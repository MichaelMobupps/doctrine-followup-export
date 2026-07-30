/**
 * test-discourse-autofix-v4r4.ts
 *
 * v4 Round-4 hardening tests for deterministic dedup auto-fix.
 *
 * Run:
 *   pnpm --filter @workspace/api-server exec tsx --test tests/test-discourse-autofix-v4r4.ts
 */

import * as test from "node:test";
import * as assert from "node:assert/strict";

import {
  autoFixRepeatingDiscourseMarkers,
  countDuplicateMarkerHits,
  COMPLEMENTIZERS,
} from "../lib/discourseMarkerAutofix";
import { findRepeatingDiscourseMarkers } from "../lib/nativenessV4";


const DENISE_TEXT =
  "Vale mencionar que, no Brasil, temos conseguido entregar 500+ " +
  "contas com primeiro aporte por dia, com retenção D7 acima de 35%. " +
  "Operamos com inventário semi-exclusivo via parcerias diretas. " +
  "Vale mencionar que Mercado Pago e C6 Bank rodam programas " +
  "otimizados em depósito nesse patamar.";


// ============================================================================
// Denise canonical
// ============================================================================

test.test("v4r4 autofix: Denise text has dedup before", () => {
  assert.ok(countDuplicateMarkerHits(DENISE_TEXT, "pt-BR") >= 1);
});

test.test("v4r4 autofix: Denise text clean after", () => {
  const { fixedText } = autoFixRepeatingDiscourseMarkers(DENISE_TEXT, "pt-BR");
  assert.equal(countDuplicateMarkerHits(fixedText, "pt-BR"), 0);
});

test.test("v4r4 autofix: reports at least 1 fix", () => {
  const { fixes } = autoFixRepeatingDiscourseMarkers(DENISE_TEXT, "pt-BR");
  assert.ok(fixes.length >= 1);
});

test.test("v4r4 autofix: first occurrence preserved", () => {
  const { fixedText } = autoFixRepeatingDiscourseMarkers(DENISE_TEXT, "pt-BR");
  assert.ok(fixedText.includes("Vale mencionar"),
    `First occurrence destroyed: ${fixedText.substring(0, 200)}`);
});

test.test("v4r4 autofix: strips complementizer 'que'", () => {
  const { fixedText } = autoFixRepeatingDiscourseMarkers(DENISE_TEXT, "pt-BR");
  assert.ok(!fixedText.includes("Que Mercado"),
    `Dangling complementizer: ${fixedText}`);
  assert.ok(!fixedText.includes("que Mercado"));
  assert.ok(fixedText.includes("Mercado Pago e C6 Bank"));
});

test.test("v4r4 autofix: preserves factual content", () => {
  const { fixedText } = autoFixRepeatingDiscourseMarkers(DENISE_TEXT, "pt-BR");
  for (const keep of ["500+", "35%", "Mercado Pago", "C6 Bank", "Brasil"]) {
    assert.ok(fixedText.includes(keep), `Lost: ${keep}`);
  }
});


// ============================================================================
// Multi-language complementizer
// ============================================================================

test.test("v4r4 autofix EN: strips 'worth mentioning that'", () => {
  const text =
    "It's worth mentioning that we deliver 500/day. " +
    "We have D7 retention. " +
    "It's worth mentioning that fraud is below 3%.";
  const { fixedText, fixes } = autoFixRepeatingDiscourseMarkers(text, "en");
  assert.ok(!fixedText.includes("That fraud"));
  assert.ok(fixes.length >= 1);
});

test.test("v4r4 autofix ES: strips 'cabe mencionar que'", () => {
  const text =
    "Cabe mencionar que entregamos 500/día. " +
    "Tenemos retención D7. " +
    "Cabe mencionar que Mercado Pago opera en depósito.";
  const { fixedText } = autoFixRepeatingDiscourseMarkers(text, "es");
  assert.ok(fixedText.includes("Mercado Pago opera"));
  assert.ok(!fixedText.includes("Que Mercado"));
  assert.equal(countDuplicateMarkerHits(fixedText, "es"), 0);
});

test.test("v4r4 autofix FR: strips 'il convient de mentionner que'", () => {
  const text =
    "Il convient de mentionner que nous livrons 500/jour. " +
    "Notre rétention D7 est solide. " +
    "Il convient de mentionner que Mercado Pago opère.";
  const { fixedText } = autoFixRepeatingDiscourseMarkers(text, "fr");
  assert.equal(countDuplicateMarkerHits(fixedText, "fr"), 0);
});

