# TODO - Email Followupper

## Open items

- **[CUTOVER BLOCKER, out of scope] The dashboard artifact pins its own build
  base to `/`.** `artifacts/dashboard/.replit-artifact/artifact.toml` sets
  `[services.env] BASE_PATH = "/"`. If that env governs the dashboard build at
  cutover, the SPA the api-server serves under `/followup` will reference
  `/assets/...` instead of `/followup/assets/...` and **every asset 404s**,
  even though the server side is correct. Verified both ways locally: built
  with `BASE_PATH=/` the html emits `src="/assets/index-*.js"`; built with
  `BASE_PATH=/followup/` it emits `src="/followup/assets/index-*.js"`.
  **Cutover step:** set the dashboard's `BASE_PATH` to `/followup/` (or build it
  with that value) in the same change that sets the api-server's. Not fixed
  here: Bundle 2 item 6 authorizes editing only `api-server`'s artifact.toml.

- **[Pre-existing, out of scope] `GET /api/gmail/sent-emails` returns 500
  `deleted_client`.** Google rejects the stored OAuth client for the Gmail
  sent-emails path. Reproduces identically on `main` and on this branch in dark
  mode, so it predates Bundle 2 and is unrelated to path routing — the request
  reaches the correct route in both modes. Powers the Email Inspector page.
  Likely needs the Google Cloud OAuth client re-created and accounts
  reconnected. Untouched here.

- **[RESOLVED in Bundle 2] `lib/api-client-react` does not honour BASE_PATH.**
  Fixed by `setBaseUrl(ROUTER_BASE)` in `dashboard/src/main.tsx`; no generated
  file was hand-edited. Verified in both modes against a live server. Original
  finding retained below for history.

- **[Bundle 1 finding, now resolved] `lib/api-client-react` does not honour BASE_PATH.** The generated
  Orval client hardcodes rooted paths (`/api/stats`, `/api/gmail/accounts`, …,
  20 distinct paths in `lib/api-client-react/src/generated/api.ts`). It does
  **not** hardcode a protocol+host base URL. A runtime setter already exists:
  `setBaseUrl(url)` in `lib/api-client-react/src/custom-fetch.ts:28`, exported
  from `lib/api-client-react/src/index.ts:4`; `applyBaseUrl()` (line 60)
  prepends it only to inputs starting with `/`, and `_baseUrl` defaults to
  `null` (no prefix). So today the client emits `/api/...` verbatim.
  Four dashboard pages consume these hooks (`accounts.tsx`, `dashboard.tsx`,
  `email-inspector.tsx`, `pipeline.tsx`). Under a non-root BASE_PATH those
  calls would bypass the prefix and 404. **Bundle 2 fix:** call
  `setBaseUrl(BASE_PATH without trailing slash)` once at dashboard startup.
  No code change made in Bundle 1, by instruction.

- **[RESOLVED in Bundle 2] `pnpm run build` fails at `mockup-sandbox`
  unless `PORT` and `BASE_PATH` are exported.**
  `artifacts/mockup-sandbox/vite.config.ts:10` throws when `PORT` is unset and
  line 24 throws when `BASE_PATH` is unset, both unconditionally — unlike
  `artifacts/dashboard/vite.config.ts`, which guards the `PORT` check behind
  `isBuild`. Proven to predate this bundle: reproduced on a clean tree with
  zero edits (only untracked `ROADMAP.md`), and the file's sole commit is the
  repo-root snapshot `858102c`. Not touched — `mockup-sandbox` is outside the
  Bundle 1 scope (api-server, dashboard, lib, addon).

## External registrations discovered

These register this app's URL with an external service. **None were changed.**

