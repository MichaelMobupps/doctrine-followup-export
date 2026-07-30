/**
 * spamRiskLint.ts — deterministic deliverability / spam-signal linter.
 *
 * Production incident 2026-07-23 (Sarit/wmadv analysis of a Followupper email
 * that landed in spam): receiving-side filters flagged content because of
 * (a) follow-up-count phrasing ("reached out 6 times"), (b) financial-bait
 * trigger words ("Bitcoins"), and (c) dry list formatting (a bulleted blob of
 * brand names). None of the existing linters (doctrineLint, structuralLint,
 * competitorScriptLint) covered these — this module closes that gap.
 *
 * Two consumers:
 *   detectSpamRiskViolations(body, opts) — ViolationReport in the exact shape
 *     doctrineLint uses. Merged into every generator's deterministic gate so
 *     a flagged draft is rewritten through the existing healing loop.
 *   assessSpamRisk(subject, body, languageTag, originalText) — weighted score
 *     for the SEND-TIME gate in the scheduler and the approval-send routes.
 *     Bodies generated before this linter shipped (stored generatedBody rows)
 *     pass through the send gate too, so pre-fix drafts cannot ship dirty.
 *
 * GROUNDING EXEMPTION: a trigger token that also appears in the ORIGINAL
 * outreach text is exempt. Two legitimate cases force this: (1) proper nouns —
 * "Mercado Bitcoin" is a brand, not bait; (2) vertical vocabulary — a crypto
 * exchange's own follow-ups will legitimately say "crypto". A trigger the
 * writer INVENTED (absent from the original) is always flagged.
 *
 * Every rule is individually env-gated and the whole layer can be disabled
 * with SPAM_LINT_ENABLED=0, mirroring structuralLint's kill switches.
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

function langBase(tag: string | undefined | null): string {
  if (!tag) return "en";
  return tag.split(/[-_]/)[0].toLowerCase();
}

function foldDiacritics(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ß/g, "ss");
}

// ----------------------------------------------------------------------------
// S1 — FOLLOWUP-COUNT: never tell the prospect (or the filter) how many times
// you have contacted them. "reached out 6 times" is the exact phrase from the
// 2026-07-23 incident. English gets strong dedicated patterns; other tabled
// languages use a count-word + contact-verb same-sentence heuristic. Untabled
// languages are SKIPPED (never guessed), per structuralLint convention.
// ----------------------------------------------------------------------------
const EN_COUNT_WORDS =
  "\\d+|two|three|four|five|six|seven|eight|nine|ten|several|multiple|many|numerous|countless|a few";

const EN_FOLLOWUP_COUNT_RES: RegExp[] = [
  // "reached out (to you) 6 times", "emailed you several times", "I have written three times"
  new RegExp(
    `\\b(?:reached out|followed up|emailed|contacted|messaged|written|wrote|pinged)(?:\\s+(?:to\\s+)?you)?(?:\\s+\\w+){0,2}\\s+(?:${EN_COUNT_WORDS})\\s+times\\b`,
    "i",
  ),
  // "my third email", "my 4th attempt" — ordinals with any contact noun.
  // "my last/final EMAIL/NOTE" is natural stage-3 phrasing ("following up on
  // my last email") and must NOT flag; last/final only flag with attempt/try.
  /\bmy\s+(?:\d+(?:st|nd|rd|th)|second|third|fourth|fifth|sixth)\s+(?:attempt|email|message|note|follow[- ]?up|try)\b|\bmy\s+(?:last|final)\s+(?:attempt|try)\b/i,
  // "this is the third time I'm reaching out / writing / trying"
  /\b(?:the|my)\s+(?:\d+(?:st|nd|rd|th)|second|third|fourth|fifth|sixth)\s+time\s+(?:that\s+)?(?:i|we)\b/i,
  // "after 5 emails / 3 attempts / 4 unanswered messages (without a reply)"
  /\bafter\s+(?:\d+|two|three|four|five|six)\s+(?:unanswered\s+)?(?:emails?|messages?|attempts?|tries)\b/i,
  // "3 previous emails", "several prior attempts"
  /\b(?:\d+|two|three|four|five|six|several|multiple)\s+(?:previous|prior|unanswered|earlier)\s+(?:emails?|messages?|attempts?|notes?)\b/i,
  // "without a response/reply" stacked on a count elsewhere is caught above;
  // "still haven't heard back despite my emails" — guilt-trip phrasing
  /\bdespite\s+my\s+(?:several|multiple|many|repeated|previous)?\s*(?:emails?|messages?|attempts?)\b/i,
];

// Non-English: flag only when ONE SENTENCE contains both a count-of-times
// marker and a contact verb. Latin-script languages are matched on
// diacritic-folded lowercased text; ru/uk/he are matched on plain lowercased
// text (NFD folding would corrupt й → и). JS \b is Latin-only, so the
// Cyrillic/Hebrew patterns use \p{L} lookarounds instead. Bounded to
// languages with a table; others are skipped.
const COUNT_MARKERS: Record<string, RegExp> = {
  es: /\b(?:\d+|dos|tres|cuatro|cinco|seis|varias|multiples|muchas)\s+veces\b|\b(?:segunda|tercera|cuarta|quinta)\s+vez\b|\b(?:segundo|tercer|cuarto|quinto|ultimo)\s+(?:intento|correo|mensaje)\b/,
  pt: /\b(?:\d+|duas|tres|quatro|cinco|seis|varias|diversas|muitas)\s+vezes\b|\b(?:segunda|terceira|quarta|quinta)\s+vez\b|\b(?:segundo|terceiro|quarto|quinto|ultimo)\s+(?:contato|e-?mail|email|mensagem)\b/,
  fr: /\b(?:\d+|deux|trois|quatre|cinq|six|plusieurs|maintes)\s+fois\b|\b(?:deuxieme|troisieme|quatrieme|cinquieme|dernier(?:e)?)\s+(?:tentative|e-?mail|email|message|relance)\b/,
  de: /\b(?:\d+|zwei|drei|vier|funf|sechs|mehrmals|mehrfach|etliche)\s*(?:-?\s*)?mal\b|\b(?:zweite|dritte|vierte|funfte|letzte)[snr]?\s+(?:versuch|e-?mail|email|nachricht|anlauf)\b/,
  it: /\b(?:\d+|due|tre|quattro|cinque|sei|diverse|piu)\s+volte\b|\b(?:seconda|terza|quarta|quinta|ultima)\s+volta\b|\b(?:secondo|terzo|quarto|quinto|ultimo)\s+(?:tentativo|messaggio|contatto)\b/,
  // "последнее письмо" ("my last email") is natural stage-3 phrasing — only
  // true ordinals flag with a noun; "последний раз" (one last time) stays.
  ru: /(?<![\p{L}\p{N}])(?:\d+|два|две|три|четыре|пять|шесть|несколько|много)\s+раз(?:а|ов)?(?!\p{L})|(?<![\p{L}])(?:второй|третий|четвертый|пятый|последний)\s+раз(?!\p{L})|(?<![\p{L}])(?:второе|третье|четвертое|пятое)\s+(?:письмо|сообщение)/u,
  uk: /(?<![\p{L}\p{N}])(?:\d+|два|дві|три|чотири|п'ять|шість|кілька|багато)\s+раз(?:и|ів)?(?!\p{L})|(?<![\p{L}])(?:другий|третій|четвертий|останній)\s+раз(?!\p{L})/u,
  he: /(?<![\p{L}\p{N}])(?:\d+|כמה|מספר|הרבה|שתי|שתיים|שלוש|שלושה|ארבע|ארבעה|חמש|חמישה|שש|שישה)\s+פעמים|פעם\s+(?:שניה|שנייה|שלישית|רביעית|חמישית|אחרונה)|ניסיון\s+(?:שני|שלישי|רביעי|אחרון)|בפעם\s+ה?(?:שניה|שנייה|שלישית|רביעית|אחרונה)/u,
};
const CONTACT_VERBS: Record<string, RegExp> = {
  es: /escrib|escrit|contact|intent|envie|enviado|mande|mandado|insisti/,
  pt: /escrev|escrit|contat|tent|enviei|enviado|mandei|insisti/,
  fr: /ecrit|contact|relanc|essay|envoye|tent/,
  de: /geschrieben|kontaktiert|versucht|gemeldet|geschickt|gesendet|gesandt/,
  it: /scritt|contattat|provat|inviat|mandat/,
  ru: /писал|написал|связ|пытал|обращ|отправ|стучал/,
  uk: /писав|написав|зв'яз|намаг|звертав|надсил|надіслав/,
  he: /כתבתי|פניתי|ניסיתי|שלחתי|התקשרתי|יצרתי קשר/,
};

function splitSentences(text: string): string[] {
  // A period splits a sentence only when followed by whitespace or end of
  // text — "Ng.Cash", "e.g." and decimals stay inside their sentence.
  return text.split(/[.!?。．！？…؟।]+(?=\s|$)|\n+/).filter((s) => s.trim().length > 0);
}

function findFollowupCountMatches(body: string, lang: string): string[] {
  const out: string[] = [];
  if (lang === "en") {
    for (const re of EN_FOLLOWUP_COUNT_RES) {
      const m = body.match(re);
      if (m) out.push(m[0]);
    }
    return out;
  }
  const counter = COUNT_MARKERS[lang];
  const verb = CONTACT_VERBS[lang];
  if (!counter || !verb) return out; // untabled language: skip, never guess
  // ru/uk/he must NOT be diacritic-folded: NFD folding strips the breve off
  // Cyrillic й (третий → третии) and would silently break every pattern
  // containing it. Folding is a Latin-orthography aid only.
  const fold = !(lang === "ru" || lang === "uk" || lang === "he");
  for (const sentence of splitSentences(body)) {
    const norm = fold ? foldDiacritics(sentence.toLowerCase()) : sentence.toLowerCase();
    const cm = norm.match(counter);
    if (cm && verb.test(norm)) {
      out.push(sentence.trim().slice(0, 90));
    }
  }
  return out;
}

// ----------------------------------------------------------------------------
// S2 — SPAM-TRIGGER LEXICON. English phrases plus universal tokens (bitcoin
// in seven scripts — the incident word). Grounding exemption applies: a term
// present in the original outreach is the user's own business vocabulary.
// ----------------------------------------------------------------------------
interface TriggerTerm {
  label: string;
  re: RegExp;
}

const TRIGGER_TERMS: TriggerTerm[] = [
  // Financial bait — the incident class ("Bitcoins")
  // NOTE: JS \b is Latin-only — Cyrillic/Hebrew/CJK tokens are matched as
  // plain substrings (they do not occur inside innocuous longer words).
  { label: "bitcoin", re: /\bbitcoins?\b|биткоин|ביטקוין|بيتكوين|比特币|ビットコイン|비트코인/i },
  { label: "crypto", re: /\bcryptos?\b|\bcryptocurrenc\w+\b|криптовалют|קריפטו|عملات مشفرة|加密货币|仮想通貨|암호화폐/i },
  { label: "free money", re: /\bfree\s+money\b/i },
  { label: "fast cash", re: /\bfast\s+cash\b|\bquick\s+cash\b/i },
  { label: "cash bonus", re: /\bcash\s+bonus\b/i },
  { label: "extra income", re: /\bextra\s+income\b|\bpassive\s+income\b/i },
  { label: "make/earn money fast", re: /\b(?:make|earn)\s+money\s+fast\b/i },
  { label: "double your X", re: /\bdouble\s+your\s+\w+/i },
  { label: "guaranteed results", re: /\bguaranteed\s+(?:income|returns?|profits?|results?|revenue|roi)\b/i },
  { label: "risk-free", re: /\brisk[- ]free\b/i },
  { label: "no obligation", re: /\bno\s+obligation\b/i },
  { label: "100% free", re: /\b100%\s*free\b|\bcompletely\s+free\b|\btotally\s+free\b/i },
  // Urgency bait
  { label: "act now", re: /\bact\s+now\b/i },
  { label: "don't miss", re: /\bdon'?t\s+miss\s+(?:out|this)\b/i },
  { label: "limited time", re: /\blimited\s+time\b/i },
  { label: "final notice", re: /\bfinal\s+notice\b/i },
  { label: "last chance", re: /\blast\s+chance\b/i },
  { label: "expires soon", re: /\bexpires?\s+(?:today|soon|tonight)\b/i },
  { label: "once in a lifetime", re: /\bonce[- ]in[- ]a[- ]lifetime\b/i },
  { label: "exclusive deal", re: /\bexclusive\s+(?:deal|offer|promotion)\b/i },
  { label: "special promotion", re: /\bspecial\s+promotion\b/i },
  // Click bait
  { label: "click here", re: /\bclick\s+(?:here|below|now)\b/i },
  { label: "buy now", re: /\b(?:buy|order|shop)\s+now\b/i },
  { label: "call now", re: /\b(?:call|apply)\s+now\b/i },
  { label: "sign up free", re: /\bsign\s+up\s+(?:for\s+)?free\b/i },
  { label: "claim your", re: /\bclaim\s+your\b/i },
  { label: "you're a winner", re: /\byou(?:'re| are)\s+a\s+winner\b|\bwinner!\B/i },
  { label: "you have been selected", re: /\byou\s+have\s+been\s+(?:selected|chosen)\b/i },
  { label: "congratulations", re: /\bcongratulations\b/i },
];

/**
 * Grounding check. A match is exempt when the matched text itself appears in
 * the original outreach (case-insensitive, whitespace-normalized) — covering
 * proper nouns ("Mercado Bitcoin") and legitimate vertical vocabulary alike.
 */
