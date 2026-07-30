/**
 * test-nativeness-v3.ts
 *
 * Test suite for the v3 Reading-A++ language nativeness module
 * (lib/nativenessV3.ts) and the Followuper bindings that delegate to it
 * (lib/languageNativeness.ts forwarders + lib/doctrineLint.ts aggregator).
 *
 * Uses Node's built-in test runner (no jest/vitest dependency). Run with:
 *   pnpm --filter @workspace/api-server exec tsx tests/test-nativeness-v3.ts
 * or after transpiling:
 *   node --test dist/tests/test-nativeness-v3.js
 *
 * Coverage:
 *  1. Data table presence and shape
 *  2. Production fixtures: Amobear VI, Tops TH, Revolut EN, Cars24 EN,
 *     Probooks EN, Thai clean
 *  3. Individual detectors: forbidden_phrases, latin_token_runs,
 *     forbidden_singletons, x_not_y, untransliterated_greeting_name
 *  4. X-not-Y across 8 representative languages
 *  5. Greeting-name detection across 6 non-Latin scripts
 *  6. Forwarder integration via languageNativeness module
 *  7. Doctrine-lint v3 aggregator: ViolationReport shape preserved,
 *     all 5 categories produce structured issues / suggestions / matches
 *  8. Prompt-builder output shape (writer + critic blocks)
 *  9. English-only edge cases: only X-not-Y rule fires
 * 10. Normalize behaviour: language tag handling, empty / unknown tags
 */

import * as test from "node:test";
import * as assert from "node:assert/strict";

import {
  // Data
  FORBIDDEN_ENGLISH_PHRASES,
  FORBIDDEN_ENGLISH_SINGLETONS,
  LATIN_ALLOWLIST,
  BOILERPLATE_LATIN,
  X_NOT_Y_PATTERNS,
  NON_LATIN_SCRIPT_LANGS,
  VIETNAMESE_DIACRITIC_SET,
  // Detectors
  findForbiddenPhrases,
  findLatinTokenRuns,
  findForbiddenSingletons,
  findXNotY,
  findUntransliteratedGreetingName,
  findAllNativenessViolations,
  hasAnyViolation,
  // Prompt
  buildNativenessBlockV3,
  buildCriticNativenessBlockV3,
  normalizeLanguageCode as normalizeV3,
} from "../lib/nativenessV3";

import {
  buildNativenessBlock,
  buildCriticNativenessBlock,
  normalizeLanguageCode,
} from "../lib/languageNativeness";

import {
  detectNativenessViolations,
  detectAllDeterministicViolations,
} from "../lib/doctrineLint";


// ============================================================================
// Section 1: Data tables — presence, shape, content
// ============================================================================

test.test("FORBIDDEN_ENGLISH_PHRASES is non-empty and contains key adtech patterns", () => {
  assert.ok(FORBIDDEN_ENGLISH_PHRASES.length >= 100);
  // Sample patterns must match expected English phrases
  const semi = "semi-exclusive inventory";
  const pre = "pre-bid screening";
  const post = "post-attribution verification";
  const matched = (s: string) => FORBIDDEN_ENGLISH_PHRASES.some(p => p.test(s));
  assert.ok(matched(semi), "semi-exclusive inventory must match");
  assert.ok(matched(pre), "pre-bid screening must match");
  assert.ok(matched(post), "post-attribution verification must match");
});

test.test("FORBIDDEN_ENGLISH_SINGLETONS contains key English content words", () => {
  for (const w of ["cohort", "install", "conversion", "retention", "lookalike",
                   "audience", "publisher", "creative", "attribution",
                   "optimization", "anomaly", "filtering", "performance",
                   "premium", "exclusive", "durable", "deliver"]) {
    assert.ok(FORBIDDEN_ENGLISH_SINGLETONS.has(w), `${w} must be in blacklist`);
  }
  assert.ok(FORBIDDEN_ENGLISH_SINGLETONS.size >= 300);
});

