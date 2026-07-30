/**
 * test-doctrine-hardening.ts
 *
 * Self-contained test suite for the Followuper doctrine-hardening + language
 * nativeness lint helpers. Uses Node's built-in test runner (no jest/vitest
 * dependency). Run with: `node --test tests/test-doctrine-hardening.ts` after
 * compiling with tsc.
 *
 * For environments without ts-node, the typical Replit pattern is:
 *   pnpm --filter @workspace/api-server exec tsx tests/test-doctrine-hardening.ts
 * or simply transpile then run.
 *
 * Coverage:
 *  1. The real Thai email from the production failure trips ONLY on
 *     "quality user acquisition" (not on per-guide-allowed singletons,
 *     not on proper nouns).
 *  2. A clean, properly-translated Thai body produces zero violations.
 *  3. An English clean body produces zero violations (Latin script = no-op).
 *  4. The VI body trips all four doctrine checks at once.
 *  5. The Probooks-style body produces zero doctrine violations and DOES
 *     have an approved differentiator anchor.
 *  6. Spanish, Russian, German, Vietnamese hedge + hype patterns work.
 *  7. The 36-language data tables are all present and non-empty.
 *  8. Module shape: required exports are present and well-typed.
 */

import * as test from "node:test";
import * as assert from "node:assert/strict";

import {
  detectDoctrineViolations,
  detectNativenessViolations,
  detectAllDeterministicViolations,
} from "../lib/doctrineLint";

import {
  MANDATED_HOW_OPENERS,
  HEDGE_PATTERNS,
  HYPE_ADJECTIVES,
  APPROVED_DIFFERENTIATOR_ANCHORS,
  FORBIDDEN_DIFFERENTIATOR_PATTERNS,
  MULTI_EVENT_PATTERNS,
  findHedgesInBody,
  findHypeAdjectivesInBody,
  findForbiddenDiffPatterns,
  findMultiEventPatterns,
  hasApprovedDifferentiatorAnchor,
} from "../lib/doctrineRules";

// =============================================================================
// Fixtures
// =============================================================================

