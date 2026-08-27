/**
 * llmRouter.ts — one call site for every LLM request in the product.
 *
 * Give it a ROLE and a prompt; it walks that role's waterfall from
 * lib/modelPolicy.ts, calls the right vendor transport, records the usage on
 * the shared ledger, and returns the first tier that answers.
 *
 * WHAT A TIER FAILURE MEANS
 *
 * "Unavailable" is any throw out of the transport after its own bounded
 * retries: a capacity wall (429 RESOURCE_EXHAUSTED / quota), an overload
 * (503 UNAVAILABLE), a timeout, a network fault, a safety block, or an empty
 * completion. All of them mean the same thing to the router — this tier cannot
 * serve this call right now — so all of them advance the waterfall. There is no
 * parallel or shadow execution; exactly one tier produces each result.
 *
 * The one throw that does NOT advance the chain is GenerationDeadlineError.
 * A spent row budget is not the tier's fault: advancing would burn the next
 * tier's latency on a row the pass has already abandoned, and the breaker would
 * score the timeout against a vendor that never faulted, pushing later rows off
 * a healthy tier for no reason. It is rethrown untouched.
 *
 * CIRCUIT BREAKERS, PER MODEL
 *
 * Each model string gets its own breaker. After a short run of consecutive
 * failures that model is skipped for a cooldown, so a sustained outage costs
 * one probe per cooldown instead of the full retry ladder on every single call.
 * Keyed by model rather than by tier or role so that a model shared across
 * roles — Flash-Lite writes drafts, summaries and ack-confirms — is discovered
 * to be down once, by whichever role hits it first, and every other role skips
 * it immediately.
 *
 * PARSING HAPPENS INSIDE THE TIER LOOP
 *
 * `runLlmJson` (and the `runLlmDraft` convenience over it) parses and validates
 * each tier's answer BEFORE accepting it, and treats an off-contract answer —
 * unparseable text, or valid JSON that fails the caller's `validate` — as a
 * TIER failure: the model's breaker is nudged and the waterfall advances. This
 * is the property that lets the cheap tiers stay cheap: a model that
 * occasionally loses the output contract costs a fallback, not a dropped
 * follow-up. `runLlm` is the raw-text escape hatch and does no parsing.
 */
import { logger } from "./logger";
import { GenerationDeadlineError } from "./generationDeadline";
import { createCircuitBreaker, type CircuitBreaker } from "./circuitBreaker";
import {
  geminiGenerateJson as realGeminiGenerateJson,
  isGeminiConfigured as realIsGeminiConfigured,
} from "./gemini";
import {
  openaiGenerateJson as realOpenaiGenerateJson,
  isOpenAiConfigured as realIsOpenAiConfigured,
} from "./openai";
import {
  getChain,
  describeChain,
  type LlmRole,
  type ModelTier,
  type LlmProviderName,
} from "./modelPolicy";
import {
  recordLlmUsageBestEffort,
  recordLlmAuxUsageBestEffort,
  type GeneratorLabel,
} from "./usageTracker";

/**
 * Provider-neutral token counts, already normalized so the pricing table can
 * bill them without knowing which vendor produced them.
 *
 *   inputTokens  — prompt tokens the vendor charged at the full input rate
 *                  (cached tokens subtracted out, so nothing is double-billed)
 *   outputTokens — visible completion PLUS hidden reasoning/thinking tokens,
 *                  which both vendors bill at the output rate. Counting only
 *                  the visible answer understates a reasoning model's cost by
 *                  several multiples, which is precisely the trap that makes
 *                  gpt-5-nano look cheaper than it is.
 *   cachedInputTokens — prompt tokens served from the vendor's cache, billed
 *                  at the discounted read rate.
 */
export interface NormalizedUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

/**
 * A JSON output contract, expressed once and translated per vendor.
 *
 * Deliberately a flat object of scalar properties: that is the intersection of
 * what Gemini's responseSchema and OpenAI's strict json_schema both accept
 * without caveat, and it covers every structured call the product makes
 * ({subject, body}, {summary, language}, {class, confidence, reason},
 * {answer}). Roles whose output is genuinely open-shaped — the critic, whose
 * `scores` is an open map that OpenAI strict mode cannot express — pass no
 * schema and rely on the prompt contract plus tolerant parsing, exactly as
 * before.
 */
export interface LlmJsonSchema {
  /** Cosmetic name for OpenAI's json_schema block. */
  name: string;
  properties: Record<string, "string" | "number" | "boolean">;
  /** Property order hint for Gemini; also the required set for both vendors. */
  required: string[];
}

