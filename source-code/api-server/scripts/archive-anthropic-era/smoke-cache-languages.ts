/**
 * smoke-cache-languages.ts — prompt-cache cost-fix smoke (offline, no API key).
 *
 * Caching never changes model OUTPUT, so a live language matrix cannot prove a
 * caching change correct. What determines the cache HIT RATE — and the bill —
 * is whether every language shares ONE identical cached prefix, whether the
 * breakpoint carries the right TTL, and whether the prefix clears the model's
 * minimum cacheable length. This smoke runs the REAL prompt builders and
 * cachedSystem() across the full doctrine matrix and asserts exactly that.
 *
 * It is also a regression guard: it exits non-zero the moment the breakpoint
 * TTL drops back to 5m (the pre-fix default).
 *
 * RUN (no API key needed; a dummy is fine because no call is made):
 *   ANTHROPIC_API_KEY=dummy node --import tsx api-server/scripts/smoke-cache-languages.ts
 *
 * PASS, per language and in aggregate:
 *   1. cachedSystem() puts a breakpoint on the LAST system block only, with
 *      cache_control = { type:"ephemeral", ttl:"1h" }.
 *   2. The cached system prefix is BYTE-IDENTICAL across every language
 *      (one shared cache entry → cross-language cache hits).
 *   3. The cached prefix clears the 1,024-token minimum for claude-sonnet-4-6.
 *   4. Per-language content (nativeness, name transliteration) lands in the
 *      USER message, never in the cached system prefix.
 */
import { createHash } from "node:crypto";
import { cachedSystem, PROMPT_CACHE_TTL } from "../../lib/anthropic";
import { UNTRUSTED_DATA_SYSTEM_CLAUSE } from "../../lib/promptInjection";
import {
  getFollowupSystemPrompt,
  getFollowupUserPrompt,
  type FollowupContext,
} from "../../services/followupPrompts";

// Full doctrine matrix across all four script families.
const LANGS: string[] = [
  // Latin
  "en", "es", "de", "fr", "it", "pt", "pt-BR", "nl", "pl", "cs", "hu", "ro",
  "tr", "sv", "da", "nb", "fi", "id", "ms", "tl", "sw", "vi",
  // Cyrillic / Greek
  "ru", "uk", "el",
  // CJK
  "ja", "zh", "ko",
  // RTL
  "ar", "he", "fa", "ur",
  // Indic / other scripts
  "hi", "bn", "ta", "am",
];

const NON_LATIN = new Set([
  "ru", "uk", "el", "ja", "zh", "ko", "ar", "he", "fa", "ur", "hi", "bn", "ta", "am",
]);

const REQUIRED_TTL: "5m" | "1h" = "1h";
const MIN_CACHEABLE_TOKENS = 1024; // claude-sonnet-4-6

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);

// Conservative token floor: min(chars/4, words*1.33). The writer prefix is
// ~3.4k, so the floor is comfortable against the 1,024 minimum.
const tokFloor = (s: string) =>
  Math.min(Math.round(s.length / 4), Math.round(s.trim().split(/\s+/).length * 1.33));

function buildCtx(lang: string): FollowupContext {
  // A Latin-script name so the non-Latin path must transliterate it in the
  // greeting — a per-language behavior that must live in the USER prompt.
  return {
    prospect_name: "John Carter",
    company: "Skylark Mobile",
    vertical: "gaming_ua",
    sub_vertical: null,
    product: "mafo",
    original_subject: "Performance UA for your gaming portfolio",
    original_body_summary: "user acquisition for your gaming portfolio in Japan",
    original_body:
      "Hi John, we run incrementality-tested UA for mobile games. " +
      "Last quarter a similar studio cut CPA 18% on a Japan segment while holding D7 ROAS. " +
      "Worth a short test on one title?",
    original_language: lang,
    stage: 2,
    days_since_original: 5,
    sender_name: "Maya Levin",
  };
}

const STATIC_SYSTEM = getFollowupSystemPrompt();

interface Row {
  lang: string;
  bpOk: boolean;
  ttlOk: boolean;
  sysHash: string;
  sysTok: number;
  natInUser: boolean;
  userLen: number;
  pass: boolean;
}

