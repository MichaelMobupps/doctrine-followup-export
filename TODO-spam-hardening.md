# TODO — Followupper spam-filter hardening (pinnacle deliverability pass) (2026-07-23)

## Problem statement
- Production incident 2026-07-23 (Sarit/wmadv report re: Denise's email): follow-ups produced by
  the Followupper trip receiving-side spam filters and land users in the spam folder / hurt their
  sender reputation. Identified content causes from the incident analysis:
  1. Follow-up-count phrasing: "reached out 6 times" — classic mass-cold-outreach signal.
  2. Spam-trigger keywords: "Bitcoins" (financial bait class), plus the usual lexicon
     (free money, guaranteed, act now, limited time, click here, ...).
  3. Dry list formatting: bullet/numbered lists of brand names instead of prose.
  4. Cold-pitch phrasing / unbalanced text (enumeration blobs with no context).
- The writer prompt already bans a few signals ("just checking in", exclamation marks) but there is
  NO deterministic spam-risk linter, NO critic criterion for deliverability, and NO send-time gate.
  A bad draft that slips the LLM critic ships to Gmail unchecked.

## Where the pipeline lives (recon done 2026-07-23)
- Monorepo: /home/runner/workspace (pnpm). API server: artifacts/api-server.
- Doctrine generator: src/services/followupGenerator.ts — draft → deterministic checks
  (detectMetaLanguage + doctrineLint.detectAllDeterministicViolations +
  structuralLint.detectStructuralViolations + competitorScriptLint) → LLM critic → rewriter,
  2 healing iterations, humanizeFollowup() at every exit.
- Context generator: src/services/contextFollowupGenerator.ts:224 (same deterministic merge point).
- Anti-ghosting generator: src/services/antiGhostingFollowupGenerator.ts:262 (same).
- Send path: src/services/scheduler.ts — generate → pending_approval | drafted | sendFollowupReply
  (gmailClient.ts:470). Approval path sends the STORED generatedBody later via routes/doctrine.ts
  (~:829) and routes/context.ts (~:499) — bodies generated before this fix can ship post-fix.
- Lint conventions: ViolationReport { found, issues, suggestions, matches } (doctrineLint.ts:38);
  every rule env-gated; whole layer killable via one env flag; per-language tables like
  structuralLint ACK_MARKERS; skip-not-guess for untabled languages.
- Tests: src/tests/test-*.ts (plain tsx scripts, run via `node --import tsx`).
- Smoke: src/scripts/smoke-writer*.ts etc. — consume live repl secrets (Anthropic/Gemini keys,
  DATABASE_URL) from env. Budget guard exists (smoke-budget.sh).

## Plan (check off as completed; resume here if SSH drops)
- [x] 0. Write this TODO file BEFORE any code.
- [x] 1. Build src/lib/spamRiskLint.ts — deterministic spam-risk linter, ViolationReport shape.
      Layer flag SPAM_LINT_ENABLED (default on), per-rule flags. Rules:
      S1 FOLLOWUP-COUNT: "reached out N times" / "my 3rd email" / "third time reaching out" /
         digit+times patterns; multilingual tables (start with en/es/pt/fr/de/ru/he) +
         universal digit-based fallback; untabled languages are skipped, never guessed.
      S2 SPAM-TRIGGER LEXICON: financial-bait (bitcoin(s), crypto giveaway, free money, cash
         bonus, double your X, earn $ fast), urgency-bait (act now, limited time offer, don't
         miss out, final notice), click-bait (click here, buy now, order now, 100% free,
         risk-free, no obligation). GROUNDING EXEMPTION: a trigger token inside a phrase that
         appears verbatim in the ORIGINAL outreach (e.g. brand "Mercado Bitcoin" present in the
         original email) is exempt — brand names are legitimate.
      S3 LIST-FORMAT: bullet/numbered/•-prefixed lines, 3+ parallel short lines, comma
         enumeration blobs (6+ items in one chain). Prose is doctrine anyway.
      S4 SHOUTING: non-acronym ALL-CAPS words (allowlist = curated acronyms CPI/CPA/ROAS/...),
         "!!" / "???" / "$$$" runs.
      S5 MONEY-BAIT: currency amount adjacent to free/win/bonus/earn/guaranteed.
      S6 LINK HYGIENE: >1 URL in body, URL shorteners (bit.ly, tinyurl, ...), bare-IP URLs.
      S7 SUBJECT: trigger words / emoji / all-caps / "!" in the subject line.
- [x] 2. Wire linter into ALL THREE generators' deterministic merge points so violations force a
      rewrite through the existing healing loop (followupGenerator.ts, contextFollowupGenerator.ts,
      antiGhostingFollowupGenerator.ts). Pass subject+original text for grounding exemption.
- [x] 3. Prompt hardening (writer + critic + rewriter, doctrine flow first):
      - Writer system prompt: new DELIVERABILITY section — never state how many times you've
        reached out or which attempt number this is; no bullet/numbered lists, prose only;
        avoid spam-trigger lexicon unless the exact proper noun is in the original email;
        no ALL-CAPS words beyond curated acronyms; at most one URL and only if present in the
        original; subject stays a plain "Re:" variant with no trigger words.
      - Critic: new criterion DELIVERABILITY / SPAM-SIGNAL, new score key "deliverability",
        needs_rewrite gate wired into the threshold sentence.
      - Rewriter: instruction to fix deliverability issues without losing the follow-up ack.
      - Mirror the writer DELIVERABILITY section into context + anti-ghosting prompts.
- [x] 4. Send-time gate (DESIGN NOTE: human paths are advisory/warn-only — the doctrine
      /approve route and forceSend re-entries would otherwise dead-loop a spam-diverted row;
      only cron auto-send hard-diverts to pending_approval with reason in errorMessage) (belt-and-suspenders; catches pre-fix stored bodies + approval path):
      spamRiskLint exports assessSpamRisk(subject, body, lang, original) → {score, violations}.
      Gate in scheduler.ts before createFollowupDraft/sendFollowupReply AND in the approval-send
      routes (doctrine.ts, context.ts): high-risk → do NOT send; flip to pending_approval with
      reason logged (never silent-drop, never fail the row). Env: SPAM_GATE_ENABLED (default on),
      SPAM_GATE_MODE=block|warn (default block).
- [x] 5. Hermetic tests: src/tests/test-spam-risk-lint.ts (46 tests green; fixed during dev:
      JS \b is Latin-only → \p{L} lookarounds for ru/uk/he; NFD fold corrupts Cyrillic й →
      no folding for ru/uk/he; es/pt participle "escrito"; sentence split must not break on
      "Ng.Cash"-style dots; Hebrew count words שלוש/ארבע/... added) — per-rule positives/negatives,
      multilingual FOLLOWUP-COUNT, grounding exemption (Mercado Bitcoin), acronym allowlist,
      CJK/Thai safety (no false positives on dense scripts), gate mode behaviour.
- [x] 6. Godlike audit + blast radius (findings logged below):
      - pnpm typecheck + full existing test battery (all src/tests/test-*.ts).
      - False-positive sweep: run the new linter over the known-good corpora in the repo
        (emails-healed*.md, exemplar library data) — FP rate must be ~0; tune before shipping.
      - Blast radius: every ViolationReport consumer, healing-loop budget (2 iterations still
        enough?), CSD shared-draft path, approval flow statuses, dashboard rendering of
        pending_approval rows created by the gate, env-flag defaults on prod autoscale.
- [x] 7. Smoke tests at full length using the repl secrets (live LLM env vars):
      - Existing: smoke-writer.ts (spot), full test battery.
      - New: src/scripts/smoke-spam-risk.ts — spam-bait contexts (crypto vertical original email,
        stage-4 prospect with prior follow-ups, list-heavy original) across languages; assert
        every final output passes assessSpamRisk + existing doctrine lint.
- [x] 8. Auto-fix everything the audit/smoke surfaced (F1-F9 below); re-ran until green.
- [x] 9. Final verify + summary in this file.

## Non-code deliverability notes (ops, not in this repo's scope — surface to Michael)
- Content is only half of deliverability. The users' domains should also have SPF, DKIM and
  DMARC aligned, warmed sending volume, and List-Unsubscribe on true bulk sends. The Followupper
  sends 1:1 threaded Gmail replies (good: threading + low volume + real Gmail infra), so content
  phrasing is the main controllable lever here — but flag domain auth in onboarding docs.

## Findings / audit log (Steps 6-8)
### Step 6 audit — completed 2026-07-23
- typecheck: PASS (tsc -b). Full test battery: 735/735 PASS (incl. 46 new spam-lint tests).
- Blast radius verified:
  - Send call sites: exactly 2 (scheduler.ts, routes/doctrine.ts approve). Context approve
    re-enters scheduler with forceSend=true → covered by the scheduler gate in advisory mode.
  - forceSend loop hazard found & fixed BEFORE shipping: gate diverts only cron auto-sends;
    human-initiated sends (approve, Send-now) get warn-only. Otherwise a diverted row could
    never be approved (approve → requeue → gate → pending_approval forever).
  - Dashboard: pipeline.tsx renders error_message on any row → gate reason surfaces with no
    UI change. pending_approval already a first-class status everywhere (kill/salvage routes).
  - CSD shared drafts: linted at generation (pre-cache), scored again at send. Name-leak
    logic untouched.
  - ViolationReport shape unchanged; merge points additive only.
- False-positive sweep (known-good corpora):
  - emails-healed.md + emails-all-langs.md (144 emails, ~30 langs): 0 flagged, 0 highRisk
    (after fixes F1-F6 below). Sweep initially mis-parsed lint ANNOTATIONS ("> issues:",
    "> residual:") as body text — real emails were never the source of those flags.
  - Exemplar library (1272 gold exemplars): 1 flagged — ja crypto exemplar with Latin
    "crypto" and no original text to ground it; in production the crypto-vertical original
    grounds it. Correct behaviour, not an FP.
### Linter defects found by audit & fixed (F-log)
- F1: JS \b is Latin-only → ru/uk/he patterns rewritten with \p{L} lookarounds (u flag).
- F2: NFD diacritic folding corrupts Cyrillic й → ru/uk/he matched unfolded.
- F3: es/pt participle "escrito/escrito" missing from contact-verb stems.
- F4: sentence splitter broke on "Ng.Cash"-style intra-word dots → split only before whitespace.
- F5: CPS (their core vertical!) + FTD/GMV/CAC/SVOD/... missing from caps allowlist; SHOUTING
  redesigned: flags shouted COMMON words (FREE/ACT/AMAZING...) or 4+ distinct unknown caps —
  brand acronyms (ESPN, DGCCRF, BLIK, HDE) no longer flag.
- F6: money-bait proximity window (±40 chars) FP'd on "eCPA of $190, with bonus abuse blocked"
  → replaced with direct-adjacency patterns ("free $500 bonus", "$500 bonus").
- F7: comma-enumeration FP on Chinese prose (，is a clause separator) → zh/ja use the
  dedicated enumeration comma 、only; and decimal commas ("5,45 USD") excluded by
  requiring a trailing space after the separator.
- F8: "my last email" / ru "последнее письмо" are natural stage-3 acks, not counts →
  last/final only flag with attempt/try; ru "последнее письмо/сообщение" dropped.
- F9: subject inheritance — a reply's subject is "Re: <original>"; emoji/caps/triggers
  INHERITED from the original subject (house style "Re: 🔵{Brand} & MobUpps") are exempt;
  only writer-invented subject content is checked. Fake "FW:" still always flags.
- Hebrew count words (שלוש, ארבע, ...) added to the S1 table.

### Step 7 live smoke — completed 2026-07-23 (repl secrets: ANTHROPIC_API_KEY + GEMINI key)
- smoke-spam-risk.ts: 12 spam-bait cells (attempt-count bait at stage 3-4 with prior
  follow-up history, list-heavy originals, crypto-grounded originals, promo/money-bait
  originals) × full production pipeline (draft → lint → critic → rewrite → humanize)
  across en/es/pt/de/ru/he/ja/zh/fr.
- Result: 12/12 PASS — every FINAL output spam-lint-clean, gate risk score 0, no doctrine
  residuals. Healing loop observed firing mid-pipeline (deterministic flags → rewrite →
  clean within <=2 iterations). Zero drafts contained counts/lists/triggers at the final
  stage: the prompt-layer DELIVERABILITY doctrine suppresses at the source; the linter and
  the send gate stand behind it.
- Log: artifacts/api-server/smoke-spam-2026-07-23T11-27-46-098Z.log
- Exit code 0. Full battery re-run after all fixes: 735/735 PASS. typecheck PASS.
- FULL-LENGTH run #2 (user request "all languages"): smoke extended to the complete
  36-tag language matrix (auto-generated stage-3 count+list-bait cell per language on
  top of the 12 curated cells) = 38 cells. Result: 38/38 PASS, spamFound=false and gate
  risk=0 on EVERY final output. Log: smoke-spam-2026-07-23T11-53-09-601Z.log
  Note: 5 cells (cs, ro, fi, tl, el) show doctrineResidual=true — residual NATIVENESS
  nits from the PRE-EXISTING doctrine linter after the 2-iteration healing budget
  (known historical behaviour for those languages), unrelated to spam signals.
- smoke-writer.ts spot-run (chain mode, quick preset): SMOKE PASS, 34 model calls ok,
  0 failed. Draft-level lint 82.4% report-only (pre-healing, consistent with history).
- S1 count-table coverage note: phrase tables exist for en/es/pt/fr/de/it/ru/uk/he;
  the other 27 tags rely on the prompt layer for count phrasing (skip-not-guess lint
  convention) plus all script-agnostic rules (S2-S7). All 36 verified clean end-to-end.

## Defense-in-depth summary (what ships)
1. WRITER prompts (all 3 flows): DELIVERABILITY doctrine — no attempt counts, no lists,
   no ungrounded trigger vocab, no shouting, subject stays plain "Re:" variant.
2. GENERATION gate: spamRiskLint merged into every deterministic pre-critic check →
   dirty drafts force a rewrite through the existing healing loop (no extra LLM cost when
   clean; skips the critic call when flagged, same CB-1 pattern).
3. CRITIC: criterion 16 DELIVERABILITY with "deliverability" score key; <4 forces rewrite.
4. SEND-TIME gate: assessSpamRisk on the FINAL subject+body right before Gmail send —
   covers pre-fix stored bodies and CSD cache hits. Cron auto-sends divert to
   pending_approval with reason in errorMessage (dashboard shows it); human-initiated
   sends (approve / Send now) warn-only, so no approval dead-loop.
   Env: SPAM_LINT_ENABLED, SPAM_CHECK_* (per rule), SPAM_GATE_ENABLED, SPAM_GATE_MODE.

## Status: COMPLETE 2026-07-23. All 9 steps done; audit green; live smoke 12/12.
