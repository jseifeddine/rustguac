//! WebSocket proxy: bridges browser ↔ guacd TCP socket.

use crate::api::AppState;
use crate::auth::{client_ip, AuthIdentity, TrustedProxies};
use crate::db::{self, Db};
use crate::guacd::GuacdStream;
use crate::protocol::{last_instruction_boundary, Instruction};
use crate::session::{SessionManager, ShareTokenValidation};
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        ConnectInfo, Path, Query, State,
    },
    http::StatusCode,
    response::IntoResponse,
    Extension,
};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::json;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::Instant;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

/// Which side terminated the proxy connection.
enum ProxyResult {
    /// guacd closed the connection (with optional error).
    GuacdEnded(Option<String>),
    /// Browser/WebSocket closed the connection (with optional error).
    BrowserEnded(Option<String>),
    /// Session was cancelled externally.
    Cancelled,
}

/// Outcome of the proxy session, including whether guacd sent a disconnect instruction.
struct ProxyOutcome {
    result: ProxyResult,
    /// True if guacd sent `10.disconnect;` through the stream — indicates the
    /// remote server ended the session (user logout, crash), as opposed to the
    /// browser/network dropping the WebSocket.
    server_disconnected: bool,
}

#[derive(Deserialize)]
pub struct WsQuery {
    pub token: Option<String>,
}

/// GET /ws/:session_id — Upgrade to WebSocket and proxy to guacd.
#[allow(clippy::too_many_arguments)]
pub async fn ws_handler(
    State(manager): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path(session_id): Path<Uuid>,
    Query(query): Query<WsQuery>,
    headers: axum::http::HeaderMap,
    identity: Option<Extension<AuthIdentity>>,
    trusted: Option<Extension<TrustedProxies>>,
    database: Option<Extension<Db>>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    let proxies = trusted.map(|Extension(t)| t.0).unwrap_or_default();
    let ip = client_ip(&headers, addr.ip(), &proxies);
    let identity = identity.map(|Extension(id)| id);

    // Validate Origin header to prevent cross-site WebSocket hijacking (CSWSH).
    // Compare Origin's hostname against the request's Host header hostname.
    // Only the hostname is compared (ports stripped) to avoid false rejections
    // behind reverse proxies that may add/remove default ports.
    if let Some(origin) = headers.get("origin").and_then(|v| v.to_str().ok()) {
        let host = headers
            .get("host")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        if !origin_host_matches(origin, host) {
            tracing::warn!(
                session_id = %session_id,
                client_ip = %ip,
                origin = %origin,
                host = %host,
                "WebSocket upgrade rejected: Origin does not match Host (possible CSWSH)"
            );
            return (
                StatusCode::FORBIDDEN,
                axum::Json(json!({"error": "cross-origin WebSocket request rejected"})),
            )
                .into_response();
        }
    }

    // Check if this is an owner connection (session is Pending). The first
    // connection to a pending session takes its guacd stream, already logged
    // in to the target, so only the session's creator may make it. There is
    // deliberately no admin bypass: admins watch a live session through a
    // shadow token instead, and an admin "rescuing" a pending session would
    // be indistinguishable from hijacking it.
    let is_owner = manager.is_session_pending(session_id).await;

    if is_owner {
        let creator = manager.get_session_creator(session_id).await;
        match &identity {
            Some(id) if id.has_role("operator") && is_session_owner(id, creator.as_deref()) => {}
            Some(id) => {
                tracing::warn!(
                    session_id = %session_id,
                    client_ip = %ip,
                    identity = %id.display_name(),
                    "Owner connection refused: not the session's creator"
                );
                return (
                    StatusCode::FORBIDDEN,
                    axum::Json(
                        json!({"error": "only the user who created this session can connect to it before it starts"}),
                    ),
                )
                    .into_response();
            }
            None => {
                tracing::warn!(session_id = %session_id, client_ip = %ip, "Unauthorized owner connection attempt");
                return (
                    StatusCode::FORBIDDEN,
                    axum::Json(
                        json!({"error": "authentication required to connect as session owner"}),
                    ),
                )
                    .into_response();
            }
        }
    }

    let identity_name = identity.as_ref().map(|id| id.display_name().to_string());
    let database = database.map(|Extension(db)| db);

    ws.protocols(["guacamole"])
        .on_upgrade(move |socket| {
            handle_ws(
                manager,
                session_id,
                is_owner,
                query.token,
                socket,
                ip,
                identity_name,
                database,
            )
        })
        .into_response()
}

