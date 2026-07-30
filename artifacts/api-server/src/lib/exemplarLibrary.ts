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
 * Disabled with WRITER_EXEMPLARS=off. Count tunable with WRITER_EXEMPLAR_COUNT
 * (default 2, clamped 1..4).
 */
import { FOLLOWUP_EXEMPLARS, type FollowupExemplar } from "./followupExemplarsData";

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

function renderOne(ex: FollowupExemplar, index: number): string {
  const flags =
    ex.illustrative_flags && ex.illustrative_flags.length > 0
      ? `\nIllustrative figures (these are examples only, do not copy them): ${ex.illustrative_flags.join("; ")}`
      : "";
  return [
    `EXEMPLAR ${index} (language=${ex.language}, vertical=${ex.vertical}, offer=${ex.offer_type}, stage=${ex.stage}, angle: ${ex.angle})`,
    `Subject: ${ex.subject}`,
    `Body: ${ex.body}`,
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
      ].join(" ")
    : [
        "STUDY THESE GOLD-STANDARD FOLLOW-UPS, THEN WRITE YOUR OWN.",
        "They are in the target language and demonstrate the exact register, length,",
        "and doctrine the output must match. Reproduce the PATTERN, never the text:",
        "open with a reference to the prior outreach, restate exactly one proof point,",
        "optionally add one fresh sourced angle, close with one soft question, and use",
        "no sign-off. Write a new email for the prospect below, do not copy or",
        "paraphrase any exemplar sentence.",
      ].join(" ");

  const rendered = exemplars.map((e, i) => renderOne(e, i + 1)).join("\n\n");
  return `${header}\n\n${rendered}\n\nEND OF EXEMPLARS. Now write the actual follow-up for the real prospect described below.`;
}