function toGeminiSchema(schema: LlmJsonSchema): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const [key, type] of Object.entries(schema.properties)) {
    props[key] = { type: type === "string" ? "STRING" : type === "number" ? "NUMBER" : "BOOLEAN" };
  }
  return {
    type: "OBJECT",
    properties: props,
    required: schema.required,
    propertyOrdering: schema.required,
  };
}

function toOpenAiSchema(schema: LlmJsonSchema): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const [key, type] of Object.entries(schema.properties)) {
    props[key] = { type };
  }
  return {
    type: "object",
    properties: props,
    // OpenAI strict mode requires EVERY property to appear in `required` and
    // additionalProperties to be false. Listing Object.keys rather than
    // schema.required is not a bug: strict mode has no notion of an optional
    // property, so the two sets must coincide.
    required: Object.keys(schema.properties),
    additionalProperties: false,
  };
}

export interface LlmResult {
  text: string;
  /** The concrete model that answered. */
  model: string;
  provider: LlmProviderName;
  /** 1-based index of the tier that served, for logs and tests. */
  tierIndex: number;
  usage: NormalizedUsage;
}

/** Where this call's cost should land on the followup_usage ledger. */
export type UsageSink =
  | { kind: "pipeline"; label: GeneratorLabel }
  | { kind: "aux"; app: string; label: string }
  | { kind: "none" };

export interface RunLlmArgs {
  role: LlmRole;
  /** System instruction parts, in order (untrusted clause first, then the role prompt). */
  systemParts: string[];
  /** The single user turn. */
  user: string;
  maxOutputTokens?: number;
  schema?: LlmJsonSchema;
  usage?: UsageSink;
  /** For logs only. */
  prospectName?: string;
}

// ---------------------------------------------------------------------------
// Per-model breakers.
// ---------------------------------------------------------------------------

const BREAKER_FAILURE_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 60_000;

const breakers = new Map<string, CircuitBreaker>();

export function breakerFor(model: string): CircuitBreaker {
  let b = breakers.get(model);
  if (!b) {
    b = createCircuitBreaker({
      failureThreshold: BREAKER_FAILURE_THRESHOLD,
      cooldownMs: BREAKER_COOLDOWN_MS,
    });
    breakers.set(model, b);
  }
  return b;
}

/** Test seam: forget every breaker's state. */
export function __resetBreakersForTests(): void {
  breakers.clear();
}

// ---------------------------------------------------------------------------
// Diagnostics observer.
// ---------------------------------------------------------------------------

/**
 * What one served LLM call looked like, for offline measurement.
 *
 * The usage SINK writes to the followup_usage ledger and needs a usage context;
 * benches deliberately run without one so they never pollute production spend
 * reporting or the daily budget cap. That left no way to measure what a full
 * `generateFollowupEmail()` actually costs — which matters, because the writer
 * harness does not run the LLM critic and so understates the real bill.
 *
 * This observer fills that gap: an opt-in, module-level callback fired after
 * each tier that successfully SERVES (not merely bills — see the note in
 * walkChain). Unset by default, so production pays nothing for it.
 */
export interface LlmCallObservation {
  role: LlmRole;
  model: string;
  provider: LlmProviderName;
  tierIndex: number;
  usage: NormalizedUsage;
}

let observer: ((o: LlmCallObservation) => void) | null = null;

/**
 * Attach (or clear, with null) a diagnostics observer. Offline measurement
 * only — nothing in the production path sets this.
 */
export function setLlmCallObserver(fn: ((o: LlmCallObservation) => void) | null): void {
  observer = fn;
}

// ---------------------------------------------------------------------------
// Failure classification (logs only — every failure advances the chain).
// ---------------------------------------------------------------------------

/**
 * Label a tier failure as a capacity wall vs a generic error. Purely for the
 * log line Michael reads when a batch shifts off its usual tier; the routing
 * decision is identical either way.
 */
export function classifyFailure(err: unknown): "capacity" | "safety" | "error" {
  const m = String((err as { message?: string })?.message ?? err).toLowerCase();
  if (m.includes("blocked") || m.includes("safety") || m.includes("content_filter")) {
    return "safety";
  }
  // Match the STATUS, not a bare number: both transports format their errors as
  // "Gemini HTTP 503: ..." / "OpenAI HTTP 429: ...", and those errors carry a
  // 300-character body preview that can easily contain a stray "500" (a token
  // count, a model name, a quota figure). Labelling that as a capacity wall
  // would make the log lie about why a batch shifted tiers.
  if (/\bhttp (408|409|429|5\d\d)\b/.test(m)) return "capacity";
  if (
    m.includes("resource_exhausted") ||
    m.includes("unavailable") ||
    m.includes("overloaded") ||
    m.includes("quota") ||
    m.includes("rate limit") ||
    m.includes("insufficient_quota") ||
    m.includes("timeout") ||
    m.includes("aborted")
  ) {
    return "capacity";
  }
  return "error";
}