| # | Where | File:line | What registers | Value today |
|---|---|---|---|---|
| 1 | Google Cloud OAuth (login flow) | `artifacts/api-server/src/routes/auth.ts:23-29` | Redirect URI `<origin>/api/auth/callback` sent to Google; must be allowlisted in the Cloud console | `https://followupper.mobupps.net/api/auth/callback` |
| 2 | Google Cloud OAuth (Gmail flow) | `artifacts/api-server/src/routes/gmail-auth.ts:33-39` | Redirect URI `<origin>/api/gmail/callback` sent to Google; must be allowlisted in the Cloud console | `https://followupper.mobupps.net/api/gmail/callback` |
| 3 | Apps Script add-on → backend | `addon/Config.gs:11` | Add-on calls the backend at the `BACKEND_URL` Script Property (fallback `http://localhost:3000`). Set in the Apps Script project, not in this repo. | Script Property, not in code |
| 4 | Deployment env (canonical address) | `.replit:33` (`[userenv.shared] APP_URL`) | Supplies the origin both OAuth redirect URIs are built from | `https://followupper.mobupps.net` |

Notes:
- 1 and 2 are the only outbound registrations built from code. Both derive
  their origin from `APP_URL`; changing the address requires updating the
  Google Cloud console allowlist by hand.
- `.replit:27-32` already carries a comment recording this coupling from the
  2026-07-16 domain move.
- No webhook registrations, no Gmail push/watch subscriptions, and no
  Pub/Sub topics exist in this codebase.

## Ledger

### 2026-07-31 — Bundle 2: base-path switch — BLAST RADIUS (pre-edit)

Branch `bundle-2-base-path`. Goal: app fully servable under `/followup`,
controlled by BASE_PATH/PUBLIC_URL, dark when both are unset.

**Files to be touched — 8** (7 modified, 1 new)

| File | Change |
|---|---|
| `api-server/src/lib/appUrls.ts` | one-prefix rule for `publicUrl`/`redirectPath`; prefix-aware `publicOrigin()` fallback |
| `api-server/src/app.ts` | bare-prefix redirect, prefixed API mount, unconditional health mount, SPA static + catch-all, JSON-404 terminator |
| `api-server/.replit-artifact/artifact.toml` | `paths = ["/api"]` -> `["/api", "/followup"]` (only line changed) |
| `api-server/src/tests/test-base-path.ts` | NEW — unit tests, both modes |
| `dashboard/src/main.tsx` | `setBaseUrl(ROUTER_BASE)` at startup |
| `dashboard/vite.config.ts` | normalize BASE_PATH to a trailing-slash base |
| `dashboard/src/components/ui/sidebar.tsx` | cookie path/name scoped to BASE_PATH |
| `mockup-sandbox/vite.config.ts` | `isBuild` guard (authorized side fix) |

**Behaviors affected:** every dashboard API call, both OAuth round-trips,
static asset serving, SPA deep links, the platform startup health check.

**Worst realistic failure — three named traps, all pre-identified:**
1. **Bare-prefix redirect loop.** Express non-strict routing makes a route at
   `/followup` also match `/followup/`, so a naive redirect targets itself and
   the main page dies. Mitigation: an exact `req.path === BASE_PATH` string
   compare in plain middleware — no route matching involved at all.
2. **Express 5 wildcard crash.** Verified empirically: `app.get("/followup/*")`
   **throws at registration** under Express 5.2.1 / path-to-regexp v8
   (`Missing parameter name at index 11`). That is a boot crash, not a 404.
   Mitigation: use `app.use(BASE_PATH, ...)` middleware, never a wildcard route.
3. **Double prefix.** `PUBLIC_URL` carries the prefix
   (`https://tools.mobupps.net/followup`), so Bundle 1's
   `publicUrl = origin + appPath(p)` would emit `/followup/followup/...`.
   Mitigation: `PUBLIC_URL` owns the prefix; `appPath()` adds it only for
   server-local relative paths.

**Rollback:** unset both env vars (the app returns to the dark path with no
code change); or `git checkout main` — branch unmerged, nothing deployed.

### 2026-07-31 — Bundle 2: base-path switch — DONE

All 10 scope items delivered. 8 files (7 modified, 1 new test file).

**Design decision — who owns the prefix.** `PUBLIC_URL` is the full public
base and already contains the prefix, so `publicUrl()`/`redirectPath()` append
the raw path to it. `appPath()` adds `BASE_PATH` and is used only for
server-local relative paths. With `BASE_PATH="/"` the two are the same
function, which is what keeps the dark path unchanged. Bundle 1's asymmetry is
intact: `auth.ts` emits absolute Locations, `gmail-auth.ts` relative ones —
now relative *and prefixed*.

