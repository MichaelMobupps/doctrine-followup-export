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
];

export async function runStartupMigrations(): Promise<void> {
  try {
    for (const stmt of STATEMENTS) {
      await pool.query(stmt);
    }
    logger.info(
      "B7r/B7u/B9a + bounce/archive migrations applied (followup_usage, users.paused_by_admin, prospects.cycle/parent_prospect_id/pause_reason/bounce_type/paused_at/archived/archived_at, followups.cycle + unique-constraint swap, users.anti_ghosting_label, thread_messages, app_settings, suppressed_addresses, partial indexes)",
    );
  } catch (err) {
    logger.error({ err }, "B9a: startup migration failed (AntiGhosting flow will not function correctly until resolved)");
  }
}
