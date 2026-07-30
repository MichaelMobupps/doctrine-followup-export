/**
 * doctrineRules.ts
 *
 * Data tables and helpers for enforcing the Michael SDR Formula and the
 * language-nativeness rules across the Followuper writer, critic, and
 * deterministic lint.
 *
 * Ported from the MobUpps Prospector app's
 * `prospector/stages/doctrine_rules.py`. The same knowledge base lives in
 * both apps; long-term this should move into a shared `lib/` package.
 *
 * Six data tables (36 languages where applicable):
 *   * MANDATED_HOW_OPENERS \u2014 acceptable methodology-signal phrases per language
 *   * HEDGE_PATTERNS \u2014 hedge expressions that must not precede a number
 *   * HYPE_ADJECTIVES \u2014 marketing-deck adjectives banned in body
 *   * APPROVED_DIFFERENTIATOR_ANCHORS \u2014 the three approved-anchor concepts
 *   * FORBIDDEN_DIFFERENTIATOR_PATTERNS \u2014 CPA-collapse failure patterns
 *   * MULTI_EVENT_PATTERNS \u2014 \"optimize on X or Y\" failure patterns
 *
 * For the Followuper, only the hedge / hype / forbidden / multi-event tables
 * are wired into the deterministic lint; HOW-openers and approved-anchor
 * tables are exposed for any caller that needs them but follow-up emails
 * don't have a HOW or DIFFERENTIATOR section in the cold-outbound sense.
 *
 * Coverage is rich for English, Spanish, Portuguese, Italian, French,
 * German, Russian, Ukrainian, Polish, Czech, Romanian, Hungarian, Greek,
 * Japanese, Chinese, Korean, Hebrew, Arabic, Persian, Hindi, Bengali, Urdu,
 * Thai, Vietnamese, Indonesian, Malay, Filipino/Tagalog, Turkish, Swahili,
 * Dutch, Swedish, Norwegian, Danish, Finnish. Where deterministic coverage
 * is partial, the critic (LLM) handles enforcement semantically.
 */

import { normalizeLanguageCode } from "./languageNativeness";

// =============================================================================
// 1. MANDATED HOW OPENERS
// =============================================================================
// Reference data only \u2014 follow-ups have no HOW section, but this lives here
// so the same module covers both flows when reused.