// ---------------------------------------------------------------------------
// Injectable dependencies, so the waterfall is testable without a network.
// ---------------------------------------------------------------------------

export interface RouterDeps {
  geminiGenerateJson: typeof realGeminiGenerateJson;
  openaiGenerateJson: typeof realOpenaiGenerateJson;
  isGeminiConfigured: typeof realIsGeminiConfigured;
  isOpenAiConfigured: typeof realIsOpenAiConfigured;
  recordUsage: typeof recordLlmUsageBestEffort;
  recordAuxUsage: typeof recordLlmAuxUsageBestEffort;
  breakerFor: typeof breakerFor;
  logger: Pick<typeof logger, "info" | "warn" | "error">;
}

const defaultDeps: RouterDeps = {
  geminiGenerateJson: realGeminiGenerateJson,
  openaiGenerateJson: realOpenaiGenerateJson,
  isGeminiConfigured: realIsGeminiConfigured,
  isOpenAiConfigured: realIsOpenAiConfigured,
  recordUsage: recordLlmUsageBestEffort,
  recordAuxUsage: recordLlmAuxUsageBestEffort,
  breakerFor,
  logger,
};

/**
 * Thrown when every tier in a role's chain was unavailable. Carries the
 * per-tier causes so the log says which models were tried and why each one
 * declined, rather than only surfacing the last error.
 */
export class AllTiersFailedError extends Error {
  readonly role: LlmRole;
  readonly attempts: Array<{ model: string; provider: LlmProviderName; cause: string }>;
  constructor(
    role: LlmRole,
    attempts: Array<{ model: string; provider: LlmProviderName; cause: string }>,
  ) {
    const detail = attempts.map((a) => `${a.provider}:${a.model} (${a.cause})`).join("; ");
    super(`Every model tier failed for role "${role}": ${detail || "no tier was eligible"}`);
    this.name = "AllTiersFailedError";
    this.role = role;
    this.attempts = attempts;
  }
}

function normalizeGeminiUsage(u: {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  cachedContentTokenCount?: number;
}): NormalizedUsage {
  const prompt = u.promptTokenCount ?? 0;
  const cached = u.cachedContentTokenCount ?? 0;
  return {
    inputTokens: Math.max(0, prompt - cached),
    // thoughtsTokenCount is Gemini's thinking budget and bills as output.
    outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
    cachedInputTokens: cached,
  };
}

function normalizeOpenAiUsage(u: {
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  cachedPromptTokens?: number;
}): NormalizedUsage {
  const prompt = u.promptTokens ?? 0;
  const cached = u.cachedPromptTokens ?? 0;
  // completion_tokens ALREADY includes reasoning_tokens in the OpenAI usage
  // block (verified against live responses: completion 94 = visible 21 +
  // reasoning 73). Adding them again would double-count the dearest half of a
  // reasoning model's bill, so reasoningTokens is carried for logging only.
  return {
    inputTokens: Math.max(0, prompt - cached),
    outputTokens: u.completionTokens ?? 0,
    cachedInputTokens: cached,
  };
}

function providerConfigured(tier: ModelTier, deps: RouterDeps): boolean {
  return tier.provider === "gemini" ? deps.isGeminiConfigured() : deps.isOpenAiConfigured();
}

/**
 * The one chain walk. Everything public is a thin wrapper over this.
 *
 * `parse` runs INSIDE the tier loop, which is the whole point: a model that
 * answers 200 OK with text that is not the agreed shape has not served the
 * call, and the correct response is the next tier — not an exception the caller
 * has to turn into a degraded result. Usage is recorded BEFORE the parse,
 * because an unusable answer was still billed.
 *
 * Throws AllTiersFailedError when no tier could serve, and rethrows
 * GenerationDeadlineError untouched.
 */
