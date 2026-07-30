/**
 * Structural lint: deterministic, model-independent checks that run alongside
 * the existing doctrine and nativeness linters (doctrineLint.ts). The point is
 * to catch the mechanical rules a regex can catch with certainty, so the LLM
 * critic only has to judge what a regex cannot: relevance, meaningful
 * differentiation, tone, and naturalness nuance. That division of labor is
 * what lets a cheaper critic model stay reliable.
 *
 * Every rule is additive and individually gated. The whole layer can be
 * disabled with STRUCTURAL_LINT_ENABLED=0 if it ever misbehaves in production,
 * and each rule has its own switch.
 *
 * Rules:
 *   A. SENTENCE-COUNT cap. Doctrine: "Maximum 4-6 sentences." Flags drafts
 *      whose sentence count exceeds the cap. Skipped for scripts without
 *      punctuation sentence delimiters (Thai, Lao, Khmer, Burmese).
 *   B. FORBIDDEN-DASH. Doctrine bans em dashes and en dashes in the body.
 *   C. VERBATIM-OVERLAP. Flags a long contiguous span copied from the original
 *      outreach, the dominant "repeats the pitch verbatim" differentiation
 *      failure. Span length is script-aware.
 *   D. FOLLOWUP-ACK. Every email this pipeline produces is a follow-up and must
 *      reference prior outreach in the opening. Flags the absence of any
 *      acknowledgment marker. Applied only for languages with a marker table,
 *      to keep false positives bounded; skipped for untabled languages.
 *
 * Returns a ViolationReport in the exact shape doctrineLint uses, so callers
 * can merge it into the existing deterministic gate with no shape changes.
 */
import type { ViolationReport } from "./doctrineLint";

const EMPTY: ViolationReport = { found: false, issues: [], suggestions: [], matches: [] };

