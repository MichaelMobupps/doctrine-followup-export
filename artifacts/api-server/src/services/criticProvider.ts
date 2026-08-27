/**
 * criticProvider.ts — the critic stage's view of the LLM router.
 *
 * All three flows (doctrine, context, anti-ghosting) run the same shape:
 * writer -> critic -> rewriter. This module governs ONLY the critic stages.
 * The writer stages are governed by services/writerProvider.ts; both sit on
 * lib/llmRouter.ts and lib/modelPolicy.ts.
 *
 * THE CHAIN
 *
 *   gemini-3-flash-preview -> gpt-5.4-mini -> gemini-3.7-flash -> gpt-4.1-mini
 *
 * Deliberately NOT the cheapest models available, and the one place in the
 * product where cost is not the tie-breaker. By the time a draft reaches the
 * LLM critic the deterministic linter has already rewritten anything that trips
 * a mechanical rule (see GEMINI_CRITIC_FOCUS below), so what is left is exactly
 * the judgment a regex cannot make. A critic that waves through a bad draft
 * costs a whole extra send; the token delta against a cheaper tier is a rounding
 * error next to that.
 *
 * Until Aug 2026 the fallback behind Gemini was an in-house Sonnet critic. With
 * the Anthropic account unfunded that tier is gone and the chain is Gemini and
 * OpenAI end to end, alternating vendors so a Google-side incident does not take
 * every tier down at once.
 *
 * The critic is the one role that passes NO response schema. Its verdict
 * contains `scores`, an open map of dimension -> number whose keys differ per
 * flow, and OpenAI's strict json_schema mode cannot express an open map
 * (additionalProperties must be false, and every property must be listed).
 * Rather than flatten the verdict to fit the tooling, the critic keeps its
 * prompt contract and relies on tolerant parsing — and, critically, the router
 * treats an unparseable verdict as a TIER failure, so a model that loses the
 * contract is fallen past instead of silently degrading the critique.
 *
 * The old CRITIC_PROVIDER env var selected between Gemini and Anthropic;
 * nothing reads it any more. Set LLM_CHAIN_CRITIC to change the chain.
 */
import type { FollowupContext } from "./followupPrompts";
import { getCriticSystemPrompt, getCriticUserPrompt } from "./followupPrompts";
import type { CriticResult } from "./followupGenerator";
import { UNTRUSTED_DATA_SYSTEM_CLAUSE } from "../lib/promptInjection";
import { logger } from "../lib/logger";
import { runLlmJson, AllTiersFailedError, type RouterDeps } from "../lib/llmRouter";
import { getChain, describeChain, type LlmRole } from "../lib/modelPolicy";

/** The three critic flows. Each records usage under its own ledger label so per-product cost stays attributable. */
export type CriticLabel = "critic" | "context_critic" | "anti_ghosting_critic";

const ROLE_FOR_LABEL: Record<CriticLabel, LlmRole> = {
  critic: "critic",
  context_critic: "context_critic",
  anti_ghosting_critic: "ag_critic",
};

type DraftLike = { subject: string; body: string };

/**
 * Coerce a parsed verdict into a CriticResult, rejecting anything that is not
 * recognisably a critique.
 *
 * The shape check is deliberately minimal but non-empty: a verdict with none of
 * the four expected keys is not a lenient critique, it is a model that answered
 * a different question, and defaulting it to `{overall: 5, needs_rewrite:
 * false}` would ship an un-reviewed draft on the strength of a malformed
 * response. Throwing hands it to the router, which advances the waterfall.
 */
export function coerceCriticResult(parsed: unknown): CriticResult {
  if (!parsed || typeof parsed !== "object") {
    throw new Error("critic verdict is not an object");
  }
  const p = parsed as Partial<CriticResult>;
  const hasAnySignal =
    p.scores !== undefined ||
    p.overall !== undefined ||
    p.issues !== undefined ||
    p.needs_rewrite !== undefined;
  if (!hasAnySignal) {
    throw new Error("critic verdict has none of scores/overall/issues/needs_rewrite");
  }
  return {
    scores: p.scores ?? {},
    overall: typeof p.overall === "number" ? p.overall : 5,
    issues: Array.isArray(p.issues) ? p.issues : [],
    suggestions: Array.isArray(p.suggestions) ? p.suggestions : [],
    needs_rewrite: p.needs_rewrite ?? false,
  };
}

