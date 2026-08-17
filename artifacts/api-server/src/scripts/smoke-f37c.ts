/**
 * smoke-f37c.ts — F-3.7c live smoke, against an ISOLATED database.
 *
 * The hermetic suite (tests/test-f37c-honest-liveness.ts) proves the decisions:
 * the retry ladder, the fallback when a firing cannot be recorded, the loud
 * line when a write is lost, the withheld tick name. Those are all reachable
 * with an injected store.
 *
 * What it cannot prove is the part that only exists as ROWS AND A CLOCK:
 *
 *   1. The row is there WHILE the tick is still working, stamped with the
 *      firing. Before this order the row appeared only when the body ended,
 *      which is why a tick with a five-minute body reported an age five minutes
 *      younger than the truth.
 *   2. One row per firing — the second write is an UPDATE. If it were an insert
 *      the tick counter would double and every cadence figure would be wrong.
 *   3. An in-flight firing is not an error, and becomes one the moment its
 *      result says so.
 *   4. The age the Chief reads is the DATABASE's arithmetic. Pushed a row's
 *      `fired_at` ten minutes into the past and the reported age is ten
 *      minutes, to the second, with no app clock anywhere in it.
 *   5. The restart marker is written, is invisible on the Chief seam, and is
 *      in the table where the admin surface reads it.
 *
 * ── VENDORS ARE MADE IMPOSSIBLE, NOT MERELY UNLIKELY ──────────────────────
 *
 * `http.request`, `https.request`, `http.get`, `https.get` and `globalThis.fetch`
 * are replaced with throwers BEFORE any application module is loaded. Postgres
 * speaks over `net`/`tls` and is unaffected. The count is asserted to be zero at
 * the end.
 *
 * NOTHING HERE SENDS EMAIL. The database holds no prospects, so the real tick
 * body that runs has no row to generate for and no address to send to, and the
 * transport is dead regardless.
 *
 * ── USAGE — never point this at dev or production ─────────────────────────
 *
 *   createdb f37c_smoke
 *   pg_dump --schema-only --no-owner --no-privileges "$DATABASE_URL" | psql -q f37c_smoke
 *
 *   DATABASE_URL=postgresql://…/f37c_smoke \
 *     pnpm --filter @workspace/api-server exec tsx src/scripts/smoke-f37c.ts
 *
 *   dropdb f37c_smoke
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

// ── 1b. Capture what the schedules register, instead of waiting for them. ──
//
// Ten tick bodies changed shape in this order and two of them are directly
// exported (`runFastTick`, `runProcessDueTick`). The other eight are reachable
// only as callbacks inside `cron.schedule(...)`, and a smoke that waits for a
// daily sweep to fire is a smoke nobody runs — so `schedule` is replaced here,
// before any application module loads, and hands its callback over instead of
// arming it. Nothing is armed at all: the stub task is inert, so no tick can
// fire behind this script's back while it works.
interface CapturedTick {
  expression: string;
  run: () => Promise<void> | void;
}
const capturedTicks: CapturedTick[] = [];
const cronMod = require("node-cron") as Record<string, unknown>;
cronMod.schedule = (expression: string, run: () => Promise<void> | void) => {
  capturedTicks.push({ expression, run });
  return { start() {}, stop() {}, now() {} };
};

// ── 2. Environment, before any application module exists. ─────────────────
process.env.NODE_ENV = "production";
process.env.LOG_LEVEL = "warn";
for (const v of ["GOOGLE_REFRESH_TOKEN", "SENDER_EMAIL", "SENDER_NAME"]) delete process.env[v];
// The Chief seam is deliberately DARK here, and this line is load-bearing: the
// first run of this smoke inherited the real `CHIEF_URL` and
// `CHIEF_INGEST_TOKEN` from the workspace environment, which armed the spend
// reporter and gave the tick census an eleventh tick pointed at the live Chief.
// The transport lockout above caught it, and unsetting them is the fix. An
// armed reporter has no business inside a smoke.
for (const v of ["FOLLOWUP_CHIEF_TOKEN", "CHIEF_URL", "CHIEF_INGEST_TOKEN"]) delete process.env[v];

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
const { beginHeartbeat, recordProcessStart } = await import("../lib/cronHeartbeat");
const { readCronPulses } = await import("../lib/chiefReaders");
const { HEARTBEAT_RUNNING, PROCESS_START_TICK } = await import("../lib/heartbeatLifecycle");
const { claimProcessingGuard, __resetProcessingGuardForTests } = await import("../lib/processingGuard");

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`  ok    ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Row {
  id: number;
  tick_name: string;
  outcome: string;
  duration_ms: number;
  details: Record<string, unknown> | null;
  age_seconds: number;
}
async function rowsFor(tick: string): Promise<Row[]> {
  const { rows } = await pool.query(
    `SELECT id, tick_name, outcome, duration_ms, details,
            round(extract(epoch FROM (now() - fired_at)))::int AS age_seconds
       FROM cron_heartbeats WHERE tick_name = $1 ORDER BY id`,
    [tick],
  );
  return rows;
}
async function pulse(tick: string) {
  return (await readCronPulses()).find((p) => p.tick_name === tick);
}

console.log("\nF-3.7c smoke — the liveness signal stops depending on the work\n");
console.log(`database: ${dbName}\n`);

await runStartupMigrations();
await pool.query("DELETE FROM cron_heartbeats");

// Sends are counted as a DELTA, not as an absolute. A scratch database that has
// hosted another smoke already holds `sent` rows, and a check that reads the
// absolute count would then fail for a reason that has nothing to do with this
// run — or, worse, pass while this run sent something.
const sentAtStart = Number(
  (await pool.query(`SELECT count(*)::int AS n FROM followups WHERE status = 'sent'`)).rows[0].n,
);

// ── PROOF 1: the row exists WHILE the tick is working, stamped at the
//             firing. This is the defect, measured. ───────────────────────
console.log("1. the row is there mid-flight, stamped with the FIRING");
const hb = await beginHeartbeat("fast_tick");

const midFlight = await rowsFor("fast_tick");
check("a row exists before the body has finished", midFlight.length === 1, midFlight.length);
check("it carries the in-flight outcome", midFlight[0]?.outcome === HEARTBEAT_RUNNING, midFlight[0]?.outcome);

const midPulse = await pulse("fast_tick");
check(
  "the Chief already counts the firing",
  midPulse?.ticks_24h === 1,
  midPulse,
);
check(
  "and does NOT read it as an error",
  midPulse?.errors_24h === 0,
  midPulse?.errors_24h,
);

// A body that takes real time. Before F-3.7c the row would not exist yet, and
// when it finally appeared its fired_at would be NOW — the age reset to zero by
// however long the work took.
await sleep(1_200);
await hb.finish({ outcome: "ok", details: { processed: 0, smoke: "slow body" } });

const finished = await rowsFor("fast_tick");
check("still exactly one row — the second write was an UPDATE", finished.length === 1, finished.length);
check("the same row", finished[0]?.id === midFlight[0]?.id, { before: midFlight[0]?.id, after: finished[0]?.id });
check(
  "fired_at stayed at the FIRING — the age did not reset to zero",
  (finished[0]?.age_seconds ?? 0) >= 1,
  { age_seconds: finished[0]?.age_seconds },
);
check(
  "the duration covers the whole body",
  (finished[0]?.duration_ms ?? 0) >= 1_200,
  { duration_ms: finished[0]?.duration_ms },
);
check("the result landed on the row", finished[0]?.outcome === "ok", finished[0]?.outcome);
check("and so did its details", finished[0]?.details?.smoke === "slow body", finished[0]?.details);

// ── PROOF 2: an in-flight firing becomes an error only when it says so. ───
console.log("\n2. running is not an error; partial is");
const hb2 = await beginHeartbeat("process_due");
const before = await pulse("process_due");
check("in flight: counted, not blamed", before?.ticks_24h === 1 && before?.errors_24h === 0, before);
await hb2.finish({ outcome: "partial", details: { wedgeReclaimedAfterMs: 1 } });
const after = await pulse("process_due");
check("finished partial: counted AND blamed", after?.ticks_24h === 1 && after?.errors_24h === 1, after);

// ── PROOF 3: the age is the database's arithmetic. ───────────────────────
console.log("\n3. the age comes from the database clock, in one snapshot");
await pool.query(
  `UPDATE cron_heartbeats SET fired_at = now() - interval '600 seconds'
     WHERE tick_name = 'process_due'`,
);
const aged = await pulse("process_due");
const { rows: control } = await pool.query(
  `SELECT round(extract(epoch FROM (now() - max(fired_at))))::int AS age
     FROM cron_heartbeats WHERE tick_name = 'process_due'`,
);
check(
  "ten minutes in the past reads as ten minutes",
  Math.abs((aged?.age_seconds ?? 0) - 600) <= 2,
  { reported: aged?.age_seconds },
);
check(
  "and it equals what the database itself computes",
  Math.abs((aged?.age_seconds ?? 0) - Number(control[0].age)) <= 1,
  { reported: aged?.age_seconds, control: control[0].age },
);

// ── PROOF 3b: the two ages, and the stall only the pair can describe. ────
//
// This is the hole that moving the row to fire-time would otherwise open: a tick
// that fires and never finishes has a fresh firing age, so the figure that used
// to climb into an alarm now says nothing. `result_age_seconds` is what says it.
console.log("\n3b. a firing that never finishes shows up as a climbing RESULT age");
const stalled = await beginHeartbeat("process_due");
const stalling = await pulse("process_due");
check(
  "the firing age is fresh — the tick did fire, and that is true",
  (stalling?.age_seconds ?? 999) <= 3,
  stalling?.age_seconds,
);
check(
  "and the result age still reads ten minutes — nothing has finished since",
  Math.abs((stalling?.result_age_seconds ?? -1) - 600) <= 3,
  stalling?.result_age_seconds,
);
await stalled.finish({ outcome: "ok" });
const settled = await pulse("process_due");
check(
  "finishing it brings the result age back down",
  (settled?.result_age_seconds ?? 999) <= 3,
  settled?.result_age_seconds,
);

await pool.query(`DELETE FROM cron_heartbeats WHERE tick_name = 'draft_stall_watcher'`);
const neverFinishes = await beginHeartbeat("draft_stall_watcher");
const noResultYet = await pulse("draft_stall_watcher");
check(
  "a tick whose only firing is still in flight reports NO result age, not zero",
  noResultYet?.result_age_seconds === null,
  noResultYet,
);
await neverFinishes.finish({ outcome: "ok" });
await pool.query(`DELETE FROM cron_heartbeats WHERE tick_name = 'draft_stall_watcher'`);

// ── PROOF 4: a GUARDED real tick still records — now structurally. ───────
console.log("\n4. a guarded fast_tick records its firing and says why it did nothing");
__resetProcessingGuardForTests();
const held = claimProcessingGuard("process_due");
if (!held.claimed) {
  console.error("smoke bug: the guard should have been free");
  process.exit(2);
}
const beforeGuarded = (await rowsFor("fast_tick")).length;
await runFastTick();
const guardedRows = await rowsFor("fast_tick");
check("one more row for one more firing", guardedRows.length === beforeGuarded + 1, {
  before: beforeGuarded,
  after: guardedRows.length,
});
const skipRow = guardedRows[guardedRows.length - 1];
check("it finished, rather than being left at running", skipRow?.outcome === "ok", skipRow?.outcome);
check("it says why it did no work", typeof skipRow?.details?.skipped === "string", skipRow?.details);
check("a skip is not an error to the Chief", (await pulse("fast_tick"))?.errors_24h === 0);
const stillHeld = claimProcessingGuard("fast_tick");
check("the running pass keeps its guard", stillHeld.claimed === false);
held.release();
__resetProcessingGuardForTests();

// ── PROOF 5: an UNGUARDED real tick — one row, finished, no doubling. ────
console.log("\n5. an unguarded real tick writes one row per firing");
const beforeReal = (await rowsFor("fast_tick")).length;
await runFastTick();
const afterReal = await rowsFor("fast_tick");
check("exactly one row was added", afterReal.length === beforeReal + 1, {
  before: beforeReal,
  after: afterReal.length,
});
const realRow = afterReal[afterReal.length - 1];
check("it did work rather than skipping", realRow?.details?.skipped === undefined, realRow?.details);
check("and it is finished", realRow?.outcome === "ok", realRow?.outcome);
check(
  "no row anywhere is stuck at running",
  (await pool.query(`SELECT count(*)::int AS n FROM cron_heartbeats WHERE outcome = $1`, [HEARTBEAT_RUNNING]))
    .rows[0].n === 0,
);

// ── PROOF 6: the restart marker. ────────────────────────────────────────
console.log("\n6. a restart is recorded, and withheld from the Chief");
recordProcessStart({ tickSet: "smoke" });
await sleep(300);
const startRows = await rowsFor(PROCESS_START_TICK);
check("the table has the restart", startRows.length === 1, startRows.length);
check("with its reason", startRows[0]?.details?.reason === "process start", startRows[0]?.details);
check("the Chief's pulses do not include it", (await pulse(PROCESS_START_TICK)) === undefined);
check(
  "while the ticks that DO have a cadence are still there",
  (await readCronPulses()).map((p) => p.tick_name).sort().join(",") === "fast_tick,process_due",
  (await readCronPulses()).map((p) => p.tick_name),
);

// ── PROOF 7: EVERY registered tick, driven once for real. ───────────────
//
// Not two of the ten. All of them, through the real bodies, against a real
// database, with the transport dead. On an empty database the work each one
// finds is nothing — no prospect to generate for, no account to sync, nobody to
// digest — which is the point: what is being proved is the bookkeeping, and the
// bookkeeping is the same on a pass that does nothing as on one that does.
console.log("\n7. every registered tick records exactly one finished firing");
await pool.query("DELETE FROM cron_heartbeats");
__resetProcessingGuardForTests();

const { startCronJobs } = await import("../cron");
startCronJobs();

check("ten schedules were registered", capturedTicks.length === 10, {
  registered: capturedTicks.length,
  expressions: capturedTicks.map((t) => t.expression),
});
check(
  "including the two the alarms were about",
  capturedTicks.some((t) => t.expression === "*/3 * * * *") &&
    capturedTicks.some((t) => t.expression === "5,20,35,50 * * * *") &&
    capturedTicks.some((t) => t.expression === "*/15 * * * *"),
  capturedTicks.map((t) => t.expression),
);

