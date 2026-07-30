/**
 * Big smoke test for the follow-up WRITER fallback chain.
 *
 * On-demand diagnostic, not part of the auto-run suite, because it makes live
 * billed calls to Gemini and Anthropic and needs GEMINI_API_KEY plus the
 * configured Anthropic client. It lives under src/scripts/ so
 * `node --test src/tests/*.ts` never picks it up.
 *
 * What it does:
 *   Builds a matrix of follow-up drafting jobs across languages, verticals, and
 *   stages, adds a set of grey-area cells and a neutral-greeting edge cell, then
 *   drives each cell through the real runWriter chain (Gemini 3.5 Flash ->
 *   Gemini 3.1 Pro -> Sonnet 4.6). For each cell it records which tier served
 *   the draft, the token usage and USD cost, and whether the draft passes the
 *   deterministic doctrine lint. It renders a live shell progress bar, writes a
 *   readable smoke-writer-<timestamp>.log, and writes an emails.md you can read
 *   end to end to judge quality by eye.
 *
 * What it asserts as a hard pass or fail (exit 1 on failure):
 *   1. Every cell produces a non-empty subject and body on some tier.
 *   2. Grey-area cells are served on the Anthropic (Sonnet) tier and their
 *      planned chain is Sonnet-only. A grey cell served on Gemini is a failure.
 *   3. Ordinary cells, when Gemini is configured, plan the full chain starting
 *      on Gemini primary.
 *   4. Every served model has a real price row, so the reported cost is real.
 *
 * Quality signal, not a hard gate by default:
 *   The doctrine lint pass rate is reported. The draft stage runs before the
 *   critic and rewrite healing loop, so a draft may carry a violation that
 *   production would repair. Lint never fails the run unless you set
 *   --lint-min-rate above 0.
 *
 * Cost and time safety (agent-hardening defaults):
 *   The run stops launching new cells once spend reaches --max-usd or once
 *   --max-cells cells have run. Concurrency is bounded by --concurrency.
 *   Usage is captured locally for the report and is NOT written to the
 *   followup_usage ledger, so a smoke run never pollutes production billing.
 *
 * Run from artifacts/api-server, where the Anthropic client and GEMINI_API_KEY
 * are configured:
 *   node --import tsx src/scripts/smoke-writer.ts
 *   node --import tsx src/scripts/smoke-writer.ts --preset full --max-usd 10 --max-cells 250
 *
 * Exit codes: 0 every hard check passed and the matrix completed; 1 a real
 * failure; 2 incomplete because a cost or cell cap stopped the run, or because
 * live calls were blocked by transient capacity or overload, with no hard
 * failures.
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
  runWriter,
  planWriterChain,
  getWriterProvider,
  getPrimaryGeminiModel,
  getSecondaryGeminiModel,
  type WriterResult,
  type WriterTier,
} from "../services/writerProvider";
import { isGreyArea, detectGreyArea } from "../lib/greyArea";
import { buildWriterExemplarBlock } from "../lib/exemplarLibrary";
import { isGeminiConfigured, type GeminiUsageMetadata } from "../lib/gemini";
import { computeCostUsd, getModelPrice, MODEL_PRICES } from "../lib/pricing";
import { detectAllDeterministicViolations } from "../lib/doctrineLint";
import { detectStructuralViolations, mergeViolationReports } from "../lib/structuralLint";

// ===========================================================================
// CLI
// ===========================================================================

interface Options {
  preset: "quick" | "full";
  maxUsd: number;
  maxCells: number;
  concurrency: number;
  lintMinRate: number;
  outDir: string;
  selfTest: boolean;
}

function parseArgs(argv: string[]): Options {
  const o: Options = {
    preset: "quick",
    maxUsd: 2.0,
    maxCells: 0, // 0 means no cap; set per preset below
    concurrency: 4,
    lintMinRate: 0,
    outDir: process.cwd(),
    selfTest: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--preset") o.preset = next() === "full" ? "full" : "quick";
    else if (a === "--max-usd") o.maxUsd = Number(next());
    else if (a === "--max-cells") o.maxCells = Math.max(0, Math.floor(Number(next())));
    else if (a === "--concurrency") o.concurrency = Math.max(1, Math.floor(Number(next())));
    else if (a === "--lint-min-rate") o.lintMinRate = Math.max(0, Math.min(1, Number(next())));
    else if (a === "--out") o.outDir = next();
    else if (a === "--self-test") o.selfTest = true;
  }
  // Preset-aware defaults that the user did not override.
  if (o.preset === "full") {
    if (o.maxUsd === 2.0) o.maxUsd = 10.0;
    if (o.maxCells === 0) o.maxCells = 250;
  }
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

// Grey-area verticals. casino/forex/sports_betting hit STRONG_TERMS; crypto
// hits the structured-only term set. Every one of these must route to Sonnet.
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

// Per-vertical content seed. The original outreach stays in English as the
// grounding source; original_language drives the follow-up's output language,
// which is what the doctrine lint judges. This is a deliberate smoke-test
// simplification, called out here so the log is not misread.
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
        summary:
          "Intro to MobUpps performance UA for mobile games with semi-exclusive supply and fraud filtering.",
        body:
          "Hi Alex, I am reaching out from MobUpps about performance user acquisition for your mobile games. We run CPI and CPA campaigns on semi-exclusive supply with fraud filtering and durable post-install retention. Happy to share a small test plan.",
        subVertical: null,
      };
    case "non_gaming_ua":
      return {
        company: "Lumi Health App",
        product: "performance user acquisition for your app",
        subject: "MobUpps UA for Lumi Health App",
        summary:
          "Intro to MobUpps performance UA for a non-gaming app with fraud filtering and retention focus.",
        body:
          "Hi Alex, I am reaching out from MobUpps about performance user acquisition for Lumi Health App. We run CPI and CPA campaigns with fraud filtering and a focus on retained, active users. Happy to share a small test plan.",
        subVertical: null,
      };
    case "cps":
      return {
        company: "ShopNova",
        product: "CPS and revenue-share performance partnership",
        subject: "MobUpps CPS partnership for ShopNova",
        summary:
          "Intro to a CPS / revenue-share performance partnership with verified-sale tracking.",
        body:
          "Hi Alex, I am reaching out from MobUpps about a CPS partnership for ShopNova. We work on a revenue-share basis with verified-sale tracking and fraud filtering, so you pay against confirmed outcomes. Happy to share a short proposal.",
        subVertical: null,
      };
    case "retargeting":
      return {
        company: "Wanderly Travel",
        product: "retargeting and re-engagement campaigns",
        subject: "MobUpps retargeting for Wanderly Travel",
        summary:
          "Intro to retargeting and re-engagement campaigns for lapsed and dormant users.",
        body:
          "Hi Alex, I am reaching out from MobUpps about retargeting for Wanderly Travel. We re-engage lapsed and dormant users across owned audiences with measured incremental lift. Happy to share a short plan.",
        subVertical: null,
      };
    case "cps_ecommerce":
      return {
        company: "ShopNova",
        product: "CPS partnership for e-commerce",
        subject: "MobUpps CPS for ShopNova store",
        summary:
          "Intro to a CPS / revenue-share partnership for an e-commerce store with verified-sale tracking.",
        body:
          "Hi Alex, I am reaching out from MobUpps about a CPS partnership for the ShopNova store. We work on revenue share with verified-sale tracking, so you pay against confirmed purchases. Happy to share a short proposal.",
        subVertical: "cps_ecommerce",
      };
    case "cps_fintech":
      return {
        company: "PayLane",
        product: "CPS partnership for a fintech app",
        subject: "MobUpps CPS for PayLane",
        summary:
          "Intro to a CPS / cost-per-action partnership for a fintech app with verified-funded-account tracking.",
        body:
          "Hi Alex, I am reaching out from MobUpps about a CPS partnership for PayLane. We work on a cost-per-action basis tied to verified funded accounts, with fraud filtering. Happy to share a short proposal.",
        subVertical: "cps_fintech",
      };
    case "cps_subscription":
      return {
        company: "StreamWell",
        product: "CPS partnership for a subscription service",
        subject: "MobUpps CPS for StreamWell",
        summary:
          "Intro to a CPS / revenue-share partnership for a subscription service with verified-trial-start tracking.",
        body:
          "Hi Alex, I am reaching out from MobUpps about a CPS partnership for StreamWell. We work on revenue share tied to verified paid conversions, not just trial starts. Happy to share a short proposal.",
        subVertical: "cps_subscription",
      };
    // Grey verticals.
    case "casino":
      return {
        company: "RoyalSpin Casino",
        product: "casino and sportsbook user acquisition",
        subject: "MobUpps UA for RoyalSpin Casino",
        summary:
          "Intro to performance user acquisition for an online casino and sportsbook brand.",
        body:
          "Hi Alex, I am reaching out from MobUpps about user acquisition for RoyalSpin Casino. We run compliant performance campaigns on vetted supply for regulated iGaming. Happy to share a short plan.",
        subVertical: null,
      };
    case "sports_betting":
      return {
        company: "GoalLine Bet",
        product: "sports betting user acquisition",
        subject: "MobUpps UA for GoalLine Bet",
        summary:
          "Intro to performance user acquisition for a sports betting brand.",
        body:
          "Hi Alex, I am reaching out from MobUpps about user acquisition for GoalLine Bet. We run compliant performance campaigns on vetted supply for regulated sports betting. Happy to share a short plan.",
        subVertical: null,
      };
    case "crypto":
      return {
        company: "CoinBridge",
        product: "crypto exchange user acquisition",
        subject: "MobUpps UA for CoinBridge",
        summary:
          "Intro to performance user acquisition for a crypto exchange.",
        body:
          "Hi Alex, I am reaching out from MobUpps about user acquisition for CoinBridge. We run compliant performance campaigns on vetted supply for regulated crypto products. Happy to share a short plan.",
        subVertical: null,
      };
    case "forex":
      return {
        company: "FXPrime",
        product: "forex broker user acquisition",
        subject: "MobUpps UA for FXPrime",
        summary:
          "Intro to performance user acquisition for a forex broker.",
        body:
          "Hi Alex, I am reaching out from MobUpps about user acquisition for FXPrime. We run compliant performance campaigns on vetted supply for regulated forex products. Happy to share a short plan.",
        subVertical: null,
      };
    default:
      return seedFor("non_gaming_ua");
  }
}

function buildCtx(
  lang: string,
  vertical: string,
  stage: number,
  opts?: { sharedCompanyDraft?: boolean },
): FollowupContext {
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

function buildMatrix(preset: "quick" | "full"): Cell[] {
  const langs = preset === "full" ? LANGS_FULL : LANGS_QUICK;
  const verticals = preset === "full" ? VERTICALS_FULL : VERTICALS_QUICK;
  const stages = preset === "full" ? STAGES_FULL : STAGES_QUICK;

  const cells: Cell[] = [];
  let idx = 0;

  for (const lang of langs) {
    for (const vertical of verticals) {
      for (const stage of stages) {
        cells.push({ index: idx++, kind: "matrix", lang, vertical, stage, ctx: buildCtx(lang, vertical, stage) });
      }
    }
  }

  // Grey-area cells. quick: one casino cell in English. full: every grey
  // vertical across two languages.
  const greyLangs = preset === "full" ? ["en", "de"] : ["en"];
  const greyVerts = preset === "full" ? GREY_VERTICALS : ["casino"];
  for (const lang of greyLangs) {
    for (const v of greyVerts) {
      cells.push({ index: idx++, kind: "grey", lang, vertical: v, stage: 2, ctx: buildCtx(lang, v, 2) });
    }
  }

  // Neutral-greeting edge cell: shared_company_draft forces a no-first-name
  // greeting. Verifies the writer path does not break under that override.
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
  provider: "gemini" | "anthropic";
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
  const costUsd = computeCostUsd(model, {
    inputTokens,
    outputTokens,
    cacheCreationTokens: 0,
    cacheReadTokens: cached,
  });
  return { provider: "gemini", model, inputTokens, outputTokens, costUsd };
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
  const costUsd = computeCostUsd(model, {
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
  });
  return { provider: "anthropic", model, inputTokens, outputTokens, costUsd };
}

// Tolerant subject/body parser for the local Sonnet writer, matching the parser
// the production draft path uses.
function parseDraft(text: string): { subject: string; body: string } {
  let raw = text.replace(/```json\s*|```/g, "").trim();
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first !== -1 && last > first) raw = raw.slice(first, last + 1);
  const parsed = JSON.parse(raw) as { subject?: string; body?: string };
  return { subject: parsed.subject ?? "", body: parsed.body ?? "" };
}

// Deterministic body for --self-test. No network. Mechanically clean enough to
// exercise the lint path (acknowledges prior note, references one grounded
// fact, asks one short question, no closing line, no dashes).
function fakeBody(ctx: FollowupContext): string {
  const who = ctx.shared_company_draft ? "there" : ctx.prospect_name;
  return (
    `Hi ${who}, following up on my earlier note about ${ctx.product} for ${ctx.company}. ` +
    `I know inboxes get busy. If useful I can send a short test plan sized to one campaign. ` +
    `Would a brief look make sense on your side?`
  );
}

// ===========================================================================
// Per-cell execution
// ===========================================================================

interface CellResult {
  cell: Cell;
  status: "OK" | "FAIL" | "BLOCK";
  grey: boolean;
  greySignals: string[];
  plannedChain: WriterTier[];
  servedTier: WriterTier | null;
  servedModel: string | null;
  captured: Captured | null;
  lintPass: boolean;
  lintIssues: string[];
  subject: string;
  body: string;
  ms: number;
  error: string | null;
  hardFailReasons: string[];
}

function isOverload(msg: string): boolean {
  return /429|503|resource_exhausted|unavailable|overload|high demand|quota|rate limit/i.test(msg);
}

async function runCell(cell: Cell, selfTest = false): Promise<CellResult> {
  const ctx = cell.ctx;
  const t0 = Date.now();

  const grey = isGreyArea(ctx);
  const greySignals = detectGreyArea(ctx).signals;
  const exemplarBlock = buildWriterExemplarBlock(ctx);
  const base = getFollowupUserPrompt(ctx);
  const userPrompt = exemplarBlock ? `${exemplarBlock}\n\n${base}` : base;
  const systemParts = [UNTRUSTED_DATA_SYSTEM_CLAUSE, getFollowupSystemPrompt()];

  const plannedChain = planWriterChain({
    provider: getWriterProvider(),
    greyArea: grey,
    geminiConfigured: selfTest ? true : isGeminiConfigured(),
  });

  let captured: Captured | null = null;

  // Local Sonnet writer (the final tier). Mirrors the production
  // generateDraftSonnet path and captures its own usage for the report.
  const anthropicWriter = async (): Promise<WriterResult> => {
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
    captured = anthropicCaptured(response.usage as AnthropicUsageLike, response.model || MODEL_DRAFT_GENERATOR);
    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") throw new Error("No text in Sonnet draft response");
    const parsed = parseDraft(textBlock.text);
    if (!parsed.subject || !parsed.body) throw new Error("Sonnet draft missing subject or body");
    return { subject: parsed.subject, body: parsed.body, modelUsed: response.model || MODEL_DRAFT_GENERATOR, tier: "anthropic" };
  };

  // Capture Gemini usage without writing to the production ledger. Signature
  // matches recordGeminiUsageBestEffort: (usage, model, label) => Promise<void>.
  const recordGeminiUsage = (async (usage: GeminiUsageMetadata, model: string): Promise<void> => {
    captured = geminiCaptured(usage, model);
  }) as typeof import("../lib/usageTracker").recordGeminiUsageBestEffort;

  const result: CellResult = {
    cell,
    status: "OK",
    grey,
    greySignals,
    plannedChain,
    servedTier: null,
    servedModel: null,
    captured: null,
    lintPass: false,
    lintIssues: [],
    subject: "",
    body: "",
    ms: 0,
    error: null,
    hardFailReasons: [],
  };

  try {
    let writer: WriterResult;
    if (selfTest) {
      // Offline harness check: synthesize the served tier from the plan and a
      // deterministic draft. No provider call, no key needed. Exercises the
      // full matrix, lint, cost, progress, and output path.
      const servedTier = plannedChain[0];
      const servedModel =
        servedTier === "gemini_primary"
          ? getPrimaryGeminiModel()
          : servedTier === "gemini_secondary"
          ? getSecondaryGeminiModel()
          : MODEL_DRAFT_GENERATOR;
      writer = {
        subject: `Re: ${ctx.original_subject}`,
        body: fakeBody(ctx),
        modelUsed: servedModel,
        tier: servedTier,
      };
      captured =
        servedTier === "anthropic"
          ? anthropicCaptured(
              { input_tokens: 3200, output_tokens: 240, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
              servedModel,
            )
          : geminiCaptured(
              { promptTokenCount: 3200, candidatesTokenCount: 240, thoughtsTokenCount: 60, cachedContentTokenCount: 0 },
              servedModel,
            );
    } else {
      writer = await runWriter(
        {
          label: "draft",
          greyArea: grey,
          systemParts,
          userPrompt,
          maxOutputTokens: 8192,
          prospectName: ctx.prospect_name,
        },
        anthropicWriter,
        { recordGeminiUsage },
      );
    }

    result.servedTier = writer.tier;
    result.servedModel = writer.modelUsed;
    result.subject = writer.subject;
    result.body = writer.body;
    result.captured = captured;

    // Doctrine lint on the produced body, in the cell's language.
    const groundingSource = [ctx.original_subject, ctx.original_body, ctx.original_body_summary].join("\n");
    const lint = mergeViolationReports(
      detectAllDeterministicViolations(writer.body, ctx.original_language),
      detectStructuralViolations(writer.body, { languageTag: ctx.original_language, originalText: groundingSource }),
    );
    result.lintPass = !lint.found;
    result.lintIssues = lint.issues.slice(0, 4);

    // Hard checks.
    if (!writer.subject || !writer.body) {
      result.hardFailReasons.push("empty subject or body");
    }
    if (grey && writer.tier !== "anthropic") {
      result.hardFailReasons.push(`grey cell served on ${writer.tier}, expected anthropic`);
    }
    if (grey && (plannedChain.length !== 1 || plannedChain[0] !== "anthropic")) {
      result.hardFailReasons.push(`grey cell planned chain ${plannedChain.join(">")}, expected anthropic-only`);
    }
    if (!grey && isGeminiConfigured() && plannedChain[0] !== "gemini_primary") {
      result.hardFailReasons.push(`ordinary cell planned chain ${plannedChain.join(">")}, expected to start on gemini_primary`);
    }
    if (writer.modelUsed && MODEL_PRICES[writer.modelUsed] === undefined) {
      result.hardFailReasons.push(`no price row for served model ${writer.modelUsed}`);
    }

    result.status = result.hardFailReasons.length > 0 ? "FAIL" : "OK";
  } catch (err) {
    const msg = String((err as { message?: string })?.message ?? err);
    result.error = msg;
    if (isOverload(msg)) {
      result.status = "BLOCK";
    } else {
      result.status = "FAIL";
      result.hardFailReasons.push(`cell threw: ${msg.slice(0, 160)}`);
    }
  }

  result.ms = Date.now() - t0;
  result.captured = captured;
  return result;
}

// ===========================================================================
// Progress bar
// ===========================================================================

interface Tally {
  done: number;
  total: number;
  flash: number;
  pro: number;
  sonnet: number;
  fail: number;
  block: number;
  spent: number;
}

function renderProgress(t: Tally): void {
  const width = 28;
  const ratio = t.total > 0 ? t.done / t.total : 0;
  const filled = Math.round(ratio * width);
  const bar = "#".repeat(filled) + "-".repeat(width - filled);
  const line =
    `[${bar}] ${t.done}/${t.total}  $${t.spent.toFixed(4)}  ` +
    `flash:${t.flash} pro:${t.pro} sonnet:${t.sonnet} fail:${t.fail} block:${t.block}`;
  if (process.stdout.isTTY) {
    process.stdout.write("\r" + line.padEnd(100));
  } else if (t.done === t.total || t.done % 10 === 0) {
    process.stdout.write(line + "\n");
  }
}

function tierBucket(t: Tally, r: CellResult): void {
  if (r.servedTier === "gemini_primary") t.flash++;
  else if (r.servedTier === "gemini_secondary") t.pro++;
  else if (r.servedTier === "anthropic") t.sonnet++;
}

// ===========================================================================
// Output writers
// ===========================================================================

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function tierLabel(t: WriterTier | null): string {
  if (t === "gemini_primary") return "Gemini Flash";
  if (t === "gemini_secondary") return "Gemini Pro";
  if (t === "anthropic") return "Sonnet";
  return "n/a";
}

function buildLog(results: CellResult[], opts: Options, summary: string): string {
  const lines: string[] = [];
  lines.push("=== Follow-up writer chain smoke test ===");
  lines.push(`generated: ${new Date().toISOString()}`);
  lines.push(`preset: ${opts.preset}   provider: ${getWriterProvider()}   gemini_configured: ${isGeminiConfigured()}`);
  lines.push(`primary: ${getPrimaryGeminiModel()}   secondary: ${getSecondaryGeminiModel()}`);
  lines.push(`caps: max_usd=${opts.maxUsd} max_cells=${opts.maxCells || "none"} concurrency=${opts.concurrency} lint_min_rate=${opts.lintMinRate}`);
  lines.push("");
  lines.push("NOTE: the original outreach is in English as the grounding source; the");
  lines.push("follow-up is written in original_language, which is what the lint judges.");
  lines.push("Usage here is captured for the report and is not written to the ledger.");
  lines.push("");
  lines.push("---------------------------------------------------------------------------");

  for (const r of results) {
    const c = r.cell;
    const cost = r.captured ? `$${r.captured.costUsd.toFixed(6)}` : "n/a";
    const tok = r.captured ? `in=${r.captured.inputTokens} out=${r.captured.outputTokens}` : "tokens=n/a";
    lines.push(
      `#${pad(String(c.index), 3)} ${pad(c.kind, 7)} ${pad(c.lang, 3)} ${pad(c.vertical, 18)} stage=${c.stage}`,
    );
    lines.push(
      `     status=${r.status}  served=${tierLabel(r.servedTier)} (${r.servedModel ?? "n/a"})  grey=${r.grey}  lint=${r.lintPass ? "PASS" : "FAIL"}`,
    );
    lines.push(`     plan=${r.plannedChain.join(" > ")}  ${tok}  cost=${cost}  ${r.ms}ms`);
    if (r.greySignals.length > 0) lines.push(`     grey_signals=${r.greySignals.join(", ")}`);
    if (!r.lintPass && r.lintIssues.length > 0) lines.push(`     lint_issues=${r.lintIssues.join(" | ")}`);
    if (r.hardFailReasons.length > 0) lines.push(`     HARD_FAIL=${r.hardFailReasons.join(" ; ")}`);
    if (r.error) lines.push(`     error=${r.error.slice(0, 200)}`);
    if (r.subject) lines.push(`     subject: ${r.subject}`);
    if (r.body) {
      const preview = r.body.replace(/\n+/g, " ").slice(0, 240);
      lines.push(`     body: ${preview}${r.body.length > 240 ? " ..." : ""}`);
    }
    lines.push("");
  }

  lines.push("---------------------------------------------------------------------------");
  lines.push(summary);
  return lines.join("\n");
}

function buildEmailsMd(results: CellResult[], opts: Options): string {
  const out: string[] = [];
  out.push(`# Follow-up writer smoke emails`);
  out.push("");
  out.push(`Generated ${new Date().toISOString()} on preset \`${opts.preset}\`.`);
  out.push("");
  out.push(
    "Each email is the draft-stage output of the writer chain. The original outreach is English; the follow-up is written in the listed language.",
  );
  out.push("");

  for (const r of results) {
    if (!r.subject && !r.body) continue;
    const c = r.cell;
    const cost = r.captured ? `$${r.captured.costUsd.toFixed(6)}` : "n/a";
    out.push(`## #${c.index} ${c.lang} / ${c.vertical} / stage ${c.stage}${c.kind !== "matrix" ? ` (${c.kind})` : ""}`);
    out.push("");
    out.push("```yaml");
    out.push(`lang: ${c.lang}`);
    out.push(`vertical: ${c.vertical}`);
    out.push(`stage: ${c.stage}`);
    out.push(`kind: ${c.kind}`);
    out.push(`grey: ${r.grey}`);
    out.push(`served_tier: ${tierLabel(r.servedTier)}`);
    out.push(`served_model: ${r.servedModel ?? "n/a"}`);
    out.push(`cost_usd: ${cost}`);
    out.push(`lint: ${r.lintPass ? "PASS" : "FAIL"}`);
    if (!r.lintPass && r.lintIssues.length > 0) out.push(`lint_issues: ${JSON.stringify(r.lintIssues)}`);
    out.push("```");
    out.push("");
    out.push(`**Subject:** ${r.subject}`);
    out.push("");
    out.push(r.body);
    out.push("");
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
  const cells = buildMatrix(opts.preset);

  console.log("=== Follow-up writer chain smoke test ===");
  if (opts.selfTest) console.log("MODE: --self-test (offline, deterministic fake writer, no provider calls)");
  console.log(`preset: ${opts.preset}   cells: ${cells.length}   concurrency: ${opts.concurrency}`);
  console.log(`provider: ${getWriterProvider()}   gemini_configured: ${isGeminiConfigured()}`);
  console.log(`primary: ${getPrimaryGeminiModel()}   secondary: ${getSecondaryGeminiModel()}`);
  console.log(`caps: max_usd=$${opts.maxUsd}  max_cells=${opts.maxCells || "none"}\n`);

  if (!isGeminiConfigured() && !opts.selfTest) {
    console.log(
      "WARN  GEMINI_API_KEY is not set. Every ordinary cell will plan and serve on\n" +
        "      Sonnet. This validates the Sonnet writer and the routing, not the\n" +
        "      Gemini tiers. Set GEMINI_API_KEY to exercise the full chain.\n",
    );
  }

  const tally: Tally = {
    done: 0,
    total: cells.length,
    flash: 0,
    pro: 0,
    sonnet: 0,
    fail: 0,
    block: 0,
    spent: 0,
  };

  const results: CellResult[] = new Array(cells.length);
  let cursor = 0;
  let capStopped = false;

  async function worker(): Promise<void> {
    for (;;) {
      // Cost cap: stop launching once spend reaches the ceiling.
      if (opts.maxUsd > 0 && tally.spent >= opts.maxUsd) {
        capStopped = true;
        return;
      }
      const i = cursor++;
      if (i >= cells.length) return;
      // Cell cap: never launch more than maxCells cells.
      if (opts.maxCells > 0 && i >= opts.maxCells) {
        capStopped = true;
        return;
      }

      const r = await runCell(cells[i], opts.selfTest);
      results[i] = r;
      tally.done++;
      if (r.captured) tally.spent += r.captured.costUsd;
      if (r.status === "FAIL") tally.fail++;
      if (r.status === "BLOCK") tally.block++;
      tierBucket(tally, r);
      renderProgress(tally);
    }
  }

  const pool = Array.from({ length: Math.min(opts.concurrency, cells.length) }, () => worker());
  await Promise.all(pool);

  if (process.stdout.isTTY) process.stdout.write("\n");
  console.log("");

  // Collect only the cells that actually ran.
  const ran = results.filter((r): r is CellResult => r !== undefined);
  const skipped = cells.length - ran.length;

  // Aggregate.
  const okCount = ran.filter((r) => r.status === "OK").length;
  const failCount = ran.filter((r) => r.status === "FAIL").length;
  const blockCount = ran.filter((r) => r.status === "BLOCK").length;
  const lintRan = ran.filter((r) => r.status !== "BLOCK" && (r.subject || r.body));
  const lintPass = lintRan.filter((r) => r.lintPass).length;
  const lintRate = lintRan.length > 0 ? lintPass / lintRan.length : 1;
  const totalCost = ran.reduce((acc, r) => acc + (r.captured ? r.captured.costUsd : 0), 0);

  const lintGateFailed = opts.lintMinRate > 0 && lintRate < opts.lintMinRate;

  let head = "SMOKE PASS";
  let exit = 0;
  if (failCount > 0 || lintGateFailed) {
    head = "SMOKE FAIL";
    exit = 1;
  } else if (blockCount > 0 || capStopped || skipped > 0) {
    head = "SMOKE INCOMPLETE";
    exit = 2;
  }

  const summaryLines: string[] = [];
  summaryLines.push(
    `=== ${head} : ${okCount} ok, ${failCount} failed, ${blockCount} blocked, ${skipped} not run ===`,
  );
  summaryLines.push(
    `tiers served: Gemini Flash ${tally.flash}, Gemini Pro ${tally.pro}, Sonnet ${tally.sonnet}`,
  );
  summaryLines.push(
    `doctrine lint: ${lintPass}/${lintRan.length} passed (${(lintRate * 100).toFixed(1)}%)` +
      (opts.lintMinRate > 0 ? `  gate>=${(opts.lintMinRate * 100).toFixed(0)}% ${lintGateFailed ? "FAILED" : "met"}` : "  (report only)"),
  );
  summaryLines.push(`total cost: $${totalCost.toFixed(6)}`);
  if (capStopped) summaryLines.push("a cap stopped the run before the full matrix completed (cost or cell cap).");
  if (blockCount > 0) summaryLines.push("some cells were blocked by transient provider capacity or overload; rerun when capacity returns.");
  if (failCount > 0) {
    summaryLines.push("hard failures:");
    for (const r of ran.filter((x) => x.status === "FAIL")) {
      summaryLines.push(`  #${r.cell.index} ${r.cell.lang}/${r.cell.vertical}/s${r.cell.stage}: ${r.hardFailReasons.join(" ; ") || r.error}`);
    }
  }
  const summary = summaryLines.join("\n");

  // Write artifacts. The log and the emails archive are timestamped so reruns
  // never clobber a previous read. A stable emails.md always holds the latest
  // run for convenience.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logPath = join(opts.outDir, `smoke-writer-${stamp}.log`);
  const emailsArchivePath = join(opts.outDir, `emails-${stamp}.md`);
  const emailsLatestPath = join(opts.outDir, "emails.md");
  const logBody = buildLog(ran, opts, summary);
  const emailsBody = buildEmailsMd(ran, opts);
  writeFileSync(logPath, logBody, "utf8");
  writeFileSync(emailsArchivePath, emailsBody, "utf8");
  writeFileSync(emailsLatestPath, emailsBody, "utf8");

  console.log(summary);
  console.log("");
  console.log(`log:            ${logPath}`);
  console.log(`emails (latest): ${emailsLatestPath}`);
  console.log(`emails (archive): ${emailsArchivePath}`);

  process.exit(exit);
}

main().catch((e) => {
  console.error("\nsmoke-writer crashed:", e);
  process.exit(1);
});