test.test("LATIN_ALLOWLIST contains every required acronym + proper noun", () => {
  for (const a of ["CPI", "CPA", "ROAS", "LTV", "MMP", "SDK", "IAP", "DSP",
                   "KPI", "KYC", "AI", "ML", "D7", "D30", "iOS",
                   "MobUpps", "AppsFlyer", "Adjust", "Meta", "Google",
                   "Xiaomi", "OPPO", "TikTok", "USD", "EUR"]) {
    assert.ok(LATIN_ALLOWLIST.has(a), `${a} must be in allowlist`);
  }
  // Lowercase variants must NOT be in allowlist (case-sensitive by design)
  assert.ok(!LATIN_ALLOWLIST.has("cpi"));
  assert.ok(!LATIN_ALLOWLIST.has("roas"));
});

test.test("BOILERPLATE_LATIN holds URL/protocol scaffolding tokens", () => {
  for (const t of ["http", "https", "www", "com", "co", "io"]) {
    assert.ok(BOILERPLATE_LATIN.has(t));
  }
});

test.test("X_NOT_Y_PATTERNS covers all 36 supported languages", () => {
  const expected = ["en", "es", "pt", "it", "fr", "de", "ru", "uk", "pl", "cs",
                    "ro", "tr", "nl", "sv", "no", "nb", "da", "fi", "hu", "el",
                    "ja", "zh", "ko", "ar", "he", "fa", "hi", "bn", "ur", "th",
                    "vi", "id", "ms", "fil", "tl", "sw"];
  for (const lang of expected) {
    assert.ok(X_NOT_Y_PATTERNS[lang], `X_NOT_Y_PATTERNS missing ${lang}`);
    assert.ok(X_NOT_Y_PATTERNS[lang].length > 0);
  }
});

test.test("NON_LATIN_SCRIPT_LANGS covers all expected non-Latin codes", () => {
  for (const lang of ["ru", "zh", "ja", "ko", "ar", "he", "fa", "ur", "hi",
                      "bn", "th", "el", "uk", "am", "ka", "hy"]) {
    assert.ok(NON_LATIN_SCRIPT_LANGS.has(lang), `${lang} expected in non-Latin set`);
  }
  // Latin-script languages must NOT be there
  for (const lang of ["en", "es", "de", "fr", "vi", "id", "tr", "pl"]) {
    assert.ok(!NON_LATIN_SCRIPT_LANGS.has(lang), `${lang} should not be in non-Latin set`);
  }
});

test.test("VIETNAMESE_DIACRITIC_SET holds Vietnamese-specific characters", () => {
  for (const ch of ["ạ", "ấ", "ế", "ố", "ổ", "ử", "ỳ"]) {
    assert.ok(VIETNAMESE_DIACRITIC_SET.has(ch), `${ch} expected in VN set`);
  }
});


// ============================================================================
// Section 2: Production fixtures (mirror the Prospector audit)
// ============================================================================

const AMOBEAR_VI = `Kính gửi anh/chị Tuan,

Amobear Game Studio đã đưa Gangster City vượt 50M lượt tải, trong khi VNG và Falcon Game Studio đang dịch chuyển ngân sách UA sang payer-optimized cohort buying thay vì mua lượt cài đặt diện rộng.

Với portfolio game crime/action tại Việt Nam, team chúng tôi thường deliver 300+ lượt chuyển đổi thành người dùng trả phí mỗi ngày. Khác với cách OneSoft mở rộng trên inventory công khai, chúng tôi vận hành trên semi-exclusive inventory không chia sẻ với các studio crime/action cạnh tranh trong cùng placement, kết hợp multi-layer fraud filtering từ pre-bid screening, post-attribution verification đến cohort-level anomaly detection.`;

const TOPS_TH = `เรียน Songsitt,

แอปซูเปอร์มาร์เก็ตและเดลิเวอรี่ชั้นนำในไทยอย่าง Lotus's และ foodpanda กำลังปรับการทำ UA ผ่าน semi-exclusive publisher inventory ที่เราไม่ได้แชร์กับ LINE MAN Mart และ Grab Mart ในตำแหน่งโฆษณาที่ทับซ้อนกัน พร้อม anti-fraud filtering ครบทุกชั้น ทั้ง pre-bid screening, post-attribution validation และ cohort-level anomaly detection`;

