/**
 * volumeCalibration.ts — v4 Round-3 universal volume floor logic.
 *
 * TypeScript port of prospector/core/volume_calibration.py. Same constants,
 * same formula. Used by doctrineLint (deterministic floor check) and
 * followupPrompts (criterion 14 critic guidance).
 */

// ============================================================================
// 1. FUNNEL DEPTH MULTIPLIERS
// ============================================================================

export const FUNNEL_DEPTH_MULTIPLIERS: Readonly<Record<string, number>> = {
  // Top of funnel — install class
  install: 1.0,
  app_install: 1.0,
  installs: 1.0,
  first_open: 1.0,
  registration: 0.8,
  signup: 0.8,
  sign_up: 0.8,
  account_creation: 0.8,
  // Mid funnel — engagement
  d7_retained: 0.4,
  retained_d7_user: 0.4,
  engaged_user: 0.4,
  active_user: 0.4,
  tutorial_complete: 0.5,
  onboarding_complete: 0.5,
  // Mid-deep — conversion
  payer_conversion: 0.15,
  purchase: 0.15,
  completed_order: 0.15,
  completed_booking: 0.15,
  transaction: 0.15,
  // Deep funnel — financial commitment
  first_deposit: 0.10,
  funded_account: 0.10,
  FTD: 0.10,
  FTD_or_qualified_deposit: 0.10,
  qualified_deposit: 0.10,
  // Subscription class
  subscription_start: 0.20,
  paid_trial: 0.20,
  trial_conversion: 0.20,
  paid_subscription: 0.20,
  plan_upgrade: 0.20,
  // Very deep — high commitment
  approved_loan: 0.05,
  approved_loan_or_issued_advance: 0.05,
  issued_advance: 0.05,
  completed_policy_purchase: 0.05,
  policy_purchase: 0.05,
  first_time_depositor: 0.10,
};

export const DEFAULT_FUNNEL_MULTIPLIER = 0.20;

export function getFunnelMultiplier(namedEvent: string | null | undefined): number {
  if (!namedEvent) return DEFAULT_FUNNEL_MULTIPLIER;
  const key = String(namedEvent).trim().toLowerCase().replace(/[\s-]+/g, "_");
  return FUNNEL_DEPTH_MULTIPLIERS[key] ?? DEFAULT_FUNNEL_MULTIPLIER;
}


// ============================================================================
// 2. MARKET SCALE TIERS
// ============================================================================

export const MARKET_SCALE_TIERS: Readonly<Record<string, "S" | "A" | "B" | "C">> = {
  // TIER-S (mega-markets, 15x)
  india: "S", in: "S",
  china: "S", cn: "S",
  indonesia: "S", id: "S",
  "united states": "S", usa: "S", us: "S",
  brazil: "S", br: "S",
  // TIER-A (large markets, 5x)
  mexico: "A", mx: "A",
  pakistan: "A", pk: "A",
  bangladesh: "A", bd: "A",
  nigeria: "A", ng: "A",
  vietnam: "A", vn: "A",
  philippines: "A", ph: "A",
  japan: "A", jp: "A",
  germany: "A", de: "A",
  "united kingdom": "A", uk: "A", gb: "A",
  france: "A", fr: "A",
  egypt: "A", eg: "A",
  russia: "A", ru: "A",
  turkey: "A", tr: "A",
  // TIER-B (mid markets, 2x)
  spain: "B", es: "B",
  italy: "B", it: "B",
  poland: "B", pl: "B",
  korea: "B", "south korea": "B", kr: "B",
  "saudi arabia": "B", sa: "B",
  thailand: "B", th: "B",
  canada: "B", ca: "B",
  australia: "B", au: "B",
  malaysia: "B", my: "B",
  "south africa": "B", za: "B",
  argentina: "B", ar: "B",
  colombia: "B", co: "B",
  ukraine: "B", ua: "B",
  // TIER-C (small/premium markets, 1x)
  singapore: "C", sg: "C",
  israel: "C", il: "C",
  netherlands: "C", nl: "C",
  sweden: "C", se: "C",
  uae: "C", "united arab emirates": "C", ae: "C",
  "hong kong": "C", hk: "C",
  switzerland: "C", ch: "C",
  norway: "C", no: "C",
  belgium: "C", be: "C",
  denmark: "C", dk: "C",
  finland: "C", fi: "C",
  ireland: "C", ie: "C",
  austria: "C", at: "C",
  "new zealand": "C", nz: "C",
  portugal: "C", pt: "C",
  greece: "C", gr: "C",
  chile: "C", cl: "C",
};

export const MARKET_TIER_MULTIPLIERS: Readonly<Record<"S" | "A" | "B" | "C", number>> = {
  S: 15.0,
  A: 5.0,
  B: 2.0,
  C: 1.0,
};

export const DEFAULT_MARKET_TIER: "S" | "A" | "B" | "C" = "B";

export function getMarketTier(market: string | null | undefined): "S" | "A" | "B" | "C" {
  if (!market) return DEFAULT_MARKET_TIER;
  const key = String(market).trim().toLowerCase();
  if (key in MARKET_SCALE_TIERS) return MARKET_SCALE_TIERS[key];
  const firstWord = key.split(",")[0].split("(")[0].trim();
  return MARKET_SCALE_TIERS[firstWord] ?? DEFAULT_MARKET_TIER;
}

