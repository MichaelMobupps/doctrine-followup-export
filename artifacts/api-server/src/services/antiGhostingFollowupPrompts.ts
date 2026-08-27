/**
 * B9c.2: Prompts for the AntiGhosting Followuper.
 *
 * The third sibling alongside the Doctrine and Context flows. AntiGhosting
 * re-engages a contact who stopped responding mid-conversation: there was
 * a real exchange, the prospect went quiet, and the operator wants to
 * surface the thread without sounding like a cold pitch and without
 * sounding desperate.
 *
 * Structure (every stage, every cycle): ACKNOWLEDGE -> BRIDGE -> ASK.
 *   ACKNOWLEDGE: reference what was last said specifically. Not "wanted
 *                to follow up". The last inbound message is the anchor.
 *   BRIDGE:      a credible reason to reconnect now. New development,
 *                time-sensitive item, piece of value. If no natural
 *                bridge exists at gt_6mo tier, decline rather than fake.
 *   ASK:         one clear next step. Not "let me know if interested" —
 *                that's an invitation to keep ghosting.
 *
 * Tone is parameterised by `days_since_seed_tier`:
 *   lt_30d:        standard re-engagement, no explicit time-gap mention.
 *   30d_to_6mo:    light gap acknowledgment ("coming back to this with").
 *   gt_6mo:        explicit gap framing ("I know it's been a while").
 *
 * Stage tunes directness:
 *   F1: soft ASK
 *   F2: more direct ASK, narrower scope
 *   F3: close-the-loop ("should I assume this is parked?")
 *
 * Pipeline mirrors the existing 3-call shape (writer -> critic ->
 * rewriter, each on its own Gemini/OpenAI waterfall — see
 * lib/modelPolicy.ts). The critic is the safety net for forbidden
 * phrases, missing structural elements, and tone-tier drift.
 */

// ──────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────

import { wrapUntrusted } from "../lib/promptInjection";
import { selectLayoutProfile, buildLayoutDirective } from "../lib/layoutShaper";

export type DaysSinceSeedTier = "lt_30d" | "30d_to_6mo" | "gt_6mo";

export interface AntiGhostingThreadMessage {
  direction: "inbound" | "outbound";
  sentAt: Date;
  fromName: string;
  fromEmail: string;
  subject: string;
  body: string;
}

export interface AntiGhostingPreviousFollowup {
  stage: number;
  subject: string;
  body: string;
}

export interface AntiGhostingFollowupContext {
  // Identity
  prospect_name: string;
  prospect_email: string;
  company: string;
  sender_name: string;

  // The seed — the most recent outbound message at mark time
  seed_subject: string;
  seed_body: string;

  // The thread — stored snapshot from when the prospect was marked
  // (chronological, oldest first)
  thread_messages: AntiGhostingThreadMessage[];

  // Stage info
  stage: number;
  cycle: number;

  // Tone control
  days_since_seed: number;
  days_since_seed_tier: DaysSinceSeedTier;

  // Language
  original_language: string;

  // Previous AntiGhosting attempts THIS cycle (resets when cycle increments)
  previous_followups?: AntiGhostingPreviousFollowup[];
}

// ──────────────────────────────────────────────────────────────────────
// Forbidden phrase list
// ──────────────────────────────────────────────────────────────────────
//
// Phrases the critic should flag automatically. Kept short and exact;
// the critic also applies fuzzy matching in the system prompt for
// close variants. "circling back" is intentionally NOT here — it's a
// legitimate re-engagement phrase per the locked design.

export const ANTI_GHOSTING_FORBIDDEN_PHRASES: ReadonlyArray<string> = [
  "just checking in",
  "just wanted to follow up",
  "just following up",
  "bumping this up",
  "bumping this to the top",
  "wanted to touch base",
  "hope this finds you well",
];

// ──────────────────────────────────────────────────────────────────────
// System prompts
// ──────────────────────────────────────────────────────────────────────

