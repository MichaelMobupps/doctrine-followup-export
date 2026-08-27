/**
 * test-llm-router.ts
 *
 * Hermetic tests for the fallback waterfall — the mechanism the whole Aug 2026
 * migration rests on. No DB, no network, no billing: both vendor transports,
 * both usage recorders and the breaker registry are injected as fakes.
 *
 * The properties under test, in the order they matter:
 *
 *   1. A tier that fails for ANY reason advances the chain. 503, 429, timeout,
 *      network fault, safety block, empty completion — the router must not care
 *      which, because a caller that has to distinguish them will get it wrong.
 *   2. An answer that is 200 OK but off-contract is a TIER failure, not a
 *      result. This is what lets the cheap tiers stay cheap.
 *   3. A spent generation budget is NOT a tier failure. It must not advance the
 *      chain and must not be scored against the tier's breaker.
 *   4. Usage is recorded for a billed call even when the answer is unusable.
 *   5. Breakers are keyed by MODEL, so a model shared across roles is
 *      discovered to be down once.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx --test src/tests/test-llm-router.ts
 */
import * as test from "node:test";
import * as assert from "node:assert/strict";

import {
  runLlm,
  runLlmJson,
  runLlmDraft,
  setLlmCallObserver,
  type LlmCallObservation,
  AllTiersFailedError,
  classifyFailure,
  extractFirstJsonObject,
  parseLlmJson,
  breakerFor,
  __resetBreakersForTests,
  type RouterDeps,
  type NormalizedUsage,
} from "../lib/llmRouter";
import { GenerationDeadlineError } from "../lib/generationDeadline";
import { createCircuitBreaker } from "../lib/circuitBreaker";

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

// A three-tier chain with a known shape, so a test can say "tier 2 served" and
// mean something. gemini / openai / gemini mirrors the real alternation.
const TEST_CHAIN = "gemini:model-a@MINIMAL,openai:model-b@none,gemini:model-c@LOW";

function withChain<T>(spec: string, fn: () => T): T {
  const prev = process.env.LLM_CHAIN_DRAFT;
  process.env.LLM_CHAIN_DRAFT = spec;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.LLM_CHAIN_DRAFT;
    else process.env.LLM_CHAIN_DRAFT = prev;
  }
}

interface Recorded {
  model: string;
  usage: NormalizedUsage;
  label: string;
}

/**
 * Build a fake dep set whose transports answer from a per-model script.
 *
 * `script[model]` is either a string (the text that model returns) or an Error
 * (what it throws). Anything not in the script throws "unexpected model", which
 * turns a routing bug into a loud failure rather than a silent pass.
 */
function fakeDeps(
  script: Record<string, string | Error>,
  opts: { calls?: string[]; recorded?: Recorded[]; breakers?: Map<string, ReturnType<typeof createCircuitBreaker>> } = {},
): Partial<RouterDeps> {
  const calls = opts.calls ?? [];
  const recorded = opts.recorded ?? [];
  const breakers = opts.breakers ?? new Map();

  const answer = (model: string) => {
    calls.push(model);
    const scripted = script[model];
    if (scripted === undefined) throw new Error(`unexpected model: ${model}`);
    if (scripted instanceof Error) throw scripted;
    return scripted;
  };

  return {
    isGeminiConfigured: () => true,
    isOpenAiConfigured: () => true,
    geminiGenerateJson: (async (a: { model?: string }) => ({
      text: answer(a.model ?? "?"),
      usage: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 5, cachedContentTokenCount: 40 },
      model: a.model ?? "?",
    })) as never,
    openaiGenerateJson: (async (a: { model: string }) => ({
      text: answer(a.model),
      usage: { promptTokens: 100, completionTokens: 25, reasoningTokens: 5, cachedPromptTokens: 40 },
      model: a.model,
    })) as never,
    recordUsage: (async (usage: NormalizedUsage, model: string, label: string) => {
      recorded.push({ model, usage, label });
    }) as never,
    recordAuxUsage: (async () => {}) as never,
    breakerFor: (model: string) => {
      let b = breakers.get(model);
      if (!b) {
        b = createCircuitBreaker({ failureThreshold: 3, cooldownMs: 60_000 });
        breakers.set(model, b);
      }
      return b;
    },
    logger: silentLogger as never,
  };
}

