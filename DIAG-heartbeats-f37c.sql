-- ===================================================================
-- DIAG-heartbeats-f37c.sql
-- Read-only diagnosis of cron_heartbeats. 2026-08-17.
--
-- Purpose: settle two questions the Chief's read-only probe could
-- not close from outside this database.
--   Q1. What do sync_and_autoqueue's 96-of-96 non-ok outcomes
--       actually carry? (blocks 3, 4, 5, 12)
--   Q2. Does the heartbeat stream have HOLES — firings that left
--       no row? A hole is the only thing that can make the
--       Chief's age_seconds spike while ticks_24h stays full.
--       (blocks 6, 7, 8)
--
-- HOW TO RUN: one numbered block at a time. Every block is a
-- single SELECT. Nothing here writes, locks or drops anything.
--
-- SAFETY NOTE on the details column: it is stored RAW. The
-- redactor (redactHeartbeatDetails) runs at READ time in the
-- admin route, not at write time, so a serialised googleapis
-- error in there can contain "Authorization: Bearer ya29...".
-- Block 5 masks those patterns in SQL before printing, and no
-- block prints a whole details payload or an email address.
-- ===================================================================


-- ── 1. Clock check ─────────────────────────────────────────────────
-- Compare db_now against the app's own server_time from
-- GET /api/chief/status. age_seconds on that endpoint is computed
-- from the APP clock while ticks_24h is computed from THIS clock.
-- They should agree to within a second or two.

SELECT
  now()                       AS db_now,
  current_setting('TimeZone') AS db_timezone;


-- ── 2. Per-tick rollup, 24h, entirely on the database clock ────────
-- The same figures the Chief seam reports, plus the outcome split
-- it folds together (errors_24h counts outcome <> 'ok', so
-- 'partial' and 'error' arrive as one number).

SELECT
  tick_name,
  count(*)                                       AS ticks_24h,
  count(*) FILTER (WHERE outcome = 'ok')         AS ok,
  count(*) FILTER (WHERE outcome = 'partial')    AS partial,
  count(*) FILTER (WHERE outcome = 'error')      AS error,
  max(fired_at)                                  AS last_row_at,
  round(extract(epoch FROM (now() - max(fired_at))))
                                                 AS age_s_db,
  round(avg(duration_ms))                        AS avg_ms,
  max(duration_ms)                               AS max_ms
FROM cron_heartbeats
WHERE fired_at > now() - interval '24 hours'
GROUP BY tick_name
ORDER BY tick_name;


-- ── 3. Q1: which failure field the sync tick sets ─────────────────
-- 'partial' comes from per-user sync failures, autoQueue, or the
-- stranded detector. 'error' only from noConnectedAccounts or a
-- wrapper throw. This says which one, per outcome.

SELECT
  outcome,
  count(*)                                        AS rows_24h,
  count(*) FILTER (
    WHERE jsonb_exists(details, 'syncError'))     AS sync_err,
  count(*) FILTER (
    WHERE jsonb_exists(details, 'autoQueueError'))
                                                  AS autoq_err,
  count(*) FILTER (
    WHERE jsonb_exists(details, 'strandedDetectorError'))
                                                  AS strand_err,
  count(*) FILTER (
    WHERE jsonb_exists(details, 'noConnectedAccounts'))
                                                  AS no_accts,
  count(*) FILTER (
    WHERE jsonb_exists(details, 'wrapperError'))  AS wrapper,
  count(*) FILTER (
    WHERE jsonb_exists(details, 'skipped'))       AS skipped
FROM cron_heartbeats
WHERE tick_name = 'sync_and_autoqueue'
  AND fired_at > now() - interval '24 hours'
GROUP BY outcome
ORDER BY outcome;


-- ── 4. Q1: which ACCOUNT fails, per pass ──────────────────────────
-- Reads the per-user outcomes inside details.perUser. Selects
-- user_id only — the addresses in that array are not printed.
-- A row with passes = ingest_err = 96 is a mailbox failing on
-- every single pass.

