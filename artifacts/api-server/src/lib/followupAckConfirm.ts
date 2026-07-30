/**
 * followupAckConfirm.ts — LLM confirmation layer for the FOLLOWUP-ACK gate.
 *
 * The deterministic FOLLOWUP-ACK check (structuralLint Rule D) decides whether a
 * follow-up email's opening references prior outreach using per-language regex
 * tables. Those tables cannot keep pace with the natural variety of ways the
 * writer phrases a reference across 36 languages, so they false-positive on
 * correct emails — a rotating tail (it, tr, es, pl, hi, ...) seen across heal-smoke
 * runs. Each false positive forces up to two needless rewrites in production.
 *
 * This module adds a cheap LLM confirmation that runs ONLY when the regex layer
 * has already flagged FOLLOWUP-ACK (the ~regex-miss subset, a few percent of
 * cells, and only for the ~20 languages the table covers). A single Haiku yes/no
 * reads the opening and confirms whether it references prior outreach. If it does,
 * the false positive is dropped; otherwise the deterministic flag stands.
 *
 * Safety properties:
 *   - Fail-open CONSERVATIVE: on any error, timeout, disabled flag, or a non-YES
 *     answer, the FOLLOWUP-ACK flag is KEPT (current behavior). The LLM can only
 *     ever REMOVE a false positive by positively confirming a reference, so the
 *     worst case is "no change from today," never a new failure mode.
 *   - No LLM call unless FOLLOWUP-ACK already fired (regex stays the free path).
 *   - Disable entirely with FOLLOWUP_ACK_LLM_CONFIRM=0. Override the model with
 *     ACK_CONFIRM_MODEL if the Haiku string ever changes.
 */
import { anthropic } from "./anthropic";
import { UNTRUSTED_DATA_SYSTEM_CLAUSE, wrapUntrusted } from "./promptInjection";
import type { ViolationReport } from "./doctrineLint";
import { logger } from "./logger";

const ENABLED = process.env.FOLLOWUP_ACK_LLM_CONFIRM !== "0";
const MODEL = process.env.ACK_CONFIRM_MODEL ?? "claude-haiku-4-5";

const ACK_SYSTEM = `You judge whether the OPENING of a sales follow-up email references or acknowledges a PRIOR message, email, or outreach to the same recipient.

A reference may be explicit or paraphrased, in ANY language. It counts as a reference if the opening points back to an earlier contact, e.g. "following up on my email", "circling back", "as I mentioned", "regarding my previous note", "in addition to the message I sent a few days ago", "picking up on my earlier email". It does NOT count if the opening starts a brand-new pitch with no mention of any earlier contact.

Answer with exactly one word: YES if the opening references prior outreach, NO if it opens cold. Output only YES or NO.`;

/**
 * True iff the opening references prior outreach. Returns false on disabled,
 * empty, error, or any non-YES answer (conservative fail-open).
 */
export async function referencesPriorOutreach(body: string, lang: string): Promise<boolean> {
  if (!ENABLED) return false;
  const opening = body.slice(0, 500).trim();
  if (!opening) return false;
  try {
    const resp = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 5,
      system: `${UNTRUSTED_DATA_SYSTEM_CLAUSE}\n\n${ACK_SYSTEM}`,
      messages: [{ role: "user", content: wrapUntrusted("EMAIL_OPENING", opening).block }],
    });
    const tb = resp.content.find((b) => b.type === "text");
    const answer = tb && tb.type === "text" ? tb.text.trim().toUpperCase() : "";
    return answer.startsWith("YES");
  } catch (err) {
    logger.warn({ err: String(err), lang }, "FOLLOWUP-ACK LLM confirm failed — keeping deterministic flag");
    return false;
  }
}

// Tags that identify the FOLLOWUP-ACK triple pushed by structuralLint Rule D.
const ACK_ISSUE_TAG = "FOLLOWUP-ACK";
const ACK_SUGGESTION_TAG = "acknowledgment of the prior outreach";
const ACK_MATCH_TAG = "no acknowledgment marker in opening";

/**
 * If `report` carries a FOLLOWUP-ACK violation that is actually a false positive
 * (the opening DOES reference prior outreach, per the LLM), strip the ACK triple
 * and recompute `found`. All other violations are left untouched. No LLM call is
 * made when the report has no FOLLOWUP-ACK entry.
 */
export async function dropFalseFollowupAck(
  report: ViolationReport,
  body: string,
  lang: string,
): Promise<ViolationReport> {
  if (!report.found || !report.issues.some((i) => i.includes(ACK_ISSUE_TAG))) return report;
  const referenced = await referencesPriorOutreach(body, lang);
  if (!referenced) return report; // genuinely missing, or LLM unsure → keep the flag
  const issues = report.issues.filter((i) => !i.includes(ACK_ISSUE_TAG));
  const suggestions = report.suggestions.filter((s) => !s.includes(ACK_SUGGESTION_TAG));
  const matches = report.matches.filter((m) => m !== ACK_MATCH_TAG);
  logger.info({ lang }, "FOLLOWUP-ACK confirmed false positive by LLM — dropping flag");
  if (issues.length === 0) return { found: false, issues: [], suggestions: [], matches: [] };
  return { found: true, issues, suggestions, matches };
}
