/**
 * test-competitor-script-lint.ts
 *
 * Hermetic tests for the native-script enforcement layer: the curated native
 * forms, the deterministic competitor-script lint, and the strict-native block
 * rendering. No DB, no network.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx --test src/tests/test-competitor-script-lint.ts
 */
import * as test from "node:test";
import * as assert from "node:assert/strict";

import {
  isStrictNativeLang,
  isLatinKeepBrand,
  nativeFormFor,
} from "../lib/competitorNativeForms";
import { detectCompetitorScriptViolations } from "../lib/competitorScriptLint";
import { buildWriterCompetitorBlock } from "../lib/competitorLibrary";

test.test("native form helpers", () => {
  assert.equal(nativeFormFor("ru", "Ozon"), "Озон");
  assert.equal(nativeFormFor("ru", "ozon"), "Озон");
  assert.equal(nativeFormFor("ru", "Wildberries"), null); // Latin-keep stays Latin
  assert.equal(nativeFormFor("es", "Ozon"), null); // not a strict-native language
  assert.equal(nativeFormFor("ar", "Noon"), "نون");
  assert.equal(isLatinKeepBrand("AliExpress"), true);
  assert.equal(isStrictNativeLang("ru"), true);
  assert.equal(isStrictNativeLang("hi"), false); // Indian languages excluded
  assert.equal(isStrictNativeLang("es"), false);
});

test.test("flags a Latin brand in a Russian body and suggests the native form", () => {
  const body = "Здравствуйте! На рынке растет конкуренция со стороны Ozon, поэтому стоит обсудить.";
  const r = detectCompetitorScriptViolations(body, "ru");
  assert.equal(r.found, true);
  assert.ok(r.matches.includes("ozon→Озон"));
  assert.ok(r.issues[0].includes("Озон"));
});

test.test("does not flag when the native form is already used", () => {
  const body = "Здравствуйте! Конкуренция со стороны Озон растет, поэтому стоит обсудить.";
  const r = detectCompetitorScriptViolations(body, "ru");
  assert.equal(r.found, false);
});

test.test("does not flag Latin-keep brands", () => {
  const body = "Здравствуйте! Wildberries и AliExpress активно растут на рынке.";
  const r = detectCompetitorScriptViolations(body, "ru");
  assert.equal(r.found, false);
});

test.test("does not flag a Latin substring inside a longer Latin word", () => {
  // "Ozonized" must not trip the "ozon" rule.
  const body = "Привет, продукт был Ozonized для теста, не бренд.";
  const r = detectCompetitorScriptViolations(body, "ru");
  assert.equal(r.found, false);
});

test.test("no enforcement for Latin or excluded languages", () => {
  assert.equal(detectCompetitorScriptViolations("Competition from Ozon is rising.", "en").found, false);
  assert.equal(detectCompetitorScriptViolations("Ozon पर प्रतिस्पर्धा बढ़ रही है।", "hi").found, false);
});

test.test("Arabic flags Latin brand names", () => {
  const body = "مرحبًا، المنافسة من Jumia وNoon في ازدياد.";
  const r = detectCompetitorScriptViolations(body, "ar");
  assert.equal(r.found, true);
  assert.ok(r.matches.some((m) => m.startsWith("jumia")) || r.matches.some((m) => m.startsWith("noon")));
});

test.test("strict-native block renders native forms and the strict directive", () => {
  const block = buildWriterCompetitorBlock({
    vertical: "cps",
    sub_vertical: "cps_ecommerce",
    product: "cps",
    original_language: "ru",
  });
  assert.ok(block.length > 0);
  assert.ok(block.includes("Озон"), "expected the native form Озон in the peer list");
  assert.ok(block.includes("Wildberries"), "Latin-keep brand should stay Latin");
  assert.match(block, /Write each peer name exactly in the script shown/);
});

test.test("Latin-language block keeps Latin names and the generic directive", () => {
  const block = buildWriterCompetitorBlock({
    vertical: "cps",
    sub_vertical: "cps_ecommerce",
    product: "cps",
    original_language: "es",
  });
  assert.ok(block.length > 0);
  assert.match(block, /Latin reference form/);
});