/** Verbatim Thai follow-up body from the production failure screenshot. */
const THAI_REAL = `\u0e2a\u0e27\u0e31\u0e2a\u0e14\u0e35\u0e04\u0e23\u0e31\u0e1a

\u0e15\u0e34\u0e14\u0e15\u0e32\u0e21\u0e08\u0e32\u0e01 email \u0e17\u0e35\u0e48\u0e2a\u0e48\u0e07\u0e44\u0e1b\u0e01\u0e48\u0e2d\u0e19\u0e2b\u0e19\u0e49\u0e32\u0e19\u0e35\u0e49\u0e40\u0e23\u0e37\u0e48\u0e2d\u0e07 quality user acquisition \u0e2a\u0e33\u0e2b\u0e23\u0e31\u0e1a Central App \u0e04\u0e23\u0e31\u0e1a

\u0e2d\u0e22\u0e32\u0e01\u0e41\u0e0a\u0e23\u0e4c\u0e2d\u0e35\u0e01\u0e21\u0e38\u0e21\u0e2b\u0e19\u0e36\u0e48\u0e07\u0e17\u0e35\u0e48\u0e2d\u0e32\u0e08\u0e19\u0e48\u0e32\u0e2a\u0e19\u0e43\u0e08 \u0e0a\u0e48\u0e27\u0e07\u0e19\u0e35\u0e49\u0e40\u0e2b\u0e47\u0e19\u0e27\u0e48\u0e32\u0e2b\u0e25\u0e32\u0e22\u0e41\u0e2d\u0e1b\u0e04\u0e49\u0e32\u0e1b\u0e25\u0e35\u0e01\u0e43\u0e19\u0e44\u0e17\u0e22\u0e01\u0e33\u0e25\u0e31\u0e07\u0e40\u0e1e\u0e34\u0e48\u0e21\u0e07\u0e1a UA \u0e2a\u0e33\u0e2b\u0e23\u0e31\u0e1a\u0e0a\u0e48\u0e27\u0e07 Brand Day \u0e41\u0e25\u0e30 Super Brand Day \u0e25\u0e48\u0e27\u0e07\u0e2b\u0e19\u0e49\u0e32\u0e21\u0e32\u0e01\u0e02\u0e36\u0e49\u0e19 \u0e40\u0e1e\u0e23\u0e32\u0e30 cohort \u0e17\u0e35\u0e48 acquire \u0e44\u0e27\u0e49\u0e01\u0e48\u0e2d\u0e19\u0e0a\u0e48\u0e27\u0e07 event \u0e21\u0e31\u0e01 convert \u0e41\u0e25\u0e30\u0e21\u0e35 LTV \u0e2a\u0e39\u0e07\u0e01\u0e27\u0e48\u0e32 cohort \u0e17\u0e35\u0e48 acquire \u0e23\u0e30\u0e2b\u0e27\u0e48\u0e32\u0e07 event \u0e08\u0e23\u0e34\u0e07\u0e46 \u0e08\u0e32\u0e01\u0e1b\u0e23\u0e30\u0e2a\u0e1a\u0e01\u0e32\u0e23\u0e13\u0e4c\u0e17\u0e35\u0e48\u0e17\u0e33\u0e01\u0e31\u0e1a King Power Online \u0e41\u0e25\u0e30 Watsons Thailand \u0e40\u0e23\u0e32\u0e40\u0e2b\u0e47\u0e19\u0e15\u0e31\u0e27\u0e40\u0e25\u0e02\u0e0a\u0e31\u0e14\u0e40\u0e08\u0e19\u0e43\u0e19\u0e2a\u0e48\u0e27\u0e19\u0e19\u0e35\u0e49

\u0e2b\u0e32\u0e01\u0e17\u0e35\u0e21\u0e01\u0e33\u0e25\u0e31\u0e07\u0e27\u0e32\u0e07\u0e41\u0e1c\u0e19 campaign \u0e2a\u0e33\u0e2b\u0e23\u0e31\u0e1a\u0e0a\u0e48\u0e27\u0e07\u0e1b\u0e25\u0e32\u0e22\u0e1b\u0e35 \u0e2d\u0e32\u0e08\u0e08\u0e30\u0e40\u0e1b\u0e47\u0e19\u0e08\u0e31\u0e07\u0e2b\u0e27\u0e30\u0e17\u0e35\u0e48\u0e14\u0e35\u0e17\u0e35\u0e48\u0e08\u0e30\u0e04\u0e38\u0e22\u0e01\u0e31\u0e19\u0e2a\u0e31\u0e49\u0e19\u0e46 \u0e01\u0e48\u0e2d\u0e19\u0e04\u0e23\u0e31\u0e1a`;

/** Clean rewritten Thai (no Latin-leak violations). */
const THAI_CLEAN = `\u0e2a\u0e27\u0e31\u0e2a\u0e14\u0e35\u0e04\u0e23\u0e31\u0e1a \u0e04\u0e38\u0e13\u0e21\u0e34\u0e40\u0e0a\u0e25

\u0e15\u0e34\u0e14\u0e15\u0e32\u0e21\u0e08\u0e32\u0e01\u0e2d\u0e35\u0e40\u0e21\u0e25\u0e17\u0e35\u0e48\u0e2a\u0e48\u0e07\u0e44\u0e1b\u0e01\u0e48\u0e2d\u0e19\u0e2b\u0e19\u0e49\u0e32\u0e19\u0e35\u0e49\u0e40\u0e23\u0e37\u0e48\u0e2d\u0e07\u0e01\u0e32\u0e23\u0e2b\u0e32\u0e1c\u0e39\u0e49\u0e43\u0e0a\u0e49\u0e04\u0e38\u0e13\u0e20\u0e32\u0e1e\u0e2a\u0e33\u0e2b\u0e23\u0e31\u0e1a\u0e41\u0e2d\u0e1b\u0e02\u0e2d\u0e07\u0e04\u0e38\u0e13

\u0e08\u0e32\u0e01\u0e1b\u0e23\u0e30\u0e2a\u0e1a\u0e01\u0e32\u0e23\u0e13\u0e4c\u0e17\u0e33\u0e07\u0e32\u0e19\u0e01\u0e31\u0e1a King Power Online \u0e41\u0e25\u0e30 Watsons Thailand \u0e40\u0e23\u0e32\u0e40\u0e2b\u0e47\u0e19\u0e27\u0e48\u0e32\u0e01\u0e32\u0e23\u0e43\u0e0a\u0e49 ROAS \u0e40\u0e1b\u0e47\u0e19\u0e15\u0e31\u0e27\u0e0a\u0e35\u0e49\u0e27\u0e31\u0e14\u0e2b\u0e25\u0e31\u0e01\u0e0a\u0e48\u0e27\u0e22\u0e40\u0e1e\u0e34\u0e48\u0e21\u0e01\u0e32\u0e23\u0e04\u0e07\u0e2d\u0e22\u0e39\u0e48\u0e02\u0e2d\u0e07\u0e1c\u0e39\u0e49\u0e43\u0e0a\u0e49\u0e44\u0e14\u0e49`;

