# TODO - Email Followupper

## Open items

- **[F-3.6b, 2026-08-10] The push to `origin` was REFUSED — no GitHub
  credential exists in this workspace, and the order's contingency points at a
  repo-local fix that is not recorded anywhere in this file.** F-3.6b is
  merged to local `main` (`8dc57f6`) with the rollback tag
  `pre-f-36b-main-tip` at `ac54213`; local `main` is **5 commits ahead of
  `origin/main`** (the two pre-existing empty "Published your App" markers,
  plus this order's two commits and the merge). `git push` fails with
  *"Invalid username or token. Password authentication is not supported for
  Git operations."*
  What is actually configured: `origin` is
  `https://github.com/MichaelMobupps/doctrine-followup-export` with **no
  credential helper** in either the repo config or the Replit global config
  (`/run/replit/user/57158411/.config/git/config`, which carries only
  `init.defaultBranch` and `user.*`); `gh` is installed but not logged in;
  no token is present in the environment. Nothing was invented and no
  credential was written — Michael owns secrets. **Michael pushes**, or
  authorises a credential, and the tag needs pushing too:
  `git push origin refs/tags/pre-f-36b-main-tip && git push origin main`.
  When the fix is made, record it here so the next order's contingency is real.

- **[F-3.6b] `startupMigrations.ts` still does not create the four BASE
  tables.** `users`, `prospects`, `followups` and `oauth_nonces` are created by
  `drizzle-kit push` alone. Every other table the server needs is now created
  at boot — `cron_heartbeats` was the last of those and F-3.6b moved it — but
  the startup migration only ever `ALTER`s the base four, so on a genuinely
  bare database its first statement throws, the single wrapping try/catch
  swallows the rest, and nothing runs. A from-scratch production database
  therefore still cannot boot to a working schema. F-3.6b's smoke bullet
  assumed otherwise and the premise was corrected before any edit; the
  achievable half (cron_heartbeats) shipped and is proven. **The exact
  boundary is now executable**: `prove-base-to-full.sh` proves the migration
  takes a base-tables-only database all the way to dev's full schema (4 → 10
  tables, 133 columns, 45 indexes, idempotent) — everything above the base
  four is covered, and only the base four are not. Closing this
  properly is its own order: adding a second definition of a table `push`
  already owns is the churn trap `cron-heartbeats.ts` records being bitten by,
  so it wants a decision about who owns the base schema, not four more
  `CREATE TABLE IF NOT EXISTS` statements.

- **[F-3.6b, observation] Two cosmetic dev↔production drifts, neither caused
  by this order.** (a) `followup_usage.cost_usd` stores its default as `0` on
  dev and `'0'::numeric` on production — semantically identical, both PG 16;
  dev's came from the startup migration's `DEFAULT 0`, production's from the
  drizzle declaration's `.default("0")`. It was equally true on 2026-08-09
  when the full diff was recorded as empty, so the publish diff does not see
  it. (b) `idx_cron_heartbeats_tick_fired_at` is `(tick_name, fired_at DESC)`
  in both databases while `lib/db/src/schema/cron-heartbeats.ts` declares it
  ascending. F-3.6b's migration matches the DATABASES, deliberately, so a
  fresh database lands where the real ones are; the declaration was left alone
  because rewriting it to chase a sort direction is exactly the republish
  churn that file's own comment warns about. Both are safe to leave and should
  be fixed, if ever, by an order that owns the publish diff.

- **[F-3.6b, out of scope] Three read-only `getLegacyGmail()` helpers still
  read the fallback identity.** `routes/email-inspector.ts`,
  `routes/context.ts` and `routes/anti-ghosting.ts` each carry a private copy
  that authorises with `GOOGLE_REFRESH_TOKEN` and pairs it with
  `process.env.SENDER_EMAIL`, used when a request arrives without a resolvable
  `userId`. They only LIST a mailbox — they never send, draft or delete — so
  they are off the send path F-3.6b was scoped to, and they were left
  untouched rather than widened into. They are still the same family: an
  inspector request that fails to resolve a user silently shows the fallback
  account's sent mail instead of refusing. `scripts/createLabels.ts` reads the
  same variable. Same verdict as the items F-3.6b closed: delete, don't harden.

- **[F-3.6b, observation] `checkThreadForReplies()` in `gmailClient.ts` has no
  callers.** Pre-existing dead export; F-3.6b made its Gmail argument required
  along with the rest of the file but did not delete the function, which is a
  separate call. Small, safe, and worth folding into the next cleanup.

- **[RESOLVED by F-3.6b, 2026-08-10] The zero-users legacy sync branch.**
  Deleted — the branch and `syncForLegacyUser()`, 290 lines. Zero connected
  accounts now throws `NoConnectedAccountsError` (503) and the cron records
  `outcome: "error"`. Original finding retained below.

- **[RESOLVED by F-3.6b, 2026-08-10] A `user_id = NULL` prospect sending
  through the legacy env-var mailbox.** Deleted. The send identity comes from
  `resolveSendIdentity()`, which contains no `process.env`; an ownerless row
  fails with `failure_reason = 'owner_missing'` before any generation or Gmail
  call. `getGmail()` is gone and the Gmail client is a required argument
  everywhere. Proven in the smoke's LIT mode, with all three variables set.
  Original finding retained below.

- **[RESOLVED by F-3.6b, 2026-08-10] `queueStageForProspect` ignores `cycle`.**
  The lookup and the INSERT carry the cycle, and stage counting is scoped to
  it in both queueing paths. Rules extracted to `lib/cycleScope.ts`. Original
  finding retained below.

- **[RESOLVED by F-3.6b, 2026-08-10] `cron_heartbeats` created by
  `drizzle-kit push`, not by `runStartupMigrations`.** Now created at boot, in
  the live production shape including the `fired_at DESC` index. The wider gap
  — the base tables — is the first Open item above. Original finding retained
  below.

- **[F-3.6a, out of scope — DELETE, do not harden — RESOLVED, see above] The
  zero-users legacy sync
  branch.** `runAllUsersSync()` falls back to `syncForLegacyUser()` when NO
  user is `is_connected`. That path swallows every per-message ingest error
  with a log line (`gmailSync.ts:1009-1012`), returns no `failed` count, and
  hands back `perUser: []` — so the cron's failure detector finds nothing and
  writes `outcome: "ok"` with `details.synced = 0`. It is the original
  ok-with-synced:0 shape, still armed: `GOOGLE_REFRESH_TOKEN` and
  `SENDER_EMAIL` are both set in the deployment. Dormant today (12 connected
  users). F-3.6a was told to record it rather than harden it. **The fix is
  deletion, not instrumentation** — the multi-user path has had per-message
  isolation, a `failed` counter and per-user outcomes since the sync
  hardening, and there is no scenario in which falling back to one shared
  env-var mailbox is the desired behaviour for a twelve-person team.

- **[F-3.6a, out of scope, found by the smoke — RESOLVED, see above] A prospect with
  `user_id = NULL` still sends through the legacy env-var mailbox.** The
  first run of `smoke-f36a.ts` seeded a null-user prospect expecting it to be
  skipped. It was not: a legacy row has no user, so `gmail` stays undefined,
  `senderEmail` falls back to `process.env.SENDER_EMAIL`, and
  `sendFollowupReply` falls back to `GOOGLE_REFRESH_TOKEN`. The row went to
  Google and returned "Invalid thread_id value" — nothing was delivered, but
  a real vendor call left a smoke that claimed to make none. In production
  both variables are set, so any null-user prospect that becomes due today
  will be **sent from michael.a.g@, not from its owner**. Same family as the
  item above and it should die with it. F-3.6a fixed only its own smoke (the
  script now deletes the three variables before importing anything).

- **[F-3.6a, out of scope — RESOLVED, see above] `queueStageForProspect` ignores `cycle`.** Its
  lookup filters `(prospect_id, stage)` with `.limit(1)` and no `ORDER BY`,
  while the unique constraint has been `(prospect_id, cycle, stage)` since
  B9a. For an AntiGhosting prospect on cycle 2, the row it finds may be the
  cycle-1 row — and if that row is `sent`, the function returns
  `{queued:false}` and the cycle-2 stage is never queued. Doctrine and
  Context are unaffected (everything is cycle 1). Pre-existing; F-3.6a
  touched the failed-row branch of this function and deliberately did not
  widen into the cycle question.

- **[F-3.6a, observation — RESOLVED, see above] `cron_heartbeats` is created by `drizzle-kit push`,
  not by `runStartupMigrations`.** Every other table the server depends on is
  created by the startup migration; this one predates that file. It exists in
  both real databases, so the new read endpoint works — but a fresh database
  brought up by boot alone would not have it, and the endpoint would 500.
  Deliberately not "fixed": adding a second definition of a table `push`
  already owns is how the index churn documented on `cron_heartbeats` starts.

- **[RESOLVED by L1a, 2026-08-02] A cached 308 outlives the prefix.** The
  legacy redirect is now a **307**: identical method-and-body preservation,
  temporary rather than permanent, so nothing survives in a client cache that
  an env-unset rollback cannot reach. L1 was never published, so no client was
  ever served the 308 — the risk was retired before it could be taken. Neither
  redirect in `app.ts` is permanent now: the bare-prefix one is 302 and the
  legacy one is 307. Original finding retained below.

- **[Original finding, now resolved] A cached 308 outlives the prefix.** The
  legacy redirect in `api-server/src/app.ts` is a 308, which is permanent and
  which browsers and shared caches may keep. Rollback for this migration is
  "unset the two env vars" — a client holding a cached 308 for `/pipeline`
  would keep bouncing to `/followup/pipeline`, which 404s once the prefix is
  withdrawn. 308 was chosen deliberately (it preserves the method, and the
  roadmap calls the old address a permanent move); Bundle 2 chose 302 for the
  bare-prefix redirect for exactly the opposite reason. **If a rollback ever
  happens, expect this and tell users to hard-refresh.** The client-side
  redirect — which is what actually fires for real browsers — is not cached at
  all.

- **[RESOLVED by L1b, 2026-08-02] No test pins the redirect STATUS CODE.**
  `api-server/src/tests/test-legacy-redirect-http.ts` boots the real app over
  real HTTP with the prefix active and asserts 307 plus end-to-end method
  preservation. Proven to bite by mutation: 307→308 fails 2 cases, 307→302 and
  307→301 fail 3 each — including the method case, because a client downgrades
  the POST to a GET. Original finding retained below.

- **[Original finding, now resolved] No test pins the redirect STATUS CODE.**
  The unit tests cover `legacyRedirectTarget()`, which returns a path; the
  status lives in `app.ts` and only the live smoke observes it, so flipping 307
  back to 308 — or to 302, which would silently downgrade a POST to a GET —
  would pass every gate. Pinning it needs a booted app, which
  `test-base-path.ts` deliberately avoids ("no DB, no network"). Left alone
  because L1a's scope was one digit; worth an api-server-level HTTP test if one
  is ever added.

- **[Repair L1, verify out-of-band] The two Google OAuth redirect URIs must be
  allowlisted.** Production is live-emitting
  `https://tools.mobupps.net/followup/api/auth/callback` and
  `…/followup/api/gmail/callback`. The
  Google Cloud console cannot be read from the workspace. Keep the legacy
  `https://followupper.mobupps.net/api/{auth,gmail}/callback` entries
  allowlisted until the legacy host is retired.

- **[Pre-existing, out of scope] Doubled-slash paths 404.** `//api/sync` — what
  a trailing slash on the add-on's `BACKEND_URL` produces — returns 404, and so
  does `//followup/pipeline`. Express does not match a doubled slash to a
  mount. Verified identical on `main`, in dark mode and in lit mode, so L1 did
  not introduce it; `legacyRedirectTarget()` only ensures such a path is not
  turned into a *misleading* redirect. If an add-on ever reports 404s, check
  `BACKEND_URL` for a trailing slash first.

- **[Pre-existing, out of scope] A stale pre-cutover index.html cannot
  self-heal.** If a browser holds a cached copy of the old base-`/`
  `index.html`, it references the pre-cutover asset hash, which now 404s. The
  L1 client redirect lives *inside* that bundle, so it never runs. Only a hard
  refresh recovers. Same class as the 2026-07-29 caching note in `app.ts`; the
  dashboard static artifact's cache headers are platform-controlled.

- **[Repair L1, by design] The api-server's own API test console is
  unreachable while the prefix is active.** `artifacts/api-server/public/
  index.html` was served at `/`; the legacy 308 now sends `/` into the app. In
  production it was already shadowed by the dashboard's static artifact, so
  nothing user-visible changed. It returns in dark mode.

- **[Observation, no action] Login moves a user from the legacy host to the
  gateway host.** The OAuth `redirect_uri` is absolute on
  `tools.mobupps.net`, so a session started at `followupper.mobupps.net/
  followup/` finishes at `tools.mobupps.net/followup/`. Auth is `localStorage`
  and therefore per-origin: a user already logged in on the legacy host stays
  logged in there, and logs in fresh on the gateway host once. This is the
  intended end state, not a defect.

- **[RESOLVED by cutover C1, 2026-07-31] The dashboard artifact pinned its own
  build base to `/`.** The `BASE_PATH = "/"` line is gone from
  `artifacts/dashboard/.replit-artifact/artifact.toml`; BASE_PATH now flows
  from the deployment environment, with the code default `"/"` when unset and
  hostile values rejected to `"/"`. **Remaining cutover step:** set `BASE_PATH`
  (and `PUBLIC_URL`) in the *deployment environment* so the dashboard build and
  the api-server agree. Original finding retained below.

- **[Original finding, now resolved] The dashboard artifact pins its own build
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
"Value today" re-measured live on 2026-08-02 (Repair L1), post-cutover.

| # | Where | File:line | What registers | Value today |
|---|---|---|---|---|
| 1 | Google Cloud OAuth (login flow) | `artifacts/api-server/src/routes/auth.ts:23-29` | Redirect URI `<origin>/api/auth/callback` sent to Google; must be allowlisted in the Cloud console | **`https://tools.mobupps.net/followup/api/auth/callback`** — read off the live `/api/auth/google`. Was `https://followupper.mobupps.net/api/auth/callback` pre-cutover |
| 2 | Google Cloud OAuth (Gmail flow) | `artifacts/api-server/src/routes/gmail-auth.ts:33-39` | Redirect URI `<origin>/api/gmail/callback` sent to Google; must be allowlisted in the Cloud console | **`https://tools.mobupps.net/followup/api/gmail/callback`** — same `PUBLIC_URL` origin. Was `https://followupper.mobupps.net/api/gmail/callback` pre-cutover |
| 3 | Apps Script add-on → backend | `addon/Config.gs:11` | Add-on calls the backend at the `BACKEND_URL` Script Property (fallback `http://localhost:3000`). Set in the Apps Script project, not in this repo. The address is **not** hardcoded anywhere in `addon/`. | Script Property, not in code. **Both plausible values work** post-cutover, verified with live requests: `https://followupper.mobupps.net` (→ `/api/…`, the first-class mount) and `https://tools.mobupps.net/followup` (→ `/followup/api/…`) |
| 4 | Deployment env (canonical address) | `.replit:33` (`[userenv.shared] APP_URL`) | Origin fallback; `PUBLIC_URL` now takes precedence over it | `.replit` still carries `https://followupper.mobupps.net`; the deployment env supplies `PUBLIC_URL=https://tools.mobupps.net/followup`, which wins |