**Deliberate: the unprefixed `/api` mount stays** under BASE_PATH. It is what
the platform startup health check and the Apps Script add-on
(`BACKEND_URL + /api/...`) call, and it is exactly today's behavior, so it adds
no new exposure. The prefixed mount is additive.

**Item 8 — cookies, corrected.** Bundle 1's "no cookies" holds for auth
(localStorage) and for sessions (none exist; `cookie-parser` is a dependency
that is never imported). But there IS one cookie:
`dashboard/src/components/ui/sidebar.tsx` set `sidebar_state` with `path=/`.
The component is unused scaffold and never runs, so this is latent — but under
the gateway two tools share one origin and that cookie would collide. Now
scoped to `BASE_PATH` and named per-app, only when BASE_PATH is set.

**Gates**
| Gate | Result |
|---|---|
| typecheck | PASS |
| tests | 34/34 files (33 prior + new `test-base-path.ts`, 25 cases) |
| build, **no `PORT`/`BASE_PATH` exported** | PASS, exit 0 — item 10 achieved; `mockup-sandbox` now builds at its own `/__mockup/` base |

**Godlike audit — 3 rounds, closed clean.** Round 1 findings:
1. *(fixed, in scope)* A missing dashboard build under BASE_PATH produced an
   opaque 500 per SPA request. Now a boot-time `logger.warn` naming the path.
2. *(recorded, out of scope)* Dashboard artifact pins its own build base — see
   Open items; item 6 forbids editing that file.
3. *(fixed, in my own tooling)* The one-prefix oracle counted substrings, and
   `"/followup"` also occurs inside `"/followups"`, a real route — it reported
   a false double-prefix. Both the smoke and the unit tests now count path
   SEGMENTS. Sanity-checked that the new oracle still catches a genuine double
   prefix.
Rounds 2 and 3 clean.

**Security framing — Bundle 1's two defects cannot recur.** Re-verified with a
URL-parser oracle (never string shape — the Bundle 1 string check passed while
`/\evil.example` still resolved off-site). Hostile `BASE_PATH` and hostile path
inputs, in both modes, resolved through `new URL(value, origin)`: the host never
moves. On the live LIT server, 9 Location headers across the whole redirect
surface — including `?x=//evil.example`, `?next=https://evil.example`, and a
CRLF attempt — all stayed on-origin, none protocol-relative, none with CRLF.
`PUBLIC_URL` is now stored as the parser's canonical `href`, so a backslash
cannot survive into an outgoing URL. Static traversal probes
(`/followup/../../../etc/passwd`, encoded variants) disclosed no file.

**Traps avoided, both verified empirically before writing code**
- `app.get("/followup/*")` **throws at registration** under Express 5.2.1 /
  path-to-regexp v8 — a boot crash, not a 404. All prefix handling uses
  `app.use(BASE_PATH, ...)`, which never touches path-to-regexp.
- The bare-prefix redirect uses an exact `req.path === BASE_PATH` compare in
  plain middleware, so the non-strict-routing self-redirect loop is
  structurally impossible. Asserted in the unit tests ("the redirect target
  never equals the request path") and in the lit smoke (`/followup` -> 302
  -> `/followup/` -> 200, not another 302).

**SMOKE a — DARK (both env vars unset): byte-for-byte identical to `main`.**
All 16 Bundle 1 baseline endpoints diffed clean against a `main` worktree
booted side by side. `/followup`, `/followup/`, `/followup/api/healthz` all
still 404 exactly as on `main` — none of the new mounts exist when dark.

**SMOKE b — LIT (`BASE_PATH=/followup/`, `PUBLIC_URL=https://tools.mobupps.net/followup`,
process env only, never written to Replit Secrets): 14/14 checks pass.**