const baseArgs = {
  role: "draft" as const,
  systemParts: ["clause", "role"],
  user: "write it",
  maxOutputTokens: 1000,
  prospectName: "Test",
};

const OK = JSON.stringify({ subject: "Re: x", body: "a body" });

// --------------------------------------------------------------------------
// 1. Any failure advances the chain
// --------------------------------------------------------------------------

test.describe("the waterfall advances on every kind of tier failure", () => {
  // The exact upstream shapes we have seen in production and in the bench runs.
  const FAILURES: Array<[string, Error]> = [
    ["503 UNAVAILABLE", new Error("Gemini HTTP 503: model is overloaded, UNAVAILABLE")],
    ["429 rate limit", new Error("OpenAI HTTP 429: Rate limit reached ... on tokens per min (TPM)")],
    ["429 RESOURCE_EXHAUSTED", new Error("Gemini HTTP 429: RESOURCE_EXHAUSTED quota exceeded")],
    ["500", new Error("Gemini HTTP 500: internal")],
    ["timeout / abort", Object.assign(new Error("The operation was aborted"), { name: "AbortError" })],
    ["network fault", new TypeError("fetch failed")],
    ["safety block", new Error("Gemini blocked the request: SAFETY")],
    ["empty completion", new Error("OpenAI returned no text content (finish_reason=length)")],
    ["missing content", new Error("Gemini returned no text content (finishReason=MAX_TOKENS)")],
  ];

  for (const [name, err] of FAILURES) {
    test.it(`${name} on tier 1 falls to tier 2`, async () => {
      const calls: string[] = [];
      const res = await withChain(TEST_CHAIN, () =>
        runLlm(baseArgs, fakeDeps({ "model-a": err, "model-b": OK }, { calls })),
      );
      assert.deepEqual(calls, ["model-a", "model-b"]);
      assert.equal(res.model, "model-b");
      assert.equal(res.provider, "openai");
      assert.equal(res.tierIndex, 2);
    });
  }

  test.it("walks all the way to tier 3 when the first two are down", async () => {
    const calls: string[] = [];
    const res = await withChain(TEST_CHAIN, () =>
      runLlm(
        baseArgs,
        fakeDeps(
          {
            "model-a": new Error("Gemini HTTP 503: UNAVAILABLE"),
            "model-b": new Error("OpenAI HTTP 429: Rate limit reached"),
            "model-c": OK,
          },
          { calls },
        ),
      ),
    );
    assert.deepEqual(calls, ["model-a", "model-b", "model-c"]);
    assert.equal(res.tierIndex, 3);
  });

  test.it("throws AllTiersFailedError naming every tier and its cause", async () => {
    const err = await withChain(TEST_CHAIN, () =>
      runLlm(
        baseArgs,
        fakeDeps({
          "model-a": new Error("Gemini HTTP 503: UNAVAILABLE"),
          "model-b": new Error("OpenAI HTTP 429: Rate limit reached"),
          "model-c": new Error("Gemini HTTP 500: internal"),
        }),
      ),
    ).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(err instanceof AllTiersFailedError, `expected AllTiersFailedError, got ${err}`);
    assert.equal(err.attempts.length, 3);
    assert.deepEqual(err.attempts.map((a) => a.model), ["model-a", "model-b", "model-c"]);
    // The message must carry the causes: an operator reading it should not have
    // to go find the logs to learn why each tier declined.
    assert.match(err.message, /model-a/);
    assert.match(err.message, /model-c/);
    assert.match(err.message, /capacity/);
  });

  test.it("skips a tier whose provider has no API key, without calling it", async () => {
    const calls: string[] = [];
    const deps = fakeDeps({ "model-b": OK }, { calls });
    const res = await withChain(TEST_CHAIN, () =>
      runLlm(baseArgs, { ...deps, isGeminiConfigured: () => false }),
    );
    assert.deepEqual(calls, ["model-b"], "the Gemini tiers must be skipped, not attempted");
    assert.equal(res.model, "model-b");
  });
});

// --------------------------------------------------------------------------
// 2. An off-contract answer is a tier failure
// --------------------------------------------------------------------------