const REVOLUT_EN = `Hi Jasson,

Revolut sits in the UK's most contested mobile funding race, where Monzo and Starling are buying the install-to-deposit journey through referral overlays and performance partners, not raw installs. The binding constraint is mid-funnel economics.`;

const CARS24_EN = `Hi Manish,

Cars24 is bidding against Spinny and CarDekho for the same Tier-1 and Tier-2 auction inventory across Google, Meta, and programmatic auto, and peers are shifting spend toward intent-rich placements to ease CPA pressure on verified seller flows rather than raw installs.`;

const PROBOOKS_EN = `Hi Brian,

Probooks competes for SMB attention against FreshBooks, Wave, QuickBooks and Xero. The way that we work is CPA pegged to your paid-plan activation event, with quality gates on trial activation. Could we look at your current trial-to-paid conversion baseline together?`;

const THAI_CLEAN = `เรียน ทรงสิทธิ์,

แอปซูเปอร์มาร์เก็ตและเดลิเวอรี่ชั้นนำในไทยอย่าง Lotus's และ foodpanda กำลังปรับการทำ UA บนมือถือ จากประสบการณ์ทำงานกับ King Power Online เราเห็นว่าการใช้ ROAS เป็นตัวชี้วัดหลักช่วยเพิ่มการคงผู้ใช้ได้`;


test.test("fixture: Amobear VI trips forbidden_phrases + forbidden_singletons", () => {
  const r = findAllNativenessViolations(AMOBEAR_VI, "vi");
  assert.ok(hasAnyViolation(r));
  assert.ok(r.forbidden_phrases.length >= 5,
            `expected ≥5 forbidden phrases, got ${r.forbidden_phrases.length}`);
  assert.ok(r.forbidden_singletons.length >= 5,
            `expected ≥5 forbidden singletons, got ${r.forbidden_singletons.length}`);
  const joined = r.forbidden_phrases.join(" | ").toLowerCase();
  assert.match(joined, /semi-exclusive inventory/);
  assert.match(joined, /pre-bid screening/);
  assert.match(joined, /post-attribution verification/);
  assert.match(joined, /cohort-level anomaly detection/);
});

test.test("fixture: Tops TH trips all four major non-Latin categories", () => {
  const r = findAllNativenessViolations(TOPS_TH, "th");
  assert.ok(hasAnyViolation(r));
  assert.ok(r.forbidden_phrases.length > 0);
  assert.ok(r.latin_token_runs.length > 0,
            "Latin-token runs must fire for Latin chunks in Thai prose");
  assert.ok(r.forbidden_singletons.length > 0);
  assert.deepEqual(r.untransliterated_greeting_name, ["Songsitt"]);
});

test.test("fixture: Revolut EN trips ONLY x_not_y", () => {
  const r = findAllNativenessViolations(REVOLUT_EN, "en");
  assert.equal(r.forbidden_phrases.length, 0);
  assert.equal(r.latin_token_runs.length, 0);
  assert.equal(r.forbidden_singletons.length, 0);
  assert.equal(r.untransliterated_greeting_name.length, 0);
  assert.ok(r.x_not_y.length > 0);
  assert.match(r.x_not_y[0]!, /not raw installs/);
});

test.test("fixture: Cars24 EN produces no violations (uses 'rather than')", () => {
  const r = findAllNativenessViolations(CARS24_EN, "en");
  assert.equal(hasAnyViolation(r), false);
});

test.test("fixture: Probooks EN produces no violations", () => {
  const r = findAllNativenessViolations(PROBOOKS_EN, "en");
  assert.equal(hasAnyViolation(r), false);
});

test.test("fixture: Thai clean fully localized — no violations", () => {
  const r = findAllNativenessViolations(THAI_CLEAN, "th");
  assert.equal(hasAnyViolation(r), false);
});


// ============================================================================
// Section 3: Individual detectors
// ============================================================================

test.test("findForbiddenPhrases: no-op for English", () => {
  const r = findForbiddenPhrases("semi-exclusive inventory and pre-bid screening", "en");
  assert.deepEqual(r, []);
});

test.test("findForbiddenPhrases: catches base phrases for non-English", () => {
  const r = findForbiddenPhrases("Use pre-bid screening + anomaly detection", "ru");
  assert.ok(r.includes("pre-bid screening") || r.some(s => s.toLowerCase().includes("pre-bid")));
  assert.ok(r.some(s => s.toLowerCase().includes("anomaly detection")));
});

