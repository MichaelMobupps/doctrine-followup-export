#!/usr/bin/env node
/**
 * patch-lint-falsepositives.mjs
 * ---------------------------------------------------------------------------
 * Fixes three lint FALSE POSITIVES surfaced by the all-languages heal smoke.
 * The writer was correct in every case; the detectors were over-firing and
 * forcing needless rewrites (cost) on good emails.
 *
 *   1. structuralLint.ts — ACK_VERB.it: add "riprend".
 *      "Riprendo la mia email di qualche giorno fa" is a valid Italian follow-up
 *      reference, but the verb riprend- was not in the table, so FOLLOWUP-ACK
 *      fired on a correct email.
 *
 *   2. structuralLint.ts — ACK_VERB.tr: add "ilet".
 *      "...ilettiğim mesajın ardından" (the message I sent) is a valid Turkish
 *      follow-up reference, but the verb ilet- (only the inflected "iletmistim"
 *      was listed) was missed, so FOLLOWUP-ACK fired.
 *
 *   3. doctrineRules.ts — widen the isLatin test in findHypeAdjectivesInBody.
 *      The test /^[\x20-\x7e]+$/ treats any diacritic-bearing Latin word (e.g.
 *      Hungarian "erős") as non-Latin and routes it to SUBSTRING matching, which
 *      flagged "erős" inside "megerősített" (confirmed). Widening the test to the
 *      Latin-Extended ranges routes these adjectives to WORD-BOUNDARY matching,
 *      which does not match a stem inside a longer word. Fixes Hungarian and the
 *      same latent bug in Czech, Polish, Romanian, Turkish, Vietnamese, etc.
 *
 * SAFE: idempotent (each fix re-checked before applying), anchored (refuses to
 * patch if the source has drifted), behavior-narrowing (each change only REMOVES
 * false positives; it never adds new flags).
 *
 * RUN (from ~/workspace):
 *   node patch-lint-falsepositives.mjs
 *   node patch-lint-falsepositives.mjs <structuralLint.ts> <doctrineRules.ts>
 * Defaults target the artifacts/src layout.
 * ---------------------------------------------------------------------------
 */
import { readFileSync, writeFileSync } from "node:fs";

const structPath = process.argv[2] ?? "artifacts/api-server/src/lib/structuralLint.ts";
const rulesPath = process.argv[3] ?? "artifacts/api-server/src/lib/doctrineRules.ts";

let changed = 0;
const fail = (m) => { console.error(`✗ ${m}`); process.exit(1); };

function read(path) {
  try { return readFileSync(path, "utf8"); }
  catch { fail(`cannot read ${path}. Pass the path as an argument.`); }
}

function applyOnce(src, oldStr, newStr, label) {
  if (src.includes(newStr)) { console.log(`• ${label}: already applied — skip.`); return src; }
  const n = src.split(oldStr).length - 1;
  if (n !== 1) fail(`${label}: expected exactly one anchor, found ${n}. Source drifted; not patching.`);
  changed++;
  console.log(`✓ ${label}`);
  return src.replace(oldStr, newStr);
}

// ---- structuralLint.ts: two ACK_VERB additions ----
let struct = read(structPath);
struct = applyOnce(
  struct,
  '  it: ["scritto", "inviato", "facendo seguito", "ricolleg", "ritorn", "contattato"],',
  '  it: ["scritto", "inviato", "facendo seguito", "ricolleg", "ritorn", "riprend", "contattato"],',
  "ACK_VERB.it += riprend",
);
struct = applyOnce(
  struct,
  '  tr: ["yazmistim", "gonderdim", "iletmistim", "takip"],',
  '  tr: ["yazmistim", "gonderdim", "iletmistim", "ilet", "takip"],',
  "ACK_VERB.tr += ilet",
);

// ---- doctrineRules.ts: widen isLatin to Latin-Extended ----
let rules = read(rulesPath);
rules = applyOnce(
  rules,
  "    const isLatin = /^[\\x20-\\x7e]+$/.test(adj);",
  "    const isLatin = /^[\\x20-\\x7e\\u00c0-\\u024f\\u1e00-\\u1eff]+$/.test(adj);",
  "findHypeAdjectivesInBody: isLatin widened to Latin-Extended",
);

if (changed === 0) {
  console.log("\nNothing to do — all three fixes already present.");
  process.exit(0);
}

writeFileSync(structPath, struct, "utf8");
writeFileSync(rulesPath, rules, "utf8");
console.log(`\nApplied ${changed} fix(es).`);
console.log("Run `pnpm --filter @workspace/api-server typecheck` to confirm.");
