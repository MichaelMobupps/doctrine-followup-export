/**
 * test-nativeness-v4-round4.ts
 *
 * v4 Round-4 verb-fronted lead-with detector tests.
 *
 * Closes the gap exposed by Denise's XP feedback. The pattern:
 *   [creative-subject NOUN] + (0-3 words) + [lead-VERB] + [WITH-particle] + comma-list
 *
 * Run with:
 *   pnpm --filter @workspace/api-server exec tsx --test tests/test-nativeness-v4-round4.ts
 */

import * as test from "node:test";
import * as assert from "node:assert/strict";

import {
  findVerbFrontedLeadWith,
  findAllNativenessViolationsV4,
  hasAnyViolationV4,
  VERB_FRONTED_LEAD_WITH_PATTERNS,
} from "../lib/nativenessV4";


// ============================================================================
// Denise canonical PT
// ============================================================================

test.test("v4r4 denise: exact PT phrase flagged", () => {
  const text = "Os criativos liderariam com CDB 150% do CDI, R$60 mil e " +
    "liquidez diária, localizados para personas como PF iniciante.";
  const hits = findVerbFrontedLeadWith(text, "pt-BR");
  assert.ok(hits.length >= 1, `Expected hit, got ${JSON.stringify(hits)}`);
});

test.test("v4r4 denise: pt tag works (base fallback)", () => {
  const text = "Os criativos liderariam com CDB 150% do CDI, R$60 mil e liquidez diária.";
  const hits = findVerbFrontedLeadWith(text, "pt");
  assert.ok(hits.length >= 1);
});

test.test("v4r4 denise: native rewrite NOT flagged", () => {
  const text = "Criativos como CDB com 150% do CDI, R$60 mil liquidez " +
    "diária com focados em pessoa física migrando da poupança, " +
    "certamente causariam bastante impacto e liderariam a estratégia inicial.";
  const hits = findVerbFrontedLeadWith(text, "pt-BR");
  assert.deepStrictEqual(hits, [], `False positive: ${JSON.stringify(hits)}`);
});


// ============================================================================
// PT variants
// ============================================================================

test.test("v4r4 pt: present-tense lideram com flagged", () => {
  const hits = findVerbFrontedLeadWith(
    "Os criativos lideram com produtos de alta liquidez, taxas zero.",
    "pt-BR"
  );
  assert.ok(hits.length >= 1);
});

test.test("v4r4 pt: singular criativo lidera com", () => {
  const hits = findVerbFrontedLeadWith(
    "O criativo lidera com CDB, fundos imobiliários, e ações.",
    "pt-BR"
  );
  assert.ok(hits.length >= 1);
});

test.test("v4r4 pt: anúncios liderariam com", () => {
  const hits = findVerbFrontedLeadWith(
    "Os anúncios liderariam com ofertas de cashback, frete grátis.",
    "pt-BR"
  );
  assert.ok(hits.length >= 1);
});

test.test("v4r4 pt: campanhas liderariam com", () => {
  const hits = findVerbFrontedLeadWith(
    "As campanhas liderariam com depósitos de alto valor, retorno garantido.",
    "pt-BR"
  );
  assert.ok(hits.length >= 1);
});


// ============================================================================
// EN
// ============================================================================

test.test("v4r4 en: creatives lead with list flagged", () => {
  const hits = findVerbFrontedLeadWith(
    "The creatives lead with high yields, low fees, instant liquidity.",
    "en"
  );
  assert.ok(hits.length >= 1);
});

test.test("v4r4 en: creatives would lead with list flagged", () => {
  const hits = findVerbFrontedLeadWith(
    "Our creatives would lead with the CDB rate, the R$60K cap, daily liquidity.",
    "en"
  );
  assert.ok(hits.length >= 1);
});

test.test("v4r4 en: ads leading with list flagged", () => {
  const hits = findVerbFrontedLeadWith(
    "Ads leading with promo codes, fast shipping, and gift cards perform best.",
    "en"
  );
  assert.ok(hits.length >= 1);
});

test.test("v4r4 en: idiomatic lead with empathy NOT flagged", () => {
  const hits = findVerbFrontedLeadWith(
    "We always lead with empathy in our customer service.",
    "en"
  );
  assert.deepStrictEqual(hits, []);
});


// ============================================================================
// ES / FR / IT
// ============================================================================