test.test("findLatinTokenRuns: only fires for non-Latin scripts", () => {
  // Vietnamese is Latin-script — should NOT fire even with multi-word runs
  const r1 = findLatinTokenRuns("Hello world cohort install", "vi");
  assert.deepEqual(r1, []);
  // Thai with embedded Latin phrase — should fire
  const para = "การใช้ pre-bid screening และ anomaly detection ในระบบนี้";
  const r2 = findLatinTokenRuns(para, "th");
  assert.ok(r2.length > 0, "must detect Latin runs in Thai prose");
});

test.test("findLatinTokenRuns: allowlist-only runs are spared", () => {
  const para = "เราใช้ ROAS LTV CPI ในระบบ"; // 3 allowlisted acronyms
  const r = findLatinTokenRuns(para, "th");
  // After stripping allowlist nothing remains — must be empty
  assert.deepEqual(r, []);
});

test.test("findLatinTokenRuns: proper-noun runs are spared", () => {
  const para = "เราทำงานร่วมกับ King Power Online และทีมงาน Lotus Express";
  const r = findLatinTokenRuns(para, "th");
  // King Power Online and Lotus Express are proper-noun runs (all capitalized) — must be skipped
  assert.deepEqual(r, []);
});

test.test("findForbiddenSingletons: only fires for non-English", () => {
  assert.deepEqual(findForbiddenSingletons("install conversion retention", "en"), []);
});

test.test("findForbiddenSingletons: Latin-script targets check the body globally", () => {
  // German (Latin script) — singletons fire on body regardless of script density
  const body = "Wir haben eine starke install rate erreicht.";
  const r = findForbiddenSingletons(body, "de");
  assert.ok(r.some(s => s.toLowerCase() === "install"),
            "install must be detected in German body");
});

test.test("findForbiddenSingletons: non-Latin targets confirm token appears in target script", () => {
  // English-only paragraph in a Thai-tagged email — singletons should NOT fire
  // because the offending tokens don't appear in target-script paragraphs.
  const body = "This is fully English text with install and conversion words.";
  const r = findForbiddenSingletons(body, "th");
  assert.deepEqual(r, []);
});

test.test("findXNotY: detects English comma-not pattern", () => {
  const r = findXNotY("performance partners, not raw installs", "en");
  assert.ok(r.length > 0);
});

test.test("findXNotY: detects German nicht pattern", () => {
  const r = findXNotY("Performance-Partner, nicht reine Installationen", "de");
  assert.ok(r.length > 0);
});

test.test("findXNotY: detects Russian не pattern", () => {
  const r = findXNotY("партнёры по результату, а не сырые установки", "ru");
  assert.ok(r.length > 0);
});

test.test("findXNotY: detects Thai ไม่ใช่ pattern", () => {
  const r = findXNotY("พันธมิตรด้านผลลัพธ์, ไม่ใช่การติดตั้งดิบ", "th");
  assert.ok(r.length > 0);
});

test.test("findUntransliteratedGreetingName: only fires for non-Latin scripts", () => {
  // English target — no firing
  assert.deepEqual(findUntransliteratedGreetingName("Hi John,\n\nBody", "en"), []);
  // German (Latin) — no firing
  assert.deepEqual(findUntransliteratedGreetingName("Hallo John,\n\nKörper", "de"), []);
  // Thai with Latin name — fires
  const r = findUntransliteratedGreetingName("เรียน Songsitt,\n\nเนื้อหา", "th");
  assert.deepEqual(r, ["Songsitt"]);
});

test.test("findUntransliteratedGreetingName: pure-script greeting passes clean", () => {
  assert.deepEqual(findUntransliteratedGreetingName("เรียน ทรงสิทธิ์,\n\nเนื้อหา", "th"), []);
});

test.test("findUntransliteratedGreetingName: greeting acronyms are spared", () => {
  // KYC team mentioned in Thai greeting line — acronym in allowlist
  const r = findUntransliteratedGreetingName("เรียน ทีม KYC,\n\nเนื้อหา", "th");
  assert.deepEqual(r, []);
});