/** English clean body \u2014 nativeness check is a no-op for Latin-script targets. */
const EN_CLEAN = `Hi Brian,

Following up on my note about the affiliate stack. CPS payouts only trigger on the paid plan activation event, and we layer quality gates on trial activation, first invoice sent, bank and ledger connection, and 30-day active usage so payouts fire only on durable conversions, not trial tourists.

Quick clarifier: did the renewal cohort question we raised land with your team?

Thanks,
Murat`;

/** The VI body that historically tripped all four doctrine rules. */
const VI_DOCTRINE_BAD = `Hi Lavina,

Vi is actively pushing recharge, bill payment, data pack, and paid service usage through its app in India, and this is exactly where Mobupps has seen strong performance with utility and payment-led apps.

Mobupps is successful with such apps because we optimize toward one clear revenue event: an approved recharge or bill payment completion.

For Indian telecom and utility apps, we can deliver around 250 approved paid events per day.

What is special about Mobupps is that we help utility apps scale only where real paid actions are happening, so Vi pays for approved revenue events rather than installs, signups, or sessions that never monetize.`;

/** Probooks-style body, the canonical clean differentiator. */
const PROBOOKS_DIFF = `we tune publisher mix and payout structure against post-trial retention and plan upgrades, not raw click or signup volume`;

/** Multilingual hedge/hype fixtures. */
const ES_BAD = "puede entregar alrededor de 250 conversiones por dia y un fuerte desempe\u00f1o";
const RU_BAD = "\u043c\u043e\u0436\u0435\u0442 \u043f\u0440\u0438\u0432\u043e\u0434\u0438\u0442\u044c \u043e\u043a\u043e\u043b\u043e 250 \u043e\u0434\u043e\u0431\u0440\u0435\u043d\u043d\u044b\u0445 \u043f\u043b\u0430\u0442\u0435\u0436\u0435\u0439 \u0432 \u0434\u0435\u043d\u044c \u0438 \u043c\u043e\u0449\u043d\u044b\u0439 \u0440\u0435\u0437\u0443\u043b\u044c\u0442\u0430\u0442";
const DE_BAD = "kann ungef\u00e4hr 250 Conversions pro Tag liefern und leistungsstarke Performance";
const VI_HEDGE = "c\u00f3 th\u1ec3 cung c\u1ea5p kho\u1ea3ng 250 chuy\u1ec3n \u0111\u1ed5i m\u1ed7i ng\u00e0y";


// =============================================================================
// Test suite
// =============================================================================

