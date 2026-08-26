/**
 * test-f37c-honest-liveness.ts — F-3.7c.
 *
 * Hermetic. No database, no network, no vendor, no email. Everything the
 * lifecycle needs — the store, the clock, the sleep, the log — is injected, so
 * the behaviours this order is actually about (what happens when a heartbeat
 * write FAILS) can be made to happen on demand instead of waited for.
 *
 * WHAT THIS PINS
 *
 * The 2026-08-17 diagnosis: the Chief's `age_seconds` and `ticks_24h` read the
 * same rows and so cannot disagree — unless a firing left no row at all. Three
 * things could erase a firing, and each gets its proof here:
 *
 *   1. The row is written when the tick FIRES, not when its body ends, so a
 *      long pass can no longer shorten the age, and no early return can skip
 *      the record. Proved on the lifecycle and pinned structurally in cron.ts.
 *   2. A failed write is RETRIED, and a write that runs out of attempts says so
 *      in one line that names the hole it leaves. It still never throws.
 *   3. A restart writes its own row, under a tick name with no cadence, which
 *      is therefore withheld from the Chief's cadence-based rule and kept on
 *      the admin surface.
 *
 * Plus the fourth scope item, which is a property of two SQL statements and is
 * pinned as source text: the age is computed by the database, in the same
 * snapshot as the counters, and an in-flight row is never counted as an error.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx --test src/tests/test-f37c-honest-liveness.ts
 */

import * as test from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  type HeartbeatRow,
  type HeartbeatStore,
  HEARTBEAT_RETRY_DELAYS_MS,
  HEARTBEAT_RUNNING,
  HEARTBEAT_WRITE_ATTEMPTS,
  NON_CADENCE_TICKS,
  PROCESS_START_TICK,
  createHeartbeatRecorder,
} from "../lib/heartbeatLifecycle";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "..");
const readSrc = (rel: string): string => fs.readFileSync(path.join(SRC, rel), "utf8");

/**
 * The same source with its comments removed.
 *
 * Every positional pin below asks "does this call come before that one", and
 * these files explain themselves at length — including by quoting the code they
 * replaced. A pin that matched prose would be answering a question about a
 * comment. Crude on purpose: it never sees a `//` inside a string literal in
 * these files, and if one ever appears the pin fails loudly rather than
 * quietly.
 */