export const MANDATED_HOW_OPENERS: Record<string, string[]> = {
  en: [
    "the way that we work is",
    "the way we work is",
    "our way of working is",
    "the way our model works is",
    "our operating model is",
    "operationally, we",
  ],
  es: [
    "la forma en que trabajamos es",
    "nuestra forma de trabajar es",
    "operativamente, nosotros",
    "operativamente, nuestro modelo",
    "nuestro m\u00e9todo de trabajo es",
  ],
  pt: [
    "a forma como trabalhamos \u00e9",
    "a nossa forma de trabalhar \u00e9",
    "operacionalmente, n\u00f3s",
    "o nosso m\u00e9todo de trabalho \u00e9",
  ],
  it: [
    "il modo in cui lavoriamo \u00e8",
    "il nostro metodo di lavoro \u00e8",
    "operativamente, noi",
  ],
  fr: [
    "la fa\u00e7on dont nous travaillons est",
    "notre fa\u00e7on de travailler est",
    "op\u00e9rationnellement, nous",
    "notre m\u00e9thode de travail est",
  ],
  de: [
    "unsere arbeitsweise ist",
    "operativ arbeiten wir",
    "die art, wie wir arbeiten, ist",
  ],
  ru: [
    "\u043f\u0440\u0438\u043d\u0446\u0438\u043f \u043d\u0430\u0448\u0435\u0439 \u0440\u0430\u0431\u043e\u0442\u044b \u0437\u0430\u043a\u043b\u044e\u0447\u0430\u0435\u0442\u0441\u044f",
    "\u043c\u044b \u0440\u0430\u0431\u043e\u0442\u0430\u0435\u043c \u0442\u0430\u043a\u0438\u043c \u043e\u0431\u0440\u0430\u0437\u043e\u043c",
    "\u043e\u043f\u0435\u0440\u0430\u0446\u0438\u043e\u043d\u043d\u043e \u043c\u044b",
    "\u043d\u0430\u0448 \u043f\u043e\u0434\u0445\u043e\u0434 \u0437\u0430\u043a\u043b\u044e\u0447\u0430\u0435\u0442\u0441\u044f",
  ],
  uk: [
    "\u043f\u0440\u0438\u043d\u0446\u0438\u043f \u043d\u0430\u0448\u043e\u0457 \u0440\u043e\u0431\u043e\u0442\u0438 \u043f\u043e\u043b\u044f\u0433\u0430\u0454",
    "\u043e\u043f\u0435\u0440\u0430\u0446\u0456\u0439\u043d\u043e \u043c\u0438",
    "\u043d\u0430\u0448 \u043f\u0456\u0434\u0445\u0456\u0434 \u043f\u043e\u043b\u044f\u0433\u0430\u0454",
  ],
  pl: [
    "spos\u00f3b naszej pracy polega na",
    "operacyjnie pracujemy",
    "nasza metoda pracy polega",
  ],
  cs: [
    "zp\u016fsob na\u0161\u00ed pr\u00e1ce spo\u010d\u00edv\u00e1",
    "opera\u010dn\u011b pracujeme",
  ],
  ro: [
    "modul \u00een care lucr\u0103m este",
    "opera\u021bional, noi",
  ],
  hu: [
    "a munkam\u00f3dszer\u00fcnk l\u00e9nyege",
    "m\u0171k\u00f6d\u00e9s\u00fcnk l\u00e9nyege",
  ],
  fi: [
    "toimintatapamme on",
    "ty\u00f6skentelytapamme on",
  ],
  tr: [
    "\u00e7al\u0131\u015fma \u015feklimiz",
    "operasyonel olarak biz",
    "\u00e7al\u0131\u015fma y\u00f6ntemimiz",
  ],
  nl: [
    "onze werkwijze is",
    "operationeel werken wij",
    "onze manier van werken is",
  ],
  sv: [
    "v\u00e5rt s\u00e4tt att arbeta \u00e4r",
    "operativt arbetar vi",
  ],
  no: [
    "v\u00e5r arbeidsm\u00e5te er",
    "operativt jobber vi",
  ],
  nb: [
    "v\u00e5r arbeidsm\u00e5te er",
    "operativt jobber vi",
  ],
  da: [
    "vores arbejdsm\u00e5de er",
    "operationelt arbejder vi",
  ],
  el: [
    "\u03bf \u03c4\u03c1\u03cc\u03c0\u03bf\u03c2 \u03c0\u03bf\u03c5 \u03b5\u03c1\u03b3\u03b1\u03b6\u03cc\u03bc\u03b1\u03c3\u03c4\u03b5 \u03b5\u03af\u03bd\u03b1\u03b9",
    "\u03bb\u03b5\u03b9\u03c4\u03bf\u03c5\u03c1\u03b3\u03b9\u03ba\u03ac, \u03b5\u03bc\u03b5\u03af\u03c2",
  ],
  ja: [
    "\u79c1\u305f\u3061\u306e\u53d6\u308a\u7d44\u307f\u65b9\u306f",
    "\u5f0a\u793e\u306e\u5b9f\u884c\u30a2\u30d7\u30ed\u30fc\u30c1\u306f",
    "\u904b\u7528\u306b\u3064\u3044\u3066\u306f",
  ],
  zh: [
    "\u6211\u4eec\u7684\u5de5\u4f5c\u65b9\u5f0f\u662f",
    "\u6211\u4eec\u7684\u8fd0\u8425\u65b9\u5f0f\u662f",
    "\u8fd0\u8425\u4e0a\uff0c\u6211\u4eec",
  ],
  ko: [
    "\uc800\ud76c\uac00 \uc77c\ud558\ub294 \ubc29\uc2dd\uc740",
    "\uc6b4\uc601 \ub300\uc0c1, \uc800\ud76c",
    "\uc800\ud76c\uc758 \uc6b4\uc601 \ubc29\uc2dd\uc740",
  ],
  he: [
    "\u05d4\u05d0\u05d5\u05e4\u05df \u05e9\u05d1\u05d5 \u05d0\u05e0\u05d5 \u05e2\u05d5\u05d1\u05d3\u05d9\u05dd",
    "\u05de\u05d1\u05d7\u05d9\u05e0\u05d4 \u05ea\u05e4\u05e2\u05d5\u05dc\u05d9\u05ea, \u05d0\u05e0\u05d7\u05e0\u05d5",
    "\u05e9\u05d9\u05d8\u05ea \u05d4\u05e2\u05d1\u05d5\u05d3\u05d4 \u05e9\u05dc\u05e0\u05d5 \u05d4\u05d9\u05d0",
  ],
  ar: [
    "\u0637\u0631\u064a\u0642\u0629 \u0639\u0645\u0644\u0646\u0627 \u0647\u064a",
    "\u0645\u0646 \u0627\u0644\u0646\u0627\u062d\u064a\u0629 \u0627\u0644\u062a\u0634\u063a\u064a\u0644\u064a\u0629\u060c \u0646\u062d\u0646",
    "\u0623\u0633\u0644\u0648\u0628\u0646\u0627 \u0641\u064a \u0627\u0644\u0639\u0645\u0644 \u0647\u0648",
  ],
  fa: [
    "\u0631\u0648\u0634 \u06a9\u0627\u0631 \u0645\u0627 \u0627\u06cc\u0646 \u0627\u0633\u062a \u06a9\u0647",
    "\u0627\u0632 \u0646\u0638\u0631 \u0627\u062c\u0631\u0627\u06cc\u06cc\u060c \u0645\u0627",
  ],
  hi: [
    "\u0939\u092e\u093e\u0930\u0940 \u0915\u093e\u0930\u094d\u092f\u092a\u094d\u0930\u0923\u093e\u0932\u0940 \u0939\u0948 \u0915\u093f",
    "\u0938\u0902\u091a\u093e\u0932\u0928 \u0915\u0940 \u0926\u0943\u0937\u094d\u091f\u093f \u0938\u0947, \u0939\u092e",
  ],
  bn: [
    "\u0986\u09ae\u09be\u09a6\u09c7\u09b0 \u0995\u09be\u099c \u0995\u09b0\u09be\u09b0 \u09aa\u09a6\u09cd\u09a7\u09a4\u09bf \u09b9\u09b2\u09cb",
    "\u09aa\u09b0\u09bf\u099a\u09be\u09b2\u09a8\u09be\u0997\u09a4\u09ad\u09be\u09ac\u09c7, \u0986\u09ae\u09b0\u09be",
  ],
  ur: [
    "\u06c1\u0645\u0627\u0631\u0627 \u0637\u0631\u06cc\u0642\u06c1 \u06a9\u0627\u0631 \u06cc\u06c1 \u06c1\u06d2 \u06a9\u06c1",
    "\u0622\u067e\u0631\u06cc\u0634\u0646\u0644 \u0637\u0648\u0631 \u067e\u0631\u060c \u06c1\u0645",
  ],
  th: [
    "\u0e27\u0e34\u0e18\u0e35\u0e01\u0e32\u0e23\u0e17\u0e33\u0e07\u0e32\u0e19\u0e02\u0e2d\u0e07\u0e40\u0e23\u0e32\u0e04\u0e37\u0e2d",
    "\u0e27\u0e34\u0e18\u0e35\u0e01\u0e32\u0e23\u0e14\u0e33\u0e40\u0e19\u0e34\u0e19\u0e07\u0e32\u0e19\u0e02\u0e2d\u0e07\u0e40\u0e23\u0e32\u0e04\u0e37\u0e2d",
    "\u0e43\u0e19\u0e40\u0e0a\u0e34\u0e07\u0e1b\u0e0f\u0e34\u0e1a\u0e31\u0e15\u0e34 \u0e40\u0e23\u0e32",
  ],
  vi: [
    "c\u00e1ch ch\u00fang t\u00f4i l\u00e0m vi\u1ec7c l\u00e0",
    "ph\u01b0\u01a1ng th\u1ee9c v\u1eadn h\u00e0nh c\u1ee7a ch\u00fang t\u00f4i l\u00e0",
    "v\u1ec1 m\u1eb7t v\u1eadn h\u00e0nh, ch\u00fang t\u00f4i",
  ],
  id: [
    "cara kami bekerja adalah",
    "metode kerja kami adalah",
    "secara operasional, kami",
  ],
  ms: [
    "cara kami bekerja ialah",
    "kaedah kerja kami ialah",
    "secara operasi, kami",
  ],
  fil: [
    "ang paraan ng aming pagtatrabaho ay",
    "sa operasyon, kami ay",
  ],
  tl: [
    "ang paraan ng aming pagtatrabaho ay",
    "sa operasyon, kami ay",
  ],
  sw: [
    "njia tunavyofanya kazi ni",
    "kiutendaji, sisi",
  ],
};


// =============================================================================
// 2. HEDGE PATTERNS (banned before numbers)
// =============================================================================