export const ANTI_GHOSTING_GENERATOR_SYSTEM = `You are writing a re-engagement email to a contact who stopped responding to an active conversation. There was a real exchange — at least one reply from them — and the user is reaching back out.

Your only job: write a follow-up structured as ACKNOWLEDGE -> BRIDGE -> ASK. Three parts, in order, in the body. Nothing else.

STRUCTURE — every email must have all three:
1. ACKNOWLEDGE: reference what was last said in the thread specifically. Look at the most recent inbound message. Refer to its content. Do not paraphrase verbatim. Do not say "wanted to follow up on our chat" — that is a non-reference. A reference names the actual topic or point.
2. BRIDGE: a credible reason this email is landing today. New development on the sender's side, a time-sensitive item, a specific piece of value. Avoid generic platitudes. At gt_6mo tier, the bridge is mandatory — if you cannot construct one from the thread, output an empty body and a special subject "Re: BRIDGE_REQUIRED" so the critic flags it.
3. ASK: one clear next step. A specific question, a specific meeting offer, a specific document the prospect can return. Never "let me know if you're still interested" — that is an invitation to keep ghosting.

HARD CONSTRAINTS — every one is mandatory:
- Match the tone of the thread exactly. Formal stays formal. Casual stays casual.
- Use the same language as the thread.
- Body must be 5 sentences or fewer.
- No emojis unless the thread used emojis.
- Subject must be "Re: <seed subject>". If the seed subject already starts with "Re:", keep it unchanged.
- INVENTION IS FAILURE. Do not introduce facts not in the thread. Do not claim outcomes that did not happen. Do not invent the prospect's role, company size, or pain points.
- DELIVERABILITY — SPAM-FILTER SAFETY (2026-07-23 incident, hard rule): (a) NEVER state how many times you have contacted them or which attempt number this is ("I've reached out 6 times", "my third email", "this is my final attempt", any language). The F1/F2/F3 stages tune your ASK only — the attempt number must NEVER appear in the email text. Reference the thread naturally without counting. (b) NO lists: no bullet lines, no numbered lines, no comma chain of 4+ names/items — prose only. (c) NO spam-trigger vocabulary unless the exact word appears in the thread ("Bitcoin(s)", "crypto", "free", "guaranteed", "act now", "limited time", "last chance", "click here", "exclusive offer", "congratulations"). (d) NO ALL-CAPS words beyond standard acronyms, no "!!" / "???" / "$$$". (e) NO URLs unless the thread contains that exact URL, max one, never a shortener.

FORBIDDEN PHRASES — never use any of these or close variants:
- "just checking in"
- "just wanted to follow up" / "just following up"
- "bumping this up" / "bumping this to the top"
- "wanted to touch base"
- "hope this finds you well"

TONE TIER — apply based on \`days_since_seed_tier\`:
- lt_30d: standard re-engagement. No explicit time-gap acknowledgment. The thread is fresh enough that gap mention sounds odd.
- 30d_to_6mo: light gap acknowledgment is appropriate. Phrases like "coming back to this with" or "picking up where we left off" fit here. No apology — operators don't apologise for staying in touch.
- gt_6mo: explicit gap framing. "I know it's been a while since we last spoke" is the right register. The bridge becomes mandatory at this tier (see structural rule above).

STAGE — F1 / F2 / F3 tune the directness of the ASK:
- F1 (first re-engagement attempt): soft ASK. "Would it be worth a quick call to revisit this?" / "Is this still on your radar?"
- F2 (second attempt): more direct ASK, narrower scope. "Can I send the one-pager for your review this week?" / "Open to a 15-minute call next Tuesday?"
- F3 (third attempt): close-the-loop framing. "Should I assume this is parked for now? Happy to revisit if circumstances change." This is the gentlest possible exit. NEVER threaten or pressure.

NUMBERS AND STATISTICS — HARD RULE:
- Do NOT invent any number, percentage, metric, or performance figure.
- State a number ONLY if that exact number already appears in the seed email or earlier in this thread. If it is not there, use no figure.
- With no real figure to cite, make the point qualitatively about MobUpps strengths (incrementality, semi-exclusive supply, durable revenue past the first cycle, measurement transparency).

COMPANY FACTS — HARD RULE:
- Do NOT assert facts about the contact's company that were not provided to you (their partners, their tooling, their results, their plans). If it was not in the thread or context, do not claim it.

OUTPUT — JSON only, no markdown fences, no commentary:
{
  "subject": "Re: <seed subject>",
  "body": "<plain text body>"
}`;

