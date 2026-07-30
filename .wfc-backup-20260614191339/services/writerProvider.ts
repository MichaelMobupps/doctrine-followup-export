/**
 * Writer-stage provider switch with a cost-ordered fallback chain.
 *
 * Governs the WRITER stages of the follow-up pipeline (the initial draft and
 * every rewrite). The critic stage is governed separately by criticProvider.ts.
 *
 * Chain (ordinary verticals, WRITER_PROVIDER=gemini, the default):
 *   1. Gemini 3.5 Flash   (GEMINI_WRITER_PRIMARY_MODEL,   default gemini-3.5-flash)
 *   2. Gemini 3.1 Pro     (GEMINI_WRITER_SECONDARY_MODEL, default gemini-3.1-pro-preview)
 *   3. Sonnet 4.6         (the in-house Anthropic writer, the safety net)
 *
 * A tier is used only when the cheaper tiers above it are unavailable. "Unavailable"
 * means the call threw after its own bounded retries: a capacity wall (HTTP 429
 * RESOURCE_EXHAUSTED), an overload (HTTP 503 UNAVAILABLE), a timeout, or a parse
 * failure. There is no parallel or shadow execution; exactly one tier produces
 * each draft.
 *
 * Grey-area verticals (casino, betting, gambling, crypto/forex/CFD, etc., per
 * lib/greyArea.ts) skip the Gemini tiers entirely and write on Sonnet by
 * default. This is a compliance and consistency choice, not a quality one.
 *
 * Quality is held up, not down: the caller injects a gold-standard exemplar
 * block into the user prompt for EVERY tier (see lib/exemplarLibrary.ts), so the
 * cheaper Gemini tiers write against the same doctrine examples as Sonnet. The
 * existing deterministic linter and the critic/rewrite healing loop run
 * unchanged on top of whatever tier produced the draft, so a weaker draft is
 * still caught and repaired exactly as before.
 *
 * Per-model circuit breakers (mirroring criticProvider.ts) stop the chain from
 * paying each Gemini tier's retry latency on every draft during a sustained
 * outage: after a short run of failures a breaker opens and that tier is skipped
 * for a cooldown, so one probe per cooldown replaces a per-draft stall.
 *
 * Escape hatch: WRITER_PROVIDER=anthropic forces the Sonnet writer on every
 * draft and never calls Gemini.
 *
 * Tunables (all optional):
 *   WRITER_PROVIDER               gemini (default) | anthropic
 *   GEMINI_WRITER_PRIMARY_MODEL   default gemini-3.5-flash
 *   GEMINI_WRITER_SECONDARY_MODEL default gemini-3.1-pro-preview
 *   GEMINI_WRITER_THINKING        LOW | MEDIUM | HIGH (default MEDIUM)
 *   GEMINI_WRITER_MAX_TOKENS      default inherits the caller's maxOutputTokens
 */
import {
  geminiGenerateJson as realGeminiGenerateJson,
  isGeminiConfigured as realIsGeminiConfigured,
  type ThinkingLevel,
} from "../lib/gemini";
import { logger as realLogger } from "../lib/logger";
import { recordGeminiUsageBestEffort as realRecordGeminiUsage } from "../lib/usageTracker";
import { createCircuitBreaker, type CircuitBreaker } from "../lib/circuitBreaker";

export type WriterTier = "gemini_primary" | "gemini_secondary" | "anthropic";
export type WriterLabel = "draft" | "rewriter";

export interface GeneratedDraft {
  subject: string;
  body: string;
}

export interface WriterResult extends GeneratedDraft {
  /** The concrete model string that produced this draft (for logs and tests). */
  modelUsed: string;
  /** Which tier in the chain served the draft. */
  tier: WriterTier;
}

export type WriterProviderName = "anthropic" | "gemini";

export function getWriterProvider(): WriterProviderName {
  // Gemini is the default. Only an explicit "anthropic" forces Sonnet-only.
  const v = (process.env.WRITER_PROVIDER || "gemini").toLowerCase();
  return v === "anthropic" ? "anthropic" : "gemini";
}

