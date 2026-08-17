-- ===================================================================
-- DIAG-heartbeats-f37c-round2.sql
-- Read-only. 2026-08-17, after the first round's results.
--
-- Round 1 settled the sync tick: 96 of 96 passes are 'partial', none
-- of them from autoQueue or the stranded detector, all of them from
-- per-user auth failures — account 5 on every pass (invalid_grant),
-- and account 3 on 49 of 96 (unauthorized_client) while syncing 32
-- messages in the others. It also found four holes in the fast_tick
-- stream in 48h, each exactly one missed firing (~6 minutes).
--
-- Two questions are left, and each changes what should be done next.
--
--   Q1. Is account 3's failure a WINDOW or a FLAP? nextAuthState()
--       has no hysteresis: one auth failure marks an account dead,
--       one healthy ingest clears it. A contiguous window is one
--       transition. Alternating passes are dozens — and the Chief
--       mails once per transition into auth_dead. (blocks 1, 2, 3)
--   Q2. Were the four holes RESTARTS or LOST WRITES? A restart takes
--       every tick with it; a lost write takes one row. The Aug 16
--       publish landed at 14:53:55Z, inside the 14:51->14:57 hole,
--       so at least that one is a restart. (block 4)
--
-- HOW TO RUN: one numbered block at a time, same as round 1. No
-- block writes anything, and none prints an email address.
-- ===================================================================


-- ── 1. Q1: account 3, hour by hour ────────────────────────────────
-- A contiguous block of failing hours is one dead window. Failures
-- spread evenly across every hour is a flap.

SELECT
  date_trunc('hour', h.fired_at)                  AS hour,
  count(*)                                        AS passes,
  count(*) FILTER (
    WHERE u.value->>'ingestError' IS NOT NULL)    AS failed,
  sum(COALESCE((u.value->>'synced')::int, 0))     AS msgs_synced
FROM cron_heartbeats h
CROSS JOIN LATERAL
  jsonb_array_elements(h.details->'perUser') AS u
WHERE h.tick_name = 'sync_and_autoqueue'
  AND h.fired_at > now() - interval '24 hours'
  AND jsonb_typeof(h.details->'perUser') = 'array'
  AND (u.value->>'userId')::int = 3
GROUP BY 1
ORDER BY 1;


-- ── 2. Q1: how many auth-dead TRANSITIONS, per account ────────────
-- This is the number the Chief turns into mail. Every pass where an
-- account's auth-failure state differs from the pass before it is one
-- transition; `into_dead` is one WARN and a Pushover each, `recovered`
-- is one INFO each.

WITH s AS (
  SELECT
    (u.value->>'userId')::int                     AS user_id,
    h.fired_at,
    (u.value->>'authFailure' = 'true')            AS auth_failed
  FROM cron_heartbeats h
  CROSS JOIN LATERAL
    jsonb_array_elements(h.details->'perUser') AS u
  WHERE h.tick_name = 'sync_and_autoqueue'
    AND h.fired_at > now() - interval '24 hours'
    AND jsonb_typeof(h.details->'perUser') = 'array'
), t AS (
  SELECT
    user_id,
    auth_failed,
    lag(auth_failed) OVER (
      PARTITION BY user_id ORDER BY fired_at) AS prev
  FROM s
)
SELECT
  user_id,
  count(*)                                        AS passes,
  count(*) FILTER (WHERE auth_failed)             AS failing,
  count(*) FILTER (
    WHERE auth_failed AND prev IS FALSE)          AS into_dead,
  count(*) FILTER (
    WHERE NOT auth_failed AND prev IS TRUE)       AS recovered
FROM t
GROUP BY user_id
HAVING count(*) FILTER (WHERE auth_failed) > 0
ORDER BY user_id;


-- ── 3. Q1: where those two accounts stand right now ───────────────
-- No address is selected. `updated_at` is bumped by the auth-dead
-- write, so for a flapping account it is the time of the LAST flip.

SELECT
  id                                              AS user_id,
  is_connected,
  auth_dead_at,
  auth_dead_reason,
  updated_at
FROM users
WHERE id IN (3, 5)
ORDER BY id;


-- ── 4. Q2: every hole, every tick, in time order ──────────────────
-- Thresholds are per-cadence, so a row here is a genuinely missed
-- firing rather than a slow body. Read it for CLUSTERING: several
-- ticks with holes in the same minute is one restart. A single tick
-- alone is a write that was lost.
-- Known anchor: the Aug 16 publish committed at 14:53:55Z.

WITH g AS (
  SELECT
    tick_name,
    fired_at,
    fired_at - lag(fired_at) OVER (
      PARTITION BY tick_name ORDER BY fired_at) AS gap
  FROM cron_heartbeats
  WHERE fired_at > now() - interval '72 hours'
    AND tick_name IN (
      'fast_tick', 'chief_spend_report',
      'process_due', 'sync_and_autoqueue')
)
SELECT
  (fired_at - gap)                                AS hole_started,
  fired_at                                        AS hole_ended,
  tick_name,
  round(extract(epoch FROM gap))                  AS gap_s
FROM g
WHERE (tick_name = 'fast_tick'
         AND gap > interval '5 minutes')
   OR (tick_name = 'chief_spend_report'
         AND gap > interval '8 minutes')
   OR (tick_name IN ('process_due', 'sync_and_autoqueue')
         AND gap > interval '20 minutes')
ORDER BY hole_started;


-- ── 5. What the flapping costs account 3 in delivery ──────────────
-- While an account is marked auth-dead its due follow-ups are held
-- (F-3.6a), so a flap does not lose work — it delays it. This is how
-- much work is waiting behind each of the two accounts.

SELECT
  u.id                                            AS user_id,
  u.auth_dead_at IS NOT NULL                      AS currently_dead,
  count(f.id)                                     AS queued,
  count(f.id) FILTER (
    WHERE f.scheduled_at <= now())                AS due_now,
  min(f.scheduled_at)                             AS oldest_due
FROM users u
JOIN prospects p ON p.user_id = u.id
JOIN followups f ON f.prospect_id = p.id
WHERE u.id IN (3, 5)
  AND f.status = 'queued'
GROUP BY 1, 2
ORDER BY 1;


-- ── 6. Optional: account 3's raw pass-by-pass timeline ────────────
-- 96 rows. Run it only if blocks 1 and 2 disagree, or to see the
-- exact shape of the alternation. The error text is masked as in
-- round 1's block 5.

SELECT
  h.fired_at,
  (u.value->>'ingestError' IS NOT NULL)           AS failed,
  COALESCE((u.value->>'synced')::int, 0)          AS synced,
  left(
    regexp_replace(
      regexp_replace(
        COALESCE(u.value->>'ingestError', ''),
        '(Bearer|Basic|OAuth)\s+\S{8,}',
        '[redacted]', 'gi'),
      '[A-Za-z0-9._~+/=-]{24,}',
      '[redacted]', 'g'),
    60)                                           AS err
FROM cron_heartbeats h
CROSS JOIN LATERAL
  jsonb_array_elements(h.details->'perUser') AS u
WHERE h.tick_name = 'sync_and_autoqueue'
  AND h.fired_at > now() - interval '24 hours'
  AND jsonb_typeof(h.details->'perUser') = 'array'
  AND (u.value->>'userId')::int = 3
ORDER BY h.fired_at;
