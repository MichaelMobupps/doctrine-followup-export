/**
 * Writer-stage provider switch with a cost-ordered fallback chain.
 *
 * Governs the WRITER stages of the follow-up pipeline (the initial draft and
 * every rewrite). The critic stage is governed separately by criticProvider.ts.
 *
 * Chain (ordinary verticals, WRITER_PROVIDER=gemini, the default):
 *   1. Gemini 3.1 Flash-Lite (GEMINI_WRITER_PRIMARY_MODEL, default gemini-3.1-flash-lite)
 *   2. Sonnet 4.6            (the in-house Anthropic writer, the safety net)
 *
 * Flash-Lite is the writer primary because a 36-language exemplar A/B showed it
 * matches/beats Sonnet on first-draft doctrine compliance while costing ~6x less
 * than gemini-3.5-flash; the exemplar block carries it, the critic/rewrite loop
 * repairs the rest.
 *
 * Gemini 3.1 Pro is an opt-in middle tier, off by default. Pro cannot run below
 * LOW thinking, so its output token count swings widely and it averages more
 * expensive than Sonnet, which makes it a poor default fallback. Set
 * WRITER_GEMINI_SECONDARY=on to insert Pro between Flash and Sonnet when you want
 * extra Gemini capacity (Pro runs on a separate Gemini quota) before paying
 * Anthropic. With it on the chain is Flash, then Pro, then Sonnet.
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
 *   WRITER_PROVIDER                gemini (default) | anthropic
 *   WRITER_GEMINI_SECONDARY        on to add the Gemini Pro middle tier (default off)
 *   GEMINI_WRITER_PRIMARY_MODEL    default gemini-3.1-flash-lite
 *   GEMINI_WRITER_SECONDARY_MODEL  default gemini-3.1-pro-preview
 *   GEMINI_WRITER_PRIMARY_THINKING   MINIMAL | LOW | MEDIUM | HIGH (default MINIMAL, Flash floor is MINIMAL)
 *   GEMINI_WRITER_SECONDARY_THINKING MINIMAL | LOW | MEDIUM | HIGH (default LOW, Pro floor is LOW)
 *   GEMINI_WRITER_THINKING         overrides both tiers when set (back-compat)
 *
 * The writer constrains Gemini output with a {subject, body} response schema, so
 * a Gemini tier cannot emit malformed JSON.
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
  // gemini-3.1-flash-lite: validated as the writer primary by a 36-language
  // exemplar A/B (75% first-draft clean vs Sonnet 69%), and ~6x cheaper than
  // gemini-3.5-flash (0.25/1.50 vs 1.50/9.00 per 1M tok). The exemplar block
  // carries the cheapest tier to parity, and the critic + rewrite loop repair
  // the rest. Override with GEMINI_WRITER_PRIMARY_MODEL to change or revert.
  return process.env.GEMINI_WRITER_PRIMARY_MODEL || "gemini-3.1-flash-lite";
}

export function getSecondaryGeminiModel(): string {
  return process.env.GEMINI_WRITER_SECONDARY_MODEL || "gemini-3.1-pro-preview";
}

// Per-tier thinking. Gemini 3.1 Pro cannot disable thinking; its floor is LOW.
// Gemini 3.5 Flash supports MINIMAL (near-zero thinking), which is the cheapest
// setting for a drafting task that the critic and rewrite loop repair anyway.
// Primary defaults to MINIMAL, secondary to LOW. GEMINI_WRITER_THINKING, when
// set, overrides both for backward compatibility.
function normalizeThinking(v: string | undefined, fallback: ThinkingLevel): ThinkingLevel {
  const u = (v || "").toUpperCase();
  if (u === "MINIMAL" || u === "LOW" || u === "MEDIUM" || u === "HIGH") return u;
  return fallback;
}

function thinkingForTier(tier: WriterTier): ThinkingLevel {
  const shared = process.env.GEMINI_WRITER_THINKING;
  if (tier === "gemini_primary") {
    return normalizeThinking(process.env.GEMINI_WRITER_PRIMARY_THINKING ?? shared, "MINIMAL");
  }
  return normalizeThinking(process.env.GEMINI_WRITER_SECONDARY_THINKING ?? shared, "LOW");
}

// Structured-output schema for the writer. Constrains Gemini to a clean
// {subject, body} object so it cannot emit malformed JSON, which removes the
// occasional Gemini Pro parse failure observed in production drafts.
const WRITER_JSON_SCHEMA: Record<string, unknown> = {
  type: "OBJECT",
  properties: {
    subject: { type: "STRING" },
    body: { type: "STRING" },
  },
  required: ["subject", "body"],
  propertyOrdering: ["subject", "body"],
};

/**
 * Whether the Gemini Pro secondary tier sits in the default chain. Pro cannot
 * run below LOW thinking, so its output token count swings widely and it averages
 * more expensive than Sonnet. It is therefore off by default: the ordinary chain
 * is Flash then Sonnet. Set WRITER_GEMINI_SECONDARY=on to insert Pro between them
 * when you want extra Gemini capacity before paying Anthropic.
 */