const HEDGE_SOURCES: Record<string, RegExp[]> = {
  en: [
    /\baround\s+\d/i,
    /\bapproximately\s+\d/i,
    /\broughly\s+\d/i,
    /\babout\s+\d/i,
    /\bsomewhere\s+(?:around|near)\s+\d/i,
    /\bin\s+the\s+ballpark\s+of\s+\d/i,
    /~\s*\d/,
    /\b\d+\s+or\s+so\b/i,
  ],
  es: [
    /\balrededor\s+de\s+\d/i,
    /\baproximadamente\s+\d/i,
    /\bcerca\s+de\s+\d/i,
    /\bunos\s+\d/i,
    /\bunas\s+\d/i,
    /\bm\u00e1s\s+o\s+menos\s+\d/i,
  ],
  pt: [
    /\bcerca\s+de\s+\d/i,
    /\baproximadamente\s+\d/i,
    /\bem\s+torno\s+de\s+\d/i,
    /\buns\s+\d/i,
    /\bumas\s+\d/i,
  ],
  it: [
    /\bcirca\s+\d/i,
    /\bapprossimativamente\s+\d/i,
    /\bintorno\s+a\s+\d/i,
  ],
  fr: [
    /\benviron\s+\d/i,
    /\bapproximativement\s+\d/i,
    /\b\u00e0\s+peu\s+pr\u00e8s\s+\d/i,
    /\bpr\u00e8s\s+de\s+\d/i,
  ],
  de: [
    /\bungef\u00e4hr\s+\d/i,
    /\betwa\s+\d/i,
    /\brund\s+\d/i,
    /\bca\.?\s+\d/i,
    /\bzirka\s+\d/i,
  ],
  ru: [
    /\u043e\u043a\u043e\u043b\u043e\s+\d/iu,
    /\u043f\u0440\u0438\u043c\u0435\u0440\u043d\u043e\s+\d/iu,
    /\u043f\u0440\u0438\u0431\u043b\u0438\u0437\u0438\u0442\u0435\u043b\u044c\u043d\u043e\s+\d/iu,
    /~\s*\d/,
  ],
  uk: [
    /\u0431\u043b\u0438\u0437\u044c\u043a\u043e\s+\d/iu,
    /\u043f\u0440\u0438\u0431\u043b\u0438\u0437\u043d\u043e\s+\d/iu,
    /\u043f\u0440\u0438\u043c\u0456\u0440\u043d\u043e\s+\d/iu,
  ],
  pl: [
    /\boko\u0142o\s+\d/iu,
    /\bmniej\s+wi\u0119cej\s+\d/iu,
    /\bplus\s+minus\s+\d/i,
  ],
  cs: [
    /\bp\u0159ibli\u017en\u011b\s+\d/iu,
    /\bkolem\s+\d/iu,
    /\basi\s+\d/iu,
  ],
  ro: [
    /\baproximativ\s+\d/iu,
    /\bcam\s+\d/iu,
    /\b\u00een\s+jur\s+de\s+\d/iu,
  ],
  hu: [
    /\bk\u00f6r\u00fclbel\u00fcl\s+\d/iu,
    /\bnagyj\u00e1b\u00f3l\s+\d/iu,
    /\b\u00e1tlagosan\s+\d/iu,
  ],
  fi: [
    /\bnoin\s+\d/iu,
    /\bsuunnilleen\s+\d/iu,
  ],
  tr: [
    /\byakla\u015f\u0131k\s+\d/iu,
    /\btakriben\s+\d/iu,
    /\bcivar\u0131nda\s+\d/iu,
  ],
  nl: [
    /\bongeveer\s+\d/i,
    /\bcirca\s+\d/i,
    /\brond\s+(?:de\s+)?\d/i,
  ],
  sv: [
    /\bungef\u00e4r\s+\d/iu,
    /\bcirka\s+\d/iu,
    /\bca\.?\s+\d/iu,
    /\bomkring\s+\d/iu,
  ],
  no: [
    /\bomtrent\s+\d/iu,
    /\bcirca\s+\d/iu,
    /\bca\.?\s+\d/iu,
    /\brundt\s+\d/iu,
  ],
  nb: [
    /\bomtrent\s+\d/iu,
    /\bcirca\s+\d/iu,
    /\bca\.?\s+\d/iu,
    /\brundt\s+\d/iu,
  ],
  da: [
    /\bcirka\s+\d/iu,
    /\bca\.?\s+\d/iu,
    /\bomkring\s+\d/iu,
  ],
  el: [
    /\u03c0\u03b5\u03c1\u03af\u03c0\u03bf\u03c5\s+\d/iu,
    /\u03c3\u03b5\s+\u03b3\u03b5\u03bd\u03b9\u03ba\u03ad\u03c2\s+\u03b3\u03c1\u03b1\u03bc\u03bc\u03ad\u03c2\s+\d/iu,
  ],
  ja: [
    /\u7d04\s*\d/u,
    /\u304a\u3088\u305d\s*\d/u,
    /\u307b\u307c\s*\d/u,
    /\d+\s*\u7a0b\u5ea6\b/u,
    /\d+\s*\u524d\u5f8c\b/u,
  ],
  zh: [
    /\u7ea6\s*\d/u,
    /\u5927\u7ea6\s*\d/u,
    /\u5927\u6982\s*\d/u,
    /\d+\s*\u5de6\u53f3\b/u,
  ],
  ko: [
    /\uc57d\s*\d/u,
    /\ub300\ub7b5\s*\d/u,
    /\d+\s*\uc815\ub3c4\b/u,
  ],
  he: [
    /\u05d1\u05e2\u05e8\u05da\s+\d/u,
    /\u05db\u05de\u05d5\s+\d/u,
    /\u05d1\u05e1\u05d1\u05d9\u05d1\u05d5\u05ea\s+\d/u,
  ],
  ar: [
    /\u062d\u0648\u0627\u0644\u064a\s+\d/u,
    /\u062a\u0642\u0631\u064a\u0628\u0627\u064b\s+\d/u,
    /\u0646\u062d\u0648\s+\d/u,
  ],
  fa: [
    /\u062d\u062f\u0648\u062f\u0627\u064b\s+\d/u,
    /\u062a\u0642\u0631\u06cc\u0628\u0627\u064b\s+\d/u,
    /\u062d\u062f\u0648\u062f\s+\d/u,
  ],
  hi: [
    /\u0932\u0917\u092d\u0917\s+\d/u,
    /\u0915\u0930\u0940\u092c\s+\d/u,
    /\u0905\u0928\u0941\u092e\u093e\u0928\u0924\u0903\s+\d/u,
  ],
  bn: [
    /\u09aa\u09cd\u09b0\u09be\u09af\u09bc\s+\d/u,
    /\u0995\u09ae\u09cd\u09b0\u09cb\u09ac\u09c7\u09b6\s+\d/u,
  ],
  ur: [
    /\u062a\u0642\u0631\u06cc\u0628\u0627\u064b\s+\d/u,
    /\u0644\u06af\u0628\u06be\u06af\s+\d/u,
  ],
  th: [
    /\u0e1b\u0e23\u0e30\u0e21\u0e32\u0e13\s+\d/u,
    /\u0e23\u0e32\u0e27\s+\d/u,
    /\u0e23\u0e32\u0e27\s+\u0e46\s+\d/u,
  ],
  vi: [
    /\bkho\u1ea3ng\s+\d/iu,
    /\b\u0111\u1ed9\s+\d/iu,
  ],
  id: [
    /\bsekitar\s+\d/i,
    /\bkira[-\s]?kira\s+\d/i,
    /\bkurang\s+lebih\s+\d/i,
  ],
  ms: [
    /\bsekitar\s+\d/i,
    /\bkira[-\s]?kira\s+\d/i,
    /\blebih\s+kurang\s+\d/i,
  ],
  fil: [
    /\bhumigit[-\s]?kumulang\s+\d/i,
    /\bmga\s+\d/i,
  ],
  tl: [
    /\bhumigit[-\s]?kumulang\s+\d/i,
    /\bmga\s+\d/i,
  ],
  sw: [
    /\btakriban\s+\d/i,
    /\bkaribu\s+\d/i,
  ],
};

export const HEDGE_PATTERNS: Record<string, RegExp[]> = HEDGE_SOURCES;


// =============================================================================
// 3. HYPE ADJECTIVES (banned in body)
// =============================================================================

