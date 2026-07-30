/**
 * replyClassification.ts — Company-Reply Cascade, pure layer.
 *
 * Deterministic, dependency-free helpers that decide reply intent and the
 * company-grouping key. No database, no network, no LLM — so the whole
 * module is unit-testable in isolation (see tests/test-reply-classification.ts).
 *
 * The cascade pauses OTHER recent campaigns at the same company once one
 * contact replies POSITIVELY. Getting the grouping key and the
 * out-of-office / unsubscribe gates right here is what bounds the blast
 * radius. The LLM (services/replySentiment.ts) only ever decides
 * positive-vs-negative on a genuine human reply; everything that can be
 * decided cheaply and deterministically is decided here.
 *
 * Tuning knobs live at the top of this file as named constants. Changing
 * the window or the confidence floor is a one-line edit, version-controlled.
 */

// ──────────────────────────────────────────────────────────────────────
// Tuning knobs (single source of truth)
// ──────────────────────────────────────────────────────────────────────

/**
 * "Recent / same timeframe" window. A sibling campaign is only paused if it
 * was sent within this many days (either side) of the replier's outreach.
 * Wider = more siblings paused = larger blast radius. 14 days covers a
 * typical multi-contact prospecting burst without reaching back into an
 * unrelated campaign run weeks earlier.
 */
export const COMPANY_CASCADE_WINDOW_DAYS = 14;

/**
 * Minimum classifier confidence required to act on a "positive" verdict.
 * Below this the reply is treated as a normal reply (replier paused, NO
 * cascade). Raising this makes the cascade fire less often but more safely.
 */
export const CASCADE_MIN_CONFIDENCE = 0.6;

/**
 * Which products' campaigns the cascade is allowed to pause. Cold-outreach
 * flows only. anti_ghosting is a deliberate, operator-marked re-engagement
 * of a specific known contact and must never be auto-paused because a
 * different colleague replied.
 */
export const CASCADE_ELIGIBLE_APPS = ["doctrine", "context"] as const;

/**
 * The reply classes the system recognises.
 *   positive    — genuine interest / willingness to engage. Triggers cascade.
 *   negative    — rejection, irrelevance, dismissive brush-off. No cascade.
 *   ooo         — out-of-office / vacation auto-reply. Ignored entirely.
 *   unsubscribe — opt-out / do-not-contact request. Replier suppressed, no cascade.
 *   unknown     — classifier failed/parse error. Conservative: no cascade.
 */
export type ReplyClass =
  | "positive"
  | "negative"
  | "ooo"
  | "unsubscribe"
  | "unknown";

// ──────────────────────────────────────────────────────────────────────
// Company grouping key
// ──────────────────────────────────────────────────────────────────────

/**
 * Consumer webmail providers. An address on one of these has no inferable
 * employer, so it must NEVER be used to group "colleagues at the same
 * company" — otherwise one reply from a gmail.com address would pause every
 * unrelated gmail.com campaign. Mirrors the list in gmailSync.inferCompany;
 * kept independent here so this destructive-path guard owns its own copy.
 */
export const FREE_EMAIL_DOMAINS = new Set<string>([
  "gmail.com", "googlemail.com",
  "yahoo.com", "yahoo.co.uk", "yahoo.co.in", "yahoo.co.jp", "yahoo.fr",
  "yahoo.de", "yahoo.es", "yahoo.it", "ymail.com", "rocketmail.com",
  "outlook.com", "outlook.co.uk", "hotmail.com", "hotmail.co.uk",
  "hotmail.fr", "hotmail.de", "hotmail.it", "live.com", "msn.com",
  "icloud.com", "me.com", "mac.com",
  "aol.com", "aim.com",
  "proton.me", "protonmail.com", "pm.me",
  "yandex.com", "yandex.ru",
  "mail.com", "mail.ru", "inbox.ru", "list.ru", "bk.ru",
  "gmx.com", "gmx.de", "gmx.net", "gmx.at", "gmx.ch",
  "web.de", "t-online.de", "freenet.de",
  "fastmail.com", "fastmail.fm", "zoho.com",
  "qq.com", "163.com", "126.com", "sina.com", "sina.cn", "sohu.com",
  "naver.com", "daum.net", "hanmail.net", "kakao.com",
  "rediffmail.com",
  "walla.co.il", "walla.com",
]);