// ----------------------------------------------------------------------------
// env helpers (read at call time so deployment-secret changes take effect)
// ----------------------------------------------------------------------------
function envFlag(name: string, dflt: boolean): boolean {
  const v = process.env[name];
  if (v == null || v === "") return dflt;
  const low = v.toLowerCase();
  return !(low === "0" || low === "false" || low === "no" || low === "off");
}
function envInt(name: string, dflt: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

function langBase(tag: string | undefined | null): string {
  if (!tag) return "en";
  return tag.split(/[-_]/)[0].toLowerCase();
}

// Scripts without a reliable punctuation sentence delimiter: skip the
// sentence-count rule for these and let the LLM judge length.
const NON_DELIMITED_SENTENCE_LANGS = new Set(["th", "lo", "km", "my"]);

// Dense scripts (no inter-word spaces): use a shorter verbatim-overlap window,
// since a given character count covers far more meaning than in spaced scripts.
const DENSE_SCRIPT_LANGS = new Set(["zh", "ja", "ko", "th", "lo", "km", "my"]);

// Per-language follow-up acknowledgment markers. Absence of every marker in
// the opening flags the draft. Languages NOT present here are skipped entirely
// (no flag), so an untabled language never produces a false positive.
const ACK_MARKERS: Record<string, string[]> = {
  en: ["following up", "follow up on", "circling back", "circle back", "reached out", "my previous email", "my last email", "my earlier email", "my note", "touching base", "wanted to revisit", "reaching out again", "my message about", "my email about"],
  es: ["dando seguimiento", "retomando", "mi correo anterior", "mi mensaje anterior", "te escribi", "les escribi", "volviendo a", "mi nota sobre", "mi correo sobre", "siguiendo con"],
  pt: ["dando seguimento", "retomando", "meu e-mail anterior", "meu email anterior", "minha mensagem anterior", "escrevi sobre", "voltando ao", "voltando a", "meu contato anterior", "minha nota sobre"],
  fr: ["pour faire suite", "je reviens vers vous", "mon precedent", "mon dernier e-mail", "mon dernier email", "mon message precedent", "je vous ai ecrit", "suite a mon", "faisant suite"],
  de: ["ich komme zuruck auf", "meine vorherige", "meine letzte e-mail", "meine letzte email", "ich hatte geschrieben", "anknupfend an", "bezugnehmend auf", "meine nachricht", "in bezug auf meine", "melde mich noch einmal", "melde mich erneut", "melde mich nochmals", "zu meiner e-mail", "zu meiner email", "auf meine e-mail", "auf meine email", "meine e-mail uber", "meine email uber", "wie bereits geschrieben", "ich wollte noch einmal"],
  it: ["a seguito della", "tornando alla", "la mia precedente", "il mio messaggio precedente", "ti avevo scritto", "ricollegandomi", "facendo seguito"],
  ru: ["возвращаясь к", "в продолжение", "мое предыдущее письмо", "моего предыдущего письма", "писал вам", "ранее писал", "в дополнение к моему", "напоминаю о"],
  uk: ["повертаючись до", "на продовження", "мій попередній лист", "писав вам", "раніше писав"],
  ja: ["先日", "以前", "前回", "再度", "先ほど", "先般", "改めてご連絡", "お送りした"],
  zh: ["跟进", "上次", "之前", "再次联系", "我之前", "上一封", "跟進", "之前发的", "之前發的", "续上次", "给您发过", "给你发过", "发过一封", "发送过", "上封", "给您写过", "给你写过", "此前发"],
  ko: ["지난번", "이전에", "앞서", "다시 연락", "보내드린", "지난 이메일", "지난 메일"],
  ar: ["متابعة", "في إشارة إلى", "رسالتي السابقة", "بريدي السابق", "تواصلت معك", "سبق أن راسلتك", "أتابع بخصوص"],
  he: ["בהמשך", "חוזר אליך", "המייל הקודם", "המייל הקודם שלי", "הודעתי הקודמת", "כתבתי לך", "פניתי אליך", "במענה ל", "חזרתי על", "חזרתי אל", "חוזר למייל", "חוזר להודעה", "חוזר על", "חוזר אל", "חוזרת על"],
  hi: ["फॉलो अप", "पिछले ईमेल", "पिछले संदेश", "मैंने आपको लिखा", "आगे बढ़ते हुए", "पिछली बार"],
  vi: ["theo dõi", "tiếp nối", "email trước", "tin nhắn trước", "tôi đã liên hệ", "nhắc lại", "thư trước"],
  th: ["ติดตาม", "อีเมลก่อนหน้า", "ข้อความก่อนหน้า", "ติดต่อไป", "ตามที่ได้"],
  tr: ["takip", "onceki e-posta", "onceki mesaj", "size yazmistim", "geri donus", "daha once"],
  pl: ["nawiazujac do", "w nawiazaniu", "moj poprzedni", "pisalem do", "wracajac do", "kontynuujac"],
  nl: ["ter opvolging", "mijn vorige e-mail", "mijn vorige bericht", "ik schreef", "terugkomend op", "naar aanleiding van mijn"],
  id: ["menindaklanjuti", "email sebelumnya", "pesan sebelumnya", "saya menghubungi", "sebelumnya saya", "kembali menghubungi"],
};

// ----------------------------------------------------------------------------
// Rule A: sentence-count cap
// ----------------------------------------------------------------------------
function countSentences(body: string): number {
  const protectedText = body
    // protect decimals and thousands separators ("250.5", "1,000")
    .replace(/\d[.,]\d/g, "0")
    // neutralize common abbreviations that carry a period
    .replace(/\b(?:e\.g|i\.e|etc|vs|mr|mrs|ms|dr|inc|ltd|co|no)\.?/gi, "x");
  const groups = protectedText.match(/[.!?。．！？…؟।]+/g) || [];
  return groups.length;
}

// ----------------------------------------------------------------------------
// Rule C: verbatim / near-verbatim overlap with the original outreach
// ----------------------------------------------------------------------------
function normalizeOverlap(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripGreetingLine(body: string): string {
  const lines = body.split(/\n/);
  if (lines.length > 1 && lines[0].trim().length > 0 && lines[0].trim().length <= 60) {
    return lines.slice(1).join("\n");
  }
  return body;
}

function longestSharedSpan(body: string, original: string, lang: string): string | null {
  const dense = DENSE_SCRIPT_LANGS.has(lang);
  const L = dense ? envInt("STRUCTURAL_OVERLAP_CHARS_CJK", 16) : envInt("STRUCTURAL_OVERLAP_CHARS", 45);
  const nd = normalizeOverlap(stripGreetingLine(body));
  const no = normalizeOverlap(original);
  if (nd.length < L || no.length < L) return null;
  for (let i = 0; i + L <= nd.length; i++) {
    const win = nd.slice(i, i + L);
    if (no.includes(win)) return win;
  }
  return null;
}

// ----------------------------------------------------------------------------
// Rule D: follow-up acknowledgment marker in the opening
// ----------------------------------------------------------------------------
// Fold Latin diacritics so a marker written in plain ASCII matches accented
// text, and vice versa. The markers below are authored without umlauts and
// accents; this makes German (ueber), French (precedent), and Spanish text
// match. Both the head and the markers are folded, so any decomposition is
// symmetric and non-Latin scripts (CJK, Arabic, Hebrew) match unchanged.
function foldDiacritics(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ß/g, "ss");
}

function hasAckMarker(body: string, markers: string[]): boolean {
  const head = foldDiacritics(body.slice(0, 320).toLowerCase());
  return markers.some((m) => head.includes(foldDiacritics(m.toLowerCase())));
}

// ----------------------------------------------------------------------------
// Merge helper
// ----------------------------------------------------------------------------
export function mergeViolationReports(...reports: ViolationReport[]): ViolationReport {
  const issues: string[] = [];
  const suggestions: string[] = [];
  const matches: string[] = [];
  let found = false;
  for (const r of reports) {
    if (!r) continue;
    if (r.found) found = true;
    issues.push(...r.issues);
    suggestions.push(...r.suggestions);
    matches.push(...r.matches);
  }
  if (!found) return EMPTY;
  return { found: true, issues, suggestions, matches };
}

export interface StructuralOpts {
  languageTag: string;
  /** Concatenated original outreach (subject + body + summary) for overlap. */
  originalText?: string;
}

export function detectStructuralViolations(body: string, opts: StructuralOpts): ViolationReport {
  if (!envFlag("STRUCTURAL_LINT_ENABLED", true)) return EMPTY;
  if (!body || !body.trim()) return EMPTY;

  const lang = langBase(opts.languageTag);
  const reports: ViolationReport[] = [];

  // A. sentence-count cap
  if (envFlag("STRUCTURAL_CHECK_SENTENCES", true) && !NON_DELIMITED_SENTENCE_LANGS.has(lang)) {
    const cap = envInt("STRUCTURAL_MAX_SENTENCES", 7);
    const n = countSentences(body);
    if (n > cap) {
      reports.push({
        found: true,
        issues: [
          `SENTENCE-COUNT - the draft has ${n} sentences, above the ${cap}-sentence cap. ` +
          `Doctrine: maximum 4-6 sentences, no walls of text.`,
        ],
        suggestions: [
          "Cut the draft to 6 sentences or fewer. Keep the acknowledgment of prior " +
          "outreach, one concrete proof point, and the soft CTA. Merge or drop the rest.",
        ],
        matches: [`${n} sentences`],
      });
    }
  }

  // B. forbidden dashes (em dash U+2014, en dash U+2013)
  if (envFlag("STRUCTURAL_BAN_DASHES", true)) {
    const m = body.match(/[\u2014\u2013]/g);
    if (m && m.length > 0) {
      reports.push({
        found: true,
        issues: [
          `FORBIDDEN-DASH - the draft contains ${m.length} em dash or en dash character(s). ` +
          `Doctrine bans both in the email body.`,
        ],
        suggestions: [
          "Replace every \u2014 and \u2013 with a comma, a period, or a hyphen.",
        ],
        matches: [`dash x${m.length}`],
      });
    }
  }

  // C. verbatim overlap with the original outreach
  if (envFlag("STRUCTURAL_CHECK_OVERLAP", true) && opts.originalText && opts.originalText.trim()) {
    const span = longestSharedSpan(body, opts.originalText, lang);
    if (span) {
      reports.push({
        found: true,
        issues: [
          `VERBATIM-OVERLAP - the draft copies a long span from the original outreach, ` +
          `which reads as repeating the prior pitch instead of advancing it. ` +
          `Copied span: "${span.slice(0, 80)}".`,
        ],
        suggestions: [
          "Rewrite the overlapping span from a fresh angle. A follow-up should add a new " +
          "proof point or reframe the value, not restate the original email's wording.",
        ],
        matches: [span.slice(0, 80)],
      });
    }
  }

  // D. follow-up acknowledgment marker in the opening
  if (envFlag("STRUCTURAL_REQUIRE_ACK", true)) {
    const markers = ACK_MARKERS[lang];
    if (markers && !hasAckMarker(body, markers)) {
      reports.push({
        found: true,
        issues: [
          `FOLLOWUP-ACK - the opening does not reference prior outreach (${lang}). ` +
          `Every email here is a follow-up and must reference the previous email or ` +
          `message in the first 1-2 sentences after the greeting.`,
        ],
        suggestions: [
          `Open with an explicit acknowledgment of the prior outreach, then continue. ` +
          `Use a natural ${lang} equivalent of "following up on my note about ...".`,
        ],
        matches: ["no acknowledgment marker in opening"],
      });
    }
  }

  return mergeViolationReports(...reports);
}
