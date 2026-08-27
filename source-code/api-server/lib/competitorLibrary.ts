/**
 * In-region competitor retrieval and writer prompt block construction.
 *
 * Purpose: lift the writing quality of the cheaper writer tiers toward the
 * strongest tier's bar by handing the model ground-truth in-market competitor
 * names. A cheaper model recalls regional competitors
 * unreliably and can name a dominant market leader as a peer, which breaks the
 * doctrine. Injecting a curated, in-region candidate set removes that recall
 * burden and gives the deterministic critic/linter concrete names to check.
 *
 * Keying decision (locked): prospects carry a language but no country, so
 * selection is LANGUAGE-KEYED. For the prospect's language we take the union of
 * the competitor rows across every market that speaks that language, then within
 * the best-matching vertical we union the nameable peers and the avoid lists.
 *
 * Union semantics that protect in-region accuracy:
 *   - nameable = union of competitors[].name across the language's markets.
 *   - avoid-line = union of avoid[] MINUS any name that is a peer in at least one
 *     of the language's markets. A name only ever flagged across all in-language
 *     markets is shown as off-limits; a name that is a real peer somewhere in the
 *     language is kept nameable rather than removed by another market's avoid set.
 *   - GLOBAL (country_code XX) rows are intentionally excluded from naming to
 *     keep references strictly in-region (Rule 9).
 *
 * The block is framed as ground truth: reference a competitor only to sharpen one
 * concrete point, apply the target-language BRAND ADAPTATION script rule to any
 * name used, and introduce no competitor outside the list for that market.
 *
 * Disabled with WRITER_COMPETITORS=off. Nameable count tunable with
 * WRITER_COMPETITOR_COUNT (default 8, clamped 3..16).
 */
import { COMPETITOR_LIBRARY, type CompetitorMarket } from "./competitorLibraryData";
import { isStrictNativeLang, nativeFormFor } from "./competitorNativeForms";

export interface CompetitorContext {
  vertical?: string | null;
  sub_vertical?: string | null;
  product?: string | null;
  original_language?: string | null;
}

export interface SelectedCompetitors {
  /** Nameable in-market peers, ranked, capped at the configured count. */
  nameable: string[];
  /** Dominant or wrong-region names to never present as peers, capped. */
  avoid: string[];
  /** Regional cross-border players present across the language's markets. */
  crossBorder: string[];
  /** The competitor vertical that was resolved for the context. */
  vertical: string;
  /** Country names that contributed, for logs and the block header. */
  markets: string[];
}

export function competitorsEnabled(): boolean {
  return (process.env.WRITER_COMPETITORS || "on").toLowerCase() !== "off";
}

function competitorCount(): number {
  const n = Number(process.env.WRITER_COMPETITOR_COUNT);
  if (!Number.isFinite(n)) return 8;
  return Math.max(3, Math.min(16, Math.floor(n)));
}

// Language -> in-library market country codes. Restricted to codes that exist in
// competitor_library.jsonl. A union across these markets is what "language-keyed"
// means: the nameable peers are pooled across every market that speaks the
// language, and ranked by how many of those markets share the name. GLOBAL (XX)
// is deliberately omitted so references stay in-region.
const LANGUAGE_TO_COUNTRY_CODES: Record<string, string[]> = {
  en: ["US", "GB", "CA", "AU", "IE", "IN", "SG", "HK", "PH", "MY", "NG", "GH", "KE", "UG", "TZ", "ZA", "PK", "LK"],
  es: ["ES", "MX", "AR", "CO", "CL", "PE", "EC", "BO", "PY", "UY", "CR", "GT", "PA", "DO"],
  pt: ["BR", "PT"],
  ar: ["SA", "AE", "EG", "MA", "DZ", "IQ", "JO", "KW", "QA", "BH", "OM"],
  de: ["DE", "AT", "CH"],
  hi: ["IN"],
  fr: ["FR", "BE", "CH", "CA", "MA", "DZ", "CI"],
  id: ["ID"],
  ja: ["JP"],
  tr: ["TR"],
  ko: ["KR"],
  ru: ["RU", "KZ", "UZ", "AZ", "GE", "UA"],
  it: ["IT", "CH"],
  pl: ["PL"],
  tl: ["PH"],
  zh: ["CN", "HK", "TW", "SG"],
  vi: ["VN"],
  th: ["TH"],
  ur: ["PK"],
  nl: ["NL", "BE"],
  he: ["IL"],
  sv: ["SE"],
  no: ["NO"],
  da: ["DK"],
  fi: ["FI"],
  uk: ["UA"],
  cs: ["CZ"],
  ro: ["RO"],
  hu: ["HU"],
  el: ["GR"],
  bn: ["BD"],
  fa: ["IR"],
  ms: ["MY", "SG"],
  sw: ["KE", "TZ", "UG"],
  az: ["AZ"],
  bg: ["BG"],
  et: ["EE"],
  ka: ["GE"],
  hr: ["HR"],
  km: ["KH"],
  si: ["LK"],
  lt: ["LT"],
  lv: ["LV"],
  my: ["MM"],
  ne: ["NP"],
  sr: ["RS"],
  sl: ["SI"],
  sk: ["SK"],
};

