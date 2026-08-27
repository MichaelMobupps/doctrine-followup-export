/**
 * smoke-writer-heal-all-languages.ts — does the production HEAL LOOP ship clean?
 *
 * The draft-only bench (scripts/bench-llm-quality.ts) measures FIRST-DRAFT
 * quality. Production does not ship the first draft: it runs a 2-iteration
 * healing loop (generateFollowupEmail in services/followupGenerator.ts) that, on
 * any deterministic doctrine/nativeness violation, feeds the findings to the
 * rewriter and tries again. This smoke replicates that exact loop so you can see
 * what actually ships:
 *
 *   draft   (the `draft` role's waterfall — lib/modelPolicy.ts)
 *     -> lint  (detectAllDeterministicViolations + detectStructuralViolations)
 *     -> if clean: done
 *     -> else: rewrite (the `rewriter` role's waterfall) with the findings as
 *              feedback, re-lint
 *   up to maxHealingIterations = 2, matching production.
 *
 * THIS IS THE NUMBER THAT MATTERS for a model-chain decision. First-draft clean
 * rate is a leading indicator; SHIPS-CLEAN rate is the outcome, and TOTAL cost
 * per shipped email is the price — a cheaper draft that heals twice is not
 * cheaper. Run it before and after any change to a writer chain.
 *
 * Aug 2026: ported off the Sonnet writer onto the production waterfalls, so the
 * models it exercises are exactly the models production uses. Cost is computed
 * from lib/pricing.ts against whichever tier actually served, rather than from a
 * hardcoded Sonnet rate card.
 *
 * Note: production's heal gate is slightly broader (it also runs competitor-
 * script, meta-language and ungrounded-number checks). Using the narrower gate
 * here is deliberately conservative: the real heal rate is at least this good.
 *
 * SAFE: bounded by --max-usd (default 8) and --concurrency (default 4). A clean
 * first draft costs 1 call; a healed cell costs up to 3. Nothing touches the
 * production usage ledger.
 *
 * RUN (from artifacts/api-server):
 *   node --import tsx src/scripts/smoke-writer-heal-all-languages.ts
 *   node --import tsx src/scripts/smoke-writer-heal-all-languages.ts --langs de,fr,it,tr,sv --max-usd 4
 *   node --import tsx src/scripts/smoke-writer-heal-all-languages.ts --baseline-model claude-sonnet-4-6
 *
 * --baseline-model (default claude-sonnet-4-6) re-prices the run's OWN observed
 * token counts under that model's rate card, so the summary answers "what did
 * the migration save?" on identical prompts and identical call counts.
 *
 * Exit codes: 0 every cell ships clean after healing; 1 at least one cell STILL
 * violates after 2 rewrites (a genuine ship risk); 2 incomplete (cost cap).
 */
import { writeFileSync } from "node:fs";
import { runLlmDraft } from "../lib/llmRouter";
import { computeCostUsd } from "../lib/pricing";
import { describeChain, getChain } from "../lib/modelPolicy";
import {
  getFollowupSystemPrompt,
  getFollowupUserPrompt,
  getRewriterSystemPrompt,
  getRewriterUserPrompt,
  type FollowupContext,
} from "../services/followupPrompts";
import { UNTRUSTED_DATA_SYSTEM_CLAUSE } from "../lib/promptInjection";
import { detectAllDeterministicViolations } from "../lib/doctrineLint";
import { detectStructuralViolations, mergeViolationReports } from "../lib/structuralLint";
import { buildWriterExemplarBlock } from "../lib/exemplarLibrary";
import { buildWriterCompetitorBlock } from "../lib/competitorLibrary";
import { stripClosingFromBody } from "../services/signatureStripper";
import { shapeFollowupBody, selectLayoutProfile } from "../lib/layoutShaper";
import { applyJapaneseRegister, withJapaneseClosing } from "../lib/japaneseRegister";

/**
 * Ship-normalization — the deterministic passes production applies to the body
 * before sending (followupGenerator.humanizeFollowup). The heal loop lints the
 * RAW draft (as production does in-loop), but the SHIPPED email is humanized, so
 * the true "ships clean" verdict must lint the humanized body. Without this the
 * smoke over-reports classes the humanizer already fixes — e.g. FORBIDDEN-DASH,
 * because humanizeText rewrites em/en dashes to hyphens, and closing/sign-off
 * violations, because stripClosingFromBody removes them.
 *
 * The dash regexes are copied verbatim from humanizeText (stable, two lines);
 * the closing strip uses the REAL production module, so it cannot drift. Cosmetic
 * passes (smart quotes, ellipsis, AI-phrase swaps) are intentionally omitted:
 * they do not correspond to any deterministic doctrine/structural lint class.
 */
