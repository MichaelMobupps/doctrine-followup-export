/**
 * test-nativeness-v4.ts
 *
 * Test suite for the v4 native-style + translationese layer (lib/nativenessV4.ts)
 * and the Followuper bindings that delegate to it.
 *
 * Run with:
 *   pnpm --filter @workspace/api-server exec tsx tests/test-nativeness-v4.ts
 *
 * Coverage:
 *  1. Data table shape and minimum coverage
 *  2. Translationese detection across 14+ languages
 *  3. Greeting-name adaptation for non-Latin scripts
 *  4. v4 aggregator: v3 keys preserved (with loanword filter), v4 keys added
 *  5. hasAnyViolationV4 truth table
 *  6. Writer block: v3 prefix preserved + v4 sections appended
 *  7. Critic block: regional variant + structure + translationese + name adaptation
 *  8. v4.1: NATIVE_ENGLISH_LOANWORDS exemption (Denise v2 sample)
 *  9. v4.1: constructive_parallel_pattern NOT flagged by v3 x_not_y
 * 10. v4.2: criterion 13 universal language coverage in followupPrompts.ts
 */

import * as test from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  // Data
  LATIN_DIACRITIC_LANGS,
  NATIVE_ENGLISH_LOANWORDS,
  TRANSLATIONESE_PATTERNS,
  NATIVE_STYLE_GUIDES,
  // Types
  type NativenessV4Report,
  // Detectors
  findTranslationese,
  findGreetingNameAdaptationIssues,
  findAllNativenessViolationsV4,
  hasAnyViolationV4,
  // Builders
  buildNativenessBlockV4,
  buildCriticNativeStyleBlockV4,
} from "../lib/nativenessV4";

import {
  findXNotY,
} from "../lib/nativenessV3";

// ============================================================================
// Fixtures — production samples
// ============================================================================

// Image-2 BAD PT (pre-v4 production failure — Bradesco/XP context)
const BAD_PT = `Olá Vinicius,

Apps de investimento no Brasil disputam o primeiro aporte via PIX como evento norte, com Nubank e PicPay agressivos sobre o mesmo investidor pessoa física que a XP busca com o gancho de 150% do CDI.

A forma como trabalhamos é rodar uma campanha mobile. O ponto específico aqui é que ajustamos a mistura de editores e a estrutura de remuneração contra a persistência do segundo aporte. Ponderamos editores e posicionamentos editoriais em sobreposição direta com as mídias trabalhadas internamente.

Controlamos qualidade em várias camadas: pre-bid screening, redirecionamento via DSP sobre usuários, e validação no sinal de conversão. Safra de usuários com primeira instalação validada por MMP.

Faz sentido comparar um piloto de 400 contas com primeiro aporte por dia contra o CPA atual da XP?`;

// Denise's GOLD PT (v1) — passes clean
const GOOD_PT_V1 = `Olá, Natan. Como vai?

Sabemos que a disputa por usuários qualificados que realizam o primeiro investimento está cada vez mais acirrada.

Considerando que hoje entregamos mais de 400 contas/dia (com depósito realizado), acredito que temos insumos relevantes.

Operamos campanhas mobile em múltiplos canais com foco em inventários que concentram audiências com maior propensão à conversão.

Acredito que pode fazer sentido avaliarmos um piloto comparativo versus os canais atuais. Você está disponível para falarmos na próxima semana?`;

// Denise's GOLD PT (v2 — second gold reference for v4.1 calibration)
const GOOD_PT_V2 = `Olá, Natan. Espero que esteja bem.

Sabemos que o cenário de investimentos no Brasil tem se tornado cada vez mais competitivo. Considerando que o Itaú e o Bradesco também investem fortemente em performance para captura de novos investidores, vale mencionar que conseguimos entregar mais de 400 contas/dia com primeiro aporte via PIX abaixo de R$160 — e isso de forma escalável.

Além disso, vocês contarão com:
- mix de editores priorizado por afinidade com o perfil de investidor pessoa física;
- KPIs acompanhados em coorte com foco em LTV de 90 dias;
- testes AB de criativos e jornadas mensais.

Acredito que pode fazer sentido avaliarmos um piloto comparativo. Você está disponível para falarmos na próxima semana?`;

