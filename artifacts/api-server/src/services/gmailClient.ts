import { gmail_v1 } from "googleapis";
import { logger } from "../lib/logger";
import { classifyBounce, type BounceKind } from "../lib/bounceDetection";
import { isOutOfOffice, type AutoReplyHeaders } from "../lib/replyClassification";
import { newGoogleOAuthClient, newGmailClient } from "../lib/googleApi";
import {
  extractFontFromHtml,
  fontStyleAttr,
  buildBodyHtml,
  type InheritedFont,
} from "../lib/emailTypography";

export interface GmailMessageMeta {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  snippet: string;
  body: string;
  date: string;
  // Gmail's server-side receive timestamp (epoch millis as string).
  // Unlike the Date header (client-authored, occasionally malformed),
  // this is always present and always valid — sync uses it as the
  // fallback when the Date header does not parse.
  internalDate: string;
  labels: string[];
}

export interface GmailCredentials {
  refreshToken: string;
  email: string;
  name?: string;
}

function getAuth() {
  // F-3.7b: constructed through lib/googleApi so the OAuth token refresh —
  // made on the auth library's own transporter, which service options never
  // reach — is bounded too. An unbounded refresh hangs the row before the
  // API call is even attempted.
  return newGoogleOAuthClient();
}

export function getGmailForUser(creds: GmailCredentials): gmail_v1.Gmail {
  const auth = getAuth();
  auth.setCredentials({ refresh_token: creds.refreshToken });
  return newGmailClient(auth);
}

// ─── F-3.6b: `getGmail()` is deleted. ───────────────────────────────────
//
// It authorised with `process.env.GOOGLE_REFRESH_TOKEN` and every function
// below took `gmail?` so it could fall back to it. That made a shared mailbox
// the identity of last resort for the whole file: a caller that failed to
// resolve an owner did not fail, it silently sent, read or deleted as
// somebody else.
//
// The Gmail client is now a REQUIRED argument on every function here, so the
// compiler — not a code review — is what guarantees each call carries the
// account it belongs to. `getAuth()` above stays: the OAuth client id and
// secret are the app's own credentials and are used for the real per-user
// grant exchange.

export async function ensureLabelsExist(
  labelNames: string[],
  gmail: gmail_v1.Gmail,
): Promise<Map<string, string>> {
  const labelIdToName = new Map<string, string>();
  try {
    const res = await gmail.users.labels.list({ userId: "me" });
    const allLabels = res.data.labels || [];
    const existing = new Set(
      allLabels.map((l) => l.name?.toLowerCase()).filter(Boolean),
    );

    for (const l of allLabels) {
      if (l.id && l.name) {
        labelIdToName.set(l.id, l.name);
      }
    }

    for (const name of labelNames) {
      if (existing.has(name.toLowerCase())) continue;
      try {
        const created = await gmail.users.labels.create({
          userId: "me",
          requestBody: {
            name,
            labelListVisibility: "labelShow",
            messageListVisibility: "show",
          },
        });
        logger.info({ label: name }, "Created missing Gmail label");
        if (created.data.id && created.data.name) {
          labelIdToName.set(created.data.id, created.data.name);
        }
      } catch (err: any) {
        if (err.code === 409) {
          logger.debug({ label: name }, "Label already exists (conflict)");
        } else {
          logger.error({ err, label: name }, "Failed to create Gmail label");
        }
      }
    }
  } catch (err) {
    logger.error({ err }, "Failed to list Gmail labels for auto-creation");
  }
  return labelIdToName;
}

/**
 * Parse the sent-at timestamp for an ingested message. The Date header is
 * client-authored and occasionally malformed (external sequencers, localized
 * formats); before this guard existed, a single bad header made
 * `new Date(msg.date)` produce an Invalid Date, the prospects INSERT threw,
 * and the user's ENTIRE sync pass aborted — permanently, every tick.
 * Fallback order: Date header → Gmail internalDate (server-side, always
 * valid) → now.
 */
export function safeSentAt(msg: { date: string; internalDate: string }): Date {
  const fromHeader = new Date(msg.date);
  if (!isNaN(fromHeader.getTime())) return fromHeader;
  const millis = parseInt(msg.internalDate, 10);
  if (Number.isFinite(millis) && millis > 0) return new Date(millis);
  return new Date();
}

