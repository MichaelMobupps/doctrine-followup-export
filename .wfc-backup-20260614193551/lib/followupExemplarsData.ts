/**
 * Embedded gold-standard follow-up exemplar library.
 *
 * Source of truth: Followupper_Exemplars.jsonl (gold-standard, doctrine-compliant
 * Stage 1/2/3 follow-ups across languages, verticals, and offer types). The data
 * is embedded as a TS constant rather than read from disk so it survives the
 * esbuild bundle step and needs no runtime file path. Regenerate this file from
 * the JSONL with scripts/build-exemplars.mjs when the library changes.
 *
 * DO NOT hand-edit the array below. Edit the JSONL and regenerate.
 *
 * Each exemplar demonstrates the doctrine SHAPE the writer must reproduce:
 * a prior-outreach reference in the opening, one restated proof point, optional
 * one fresh sourced angle, a soft single-question CTA, no sign-off, and native
 * register for the target language. register_notes explains why each one passes.
 */

export interface FollowupExemplar {
  parent_id: string;
  id: string;
  stage: number;
  subject: string;
  body: string;
  angle: string;
  vertical: string;
  offer_type: string;
  language: string;
  market: string;
  rule_pack: string;
  enrichment_sources: string[];
  illustrative_flags: string[];
  register_notes: string;
}