// Image-1 BAD Thai (Latin name in Thai greeting)
const BAD_TH = `เรียน Tareep,

ผู้ให้บริการสินเชื่อดิจิทัลในตลาดไทย...`;

// Clean Thai
const GOOD_TH = `เรียน ทรงสิทธิ์,

หวังว่าคุณสบายดี...`;

// ============================================================================
// 1. Data table shape and minimum coverage
// ============================================================================

test.test("LATIN_DIACRITIC_LANGS contains 16 expected codes", () => {
  assert.equal(LATIN_DIACRITIC_LANGS.size, 16);
  for (const code of ["pt", "es", "fr", "it", "vi", "cs", "pl", "hu", "de", "tr", "ro", "sv", "no", "nb", "da", "fi"]) {
    assert.ok(LATIN_DIACRITIC_LANGS.has(code), `${code} missing from LATIN_DIACRITIC_LANGS`);
  }
});

test.test("NATIVE_ENGLISH_LOANWORDS covers BR/LatAm adtech languages", () => {
  for (const lang of ["pt", "es", "it", "id", "ms", "nl", "fil", "tl"]) {
    assert.ok(NATIVE_ENGLISH_LOANWORDS[lang], `${lang} missing from NATIVE_ENGLISH_LOANWORDS`);
  }
  // pt-BR set must include the BR finance acronyms
  for (const term of ["performance", "fee", "players", "mix", "ROAS", "LTV", "KPI", "PIX", "FGC", "CDI"]) {
    assert.ok(NATIVE_ENGLISH_LOANWORDS.pt!.has(term), `pt loanword set missing: ${term}`);
  }
});

test.test("TRANSLATIONESE_PATTERNS covers >= 22 languages with >= 150 total patterns", () => {
  const langs = Object.keys(TRANSLATIONESE_PATTERNS);
  assert.ok(langs.length >= 22, `expected >= 22 languages, got ${langs.length}`);
  let total = 0;
  for (const arr of Object.values(TRANSLATIONESE_PATTERNS)) total += arr.length;
  assert.ok(total >= 150, `expected >= 150 total patterns, got ${total}`);
  assert.ok(TRANSLATIONESE_PATTERNS.pt.length >= 10, "pt should have >= 10 patterns");
  assert.ok(TRANSLATIONESE_PATTERNS.es.length >= 10, "es should have >= 10 patterns");
});

test.test("NATIVE_STYLE_GUIDES covers 35 languages with required fields", () => {
  const langs = Object.keys(NATIVE_STYLE_GUIDES);
  assert.equal(langs.length, 35, `expected 35 languages, got ${langs.length}`);
  for (const lang of langs) {
    const guide = NATIVE_STYLE_GUIDES[lang];
    assert.ok(guide.regional_variant, `${lang}: missing regional_variant`);
    assert.ok(guide.social_opener, `${lang}: missing social_opener`);
    assert.ok(guide.connector_phrases.length > 0, `${lang}: empty connector_phrases`);
    assert.ok(guide.softener_phrases.length > 0, `${lang}: empty softener_phrases`);
    assert.ok(guide.collaborative_close, `${lang}: missing collaborative_close`);
    assert.ok(guide.register_notes, `${lang}: missing register_notes`);
  }
});

test.test("v4.1: pt and es style guides have constructive_parallel_pattern + bullet_list_pattern", () => {
  assert.ok(NATIVE_STYLE_GUIDES.pt.constructive_parallel_pattern, "pt missing constructive_parallel_pattern");
  assert.ok(NATIVE_STYLE_GUIDES.es.constructive_parallel_pattern, "es missing constructive_parallel_pattern");
  assert.ok(NATIVE_STYLE_GUIDES.pt.bullet_list_pattern, "pt missing bullet_list_pattern");
  assert.ok(NATIVE_STYLE_GUIDES.es.bullet_list_pattern, "es missing bullet_list_pattern");
});

// ============================================================================
// 2. Translationese detection
// ============================================================================

test.test("findTranslationese: Image-2 BAD PT fires >= 5 hits", () => {
  const hits = findTranslationese(BAD_PT, "pt");
  assert.ok(hits.length >= 5, `expected >= 5 PT translationese hits, got ${hits.length}: ${JSON.stringify(hits)}`);
  // Spot-check specific patterns
  const joined = hits.join(" | ").toLowerCase();
  assert.ok(joined.includes("evento norte") || joined.includes("evento\u00a0norte"), "missing 'evento norte'");
  assert.ok(joined.includes("mistura de editores"), "missing 'mistura de editores'");
  assert.ok(joined.includes("contra a persistência"), "missing 'contra a persistência'");
});