#[allow(clippy::too_many_arguments)]
async fn handle_ws(
    manager: Arc<SessionManager>,
    session_id: Uuid,
    owner_verified: bool,
    token: Option<String>,
    ws: WebSocket,
    client_addr: IpAddr,
    identity_name: Option<String>,
    database: Option<Db>,
) {
    // Try to take the guacd stream (owner/first connection). Only a
    // connection that passed the owner check at upgrade time may, so the
    // stream can never go to a caller who was vetted as a joiner.
    let owned = if owner_verified {
        manager.take_guacd_stream(session_id).await
    } else {
        None
    };
    let (guacd_stream, cancel) = if let Some((stream, cancel)) = owned {
        let identity_str = identity_name.as_deref().unwrap_or("unknown");
        tracing::info!(session_id = %session_id, client_ip = %client_addr, identity = %identity_str, "Session owner connected");
        (stream, cancel)
    } else {
        // Not pending — try to join an active session
        // Joining requires a valid share token
        let token = match token {
            Some(t) => t,
            None => {
                tracing::warn!(session_id = %session_id, client_ip = %client_addr, "Join attempt without share token");
                return;
            }
        };

        let validation = manager.validate_share_token(session_id, &token).await;
        match &validation {
            ShareTokenValidation::Invalid => {
                tracing::warn!(session_id = %session_id, client_ip = %client_addr, "Share token rejected");
                return;
            }
            ShareTokenValidation::Owner | ShareTokenValidation::OwnerReadOnly => {}
            ShareTokenValidation::Shadow {
                issued_by,
                read_only,
            } => {
                // Audit every shadow-token use (not just the mint). A leaked
                // token remains reusable within its TTL, but each reuse is
                // now visible in token_audit_log with the connecting IP.
                if let Some(db) = database.as_ref() {
                    let db_clone = db.clone();
                    let ip_str = client_addr.to_string();
                    let issued_by = issued_by.clone();
                    let details = format!(
                        "session_id={}, issued_by={}, read_only={}",
                        session_id, issued_by, read_only
                    );
                    let _ = tokio::task::spawn_blocking(move || {
                        if let Err(e) = db::log_token_event(
                            &db_clone,
                            None,
                            None,
                            &issued_by,
                            "shadow_used",
                            Some(&ip_str),
                            Some(&details),
                        ) {
                            tracing::warn!(error = %e, "failed to write shadow_used audit log");
                        }
                    })
                    .await;
                }
                tracing::info!(
                    session_id = %session_id,
                    client_ip = %client_addr,
                    issued_by = %issued_by,
                    "Shadow token consumed"
                );
            }
        }

        let read_only = validation.is_read_only();
        match manager.join_session(session_id, read_only).await {
            Ok((stream, cancel)) => {
                tracing::info!(session_id = %session_id, client_ip = %client_addr, read_only, "Viewer connected via share token");
                (stream, cancel)
            }
            Err(e) => {
                tracing::warn!(session_id = %session_id, client_ip = %client_addr, error = %e, "Failed to join session");
                return;
            }
        }
    };

    tracing::info!(session_id = %session_id, client_ip = %client_addr, "Starting proxy");

    // Set up recording file (only for owner connections, and only if recording is enabled)
    let is_recording_enabled = manager.is_recording_enabled(session_id).await;
    let recording_path = manager
        .recording_path()
        .join(format!("{}.guac", session_id));
    let recording_file = if is_recording_enabled && !recording_path.exists() {
        match tokio::fs::File::create(&recording_path).await {
            Ok(f) => {
                // Set restrictive permissions on recording file
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = tokio::fs::set_permissions(
                        &recording_path,
                        std::fs::Permissions::from_mode(0o640),
                    )
                    .await;
                }

                // Write sidecar .meta file with session context
                {
                    let session_info = manager.get_session(session_id).await;
                    let ab_entry = session_info
                        .as_ref()
                        .and_then(|s| s.address_book_entry.clone());
                    let meta = crate::recording::RecordingMeta {
                        address_book_entry: ab_entry,
                        created_at: chrono::Utc::now().to_rfc3339(),
                        user: session_info.as_ref().map(|s| s.created_by.clone()),
                        folder: session_info
                            .as_ref()
                            .and_then(|s| s.address_book_folder.clone()),
                        entry_display_name: session_info
                            .as_ref()
                            .and_then(|s| s.entry_display_name.clone()),
                        session_type: session_info
                            .as_ref()
                            .map(|s| format!("{:?}", s.session_type).to_lowercase()),
                    };
                    if let Err(e) = crate::recording::write_meta(&recording_path, &meta) {
                        tracing::warn!(session_id = %session_id, error = %e, "Failed to write recording .meta");
                    }
                }

                Some(f)
            }
            Err(e) => {
                tracing::error!(session_id = %session_id, error = %e, "Failed to create recording file");
                None
            }
        }
    } else {
        None // Viewer connections don't record, or recording is disabled
    };

    // Run the bidirectional proxy
    let start = Instant::now();
    let proxy_outcome = proxy_ws_guacd(ws, guacd_stream, recording_file, cancel).await;
    let elapsed = start.elapsed();
    let server_disconnected = proxy_outcome.server_disconnected;
    let proxy_result = proxy_outcome.result;

    manager.disconnect_viewer(session_id).await;

    // Log termination direction and timing
    let mark_error = match &proxy_result {
        ProxyResult::GuacdEnded(err) => {
            if elapsed.as_secs() < 5 {
                tracing::warn!(
                    session_id = %session_id, client_ip = %client_addr,
                    elapsed_ms = elapsed.as_millis() as u64,
                    error = ?err,
                    "guacd closed connection quickly (possible connection failure)"
                );
                true // mark as error
            } else {
                tracing::info!(
                    session_id = %session_id, client_ip = %client_addr,
                    elapsed_secs = elapsed.as_secs(),
                    "Proxy ended: guacd closed connection"
                );
                false
            }
        }
        ProxyResult::BrowserEnded(err) => {
            tracing::info!(
                session_id = %session_id, client_ip = %client_addr,
                elapsed_secs = elapsed.as_secs(),
                error = ?err,
                "Proxy ended: browser disconnected"
            );
            false
        }
        ProxyResult::Cancelled => {
            tracing::info!(
                session_id = %session_id, client_ip = %client_addr,
                elapsed_secs = elapsed.as_secs(),
                "Proxy ended: session cancelled"
            );
            false
        }
    };

    let status_str;
    if mark_error {
        manager.error_session(session_id).await;
        status_str = "error";
    } else {
        // Only mark completed if no more active connections
        let info = manager.get_session(session_id).await;
        if let Some(info) = info {
            if info.active_connections == 0 {
                manager.complete_session(session_id).await;
                status_str = "completed";
            } else {
                status_str = "active";
            }
        } else {
            status_str = "completed";
        }
    }

    // VDI container lifecycle on session end
    if let Some((crate::session::SessionType::Vdi, Some(ref _cid), container_name)) =
        manager.get_vdi_info(session_id).await
    {
        if server_disconnected {
            // User logged out / session crashed → stop container immediately
            manager.stop_vdi_container(session_id).await;
            // Clean up session thumbnail
            let _ = tokio::fs::remove_file(manager.thumbnail_path(session_id)).await;
        } else {
            // Browser disconnect / network drop → container persists.
            // Copy session thumbnail to container-keyed file for the active desktops UI.
            let session_thumb = manager.thumbnail_path(session_id);
            if let Some(container_name) = container_name {
                let vdi_thumb = manager.vdi_thumbnail_path(&container_name);
                if session_thumb.exists() {
                    let _ = tokio::fs::copy(&session_thumb, &vdi_thumb).await;
                }
            }
        }
    }

    // Record session end in history
    manager.end_session_history(
        session_id,
        status_str,
        elapsed.as_secs(),
        is_recording_enabled,
    );

    // Per-entry recording rotation (after session ends, recording file is complete)
    if is_recording_enabled {
        if let Some((Some(entry_key), Some(max_recs))) =
            manager.get_recording_meta(session_id).await
        {
            if max_recs > 0 {
                let rec_dir = manager.recording_path().to_path_buf();
                tokio::task::spawn_blocking(move || {
                    crate::recording::rotate_per_entry(&rec_dir, &entry_key, max_recs);
                });
            }
        }
    }

    tracing::info!(session_id = %session_id, client_ip = %client_addr, "Session disconnected");
}

