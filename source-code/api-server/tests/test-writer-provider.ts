/**
 * test-writer-provider.ts
 *
 * Hermetic tests for the writer stage's two pure inputs — grey-area routing and
 * the exemplar library — and for the role mapping that turns them into a chain
 * choice. No DB, no network, no billing.
 *
 * The fallback WATERFALL itself is tested in test-llm-router.ts, which is where
 * it now lives: writerProvider is a ~130-line adapter over lib/llmRouter.ts, and
 * testing the chain walk here would be testing the router twice.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx --test src/tests/test-writer-provider.ts
 */
import * as test from "node:test";
import * as assert from "node:assert/strict";

import { detectGreyArea, isGreyArea } from "../lib/greyArea";
import {
  selectExemplars,
  buildWriterExemplarBlock,
  exemplarsEnabled,
} from "../lib/exemplarLibrary";
import { writerRole, getPrimaryWriterModel } from "../services/writerProvider";
import { getChain, describeChain, isAnthropicModel } from "../lib/modelPolicy";

// ----------------------------- grey-area --------------------------------

test.describe("greyArea", () => {
  test.it("flags casino, betting, crypto, and forex", () => {
    assert.equal(isGreyArea({ vertical: "Online Casino" }), true);
    assert.equal(isGreyArea({ product: "sportsbook UA" }), true);
    assert.equal(isGreyArea({ original_subject: "Crypto exchange growth" }), true);
    assert.equal(isGreyArea({ sub_vertical: "forex broker" }), true);
    assert.equal(isGreyArea({ vertical: "iGaming" }), true);
    assert.equal(isGreyArea({ original_body_summary: "sports betting FTDs" }), true);
  });

  test.it("passes ordinary verticals through to the Gemini chain", () => {
    assert.equal(isGreyArea({ vertical: "ecommerce", product: "cps" }), false);
    assert.equal(isGreyArea({ vertical: "health_and_fitness", product: "retargeting" }), false);
    assert.equal(isGreyArea({ vertical: "gaming_midcore_hardcore", product: "ua" }), false);
    assert.equal(isGreyArea({ vertical: "non_gaming_ua", product: "ua" }), false);
  });

  test.it("does not false-positive on substrings", () => {
    // 'broker' is structured-only, so it must NOT trip from narrative text.
    assert.equal(isGreyArea({ original_body_summary: "we never broker raw installs" }), false);
    // boundary check: 'smokers' must not match 'poker'-style scanning
    assert.equal(isGreyArea({ original_subject: "wellness for smokers" }), false);
  });

  test.it("treats structured-only terms as grey when in a structured field", () => {
    assert.equal(isGreyArea({ vertical: "crypto", product: "ua" }), true);
    assert.equal(isGreyArea({ sub_vertical: "trading" }), true);
  });

  test.it("reports the matched signals", () => {
    const r = detectGreyArea({ vertical: "casino", product: "betting ua" });
    assert.equal(r.grey, true);
    assert.ok(r.signals.length >= 1);
  });

  test.it("honors WRITER_GREY_VERTICALS extension", () => {
    const prev = process.env.WRITER_GREY_VERTICALS;
    process.env.WRITER_GREY_VERTICALS = "nutra,cbd";
    try {
      assert.equal(isGreyArea({ vertical: "nutra offers" }), true);
    } finally {
      if (prev === undefined) delete process.env.WRITER_GREY_VERTICALS;
      else process.env.WRITER_GREY_VERTICALS = prev;
    }
  });
});

// --------------------------- exemplar library ---------------------------

