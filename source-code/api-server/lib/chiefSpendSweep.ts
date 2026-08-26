/**
 * chiefSpendSweep.ts — F-3.7a. The thing that actually reports this app's spend
 * to the Chief.
 *
 * `chiefSpend.ts` is the pure protocol: how to shape one report, how to name it,
 * when to retry it. This file is the part that touches the database — it reads
 * `followup_usage`, reads and advances `chief_spend_cursor`, and drives the
 * reporter — plus the one decision about whether any of that happens at all.
 *
 * ── THE ACCOUNTING, IN ONE PARAGRAPH ─────────────────────────────────────────
 *
 * Spend is bucketed by (UTC day, vendor). For each bucket the sweep knows two
 * whole-cent numbers: what this app has SPENT (summed from the usage ledger) and
 * what the Chief has CONFIRMED (the cursor). Every $0.50 of the gap becomes one
 * report, named for the running total it starts from — so a report's amount is a
 * pure function of its `external_id`, and a retry of any report is
 * byte-identical to the original. That is what makes the Chief's
 * first-write-wins dedupe safe rather than lossy. A residual under one quantum
 * is not reported; it waits for more spend. The Chief therefore under-counts by
 * less than $0.50 per vendor per day and can never over-count, which is the only
 * direction an error is allowed to go.
 *
 * ── DORMANT AND LOUD ─────────────────────────────────────────────────────────
 *
 * With `CHIEF_URL` or `CHIEF_INGEST_TOKEN` unset there is no reporter, no timer,
 * no socket, and not one query against the cursor table. The app says so once,
 * at boot, in a sentence that names both variables — an integration that is off
 * because nobody set a secret should be legible from the log without reading
 * this file. It never crashes, and it never degrades a send.
 */

import cron from "node-cron";
import { db, chiefSpendCursorTable, followupUsageTable } from "@workspace/db";
import { gte, inArray, sql } from "drizzle-orm";
import { logger } from "./logger";
import { beginHeartbeat } from "./cronHeartbeat";
import { chiefTokenMismatchWarning } from "./chiefAuth";
import {
  type ChiefReporter,
  SPEND_QUANTUM_CENTS,
  DEFAULT_SPEND_INITIATOR,
  chiefSpendExternalId,
  createChiefReporter,
  pendingReportOffsets,
  resolveChiefConfig,
  vendorForModel,
} from "./chiefSpend";
import { startOfUtcDay, utcDayKey } from "./chiefView";

/** The heartbeat name this tick records under, so it shows up in the pulse. */
export const CHIEF_SPEND_TICK = "chief_spend_report";

/**
 * How often the sweep runs. Five minutes: the ledger only grows when a
 * generation happens, a quantum is $0.50, and a fully exhausted send takes
 * ~10s — so this is two orders of magnitude of headroom on both sides. The
 * cadence is not load-bearing for correctness: a missed sweep reports the same
 * money under the same ids on the next one.
 */
const SWEEP_CRON = "*/5 * * * *";

/**
 * Reports one sweep will send for a single (day, vendor) bucket before moving
 * on. A bound, not a budget: whatever is left is picked up by the next sweep
 * under the same ids. It exists so a backfill after a long outage cannot turn
 * one tick into a hundred sequential HTTP calls.
 *
 * When it bites, the sweep SAYS so — a cap that silently truncates reads as
 * "everything is reported" when it is not.
 */
const MAX_REPORTS_PER_BUCKET_PER_SWEEP = 20;

/**
 * How many UTC days back the sweep looks. Two: today, and yesterday for the
 * tail that landed just before midnight and was still inside a quantum when the
 * day rolled. Anything older is already on file or was permanently below a
 * quantum, and re-summing a week of the ledger on every tick would buy nothing.
 */
const SWEEP_DAYS = 2;

/** Overlap guard. One sweep at a time; an overlapping tick simply skips. */
let sweepRunning = false;

export interface BucketSpend {
  dayKey: string;
  vendor: string;
  spentCents: number;
}