SELECT
  (u.value->>'userId')::int                       AS user_id,
  count(*)                                        AS passes,
  count(*) FILTER (
    WHERE u.value->>'ingestError' IS NOT NULL)    AS ingest_err,
  count(*) FILTER (
    WHERE u.value->>'replyError' IS NOT NULL)     AS reply_err,
  count(*) FILTER (
    WHERE u.value->>'authFailure' = 'true')       AS auth_fail,
  sum(COALESCE((u.value->>'ingestFailed')::int, 0))
                                                  AS msgs_failed,
  sum(COALESCE((u.value->>'synced')::int, 0))     AS msgs_synced
FROM cron_heartbeats h
CROSS JOIN LATERAL
  jsonb_array_elements(h.details->'perUser') AS u
WHERE h.tick_name = 'sync_and_autoqueue'
  AND h.fired_at > now() - interval '24 hours'
  AND jsonb_typeof(h.details->'perUser') = 'array'
GROUP BY 1
ORDER BY 1;


-- ── 5. Q1: the failure text itself, masked ────────────────────────
-- Distinct per-user ingest errors, grouped. Any "Bearer <token>"
-- and any 24+ character token-shaped run is replaced before the
-- text is printed, then it is cut to 160 characters.

SELECT
  count(*)                                        AS occurrences,
  left(
    regexp_replace(
      regexp_replace(
        u.value->>'ingestError',
        '(Bearer|Basic|OAuth)\s+\S{8,}',
        '[redacted]', 'gi'),
      '[A-Za-z0-9._~+/=-]{24,}',
      '[redacted]', 'g'),
    160)                                          AS ingest_error
FROM cron_heartbeats h
CROSS JOIN LATERAL
  jsonb_array_elements(h.details->'perUser') AS u
WHERE h.tick_name = 'sync_and_autoqueue'
  AND h.fired_at > now() - interval '24 hours'
  AND jsonb_typeof(h.details->'perUser') = 'array'
  AND u.value->>'ingestError' IS NOT NULL
GROUP BY 2
ORDER BY 1 DESC
LIMIT 20;


-- ── 6. Q2: holes in the fast_tick stream ──────────────────────────
-- fast_tick fires every 3 minutes and, since F-3.7b, writes a row
-- even when the overlap guard stops it. So any gap much over 3
-- minutes is a firing that left NO row: a swallowed write
-- (recordHeartbeat logs and returns), or a process that was not
-- running. Each such gap is a false "cron stale" window.
-- 72 hours, so it covers the days the alert mails came from.

WITH s AS (
  SELECT
    fired_at,
    fired_at - lag(fired_at) OVER (ORDER BY fired_at) AS gap
  FROM cron_heartbeats
  WHERE tick_name = 'fast_tick'
    AND fired_at > now() - interval '72 hours'
)
SELECT
  fired_at                            AS row_landed_at,
  round(extract(epoch FROM gap))      AS gap_seconds
FROM s
WHERE gap > interval '4 minutes'
ORDER BY gap DESC
LIMIT 40;


-- ── 7. Q2: the same test for every tick ───────────────────────────
-- max_gap_s well above a tick's cadence is the same defect on
-- that tick. Cadences: fast_tick 180, chief_spend_report 300,
-- process_due 900, sync_and_autoqueue 900, the daily sweeps 86400.

WITH s AS (
  SELECT
    tick_name,
    fired_at - lag(fired_at) OVER (
      PARTITION BY tick_name ORDER BY fired_at) AS gap
  FROM cron_heartbeats
  WHERE fired_at > now() - interval '72 hours'
)
SELECT
  tick_name,
  count(*)                            AS rows_72h,
  round(extract(epoch FROM max(gap))) AS max_gap_s,
  round(extract(epoch FROM avg(gap))) AS avg_gap_s
FROM s
WHERE gap IS NOT NULL
GROUP BY tick_name
ORDER BY tick_name;


