// Browser, sign-in and API helpers shared by seed.mjs and capture.mjs.

export const BASE = (process.env.RUSTGUAC_URL || 'https://rustguac:8089').replace(/\/$/, '');

// Desktop shots are 1440x900 pixels of a 1600x1000 CSS viewport (90% zoom),
// which fits a whole table row of the wider pages without wrapping.
export const DESKTOP = { width: 1600, height: 1000, scale: 0.9 };

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function log(...args) {
  console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...args);
}

// Wait until rustguac answers its health check.
export async function waitForRustguac(request, timeoutMs = 120000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await request.get(`${BASE}/api/health`, { ignoreHTTPSErrors: true });
      if (res.ok()) return;
    } catch {
      // not listening yet
    }
    if (Date.now() > until) throw new Error(`rustguac did not become healthy at ${BASE}`);
    await sleep(1000);
  }
}

// A browser context for one user, signed in through the mock OIDC provider.
// `theme` is stored the way the gear menu stores it, so every page opens in it.
export async function signIn(browser, user, { theme = 'aurora', size = DESKTOP } = {}) {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: size.width, height: size.height },
    deviceScaleFactor: size.scale,
    locale: 'en-GB',
    timezoneId: 'UTC',
  });
  await context.addInitScript((t) => {
    try {
      localStorage.setItem('rustguac_theme', t);
      localStorage.setItem('rustguac_onboarding_dismissed', '1');
    } catch {
      // storage is unavailable on about:blank
    }
  }, theme);

  const page = await context.newPage();
  await page.goto(`${BASE}/auth/login`);
  await page.locator('input[name="username"]').fill(user.email);
  await page.locator('textarea[name="claims"]').fill(JSON.stringify({
    email: user.email,
    email_verified: true,
    name: user.name,
    groups: user.groups,
  }));
  await Promise.all([
    page.waitForURL((url) => url.href.startsWith(BASE)),
    page.locator('input[type="submit"]').click(),
  ]);
  // /api/me names an OIDC user by email in `name`.
  const me = await api(context, 'GET', '/api/me');
  if (me.name !== user.email) throw new Error(`signed in as ${me.name}, expected ${user.email}`);
  return { context, page };
}

// Call the rustguac API with the context's session cookie.
export async function api(context, method, path, body, headers = {}) {
  const res = await context.request.fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    data: body === undefined ? undefined : JSON.stringify(body),
    ignoreHTTPSErrors: true,
  });
  const text = await res.text();
  if (!res.ok()) throw new Error(`${method} ${path}: ${res.status()} ${text}`);
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

// Open a page and wait for its data to load.
export async function openPage(context, path) {
  const page = await context.newPage();
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
  await sleep(500);
  return page;
}
