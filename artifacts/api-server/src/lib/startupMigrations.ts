// B7r: startup migration for the followup_usage table.
//
// Run once at server boot, BEFORE the cron jobs start so the first
// follow-up generation never races against table creation. Uses raw
// SQL with CREATE TABLE IF NOT EXISTS so re-runs are no-ops.
//
// This is a pragmatic choice. The "proper" Drizzle Kit migration
// flow (drizzle-kit generate + drizzle-kit migrate) requires a
// developer to run two commands; doing it at server start removes
// that gap and keeps deploy-time work down to "build + restart".
//
// If the migration fails, we log loudly but DO NOT crash the boot
// process. The activity-log feature degrades to "no new rows
// captured" until the table comes up; the rest of the app works.

import { pool } from "@workspace/db";
import { logger } from "./logger";

const STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS followup_usage (
    id SERIAL PRIMARY KEY,
    followup_id INTEGER,
    prospect_id INTEGER,
    user_id INTEGER,
    app TEXT NOT NULL,
    stage INTEGER NOT NULL,
    label TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    web_searches INTEGER NOT NULL DEFAULT 0,
    cost_usd NUMERIC(12, 6) NOT NULL DEFAULT 0,
    generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_followup_usage_user ON followup_usage(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_followup_usage_followup ON followup_usage(followup_id)`,
  `CREATE INDEX IF NOT EXISTS idx_followup_usage_prospect ON followup_usage(prospect_id)`,
  `CREATE INDEX IF NOT EXISTS idx_followup_usage_generated_at ON followup_usage(generated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_followup_usage_app ON followup_usage(app)`,
  // B7u: users.paused_by_admin migration. ALTER TABLE ADD COLUMN IF
  // NOT EXISTS is idempotent — safe to re-run on every boot.
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS paused_by_admin BOOLEAN NOT NULL DEFAULT false`,

  // ──────────────────────────────────────────────────────────────────
  // B9a: AntiGhosting Followuper schema migrations.
  //
  // All statements below are idempotent (IF NOT EXISTS on columns,
  // CREATE TABLE IF NOT EXISTS on the new table, DO blocks that check
  // pg_constraint before adding constraints). Re-running on every boot
  // is a no-op after the first successful application.
  // ──────────────────────────────────────────────────────────────────

  // prospects.cycle — renewal-generation counter. Existing rows default
  // to 1 (their first and only cycle). Reengagement-app rows increment
  // on operator-initiated renewals.
  `ALTER TABLE prospects ADD COLUMN IF NOT EXISTS cycle INTEGER NOT NULL DEFAULT 1`,

  // prospects.parent_prospect_id — self-reference for AntiGhosting
  // prospects that originated from a doctrine/context campaign. Nullable.
  // The FK constraint is added separately because Postgres does not
  // accept IF NOT EXISTS on ADD CONSTRAINT; the DO block checks
  // pg_constraint by name first.
  `ALTER TABLE prospects ADD COLUMN IF NOT EXISTS parent_prospect_id INTEGER`,
  `DO $$
   BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint WHERE conname = 'fk_prospects_parent_prospect'
     ) THEN
       ALTER TABLE prospects
         ADD CONSTRAINT fk_prospects_parent_prospect
         FOREIGN KEY (parent_prospect_id) REFERENCES prospects(id);
     END IF;
   END $$`,

  // prospects.pause_reason — WHY a prospect is paused. Nullable. Only
  // populated when followup_paused = true; null for doctrine/context
  // prospects which only need the boolean.
  `ALTER TABLE prospects ADD COLUMN IF NOT EXISTS pause_reason TEXT`,

  // Dispatcher hot-path covering index (app, replied, followup_paused).
  // The cron scheduler scans this triple every cycle to find prospects
  // due for a follow-up. With three apps now, a single composite index
  // prevents three full table scans per cron tick.
  `CREATE INDEX IF NOT EXISTS idx_prospects_app_replied_paused
     ON prospects(app, replied, followup_paused)`,

  // Parent lookups: analytics view "all reengagements derived from
  // prospect X".
  `CREATE INDEX IF NOT EXISTS idx_prospects_parent
     ON prospects(parent_prospect_id)`,

  // followups.cycle — mirrors prospects.cycle. Together with
  // (prospect_id, stage) forms the new unique constraint.
  `ALTER TABLE followups ADD COLUMN IF NOT EXISTS cycle INTEGER NOT NULL DEFAULT 1`,

  // Swap the unique constraint on followups from (prospect_id, stage)
  // to (prospect_id, cycle, stage) so renewed AntiGhosting campaigns
  // can re-use stage numbers 1..N under a new cycle without colliding
  // with the previous cycle's rows.
  //
  // Wrapped in a DO block so the drop is conditional (re-runs of this
  // migration after the new constraint already exists must not error).
  `DO $$
   BEGIN
     IF EXISTS (
       SELECT 1 FROM pg_constraint WHERE conname = 'uq_followups_prospect_stage'
     ) THEN
       ALTER TABLE followups DROP CONSTRAINT uq_followups_prospect_stage;
     END IF;
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint WHERE conname = 'uq_followups_prospect_cycle_stage'
     ) THEN
       ALTER TABLE followups
         ADD CONSTRAINT uq_followups_prospect_cycle_stage
         UNIQUE (prospect_id, cycle, stage);
     END IF;
   END $$`,

  // users.anti_ghosting_label — Gmail label users apply to seed threads
  // to mark them for AntiGhosting Followuper. Mirrors the existing
  // doctrine_label / context_label columns. Default is the canonical
  // product name; users can rename it per their workspace conventions.
  `ALTER TABLE users
     ADD COLUMN IF NOT EXISTS anti_ghosting_label TEXT NOT NULL
     DEFAULT 'AntiGhosting Followuper'`,

  // thread_messages: normalised Gmail thread history. The AntiGhosting
  // generator reads this table chronologically to compose follow-ups
  // that reference the full prior conversation.
  `CREATE TABLE IF NOT EXISTS thread_messages (
    id SERIAL PRIMARY KEY,
    prospect_id INTEGER NOT NULL REFERENCES prospects(id),
    gmail_message_id TEXT NOT NULL UNIQUE,
    gmail_thread_id TEXT NOT NULL,
    direction TEXT NOT NULL,
    sent_at TIMESTAMPTZ NOT NULL,
    from_email TEXT NOT NULL DEFAULT '',
    subject TEXT NOT NULL DEFAULT '',
    snippet TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_thread_messages_prospect_sent
     ON thread_messages(prospect_id, sent_at)`,
  `CREATE INDEX IF NOT EXISTS idx_thread_messages_thread
     ON thread_messages(gmail_thread_id)`,

  // ──────────────────────────────────────────────────────────────────
  // Bounce auto-pause + archival + global pause migrations.
  //
  // All idempotent (ADD COLUMN IF NOT EXISTS, CREATE ... IF NOT EXISTS).
  // ──────────────────────────────────────────────────────────────────

  // prospects.bounce_type — 'hard' | 'soft' | null. Set when a delivery
  // failure auto-pauses the campaign (pause_reason = 'bounced').
  `ALTER TABLE prospects ADD COLUMN IF NOT EXISTS bounce_type TEXT`,

  // prospects.paused_at — when followup_paused last flipped true. Drives the
  // 14-day archival clock.
  `ALTER TABLE prospects ADD COLUMN IF NOT EXISTS paused_at TIMESTAMPTZ`,

  // prospects.archived / archived_at — soft removal after 14 days paused.
  `ALTER TABLE prospects ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE prospects ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ`,

  // Backfill paused_at for rows already paused before this column existed.
  // Use replied_at when available (accurate for reply-paused rows); otherwise
  // start the clock at NOW() so existing paused campaigns get a fresh 14-day
  // window instead of being archived on the first sweep.
  `UPDATE prospects
     SET paused_at = COALESCE(replied_at, NOW())
     WHERE followup_paused = true AND paused_at IS NULL`,

  // Archival sweep hot path (partial index over the live paused set).
  `CREATE INDEX IF NOT EXISTS idx_prospects_archive_sweep
     ON prospects(paused_at)
     WHERE followup_paused = true AND archived = false`,

  // Active-set dispatcher index (partial over non-archived rows).
  `CREATE INDEX IF NOT EXISTS idx_prospects_active_dispatch
     ON prospects(app, sent_at)
     WHERE archived = false`,

  // Global app settings (key/value). Holds the global_pause switch.
  `CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  // Global address suppression list. A suppressed email is never sent to by
  // any user in any subproduct. Hard bounces add rows automatically.
  `CREATE TABLE IF NOT EXISTS suppressed_addresses (
    id SERIAL PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    reason TEXT NOT NULL,
    source TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_suppressed_email ON suppressed_addresses(email)`,

  // ──────────────────────────────────────────────────────────────────
  // Company-Reply Cascade migrations.
  //
  // When one contact at a company replies positively, recent sibling
  // campaigns to colleagues at the same company are paused. All idempotent
  // (ADD COLUMN IF NOT EXISTS, DO-block FK guard, partial index IF NOT
  // EXISTS). The pause_reason value 'company_reply_cascade' needs no DDL —
  // pause_reason is a plain TEXT column with no CHECK constraint.
  // ──────────────────────────────────────────────────────────────────

  // prospects.reply_class — audit of how the latest inbound reply was
  // classified: positive | negative | ooo | unsubscribe | unknown. Nullable.
  `ALTER TABLE prospects ADD COLUMN IF NOT EXISTS reply_class TEXT`,

  // prospects.cascade_paused_by_prospect_id — self-reference: a sibling that
  // the cascade paused points at the prospect whose positive reply paused it.
  // Powers the blast-radius audit and the exact-set undo. Nullable. The FK is
  // added in a DO block because Postgres rejects IF NOT EXISTS on ADD
  // CONSTRAINT; the block checks pg_constraint by name first.
  `ALTER TABLE prospects ADD COLUMN IF NOT EXISTS cascade_paused_by_prospect_id INTEGER`,
  `DO $$
   BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint WHERE conname = 'fk_prospects_cascade_trigger'
     ) THEN
       ALTER TABLE prospects
         ADD CONSTRAINT fk_prospects_cascade_trigger
         FOREIGN KEY (cascade_paused_by_prospect_id) REFERENCES prospects(id);
     END IF;
   END $$`,

  // prospects.reply_classified_msg_id — Gmail message id behind the current
  // reply_class. Cost guard: skip re-running the LLM classifier on an
  // unchanged out-of-office auto-reply. Nullable.
  `ALTER TABLE prospects ADD COLUMN IF NOT EXISTS reply_classified_msg_id TEXT`,

  // Blast-radius audit self-join + undo-by-trigger lookups. Partial index
  // over the cascade-paused set keeps it small.
  `CREATE INDEX IF NOT EXISTS idx_prospects_cascade_trigger
     ON prospects(cascade_paused_by_prospect_id)
     WHERE cascade_paused_by_prospect_id IS NOT NULL`,

  // ──────────────────────────────────────────────────────────────────
  // CSD v1: Company-Shared Drafts migrations.
  //
  // One generated follow-up draft is shared across every contact in a
  // company cohort (same user, app, normalized company, ORIGINAL THREAD
  // LANGUAGE, stage, cycle, campaign context hash, history hash) instead
  // of running the 3-7-call LLM pipeline once per contact. Idempotent:
  // CREATE TABLE / INDEX IF NOT EXISTS, re-run on every boot is a no-op.
  // ──────────────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS company_shared_drafts (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    app TEXT NOT NULL,
    company_key TEXT NOT NULL,
    language TEXT NOT NULL,
    stage INTEGER NOT NULL,
    cycle INTEGER NOT NULL DEFAULT 1,
    context_hash TEXT NOT NULL,
    history_hash TEXT NOT NULL,
    generated_subject TEXT NOT NULL,
    generated_body TEXT NOT NULL,
    source_prospect_id INTEGER,
    source_followup_id INTEGER,
    reuse_count INTEGER NOT NULL DEFAULT 0,
    last_reused_at TIMESTAMPTZ,
    generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_company_shared_drafts_cohort
     ON company_shared_drafts(user_id, app, company_key, language, stage, cycle, context_hash, history_hash)`,
  `CREATE INDEX IF NOT EXISTS idx_company_shared_drafts_generated
     ON company_shared_drafts(generated_at)`,

  // ──────────────────────────────────────────────────────────────────
  // Data cleanup: clamp stored users.max_followups into the rigid range.
  //
  // The rigid cap is 3 (HARD_FOLLOWUP_CAP) and "unlimited" (stored as 0) was
  // retired product-wide. The scheduler and the dashboard already clamp at
  // read time, so stale values were harmless, but this makes the stored data
  // match reality: any value above 3, or below 1 (the legacy 0/unlimited),
  // becomes 3. NOT NULL column, so no NULL handling is needed. Idempotent:
  // after the first run no rows match.
  // ──────────────────────────────────────────────────────────────────
  `UPDATE users SET max_followups = 3 WHERE max_followups > 3 OR max_followups < 1`,

  // ──────────────────────────────────────────────────────────────────
  // F-3.6a: truth and flow.
  //
  // Six statements, every one additive and either nullable or defaulted, so
  // a code rollback needs no schema rollback — the previous build simply
  // stops reading columns it never knew about. Same property B7u's
  // paused_by_admin has had since it shipped.
  // ──────────────────────────────────────────────────────────────────

  // users.auth_dead_at / auth_dead_reason — the auth-dead state, distinct
  // from is_connected. NULL = healthy. See schema/users.ts for why this is
  // not a disconnect.
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_dead_at TIMESTAMPTZ`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_dead_reason TEXT`,
  // Read on every due-query pass. Deliberately a PLAIN index, byte-for-byte
  // matching the declaration in lib/db/src/schema/users.ts. A partial index
  // here (WHERE auth_dead_at IS NOT NULL) would be marginally tidier and
  // would also make drizzle-kit diff it as undeclared and churn a
  // DROP/CREATE on every Republish — the exact trap cron-heartbeats.ts
  // records having been caught by. On a fifteen-row table the difference is
  // nil; the churn is not.
  `CREATE INDEX IF NOT EXISTS idx_users_auth_dead ON users(auth_dead_at)`,

  // followups.retry_count / failure_reason / error_history — bounded retry
  // policy replacing the 15-minute amnesia revive. Existing rows start at
  // retry_count 0, which is correct: none of them has been retried under a
  // policy, and the two July DB-error rows of user 8 stay exactly where they
  // are (their owner is admin-paused, so no auto-queue pass reaches them).
  `ALTER TABLE followups ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE followups ADD COLUMN IF NOT EXISTS failure_reason TEXT`,
  `ALTER TABLE followups ADD COLUMN IF NOT EXISTS error_history JSONB`,

  // ──────────────────────────────────────────────────────────────────
  // F-3.6b: cron_heartbeats moves into the startup migration.
  //
  // Every other table the server depends on is created here; this one was
  // created by `drizzle-kit push` alone because it predates this file. It
  // exists in dev and production, so nothing has ever noticed — but a
  // database brought up by boot alone would not have it and
  // GET /api/admin/cron-heartbeats, the F-3.6a liveness surface, would 500
  // on the one occasion an operator most needs it.
  //
  // F-3.6a declined to add it, on the grounds that a second definition of a
  // table `push` already owns is how index churn starts. That risk is real
  // and it is answered by matching the LIVE shape exactly rather than by
  // staying out: the statements below were written from a read-only
  // information_schema / pg_indexes dump of BOTH databases on 2026-08-10, so
  // a fresh database lands on a byte-identical table and there is nothing for
  // a diff to churn. Note `fired_at DESC` — the real index carries it and the
  // drizzle declaration in lib/db/src/schema/cron-heartbeats.ts does not.
  // The declaration is deliberately left alone: it describes what both
  // databases already have closely enough that the publish diff is empty
  // today, and rewriting it to chase the sort direction would risk exactly
  // the churn this comment is about. Recorded in TODO Open items instead.
  //
  // IF NOT EXISTS on both, so on dev and production this is a no-op.
  // ──────────────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS cron_heartbeats (
    id SERIAL PRIMARY KEY,
    tick_name TEXT NOT NULL,
    fired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    outcome TEXT NOT NULL,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    details JSONB
  )`,
  `CREATE INDEX IF NOT EXISTS idx_cron_heartbeats_tick_fired_at
     ON cron_heartbeats(tick_name, fired_at DESC)`,

  // ──────────────────────────────────────────────────────────────────
  // F-3.7a: the Chief spend cursor.
  //
  // One row per (UTC day, vendor) recording the running total this app has
  // had ACCEPTED by the Chief, in whole cents. See
  // lib/db/src/schema/chief-spend-cursor.ts for why it is a dollar total
  // rather than a chunk count, and lib/chiefSpend.ts for how it makes a
  // retry safe against the Chief's first-write-wins dedupe.
  //
  // Created unconditionally, not only when CHIEF_URL / CHIEF_INGEST_TOKEN
  // are set. The reporter itself is fully inert while they are unset — it
  // opens no socket and writes no row — but a table that only appears once
  // a secret is set is a table whose first use races its own creation, and
  // it would make the publish plan depend on which secrets happened to be
  // present at boot. An empty four-column table costs nothing.
  //
  // The PRIMARY KEY constraint is NAMED explicitly. Postgres would call it
  // `chief_spend_cursor_pkey` and drizzle-kit calls the same thing
  // `chief_spend_cursor_day_key_vendor_pk`; a mismatch is precisely the
  // shape of diff churn cron-heartbeats.ts records being bitten by. Both
  // sides now spell it out, identically.
  //
  // IF NOT EXISTS, so re-running on every boot is a no-op.
  // ──────────────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS chief_spend_cursor (
    day_key TEXT NOT NULL,
    vendor TEXT NOT NULL,
    reported_cents INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chief_spend_cursor_day_key_vendor_pk PRIMARY KEY (day_key, vendor)
  )`,
];

export async function runStartupMigrations(): Promise<void> {
  try {
    for (const stmt of STATEMENTS) {
      await pool.query(stmt);
    }
    logger.info(
      "B7r/B7u/B9a + bounce/archive + company-cascade + F-3.6a + F-3.6b + F-3.7a migrations applied (followup_usage, users.paused_by_admin, prospects.cycle/parent_prospect_id/pause_reason/bounce_type/paused_at/archived/archived_at/reply_class/cascade_paused_by_prospect_id/reply_classified_msg_id, followups.cycle + unique-constraint swap, users.anti_ghosting_label, thread_messages, app_settings, suppressed_addresses, users.auth_dead_at/auth_dead_reason, followups.retry_count/failure_reason/error_history, cron_heartbeats, chief_spend_cursor, partial indexes)",
    );
  } catch (err) {
    logger.error({ err }, "B9a: startup migration failed (AntiGhosting flow will not function correctly until resolved)");
  }
}
