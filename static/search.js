/*
 * Global connection search — a floating, dim overlay available on every page.
 *
 * Drop-in: a page only needs <script src="/search.js"></script>. It injects its
 * own styles, a search box into the brand row, and the results overlay into the
 * body, loads the address-book search index, and wires the "/" shortcut.
 *
 * The connections page has its own in-page search (results interact with the
 * folder tree there), so this module stands aside when it sees that page's own
 * search box (#connections-search). It also depends on rgFilters (filters.js),
 * which it loads on demand if the page hasn't already.
 */
(function () {
    'use strict';
    if (document.getElementById('connections-search')) return; // connections handles its own
    if (window.__rgGlobalSearch) return;
    window.__rgGlobalSearch = true;

    var searchIndex = null, searchEngaged = false, searchFilters = null, keepUntil = 0, keepTimer = null;

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function attr(s) { return esc(s); }
    function highlight(text, tokens) {
        var safe = esc(text);
        if (!tokens || !tokens.length) return safe;
        var escaped = tokens.filter(function (t) { return t.length > 0; })
            .map(function (t) { return t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); });
        if (!escaped.length) return safe;
        return safe.replace(new RegExp('(' + escaped.join('|') + ')', 'gi'), '<mark>$1</mark>');
    }
    // "host (Tenant)" -> host over a quieter tenant sub-line
    function entryNameHtml(label, tokens) {
        var e = tokens ? function (t) { return highlight(t, tokens); } : esc;
        var m = /^(.*\S)\s+\(([^()]+)\)$/.exec(label || '');
        if (!m) return e(label || '');
        return '<span class="entry-name">' + e(m[1]) + '</span><span class="entry-sub">' + e(m[2]) + '</span>';
    }
    function apiKey() { try { return sessionStorage.getItem('rustguac_api_key'); } catch (e) { return null; } }
    function headers(extra) {
        var h = extra || {}; var k = apiKey();
        if (k) h['Authorization'] = 'Bearer ' + k;
        return h;
    }

    function injectStyle() {
        var css = [
            '.global-search{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:min(640px,42vw);min-width:320px;display:flex;align-items:center}',
            '.global-search input[type="search"]{width:100%;height:48px;padding:0 52px 0 46px;font-size:var(--fz-lg);background:var(--input);border:1px solid var(--border);border-radius:6px;color:var(--text);box-sizing:border-box;font-family:monospace;transition:border-color .15s,box-shadow .15s}',
            '.global-search input[type="search"]:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 22%,transparent)}',
            '.global-search input[type="search"]:disabled{opacity:.6;cursor:progress}',
            '.global-search-icon{position:absolute;left:16px;top:50%;transform:translateY(-50%) rotate(-45deg);color:var(--text-dim);font-size:22px;line-height:1;pointer-events:none}',
            '.global-search:focus-within .global-search-icon{color:var(--accent)}',
            '.global-search-key{position:absolute;right:14px;top:50%;transform:translateY(-50%);font-family:monospace;font-size:var(--fz-xs);color:var(--text-dim);border:1px solid var(--border);border-radius:4px;padding:1px 7px;line-height:1.5;pointer-events:none}',
            '.global-search:focus-within .global-search-key,.global-search.has-value .global-search-key{display:none}',
            '@media(max-width:1180px){.global-search{position:static;transform:none;margin-left:auto;width:360px;min-width:0}}',
            '#search-overlay{display:none;position:fixed;inset:0;z-index:200;background:color-mix(in srgb,var(--bg) 62%,transparent);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);padding:86px var(--s-5) var(--s-5);justify-content:center;align-items:flex-start}',
            '#search-overlay.open{display:flex}',
            '#search-overlay-panel{width:min(1120px,100%);max-height:calc(100vh - 110px);display:flex;flex-direction:column;background:var(--surface);border:1px solid var(--border);border-radius:10px;box-shadow:0 24px 70px rgba(0,0,0,.6);overflow:hidden;animation:rg-search-in 140ms ease-out both}',
            '@keyframes rg-search-in{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:none}}',
            '#search-overlay-head{display:flex;flex-direction:column;gap:var(--s-2);padding:var(--s-4) var(--s-4) var(--s-3);border-bottom:1px solid var(--border);flex:none}',
            '#search-overlay-head .list-tools{margin:0}',
            '.search-summary{color:var(--text-muted);font-size:var(--fz-sm);margin:0}',
            '.search-summary strong{color:var(--text);font-weight:bold}',
            '#search-results{overflow-y:auto;overflow-x:hidden;padding:0 var(--s-4) var(--s-3)}',
            '#search-results .entries-table{border-collapse:collapse;width:100%;margin-top:0;border:0}',
            '#search-results .entries-table th,#search-results .entries-table td{padding:var(--s-2) var(--s-3);text-align:left;border-bottom:1px solid var(--border);font-size:var(--fz-sm)}',
            '#search-results .entries-table th{color:var(--text-muted);text-transform:uppercase;letter-spacing:.08em;font-size:var(--fz-xs);position:sticky;top:0;background:var(--surface);z-index:1}',
            '#search-results .empty-state{padding:2.5em 1em;text-align:center}',
            '#search-results mark{background:var(--accent);color:var(--bg);padding:0 .15em;border-radius:2px}',
            '.search-results{table-layout:fixed}',
            '.search-results .c-name{width:26%}.search-results .c-type{width:7%}.search-results .c-host{width:18%}.search-results .c-user{width:10%}.search-results .c-folder{width:15%}.search-results .c-actions{width:24%}',
            '.search-results td{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;vertical-align:middle}',
            '.search-results .entry-name,.search-results .entry-sub{display:block;overflow:hidden;text-overflow:ellipsis}',
            '.search-results .entry-sub{color:var(--text-muted);font-size:var(--fz-xs)}',
            '.search-results .folder-cell .fname{display:block;overflow:hidden;text-overflow:ellipsis}',
            '.search-results .folder-cell .fkey{display:block;overflow:hidden;text-overflow:ellipsis;color:var(--text-dim);font-size:var(--fz-xs);letter-spacing:.04em}',
            '.search-results .host-cell{color:var(--text-muted)}',
            '.search-results .actions-cell{text-align:right;overflow:visible;text-overflow:clip;white-space:nowrap}',
            '.search-results .actions-cell .btn-connect{vertical-align:middle}',
            '.search-results .search-open-folder{margin-left:var(--s-3);white-space:nowrap;color:var(--accent);text-decoration:none;font-size:var(--fz-sm)}',
            '.search-results .search-open-folder:hover{text-decoration:underline}',
            '.search-more{color:var(--text-muted);font-size:var(--fz-sm);padding:var(--s-3) 0}'
        ].join('');
        var st = document.createElement('style'); st.id = 'rg-search-style'; st.textContent = css;
        document.head.appendChild(st);
    }

    function injectUI() {
        var brand = document.querySelector('.brand-row');
        if (brand) {
            brand.style.position = 'relative';
            var gs = document.createElement('div');
            gs.className = 'global-search'; gs.id = 'global-search';
            gs.innerHTML = '<span class="global-search-icon" aria-hidden="true">⌘</span>' +
                '<input type="search" id="rg-search" placeholder="Search connections…" autocomplete="off" spellcheck="false" aria-label="Search connections" disabled />' +
                '<kbd class="global-search-key" title="Press / to search">/</kbd>';
            brand.appendChild(gs);
        }
        var ov = document.createElement('div');
        ov.id = 'search-overlay'; ov.setAttribute('aria-hidden', 'true');
        ov.innerHTML = '<div id="search-overlay-panel" role="dialog" aria-label="Search results">' +
            '<div id="search-overlay-head"><div id="search-summary" class="search-summary"></div><div id="search-facets" class="list-tools"></div></div>' +
            '<div id="search-results"></div></div>';
        document.body.appendChild(ov);
    }

    function input() { return document.getElementById('rg-search'); }
    function overlay() { return document.getElementById('search-overlay'); }

    function loadIndex() {
        var inp = input(); if (!inp) return;
        fetch('/api/addressbook/search-index', { headers: headers(), credentials: 'same-origin' })
            .then(function (r) { if (!r.ok) throw new Error('index'); return r.json(); })
            .then(function (data) {
                var rows = (data && data.entries) || [];
                searchIndex = rows.map(function (r) {
                    var e = r.entry;
                    var label = e.display_name || e.name;
                    var host = e.session_type === 'web' ? (e.url || '')
                        : e.session_type === 'vdi' ? (e.container_image || '')
                        : e.session_type === 'proxmox' ? ((e.proxmox_url || '') + (e.proxmox_vmid ? ' · VM ' + e.proxmox_vmid : ''))
                        : (e.hostname || '');
                    var haystack = [e.name, e.display_name || '', host, e.username || '', e.proxmox_token_id || '', e.url || '', e.domain || '', e.session_type, r.folder_path].join(' ').toLowerCase();
                    return { scope: r.scope, folderPath: r.folder_path, entry: e, label: label, host: host, haystack: haystack };
                });
                inp.placeholder = 'Search ' + searchIndex.length + ' connection' + (searchIndex.length === 1 ? '' : 's') + '…';
                inp.disabled = false;
                if (searchEngaged) runSearch();
            })
            .catch(function () { inp.placeholder = 'Search unavailable'; });
    }

    function setEngaged(on) {
        if (searchEngaged === on) return;
        searchEngaged = on;
        var ov = overlay();
        ov.classList.toggle('open', on);
        ov.setAttribute('aria-hidden', on ? 'false' : 'true');
        if (on) runSearch();
    }
    function close() {
        var inp = input();
        if (inp) { inp.value = ''; inp.blur(); }
        document.getElementById('global-search').classList.remove('has-value');
        setEngaged(false);
    }

    function runSearch() {
        var inp = input(); if (!inp) return;
        var q = (inp.value || '').trim().toLowerCase();
        document.getElementById('global-search').classList.toggle('has-value', !!inp.value);
        if (!searchEngaged) return;
        var res = document.getElementById('search-results');
        if (!searchIndex) { res.innerHTML = '<p class="empty-state">Indexing connections…</p>'; return; }
        if (!q) {
            var all = searchIndex.map(function (row) { return { row: row, score: 0 }; });
            all.sort(function (a, b) {
                if (a.row.folderPath !== b.row.folderPath) return a.row.folderPath.localeCompare(b.row.folderPath);
                return a.row.label.localeCompare(b.row.label);
            });
            renderResults(all, '', []); return;
        }
        var tokens = q.split(/\s+/).filter(Boolean);
        var matches = [];
        for (var i = 0; i < searchIndex.length; i++) {
            var row = searchIndex[i], ok = true;
            for (var t = 0; t < tokens.length; t++) { if (row.haystack.indexOf(tokens[t]) === -1) { ok = false; break; } }
            if (!ok) continue;
            var first = tokens[0], lcL = row.label.toLowerCase(), lcN = row.entry.name.toLowerCase(), score = 0;
            if (lcL.indexOf(first) === 0 || lcN.indexOf(first) === 0) score += 100;
            else if (lcL.indexOf(first) !== -1 || lcN.indexOf(first) !== -1) score += 50;
            if ((row.host || '').toLowerCase().indexOf(first) !== -1) score += 20;
            if (row.folderPath.toLowerCase().indexOf(first) !== -1) score += 10;
            matches.push({ row: row, score: score });
        }
        matches.sort(function (a, b) {
            if (b.score !== a.score) return b.score - a.score;
            if (a.row.folderPath !== b.row.folderPath) return a.row.folderPath.localeCompare(b.row.folderPath);
            return a.row.label.localeCompare(b.row.label);
        });
        renderResults(matches, q, tokens);
    }

    var folderNames = {};   // "scope/path" -> display name, learned from entries
    function renderResults(matches, query, tokens) {
        var content = document.getElementById('search-results');
        searchFilters.update(matches.map(function (m) { return m.row; }));
        var all = matches;
        matches = matches.filter(function (m) { return searchFilters.apply([m.row]).length > 0; });
        var summary = document.getElementById('search-summary');
        var total = searchIndex ? searchIndex.length : all.length;
        if (!query) {
            summary.innerHTML = searchFilters.active()
                ? '<strong>' + matches.length + '</strong> of ' + total + ' connections'
                : 'All <strong>' + total + '</strong> connections';
        } else {
            summary.innerHTML = '<strong>' + matches.length + '</strong>' +
                (searchFilters.active() && all.length !== matches.length ? ' of ' + all.length : '') +
                ' match' + (matches.length === 1 ? '' : 'es') + ' for <strong>' + esc(query) + '</strong>';
        }
        if (matches.length === 0) {
            content.innerHTML = '<div class="empty-state"><p style="color:var(--text-dim);margin:0">' +
                (query ? (all.length ? 'No matches for ' + esc(query) + ' with the current filters' : 'No matches for ' + esc(query)) : 'No connections match the current filters') +
                '</p></div>';
            return;
        }
        var max = 50, more = matches.length - max, shown = matches.slice(0, max);
        var html = '<table class="entries-table search-results"><colgroup><col class="c-name"><col class="c-type"><col class="c-host"><col class="c-user"><col class="c-folder"><col class="c-actions"></colgroup>' +
            '<thead><tr><th>Name</th><th>Type</th><th>Host</th><th>User</th><th>Folder</th><th></th></tr></thead><tbody>';
        shown.forEach(function (m) {
            var r = m.row, e = r.entry;
            var typeLabel = e.session_type.toUpperCase();
            var typeCls = 'type-' + e.session_type;
            var needsPrompt = (e.prompt_credentials || !e.has_credentials) && e.session_type !== 'web' && e.session_type !== 'proxmox';
            var connectLabel = needsPrompt ? 'Login…' : 'Connect';
            var userCol = e.session_type === 'proxmox' ? highlight(e.proxmox_token_id || '', tokens) : (e.username ? highlight(e.username, tokens) : '');
            var scopeIcon = r.scope === 'shared' ? '⊕' : '▣';
            var fName = folderNames[r.scope + '/' + r.folderPath] || r.folderPath;
            html += '<tr>' +
                '<td title="' + attr(r.label) + '">' + entryNameHtml(r.label, tokens) + '</td>' +
                '<td><span class="type-badge ' + typeCls + '">' + esc(typeLabel) + '</span></td>' +
                '<td class="host-cell" title="' + attr(r.host || '') + '">' + highlight(r.host || '', tokens) + '</td>' +
                '<td>' + userCol + '</td>' +
                '<td class="folder-cell" title="' + attr(r.scope + '/' + r.folderPath) + '"><span class="fname"><span class="folder-scope">' + scopeIcon + '</span>' + highlight(fName, tokens) + '</span>' +
                (fName !== r.folderPath ? '<span class="fkey">' + highlight(r.folderPath, tokens) + '</span>' : '') + '</td>' +
                '<td class="actions-cell"><button class="btn-connect" data-sc-connect="' + attr(e.name) + '" data-scope="' + attr(r.scope) + '" data-folder="' + attr(r.folderPath) + '">' + connectLabel + '</button>' +
                '<a href="#" class="search-open-folder" data-open-scope="' + attr(r.scope) + '" data-open-folder="' + attr(r.folderPath) + '" title="Open this folder">folder ↗</a></td>' +
                '</tr>';
        });
        html += '</tbody></table>';
        if (more > 0) html += '<div class="search-more">+' + more + ' more — refine your search to narrow results</div>';
        content.innerHTML = html;
        content.scrollTop = 0;
    }

    // Connect to an entry: open the client in a window opened within this click
    // (keeps activation for fullscreen). Missing credentials send the user to
    // the connections page to set them.
    function doConnect(scope, folder, name) {
        var win = window.open('', '_blank');
        var body = { width: window.innerWidth, height: window.innerHeight, dpi: Math.round((window.devicePixelRatio || 1) * 96) };
        if (window.screen && screen.width) { body.screen_width = screen.width; body.screen_height = screen.height; }
        fetch('/api/addressbook/folders/' + encodeURIComponent(scope) + '/' + encodeURIComponent(folder) + '/entries/' + encodeURIComponent(name) + '/connect',
            { method: 'POST', headers: headers({ 'Content-Type': 'application/json' }), credentials: 'same-origin', body: JSON.stringify(body) })
            .then(function (res) {
                if (!res.ok) {
                    if (win && !win.closed) win.close();
                    if (res.status === 412) { openFolder(scope, folder); return null; }
                    return res.text().then(function (t) { throw new Error(t); });
                }
                return res.json();
            })
            .then(function (data) {
                if (!data) return;
                var url = data.client_url + '?name=' + encodeURIComponent(name);
                if (win && !win.closed) win.location.href = url; else window.open(url, '_blank');
            })
            .catch(function () { if (win && !win.closed) win.close(); });
    }
    function openFolder(scope, path) {
        location.href = '/connections.html#open=' + encodeURIComponent(scope + '/' + path);
    }

    function wire() {
        var inp = input();
        inp.addEventListener('input', runSearch);
        inp.addEventListener('focus', function () { setEngaged(true); });
        inp.addEventListener('blur', function () {
            if (inp.value) return;
            clearTimeout(keepTimer);
            keepTimer = setTimeout(function () {
                if (document.activeElement === inp || inp.value) return;
                var a = document.activeElement, ov = overlay();
                if (a && ov && ov.contains(a) && a !== document.body) return;
                if (keepUntil > Date.now()) return;
                setEngaged(false);
            }, 150);
        });
        inp.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') { inp.value = ''; inp.blur(); setEngaged(false); e.stopPropagation(); }
        });
        document.addEventListener('mousedown', function (e) {
            var panel = document.getElementById('search-overlay-panel');
            if (panel && panel.contains(e.target)) keepUntil = Date.now() + 400;
        }, true);
        overlay().addEventListener('mousedown', function (e) { if (e.target === this) close(); });
        document.getElementById('search-results').addEventListener('click', function (e) {
            var t = e.target;
            var open = t.closest && t.closest('.search-open-folder');
            if (open) { e.preventDefault(); openFolder(open.getAttribute('data-open-scope'), open.getAttribute('data-open-folder')); return; }
            var conn = t.closest && t.closest('[data-sc-connect]');
            if (conn) { e.preventDefault(); doConnect(conn.getAttribute('data-scope'), conn.getAttribute('data-folder'), conn.getAttribute('data-sc-connect')); }
        });
        // "/" focuses the search unless typing in a field or a modal is open.
        document.addEventListener('keydown', function (e) {
            if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
            var t = document.activeElement;
            if (t) { var tag = t.tagName; if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable) return; }
            if (document.querySelector('.modal-overlay.active')) return;
            if (inp.disabled) return;
            e.preventDefault(); e.stopPropagation();
            setTimeout(function () { inp.focus(); inp.select(); }, 0);
        });
    }

    function start() {
        injectStyle();
        injectUI();
        var mkFilters = function () {
            searchFilters = window.rgFilters.create({
                mount: document.getElementById('search-facets'),
                id: 'global-search',
                facets: [
                    { key: 'type', label: 'Type', value: function (x) { return x.entry.session_type; },
                      render: function (v) { return '<span class="type-badge type-' + attr(v) + '">' + esc(v) + '</span>'; } },
                    { key: 'folder', label: 'Folder', value: function (x) { return x.folderPath || null; } }
                ],
                onChange: function () { runSearch(); }
            });
            wire();
            loadIndex();
        };
        if (window.rgFilters) { mkFilters(); }
        else {
            var s = document.createElement('script'); s.src = '/filters.js';
            s.onload = mkFilters; document.head.appendChild(s);
        }
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
})();