for (const tick of capturedTicks) {
  __resetProcessingGuardForTests();
  await tick.run();
}

const { rows: perTick } = await pool.query(
  `SELECT tick_name, count(*)::int AS n,
          count(*) FILTER (WHERE outcome = $1)::int AS still_running,
          count(*) FILTER (WHERE details IS NULL)::int AS no_details
     FROM cron_heartbeats
    WHERE tick_name <> $2
    GROUP BY tick_name ORDER BY tick_name`,
  [HEARTBEAT_RUNNING, PROCESS_START_TICK],
);
check("ten distinct ticks recorded", perTick.length === 10, perTick.map((r: { tick_name: string }) => r.tick_name));
check(
  "one row per firing, for every one of them",
  perTick.every((r: { n: number }) => r.n === 1),
  perTick,
);
check(
  "none of them was left at running",
  perTick.every((r: { still_running: number }) => r.still_running === 0),
  perTick,
);
check(
  "every one recorded what it did",
  perTick.every((r: { no_details: number }) => r.no_details === 0),
  perTick,
);
check(
  "boot recorded the restart alongside them",
  (await rowsFor(PROCESS_START_TICK)).length >= 1,
);
// The one honest gap in this proof, stated rather than hidden: the
// `chief_spend_report` tick is registered by `startChiefSpendReporting()` only
// when CHIEF_URL and CHIEF_INGEST_TOKEN are both set, which this smoke
// deliberately never sets — an armed reporter would dial a Chief. Its wrapper is
// the same shape as these ten and is pinned as source text in
// tests/test-f37c-honest-liveness.ts instead.
check(
  "the Chief spend tick stayed dormant, as this smoke requires",
  capturedTicks.length === 10 && (await rowsFor("chief_spend_report")).length === 0,
);

// ── PROOF 8: nothing was reachable, nothing was sent. ───────────────────
console.log("\n8. vendors were impossible throughout");
check("zero outbound attempts", vendorAttempts === 0, { vendorAttempts });
const { rows: sends } = await pool.query(`SELECT count(*)::int AS n FROM followups WHERE status = 'sent'`);
check("this run sent nothing", Number(sends[0].n) === sentAtStart, {
  atStart: sentAtStart,
  atEnd: sends[0].n,
});

await pool.end();

console.log(
  failures === 0 ? "\nF-3.7c smoke PASSED\n" : `\nF-3.7c smoke FAILED — ${failures} check(s)\n`,
);
process.exit(failures === 0 ? 0 : 1);