/**
 * Extract the company-grouping key from an email address or a From header.
 *
 * Returns the exact, lowercased host after the @ (e.g. "pizzahut.com").
 * Returns "" when:
 *   - there is no parseable address / domain, or
 *   - the domain is a free webmail provider (no employer to group on).
 *
 * Exact-host matching is intentional: it is the conservative choice. Two
 * brand colleagues on uk.pizzahut.com and pizzahut.com will NOT be grouped,
 * which can miss a sibling — but it can never WRONGLY pause a stranger who
 * merely shares a registrable suffix. Recall is traded for precision on
 * purpose; the cost of a missed pause (one extra follow-up) is far smaller
 * than the cost of a wrong pause (a killed live campaign).
 */
export function extractEmailDomain(input: string): string {
  if (!input) return "";
  // Pull an address out of a possible "Name <addr@host>" header form.
  const angle = input.match(/<([^>]+)>/);
  const candidate = (angle ? angle[1] : input).trim().toLowerCase();
  const at = candidate.lastIndexOf("@");
  if (at < 0) return "";
  // Take everything after the last '@', strip any trailing punctuation.
  const host = candidate
    .slice(at + 1)
    .replace(/[>,;:\s].*$/, "")
    .replace(/\.+$/, "")
    .trim();
  if (!host || !host.includes(".")) return "";
  if (FREE_EMAIL_DOMAINS.has(host)) return "";
  return host;
}

// ──────────────────────────────────────────────────────────────────────
// Out-of-office detection
// ──────────────────────────────────────────────────────────────────────

/**
 * Auto-reply header signals. Gmail surfaces these on most mailbox
 * vacation responders and on enterprise OOO systems. Passed in as a
 * lowercased record by the caller (classifyThreadInbound).
 */
export interface AutoReplyHeaders {
  autoSubmitted?: string;   // RFC 3834 "Auto-Submitted: auto-replied"
  xAutoreply?: string;      // "X-Autoreply: yes"
  xAutorespond?: string;    // present on some responders
  precedence?: string;      // "auto_reply"
}

function headerSignalsOoo(h?: AutoReplyHeaders): boolean {
  if (!h) return false;
  const auto = (h.autoSubmitted || "").toLowerCase();
  if (auto.includes("auto-replied") || auto.includes("auto-generated")) return true;
  if ((h.xAutoreply || "").toLowerCase().trim() === "yes") return true;
  if ((h.xAutorespond || "").trim().length > 0) return true;
  if ((h.precedence || "").toLowerCase().includes("auto_reply")) return true;
  return false;
}

/**
 * Out-of-office / vacation phrases across the languages MobUpps emails in.
 * Heuristic by design: a regex miss falls through to the LLM, which is also
 * asked to flag OOO, so a missed phrase costs at most one classifier call,
 * never a wrong cascade. Patterns are matched case-insensitively against the
 * subject and the message snippet/body.
 */
