/**
 * nativenessV4.ts — Native-style + translationese layer over the v3
 * Reading-A++ policy. TypeScript port of prospector's nativeness_v4.py.
 *
 * v3 enforced: (a) no English content tokens in non-English emails
 * (Reading-A++), (b) no X-NOT-Y comma-negation, (c) greeting-name
 * transliteration for non-Latin scripts.
 *
 * v4 closes three remaining gaps that v3 cannot catch:
 *
 *   1. UNIVERSAL GREETING-NAME ADAPTATION — for ALL 35 languages, not just
 *      non-Latin scripts. Non-Latin scripts get transliteration (already in
 *      v3); Latin-script languages with diacritics (pt, es, vi, cs, pl, hu,
 *      de, fr, it, ro, tr, sv, no, da, fi) get the proper native orthography
 *      of the prospect's first name when a canonical native form exists
 *      (Vinicius → Vinícius in pt; Jose → José in es; Tuan → Tuấn in vi).
 *
 *   2. TRANSLATIONESE PATTERNS — literal English-idiom translations whose
 *      individual words are correct local-language tokens but whose
 *      combination reads as translated-from-English. v3 cannot catch these
 *      because each word in isolation is fine. Examples in pt-BR: "evento
 *      norte" (north star), "gancho de" (hook), "mistura de editores"
 *      (publisher mix), "em sobreposição direta" (in direct overlap),
 *      "contra o CPA" (vs the CPA), "O ponto específico aqui é que",
 *      "A forma como X é Y" (colloquial spoken register in formal B2B).
 *
 *   3. NATIVE-STRUCTURE SCAFFOLD — per-language guidance on the structural
 *      elements that distinguish a Brazilian / Spanish / German / Italian
 *      B2B sales email from an English-translated one: social opener
 *      convention, connector phrases, softener phrases, collaborative close
 *      pattern, regional variant target.
 *
 * v4.1 additions (Denise's second gold reference): NATIVE_ENGLISH_LOANWORDS
 * per-language exemption set, constructive-parallel pattern, dual CTA
 * pattern, bullet-list pattern for deliverables, expanded connector lists.
 *
 * Public API is fully backward-compatible with v3 — v4 is purely additive.
 */

import {
  NON_LATIN_SCRIPT_LANGS,
  LATIN_ALLOWLIST,
  BOILERPLATE_LATIN,
  normalizeLanguageCode,
  findAllNativenessViolations as _findAllV3,
  hasAnyViolation as _hasAnyV3,
  buildNativenessBlockV3,
  type NativenessV3Report,
} from "./nativenessV3";

// ============================================================================
// 1. LATIN-SCRIPT LANGUAGES WITH DIACRITICS
// ============================================================================
// These Latin-script languages use diacritics that native speakers DO apply
// to common first names. "Vinicius" in a Brazilian Portuguese email should
// be "Vinícius"; "Jose" in Spanish should be "José"; "Tuan" in Vietnamese
// should be "Tuấn".
//
// English / Dutch / Indonesian / Malay / Swahili / Filipino / Tagalog are
// Latin-script-NO-diacritic for ASCII names and are intentionally excluded.

export const LATIN_DIACRITIC_LANGS: ReadonlySet<string> = new Set([
  "pt", "es", "fr", "it", "ro", "vi", "cs", "pl", "hu", "tr",
  "de", "sv", "no", "nb", "da", "fi",
]);

// ============================================================================
// 1b. NATIVE ENGLISH LOANWORDS — per-language exemption set
// ============================================================================
// v3's FORBIDDEN_ENGLISH_SINGLETONS list is calibrated to be aggressive and
// catch English content words inside non-English prose. In some adtech-heavy
// B2B languages (Brazilian Portuguese, LatAm Spanish, Italian, Dutch,
// Indonesian) certain English terms are GENUINELY native loanwords — native
// salespeople write "performance", "fee", "KPI", "ROAS", "LTV", "players",
// "mix" inside Portuguese / Spanish prose as a matter of standard B2B usage.
//
// This set is per-language and overrides v3's singleton flag for these
// specific tokens. It does NOT override v3's multi-word phrase flag.

export const NATIVE_ENGLISH_LOANWORDS: Record<string, ReadonlySet<string>> = {
  pt: new Set([
    "performance", "fee", "fees", "players", "player", "mix",
    "mobile", "app", "apps", "blog", "blogs", "AB", "ROAS",
    "LTV", "KPI", "KPIs", "KPIS", "CTV", "RTG", "PIX",
    "FGC", "CDI", "AUM", "CDB",
  ]),
  es: new Set([
    "performance", "fee", "fees", "players", "player", "mix",
    "mobile", "app", "apps", "blog", "blogs", "AB", "ROAS",
    "LTV", "KPI", "KPIs", "KPIS", "CTV", "RTG",
  ]),
  it: new Set([
    "performance", "fee", "fees", "player", "players", "mix",
    "mobile", "app", "apps", "blog", "blogs",
    "ROAS", "LTV", "KPI", "KPIs",
  ]),
  id: new Set([
    "performance", "fee", "player", "players", "mix",
    "mobile", "app", "apps", "ROAS", "LTV", "KPI",
  ]),
  ms: new Set([
    "performance", "fee", "player", "players", "mix",
    "mobile", "app", "apps", "ROAS", "LTV", "KPI",
  ]),
  nl: new Set([
    "performance", "fee", "player", "players", "mix",
    "mobile", "app", "apps", "ROAS", "LTV", "KPI",
  ]),
  fil: new Set([
    "performance", "fee", "player", "players", "mix",
    "mobile", "app", "apps", "ROAS", "LTV", "KPI",
  ]),
  tl: new Set([
    "performance", "fee", "player", "players", "mix",
    "mobile", "app", "apps", "ROAS", "LTV", "KPI",
  ]),
};

// ============================================================================
// 2. TRANSLATIONESE PATTERNS — per-language regex arrays
// ============================================================================

function b(pattern: string): RegExp {
  return new RegExp(pattern, "iu");
}

