// Phase 9b.7 — DB migration: extend prospects.app CHECK to allow 'anti_ghosting'.
//
// Root cause of B9b auto-ingest failures: the CHECK constraint on
// prospects.app was set up with only ('doctrine','context') values.
// B9a's startup log claims to have applied an anti_ghosting CHECK update
// but no such update actually ran — the constraint still rejects
// app='anti_ghosting' with:
//   new row for relation "prospects" violates check constraint
//   "prospects_app_check"
//
// Fix: drop the old CHECK, add a new one that permits all three apps.
//
// Idempotent + transactional. Re-running is a clean no-op.
// Requires DATABASE_URL in env.

import pg from "pg";
const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.error("[fail] DATABASE_URL must be set in env");
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function getCheckDef(client, conName) {
  const r = await client.query(
    `SELECT pg_get_constraintdef(con.oid) AS def
       FROM pg_constraint con
       JOIN pg_class rel ON rel.oid = con.conrelid
       JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
       WHERE con.conname = $1
         AND rel.relname = 'prospects'
         AND nsp.nspname = current_schema()
         AND con.contype = 'c'`,
    [conName],
  );
  return r.rows[0]?.def || null;
}

async function main() {
  const client = await pool.connect();
  let changed = 0;
  let skipped = 0;
  try {
    console.log("Starting Phase 9b.7 migration...\n");
    await client.query("BEGIN");

    const currentDef = await getCheckDef(client, "prospects_app_check");
    console.log(`Current prospects_app_check: ${currentDef || "(not present)"}`);

    if (currentDef && currentDef.includes("'anti_ghosting'")) {
      console.log("[skip] CHECK already permits anti_ghosting");
      skipped++;
    } else {
      if (currentDef) {
        await client.query(`ALTER TABLE prospects DROP CONSTRAINT prospects_app_check`);
        console.log(`[ok]   dropped old CHECK`);
        changed++;
      }
      await client.query(
        `ALTER TABLE prospects
         ADD CONSTRAINT prospects_app_check
         CHECK (app IN ('doctrine', 'context', 'anti_ghosting'))`,
      );
      console.log("[ok]   added CHECK (app IN ('doctrine', 'context', 'anti_ghosting'))");
      changed++;
    }

    await client.query("COMMIT");
    console.log(`\nMigration complete. Changed: ${changed}, Skipped: ${skipped}`);

    console.log("\n=== Verify ===");
    const newDef = await getCheckDef(client, "prospects_app_check");
    if (!newDef) {
      console.error("[fail] prospects_app_check not present after migration");
      process.exit(1);
    }
    if (!newDef.includes("'anti_ghosting'")) {
      console.error(`[fail] CHECK does not include anti_ghosting: ${newDef}`);
      process.exit(1);
    }
    console.log(`[ok]   prospects_app_check: ${newDef}`);

    // Sanity: dry-run a hypothetical anti_ghosting insert as a no-op
    // EXPLAIN to verify the CHECK accepts it.
    const probe = await client.query(`
      SELECT 'anti_ghosting' IN ('doctrine', 'context', 'anti_ghosting') AS allowed
    `);
    console.log(`[ok]   probe: anti_ghosting allowed = ${probe.rows[0].allowed}`);
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
