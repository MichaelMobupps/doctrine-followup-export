/**
 * doctrineLint.ts
 *
 * Deterministic pre-flight checks that run BEFORE the LLM critic, producing
 * issues + suggestions that get merged into the critique. Follows the same
 * pattern as the existing `detectMetaLanguage` helper in followupGenerator.ts.
 *
 * Two detectors:
 *   detectDoctrineViolations(body, lang) \u2014 runs the subset of Michael SDR
 *     Formula rules that apply to follow-up emails (hedge on numbers, hype
 *     adjectives, CPA-collapse pattern, multi-event optimization claims).
 *
 *   detectNativenessViolations(body, lang) \u2014 catches the Zekri-class
 *     failure where multi-word English phrases (lowercase, 2+ consecutive
 *     content words) appear inside non-Latin-script prose. This is the
 *     deterministic side of the v2 language-nativeness work that the
 *     existing `lib/languageNativeness.ts` did not ship.
 *
 * Both detectors return:
 *   { found: boolean; issues: string[]; suggestions: string[]; matches: string[] }
 */

import {
  findHedgesInBody,
  findHypeAdjectivesInBody,
  findForbiddenDiffPatterns,
  findMultiEventPatterns,
} from "./doctrineRules";
import { normalizeLanguageCode } from "./languageNativeness";

export interface ViolationReport {
  found: boolean;
  issues: string[];
  suggestions: string[];
  matches: string[];
}

const EMPTY_REPORT: ViolationReport = {
  found: false,
  issues: [],
  suggestions: [],
  matches: [],
};

// =============================================================================
// Doctrine violations applicable to follow-up emails
// =============================================================================

/**
 * Run the deterministic doctrine checks that apply to follow-up emails.
 * This is a SUBSET of the full Prospector cold-outbound doctrine \u2014
 * follow-ups don't have a WHAT/DIFFERENTIATOR section per se, but if a
 * follow-up makes a value claim that collapses onto CPA, that's still
 * worth catching. Hedge + hype + multi-event apply universally.
 */
export function detectDoctrineViolations(body: string, languageTag: string): ViolationReport {
  const lang = normalizeLanguageCode(languageTag) || "en";
  const issues: string[] = [];
  const suggestions: string[] = [];
  const matches: string[] = [];

  // 1. Hedge on number
  const hedges = findHedgesInBody(body, lang);
  if (hedges.length > 0) {
    matches.push(...hedges);
    issues.push(
      `HEDGED NUMBER DETECTED \u2014 the email uses hedge words before a number ` +
      `(${hedges.slice(0, 3).map((h) => `"${h}"`).join(", ")}). ` +
      `Volume and metric claims must be decisive. Write "250" or "250+", ` +
      `not "around 250" or "approximately 250" or the target-language equivalent.`,
    );
    suggestions.push(
      "Replace every hedge-plus-number phrase with a single decisive number " +
      "(\"250\" or \"250+\"). Numbers carry credibility; hedges undercut it.",
    );
  }

  // 2. Hype adjectives
  const hype = findHypeAdjectivesInBody(body, lang);
  if (hype.length > 0) {
    matches.push(...hype);
    issues.push(
      `HYPE ADJECTIVES IN BODY \u2014 marketing-deck adjectives detected ` +
      `(${hype.slice(0, 4).map((h) => `"${h}"`).join(", ")}). ` +
      `These read as filler. Numbers, mechanics, and named competitors ` +
      `carry the claim, not adjectives.`,
    );
    suggestions.push(
      "Cut every hype adjective from the body. If a sentence loses its " +
      "punch without the adjective, the sentence was leaning on the " +
      "adjective instead of on a real fact \u2014 replace it with a number, a " +
      "mechanism, or a named entity.",
    );
  }

  // 3. Multi-event optimization claim
  const multiEvent = findMultiEventPatterns(body, lang);
  if (multiEvent.length > 0) {
    matches.push(...multiEvent);
    issues.push(
      `MULTI-EVENT OPTIMIZATION CLAIM \u2014 the email lists two or more event ` +
      `types as the optimization target (${multiEvent.slice(0, 2).map((m) => `"${m}"`).join(", ")}). ` +
      `Optimization claims must anchor on EXACTLY ONE primary event. ` +
      `Other related events may appear as adjacent context but not as the anchor.`,
    );
    suggestions.push(
      "Pick the single dominant revenue event by volume for the prospect's " +
      "business and use that one. Drop the \"or X or Y\" tail.",
    );
  }

  // 4. CPA-collapse pattern in any paragraph (follow-ups have no fixed
  // DIFFERENTIATOR section, so scan the whole body).
  const forbidden = findForbiddenDiffPatterns(body, lang);
  if (forbidden.length > 0) {
    matches.push(...forbidden);
    issues.push(
      `CPA-AS-DIFFERENTIATOR COLLAPSE \u2014 the email claims a differentiator ` +
      `that is actually just CPA (${forbidden.slice(0, 2).map((f) => `"${f}"`).join(", ")}). ` +
      `Every ad network can offer "we pay only for approved events"; it is ` +
      `not a real differentiator. Approved anchors are renewals/persistence, ` +
      `incrementality, or semi-exclusive supply.`,
    );
    suggestions.push(
      "If the follow-up needs a differentiating claim, anchor it on one of: " +
      "renewals/persistence (durable revenue past the first conversion cycle), " +
      "incrementality (incremental users vs cannibalized), or semi-exclusive " +
      "supply (publishers not shared with named competitors). Avoid \"we pay " +
      "for X, not Y\" framing entirely.",
    );
  }

  return {
    found: issues.length > 0,
    issues,
    suggestions,
    matches,
  };
}

