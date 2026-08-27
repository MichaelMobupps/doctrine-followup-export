/**
 * smoke-summarizer-cheap.ts — validate the summarizer chain's PRIMARY and its
 * FALLBACK tier across languages.
 *
 * summarizeOriginalEmail feeds two things into every downstream follow-up:
 *   - language: sets prospects.original_language, which drives exemplar
 *     selection AND the language the follow-up is written in. A wrong code is a
 *     severe failure (wrong-language email), so language-detection accuracy is
 *     the primary metric here.
 *   - summary: a short topic noun phrase used as context. Heavily sanitized
 *     downstream, so the bar is: non-empty and not meta-language.
 *
 * Aug 2026: this used to compare the cheap Gemini summarizer against a
 * SUMMARIZER_PROVIDER=anthropic Sonnet baseline. That switch no longer exists —
 * the summarizer runs a Gemini/OpenAI waterfall (lib/modelPolicy.ts) and
 * Anthropic is disabled — and for a while after the migration this smoke kept
 * setting the dead env var, which made both arms run the identical config and
 * the "comparison" pass vacuously. A smoke that cannot fail is worse than none.
 *
 * It now compares what actually exists and actually carries risk:
 *   primary  = the live summarizer chain as production runs it (tier 1 serving)
 *   fallback = LLM_CHAIN_SUMMARIZER forced to the chain's cross-vendor tier,
 *              i.e. what production silently degrades to when Gemini is at
 *              capacity. If THAT tier misdetects languages, a Gemini outage
 *              quietly produces wrong-language follow-ups — exactly the failure
 *              this smoke exists to catch before it ships.
 *
 * RUN (from artifacts/api-server):
 *   node --import tsx src/scripts/smoke-summarizer-cheap.ts
 *
 * Exit codes: 0 the fallback tier holds language accuracy (within 1 miss of the
 * primary) and no errors; 1 the fallback is materially worse or a hard error.
 */
import { summarizeOriginalEmail, summaryLooksMeta } from "../services/emailSummarizer";
import { __setLedgerSuppressedForOfflineRuns } from "../lib/usageTracker";
import { isGeminiConfigured } from "../lib/gemini";
import { isOpenAiConfigured } from "../lib/openai";
import { getChain, describeChain } from "../lib/modelPolicy";
import { __resetBreakersForTests } from "../lib/llmRouter";
import { logger } from "../lib/logger";

