/**
 * Context-based follow-up generator — Phase 7b.
 *
 * Mirrors followupGenerator.ts in shape (generator -> critic -> rewriter) but
 * uses context-only prompts with no doctrine principles.
 *
 * Goal: write follow-ups that nudge for a response on a previous email
 * thread, faithfully referencing the prior content with no invention,
 * marketing language, or sales pitch. The critic's job is to catch any
 * drift from those constraints; the rewriter applies the fixes.
 *
 * MODEL ROUTING (Aug 2026)
 *
 * Every stage runs through the LLM router on this flow's OWN chain, which
 * starts a tier above the doctrine flow's. That is not caution, it is a
 * measurement: this flow has no exemplar library, and when the writer was first
 * moved to a cheap tier a cross-language smoke found it regressed nativeness
 * here specifically — untranslated English singletons in Latin-script languages,
 * "test" surviving into fr/es/pt copy — at 50% clean against the then-Sonnet
 * writer's 80%. The doctrine flow did not regress, because its exemplar block
 * carries the cheap tier. Without exemplars there is nothing to carry it, so
 * the chain compensates. See EXEMPLARLESS_WRITER_CHAIN in lib/modelPolicy.ts.
 */

import { runWriter } from "./writerProvider";
// F-3.7b: a spent row budget outranks every fail-open path in this file.
import { GenerationDeadlineError } from "../lib/generationDeadline";
import { runCriticWithProvider } from "./criticProvider";
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
import { mergeViolationReports } from "../lib/structuralLint";
// 2026-07-23 deliverability incident: spam-signal linter (follow-up counts,
// trigger lexicon, list formatting). Same gate as the doctrine flow.
import { detectSpamRiskViolations } from "../lib/spamRiskLint";
// B8a: deterministic closing/signature stripper. Belt-and-suspenders
// safety net for the new prompt-level no-closing rule (CONTEXT generator
// constraint #9 and critic dimension `closing_strip`). Applied to every
// return path of generateContextFollowup so the body is always free of
// a sign-off before the email client appends the user signature.
import { stripClosingFromBody } from "./signatureStripper";
// 2026-08-26 layout fix. Shared with the doctrine and anti-ghosting
// pipelines so a context follow-up is shaped by the same rules — the
// recipient cannot tell which pipeline wrote it and neither should the shape.
import { shapeFollowupBody, selectLayoutProfile } from "../lib/layoutShaper";
import { checkOutputIntegrity, UNTRUSTED_DATA_SYSTEM_CLAUSE } from "../lib/promptInjection";

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

// Context draft writer. Walks the exemplar-less writer chain. The router
// retries inside a tier, falls to the next tier on a 429/503/timeout/safety
// block, and treats an off-contract answer as a tier failure — so the
// two-attempt JSON-parse retry this function used to carry is now handled for
// every tier at once, one level down.
async function generateContextDraft(
  ctx: FollowupContext,
): Promise<GeneratedContextFollowup> {
  const result = await runWriter({
    role: "context_draft",
    systemParts: [UNTRUSTED_DATA_SYSTEM_CLAUSE, CONTEXT_GENERATOR_SYSTEM],
    userPrompt: getContextGeneratorUserPrompt(ctx),
    maxOutputTokens: 4096,
    usageLabel: "context_generator",
    prospectName: ctx.prospect_name,
  });
  return { subject: result.subject, body: result.body };
}

// Context rewriter. Same chain as the draft.
//
// Keeps the caller's old failure semantics deliberately: if the whole chain is
// unavailable, or none of it returns a usable revision, we return the ORIGINAL
// draft rather than nothing. A follow-up that skipped one round of polish beats
// a follow-up that never sends.
async function rewriteContextDraft(
  ctx: FollowupContext,
  draft: GeneratedContextFollowup,
  critique: ContextCriticResult,
): Promise<GeneratedContextFollowup> {
  try {
    const result = await runWriter({
      role: "context_rewriter",
      systemParts: [UNTRUSTED_DATA_SYSTEM_CLAUSE, CONTEXT_REWRITER_SYSTEM],
      userPrompt: getContextRewriterUserPrompt(ctx, draft, {
        issues: critique.issues,
        suggestions: critique.suggestions,
      }),
      maxOutputTokens: 4096,
      usageLabel: "context_rewriter",
      prospectName: ctx.prospect_name,
    });
    return { subject: result.subject, body: result.body };
  } catch (err) {
    // Same rule as the critic above: a spent budget is terminal for the row.
    if (err instanceof GenerationDeadlineError) throw err;
    logger.warn(
      { err: String(err), stage: ctx.stage },
      "Context-rewriter chain exhausted — falling back to the original draft",
    );
    return draft;
  }
}

