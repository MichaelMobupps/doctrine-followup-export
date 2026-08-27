/**
 * bench-llm-quality.ts — head-to-head writer quality + cost across candidate
 * models, using the REAL production prompts and the REAL production lint gate.
 *
 * WHY THIS EXISTS
 *
 * Moving every role off Anthropic is a cost decision, and a cost decision made
 * without a quality measurement is a guess. This is the measurement. For each
 * candidate model it generates a follow-up for every (language x vertical)
 * cell through exactly the prompt path services/followupGenerator.ts uses —
 * the same system prefix, the same competitor + exemplar study block, the same
 * user prompt — and then grades the result with exactly the gates production
 * grades with (doctrineLint + structuralLint, merged).
 *
 * The headline number is FIRST-DRAFT CLEAN RATE: the share of cells whose very
 * first draft passes the deterministic doctrine and nativeness gates with no
 * rewrite. It is the right metric because it is what the healing loop costs
 * money on — every point of first-draft clean rate is a critic call and a
 * rewrite call that never happen. A model that drafts worse is not just worse,
 * it is also dearer than its sticker price suggests.
 *
 * It reports, per model: clean rate, mean cost per email, mean latency, and the
 * top failing rules, plus a blended "cost per CLEAN email" that prices the
 * healing loop back in.
 *
 * SAFE: makes no DB writes, sends no email, touches no production ledger.
 * Bounded by --max-usd and --concurrency.
 *
 * RUN (from artifacts/api-server):
 *   node --import tsx src/scripts/bench-llm-quality.ts --models "gemini:gemini-3.1-flash-lite@MINIMAL,openai:gpt-5.4-nano@none"
 *   node --import tsx src/scripts/bench-llm-quality.ts --langs en,ja,de,ar,he,ru --verticals gaming_ua,cps
 *   node --import tsx src/scripts/bench-llm-quality.ts --out bench.json
 *
 * Flags:
 *   --models "p:m@e,p:m@e"   candidates to compare (default: the six that matter)
 *   --langs en,ja,ar         languages (default: a 12-language spread across all four script families)
 *   --verticals gaming_ua    verticals (default gaming_ua,cps)
 *   --stage 2                follow-up stage (default 2)
 *   --max-usd 6              stop launching new cells once spend reaches this
 *   --concurrency 6          parallel cells
 *   --out FILE               also write the full JSON result
 *
 * Exit codes: 0 the run completed; 2 the cost cap stopped it early.
 */
import { writeFileSync } from "node:fs";
import { geminiGenerateJson, type ThinkingLevel } from "../lib/gemini";
import { openaiGenerateJson, type ReasoningEffort } from "../lib/openai";
import { computeCostUsd } from "../lib/pricing";
import { parseChainSpec, type ModelTier } from "../lib/modelPolicy";
import { SUBJECT_BODY_SCHEMA, parseLlmJson } from "../lib/llmRouter";
import {
  getFollowupSystemPrompt,
  getFollowupUserPrompt,
  type FollowupContext,
} from "../services/followupPrompts";
import { UNTRUSTED_DATA_SYSTEM_CLAUSE } from "../lib/promptInjection";
import { detectAllDeterministicViolations } from "../lib/doctrineLint";
import { detectStructuralViolations, mergeViolationReports } from "../lib/structuralLint";
import { buildWriterExemplarBlock } from "../lib/exemplarLibrary";
import { buildWriterCompetitorBlock } from "../lib/competitorLibrary";

// A 12-language spread covering all four script families the doctrine
// supports: Latin, Cyrillic/Greek, CJK, RTL, and Indic. Deliberately not all 36
// by default — the point of the default run is a decision in ten minutes for a
// couple of dollars, and the full 36 is available with --langs.
const DEFAULT_LANGS = ["en", "es", "de", "pt-BR", "tr", "ru", "el", "ja", "zh", "ar", "he", "hi"];

const DEFAULT_MODELS = [
  "gemini:gemini-3.1-flash-lite@MINIMAL",
  "openai:gpt-5.4-nano@none",
  "gemini:gemini-3-flash-preview@MINIMAL",
  "openai:gpt-4.1-mini",
  "gemini:gemini-3.7-flash@LOW",
  "openai:gpt-5.4-mini@none",
].join(",");