// ============================================================================
// Section 4: X-not-Y across many languages
// ============================================================================

const X_NOT_Y_FIXTURES: Array<[string, string]> = [
  ["en", "performance partners, not raw installs"],
  ["es", "socios de rendimiento, no instalaciones puras"],
  ["pt", "parceiros de desempenho, não instalações puras"],
  ["fr", "partenaires de performance, pas d'installations brutes"],
  ["de", "Performance-Partner, nicht reine Installationen"],
  ["pl", "partnerzy wynikowi, nie surowe instalacje"],
  ["nl", "performance-partners, niet ruwe installaties"],
  ["ru", "партнёры по результату, а не сырые установки"],
];

for (const [lang, sample] of X_NOT_Y_FIXTURES) {
  test.test(`X-not-Y detection: language=${lang}`, () => {
    const hits = findXNotY(sample, lang);
    assert.ok(hits.length > 0, `expected X-not-Y hit for ${lang}: ${sample}`);
  });
}


// ============================================================================
// Section 5: Greeting-name detection across non-Latin scripts
// ============================================================================

const GREETING_FIXTURES: Array<[string, string, string]> = [
  ["th", "เรียน Songsitt,\n\nเนื้อหา", "Songsitt"],
  ["hi", "नमस्ते Manish,\n\nसामग्री", "Manish"],
  ["zh", "你好 Wang,\n\n内容", "Wang"],
  ["ja", "こんにちは Yuki,\n\n本文", "Yuki"],
  ["ko", "안녕하세요 Park,\n\n본문", "Park"],
  ["ar", "مرحبًا Ahmed,\n\nالنص", "Ahmed"],
  ["he", "שלום David,\n\nגוף", "David"],
  ["ru", "Здравствуйте Ivan,\n\nТекст", "Ivan"],
];

for (const [lang, body, expected] of GREETING_FIXTURES) {
  test.test(`untransliterated greeting name: lang=${lang}, name=${expected}`, () => {
    const r = findUntransliteratedGreetingName(body, lang);
    assert.ok(r.includes(expected),
              `expected to find ${expected} in greeting for ${lang}, got ${JSON.stringify(r)}`);
  });
}


// ============================================================================
// Section 6: Forwarder integration via languageNativeness
// ============================================================================

test.test("buildNativenessBlock forwards to v3 for non-English", () => {
  // v4: wrapper now returns v3 content + v4 sections (NATIVE STYLE
  // GUIDE, TRANSLATIONESE BAN, UNIVERSAL NAME ADAPTATION) appended.
  // The v3 content must remain the prefix; the v4 sections are added
  // after.
  const directV3 = buildNativenessBlockV3("ru");
  const viaWrapper = buildNativenessBlock("ru");
  assert.ok(viaWrapper.startsWith(directV3),
    "v4 wrapper must begin with full v3 block verbatim");
  assert.ok(viaWrapper.includes("Reading A++"));
  assert.ok(viaWrapper.includes("NATIVE STYLE GUIDE"),
    "v4 wrapper must include NATIVE STYLE GUIDE section");
});

test.test("buildNativenessBlock returns universal block for English", () => {
  const r = buildNativenessBlock("en");
  // v3: English gets the universal X-not-Y rule, not empty string
  assert.ok(r.includes("X-NOT-Y") || r.includes("WRITING STYLE"),
            "English block must mention X-not-Y");
});

test.test("buildCriticNativenessBlock forwards to v3 for non-English", () => {
  // v4: wrapper now concatenates v3 critic block (Reading-A++) with v4
  // critic block (native style + translationese + name adaptation).
  const directV3 = buildCriticNativenessBlockV3("th");
  const viaWrapper = buildCriticNativenessBlock("th");
  assert.ok(viaWrapper.startsWith(directV3),
    "v4 critic wrapper must begin with full v3 critic block verbatim");
  assert.ok(viaWrapper.includes("Reading A++") || viaWrapper.includes("v3 Reading"));
  assert.ok(viaWrapper.includes("v4 NATIVE STYLE") ||
            viaWrapper.includes("TRANSLATIONESE PATTERNS"),
    "v4 critic wrapper must include v4 sections");
});