-- ── 8. Q2: fast_tick firings per hour ─────────────────────────────
-- Expect exactly 20 rows in every full hour. Any hour under 20
-- lost firings; that hour is where a flap mail came from.

SELECT
  date_trunc('hour', fired_at)         AS hour,
  count(*)                             AS rows_in_hour,
  20 - count(*)                        AS missing
FROM cron_heartbeats
WHERE tick_name = 'fast_tick'
  AND fired_at > now() - interval '48 hours'
GROUP BY 1
ORDER BY 1;


-- ── 9. How often the overlap guard actually bit ───────────────────
-- skipped = the F-3.7b recorded skip. wedge = a pass reclaimed by
-- the 10-minute no-progress watchdog. Both are healthy signals;
-- this is here to size them, not to alarm on them.

SELECT
  tick_name,
  count(*)                                       AS rows_24h,
  count(*) FILTER (
    WHERE jsonb_exists(details, 'skipped'))      AS skipped,
  count(*) FILTER (
    WHERE jsonb_exists(details, 'wedgeReclaimedAfterMs'))
                                                 AS wedge
FROM cron_heartbeats
WHERE fired_at > now() - interval '24 hours'
  AND tick_name IN (
    'fast_tick', 'process_due', 'sync_and_autoqueue')
GROUP BY tick_name
ORDER BY tick_name;


-- ── 10. Work frozen behind a dead grant ───────────────────────────
-- The operational cost of the auth-dead account: follow-ups that
-- are queued and can go nowhere until it reconnects.

SELECT
  u.id                                 AS user_id,
  u.auth_dead_at::date                 AS dead_since,
  u.auth_dead_reason                   AS reason,
  count(f.id)                          AS queued_followups,
  min(f.scheduled_at)                  AS oldest_due,
  max(f.scheduled_at)                  AS newest_due
FROM users u
JOIN prospects p ON p.user_id = u.id
JOIN followups f ON f.prospect_id = p.id
WHERE u.auth_dead_at IS NOT NULL
  AND f.status = 'queued'
GROUP BY 1, 2, 3
ORDER BY 1;


-- ── 11. Ticks that outran their own cadence ───────────────────────
-- duration_ms is measured from the firing to the row being
-- written, so this also says how far fired_at (stamped at
-- COMPLETION) sits from the moment the tick actually fired.

WITH cadence(tick_name, secs) AS (
  VALUES
    ('fast_tick',           180),
    ('chief_spend_report',  300),
    ('process_due',         900),
    ('sync_and_autoqueue',  900)
)
SELECT
  h.tick_name,
  c.secs                               AS cadence_s,
  count(*)                             AS rows_24h,
  count(*) FILTER (
    WHERE h.duration_ms > c.secs * 1000)
                                       AS overran_cadence,
  round(avg(h.duration_ms))            AS avg_ms,
  max(h.duration_ms)                   AS max_ms
FROM cron_heartbeats h
JOIN cadence c ON c.tick_name = h.tick_name
WHERE h.fired_at > now() - interval '24 hours'
GROUP BY h.tick_name, c.secs
ORDER BY h.tick_name;


-- ── 12. The last 15 sync passes, as a timeline ────────────────────
-- One line per pass: when its row landed, how long it ran, what
-- it recorded. Read with block 4: same defect, different view.

SELECT
  fired_at                             AS row_landed_at,
  outcome,
  duration_ms,
  (details->>'synced')::int            AS synced,
  (details->>'repliesDetected')::int   AS replies,
  (details->>'autoQueued')::int        AS auto_queued,
  (details->>'strandedGenerating')::int
                                       AS stranded,
  jsonb_array_length(
    COALESCE(details->'perUser', '[]'::jsonb))
                                       AS users_in_pass
FROM cron_heartbeats
WHERE tick_name = 'sync_and_autoqueue'
  AND fired_at > now() - interval '6 hours'
ORDER BY fired_at DESC
LIMIT 15;