/// Bidirectional proxy between WebSocket and guacd stream (TCP or TLS).
async fn proxy_ws_guacd(
    ws: WebSocket,
    guacd: GuacdStream,
    recording_file: Option<tokio::fs::File>,
    cancel: CancellationToken,
) -> ProxyOutcome {
    let (guacd_read, guacd_write) = tokio::io::split(guacd);
    let (ws_write, ws_read) = ws.split();

    let recording = recording_file.map(|f| Arc::new(tokio::sync::Mutex::new(f)));

    // Shared flag: set by guacd_to_ws when it sees `10.disconnect;` in the stream
    let server_disconnected = Arc::new(std::sync::atomic::AtomicBool::new(false));

    // The WebSocket sink is shared so both halves can write to it. The browser →
    // guacd side needs to echo `0.,4.ping,...` instructions back to the client
    // (Apache webapp parity), without ever forwarding them to guacd.
    let ws_sink = Arc::new(tokio::sync::Mutex::new(ws_write));

    // guacd → browser (also tee to recording)
    let recording_clone = recording.clone();
    let sd_flag = server_disconnected.clone();
    let ws_sink_g = ws_sink.clone();
    let guacd_to_browser =
        tokio::spawn(
            async move { guacd_to_ws(guacd_read, ws_sink_g, recording_clone, sd_flag).await },
        );

    // browser → guacd, alongside the watch on the browser (see
    // `watch_browser`): whichever ends first ends this side.
    let guacd_write = Arc::new(tokio::sync::Mutex::new(guacd_write));
    let heard = Arc::new(Heard::new());
    let ws_sink_b = ws_sink.clone();
    let browser_to_guacd = tokio::spawn(async move {
        tokio::select! {
            r = ws_to_guacd(ws_read, guacd_write.clone(), ws_sink_b.clone(), heard.clone()) => r,
            r = watch_browser(heard, guacd_write, ws_sink_b) => r,
        }
    });

    // Wait for either direction to finish, or cancellation, then stop both.
    let result = match race_and_abort(guacd_to_browser, browser_to_guacd, &cancel).await {
        Race::First(result) => ProxyResult::GuacdEnded(task_error(result)),
        Race::Second(result) => ProxyResult::BrowserEnded(task_error(result)),
        Race::Cancelled => ProxyResult::Cancelled,
    };

    ProxyOutcome {
        result,
        server_disconnected: server_disconnected.load(std::sync::atomic::Ordering::Relaxed),
    }
}

