/**
 * test-critic-no-opus.ts
 *
 * Regression lock for the cost rule: Opus must NEVER be used as a critic
 * model. This test fails loudly if a critic model constant is ever edited back
 * to an Opus identifier, or if the isOpusModel / assertCriticModelAllowed
 * guards stop catching Opus.
 *
 * lib/anthropic.ts throws at import time when ANTHROPIC_API_KEY is unset (a
 * deliberate fail-loud-at-boot), so we set a dummy key (only if absent) and
 * load the module in a before() hook via dynamic import. No network and no
 * real key are needed. Using a hook (not top-level await) keeps the test
 * runnable under either module format.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx --test src/tests/test-critic-no-opus.ts
 */

import * as test from "node:test";
import * as assert from "node:assert/strict";

if (!process.env.ANTHROPIC_API_KEY) {
  process.env.ANTHROPIC_API_KEY = "test-key-for-import-only";
}

let mod: typeof import("../lib/anthropic");

test.before(async () => {
  mod = await import("../lib/anthropic");
});

test.describe("isOpusModel", () => {
  test.it("matches every Opus identifier", () => {
    for (const m of [
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-opus-4-1",
      "claude-opus-4",
      "claude-opus-5-0",
      "Claude-OPUS-4-8",
    ]) {
      assert.equal(mod.isOpusModel(m), true, `expected ${m} to be detected as Opus`);
    }
  });

  test.it("does not match Sonnet, Haiku, or Gemini", () => {
    for (const m of [
      "claude-sonnet-4-6",
      "claude-sonnet-4-5-20250929",
      "claude-haiku-4-5",
      "gemini-3-flash-preview",
      "gemini-3.1-flash-lite",
    ]) {
      assert.equal(mod.isOpusModel(m), false, `expected ${m} NOT to be detected as Opus`);
    }
  });
});

test.describe("assertCriticModelAllowed", () => {
  test.it("throws for any Opus model", () => {
    assert.throws(() => mod.assertCriticModelAllowed("claude-opus-4-8"), /not permitted as a critic/i);
    assert.throws(() => mod.assertCriticModelAllowed("claude-opus-5-0"), /not permitted as a critic/i);
  });

  test.it("permits Sonnet and Gemini critics", () => {
    assert.doesNotThrow(() => mod.assertCriticModelAllowed("claude-sonnet-4-6"));
    assert.doesNotThrow(() => mod.assertCriticModelAllowed("gemini-3-flash-preview"));
  });
});

test.describe("critic model constants", () => {
  test.it("no critic constant is an Opus model", () => {
    const constants: Array<[string, string]> = [
      ["MODEL_CRITIC", mod.MODEL_CRITIC],
      ["MODEL_CONTEXT_CRITIC", mod.MODEL_CONTEXT_CRITIC],
      ["MODEL_ANTI_GHOSTING_CRITIC", mod.MODEL_ANTI_GHOSTING_CRITIC],
      ["MODEL_CRITIC_FALLBACK", mod.MODEL_CRITIC_FALLBACK],
    ];
    for (const [name, model] of constants) {
      assert.equal(
        mod.isOpusModel(model),
        false,
        `${name} is "${model}" — an Opus model is banned as a critic`,
      );
    }
  });

  test.it("every critic constant passes the runtime guard", () => {
    assert.doesNotThrow(() => mod.assertCriticModelAllowed(mod.MODEL_CRITIC));
    assert.doesNotThrow(() => mod.assertCriticModelAllowed(mod.MODEL_CONTEXT_CRITIC));
    assert.doesNotThrow(() => mod.assertCriticModelAllowed(mod.MODEL_ANTI_GHOSTING_CRITIC));
  });
});