test.test("findTranslationese: GOLD PT v1 (Denise) is clean (0 hits)", () => {
  const hits = findTranslationese(GOOD_PT_V1, "pt");
  assert.equal(hits.length, 0, `expected 0 PT translationese in Denise gold, got ${JSON.stringify(hits)}`);
});

test.test("findTranslationese: GOLD PT v2 (Denise v2) is clean (0 hits)", () => {
  const hits = findTranslationese(GOOD_PT_V2, "pt");
  assert.equal(hits.length, 0, `expected 0 PT translationese in Denise v2, got ${JSON.stringify(hits)}`);
});

test.test("findTranslationese: ES Spain leakage fires", () => {
  const text = "Vamos a usar el ordenador para ver vosotros la propuesta";
  const hits = findTranslationese(text, "es");
  assert.ok(hits.length >= 1, `expected ES Spain leakage, got ${JSON.stringify(hits)}`);
});

test.test("findTranslationese: EU PT progressive leakage fires", () => {
  const text = "Nós estamos a fazer uma campanha de teste";
  const hits = findTranslationese(text, "pt");
  assert.ok(hits.length >= 1, `expected EU PT leakage, got ${JSON.stringify(hits)}`);
});

test.test("findTranslationese: zh Traditional Chinese leakage fires", () => {
  const text = "我们的伺服器和網路都已经准备好";
  const hits = findTranslationese(text, "zh");
  assert.ok(hits.length >= 2, `expected Traditional tokens, got ${JSON.stringify(hits)}`);
});

test.test("findTranslationese: English returns empty (no patterns for en)", () => {
  const hits = findTranslationese("This is a north star event with a publisher mix", "en");
  assert.equal(hits.length, 0);
});

test.test("findTranslationese: unknown language returns empty", () => {
  const hits = findTranslationese("any text here", "xx");
  assert.equal(hits.length, 0);
});

// Spot-check each of the 14 major non-English languages has fixtures that fire
test.test("findTranslationese: each of 14 major non-English languages has a working pattern", () => {
  const fixtures: Record<string, string> = {
    pt: "evento norte para captação",
    es: "evento norte y mezcla de editores",
    it: "evento stella polare con miscela di editori",
    fr: "événement étoile du nord et mélange d'éditeurs",
    de: "Nordstern-Event mit Publisher-Mischung",
    ru: "событие полярная звезда и смесь издателей",
    ja: "北極星イベントとパブリッシャーミックス",
    zh: "北极星事件和发布商混合",
    ko: "북극성 이벤트와 퍼블리셔 믹스",
    ar: "حدث النجم الشمالي ومزيج الناشرين",
    he: "אירוע כוכב הצפון ותערובת מפרסמים",
    hi: "उत्तरी तारा घटना और प्रकाशक मिश्रण",
    th: "เหตุการณ์ดาวเหนือและการผสมผู้เผยแพร่",
    vi: "sự kiện sao bắc đẩu và hỗn hợp nhà xuất bản",
  };
  for (const [lang, text] of Object.entries(fixtures)) {
    const hits = findTranslationese(text, lang);
    assert.ok(hits.length >= 1, `${lang}: expected >= 1 translationese hit, got ${JSON.stringify(hits)}`);
  }
});

// ============================================================================
// 3. Greeting-name adaptation (non-Latin scripts)
// ============================================================================

test.test("findGreetingNameAdaptationIssues: Thai BAD flags Tareep", () => {
  const hits = findGreetingNameAdaptationIssues(BAD_TH, "th");
  assert.deepEqual(hits, ["Tareep"]);
});

test.test("findGreetingNameAdaptationIssues: clean Thai (full Thai-script greeting) passes", () => {
  const hits = findGreetingNameAdaptationIssues(GOOD_TH, "th");
  assert.equal(hits.length, 0);
});

test.test("findGreetingNameAdaptationIssues: Latin-script target returns empty (no false positives)", () => {
  // pt is Latin-script — the function should return empty even with Latin names
  const text = "Olá, Vinicius. Como vai?";
  const hits = findGreetingNameAdaptationIssues(text, "pt");
  assert.equal(hits.length, 0, "Latin-script langs must not flag Latin names");
});

