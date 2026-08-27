/**
 * B9c.2: AntiGhosting follow-up generator.
 *
 * Mirrors contextFollowupGenerator.ts in shape — writer -> critic -> rewriter,
 * JSON-only output, three-call pipeline with graceful fallbacks on critic or
 * rewriter failure.
 *
 * The AntiGhosting prompts (writer/critic/rewriter) enforce the
 * ACKNOWLEDGE -> BRIDGE -> ASK structure, the forbidden-phrase list,
 * and the tone-tier rules. The critic dimensions and forbidden phrases
 * are specific to re-engagement; otherwise the call shape is identical
 * to the existing flows.
 *
 * Sign-off stripping (B8a) runs as the final step on every return path
 * via finalize(). The deterministic doctrineLint pre-flight (Latin
 * token leaks in non-Latin-script bodies) is wired in identically to
 * the context flow.
 */

// MODEL ROUTING (Aug 2026): every stage runs through the LLM router. This flow
// shares the Context flow's chain, which starts a tier above the doctrine
// flow's — both are exemplar-less, and a cross-language smoke measured the cheap
// writer regressing nativeness where there is no exemplar block to carry it.
// See EXEMPLARLESS_WRITER_CHAIN in lib/modelPolicy.ts.
//
// The writer stages call the router directly rather than through
// services/writerProvider, because this flow tolerates an EMPTY body (some
// re-engagement tiers are subject-only) and the shared draft contract does not.
// F-3.7b: a spent row budget outranks every fail-open path in this file.
import { GenerationDeadlineError } from "../lib/generationDeadline";
import { applyJapaneseRegister, withJapaneseClosing } from "../lib/japaneseRegister";
import { runCriticWithProvider } from "./criticProvider";
import { runLlmJson, SUBJECT_BODY_SCHEMA } from "../lib/llmRouter";
import {
  ANTI_GHOSTING_GENERATOR_SYSTEM,
  ANTI_GHOSTING_CRITIC_SYSTEM,
  ANTI_GHOSTING_REWRITER_SYSTEM,
  getAntiGhostingGeneratorUserPrompt,
  getAntiGhostingCriticUserPrompt,
  getAntiGhostingRewriterUserPrompt,
} from "./antiGhostingFollowupPrompts";
import type { AntiGhostingFollowupContext } from "./antiGhostingFollowupPrompts";
import { logger } from "../lib/logger";
import { detectAllDeterministicViolations } from "../lib/doctrineLint";
import { mergeViolationReports } from "../lib/structuralLint";
// 2026-07-23 deliverability incident: spam-signal linter (follow-up counts,
// trigger lexicon, list formatting). Anti-ghosting is the flow MOST at risk
// of "reached out N times" phrasing — its whole premise is repeated contact.
import { detectSpamRiskViolations } from "../lib/spamRiskLint";
import { stripClosingFromBody } from "./signatureStripper";
// 2026-08-26 layout fix. The seed subject stands in for the thread identity
// here; this context has no original_subject field but seed_subject is
// equally stable per thread, which is all the profile seed needs.
import { shapeFollowupBody, selectLayoutProfile } from "../lib/layoutShaper";
import { scanForInjection, checkOutputIntegrity, UNTRUSTED_DATA_SYSTEM_CLAUSE } from "../lib/promptInjection";

export interface GeneratedAntiGhostingFollowup {
  subject: string;
  body: string;
}

interface AntiGhostingCriticResult {
  scores: Record<string, number>;
  overall: number;
  issues: string[];
  suggestions: string[];
  needs_rewrite: boolean;
}

function normalizeForGrounding(s: string): string {
  return (s || "").toLowerCase().replace(/\s+/g, "");
}
function findUngroundedPercentages(body: string, source: string): string[] {
  const src = normalizeForGrounding(source);
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /\d{1,3}(?:[.,]\d+)?\s*(?:[-\u2013\u2014]\s*\d{1,3}(?:[.,]\d+)?\s*)?%/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const raw = m[0].trim();
    const key = normalizeForGrounding(raw);
    if (seen.has(key)) continue;
    seen.add(key);
    const digits = key.replace("%", "");
    if (src.includes(key) || src.includes(digits + "%")) continue;
    out.push(raw);
  }
  return out;
}

