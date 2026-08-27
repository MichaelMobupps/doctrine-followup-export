/**
 * Summarizes a cold outreach email body into a short context blurb
 * suitable for follow-up generation.
 *
 * The goal is to capture WHAT was pitched and the core value prop
 * in 1-2 sentences, so the follow-up writer knows the thread context
 * without being tempted to reproduce the original pitch verbatim.
 */

import { logger } from "../lib/logger";
import { wrapUntrusted, UNTRUSTED_DATA_SYSTEM_CLAUSE } from "../lib/promptInjection";
import { runLlmJson, type LlmJsonSchema } from "../lib/llmRouter";

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

// {summary, language} output contract. Both vendors are constrained to it —
// Gemini through responseSchema, OpenAI through strict json_schema — so a tier
// cannot emit malformed JSON, and the router falls to the next tier if one
// somehow does.
const SUMMARIZER_SCHEMA: LlmJsonSchema = {
  name: "email_summary",
  properties: { summary: "string", language: "string" },
  required: ["summary", "language"],
};

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

const META_PARTICIPLES = [
  "pitched", "offered", "proposed", "outlined", "outlining",
  "highlighted", "highlighting", "cited", "citing",
  "referenced", "referencing", "mentioned", "mentioning",
  "claimed", "claiming", "described", "describing",
  "presented", "presenting", "noted", "noting",
  "emphasized", "emphasizing", "indicating", "demonstrating",
  "stating", "explaining", "suggesting", "arguing",
];

const META_PARTICIPLE_RE = new RegExp(`\\b(?:${META_PARTICIPLES.join("|")})\\b`, "i");

function stripMetaClauses(input: string): string {
  let s = input;

  // Strip leading meta-participle (e.g., "Pitched a service to ..." → "a service to ...")
  s = s.replace(
    new RegExp(`^(?:${META_PARTICIPLES.join("|")})\\s+`, "i"),
    "",
  );

  // Strip ", -ing ..." participial clauses anywhere (", citing X", ", claiming Y")
  s = s.replace(
    new RegExp(
      `,?\\s*(?:${META_PARTICIPLES.join("|")})\\s+[^,.!?;]*`,
      "gi",
    ),
    "",
  );

  // Strip "and -ing X" continuations ("and referencing benchmarks")
  s = s.replace(
    new RegExp(
      `\\s+and\\s+(?:${META_PARTICIPLES.join("|")})\\s+[^,.!?;]*`,
      "gi",
    ),
    "",
  );

  // Strip "claiming the ability to ..." / "the ability to drive ..." meta-constructions
  s = s.replace(/\bthe ability to\s+[a-z]+\s+[^,.!?;]{0,80}/gi, "");

  // Strip "as urgency / as social proof / as a benchmark / as an example / as context"
  s = s.replace(
    /\bas\s+(?:urgency|social proof|a benchmark|an example|context|reference|justification|proof|validation|a hook|a reason)\b[^,.!?;]*/gi,
    "",
  );

  // Strip "via/through/by citing|referencing|..." constructions
  s = s.replace(
    new RegExp(
      `\\s+(?:via|through|by)\\s+(?:${META_PARTICIPLES.join("|")})\\s+[^,.!?;]*`,
      "gi",
    ),
    "",
  );

  return s;
}

/**
 * Returns true if a candidate summary reads like prose / a real sentence
 * instead of a short noun phrase suitable for "...my email about ___".
 *
 * This catches the pathological case where the summarizer LLM echoes the
 * original body back as a summary — which then gets pasted verbatim into
 * the follow-up template and produces garbage like
 *   "Following up on my previous email about hi Jesaja, Prematch is..."
 */
function looksLikeProse(s: string): boolean {
  if (!s) return false;
  const trimmed = s.trim();
  // Starts with a greeting word (any common language)
  if (/^(hi|hello|hey|dear|greetings|good\s+(morning|afternoon|evening)|shalom|bonjour|hola|ciao|guten\s+tag|konnichiwa|salaam|privet|namaste)\b/i.test(trimmed)) {
    return true;
  }
  // Starts with a pronoun subject (a sentence, not a noun phrase)
  if (/^(i|we|you|they|he|she|it|my|our|your|their)\s+\w+/i.test(trimmed)) {
    return true;
  }
  // Contains clear sentence connectors mid-string
  if (/,\s*(but|and|so|however|because|while|although|though)\s+/i.test(trimmed)) {
    return true;
  }
  // Has a finite verb pattern typical of a sentence ("X is/are/was/were/has/have")
  if (/^\w+\s+(is|are|was|were|has|have|had|will|would|can|could|should)\s+/i.test(trimmed)) {
    return true;
  }
  return false;
}