export const TRANSLATIONESE_PATTERNS: Record<string, RegExp[]> = {
  // --------------------------------------------------------------------
  // Portuguese (pt) — defaults to Brazilian Portuguese
  // --------------------------------------------------------------------
  pt: [
    b(String.raw`\bevento\s+norte\b`),
    b(String.raw`\bmétrica\s+norte\b`),
    b(String.raw`\bestrela\s+do\s+norte\b`),
    b(String.raw`\bgancho\s+(?:de|do|da|com)\b`),
    b(String.raw`\bisca\s+(?:de|do|da)\b`),
    b(String.raw`\bmistura\s+de\s+editores\b`),
    b(String.raw`\bmistura\s+de\s+criativos\b`),
    b(String.raw`\bposicionamentos\s+editoriais\b`),
    b(String.raw`\bem\s+sobreposição\s+direta\b`),
    b(String.raw`\bcontra\s+o\s+CPA\b`),
    b(String.raw`\bcontra\s+o\s+(?:custo|valor|nosso)\b`),
    b(String.raw`\bcontra\s+a\s+(?:persistência|retenção|conversão)\b`),
    b(String.raw`\bcompetição\s+por\s+lance\b`),
    b(String.raw`\bredirecionamento\s+(?:via\s+\w+\s+)?sobre\s+usuários\b`),
    b(String.raw`\bremarketing\s+sobre\s+usuários\b`),
    b(String.raw`\bno\s+sinal\s+de\s+conversão\b`),
    b(String.raw`\baos\s+sinais\s+de\s+conversão\b`),
    b(String.raw`\bponderamos\s+(?:os\s+)?editores\b`),
    b(String.raw`\bponderamos\s+(?:os\s+)?publishers\b`),
    b(String.raw`\bO\s+ponto\s+específico\s+aqui\s+é\s+que\b`),
    b(String.raw`\bO\s+ponto\s+(?:central|principal)\s+aqui\s+é\s+que\b`),
    b(String.raw`\bA\s+forma\s+como\s+(?:trabalhamos|operamos)\s+é\s+(?:rodar|executar|fazer)\b`),
    b(String.raw`\bO\s+(?:nosso\s+)?modo\s+de\s+(?:trabalhar|operar)\s+é\s+(?:rodar|fazer)\b`),
    b(String.raw`\bsafra\s+de\s+usuários\b`),
    b(String.raw`\bcontrolamos\s+(?:a\s+)?qualidade\s+em\s+várias\s+camadas\b`),
    b(String.raw`(?:\bnós\s+)?estamos\s+a\s+\w+(?:ar|er|ir)\b`), // EU PT progressive
    b(String.raw`\bordenador\b`),
  ],

  // --------------------------------------------------------------------
  // Spanish (es) — defaults to LatAm-neutral Spanish
  // --------------------------------------------------------------------
  es: [
    b(String.raw`\bevento\s+norte\b`),
    b(String.raw`\bmétrica\s+norte\b`),
    b(String.raw`\bestrella\s+del\s+norte\b`),
    b(String.raw`\bgancho\s+(?:de|del|de\s+la)\b`),
    b(String.raw`\banzuelo\s+(?:de|del|de\s+la)\b`),
    b(String.raw`\bmezcla\s+de\s+editores\b`),
    b(String.raw`\bmezcla\s+de\s+publishers\b`),
    b(String.raw`\bposicionamientos\s+editoriales\b`),
    b(String.raw`\ben\s+superposición\s+directa\b`),
    b(String.raw`\bcontra\s+el\s+CPA\b`),
    b(String.raw`\bcontra\s+la\s+(?:persistencia|retención|conversión)\b`),
    b(String.raw`\bcompetición\s+por\s+puja\b`),
    b(String.raw`\bremarketing\s+sobre\s+usuarios\b`),
    b(String.raw`\bredirecciona(?:miento|do)\s+sobre\s+usuarios\b`),
    b(String.raw`\bel\s+punto\s+específico\s+aquí\s+es\s+que\b`),
    b(String.raw`\bla\s+forma\s+como\s+(?:trabajamos|operamos)\s+es\s+(?:correr|ejecutar|hacer)\b`),
    b(String.raw`\bponderamos\s+(?:los\s+|a\s+los\s+)?(?:editores|publishers)\b`),
    b(String.raw`\bordenador(?:es)?\b`),
    b(String.raw`\bvosotros\b`),
    b(String.raw`\bos\s+(?:agradezco|escribo|comparto)\b`),
    b(String.raw`\bcontrolamos\s+(?:la\s+)?calidad\s+en\s+(?:varias|múltiples)\s+capas\b`),
  ],

  // --------------------------------------------------------------------
  // Italian (it)
  // --------------------------------------------------------------------
  it: [
    b(String.raw`\bevento\s+stella\s+polare\b`),
    b(String.raw`\bl[' ]?esca\s+(?:di|del|della)\b`),
    b(String.raw`\bgancio\s+(?:di|del|della)\b`),
    b(String.raw`\bmiscela\s+di\s+editori\b`),
    b(String.raw`\bposizionamenti\s+editoriali\b`),
    b(String.raw`\bin\s+sovrapposizione\s+diretta\b`),
    b(String.raw`\bcontro\s+il\s+CPA\b`),
    b(String.raw`\bcompetizione\s+per\s+l[' ]?offerta\b`),
    b(String.raw`\bil\s+punto\s+specifico\s+qui\s+è\s+che\b`),
    b(String.raw`\bil\s+modo\s+in\s+cui\s+lavoriamo\s+è\s+(?:eseguire|far\s+girare)\b`),
  ],

  // --------------------------------------------------------------------
  // French (fr)
  // --------------------------------------------------------------------
  fr: [
    b(String.raw`\bévénement\s+étoile\s+du\s+nord\b`),
    b(String.raw`\bl[' ]?hameçon\s+(?:de|du|de\s+la)\b`),
    b(String.raw`\bmélange\s+d[' ]?éditeurs\b`),
    b(String.raw`\bplacements\s+éditoriaux\b`),
    b(String.raw`\ben\s+superposition\s+directe\b`),
    b(String.raw`\bcontre\s+le\s+CPA\b`),
    b(String.raw`\bla\s+manière\s+dont\s+nous\s+travaillons\s+est\s+de\s+(?:lancer|exécuter)\b`),
    b(String.raw`\ble\s+point\s+spécifique\s+ici\s+est\s+que\b`),
  ],

  // --------------------------------------------------------------------
  // German (de)
  // --------------------------------------------------------------------
  de: [
    b(String.raw`\bNordstern[- ]?(?:Event|Metrik|Veranstaltung)\b`),
    b(String.raw`\b(?:der|den|dem)\s+Köder\b`),
    b(String.raw`\bPublisher[- ]?Mischung\b`),
    b(String.raw`\bredaktionelle\s+Platzierungen\b`),
    b(String.raw`\bin\s+direkter\s+Überlappung\b`),
    b(String.raw`\bgegen\s+den\s+CPA\b`),
    b(String.raw`\bder\s+spezifische\s+Punkt\s+hier\s+ist[,\s]+dass\b`),
    b(String.raw`\bdie\s+Art\s+und\s+Weise[,\s]+wie\s+wir\s+arbeiten[,\s]+ist[,\s]+eine\s+Kampagne\s+zu\s+(?:fahren|laufen)\b`),
  ],

  // --------------------------------------------------------------------
  // Russian (ru) — note: JS \b doesn't work for Cyrillic (\w is ASCII-only),
  // so use space/anchor boundaries instead.
  // --------------------------------------------------------------------
  ru: [
    b(String.raw`событие\s+(?:северная|полярная)\s+звезда`),
    b(String.raw`крючок\s+(?:для|на)`),
    b(String.raw`смесь\s+(?:издателей|паблишеров)`),
    b(String.raw`в\s+прямом\s+перекрытии`),
    b(String.raw`против\s+(?:CPA|нашего\s+CPA)`),
    b(String.raw`конкретный\s+момент\s+здесь\s+(?:заключается\s+в\s+том[,\s]+)?что`),
    b(String.raw`то[,\s]+как\s+мы\s+работаем[,\s]+это\s+запустить`),
    b(String.raw`взвешиваем\s+(?:издателей|паблишеров)`),
  ],

  // --------------------------------------------------------------------
  // Japanese (ja)
  // --------------------------------------------------------------------
  ja: [
    b(String.raw`北極星(?:イベント|指標)`),
    b(String.raw`パブリッシャー(?:ミックス|の混合)`),
    b(String.raw`編集(?:プレースメント|配置)`),
    b(String.raw`直接的(?:な)?重(?:なり|複)`),
    b(String.raw`CPA\s*に対して`),
    b(String.raw`具体的(?:な)?ポイントはここで(?:、)?`),
    b(String.raw`私たちの働き方は.{0,10}を実行することです`),
  ],

  // --------------------------------------------------------------------
  // Chinese (zh) — defaults to Simplified Mainland
  // --------------------------------------------------------------------
  zh: [
    b(String.raw`北极星(?:事件|指标)`),
    b(String.raw`发布商(?:混合|混搭)`),
    b(String.raw`编辑(?:位置|投放位置)`),
    b(String.raw`直接重叠`),
    b(String.raw`对抗\s*CPA`),
    b(String.raw`对抗(?:留存|转化)`),
    b(String.raw`这里的具体点是`),
    b(String.raw`我们(?:的)?工作方式是(?:运行|执行)`),
    // Taiwan-traditional leakage in mainland context
    b(String.raw`伺服器`),
    b(String.raw`網路`),
    b(String.raw`資料`),
    b(String.raw`軟體`),
    b(String.raw`硬體`),
  ],

  // --------------------------------------------------------------------
  // Korean (ko)
  // --------------------------------------------------------------------
  ko: [
    b(String.raw`북극성\s*(?:이벤트|지표)`),
    b(String.raw`퍼블리셔\s*(?:믹스|혼합)`),
    b(String.raw`편집\s*배치`),
    b(String.raw`직접\s*중복`),
    b(String.raw`CPA에?\s*반대`),
    b(String.raw`여기서\s*구체적인\s*점은`),
    b(String.raw`우리가\s*일하는\s*방식은.{0,10}을?\s*실행하는\s*것`),
  ],

  // --------------------------------------------------------------------
  // Arabic (ar) — defaults to MSA
  // --------------------------------------------------------------------
  ar: [
    b(String.raw`حدث\s+النجم\s+الشمالي`),
    b(String.raw`خطاف\s+(?:من|في|على)`),
    b(String.raw`مزيج\s+الناشرين`),
    b(String.raw`في\s+تداخل\s+مباشر`),
    b(String.raw`ضد\s+(?:تكلفة|الـCPA)`),
    b(String.raw`\bعايز\b`),
    b(String.raw`\bمش\s+كده\b`),
  ],

  // --------------------------------------------------------------------
  // Hebrew (he)
  // --------------------------------------------------------------------
  he: [
    b(String.raw`אירוע\s+כוכב\s+הצפון`),
    b(String.raw`וו\s+(?:של|עבור)`),
    b(String.raw`תערובת\s+(?:מפרסמים|פאבלישרים)`),
    b(String.raw`בחפיפה\s+ישירה`),
    b(String.raw`נגד\s+(?:ה[-]?CPA)`),
  ],

  // --------------------------------------------------------------------
  // Persian (fa)
  // --------------------------------------------------------------------
  fa: [
    b(String.raw`رویداد\s+ستاره\s+شمالی`),
    b(String.raw`قلاب\s+(?:برای|از)`),
    b(String.raw`در\s+همپوشانی\s+مستقیم`),
    b(String.raw`در\s+مقابل\s+CPA`),
  ],

  // --------------------------------------------------------------------
  // Hindi (hi)
  // --------------------------------------------------------------------
  hi: [
    b(String.raw`उत्तरी\s+तारा\s+घटना`),
    b(String.raw`प्रकाशक\s+मिश्रण`),
    b(String.raw`प्रत्यक्ष\s+ओवरलैप\s+में`),
    b(String.raw`CPA\s+के\s+खिलाफ`),
    b(String.raw`यहां\s+विशिष्ट\s+बिंदु\s+यह\s+है\s+कि`),
  ],

  // --------------------------------------------------------------------
  // Thai (th)
  // --------------------------------------------------------------------
  th: [
    b(String.raw`เหตุการณ์\s*ดาวเหนือ`),
    b(String.raw`ตะขอ\s*(?:สำหรับ|ของ)`),
    b(String.raw`การ\s*ผสม\s*ผู้\s*เผยแพร่`),
    b(String.raw`ใน\s*การ\s*ทับ\s*ซ้อน\s*โดยตรง`),
    b(String.raw`เทียบ\s*กับ\s*CPA`),
  ],

  // --------------------------------------------------------------------
  // Vietnamese (vi)
  // --------------------------------------------------------------------
  vi: [
    b(String.raw`\bsự\s+kiện\s+sao\s+bắc\s+đẩu\b`),
    b(String.raw`\bmóc\s+(?:câu|của)\b`),
    b(String.raw`\bhỗn\s+hợp\s+nhà\s+xuất\s+bản\b`),
    b(String.raw`\btrong\s+sự\s+chồng\s+chéo\s+trực\s+tiếp\b`),
    b(String.raw`\bchống\s+lại\s+CPA\b`),
    b(String.raw`\bcách\s+chúng\s+tôi\s+làm\s+việc\s+là\s+chạy\b`),
  ],

  // --------------------------------------------------------------------
  // Other languages — baseline coverage
  // --------------------------------------------------------------------
  tr: [
    b(String.raw`\bkuzey\s+yıldızı\s+(?:olayı|metriği)\b`),
    b(String.raw`\byayıncı\s+karışımı\b`),
    b(String.raw`\bdoğrudan\s+örtüşmede\b`),
    b(String.raw`\bCPA[' ]ya\s+karşı\b`),
  ],
  pl: [
    b(String.raw`\bgwiazda\s+polarna\s+(?:wydarzenie|metryka)\b`),
    b(String.raw`\bmieszanka\s+wydawców\b`),
    b(String.raw`\bw\s+bezpośrednim\s+nakładaniu\b`),
    b(String.raw`\bprzeciwko\s+CPA\b`),
  ],
  nl: [
    b(String.raw`\bnoordsterevent\b`),
    b(String.raw`\buitgevermix\b`),
    b(String.raw`\bin\s+directe\s+overlap\b`),
    b(String.raw`\btegen\s+de\s+CPA\b`),
  ],
  cs: [
    b(String.raw`\bpolární\s+hvězda\s+(?:událost|metrika)\b`),
    b(String.raw`\bsměs\s+vydavatelů\b`),
    b(String.raw`\bv\s+přímém\s+překryvu\b`),
    b(String.raw`\bproti\s+CPA\b`),
  ],
  hu: [
    b(String.raw`\bsarkcsillag\s+(?:esemény|mutató)\b`),
    b(String.raw`\bkiadó\s+keverék\b`),
    b(String.raw`\bközvetlen\s+átfedésben\b`),
    b(String.raw`\ba\s+CPA\s+ellen\b`),
  ],
  ro: [
    b(String.raw`\beveniment\s+steaua\s+nordului\b`),
    b(String.raw`\bamestec\s+de\s+editori\b`),
    b(String.raw`\bîn\s+suprapunere\s+directă\b`),
    b(String.raw`\bîmpotriva\s+CPA\b`),
  ],
  el: [
    b(String.raw`\bγεγονός\s+πολικός\s+αστέρας\b`),
    b(String.raw`\bμίγμα\s+εκδοτών\b`),
    b(String.raw`\bσε\s+άμεση\s+επικάλυψη\b`),
    b(String.raw`\bενάντια\s+στο\s+CPA\b`),
  ],
};

// ============================================================================
// 3. NATIVE STYLE GUIDES — per-language structural scaffold
// ============================================================================

export interface NativeStyleGuide {
  regional_variant: string;
  social_opener: string;
  connector_phrases: string[];
  softener_phrases: string[];
  collaborative_close: string;
  register_notes: string;
  constructive_parallel_pattern?: string;
  bullet_list_pattern?: string;
}