export function getMarketMultiplier(market: string | null | undefined): number {
  return MARKET_TIER_MULTIPLIERS[getMarketTier(market)];
}


// ============================================================================
// 3. VERTICAL BASE BANDS
// ============================================================================

export const VERTICAL_BASE_INSTALL_FLOOR: Readonly<Record<string, number>> = {
  hypercasual_gaming: 1500,
  casual_gaming: 1500,
  midcore_gaming: 100,
  hardcore_gaming: 100,
  rpg_gaming: 100,
  strategy_gaming: 100,
  ccg_gaming: 100,
  fintech: 200,
  banking: 200,
  investment: 200,
  lending: 200,
  insurance: 100,
  ecommerce: 300,
  marketplace: 300,
  retail: 300,
  subscription_media: 200,
  streaming: 200,
  social_dating: 300,
  social: 300,
  dating: 300,
  food_qsr: 200,
  food_delivery: 300,
  ride_hailing: 300,
  travel: 200,
  education: 150,
  health_wellness: 150,
  fitness: 150,
  utility: 200,
  auto: 200,
  real_estate: 100,
  telecom: 300,
  crypto: 100,
};

export const DEFAULT_VERTICAL_FLOOR = 100;

export function getVerticalBaseFloor(vertical: string | null | undefined): number {
  if (!vertical) return DEFAULT_VERTICAL_FLOOR;
  const key = String(vertical).trim().toLowerCase().replace(/[\s-]+/g, "_");
  return VERTICAL_BASE_INSTALL_FLOOR[key] ?? DEFAULT_VERTICAL_FLOOR;
}


// ============================================================================
// 4. FLOOR COMPUTATION
// ============================================================================

export const SAFETY_FACTOR = 0.5;

export function computeVolumeFloor(
  market: string | null | undefined,
  vertical: string | null | undefined,
  namedEvent: string | null | undefined,
): number {
  const base = getVerticalBaseFloor(vertical);
  const funnel = getFunnelMultiplier(namedEvent);
  const marketMult = getMarketMultiplier(market);
  const raw = base * funnel * marketMult * SAFETY_FACTOR;
  return Math.max(10, Math.round(raw));
}

export function computeVolumeCeiling(
  market: string | null | undefined,
  vertical: string | null | undefined,
  namedEvent: string | null | undefined,
): number {
  const base = getVerticalBaseFloor(vertical);
  const funnel = getFunnelMultiplier(namedEvent);
  const marketMult = getMarketMultiplier(market);
  const raw = base * funnel * marketMult * 6.0;
  return Math.round(raw);
}

export function isVolumePlausible(
  volume: number,
  market: string | null | undefined,
  vertical: string | null | undefined,
  namedEvent: string | null | undefined,
): boolean {
  if (volume <= 0) return false;
  return (
    computeVolumeFloor(market, vertical, namedEvent) <= volume &&
    volume <= computeVolumeCeiling(market, vertical, namedEvent)
  );
}


// ============================================================================
// 5. FUNNEL-DEPTH COHERENCE
// ============================================================================

export function isFunnelCoherent(
  installVolume: number,
  deeperEventVolume: number,
  deeperEventName: string,
): boolean {
  if (installVolume <= 0 || deeperEventVolume <= 0) return true;
  const deeperMultiplier = getFunnelMultiplier(deeperEventName);
  const installMultiplier = FUNNEL_DEPTH_MULTIPLIERS["install"];
  if (deeperMultiplier >= installMultiplier) return true;
  const expectedRatio = deeperMultiplier / installMultiplier;
  const actualRatio = deeperEventVolume / installVolume;
  return actualRatio <= expectedRatio * 2.0;
}


// ============================================================================
// 6. EMAIL BODY VOLUME EXTRACTION
// ============================================================================
// Used by doctrineLint to scan email bodies for volume claims to validate.

export interface ExtractedVolume {
  number: number;
  unit: string;
  context: string;
}

/** Find volume claims like "500 installs/day", "1000 deposits per day",
 * "delivering 250+", "500 contas por dia", etc. */
export function extractVolumeClaims(body: string): ExtractedVolume[] {
  if (!body) return [];
  const hits: ExtractedVolume[] = [];
  // Match number (optionally with +, comma separators, or "k"/"K" suffix)
  // followed within 8 words by a daily-context marker.
  const numberRe = /(\d[\d,]*\+?\s*[kK]?)\s+([^.]{0,80}?\b(per\s+day|\/day|daily|por\s+dia|al\s+d[ií]a|pro\s+Tag|en\s+un\s+d[ií]a|по\s+дням|\/\s*día|\/giorno))/gi;
  let m: RegExpExecArray | null;
  while ((m = numberRe.exec(body)) !== null) {
    const numStr = m[1].replace(/[,\s]/g, "").replace(/\+$/, "");
    let num: number;
    if (numStr.toLowerCase().endsWith("k")) {
      num = parseFloat(numStr.slice(0, -1)) * 1000;
    } else {
      num = parseInt(numStr, 10);
    }
    if (!isNaN(num)) {
      hits.push({
        number: Math.round(num),
        unit: "daily",
        context: m[0].slice(0, 100),
      });
    }
  }
  return hits;
}