export const HYPE_ADJECTIVES: Record<string, string[]> = {
  en: [
    "strong", "powerful", "robust", "significant", "exceptional", "outstanding",
    "innovative", "cutting-edge", "best-in-class", "world-class",
    "industry-leading", "game-changing", "groundbreaking", "revolutionary",
    "unparalleled", "unmatched", "next-generation", "next-gen",
    "transformative", "trailblazing", "pioneering",
  ],
  es: [
    "fuerte", "poderoso", "robusto", "significativo", "excepcional",
    "innovador", "vanguardista", "l\u00edder", "de clase mundial",
    "puntero", "transformador", "revolucionario", "in\u00e9dito",
  ],
  pt: [
    "forte", "poderoso", "robusto", "significativo", "excepcional",
    "inovador", "vanguardista", "l\u00edder", "de classe mundial",
    "transformador", "revolucion\u00e1rio",
  ],
  it: [
    "forte", "potente", "robusto", "significativo", "eccezionale",
    "innovativo", "all'avanguardia", "leader del settore",
    "rivoluzionario", "di classe mondiale",
  ],
  fr: [
    "puissant", "robuste", "significatif", "exceptionnel",
    "innovant", "leader", "de classe mondiale", "r\u00e9volutionnaire",
    "transformateur", "in\u00e9gal\u00e9", "incomparable",
  ],
  de: [
    "leistungsstark", "robust", "signifikant", "herausragend",
    "exzellent", "marktf\u00fchrend", "weltklasse", "bahnbrechend",
    "revolution\u00e4r", "wegweisend", "innovativ",
  ],
  ru: [
    "\u043c\u043e\u0449\u043d\u044b\u0439", "\u0437\u043d\u0430\u0447\u0438\u0442\u0435\u043b\u044c\u043d\u044b\u0439", "\u0432\u044b\u0434\u0430\u044e\u0449\u0438\u0439\u0441\u044f",
    "\u0438\u0441\u043a\u043b\u044e\u0447\u0438\u0442\u0435\u043b\u044c\u043d\u044b\u0439", "\u0432\u0435\u0434\u0443\u0449\u0438\u0439", "\u0438\u043d\u043d\u043e\u0432\u0430\u0446\u0438\u043e\u043d\u043d\u044b\u0439",
    "\u0440\u0435\u0432\u043e\u043b\u044e\u0446\u0438\u043e\u043d\u043d\u044b\u0439", "\u043f\u0435\u0440\u0435\u0434\u043e\u0432\u043e\u0439", "\u043d\u0435\u043f\u0440\u0435\u0432\u0437\u043e\u0439\u0434\u0435\u043d\u043d\u044b\u0439",
  ],
  uk: [
    "\u043f\u043e\u0442\u0443\u0436\u043d\u0438\u0439", "\u0437\u043d\u0430\u0447\u043d\u0438\u0439", "\u0432\u0438\u043d\u044f\u0442\u043a\u043e\u0432\u0438\u0439",
    "\u043f\u0440\u043e\u0432\u0456\u0434\u043d\u0438\u0439", "\u0456\u043d\u043d\u043e\u0432\u0430\u0446\u0456\u0439\u043d\u0438\u0439", "\u043f\u0435\u0440\u0435\u0434\u043e\u0432\u0438\u0439",
  ],
  pl: [
    "mocny", "pot\u0119\u017cny", "znacz\u0105cy", "wybitny", "wyj\u0105tkowy",
    "wiod\u0105cy", "innowacyjny", "rewolucyjny", "prze\u0142omowy",
  ],
  cs: [
    "siln\u00fd", "v\u00fdkonn\u00fd", "v\u00fdznamn\u00fd", "vynikaj\u00edc\u00ed",
    "p\u0159ev\u00e1\u017en\u00fd", "inovativn\u00ed", "revolu\u010dn\u00ed",
  ],
  ro: [
    "puternic", "robust", "semnificativ", "excep\u021bional",
    "lider", "inovator", "revolu\u021bionar",
  ],
  hu: [
    "er\u0151s", "jelent\u0151s", "kiv\u00e1l\u00f3", "kimagasl\u00f3",
    "vezet\u0151", "innovat\u00edv", "forradalmi",
  ],
  fi: [
    "vahva", "tehokas", "merkitt\u00e4v\u00e4", "poikkeuksellinen",
    "johtava", "innovatiivinen", "mullistava",
  ],
  tr: [
    "g\u00fc\u00e7l\u00fc", "kuvvetli", "\u00f6nemli", "ola\u011fan\u00fcst\u00fc",
    "\u00f6nc\u00fc", "yenilik\u00e7i", "devrimsel", "rakipsiz",
  ],
  nl: [
    "sterk", "krachtig", "robuust", "significant", "uitstekend",
    "toonaangevend", "innovatief", "revolutionair", "baanbrekend",
  ],
  sv: [
    "stark", "kraftfull", "betydande", "enast\u00e5ende",
    "ledande", "innovativ", "banbrytande", "revolutionerande",
  ],
  no: [
    "sterk", "kraftig", "betydelig", "enest\u00e5ende",
    "ledende", "innovativ", "banebrytende", "revolusjonerende",
  ],
  nb: [
    "sterk", "kraftig", "betydelig", "enest\u00e5ende",
    "ledende", "innovativ", "banebrytende", "revolusjonerende",
  ],
  da: [
    "st\u00e6rk", "kraftfuld", "betydelig", "enest\u00e5ende",
    "f\u00f8rende", "innovativ", "banebrydende", "revolutionerende",
  ],
  el: [
    "\u03b9\u03c3\u03c7\u03c5\u03c1\u03cc\u03c2", "\u03c3\u03b7\u03bc\u03b1\u03bd\u03c4\u03b9\u03ba\u03cc\u03c2", "\u03b5\u03be\u03b1\u03b9\u03c1\u03b5\u03c4\u03b9\u03ba\u03cc\u03c2",
    "\u03b7\u03b3\u03b5\u03c4\u03b9\u03ba\u03cc\u03c2", "\u03ba\u03b1\u03b9\u03bd\u03bf\u03c4\u03cc\u03bc\u03bf\u03c2", "\u03b5\u03c0\u03b1\u03bd\u03b1\u03c3\u03c4\u03b1\u03c4\u03b9\u03ba\u03cc\u03c2",
  ],
  ja: [
    "\u5f37\u529b", "\u5f37\u529b\u306a", "\u5353\u8d8a", "\u5353\u8d8a\u3057\u305f", "\u696d\u754c\u6700\u9ad8",
    "\u9769\u65b0\u7684", "\u9769\u65b0\u7684\u306a", "\u4e16\u754c\u30c8\u30c3\u30d7",
    "\u30c8\u30c3\u30d7\u30af\u30e9\u30b9", "\u696d\u754c\u3092\u30ea\u30fc\u30c9",
  ],
  zh: [
    "\u5f3a\u5927", "\u5f3a\u52b2", "\u5353\u8d8a", "\u4e1a\u754c\u9886\u5148",
    "\u4e16\u754c\u9886\u5148", "\u521b\u65b0", "\u9769\u547d\u6027",
    "\u9886\u5148", "\u7a81\u7834\u6027",
  ],
  ko: [
    "\uac15\ub825\ud55c", "\uac15\ub825", "\ud0c1\uc6d4\ud55c", "\ud0c1\uc6d4",
    "\uc5c5\uacc4 \ucd5c\uace0", "\uc138\uacc4 \ucd5c\uace0", "\ud601\uc2e0\uc801",
    "\uc8fc\ub3c4\uc801", "\uc120\ub3c4\uc801",
  ],
  he: [
    "\u05d7\u05d6\u05e7",
    "\u05d9\u05d5\u05e6\u05d0 \u05de\u05df \u05d4\u05db\u05dc\u05dc",
    "\u05d7\u05e1\u05e8 \u05ea\u05e7\u05d3\u05d9\u05dd",
  ],
  ar: [
    "\u0642\u0648\u064a", "\u0645\u0647\u0645", "\u0627\u0633\u062a\u062b\u0646\u0627\u0626\u064a",
    "\u0631\u0627\u0626\u062f", "\u0645\u0628\u062a\u0643\u0631", "\u062b\u0648\u0631\u064a",
  ],
  fa: [
    "\u0642\u0648\u06cc", "\u0645\u0647\u0645", "\u0627\u0633\u062a\u062b\u0646\u0627\u06cc\u06cc",
    "\u067e\u06cc\u0634\u0631\u0648", "\u0646\u0648\u0622\u0648\u0631\u0627\u0646\u0647", "\u0627\u0646\u0642\u0644\u0627\u0628\u06cc",
  ],
  hi: [
    "\u092e\u091c\u093c\u092c\u0942\u0924", "\u0936\u0915\u094d\u0924\u093f\u0936\u093e\u0932\u0940", "\u0905\u0938\u093e\u0927\u093e\u0930\u0923",
    "\u0905\u0917\u094d\u0930\u0923\u0940", "\u0928\u0935\u0940\u0928", "\u0915\u094d\u0930\u093e\u0902\u0924\u093f\u0915\u093e\u0930\u0940",
  ],
  bn: [
    "\u09b6\u0995\u094d\u09a4\u09bf\u09b6\u09be\u09b2\u09c0", "\u0985\u09b8\u09be\u09a7\u09be\u09b0\u09a3",
    "\u0985\u0997\u09cd\u09b0\u09a3\u09c0", "\u0989\u09a6\u09cd\u09ad\u09be\u09ac\u09a8\u09c0",
  ],
  ur: [
    "\u0645\u0636\u0628\u0648\u0637", "\u0637\u0627\u0642\u062a\u0648\u0631", "\u063a\u06cc\u0631 \u0645\u0639\u0645\u0648\u0644\u06cc",
    "\u0627\u0648\u0644 \u062f\u0631\u062c\u06d2 \u06a9\u0627", "\u062c\u062f\u062a \u067e\u0633\u0646\u062f", "\u0627\u0646\u0642\u0644\u0627\u0628\u06cc",
  ],
  th: [
    "\u0e41\u0e02\u0e47\u0e07\u0e41\u0e01\u0e23\u0e48\u0e07", "\u0e1c\u0e39\u0e49\u0e19\u0e33\u0e43\u0e19\u0e2d\u0e38\u0e15\u0e2a\u0e32\u0e2b\u0e01\u0e23\u0e23\u0e21",
    "\u0e22\u0e2d\u0e14\u0e40\u0e22\u0e35\u0e48\u0e22\u0e21", "\u0e2a\u0e23\u0e49\u0e32\u0e07\u0e2a\u0e23\u0e23\u0e04\u0e4c", "\u0e1b\u0e0f\u0e34\u0e27\u0e31\u0e15\u0e34",
  ],
  vi: [
    "m\u1ea1nh m\u1ebd", "v\u01b0\u1ee3t tr\u1ed9i", "h\u00e0ng \u0111\u1ea7u",
    "\u0111\u1ed9t ph\u00e1", "ti\u00ean phong", "c\u00e1ch m\u1ea1ng",
  ],
  id: [
    "kuat", "luar biasa", "terdepan", "terkemuka",
    "inovatif", "revolusioner", "tak tertandingi",
  ],
  ms: [
    "kuat", "luar biasa", "terkemuka", "inovatif", "revolusioner",
  ],
  fil: [
    "malakas", "pinakamahusay", "nangunguna", "makabago",
  ],
  tl: [
    "malakas", "pinakamahusay", "nangunguna", "makabago",
  ],
  sw: [
    "imara", "bora", "kinara", "ya kibunifu",
  ],
};