test.describe("language-nativeness lint", () => {

  test.it("flags 'quality user acquisition' in the real Thai email", () => {
    const r = detectNativenessViolations(THAI_REAL, "th");
    assert.equal(r.found, true);
    assert.ok(r.matches.includes("quality user acquisition"),
      `expected to flag "quality user acquisition", got: ${JSON.stringify(r.matches)}`);
  });

  test.it("v3 flags ALL English content singletons in Thai (no v2 carve-outs); acronyms stay spared", () => {
    const r = detectNativenessViolations(THAI_REAL, "th");
    // v3 Reading-A++ supersedes the v1 Thai-guide allowlist for content words.
    // cohort/acquire/event/convert/campaign are now flagged.
    const expected_flagged = ["cohort", "acquire", "event", "convert", "campaign"];
    for (const s of expected_flagged) {
      assert.ok(r.matches.includes(s) || r.matches.includes(s.charAt(0).toUpperCase() + s.slice(1)),
        `v3 should flag "${s}" as English content singleton; matches=${JSON.stringify(r.matches)}`);
    }
    // Acronyms (LTV, UA) and proper nouns stay spared.
    const must_spare = ["LTV", "UA"];
    for (const s of must_spare) {
      assert.ok(!r.matches.includes(s),
        `acronym "${s}" should not be flagged; matches=${JSON.stringify(r.matches)}`);
    }
  });

  test.it("does NOT flag proper-noun runs like 'King Power Online' or 'Brand Day'", () => {
    const r = detectNativenessViolations(THAI_REAL, "th");
    const proper = ["King Power Online", "Watsons Thailand", "Brand Day", "Super Brand Day", "Central App"];
    for (const p of proper) {
      assert.ok(!r.matches.includes(p), `did not expect "${p}" to be flagged`);
    }
  });

  test.it("returns zero hits on clean rewritten Thai", () => {
    const r = detectNativenessViolations(THAI_CLEAN, "th");
    assert.equal(r.found, false);
    assert.deepEqual(r.matches, []);
  });

  test.it("v3 fires X-not-Y universal rule on English emails containing the pattern", () => {
    // EN_CLEAN intentionally contains "durable conversions, not trial tourists"
    // which v3 flags as X-NOT-Y (universal rule, applies to English too).
    const r = detectNativenessViolations(EN_CLEAN, "en");
    assert.equal(r.found, true);
    assert.match(r.issues.join(" "), /X-NOT-Y/);
  });

  test.it("v3 treats well-formed unknown language tags as non-English (conservative default)", () => {
    // "xx" passes the 2-3 letter regex check, so v3 treats it as a non-English
    // target and fires detectors. This is the safe default — an unknown
    // non-English tag should still benefit from the lint.
    const r = detectNativenessViolations("install cohort retention", "xx");
    assert.ok(r.found, "unknown but well-formed lang should still benefit from detectors");
    // Malformed tag normalizes to "" and detectors no-op.
    const r2 = detectNativenessViolations("install cohort retention", "x");
    assert.equal(r2.found, false,
      "malformed tag (normalized to '') should be no-op");
  });

  test.it("handles BCP-47 subtag normalization", () => {
    const r1 = detectNativenessViolations(THAI_REAL, "th-TH");
    const r2 = detectNativenessViolations(THAI_REAL, "th");
    assert.deepEqual(r1.matches, r2.matches);
  });

  test.it("flags multi-word phrases in Japanese", () => {
    const ja = "\u4eca\u56de\u306e quality acquisition \u30ad\u30e3\u30f3\u30da\u30fc\u30f3\u306b\u3064\u3044\u3066\u3054\u9023\u7d61\u3059\u308b\u305f\u3081\u306b\u30e1\u30fc\u30eb\u3092\u9001\u3063\u3066\u304a\u308a\u307e\u3059";
    const r = detectNativenessViolations(ja, "ja");
    assert.equal(r.found, true);
    assert.ok(r.matches.some((m) => m.includes("quality acquisition")));
  });

  test.it("flags multi-word phrases in Russian (Cyrillic)", () => {
    const ru = "\u043c\u044b \u043f\u0440\u0435\u0434\u043b\u0430\u0433\u0430\u0435\u043c quality user acquisition \u0434\u043b\u044f \u0432\u0430\u0448\u0435\u0433\u043e \u043f\u0440\u0438\u043b\u043e\u0436\u0435\u043d\u0438\u044f";
    const r = detectNativenessViolations(ru, "ru");
    assert.equal(r.found, true);
    assert.ok(r.matches.some((m) => m.includes("quality user acquisition")));
  });

  test.it("flags multi-word phrases in Hebrew", () => {
    const he = "\u05de\u05e6\u05d3\u05d9\u05e2\u05d9\u05dd quality user acquisition \u05e2\u05d1\u05d5\u05e8 \u05d4\u05d0\u05e4\u05dc\u05d9\u05e7\u05e6\u05d9\u05d4 \u05e9\u05dc\u05db\u05dd";
    const r = detectNativenessViolations(he, "he");
    assert.equal(r.found, true);
  });

  test.it("flags multi-word phrases in Arabic", () => {
    const ar = "\u0646\u062d\u0646 \u0646\u0642\u062f\u0645 quality user acquisition \u0644\u062a\u0637\u0628\u064a\u0642\u0643\u0645";
    const r = detectNativenessViolations(ar, "ar");
    assert.equal(r.found, true);
  });

  test.it("flags multi-word phrases in Chinese", () => {
    const zh = "\u6211\u4eec\u63d0\u4f9b quality user acquisition \u670d\u52a1";
    const r = detectNativenessViolations(zh, "zh");
    assert.equal(r.found, true);
  });

  test.it("flags multi-word phrases in Korean", () => {
    const ko = "\uc800\ud76c\ub294 quality user acquisition \uc11c\ube44\uc2a4\ub97c \uc81c\uacf5\ud569\ub2c8\ub2e4";
    const r = detectNativenessViolations(ko, "ko");
    assert.equal(r.found, true);
  });

});


