/**
 * run-migrations-guarded.ts — run `runStartupMigrations()` and nothing else.
 *
 * No server boot, no cron, no sync, no sends: importing this file imports the
 * migration module and the db pool, and calls one function.
 *
 * Guards, checked before anything is imported:
 *   - DATABASE_URL must be set and must NOT equal PROD_DATABASE_URL
 *   - the database name must contain "smoke" or "test", unless
 *     ALLOW_DEV=1 is set AND the URL contains "helium" (the scope-6
 *     dev-alignment case, which is deliberate and separately authorised)
 *
 *   DATABASE_URL=postgresql://…/f36b_smoke_base \
 *     pnpm --filter @workspace/api-server exec tsx src/scripts/run-migrations-guarded.ts
 */

export {};

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("REFUSING: DATABASE_URL unset");
  process.exit(1);
}
if (process.env.PROD_DATABASE_URL && url === process.env.PROD_DATABASE_URL) {
  console.error("REFUSING: DATABASE_URL is PROD_DATABASE_URL");
  process.exit(1);
}
const dbName = new URL(url).pathname.slice(1);
const isSmoke = /smoke|test/.test(dbName);
const isAuthorisedDev = process.env.ALLOW_DEV === "1" && /helium/.test(url);
if (!isSmoke && !isAuthorisedDev) {
  console.error(`REFUSING: ${JSON.stringify(dbName)} is neither a smoke/test database nor an authorised dev run`);
  process.exit(1);
}

const { runStartupMigrations } = await import("../lib/startupMigrations");
const { pool } = await import("@workspace/db");

await runStartupMigrations();
console.log(`migrations applied to ${dbName}`);
await pool.end();
