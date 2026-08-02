# TODO - Email Followupper

## Open items

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

- **[Repair L1a, deliberate gap] No test pins the redirect STATUS CODE.** The
  unit tests cover `legacyRedirectTarget()`, which returns a path; the status
  lives in `app.ts` and only the live smoke observes it, so flipping 307 back
  to 308 — or to 302, which would silently downgrade a POST to a GET — would
  pass every gate. Pinning it needs a booted app, which `test-base-path.ts`
  deliberately avoids ("no DB, no network"). Left alone because L1a's scope was
  one digit; worth an api-server-level HTTP test if one is ever added.

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
