/**
 * strandedGenerating.ts — F-3.6a.
 *
 * Pure classifier for follow-ups stranded in `generating`. No DB, no network.
 *
 * A row reaches `generating` when the scheduler claims it, and leaves when
 * the send/draft/approval write lands. If the process dies in between — a
 * republish, an OOM, a pool error — the row stays `generating` for ever.
 * That is worse than a visible failure: `generating` is in
 * ACTIVE_FOLLOWUP_STATUSES, so auto-queue treats the campaign as busy and
 * never schedules another stage. The campaign is frozen, silently.
 *
 * RH-1 (2026-06-08) added the detector. It logged, counted, and wrote the
 * count into a heartbeat nobody could read, and deliberately did NOT repair:
 * a row can strand AFTER the Gmail send and BEFORE the status write, so an
 * automatic re-queue may deliver a second copy to the client.
 *
 * F-3.6a keeps that safety rule and fixes the visibility: the row moves to
 * `failed` with reason `stranded`, which unfreezes the campaign and puts the
 * row on the admin surface — but `stranded` is terminal for the retry policy
 * (see retryPolicy.decideFailedRowAction), so nothing is auto-resent. A
 * human resolves it from the pipeline: mark sent if the thread shows it went
 * out, Send-Now if it did not.
 */

/**
 * Hours a row may sit in `generating` before it is considered stranded.
 *
 * Unchanged from RH-1. The longest legitimate generation observed is a
 * multi-call heal chain measured in minutes; six hours is two orders of
 * magnitude clear of it, which is what keeps this safe to act on.
 */
export const GENERATING_STRAND_HOURS = 6;

export interface GeneratingRow {
  status: string;
  /**
   * The row's scheduled time — what RH-1 measures age from, kept for
   * continuity. It is the instant the row became due, and the claim follows
   * within one tick, so it is never later than the claim by more than a few
   * minutes and can only ever make this classifier MORE conservative.
   */
  scheduledAt: Date;
}

/** The cutoff instant: rows scheduled before this and still generating are stranded. */
export function strandedCutoff(now: Date, thresholdHours: number = GENERATING_STRAND_HOURS): Date {
  return new Date(now.getTime() - thresholdHours * 60 * 60 * 1000);
}

export function isStrandedGenerating(
  row: GeneratingRow,
  now: Date,
  thresholdHours: number = GENERATING_STRAND_HOURS,
): boolean {
  if (row.status !== "generating") return false;
  return row.scheduledAt.getTime() < strandedCutoff(now, thresholdHours).getTime();
}

/** The error text written onto a recovered row. Stated in operator language. */
export function strandedErrorMessage(
  scheduledAt: Date,
  now: Date,
  thresholdHours: number = GENERATING_STRAND_HOURS,
): string {
  const hours = Math.floor((now.getTime() - scheduledAt.getTime()) / (60 * 60 * 1000));
  return (
    `Stranded in 'generating' for ${hours}h (threshold ${thresholdHours}h): the process died between ` +
    `claiming this follow-up and writing its result. NOT retried automatically — the send may ` +
    `already have gone out. Check the Gmail thread: mark sent if it did, Send-Now if it did not.`
  );
}
