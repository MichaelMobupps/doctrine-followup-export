/**
 * RETIRED — the Anthropic client. Nothing on a production path imports this.
 *
 * Aug 2026: the Anthropic account's card was declined, so every LLM role moved
 * to Gemini and OpenAI. See lib/modelPolicy.ts for what runs where and
 * lib/llmRouter.ts for how a role's fallback waterfall is walked.
 *
 * The module is kept rather than deleted for two reasons, both about not losing
 * information:
 *
 *   1. Archived comparison scripts (src/scripts/archive-anthropic-era/) still
 *      reference these model constants. They are the record of how the Gemini
 *      tiers were validated against Sonnet in the first place, and they should
 *      still typecheck.
 *   2. The MODEL_* constants document what each stage used to run on, which is
 *      the baseline every cost claim in TODO-llm-cost-migration.md is measured
 *      against.
 *
 * WHAT CHANGED HERE
 *
 * The module used to `throw` at import time when ANTHROPIC_API_KEY was unset —
 * a deliberate fail-loud-at-boot when Anthropic was load-bearing. It is no
 * longer load-bearing, and a server that refuses to start without a key it will
 * never use is a worse failure than the one that guard was written to prevent.
 * The client is now built lazily and throws only if something actually tries to
 * call it, which is exactly the signal we want: a loud, specific error naming
 * the ban, at the call site that violated it.
 *
 * To bring Anthropic back: restore a chain entry in lib/modelPolicy.ts and
 * delete assertNoAnthropic. That is deliberately a visible code edit rather
 * than an env flag, because re-enabling it is a billing decision.
 */
import Anthropic from "@anthropic-ai/sdk";

let client: Anthropic | null = null;

/**
 * The Anthropic client, built on first use.
 *
 * Every property access goes through this proxy, so merely importing the module
 * — which the archived scripts and a couple of type-only imports still do — is
 * free, and only an actual API call trips the guard.
 */
export const anthropic: Anthropic = new Proxy({} as Anthropic, {
  get(_target, prop, receiver) {
    if (!client) {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        throw new Error(
          "ANTHROPIC_API_KEY is not set, and Anthropic is disabled anyway " +
            "(the account is unfunded as of Aug 2026). Every LLM role runs on " +
            "Gemini or OpenAI — see lib/modelPolicy.ts. If you reached this " +
            "from production code, that code should be using lib/llmRouter.ts.",
        );
      }
      client = new Anthropic({
        // Reasonable network timeouts. The SDK default is 10min, way too long
        // for a user-facing follow-up pipeline.
        apiKey,
        timeout: 60 * 1000,
        maxRetries: 0,
      });
    }
    return Reflect.get(client as object, prop, receiver);
  },
});

/**
 * Centralized model identifiers. Single source of truth — every call site
 * imports the named constant for its role and never hardcodes a model
 * string. Swapping a model is a one-line change here.
 *
 * Critic cost policy (Jun 2026): every critic stage runs on Sonnet. Opus is
 * BANNED as a critic — at 5.00 / 25.00 USD per 1M tokens it is far too
 * expensive for the high-volume critic stage. assertCriticModelAllowed()
 * enforces the ban at each critic call site, and withOpusReasoning() (below)
 * now injects the Opus-only adaptive-thinking + high-effort fields only when a
 * call actually targets an Opus model, so it is a transparent passthrough for
 * the Sonnet critic. The whole pipeline — summarizer, generator, critic,
 * rewriter — therefore runs on Sonnet 4.6 with its default adaptive thinking.
 *   - CRITIC_PROVIDER=gemini can move the critic to Gemini for further savings.
 *
 * Roles:
 *   SUMMARIZER       — short JSON summary + language detect on inbound email
 *                      (low max_tokens, latency-sensitive)
 *   DRAFT_GENERATOR  — composes the follow-up subject + body
 *   CRITIC           — scores and flags issues; runs on Sonnet. Opus is
 *                      BANNED as a critic on cost grounds (see the ban note
 *                      below and assertCriticModelAllowed).
 *   REWRITER         — applies critic feedback and outputs a revised draft
 */
