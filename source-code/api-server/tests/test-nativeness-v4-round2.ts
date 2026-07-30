/**
 * test-nativeness-v4-round2.ts
 *
 * Test suite for the v4 Round-2 universal native-style detectors:
 *   - findRepeatingDiscourseMarkers
 *   - findSemicolonWithoutConnector
 *   - findNonReflexiveRomanceVerbs
 *
 * Plus integration with findAllNativenessViolationsV4 and hasAnyViolationV4.
 *
 * Run with:
 *   pnpm --filter @workspace/api-server exec tsx tests/test-nativeness-v4-round2.ts
 */

import * as test from "node:test";
import * as assert from "node:assert/strict";

import {
  // Existing v4 aggregator
  findAllNativenessViolationsV4,
  hasAnyViolationV4,
  // v4 Round-2 detectors
  findRepeatingDiscourseMarkers,
  findSemicolonWithoutConnector,
  findNonReflexiveRomanceVerbs,
  // v4 Round-2 data tables
  REPEATING_DISCOURSE_MARKERS,
  SEMICOLON_CONNECTORS,
  NON_REFLEXIVE_VERBS,
} from "../lib/nativenessV4";


// ============================================================================
// 1. REPEATING DISCOURSE MARKERS
// ============================================================================

test.test("v4r2: pt-BR — Denise email caught (vale mencionar 2x)", () => {
  const email = `Olá Natan,\n\nVale mencionar que, no Brasil, temos resultados sólidos.\nOperamos com inventário semi-exclusivo via parcerias diretas.\nVale mencionar que Mercado Pago e C6 Bank rodam programas similares.`;
  const hits = findRepeatingDiscourseMarkers(email, "pt-BR");
  assert.ok(hits.length >= 1);
  assert.ok(hits.some(h => h.marker === "vale mencionar"));
  assert.ok(hits.some(h => h.count >= 2));
});

test.test("v4r2: pt base tag falls back from pt-BR", () => {
  const email = "Vale destacar isso. Outro ponto. Vale destacar também aquilo.";
  const hits = findRepeatingDiscourseMarkers(email, "pt");
  assert.ok(hits.some(h => h.marker === "vale destacar"));
});

test.test("v4r2: en — worth mentioning caught", () => {
  const email = `I wanted to share context. It's worth mentioning the retention. Additionally, it's worth mentioning the antifraud layer.`;
  const hits = findRepeatingDiscourseMarkers(email, "en");
  assert.ok(hits.some(h => h.marker === "worth mentioning"));
});

test.test("v4r2: es — cabe destacar caught", () => {
  const email = `Cabe destacar que los resultados son sólidos. El mercado responde bien. Cabe destacar también la integración.`;
  const hits = findRepeatingDiscourseMarkers(email, "es");
  assert.ok(hits.some(h => h.marker === "cabe destacar"));
});

test.test("v4r2: fr — à noter caught", () => {
  const email = `À noter que notre rétention dépasse 35%. Le marché est mature. À noter aussi le contexte antifraude.`;
  const hits = findRepeatingDiscourseMarkers(email, "fr");
  assert.ok(hits.some(h => h.marker === "à noter"));
});

test.test("v4r2: de — erwähnenswert caught", () => {
  const email = `Erwähnenswert ist die hohe Retention. Der Markt ist reif. Erwähnenswert ist auch die Antifraud-Architektur.`;
  const hits = findRepeatingDiscourseMarkers(email, "de");
  assert.ok(hits.some(h => h.marker === "erwähnenswert ist"));
});

test.test("v4r2: ru — стоит отметить caught", () => {
  const email = `Стоит отметить, что наши результаты стабильны. Рынок зрелый. Стоит отметить также интеграцию.`;
  const hits = findRepeatingDiscourseMarkers(email, "ru");
  assert.ok(hits.some(h => h.marker === "стоит отметить"));
});

test.test("v4r2: he — ראוי לציין caught", () => {
  const email = `ראוי לציין שהתוצאות שלנו חזקות. השוק בוגר. ראוי לציין גם את שכבת ההגנה.`;
  const hits = findRepeatingDiscourseMarkers(email, "he");
  assert.ok(hits.some(h => h.marker === "ראוי לציין"));
});

test.test("v4r2: single use does NOT fire", () => {
  const email = "Vale mencionar isso. Outro ponto. Mais alguma coisa.";
  const hits = findRepeatingDiscourseMarkers(email, "pt-BR");
  assert.deepStrictEqual(hits, []);
});

test.test("v4r2: empty text returns empty", () => {
  assert.deepStrictEqual(findRepeatingDiscourseMarkers("", "pt-BR"), []);
});

test.test("v4r2: unknown language returns empty", () => {
  const email = "Vale mencionar. Vale mencionar.";
  assert.deepStrictEqual(findRepeatingDiscourseMarkers(email, "xx"), []);
});