function sanitizeSummary(raw: string): string {
  let s = (raw || "").trim();

  // Iteratively strip meta clauses until the string stops changing.
  // Guards against chained meta phrases like "Pitched X, citing Y, referencing Z".
  for (let i = 0; i < 5; i++) {
    const before = s;
    s = stripMetaClauses(s);
    if (s === before) break;
  }

  // Collapse whitespace, trim leading junk punctuation.
  s = s.replace(/\s+/g, " ").trim();
  s = s.replace(/^[,.;:\s]+/, "");

  // If what remains looks like prose, throw it out — a bad summary is worse
  // than no summary because it gets concatenated into "about ___" verbatim.
  if (looksLikeProse(s)) return "";

  // Lowercase first letter so it reads naturally inside "following up on my email about ___"
  s = s.replace(/^[A-Z]/, (c) => c.toLowerCase());

  // Hard length cap — follow-up references should be short.
  if (s.length > 120) s = s.slice(0, 120).replace(/\s+\S*$/, "");

  // Trim trailing punctuation.
  s = s.replace(/[.,;:]+$/, "").trim();

  return s;
}

/**
 * Returns true if a summary still contains meta-language after sanitization
 * (a participle verb describing what the email did, rather than a topic name).
 * Used by the follow-up generator as a runtime self-heal check on existing
 * rows whose summaries may have been stored before sanitization was hardened.
 */
export function summaryLooksMeta(summary: string): boolean {
  if (!summary) return false;
  if (META_PARTICIPLE_RE.test(summary)) return true;
  if (/\bthe ability to\s+\w+/i.test(summary)) return true;
  if (/\bas\s+(?:urgency|social proof|a benchmark|an example)\b/i.test(summary)) return true;
  if (looksLikeProse(summary)) return true;
  return false;
}

/**
 * Run sanitization on an already-stored summary. Exported so the follow-up
 * generator can self-heal contaminated rows at send time without a migration.
 */
export function resanitizeStoredSummary(summary: string): string {
  return sanitizeSummary(summary);
}

/**
 * Turn a summarizer model's parsed answer into a sanitized SummarizeResult, or
 * null when it is unusable.
 *
 * The router has already parsed the JSON (and already fell to the next tier if
 * it could not), so this handles the shapes that ARE valid JSON but are not the
 * agreed object: a summary with no language, or a bare string. Both are salvaged
 * with the deterministic language detector rather than thrown away, because a
 * usable summary in the wrong-labelled language is far better for the writer
 * than no summary at all.
 *
 * Every tier goes through it, so the sanitize rules are identical whichever
 * vendor answered — which is the point. sanitizeSummary is what keeps the
 * cheapest tier's output at the same bar as an expensive one's.
 */
function coerceSummarizerOutput(parsed: unknown, body: string): SummarizeResult | null {
  if (typeof parsed === "string") {
    const summary = sanitizeSummary(parsed);
    return summary.trim() ? { summary, language: detectLanguageFallback(body) } : null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as { summary?: unknown; language?: unknown };
  if (typeof p.summary !== "string" || !p.summary.trim()) return null;
  const summary = sanitizeSummary(p.summary);
  if (!summary.trim()) return null;
  const language =
    typeof p.language === "string" && p.language.trim()
      ? p.language.trim().toLowerCase()
      : detectLanguageFallback(body);
  return { summary, language };
}

export async function summarizeOriginalEmail(body: string): Promise<SummarizeResult> {
  if (!body || body.trim().length < 30) {
    return { summary: body.trim(), language: detectLanguageFallback(body) };
  }

  const userBlock = wrapUntrusted("EMAIL_BODY", body.slice(0, 1000)).block;

  // Summarization is an easy extract-the-topic task with a heavy deterministic
  // sanitizer (sanitizeSummary) behind it, so the summarizer chain is the
  // cheapest in the product. The router walks it, retries inside a tier, and
  // moves on to the next tier on a 429/503/timeout or an unusable answer.
  try {
    const { value } = await runLlmJson<SummarizeResult>({
      role: "summarizer",
      systemParts: [UNTRUSTED_DATA_SYSTEM_CLAUSE, SUMMARIZE_SYSTEM],
      user: userBlock,
      maxOutputTokens: 300,
      schema: SUMMARIZER_SCHEMA,
      // Ingest runs outside a generation, so there is no usage context to
      // attribute to. The aux sink still lands the cost on the shared ledger,
      // which is what the daily budget cap reads.
      usage: { kind: "aux", app: "email_summary", label: "email_summary" },
      validate: (parsed) => {
        // coerceSummarizerOutput owns the messy-but-valid shapes (a bare string,
        // a summary with no language) and the meta-language sanitize pass. It
        // returns null when the answer is unusable, which we turn into a throw
        // so the router treats it as a tier failure rather than a result.
        const result = coerceSummarizerOutput(parsed, body);
        if (!result) throw new Error("summarizer output unusable");
        return result;
      },
    });
    return value;
  } catch (err) {
    logger.warn({ err: String(err) }, "Email summarization failed on every tier, using truncated body");
  }

  // Last resort, unchanged: a truncated body is a poor topic line but it is
  // real text in the right language, and the follow-up writer degrades far
  // better with a weak summary than with none.
  const summary = body.slice(0, 200).trim() + (body.length > 200 ? "..." : "");
  return { summary: sanitizeSummary(summary), language: detectLanguageFallback(body) };
}
