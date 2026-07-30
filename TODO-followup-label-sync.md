# TODO — Follow-up engine not syncing Doctrine-labeled emails (2026-07-16)

## Problem statement
- Shama's Gmail (shama@mobupps.com) clearly has emails labeled `Doctrine SDR` (see Gmail UI, Jul 14 sends).
- Email Inspector shows: TOTAL FETCHED 30, DOCTRINE LABELED 0, DETECTED 0, IN DATABASE 0, "+30 thread-only".
- Warning banner: "No emails have doctrine labels — The follow-up engine only picks up emails with doctrine Gmail labels."
- Result: none of her emails from last week synced → no follow-ups queued. MUST auto-sync.

## Plan
- [ ] 1. Locate sync path: cron → gmail sync service → label matching → prospects insert
- [ ] 2. Root-cause why label match fails (hypotheses: labelIds vs label NAMES mismatch;
      Gmail query `label:` needs sanitized name (spaces→hyphens); metadata fetch missing labelIds;
      per-user doctrine_label setting empty/mismatched for shama; thread-only messages skip label check)
- [ ] 3. Fix the bug (auto-sync must work with no manual labeling module)
- [ ] 4. Godlike audit of the whole sync pipeline (blast radius analysis — what else consumes labels?)
- [ ] 5. Smoke tests (static + typecheck + targeted runtime smoke)
- [ ] 6. Auto-fix anything found in audit
- [ ] 7. Verify: re-run sync for shama@mobupps.com, confirm DOCTRINE LABELED > 0 and prospects in DB

## Findings (2026-07-16, investigation session)
- Repo: /home/runner/workspace (pnpm monorepo). API server: artifacts/api-server, sync cron every 15 min.
- Per-user `doctrine label` stored in users table (default 'Doctrine SDR'); legacy env fallback DOCTRINE_LABELS.

### ROOT CAUSE (primary, structural): cron never fires reliably in prod
- `.replit` has `deploymentTarget = "autoscale"` (since ≥April). Replit autoscale scales to zero
  between requests → node-cron `*/15` sync tick only fires if traffic keeps the container warm
  across a :00/:15/:30/:45 boundary. "Automatic" sync is therefore best-effort/rare.
- Evidence fits: Jul 16 17:33–17:42 follow-up sends happened WHILE dashboard was open (fast-tick */3
  fired during warm window), but no sync boundary was crossed; Jul 14 labeled batch (Jellycat,
  Richer Sounds, Dreams, Furniture Village, Skin+Me, Liberty, Wren) never ingested.
- Sync code itself unchanged since Jun 11 (git). Manual POST /api/sync (all-users or per-email) exists.
- Inspector "DOCTRINE LABELED 0" on the 30 recent messages is a UX red herring: those 30 are
  outbound "Re:" follow-ups which never carry the label (Gmail labels don't propagate to new
  thread messages). "+30 thread-only" proves those threads ARE in DB.

### Secondary defects found (fix in hardening pass)
1. gmailSync.syncForUser ingest loop (gmailSync.ts:276-323): NO per-message try/catch.
   One poison message (e.g. invalid Date header → `new Date(msg.date)` Invalid Date → insert throws,
   or transient DB error) aborts the ENTIRE user's sync every tick. Same in syncForLegacyUser.
2. No `invalid_grant` (expired/revoked OAuth token) handling anywhere: sync fails silently forever;
   nothing flips is_connected or surfaces a "reconnect" banner (this exact mode bit murat in March).
3. Inspector banner "No emails have doctrine labels" is misleading (counts reply messages that can
   never carry the label). Also: if configured doctrine_label matches NO label in the mailbox,
   nothing warns loudly (doctrineLabelIds=[] silently).
4. `syncEmails()` iterates users sequentially with try/catch per user — a HANG (no timeouts) on one
   user starves the rest.
5. Empty `doctrine_label` on a user row silently disables ingest (doctrineLabels=[] → fetch skipped,
   "Sync complete synced=0" - no warning).

### CONFIRMED IN PROD (user authorized read-only queries, 2026-07-16)
- shama = user id 7: is_connected=t, has token, doctrine_label='Doctrine SDR' (correct). Sends still
  work (followup sent 2026-07-16 12:38). 105 queued. Ingest: NOTHING since 2026-06-17 10:41.
