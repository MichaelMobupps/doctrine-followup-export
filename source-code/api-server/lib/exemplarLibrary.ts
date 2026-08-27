/**
 * Follow-up exemplar retrieval and few-shot block construction.
 *
 * Purpose: lift the writing quality of the cheaper writer tiers (Gemini Flash,
 * Gemini Pro) toward the Sonnet/Opus bar by showing the model a small set of
 * gold-standard, doctrine-compliant follow-ups that match the prospect's
 * language, vertical, offer type, and stage. The same block is added to the
 * Sonnet tier as well, so the change can only raise quality, never lower it.
 *
 * The exemplars are embedded in followupExemplarsData.ts. This module ranks
 * them for a given context and renders a compact study block for the prompt.
 *
 * Selection policy:
 *   1. Prefer exemplars in the SAME language. Native exemplars are the strongest
 *      signal because the doctrine's nativeness rules are language-specific.
 *   2. Within a language, rank by vertical match, then offer-type match, then
 *      stage proximity.
 *   3. If no same-language exemplar exists, fall back to the best vertical /
 *      stage matches in ANY language, rendered as STRUCTURE-ONLY references with
 *      an explicit instruction to copy the shape and write natively in the
 *      target language. This still teaches the doctrine pattern without pushing
 *      wrong-language text.
 *
 * The block is framed as study material: reproduce the pattern, never copy the
 * text. It carries each exemplar's register_notes, which state exactly why the
 * exemplar is compliant.
 *
 * LAYOUT (2026-08-26). The stored exemplar bodies teach the wrong SHAPE: of
 * the 1272 in followupExemplarsData.ts, 1209 are a greeting plus one
 * undifferentiated block, 54 have no line break at all, and 9 contain a blank
 * line. That is the single strongest reason the writer kept producing walls of
 * text — a prompt rule asking for paragraph breaks was arguing with 1209
 * counter-examples. The bodies are therefore re-shaped HERE, at render time,
 * rather than in the data file, whose header states it is generated from
 * Followupper_exemplars_widened.jsonl and must not be hand-edited. Each
 * exemplar in a block gets a DIFFERENT layout profile, so the few-shot set
 * demonstrates the variation the LAYOUT directive asks for instead of one
 * repeated shape. Only whitespace changes; the wording, register and doctrine
 * content of every exemplar are untouched.
 *
 * Disabled with WRITER_EXEMPLARS=off. Count tunable with WRITER_EXEMPLAR_COUNT
 * (default 2, clamped 1..4).
 */
import { FOLLOWUP_EXEMPLARS, type FollowupExemplar } from "./followupExemplarsData";
import { shapeFollowupBody, LAYOUT_PROFILES } from "./layoutShaper";
import { applyJapaneseRegister } from "./japaneseRegister";

export interface ExemplarContext {
  vertical?: string | null;
  sub_vertical?: string | null;
  product?: string | null;
  original_language?: string | null;
  stage?: number | null;
}

export interface SelectedExemplars {
  exemplars: FollowupExemplar[];
  // true when no same-language exemplar was found and the selection is a
  // cross-language structure reference rather than a native sample.
  structureOnly: boolean;
}

export function exemplarsEnabled(): boolean {
  return (process.env.WRITER_EXEMPLARS || "on").toLowerCase() !== "off";
}

function exemplarCount(): number {
  const n = Number(process.env.WRITER_EXEMPLAR_COUNT);
  if (!Number.isFinite(n)) return 2;
  return Math.max(1, Math.min(4, Math.floor(n)));
}

function langOf(ctx: ExemplarContext): string {
  return (ctx.original_language || "en").toLowerCase();
}

// Map the runtime vertical taxonomy (gaming_ua, non_gaming_ua, cps, retargeting
// plus cps_* sub-verticals) and free product text onto the exemplar vertical
// vocabulary (sports_betting, ecommerce, health_and_fitness,
// gaming_midcore_hardcore, ...). The match is fuzzy and additive: any token
// overlap counts. Returns a normalized token bag for scoring.
function verticalTokens(ctx: ExemplarContext): string[] {
  const parts = [ctx.vertical, ctx.sub_vertical, ctx.product]
    .map((p) => (p || "").toLowerCase())
    .join(" ");
  const tokens = parts
    .replace(/cps_/g, " ")
    .split(/[^a-z]+/)
    .filter((t) => t.length >= 3);
  return Array.from(new Set(tokens));
}

