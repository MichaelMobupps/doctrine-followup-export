/**
 * Context-based follow-up generator — Phase 7b.
 *
 * Mirrors followupGenerator.ts in shape (Sonnet generator → Opus critic
 * → Sonnet rewriter, all adaptive thinking) but uses context-only prompts
 * with no doctrine principles.
 *
 * Goal: write follow-ups that nudge for a response on a previous email
 * thread, faithfully referencing the prior content with no invention,
 * marketing language, or sales pitch. The critic's job is to catch any
 * drift from those constraints; the rewriter applies the fixes.
 */

import { anthropic, MODEL_CONTEXT_GENERATOR, MODEL_CONTEXT_CRITIC, MODEL_CONTEXT_REWRITER } from "../lib/anthropic";
import { withAnthropicRetry } from "./anthropicRetry";
// B7r: usage tracker import. Safe outside a runWithUsageContext scope.
import { recordUsageBestEffort } from "../lib/usageTracker";
import type { FollowupContext } from "./followupPrompts";
import {
  CONTEXT_GENERATOR_SYSTEM,
  CONTEXT_CRITIC_SYSTEM,
  CONTEXT_REWRITER_SYSTEM,
  getContextGeneratorUserPrompt,
  getContextCriticUserPrompt,
  getContextRewriterUserPrompt,
} from "./contextFollowupPrompts";
import { logger } from "../lib/logger";
import { detectAllDeterministicViolations } from "../lib/doctrineLint";
// B8a: deterministic closing/signature stripper. Belt-and-suspenders
// safety net for the new prompt-level no-closing rule (CONTEXT generator
// constraint #9 and critic dimension `closing_strip`). Applied to every
// return path of generateContextFollowup so the body is always free of
// a sign-off before the email client appends the user signature.
import { stripClosingFromBody } from "./signatureStripper";

export interface GeneratedContextFollowup {
  subject: string;
  body: string;
}

interface ContextCriticResult {
  scores: Record<string, number>;
  overall: number;
  issues: string[];
  suggestions: string[];
  needs_rewrite: boolean;
}

function parseJsonResponse(raw: string): any {
  const cleaned = raw.replace(/```json\s*|```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch (firstErr) {
    // Sometimes models emit a JSON object embedded in commentary. Pull
    // the first {...} block and try that.
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        // fall through
      }
    }
    throw new SyntaxError(`Failed to parse Context follow-up JSON: ${cleaned.slice(0, 200)}...`);
  }
}

async function generateContextDraft(
  ctx: FollowupContext,
  attempt = 1,
): Promise<GeneratedContextFollowup> {
  const maxAttempts = 2;
  const response = await withAnthropicRetry(
    () => anthropic.messages.create({
      model: MODEL_CONTEXT_GENERATOR,
      max_tokens: 4096,
      system: CONTEXT_GENERATOR_SYSTEM,
      messages: [{ role: "user", content: getContextGeneratorUserPrompt(ctx) }],
    }),
    { label: "context-draft" },
  );
  // B7r: capture token usage for the activity log.
  void recordUsageBestEffort(response, "context_generator");

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text in context-draft response");
  }

  try {
    const parsed = parseJsonResponse(textBlock.text);
    if (!parsed.subject || !parsed.body) {
      throw new Error("Context draft missing subject or body");
    }
    return { subject: String(parsed.subject), body: String(parsed.body) };
  } catch (err) {
    logger.warn(
      { attempt, rawPreview: textBlock.text.slice(0, 300) },
      "Context-draft JSON parse failed",
    );
    if (attempt < maxAttempts) {
      logger.info("Retrying context-draft generation...");
      return generateContextDraft(ctx, attempt + 1);
    }
    throw err;
  }
}

async function critiqueContextDraft(
  ctx: FollowupContext,
  draft: GeneratedContextFollowup,
): Promise<ContextCriticResult> {
  const response = await withAnthropicRetry(
    () => anthropic.messages.create({
      model: MODEL_CONTEXT_CRITIC,
      max_tokens: 4096,
      system: CONTEXT_CRITIC_SYSTEM,
      messages: [{ role: "user", content: getContextCriticUserPrompt(ctx, draft) }],
    }),
    { label: "context-critic" },
  );
  // B7r: capture token usage for the activity log.
  void recordUsageBestEffort(response, "context_critic");

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text in context-critic response");
  }

  const parsed = parseJsonResponse(textBlock.text);
  return {
    scores: parsed.scores || {},
    overall: typeof parsed.overall === "number" ? parsed.overall : 5,
    issues: Array.isArray(parsed.issues) ? parsed.issues.map(String) : [],
    suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.map(String) : [],
    needs_rewrite: parsed.needs_rewrite === true,
  };
}