// =============================================================================
// Language nativeness: Latin-token-leak detection
// =============================================================================

/**
 * Set of language codes whose script is NOT Latin and therefore should be
 * checked for multi-word English phrase leaks. For Latin-script languages
 * (en, es, pt, it, fr, de, nl, sv, etc.), this detector is a no-op.
 */
const NON_LATIN_LANGUAGES = new Set([
  // Cyrillic
  "ru", "uk", "bg", "be", "sr", "mk",
  // Greek
  "el",
  // East Asian
  "zh", "ja", "ko",
  // Middle Eastern
  "ar", "he", "fa", "ur",
  // South Asian
  "hi", "bn", "ta", "te", "mr", "gu", "kn", "ml", "pa",
  // Southeast Asian
  "th", "lo", "km", "my",
  // Other
  "am", "ka", "hy",
]);

/**
 * Industry-standard acronyms that are always permitted as standalone Latin
 * tokens inside non-Latin prose, even when they appear in a multi-word run.
 * Comparison is case-insensitive but original casing is preserved for output.
 */
const PERMITTED_ACRONYMS = new Set([
  // Adtech
  "UA", "LTV", "ROAS", "CPI", "CPA", "CPM", "CPC", "CTR", "CVR",
  "MMP", "DSP", "SSP", "RTB", "PMP", "SDK", "IAP", "KPI",
  "MAU", "DAU", "ARPU", "ARPDAU", "AOV", "ROI", "OEM", "API",
  "B2B", "B2C", "D7", "D30", "D90",
  // General
  "USD", "EUR", "GBP", "JPY", "CNY", "INR", "THB", "MYR", "SGD",
  "AI", "ML", "SaaS", "PaaS", "IaaS", "iOS", "URL", "HTTP", "JSON",
  "Q1", "Q2", "Q3", "Q4", "YoY", "MoM", "QoQ",
]);

/**
 * Internal: split a paragraph into runs of consecutive Latin words.
 * Words are A-Z/a-z plus hyphens/apostrophes; runs are separated by any
 * non-Latin character (including whitespace embedded in non-Latin context
 * is handled via the paragraph segmentation step \u2014 here we only split
 * on characters that break a run).
 *
 * Returns array of {phrase, startIdx, endIdx, words}.
 */
function extractLatinRuns(paragraph: string): Array<{ phrase: string; words: string[] }> {
  // Match runs of: Latin word, then 1+ (whitespace/comma/period + Latin word).
  // A Latin word: starts with a letter, contains letters/digits/hyphens/apostrophes,
  // minimum 2 characters to avoid matching single letters.
  const RUN_RE = /[A-Za-z][A-Za-z\d'-]+(?:[ \t,.](?:[ \t,.])*[A-Za-z][A-Za-z\d'-]+)+/g;
  const runs: Array<{ phrase: string; words: string[] }> = [];
  let m: RegExpExecArray | null;
  while ((m = RUN_RE.exec(paragraph)) !== null) {
    const phrase = m[0].trim();
    const words = phrase.split(/[\s,.]+/).filter((w) => w.length > 0);
    if (words.length >= 2) {
      runs.push({ phrase, words });
    }
  }
  return runs;
}

/**
 * Internal: estimate whether a paragraph is "primarily non-Latin script"
 * (so Latin tokens in it count as foreign-language leaks). Threshold: 15%
 * of non-whitespace characters must be non-Latin. CJK scripts pack a lot
 * of semantic content into few characters, so a short Chinese sentence
 * with a 3-word English phrase pasted in may show only ~20% non-Latin
 * even though it is unambiguously a Chinese-target paragraph. We lean
 * toward catching the violation; the cost of a false positive in a
 * primarily-English paragraph is low (target language must also be
 * non-Latin for this detector to fire at all).
 */
function isPrimarilyNonLatin(paragraph: string): boolean {
  let latin = 0;
  let nonLatin = 0;
  for (const ch of paragraph) {
    if (/\s/.test(ch)) continue;
    const code = ch.codePointAt(0)!;
    // Latin block + Latin-1 Supplement = 0x0000..0x024F (broad)
    if ((code >= 0x0020 && code <= 0x024F) || /[\x20-\x7e]/.test(ch)) {
      latin++;
    } else {
      nonLatin++;
    }
  }
  const total = latin + nonLatin;
  if (total === 0) return false;
  // Require at least 3 non-Latin chars AND at least 15% non-Latin ratio so
  // that a single foreign name like "François" in an English paragraph
  // doesn't flip the paragraph into "target-language mode".
  return nonLatin >= 3 && nonLatin / total >= 0.15;
}

