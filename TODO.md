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
