#!/usr/bin/env node
/**
 * Batch 3a — DB migration
 *
 * Schema deltas:
 *   - users.require_approval (boolean)  -> users.followup_mode (text enum, default 'auto_send')
 *       Data migration: require_approval=TRUE  rows -> followup_mode = 'review_in_app'
 *                       require_approval=FALSE rows -> followup_mode = 'auto_send' (the default)
 *   - users.draft_stage_timing (JSONB, new) — separate timing config for draft mode.
 *   - followups.draft_message_id (text, nullable, new) — Gmail draft id to track + delete on manual send.
 *
 * Idempotent: each step checks information_schema before running. Re-running is safe.
 * Transactional: all changes happen in one transaction, rolled back on any error.
 *
 * Run from inside artifacts/api-server (or anywhere pg is resolvable):
 *   node /path/to/migrate-batch3a.mjs
 * Requires DATABASE_URL in env.
 */
import pg from "pg";
const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.error("[fail] DATABASE_URL must be set in env");
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function columnExists(client, table, column) {
  const r = await client.query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`,
    [table, column],
  );
  return r.rowCount > 0;
}

async function constraintExists(client, table, constraintName) {
  const r = await client.query(
    `SELECT 1 FROM information_schema.table_constraints WHERE table_schema = current_schema() AND table_name = $1 AND constraint_name = $2`,
    [table, constraintName],
  );
  return r.rowCount > 0;
}

async function main() {
  const client = await pool.connect();
  let changed = 0;
  let skipped = 0;
  try {
    console.log("Starting Batch 3a migration...\n");
    await client.query("BEGIN");

    const hadFollowupMode    = await columnExists(client, "users", "followup_mode");
    const hadRequireApproval = await columnExists(client, "users", "require_approval");
    const hadDraftStageTiming= await columnExists(client, "users", "draft_stage_timing");
    const hadDraftMessageId  = await columnExists(client, "followups", "draft_message_id");
    const hadModeCheck       = await constraintExists(client, "users", "users_followup_mode_check");

    // Step 1 — Add followup_mode column with default
    if (!hadFollowupMode) {
      await client.query(
        `ALTER TABLE users ADD COLUMN followup_mode TEXT NOT NULL DEFAULT 'auto_send'`,
      );
      console.log("  [ok] users.followup_mode added (default 'auto_send')");
      changed++;
    } else {
      console.log("  [skip] users.followup_mode already exists");
      skipped++;
    }

    // Step 2 — Add CHECK constraint enforcing the enum values
    if (!hadModeCheck) {
      await client.query(
        `ALTER TABLE users ADD CONSTRAINT users_followup_mode_check CHECK (followup_mode IN ('auto_send', 'review_in_app', 'draft_in_gmail'))`,
      );
      console.log("  [ok] CHECK constraint users_followup_mode_check added");
      changed++;
    } else {
      console.log("  [skip] CHECK constraint already exists");
      skipped++;
    }

    // Step 3 — Migrate data from require_approval (only if old col still present)
    if (hadRequireApproval) {
      const result = await client.query(
        `UPDATE users SET followup_mode = 'review_in_app' WHERE require_approval = TRUE AND followup_mode = 'auto_send'`,
      );
      console.log(`  [ok] migrated ${result.rowCount} user(s) with require_approval=TRUE -> followup_mode='review_in_app'`);
      changed++;
    } else {
      console.log("  [skip] require_approval column already gone, no data to migrate");
      skipped++;
    }

    // Step 4 — Drop require_approval
    if (hadRequireApproval) {
      await client.query(`ALTER TABLE users DROP COLUMN require_approval`);
      console.log("  [ok] users.require_approval dropped");
      changed++;
    } else {
      console.log("  [skip] users.require_approval already dropped");
      skipped++;
    }

    // Step 5 — Add draft_stage_timing (JSONB, with sane default)
    if (!hadDraftStageTiming) {
      const defaultDraft = `'[{"minDays":3,"maxDays":7},{"minDays":5,"maxDays":10},{"minDays":7,"maxDays":14}]'::jsonb`;
      await client.query(
        `ALTER TABLE users ADD COLUMN draft_stage_timing JSONB NOT NULL DEFAULT ${defaultDraft}`,
      );
      console.log("  [ok] users.draft_stage_timing added (default 3-stage gap config)");
      changed++;
    } else {
      console.log("  [skip] users.draft_stage_timing already exists");
      skipped++;
    }

    // Step 6 — Add followups.draft_message_id (nullable)
    if (!hadDraftMessageId) {
      await client.query(`ALTER TABLE followups ADD COLUMN draft_message_id TEXT`);
      console.log("  [ok] followups.draft_message_id added (nullable)");
      changed++;
    } else {
      console.log("  [skip] followups.draft_message_id already exists");
      skipped++;
    }

    await client.query("COMMIT");

    // Verify
    const v1 = await columnExists(client, "users", "followup_mode");
    const v2 = await columnExists(client, "users", "require_approval");
    const v3 = await columnExists(client, "users", "draft_stage_timing");
    const v4 = await columnExists(client, "followups", "draft_message_id");
    const v5 = await constraintExists(client, "users", "users_followup_mode_check");

    const checks = [
      [v1,  "users.followup_mode exists"],
      [!v2, "users.require_approval gone"],
      [v3,  "users.draft_stage_timing exists"],
      [v4,  "followups.draft_message_id exists"],
      [v5,  "users_followup_mode_check constraint present"],
    ];

    console.log("\n[verify]");
    let failed = 0;
    for (const [ok, label] of checks) {
      console.log(`  ${ok ? "[ok]" : "[fail]"} ${label}`);
      if (!ok) failed++;
    }

    // Sanity-check the enum distribution
    const dist = await client.query(`SELECT followup_mode, COUNT(*) AS n FROM users GROUP BY followup_mode ORDER BY followup_mode`);
    console.log("\n[users by followup_mode]");
    for (const row of dist.rows) {
      console.log(`  ${row.followup_mode}: ${row.n}`);
    }

    console.log(`\nsummary: ${changed} change(s) applied, ${skipped} skipped (already applied)`);
    if (failed > 0) {
      console.error(`verify: ${failed} check(s) failed`);
      process.exit(1);
    }
    console.log("verify: all checks passed");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("\n[fail] migration rolled back:", err instanceof Error ? err.message : err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
