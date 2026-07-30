/**
 * Summarizes a cold outreach email body into a short context blurb
 * suitable for follow-up generation.
 *
 * The goal is to capture WHAT was pitched and the core value prop
 * in 1-2 sentences, so the follow-up writer knows the thread context
 * without being tempted to reproduce the original pitch verbatim.
 */

import { anthropic } from "@workspace/integrations-anthropic-ai";
import { logger } from "../lib/logger";

const SUMMARIZE_SYSTEM = `You are a topic extractor. Given a cold outreach email body, extract the SHORT TOPIC the email was about, suitable for a follow-up reference like "following up on my email about [TOPIC]".

RULES:
- Output ONLY valid JSON, no preamble, no markdown fences.
- Return: {"summary": "...", "language": "..."}
- "summary": A SHORT NOUN PHRASE (5-12 words) naming WHAT the email was about. It must read naturally when inserted into the sentence "following up on my email about ___".
  - GOOD: "the web affiliate program for Alibaba in Malaysia"
  - GOOD: "CPS partnerships for Lazada's checkout traffic"
  - GOOD: "user acquisition for your gaming portfolio in Japan"
  - BAD (meta-language describing the email): "Pitched a performance-based affiliate service, citing competitor growth"
  - BAD (verbose): "An offer to provide performance-based web affiliate services to Alibaba.com targeting confirmed purchases in Malaysia"
  - NEVER use words like "Pitched", "Offered", "Highlighting", "Citing", "Referencing", "Claiming", "Mentioning", "Proposed". These describe the email instead of naming the topic.
  - The summary is a TOPIC NAME, not a description of what the email did.
- "language": The ISO 639-1 language code of the email body (e.g., "en", "ja", "ko", "zh", "de", "fr", "es", "pt", "ru", "he", "ar"). Detect based on the actual text, not the names or domains mentioned. If the body is primarily in Japanese, return "ja". If primarily English, return "en". Etc.`;

export interface SummarizeResult {
  summary: string;
  language: string;
}

function detectLanguageFallback(text: string): string {
  const sample = text.slice(0, 500);
  if (/[\u3040-\u309F\u30A0-\u30FF]/.test(sample)) return "ja";
  if (/[\uAC00-\uD7AF\u1100-\u11FF]/.test(sample)) return "ko";
  if (/[\u4E00-\u9FFF]/.test(sample) && !/[\u3040-\u309F\u30A0-\u30FF]/.test(sample)) return "zh";
  if (/[\u0590-\u05FF]/.test(sample)) return "he";
  if (/[\u0600-\u06FF]/.test(sample)) return "ar";
  if (/[\u0400-\u04FF]/.test(sample)) return "ru";
  return "en";
}

function sanitizeSummary(raw: string): string {
  let s = raw.trim();
  s = s.replace(/^(?:Pitched|Offered|Proposed|Outlined|Outlining|Highlighted|Highlighting|Cited|Citing|Referenced|Referencing|Mentioned|Mentioning|Claimed|Claiming|Described|Describing|Presented|Presenting|Noted|Noting|Emphasized|Emphasizing)\s+/i, "");
  s = s.replace(/,\s*(?:citing|referencing|mentioning|highlighting|noting|emphasizing|claiming)\s+[^,.!?]*/gi, "");
  s = s.replace(/\bas\s+(?:urgency|social proof|a benchmark|an example|context|reference|justification)\b/gi, "");
  s = s.replace(/\s+/g, " ").trim();
  s = s.replace(/^[A-Z]/, (c) => c.toLowerCase());
  if (s.length > 140) s = s.slice(0, 140).replace(/\s+\S*$/, "");
  return s.replace(/[.,;:]+$/, "").trim();
}

export async function summarizeOriginalEmail(body: string): Promise<SummarizeResult> {
  if (!body || body.trim().length < 30) {
    return { summary: body.trim(), language: detectLanguageFallback(body) };
  }

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 300,
      system: SUMMARIZE_SYSTEM,
      messages: [{ role: "user", content: body.slice(0, 1000) }],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    if (textBlock && textBlock.type === "text" && textBlock.text.trim().length > 10) {
      try {
        const raw = textBlock.text.replace(/```json\s*|```/g, "").trim();
        const parsed = JSON.parse(raw);
        if (parsed.summary && parsed.language) {
          return { summary: sanitizeSummary(parsed.summary), language: parsed.language.trim().toLowerCase() };
        }
        if (typeof parsed === "string" || parsed.summary) {
          return {
            summary: sanitizeSummary(parsed.summary || textBlock.text),
            language: detectLanguageFallback(body),
          };
        }
      } catch {
        return { summary: sanitizeSummary(textBlock.text), language: detectLanguageFallback(body) };
      }
    }
  } catch (err) {
    logger.warn({ err }, "Email summarization failed, using truncated body");
  }

  const summary = body.slice(0, 200).trim() + (body.length > 200 ? "..." : "");
  return { summary: sanitizeSummary(summary), language: detectLanguageFallback(body) };
}
