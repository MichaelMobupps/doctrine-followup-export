/**
 * Real comparison smoke test for the follow-up writer models.
 *
 * On-demand diagnostic, not part of the auto-run suite, because it makes live
 * billed calls and needs GEMINI_API_KEY plus the configured Anthropic client. It
 * lives under src/scripts/ so `node --test src/tests/*.ts` never picks it up.
 *
 * Default mode is "compare": for every cell in the matrix it generates a draft
 * with EACH of the three writer models on the same prompt, so you can read the
 * Gemini 3.5 Flash, Gemini 3.1 Pro, and Sonnet 4.6 output side by side and judge
 * quality directly. Every model receives the identical system prompt, untrusted
 * clause, and exemplar block, so the comparison is fair.
 *
 * The production chain stops at the first model that succeeds, so a normal run
 * would only ever show Flash for an ordinary vertical. This test calls every
 * model explicitly so all three actually produce an email. The log also records
 * which model production would route to (Flash for an ordinary vertical, Sonnet
 * for a grey-area vertical), so the comparison and the routing are both visible.
 *
 * Modes:
 *   --mode compare   (default) every model generates every cell, real calls.
 *   --mode chain     drive the real runWriter chain, one served model per cell.
 *   --self-test      offline, deterministic fake output, no provider call.
 *
 * Scope flags:
 *   --preset quick|full|stress  matrix size. stress is a short, curated set of
 *                               the cells where Gemini Pro JSON failures appeared
 *                               (non-Latin and right-to-left scripts on cps and
 *                               retargeting), for confirming the schema fix fast.
 *   --only flash,pro,sonnet     restrict to specific models. Example: --only pro
 *                               runs Gemini Pro alone.
 *
 * Outputs:
 *   smoke-writer-<timestamp>.log   readable per-cell, per-model report.
 *   emails-<timestamp>.md          archive of every generated email.
 *   emails.md                      the latest run, for convenience.
 *
 * Cost and time safety (agent-hardening defaults):
 *   The run stops launching new work once spend reaches --max-usd or once
 *   --max-cells cells have run. Concurrency over cells is bounded by
 *   --concurrency. Usage is captured locally for the report and is NOT written
 *   to the followup_usage ledger, so a smoke run never affects production billing.
 *
 * Run from artifacts/api-server, where the Anthropic client and GEMINI_API_KEY
 * are configured:
 *   node --import tsx src/scripts/smoke-writer.ts
 *   node --import tsx src/scripts/smoke-writer.ts --preset full --max-usd 20 --max-cells 120
 *
 * Exit codes: 0 every model call succeeded and the matrix completed; 1 a real
 * failure (a non-capacity error, or a lint gate set above zero that failed);
 * 2 incomplete because a cap stopped the run, or because some calls were blocked
 * by transient provider capacity or overload, with no hard failures.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { anthropic, MODEL_DRAFT_GENERATOR, cachedSystem } from "../lib/anthropic";
import { withAnthropicRetry } from "../services/anthropicRetry";
import {
  getFollowupSystemPrompt,
  getFollowupUserPrompt,
  type FollowupContext,
} from "../services/followupPrompts";
import { UNTRUSTED_DATA_SYSTEM_CLAUSE } from "../lib/promptInjection";
import {
  planWriterChain,
  getWriterProvider,
  getPrimaryGeminiModel,
  getSecondaryGeminiModel,
  isSecondaryEnabled,
  type WriterTier,
} from "../services/writerProvider";
import { isGreyArea, detectGreyArea } from "../lib/greyArea";
import { buildWriterExemplarBlock } from "../lib/exemplarLibrary";
import {
  geminiGenerateJson,
  isGeminiConfigured,
  type GeminiUsageMetadata,
  type ThinkingLevel,
} from "../lib/gemini";
import { computeCostUsd, MODEL_PRICES } from "../lib/pricing";
import { detectAllDeterministicViolations } from "../lib/doctrineLint";
import { detectStructuralViolations, mergeViolationReports } from "../lib/structuralLint";

// ===========================================================================
// CLI
// ===========================================================================

type Mode = "compare" | "chain";

interface Options {
  preset: "quick" | "full" | "stress";
  mode: Mode;
  only: WriterTier[];
  maxUsd: number;
  maxCells: number;
  concurrency: number;
  lintMinRate: number;
  outDir: string;
  selfTest: boolean;
}

const ALL_TIERS: WriterTier[] = ["gemini_primary", "gemini_secondary", "anthropic"];

function parseOnly(spec: string): WriterTier[] {
  const map: Record<string, WriterTier> = {
    flash: "gemini_primary",
    primary: "gemini_primary",
    gemini_primary: "gemini_primary",
    pro: "gemini_secondary",
    secondary: "gemini_secondary",
    gemini_secondary: "gemini_secondary",
    sonnet: "anthropic",
    anthropic: "anthropic",
  };
  const picked = spec
    .split(",")
    .map((s) => map[s.trim().toLowerCase()])
    .filter((t): t is WriterTier => Boolean(t));
  // Preserve canonical order and dedupe.
  return ALL_TIERS.filter((t) => picked.includes(t));
}

function parseArgs(argv: string[]): Options {
  const o: Options = {
    preset: "quick",
    mode: "compare",
    only: ALL_TIERS,
    maxUsd: 0, // set per preset below
    maxCells: 0, // 0 means no cap
    concurrency: 3,
    lintMinRate: 0,
    outDir: process.cwd(),
    selfTest: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--preset") {
      const p = next();
      o.preset = p === "full" ? "full" : p === "stress" ? "stress" : "quick";
    } else if (a === "--mode") o.mode = next() === "chain" ? "chain" : "compare";
    else if (a === "--only") {
      const picked = parseOnly(next() || "");
      if (picked.length > 0) o.only = picked;
    } else if (a === "--max-usd") o.maxUsd = Number(next());
    else if (a === "--max-cells") o.maxCells = Math.max(0, Math.floor(Number(next())));
    else if (a === "--concurrency") o.concurrency = Math.max(1, Math.floor(Number(next())));
    else if (a === "--lint-min-rate") o.lintMinRate = Math.max(0, Math.min(1, Number(next())));
    else if (a === "--out") o.outDir = next();
    else if (a === "--self-test") o.selfTest = true;
  }
  // Preset-aware cost and cell defaults that the user did not override.
  if (o.maxUsd === 0) o.maxUsd = o.preset === "full" ? 20.0 : 4.0;
  if (o.maxCells === 0 && o.preset === "full") o.maxCells = 120;
  return o;
}

// ===========================================================================
// Matrix definition
// ===========================================================================

const LANGS_QUICK = ["en", "es", "de", "ja"];
const LANGS_FULL = [
  "en", "es", "de", "ja", "fr", "it", "pt", "ru", "uk", "zh",
  "ko", "ar", "he", "hi", "th", "tr", "pl", "nl", "vi",
];

const VERTICALS_QUICK = ["gaming_ua", "non_gaming_ua", "cps", "retargeting"];
const VERTICALS_FULL = [
  "gaming_ua", "non_gaming_ua", "cps", "retargeting",
  "cps_ecommerce", "cps_fintech", "cps_subscription",
];

const STAGES_QUICK = [2, 3];
const STAGES_FULL = [2, 3, 4];

const GREY_VERTICALS = ["casino", "sports_betting", "crypto", "forex"];

type CellKind = "matrix" | "grey" | "neutral";

interface Cell {
  index: number;
  kind: CellKind;
  lang: string;
  vertical: string;
  stage: number;
  ctx: FollowupContext;
}

interface Seed {
  company: string;
  product: string;
  subject: string;
  summary: string;
  body: string;
  subVertical: string | null;
}

function seedFor(vertical: string): Seed {
  switch (vertical) {
    case "gaming_ua":
      return {
        company: "PixelForge Games",
        product: "performance user acquisition for mobile games",
        subject: "MobUpps UA for PixelForge Games",
        summary: "Intro to MobUpps performance UA for mobile games with semi-exclusive supply and fraud filtering.",
        body: "Hi Alex, I am reaching out from MobUpps about performance user acquisition for your mobile games. We run CPI and CPA campaigns on semi-exclusive supply with fraud filtering and durable post-install retention. Happy to share a small test plan.",
        subVertical: null,
      };
    case "non_gaming_ua":
      return {
        company: "Lumi Health App",
        product: "performance user acquisition for your app",
        subject: "MobUpps UA for Lumi Health App",
        summary: "Intro to MobUpps performance UA for a non-gaming app with fraud filtering and retention focus.",
        body: "Hi Alex, I am reaching out from MobUpps about performance user acquisition for Lumi Health App. We run CPI and CPA campaigns with fraud filtering and a focus on retained, active users. Happy to share a small test plan.",
        subVertical: null,
      };
    case "cps":
      return {
        company: "ShopNova",
        product: "CPS and revenue-share performance partnership",
        subject: "MobUpps CPS partnership for ShopNova",
        summary: "Intro to a CPS / revenue-share performance partnership with verified-sale tracking.",
        body: "Hi Alex, I am reaching out from MobUpps about a CPS partnership for ShopNova. We work on a revenue-share basis with verified-sale tracking and fraud filtering, so you pay against confirmed outcomes. Happy to share a short proposal.",
        subVertical: null,
      };
    case "retargeting":
      return {
        company: "Wanderly Travel",
        product: "retargeting and re-engagement campaigns",
        subject: "MobUpps retargeting for Wanderly Travel",
        summary: "Intro to retargeting and re-engagement campaigns for lapsed and dormant users.",
        body: "Hi Alex, I am reaching out from MobUpps about retargeting for Wanderly Travel. We re-engage lapsed and dormant users across owned audiences with measured incremental lift. Happy to share a short plan.",
        subVertical: null,
      };
    case "cps_ecommerce":
      return {
        company: "ShopNova",
        product: "CPS partnership for e-commerce",
        subject: "MobUpps CPS for ShopNova store",
        summary: "Intro to a CPS / revenue-share partnership for an e-commerce store with verified-sale tracking.",
        body: "Hi Alex, I am reaching out from MobUpps about a CPS partnership for the ShopNova store. We work on revenue share with verified-sale tracking, so you pay against confirmed purchases. Happy to share a short proposal.",
        subVertical: "cps_ecommerce",
      };
    case "cps_fintech":
      return {
        company: "PayLane",
        product: "CPS partnership for a fintech app",
        subject: "MobUpps CPS for PayLane",
        summary: "Intro to a CPS / cost-per-action partnership for a fintech app with verified-funded-account tracking.",
        body: "Hi Alex, I am reaching out from MobUpps about a CPS partnership for PayLane. We work on a cost-per-action basis tied to verified funded accounts, with fraud filtering. Happy to share a short proposal.",
        subVertical: "cps_fintech",
      };
    case "cps_subscription":
      return {
        company: "StreamWell",
        product: "CPS partnership for a subscription service",
        subject: "MobUpps CPS for StreamWell",
        summary: "Intro to a CPS / revenue-share partnership for a subscription service with verified-paid-conversion tracking.",
        body: "Hi Alex, I am reaching out from MobUpps about a CPS partnership for StreamWell. We work on revenue share tied to verified paid conversions rather than trial starts. Happy to share a short proposal.",
        subVertical: "cps_subscription",
      };
    case "casino":
      return {
        company: "RoyalSpin Casino",
        product: "casino and sportsbook user acquisition",
        subject: "MobUpps UA for RoyalSpin Casino",
        summary: "Intro to performance user acquisition for an online casino and sportsbook brand.",
        body: "Hi Alex, I am reaching out from MobUpps about user acquisition for RoyalSpin Casino. We run compliant performance campaigns on vetted supply for regulated iGaming. Happy to share a short plan.",
        subVertical: null,
      };
    case "sports_betting":
      return {
        company: "GoalLine Bet",
        product: "sports betting user acquisition",
        subject: "MobUpps UA for GoalLine Bet",
        summary: "Intro to performance user acquisition for a sports betting brand.",
        body: "Hi Alex, I am reaching out from MobUpps about user acquisition for GoalLine Bet. We run compliant performance campaigns on vetted supply for regulated sports betting. Happy to share a short plan.",
        subVertical: null,
      };
    case "crypto":
      return {
        company: "CoinBridge",
        product: "crypto exchange user acquisition",
        subject: "MobUpps UA for CoinBridge",
        summary: "Intro to performance user acquisition for a crypto exchange.",
        body: "Hi Alex, I am reaching out from MobUpps about user acquisition for CoinBridge. We run compliant performance campaigns on vetted supply for regulated crypto products. Happy to share a short plan.",
        subVertical: null,
      };
    case "forex":
      return {
        company: "FXPrime",
        product: "forex broker user acquisition",
        subject: "MobUpps UA for FXPrime",
        summary: "Intro to performance user acquisition for a forex broker.",
        body: "Hi Alex, I am reaching out from MobUpps about user acquisition for FXPrime. We run compliant performance campaigns on vetted supply for regulated forex products. Happy to share a short plan.",
        subVertical: null,
      };
    default:
      return seedFor("non_gaming_ua");
  }
}

function buildCtx(lang: string, vertical: string, stage: number, opts?: { sharedCompanyDraft?: boolean }): FollowupContext {
  const seed = seedFor(vertical);
  return {
    prospect_name: "Alex",
    company: seed.company,
    vertical,
    sub_vertical: seed.subVertical,
    product: seed.product,
    original_subject: seed.subject,
    original_body_summary: seed.summary,
    original_body: seed.body,
    original_language: lang,
    stage,
    days_since_original: stage === 2 ? 4 : stage === 3 ? 9 : 14,
    sender_name: "Michael",
    shared_company_draft: opts?.sharedCompanyDraft ?? false,
  };
}

// Stress preset: the cells that produced wrong results on Gemini Pro, ordered
// so the most informative ones lead. The first three are the lint false
// positives this round fixes (German FOLLOWUP-ACK, Chinese and Hebrew
// greeting-name). Next is the JSON cell fixed last round, then neighbors in
// non-Latin and right-to-left scripts. Intentionally small for a Pro-only run.
// Run the first three with --max-cells 3 to confirm just the lint fixes.
const STRESS_CELLS: Array<[string, string, number]> = [
  ["de", "cps", 2],          // was FOLLOWUP-ACK false positive
  ["zh", "cps", 2],          // was UNTRANSLITERATED-GREETING-NAME false positive
  ["he", "retargeting", 2],  // was UNTRANSLITERATED-GREETING-NAME false positive
  ["ja", "cps", 2],          // was malformed JSON, now a clean baseline
  ["ja", "retargeting", 2],
  ["es", "retargeting", 3],
  ["ko", "retargeting", 2],
  ["ar", "cps", 2],
  ["ru", "cps", 2],
  ["th", "retargeting", 2],
];

function buildMatrix(preset: "quick" | "full" | "stress"): Cell[] {
  if (preset === "stress") {
    return STRESS_CELLS.map(([lang, vertical, stage], i) => ({
      index: i,
      kind: "matrix" as CellKind,
      lang,
      vertical,
      stage,
      ctx: buildCtx(lang, vertical, stage),
    }));
  }

  const langs = preset === "full" ? LANGS_FULL : LANGS_QUICK;
  const verticals = preset === "full" ? VERTICALS_FULL : VERTICALS_QUICK;
  const stages = preset === "full" ? STAGES_FULL : STAGES_QUICK;

  const cells: Cell[] = [];
  let idx = 0;
  for (const lang of langs)
    for (const vertical of verticals)
      for (const stage of stages)
        cells.push({ index: idx++, kind: "matrix", lang, vertical, stage, ctx: buildCtx(lang, vertical, stage) });

  const greyLangs = preset === "full" ? ["en", "de"] : ["en"];
  const greyVerts = preset === "full" ? GREY_VERTICALS : ["casino"];
  for (const lang of greyLangs)
    for (const v of greyVerts)
      cells.push({ index: idx++, kind: "grey", lang, vertical: v, stage: 2, ctx: buildCtx(lang, v, 2) });

  cells.push({
    index: idx++,
    kind: "neutral",
    lang: "en",
    vertical: "non_gaming_ua",
    stage: 2,
    ctx: buildCtx("en", "non_gaming_ua", 2, { sharedCompanyDraft: true }),
  });
  return cells;
}

// ===========================================================================
// Cost helpers
// ===========================================================================

interface Captured {
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

function geminiCaptured(usage: GeminiUsageMetadata, model: string): Captured {
  const prompt = usage.promptTokenCount ?? 0;
  const cached = usage.cachedContentTokenCount ?? 0;
  const inputTokens = Math.max(0, prompt - cached);
  const outputTokens = (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0);
  const costUsd = computeCostUsd(model, { inputTokens, outputTokens, cacheCreationTokens: 0, cacheReadTokens: cached });
  return { model, inputTokens, outputTokens, costUsd };
}

interface AnthropicUsageLike {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

function anthropicCaptured(usage: AnthropicUsageLike, model: string): Captured {
  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  const cacheCreationTokens = usage.cache_creation_input_tokens ?? 0;
  const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
  const costUsd = computeCostUsd(model, { inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens });
  return { model, inputTokens, outputTokens, costUsd };
}

// Extract the first complete, brace-balanced JSON object, honoring strings and
// escapes. Gemini Pro sometimes appends a second object or trailing notes; this
// takes the first object rather than slicing to the last brace.
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
    } else if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function parseDraft(text: string): { subject: string; body: string } {
  const cleaned = text.replace(/```json\s*|```/g, "").trim();
  const candidate = extractFirstJsonObject(cleaned) ?? cleaned;
  const parsed = JSON.parse(candidate) as { subject?: string; body?: string };
  return { subject: parsed.subject ?? "", body: parsed.body ?? "" };
}

// Per-tier thinking, mirroring writerProvider: Flash defaults to MINIMAL, Pro
// to LOW (its floor). GEMINI_WRITER_THINKING overrides both when set.
function normalizeThinking(v: string | undefined, fallback: ThinkingLevel): ThinkingLevel {
  const u = (v || "").toUpperCase();
  if (u === "MINIMAL" || u === "LOW" || u === "MEDIUM" || u === "HIGH") return u as ThinkingLevel;
  return fallback;
}

function thinkingForTier(tier: WriterTier): ThinkingLevel {
  const shared = process.env.GEMINI_WRITER_THINKING;
  if (tier === "gemini_primary") return normalizeThinking(process.env.GEMINI_WRITER_PRIMARY_THINKING ?? shared, "MINIMAL");
  return normalizeThinking(process.env.GEMINI_WRITER_SECONDARY_THINKING ?? shared, "LOW");
}

// Same structured-output schema the production writer uses.
const WRITER_JSON_SCHEMA: Record<string, unknown> = {
  type: "OBJECT",
  properties: {
    subject: { type: "STRING" },
    body: { type: "STRING" },
  },
  required: ["subject", "body"],
  propertyOrdering: ["subject", "body"],
};

function fakeBody(ctx: FollowupContext, label: string): string {
  const who = ctx.shared_company_draft ? "there" : ctx.prospect_name;
  return (
    `Hi ${who}, following up on my earlier note about ${ctx.product} for ${ctx.company}. ` +
    `I know inboxes get busy. If useful I can send a short test plan sized to one campaign. ` +
    `Would a brief look make sense on your side? [${label} fake output]`
  );
}

// ===========================================================================
// Per-model generation (real calls)
// ===========================================================================

const TIER_ORDER: WriterTier[] = ["gemini_primary", "gemini_secondary", "anthropic"];

function tierLabel(t: WriterTier): string {
  if (t === "gemini_primary") return "Gemini Flash";
  if (t === "gemini_secondary") return "Gemini Pro";
  return "Sonnet";
}

function modelForTier(t: WriterTier): string {
  if (t === "gemini_primary") return getPrimaryGeminiModel();
  if (t === "gemini_secondary") return getSecondaryGeminiModel();
  return MODEL_DRAFT_GENERATOR;
}

interface TierGen {
  subject: string;
  body: string;
  captured: Captured;
}

async function genGemini(tier: WriterTier, model: string, systemParts: string[], userPrompt: string): Promise<TierGen> {
  const res = await geminiGenerateJson({
    systemParts,
    user: userPrompt,
    maxOutputTokens: 8192,
    model,
    thinkingLevel: thinkingForTier(tier),
    responseSchema: WRITER_JSON_SCHEMA,
  });
  const draft = parseDraft(res.text);
  if (!draft.subject || !draft.body) throw new Error("Gemini output missing subject or body");
  return { subject: draft.subject, body: draft.body, captured: geminiCaptured(res.usage, res.model) };
}

async function genSonnet(userPrompt: string): Promise<TierGen> {
  const response = await withAnthropicRetry(
    () =>
      anthropic.messages.create({
        model: MODEL_DRAFT_GENERATOR,
        max_tokens: 8192,
        system: cachedSystem(UNTRUSTED_DATA_SYSTEM_CLAUSE, getFollowupSystemPrompt()),
        messages: [{ role: "user", content: userPrompt }],
      }),
    { label: "draft" },
  );
  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") throw new Error("No text in Sonnet draft response");
  const draft = parseDraft(textBlock.text);
  if (!draft.subject || !draft.body) throw new Error("Sonnet output missing subject or body");
  return {
    subject: draft.subject,
    body: draft.body,
    captured: anthropicCaptured(response.usage as AnthropicUsageLike, response.model || MODEL_DRAFT_GENERATOR),
  };
}

// ===========================================================================
// Cell execution
// ===========================================================================

interface TierOutput {
  tier: WriterTier;
  model: string;
  status: "OK" | "FAIL" | "BLOCK" | "SKIP";
  subject: string;
  body: string;
  captured: Captured | null;
  lintPass: boolean;
  lintIssues: string[];
  ms: number;
  error: string | null;
}

interface CellResult {
  cell: Cell;
  grey: boolean;
  greySignals: string[];
  plannedChain: WriterTier[];
  productionRoute: WriterTier;
  tiers: TierOutput[];
  hardFailReasons: string[];
}

function isOverload(msg: string): boolean {
  return /429|503|resource_exhausted|unavailable|overload|high demand|quota|rate limit/i.test(msg);
}

function lintBody(body: string, ctx: FollowupContext): { pass: boolean; issues: string[] } {
  const groundingSource = [ctx.original_subject, ctx.original_body, ctx.original_body_summary].join("\n");
  const report = mergeViolationReports(
    detectAllDeterministicViolations(body, ctx.original_language),
    detectStructuralViolations(body, { languageTag: ctx.original_language, originalText: groundingSource }),
  );
  return { pass: !report.found, issues: report.issues.slice(0, 4) };
}

interface RunHooks {
  // Returns true if the cost cap is already reached, so the caller stops.
  capReached(): boolean;
  addCost(usd: number): void;
}

async function runCellCompare(cell: Cell, selfTest: boolean, hooks: RunHooks, only: WriterTier[]): Promise<CellResult> {
  const ctx = cell.ctx;
  const grey = isGreyArea(ctx);
  const greySignals = detectGreyArea(ctx).signals;
  const exemplarBlock = buildWriterExemplarBlock(ctx);
  const base = getFollowupUserPrompt(ctx);
  const userPrompt = exemplarBlock ? `${exemplarBlock}\n\n${base}` : base;
  const systemParts = [UNTRUSTED_DATA_SYSTEM_CLAUSE, getFollowupSystemPrompt()];
  const geminiOk = selfTest ? true : isGeminiConfigured();
  const plannedChain = planWriterChain({ provider: getWriterProvider(), greyArea: grey, geminiConfigured: geminiOk, secondaryEnabled: isSecondaryEnabled() });
  const productionRoute = plannedChain[0];

  const result: CellResult = {
    cell,
    grey,
    greySignals,
    plannedChain,
    productionRoute,
    tiers: [],
    hardFailReasons: [],
  };

  for (const tier of TIER_ORDER) {
    if (!only.includes(tier)) continue;
    const model = modelForTier(tier);
    const out: TierOutput = {
      tier,
      model,
      status: "OK",
      subject: "",
      body: "",
      captured: null,
      lintPass: false,
      lintIssues: [],
      ms: 0,
      error: null,
    };

    // Skip a Gemini model when the key is absent (live mode only).
    if (!geminiOk && (tier === "gemini_primary" || tier === "gemini_secondary")) {
      out.status = "SKIP";
      out.error = "GEMINI_API_KEY not set";
      result.tiers.push(out);
      continue;
    }
    // Cost cap: stop launching further model calls once the ceiling is reached.
    if (hooks.capReached()) {
      out.status = "SKIP";
      out.error = "cost cap reached";
      result.tiers.push(out);
      continue;
    }

    const t0 = Date.now();
    try {
      let gen: TierGen;
      if (selfTest) {
        const cap: Captured =
          tier === "anthropic"
            ? anthropicCaptured({ input_tokens: 3200, output_tokens: 240 }, model)
            : geminiCaptured({ promptTokenCount: 3200, candidatesTokenCount: 240, thoughtsTokenCount: 60 }, model);
        gen = { subject: `Re: ${ctx.original_subject}`, body: fakeBody(ctx, tierLabel(tier)), captured: cap };
      } else if (tier === "anthropic") {
        gen = await genSonnet(userPrompt);
      } else {
        gen = await genGemini(tier, model, systemParts, userPrompt);
      }
      out.subject = gen.subject;
      out.body = gen.body;
      out.captured = gen.captured;
      hooks.addCost(gen.captured.costUsd);
      const lint = lintBody(gen.body, ctx);
      out.lintPass = lint.pass;
      out.lintIssues = lint.issues;
      if (gen.captured.model && MODEL_PRICES[gen.captured.model] === undefined) {
        out.status = "FAIL";
        out.error = `no price row for ${gen.captured.model}`;
        result.hardFailReasons.push(`${tierLabel(tier)}: no price row for ${gen.captured.model}`);
      }
    } catch (err) {
      const msg = String((err as { message?: string })?.message ?? err);
      out.error = msg.slice(0, 200);
      if (isOverload(msg)) {
        out.status = "BLOCK";
      } else {
        out.status = "FAIL";
        result.hardFailReasons.push(`${tierLabel(tier)} threw: ${msg.slice(0, 140)}`);
      }
    }
    out.ms = Date.now() - t0;
    result.tiers.push(out);
  }

  // Free deterministic routing checks.
  if (grey && productionRoute !== "anthropic") {
    result.hardFailReasons.push(`grey cell production route is ${productionRoute}, expected anthropic`);
  }
  if (!grey && geminiOk && productionRoute !== "gemini_primary") {
    result.hardFailReasons.push(`ordinary cell production route is ${productionRoute}, expected gemini_primary`);
  }
  return result;
}

// ===========================================================================
// Progress bar
// ===========================================================================

interface Tally {
  doneCalls: number;
  totalCalls: number;
  ok: number;
  fail: number;
  block: number;
  skip: number;
  spent: number;
}

function renderProgress(t: Tally): void {
  const width = 26;
  const ratio = t.totalCalls > 0 ? t.doneCalls / t.totalCalls : 0;
  const filled = Math.round(ratio * width);
  const bar = "#".repeat(filled) + "-".repeat(width - filled);
  const line =
    `[${bar}] ${t.doneCalls}/${t.totalCalls} calls  $${t.spent.toFixed(4)}  ` +
    `ok:${t.ok} fail:${t.fail} block:${t.block} skip:${t.skip}`;
  if (process.stdout.isTTY) process.stdout.write("\r" + line.padEnd(100));
  else if (t.doneCalls === t.totalCalls || t.doneCalls % 12 === 0) process.stdout.write(line + "\n");
}

// ===========================================================================
// Output writers
// ===========================================================================

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function buildLog(results: CellResult[], opts: Options, summary: string): string {
  const out: string[] = [];
  out.push("=== Follow-up writer model comparison ===");
  out.push(`generated: ${new Date().toISOString()}`);
  out.push(`mode: ${opts.mode}   preset: ${opts.preset}   gemini_configured: ${isGeminiConfigured()}`);
  out.push(`models: Flash=${getPrimaryGeminiModel()}  Pro=${getSecondaryGeminiModel()}  Sonnet=${MODEL_DRAFT_GENERATOR}`);
  out.push(`thinking: Flash=${thinkingForTier("gemini_primary")}  Pro=${thinkingForTier("gemini_secondary")}`);
  out.push(`caps: max_usd=${opts.maxUsd} max_cells=${opts.maxCells || "none"} concurrency=${opts.concurrency} lint_min_rate=${opts.lintMinRate}`);
  out.push("");
  out.push("Every model wrote the same prompt: same system prompt, same untrusted clause,");
  out.push("same exemplar block. The original outreach is English; the follow-up is written");
  out.push("in original_language. production_route is the model production would actually");
  out.push("use for this cell. Usage is captured for this report and is not written to the ledger.");
  out.push("");
  out.push("---------------------------------------------------------------------------");

  for (const r of results) {
    const c = r.cell;
    out.push(`#${pad(String(c.index), 3)} ${pad(c.kind, 7)} ${pad(c.lang, 3)} ${pad(c.vertical, 18)} stage=${c.stage}  grey=${r.grey}`);
    out.push(`     production_route=${tierLabel(r.productionRoute)}   plan=${r.plannedChain.join(" > ")}`);
    if (r.greySignals.length > 0) out.push(`     grey_signals=${r.greySignals.join(", ")}`);
    for (const t of r.tiers) {
      const cost = t.captured ? `$${t.captured.costUsd.toFixed(6)}` : "n/a";
      const tok = t.captured ? `in=${t.captured.inputTokens} out=${t.captured.outputTokens}` : "tokens=n/a";
      out.push(`     [${pad(tierLabel(t.tier), 12)}] ${pad(t.status, 5)} lint=${t.lintPass ? "PASS" : "FAIL"}  ${tok}  ${cost}  ${t.ms}ms`);
      if (t.status === "OK") {
        out.push(`        subject: ${t.subject}`);
        out.push(`        body: ${t.body.replace(/\n+/g, " ").slice(0, 220)}${t.body.length > 220 ? " ..." : ""}`);
        if (!t.lintPass && t.lintIssues.length > 0) out.push(`        lint_issues: ${t.lintIssues.join(" | ")}`);
      } else if (t.error) {
        out.push(`        note: ${t.error}`);
      }
    }
    if (r.hardFailReasons.length > 0) out.push(`     HARD_FAIL: ${r.hardFailReasons.join(" ; ")}`);
    out.push("");
  }
  out.push("---------------------------------------------------------------------------");
  out.push(summary);
  return out.join("\n");
}

function buildEmailsMd(results: CellResult[], opts: Options): string {
  const out: string[] = [];
  out.push(`# Follow-up writer model comparison`);
  out.push("");
  out.push(`Generated ${new Date().toISOString()} on mode \`${opts.mode}\`, preset \`${opts.preset}\`.`);
  out.push("");
  out.push("Each cell below shows the same prompt written by every model, so you can compare quality directly. The original outreach is English; the follow-up is written in the listed language.");
  out.push("");

  for (const r of results) {
    const c = r.cell;
    out.push(`## #${c.index} ${c.lang} / ${c.vertical} / stage ${c.stage}${c.kind !== "matrix" ? ` (${c.kind})` : ""}`);
    out.push("");
    out.push(`Production route for this cell: **${tierLabel(r.productionRoute)}**. grey: ${r.grey}.`);
    out.push("");
    for (const t of r.tiers) {
      out.push(`### ${tierLabel(t.tier)} (${t.model})`);
      out.push("");
      if (t.status !== "OK") {
        out.push(`status: ${t.status}${t.error ? ` - ${t.error}` : ""}`);
        out.push("");
        continue;
      }
      const cost = t.captured ? `$${t.captured.costUsd.toFixed(6)}` : "n/a";
      out.push("```yaml");
      out.push(`cost_usd: ${cost}`);
      out.push(`tokens: in=${t.captured?.inputTokens ?? 0} out=${t.captured?.outputTokens ?? 0}`);
      out.push(`lint: ${t.lintPass ? "PASS" : "FAIL"}`);
      if (!t.lintPass && t.lintIssues.length > 0) out.push(`lint_issues: ${JSON.stringify(t.lintIssues)}`);
      out.push("```");
      out.push("");
      out.push(`**Subject:** ${t.subject}`);
      out.push("");
      out.push(t.body);
      out.push("");
    }
    out.push("---");
    out.push("");
  }
  return out.join("\n");
}

// ===========================================================================
// Main
// ===========================================================================

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.mode === "chain") {
    console.log("NOTE: --mode chain drives the production fallback chain (one served model per");
    console.log("cell). To read all three models side by side, use the default --mode compare.\n");
  }
  const cells = buildMatrix(opts.preset);
  const geminiOk = opts.selfTest ? true : isGeminiConfigured();
  // Tiers actually run this session: the selected set, minus Gemini tiers when
  // no key is configured.
  const runTiers = opts.only.filter((t) => t === "anthropic" || geminiOk);
  const perCellCalls = runTiers.length;

  console.log("=== Follow-up writer model comparison ===");
  if (opts.selfTest) console.log("MODE: --self-test (offline, deterministic fake output, no provider calls)");
  console.log(`mode: ${opts.mode}   preset: ${opts.preset}   cells: ${cells.length}   calls/cell: ${perCellCalls}   concurrency: ${opts.concurrency}`);
  console.log(`only: ${opts.only.map(tierLabel).join(", ")}`);
  console.log(`models: Flash=${getPrimaryGeminiModel()}  Pro=${getSecondaryGeminiModel()}  Sonnet=${MODEL_DRAFT_GENERATOR}`);
  console.log(`thinking: Flash=${thinkingForTier("gemini_primary")}  Pro=${thinkingForTier("gemini_secondary")}  (Sonnet has no thinking knob)`);
  console.log(`caps: max_usd=$${opts.maxUsd}  max_cells=${opts.maxCells || "none"}\n`);

  if (!geminiOk && opts.only.some((t) => t !== "anthropic")) {
    console.log("WARN  GEMINI_API_KEY is not set. The Gemini models will be skipped this run.\n");
  }

  const tally: Tally = { doneCalls: 0, totalCalls: cells.length * perCellCalls, ok: 0, fail: 0, block: 0, skip: 0, spent: 0 };
  const results: CellResult[] = new Array(cells.length);
  let cursor = 0;
  let capStopped = false;

  const hooks: RunHooks = {
    capReached: () => opts.maxUsd > 0 && tally.spent >= opts.maxUsd,
    addCost: (usd: number) => {
      tally.spent += usd;
    },
  };

  async function worker(): Promise<void> {
    for (;;) {
      if (hooks.capReached()) {
        capStopped = true;
        return;
      }
      const i = cursor++;
      if (i >= cells.length) return;
      if (opts.maxCells > 0 && i >= opts.maxCells) {
        capStopped = true;
        return;
      }
      const r = await runCellCompare(cells[i], opts.selfTest, hooks, opts.only);
      results[i] = r;
      for (const t of r.tiers) {
        tally.doneCalls++;
        if (t.status === "OK") tally.ok++;
        else if (t.status === "FAIL") tally.fail++;
        else if (t.status === "BLOCK") tally.block++;
        else tally.skip++;
      }
      renderProgress(tally);
    }
  }

  const pool = Array.from({ length: Math.min(opts.concurrency, cells.length) }, () => worker());
  await Promise.all(pool);
  if (process.stdout.isTTY) process.stdout.write("\n");
  console.log("");

  const ran = results.filter((r): r is CellResult => r !== undefined);
  const cellsNotRun = cells.length - ran.length;

  // Per-model aggregates.
  const tiers: WriterTier[] = ALL_TIERS.filter((t) => opts.only.includes(t));
  const perModel: Record<string, { ok: number; fail: number; block: number; skip: number; cost: number; lintPass: number; lintTotal: number }> = {};
  for (const t of tiers) perModel[t] = { ok: 0, fail: 0, block: 0, skip: 0, cost: 0, lintPass: 0, lintTotal: 0 };
  let hardFails = 0;
  for (const r of ran) {
    hardFails += r.hardFailReasons.length;
    for (const t of r.tiers) {
      const m = perModel[t.tier];
      if (t.status === "OK") {
        m.ok++;
        m.lintTotal++;
        if (t.lintPass) m.lintPass++;
      } else if (t.status === "FAIL") m.fail++;
      else if (t.status === "BLOCK") m.block++;
      else m.skip++;
      if (t.captured) m.cost += t.captured.costUsd;
    }
  }
  const totalCost = tiers.reduce((a, t) => a + perModel[t].cost, 0);
  const totalLintPass = tiers.reduce((a, t) => a + perModel[t].lintPass, 0);
  const totalLintRan = tiers.reduce((a, t) => a + perModel[t].lintTotal, 0);
  const lintRate = totalLintRan > 0 ? totalLintPass / totalLintRan : 1;
  const lintGateFailed = opts.lintMinRate > 0 && lintRate < opts.lintMinRate;

  let head = "SMOKE PASS";
  let exit = 0;
  if (tally.fail > 0 || hardFails > 0 || lintGateFailed) {
    head = "SMOKE FAIL";
    exit = 1;
  } else if (tally.block > 0 || capStopped || cellsNotRun > 0 || tally.skip > 0) {
    head = "SMOKE INCOMPLETE";
    exit = 2;
  }

  const s: string[] = [];
  s.push(`=== ${head} : ${tally.ok} model calls ok, ${tally.fail} failed, ${tally.block} blocked, ${tally.skip} skipped, ${cellsNotRun} cells not run ===`);
  for (const t of tiers) {
    const m = perModel[t];
    const rate = m.lintTotal > 0 ? ((m.lintPass / m.lintTotal) * 100).toFixed(1) : "n/a";
    s.push(`  ${pad(tierLabel(t), 12)} ok:${m.ok} fail:${m.fail} block:${m.block} skip:${m.skip}  lint ${m.lintPass}/${m.lintTotal} (${rate}%)  cost $${m.cost.toFixed(6)}`);
  }
  s.push(`lint overall: ${totalLintPass}/${totalLintRan} (${(lintRate * 100).toFixed(1)}%)` + (opts.lintMinRate > 0 ? `  gate>=${(opts.lintMinRate * 100).toFixed(0)}% ${lintGateFailed ? "FAILED" : "met"}` : "  (report only)"));
  s.push(`total cost: $${totalCost.toFixed(6)}`);
  if (capStopped) s.push("a cap stopped the run before the full matrix completed (cost or cell cap).");
  if (tally.block > 0) s.push("some model calls were blocked by transient provider capacity or overload; rerun when capacity returns.");
  if (hardFails > 0) {
    s.push("hard failures:");
    for (const r of ran.filter((x) => x.hardFailReasons.length > 0)) {
      s.push(`  #${r.cell.index} ${r.cell.lang}/${r.cell.vertical}/s${r.cell.stage}: ${r.hardFailReasons.join(" ; ")}`);
    }
  }
  const summary = s.join("\n");

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logPath = join(opts.outDir, `smoke-writer-${stamp}.log`);
  const emailsArchivePath = join(opts.outDir, `emails-${stamp}.md`);
  const emailsLatestPath = join(opts.outDir, "emails.md");
  const emailsBody = buildEmailsMd(ran, opts);
  writeFileSync(logPath, buildLog(ran, opts, summary), "utf8");
  writeFileSync(emailsArchivePath, emailsBody, "utf8");
  writeFileSync(emailsLatestPath, emailsBody, "utf8");

  console.log(summary);
  console.log("");
  console.log(`log:              ${logPath}`);
  console.log(`emails (latest):  ${emailsLatestPath}`);
  console.log(`emails (archive): ${emailsArchivePath}`);
  process.exit(exit);
}

main().catch((e) => {
  console.error("\nsmoke-writer crashed:", e);
  process.exit(1);
});
