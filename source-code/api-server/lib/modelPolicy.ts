/**
 * modelPolicy.ts — the single source of truth for WHICH model serves WHICH
 * role, and in WHAT ORDER when the preferred one is unavailable.
 *
 * WHY THIS FILE EXISTS
 *
 * Before it, model choice was scattered: constants in lib/anthropic.ts, a
 * two-tier chain in services/writerProvider.ts, a one-model default in
 * services/criticProvider.ts, an inline env read in emailSummarizer.ts, and a
 * hardcoded model string in lib/followupAckConfirm.ts. Six places, three
 * different fallback policies, and five roles with no fallback at all.
 *
 * Everything now resolves here, so "what does the critic run on, and what
 * happens when that 503s?" has exactly one answer you can read.
 *
 * THE ANTHROPIC BAN
 *
 * Aug 2026: the Anthropic account's card was declined, so every Anthropic model
 * is off the table until billing is restored. This is not a preference that can
 * be quietly regressed by editing a string — assertNoAnthropic() rejects any
 * chain containing an Anthropic model, including one supplied through an env
 * override, and it runs at module load. A misconfiguration fails at boot with a
 * readable message rather than at 2am with a 401 on a live send.
 *
 * WHY EVERY CHAIN SPANS BOTH VENDORS
 *
 * Models run out of capacity. Gemini answers 503 UNAVAILABLE and 429
 * RESOURCE_EXHAUSTED under load; OpenAI does the same. A waterfall built only
 * from Gemini tiers shares one quota pool, one control plane and one incident
 * page, so a Google-side event takes every tier down together. Each chain below
 * therefore alternates vendors: tier 1 Gemini, tier 2 OpenAI, tier 3 Gemini,
 * and where a fourth tier is warranted, OpenAI again. A whole-vendor outage
 * costs latency, never the pipeline.
 *
 * COST ORDERING
 *
 * Tiers are cost-ordered, cheapest first, so the ordinary path is also the
 * cheapest path and the dearer tiers are only ever paid for when the cheap ones
 * cannot serve.
 *
 * Three chains deliberately break that ordering, each for a measured reason:
 *   critic          — the judgment stage. A critic that misses a bad draft
 *                     costs a rewrite loop, or a bad email, worth far more than
 *                     the token delta.
 *   context_ and ag_ — the two flows with no exemplar library. The cheap writer
 *                     measurably regresses nativeness there and nothing
 *                     carries it; see EXEMPLARLESS_WRITER_CHAIN.
 *   grey_            — regulated verticals, where the realistic failure is a
 *                     safety block rather than capacity.
 *
 * ENV OVERRIDES
 *
 * Any chain can be replaced at deploy time without a code change:
 *
 *   LLM_CHAIN_DRAFT="gemini:gemini-3.1-flash-lite@MINIMAL,openai:gpt-5.4-nano@none"
 *
 * Format: comma-separated `provider:model[@effort]`. `provider` is gemini or
 * openai. `@effort` is the Gemini thinkingLevel (MINIMAL|LOW|MEDIUM|HIGH) or
 * the OpenAI reasoning_effort (none|low|medium|high|xhigh). Omitting it means
 * "the transport's default": for OpenAI that is reasoning_effort=none, for
 * Gemini it is GEMINI_CRITIC_THINKING (or MEDIUM when that is unset) — so
 * write the @level explicitly in overrides rather than relying on it. A
 * malformed entry is skipped with a warning rather than taking the process
 * down; an empty resulting chain falls back to the built-in.
 */
import { logger } from "./logger";
import type { ThinkingLevel } from "./gemini";
import type { ReasoningEffort } from "./openai";

export type LlmProviderName = "gemini" | "openai";

/**
 * Every LLM job in the product. One role per distinct prompt+task pair, so a
 * role can be retuned without disturbing its neighbours.
 */
export type LlmRole =
  // Doctrine follow-up flow
  | "draft"
  | "critic"
  | "rewriter"
  // Grey-area verticals (casino, betting, crypto/forex/CFD, ...) — see lib/greyArea.ts
  | "grey_draft"
  | "grey_rewriter"
  // Context Based Followuper
  | "context_draft"
  | "context_critic"
  | "context_rewriter"
  // Anti-ghosting flow
  | "ag_draft"
  | "ag_critic"
  | "ag_rewriter"
  // Auxiliary calls outside the generation pipeline
  | "summarizer"
  | "reply_sentiment"
  | "ack_confirm";