// ============================================================================
// 2. SEMICOLON WITHOUT CONNECTOR
// ============================================================================

test.test("v4r2 semi: pt-BR — Denise email caught", () => {
  const email = `No mercado brasileiro, Nubank e PicPay já rodam mídia mobile otimizada no evento de primeiro aporte; a oferta de 150% do CDI da XP encaixa exatamente nesse playbook.`;
  const hits = findSemicolonWithoutConnector(email, "pt-BR");
  assert.equal(hits.length, 1);
  assert.ok(hits[0].followedBy.startsWith("a oferta"));
  assert.ok(hits[0].suggestions.includes("logo"));
});

test.test("v4r2 semi: pt-BR — with logo does NOT fire", () => {
  const email = `Nubank e PicPay já rodam mídia mobile; logo, a oferta de 150% do CDI da XP se encaixa nesse playbook.`;
  assert.deepStrictEqual(findSemicolonWithoutConnector(email, "pt-BR"), []);
});

test.test("v4r2 semi: pt-BR — with portanto does NOT fire", () => {
  const email = "Os números são fortes; portanto vamos avançar.";
  assert.deepStrictEqual(findSemicolonWithoutConnector(email, "pt-BR"), []);
});

test.test("v4r2 semi: en — without therefore caught", () => {
  const email = "Retention is strong; the playbook fits exactly.";
  assert.equal(findSemicolonWithoutConnector(email, "en").length, 1);
});

test.test("v4r2 semi: en — with therefore does NOT fire", () => {
  const email = "Retention is strong; therefore the playbook fits.";
  assert.deepStrictEqual(findSemicolonWithoutConnector(email, "en"), []);
});

test.test("v4r2 semi: es — without connector caught", () => {
  const email = "Los números son fuertes; el playbook se aplica.";
  assert.equal(findSemicolonWithoutConnector(email, "es").length, 1);
});

test.test("v4r2 semi: fr — without ainsi caught", () => {
  const email = "Les chiffres sont solides; le playbook s'applique.";
  assert.equal(findSemicolonWithoutConnector(email, "fr").length, 1);
});

test.test("v4r2 semi: de — without daher caught", () => {
  const email = "Die Zahlen sind stark; das Playbook passt.";
  assert.equal(findSemicolonWithoutConnector(email, "de").length, 1);
});

test.test("v4r2 semi: ja — skipped", () => {
  const email = "日本語の文章です; 別の文章です。";
  assert.deepStrictEqual(findSemicolonWithoutConnector(email, "ja"), []);
});

test.test("v4r2 semi: th — skipped", () => {
  const email = "ภาษาไทย; อีกประโยคหนึ่ง";
  assert.deepStrictEqual(findSemicolonWithoutConnector(email, "th"), []);
});

test.test("v4r2 semi: ar — skipped", () => {
  const email = "اللغة العربية; جملة أخرى";
  assert.deepStrictEqual(findSemicolonWithoutConnector(email, "ar"), []);
});

test.test("v4r2 semi: he — skipped", () => {
  const email = "עברית; משפט נוסף";
  assert.deepStrictEqual(findSemicolonWithoutConnector(email, "he"), []);
});

test.test("v4r2 semi: no semicolon returns empty", () => {
  const email = "Vale mencionar que os números são fortes.";
  assert.deepStrictEqual(findSemicolonWithoutConnector(email, "pt-BR"), []);
});

test.test("v4r2 semi: ;\\n bullet list does NOT fire (PT/ES/IT pattern)", () => {
  const email = "Vantagens:\n- sem fee;\n- sem mínimo de investimento;\n- otimização por LTV.";
  // Each `;\n-` is a list-item terminator, not a clause joiner
  assert.deepStrictEqual(findSemicolonWithoutConnector(email, "pt-BR"), []);
});


// ============================================================================
// 3. NON-REFLEXIVE ROMANCE VERBS
// ============================================================================

test.test("v4r2 refl: pt-BR — encaixa caught", () => {
  const email = "A oferta de 150% do CDI da XP encaixa exatamente nesse playbook.";
  const hits = findNonReflexiveRomanceVerbs(email, "pt-BR");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].verb, "encaixa");
  assert.equal(hits[0].expected, "se encaixa");
});

test.test("v4r2 refl: pt-BR — se encaixa does NOT fire", () => {
  const email = "A oferta de 150% se encaixa exatamente nesse playbook.";
  assert.deepStrictEqual(findNonReflexiveRomanceVerbs(email, "pt-BR"), []);
});

test.test("v4r2 refl: pt-BR — aplica caught", () => {
  const email = "O modelo aplica diretamente ao seu caso.";
  const hits = findNonReflexiveRomanceVerbs(email, "pt-BR");
  assert.ok(hits.some(h => h.verb === "aplica"));
});