test.describe("an off-contract answer advances the waterfall", () => {
  test.it("unparseable JSON falls to the next tier", async () => {
    const calls: string[] = [];
    const { result } = await withChain(TEST_CHAIN, () =>
      runLlmJson({ ...baseArgs }, fakeDeps({ "model-a": "I'm sorry, I can't do that.", "model-b": OK }, { calls })),
    );
    assert.deepEqual(calls, ["model-a", "model-b"]);
    assert.equal(result.model, "model-b");
  });

  test.it("valid JSON that fails the caller's contract check falls to the next tier", async () => {
    const calls: string[] = [];
    // A draft with an empty body is well-formed JSON and completely useless.
    const { value, result } = await withChain(TEST_CHAIN, () =>
      runLlmDraft(
        baseArgs,
        fakeDeps({ "model-a": JSON.stringify({ subject: "Re: x", body: "" }), "model-b": OK }, { calls }),
      ),
    );
    assert.deepEqual(calls, ["model-a", "model-b"]);
    assert.equal(result.model, "model-b");
    assert.equal(value.body, "a body");
  });

  test.it("does not re-pick the model that just answered off-contract", async () => {
    // The bug this locks: an early draft walked the chain from the start on each
    // parse failure, so tier 1 was retried until its breaker happened to open.
    const calls: string[] = [];
    await withChain(TEST_CHAIN, () =>
      runLlmJson({ ...baseArgs }, fakeDeps({ "model-a": "nonsense", "model-b": OK }, { calls })),
    );
    assert.equal(calls.filter((c) => c === "model-a").length, 1);
  });

  test.it("survives a fenced or trailing-note answer rather than falling past a good tier", async () => {
    const calls: string[] = [];
    const { result } = await withChain(TEST_CHAIN, () =>
      runLlmDraft(
        baseArgs,
        fakeDeps({ "model-a": "```json\n" + OK + "\n```\nHope that helps!" }, { calls }),
      ),
    );
    assert.deepEqual(calls, ["model-a"], "tolerant parsing must not waste a tier");
    assert.equal(result.tierIndex, 1);
  });
});

// --------------------------------------------------------------------------
// 3. A spent generation budget is not a tier failure
// --------------------------------------------------------------------------

test.describe("a spent row budget outranks the waterfall", () => {
  test.it("rethrows without advancing and without blaming the breaker", async () => {
    const calls: string[] = [];
    const breakers = new Map<string, ReturnType<typeof createCircuitBreaker>>();
    let failures = 0;
    const countingBreaker = {
      shouldAttempt: () => true,
      onSuccess: () => {},
      onFailure: () => {
        failures++;
      },
      state: () => ({ open: false, consecutiveFailures: 0, openUntil: 0 }),
    };
    const deps = fakeDeps(
      { "model-a": new GenerationDeadlineError(180_000, 180_500), "model-b": OK, "model-c": OK },
      { calls, breakers },
    );
    await assert.rejects(
      () => withChain(TEST_CHAIN, () => runLlm(baseArgs, { ...deps, breakerFor: () => countingBreaker as never })),
      GenerationDeadlineError,
    );
    assert.deepEqual(calls, ["model-a"], "the chain must stop, not merely fail");
    assert.equal(failures, 0, "a deadline is not the vendor's fault and must not open its breaker");
  });
});

// --------------------------------------------------------------------------
// 4. Usage accounting
// --------------------------------------------------------------------------