export async function generateContextFollowup(
  ctx: FollowupContext,
): Promise<GeneratedContextFollowup> {
  // B8a: wrap every final return through this helper so the stripper
  // runs on every exit path (initial draft, post-critique no-rewrite,
  // post-critique rewritten, rewriter-failure fallback).
  const finalize = (draft: GeneratedContextFollowup): GeneratedContextFollowup => {
    const out = {
      subject: draft.subject,
      body: shapeFollowupBody(stripClosingFromBody(draft.body), {
        profile: selectLayoutProfile(ctx),
        languageTag: ctx.original_language,
      }),
    };
    const _egress = checkOutputIntegrity(`${out.subject}\n${out.body}`);
    if (_egress.compromised) throw new Error(`Output integrity check failed: ${_egress.reasons.join("; ")}`);
    return out;
  };

  const draft = await generateContextDraft(ctx);

  // Deterministic doctrine + nativeness pre-flight. Doctrine rules are
  // mostly inert here (context flow is non-sales, no value claims), but
  // the language-nativeness latin-token-leak detector applies universally
  // and catches the Zekri-pattern multi-word English phrases inside
  // non-Latin-script prose.
  const deterministicCheck = mergeViolationReports(
    detectAllDeterministicViolations(draft.body, ctx.original_language),
    detectSpamRiskViolations(draft.body, {
      languageTag: ctx.original_language,
      subject: draft.subject,
      originalText: [ctx.original_subject, ctx.original_body, ctx.original_body_summary].join("\n"),
    }),
  );

  // CB-1 cost gate: when the deterministic layer flags the draft we already
  // know it needs a rewrite, so we skip the LLM critic call and rewrite
  // directly from the deterministic findings. The LLM critic runs only on a
  // draft that is already deterministically clean. The guards are unchanged;
  // only the timing of the critic call changes.
  let critique: ContextCriticResult;
  if (deterministicCheck.found) {
    critique = {
      scores: {},
      overall: 2,
      issues: [...deterministicCheck.issues],
      suggestions: [...deterministicCheck.suggestions],
      needs_rewrite: true,
    };
    logger.info(
      { stage: ctx.stage, matches: deterministicCheck.matches.slice(0, 5) },
      "Context-flow deterministic violations detected — rewriting without an LLM critic call",
    );
  } else {
    try {
      // Critic runs the shared critic waterfall with this flow's own prompts.
      critique = await runCriticWithProvider({
        systemParts: [UNTRUSTED_DATA_SYSTEM_CLAUSE, CONTEXT_CRITIC_SYSTEM],
        user: getContextCriticUserPrompt(ctx, draft),
        label: "context_critic",
        prospectName: ctx.prospect_name,
      });
    } catch (err) {
      // F-3.7b: a spent row budget is NOT a critic outage. The catch below is
      // deliberately fail-open — a transient critic problem should ship the
      // draft rather than fail the row — but "ship the original draft" on the
      // strength of a DEADLINE would put an un-critiqued email in a client's
      // inbox. The doctrine flow has always rethrown here; these two never did.
      // Closing that gap so all three flows obey the same rule.
      if (err instanceof GenerationDeadlineError) throw err;
      // Critic failure is non-fatal: ship the original draft. We log but
      // don't block delivery on a transient critic problem.
      logger.warn({ err }, "Context-critic call failed — shipping original draft");
      return finalize(draft);
    }
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
    // F-3.7b: rewriteContextDraft rethrows a spent budget precisely so it can
    // travel — swallowing it here would defeat that guard one frame up.
    if (err instanceof GenerationDeadlineError) throw err;
    logger.warn(
      { err, stage: ctx.stage },
      "Context-rewriter failed — shipping original draft",
    );
    return finalize(draft);
  }
}