test.describe("exemplarLibrary", () => {
  test.it("prefers same-language exemplars", () => {
    const sel = selectExemplars({ original_language: "ja", vertical: "gaming_midcore_hardcore", product: "ua", stage: 1 });
    assert.ok(sel.exemplars.length >= 1);
    assert.equal(sel.structureOnly, false);
    assert.ok(sel.exemplars.every((e) => e.language === "ja"));
  });

  test.it("falls back to structure-only when no same-language exemplar exists", () => {
    const sel = selectExemplars({ original_language: "ta", vertical: "ecommerce", product: "cps", stage: 2 });
    assert.ok(sel.exemplars.length >= 1);
    assert.equal(sel.structureOnly, true);
  });

  test.it("builds a non-empty study block that forbids copying", () => {
    const block = buildWriterExemplarBlock({ original_language: "es", vertical: "ecommerce", product: "cps", stage: 1 });
    assert.ok(block.length > 0);
    assert.match(block, /never the text|do not copy|STRUCTURE REFERENCE/i);
    assert.match(block, /EXEMPLAR 1/);
  });

  test.it("maps the real runtime taxonomy onto the right exemplar vertical", () => {
    // The runtime classifier only emits non_gaming_ua | gaming_ua | cps |
    // retargeting (+ cps_* sub_verticals), none of which equals an exemplar
    // vertical. The runtime->exemplar map must translate these correctly.
    const nonGaming = selectExemplars({ vertical: "non_gaming_ua", product: "ua", original_language: "en", stage: 1 });
    // The default, most common prospect must NOT be shown gambling/gaming
    // exemplars (the pre-fix bug pulled sports_betting).
    assert.ok(nonGaming.exemplars.every((e) => e.vertical === "ecommerce"));
    assert.ok(nonGaming.exemplars.every((e) => e.vertical !== "sports_betting" && !e.vertical.startsWith("gaming")));

    const fintech = selectExemplars({ vertical: "cps", sub_vertical: "cps_fintech", product: "cps", original_language: "en", stage: 1 });
    assert.ok(fintech.exemplars.every((e) => e.vertical === "fintech_banking_and_payments"));

    // retargeting is an offer type, not a health vertical (pre-fix it bridged to
    // health_and_fitness for every retargeting prospect).
    const retarget = selectExemplars({ vertical: "retargeting", product: "retargeting", original_language: "en", stage: 1 });
    assert.ok(retarget.exemplars.every((e) => e.vertical !== "health_and_fitness"));

    const gaming = selectExemplars({ vertical: "gaming_ua", product: "ua", original_language: "en", stage: 1 });
    assert.ok(gaming.exemplars.some((e) => e.vertical.startsWith("gaming")));
  });

  test.it("respects WRITER_EXEMPLARS=off", () => {
    const prev = process.env.WRITER_EXEMPLARS;
    process.env.WRITER_EXEMPLARS = "off";
    try {
      assert.equal(exemplarsEnabled(), false);
      assert.equal(buildWriterExemplarBlock({ original_language: "en", vertical: "ecommerce", stage: 1 }), "");
    } finally {
      if (prev === undefined) delete process.env.WRITER_EXEMPLARS;
      else process.env.WRITER_EXEMPLARS = prev;
    }
  });
});

// --------------------------- role selection -----------------------------

test.describe("writerRole", () => {
  test.it("maps stage x grey-area onto the four writer roles", () => {
    assert.equal(writerRole("draft", false), "draft");
    assert.equal(writerRole("rewriter", false), "rewriter");
    assert.equal(writerRole("draft", true), "grey_draft");
    assert.equal(writerRole("rewriter", true), "grey_rewriter");
  });

  test.it("gives grey-area verticals a genuinely different chain", () => {
    // The whole reason grey-area is a separate ROLE rather than a boolean
    // inside the chain walk. If these two ever resolve to the same chain, the
    // regulated-vertical policy has silently evaporated.
    const ordinary = describeChain(getChain("draft"));
    const grey = describeChain(getChain("grey_draft"));
    assert.notEqual(ordinary, grey);
  });

  test.it("starts grey-area on a stronger tier than the ordinary chain", () => {
    // Regulated verticals used to be pinned to Sonnet. The replacement policy is
    // "start at the strongest tier, not the cheapest", so tier 1 of the grey
    // chain must not be the cheap primary the ordinary chain opens with.
    assert.notEqual(getChain("grey_draft")[0].model, getChain("draft")[0].model);
  });

  test.it("reports the live primary writer model rather than a frozen copy", () => {
    assert.equal(getPrimaryWriterModel(), getChain("draft")[0].model);
  });
});

// --------------------------- chain invariants ---------------------------

test.describe("writer chains", () => {
  const WRITER_ROLES = [
    "draft",
    "rewriter",
    "grey_draft",
    "grey_rewriter",
    "context_draft",
    "context_rewriter",
    "ag_draft",
    "ag_rewriter",
  ] as const;

  for (const role of WRITER_ROLES) {
    test.it(`${role}: has a real fallback and never depends on one model`, () => {
      const chain = getChain(role);
      assert.ok(chain.length >= 2, `${role} has only ${chain.length} tier(s): ${describeChain(chain)}`);
    });

    test.it(`${role}: spans both vendors`, () => {
      // A chain built only from one vendor's models shares one quota pool and
      // one control plane, so a vendor-side incident empties it all at once.
      const vendors = new Set(getChain(role).map((t) => t.provider));
      assert.ok(vendors.size >= 2, `${role} uses only ${[...vendors].join(",")}`);
    });

    test.it(`${role}: names no Anthropic model`, () => {
      assert.ok(!getChain(role).some((t) => isAnthropicModel(t.model)));
    });
  }

  test.it("the two exemplar-less flows share one chain, and it is not the doctrine chain", () => {
    // Context and anti-ghosting both lack an exemplar library, which is the
    // measured reason they start a tier up. If either drifts back onto the
    // doctrine chain, the nativeness regression that motivated the split comes
    // back with it.
    const ctxChain = describeChain(getChain("context_draft"));
    assert.equal(ctxChain, describeChain(getChain("ag_draft")));
    assert.notEqual(ctxChain, describeChain(getChain("draft")));
  });
});