function shipNormalize(body: string, ctx: FollowupContext): string {
  let r = body;
  r = r.replace(/\s*\u2014\s*/g, " - "); // em dash -> hyphen
  r = r.replace(/\s*\u2013\s*/g, " - "); // en dash -> hyphen
  // 2026-08-26: production's humanizeFollowup now ends with the layout
  // shaper. Without mirroring it here every shipped body would flag the
  // LAYOUT lint classes this harness is supposed to prove are fixed.
  //
  // 2026-08-27: and it now ends with applyJapaneseRegister after that. This
  // function's whole claim is that it models what production SHIPS, so every
  // pass production adds has to be added here too or the harness quietly
  // under-reports. A JA run caught this: the archived bodies still showed 貴社
  // that production would have normalized to 御社 before sending.
  return withJapaneseClosing(
    applyJapaneseRegister(
      shapeFollowupBody(stripClosingFromBody(r), {
        profile: selectLayoutProfile(ctx),
        languageTag: ctx.original_language,
      }),
      ctx.original_language,
    ),
    ctx.original_language,
    `${ctx.company}|${ctx.original_subject}|${ctx.stage}`,
  );
}

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
const MAX_HEAL = 2; // matches followupGenerator.ts maxHealingIterations

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

// Same gate the draft smoke used (production's is broader; this is conservative).
function lintFull(body: string, ctx: FollowupContext) {
  const groundingSource = [ctx.original_subject, ctx.original_body, ctx.original_body_summary].join("\n");
  return mergeViolationReports(
    detectAllDeterministicViolations(body, ctx.original_language),
    detectStructuralViolations(body, { languageTag: ctx.original_language, originalText: groundingSource, companyName: ctx.company }),
  );
}

function studyBlockFor(ctx: FollowupContext): string {
  const ex = buildWriterExemplarBlock(ctx);
  const comp = buildWriterCompetitorBlock(ctx);
  return [comp, ex].filter((b) => b.length > 0).join("\n\n");
}

/**
 * One writer call through the production waterfall.
 *
 * `usage: {kind:"none"}` keeps this out of the followup_usage ledger — the smoke
 * must not pollute production spend reporting or the daily budget cap — so cost
 * is computed here from the same pricing table the ledger would have used.
 */
async function write(
  role: "draft" | "rewriter",
  systemParts: string[],
  user: string,
  baselineModel: string,
): Promise<{
  draft: { subject: string; body: string };
  costUsd: number;
  baselineUsd: number;
  model: string;
  tier: number;
}> {
  const { value, result } = await runLlmDraft({
    role,
    systemParts,
    user,
    maxOutputTokens: 8192,
    usage: { kind: "none" },
  });
  const tokens = {
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    cacheCreationTokens: 0,
    cacheReadTokens: result.usage.cachedInputTokens,
  };
  return {
    draft: value,
    costUsd: computeCostUsd(result.model, tokens),
    // The SAME observed token counts, priced under another model's rate card.
    // This is the honest apples-to-apples baseline: identical prompts, identical
    // number of calls, only the price list differs. What it deliberately does
    // NOT model is whether the baseline model would have needed fewer heal
    // iterations — see the note printed with the summary.
    baselineUsd: computeCostUsd(baselineModel, tokens),
    model: result.model,
    tier: result.tierIndex,
  };
}

interface Result {
  lang: string; vertical: string;
  firstClean: boolean; finalClean: boolean; iterations: number;
  status: "CLEAN-FIRST" | "HEALED" | "HUMANIZED" | "STILL-FAILING" | "ERROR" | "CAPPED";
  residual: string[]; subject: string; body: string; costUsd: number;
  /** The same tokens priced under --baseline-model's rate card. */
  baselineUsd: number;
  /** Which concrete model served each call, with a (tN) marker when a fallback tier did. */
  models: string[];
}

