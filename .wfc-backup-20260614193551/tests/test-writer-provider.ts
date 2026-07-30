/**
 * test-writer-provider.ts
 *
 * Hermetic tests for the writer fallback chain and its two inputs. No DB, no
 * network, no billing: the Gemini transport, usage recorder, and breakers are
 * injected as fakes, and the grey-area / exemplar logic is pure.
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
import {
  planWriterChain,
  runWriter,
  type WriterDeps,
  type WriterResult,
  type AnthropicWriterFn,
} from "../services/writerProvider";
import { createCircuitBreaker } from "../lib/circuitBreaker";

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
    const sel = selectExemplars({ original_language: "th", vertical: "ecommerce", product: "cps", stage: 2 });
    assert.ok(sel.exemplars.length >= 1);
    assert.equal(sel.structureOnly, true);
  });

  test.it("builds a non-empty study block that forbids copying", () => {
    const block = buildWriterExemplarBlock({ original_language: "es", vertical: "ecommerce", product: "cps", stage: 1 });
    assert.ok(block.length > 0);
    assert.match(block, /never the text|do not copy|STRUCTURE REFERENCE/i);
    assert.match(block, /EXEMPLAR 1/);
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

// --------------------------- chain planning -----------------------------

test.describe("planWriterChain", () => {
  test.it("returns the full chain for an ordinary gemini-mode draft", () => {
    assert.deepEqual(
      planWriterChain({ provider: "gemini", greyArea: false, geminiConfigured: true }),
      ["gemini_primary", "gemini_secondary", "anthropic"],
    );
  });
  test.it("collapses to Sonnet for grey-area", () => {
    assert.deepEqual(
      planWriterChain({ provider: "gemini", greyArea: true, geminiConfigured: true }),
      ["anthropic"],
    );
  });
  test.it("collapses to Sonnet for the anthropic escape hatch", () => {
    assert.deepEqual(
      planWriterChain({ provider: "anthropic", greyArea: false, geminiConfigured: true }),
      ["anthropic"],
    );
  });
  test.it("collapses to Sonnet when Gemini is not configured", () => {
    assert.deepEqual(
      planWriterChain({ provider: "gemini", greyArea: false, geminiConfigured: false }),
      ["anthropic"],
    );
  });
});

// --------------------------- runWriter chain ----------------------------

const silentLogger = { info: () => {}, warn: () => {} };

function freshDeps(over: Partial<WriterDeps>): Partial<WriterDeps> {
  return {
    isGeminiConfigured: () => true,
    recordGeminiUsage: async () => {},
    primaryBreaker: createCircuitBreaker({ failureThreshold: 3, cooldownMs: 60_000 }),
    secondaryBreaker: createCircuitBreaker({ failureThreshold: 3, cooldownMs: 60_000 }),
    logger: silentLogger,
    ...over,
  };
}

const baseArgs = {
  label: "draft" as const,
  greyArea: false,
  systemParts: ["clause", "role"],
  userPrompt: "write it",
  maxOutputTokens: 1000,
  prospectName: "Test",
};

function sonnet(): AnthropicWriterFn {
  return async (): Promise<WriterResult> => ({
    subject: "Re: x",
    body: "sonnet body",
    modelUsed: "claude-sonnet-4-6",
    tier: "anthropic",
  });
}

test.describe("runWriter fallback chain", () => {
  test.it("uses Gemini primary when it succeeds and records usage once", async () => {
    let recorded = 0;
    const deps = freshDeps({
      geminiGenerateJson: async () => ({
        text: JSON.stringify({ subject: "Re: a", body: "flash body" }),
        usage: { totalTokenCount: 10 },
        model: "gemini-3.5-flash",
      }),
      recordGeminiUsage: async () => { recorded++; },
    });
    const res = await runWriter(baseArgs, sonnet(), deps);
    assert.equal(res.tier, "gemini_primary");
    assert.equal(res.body, "flash body");
    assert.equal(recorded, 1);
  });

  test.it("advances to Gemini Pro when primary is at capacity", async () => {
    let calls = 0;
    const deps = freshDeps({
      geminiGenerateJson: async (a: { model?: string }) => {
        calls++;
        if (a.model === "gemini-3.5-flash") {
          throw new Error("Gemini HTTP 429: RESOURCE_EXHAUSTED");
        }
        return { text: JSON.stringify({ subject: "Re: b", body: "pro body" }), usage: {}, model: a.model || "?" };
      },
    });
    const res = await runWriter(baseArgs, sonnet(), deps);
    assert.equal(res.tier, "gemini_secondary");
    assert.equal(res.body, "pro body");
    assert.equal(calls, 2);
  });

  test.it("falls through to Sonnet when both Gemini tiers fail", async () => {
    const deps = freshDeps({
      geminiGenerateJson: async () => { throw new Error("Gemini HTTP 503: UNAVAILABLE"); },
    });
    const res = await runWriter(baseArgs, sonnet(), deps);
    assert.equal(res.tier, "anthropic");
    assert.equal(res.body, "sonnet body");
  });

  test.it("never calls Gemini for grey-area drafts", async () => {
    let geminiCalled = false;
    const deps = freshDeps({
      geminiGenerateJson: async () => { geminiCalled = true; throw new Error("should not be called"); },
    });
    const res = await runWriter({ ...baseArgs, greyArea: true }, sonnet(), deps);
    assert.equal(res.tier, "anthropic");
    assert.equal(geminiCalled, false);
  });

  test.it("skips a tier whose breaker is open", async () => {
    const openBreaker = {
      shouldAttempt: () => false,
      onSuccess: () => {},
      onFailure: () => {},
      state: () => ({ open: true, consecutiveFailures: 9, openUntil: Date.now() + 1000 }),
    };
    let model = "";
    const deps = freshDeps({
      primaryBreaker: openBreaker,
      geminiGenerateJson: async (a: { model?: string }) => {
        model = a.model || "";
        return { text: JSON.stringify({ subject: "Re: c", body: "pro body" }), usage: {}, model: a.model || "?" };
      },
    });
    const res = await runWriter(baseArgs, sonnet(), deps);
    assert.equal(res.tier, "gemini_secondary");
    assert.equal(model, "gemini-3.1-pro-preview");
  });

  test.it("advances on a malformed Gemini JSON response", async () => {
    const deps = freshDeps({
      geminiGenerateJson: async (a: { model?: string }) => {
        if (a.model === "gemini-3.5-flash") return { text: "not json at all", usage: {}, model: a.model };
        return { text: JSON.stringify({ subject: "Re: d", body: "pro body" }), usage: {}, model: a.model || "?" };
      },
    });
    const res = await runWriter(baseArgs, sonnet(), deps);
    assert.equal(res.tier, "gemini_secondary");
  });

  test.it("uses the first JSON object when Gemini appends trailing content", async () => {
    // Observed Gemini Pro behavior: a valid object followed by a second object
    // or trailing notes. The parser must take the first complete object and
    // succeed on that tier rather than discarding the draft.
    const deps = freshDeps({
      geminiGenerateJson: async (a: { model?: string }) => ({
        text:
          JSON.stringify({ subject: "Re: e", body: "first body with a } brace inside" }) +
          "\n" +
          JSON.stringify({ subject: "second", body: "trailing object" }),
        usage: {},
        model: a.model || "gemini-3.5-flash",
      }),
    });
    const res = await runWriter(baseArgs, sonnet(), deps);
    assert.equal(res.tier, "gemini_primary");
    assert.equal(res.subject, "Re: e");
    assert.equal(res.body, "first body with a } brace inside");
  });

  test.it("passes a response schema and MINIMAL thinking to Gemini primary", async () => {
    let seen: { responseSchema?: unknown; thinkingLevel?: unknown } = {};
    const savedPrimary = process.env.GEMINI_WRITER_PRIMARY_THINKING;
    const savedShared = process.env.GEMINI_WRITER_THINKING;
    delete process.env.GEMINI_WRITER_PRIMARY_THINKING;
    delete process.env.GEMINI_WRITER_THINKING;
    const deps = freshDeps({
      geminiGenerateJson: async (a: { responseSchema?: unknown; thinkingLevel?: unknown; model?: string }) => {
        seen = { responseSchema: a.responseSchema, thinkingLevel: a.thinkingLevel };
        return { text: JSON.stringify({ subject: "Re: s", body: "schema body" }), usage: {}, model: a.model || "gemini-3.5-flash" };
      },
    });
    const res = await runWriter(baseArgs, sonnet(), deps);
    assert.equal(res.tier, "gemini_primary");
    assert.ok(seen.responseSchema, "writer must pass a response schema to Gemini");
    assert.equal(seen.thinkingLevel, "MINIMAL");
    if (savedPrimary !== undefined) process.env.GEMINI_WRITER_PRIMARY_THINKING = savedPrimary;
    if (savedShared !== undefined) process.env.GEMINI_WRITER_THINKING = savedShared;
  });
});