// AG draft writer. Walks the exemplar-less writer chain.
//
// Note the AG-specific output contract: an EMPTY body is legitimate here (some
// re-engagement tiers are subject-only), so this flow cannot use the shared
// runLlmDraft contract check, which requires a non-empty body. It asks the
// router for the raw {subject, body} object and applies its own validation —
// subject required, body merely present.
async function generateAntiGhostingDraft(
  ctx: AntiGhostingFollowupContext,
): Promise<GeneratedAntiGhostingFollowup> {
  const { value } = await runLlmJson<GeneratedAntiGhostingFollowup>({
    role: "ag_draft",
    systemParts: [UNTRUSTED_DATA_SYSTEM_CLAUSE, ANTI_GHOSTING_GENERATOR_SYSTEM],
    user: getAntiGhostingGeneratorUserPrompt(ctx),
    maxOutputTokens: 4096,
    schema: SUBJECT_BODY_SCHEMA,
    usage: { kind: "pipeline", label: "anti_ghosting_generator" },
    prospectName: ctx.prospect_name,
    validate: (parsed) => {
      const p = parsed as { subject?: unknown; body?: unknown };
      if (!p.subject || p.body === undefined) {
        throw new Error("AntiGhosting draft missing subject or body");
      }
      return { subject: String(p.subject), body: String(p.body) };
    },
  });
  return value;
}

// AG rewriter. Same chain as the draft, same empty-body tolerance.
//
// Keeps the caller's old failure semantics: if the chain is exhausted, or none
// of it returns a usable revision, return the ORIGINAL draft rather than
// nothing. A follow-up that skipped one round of polish beats one that never
// sends.
async function rewriteAntiGhostingDraft(
  ctx: AntiGhostingFollowupContext,
  draft: GeneratedAntiGhostingFollowup,
  critique: AntiGhostingCriticResult,
): Promise<GeneratedAntiGhostingFollowup> {
  try {
    const { value } = await runLlmJson<GeneratedAntiGhostingFollowup>({
      role: "ag_rewriter",
      systemParts: [UNTRUSTED_DATA_SYSTEM_CLAUSE, ANTI_GHOSTING_REWRITER_SYSTEM],
      user: getAntiGhostingRewriterUserPrompt(ctx, draft, {
        issues: critique.issues,
        suggestions: critique.suggestions,
      }),
      maxOutputTokens: 4096,
      schema: SUBJECT_BODY_SCHEMA,
      usage: { kind: "pipeline", label: "anti_ghosting_rewriter" },
      prospectName: ctx.prospect_name,
      validate: (parsed) => {
        const p = parsed as { subject?: unknown; body?: unknown };
        if (!p.subject || p.body === undefined) {
          throw new Error("AntiGhosting rewrite missing subject or body");
        }
        return { subject: String(p.subject), body: String(p.body) };
      },
    });
    return value;
  } catch (err) {
    // Same rule as the critic above: a spent budget is terminal for the row.
    if (err instanceof GenerationDeadlineError) throw err;
    logger.warn(
      { err: String(err), stage: ctx.stage, cycle: ctx.cycle },
      "AntiGhosting-rewriter chain exhausted — falling back to the original draft",
    );
    return draft;
  }
}

