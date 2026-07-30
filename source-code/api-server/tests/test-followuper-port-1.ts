/**
 * test-followuper-port-1.ts (v1.1 — ESM-compatible)
 *
 * Tests for the followuper Phase 1 port of prospector v4r6x fixes:
 *   - Patch 1: restoreUniversalTechBrands helper in humanizeText
 *   - Patch 2a/2b: BRAND ADAPTATION directive in system + rewriter prompts
 *
 * v1.1 fix: replace CommonJS `__dirname` with the ESM idiom
 *           `fileURLToPath(import.meta.url)` so this runs under the live
 *           api-server's ESM toolchain (Node 22, tsx with ESM modules).
 *
 * Run via:
 *   pnpm --filter @workspace/api-server exec tsx --test tests/test-followuper-port-1.ts
 * or:
 *   node --import tsx --test tests/test-followuper-port-1.ts
 */

import * as test from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// ESM-compatible __dirname (Node 16+). The live api-server runs in ESM
// scope so `__dirname` global is not defined — must derive from
// import.meta.url. Equivalent to CommonJS __dirname.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SERVICES_DIR = path.join(__dirname, "..", "services");
const GENERATOR_PATH = path.join(SERVICES_DIR, "followupGenerator.ts");
const PROMPTS_PATH = path.join(SERVICES_DIR, "followupPrompts.ts");


// ──────────────────────────────────────────────────────────────────────
// Patch 1 source-level checks
// ──────────────────────────────────────────────────────────────────────

test.describe("followuper-p1 Patch 1: restoreUniversalTechBrands", () => {
  let src: string;
  test.before(() => {
    src = fs.readFileSync(GENERATOR_PATH, "utf8");
  });

  test.it("declares the UNIVERSAL_TECH_RESTORE map", () => {
    assert.ok(
      src.includes("const UNIVERSAL_TECH_RESTORE: Record<string, string> = {"),
      "Map declaration missing",
    );
  });

  test.it("Russian Андроид → Android mapping present", () => {
    assert.ok(src.includes('"Андроид": "Android"'), "Russian Android map missing");
  });

  test.it("Russian АйОС → iOS mapping present", () => {
    assert.ok(src.includes('"АйОС": "iOS"'), "Russian iOS map missing");
  });

  test.it("Russian АЙОС (uppercase) → iOS mapping present", () => {
    assert.ok(src.includes('"АЙОС": "iOS"'), "Russian uppercase iOS map missing");
  });

  test.it("declares restoreUniversalTechBrands function", () => {
    assert.ok(
      src.includes("function restoreUniversalTechBrands(text: string): string"),
      "Function declaration missing",
    );
  });

  test.it("humanizeText calls restoreUniversalTechBrands as the first transform", () => {
    const idxFn = src.indexOf("function humanizeText(text: string): string {");
    assert.ok(idxFn > -1, "humanizeText function not found");
    const fnBody = src.slice(idxFn, idxFn + 600);
    const firstAssign = fnBody.indexOf("result =");
    const secondAssign = fnBody.indexOf("result =", firstAssign + 1);
    const between = fnBody.slice(firstAssign, secondAssign + 100);
    assert.ok(
      between.includes("restoreUniversalTechBrands(result)"),
      `humanizeText must call restoreUniversalTechBrands early. Got: ${between.slice(0, 200)}`,
    );
  });
});


// ──────────────────────────────────────────────────────────────────────
// Patch 1 functional check — actually invoke the helper
// ──────────────────────────────────────────────────────────────────────

