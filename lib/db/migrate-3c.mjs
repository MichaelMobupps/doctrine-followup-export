#!/usr/bin/env node
/**
 * Phase 3c — DB migration
 *
 * Schema deltas:
 *   - users.has_seen_draft_mode_warning (boolean NOT NULL DEFAULT FALSE, new)
 *       Gate for the one-time mode-switch confirmation modal. Flips TRUE after
 *       the user acknowledges the warning the first time they switch to Draft
 *       mode. Subsequent switches do not re-prompt.
 *
 * Idempotent: each step checks information_schema before running. Re-running
 * is a clean no-op.
 * Transactional: all changes happen in one transaction; rolls back on any error.
 *
 * Run from the project root:
 *   node lib/db/migrate-3c.mjs
 * pg is resolved from lib/db/node_modules/pg, so this script must live in
 * lib/db/ for ESM resolution to work.
 *
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

async function main() {
  const client = await pool.connect();
  let changed = 0;
  let skipped = 0;
  try {
    console.log("Starting Phase 3c migration...\n");
    await client.query("BEGIN");

    // Step 1: users.has_seen_draft_mode_warning
    if (await columnExists(client, "users", "has_seen_draft_mode_warning")) {
      console.log("[skip] users.has_seen_draft_mode_warning already exists");
      skipped++;
    } else {
      await client.query(
        `ALTER TABLE users ADD COLUMN has_seen_draft_mode_warning BOOLEAN NOT NULL DEFAULT FALSE`,
      );
      console.log("[ok]   users.has_seen_draft_mode_warning column added (NOT NULL DEFAULT FALSE)");
      changed++;
    }

    await client.query("COMMIT");
    console.log(`\nMigration complete. Changed: ${changed}, Skipped: ${skipped}`);

    // Verify
    console.log("\n=== Verify ===");
    const verify = await client.query(`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'users'
        AND column_name = 'has_seen_draft_mode_warning'
    `);
    if (verify.rowCount === 0) {
      console.error("[fail] verify could not find users.has_seen_draft_mode_warning");
      process.exit(1);
    }
    const row = verify.rows[0];
    console.log(
      `users.${row.column_name}: type=${row.data_type}, nullable=${row.is_nullable}, default=${row.column_default}`,
    );

    // Sanity: how many users have it set to FALSE (should be ALL existing users)
    const counts = await client.query(`
      SELECT has_seen_draft_mode_warning, COUNT(*)::int AS n
      FROM users
      GROUP BY has_seen_draft_mode_warning
      ORDER BY has_seen_draft_mode_warning
    `);
    console.log("Users by has_seen_draft_mode_warning:");
    if (counts.rowCount === 0) {
      console.log("  (no users)");
    } else {
      for (const r of counts.rows) {
        console.log(`  ${r.has_seen_draft_mode_warning} -> ${r.n}`);
      }
    }
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[fail] migration error:", err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();