export interface ModelTier {
  provider: LlmProviderName;
  model: string;
  /** Gemini thinkingLevel. Ignored for OpenAI tiers. */
  thinking?: ThinkingLevel;
  /** OpenAI reasoning_effort. Ignored for Gemini tiers. */
  effort?: ReasoningEffort;
}

// ---------------------------------------------------------------------------
// Model shorthands. Named so a chain reads as a sentence and a model swap is
// one edit rather than nine.
// ---------------------------------------------------------------------------

// Gemini — cheapest first.
//   gemini-3.1-flash-lite   0.25 / 1.50   MINIMAL thinking supported
//   gemini-3-flash-preview  0.50 / 3.00   MINIMAL thinking supported
//   gemini-3.7-flash        0.75 / 3.75   thinking floor is LOW (MINIMAL 400s)
const G_FLASH_LITE = (thinking: ThinkingLevel = "MINIMAL"): ModelTier => ({
  provider: "gemini",
  model: process.env.GEMINI_FLASH_LITE_MODEL || "gemini-3.1-flash-lite",
  thinking,
});
const G_FLASH = (thinking: ThinkingLevel = "MEDIUM"): ModelTier => ({
  provider: "gemini",
  model: process.env.GEMINI_FLASH_MODEL || "gemini-3-flash-preview",
  thinking,
});
const G_FLASH_37 = (thinking: ThinkingLevel = "LOW"): ModelTier => ({
  provider: "gemini",
  model: process.env.GEMINI_FLASH_37_MODEL || "gemini-3.7-flash",
  thinking,
});

// OpenAI — cheapest first.
//   gpt-5.4-nano  0.20 / 1.25   reasoning_effort supported; default 'none'
//   gpt-4.1-mini  0.40 / 1.60   no reasoning_effort field at all
//   gpt-5.4-mini  0.75 / 4.50   reasoning_effort supported
const O_NANO = (effort: ReasoningEffort = "none"): ModelTier => ({
  provider: "openai",
  model: process.env.OPENAI_NANO_MODEL || "gpt-5.4-nano",
  effort,
});
const O_MINI_41 = (): ModelTier => ({
  provider: "openai",
  model: process.env.OPENAI_MINI_41_MODEL || "gpt-4.1-mini",
});
const O_MINI = (effort: ReasoningEffort = "none"): ModelTier => ({
  provider: "openai",
  model: process.env.OPENAI_MINI_MODEL || "gpt-5.4-mini",
  effort,
});

// ---------------------------------------------------------------------------
// The chains.
// ---------------------------------------------------------------------------

/**
 * Doctrine writer chain — the initial draft and every rewrite for the doctrine
 * flow, which is the high-volume one.
 *
 * Flash-Lite is tier 1 on measured evidence, not reputation: a 36-cell A/B over
 * 12 languages x 3 verticals through the real production prompts and the real
 * production lint gate put it at 61-67% first-draft clean, better than every
 * other candidate at anything near its price (bench-llm-quality.ts, 27 Aug
 * 2026). This flow injects a gold-standard exemplar block into the user prompt
 * for EVERY tier (lib/exemplarLibrary.ts), which is what carries the cheapest
 * tier; the deterministic linter and the critic/rewrite loop repair the rest,
 * and they run identically whatever tier wrote the draft.
 *
 * Tier 2 crosses to OpenAI at a comparable price. gpt-5.4-nano's measured
 * weakness is nativeness — it leaves English words in a non-English email
 * (FORBIDDEN-ENGLISH-SINGLETON was 13 of its 19 lint failures) — which is
 * exactly the class of fault the deterministic linter catches every time. That
 * makes it a sound fallback and a poor primary.
 *
 * Tier 3 steps UP in capability rather than down in price: if both cheap tiers
 * are unavailable something unusual is happening, and gemini-3.7-flash measured
 * highest of the whole field (70.8%). Tier 4 is a different OpenAI model CLASS,
 * which matters because the account's 200k TPM is shared — a nano tier already
 * throttled does not mean a mini tier is.
 */
const WRITER_CHAIN = (): ModelTier[] => [
  G_FLASH_LITE(writerPrimaryThinking()),
  O_NANO("none"),
  G_FLASH_37("LOW"),
  O_MINI("none"),
];

/**
 * Thinking level for the writer primary. The single biggest quality lever
 * measured: same model, same cells, LOW scored 72.2% first-draft clean against
 * MINIMAL's 61.1% — a paired comparison, so the 11-point gap is real and not the
 * ~6-point run-to-run noise of the harness. LOW costs about 2.5x per draft.
 *
 * MINIMAL is the default because the decision is end-to-end, not per-draft: a
 * dirty draft costs a critic call plus a rewrite, and at these rates the cheaper
 * draft still wins on total cost per SHIPPED email. Flip it with
 * WRITER_THINKING=LOW when quality is worth more than the delta — that is a
 * business call, so it is one env var, not a code change.
 */