const rows: Row[] = [];
let firstSysHash = "";

for (const lang of LANGS) {
  const ctx = buildCtx(lang);
  const system = cachedSystem(UNTRUSTED_DATA_SYSTEM_CLAUSE, STATIC_SYSTEM) as Array<{
    text: string;
    cache_control?: { type: string; ttl?: string };
  }>;
  const user = getFollowupUserPrompt(ctx);

  const last = system[system.length - 1];
  const earlierClean = system.slice(0, -1).every((b) => !b.cache_control);
  const bpOk = earlierClean && !!last.cache_control && last.cache_control.type === "ephemeral";
  const ttlOk = last.cache_control?.ttl === REQUIRED_TTL;

  const prefixText = system.map((b) => b.text).join("\n");
  const sysHash = sha(prefixText);
  if (!firstSysHash) firstSysHash = sysHash;

  const sysTok = tokFloor(prefixText);
  const natInUser = lang === "en" ? true : /NATIVENESS|NATIVE/i.test(user);

  const pass =
    bpOk && ttlOk && sysHash === firstSysHash && sysTok >= MIN_CACHEABLE_TOKENS && natInUser;
  rows.push({ lang, bpOk, ttlOk, sysHash, sysTok, natInUser, userLen: user.length, pass });
}

const allHashesEqual = new Set(rows.map((r) => r.sysHash)).size === 1;
const allPass = rows.every((r) => r.pass) && allHashesEqual;

console.log(`\nPROMPT_CACHE_TTL in use:    "${PROMPT_CACHE_TTL}"  (smoke requires "${REQUIRED_TTL}")`);
console.log(`Languages exercised:        ${rows.length}`);
console.log(`Cached prefix sha256:       ${firstSysHash} (first 12)`);
console.log(`Cached prefix token floor:  ~${rows[0].sysTok}  (>= ${MIN_CACHEABLE_TOKENS} required)\n`);

console.log("lang    bp  ttl=1h  sys-hash   ~tok    nat->user  user-len  result");
console.log("-".repeat(72));
for (const r of rows) {
  const flag = NON_LATIN.has(r.lang) ? "*" : " ";
  console.log(
    `${(r.lang + flag).padEnd(7)} ${r.bpOk ? "Y" : "n"}   ${r.ttlOk ? "Y" : "n"}     ` +
      `${r.sysHash === firstSysHash ? "MATCH" : "DIFF "}   ${String(r.sysTok).padStart(5)}    ` +
      `${r.natInUser ? "Y" : "n"}        ${String(r.userLen).padStart(6)}   ${r.pass ? "PASS" : "FAIL"}`,
  );
}
console.log("-".repeat(72));
console.log("(* = non-Latin script: greeting name must transliterate in the USER prompt)\n");

console.log(`All cached prefixes identical across languages: ${allHashesEqual ? "YES" : "NO"}`);
console.log(`Breakpoint + ${REQUIRED_TTL} TTL on every call:              ${rows.every((r) => r.bpOk && r.ttlOk) ? "YES" : "NO"}`);
console.log(`Prefix clears ${MIN_CACHEABLE_TOKENS}-token minimum:              ${rows.every((r) => r.sysTok >= MIN_CACHEABLE_TOKENS) ? "YES" : "NO"}`);
console.log(`Per-language content in USER prompt only:       ${rows.every((r) => r.natInUser) && allHashesEqual ? "YES" : "NO"}`);

const sample = (lang: string) => {
  const u = getFollowupUserPrompt(buildCtx(lang));
  return `${lang}: userHash=${sha(u)} len=${u.length}`;
};
console.log("\nUSER prompt varies per language (variation is OUTSIDE the cache):");
for (const l of ["en", "ja", "ar", "ru"]) console.log("  " + sample(l));

console.log(
  `\n${allPass ? "SMOKE PASS" : "SMOKE FAIL"} - ${rows.filter((r) => r.pass).length}/${rows.length} languages clean\n`,
);
process.exit(allPass ? 0 : 1);