async function runCellHeal(lang: string, vertical: string, stage: number, baselineModel: string): Promise<Result> {
  const ctx = buildCtx(lang, vertical, stage);
  const study = studyBlockFor(ctx);
  const draftSystem = [UNTRUSTED_DATA_SYSTEM_CLAUSE, getFollowupSystemPrompt()];
  const rewriteSystem = [UNTRUSTED_DATA_SYSTEM_CLAUSE, getRewriterSystemPrompt()];
  let cost = 0;
  let baselineCost = 0;
  const models: string[] = [];
  try {
    const base = getFollowupUserPrompt(ctx);
    const draftUser = study ? `${study}\n\n${base}` : base;
    const first = await write("draft", draftSystem, draftUser, baselineModel);
    let draft = first.draft;
    cost += first.costUsd;
    baselineCost += first.baselineUsd;
    models.push(`draft=${first.model}${first.tier > 1 ? `(t${first.tier})` : ""}`);

    let report = lintFull(draft.body, ctx);
    const firstClean = !report.found;
    let iterations = 0;

    while (report.found && iterations < MAX_HEAL) {
      iterations++;
      const rewriteBase = getRewriterUserPrompt(ctx, draft, { issues: report.issues, suggestions: report.suggestions });
      const rewriteUser = study ? `${study}\n\n${rewriteBase}` : rewriteBase;
      const rw = await write("rewriter", rewriteSystem, rewriteUser, baselineModel);
      cost += rw.costUsd;
      baselineCost += rw.baselineUsd;
      models.push(`rw${iterations}=${rw.model}${rw.tier > 1 ? `(t${rw.tier})` : ""}`);
      draft = rw.draft;
      report = lintFull(draft.body, ctx);
      if (!report.found) break;
    }

    const finalClean = !report.found;

    // Production ships humanizeFollowup(draft), not the raw draft. Lint the
    // humanized body for the true ship verdict so we don't over-report classes
    // the humanizer fixes (dashes, closing/sign-off lines).
    const shipBody = shipNormalize(draft.body, ctx);
    const shipReport = lintFull(shipBody, ctx);
    const shipClean = !shipReport.found;

    let status: Result["status"];
    if (firstClean) status = "CLEAN-FIRST";
    else if (finalClean) status = "HEALED";
    else if (shipClean) status = "HUMANIZED"; // loop left a residual, humanizer cleared it
    else status = "STILL-FAILING";

    return { lang, vertical, firstClean, finalClean: shipClean, iterations, status, residual: shipReport.issues.slice(0, 3), subject: draft.subject, body: shipBody, costUsd: cost, baselineUsd: baselineCost, models };
  } catch (err) {
    return { lang, vertical, firstClean: false, finalClean: false, iterations: 0, status: "ERROR", residual: [err instanceof Error ? err.message : String(err)], subject: "", body: "", costUsd: cost, baselineUsd: baselineCost, models };
  }
}

function parseArgs() {
  const a = process.argv.slice(2);
  const get = (f: string, d: string) => { const i = a.indexOf(f); return i >= 0 && a[i + 1] ? a[i + 1] : d; };
  return {
    langs: get("--langs", "").trim() ? get("--langs", "").split(",").map((s) => s.trim()) : ALL_LANGS,
    verticals: get("--verticals", "gaming_ua,cps").split(",").map((s) => s.trim()),
    stage: Number(get("--stage", "2")),
    maxUsd: Number(get("--max-usd", "8")),
    // The rate card to compare against. Defaults to the Sonnet writer this
    // pipeline ran on until Aug 2026, so the summary answers "what did the
    // migration actually save?" without anyone doing arithmetic by hand.
    baselineModel: get("--baseline-model", "claude-sonnet-4-6"),
    concurrency: Math.max(1, Number(get("--concurrency", "4"))),
  };
}