export const NATIVE_STYLE_GUIDES: Record<string, NativeStyleGuide> = {
  pt: {
    regional_variant:
      "Brazilian Portuguese (pt-BR). Reject European Portuguese vocabulary and grammar: avoid 'estamos a fazer' (use 'estamos fazendo'); avoid 'ordenador'; avoid overly formal 'Caro/a' as primary greeting.",
    social_opener:
      "Open with greeting + comma + name + period + brief social opener. Example: 'Olá, NAME. Como vai?' or 'Olá, NAME. Espero que esteja bem.' NEVER 'Olá NAME,' alone — Brazilian B2B emails always warm up with one social-pleasantry line before going into business.",
    connector_phrases: [
      "Sabemos que…", "Considerando que…", "Vale mencionar que…",
      "Vale destacar que…", "Cabe ressaltar que…",
      "Além disso,", "Além do volume,", "Por outro lado,", "Porém,",
      "Com isso,", "Dessa forma,", "Sendo assim,",
      "Acredito que…", "Entre outros…",
    ],
    softener_phrases: [
      "acredito que", "pode fazer sentido", "vale mencionar",
      "talvez seja interessante", "se fizer sentido para vocês",
      "podemos avaliar", "podemos explorar",
    ],
    constructive_parallel_pattern:
      "Use the NATIVE constructive parallel 'não apenas X, mas (também|principalmente) Y' (not just X, but also/mainly Y) to express upgrade or refinement. This is the native alternative to the banned X-NOT-Y comma-negation pattern. Example: 'usuários qualificados que não apenas realizem a instalação, mas principalmente que façam seu primeiro depósito'. NEVER use the negation-only form 'X, não Y' (without 'apenas' / 'só') — that is the banned LLM-tell pattern.",
    collaborative_close:
      "Two acceptable CTA patterns: (a) Two-sentence soft close: 'Acredito que pode fazer sentido avaliarmos… Você está disponível para falarmos na próxima semana?'. (b) Single-sentence subjunctive: 'Faz sentido falarmos na próxima semana sobre um projeto piloto?'. The verb MUST be in 1st-person-plural subjunctive ('falarmos', 'avaliarmos', 'conversarmos') — NOT a declarative 'falar' or 'comparar'. NEVER use 'Faz sentido X contra Y?' (with 'contra' for comparison).",
    bullet_list_pattern:
      "Bullet lists of 2-4 short items ARE acceptable when listing concrete deliverables / benefits after an introductory phrase like 'Além disso, vocês contarão com:'. Each item: dash prefix, lowercase start, semicolon terminator, one short clause. Do NOT use bullets for narrative content. Do NOT use markdown asterisks, bold, or headers.",
    register_notes:
      "Native BR B2B prose weaves claims into a narrative with cohesion markers; do NOT stack 4-fact sentences. Prefer 'inventários que concentram audiências' over 'posicionamentos editoriais'. Prefer 'sem sobrepor às mídias trabalhadas internamente' over 'em sobreposição direta'. Prefer 'versus' or 'comparado a' over 'contra' for comparison. Use 'mix de editores' (English loanword 'mix' accepted in BR) NOT 'mistura de editores'. For 'cohort' use 'coorte' consistently — do NOT mix with 'safra'. ENGLISH LOANWORDS that are NATIVE in BR adtech and should NOT be translated: performance, fee, players, mix, mobile, app/apps, blog/blogs, ROAS, LTV, KPI/KPIs, CTV, RTG, AB (as in 'testes AB').",
  },

  es: {
    regional_variant:
      "LatAm-neutral Spanish (es-LatAm). Reject Spain-Spanish vocabulary: avoid 'ordenador' (use 'computadora'); avoid 'móvil' in adtech context (use 'celular' or English 'mobile'); avoid 'vosotros' and its object 'os' (use 'ustedes'); avoid 'coger' (use 'tomar').",
    social_opener:
      "Open with greeting + comma + name + period + brief social opener. Example: 'Hola, NAME. ¿Cómo estás?' or 'Hola, NAME. Espero que te encuentres bien.' NEVER 'Hola NAME,' alone.",
    connector_phrases: [
      "Sabemos que…", "Considerando que…", "Vale la pena mencionar que…",
      "Cabe destacar que…", "Vale resaltar que…",
      "Además,", "Más allá del volumen,", "Por otro lado,", "Sin embargo,",
      "Con esto,", "De esta forma,", "Así,",
      "Creo que…", "Entre otros…",
    ],
    softener_phrases: [
      "creo que", "puede tener sentido", "valdría la pena",
      "tal vez sea interesante", "si tiene sentido para ustedes",
      "podemos evaluar", "podemos explorar",
    ],
    constructive_parallel_pattern:
      "Use the NATIVE constructive parallel 'no solo X, sino (también|principalmente) Y'. Native alternative to the banned X-NOT-Y. NEVER use 'X, no Y' without 'solo' / 'sólo' — that is the banned LLM-tell pattern.",
    collaborative_close:
      "Two acceptable patterns: (a) Two-sentence: 'Creo que puede tener sentido evaluar… ¿Tendrías disponibilidad para conversar la próxima semana?'. (b) Single-sentence subjunctive: '¿Tendría sentido conversemos la próxima semana sobre un piloto?'. Verb MUST be 1st-person-plural subjunctive ('conversemos', 'evaluemos'). NEVER '¿Tiene sentido X contra Y?' (with 'contra' for comparison).",
    bullet_list_pattern:
      "Bullet lists of 2-4 short items ARE acceptable when listing concrete deliverables after an introductory phrase like 'Además, ustedes contarán con:'. Same format rules as pt.",
    register_notes:
      "LatAm B2B prose uses cohesion markers. Prefer 'inventarios que concentran audiencias' over 'posicionamientos editoriales'. Prefer 'versus' or 'comparado a' over 'contra' for comparison. Use 'mix de editores' NOT 'mezcla de editores'. ENGLISH LOANWORDS that are NATIVE in LatAm adtech: performance, fee, players, mix, mobile, app/apps, blog/blogs, ROAS, LTV, KPI/KPIs, CTV, RTG.",
  },

  it: {
    regional_variant: "Standard Italian (it-IT).",
    social_opener:
      "Open with 'Gentile NAME,' then 'Spero che tu stia bene.' or 'Buongiorno.'",
    connector_phrases: [
      "Sappiamo che…", "Considerando che…", "Vale la pena notare che…",
      "Inoltre,", "D'altra parte,", "Ritengo che…",
    ],
    softener_phrases: ["ritengo che", "potrebbe avere senso", "varrebbe la pena"],
    collaborative_close:
      "Two-sentence soft close: 'Ritengo che potrebbe avere senso valutare un pilota… Saresti disponibile per parlarne la prossima settimana?'",
    register_notes:
      "Italian B2B is formal and uses cohesion markers. Prefer 'rispetto a' or 'versus' over 'contro' for comparison.",
  },

  fr: {
    regional_variant:
      "Standard French (fr-FR). Apply French diacritics to proper names where the name has a known French form.",
    social_opener:
      "Open with 'Bonjour NAME,' then 'J'espère que vous allez bien.'",
    connector_phrases: [
      "Nous savons que…", "Considérant que…", "Il vaut la peine de noter que…",
      "Par ailleurs,", "De plus,", "Je pense que…",
    ],
    softener_phrases: ["je pense que", "il pourrait avoir du sens", "peut-être"],
    collaborative_close:
      "Two-sentence soft close: 'Je pense qu'il pourrait avoir du sens d'évaluer un pilote… Seriez-vous disponible pour en discuter la semaine prochaine?'",
    register_notes:
      "French B2B uses 'vous' formal register. Prefer 'par rapport à' or 'versus' over 'contre' for comparison.",
  },

  de: {
    regional_variant: "Standard German (de-DE).",
    social_opener:
      "Open with 'Guten Tag NAME,' (gender-neutral default). German B2B is more direct than Romance languages — no extensive social warm-up needed.",
    connector_phrases: [
      "Wir wissen, dass…", "Angesichts der Tatsache, dass…",
      "Es ist erwähnenswert, dass…", "Darüber hinaus,",
      "Andererseits,", "Ich glaube, dass…",
    ],
    softener_phrases: [
      "ich glaube, dass", "es könnte Sinn machen", "es wäre vielleicht",
    ],
    collaborative_close:
      "Two-sentence soft close: 'Ich glaube, es könnte Sinn machen, einen Pilotversuch zu prüfen… Hätten Sie nächste Woche Zeit für ein Gespräch?'",
    register_notes:
      "German B2B is precise and direct but uses cohesion markers. Use 'gegenüber' or 'im Vergleich zu' for comparison, NOT 'gegen'. Use 'Publisher-Mix' or 'Publisher-Auswahl', NOT 'Publisher-Mischung'.",
  },

  ru: {
    regional_variant: "Standard Russian (ru-RU).",
    social_opener:
      "Open with 'Здравствуйте, NAME-IN-CYRILLIC,' then 'Надеюсь, что у вас всё хорошо.'",
    connector_phrases: [
      "Мы знаем, что…", "Учитывая, что…", "Стоит отметить, что…",
      "Кроме того,", "С другой стороны,", "Полагаю, что…",
    ],
    softener_phrases: ["полагаю, что", "может иметь смысл", "возможно,"],
    collaborative_close:
      "Two-sentence soft close: 'Полагаю, что может иметь смысл оценить пилотный проект… Будете ли вы доступны для разговора на следующей неделе?'",
    register_notes:
      "Russian B2B uses formal 'Вы'. For comparison use 'по сравнению с' or Latin 'versus', NOT 'против'.",
  },

  ja: {
    regional_variant: "Standard Japanese (ja-JP). Use 敬語 (keigo).",
    social_opener:
      "Open with 'NAME-IN-KATAKANA様' on first line, then '突然のご連絡失礼いたします。' as second-line social opener. Japanese B2B cold outreach REQUIRES the apologetic opener.",
    connector_phrases: [
      "～と存じます", "～につきまして", "また、", "さらに、",
      "ご検討いただけますと幸いです",
    ],
    softener_phrases: ["～かもしれません", "～と存じます", "もしよろしければ"],
    collaborative_close:
      "Soft close with 'もしよろしければ、来週お打ち合わせの機会をいただけますでしょうか。' style — explicit time-frame, permission-asking grammar, full keigo.",
    register_notes:
      "Japanese B2B uses full keigo. Verbs end in ～ます / ～です. Use 御社 for the recipient's company, 弊社 for own.",
  },

  zh: {
    regional_variant:
      "Simplified Chinese (zh-CN, Mainland). Reject Traditional Chinese vocabulary: 服务器 NOT 伺服器; 网络 NOT 網路; 数据 NOT 資料; 软件 NOT 軟體; 视频 NOT 影片.",
    social_opener:
      "Open with '您好，' on greeting line. Second line: '冒昧打扰，' or '感谢您抽空阅读这封邮件。' as social opener.",
    connector_phrases: [
      "我们了解到…", "考虑到…", "值得一提的是…",
      "此外，", "另一方面，", "我们认为…",
    ],
    softener_phrases: ["我们认为", "或许可以", "可能有意义"],
    collaborative_close:
      "Soft close: '我们认为可以评估一个试点项目… 请问您下周是否方便沟通？'",
    register_notes:
      "Use 您 (formal you), NOT 你. For comparison use 相比 or 对比, NOT 对抗.",
  },

  ko: {
    regional_variant: "Standard Korean (ko-KR). Use 존댓말 (formal speech).",
    social_opener:
      "Open with 'NAME-IN-HANGUL 님,' then '갑작스러운 연락 드려 죄송합니다.' Korean B2B cold outreach REQUIRES the apologetic opener.",
    connector_phrases: [
      "～을(를) 알고 있습니다", "～을(를) 고려하면", "또한,", "한편,",
      "～라고 생각합니다",
    ],
    softener_phrases: [
      "～라고 생각합니다", "～수도 있습니다", "혹시 괜찮으시다면",
    ],
    collaborative_close:
      "Soft close with permission-asking grammar and explicit time-frame: '혹시 다음 주에 짧게 통화 가능하실까요?'",
    register_notes:
      "Korean B2B uses 존댓말 ending in -ㅂ니다 / -입니다. For comparison use 대비 or 비교, NOT 반대.",
  },

  ar: {
    regional_variant:
      "Modern Standard Arabic (MSA, fuṣḥā). Reject Egyptian, Levantine, Gulf, Maghrebi colloquialisms.",
    social_opener:
      "Open with 'السلام عليكم NAME-IN-ARABIC،' or 'مرحبًا NAME-IN-ARABIC،' then 'أتمنى أن تكون بخير.'",
    connector_phrases: [
      "نعلم أن…", "بالنظر إلى أن…", "تجدر الإشارة إلى أن…",
      "علاوة على ذلك،", "من ناحية أخرى،", "أعتقد أن…",
    ],
    softener_phrases: ["أعتقد أن", "قد يكون من المفيد", "ربما"],
    collaborative_close:
      "Soft close: 'أعتقد أن من المفيد تقييم برنامج تجريبي… هل ستكون متاحًا للتحدث الأسبوع المقبل؟'",
    register_notes:
      "MSA register throughout. Right-to-left text direction. For comparison use 'مقارنة بـ' NOT 'ضد'.",
  },

  he: {
    regional_variant: "Standard Modern Hebrew (he-IL).",
    social_opener:
      "Open with 'שלום NAME-IN-HEBREW,' then 'מקווה שאתה/את במצב טוב.'",
    connector_phrases: [
      "אנו יודעים ש…", "בהתחשב בכך ש…", "ראוי לציין ש…",
      "בנוסף,", "מצד שני,", "אני מאמין ש…",
    ],
    softener_phrases: ["אני מאמין ש", "ייתכן שיהיה הגיוני", "אולי"],
    collaborative_close:
      "Soft close: 'אני מאמין שיכול להיות הגיוני להעריך פיילוט… האם תהיה זמין לשיחה בשבוע הבא?'",
    register_notes: "Hebrew B2B uses formal register. For comparison use 'בהשוואה ל' NOT 'נגד'.",
  },

  hi: {
    regional_variant: "Standard Hindi (hi-IN). Devanagari script throughout body.",
    social_opener:
      "Open with 'नमस्ते NAME-IN-DEVANAGARI,' then 'आशा है आप कुशल हैं।'",
    connector_phrases: [
      "हम जानते हैं कि…", "यह देखते हुए कि…", "उल्लेखनीय है कि…",
      "इसके अलावा,", "दूसरी ओर,", "मेरा मानना है कि…",
    ],
    softener_phrases: ["मेरा मानना है कि", "अर्थपूर्ण हो सकता है", "शायद"],
    collaborative_close: "Soft close: 'क्या आप अगले सप्ताह बात करने के लिए उपलब्ध होंगे?'",
    register_notes: "Hindi B2B uses formal आप. For comparison use 'की तुलना में', NOT 'के खिलाफ'.",
  },

  th: {
    regional_variant: "Standard Central Thai (th-TH).",
    social_opener:
      "Open with 'เรียน NAME-IN-THAI,' then a brief polite opener like 'หวังว่าคุณสบายดี.'",
    connector_phrases: [
      "เราทราบว่า…", "เมื่อพิจารณาว่า…", "ที่น่าสนใจคือ…",
      "นอกจากนี้,", "ในทางกลับกัน,", "ผม/ดิฉันคิดว่า…",
    ],
    softener_phrases: ["คิดว่า", "อาจจะมีความหมาย", "บางที"],
    collaborative_close:
      "Soft close: 'ผม/ดิฉันคิดว่าน่าจะมีประโยชน์ หากเราประเมินไพล็อต… คุณสะดวกที่จะคุยในสัปดาห์หน้าหรือไม่?'",
    register_notes:
      "Thai B2B uses polite particles ครับ/ค่ะ in signature. For comparison use 'เมื่อเทียบกับ' NOT 'ต่อต้าน'.",
  },

  vi: {
    regional_variant:
      "Standard Vietnamese (vi-VN). Names MUST use proper Vietnamese diacritics: 'Tuan' must be 'Tuấn'; 'Huong' must be 'Hương'.",
    social_opener:
      "Open with 'Kính gửi anh/chị NAME,' (B2B formal), then 'Hy vọng anh/chị nhận được email này khi đang khỏe.' NEVER 'Chào' alone for cold B2B.",
    connector_phrases: [
      "Chúng tôi biết rằng…", "Xét rằng…", "Đáng chú ý là…",
      "Ngoài ra,", "Mặt khác,", "Chúng tôi tin rằng…",
    ],
    softener_phrases: ["chúng tôi tin rằng", "có thể có ý nghĩa", "có lẽ"],
    collaborative_close:
      "Soft close: 'Chúng tôi tin rằng có thể có ý nghĩa để đánh giá một pilot… Anh/chị có thể sắp xếp thời gian trao đổi vào tuần tới không?'",
    register_notes:
      "Vietnamese B2B uses anh/chị as respectful 'you'. For comparison use 'so với', NOT 'chống lại'.",
  },

  // Baseline coverage for the remaining major target languages
  tr: {
    regional_variant: "Standard Turkish (tr-TR).",
    social_opener: "Open with 'Sayın NAME,' (formal) then 'Umarım iyisinizdir.'",
    connector_phrases: ["Bildiğimiz gibi…", "Göz önünde bulundurarak…", "Belirtmek gerekir ki…", "Ayrıca,", "Öte yandan,"],
    softener_phrases: ["sanırım", "anlamlı olabilir", "belki"],
    collaborative_close: "Soft close with time-frame: 'Önümüzdeki hafta bir pilot değerlendirme konusunda görüşebilir miyiz?'",
    register_notes: "Turkish B2B uses formal 'siz'. For comparison use 'kıyasla' NOT 'karşı'.",
  },
  pl: {
    regional_variant: "Standard Polish (pl-PL).",
    social_opener: "Open with 'Dzień dobry NAME,' then 'Mam nadzieję, że ten e-mail zastaje Pana/Panią w dobrym nastroju.'",
    connector_phrases: ["Wiemy, że…", "Biorąc pod uwagę, że…", "Warto wspomnieć, że…", "Ponadto,", "Z drugiej strony,"],
    softener_phrases: ["uważam, że", "może mieć sens", "być może"],
    collaborative_close: "Soft close with time-frame: 'Czy w przyszłym tygodniu znajdzie Pan/Pani chwilę na krótką rozmowę?'",
    register_notes: "Polish B2B uses formal Pan/Pani. For comparison use 'w porównaniu z' NOT 'przeciwko'.",
  },
  nl: {
    regional_variant: "Standard Dutch (nl-NL).",
    social_opener: "Open with 'Beste NAME,' then 'Ik hoop dat deze e-mail u in goede gezondheid bereikt.'",
    connector_phrases: ["We weten dat…", "Gezien het feit dat…", "Het is vermeldenswaard dat…", "Daarnaast,", "Anderzijds,"],
    softener_phrases: ["ik denk dat", "het zou zinvol kunnen zijn", "wellicht"],
    collaborative_close: "Soft close: 'Zou u volgende week tijd hebben voor een kort gesprek?'",
    register_notes: "Dutch B2B uses formal 'u'. For comparison use 'in vergelijking met' NOT 'tegen'.",
  },
  cs: {
    regional_variant: "Standard Czech (cs-CZ).",
    social_opener: "Open with 'Dobrý den NAME,' then 'Doufám, že se Vám daří dobře.'",
    connector_phrases: ["Víme, že…", "Vzhledem k tomu, že…", "Stojí za zmínku, že…", "Kromě toho,"],
    softener_phrases: ["domnívám se, že", "mohlo by to mít smysl"],
    collaborative_close: "Soft close: 'Měl(a) byste příští týden čas na krátký hovor?'",
    register_notes: "Czech B2B uses formal 'Vy'. For comparison use 've srovnání s' NOT 'proti'.",
  },
  hu: {
    regional_variant: "Standard Hungarian (hu-HU).",
    social_opener: "Open with 'Tisztelt NAME!' then 'Remélem, jól van.'",
    connector_phrases: ["Tudjuk, hogy…", "Tekintettel arra, hogy…", "Érdemes megemlíteni, hogy…", "Továbbá,"],
    softener_phrases: ["úgy gondolom", "értelmes lehet"],
    collaborative_close: "Soft close: 'Lenne lehetősége egy rövid beszélgetésre a jövő héten?'",
    register_notes: "Hungarian B2B uses Ön (formal). For comparison use 'összehasonlítva' NOT 'ellen'.",
  },
  ro: {
    regional_variant: "Standard Romanian (ro-RO).",
    social_opener: "Open with 'Bună ziua NAME,' then 'Sper că vă găsesc bine.'",
    connector_phrases: ["Știm că…", "Având în vedere că…", "Merită menționat că…", "În plus,"],
    softener_phrases: ["cred că", "ar putea avea sens"],
    collaborative_close: "Soft close: 'Ați avea disponibilitate pentru o discuție săptămâna viitoare?'",
    register_notes: "Romanian B2B uses 'Dumneavoastră' formal. For comparison use 'comparativ cu' NOT 'împotriva'.",
  },
  el: {
    regional_variant: "Standard Modern Greek (el-GR).",
    social_opener: "Open with 'Αγαπητέ NAME,' (m) or 'Αγαπητή NAME,' (f) or 'Γεια σας NAME,'. Then a brief polite opener.",
    connector_phrases: ["Γνωρίζουμε ότι…", "Λαμβάνοντας υπόψη ότι…", "Αξίζει να σημειωθεί ότι…", "Επιπλέον,"],
    softener_phrases: ["πιστεύω ότι", "θα μπορούσε να έχει νόημα"],
    collaborative_close: "Soft close: 'Θα ήσασταν διαθέσιμοι για μια σύντομη συζήτηση την επόμενη εβδομάδα?'",
    register_notes: "Greek B2B uses formal πληθυντικός. For comparison use 'σε σύγκριση με' NOT 'ενάντια'.",
  },
  fi: {
    regional_variant: "Standard Finnish (fi-FI).",
    social_opener: "Open with 'Hei NAME,' (Finnish B2B is informal-by-default).",
    connector_phrases: ["Tiedämme, että…", "Ottaen huomioon…", "Mainittakoon, että…", "Lisäksi,"],
    softener_phrases: ["uskon, että", "voisi olla järkevää"],
    collaborative_close: "Soft close: 'Olisiko sinulla aikaa lyhyeen keskusteluun ensi viikolla?'",
    register_notes: "Finnish B2B is direct and uses 'sinä' (informal-respectful is the default). For comparison use 'verrattuna' NOT 'vastaan'.",
  },
  sv: {
    regional_variant: "Standard Swedish (sv-SE).",
    social_opener: "Open with 'Hej NAME,' (Swedish B2B is informal; first-name basis is standard).",
    connector_phrases: ["Vi vet att…", "Med tanke på att…", "Värt att nämna att…", "Dessutom,"],
    softener_phrases: ["jag tror att", "det skulle kunna vara meningsfullt"],
    collaborative_close: "Soft close: 'Skulle du ha tid för ett kort samtal nästa vecka?'",
    register_notes: "Swedish B2B uses 'du'. For comparison use 'jämfört med' NOT 'mot'.",
  },
  no: {
    regional_variant: "Standard Norwegian Bokmål (no/nb-NO).",
    social_opener: "Open with 'Hei NAME,'",
    connector_phrases: ["Vi vet at…", "Tatt i betraktning…", "Verdt å nevne at…", "I tillegg,"],
    softener_phrases: ["jeg tror at", "det kan gi mening"],
    collaborative_close: "Soft close: 'Ville du hatt tid til en kort samtale neste uke?'",
    register_notes: "Norwegian B2B uses 'du'. For comparison use 'sammenlignet med' NOT 'mot'.",
  },
  nb: {
    regional_variant: "Norwegian Bokmål (nb-NO). Same as 'no'.",
    social_opener: "Open with 'Hei NAME,'",
    connector_phrases: ["Vi vet at…", "Tatt i betraktning…", "Verdt å nevne at…", "I tillegg,"],
    softener_phrases: ["jeg tror at", "det kan gi mening"],
    collaborative_close: "Soft close: 'Ville du hatt tid til en kort samtale neste uke?'",
    register_notes: "Norwegian B2B uses 'du'. For comparison use 'sammenlignet med' NOT 'mot'.",
  },
  da: {
    regional_variant: "Standard Danish (da-DK).",
    social_opener: "Open with 'Hej NAME,' (Danish B2B is informal).",
    connector_phrases: ["Vi ved, at…", "I betragtning af, at…", "Det er værd at nævne, at…", "Desuden,"],
    softener_phrases: ["jeg tror, at", "det kunne give mening"],
    collaborative_close: "Soft close: 'Ville du have tid til en kort samtale i næste uge?'",
    register_notes: "Danish B2B uses 'du'. For comparison use 'sammenlignet med' NOT 'mod'.",
  },
  uk: {
    regional_variant: "Standard Ukrainian (uk-UA).",
    social_opener: "Open with 'Вітаю, NAME-IN-CYRILLIC,' then 'Сподіваюся, що цей лист застає Вас у доброму настрої.'",
    connector_phrases: ["Ми знаємо, що…", "Враховуючи, що…", "Варто зазначити, що…", "Крім того,"],
    softener_phrases: ["вважаю, що", "може мати сенс"],
    collaborative_close: "Soft close: 'Чи будете Ви доступні для короткої розмови наступного тижня?'",
    register_notes: "Ukrainian B2B uses formal 'Ви'. For comparison use 'у порівнянні з' NOT 'проти'.",
  },
  id: {
    regional_variant: "Standard Indonesian (id-ID).",
    social_opener: "Open with 'Yth. NAME,' or 'Halo NAME,' then 'Semoga email ini sampai dalam keadaan baik.'",
    connector_phrases: ["Kami mengetahui bahwa…", "Mengingat bahwa…", "Perlu disebutkan bahwa…", "Selain itu,"],
    softener_phrases: ["saya percaya bahwa", "mungkin masuk akal"],
    collaborative_close: "Soft close: 'Apakah Anda tersedia untuk berbicara minggu depan?'",
    register_notes: "Indonesian B2B uses 'Anda'. For comparison use 'dibandingkan dengan' NOT 'melawan'.",
  },
  ms: {
    regional_variant: "Standard Malay (ms-MY).",
    social_opener: "Open with 'Yang Berusaha NAME,' (formal) or 'Salam sejahtera NAME,' then a brief polite opener.",
    connector_phrases: ["Kami tahu bahawa…", "Memandangkan…", "Patut disebut bahawa…", "Selain itu,"],
    softener_phrases: ["saya percaya bahawa", "mungkin masuk akal"],
    collaborative_close: "Soft close: 'Adakah anda lapang untuk berbual pada minggu depan?'",
    register_notes: "Malay B2B uses formal 'anda'. For comparison use 'berbanding dengan' NOT 'menentang'.",
  },
  fil: {
    regional_variant: "Filipino/Tagalog (fil/tl-PH). English greeting 'Hi NAME,' is fully acceptable.",
    social_opener: "Open with 'Magandang araw NAME,' or 'Hi NAME,' then a brief polite opener.",
    connector_phrases: ["Alam namin na…", "Isinasaalang-alang na…", "Karapat-dapat banggitin na…", "Bukod pa rito,"],
    softener_phrases: ["naniniwala ako na", "maaaring magkaroon ng saysay"],
    collaborative_close: "Soft close: 'Magkakaroon po ba kayo ng oras para sa maikling usapan sa susunod na linggo?'",
    register_notes: "Filipino B2B uses formal 'po' particles. For comparison use 'kumpara sa' NOT 'laban sa'.",
  },
  tl: {
    regional_variant: "Tagalog (tl-PH). Same as 'fil'.",
    social_opener: "Open with 'Magandang araw NAME,' or 'Hi NAME,'",
    connector_phrases: ["Alam namin na…", "Isinasaalang-alang na…", "Karapat-dapat banggitin na…", "Bukod pa rito,"],
    softener_phrases: ["naniniwala ako na", "maaaring magkaroon ng saysay"],
    collaborative_close: "Soft close: 'Magkakaroon po ba kayo ng oras para sa maikling usapan sa susunod na linggo?'",
    register_notes: "Same as 'fil'.",
  },
  sw: {
    regional_variant: "Standard Swahili (sw-TZ / sw-KE).",
    social_opener: "Open with 'Habari NAME,' then 'Natumai unaipata barua pepe hii ukiwa salama.'",
    connector_phrases: ["Tunajua kwamba…", "Kwa kuzingatia…", "Inafaa kutaja kwamba…", "Aidha,"],
    softener_phrases: ["naamini kwamba", "inaweza kuwa na maana"],
    collaborative_close: "Soft close: 'Je, utakuwa na nafasi ya kuongea wiki ijayo?'",
    register_notes: "Swahili B2B uses respectful 'wewe'. For comparison use 'ikilinganishwa na' NOT 'dhidi ya'.",
  },
  am: {
    regional_variant: "Standard Amharic (am-ET).",
    social_opener: "Open with 'ውድ NAME,' (formal B2B), then a brief polite opener.",
    connector_phrases: ["እንደምታውቁት…", "ይህን ግምት ውስጥ በማስገባት…", "በተጨማሪም,"],
    softener_phrases: ["እኔ እንደማስበው", "ምክንያታዊ ሊሆን ይችላል"],
    collaborative_close: "Soft close: 'በቀጣዩ ሳምንት ለማውራት ጊዜ ይኖራዎታል?'",
    register_notes: "Amharic B2B uses formal register. For comparison use 'ጋር ሲነጻጸር' NOT 'በተቃራኒ'.",
  },
  bn: {
    regional_variant: "Standard Bengali (bn-IN / bn-BD).",
    social_opener: "Open with 'প্রিয় NAME-IN-BENGALI,' then 'আশা করি ভালো আছেন।'",
    connector_phrases: ["আমরা জানি যে…", "বিবেচনা করে যে…", "উল্লেখযোগ্য যে…", "এছাড়াও,"],
    softener_phrases: ["আমি মনে করি যে", "অর্থপূর্ণ হতে পারে"],
    collaborative_close: "Soft close: 'আগামী সপ্তাহে কথা বলার জন্য আপনি কি সময় বের করতে পারবেন?'",
    register_notes: "Bengali B2B uses formal আপনি. For comparison use 'এর তুলনায়' NOT 'বিরুদ্ধে'.",
  },
  ur: {
    regional_variant: "Standard Urdu (ur-PK / ur-IN). Right-to-left script.",
    social_opener: "Open with 'السلام علیکم NAME-IN-URDU،' or 'محترم NAME،' then 'امید ہے آپ خیریت سے ہوں گے۔'",
    connector_phrases: ["ہم جانتے ہیں کہ…", "یہ مدنظر رکھتے ہوئے کہ…", "قابل ذکر ہے کہ…", "علاوہ ازیں,"],
    softener_phrases: ["میرا خیال ہے کہ", "بامعنی ہو سکتا ہے"],
    collaborative_close: "Soft close: 'کیا اگلے ہفتے بات کرنے کے لیے آپ کے پاس وقت ہوگا؟'",
    register_notes: "Urdu B2B uses formal آپ. For comparison use 'کے مقابلے میں' NOT 'کے خلاف'.",
  },
};

