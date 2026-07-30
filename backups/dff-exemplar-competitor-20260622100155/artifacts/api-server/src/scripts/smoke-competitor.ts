/**
 * Competitor-injection smoke probe for the follow-up writer.
 *
 * On-demand diagnostic, not part of the auto-run suite. It checks the new
 * in-region competitor block end to end on the deployed code:
 *   1. Deterministic selector behaviour (no API): the block fires for CPS cells
 *      with a resolvable sub-vertical and stays inert for UA cells.
 *   2. Live Flash behaviour (real billed call): the production study block
 *      (competitor block + exemplar block) plus the real follow-up prompt
 *      produces a draft that passes the deterministic lint, so the added prompt
 *      content introduces no lint regression on the cheap tier.
 *   3. Informational signals: which nameable peers were injected, whether the
 *      draft named one, and for non-Latin languages whether a Latin peer name
 *      leaked without transliteration (a brand-adaptation miss to eyeball).
 *
 * No production side effects: usage is captured locally for the cost cap and is
 * NOT written to the followup_usage ledger; nothing is sent and nothing is
 * persisted. Run from artifacts/api-server, where GEMINI_API_KEY is configured.
 *
 *   node --import tsx src/scripts/smoke-competitor.ts            # live, Flash
 *   node --import tsx src/scripts/smoke-competitor.ts --dry      # offline, selector only
 *   node --import tsx src/scripts/smoke-competitor.ts --max-usd 0.50
 *
 * Exit codes: 0 all selector expectations correct and (dry, or live lint pass
 * rate at or above --lint-min-rate with no hard error); 1 a selector mismatch, a
 * lint pass rate below the floor, or a non-capacity error; 2 a cap or provider
 * capacity stopped the live calls before completion.
 */
import { writeFileSync } from "node:fs";

import {
  getFollowupSystemPrompt,
  getFollowupUserPrompt,
  type FollowupContext,
} from "../services/followupPrompts";
import { UNTRUSTED_DATA_SYSTEM_CLAUSE } from "../lib/promptInjection";
import { buildWriterExemplarBlock } from "../lib/exemplarLibrary";
import { buildWriterCompetitorBlock, selectCompetitors } from "../lib/competitorLibrary";
import { geminiGenerateJson, isGeminiConfigured } from "../lib/gemini";
import { getPrimaryGeminiModel } from "../services/writerProvider";
import { computeCostUsd } from "../lib/pricing";
import { detectAllDeterministicViolations } from "../lib/doctrineLint";
import { detectStructuralViolations, mergeViolationReports } from "../lib/structuralLint";

interface Opts {
  dry: boolean;
  maxUsd: number;
  lintMinRate: number;
}

function parseArgs(argv: string[]): Opts {
  const o: Opts = { dry: false, maxUsd: 1.0, lintMinRate: 0.6 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry") o.dry = true;
    else if (a === "--max-usd") o.maxUsd = Math.max(0, Number(argv[++i]));
    else if (a === "--lint-min-rate") o.lintMinRate = Math.max(0, Math.min(1, Number(argv[++i])));
  }
  return o;
}

interface CellSpec {
  lang: string;
  vertical: string;
  sub: string | null;
  product: string;
  expectBlock: boolean;
  nonLatin?: boolean;
  company: string;
  body: string;
}