Notes:
- 1 and 2 are the only outbound registrations built from code. Both derive
  their origin from `APP_URL`; changing the address requires updating the
  Google Cloud console allowlist by hand.
- `.replit:27-32` already carries a comment recording this coupling from the
  2026-07-16 domain move.
- No webhook registrations, no Gmail push/watch subscriptions, and no
  Pub/Sub topics exist in this codebase.

## Ledger

### 2026-08-10 — F-3.6b: delete-not-harden cleanup — DONE

Branch `claude/f-36b-delete-not-harden`. **Predicted 17 files; touched 19**
(6 new, 13 edited). The two beyond the prediction are both audit findings,
below: `routes/admin-activity.ts` (an `owner_missing` row was not counted as
held) and the deletion of `isProspectOwnerAuthDead()`, which the new
three-field lookup left with no callers.

**Gates.** typecheck ✅ · **1004 assertions across 127 files, 0 failures** ✅
(934 before; +70 in three new suites) · build ✅ (api-server esbuild +
dashboard vite).

**What shipped, against the six scoped items**

| Item | As built |
|---|---|
| 1. Ownerless refuses | `lib/ownerIdentity.ts` — `resolveSendIdentity()`, pure, **no `process.env` in the file at all**. A row sends as the account owning its prospect or not at all. No owner → `failed` + `failure_reason = 'owner_missing'` + an operator sentence, before any claim, any generation, any Gmail call. `getGmail()` — the `GOOGLE_REFRESH_TOKEN` client — is **deleted**, and the Gmail client is a REQUIRED argument on all seven `gmailClient.ts` functions, so `tsc` is what guarantees each call carries its own account. `queueStageForProspect` and the approve-and-send route refuse it too. |
| 2. Legacy sync deleted | The zero-users branch and `syncForLegacyUser()` — 290 lines — are gone. Zero connected accounts throws `NoConnectedAccountsError` (503), so `/api/sync`, `/api/context/sync` and `/api/anti-ghosting/sync` surface the real condition (all three already honour `err.statusCode`) and the cron records `outcome: "error"` with `details.noConnectedAccounts`. |
| 3. Cycle respected | `lib/cycleScope.ts` — `rowsInCycle` / `findStageRow` / `campaignPosition`, pure, with a `cycleScoped: false` switch that reproduces the defect against the same implementation (the `excludeHeldUsers` pattern). `queueStageForProspect` filters `(prospect_id, cycle, stage)` and INSERTs the cycle; `autoQueueAllCampaigns` and `queueNextFollowupStageForProspect` count stages within the prospect's current cycle. `loadProspectQueueContext()` fetches cycle + owner state in one LEFT JOIN; the hot loop still costs no extra query (the sweep supplies both). |
| 4. cron_heartbeats | Two idempotent statements in `startupMigrations.ts`, written from a read-only `information_schema` / `pg_indexes` dump of BOTH databases — including `fired_at DESC`, which the drizzle declaration does not carry. `push` is no longer required for it. |
| 5. idx_prospects_app | **Deleted.** See the finding below. |
| 6. Dev alignment | Run. See below. |

**Scope 5, the finding the order asked for.** `prospects.app` is filtered on
at **29 sites**, grouped by at 1, and sorted by at **0**. So the column is
used, heavily. The declared single-column index is nonetheless redundant:
`idx_prospects_app_replied_paused` leads with `app`, and a B-tree prefix scan
serves every `app = ?` predicate. Verified read-only against **production**,
`EXPLAIN` (no execution):

- `where app='anti_ghosting'` → `Index Scan using idx_prospects_app_replied_paused`
- `where app='context'` → same
- `group by app` → `Index Only Scan using idx_prospects_app_replied_paused`

A second copy of the same prefix would never be preferred. The declaration was
therefore stale, not pending — it has existed in the schema and in neither
database since Phase 7a — so it is deleted rather than created. **No database
changes either way**, which keeps dev and production identical in the publish
diff's eyes without adding an index nothing would use.

**Scope 6, dev-database alignment.** `runStartupMigrations()` run against
`heliumdb` through a guarded one-off (`DATABASE_URL` must contain `helium` and
must not equal `PROD_DATABASE_URL`; both guards were exercised against a
non-helium URL and against `PROD_DATABASE_URL` itself and both refused). No
server boot, no cron, no sync, no sends. Result: **public tables 10 → 10, no
DDL applied** — every F-3.6b statement is `IF NOT EXISTS` over objects dev
already had. `idx_prospects_app` absent, `idx_cron_heartbeats_tick_fired_at`
unchanged at `(tick_name, fired_at DESC)`.

Full read-only dev↔production comparison afterwards — every column, every
index, every constraint:

| Difference | Verdict |
|---|---|
| `uq_followups_prospect_cycle_stage`: `(prospect_id, cycle, stage)` on dev vs `(prospect_id, stage, cycle)` on production | The known, deliberate column-order drift. Skipped by name in `startupMigrations.ts`. **Not touched.** |
| `followup_usage.cost_usd` default stored as `0` on dev, `'0'::numeric` on production | **New observation, pre-existing, not caused by this order.** Semantically identical (both PG 16); dev's copy came from the startup migration's `DEFAULT 0`, production's from the drizzle declaration's `.default("0")`. It was equally true on 2026-08-09, when the diff was recorded as empty, so the publish diff evidently does not see it. Recorded in Open items; changing it would be a schema change beyond this order. |

Nothing else differs.

**Expected publish plan, before Michael touches Publish: NO SCHEMA CHANGES.**
Scope 5 chose "delete", so there is no new index. The only DDL this order adds
is `cron_heartbeats`, which both databases already have.

**Ritual: audit rounds.** Three framings; the first two found something, the
third was clean.

1. **Technical — dead code.** Replacing `isProspectOwnerAuthDead()` with the
   three-field `loadProspectQueueContext()` left the former with no callers.
   In a delete-not-harden order, leaving a dead private function behind is the
   exact debt being removed. Deleted.
2. **End-user / operator.** `admin-activity.ts` computes `failures.held` from
   an explicit list — `retry_count >= MAX or failure_reason in ('stranded',
   'auth_dead')`. `by_reason` populates itself from the `GROUP BY`, so
   `owner_missing` would have appeared there, but the row would have been
   counted as **not held** while the policy refuses it on every single pass.
   A held row counted as unheld is precisely the invisibility F-3.6a built
   that surface to end. `owner_missing` added to the list, with a source-level
   test so it cannot silently fall out again.
   Also checked, and good as-is: the dashboard's sync button already renders
   `data.error` on a non-OK response, so a zero-account tenant now reads *"No
   Gmail account is connected — nothing can be synced…"* where it used to read
   *"Synced 0 emails, 0 replies detected."*
3. **Security.** `owner_missing` cannot be spoofed over HTTP: no route writes
   `followups.failure_reason` from request input (the `failureReason` fields in
   `anti-ghosting.ts` / `antiGhostingValidators.ts` are an unrelated in-memory
   validation string). The new failure text is a constant with no interpolation
   and renders as data like every other `error_message`. `NoConnectedAccountsError`
   carries no token, address or account id. Deleting the fallback strictly
   reduces credential reach: `GOOGLE_REFRESH_TOKEN` is now read by **nothing**
   on the send or sync path. Clean.

   One thing considered and deliberately left: the ownerless refusal fires
   before the suppression gate, so an ownerless prospect on a suppressed
   address now records `owner_missing` rather than `cancelled`/bounced. Both
   are terminal, and `owner_missing` is the more fundamental fact about the
   row.

**Ritual: mutation proof.** Every deleted branch and defect reintroduced
briefly, each reverted immediately. Unit suites first:

| Mutation | Result |
|---|---|
| env fallback restored inside `resolveSendIdentity` | **9 fail** (test-owner-missing, test-fallback-deleted) |
| `getGmail()` + one optional `gmail?` restored in `gmailClient.ts` | **3 fail** |
| `cycleScoped` defaulted to off in `cycleScope.ts` | **8 fail** (test-cycle-scope) |
| `cron_heartbeats` statements removed from the migration | **4 fail** |
| zero-users `{synced: 0, perUser: []}` return restored | **2 fail** |
| `idx_prospects_app` declaration restored | **1 fail** |

Then the same defects at the wiring level, against a live database:

| Mutation | Smoke result |
|---|---|
| env fallback restored — **LIT mode** | **6 fail**, and the row's `failure_reason` became `send_error` with *"Connection error."*: **the ownerless prospect made 2 outbound calls to Google.** With a real network that is a delivery from the wrong mailbox. The transport lockout is what turned it into a failed assertion instead of a sent email. |
| `cycle` dropped from the scheduler's lookup + INSERT, sweep unscoped | **6 fail** — `queueStageForProspect` returns `{queued:false}` for cycle-2 stage 1, no row is created, and the sweep queues nothing |
| `cron_heartbeats` dropped from the migration | **5 fail** — the table never appears |
| zero-users ok/synced:0 restored | **4 fail** — no throw, no 503, a result object instead |

**Ritual: smoke, dark and lit.** `src/scripts/smoke-f36b.ts`, two isolated
ephemeral databases (`f36b_smoke_dark`, `f36b_smoke_lit`, both dropped
afterwards), each built from a `pg_dump --schema-only` of dev with
`cron_heartbeats` deliberately **dropped**, so the migration is exercised on a
database that does not have it.

- **DARK** — the three fallback variables absent: **38 checks, all pass.**
- **LIT** — `GOOGLE_REFRESH_TOKEN` / `SENDER_EMAIL` / `SENDER_NAME` all SET,
  which is the production configuration and the only one in which the deleted
  landmine could ever fire: **41 checks, all pass** (3 LIT-only).
- **Vendor call attempts in both modes: 0.**

Vendors are made impossible rather than unlikely. F-3.6a's smoke answered the
same problem by unsetting three variables, which depends on the operator
remembering and could not be used here at all — LIT *needs* them set. So this
smoke replaces `http.request` / `https.request` / `.get` and `globalThis.fetch`
with throwers before a single application module is loaded (every application
import goes through `await import()` below the guard, so the ordering is
guaranteed by the language rather than by ESM hoisting happening to be
harmless). Postgres speaks `net`/`tls` and is unaffected. The guard is proven
armed by two probes at the top of every run, and the counter is reset after
them so any later increment is a genuine application attempt.

`smoke-f36a.ts` re-run against the new code: **39 checks, all pass.** Four of
its assertions were updated, each annotated, because F-3.6b deliberately
changed what they measure: its null-user fixture row now FAILS with
`owner_missing` where it used to be silently skipped, so one pass reports
`failed: 1` and the later passes see one fewer queued row. Its
hand-rolled `CREATE TABLE cron_heartbeats` harness step is deleted — the
migration does it now.

**PREMISE CORRECTION — the smoke's fourth bullet, and the proof that replaced
it (2026-08-10, follow-on session).** The order's ritual asked the smoke to
show *"a from-scratch ephemeral database boots to the full schema including
`cron_heartbeats` via startupMigrations alone."* **That claim is false and was
never true**, in this order or before it: `startupMigrations.ts` has never
created the four BASE tables — `users`, `prospects`, `followups`,
`oauth_nonces` — it only `ALTER`s them, so on a genuinely bare database its
first statement throws, the single wrapping `try/catch` swallows the rest, and
nothing runs. From-scratch-full-schema was therefore not provable and was not
asserted. The gap is the first Open item at the top of this file.

The narrower claim that IS true was proved instead, and it is the one that
governs a real boot:

> From a **base-tables-only** database, `runStartupMigrations()` alone brings
> the schema to the current full state — every table, column and index dev
> has, including `cron_heartbeats` and its `(tick_name, fired_at DESC)` index
> — and a second run changes nothing.

`src/scripts/prove-base-to-full.sh`, self-contained, against its own ephemeral
database built from a `pg_dump --schema-only` of dev with the **six** tables
the migration owns dropped, leaving exactly the four `push` owns. Dev is read
only; the ephemeral database is dropped on exit; production is never touched.
It refuses a non-`helium` source and refuses `PROD_DATABASE_URL` at either end.
The migration is run through `src/scripts/run-migrations-guarded.ts`, which
calls that one function and nothing else — no server boot, no cron, no sync,
no sends.

**22 checks, all pass.** `4 tables → 10`, matching dev exactly: **133 columns**
(name, type, nullability) and **45 indexes** (definition for definition,
`uq_followups_prospect_cycle_stage` skipped by name as always), then byte-identical
inventories after a second run. This is strictly stronger than the shipped
smoke's scope-4 section, which removed only `cron_heartbeats` from an otherwise
complete schema; this removes all six.

**Mutation:** the `cron_heartbeats` statements deleted from `STATEMENTS` →
**6 of the 22 fail** (`4 → 9` tables, the table and its index absent, and the
column and index inventories diverge from dev). Reverted byte-exact; `git
status` clean.

**Gates re-run on the final tree, independently of the stood-down session:**
typecheck ✅ · **1004 tests / 127 suites / 0 failures** ✅ · build ✅
(api-server esbuild + dashboard vite). Smoke re-run on fresh ephemeral
databases: **DARK 38 checks all pass, LIT 41 checks all pass, vendor call
attempts 0 in both.** All three ephemeral databases dropped afterwards.

**Behaviour on the live data, predicted.** Production holds **9,191 prospects
and zero with a null `user_id`** (read-only count, 2026-08-10), so item 1 fires
on nothing today: it closes the hole before it opens rather than repairing
damage. Every prospect is `cycle = 1` — including all 9 AntiGhosting rows — and
nothing in the code increments `prospects.cycle` yet (the renewal UI is B9d),
so item 3 likewise changes no current row and makes the first renewal work
instead of stranding. Items 2 and 4 are dormant-until-needed by construction.
**This order writes no data at deploy time.**

**Not touched, as required:** `uq_followups_prospect_cycle_stage`; send
windows, caps, models, providers; the Chief seam; the production database.
Also deliberately left, and recorded as Open items rather than widened into:
the three read-only `getLegacyGmail()` inspector helpers, and
`scripts/createLabels.ts`.

**Not deployed.** No publish, no secret change, no production write.

**Rollback:** `git revert` the merge, or `git reset --hard
pre-f-36b-main-tip`. `cron_heartbeats` stays and is ignored; the previous build
created it via `push` anyway.