// ============================================================================
// 4. DETECTORS
// ============================================================================

/**
 * Scan body for known translationese patterns in the target language.
 * Returns a list of matched substrings, deduplicated case-insensitively.
 */
export function findTranslationese(text: string, lang: string): string[] {
  const langN = normalizeLanguageCode(lang);
  const patterns = TRANSLATIONESE_PATTERNS[langN];
  if (!patterns || !text) return [];

  const seen = new Set<string>();
  const hits: string[] = [];
  for (const pat of patterns) {
    // Make sure the pattern is global so we can iterate matches
    const re = pat.global ? pat : new RegExp(pat.source, pat.flags + "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const s = m[0].trim();
      const key = s.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        hits.push(s);
      }
      if (m.index === re.lastIndex) re.lastIndex++; // empty-match safety
    }
  }
  return hits;
}

const LATIN_WORD_RE_V4 = /[A-Za-z][A-Za-z'\-]+/g;
const HAS_NON_LATIN_RE_V4 = new RegExp(
  "[" +
    "\\u0400-\\u04FF" + // Cyrillic
    "\\u0370-\\u03FF" + // Greek
    "\\u0590-\\u05FF" + // Hebrew
    "\\u0600-\\u06FF" + // Arabic
    "\\u0900-\\u097F" + // Devanagari
    "\\u0980-\\u09FF" + // Bengali
    "\\u0E00-\\u0E7F" + // Thai
    "\\u3040-\\u30FF" + // Japanese kana
    "\\u4E00-\\u9FFF" + // CJK
    "\\uAC00-\\uD7AF" + // Hangul
    "\\u0600-\\u06FF\\u0750-\\u077F\\u08A0-\\u08FF\\uFB50-\\uFDFF\\uFE70-\\uFEFF" + // Arabic ranges
    "\\u1200-\\u137F" + // Ethiopic
    "]"
);

/**
 * Detect greeting-line name adaptation issues. Mirrors the v3
 * findUntransliteratedGreetingName behaviour exactly — only non-Latin-script
 * targets are flagged deterministically. Latin-script-with-diacritic
 * adaptation is handled in the writer prompt block (too many false positives
 * without a name dictionary).
 */
export function findGreetingNameAdaptationIssues(text: string, lang: string): string[] {
  const langN = normalizeLanguageCode(lang);
  if (!text) return [];
  if (!NON_LATIN_SCRIPT_LANGS.has(langN)) return [];

  let firstLine = "";
  for (const line of text.split("\n")) {
    if (line.trim()) {
      firstLine = line.trim();
      break;
    }
  }
  if (!firstLine) return [];
  if (!HAS_NON_LATIN_RE_V4.test(firstLine)) return [];

  const hits: string[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(LATIN_WORD_RE_V4.source, LATIN_WORD_RE_V4.flags);
  while ((m = re.exec(firstLine)) !== null) {
    const tok = m[0];
    if (LATIN_ALLOWLIST.has(tok)) continue;
    if (BOILERPLATE_LATIN.has(tok.toLowerCase())) continue;
    if (tok.length < 2) continue;
    hits.push(tok);
  }
  return hits;
}

// ============================================================================
// v4 Round-2 (Universal native-style detectors)
// ============================================================================
// Three new detectors that catch failure modes Denise (BR PT native reviewer)
// flagged but that apply to every language the v4 layer covers:
//   - REPEATING-DISCOURSE-MARKER  (sentence-starter reuse, 26 languages)
//   - SEMICOLON-NO-CONNECTOR      (clause coherence, 17 languages)
//   - NON-REFLEXIVE-ROMANCE-VERB  (reflexive verb preference, 4 Romance langs)
// TypeScript port of prospector/stages/nativeness_v4.py v4 Round-2 work —
// behavior parity with the Python detectors verified by shared test fixtures.

export const REPEATING_DISCOURSE_MARKERS: Record<string, readonly string[]> = {
  en: ["worth mentioning", "worth noting", "i should add", "i'd note that",
       "notably", "importantly", "it's worth"],
  pt: ["vale mencionar", "vale destacar", "vale notar", "vale ressaltar",
       "é importante destacar", "é importante mencionar", "cabe destacar",
       "cabe mencionar", "convém destacar"],
  "pt-BR": ["vale mencionar", "vale destacar", "vale notar", "vale ressaltar",
            "é importante destacar", "é importante mencionar", "cabe destacar",
            "cabe mencionar", "convém destacar"],
  es: ["vale la pena mencionar", "vale la pena destacar", "cabe destacar",
       "cabe mencionar", "es importante notar", "es importante destacar",
       "conviene señalar", "conviene destacar"],
  fr: ["il convient de mentionner", "il convient de noter", "à noter",
       "à signaler", "notons que", "il est important de souligner",
       "il faut souligner", "il faut mentionner"],
  de: ["erwähnenswert ist", "bemerkenswert ist", "hervorzuheben ist",
       "es ist anzumerken", "es sei erwähnt", "anzumerken ist"],
  it: ["vale la pena menzionare", "vale la pena notare", "è importante notare",
       "è importante sottolineare", "da notare che", "merita menzionare",
       "occorre sottolineare"],
  nl: ["het is vermeldenswaard", "vermeldenswaard is", "opmerkelijk is",
       "noemenswaard is"],
  ja: ["なお", "ちなみに", "ご参考までに", "申し添えますと"],
  zh: ["值得一提的是", "顺便提一下", "另外值得注意的是", "值得注意的是"],
  ko: ["참고로", "덧붙여 말하면", "참고하시면", "한 가지 더 말씀드리면"],
  ar: ["تجدر الإشارة", "من الجدير بالذكر", "والجدير بالذكر", "تجدر الاشارة"],
  he: ["ראוי לציין", "כדאי להזכיר", "יש לציין", "חשוב לציין"],
  ru: ["стоит отметить", "важно упомянуть", "следует подчеркнуть",
       "стоит подчеркнуть", "необходимо отметить"],
  uk: ["варто зазначити", "слід підкреслити", "важливо зазначити",
       "необхідно відзначити"],
  tr: ["belirtmek gerekir ki", "şunu da belirtmek isterim",
       "şunu da eklemek isterim", "vurgulamak gerekir ki"],
  hi: ["बता दें कि", "ध्यान देने योग्य है", "गौरतलब है कि", "उल्लेखनीय है कि"],
  pl: ["warto wspomnieć", "warto zauważyć", "warto podkreślić", "należy zaznaczyć"],
  cs: ["stojí za zmínku", "je třeba poznamenat", "za zmínku stojí"],
  hu: ["érdemes megemlíteni", "fontos megjegyezni", "ki kell emelni"],
  ro: ["merită menționat", "trebuie subliniat", "este important de menționat"],
  sv: ["värt att nämna", "värt att notera", "det är värt att"],
  no: ["verdt å nevne", "verdt å merke seg", "det er verdt å"],
  nb: ["verdt å nevne", "verdt å merke seg", "det er verdt å"],
  da: ["værd at nævne", "værd at bemærke", "det er værd at"],
  fi: ["on syytä mainita", "on syytä huomata", "kannattaa mainita"],
};

export interface RepeatingMarkerHit {
  marker: string;
  count: number;
}

export function findRepeatingDiscourseMarkers(
  text: string,
  lang: string
): RepeatingMarkerHit[] {
  if (!text) return [];
  const langStr = (lang || "").trim().toLowerCase();
  let markers = REPEATING_DISCOURSE_MARKERS[langStr];
  if (!markers) {
    const base = langStr.includes("-") ? langStr.split("-")[0] : langStr;
    markers = REPEATING_DISCOURSE_MARKERS[base];
  }
  if (!markers || markers.length === 0) return [];

  const lower = text.toLowerCase();
  const hits: RepeatingMarkerHit[] = [];
  for (const marker of markers) {
    const m = marker.toLowerCase();
    // Count all occurrences
    let count = 0;
    let idx = lower.indexOf(m);
    while (idx !== -1) {
      count += 1;
      idx = lower.indexOf(m, idx + m.length);
    }
    if (count >= 2) {
      hits.push({ marker, count });
    }
  }
  return hits;
}


export const SEMICOLON_CONNECTORS: Record<string, readonly string[]> = {
  en: ["therefore", "thus", "hence", "consequently", "as", "accordingly",
       "moreover", "however", "still", "also", "indeed", "furthermore",
       "in addition", "in fact", "in contrast", "in particular", "nonetheless"],
  pt: ["logo", "portanto", "dessa forma", "assim", "por isso", "em vista disso",
       "ademais", "ou seja", "no entanto", "contudo", "além disso",
       "consequentemente", "diante disso"],
  "pt-BR": ["logo", "portanto", "dessa forma", "assim", "por isso", "em vista disso",
            "ademais", "ou seja", "no entanto", "contudo", "além disso",
            "consequentemente", "diante disso"],
  es: ["por lo tanto", "por consiguiente", "así pues", "en consecuencia",
       "de ahí que", "asimismo", "no obstante", "sin embargo", "además",
       "es decir", "por ende"],
  fr: ["ainsi", "par conséquent", "de ce fait", "aussi", "dès lors",
       "néanmoins", "toutefois", "en outre", "cependant", "c'est-à-dire",
       "à savoir"],
  de: ["daher", "folglich", "somit", "demnach", "infolgedessen", "dennoch",
       "jedoch", "außerdem", "zudem", "das heißt", "darüber hinaus"],
  it: ["pertanto", "quindi", "di conseguenza", "per cui", "ne consegue che",
       "tuttavia", "inoltre", "ovvero", "in altre parole", "cioè"],
  nl: ["daarom", "bijgevolg", "vandaar", "aldus", "echter", "bovendien",
       "dat wil zeggen", "namelijk"],
  ru: ["следовательно", "поэтому", "таким образом", "однако", "тем не менее",
       "то есть", "кроме того", "более того"],
  uk: ["отже", "тому", "таким чином", "однак", "проте", "крім того"],
  pl: ["zatem", "dlatego", "w związku z tym", "jednak", "ponadto", "czyli"],
  cs: ["proto", "tudíž", "tedy", "nicméně", "navíc", "totiž"],
  hu: ["ezért", "tehát", "így", "azonban", "továbbá", "vagyis"],
  ro: ["prin urmare", "așadar", "astfel", "totuși", "în plus", "adică"],
  sv: ["därför", "således", "alltså", "dock", "dessutom"],
  no: ["derfor", "således", "altså", "imidlertid", "dessuten"],
  nb: ["derfor", "således", "altså", "imidlertid", "dessuten"],
  da: ["derfor", "således", "altså", "imidlertid", "desuden"],
  fi: ["siksi", "näin ollen", "kuitenkin", "lisäksi", "toisin sanoen"],
};

// Languages where semicolons are uncommon in native business prose;
// detector skips them to avoid false positives.
export const SEMICOLON_DETECTOR_SKIP_LANGS: ReadonlySet<string> = new Set([
  "ja", "zh", "ko", "th", "ar", "he", "fa", "ur", "hi", "bn", "ta",
  "te", "mr", "vi", "id", "ms", "fil", "tl", "sw", "am", "ka", "el",
  "tr",
]);

export interface SemicolonHit {
  position: number;
  followedBy: string;
  suggestions: readonly string[];
}

function _escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function findSemicolonWithoutConnector(
  text: string,
  lang: string
): SemicolonHit[] {
  if (!text || !text.includes(";")) return [];
  const langStr = (lang || "").trim().toLowerCase();
  const base = langStr.includes("-") ? langStr.split("-")[0] : langStr;
  if (SEMICOLON_DETECTOR_SKIP_LANGS.has(langStr) ||
      SEMICOLON_DETECTOR_SKIP_LANGS.has(base)) {
    return [];
  }

  let connectors = SEMICOLON_CONNECTORS[langStr];
  if (!connectors) connectors = SEMICOLON_CONNECTORS[base];
  if (!connectors || connectors.length === 0) return [];

  // Sort longest-first so multi-word connectors match before single-word
  const connectorsSorted = [...connectors].sort((a, b) => b.length - a.length);
  const connectorRe = new RegExp(
    "^(?:" + connectorsSorted.map(_escapeRegex).join("|") + ")",
    "i"
  );

  const hits: SemicolonHit[] = [];
  // Match `;` then capture the immediately following word(s).
  // Uses /g flag for repeated matches.
  const semiRe = /;\s*([^\s;]+(?:\s+[^\s;]+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = semiRe.exec(text)) !== null) {
    // Skip if newline appears between `;` and the next word — that's a list
    // terminator or sentence break, not a clause joiner. Common in PT/ES/IT
    // bullet-list business style.
    const semiEnd = m.index + 1;
    const wordStart = m.index + m[0].length - m[1].length;
    const between = text.slice(semiEnd, wordStart);
    if (between.includes("\n")) continue;

    const following = m[1].replace(/[,.;:!?]+$/, "");
    // Check if the post-semicolon text starts with any connector
    const postSemi = text.slice(semiEnd).replace(/^\s+/, "");
    if (!connectorRe.test(postSemi)) {
      hits.push({
        position: m.index,
        followedBy: following.slice(0, 30),
        suggestions: connectors.slice(0, 5),
      });
    }
  }
  return hits;
}


export interface NonReflexiveVerbPair {
  readonly bare: string;
  readonly reflexive: string;
}

export const NON_REFLEXIVE_VERBS: Record<string, readonly NonReflexiveVerbPair[]> = {
  pt: [
    { bare: "encaixa", reflexive: "se encaixa" },
    { bare: "aplica", reflexive: "se aplica" },
    { bare: "adequa", reflexive: "se adequa" },
    { bare: "ajusta", reflexive: "se ajusta" },
    { bare: "alinha", reflexive: "se alinha" },
    { bare: "integra", reflexive: "se integra" },
    { bare: "adapta", reflexive: "se adapta" },
    { bare: "aplicam", reflexive: "se aplicam" },
    { bare: "encaixam", reflexive: "se encaixam" },
    { bare: "ajustam", reflexive: "se ajustam" },
  ],
  "pt-BR": [
    { bare: "encaixa", reflexive: "se encaixa" },
    { bare: "aplica", reflexive: "se aplica" },
    { bare: "adequa", reflexive: "se adequa" },
    { bare: "ajusta", reflexive: "se ajusta" },
    { bare: "alinha", reflexive: "se alinha" },
    { bare: "integra", reflexive: "se integra" },
    { bare: "adapta", reflexive: "se adapta" },
    { bare: "aplicam", reflexive: "se aplicam" },
    { bare: "encaixam", reflexive: "se encaixam" },
    { bare: "ajustam", reflexive: "se ajustam" },
  ],
  es: [
    { bare: "encaja", reflexive: "se encaja" },
    { bare: "aplica", reflexive: "se aplica" },
    { bare: "ajusta", reflexive: "se ajusta" },
    { bare: "adapta", reflexive: "se adapta" },
    { bare: "alinea", reflexive: "se alinea" },
    { bare: "integra", reflexive: "se integra" },
    { bare: "encajan", reflexive: "se encajan" },
    { bare: "aplican", reflexive: "se aplican" },
  ],
  fr: [
    { bare: "applique", reflexive: "s'applique" },
    { bare: "ajuste", reflexive: "s'ajuste" },
    { bare: "adapte", reflexive: "s'adapte" },
    { bare: "intègre", reflexive: "s'intègre" },
    { bare: "aligne", reflexive: "s'aligne" },
    { bare: "appliquent", reflexive: "s'appliquent" },
  ],
  it: [
    { bare: "applica", reflexive: "si applica" },
    { bare: "adatta", reflexive: "si adatta" },
    { bare: "integra", reflexive: "si integra" },
    { bare: "allinea", reflexive: "si allinea" },
    { bare: "inserisce", reflexive: "si inserisce" },
    { bare: "applicano", reflexive: "si applicano" },
  ],
};

const REFLEXIVE_PRONOUNS: Record<string, readonly string[]> = {
  pt: ["se", "me", "te", "nos", "vos"],
  "pt-BR": ["se", "me", "te", "nos", "vos"],
  es: ["se", "me", "te", "nos", "os"],
  fr: ["s'", "se", "me", "te", "nous", "vous", "m'", "t'"],
  it: ["si", "mi", "ti", "ci", "vi"],
};

export interface NonReflexiveHit {
  verb: string;
  expected: string;
  context: string;
}

export function findNonReflexiveRomanceVerbs(
  text: string,
  lang: string
): NonReflexiveHit[] {
  if (!text) return [];
  const langStr = (lang || "").trim().toLowerCase();
  const base = langStr.includes("-") ? langStr.split("-")[0] : langStr;

  let verbs = NON_REFLEXIVE_VERBS[langStr];
  if (!verbs) verbs = NON_REFLEXIVE_VERBS[base];
  if (!verbs || verbs.length === 0) return [];

  const pronouns = REFLEXIVE_PRONOUNS[langStr] || REFLEXIVE_PRONOUNS[base] || [];
  const pronounsSet = new Set(pronouns.map(p => p.toLowerCase()));

  const hits: NonReflexiveHit[] = [];
  for (const { bare, reflexive } of verbs) {
    // Word-boundary match, case-insensitive
    const re = new RegExp("\\b" + _escapeRegex(bare) + "\\b", "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const start = m.index;
      // Look at the 2 preceding tokens
      const prefix = text.slice(Math.max(0, start - 30), start);
      const tokenMatches = prefix.toLowerCase().match(/\b\w+'?\b|\bs'/g) || [];
      const recent = tokenMatches.slice(-2);
      // Skip if any reflexive pronoun is in the recent tokens
      if (recent.some(t => pronounsSet.has(t))) continue;
      // Skip if verb is at sentence start (after newline) or text start
      if (start === 0 || text[start - 1] === "\n") continue;
      const context = text.slice(
        Math.max(0, start - 25),
        Math.min(text.length, start + bare.length + 15)
      );
      hits.push({
        verb: bare,
        expected: reflexive,
        context: context.trim(),
      });
    }
  }
  return hits;
}


export interface NativenessV4Report extends NativenessV3Report {
  translationese: string[];
  greeting_name_adaptation: string[];
  // v4 Round-2 detector keys
  repeating_discourse_markers: RepeatingMarkerHit[];
  semicolon_no_connector: SemicolonHit[];
  non_reflexive_romance_verbs: NonReflexiveHit[];
  // v4 Round-4 detector
  verb_fronted_lead_with: string[];
}

/**
 * Run all v3 detectors + v4 additions. Filters v3's forbidden_singletons
 * against the per-language NATIVE_ENGLISH_LOANWORDS exemption set.
 */
// ============================================================================
// v4 Round-4: VERB-FRONTED LEAD-WITH DETECTOR
// ============================================================================
// Catches "X lead with A, B, C" where X is a creative/strategy noun. This is
// a verb-fronted English calque that LLMs reliably produce when translating
// business copy. Native business writers delay the lead-verb to AFTER the
// description ("Creatives like X, Y, Z would lead the strategy").
//
// Coverage: EN, PT, PT-BR, ES, FR, IT. DE/JA/ZH/KO have different word order
// so the pattern does not transfer cleanly.

export const VERB_FRONTED_LEAD_WITH_PATTERNS: Record<string, RegExp[]> = {
  en: [
    /\b(creatives?|ads?|ad\s+sets?|campaigns?|assets?|strategy|strategies|concepts?|content|messaging|creative\s+pods?)\b(?:\s+\w+){0,3}\s+(?:would\s+|will\s+|could\s+|should\s+|might\s+)?(?:lead|leads|leading|led)\s+with\b[^.\n]{0,80},[^.\n]{0,80}[,.]/gi,
  ],
  pt: [
    /\b(criativos?|an[uú]ncios?|estrat[eé]gias?|campanhas?|conceitos?|conte[uú]dos?|pe[cç]as?)\b(?:\s+\w+){0,3}\s+(?:lideraria(?:m)?|lideram?|liderar[aá](?:o|i?am)?|vai[oõ]?\s+liderar|v[ãa]o\s+liderar)\s+com\b[^.\n]{0,80},[^.\n]{0,80}/gi,
  ],
  es: [
    /\b(creativos?|anuncios?|estrategias?|campa[ñn]as?|conceptos?|contenidos?|piezas?)\b(?:\s+\w+){0,3}\s+(?:liderar[ií]a(?:n)?|lidera(?:n|r[aá]n)?|liderar[aá](?:n)?)\s+con\b[^.\n]{0,80},[^.\n]{0,80}/gi,
  ],
  fr: [
    /\b(cr[eé]atifs?|annonces?|strat[eé]gies?|campagnes?|concepts?|contenus?)\b(?:\s+\w+){0,3}\s+(?:m[eè]ner(?:ait|aient|ont|a)?|m[eè]nent|conduisent|dirigent)\s+avec\b[^.\n]{0,80},[^.\n]{0,80}/gi,
  ],
  it: [
    /\b(creativi|annunci|strategie|campagne|concetti|contenuti)\b(?:\s+\w+){0,3}\s+(?:guidereb(?:be|bero)|guidano|guideranno|conducono)\s+con\b[^.\n]{0,80},[^.\n]{0,80}/gi,
  ],
};
// pt-BR shares pt patterns
VERB_FRONTED_LEAD_WITH_PATTERNS["pt-BR"] = VERB_FRONTED_LEAD_WITH_PATTERNS["pt"];


export function findVerbFrontedLeadWith(text: string, lang: string): string[] {
  if (!text) return [];
  const langN = normalizeLanguageCode(lang);
  let patterns = VERB_FRONTED_LEAD_WITH_PATTERNS[langN];
  if (!patterns) {
    const base = langN.includes("-") ? langN.split("-")[0] : langN;
    patterns = VERB_FRONTED_LEAD_WITH_PATTERNS[base];
  }
  if (!patterns) return [];
  const seen: string[] = [];
  for (const pat of patterns) {
    pat.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pat.exec(text)) !== null) {
      let phrase = m[0].trim();
      if (phrase.length > 200) phrase = phrase.substring(0, 200) + "...";
      if (!seen.includes(phrase)) seen.push(phrase);
      // Guard against zero-length matches
      if (m.index === pat.lastIndex) pat.lastIndex++;
    }
  }
  return seen;
}


