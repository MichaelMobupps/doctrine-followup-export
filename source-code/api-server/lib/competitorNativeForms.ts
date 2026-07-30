/**
 * Curated native-script forms for competitor brand names, plus the language gate
 * that decides when native rendering is enforced.
 *
 * Why curated and not exhaustive: correct native-script brand forms cannot be
 * machine-generated reliably across every script, and a wrong transliteration is
 * worse than leaving a name in Latin. So this map carries only high-confidence
 * forms, and the deterministic lint flags ONLY names present here. Names absent
 * from the map are never flagged, which removes false positives. The map is meant
 * to grow over time as more forms are verified.
 *
 * Scope of enforcement (STRICT_NATIVE_LANGS): languages where rendering local
 * brands in the native script is the clear B2B norm. Indian-subcontinent
 * languages (hi, bn, ur, ne, ta, te), Thai, Hebrew, and Persian are intentionally
 * excluded, because Latin brand names are standard in B2B copy there; forcing a
 * native rendering would reduce quality.
 *
 * LATIN_KEEP_BRANDS are brands whose canonical identity is Latin even in
 * non-Latin B2B media. They stay Latin in every language and are never flagged.
 */

// Languages where competitor names should be rendered in the native script and
// where the deterministic lint enforces it. Greek and Georgian are included for
// the prompt directive; their maps are empty, so the lint stays silent until
// verified forms are added.
export const STRICT_NATIVE_LANGS = new Set<string>(["ru", "uk", "ar", "zh", "ja", "ko", "el", "ka"]);

// Brands that remain Latin in every language. Lowercased for comparison.
export const LATIN_KEEP_BRANDS = new Set<string>([
  "wildberries",
  "aliexpress",
  "lamoda",
  "rakuten",
  "shein",
  "temu",
  "ikea",
  "glovo",
  "booking.com",
  "agoda",
  "airbnb",
  "spotify",
  "netflix",
  "line",
  "olx",
]);

// Per-language Latin -> native-script forms. Keys are lowercased Latin names.
// Only high-confidence forms are included.
export const BRAND_NATIVE_FORMS: Record<string, Record<string, string>> = {
  ru: {
    ozon: "Озон",
    rozetka: "Розетка",
    kasta: "Каста",
    allo: "Алло",
    sportmaster: "Спортмастер",
    citilink: "Ситилинк",
    dns: "ДНС",
    avito: "Авито",
    yandex: "Яндекс",
    sber: "Сбер",
    sberbank: "Сбербанк",
    tinkoff: "Тинькофф",
    vtb: "ВТБ",
    mts: "МТС",
    megafon: "МегаФон",
    beeline: "Билайн",
    mvideo: "М.Видео",
    eldorado: "Эльдорадо",
    magnit: "Магнит",
    pyaterochka: "Пятёрочка",
    perekrestok: "Перекрёсток",
    samokat: "Самокат",
    citymobil: "Ситимобил",
  },
  uk: {
    rozetka: "Розетка",
    allo: "Алло",
    privatbank: "ПриватБанк",
    monobank: "Монобанк",
  },
  ar: {
    noon: "نون",
    jumia: "جوميا",
    talabat: "طلبات",
    careem: "كريم",
    carrefour: "كارفور",
    jahez: "جاهز",
  },
  zh: {
    taobao: "淘宝",
    tmall: "天猫",
    jd: "京东",
    pinduoduo: "拼多多",
    meituan: "美团",
    didi: "滴滴",
    alipay: "支付宝",
    wechat: "微信",
  },
  ja: {
    mercari: "メルカリ",
  },
  ko: {
    coupang: "쿠팡",
    naver: "네이버",
    kakao: "카카오",
  },
  el: {},
  ka: {},
};

export function isStrictNativeLang(lang: string | null | undefined): boolean {
  return STRICT_NATIVE_LANGS.has((lang || "").toLowerCase());
}

export function isLatinKeepBrand(name: string): boolean {
  return LATIN_KEEP_BRANDS.has(name.trim().toLowerCase());
}

/**
 * Native-script form of a Latin brand name for a language, or null when there is
 * no verified form (including Latin-keep brands, which intentionally stay Latin).
 */
export function nativeFormFor(lang: string | null | undefined, name: string): string | null {
  const key = name.trim().toLowerCase();
  if (LATIN_KEEP_BRANDS.has(key)) return null;
  const map = BRAND_NATIVE_FORMS[(lang || "").toLowerCase()];
  if (!map) return null;
  return map[key] ?? null;
}