// Curated cells: CPS across script families (the block should fire) plus one UA
// cell (the block should stay inert). cps_ecommerce and cps_fintech resolve
// through the bridge; the languages are all present in the competitor map.
const CELLS: CellSpec[] = [
  { lang: "en", vertical: "cps", sub: "cps_ecommerce", product: "cps", expectBlock: true,
    company: "ShopNova", body: "Hi Alex, I am reaching out from MobUpps about a CPS partnership for the ShopNova store. We work on revenue share with verified-sale tracking, so you pay against confirmed purchases. Happy to share a short proposal." },
  { lang: "es", vertical: "cps", sub: "cps_ecommerce", product: "cps", expectBlock: true,
    company: "ShopNova", body: "Hi Alex, I am reaching out from MobUpps about a CPS partnership for the ShopNova store. We work on revenue share with verified-sale tracking, so you pay against confirmed purchases. Happy to share a short proposal." },
  { lang: "pt", vertical: "cps", sub: "cps_fintech", product: "cps", expectBlock: true,
    company: "PayLane", body: "Hi Alex, I am reaching out from MobUpps about a CPS partnership for PayLane. We work on a cost-per-action basis tied to verified funded accounts, with fraud filtering. Happy to share a short proposal." },
  { lang: "ar", vertical: "cps", sub: "cps_ecommerce", product: "cps", expectBlock: true, nonLatin: true,
    company: "ShopNova", body: "Hi Alex, I am reaching out from MobUpps about a CPS partnership for the ShopNova store. We work on revenue share with verified-sale tracking, so you pay against confirmed purchases. Happy to share a short proposal." },
  { lang: "ru", vertical: "cps", sub: "cps_ecommerce", product: "cps", expectBlock: true, nonLatin: true,
    company: "ShopNova", body: "Hi Alex, I am reaching out from MobUpps about a CPS partnership for the ShopNova store. We work on revenue share with verified-sale tracking, so you pay against confirmed purchases. Happy to share a short proposal." },
  { lang: "en", vertical: "non_gaming_ua", sub: null, product: "ua", expectBlock: false,
    company: "Lumi Health App", body: "Hi Alex, I am reaching out from MobUpps about performance user acquisition for Lumi Health App. We run CPI and CPA campaigns with fraud filtering and a focus on retained, active users. Happy to share a small test plan." },
];

const WRITER_JSON_SCHEMA: Record<string, unknown> = {
  type: "OBJECT",
  properties: { subject: { type: "STRING" }, body: { type: "STRING" } },
  required: ["subject", "body"],
  propertyOrdering: ["subject", "body"],
};

function buildCtx(c: CellSpec): FollowupContext {
  return {
    prospect_name: "Alex",
    company: c.company,
    vertical: c.vertical,
    sub_vertical: c.sub,
    product: c.product,
    original_subject: `MobUpps partnership for ${c.company}`,
    original_body_summary: `Intro to a MobUpps partnership for ${c.company}.`,
    original_body: c.body,
    original_language: c.lang,
    stage: 2,
    days_since_original: 4,
    sender_name: "Dana",
  };
}