function offerTokens(ctx: ExemplarContext): string[] {
  const parts = [ctx.product, ctx.vertical]
    .map((p) => (p || "").toLowerCase())
    .join(" ");
  return Array.from(new Set(parts.split(/[^a-z]+/).filter((t) => t.length >= 2)));
}

// Explicit bridge from the RUNTIME vertical taxonomy onto the exemplar vertical
// vocabulary. The runtime classifier (lib/verticalClassifier.ts) only ever emits
// non_gaming_ua | gaming_ua | cps | retargeting, plus the cps_* sub_verticals —
// NONE of which equals an exemplar vertical string. Without this map the fuzzy
// token scorer below mis-fires on the two most common inputs: "non_gaming_ua"
// tokenizes to ["non","gaming"] and the stray "gaming" token pulls
// sports_betting / gaming exemplars for a NON-gaming prospect, and every
// "retargeting" context used to be bridged to health_and_fitness. This table
// translates the real inputs to the correct exemplar vertical so same-language
// selection also lands on the right vertical. Keys are checked sub_vertical
// first, then vertical; an unrecognized value (e.g. an already-exemplar-vocab
// vertical passed by a test or future caller) falls through to the fuzzy logic.
const RUNTIME_VERTICAL_TO_EXEMPLAR: Record<string, string[]> = {
  // cps_* sub-verticals carry the real vertical signal.
  cps_ecommerce: ["ecommerce"],
  cps_fintech: ["fintech_banking_and_payments"],
  cps_classifieds: ["classifieds"],
  cps_travel: ["travel_and_booking"],
  cps_food_delivery: ["food_and_delivery"],
  cps_subscription: ["subscription_media"],
  cps_education: ["education"],
  cps_health_wellness: ["health_and_fitness"],
  cps_utilities_telco: ["utility_and_productivity", "telecom"],
  cps_real_estate: ["real_estate_proptech"],
  cps_dating_social: ["social_and_dating"],
  cps_gaming_iap: ["gaming_midcore_hardcore"],
  // Top-level runtime verticals.
  gaming_ua: ["gaming_midcore_hardcore", "gaming_casual"],
  cps: ["ecommerce"], // bare CPS (null sub_vertical) is overwhelmingly ecommerce
  // Generic, non-vertical inputs: bias to the broadest B2C vertical and
  // explicitly NOT gaming / gambling. non_gaming_ua is the most common prospect.
  non_gaming_ua: ["ecommerce"],
  retargeting: ["ecommerce"],
};

// Resolve the mapped exemplar verticals for a context, sub_vertical first.
function mappedExemplarVerticals(ctx: ExemplarContext): string[] {
  const sub = (ctx.sub_vertical || "").toLowerCase();
  const vert = (ctx.vertical || "").toLowerCase();
  return RUNTIME_VERTICAL_TO_EXEMPLAR[sub] || RUNTIME_VERTICAL_TO_EXEMPLAR[vert] || [];
}