export interface FetchLabeledResult {
  messages: GmailMessageMeta[];
  // How many listed message IDs were skipped because the caller already
  // has them (skipIds). Logged by sync so ingest volume stays observable.
  skippedKnown: number;
}

export async function fetchLabeledSentEmails(
  labels: string[],
  // Undefined means "no date bound"; it stays explicit rather than optional
  // because the Gmail client after it is required (F-3.6b).
  afterDate: string | undefined,
  gmail: gmail_v1.Gmail,
  // IDs the caller has already ingested. Passing this skips the expensive
  // per-message format:"full" fetch for every already-known message. Before
  // this existed, every 15-minute sync re-downloaded the full body of EVERY
  // labeled message in the 60-day window for EVERY user — thousands of
  // Gmail calls per tick, which is what stretched sync passes to hours.
  skipIds?: ReadonlySet<string>,
): Promise<FetchLabeledResult> {
  const labelQuery = labels.map((l) => `label:${l.replace(/\s+/g, "-")}`).join(" OR ");
  let q = `in:sent (${labelQuery})`;
  if (afterDate) {
    q += ` after:${afterDate}`;
  }

  const messages: GmailMessageMeta[] = [];
  let skippedKnown = 0;
  let pageToken: string | undefined;

  do {
    const res = await gmail.users.messages.list({
      userId: "me",
      q,
      maxResults: 100,
      pageToken,
    });

    const items = res.data.messages || [];
    for (const item of items) {
      if (!item.id) continue;
      if (skipIds?.has(item.id)) {
        skippedKnown++;
        continue;
      }
      try {
        const msg = await fetchMessageDetail(gmail, item.id);
        if (msg) messages.push(msg);
      } catch (err) {
        logger.error({ err, messageId: item.id }, "Failed to fetch message detail");
      }
    }

    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  return { messages, skippedKnown };
}

async function fetchMessageDetail(
  gmail: gmail_v1.Gmail,
  messageId: string,
): Promise<GmailMessageMeta | null> {
  const res = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "full",
  });

  const msg = res.data;
  if (!msg.id || !msg.threadId) return null;

  const headers = msg.payload?.headers || [];
  const getHeader = (name: string) =>
    headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || "";

  let body = "";
  const parts = msg.payload?.parts || [];
  if (msg.payload?.mimeType === "text/plain" && msg.payload?.body?.data) {
    body = Buffer.from(msg.payload.body.data, "base64").toString("utf-8");
  } else {
    for (const part of parts) {
      if (part.mimeType === "text/plain" && part.body?.data) {
        body = Buffer.from(part.body.data, "base64").toString("utf-8");
        break;
      }
    }
  }

  // Return the full decoded body. Downstream consumers (gmailSync ->
  // prepareOriginalBody) apply their own truncation cap (3000 chars) and
  // HTML/whitespace cleanup. Truncating here would silently defeat the
  // follow-up context pipeline that relies on the full body.
  const labelIds = msg.labelIds || [];

  return {
    id: msg.id,
    threadId: msg.threadId,
    from: getHeader("From"),
    to: getHeader("To"),
    subject: getHeader("Subject"),
    snippet: msg.snippet || "",
    body,
    date: getHeader("Date"),
    internalDate: msg.internalDate || "",
    labels: labelIds,
  };
}

export async function checkThreadForReplies(
  threadId: string,
  senderEmail: string,
  gmail: gmail_v1.Gmail,
): Promise<boolean> {
  const res = await gmail.users.threads.get({
    userId: "me",
    id: threadId,
    format: "metadata",
    metadataHeaders: ["From"],
  });

  const messages = res.data.messages || [];
  if (messages.length < 2) return false;

  for (const msg of messages) {
    // Drafts live inside the thread in Gmail's threads.get response but are
    // not conversation: never count them as replies (the scheduler's own
    // draft_in_gmail flow puts a draft in every campaign thread).
    if ((msg.labelIds ?? []).includes("DRAFT")) continue;
    // 2026-07-29 direction-hardening: SENT-label-aware outbound check, so an
    // operator's own alias-sent message is never miscounted as a reply.
    if (!isOutboundMessage(msg, senderEmail)) {
      return true;
    }
  }

  return false;
}

export type ThreadInboundKind = "none" | "reply" | "bounce" | "ooo";

