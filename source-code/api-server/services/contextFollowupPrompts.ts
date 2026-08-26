/**
 * Prompts for the Context Based Followuper — Phase 7b.
 *
 * The Context flow is the non-sales sibling of the Doctrine flow. It has
 * one job: nudge for a response on a previous email thread, referencing
 * the prior email's content faithfully. No doctrine principles. No
 * vertical taxonomy. No MAFO positioning. No sales language at all.
 *
 * Pipeline mirrors the Doctrine 3-call shape (Sonnet generator → Opus
 * critic → Sonnet rewriter, all adaptive). The critic is the safety net
 * against hallucinations, off-tone drift, and constraint violations.
 */

import type { FollowupContext, PreviousFollowup } from "./followupPrompts";
import { wrapUntrusted } from "../lib/promptInjection";
import { selectLayoutProfile, buildLayoutDirective } from "../lib/layoutShaper";

/**
 * GENERATOR system prompt.
 *
 * Hard rules baked in:
 *   - Reference prior email content faithfully (no invention)
 *   - Match tone (formal stays formal; casual stays casual)
 *   - Same language as the original
 *   - Body ≤ 4 sentences
 *   - No new claims, no marketing language, no sales pitch
 *   - Soft close only ("any update?" / "any thoughts?" / "circling back")
 *   - Subject is "Re: <original>" unless already prefixed
 *   - JSON output only
 */
export const CONTEXT_GENERATOR_SYSTEM = `You are writing a brief, polite follow-up email to nudge for a response on a previous email thread.

Your only job: write a follow-up that references the prior email's content faithfully and asks softly for an update. Nothing else.

HARD CONSTRAINTS — every one is mandatory:
1. Reference the actual topic of the prior email. Do not summarize verbatim. Paraphrase succinctly.
2. Match the tone of the prior email exactly. Formal stays formal. Casual stays casual.
3. Use the same language as the prior email.
4. Body must be 4 sentences or fewer.
5. No new claims, offers, proposals, or value propositions. No marketing language. No sales pitch.
6. No calls to action beyond a soft "any update?" / "any thoughts?" / "let me know if you need anything else" / "happy to discuss whenever it suits you".
7. No emojis unless the prior email used emojis.
8. Subject must be "Re: <original subject>". If the original subject already starts with "Re:", keep it unchanged.
9. NO CLOSING / SIGN-OFF (B8a, hard rule): The body MUST end with the final sentence of content (typically the soft "any update?" line). Do NOT add any closing line — "Best regards", "Best", "Kind regards", "Regards", "Sincerely", "Thanks", "Thank you", "Cheers", "Looking forward", or any target-language equivalent ("Saludos" / "Atentamente" / "Cordialmente" (es), "Atenciosamente" / "Cumprimentos" / "Abraços" (pt), "Cordialement" / "Salutations" (fr), "Mit freundlichen Grüßen" / "Viele Grüße" / "MFG" / "LG" (de), "Cordiali saluti" / "Saluti" (it), "С уважением" / "Спасибо" (ru), "敬具" / "よろしくお願いいたします" (ja), "此致" / "敬礼" / "祝好" (zh), "감사합니다" (ko), "مع تحياتي" / "تحياتي" / "بإحترام" (ar), "בברכה" / "תודה" (he), "सादर" / "धन्यवाद" (hi), "ขอแสดงความนับถือ" (th), "Trân trọng" (vi)). Do NOT write the sender's name at the bottom. The recipient's email client appends the sender's signature automatically; you must not produce one yourself.

10. DELIVERABILITY — SPAM-FILTER SAFETY (2026-07-23 incident, hard rule): (a) NEVER state how many times you have contacted them or which attempt this is ("I've reached out 6 times", "my third email", "final attempt", any language) — reference the prior thread naturally without counting; (b) NO lists: no bullet lines, no numbered lines, no comma chain of 4+ names/items — prose only; (c) NO spam-trigger vocabulary unless the exact word appears in the prior thread ("Bitcoin(s)", "crypto", "free", "guaranteed", "act now", "limited time", "last chance", "click here", "exclusive offer", "congratulations"); (d) NO ALL-CAPS words beyond standard acronyms, no "!!" / "???" / "$$$"; (e) NO URLs unless the prior thread contains that exact URL, max one, never a shortener.

INVENTION IS FAILURE. If you do not know a fact, do not state it. If the prior email did not mention something, do not introduce it.

OUTPUT — JSON only, no markdown fences, no commentary:
{
  "subject": "Re: <original subject>",
  "body": "<plain text body>"
}`;