async function main() {
  const opts = parseArgs();
  const cells: Array<{ lang: string; vertical: string }> = [];
  for (const lang of opts.langs) for (const v of opts.verticals) cells.push({ lang, vertical: v });

  console.log(`\nFull-chain HEAL smoke (LIVE — billed calls). Replicates production's ${MAX_HEAL}-pass heal loop.`);
  console.log(`languages=${opts.langs.length}  verticals=${opts.verticals.join(",")}  stage=${opts.stage}  cells=${cells.length}`);
  console.log(`caps: max_usd=${opts.maxUsd}  concurrency=${opts.concurrency}\n`);

  const results: Result[] = [];
  let spent = 0, capped = false, idx = 0;
  async function worker() {
    while (true) {
      const my = idx++;
      if (my >= cells.length) return;
      if (spent >= opts.maxUsd) { results.push({ ...cells[my], firstClean: false, finalClean: false, iterations: 0, status: "CAPPED", residual: [], subject: "", body: "", costUsd: 0, baselineUsd: 0, models: [] }); capped = true; continue; }
      const r = await runCellHeal(cells[my].lang, cells[my].vertical, opts.stage, opts.baselineModel);
      spent += r.costUsd;
      results.push(r);
      const flag = NON_LATIN.has(r.lang) ? "*" : " ";
      const note = r.status === "HEALED" ? ` (fixed in ${r.iterations} rewrite${r.iterations > 1 ? "s" : ""})`
        : r.status === "HUMANIZED" ? ` (cleared by humanizer)`
        : r.status === "STILL-FAILING" ? `  ${r.residual.join(" | ")}` : "";
      console.log(`${(r.lang + flag).padEnd(7)} ${r.vertical.padEnd(13)} ${r.status.padEnd(13)} $${r.costUsd.toFixed(4)}${note}`);
    }
  }
  await Promise.all(Array.from({ length: opts.concurrency }, () => worker()));

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const md = results.filter((r) => r.body).map((r) =>
    `## ${r.lang} / ${r.vertical} — ${r.status}${r.status === "HEALED" ? ` (${r.iterations} rewrite${r.iterations > 1 ? "s" : ""})` : ""}\n\n**Subject:** ${r.subject}\n\n${r.body}\n${r.residual.length && r.status === "STILL-FAILING" ? `\n> residual: ${r.residual.join(" | ")}\n` : ""}`,
  ).join("\n\n---\n\n");
  writeFileSync(`emails-healed-${ts}.md`, `# Full-chain heal smoke — ${ts}\n\n${md}\n`, "utf8");
  writeFileSync("emails-healed.md", `# Full-chain heal smoke — ${ts}\n\n${md}\n`, "utf8");

  const cleanFirst = results.filter((r) => r.status === "CLEAN-FIRST").length;
  const healed = results.filter((r) => r.status === "HEALED").length;
  const humanized = results.filter((r) => r.status === "HUMANIZED").length;
  const stillFailing = results.filter((r) => r.status === "STILL-FAILING");
  const errors = results.filter((r) => r.status === "ERROR").length;
  const shipClean = cleanFirst + healed + humanized;

  console.log(`\n${"-".repeat(64)}`);
  console.log(`cells: ${results.length}`);
  console.log(`  clean on first draft:        ${cleanFirst}`);
  console.log(`  fixed by the heal loop:      ${healed}`);
  console.log(`  cleared by the humanizer:    ${humanized}   (dashes / closing lines production strips before send)`);
  console.log(`  SHIP CLEAN (all of the above): ${shipClean} / ${results.length}`);
  console.log(`  still failing after ${MAX_HEAL} rewrites + humanizer: ${stillFailing.length}   (genuine ship risks)`);
  if (errors) console.log(`  errors: ${errors}`);
  // ---- cost, and what the same work would have cost on the old rate card ----
  const baselineSpent = results.reduce((sum, r) => sum + r.baselineUsd, 0);
  const perShipped = shipClean ? spent / shipClean : 0;
  const baselinePerShipped = shipClean ? baselineSpent / shipClean : 0;
  const savedPct = baselineSpent > 0 ? (1 - spent / baselineSpent) * 100 : 0;

  console.log(`\nspend:                 $${spent.toFixed(4)} of $${opts.maxUsd} cap`);
  console.log(`  per SHIPPED email:   $${perShipped.toFixed(6)}`);
  console.log(`  same tokens on ${opts.baselineModel}: $${baselineSpent.toFixed(4)}  ($${baselinePerShipped.toFixed(6)} per shipped email)`);
  console.log(`  => ${savedPct.toFixed(1)}% cheaper than the ${opts.baselineModel} rate card`);
  console.log(
    `  (identical prompts and identical call counts, only the price list differs.\n` +
    `   It does NOT model whether ${opts.baselineModel} would have needed fewer\n` +
    `   heal iterations — compare the SHIP CLEAN line against that model's own run.)`,
  );

  // Which tiers actually served, so a run that quietly fell onto a dearer tier
  // is visible in the cost line rather than only in the logs.
  const tierCounts = new Map<string, number>();
  for (const r of results) {
    for (const m of r.models) {
      const model = m.split("=")[1] ?? m;
      tierCounts.set(model, (tierCounts.get(model) ?? 0) + 1);
    }
  }
  if (tierCounts.size) {
    console.log(`\nmodels that served:`);
    for (const [model, n] of [...tierCounts.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(4)}  ${model}`);
    }
  }

  console.log(`\nemails archived to emails-healed-${ts}.md (and emails-healed.md)`);
  if (stillFailing.length) {
    console.log(`\nstill failing (read these in emails-healed.md):`);
    for (const r of stillFailing) console.log(`  ${r.lang}/${r.vertical}: ${r.residual.join(" | ")}`);
  }

  const hardFail = stillFailing.length > 0 || errors > 0;
  console.log(`\n${hardFail ? "HEAL SMOKE: ship risks found" : capped ? "HEAL SMOKE INCOMPLETE (cost cap)" : "HEAL SMOKE PASS — everything ships clean"} — ${shipClean}/${results.length} clean\n`);
  process.exit(hardFail ? 1 : capped ? 2 : 0);
}

main().catch((e) => { console.error("fatal:", e instanceof Error ? e.message : e); process.exit(1); });
