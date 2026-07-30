/**
 * nativenessV3.ts
 *
 * Reading-A++ language nativeness policy for the MobUpps Followuper. This is
 * the TypeScript twin of stages/nativeness_v3.py in the Prospector. The two
 * modules ship the same policy and the same detector logic so the writer
 * critic + lint behave identically across the two products.
 *
 * v3 policy in one paragraph:
 *
 *   For every non-English target email, the ONLY Latin tokens permitted
 *   inside the body are (a) pure acronyms from a curated allowlist (CPI,
 *   CPA, ROAS, LTV, MMP, SDK, IAP, KYC, AI, ML, ...), and (b) proper nouns
 *   (Meta, Google, Xiaomi, OPPO, AppsFlyer, Adjust, and the prospect's own
 *   brand and product names). Every other English word — single tokens
 *   AND multi-word phrases — must be translated. This includes capitalized
 *   loan-nouns like German "Conversion" / "Performance" / "Retention",
 *   which v2 previously permitted under the ENGLISH-TOLERANT carve-out.
 *
 *   Two universal style rules apply to every language INCLUDING English:
 *     * X-NOT-Y comma-negation pattern is banned ("performance partners,
 *       not raw installs"). Use "rather than" / "instead of" or rephrase.
 *     * For non-Latin-script targets, the prospect's first name in the
 *       greeting MUST be transliterated into the local script
 *       ("เรียน Songsitt" → "เรียน ทรงสิทธิ์").
 *
 * Exports:
 *   FORBIDDEN_ENGLISH_PHRASES, FORBIDDEN_ENGLISH_SINGLETONS,
 *   LATIN_ALLOWLIST, BOILERPLATE_LATIN, X_NOT_Y_PATTERNS,
 *   NON_LATIN_SCRIPT_LANGS, VIETNAMESE_DIACRITIC_SET
 *
 *   findForbiddenPhrases, findLatinTokenRuns, findForbiddenSingletons,
 *   findXNotY, findUntransliteratedGreetingName,
 *   findAllNativenessViolations, hasAnyViolation
 *
 *   buildNativenessBlockV3, buildCriticNativenessBlockV3
 */

// ============================================================================
// 1. EXPANDED LATIN ALLOWLIST
// ============================================================================

export const LATIN_ALLOWLIST: ReadonlySet<string> = new Set([
  // Performance metrics
  "CPI", "CPA", "CPM", "CPC", "CTR", "CVR",
  "ROAS", "ROI", "ARPU", "ARPPU", "ARPDAU", "AOV", "LTV",
  "MAU", "DAU", "WAU", "MAUs", "DAUs",
  "D1", "D3", "D7", "D14", "D30", "D60", "D90",
  // Industry roles / systems
  "DSP", "SSP", "RTB", "PMP", "OEM", "OEMs",
  "MMP", "MMPs",
  "SDK", "SDKs", "API", "APIs", "IAP", "IAPs",
  "KPI", "KPIs", "KYC", "AML", "GDPR", "CCPA", "PII",
  "AI", "ML", "NLP", "LLM",
  "iOS", "OS", "GP",
  "B2B", "B2C", "P2P", "C2C",
  "QR", "URL", "URI", "UTM", "HTTP", "HTTPS",
  // Capital labels
  "RR", "D7 RR", "D30 RR", "D7-RR", "D30-RR",
  "D ROAS", "D-ROAS", "D7-ROAS", "D30-ROAS",
  // Sector acronyms
  "SMB", "SME", "VPN", "OTT", "CTV", "IPTV", "FTTH",
  // Common adtech vendor / product names
  "MobUpps", "MAFO",
  "AppsFlyer", "Adjust", "Singular", "Branch", "Kochava",
  "Tenjin", "AppMetrica",
  "Apple", "Google", "Meta", "Facebook", "TikTok", "ByteDance",
  "Snap", "Snapchat", "Twitter", "X", "LinkedIn",
  "Amazon", "Microsoft", "Samsung",
  "Xiaomi", "Huawei", "OPPO", "Vivo", "OnePlus", "Realme",
  "WhatsApp", "WeChat", "Line", "Telegram", "Viber",
  "YouTube", "Instagram", "Pinterest", "Reddit",
  "Spotify", "Netflix", "Disney",
  // Currency codes
  "USD", "EUR", "GBP", "JPY", "CNY", "INR", "THB", "MYR", "SGD",
  "IDR", "VND", "PHP", "BRL", "MXN", "ZAR", "AED", "SAR",
  "RUB", "TRY", "ILS", "PLN", "CZK", "HUF", "RON",
]);

export const BOILERPLATE_LATIN: ReadonlySet<string> = new Set([
  "http", "https", "www", "com", "co", "io", "ai", "app", "net",
  "org", "page", "tel", "email", "e", "mail", "fax", "ltd", "inc",
  "the", "and", "or", "to", "for", "of", "in", "on", "at", "by",
]);


// ============================================================================
// 2. FORBIDDEN MULTI-WORD ENGLISH PHRASES (universal)
// ============================================================================

