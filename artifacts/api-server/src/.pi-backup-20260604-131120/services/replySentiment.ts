/**
 * replySentiment.ts — Company-Reply Cascade, LLM layer.
 *
 * Classifies a SINGLE genuine inbound reply into one of:
 *   unsubscribe | ooo | positive | negative | unknown
 *
 * Order of decision (cheap → expensive, fail-safe at every step):
 *   1. Deterministic unsubscribe scan on the body  → "unsubscribe"
 *   2. Deterministic OOO scan on subject+body+headers → "ooo"
 *   3. LLM positive/negative judgement (Sonnet) with a confidence score.
 *      The LLM may also return "ooo" to catch auto-replies the regex missed.
 *   4. Any failure (network, parse, empty) → "unknown" (NO cascade).
 *
 * Only the body of the LATEST inbound message is read — the caller passes
 * its Gmail message id (resolved in classifyThreadInbound). The original
 * outreach topic is passed for context so the model can judge "positive"
 * relative to what was offered, not in a vacuum.
 *
 * The decisive design choice: when the model is genuinely unsure, it must
 * choose "negative". A false positive pauses real campaigns; a false
 * negative just sends one more follow-up. The asymmetry is baked into the
 * prompt and enforced again by the caller's confidence floor.
 */

import { gmail_v1 } from "googleapis";
import { anthropic, MODEL_REPLY_CLASSIFIER } from "../lib/anthropic";
import { withAnthropicRetry } from "./anthropicRetry";
import {
  getHeaderValueHelper,
  extractPlainTextFromPayloadHelper,
} from "./gmailClient";
import {
  isOutOfOffice,
  isUnsubscribe,
  type ReplyClass,
  type AutoReplyHeaders,
} from "../lib/replyClassification";
import { logger } from "../lib/logger";

export interface ReplySentimentResult {
  replyClass: ReplyClass;
  confidence: number;       // 0..1; only meaningful for positive/negative
  reason: string;           // short human-readable rationale (for audit)
  source: "rule" | "llm" | "fallback";
}

const SENTIMENT_SYSTEM = `You classify a single inbound reply to a B2B sales outreach email. You output ONLY the prospect's intent toward continuing the conversation.

Return ONLY valid JSON, no preamble, no markdown fences:
{"class": "positive" | "negative" | "ooo", "confidence": 0.0-1.0, "reason": "<=12 words"}

DEFINITIONS:
- "positive": the reply shows genuine interest or willingness to engage with the offer. Examples: asks for more info / pricing / a deck, proposes or accepts a call or meeting, says they are interested or it is relevant, asks a real qualifying question in good faith, or refers you onward WHILE expressing openness ("we might be interested, talk to our UA lead").
- "negative": rejection, disinterest, or irrelevance. Examples: "not interested", "we already have a partner", "no thanks", "wrong person" with no useful or positive redirect, a dismissive one-liner, or hostility.
- "ooo": an out-of-office / vacation / automatic away reply. The person did not actually respond to the content.

RULES:
- Judge intent toward CONTINUING THE CONVERSATION, not mere politeness. "Thanks but no" is negative despite being polite.
- A bare referral with no interest ("not me, no idea who handles this") is negative.
- If you are genuinely unsure between positive and negative, choose "negative" with a low confidence. Never guess "positive".
- "confidence" is your certainty in the class you chose, 0 to 1.`;

/**
 * Read the latest inbound message body and classify it.
 *
 * @param latestInboundMessageId Gmail message id of the most recent inbound
 *        (resolved by classifyThreadInbound). When absent, returns "unknown".
 */
export async function classifyReplySentiment(params: {
  gmail: gmail_v1.Gmail;
  latestInboundMessageId: string | null | undefined;
  outreachTopic?: string;
}): Promise<ReplySentimentResult> {
  const { gmail, latestInboundMessageId, outreachTopic } = params;

  if (!latestInboundMessageId) {
    return { replyClass: "unknown", confidence: 0, reason: "no inbound message id", source: "fallback" };
  }

  // Fetch the one inbound message we need (full format for the body).
  let subject = "";
  let body = "";
  let headers: AutoReplyHeaders = {};
  try {
    const msg = await gmail.users.messages.get({
      userId: "me",
      id: latestInboundMessageId,
      format: "full",
    });
    const h = msg.data.payload?.headers;
    subject = getHeaderValueHelper(h, "Subject");
    body = extractPlainTextFromPayloadHelper(msg.data.payload);
    headers = {
      autoSubmitted: getHeaderValueHelper(h, "Auto-Submitted"),
      xAutoreply: getHeaderValueHelper(h, "X-Autoreply"),
      xAutorespond: getHeaderValueHelper(h, "X-Autorespond"),
      precedence: getHeaderValueHelper(h, "Precedence"),
    };
    // Fall back to the snippet if no body part decoded.
    if (!body) body = msg.data.snippet || "";
  } catch (err) {
    logger.warn({ err, latestInboundMessageId }, "replySentiment: inbound fetch failed");
    return { replyClass: "unknown", confidence: 0, reason: "inbound fetch failed", source: "fallback" };
  }

  const combined = `${subject}\n${body}`;

  // 1. Deterministic unsubscribe.
  if (isUnsubscribe(combined)) {
    return { replyClass: "unsubscribe", confidence: 1, reason: "explicit opt-out phrase", source: "rule" };
  }

  // 2. Deterministic OOO (catches the common cases without an LLM call).
  if (isOutOfOffice(subject, body, headers)) {
    return { replyClass: "ooo", confidence: 1, reason: "out-of-office auto-reply", source: "rule" };
  }

  // 3. LLM positive/negative (and OOO as a multilingual safety net).
  const trimmed = body.slice(0, 2000);
  const userContent = outreachTopic
    ? `Original outreach was about: ${outreachTopic}\n\n---\nProspect's reply:\n${trimmed}`
    : `Prospect's reply:\n${trimmed}`;

  try {
    const response = await withAnthropicRetry(
      () => anthropic.messages.create({
        model: MODEL_REPLY_CLASSIFIER,
        max_tokens: 200,
        system: SENTIMENT_SYSTEM,
        messages: [{ role: "user", content: userContent }],
      }),
      { label: "reply_sentiment" },
    );

    const textBlock = response.content.find((b) => b.type === "text");
    if (textBlock && textBlock.type === "text") {
      const raw = textBlock.text.replace(/```json\s*|```/g, "").trim();
      const parsed = JSON.parse(raw);
      const cls = String(parsed.class || "").toLowerCase();
      const conf = Number(parsed.confidence);
      const reason = String(parsed.reason || "").slice(0, 120);
      if (cls === "positive" || cls === "negative" || cls === "ooo") {
        return {
          replyClass: cls as ReplyClass,
          confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0.5,
          reason: reason || cls,
          source: "llm",
        };
      }
    }
    logger.warn({ latestInboundMessageId }, "replySentiment: unparseable LLM verdict — treating as negative");
    // Unparseable but the LLM responded: fail to the SAFE side (no cascade).
    return { replyClass: "negative", confidence: 0, reason: "unparseable verdict", source: "fallback" };
  } catch (err) {
    logger.warn({ err, latestInboundMessageId }, "replySentiment: LLM classify failed — treating as unknown");
    return { replyClass: "unknown", confidence: 0, reason: "classifier error", source: "fallback" };
  }
}
