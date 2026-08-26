/**
 * layoutShaper.ts — visual layout of the follow-up body.
 *
 * Problem this solves (2026-08-26, Sunil feedback + Robotic.jpeg):
 * every follow-up this system shipped looked like the same object — a
 * greeting glued to a single 4-6 sentence wall of text, identical in
 * shape at stage 1, 2 and 3 of the same thread. A human writing three
 * follow-ups by hand never produces three identically-shaped blocks;
 * they break lines, leave the closing question alone on its own line,
 * open with a one-liner, and the shape drifts from message to message.
 * The block is one of the strongest "written by a machine" signals a
 * recipient gets, and it lands before a single word of content is read.
 *
 * Root causes found:
 *   1. No prompt rule anywhere asked for paragraph structure. The only
 *      shape rule was "Maximum 4-6 sentences", which pushes toward one
 *      dense block.
 *   2. The gold exemplar library teaches the block: of 1272 exemplars,
 *      1209 are "greeting + one blob" (a single \n), 54 have no line
 *      break at all, and only 9 contain a blank line.
 *   3. The Gmail HTML builder mapped \n to a bare <br>, so even when a
 *      break survived it rendered as a tight line break rather than a
 *      paragraph gap.
 *
 * This module owns layer 2 of the three-layer fix: the deterministic
 * normalizer. Layer 1 is the LAYOUT directive injected into the writer,
 * critic and rewriter prompts (followupPrompts.ts); layer 3 is the
 * LAYOUT-SINGLE-BLOCK structural lint rule that pushes a flat draft back
 * through the rewrite loop (structuralLint.ts). The normalizer is the
 * guarantee: whatever the model returns, the shipped body has its
 * greeting on its own line and more than one block.
 *
 * VARIATION MODEL
 * ───────────────
 * Six layout profiles. A thread gets a seeded permutation of them keyed
 * on the thread's identity, and stage N takes perm[(N-1) % 6]. Two
 * consequences that matter:
 *   - consecutive stages of one thread can never share a profile, so the
 *     "all the follow-ups look the same" complaint cannot recur;
 *   - two different prospects walk the profiles in different orders, so
 *     the shapes never become a fingerprint across a campaign.
 * Selection is deterministic (no Math.random), so a regenerated draft,
 * the dashboard preview and the sent message always agree.
 *
 * SCRIPT SAFETY
 * ─────────────
 * Redistributing sentences needs reliable sentence boundaries. For
 * scripts that lack them (Thai, Lao, Khmer, Burmese) or where our
 * splitter is unreliable (Chinese, Japanese, Korean), the shaper does the
 * greeting split and blank-line normalization only and leaves the model's
 * own blocks untouched. It never invents a boundary it cannot see. This
 * mirrors the carve-out structuralLint.ts already makes for its
 * sentence-count rule.
 *
 * Disable with FOLLOWUP_LAYOUT_SHAPER=0.
 */

export interface LayoutProfile {
  id: string;
  /** Sentences per body block, greeting excluded. Sums to 4-6. */
  pattern: number[];
  /** Final block is the closing question alone on its own line. */
  ctaStandalone: boolean;
  /** Index of the block joined with a single \n instead of a space. */
  softBreakAt: number | null;
  /** Plain-language description handed to the writer, critic and rewriter. */
  directive: string;
}

/**
 * The six shapes. Each stays inside the existing 4-6 sentence doctrine
 * cap, so this layer never fights the CONCISENESS criterion. The
 * directives are written as instructions to the model, not as
 * descriptions of this module.
 */