// =============================================================================
// 4. APPROVED DIFFERENTIATOR ANCHORS
// =============================================================================

export const APPROVED_DIFFERENTIATOR_ANCHORS: Record<string, string[]> = {
  en: [
    "renewal", "renewals", "persistence", "persistent", "repeat", "second cycle",
    "second-cycle", "post-trial retention", "long-term retention",
    "30-day", "60-day", "90-day", "durable", "retained", "retention",
    "post-trial", "upgrade", "subscriber retention",
    "incremental", "incrementality", "incremental lift", "holdout",
    "semi-exclusive", "non-shared", "exclusive inventory", "exclusive supply",
    "exclusive placements", "exclusive sources", "exclusive publishers",
    "non-overlapping", "carved-out",
  ],
  es: [
    "renovaci\u00f3n", "renovaciones", "persistencia", "retenci\u00f3n",
    "recurrente", "post-prueba", "duradero", "duradera", "60 d\u00edas",
    "90 d\u00edas", "30 d\u00edas", "incremental", "incrementalidad",
    "semi-exclusiv", "exclusiv", "no compartid",
  ],
  pt: [
    "renova\u00e7\u00e3o", "renova\u00e7\u00f5es", "persist\u00eancia", "reten\u00e7\u00e3o",
    "recorrente", "p\u00f3s-trial", "dur\u00e1vel", "60 dias", "90 dias", "30 dias",
    "incremental", "incrementalidade",
    "semi-exclusiv", "exclusiv", "n\u00e3o compartilhad",
  ],
  it: [
    "rinnovo", "rinnovi", "persistenza", "retention",
    "ricorrente", "duraturo", "60 giorni", "90 giorni", "30 giorni",
    "incrementale", "incrementalit\u00e0",
    "semi-esclusiv", "esclusiv", "non condivis",
  ],
  fr: [
    "renouvellement", "renouvellements", "persistance", "r\u00e9tention",
    "r\u00e9current", "post-essai", "durable", "60 jours", "90 jours", "30 jours",
    "incr\u00e9mental", "incr\u00e9mentalit\u00e9",
    "semi-exclusi", "exclusi", "non partag\u00e9",
  ],
  de: [
    "verl\u00e4ngerung", "persistenz", "retention",
    "wiederkehrend", "nachhaltig", "60 tage", "90 tage", "30 tage",
    "inkrementell", "inkrementalit\u00e4t",
    "halbexklusiv", "exklusiv", "nicht geteilt",
  ],
  ru: [
    "\u0443\u0434\u0435\u0440\u0436\u0430\u043d\u0438\u0435", "\u043f\u043e\u0432\u0442\u043e\u0440\u043d\u044b\u0439", "\u043f\u043e\u0432\u0442\u043e\u0440\u043d\u044b\u0445", "\u0432\u0442\u043e\u0440\u043e\u0439 \u0446\u0438\u043a\u043b",
    "\u043f\u0440\u043e\u0434\u043b\u0435\u043d\u0438\u0435", "\u043f\u043e\u0434\u043f\u0438\u0441\u043a\u0438", "60 \u0434\u043d\u0435\u0439", "90 \u0434\u043d\u0435\u0439", "30 \u0434\u043d\u0435\u0439",
    "\u0438\u043d\u043a\u0440\u0435\u043c\u0435\u043d\u0442\u0430\u043b\u044c\u043d", "\u0438\u043d\u043a\u0440\u0435\u043c\u0435\u043d\u0442\u0430\u043b\u044c\u043d\u043e\u0441\u0442\u044c",
    "\u043f\u043e\u043b\u0443\u044d\u043a\u0441\u043a\u043b\u044e\u0437\u0438\u0432", "\u044d\u043a\u0441\u043a\u043b\u044e\u0437\u0438\u0432", "\u043d\u0435 \u043f\u0435\u0440\u0435\u0441\u0435\u043a\u0430",
  ],
  uk: [
    "\u0443\u0442\u0440\u0438\u043c\u0430\u043d\u043d\u044f", "\u043f\u043e\u0432\u0442\u043e\u0440\u043d", "\u0434\u0440\u0443\u0433\u0438\u0439 \u0446\u0438\u043a\u043b", "\u043f\u0440\u043e\u0434\u043e\u0432\u0436\u0435\u043d\u043d\u044f",
    "\u0456\u043d\u043a\u0440\u0435\u043c\u0435\u043d\u0442\u0430\u043b\u044c\u043d", "\u043d\u0430\u043f\u0456\u0432\u0435\u043a\u0441\u043a\u043b\u044e\u0437\u0438\u0432", "\u0435\u043a\u0441\u043a\u043b\u044e\u0437\u0438\u0432",
  ],
  pl: [
    "retencja", "powtarzaj\u0105cy", "drugi cykl", "odnowienie",
    "inkrementaln", "inkrementalno\u015b\u0107",
    "p\u00f3\u0142wy\u0142\u0105czn", "ekskluzywn", "wy\u0142\u0105czn",
  ],
  cs: [
    "retence", "opakovan\u00fd", "druh\u00fd cyklus", "obnoven\u00ed",
    "inkrement\u00e1ln\u00ed", "inkrementalita",
    "polo-exkluzivn\u00ed", "exkluzivn\u00ed",
  ],
  ro: [
    "reten\u021bie", "recurent", "al doilea ciclu", "re\u00eennoire",
    "incremental", "incrementalitate",
    "semi-exclusiv", "exclusiv",
  ],
  hu: [
    "megtart\u00e1s", "ism\u00e9tl\u0151d\u0151", "m\u00e1sodik ciklus", "megh\u00f3sszabb\u00edt\u00e1s",
    "inkrement\u00e1lis", "f\u00e9l-exkluz\u00edv", "exkluz\u00edv",
  ],
  fi: [
    "retentio", "toistuva", "toinen sykli", "uudistus",
    "inkrementaalinen", "puoli-eksklusiivinen", "eksklusiivinen",
  ],
  tr: [
    "elde tutma", "yenileme", "tekrar eden", "ikinci d\u00f6ng\u00fc",
    "art\u0131msal", "art\u0131msall\u0131k",
    "yar\u0131-\u00f6zel", "\u00f6zel envanter",
  ],
  nl: [
    "verlenging", "verlengingen", "retentie", "terugkerend", "duurzaam",
    "incrementeel", "incrementaliteit",
    "semi-exclusief", "exclusief", "niet-gedeeld",
  ],
  sv: [
    "f\u00f6rl\u00e4ngning", "retention", "\u00e5terkommande", "h\u00e5llbar",
    "inkrementell", "inkrementalitet",
    "semi-exklusiv", "exklusiv",
  ],
  no: [
    "fornyelse", "retention", "tilbakevendende", "vedvarende",
    "inkrementell", "inkrementalitet",
    "semi-eksklusiv", "eksklusiv",
  ],
  nb: [
    "fornyelse", "retention", "tilbakevendende", "vedvarende",
    "inkrementell", "inkrementalitet",
    "semi-eksklusiv", "eksklusiv",
  ],
  da: [
    "forl\u00e6ngelse", "retention", "tilbagevendende", "varig",
    "inkrementel", "inkrementalitet",
    "semi-eksklusiv", "eksklusiv",
  ],
  el: [
    "\u03b1\u03bd\u03b1\u03bd\u03ad\u03c9\u03c3\u03b7", "\u03b4\u03b9\u03b1\u03c4\u03ae\u03c1\u03b7\u03c3\u03b7", "\u03b5\u03c0\u03b1\u03bd\u03b1\u03bb\u03b1\u03bc\u03b2\u03b1\u03bd\u03cc\u03bc\u03b5\u03bd\u03bf",
    "\u03b1\u03c5\u03be\u03b7\u03c4\u03b9\u03ba\u03cc\u03c2", "\u03b7\u03bc\u03b9-\u03b1\u03c0\u03bf\u03ba\u03bb\u03b5\u03b9\u03c3\u03c4\u03b9\u03ba", "\u03b1\u03c0\u03bf\u03ba\u03bb\u03b5\u03b9\u03c3\u03c4\u03b9\u03ba",
  ],
  ja: [
    "\u30ea\u30c6\u30f3\u30b7\u30e7\u30f3", "\u9577\u671f\u30ea\u30c6\u30f3\u30b7\u30e7\u30f3", "\u7d99\u7d9a", "\u7d99\u7d9a\u6027",
    "\u7e70\u308a\u8fd4\u3057", "60\u65e5", "90\u65e5", "30\u65e5",
    "\u30a4\u30f3\u30af\u30ea\u30e1\u30f3\u30bf\u30eb", "\u30a4\u30f3\u30af\u30ea\u30e1\u30f3\u30bf\u30ea\u30c6\u30a3",
    "\u30bb\u30df\u30a8\u30af\u30b9\u30af\u30eb\u30fc\u30b7\u30d6", "\u72ec\u81ea", "\u72ec\u5360",
  ],
  zh: [
    "\u7559\u5b58", "\u7528\u6237\u7559\u5b58", "\u7eed\u8d39", "\u590d\u8d2d", "\u8c41\u5e74\u6301\u4e45",
    "60\u5929", "90\u5929", "30\u5929", "\u589e\u91cf", "\u589e\u91cf\u6027",
    "\u534a\u72ec\u5bb6", "\u72ec\u5bb6", "\u72ec\u5360",
  ],
  ko: [
    "\ub9ac\ud150\uc158", "\uc7ac\uad6c\ub9e4", "\uc7ac\uacc4\uc57d", "\uc9c0\uc18d",
    "60\uc77c", "90\uc77c", "30\uc77c", "\uc99d\ubd84", "\uc99d\ubd84\uc801",
    "\ubc18-\ub3c5\uc810", "\ub3c5\uc810", "\ud504\ub9ac\ubbf8\uc5c4",
  ],
  he: [
    "\u05d4\u05ea\u05de\u05d3\u05d4", "\u05d7\u05d9\u05d3\u05d5\u05e9", "\u05d7\u05d6\u05e8\u05d4", "\u05de\u05de\u05d5\u05e9\u05da",
    "\u05ea\u05d5\u05e1\u05e4\u05ea\u05d9\u05d5\u05ea", "\u05e8\u05d5\u05d1 \u05d0\u05e7\u05e1\u05e7\u05dc\u05d5\u05e1\u05d9\u05d1\u05d9\u05d5\u05ea", "\u05d0\u05e7\u05e1\u05e7\u05dc\u05d5\u05e1\u05d9\u05d1\u05d9",
  ],
  ar: [
    "\u0627\u0644\u0627\u062d\u062a\u0641\u0627\u0638", "\u062a\u062c\u062f\u064a\u062f", "\u062a\u062c\u062f\u064a\u062f\u0627\u062a", "\u0645\u062a\u0643\u0631\u0631",
    "\u0625\u0636\u0627\u0641\u064a", "\u0625\u0636\u0627\u0641\u064a\u0629", "\u0634\u0628\u0647 \u062d\u0635\u0631\u064a", "\u062d\u0635\u0631\u064a",
  ],
  fa: [
    "\u062d\u0641\u0638", "\u062a\u0645\u062f\u06cc\u062f", "\u062a\u06a9\u0631\u0627\u0631\u06cc",
    "\u0627\u0641\u0632\u0627\u06cc\u0634\u06cc", "\u0646\u06cc\u0645\u0647\u200c\u0627\u0646\u062d\u0635\u0627\u0631\u06cc", "\u0627\u0646\u062d\u0635\u0627\u0631\u06cc",
  ],
  hi: [
    "\u0930\u093f\u091f\u0947\u0902\u0936\u0928", "\u0928\u0935\u0940\u0915\u0930\u0923", "\u0926\u094b\u0939\u0930\u093e\u0924\u093e", "\u0926\u094b\u0939\u0930\u093e\u0935",
    "\u0935\u0943\u0926\u094d\u0927\u093f\u0936\u0940\u043b", "\u0905\u0930\u094d\u0927-\u0935\u093f\u0936\u0947\u0937", "\u0935\u093f\u0936\u0947\u0937",
  ],
  bn: [
    "\u09b0\u09bf\u099f\u09c7\u09a8\u09b6\u09a8", "\u09a8\u09ac\u09be\u09af\u09bc\u09a8", "\u09aa\u09c1\u09a8\u09b0\u09be\u09ac\u09c3\u09a4\u09cd\u09a4",
    "\u0985\u09b0\u09cd\u09a7-\u09ac\u09bf\u09b6\u09c7\u09b7", "\u09ac\u09bf\u09b6\u09c7\u09b7",
  ],
  ur: [
    "\u0631\u0631\u0679\u06cc\u0646\u0634\u0646", "\u062a\u062c\u062f\u06cc\u062f", "\u0628\u0627\u0631 \u0628\u0627\u0631",
    "\u0627\u0636\u0627\u0641\u06cc", "\u0646\u06cc\u0645 \u062e\u0635\u0648\u0635\u06cc", "\u062e\u0635\u0648\u0635\u06cc",
  ],
  th: [
    "\u0e23\u0e35\u0e40\u0e17\u0e19\u0e0a\u0e31\u0e19", "\u0e01\u0e32\u0e23\u0e15\u0e48\u0e2d\u0e2d\u0e32\u0e22\u0e38", "\u0e15\u0e48\u0e2d\u0e2d\u0e32\u0e22\u0e38", "\u0e0a\u0e33\u0e23\u0e30\u0e0b\u0e49\u0e33", "\u0e23\u0e2d\u0e1a\u0e17\u0e35\u0e48\u0e2a\u0e2d\u0e07",
    "60 \u0e27\u0e31\u0e19", "90 \u0e27\u0e31\u0e19", "30 \u0e27\u0e31\u0e19",
    "\u0e2a\u0e48\u0e27\u0e19\u0e40\u0e1e\u0e34\u0e48\u0e21", "\u0e01\u0e36\u0e48\u0e07\u0e1e\u0e34\u0e40\u0e28\u0e29", "\u0e1e\u0e34\u0e40\u0e28\u0e29",
  ],
  vi: [
    "gia h\u1ea1n", "duy tr\u00ec", "l\u1eb7p l\u1ea1i", "chu k\u1ef3 th\u1ee9 hai",
    "gia t\u0103ng", "t\u00ednh gia t\u0103ng", "b\u00e1n \u0111\u1ed9c quy\u1ec1n", "\u0111\u1ed9c quy\u1ec1n",
  ],
  id: [
    "perpanjangan", "retensi", "berulang", "siklus kedua",
    "inkremental", "inkrementalitas", "semi-eksklusif", "eksklusif",
  ],
  ms: [
    "pembaharuan", "pengekalan", "berulang", "kitar kedua",
    "tambahan", "separa-eksklusif", "eksklusif",
  ],
  fil: [
    "renewal", "retention", "paulit-ulit", "pangalawang siklo",
    "incremental", "semi-exclusive", "exclusive",
  ],
  tl: [
    "renewal", "retention", "paulit-ulit", "pangalawang siklo",
    "incremental", "semi-exclusive", "exclusive",
  ],
  sw: [
    "upyaisha", "uhifadhi", "kurudiarudia", "mzunguko wa pili",
    "nyongeza", "nusu-pekee", "pekee",
  ],
};


