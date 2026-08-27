/**
 * smoke-japanese-nativeness.ts — does the JA pipeline write like a native?
 *
 * Grades live Japanese output against the specific defects a native reviewer
 * (Hidenori Terao, MobUpps BD, Aug 2026 — Hidenori.pdf) found in a Japanese
 * email, plus the register rules his rewrite implies.
 *
 * Every check here is DETERMINISTIC — no LLM grades the output — because the
 * point is to measure whether the writing rules land, and using a model to
 * judge that would fold the thing under test into the judge.
 *
 *   J1 KATAKANA-TRANSLITERATION (the headline defect). An acronym or company
 *      name spelled out phonetically: エーピーエスフライヤー for AppsFlyer,
 *      ディーサーティ for D30, エスツーエス for s2s. A native stops reading at these.
 *   J2 SALUTATION COMMA. "NAME様," — the English "Hi Alex," shape imported into
 *      Japanese, which all 39 stored exemplars used to teach.
 *   J3 REGISTER 当社. Outbound sales is written in 謙譲語, so our own company is
 *      弊社, never the neutral 当社.
 *   J4 REGISTER 貴社. 貴社 is for written documents; email uses 御社.
 *   J5 WRONG APOLOGY. 突然のご連絡 ("sudden contact") in a FOLLOW-UP is wrong on
 *      the facts and contradicts the follow-up reference in the same opening.
 *
 * TWO NUMBERS, AND THE DIFFERENCE BETWEEN THEM IS THE POINT
 *
 * Each cell is graded twice:
 *
 *   RAW      what the writer produced, before the deterministic layer. This is
 *            the writer's true tendency and the honest measure of whether the
 *            PROMPT rules land.
 *   SHIPPED  after applyJapaneseRegister, which is what the recipient sees.
 *
 * Only SHIPPED can fail the run — it is what actually goes out. RAW is reported
 * because a rising raw rate is the early warning that a prompt rule has stopped
 * working, and it would be invisible if the deterministic layer silently
 * absorbed it. When RAW > 0 and SHIPPED = 0, the safety net is doing exactly
 * the job it was added for.
 *
 * SAFE: runs outside a usage context and suppresses the ledger, so nothing
 * reaches followup_usage. Uses the real writer waterfall.
 *
 * RUN (from artifacts/api-server):
 *   node --import tsx src/scripts/smoke-japanese-nativeness.ts
 *   node --import tsx src/scripts/smoke-japanese-nativeness.ts --cells 9 --full-pipeline
 *
 * Exit codes: 0 no J1-J5 defect found; 1 at least one defect.
 */
import { runWriter, writerRole } from "../services/writerProvider";
import { generateFollowupEmail } from "../services/followupGenerator";
import { __setLedgerSuppressedForOfflineRuns } from "../lib/usageTracker";
import {
  getFollowupSystemPrompt,
  getFollowupUserPrompt,
  type FollowupContext,
} from "../services/followupPrompts";
import { UNTRUSTED_DATA_SYSTEM_CLAUSE } from "../lib/promptInjection";
import { buildWriterExemplarBlock } from "../lib/exemplarLibrary";
import { buildWriterCompetitorBlock } from "../lib/competitorLibrary";
import { applyJapaneseRegister } from "../lib/japaneseRegister";
import { logger } from "../lib/logger";

/**
 * Phonetic katakana spellings of things that must stay in Latin script. Seeded
 * from the forms the native reviewer actually flagged, then extended across the
 * acronym set the doctrine permits.
 */