### 2026-08-10 — F-3.6b: delete-not-harden cleanup — BLAST RADIUS (pre-edit)

Branch `claude/f-36b-delete-not-harden`, from `main` at `ac54213`. Closes the
four Open items F-D4 and F-3.6a recorded as debt to **delete**, not harden.

**Lineage check (Git safety rule 1), directional form.** `main` is 2 ahead of
`origin/main` — both are empty Replit "Published your App" markers created
locally after the F-3.6a merge (`4da6dd2`) was pushed. `replit-agent` diffs
to **zero lines** against `main`. `gitsafe-backup/main`,
`snapshot-2026-07-30` and `backup-old-shallow-history` hold, directionally,
only `backup.sql`, `sync-dev-db.sql` and one stray shell-name artifact — the
exact set PA-1 recorded on 08-05 as deliberate replacement. Every
`bundle-*` / `cutover-*` / `followupper-f36a-*` ref is a strict ancestor of
`main`. **No ref holds newer content `main` lacks.**

**Rollback point:** tag `pre-f-36b-main-tip` at `ac54213`, pushed before the
merge.

**Premise correction, raised before any edit.** The smoke bullet asks for "a
from-scratch ephemeral database boots to the full schema including
`cron_heartbeats` via startupMigrations alone". The first half of that is not
achievable and is not made achievable by this order: `startupMigrations.ts`
has never created the four base tables (`users`, `prospects`, `followups`,
`oauth_nonces`) — it only `ALTER`s them — so on a genuinely bare database its
first statement throws, the single wrapping try/catch swallows the rest, and
nothing else runs. `drizzle-kit push` owns those tables today. Scope item 4
itself is achievable exactly as written and is delivered in full: after this
order `cron_heartbeats` is created by the startup migration, in the live
production shape, and `push` is not required for it. The smoke proves that
claim against a real database that has the base tables and **no**
`cron_heartbeats`. The residue — base tables still `push`-owned — is recorded
as a new Open item; it is a bigger order than this one and adding a second
definition of a table `push` already owns is the exact churn trap
`cron-heartbeats.ts` records being bitten by.

**Files to be touched — 17** (6 new, 11 edited)

| File | Change |
|---|---|
| `api-server/src/lib/ownerIdentity.ts` | NEW — pure send-identity resolver: owner or refusal, no env, no db |
| `api-server/src/lib/cycleScope.ts` | NEW — pure cycle-scoped stage rules, no db (mirrors `dueEligibility.ts`) |
| `api-server/src/tests/test-owner-missing.ts` | NEW — the ownerless refusal + retry policy for it |
| `api-server/src/tests/test-cycle-scope.ts` | NEW — the cycle regression, old rules vs new against one implementation |
| `api-server/src/tests/test-fallback-deleted.ts` | NEW — structural: the env-fallback identity cannot come back unnoticed |
| `api-server/src/scripts/smoke-f36b.ts` | NEW — live smoke, dark and lit, vendors blocked at the socket |
| `lib/db/src/schema/followups.ts` | `owner_missing` added to `FAILURE_REASONS` (TS union over a plain TEXT column — no DDL) |
| `lib/db/src/schema/prospects.ts` | `idx_prospects_app` declaration deleted (scope 5) |
| `api-server/src/lib/retryPolicy.ts` | `owner_missing` becomes a hold, decided on CURRENT ownership |
| `api-server/src/lib/startupMigrations.ts` | +2 statements: `cron_heartbeats` table + its index |
| `api-server/src/services/gmailClient.ts` | `getGmail()` **deleted**; the Gmail client is a required argument everywhere |
| `api-server/src/services/gmailSync.ts` | zero-users branch and `syncForLegacyUser()` (~290 lines) **deleted**; `NoConnectedAccountsError` added |
| `api-server/src/services/scheduler.ts` | ownerless rows refuse with `owner_missing`; queueing becomes cycle-aware |
| `api-server/src/routes/doctrine.ts` | approve-and-send refuses without a per-user Gmail client |
| `api-server/src/cron.ts` | a zero-account sync tick records `error`, not `ok` |
| `api-server/src/scripts/smoke-f36a.ts` | the three assertions F-3.6b deliberately changes |
| `TODO.md` | Open items closed; this ledger |

**Schema deltas — 2 statements, both create-only, plus one deletion that
touches no database**

| Statement | Rollback |
|---|---|
| `CREATE TABLE IF NOT EXISTS cron_heartbeats (…)` — byte-for-byte the live production shape, verified read-only against both databases on 2026-08-10 | none needed: the table already exists in dev and production, so this is a no-op there and only fires on a fresh database |
| `CREATE INDEX IF NOT EXISTS idx_cron_heartbeats_tick_fired_at ON cron_heartbeats(tick_name, fired_at DESC)` | `DROP INDEX`; same no-op property |
| `idx_prospects_app`: declaration deleted from the drizzle schema | re-add the line. **No database changes**: the index exists in neither dev nor production and nothing has ever created it |

`failure_reason` is a plain TEXT column with no CHECK constraint, so the new
`owner_missing` value needs no DDL — the same widening `pause_reason` has
taken twice before. Nothing is dropped, renamed, retyped or made NOT NULL, so
a code rollback needs no schema rollback.

**Behaviors affected**

1. A follow-up whose prospect has no owning user stops sending from
   `SENDER_EMAIL`/`GOOGLE_REFRESH_TOKEN` and instead **fails visibly** with
   `failure_reason = 'owner_missing'`. Today, in production, such a row sends
   from `michael.a.g@` under someone else's campaign.
2. A sync pass with zero connected accounts stops returning `ok`/`synced: 0`
   and reports its true condition — 503 on the routes, `outcome: "error"` and
   a named detail on the cron heartbeat.
3. Queueing a stage is scoped to the prospect's current cycle, so an
   AntiGhosting cycle-2 stage can be queued instead of colliding with a
   `sent` cycle-1 row.
4. A fresh database gets `cron_heartbeats` from boot instead of from
   `drizzle-kit push`.

**Worst realistic failure — five ways this could go wrong, each pre-mitigated**

1. **Deleting the env fallback silently stops a real send.** If any live
   prospect legitimately depended on the fallback identity, its follow-ups
   would stop. Mitigation: that is the *intent* — sending a client's
   follow-up from the wrong mailbox is the bug — and the refusal is loud
   (`failed` + `owner_missing` + an operator sentence on the row) rather than
   a silent skip, which is what the ownerless row gets today when the
   variables are unset. The refusal is a pure function with its own suite.
2. **Making the Gmail client a required argument breaks a caller.** A caller
   relying on the fallback would now fail to compile. Mitigation: that is
   exactly what makes this safe — every one of the seven call sites is
   checked by `tsc`, and all of them already passed a per-user client.
3. **Deleting `syncForLegacyUser` removes a path someone still uses.** It is
   reachable only when `is_connected` is true for **zero** users; twelve are
   connected today, and the multi-user path has had per-message isolation,
   a `failed` count and per-user outcomes since the sync hardening.
   Mitigation: the new typed error means the condition is reported instead of
   silently substituted, and nothing else calls that function.
4. **Cycle scoping changes doctrine/context behaviour.** Every doctrine and
   context row is cycle 1 on both sides of the join, so the scoped query
   returns exactly what the unscoped one did. Mitigation: the rules are one
   pure implementation with a `cycleScoped: false` switch that reproduces the
   old behaviour against the same fixture — the `excludeHeldUsers` pattern
   `dueEligibility.ts` established — so the regression is demonstrated, not
   asserted.
5. **The new migration churns the publish diff.** A second definition of a
   `push`-owned table is how `cron_heartbeats` index churn started in the
   first place. Mitigation: the statement was written from a read-only
   `pg_indexes` / `information_schema` dump of **production**, including the
   `fired_at DESC` ordering that the drizzle declaration does not carry, so a
   fresh database lands on the identical shape; `IF NOT EXISTS` makes it a
   no-op on both real databases; and the dev-alignment run at the end proves
   the publish plan is empty.

**Not touched, deliberately:** `uq_followups_prospect_cycle_stage`; send
windows, caps, models, providers; the Chief seam; the three read-only
`getLegacyGmail()` inspector helpers in `email-inspector.ts`, `context.ts`
and `anti-ghosting.ts` (they read a mailbox, they never send — recorded as an
Open item rather than widened into); `scripts/createLabels.ts`; the
production database.

**Rollback:** `git revert` the merge, or `git reset --hard
pre-f-36b-main-tip`. The one new table stays and is ignored. No data is
migrated, no row is mutated by this order at deploy time.

### 2026-08-09 — F-3.6a: truth and flow — BLAST RADIUS (pre-edit)

Branch `followupper-f36a-truth-and-flow`, from `main` at `918d996`. Built from
the F-D4 verdict of the same day. Nothing F-D4 rated healthy is touched:
windows, caps, bounce handling, durability and the send/generate pipeline
itself are untouched.

**Lineage check (Git safety rule 1), directional form.** `main` is level with
`origin/main` (0/0). `git diff <branch> main` for every ref: `replit-agent`
holds 7 lines main lacks and they are the *superseded* TODO Open-item wording
that L1b replaced; `snapshot-2026-07-30` / `backup-old-shallow-history` /
`gitsafe-backup/main` hold `backup.sql`, `sync-dev-db.sql` and the
pre-Bundle-1 hardcoded URL literals — the same set PA-1 recorded on 08-05 as
deliberate replacement, not loss. The `bundle-*` / `cutover-*` branches are
all strict ancestors of today's work. **No ref holds newer content main
lacks.**

**Files to be touched — 19** (9 new, 10 edited)

| File | Change |
|---|---|
| `lib/db/src/schema/users.ts` | +2 columns: `authDeadAt`, `authDeadReason` |
| `lib/db/src/schema/followups.ts` | +3 columns: `retryCount`, `failureReason`, `errorHistory` |
| `api-server/src/lib/startupMigrations.ts` | +6 idempotent statements for the above |
| `api-server/src/lib/connectionHealth.ts` | NEW — pure connection-state machine (no db import) |
| `api-server/src/lib/retryPolicy.ts` | NEW — pure retry decision + error-history append (no db import) |
| `api-server/src/lib/dueEligibility.ts` | NEW — pure due-batch eligibility predicate (no db import) |
| `api-server/src/lib/strandedGenerating.ts` | NEW — pure stranded classifier (no db import) |
| `api-server/src/lib/heartbeatView.ts` | NEW — pure query parse + details redaction (no db import) |
| `api-server/src/lib/authProbe.ts` | NEW — one cheap Gmail profile read, injectable |
| `api-server/src/services/gmailSync.ts` | mark / clear auth-dead from the per-user outcome |
| `api-server/src/services/scheduler.ts` | due-query exclusion; retry policy replaces the amnesia revive; stranded rows get teeth |
| `api-server/src/routes/gmail-auth.ts` | surface auth-dead on `/gmail/accounts`; reconnect clears it |
| `api-server/src/routes/admin-cron-heartbeats.ts` | NEW — admin-authed heartbeat read |
| `api-server/src/routes/admin-activity.ts` | +failed-row counts on the admin surface |
| `api-server/src/routes/index.ts` | mount the new router |
| `api-server/src/lib/deployRecovery.ts` | NEW — the two named deploy-time passes |
| `api-server/src/index.ts` | call the deploy-time recovery after listen |
| `dashboard/src/pages/accounts.tsx` | plain-words dead-grant badge + reconnect line |
| `api-server/src/tests/*` | 5 NEW hermetic suites |

**Schema deltas — 6 statements, every one additive, nullable-or-defaulted, and
invisible to the previous code**

| Statement | Rollback |
|---|---|
| `ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_dead_at TIMESTAMPTZ` | `DROP COLUMN`, or leave — pre-F-3.6a code never selects it |
| `ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_dead_reason TEXT` | same |
| `ALTER TABLE followups ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0` | same |
| `ALTER TABLE followups ADD COLUMN IF NOT EXISTS failure_reason TEXT` | same |
| `ALTER TABLE followups ADD COLUMN IF NOT EXISTS error_history JSONB` | same |
| `CREATE INDEX IF NOT EXISTS idx_users_auth_dead ON users(auth_dead_at) WHERE auth_dead_at IS NOT NULL` | `DROP INDEX` |

No column is dropped, renamed, retyped or made NOT NULL without a default, so
a code rollback needs no schema rollback: the previous build simply stops
reading five columns it never knew about. This is the same property the
migration rules have required since B7u.

**Behaviors affected**

1. A user whose grant Google rejects gets a distinct `auth_dead` state — not a
   disconnect — and stops generating until it heals.
2. A failed follow-up keeps its status, error and generated content; revival
   becomes a bounded policy (≤2 automatic retries) instead of a 15-minute wipe.
3. The due query stops handing slots to held rows.
4. Rows stranded in `generating` past 6h become failed-with-reason instead of
   freezing their campaign forever.
5. `cron_heartbeats` becomes readable by an admin.

**Worst realistic failure — seven ways this could go wrong, each pre-mitigated**

1. **The due-query join silently drops legacy rows.** `prospects.user_id` is
   nullable. An INNER JOIN to `users` would stop processing every user-less
   row without a single error. Mitigation: LEFT JOIN plus
   `user_id IS NULL OR (not paused AND not auth-dead)`, and the starvation
   fixture carries a null-user row that must survive.
2. **Auth-dead marks a healthy account.** A transient Gmail 5xx or a quota
   error misread as an auth failure would pause a working sender. Mitigation:
   the mark uses `isAuthError()` — the predicate already in production, matching
   only `invalid_grant|invalid_client|unauthorized_client` — and *any*
   successful sync or probe for that user clears the state on the next tick, so
   a false positive self-heals within 15 minutes and costs no send.
3. **Retries exhaust and rows stick forever.** If `retry_count` were bumped on
   a non-failure path, every row would reach the cap and stop. Mitigation: the
   counter increments only on the failed→queued transition, the decision is a
   pure function with its own suite, and a row at the cap is *visible* on the
   admin surface rather than silent — which is the whole point of the order.
4. **Error history grows without bound.** A pathological loop could append
   forever. Mitigation: the history is capped at the most recent 10 entries.
5. **The heartbeat endpoint leaks.** `details.perUser` carries user emails and
   raw provider error strings. Mitigation: an explicit redaction pass over
   token-shaped keys and values, on top of the double gate every `/api/admin`
   route already has (ADDON_API_KEY *then* ADMIN_API_KEY).
6. **The deploy-time probe slows or breaks boot.** Mitigation: it runs
   fire-and-forget *after* `listen()`, sequentially, each user in its own
   try/catch, and can only ever mark — never send, never generate, never
   delete.
7. **Stranded recovery fails healthy in-flight work.** A generation legitimately
   takes minutes. Mitigation: the 6h RH-1 threshold is unchanged, and the write
   is a CAS matching `status='generating'` AND the age predicate, so a row that
   completed between read and write is never touched.