async function walkChain<T>(
  args: RunLlmArgs,
  parse: (text: string, result: LlmResult) => T,
  depsOverride?: Partial<RouterDeps>,
): Promise<{ value: T; result: LlmResult }> {
  const deps: RouterDeps = { ...defaultDeps, ...depsOverride };
  const chain = getChain(args.role);
  const attempts: Array<{ model: string; provider: LlmProviderName; cause: string }> = [];

  for (let i = 0; i < chain.length; i++) {
    const tier = chain[i];
    const tierIndex = i + 1;
    const nextTier = chain[i + 1]
      ? `${chain[i + 1].provider}:${chain[i + 1].model}`
      : "(none — chain exhausted)";

    if (!providerConfigured(tier, deps)) {
      const cause = `${tier.provider === "gemini" ? "GEMINI_API_KEY" : "OPENAI_API_KEY"} not set`;
      attempts.push({ model: tier.model, provider: tier.provider, cause });
      continue;
    }

    const breaker = deps.breakerFor(tier.model);
    if (!breaker.shouldAttempt()) {
      deps.logger.info(
        { role: args.role, tier: tierIndex, model: tier.model, breaker: breaker.state() },
        "LLM tier breaker open — skipping to the next tier",
      );
      attempts.push({ model: tier.model, provider: tier.provider, cause: "breaker open" });
      continue;
    }

    let result: LlmResult;
    try {
      result = await callTier(tier, tierIndex, args, deps);
    } catch (err) {
      // F-3.7b: a spent row budget is not this tier's failure. See the header.
      if (err instanceof GenerationDeadlineError) throw err;
      breaker.onFailure();
      const cause = classifyFailure(err);
      attempts.push({
        model: tier.model,
        provider: tier.provider,
        cause: `${cause}: ${String(err).slice(0, 160)}`,
      });
      deps.logger.warn(
        {
          err: String(err),
          role: args.role,
          prospect: args.prospectName,
          tier: tierIndex,
          model: tier.model,
          provider: tier.provider,
          cause,
          breaker: breaker.state(),
          nextTier,
        },
        `LLM tier unavailable (${cause}) — advancing the waterfall`,
      );
      continue;
    }

    // Billed, so record it — even if the parse below rejects the answer.
    recordUsage(deps, args, result.model, result.usage);
    // Same rule for the diagnostics observer: it measures what was BILLED, so
    // a bench's cost figure includes tiers that answered off-contract and were
    // fallen past. Anything else would flatter the chain.
    if (observer) {
      observer({
        role: args.role,
        model: result.model,
        provider: result.provider,
        tierIndex: result.tierIndex,
        usage: result.usage,
      });
    }

    let value: T;
    try {
      value = parse(result.text, result);
    } catch (err) {
      breaker.onFailure();
      attempts.push({
        model: tier.model,
        provider: tier.provider,
        cause: `contract: ${String(err).slice(0, 160)}`,
      });
      deps.logger.warn(
        {
          err: String(err),
          role: args.role,
          prospect: args.prospectName,
          tier: tierIndex,
          model: tier.model,
          preview: result.text.slice(0, 200),
          breaker: breaker.state(),
          nextTier,
        },
        "LLM tier answered off-contract (unparseable or invalid) — advancing the waterfall",
      );
      continue;
    }

    breaker.onSuccess();

    if (tierIndex > 1) {
      // Only log the routing decision when it was NOT the ordinary path — an
      // info line on every single call would drown the one that matters.
      deps.logger.info(
        {
          role: args.role,
          prospect: args.prospectName,
          tier: tierIndex,
          model: result.model,
          provider: result.provider,
          chain: describeChain(chain),
          skipped: attempts.map((a) => `${a.model} (${a.cause})`),
        },
        "LLM served by a fallback tier",
      );
    }

    return { value, result };
  }

  deps.logger.error(
    { role: args.role, prospect: args.prospectName, chain: describeChain(chain), attempts },
    "Every LLM tier failed for this role",
  );
  throw new AllTiersFailedError(args.role, attempts);
}

/** One vendor call. Knows the two transports and nothing else. */
async function callTier(
  tier: ModelTier,
  tierIndex: number,
  args: RunLlmArgs,
  deps: RouterDeps,
): Promise<LlmResult> {
  if (tier.provider === "gemini") {
    const res = await deps.geminiGenerateJson({
      systemParts: args.systemParts,
      user: args.user,
      model: tier.model,
      maxOutputTokens: args.maxOutputTokens ?? 8192,
      thinkingLevel: tier.thinking,
      responseSchema: args.schema ? toGeminiSchema(args.schema) : undefined,
    });
    return {
      text: res.text,
      model: res.model || tier.model,
      provider: "gemini",
      tierIndex,
      usage: normalizeGeminiUsage(res.usage),
    };
  }
  const res = await deps.openaiGenerateJson({
    systemParts: args.systemParts,
    user: args.user,
    model: tier.model,
    maxOutputTokens: args.maxOutputTokens ?? 8192,
    reasoningEffort: tier.effort,
    responseSchema: args.schema ? toOpenAiSchema(args.schema) : undefined,
    schemaName: args.schema?.name,
  });
  return {
    text: res.text,
    model: res.model || tier.model,
    provider: "openai",
    tierIndex,
    usage: normalizeOpenAiUsage(res.usage),
  };
}