interface Seed {
  company: string;
  product: string;
  subject: string;
  summary: string;
  body: string;
  subVertical: string | null;
}

// Same seeds as scripts/smoke-writer-all-languages.ts, so a number produced
// here is comparable with the numbers already recorded in that harness's runs.
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
    default:
      return seedFor("gaming_ua");
  }
}

function buildCtx(lang: string, vertical: string, stage: number): FollowupContext {
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
    days_since_original: 4,
    sender_name: "Michael",
  };
}

// The exact production lint gate (mirrors smoke-writer-all-languages' lintBody).
function lintBody(body: string, ctx: FollowupContext): { pass: boolean; issues: string[] } {
  const groundingSource = [ctx.original_subject, ctx.original_body, ctx.original_body_summary].join("\n");
  const report = mergeViolationReports(
    detectAllDeterministicViolations(body, ctx.original_language),
    detectStructuralViolations(body, {
      languageTag: ctx.original_language,
      originalText: groundingSource,
      companyName: ctx.company,
    }),
  );
  return { pass: !report.found, issues: report.issues };
}

// The exact production prompt (mirrors generateDraft).
function buildPrompts(ctx: FollowupContext): { systemParts: string[]; user: string } {
  const exemplarBlock = buildWriterExemplarBlock(ctx);
  const competitorBlock = buildWriterCompetitorBlock(ctx);
  const studyBlock = [competitorBlock, exemplarBlock].filter((b) => b.length > 0).join("\n\n");
  const base = getFollowupUserPrompt(ctx);
  const user = studyBlock ? `${studyBlock}\n\n${base}` : base;
  return { systemParts: [UNTRUSTED_DATA_SYSTEM_CLAUSE, getFollowupSystemPrompt()], user };
}

// A violation issue string is long and cell-specific; the RULE TAG at its head
// is what aggregates. Take the leading ALL-CAPS token run, else the first
// four words.
function ruleTag(issue: string): string {
  const m = issue.match(/^([A-Z][A-Z0-9 \-_]{2,40}?)(?::| —| -|$)/);
  if (m) return m[1].trim();
  return issue.split(/\s+/).slice(0, 4).join(" ");
}

interface Cell {
  lang: string;
  vertical: string;
}

interface CellResult {
  lang: string;
  vertical: string;
  status: "PASS" | "FAIL" | "ERROR" | "CAPPED";
  issues: string[];
  costUsd: number;
  ms: number;
  outputTokens: number;
  body: string;
  subject: string;
}

async function runCell(tier: ModelTier, cell: Cell, stage: number): Promise<CellResult> {
  const ctx = buildCtx(cell.lang, cell.vertical, stage);
  const { systemParts, user } = buildPrompts(ctx);
  const started = Date.now();
  try {
    let text: string;
    let inputTokens: number;
    let outputTokens: number;
    let cachedTokens: number;

    if (tier.provider === "gemini") {
      const res = await geminiGenerateJson({
        systemParts,
        user,
        model: tier.model,
        maxOutputTokens: 8192,
        thinkingLevel: tier.thinking as ThinkingLevel | undefined,
        responseSchema: {
          type: "OBJECT",
          properties: { subject: { type: "STRING" }, body: { type: "STRING" } },
          required: ["subject", "body"],
          propertyOrdering: ["subject", "body"],
        },
      });
      text = res.text;
      const cached = res.usage.cachedContentTokenCount ?? 0;
      inputTokens = Math.max(0, (res.usage.promptTokenCount ?? 0) - cached);
      outputTokens = (res.usage.candidatesTokenCount ?? 0) + (res.usage.thoughtsTokenCount ?? 0);
      cachedTokens = cached;
    } else {
      const res = await openaiGenerateJson({
        systemParts,
        user,
        model: tier.model,
        maxOutputTokens: 8192,
        reasoningEffort: tier.effort as ReasoningEffort | undefined,
        responseSchema: {
          type: "object",
          properties: { subject: { type: "string" }, body: { type: "string" } },
          required: ["subject", "body"],
          additionalProperties: false,
        },
        schemaName: SUBJECT_BODY_SCHEMA.name,
      });
      text = res.text;
      const cached = res.usage.cachedPromptTokens ?? 0;
      inputTokens = Math.max(0, (res.usage.promptTokens ?? 0) - cached);
      // completion_tokens already includes reasoning_tokens.
      outputTokens = res.usage.completionTokens ?? 0;
      cachedTokens = cached;
    }

    const ms = Date.now() - started;
    const parsed = parseLlmJson<{ subject?: string; body?: string }>(text);
    const subject = String(parsed.subject ?? "");
    const body = String(parsed.body ?? "");
    if (!subject || !body) throw new Error("missing subject or body");
    const lint = lintBody(body, ctx);
    return {
      lang: cell.lang,
      vertical: cell.vertical,
      status: lint.pass ? "PASS" : "FAIL",
      issues: lint.issues,
      costUsd: computeCostUsd(tier.model, {
        inputTokens,
        outputTokens,
        cacheCreationTokens: 0,
        cacheReadTokens: cachedTokens,
      }),
      ms,
      outputTokens,
      body,
      subject,
    };
  } catch (err) {
    return {
      lang: cell.lang,
      vertical: cell.vertical,
      status: "ERROR",
      issues: [err instanceof Error ? err.message : String(err)],
      costUsd: 0,
      ms: Date.now() - started,
      outputTokens: 0,
      body: "",
      subject: "",
    };
  }
}

