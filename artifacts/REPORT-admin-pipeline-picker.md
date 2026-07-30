# Report — Real admin gate (separate admin token) + pipeline picker behind it

## What shipped

A separate admin secret (`ADMIN_API_KEY`) is now issued ONLY to allowlisted
people at the OAuth exchange, every `/api/admin/*` endpoint requires it, and the
pipeline user picker + Admin Activity page are gated on real admin status.

### Server

1. **`lib/adminAccess.ts`** (new, pure, unit-tested): `parseAdminEmails`,
   `isAdminEmail`, `resolveAdminGrant`. Admin status is decided ONLY from the
   OAuth-verified email vs the `ADMIN_EMAILS` allowlist (case-insensitive,
   trimmed). Fails closed.
2. **`middlewares/requireAdmin.ts`** (new): reads `x-admin-key`; 500 if
   `ADMIN_API_KEY` unset, 403 if header missing/wrong, `next()` only on exact
   match. It checks the unset case BEFORE the header, so an empty/absent header
   can never match an empty expected value. SEPARATE from the shared-key
   `authMiddleware` (unchanged).
3. **`routes/auth.ts`**: `/auth/exchange` now calls `resolveAdminGrant` on the
   server-stored verified email (`codeData.metadata`, NOT any client input) and
   returns `isAdmin` plus, for admins only, `adminToken: ADMIN_API_KEY`. Normal
   login is unchanged: every user still gets `{ token, email }`. If
   `ADMIN_API_KEY` is unset, no one is admin and the `adminToken` field is
   omitted entirely (never an empty string). The admin secret is never logged.
4. **All 8 admin routers** (`admin-salvage`, `admin-activity`,
   `admin-activity-report`, `admin-user-controls`, `admin-user-kill`,
   `admin-prospect-kill`, `admin-global-controls`, `admin-suppression`) had
   their local shared-key `authMiddleware` replaced with `requireAdmin`. The
   live set was confirmed by reading `routes/index.ts` and grepping
   `router.use(authMiddleware)` across `routes/`.

### Client

1. **`hooks/use-admin.ts`** (new): `AdminProvider` + `useAdmin()` returning
   `{ isAdmin, adminToken }`, persisted in localStorage the same way the shared
   key is. Honours the admin flag only when a token is actually present.
2. **`components/api-key-provider.tsx`**: captures `isAdmin`/`adminToken` from
   the exchange response. A non-admin response clears any stale admin token.
3. **Every `/api/admin/*` call sends `x-admin-key`** — all enumerated and
   converted: 9 in `admin-activity.tsx` (activity, global-pause,
   pause-all/resume-all, suppression GET/POST/DELETE, activity-report, user
   pause/resume, user kill), 1 in `use-manager-options.ts`, 1 in
   `prospect-kill-control.tsx`. Total 11.
4. **`components/layout.tsx`**: Admin Activity nav entry gated on `isAdmin`;
   logout clears the admin grant.
5. **`pages/admin-activity.tsx`**: returns a "no admin access" panel when
   `!isAdmin` (after all hooks, so no rules-of-hooks violation).
6. **Picker** (`components/pipeline-user-picker.tsx`): now gates on `isAdmin`
   (was mere key presence). `use-manager-options.ts` only fetches when admin
   and sends the admin token. The three pipeline pages
   (`pipeline`, `context-pipeline`, `anti-ghosting-pipeline`) pass
   `isAdmin={isAdmin}` and wire the selected manager's id into the primary +
   archived loads (unchanged wiring), with the persistent viewing-as-admin
   banner for a non-self manager.

## REQUIRED operator setup (feature does NOT work until done)

Set BOTH in the workspace secrets AND the deployment secrets:

- `ADMIN_EMAILS` — comma-separated admin emails, e.g. `boss@mobupps.com,ops@mobupps.com`.
- `ADMIN_API_KEY` — a secret **distinct from `ADDON_API_KEY`**. If the two were
  equal, every shared-key holder would be admin. The code reads them as two
  separate env vars; the operator MUST set distinct values. Generate a fresh
  random value (e.g. `openssl rand -hex 32`).

