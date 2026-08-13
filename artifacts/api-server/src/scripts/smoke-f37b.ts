/**
 * smoke-f37b.ts — F-3.7b live smoke, against an ISOLATED database.
 *
 * The hermetic suite (tests/test-f37b-honest-tick.ts) proves the decisions:
 * the guard reclaims a wedge, the budget cuts a hung generation, a Google call
 * that never answers is cut, a poisoned row fails alone. What it cannot prove
 * is the one thing this order exists for, because that property is a ROW IN A
 * TABLE: when a pass is running, does the fast_tick heartbeat stream keep
 * advancing?
 *
 * That is the whole false-death-report bug. `max(fired_at)` per tick is the
 * Chief's liveness signal (F-3.7a), the alarm reads it, and before this order a
 * guarded fast_tick wrote nothing at all — so the figure aged while the tick
 * fired perfectly on schedule. This smoke runs the REAL exported tick body
 * against a REAL Postgres and watches the figure move.
 *
 * ── VENDORS ARE MADE IMPOSSIBLE, NOT MERELY UNLIKELY ──────────────────────
 *
 * `http.request`, `https.request`, `http.get`, `https.get` and `globalThis.fetch`
 * are replaced with throwers BEFORE any application module is loaded. Postgres
 * speaks over `net`/`tls` and is unaffected. Any outbound call — Gmail,
 * Anthropic, Gemini — becomes a loud, attributable exception rather than a
 * request, and the count is asserted to be zero at the end.
 *
 * NOTHING HERE SENDS EMAIL. The database is empty of prospects, so the one pass
 * that runs for real has no row to generate for and no address to send to, and
 * the transport is dead regardless.
 *
 * ── USAGE — never point this at dev or production ─────────────────────────
 *
 *   createdb f37b_smoke
 *   pg_dump --schema-only --no-owner --no-privileges "$DATABASE_URL" | psql -q f37b_smoke
 *
 *   DATABASE_URL=postgresql://…/f37b_smoke \
 *     pnpm --filter @workspace/api-server exec tsx src/scripts/smoke-f37b.ts
 *
 *   dropdb f37b_smoke
 *
 * It refuses to run against a database whose name does not contain "smoke" or
 * "test".
 */

import { createRequire } from "node:module";

// ── 1. Transport lockout. Nothing application-level is loaded yet. ─────────
const require = createRequire(import.meta.url);
const httpMod = require("node:http") as Record<string, unknown>;
const httpsMod = require("node:https") as Record<string, unknown>;

let vendorAttempts = 0;
function blockOutbound(what: string): never {
  vendorAttempts++;
  throw new Error(`SMOKE LOCKOUT: outbound ${what} attempted — this smoke makes no vendor calls`);
}
for (const mod of [httpMod, httpsMod]) {
  mod.request = () => blockOutbound("http(s).request");
  mod.get = () => blockOutbound("http(s).get");
}
globalThis.fetch = (() => blockOutbound("fetch")) as never;

// ── 2. Environment, before any application module exists. ─────────────────
process.env.NODE_ENV = "production";
process.env.LOG_LEVEL = "warn";
// F-3.6b discipline: no identity of last resort exists to be picked up.
for (const v of ["GOOGLE_REFRESH_TOKEN", "SENDER_EMAIL", "SENDER_NAME"]) delete process.env[v];