const TRANSLITERATIONS: Array<[string, string]> = [
  ["エーピーエスフライヤー", "AppsFlyer"],
  ["アップスフライヤー", "AppsFlyer"],
  ["アプスフライヤー", "AppsFlyer"],
  ["エイジャスト", "Adjust"],
  ["エスツーエス", "s2s"],
  ["ディーセブン", "D7"],
  ["ディーサーティ", "D30"],
  ["ディーワン", "D1"],
  ["エルティーブイ", "LTV"],
  ["エルティービー", "LTV"],
  ["シーピーアイ", "CPI"],
  ["シーピーエー", "CPA"],
  ["シーピーエム", "CPM"],
  ["シーティーアール", "CTR"],
  ["アールオーエーエス", "ROAS"],
  ["エムエムピー", "MMP"],
  ["エスディーケー", "SDK"],
  ["ケーピーアイ", "KPI"],
  ["エーピーアイ", "API"],
  ["ディーエスピー", "DSP"],
  ["エスエスピー", "SSP"],
  ["アイオーエス", "iOS"],
  ["エーアールピーユー", "ARPU"],
  ["ビーツービー", "B2B"],
];

export interface JaDefect {
  code: string;
  detail: string;
}

export function gradeJapaneseBody(body: string): JaDefect[] {
  const out: JaDefect[] = [];

  for (const [kana, latin] of TRANSLITERATIONS) {
    if (body.includes(kana)) {
      out.push({ code: "J1-TRANSLITERATION", detail: `${kana} should be ${latin}` });
    }
  }
  if (/様[ \t]*[,、，][ \t]*(\r?\n|$)/m.test(body)) {
    out.push({ code: "J2-SALUTATION-COMMA", detail: "様 followed by a comma" });
  }
  if (body.includes("当社")) {
    out.push({ code: "J3-REGISTER", detail: "当社 — outbound sales uses the humble 弊社" });
  }
  if (body.includes("貴社")) {
    out.push({ code: "J4-REGISTER", detail: "貴社 — email uses 御社; 貴社 is for documents" });
  }
  if (/突然のご連絡/.test(body)) {
    out.push({ code: "J5-WRONG-APOLOGY", detail: "突然 (sudden) is first-contact; a follow-up uses 度々/再度" });
  }
  return out;
}

const SEEDS = [
  {
    vertical: "gaming_midcore_hardcore",
    product: "モバイルゲームの課金ユーザー獲得",
    company: "PixelForge Games",
    body: "はじめまして。MobUppsではモバイルゲーム向けの成果報酬型ユーザー獲得を提供しております。CPIおよびCPAキャンペーンを、不正検知付きの準独占的な在庫で運用しております。",
  },
  {
    vertical: "ecommerce",
    product: "CPSレベニューシェア型パートナーシップ",
    company: "ShopNova",
    body: "はじめまして。MobUppsではCPS型のパートナーシップをご提供しております。確定売上ベースのトラッキングと不正検知により、確定した成果に対してのみお支払いいただけます。",
  },
  {
    vertical: "travel_and_booking",
    product: "リターゲティングと再エンゲージメント施策",
    company: "Wanderly Travel",
    body: "はじめまして。MobUppsでは休眠ユーザーの再活性化を目的としたリターゲティングをご提供しております。増分効果を計測しながら配信いたします。",
  },
];

function buildCtx(seed: (typeof SEEDS)[number], stage: number): FollowupContext {
  return {
    prospect_name: "カワマタ",
    company: seed.company,
    vertical: seed.vertical,
    sub_vertical: null,
    product: seed.product,
    original_subject: `MobUpps × ${seed.company}`,
    original_body_summary: `${seed.product}のご案内`,
    original_body: seed.body,
    original_language: "ja",
    stage,
    days_since_original: 5,
    sender_name: "Michael",
  };
}

function parseArgs() {
  const a = process.argv.slice(2);
  const get = (f: string, d: string) => {
    const i = a.indexOf(f);
    return i >= 0 && a[i + 1] ? a[i + 1] : d;
  };
  return { cells: Number(get("--cells", "9")), fullPipeline: a.includes("--full-pipeline") };
}

