import { gmail_v1 } from "googleapis";
import { and, eq, inArray, not } from "drizzle-orm";
import { db, followupsTable, prospectsTable } from "@workspace/db";
import {
  getHeaderValueHelper,
  getMessageSentAtHelper,
  isOutboundMessage,
  extractPlainTextFromPayloadHelper,
  extractEmail,
  extractName,
} from "./gmailClient";

/**
 * B9b: AntiGhosting marking validators.
 *
 * Three validators run in design order, short-circuiting on first failure:
 *
 *   1. mostRecentIsOutbound — last message in the thread is from the user
 *      (i.e., the prospect is the one ghosting, not the other way round).
 *      Failure means the prospect already replied — operator should respond
 *      manually, not start an AntiGhosting cycle.
 *
 *   2. threadHasInbound — thread contains at least one reply from the prospect.
 *      Failure means there is no relationship to re-engage; this is a cold
 *      thread that belongs in Doctrine, not AntiGhosting.
 *
 *   3. mostRecentOutboundNotInFollowups — the seed message was not sent by
 *      an automated follow-up campaign. Failure means an active Doctrine or
 *      Context campaign is already running on this thread; marking it for
 *      AntiGhosting would double-send.
 *
 * The validator returns the parsed thread messages alongside the verdict,
 * so the /mark endpoint can avoid re-fetching the thread before sync.
 */

export interface ThreadMessageBrief {
  /** Gmail message ID. */
  id: string;
  sentAt: Date;
  fromHeader: string;
  /** Email address extracted from `fromHeader`. */
  fromEmail: string;
  /** Display name extracted from `fromHeader`. */
  fromName: string;
  subject: string;
  /** Gmail snippet (preview text). */
  snippet: string;
  /** Decoded plain-text body, best-effort. */
  body: string;
  direction: "inbound" | "outbound";
}

export interface ValidatorResults {
  mostRecentIsOutbound: boolean;
  threadHasInbound: boolean;
  mostRecentOutboundNotInFollowups: boolean;
}

export interface ValidationOutcome {
  ok: boolean;
  results: ValidatorResults;
  /** The most recent outbound, used as the seed if validators pass. Null on early failure. */
  seed: ThreadMessageBrief | null;
  /** The other party in the conversation (most recent inbound's sender). Null if no inbound exists. */
  prospect: { email: string; name: string } | null;
  /** Full chronological thread, oldest first. Empty on fetch failure. */
  threadMessages: ThreadMessageBrief[];
  /** Operator-facing failure message, populated only when ok is false. */
  failureReason: string | null;
}

/**
 * Fetch a Gmail thread and parse its messages into ThreadMessageBrief[].
 * Pure data extraction — no DB writes. Used by both the validator and
 * (indirectly via syncThreadFromGmail) the marking endpoint's persistence
 * step.
 */
export async function parseGmailThread(
  gmail: gmail_v1.Gmail,
  gmailThreadId: string,
  userEmail: string,
): Promise<ThreadMessageBrief[]> {
  const threadRes = await gmail.users.threads.get({
    userId: "me",
    id: gmailThreadId,
    format: "full",
  });

  const messages = threadRes.data.messages || [];
  const briefs: ThreadMessageBrief[] = [];

  for (const msg of messages) {
    if (!msg.id) continue;
    // 2026-07-29: skip drafts. threads.get returns them in-thread, and an
    // open draft is usually the chronologically last "message" — without
    // this skip it either failed Validator 1 ("most recent message is from
    // the prospect") or, worse, was picked as the most-recent-inbound so the
    // "prospect" identity became the operator's own address.
    if ((msg.labelIds ?? []).includes("DRAFT")) continue;
    const sentAt = getMessageSentAtHelper(msg);
    if (!sentAt) continue;

    const fromHeader = getHeaderValueHelper(msg.payload?.headers, "From") || "";
    briefs.push({
      id: msg.id,
      sentAt,
      fromHeader,
      fromEmail: extractEmail(fromHeader),
      fromName: extractName(fromHeader),
      subject: getHeaderValueHelper(msg.payload?.headers, "Subject") || "",
      snippet: msg.snippet || "",
      body: extractPlainTextFromPayloadHelper(msg.payload),
      // 2026-07-29 direction-hardening: SENT-label-aware (alias-proof). The
      // old From-header substring check classified the operator's own
      // alias-sent replies as inbound, which made Validator 1 reject
      // correctly-labeled ghosted threads with "most recent message is from
      // the prospect".
      direction: isOutboundMessage(msg, userEmail) ? "outbound" : "inbound",
    });
  }

  // Sort chronologically, oldest first. Gmail usually returns this order
  // already but the API does not guarantee it.
  briefs.sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime());
  return briefs;
}