function normalizeGround(s: string): string {
  return (s || "").toLowerCase().normalize("NFKC").replace(/\s+/g, " ");
}

function isGrounded(matchText: string, groundedSource: string): boolean {
  if (!groundedSource) return false;
  const needle = normalizeGround(matchText).trim();
  if (!needle) return false;
  return groundedSource.includes(needle);
}

function findTriggerMatches(text: string, groundedSource: string): string[] {
  const out: string[] = [];
  for (const term of TRIGGER_TERMS) {
    const re = new RegExp(term.re.source, term.re.flags.includes("g") ? term.re.flags : term.re.flags + "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (!isGrounded(m[0], groundedSource)) {
        out.push(`${m[0]} (${term.label})`);
        break; // one report per term is enough
      }
    }
  }
  return out;
}

// ----------------------------------------------------------------------------
// S3 — LIST-FORMAT. The incident email was a bulleted blob of brand names.
// Doctrine wants 4-6 sentences of prose, so any list shape is doubly wrong.
// ----------------------------------------------------------------------------
const BULLET_LINE_RE = /^\s*(?:[-*•‣▪◦→]|(?:\d{1,2}|[a-zA-Z])[.)])\s+\S/;

function stripGreetingLine(body: string): string {
  const lines = body.split(/\n/);
  if (lines.length > 1 && lines[0].trim().length > 0 && lines[0].trim().length <= 60) {
    return lines.slice(1).join("\n");
  }
  return body;
}