- Other users ingest fine (murat Jul 16, alberto Jul 16, nino Jul 14) → user-7-specific starvation.
- cron sync_and_autoqueue ticks take 4–6 HOURS each (duration_ms up to 22,086,500) and OVERLAP
  (every 15 min a new one starts). Several fail at the FIRST users query ("Failed query: select ...
  from users" → DB pool exhaustion from overlapping runs). Completed runs report synced=0.
- Mechanism: sequential per-user loop inside a multi-hour pass + container restarts/kills
  (autoscale) + swallowed per-user errors ⇒ users late in iteration (shama) never get ingested;
  per-user errors are logged to stdout only, invisible.

### Fix plan (decided, user approved Reserved VM)
- [x] Root cause confirmed
- [x] F1: fetchLabeledSentEmails skips messages.get for IDs already in DB (knownIds prefetch;
      kills ~95% of Gmail calls) — gmailClient.ts
- [x] F2: per-message try/catch + safeSentAt (invalid Date header → internalDate → now)
- [x] F3: two-phase syncEmails — ingestForUser for ALL users first, handleRepliesForUser after;
      users iterated ORDER BY id (deterministic). syncForUser kept for per-user manual path.
- [x] F4: overlap guard in cron.ts sync tick (skip + heartbeat details.skipped)
- [x] F5: perUser outcomes (synced/ingestError/replyError/authFailure) in heartbeat details;
      isAuthError() flags invalid_grant. Route responses pinned to old shape (no perUser leak)
      in doctrine.ts/context.ts/anti-ghosting.ts POST /sync.
- [x] F6: .replit deploymentTarget autoscale → vm (REQUIRES RE-PUBLISH from Replit UI)
- [x] F7: email-inspector.tsx 3-tier banner (config-error red / replies-only info / original warning)
- [x] Smoke: monorepo typecheck GREEN; new hermetic suite src/tests/test-gmail-sync-hardening.ts
      8/8 PASS; bounce-detection 6/6, reply-classification 27/27, circuit-breaker 5/5 PASS
- [x] Audit round 2 (3 agents: blast radius, double-send risk, adversarial diff review) + fixes:
      - Overlap guard moved INTO syncEmails() (SyncAlreadyRunningError, 409) so route-triggered
        all-users syncs are covered too; 4h wedge watchdog reclaims a hung guard; pass-identity
        token prevents a late-finishing wedged pass from clearing the new pass's guard.
      - ingestForUser returns failed count → PerUserSyncOutcome.ingestFailed → heartbeat marks
        outcome=partial (a 100%-failing mailbox can no longer masquerade as healthy synced=0).
      - scheduler.ts queueStageForProspect revive is now a CAS (status guard in WHERE) — closes
        the one real double-send vector found (revive TOCTOU un-claiming an in-flight row).
      - processTickRunning guard shared by process_due + fast_tick (efficiency; CAS already
        prevented double sends).
      - Banner tier-1 also requires empty contextLabelIds (context-only accounts).
      - context.ts/anti-ghosting.ts sync routes honor err.statusCode (409/404).
      - Verified SAFE by agents: route/addon/OpenAPI response shapes, heartbeat details consumers
        (none exist), knownIds unscoped semantics == old dedup, AG ingest independent of
        fetchLabeledSentEmails, handleRepliesForUser split byte-identical to old reply scan.
- [x] Final verification: typecheck 4/4 Done, api-server esbuild build OK, dashboard vite build OK,
      tests 8/8 + 6/6 + 27/27 + 5/5 pass.

## DEPLOY (manual step required)
1. Re-publish the app from Replit (Deploy). .replit now has deploymentTarget="vm" — confirm the
   deploy UI switches to Reserved VM. Without re-publish NOTHING here reaches prod.
2. After deploy: sync fires within 15 min (cron). Shama's Jul 8–16 'Doctrine SDR' emails are within
   the 60-day window and will ingest. Faster: dashboard → Email Inspector → Sync Now (per-user).
3. Verify: SELECT MAX(created_at) FROM prospects WHERE user_id=7; → must advance past 2026-06-17.
   Check cron_heartbeats details.perUser for shama's row: synced>0, no ingestError.
   First pass after deploy may take a while (backfill); subsequent passes should be minutes.

## Known follow-ups (pre-existing, NOT fixed here — by design)
- AntiGhosting prospects: doctrine reply scan classifies their pre-existing thread inbound as a
  'reply' (pre-existing behavior; my refactor only makes it fire same-pass instead of next tick).
  Needs a dedicated AG-semantics review (exclude app='anti_ghosting' from scan vs rely on revive).
- Pre-claim budget check can softly overshoot hourly caps under concurrency (LOW).
- openapi.yaml SyncResult lacks auto_queued (pre-existing drift; non-strict clients unaffected).
- No googleapis request timeouts anywhere (a hung socket can still stall a pass; wedge watchdog
  now bounds the damage to 4h).
- Reply-scan is still O(unreplied threads) per pass — fine on VM, revisit if user count grows.