function parseSubjectBody(text: string): { subject: string; body: string } {
  const cleaned = text.replace(/```json\s*|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  const candidate = start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;
  const parsed = JSON.parse(candidate) as { subject?: unknown; body?: unknown };
  const subject = typeof parsed.subject === "string" ? parsed.subject : "";
  const body = typeof parsed.body === "string" ? parsed.body : "";
  if (!subject || !body) throw new Error("Gemini output missing subject or body");
  return { subject, body };
}

function lintClean(body: string, ctx: FollowupContext): { pass: boolean; issues: string[] } {
  const groundingSource = [ctx.original_subject, ctx.original_body, ctx.original_body_summary].join("\n");
  const report = mergeViolationReports(
    detectAllDeterministicViolations(body, ctx.original_language),
    detectStructuralViolations(body, {
      languageTag: ctx.original_language,
      originalText: groundingSource,
      companyName: ctx.company,
    }),
  );
  return { pass: !report.found, issues: report.issues.slice(0, 4) };
}

function geminiCostUsd(model: string, usage: {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  cachedContentTokenCount?: number;
}): number {
  const cached = usage.cachedContentTokenCount ?? 0;
  const inputTokens = Math.max(0, (usage.promptTokenCount ?? 0) - cached);
  const outputTokens = (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0);
  return computeCostUsd(model, { inputTokens, outputTokens, cacheCreationTokens: 0, cacheReadTokens: cached });
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const live = !opts.dry && isGeminiConfigured();
  const model = getPrimaryGeminiModel();
  const log: string[] = [];
  const say = (s: string): void => {
    console.log(s);
    log.push(s);
  };

  say("=== Competitor-injection smoke ===");
  say(`mode: ${opts.dry ? "dry (selector only)" : live ? `live (Flash=${model})` : "selector only (GEMINI_API_KEY not set)"}`);
  say(`caps: max_usd=${opts.maxUsd}  lint_min_rate=${opts.lintMinRate}`);
  say("");

  let selectorMismatch = false;
  let hardError = false;
  let capStopped = false;
  let spent = 0;
  let liveRan = 0;
  let lintPasses = 0;

  for (const c of CELLS) {
    const ctx = buildCtx(c);
    const sel = selectCompetitors(ctx);
    const compBlock = buildWriterCompetitorBlock(ctx);
    const fired = compBlock.length > 0;
    const peers = sel ? sel.nameable : [];

    const tag = `[${c.lang} ${c.vertical}${c.sub ? "/" + c.sub : ""}]`;

    // 1. Deterministic selector expectation.
    if (c.expectBlock && (!fired || peers.length === 0)) {
      say(`${tag} SELECTOR FAIL: expected an in-region block with peers, got none.`);
      selectorMismatch = true;
      continue;
    }
    if (!c.expectBlock && fired) {
      say(`${tag} SELECTOR FAIL: expected no block for a UA cell, but one fired.`);
      selectorMismatch = true;
      continue;
    }
    if (!c.expectBlock) {
      say(`${tag} selector inert as expected (no competitor block).`);
      say("");
      continue;
    }
    say(`${tag} vertical=${sel!.vertical}  peers: ${peers.slice(0, 8).join(", ")}`);

    // 2. Live Flash draft (optional).
    if (!live) {
      say("");
      continue;
    }
    if (spent >= opts.maxUsd) {
      say(`${tag} SKIP live call: cost cap $${opts.maxUsd} reached.`);
      capStopped = true;
      say("");
      continue;
    }

    const studyBlock = [compBlock, buildWriterExemplarBlock(ctx)].filter((b) => b.length > 0).join("\n\n");
    const userPrompt = `${studyBlock}\n\n${getFollowupUserPrompt(ctx)}`;
    const systemParts = [UNTRUSTED_DATA_SYSTEM_CLAUSE, getFollowupSystemPrompt()];

    try {
      const res = await geminiGenerateJson({
        systemParts,
        user: userPrompt,
        maxOutputTokens: 8192,
        model,
        thinkingLevel: "MINIMAL",
        responseSchema: WRITER_JSON_SCHEMA,
      });
      const cost = geminiCostUsd(res.model, res.usage);
      spent += cost;
      const draft = parseSubjectBody(res.text);
      const lint = lintClean(draft.body, ctx);
      liveRan += 1;
      if (lint.pass) lintPasses += 1;

      const used = peers.filter((p) => draft.body.includes(p));
      say(`  draft lint=${lint.pass ? "PASS" : "FAIL"}  $${cost.toFixed(6)}`);
      say(`  subject: ${draft.subject}`);
      say(`  body: ${draft.body.replace(/\n+/g, " ")}`);
      if (!lint.pass) say(`  lint_issues: ${lint.issues.join(" | ")}`);
      if (c.nonLatin) {
        say(used.length > 0
          ? `  NOTE: Latin peer name appears verbatim (${used.join(", ")}) — confirm it should be transliterated for ${c.lang}.`
          : `  peer naming: no Latin peer leaked (transliterated or omitted, as expected for ${c.lang}).`);
      } else {
        say(used.length > 0
          ? `  peer naming: draft referenced ${used.join(", ")}.`
          : `  peer naming: no peer named (allowed — competitor reference is optional).`);
      }
    } catch (err) {
      const msg = String((err as { message?: string })?.message ?? err);
      const capacity = /429|503|resource_exhausted|unavailable|overloaded|quota|rate limit/i.test(msg);
      if (capacity) {
        say(`  SKIP live call: provider capacity (${msg.slice(0, 80)}).`);
        capStopped = true;
      } else {
        say(`  HARD ERROR: ${msg.slice(0, 160)}`);
        hardError = true;
      }
    }
    say("");
  }

  const liveRate = liveRan > 0 ? lintPasses / liveRan : 1;
  say("---------------------------------------------------------------");
  say(`selector: ${selectorMismatch ? "MISMATCH" : "all expectations correct"}`);
  if (live) say(`live drafts: ${liveRan}  lint_pass=${lintPasses}  rate=${liveRate.toFixed(2)}  spent=$${spent.toFixed(6)}`);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = `smoke-competitor-${stamp}.log`;
  writeFileSync(file, log.join("\n"));
  say(`log: ${file}`);

  let code = 0;
  let verdict = "PASS";
  if (selectorMismatch || hardError) {
    code = 1;
    verdict = "FAIL";
  } else if (live && liveRan > 0 && liveRate < opts.lintMinRate) {
    code = 1;
    verdict = `FAIL (lint rate ${liveRate.toFixed(2)} below ${opts.lintMinRate})`;
  } else if (capStopped && liveRan === 0 && !opts.dry) {
    code = 2;
    verdict = "INCOMPLETE (capacity or cap stopped all live calls)";
  }
  say(`VERDICT: ${verdict}`);
  process.exit(code);
}

main().catch((err) => {
  console.error("smoke-competitor crashed:", err);
  process.exit(1);
});