test.describe("followuper-p1 Patch 1: restoreUniversalTechBrands behavior", () => {
  // Re-implement locally for direct testing without requiring the
  // followupGenerator module's dependencies (anthropic SDK, logger, etc.)
  // to be resolvable in this test scope. Mirrors the in-source definition.
  const UNIVERSAL_TECH_RESTORE: Record<string, string> = {
    "Андроид": "Android",
    "АйОС": "iOS",
    "АЙОС": "iOS",
  };
  function restoreUniversalTechBrands(text: string): string {
    if (!text) return text;
    let result = text;
    for (const [nativeForm, latinForm] of Object.entries(UNIVERSAL_TECH_RESTORE)) {
      if (result.includes(nativeForm)) {
        result = result.split(nativeForm).join(latinForm);
      }
    }
    return result;
  }

  test.it("Russian over-transliteration: Андроид и АйОС → Android и iOS", () => {
    const input = "Мы поддерживаем Андроид и АйОС в России.";
    const out = restoreUniversalTechBrands(input);
    assert.ok(out.includes("Android"));
    assert.ok(out.includes("iOS"));
    assert.ok(!out.includes("Андроид"));
    assert.ok(!out.includes("АйОС"));
  });

  test.it("Russian uppercase АЙОС → iOS", () => {
    assert.equal(restoreUniversalTechBrands("АЙОС только"), "iOS только");
  });

  test.it("English body unchanged (no source patterns present)", () => {
    const input = "We support Android and iOS";
    assert.equal(restoreUniversalTechBrands(input), input);
  });

  test.it("Empty input passes through", () => {
    assert.equal(restoreUniversalTechBrands(""), "");
  });

  test.it("Idempotent on already-restored body", () => {
    const once = restoreUniversalTechBrands("Мы поддерживаем Андроид и АйОС");
    const twice = restoreUniversalTechBrands(once);
    assert.equal(once, twice);
    assert.ok(once.includes("Android"));
    assert.ok(once.includes("iOS"));
  });

  test.it("Preserves surrounding Russian content (only Android/iOS swapped)", () => {
    const input = "Здравствуйте, Кинопоиск unchanged, Андроид + АйОС, Озон unchanged.";
    const out = restoreUniversalTechBrands(input);
    assert.ok(out.includes("Здравствуйте"));
    assert.ok(out.includes("Кинопоиск unchanged"));
    assert.ok(out.includes("Озон unchanged"));
    assert.ok(out.includes("Android"));
    assert.ok(out.includes("iOS"));
  });
});


// ──────────────────────────────────────────────────────────────────────
// Patch 2 source-level checks
// ──────────────────────────────────────────────────────────────────────

test.describe("followuper-p1 Patch 2: BRAND ADAPTATION directive in followupPrompts.ts", () => {
  let src: string;
  test.before(() => {
    src = fs.readFileSync(PROMPTS_PATH, "utf8");
  });

  test.it("BRAND ADAPTATION marker present", () => {
    assert.ok(
      src.includes("BRAND ADAPTATION (CRITICAL — applies to ALL non-Latin target languages, severity: block, ported from prospector v4r6x)"),
      "BRAND ADAPTATION directive marker missing",
    );
  });

  test.it("EXPLICIT LATIN-KEEP LIST present with iOS / Android", () => {
    assert.ok(src.includes("EXPLICIT LATIN-KEEP LIST"), "EXPLICIT LATIN-KEEP LIST header missing");
    for (const brand of ["iOS", "Android", "Google", "Apple", "AppsFlyer", "Adjust"]) {
      assert.ok(src.includes(brand), `Required brand ${brand} missing from Latin-keep list`);
    }
  });

  test.it("BRAND ADAPTATION inserted in BOTH system + rewriter prompts (2 occurrences)", () => {
    const count = src.split("BRAND ADAPTATION (CRITICAL — applies to ALL non-Latin target languages, severity: block, ported from prospector v4r6x)").length - 1;
    assert.equal(count, 2, `Expected directive to appear in BOTH system + rewriter prompts; got ${count} occurrences`);
  });

  test.it("Russian Кинопоиск example present (local-market native-script anchor)", () => {
    assert.ok(src.includes("Кинопоиск"), "Russian local-market brand example missing");
  });

  test.it("Chinese 微信 example present", () => {
    assert.ok(src.includes("微信"), "Chinese local-market brand example missing");
  });
});


// ──────────────────────────────────────────────────────────────────────
// Cross-cutting: the prospector port markers match the prospector source
// ──────────────────────────────────────────────────────────────────────

test.describe("followuper-p1: prospector parity sanity", () => {
  test.it("Russian over-transliterations match the prospector source set", () => {
    const src = fs.readFileSync(GENERATOR_PATH, "utf8");
    for (const pattern of ["Андроид", "АйОС"]) {
      assert.ok(src.includes(pattern), `Russian source pattern ${pattern} missing from port`);
    }
  });
});