/// Which side of `race_and_abort` finished first.
enum Race<A, B> {
    First(A),
    Second(B),
    Cancelled,
}

/// Wait for the first of two tasks to finish, or for `cancel`, then abort
/// both. Dropping a `JoinHandle` only detaches its task, so without the
/// abort a terminated session (or one whose browser went away) kept both
/// pump tasks running: traffic still flowed to and from the target and the
/// guacd connection stayed open until the other side happened to close.
/// Aborting a task that has already finished does nothing.
async fn race_and_abort<A, B>(
    mut first: tokio::task::JoinHandle<A>,
    mut second: tokio::task::JoinHandle<B>,
    cancel: &CancellationToken,
) -> Race<Result<A, tokio::task::JoinError>, Result<B, tokio::task::JoinError>> {
    let outcome = tokio::select! {
        r = &mut first => Race::First(r),
        r = &mut second => Race::Second(r),
        _ = cancel.cancelled() => Race::Cancelled,
    };
    first.abort();
    second.abort();
    outcome
}

/// The error text of a pump task that ended, if it ended badly.
fn task_error<E: std::fmt::Display>(
    result: Result<Result<(), E>, tokio::task::JoinError>,
) -> Option<String> {
    match result {
        Ok(Err(e)) => Some(e.to_string()),
        Err(e) => Some(e.to_string()),
        _ => None,
    }
}

type WsSink = Arc<tokio::sync::Mutex<futures_util::stream::SplitSink<WebSocket, Message>>>;
type GuacdWriter = Arc<tokio::sync::Mutex<tokio::io::WriteHalf<GuacdStream>>>;

/// With nothing at all from the browser for this long (no instruction, no
/// tunnel ping, no answer to a WebSocket ping), it is taken to be gone and
/// the proxy ends. A browser that vanishes without closing its WebSocket (a
/// laptop asleep, a network change) otherwise left its session Active, and
/// counting against the per-user limit, until the TCP connection errored
/// out, or for good while a send to it was stuck behind a full buffer.
const BROWSER_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);
/// The browser is pinged once it has been quiet this long. A page in the
/// foreground sends a tunnel ping every 500ms, so this is mostly for pages
/// in background tabs (timers slowed), frozen (Safari) or gone. The
/// browser's network stack answers, whatever its page is doing.
const PING_AFTER: std::time::Duration = std::time::Duration::from_secs(10);
/// guacd ends a user it hears nothing from for 15 seconds ("User is not
/// responding"). The Guacamole client sends a `nop` every 5 seconds to
/// prevent that, but not while its page is frozen, so the proxy sends one
/// for it when nothing has gone to guacd for this long.
const NOP_AFTER: std::time::Duration = std::time::Duration::from_secs(5);
const WATCH_TICK: std::time::Duration = std::time::Duration::from_secs(1);

/// When the browser was last heard from, and when guacd last was sent
/// anything, as milliseconds since the proxy started.
struct Heard {
    start: tokio::time::Instant,
    browser: std::sync::atomic::AtomicU64,
    guacd: std::sync::atomic::AtomicU64,
}