export interface ThreadInboundVerdict {
  kind: ThreadInboundKind;
  // populated when kind === 'bounce'
  bounceType?: BounceKind;
  bounceDetail?: string;
  // Gmail message id of the latest inbound message worth classifying.
  // For kind === 'reply' this is the latest genuine (non-OOO, non-bounce)
  // human inbound — the message the sentiment classifier should read. For
  // kind === 'ooo' it is the latest auto-reply. null for 'none'/'bounce'.
  latestInboundMessageId?: string | null;
}

/**
 * Classify the inbound activity on a thread.
 *
 * Walks the thread once (cheap metadata + snippet, no body fetch) and returns:
 *   - 'bounce' if any inbound message is a delivery-failure / NDR. The bounce
 *     class (hard|soft) and a short detail string come back too.
 *   - 'reply'  if there is a genuine human inbound from someone other than the
 *     sender that is NOT a bounce and NOT an out-of-office auto-reply.
 *   - 'ooo'    if the only non-bounce inbound messages are out-of-office
 *     auto-replies. The prospect did not actually respond; follow-ups continue.
 *   - 'none'   if the thread only contains the sender's own messages.
 *
 * Bounce wins over everything: if a thread contains both a daemon NDR and some
 * other inbound, the bounce verdict is returned because the address is bad.
 * A genuine human reply wins over OOO: an OOO followed later by a real reply
 * classifies as 'reply'.
 *
 * OOO detection here is a fast first pass on subject + snippet + auto-reply
 * headers. The authoritative body-level check runs later in replySentiment.
 */
export async function classifyThreadInbound(
  threadId: string,
  senderEmail: string,
  gmail: gmail_v1.Gmail,
): Promise<ThreadInboundVerdict> {
  const res = await gmail.users.threads.get({
    userId: "me",
    id: threadId,
    format: "metadata",
    metadataHeaders: [
      "From",
      "Subject",
      // Auto-reply signals for the first-pass OOO check.
      "Auto-Submitted",
      "X-Autoreply",
      "X-Autorespond",
      "Precedence",
    ],
  });

  const messages = res.data.messages || [];
  if (messages.length < 2) return { kind: "none" };

  let sawHumanReply = false;
  let sawInbound = false;
  // Track latest inbound by Gmail's chronological thread order (oldest first):
  // the last match wins. Prefer the latest genuine human reply; fall back to
  // the latest auto-reply when no human reply exists.
  let latestHumanInboundId: string | null = null;
  let latestInboundId: string | null = null;

  for (const msg of messages) {
    const from = getHeaderValue(msg.payload?.headers, "From");
    // Skip drafts entirely: threads.get returns them in-thread, and the
    // draft_in_gmail flow guarantees one per campaign thread. A draft is
    // neither outbound-sent nor a prospect reply — without this skip, the
    // operator's own unsent draft classified as a "reply" one tick after
    // it was created, pausing the campaign and cancelling the follow-up.
    if ((msg.labelIds ?? []).includes("DRAFT")) continue;
    // Skip the sender's own outbound messages. 2026-07-29 direction-hardening:
    // SENT-label-aware, so a follow-up sent from a send-as alias
    // (michael.a.g@... while connected as michael@...) is recognized as our
    // own message instead of being classified as a prospect reply — the old
    // substring check silently stamped replied=1 + followup_paused on such
    // threads and froze their campaigns.
    if (isOutboundMessage(msg, senderEmail)) continue;

    const subject = getHeaderValue(msg.payload?.headers, "Subject");
    const snippet = msg.snippet || "";

    const verdict = classifyBounce(from, subject, snippet);
    if (verdict.isBounce) {
      return { kind: "bounce", bounceType: verdict.kind, bounceDetail: verdict.detail };
    }

    // Inbound from a non-sender that is not a bounce.
    sawInbound = true;
    if (msg.id) latestInboundId = msg.id;

    const autoHeaders: AutoReplyHeaders = {
      autoSubmitted: getHeaderValue(msg.payload?.headers, "Auto-Submitted"),
      xAutoreply: getHeaderValue(msg.payload?.headers, "X-Autoreply"),
      xAutorespond: getHeaderValue(msg.payload?.headers, "X-Autorespond"),
      precedence: getHeaderValue(msg.payload?.headers, "Precedence"),
    };

    if (isOutOfOffice(subject, snippet, autoHeaders)) {
      // Auto-reply; not a human response. Recorded as inbound but does not
      // make the thread a 'reply'.
      continue;
    }

    // A genuine human reply.
    sawHumanReply = true;
    if (msg.id) latestHumanInboundId = msg.id;
  }

  if (sawHumanReply) {
    return { kind: "reply", latestInboundMessageId: latestHumanInboundId ?? latestInboundId };
  }
  if (sawInbound) {
    // Every non-bounce inbound was an out-of-office.
    return { kind: "ooo", latestInboundMessageId: latestInboundId };
  }
  return { kind: "none" };
}

