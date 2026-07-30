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
 * Phase 5 audit (May 2026): all four call sites verified to use the
 * standard messages.create API with no thinking.budget_tokens overrides.
 * Per Anthropic docs:
 *   - Opus 4.7 always uses adaptive reasoning; the fixed budget mode and
 *     CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING do not apply to it.
 *   - Sonnet 4.6 supports adaptive thinking by default and is in adaptive
 *     mode here because no override is set.
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
export const MODEL_CRITIC:          "claude-opus-4-7"   = "claude-opus-4-7";
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
export const MODEL_CONTEXT_CRITIC:    "claude-opus-4-7"   = "claude-opus-4-7";
export const MODEL_CONTEXT_REWRITER:  "claude-sonnet-4-6" = "claude-sonnet-4-6";
// B9c.2: AntiGhosting flow uses the same models as Context for now.
// Aliases let us swap independently later without touching call sites.
export const MODEL_ANTI_GHOSTING_GENERATOR: "claude-sonnet-4-6" = "claude-sonnet-4-6";
export const MODEL_ANTI_GHOSTING_CRITIC:    "claude-opus-4-7"   = "claude-opus-4-7";
export const MODEL_ANTI_GHOSTING_REWRITER:  "claude-sonnet-4-6" = "claude-sonnet-4-6";