**Not touched, deliberately:** user 8's two July DB-error `failed` rows (the
order leaves them); the legacy zero-users sync branch (recorded as an open item
to delete, not hardened); windows, caps, user 10's personal window; the OAuth
client and anything in Google Cloud.

**Rollback:** `git revert` the merge. The five columns and one index stay and
are ignored. The only data this order writes are (a) `auth_dead_at` marks,
which a reconnect or a healthy sync clears, and (b) the stranded `generating`
rows moved to `failed`, which is strictly more recoverable than the frozen
state they are in now.

### 2026-08-09 — F-3.6a: truth and flow — DONE

Branch `followupper-f36a-truth-and-flow`. **Predicted 19 rows / ~24 files;
touched 27** (14 new, 13 edited). The three beyond the prediction:
`lib/authProbe.ts` and `lib/deployRecovery.ts` were folded into the "9 new"
count as one row each and are listed there; the genuine addition is
`src/scripts/smoke-f36a.ts`, the live smoke — the ritual requires one and the
repo keeps smokes in `src/scripts/`, so it is committed rather than thrown
away.

**Gates.** typecheck ✅ · **934 assertions across 41 files, 0 failures** ✅ ·
build ✅ (api-server esbuild + dashboard vite). The 934 includes 141 new ones
in five suites.

**What shipped, against the five scoped items**

| Item | As built |
|---|---|
| 1. Auth truth | `users.auth_dead_at` / `auth_dead_reason` — a THIRD state, not a disconnect. Marked by the sync's Phase C and by the send path (`IS NULL`-guarded so the first date survives). Cleared by positive proof of health only. Surfaced as `connectionState` + `authDeadMessage` on `/api/gmail/accounts`, and as an AUTH-DEAD badge + "Gmail connection dead since <date> — reconnect" + a Reconnect button on the Accounts page. Auto-queue, the due query and `queueStageForProspect` all refuse a dead account. Reconnect and disconnect both clear it. |
| 2. Failures keep evidence | `retry_count`, `failure_reason`, `error_history`. `decideFailedRowAction` allows **2** automatic retries, then holds the row `failed` and visible. `auth_dead` rows are not retried at all and spend no strike; `stranded` is terminal. Revival preserves errorMessage, both generated fields, and the Gmail ids — only status, scheduledAt, retryCount and errorHistory move. Counted on `/api/admin/activity` as `failures.{total,held,by_reason}`. |
| 3. Scheduler flow | Held users excluded at SELECT time via a **LEFT** join (`user_id IS NULL OR (not paused AND not auth-dead)`). Ordering and the 20-row batch unchanged. |
| 4. Stranded gets teeth | `generating` past 6h → `failed` + reason `stranded`, evidence written, CAS'd on status AND age. Campaign unfreezes; the row is never auto-retried. |
| 5. Heartbeats readable | `GET /api/admin/cron-heartbeats` — latest N plus a per-tick `seconds_since_last` / `ticks_24h` / `errors_24h` rollup. Two keys (ADDON then ADMIN). Every `details` payload redacted. |

**The state machine, as built.** `connectionState()` returns exactly one of
`connected` / `auth_dead` / `disconnected`; **disconnect wins over
auth-dead** (no grant left to be dead). Transitions take a THREE-way signal,
and that split is the load-bearing part: `auth_failure` (isAuthError matched)
marks dead; `healthy` (the ingest phase completed, so Gmail demonstrably
answered) clears; `inconclusive` (any other error — a DB write, the
summarizer) changes nothing in **either** direction. Treating "not an auth
error" as health would clear a genuinely dead grant on the first database
hiccup. Six cases, only two of which write: an already-dead account is not
rewritten (the first date is the actionable one and rewriting churns the row
every 15 minutes), and a healthy account writes nothing at all.

**Retry policy, as built**

| Row state | Automatic sweep | Human (buttons, salvage, resume) |
|---|---|---|
| `failed`, reason `send_error`, retries 0–1 | retry, strike spent | retry |
| `failed`, reason `send_error`, retries ≥ 2 | **hold** `retries_exhausted` | retry (override) |
| `failed`, reason `auth_dead`, owner still dead | **hold** `auth_dead` | **hold** — not overridable |
| `failed`, reason `auth_dead`, owner healed | retry, **no strike spent** | retry |
| `failed`, reason `stranded` | **hold** `stranded_needs_human` | retry (override, after checking the thread) |
| `cancelled` | revived and cleared, exactly as before | same |

`auth_dead` is the one hold a human cannot push through, because pressing the
button harder does not make a refused token work — and a reconnect clears the
state, and therefore the guard, instantly.

**Deploy-time effect, predicted**

- The probe pass marks the six accounts F-D4 named — denise(3), murat(5),
  kirk(6), marissa(8), nino(13), kevin.cowen(15) — AUTH-DEAD on first boot,
  each with the reason Google gave. They stop generating immediately. On the
  evidence of the F-D4 week that stops ~196 unsendable generations and
  ~$4.45 of ~$5.95 weekly LLM spend, and the six stop reporting CONNECTED.
- The stranded pass moves the rows frozen since 2026-07-21 (`28338`) and
  07-28 (`34334`) — three by the unfiltered count, the third on an archived
  prospect — from invisible-`generating` to visible-`failed`/`stranded`,
  unfreezing those campaigns without resending anything.
- Marissa's 15 rows stop occupying 15 of every 20 due slots. Nothing of hers
  is cancelled; it all comes back when she is resumed.
- User 8's two July DB-error rows are untouched, as the order required:
  `retry_count` defaults to 0, and no auto-queue pass reaches an
  admin-paused account.

**Ritual: audit rounds.** Five rounds; the first four found something, the
fifth was clean.

1. **Orphaned doc block** — `markUserAuthDead`'s comment had detached and was
   sitting above a different function. Reattached.
2. **A duplicate-email hole the order did not name.** The catch classified
   every non-auth throw as `send_error`, which is retryable — including a
   throw from the status write that runs AFTER `sendFollowupReply` has
   already delivered. Retrying that row puts a second copy in a client's
   inbox. Fixed by recording a `gmailArtifactId` the moment anything reaches
   Gmail and classifying such failures `stranded`, which the policy refuses.
   Extracted as `classifyProcessingFailure()` and covered by 6 new cases.
   Strictly better than before either way — that row used to be revived every
   15 minutes, unbounded.
3. **`failures.held` overstated.** `auth_dead` rows are held only while their
   owner is dead. Left as-is (it self-corrects on reconnect) but the comment
   now says so instead of implying they need a human.
4. **Index churn.** The drizzle declaration was a plain index and the
   migration created a PARTIAL one. That mismatch is exactly what the
   `cron_heartbeats` comment records being bitten by — drizzle-kit diffs it
   as undeclared and churns a DROP/CREATE on every Republish. Migration
   changed to plain so the two are identical, and the smoke asserts it.
   Also: `auth_dead_reason` was documented as "free text from the provider"
   when `classifyAuthReason()` in fact maps it onto a closed five-value set
   before storage. The comment was wrong in a security-relevant direction and
   is corrected.
5. Clean. No `console.log`, no `debugger`, no secret values, no stray `any`
   beyond the two the dashboard already uses for this account type.

**Ritual: mutation proof.** `test-due-starvation.ts` — 21 cases, green.
Reintroducing the defect three ways, each reverted immediately:

| Mutation | Result |
|---|---|
| force `excludeHeld = false` (delete the held-user exclusion) | **5 fail** |
| `isUserHeld` returns `userPausedByAdmin` only (drop the auth-dead half) | **2 fail** |
| `isUserHeld` returns true for a null `user_id` (the INNER JOIN) | **3 fail** |

The fixture is the 2026-08-09 queue at scale: 15 admin-paused rows dated
07-30→08-03, 5 cascade-paused, 159 healthy behind them. Under the old rules
it selects 20 and can process 5 — **75% of every pass thrown away, the same
15 rows, for ever**. Under the new ones: 20 selected, 20 processable.

**Ritual: smoke.** `src/scripts/smoke-f36a.ts` against an isolated
`f36a_smoke` database (dropped afterwards), started from a **pre-F-3.6a
schema** so the migration itself was exercised. 33 checks, all passing, in
both modes.

The first run **failed 5 checks and made a real Gmail call**, and that is the
most useful thing the smoke did. A fixture prospect with `user_id = NULL`
does not hit the "Gmail credentials unavailable" guard — a legacy row has no
user, so the send falls through to `GOOGLE_REFRESH_TOKEN` + `SENDER_EMAIL`,
which are set in this workspace. It reached Google and came back "Invalid
thread_id value". Nothing was delivered and no production data was touched
(isolated database, fake thread ids), but a smoke that claimed to make no
vendor call made one. The script now deletes those three variables before it
imports anything, so it is safe by construction rather than by remembering.
The underlying production behaviour is recorded in Open items — it is the
legacy-fallback family, and it should be deleted, not hardened.

**Not touched, as required:** windows, caps, bounce handling, user 10's
personal window, the OAuth client, the legacy sync branch, user 8's two July
rows.

**Rollback:** revert the merge. The five columns and the index stay and are
ignored by the previous build. The only data written are auth-dead marks
(cleared by a reconnect or a healthy sync) and the stranded rows moved to
`failed`, which is strictly more recoverable than the frozen state they are
in now.

**Not deployed.** No publish, no secret change, no production database was
written by this order.

### 2026-08-02 — Repair L1b: pin the redirect status code — BLAST RADIUS (pre-edit)

Branch `cutover-l1b-pin-status`. Closes the gap L1a recorded in Open items:
nothing in the repo pins the status code, so a change to 302 or 308 passes
every gate.

**Lineage check (Git safety rule 1), directional form.** On `main` at
`5088adb`. **`main` moved since L1a and it was not me:** Replit Agent created
an empty "Published your App" marker at 17:18 UTC on top of `cf6c06e`. So L1
and L1a are now DEPLOYED — verified live, the legacy address serves
`index-85ZvAqfs.js`, the build containing the pre-mount redirect, and the
deployed tree carries `res.redirect(307, …)`. Local `main` is 1 commit ahead
of `origin/main` (that marker, unpushed). `replit-agent` holds no content
`main` lacks. Branched from `5088adb`.

**Note for the L1a ledger, still true:** the published build has 307 and never
had 308, so "the risk was retired before it could be taken" holds — the deploy
landed after L1a merged, not between L1 and L1a.

**Files to be touched — 2** (1 new, 1 doc)

| File | Change |
|---|---|
| `api-server/src/tests/test-legacy-redirect-http.ts` | NEW — boots the real app over real HTTP with the prefix active, asserts 307 and end-to-end method preservation |
| `TODO.md` | this entry, the ledger entry, and retiring the Open item |

**No production code is touched by this order.** Zero behavior change by
construction; the entire risk is that the new test destabilises the gate.

**Behaviors affected:** the test suite only.

