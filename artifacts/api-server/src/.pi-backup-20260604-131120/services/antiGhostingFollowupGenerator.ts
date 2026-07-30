/**
 * B9c.2: AntiGhosting follow-up generator.
 *
 * Mirrors contextFollowupGenerator.ts in shape — Sonnet writer -> Opus
 * critic -> Sonnet rewriter, JSON-only output, three-call pipeline with
 * graceful fallbacks on critic or rewriter failure.
 *
 * The AntiGhosting prompts (writer/critic/rewriter) enforce the
 * ACKNOWLEDGE -> BRIDGE -> ASK structure, the forbidden-phrase list,
 * and the tone-tier rules. The critic dimensions and forbidden phrases
 * are specific to re-engagement; otherwise the call shape is identical
 * to the existing flows.
 *
 * Sign-off stripping (B8a) runs as the final step on every return path
 * via finalize(). The deterministic doctrineLint pre-flight (Latin
 * token leaks in non-Latin-script bodies) is wired in identically to
 * the context flow.
 */

import {
  anthropic,
  MODEL_ANTI_GHOSTING_GENERATOR,
  MODEL_ANTI_GHOSTING_CRITIC,
  MODEL_ANTI_GHOSTING_REWRITER,
  withOpusReasoning,
} from "../lib/anthropic";
import { withAnthropicRetry } from "./anthropicRetry";
import { recordUsageBestEffort } from "../lib/usageTracker";
import {
  ANTI_GHOSTING_GENERATOR_SYSTEM,
  ANTI_GHOSTING_CRITIC_SYSTEM,
  ANTI_GHOSTING_REWRITER_SYSTEM,
  getAntiGhostingGeneratorUserPrompt,
  getAntiGhostingCriticUserPrompt,
  getAntiGhostingRewriterUserPrompt,
} from "./antiGhostingFollowupPrompts";
import type { AntiGhostingFollowupContext } from "./antiGhostingFollowupPrompts";
import { logger } from "../lib/logger";
import { detectAllDeterministicViolations } from "../lib/doctrineLint";
import { stripClosingFromBody } from "./signatureStripper";

export interface GeneratedAntiGhostingFollowup {
  subject: string;
  body: string;
}

interface AntiGhostingCriticResult {
  scores: Record<string, number>;
  overall: number;
  issues: string[];
  suggestions: string[];
  needs_rewrite: boolean;
}

function parseJsonResponse(raw: string): unknown {
  const cleaned = raw.replace(/```json\s*|```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // Models sometimes wrap JSON in commentary. Pull the first {...} block.
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        // fall through
      }
    }
    throw new SyntaxError(
      `Failed to parse AntiGhosting follow-up JSON: ${cleaned.slice(0, 200)}...`,
    );
  }
}

async function generateAntiGhostingDraft(
  ctx: AntiGhostingFollowupContext,
  attempt = 1,
): Promise<GeneratedAntiGhostingFollowup> {
  const maxAttempts = 2;
  const response = await withAnthropicRetry(
    () => anthropic.messages.create({
      model: MODEL_ANTI_GHOSTING_GENERATOR,
      max_tokens: 4096,
      system: ANTI_GHOSTING_GENERATOR_SYSTEM,
      messages: [{ role: "user", content: getAntiGhostingGeneratorUserPrompt(ctx) }],
    }),
    { label: "anti-ghosting-draft" },
  );
  void recordUsageBestEffort(response, "anti_ghosting_generator");

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text in anti-ghosting-draft response");
  }

  try {
    const parsed = parseJsonResponse(textBlock.text) as { subject?: unknown; body?: unknown };
    if (!parsed.subject || parsed.body === undefined) {
      throw new Error("AntiGhosting draft missing subject or body");
    }
    return { subject: String(parsed.subject), body: String(parsed.body) };
  } catch (err) {
    logger.warn(
      { attempt, rawPreview: textBlock.text.slice(0, 300) },
      "AntiGhosting-draft JSON parse failed",
    );
    if (attempt < maxAttempts) {
      logger.info("Retrying anti-ghosting-draft generation...");
      return generateAntiGhostingDraft(ctx, attempt + 1);
    }
    throw err;
  }
}

async function critiqueAntiGhostingDraft(
  ctx: AntiGhostingFollowupContext,
  draft: GeneratedAntiGhostingFollowup,
): Promise<AntiGhostingCriticResult> {
  const response = await withAnthropicRetry(
    // Opus 4.8 critic: adaptive thinking on high effort. max_tokens raised
    // to 12000 so thinking plus the JSON verdict never truncates.
    () => anthropic.messages.create(withOpusReasoning({
      model: MODEL_ANTI_GHOSTING_CRITIC,
      max_tokens: 12000,
      system: ANTI_GHOSTING_CRITIC_SYSTEM,
      messages: [{ role: "user", content: getAntiGhostingCriticUserPrompt(ctx, draft) }],
    })),
    { label: "anti-ghosting-critic" },
  );
  void recordUsageBestEffort(response, "anti_ghosting_critic");

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text in anti-ghosting-critic response");
  }

  const parsed = parseJsonResponse(textBlock.text) as {
    scores?: Record<string, number>;
    overall?: unknown;
    issues?: unknown;
    suggestions?: unknown;
    needs_rewrite?: unknown;
  };
  return {
    scores: parsed.scores || {},
    overall: typeof parsed.overall === "number" ? parsed.overall : 5,
    issues: Array.isArray(parsed.issues) ? parsed.issues.map(String) : [],
    suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.map(String) : [],
    needs_rewrite: parsed.needs_rewrite === true,
  };
}