export const LAYOUT_PROFILES: LayoutProfile[] = [
  {
    id: "open-lead",
    pattern: [1, 3, 1],
    ctaStandalone: true,
    softBreakAt: null,
    directive:
      "Greeting alone on the first line. Blank line. One short opening sentence alone on its own line. Blank line. Three sentences together. Blank line. The closing question alone on the last line.",
  },
  {
    id: "two-block",
    pattern: [2, 3],
    ctaStandalone: false,
    softBreakAt: null,
    directive:
      "Greeting alone on the first line. Blank line. Two sentences. Blank line. Three sentences, the last of which is the closing question.",
  },
  {
    id: "stacked",
    pattern: [1, 1, 2, 1],
    ctaStandalone: true,
    softBreakAt: null,
    directive:
      "Greeting alone on the first line. Blank line. Then four blocks separated by blank lines: one sentence, one sentence, two sentences, then the closing question alone on the last line. Keep the sentences short so the email reads airy rather than dense.",
  },
  {
    id: "body-cta",
    pattern: [4, 1],
    ctaStandalone: true,
    softBreakAt: null,
    directive:
      "Greeting alone on the first line. Blank line. One block of four sentences. Blank line. The closing question alone on the last line.",
  },
  {
    id: "balanced",
    pattern: [2, 2, 1],
    ctaStandalone: true,
    softBreakAt: null,
    directive:
      "Greeting alone on the first line. Blank line. Two sentences. Blank line. Two sentences. Blank line. The closing question alone on the last line.",
  },
  {
    id: "tight-soft",
    pattern: [1, 3],
    ctaStandalone: false,
    softBreakAt: 1,
    directive:
      "Greeting alone on the first line. Blank line. One short opening sentence. Blank line. Then three sentences where the first sits on its own line and the remaining two follow on the next line with no blank line between them, the way someone types when they hit Enter once mid-thought. The last sentence is the closing question.",
  },
];

// ---------------------------------------------------------------------------
// env
// ---------------------------------------------------------------------------
export function layoutShaperEnabled(): boolean {
  const v = process.env.FOLLOWUP_LAYOUT_SHAPER;
  if (v == null || v === "") return true;
  const low = v.toLowerCase();
  return !(low === "0" || low === "false" || low === "no" || low === "off");
}

// ---------------------------------------------------------------------------
// seeded selection
// ---------------------------------------------------------------------------

