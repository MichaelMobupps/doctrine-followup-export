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
 *   E. LAYOUT-SINGLE-BLOCK. A greeting run into the first sentence, or a
 *      multi-sentence body with no blank line anywhere, is the shape every
 *      follow-up shipped in before 2026-08-26 and the fastest way to be read
 *      as machine-written. layoutShaper.ts normalises the shape on the way
 *      out regardless; this rule exists so the rewrite loop gets a chance to
 *      produce the blocks itself, which reads better than a body cut up
 *      after the fact.
 *
 * Returns a ViolationReport in the exact shape doctrineLint uses, so callers
 * can merge it into the existing deterministic gate with no shape changes.
 */
import type { ViolationReport } from "./doctrineLint";
import { splitGreetingLine } from "./layoutShaper";

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

// Languages whose standard typography uses the em dash or en dash as
// native punctuation. The dash ban is an English anti-AI-tell rule, so it
// does not apply to these. Russian and Ukrainian use the em dash to join
// clauses and replace a copula; Chinese, Japanese, and Korean use the
// full-width dash as standard punctuation.
const DASH_NATIVE_LANGS = new Set(["ru", "uk", "zh", "ja", "ko"]);

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
  // ru extended 2026-08-27: live drafts opened with natural continuation
  // framings the original eight markers never matched — "Продолжаю нашу
  // переписку по поводу…" / "Продолжаю свою мысль относительно…" are textbook
  // Russian follow-up acknowledgments, yet every one produced a FOLLOWUP-ACK
  // false positive, a needless rewrite cycle, and a STILL-FAILING E2E cell.
  // Markers only SUPPRESS the flag, so additions are fail-open safe.
  ru: ["возвращаясь к", "в продолжение", "мое предыдущее письмо", "моего предыдущего письма", "писал вам", "ранее писал", "в дополнение к моему", "напоминаю о", "продолжаю", "продолжая", "снова пишу", "пишу вам снова", "хочу вернуться к", "вернуться к моему", "предыдущем письме", "прошлом письме", "прошлое письмо", "писала вам", "ранее писала", "напомнить о", "напомню о"],
  // uk mirrors the ru extension (same continuation-verb gap, same morphology).
  uk: ["повертаючись до", "на продовження", "мій попередній лист", "писав вам", "раніше писав", "продовжую", "продовжуючи", "знову пишу", "попередньому листі", "попереднього листа", "писала вам", "раніше писала"],
  ja: ["先日", "以前", "前回", "再度", "先ほど", "先般", "改めてご連絡", "お送りした"],
  zh: ["跟进", "上次", "之前", "再次联系", "我之前", "上一封", "跟進", "之前发的", "之前發的", "续上次", "给您发过", "给你发过", "发过一封", "发送过", "上封", "给您写过", "给你写过", "此前发"],
  ko: ["지난번", "이전에", "앞서", "다시 연락", "보내드린", "지난 이메일", "지난 메일"],
  ar: ["متابعة", "في إشارة إلى", "رسالتي السابقة", "بريدي السابق", "تواصلت معك", "سبق أن راسلتك", "أتابع بخصوص"],
  he: ["בהמשך", "חוזר אליך", "המייל הקודם", "המייל הקודם שלי", "הודעתי הקודמת", "כתבתי לך", "פניתי אליך", "במענה ל", "חזרתי על", "חזרתי אל", "חוזר למייל", "חוזר להודעה", "חוזר על", "חוזר אל", "חוזרת על"],
  // hi extended 2026-08-27: the table only knew masculine agreement (पिछले)
  // and missed the feminine पिछली (ईमेल/मेल are commonly feminine in Hindi),
  // plus the "returning to my message" (…पर लौट रहा हूँ) and "contacting again"
  // framings live drafts actually use. Same fail-open safety as ru.
  hi: ["फॉलो अप", "पिछले ईमेल", "पिछले संदेश", "मैंने आपको लिखा", "आगे बढ़ते हुए", "पिछली बार", "पिछली ईमेल", "पिछली मेल", "पिछले मेल", "मेरे पिछले", "मेरी पिछली", "लौट रहा", "लौट रही", "दोबारा संपर्क", "फिर से संपर्क", "दोबारा लिख", "फिर से लिख", "याद दिला", "स्मरण करा"],
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

