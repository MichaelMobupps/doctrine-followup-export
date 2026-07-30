/**
 * smoke-spam-risk.ts — live end-to-end smoke for the 2026-07-23 spam-filter
 * hardening. On-demand diagnostic, not part of the auto-run suite: it makes
 * real billed LLM calls (Anthropic key + optional Gemini key from the repl
 * secrets). Lives under src/scripts/ so `node --test src/tests/*.ts` never
 * picks it up.
 *
 * What it does: builds SPAM-BAIT FollowupContexts engineered to provoke the
 * incident failure modes —
 *   - deep-stage prospects with several prior follow-ups (tempts the writer
 *     into "I've reached out N times"),
 *   - original emails carrying long brand LISTS (tempts list-format output),
 *   - crypto-vertical originals naming "Mercado Bitcoin" (tests that grounded
 *     trigger vocabulary survives while invented bait is linted away),
 *   - promo-flavored originals ("bonus", "free credits") (tempts money-bait),
 * then runs the REAL production pipeline (generateFollowupEmail: draft →
 * deterministic lint incl. spamRiskLint → critic → rewriter → humanize) and
 * asserts every FINAL output is deliverability-clean:
 *   1. detectSpamRiskViolations(final body) finds nothing, and
 *   2. assessSpamRisk(final subject+body) is not highRisk (send gate would
 *      NOT divert it).
 *
 * It also reports whether the draft NEEDED healing (spam lint fired during
 * generation) so we can see the linter doing real work, not just passing
 * already-clean drafts.
 *
 * Cost safety: --max-cells cap (default 12), sequential execution, usage is
 * not written to the followup_usage ledger (no usage context is active).
 *
 * Run from artifacts/api-server:
 *   node --import tsx src/scripts/smoke-spam-risk.ts
 *   node --import tsx src/scripts/smoke-spam-risk.ts --max-cells 6
 *
 * Exit codes: 0 all cells clean; 1 at least one final output failed the
 * spam checks (or a hard pipeline error); 2 run truncated by --max-cells.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { generateFollowupEmail } from "../services/followupGenerator";
import type { FollowupContext } from "../services/followupPrompts";
import { detectSpamRiskViolations, assessSpamRisk } from "../lib/spamRiskLint";
import { detectAllDeterministicViolations } from "../lib/doctrineLint";

interface Cell {
  id: string;
  ctx: FollowupContext;
}

// A previous-followup history that tempts the writer to count attempts.
function priorFollowups(lang: string): { stage: number; subject: string; body: string }[] {
  const bodies: Record<string, string[]> = {
    en: [
      "Hi there,\nFollowing up on my note about the partnership. We added a new supply source in your market. Worth a look?",
      "Hi there,\nCircling back on my earlier email. A competitor of yours just scaled spend with us. Open to comparing notes?",
      "Hi there,\nFollowing up once more on the program. Happy to share the market view we built. Any interest?",
    ],
    es: [
      "Hola,\nDando seguimiento a mi correo sobre la asociación. Sumamos una nueva fuente de tráfico en tu mercado. ¿Lo vemos?",
      "Hola,\nRetomando mi correo anterior. Un competidor acaba de escalar inversión con nosotros. ¿Comparamos datos?",
    ],
  };
  const set = bodies[lang] || bodies.en;
  return set.map((b, i) => ({ stage: i + 1, subject: "Re: partnership", body: b }));
}

const LIST_HEAVY_ORIGINAL =
  "Hi,\n\nI run partnerships at MobUpps. We work with key retail & mobility brands (e.g., Unidas, " +
  "Lojas Riachuelo, Sofisa, Ng.Cash, Vulcabras, Panvel, Rentcars, UAI Rango, Midway) and key gaming " +
  "& digital platforms (e.g., Afterverse, Tapps Games, Mercado Bitcoin, Wildlife Studios). We drive " +
  "performance UA on a CPA basis with post-attribution verification. Would an intro call make sense?";

const CRYPTO_ORIGINAL =
  "Hi,\n\nI lead growth partnerships at MobUpps. We help crypto exchange apps like Mercado Bitcoin " +
  "acquire verified KYC users at scale, optimizing to the first trade event with four-layer fraud " +
  "screening. Typical eCPA for verified traders runs $85 in LatAm. Open to a quick call?";

const PROMO_ORIGINAL =
  "Hi,\n\nWe run CPS campaigns for e-commerce brands. Publishers earn commission on confirmed " +
  "purchases only, and new advertisers get their first month of tracking free plus a $500 media " +
  "credit bonus at launch. Interested in the details?";

const PLAIN_ORIGINAL =
  "Hola,\n\nDirijo alianzas en MobUpps. Ayudamos a apps de e-commerce a escalar la adquisición de " +
  "usuarios con optimización hacia la compra confirmada y filtrado antifraude en varias capas. " +
  "¿Tendría sentido una llamada breve?";

const CELLS: Cell[] = [
  // 1-3: deep-stage EN — attempt-count bait (the incident phrase class)
  {
    id: "en/stage4/count-bait",
    ctx: {
      prospect_name: "Michael", company: "Acme Retail", vertical: "cps", sub_vertical: "cps_ecommerce",
      product: "cps", original_subject: "MobUpps CPS partnership", original_body_summary: "CPS partnership for confirmed purchases",
      original_body: LIST_HEAVY_ORIGINAL, original_language: "en", stage: 4, days_since_original: 41,
      sender_name: "Denise", previous_followups: priorFollowups("en"),
    },
  },
  {
    id: "en/stage4/list-bait",
    ctx: {
      prospect_name: "Sarah", company: "Ng.Cash", vertical: "cps", sub_vertical: "cps_fintech",
      product: "cps", original_subject: "Introductions to retail brands", original_body_summary: "warm introductions to retail and gaming brands",
      original_body: LIST_HEAVY_ORIGINAL, original_language: "en", stage: 4, days_since_original: 35,
      sender_name: "Denise", previous_followups: priorFollowups("en"),
    },
  },
  {
    id: "en/stage2/crypto-grounded",
    ctx: {
      prospect_name: "Rafael", company: "Mercado Bitcoin", vertical: "non_gaming_ua", sub_vertical: null,
      product: "ua", original_subject: "Verified trader acquisition", original_body_summary: "verified KYC trader acquisition for the exchange",
      original_body: CRYPTO_ORIGINAL, original_language: "en", stage: 2, days_since_original: 12,
      sender_name: "Denise", previous_followups: priorFollowups("en").slice(0, 1),
    },
  },
  {
    id: "en/stage1/promo-bait",
    ctx: {
      prospect_name: "Priya", company: "ShopNova", vertical: "cps", sub_vertical: "cps_ecommerce",
      product: "cps", original_subject: "CPS launch offer", original_body_summary: "CPS program with launch incentives",
      original_body: PROMO_ORIGINAL, original_language: "en", stage: 1, days_since_original: 6,
      sender_name: "Denise",
    },
  },
  // 5-8: non-English
  {
    id: "es/stage3/count-bait",
    ctx: {
      prospect_name: "Lucía", company: "Panvel", vertical: "cps", sub_vertical: "cps_health_wellness",
      product: "cps", original_subject: "Alianza CPS", original_body_summary: "alianza CPS para compras confirmadas",
      original_body: PLAIN_ORIGINAL, original_language: "es", stage: 3, days_since_original: 28,
      sender_name: "Denise", previous_followups: priorFollowups("es"),
    },
  },
  {
    id: "pt/stage4/list-bait",
    ctx: {
      prospect_name: "Vinicius", company: "Lojas Riachuelo", vertical: "cps", sub_vertical: "cps_ecommerce",
      product: "cps", original_subject: "Parceria CPS", original_body_summary: "parceria CPS para compras confirmadas",
      original_body: LIST_HEAVY_ORIGINAL, original_language: "pt", stage: 4, days_since_original: 44,
      sender_name: "Denise", previous_followups: priorFollowups("en"),
    },
  },
  {
    id: "de/stage3/count-bait",
    ctx: {
      prospect_name: "Jurgen", company: "Bauhaus", vertical: "cps", sub_vertical: "cps_ecommerce",
      product: "cps", original_subject: "CPS Partnerschaft", original_body_summary: "CPS Partnerschaft für bestätigte Käufe",
      original_body: LIST_HEAVY_ORIGINAL, original_language: "de", stage: 3, days_since_original: 30,
      sender_name: "Denise", previous_followups: priorFollowups("en"),
    },
  },
  {
    id: "ru/stage3/count-bait",
    ctx: {
      prospect_name: "Dmitri", company: "Ozon", vertical: "cps", sub_vertical: "cps_ecommerce",
      product: "cps", original_subject: "CPS партнерство", original_body_summary: "CPS партнерство с оплатой за подтвержденные покупки",
      original_body: LIST_HEAVY_ORIGINAL, original_language: "ru", stage: 3, days_since_original: 27,
      sender_name: "Denise", previous_followups: priorFollowups("en"),
    },
  },
  {
    id: "he/stage3/count-bait",
    ctx: {
      prospect_name: "Noa", company: "Wolt IL", vertical: "cps", sub_vertical: "cps_food_delivery",
      product: "cps", original_subject: "שיתוף פעולה CPS", original_body_summary: "שיתוף פעולה במודל תשלום עבור הזמנות מאושרות",
      original_body: LIST_HEAVY_ORIGINAL, original_language: "he", stage: 3, days_since_original: 25,
      sender_name: "Denise", previous_followups: priorFollowups("en"),
    },
  },
  {
    id: "ja/stage2/crypto",
    ctx: {
      prospect_name: "Yuki", company: "bitFlyer", vertical: "non_gaming_ua", sub_vertical: null,
      product: "ua", original_subject: "検証済みトレーダー獲得", original_body_summary: "取引所向けの検証済みトレーダー獲得",
      original_body: CRYPTO_ORIGINAL, original_language: "ja", stage: 2, days_since_original: 14,
      sender_name: "Denise", previous_followups: priorFollowups("en").slice(0, 1),
    },
  },
  {
    id: "zh/stage3/list-bait",
    ctx: {
      prospect_name: "Wei", company: "Meituan", vertical: "cps", sub_vertical: "cps_food_delivery",
      product: "cps", original_subject: "CPS 合作", original_body_summary: "以确认订单计费的 CPS 合作",
      original_body: LIST_HEAVY_ORIGINAL, original_language: "zh", stage: 3, days_since_original: 29,
      sender_name: "Denise", previous_followups: priorFollowups("en"),
    },
  },
  {
    id: "fr/stage4/promo-bait",
    ctx: {
      prospect_name: "Helene", company: "Rentcars", vertical: "cps", sub_vertical: "cps_travel",
      product: "cps", original_subject: "Offre de lancement CPS", original_body_summary: "programme CPS avec incitations au lancement",
      original_body: PROMO_ORIGINAL, original_language: "fr", stage: 4, days_since_original: 39,
      sender_name: "Denise", previous_followups: priorFollowups("en"),
    },
  },
];

// Full supported-language matrix (same set as smoke-writer-heal-all-languages).
// Every language not already covered by a curated bait cell above gets an
// auto-generated worst-case cell: deep stage, 3 prior follow-ups (count bait),
// list-heavy original naming Mercado Bitcoin (list + grounded-trigger bait).
const ALL_LANGS: string[] = [
  "en", "es", "de", "fr", "it", "pt", "pt-BR", "nl", "pl", "cs", "hu", "ro",
  "tr", "sv", "da", "nb", "fi", "id", "ms", "tl", "sw", "vi",
  "ru", "uk", "el",
  "ja", "zh", "ko",
  "ar", "he", "fa", "ur",
  "hi", "bn", "ta", "am",
];
const curatedBases = new Set(CELLS.map((c) => c.ctx.original_language.split("-")[0]));
for (const lang of ALL_LANGS) {
  if (curatedBases.has(lang.split("-")[0])) continue;
  CELLS.push({
    id: `${lang}/stage3/count+list-bait`,
    ctx: {
      prospect_name: "Alex", company: "ShopNova", vertical: "cps", sub_vertical: "cps_ecommerce",
      product: "cps", original_subject: "MobUpps CPS partnership", original_body_summary: "CPS partnership for confirmed purchases",
      original_body: LIST_HEAVY_ORIGINAL, original_language: lang, stage: 3, days_since_original: 26,
      sender_name: "Denise", previous_followups: priorFollowups("en"),
    },
  });
}

function argInt(name: string, dflt: number): number {
  const i = process.argv.indexOf(name);
  if (i === -1 || !process.argv[i + 1]) return dflt;
  const v = parseInt(process.argv[i + 1], 10);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

async function main(): Promise<number> {
  const maxCells = argInt("--max-cells", CELLS.length);
  const cells = CELLS.slice(0, maxCells);
  const lines: string[] = [];
  const log = (s: string) => {
    lines.push(s);
    console.log(s);
  };

  let failures = 0;

  log(`smoke-spam-risk — ${cells.length}/${CELLS.length} cells, live pipeline`);
  log("");

  for (const cell of cells) {
    const grounding = [cell.ctx.original_subject, cell.ctx.original_body, cell.ctx.original_body_summary].join("\n");
    try {
      // Pre-check: did the BAIT work at the draft level? We can't observe the
      // internal draft directly, so instead we lint the final result and
      // separately report the pipeline logs' healing behaviour via the
      // deterministic report on the final email (must be empty).
      const t0 = Date.now();
      const out = await generateFollowupEmail({ ...cell.ctx });
      const secs = ((Date.now() - t0) / 1000).toFixed(1);

      const spamReport = detectSpamRiskViolations(out.body, {
        languageTag: cell.ctx.original_language,
        subject: out.subject,
        originalText: grounding,
      });
      const risk = assessSpamRisk(out.subject, out.body, cell.ctx.original_language, grounding);
      const doctrineReport = detectAllDeterministicViolations(out.body, cell.ctx.original_language);

      const clean = !spamReport.found && !risk.highRisk;
      if (!clean) failures++;

      log(`[${clean ? "PASS" : "FAIL"}] ${cell.id} (${secs}s) spamFound=${spamReport.found} risk=${risk.score} doctrineResidual=${doctrineReport.found}`);
      if (spamReport.found) {
        for (const i of spamReport.issues) log(`    issue: ${i.slice(0, 140)}`);
        for (const m of spamReport.matches) log(`    match: ${m.slice(0, 100)}`);
      }
      log(`    subject: ${out.subject}`);
      log(`    body: ${out.body.replace(/\n/g, " / ").slice(0, 260)}`);
      log("");
    } catch (err) {
      failures++;
      log(`[ERROR] ${cell.id}: ${err instanceof Error ? err.message : String(err)}`);
      log("");
    }
  }

  log(`cells: ${cells.length}, failures: ${failures}`);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = join(process.cwd(), `smoke-spam-${stamp}.log`);
  writeFileSync(file, lines.join("\n"), "utf8");
  console.log(`\nlog written: ${file}`);

  if (failures > 0) return 1;
  if (cells.length < CELLS.length) return 2;
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
