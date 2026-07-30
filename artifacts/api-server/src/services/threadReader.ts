/**
 * threadReader.ts — Batch B9a
 *
 * Read and sync support for the AntiGhosting Followuper. Two public
 * surfaces:
 *
 *   getThreadMessages(prospectId)
 *     Returns every thread_messages row for a prospect, ordered
 *     chronologically (oldest first). The AntiGhosting generator reads
 *     this to compose follow-ups that acknowledge the last touchpoint
 *     and bridge to a fresh ask.
 *
 *   syncThreadFromGmail(prospectId, gmail, userEmail)
 *     Fetches the full Gmail thread for the prospect, normalises each
 *     message (direction, headers, body, snippet), and upserts into
 *     thread_messages. Idempotent on gmail_message_id.
 *
 * The doctrine/context generators do NOT use this module — they read
 * the seed email body from prospects.original_body and stop there.
 * Only AntiGhosting needs the chronological history.
 *
 * Direction classification rule
 * ─────────────────────────────
 * A message is 'outbound' iff its From header contains the
 * authenticated user's email address (case-insensitive substring match,
 * matching the existing isFromSender heuristic used elsewhere in the
 * codebase). All other messages are 'inbound'. This correctly handles
 * Gmail aliases that include the user's primary email in angle
 * brackets ("Mike Goder <mike@mobupps.com>") and forwarded threads
 * where the From line includes the user as a CC'd party are NOT
 * misclassified because we only check the From, not To/CC.
 */

import { eq, asc } from "drizzle-orm";
import { gmail_v1 } from "googleapis";
import { db } from "@workspace/db";
import {
  prospectsTable,
  threadMessagesTable,
  type ThreadMessage,
  type ThreadMessageDirection,
  type InsertThreadMessage,
} from "@workspace/db";
import {
  getHeaderValueHelper,
  getMessageSentAtHelper,
  extractPlainTextFromPayloadHelper,
  isFromSenderHelper,
  isOutboundMessage,
} from "./gmailClient";
import { logger } from "../lib/logger";

// ──────────────────────────────────────────────────────────────────────
// Public surface
// ──────────────────────────────────────────────────────────────────────

/**
 * Return every thread_messages row for a prospect, ordered by sentAt
 * ascending (oldest first). Used by the AntiGhosting generator to
 * build chronological prompt context. Empty array if no messages have
 * been synced for this prospect yet.
 */
export async function getThreadMessages(prospectId: number): Promise<ThreadMessage[]> {
  return db
    .select()
    .from(threadMessagesTable)
    .where(eq(threadMessagesTable.prospectId, prospectId))
    .orderBy(asc(threadMessagesTable.sentAt));
}

export interface ThreadSyncResult {
  inserted: number;
  skipped: number;
  errors: number;
}

/**
 * Fetch the full Gmail thread for a prospect and upsert each message
 * into thread_messages. Idempotent on gmail_message_id.
 *
 * Failure modes that are non-fatal (logged + counted):
 *   - Individual message fetch fails: increment `errors`, continue.
 *   - Per-message DB insert violates unique constraint: increment
 *     `skipped`, continue.
 *
 * Failure modes that propagate:
 *   - The prospect does not exist or has no gmailThreadId.
 *   - The Gmail threads.get call fails outright (auth, rate limit,
 *     network).
 *
 * The caller is responsible for catching propagated errors and deciding
 * whether to retry.
 */