function mimeEncodeHeader(value: string): string {
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  const encoded = Buffer.from(value, "utf-8").toString("base64");
  return `=?UTF-8?B?${encoded}?=`;
}

async function getGmailSignatureHtml(gmail: gmail_v1.Gmail, senderEmail: string): Promise<string> {
  try {
    const res = await gmail.users.settings.sendAs.get({
      userId: "me",
      sendAsEmail: senderEmail,
    });
    return res.data.signature || "";
  } catch {
    return "";
  }
}

/**
 * The two things the reply needs from the message it is answering: its
 * RFC822 Message-ID (for threading) and the font it was composed in.
 *
 * Both come from one `format: "full"` fetch. They used to be two calls —
 * a metadata fetch for the id, and the font read added alongside it — and
 * one message cannot need two round trips to describe itself.
 *
 * The font is {} when the message declares none, when it has no HTML
 * part, or when the fetch fails. All three mean "declare no font either",
 * which renders the follow-up in the recipient's own client default
 * exactly as a hand-typed Gmail message does. The previous behaviour was
 * a hardcoded "Calibri Light", Calibri, sans-serif at 11pt on every
 * follow-up in every thread, which could and did render in a different
 * face from the email directly above it.
 */
async function readOriginalMessage(
  gmail: gmail_v1.Gmail,
  messageId: string,
): Promise<{ rfc822Id: string | null; font: InheritedFont }> {
  try {
    const msg = await gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "full",
    });
    const headers = msg.data.payload?.headers || [];
    const rfc822Id =
      headers.find((h) => h.name?.toLowerCase() === "message-id")?.value || null;
    const html = findHtmlPart(msg.data.payload);
    return { rfc822Id, font: html ? extractFontFromHtml(html) : {} };
  } catch (err) {
    logger.warn(
      { err: String(err), messageId },
      "Could not read the original message; threading falls back to the Gmail id and the follow-up sends in the recipient's default font",
    );
    return { rfc822Id: null, font: {} };
  }
}

/** Depth-first search for a message's text/html body part. */
function findHtmlPart(payload?: gmail_v1.Schema$MessagePart): string | null {
  if (!payload) return null;
  if (payload.mimeType === "text/html" && payload.body?.data) {
    return decodeGmailPart(payload.body.data);
  }
  for (const part of payload.parts || []) {
    const found = findHtmlPart(part);
    if (found) return found;
  }
  return null;
}

