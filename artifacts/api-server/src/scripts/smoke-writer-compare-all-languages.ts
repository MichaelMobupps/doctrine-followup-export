/**
 * smoke-writer-compare-all-languages.ts — CAN THE CHEAP WRITER HOLD QUALITY?
 *
 * The decision this answers: can we afford to route the follow-up WRITER to the
 * cheap tier (Gemini 3.5 Flash) instead of Sonnet, across every language, without
 * losing quality? It generates the SAME follow-up on BOTH writers for every
 * doctrine language, runs the IDENTICAL production lint gate on the ship-
 * normalized body of each, and reports the per-model clean rate and the DELTA.
 *
 * Both writers receive the identical production prompt path: cachedSystem system
 * prefix (Sonnet) / the same systemParts (Flash), the exemplar + competitor study
 * blocks, and getFollowupUserPrompt. Flash runs at MINIMAL thinking with the
 * production {subject, body} response schema, exactly as writerProvider drives it.
 *
 * The verdict metric is the DELTA, not the absolute rate: this smoke lints the
 * first draft (ship-normalized), not the post-heal output, and production ships
 * the healed draft. The heal loop is model-agnostic, so if Flash's raw clean rate
 * tracks Sonnet's across languages, the healed Flash output will too. A large gap
 * in Flash's favour-of-worse is the signal that the cheap tier costs quality.
 *
 * SAFE: bounded by --max-usd (default 8) and --concurrency (default 4). Usage is
 * measured locally only; NOTHING is written to the production usage ledger.
 *
 * RUN (from artifacts/api-server):
 *   node --import tsx src/scripts/smoke-writer-compare-all-languages.ts
 *   node --import tsx src/scripts/smoke-writer-compare-all-languages.ts --verticals non_gaming_ua,cps,retargeting --max-usd 12
 *   node --import tsx src/scripts/smoke-writer-compare-all-languages.ts --langs en,de,ja,ar,hi --stage 2
 *   node --import tsx src/scripts/smoke-writer-compare-all-languages.ts --dry-run   # offline wiring check
 *
 * Flags:
 *   --dry-run                 build prompts + exercise lint for every cell, no API calls.
 *   --langs en,ja,ar          restrict to a subset (default: all 36).
 *   --verticals non_gaming_ua,cps   representative verticals (default: non_gaming_ua,cps).
 *   --stage 2                 follow-up stage (default 2).
 *   --max-usd 8               stop launching new cells once spend reaches this.
 *   --concurrency 4           parallel cells.
 *
 * Exit codes: 0 both writers completed and Flash held quality (delta within
 * tolerance); 1 Flash was materially worse than Sonnet (a genuine quality risk),
 * or a hard error; 2 incomplete because the cost cap stopped the run.
 */
import { writeFileSync } from "node:fs";
import { anthropic, MODEL_DRAFT_GENERATOR, cachedSystem } from "../lib/anthropic";
import { withAnthropicRetry } from "../services/anthropicRetry";
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
import { stripClosingFromBody } from "../services/signatureStripper";
import { geminiGenerateJson, isGeminiConfigured } from "../lib/gemini";
import { getPrimaryGeminiModel } from "../services/writerProvider";
import { computeCostUsd } from "../lib/pricing";

// ---- all 36 doctrine languages (same set as the sibling all-languages smokes) ----
const ALL_LANGS: string[] = [
  "en", "es", "de", "fr", "it", "pt", "pt-BR", "nl", "pl", "cs", "hu", "ro",
  "tr", "sv", "da", "nb", "fi", "id", "ms", "tl", "sw", "vi",
  "ru", "uk", "el",
  "ja", "zh", "ko",
  "ar", "he", "fa", "ur",
  "hi", "bn", "ta", "am",
];
const NON_LATIN = new Set([
  "ru", "uk", "el", "ja", "zh", "ko", "ar", "he", "fa", "ur", "hi", "bn", "ta", "am",
]);

