/**
 * writerProvider.ts — the writer stage's view of the LLM router.
 *
 * The WRITER stages are the initial draft and every rewrite, in all three
 * flows (doctrine, context, anti-ghosting). This module owns two things and
 * delegates everything else:
 *
 *   1. Which ROLE a given draft belongs to — which is only interesting because
 *      grey-area verticals get their own chain (see below).
 *   2. The {subject, body} output contract.
 *
 * Everything that used to live here — the tier list, the per-tier thinking
 * levels, the circuit breakers, the fallback loop, the JSON salvage — now lives
 * in lib/modelPolicy.ts and lib/llmRouter.ts, shared with the critic, the
 * summarizer, the reply classifier and the ack confirm. There is one fallback
 * implementation in the process, not five.
 *
 * WHAT CHANGED, AND WHY
 *
 * Until Aug 2026 the last tier of this chain was the in-house Sonnet writer,
 * supplied by the caller as a callback. With the Anthropic account unfunded
 * that tier cannot exist, so the chain is now Gemini and OpenAI end to end:
 *
 *   ordinary verticals   gemini-3.1-flash-lite -> gpt-5.4-nano -> gemini-3.7-flash -> gpt-5.4-mini
 *   grey-area verticals  gemini-3.7-flash -> gpt-5.4-mini -> gemini-3-flash-preview -> gpt-4.1-mini
 *
 * Grey-area verticals (casino, betting, gambling, crypto/forex/CFD, per
 * lib/greyArea.ts) used to be pinned to Sonnet on compliance and consistency
 * grounds. That pin cannot hold without Anthropic, so the policy became: start
 * at the strongest tier rather than the cheapest, and make sure the chain
 * crosses vendors — because the realistic failure in these verticals is not
 * capacity but a SAFETY BLOCK, and a refusal from one vendor should land on the
 * other rather than on the floor. Volume there is low, so the higher unit price
 * barely moves the blended cost.
 *
 * Quality is held up, not down: the caller injects the gold-standard exemplar
 * block into the user prompt for EVERY tier (lib/exemplarLibrary.ts), and the
 * deterministic linter plus the critic/rewrite healing loop run unchanged on top
 * of whatever tier produced the draft — so a weaker draft is still caught and
 * repaired exactly as before.
 *
 * Tuning is env-only; see LLM_CHAIN_DRAFT / LLM_CHAIN_REWRITER /
 * LLM_CHAIN_GREY_DRAFT / LLM_CHAIN_GREY_REWRITER in lib/modelPolicy.ts.
 */
import { runLlmDraft, type RouterDeps } from "../lib/llmRouter";
import { getChain, type LlmRole } from "../lib/modelPolicy";
import type { GeneratorLabel } from "../lib/usageTracker";

export type WriterLabel = "draft" | "rewriter";

export interface GeneratedDraft {
  subject: string;
  body: string;
}

export interface WriterResult extends GeneratedDraft {
  /** The concrete model string that produced this draft (for logs and tests). */
  modelUsed: string;
  /** Which vendor served it. */
  provider: "gemini" | "openai";
  /** 1-based position in the chain, so a log line says "tier 3 served this". */
  tierIndex: number;
}

/**
 * Map (stage, grey-area) onto a router role.
 *
 * Grey-area is a routing decision, not a special case inside the chain walk:
 * expressing it as its own role means the whole policy for regulated verticals
 * is one table entry in lib/modelPolicy.ts that an operator can read and
 * override, instead of a boolean threaded through the fallback loop.
 */
export function writerRole(label: WriterLabel, greyArea: boolean): LlmRole {
  if (label === "draft") return greyArea ? "grey_draft" : "draft";
  return greyArea ? "grey_rewriter" : "rewriter";
}

export interface RunWriterArgs {
  /**
   * Which chain to walk. The doctrine flow computes this with writerRole();
   * the context and anti-ghosting flows pass their own roles directly, because
   * they have their own chain (see EXEMPLARLESS_WRITER_CHAIN in modelPolicy).
   */
  role: LlmRole;
  /** System instruction parts, in order (untrusted clause, role prompt, ...). */
  systemParts: string[];
  /** The user turn. The caller has already prepended any exemplar block. */
  userPrompt: string;
  maxOutputTokens?: number;
  /** Usage-ledger label for this flow's writer stage. */
  usageLabel?: GeneratorLabel;
  /** For logs only. */
  prospectName?: string;
}

/**
 * Run the writer waterfall for one draft or rewrite.
 *
 * Returns the first tier that produces a well-formed {subject, body}. A tier
 * that 429s, 503s, times out, is safety-blocked, or answers with something that
 * is not a valid draft is skipped and the next tier is tried; a model that has
 * failed repeatedly is skipped outright for a cooldown. Throws
 * AllTiersFailedError only when the whole chain is unavailable, which the
 * caller surfaces as a failed follow-up rather than degrading to a template.
 */
export async function runWriter(
  args: RunWriterArgs,
  depsOverride?: Partial<RouterDeps>,
): Promise<WriterResult> {
  const { value, result } = await runLlmDraft(
    {
      role: args.role,
      systemParts: args.systemParts,
      user: args.userPrompt,
      maxOutputTokens: args.maxOutputTokens ?? 8192,
      usage: args.usageLabel ? { kind: "pipeline", label: args.usageLabel } : { kind: "none" },
      prospectName: args.prospectName,
    },
    depsOverride,
  );
  return {
    subject: value.subject,
    body: value.body,
    modelUsed: result.model,
    provider: result.provider,
    tierIndex: result.tierIndex,
  };
}

/**
 * The model that ordinarily writes drafts. Reporting and smoke scripts print
 * this; nothing routes on it. Reads the live chain so it can never drift from
 * what actually runs.
 */
export function getPrimaryWriterModel(): string {
  return getChain("draft")[0]?.model ?? "(no writer chain configured)";
}