const OOO_PATTERNS: RegExp[] = [
  // English
  /\bout of (the )?office\b/i,
  /\bauto(?:matic)?[- ]?reply\b/i,
  /\bautomatic response\b/i,
  /\bon (?:annual |paternity |maternity |sick )?leave\b/i,
  /\bon vacation\b/i,
  /\bon holiday\b/i,
  /\b(currently|presently) (away|unavailable|out)\b/i,
  /\baway from (?:my|the) (?:desk|office|email)\b/i,
  /\bi am (?:currently )?out\b/i,
  /\bwill be back (?:in|on|after)\b/i,
  /\breturning (?:to (?:the )?office )?on\b/i,
  /\bback in the office on\b/i,
  /\blimited access to (?:my )?email\b/i,
  // German
  /\babwesenheit(?:snotiz)?\b/i,
  /\bnicht im b(?:ü|ue)ro\b/i,
  /\bim urlaub\b/i,
  // French
  /\br(?:é|e)ponse automatique\b/i,
  /\babsence du bureau\b/i,
  /\bje suis absent\b/i,
  /\ben cong(?:é|e)\b/i,
  // Spanish / Portuguese
  /\brespuesta autom(?:á|a)tica\b/i,
  /\bfuera de (?:la )?oficina\b/i,
  /\bde vacaciones\b/i,
  /\bresposta autom(?:á|a)tica\b/i,
  /\bde f(?:é|e)rias\b/i,
  /\bausente do escrit(?:ó|o)rio\b/i,
  // Italian
  /\brisposta automatica\b/i,
  /\bfuori sede\b/i,
  /\bin ferie\b/i,
  // Russian
  /автоответ/i,
  /в отпуске/i,
  /не на рабочем месте/i,
  // Hebrew
  /חופשה/,
  /מחוץ למשרד/,
  // CJK
  /自動返信/,         // ja: automatic reply
  /不在/,             // ja/zh: absent
  /自动回复/,         // zh: automatic reply
  /부재중/,           // ko: out of office
  /휴가/,             // ko: vacation
];

/**
 * Decide whether an inbound message is an out-of-office / auto-reply.
 * Combines header signals with a multilingual phrase scan over the subject
 * and the snippet/body text.
 */
export function isOutOfOffice(
  subject: string,
  bodyOrSnippet: string,
  headers?: AutoReplyHeaders,
): boolean {
  if (headerSignalsOoo(headers)) return true;
  const haystack = `${subject || ""}\n${bodyOrSnippet || ""}`;
  return OOO_PATTERNS.some((re) => re.test(haystack));
}

// ──────────────────────────────────────────────────────────────────────
// Unsubscribe / opt-out detection
// ──────────────────────────────────────────────────────────────────────

const UNSUBSCRIBE_PATTERNS: RegExp[] = [
  /\bunsubscribe\b/i,
  /\bopt[- ]?out\b/i,
  /\bremove me\b/i,
  /\btake me off\b/i,
  /\bstop (?:emailing|contacting|sending)\b/i,
  /\bdo not (?:contact|email|write)\b/i,
  /\bdon'?t (?:contact|email) me\b/i,
  /\bno (?:longer|more) (?:emails|messages)\b/i,
  // Other languages (high-signal phrases only)
  /\bse d(?:é|e)sabonner\b/i,           // fr
  /\bne plus me contacter\b/i,          // fr
  /\bdarse de baja\b/i,                  // es
  /\bno me contacten\b/i,                // es
  /\babmelden\b/i,                       // de
  /\bnicht mehr kontaktieren\b/i,        // de
  /отписаться/i,                         // ru
  /не писать(?: мне)?\b/i,               // ru
  /הסר אותי/,                            // he
];

/**
 * Decide whether a reply is an explicit opt-out / do-not-contact request.
 * Matched against the message body (and subject if folded in by the caller).
 */
export function isUnsubscribe(text: string): boolean {
  if (!text) return false;
  return UNSUBSCRIBE_PATTERNS.some((re) => re.test(text));
}

// ──────────────────────────────────────────────────────────────────────
// Window helper
// ──────────────────────────────────────────────────────────────────────

/**
 * True when |a - b| <= days. Used to decide whether a sibling campaign was
 * sent "around the same timeframe" as the reply that triggered the cascade.
 */
export function isWithinDays(a: Date, b: Date, days: number): boolean {
  const ms = Math.abs(a.getTime() - b.getTime());
  return ms <= days * 24 * 60 * 60 * 1000;
}

/**
 * Inclusive [lower, upper] date bounds of +/- `days` around an anchor.
 * Returned for use as a SQL BETWEEN filter on prospects.sent_at.
 */
export function windowBounds(anchor: Date, days: number): { lower: Date; upper: Date } {
  const span = days * 24 * 60 * 60 * 1000;
  return {
    lower: new Date(anchor.getTime() - span),
    upper: new Date(anchor.getTime() + span),
  };
}