function writerPrimaryThinking(): ThinkingLevel {
  const v = (process.env.WRITER_THINKING || "").trim().toUpperCase();
  return v === "LOW" || v === "MEDIUM" || v === "HIGH" ? (v as ThinkingLevel) : "MINIMAL";
}

/**
 * Exemplar-less writer chain — the Context Based Followuper and the
 * anti-ghosting flow.
 *
 * These two flows do NOT have an exemplar library. That is the whole reason
 * they need their own chain: when the writer was first moved to a cheap tier,
 * a cross-language smoke found the cheap Flash writer regressed nativeness here
 * specifically — untranslated English singletons in Latin-script languages
 * ("test" surviving into fr/es/pt copy) — scoring 50% clean against the
 * then-Sonnet writer's 80%. The doctrine flow did not regress, because its
 * exemplar block carries the cheap tier. Without exemplars there is nothing to
 * carry it.
 *
 * So these flows start a tier up and think harder, and the cheap tier sits
 * BELOW them as a fallback rather than above them as the default. They are also
 * far lower volume than the doctrine flow, so the higher unit price barely moves
 * the blended cost.
 */
const EXEMPLARLESS_WRITER_CHAIN = (): ModelTier[] => [
  G_FLASH_37("LOW"),
  O_MINI("none"),
  G_FLASH_LITE("LOW"),
  O_MINI_41(),
];

/**
 * Critic chain — the judgment stage.
 *
 * Deliberately NOT the cheapest model available, and the one place in the
 * product where cost is not the tie-breaker. By the time a draft reaches the
 * LLM critic the deterministic linter has already rewritten anything that trips
 * a mechanical rule (see GEMINI_CRITIC_FOCUS in criticProvider.ts), so what is
 * left is exactly the judgment a regex cannot make: is this relevant to this
 * prospect, does it advance a new angle, does it read as a human. A critic that
 * waves through a bad draft costs a whole extra send; the token delta between
 * tier 1 here and Flash-Lite is a rounding error against that.
 *
 * Note that gemini-3-flash-preview measured POORLY as a writer (54.2%) at 3x
 * flash-lite's price. That is not a contradiction — grading and drafting are
 * different jobs — but it is why it must not be promoted into the writer chain
 * on the strength of sitting at the head of this one.
 */
const CRITIC_CHAIN = (): ModelTier[] => [
  G_FLASH(criticThinking()),
  O_MINI("low"),
  G_FLASH_37("LOW"),
  O_MINI_41(),
];

/**
 * Thinking level for the critic head. LOW, on measurement, not intuition.
 *
 * A 90-call battery (scripts/bench-llm-critic.ts, 27 Aug 2026) put seven
 * planted doctrine faults and two clean controls in front of five candidate
 * critics, twice each. Every candidate scored 100% recall and 100% naming — all
 * of them caught every planted fault and described it well enough for the
 * rewriter to fix the right thing. What separated them was cost and latency:
 *
 *   gemini-3-flash-preview @MEDIUM   $0.009458/call   12,390 ms
 *   gemini-3-flash-preview @LOW      $0.003786/call    3,377 ms
 *
 * Identical verdicts, 2.5x the price and 3.7x the wall-clock. The latency is
 * the part that stings: the critic runs inside a 180-second per-row generation
 * deadline (lib/generationDeadline.ts), and a 12-second critic spends 7% of
 * that budget for nothing.
 *
 * Raise it with CRITIC_THINKING if a future battery finds a fault class that
 * only deeper thinking catches — but bring the battery.
 */
function criticThinking(): ThinkingLevel {
  const v = (process.env.CRITIC_THINKING || "").trim().toUpperCase();
  return v === "MINIMAL" || v === "MEDIUM" || v === "HIGH" ? (v as ThinkingLevel) : "LOW";
}

/**
 * Grey-area writer chain — casino, betting, gambling, crypto/forex/CFD.
 *
 * These verticals used to be pinned to Sonnet as a compliance and consistency
 * choice. With Anthropic unavailable that pin cannot hold, so the policy
 * becomes: start at the strongest tier rather than the cheapest, and make sure
 * the chain crosses vendors, because the realistic failure here is not capacity
 * but a SAFETY BLOCK. Gemini returns promptFeedback.blockReason on content it
 * declines and lib/gemini.ts throws on it, which the router treats like any
 * other tier failure — so a Gemini refusal lands on OpenAI rather than on the
 * floor. Volume in these verticals is low, so the higher unit price is
 * immaterial to the blended cost.
 */