/**
 * Whole cents spent per (UTC day, vendor) since `since`.
 *
 * The model → vendor fold happens in TypeScript, through `vendorForModel()`, so
 * the mapping the reports are grouped by is the same function the `external_id`
 * is built from. A `CASE` expression in SQL would be a second copy of it, and
 * the day the two disagree is the day one vendor's cursor silently restarts
 * from zero and a day of spend is reported twice.
 *
 * Micro-dollars are accumulated as integers and only then floored to cents.
 * FLOORED, not rounded: rounding up would report money that was never spent, and
 * the Chief has no correction path (CONTRACT.md §6 — first write wins, and there
 * is no update seam). Flooring keeps the error strictly in the safe direction
 * and, because spend within a day only ever grows, keeps the figure monotonic —
 * which is what stops a cursor from ever being ahead of its bucket.
 */
export async function readBucketSpend(since: Date): Promise<BucketSpend[]> {
  const rows = await db
    .select({
      dayKey: sql<string>`to_char(${followupUsageTable.generatedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
      model: followupUsageTable.model,
      total: sql<string>`COALESCE(SUM(${followupUsageTable.costUsd}), 0)`,
    })
    .from(followupUsageTable)
    .where(gte(followupUsageTable.generatedAt, since))
    .groupBy(
      sql`to_char(${followupUsageTable.generatedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
      followupUsageTable.model,
    );

  // Keyed by a joined string for the Map's sake, but the parts ride alongside
  // rather than being recovered by splitting it back apart. A `split()` on the
  // way out would be a second, weaker definition of the key — correct only
  // while no vendor name contains the separator, which nothing but
  // `vendorForModel()`'s closed return set keeps true.
  const microByBucket = new Map<string, { dayKey: string; vendor: string; micro: number }>();
  for (const r of rows) {
    const vendor = vendorForModel(r.model);
    const key = bucketKey(r.dayKey, vendor);
    const micro = Math.round(Number(r.total ?? 0) * 1_000_000);
    const entry = microByBucket.get(key) ?? { dayKey: r.dayKey, vendor, micro: 0 };
    entry.micro += Number.isFinite(micro) ? micro : 0;
    microByBucket.set(key, entry);
  }

  const out: BucketSpend[] = [];
  for (const { dayKey, vendor, micro } of microByBucket.values()) {
    out.push({ dayKey, vendor, spentCents: Math.floor(micro / 10_000) });
  }
  // Deterministic order so a log transcript of one sweep is comparable to the
  // next, and so the smoke can assert on the sequence of reports.
  out.sort((a, b) => (a.dayKey === b.dayKey ? a.vendor.localeCompare(b.vendor) : a.dayKey.localeCompare(b.dayKey)));
  return out;
}

/**
 * The one spelling of a bucket's identity, shared by the spend map, the cursor
 * map and the sweep, so the three cannot drift into disagreeing about what a
 * bucket is. NUL is the separator because it cannot occur in a `YYYY-MM-DD` day
 * key or in any name `vendorForModel()` returns, written as an escape rather
 * than as a literal byte so the source stays greppable and diffable.
 */
function bucketKey(dayKey: string, vendor: string): string {
  return `${dayKey}\u0000${vendor}`;
}

/** What the Chief has already confirmed, per bucket, in whole cents. */
export async function readCursors(dayKeys: string[]): Promise<Map<string, number>> {
  if (dayKeys.length === 0) return new Map();
  const rows = await db
    .select({
      dayKey: chiefSpendCursorTable.dayKey,
      vendor: chiefSpendCursorTable.vendor,
      reportedCents: chiefSpendCursorTable.reportedCents,
    })
    .from(chiefSpendCursorTable)
    .where(inArray(chiefSpendCursorTable.dayKey, dayKeys));
  return new Map(rows.map((r) => [bucketKey(r.dayKey, r.vendor), Number(r.reportedCents ?? 0)]));
}

/**
 * Move a bucket's cursor forward.
 *
 * `GREATEST` rather than a plain assignment: the cursor is a high-water mark and
 * must never go backwards. Nothing today can drive it backwards — one process,
 * one sweep at a time — but a cursor that regresses re-reports money already on
 * file, and the guard costs one SQL function.
 */
async function advanceCursor(dayKey: string, vendor: string, toCents: number): Promise<void> {
  await db
    .insert(chiefSpendCursorTable)
    .values({ dayKey, vendor, reportedCents: toCents })
    .onConflictDoUpdate({
      target: [chiefSpendCursorTable.dayKey, chiefSpendCursorTable.vendor],
      set: {
        reportedCents: sql`GREATEST(${chiefSpendCursorTable.reportedCents}, ${toCents})`,
        updatedAt: sql`NOW()`,
      },
    });
}

export interface SweepResult {
  /** Reports the Chief accepted this sweep (201 and 200-deduped alike). */
  recorded: number;
  /** Reports that were already on file — the idempotency path. */
  deduped: number;
  /** Buckets whose remaining backlog was left for the next sweep by the cap. */
  cappedBuckets: string[];
  /** Set when the reporter latched off; the sweep stopped there. */
  halted: string | null;
  /** Set when a bucket gave up on a transient failure; it retries next sweep. */
  unavailable: number;
}

/**
 * One pass. Exported so the smoke can drive it against a fake Chief with no
 * timer and no real transport.
 *
 * Never throws for a reporting failure — those come back in the result. A
 * DATABASE failure does throw, and the caller (the tick) is what swallows it, so
 * a broken read is visible in the heartbeat rather than silently reported as a
 * clean sweep.
 */
export async function runChiefSpendSweep(
  reporter: ChiefReporter,
  now: Date = new Date(),
): Promise<SweepResult> {
  const result: SweepResult = {
    recorded: 0,
    deduped: 0,
    cappedBuckets: [],
    halted: reporter.haltedReason(),
    unavailable: 0,
  };
  if (result.halted) return result;

  const since = new Date(startOfUtcDay(now).getTime() - (SWEEP_DAYS - 1) * 86_400_000);
  const buckets = await readBucketSpend(since);
  if (buckets.length === 0) return result;

  const cursors = await readCursors([...new Set(buckets.map((b) => b.dayKey))]);

  for (const bucket of buckets) {
    const reported = cursors.get(bucketKey(bucket.dayKey, bucket.vendor)) ?? 0;
    const offsets = pendingReportOffsets(
      bucket.spentCents,
      reported,
      SPEND_QUANTUM_CENTS,
      MAX_REPORTS_PER_BUCKET_PER_SWEEP,
    );
    if (offsets.length === 0) continue;

    // Did the cap bite? Compare what was owed against what will be sent.
    const owed = Math.floor(Math.max(0, bucket.spentCents - reported) / SPEND_QUANTUM_CENTS);
    if (owed > offsets.length) {
      result.cappedBuckets.push(`${bucket.dayKey}/${bucket.vendor}`);
      logger.warn(
        {
          dayKey: bucket.dayKey,
          vendor: bucket.vendor,
          owed,
          sending: offsets.length,
          cap: MAX_REPORTS_PER_BUCKET_PER_SWEEP,
        },
        "F-3.7a: Chief spend backlog exceeds one sweep's cap — the remainder is NOT reported yet and will go out on the next sweep under the same ids",
      );
    }

    for (const offsetCents of offsets) {
      const outcome = await reporter.send({
        vendor: bucket.vendor,
        amountUsd: SPEND_QUANTUM_CENTS / 100,
        externalId: chiefSpendExternalId({
          dayKey: bucket.dayKey,
          vendor: bucket.vendor,
          offsetCents,
        }),
        initiatedBy: DEFAULT_SPEND_INITIATOR,
      });

      if (outcome.kind === "recorded") {
        // Advanced per report, not per bucket: a crash between two reports then
        // costs a duplicate POST that the Chief dedupes, rather than a repeat of
        // the whole bucket.
        await advanceCursor(bucket.dayKey, bucket.vendor, offsetCents + SPEND_QUANTUM_CENTS);
        result.recorded += 1;
        if (outcome.deduped) result.deduped += 1;
        continue;
      }

      if (outcome.kind === "refused" || outcome.kind === "halted") {
        // The reporter has latched off and said so at error level. Stop the
        // whole sweep: every further report would take the same path.
        result.halted = reporter.haltedReason() ?? outcome.reason;
        return result;
      }

      // `unavailable` or `skipped`: stop THIS bucket. Its later offsets depend
      // on this one landing, and sending them now would leave a hole in the
      // running total that the cursor could never describe.
      result.unavailable += 1;
      break;
    }
  }

  return result;
}

// ─── Wiring ──────────────────────────────────────────────────────────────────

let started = false;

/**
 * The dormancy sentence, as a constant rather than a string literal inside the
 * `logger.warn` call.
 *
 * Pino in production writes to fd 1 through a batching destination, so a test
 * cannot reliably capture the line by wrapping `process.stdout.write` — it
 * arrives after the assertion. Naming the sentence lets the smoke assert on the
 * exact text that gets logged AND on the branch that logged it
 * (`startChiefSpendReporting()` returns which one it took), instead of racing
 * the logger for evidence.
 */
export const CHIEF_DORMANT_MESSAGE =
  "F-3.7a: Chief spend reporting is DORMANT — CHIEF_URL and/or CHIEF_INGEST_TOKEN are unset, " +
  "so this app will not report any LLM spend to the Chief. Nothing is queued and nothing is lost " +
  "in this app's own ledger; the Chief's cross-app spend view simply will not include the Email " +
  "Followupper until both are set and this app is restarted.";

/** Which branch `startChiefSpendReporting()` took. */
export type ChiefReportingState = "dormant" | "live" | "already_started";

/**
 * Announce the seam's configuration and, when it is configured, start the sweep.
 *
 * Called once from `startCronJobs()`. Idempotent — a second call registers
 * nothing and says nothing, so "loud once per boot" is a property of the code
 * rather than of who happens to call it.
 */
export function startChiefSpendReporting(): ChiefReportingState {
  if (started) return "already_started";
  started = true;

  // The half-a-seam check. Emitted whatever the outbound config says, because
  // the failure it catches is precisely the one where the two halves disagree.
  const mismatch = chiefTokenMismatchWarning();
  if (mismatch) logger.warn({ seam: "chief" }, `F-3.7a: ${mismatch}`);

  const cfg = resolveChiefConfig();
  if (!cfg) {
    logger.warn({ seam: "chief", vars: ["CHIEF_URL", "CHIEF_INGEST_TOKEN"] }, CHIEF_DORMANT_MESSAGE);
    return "dormant";
  }

  const reporter = createChiefReporter(cfg, { log: logger });
  logger.info(
    { seam: "chief", origin: reporter.origin, cadence: SWEEP_CRON, quantumUsd: SPEND_QUANTUM_CENTS / 100 },
    "F-3.7a: Chief spend reporting is LIVE",
  );

  cron.schedule(SWEEP_CRON, async () => {
    // F-3.7c: the firing is recorded FIRST, before the overlap guard is
    // consulted. This tick carried the same defect F-3.7b removed from
    // fast_tick — `if (sweepRunning) return` wrote nothing at all, so a sweep
    // that ran long aged this tick's `max(fired_at)` while it fired exactly on
    // schedule, and the Chief would have read that as a dead tick. It has
    // never bitten in production (288 of 288 rows in 24h on 2026-08-17,
    // because a sweep takes about a second), which is precisely why it was
    // still there to find.
    const hb = await beginHeartbeat(CHIEF_SPEND_TICK);
    let outcome: "ok" | "partial" | "error" = "ok";
    const details: Record<string, unknown> = {};
    if (sweepRunning) {
      await hb.finish({
        outcome: "ok",
        details: { skipped: "previous chief spend sweep still running" },
      });
      return;
    }
    sweepRunning = true;
    try {
      const r = await runChiefSpendSweep(reporter);
      details.recorded = r.recorded;
      details.deduped = r.deduped;
      details.unavailable = r.unavailable;
      if (r.cappedBuckets.length > 0) details.cappedBuckets = r.cappedBuckets;
      if (r.halted) {
        details.halted = r.halted;
        outcome = "error";
      } else if (r.unavailable > 0 || r.cappedBuckets.length > 0) {
        outcome = "partial";
      }
    } catch (err) {
      // A database failure. The reporter cannot fail this way — it returns
      // outcomes — so anything here is a read this sweep could not do.
      outcome = "error";
      details.error = err instanceof Error ? err.message : String(err);
      logger.error({ err }, "F-3.7a: Chief spend sweep failed");
    } finally {
      sweepRunning = false;
      await hb.finish({ outcome, details });
    }
  });

  return "live";
}

/** Exported for tests: forget that `startChiefSpendReporting()` ran. */
export function _resetChiefSpendReporting(): void {
  started = false;
  sweepRunning = false;
}

/** The UTC day key helper the sweep and the ids share. Re-exported for the smoke. */
export { utcDayKey };