// Flash's floor is MINIMAL thinking — exactly how writerProvider drives the
// primary tier. Same {subject, body} schema production constrains it with.
const WRITER_SCHEMA: Record<string, unknown> = {
  type: "OBJECT",
  properties: { subject: { type: "STRING" }, body: { type: "STRING" } },
  required: ["subject", "body"],
  propertyOrdering: ["subject", "body"],
};

// A material quality gap: if Flash's clean rate is more than this many points
// below Sonnet's, the cheap tier is judged to cost quality and the run fails.
const DELTA_TOLERANCE_PCT = 15;

interface Seed { company: string; product: string; subject: string; summary: string; body: string; subVertical: string | null; }
function seedFor(vertical: string): Seed {
  switch (vertical) {
    case "gaming_ua": return { company: "PixelForge Games", product: "performance user acquisition for mobile games", subject: "MobUpps UA for PixelForge Games", summary: "Intro to MobUpps performance UA for mobile games with semi-exclusive supply and fraud filtering.", body: "Hi Alex, I am reaching out from MobUpps about performance user acquisition for your mobile games. We run CPI and CPA campaigns on semi-exclusive supply with fraud filtering and durable post-install retention. Happy to share a small test plan.", subVertical: null };
    case "non_gaming_ua": return { company: "Lumi Health App", product: "performance user acquisition for your app", subject: "MobUpps UA for Lumi Health App", summary: "Intro to MobUpps performance UA for a non-gaming app with fraud filtering and retention focus.", body: "Hi Alex, I am reaching out from MobUpps about performance user acquisition for Lumi Health App. We run CPI and CPA campaigns with fraud filtering and a focus on retained, active users. Happy to share a small test plan.", subVertical: null };
    case "cps": return { company: "ShopNova", product: "CPS and revenue-share performance partnership", subject: "MobUpps CPS partnership for ShopNova", summary: "Intro to a CPS / revenue-share performance partnership with verified-sale tracking.", body: "Hi Alex, I am reaching out from MobUpps about a CPS partnership for ShopNova. We work on a revenue-share basis with verified-sale tracking and fraud filtering, so you pay against confirmed outcomes. Happy to share a short proposal.", subVertical: null };
    case "retargeting": return { company: "Wanderly Travel", product: "retargeting and re-engagement campaigns", subject: "MobUpps retargeting for Wanderly Travel", summary: "Intro to retargeting and re-engagement campaigns for lapsed and dormant users.", body: "Hi Alex, I am reaching out from MobUpps about retargeting for Wanderly Travel. We re-engage lapsed and dormant users across owned audiences with measured incremental lift. Happy to share a short plan.", subVertical: null };
    default: return seedFor("gaming_ua");
  }
}
function buildCtx(lang: string, vertical: string, stage: number): FollowupContext {
  const s = seedFor(vertical);
  return { prospect_name: "Alex", company: s.company, vertical, sub_vertical: s.subVertical, product: s.product, original_subject: s.subject, original_body_summary: s.summary, original_body: s.body, original_language: lang, stage, days_since_original: 4, sender_name: "Michael" };
}

// Ship-normalization: the deterministic passes production applies before sending
// (humanizeText dash-normalization + stripClosingFromBody). Lint the SHIPPED
// shape, not the raw draft, so neither writer is dinged for classes the humanizer
// already fixes. Mirrors smoke-writer-heal-all-languages.shipNormalize.
function shipNormalize(body: string): string {
  let r = body;
  r = r.replace(/\s*—\s*/g, " - "); // em dash -> hyphen
  r = r.replace(/\s*–\s*/g, " - "); // en dash -> hyphen
  return stripClosingFromBody(r);
}

// The exact production lint gate (mirrors smoke-writer / all-languages lintBody).
function lintBody(body: string, ctx: FollowupContext): { pass: boolean; issues: string[] } {
  const groundingSource = [ctx.original_subject, ctx.original_body, ctx.original_body_summary].join("\n");
  const report = mergeViolationReports(
    detectAllDeterministicViolations(body, ctx.original_language),
    detectStructuralViolations(body, { languageTag: ctx.original_language, originalText: groundingSource, companyName: ctx.company }),
  );
  return { pass: !report.found, issues: report.issues.slice(0, 4) };
}