test.describe("usage accounting", () => {
  test.it("records the serving tier under the caller's ledger label", async () => {
    const recorded: Recorded[] = [];
    await withChain(TEST_CHAIN, () =>
      runLlmDraft(
        { ...baseArgs, usage: { kind: "pipeline", label: "draft" } },
        fakeDeps({ "model-a": OK }, { recorded }),
      ),
    );
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].model, "model-a");
    assert.equal(recorded[0].label, "draft");
  });

  test.it("subtracts cached tokens from input and folds thinking tokens into output", async () => {
    // Both vendors bill hidden reasoning/thinking at the OUTPUT rate. Counting
    // only the visible answer understates a reasoning model by several
    // multiples — the trap that makes gpt-5-nano look cheaper than it is.
    const recorded: Recorded[] = [];
    await withChain(TEST_CHAIN, () =>
      runLlmDraft(
        { ...baseArgs, usage: { kind: "pipeline", label: "draft" } },
        fakeDeps({ "model-a": OK }, { recorded }),
      ),
    );
    // Gemini fake: prompt 100, cached 40, candidates 20, thoughts 5.
    assert.deepEqual(recorded[0].usage, { inputTokens: 60, outputTokens: 25, cachedInputTokens: 40 });
  });

  test.it("does not double-count OpenAI reasoning tokens", async () => {
    // completion_tokens ALREADY includes reasoning_tokens in the OpenAI usage
    // block. Adding them again would double the dearest half of the bill.
    const recorded: Recorded[] = [];
    await withChain("openai:model-b@none", () =>
      runLlmDraft(
        { ...baseArgs, usage: { kind: "pipeline", label: "draft" } },
        fakeDeps({ "model-b": OK }, { recorded }),
      ),
    );
    // OpenAI fake: prompt 100, cached 40, completion 25 (of which 5 reasoning).
    assert.deepEqual(recorded[0].usage, { inputTokens: 60, outputTokens: 25, cachedInputTokens: 40 });
  });

  test.it("records a billed call even when its answer was unusable", async () => {
    // The tier charged us. A ledger that only counts answers we liked
    // under-reports spend, and the daily budget cap reads that ledger.
    const recorded: Recorded[] = [];
    await withChain(TEST_CHAIN, () =>
      runLlmDraft(
        { ...baseArgs, usage: { kind: "pipeline", label: "draft" } },
        fakeDeps({ "model-a": "not json at all", "model-b": OK }, { recorded }),
      ),
    );
    assert.deepEqual(recorded.map((r) => r.model), ["model-a", "model-b"]);
  });

  test.it("records nothing when the caller asks for no sink", async () => {
    const recorded: Recorded[] = [];
    await withChain(TEST_CHAIN, () =>
      runLlmDraft({ ...baseArgs, usage: { kind: "none" } }, fakeDeps({ "model-a": OK }, { recorded })),
    );
    assert.equal(recorded.length, 0);
  });
});

// --------------------------------------------------------------------------
// 5. Breakers
// --------------------------------------------------------------------------

test.describe("circuit breakers", () => {
  test.it("opens after the threshold and then skips the model without calling it", async () => {
    const breakers = new Map<string, ReturnType<typeof createCircuitBreaker>>();
    const down = new Error("Gemini HTTP 503: UNAVAILABLE");

    // Three failures trip model-a's breaker (threshold 3).
    for (let i = 0; i < 3; i++) {
      const calls: string[] = [];
      await withChain(TEST_CHAIN, () =>
        runLlm(baseArgs, fakeDeps({ "model-a": down, "model-b": OK }, { calls, breakers })),
      );
      assert.ok(calls.includes("model-a"), `attempt ${i + 1} should still probe model-a`);
    }

    // Fourth call: the breaker is open, so model-a is not attempted at all.
    const calls: string[] = [];
    const res = await withChain(TEST_CHAIN, () =>
      runLlm(baseArgs, fakeDeps({ "model-b": OK }, { calls, breakers })),
    );
    assert.deepEqual(calls, ["model-b"]);
    assert.equal(res.model, "model-b");
  });

  test.it("is keyed by model, so one role's discovery serves every role", () => {
    // Flash-Lite writes drafts, summaries and ack-confirms. If it is down, the
    // first role to find out should spare the other two the retry latency.
    __resetBreakersForTests();
    const a = breakerFor("gemini-3.1-flash-lite");
    const b = breakerFor("gemini-3.1-flash-lite");
    assert.equal(a, b, "same model must resolve to the same breaker instance");
    assert.notEqual(a, breakerFor("gpt-5.4-nano"));
  });

  test.it("a success closes the breaker again", async () => {
    const breakers = new Map<string, ReturnType<typeof createCircuitBreaker>>();
    const down = new Error("Gemini HTTP 503: UNAVAILABLE");
    // Two failures — one short of the threshold.
    for (let i = 0; i < 2; i++) {
      await withChain(TEST_CHAIN, () =>
        runLlm(baseArgs, fakeDeps({ "model-a": down, "model-b": OK }, { breakers })),
      );
    }
    // A success clears the run, so the next two failures must not open it.
    await withChain(TEST_CHAIN, () => runLlm(baseArgs, fakeDeps({ "model-a": OK }, { breakers })));
    const calls: string[] = [];
    await withChain(TEST_CHAIN, () =>
      runLlm(baseArgs, fakeDeps({ "model-a": down, "model-b": OK }, { calls, breakers })),
    );
    assert.ok(calls.includes("model-a"), "the breaker should have been reset by the success");
  });
});

