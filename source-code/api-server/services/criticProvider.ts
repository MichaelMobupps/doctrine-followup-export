/**
 * Critic-stage provider switch.
 *
 * The Doctrine follow-up pipeline runs writer (Sonnet) -> critic -> rewriter
 * (Sonnet). This module governs ONLY the doctrine critic stage. The provider is
 * selected by the CRITIC_PROVIDER env var:
 *
 *   gemini     (default, or unset) Run the critic on the configured Gemini
 *              model (GEMINI_CRITIC_MODEL, default gemini-3-flash-preview).
 *              Gemini is cheapest and is the normal path. If Gemini is at full
 *              capacity or unavailable, the call falls back to the in-house
 *              Sonnet critic for that draft — never in parallel. A circuit
 *              breaker guards this: after a short run of Gemini failures the
 *              breaker opens and every call routes straight to Sonnet for a
 *              cooldown, so a Gemini outage costs one probe per cooldown instead
 *              of a Gemini-retry stall on every single draft. A missing
 *              GEMINI_API_KEY also uses Sonnet.
 *   anthropic  Force the in-house Sonnet critic and never call Gemini. An
 *              escape hatch for debugging or if Gemini billing must be cut off.
 *
 * There is no parallel/shadow mode: the critic runs on exactly one model per
 * draft.
 *
 * Cost note: Gemini 3 Flash Preview bills 0.50 / 3.00 USD per 1M
 * input/output tokens; the Sonnet fallback bills 3.00 / 15.00. Opus
 * (5.00 / 25.00) is never used as a critic on any path.
 */
import type { FollowupContext } from "./followupPrompts";
import { getCriticSystemPrompt, getCriticUserPrompt } from "./followupPrompts";
import type { CriticResult } from "./followupGenerator";
import { UNTRUSTED_DATA_SYSTEM_CLAUSE } from "../lib/promptInjection";
import { logger } from "../lib/logger";
import {
  geminiGenerateJson,
  isGeminiConfigured,
  GEMINI_CRITIC_MODEL,
} from "../lib/gemini";
import { anthropic, cachedSystem, MODEL_CRITIC_FALLBACK } from "../lib/anthropic";
import { withAnthropicRetry } from "./anthropicRetry";
import { recordGeminiUsageBestEffort, recordUsageBestEffort } from "../lib/usageTracker";
import { createCircuitBreaker } from "../lib/circuitBreaker";

// Guards the Gemini critic. After 3 consecutive Gemini failures the breaker
// opens for 60s and every critic routes straight to Sonnet, so a Gemini outage
// or capacity wall does not stall each draft on Gemini's own retry budget. One
// probe is allowed after the cooldown; a success closes it. Module-level so the
// state is shared across the long-running api-server process.
const geminiBreaker = createCircuitBreaker({ failureThreshold: 3, cooldownMs: 60_000 });

export type CriticProviderName = "anthropic" | "gemini";

export function getCriticProvider(): CriticProviderName {
  // Gemini is the default. Only an explicit "anthropic" forces the Sonnet-only
  // critic; any other value (including unset) resolves to gemini.
  const v = (process.env.CRITIC_PROVIDER || "gemini").toLowerCase();
  return v === "anthropic" ? "anthropic" : "gemini";
}

type AnthropicCriticFn = () => Promise<CriticResult>;
type DraftLike = { subject: string; body: string };

// Same tolerant extraction the Anthropic path uses: strip any code fences and
// slice to the outermost JSON object before parsing. responseMimeType
// application/json normally yields a bare object, so the fence and slice
// handling is belt-and-suspenders. A parse failure throws and the caller
// falls back to the Sonnet critic.
function parseCriticJson(text: string): CriticResult {
  let raw = text.replace(/```json\s*|```/g, "").trim();
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first !== -1 && last > first) {
    raw = raw.slice(first, last + 1);
  }
  const parsed = JSON.parse(raw) as Partial<CriticResult>;
  return {
    scores: parsed.scores ?? {},
    overall: parsed.overall ?? 5,
    issues: parsed.issues ?? [],
    suggestions: parsed.suggestions ?? [],
    needs_rewrite: parsed.needs_rewrite ?? false,
  };
}

// Gemini critic focus directive. In production the deterministic linter runs
// upstream of the critic and rewrites any draft that trips a mechanical rule,
// so by the time the LLM critic sees a draft those rules are already clean.
// This tells the cheaper Gemini model to trust that and spend its scrutiny on
// the judgment a regex cannot make. It is appended only to the Gemini system
// prompt; the Anthropic critic prompt is unchanged.
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
].join(" ");

// The three critic flows that can run on Gemini. Each records usage under its
// own ledger label so per-product cost stays attributable.
type CriticLabel = "critic" | "context_critic" | "anti_ghosting_critic";

// Generalized Gemini critic: grade a draft on the Gemini critic model using the
// caller's own system + user prompts, and record usage under the flow's label.
// The doctrine critic is one caller (getCriticSystemPrompt + GEMINI_CRITIC_FOCUS);
// the context and anti-ghosting flows pass their own critic prompts. The prompt-
// injection hardening clause is expected to be the first systemPart in every
// caller, mirroring the Anthropic critic's system construction.
async function geminiCritiqueWithPrompts(
  systemParts: string[],
  user: string,
  label: CriticLabel,
): Promise<CriticResult> {
  const result = await geminiGenerateJson({
    systemParts,
    user,
    maxOutputTokens: 8192,
  });
  // Record token usage on the same ledger as the Anthropic stages, under the
  // flow's own critic label. Best-effort: never throws.
  void recordGeminiUsageBestEffort(result.usage, result.model, label);
  return parseCriticJson(result.text);
}