/** FNV-1a. Small, stable across processes, no dependency. */
function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32 — deterministic PRNG seeded from the thread hash. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededShuffle<T>(items: T[], seed: number): T[] {
  const out = items.slice();
  const rng = makeRng(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export interface LayoutSeedContext {
  /** Thread identity. Anything stable per prospect-thread works. */
  original_subject?: string | null;
  company?: string | null;
  prospect_name?: string | null;
  stage?: number | null;
}

/** Stable per-thread seed string. Deliberately excludes the stage. */
function threadSeed(ctx: LayoutSeedContext): string {
  return [ctx.company || "", ctx.prospect_name || "", ctx.original_subject || ""]
    .join("|")
    .trim()
    .toLowerCase();
}

/**
 * The profile for this thread at this stage.
 *
 * A seeded permutation of the six profiles is derived from the thread
 * identity alone, then indexed by stage. Consecutive stages therefore
 * always land on different profiles, and different threads walk the
 * profiles in different orders.
 */
export function selectLayoutProfile(ctx: LayoutSeedContext): LayoutProfile {
  const perm = seededShuffle(LAYOUT_PROFILES, hashString(threadSeed(ctx)));
  const stage = Math.max(1, Math.floor(ctx.stage || 1));
  return perm[(stage - 1) % perm.length];
}

// ---------------------------------------------------------------------------
// greeting detection
// ---------------------------------------------------------------------------

/**
 * Greeting openers across the supported languages. Matched
 * case-insensitively at the START of the first line only. Kept as an
 * explicit lexicon rather than a "short prefix before a comma" heuristic
 * so a real sentence that happens to carry an early comma ("Following up
 * on my note, we saw a lift.") is never split.
 */
const GREETING_PREFIXES: string[] = [
  // en
  "hi", "hello", "hey", "dear", "good morning", "good afternoon", "good evening",
  // es
  "hola", "buenos dias", "buenos días", "buenas tardes", "estimado", "estimada",
  // pt
  "ola", "olá", "oi", "bom dia", "boa tarde", "prezado", "prezada", "caro", "cara",
  // fr
  "bonjour", "bonsoir", "salut", "cher", "chere", "chère",
  // de
  "hallo", "guten tag", "guten morgen", "guten abend", "sehr geehrte", "sehr geehrter",
  "lieber", "liebe",
  // it
  "ciao", "buongiorno", "buonasera", "gentile", "egregio",
  // nl
  "hoi", "beste", "geachte", "goedemorgen", "goedendag",
  // nordics / fi
  "hej", "hejsan", "hei", "moi", "kjaere", "kjære", "kaere", "kære", "hyva", "hyvä",
  // pl / cs / sk
  "czesc", "cześć", "dzien dobry", "dzień dobry", "szanowny", "szanowna", "witam",
  "ahoj", "dobry den", "dobrý den", "vazeny", "vážený",
  // hu / ro
  "szia", "kedves", "tisztelt", "buna", "bună", "stimate", "stimata", "stimată",
  // tr
  "merhaba", "sayin", "sayın", "iyi gunler", "iyi günler",
  // ru / uk
  "здравствуйте", "добрый день", "доброе утро", "добрый вечер", "привет",
  "уважаемый", "уважаемая", "доброго дня", "вітаю", "добрий день", "шановний", "шановна",
  // el
  "γεια σας", "γεια σου", "αγαπητε", "αγαπητέ", "αξιοτιμε", "αξιότιμε",
  // he
  "שלום", "היי", "הי",
  // ar / fa / ur
  "مرحبا", "مرحبًا", "السلام عليكم", "أهلا", "اهلا", "تحية طيبة", "سلام", "السلام علیکم",
  // hi / bn / mr
  "नमस्ते", "नमस्कार", "प्रिय", "নমস্কার",
  // th
  "สวัสดี", "เรียน",
  // vi
  "chao", "chào", "xin chao", "xin chào", "kinh gui", "kính gửi",
  // id / ms / tl
  "halo", "hai", "selamat pagi", "selamat siang", "selamat sore", "yth",
  "kumusta", "magandang araw",
  // zh / ko
  "您好", "你好", "尊敬的", "안녕하세요", "안녕하십니까",
  // sw / am
  "habari", "hujambo", "ሰላም",
];

/**
 * Name-suffix greetings: languages where the greeting is "NAME +
 * honorific" rather than "opener + NAME". Matched inside the opening
 * characters of the first line.
 */
const GREETING_SUFFIXES: string[] = ["様", "さん", "님", "您好", "你好", "先生", "女士"];

/** Comma-class separators that close a greeting across scripts. */
const GREETING_SEPARATORS = [",", "，", "、", "،", "؛", "፣", ":", "："];

/**
 * Languages whose convention after the greeting comma is a lowercase
 * letter. German "Sehr geehrter Herr Müller,\n\nich komme zurück auf..."
 * keeps the lowercase "ich"; capitalising it would be a nativeness error
 * of exactly the kind the v4 checks exist to catch. Dutch, Polish, Czech,
 * Slovak and Hungarian share the convention. Every other cased language
 * (English, the Romance languages, Russian, Greek, the Nordics)
 * capitalises.
 */
const LOWERCASE_AFTER_GREETING = new Set(["de", "nl", "pl", "cs", "sk", "hu"]);

const NON_DELIMITED_SENTENCE_LANGS = new Set(["th", "lo", "km", "my"]);
/** Scripts our sentence splitter cannot segment reliably. */
const UNSPLITTABLE_LANGS = new Set(["th", "lo", "km", "my", "zh", "ja", "ko"]);

function langBase(tag: string | undefined | null): string {
  if (!tag) return "en";
  return tag.split(/[-_]/)[0].toLowerCase();
}

/**
 * Split "Hi there, following up on ..." into ["Hi there,", "Following up on ..."].
 * Returns null when the line does not open with a recognised greeting or
 * carries no trailing content, in which case the caller leaves it alone.
 */
export function splitGreetingLine(
  line: string,
  languageTag?: string | null,
): { greeting: string; rest: string } | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const lower = trimmed.toLowerCase();
  const hasPrefix = GREETING_PREFIXES.some((g) => {
    if (!lower.startsWith(g)) return false;
    // The next character must be a boundary, so "hiring" never matches
    // "hi" and "heyday" never matches "hey".
    const next = trimmed.charAt(g.length);
    return next === "" || !/[\p{L}\p{N}]/u.test(next);
  });
  const head = trimmed.slice(0, 24);
  const hasSuffix = GREETING_SUFFIXES.some((s) => head.includes(s));
  if (!hasPrefix && !hasSuffix) return null;

  // Find the first separator inside the greeting window.
  let cut = -1;
  for (let i = 0; i < Math.min(trimmed.length, 60); i++) {
    if (GREETING_SEPARATORS.includes(trimmed[i])) {
      cut = i;
      break;
    }
  }
  if (cut < 0) return null;

  // Languages that put the name AFTER the opener take a second separator:
  // Russian "Здравствуйте, Иван, ...", Arabic "مرحبًا John، ..." and the
  // English "Hi, Sarah, ..." variant all close the greeting at the comma
  // after the NAME, not the one after the opener. Advance the cut when the
  // text following it is one or two capitalised words plus another
  // separator. A lowercase continuation ("Hey, that benchmark ...") or a
  // running sentence ("Hi Sarah, Following up on X, we ...") does not
  // match, so the first cut stands.
  const tail = trimmed.slice(cut + 1, 60);
  const nameThenSep = tail.match(
    /^\s*\p{Lu}[\p{L}'\u2019.-]*(?:\s+\p{Lu}[\p{L}'\u2019.-]*)?\s*([,\uFF0C\u060C:\uFF1A])/u,
  );
  if (nameThenSep) {
    cut = cut + 1 + tail.indexOf(nameThenSep[0]) + nameThenSep[0].length - 1;
  }

  const greeting = trimmed.slice(0, cut + 1).trim();
  const rest = trimmed.slice(cut + 1).trim();
  if (!rest) return null;

  // A greeting is a handful of words. Anything longer is a sentence that
  // merely starts with a greeting-shaped token.
  const wordCount = greeting.split(/\s+/).filter(Boolean).length;
  if (wordCount > 6) return null;

  return { greeting, rest: capitalizeFirst(rest, languageTag) };
}

