/**
 * smoke-llm-waterfall.ts — does the fallback waterfall actually work, live?
 *
 * test-llm-router.ts proves the chain-walking LOGIC with fake transports. This
 * proves the same thing against the real vendors, which is a different claim:
 * it exercises the actual HTTP error shapes, the actual auth failures, the
 * actual retry loops, and the actual per-model quirks (Gemini's thinking floors,
 * OpenAI's max_completion_tokens, both vendors' schema dialects).
 *
 * WHAT IT DOES
 *
 * Static, no network:
 *   S1  every role's chain has >= 2 tiers
 *   S2  every role's chain spans BOTH vendors
 *   S3  no chain names an Anthropic model (the Aug 2026 ban)
 *   S4  every tier has a real price row (an unpriced tier bills at
 *       DEFAULT_PRICE and corrupts the ledger the budget cap reads)
 *   S5  no chain names the same model twice (a repeated tier is a dead tier —
 *       its breaker is already open by the time the chain reaches it again)
 *
 * Live, one billed call each:
 *   L1  every role answers on its real chain, and we report which TIER served
 *   L2  FAULT INJECTION: prepend a model id that does not exist, and confirm
 *       the real tier 1 serves the call. This is the waterfall working against
 *       a genuine vendor 404, not a mocked throw.
 *   L3  CROSS-VENDOR FAULT INJECTION: prepend a broken tier from EACH vendor and
 *       confirm the call still lands. This is the property that a single-vendor
 *       chain cannot have, and the reason every chain alternates.
 *   L4  AUTH FAULT: point Gemini at a bad key so every Gemini tier fails, and
 *       confirm an OpenAI tier picks up the writer role. This is the closest
 *       safe simulation of a whole-vendor outage.
 *
 * SAFE: no DB writes, no email, nothing on the production usage ledger. Roughly
 * 20-30 short calls, well under a cent in total.
 *
 * RUN (from artifacts/api-server):
 *   node --import tsx src/scripts/smoke-llm-waterfall.ts
 *   node --import tsx src/scripts/smoke-llm-waterfall.ts --static-only
 *   node --import tsx src/scripts/smoke-llm-waterfall.ts --roles draft,critic
 *
 * Exit codes: 0 all checks passed; 1 a real failure; 2 a live check was blocked
 * by a vendor capacity wall on EVERY tier (an upstream problem, not a code one).
 */
import { runLlm, __resetBreakersForTests, type LlmResult } from "../lib/llmRouter";
import {
  ALL_LLM_ROLES,
  getChain,
  describeChain,
  isAnthropicModel,
  envVarForRole,
  type LlmRole,
} from "../lib/modelPolicy";
import { MODEL_PRICES, computeCostUsd } from "../lib/pricing";
import { isGeminiConfigured } from "../lib/gemini";
import { isOpenAiConfigured } from "../lib/openai";

let passed = 0;
let failed = 0;
let blocked = false;
let spend = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed++;
    console.log(`  PASS  ${name}${detail ? ` (${detail})` : ""}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` (${detail})` : ""}`);
  }
}

/**
 * A short, real prompt per role.
 *
 * Deliberately tiny — this smoke tests ROUTING, not writing quality (that is
 * scripts/bench-llm-quality.ts). Each prompt asks for the JSON shape that
 * role's real caller expects, so a tier that cannot hold that contract fails
 * here rather than in production.
 */