interface ModelReport {
  spec: string;
  provider: string;
  model: string;
  cells: number;
  pass: number;
  fail: number;
  error: number;
  cleanRatePct: number;
  meanCostUsd: number;
  meanMs: number;
  p95Ms: number;
  costPerCleanUsd: number;
  topRules: Array<{ rule: string; n: number }>;
  results: CellResult[];
}

function summarize(spec: string, tier: ModelTier, results: CellResult[]): ModelReport {
  const done = results.filter((r) => r.status !== "CAPPED");
  const pass = done.filter((r) => r.status === "PASS").length;
  const fail = done.filter((r) => r.status === "FAIL").length;
  const error = done.filter((r) => r.status === "ERROR").length;
  const totalCost = done.reduce((s, r) => s + r.costUsd, 0);
  const times = done.map((r) => r.ms).sort((a, b) => a - b);
  const meanMs = times.length ? times.reduce((s, t) => s + t, 0) / times.length : 0;
  const p95Ms = times.length ? times[Math.min(times.length - 1, Math.floor(times.length * 0.95))] : 0;

  const ruleCounts = new Map<string, number>();
  for (const r of done) {
    if (r.status !== "FAIL") continue;
    // Count each rule once per cell, not once per occurrence, so one email
    // tripping the same rule five times does not dominate the table.
    for (const tag of new Set(r.issues.map(ruleTag))) {
      ruleCounts.set(tag, (ruleCounts.get(tag) ?? 0) + 1);
    }
  }
  const topRules = [...ruleCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([rule, n]) => ({ rule, n }));

  const meanCost = done.length ? totalCost / done.length : 0;
  return {
    spec,
    provider: tier.provider,
    model: tier.model,
    cells: done.length,
    pass,
    fail,
    error,
    cleanRatePct: done.length ? (pass / done.length) * 100 : 0,
    meanCostUsd: meanCost,
    meanMs,
    p95Ms,
    // Cost per CLEAN email: prices the healing loop back in. A draft that fails
    // the gate costs a critic call plus a rewrite call before it can ship, so a
    // cheaper model with a worse clean rate is not necessarily cheaper.
    costPerCleanUsd: pass ? totalCost / pass : Number.POSITIVE_INFINITY,
    topRules,
    results,
  };
}

function parseArgs() {
  const a = process.argv.slice(2);
  const get = (flag: string, dflt: string) => {
    const i = a.indexOf(flag);
    return i >= 0 && a[i + 1] ? a[i + 1] : dflt;
  };
  return {
    models: get("--models", DEFAULT_MODELS),
    langs: get("--langs", DEFAULT_LANGS.join(",")).split(",").map((s) => s.trim()).filter(Boolean),
    verticals: get("--verticals", "gaming_ua,cps").split(",").map((s) => s.trim()).filter(Boolean),
    stage: Number(get("--stage", "2")),
    maxUsd: Number(get("--max-usd", "6")),
    concurrency: Math.max(1, Number(get("--concurrency", "6"))),
    out: get("--out", ""),
  };
}