impl Heard {
    fn new() -> Self {
        Heard {
            start: tokio::time::Instant::now(),
            browser: 0.into(),
            guacd: 0.into(),
        }
    }
    fn now(&self) -> u64 {
        self.start.elapsed().as_millis() as u64
    }
    fn browser_now(&self) {
        self.browser
            .store(self.now(), std::sync::atomic::Ordering::Relaxed);
    }
    fn guacd_now(&self) {
        self.guacd
            .store(self.now(), std::sync::atomic::Ordering::Relaxed);
    }
    fn since(&self, at: &std::sync::atomic::AtomicU64) -> std::time::Duration {
        let at = at.load(std::sync::atomic::Ordering::Relaxed);
        std::time::Duration::from_millis(self.now().saturating_sub(at))
    }
}

/// What the watch on the browser does on one tick.
#[derive(Debug, PartialEq)]
struct WatchStep {
    end: bool,
    ping: bool,
    nop: bool,
}

fn watch_step(browser_quiet: std::time::Duration, guacd_quiet: std::time::Duration) -> WatchStep {
    let end = browser_quiet >= BROWSER_TIMEOUT;
    WatchStep {
        end,
        ping: !end && browser_quiet >= PING_AFTER,
        nop: !end && guacd_quiet >= NOP_AFTER,
    }
}

/// Watch the browser end of the proxy. Returns (ending the proxy) once the
/// browser has been silent for `BROWSER_TIMEOUT`; until then pings it when
/// it goes quiet, and keeps guacd from timing the user out while its page
/// is frozen. Pings are skipped while a send to the browser holds the sink:
/// a browser that stops reading then stops being heard from, and is ended.
async fn watch_browser<W, S>(
    heard: Arc<Heard>,
    guacd: Arc<tokio::sync::Mutex<W>>,
    ws_sink: Arc<tokio::sync::Mutex<S>>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>>
where
    W: tokio::io::AsyncWrite + Unpin,
    S: futures_util::Sink<Message> + Unpin,
{
    let mut tick = tokio::time::interval(WATCH_TICK);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tick.tick().await;
        let step = watch_step(heard.since(&heard.browser), heard.since(&heard.guacd));
        if step.end {
            return Err(format!(
                "nothing from the browser for {}s",
                heard.since(&heard.browser).as_secs()
            )
            .into());
        }
        if step.nop {
            guacd.lock().await.write_all(b"3.nop;").await?;
            heard.guacd_now();
        }
        if step.ping {
            if let Ok(mut sink) = ws_sink.try_lock() {
                let _ = tokio::time::timeout(
                    std::time::Duration::from_secs(5),
                    sink.send(Message::Ping(Default::default())),
                )
                .await;
            }
        }
    }
}

/// Maximum bytes the guacd-side carry buffer is allowed to grow to before
/// force-flushing without a clean instruction boundary. In practice guacd
/// instructions are tiny; this exists to bound memory if upstream sends
/// something pathological. 16 MiB is well above any real instruction.
const MAX_GUACD_CARRY: usize = 16 * 1024 * 1024;

/// Forward data from guacd to WebSocket, recording along the way.
///
/// The browser's Tunnel.js parser concatenates every Message::Text into a
/// single rolling buffer with no message-boundary semantics. If we send a
/// chunk that ends mid-instruction and `ws_to_guacd` then echoes a tunnel
/// ping over the shared sink, the ping bytes splice into the middle of the
/// in-flight instruction and the parser blows up with "Element terminator
/// of instruction was not ';' nor ','". To prevent that, every Message::Text
/// we emit ends at a true Guacamole instruction boundary; partial tail data
/// is held in `carry` until the next read completes it.
async fn guacd_to_ws(
    mut guacd: tokio::io::ReadHalf<GuacdStream>,
    ws: WsSink,
    recording: Option<Arc<tokio::sync::Mutex<tokio::fs::File>>>,
    server_disconnected: Arc<std::sync::atomic::AtomicBool>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut buf = vec![0u8; 65536];
    let mut carry: Vec<u8> = Vec::new();

    loop {
        let n = guacd.read(&mut buf).await?;
        if n == 0 {
            break;
        }

        let data = &buf[..n];

        // Recording captures the raw guacd stream regardless of buffering.
        if let Some(ref recording) = recording {
            let mut file = recording.lock().await;
            let _ = file.write_all(data).await;
        }

        carry.extend_from_slice(data);

        // Flush up to the last complete instruction boundary in the carry.
        // Anything past that is held over for the next read.
        let to_send_bytes: Vec<u8> = match last_instruction_boundary(&carry) {
            Some(end) => carry.drain(..end).collect(),
            None if carry.len() > MAX_GUACD_CARRY => {
                tracing::warn!(
                    len = carry.len(),
                    cap = MAX_GUACD_CARRY,
                    "guacd carry exceeded cap; force-flushing without instruction boundary"
                );
                std::mem::take(&mut carry)
            }
            None => continue,
        };

        // The boundary scanner only advances over valid UTF-8, so this
        // String::from_utf8 should never fail in practice; defensive in
        // case a force-flush above happened mid-multibyte char.
        let text = String::from_utf8(to_send_bytes).map_err(
            |e| -> Box<dyn std::error::Error + Send + Sync> {
                format!("invalid UTF-8 from guacd: {}", e).into()
            },
        )?;

        // Detect guacd-initiated disconnect (server-side logout/crash).
        // guacd sends "10.disconnect;" as the final instruction when the
        // remote server ends the session. Buffering at instruction boundary
        // means the disconnect appears intact in the flushed text, either
        // at the start or after a previous ";".
        if text.starts_with("10.disconnect;") || text.contains(";10.disconnect;") {
            server_disconnected.store(true, std::sync::atomic::Ordering::Relaxed);
        }

        let mut sink = ws.lock().await;
        sink.send(Message::Text(text.into())).await?;
    }

    Ok(())
}

