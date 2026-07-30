// B9b.7 diagnostic — figure out why prospects_app_check still rejects
// anti_ghosting after the migration claimed to fix it.
//
// Looks at:
//   1. Which database+schema this connection talks to (vs api-server's)
//   2. ALL check constraints on prospects (not just by name)
//   3. The actual column type and any domain-level CHECK
//   4. A test INSERT with app='anti_ghosting' (rolled back)
//
// Read-only except for the test INSERT, which runs inside BEGIN/ROLLBACK.

import pg from "pg";
const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.error("[fail] DATABASE_URL not set");
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();

try {
  // 1. DB identity. If api-server connects to a different DB than the shell,
  // we'd expect different host/db here vs what api-server logs report.
  const dbInfo = await client.query(`
    SELECT current_database() AS db,
           current_schema() AS schema,
           inet_server_addr() AS host,
           inet_server_port() AS port
  `);
  const d = dbInfo.rows[0];
  console.log(`=== DB identity ===`);
  console.log(`  database: ${d.db}`);
  console.log(`  schema:   ${d.schema}`);
  console.log(`  host:     ${d.host || "(local/socket)"}`);
  console.log(`  port:     ${d.port || "(n/a)"}`);

  // 2. ALL check constraints on prospects, by structure not by name.
  const checks = await client.query(`
    SELECT con.conname, pg_get_constraintdef(con.oid) AS def
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE rel.relname = 'prospects'
      AND nsp.nspname = current_schema()
      AND con.contype = 'c'
    ORDER BY con.conname
  `);
  console.log(`\n=== Check constraints on prospects (${checks.rowCount}) ===`);
  if (checks.rowCount === 0) {
    console.log(`  (none)`);
  } else {
    for (const r of checks.rows) {
      console.log(`  ${r.conname}`);
      console.log(`    ${r.def}`);
    }
  }

  // 3. Column type — is `app` a DOMAIN with its own CHECK?
  const colInfo = await client.query(`
    SELECT a.attname,
           t.typname,
           t.typtype,
           CASE WHEN t.typtype = 'd' THEN pg_get_constraintdef(dc.oid) END AS domain_check
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_type t ON t.oid = a.atttypid
    LEFT JOIN pg_constraint dc ON dc.contypid = t.oid AND dc.contype = 'c'
    WHERE c.relname = 'prospects'
      AND n.nspname = current_schema()
      AND a.attname = 'app'
  `);
  console.log(`\n=== Column 'app' type info ===`);
  for (const r of colInfo.rows) {
    console.log(`  typname:    ${r.typname}`);
    console.log(`  typtype:    ${r.typtype}  (d=domain, b=base, e=enum)`);
    if (r.domain_check) {
      console.log(`  DOMAIN CHECK: ${r.domain_check}`);
    }
  }

  // 4. Actual test INSERT with app='anti_ghosting' (rolled back).
  // If this succeeds in a transaction, the constraints don't block it,
  // and the failure in production must come from somewhere else.
  console.log(`\n=== Test INSERT with app='anti_ghosting' (rollback) ===`);
  await client.query("BEGIN");
  try {
    const r = await client.query(
      `INSERT INTO prospects (
         user_id, gmail_message_id, gmail_thread_id, email, sent_at, app
       )
       VALUES ($1, $2, $3, $4, NOW(), $5)
       RETURNING id`,
      [2, "diag-msg-b9b7-rollback", "diag-thread-b9b7", "test@example.com", "anti_ghosting"],
    );
    console.log(`  [ok] INSERT succeeded, id=${r.rows[0].id} (will be rolled back)`);
  } catch (e) {
    console.log(`  [FAIL] INSERT failed:`);
    console.log(`    ${e.message}`);
  } finally {
    await client.query("ROLLBACK");
  }

  // 5. Compare-against-error sanity: what does PostgreSQL see when we
  // explicitly cast 'anti_ghosting' through the column type?
  const cast = await client.query(`
    SELECT 'anti_ghosting'::text AS as_text
  `);
  console.log(`\n=== Sanity: 'anti_ghosting' literal ===`);
  console.log(`  ${JSON.stringify(cast.rows[0])}`);
} catch (err) {
  console.error("[fail] diagnostic error:", err);
  process.exit(1);
} finally {
  client.release();
  await pool.end();
}