async function runModel(
  spec: string,
  tier: ModelTier,
  cells: Cell[],
  stage: number,
  concurrency: number,
  budgetLeft: () => number,
  spend: (usd: number) => void,
): Promise<ModelReport> {
  const results: CellResult[] = [];
  let idx = 0;
  async function worker() {
    for (;;) {
      const my = idx++;
      if (my >= cells.length) return;
      if (budgetLeft() <= 0) {
        results.push({
          ...cells[my],
          status: "CAPPED",
          issues: [],
          costUsd: 0,
          ms: 0,
          outputTokens: 0,
          body: "",
          subject: "",
        });
        continue;
      }
      const r = await runCell(tier, cells[my], stage);
      spend(r.costUsd);
      results.push(r);
      process.stdout.write(r.status === "PASS" ? "." : r.status === "FAIL" ? "x" : "!");
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, cells.length) }, worker));
  process.stdout.write("\n");
  return summarize(spec, tier, results);
}

async function main() {
  const opts = parseArgs();
  const specs = opts.models.split(",").map((s) => s.trim()).filter(Boolean);
  const tiers = specs.map((s) => {
    const parsed = parseChainSpec("bench", s);
    if (parsed.length !== 1) throw new Error(`--models entry did not parse to one tier: "${s}"`);
    return { spec: s, tier: parsed[0] };
  });

  const cells: Cell[] = [];
  for (const lang of opts.langs) for (const v of opts.verticals) cells.push({ lang, vertical: v });

  console.log("\nLLM writer quality + cost bench (LIVE — billed calls)");
  console.log(`models=${tiers.length}  langs=${opts.langs.length}  verticals=${opts.verticals.join(",")}  cells/model=${cells.length}`);
  console.log(`caps: max_usd=${opts.maxUsd}  concurrency=${opts.concurrency}\n`);

  let spent = 0;
  const budgetLeft = () => opts.maxUsd - spent;
  const spend = (usd: number) => {
    spent += usd;
  };

  const reports: ModelReport[] = [];
  for (const { spec, tier } of tiers) {
    process.stdout.write(`${spec.padEnd(42)} `);
    reports.push(await runModel(spec, tier, cells, opts.stage, opts.concurrency, budgetLeft, spend));
  }

  reports.sort((a, b) => b.cleanRatePct - a.cleanRatePct);

  console.log("\n=== RESULTS (sorted by first-draft clean rate) ===\n");
  const head = [
    "model".padEnd(34),
    "clean%".padStart(7),
    "pass".padStart(5),
    "fail".padStart(5),
    "err".padStart(4),
    "$/email".padStart(9),
    "$/clean".padStart(9),
    "mean ms".padStart(8),
    "p95 ms".padStart(7),
  ].join(" ");
  console.log(head);
  console.log("-".repeat(head.length));
  for (const r of reports) {
    console.log(
      [
        `${r.provider}:${r.model}`.padEnd(34),
        r.cleanRatePct.toFixed(1).padStart(7),
        String(r.pass).padStart(5),
        String(r.fail).padStart(5),
        String(r.error).padStart(4),
        r.meanCostUsd.toFixed(6).padStart(9),
        (Number.isFinite(r.costPerCleanUsd) ? r.costPerCleanUsd.toFixed(6) : "inf").padStart(9),
        r.meanMs.toFixed(0).padStart(8),
        String(r.p95Ms).padStart(7),
      ].join(" "),
    );
  }

  console.log("\n=== TOP FAILING RULES PER MODEL ===");
  for (const r of reports) {
    if (!r.topRules.length) {
      console.log(`\n${r.provider}:${r.model}  (no failures)`);
      continue;
    }
    console.log(`\n${r.provider}:${r.model}`);
    for (const t of r.topRules) console.log(`   ${String(t.n).padStart(3)}  ${t.rule}`);
  }

  console.log(`\ntotal spend: $${spent.toFixed(4)}`);

  if (opts.out) {
    writeFileSync(opts.out, JSON.stringify({ opts, reports }, null, 2));
    console.log(`wrote ${opts.out}`);
  }

  const capped = reports.some((r) => r.results.some((c) => c.status === "CAPPED"));
  process.exit(capped ? 2 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