// Bridge from the runtime taxonomy (vertical / sub_vertical / product free text)
// onto the competitor library's vertical vocabulary. Each competitor vertical
// lists the tokens that should resolve to it. Matching is fuzzy and additive:
// any token overlap scores. The best-scoring vertical wins; a zero score means
// the context is too generic to resolve a vertical confidently and the block is
// skipped rather than guessed.
const VERTICAL_BRIDGE: Record<string, string[]> = {
  ecommerce: ["ecommerce", "commerce", "retail", "shop", "shopping", "marketplace", "purchase", "store"],
  fintech_banking_and_payments: ["fintech", "bank", "banking", "payment", "payments", "wallet", "finance", "neobank"],
  food_and_delivery: ["food", "delivery", "grocery", "restaurant", "meal", "groceries"],
  telecom: ["telecom", "telco", "carrier", "operator", "mobile_operator", "prepaid"],
  ride_hailing: ["ride", "hailing", "taxi", "mobility", "rideshare", "cab"],
  crypto_and_trading: ["crypto", "trading", "exchange", "forex", "broker", "cfd", "defi"],
  comparison_aggregator: ["comparison", "aggregator", "compare", "price", "pricecompare"],
  classifieds: ["classifieds", "classified", "listings", "listing"],
  real_estate_proptech: ["estate", "realestate", "property", "proptech", "housing", "rent"],
  jobs_recruitment: ["jobs", "job", "recruitment", "hiring", "career", "careers", "recruit"],
  subscription_media: ["subscription", "media", "streaming", "ott", "vod", "music", "video", "audio"],
  travel_and_booking: ["travel", "booking", "flights", "flight", "hotels", "hotel", "tourism", "ota"],
  sports_betting: ["betting", "sportsbook", "wager", "bet"],
  lending_and_credit: ["lending", "loan", "loans", "credit", "bnpl", "advance"],
  health_and_fitness: ["health", "fitness", "wellness", "workout", "gym"],
  insurance: ["insurance", "insurtech", "insure"],
  gaming_midcore_hardcore: ["midcore", "hardcore", "rpg", "strategy", "iap", "shooter"],
  education: ["education", "edtech", "learning", "courses", "tutoring", "course"],
  gaming_casual: ["casual", "puzzle", "match"],
  social_and_dating: ["social", "dating", "match", "chat"],
  gaming_casino: ["casino", "slots", "gambling", "poker"],
  utility_and_productivity: ["utility", "productivity", "tools", "vpn", "scanner"],
  ai_tool: ["ai", "llm", "assistant", "chatbot", "genai"],
  gaming_casual_hypercasual: ["hypercasual", "hyper"],
  sports_media_and_community: ["fan", "scores", "sportsmedia"],
};

// Generic gaming UA without a more specific sub-vertical defaults to the most
// common gaming competitor vertical so it is not silently dropped.
const GAMING_FALLBACK = "gaming_midcore_hardcore";