// =============================================================================
// 5. FORBIDDEN DIFFERENTIATOR PATTERNS (CPA collapse)
// =============================================================================
// Detection of "we pay for X, not Y" / "scale only where real Z" patterns.
// Deterministic in en/es/ru/th; semantic enforcement via critic for the rest.

export const FORBIDDEN_DIFFERENTIATOR_PATTERNS: Record<string, RegExp[]> = {
  en: [
    /\bpays?\s+for\s+(?:approved|real|paid|completed)\s+(?:\w+\s+){0,3}(?:rather\s+than|not|instead\s+of)\s+(?:installs?|signups?|sessions?|clicks?|impressions?)\b/i,
    /\b(?:only|exclusively)\s+pays?\s+for\s+(?:\w+\s+){0,4}(?:not|rather\s+than|instead\s+of)\s+(?:installs?|signups?|sessions?)\b/i,
    /\b(?:scale|optimize)\s+only\s+where\s+real\s+(?:\w+\s+){1,3}(?:are|is)\s+happening\b/i,
    /\bhelp\s+\w+(?:\s+\w+)?\s+scale\s+only\s+where\s+real\b/i,
    /\bpays?\s+for\s+approved\s+(?:\w+\s+){0,3}rather\s+than\s+(?:installs?|signups?|sessions?|clicks?|impressions?)\b/i,
  ],
  es: [
    /\bpaga\s+por\s+(?:eventos?\s+aprobados?|acciones?\s+reales?|conversiones?\s+reales?)\s+(?:en\s+vez\s+de|no|en\s+lugar\s+de)\s+(?:instalaciones?|registros?|sesiones?|clics?)\b/iu,
    /\b(?:s\u00f3lo|solo)\s+paga\s+por\s+(?:\w+\s+){0,4}(?:no|en\s+vez\s+de|en\s+lugar\s+de)\s+(?:instalaciones?|registros?|sesiones?)\b/iu,
  ],
  ru: [
    /\u043f\u043b\u0430\u0442\u0438\u0442\u044c\s+(?:\u0442\u043e\u043b\u044c\u043a\u043e\s+)?\u0437\u0430\s+(?:\u043e\u0434\u043e\u0431\u0440\u0435\u043d\u043d\u044b\u0435|\u0440\u0435\u0430\u043b\u044c\u043d\u044b\u0435|\u043f\u043b\u0430\u0442\u043d\u044b\u0435)\s+(?:\S+\s+){0,3}\u0430\s+\u043d\u0435\s+\u0437\u0430\s+(?:\u0443\u0441\u0442\u0430\u043d\u043e\u0432\u043a\u0438|\u0440\u0435\u0433\u0438\u0441\u0442\u0440\u0430\u0446\u0438\u0438|\u0441\u0435\u0441\u0441\u0438\u0438|\u043a\u043b\u0438\u043a\u0438)/iu,
  ],
  th: [
    /\u0e08\u0e48\u0e32\u0e22\u0e40\u0e09\u0e1e\u0e32\u0e30\u0e2a\u0e33\u0e2b\u0e23\u0e31\u0e1a.{0,40}\u0e44\u0e21\u0e48\u0e43\u0e0a\u0e48.{0,20}(?:\u0e15\u0e34\u0e14\u0e15\u0e31\u0e49\u0e07|\u0e2a\u0e21\u0e31\u0e04\u0e23|\u0e40\u0e0b\u0e2a\u0e0a\u0e31\u0e19|\u0e04\u0e25\u0e34\u0e01)/u,
  ],
};


