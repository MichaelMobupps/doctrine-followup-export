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
  assertCriticModelAllowed,
} from "../lib/anthropic";
import { withAnthropicRetry } from "./anthropicRetry";
import { recordUsageBestEffort } from "../lib/usageTracker";
import { cachedSystem } from "../lib/anthropic";
// Cost-saving change: the CRITIC runs on the shared Gemini critic (Sonnet
// fallback + shared breaker). The WRITER stays on Sonnet — this exemplar-less,
// non-sales flow regressed nativeness on the cheap Flash writer in a cross-
// language smoke, so only the critic (a judge, ~90% cheaper) moves to Gemini.
import { runCriticWithProvider } from "./criticProvider";
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
import { mergeViolationReports } from "../lib/structuralLint";
// 2026-07-23 deliverability incident: spam-signal linter (follow-up counts,
// trigger lexicon, list formatting). Anti-ghosting is the flow MOST at risk
// of "reached out N times" phrasing — its whole premise is repeated contact.
import { detectSpamRiskViolations } from "../lib/spamRiskLint";
import { stripClosingFromBody } from "./signatureStripper";
// 2026-08-26 layout fix. The seed subject stands in for the thread identity
// here; this context has no original_subject field but seed_subject is
// equally stable per thread, which is all the profile seed needs.
import { shapeFollowupBody, selectLayoutProfile } from "../lib/layoutShaper";
import { scanForInjection, checkOutputIntegrity, UNTRUSTED_DATA_SYSTEM_CLAUSE } from "../lib/promptInjection";

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

// CB-4 (AG port): a number in an anti-ghosting follow-up is grounded only
// if it already appeared in the seed email or earlier in the real thread.
// A percentage not present there is treated as invented and is removed or
// grounded by the rewrite below. Local copies of the Doctrine-flow helpers.
function normalizeForGrounding(s: string): string {
  return (s || "").toLowerCase().replace(/\s+/g, "");
}
function findUngroundedPercentages(body: string, source: string): string[] {
  const src = normalizeForGrounding(source);
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /\d{1,3}(?:[.,]\d+)?\s*(?:[-\u2013\u2014]\s*\d{1,3}(?:[.,]\d+)?\s*)?%/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const raw = m[0].trim();
    const key = normalizeForGrounding(raw);
    if (seen.has(key)) continue;
    seen.add(key);
    const digits = key.replace("%", "");
    if (src.includes(key) || src.includes(digits + "%")) continue;
    out.push(raw);
  }
  return out;
}