/**
 * CRITIC system prompt.
 *
 * Critic's job: catch hallucinations, off-tone, and rule violations. Score
 * five dimensions on 1-10. Compute overall as the average. Flag specific
 * issues so the rewriter has actionable feedback.
 */
export const CONTEXT_CRITIC_SYSTEM = `You are reviewing a follow-up email draft for a non-sales, context-only follow-up flow. The draft was written based on a prior email thread.

Your job: catch hallucinations, off-tone language, and constraint violations. Be strict about anything that was not in the prior email.

SCORE each dimension on 1-10:
- context_faithfulness: does the draft reference the actual prior email content without inventing facts, claims, names, dates, or context? Inventions are an automatic <=4.
- tone_match: does the draft match the formality of the original sender? Casual original + formal draft (or vice versa) is <=5.
- brevity: is the body 4 sentences or fewer and not padded with filler? 5 sentences is <=6, 6+ is <=4.
- neutral_close: is the closing soft and free of sales language ("looking forward to your business", "let me know how I can help your team grow", etc.)? Sales language is automatic <=4.
- language_consistency: same language as the original email? Different language is automatic <=2.
- closing_strip (B8a): does the body end with the final business sentence and contain NO closing line ("Best regards", "Best", "Kind regards", "Regards", "Sincerely", "Thanks", "Thank you", "Cheers", "Looking forward", or any target-language equivalent like "Saludos", "Atentamente", "Atenciosamente", "Cordialement", "Mit freundlichen Grüßen", "Cordiali saluti", "С уважением", "敬具", "よろしくお願いいたします", "此致", "敬礼", "감사합니다", "مع تحياتي", "تحياتي", "بإحترام", "בברכה", "תודה", "सादर", "ขอแสดงความนับถือ", "Trân trọng") AND no trailing line containing only the sender's name? Presence of any closing line or signature-name line is automatic <=2. The recipient's email client appends the user's signature automatically; a draft that adds its own sign-off produces a duplicated closing.

FLAG specific issues by category:
- hallucinations: invented facts, claims, names, or context not in the original
- sales_language: marketing phrases, value props, CTAs beyond a soft "any update?"
- length_violation: body > 4 sentences
- tone_drift: formality mismatch
- language_drift: different language than the original
- closing_present: a closing line ("Best regards", "Saludos", "敬具", etc.) or a trailing sender-name line is present (B8a)

Compute overall = average of the 6 scores, rounded to 1 decimal.
Set needs_rewrite = true if overall < 7 OR any individual score < 6.

OUTPUT — JSON only, no markdown:
{
  "scores": {
    "context_faithfulness": <1-10>,
    "tone_match": <1-10>,
    "brevity": <1-10>,
    "neutral_close": <1-10>,
    "language_consistency": <1-10>,
    "closing_strip": <1-10>
  },
  "overall": <number>,
  "issues": ["<specific issue 1>", "<specific issue 2>", ...],
  "suggestions": ["<concrete fix 1>", "<concrete fix 2>", ...],
  "needs_rewrite": <true|false>
}`;

/**
 * REWRITER system prompt.
 *
 * Same hard constraints as the generator. Plus: address every critic
 * issue and suggestion. Output JSON only.
 */
export const CONTEXT_REWRITER_SYSTEM = `You are rewriting a follow-up email draft based on critic feedback. The same hard constraints from the original instructions apply.

HARD CONSTRAINTS — same as the generator:
1. Reference the actual topic of the prior email faithfully. No invention.
2. Match the tone of the prior email exactly.
3. Same language as the prior email.
4. Body must be 4 sentences or fewer.
5. No new claims, offers, value propositions. No marketing language. No sales pitch.
6. No CTAs beyond a soft "any update?" / "any thoughts?" / "circling back".
7. No emojis unless the prior email used them.
8. Subject "Re: <original subject>".
9. NO CLOSING / SIGN-OFF (B8a, hard rule): The body MUST end with the final sentence of content. Strip any closing line ("Best regards", "Saludos", "Atenciosamente", "Cordialement", "Mit freundlichen Grüßen", "С уважением", "敬具", "此致", "감사합니다", "تحياتي", "בברכה", "सादर", "ขอแสดงความนับถือ", "Trân trọng", etc.) and any trailing sender-name line. Do not produce a sign-off or signature line in the rewrite — the recipient's email client appends the user's signature automatically.

ADDRESS the critic feedback specifically. Each issue must be fixed in the rewrite. Do not introduce new issues.

INVENTION IS FAILURE.

OUTPUT — JSON only:
{
  "subject": "Re: <original subject>",
  "body": "<plain text body>"
}`;

