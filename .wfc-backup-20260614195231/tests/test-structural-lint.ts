/**
 * test-structural-lint.ts
 *
 * Locks the deterministic contract of the structural linter: sentence-count
 * cap, forbidden dashes, verbatim overlap with the original, and follow-up
 * acknowledgment markers. No DB, no network, no LLM.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx --test src/tests/test-structural-lint.ts
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";

import { detectStructuralViolations, mergeViolationReports } from "../lib/structuralLint";

function hasIssue(report: { issues: string[] }, code: string): boolean {
  return report.issues.some((i) => i.includes(code));
}

// ---------------------------------------------------------------------------
// clean control
// ---------------------------------------------------------------------------
test("clean english follow-up passes", () => {
  const body =
    "Hi John,\n" +
    "Following up on my note about the Brazil campaign. We delivered 250 installs last month. " +
    "The D7 retention held steady. Worth a quick call next week?";
  const r = detectStructuralViolations(body, { languageTag: "en" });
  assert.equal(r.found, false);
});

// ---------------------------------------------------------------------------
// A. sentence-count cap
// ---------------------------------------------------------------------------
test("over-length english draft flags SENTENCE-COUNT", () => {
  const body =
    "Following up on my earlier email. One. Two. Three. Four. Five. Six. Seven. Eight more sentences here.";
  const r = detectStructuralViolations(body, { languageTag: "en" });
  assert.equal(r.found, true);
  assert.ok(hasIssue(r, "SENTENCE-COUNT"));
});

test("sentence-count rule is skipped for thai", () => {
  // Same nine periods, but Thai has no punctuation sentence delimiter, so the
  // rule must not fire. Thai ack markers are present to isolate rule A.
  const body =
    "เรียน คุณสมชาย ติดตามอีเมลก่อนหน้า. A. B. C. D. E. F. G. H.";
  const r = detectStructuralViolations(body, { languageTag: "th" });
  assert.ok(!hasIssue(r, "SENTENCE-COUNT"));
});

// ---------------------------------------------------------------------------
// B. forbidden dashes
// ---------------------------------------------------------------------------
test("em dash flags FORBIDDEN-DASH", () => {
  const body = "Following up on my note. We deliver quality \u2014 real durable revenue. Call?";
  const r = detectStructuralViolations(body, { languageTag: "en" });
  assert.equal(r.found, true);
  assert.ok(hasIssue(r, "FORBIDDEN-DASH"));
});

test("en dash flags FORBIDDEN-DASH", () => {
  const body = "Following up on my note. Volumes ran 200\u2013300 a day. Call?";
  const r = detectStructuralViolations(body, { languageTag: "en" });
  assert.ok(hasIssue(r, "FORBIDDEN-DASH"));
});

test("plain hyphen does not flag", () => {
  const body = "Following up on my note. We run pre-bid screening daily. Call?";
  const r = detectStructuralViolations(body, { languageTag: "en" });
  assert.ok(!hasIssue(r, "FORBIDDEN-DASH"));
});

// ---------------------------------------------------------------------------
// C. verbatim overlap
// ---------------------------------------------------------------------------
const ORIGINAL =
  "We run semi exclusive inventory with pre bid screening and cohort level anomaly detection across tier one markets.";

test("verbatim copy of the original flags VERBATIM-OVERLAP", () => {
  const body =
    "Hi John,\n" +
    "Following up on my earlier email. We run semi exclusive inventory with pre bid screening " +
    "and cohort level anomaly detection, which keeps revenue durable. Worth a call?";
  const r = detectStructuralViolations(body, { languageTag: "en", originalText: ORIGINAL });
  assert.equal(r.found, true);
  assert.ok(hasIssue(r, "VERBATIM-OVERLAP"));
});

test("paraphrase of the original does not flag overlap", () => {
  const body =
    "Hi John,\n" +
    "Following up on my earlier email. We focus on durable supply and screen traffic before " +
    "bidding. Worth a call?";
  const r = detectStructuralViolations(body, { languageTag: "en", originalText: ORIGINAL });
  assert.ok(!hasIssue(r, "VERBATIM-OVERLAP"));
});

// ---------------------------------------------------------------------------
// D. follow-up acknowledgment
// ---------------------------------------------------------------------------
test("missing acknowledgment flags FOLLOWUP-ACK", () => {
  const body = "Hi John,\nWe deliver 250 installs a day in Brazil. Worth a call next week?";
  const r = detectStructuralViolations(body, { languageTag: "en" });
  assert.equal(r.found, true);
  assert.ok(hasIssue(r, "FOLLOWUP-ACK"));
});

test("present acknowledgment passes ack rule", () => {
  const body = "Hi John,\nCircling back on my previous email about Brazil. Worth a call?";
  const r = detectStructuralViolations(body, { languageTag: "en" });
  assert.ok(!hasIssue(r, "FOLLOWUP-ACK"));
});

test("untabled language is skipped for ack (no false positive)", () => {
  // Swahili has no marker table, so absence of a marker must not flag.
  const body = "Habari John,\nTunatoa watumiaji bora kila siku. Tupige simu wiki ijayo?";
  const r = detectStructuralViolations(body, { languageTag: "sw" });
  assert.ok(!hasIssue(r, "FOLLOWUP-ACK"));
});

// ---------------------------------------------------------------------------
// master toggle
// ---------------------------------------------------------------------------
test("STRUCTURAL_LINT_ENABLED=0 disables the whole layer", () => {
  process.env.STRUCTURAL_LINT_ENABLED = "0";
  const body = "Hi John,\nWe deliver 250 installs a day. Worth a call?"; // would normally flag ack
  const r = detectStructuralViolations(body, { languageTag: "en" });
  assert.equal(r.found, false);
  delete process.env.STRUCTURAL_LINT_ENABLED;
});

// ---------------------------------------------------------------------------
// merge helper
// ---------------------------------------------------------------------------
test("mergeViolationReports unions found reports", () => {
  const a = { found: true, issues: ["X"], suggestions: ["sx"], matches: ["mx"] };
  const b = { found: false, issues: [], suggestions: [], matches: [] };
  const merged = mergeViolationReports(a, b);
  assert.equal(merged.found, true);
  assert.deepEqual(merged.issues, ["X"]);
});

test("mergeViolationReports of empties is not found", () => {
  const empty = { found: false, issues: [], suggestions: [], matches: [] };
  const merged = mergeViolationReports(empty, empty);
  assert.equal(merged.found, false);
});