function findListMatches(body: string): string[] {
  const out: string[] = [];
  const afterGreeting = stripGreetingLine(body);
  const lines = afterGreeting.split(/\n/);

  // (a) bullet / numbered lines
  const bulletLines = lines.filter((l) => BULLET_LINE_RE.test(l));
  if (bulletLines.length >= 2) {
    out.push(`${bulletLines.length} bulleted/numbered lines, e.g. "${bulletLines[0].trim().slice(0, 60)}"`);
  }

  // (b) 3+ consecutive short lines without sentence-ending punctuation —
  // an enumeration written without bullet characters.
  let run = 0;
  for (const l of lines) {
    const t = l.trim();
    const shortItem = t.length > 0 && t.length <= 60 && !/[.!?。．！？…]$/.test(t);
    run = shortItem ? run + 1 : 0;
    if (run >= 3) {
      out.push(`3+ consecutive short unpunctuated lines (list-shaped block)`);
      break;
    }
  }

  // (c) comma enumeration blob: one sentence with 6+ separators and short
  // segments — "Unidas, Lojas Riachuelo, Sofisa, Ng.Cash, Vulcabras, Panvel".
  // CJK caveat: the fullwidth comma ，is the ordinary CLAUSE separator in
  // Chinese/Japanese prose (a normal sentence has many), so only the
  // dedicated enumeration comma 、counts there, with a tighter item length.
  for (const sentence of splitSentences(afterGreeting)) {
    const cjkEnum = sentence.split(/、/);
    if (cjkEnum.length >= 6) {
      const avg = cjkEnum.reduce((a, s) => a + s.trim().length, 0) / cjkEnum.length;
      if (avg > 0 && avg <= 12) {
        out.push(`ideographic-comma enumeration of ${cjkEnum.length} short items: "${sentence.trim().slice(0, 70)}..."`);
        break;
      }
    }
    // Split only on separator-followed-by-space: enumeration commas always
    // carry a trailing space, decimal commas ("5,45 USD") never do.
    const segments = sentence.split(/[,;；](?=\s)/);
    if (segments.length >= 7) {
      const avg = segments.reduce((a, s) => a + s.trim().length, 0) / segments.length;
      if (avg > 0 && avg <= 24) {
        out.push(`comma enumeration of ${segments.length} short items: "${sentence.trim().slice(0, 70)}..."`);
        break;
      }
    }
  }
  return out;
}