function scoreExemplar(ex: FollowupExemplar, ctx: ExemplarContext): number {
  let score = 0;

  // Language is the dominant signal.
  if (ex.language.toLowerCase() === langOf(ctx)) score += 100;

  // Explicit runtime->exemplar vertical map. This is the authoritative vertical
  // signal for real production inputs and is weighted above the maximum the
  // fuzzy token bridge below can reach (~62), so a mapped context lands on the
  // correct vertical rather than on whatever the token soup happens to hit. The
  // fuzzy logic stays as the fallback for unmapped (already-exemplar-vocab)
  // inputs. Kept below the language weight so it never overrides same-language.
  const mapped = mappedExemplarVerticals(ctx);
  if (mapped.length > 0 && mapped.includes(ex.vertical.toLowerCase())) {
    score += 80;
  }

  // Vertical token overlap. Both the exemplar vertical and its rule_pack count.
  const vt = verticalTokens(ctx);
  const exVert = `${ex.vertical} ${ex.rule_pack}`.toLowerCase();
  for (const t of vt) {
    if (exVert.includes(t)) score += 12;
  }
  // Direct semantic bridges between the two taxonomies.
  const bridge: Record<string, string[]> = {
    sports_betting: ["betting", "sport", "sportsbook", "gaming", "ua"],
    ecommerce: ["ecommerce", "commerce", "retail", "cps", "shop", "purchase"],
    health_and_fitness: ["health", "fitness", "wellness"],
    gaming_midcore_hardcore: ["gaming", "game", "midcore", "hardcore", "iap", "ua"],
  };
  const bridges = bridge[ex.vertical] || [];
  for (const t of vt) {
    if (bridges.includes(t)) score += 8;
  }

  // Offer-type overlap (ua / cps / retargeting).
  const ot = offerTokens(ctx);
  if (ot.includes(ex.offer_type.toLowerCase())) score += 20;

  // Stage proximity. Exact match is best; adjacent stages still teach the arc.
  const stage = ctx.stage ?? 1;
  const diff = Math.abs((ex.stage ?? 1) - stage);
  score += Math.max(0, 10 - diff * 4);

  return score;
}

/**
 * Rank and select the best exemplars for a context.
 */
export function selectExemplars(ctx: ExemplarContext): SelectedExemplars {
  const all = FOLLOWUP_EXEMPLARS;
  if (all.length === 0) return { exemplars: [], structureOnly: false };

  const lang = langOf(ctx);
  const sameLang = all.filter((e) => e.language.toLowerCase() === lang);
  const pool = sameLang.length > 0 ? sameLang : all;
  const structureOnly = sameLang.length === 0;

  const ranked = [...pool]
    .map((e) => ({ e, s: scoreExemplar(e, ctx) }))
    .sort((a, b) => b.s - a.s);

  // Prefer variety of angle/stage among the top picks so the few-shot set
  // shows more than one move. De-duplicate by id defensively.
  const want = exemplarCount();
  const picked: FollowupExemplar[] = [];
  const seen = new Set<string>();
  for (const { e } of ranked) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    picked.push(e);
    if (picked.length >= want) break;
  }

  return { exemplars: picked, structureOnly };
}

// ---------------------------------------------------------------------------
// Japanese exemplar normalization (native review, Aug 2026).
// ---------------------------------------------------------------------------

/**
 * Repair the Japanese exemplars at render time.
 *
 * WHY HERE AND NOT IN THE DATA FILE
 *
 * followupExemplarsData.ts states it is generated from
 * Followupper_exemplars_widened.jsonl and must not be hand-edited — and that
 * JSONL is not in this repo, so a direct edit would be silently lost the next
 * time the file is regenerated. This module already fixes a data-level defect
 * the same way: every stored body is re-shaped through the layout profiles
 * because 1209 of the 1272 bodies taught the wrong SHAPE. These JA repairs
 * follow that precedent, so they survive regeneration.
 *
 * WHAT IS WRONG WITH THE STORED JA EXEMPLARS
 *
 * A native review (Hidenori Terao, MobUpps BD, Aug 2026) identified register and
 * punctuation errors that the stored exemplars actively teach. Measured across
 * all 39 JA exemplars:
 *
 *   - 39/39 open "NAME様," with an ASCII COMMA. Japanese does not punctuate a
 *     salutation; this is the English "Hi Alex," shape imported wholesale, and
 *     39 counter-examples beat any prompt rule asking for the native form.
 *   - 7/39 use 当社 (neutral) where outbound sales requires 弊社 (humble, 謙譲語).
 *     Another 8 already use 弊社, so the set is internally inconsistent — the
 *     writer learns that either is fine.
 *
 * The substitutions live in lib/japaneseRegister.ts, shared with the OUTPUT path
 * so that what the writer is shown and what the writer ships obey one rule.
 * Only register and punctuation are touched: no claim, figure, structure or
 * doctrine content of any exemplar changes.
 */