const ROLE_PROBE: Record<LlmRole, { system: string; user: string; maxTokens: number }> = {
  draft: {
    system: 'You write short sales follow-up emails. Return JSON: {"subject": string, "body": string}.',
    user: "Write a two-sentence follow-up to Alex at PixelForge Games about mobile game user acquisition.",
    maxTokens: 400,
  },
  rewriter: {
    system: 'You revise sales follow-up emails against feedback. Return JSON: {"subject": string, "body": string}.',
    user: 'Revise this to be one sentence shorter: {"subject":"Following up","body":"Hi Alex, checking in on my note about UA for PixelForge. Happy to share a test plan. Worth a quick look?"}',
    maxTokens: 400,
  },
  grey_draft: {
    system: 'You write short B2B follow-up emails. Return JSON: {"subject": string, "body": string}.',
    user: "Write a two-sentence follow-up to a sports betting operator about performance user acquisition.",
    maxTokens: 400,
  },
  grey_rewriter: {
    system: 'You revise B2B follow-up emails. Return JSON: {"subject": string, "body": string}.',
    user: 'Shorten by one sentence: {"subject":"Following up","body":"Hi, checking in on my note about UA. Happy to share a plan. Worth a look?"}',
    maxTokens: 400,
  },
  context_draft: {
    system: 'You write short thread follow-ups with no sales pitch. Return JSON: {"subject": string, "body": string}.',
    user: "Nudge for a reply on a thread about scheduling a Q3 integration call. Two sentences.",
    maxTokens: 400,
  },
  context_rewriter: {
    system: 'You revise thread follow-ups. Return JSON: {"subject": string, "body": string}.',
    user: 'Make this warmer: {"subject":"Re: Q3 call","body":"Any update on the call?"}',
    maxTokens: 400,
  },
  ag_draft: {
    system: 'You write short re-engagement emails. Return JSON: {"subject": string, "body": string}.',
    user: "Re-engage a prospect who went quiet after a demo. Two sentences.",
    maxTokens: 400,
  },
  ag_rewriter: {
    system: 'You revise re-engagement emails. Return JSON: {"subject": string, "body": string}.',
    user: 'Make this less pushy: {"subject":"Still there?","body":"You never replied. Are you interested or not?"}',
    maxTokens: 400,
  },
  critic: {
    system:
      'You grade a sales follow-up email. Return JSON: {"scores": object, "overall": number 1-5, "issues": string[], "suggestions": string[], "needs_rewrite": boolean}.',
    user: 'Grade this: {"subject":"Following up","body":"Hi Alex, just circling back on my previous email. Let me know!"}',
    maxTokens: 800,
  },
  context_critic: {
    system:
      'You grade a thread follow-up for invention and tone. Return JSON: {"scores": object, "overall": number 1-5, "issues": string[], "suggestions": string[], "needs_rewrite": boolean}.',
    user: 'Grade this: {"subject":"Re: Q3 call","body":"Any update on the call?"}',
    maxTokens: 800,
  },
  ag_critic: {
    system:
      'You grade a re-engagement email for tone. Return JSON: {"scores": object, "overall": number 1-5, "issues": string[], "suggestions": string[], "needs_rewrite": boolean}.',
    user: 'Grade this: {"subject":"Still there?","body":"You never replied. Are you interested or not?"}',
    maxTokens: 800,
  },
  summarizer: {
    system: 'Extract the topic of an email. Return JSON: {"summary": string, "language": string}.',
    user: "Hi Alex, reaching out from MobUpps about performance user acquisition for your mobile games.",
    maxTokens: 200,
  },
  reply_sentiment: {
    system:
      'Classify a reply. Return JSON: {"class": "positive"|"negative"|"ooo", "confidence": number, "reason": string}.',
    user: "Thanks but we already have a partner for this.",
    maxTokens: 200,
  },
  ack_confirm: {
    system: 'Does this email opening reference prior outreach? Return JSON: {"answer": "YES"} or {"answer": "NO"}.',
    user: "Hi Alex, following up on my email from last week about UA.",
    maxTokens: 64,
  },
};

/** A model id that will never exist. Both vendors answer a hard 404/400 for it. */
const BOGUS_GEMINI = "gemini-does-not-exist-9.9";
const BOGUS_OPENAI = "gpt-does-not-exist-9.9";

function costOf(r: LlmResult): number {
  return computeCostUsd(r.model, {
    inputTokens: r.usage.inputTokens,
    outputTokens: r.usage.outputTokens,
    cacheCreationTokens: 0,
    cacheReadTokens: r.usage.cachedInputTokens,
  });
}

async function probe(role: LlmRole): Promise<LlmResult> {
  const p = ROLE_PROBE[role];
  const r = await runLlm({
    role,
    systemParts: [p.system],
    user: p.user,
    maxOutputTokens: p.maxTokens,
    // Never touch the production ledger from a smoke run.
    usage: { kind: "none" },
  });
  spend += costOf(r);
  return r;
}

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const restore = () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  return fn().then(
    (r) => {
      restore();
      return r;
    },
    (e) => {
      restore();
      throw e;
    },
  );
}

function isCapacityWall(err: unknown): boolean {
  const m = String(err).toLowerCase();
  return m.includes("429") || m.includes("503") || m.includes("quota") || m.includes("rate limit");
}

function parseArgs() {
  const a = process.argv.slice(2);
  const get = (flag: string, dflt: string) => {
    const i = a.indexOf(flag);
    return i >= 0 && a[i + 1] ? a[i + 1] : dflt;
  };
  const rolesArg = get("--roles", "").trim();
  return {
    staticOnly: a.includes("--static-only"),
    roles: rolesArg
      ? (rolesArg.split(",").map((s) => s.trim()) as LlmRole[])
      : ALL_LLM_ROLES,
  };
}