test.describe("doctrine violations", () => {

  test.it("trips on the canonical VI body across all four checks", () => {
    const r = detectDoctrineViolations(VI_DOCTRINE_BAD, "en");
    assert.equal(r.found, true);
    assert.ok(r.issues.length >= 4,
      `expected 4+ issues for VI body, got ${r.issues.length}: ${r.issues.map((i) => i.slice(0, 40)).join(" | ")}`);
    // Check each rule fires:
    const issueText = r.issues.join(" ");
    assert.match(issueText, /HEDGED NUMBER/);
    assert.match(issueText, /HYPE ADJECTIVES/);
    assert.match(issueText, /MULTI-EVENT/);
    assert.match(issueText, /CPA-AS-DIFFERENTIATOR/);
  });

  test.it("returns clean on the English Probooks-style body", () => {
    const r = detectDoctrineViolations(EN_CLEAN, "en");
    assert.equal(r.found, false);
    assert.deepEqual(r.matches, []);
  });

  test.it("hedge + hype fire in Spanish", () => {
    const r = detectDoctrineViolations(ES_BAD, "es");
    assert.equal(r.found, true);
    const txt = r.issues.join(" ");
    assert.match(txt, /HEDGED NUMBER/);
    assert.match(txt, /HYPE ADJECTIVES/);
  });

  test.it("hedge + hype fire in Russian", () => {
    const r = detectDoctrineViolations(RU_BAD, "ru");
    assert.equal(r.found, true);
    const txt = r.issues.join(" ");
    assert.match(txt, /HEDGED NUMBER/);
    assert.match(txt, /HYPE ADJECTIVES/);
  });

  test.it("hedge + hype fire in German", () => {
    const r = detectDoctrineViolations(DE_BAD, "de");
    assert.equal(r.found, true);
    const txt = r.issues.join(" ");
    assert.match(txt, /HEDGED NUMBER/);
    assert.match(txt, /HYPE ADJECTIVES/);
  });

  test.it("ordinary words 'stark' (de) and significant (he) are not hype; real hype still catches", () => {
    assert.deepEqual(findHypeAdjectivesInBody("R\u00fcckgabequoten stark schwanken je nach Warengruppe", "de"), []);
    assert.deepEqual(findHypeAdjectivesInBody("\u05ea\u05d5\u05e6\u05d0\u05d4 \u05de\u05e9\u05de\u05e2\u05d5\u05ea\u05d9\u05ea \u05de\u05d0\u05d5\u05d3", "he"), []);
    assert.ok(findHypeAdjectivesInBody("ein leistungsstarkes Netzwerk", "de").length > 0);
    assert.ok(findHypeAdjectivesInBody("\u05e8\u05e9\u05ea \u05d7\u05d6\u05e7\u05d4", "he").length > 0);
  });

  test.it("hedge fires in Vietnamese", () => {
    const r = detectDoctrineViolations(VI_HEDGE, "vi");
    assert.equal(r.found, true);
    assert.match(r.issues.join(" "), /HEDGED NUMBER/);
  });

});


test.describe("combined detector", () => {

  test.it("merges doctrine + nativeness reports on Thai email (v3 issue strings)", () => {
    const r = detectAllDeterministicViolations(THAI_REAL, "th");
    assert.equal(r.found, true);
    // v3 categorizes the Thai email's English-leakage into FORBIDDEN-ENGLISH-PHRASE
    // and LATIN-TOKEN-RUN and FORBIDDEN-ENGLISH-SINGLETON (the old LATIN-TOKEN-LEAK
    // umbrella is replaced by these category-specific issue strings).
    const joined = r.issues.join(" | ");
    assert.match(joined,
      /FORBIDDEN-ENGLISH-PHRASE|LATIN-TOKEN-RUN|FORBIDDEN-ENGLISH-SINGLETON/);
  });

  test.it("doctrine + nativeness silent on truly-clean English (no X-not-Y, no flagged content)", () => {
    // EN_CLEAN intentionally contains X-not-Y so it now fires under v3 — see the
    // companion test above. For the silent case, use a fixture without any
    // X-not-Y comma-negation and without flagged content words.
    const truly_clean = "Hi Brian,\n\nFollowing up on my note about partnerships. Worth a quick call?\n\nThanks,\nMurat";
    const r = detectAllDeterministicViolations(truly_clean, "en");
    assert.equal(r.found, false);
  });

});


