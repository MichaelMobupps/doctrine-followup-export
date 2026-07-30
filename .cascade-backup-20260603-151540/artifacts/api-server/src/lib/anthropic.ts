/**
 * Direct Anthropic SDK client.
 *
 * Replaces the prior `@workspace/integrations-anthropic-ai` wrapper, which
 * routed requests through Replit's AI Integrations proxy. The proxy dependency
 * caused production-silent outages: when Replit's integration was not
 * configured on the deployment, every call returned 404 "Replit AI Integrations
 * is not configured", and the pipeline silently degraded to a broken
 * hard-coded fallback.
 *
 * This module talks to api.anthropic.com directly with ANTHROPIC_API_KEY.
 * Single source of credentials, single import site, clearer error messages.
 *
 * The exported `anthropic` object is API-compatible with the previous wrapper
 * (both use the official @anthropic-ai/sdk underneath) so callers only change
 * the import line.
 */
import Anthropic from "@anthropic-ai/sdk";

const apiKey = process.env.ANTHROPIC_API_KEY;

if (!apiKey) {
  // Fail loudly at boot rather than on first request — a missing API key is
  // a config problem, not a runtime problem, and should be visible immediately
  // in the deploy logs.
  throw new Error(
    "ANTHROPIC_API_KEY is not set. Add it as a Replit Secret for both the " +
      "workspace and the deployment. Get a key at https://console.anthropic.com/",
  );
}

export const anthropic = new Anthropic({
  apiKey,
  // Reasonable network timeouts. The SDK default is 10min, way too long for
  // a user-facing follow-up pipeline. If a request is still pending after 60s,
  // it's better to fail and let our retry layer try again.
  timeout: 60 * 1000,
  maxRetries: 0, // We implement our own retry logic with visibility and logging.
});

/**
 * Centralized model identifiers. Single source of truth — every call site
 * imports the named constant for its role and never hardcodes a model
 * string. Swapping a model is a one-line change here.
 *
 * Opus 4.8 upgrade (May 2026): the three critic stages run on
 * claude-opus-4-8 with adaptive thinking on high effort. Opus 4.8
 * supports only adaptive thinking (manual budget_tokens returns 400),
 * and effort is the recommended depth control. The reasoning config is
 * applied through withOpusReasoning() at each critic call site so the
 * thinking + effort settings stay in one place. See the helper below.
 *   - Sonnet 4.6 (summarizer / generator / rewriter) keeps default
 *     adaptive thinking because no override is set.
 *   - Opus 4.8 (critic) sets adaptive thinking + high effort explicitly.
 * Adaptive thinking is therefore active across the entire pipeline.
 *
 * Roles:
 *   SUMMARIZER       — short JSON summary + language detect on inbound email
 *                      (low max_tokens, latency-sensitive)
 *   DRAFT_GENERATOR  — composes the follow-up subject + body
 *   CRITIC           — scores and flags issues; uses Opus for judgment quality
 *   REWRITER         — applies critic feedback and outputs a revised draft
 */
export const MODEL_SUMMARIZER:      "claude-sonnet-4-6" = "claude-sonnet-4-6";
export const MODEL_DRAFT_GENERATOR: "claude-sonnet-4-6" = "claude-sonnet-4-6";
export const MODEL_CRITIC:          "claude-opus-4-8"   = "claude-opus-4-8";
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
export const MODEL_CONTEXT_CRITIC:    "claude-opus-4-8"   = "claude-opus-4-8";
export const MODEL_CONTEXT_REWRITER:  "claude-sonnet-4-6" = "claude-sonnet-4-6";
// B9c.2: AntiGhosting flow uses the same models as Context for now.
// Aliases let us swap independently later without touching call sites.
export const MODEL_ANTI_GHOSTING_GENERATOR: "claude-sonnet-4-6" = "claude-sonnet-4-6";
export const MODEL_ANTI_GHOSTING_CRITIC:    "claude-opus-4-8"   = "claude-opus-4-8";
export const MODEL_ANTI_GHOSTING_REWRITER:  "claude-sonnet-4-6" = "claude-sonnet-4-6";

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
  // Cast through `unknown`: SDK 0.65 declares `thinking` with an
  // incompatible shape (the adaptive variant lands in >= 0.100), so a
  // direct cast is rejected. Routing through unknown is the localized,
  // documented escape until the SDK is bumped.
  return {
    ...params,
    ...OPUS_REASONING,
  } as unknown as Anthropic.Messages.MessageCreateParamsNonStreaming;
}
