/**
 * replySentiment.ts — Company-Reply Cascade, LLM layer.
 *
 * Classifies a SINGLE genuine inbound reply into one of:
 *   unsubscribe | ooo | positive | negative | unknown
 *
 * Order of decision (cheap → expensive, fail-safe at every step):
 *   1. Deterministic unsubscribe scan on the body  → "unsubscribe"
 *   2. Deterministic OOO scan on subject+body+headers → "ooo"
 *   3. LLM positive/negative judgement with a confidence score, via the
 *      reply_sentiment chain (lib/modelPolicy.ts). The LLM may also return
 *      "ooo" to catch auto-replies the regex missed.
 *   4. Any failure (every tier down, or no tier answering in the agreed
 *      vocabulary) → "unknown" (NO cascade).
 *
 * Aug 2026 note on one behaviour change: an unparseable verdict used to be
 * returned as "negative". It now advances the router's waterfall instead, and
 * only a fully exhausted chain returns "unknown". Both values are equally safe
 * downstream — gmailSync cascades only on "positive" above the confidence floor
 * — so this strictly buys another model's opinion where the old code gave up.
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
import { runLlmJson, type LlmJsonSchema } from "../lib/llmRouter";
import { wrapUntrusted, scanForInjection, UNTRUSTED_DATA_SYSTEM_CLAUSE } from "../lib/promptInjection";

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

// The {class, confidence, reason} contract, enforced at both vendors so the
// classifier cannot answer with prose. `class` is a plain string rather than an
// enum because the shared schema shape is scalars-only; the value check below
// is the real gate, and it is the one that must be conservative.
const SENTIMENT_SCHEMA: LlmJsonSchema = {
  name: "reply_sentiment",
  properties: { class: "string", confidence: "number", reason: "string" },
  required: ["class", "confidence", "reason"],
};

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

  const _scan = scanForInjection(trimmed);
  if (_scan.suspicious) {
    logger.warn(
      { latestInboundMessageId, signals: _scan.signals.map((s) => s.kind), score: _scan.score },
      "replySentiment: injection markers in reply - classifying unknown, no cascade",
    );
    return { replyClass: "unknown", confidence: 0, reason: "injection suspected in reply", source: "fallback" };
  }
  const _replyBlock = wrapUntrusted("PROSPECT_REPLY", trimmed);
  const _topicWrap = outreachTopic ? wrapUntrusted("OUTREACH_TOPIC", outreachTopic) : null;
  const userContent = _topicWrap
    ? `Original outreach was about:\n${_topicWrap.block}\n\nProspect's reply:\n${_replyBlock.block}`
    : `Prospect's reply:\n${_replyBlock.block}`;

  try {
    const { value } = await runLlmJson<ReplySentimentResult>({
      role: "reply_sentiment",
      systemParts: [UNTRUSTED_DATA_SYSTEM_CLAUSE, SENTIMENT_SYSTEM],
      user: userContent,
      maxOutputTokens: 200,
      schema: SENTIMENT_SCHEMA,
      // No usage context here — reply handling runs outside a generation — so
      // the cost lands on the shared ledger under its own app label, where the
      // daily budget cap still sums it.
      usage: { kind: "aux", app: "reply_sentiment", label: "reply_sentiment" },
      validate: (parsed) => {
        const p = parsed as { class?: unknown; confidence?: unknown; reason?: unknown };
        const cls = String(p.class ?? "").toLowerCase();
        if (cls !== "positive" && cls !== "negative" && cls !== "ooo") {
          // Not one of the three permitted verdicts. Throwing hands it to the
          // router, which tries the next tier — a model that answered a
          // different question should not get to decide a campaign's fate.
          throw new Error(`reply classifier returned an unknown class: ${cls.slice(0, 40)}`);
        }
        const conf = Number(p.confidence);
        return {
          replyClass: cls as ReplyClass,
          confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0.5,
          reason: String(p.reason ?? "").slice(0, 120) || cls,
          source: "llm" as const,
        };
      },
    });
    return value;
  } catch (err) {
    // Every tier failed, or none produced a verdict in the agreed vocabulary.
    // Fail to "unknown", which means NO cascade — the conservative direction.
    // A false "positive" pauses a live campaign; a false "negative" costs one
    // extra follow-up. That asymmetry is why this catch does not guess.
    logger.warn(
      { err: String(err), latestInboundMessageId },
      "replySentiment: LLM classify failed on every tier — treating as unknown",
    );
    return { replyClass: "unknown", confidence: 0, reason: "classifier error", source: "fallback" };
  }
}
