import { anthropic, MODEL_DRAFT_GENERATOR, MODEL_CRITIC, MODEL_REWRITER, withOpusReasoning, cachedSystem } from "../lib/anthropic";
import { withAnthropicRetry } from "./anthropicRetry";
// B7r: usage tracker import. recordUsageBestEffort is no-op when called
// outside a runWithUsageContext scope, so safe to call from any path.
import { recordUsageBestEffort } from "../lib/usageTracker";
import type { FollowupContext } from "./followupPrompts";
import {
  getFollowupSystemPrompt,
  getFollowupUserPrompt,
  getCriticSystemPrompt,
  getCriticUserPrompt,
  getRewriterSystemPrompt,
  getRewriterUserPrompt,
} from "./followupPrompts";
import { summaryLooksMeta, resanitizeStoredSummary } from "./emailSummarizer";
import { logger } from "../lib/logger";
import { detectAllDeterministicViolations } from "../lib/doctrineLint";
// B8a: deterministic closing/signature stripper. Belt-and-suspenders
// safety net for the new prompt-level no-closing rule. Runs as the last
// transformation in humanizeText so it cleans every doctrine return path.
import { stripClosingFromBody } from "./signatureStripper";
import { checkOutputIntegrity, UNTRUSTED_DATA_SYSTEM_CLAUSE } from "../lib/promptInjection";
import { runCritic } from "./criticProvider";

export interface GeneratedFollowup {
  subject: string;
  body: string;
}


// followuper-p1: port of prospector v4r6x Patch B (core/brand_localization.py).
// Reverts over-transliterations of universal Latin tech brands back to Latin in
// non-Latin language emails. iOS, Android, etc. are always Latin in B2B media
// across all languages — when the writer over-transliterates them (e.g. Russian
// 'Андроид' / 'АйОС'), this restores them.
//
// Applied UNCONDITIONALLY (no language parameter needed): the source patterns
// only appear in non-Latin scripts, so the map is a no-op on Latin-script bodies.
// Map structure mirrors core/brand_localization._UNIVERSAL_TECH_RESTORE in the
// prospector. Extensible per-language as production observations dictate.
const UNIVERSAL_TECH_RESTORE: Record<string, string> = {
  // Russian (observed in prospector production 2026-05-16 Magnit draft)
  "Андроид": "Android",
  "АйОС": "iOS",
  "АЙОС": "iOS",
  // Korean / Japanese / Chinese / Thai / Arabic: extend on observation.
  // Empty for now — writer-prompt directive (BRAND ADAPTATION) keeps these
  // Latin probabilistically across all languages.
};

function restoreUniversalTechBrands(text: string): string {
  if (!text) return text;
  let result = text;
  for (const [nativeForm, latinForm] of Object.entries(UNIVERSAL_TECH_RESTORE)) {
    if (result.includes(nativeForm)) {
      result = result.split(nativeForm).join(latinForm);
    }
  }
  return result;
}

function humanizeText(text: string): string {
  let result = text;
  // followuper-p1: revert universal Latin tech brand over-transliterations FIRST,
  // before the existing humanize passes — the rest of humanizeText assumes Latin
  // brand names won't be wrapped inside e.g. Cyrillic transliteration.
  result = restoreUniversalTechBrands(result);
  result = result.replace(/\s*—\s*/g, " - ");
  result = result.replace(/\s*–\s*/g, " - ");
  result = result.replace(/[""\u201C\u201D]/g, '"');
  result = result.replace(/[''‛\u2018\u2019]/g, "'");
  result = result.replace(/…/g, "...");
  result = result.replace(/\u00A0/g, " ");
  result = result.replace(/\u200B/g, "");
  const aiPhrases = [
    /\bI'd love to\b/gi,
    /\bI wanted to reach out\b/gi,
    /\bI hope this (?:email )?finds you well\b/gi,
    /\bI hope you're doing well\b/gi,
    /\bI trust this (?:email )?finds you well\b/gi,
    /\bdelve(?:s|d)?\b/gi,
    /\bleverage(?:s|d)?\b/gi,
    /\bin today's (?:rapidly )?(?:evolving|changing) (?:landscape|world)\b/gi,
    /\bIt's worth noting that\b/gi,
    /\bIt bears mentioning that\b/gi,
    /\bNavigate the (?:complexities|landscape)\b/gi,
    /\bseamless(?:ly)?\b/gi,
    /\bsynerg(?:y|ies|ize)\b/gi,
    /\bholistic(?:ally)?\b/gi,
    /\bgame[\s-]?changer\b/gi,
    /\bunlock(?:ing)? (?:the )?(?:full )?potential\b/gi,
  ];
  for (const pattern of aiPhrases) {
    result = result.replace(pattern, (match) => {
      const replacements: Record<string, string> = {
        "delve": "dig",
        "delves": "digs",
        "delved": "dug",
        "leverage": "use",
        "leverages": "uses",
        "leveraged": "used",
        "seamlessly": "smoothly",
        "seamless": "smooth",
        "holistically": "broadly",
        "holistic": "broad",
      };
      const lower = match.toLowerCase();
      if (replacements[lower]) return replacements[lower];
      return "";
    });
  }
  result = result.replace(/ {2,}/g, " ");
  result = result.replace(/^\s+/gm, (m) => m);
  result = result.trim();
  return result;
}