interface Sample { lang: string; body: string }
const SAMPLES: Sample[] = [
  { lang: "en", body: "Hi, I'm reaching out from MobUpps about performance user acquisition for your mobile game. We run CPI and CPA campaigns on semi-exclusive supply with fraud filtering. Would you be open to a short test?" },
  { lang: "de", body: "Hallo, ich melde mich von MobUpps zum Thema performancebasierte Nutzergewinnung für Ihre App. Wir betreiben CPI- und CPA-Kampagnen mit Betrugsfilterung. Hätten Sie Interesse an einem kurzen Test?" },
  { lang: "fr", body: "Bonjour, je vous contacte de la part de MobUpps au sujet de l'acquisition d'utilisateurs à la performance pour votre application. Nous gérons des campagnes CPI et CPA avec filtrage anti-fraude. Seriez-vous ouvert à un court test ?" },
  { lang: "es", body: "Hola, le escribo desde MobUpps sobre la adquisición de usuarios por rendimiento para su aplicación. Gestionamos campañas de CPI y CPA con filtrado de fraude. ¿Estaría abierto a una prueba breve?" },
  { lang: "pt", body: "Olá, escrevo da MobUpps sobre aquisição de usuários por desempenho para o seu aplicativo. Gerenciamos campanhas de CPI e CPA com filtragem de fraude. Você estaria aberto a um teste rápido?" },
  { lang: "it", body: "Salve, la contatto da MobUpps riguardo all'acquisizione utenti a performance per la vostra app. Gestiamo campagne CPI e CPA con filtraggio antifrode. Sarebbe disponibile per un breve test?" },
  { lang: "ru", body: "Здравствуйте, пишу вам из MobUpps по поводу привлечения пользователей с оплатой за результат для вашего приложения. Мы ведём CPI и CPA кампании с фильтрацией фрода. Готовы обсудить небольшой тест?" },
  { lang: "ja", body: "こんにちは、MobUppsからご連絡しております。御社アプリのパフォーマンス型ユーザー獲得についてのご提案です。不正フィルタリング付きのCPIおよびCPAキャンペーンを運用しています。短いテストにご興味はありますか？" },
  { lang: "ko", body: "안녕하세요, MobUpps에서 연락드립니다. 귀사 앱의 성과 기반 사용자 획득에 대해 제안드립니다. 사기 필터링이 포함된 CPI 및 CPA 캠페인을 운영합니다. 간단한 테스트에 관심이 있으신가요?" },
  { lang: "zh", body: "您好，我是MobUpps的代表，想就贵公司应用的效果型用户获取与您联系。我们运营带有反欺诈过滤的CPI和CPA广告活动。您是否愿意进行一次简短的测试？" },
  { lang: "ar", body: "مرحبًا، أتواصل معكم من MobUpps بخصوص اكتساب المستخدمين القائم على الأداء لتطبيقكم. ندير حملات CPI وCPA مع تصفية الاحتيال. هل أنتم منفتحون على اختبار قصير؟" },
  { lang: "he", body: "שלום, אני פונה מטעם MobUpps בנוגע לרכישת משתמשים מבוססת ביצועים עבור האפליקציה שלכם. אנו מנהלים קמפייני CPI ו-CPA עם סינון הונאות. האם תהיו פתוחים לבדיקה קצרה?" },
  { lang: "hi", body: "नमस्ते, मैं MobUpps से आपके ऐप के लिए परफ़ॉर्मेंस-आधारित यूज़र अधिग्रहण के बारे में संपर्क कर रहा हूँ। हम फ्रॉड फ़िल्टरिंग के साथ CPI और CPA अभियान चलाते हैं। क्या आप एक छोटे परीक्षण के लिए तैयार हैं?" },
  { lang: "tr", body: "Merhaba, uygulamanız için performansa dayalı kullanıcı edinimi konusunda MobUpps'tan yazıyorum. Sahtekarlık filtrelemeli CPI ve CPA kampanyaları yürütüyoruz. Kısa bir denemeye açık mısınız?" },
];

type Verdict = "OK" | "LANG" | "META" | "EMPTY" | "ERROR";
interface Row { lang: string; provider: string; got: string; summary: string; verdict: Verdict }