export function getPrimaryGeminiModel(): string {
  return process.env.GEMINI_WRITER_PRIMARY_MODEL || "gemini-3.5-flash";
}

export function getSecondaryGeminiModel(): string {
  return process.env.GEMINI_WRITER_SECONDARY_MODEL || "gemini-3.1-pro-preview";
}

function resolveWriterThinking(): ThinkingLevel {
  const v = (process.env.GEMINI_WRITER_THINKING || "MEDIUM").toUpperCase();
  if (v === "LOW" || v === "HIGH" || v === "MEDIUM") return v;
  return "MEDIUM";
}

/**
 * Pure planner: produce the ordered list of tiers to try for a draft.
 *
 * Sonnet ("anthropic") is always the final element so the chain can never fail
 * to produce a writer. Grey-area drafts, the anthropic escape hatch, and a
 * missing GEMINI_API_KEY all collapse the chain to ["anthropic"]. Kept pure and
 * argument-driven so it is hermetically testable.
 */
export function planWriterChain(opts: {
  provider: WriterProviderName;
  greyArea: boolean;
  geminiConfigured: boolean;
}): WriterTier[] {
  if (opts.provider === "anthropic" || opts.greyArea || !opts.geminiConfigured) {
    return ["anthropic"];
  }
  return ["gemini_primary", "gemini_secondary", "anthropic"];
}

// Module-level breakers, one per Gemini writer tier. State is shared across the
// long-running api-server process. Same thresholds as the critic breaker.
const primaryBreaker = createCircuitBreaker({ failureThreshold: 3, cooldownMs: 60_000 });
const secondaryBreaker = createCircuitBreaker({ failureThreshold: 3, cooldownMs: 60_000 });

// Tolerant JSON extraction for the Gemini writer output. responseMimeType
// application/json normally yields a bare object; the fence-strip and brace-slice
// are belt-and-suspenders. A failure throws and the chain advances to the next
// tier, so a malformed Gemini response degrades to Pro and then Sonnet.
function parseSubjectBody(text: string): GeneratedDraft {
  let raw = text.replace(/```json\s*|```/g, "").trim();
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first !== -1 && last > first) raw = raw.slice(first, last + 1);
  let parsed: { subject?: unknown; body?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch {
    const subjectMatch = raw.match(/"subject"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    const bodyMatch = raw.match(/"body"\s*:\s*"((?:[^"\\]|\\[\s\S])*)"\s*\}$/s);
    if (subjectMatch && bodyMatch) {
      parsed = {
        subject: unescapeJsonString(subjectMatch[1]),
        body: unescapeJsonString(bodyMatch[1]),
      };
    } else {
      throw new SyntaxError(`Gemini writer JSON parse failed: ${raw.slice(0, 200)}`);
    }
  }
  const subject = typeof parsed.subject === "string" ? parsed.subject : "";
  const body = typeof parsed.body === "string" ? parsed.body : "";
  if (!subject || !body) {
    throw new Error("Gemini writer output missing subject or body");
  }
  return { subject, body };
}