function encodeRawMessage(rawMessage: string): string {
  return Buffer.from(rawMessage)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function buildFollowupReplyRawMessage(params: {
  threadId: string;
  originalMessageId: string;
  to: string;
  subject: string;
  body: string;
  senderName: string;
  senderEmail: string;
  gmail: gmail_v1.Gmail;
  doctrineFollowupId?: number;
}): Promise<string> {
  const [signatureHtml, original] = await Promise.all([
    getGmailSignatureHtml(params.gmail, params.senderEmail),
    readOriginalMessage(params.gmail, params.originalMessageId),
  ]);
  const inReplyTo = original.rfc822Id || `<${params.originalMessageId}>`;
  const references = original.rfc822Id || `<${params.originalMessageId}>`;
  const inheritedFont = original.font;
  const bodyHtml = buildBodyHtml(params.body);
  // Empty when the original declared no font: we then declare none either
  // and the message renders in the recipient's client default.
  const fontStyle = fontStyleAttr(inheritedFont);
  const styleAttr = fontStyle ? ` style="${fontStyle}"` : "";
  const fullHtml = signatureHtml
    ? `<div dir="ltr"${styleAttr}>${bodyHtml}<div><br></div><div class="gmail_signature">${signatureHtml}</div></div>`
    : `<div dir="ltr"${styleAttr}>${bodyHtml}</div>`;

  const replySubject = params.subject.startsWith("Re:")
    ? params.subject
    : `Re: ${params.subject}`;

  const encodedSubject = mimeEncodeHeader(replySubject);
  const encodedSenderName = mimeEncodeHeader(params.senderName);
  const headers = [
    `From: ${encodedSenderName} <${params.senderEmail}>`,
    `To: ${params.to}`,
    `Subject: ${encodedSubject}`,
    `In-Reply-To: ${inReplyTo}`,
    `References: ${references}`,
  ];

  if (params.doctrineFollowupId) {
    headers.push(`X-Doctrine-Followup-Id: ${params.doctrineFollowupId}`);
  }

  headers.push(
    `MIME-Version: 1.0`,
    `Content-Type: text/html; charset="UTF-8"`,
    `Content-Transfer-Encoding: base64`,
    "",
    Buffer.from(fullHtml, "utf-8").toString("base64"),
  );

  return encodeRawMessage(headers.join("\r\n"));
}

export async function sendFollowupReply(params: {
  threadId: string;
  originalMessageId: string;
  to: string;
  subject: string;
  body: string;
  senderName: string;
  senderEmail: string;
  // F-3.6b: REQUIRED. A send with no per-user client used to fall back to the
  // shared `GOOGLE_REFRESH_TOKEN` mailbox, which is how an ownerless prospect
  // was delivered under an identity unrelated to its campaign.
  gmail: gmail_v1.Gmail;
}): Promise<string> {
  const gmail = params.gmail;
  const raw = await buildFollowupReplyRawMessage({ ...params, gmail });

  const res = await gmail.users.messages.send({
    userId: "me",
    requestBody: {
      raw,
      threadId: params.threadId,
    },
  });

  return res.data.id || "";
}

export async function createFollowupDraft(params: {
  followupId: number;
  threadId: string;
  originalMessageId: string;
  to: string;
  subject: string;
  body: string;
  senderName: string;
  senderEmail: string;
  // F-3.6b: REQUIRED — a draft lands in a real mailbox, so it needs a real owner.
  gmail: gmail_v1.Gmail;
}): Promise<{ draftId: string; messageId: string }> {
  const gmail = params.gmail;
  const raw = await buildFollowupReplyRawMessage({
    ...params,
    gmail,
    doctrineFollowupId: params.followupId,
  });

  const res = await gmail.users.drafts.create({
    userId: "me",
    requestBody: {
      message: {
        raw,
        threadId: params.threadId,
      },
    },
  });

  return {
    draftId: res.data.id || "",
    messageId: res.data.message?.id || "",
  };
}

export async function deleteDraft(params: {
  draftId: string | null | undefined;
  // F-3.6b: REQUIRED. Deleting is a mailbox mutation; the fallback made it
  // possible to delete out of the shared mailbox on behalf of a row whose
  // owner could not be resolved.
  gmail: gmail_v1.Gmail;
}): Promise<boolean> {
  if (!params.draftId) return false;
  const gmail = params.gmail;

  try {
    await gmail.users.drafts.delete({ userId: "me", id: params.draftId });
    return true;
  } catch (err: any) {
    if (err?.code === 404 || err?.response?.status === 404) {
      return false;
    }
    logger.error({ err, draftId: params.draftId }, "Failed to delete Gmail draft");
    return false;
  }
}

export interface ManualFollowupSendDetection {
  kind: "none" | "draft_sent" | "custom_outbound";
  messageId?: string;
  sentAt?: Date;
}

function getHeaderValue(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  name: string,
): string {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || "";
}

function isFromSender(fromHeader: string, senderEmail: string): boolean {
  const from = fromHeader.toLowerCase();
  const sender = senderEmail.toLowerCase();
  if (sender.length === 0) return false;
  // 2026-07-29 direction-hardening: compare the ADDRESS extracted from the
  // From header against the sender address, not a raw substring scan. The
  // substring check misfired both ways: a prospect whose display name quotes
  // the operator's address ("Assistant to michael@x" <other@y>) classified as
  // outbound, and it is fragile against header formatting in general. The
  // substring path is kept only as a fallback for headers extractEmail cannot
  // parse an address out of (extremely rare / malformed).
  const fromAddress = extractEmail(from);
  if (fromAddress.includes("@")) return fromAddress === sender;
  return from.includes(sender);
}

/**
 * 2026-07-29 direction-hardening: authoritative outbound check for a Gmail
 * message. A message carrying Gmail's SENT system label was sent from THIS
 * mailbox — regardless of which From address (send-as alias) it used. This is
 * exactly the failure mode of the header-only check: an operator sending from
 * an alias (michael.a.g@... while connected as michael@...) had their own
 * message classified as an inbound "prospect reply", which silently paused
 * campaigns (reply-scan) and failed AntiGhosting validators. The From-header
 * comparison remains as a fallback for messages without label metadata.
 * DRAFT-labeled messages are never outbound-SENT — but note that "not
 * outbound" must NOT be read as "inbound" for drafts: thread walkers skip
 * DRAFT messages entirely before calling this.
 */
export function isOutboundMessage(
  msg: Pick<gmail_v1.Schema$Message, "labelIds" | "payload">,
  senderEmail: string,
): boolean {
  const labels = msg.labelIds || [];
  if (labels.includes("DRAFT")) return false;
  if (labels.includes("SENT")) return true;
  return isFromSender(getHeaderValue(msg.payload?.headers, "From"), senderEmail);
}

function getMessageSentAt(msg: gmail_v1.Schema$Message): Date | null {
  if (msg.internalDate) {
    const internalMs = Number(msg.internalDate);
    if (Number.isFinite(internalMs) && internalMs > 0) return new Date(internalMs);
  }

  const dateHeader = getHeaderValue(msg.payload?.headers, "Date");
  const parsed = Date.parse(dateHeader);
  return Number.isFinite(parsed) ? new Date(parsed) : null;
}

function decodeGmailPart(data?: string | null): string {
  if (!data) return "";
  const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf-8");
}

function stripHtmlForComparison(value: string): string {
  return value
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function extractPlainTextFromPayload(payload?: gmail_v1.Schema$MessagePart): string {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return decodeGmailPart(payload.body.data);
  }
  if (payload.mimeType === "text/html" && payload.body?.data) {
    return stripHtmlForComparison(decodeGmailPart(payload.body.data));
  }

  const parts = payload.parts || [];
  for (const part of parts) {
    const text = extractPlainTextFromPayload(part);
    if (text) return text;
  }

  return "";
}

function normalizeTextForComparison(value: string): string {
  return stripHtmlForComparison(value)
    .replace(/\\n/g, "\n")
    .replace(/\r/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

async function messageBodyMatchesGeneratedDraft(params: {
  gmail: gmail_v1.Gmail;
  messageId: string;
  generatedBody?: string | null;
}): Promise<boolean> {
  const generated = normalizeTextForComparison(params.generatedBody || "");
  if (generated.length < 80) return false;

  try {
    const full = await params.gmail.users.messages.get({
      userId: "me",
      id: params.messageId,
      format: "full",
    });
    const actual = normalizeTextForComparison(extractPlainTextFromPayload(full.data.payload));
    const generatedNeedle = generated.slice(0, 160);
    return generatedNeedle.length >= 80 && actual.includes(generatedNeedle);
  } catch (err) {
    logger.error({ err, messageId: params.messageId }, "Failed to compare sent message with drafted follow-up");
    return false;
  }
}

export async function detectManualFollowupSend(params: {
  threadId: string;
  senderEmail: string;
  after: Date;
  followupId: number;
  generatedBody?: string | null;
  gmail: gmail_v1.Gmail;
}): Promise<ManualFollowupSendDetection> {
  const gmail = params.gmail;
  const res = await gmail.users.threads.get({
    userId: "me",
    id: params.threadId,
    format: "metadata",
    metadataHeaders: ["From", "Date", "X-Doctrine-Followup-Id"],
  });

  const afterMs = params.after.getTime();
  const outbound = (res.data.messages || [])
    .map((msg) => {
      const sentAt = getMessageSentAt(msg);
      return { msg, sentAt };
    })
    .filter(({ msg, sentAt }) => {
      if (!msg.id || !sentAt) return false;
      if (sentAt.getTime() <= afterMs) return false;
      const labels = msg.labelIds || [];
      if (!labels.includes("SENT") || labels.includes("DRAFT")) return false;
      // 2026-07-29: SENT && !DRAFT is sufficient — the message went out from
      // this mailbox. The old additional From-header check made an
      // alias-sent manual follow-up unattributable, leaving its followup
      // row 'drafted' forever with no manual_intervention pause.
      return true;
    })
    .sort((a, b) => a.sentAt!.getTime() - b.sentAt!.getTime());

  if (outbound.length === 0) return { kind: "none" };

  const followupIdHeader = String(params.followupId);
  for (const candidate of outbound) {
    const doctrineHeader = getHeaderValue(candidate.msg.payload?.headers, "X-Doctrine-Followup-Id").trim();
    if (doctrineHeader === followupIdHeader) {
      return {
        kind: "draft_sent",
        messageId: candidate.msg.id || undefined,
        sentAt: candidate.sentAt || undefined,
      };
    }
  }

  for (const candidate of outbound) {
    if (!candidate.msg.id) continue;
    const matchesGenerated = await messageBodyMatchesGeneratedDraft({
      gmail,
      messageId: candidate.msg.id,
      generatedBody: params.generatedBody,
    });
    if (matchesGenerated) {
      return {
        kind: "draft_sent",
        messageId: candidate.msg.id,
        sentAt: candidate.sentAt || undefined,
      };
    }
  }

  const first = outbound[0];
  return {
    kind: "custom_outbound",
    messageId: first.msg.id || undefined,
    sentAt: first.sentAt || undefined,
  };
}

export function extractEmail(headerValue: string): string {
  const match =
    headerValue.match(/<([^>]+)>/) || headerValue.match(/([^\s,]+@[^\s,]+)/);
  return match ? match[1].trim() : headerValue.trim();
}

/**
 * Extract a displayable recipient name from a To/From header value.
 *
 * This is a STRICT extractor — it only returns a name when the header clearly
 * contains a human display name (e.g., `"David Cohen" <david@acme.com>`).
 * It refuses to treat email local-parts as names ("hwholestorm" isn't a name),
 * and refuses the pathological case where the "display name" is itself an
 * email address.
 *
 * For cold outreach we prefer extracting the name from the email body greeting
 * (see extractRecipientFirstNameFromBody) — the body is much more reliable.
 * This function is the secondary source.
 *
 * Returns empty string when nothing reliable is available. The caller should
 * then fall through to body parsing, and only fall back to a neutral greeting
 * if both fail.
 */
export function extractName(headerValue: string): string {
  const bracketMatch = headerValue.match(/^"?([^"<]+?)"?\s*</);
  if (!bracketMatch) return "";
  const candidate = bracketMatch[1].trim().replace(/^"+|"+$/g, "");
  if (!candidate) return "";
  // Reject "display name is actually an email" (common when contacts have no
  // real name and the client auto-fills the email as the display name).
  if (candidate.includes("@")) return "";
  // Must contain at least one letter sequence that looks like a word.
  // Letters from: Latin incl. accents, Greek, Cyrillic, Hebrew, Arabic, CJK,
  // Hangul, Hiragana, Katakana, Thai, Devanagari, etc.
  if (!/[A-Za-z\u00C0-\u024F\u0370-\u1CFF\u1D00-\uFFFF]{2}/.test(candidate)) return "";
  // Normalize Latin-script casing only; leave other scripts unchanged.
  if (/^[A-Za-z\s'.-]+$/.test(candidate)) {
    return candidate
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  }
  return candidate;
}

/**
 * Extract the recipient's first name from the opening greeting of the original
 * email body. This is the PRIMARY source of recipient names for cold outreach —
 * the sender almost always wrote "Hi Sarah," or "Shalom David," at the top of
 * the email, which is the cleanest ground truth for who the email is addressed to.
 *
 * Supports greetings in many languages. Returns the raw first name (not lowercased,
 * not normalized) or empty string if nothing found in the first few lines.
 */
export function extractRecipientFirstNameFromBody(body: string): string {
  if (!body) return "";

  // Strip HTML tags, collapse whitespace, focus on first ~300 chars.
  const plain = body
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\r/g, "")
    .trim();
  const head = plain.slice(0, 300);

  // Letter character class covering Latin (incl. accents), Cyrillic, Greek,
  // Hebrew, Arabic, CJK, Hangul, Hiragana, Katakana, Thai, Devanagari, etc.
  const LETTER = "A-Za-z\\u00C0-\\u024F\\u0370-\\u1CFF\\u1D00-\\uFFFF";
  // A "name token" is 2+ letters. Allow hyphens and apostrophes mid-name
  // ("Jean-Luc", "O'Brien"). Allow one optional second name word for CJK
  // constructions where given + surname are separated by a space.
  const NAME = `[${LETTER}][${LETTER}'\\-]{1,}(?:\\s[${LETTER}][${LETTER}'\\-]{1,})?`;

  // Greeting openers across many languages. Order matters: try longest first
  // so "Good morning" wins over "Good".
  const OPENERS = [
    // English
    "Good morning", "Good afternoon", "Good evening",
    "Hi", "Hello", "Hey", "Hiya", "Dear", "Greetings", "Shalom", "Salaam",
    "Salam", "Namaste",
    // Hebrew
    "שלום", "היי", "הי", "בוקר טוב", "ערב טוב",
    // Spanish / Portuguese
    "Hola", "Buenos d[ií]as", "Buenas tardes", "Buenas noches",
    "Ol[aá]", "Bom dia", "Boa tarde", "Boa noite", "Prezado(?:a)?", "Estimado(?:a)?",
    // French
    "Bonjour", "Bonsoir", "Salut", "Cher(?:e)?",
    // German
    "Hallo", "Guten Tag", "Guten Morgen", "Guten Abend", "Sehr geehrte(?:r)?",
    "Liebe(?:r)?",
    // Italian
    "Ciao", "Buongiorno", "Buonasera", "Gentile", "Caro",
    // Dutch
    "Hoi", "Hallo", "Beste", "Geachte",
    // Russian
    "Здравствуйте", "Привет", "Добрый день", "Уважаемый(?:ая)?",
    // Japanese
    "こんにちは", "こんばんは", "おはようございます", "拝啓",
    // Korean — order longest-first because the regex picks the first match.
    // 안녕하십니까 is the formal "hello" used in business emails; 안녕하세요
    // is the everyday polite form. Both were required after we saw a
    // Hangul email skipped because the prospect name extractor only
    // recognised the polite form.
    "안녕하십니까", "안녕하세요",
    // Chinese
    "你好", "您好", "尊敬的",
    // Arabic
    "مرحبا", "السلام عليكم", "أهلا",
    // Turkish
    "Merhaba", "Sayın",
    // Thai
    "สวัสดี",
  ];

  const opener = `(?:${OPENERS.join("|")})`;
  // Pattern: opener, optional space, optional honorific, name, then comma/colon/newline/end.
  // The honorific group is loose: "Mr", "Mr.", "Ms", "Mrs", "Dr", "Prof" etc.
  const HONORIFIC = `(?:(?:Mr|Mrs|Ms|Mx|Dr|Prof|Sr|Sra|M|Mme|Herr|Frau|Dott)\\.?\\s+)?`;
  const greetingRegex = new RegExp(
    `^\\s*${opener}[\\s,]*(?:there\\s*,?\\s*)?${HONORIFIC}(${NAME})\\s*[,:!\\n\\-]`,
    "iu",
  );
  const m = head.match(greetingRegex);
  if (m && m[1]) {
    let name = m[1].trim();
    // Strip trailing CJK honorifics that the NAME regex happily slurps
    // up because they're letter characters. Without this, a Korean
    // greeting like "안녕하세요 김민준님," captured "김민준님" instead
    // of "김민준", and the follow-up generator then wrote
    // "Hi 김민준님님" with a doubled honorific. Japanese suffixes get
    // the same treatment. Chinese 先生 / 女士 / 小姐 are stripped if
    // they trail an extracted Han-script name.
    name = name
      .replace(/(님|씨)$/u, "")              // Korean
      .replace(/(さん|サン|さま|サマ|様|ちゃん|チャン|くん|クン|君)$/u, "")  // Japanese
      .replace(/(先生|女士|小姐)$/u, "")      // Chinese
      .trim();
    // "there" shouldn't pass as a first name — guard.
    if (/^(there|all|team|everyone|folks)$/i.test(name)) return "";
    // After honorific stripping the captured token might be too short
    // to be meaningful — fall through instead of returning junk.
    if (name.length < 1) return "";
    return name;
  }

  return "";
}


// B9a: re-exported helpers so the AntiGhosting threadReader can reuse
// the canonical Gmail message parsing logic without duplicating it.
// These are existing internal helpers (declared above) being promoted
// to the module's public surface. No behaviour change.
export {
  isFromSender as isFromSenderHelper,
  getHeaderValue as getHeaderValueHelper,
  getMessageSentAt as getMessageSentAtHelper,
  decodeGmailPart as decodeGmailPartHelper,
  stripHtmlForComparison as stripHtmlForComparisonHelper,
  extractPlainTextFromPayload as extractPlainTextFromPayloadHelper,
};