function longestSharedSpan(
  body: string,
  original: string,
  lang: string,
  companyName?: string,
): string | null {
  const dense = DENSE_SCRIPT_LANGS.has(lang);
  const L = dense ? envInt("STRUCTURAL_OVERLAP_CHARS_CJK", 16) : envInt("STRUCTURAL_OVERLAP_CHARS", 45);
  let nd = normalizeOverlap(stripGreetingLine(body));
  let no = normalizeOverlap(original);
  // The prospect's company name appears in both the original outreach and every
  // follow-up by necessity, so it is not a copied pitch. Blank it out of both
  // sides before scanning, otherwise a multi-word company name like
  // "Wanderly Travel" registers as a shared span on every retargeting email.
  if (companyName && companyName.trim()) {
    const c = normalizeOverlap(companyName);
    if (c.length >= 3) {
      const re = new RegExp(c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
      nd = nd.replace(re, " ").replace(/\s+/g, " ").trim();
      no = no.replace(re, " ").replace(/\s+/g, " ").trim();
    }
  }
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

// Structure-based acknowledgment fallback. An acknowledgment of prior outreach
// almost always carries at least two of three signals: it names a prior message
// (REF), it uses a contact, send, write, follow-up, or return verb (VERB), and
// it marks the contact as earlier or repeated (PRIOR). Requiring any two of the
// three catches valid acknowledgments whose exact phrasing is not in the
// standalone list, including verb-form and tense variants, without passing an
// email that merely mentions one of them in isolation. Terms are folded and
// lowercased like the head, and matched as substrings so conjugations are
// covered. Languages absent from a table simply fall back to the standalone list.
const ACK_REF: Record<string, string[]> = {
  en: ["email", "message", "note"],
  es: ["correo", "mensaje", "nota"],
  pt: ["e-mail", "email", "mensagem", "nota", "contato"],
  fr: ["e-mail", "email", "courriel", "message", "note"],
  de: ["mail", "e-mail", "email", "nachricht", "zeilen", "vorschlag", "anliegen", "anfrage"],
  it: ["e-mail", "email", "messaggio", "nota"],
  ru: ["письм", "сообщени", "обсуждени", "разговор"],
  uk: ["лист", "повідомлен", "розмов"],
  ja: ["メール", "ご連絡", "連絡"],
  zh: ["邮件", "来信", "信件"],
  ko: ["메일", "이메일", "메시지"],
  ar: ["رسالة", "رسالتي", "بريد", "ايميل", "إيميل"],
  he: ["מייל", "הודעה", "מסר", "פניי"],
  th: ["อีเมล", "ข้อความ", "จดหมาย"],
  hi: ["ईमेल", "संदेश", "मेल"],
  vi: ["email", "tin nhắn", "thư"],
  tr: ["e-posta", "mesaj", "mail"],
  pl: ["e-mail", "email", "wiadomosc", "list"],
  nl: ["e-mail", "email", "bericht"],
  id: ["email", "pesan", "surel"],
};
const ACK_VERB: Record<string, string[]> = {
  en: ["sent you", "i sent", "wrote to", "wrote you", "reached out", "reaching out", "followed up", "following up", "circling back", "getting back to", "revisit"],
  es: ["envie", "te escrib", "le escrib", "escribi", "seguimiento", "retom", "volviendo", "siguiendo con", "contacte"],
  pt: ["enviei", "escrevi", "seguimento", "retom", "voltando", "contatei"],
  fr: ["ecrit", "envoye", "faire suite", "suite a mon", "je reviens", "recontact"],
  de: ["geschrieben", "gesendet", "gesandt", "melde mich", "komme zuruck", "komme auf", "zuruckkomm", "zuruckgekomm", "anknupf", "bezugneh", "kontaktiert", "wollte mich"],
  it: ["scritto", "inviato", "facendo seguito", "ricolleg", "ritorn", "riprend", "contattato"],
  ru: ["писал", "отправ", "возвраща", "возвращ", "продолж", "напомина", "пишу вам", "пишу, чтобы"],
  uk: ["писав", "надісл", "поверта", "продовж", "нагаду"],
  ja: ["お送り", "送りした", "書い", "ご連絡", "フォロー", "改めて"],
  zh: ["发过", "发送过", "写过", "写信", "发信", "致信", "去信", "给您发", "向您发", "发邮件", "联系您", "联系过", "跟进", "跟進", "提到", "提及", "联络您"],
  ko: ["보내", "드린", "연락", "후속"],
  ar: ["راسلت", "أرسلت", "كتبت", "تواصلت", "أتابع", "متابعة", "أعود", "اعود"],
  he: ["כתבתי", "שלחתי", "פניתי", "חוזר", "חזרתי", "פונה", "יצרתי קשר"],
  th: ["ส่งอีเมล", "ส่งข้อความ", "เขียนถึง", "ติดตามผล", "ติดตาม", "กลับมาติดตาม", "ติดต่อ", "ขอติดต่อ", "คุยกัน"],
  hi: ["भेजा", "लिखा", "संपर्क", "फॉलो"],
  vi: ["đã gửi", "đã viết", "liên hệ", "theo dõi"],
  tr: ["yazmistim", "gonderdim", "iletmistim", "ilet", "takip"],
  pl: ["pisalem", "wyslalem", "kontaktowa", "nawiazuj"],
  nl: ["schreef", "stuurde", "opvolging", "terugkom"],
  id: ["mengirim", "menulis", "menghubungi", "menindaklanjuti"],
};
const ACK_PRIOR: Record<string, string[]> = {
  en: ["previous", "earlier", "prior", "last week", "last email", "last message", "again"],
  es: ["anterior", "ultimo", "ultima", "ultimos", "ultimas", "previo", "previa", "pasado", "pasada", "nuevamente", "de nuevo"],
  pt: ["anterior", "ultimo", "ultima", "ultimos", "ultimas", "previo", "novamente"],
  fr: ["precedent", "precedente", "dernier", "derniere", "anterieur", "a nouveau"],
  de: ["vorherig", "letzte", "fruher", "erneut", "noch einmal", "nochmals", "bereits"],
  it: ["precedente", "ultimo", "ultima", "scorso", "scorsa", "di nuovo"],
  ru: ["предыдущ", "прошл", "ранее", "еще раз", "ещё раз", "снова", "повторно"],
  uk: ["попередн", "минул", "раніше", "ще раз", "знову"],
  ja: ["先日", "以前", "前回", "先ほど", "先般", "再度"],
  zh: ["此前", "之前", "上次", "上封", "上一封", "先前", "早前", "日前", "上周", "上个月", "上月", "前几天", "几天前", "近日", "早些时候"],
  ko: ["지난", "이전", "앞서", "먼저", "전에", "다시"],
  ar: ["السابق", "السابقة", "السابقه", "مجددا", "ثانية"],
  he: ["הקודם", "הקודמת", "קודם", "לפני", "שוב", "שנית", "מחדש", "לאחרונה"],
  th: ["ก่อนหน้านี้", "ก่อนหน้า", "ที่แล้ว", "อีกครั้ง", "ครั้งก่อน"],
  hi: ["पिछले", "पहले", "फिर", "दोबारा"],
  vi: ["trước", "lần trước", "lại"],
  tr: ["onceki", "gecen", "daha once", "tekrar"],
  pl: ["poprzedni", "ostatni", "wczesniej", "ponownie"],
  nl: ["vorige", "laatste", "eerder", "opnieuw"],
  id: ["sebelumnya", "terakhir", "lagi"],
};

function categoryHit(head: string, terms: string[] | undefined): boolean {
  if (!terms) return false;
  return terms.some((t) => head.includes(foldDiacritics(t.toLowerCase())));
}

function hasAckMarker(body: string, markers: string[], lang: string): boolean {
  const head = foldDiacritics(body.slice(0, 320).toLowerCase());
  if (markers.some((m) => head.includes(foldDiacritics(m.toLowerCase())))) return true;
  let cats = 0;
  if (categoryHit(head, ACK_REF[lang])) cats++;
  if (categoryHit(head, ACK_VERB[lang])) cats++;
  if (categoryHit(head, ACK_PRIOR[lang])) cats++;
  return cats >= 2;
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
  /** Prospect company name, excluded from overlap so the required brand
   *  mention is not flagged as a copied span. */
  companyName?: string;
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

  // B. forbidden dashes (em dash U+2014, en dash U+2013). Skipped for
  // languages where the dash is native punctuation.
  if (envFlag("STRUCTURAL_BAN_DASHES", true) && !DASH_NATIVE_LANGS.has(lang)) {
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
    const span = longestSharedSpan(body, opts.originalText, lang, opts.companyName);
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
    if (markers && !hasAckMarker(body, markers, lang)) {
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

  // E. layout: greeting run-on, or the whole body as one block.
  if (envFlag("STRUCTURAL_CHECK_LAYOUT", true)) {
    const normalised = body.replace(/\r\n/g, "\n").replace(/\\n/g, "\n").trim();
    const firstLine = normalised.split("\n")[0] || "";

    if (splitGreetingLine(firstLine, opts.languageTag)) {
      reports.push({
        found: true,
        issues: [
          `LAYOUT-GREETING-RUNON - the greeting shares a line with the first sentence: ` +
          `"${firstLine.slice(0, 70)}". A person puts the greeting on its own line.`,
        ],
        suggestions: [
          "Put the greeting alone on the first line and leave a completely blank line " +
          "under it before the first sentence.",
        ],
        matches: [firstLine.slice(0, 70)],
      });
    }

    // The block check needs a sentence count, so it is skipped for the same
    // scripts rule A skips.
    if (!NON_DELIMITED_SENTENCE_LANGS.has(lang) && !/\n\s*\n/.test(normalised)) {
      const n = countSentences(normalised);
      if (n >= 3) {
        reports.push({
          found: true,
          issues: [
            `LAYOUT-SINGLE-BLOCK - the body is ${n} sentences delivered as one ` +
            `unbroken block with no blank line anywhere. This is the shape a ` +
            `recipient reads as machine-written before judging a single word.`,
          ],
          suggestions: [
            "Break the body into at least two blocks separated by a blank line, " +
            "following the LAYOUT block supplied with the draft. Use prose blocks, " +
            "never bullets or numbered lines.",
          ],
          matches: [`${n} sentences, 0 blank lines`],
        });
      }
    }
  }

  return mergeViolationReports(...reports);
}