// ----------------------------------------------------------------------------
// S4 — SHOUTING: ALL-CAPS words beyond the curated acronym set, and
// punctuation runs. Latin-script only for the caps check by construction.
// ----------------------------------------------------------------------------
// Superset of doctrineLint's PERMITTED_ACRONYMS (kept local so the two lists
// can evolve independently; deliverability tolerates a few extra).
const CAPS_ALLOWLIST = new Set([
  "UA", "LTV", "ROAS", "CPI", "CPA", "CPM", "CPC", "CTR", "CVR",
  "CPS", "CPL", "CPO", "CPE", "CPV", "LLM",
  "FTD", "GMV", "CAC", "SVOD", "AVOD", "NGR", "GGR", "ARPPU", "COD",
  "MMP", "DSP", "SSP", "RTB", "PMP", "SDK", "IAP", "KPI", "KYC",
  "MAU", "DAU", "ARPU", "ARPDAU", "AOV", "ROI", "OEM", "API", "CRM",
  "B2B", "B2C", "D2C", "D7", "D30", "D90", "CTV", "RTG", "GEO", "GEOS",
  "USD", "EUR", "GBP", "JPY", "CNY", "INR", "THB", "MYR", "SGD", "BRL", "MXN", "ILS", "AED",
  "AI", "ML", "URL", "HTTP", "HTTPS", "JSON", "APP", "APPS",
  "Q1", "Q2", "Q3", "Q4", "YOY", "MOM", "QOQ", "CEO", "CMO", "CTO", "VP",
  "USA", "UK", "UAE", "EU", "APAC", "EMEA", "LATAM", "MENA", "SEA",
  "IOS", "GTA", "RPG", "MMO", "FPS", "F2P", "PVP", "PC", "TV", "OTT", "VOD",
]);