/** Build a case-insensitive phrase regex. Spaces tolerate hyphen alternation. */
function phrase(...parts: string[]): RegExp {
  const joined = parts.map(escapeReg).join("[\\s\\-]+");
  return new RegExp("(?<![A-Za-z])" + joined + "(?![A-Za-z])", "i");
}

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const FORBIDDEN_ENGLISH_PHRASES: RegExp[] = [
  // Inventory / supply framing
  phrase("semi", "exclusive", "inventory"),
  phrase("semi", "exclusive", "publisher", "inventory"),
  phrase("semi", "exclusive", "supply"),
  phrase("premium", "publisher", "inventory"),
  phrase("premium", "inventory"),
  phrase("exclusive", "inventory"),
  phrase("exclusive", "publisher", "inventory"),
  phrase("exclusive", "supply"),
  phrase("non", "shared", "inventory"),
  phrase("non", "overlapping", "inventory"),

  // Fraud / quality screening
  phrase("pre", "bid", "screening"),
  phrase("pre", "bid", "filtering"),
  phrase("pre", "bid", "filter"),
  phrase("pre", "bid", "validation"),
  phrase("pre", "bid", "checks"),
  phrase("post", "attribution", "verification"),
  phrase("post", "attribution", "validation"),
  phrase("post", "attribution", "postback", "validation"),
  phrase("post", "attribution", "checks"),
  phrase("anti", "fraud", "filtering"),
  phrase("anti", "fraud", "system"),
  phrase("multi", "layer", "fraud", "filtering"),
  phrase("multi", "stage", "fraud", "screening"),
  phrase("multi", "stage", "fraud", "filtering"),
  phrase("fraud", "filtering"),
  phrase("fraud", "screening"),
  phrase("source", "level", "fraud", "screening"),
  phrase("source", "level", "fraud", "filtering"),
  phrase("synthetic", "funding", "patterns"),
  phrase("synthetic", "traffic"),

  // Cohort / anomaly
  phrase("cohort", "level", "anomaly", "detection"),
  phrase("cohort", "level", "anomaly", "check"),
  phrase("cohort", "level", "anomaly", "checks"),
  phrase("cohort", "level", "anomaly", "review"),
  phrase("anomaly", "detection"),

  // Payer / lookalike modeling
  phrase("payer", "optimized", "cohort", "buying"),
  phrase("payer", "lookalike", "modeling"),
  phrase("lookalike", "modeling"),
  phrase("lookalike", "audiences"),
  phrase("lookalike", "audience"),
  phrase("look", "alike", "audiences"),

  // Postback / IAP framing
  phrase("first", "party", "IAP", "postbacks"),
  phrase("first", "party", "postbacks"),
  phrase("server", "to", "server", "postbacks"),

  // Audience / market framing
  phrase("Android", "heavy", "audience"),
  phrase("Android", "heavy", "market"),
  phrase("iOS", "heavy", "audience"),
  phrase("iOS", "heavy", "market"),
  phrase("potential", "whales"),
  phrase("high", "value", "users"),

  // Publisher mix / payout framing
  phrase("publisher", "mix"),
  phrase("publisher", "mix", "and", "payout", "structure"),
  phrase("payout", "structure"),
  phrase("payout", "ladder"),

  // Spend / cohort behavioural framing
  phrase("one", "time", "spenders"),
  phrase("first", "purchase", "only", "spenders"),
  phrase("trial", "tourists"),

  // Ad format framing
  phrase("rewarded", "video"),
  phrase("playable", "ads"),
  phrase("offerwall", "campaigns"),

  // Creative + signal
  phrase("creative", "testing"),
  phrase("genre", "signal"),
  phrase("genre", "based", "signal"),
  phrase("F2P", "only", "users"),
  phrase("F2P", "only", "cohort"),
  phrase("open", "world", "hook"),
  phrase("open", "world", "gameplay", "hook"),
  phrase("GTA", "style", "gameplay"),
  phrase("GTA", "style", "gameplay", "loop"),

  // Trial / SaaS framing
  phrase("post", "trial", "retention"),
  phrase("post", "trial", "cohort"),
  phrase("trial", "to", "paid", "conversion"),
  phrase("trial", "activation"),
  phrase("plan", "upgrades"),
  phrase("paid", "plan", "activation"),

  // Funded / deposit framing
  phrase("install", "to", "deposit", "journey"),
  phrase("install", "to", "funded"),
  phrase("first", "deposit", "size"),
  phrase("install", "to", "sale", "completion"),
  phrase("install", "to", "deposit", "completion"),
  phrase("single", "tap", "funders"),

  // Targeting / geo
  phrase("geo", "targeting"),
  phrase("geo", "targeted"),
  phrase("dayparting"),
  phrase("delivery", "radius", "targeting"),

  // Bidding / auction
  phrase("programmatic", "auction"),
  phrase("programmatic", "inventory"),
  phrase("intent", "rich", "placements"),

  // Optimization framing
  phrase("incremental", "lift"),
  phrase("incremental", "users"),
  phrase("incrementality", "test"),
  phrase("optimization", "signal"),
  phrase("optimization", "signals"),
  phrase("full", "funnel", "optimization"),
  phrase("deep", "funnel", "events"),
  phrase("deep", "funnel", "optimization"),
  phrase("mid", "funnel", "economics"),
  phrase("mid", "funnel"),

  // Retention / persistence
  phrase("subscriber", "retention"),
  phrase("payer", "retention"),
  phrase("user", "retention"),
  phrase("second", "deposit", "persistence"),
  phrase("second", "cycle"),

  // Quality gates / verification
  phrase("quality", "gates"),
  phrase("quality", "user", "acquisition"),
  phrase("approved", "events"),
  phrase("approved", "paid", "events"),
  phrase("approved", "revenue", "events"),
  phrase("verified", "seller", "flows"),
  phrase("paid", "actions"),
  phrase("paid", "events"),
  phrase("real", "paid", "actions"),
  phrase("real", "revenue", "events"),

  // Sources / supply framing
  phrase("source", "level", "transparency"),
  phrase("supply", "stack"),
  phrase("supply", "side"),

  // Misc adtech compounds
  phrase("install", "to", "deposit"),
  phrase("first", "invoice", "sent"),
  phrase("bank", "and", "ledger", "connection"),
  phrase("ledger", "connection"),
  phrase("active", "usage"),
  phrase("durable", "conversions"),
  phrase("durable", "revenue"),
  phrase("durable", "payer"),
  phrase("payer", "conversion", "event"),
  phrase("surface", "install", "KPI"),
  phrase("surface", "install"),
];


// ============================================================================
// 3. SINGLE-TOKEN ENGLISH CONTENT BLACKLIST (Reading A++)
// ============================================================================

export const FORBIDDEN_ENGLISH_SINGLETONS: ReadonlySet<string> = new Set([
  // Adtech mechanics nouns
  "install", "installs", "installation", "installations",
  "conversion", "conversions",
  "retention", "retentions",
  "cohort", "cohorts",
  "lookalike", "lookalikes",
  "audience", "audiences",
  "publisher", "publishers",
  "creative", "creatives",
  "targeting", "retargeting", "remarketing",
  "traffic",
  "segment", "segments", "segmentation",
  "placement", "placements",
  "postback", "postbacks",
  "attribution", "attributions",
  "anomaly", "anomalies",
  "detection",
  "filtering", "filter", "filters",
  "screening", "screen", "screens", "screened",
  "validation", "validations",
  "verification", "verifications",
  "modeling", "model", "models", "modelling",
  "inventory", "inventories",
  "supply", "supplies", "supplied",
  "payer", "payers",
  "optimization", "optimizations", "optimisation",

  // Adtech adjectives / quality framing
  "exclusive",
  "semi-exclusive",
  "premium",
  "durable",
  "synthetic",
  "rewarded",
  "playable",
  "programmatic",
  "incremental",
  "incrementality",
  "approved",
  "verified",
  "real",
  "raw",

  // Business / marketing nouns
  "performance",
  "marketing",
  "branding",
  "campaign", "campaigns",
  "network", "networks",
  "platform", "platforms",
  "growth",
  "revenue", "revenues",
  "spend",
  "funnel", "funnels",
  "channel", "channels",
  "source", "sources",
  "mix",
  "stack",
  "data",
  "analytics",
  "dashboard", "dashboards",
  "report", "reports", "reporting",
  "benchmark", "benchmarks", "benchmarked",
  "baseline",
  "target", "targets",
  "user", "users",
  "userbase",
  "customer", "customers",
  "subscriber", "subscribers",
  "merchant", "merchants",
  "partner", "partners", "partnership", "partnerships",
  "vendor", "vendors",

  // Event / conversion nouns
  "event", "events",
  "action", "actions",
  "click", "clicks",
  "impression", "impressions",
  "view", "views",
  "signup", "signups", "sign-up", "sign-ups",
  "deposit", "deposits",
  "purchase", "purchases",
  "registration", "registrations",
  "order", "orders",

  // Action verbs
  "deliver", "delivers", "delivered", "delivering", "delivery",
  "optimize", "optimizes", "optimized", "optimizing", "optimise", "optimises",
  "convert", "converts", "converted", "converting",
  "acquire", "acquires", "acquired", "acquiring", "acquisition",
  "scale", "scales", "scaled", "scaling",
  "retain", "retains", "retained", "retaining",
  "validate", "validates", "validated", "validating",
  "monitor", "monitors", "monitored", "monitoring",
  "track", "tracks", "tracked", "tracking",
  "drive", "drives", "drove", "driving", "driven",
  "boost", "boosts", "boosted", "boosting",
  "leverage", "leverages", "leveraged", "leveraging",
  "deploy", "deploys", "deployed", "deploying",
  "implement", "implements", "implemented", "implementing",
  "launch", "launches", "launched", "launching",
  "execute", "executes", "executed", "executing", "execution",

  // Bidding / auction
  "bid", "bidder", "bidders", "bids", "bidding",
  "budget", "budgets",
  "exposure",
  "frequency",
  "reach",
  "dayparting",
  "lookback",
  "similar",

  // Quality / payment framing
  "quality",
  "gates",
  "guardrail", "guardrails",
  "transparency",
  "fraud",
  "spam",
  "abuse",

  // Tech / SaaS context
  "tech",
  "infrastructure",
  "pipeline", "pipelines",
  "integration", "integrations",
  "deployment", "deployments",
  "release", "releases",
  "build", "builds",
  "feature", "features",
  "rollout",
  "experiment", "experiments",
  "test", "tests", "testing",

  // Funnel / retention framing
  "trial", "trials",
  "subscription", "subscriptions",
  "tier", "tiers", "tiered",
  "freemium",

  // Common adjectives that read as English filler
  "strong",
  "powerful",
  "robust",
  "significant",
  "exceptional",
  "outstanding",
  "innovative",
  "industry-leading",
  "best-in-class",
  "world-class",
  "cutting-edge",
  "next-generation",
  "next-gen",
  "transformative",
  "game-changing",
  "groundbreaking",
  "revolutionary",
  "unparalleled",
  "unmatched",

  // Verbs / common nouns that leak
  "pulled",
  "pegged",
  "tied",
  "feeds",
  "anchored",
  "weighted",
  "split",
  "tune", "tunes", "tuned", "tuning",
  "shift", "shifts", "shifted", "shifting",
  "buying",
  "moving",
  "running",
  "blocked",
  "blocking",
  "completion",
  "completes",
  "above",
  "below",
  "across",
  "before",
  "after",
  "between",
  "rather",
  "instead",

  // Ad-format roots
  "interstitial",
  "banner",
  "native",
  "video",
  "audio",
  "display",
  "search",
  "social",
  "affiliate",
  "influencer",

  // Funnel stage / cohort framing
  "cycle", "cycles",
  "trial-to-paid",
  "post-trial",
  "pre-trial",
  "pre-purchase",
  "post-purchase",
]);


