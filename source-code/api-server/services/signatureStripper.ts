/**
 * signatureStripper.ts — Batch B8a (sign-off & signature line removal)
 *
 * Deterministic safety net that strips any closing line ("Best regards",
 * "Saludos", "С уважением", "敬具", "בברכה", and many others across 18+
 * languages) and the immediately-following sender-name line from a
 * follow-up email body before it is sent.
 *
 * Why this exists
 * ───────────────
 * The Doctrine and Context writer/critic/rewriter prompts now explicitly
 * forbid the model from producing a closing or signature line, because
 * the recipient's email client appends the user's signature automatically.
 * The prompts and critic are stochastic. This stripper is the
 * belt-and-suspenders deterministic layer: even if the model drifts and
 * emits "Best regards,\nMichael" at the bottom, this function strips
 * those two lines before delivery so the recipient never sees a
 * duplicated sign-off.
 *
 * Design constraints
 * ──────────────────
 *   - LINE-LEVEL only. A closing phrase appearing inline ("thanks again
 *     for the call") must NOT be touched. Only full lines whose normalised
 *     content matches an entry in CLOSING_PHRASES.
 *   - Name removal is CONDITIONAL — only triggered immediately after a
 *     closing line has been stripped. Bare orphan name lines without a
 *     preceding closing are left alone (they are rare in practice and
 *     stripping them risks false positives on short final CTAs).
 *   - Conservative on punctuation. A line ending in . ! or ? is treated
 *     as a real sentence and NEVER stripped as a name.
 *   - Multi-pass. If the model produced two closings in a row
 *     ("Thanks,\nBest regards,\nMichael") all of them are removed in one
 *     call.
 *   - Idempotent. Running stripClosingFromBody twice in succession yields
 *     the same result as running it once.
 *
 * The phrase list is curated for the ~18 languages MobUpps currently
 * sends in. New languages can be added freely; only the listed phrases
 * trigger stripping.
 */

// Canonicalised, lowercased closing phrases. Punctuation, exclamation,
// and surrounding whitespace are stripped before lookup, so the table
// entries are bare phrase forms.
//
// Ordering note: longer phrases (e.g. "kind regards") MUST come before
// their substrings (e.g. "regards") in the lookup, but since this is a
// Set-based exact match, ordering is irrelevant. The normalisation step
// makes the lookup safe.
const CLOSING_PHRASES: ReadonlySet<string> = new Set([
  // ── English ───────────────────────────────────────────────────────
  "best regards",
  "best",
  "kind regards",
  "warm regards",
  "warmest regards",
  "regards",
  "sincerely",
  "yours sincerely",
  "yours truly",
  "yours faithfully",
  "thanks",
  "thank you",
  "many thanks",
  "thanks again",
  "cheers",
  "talk soon",
  "speak soon",
  "looking forward",
  "all the best",
  "take care",
  "have a great day",
  "have a good day",
  // ── Spanish (LatAm + ES) ──────────────────────────────────────────
  "saludos",
  "saludos cordiales",
  "un saludo",
  "cordialmente",
  "atentamente",
  "atte",
  "muchas gracias",
  "un abrazo",
  // ── Portuguese (BR + PT) ──────────────────────────────────────────
  "atenciosamente",
  "cumprimentos",
  "abracos",
  "abraco",
  "um abraco",
  "saudacoes",
  "obrigado",
  "obrigada",
  // ── French ────────────────────────────────────────────────────────
  "cordialement",
  "bien cordialement",
  "bien a vous",
  "salutations",
  "salutations distinguees",
  "amicalement",
  "merci",
  "merci beaucoup",
  // ── German ────────────────────────────────────────────────────────
  "mit freundlichen grüßen",
  "mit freundlichen grussen",
  "mit freundlichen gruessen",
  "viele grüße",
  "viele grusse",
  "viele gruesse",
  "beste grüße",
  "beste grusse",
  "beste gruesse",
  "freundliche grüße",
  "freundliche grusse",
  "freundliche gruesse",
  "grüße",
  "gruß",
  "gruss",
  "mfg",
  "lg",
  "danke",
  "vielen dank",
  // ── Italian ───────────────────────────────────────────────────────
  "cordiali saluti",
  "distinti saluti",
  "saluti",
  "un saluto",
  "grazie",
  "grazie mille",
  // ── Dutch ─────────────────────────────────────────────────────────
  "met vriendelijke groet",
  "vriendelijke groeten",
  "groet",
  "groeten",
  "bedankt",
  // ── Russian ───────────────────────────────────────────────────────
  "с уважением",
  "всего доброго",
  "с наилучшими пожеланиями",
  "с наилучшими",
  "спасибо",
  // ── Ukrainian ─────────────────────────────────────────────────────
  "з повагою",
  "з найкращими побажаннями",
  "дякую",
  // ── Polish ────────────────────────────────────────────────────────
  "pozdrawiam",
  "pozdrawiam serdecznie",
  "z powazaniem",
  "z poważaniem",
  "dziekuje",
  "dziękuję",
  // ── Czech / Slovak ────────────────────────────────────────────────
  "s pozdravem",
  "zdravim",
  "zdravím",
  "dekuji",
  "děkuji",
  // ── Turkish ───────────────────────────────────────────────────────
  "saygilarimla",
  "saygılarımla",
  "iyi calismalar",
  "iyi çalışmalar",
  "tesekkurler",
  "teşekkürler",
  // ── Japanese ──────────────────────────────────────────────────────
  "敬具",
  "よろしくお願いいたします",
  "よろしくお願いします",
  "宜しくお願い致します",
  "宜しくお願いします",
  "ありがとうございます",
  "ありがとうございました",
  // ── Chinese (Simplified + Traditional) ────────────────────────────
  "此致",
  "敬礼",
  "顺颂商祺",
  "祝好",
  "祝商祺",
  "谢谢",
  "謝謝",
  // ── Korean ────────────────────────────────────────────────────────
  "감사합니다",
  "감사드립니다",
  "안녕히 계세요",
  "잘 부탁드립니다",
  "잘 부탁 드립니다",
  // ── Arabic ────────────────────────────────────────────────────────
  "مع تحياتي",
  "تحياتي",
  "بإحترام",
  "باحترام",
  "مع خالص التحية",
  "تفضلوا بقبول فائق الاحترام",
  "شكرا",
  "شكرًا",
  // ── Hebrew ────────────────────────────────────────────────────────
  "בברכה",
  "בכבוד רב",
  "תודה",
  "תודה רבה",
  "כל טוב",
  // ── Hindi ─────────────────────────────────────────────────────────
  "सादर",
  "धन्यवाद",
  "सधन्यवाद",
  // ── Thai ──────────────────────────────────────────────────────────
  "ขอแสดงความนับถือ",
  "ด้วยความเคารพ",
  "ขอบคุณ",
  "ขอบคุณครับ",
  "ขอบคุณค่ะ",
  // ── Vietnamese ────────────────────────────────────────────────────
  "trân trọng",
  "tran trong",
  "kính chào",
  "kinh chao",
  "thân ái",
  "than ai",
  "cảm ơn",
  "cam on",
]);