test.test("v4r4 es: creativos liderarían con flagged", () => {
  const hits = findVerbFrontedLeadWith(
    "Los creativos liderarían con CDB al 150% del CDI, comisiones cero, liquidez diaria.",
    "es"
  );
  assert.ok(hits.length >= 1);
});

test.test("v4r4 es: anuncios lideran con flagged", () => {
  const hits = findVerbFrontedLeadWith(
    "Los anuncios lideran con descuentos, envío gratis, garantía extendida.",
    "es"
  );
  assert.ok(hits.length >= 1);
});

test.test("v4r4 fr: créatifs mèneraient avec flagged", () => {
  const hits = findVerbFrontedLeadWith(
    "Les créatifs mèneraient avec des rendements élevés, sans frais, liquidité quotidienne.",
    "fr"
  );
  assert.ok(hits.length >= 1);
});

test.test("v4r4 fr: annonces mènent avec flagged", () => {
  const hits = findVerbFrontedLeadWith(
    "Les annonces mènent avec des promotions, livraison gratuite, garantie.",
    "fr"
  );
  assert.ok(hits.length >= 1);
});

test.test("v4r4 it: creativi guiderebbero con flagged", () => {
  const hits = findVerbFrontedLeadWith(
    "I creativi guiderebbero con rendimenti elevati, commissioni zero, liquidità giornaliera.",
    "it"
  );
  assert.ok(hits.length >= 1);
});

test.test("v4r4 it: annunci guidano con flagged", () => {
  const hits = findVerbFrontedLeadWith(
    "Gli annunci guidano con sconti, spedizione gratuita, garanzia estesa.",
    "it"
  );
  assert.ok(hits.length >= 1);
});


// ============================================================================
// Negatives
// ============================================================================

test.test("v4r4 neg: plain lead-verb no creative subject", () => {
  const hits = findVerbFrontedLeadWith(
    "The CEO would lead with strong values and humility.",
    "en"
  );
  assert.deepStrictEqual(hits, []);
});

test.test("v4r4 neg: creative subject no lead-verb", () => {
  const hits = findVerbFrontedLeadWith(
    "Our creatives focus on user pain points and value clarity.",
    "en"
  );
  assert.deepStrictEqual(hits, []);
});

test.test("v4r4 neg: no comma-list after with", () => {
  const hits = findVerbFrontedLeadWith(
    "Creatives lead with the brand. We measure performance.",
    "en"
  );
  assert.deepStrictEqual(hits, []);
});

test.test("v4r4 neg: empty text", () => {
  assert.deepStrictEqual(findVerbFrontedLeadWith("", "pt-BR"), []);
  assert.deepStrictEqual(findVerbFrontedLeadWith("", "en"), []);
});

test.test("v4r4 neg: unsupported language (ja, ar)", () => {
  const text = "Os criativos liderariam com CDB, R$60 mil, liquidez.";
  assert.deepStrictEqual(findVerbFrontedLeadWith(text, "ja"), []);
  assert.deepStrictEqual(findVerbFrontedLeadWith(text, "ar"), []);
});


// ============================================================================
// Report integration
// ============================================================================

test.test("v4r4 wiring: report has verb_fronted_lead_with key", () => {
  const text = "Os criativos liderariam com CDB, R$60 mil, liquidez.";
  const r = findAllNativenessViolationsV4(text, "pt-BR");
  assert.ok("verb_fronted_lead_with" in r, "Key missing in report");
  assert.ok(r.verb_fronted_lead_with.length >= 1);
});

test.test("v4r4 wiring: violation flag propagates", () => {
  const text = "Os criativos liderariam com CDB, R$60 mil, liquidez.";
  const r = findAllNativenessViolationsV4(text, "pt-BR");
  assert.equal(hasAnyViolationV4(r), true);
});

test.test("v4r4 wiring: native phrasing passes overall", () => {
  const text = "Criativos como CDB com 150% do CDI, R$60 mil liquidez " +
    "diária com focados em pessoa física certamente causariam impacto.";
  const r = findAllNativenessViolationsV4(text, "pt-BR");
  assert.deepStrictEqual(r.verb_fronted_lead_with, []);
});

test.test("v4r4 vocab: constant has expected languages", () => {
  for (const lang of ["en", "pt", "pt-BR", "es", "fr", "it"]) {
    assert.ok(lang in VERB_FRONTED_LEAD_WITH_PATTERNS, `Missing ${lang}`);
    assert.ok(VERB_FRONTED_LEAD_WITH_PATTERNS[lang].length >= 1);
  }
});