function tokensOf(ctx: CompetitorContext): string[] {
  const parts = [ctx.vertical, ctx.sub_vertical, ctx.product]
    .map((p) => (p || "").toLowerCase())
    .join(" ");
  return Array.from(new Set(parts.split(/[^a-z]+/).filter((t) => t.length >= 2)));
}

function resolveVertical(ctx: CompetitorContext): string | null {
  const raw = [ctx.vertical, ctx.sub_vertical, ctx.product]
    .map((p) => (p || "").toLowerCase())
    .join(" ");
  const toks = tokensOf(ctx);
  // "non_gaming_ua" is the opposite signal to gaming, but it tokenizes to
  // ["non","gaming"] and the bare "gaming" token weak-matches every "gaming_*"
  // vertical via the vert.includes(t) rule below, giving a non-gaming prospect a
  // spurious score on a gaming vertical. That used to push bestScore above 0 and
  // bypass the non-gaming guard at the tail, so generic non-gaming prospects
  // resolved to gaming competitors. Compute the non-gaming flag up front and
  // exclude gaming verticals from scoring when it is set, so a truly generic
  // non-gaming context scores 0 and the block is skipped (the module's stated
  // policy) rather than guessed as gaming.
  const isNonGaming = raw.includes("non_gaming") || raw.includes("non-gaming") || raw.includes("non gaming");
  let best: string | null = null;
  let bestScore = 0;
  for (const [vert, keys] of Object.entries(VERTICAL_BRIDGE)) {
    if (isNonGaming && vert.startsWith("gaming")) continue;
    let score = 0;
    for (const t of toks) {
      if (keys.includes(t)) score += 3;
      else if (vert.includes(t)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = vert;
    }
  }
  if (bestScore > 0) return best;
  // No confident vertical. Fall back to a gaming vertical only for an explicit
  // gaming context. "non_gaming_ua" contains the token "gaming" but is the
  // opposite signal, so it must never resolve here.
  if (!isNonGaming && (toks.includes("gaming") || toks.includes("game"))) return GAMING_FALLBACK;
  return null;
}

function offerOf(ctx: CompetitorContext): string | null {
  const p = (ctx.product || "").toLowerCase();
  if (p === "ua" || p === "cps" || p === "retargeting") return p;
  return null;
}

function langOf(ctx: CompetitorContext): string {
  return (ctx.original_language || "en").toLowerCase();
}

/**
 * Rank and select in-region competitors for a context. Pure and side-effect
 * free so it is hermetically testable.
 */
export function selectCompetitors(ctx: CompetitorContext): SelectedCompetitors | null {
  const empty = (): null => null;

  const codes = LANGUAGE_TO_COUNTRY_CODES[langOf(ctx)];
  if (!codes || codes.length === 0) return empty();

  const vertical = resolveVertical(ctx);
  if (!vertical) return empty();

  const offer = offerOf(ctx);
  const codeSet = new Set(codes);

  const rows = COMPETITOR_LIBRARY.filter((r) => {
    if (r.country_code === "XX") return false;
    if (!codeSet.has(r.country_code)) return false;
    if (r.vertical !== vertical) return false;
    if (offer && r.offer_types && r.offer_types.length > 0 && !r.offer_types.includes(offer)) {
      return false;
    }
    return true;
  });
  if (rows.length === 0) return empty();

  // Count, per name, how many in-language markets list it as a peer, and track
  // its strongest tier (core outranks secondary). Track the union of names that
  // appear as a peer anywhere in the language.
  const peerMarkets = new Map<string, number>();
  const peerTier = new Map<string, string>();
  const peerNames = new Set<string>();
  const avoidSet = new Set<string>();
  const crossSet = new Set<string>();
  const markets = new Set<string>();

  const tierRank = (t: string): number => (t === "core" ? 0 : t === "secondary" ? 1 : 2);

  for (const r of rows) {
    markets.add(r.country);
    for (const c of r.competitors || []) {
      if (!c.operates_in_country) continue;
      const name = c.name.trim();
      if (!name) continue;
      peerNames.add(name.toLowerCase());
      peerMarkets.set(name, (peerMarkets.get(name) || 0) + 1);
      const prev = peerTier.get(name);
      if (prev === undefined || tierRank(c.tier) < tierRank(prev)) peerTier.set(name, c.tier);
    }
    for (const a of r.avoid || []) {
      const name = a.trim();
      if (name) avoidSet.add(name);
    }
    for (const x of r.cross_border || []) {
      const name = x.trim();
      if (name) crossSet.add(name);
    }
  }

  // Rank nameable peers: stronger tier first, then more in-language markets, then
  // alphabetical for a stable order.
  const nameable = Array.from(peerMarkets.keys())
    .sort((a, b) => {
      const tr = tierRank(peerTier.get(a) || "") - tierRank(peerTier.get(b) || "");
      if (tr !== 0) return tr;
      const mr = (peerMarkets.get(b) || 0) - (peerMarkets.get(a) || 0);
      if (mr !== 0) return mr;
      return a.localeCompare(b);
    })
    .slice(0, competitorCount());

  // Avoid line: names flagged as off-limits that are NOT a real peer anywhere in
  // the language. Cross-border names are not duplicated into the avoid line.
  const avoid = Array.from(avoidSet)
    .filter((n) => !peerNames.has(n.toLowerCase()))
    .filter((n) => !crossSet.has(n))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 8);

  const crossBorder = Array.from(crossSet)
    .filter((n) => !peerNames.has(n.toLowerCase()))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 6);

  if (nameable.length === 0 && avoid.length === 0) return empty();

  return {
    nameable,
    avoid,
    crossBorder,
    vertical,
    markets: Array.from(markets).sort(),
  };
}