function humanizeFollowup(followup: GeneratedFollowup): GeneratedFollowup {
  // B8a: strip the closing/signature lines from the body AFTER the
  // humanize passes. Order matters — humanizeText normalises em
  // dashes and quotes first, then the closing stripper operates on
  // the canonicalised line shape. The subject never carries a
  // closing, so it is humanized only.
  const humanizedBody = humanizeText(followup.body);
  const result = {
    subject: humanizeText(followup.subject),
    body: stripClosingFromBody(humanizedBody),
  };
  const _egress = checkOutputIntegrity(`${result.subject}\n${result.body}`);
  if (_egress.compromised) {
    throw new Error(`Output integrity check failed: ${_egress.reasons.join("; ")}`);
  }
  return result;
}

const META_VERBS = [
  "citing", "referencing", "mentioning", "highlighting", "noting",
  "emphasizing", "claiming", "stating", "explaining", "pitched",
  "proposed", "offered", "outlining", "outlined", "describing",
  "described", "presenting", "presented", "indicating", "demonstrating",
  "suggesting", "arguing",
];

// CB-4: numbers must be grounded in the source. The writer is forbidden
// from inventing statistics. This finds percentage figures in the draft
// that do not appear in the original email or provided context, so the
// rewriter removes them or swaps in a qualitative MobUpps proof point.
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

function detectMetaLanguage(text: string): { found: boolean; matches: string[] } {
  const matches: string[] = [];
  const lower = text.toLowerCase();

  for (const verb of META_VERBS) {
    const re = new RegExp(`\\b${verb}\\b\\s+(?:the |a |an |our |their |its |competitor|industry|market|case|conversion|growth|benchmarks?|examples?|trends?|metrics?|data|insights?|platforms?|services?|results?|wins?|partnerships?|ability)`, "gi");
    const found = text.match(re);
    if (found) matches.push(...found);
  }

  // "claiming the ability to [verb]" — exact pattern from the Alibaba email.
  const abilityRe = /\b(?:claiming|stating|offering|promising)\s+the\s+ability\s+to\s+\w+/gi;
  const abilityFound = text.match(abilityRe);
  if (abilityFound) matches.push(...abilityFound);

  // "the ability to drive/generate/deliver X" used as a capability claim
  // (even without a preceding meta-verb, this is meta-speak about what the
  // email is offering rather than a concrete statement to the prospect).
  const bareAbility = /\bthe\s+ability\s+to\s+(?:drive|generate|deliver|provide|produce|achieve|create)\s+[a-z][^,.!?]{0,60}/gi;
  const bareAbilityFound = text.match(bareAbility);
  if (bareAbilityFound) matches.push(...bareAbilityFound);

  const asPatterns = [
    /\bas\s+(?:urgency|social proof|a benchmark|an example|context|reference|justification|proof|validation|a hook|a reason)\b/gi,
    /\b(?:by|via|through)\s+(?:citing|referencing|mentioning|highlighting|noting)\b/gi,
  ];
  for (const re of asPatterns) {
    const found = text.match(re);
    if (found) matches.push(...found);
  }

  const ingClauseChain = text.match(/,\s*\w+ing\s+[^,.!?]{8,}/g) || [];
  const suspicious = ingClauseChain.filter((clause) => {
    const c = clause.toLowerCase();
    return META_VERBS.some((v) => c.includes(v));
  });
  matches.push(...suspicious);

  if (lower.includes("following up on") || lower.includes("follow up on") || lower.includes("circling back")) {
    const refMatch = text.match(/(?:following up on|circling back on)\s+[^.!?\n]{0,300}/i);
    if (refMatch) {
      const reference = refMatch[0].toLowerCase();
      const hasMetaInRef = META_VERBS.some((v) =>
        new RegExp(`\\b${v}\\b`, "i").test(reference)
      );
      const hasAbilityInRef = /\bthe\s+ability\s+to\s+\w+/i.test(reference);
      if (hasMetaInRef || hasAbilityInRef) {
        matches.push(`Reference contains meta-language: "${refMatch[0].slice(0, 100)}..."`);
      }
    }
  }

  return { found: matches.length > 0, matches: Array.from(new Set(matches)).slice(0, 5) };
}