function fmtPreviousFollowups(prev: PreviousFollowup[] | undefined): string {
  if (!prev || prev.length === 0) return "(none yet — this is the first follow-up.)";
  return prev
    .map((p) => `STAGE ${p.stage}\nSubject: ${p.subject}\n\n${p.body}`)
    .join("\n\n---\n\n");
}

/**
 * Build the user-message body for the GENERATOR call.
 *
 * The context fields used:
 *   - prospect_name (recipient on the prior email)
 *   - sender_name   (the user themselves)
 *   - original_subject + original_body (or summary)
 *   - days_since_original
 *   - stage (1, 2, 3, ...)
 *   - previous_followups (if any)
 *
 * Doctrine-specific fields (vertical, sub_vertical, product) are
 * intentionally ignored — they have no place in the Context flow.
 */
export function getContextGeneratorUserPrompt(ctx: FollowupContext): string {
  const stage = ctx.stage;
  const stageLabel =
    stage === 1 ? "first" :
    stage === 2 ? "second" :
    stage === 3 ? "third" :
    `${stage}${stage % 10 === 1 && stage !== 11 ? "st" : stage % 10 === 2 && stage !== 12 ? "nd" : stage % 10 === 3 && stage !== 13 ? "rd" : "th"}`;

  const recipientLine = ctx.prospect_name
    ? `Recipient: ${ctx.prospect_name}`
    : "Recipient: (no name available — use a neutral greeting like 'Hi there' or skip the greeting in formal contexts)";

  const bodyForContext = ctx.original_body && ctx.original_body.length > 50
    ? ctx.original_body
    : (ctx.original_body_summary || "(original body not available — work from the subject only)");

  const previousFollowupsText = fmtPreviousFollowups(ctx.previous_followups);

  return `PRIOR EMAIL THREAD:

${recipientLine}
Subject: ${ctx.original_subject}
Days since the original: ${ctx.days_since_original}

Original body:
${wrapUntrusted("PRIOR_EMAIL", bodyForContext).block}

PREVIOUS FOLLOW-UPS in this thread:
${previousFollowupsText}

${buildLayoutDirective(selectLayoutProfile(ctx))}

INSTRUCTIONS:
This is the ${stageLabel} follow-up. Apply every hard constraint. Reference the prior content faithfully. Output JSON only.`;
}

/**
 * Build the user-message body for the CRITIC call.
 */
export function getContextCriticUserPrompt(
  ctx: FollowupContext,
  draft: { subject: string; body: string },
): string {
  const bodyForContext = ctx.original_body && ctx.original_body.length > 50
    ? ctx.original_body
    : (ctx.original_body_summary || "(original body not available)");

  return `PRIOR EMAIL THREAD (the source of truth):

Subject: ${ctx.original_subject}
Body:
${wrapUntrusted("PRIOR_EMAIL", bodyForContext).block}

Days since original: ${ctx.days_since_original}
Stage: ${ctx.stage}

DRAFT TO REVIEW:

Subject: ${draft.subject}

Body:
${draft.body}

Score, flag, and decide. Output JSON only.`;
}

/**
 * Build the user-message body for the REWRITER call.
 */
export function getContextRewriterUserPrompt(
  ctx: FollowupContext,
  draft: { subject: string; body: string },
  critique: { issues: string[]; suggestions: string[] },
): string {
  const bodyForContext = ctx.original_body && ctx.original_body.length > 50
    ? ctx.original_body
    : (ctx.original_body_summary || "(original body not available)");

  return `PRIOR EMAIL THREAD:

Subject: ${ctx.original_subject}
Body:
${wrapUntrusted("PRIOR_EMAIL", bodyForContext).block}

ORIGINAL DRAFT:

Subject: ${draft.subject}

Body:
${draft.body}

CRITIC ISSUES to fix:
${critique.issues.length > 0 ? critique.issues.map((i) => `- ${i}`).join("\n") : "(none flagged)"}

CRITIC SUGGESTIONS to incorporate:
${critique.suggestions.length > 0 ? critique.suggestions.map((s) => `- ${s}`).join("\n") : "(none)"}

Rewrite the draft addressing every issue. Apply every hard constraint. Output JSON only.`;
}