/**
 * Uppercase the first cased letter of a sentence lifted out of a run-on
 * greeting line. Scripts without case (Hebrew, Arabic, CJK, Thai,
 * Devanagari) fall through untouched because toUpperCase is a no-op there.
 */
function capitalizeFirst(s: string, languageTag?: string | null): string {
  if (!s) return s;
  if (LOWERCASE_AFTER_GREETING.has(langBase(languageTag))) return s;
  const first = s[0];
  const upper = first.toUpperCase();
  if (upper === first) return s;
  return upper + s.slice(1);
}

/**
 * True when the line is a bare greeting with nothing after it — the
 * "greeting + single newline + wall" shape 95% of the exemplar library
 * teaches. Such a line needs a blank line inserted after it, not a split.
 */
function isGreetingOnlyLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > 60) return false;
  const lower = trimmed.toLowerCase();
  const prefixHit = GREETING_PREFIXES.some((g) => {
    if (!lower.startsWith(g)) return false;
    const next = trimmed.charAt(g.length);
    return next === "" || !/[\p{L}\p{N}]/u.test(next);
  });
  const suffixHit = GREETING_SUFFIXES.some((s) => trimmed.includes(s));
  if (!prefixHit && !suffixHit) return false;
  // A greeting line ends on a separator or nothing, never on a full stop.
  return !/[.!?]$/.test(trimmed) && trimmed.split(/\s+/).filter(Boolean).length <= 6;
}

// ---------------------------------------------------------------------------
// sentence segmentation
// ---------------------------------------------------------------------------

/** Tokens that end in a period without ending a sentence. */
const ABBREVIATIONS = new Set([
  "mr", "mrs", "ms", "dr", "prof", "inc", "ltd", "llc", "co", "corp", "vs",
  "etc", "e.g", "i.e", "no", "vol", "est", "approx", "dept", "jr", "sr", "st",
]);

/**
 * Terminal punctuation, beyond ASCII ".!?": the Arabic question mark and
 * Urdu full stop, the Devanagari danda and double danda, the Armenian and
 * Ethiopic full stops. Without these, an Arabic or Hindi body has no
 * recognisable boundaries and ships as a single block — the exact defect
 * this module exists to remove.
 */
const SENTENCE_TERMINALS = ".!?\u061F\u06D4\u0964\u0965\u0589\u1362";

/**
 * Segment prose into sentences. Conservative by construction: a boundary
 * needs terminal punctuation, following whitespace, and a following
 * character that can open a sentence. Single-token runts fold back into
 * the previous sentence, which absorbs abbreviation false positives that
 * survive the abbreviation table without eating legitimate short
 * sentences ("We hit 250.").
 */