test.test("v4r2 refl: es — aplica caught", () => {
  const email = "El modelo aplica directamente a su caso.";
  const hits = findNonReflexiveRomanceVerbs(email, "es");
  assert.ok(hits.some(h => h.verb === "aplica"));
});

test.test("v4r2 refl: fr — applique caught", () => {
  const email = "Le modèle applique directement à votre cas.";
  const hits = findNonReflexiveRomanceVerbs(email, "fr");
  assert.ok(hits.some(h => h.verb === "applique"));
});

test.test("v4r2 refl: it — applica caught", () => {
  const email = "Il modello applica direttamente al vostro caso.";
  const hits = findNonReflexiveRomanceVerbs(email, "it");
  assert.ok(hits.some(h => h.verb === "applica"));
});

test.test("v4r2 refl: non-Romance returns empty (en)", () => {
  const email = "The model applies directly to your case.";
  assert.deepStrictEqual(findNonReflexiveRomanceVerbs(email, "en"), []);
});

test.test("v4r2 refl: de returns empty", () => {
  const email = "Das Modell passt direkt zu Ihrem Fall.";
  assert.deepStrictEqual(findNonReflexiveRomanceVerbs(email, "de"), []);
});


// ============================================================================
// 4. AGGREGATOR INTEGRATION
// ============================================================================

test.test("v4r2 aggregator: returns 3 new keys", () => {
  const r = findAllNativenessViolationsV4("", "pt-BR");
  assert.ok("repeating_discourse_markers" in r);
  assert.ok("semicolon_no_connector" in r);
  assert.ok("non_reflexive_romance_verbs" in r);
});

test.test("v4r2 aggregator: Denise email fires all 3 detectors", () => {
  const email = `No mercado brasileiro, Nubank e PicPay rodam mídia mobile otimizada; a oferta de 150% do CDI da XP encaixa nesse playbook.\n\nVale mencionar que temos resultados fortes. Operamos com inventário semi-exclusivo. Vale mencionar também C6 Bank.`;
  const r = findAllNativenessViolationsV4(email, "pt-BR");
  assert.ok(r.repeating_discourse_markers.length > 0, "repeating not caught");
  assert.ok(r.semicolon_no_connector.length > 0, "semicolon not caught");
  assert.ok(r.non_reflexive_romance_verbs.length > 0, "non-reflexive not caught");
});

test.test("v4r2 aggregator: hasAnyViolationV4 fires on new keys", () => {
  const r = findAllNativenessViolationsV4(
    "Vale mencionar isso. Vale mencionar aquilo.", "pt-BR");
  assert.equal(hasAnyViolationV4(r), true);
});

test.test("v4r2 aggregator: clean email does NOT fire", () => {
  const email = `Olá Natan,\n\nNo Brasil, Nubank e PicPay rodam mídia mobile otimizada. Logo, a oferta de 150% do CDI da XP se encaixa nesse playbook.\n\nVale mencionar que nossa retenção D7 está acima de 35%. Operamos com inventário semi-exclusivo via parcerias diretas. Clientes como Mercado Pago e C6 Bank rodam programas similares.`;
  const r = findAllNativenessViolationsV4(email, "pt-BR");
  assert.deepStrictEqual(r.repeating_discourse_markers, []);
  assert.deepStrictEqual(r.semicolon_no_connector, []);
  assert.deepStrictEqual(r.non_reflexive_romance_verbs, []);
});


// ============================================================================
// 5. LANGUAGE COVERAGE SANITY
// ============================================================================

test.test("v4r2 coverage: discourse markers cover required languages", () => {
  const required = new Set([
    "en", "pt", "pt-BR", "es", "fr", "de", "it",
    "ja", "zh", "ko", "ar", "he", "ru",
  ]);
  for (const lang of required) {
    assert.ok(
      REPEATING_DISCOURSE_MARKERS[lang],
      `Missing discourse markers for: ${lang}`
    );
  }
});

test.test("v4r2 coverage: semicolon connectors cover required languages", () => {
  const required = new Set([
    "en", "pt", "pt-BR", "es", "fr", "de", "it", "nl", "ru",
  ]);
  for (const lang of required) {
    assert.ok(
      SEMICOLON_CONNECTORS[lang],
      `Missing semicolon connectors for: ${lang}`
    );
  }
});

test.test("v4r2 coverage: reflexive verbs cover Romance languages", () => {
  const required = new Set(["pt", "pt-BR", "es", "fr", "it"]);
  for (const lang of required) {
    assert.ok(
      NON_REFLEXIVE_VERBS[lang],
      `Missing reflexive verbs for: ${lang}`
    );
  }
});