/// Forward data from WebSocket to guacd, intercepting empty-opcode tunnel
/// pings. The Guacamole client sends `0.,4.ping,<ts>;` every 500ms over the
/// "internal data" opcode (the empty string) to keep the tunnel from going
/// UNSTABLE. Apache's webapp echoes these back without ever forwarding them
/// to guacd; guacd silently drops unknown opcodes (libguac/user-handlers.c
/// `__guac_user_call_opcode_handler`), so without echoing here the client
/// would mark the tunnel UNSTABLE after 1.5s of guacd quiet time and close
/// it after 15s. We mirror Apache's filter behaviour.
async fn ws_to_guacd(
    mut ws_read: futures_util::stream::SplitStream<WebSocket>,
    guacd: GuacdWriter,
    ws_sink: WsSink,
    heard: Arc<Heard>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    while let Some(msg) = ws_read.next().await {
        let msg = msg?;
        heard.browser_now();
        match msg {
            Message::Text(text) => {
                // Empty-opcode instructions always start with "0.," — fast
                // path skips the parse for normal traffic.
                if text.starts_with("0.,") {
                    if let Ok(instr) = Instruction::parse(text.trim_end_matches(';')) {
                        if instr.opcode.is_empty() {
                            // Echo ping requests; drop everything else on the
                            // internal channel.
                            if instr.args.first().map(|s| s.as_str()) == Some("ping") {
                                let echo = Instruction::new("", instr.args).encode();
                                let mut sink = ws_sink.lock().await;
                                sink.send(Message::Text(echo.into())).await?;
                            }
                            continue;
                        }
                    }
                }

                // Log clipboard instructions from browser → guacd
                if text.contains(".clipboard,") {
                    tracing::info!("browser sent clipboard instruction to guacd");
                }
                guacd.lock().await.write_all(text.as_bytes()).await?;
                heard.guacd_now();
            }
            Message::Binary(_) => {
                continue;
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    Ok(())
}

/// Return true if the browser-supplied Origin and the request Host header
/// refer to the same hostname (ports stripped). Extracted for test.
///
/// If either value is missing or empty, the request is allowed — matches
/// the prior `unwrap_or("")` behaviour where axum had no header and no
/// CSWSH signal. The caller must still ensure auth is enforced separately.
/// Whether `identity` is the creator of a session. Emails are compared
/// without regard to ASCII case, since an identity provider and an API
/// client sending `owner` on someone's behalf may capitalise the same
/// address differently.
pub(crate) fn is_session_owner(identity: &AuthIdentity, creator: Option<&str>) -> bool {
    match creator {
        Some(c) => !c.is_empty() && identity.display_name().eq_ignore_ascii_case(c),
        None => false,
    }
}

pub(crate) fn origin_host_matches(origin: &str, host: &str) -> bool {
    let origin_host = origin
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_end_matches('/')
        .split(':')
        .next()
        .unwrap_or("");
    let host_name = host.split(':').next().unwrap_or("");
    if host_name.is_empty() || origin_host.is_empty() {
        return true;
    }
    origin_host.eq_ignore_ascii_case(host_name)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A task that runs until aborted; `alive` turns false when it is dropped.
    fn forever(
        alive: std::sync::Arc<std::sync::atomic::AtomicBool>,
    ) -> tokio::task::JoinHandle<Result<(), String>> {
        struct Flag(std::sync::Arc<std::sync::atomic::AtomicBool>);
        impl Drop for Flag {
            fn drop(&mut self) {
                self.0.store(false, std::sync::atomic::Ordering::SeqCst);
            }
        }
        // Captured by the future, so dropping the task (polled or not)
        // drops the flag.
        let flag = Flag(alive);
        tokio::spawn(async move {
            let _flag = flag;
            std::future::pending::<()>().await;
            Ok(())
        })
    }

    async fn gone(alive: &std::sync::atomic::AtomicBool) -> bool {
        for _ in 0..100 {
            if !alive.load(std::sync::atomic::Ordering::SeqCst) {
                return true;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        false
    }

    #[tokio::test]
    async fn terminating_a_session_stops_both_pump_tasks() {
        // Terminate fires the cancel token. Before, the select dropped the
        // two task handles, which only detaches them: traffic kept flowing
        // to the target after the session was "terminated".
        use std::sync::atomic::AtomicBool;
        use std::sync::Arc;
        let (a, b) = (
            Arc::new(AtomicBool::new(true)),
            Arc::new(AtomicBool::new(true)),
        );
        let cancel = CancellationToken::new();
        let race = tokio::spawn({
            let (a, b, cancel) = (a.clone(), b.clone(), cancel.clone());
            async move {
                matches!(
                    race_and_abort(forever(a), forever(b), &cancel).await,
                    Race::Cancelled
                )
            }
        });
        cancel.cancel();
        assert!(race.await.unwrap(), "cancellation wins the race");
        assert!(gone(&a).await, "guacd to browser task stopped");
        assert!(gone(&b).await, "browser to guacd task stopped");
    }

    #[tokio::test]
    async fn one_direction_ending_stops_the_other() {
        // The browser goes away: its task ends, and the guacd side must not be
        // left running with the connection open.
        use std::sync::atomic::AtomicBool;
        use std::sync::Arc;
        let other = Arc::new(AtomicBool::new(true));
        let ended: tokio::task::JoinHandle<Result<(), String>> = tokio::spawn(async { Ok(()) });
        let cancel = CancellationToken::new();
        let r = race_and_abort(forever(other.clone()), ended, &cancel).await;
        assert!(matches!(r, Race::Second(Ok(Ok(())))));
        assert!(gone(&other).await, "the still-running side was stopped");
    }

    #[test]
    fn the_watch_pings_a_quiet_browser_and_ends_a_silent_one() {
        let s = std::time::Duration::from_secs;
        let step = |b, g, end, ping, nop| {
            assert_eq!(
                watch_step(s(b), s(g)),
                WatchStep { end, ping, nop },
                "browser quiet {b}s, guacd quiet {g}s"
            );
        };
        step(0, 0, false, false, false);
        step(4, 4, false, false, false);
        step(5, 5, false, false, true);
        step(10, 1, false, true, false);
        step(59, 59, false, true, true);
        step(60, 0, true, false, false);
        step(600, 600, true, false, false);
    }

    /// Runs the watch for at most `limit` of (paused) time while `feed`
    /// plays the browser. Returns whether the watch ended the proxy, and
    /// the `nop`s it sent guacd.
    async fn watch_for(
        limit: std::time::Duration,
        feed: impl Fn(&Heard) + Send + 'static,
        every: std::time::Duration,
    ) -> (bool, usize) {
        use tokio::io::AsyncReadExt as _;
        let (guacd_w, mut guacd_r) = tokio::io::duplex(1 << 16);
        let heard = Arc::new(Heard::new());
        let feeder = {
            let heard = heard.clone();
            tokio::spawn(async move {
                loop {
                    tokio::time::sleep(every).await;
                    feed(&heard);
                }
            })
        };
        let ended = tokio::time::timeout(
            limit,
            watch_browser(
                heard,
                Arc::new(tokio::sync::Mutex::new(guacd_w)),
                Arc::new(tokio::sync::Mutex::new(futures_util::sink::drain())),
            ),
        )
        .await
        .is_ok();
        feeder.abort();
        let mut sent = Vec::new();
        let mut buf = [0u8; 4096];
        while let Some(Ok(n)) = futures_util::FutureExt::now_or_never(guacd_r.read(&mut buf)) {
            if n == 0 {
                break;
            }
            sent.extend_from_slice(&buf[..n]);
        }
        let sent = String::from_utf8(sent).unwrap();
        assert_eq!(sent.replace("3.nop;", ""), "", "only nops go to guacd");
        (ended, sent.matches("3.nop;").count())
    }

    #[tokio::test(start_paused = true)]
    async fn a_browser_that_went_away_is_ended_within_a_minute() {
        // Nothing from it at all (asleep, network gone): before, the session
        // stayed Active until TCP gave up, half an hour or more.
        let start = tokio::time::Instant::now();
        let (ended, _) = watch_for(
            std::time::Duration::from_secs(600),
            |_| {},
            std::time::Duration::from_secs(3600),
        )
        .await;
        assert!(ended);
        let took = start.elapsed().as_secs();
        assert!((60..=62).contains(&took), "ended after {took}s");
    }

    #[tokio::test(start_paused = true)]
    async fn a_running_page_is_left_alone() {
        // Its tunnel pings and its own nops: no pings or nops from the proxy.
        let (ended, nops) = watch_for(
            std::time::Duration::from_secs(600),
            |h| {
                h.browser_now();
                h.guacd_now();
            },
            std::time::Duration::from_millis(500),
        )
        .await;
        assert!(!ended);
        assert_eq!(nops, 0);
    }

    #[tokio::test(start_paused = true)]
    async fn a_frozen_page_is_kept_attached() {
        // A background tab in Safari: the page sends nothing, but its network
        // stack answers pings. guacd, which ends a user silent for 15s, is
        // sent a nop every 5s for it.
        let (ended, nops) = watch_for(
            std::time::Duration::from_secs(600),
            |h| h.browser_now(),
            std::time::Duration::from_secs(10),
        )
        .await;
        assert!(!ended);
        assert!((110..=121).contains(&nops), "{nops} nops in 600s");
    }

    fn user(email: &str, role: &str) -> AuthIdentity {
        AuthIdentity::User {
            email: email.into(),
            role: role.into(),
            groups: Vec::new(),
        }
    }

    #[test]
    fn owner_is_creator() {
        assert!(is_session_owner(
            &user("alice@example.com", "operator"),
            Some("alice@example.com")
        ));
    }

    #[test]
    fn owner_match_ignores_ascii_case() {
        assert!(is_session_owner(
            &user("Alice@Example.com", "operator"),
            Some("alice@example.com")
        ));
    }

    /// H3: another user, even an admin, must not claim a pending session.
    #[test]
    fn non_creator_is_not_owner_even_if_admin() {
        assert!(!is_session_owner(
            &user("bob@example.com", "operator"),
            Some("alice@example.com")
        ));
        assert!(!is_session_owner(
            &user("root@example.com", "admin"),
            Some("alice@example.com")
        ));
        assert!(!is_session_owner(
            &AuthIdentity::ApiKey("ops-key".into()),
            Some("alice@example.com")
        ));
    }

    #[test]
    fn api_key_owns_its_own_session() {
        assert!(is_session_owner(
            &AuthIdentity::ApiKey("ops-key".into()),
            Some("ops-key")
        ));
    }

    #[test]
    fn unknown_or_empty_creator_has_no_owner() {
        assert!(!is_session_owner(&user("a@example.com", "admin"), None));
        assert!(!is_session_owner(
            &AuthIdentity::ApiKey(String::new()),
            Some("")
        ));
    }

    #[test]
    fn origin_match_same_hostname_no_ports() {
        assert!(origin_host_matches(
            "https://console.example.com",
            "console.example.com"
        ));
    }

    #[test]
    fn origin_match_ports_stripped() {
        assert!(origin_host_matches(
            "https://console.example.com:8443",
            "console.example.com:80"
        ));
        assert!(origin_host_matches("http://host.local:8080", "host.local"));
    }

    #[test]
    fn origin_match_trailing_slash_tolerated() {
        assert!(origin_host_matches(
            "https://console.example.com/",
            "console.example.com"
        ));
    }

    #[test]
    fn origin_match_case_insensitive_hostname() {
        // DNS is case-insensitive; browsers can vary casing.
        assert!(origin_host_matches(
            "https://Console.Example.COM",
            "console.example.com"
        ));
    }

    #[test]
    fn origin_mismatch_different_subdomain_rejected() {
        assert!(!origin_host_matches(
            "https://evil.example.com",
            "console.example.com"
        ));
    }

    #[test]
    fn origin_mismatch_unrelated_host_rejected() {
        assert!(!origin_host_matches(
            "https://evil.attacker.io",
            "console.example.com"
        ));
    }

    #[test]
    fn origin_empty_allowed_preserves_prior_behaviour() {
        // No Origin header (rare — server-side fetches / Firefox in some
        // contexts) must be allowed by this check; caller still enforces
        // auth. Same for empty Host (shouldn't happen, but belt + braces).
        assert!(origin_host_matches("", "console.example.com"));
        assert!(origin_host_matches("https://console.example.com", ""));
    }

    #[test]
    fn origin_mismatch_path_in_origin_ignored_by_host() {
        // An Origin with a path should never happen (spec forbids it) but
        // if it slips through, the split should not cause a match by
        // accident.
        assert!(!origin_host_matches(
            "https://evil.example.com/path",
            "console.example.com"
        ));
    }

    #[test]
    fn origin_mismatch_prefix_attack_rejected() {
        // `console.example.com.attacker.io` must NOT match
        // `console.example.com`. Split-on-`:` + exact compare handles this.
        assert!(!origin_host_matches(
            "https://console.example.com.attacker.io",
            "console.example.com"
        ));
    }
}
