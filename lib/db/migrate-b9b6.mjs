// Phase 9b.6 — DB migration
//
// Schema deltas:
//   - prospects.gmail_message_id global UQ constraint REMOVED.
//       Blocked the canonical re-engagement case where the same
//       outbound message anchors both a doctrine prospect and an
//       anti_ghosting prospect.
//   - prospects (user_id, gmail_message_id, app) uniqueIndex ADDED.
//       Replacement composite uniqueness. Strictly more permissive
//       than the old global UQ, so no data cleanup is required.
//
// Idempotent + transactional. Re-running is a clean no-op.
//
// Run from project root:  node lib/db/migrate-b9b6.mjs
// Requires DATABASE_URL in env.

import pg from "pg";
const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.error("[fail] DATABASE_URL must be set in env");
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function findGlobalUqOnGmailMessageId(client) {
  const r = await client.query(`
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    JOIN pg_attribute att
      ON att.attrelid = rel.oid AND att.attnum = ANY(con.conkey)
    WHERE rel.relname = 'prospects'
      AND nsp.nspname = current_schema()
      AND con.contype = 'u'
      AND att.attname = 'gmail_message_id'
      AND array_length(con.conkey, 1) = 1
  `);
  return r.rows.map((row) => row.conname);
}

async function indexExists(client, indexName) {
  const r = await client.query(
    `SELECT 1 FROM pg_indexes
       WHERE schemaname = current_schema()
         AND tablename = 'prospects'
         AND indexname = $1`,
    [indexName],
  );
  return r.rowCount > 0;
}

async function main() {
  const client = await pool.connect();
  let changed = 0;
  let skipped = 0;
  try {
    console.log("Starting Phase 9b.6 migration...\n");
    await client.query("BEGIN");

    const uqNames = await findGlobalUqOnGmailMessageId(client);
    if (uqNames.length === 0) {
      console.log("[skip] no global UQ on prospects.gmail_message_id");
      skipped++;
    } else {
      for (const name of uqNames) {
        await client.query(`ALTER TABLE prospects DROP CONSTRAINT "${name}"`);
        console.log(`[ok]   dropped constraint "${name}" from prospects`);
        changed++;
      }
    }

    if (await indexExists(client, "uq_prospects_user_message_app")) {
      console.log("[skip] uq_prospects_user_message_app already exists");
      skipped++;
    } else {
      await client.query(
        `CREATE UNIQUE INDEX uq_prospects_user_message_app
           ON prospects (user_id, gmail_message_id, app)`,
      );
      console.log(
        "[ok]   created uniqueIndex uq_prospects_user_message_app(user_id, gmail_message_id, app)",
      );
      changed++;
    }

    await client.query("COMMIT");
    console.log(`\nMigration complete. Changed: ${changed}, Skipped: ${skipped}`);

    console.log("\n=== Verify ===");
    const stillGlobalUq = await findGlobalUqOnGmailMessageId(client);
    if (stillGlobalUq.length > 0) {
      console.error(`[fail] global UQ still present: ${stillGlobalUq.join(", ")}`);
      process.exit(1);
    }
    console.log("[ok]   no global UQ on prospects.gmail_message_id");

    const compositeOk = await indexExists(client, "uq_prospects_user_message_app");
    if (!compositeOk) {
      console.error("[fail] uq_prospects_user_message_app not found");
      process.exit(1);
    }
    console.log("[ok]   uq_prospects_user_message_app present");

    const allIndexes = await client.query(`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = current_schema() AND tablename = 'prospects'
      ORDER BY indexname
    `);
    console.log("\nAll indexes on prospects:");
    for (const r of allIndexes.rows) {
      console.log(`  ${r.indexname}`);
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