async function main(): Promise<void> {
  const opts = parseArgs();
  console.log("\n=== LLM waterfall smoke ===\n");

  // ---------------------------------------------------------------- static
  console.log("[static] chain invariants — no network\n");
  for (const role of ALL_LLM_ROLES) {
    const chain = getChain(role);
    const vendors = new Set(chain.map((t) => t.provider));
    const models = chain.map((t) => t.model);
    const unpriced = models.filter((m) => MODEL_PRICES[m] === undefined);

    const ok =
      chain.length >= 2 &&
      vendors.size >= 2 &&
      !chain.some((t) => isAnthropicModel(t.model)) &&
      unpriced.length === 0 &&
      new Set(models).size === models.length;

    const problems: string[] = [];
    if (chain.length < 2) problems.push("only one tier");
    if (vendors.size < 2) problems.push(`single vendor (${[...vendors].join(",")})`);
    if (chain.some((t) => isAnthropicModel(t.model))) problems.push("names an Anthropic model");
    if (unpriced.length) problems.push(`unpriced: ${unpriced.join(",")}`);
    if (new Set(models).size !== models.length) problems.push("repeats a model");

    check(`${role.padEnd(17)} ${describeChain(chain)}`, ok, problems.join("; "));
  }

  if (opts.staticOnly) {
    summary();
    return;
  }

  if (!isGeminiConfigured() || !isOpenAiConfigured()) {
    failed++;
    console.log(
      `\n  FAIL  live checks need BOTH keys (GEMINI_API_KEY=${isGeminiConfigured()}, OPENAI_API_KEY=${isOpenAiConfigured()})`,
    );
    summary();
    return;
  }

  // ------------------------------------------------------------------ live
  console.log("\n[live] L1 — every role answers on its real chain\n");
  for (const role of opts.roles) {
    __resetBreakersForTests();
    try {
      const r = await probe(role);
      check(
        `${role.padEnd(17)} served by ${r.provider}:${r.model} (tier ${r.tierIndex})`,
        true,
        `$${costOf(r).toFixed(6)}`,
      );
    } catch (err) {
      if (isCapacityWall(err)) blocked = true;
      check(`${role.padEnd(17)} answers`, false, String(err).slice(0, 140));
    }
  }

  // L2 / L3 run on the writer and critic roles only. Every role shares the same
  // router, so proving it twice on two differently-shaped chains is the useful
  // amount; running it fourteen times would just be fourteen times the spend.
  const FAULT_ROLES: LlmRole[] = ["draft", "critic"];

  console.log("\n[live] L2 — fault injection: a dead tier 1 must fall through\n");
  for (const role of FAULT_ROLES) {
    __resetBreakersForTests();
    const real = getChain(role);
    const injected = `gemini:${BOGUS_GEMINI},${describeChain(real).split(" -> ").join(",")}`;
    try {
      const r = await withEnv({ [envVarForRole(role)]: injected }, () => probe(role));
      check(
        `${role}: dead Gemini tier 1 fell through to ${r.provider}:${r.model}`,
        r.tierIndex === 2 && r.model === real[0].model,
        `tier=${r.tierIndex} expected the real primary ${real[0].model}`,
      );
    } catch (err) {
      if (isCapacityWall(err)) blocked = true;
      check(`${role}: dead Gemini tier 1 falls through`, false, String(err).slice(0, 140));
    }
  }

  console.log("\n[live] L3 — cross-vendor fault injection: a dead tier from EACH vendor\n");
  for (const role of FAULT_ROLES) {
    __resetBreakersForTests();
    const real = getChain(role);
    const injected = `gemini:${BOGUS_GEMINI},openai:${BOGUS_OPENAI},${describeChain(real).split(" -> ").join(",")}`;
    try {
      const r = await withEnv({ [envVarForRole(role)]: injected }, () => probe(role));
      check(
        `${role}: two dead tiers across both vendors fell through to ${r.provider}:${r.model}`,
        r.tierIndex === 3 && r.model === real[0].model,
        `tier=${r.tierIndex}`,
      );
    } catch (err) {
      if (isCapacityWall(err)) blocked = true;
      check(`${role}: two dead tiers fall through`, false, String(err).slice(0, 140));
    }
  }

  console.log("\n[live] L4 — auth fault: a whole vendor down must not stop the pipeline\n");
  __resetBreakersForTests();
  try {
    // The closest safe simulation of a Google-side outage: a bad key makes every
    // Gemini tier fail authentication, so the chain has to reach OpenAI. If the
    // chain were single-vendor, this is exactly where it would have nothing left.
    const r = await withEnv({ GEMINI_API_KEY: "bad-key-for-smoke-only" }, () => probe("draft"));
    check(
      `draft: with Gemini unusable, ${r.provider}:${r.model} served (tier ${r.tierIndex})`,
      r.provider === "openai",
      `provider=${r.provider}`,
    );
  } catch (err) {
    if (isCapacityWall(err)) blocked = true;
    check("draft: an OpenAI tier serves when Gemini is unusable", false, String(err).slice(0, 140));
  }

  summary();
}

function summary(): void {
  console.log(`\n=== ${passed} passed, ${failed} failed — total spend $${spend.toFixed(6)} ===\n`);
}

function exitCode(): number {
  if (failed === 0) return 0;
  return blocked && failed > 0 ? 2 : 1;
}

main()
  .then(() => process.exit(exitCode()))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