After deploy, **admins must log out and back in** to receive the admin token —
tokens issued before this change do not carry it.

## Godlike audit result (looped to two clean passes)

### The gate itself
- Every admin endpoint requires `x-admin-key`; verified all 8 routers now
  `router.use(requireAdmin)` (grep across `routes/`). No admin router references
  `ADDON_API_KEY` for auth anymore.
- Admin token is issued only when the OAuth-verified email is in `ADMIN_EMAILS`.
  The only input to `resolveAdminGrant` is the server-stored verified email; a
  client-sent email cannot influence it. Unit test asserts an
  attacker-asserted email is rejected.
- `ADMIN_API_KEY`/`adminToken`/`ADMIN_EMAILS` are never logged (grep for
  logger/console references returned none).
- Unset `ADMIN_API_KEY` fails closed: `resolveAdminGrant` returns
  `{ isAdmin: false }` with no token; `requireAdmin` returns 500 before reading
  the header so an empty header never matches an empty key. Unit tests cover
  both, including the empty-string-header case (403).
- Distinct-key requirement: enforced by the REPORT/operator (the code reads two
  separate env vars). Stated above as a hard requirement.

### Client coverage
- All 11 `/api/admin/*` calls send `x-admin-key` (enumerated above; grep
  confirmed 0 remaining bare admin fetches).
- Admin Activity page and the picker render only when `isAdmin`.
- Normal non-admin calls (`/my/*`, per-campaign pause/resume/restore, lists,
  bulk send/pause/resume) are unchanged and still send only the shared key.

### Non-regression
- `/my/*`, per-campaign controls, and list endpoints (in `doctrine.ts`,
  `context.ts`, `anti-ghosting.ts`) are untouched; only `admin-*` routers use
  `requireAdmin`.
- Full suite green: `tsx --test src/tests/*.ts` → **477 tests pass, 0 fail**.
- Both typechecks pass; both builds succeed.

## Blast radius

1. **What it touches.** Adds an admin token at login, a `requireAdmin` guard,
   that guard on every admin router, the client `x-admin-key` header on admin
   calls, and the picker gate. Changes the access model for the admin surface
   only.
2. **What it cannot reach.** No database change, no kill/pause semantics change,
   no per-campaign or per-user data flow change. A fault here is an access fault
   — a 403 or a hidden control — not data loss.
3. **Worst cases.** *Too tight:* a missed client header or a misread allowlist
   locks an admin out of the dashboard or kills; recoverable by fixing the
   header/allowlist and re-login. *Too loose:* the residual reads/reversible
   controls named below. The destructive path — the kills — is **fully closed**.

## Residual exposure (honest boundary)

This fully protects the destructive and admin actions: the kills, the admin
dashboard, the per-user admin pause, global controls, and suppression now
require the admin token, and the picker is admin-only.

It does **not** fully isolate per-user data reads or the per-campaign reversible
controls. The list endpoints still honor a `userId` query parameter under the
shared key, and the per-campaign pause/resume/restore still act by prospect id
under the shared key. A determined shared-key holder could still read another
manager's campaign list or pause one of their campaigns by crafting a raw
request. These are reversible and were reachable before this feature. Closing
them fully requires per-user tokens — a separate, larger change. This is the
named residual.

## Ship steps

1. **Set secrets first** (workspace AND deployment): `ADMIN_EMAILS` and
   `ADMIN_API_KEY` (distinct from `ADDON_API_KEY`).
2. Upload `apply.sh` + `payload.zip` to the workspace root.
3. Run `bash apply.sh`; wait for `SUCCESS` (it runs typecheck, the 477-test
   gate, and both builds). No `apply-schema.sql` — no schema change.
4. Restart the workflow, then Republish the deployment.
5. Admins log out and back in to receive the admin token.