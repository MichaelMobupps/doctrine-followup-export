/**
 * smoke-writer-all-languages.ts — real writer-quality pass across all 36
 * doctrine languages.
 *
 * For every language it generates a follow-up email through the SAME production
 * prompt path the pipeline uses (cachedSystem system prefix + exemplar and
 * competitor blocks + getFollowupUserPrompt), then runs the SAME doctrine and
 * structural lint gates production runs, and archives every email so you can
 * read how it writes in each language. This is a QUALITY check, independent of
 * the cache TTL change (caching never alters output).
 *
 * It uses the Sonnet writer directly (the highest-quality tier and the one
 * grey-area verticals route to), so it needs only ANTHROPIC_API_KEY — no Gemini
 * wiring. As a side effect the run shares one cached prefix across all 36
 * languages, so the usage line will show cache reads climbing: a live proof of
 * the TTL fix.
 *
 * SAFE: bounded by --max-usd (default 8) and --concurrency (default 4). Usage is
 * measured locally only; nothing is written to the production usage ledger.
 *
 * RUN (from artifacts/api-server, where the Anthropic client is configured):
 *   node --import tsx src/scripts/smoke-writer-all-languages.ts
 *   node --import tsx src/scripts/smoke-writer-all-languages.ts --max-usd 12 --verticals gaming_ua,cps,retargeting
 *   node --import tsx src/scripts/smoke-writer-all-languages.ts --dry-run   # offline: build + lint only, no API calls
 *
 * Flags:
 *   --dry-run                 build the prompt and lint a placeholder for every
 *                             language; make NO API calls. Proves the per-language
 *                             prompt path never throws before you spend anything.
 *   --langs en,ja,ar          restrict to a subset (default: all 36).
 *   --verticals gaming_ua,cps representative verticals (default: gaming_ua,cps).
 *   --stage 2                 follow-up stage (default 2).
 *   --max-usd 8               stop launching new cells once spend reaches this.
 *   --concurrency 4           parallel cells.
 *
 * Exit codes: 0 every cell generated and passed lint; 1 a hard failure (an error
 * or a lint gate failure); 2 incomplete because the cost cap stopped the run.
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

// ---- all 36 doctrine languages, across four script families ----
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

// ---- the exact production lint gate (mirrors smoke-writer's lintBody) ----
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
  return { pass: !report.found, issues: report.issues.slice(0, 4) };
}

// ---- the exact production prompt (mirrors generateDraft / runCellCompare) ----
function buildPrompts(ctx: FollowupContext): { system: ReturnType<typeof cachedSystem>; user: string } {
  const exemplarBlock = buildWriterExemplarBlock(ctx);
  const competitorBlock = buildWriterCompetitorBlock(ctx);
  const studyBlock = [competitorBlock, exemplarBlock].filter((b) => b.length > 0).join("\n\n");
  const base = getFollowupUserPrompt(ctx);
  const user = studyBlock ? `${studyBlock}\n\n${base}` : base;
  const system = cachedSystem(UNTRUSTED_DATA_SYSTEM_CLAUSE, getFollowupSystemPrompt());
  return { system, user };
}

function parseSubjectBody(raw: string): { subject: string; body: string } {
  const cleaned = raw.replace(/```json\s*|```/g, "").trim();
  const parsed = JSON.parse(cleaned);
  if (!parsed.subject || !parsed.body) throw new Error("missing subject or body");
  return { subject: String(parsed.subject), body: String(parsed.body) };
}

// Sonnet 4.6 prices ($/MTok): in 3, out 15, cache read 0.30, 1h write 6.
function estCostUsd(u: any): number {
  const inp = (u?.input_tokens ?? 0) / 1e6 * 3;
  const out = (u?.output_tokens ?? 0) / 1e6 * 15;
  const read = (u?.cache_read_input_tokens ?? 0) / 1e6 * 0.3;
  const write = (u?.cache_creation_input_tokens ?? 0) / 1e6 * 6;
  return inp + out + read + write;
}

// ---- args ----
function parseArgs() {
  const a = process.argv.slice(2);
  const get = (flag: string, dflt: string) => {
    const i = a.indexOf(flag);
    return i >= 0 && a[i + 1] ? a[i + 1] : dflt;
  };
  return {
    dryRun: a.includes("--dry-run"),
    langs: get("--langs", "").trim() ? get("--langs", "").split(",").map((s) => s.trim()) : ALL_LANGS,
    verticals: get("--verticals", "gaming_ua,cps").split(",").map((s) => s.trim()),
    stage: Number(get("--stage", "2")),
    maxUsd: Number(get("--max-usd", "8")),
    concurrency: Math.max(1, Number(get("--concurrency", "4"))),
  };
}

interface Result {
  lang: string;
  vertical: string;
  status: "PASS" | "FAIL" | "ERROR" | "CAPPED";
  lintPass: boolean;
  issues: string[];
  subject: string;
  body: string;
  costUsd: number;
  cacheRead: number;
  cacheWrite: number;
}

async function runCell(lang: string, vertical: string, stage: number, dryRun: boolean): Promise<Result> {
  const ctx = buildCtx(lang, vertical, stage);
  const { system, user } = buildPrompts(ctx);

  if (dryRun) {
    // Offline: prove the per-language prompt path and the lint gate execute
    // without throwing. We do NOT judge a fake body — we just exercise the
    // wiring. lintPass is reported as n/a (true) because there is no real email.
    lintBody("probe", ctx); // exercise the lint code path; ignore the verdict
    const sysChars = system.map((b: any) => b.text.length).reduce((x: number, y: number) => x + y, 0);
    return {
      lang, vertical, status: "PASS", lintPass: true, issues: [],
      subject: "(dry-run)", body: `built: sys=${sysChars} user=${user.length} chars`,
      costUsd: 0, cacheRead: 0, cacheWrite: 0,
    };
  }

  try {
    const resp = await withAnthropicRetry(
      () => anthropic.messages.create({
        model: MODEL_DRAFT_GENERATOR,
        max_tokens: 8192,
        system,
        messages: [{ role: "user", content: user }],
      }),
      { label: `all-langs:${lang}:${vertical}` },
    );
    const usage: any = (resp as any).usage ?? {};
    const textBlock = resp.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") throw new Error("no text block");
    const { subject, body } = parseSubjectBody(textBlock.text);
    const lint = lintBody(body, ctx);
    return {
      lang, vertical,
      status: lint.pass ? "PASS" : "FAIL",
      lintPass: lint.pass, issues: lint.issues, subject, body,
      costUsd: estCostUsd(usage),
      cacheRead: usage.cache_read_input_tokens ?? 0,
      cacheWrite: usage.cache_creation_input_tokens ?? 0,
    };
  } catch (err) {
    return {
      lang, vertical, status: "ERROR", lintPass: false,
      issues: [err instanceof Error ? err.message : String(err)],
      subject: "", body: "", costUsd: 0, cacheRead: 0, cacheWrite: 0,
    };
  }
}

async function main() {
  const opts = parseArgs();
  const cells: Array<{ lang: string; vertical: string }> = [];
  for (const lang of opts.langs) for (const v of opts.verticals) cells.push({ lang, vertical: v });

  console.log(`\nAll-languages writer smoke ${opts.dryRun ? "(DRY RUN — no API calls)" : "(LIVE — billed calls)"}`);
  console.log(`languages=${opts.langs.length}  verticals=${opts.verticals.join(",")}  stage=${opts.stage}  cells=${cells.length}`);
  if (!opts.dryRun) console.log(`caps: max_usd=${opts.maxUsd}  concurrency=${opts.concurrency}\n`);

  const results: Result[] = [];
  let spent = 0;
  let capped = false;
  let idx = 0;

  async function worker() {
    while (true) {
      const myIdx = idx++;
      if (myIdx >= cells.length) return;
      if (!opts.dryRun && spent >= opts.maxUsd) {
        results.push({ ...cells[myIdx], status: "CAPPED", lintPass: false, issues: [], subject: "", body: "", costUsd: 0, cacheRead: 0, cacheWrite: 0 });
        capped = true;
        continue;
      }
      const r = await runCell(cells[myIdx].lang, cells[myIdx].vertical, opts.stage, opts.dryRun);
      spent += r.costUsd;
      results.push(r);
      const flag = NON_LATIN.has(r.lang) ? "*" : " ";
      if (opts.dryRun) {
        console.log(`${(r.lang + flag).padEnd(7)} ${r.vertical.padEnd(13)} ${r.status.padEnd(6)} ${r.body}`);
      } else {
        const cacheNote = r.cacheRead > 0 ? ` cache_read=${r.cacheRead}` : r.cacheWrite > 0 ? ` cache_write=${r.cacheWrite}` : "";
        console.log(
          `${(r.lang + flag).padEnd(7)} ${r.vertical.padEnd(13)} ${r.status.padEnd(6)} ` +
            `lint=${r.lintPass ? "PASS" : "FAIL"} $${r.costUsd.toFixed(4)}${cacheNote}` +
            `${r.issues.length ? `  ${r.issues.join(" | ")}` : ""}`,
        );
      }
    }
  }
  await Promise.all(Array.from({ length: opts.concurrency }, () => worker()));

  // ---- archive every email so you can read how it writes ----
  if (!opts.dryRun) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const md = results
      .filter((r) => r.body)
      .map((r) => `## ${r.lang} / ${r.vertical} — ${r.status} (lint ${r.lintPass ? "PASS" : "FAIL"})\n\n**Subject:** ${r.subject}\n\n${r.body}\n${r.issues.length ? `\n> issues: ${r.issues.join(" | ")}\n` : ""}`)
      .join("\n\n---\n\n");
    const file = `emails-all-langs-${ts}.md`;
    writeFileSync(file, `# All-languages writer smoke — ${ts}\n\n${md}\n`, "utf8");
    writeFileSync("emails-all-langs.md", `# All-languages writer smoke — ${ts}\n\n${md}\n`, "utf8");
    console.log(`\nEmails archived to ${file} (and emails-all-langs.md)`);
  }

  // ---- summary ----
  const pass = results.filter((r) => r.status === "PASS").length;
  const fail = results.filter((r) => r.status === "FAIL").length;
  const err = results.filter((r) => r.status === "ERROR").length;
  const cap = results.filter((r) => r.status === "CAPPED").length;
  const totalRead = results.reduce((a, r) => a + r.cacheRead, 0);
  const totalWrite = results.reduce((a, r) => a + r.cacheWrite, 0);

  console.log(`\n${"-".repeat(60)}`);
  console.log(`cells: ${results.length}   PASS ${pass}   FAIL ${fail}   ERROR ${err}   CAPPED ${cap}`);
  if (!opts.dryRun) {
    console.log(`spend: $${spent.toFixed(4)} of $${opts.maxUsd} cap`);
    console.log(`cache: read=${totalRead} tok  write=${totalWrite} tok  (reads >> writes means the 1h cache is working)`);
  }
  const failingLangs = [...new Set(results.filter((r) => r.status === "FAIL" || r.status === "ERROR").map((r) => `${r.lang}/${r.vertical}`))];
  if (failingLangs.length) console.log(`needs a look: ${failingLangs.join(", ")}`);

  const hardFail = fail > 0 || err > 0;
  const verdict = hardFail ? "SMOKE FAIL" : capped ? "SMOKE INCOMPLETE (cost cap)" : "SMOKE PASS";
  console.log(`\n${verdict} — ${pass}/${results.length} clean\n`);
  process.exit(hardFail ? 1 : capped ? 2 : 0);
}

main().catch((e) => {
  console.error("fatal:", e instanceof Error ? e.message : e);
  process.exit(1);
});
