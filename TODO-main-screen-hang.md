# TODO — Main-screen indefinite "loading emails" hang (2026-07-16)

Incident: a colleague logs into the dashboard (followupper.mobupps.net), lands on
the main Pipeline screen, and it loads emails indefinitely. Clicking Settings
(and everything else) does nothing. Reported 2026-07-16, same day as the
Reserved-VM re-deploy + domain switch (`doctrine-followupv-2.replit.app` →
`followupper.mobupps.net`, commits 18a83d4/f3bd7e2).

## Root cause (CONFIRMED)

Chain of four links, each verified in code:

1. **Trigger** — the domain moved, so every browser hits a new origin with
   empty localStorage; everyone re-runs login + identity resolution.
2. **Identity miss** — the colleague's login email does not match any
   *connected Gmail account*, so identity resolution stores
   `currentUser.userId = null`
   ([api-key-provider.tsx](artifacts/dashboard/src/components/api-key-provider.tsx)).
3. **Unfiltered fetch** — with `userId` null, the Pipeline page called
   `GET /api/followups` with **no userId param**, gated only on `!!apiKey`
   ([pipeline.tsx:598](artifacts/dashboard/src/pages/pipeline.tsx#L598)).
4. **Unbounded response** — the server answered with up to **50,000 rows ×
   full `original_body` + `generated_body`** in one synchronous `res.json()`
   ([doctrine.ts:701](artifacts/api-server/src/routes/doctrine.ts#L701)).
   The browser tab froze downloading/parsing/rendering it (no windowing —
   one `<Card>` per thread), which is why Settings clicks were dead; while
   serializing, the server's event loop stalled for every user; and a 30s
   `refetchInterval` restarted the cycle forever.

Same bug reachable on `GET /api/context/followups`,
`GET /api/anti-ghosting/followups`, `GET /api/context/prospects`, and
(no LIMIT at all) `GET /api/prospects`.

## Steps

- [x] 1. Root-cause trace (see above; three-agent audit reports summarized below)
- [x] 2. Godlike audit — blast radius of the 2026-07-16 deploy
  - [x] Sync entry points vs new `SyncAlreadyRunningError` 409: **all deployed
        callers correct** (cron skip-branch, three /sync routes honor
        statusCode, add-on + inspectors use per-user path exempt from 409;
        no retry loops anywhere).
  - [x] Unbounded/hanging routes: the 5 list endpoints above (fixed); also
        noted (not fixed, pre-existing): in-request LLM pipeline on
        followup-now/send-bulk/process routes, Gmail calls with no request
        timeout in inspector/candidates routes, no server/statement
        timeouts anywhere (see Recommendations).
  - [x] Domain-switch fallout: no dead-domain hardcodes in live code;
        dashboard API base is origin-relative; CORS open. Two EXTERNAL
        items remain — see "Needs operator" below.
  - [x] Frontend sweep: pipeline, context-pipeline, anti-ghosting-pipeline
        (+ their archived toggles) were vulnerable — all fixed. Inspectors,
        layout poll, activity pages already hard-gate on a concrete
        userId / small payloads.
- [x] 3. Fix (protects every user, both ends)
  - [x] Frontend: identity resolution now records how it resolved
        (`matched` / `unmatched` / `legacy`) in
        [use-current-user.ts](artifacts/dashboard/src/hooks/use-current-user.ts);
        all three pipeline pages block the userId-less fetch unless the
        install is legacy single-user, and render a clear "No Gmail account
        connected for <email> — connect it in Settings" card instead of an
        infinite spinner. Settings stays clickable because nothing heavy runs.
  - [x] Backend: new guard
        [listGuards.ts](artifacts/api-server/src/lib/listGuards.ts) — the five
        list endpoints 400 with an explanatory error when called with no
        narrowing param (`userId` / `status` / `email` / `vertical` /
        `replied`) on a multi-user install, whatever the client. Legacy
        installs (empty users table) keep the old unfiltered behavior.
  - [x] Add-on paths preserved: `/api/followups?status=queued` and
        `/api/prospects?replied=0` verified 200. Admin picker unaffected
        (always sends a concrete userId).
- [x] 4. Smoke & regression
  - [x] Typecheck: api-server ✓, dashboard ✓. Dashboard vite build ✓.
  - [x] Tests: 34/34 pass — 8 new guard tests
        ([test-list-guards.ts](artifacts/api-server/src/tests/test-list-guards.ts))
        + gmail-sync-hardening + pipeline-user-picker regression suites.
  - [x] Live local server matrix (dev DB, multi-user): unfiltered
        `/followups`, `/prospects`, `/context/followups`, `/context/prospects`,
        `/anti-ghosting/followups` → **400 in <2ms**; same routes with
        userId/status/replied → 200; `/stats`, `/gmail/accounts` unaffected.
- [ ] 5. Verify in prod after deploy (manual — needs operator)
  - [ ] Re-publish the app (fix is in `artifacts/`, the deployed tree).
  - [ ] Colleague logs in again → should see the "No Gmail account connected"
        card instantly, with Settings working; connecting their Gmail in
        Settings gives them a working pipeline.
  - [ ] Confirm existing users' pipelines load normally.

## Needs operator (external config — cannot be fixed from the repo)

- [ ] **Google Cloud OAuth client**: Authorized redirect URIs must include
      `https://followupper.mobupps.net/api/auth/callback` **and**
      `https://followupper.mobupps.net/api/gmail/callback` (login already
      works, so the first is likely done — the second is what "Connect
      Gmail" in Settings needs, incl. for the affected colleague).
- [ ] **Gmail add-on**: repoint the `BACKEND_URL` Script Property in the
      Apps Script project to `https://followupper.mobupps.net` — otherwise
      every add-on button still targets the dead old domain.
- [ ] Optional: measure prod scale (`select count(*) from followups;`) —
      prod DB probes were permission-blocked in the audit session.

## Recommendations (follow-ups, not in this patch)

- Paginate the /followups list endpoints (or drop `original_body` from list
  payloads and fetch it on demand for the modal) — a single user with a huge
  pipeline still ships megabytes per 30s poll.
- Add `statement_timeout` on the pg pool and an express request timeout —
  today nothing unsticks a wedged query/socket (googleapis has no default
  timeout; in-request LLM pipeline can hold a request for minutes).
- Virtualize the pipeline thread list (no windowing today).
- `source-code/` is a stale, non-deployed duplicate of `artifacts/` (pre-18a83d4
  code). Either delete it or mark it clearly — a fix applied there silently
  never ships.
- Clarify how the dashboard bundle reaches the served `public/` dir — the
  committed build scripts don't wire `artifacts/dashboard/dist/public` into
  the api-server's static dir (deploy likely does it out-of-band).