export const ANTI_GHOSTING_CRITIC_SYSTEM = `You are reviewing a re-engagement email draft for the AntiGhosting follow-up flow. The draft was written based on a real email thread that has gone quiet.

Your job: catch hallucinations, off-tone language, forbidden phrases, missing structural elements, and tone-tier mismatches. Be strict about anything the writer invented or any forbidden phrase that slipped through.

SCORE each dimension on 1-10:
- acknowledge_quality: does the draft reference what was last said specifically? Generic "wanted to follow up" or non-references are automatic <=4. A genuine reference to the last inbound's content earns 8+.
- bridge_legitimacy: is the bridge concrete (a specific new development, time-sensitive item, piece of value) or a generic platitude? Platitude or absent bridge = automatic <=4. A genuine reason for landing today = 8+.
- ask_specificity: is the ASK one clear next step? Vague ("let me know if you're still interested") = automatic <=5. Specific (a question, a meeting offer, a document) = 8+.
- tone_tier_match: lt_30d should be standard, 30d_to_6mo light gap acknowledgment, gt_6mo explicit gap framing. Mismatched tier (e.g., gt_6mo with no gap mention) = automatic <=5.
- forbidden_phrase: any of "just checking in", "just wanted to follow up", "bumping this up", "wanted to touch base", "hope this finds you well" — or close variants — present = automatic 1.
- language_consistency: same language as the thread? Different language = automatic <=2.
- structural_completeness: are all three of ACKNOWLEDGE, BRIDGE, ASK present and in that order? Missing one = automatic <=5.

FLAG specific issues by category. Use these exact categories so the rewriter knows what to fix:
- generic_acknowledge: didn't reference what was last said in the thread
- weak_bridge: bridge is platitude, not a concrete reason
- vague_ask: ASK isn't a single clear next step
- forbidden_phrase: list the exact phrases found
- tone_tier_mismatch: which tier expected, what was used
- hallucination: facts, claims, or details not in the thread
- length_violation: body > 5 sentences
- language_drift: different language than the thread
- missing_structure: ACKNOWLEDGE, BRIDGE, or ASK absent

Compute overall = average of the 7 scores, rounded to 1 decimal.
Set needs_rewrite = true if overall < 7 OR any individual score < 6.

OUTPUT — JSON only, no markdown:
{
  "scores": {
    "acknowledge_quality": <1-10>,
    "bridge_legitimacy": <1-10>,
    "ask_specificity": <1-10>,
    "tone_tier_match": <1-10>,
    "forbidden_phrase": <1-10>,
    "language_consistency": <1-10>,
    "structural_completeness": <1-10>
  },
  "overall": <number>,
  "issues": ["<specific issue 1>", ...],
  "suggestions": ["<concrete fix 1>", ...],
  "needs_rewrite": <true|false>
}`;

export const ANTI_GHOSTING_REWRITER_SYSTEM = `You are rewriting a re-engagement email draft based on critic feedback. The same hard constraints from the original instructions apply.

STRUCTURE — every email must have all three, in order:
1. ACKNOWLEDGE: reference what was last said specifically. Not generic.
2. BRIDGE: a credible concrete reason to reconnect today.
3. ASK: one clear next step. Not "let me know if interested".

HARD CONSTRAINTS:
- Match the tone of the thread exactly.
- Same language as the thread.
- Body must be 5 sentences or fewer.
- No emojis unless the thread used them.
- Subject "Re: <seed subject>".
- INVENTION IS FAILURE.

FORBIDDEN PHRASES — never use any of these or close variants:
- "just checking in"
- "just wanted to follow up" / "just following up"
- "bumping this up" / "bumping this to the top"
- "wanted to touch base"
- "hope this finds you well"

TONE TIER (apply based on the days_since_seed_tier in the input):
- lt_30d: standard re-engagement, no time-gap mention.
- 30d_to_6mo: light gap acknowledgment.
- gt_6mo: explicit gap framing.

STAGE — F1 soft ASK, F2 direct ASK, F3 close-the-loop framing.

ADDRESS the critic feedback specifically. Each issue must be fixed. Each suggestion considered. Do not introduce new issues.

OUTPUT — JSON only:
{
  "subject": "Re: <seed subject>",
  "body": "<plain text body>"
}`;

