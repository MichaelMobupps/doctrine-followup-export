import { anthropic } from "@workspace/integrations-anthropic-ai";
import type { FollowupContext } from "./followupPrompts";
import {
  getFollowupSystemPrompt,
  getFollowupUserPrompt,
  getCriticSystemPrompt,
  getCriticUserPrompt,
  getRewriterSystemPrompt,
  getRewriterUserPrompt,
} from "./followupPrompts";
import { logger } from "../lib/logger";

export interface GeneratedFollowup {
  subject: string;
  body: string;
}

function firstToken(value: string): string {
  return value.trim().split(/\s+/)[0] || value.trim() || "there";
}

type FallbackTemplate = {
  greeting: string;
  noSummary: string;
  withSummaryPrefix: string;
  stage1: string;
  stage2: (company: string) => string;
  stage3: string;
  cta: string;
};

const FALLBACK_TEMPLATES: Record<string, FallbackTemplate> = {
  en: {
    greeting: "Hi",
    noSummary: "Following up on my previous email.",
    withSummaryPrefix: "Following up on my previous email about",
    stage1: "Happy to share a quick example if useful.",
    stage2: (company) => `I thought it could still be relevant for ${company}.`,
    stage3: "If timing is not right, no worries - just let me know.",
    cta: "Would it make sense to reconnect on this?",
  },
  de: {
    greeting: "Hallo",
    noSummary: "Ich mochte auf meine vorherige E-Mail zuruckkommen.",
    withSummaryPrefix: "Ich mochte auf meine vorherige E-Mail zu folgendem Thema zuruckkommen",
    stage1: "Gern teile ich bei Bedarf ein kurzes Beispiel.",
    stage2: (company) => `Ich dachte, das konnte fur ${company} weiterhin relevant sein.`,
    stage3: "Falls der Zeitpunkt gerade nicht passt, ist das auch kein Problem - geben Sie mir einfach kurz Bescheid.",
    cta: "Ware ein kurzes Nachfassen dazu sinnvoll?",
  },
  fr: {
    greeting: "Bonjour",
    noSummary: "Je reviens sur mon precedent email.",
    withSummaryPrefix: "Je reviens sur mon precedent email au sujet de",
    stage1: "Je peux partager un exemple rapide si utile.",
    stage2: (company) => `Je pensais que cela pouvait encore etre pertinent pour ${company}.`,
    stage3: "Si le timing n'est pas ideal, aucun souci - dites-le-moi simplement.",
    cta: "Est-ce que cela vaudrait la peine d'en reparler ?",
  },
  es: {
    greeting: "Hola",
    noSummary: "Queria retomar mi correo anterior.",
    withSummaryPrefix: "Queria retomar mi correo anterior sobre",
    stage1: "Puedo compartir un ejemplo breve si te sirve.",
    stage2: (company) => `Pense que esto podria seguir siendo relevante para ${company}.`,
    stage3: "Si no es el momento adecuado, no pasa nada - avisame.",
    cta: "Te haria sentido retomarlo?",
  },
  pt: {
    greeting: "Ola",
    noSummary: "Queria retomar meu email anterior.",
    withSummaryPrefix: "Queria retomar meu email anterior sobre",
    stage1: "Posso compartilhar um exemplo rapido se for util.",
    stage2: (company) => `Achei que isso ainda poderia ser relevante para ${company}.`,
    stage3: "Se o momento nao for ideal, sem problema - e so me avisar.",
    cta: "Faz sentido retomarmos isso?",
  },
  it: {
    greeting: "Ciao",
    noSummary: "Volevo riprendere la mia email precedente.",
    withSummaryPrefix: "Volevo riprendere la mia email precedente su",
    stage1: "Posso condividere un esempio rapido se puo essere utile.",
    stage2: (company) => `Pensavo potesse essere ancora rilevante per ${company}.`,
    stage3: "Se non e il momento giusto, nessun problema - fammelo sapere.",
    cta: "Ha senso riparlarne?",
  },
  nl: {
    greeting: "Hoi",
    noSummary: "Ik wilde even terugkomen op mijn vorige e-mail.",
    withSummaryPrefix: "Ik wilde even terugkomen op mijn vorige e-mail over",
    stage1: "Ik deel graag een kort voorbeeld als dat nuttig is.",
    stage2: (company) => `Ik dacht dat dit nog steeds relevant kon zijn voor ${company}.`,
    stage3: "Als de timing niet goed is, geen probleem - laat het gerust weten.",
    cta: "Heeft het zin om dit opnieuw op te pakken?",
  },
  tr: {
    greeting: "Merhaba",
    noSummary: "Onceki e-postama tekrar donmek istedim.",
    withSummaryPrefix: "Onceki e-postamda bahsettigim konuya tekrar donmek istedim",
    stage1: "Isterseniz kisa bir ornek paylasabilirim.",
    stage2: (company) => `Bunun ${company} icin hala ilgili olabilecegini dusundum.`,
    stage3: "Zamanlama uygun degilse sorun degil - bana kisaca haber vermeniz yeterli.",
    cta: "Bunu yeniden konusmak mantikli olur mu?",
  },
  ru: {
    greeting: "Привет",
    noSummary: "Хотел вернуться к моему предыдущему письму.",
    withSummaryPrefix: "Хотел вернуться к моему предыдущему письму о",
    stage1: "Могу коротко поделиться примером, если это полезно.",
    stage2: (company) => `Мне показалось, что это все еще может быть актуально для ${company}.`,
    stage3: "Если сейчас время не подходит, все в порядке - просто дайте знать.",
    cta: "Есть смысл коротко вернуться к этому вопросу?",
  },
  he: {
    greeting: "היי",
    noSummary: "רציתי לחזור למייל הקודם שלי.",
    withSummaryPrefix: "רציתי לחזור למייל הקודם שלי לגבי",
    stage1: "אשמח לשתף דוגמה קצרה אם זה יעזור.",
    stage2: (company) => `חשבתי שזה עדיין יכול להיות רלוונטי עבור ${company}.`,
    stage3: "אם התזמון לא מתאים עכשיו, זה גם בסדר - רק תגיד לי.",
    cta: "נראה לך שיש טעם לחזור לזה?",
  },
  ar: {
    greeting: "مرحبا",
    noSummary: "اردت المتابعة بخصوص رسالتي السابقة.",
    withSummaryPrefix: "اردت المتابعة بخصوص رسالتي السابقة حول",
    stage1: "يمكنني مشاركة مثال سريع إذا كان ذلك مفيدا.",
    stage2: (company) => `اعتقدت أن هذا قد يبقى ذا صلة بالنسبة إلى ${company}.`,
    stage3: "إذا لم يكن التوقيت مناسبا الآن فلا مشكلة، فقط أخبرني.",
    cta: "هل من المناسب أن نعود لهذا الموضوع؟",
  },
  ja: {
    greeting: "こんにちは",
    noSummary: "前回のメールについてご連絡しました。",
    withSummaryPrefix: "前回のメールで触れた",
    stage1: "必要であれば簡単な事例も共有できます。",
    stage2: (company) => `${company} にとって今でも関連があるかと思いました。`,
    stage3: "もし今はタイミングが違うようでしたら、その旨だけ教えてください。",
    cta: "もう一度だけ軽くお話しできそうでしょうか。",
  },
  ko: {
    greeting: "안녕하세요",
    noSummary: "이전 메일에 이어 다시 연락드립니다.",
    withSummaryPrefix: "이전 메일에서 말씀드린",
    stage1: "원하시면 짧은 사례도 공유드릴 수 있습니다.",
    stage2: (company) => `이 내용이 아직도 ${company}에 의미가 있을 수 있다고 생각했습니다.`,
    stage3: "지금 타이밍이 아니어도 괜찮습니다. 편하게 알려주세요.",
    cta: "이 내용을 다시 짧게 이야기해볼 수 있을까요?",
  },
  zh: {
    greeting: "你好",
    noSummary: "我想跟进一下之前的邮件。",
    withSummaryPrefix: "我想跟进一下之前邮件里提到的",
    stage1: "如果有帮助，我也可以分享一个简短的案例。",
    stage2: (company) => `我觉得这对 ${company} 现在可能仍然有参考价值。`,
    stage3: "如果现在时机不合适也没关系，直接告诉我就好。",
    cta: "要不要找个时间再简单聊一下？",
  },
  th: {
    greeting: "สวัสดี",
    noSummary: "ผม/ฉันขอติดตามอีเมลก่อนหน้านี้ครับ/ค่ะ",
    withSummaryPrefix: "ผม/ฉันขอติดตามอีเมลก่อนหน้านี้เกี่ยวกับ",
    stage1: "หากเป็นประโยชน์ ผม/ฉันสามารถส่งตัวอย่างสั้นๆ ให้ได้ครับ/ค่ะ",
    stage2: (company) => `ผม/ฉันคิดว่าสิ่งนี้ยังอาจเกี่ยวข้องกับ ${company} ได้อยู่ครับ/ค่ะ`,
    stage3: "ถ้าตอนนี้ยังไม่ใช่จังหวะก็ไม่เป็นไร แจ้งผม/ฉันได้เลยครับ/ค่ะ",
    cta: "พอจะสะดวกกลับมาคุยเรื่องนี้สั้นๆ ไหมครับ/ค่ะ",
  },
  vi: {
    greeting: "Chao",
    noSummary: "Minh muon theo lai email truoc do.",
    withSummaryPrefix: "Minh muon theo lai email truoc do ve",
    stage1: "Neu huu ich, minh co the gui mot vi du ngan.",
    stage2: (company) => `Minh nghi dieu nay van co the phu hop voi ${company}.`,
    stage3: "Neu hien tai chua dung thoi diem thi cung khong sao - ban cu cho minh biet.",
    cta: "Ban thay co hop de minh noi tiep ve viec nay khong?",
  },
};