export function splitSentences(text: string): string[] {
  const src = text.trim();
  if (!src) return [];

  const out: string[] = [];
  let start = 0;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (!SENTENCE_TERMINALS.includes(ch)) continue;

    // Consume a run of terminal punctuation ("...", "?!").
    let j = i;
    while (j + 1 < src.length && SENTENCE_TERMINALS.includes(src[j + 1])) j++;

    const after = src.slice(j + 1);
    const spaceMatch = after.match(/^\s+/);
    if (!spaceMatch) continue;

    const nextChar = after.slice(spaceMatch[0].length, spaceMatch[0].length + 1);
    if (!nextChar) continue;
    // A new sentence opens with an uppercase letter, a digit, a quote —
    // or, in a script without case (Hebrew, Arabic, Devanagari, ...), any
    // letter at all. The caseless test keeps the lowercase-continuation
    // guard meaningful for cased scripts while not demanding an uppercase
    // letter from scripts that have none.
    const caselessLetter =
      /\p{L}/u.test(nextChar) && nextChar.toUpperCase() === nextChar.toLowerCase();
    if (!caselessLetter && !/[\p{Lu}\p{N}"'(«“]/u.test(nextChar)) continue;

    // Abbreviation guard: inspect the word immediately before the period.
    const before = src.slice(start, j + 1);
    const lastWord = (before.match(/([\p{L}.]+)[.!?]+$/u)?.[1] || "")
      .toLowerCase()
      .replace(/\.$/, "");
    // The initial guard targets "J. Smith" — a SINGLE capital letter as its
    // own word. It must not fire on the last letter of an acronym: in this
    // domain sentences end with "MMP." / "LTV." / "ROAS." constantly, and
    // suppressing those boundaries glues sentence pairs back together.
    const isInitial = /(?:^|\s)\p{Lu}\.$/u.test(before);
    if (ch === "." && (ABBREVIATIONS.has(lastWord) || isInitial)) {
      continue;
    }

    out.push(src.slice(start, j + 1).trim());
    start = j + 1 + spaceMatch[0].length;
    i = j;
  }

  const tail = src.slice(start).trim();
  if (tail) out.push(tail);

  // Fold single-token runts back into their predecessor. The space test is
  // what keeps this from eating legitimate short sentences: "We hit 250."
  // survives, a stranded "Ltd." or "2026." folds.
  const merged: string[] = [];
  for (const s of out) {
    if (merged.length > 0 && s.length < 12 && !s.includes(" ")) {
      merged[merged.length - 1] = `${merged[merged.length - 1]} ${s}`;
    } else {
      merged.push(s);
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// distribution
// ---------------------------------------------------------------------------

/**
 * Spread `n` sentences over a profile's block pattern.
 *
 * The pattern is a shape, not a contract — the model decides how many
 * sentences it writes. When the counts disagree the pattern's relative
 * weights are preserved by largest-remainder apportionment, every block
 * keeps at least one sentence, and a standalone closing question stays
 * exactly one sentence so it is never swallowed back into a block.
 */
export function distributeSentences(
  n: number,
  pattern: number[],
  ctaStandalone: boolean,
): number[] {
  if (n <= 1) return [n];

  // Drop middle blocks when there are fewer sentences than blocks, always
  // keeping the leading blocks and the final one (the closing question).
  let shape = pattern;
  if (pattern.length > n) {
    shape = pattern.slice(0, n - 1).concat([pattern[pattern.length - 1]]);
  }
  const k = shape.length;
  if (k <= 1) return [n];

  const reserved = ctaStandalone ? 1 : 0;
  const budget = n - reserved;
  const weightBlocks = ctaStandalone ? shape.slice(0, k - 1) : shape;
  const weightTotal = weightBlocks.reduce((a, b) => a + b, 0) || 1;

  const exact = weightBlocks.map((w) => (w / weightTotal) * budget);
  const counts = exact.map((e) => Math.max(1, Math.floor(e)));

  // Largest-remainder pass to reconcile the rounding.
  let diff = budget - counts.reduce((a, b) => a + b, 0);
  const order = exact
    .map((e, i) => ({ i, rem: e - Math.floor(e) }))
    .sort((a, b) => b.rem - a.rem || a.i - b.i);
  let cursor = 0;
  while (diff > 0) {
    counts[order[cursor % order.length].i]++;
    diff--;
    cursor++;
  }
  cursor = 0;
  while (diff < 0) {
    const idx = order[order.length - 1 - (cursor % order.length)].i;
    if (counts[idx] > 1) {
      counts[idx]--;
      diff++;
    } else if (counts.every((c) => c <= 1)) {
      break;
    }
    cursor++;
  }

  return ctaStandalone ? counts.concat([1]) : counts;
}

// ---------------------------------------------------------------------------
// the shaper
// ---------------------------------------------------------------------------

export interface ShapeOptions {
  profile: LayoutProfile;
  languageTag?: string | null;
}

/**
 * Give the body its visual shape.
 *
 * Guarantees on every return path, in every language:
 *   - the greeting sits alone on line one, followed by a blank line;
 *   - runs of three or more newlines collapse to a single blank line;
 *   - no leading or trailing blank lines.
 *
 * Additionally, for languages our splitter can segment, a body that
 * arrived as one block is redistributed into the profile's blocks. A body
 * that already carries the model's own paragraph breaks keeps them: the
 * model following the LAYOUT directive is the desired outcome, and
 * re-cutting its blocks would only flatten the variation back out.
 */
export function shapeFollowupBody(body: string, opts: ShapeOptions): string {
  if (!body) return body;
  if (!layoutShaperEnabled()) return body;

  const lang = langBase(opts.languageTag);

  // Normalise line endings and any literal backslash-n that survived JSON
  // round-tripping, then collapse blank-line runs.
  let text = body
    .replace(/\r\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!text) return text;

  // 1. Greeting onto its own line.
  let greeting = "";
  const firstBreak = text.indexOf("\n");
  const firstLine = firstBreak === -1 ? text : text.slice(0, firstBreak);
  const afterFirst = firstBreak === -1 ? "" : text.slice(firstBreak + 1).replace(/^\n+/, "");

  const split = splitGreetingLine(firstLine, opts.languageTag);
  if (split) {
    greeting = split.greeting;
    text = [split.rest, afterFirst].filter(Boolean).join("\n\n");
  } else if (firstBreak !== -1 && isGreetingOnlyLine(firstLine)) {
    greeting = firstLine.trim();
    text = afterFirst;
  }

  // 2. Block structure for the remaining prose.
  const bodyText = text.trim();
  let blocks: string[];

  if (UNSPLITTABLE_LANGS.has(lang) || NON_DELIMITED_SENTENCE_LANGS.has(lang)) {
    // No reliable boundaries: keep whatever the model produced.
    blocks = bodyText.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  } else if (/\n\s*\n/.test(bodyText)) {
    // The model already blocked it. Respect its choice.
    blocks = bodyText.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  } else {
    const sentences = splitSentences(bodyText.replace(/\n+/g, " "));
    if (sentences.length < 2) {
      blocks = bodyText ? [bodyText] : [];
    } else {
      const counts = distributeSentences(
        sentences.length,
        opts.profile.pattern,
        opts.profile.ctaStandalone,
      );
      blocks = [];
      let idx = 0;
      for (let b = 0; b < counts.length && idx < sentences.length; b++) {
        const take = sentences.slice(idx, idx + counts[b]);
        idx += counts[b];
        if (take.length === 0) continue;
        blocks.push(
          opts.profile.softBreakAt === b && take.length > 1
            ? `${take[0]}\n${take.slice(1).join(" ")}`
            : take.join(" "),
        );
      }
      // Sentences left over after the pattern is exhausted join the last
      // block rather than being dropped.
      if (idx < sentences.length && blocks.length > 0) {
        blocks[blocks.length - 1] =
          `${blocks[blocks.length - 1]} ${sentences.slice(idx).join(" ")}`;
      }
    }
  }

  const assembled = blocks.join("\n\n");
  return (greeting ? `${greeting}\n\n${assembled}` : assembled).trim();
}

/**
 * The LAYOUT block injected into the writer, critic and rewriter prompts.
 * Phrased as a hard rule because the exemplar library still shows the
 * model mostly single-block bodies; a soft suggestion loses to 1209
 * contrary examples.
 */
export function buildLayoutDirective(profile: LayoutProfile): string {
  return `LAYOUT (hard rule, severity: block — this is about the SHAPE of the text on screen, not its content):
Real people do not write a follow-up as one dense paragraph. They break it up, and the break-up looks different every time. A wall of text is the first thing a recipient sees and the fastest way to be read as machine-written, before a single word is judged.

Use EXACTLY this shape for this email:
${profile.directive}

Rules that apply to every shape:
- The greeting is ALWAYS alone on the first line, followed by a completely blank line. Never run the greeting into the first sentence. "Hi there, following up on..." is WRONG. "Hi there,\\n\\nFollowing up on..." is RIGHT.
- Separate blocks with a genuinely blank line (two newline characters), not a single line break.
- Do NOT add bullet points, numbered lines, or dash-prefixed lines. Blocks are prose, and the deliverability rules against lists apply in full.
- The sentence budget is unchanged: 4-6 sentences in total across all blocks.
- Put the newlines in the "body" value of the JSON you return, as \\n escapes.`;
}