/**
 * Build the in-region competitor reference block for the writer/rewriter user
 * prompt. Returns an empty string when disabled or when no confident in-region
 * selection exists for the context.
 *
 * The block is prepended to the user prompt (alongside the exemplar block) and
 * never to the system prefix, which stays byte-identical across calls — that is
 * what both vendors' prompt caches key on — and so reaches every tier in the
 * same place.
 */
export function buildWriterCompetitorBlock(ctx: CompetitorContext): string {
  if (!competitorsEnabled()) return "";
  const sel = selectCompetitors(ctx);
  if (!sel) return "";

  const lines: string[] = [];
  const lang = (ctx.original_language || "en").toLowerCase();
  const strict = isStrictNativeLang(lang);
  const marketLabel = sel.markets.slice(0, 6).join(", ") + (sel.markets.length > 6 ? ", and others" : "");
  lines.push(
    `IN-REGION COMPETITOR REFERENCE (vertical: ${sel.vertical}; markets: ${marketLabel}). These are ground-truth, in-market names for this language. Reference a competitor only when an angle needs one concrete local peer, and only to sharpen a specific point.`,
  );
  if (sel.nameable.length > 0) {
    // For strict-native languages, show the verified native-script form where one
    // exists so the model copies the correct script rather than the Latin name.
    const shown = strict ? sel.nameable.map((n) => nativeFormFor(lang, n) ?? n) : sel.nameable;
    lines.push(`Nameable in-market peers: ${shown.join(", ")}.`);
  }
  if (sel.avoid.length > 0) {
    lines.push(
      `Do not present these as peers for this market (wrong-region or off-limits): ${sel.avoid.join(", ")}.`,
    );
  }
  if (sel.crossBorder.length > 0) {
    lines.push(`Regional cross-border players you may cite as market context: ${sel.crossBorder.join(", ")}.`);
  }
  if (strict) {
    lines.push(
      `Write each peer name exactly in the script shown above. For any name shown in Latin, render it in the local script as it appears in B2B media, and keep brands whose identity stays Latin (Wildberries, AliExpress, Lamoda, and similar) in Latin. Beyond any competitor already named in the original email, introduce no competitor outside this list for this market. A competitor reference fits a later-stage follow-up more than the first touch.`,
    );
  } else {
    lines.push(
      `Names are given in Latin reference form; apply the target-language BRAND ADAPTATION script rule when you use one. Beyond any competitor already named in the original email, introduce no competitor outside this list for this market. A competitor reference fits a later-stage follow-up more than the first touch.`,
    );
  }
  return lines.join("\n");
}