export const MODEL_SUMMARIZER:      "claude-sonnet-4-6" = "claude-sonnet-4-6";
export const MODEL_DRAFT_GENERATOR: "claude-sonnet-4-6" = "claude-sonnet-4-6";
// Opus is permanently banned as a critic. At 5.00 / 25.00 USD per 1M
// input/output tokens it is far too expensive for the high-volume critic
// stage, which runs on Sonnet (3.00 / 15.00) or, via CRITIC_PROVIDER=gemini,
// on Gemini. assertCriticModelAllowed() enforces this at every critic call
// site so the constant cannot silently regress to Opus.
export const MODEL_CRITIC:          "claude-sonnet-4-6" = "claude-sonnet-4-6";
export const MODEL_CRITIC_FALLBACK: "claude-sonnet-4-6" = "claude-sonnet-4-6";
export const MODEL_REWRITER:        "claude-sonnet-4-6" = "claude-sonnet-4-6";

/**
 * Phase 7b: model identifiers for the Context Based Followuper.
 *
 * Same 3-call pipeline shape as the Doctrine flow (Sonnet → Opus → Sonnet),
 * separate constants so the two products can be retuned independently.
 *
 * Roles:
 *   CONTEXT_GENERATOR — drafts the follow-up referencing prior thread context
 *   CONTEXT_CRITIC    — Opus critic; catches hallucinations, off-tone, length violations
 *   CONTEXT_REWRITER  — applies critic feedback to produce the final draft
 */
export const MODEL_CONTEXT_GENERATOR: "claude-sonnet-4-6" = "claude-sonnet-4-6";
// Critic on Sonnet. Opus is banned as a critic (cost) across every flow.
export const MODEL_CONTEXT_CRITIC:    "claude-sonnet-4-6" = "claude-sonnet-4-6";
export const MODEL_CONTEXT_REWRITER:  "claude-sonnet-4-6" = "claude-sonnet-4-6";
// B9c.2: AntiGhosting flow uses the same models as Context for now.
// Aliases let us swap independently later without touching call sites.
export const MODEL_ANTI_GHOSTING_GENERATOR: "claude-sonnet-4-6" = "claude-sonnet-4-6";
// Critic on Sonnet. Opus is banned as a critic (cost) across every flow.
export const MODEL_ANTI_GHOSTING_CRITIC:    "claude-sonnet-4-6" = "claude-sonnet-4-6";
export const MODEL_ANTI_GHOSTING_REWRITER:  "claude-sonnet-4-6" = "claude-sonnet-4-6";

// Company-Reply Cascade: classifies a single inbound reply as
// positive/negative/ooo. A cheap, high-volume judgement (one short call per
// genuine reply), so it stays on Sonnet. The conservative tie-break lives in
// the prompt, not the model tier.
export const MODEL_REPLY_CLASSIFIER: "claude-sonnet-4-6" = "claude-sonnet-4-6";

/**
 * Adaptive thinking on high effort for the Opus 4.8 critic stages.
 *
 * Opus 4.8 supports only adaptive thinking; setting a manual
 * thinking.budget_tokens returns a 400. The `effort` field (inside
 * output_config) is the recommended way to control thinking depth, and
 * "high" is the default tier where the model almost always thinks.
 *
 * The pinned @anthropic-ai/sdk@0.65 predates these fields, so its
 * MessageCreateParams type does not declare them. We type the shape
 * locally and merge it into the request through a single documented cast
 * in withOpusReasoning(). The SDK serializes unknown body fields as-is,
 * so the parameters still reach the API on 0.65. When the SDK is bumped
 * to a version that ships these fields (>= 0.100), this constant can be
 * inlined into the params type and the cast removed.
 */
export interface OpusReasoningParams {
  thinking: { type: "adaptive" };
  output_config: { effort: "high" };
}

export const OPUS_REASONING: OpusReasoningParams = {
  thinking: { type: "adaptive" },
  output_config: { effort: "high" },
};

/**
 * Merge base messages.create params with the Opus reasoning config.
 *
 * Call sites pass a normal MessageCreateParamsNonStreaming object (fully
 * type-checked for model / max_tokens / system / messages), and this
 * helper layers the reasoning fields on top. The cast is localized here
 * so the rest of the codebase stays typed against the installed SDK.
 *
 * Usage:
 *   anthropic.messages.create(withOpusReasoning({
 *     model: MODEL_CRITIC,
 *     max_tokens: 16000,
 *     system: ...,
 *     messages: [...],
 *   }))
 */
