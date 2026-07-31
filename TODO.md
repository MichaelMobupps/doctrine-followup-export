# TODO - Email Followupper

## Open items

- **[Bundle 2] `lib/api-client-react` does not honour BASE_PATH.** The generated
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

- **[Pre-existing, out of scope] `pnpm run build` fails at `mockup-sandbox`
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