// --------------------------------------------------------------------------
// 6. Helpers
// --------------------------------------------------------------------------

test.describe("classifyFailure", () => {
  test.it("labels capacity walls, safety blocks and everything else", () => {
    assert.equal(classifyFailure(new Error("Gemini HTTP 503: UNAVAILABLE")), "capacity");
    assert.equal(classifyFailure(new Error("OpenAI HTTP 429: Rate limit reached")), "capacity");
    assert.equal(classifyFailure(new Error("RESOURCE_EXHAUSTED")), "capacity");
    assert.equal(classifyFailure(new Error("The operation was aborted (timeout)")), "capacity");
    assert.equal(classifyFailure(new Error("Gemini blocked the request: SAFETY")), "safety");
    assert.equal(classifyFailure(new Error("something else entirely")), "error");
  });

  test.it("does not read a stray number in an error body as a capacity wall", () => {
    // Both transports append a 300-char body preview to their errors, and that
    // preview can easily contain a "500" that has nothing to do with the status
    // — a token count, a quota figure, a model name. Mislabelling it would make
    // the log lie about why a batch shifted tiers.
    assert.equal(
      classifyFailure(new Error('Gemini HTTP 400: {"error":{"message":"maxOutputTokens 500 exceeds..."}}')),
      "error",
    );
    assert.equal(classifyFailure(new Error("OpenAI HTTP 503: service unavailable")), "capacity");
    assert.equal(classifyFailure(new Error("Gemini HTTP 502: bad gateway")), "capacity");
  });
});

test.describe("extractFirstJsonObject", () => {
  test.it("takes the FIRST balanced object, not everything up to the last brace", () => {
    // Some models append a second object or a note. Slicing to the last brace
    // would swallow it and fail to parse a perfectly good first answer.
    assert.equal(extractFirstJsonObject('{"a":1} {"b":2}'), '{"a":1}');
  });
  test.it("does not end early on a brace inside a string", () => {
    assert.equal(extractFirstJsonObject('{"a":"}"}'), '{"a":"}"}');
  });
  test.it("handles escaped quotes", () => {
    assert.equal(extractFirstJsonObject('{"a":"say \\"hi\\" }"}'), '{"a":"say \\"hi\\" }"}');
  });
  test.it("returns null when there is no object", () => {
    assert.equal(extractFirstJsonObject("no braces here"), null);
  });
});

test.describe("parseLlmJson", () => {
  test.it("strips code fences", () => {
    assert.deepEqual(parseLlmJson('```json\n{"a":1}\n```'), { a: 1 });
  });
  test.it("throws on genuinely unparseable text so the router can advance", () => {
    assert.throws(() => parseLlmJson("I cannot help with that."));
  });
});

// --------------------------------------------------------------------------
// 7. The thinking/reasoning budget trap
// --------------------------------------------------------------------------