async function rewriteAntiGhostingDraft(
  ctx: AntiGhostingFollowupContext,
  draft: GeneratedAntiGhostingFollowup,
  critique: AntiGhostingCriticResult,
): Promise<GeneratedAntiGhostingFollowup> {
  const response = await withAnthropicRetry(
    () => anthropic.messages.create({
      model: MODEL_ANTI_GHOSTING_REWRITER,
      max_tokens: 4096,
      system: ANTI_GHOSTING_REWRITER_SYSTEM,
      messages: [{
        role: "user",
        content: getAntiGhostingRewriterUserPrompt(ctx, draft, {
          issues: critique.issues,
          suggestions: critique.suggestions,
        }),
      }],
    }),
    { label: "anti-ghosting-rewriter" },
  );
  void recordUsageBestEffort(response, "anti_ghosting_rewriter");

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text in anti-ghosting-rewriter response");
  }

  const parsed = parseJsonResponse(textBlock.text) as { subject?: unknown; body?: unknown };
  if (!parsed.subject || parsed.body === undefined) {
    logger.warn(
      { rawPreview: textBlock.text.slice(0, 300) },
      "AntiGhosting-rewriter produced invalid output — falling back to original draft",
    );
    return draft;
  }
  return { subject: String(parsed.subject), body: String(parsed.body) };
}

/**
 * Top-level entry point for the dispatcher. Same shape as
 * generateContextFollowup / generateFollowupEmail so the scheduler
 * can branch between them without restructuring the dispatch site.
 */
export async function generateAntiGhostingFollowup(
  ctx: AntiGhostingFollowupContext,
): Promise<GeneratedAntiGhostingFollowup> {
  // B8a sign-off stripper applied as the very last step on every return
  // path. The subject never carries a closing, only the body.
  const finalize = (draft: GeneratedAntiGhostingFollowup): GeneratedAntiGhostingFollowup => ({
    subject: draft.subject,
    body: stripClosingFromBody(draft.body),
  });

  const draft = await generateAntiGhostingDraft(ctx);

  let critique: AntiGhostingCriticResult;
  try {
    critique = await critiqueAntiGhostingDraft(ctx, draft);
  } catch (err) {
    // Critic failure is non-fatal: ship the original draft. The
    // forbidden-phrase rule will still be enforced server-side at
    // send time via deterministic post-checks; the critic is the
    // primary line of defence but not the only one.
    logger.warn({ err }, "AntiGhosting-critic call failed — shipping original draft");
    return finalize(draft);
  }

  // Deterministic pre-flight identical to the context flow. The Latin
  // token leak detector catches multi-word English phrases that slip
  // into non-Latin-script bodies (the Zekri pattern). Universal across
  // all three flows.
  const deterministicCheck = detectAllDeterministicViolations(draft.body, ctx.original_language);
  if (deterministicCheck.found) {
    critique.issues = [...deterministicCheck.issues, ...critique.issues];
    critique.suggestions = [...deterministicCheck.suggestions, ...critique.suggestions];
    critique.needs_rewrite = true;
    critique.overall = Math.min(critique.overall, 2);
    logger.info(
      { stage: ctx.stage, cycle: ctx.cycle, matches: deterministicCheck.matches.slice(0, 5) },
      "AntiGhosting deterministic violations detected — merging into critique",
    );
  }

  logger.info(
    {
      stage: ctx.stage,
      cycle: ctx.cycle,
      tier: ctx.days_since_seed_tier,
      overall: critique.overall,
      scores: critique.scores,
      needs_rewrite: critique.needs_rewrite,
      issuesCount: critique.issues.length,
    },
    "AntiGhosting follow-up critique completed",
  );

  if (!critique.needs_rewrite) {
    return finalize(draft);
  }

  try {
    const rewritten = await rewriteAntiGhostingDraft(ctx, draft, critique);
    logger.info({ stage: ctx.stage, cycle: ctx.cycle }, "AntiGhosting follow-up rewritten after critic feedback");
    return finalize(rewritten);
  } catch (err) {
    logger.warn(
      { err, stage: ctx.stage, cycle: ctx.cycle },
      "AntiGhosting-rewriter failed — shipping original draft",
    );
    return finalize(draft);
  }
}