// Common words that read as SHOUTING when fully capitalized. Brand and org
// acronyms (ESPN, DGCCRF, BLIK, HDE, ...) are an unbounded set that must NOT
// flag — real spam shouting almost always capitalizes ordinary sales words.
const SHOUT_WORDS = new Set([
  "FREE", "NOW", "ACT", "NEW", "SALE", "OFFER", "DEAL", "BONUS", "CASH",
  "WIN", "WINNER", "LIMITED", "EXCLUSIVE", "HURRY", "URGENT", "IMPORTANT",
  "ATTENTION", "AMAZING", "GUARANTEED", "BEST", "HUGE", "SAVE", "TODAY",
  "LAST", "FINAL", "CHANCE", "CLICK", "BUY", "ORDER", "APPLY", "STOP",
]);

function findShoutingMatches(body: string, groundedSource: string): string[] {
  const out: string[] = [];
  const capsWords = (body.match(/\b[A-Z]{3,}\b/g) || []).filter(
    (w) => !CAPS_ALLOWLIST.has(w) && !isGrounded(w, groundedSource),
  );
  const distinct = Array.from(new Set(capsWords));
  const shouted = distinct.filter((w) => SHOUT_WORDS.has(w));
  // Flag when an ordinary word is shouted, or when caps density is extreme
  // (4+ distinct unknown caps tokens — even brand acronyms read spammy in
  // that concentration).
  if (shouted.length >= 1 || distinct.length >= 4) {
    out.push(`ALL-CAPS words: ${(shouted.length >= 1 ? shouted : distinct).slice(0, 5).join(", ")}`);
  }
  const punctRuns = body.match(/[!?]{2,}|\${2,}/g);
  if (punctRuns) {
    out.push(`punctuation runs: ${Array.from(new Set(punctRuns)).slice(0, 3).join(" ")}`);
  }
  // 3+ exclamation marks anywhere in the body (doctrine already bans them in
  // prompts; this is the deterministic deliverability backstop). Spanish
  // inverted ¡ counts as the same mark to avoid double-counting pairs.
  const bangs = (body.match(/!/g) || []).length;
  if (bangs >= 3) {
    out.push(`${bangs} exclamation marks in body`);
  }
  return out;
}