export const FOLLOWUP_EXEMPLARS: FollowupExemplar[] = [
  {
    "parent_id": "en_sports_betting_ua",
    "id": "en_sports_betting_ua__f1",
    "stage": 1,
    "subject": "Re: 🔵{Brand} & MobUpps",
    "body": "Hi RECIPIENT_NAME,\nFollowing up on my note about driving first-time deposits for your sportsbook in the states where you are licensed. The one point worth repeating: we optimize to the FTD and screen the deposit in four layers, so the volume you pay for is validated depositors at an eCPA of $190, with bonus-only and multi-accounting blocked before payout. If it helps, I can pull the state-level FTD view for your live markets. Open to a quick look?",
    "angle": "warm bump, restate FTD-quality proof",
    "vertical": "sports_betting",
    "offer_type": "ua",
    "language": "en",
    "market": "United States",
    "rule_pack": "non_gaming_mobile",
    "enrichment_sources": [],
    "illustrative_flags": [
      "eCPA on the FTD $190 (MobUpps, illustrative)"
    ],
    "register_notes": "Stage 1 EN sports_betting: references prior in S1; restates single proof (FTD optimization + 4-layer deposit screening); one illustrative figure (eCPA $190); soft CTA, 1 question mark; no sign-off; X-not-Y avoided."
  },
  {
    "parent_id": "en_sports_betting_ua",
    "id": "en_sports_betting_ua__f2",
    "stage": 2,
    "subject": "Re: 🔵{Brand} & MobUpps",
    "body": "Hi RECIPIENT_NAME,\nFollowing up on my earlier email about FTD acquisition in your licensed states. Since PENN shut down ESPN BET and relaunched theScore Bet across 21 states in December 2025, the tier you compete in has reshuffled, and qualified-bettor CPAs in US regulated markets run between $50 and $300. That is exactly the spread where deposit-event screening and incrementality decide your real cost per validated depositor. We hold out a control group so the paid FTDs show as incremental to your organic high-value bettors. Worth comparing against your current source mix?",
    "angle": "fresh angle: timely ESPN BET->theScore Bet shift (sourced) + market CPA band",
    "vertical": "sports_betting",
    "offer_type": "ua",
    "language": "en",
    "market": "United States",
    "rule_pack": "non_gaming_mobile",
    "enrichment_sources": [
      "https://casinobeats.com/2025/12/02/penn-thescore-bet-relaunch-espn-bet-shutdown/",
      "https://igamingbusiness.com/sports-betting/penn-espn-bet-shutdown-thescore-relaunch/",
      "https://track360.io/glossary/sportsbook-cpa"
    ],
    "illustrative_flags": [],
    "register_notes": "Stage 2 EN sports_betting: acknowledges 2nd follow-up + references prior; fresh angle = timely development (theScore Bet) + market CPA band $50-300; MobUpps holdout reference (no figure); 1 question mark; no sign-off."
  },
  {
    "parent_id": "en_sports_betting_ua",
    "id": "en_sports_betting_ua__f3",
    "stage": 3,
    "subject": "Re: 🔵{Brand} & MobUpps",
    "body": "Hi RECIPIENT_NAME,\nLast note from me on the FTD program for your licensed states. If depositor quality and incrementality are on your roadmap for the next season, I can share the state-level FTD view and a short holdout read this week. If the timing is not right, I will leave it here and step back. Either way, you have the context for when it is useful.",
    "angle": "direct close with easy out",
    "vertical": "sports_betting",
    "offer_type": "ua",
    "language": "en",
    "market": "United States",
    "rule_pack": "non_gaming_mobile",
    "enrichment_sources": [],
    "illustrative_flags": [],
    "register_notes": "Stage 3 EN sports_betting: references prior + earlier stages; direct, easy out (release if timing wrong); no figure; 0 question marks; no sign-off."
  },
  {
    "parent_id": "es_ecommerce_cps",
    "id": "es_ecommerce_cps__f1",
    "stage": 1,
    "subject": "Re: 🔵{Brand} & MobUpps",
    "body": "Hola RECIPIENT_NAME,\nRetomo mi correo sobre generar ventas web por coste por venta para tu marca. El punto que vale la pena repetir: pagas por compra validada y con deduplicación por pedido, así que el riesgo comercial es nuestro hasta que la venta entra. Si te resulta útil, te comparto la vista de ventas por categoría. ¿Lo vemos esta semana?",
    "angle": "warm bump, restate cost-per-sale + risk-on-us proof",
    "vertical": "ecommerce",
    "offer_type": "cps",
    "language": "es",
    "market": "Spain",
    "rule_pack": "non_gaming_mobile",
    "enrichment_sources": [],
    "illustrative_flags": [],
    "register_notes": "Stage 1 ES ecommerce: references prior in S1; restates single proof (CPS validated sale + dedup + risk-on-us); no figure; 1 question mark; reflexive register; no sign-off; X-not-Y avoided."
  },
  {
    "parent_id": "es_ecommerce_cps",
    "id": "es_ecommerce_cps__f2",
    "stage": 2,
    "subject": "Re: 🔵{Brand} & MobUpps",
    "body": "Hola RECIPIENT_NAME,\nVuelvo sobre mi mensaje anterior acerca del coste por venta para tu tienda. Un dato del mercado que conviene tener presente: el 70% de los carritos se abandonan y hasta dos de cada tres ventas de cupón y cashback no son incrementales, de modo que la incrementalidad separa el gasto útil del que canibaliza el tráfico orgánico que ya tienes. Nosotros la medimos con grupo de control sobre inventario semi exclusivo. ¿Tendrías un momento para verlo la próxima semana?",
    "angle": "fresh angle: market data (cart abandonment + coupon non-incrementality)",
    "vertical": "ecommerce",
    "offer_type": "cps",
    "language": "es",
    "market": "Spain",
    "rule_pack": "non_gaming_mobile",
    "enrichment_sources": [
      "https://baymard.com/lists/cart-abandonment-rate",
      "https://partnercentric.com/affiliate-resources/guide-to-incrementality/"
    ],
    "illustrative_flags": [],
    "register_notes": "Stage 2 ES ecommerce: acknowledges 2nd follow-up + references prior; fresh angle = market data (70% cart abandonment; 2-of-3 coupon non-incremental); MobUpps control-group reference (no figure); 1 question mark; subjunctive CTA; no sign-off."
  },
  {
    "parent_id": "es_ecommerce_cps",
    "id": "es_ecommerce_cps__f3",
    "stage": 3,
    "subject": "Re: 🔵{Brand} & MobUpps",
    "body": "Hola RECIPIENT_NAME,\nÚltima nota por mi parte sobre el programa de coste por venta. Si para esta temporada te interesa sumar ventas validadas e incrementales sobre tu propio tráfico, esta semana te paso la vista por categoría y el desglose de incrementalidad. Si no es el momento, lo dejo aquí sin problema. En cualquier caso, te queda el contexto para cuando lo necesites.",
    "angle": "direct close with easy out",
    "vertical": "ecommerce",
    "offer_type": "cps",
    "language": "es",
    "market": "Spain",
    "rule_pack": "non_gaming_mobile",
    "enrichment_sources": [],
    "illustrative_flags": [],
    "register_notes": "Stage 3 ES ecommerce: references prior + earlier stages; direct, easy out; no figure; 0 question marks; no sign-off."
  },
  {
    "parent_id": "de_health_and_fitness_retargeting",
    "id": "de_health_and_fitness_retargeting__f1",
    "stage": 1,
    "subject": "Re: 🔵{Brand} & MobUpps",
    "body": "Hallo RECIPIENT_NAME,\nIch komme auf meine Mail zur Reaktivierung abgesprungener Trial-Nutzer zurück. Der eine Punkt, den ich wiederholen möchte: wir lesen das Leck zwischen Onboarding-Abbruch und erstem bezahlten Abo und unterdrücken aktive Mitglieder, sodass du nie für eine organische Verlängerung zahlst. Reaktivierung senkt den CPA gegenüber Neukundengewinnung typischerweise um 38%. Wenn es hilft, schicke ich dir die Reaktivierungssicht nach Kohorte.",
    "angle": "warm bump, restate reactivation + suppression proof",
    "vertical": "health_and_fitness",
    "offer_type": "retargeting",
    "language": "de",
    "market": "Germany",
    "rule_pack": "non_gaming_mobile",
    "enrichment_sources": [
      "https://www.appsflyer.com/resources/reports/top-5-data-trends-report/"
    ],
    "illustrative_flags": [],
    "register_notes": "Stage 1 DE health_fitness: references prior in S1; restates single proof (reactivation + suppress organic); one market figure (CPA -38%, market context); no question mark (register); no sign-off; English-tolerant register."
  },
  {
    "parent_id": "de_health_and_fitness_retargeting",
    "id": "de_health_and_fitness_retargeting__f2",
    "stage": 2,
    "subject": "Re: 🔵{Brand} & MobUpps",
    "body": "Hallo RECIPIENT_NAME,\nIch melde mich noch einmal zu meiner Mail über die Reaktivierung an der Paywall. Ein Marktwert, der hier zählt: 35% der Jahresabos kündigen schon im ersten Monat und 45% der Rückkehrer kommen in den ersten 30 Tagen zurück, also entscheidet das Timing nach dem Absprung über die Rückgewinnung. Wir takten die Auslieferung genau auf diese Fenster und messen die Inkrementalität gegen die organische Rückkehr über eine Holdout-Gruppe. Bei Interesse schicke ich dir den Vergleich für deine Kohorten.",
    "angle": "fresh angle: churn + win-back timing data",
    "vertical": "health_and_fitness",
    "offer_type": "retargeting",
    "language": "de",
    "market": "Germany",
    "rule_pack": "non_gaming_mobile",
    "enrichment_sources": [
      "https://ppc.land/95-of-annual-app-subscribers-who-cancel-never-return-revenuecat-finds/"
    ],
    "illustrative_flags": [],
    "register_notes": "Stage 2 DE health_fitness: acknowledges 2nd follow-up + references prior; fresh angle = churn/win-back timing (35% month-1 cancel, 45% return within 30 days); MobUpps Holdout reference (no figure); no question mark; no sign-off."
  },
  {
    "parent_id": "de_health_and_fitness_retargeting",
    "id": "de_health_and_fitness_retargeting__f3",
    "stage": 3,
    "subject": "Re: 🔵{Brand} & MobUpps",
    "body": "Hallo RECIPIENT_NAME,\nLetzte Nachricht von mir zur Reaktivierung deiner abgesprungenen Trials. Wenn erneuerungsgewichteter LTV und sauberer, validierter Wiedereinstieg für die nächste Saison auf deiner Liste stehen, schicke ich dir diese Woche die Kohortensicht und den Holdout-Vergleich. Falls das Timing gerade nicht passt, lasse ich es hier und du hast den Kontext für später. So oder so bleibt die Reaktivierungssicht für dich bereit.",
    "angle": "direct close with easy out",
    "vertical": "health_and_fitness",
    "offer_type": "retargeting",
    "language": "de",
    "market": "Germany",
    "rule_pack": "non_gaming_mobile",
    "enrichment_sources": [],
    "illustrative_flags": [],
    "register_notes": "Stage 3 DE health_fitness: references prior + earlier stages; direct, easy out; no figure; no question mark; no sign-off."
  },
  {
    "parent_id": "ja_gaming_midcore_hardcore_ua",
    "id": "ja_gaming_midcore_hardcore_ua__f1",
    "stage": 1,
    "subject": "Re: 🔵{Brand} & MobUpps",
    "body": "RECIPIENT_NAME様,\n先日お送りした、課金ユーザー獲得に関するメールのフォローアップです。改めてお伝えしたい点は、最初の課金転換と継続率を軸に最適化している点です。規模としては D7 継続率23%の水準でコホートを維持しています。ご参考までに、ジャンル別コホートの内訳をお送りできます。一度お話しする機会をいただけますでしょうか。",
    "angle": "warm bump, restate payer-conversion + retention proof",
    "vertical": "gaming_midcore_hardcore",
    "offer_type": "ua",
    "language": "ja",
    "market": "Japan",
    "rule_pack": "gaming",
    "enrichment_sources": [],
    "illustrative_flags": [
      "D7 retention 23% / D7継続率23% (MobUpps, illustrative)"
    ],
    "register_notes": "Stage 1 JA gaming: references prior in S1; restates single proof (payer conversion + retention); one illustrative figure (D7継続率23%); keigo question (no ? char); ではなく avoided; no sign-off; 様 salutation + transliterated name slot."
  },
  {
    "parent_id": "ja_gaming_midcore_hardcore_ua",
    "id": "ja_gaming_midcore_hardcore_ua__f2",
    "stage": 2,
    "subject": "Re: 🔵{Brand} & MobUpps",
    "body": "RECIPIENT_NAME様,\n先日の課金ユーザー獲得のメールに続けてのご連絡です。市場の動きとして、iOS の計測は SKAdNetwork から AdAttributionKit へ移行が進み、課金シグナルが集計ベースになるため、初回課金への価値ベース最適化とインクリメンタリティの検証がこれまで以上に効いてきます。ミッドコアの課金転換率は市場全体で1.6〜2.0%とされ、ここを引き上げられるかが単価を左右します。弊社はコントロール群で増分を検証し、準独占的な在庫で配信します。ご関心があれば、御社の構成と比較した見方をお送りします。",
    "angle": "fresh angle: SKAN->AdAttributionKit shift + market payer-conversion band",
    "vertical": "gaming_midcore_hardcore",
    "offer_type": "ua",
    "language": "ja",
    "market": "Japan",
    "rule_pack": "gaming",
    "enrichment_sources": [
      "https://www.appsflyer.com/glossary/skadnetwork/",
      "https://developer.apple.com/app-store/ad-attribution",
      "https://maf.ad/en/blog/mobile-game-conversion-rates/"
    ],
    "illustrative_flags": [],
    "register_notes": "Stage 2 JA gaming: acknowledges continuation + references prior; fresh angle = timely measurement shift (SKAdNetwork->AdAttributionKit) + market band 1.6-2.0%; no MobUpps figure; 0 ? chars; ではなく avoided; no sign-off."
  },
  {
    "parent_id": "ja_gaming_midcore_hardcore_ua",
    "id": "ja_gaming_midcore_hardcore_ua__f3",
    "stage": 3,
    "subject": "Re: 🔵{Brand} & MobUpps",
    "body": "RECIPIENT_NAME様,\n課金ユーザー獲得の件で、私からは最後のご連絡です。次の四半期で初回課金の質と継続率を伸ばす計画があれば、今週中にジャンル別コホートの内訳と増分の簡単な検証結果をお送りします。タイミングが合わなければ、こちらで止めておきますのでご安心ください。いずれにせよ、必要になった際の参考にしていただければ幸いです。",
    "angle": "direct close with easy out",
    "vertical": "gaming_midcore_hardcore",
    "offer_type": "ua",
    "language": "ja",
    "market": "Japan",
    "rule_pack": "gaming",
    "enrichment_sources": [],
    "illustrative_flags": [],
    "register_notes": "Stage 3 JA gaming: references prior + earlier stages; direct, easy out (release if timing wrong); no figure; 0 ? chars; keigo; no sign-off."
  }
];