// AG draft writer (Sonnet). Unchanged by the cost work — the cheap Flash writer
// regressed nativeness on this exemplar-less flow, so only the critic moved to
// Gemini. Keeps the AG-specific empty-body tolerance (body === undefined).
async function generateAntiGhostingDraft(
  ctx: AntiGhostingFollowupContext,
  attempt = 1,
): Promise<GeneratedAntiGhostingFollowup> {
  const maxAttempts = 2;
  const response = await withAnthropicRetry(
    () => anthropic.messages.create({
      model: MODEL_ANTI_GHOSTING_GENERATOR,
      max_tokens: 4096,
      system: cachedSystem(UNTRUSTED_DATA_SYSTEM_CLAUSE, ANTI_GHOSTING_GENERATOR_SYSTEM),
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
  // Critic runs on Sonnet. assertCriticModelAllowed refuses any Opus model.
  assertCriticModelAllowed(MODEL_ANTI_GHOSTING_CRITIC);
  const response = await withAnthropicRetry(
    // Sonnet critic. withOpusReasoning is a passthrough for a non-Opus model.
    // max_tokens stays at 12000 so the JSON verdict never truncates.
    () => anthropic.messages.create(withOpusReasoning({
      model: MODEL_ANTI_GHOSTING_CRITIC,
      max_tokens: 12000,
      system: cachedSystem(UNTRUSTED_DATA_SYSTEM_CLAUSE, ANTI_GHOSTING_CRITIC_SYSTEM),
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

// AG rewriter (Sonnet). Unchanged by the cost work.
async function rewriteAntiGhostingDraft(
  ctx: AntiGhostingFollowupContext,
  draft: GeneratedAntiGhostingFollowup,
  critique: AntiGhostingCriticResult,
): Promise<GeneratedAntiGhostingFollowup> {
  const response = await withAnthropicRetry(
    () => anthropic.messages.create({
      model: MODEL_ANTI_GHOSTING_REWRITER,
      max_tokens: 4096,
      system: cachedSystem(UNTRUSTED_DATA_SYSTEM_CLAUSE, ANTI_GHOSTING_REWRITER_SYSTEM),
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
  const finalize = (draft: GeneratedAntiGhostingFollowup): GeneratedAntiGhostingFollowup => {
    const out = {
      subject: draft.subject,
      body: shapeFollowupBody(stripClosingFromBody(draft.body), {
        profile: selectLayoutProfile({
          company: ctx.company,
          prospect_name: ctx.prospect_name,
          original_subject: ctx.seed_subject,
          stage: ctx.stage,
        }),
        languageTag: ctx.original_language,
      }),
    };
    const _egress = checkOutputIntegrity(`${out.subject}\n${out.body}`);
    if (_egress.compromised) throw new Error(`Output integrity check failed: ${_egress.reasons.join("; ")}`);
    return out;
  };

  const _inboundText = ctx.thread_messages
    .filter((m) => m.direction === "inbound")
    .map((m) => m.body)
    .join("\n");
  const _inboundScan = scanForInjection(_inboundText);
  if (_inboundScan.suspicious) {
    throw new Error("Injection suspected in inbound thread; not auto-sending");
  }

  const draft = await generateAntiGhostingDraft(ctx);

  // Deterministic pre-flight identical to the context flow. The Latin
  // token leak detector catches multi-word English phrases that slip
  // into non-Latin-script bodies (the Zekri pattern). Universal across
  // all three flows.
  // CB-4 (AG port): a number is grounded only if it appears in the seed email
  // or earlier in the real thread. Anything else is treated as invented.
  // (Computed before the deterministic checks since 2026-07-23 — the spam
  // linter uses the same source for its trigger-grounding exemption.)
  const groundingSource = [
    ctx.seed_subject,
    ctx.seed_body,
    ...ctx.thread_messages.map((m) => m.body),
  ].join("\n");

  const deterministicCheck = mergeViolationReports(
    detectAllDeterministicViolations(draft.body, ctx.original_language),
    detectSpamRiskViolations(draft.body, {
      languageTag: ctx.original_language,
      subject: draft.subject,
      originalText: groundingSource,
    }),
  );
  const ungroundedStats = findUngroundedPercentages(draft.body, groundingSource);

  // CB-1 cost gate: when the deterministic layer flags the draft we already
  // know it needs a rewrite, so we skip the Opus critic call and rewrite
  // directly from the deterministic findings. The Opus critic runs only on a
  // draft that is already deterministically clean. The forbidden-phrase rule
  // is still enforced server-side at send time via deterministic
  // post-checks; the critic is one line of defence and not the only one.
  // CB-4 (AG port): an invented percentage forces a rewrite on the same
  // no-critic path as a deterministic violation. The rewriter receives the
  // stat finding in the same channel as every other issue.
  const statIssue = ungroundedStats.length > 0
    ? `INVENTED STATISTIC: the figure(s) ${ungroundedStats.join(", ")} do not appear in the seed email or earlier in the thread. Remove each one, or replace it with a qualitative proof point about MobUpps quality (incrementality, semi-exclusive supply, durable revenue past the first cycle, measurement transparency). State a number ONLY if that exact number is in the prior conversation.`
    : null;
  const statSuggestions = ungroundedStats.length > 0
    ? [
        "Do not state any percentage or performance figure that is not present in the seed email or the thread.",
        "If the prior conversation has no figure, make the point qualitatively about MobUpps strengths.",
      ]
    : [];

  let critique: AntiGhostingCriticResult;
  if (deterministicCheck.found || ungroundedStats.length > 0) {
    critique = {
      scores: {},
      overall: 2,
      issues: [...(statIssue ? [statIssue] : []), ...deterministicCheck.issues],
      suggestions: [...statSuggestions, ...deterministicCheck.suggestions],
      needs_rewrite: true,
    };
    logger.info(
      { stage: ctx.stage, cycle: ctx.cycle, matches: deterministicCheck.matches.slice(0, 5) },
      "AntiGhosting deterministic violations detected — rewriting without an Opus critic call",
    );
  } else {
    try {
      // Critic runs on Gemini (flash-lite) with the in-house Sonnet critic as
      // the fallback — same provider switch and shared breaker as the doctrine
      // critic, using the AG flow's own critic prompts.
      critique = await runCriticWithProvider({
        anthropicCritic: () => critiqueAntiGhostingDraft(ctx, draft),
        geminiSystemParts: [UNTRUSTED_DATA_SYSTEM_CLAUSE, ANTI_GHOSTING_CRITIC_SYSTEM],
        geminiUser: getAntiGhostingCriticUserPrompt(ctx, draft),
        label: "anti_ghosting_critic",
        prospectName: ctx.prospect_name,
      });
    } catch (err) {
      // Critic failure is non-fatal: ship the original draft. The critic is
      // the primary line of defence and not the only one.
      logger.warn({ err }, "AntiGhosting-critic call failed — shipping original draft");
      return finalize(draft);
    }
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