// ── 3. Refuse anything that is not obviously a scratch database. ──────────
const dbUrl = process.env.DATABASE_URL || "";
const dbName = (() => {
  try {
    return new URL(dbUrl).pathname.replace(/^\//, "");
  } catch {
    return "";
  }
})();
if (!/smoke|test/i.test(dbName)) {
  console.error(
    `REFUSING TO RUN: DATABASE_URL names ${JSON.stringify(dbName) || "(unparseable)"}, ` +
      `which does not look like a scratch database. Create one first — see the header.`,
  );
  process.exit(2);
}

// ── 4. Now the application. ───────────────────────────────────────────────
const { pool } = await import("@workspace/db");
const { runStartupMigrations } = await import("../lib/startupMigrations");
const { runFastTick } = await import("../cron");
const {
  claimProcessingGuard,
  __resetProcessingGuardForTests,
  __setWedgedPassForTests,
  PROCESS_WEDGE_NO_PROGRESS_MS,
} = await import("../lib/processingGuard");

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`  ok    ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

interface Pulse {
  last_fired_at: string | null;
  n: number;
}
async function fastTickPulse(): Promise<Pulse> {
  const { rows } = await pool.query(
    `SELECT max(fired_at)::text AS last_fired_at, count(*)::int AS n
       FROM cron_heartbeats WHERE tick_name = 'fast_tick'`,
  );
  return { last_fired_at: rows[0].last_fired_at, n: rows[0].n };
}
async function latestFastTick(): Promise<{ outcome: string; details: Record<string, unknown> | null }> {
  const { rows } = await pool.query(
    `SELECT outcome, details FROM cron_heartbeats
      WHERE tick_name = 'fast_tick' ORDER BY fired_at DESC, id DESC LIMIT 1`,
  );
  return rows[0];
}

console.log("\nF-3.7b smoke — the tick stops lying\n");
console.log(`database: ${dbName}\n`);

await runStartupMigrations();
await pool.query("DELETE FROM cron_heartbeats");

// ── PROOF 1: an UNGUARDED fast_tick writes its heartbeat (the control). ───
console.log("1. an unguarded fast_tick writes a heartbeat");
__resetProcessingGuardForTests();
await runFastTick();

const afterRun = await fastTickPulse();
check("a heartbeat row exists", afterRun.n === 1, afterRun);
check("max(fired_at) is set", afterRun.last_fired_at !== null);
const run = await latestFastTick();
check("it did work rather than skipping", run?.details?.skipped === undefined, run?.details);

// ── PROOF 2: THE ORDER. A GUARDED fast_tick still writes, and the figure
//             the Chief reads advances. ─────────────────────────────────────
console.log("\n2. a GUARDED fast_tick records the skip, and max(fired_at) ADVANCES");
const before = await fastTickPulse();

// A pass is running — exactly the state that produced the all-day alarms.
__resetProcessingGuardForTests();
const held = claimProcessingGuard("process_due");
if (!held.claimed) {
  console.error("smoke bug: the guard should have been free");
  process.exit(2);
}

// Postgres now() has microsecond resolution, but be explicit rather than lucky.
await new Promise((r) => setTimeout(r, 25));
await runFastTick();

const after = await fastTickPulse();
check("the guarded tick wrote a heartbeat", after.n === before.n + 1, {
  before: before.n,
  after: after.n,
});
check(
  "max(fired_at) ADVANCED — this is the figure the Chief alarms on",
  after.last_fired_at !== null &&
    before.last_fired_at !== null &&
    Date.parse(after.last_fired_at) > Date.parse(before.last_fired_at),
  { before: before.last_fired_at, after: after.last_fired_at },
);

const skipRow = await latestFastTick();
check("it says WHY it did no work", typeof skipRow?.details?.skipped === "string", skipRow?.details);
check("a skip is not an error", skipRow?.outcome === "ok", skipRow?.outcome);
check(
  "it reports how long the pass has held the guard",
  typeof skipRow?.details?.passAgeMs === "number",
  skipRow?.details,
);

// The guard was NOT stolen by the skipping tick.
const stillHeld = claimProcessingGuard("fast_tick");
check("the running pass keeps its guard", stillHeld.claimed === false);
held.release();

// ── PROOF 3: a wedge reclaim reaches the Chief as an error, not as ok. ────
console.log("\n3. a wedge reclaim is ledgered, not swallowed");
__resetProcessingGuardForTests();
__setWedgedPassForTests(PROCESS_WEDGE_NO_PROGRESS_MS + 60_000);

const beforeWedge = await fastTickPulse();
await new Promise((r) => setTimeout(r, 25));
await runFastTick();
const afterWedge = await fastTickPulse();
const wedgeRow = await latestFastTick();

check("the wedged pass did not block the tick", afterWedge.n === beforeWedge.n + 1);
check(
  "the reclaim is recorded on the row",
  typeof wedgeRow?.details?.wedgeReclaimedAfterMs === "number",
  wedgeRow?.details,
);
check(
  "and counts as an error, so errors_24h shows it",
  wedgeRow?.outcome === "partial",
  wedgeRow?.outcome,
);

// ── PROOF 4: no vendor was reachable at any point. ───────────────────────
console.log("\n4. vendors were impossible throughout");
check("zero outbound attempts", vendorAttempts === 0, { vendorAttempts });

const { rows: sends } = await pool.query(
  `SELECT count(*)::int AS n FROM followups WHERE status = 'sent'`,
);
check("nothing was sent", sends[0].n === 0, sends[0]);

__resetProcessingGuardForTests();
await pool.end();

console.log(
  failures === 0
    ? "\nF-3.7b smoke PASSED\n"
    : `\nF-3.7b smoke FAILED — ${failures} check(s)\n`,
);
process.exit(failures === 0 ? 0 : 1);