// Maximum permissible width (in characters) of a candidate name-line.
// Real names with titles, full-name + last-name, parenthetical middle
// names ("Michael (Adam) Goder") fit comfortably under 40 chars. Longer
// trailing lines are very likely real content (a final CTA sentence, a
// thank-you note) so we never treat them as names.
const NAME_LINE_MAX_CHARS = 40;

// Maximum permissible token-count for a candidate name-line. We split on
// whitespace; CJK scripts that lack spaces will always have token-count
// 1 which is safely under this cap. Latin-script names of 1-4 tokens
// are common ("Michael", "Michael Goder", "Michael Adam Goder", "Dr.
// Michael Goder"). 5+ tokens is almost certainly a real sentence.
const NAME_LINE_MAX_TOKENS = 4;

// Punctuation stripped from the END of a line before comparing against
// CLOSING_PHRASES. Includes Latin (, . ; : ! ?), CJK (、 。 ， ． ！ ？),
// Arabic (، ؟), Devanagari (। ॥), Hebrew punctuation, and dashes/ellipsis.
const TRAILING_PUNCTUATION = /[\s,.;:!?\u3001\u3002\uFF0C\uFF0E\uFF01\uFF1F\u060C\u061F\u05BE\u05F3\u05F4\u0964\u0965\u2013\u2014\u2026\-]+$/;

// Sentence-terminating punctuation across writing systems. A line that
// ends with any of these is a real sentence and must NEVER be treated
// as a name signature. Latin (. ! ?), CJK fullwidth (。 ． ！ ？),
// Arabic (؟), Devanagari (। ॥).
const SENTENCE_TERMINATOR_AT_END = /[.!?\u3002\uFF0E\uFF01\uFF1F\u061F\u0964\u0965]$/;

/**
 * Normalise a single line for closing-phrase matching.
 *
 * Steps:
 *   1. Trim outer whitespace.
 *   2. Strip trailing punctuation (commas, periods, exclamation, etc.)
 *      since model output varies on "Best regards," vs "Best regards"
 *      vs "Best regards!".
 *   3. Collapse internal whitespace runs to single spaces.
 *   4. Lowercase.
 *
 * Returns an empty string for whitespace-only inputs so callers can
 * treat blank lines uniformly.
 */
function normaliseLineForClosingMatch(line: string): string {
  let result = line.trim();
  if (!result) return "";
  result = result.replace(TRAILING_PUNCTUATION, "");
  result = result.replace(/\s+/g, " ");
  result = result.toLowerCase();
  return result;
}