export function findAllNativenessViolationsV4(
  text: string,
  lang: string
): NativenessV4Report {
  const v3 = _findAllV3(text, lang);
  const langN = normalizeLanguageCode(lang);
  const loanwords = NATIVE_ENGLISH_LOANWORDS[langN];

  let forbidden_singletons = v3.forbidden_singletons;
  if (loanwords && forbidden_singletons.length > 0) {
    forbidden_singletons = forbidden_singletons.filter(
      (t) => !loanwords.has(t) && !loanwords.has(t.toUpperCase())
    );
  }

  return {
    forbidden_phrases: v3.forbidden_phrases,
    latin_token_runs: v3.latin_token_runs,
    forbidden_singletons,
    x_not_y: v3.x_not_y,
    untransliterated_greeting_name: v3.untransliterated_greeting_name,
    translationese: findTranslationese(text, lang),
    greeting_name_adaptation: findGreetingNameAdaptationIssues(text, lang),
    // v4 Round-2 detectors
    repeating_discourse_markers: findRepeatingDiscourseMarkers(text, lang),
    semicolon_no_connector: findSemicolonWithoutConnector(text, lang),
    non_reflexive_romance_verbs: findNonReflexiveRomanceVerbs(text, lang),
    // v4 Round-4 detector
    verb_fronted_lead_with: findVerbFrontedLeadWith(text, lang),
  };
}