async function runConfig(provider: "primary" | "fallback", chainSpec: string | null): Promise<Row[]> {
  if (chainSpec) process.env.LLM_CHAIN_SUMMARIZER = chainSpec;
  else delete process.env.LLM_CHAIN_SUMMARIZER;
  // Fresh breakers per arm so a failure streak in one arm cannot open a
  // breaker that silently reroutes the other arm's calls.
  __resetBreakersForTests();
  const rows: Row[] = [];
  for (const s of SAMPLES) {
    try {
      const res = await summarizeOriginalEmail(s.body);
      const got = (res.language || "").slice(0, 2).toLowerCase();
      let verdict: Verdict = "OK";
      if (got !== s.lang) verdict = "LANG";
      else if (!res.summary || res.summary.trim().length === 0) verdict = "EMPTY";
      else if (summaryLooksMeta(res.summary)) verdict = "META";
      rows.push({ lang: s.lang, provider, got: res.language, summary: res.summary, verdict });
      console.log(`  ${provider.padEnd(6)} ${s.lang.padEnd(4)} -> lang=${(res.language || "?").padEnd(6)} ${verdict.padEnd(6)} "${res.summary.slice(0, 70)}"`);
    } catch (err) {
      rows.push({ lang: s.lang, provider, got: "", summary: "", verdict: "ERROR" });
      console.log(`  ${provider.padEnd(6)} ${s.lang.padEnd(4)} ERROR ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return rows;
}

function score(rows: Row[]) {
  const langOk = rows.filter((r) => r.verdict !== "LANG" && r.verdict !== "ERROR").length;
  const fullOk = rows.filter((r) => r.verdict === "OK").length;
  const errs = rows.filter((r) => r.verdict === "ERROR").length;
  return { langOk, fullOk, errs, n: rows.length };
}

async function main() {
  (logger as unknown as { level: string }).level = "warn";
  // Keep this smoke's 28 summarizer calls off the production usage ledger —
  // the aux recorder writes without a usage context by design, so a dev run
  // would otherwise skew the email_summary cost line and the daily budget cap.
  __setLedgerSuppressedForOfflineRuns(true);
  if (!isGeminiConfigured()) {
    console.error("GEMINI_API_KEY not set — cannot test the cheap summarizer. Aborting.");
    process.exit(1);
  }
  if (!isOpenAiConfigured()) {
    console.error("OPENAI_API_KEY not set — cannot test the fallback tier. Aborting.");
    process.exit(1);
  }

  // The chain's first cross-vendor tier is the one a Gemini outage lands on.
  const chain = getChain("summarizer");
  const fallbackTier = chain.find((t) => t.provider !== chain[0].provider);
  if (!fallbackTier) {
    console.error(`summarizer chain has no cross-vendor tier: ${describeChain(chain)}`);
    process.exit(1);
  }
  const fallbackSpec = `${fallbackTier.provider}:${fallbackTier.model}${fallbackTier.effort ? `@${fallbackTier.effort}` : fallbackTier.thinking ? `@${fallbackTier.thinking}` : ""}`;

  const savedChain = process.env.LLM_CHAIN_SUMMARIZER;
  console.log(`\nSummarizer primary-vs-fallback smoke — ${SAMPLES.length} languages, real summarizeOriginalEmail`);
  console.log(`chain: ${describeChain(chain)}\n`);
  console.log("PRIMARY (live chain, tier 1 serving):");
  const cheap = await runConfig("primary", null);
  console.log(`\nFALLBACK (forced ${fallbackSpec} — what a Gemini outage degrades to):`);
  const sonnet = await runConfig("fallback", fallbackSpec);
  if (savedChain === undefined) delete process.env.LLM_CHAIN_SUMMARIZER;
  else process.env.LLM_CHAIN_SUMMARIZER = savedChain;

  const c = score(cheap);
  const s = score(sonnet);
  console.log(`\n${"-".repeat(64)}`);
  console.log(`language correct   primary ${c.langOk}/${c.n}   fallback ${s.langOk}/${s.n}`);
  console.log(`fully OK (lang+summary)  primary ${c.fullOk}/${c.n}   fallback ${s.fullOk}/${s.n}`);
  const fallbackLangMisses = sonnet.filter((r) => r.verdict === "LANG").map((r) => `${r.lang}->${r.got}`);
  if (fallbackLangMisses.length) console.log(`fallback language misses: ${fallbackLangMisses.join(", ")}`);
  const errs = [...cheap, ...sonnet].filter((r) => r.verdict === "ERROR");

  // Language accuracy is the gate, and the FALLBACK is the arm under test: it
  // is what a Gemini capacity wall silently degrades production to. Allow it to
  // be at most 1 behind the primary.
  const langRegression = c.langOk - s.langOk > 1;
  const hardError = errs.length > 0;
  const verdict = hardError
    ? "SMOKE FAIL (errors)"
    : langRegression
    ? `SMOKE FAIL — fallback language accuracy ${s.langOk} vs primary ${c.langOk}`
    : `SMOKE PASS — the fallback tier holds language accuracy (${s.langOk}/${s.n} vs primary ${c.langOk}/${c.n})`;
  console.log(`\n${verdict}\n`);
  process.exit(hardError || langRegression ? 1 : 0);
}

main().catch((e) => {
  console.error("fatal:", e instanceof Error ? e.message : e);
  process.exit(1);
});