/**
 * Does a trimmed line look like a sender-name signature line?
 *
 * Rules:
 *   - Non-empty after trim.
 *   - No sentence-terminating punctuation (. ! ? 。 ！ ？ ؟ । ॥).
 *     A line that ends in a real sentence is content, not a name.
 *   - Character length under NAME_LINE_MAX_CHARS.
 *   - Token count (whitespace-split) under NAME_LINE_MAX_TOKENS.
 *
 * Conservative on purpose. False negatives (missing a name) are
 * tolerable — the prompts + critic catch them. False positives
 * (stripping real content) are NOT tolerable.
 */
function looksLikeNameLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (SENTENCE_TERMINATOR_AT_END.test(trimmed)) return false;
  if (trimmed.length > NAME_LINE_MAX_CHARS) return false;
  const tokens = trimmed.split(/\s+/);
  if (tokens.length > NAME_LINE_MAX_TOKENS) return false;
  return true;
}

/**
 * Strip closing lines and the immediately-following sender-name line
 * from the end of an email body.
 *
 * Algorithm:
 *   1. Pop trailing whitespace-only lines.
 *   2. Loop, each iteration trying to remove ONE "trailing unit":
 *
 *      CASE A — the last line is itself a known closing phrase
 *      ("Best regards,"). Pop it.
 *
 *      CASE B — the last line looks like a sender name AND the line
 *      above it (skipping blank lines) is a known closing phrase. Pop
 *      both lines (and any blanks between them).
 *
 *      Otherwise — stop.
 *
 *   3. Pop trailing whitespace once more after all unit removals.
 *
 * The two-case loop handles the "Best regards,\nMichael" common case
 * (CASE B catches the name + closing as a unit) AND the bare orphan
 * closing case (CASE A pops a closing with no name below). Stacked
 * closings ("Thanks,\nBest regards,\nMichael") iterate naturally —
 * each pass removes one unit until the body is reached.
 *
 * A closing line sitting IN THE MIDDLE of the body — e.g. followed by
 * a real period-ending sentence — is left untouched because neither
 * case applies (the sentence below is not a name, so CASE B fails;
 * the closing is not the last line, so CASE A fails). This is by
 * design: the stripper acts on trailing closings only, never on
 * middle-of-body artefacts.
 */
export function stripClosingFromBody(body: string): string {
  if (!body) return body;

  const usesCrlf = body.includes("\r\n");
  const normalisedInput = usesCrlf ? body.replace(/\r\n/g, "\n") : body;
  const lines = normalisedInput.split("\n");

  const popTrailingBlanks = (): void => {
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
      lines.pop();
    }
  };

  /**
   * Attempt to remove one trailing "unit" (a bare closing line, or a
   * name+closing pair). Returns true if any lines were removed so the
   * outer loop can iterate.
   */
  const stripOneUnit = (): boolean => {
    popTrailingBlanks();
    if (lines.length === 0) return false;

    const lastLine = lines[lines.length - 1];
    const lastNorm = normaliseLineForClosingMatch(lastLine);

    // CASE A: the last line is itself a known closing.
    if (lastNorm && CLOSING_PHRASES.has(lastNorm)) {
      lines.pop();
      return true;
    }

    // CASE B: the last line looks like a sender name AND the
    // line above (skipping blank lines) is a known closing.
    if (looksLikeNameLine(lastLine)) {
      let aboveIdx = lines.length - 2;
      while (aboveIdx >= 0 && lines[aboveIdx].trim() === "") {
        aboveIdx--;
      }
      if (aboveIdx >= 0) {
        const aboveNorm = normaliseLineForClosingMatch(lines[aboveIdx]);
        if (aboveNorm && CLOSING_PHRASES.has(aboveNorm)) {
          // Truncate at aboveIdx, removing the closing, any
          // intermediate blanks, and the name line in one shot.
          lines.length = aboveIdx;
          return true;
        }
      }
    }

    return false;
  };

  // Iterate until no more units can be stripped. Each iteration is
  // bounded by the line count, so the loop is guaranteed to terminate.
  // We cap iterations as a defensive measure in case of a logic bug.
  const maxIterations = lines.length + 1;
  let iter = 0;
  while (stripOneUnit()) {
    iter++;
    if (iter > maxIterations) break;
  }

  popTrailingBlanks();

  const joined = lines.join("\n");
  return usesCrlf ? joined.replace(/\n/g, "\r\n") : joined;
}

/**
 * Test-only export of the canonical phrase set, exposed so unit tests
 * can verify the table without re-declaring it. Treat as read-only.
 */
export const CLOSING_PHRASES_FOR_TESTING: ReadonlySet<string> = CLOSING_PHRASES;