export function hasAnyViolationV4(report: NativenessV4Report): boolean {
  // Reconstruct a v3-shaped report from the v4 fields so v3's truth table applies
  if (_hasAnyV3({
    forbidden_phrases: report.forbidden_phrases,
    latin_token_runs: report.latin_token_runs,
    forbidden_singletons: report.forbidden_singletons,
    x_not_y: report.x_not_y,
    untransliterated_greeting_name: report.untransliterated_greeting_name,
  })) {
    return true;
  }
  if (report.translationese.length > 0) return true;
  if (report.greeting_name_adaptation.length > 0) return true;
  // v4 Round-2 detectors
  if (report.repeating_discourse_markers.length > 0) return true;
  if (report.semicolon_no_connector.length > 0) return true;
  if (report.non_reflexive_romance_verbs.length > 0) return true;
  // v4 Round-4
  if (report.verb_fronted_lead_with.length > 0) return true;
  return false;
}

// ============================================================================
// 5. PROMPT BLOCK BUILDERS
// ============================================================================

function buildNativeStyleBlock(languageTag: string): string {
  const lang = normalizeLanguageCode(languageTag);
  if (!lang || lang === "en") return "";
  const guide = NATIVE_STYLE_GUIDES[lang];
  if (!guide) return "";

  const parts: string[] = [
    "\n",
    `- NATIVE STYLE GUIDE for ${languageTag} (v4 native-structure scaffold):\n`,
    `  Regional variant: ${guide.regional_variant}\n`,
    "  \n",
    `  SOCIAL OPENER (required): ${guide.social_opener}\n`,
    "  \n",
    "  CONNECTOR PHRASES (use 2-4 across the email body to weave claims into\n",
    "  a narrative — do NOT stack declarative facts in 4-fact sentences):\n",
  ];
  for (const cp of guide.connector_phrases) parts.push(`    - ${cp}\n`);
  parts.push("  \n");
  parts.push("  SOFTENER PHRASES (use 1-2, especially for differentiator\n");
  parts.push("  claims and CTA — native B2B avoids unhedged declarative tone):\n");
  for (const sp of guide.softener_phrases) parts.push(`    - ${sp}\n`);

  if (guide.constructive_parallel_pattern) {
    parts.push("  \n");
    parts.push(`  CONSTRUCTIVE PARALLEL PATTERN: ${guide.constructive_parallel_pattern}\n`);
  }

  parts.push("  \n");
  parts.push(`  COLLABORATIVE CLOSE (required): ${guide.collaborative_close}\n`);

  if (guide.bullet_list_pattern) {
    parts.push("  \n");
    parts.push(`  BULLET LIST PATTERN: ${guide.bullet_list_pattern}\n`);
  }

  parts.push("  \n");
  parts.push(`  REGISTER NOTES: ${guide.register_notes}\n`);
  return parts.join("");
}