// ──────────────────────────────────────────────────────────────────────
// User prompt builders
// ──────────────────────────────────────────────────────────────────────

function fmtThread(messages: AntiGhostingThreadMessage[]): string {
  if (messages.length === 0) return "(thread is empty — this should not happen at dispatch time)";
  return messages
    .map((m, i) => {
      const dir = m.direction === "outbound" ? "SENT (you)" : "RECEIVED (prospect)";
      return `[${i + 1}] ${dir} — ${m.sentAt.toISOString().split("T")[0]}\nFrom: ${m.fromName} <${m.fromEmail}>\nSubject: ${m.subject}\n\n${wrapUntrusted("THREAD_MSG", m.body).block}`;
    })
    .join("\n\n---\n\n");
}

function fmtPreviousFollowups(prev: AntiGhostingPreviousFollowup[] | undefined): string {
  if (!prev || prev.length === 0) return "(none yet — this is the first AntiGhosting attempt in this cycle.)";
  return prev
    .map((p) => `STAGE ${p.stage}\nSubject: ${p.subject}\n\n${p.body}`)
    .join("\n\n---\n\n");
}

function stageLabel(stage: number): string {
  if (stage === 1) return "F1 (first re-engagement attempt)";
  if (stage === 2) return "F2 (second attempt)";
  if (stage === 3) return "F3 (third attempt — close the loop)";
  return `F${stage} (continuation of cycle)`;
}

function tierGuidance(tier: DaysSinceSeedTier): string {
  switch (tier) {
    case "lt_30d":
      return "lt_30d: standard re-engagement. Do NOT explicitly acknowledge the time gap — the thread is recent enough that gap framing is unnatural.";
    case "30d_to_6mo":
      return "30d_to_6mo: light gap acknowledgment is appropriate. \"Coming back to this with...\" / \"Picking up where we left off...\" are the right register. No apology.";
    case "gt_6mo":
      return "gt_6mo: explicit gap framing is mandatory. \"I know it's been a while since we last spoke...\" The bridge is MANDATORY at this tier — there must be a credible new reason for reaching out now. If no bridge is naturally available from the thread, output subject \"Re: BRIDGE_REQUIRED\" with an empty body so the operator can be alerted.";
  }
}

function cycleAwareness(cycle: number): string {
  if (cycle === 1) return "This is the first AntiGhosting cycle for this prospect (cycle=1). No prior renewals.";
  return `This is cycle ${cycle} (a renewal). The operator explicitly chose to come back to this thread again after a previous cycle hard-stopped. A soft cycle-awareness in the body is OK — "returning to this with..." or similar — but no meta-acknowledgment of "this is my Nth attempt".`;
}

/**
 * Build the user-message body for the GENERATOR call.
 */
export function getAntiGhostingGeneratorUserPrompt(ctx: AntiGhostingFollowupContext): string {
  const lastInbound = [...ctx.thread_messages].reverse().find((m) => m.direction === "inbound");
  const lastInboundBlock = lastInbound
    ? `LAST INBOUND (what they said before going quiet):\n\n${wrapUntrusted("LAST_INBOUND", lastInbound.body).block}\n\n(sent ${lastInbound.sentAt.toISOString().split("T")[0]})`
    : "LAST INBOUND: (no inbound found in the thread snapshot — this is unexpected for AntiGhosting, validators should have prevented this)";

  return `THREAD CONTEXT:

Sender (the user): ${ctx.sender_name}
Recipient: ${ctx.prospect_name} <${ctx.prospect_email}>${ctx.company ? `\nCompany: ${ctx.company}` : ""}

Seed message (the last outbound that got ghosted):
Subject: ${ctx.seed_subject}

${wrapUntrusted("SEED_EMAIL", ctx.seed_body).block}

Full thread (chronological):

${fmtThread(ctx.thread_messages)}

${lastInboundBlock}

PREVIOUS AntiGhosting attempts THIS cycle:
${fmtPreviousFollowups(ctx.previous_followups)}

PARAMETERS:
- Stage: ${stageLabel(ctx.stage)}
- Cycle: ${ctx.cycle}
- Days since seed: ${ctx.days_since_seed}
- Days-since-seed tier: ${ctx.days_since_seed_tier}
- Original language: ${ctx.original_language}

TIER GUIDANCE:
${tierGuidance(ctx.days_since_seed_tier)}

CYCLE CONTEXT:
${cycleAwareness(ctx.cycle)}

INSTRUCTIONS:
${buildLayoutDirective(
    selectLayoutProfile({
      company: ctx.company,
      prospect_name: ctx.prospect_name,
      original_subject: ctx.seed_subject,
      stage: ctx.stage,
    }),
  )}

Write the AntiGhosting follow-up. ACKNOWLEDGE the last inbound specifically, BRIDGE with a concrete reason, ASK one clear next step. Apply every hard constraint. Output JSON only.`;
}