test.test("v4r4 autofix IT: strips 'vale la pena menzionare che'", () => {
  const text =
    "Vale la pena menzionare che consegniamo 500/giorno. " +
    "Il mercato è solido. " +
    "Vale la pena menzionare che Mercado Pago opera in depositi.";
  const { fixedText } = autoFixRepeatingDiscourseMarkers(text, "it");
  assert.equal(countDuplicateMarkerHits(fixedText, "it"), 0);
  assert.ok(!fixedText.includes("Che Mercado"));
});

test.test("v4r4 autofix DE: strips 'erwähnenswert ist, dass'", () => {
  const text =
    "Erwähnenswert ist, dass wir 500/Tag liefern. " +
    "D7-Retention ist solide. " +
    "Erwähnenswert ist, dass Mercado Pago in Einzahlungen optimiert.";
  const { fixedText } = autoFixRepeatingDiscourseMarkers(text, "de");
  assert.equal(countDuplicateMarkerHits(fixedText, "de"), 0);
});


// ============================================================================
// No-op cases
// ============================================================================

test.test("v4r4 autofix: single occurrence is no-op", () => {
  const text = "Vale mencionar que entregamos 500/dia para Mercado Pago.";
  const { fixedText, fixes } = autoFixRepeatingDiscourseMarkers(text, "pt-BR");
  assert.equal(fixedText, text);
  assert.deepStrictEqual(fixes, []);
});

test.test("v4r4 autofix: empty text returns empty", () => {
  const { fixedText, fixes } = autoFixRepeatingDiscourseMarkers("", "pt-BR");
  assert.equal(fixedText, "");
  assert.deepStrictEqual(fixes, []);
});

test.test("v4r4 autofix: text with no markers unchanged", () => {
  const text = "Just a normal email body without markers.";
  const { fixedText, fixes } = autoFixRepeatingDiscourseMarkers(text, "en");
  assert.equal(fixedText, text);
  assert.deepStrictEqual(fixes, []);
});


// ============================================================================
// Edge cases
// ============================================================================

test.test("v4r4 autofix: three occurrences → keep 1, strip 2", () => {
  const text =
    "Vale mencionar que A é importante. " +
    "Outras frases aqui. " +
    "Vale mencionar que B é importante. " +
    "Mais contexto. " +
    "Vale mencionar que C é importante.";
  const { fixedText, fixes } = autoFixRepeatingDiscourseMarkers(text, "pt-BR");
  assert.equal(countDuplicateMarkerHits(fixedText, "pt-BR"), 0);
  assert.ok(fixedText.includes("Vale mencionar que A"));
  assert.ok(fixedText.includes("B é importante"));
  assert.ok(fixedText.includes("C é importante"));
  assert.ok(!fixedText.includes("Que B"));
  assert.ok(!fixedText.includes("Que C"));
  assert.equal(fixes.length, 2);
});

test.test("v4r4 autofix: unknown language no-op", () => {
  const text = "Vale mencionar que A. Vale mencionar que B.";
  const { fixedText } = autoFixRepeatingDiscourseMarkers(text, "klingon");
  assert.equal(fixedText, text);
});


// ============================================================================
// Complementizer vocabulary
// ============================================================================

test.test("v4r4 vocab: pt has 'que'", () => {
  assert.ok(COMPLEMENTIZERS.pt.includes("que"));
  assert.ok(COMPLEMENTIZERS["pt-BR"].includes("que"));
});

test.test("v4r4 vocab: en has 'that'", () => {
  assert.ok(COMPLEMENTIZERS.en.includes("that"));
});

test.test("v4r4 vocab: de has 'dass'", () => {
  assert.ok(COMPLEMENTIZERS.de.includes("dass"));
});

test.test("v4r4 vocab: it has 'che'", () => {
  assert.ok(COMPLEMENTIZERS.it.includes("che"));
});

test.test("v4r4 vocab: supported languages present", () => {
  for (const lang of ["en", "pt", "pt-BR", "es", "fr", "it", "de", "ru", "ja"]) {
    assert.ok(lang in COMPLEMENTIZERS, `Missing ${lang}`);
  }
});


// ============================================================================
// Integration with detector
// ============================================================================

test.test("v4r4 integration: detector returns 0 after autofix", () => {
  const before = findRepeatingDiscourseMarkers(DENISE_TEXT, "pt-BR");
  assert.ok(before.length >= 1);
  const { fixedText } = autoFixRepeatingDiscourseMarkers(DENISE_TEXT, "pt-BR");
  const after = findRepeatingDiscourseMarkers(fixedText, "pt-BR");
  assert.equal(after.length, 0);
});