function buildTranslationeseBanBlock(languageTag: string): string {
  const lang = normalizeLanguageCode(languageTag);
  if (!lang || lang === "en") return "";
  const patterns = TRANSLATIONESE_PATTERNS[lang];
  if (!patterns) return "";

  const samples = patterns.slice(0, 14).map((p) => p.source);
  const parts: string[] = [
    "\n",
    `- TRANSLATIONESE BAN for ${languageTag} (v4 literal-translation patterns):\n`,
    "  Native speakers in this language do NOT use these constructions. Each\n",
    "  pattern below is an individual local-language phrase whose individual\n",
    "  words are correct, but whose combination reads as translated-from-\n",
    "  English. Never emit any of these patterns; rephrase using native\n",
    "  alternatives from the NATIVE STYLE GUIDE above.\n",
    "  Banned patterns (regex form, not exhaustive):\n",
  ];
  for (const s of samples) parts.push(`    - ${s}\n`);
  if (patterns.length > 14) parts.push(`    - ...and ${patterns.length - 14} more.\n`);
  return parts.join("");
}

function buildUniversalNameAdaptationBlock(languageTag: string): string {
  const lang = normalizeLanguageCode(languageTag);
  if (!lang) return "";

  if (NON_LATIN_SCRIPT_LANGS.has(lang)) {
    return (
      "\n" +
      `- UNIVERSAL NAME ADAPTATION for ${languageTag} (v4 non-Latin script target):\n` +
      "  The prospect's first name in the greeting MUST be transliterated\n" +
      "  into the target script. Examples:\n" +
      "    Thai     'เรียน Songsitt'   WRONG  →  'เรียน ทรงสิทธิ์'   RIGHT\n" +
      "    Hindi    'नमस्ते Manish'      WRONG  →  'नमस्ते मनीश'        RIGHT\n" +
      "    Russian  'Здравствуйте, John' WRONG →  'Здравствуйте, Джон'  RIGHT\n" +
      "    Chinese  '您好 Vinicius'      WRONG  →  '您好 维尼修斯'       RIGHT\n" +
      "    Japanese 'NAME様'             WRONG  →  'カタカナ表記の名前様'  RIGHT\n" +
      "    Korean   'NAME 님'            WRONG  →  '한글 표기 이름 님'    RIGHT\n" +
      "    Hebrew   'שלום John'          WRONG  →  'שלום ג'ון'           RIGHT\n" +
      "    Arabic   'مرحبًا John'        WRONG  →  'مرحبًا جون'          RIGHT\n" +
      "  Pick a reasonable phonetic transliteration if no canonical form\n" +
      "  is known, and use it consistently. The sender's signature at the\n" +
      "  bottom stays in Latin; ONLY the recipient's greeting name is\n" +
      "  transliterated.\n"
    );
  }

  if (LATIN_DIACRITIC_LANGS.has(lang)) {
    return (
      "\n" +
      `- UNIVERSAL NAME ADAPTATION for ${languageTag} (v4 Latin-script-with-diacritic target):\n` +
      "  Apply the language's native orthography to the prospect's first\n" +
      "  name in the greeting if a canonical native form exists. Examples:\n" +
      "    Portuguese (pt-BR)  'Vinicius'  →  'Vinícius'\n" +
      "    Spanish    (es)     'Jose'      →  'José'  ;  'Maria' → 'María'\n" +
      "    Vietnamese (vi)     'Tuan'      →  'Tuấn'  ;  'Huong' → 'Hương'\n" +
      "    Czech      (cs)     'Tomas'     →  'Tomáš'\n" +
      "    Polish     (pl)     'Lukasz'    →  'Łukasz'\n" +
      "    Hungarian  (hu)     'Andras'    →  'András'\n" +
      "    French     (fr)     'Helene'    →  'Hélène' ; 'Francois' → 'François'\n" +
      "    German     (de)     'Jurgen'    →  'Jürgen'\n" +
      "  If unsure about the diacritic form, KEEP the ASCII spelling rather\n" +
      "  than guess incorrectly. This rule does NOT translate the semantic\n" +
      "  name; only orthography adapts.\n"
    );
  }

  return "";
}