// ----------------------------------------------------------------------------
// S5 — MONEY-BAIT: a currency amount within 40 chars of a bait word.
// ----------------------------------------------------------------------------
function findMoneyBaitMatches(body: string, groundedSource: string): string[] {
  const out: string[] = [];
  // Direct adjacency only: "free $500 bonus", "win $1,000", "$500 bonus".
  // A loose proximity window false-positives on legitimate performance
  // vocabulary ("eCPA of $190, with bonus abuse blocked", "cost to win a
  // subscriber at $30") — bait requires the bait word touching the amount.
  const res = [
    /\b(?:free|win|earn|claim|guaranteed)\s+(?:an?\s+|up\s+to\s+)?[$€£₪₹]\s?\d[\d,.]*/gi,
    /[$€£₪₹]\s?\d[\d,.]*\s*(?:free|bonus|prize|gift|giveaway)\b/gi,
  ];
  for (const re of res) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
      if (!isGrounded(m[0], groundedSource)) {
        out.push(m[0].trim().slice(0, 70));
        return out;
      }
    }
  }
  return out;
}

// ----------------------------------------------------------------------------
// S6 — LINK HYGIENE: multiple URLs, shorteners, bare-IP URLs.
// ----------------------------------------------------------------------------
const SHORTENER_HOSTS = [
  "bit.ly", "tinyurl.com", "goo.gl", "t.co", "ow.ly", "is.gd", "buff.ly",
  "cutt.ly", "rebrand.ly", "tiny.cc", "rb.gy", "shorturl.at", "lnkd.in",
];

function findLinkMatches(body: string): string[] {
  const out: string[] = [];
  const urls = body.match(/https?:\/\/[^\s)>\]]+|(?<![\w@.])www\.[^\s)>\]]+/gi) || [];
  if (urls.length >= 2) {
    out.push(`${urls.length} URLs in body (max 1)`);
  }
  for (const u of urls) {
    const lower = u.toLowerCase();
    if (SHORTENER_HOSTS.some((h) => lower.includes(`//${h}/`) || lower.includes(`.${h}/`) || lower.startsWith(`www.${h}`) || lower.includes(`//${h}`))) {
      out.push(`URL shortener: ${u.slice(0, 50)}`);
      break;
    }
  }
  if (urls.some((u) => /https?:\/\/\d{1,3}(?:\.\d{1,3}){3}/.test(u))) {
    out.push("bare IP-address URL");
  }
  return out;
}

// ----------------------------------------------------------------------------
// S7 — SUBJECT: trigger words, shouting, emoji, exclamation, fake FW:.
// ----------------------------------------------------------------------------
function findSubjectMatches(subject: string, groundedSource: string): string[] {
  const out: string[] = [];
  if (!subject || !subject.trim()) return out;
  // Threaded-reply inheritance: every follow-up replies with "Re: <original
  // subject>". If the subject minus its reply prefix appears in the original
  // outreach, the writer INHERITED it (emoji, caps, wording and all) — the
  // content checks below only apply to subjects the writer invented. A
  // forward prefix is still checked (a reply must never fake "FW:").
  const withoutRe = subject.replace(/^\s*(?:re|aw|sv|vs|odp)\s*:\s*/i, "").trim();
  const inherited = withoutRe.length > 0 && isGrounded(withoutRe, groundedSource);
  if (inherited) {
    if (/^\s*(?:fwd?|wg|tr)\s*:/i.test(subject)) {
      out.push("forward-prefix subject on a reply");
    }
    return out;
  }
  const triggers = findTriggerMatches(subject, groundedSource);
  if (triggers.length > 0) {
    out.push(`trigger word in subject: ${triggers.join("; ")}`);
  }
  const stripped = subject.replace(/^\s*(?:re|aw|sv|vs|odp)\s*:\s*/i, "");
  const letters = stripped.match(/\p{L}/gu) || [];
  const uppers = stripped.match(/\p{Lu}/gu) || [];
  if (letters.length >= 8 && uppers.length / letters.length >= 0.6) {
    out.push(`subject is mostly ALL-CAPS: "${subject.slice(0, 50)}"`);
  }
  if (/!/.test(subject)) {
    out.push("exclamation mark in subject");
  }
  if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u.test(subject)) {
    out.push("emoji in subject");
  }
  if (/^\s*(?:fwd?|wg|tr)\s*:/i.test(subject)) {
    out.push("forward-prefix subject on a reply");
  }
  return out;
}

