# End-to-end tests

Playwright specs that drive the real pages in `static/` against a stubbed
API. Nothing here needs Vault, guacd, Docker or a browser session: `serve.mjs`
serves the static tree over HTTP and every spec installs `lib/api.mjs`, which
answers `/api/*` from a small fixture address book (two named tenants and
twenty generic ones, two sessions, two recordings) and records every request
the page makes so a spec can assert on what was sent.

```sh
cd tests/e2e
npm ci
npx playwright install chromium   # once
npm test                          # all specs
npx playwright test specs/global-search.spec.mjs
npx playwright test --ui          # step through a spec
```

`PW_CHROMIUM=/path/to/chrome` runs against an already installed Chromium
instead of the one Playwright downloads. CI runs the suite in the `e2e` job.

One spec per change, named after the branch that introduced it:

| spec | pins |
|---|---|
| `tables-1710` | #252: no horizontal overflow at 1710px on Connections, Recordings and Reports, with short and with long unbreakable names |
| `sessions-adhoc-modal` | ad-hoc form opens as a modal |

The fixture suppresses the first-visit onboarding tour (`options.onboarding`
re-enables it) and defaults to the admin role; pass `role` to test gating.