function unescapeJsonString(s: string): string {
  return s
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

function parseJsonResponse(text: string): any {
  let raw = text.replace(/```json\s*|```/g, "").trim();

  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    raw = raw.slice(firstBrace, lastBrace + 1);
  }

  try {
    return JSON.parse(raw);
  } catch {
    const subjectMatch = raw.match(/"subject"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    const bodyMatch = raw.match(/"body"\s*:\s*"((?:[^"\\]|\\[\s\S])*)"\s*\}$/s);
    if (subjectMatch && bodyMatch) {
      return {
        subject: unescapeJsonString(subjectMatch[1]),
        body: unescapeJsonString(bodyMatch[1]),
      };
    }
    throw new SyntaxError(`Failed to parse AI response as JSON: ${raw.slice(0, 200)}...`);
  }
}

async function generateDraft(ctx: FollowupContext, attempt = 1): Promise<GeneratedFollowup> {
  const maxAttempts = 2;
  const response = await withAnthropicRetry(
    () => anthropic.messages.create({
      model: MODEL_DRAFT_GENERATOR,
      max_tokens: 8192,
      system: cachedSystem(UNTRUSTED_DATA_SYSTEM_CLAUSE, getFollowupSystemPrompt()),
      messages: [{ role: "user", content: getFollowupUserPrompt(ctx) }],
    }),
    { label: "draft" },
  );
  // B7r: capture token usage for the activity log. Fire-and-forget.
  void recordUsageBestEffort(response, "draft");

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text in draft response");
  }

  try {
    const parsed = parseJsonResponse(textBlock.text);
    if (!parsed.subject || !parsed.body) {
      throw new Error("Draft missing subject or body");
    }
    return { subject: parsed.subject, body: parsed.body };
  } catch (err) {
    logger.warn({ attempt, rawPreview: textBlock.text.slice(0, 300) }, "Draft JSON parse failed");
    if (attempt < maxAttempts) {
      logger.info("Retrying draft generation...");
      return generateDraft(ctx, attempt + 1);
    }
    throw err;
  }
}

export interface CriticResult {
  scores: Record<string, number>;
  overall: number;
  issues: string[];
  suggestions: string[];
  needs_rewrite: boolean;
}

async function critiqueDraft(
  ctx: FollowupContext,
  draft: GeneratedFollowup,
): Promise<CriticResult> {
  const response = await withAnthropicRetry(
    // Opus 4.8 critic: adaptive thinking on high effort. max_tokens raised
    // to 16000 so thinking plus the JSON verdict never truncates.
    () => anthropic.messages.create(withOpusReasoning({
      model: MODEL_CRITIC,
      max_tokens: 16000,
      system: cachedSystem(UNTRUSTED_DATA_SYSTEM_CLAUSE, getCriticSystemPrompt()),
      messages: [{ role: "user", content: getCriticUserPrompt(ctx, draft) }],
    })),
    { label: "critic" },
  );
  // B7r: capture token usage for the activity log.
  void recordUsageBestEffort(response, "critic");

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text in critic response");
  }

  const parsed = parseJsonResponse(textBlock.text);
  return {
    scores: parsed.scores || {},
    overall: parsed.overall || 5,
    issues: parsed.issues || [],
    suggestions: parsed.suggestions || [],
    needs_rewrite: parsed.needs_rewrite ?? false,
  };
}

