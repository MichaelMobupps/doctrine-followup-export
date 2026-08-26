/**
 * greetingName.ts — recover the recipient's first name from the original
 * outreach when the prospect row does not carry one.
 *
 * Why (2026-08-26, Robotic.jpeg): the HALA thread opened
 * "Hi Ibrahim, Sunil from MobUpps here." and then all three follow-ups
 * addressed the same person as "Hi there,". The name was sitting in the
 * original email the whole time; the prospects row simply had an empty
 * prospect_name, and the writer prompt correctly refuses to invent one.
 * Being addressed generically by someone who used your name a week
 * earlier reads as a machine, and it is the cheapest humanness win
 * available — the data is already in hand.
 *
 * The extraction is deliberately narrow. It returns a name only when the
 * original email opens with a recognised greeting followed by one or two
 * name-shaped tokens. Anything else returns null and the existing
 * neutral-greeting behaviour stands, because a wrong name is far worse
 * than a neutral one.
 *
 * NOT used for shared company drafts: there the greeting in the original
 * belongs to exactly one of several recipients, and writing it would
 * misaddress everybody else. The caller enforces that.
 */
import { splitGreetingLine } from "./layoutShaper";

/**
 * Words that follow a greeting but are not names. A generic opener in the
 * original ("Hi there," / "Hello team,") carries no name to recover.
 */
const NON_NAMES = new Set([
  "there", "team", "all", "everyone", "folks", "sir", "madam", "sirs",
  "friend", "friends", "guys", "hello", "hi", "colleague", "colleagues",
  "equipo", "todos", "time", "pessoal", "tous", "alle", "team,", "everybody",
  "concerned", "whom", "buddy", "mate",
]);

/** Tokens that are part of the greeting phrase, never part of the name. */
const OPENER_TOKENS = new Set([
  "hi", "hello", "hey", "dear", "good", "morning", "afternoon", "evening",
  "hola", "estimado", "estimada", "buenos", "buenas", "dias", "días", "tardes",
  "ola", "olá", "oi", "bom", "boa", "dia", "tarde", "prezado", "prezada", "caro", "cara",
  "bonjour", "bonsoir", "salut", "cher", "chere", "chère",
  "hallo", "guten", "tag", "abend", "sehr", "geehrte", "geehrter", "lieber", "liebe",
  "ciao", "buongiorno", "buonasera", "gentile", "egregio",
  "hoi", "beste", "geachte", "hej", "hejsan", "hei", "moi", "kjære", "kære",
  "cześć", "czesc", "dzień", "dzien", "dobry", "szanowny", "szanowna", "witam",
  "ahoj", "den", "vážený", "vazeny", "szia", "kedves", "tisztelt",
  "bună", "buna", "stimate", "stimata", "merhaba", "sayın", "sayin",
  "здравствуйте", "добрый", "доброе", "вечер", "утро", "привет", "уважаемый",
  "уважаемая", "доброго", "дня", "вітаю", "добрий", "шановний", "шановна",
  "halo", "hai", "selamat", "pagi", "siang", "yth", "kumusta", "magandang", "araw",
  "chào", "chao", "xin", "kính", "gửi",
  // he / ar / fa / hi / bn / th / zh / ko openers
  "שלום", "היי", "הי", "מרחבא",
  "مرحبا", "مرحبًا", "أهلا", "اهلا", "السلام", "عليكم", "سلام", "تحية", "طيبة",
  "नमस्ते", "नमस्कार", "प्रिय", "নমস্কার",
  "สวัสดี", "เรียน", "คุณ",
  "您好", "你好", "尊敬的", "안녕하세요", "안녕하십니까",
  "habari", "hujambo", "ሰላም",
]);

/**
 * Scripts where "starts with a capital" is not a usable name test, so the
 * shape check is relaxed to "not a known non-name".
 */
/** Honorifics that trail a name in CJK and Korean address forms. */
const TRAILING_HONORIFICS = ["様", "さん", "님", "先生", "女士"];

const CASELESS_SCRIPTS = /[֐-׿؀-ۿऀ-ॿ฀-๿一-鿿぀-ヿ가-힯]/;

/**
 * Pull the recipient's first name out of the original outreach's greeting
 * line. Returns null unless the line is unambiguously "greeting + name".
 */
export function extractGreetingName(
  originalBody: string | null | undefined,
  languageTag?: string | null,
): string | null {
  const body = (originalBody || "").replace(/\r\n/g, "\n").trim();
  if (!body) return null;

  const firstLine = body.split("\n")[0]?.trim();
  if (!firstLine) return null;

  // The greeting may run into the first sentence ("Hi Ibrahim, Sunil from
  // MobUpps here.") or occupy the whole line ("Hello Sarah Chen,"). Take
  // the split when it fires; otherwise treat a short line that ends on a
  // separator as the greeting itself.
  const split = splitGreetingLine(firstLine, languageTag);
  const greetingRaw = split
    ? split.greeting
    : /[,，、،؛፣:：]\s*$/.test(firstLine) && firstLine.length <= 60
      ? firstLine
      : null;
  if (!greetingRaw) return null;

  // Strip the trailing separator, then drop the opener tokens; what
  // survives should be the name. Punctuation is stripped per token so a
  // trailing comma cannot hide an opener from the lookup ("Здравствуйте,").
  const greeting = greetingRaw.replace(/[,，、،؛፣:：]\s*$/, "").trim();
  const tokens = greeting.split(/\s+/).filter(Boolean);
  const nameTokens = tokens
    .map((t) => t.replace(/^[,，、،؛፣:：.]+|[,，、،؛፣:：.]+$/g, ""))
    .filter((t) => t && !OPENER_TOKENS.has(t.toLowerCase()));

  if (nameTokens.length === 0 || nameTokens.length > 2) return null;

  let candidate = nameTokens.join(" ").replace(/[.,;:]+$/, "").trim();
  // "田中様" / "민수 님" carry an honorific the writer prompt regenerates
  // itself from the greeting-script rules; storing it would double it up.
  for (const h of TRAILING_HONORIFICS) {
    if (candidate.endsWith(h) && candidate.length > h.length) {
      candidate = candidate.slice(0, -h.length).trim();
      break;
    }
  }
  if (!candidate || candidate.length < 2 || candidate.length > 40) return null;
  if (candidate.includes("@")) return null;
  if (NON_NAMES.has(candidate.toLowerCase())) return null;
  // A name is letters, and optionally an internal hyphen or apostrophe.
  if (!/^[\p{L}][\p{L}’'-]*(?:\s[\p{L}][\p{L}’'-]*)?$/u.test(candidate)) return null;

  // For cased scripts, insist the name is capitalised — that rules out a
  // lowercase sentence fragment that survived the token filter.
  if (!CASELESS_SCRIPTS.test(candidate) && !/^\p{Lu}/u.test(candidate)) return null;

  return candidate;
}

/** True when a stored prospect name is usable as a greeting name. */
export function hasUsableProspectName(name: string | null | undefined): boolean {
  return !!(name && name.trim() && !name.includes("@"));
}