export function normalizeJapaneseExemplarBody(body: string): string {
  return applyJapaneseRegister(body, "ja");
}

function renderOne(ex: FollowupExemplar, index: number): string {
  const flags =
    ex.illustrative_flags && ex.illustrative_flags.length > 0
      ? `\nIllustrative figures (these are examples only, do not copy them): ${ex.illustrative_flags.join("; ")}`
      : "";
  // Give each exemplar in the block a different shape, so the few-shot set
  // teaches variation rather than one repeated layout. index is 1-based.
  const profile = LAYOUT_PROFILES[(index - 1) % LAYOUT_PROFILES.length];
  // Japanese register/punctuation repairs run BEFORE the layout shaper, because
  // the salutation fix targets the name line the shaper then positions.
  const source = ex.language === "ja" ? normalizeJapaneseExemplarBody(ex.body) : ex.body;
  const body = shapeFollowupBody(source, { profile, languageTag: ex.language });
  // The body is multi-line now, so it gets its own delimited section instead
  // of sitting inline after a "Body:" label where the line breaks would be
  // ambiguous against the surrounding prompt structure.
  return [
    `EXEMPLAR ${index} (language=${ex.language}, vertical=${ex.vertical}, offer=${ex.offer_type}, stage=${ex.stage}, angle: ${ex.angle})`,
    `Subject: ${ex.subject}`,
    `Body:`,
    `<<<`,
    body,
    `>>>`,
    `Why it works: ${ex.register_notes}${flags}`,
  ].join("\n");
}

/**
 * Build the few-shot study block for the writer/rewriter user prompt. Returns
 * an empty string when exemplars are disabled or none rank for the context.
 *
 * The block is prepended to the user prompt (not the cached system prefix) so
 * it never busts the Sonnet system-prompt cache and reaches the Gemini tiers in
 * the same place.
 */
export function buildWriterExemplarBlock(ctx: ExemplarContext): string {
  if (!exemplarsEnabled()) return "";
  const { exemplars, structureOnly } = selectExemplars(ctx);
  if (exemplars.length === 0) return "";

  const header = structureOnly
    ? [
        "STUDY THESE GOLD-STANDARD FOLLOW-UPS (STRUCTURE REFERENCE ONLY).",
        "No native-language exemplar was available for the target language, so the",
        "examples below are in another language. Copy their SHAPE and discipline,",
        "then write your follow-up natively in the required target language. Do NOT",
        "translate or reuse their wording. Reproduce the pattern: open with a",
        "reference to the prior outreach, restate exactly one proof point, optionally",
        "add one fresh sourced angle, close with one soft question, no sign-off.",
        "Reproduce their SHAPE as well: greeting alone on the first line, a blank line",
        "under it, and the body broken into blocks rather than delivered as one",
        "paragraph. Follow the LAYOUT block given for THIS email for the exact",
        "block pattern.",
      ].join(" ")
    : [
        "STUDY THESE GOLD-STANDARD FOLLOW-UPS, THEN WRITE YOUR OWN.",
        "They are in the target language and demonstrate the exact register, length,",
        "and doctrine the output must match. Reproduce the PATTERN, never the text:",
        "open with a reference to the prior outreach, restate exactly one proof point,",
        "optionally add one fresh sourced angle, close with one soft question, and use",
        "no sign-off. Write a new email for the prospect below, do not copy or",
        "paraphrase any exemplar sentence.",
        "Note their SHAPE too: greeting alone on the first line, a blank line under it,",
        "and the body broken into blocks. Each exemplar is broken up differently on",
        "purpose — do not copy one exemplar's block pattern, follow the LAYOUT block",
        "given for THIS email.",
      ].join(" ");

  const rendered = exemplars.map((e, i) => renderOne(e, i + 1)).join("\n\n");
  return `${header}\n\n${rendered}\n\nEND OF EXEMPLARS. Now write the actual follow-up for the real prospect described below.`;
}