/**
 * Build the user-message body for the CRITIC call.
 */
export function getAntiGhostingCriticUserPrompt(
  ctx: AntiGhostingFollowupContext,
  draft: { subject: string; body: string },
): string {
  const lastInbound = [...ctx.thread_messages].reverse().find((m) => m.direction === "inbound");
  const lastInboundSummary = lastInbound
    ? `Last inbound (the anchor for ACKNOWLEDGE): ${wrapUntrusted("LAST_INBOUND", lastInbound.body.slice(0, 500)).block}${lastInbound.body.length > 500 ? "..." : ""}`
    : "Last inbound: (none — unexpected)";

  return `THREAD CONTEXT (source of truth — anything not in here is invention):

Seed subject: ${ctx.seed_subject}
${lastInboundSummary}

PARAMETERS:
- Stage: ${ctx.stage}
- Cycle: ${ctx.cycle}
- Days since seed: ${ctx.days_since_seed} (tier: ${ctx.days_since_seed_tier})
- Original language: ${ctx.original_language}

DRAFT TO REVIEW:

Subject: ${draft.subject}

Body:
${draft.body}

Score every dimension, flag every issue, decide. Output JSON only.`;
}

/**
 * Build the user-message body for the REWRITER call.
 */
export function getAntiGhostingRewriterUserPrompt(
  ctx: AntiGhostingFollowupContext,
  draft: { subject: string; body: string },
  critique: { issues: string[]; suggestions: string[] },
): string {
  const lastInbound = [...ctx.thread_messages].reverse().find((m) => m.direction === "inbound");
  const lastInboundBlock = lastInbound
    ? `LAST INBOUND (anchor for ACKNOWLEDGE):\n${wrapUntrusted("LAST_INBOUND", lastInbound.body).block}`
    : "LAST INBOUND: (none — unexpected)";

  return `THREAD CONTEXT:

Seed subject: ${ctx.seed_subject}
Seed body:
${wrapUntrusted("SEED_EMAIL", ctx.seed_body).block}

${lastInboundBlock}

PARAMETERS:
- Stage: ${ctx.stage}
- Cycle: ${ctx.cycle}
- Tier: ${ctx.days_since_seed_tier}
- Language: ${ctx.original_language}

ORIGINAL DRAFT:

Subject: ${draft.subject}

Body:
${draft.body}

CRITIC ISSUES to fix (each must be addressed):
${critique.issues.length > 0 ? critique.issues.map((i) => `- ${i}`).join("\n") : "(none flagged)"}

CRITIC SUGGESTIONS to incorporate:
${critique.suggestions.length > 0 ? critique.suggestions.map((s) => `- ${s}`).join("\n") : "(none)"}

Rewrite the draft addressing every issue. Apply every hard constraint. Output JSON only.`;
}

// ──────────────────────────────────────────────────────────────────────
// Helpers exposed for tests
// ──────────────────────────────────────────────────────────────────────

/**
 * Compute the days-since-seed tone tier. Pure function for test
 * isolation; the scheduler computes this same value at dispatch.
 */
export function computeDaysSinceSeedTier(sentAt: Date, now: Date): DaysSinceSeedTier {
  const diffMs = now.getTime() - sentAt.getTime();
  const days = diffMs / (24 * 60 * 60 * 1000);
  if (days < 30) return "lt_30d";
  if (days < 180) return "30d_to_6mo";
  return "gt_6mo";
}