export function isSecondaryEnabled(): boolean {
  const v = (process.env.WRITER_GEMINI_SECONDARY || "").trim().toLowerCase();
  return v === "on" || v === "1" || v === "true" || v === "yes";
}

/**
 * Pure planner: produce the ordered list of tiers to try for a draft.
 *
 * Sonnet ("anthropic") is always the final element so the chain can never fail
 * to produce a writer. Grey-area drafts, the anthropic escape hatch, and a
 * missing GEMINI_API_KEY all collapse the chain to ["anthropic"]. The Gemini Pro
 * secondary tier is inserted only when secondaryEnabled is true. Kept pure and
 * argument-driven so it is hermetically testable.
 */
export function planWriterChain(opts: {
  provider: WriterProviderName;
  greyArea: boolean;
  geminiConfigured: boolean;
  secondaryEnabled?: boolean;
}): WriterTier[] {
  if (opts.provider === "anthropic" || opts.greyArea || !opts.geminiConfigured) {
    return ["anthropic"];
  }
  return opts.secondaryEnabled
    ? ["gemini_primary", "gemini_secondary", "anthropic"]
    : ["gemini_primary", "anthropic"];
}

// Module-level breakers, one per Gemini writer tier. State is shared across the
// long-running api-server process. Same thresholds as the critic breaker.
const primaryBreaker = createCircuitBreaker({ failureThreshold: 3, cooldownMs: 60_000 });
const secondaryBreaker = createCircuitBreaker({ failureThreshold: 3, cooldownMs: 60_000 });

// Extract the first complete, brace-balanced JSON object from a string, honoring
// string literals and escapes so a brace inside a value does not end it early.
// Gemini Pro occasionally appends a second object or trailing notes after the
// JSON; slicing to the last brace would capture that trailing content and fail
// to parse. Returns null when no balanced object is present.
function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') {
      inStr = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// Tolerant JSON extraction for the Gemini writer output. responseMimeType
// application/json normally yields a bare object; the fence-strip, first-object
// extraction, and regex fallback are belt-and-suspenders. A failure throws and
// the chain advances to the next tier, so a malformed Gemini response degrades to
// Sonnet by default, or to Pro and then Sonnet when the secondary tier is enabled.
function parseSubjectBody(text: string): GeneratedDraft {
  const cleaned = text.replace(/```json\s*|```/g, "").trim();
  const candidate = extractFirstJsonObject(cleaned) ?? cleaned;
  let parsed: { subject?: unknown; body?: unknown };
  try {
    parsed = JSON.parse(candidate);
  } catch {
    const subjectMatch = candidate.match(/"subject"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    const bodyMatch = candidate.match(/"body"\s*:\s*"((?:[^"\\]|\\[\s\S])*)"\s*\}\s*$/s);
    if (subjectMatch && bodyMatch) {
      parsed = {
        subject: unescapeJsonString(subjectMatch[1]),
        body: unescapeJsonString(bodyMatch[1]),
      };
    } else {
      throw new SyntaxError(`Gemini writer JSON parse failed: ${candidate.slice(0, 200)}`);
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
  const chain = planWriterChain({
    provider,
    greyArea: args.greyArea,
    geminiConfigured,
    secondaryEnabled: isSecondaryEnabled(),
  });

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
        thinkingLevel: thinkingForTier(tier),
        responseSchema: WRITER_JSON_SCHEMA,
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