// =============================================================================
// 6. MULTI-EVENT OPTIMIZATION PATTERNS
// =============================================================================

export const MULTI_EVENT_PATTERNS: Record<string, RegExp[]> = {
  en: [
    /\b(?:one|single|a\s+single)\s+(?:\w+\s+){0,3}event[:,]\s*(?:an?\s+)?\w+\s+(?:or|and)\s+\w+\b/i,
    /\b(?:anchor|optimize|tune)\s+(?:on|for|toward|against)\s+\w+\s+(?:or|and)\s+\w+\s+(?:or|and)\s+\w+\b/i,
    /\boptimize\s+toward\s+(?:\w+\s+){0,4}event[:,]\s*(?:\w+\s+){0,3}(?:or|and)\s+\w+/i,
    /\b(?:one\s+clear|one\s+single|exactly\s+one)\s+(?:\w+\s+){0,3}event[:,].{0,80}\s+(?:or|and)\s+\w+/i,
    /\b(?:optimization|optimize|optimizes|target|targets|targeting)\s+(?:on|toward|for)\s+\w+(?:\s+\w+)?,\s+\w+(?:\s+\w+)?,?\s+and\s+\w+/i,
  ],
  es: [
    /\b(?:un\s+|un\s+solo\s+)(?:\w+\s+){0,3}evento[,:]\s*\w+\s+o\s+\w+\b/iu,
    /\boptimizar\s+(?:hacia|para|por)\s+\w+\s+o\s+\w+\s+o\s+\w+\b/iu,
  ],
  ru: [
    /\u043e\u0434\u043d\u043e\u0433\u043e\s+(?:\S+\s+){0,3}\u0441\u043e\u0431\u044b\u0442\u0438\u044f[:,]\s*\S+\s+\u0438\u043b\u0438\s+\S+/iu,
    /\u043e\u0434\u043d\u043e\s+(?:\S+\s+){0,3}\u0441\u043e\u0431\u044b\u0442\u0438\u0435[:,]\s*\S+\s+\u0438\u043b\u0438\s+\S+/iu,
  ],
  th: [
    /\u0e2b\u0e19\u0e36\u0e48\u0e07\u0e40\u0e2b\u0e15\u0e38\u0e01\u0e32\u0e23\u0e13\u0e4c.{0,40}\u0e2b\u0e23\u0e37\u0e2d.{0,40}\u0e1e\u0e23\u0e49\u0e2d\u0e21\u0e01\u0e31\u0e1a/u,
  ],
};