export async function syncThreadFromGmail(
  prospectId: number,
  gmail: gmail_v1.Gmail,
  userEmail: string,
): Promise<ThreadSyncResult> {
  const prospect = await db
    .select({
      id: prospectsTable.id,
      gmailThreadId: prospectsTable.gmailThreadId,
    })
    .from(prospectsTable)
    .where(eq(prospectsTable.id, prospectId))
    .limit(1)
    .then((rows) => rows[0]);

  if (!prospect) {
    throw new Error(`syncThreadFromGmail: prospect ${prospectId} not found`);
  }
  if (!prospect.gmailThreadId) {
    throw new Error(`syncThreadFromGmail: prospect ${prospectId} has no gmailThreadId`);
  }

  const threadRes = await gmail.users.threads.get({
    userId: "me",
    id: prospect.gmailThreadId,
    format: "full",
  });

  const messages = threadRes.data.messages || [];
  let inserted = 0;
  let skipped = 0;
  let errors = 0;

  for (const msg of messages) {
    if (!msg.id) {
      errors++;
      continue;
    }
    // 2026-07-29: never persist drafts into thread_messages. threads.get
    // returns them in-thread, and an unsent draft ingested as
    // direction:"inbound" would surface the operator's OWN draft text to
    // the follow-up generator as words the prospect wrote.
    if ((msg.labelIds ?? []).includes("DRAFT")) {
      skipped++;
      continue;
    }
    try {
      const insertRow = buildInsertRow(msg, prospect.id, prospect.gmailThreadId, userEmail);
      if (!insertRow) {
        errors++;
        continue;
      }
      const result = await db
        .insert(threadMessagesTable)
        .values(insertRow)
        .onConflictDoNothing({ target: threadMessagesTable.gmailMessageId });
      if (result.rowCount && result.rowCount > 0) {
        inserted++;
      } else {
        skipped++;
      }
    } catch (err) {
      errors++;
      logger.warn(
        { err, prospectId, gmailMessageId: msg.id },
        "B9a threadReader: per-message upsert failed",
      );
    }
  }

  logger.info(
    { prospectId, threadId: prospect.gmailThreadId, inserted, skipped, errors, totalSeen: messages.length },
    "B9a threadReader: thread sync complete",
  );

  return { inserted, skipped, errors };
}

// ──────────────────────────────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────────────────────────────

/**
 * Classify a message direction by comparing its From header to the
 * authenticated user's email. Outbound iff the user's email appears
 * (case-insensitive substring) anywhere in the From header.
 *
 * Exported for unit tests. The actual production code path goes through
 * buildInsertRow which calls this internally.
 */
export function classifyDirection(
  fromHeader: string,
  userEmail: string,
): ThreadMessageDirection {
  return isFromSenderHelper(fromHeader, userEmail) ? "outbound" : "inbound";
}

/**
 * Extract the plain-text body from a Gmail message payload. Tries
 * text/plain first, then falls back to text/html with tags stripped.
 * Returns empty string if neither part is present.
 *
 * Exported for unit tests; production code calls
 * extractPlainTextFromPayloadHelper directly via buildInsertRow.
 */
export function extractBodyText(payload?: gmail_v1.Schema$MessagePart): string {
  return extractPlainTextFromPayloadHelper(payload);
}

/**
 * Build the InsertThreadMessage row for a single Gmail Schema$Message.
 * Returns null if the message is structurally unusable (no sentAt or
 * no payload) so the caller can count it as an error and continue.
 */
function buildInsertRow(
  msg: gmail_v1.Schema$Message,
  prospectId: number,
  gmailThreadId: string,
  userEmail: string,
): InsertThreadMessage | null {
  if (!msg.id) return null;

  const sentAt = getMessageSentAtHelper(msg);
  if (!sentAt) {
    logger.warn(
      { gmailMessageId: msg.id, prospectId },
      "B9a threadReader: message has no parseable sentAt — skipping",
    );
    return null;
  }

  const fromHeader = getHeaderValueHelper(msg.payload?.headers, "From") || "";
  const subject = getHeaderValueHelper(msg.payload?.headers, "Subject") || "";
  const body = extractPlainTextFromPayloadHelper(msg.payload);
  // 2026-07-29 direction-hardening: prefer the Gmail SENT label (alias-proof)
  // over the From-header heuristic; classifyDirection stays as the fallback
  // inside isOutboundMessage and for unit tests.
  const direction = isOutboundMessage(msg, userEmail) ? "outbound" : "inbound";

  return {
    prospectId,
    gmailMessageId: msg.id,
    gmailThreadId,
    direction,
    sentAt,
    fromEmail: fromHeader,
    subject,
    snippet: msg.snippet || "",
    body,
  };
}