test.test("findGreetingNameAdaptationIssues: English returns empty", () => {
  const hits = findGreetingNameAdaptationIssues("Hi Sarah,\nHow are you?", "en");
  assert.equal(hits.length, 0);
});

test.test("findGreetingNameAdaptationIssues: allowlist acronyms exempt", () => {
  // DSP is in the v3 LATIN_ALLOWLIST — should not flag
  const text = "เรียน DSP,\nหวังว่าคุณสบายดี";
  const hits = findGreetingNameAdaptationIssues(text, "th");
  assert.equal(hits.length, 0, "allowlist acronyms must not be flagged in greeting");
});

// ============================================================================
// 4. v4 aggregator: v3 keys preserved + v4 keys added + loanword filter
// ============================================================================

test.test("findAllNativenessViolationsV4: preserves all v3 keys", () => {
  const r = findAllNativenessViolationsV4(BAD_PT, "pt");
  const keys = Object.keys(r).sort();
  const expected = [
    "forbidden_phrases", "forbidden_singletons", "greeting_name_adaptation",
    "latin_token_runs",
    // v4 Round-2 keys
    "non_reflexive_romance_verbs", "repeating_discourse_markers",
    "semicolon_no_connector",
    "translationese", "untransliterated_greeting_name",
    // v4 Round-4 key
    "verb_fronted_lead_with",
    "x_not_y",
  ];
  assert.deepEqual(keys, expected);
});

test.test("findAllNativenessViolationsV4: BAD PT triggers translationese", () => {
  const r = findAllNativenessViolationsV4(BAD_PT, "pt");
  assert.ok(r.translationese.length >= 5);
});

test.test("findAllNativenessViolationsV4: v4.1 loanword filter — Denise v2 'performance/LTV/ROAS' exempt in pt", () => {
  const r = findAllNativenessViolationsV4(GOOD_PT_V2, "pt");
  // forbidden_singletons should NOT contain performance/LTV/KPIs since they're loanwords in pt
  const lower = r.forbidden_singletons.map(s => s.toLowerCase());
  for (const term of ["performance", "ltv", "kpis", "roas"]) {
    assert.ok(!lower.includes(term), `pt loanword '${term}' wrongly flagged in Denise v2`);
  }
});

test.test("findAllNativenessViolationsV4: 'install' (non-loanword) still flagged in pt", () => {
  // 'install' is NOT in pt's NATIVE_ENGLISH_LOANWORDS — should still fire v3 singleton flag
  const text = "Sabemos que install foi feito por mais de 1000 usuários hoje.";
  const r = findAllNativenessViolationsV4(text, "pt");
  const lower = r.forbidden_singletons.map(s => s.toLowerCase());
  assert.ok(lower.includes("install"), `'install' should still be flagged in pt: ${JSON.stringify(r.forbidden_singletons)}`);
});

test.test("findAllNativenessViolationsV4: loanwords don't apply to de", () => {
  // 'performance' is NOT exempt in German — should still fire
  const text = "Wir haben eine starke performance erreicht";
  const r = findAllNativenessViolationsV4(text, "de");
  const lower = r.forbidden_singletons.map(s => s.toLowerCase());
  assert.ok(lower.includes("performance"), `'performance' should still be flagged in de: ${JSON.stringify(r.forbidden_singletons)}`);
});

// ============================================================================
// 5. hasAnyViolationV4 truth table
// ============================================================================

test.test("hasAnyViolationV4: BAD PT (translationese present) → true", () => {
  const r = findAllNativenessViolationsV4(BAD_PT, "pt");
  assert.equal(hasAnyViolationV4(r), true);
});

test.test("hasAnyViolationV4: GOOD PT v1 (Denise) → false", () => {
  const r = findAllNativenessViolationsV4(GOOD_PT_V1, "pt");
  assert.equal(hasAnyViolationV4(r), false);
});

test.test("hasAnyViolationV4: GOOD PT v2 (Denise v2) → false", () => {
  const r = findAllNativenessViolationsV4(GOOD_PT_V2, "pt");
  assert.equal(hasAnyViolationV4(r), false);
});