| Check | Result |
|---|---|
| main page `/followup/` | 200 |
| deep links (`/pipeline`, `/accounts`, `/context/pipeline`, `/anti-ghosting`) hard-load | 200 |
| bare `/followup` -> `/followup/` | 302, and the target returns 200 — **no loop** |
| query preserved across the redirect | `/followup/?login_code=abc&x=1` |
| assets referenced by the served index.html | 3/3 resolve, **zero 404s** |
| missing asset | 404 (Express error page, **not** index.html 200) |
| unmatched API path | JSON — 404 `{"error":"Not found"}` authorized; 401/403 unauthorized, which correctly does not leak route existence. Never index.html. |
| platform health `/api/healthz` unprefixed | 200 |
| health `/followup/api/healthz` prefixed | 200 |
| all 16 baseline endpoints under the prefix | correct |

**Item 1 verified end-to-end** by driving the REAL generated client (the module
the four pages import) against both servers with `setBaseUrl()` configured as
`main.tsx` configures it: 5/5 calls covering all four pages route correctly in
both modes — `/followup/api/...` lit, `/api/...` dark. One call returns upstream
500 `deleted_client`; that reproduces identically on `main` and is a Google-side
OAuth client problem, not routing (see Open items).

**Item 9:** all four generated outgoing URLs (both OAuth `redirect_uri`s, both
callback Locations) carry exactly one prefix segment.

**Blast radius held.** Predicted 8 files, 8 touched. All three named traps were
avoided; the one that materialized (missing SPA build) was caught by the audit
and fixed. No database, cron, doctrine, or dependency changes. No email
dispatched — `app.ts` was booted directly in every smoke, so `startCronJobs()`
never ran. The running workflow was never touched; ports 5411/5412/5413 were
used and all were shut down individually by PID.

### 2026-07-31 — Bundle 1: URL centralization — DONE

Branch `bundle-1-url-centralization`. Goal: route every hardcoded public
address / rooted path through one config module, zero behavior change.

**Discovery.** Much of the stated scope does not exist in this app, verified
rather than assumed: no cookies and no sessions anywhere (auth is an API key
plus a one-shot login code; zero `Set-Cookie` in the codebase), no SSE or
live-progress endpoints, and the weekly digest (`services/weeklyDigest.ts`)
contains no links at all — zero `http`/`href` occurrences in 610 lines. The
real surface was 2 OAuth redirect-URI builders, 11 server-side redirects, and
65 client-side base-path expressions.

**Modules created**
- `artifacts/api-server/src/lib/appUrls.ts` — `BASE_PATH` (default `/`),
  `PUBLIC_URL`, `publicOrigin()`, `appPath()`, `publicUrl()`, `redirectPath()`.
- `artifacts/dashboard/src/lib/app-urls.ts` — `BASE_PATH`, `ROUTER_BASE`,
  `apiUrl()`.

**Files touched: 23** (2 new, 21 modified) — 64 inline
`import.meta.env.BASE_URL || "/"` sites across 17 files, `App.tsx` router base,
`auth.ts` (redirect URI + 7 redirects), `gmail-auth.ts` (redirect URI +
7 redirects), and 3 bare `/api/...` fetches that bypassed the prefix entirely
(`anti-ghosting.tsx` ×2, `email-inspector.tsx` ×1) — a latent Bundle 2 bug
fixed now at no behavior cost.

**Two asymmetries preserved deliberately** (collapsing either would have been a
silent behavior change):
1. `auth.ts` callbacks prefix the configured origin (`redirectPath`);
   `gmail-auth.ts` callbacks stay same-origin **relative** (`appPath`).
2. `PUBLIC_URL` resolves `PUBLIC_URL || APP_URL || <Replit-domain fallback>`
   rather than hardcoding `https://followupper.mobupps.net`. That literal is
   not in the code today — it comes from `.replit:33` — so hardcoding it would
   have changed dev behavior and broken the byte-for-byte rule.

**Gates**
| Gate | Result |
|---|---|
| typecheck (`pnpm run typecheck`) | PASS |
| tests (33 files, `tsx --test`) | 33/33 PASS — diff vs pre-bundle baseline: identical |
| build (all except `mockup-sandbox`) | PASS |
| build (`mockup-sandbox`) | FAIL — **pre-existing**, see Open items; reproduced on a clean tree with zero edits |

