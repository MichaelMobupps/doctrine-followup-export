/**
 * dueEligibility.ts — F-3.6a.
 *
 * The due-batch selection rules, as pure functions. No DB, no network.
 *
 * ONE implementation, two consumers: `processDueFollowups()` builds its SQL
 * WHERE clause from the same rules this file states, and the tests drive
 * these functions directly with a fixture. Same discipline as
 * `legacyRedirectTarget()` — a rule that lives in two places drifts.
 *
 * THE STARVATION THIS FIXES
 *
 * The due query selects `queued AND scheduled_at <= now AND replied = 0 AND
 * followup_paused = false`, orders by scheduled_at ascending, and takes 20.
 * Admin-paused users were filtered nowhere in that query — only INSIDE the
 * processing loop, by a `continue`.
 *
 * On 2026-08-09 the fifteen oldest eligible rows in the entire system all
 * belonged to one admin-paused account (F-D4). They were selected on every
 * tick and skipped on every tick, so 15 of every 20 slots did nothing, for
 * ever, and rows behind them were never reached. Auth-dead users were about
 * to do the same thing, worse: their rows were not skipped at all, they were
 * generated and then failed.
 *
 * The fix is to move the held-user test into the query. Ordering and the
 * 20-row batch size are deliberately unchanged.
 */

/** Rows per processing pass. Unchanged from pre-F-3.6a. */
export const DUE_BATCH_LIMIT = 20;

/**
 * The fields the due decision reads. Mirrors the joined shape of
 * followups × prospects × users.
 */
export interface DueCandidate {
  followupId: number;
  status: string;
  scheduledAt: Date;
  prospectReplied: number;
  prospectApp: string;
  prospectPaused: boolean;
  /** Null for legacy rows that predate multi-user. They must still process. */
  userId: number | null;
  userPausedByAdmin: boolean;
  userAuthDead: boolean;
}

export interface DueOptions {
  /**
   * Whether held users (admin-paused, auth-dead) are excluded at SELECT time.
   *
   * Production always passes true — it is the fix. The tests pass false to
   * reproduce the pre-F-3.6a behaviour against the same fixture, so the
   * starvation is demonstrated rather than asserted, and there is still only
   * one implementation of the rules.
   */
  excludeHeldUsers?: boolean;
}

/** True when a user's rows must not be selected or processed. */
export function isUserHeld(row: Pick<DueCandidate, "userId" | "userPausedByAdmin" | "userAuthDead">): boolean {
  // A legacy row with no user has no user-level hold to apply. It is governed
  // by the prospect-level gates alone, exactly as before F-3.6a. An INNER
  // JOIN here would have silently dropped every one of these rows.
  if (row.userId === null || row.userId === undefined) return false;
  return row.userPausedByAdmin || row.userAuthDead;
}

/**
 * The SELECT-time predicate.
 *
 * anti_ghosting prospects bypass the replied gate (B9b.12.5: manually-resumed
 * replied threads are legitimate AG work). The pause gate is universal.
 */
export function isDueRowEligible(
  row: DueCandidate,
  now: Date,
  options: DueOptions = {},
): boolean {
  const excludeHeld = options.excludeHeldUsers !== false;

  if (row.status !== "queued") return false;
  if (row.scheduledAt.getTime() > now.getTime()) return false;
  if (row.prospectPaused) return false;
  if (row.prospectReplied !== 0 && row.prospectApp !== "anti_ghosting") return false;
  if (excludeHeld && isUserHeld(row)) return false;

  return true;
}

/**
 * True when the processing loop will do real work on a selected row.
 *
 * The in-loop guards stay in the scheduler as defence in depth (they also
 * cover the forceSend path, which bypasses the batch query entirely). This
 * function is what makes "selected but useless" measurable: a healthy batch
 * has selected === processable.
 */
export function isProcessableInLoop(row: DueCandidate): boolean {
  return !isUserHeld(row);
}

/**
 * Select one batch the way the SQL does: filter, oldest-first, take `limit`.
 *
 * Ordering is by scheduledAt ascending with followupId as a tiebreaker, so a
 * fixture is deterministic; the SQL's ORDER BY scheduled_at is stable enough
 * in production and unchanged by this order.
 */
export function selectDueBatch(
  rows: DueCandidate[],
  now: Date,
  limit: number = DUE_BATCH_LIMIT,
  options: DueOptions = {},
): DueCandidate[] {
  return rows
    .filter((r) => isDueRowEligible(r, now, options))
    .sort((a, b) => {
      const d = a.scheduledAt.getTime() - b.scheduledAt.getTime();
      return d !== 0 ? d : a.followupId - b.followupId;
    })
    .slice(0, Math.max(0, Math.trunc(limit)));
}

/**
 * How much of a batch is real work. `wasted` is the starvation measure:
 * 15 of 20 before this order, 0 after.
 */
export function batchUtilisation(batch: DueCandidate[]): {
  selected: number;
  processable: number;
  wasted: number;
} {
  const processable = batch.filter(isProcessableInLoop).length;
  return { selected: batch.length, processable, wasted: batch.length - processable };
}
