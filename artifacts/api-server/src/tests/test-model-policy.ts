/**
 * test-model-policy.ts
 *
 * Hermetic tests for the model-chain policy: the Anthropic ban, the env
 * override parser, and the invariants every chain must satisfy.
 *
 * The ban is the one that matters. Aug 2026: the Anthropic account is unfunded,
 * and "we moved off Anthropic" has to be a property the code enforces, not a
 * claim in a commit message — otherwise one edited string, six months from now,
 * quietly starts billing an account that will decline it.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx --test src/tests/test-model-policy.ts
 */
import * as test from "node:test";
import * as assert from "node:assert/strict";

import {
  ALL_LLM_ROLES,
  getChain,
  parseChainSpec,
  validateAllChains,
  describeChain,
  isAnthropicModel,
  assertNoAnthropic,
  envVarForRole,
  type LlmRole,
} from "../lib/modelPolicy";
import { MODEL_PRICES } from "../lib/pricing";

function withEnv<T>(key: string, value: string | undefined, fn: () => T): T {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

// --------------------------------------------------------------------------
// The Anthropic ban
// --------------------------------------------------------------------------

test.describe("the Anthropic ban", () => {
  test.it("recognises every Anthropic identifier shape", () => {
    for (const m of [
      "claude-sonnet-4-6",
      "claude-opus-4-8",
      "claude-haiku-4-5",
      "claude-3-7-sonnet-latest",
      "Claude-Sonnet-4-6",
      // Bedrock / Vertex qualified forms.
      "us.anthropic.claude-sonnet-4-6-v1:0",
      "anthropic/claude-sonnet-4-6",
    ]) {
      assert.equal(isAnthropicModel(m), true, `${m} should be recognised as Anthropic`);
    }
  });

  test.it("does not false-positive on the models we actually use", () => {
    for (const m of [
      "gemini-3.1-flash-lite",
      "gemini-3-flash-preview",
      "gemini-3.7-flash",
      "gpt-5.4-nano",
      "gpt-5.4-mini",
      "gpt-4.1-mini",
    ]) {
      assert.equal(isAnthropicModel(m), false, `${m} must not be mistaken for Anthropic`);
    }
  });

  test.it("rejects an Anthropic model anywhere in a chain", () => {
    assert.throws(
      () =>
        assertNoAnthropic("draft", [
          { provider: "gemini", model: "gemini-3.1-flash-lite" },
          { provider: "gemini", model: "claude-sonnet-4-6" },
        ]),
      /Anthropic models are disabled/,
    );
  });

  test.it("rejects an Anthropic model smuggled in through an env override", () => {
    // Deliberately a THROW rather than a skipped tier: silently dropping it
    // leaves a shorter chain that looks intentional, and the whole point of the
    // ban is that it cannot be silent.
    assert.throws(
      () => withEnv("LLM_CHAIN_DRAFT", "anthropic:claude-sonnet-4-6", () => getChain("draft")),
      /Anthropic models are disabled/,
    );
    assert.throws(
      () =>
        withEnv("LLM_CHAIN_CRITIC", "gemini:gemini-3-flash-preview,gemini:claude-haiku-4-5", () =>
          getChain("critic"),
        ),
      /Anthropic models are disabled/,
    );
  });

  test.it("no built-in chain names an Anthropic model", () => {
    for (const [role, chain] of Object.entries(validateAllChains())) {
      assert.ok(
        !chain.some((t) => isAnthropicModel(t.model)),
        `${role} -> ${describeChain(chain)}`,
      );
    }
  });
});

// --------------------------------------------------------------------------
// Chain invariants
// --------------------------------------------------------------------------

test.describe("every role's chain", () => {
  for (const role of ALL_LLM_ROLES) {
    test.it(`${role}: has at least two tiers, so no role depends on one model`, () => {
      const chain = getChain(role);
      assert.ok(chain.length >= 2, `${role} -> ${describeChain(chain)}`);
    });

    test.it(`${role}: spans both vendors`, () => {
      // A chain built from one vendor shares one quota pool, one control plane
      // and one incident page. That is not a fallback, it is a single point of
      // failure with extra steps.
      const vendors = new Set(getChain(role).map((t) => t.provider));
      assert.ok(vendors.size >= 2, `${role} uses only ${[...vendors].join(",")}`);
    });

    test.it(`${role}: every tier has a real price row`, () => {
      // An unpriced model silently bills at DEFAULT_PRICE, which corrupts both
      // the activity report and the daily budget cap that reads it.
      for (const tier of getChain(role)) {
        assert.ok(
          MODEL_PRICES[tier.model] !== undefined,
          `${role} tier ${tier.model} is missing from MODEL_PRICES`,
        );
      }
    });

    test.it(`${role}: names no model twice`, () => {
      // A repeated model is a dead tier: its breaker is already open by the
      // time the chain reaches it again.
      const models = getChain(role).map((t) => t.model);
      assert.equal(new Set(models).size, models.length, describeChain(getChain(role)));
    });
  }
});

// --------------------------------------------------------------------------
// The env override parser
// --------------------------------------------------------------------------

test.describe("parseChainSpec", () => {
  test.it("parses provider:model@effort for both vendors", () => {
    assert.deepEqual(
      parseChainSpec("t", "gemini:gemini-3.1-flash-lite@MINIMAL,openai:gpt-5.4-nano@none"),
      [
        { provider: "gemini", model: "gemini-3.1-flash-lite", thinking: "MINIMAL" },
        { provider: "openai", model: "gpt-5.4-nano", effort: "none" },
      ],
    );
  });

  test.it("omits the effort when it is absent or not a valid value", () => {
    assert.deepEqual(parseChainSpec("t", "openai:gpt-4.1-mini"), [
      { provider: "openai", model: "gpt-4.1-mini" },
    ]);
    // MINIMAL is not an OpenAI effort; dropping it means "use the default"
    // rather than sending a value the API 400s on.
    assert.deepEqual(parseChainSpec("t", "openai:gpt-5.4-nano@minimal"), [
      { provider: "openai", model: "gpt-5.4-nano" },
    ]);
  });

  test.it("is case-insensitive about the effort, per vendor convention", () => {
    assert.deepEqual(parseChainSpec("t", "gemini:m@low"), [
      { provider: "gemini", model: "m", thinking: "LOW" },
    ]);
    assert.deepEqual(parseChainSpec("t", "openai:m@NONE"), [
      { provider: "openai", model: "m", effort: "none" },
    ]);
  });

  test.it("skips malformed entries instead of taking the process down", () => {
    // One typo in one tier must not stop a deploy. An Anthropic model is the
    // deliberate exception and is tested above.
    assert.deepEqual(parseChainSpec("t", "nonsense,gemini:good,:,openai:"), [
      { provider: "gemini", model: "good" },
    ]);
    assert.deepEqual(parseChainSpec("t", "bedrock:some-model"), []);
    assert.deepEqual(parseChainSpec("t", ""), []);
  });

  test.it("tolerates whitespace around entries", () => {
    assert.deepEqual(parseChainSpec("t", " gemini:a@LOW , openai:b "), [
      { provider: "gemini", model: "a", thinking: "LOW" },
      { provider: "openai", model: "b" },
    ]);
  });
});

test.describe("getChain overrides", () => {
  test.it("uses the env chain when one parses", () => {
    withEnv("LLM_CHAIN_SUMMARIZER", "openai:gpt-4.1-nano,gemini:gemini-3.1-flash-lite", () => {
      assert.deepEqual(getChain("summarizer").map((t) => t.model), [
        "gpt-4.1-nano",
        "gemini-3.1-flash-lite",
      ]);
    });
  });

  test.it("falls back to the built-in when the override parses to nothing", () => {
    const builtin = describeChain(getChain("summarizer"));
    withEnv("LLM_CHAIN_SUMMARIZER", "garbage,,,", () => {
      assert.equal(describeChain(getChain("summarizer")), builtin);
    });
  });

  test.it("reads env fresh on every call, not once at module load", () => {
    // getChain documents itself as reading fresh. A module-load snapshot would
    // silently ignore an env change a test or an operator made after import.
    const before = getChain("summarizer")[0].model;
    withEnv("LLM_CHAIN_SUMMARIZER", "openai:gpt-4.1-nano", () => {
      assert.equal(getChain("summarizer")[0].model, "gpt-4.1-nano");
    });
    assert.equal(getChain("summarizer")[0].model, before);
  });

  test.it("names the env var for a role the way the docs say", () => {
    assert.equal(envVarForRole("draft"), "LLM_CHAIN_DRAFT");
    assert.equal(envVarForRole("reply_sentiment"), "LLM_CHAIN_REPLY_SENTIMENT");
    assert.equal(envVarForRole("ag_critic" as LlmRole), "LLM_CHAIN_AG_CRITIC");
  });
});

test.describe("WRITER_THINKING", () => {
  test.it("defaults the writer primary to MINIMAL", () => {
    withEnv("WRITER_THINKING", undefined, () => {
      assert.equal(getChain("draft")[0].thinking, "MINIMAL");
    });
  });

  test.it("lifts the writer primary without touching any other tier or role", () => {
    // The measured 11-point quality lever (72.2% vs 61.1% first-draft clean),
    // deliberately one env var rather than a code change: whether it is worth
    // ~2.5x per draft is a business call, not an engineering one.
    withEnv("WRITER_THINKING", "LOW", () => {
      const chain = getChain("draft");
      assert.equal(chain[0].thinking, "LOW");
      assert.equal(chain[1].model, getChain("rewriter")[1].model);
      assert.equal(getChain("summarizer")[0].thinking, "MINIMAL", "aux roles must be unaffected");
    });
  });

  test.it("ignores a value that is not a Gemini thinking level", () => {
    withEnv("WRITER_THINKING", "TURBO", () => {
      assert.equal(getChain("draft")[0].thinking, "MINIMAL");
    });
  });
});