**Godlike audit — 3 rounds, closed clean.** Round 1 (security) found two real
defects, both fixed:
1. `PUBLIC_URL="//evil.example"` made `redirectPath()` emit a
   protocol-relative URL — every login redirect, carrying the login code in
   its query string, would have landed on the attacker's host. `PUBLIC_URL` is
   now validated as an absolute http(s) origin and ignored otherwise.
2. `BASE_PATH="/\evil.example"` produced an **open redirect** that a
   leading-`//` check does not catch: the WHATWG URL parser treats `/\` as
   `//`, so `new URL("/\evil.example/accounts", "https://good.example")`
   resolves to `https://evil.example/accounts`. Backslashes are now rejected
   in `BASE_PATH` and stripped in `appPath()`/`apiUrl()`.
Rounds 2 and 3 clean. The round-1 string-shape check missed defect 2, so
round 3 replaced it with a URL-parser oracle that resolves every emitted value
and asserts the host never changes.

**Evidence**
- 90 byte-for-byte assertions replaying the *old* expressions verbatim against
  the new helpers across 5 env configurations (unset, production `APP_URL`,
  `REPLIT_DEV_DOMAIN`, `REPLIT_DOMAINS`, trailing-slash `APP_URL`).
- 450 adversarial + 756 URL-parser-oracle assertions: no protocol-relative
  output, no CRLF, host never escapes.
- Client: built the dashboard from `main` in a throwaway worktree (reproduced
  hash `index-CYnbF2YW.js` exactly) and compared emitted URL strings —
  **73 distinct API paths in both, sets identical**. The bundle differs only in
  that `${base}` is no longer constant-folded across the module boundary
  (`fetch("/api/x")` became `` fetch(`${ve}api/x`) `` with `ve="/"`),
  which is value-identical at runtime.

**Smoke — A/B against `main`, byte-for-byte identical.** Booted `app.ts`
directly (never `index.ts`) on ports 5199/5200 so `startCronJobs()` never ran
and no follow-up email could be dispatched. No workflow was running; nothing
was restarted. **This endpoint list is the Bundle 2 baseline:**

| # | Endpoint | Result (identical before/after) |
|---|---|---|
| 1 | `GET /api/healthz` | 200 `{"status":"ok"}` |
| 2 | `GET /api/auth/google` | 200, `redirect_uri=https://followupper.mobupps.net/api/auth/callback` |
| 3 | `GET /api/auth/callback?error=access_denied` | 302 → `https://followupper.mobupps.net/?login_error=denied` |
| 4 | `GET /api/auth/callback` | 302 → `…/?login_error=missing_params` |
| 5 | `GET /api/auth/callback?code=x&state=nope` | 302 → `…/?login_error=expired` |
| 6 | `POST /api/auth/exchange` (no code) | 400 `Missing code` |
| 7 | `GET /api/gmail/auth` | 200, `redirect_uri=https://followupper.mobupps.net/api/gmail/callback` |
| 8 | `GET /api/gmail/callback?error=denied` | 302 → `/?oauth_error=denied` (**relative**) |
| 9 | `GET /api/gmail/callback` | 302 → `/?oauth_error=missing_params` (relative) |
| 10 | `GET /api/gmail/callback?code=x&state=nope` | 302 → `/?oauth_error=invalid_state` (relative) |
| 11 | `GET /api/gmail/accounts` (+key) | 200, 1 account |
| 12 | `GET /api/stats` (+key) | 200 `total_sent:41, sent_followups:37` |
| 13 | `GET /api/prospects` (+key) | 400 list-guard (pre-existing, by design) |
| 14 | `GET /api/followups` (+key) | 400 list-guard (pre-existing, by design) |
| 15 | `GET /api/context/stats` (+key) | 200 all-zero |
| 16 | `GET /api/gmail/accounts` (no key) | 401 `Invalid API key` |

**Blast radius held.** Predicted 23 files, 23 touched. Predicted worst failure
(a join emitting a protocol-relative URL) was found twice by the audit and
fixed before merge. No database, scheduler, doctrine, or dependency changes.
`source-code/` untouched; no mirror sync run.