/**
 * v4 top-level writer prompt block builder. Returns the full v3 block
 * verbatim plus three v4 sections: NATIVE STYLE GUIDE, TRANSLATIONESE BAN,
 * UNIVERSAL NAME ADAPTATION.
 */
export function buildNativenessBlockV4(languageTag: string | null | undefined): string {
  const v3 = buildNativenessBlockV3(languageTag);
  const tag = languageTag ?? "";
  const style = buildNativeStyleBlock(tag);
  const trans = buildTranslationeseBanBlock(tag);
  const name = buildUniversalNameAdaptationBlock(tag);
  return v3 + style + trans + name;
}

/**
 * Concise critic-facing block listing v4 violations to check for in the
 * target language. Used as the v4 augmentation to the critic prompt.
 */
export function buildCriticNativeStyleBlockV4(
  languageTag: string | null | undefined
): string {
  const lang = normalizeLanguageCode(languageTag ?? "");
  if (!lang || lang === "en") {
    return (
      "v4 NATIVE STYLE / TRANSLATIONESE / NAME ADAPTATION — universal style\n" +
      "rules apply even to English: flag the X-NOT-Y comma-negation pattern\n" +
      "(', not raw installs' etc.) and rewrite as 'rather than' / 'instead\n" +
      "of' or rephrase.\n"
    );
  }

  const guide = NATIVE_STYLE_GUIDES[lang];
  const patterns = TRANSLATIONESE_PATTERNS[lang] || [];

  const parts: string[] = [
    `v4 NATIVE STYLE / TRANSLATIONESE / NAME ADAPTATION checks for ${languageTag}:\n`,
    "\n",
  ];

  if (guide) {
    parts.push(`REGIONAL VARIANT TARGET: ${guide.regional_variant}\n`);
    parts.push("\n");
    parts.push("REQUIRED STRUCTURE — flag if absent:\n");
    parts.push(`- Social opener: ${guide.social_opener.split(".")[0]}.\n`);
    parts.push(
      `- At least 1-2 native connector phrases from the language's\n`
    );
    parts.push(
      `  cohesion repertoire (e.g. ${guide.connector_phrases.slice(0, 3).join(", ")}).\n`
    );
    parts.push(
      `- At least 1 softener phrase for the CTA or differentiator\n`
    );
    parts.push(
      `  (e.g. ${guide.softener_phrases.slice(0, 2).join(", ")}).\n`
    );
    parts.push(
      `- Collaborative-close pattern: ${guide.collaborative_close.split(".")[0]}.\n`
    );
    parts.push("\n");
  }

  if (patterns.length > 0) {
    const samples = patterns.slice(0, 12).map((p) => p.source);
    parts.push("TRANSLATIONESE PATTERNS — flag every match:\n");
    for (const s of samples) parts.push(`- ${s}\n`);
    if (patterns.length > 12)
      parts.push(`- ...and ${patterns.length - 12} more in the v4 module.\n`);
    parts.push("\n");
  }

  if (NON_LATIN_SCRIPT_LANGS.has(lang)) {
    parts.push("NAME ADAPTATION — flag if the prospect's first name in the\n");
    parts.push("greeting line is in Latin script while the rest of the\n");
    parts.push("greeting is in the target script. The name must be transliterated.\n");
  } else if (LATIN_DIACRITIC_LANGS.has(lang)) {
    parts.push("NAME ADAPTATION — if the prospect's name has a known native\n");
    parts.push("form with diacritics (Vinicius→Vinícius, Jose→José, Tuan→Tuấn,\n");
    parts.push("Lukasz→Łukasz, Jurgen→Jürgen, Helene→Hélène, etc.), the\n");
    parts.push("greeting should use that form. If unsure, keep ASCII.\n");
  }

  return parts.join("");
}