async function rewriteContextDraft(
  ctx: FollowupContext,
  draft: GeneratedContextFollowup,
  critique: ContextCriticResult,
): Promise<GeneratedContextFollowup> {
  const response = await withAnthropicRetry(
    () => anthropic.messages.create({
      model: MODEL_CONTEXT_REWRITER,
      max_tokens: 4096,
      system: CONTEXT_REWRITER_SYSTEM,
      messages: [{
        role: "user",
        content: getContextRewriterUserPrompt(ctx, draft, {
          issues: critique.issues,
          suggestions: critique.suggestions,
        }),
      }],
    }),
    { label: "context-rewriter" },
  );
  // B7r: capture token usage for the activity log.
  void recordUsageBestEffort(response, "context_rewriter");

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text in context-rewriter response");
  }

  const parsed = parseJsonResponse(textBlock.text);
  if (!parsed.subject || !parsed.body) {
    // Rewriter failed to produce a valid revision — fall back to the
    // original draft rather than returning nothing. The critic flagged
    // issues, but a malformed rewrite is worse than the original.
    logger.warn(
      { rawPreview: textBlock.text.slice(0, 300) },
      "Context-rewriter produced invalid output — falling back to original draft",
    );
    return draft;
  }
  return { subject: String(parsed.subject), body: String(parsed.body) };
}

/**
 * Top-level entry point for the dispatcher. Mirrors generateFollowupEmail
 * from followupGenerator.ts — same signature, same error semantics — so
 * the scheduler can branch between them without restructuring its call
 * site.
 */
export async function generateContextFollowup(
  ctx: FollowupContext,
): Promise<GeneratedContextFollowup> {
  // B8a: wrap every final return through this helper so the stripper
  // runs on every exit path (initial draft, post-critique no-rewrite,
  // post-critique rewritten, rewriter-failure fallback).
  const finalize = (draft: GeneratedContextFollowup): GeneratedContextFollowup => ({
    subject: draft.subject,
    body: stripClosingFromBody(draft.body),
  });

  const draft = await generateContextDraft(ctx);

  let critique: ContextCriticResult;
  try {
    critique = await critiqueContextDraft(ctx, draft);
  } catch (err) {
    // Critic failure is non-fatal: ship the original draft. We log but
    // don't block delivery on a transient critic problem.
    logger.warn({ err }, "Context-critic call failed — shipping original draft");
    return finalize(draft);
  }

  // Deterministic doctrine + nativeness pre-flight. Doctrine rules are
  // mostly inert here (context flow is non-sales, no value claims), but
  // the language-nativeness latin-token-leak detector applies universally
  // and catches the Zekri-pattern multi-word English phrases inside
  // non-Latin-script prose.
  const deterministicCheck = detectAllDeterministicViolations(draft.body, ctx.original_language);
  if (deterministicCheck.found) {
    critique.issues = [...deterministicCheck.issues, ...critique.issues];
    critique.suggestions = [...deterministicCheck.suggestions, ...critique.suggestions];
    critique.needs_rewrite = true;
    critique.overall = Math.min(critique.overall, 2);
    logger.info(
      { stage: ctx.stage, matches: deterministicCheck.matches.slice(0, 5) },
      "Context-flow deterministic violations detected — merging into critique",
    );
  }

  logger.info(
    {
      stage: ctx.stage,
      overall: critique.overall,
      scores: critique.scores,
      needs_rewrite: critique.needs_rewrite,
      issuesCount: critique.issues.length,
    },
    "Context-follow-up critique completed",
  );

  if (!critique.needs_rewrite) {
    return finalize(draft);
  }

  try {
    const rewritten = await rewriteContextDraft(ctx, draft, critique);
    logger.info({ stage: ctx.stage }, "Context-follow-up rewritten after critic feedback");
    return finalize(rewritten);
  } catch (err) {
    logger.warn(
      { err, stage: ctx.stage },
      "Context-rewriter failed — shipping original draft",
    );
    return finalize(draft);
  }
}