function buildFallbackFollowup(ctx: FollowupContext): GeneratedFollowup {
  const template = FALLBACK_TEMPLATES[ctx.original_language] || FALLBACK_TEMPLATES.en;
  const prospectFirstName = firstToken(ctx.prospect_name || "there");
  const senderFirstName = firstToken(ctx.sender_name || "Team");
  const subject = ctx.original_subject.startsWith("Re:")
    ? ctx.original_subject
    : `Re: ${ctx.original_subject}`;

  const summary = ctx.original_body_summary.replace(/\s+/g, " ").trim();
  const referenceLine = summary
    ? `${template.withSummaryPrefix} ${summary}.`
    : template.noSummary;

  let angleLine = template.stage1;
  if (ctx.stage === 2) {
    angleLine = template.stage2(ctx.company);
  } else if (ctx.stage >= 3) {
    angleLine = template.stage3;
  }

  return {
    subject,
    body: `${template.greeting} ${prospectFirstName},\n\n${referenceLine} ${angleLine} ${template.cta}\n\n${senderFirstName}`,
  };
}

function humanizeText(text: string): string {
  let result = text;
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
  return {
    subject: humanizeText(followup.subject),
    body: humanizeText(followup.body),
  };
}

const META_VERBS = [
  "citing", "referencing", "mentioning", "highlighting", "noting",
  "emphasizing", "claiming", "stating", "explaining", "pitched",
  "proposed", "offered", "outlining", "outlined", "describing",
  "described", "presenting", "presented", "indicating", "demonstrating",
];