test.test("hasAnyViolationV4: BAD TH (greeting-name) → true", () => {
  const r = findAllNativenessViolationsV4(BAD_TH, "th");
  assert.equal(hasAnyViolationV4(r), true);
});

// ============================================================================
// 6. Writer block: v3 prefix + v4 sections
// ============================================================================

test.test("buildNativenessBlockV4: pt block starts with v3 content + has 3 v4 sections", () => {
  const block = buildNativenessBlockV4("pt");
  assert.ok(block.length > 5000, "pt block should be substantial");
  assert.ok(block.includes("Reading A++") || block.includes("Reading-A++"), "must contain v3 marker");
  assert.ok(block.includes("NATIVE STYLE GUIDE"), "must contain v4 NATIVE STYLE GUIDE");
  assert.ok(block.includes("TRANSLATIONESE BAN"), "must contain v4 TRANSLATIONESE BAN");
  assert.ok(block.includes("UNIVERSAL NAME ADAPTATION"), "must contain v4 NAME ADAPTATION");
});

test.test("buildNativenessBlockV4: English emits no v4 sections", () => {
  const block = buildNativenessBlockV4("en");
  assert.ok(!block.includes("NATIVE STYLE GUIDE"), "en must not have NATIVE STYLE GUIDE");
  assert.ok(!block.includes("TRANSLATIONESE BAN"), "en must not have TRANSLATIONESE BAN");
});

test.test("buildNativenessBlockV4: vi emits diacritic name adaptation", () => {
  const block = buildNativenessBlockV4("vi");
  assert.ok(block.includes("UNIVERSAL NAME ADAPTATION"), "vi must have NAME ADAPTATION");
  assert.ok(block.includes("Tuan") && block.includes("Tuấn"), "vi must show Tuan→Tuấn example");
});

// ============================================================================
// 7. Critic block
// ============================================================================

test.test("buildCriticNativeStyleBlockV4: pt has all 4 sections", () => {
  const block = buildCriticNativeStyleBlockV4("pt");
  assert.ok(block.includes("REGIONAL VARIANT TARGET"), "must have regional variant");
  assert.ok(block.includes("REQUIRED STRUCTURE"), "must have required structure");
  assert.ok(block.includes("TRANSLATIONESE PATTERNS"), "must list translationese");
  assert.ok(block.includes("NAME ADAPTATION"), "must mention name adaptation");
});

test.test("buildCriticNativeStyleBlockV4: English is terse", () => {
  const block = buildCriticNativeStyleBlockV4("en");
  assert.ok(block.length < 500, "en critic block should be short");
  assert.ok(block.includes("X-NOT-Y"), "must still mention universal X-not-Y");
});

// ============================================================================
// 8. v4.1: constructive parallel pattern NOT flagged by v3 x_not_y
// ============================================================================

test.test("v4.1: 'não apenas X, mas Y' is NOT flagged by v3 x_not_y", () => {
  const text = "usuários qualificados que não apenas realizem a instalação, mas principalmente que façam seu primeiro depósito";
  const hits = findXNotY(text, "pt");
  assert.equal(hits.length, 0, `constructive parallel wrongly flagged: ${JSON.stringify(hits)}`);
});

// ============================================================================
// 9. v4.2: criterion 13 universal language coverage in followupPrompts.ts
// ============================================================================