/**
 * Run the three AntiGhosting marking validators against a Gmail thread.
 * Short-circuits on first failure for response speed.
 *
 * @param gmailThreadId  Gmail thread to validate.
 * @param gmail          Authenticated Gmail client for the user.
 * @param userEmail      The user's email (used to classify outbound vs inbound).
 * @param userId         DB user ID (used for the followups lookup in validator 3).
 */
export async function validateThreadForMarking(
  gmailThreadId: string,
  gmail: gmail_v1.Gmail,
  userEmail: string,
  userId: number,
): Promise<ValidationOutcome> {
  const results: ValidatorResults = {
    mostRecentIsOutbound: false,
    threadHasInbound: false,
    mostRecentOutboundNotInFollowups: false,
  };

  let threadMessages: ThreadMessageBrief[] = [];
  try {
    threadMessages = await parseGmailThread(gmail, gmailThreadId, userEmail);
  } catch (err) {
    return {
      ok: false,
      results,
      seed: null,
      prospect: null,
      threadMessages: [],
      failureReason: `Failed to fetch thread from Gmail: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (threadMessages.length === 0) {
    return {
      ok: false,
      results,
      seed: null,
      prospect: null,
      threadMessages: [],
      failureReason: "Thread has no parseable messages",
    };
  }

  // Identify the other party from the most recent inbound (the prospect),
  // falling back to the most recent message if no inbound exists. This is
  // populated even on failure paths so the dashboard can show whom we
  // were going to re-engage.
  const mostRecentInbound = [...threadMessages].reverse().find((m) => m.direction === "inbound");
  const prospect = mostRecentInbound
    ? { email: mostRecentInbound.fromEmail, name: mostRecentInbound.fromName }
    : null;

  // Validator 1: most recent message is outbound.
  const mostRecent = threadMessages[threadMessages.length - 1];
  results.mostRecentIsOutbound = mostRecent.direction === "outbound";
  if (!results.mostRecentIsOutbound) {
    return {
      ok: false,
      results,
      seed: null,
      prospect,
      threadMessages,
      failureReason: "Most recent message in the thread is from the prospect. Reply manually first, then mark for AntiGhosting if no further reply comes.",
    };
  }

  // Validator 2: thread has at least one inbound.
  results.threadHasInbound = threadMessages.some((b) => b.direction === "inbound");
  if (!results.threadHasInbound) {
    return {
      ok: false,
      results,
      seed: null,
      prospect,
      threadMessages,
      failureReason: "Thread has no replies from the prospect. AntiGhosting is for re-engaging conversations that have already had at least one exchange; this looks like a cold outreach that belongs in Doctrine.",
    };
  }

  // Validator 3 (B9b.5 refinement): no active follow-up campaign is
  // running on this thread. The original B9b check was "most recent
  // outbound is not in followups" — too strict, because a completed
  // Doctrine campaign (all status='sent') still has its outbound
  // message IDs in followups, so AntiGhosting refused to ingest. The
  // refined check asks: does any prospect for this thread have a
  // follow-up in a non-terminal status? Terminal = sent/cancelled/
  // failed (campaign is done). Non-terminal = queued, generating,
  // drafted, pending_approval, stalled_awaiting_manual_send, or any
  // future status that defaults to "still in flight". Failing safe
  // on unknowns avoids accidental double-sends.
  //
  // The ValidatorResults field name is preserved despite the
  // semantics shift — the dashboard chip already reads "Not already
  // in active follow-up", which describes the new check accurately.
  const activeFollowups = await db
    .select({ id: followupsTable.id })
    .from(followupsTable)
    .innerJoin(prospectsTable, eq(prospectsTable.id, followupsTable.prospectId))
    .where(
      and(
        eq(prospectsTable.userId, userId),
        eq(prospectsTable.gmailThreadId, gmailThreadId),
        not(inArray(followupsTable.status, ["sent", "cancelled", "failed"])),
      ),
    )
    .limit(1);

  results.mostRecentOutboundNotInFollowups = activeFollowups.length === 0;
  if (!results.mostRecentOutboundNotInFollowups) {
    return {
      ok: false,
      results,
      seed: null,
      prospect,
      threadMessages,
      failureReason: "An active follow-up campaign (Doctrine or Context) is still running on this thread. AntiGhosting will be available once that campaign completes, is cancelled, or stops on its own.",
    };
  }

  return {
    ok: true,
    results,
    seed: mostRecent,
    prospect,
    threadMessages,
    failureReason: null,
  };
}