// Sonnet fallback critic. In gemini mode this runs whenever the Gemini path
// is unavailable: a Gemini call that fails after retries (a 503 under load),
// or a missing GEMINI_API_KEY. The draft reaching this point is already
// deterministically clean, and Sonnet is the standard critic tier, so gemini
// mode degrades to the same cost as the default in-house critic. No path —
// anthropic, gemini, or shadow — ever uses an Opus critic.
async function sonnetCritique(
  ctx: FollowupContext,
  draft: DraftLike,
): Promise<CriticResult> {
  const response = await withAnthropicRetry(
    () =>
      anthropic.messages.create({
        model: MODEL_CRITIC_FALLBACK,
        max_tokens: 4096,
        system: cachedSystem(UNTRUSTED_DATA_SYSTEM_CLAUSE, getCriticSystemPrompt()),
        messages: [{ role: "user", content: getCriticUserPrompt(ctx, draft) }],
      }),
    { label: "critic" },
  );
  void recordUsageBestEffort(response, "critic");
  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text in Sonnet fallback critic response");
  }
  return parseCriticJson(textBlock.text);
}

export interface CriticProviderArgs {
  /**
   * Sonnet critic used for the explicit escape hatch (CRITIC_PROVIDER=anthropic).
   * For the doctrine flow this is the full critic; for the sibling flows it is
   * that flow's only Sonnet critic.
   */
  anthropicCritic: AnthropicCriticFn;
  /**
   * Sonnet critic used when Gemini is the intended provider but is unavailable
   * (no key, breaker open, or a failed call). Defaults to anthropicCritic. The
   * doctrine flow passes a cheaper fallback critic here so a degraded path does
   * not pay for the full critic.
   */
  geminiFallbackCritic?: AnthropicCriticFn;
  /** Gemini critic system-instruction parts (untrusted clause first, then the critic prompt). */
  geminiSystemParts: string[];
  /** The Gemini critic user turn (the draft to grade). */
  geminiUser: string;
  /** Usage-ledger label for this flow's critic. */
  label: CriticLabel;
  /** For logs only. */
  prospectName?: string;
}

/**
 * Provider-switched critic for ANY flow. Gemini-first with a Sonnet fallback —
 * never both, never in parallel — the exact policy the doctrine critic uses,
 * generalized so the context and anti-ghosting critics get the same cost saving.
 * The circuit breaker is shared across all critic flows, so a Gemini outage
 * opens it once and every flow routes to Sonnet for the cooldown.
 */
export async function runCriticWithProvider(args: CriticProviderArgs): Promise<CriticResult> {
  const provider = getCriticProvider();
  const fallback = args.geminiFallbackCritic ?? args.anthropicCritic;

  // Escape hatch: force the in-house Sonnet critic, never call Gemini.
  if (provider === "anthropic") {
    return args.anthropicCritic();
  }

  // Default: Gemini-first with a Sonnet fallback. Never both, never in parallel.
  if (!isGeminiConfigured()) {
    logger.warn({ prospect: args.prospectName }, "GEMINI_API_KEY is not set. Using Sonnet critic");
    return fallback();
  }

  // Breaker open: a recent run of Gemini failures means it is at capacity or
  // down, so skip it entirely for this draft and use Sonnet — no per-call
  // Gemini stall during an outage.
  if (!geminiBreaker.shouldAttempt()) {
    logger.info(
      { prospect: args.prospectName, breaker: geminiBreaker.state() },
      "Gemini critic circuit breaker open. Using Sonnet critic",
    );
    return fallback();
  }

  try {
    const result = await geminiCritiqueWithPrompts(args.geminiSystemParts, args.geminiUser, args.label);
    geminiBreaker.onSuccess();
    return result;
  } catch (err) {
    geminiBreaker.onFailure();
    logger.warn(
      { err: String(err), prospect: args.prospectName, model: GEMINI_CRITIC_MODEL, breaker: geminiBreaker.state() },
      "Gemini critic failed (capacity or unavailable). Falling back to Sonnet critic",
    );
    return fallback();
  }
}

/**
 * Doctrine-flow critic. Thin wrapper over runCriticWithProvider that supplies
 * the doctrine critic prompts, the GEMINI_CRITIC_FOCUS directive, and the cheaper
 * MODEL_CRITIC_FALLBACK Sonnet critic for the degraded path. Behavior is
 * identical to the previous implementation.
 */
export async function runCritic(
  ctx: FollowupContext,
  draft: DraftLike,
  anthropicCritic: AnthropicCriticFn,
): Promise<CriticResult> {
  return runCriticWithProvider({
    anthropicCritic,
    // Cheaper Sonnet critic for the Gemini-unavailable path, as before.
    geminiFallbackCritic: () => sonnetCritique(ctx, draft),
    // Mirror the Anthropic critic's system construction: the prompt-injection
    // hardening clause precedes the critic instructions.
    geminiSystemParts: [UNTRUSTED_DATA_SYSTEM_CLAUSE, getCriticSystemPrompt(), GEMINI_CRITIC_FOCUS],
    geminiUser: getCriticUserPrompt(ctx, draft),
    label: "critic",
    prospectName: ctx.prospect_name,
  });
}