test.test("buildCriticNativenessBlock returns universal style block for English", () => {
  const r = buildCriticNativenessBlock("en");
  assert.ok(r.includes("X-NOT-Y") || r.includes("comma-negation"));
});

test.test("normalizeLanguageCode in nativenessV3 matches languageNativeness", () => {
  for (const tag of ["en", "EN_US", "ru-RU", "zh-Hans", "nb-NO", "", "x"]) {
    assert.equal(normalizeV3(tag), normalizeLanguageCode(tag),
                 `mismatch for tag ${tag}`);
  }
});


// ============================================================================
// Section 7: doctrineLint v3 aggregator — ViolationReport contract preserved
// ============================================================================

test.test("detectNativenessViolations returns ViolationReport shape", () => {
  const r = detectNativenessViolations(AMOBEAR_VI, "vi");
  assert.equal(typeof r.found, "boolean");
  assert.ok(Array.isArray(r.issues));
  assert.ok(Array.isArray(r.suggestions));
  assert.ok(Array.isArray(r.matches));
});

test.test("detectNativenessViolations finds matches for Amobear VI", () => {
  const r = detectNativenessViolations(AMOBEAR_VI, "vi");
  assert.equal(r.found, true);
  assert.ok(r.issues.length > 0);
  assert.ok(r.suggestions.length > 0);
  assert.ok(r.matches.length > 0);
});

test.test("detectNativenessViolations: Tops TH issues are category-tagged", () => {
  const r = detectNativenessViolations(TOPS_TH, "th");
  const allIssues = r.issues.join(" | ");
  assert.match(allIssues, /FORBIDDEN-ENGLISH-PHRASE/);
  assert.match(allIssues, /LATIN-TOKEN-RUN/);
  assert.match(allIssues, /FORBIDDEN-ENGLISH-SINGLETON/);
  assert.match(allIssues, /UNTRANSLITERATED-GREETING-NAME/);
});

test.test("detectNativenessViolations: clean Thai produces empty report", () => {
  const r = detectNativenessViolations(THAI_CLEAN, "th");
  assert.equal(r.found, false);
  assert.equal(r.issues.length, 0);
});

test.test("detectNativenessViolations: Revolut EN catches X-not-Y", () => {
  const r = detectNativenessViolations(REVOLUT_EN, "en");
  assert.equal(r.found, true);
  assert.match(r.issues.join(" | "), /X-NOT-Y/);
});

test.test("detectNativenessViolations: clean English produces empty report", () => {
  const r = detectNativenessViolations(CARS24_EN, "en");
  assert.equal(r.found, false);
});

test.test("detectAllDeterministicViolations merges doctrine + nativeness", () => {
  // Should be at least the nativeness report for AMOBEAR_VI
  const r = detectAllDeterministicViolations(AMOBEAR_VI, "vi");
  assert.equal(r.found, true);
  assert.ok(r.issues.length > 0);
});


// ============================================================================
// Section 8: Prompt builder output shape
// ============================================================================

test.test("buildNativenessBlockV3: English includes only X-not-Y rule", () => {
  const en = buildNativenessBlockV3("en");
  assert.ok(en.length > 0);
  assert.ok(en.includes("X-NOT-Y"));
  // Should NOT include the per-language translation table apparatus
  assert.ok(!en.includes("TRANSLATION REFERENCE"));
});

test.test("buildNativenessBlockV3: non-English includes full Reading-A++ block", () => {
  const ru = buildNativenessBlockV3("ru");
  assert.ok(ru.includes("Reading A++"));
  assert.ok(ru.includes("STRICT LOCALIZATION POLICY"));
  assert.ok(ru.includes("TRANSLATION REFERENCE"));
  assert.ok(ru.includes("X-NOT-Y"));
  assert.ok(ru.includes("SCRIPT-MIXING IS FORBIDDEN"),
            "Russian (non-Latin) must have script-mixing block");
  assert.ok(ru.includes("GREETING-NAME TRANSLITERATION"),
            "Russian (non-Latin) must have name-transliteration block");
});

