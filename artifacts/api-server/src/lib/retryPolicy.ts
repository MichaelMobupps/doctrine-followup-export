/**
 * retryPolicy.ts — F-3.6a.
 *
 * Pure decisions for what happens to a follow-up row that has FAILED. No DB,
 * no network, no @workspace/db import.
 *
 * WHAT THIS REPLACES
 *
 * `failed` is not in ACTIVE_FOLLOWUP_STATUSES, so autoQueueAllCampaigns —
 * which runs every 15 minutes — found every failed row "inactive" and had
 * queueStageForProspect revive it in place: status back to `queued`,
 * errorMessage nulled, generatedBody/generatedSubject nulled, scheduledAt
 * pushed to now+1h.
 *
 * Two consequences, both confirmed in production on 2026-08-09 (F-D4):
 *   1. Every failure erased its own evidence within 15 minutes. The whole
 *      fleet showed TWO failed rows — and both survived only because their
 *      owner is admin-paused, the one state auto-queue skips.
 *   2. The revive loop regenerated from scratch every hour against six dead
 *      Gmail grants: 196 follow-ups, zero sends, $4.45 of a $5.95 week. One
 *      account spent 1,278 LLM calls on 49 follow-ups — 26 per follow-up.
 *
 * Revival is now a bounded policy with the evidence kept on the row.
 */

// `import type` — erased at compile time, so this file pulls in NO runtime
// module. @workspace/db throws at import unless DATABASE_URL is set; keeping
// this file free of runtime db imports is what lets its tests be hermetic.
import type { FollowupFailureRecord } from "@workspace/db";

/**
 * Automatic retries allowed per row, per failure class that earns a strike.
 *
 * Two, not more: a third attempt has never once succeeded in the observed
 * data where the first two failed for the same cause, and each attempt costs
 * a full generation. A row that exhausts them stays `failed` and VISIBLE —
 * which is the point. Silence was the bug.
 */
export const MAX_AUTO_RETRIES = 2;

/**
 * Which failure class a thrown per-row error belongs to.
 *
 * `gmailArtifactId` is non-null only once a Gmail call has SUCCEEDED — a
 * message sent or a draft created — and before the status write landed. In
 * that window the email exists in the client's inbox while the row still
 * says `queued`, so a failure there must be terminal: retrying it delivers a
 * second copy. That outranks everything, including an auth error, because
 * the consequence is a duplicate in someone's inbox rather than a wasted
 * generation.
 *
 * It is the same hazard RH-1 reasoned about for rows stuck six hours in
 * `generating`, caught in-process instead, so it carries the same reason and
 * inherits the same terminal treatment from decideFailedRowAction.
 */
export function classifyProcessingFailure(args: {
  gmailArtifactId: string | null | undefined;
  isAuthFailure: boolean;
}): "stranded" | "auth_dead" | "send_error" {
  if (args.gmailArtifactId) return "stranded";
  if (args.isAuthFailure) return "auth_dead";
  return "send_error";
}

export type HoldReason =
  /** Owner's grant is refused by Google. Resumes automatically when it heals. */
  | "auth_dead"
  /** Died between the Gmail send and the status write. Needs a human. */
  | "stranded_needs_human"
  /** Spent both automatic retries. Needs a human. */
  | "retries_exhausted";

export type RetryDecision =
  | { action: "retry"; nextRetryCount: number }
  | { action: "hold"; reason: HoldReason };

/**
 * Should this failed row be revived by the next auto-queue pass?
 *
 * Order of the guards is load-bearing.
 *
 * `stranded` is checked FIRST and is terminal. RH-1 made the stranded
 * detector deliberately non-repairing for a reason that has not gone away:
 * a row can strand AFTER the Gmail send but BEFORE the status write, so an
 * automatic re-queue may put a second copy of the same email in a client's
 * inbox. F-3.6a moves stranded rows out of `generating` (which froze the
 * campaign invisibly) into a visible, counted `failed` — but it does NOT
 * hand them to the retry loop. The operator checks the thread and either
 * marks it sent or pushes it through Send-Now, which is an explicit human
 * choice and bypasses this policy by design.
 *
 * `auth_dead` holds while the grant is dead and then retries WITHOUT
 * spending a strike: the row did nothing wrong, its owner's token did, and
 * charging it a retry would mean a reconnected account silently drops
 * follow-ups that had two dead-grant attempts against them.
 */
export function decideFailedRowAction(args: {
  retryCount: number;
  failureReason: string | null | undefined;
  ownerAuthDead: boolean;
}): RetryDecision {
  if (args.failureReason === "stranded") {
    return { action: "hold", reason: "stranded_needs_human" };
  }
  if (args.ownerAuthDead) {
    return { action: "hold", reason: "auth_dead" };
  }
  if (args.failureReason === "auth_dead") {
    // The grant healed. Retry, no strike.
    return { action: "retry", nextRetryCount: Math.max(0, args.retryCount) };
  }
  if (args.retryCount >= MAX_AUTO_RETRIES) {
    return { action: "hold", reason: "retries_exhausted" };
  }
  return { action: "retry", nextRetryCount: args.retryCount + 1 };
}

/** Longest error text kept per history entry. Provider errors can be huge. */
export const MAX_ERROR_TEXT = 500;

/** Most recent failures kept per row; older ones fall off the front. */
export const MAX_ERROR_HISTORY = 10;

/** Build one preserved failure record. */
export function makeFailureRecord(args: {
  reason: string;
  error: string;
  attempt: number;
  now: Date;
}): FollowupFailureRecord {
  return {
    at: args.now.toISOString(),
    reason: args.reason,
    error: truncate(args.error, MAX_ERROR_TEXT),
    attempt: Math.max(0, Math.trunc(args.attempt)),
  };
}

/**
 * Append a failure to a row's history, oldest-first, capped.
 *
 * Tolerant of a null/garbage column: `error_history` is jsonb and nothing
 * stops a hand-written UPDATE from putting an object there. A malformed
 * value is replaced rather than thrown on — losing stale history is a much
 * smaller harm than a cron tick that dies mid-pass.
 */
export function appendFailure(
  history: unknown,
  record: FollowupFailureRecord,
  cap: number = MAX_ERROR_HISTORY,
): FollowupFailureRecord[] {
  const prior = Array.isArray(history) ? (history as FollowupFailureRecord[]) : [];
  const next = [...prior, record];
  const limit = Math.max(1, Math.trunc(cap));
  return next.length > limit ? next.slice(next.length - limit) : next;
}

function truncate(s: string, max: number): string {
  const text = typeof s === "string" ? s : String(s);
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
