/**
 * Grey-area vertical detector.
 *
 * The writer-provider fallback chain (Gemini Flash -> Gemini Pro -> Sonnet)
 * applies to ordinary verticals. Regulated "grey area" verticals stay on
 * Sonnet by default and never route to a Gemini tier. The reasons are
 * compliance and consistency: gambling, betting, casino, and high-risk
 * financial offers (crypto exchanges, forex/CFD brokers) carry language and
 * claim-handling rules where the highest-tier model is the safer writer, and
 * where a model-family swap could shift tone or trip a provider content
 * filter mid-batch.
 *
 * This module is deterministic and dependency-free so it is hermetically
 * testable. It scans the structured FollowupContext fields plus the original
 * subject and summary for unambiguous grey-area signals. When in doubt it
 * routes to Sonnet: a false positive costs a few cents of Sonnet tokens, a
 * false negative writes a regulated email on the wrong tier.
 *
 * The signal set is extensible at runtime via WRITER_GREY_VERTICALS, a
 * comma-separated list of extra lowercase substrings appended to the built-in
 * terms. WRITER_GREY_SCAN_BODY=on additionally scans the full original body
 * with the strong-term set only (default off, since the body can mention a
 * grey term incidentally).
 */

// Minimal structural shape. Kept local so this module has no service imports
// and stays trivially testable. FollowupContext in followupPrompts.ts is a
// structural superset, so it satisfies this interface at every call site.
export interface GreyAreaInput {
  vertical?: string | null;
  sub_vertical?: string | null;
  product?: string | null;
  company?: string | null;
  original_subject?: string | null;
  original_body_summary?: string | null;
  original_body?: string | null;
}

export interface GreyAreaResult {
  grey: boolean;
  signals: string[];
}

// Unambiguous grey-area terms. These rarely appear incidentally in a
// non-grey B2B media email, so they are safe to match across all scanned
// fields. Lowercase; matched as word-ish substrings via a boundary regex.
const STRONG_TERMS: string[] = [
  "casino",
  "sportsbook",
  "igaming",
  "i-gaming",
  "gambling",
  "gamble",
  "betting",
  "bookmaker",
  "bookie",
  "roulette",
  "baccarat",
  "blackjack",
  "poker",
  "slots",
  "lottery",
  "lotto",
  "forex",
  "cfd",
  "cfds",
  "binary option",
  "binary options",
  "spread betting",
  "cryptocurrency",
  "crypto exchange",
  "crypto casino",
  "crypto trading",
  "trading broker",
  "fx broker",
  "online betting",
  "sports betting",
  "sports_betting",
];

// Softer terms that are grey only when they sit in a structured vertical /
// product field, not in free narrative text. "crypto" and "trading" alone are
// too broad to scan body text for, but in a vertical/product/sub-vertical slot
// they are a real routing signal.
const STRUCTURED_ONLY_TERMS: string[] = [
  "crypto",
  "trading",
  "broker",
  "wagering",
  "esports betting",
];

function extraTerms(): string[] {
  const raw = process.env.WRITER_GREY_VERTICALS;
  if (!raw) return [];
  return raw
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
}

function scanBodyEnabled(): boolean {
  return (process.env.WRITER_GREY_SCAN_BODY || "").toLowerCase() === "on";
}

function norm(s: string | null | undefined): string {
  return (s || "").toLowerCase();
}

// Match a term as a whole-ish token: a non-letter boundary on each side so
// "poker" matches "poker app" but not "smokers". Multi-word terms (with a
// space or hyphen) are matched as a plain substring since they are already
// specific.
function containsTerm(haystack: string, term: string): boolean {
  if (!haystack) return false;
  if (term.includes(" ") || term.includes("-") || term.includes("_")) {
    return haystack.includes(term);
  }
  const re = new RegExp(`(^|[^a-z])${term}([^a-z]|$)`, "i");
  return re.test(haystack);
}

/**
 * Decide whether a follow-up is in a regulated grey-area vertical that must
 * stay on the Sonnet writer.
 *
 * Strong terms are scanned across the structured fields, company, subject, and
 * summary (and the body when WRITER_GREY_SCAN_BODY=on). Structured-only terms
 * are scanned across the vertical / sub_vertical / product fields only. Any
 * single hit makes the follow-up grey.
 */
export function detectGreyArea(input: GreyAreaInput): GreyAreaResult {
  const strong = [...STRONG_TERMS, ...extraTerms()];
  const signals: string[] = [];

  const structuredFields: Array<[string, string]> = [
    ["vertical", norm(input.vertical)],
    ["sub_vertical", norm(input.sub_vertical)],
    ["product", norm(input.product)],
  ];
  const textFields: Array<[string, string]> = [
    ...structuredFields,
    ["company", norm(input.company)],
    ["original_subject", norm(input.original_subject)],
    ["original_body_summary", norm(input.original_body_summary)],
  ];
  if (scanBodyEnabled()) {
    textFields.push(["original_body", norm(input.original_body)]);
  }

  for (const [field, value] of textFields) {
    for (const term of strong) {
      if (containsTerm(value, term)) signals.push(`${field}:${term}`);
    }
  }
  for (const [field, value] of structuredFields) {
    for (const term of STRUCTURED_ONLY_TERMS) {
      if (containsTerm(value, term)) signals.push(`${field}:${term}`);
    }
  }

  const unique = Array.from(new Set(signals));
  return { grey: unique.length > 0, signals: unique.slice(0, 8) };
}

/** Convenience boolean wrapper. */
export function isGreyArea(input: GreyAreaInput): boolean {
  return detectGreyArea(input).grey;
}