async function rewriteDraft(
  ctx: FollowupContext,
  draft: GeneratedFollowup,
  critique: CriticResult,
): Promise<GeneratedFollowup> {
  const response = await withAnthropicRetry(
    () => anthropic.messages.create({
      model: MODEL_REWRITER,
      max_tokens: 8192,
      system: cachedSystem(UNTRUSTED_DATA_SYSTEM_CLAUSE, getRewriterSystemPrompt()),
      messages: [{
        role: "user",
        content: getRewriterUserPrompt(ctx, draft, {
          issues: critique.issues,
          suggestions: critique.suggestions,
        }),
      }],
    }),
    { label: "rewriter" },
  );
  // B7r: capture token usage for the activity log.
  void recordUsageBestEffort(response, "rewriter");

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text in rewriter response");
  }

  const parsed = parseJsonResponse(textBlock.text);
  if (!parsed.subject || !parsed.body) {
    throw new Error("Rewrite missing subject or body");
  }

  return { subject: parsed.subject, body: parsed.body };
}

export async function generateFollowupEmail(
  ctx: FollowupContext,
): Promise<GeneratedFollowup> {
  // Self-heal: sanitize the stored summary before it reaches any LLM prompt.
  // Older rows may contain meta-language ("Pitched X, citing Y, as urgency").
  if (ctx.original_body_summary && summaryLooksMeta(ctx.original_body_summary)) {
    const cleaned = resanitizeStoredSummary(ctx.original_body_summary);
    logger.info(
      {
        prospect: ctx.prospect_name,
        before: ctx.original_body_summary.slice(0, 100),
        after: cleaned.slice(0, 100),
        stillMeta: summaryLooksMeta(cleaned),
      },
      "Self-healed meta-contaminated original_body_summary before generation",
    );
    ctx = {
      ...ctx,
      original_body_summary: summaryLooksMeta(cleaned) ? "" : cleaned,
    };
  }

  logger.info(
    { prospect: ctx.prospect_name, stage: ctx.stage, previousFollowups: ctx.previous_followups?.length || 0 },
    "Step 1: Generating initial draft (Sonnet 4.6)",
  );

  // Step 1: Draft.
  // If this throws after all retries, we let it bubble up — the scheduler marks
  // the follow-up as failed and surfaces the error in the UI. We do NOT fall
  // back to a hardcoded multilingual template; the template was (a) incomplete
  // across global languages, (b) glued raw summary paragraphs into template
  // sentences, and (c) masked upstream outages by silently degrading quality.
  const draft = await generateDraft(ctx);

  // CB-4: the only facts the follow-up may cite are those already in the
  // original outreach. A number absent from this source is treated as
  // invented and is stripped or grounded by the rewrite below.
  const groundingSource = [
    ctx.original_subject,
    ctx.original_body,
    ctx.original_body_summary,
  ].join("\n");

  let current = draft;
  let best = draft;
  let bestOverall = 0;
  const maxHealingIterations = 2;

  for (let iteration = 1; iteration <= maxHealingIterations; iteration++) {
    const metaCheck = detectMetaLanguage(current.body);
    const deterministicCheck = detectAllDeterministicViolations(current.body, ctx.original_language);
    const ungroundedStats = findUngroundedPercentages(current.body, groundingSource);

    logger.info(
      { prospect: ctx.prospect_name, iteration, metaFound: metaCheck.found, metaMatches: metaCheck.matches },
      `Iteration ${iteration}: Critiquing draft (Opus 4.7)`,
    );

    // If the critic itself fails after retries, we don't abandon — we return
    // the best draft we've seen so far. A real LLM draft beats any template.
    //
    // CB-1 cost gate: when the deterministic layer (meta-language or the
    // doctrine and nativeness checks) already flags the draft, we know it
    // needs a rewrite, so we skip the Opus critic call this iteration and
    // build the critique from the deterministic findings merged in below.
    // The Opus critic runs only on a draft that is already deterministically
    // clean, which is where its subjective judgment adds value the free
    // checks cannot. The hallucination and doctrine guards are unchanged;
    // only the timing of the critic call changes.
    let critique: CriticResult;
    if (metaCheck.found || deterministicCheck.found || ungroundedStats.length > 0) {
      critique = { scores: {}, overall: 2, issues: [], suggestions: [], needs_rewrite: true };
      logger.info(
        { prospect: ctx.prospect_name, iteration },
        `Iteration ${iteration}: deterministic checks flagged the draft, rewriting without an Opus critic call`,
      );
    } else {
      try {
        critique = await runCritic(ctx, current, () => critiqueDraft(ctx, current));
      } catch (err) {
        logger.warn(
          { err: String(err), prospect: ctx.prospect_name, iteration },
          "Critic unavailable after retries — returning best draft seen",
        );
        return humanizeFollowup(best);
      }
    }

    if (metaCheck.found) {
      const metaIssue = `META-LANGUAGE DETECTED — the email is describing what it does instead of writing literal content. Offending phrases: ${metaCheck.matches.join(" | ")}. You MUST rewrite to use concrete, literal statements (real numbers, real competitor names, real outcomes), not descriptions of email tactics.`;
      critique.issues = [metaIssue, ...critique.issues];
      critique.suggestions = [
        "Replace every -ing meta-verb (citing, referencing, mentioning, highlighting, claiming, pitched) with the actual concrete fact.",
        "If you would write 'citing competitor growth', instead name the competitor and what they did with a specific number.",
        "If you would write 'referencing benchmarks', instead state the actual benchmark figure.",
        "The follow-up reference must use a short topic name, e.g., 'Following up on my note about the Malaysia affiliate program', NOT a description of the original email's tactics.",
        ...critique.suggestions,
      ];
      critique.needs_rewrite = true;
      critique.overall = Math.min(critique.overall, 2);
    }

    if (deterministicCheck.found) {
      // Prepend deterministic doctrine + nativeness issues into the LLM
      // critique so the rewriter receives them in the same channel as
      // every other issue. Same pattern as the meta-language merge above.
      critique.issues = [...deterministicCheck.issues, ...critique.issues];
      critique.suggestions = [...deterministicCheck.suggestions, ...critique.suggestions];
      critique.needs_rewrite = true;
      critique.overall = Math.min(critique.overall, 2);
      logger.info(
        { prospect: ctx.prospect_name, iteration, matches: deterministicCheck.matches.slice(0, 5) },
        "Deterministic doctrine/nativeness violations detected — merging into critique",
      );
    }

    if (ungroundedStats.length > 0) {
      const statIssue = `INVENTED STATISTIC: the figure(s) ${ungroundedStats.join(", ")} do not appear in the original email or context. Remove each one, or replace it with a qualitative proof point about MobUpps quality (incrementality, semi-exclusive supply, durable revenue past the first cycle, measurement transparency). State a number ONLY if that exact number is in the original email.`;
      critique.issues = [statIssue, ...critique.issues];
      critique.suggestions = [
        "Do not state any percentage or performance figure that is not present in the original email.",
        "If the original email has no figure, make the point qualitatively about MobUpps strengths.",
        ...critique.suggestions,
      ];
      critique.needs_rewrite = true;
      critique.overall = Math.min(critique.overall, 2);
      logger.info(
        { prospect: ctx.prospect_name, iteration, ungroundedStats },
        "CB-4: invented statistic detected, merging into critique",
      );
    }

    // Track the best draft we've seen so we always have something to return
    // even if later iterations regress or fail.
    if (critique.overall > bestOverall) {
      best = current;
      bestOverall = critique.overall;
    }

    logger.info(
      { prospect: ctx.prospect_name, iteration, overall: critique.overall, needsRewrite: critique.needs_rewrite, issues: critique.issues.slice(0, 3) },
      "Critic evaluation complete",
    );

    if (!critique.needs_rewrite) {
      logger.info({ prospect: ctx.prospect_name, iteration }, "Draft passed all checks");
      return humanizeFollowup(current);
    }

    logger.info(
      { prospect: ctx.prospect_name, iteration },
      `Iteration ${iteration}: Rewriting draft (Sonnet 4.6)`,
    );

    try {
      current = await rewriteDraft(ctx, current, critique);
      logger.info({ prospect: ctx.prospect_name, iteration }, "Rewrite complete");
    } catch (err) {
      logger.warn(
        { err: String(err), prospect: ctx.prospect_name, iteration },
        "Rewriter unavailable after retries — returning best draft seen",
      );
      return humanizeFollowup(best);
    }
  }

  // Healing iterations exhausted. Return the highest-scoring draft we saw.
  // This IS real LLM output in the correct language — just possibly with one
  // or two minor critic nits unresolved. Much better than any template.
  logger.info(
    { prospect: ctx.prospect_name, bestOverall, iterations: maxHealingIterations },
    "Healing iterations exhausted — returning best draft seen",
  );
  return humanizeFollowup(best);
}