function detectMetaLanguage(text: string): { found: boolean; matches: string[] } {
  const matches: string[] = [];
  const lower = text.toLowerCase();

  for (const verb of META_VERBS) {
    const re = new RegExp(`\\b${verb}\\b\\s+(?:the |a |an |our |their |its |competitor|industry|market|case|conversion|growth|benchmarks?|examples?|trends?|metrics?|data|insights?|platforms?|services?|results?|wins?|partnerships?)`, "gi");
    const found = text.match(re);
    if (found) matches.push(...found);
  }

  const asPatterns = [
    /\bas\s+(?:urgency|social proof|a benchmark|an example|context|reference|justification)\b/gi,
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
      if (hasMetaInRef) {
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
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 8192,
    system: getFollowupSystemPrompt(),
    messages: [{ role: "user", content: getFollowupUserPrompt(ctx) }],
  });

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

interface CriticResult {
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
  const response = await anthropic.messages.create({
    model: "claude-opus-4-7",
    max_tokens: 8192,
    system: getCriticSystemPrompt(),
    messages: [{ role: "user", content: getCriticUserPrompt(ctx, draft) }],
  });

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
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 8192,
    system: getRewriterSystemPrompt(),
    messages: [{
      role: "user",
      content: getRewriterUserPrompt(ctx, draft, {
        issues: critique.issues,
        suggestions: critique.suggestions,
      }),
    }],
  });

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
  logger.info(
    { prospect: ctx.prospect_name, stage: ctx.stage, previousFollowups: ctx.previous_followups?.length || 0 },
    "Step 1: Generating initial draft (Sonnet 4.6)",
  );
  let draft: GeneratedFollowup;
  try {
    draft = await generateDraft(ctx);
  } catch (err) {
    logger.warn({ err, prospect: ctx.prospect_name, stage: ctx.stage }, "Draft generation failed, using fallback follow-up");
    return humanizeFollowup(buildFallbackFollowup(ctx));
  }

  let current = draft;
  const maxHealingIterations = 3;

  for (let iteration = 1; iteration <= maxHealingIterations; iteration++) {
    const metaCheck = detectMetaLanguage(current.body);

    logger.info(
      { prospect: ctx.prospect_name, iteration, metaFound: metaCheck.found, metaMatches: metaCheck.matches },
      `Iteration ${iteration}: Critiquing draft (Opus 4.7)`,
    );

    let critique: CriticResult;
    try {
      critique = await critiqueDraft(ctx, current);
    } catch (err) {
      logger.warn({ err, prospect: ctx.prospect_name, iteration }, "Critic failed, using current draft");
      return humanizeFollowup(current);
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

    logger.info(
      { prospect: ctx.prospect_name, iteration, overall: critique.overall, needsRewrite: critique.needs_rewrite, issues: critique.issues.slice(0, 3) },
      "Critic evaluation complete",
    );

    if (!critique.needs_rewrite) {
      logger.info({ prospect: ctx.prospect_name, iteration }, "Draft passed all checks");
      const humanized = humanizeFollowup(current);
      return humanized;
    }

    logger.info(
      { prospect: ctx.prospect_name, iteration },
      `Iteration ${iteration}: Rewriting draft (Sonnet 4.6)`,
    );

    try {
      current = await rewriteDraft(ctx, current, critique);
      logger.info({ prospect: ctx.prospect_name, iteration }, "Rewrite complete");
    } catch (err) {
      logger.warn({ err, prospect: ctx.prospect_name, iteration }, "Rewriter failed, returning current draft");
      return humanizeFollowup(current);
    }
  }

  const finalCheck = detectMetaLanguage(current.body);
  if (finalCheck.found) {
    logger.warn(
      { prospect: ctx.prospect_name, matches: finalCheck.matches },
      "Meta-language still present after max healing iterations — falling back to template",
    );
    return humanizeFollowup(buildFallbackFollowup(ctx));
  }

  logger.info({ prospect: ctx.prospect_name }, `Final draft accepted after ${maxHealingIterations} iterations`);
  return humanizeFollowup(current);
}