export async function generateAntiGhostingFollowup(
  ctx: AntiGhostingFollowupContext,
): Promise<GeneratedAntiGhostingFollowup> {
  // B8a sign-off stripper applied as the very last step on every return
  // path. The subject never carries a closing, only the body.
  const finalize = (draft: GeneratedAntiGhostingFollowup): GeneratedAntiGhostingFollowup => {
    const out = {
      subject: draft.subject,
      // applyJapaneseRegister is a no-op for every non-JA language. For Japanese
      // it enforces 弊社/御社 and drops the English salutation comma. See
      // lib/japaneseRegister.ts.
      // The deterministic layer also owns the Japanese ending — one vetted
      // 結びの挨拶 appended after the strip. See JAPANESE_CLOSINGS.
      body: withJapaneseClosing(
        applyJapaneseRegister(
          shapeFollowupBody(stripClosingFromBody(draft.body), {
            profile: selectLayoutProfile({
              company: ctx.company,
              prospect_name: ctx.prospect_name,
              original_subject: ctx.seed_subject,
              stage: ctx.stage,
            }),
            languageTag: ctx.original_language,
          }),
          ctx.original_language,
        ),
        ctx.original_language,
        `${ctx.company}|${ctx.seed_subject}|${ctx.stage}`,
      ),
    };
    const _egress = checkOutputIntegrity(`${out.subject}\n${out.body}`);
    if (_egress.compromised) throw new Error(`Output integrity check failed: ${_egress.reasons.join("; ")}`);
    return out;
  };

  const _inboundText = ctx.thread_messages
    .filter((m) => m.direction === "inbound")
    .map((m) => m.body)
    .join("\n");
  const _inboundScan = scanForInjection(_inboundText);
  if (_inboundScan.suspicious) {
    throw new Error("Injection suspected in inbound thread; not auto-sending");
  }

  const draft = await generateAntiGhostingDraft(ctx);

  // Deterministic pre-flight identical to the context flow. The Latin
  // token leak detector catches multi-word English phrases that slip
  // into non-Latin-script bodies (the Zekri pattern). Universal across
  // all three flows.
  // CB-4 (AG port): a number is grounded only if it appears in the seed email
  // or earlier in the real thread. Anything else is treated as invented.
  // (Computed before the deterministic checks since 2026-07-23 — the spam
  // linter uses the same source for its trigger-grounding exemption.)
  const groundingSource = [
    ctx.seed_subject,
    ctx.seed_body,
    ...ctx.thread_messages.map((m) => m.body),
  ].join("\n");

  const deterministicCheck = mergeViolationReports(
    detectAllDeterministicViolations(draft.body, ctx.original_language),
    detectSpamRiskViolations(draft.body, {
      languageTag: ctx.original_language,
      subject: draft.subject,
      originalText: groundingSource,
    }),
  );
  const ungroundedStats = findUngroundedPercentages(draft.body, groundingSource);

  // CB-1 cost gate: when the deterministic layer flags the draft we already
  // know it needs a rewrite, so we skip the LLM critic call and rewrite
  // directly from the deterministic findings. The LLM critic runs only on a
  // draft that is already deterministically clean. The forbidden-phrase rule
  // is still enforced server-side at send time via deterministic
  // post-checks; the critic is one line of defence and not the only one.
  // CB-4 (AG port): an invented percentage forces a rewrite on the same
  // no-critic path as a deterministic violation. The rewriter receives the
  // stat finding in the same channel as every other issue.
  const statIssue = ungroundedStats.length > 0
    ? `INVENTED STATISTIC: the figure(s) ${ungroundedStats.join(", ")} do not appear in the seed email or earlier in the thread. Remove each one, or replace it with a qualitative proof point about MobUpps quality (incrementality, semi-exclusive supply, durable revenue past the first cycle, measurement transparency). State a number ONLY if that exact number is in the prior conversation.`
    : null;
  const statSuggestions = ungroundedStats.length > 0
    ? [
        "Do not state any percentage or performance figure that is not present in the seed email or the thread.",
        "If the prior conversation has no figure, make the point qualitatively about MobUpps strengths.",
      ]
    : [];

  let critique: AntiGhostingCriticResult;
  if (deterministicCheck.found || ungroundedStats.length > 0) {
    critique = {
      scores: {},
      overall: 2,
      issues: [...(statIssue ? [statIssue] : []), ...deterministicCheck.issues],
      suggestions: [...statSuggestions, ...deterministicCheck.suggestions],
      needs_rewrite: true,
    };
    logger.info(
      { stage: ctx.stage, cycle: ctx.cycle, matches: deterministicCheck.matches.slice(0, 5) },
      "AntiGhosting deterministic violations detected — rewriting without an LLM critic call",
    );
  } else {
    try {
      // Critic runs the shared critic waterfall with the AG flow's own prompts.
      critique = await runCriticWithProvider({
        systemParts: [UNTRUSTED_DATA_SYSTEM_CLAUSE, ANTI_GHOSTING_CRITIC_SYSTEM],
        user: getAntiGhostingCriticUserPrompt(ctx, draft),
        label: "anti_ghosting_critic",
        prospectName: ctx.prospect_name,
      });
    } catch (err) {
      // F-3.7b: a spent row budget is NOT a critic outage. The catch below is
      // deliberately fail-open — a transient critic problem should ship the
      // draft rather than fail the row — but "ship the original draft" on the
      // strength of a DEADLINE would put an un-critiqued email in a client's
      // inbox. The doctrine flow has always rethrown here; these two never did.
      // Closing that gap so all three flows obey the same rule.
      if (err instanceof GenerationDeadlineError) throw err;
      // Critic failure is non-fatal: ship the original draft. The critic is
      // the primary line of defence and not the only one.
      logger.warn({ err }, "AntiGhosting-critic call failed — shipping original draft");
      return finalize(draft);
    }
  }

  logger.info(
    {
      stage: ctx.stage,
      cycle: ctx.cycle,
      tier: ctx.days_since_seed_tier,
      overall: critique.overall,
      scores: critique.scores,
      needs_rewrite: critique.needs_rewrite,
      issuesCount: critique.issues.length,
    },
    "AntiGhosting follow-up critique completed",
  );

  if (!critique.needs_rewrite) {
    return finalize(draft);
  }

  try {
    const rewritten = await rewriteAntiGhostingDraft(ctx, draft, critique);
    logger.info({ stage: ctx.stage, cycle: ctx.cycle }, "AntiGhosting follow-up rewritten after critic feedback");
    return finalize(rewritten);
  } catch (err) {
    // F-3.7b: rewriteAntiGhostingDraft rethrows a spent budget precisely so it
    // can travel — swallowing it here would defeat that guard one frame up.
    if (err instanceof GenerationDeadlineError) throw err;
    logger.warn(
      { err, stage: ctx.stage, cycle: ctx.cycle },
      "AntiGhosting-rewriter failed — shipping original draft",
    );
    return finalize(draft);
  }
}
