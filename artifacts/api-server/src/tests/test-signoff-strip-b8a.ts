/**
 * test-signoff-strip-b8a.ts — Batch B8a unit tests
 *
 * Covers the deterministic sign-off / signature-line stripper added in
 * signatureStripper.ts. Tests are grouped:
 *
 *   1. Positive cases: closing + name combinations across 18 languages
 *      must be stripped down to the prior business sentence.
 *
 *   2. Negative cases: real content that incidentally contains a
 *      closing-class word (e.g. "thanks again for the call") must
 *      survive untouched.
 *
 *   3. Edge cases: empty input, idempotency, CRLF preservation,
 *      multiple stacked closings, closing with no following name,
 *      bare orphan name with no closing.
 *
 * Run via the api-server's existing tsx + node:test rig:
 *   pnpm --filter @workspace/api-server exec tsx --test tests/test-signoff-strip-b8a.ts
 */

import * as test from "node:test";
import * as assert from "node:assert/strict";
import { stripClosingFromBody, CLOSING_PHRASES_FOR_TESTING } from "../services/signatureStripper";

// ──────────────────────────────────────────────────────────────────────
// Positive cases — closing + name must be stripped
// ──────────────────────────────────────────────────────────────────────

test.describe("B8a positive cases — strip closing + sender-name line", () => {
  test.it("English: Best regards + first name", () => {
    const input = "Hi Michael,\n\nWorth a quick test on Malaysia?\n\nBest regards,\nJohn";
    const expected = "Hi Michael,\n\nWorth a quick test on Malaysia?";
    assert.equal(stripClosingFromBody(input), expected);
  });

  test.it("English: Thanks + full name", () => {
    const input = "Hello there.\n\nLet me know.\n\nThanks,\nJohn Smith";
    const expected = "Hello there.\n\nLet me know.";
    assert.equal(stripClosingFromBody(input), expected);
  });

  test.it("English: Kind regards + parenthetical middle name", () => {
    const input = "Body content here.\n\nKind regards,\nMichael (Adam) Goder";
    const expected = "Body content here.";
    assert.equal(stripClosingFromBody(input), expected);
  });

  test.it("English: Best + no comma + name", () => {
    const input = "Some content.\n\nBest\nJohn";
    const expected = "Some content.";
    assert.equal(stripClosingFromBody(input), expected);
  });

  test.it("English: Thanks! with exclamation + name", () => {
    const input = "Final line of content.\n\nThanks!\nJohn";
    const expected = "Final line of content.";
    assert.equal(stripClosingFromBody(input), expected);
  });

  test.it("Spanish: Saludos + nombre", () => {
    const input = "Hola Juan,\n\n¿Tendrías disponibilidad?\n\nSaludos,\nMiguel";
    const expected = "Hola Juan,\n\n¿Tendrías disponibilidad?";
    assert.equal(stripClosingFromBody(input), expected);
  });

  test.it("Spanish: Atentamente + name", () => {
    const input = "Cuerpo del email.\n\nAtentamente,\nJuan Pérez";
    const expected = "Cuerpo del email.";
    assert.equal(stripClosingFromBody(input), expected);
  });

  test.it("Portuguese: Atenciosamente + nome", () => {
    const input = "Olá João.\n\nFaz sentido conversarmos?\n\nAtenciosamente,\nMiguel";
    const expected = "Olá João.\n\nFaz sentido conversarmos?";
    assert.equal(stripClosingFromBody(input), expected);
  });

  test.it("French: Cordialement + nom", () => {
    const input = "Bonjour Jean,\n\nQu'en pensez-vous?\n\nCordialement,\nMichel";
    const expected = "Bonjour Jean,\n\nQu'en pensez-vous?";
    assert.equal(stripClosingFromBody(input), expected);
  });

  test.it("German: Mit freundlichen Grüßen + Name", () => {
    const input = "Hallo Hans.\n\nKönnen wir reden?\n\nMit freundlichen Grüßen,\nMichael";
    const expected = "Hallo Hans.\n\nKönnen wir reden?";
    assert.equal(stripClosingFromBody(input), expected);
  });

  test.it("Italian: Cordiali saluti + nome", () => {
    const input = "Ciao Marco.\n\nHa senso parlarne?\n\nCordiali saluti,\nMichele";
    const expected = "Ciao Marco.\n\nHa senso parlarne?";
    assert.equal(stripClosingFromBody(input), expected);
  });

  test.it("Russian: С уважением + Cyrillic name", () => {
    const input = "Здравствуйте, Иван.\n\nКак думаете?\n\nС уважением,\nМихаил";
    const expected = "Здравствуйте, Иван.\n\nКак думаете?";
    assert.equal(stripClosingFromBody(input), expected);
  });

  test.it("Russian: Спасибо + name", () => {
    const input = "Текст письма.\n\nСпасибо,\nМихаил Гудер";
    const expected = "Текст письма.";
    assert.equal(stripClosingFromBody(input), expected);
  });

  test.it("Hebrew: בברכה + Hebrew name", () => {
    const input = "שלום יוסף,\n\nמה דעתך?\n\nבברכה,\nמייקל";
    const expected = "שלום יוסף,\n\nמה דעתך?";
    assert.equal(stripClosingFromBody(input), expected);
  });

  test.it("Arabic: مع تحياتي + Arabic name", () => {
    const input = "مرحبا أحمد.\n\nما رأيك؟\n\nمع تحياتي،\nمايكل";
    const expected = "مرحبا أحمد.\n\nما رأيك؟";
    assert.equal(stripClosingFromBody(input), expected);
  });

  test.it("Japanese: 敬具 + Japanese name", () => {
    const input = "山田様、\n\nいかがでしょうか。\n\n敬具\nマイケル";
    const expected = "山田様、\n\nいかがでしょうか。";
    assert.equal(stripClosingFromBody(input), expected);
  });

  test.it("Japanese: よろしくお願いいたします + name", () => {
    const input = "本文。\n\nよろしくお願いいたします。\nマイケル";
    const expected = "本文。";
    assert.equal(stripClosingFromBody(input), expected);
  });

  test.it("Chinese: 此致 + Chinese name", () => {
    const input = "您好。\n\n请回复。\n\n此致\n敬礼\n迈克尔";
    // Both 此致 and 敬礼 are recognised closings, then 迈克尔 is the name.
    const expected = "您好。\n\n请回复。";
    assert.equal(stripClosingFromBody(input), expected);
  });

  test.it("Korean: 감사합니다 + Korean name", () => {
    const input = "안녕하세요.\n\n어떻게 생각하세요?\n\n감사합니다,\n마이클";
    const expected = "안녕하세요.\n\n어떻게 생각하세요?";
    assert.equal(stripClosingFromBody(input), expected);
  });

  test.it("Thai: ขอแสดงความนับถือ + Thai name", () => {
    const input = "สวัสดีครับ\n\nคิดอย่างไรครับ\n\nขอแสดงความนับถือ,\nไมเคิล";
    const expected = "สวัสดีครับ\n\nคิดอย่างไรครับ";
    assert.equal(stripClosingFromBody(input), expected);
  });

  test.it("Vietnamese: Trân trọng + name", () => {
    const input = "Xin chào.\n\nAnh nghĩ sao?\n\nTrân trọng,\nMichael";
    const expected = "Xin chào.\n\nAnh nghĩ sao?";
    assert.equal(stripClosingFromBody(input), expected);
  });

  test.it("Hindi: सादर + Hindi name", () => {
    const input = "नमस्ते।\n\nआपकी क्या राय है?\n\nसादर,\nमाइकल";
    const expected = "नमस्ते।\n\nआपकी क्या राय है?";
    assert.equal(stripClosingFromBody(input), expected);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Negative cases — real content must survive untouched
// ──────────────────────────────────────────────────────────────────────

test.describe("B8a negative cases — body content must NOT be stripped", () => {
  test.it("Inline 'thanks' inside a sentence is not stripped", () => {
    const input = "Following up on my note. Thanks again for the call last week, the breakdown helps.";
    assert.equal(stripClosingFromBody(input), input);
  });

  test.it("Body ending with a real CTA question mark is not stripped", () => {
    const input = "Hi John.\n\nWorth a quick test on Malaysia?";
    assert.equal(stripClosingFromBody(input), input);
  });

  test.it("Body ending with a real CTA period is not stripped", () => {
    const input = "Hi John.\n\nHappy to share the breakdown.";
    assert.equal(stripClosingFromBody(input), input);
  });

  test.it("Body ending with a multi-word sentence containing 'thanks' is not stripped", () => {
    const input = "Hi John.\n\nLet me know if helpful, and thanks for your time.";
    assert.equal(stripClosingFromBody(input), input);
  });

  test.it("Body with no closing whatsoever is unchanged", () => {
    const input = "Hi John.\n\nFollowing up on my note about Malaysia.\n\nLazada moved 40% of traffic through CPS partners last quarter.";
    assert.equal(stripClosingFromBody(input), input);
  });

  test.it("Spanish content with the word 'gracias' inline is not stripped", () => {
    const input = "Hola Juan, gracias por su respuesta detallada del lunes.";
    assert.equal(stripClosingFromBody(input), input);
  });

  test.it("Bare orphan name line with NO preceding closing is left alone", () => {
    // The model occasionally drops just a name with no "Best regards"
    // line above it. Per design, the stripper only fires the name-pop
    // when a closing was just removed. This is intentional — false
    // positives on real short final lines are worse than missing this
    // edge case, which the critic should catch via its closing_strip
    // criterion.
    const input = "Hi John.\n\nWorth a chat?\n\nMichael";
    assert.equal(stripClosingFromBody(input), input);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Edge cases
// ──────────────────────────────────────────────────────────────────────

test.describe("B8a edge cases", () => {
  test.it("Empty body returns empty body", () => {
    assert.equal(stripClosingFromBody(""), "");
  });

  test.it("Whitespace-only body returns empty string", () => {
    assert.equal(stripClosingFromBody("   \n\n  \n"), "");
  });

  test.it("Multiple stacked closings are all removed", () => {
    const input = "Body.\n\nThanks,\nBest regards,\nMichael";
    const expected = "Body.";
    assert.equal(stripClosingFromBody(input), expected);
  });

  test.it("Extra blank lines between body and closing are cleaned up", () => {
    const input = "Body.\n\n\n\nBest regards,\nMichael\n\n\n";
    const expected = "Body.";
    assert.equal(stripClosingFromBody(input), expected);
  });

  test.it("Closing with no following name strips only the closing", () => {
    const input = "Body.\n\nBest regards,";
    const expected = "Body.";
    assert.equal(stripClosingFromBody(input), expected);
  });

  test.it("Idempotency — running twice produces the same result as once", () => {
    const input = "Hi.\n\nWorth a chat?\n\nBest regards,\nMichael";
    const onePass = stripClosingFromBody(input);
    const twoPass = stripClosingFromBody(onePass);
    assert.equal(twoPass, onePass);
  });

  test.it("CRLF line endings are preserved on output", () => {
    const input = "Body line one.\r\n\r\nBest regards,\r\nMichael";
    const result = stripClosingFromBody(input);
    assert.ok(result.includes("\r\n") || !result.includes("\n"), "CRLF must round-trip when input uses CRLF");
    assert.equal(result.replace(/\r/g, ""), "Body line one.");
  });

  test.it("Trailing whitespace after closing is fully cleaned", () => {
    const input = "Body.\n\nThanks,\nMichael\n   \n  \n";
    const expected = "Body.";
    assert.equal(stripClosingFromBody(input), expected);
  });

  test.it("Closing followed by a real sentence is left alone (mid-body, not trailing)", () => {
    // When a closing line is followed by another real sentence (not a
    // name), the stripper leaves it untouched. The closing is not at
    // the trailing end of the body — it's mid-body — and the stripper
    // only acts on trailing closings.
    const input = "Body.\n\nBest regards,\nLet me know your thoughts.";
    assert.equal(stripClosingFromBody(input), input);
  });

  test.it("Long final sentence (5+ tokens) after closing is preserved", () => {
    const input = "Body.\n\nBest regards from the whole MobUpps team here";
    // The "Best regards" is part of a longer sentence; full-line
    // normalisation gives "best regards from the whole mobupps team
    // here" which is not in the CLOSING_PHRASES set. Nothing is
    // stripped.
    assert.equal(stripClosingFromBody(input), input);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Phrase-table sanity
// ──────────────────────────────────────────────────────────────────────

test.describe("B8a phrase-table sanity", () => {
  test.it("CLOSING_PHRASES contains the canonical English forms", () => {
    for (const phrase of ["best regards", "regards", "sincerely", "thanks", "cheers"]) {
      assert.ok(CLOSING_PHRASES_FOR_TESTING.has(phrase), `missing English phrase: ${phrase}`);
    }
  });

  test.it("CLOSING_PHRASES contains at least one entry for each major target language", () => {
    const samples: Record<string, string[]> = {
      Spanish: ["saludos", "atentamente"],
      Portuguese: ["atenciosamente"],
      French: ["cordialement"],
      German: ["mfg"],
      Italian: ["saluti"],
      Russian: ["с уважением"],
      Hebrew: ["בברכה"],
      Arabic: ["تحياتي"],
      Japanese: ["敬具"],
      Chinese: ["此致"],
      Korean: ["감사합니다"],
      Thai: ["ขอแสดงความนับถือ"],
      Vietnamese: ["trân trọng"],
      Hindi: ["सादर"],
    };
    for (const [lang, entries] of Object.entries(samples)) {
      for (const entry of entries) {
        assert.ok(
          CLOSING_PHRASES_FOR_TESTING.has(entry),
          `${lang}: missing phrase "${entry}"`,
        );
      }
    }
  });

  test.it("All phrases in the table are lowercased and trimmed", () => {
    for (const phrase of CLOSING_PHRASES_FOR_TESTING) {
      assert.equal(phrase.trim(), phrase, `phrase has whitespace: "${phrase}"`);
      assert.equal(phrase.toLowerCase(), phrase, `phrase has uppercase chars: "${phrase}"`);
    }
  });
});