test.describe("thinking and reasoning budgets do not eat the answer", () => {
  test.it("Gemini: a thinking level adds headroom above the caller's cap", async () => {
    const { budgetForThinking } = await import("../lib/gemini");
    // The bug this locks, found live on 27 Aug 2026: reply_sentiment asks for
    // maxOutputTokens 200 because its ANSWER is ~35 tokens. Its tier 1 runs LOW
    // thinking, which measured 138-181 tokens on that exact task — and Gemini
    // counts thinking against the same cap. The response was not an error, it
    // was a TRUNCATED string that arrived as unparseable JSON, roughly half the
    // time. The waterfall covered it, but it burned a tier on every other call.
    assert.ok(budgetForThinking(200, "LOW") >= 200 + 181, "LOW must clear the measured 181-token thinking spend");
    assert.ok(budgetForThinking(200, "MEDIUM") > budgetForThinking(200, "LOW"));
    assert.ok(budgetForThinking(200, "HIGH") > budgetForThinking(200, "MEDIUM"));
  });

  test.it("Gemini: MINIMAL and no-thinking are left exactly as the caller asked", () => {
    // Unused headroom costs nothing (only generated tokens bill), but silently
    // changing a cap the caller set for a zero-thinking model would be a
    // surprise with no upside.
    return import("../lib/gemini").then(({ budgetForThinking }) => {
      assert.equal(budgetForThinking(200, "MINIMAL"), 200);
      assert.equal(budgetForThinking(200, null), 200);
    });
  });

  test.it("OpenAI: a reasoning effort adds headroom, and 'none' does not", async () => {
    const { budgetForReasoning } = await import("../lib/openai");
    // Same trap, worse symptom: OpenAI returns finish_reason=length with an
    // EMPTY message when reasoning consumes the whole budget, so the tier looks
    // broken rather than truncated.
    assert.equal(budgetForReasoning(200, "none"), 200);
    assert.equal(budgetForReasoning(200, undefined), 200);
    assert.ok(budgetForReasoning(200, "low") > 200);
    assert.ok(budgetForReasoning(200, "xhigh") > budgetForReasoning(200, "high"));
  });

  test.it("every role's small-output callers survive their chain's thinking tiers", async () => {
    // A structural check rather than a live one: the roles whose callers cap
    // output tightly (ack_confirm at 32, reply_sentiment at 200, summarizer at
    // 300) must have enough headroom on EVERY tier to hold both the reasoning
    // and the answer.
    const { getChain } = await import("../lib/modelPolicy");
    const { budgetForThinking } = await import("../lib/gemini");
    const { budgetForReasoning } = await import("../lib/openai");
    const TIGHT: Array<[string, number]> = [
      ["ack_confirm", 32],
      ["reply_sentiment", 200],
      ["summarizer", 300],
    ];
    for (const [role, cap] of TIGHT) {
      for (const tier of getChain(role as never)) {
        const budget =
          tier.provider === "gemini"
            ? budgetForThinking(cap, tier.thinking ?? null)
            : budgetForReasoning(cap, tier.effort);
        assert.ok(
          budget >= cap,
          `${role}/${tier.model}: headroom must never reduce the caller's cap`,
        );
        // If the tier reasons at all, the budget must clear the answer by a
        // wide margin — not by the handful of tokens that made this
        // intermittent in the first place.
        const reasons = tier.provider === "gemini" ? tier.thinking && tier.thinking !== "MINIMAL" : tier.effort && tier.effort !== "none";
        if (reasons) {
          assert.ok(
            budget >= cap + 512,
            `${role}/${tier.model} reasons but has only ${budget - cap} tokens of headroom`,
          );
        }
      }
    }
  });
});

// --------------------------------------------------------------------------
// 8. The diagnostics observer
// --------------------------------------------------------------------------

test.describe("diagnostics observer", () => {
  test.it("is off by default and reports every BILLED call when attached", async () => {
    // It measures what was billed, not what was accepted — so a bench's cost
    // figure includes a tier that answered off-contract and was fallen past.
    // Anything else would flatter the chain.
    const seen: LlmCallObservation[] = [];
    setLlmCallObserver((o) => seen.push(o));
    try {
      await withChain(TEST_CHAIN, () =>
        runLlmDraft(baseArgs, fakeDeps({ "model-a": "not json at all", "model-b": OK })),
      );
    } finally {
      setLlmCallObserver(null);
    }
    assert.deepEqual(seen.map((o) => o.model), ["model-a", "model-b"]);
    assert.equal(seen[1].tierIndex, 2);
    assert.equal(seen[1].provider, "openai");
    assert.deepEqual(seen[0].usage, { inputTokens: 60, outputTokens: 25, cachedInputTokens: 40 });
  });

  test.it("detaches cleanly, so one bench cannot leak into the next", async () => {
    const seen: LlmCallObservation[] = [];
    setLlmCallObserver((o) => seen.push(o));
    setLlmCallObserver(null);
    await withChain(TEST_CHAIN, () => runLlmDraft(baseArgs, fakeDeps({ "model-a": OK })));
    assert.equal(seen.length, 0);
  });
});