function buildPrompts(ctx: FollowupContext): { systemParts: string[]; user: string } {
  const exemplarBlock = buildWriterExemplarBlock(ctx);
  const competitorBlock = buildWriterCompetitorBlock(ctx);
  const studyBlock = [competitorBlock, exemplarBlock].filter((b) => b.length > 0).join("\n\n");
  const base = getFollowupUserPrompt(ctx);
  const user = studyBlock ? `${studyBlock}\n\n${base}` : base;
  return { systemParts: [UNTRUSTED_DATA_SYSTEM_CLAUSE, getFollowupSystemPrompt()], user };
}

function parseSubjectBody(raw: string): { subject: string; body: string } {
  const cleaned = raw.replace(/```json\s*|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  const candidate = start !== -1 && end > start ? cleaned.slice(start, end + 1) : cleaned;
  const parsed = JSON.parse(candidate);
  if (!parsed.subject || !parsed.body) throw new Error("missing subject or body");
  return { subject: String(parsed.subject), body: String(parsed.body) };
}

interface Draft { subject: string; body: string; costUsd: number; model: string; }

async function genSonnet(systemParts: string[], user: string, label: string): Promise<Draft> {
  const system = cachedSystem(...systemParts);
  const resp = await withAnthropicRetry(
    () => anthropic.messages.create({ model: MODEL_DRAFT_GENERATOR, max_tokens: 8192, system, messages: [{ role: "user", content: user }] }),
    { label },
  );
  const u: any = (resp as any).usage ?? {};
  const tb = resp.content.find((b) => b.type === "text");
  if (!tb || tb.type !== "text") throw new Error("no text block");
  const { subject, body } = parseSubjectBody(tb.text);
  const costUsd = computeCostUsd(resp.model || MODEL_DRAFT_GENERATOR, {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
  });
  return { subject, body, costUsd, model: resp.model || MODEL_DRAFT_GENERATOR };
}

async function genFlash(systemParts: string[], user: string): Promise<Draft> {
  const res = await geminiGenerateJson({
    systemParts, user, maxOutputTokens: 8192,
    model: getPrimaryGeminiModel(), thinkingLevel: "MINIMAL", responseSchema: WRITER_SCHEMA,
  });
  const { subject, body } = parseSubjectBody(res.text);
  const u: any = res.usage ?? {};
  const costUsd = computeCostUsd(res.model, {
    inputTokens: u.promptTokenCount ?? 0,
    outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
    cacheCreationTokens: 0,
    cacheReadTokens: u.cachedContentTokenCount ?? 0,
  });
  return { subject, body, costUsd, model: res.model };
}

function parseArgs() {
  const a = process.argv.slice(2);
  const get = (flag: string, dflt: string) => {
    const i = a.indexOf(flag);
    return i >= 0 && a[i + 1] ? a[i + 1] : dflt;
  };
  return {
    dryRun: a.includes("--dry-run"),
    langs: get("--langs", "").trim() ? get("--langs", "").split(",").map((s) => s.trim()) : ALL_LANGS,
    verticals: get("--verticals", "non_gaming_ua,cps").split(",").map((s) => s.trim()),
    stage: Number(get("--stage", "2")),
    maxUsd: Number(get("--max-usd", "8")),
    concurrency: Math.max(1, Number(get("--concurrency", "4"))),
  };
}

type Verdict = "PASS" | "FAIL" | "ERROR" | "CAPPED";
interface Row {
  lang: string; vertical: string;
  sonnet: { verdict: Verdict; issues: string[]; subject: string; body: string; costUsd: number };
  flash: { verdict: Verdict; issues: string[]; subject: string; body: string; costUsd: number };
}

async function runCell(lang: string, vertical: string, stage: number, dryRun: boolean): Promise<Row> {
  const ctx = buildCtx(lang, vertical, stage);
  const { systemParts, user } = buildPrompts(ctx);

  if (dryRun) {
    lintBody("probe", ctx); // exercise the gate
    const built = `built: sys=${systemParts.join("").length} user=${user.length} chars`;
    const stub = { verdict: "PASS" as Verdict, issues: [], subject: "(dry-run)", body: built, costUsd: 0 };
    return { lang, vertical, sonnet: stub, flash: { ...stub } };
  }

  async function one(gen: () => Promise<Draft>) {
    try {
      const d = await gen();
      const lint = lintBody(shipNormalize(d.body), ctx);
      return { verdict: (lint.pass ? "PASS" : "FAIL") as Verdict, issues: lint.issues, subject: d.subject, body: d.body, costUsd: d.costUsd };
    } catch (err) {
      return { verdict: "ERROR" as Verdict, issues: [err instanceof Error ? err.message : String(err)], subject: "", body: "", costUsd: 0 };
    }
  }
  // Run both writers concurrently for this language.
  const [sonnet, flash] = await Promise.all([
    one(() => genSonnet(systemParts, user, `cmp:sonnet:${lang}:${vertical}`)),
    one(() => genFlash(systemParts, user)),
  ]);
  return { lang, vertical, sonnet, flash };
}

function rate(rows: Row[], pick: (r: Row) => Row["sonnet"]): { clean: number; total: number; pct: number } {
  const graded = rows.filter((r) => pick(r).verdict === "PASS" || pick(r).verdict === "FAIL");
  const clean = graded.filter((r) => pick(r).verdict === "PASS").length;
  const total = graded.length;
  return { clean, total, pct: total ? (100 * clean) / total : 0 };
}

async function main() {
  const opts = parseArgs();
  if (!opts.dryRun && !isGeminiConfigured()) {
    console.error("GEMINI_API_KEY is not set — cannot compare the Flash tier. Aborting.");
    process.exit(1);
  }
  const cells: Array<{ lang: string; vertical: string }> = [];
  for (const lang of opts.langs) for (const v of opts.verticals) cells.push({ lang, vertical: v });

  console.log(`\nFlash-vs-Sonnet writer quality comparison ${opts.dryRun ? "(DRY RUN — no API calls)" : "(LIVE — billed calls)"}`);
  console.log(`Flash=${getPrimaryGeminiModel()} @ MINIMAL   Sonnet=${MODEL_DRAFT_GENERATOR}`);
  console.log(`languages=${opts.langs.length}  verticals=${opts.verticals.join(",")}  stage=${opts.stage}  cells=${cells.length}  (2 calls/cell)`);
  if (!opts.dryRun) console.log(`caps: max_usd=${opts.maxUsd}  concurrency=${opts.concurrency}\n`);

  const rows: Row[] = [];
  let spent = 0;
  let capped = false;
  let idx = 0;

  async function worker() {
    while (true) {
      const my = idx++;
      if (my >= cells.length) return;
      if (!opts.dryRun && spent >= opts.maxUsd) {
        const cap = { verdict: "CAPPED" as Verdict, issues: [], subject: "", body: "", costUsd: 0 };
        rows.push({ ...cells[my], sonnet: cap, flash: { ...cap } });
        capped = true;
        continue;
      }
      const r = await runCell(cells[my].lang, cells[my].vertical, opts.stage, opts.dryRun);
      spent += r.sonnet.costUsd + r.flash.costUsd;
      rows.push(r);
      const flag = NON_LATIN.has(r.lang) ? "*" : " ";
      const mark = (v: Verdict) => (v === "PASS" ? "PASS" : v === "FAIL" ? "FAIL" : v === "ERROR" ? "ERR " : "CAP ");
      const gap = r.sonnet.verdict === "PASS" && r.flash.verdict === "FAIL" ? "  <-- Flash worse" : "";
      if (opts.dryRun) {
        console.log(`${(r.lang + flag).padEnd(7)} ${r.vertical.padEnd(14)} ${r.flash.body}`);
      } else {
        console.log(
          `${(r.lang + flag).padEnd(7)} ${r.vertical.padEnd(14)} ` +
          `Sonnet ${mark(r.sonnet.verdict)}  Flash ${mark(r.flash.verdict)}  ` +
          `$${(r.sonnet.costUsd + r.flash.costUsd).toFixed(4)}${gap}` +
          `${r.flash.verdict === "FAIL" ? `   flash: ${r.flash.issues.join(" | ")}` : ""}`,
        );
      }
    }
  }
  await Promise.all(Array.from({ length: opts.concurrency }, () => worker()));

  // ---- archive both emails per cell for human reading ----
  if (!opts.dryRun) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const md = rows
      .filter((r) => r.flash.body || r.sonnet.body)
      .map((r) =>
        `## ${r.lang} / ${r.vertical}\n\n` +
        `### Sonnet — ${r.sonnet.verdict}\n**Subject:** ${r.sonnet.subject}\n\n${r.sonnet.body}\n` +
        `${r.sonnet.issues.length ? `\n> issues: ${r.sonnet.issues.join(" | ")}\n` : ""}\n` +
        `### Flash — ${r.flash.verdict}\n**Subject:** ${r.flash.subject}\n\n${r.flash.body}\n` +
        `${r.flash.issues.length ? `\n> issues: ${r.flash.issues.join(" | ")}\n` : ""}`,
      )
      .join("\n\n---\n\n");
    const file = `emails-compare-${ts}.md`;
    writeFileSync(file, `# Flash-vs-Sonnet writer comparison — ${ts}\n\n${md}\n`, "utf8");
    writeFileSync("emails-compare.md", `# Flash-vs-Sonnet writer comparison — ${ts}\n\n${md}\n`, "utf8");
    console.log(`\nBoth emails per cell archived to ${file} (and emails-compare.md)`);
  }

  // ---- summary ----
  const sRate = rate(rows, (r) => r.sonnet);
  const fRate = rate(rows, (r) => r.flash);
  const delta = sRate.pct - fRate.pct; // positive => Sonnet cleaner => Flash costs quality
  const errs = rows.filter((r) => r.sonnet.verdict === "ERROR" || r.flash.verdict === "ERROR");
  const flashWorse = rows.filter((r) => r.sonnet.verdict === "PASS" && r.flash.verdict === "FAIL");
  const flashBetter = rows.filter((r) => r.sonnet.verdict === "FAIL" && r.flash.verdict === "PASS");

  console.log(`\n${"-".repeat(64)}`);
  console.log(`graded cells: ${sRate.total}`);
  console.log(`Sonnet clean: ${sRate.clean}/${sRate.total}  (${sRate.pct.toFixed(1)}%)`);
  console.log(`Flash  clean: ${fRate.clean}/${fRate.total}  (${fRate.pct.toFixed(1)}%)`);
  console.log(`delta (Sonnet - Flash): ${delta.toFixed(1)} pts   tolerance: ${DELTA_TOLERANCE_PCT} pts`);
  console.log(`cells where Flash was worse than Sonnet: ${flashWorse.length}${flashWorse.length ? `  [${flashWorse.map((r) => `${r.lang}/${r.vertical}`).join(", ")}]` : ""}`);
  if (flashBetter.length) console.log(`cells where Flash was BETTER than Sonnet: ${flashBetter.length}  [${flashBetter.map((r) => `${r.lang}/${r.vertical}`).join(", ")}]`);
  if (!opts.dryRun) console.log(`spend: $${spent.toFixed(4)} of $${opts.maxUsd} cap`);
  if (errs.length) console.log(`errors: ${errs.map((r) => `${r.lang}/${r.vertical}`).join(", ")}`);

  const hardError = errs.length > 0;
  const qualityRisk = delta > DELTA_TOLERANCE_PCT;
  const verdict = hardError
    ? "COMPARE FAIL (errors)"
    : capped
    ? "COMPARE INCOMPLETE (cost cap)"
    : qualityRisk
    ? `COMPARE FAIL — Flash ${delta.toFixed(1)} pts worse than Sonnet (> ${DELTA_TOLERANCE_PCT} pt tolerance)`
    : `COMPARE PASS — Flash holds quality (within ${DELTA_TOLERANCE_PCT} pts of Sonnet)`;
  console.log(`\n${verdict}\n`);
  process.exit(hardError || qualityRisk ? 1 : capped ? 2 : 0);
}

main().catch((e) => {
  console.error("fatal:", e instanceof Error ? e.message : e);
  process.exit(1);
});