**Worst realistic failure — four ways a booting test can poison the gate, all
pre-identified**
1. **Env leak into the other 34 test files.** This test must set `BASE_PATH`
   *before* `app.ts` is imported, because `appUrls` reads env at module load.
   If the runner shared one process, that would flip `test-base-path.ts`'s dark
   cases into lit mode and the darkness guarantee would silently stop being
   tested. Verified empirically rather than assumed: a two-file canary proved
   `node --test` gives each FILE its own process (file B could not see file
   A's env var). Also forces a dynamic `await import("../app")` — a static
   import is hoisted and would run before the assignment.
2. **Touching the real database.** `@workspace/db` THROWS at import unless
   `DATABASE_URL` is set, and `app.ts` imports the whole router tree. The test
   sets a deliberately unroutable dummy `DATABASE_URL`, so it is hermetic: the
   pool is lazy, nothing queries, and if anything ever did the test would fail
   loudly instead of quietly reading production data.
3. **Hanging the gate.** `logger.ts` attaches a `pino-pretty` transport unless
   `NODE_ENV=production` — a worker thread that can outlive the test. The test
   sets `NODE_ENV=production` (grepped first: that variable is read in exactly
   one place in the whole api-server, the logger) plus `LOG_LEVEL=silent`, and
   closes its server in an `after` hook.
4. **Port collision with the running workflow.** Listens on port 0 and reads
   the assigned ephemeral port, so it can never contend for a fixed one.

**Rollback:** delete the new file. No production code to revert.

### 2026-08-02 — Repair L1b: pin the redirect status code — DONE

Predicted 2 files, touched 2. **Zero production code changed** — `git status`
shows one new test file and `TODO.md`. Not deployed; ready to publish.

**What it pins.** `test-base-path.ts` covers `legacyRedirectTarget()`, which
returns a PATH — it cannot see the status `app.ts` sends with it. Both
regression routes were therefore invisible to the gate: back to 308 (permanent,
client-cached, unreachable by an env-unset rollback — the reason L1a existed),
or to 302 (lets a client rewrite a POST into a GET and drop the body, while
still looking fine in a browser address bar).

**The test is proven to bite, by mutation.** A test that cannot fail is
decoration, so each regression was actually introduced and run:

| Mutation | Result |
|---|---|
| `307 → 308` | **2 of 4 fail** — the status cases. The method case correctly still passes: 308 does preserve the method; it is the permanence that is wrong |
| `307 → 302` | **3 of 4 fail** — status, *and* the second hop arrives as `GET`, catching the silent body-drop |
| `307 → 301` | **3 of 4 fail** — same |
| unmodified | 4 of 4 pass |

`app.ts` was restored from a pre-mutation copy and confirmed byte-identical to
`HEAD` afterwards.

**The four cases**
1. `POST` to a legacy path → 307, `Location: /followup/l1b-probe?q=1` (query
   preserved).
2. The same POST followed to completion → the server records exactly
   `["POST /l1b-probe?q=1", "POST /followup/l1b-probe?q=1"]`. The status code
   is a promise to the client; this checks the promise is kept end to end,
   using a `prependListener("request")` recorder in front of the app rather
   than trusting the code.
3. `GET` legacy path → 307 too, so nobody "fixes" a failure by special-casing
   one method.
4. `POST /api/…` → **not** a redirect. The exclusion that makes any redirect
   here safe; asserted as "not 3xx" rather than a specific code so it does not
   depend on `ADDON_API_KEY` being present.

**Gates**

| Gate | Result |
|---|---|
| typecheck | PASS |
| tests | **793/793 across 35 files** (789 + 4 new) |
| build, no `PORT`/`BASE_PATH`/`PUBLIC_URL` exported | PASS, exit 0 |

**Godlike audit — 2 rounds, closed clean on round 2.**
- *Round 1, 2 findings, both fixed.* (i) The recorder wrapped the app behind a
  `as unknown as http.RequestListener` double cast. Replaced with
  `http.createServer(app)` + `prependListener("request", …)`, which typechecks
  with no cast at all and additionally records BEFORE the app handles the
  request rather than after. Re-verified it still passes and still catches the
  302 mutation. (ii) The header comment claimed `NODE_ENV` is read in exactly
  one place in the api-server. True of our code, **not** of Express, which
  reads it too (`app.get("env")`, dev-mode stack traces). Corrected in place.
- *Round 2 (added), clean.* Gates re-run on the final code.

**The four named traps, all held**
1. *Env leak into the other 34 files* — the test must set `BASE_PATH` before
   `app.ts` is imported. Proven safe by a dedicated two-file canary: file B
   could not see an env var file A set at module scope, so `node --test` gives
   each FILE its own process. **Worth stating precisely: the suite passing is
   NOT independent evidence of this**, because `test-base-path.ts`'s own
   `loadWith()` deletes those keys before every import and would mask a leak.
   The canary is the evidence. Forced the dynamic `await import("../app")` —
   a static import is hoisted and would run before the assignments.
2. *Touching the real database* — `@workspace/db` throws at import unless
   `DATABASE_URL` is set, and `app.ts` pulls in the whole router tree. Set to
   an unroutable dummy (port 1). The pool is lazy and nothing on these paths
   queries; if anything ever did, the test fails loudly rather than quietly
   reading production.
3. *Hanging the gate* — `pino-pretty` is a transport worker outside
   production. `NODE_ENV=production` + `LOG_LEVEL=silent`, server closed in an
   `after` hook. The file exits 0 on its own, checked under `timeout`.
4. *Port collision with the running workflow* — listens on port 0 and reads
   the assigned port.

**Blast radius held.** No production code, no database, cron, doctrine,
add-on, dashboard, `.replit` or dependency changes. No email dispatched — the
test boots `app.ts`, never `index.ts`, so `startCronJobs()` cannot run. No
workflow was running and none was touched; the test binds only ephemeral ports.

**State of the world at branch time.** `main` moved without me: Replit Agent
published the app at 17:18 UTC (`5088adb`, an empty marker on top of L1a). So
L1 and L1a are LIVE. Verified against production: the legacy address now
serves `index-85ZvAqfs.js`, the bundle containing the pre-mount redirect, so
the blank-page defect is fixed in production; `/api/healthz`, `/followup/`,
`/followup/pipeline` and the gateway all return 200, and the add-on paths
still answer 401 to a wrong key. The deployed tree carries `307` and never
carried `308`.

### 2026-08-02 — Repair L1a: legacy redirect 308 → 307 — BLAST RADIUS (pre-edit)

Branch `cutover-l1a-307`. Retires the one accepted risk L1 shipped with.

**Lineage check (Git safety rule 1), before branching.** On `main`
(`e1766f1`), equal to `origin/main`. Note the check L1 used —
"`replit-agent`'s tree equals `main`'s tree" — is now STALE and reports a
false alarm, because `main` advanced with the L1 commit while `replit-agent`
did not. The question the rule actually asks is whether another branch holds
content `main` lacks. Re-checked in the correct direction: `git diff
replit-agent main` is exactly the five L1 files and nothing else, and
`replit-agent`'s tree equals `main`'s PARENT (`bd06214`). So `replit-agent` is
behind in content, not ahead, and still carries only the retained granular
history. `main` is the newest lineage; branched from it.

**Reasoning.** 308 is a PERMANENT redirect, and browsers and shared caches may
keep it indefinitely. Rollback for this whole migration is "unset the two env
vars and redeploy" — but a cached 308 is client-side state that the rollback
cannot reach. A client holding one for `/pipeline` would keep bouncing itself
to `/followup/pipeline`, which 404s the moment the prefix is withdrawn, and no
server-side action would clear it. 307 is the temporary sibling: **identical**
method-and-body preservation semantics, which is the only property the repair
needs, without the permanence. This is the same reasoning Bundle 2 applied
when it chose 302 over 301 for the bare-prefix redirect; L1 diverged from it
and is now brought back in line.

**Files to be touched — 4** (1 behavioral line, the rest comment-only)

| File | Change |
|---|---|
| `api-server/src/app.ts` | `res.redirect(308, …)` → `res.redirect(307, …)`. **The only behavioral change in this order.** Plus the four comment lines naming 308 |
| `api-server/src/lib/appUrls.ts` | one comment line naming 308 |
| `api-server/src/tests/test-base-path.ts` | three comment/assert-message lines naming 308 |
| `TODO.md` | this entry, the ledger entry, and retiring the accepted-risk Open item |

Comments are updated in the same change on purpose: leaving them saying "308"
would make the code contradict its own documentation, which is how the next
person reintroduces the permanence.

**Behaviors affected:** the status code of the legacy → prefixed redirect, and
nothing else. Not the target, not the query handling, not which paths match,
not the `/api` exclusion, not the client-side redirect, not the dark path
(the whole rule stays gated on `PREFIXED`).

**Worst realistic failure:** 307 and 308 are not interchangeable for every
client. 308 was standardised later (RFC 7538) than 307 (RFC 7231), so if
anything, 307 has the broader support — but a client that treats an unknown
3xx as a hard error would be a regression. The mitigating fact is that the
only callers reaching this rule are browsers: `/api` is excluded, so no
machine caller can ever receive it. Verified in the smoke rather than assumed:
the POST probe must still arrive at the prefixed path as a POST.

**Rollback:** change the digit back, or `git revert`. Unsetting the env vars
still disables the whole rule. Nothing is deployed by this work.

### 2026-08-02 — Repair L1a: legacy redirect 308 → 307 — DONE

Predicted 4 files, touched 4. One behavioral character; everything else is
documentation kept true. Not deployed; ready to publish.

```
-    res.redirect(308, `${target}${query}`);
+    res.redirect(307, `${target}${query}`);
```

**Why 307 is the right code, not a compromise.** 307 and 308 are the same
guarantee about the method — both forbid the client from rewriting a POST into
a GET, which is the only property this rule needs. They differ only in
permanence, and permanence is precisely the property that made the rule
unsafe: a 308 is cached client-side, and no server-side rollback can reach a
client's cache. 302 was not an option: it *permits* the method downgrade.

**The risk was retired before it was taken.** L1 was merged but never
published — `git log e1766f1..main` contains no "Published your App" commit —
so the deployment has never emitted a 308 and no client anywhere holds one
cached. L1a lands before the first deploy that would have created one, which
is what makes this a clean retirement rather than a partial one.

**Gates**

| Gate | Result |
|---|---|
| typecheck | PASS |
| tests | 789/789 across 34 files (unchanged — no test asserts a status; see Open items) |
| build, no `PORT`/`BASE_PATH`/`PUBLIC_URL` exported | PASS, exit 0 |

**Godlike audit — 2 rounds, closed clean on round 2.**
- *Round 1, 2 findings.* (i) **Recorded, deliberately not fixed:** nothing in
  the repo pins the status code, so a regression to 308 or 302 would pass
  every gate — but pinning it needs a booted app, which the unit-test file
  deliberately avoids, and this order's scope was one digit. Logged in Open
  items. (ii) **Fixed:** the reflowed comment in the `/api` mount lock left a
  ragged two-line wrap; rejoined.
- *Round 2 (added), clean.* Diff re-read, gates re-run, both smokes re-run on
  the final code.

**SMOKE — LIT (5721), 31/31, plus the method proof this order asked for**

| Check | Result |
|---|---|
| raw `POST /l1a-post-probe?q=1` | **307**, `Location: /followup/l1a-post-probe?q=1` |
| the POST **arrives** as a POST | access log, both hops: `POST /l1a-post-probe` then `POST /followup/l1a-post-probe` — the method survived the redirect |
| raw `GET`, raw `PUT` | 307, correct prefixed target |
| `/`, `/pipeline`, `/accounts`, `/favicon.svg`, `/followupper` | 307 → prefixed, 1 hop, final 200 |
| no 308 anywhere on the LIT surface | confirmed |
| everything else from the L1 suite | unchanged: 9 add-on paths + both OAuth callbacks + `/api/healthz` reach handlers with **0** answering 3xx; loop guard holds; hostile paths stay on-origin; 3/3 assets resolve; missing asset still an honest 404 |

**SMOKE — DARK (5722) vs `main`/L1 (5723): byte-for-byte identical across all
36 probes.** Expected — the rule is gated on `PREFIXED` — and verified rather
than assumed. Also re-compared against the ORIGINAL pre-L1 baseline captured
during L1: **`cmp` reports the 44 recorded lines identical**, so the dark path
is still exactly what it was before either repair. In dark mode `/` is still
200 (API test console), `/pipeline` and `/accounts` still 404, and no legacy
path answers 3xx.

**Blast radius held.** No database, cron, doctrine, add-on, dashboard,
`.replit`, `artifact.toml` or dependency changes; the client-side redirect was
not touched. No email dispatched — `app.ts` booted directly in every smoke, so
`startCronJobs()` never ran. No workflow was running and none was touched;
ports 5721/5722/5723 were used and all were shut down by PID.

**Lineage note worth keeping.** The shorthand L1 used for Git safety rule 1 —
"`replit-agent`'s tree equals `main`'s tree" — went stale the moment `main`
took a commit `replit-agent` lacked, and reported a false alarm at the start of
this order. The durable form of the check is directional: *does another branch
hold content `main` lacks?* Answered with `git diff replit-agent main` (only
the five L1 files) and by confirming `replit-agent`'s tree equals `main`'s
PARENT. Use the directional form from here on.

### 2026-08-02 — Repair L1: legacy address survival, post-cutover — BLAST RADIUS (pre-edit)

Branch `cutover-l1-legacy-addresses`. The prefix is **already live in
production** (`BASE_PATH=/followup/`,
`PUBLIC_URL=https://tools.mobupps.net/followup`). This repair makes the
unprefixed legacy address survive it.

**Lineage check (Git safety rule 1), before branching.** Checked out `main`
(`bd06214`, 2026-08-02). `replit-agent` (`14ebbb0`) is 686 commits ahead by
count, but `git rev-parse` shows both tips resolve to the SAME tree
`c1095fc1`, and `main` is an ancestor of it — it carries the retained granular
history and no content `main` lacks. `main` is 3 commits ahead of
`origin/main`. `main` is the newest lineage; branched from it.

**Files to be touched — 3** (2 modified, 1 modified test)

| File | Change |
|---|---|
| `artifacts/dashboard/src/main.tsx` | pre-mount redirect: unprefixed location → prefixed, before `createRoot` |
| `artifacts/api-server/src/app.ts` | legacy-path 308 to the prefixed path (gated on `PREFIXED`); comment lock on the unprefixed `/api` mount |
| `artifacts/api-server/src/tests/test-base-path.ts` | L1 contract cases: legacy survival lit, darkness unchanged, no redirect loop |

Deliberately NOT touched: `.replit`, either `artifact.toml` (platform routing
is not observable from the workspace — see the state report below), the
add-on sources (`addon/` hardcodes no address), and the Google Cloud console
(out-of-band, recorded in External registrations).

**Behaviors affected**
- What a browser sees at the unprefixed address (today: a blank page).
- What the api-server returns for unprefixed non-`/api` paths (today: 404
  from a direct hit; in production those paths never reach it).
- Nothing on the `/api` surface: the unprefixed mount is already first-class
  and stays byte-identical. That is what the add-on, both OAuth callbacks and
  the platform startup health check use.

**Worst realistic failure — four named traps**
1. **Redirect loop.** A legacy→prefix redirect that also matches paths already
   under the prefix redirects to itself and takes the whole app down.
   Mitigation: an explicit segment-boundary `isUnder()` guard, asserted in the
   unit tests and in the lit smoke (308 target must never re-enter the rule).
2. **Shadowing `/api`.** If the legacy redirect is registered before, or
   without excluding, `/api`, every add-on POST becomes a redirect — and
   `UrlFetchApp` follows redirects but the platform health check would flap.
   Mitigation: registered AFTER both `/api` mounts, plus an explicit `/api`
   exclusion, plus a test that every add-on path still returns its handler's
   status and not a 3xx.
3. **A cached 308 outliving the prefix.** 308 is permanent and browsers cache
   it. Rollback for this migration is "unset the two env vars" — a browser
   holding a cached 308 for `/pipeline` would keep bouncing to
   `/followup/pipeline`, which 404s once the prefix is withdrawn. This is the
   same reasoning that made Bundle 2 choose 302 over 301 for the bare-prefix
   redirect. **308 is used here as instructed** (it is what preserves the
   method, and the roadmap calls the old address a permanent redirect); the
   caveat is recorded in Open items, and the client-side redirect — which is
   what actually fires for real browsers — is not cached at all.
4. **Breaking the dark path.** Every change is gated: the server rule on
   `PREFIXED`, the client rule on a build-time `BASE_PATH !== "/"`. With both
   env vars unset the two files must produce byte-identical behavior, which
   the DARK smoke checks against a `main` worktree.

**Rollback:** unset `BASE_PATH`/`PUBLIC_URL` (both changes self-disable with
no code change), or `git revert` the merge. Nothing is deployed by this work.

### 2026-08-02 — Repair L1: legacy address survival, post-cutover — DONE

Predicted 3 files, touched 3. Not deployed; ready to publish.

**Production state BEFORE the repair, measured live (read-only GETs).** Two
addresses front the same deployment: `https://followupper.mobupps.net` (this
app's own domain, still attached) and `https://tools.mobupps.net/followup`
(the gateway, reverse-proxying it). In front of Express the Replit artifact
router splits on `paths`: `/api` + `/followup` → api-server, `/__mockup` →
mockup-sandbox, and **`/` → the dashboard's own STATIC artifact**
(`paths=["/"]`, rewrite `/*` → `/index.html`).

| Unprefixed request | Before | Verdict |
|---|---|---|
| `GET /` | 200 index.html — and it is the `/followup/`-based build, **byte-identical** to what `/followup/` serves. Assets resolve. Then wouter mounts `base="/followup"` against location `/`, nothing matches → **blank page**, clean 200, no console error | BROKEN |
| `GET /pipeline`, `/accounts`, `/anti-ghosting` | 200, same 765-byte index.html via the static artifact's rewrite → same blank page | BROKEN |
| `GET /api/*` | reaches the unconditional `app.use("/api", router)`. `/api/healthz` 200; all 9 add-on paths 401 on a wrong key, i.e. handler reached; POST bodies forwarded on both addresses | works |
| `GET /api/auth/callback` | 302 → `https://tools.mobupps.net/followup/?login_error=…` | works |
| `GET /api/gmail/callback` | 302 → `/followup/?oauth_error=…` (relative) | works |
| `GET /followup`, `/followup/…` | 302 → `/followup/`, then 200 | works |

Only the browser surface was broken. **Every machine caller was already
intact** — the unprefixed `/api` mount Bundle 2 deliberately kept is what
carried them. On the api-server alone (source boot, no platform router) the
unprefixed browser paths 404 and `/` serves the pre-prefix API test console;
in production that is masked by the static artifact.

**Caller inventory (step 3), before any code**
- *(a) Apps Script add-on* — 9 URLs, all `BACKEND_URL + "/api/…"`: POST
  `/api/sync`, `/api/queue`, `/api/queue-batch`, `/api/cancel`; GET
  `/api/stats`, `/api/prospects?replied=0`,
  `/api/prospects?vertical=…&replied=0`, `/api/followups?status=queued`,
  `/api/prospect/by-thread/<threadId>`. Auth: `apiRequest_()`
  (`addon/Config.gs:17-42`) sends `x-api-key` from the `API_KEY` Script
  Property; the server compares it to `ADDON_API_KEY`
  (`routes/doctrine.ts:29-44`) and 401s on mismatch. **The address is NOT
  hardcoded** — `addon/Config.gs:11` reads the `BACKEND_URL` Script Property
  (fallback `http://localhost:3000`). To change it: Apps Script project →
  Project Settings → Script Properties → `BACKEND_URL`. **No change needed:**
  both plausible values work, verified with live POSTs —
  `https://followupper.mobupps.net` (→ `/api/…`) and
  `https://tools.mobupps.net/followup` (→ `/followup/api/…`).
- *(b) Fixed-URL third-party callbacks* — two, both Google OAuth, both built
  from `PUBLIC_URL`. Production is live-emitting
  `redirect_uri=https://tools.mobupps.net/followup/api/auth/callback` (read
  off the live `/api/auth/google`); the Gmail counterpart is
  `…/followup/api/gmail/callback`. Both must be allowlisted in the Google
  Cloud console — out-of-band, see External registrations. No webhooks, no
  Gmail `users.watch`, no Pub/Sub topics exist anywhere in the codebase.
- *(c) Links in outgoing email/notifications* — **none.** Zero `http(s)://`
  in `weeklyDigest.ts`, `followupGenerator.ts`, `contextFollowupGenerator.ts`,
  `antiGhostingFollowupGenerator.ts`, `gmailClient.ts`; every
  `publicUrl()`/`appPath()`/`redirectPath()` call site is an OAuth redirect
  URI or an HTTP `Location`. The add-on cards contain no `OpenLink` widgets.
  **Nothing with a stale address is sitting in an inbox.**

**What was changed**

| File | Change |
|---|---|
| `dashboard/src/main.tsx` | `redirectLegacyAddress()` before `createRoot` — the repair that actually fires for real browsers |
| `api-server/src/lib/appUrls.ts` | `legacyRedirectTarget()` + private `isUnderPrefix()`: one implementation of the decision, shared by the server and the tests |
| `api-server/src/app.ts` | 308 middleware (gated on `PREFIXED`); comment lock on the unprefixed `/api` mount |
| `api-server/src/tests/test-base-path.ts` | +12 L1 cases (36 total in the file) |

**Design decision — the client redirect is the load-bearing one.** The broken
paths are answered by the dashboard's static artifact and never reach Express,
so no server rule can fix them. The 308 is the backstop for anything
addressing the api-server directly. Both were built because the platform
routing is not observable from the workspace and must not be the single point
of failure.

**Design decision — the redirect stays on the host it started on.**
`location.replace("/followup/…")` is same-origin, so a user on the legacy host
lands on `followupper.mobupps.net/followup/…`, not the gateway. Auth is
`localStorage`, which is per-origin: sending them cross-host would silently
log them out. (They migrate to the gateway host at their next login anyway —
the OAuth `redirect_uri` is absolute on `tools.mobupps.net`.)

**Gates**

| Gate | Result |
|---|---|
| typecheck | PASS |
| tests | 789/789 across 34 files (was 777; +12 L1 cases) |
| build, no `PORT`/`BASE_PATH`/`PUBLIC_URL` exported | PASS, exit 0 |

**Godlike audit — 5 rounds, closed clean on round 5.**
- *Round 1 (technical), 2 findings, both fixed.* (i) The comment and test name
  claimed a trailing-slash `BACKEND_URL` ("//api/sync") was "still treated as
  an API path". Measured: it 404s either way, because Express does not match a
  doubled slash to the `/api` mount — identically on `main`, in dark mode and
  in lit mode. The normalization prevents a *misleading redirect*, not a
  failure; both now say exactly that. (ii) `isUnderPrefix` was exported with no
  external consumer while its sibling `safeRootedPath` is module-private —
  made private so callers cannot make half a decision.
- *Round 2 (security), clean.* Encoded CRLF in path and query stays encoded in
  `Location`, no injected header. With `Accept: text/html` the redirect body
  keeps the URL percent-encoded — no raw `<script>`. Traversal
  (`/../../../etc/passwd`, `%2f` variants) followed **through** the new hop
  discloses no file. Every hostile path resolves back to this origin via a
  URL-parser oracle, never string shape.
- *Round 3 (end-user), clean.* Back button: `replace()` not `assign()`, so
  Back does not return to the blank page. `login_code` survives in the query.
  No flash of an empty shell — render is skipped entirely when redirecting.
- *Round 4 (added), 1 finding, fixed.* The `prefix === "/"` branch of
  `isUnderPrefix` is unreachable from its only caller, and its comment claimed
  it was what kept the dark path inert. Darkness is enforced by
  `legacyRedirectTarget`'s early return; the comment now says so and the
  branch is kept only as a correct default.
- *Round 5 (added), fully clean.* Gates and both smokes re-run on the final
  code.

**Traps — all four named pre-edit, plus one found during the audit**
1. *Redirect loop* — avoided; segment-boundary `isUnderPrefix`, asserted by an
   idempotence test (the rule's own target must return `null`) and in the lit
   smoke (every legacy path reaches 200 in exactly **1 hop**).
2. *Shadowing `/api`* — avoided; registered after both `/api` mounts plus an
   explicit exclusion. Smoke: 0 of the `/api` probes answer 3xx.
3. *Cached 308 outliving the prefix* — real, accepted, recorded in Open items.
4. *Breaking the dark path* — avoided; see the darkness evidence below.
5. **Found in round 4 — gateway prefix-stripping.** If the gateway proxied
   `tools.mobupps.net/followup/*` to the app's root, the 308 would rewrite
   `/pipeline` → `/followup/pipeline` → stripped back to `/pipeline` → an
   **infinite loop in production**. Ruled out empirically, two ways: bare
   `https://tools.mobupps.net/followup` returns 302 → `/followup/`, which only
   an api-server that sees the literal `/followup` can emit; and
   `…/followup/assets/index--NgTAXL1.js` returns 200 while
   `…/assets/index--NgTAXL1.js` returns 404. The gateway forwards the full
   path.

**Darkness evidence — the rollback path**
- *Server:* all **36** probes on a branch server and a `main` server booted
  side by side, both env-unset, are **byte-for-byte identical** (md5
  `db11b7b9…`, ports normalized). `/pipeline` and `/accounts` still 404,
  `/followup` still 404, `/` still serves the API test console.
- *Client:* the dark bundle was diffed against a dark bundle built from
  `main`'s `main.tsx` in place. Common prefix 714,032 of 714,315 bytes; the
  **entire** divergence is `function YC(){return!1}` plus an always-false
  guard — Vite constant-folds `BASE_PATH === "/"` and drops the body. The dark
  bundle contains **zero** occurrences of `location.replace`. The guarded code
  (`setBaseUrl` + `createRoot`) is byte-identical to `main`'s.

**SMOKE — LIT (`BASE_PATH=/followup/`, `PUBLIC_URL=https://tools.mobupps.net/followup`,
process env only, never written to Replit Secrets): 31/31.**

| Check | Result |
|---|---|
| `/`, `/pipeline`, `/accounts`, `/anti-ghosting`, `/context/pipeline` | 308 → prefixed, **1 hop**, final 200 |
| 308 preserves METHOD | proven end to end: the access log shows hop 1 `POST /l1-post-probe`, hop 2 arriving as `POST /followup/l1-post-probe` |
| query preserved | `/?login_code=abc&x=1` → `/followup/?login_code=abc&x=1` |
| all 9 add-on paths + both OAuth callbacks + `/api/healthz` | reach their handler; **0** answer 3xx |
| prefix-lookalikes `/followupper`, `/followups` | correctly redirected, not mistaken for prefixed |
| already-prefixed paths | never redirect (loop guard) |
| hostile paths (`//evil.example`, `/%5C…`, encoded CRLF, traversal) | Location never leaves this origin |
| assets referenced by the served SPA | 3/3 resolve, **zero 404s** |
| missing asset | honest 404, not index.html 200 |
| CORS preflight (`OPTIONS`) | 204 from `cors()` before the rule, identical in both modes |

**The shipped LIT bundle was executed, not just inspected.** The emitted
function was extracted verbatim from `index-85ZvAqfs.js` and run in Node
against a 14-path corpus with a stubbed `window.location`: `/` → `/followup/`,
`/pipeline?a=1#row-7` → `/followup/pipeline?a=1#row-7`, `/followupper` →
`/followup/followupper`, `/followup/*` → render in place, and every hostile
input resolves back to this origin.

**Blast radius held.** No database, cron, doctrine, add-on, `.replit`,
`artifact.toml` or dependency changes. No email dispatched — `app.ts` was
booted directly in every smoke, so `startCronJobs()` never ran. No workflow
was running and none was touched; ports 5711/5712/5713 were used and all were
shut down by PID.

**Deviation to note.** Steps 2 and 3 required the *actual* production state,
which cannot be read from the workspace, so I made unauthenticated read-only
`GET`s to the live app (plus four `POST`s carrying a deliberately wrong API
key, which 401 at the auth middleware before any handler work). No
authenticated call, no state change, nothing deployed.

### 2026-07-31 — Cutover C1: dashboard base-path blocker — BLAST RADIUS (pre-edit)

Branch `cutover-c1-dashboard-base-path`. Clears the cutover blocker recorded
in Open items: the dashboard artifact pins its own build base to `/`.

**Files to be touched — 1.** `artifacts/dashboard/.replit-artifact/artifact.toml`,
deleting exactly one line (`BASE_PATH = "/"`). `PORT` stays. No other file, no
other artifact.toml, no code change.

**Behaviors affected:** the base URL the dashboard's Vite build stamps into
`index.html` and every asset reference. Nothing else — `BASE_PATH` is read
only by `vite.config.ts`.

**Worst realistic failure:** if `vite.config.ts` treated an absent `BASE_PATH`
as fatal (as `mockup-sandbox`'s config does), removing the key would break both
the dev workflow and the build. Checked first: dashboard's config throws only
on missing `PORT` and falls back to `"/"` for `BASE_PATH`. Verified by booting
the dev server with the key absent — it served base `/`.

**Rollback:** re-add the single line, or `git checkout main`. Branch unmerged,
nothing deployed.

**RESULT — DONE.** Two files changed: the one-line deletion, plus a security
fix the audit forced (below).

**Investigation (step 2), before editing**
- *How the key reaches the build:* `[services.env]` is the unscoped,
  service-wide table. The api-server artifact proves Replit honours narrower
  scopes — it uses `[services.production.build.env]` (build-only, `CI=true`)
  and `[services.production.run.env]` (run-only) as separate tables — so the
  dashboard's unscoped form spans every phase, including the production `build`
  declared in the same block. Corroborating: `mockup-sandbox` relies on the
  identical unscoped `[services.env] BASE_PATH`, and its vite config *required*
  BASE_PATH at build time until Bundle 2 — only workable if that env reaches
  the build. **Honest limit:** Replit's deployer cannot be executed from inside
  the workspace, so this was not directly observed.
- *Does a deployment secret override it?* Not testable from here, and not
  guessed. It does not need to be: while the key is present with a literal
  `"/"`, the only safe assumption is that it wins or ties, so a deployment
  secret is **not guaranteed** to take effect. That ambiguity *is* the blocker.
  Deleting the key removes the question entirely.
- *Dev workflow with the key absent?* Verified empirically — dev server booted
  on port 5501 with BASE_PATH unset, served base `/`. `vite.config.ts` throws
  only on missing `PORT` (which stays) and falls back to `"/"`. Contrast
  `mockup-sandbox`, whose config *does* throw on absent BASE_PATH outside a
  build; untouched.
- *Halt condition did not apply:* the unset case builds and serves correctly on
  the code default.

**Step 4 evidence — both directions**
```
BASE_PATH unset      -> href="/favicon.svg"           src="/assets/index-B0HQJ3rS.js"
BASE_PATH=/followup/ -> href="/followup/favicon.svg"  src="/followup/assets/index--NgTAXL1.js"
```

**Gates:** typecheck PASS; 34/34 test files; full build PASS with no env
exported.

**Godlike audit — 3 rounds, closed clean.** Round 1 (security framing) found a
real defect **introduced by this very change**: the artifact.toml pin had been
accidentally shielding the build. With it gone, a hostile deployment-env
`BASE_PATH=//evil.example/` was stamped verbatim, producing
`src="//evil.example/assets/..."` — a protocol-relative script URL that a
URL-parser oracle confirmed resolves to `evil.example`. The server already
rejected the same value (`appUrls` normalized it to `/`); the build did not.
Fixed by mirroring `normalizeBasePath`'s rule set in `vite.config.ts`. Rounds 2
and 3 clean. Post-fix oracle, 8 inputs: `//evil.example/`, `///evil.example/`,
`/\evil.example/`, `https://evil.example/`, `javascript:x` all degrade to `/`
and produce a build **byte-identical to the unset state** (same hash
`B0HQJ3rS`); `/followup` and `/followup/` both produce the same prefixed build.

**Smoke — both ways, `app.ts` booted directly so `startCronJobs()` never ran.**
- *LIT* (port 5601, prefixed build on disk): `/followup/` 200, `/followup` 302,
  deep link 200, health 200 on both prefixed and unprefixed forms, and **zero
  asset 404s** — all three references in the served index.html returned 200.
  No "dashboard build is missing" warning.
- *DARK* (5602 = `main` pre-C1 vs 5603 = branch, both env-unset): all 16
  baseline endpoints **byte-for-byte identical**. `/followup` and `/followup/`
  still 404, as on `main`.
- `GET /` returns 500 under a source boot on **both** `main` and the branch —
  `app.get("/")` serves `__dirname/public`, which does not exist under `src/`.
  A harness artifact of the mandated source boot, not a defect: the production
  bundle serves `/` with 200.

**Deviation to note:** while diagnosing that 500 I briefly booted
`dist/index.mjs` (~15s), which *does* call `startCronJobs()`, rather than
`app.ts`. Contrary to the instruction. Verified no harm: zero
`cron_heartbeats` rows in the following 10 minutes (18:29 UTC is nowhere near a
`*/15` or `:05/:20/:35/:50` boundary), and with 0 queued follow-ups and 0
connected users nothing was dispatchable regardless. Process killed, port
confirmed closed.

**Note — state of the world at branch time:** `main` had moved to `cf5725f`
"Published your App" (empty deployment marker, Replit Agent, 2026-07-31 17:55),
i.e. **Bundle 2 was deployed to production** between bundles. Dark by
construction, so no behavior change. Lineage checked per the Git safety rules:
`replit-agent` is 683 commits ahead of `main` but its tree is byte-identical
(`db904e8a`), so it holds the retained granular history and no content `main`
lacks. Both bundle commits confirmed ancestors of `main`.

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

## Provenance audit PA-1 — 2026-08-05

**Verdict: no content has been lost.** Every ref, dangling commit, backup
directory and dated bundle in this repo was compared against HEAD; every
difference is accounted for by a recorded commit or a stated policy. Evidence
limits are listed at the end — none of them is evidence of loss.

### The history-wipe event, reconstructed

- `main` was recreated from scratch on **2026-07-30** as a single snapshot
  commit `858102c` ("Snapshot 2026-07-30 - fresh history; database dumps
  excluded"). The pre-amend twin `9f49ade` says why: "previous remote deleted,
  shallow local history unrecoverable". The old clone was **shallow** —
  `.git/shallow` pins the boundary at `962d47d` (2026-04-08, "add db backup").
- The old lineage **survives in full** at `backup-old-shallow-history` =
  local `snapshot-2026-07-30` = `gitsafe-backup/main` = `da507e9`
  (2026-07-29 12:53, 342 commits, 2026-04-08 → 2026-07-29).
- The platform deploy chain (`replit-agent`, 699 commits) **bridges the wipe**:
  `1b29bc1` (2026-07-31) merges `7630f53` (old-lineage publish) with `cf5725f`
  (new-lineage publish); `git merge-base replit-agent backup-old-shallow-history`
  = `da507e9`. The old tree never became unreachable.

### Wipe-boundary diff (the core test)

`git diff da507e9 858102c`: **3 deletions, 0 additions, 1 modification.**
Deleted: `backup.sql` (−524), `ql "$DATABASE_URL" -c "` (−314, shell-mishap
junk file), `sync-dev-db.sql` (−36). Modified: `.gitignore` (adds exactly those
two dump names). Both dumps still exist on disk, untracked. Everything else in
the old tip's tree entered the snapshot byte-for-byte.

`git diff da507e9 HEAD` (old tip vs today): 38 files, +2498/−978. The 978
deletions = 874 (the three files above) + ~104 lines of Bundle 1/2/C1/L1
refactor churn (verified against `git diff origin/snapshot-2026-07-30 HEAD`
= −104). No app content dropped.

### Per-ref content test (every ref → HEAD, insertions/deletions)

| Ref | vs HEAD | Disposition |
|---|---|---|
| backup-old-shallow-history (`da507e9`) | +2498/−978 | fully accounted above |
| origin/snapshot-2026-07-30 (`858102c`) | +2495/−104 | post-snapshot work only |
| replit-agent (`1e8049f`) | +303/−7 | HEAD adds L1b test + TODO; deploy lag, expected |
| bundle-1 / bundle-2 / cutover-c1 / l1 / l1a | net insertions only | ancestors of main |
| cutover-l1b-pin-status | empty | = HEAD |
| dangling `845543a`, `79a3619` (2026-05-08 stashes) | — | stash residue; identical file-set landed in `4d413fe` same day |
| dangling `9f49ade` | same as da507e9 case | pre-amend snapshot twin |

### Path test (every path that ever existed vs HEAD)

1766 paths have ever been tracked on any ref; 1444 exist at HEAD; **322 gone**
(full list at the end). Every one is: (a) transient patch-staging
(`_inbox/`, `_apply_staging/`, `pi-hardening/`, `opus48-ag/`,
`followuper-batch/`, `writer-fallback-chain/`, `structural-lint-batch/`,
`cascade-qa/`), (b) `.bak` patch backups, (c) stale `source-code/` mirror
layout (the mirror is a one-way export written by `source-code/sync.sh`; it is
not what runs), or (d) a deliberate deletion recorded by a commit:
`followups.tsx` + `prospects.tsx` (pipeline refactor `4d413fe`, 2026-05-08),
`doctrine-integration/doctrineFollowupLabel.ts` (`f9a290a`, 2026-06-24),
`lib/db/drizzle/*` (`725f93f`, 2026-05-17),
`smoke-cache-languages.ts` (`2e96be7`, 2026-06-24).
**No path disappeared without a recording commit.**

### Peak-line test

All 12 key source files are at their historical maximum line count at HEAD:
doctrine.ts 1872, anti-ghosting.ts 1772, followupGenerator.ts 671,
followupPrompts.ts 417, scheduler.ts 1417, gmailSync.ts 1222,
timingEngine.ts 242, emailSummarizer.ts 305, competitorLibraryData.ts 50683,
followupExemplarsData.ts 22496, pipeline.tsx 1882, cron.ts 396.
No file is smaller than it ever was.

### Bundle inventory (step 13) and reconstruction (steps 14–16)

Root zips: batch-resume-bulk (2026-05-11), opus48-antighosting-bundle-v2
(05-31), cascade-qa-bundle (06-03), pi-hardening (06-04), structural-lint-batch
(06-10), gemini-model-switch (06-10), doctrine-followup-fixes-round2 (06-11),
-round4 (06-11), dff-smoke-bundle (06-22), dff-native-script-bundle (06-22),
payload.zip (06-22). attached_assets: ~60 batch zips 2026-05-08 → 05-19 plus
followuper-bounce-archive-pause (06-02). Backup dirs: `.ship-backups/`
(05-31), `backups/dff-exemplar-competitor-2026-06-22*`,
`_apply_backup_20260602-*`. **No July-dated bundle exists in this repo** —
the newest archive is 2026-06-22. July work is evidenced in git only
(old-lineage commits Jul 1–29), all contained in HEAD.

Extracted and diffed vs HEAD: opus48-antighosting-v2 (May 31),
followuper-bounce-archive-pause (Jun 2), structural-lint-batch (Jun 10),
dff-native-script-bundle (Jun 22), payload.zip (Jun 22). Result: **zero
payload paths absent at HEAD, zero functions/constants/routes missing**, every
file at HEAD strictly newer than or equal to its bundle version.
`bounceDetection.ts` and `globalPause.ts` are byte-identical to the Jun 2
bundle. The Jun 2 gmailSync dedup guard survives improved (knownIds prefilter,
gmailSync.ts:302–372).

### Symptom anchors (Phase 5)

- **v4 lint stages — present, newest ever.** doctrineLint.ts + nativenessV4.ts
  created 2026-05-14 (five-commit sequence ending `d1461bc` volume
  plausibility); structuralLint.ts 06-10; competitorScriptLint.ts 06-22;
  spamRiskLint.ts **07-23** (newest stage). All wired in followupGenerator.ts
  heal loop (`:527–537`; spam lint import `:23`, call `:535`). File contents at
  HEAD identical to the old tip.
- **Discourse marker autofix — never regressed because never wired.**
  `discourseMarkerAutofix.ts` (2026-05-14) is imported only by
  `test-discourse-autofix-v4r4.ts` — and `git log --all -S` proves **no commit
  on any ref ever wired it** into a service or route. Detection
  (`doctrineLint.ts:414`) + LLM rewrite is, and always was, the design.
- **Volume calibration — present, unchanged since creation** (2026-05-14),
  wired at doctrineLint.ts:450–487 and critic criterion 14
  (followupPrompts.ts:282).
- **Nativeness — at peak**: nativenessV3.ts 1229 lines, nativenessV4.ts 1559
  lines, both identical to old tip.
- **Send caps — never changed → rollback disproven for this symptom.**
  30/hour, 200/day defaults (sendBudget.ts:55–56) identical since creation
  2026-05-08. Bulk send-now cap lowered 100→25 on 2026-05-08 (current 25 is
  the newer value). HARD_FOLLOWUP_CAP=3 unchanged since 06-09.
  DEFAULT_CAP_USD=500 unchanged since 06-21.
- **Scheduling window — never changed → rollback disproven.** 8–18 UTC,
  Mon–Fri defaults identical since 2026-05-08 (timingEngine.ts:97–114,
  scheduleWindow.ts:19,53–61).
- **Bounce handling — newest ever.** bounceDetection.ts unchanged since
  creation 2026-06-02; hard-bounce suppression (gmailSync.ts:529) and pre-send
  suppression gate (scheduler.ts:230–247) present. `maxHealingIterations`
  3→2 on 2026-06-24 (`5cfd63d`); current 2 is the newest value.

### What is deployed (Phase 3)

Repo evidence: last platform publish `1e8049f`, 2026-08-02 17:18:06, tree
identical to main@`5088adb` — L1 + L1a live, **L1b (test-only) merged but
unpublished**, exactly matching ROADMAP. Local `dist/` is a dev build from
17:37 that day, not the deployed artifact. `/api/healthz` returns only
`{status:"ok"}` — no build identity.

### Evidence limits — what the repo cannot settle, and what would

1. **Pre-2026-04-08 commit history**: never in this clone (shallow) and the
   old origin was deleted. Content as of 04-08 is present (`962d47d` tree);
   its earlier evolution is not. Would settle: the deleted upstream repo, if
   Replit support can recover it.
2. **That the VM actually serves build `1e8049f`**: would settle: Replit
   Deployments pane build log (commit + timestamp), or adding a version
   endpoint.
3. **Add-on deployed version**: `addon/.clasp.json` scriptId is a placeholder.
   Would settle: Apps Script console version history.
4. **Env-side rollback mimicry**: deployment secret values are not readable
   here. Flags that can mimic a rollback: STRUCTURAL_LINT_ENABLED,
   SPAM_LINT_ENABLED, SPAM_GATE_MODE/ENABLED, SEND_HOUR_START/END,
   DOCTRINE_HOURLY/DAILY_SEND_CAP, DOCTRINE_DAILY_BUDGET_USD,
   WRITER_/CRITIC_/SUMMARIZER_PROVIDER, GEMINI_*_MODEL/THINKING,
   WRITER_EXEMPLAR_COUNT, WRITER_COMPETITOR_COUNT, FOLLOWUP_ACK_LLM_CONFIRM,
   ADV_SKIP_REWRITE, PROMPT_CACHE_TTL, BASE_PATH. Would settle: the
   deployment's Secrets pane compared against these code defaults.

### Fragility notes (no action taken, per order)

- The old lineage's survival rests on `backup-old-shallow-history` and the
  `gitsafe-backup` remote. A tag on `da507e9` would make it robust against
  branch deletion. Not done in this order.
- Dangling commits `845543a`/`79a3619`/`9f49ade` are unreachable and will die
  in a future `git gc`; their content is confirmed redundant.
- Observed in passing (pre-existing states, not regressions): a duplicate
  legacy bounce handler in gmailSync.ts (~:1035–1077); doctrine.ts:25–26 keeps
  a local "0 = unlimited" cap convention that followupLimits.ts says was
  removed; the 8/18/Mon–Fri defaults are hardcoded in four places.

### Full path set (step 6): 322 paths ever tracked, absent at HEAD

```
_apply_staging/artifacts/api-server/src/cron.ts
_apply_staging/artifacts/api-server/src/lib/adminAccess.ts
_apply_staging/artifacts/api-server/src/lib/bounceDetection.ts
_apply_staging/artifacts/api-server/src/lib/emailNormalize.ts
_apply_staging/artifacts/api-server/src/lib/globalPause.ts
_apply_staging/artifacts/api-server/src/lib/pipelineUserPicker.ts
_apply_staging/artifacts/api-server/src/lib/startupMigrations.ts
_apply_staging/artifacts/api-server/src/lib/suppression.ts
_apply_staging/artifacts/api-server/src/middlewares/requireAdmin.ts
_apply_staging/artifacts/api-server/src/routes/admin-activity-report.ts
_apply_staging/artifacts/api-server/src/routes/admin-activity.ts
_apply_staging/artifacts/api-server/src/routes/admin-global-controls.ts
_apply_staging/artifacts/api-server/src/routes/admin-prospect-kill.ts
_apply_staging/artifacts/api-server/src/routes/admin-salvage.ts
_apply_staging/artifacts/api-server/src/routes/admin-suppression.ts
_apply_staging/artifacts/api-server/src/routes/admin-user-controls.ts
_apply_staging/artifacts/api-server/src/routes/admin-user-kill.ts
_apply_staging/artifacts/api-server/src/routes/anti-ghosting.ts
_apply_staging/artifacts/api-server/src/routes/auth.ts
_apply_staging/artifacts/api-server/src/routes/context.ts
_apply_staging/artifacts/api-server/src/routes/doctrine.ts
_apply_staging/artifacts/api-server/src/routes/index.ts
_apply_staging/artifacts/api-server/src/services/gmailClient.ts
_apply_staging/artifacts/api-server/src/services/gmailSync.ts
_apply_staging/artifacts/api-server/src/services/scheduler.ts
_apply_staging/artifacts/api-server/src/services/weeklyDigest.ts
_apply_staging/artifacts/api-server/src/tests/test-admin-access.ts
_apply_staging/artifacts/api-server/src/tests/test-bounce-detection.ts
_apply_staging/artifacts/api-server/src/tests/test-nativeness-v4.ts
_apply_staging/artifacts/api-server/src/tests/test-pipeline-user-picker.ts
_apply_staging/artifacts/api-server/src/tests/test-suppression.ts
_apply_staging/artifacts/dashboard/src/App.tsx
_apply_staging/artifacts/dashboard/src/components/api-key-provider.tsx
_apply_staging/artifacts/dashboard/src/components/layout.tsx
_apply_staging/artifacts/dashboard/src/components/pipeline-user-picker.tsx
_apply_staging/artifacts/dashboard/src/components/prospect-kill-control.tsx
_apply_staging/artifacts/dashboard/src/hooks/use-admin.ts
_apply_staging/artifacts/dashboard/src/hooks/use-manager-options.ts
_apply_staging/artifacts/dashboard/src/pages/admin-activity.tsx
_apply_staging/artifacts/dashboard/src/pages/anti-ghosting-pipeline.tsx
_apply_staging/artifacts/dashboard/src/pages/context-pipeline.tsx
_apply_staging/artifacts/dashboard/src/pages/pipeline.tsx
_apply_staging/lib/db/src/schema/app-settings.ts
_apply_staging/lib/db/src/schema/cron-heartbeats.ts
_apply_staging/lib/db/src/schema/index.ts
_apply_staging/lib/db/src/schema/prospects.ts
_apply_staging/lib/db/src/schema/suppressed-addresses.ts
artifacts/api-server/scripts/smoke-cache-languages.ts
artifacts/api-server/src/cron.ts.batch3b.bak
artifacts/api-server/src/routes/doctrine.ts.batch3b.bak
artifacts/api-server/src/services/gmailClient.ts.batch3b.bak
artifacts/api-server/src/services/gmailSync.ts.batch3b.bak
artifacts/api-server/src/services/scheduler.ts.batch3b.bak
artifacts/api-server/src/services/timingEngine.ts.batch3b.bak
artifacts/dashboard/src/pages/followups.tsx
artifacts/dashboard/src/pages/prospects.tsx
backup.sql
budget_apply_v2/apply.sh
budget_apply_v2/_backup-20260621112346/lib/usageTracker.ts
budget_apply_v2/_backup-20260621112346/routes/index.ts
budget_apply_v2/_backup-20260621112346/services/emailSummarizer.ts
budget_apply_v2/_backup-20260621112346/services/replySentiment.ts
budget_apply_v2/_backup-20260621112346/services/scheduler.ts
budget_apply_v2/payload.zip
budget_apply_v2/_stage/api-server/src/lib/dailyBudgetMath.ts
budget_apply_v2/_stage/api-server/src/lib/dailyBudget.ts
budget_apply_v2/_stage/api-server/src/routes/admin-daily-budget.ts
budget_apply_v2/_stage/api-server/src/tests/dailyBudget.test.ts
budget_apply_v2/_stage/patch.py
budget-daily-cap-v2.zip
clean-ship/apply_edits.py
clean-ship/backup-20260609220708/artifacts/api-server/src/cron.ts
clean-ship/backup-20260609220708/artifacts/api-server/src/services/antiGhostingFollowupGenerator.ts
clean-ship/backup-20260609220708/artifacts/api-server/src/services/antiGhostingFollowupPrompts.ts
clean-ship/backup-20260609220708/artifacts/api-server/src/services/followupPrompts.ts
clean-ship/install.sh
company-cascade-ship/payload.zip
company-cascade-ship/ship.sh
company-cascade-ship.zip
critic-cleanup/apply.py
critic-cleanup/backup/lib/gemini.ts.bak
critic-cleanup/backup/scripts/smoke-critic.ts.bak
critic-cleanup/backup/services/criticProvider.ts.bak
critic-cleanup/payload/scripts/smoke-critic.ts
critic-cleanup/restore.sh
critic-cleanup/run.sh
critic-cleanup.zip
critic-cost-report/payload/scripts/critic-cost-report.ts
critic-cost-report/report-run.sh
critic-cost-report.zip
critic-gemini-models/apply.py
critic-gemini-models/backup/lib/pricing.ts.bak
critic-gemini-models/backup/scripts/critic-cost-report.ts.bak
critic-gemini-models/restore.sh
critic-gemini-models/run.sh
critic-gemini-models.zip
critic-nokey-sonnet/apply.py
critic-nokey-sonnet/backup/scripts/smoke-critic.ts.bak
critic-nokey-sonnet/backup/services/criticProvider.ts.bak
critic-nokey-sonnet/payload/scripts/smoke-critic.ts
critic-nokey-sonnet/restore.sh
critic-nokey-sonnet/run.sh
critic-nokey-sonnet.zip
critic-proid-fix/apply.py
critic-proid-fix/backup/lib/pricing.ts.bak
critic-proid-fix/backup/scripts/critic-cost-report.ts.bak
critic-proid-fix/restore.sh
critic-proid-fix/run.sh
critic-proid-fix.zip
critic-sonnet-fallback-real/apply.py
critic-sonnet-fallback-real/backup/lib/anthropic.ts.bak
critic-sonnet-fallback-real/backup/scripts/smoke-critic.ts.bak
critic-sonnet-fallback-real/backup/services/criticProvider.ts.bak
critic-sonnet-fallback-real/payload/scripts/smoke-critic.ts
critic-sonnet-fallback-real/restore.sh
critic-sonnet-fallback-real/run.sh
critic-sonnet-fallback-real.zip
dff-exemplar-competitor-bundle.zip
dff-synthetic-verify-bundle.zip
doctrine-followup-fixes-round2-hotfix.zip
doctrine-followup-fixes-round3.zip
doctrine-followup-fixes.zip
doctrine-integration/doctrineFollowupLabel.ts
fix-adminprovider.zip
fix-batch/apply_edits.py
fix-batch/backup-20260609212356/artifacts/api-server/src/services/followupGenerator.ts
fix-batch/backup-20260609212356/artifacts/api-server/src/services/followupPrompts.ts
fix-batch/install.sh
_fixes2/apply-fixes.sh
_fixes2/patches/api-server.patch
_fixes2/patches/dashboard.patch
_fixes2/README.md
_fixes3/apply-fixes.sh
_fixes3/patches/api-server.patch
_fixes3/patches/dashboard.patch
_fixes3/README.md
_fixes4/apply-fixes.sh
_fixes4/patches/dashboard.patch
_fixes4/README.md
_fixes/apply-fixes.sh
_fixes/patches/api-server.patch
_fixes/patches/dashboard.patch
_fixes/README.md
followuper-30d-cap-cost.zip
followuper-address-suppression.zip
followuper-archived-view-bounce-badge.zip
followuper-batch/apply_edits.py
followuper-batch/backup-20260609204111/artifacts/api-server/src/cron.ts
followuper-batch/backup-20260609204111/artifacts/api-server/src/lib/anthropic.ts
followuper-batch/backup-20260609204111/artifacts/api-server/src/routes/anti-ghosting.ts
followuper-batch/backup-20260609204111/artifacts/api-server/src/routes/context.ts
followuper-batch/backup-20260609204111/artifacts/api-server/src/routes/gmail-auth.ts
followuper-batch/backup-20260609204111/artifacts/api-server/src/services/antiGhostingFollowupGenerator.ts
followuper-batch/backup-20260609204111/artifacts/api-server/src/services/contextFollowupGenerator.ts
followuper-batch/backup-20260609204111/artifacts/api-server/src/services/followupGenerator.ts
followuper-batch/backup-20260609204111/artifacts/api-server/src/services/scheduler.ts
followuper-batch/backup-20260609204111/artifacts/dashboard/src/pages/accounts.tsx
followuper-batch/backup-20260609204111/lib/db/src/schema/prospects.ts
followuper-batch/install.sh
followuper-batch/new-files/followupLimits.ts
followuper-batch/new-files/test-followup-limits.ts
followuper-bounce-archive-pause.zip
followuper-clean-ship.zip
followuper-doctrine-v1.zip
followuper-hardening-gate-cron.zip
followuper-no-fabricated-numbers.zip
followuper-sync-dev-db.zip
gemini-critic-adversarial/adversarial-run.sh
gemini-critic-adversarial/payload/scripts/adversarial-critic.ts
gemini-critic-adversarial.zip
gemini-critic-batch/payload/apply.py
gemini-critic-batch/payload/lib/gemini.ts
gemini-critic-batch/payload/services/criticProvider.ts
gemini-critic-batch/run.sh
gemini-critic-batch.zip
gemini-critic-retry/payload/lib/gemini.ts
gemini-critic-retry/payload/scripts/smoke-critic.ts
gemini-critic-retry/retry-run.sh
gemini-critic-retry.zip
gemini-critic-smoke/payload/scripts/smoke-critic.ts
gemini-critic-smoke/smoke-run.sh
gemini-critic-smoke.zip
gemini-model-switch/apply.py
gemini-model-switch/backup/lib/gemini.ts.bak
gemini-model-switch/backup/lib/pricing.ts.bak
gemini-model-switch/backup/scripts/smoke-critic.ts.bak
gemini-model-switch/backup/services/criticProvider.ts.bak
gemini-model-switch/payload/scripts/smoke-critic.ts
gemini-model-switch/restore.sh
gemini-model-switch/run.sh
_hf/apply-fixes.sh
_hf/patches/db.patch
_hf/README.md
_inbox/batch7c/apply-batch7c.mjs
_inbox/batch7c/audit-batch7c.mjs
_inbox/batch7c-doctrine-filter.zip
_inbox/batch7c/README.md
_inbox/batch7d/apply-batch7d.mjs
_inbox/batch7d/audit-batch7d.mjs
_inbox/batch7d/files/dashboard/pages/context-activity.tsx
_inbox/batch7d/files/dashboard/pages/context-inspector.tsx
_inbox/batch7d/files/dashboard/pages/context-pipeline.tsx
_inbox/batch7d/files/dashboard/pages/picker.tsx
_inbox/batch7d-picker-theme-switcher.zip
_inbox/batch7d/README.md
_inbox/batch7e/apply-batch7e.mjs
_inbox/batch7e/audit-batch7e.mjs
_inbox/batch7e-context-pipeline.zip
_inbox/batch7e-hotfix1/apply-batch7e-hotfix1.mjs
_inbox/batch7e-hotfix1-asc-import.zip
_inbox/batch7e/README.md
_inbox/batch7f/apply-batch7f.mjs
_inbox/batch7f/audit-batch7f.mjs
_inbox/batch7f-context-activity-log.zip
_inbox/batch7f/README.md
_inbox/batch7g/apply-batch7g.mjs
_inbox/batch7g/audit-batch7g.mjs
_inbox/batch7g-context-inspector-backend.zip
_inbox/batch7g/README.md
_inbox/batch7h/apply-batch7h.mjs
_inbox/batch7h/audit-batch7h.mjs
_inbox/batch7h-context-inspector-frontend.zip
_inbox/batch7h/README.md
_inbox/batch7i/apply-batch7i.mjs
_inbox/batch7i/audit-batch7i.mjs
_inbox/batch7i/README.md
_inbox/batch7i-sidebar-activity-per-product.zip
_inbox/batch7j/apply-batch7j.mjs
_inbox/batch7j/audit-batch7j.mjs
_inbox/batch7j/README.md
_inbox/batch7j-vertical-hide-stats-parity.zip
_inbox/batch7k/apply-batch7k.mjs
_inbox/batch7k/audit-batch7k.mjs
_inbox/batch7k/README.md
_inbox/batch7k-sync-autoqueue.zip
_inbox/batch7l/apply-batch7l.mjs
_inbox/batch7l/audit-batch7l.mjs
_inbox/batch7l-context-safety-parity.zip
_inbox/batch7l/README.md
_inbox/batch7m/apply-batch7m.mjs
_inbox/batch7m/audit-batch7m.mjs
_inbox/batch7m-pipeline-stage-indicator.zip
_inbox/batch7m/README.md
_inbox/batch7n/apply-batch7n.mjs
_inbox/batch7n/audit-batch7n.mjs
_inbox/batch7n-cron-heartbeat.zip
_inbox/batch7n/migrate-batch7n.sql
_inbox/batch7n/README.md
lib/db/drizzle/0000_relax_prospects_uq.sql
lib/db/drizzle/meta/0000_snapshot.json
lib/db/drizzle/meta/_journal.json
opus48-ag/CHANGES.md
opus48-ag/payload/api-server/lib/anthropic.ts
opus48-ag/payload/api-server/lib/pricing.ts
opus48-ag/payload/api-server/routes/admin-activity-report.ts
opus48-ag/payload/api-server/routes/admin-activity.ts
opus48-ag/payload/api-server/routes/anti-ghosting.ts
opus48-ag/payload/api-server/services/antiGhostingFollowupGenerator.ts
opus48-ag/payload/api-server/services/contextFollowupGenerator.ts
opus48-ag/payload/api-server/services/followupGenerator.ts
opus48-ag/payload/dashboard/App.tsx
opus48-ag/payload/dashboard/components/layout.tsx
opus48-ag/payload/dashboard/pages/admin-activity.tsx
opus48-ag/payload/dashboard/pages/anti-ghosting-activity.tsx
opus48-ag/ship.sh
pi-hardening/AUDIT.md
pi-hardening/install.sh
pi-hardening/patch.py
pi-hardening/promptInjection.test.ts
pi-hardening/promptInjection.ts
pi-hardening/README.txt
pi-hardening/RELAY_VERIFICATION_PROMPT.md
pi-hardening/uninstall.sh
"ql \"$DATABASE_URL\" -c \""
reddit_followupper_v1_1.zip
source-code/api-server/cron.ts.batch3b.bak
source-code/api-server/routes/doctrine.ts.batch3b.bak
source-code/api-server/services/followupPrompts.ts.reddit.bak
source-code/api-server/services/gmailClient.ts.batch3b.bak
source-code/api-server/services/gmailSync.ts.batch3b.bak
source-code/api-server/services/scheduler.ts.batch3b.bak
source-code/api-server/services/timingEngine.ts.batch3b.bak
source-code/api-server/src/app.ts
source-code/api-server/src/cron.ts
source-code/api-server/src/index.ts
source-code/api-server/src/lib/constants.ts
source-code/api-server/src/lib/logger.ts
source-code/api-server/src/lib/verticalClassifier.ts
source-code/api-server/src/routes/auth.ts
source-code/api-server/src/routes/doctrine.ts
source-code/api-server/src/routes/email-inspector.ts
source-code/api-server/src/routes/gmail-auth.ts
source-code/api-server/src/routes/health.ts
source-code/api-server/src/routes/index.ts
source-code/api-server/src/scripts/createLabels.ts
source-code/api-server/src/scripts/seed.ts
source-code/api-server/src/services/emailSummarizer.ts
source-code/api-server/src/services/followupGenerator.ts
source-code/api-server/src/services/followupPrompts.ts
source-code/api-server/src/services/gmailClient.ts
source-code/api-server/src/services/gmailSync.ts
source-code/api-server/src/services/scheduler.ts
source-code/api-server/src/services/timingEngine.ts
source-code-csd-v1.1.zip
source-code-csd-v1.zip
source-code/dashboard/pages/followups.tsx
source-code/dashboard/pages/prospects.tsx
source-code/dashboard/src/pages/prospects.tsx
source-code/doctrine-integration/doctrineFollowupLabel.ts
source-code-rh1.zip
structural-lint-batch/apply.py
structural-lint-batch/backup/followupGenerator.ts.bak
structural-lint-batch/payload/lib/structuralLint.ts
structural-lint-batch/payload/tests/test-structural-lint.ts
structural-lint-batch/restore.sh
structural-lint-batch/run.sh
sync-dev-db.sql
writer-fallback-chain/apply.sh
writer-fallback-chain/AUDIT.md
writer-fallback-chain/BLAST_RADIUS.md
writer-fallback-chain/payload.zip
writer-fallback-chain.zip
```

## Blast radius — diagnostic order F-D3 (2026-08-05)

Read-only history audit ("were these behaviours ever different?"). Read: all
refs, reflog, dangling commits, file contents at eleven epochs. Wrote exactly
two files: `diagnostic.md` (full findings) and this entry. No source, DB,
secrets, deploys, or workflow touched. Headline: zero confirmed rollbacks;
send caps / window / bounce / structural-toggle / autofix wiring have had one
value ever (visible history starts 2026-04-08), so production deviations are
configuration, per-user DB settings, or the separately-deployed add-on — see
diagnostic.md §6-7 for the Secrets-pane checklist and add-on discriminator.