// Gemini critic focus directive. In production the deterministic linter runs
// upstream of the critic and rewrites any draft that trips a mechanical rule,
// so by the time the LLM critic sees a draft those rules are already clean.
// This tells the cheaper model to trust that and spend its scrutiny on the
// judgment a regex cannot make. Named GEMINI_* historically; it is appended to
// every critic chain's system prompt now, whichever vendor serves.
export const GEMINI_CRITIC_FOCUS = [
  "ENFORCEMENT CONTEXT: A deterministic linter runs before you and rewrites any",
  "draft that violates a mechanical rule, so the draft you are grading is already",
  "clean on: sentence-count, em and en dashes, hedged numbers, hype adjectives,",
  "the X-not-Y comma negation, multi-event claims, invented statistics,",
  "meta-language, closing or sign-off lines, the language-nativeness rules,",
  "the greeting-on-its-own-line and paragraph-block layout rules, and",
  "the presence of a follow-up acknowledgment. Do not spend your budget",
  "re-policing those. Concentrate your judgment on what the linter cannot see:",
  "whether the follow-up is relevant to this specific prospect and their original",
  "email, whether it advances a genuinely new angle instead of restating the prior",
  "message, whether the tone reads as a real human sales rep, and whether the",
  "language is natural beyond the mechanical checks. Still return every score in",
  "the required JSON, but weight your overall score and your needs_rewrite",
  "decision toward those judgment dimensions.",
  // Aug 2026 audit: layout is out of the critic's hands entirely.
  //
  // The writer prompt carries a randomized per-thread layout directive (block
  // pattern, soft breaks) for human-formatting variation, and critics kept
  // re-judging drafts against it — unreliably. Measured directly: a control
  // draft verified STRUCTURALLY to match its seeded directive (pattern [1,3],
  // soft break after sentence 1) was still flagged with a miscounted layout
  // complaint. Every such false flag buys a full rewrite + re-critique cycle,
  // and the critic stage is two thirds of the LLM bill (bench-llm-pipeline).
  //
  // The division of labour is: the writer ATTEMPTS the directive, the
  // deterministic linter + layout shaper OWN the floor that must hold at ship
  // time, and the critic judges CONTENT — including opener repetition (rule
  // 5b), which is carved back in below because no regex can judge it. Restore
  // the old re-policing with CRITIC_JUDGES_LAYOUT=1 (read at module load for
  // this clause; followupPrompts reads it per call — set it before boot).
  ...(process.env.CRITIC_JUDGES_LAYOUT === "1"
    ? []
    : [
        "LAYOUT (VISUAL SHAPE) IS OUT OF SCOPE FOR YOU: how many paragraph",
        "blocks the email has, which sentences share a line, where blank lines",
        "or mid-thought line breaks fall — all of that is owned by the",
        "deterministic layout stage. Do not list any visual-shape complaint in",
        "issues and never set needs_rewrite for visual shape. One carve-out",
        "stays fully yours: OPENER REPETITION across the thread's previous",
        "follow-ups (rule 5b of your instructions) is content judgment, not",
        "visual shape — keep scoring and flagging it exactly as instructed.",
      ]),
].join(" ");

export interface CriticProviderArgs {
  /** Critic system-instruction parts (untrusted clause first, then the critic prompt). */
  systemParts: string[];
  /** The critic user turn (the draft to grade). */
  user: string;
  /** Usage-ledger label for this flow's critic; also selects the router role. */
  label: CriticLabel;
  /** For logs only. */
  prospectName?: string;
}

/**
 * Provider-switched critic for ANY flow.
 *
 * Walks the flow's critic chain and returns the first well-formed verdict.
 * Throws AllTiersFailedError when the whole chain is unavailable — every caller
 * already degrades gracefully on a critic throw (it ships the best draft seen),
 * so a total critic outage costs review depth, never a dropped follow-up.
 */
export async function runCriticWithProvider(
  args: CriticProviderArgs,
  depsOverride?: Partial<RouterDeps>,
): Promise<CriticResult> {
  const role = ROLE_FOR_LABEL[args.label];
  try {
    const { value, result } = await runLlmJson<CriticResult>(
      {
        role,
        systemParts: args.systemParts,
        user: args.user,
        maxOutputTokens: 8192,
        usage: { kind: "pipeline", label: args.label },
        prospectName: args.prospectName,
        validate: coerceCriticResult,
      },
      depsOverride,
    );
    if (result.tierIndex > 1) {
      logger.info(
        { prospect: args.prospectName, label: args.label, model: result.model, tier: result.tierIndex },
        "Critic served by a fallback tier",
      );
    }
    return value;
  } catch (err) {
    if (err instanceof AllTiersFailedError) {
      logger.warn(
        { prospect: args.prospectName, label: args.label, chain: describeChain(getChain(role)), err: String(err) },
        "Every critic tier was unavailable",
      );
    }
    throw err;
  }
}

/**
 * Doctrine-flow critic. Thin wrapper that supplies the doctrine critic prompts
 * and the GEMINI_CRITIC_FOCUS directive.
 */
export async function runCritic(
  ctx: FollowupContext,
  draft: DraftLike,
): Promise<CriticResult> {
  return runCriticWithProvider({
    // The prompt-injection hardening clause precedes the critic instructions,
    // as it does on every other prompt in the product.
    systemParts: [UNTRUSTED_DATA_SYSTEM_CLAUSE, getCriticSystemPrompt(), GEMINI_CRITIC_FOCUS],
    user: getCriticUserPrompt(ctx, draft),
    label: "critic",
    prospectName: ctx.prospect_name,
  });
}