const GREY_WRITER_CHAIN = (): ModelTier[] => [
  G_FLASH_37("LOW"),
  O_MINI("none"),
  G_FLASH("MEDIUM"),
  O_MINI_41(),
];

/**
 * Summarizer chain — extract a short topic noun-phrase and an ISO language code
 * from an inbound email. An easy task with a heavy deterministic sanitizer
 * (sanitizeSummary) behind it, so the cheapest tiers are the right ones.
 */
const SUMMARIZER_CHAIN = (): ModelTier[] => [
  G_FLASH_LITE("MINIMAL"),
  O_NANO("none"),
  G_FLASH("MINIMAL"),
];

/**
 * Reply-sentiment chain — classify one inbound reply positive/negative/ooo.
 *
 * Short prompt, 200-token answer, so cost per call is negligible whatever tier
 * serves it — a few hundredths of a cent. Quality, by contrast, is asymmetric
 * and load-bearing: a false "positive" pauses a real campaign, while a false
 * "negative" costs one extra follow-up. That asymmetry is why this chain starts
 * a tier above the summarizer despite the near-identical prompt size.
 */
const REPLY_SENTIMENT_CHAIN = (): ModelTier[] => [
  G_FLASH("LOW"),
  O_MINI("none"),
  G_FLASH_LITE("MINIMAL"),
];

/**
 * FOLLOWUP-ACK confirm chain — a single YES/NO on whether an email's opening
 * references prior outreach. Five output tokens. The caller is conservative
 * fail-open (any error keeps the deterministic flag), so the cheapest tiers are
 * correct and a total outage is merely today's behaviour.
 */
const ACK_CONFIRM_CHAIN = (): ModelTier[] => [
  G_FLASH_LITE("MINIMAL"),
  O_NANO("none"),
];

/**
 * Built-in chains, as thunks rather than values.
 *
 * They are built per call because the model ids and the writer thinking level
 * are env-readable, and `getChain` documents itself as reading fresh — a
 * module-load snapshot would silently ignore an env change a test or an
 * operator made after import, which is the kind of divergence that is only ever
 * discovered in production.
 */
const BUILTIN_CHAINS: Record<LlmRole, () => ModelTier[]> = {
  draft: WRITER_CHAIN,
  rewriter: WRITER_CHAIN,
  critic: CRITIC_CHAIN,
  grey_draft: GREY_WRITER_CHAIN,
  grey_rewriter: GREY_WRITER_CHAIN,
  // The two exemplar-less flows share a chain that starts a tier up. See
  // EXEMPLARLESS_WRITER_CHAIN for the measurement behind that.
  context_draft: EXEMPLARLESS_WRITER_CHAIN,
  context_rewriter: EXEMPLARLESS_WRITER_CHAIN,
  context_critic: CRITIC_CHAIN,
  ag_draft: EXEMPLARLESS_WRITER_CHAIN,
  ag_rewriter: EXEMPLARLESS_WRITER_CHAIN,
  ag_critic: CRITIC_CHAIN,
  summarizer: SUMMARIZER_CHAIN,
  reply_sentiment: REPLY_SENTIMENT_CHAIN,
  ack_confirm: ACK_CONFIRM_CHAIN,
};

export const ALL_LLM_ROLES = Object.keys(BUILTIN_CHAINS) as LlmRole[];

// ---------------------------------------------------------------------------
// The Anthropic ban.
// ---------------------------------------------------------------------------

/**
 * True for any Anthropic model identifier, in either the bare or the
 * fully-qualified Bedrock/Vertex form.
 */
export function isAnthropicModel(model: string): boolean {
  return /(^|[.\/])(claude|anthropic)/i.test(model) || /^claude-/i.test(model);
}

/**
 * Reject a chain containing an Anthropic model. Called on every built-in chain
 * at module load and on every env override as it is parsed, so an Anthropic
 * model can neither be committed nor deployed by accident while the ban stands.
 *
 * Lift the ban by deleting this function and its call sites — deliberately a
 * visible edit, not an env flag, because turning Anthropic back on is a billing
 * decision, not a runtime one.
 */