const readCode = (rel: string): string =>
  readSrc(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[^\n]*?\/\/.*$/gm, (line) => (/^\s*\/\//.test(line) ? "" : line.replace(/\/\/.*$/, "")));

// ── The harness ────────────────────────────────────────────────────────────

interface Recorded {
  op: "insertRunning" | "finishRow" | "insertFinished";
  tickName?: string;
  id?: number;
  row?: HeartbeatRow;
}

/**
 * A store that records what it was asked to do, and can be told to fail the
 * first N attempts of any one statement.
 */
function harness(opts: { failInsertRunning?: number; failFinish?: number; failInsertFinished?: number } = {}) {
  const ops: Recorded[] = [];
  const logs: Array<{ level: "warn" | "error"; obj: Record<string, unknown>; msg: string }> = [];
  const slept: number[] = [];
  let clock = 1_000;
  let nextId = 1;
  let insertRunningFailures = opts.failInsertRunning ?? 0;
  let finishFailures = opts.failFinish ?? 0;
  let insertFinishedFailures = opts.failInsertFinished ?? 0;

  const store: HeartbeatStore = {
    async insertRunning(tickName) {
      if (insertRunningFailures > 0) {
        insertRunningFailures--;
        throw new Error("pool acquisition timed out");
      }
      const id = nextId++;
      ops.push({ op: "insertRunning", tickName, id });
      return id;
    },
    async finishRow(id, row) {
      if (finishFailures > 0) {
        finishFailures--;
        throw new Error("pool acquisition timed out");
      }
      ops.push({ op: "finishRow", id, row });
    },
    async insertFinished(tickName, row) {
      if (insertFinishedFailures > 0) {
        insertFinishedFailures--;
        throw new Error("pool acquisition timed out");
      }
      ops.push({ op: "insertFinished", tickName, row });
    },
  };

  const recorder = createHeartbeatRecorder({
    store,
    log: {
      warn: (obj, msg) => logs.push({ level: "warn", obj, msg }),
      error: (obj, msg) => logs.push({ level: "error", obj, msg }),
    },
    now: () => clock,
    // The sleep is recorded and returns immediately: this suite proves the
    // ladder's shape, and a test that actually waited four seconds to prove it
    // would be a test nobody runs.
    sleep: async (ms) => {
      slept.push(ms);
    },
  });

  return {
    recorder,
    ops,
    logs,
    slept,
    advance: (ms: number) => {
      clock += ms;
    },
    errors: () => logs.filter((l) => l.level === "error"),
  };
}

// ── 1. The row is written at the firing, and updated in place ─────────────

test.describe("a firing is recorded when it fires", () => {
  test.it("begin inserts one running row, finish updates THAT row", async () => {
    const h = harness();
    const hb = await h.recorder.begin("fast_tick");

    assert.deepEqual(
      h.ops.map((o) => o.op),
      ["insertRunning"],
      "the row must exist before the body runs — that is the whole order",
    );
    assert.equal(h.ops[0]?.tickName, "fast_tick");
    assert.equal(hb.id, 1);

    await hb.finish({ outcome: "ok", details: { processed: 0 } });

    assert.deepEqual(
      h.ops.map((o) => o.op),
      ["insertRunning", "finishRow"],
      "one row per firing: the second write is an UPDATE, never a second insert",
    );
    assert.equal(h.ops[1]?.id, 1, "it updates the row this firing inserted");
    assert.deepEqual(h.ops[1]?.row?.details, { processed: 0 });
    assert.equal(h.ops[1]?.row?.outcome, "ok");
  });

  test.it("the running outcome is what an unfinished firing carries", () => {
    assert.equal(HEARTBEAT_RUNNING, "running");
  });

  test.it("the duration is measured from the FIRING, not from the result", async () => {
    const h = harness();
    const hb = await h.recorder.begin("process_due");
    h.advance(7_500);
    await hb.finish({ outcome: "ok" });
    assert.equal(h.ops[1]?.row?.durationMs, 7_500);
  });

  test.it("a clock that goes backwards cannot produce a negative duration", async () => {
    const h = harness();
    const hb = await h.recorder.begin("process_due");
    h.advance(-5_000);
    await hb.finish({ outcome: "ok" });
    assert.equal(h.ops[1]?.row?.durationMs, 0);
  });

  test.it("finishing twice writes once", async () => {
    const h = harness();
    const hb = await h.recorder.begin("fast_tick");
    await hb.finish({ outcome: "ok" });
    await hb.finish({ outcome: "error", details: { error: "second call" } });
    assert.equal(h.ops.filter((o) => o.op !== "insertRunning").length, 1);
  });
});

// ── 2. A failed write is retried, and a lost one is loud ─────────────────

test.describe("the heartbeat write is no longer best-effort", () => {
  test.it("more than one attempt, and one wait between each pair", () => {
    assert.ok(HEARTBEAT_WRITE_ATTEMPTS >= 2, "one attempt is the old behaviour");
    assert.equal(
      HEARTBEAT_RETRY_DELAYS_MS.length,
      HEARTBEAT_WRITE_ATTEMPTS - 1,
      "a wait between each pair of attempts, and no more",
    );
    for (const d of HEARTBEAT_RETRY_DELAYS_MS) assert.ok(d > 0 && d <= 10_000, `implausible delay ${d}`);
  });

  test.it("a transient insert failure is retried and the firing survives", async () => {
    const h = harness({ failInsertRunning: HEARTBEAT_WRITE_ATTEMPTS - 1 });
    const hb = await h.recorder.begin("fast_tick");

    assert.notEqual(hb.id, null, "the firing was recorded despite the failures");
    assert.deepEqual(h.slept, [...HEARTBEAT_RETRY_DELAYS_MS], "it waited between attempts");
    assert.equal(h.errors().length, 0, "a retry that succeeded is not an error");
    assert.equal(h.logs.filter((l) => l.level === "warn").length, HEARTBEAT_WRITE_ATTEMPTS - 1);
  });

  test.it("a write that runs out of attempts says so, and names the hole", async () => {
    const h = harness({ failInsertRunning: HEARTBEAT_WRITE_ATTEMPTS });
    const hb = await h.recorder.begin("fast_tick");

    assert.equal(hb.id, null);
    const errs = h.errors();
    assert.equal(errs.length, 1, "exactly one line, not one per attempt");
    assert.equal(errs[0]?.obj.tickName, "fast_tick");
    assert.match(errs[0]?.msg ?? "", /hole/i, "it must say a firing left no row");
    assert.match(errs[0]?.msg ?? "", /Chief|stale|dead cron/i, "and what that hole will look like");
  });

  test.it("when the firing could not be recorded, the RESULT still is", async () => {
    const h = harness({ failInsertRunning: HEARTBEAT_WRITE_ATTEMPTS });
    const hb = await h.recorder.begin("sync_and_autoqueue");
    h.advance(2_000);
    await hb.finish({ outcome: "partial", details: { syncError: "boom" } });

    const finished = h.ops.filter((o) => o.op === "insertFinished");
    assert.equal(finished.length, 1, "it falls back to the pre-F-3.7c shape rather than losing everything");
    assert.equal(finished[0]?.tickName, "sync_and_autoqueue");
    assert.equal(finished[0]?.row?.outcome, "partial");
    assert.equal(finished[0]?.row?.durationMs, 2_000);
  });

  test.it("a finish that cannot be written leaves the row at running, loudly", async () => {
    const h = harness({ failFinish: HEARTBEAT_WRITE_ATTEMPTS });
    const hb = await h.recorder.begin("process_due");
    await hb.finish({ outcome: "error", details: { error: "boom" } });

    const errs = h.errors();
    assert.ok(errs.length >= 1);
    assert.ok(
      errs.some((e) => /running/.test(e.msg)),
      "the operator has to be told why a row will sit at running for ever",
    );
  });

  test.it("nothing here throws — a heartbeat may be missing, never fatal", async () => {
    const h = harness({
      failInsertRunning: HEARTBEAT_WRITE_ATTEMPTS,
      failFinish: HEARTBEAT_WRITE_ATTEMPTS,
      failInsertFinished: HEARTBEAT_WRITE_ATTEMPTS,
    });
    const hb = await h.recorder.begin("fast_tick");
    await hb.finish({ outcome: "ok" });
    await h.recorder.record({ tickName: PROCESS_START_TICK, outcome: "ok" });
  });

  test.it("the one-shot record is retried on the same ladder", async () => {
    const h = harness({ failInsertFinished: HEARTBEAT_WRITE_ATTEMPTS - 1 });
    await h.recorder.record({ tickName: PROCESS_START_TICK, outcome: "ok", details: { reason: "x" } });
    assert.equal(h.ops.filter((o) => o.op === "insertFinished").length, 1);
    assert.deepEqual(h.slept, [...HEARTBEAT_RETRY_DELAYS_MS]);
    assert.equal(h.errors().length, 0);
  });
});

// ── 3. The restart marker, and why the Chief does not see it ─────────────

test.describe("a restart is recorded, under a name with no cadence", () => {
  test.it("the tick name exists and is withheld from the Chief's pulses", () => {
    assert.equal(PROCESS_START_TICK, "process_start");
    assert.ok(
      NON_CADENCE_TICKS.includes(PROCESS_START_TICK),
      "a cadence-based staleness rule cannot read a marker with no cadence",
    );
  });

  test.it("no real cron tick is withheld by accident", () => {
    for (const real of [
      "fast_tick",
      "process_due",
      "sync_and_autoqueue",
      "chief_spend_report",
      "draft_stall_watcher",
      "archive_sweep",
      "weekly_digest",
    ]) {
      assert.ok(!NON_CADENCE_TICKS.includes(real), `${real} must reach the Chief`);
    }
  });

  test.it("boot records it fire-and-forget, not awaited", () => {
    const src = readSrc("cron.ts");
    assert.match(src, /recordProcessStart\(/, "boot must record that the process started");
    assert.doesNotMatch(
      src,
      /await\s+recordProcessStart\(/,
      "boot must not wait on its own bookkeeping",
    );
  });
});

// ── 4. Structural pins: the wiring lives in modules that import the db ───
//
// cron.ts, chiefReaders.ts and the admin route all import @workspace/db, which
// throws at import without DATABASE_URL. So they are read as TEXT here — the
// test-fallback-deleted.ts idiom — and every pin below is one that bites if the
// behaviour it names is removed.

test.describe("structural pins", () => {
  test.it("every tick in cron.ts records its firing, and none records at the end only", () => {
    const src = readSrc("cron.ts");
    const begins = src.match(/beginHeartbeat\("/g) ?? [];
    assert.equal(begins.length, 10, "eight scheduled bodies plus the two exported ticks");
    assert.equal(
      (src.match(/recordHeartbeat\(/g) ?? []).length,
      0,
      "a tick that records only at the end is the defect this order removes",
    );
    assert.equal((src.match(/Date\.now\(\) - startedAt/g) ?? []).length, 0);
  });

  test.it("the guard is consulted AFTER the firing is recorded, in both ticks", () => {
    const src = readCode("cron.ts");
    for (const fn of ["runProcessDueTick", "runFastTick"]) {
      const body = src.slice(src.indexOf(`export async function ${fn}`));
      const begin = body.indexOf("beginHeartbeat(");
      const claim = body.indexOf("claimProcessingGuard(");
      assert.ok(begin >= 0 && claim >= 0, `${fn}: both calls must be there`);
      assert.ok(
        begin < claim,
        `${fn}: the row must exist before the guard can send this tick home, or a skip can go unrecorded again`,
      );
    }
  });

  test.it("the chief spend sweep records its firing before its own overlap guard", () => {
    const src = readCode("lib/chiefSpendSweep.ts");
    const begin = src.indexOf("beginHeartbeat(");
    const guard = src.indexOf("if (sweepRunning)");
    assert.ok(begin >= 0 && guard >= 0);
    assert.ok(begin < guard, "this tick carried the same unrecorded-skip defect as fast_tick");
    assert.equal((src.match(/if \(sweepRunning\) return;/g) ?? []).length, 0, "a bare return records nothing");
  });

  test.it("the Chief's ages come from the database clock, in one snapshot", () => {
    const src = readSrc("lib/chiefReaders.ts");
    assert.match(
      src,
      /extract\(epoch from \(now\(\) - max\(/,
      "the age must be SQL, evaluated with the same now() as the counters",
    );
    assert.doesNotMatch(src, /ageSeconds\(/, "the app-clock helper must not come back");
    assert.match(src, /notInArray\(cronHeartbeatsTable\.tickName/, "non-cadence ticks stay off the Chief seam");
  });

  test.it("a firing that never finishes is describable — two ages, not one", () => {
    const view = readSrc("lib/chiefView.ts");
    assert.match(
      view,
      /result_age_seconds: number \| null;/,
      "fire-time rows make a hung tick look fresh; the second age is what says otherwise",
    );
    const readers = readSrc("lib/chiefReaders.ts");
    assert.match(
      readers,
      /filter \(where \$\{cronHeartbeatsTable\.outcome\} <> \$\{HEARTBEAT_RUNNING\}\)/,
      "the result age must be max(fired_at) over FINISHED rows only",
    );
    assert.match(readers, /resultAgeSeconds === null \? null : Number/, "NULL must not become 0 — that reads as 'just finished'");
    const admin = readSrc("routes/admin-cron-heartbeats.ts");
    assert.match(admin, /seconds_since_last_result/, "the operator gets the same pair");
  });

  test.it("emptying the withheld-tick list cannot blank the Chief's cron list", () => {
    assert.match(
      readSrc("lib/chiefReaders.ts"),
      /NON_CADENCE_TICKS\.length > 0/,
      "notInArray(col, []) compiles to a false predicate — every tick would vanish",
    );
  });

  test.it("the app-clock age helper is gone from the pure view module", () => {
    const src = readSrc("lib/chiefView.ts");
    assert.doesNotMatch(
      src,
      /export function ageSeconds/,
      "leaving it exported is leaving the wrong clock where the next reader will find it",
    );
  });

  test.it("an in-flight tick is not an error, on either reader", () => {
    for (const rel of ["lib/chiefReaders.ts", "routes/admin-cron-heartbeats.ts"]) {
      const src = readSrc(rel);
      assert.doesNotMatch(
        src,
        /outcome} <> 'ok'/,
        `${rel}: <> 'ok' counts every in-flight firing as a failure`,
      );
      assert.match(src, /not in \('ok', \$\{HEARTBEAT_RUNNING\}\)/, `${rel}: must exclude running`);
    }
  });

  test.it("the admin surface computes its age in SQL too, and hides no tick", () => {
    const src = readSrc("routes/admin-cron-heartbeats.ts");
    assert.match(src, /extract\(epoch from \(now\(\) - max\(/);
    assert.doesNotMatch(
      src,
      /now\.getTime\(\) - last\.getTime\(\)/,
      "the app-clock subtraction was the same defect in a second place",
    );
    assert.doesNotMatch(
      src,
      /notInArray/,
      "process_start must be visible here — it is what explains a hole",
    );
  });

  test.it("the status route hands the pulse reader no clock of its own", () => {
    const src = readSrc("routes/chief.ts");
    assert.match(src, /sources\.cronPulses\(\)/, "no instant is passed in any more");
    assert.doesNotMatch(src, /cronPulses\(at\)/);
  });
});