async function main(): Promise<void> {
  (logger as unknown as { level: string }).level = "warn";
  __setLedgerSuppressedForOfflineRuns(true);
  const opts = parseArgs();

  const cells: Array<{ seed: (typeof SEEDS)[number]; stage: number }> = [];
  for (const stage of [1, 2, 3]) for (const seed of SEEDS) cells.push({ seed, stage });
  const run = cells.slice(0, Math.max(1, opts.cells));

  console.log(
    `\nJapanese nativeness smoke — ${run.length} cells, ${opts.fullPipeline ? "FULL pipeline (critic + heal)" : "writer only"}`,
  );
  console.log("deterministic grading: J1 transliteration, J2 salutation comma, J3/J4 register, J5 wrong apology\n");

  const all: JaDefect[] = [];
  const rawAll: JaDefect[] = [];
  let failed = 0;
  let rawFailed = 0;

  for (const { seed, stage } of run) {
    const ctx = buildCtx(seed, stage);
    try {
      let body: string;
      if (opts.fullPipeline) {
        body = (await generateFollowupEmail(ctx)).body;
      } else {
        const study = [buildWriterCompetitorBlock(ctx), buildWriterExemplarBlock(ctx)]
          .filter(Boolean)
          .join("\n\n");
        const base = getFollowupUserPrompt(ctx);
        const res = await runWriter({
          role: writerRole("draft", false),
          systemParts: [UNTRUSTED_DATA_SYSTEM_CLAUSE, getFollowupSystemPrompt()],
          userPrompt: study ? `${study}\n\n${base}` : base,
          maxOutputTokens: 8192,
          prospectName: ctx.prospect_name,
        });
        body = res.body;
      }
      // In full-pipeline mode the body has already been normalized by
      // humanizeFollowup; applying it again is a no-op (the function is
      // idempotent), which keeps the two modes directly comparable.
      const rawDefects = gradeJapaneseBody(body);
      const shipped = applyJapaneseRegister(body, "ja");
      const shippedDefects = gradeJapaneseBody(shipped);

      rawAll.push(...rawDefects);
      all.push(...shippedDefects);
      if (rawDefects.length) rawFailed++;
      if (shippedDefects.length) failed++;

      const label = `${seed.vertical.slice(0, 18)}/s${stage}`;
      console.log(
        `  ${label.padEnd(22)} raw ${rawDefects.length ? "DEFECT" : "clean "}  ` +
          `shipped ${shippedDefects.length ? "DEFECT" : "clean "}  ` +
          (rawDefects.length ? rawDefects.map((d) => d.code).join(", ") : ""),
      );
      for (const d of shippedDefects) console.log(`      SHIPPED ${d.code}: ${d.detail}`);
      console.log(`      opening: ${JSON.stringify(shipped.split("\n").slice(0, 2).join(" / ").slice(0, 88))}`);
    } catch (err) {
      failed++;
      console.log(
        `  ${seed.vertical}/s${stage} ERROR ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`,
      );
    }
  }

  const tally = (ds: JaDefect[]) => {
    const m = new Map<string, number>();
    for (const d of ds) m.set(d.code, (m.get(d.code) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };

  console.log(`\n${"-".repeat(60)}`);
  console.log(`cells: ${run.length}`);
  console.log(`  RAW writer output   clean ${run.length - rawFailed}/${run.length}   with defects ${rawFailed}`);
  for (const [code, n] of tally(rawAll)) console.log(`      ${String(n).padStart(3)}  ${code}`);
  console.log(`  SHIPPED (what sends) clean ${run.length - failed}/${run.length}   with defects ${failed}`);
  for (const [code, n] of tally(all)) console.log(`      ${String(n).padStart(3)}  ${code}`);

  if (rawFailed > 0 && failed === 0) {
    console.log(
      `\n  The deterministic layer repaired all ${rawFailed} raw defect(s) — that is what it is for.` +
        `\n  A rising RAW number still means a prompt rule is losing its grip; watch it.`,
    );
  }
  console.log(failed === 0 ? "\nJA SMOKE PASS\n" : "\nJA SMOKE FAIL\n");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