// ----------------------------------------------------------------------------
// Public API
// ----------------------------------------------------------------------------
export interface SpamRiskOpts {
  languageTag: string;
  /** Subject line of the draft (checked by S7 when provided). */
  subject?: string;
  /** Concatenated original outreach (subject + body + summary) — grounding
   *  source for the trigger/caps/money exemptions. */
  originalText?: string;
}

interface RuleHit {
  rule: string;
  weight: number;
  matches: string[];
  issue: string;
  suggestion: string;
}

function runRules(body: string, opts: SpamRiskOpts): RuleHit[] {
  const lang = langBase(opts.languageTag);
  const grounded = normalizeGround(opts.originalText || "");
  const hits: RuleHit[] = [];

  if (envFlag("SPAM_CHECK_FOLLOWUP_COUNT", true)) {
    const m = findFollowupCountMatches(body, lang);
    if (m.length > 0) {
      hits.push({
        rule: "FOLLOWUP-COUNT",
        weight: 3,
        matches: m,
        issue:
          `SPAM-FOLLOWUP-COUNT - the draft states how many times the prospect has been contacted ` +
          `("${m[0].slice(0, 60)}"). Repeated-contact counts are a classic mass-outreach spam signal ` +
          `(2026-07-23 deliverability incident) and read as a guilt-trip. Reference the previous email ` +
          `naturally WITHOUT counting attempts.`,
        suggestion:
          'Acknowledge prior outreach without a count: "Following up on my note about [topic]" — ' +
          'never "I have reached out N times" / "my third email" / "after 4 attempts".',
      });
    }
  }

  if (envFlag("SPAM_CHECK_TRIGGERS", true)) {
    const m = findTriggerMatches(body, grounded);
    if (m.length > 0) {
      hits.push({
        rule: "SPAM-TRIGGER",
        weight: 2 * Math.min(m.length, 3),
        matches: m,
        issue:
          `SPAM-TRIGGER - the draft contains spam-filter trigger vocabulary not present in the ` +
          `original outreach: ${m.slice(0, 4).join("; ")}. Financial-bait, urgency-bait, and ` +
          `click-bait phrasing gets follow-ups routed to the spam folder.`,
        suggestion:
          "Remove or rephrase each trigger phrase. If the concept is genuinely the prospect's " +
          "business (it appeared in the original email), name it exactly as the original did; " +
          "otherwise drop it and make the point with neutral, concrete language.",
      });
    }
  }

  if (envFlag("SPAM_CHECK_LISTS", true)) {
    const m = findListMatches(body);
    if (m.length > 0) {
      hits.push({
        rule: "LIST-FORMAT",
        weight: 3,
        matches: m,
        issue:
          `SPAM-LIST-FORMAT - the draft is list-shaped (${m[0]}). Dry lists of names or bullets ` +
          `read as mass spam to content filters (2026-07-23 incident) and violate the 4-6 sentence ` +
          `prose doctrine.`,
        suggestion:
          "Rewrite as natural prose. Weave at most 2-3 named examples into a sentence with " +
          "context, instead of enumerating. Cut the rest.",
      });
    }
  }

  if (envFlag("SPAM_CHECK_SHOUTING", true)) {
    const m = findShoutingMatches(body, grounded);
    if (m.length > 0) {
      hits.push({
        rule: "SHOUTING",
        weight: m.length,
        matches: m,
        issue:
          `SPAM-SHOUTING - the draft shouts: ${m.join("; ")}. ALL-CAPS words and stacked ` +
          `punctuation are strong spam-filter signals.`,
        suggestion:
          "Use sentence case everywhere except curated acronyms (CPI, ROAS, ...). Remove " +
          "doubled punctuation and exclamation marks.",
      });
    }
  }

  if (envFlag("SPAM_CHECK_MONEY", true)) {
    const m = findMoneyBaitMatches(body, grounded);
    if (m.length > 0) {
      hits.push({
        rule: "MONEY-BAIT",
        weight: 2,
        matches: m,
        issue:
          `SPAM-MONEY-BAIT - a currency amount sits next to bait vocabulary ("${m[0]}"). ` +
          `Money-plus-free/bonus/win phrasing is core spam-filter lexicon.`,
        suggestion:
          "Separate the number from the bait word, or drop the bait word entirely. State " +
          "figures factually, only if they come from the original email.",
      });
    }
  }

  if (envFlag("SPAM_CHECK_LINKS", true)) {
    const m = findLinkMatches(body);
    if (m.length > 0) {
      hits.push({
        rule: "LINK-HYGIENE",
        weight: 2,
        matches: m,
        issue:
          `SPAM-LINK-HYGIENE - ${m.join("; ")}. Multiple URLs, shortened URLs, and IP-address ` +
          `URLs are high-weight spam-filter features.`,
        suggestion:
          "Keep at most one full-domain URL, and only if the original email already used it. " +
          "Never use URL shorteners in B2B follow-ups.",
      });
    }
  }

  if (envFlag("SPAM_CHECK_SUBJECT", true) && opts.subject) {
    const m = findSubjectMatches(opts.subject, grounded);
    if (m.length > 0) {
      hits.push({
        rule: "SUBJECT",
        weight: 2,
        matches: m,
        issue:
          `SPAM-SUBJECT - the subject line carries spam signals: ${m.join("; ")}. The subject ` +
          `must stay a plain "Re:" variant of the original subject.`,
        suggestion:
          'Use "Re: [original subject]" or a short neutral variant: no trigger words, no ' +
          "exclamation marks, no emoji, no ALL-CAPS.",
      });
    }
  }

  return hits;
}