/**
 * Internal: classify a Latin run as a violation or not.
 *
 * Rules:
 *   * All-acronyms run (e.g. "ROAS CPI") \u2192 not a violation.
 *   * Proper-noun run (all words start with a capital letter) \u2192 not a
 *     violation, even though it's Latin.
 *   * Mixed (some capitals, some lowercase) \u2014 typically a proper noun
 *     plus an adjective ("Brand Day cohort") \u2014 not a violation.
 *   * All-lowercase run with 2+ words \u2192 VIOLATION (the Zekri pattern).
 *   * Run with 2+ consecutive lowercase content words anywhere \u2192 VIOLATION.
 *
 * Returns null if not a violation, or the violating phrase if it is.
 */
function classifyLatinRun(run: { phrase: string; words: string[] }): string | null {
  const { words } = run;
  // Strip acronyms; if everything that's left is empty or a single word, no violation
  const remaining = words.filter((w) => !PERMITTED_ACRONYMS.has(w));
  if (remaining.length < 2) return null;

  // Are all remaining words capitalized? Proper-noun-style runs are allowed.
  const allCapitalized = remaining.every((w) => /^[A-Z]/.test(w));
  if (allCapitalized) return null;

  // Are there 2+ consecutive lowercase content words anywhere in the run?
  let consecutiveLowercase = 0;
  let maxConsecutive = 0;
  for (const w of remaining) {
    if (/^[a-z]/.test(w) && w.length >= 3) {
      consecutiveLowercase++;
      maxConsecutive = Math.max(maxConsecutive, consecutiveLowercase);
    } else {
      consecutiveLowercase = 0;
    }
  }

  if (maxConsecutive >= 2) {
    return run.phrase;
  }

  return null;
}

/**
 * Run deterministic language-nativeness checks. For non-Latin-script
 * languages, detect multi-word English phrases (the Zekri pattern) leaking
 * into the prose. For Latin-script languages, this is a no-op.
 */
export function detectNativenessViolations(body: string, languageTag: string): ViolationReport {
  const lang = normalizeLanguageCode(languageTag);
  if (!lang || !NON_LATIN_LANGUAGES.has(lang)) {
    return EMPTY_REPORT;
  }

  // Split into paragraphs. Use newline-based segmentation; the Followuper
  // produces \n\n-separated paragraphs in body text.
  const paragraphs = body.split(/\n\n+/).map((p) => p.trim()).filter((p) => p.length > 0);

  const violations: string[] = [];

  for (const para of paragraphs) {
    if (!isPrimarilyNonLatin(para)) continue;

    const runs = extractLatinRuns(para);
    for (const run of runs) {
      const viol = classifyLatinRun(run);
      if (viol) violations.push(viol);
    }
  }

  if (violations.length === 0) return EMPTY_REPORT;

  const sample = violations.slice(0, 4).map((v) => `"${v}"`).join(", ");
  return {
    found: true,
    issues: [
      `LATIN-TOKEN-LEAK \u2014 multi-word English phrases detected inside ` +
      `non-Latin-script prose (${sample}). This is the most common signal ` +
      `that the writer pasted English chunks from the original brief ` +
      `instead of expressing the concept natively in ${languageTag}. ` +
      `Each flagged phrase must be rewritten as a native phrase in the ` +
      `target language, unless it is an industry-standard acronym ` +
      `(UA, LTV, ROAS, CPI, CPA, MMP, DSP, SDK, IAP, KPI) or a proper noun ` +
      `(company name, product name, branded event name).`,
    ],
    suggestions: [
      "Rewrite every flagged Latin run in the target language. Single " +
      "industry-standard adtech tokens (cohort, retention, event) that " +
      "the language's guide explicitly permits MAY stay in English as " +
      "isolated single words, but never as multi-word sequences like " +
      "\"quality user acquisition\" or \"approved revenue events\". " +
      "Multi-word English phrases are always a violation in non-Latin scripts.",
      "If a Latin phrase is genuinely a proper noun (e.g., \"Brand Day\", " +
      "\"King Power Online\"), keep it. The detector only flags lowercase " +
      "multi-word runs, but if you produced an all-capitalized phrase that " +
      "is not actually a proper noun, treat it the same way \u2014 rewrite it " +
      "natively.",
    ],
    matches: violations,
  };
}

/**
 * Convenience: run both detectors and merge their reports.
 */
export function detectAllDeterministicViolations(body: string, languageTag: string): ViolationReport {
  const doc = detectDoctrineViolations(body, languageTag);
  const nat = detectNativenessViolations(body, languageTag);
  return {
    found: doc.found || nat.found,
    issues: [...doc.issues, ...nat.issues],
    suggestions: [...doc.suggestions, ...nat.suggestions],
    matches: [...doc.matches, ...nat.matches],
  };
}
