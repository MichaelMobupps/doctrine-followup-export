/**
 * test-ack-and-homograph-fixes.ts
 *
 * Locks the 2026-08-27 fixes for the two recurring E2E ship-fail classes.
 *
 * CLASS 1 — FOLLOWUP-ACK false positives (ru, hi).
 * Live Russian drafts opened with "Продолжаю нашу переписку по поводу…" —
 * textbook follow-up acknowledgment — and were flagged anyway, because the
 * marker table lacked the continuation-verb stems. Hindi only knew the
 * masculine agreement पिछले and missed the feminine पिछली. Every false
 * positive costs a rewrite cycle that cannot succeed, and in the E2E harness
 * (which has no LLM rescue) it counts as a genuine ship risk.
 *
 * CLASS 2 — FORBIDDEN-ENGLISH-SINGLETON homograph false positives.
 * The singleton list is spelled in English, so a target language whose OWN
 * standard word is the identical spelling gets flagged for writing natively:
 * a French draft was flagged for "durable", "installation" and "segments";
 * an Indonesian one for "model" (KBBI-native). The "fix" the rewrite loop
 * demands would be to stop writing French.
 *
 * Both fixes are fail-open by construction — ACK markers only SUPPRESS a
 * flag, and exemptions only UNFLAG — so the tests focus on the other edge:
 * the genuine defect classes must STILL be caught.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx --test src/tests/test-ack-and-homograph-fixes.ts
 */
import * as test from "node:test";
import * as assert from "node:assert/strict";

import { detectStructuralViolations } from "../lib/structuralLint";
import { findForbiddenSingletons } from "../lib/nativenessV3";

function ackFlagged(body: string, lang: string): boolean {
  const r = detectStructuralViolations(body, {
    languageTag: lang,
    originalText: "MobUpps CPS partnership",
    companyName: "ShopNova",
  });
  return r.issues.some((i) => i.includes("FOLLOWUP-ACK"));
}

test.describe("FOLLOWUP-ACK: natural continuation openers are acknowledgments", () => {
  test.it("Russian continuation framings pass (the live false-positive openings)", () => {
    // These two are verbatim from live drafts that were flagged.
    for (const opener of [
      "Продолжаю нашу переписку по поводу перехода на модель revenue-share.",
      "Продолжаю свою мысль относительно нашего CPS-партнёрства.",
      "Снова пишу по поводу CPS-партнёрства для ShopNova.",
      "Хочу вернуться к моему письму о CPS-партнёрстве.",
      "В предыдущем письме я описывал модель revenue-share.",
      // Feminine agreement — a saleswoman's draft must not be flagged either.
      "Ранее писала вам о CPS-партнёрстве.",
    ]) {
      const body = `Здравствуйте, Алексей,\n\n${opener}\n\nГотов обсудить детали. Что скажете?`;
      assert.equal(ackFlagged(body, "ru"), false, `false positive on: ${opener}`);
    }
  });

  test.it("a genuinely cold Russian opening is still flagged", () => {
    const cold = "Здравствуйте, Алексей,\n\nМы предлагаем CPS-партнёрство для вашей компании.\n\nГотов обсудить детали.";
    assert.equal(ackFlagged(cold, "ru"), true, "the rule must still catch a cold open");
  });

  test.it("Hindi feminine agreement and returning-to-my-message framings pass", () => {
    for (const opener of [
      "अपनी पिछली ईमेल पर लौट रहा हूँ जिसमें CPS साझेदारी की चर्चा थी।",
      "मेरी पिछली मेल के बारे में दोबारा संपर्क कर रहा हूँ।",
      "आपको याद दिलाना चाहता हूँ कि हमने CPS साझेदारी पर बात की थी।",
    ]) {
      const body = `नमस्ते एलेक्से,\n\n${opener}\n\nक्या अगले सप्ताह बात हो सकती है।`;
      assert.equal(ackFlagged(body, "hi"), false, `false positive on: ${opener}`);
    }
  });

  test.it("a genuinely cold Hindi opening is still flagged", () => {
    const cold = "नमस्ते एलेक्से,\n\nहम आपकी कंपनी के लिए CPS साझेदारी प्रदान करते हैं।\n\nक्या अगले सप्ताह बात हो सकती है।";
    assert.equal(ackFlagged(cold, "hi"), true);
  });

  test.it("Ukrainian mirrors the Russian extension", () => {
    const body = "Доброго дня, Олексію,\n\nПродовжую наше листування щодо CPS-партнерства.\n\nГотовий обговорити деталі.";
    assert.equal(ackFlagged(body, "uk"), false);
  });
});

test.describe("FORBIDDEN-ENGLISH-SINGLETON: homographs are not anglicisms", () => {
  test.it("French dictionary words spelled like English pass (the live false positives)", () => {
    // "durable", "installation", "segments" are verbatim from a flagged E2E
    // cell; "test" from a flagged context-flow cell. All are Larousse French.
    const fr = "Le test montre une installation durable sur ces segments, avec une bonne conversion et une attribution claire des sources.";
    assert.deepEqual(findForbiddenSingletons(fr, "fr"), []);
  });

  test.it("genuine English inside French is still flagged", () => {
    const bad = findForbiddenSingletons("Nous utilisons un cohort pour le screening des payers.", "fr");
    assert.deepEqual(bad.map((w) => w.toLowerCase()).sort(), ["cohort", "payers", "screening"]);
  });

  test.it("Spanish and Italian keep their RAE/Treccani 'test'", () => {
    assert.deepEqual(findForbiddenSingletons("Hicimos un test con resultados reales.", "es"), []);
    assert.deepEqual(findForbiddenSingletons("Abbiamo condotto un test approfondito.", "it"), []);
  });

  test.it("Italian 'validate' is a genuine error and stays flagged", () => {
    // Italian has validare; "validate" is English. The homograph exemption
    // must not leak onto words with a distinct native form.
    const bad = findForbiddenSingletons("Possiamo validate i risultati.", "it");
    assert.ok(bad.map((w) => w.toLowerCase()).includes("validate"));
  });

  test.it("Indonesian KBBI-native 'model' and 'data' pass", () => {
    assert.deepEqual(
      findForbiddenSingletons("Kami menggunakan model berbasis data untuk kampanye ini.", "id"),
      [],
    );
  });

  test.it("German homographs pass while the anti-loanword doctrine holds", () => {
    // Test / Installation / Partner have no doctrine-mandated German rival —
    // they ARE the German words.
    assert.deepEqual(
      findForbiddenSingletons("Der Test zeigt, dass unser Partner die Installation im Budget hält.", "de"),
      [],
    );
    // But the doctrine's deliberate rejections stand: Duden alternatives exist
    // (Leistung, Umwandlung, Kundenbindung) and the doctrine mandates them.
    const bad = findForbiddenSingletons(
      "Wir liefern starke Performance und Conversion für Ihre Retention.",
      "de",
    ).map((w) => w.toLowerCase());
    assert.deepEqual(bad.sort(), ["conversion", "performance", "retention"]);
  });
});