function recordUsage(
  deps: RouterDeps,
  args: RunLlmArgs,
  model: string,
  usage: NormalizedUsage,
): void {
  const sink = args.usage ?? { kind: "none" as const };
  if (sink.kind === "pipeline") {
    void deps.recordUsage(usage, model, sink.label);
  } else if (sink.kind === "aux") {
    void deps.recordAuxUsage(usage, model, sink.app, sink.label);
  }
}

/**
 * Run one call through a role's waterfall and return the raw text.
 *
 * Use this only when the answer has no machine-checkable contract — today that
 * is nothing, but it keeps the raw path available. Prefer runLlmJson, which
 * turns an off-contract answer into a fallback instead of a caller's problem.
 */
export async function runLlm(
  args: RunLlmArgs,
  depsOverride?: Partial<RouterDeps>,
): Promise<LlmResult> {
  const { result } = await walkChain(args, (text) => text, depsOverride);
  return result;
}

// ---------------------------------------------------------------------------
// Tolerant JSON parsing, shared by every structured caller.
// ---------------------------------------------------------------------------

/**
 * Extract the first complete, brace-balanced JSON object from a string,
 * honoring string literals and escapes so a brace inside a value does not end
 * it early. Some models append a second object or a trailing note after the
 * JSON; slicing to the LAST brace would swallow that and fail to parse.
 * Returns null when no balanced object is present.
 */
export function extractFirstJsonObject(text: string): string | null {
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

/** Strip code fences, then parse the first balanced object. Throws on failure. */
export function parseLlmJson<T = Record<string, unknown>>(text: string): T {
  const cleaned = text.replace(/```json\s*|```/g, "").trim();
  const candidate = extractFirstJsonObject(cleaned) ?? cleaned;
  return JSON.parse(candidate) as T;
}

/**
 * Run a role's waterfall, parse the answer as JSON, and optionally validate it.
 *
 * A parse failure or a `validate` throw is treated as a TIER failure: the model
 * is marked failed, its breaker is nudged, and the chain advances. This is the
 * property that lets the cheap tiers stay cheap — a model that occasionally
 * loses the output contract costs a fallback, not a dropped follow-up.
 *
 * `validate` should throw (any error) to reject, and return the typed value to
 * accept.
 */
export async function runLlmJson<T = Record<string, unknown>>(
  args: RunLlmArgs & { validate?: (parsed: unknown) => T },
  depsOverride?: Partial<RouterDeps>,
): Promise<{ value: T; result: LlmResult }> {
  return walkChain<T>(
    args,
    (text) => {
      const parsed = parseLlmJson(text);
      return args.validate ? args.validate(parsed) : (parsed as T);
    },
    depsOverride,
  );
}

/**
 * Run a role's waterfall for a {subject, body} email draft.
 *
 * The single most common structured call in the product (draft and rewrite, in
 * all three flows), so the schema and the contract check live here once rather
 * than in six call sites.
 */
export const SUBJECT_BODY_SCHEMA: LlmJsonSchema = {
  name: "email_draft",
  properties: { subject: "string", body: "string" },
  required: ["subject", "body"],
};

export interface SubjectBody {
  subject: string;
  body: string;
}

export async function runLlmDraft(
  args: Omit<RunLlmArgs, "schema">,
  depsOverride?: Partial<RouterDeps>,
): Promise<{ value: SubjectBody; result: LlmResult }> {
  return runLlmJson<SubjectBody>(
    {
      ...args,
      schema: SUBJECT_BODY_SCHEMA,
      validate: (parsed) => {
        const p = parsed as { subject?: unknown; body?: unknown };
        const subject = typeof p.subject === "string" ? p.subject.trim() : "";
        const body = typeof p.body === "string" ? p.body.trim() : "";
        if (!subject || !body) {
          throw new Error("draft is missing subject or body");
        }
        return { subject, body };
      },
    },
    depsOverride,
  );
}