// =============================================================================
// Helper functions
// =============================================================================

function pickFor<T>(table: Record<string, T[]>, lang: string): T[] {
  const norm = normalizeLanguageCode(lang) || "en";
  return table[norm] ?? table["en"] ?? [];
}

export function getHowOpeners(lang: string): string[] {
  return pickFor(MANDATED_HOW_OPENERS, lang);
}

export function getHedgePatterns(lang: string): RegExp[] {
  return pickFor(HEDGE_PATTERNS, lang);
}

export function getHypeAdjectives(lang: string): string[] {
  return pickFor(HYPE_ADJECTIVES, lang);
}

export function getDifferentiatorAnchors(lang: string): string[] {
  return pickFor(APPROVED_DIFFERENTIATOR_ANCHORS, lang);
}

export function getForbiddenDiffPatterns(lang: string): RegExp[] {
  return pickFor(FORBIDDEN_DIFFERENTIATOR_PATTERNS, lang);
}

export function getMultiEventPatterns(lang: string): RegExp[] {
  return pickFor(MULTI_EVENT_PATTERNS, lang);
}

/** Return all hype-adjective hits found anywhere in the body. */
export function findHypeAdjectivesInBody(body: string, lang: string): string[] {
  const bodyLower = body.toLowerCase();
  const hits: string[] = [];
  for (const adj of getHypeAdjectives(lang)) {
    // Whole-word match. For Latin-script adjectives, allow a short
    // inflectional suffix (up to 4 letter characters including common
    // diacritics) so German "starke" / "starker" / "starken" match the
    // "stark" stem, Spanish "fuertes" matches "fuerte", and similar
    // declensions in other Latin-script European languages catch.
    // For non-Latin scripts, fall back to substring match because \b is
    // unreliable at script boundaries; the data tables for those
    // languages typically list the dictionary form and the LLM critic
    // covers semantic variants.
    const isLatin = /^[\x20-\x7e\u00c0-\u024f\u1e00-\u1eff]+$/.test(adj);
    if (isLatin) {
      const escaped = adj.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pat = new RegExp(
        "(?<![\\p{L}\\p{N}_])" + escaped + "[\\p{L}]{0,4}(?![\\p{L}\\p{N}_])",
        "iu",
      );
      if (pat.test(bodyLower)) hits.push(adj);
    } else {
      if (bodyLower.includes(adj.toLowerCase())) hits.push(adj);
    }
  }
  return hits;
}

/** Return hedge-on-number hits (each is the matched substring). */
export function findHedgesInBody(body: string, lang: string): string[] {
  const hits: string[] = [];
  for (const pat of getHedgePatterns(lang)) {
    const m = body.match(pat);
    if (m) hits.push(m[0]);
  }
  return hits;
}

/** Whether the differentiator paragraph contains an approved anchor keyword. */
export function hasApprovedDifferentiatorAnchor(diffText: string, lang: string): boolean {
  const lower = diffText.toLowerCase();
  for (const anchor of getDifferentiatorAnchors(lang)) {
    if (lower.includes(anchor.toLowerCase())) return true;
  }
  return false;
}

/** CPA-collapse pattern hits in the differentiator paragraph. */
export function findForbiddenDiffPatterns(diffText: string, lang: string): string[] {
  const hits: string[] = [];
  for (const pat of getForbiddenDiffPatterns(lang)) {
    const m = diffText.match(pat);
    if (m) hits.push(m[0]);
  }
  return hits;
}

/** Multi-event optimization pattern hits anywhere in the body. */
export function findMultiEventPatterns(body: string, lang: string): string[] {
  const hits: string[] = [];
  for (const pat of getMultiEventPatterns(lang)) {
    const m = body.match(pat);
    if (m) hits.push(m[0]);
  }
  return hits;
}

/** Whether the HOW paragraph begins with a mandated methodology opener. */
export function howParagraphStartsWithMandatedOpener(howPara: string, lang: string): boolean {
  const lower = howPara.trimStart().toLowerCase();
  for (const opener of getHowOpeners(lang)) {
    if (lower.startsWith(opener.toLowerCase())) return true;
  }
  return false;
}