export function withOpusReasoning(
  params: Anthropic.Messages.MessageCreateParamsNonStreaming,
): Anthropic.Messages.MessageCreateParamsNonStreaming {
  // The Opus reasoning fields (adaptive thinking + high effort) are valid
  // ONLY on an Opus model. Every critic stage now runs on Sonnet (Opus is
  // banned as a critic — see assertCriticModelAllowed), so this helper injects
  // the reasoning config only when the call actually targets an Opus model and
  // is a transparent passthrough otherwise. That guarantees the Opus-only
  // params never reach a Sonnet request (which would 400) while leaving the
  // three critic call sites untouched.
  if (!isOpusModel(params.model)) {
    return params;
  }
  // Cast through `unknown`: SDK 0.65 declares `thinking` with an
  // incompatible shape (the adaptive variant lands in >= 0.100), so a
  // direct cast is rejected. Routing through unknown is the localized,
  // documented escape until the SDK is bumped.
  return {
    ...params,
    ...OPUS_REASONING,
  } as unknown as Anthropic.Messages.MessageCreateParamsNonStreaming;
}

/**
 * True for any model in the Opus family (claude-opus-4-8, a future
 * claude-opus-4-9, etc.). Sonnet, Haiku, and Gemini model strings never
 * contain "opus", so the substring test is sufficient and forward-compatible.
 */
export function isOpusModel(model: string): boolean {
  return /opus/i.test(model);
}

/**
 * Hard ban on Opus as a critic model. Opus is too expensive for the
 * high-volume critic stage; the critic runs on Sonnet (or Gemini via
 * CRITIC_PROVIDER). Call this at every critic call site so that if the model
 * constant is ever edited back to an Opus identifier the call fails loudly
 * instead of silently billing Opus rates. Throwing here is safe: every critic
 * caller already degrades gracefully when the critic throws (it ships the best
 * draft seen), so a misconfiguration costs quality, never a Opus bill.
 */
export function assertCriticModelAllowed(model: string): void {
  if (isOpusModel(model)) {
    throw new Error(
      `Opus is not permitted as a critic model (got "${model}"). The critic ` +
        `stage must run on Sonnet or Gemini. See MODEL_CRITIC in lib/anthropic.ts.`,
    );
  }
}

/**
 * CB-1: build a system prompt as cache-enabled content blocks.
 *
 * The follow-up pipeline sends large, fully static system prompts on every
 * draft, critic, and rewriter call. Prompt caching bills cache reads at 10%
 * of the input rate, so caching the static system prefix removes most of the
 * repeated input cost across a processing batch and across the healing loop,
 * with no change to model, output, or behavior.
 *
 * The cache breakpoint sits on the LAST block, so the whole concatenated
 * prefix up to and including it is cached. Pass the static parts in order
 * (the untrusted-data clause first, then the role prompt). The pinned
 * @anthropic-ai/sdk@0.65 already types cache_control on text blocks.
 */
/**
 * CB-2 (cost) — prompt-cache TTL. Default flipped from 1h to 5m by Anthropic
 * on 6 Mar 2026; our 15-minute cron tick means a 5m prefix dies before reuse,
 * so every call pays the 1.25x write surcharge and never reads. Pin to 1h:
 * first call of the hour writes (2x), the next ~4 ticks read (0.1x), and
 * reads are exempt from rate-limit accounting. 1h is GA on the API and needs
 * no beta header. Override with PROMPT_CACHE_TTL=5m to revert without a code
 * change (only sensible if call cadence ever drops below one call per hour).
 */
type PromptCacheTtl = "5m" | "1h";

export const PROMPT_CACHE_TTL: PromptCacheTtl =
  process.env.PROMPT_CACHE_TTL === "5m" ? "5m" : "1h";

export function cachedSystem(
  ...parts: string[]
): Anthropic.Messages.TextBlockParam[] {
  return parts.map((text, index) => {
    const block: Anthropic.Messages.TextBlockParam = { type: "text", text };
    if (index === parts.length - 1) {
      // ttl is a first-class, typed field on CacheControlEphemeral in
      // @anthropic-ai/sdk@0.65 (ttl?: "5m" | "1h"), so no cast is needed.
      block.cache_control = { type: "ephemeral", ttl: PROMPT_CACHE_TTL };
    }
    return block;
  });
}
