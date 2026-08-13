/**
 * processingGuard.ts — F-3.7b.
 *
 * The overlap guard shared by the two follow-up processing ticks, and nothing
 * else. No database import, no vendor import, no node-cron: pure module state
 * and a clock, so the wedge watchdog can be proven hermetically. Same reasoning
 * retryPolicy.ts applies to the failed-row rules.
 */

import { logger } from "./logger";

// Overlap guard for follow-up processing ticks. processDueFollowups() is
// CAS-protected against double sends, so overlap is safe — but process_due
// (4x/hour) and fast_tick (every 3 min) calling it concurrently multiplies
// DB round-trips and Gmail reads for zero benefit. One processing pass at
// a time; an overlapping tick simply skips. (The all-users SYNC overlap
// guard lives inside syncEmails() itself so it also covers the /sync
// routes — see SyncAlreadyRunningError.)
//
// ── F-3.7b: the bare boolean became a pass record. ───────────────────────
//
// It had neither a wedge watchdog nor a pass-identity token, both of which the
// sync guard was given in the 2026-07-16 audit. A hung socket inside a pass
// would therefore have left `true` set for the life of the process: fast_tick
// would never write another heartbeat, process_due would keep writing `ok`
// heartbeats saying "skipped", and NOTHING would ever send again — the loudest
// possible failure wearing the quietest possible face.
//
// The watchdog measures TIME SINCE THE PASS LAST FINISHED A ROW, not the pass's
// total age, and that is a deliberate departure from the sync guard's start-time
// measure. A processing pass is 20 rows deep and a healthy one runs for many
// minutes, so total age cannot tell "slow" from "wedged" without a limit so
// generous it would not bound the damage. Progress can: a pass still completing
// rows is alive whatever the clock says, and a pass that has completed nothing
// for PROCESS_WEDGE_NO_PROGRESS_MS is stuck on one row.
//
// A single row is bounded above by the F-3.7b generation deadline
// (GENERATION_DEADLINE_MS, 180s) plus its Gmail calls (each bounded by
// GOOGLE_API_TIMEOUT_MS, 30s) plus its database writes. Ten minutes is
// comfortably longer than any legitimate row and far shorter than the sync
// path's four hours, which is the right trade here because every extra minute
// of this limit is a minute in which a genuinely hung pass blocks ALL sending.
//
// Reclaiming early is safe by construction, which is what lets the limit be
// tight: rows are claimed by a CAS to `generating` (scheduler.ts), so a second
// pass running beside a slow first one skips every row the first one holds. This
// guard prevents redundant work; it is not what prevents double sends.
export const PROCESS_WEDGE_NO_PROGRESS_MS = 10 * 60 * 1000;

interface ProcessingPass {
  startedAt: number;
  lastProgressAt: number;
}

let runningProcessingPass: ProcessingPass | null = null;

export type ProcessingGuardClaim =
  | { claimed: false; passAgeMs: number; sinceProgressMs: number }
  | {
      claimed: true;
      /** Non-null when this claim broke a wedged pass: the age of what it broke. */
      reclaimedAfterMs: number | null;
      /** Handed to processDueFollowups so each finished row refreshes the watchdog. */
      onProgress: () => void;
      /** Identity-token release: a late-finishing wedged pass cannot clear OUR guard. */
      release: () => void;
    };

export function claimProcessingGuard(tickName: string): ProcessingGuardClaim {
  const now = Date.now();
  let reclaimedAfterMs: number | null = null;

  if (runningProcessingPass !== null) {
    const sinceProgressMs = now - runningProcessingPass.lastProgressAt;
    if (sinceProgressMs < PROCESS_WEDGE_NO_PROGRESS_MS) {
      return {
        claimed: false,
        passAgeMs: now - runningProcessingPass.startedAt,
        sinceProgressMs,
      };
    }
    reclaimedAfterMs = now - runningProcessingPass.startedAt;
    logger.error(
      {
        tickName,
        passAgeMs: reclaimedAfterMs,
        sinceProgressMs,
        limitMs: PROCESS_WEDGE_NO_PROGRESS_MS,
      },
      "Follow-up processing pass finished no row within the wedge limit — reclaiming the overlap guard",
    );
  }

  const pass: ProcessingPass = { startedAt: now, lastProgressAt: now };
  runningProcessingPass = pass;

  return {
    claimed: true,
    reclaimedAfterMs,
    onProgress: () => {
      pass.lastProgressAt = Date.now();
    },
    // Identity token, mirroring the sync guard: if the pass we displaced ever
    // returns, its release must not clear the guard THIS pass is holding.
    release: () => {
      if (runningProcessingPass === pass) runningProcessingPass = null;
    },
  };
}

/** Test seam: the guard is module state, and a test must be able to reset it. */
export function __resetProcessingGuardForTests(): void {
  runningProcessingPass = null;
}

/**
 * Test seam: age the pass that is ALREADY running, in place.
 *
 * Distinct from __setWedgedPassForTests on purpose: that one installs a fresh
 * pass object, which severs the identity a live claim's release() closes over.
 * A test about the identity token has to age the very object the claim holds.
 */
export function __ageCurrentPassForTests(byMs: number): void {
  if (runningProcessingPass === null) return;
  runningProcessingPass.startedAt -= byMs;
  runningProcessingPass.lastProgressAt -= byMs;
}

/** Test seam: pretend a pass is running and last made progress `agoMs` ago. */
export function __setWedgedPassForTests(agoMs: number): void {
  const now = Date.now();
  runningProcessingPass = { startedAt: now - agoMs, lastProgressAt: now - agoMs };
}