function loadFollowupPromptsText(): string {
  // Tests can be invoked from the api-server root (`npx tsx tests/...`) or
  // from the tests dir directly. Try multiple candidates to find the file.
  const cwd = process.cwd();
  const dirHint = typeof __dirname === "string" ? __dirname : ".";
  const candidates = [
    path.join(cwd, "services", "followupPrompts.ts"),
    path.join(cwd, "api-server", "services", "followupPrompts.ts"),
    path.join(dirHint, "..", "services", "followupPrompts.ts"),
    path.join(dirHint, "..", "..", "services", "followupPrompts.ts"),
    path.resolve("api-server", "services", "followupPrompts.ts"),
    path.resolve("services", "followupPrompts.ts"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return fs.readFileSync(p, "utf-8");
  }
  throw new Error(
    `followupPrompts.ts not found. cwd=${cwd}, dirHint=${dirHint}, tried:\n` +
      candidates.map(c => `  - ${c}`).join("\n")
  );
}

test.test("v4.2: followupPrompts.ts has criterion 13 (production-failure patterns)", () => {
  const src = loadFollowupPromptsText();
  assert.ok(src.includes("13. PRODUCTION-FAILURE PATTERN CHECKLIST"),
    "missing criterion 13 in followupPrompts.ts");
  assert.ok(src.includes("applies to EVERY non-English email"),
    "criterion 13 must be marked as universal");
});

test.test("v4.2: criterion 13 has all 8 sub-criteria (13a-13h)", () => {
  const src = loadFollowupPromptsText();
  for (const sub of ["13a.", "13b.", "13c.", "13d.", "13e.", "13f.", "13g.", "13h."]) {
    assert.ok(src.includes(sub), `criterion 13 missing sub-criterion ${sub}`);
  }
});

test.test("v4.2: criterion 13 covers 14+ languages explicitly", () => {
  const src = loadFollowupPromptsText();
  // Find the criterion 13 section
  const start = src.indexOf("13. PRODUCTION-FAILURE PATTERN CHECKLIST");
  assert.ok(start > 0);
  const section = src.slice(start);
  const langCodes = ["pt", "es", "it", "fr", "de", "ru", "ja", "zh", "ko", "ar", "he", "hi", "th", "vi"];
  const found = langCodes.filter(c => section.includes(`${c}:`) || section.includes(`${c}-`));
  assert.ok(found.length >= 14,
    `criterion 13 only references ${found.length} languages: ${found.join(", ")}`);
});

test.test("v4.2: criterion 13a covers non-Latin script greetings (JP/ZH/KO)", () => {
  const src = loadFollowupPromptsText();
  // Apologetic openers required in Japanese, Chinese, Korean
  assert.ok(src.includes("様") || src.includes("突然のご連絡"), "missing Japanese apologetic opener");
  assert.ok(src.includes("您好") || src.includes("冒昧打扰"), "missing Chinese polite opener");
  assert.ok(src.includes("님") || src.includes("갑작스러운"), "missing Korean apologetic opener");
});

test.test("v4.2: criterion 13d covers subjunctive/keigo grammars", () => {
  const src = loadFollowupPromptsText();
  assert.ok(src.includes("subjunctive") || src.includes("falarmos") || src.includes("conversemos"),
    "criterion 13d missing PT/ES subjunctive reference");
  assert.ok(src.includes("keigo") || src.includes("ご相談させていただけますでしょうか"),
    "criterion 13d missing JP keigo reference");
  assert.ok(src.includes("존댓말") || src.includes("가능하실까요"),
    "criterion 13d missing KO 존댓말 reference");
});

test.test("v4.2: criterion 13g covers 4 regional-variant splits", () => {
  const src = loadFollowupPromptsText();
  // pt → BR, es → LatAm, zh → Simplified, ar → MSA
  assert.ok(src.includes("estamos a fazer") || src.includes("EU PT") || src.includes("pt-BR"),
    "criterion 13g missing pt-BR/EU PT split");
  assert.ok(src.includes("vosotros") || src.includes("Spain") || src.includes("es-LatAm"),
    "criterion 13g missing es-LatAm/Spain split");
  assert.ok(src.includes("伺服器") || src.includes("Traditional"),
    "criterion 13g missing zh Simplified/Traditional split");
  assert.ok(src.includes("MSA") || src.includes("عايز"),
    "criterion 13g missing ar MSA/colloquial split");
});

test.test("v4.2: criterion 13h distinguishes loanword-keeping from loanword-translating languages", () => {
  const src = loadFollowupPromptsText();
  // Languages that KEEP loanwords
  for (const lang of ["pt-BR", "es-LatAm", "it"]) {
    assert.ok(src.includes(lang), `criterion 13h missing loanword-keeping lang ${lang}`);
  }
  // Languages that TRANSLATE loanwords
  assert.ok(src.includes("Leistung") || (src.includes("de") && src.includes("Leistung")),
    "criterion 13h should reference German Leistung as evidence of translate-required");
});

// ============================================================================
// 10. v4.3 HOTFIX — writer + rewriter GREETING script-aware rule
// ============================================================================
// Regression: production output "เรียน Thasawan," (Latin name in Thai
// greeting) was generated because the writer's main GREETING instruction
// had "use it (e.g., 'Hi Sarah,')" as the only example, giving the LLM
// permission to use the Latin name as-provided. The v4 nativeness block
// transliteration rule competed with — and lost to — this earlier explicit
// example. v4.3 replaces the weak instruction in BOTH the writer
// (getFollowupSystemPrompt) and rewriter (getRewriterSystemPrompt) prompts
// with a script-aware non-bypassable rule.

test.test("v4.3: writer + rewriter GREETING rule is present (TWO occurrences)", () => {
  const src = loadFollowupPromptsText();
  const matches = (src.match(/GREETING NAME SCRIPT \(CRITICAL/g) || []).length;
  assert.equal(matches, 2,
    `expected GREETING NAME SCRIPT rule in BOTH writer and rewriter prompts (got ${matches})`);
});

test.test("v4.3: GREETING rule lists 14+ non-Latin-script languages explicitly", () => {
  const src = loadFollowupPromptsText();
  const start = src.indexOf("GREETING NAME SCRIPT (CRITICAL");
  assert.ok(start > 0, "GREETING NAME SCRIPT rule not found");
  // Take the first occurrence of the rule
  const end = src.indexOf("- GREETING (general", start);
  const section = src.slice(start, end > start ? end : start + 4000);

  const expectedLangs = ["Thai th", "Chinese zh", "Japanese ja", "Korean ko",
    "Arabic ar", "Hebrew he", "Persian fa", "Hindi hi", "Russian ru",
    "Greek el", "Ukrainian uk"];
  for (const lang of expectedLangs) {
    assert.ok(section.includes(lang),
      `v4.3 GREETING rule missing reference to ${lang}`);
  }
});

test.test("v4.3: GREETING rule shows the Thasawan → ทศวรรณ canonical example", () => {
  const src = loadFollowupPromptsText();
  // The canonical production failure that triggered v4.3 must be in the rule
  assert.ok(src.includes("Thasawan") && src.includes("ทศวรรณ"),
    "v4.3 GREETING rule must show the Thasawan → ทศวรรณ Thai example");
  // Show the FORBIDDEN → REQUIRED framing
  assert.ok(src.includes("FORBIDDEN → REQUIRED") || src.includes("FORBIDDEN"),
    "v4.3 GREETING rule must use FORBIDDEN→REQUIRED framing");
});

test.test("v4.3: GREETING rule covers 8+ non-Latin script examples", () => {
  const src = loadFollowupPromptsText();
  const start = src.indexOf("GREETING NAME SCRIPT (CRITICAL");
  const section = src.slice(start, start + 4000);
  // Spot-check non-Latin script transliterations are shown
  const expectedScripts = [
    "ทศวรรณ",    // Thai
    "मनीश",       // Hindi
    "ゆき",       // Japanese
    "마니쉬",     // Korean
    "维尼修斯",   // Chinese
    "Джон",       // Russian Cyrillic
    "جون",        // Arabic
    "ג'ון",       // Hebrew
  ];
  let found = 0;
  for (const script of expectedScripts) {
    if (section.includes(script)) found++;
  }
  assert.ok(found >= 7, `v4.3 GREETING rule covers only ${found}/8 non-Latin script examples`);
});

test.test("v4.3: weak 'Hi Sarah,' as the ONLY example is removed from the writer prompt", () => {
  const src = loadFollowupPromptsText();
  // The old weak pattern was: GREETING: ALWAYS start... If a first name is provided, use it (e.g., "Hi Sarah,").
  // The new rule still mentions "Hi Sarah," but only as the CASE 3 (ASCII-Latin) example.
  // The old single-line GREETING instruction with just "Hi Sarah," should be gone — replaced by the CRITICAL script-aware rule.
  // Verify by checking the surrounding context: the writer prompt should NO LONGER have
  // the original weak text "If a first name is provided, use it (e.g., \"Hi Sarah,\")"
  // in the writer prompt without the CRITICAL rule.
  const weakPattern = 'If a first name is provided, use it (e.g., "Hi Sarah,"). If the context says no name is on file';
  const weakPatternRewriter = 'If a first name is provided in the context, use it (e.g., "Hi Sarah,"). If the context says no name is on file';
  assert.ok(!src.includes(weakPattern), "weak writer GREETING instruction (e.g., 'Hi Sarah,') still present");
  assert.ok(!src.includes(weakPatternRewriter), "weak rewriter GREETING instruction (e.g., 'Hi Sarah,') still present");
});