// ============================================================================
// 4. X-NOT-Y COMMA-NEGATION PATTERNS (per language)
// ============================================================================

export const X_NOT_Y_PATTERNS: Record<string, RegExp[]> = {
  "en": [
    /,\s+not\s+[a-z][a-z'\-]+(?:\s+[a-z][a-z'\-]+){0,5}/i,
    /;\s+not\s+[a-z][a-z'\-]+(?:\s+[a-z][a-z'\-]+){0,5}/i,
  ],
  "es": [
    /,\s+no\s+(?!(?:hay|es|son|est[aá]|est[aá]n|estoy|fue|fueron|ser[aá]|ser[ií]a|puede|pueden|podr[ií]a|tiene|tienen|debe|deben|hace|hacen|hubo|habr[aá]|va|van|existe|existen|importa|queda|quedan|necesita|necesitas|dudes|busca|buscamos)\b)(?:el\s+|la\s+|los\s+|las\s+|un\s+|una\s+)?[a-záéíóúñ][a-záéíóúñ'\-]+/iu,
  ],
  "pt": [
    /,\s+não\s+(?:o\s+|a\s+|os\s+|as\s+|um\s+|uma\s+)?[a-zãâáàéêíóôõúç][a-zãâáàéêíóôõúç'\-]+/iu,
  ],
  "it": [
    /,\s+non\s+(?:il\s+|la\s+|i\s+|le\s+|un\s+|una\s+)?[a-zàèéìíòùóú][a-zàèéìíòùóú'\-]+/iu,
  ],
  "fr": [
    /,\s+(?:non\s+pas|pas)\s+(?:le\s+|la\s+|les\s+|un\s+|une\s+|des\s+)?[a-zàâçéèêëîïôûùüÿ][a-zàâçéèêëîïôûùüÿ'\-]+/iu,
  ],
  "de": [
    /,\s+nicht\s+(?:der\s+|die\s+|das\s+|den\s+|dem\s+|ein\s+|eine\s+)?[a-zäöüß][a-zäöüß'\-]+/iu,
  ],
  "ru": [
    /,\s+(?:а\s+не|не)\s+[а-яё][а-яё'\-]+/iu,
  ],
  "uk": [
    /,\s+(?:а\s+не|не)\s+[а-яіїєґ][а-яіїєґ'\-]+/iu,
  ],
  "pl": [
    /,\s+(?:a\s+nie|nie)\s+[a-ząćęłńóśźż][a-ząćęłńóśźż'\-]+/iu,
  ],
  "cs": [
    /,\s+(?:a\s+ne|ne)\s+[a-záčďéěíňóřšťúůýž][a-záčďéěíňóřšťúůýž'\-]+/iu,
  ],
  "ro": [
    /,\s+(?:și\s+nu|nu)\s+[a-zăâîșț][a-zăâîșț'\-]+/iu,
  ],
  "tr": [
    /,\s+[a-zçğıöşü][a-zçğıöşü'\-]+\s+değil/iu,
  ],
  "nl": [
    /,\s+(?:niet|geen)\s+(?:de\s+|het\s+|een\s+)?[a-zàäéëïöü][a-zàäéëïöü'\-]+/iu,
  ],
  "sv": [
    /,\s+(?:inte|inga)\s+[a-zåäö][a-zåäö'\-]+/iu,
  ],
  "no": [
    /,\s+(?:ikke|ingen)\s+[a-zæøå][a-zæøå'\-]+/iu,
  ],
  "nb": [
    /,\s+(?:ikke|ingen)\s+[a-zæøå][a-zæøå'\-]+/iu,
  ],
  "da": [
    /,\s+(?:ikke|ingen)\s+[a-zæøå][a-zæøå'\-]+/iu,
  ],
  "fi": [
    /,\s+(?:ei|eivät)\s+[a-zåäö][a-zåäö'\-]+/iu,
  ],
  "hu": [
    /,\s+nem\s+[a-záéíóöőúüű][a-záéíóöőúüű'\-]+/iu,
  ],
  "el": [
    /,\s+(?:και\s+)?(?:όχι|μη|δεν)\s+[α-ωάέήίόύώ][α-ωάέήίόύώ'\-]+/iu,
  ],
  "ja": [
    /ではなく(?:て)?[、。\s]/u,
    /ではない[、。\s]/u,
  ],
  "zh": [
    /[，,]\s*(?:而\s*)?(?:不是|非)[\u4e00-\u9fff]/u,
  ],
  "ko": [
    /[，,]\s*[\uac00-\ud7af]+(?:이|가)\s*아니(?:라|고)/u,
  ],
  "ar": [
    /[،,]\s*(?:ليس|وليس)\s+[\u0600-\u06ff]+/u,
  ],
  "he": [
    /,\s*(?:לא|אינו|אינה)\s+[\u0590-\u05ff]+/u,
  ],
  "fa": [
    /[،,]\s*نه\s+[\u0600-\u06ff]+/u,
  ],
  "hi": [
    /,\s*नहीं\s+[\u0900-\u097f]+/u,
  ],
  "bn": [
    /,\s*(?:নয়|নয়,)\s*[\u0980-\u09ff]+/u,
  ],
  "ur": [
    /[،,]\s*نہیں\s+[\u0600-\u06ff]+/u,
  ],
  "th": [
    /[,\s]+ไม่ใช่\s*[\u0e00-\u0e7f]/u,
  ],
  "vi": [
    /,\s+(?:không\s+phải|chứ\s+không)\s+[a-zàáâãèéêìíòóôõùúýăđĩũơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ][a-zàáâãèéêìíòóôõùúýăđĩũơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ'\-]+/iu,
  ],
  "id": [
    /,\s+bukan\s+[a-z][a-z'\-]+/iu,
  ],
  "ms": [
    /,\s+bukan\s+[a-z][a-z'\-]+/iu,
  ],
  "fil": [
    /,\s+(?:hindi|wala)\s+[a-z][a-z'\-]+/iu,
  ],
  "tl": [
    /,\s+(?:hindi|wala)\s+[a-z][a-z'\-]+/iu,
  ],
  "sw": [
    /,\s+(?:siyo|si|bila)\s+[a-z][a-z'\-]+/iu,
  ],
};


// ============================================================================
// 5. NON-LATIN-SCRIPT LANGUAGES
// ============================================================================

export const NON_LATIN_SCRIPT_LANGS: ReadonlySet<string> = new Set([
  "ru", "uk", "bg", "be", "sr", "mk",
  "el",
  "zh", "ja", "ko",
  "ar", "he", "fa", "ur",
  "hi", "bn", "ta", "te", "mr", "gu", "kn",
  "ml", "pa", "or", "as", "si",
  "th", "lo", "km", "my",
  "am", "ti", "ka", "hy",
]);


// ============================================================================
// 6. VIETNAMESE DIACRITIC SIGNAL
// ============================================================================

export const VIETNAMESE_DIACRITIC_SET: ReadonlySet<string> = new Set([
  ...("àáâãèéêìíòóôõùúýăđĩũơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ" +
      "ÀÁÂÃÈÉÊÌÍÒÓÔÕÙÚÝĂĐĨŨƠƯẠẢẤẦẨẪẬẮẰẲẴẶẸẺẼẾỀỂỄỆỈỊỌỎỐỒỔỖỘỚỜỞỠỢỤỦỨỪỬỮỰỲỴỶỸ"),
]);


// ============================================================================
// 7. HELPER INTERNALS
// ============================================================================

const LATIN_WORD_RE = /[A-Za-z][A-Za-z'\-]+/g;
const PARAGRAPH_SPLIT_RE = /\n\s*\n+/;

const HAS_NON_LATIN_RE = new RegExp(
  "[" +
  "\u0370-\u03FF\u0400-\u04FF\u0500-\u052F\u0530-\u058F" +
  "\u0590-\u05FF\u0600-\u06FF\u0700-\u074F\u0750-\u077F" +
  "\u0780-\u07BF\u0900-\u097F\u0980-\u09FF\u0A00-\u0A7F" +
  "\u0A80-\u0AFF\u0B00-\u0B7F\u0B80-\u0BFF\u0C00-\u0C7F" +
  "\u0C80-\u0CFF\u0D00-\u0D7F\u0D80-\u0DFF\u0E00-\u0E7F" +
  "\u0E80-\u0EFF\u0F00-\u0FFF\u1000-\u109F\u10A0-\u10FF" +
  "\u1100-\u11FF\u1200-\u137F\u1780-\u17FF\u1800-\u18AF" +
  "\u3040-\u309F\u30A0-\u30FF\u3400-\u4DBF\u4E00-\u9FFF" +
  "\uAC00-\uD7AF\uF900-\uFAFF" +
  "]",
  "u"
);


export function normalizeLanguageCode(tag: string | null | undefined): string {
  if (!tag) return "";
  const primary = String(tag).trim().split(/[-_]/, 1)[0]?.toLowerCase() ?? "";
  if (!/^[a-z]{2,3}$/.test(primary)) return "";
  return primary;
}


function isNonEnglish(lang: string): boolean {
  return lang !== "" && lang !== "en";
}


function paragraphIsPrimarilyNonLatin(para: string): boolean {
  let latin = 0;
  let nonLatin = 0;
  for (const ch of para) {
    if (/\s/.test(ch)) continue;
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x0250 || (cp >= 0x0020 && cp <= 0x007e)) latin++;
    else nonLatin++;
  }
  const total = latin + nonLatin;
  if (total === 0) return false;
  return nonLatin >= 3 && (nonLatin / total) >= 0.15;
}


function paragraphIsVietnamese(para: string): boolean {
  for (const ch of para) {
    if (VIETNAMESE_DIACRITIC_SET.has(ch)) return true;
  }
  return false;
}


function isProperNounRun(words: string[]): boolean {
  return words.every(w => !w || /^[A-Z]/.test(w));
}


function stripAllowlist(words: string[]): string[] {
  return words.filter(w =>
    !LATIN_ALLOWLIST.has(w) && !BOILERPLATE_LATIN.has(w.toLowerCase())
  );
}


// ============================================================================
// 8. DETECTORS
// ============================================================================

export function findForbiddenPhrases(text: string, lang: string): string[] {
  const langN = normalizeLanguageCode(lang);
  if (!isNonEnglish(langN)) return [];
  const seen = new Set<string>();
  const hits: string[] = [];
  for (const pat of FORBIDDEN_ENGLISH_PHRASES) {
    const re = new RegExp(pat.source, pat.flags.includes("g") ? pat.flags : pat.flags + "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const key = m[0].toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        hits.push(m[0]);
      }
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }
  return hits;
}


export function findLatinTokenRuns(text: string, lang: string): string[] {
  const langN = normalizeLanguageCode(lang);
  if (!isNonEnglish(langN)) return [];
  if (!NON_LATIN_SCRIPT_LANGS.has(langN)) return [];

  const paragraphs = text.split(PARAGRAPH_SPLIT_RE).map(p => p.trim()).filter(Boolean);
  const seen = new Set<string>();
  const hits: string[] = [];

  const runRe = /[A-Za-z][A-Za-z\d'\-]+(?:[ \t,.](?:[ \t,.])*[A-Za-z][A-Za-z\d'\-]+)+/g;

  for (const para of paragraphs) {
    if (!paragraphIsPrimarilyNonLatin(para)) continue;
    let m: RegExpExecArray | null;
    runRe.lastIndex = 0;
    while ((m = runRe.exec(para)) !== null) {
      const phrase = m[0].trim();
      const words = phrase.split(/[\s,.]+/).filter(Boolean);
      if (words.length < 2) continue;
      const remaining = stripAllowlist(words);
      if (remaining.length < 2) continue;
      if (isProperNounRun(remaining)) continue;
      let streak = 0;
      let longest = 0;
      for (const w of remaining) {
        if (/^[a-z]/.test(w) && w.length >= 3) {
          streak++;
          if (streak > longest) longest = streak;
        } else {
          streak = 0;
        }
      }
      if (longest >= 2) {
        const key = phrase.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          hits.push(phrase);
        }
      }
    }
  }
  return hits;
}


// Words that sit in FORBIDDEN_ENGLISH_SINGLETONS because they are English, yet
// are also the native, dictionary-correct word in specific target languages, so
// they must not be flagged there. "Budget" is standard German and French;
// "incremental" is standard Spanish and Portuguese. Languages that genuinely
// translate the term (for example Russian budget>бюджет) are deliberately absent.
const SINGLETON_LANG_EXEMPTIONS: Record<string, ReadonlySet<string>> = {
  de: new Set(["budget", "segment"]),
  fr: new Set(["budget", "segment"]),
  es: new Set(["incremental", "real"]),
  pt: new Set(["incremental", "real"]),
};

// Industry terms kept in English across every target language. Practitioners
// in adtech use these untranslated, so they pass the singleton rule for all
// languages rather than being treated as anglicisms to translate.
const GLOBAL_SINGLETON_EXEMPTIONS: ReadonlySet<string> = new Set([
  "retargeting",
  "remarketing",
]);

export function findForbiddenSingletons(text: string, lang: string): string[] {
  const langN = normalizeLanguageCode(lang);
  if (!isNonEnglish(langN)) return [];

  const exempt = SINGLETON_LANG_EXEMPTIONS[langN];
  const isNonLatinTarget = NON_LATIN_SCRIPT_LANGS.has(langN);
  const isVietnamese = langN === "vi";

  const seen = new Set<string>();
  const hits: string[] = [];
  const wordRe = new RegExp(LATIN_WORD_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = wordRe.exec(text)) !== null) {
    const token = m[0];
    const key = token.toLowerCase();
    if (seen.has(key)) continue;
    if (GLOBAL_SINGLETON_EXEMPTIONS.has(key)) continue;
    if (exempt && exempt.has(key)) continue;
    if (FORBIDDEN_ENGLISH_SINGLETONS.has(key)) {
      seen.add(key);
      hits.push(token);
    }
  }
  if (hits.length === 0) return [];

  if (isNonLatinTarget || isVietnamese) {
    const paragraphs = text.split(PARAGRAPH_SPLIT_RE).map(p => p.trim()).filter(Boolean);
    const targetParas = paragraphs.filter(p =>
      isVietnamese ? paragraphIsVietnamese(p) : paragraphIsPrimarilyNonLatin(p)
    );
    const joined = targetParas.join(" ").toLowerCase();
    return hits.filter(h => joined.includes(h.toLowerCase()));
  }
  return hits;
}


export function findXNotY(text: string, lang: string): string[] {
  const langN = normalizeLanguageCode(lang) || "en";
  const pats = X_NOT_Y_PATTERNS[langN] || X_NOT_Y_PATTERNS["en"] || [];
  const seen = new Set<string>();
  const hits: string[] = [];
  for (const pat of pats) {
    const flags = pat.flags.includes("g") ? pat.flags : pat.flags + "g";
    const re = new RegExp(pat.source, flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const phrase = m[0].trim();
      const key = phrase.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        hits.push(phrase);
      }
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }
  return hits;
}


export function findUntransliteratedGreetingName(text: string, lang: string): string[] {
  const langN = normalizeLanguageCode(lang);
  if (!NON_LATIN_SCRIPT_LANGS.has(langN)) return [];
  if (!text) return [];

  let firstLine = "";
  for (const line of text.split("\n")) {
    if (line.trim()) {
      firstLine = line.trim();
      break;
    }
  }
  if (!firstLine) return [];
  if (!HAS_NON_LATIN_RE.test(firstLine)) return [];

  // Tokenize the greeting line into letter words, keeping combining marks with
  // their base letter so a single non-Latin word stays one token.
  const wordRe = /[\p{L}\p{M}]+/gu;
  const words: string[] = [];
  let wm: RegExpExecArray | null;
  while ((wm = wordRe.exec(firstLine)) !== null) words.push(wm[0]);
  if (words.length < 2) return [];

  // word[0] is the greeting term. The prospect's name sits in the next slot.
  // We scan forward from word[1] and stop at the first non-Latin word, which is
  // the transliterated name or the start of the body. A Latin token before that
  // stop is an untransliterated greeting name. A brand name or acronym deeper in
  // the line is body content and is never reached. Acronyms and allowlisted
  // tokens are spared.
  const isLatinWord = (t: string): boolean => /^[\p{Script=Latin}\p{M}]+$/u.test(t);
  const isAcronym = (t: string): boolean => /^[A-Z]{2,6}$/.test(t);

  const hits: string[] = [];
  for (let i = 1; i < words.length; i++) {
    const token = words[i];
    if (!isLatinWord(token)) break; // transliterated name or body start
    if (LATIN_ALLOWLIST.has(token)) continue;
    if (BOILERPLATE_LATIN.has(token.toLowerCase())) continue;
    if (isAcronym(token)) continue;
    if (token.length < 2) continue;
    hits.push(token);
  }
  return hits;
}


// ============================================================================
// 9. AGGREGATOR
// ============================================================================

export interface NativenessV3Report {
  forbidden_phrases: string[];
  latin_token_runs: string[];
  forbidden_singletons: string[];
  x_not_y: string[];
  untransliterated_greeting_name: string[];
}


export function findAllNativenessViolations(text: string, lang: string): NativenessV3Report {
  return {
    forbidden_phrases: findForbiddenPhrases(text, lang),
    latin_token_runs: findLatinTokenRuns(text, lang),
    forbidden_singletons: findForbiddenSingletons(text, lang),
    x_not_y: findXNotY(text, lang),
    untransliterated_greeting_name: findUntransliteratedGreetingName(text, lang),
  };
}


export function hasAnyViolation(report: NativenessV3Report): boolean {
  return (
    report.forbidden_phrases.length > 0 ||
    report.latin_token_runs.length > 0 ||
    report.forbidden_singletons.length > 0 ||
    report.x_not_y.length > 0 ||
    report.untransliterated_greeting_name.length > 0
  );
}


// ============================================================================
// 10. PROMPT BUILDER (writer + critic blocks)
// ============================================================================

const TRANSLATION_TABLES: Record<string, string> = {
  "ru": "retention>удержание, install>установка, conversion>конверсия, targeting>таргетинг, traffic>трафик, fraud>фрод, creatives>креативы, bid>ставка, budget>бюджет, audience>аудитория, inventory>инвентарь, supply>поставка, payer>платящий пользователь, screening>скрининг, validation>валидация, verification>проверка, lookalike>лукэлайк, pre-bid>пре-бид, post-attribution>пост-атрибуция, cohort>когорта, programmatic>программатик, in-app>инапп, publisher>паблишер, performance>результаты, deliver>обеспечивать, anomaly detection>обнаружение аномалий, fraud filtering>фрод-фильтрация, semi-exclusive inventory>полуэксклюзивный инвентарь, post-attribution verification>пост-атрибуционная проверка, cohort-level anomaly detection>обнаружение аномалий на уровне когорт",
  "uk": "retention>утримання, install>встановлення, conversion>конверсія, targeting>таргетинг, traffic>трафік, fraud>фрод, creatives>креативи, bid>ставка, audience>аудиторія, inventory>інвентар, publisher>паблішер, in-app>в додатку, pre-bid>пре-бід, post-attribution>пост-атрибуція, lookalike>схожі аудиторії, cohort>когорта, geo-targeting>геотаргетинг, anomaly detection>виявлення аномалій, performance>результати, deliver>забезпечувати",
  "el": "retention>διατήρηση, install>εγκατάσταση, conversion>μετατροπή, targeting>στόχευση, traffic>επισκεψιμότητα, creatives>δημιουργικά, bid>προσφορά, audience>κοινό, publisher>εκδότης, in-app>εντός εφαρμογής, pre-bid>προ-προσφοράς, post-attribution>μετά την απόδοση, lookalike>παρόμοιο κοινό, cohort>ομάδα χρηστών, fraud>απάτη, anomaly detection>ανίχνευση ανωμαλιών, performance>απόδοση, deliver>παρέχω",
  "ja": "retention>リテンション, install>インストール, conversion>コンバージョン, traffic>トラフィック, creatives>クリエイティブ, audience>オーディエンス, targeting>ターゲティング, publisher>パブリッシャー, in-app>アプリ内, pre-bid>プレビッド, post-attribution>ポストアトリビューション, lookalike>類似オーディエンス, cohort>コホート, fraud>不正, fraud filtering>不正検知, anomaly detection>異常検知, performance>成果, deliver>提供する",
  "zh": "retention>留存, install>安装, conversion>转化, acquisition>获客, traffic>流量, creatives>素材, fraud>反作弊, audience>受众, bid>竞价, publisher>发布商, pre-bid>竞价前, post-attribution>归因后, lookalike>相似受众, cohort>群组, fraud filtering>反作弊过滤, in-app>应用内, geo-targeting>地域定向, screening>筛选, payer>付费用户, anomaly detection>异常检测, performance>表现, deliver>交付, semi-exclusive inventory>半独家流量资源",
  "ko": "retention>리텐션, install>설치, conversion>전환, traffic>트래픽, creatives>크리에이티브, targeting>타겟팅, audience>오디언스, publisher>퍼블리셔, in-app>인앱, pre-bid>프리비드, post-attribution>포스트어트리뷰션, lookalike>유사 오디언스, cohort>코호트, geo-targeting>지역 타겟팅, fraud filtering>프로드 필터링, anomaly detection>이상 탐지, performance>성과, deliver>제공",
  "he": "retention>שימור, install>התקנה, conversion>המרה, targeting>טירגוט, traffic>טראפיק, creatives>קריאייטיבים, bid>הצעת מחיר, audience>קהל יעד, publisher>פאבלישר, in-app>באפליקציה, pre-bid>פרה-ביד, post-attribution>פוסט-אטריביושן, lookalike>לוקאלייק, cohort>קוהורט, fraud>פראוד, anomaly detection>זיהוי חריגות, performance>ביצועים, deliver>לספק",
  "ar": "retention>الاحتفاظ, install>تثبيت, conversion>تحويل, targeting>استهداف, traffic>حركة المرور, creatives>المواد الإبداعية, bid>عرض السعر, audience>الجمهور المستهدف, publisher>الناشر, in-app>داخل التطبيق, pre-bid>ما قبل المزايدة, post-attribution>ما بعد الإسناد, lookalike>جمهور مشابه, cohort>مجموعة, fraud>الاحتيال, fraud filtering>تصفية الاحتيال, performance>الأداء, deliver>توفير",
  "fa": "retention>حفظ کاربر, install>نصب, conversion>تبدیل, targeting>هدف‌گذاری, traffic>ترافیک, creatives>محتوای تبلیغاتی, bid>پیشنهاد قیمت, audience>مخاطبان هدف, publisher>ناشر, in-app>درون‌برنامه‌ای, pre-bid>پیش از مزایده, post-attribution>پس از اسناد, lookalike>مخاطبان مشابه, cohort>گروه همدوره, fraud>تقلب, performance>عملکرد",
  "th": "completed order>ออเดอร์ที่สำเร็จ, publisher>ผู้เผยแพร่โฆษณา, in-app>ในแอป, pre-bid>การคัดกรองก่อนประมูล, post-attribution>หลังการระบุที่มา, lookalike>กลุ่มผู้ใช้ที่มีลักษณะคล้ายกัน, cohort>กลุ่มผู้ใช้, geo-targeting>การกำหนดเป้าหมายเชิงพื้นที่, fraud filtering>การกรองทราฟฟิกฉ้อโกง, anomaly detection>การตรวจจับความผิดปกติ, premium publisher inventory>อินเวนทอรีจากผู้เผยแพร่โฆษณาระดับพรีเมียม, creatives>ครีเอทีฟ, install>การติดตั้ง, conversion>การแปลง, retention>การคงผู้ใช้, targeting>การกำหนดเป้าหมาย, traffic>ทราฟฟิก, performance>ผลลัพธ์, deliver>ส่งมอบ, semi-exclusive inventory>อินเวนทอรีกึ่งเอกสิทธิ์, post-attribution verification>การตรวจสอบหลังการระบุที่มา, cohort-level anomaly detection>การตรวจจับความผิดปกติในระดับโคฮอร์ต",
  "hi": "retention>उपयोगकर्ता प्रतिधारण, install>स्थापन, conversion>रूपांतरण, targeting>लक्ष्यीकरण, traffic>ट्रैफ़िक, creatives>विज्ञापन सामग्री, publisher>प्रकाशक, in-app>ऐप के अंदर, pre-bid>बोली से पहले, post-attribution>एट्रिब्यूशन के बाद, lookalike>समान दर्शक, cohort>समूह, geo-targeting>भौगोलिक लक्ष्यीकरण, fraud filtering>धोखाधड़ी छँटाई, performance>प्रदर्शन, deliver>प्रदान करना",
  "bn": "retention>ব্যবহারকারী ধরে রাখা, install>স্থাপন, conversion>রূপান্তর, targeting>লক্ষ্যকরণ, traffic>ট্রাফিক, creatives>বিজ্ঞাপন সামগ্রী, publisher>প্রকাশক, in-app>অ্যাপের ভিতরে, pre-bid>বিডের পূর্বে যাচাই, post-attribution>অ্যাট্রিবিউশন-পরবর্তী, lookalike>সদৃশ দর্শক, cohort>সমগোত্রীয় গোষ্ঠী, fraud filtering>জালিয়াতি ছাঁকন, performance>কর্মক্ষমতা",
  "ur": "retention>صارف برقرار رکھنا, install>تنصیب, conversion>تبدیلی, targeting>ہدف بندی, traffic>ٹریفک, creatives>اشتہاری مواد, publisher>ناشر, in-app>ایپ کے اندر, pre-bid>بولی سے پہلے, post-attribution>اٹریبیوشن کے بعد, lookalike>مماثل سامعین, cohort>گروہ, fraud filtering>دھوکہ دہی کی چھانٹی, performance>کارکردگی",
  "es": "conversion>conversión, targeting>segmentación, install>instalación, retention>retención, traffic>tráfico, creatives>creativos, audience>audiencia, bid>puja, publisher>editor, in-app>dentro de la app, pre-bid>previo a la puja, post-attribution>post-atribución, geo-targeting>segmentación geográfica, lookalike>audiencias similares, cohort>cohorte, screening>filtrado, postback>devolución, fraud filtering>filtrado antifraude, anomaly detection>detección de anomalías, performance>rendimiento, deliver>entregar, semi-exclusive inventory>inventario semi-exclusivo, post-attribution verification>verificación post-atribución, cohort-level anomaly detection>detección de anomalías a nivel de cohorte",
  "pt": "retention>retenção, install>instalação, conversion>conversão, targeting>segmentação, traffic>tráfego, creatives>criativos, audience>audiência, bid>lance, publisher>editor, in-app>dentro do app, pre-bid>pré-lance, post-attribution>pós-atribuição, lookalike>audiências semelhantes, cohort>coorte, fraud filtering>filtragem antifraude, performance>desempenho, deliver>entregar, semi-exclusive inventory>inventário semi-exclusivo",
  "it": "conversion>conversione, install>installazione, traffic>traffico, creatives>creatività, bid>offerta, publisher>editore, post-attribution>post-attribuzione, lookalike>pubblico simile, cohort>coorte, geo-targeting>targeting geografico, retention>fidelizzazione, targeting>segmentazione, audience>pubblico, performance>prestazioni, deliver>fornire, semi-exclusive inventory>inventario semi-esclusivo, fraud filtering>filtro antifrode",
  "fr": "conversion>conversion, targeting>ciblage, install>installation, retention>rétention, traffic>trafic, creatives>créations, audience>audience, bid>enchère, publisher>éditeur, pre-bid>pré-enchère, lookalike>audiences similaires, cohort>cohorte, geo-targeting>ciblage géographique, fraud filtering>filtrage anti-fraude, performance>résultats, deliver>fournir, semi-exclusive inventory>inventaire semi-exclusif, post-attribution verification>vérification post-attribution",
  "de": "conversion>Umwandlung, targeting>Zielgruppenansprache, retention>Kundenbindung, traffic>Datenverkehr, creatives>Werbemittel, audience>Zielgruppe, bid>Gebot, publisher>Herausgeber, in-app>In der App, pre-bid>Vor-Gebot-Prüfung, post-attribution>Nach-Attribution, lookalike>Ähnliche Zielgruppe, cohort>Kohorte, geo-targeting>Geo-Ausrichtung, fraud>Betrug, fraud filtering>Betrugsfilterung, anomaly detection>Anomalieerkennung, programmatic>Programmatisch, install>Installation, inventory>Inventar, supply>Bestand, performance>Leistung, deliver>liefern, semi-exclusive inventory>halbexklusives Inventar, post-attribution verification>Nach-Attributions-Prüfung, cohort-level anomaly detection>Anomalieerkennung auf Kohortenebene",
  "pl": "retention>retencja, install>instalacja, conversion>konwersja, targeting>targetowanie, traffic>ruch, creatives>kreacje, bid>stawka, audience>grupa docelowa, publisher>wydawca, in-app>w aplikacji, post-attribution>post-atrybucja, lookalike>podobni użytkownicy, cohort>kohorta, geo-targeting>geotargetowanie, pre-bid>filtrowanie wstępne, fraud>oszustwo, fraud filtering>filtrowanie oszustw, performance>wyniki, deliver>dostarczać",
  "cs": "retention>retence, install>instalace, conversion>konverze, targeting>cílení, traffic>provoz, creatives>kreativy, bid>nabídka, publisher>vydavatel, in-app>v aplikaci, post-attribution>post-atribuce, lookalike>podobná publika, cohort>kohorta, geo-targeting>geografické cílení, fraud>podvod, fraud filtering>filtrace podvodů, performance>výkon, deliver>dodávat",
  "ro": "retention>retenție, install>instalare, conversion>conversie, targeting>direcționare, traffic>trafic, creatives>creații, audience>audiență, bid>licitație, publisher>editor, in-app>în aplicație, pre-bid>pre-licitație, post-attribution>post-atribuire, lookalike>audiențe similare, cohort>cohortă, fraud filtering>filtrare antifraudă, performance>performanță, deliver>livra",
  "hu": "retention>megtartás, install>telepítés, conversion>konverzió, targeting>célzás, traffic>forgalom, creatives>kreatívok, audience>célközönség, bid>ajánlat, publisher>kiadó, in-app>alkalmazáson belüli, lookalike>hasonló közönség, cohort>kohorsz, fraud filtering>csalásszűrés, performance>teljesítmény, deliver>biztosítani",
  "fi": "retention>säilytys, install>asennus, conversion>konversio, targeting>kohdentaminen, traffic>liikenne, creatives>mainosaineistot, audience>kohderyhmä, publisher>julkaisija, in-app>sovelluksen sisäinen, lookalike>samankaltainen yleisö, cohort>kohortti, fraud filtering>petossuodatus, performance>suorituskyky, deliver>toimittaa",
  "tr": "retention>elde tutma, install>kurulum, conversion>dönüşüm, targeting>hedefleme, traffic>trafik, creatives>reklam materyalleri, audience>hedef kitle, bid>teklif, publisher>yayıncı, in-app>uygulama içi, lookalike>benzer kitle, cohort>kohort, fraud filtering>dolandırıcılık filtreleme, performance>performans, deliver>sağlamak",
  "nl": "retention>retentie or behoud, install>installatie, conversion>conversie, targeting>doelgroepbenadering, traffic>verkeer, creatives>advertentiemateriaal, audience>doelgroep, bid>bod, publisher>uitgever, in-app>in de app, pre-bid>vooraanbod-controle, post-attribution>post-attributie, lookalike>vergelijkbare doelgroep, cohort>cohort, fraud filtering>fraudefiltering, performance>prestaties, deliver>leveren",
  "sv": "retention>kvarhållning, install>installation, conversion>konvertering, targeting>målgruppsinriktning, traffic>trafik, creatives>annonsmaterial, audience>målgrupp, publisher>utgivare, in-app>i appen, lookalike>liknande målgrupp, cohort>grupp, fraud filtering>bedrägerifiltrering, performance>prestanda, deliver>leverera",
  "no": "retention>tilbakeholdelse, install>installasjon, conversion>konvertering, targeting>målretting, traffic>trafikk, creatives>annonsemateriell, audience>målgruppe, publisher>utgiver, in-app>i appen, lookalike>lignende målgruppe, cohort>gruppe, fraud filtering>svindelfiltrering, performance>resultater, deliver>levere",
  "nb": "retention>tilbakeholdelse, install>installasjon, conversion>konvertering, targeting>målretting, traffic>trafikk, creatives>annonsemateriell, audience>målgruppe, publisher>utgiver, in-app>i appen, lookalike>lignende målgruppe, cohort>kohort, fraud filtering>svindelfiltrering, performance>resultater, deliver>levere",
  "da": "retention>fastholdelse, install>installation, conversion>konvertering, targeting>målretning, traffic>trafik, creatives>annoncemateriale, audience>målgruppe, publisher>udgiver, in-app>i appen, lookalike>lignende målgruppe, cohort>kohorte, fraud filtering>svindelfiltrering, performance>resultater, deliver>levere",
  "vi": "install>cài đặt, conversion>chuyển đổi, retention>giữ chân người dùng, targeting>nhắm mục tiêu, traffic>lưu lượng, audience>nhóm mục tiêu, publisher>nhà xuất bản, in-app>trong ứng dụng, fraud filtering>lọc gian lận, creatives>nội dung quảng cáo, bid>giá thầu, pre-bid>trước đấu giá, post-attribution>sau phân bổ, lookalike>nhóm tương tự, cohort>nhóm người dùng, anomaly detection>phát hiện bất thường, performance>hiệu suất, deliver>cung cấp, semi-exclusive inventory>kho quảng cáo bán độc quyền, post-attribution verification>kiểm tra sau phân bổ, cohort-level anomaly detection>phát hiện bất thường ở cấp nhóm người dùng",
  "id": "install>instalasi, conversion>konversi, retention>retensi, targeting>penargetan, traffic>lalu lintas, audience>audiens, publisher>penerbit, in-app>dalam aplikasi, fraud filtering>penyaringan penipuan, creatives>materi iklan, bid>tawaran, pre-bid>pra-tawaran, post-attribution>pasca-atribusi, lookalike>audiens serupa, cohort>kelompok pengguna, performance>kinerja, deliver>memberikan, semi-exclusive inventory>inventaris semi-eksklusif",
  "ms": "install>pemasangan, conversion>penukaran, retention>pengekalan, targeting>penyasaran, traffic>trafik, audience>khalayak, publisher>penerbit, in-app>dalam aplikasi, fraud filtering>penapisan penipuan, creatives>bahan iklan, bid>tawaran, pre-bid>pra-tawaran, post-attribution>pasca-atribusi, lookalike>khalayak serupa, cohort>kumpulan pengguna, performance>prestasi, deliver>menyampaikan",
  "fil": "install>pag-install, conversion>pagbabago, retention>pagpapanatili, targeting>pag-target, traffic>trapiko, audience>target na grupo, publisher>tagapaglathala, in-app>sa loob ng app, fraud filtering>pagsasala ng pandaraya, creatives>mga kreatibo, bid>alok, lookalike>katulad na audience, cohort>pangkat ng gumagamit, performance>pagganap, deliver>maghatid",
  "tl": "install>pag-install, conversion>pagbabago, retention>pagpapanatili, targeting>pag-target, traffic>trapiko, audience>tagapakinig, publisher>tagapaglathala, in-app>sa loob ng app, fraud filtering>pagsasala ng pandaraya, creatives>mga kreatibo, bid>alok, lookalike>katulad na audience, cohort>pangkat, performance>pagganap, deliver>maghatid",
  "sw": "install>kusakinisha, conversion>kubadilisha, retention>kuhifadhi watumiaji, targeting>kulenga, traffic>trafiki, audience>hadhira, publisher>mchapishaji, in-app>ndani ya programu-tumizi, fraud filtering>kuchuja udanganyifu, creatives>vifaa vya matangazo, bid>zabuni, lookalike>hadhira inayofanana, cohort>kundi la watumiaji, performance>matokeo, deliver>kutoa",
};


function buildUniversalBlock(languageTag: string): string {
  return (
`- LANGUAGE NATIVENESS RULES for tag ${languageTag} (v3 Reading A++):
  You are writing AS a native speaker of this language who works in
  adtech, NOT translating from English.

  STRICT LOCALIZATION POLICY (overrides every earlier guide and rule):

  The ONLY Latin/English tokens permitted inside the email body are:
    (a) pure acronyms: CPI, CPA, CPM, CPC, CTR, CVR, ROAS, ROI, AOV,
        ARPU, ARPPU, ARPDAU, LTV, MAU, DAU, D1, D3, D7, D14, D30,
        D60, D90, MMP, SDK, IAP, OEM, API, KPI, KYC, AML, AI, ML,
        NLP, LLM, DSP, SSP, RTB, B2B, B2C, P2P, iOS, USD, EUR, GBP,
        JPY, CNY, INR, THB, MYR, SGD, IDR, VND, PHP, BRL, MXN, ZAR.
    (b) proper nouns: company brand names (Meta, Google, Apple, TikTok,
        Snapchat, Xiaomi, Huawei, OPPO, Vivo, AppsFlyer, Adjust, etc.),
        the prospect's own brand and product names, and any
        third-party brand or service named in the email.

  EVERY OTHER English word — single tokens AND multi-word phrases —
  MUST be translated to the target language. This includes:
    * Capitalized loan-nouns: German 'Conversion' becomes 'Umwandlung';
      'Performance' becomes 'Leistung'; 'Retention' becomes
      'Kundenbindung'. The historical German convention of
      capitalizing English loan-nouns as German nouns is REJECTED
      under v3.
    * Common adtech content words: install, conversion, retention,
      cohort, lookalike, audience, publisher, creative, screening,
      validation, verification, attribution, optimization, anomaly,
      detection, filtering, modeling, inventory, supply, placement,
      postback, segment, payer, signup, subscriber, campaign,
      performance, channel, source, partner, platform, network,
      system, data, analytics, pipeline, feature, launch, experiment,
      test, tier, trial, subscription, event, click, impression, view,
      deposit, purchase, registration, order, bid, budget, spend,
      deliver, optimize, convert, acquire, scale, retain, validate,
      monitor, track, drive, boost, deploy, premium, exclusive, durable.
    * Multi-word English phrases: 'semi-exclusive inventory',
      'pre-bid screening', 'post-attribution verification',
      'cohort-level anomaly detection', 'multi-layer fraud filtering',
      'payer-lookalike modeling', 'first-party IAP postbacks',
      'Android-heavy audience', 'publisher mix', 'one-time spenders',
      'rewarded video', 'playable ads', 'genre signal',
      'open-world hook', 'GTA-style gameplay loop', 'F2P-only users',
      'fraud filtering', 'anomaly detection' MUST be translated
      entirely. Splitting these phrases (translating one word and
      leaving another in English) is also forbidden.
`
  );
}


function buildXNotYBlock(): string {
  return (
`
  * X-NOT-Y COMMA-NEGATION (severity: critical, applies to ALL languages
    including English):
    Do NOT use the comma-plus-negation contrast pattern. Phrases like
    'performance partners, not raw installs' or 'approved events,
    not signups' or any target-language equivalent (', no', ', не',
    ', nicht', ', ไม่ใช่', etc.) read as classic LLM cadence and
    humans detect it instantly as AI writing.

    Acceptable alternatives: 'rather than', 'instead of', or a full
    rephrase that drops the contrast entirely. In other languages, use
    the natural-language equivalent of 'rather than' or rephrase.
    Example (WRONG):
      'buying the install-to-deposit journey through referral overlays
       and performance partners, not raw installs'
    Example (RIGHT):
      'shifting spend toward placements rather than raw installs'
`
  );
}


function buildNameTransliterationBlock(lang: string): string {
  if (!NON_LATIN_SCRIPT_LANGS.has(lang)) return "";
  return (
`
  * GREETING-NAME TRANSLITERATION (severity: critical, non-Latin-script
    targets only):
    The prospect's first name in the greeting MUST be transliterated
    into the target script. Writing 'เรียน Songsitt' is wrong;
    'เรียน ทรงสิทธิ์' is right. 'Hi Manish' in a Hindi email is
    wrong; 'नमस्ते मनीश' is right. Native speakers always write
    names in the local script even when the person's name has a
    standard Latin spelling.

    Pick a reasonable phonetic transliteration if no canonical form
    is known, and use it consistently throughout the email.

    The sender's signature at the bottom of the email is kept in
    Latin (it is the sender's actual signed name); ONLY the
    greeting name is transliterated.
`
  );
}


function buildScriptMixingBlock(lang: string): string {
  if (!NON_LATIN_SCRIPT_LANGS.has(lang)) return "";
  return (
`
  * SCRIPT-MIXING IS FORBIDDEN (severity: critical):
    NEVER place a Latin word directly adjacent to non-Latin script
    characters. The ONLY exception is curated acronyms (CPI, ROAS,
    LTV, D7, etc.) which may be space- or hyphen-separated from
    non-Latin words ('D7-удержание', 'ROAS-стратегия').
`
  );
}


function buildConsistencyBlock(): string {
  return (
`
  * CONSISTENCY: once you choose a target-language form for a term,
    use that SAME form every time the term appears in the email.
    Switching between forms (English in one paragraph, translation in
    another) is a critical error.
`
  );
}


function buildNoCarveoutBlock(): string {
  return (
`
  CRITICAL: v3 Reading A++ removes the historical 'ENGLISH-TOLERANT'
  and 'ENGLISH-HEAVY' carve-outs that previously applied to German,
  Dutch, Nordic languages, Vietnamese, Thai, Indonesian, Malay,
  Filipino, Tagalog, and Swahili. All 35 supported languages are now
  held to the same strict translation standard. German, Vietnamese,
  and Thai emails follow exactly the same rule as Russian, Chinese,
  Japanese, or Arabic emails: acronyms and proper nouns only in Latin
  script, everything else translated.`
  );
}


/**
 * Top-level builder for the writer prompt. For English targets, returns only
 * the universal X-not-Y rule. For non-English, returns the full Reading-A++
 * block including the per-language translation reference.
 */
export function buildNativenessBlockV3(languageTag: string | null | undefined): string {
  const lang = normalizeLanguageCode(languageTag);

  if (lang === "" || lang === "en") {
    return (
      "- WRITING STYLE RULES (universal, applies to every language):\n" +
      buildXNotYBlock().trimStart()
    );
  }

  const parts: string[] = [buildUniversalBlock(String(languageTag))];

  const table = TRANSLATION_TABLES[lang];
  if (table) {
    parts.push(
`
  TRANSLATION REFERENCE for ${languageTag}: ${table}.
  This list is not exhaustive — translate ALL English content
  words and phrases, not only the ones listed.
`
    );
  } else {
    parts.push(
`
  NOTE for ${languageTag}: no per-language translation reference
  table is shipped for this code. Apply the universal rule —
  translate every English content word and multi-word phrase to
  the target language. Only curated acronyms and proper nouns
  may remain in Latin script.
`
    );
  }

  parts.push(buildXNotYBlock());
  parts.push(buildNameTransliterationBlock(lang));
  parts.push(buildScriptMixingBlock(lang));
  parts.push(buildConsistencyBlock());
  parts.push(buildNoCarveoutBlock());

  return parts.join("");
}


/**
 * Concise critic-facing rules. Used by the critic prompt to score the draft
 * against the v3 policy. Shorter than the writer block — just the rules.
 */
export function buildCriticNativenessBlockV3(languageTag: string | null | undefined): string {
  const lang = normalizeLanguageCode(languageTag);
  if (lang === "" || lang === "en") {
    return (
`UNIVERSAL STYLE RULES (apply even to English):
- X-NOT-Y comma-negation pattern (', not raw installs' / ', no the equivalent'
  in any language) is forbidden. Use 'rather than' or 'instead of' or rephrase.
  Flag every instance.`
    );
  }

  const table = TRANSLATION_TABLES[lang] || "";
  const isNonLatin = NON_LATIN_SCRIPT_LANGS.has(lang);

  return (
`LANGUAGE-SPECIFIC CHECKS for ${languageTag} (v3 Reading A++):

The ONLY Latin tokens permitted in this email are pure acronyms (CPI, CPA,
ROAS, LTV, MMP, SDK, IAP, KPI, KYC, D7, D30, AI, ML, etc.) and proper nouns
(Meta, Google, Xiaomi, AppsFlyer, brand names, person names with standard
Latin spelling). Every other English word — single tokens AND multi-word
phrases — is a violation.

Flag as language_naturalness violations:
- Any single English content word: cohort, install, conversion, retention,
  lookalike, audience, publisher, creative, screening, validation,
  verification, attribution, optimization, anomaly, detection, filtering,
  modeling, inventory, supply, placement, postback, segment, payer,
  signup, subscriber, campaign, performance, channel, source, partner,
  platform, network, system, data, analytics, pipeline, feature, launch,
  experiment, test, tier, trial, subscription, event, click, impression,
  view, deposit, purchase, registration, order, bid, budget, spend,
  deliver, optimize, convert, acquire, scale, retain, validate, monitor,
  track, drive, boost, deploy, premium, exclusive, durable. Includes
  capitalized loan-nouns: German 'Conversion' → 'Umwandlung'; German
  'Performance' → 'Leistung'.
- Any multi-word English phrase: 'semi-exclusive inventory', 'pre-bid
  screening', 'post-attribution verification', 'cohort-level anomaly
  detection', 'multi-layer fraud filtering', 'payer-lookalike modeling',
  'first-party IAP postbacks', 'Android-heavy audience', 'publisher mix',
  'one-time spenders', 'rewarded video', 'playable ads', 'genre signal',
  'open-world hook', 'GTA-style gameplay loop', 'F2P-only users',
  'fraud filtering', 'anomaly detection'.
${table ? `- Translation reference for ${languageTag}: ${table}` : ""}
${isNonLatin ?
`- SCRIPT-MIXING: any Latin word directly adjacent to non-Latin script
  characters in a compound term (acronyms hyphenated to non-Latin words
  are acceptable: 'D7-удержание', 'ROAS-стратегия').
- GREETING-NAME TRANSLITERATION: the prospect's first name in the greeting
  line MUST be in target script. 'เรียน Songsitt' is wrong; 'เรียน ทรงสิทธิ์'
  is right. 'Hi Manish' in a Hindi email is wrong; 'नमस्ते मनीश' is right.
  Sender signature stays in Latin.`
: ""}

UNIVERSAL STYLE RULE (every language, including this one):
- X-NOT-Y comma-negation pattern (', not Y' / ', нет Y' / ', nicht Y' /
  ', ไม่ใช่ Y' / ', không phải Y' / ', 不是 Y' / ', ではなく Y' etc.) is
  forbidden. Use 'rather than' / 'instead of' or rephrase.

If the draft has 3+ violations across these categories, score language_naturalness 1 and set needs_rewrite = true.
If 1-2 violations, score 2-3 and set needs_rewrite = true. Quote the
specific offending tokens / phrases in "issues".`
  );
}