test.test("buildNativenessBlockV3: Latin-script non-English (vi) omits script blocks", () => {
  const vi = buildNativenessBlockV3("vi");
  assert.ok(vi.includes("Reading A++"));
  assert.ok(vi.includes("TRANSLATION REFERENCE"));
  // Vietnamese is Latin-script — must NOT include the script-mixing block
  assert.ok(!vi.includes("SCRIPT-MIXING IS FORBIDDEN"));
  // Must NOT include greeting-name transliteration block
  assert.ok(!vi.includes("GREETING-NAME TRANSLITERATION"));
});

test.test("buildNativenessBlockV3: unknown language emits universal rule with note", () => {
  const xx = buildNativenessBlockV3("xx");
  // For an unknown lang, the v3 block still renders the universal rule
  // because normalizeLanguageCode returns "" for unknown tags and the
  // function then treats it as English (returns universal block).
  assert.ok(xx.length > 0);
});

test.test("buildCriticNativenessBlockV3: structure mirrors writer block but condensed", () => {
  const r = buildCriticNativenessBlockV3("zh");
  assert.ok(r.includes("Reading A++"));
  assert.ok(r.includes("SCRIPT-MIXING"));
  assert.ok(r.includes("GREETING-NAME TRANSLITERATION"));
  assert.ok(r.includes("X-NOT-Y"));
});


// ============================================================================
// Section 9: English edge cases
// ============================================================================

test.test("English fully-clean email passes findAll cleanly", () => {
  const body = "Hi John,\n\nFollowing up on my note about Q4 partnerships. Worth a quick call rather than another email thread?";
  const r = findAllNativenessViolations(body, "en");
  assert.equal(hasAnyViolation(r), false);
});

test.test("English ONLY x-not-y triggers — other categories silent for en", () => {
  const body = "We sell performance, not installs.";
  const r = findAllNativenessViolations(body, "en");
  assert.equal(r.forbidden_phrases.length, 0);
  assert.equal(r.latin_token_runs.length, 0);
  assert.equal(r.forbidden_singletons.length, 0,
               "English singletons should never fire for English target");
  assert.equal(r.untransliterated_greeting_name.length, 0,
               "English target should not fire greeting-name");
  assert.ok(r.x_not_y.length > 0);
});


// ============================================================================
// Section 10: Language-tag normalization
// ============================================================================

test.test("normalizeLanguageCode handles BCP47 variants", () => {
  assert.equal(normalizeV3("en"), "en");
  assert.equal(normalizeV3("EN"), "en");
  assert.equal(normalizeV3("en-US"), "en");
  assert.equal(normalizeV3("en_US"), "en");
  assert.equal(normalizeV3("zh-Hans"), "zh");
  assert.equal(normalizeV3("nb-NO"), "nb");
  assert.equal(normalizeV3(""), "");
  assert.equal(normalizeV3(null), "");
  assert.equal(normalizeV3(undefined), "");
  assert.equal(normalizeV3("x"), "");          // too short
  assert.equal(normalizeV3("abcd"), "");        // too long
  assert.equal(normalizeV3("  ru  "), "ru");    // whitespace tolerated
});

test.test("detectors handle null / empty bodies without crashing", () => {
  assert.deepEqual(findAllNativenessViolations("", "en"), {
    forbidden_phrases: [],
    latin_token_runs: [],
    forbidden_singletons: [],
    x_not_y: [],
    untransliterated_greeting_name: [],
  });
});

test.test("detectors handle unknown language tag gracefully", () => {
  // Unknown but well-formed tag (e.g. "xx") passes the 2-3 letter format
  // check and is treated as a non-English target. The detector fires on
  // English content words, which is the correct conservative default —
  // an unknown non-English tag is presumed to need translation.
  const r = findAllNativenessViolations("install cohort retention", "xx");
  assert.ok(r.forbidden_singletons.length > 0,
            "unknown non-English tag should still fire English singletons");
});

test.test("detectors return empty for malformed language tag", () => {
  // Malformed tag (e.g. "x", "abcd") normalizes to "" and detectors no-op.
  const r = findAllNativenessViolations("install cohort retention", "x");
  assert.equal(r.forbidden_singletons.length, 0,
               "malformed tag normalizes to empty and disables detectors");
});