/**
 * Generator-gate detector. ViolationReport-shaped so callers merge it with
 * doctrineLint/structuralLint reports via mergeViolationReports.
 */
export function detectSpamRiskViolations(body: string, opts: SpamRiskOpts): ViolationReport {
  if (!envFlag("SPAM_LINT_ENABLED", true)) return EMPTY;
  if (!body || !body.trim()) return EMPTY;
  const hits = runRules(body, opts);
  if (hits.length === 0) return EMPTY;
  return {
    found: true,
    issues: hits.map((h) => h.issue),
    suggestions: hits.map((h) => h.suggestion),
    matches: hits.flatMap((h) => h.matches).slice(0, 10),
  };
}

// ----------------------------------------------------------------------------
// Send-time gate
// ----------------------------------------------------------------------------
export type SpamGateMode = "block" | "warn";

export interface SpamRiskAssessment {
  /** Weighted risk score across all matched rules. */
  score: number;
  /** True when the email should not ship as-is (score >= 3: any single
   *  incident-class rule, or two lesser signals stacked). */
  highRisk: boolean;
  /** Rule names that fired. */
  rules: string[];
  /** Human-readable issue lines for logs / approval UI. */
  issues: string[];
}

export function assessSpamRisk(
  subject: string,
  body: string,
  languageTag: string,
  originalText?: string,
): SpamRiskAssessment {
  if (!envFlag("SPAM_LINT_ENABLED", true)) {
    return { score: 0, highRisk: false, rules: [], issues: [] };
  }
  const hits = runRules(body || "", { languageTag, subject, originalText });
  const score = hits.reduce((a, h) => a + h.weight, 0);
  return {
    score,
    highRisk: score >= 3,
    rules: hits.map((h) => h.rule),
    issues: hits.map((h) => h.issue),
  };
}

export function spamGateEnabled(): boolean {
  return envFlag("SPAM_GATE_ENABLED", true);
}

export function spamGateMode(): SpamGateMode {
  const v = (process.env.SPAM_GATE_MODE || "").toLowerCase();
  return v === "warn" ? "warn" : "block";
}