function unescapeJsonString(s: string): string {
  return s
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

// Classify a Gemini failure for logging only. The chain advances on ANY throw;
// this just labels the cause as a capacity wall vs a generic error in the logs,
// which is what Michael reads when a batch shifts off Flash.
function isCapacityError(err: unknown): boolean {
  const m = String((err as { message?: string })?.message ?? err).toLowerCase();
  return (
    m.includes("429") ||
    m.includes("503") ||
    m.includes("resource_exhausted") ||
    m.includes("unavailable") ||
    m.includes("overloaded") ||
    m.includes("quota") ||
    m.includes("rate limit")
  );
}

// Injectable dependencies. Defaults wire the real modules; tests pass fakes to
// exercise the chain without network, DB, or billing.
export interface WriterDeps {
  geminiGenerateJson: typeof realGeminiGenerateJson;
  isGeminiConfigured: typeof realIsGeminiConfigured;
  recordGeminiUsage: typeof realRecordGeminiUsage;
  primaryBreaker: CircuitBreaker;
  secondaryBreaker: CircuitBreaker;
  logger: Pick<typeof realLogger, "info" | "warn">;
}

const defaultDeps: WriterDeps = {
  geminiGenerateJson: realGeminiGenerateJson,
  isGeminiConfigured: realIsGeminiConfigured,
  recordGeminiUsage: realRecordGeminiUsage,
  primaryBreaker,
  secondaryBreaker,
  logger: realLogger,
};

export interface RunWriterArgs {
  label: WriterLabel;
  greyArea: boolean;
  /** System instruction parts, in order (untrusted clause, role prompt, ...). */
  systemParts: string[];
  /** The user turn. The caller has already prepended any exemplar block. */
  userPrompt: string;
  maxOutputTokens?: number;
  /** For logs only. */
  prospectName?: string;
}

/**
 * The in-house Sonnet writer for the final tier. Returns the parsed draft and
 * the model string it ran on, and is responsible for recording its own usage
 * on the followup_usage ledger (it already does, via recordUsageBestEffort).
 */
export type AnthropicWriterFn = () => Promise<WriterResult>;

/**
 * Run the writer chain for one draft or rewrite.
 *
 * Tries each planned tier in order. Gemini tiers parse JSON, record usage on the
 * shared ledger, and trip their breaker on failure. The final Sonnet tier is the
 * caller-supplied anthropicWriter, which never enters the chain logic and always
 * runs last. Returns the first successful tier's result.
 */
export async function runWriter(
  args: RunWriterArgs,
  anthropicWriter: AnthropicWriterFn,
  depsOverride?: Partial<WriterDeps>,
): Promise<WriterResult> {
  const deps: WriterDeps = { ...defaultDeps, ...depsOverride };
  const provider = getWriterProvider();
  const geminiConfigured = deps.isGeminiConfigured();
  const chain = planWriterChain({ provider, greyArea: args.greyArea, geminiConfigured });

  // Log the routing decision once, with the reason, so a shifted batch is easy
  // to explain after the fact.
  if (chain.length === 1) {
    const reason = args.greyArea
      ? "grey-area vertical"
      : provider === "anthropic"
      ? "WRITER_PROVIDER=anthropic"
      : "GEMINI_API_KEY not set";
    deps.logger.info(
      { prospect: args.prospectName, label: args.label, reason },
      "Writer routed straight to Sonnet",
    );
  }

  for (const tier of chain) {
    if (tier === "anthropic") {
      return anthropicWriter();
    }

    const model = tier === "gemini_primary" ? getPrimaryGeminiModel() : getSecondaryGeminiModel();
    const breaker = tier === "gemini_primary" ? deps.primaryBreaker : deps.secondaryBreaker;

    if (!breaker.shouldAttempt()) {
      deps.logger.info(
        { prospect: args.prospectName, label: args.label, tier, model, breaker: breaker.state() },
        "Writer tier breaker open — skipping to next tier",
      );
      continue;
    }

    try {
      const res = await deps.geminiGenerateJson({
        systemParts: args.systemParts,
        user: args.userPrompt,
        maxOutputTokens: args.maxOutputTokens ?? 8192,
        model,
        thinkingLevel: resolveWriterThinking(),
      });
      const draft = parseSubjectBody(res.text);
      // Record usage on the same ledger as the Anthropic stages, under the same
      // label, with the model field distinguishing the tier. Best-effort.
      void deps.recordGeminiUsage(res.usage, res.model, args.label);
      breaker.onSuccess();
      deps.logger.info(
        { prospect: args.prospectName, label: args.label, tier, model: res.model },
        "Writer produced draft on Gemini tier",
      );
      return { ...draft, modelUsed: res.model, tier };
    } catch (err) {
      breaker.onFailure();
      const capacity = isCapacityError(err);
      deps.logger.warn(
        {
          err: String(err),
          prospect: args.prospectName,
          label: args.label,
          tier,
          model,
          cause: capacity ? "capacity" : "error",
          breaker: breaker.state(),
        },
        `Writer tier unavailable (${capacity ? "capacity" : "error"}) — falling back to next tier`,
      );
      // Advance to the next tier in the chain.
    }
  }

  // Unreachable: planWriterChain always ends with "anthropic". Defensive only.
  return anthropicWriter();
}