export function assertNoAnthropic(role: string, chain: ModelTier[]): void {
  const offender = chain.find((t) => isAnthropicModel(t.model));
  if (offender) {
    throw new Error(
      `Anthropic models are disabled (role "${role}" names "${offender.model}"). ` +
        `The Anthropic account is unfunded as of Aug 2026; every role must run on ` +
        `Gemini or OpenAI. See lib/modelPolicy.ts.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Env override parsing.
// ---------------------------------------------------------------------------

const GEMINI_LEVELS = new Set<string>(["MINIMAL", "LOW", "MEDIUM", "HIGH"]);
const OPENAI_EFFORTS = new Set<string>(["none", "low", "medium", "high", "xhigh"]);

/** `LLM_CHAIN_DRAFT`, `LLM_CHAIN_REPLY_SENTIMENT`, ... */
export function envVarForRole(role: LlmRole): string {
  return `LLM_CHAIN_${role.toUpperCase()}`;
}

/**
 * Parse a chain spec: `provider:model[@effort],provider:model[@effort],...`
 *
 * Exported for the unit tests and for the startup validator. A malformed entry
 * is dropped with a warning rather than throwing, so one typo in one tier does
 * not take the deploy down — but an Anthropic model DOES throw, because
 * silently dropping it would leave a shorter chain that looks intentional.
 */
export function parseChainSpec(role: string, spec: string): ModelTier[] {
  const tiers: ModelTier[] = [];
  for (const rawEntry of spec.split(",")) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    const [head, effortRaw] = entry.split("@");
    const idx = head.indexOf(":");
    if (idx <= 0) {
      logger.warn({ role, entry }, "modelPolicy: skipping malformed chain entry (want provider:model)");
      continue;
    }
    const provider = head.slice(0, idx).trim().toLowerCase();
    const model = head.slice(idx + 1).trim();
    if (!model) {
      logger.warn({ role, entry }, "modelPolicy: skipping chain entry with an empty model");
      continue;
    }
    if (isAnthropicModel(model)) {
      // Throw rather than skip: a dropped tier changes the chain's meaning
      // silently, and the whole point of the ban is that it cannot be silent.
      assertNoAnthropic(role, [{ provider: "gemini", model }]);
    }
    if (provider === "gemini") {
      const thinking = (effortRaw || "").trim().toUpperCase();
      tiers.push({
        provider: "gemini",
        model,
        ...(GEMINI_LEVELS.has(thinking) ? { thinking: thinking as ThinkingLevel } : {}),
      });
    } else if (provider === "openai") {
      const effort = (effortRaw || "").trim().toLowerCase();
      tiers.push({
        provider: "openai",
        model,
        ...(OPENAI_EFFORTS.has(effort) ? { effort: effort as ReasoningEffort } : {}),
      });
    } else {
      logger.warn({ role, entry, provider }, "modelPolicy: unknown provider in chain entry");
    }
  }
  return tiers;
}

/**
 * The ordered waterfall for a role: the env override when one is set and parses
 * to at least one tier, otherwise the built-in chain.
 *
 * Read fresh on every call rather than cached at module load, so a test (or an
 * operator with a REPL) can change a chain by setting the env var. The chains
 * are three or four small objects; there is nothing to memoize.
 */
export function getChain(role: LlmRole): ModelTier[] {
  const spec = process.env[envVarForRole(role)];
  if (spec && spec.trim()) {
    const parsed = parseChainSpec(role, spec);
    if (parsed.length > 0) {
      assertNoAnthropic(role, parsed);
      return parsed;
    }
    logger.warn(
      { role, spec },
      "modelPolicy: env chain override parsed to nothing — using the built-in chain",
    );
  }
  const builtin = BUILTIN_CHAINS[role]();
  assertNoAnthropic(role, builtin);
  return builtin;
}

/**
 * Validate every role's chain. Called once from the server boot path so a bad
 * override or a smuggled-in Anthropic model fails visibly at startup, in the
 * deploy logs, rather than on the first follow-up of the night.
 *
 * Returns the resolved chains so the boot log can print exactly what will run.
 */
export function validateAllChains(): Record<LlmRole, ModelTier[]> {
  const out = {} as Record<LlmRole, ModelTier[]>;
  for (const role of ALL_LLM_ROLES) {
    out[role] = getChain(role);
  }
  return out;
}

/** One-line rendering of a chain, for logs: `gemini:gemini-3.1-flash-lite@MINIMAL -> openai:gpt-5.4-nano@none`. */
export function describeChain(chain: ModelTier[]): string {
  return chain
    .map((t) => `${t.provider}:${t.model}${t.thinking ? `@${t.thinking}` : t.effort ? `@${t.effort}` : ""}`)
    .join(" -> ");
}