test.describe("data-table coverage", () => {

  const LANGS_36 = ["en", "es", "pt", "it", "fr", "de", "ru", "uk", "pl", "cs",
    "ro", "hu", "fi", "tr", "nl", "sv", "no", "nb", "da", "el",
    "ja", "zh", "ko", "he", "ar", "fa", "hi", "bn", "ur", "th",
    "vi", "id", "ms", "fil", "tl", "sw"];

  for (const tbl of [
    { name: "HOW openers", t: MANDATED_HOW_OPENERS },
    { name: "Hedge patterns", t: HEDGE_PATTERNS },
    { name: "Hype adjectives", t: HYPE_ADJECTIVES },
    { name: "Anchors", t: APPROVED_DIFFERENTIATOR_ANCHORS },
  ] as const) {
    test.it(`${tbl.name}: all 36 languages present with non-empty data`, () => {
      for (const lang of LANGS_36) {
        const entry = (tbl.t as Record<string, unknown[]>)[lang];
        assert.ok(entry !== undefined, `missing ${tbl.name} for "${lang}"`);
        assert.ok(entry.length > 0, `empty ${tbl.name} for "${lang}"`);
      }
    });
  }

  test.it("CPA-collapse and multi-event have deterministic coverage for the documented quad", () => {
    for (const lang of ["en", "es", "ru", "th"]) {
      assert.ok(FORBIDDEN_DIFFERENTIATOR_PATTERNS[lang] !== undefined,
        `missing CPA-collapse patterns for ${lang}`);
      assert.ok(MULTI_EVENT_PATTERNS[lang] !== undefined,
        `missing multi-event patterns for ${lang}`);
    }
  });

});


test.describe("module shape", () => {

  test.it("exports are functions with the expected arity", () => {
    assert.equal(typeof detectDoctrineViolations, "function");
    assert.equal(typeof detectNativenessViolations, "function");
    assert.equal(typeof detectAllDeterministicViolations, "function");
    assert.equal(detectDoctrineViolations.length, 2);
    assert.equal(detectNativenessViolations.length, 2);
    assert.equal(detectAllDeterministicViolations.length, 2);
  });

  test.it("ViolationReport shape is consistent across detectors", () => {
    const reports = [
      detectDoctrineViolations(VI_DOCTRINE_BAD, "en"),
      detectNativenessViolations(THAI_REAL, "th"),
      detectAllDeterministicViolations(THAI_REAL, "th"),
      detectDoctrineViolations(EN_CLEAN, "en"),     // empty case
      detectNativenessViolations(EN_CLEAN, "en"),   // no-op case
    ];
    for (const r of reports) {
      assert.equal(typeof r.found, "boolean");
      assert.ok(Array.isArray(r.issues));
      assert.ok(Array.isArray(r.suggestions));
      assert.ok(Array.isArray(r.matches));
      // Invariant: found iff issues non-empty.
      assert.equal(r.found, r.issues.length > 0);
    }
  });

  test.it("the helper functions from doctrineRules behave consistently with reports", () => {
    // Re-confirm the lower-level helpers track the report results.
    const hedge = findHedgesInBody(VI_DOCTRINE_BAD, "en");
    assert.ok(hedge.length > 0);

    const hype = findHypeAdjectivesInBody(VI_DOCTRINE_BAD, "en");
    assert.ok(hype.length > 0);

    const multi = findMultiEventPatterns(VI_DOCTRINE_BAD, "en");
    assert.ok(multi.length > 0);

    const forbidden = findForbiddenDiffPatterns(VI_DOCTRINE_BAD, "en");
    assert.ok(forbidden.length > 0);

    assert.equal(hasApprovedDifferentiatorAnchor(VI_DOCTRINE_BAD, "en"), false);
    assert.equal(hasApprovedDifferentiatorAnchor(PROBOOKS_DIFF, "en"), true);
  });

});
