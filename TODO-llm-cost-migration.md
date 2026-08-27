# TODO — Move the Follow-upper off Anthropic (Gemini + OpenAI only), cheaper, with fallback waterfalls

**Owner:** Michael (michael@mobupps.com)
**Started:** 2026-08-27
**Driver:** Anthropic credit card declined → no Anthropic calls for now. Also: cut cost significantly, ideally with ~zero quality loss.
**Status legend:** ☐ todo · ◐ in progress · ☑ done · ✗ blocked/dropped

---

## 0. Constraints and acceptance criteria

- **Hard:** zero Anthropic API calls on any production path (no Sonnet/Haiku/Opus, not even as fallback).
- **Hard:** every LLM role has a **fallback waterfall** — on 429/503/5xx/timeout/parse-failure the call moves to the
  next model in that role's chain. No role may depend on a single model.
- **Hard:** waterfall must span **both vendors** where possible (Gemini tier → OpenAI tier), so a whole-vendor
  outage does not stop the pipeline.
- **Soft:** significant cost reduction vs today's blended cost.
- **Soft:** quality within noise of today. Some regression tolerated, not much. Measured, not asserted.
- Every change lands with a **smoke test**; the whole thing lands with an **E2E** run.

---

## 1. Inventory — every LLM call site (12 roles)

| # | Role | File | Today | Gap |
|---|------|------|-------|-----|
| 1 | Summarizer | `services/emailSummarizer.ts` | Gemini flash-lite → **Sonnet** | Anthropic fallback |
| 2 | Doctrine writer (draft) | `services/followupGenerator.ts` + `services/writerProvider.ts` | Gemini flash-lite → (Pro) → **Sonnet** | Anthropic final tier |
| 3 | Doctrine critic | `services/criticProvider.ts` | Gemini 3 flash → **Sonnet** | Anthropic fallback |
| 4 | Doctrine rewriter | `services/followupGenerator.ts` (via `runWriter`) | same chain as #2 | Anthropic final tier |
| 5 | Context generator | `services/contextFollowupGenerator.ts` | **Sonnet only** | fully Anthropic |
| 6 | Context critic | `contextFollowupGenerator.ts` → `runCriticWithProvider` | Gemini → **Sonnet** | Anthropic fallback |
| 7 | Context rewriter | `services/contextFollowupGenerator.ts` | **Sonnet only** | fully Anthropic |
| 8 | Anti-ghosting generator | `services/antiGhostingFollowupGenerator.ts` | **Sonnet only** | fully Anthropic |
| 9 | Anti-ghosting critic | → `runCriticWithProvider` | Gemini → **Sonnet** | Anthropic fallback |
| 10 | Anti-ghosting rewriter | `services/antiGhostingFollowupGenerator.ts` | **Sonnet only** | fully Anthropic |
| 11 | Reply sentiment classifier | `services/replySentiment.ts` | **Sonnet only** | fully Anthropic |
| 12 | FOLLOWUP-ACK confirm | `lib/followupAckConfirm.ts` | **Haiku only** | fully Anthropic |

☑ 1.1 Inventory complete (12 roles, verified by grep of `anthropic.messages.create`).

---

## 2. Plan

### Phase A — discovery (no code changes)
- ☑ A1. Probe Gemini API live — key works, 38 text models served (see §4).
- ☑ A2. Probe OpenAI API live — key works, Chat Completions + `response_format:json_object` OK on all candidates (see §4).
- ☑ A3. Published prices confirmed from vendor pricing pages (see §4 table).
- ☑ A4. Ledger baseline — queried, but **too thin to be the baseline**, so a better method was used instead.
      The whole `followup_usage` table holds 10 attributed follow-ups, all from June 2026 and all from the
      Opus-critic era ($0.0945/follow-up, 2 calls each). Nothing recent enough to characterise the Sonnet
      configuration this migration actually replaced. The baseline in §4.5 is therefore measured a better
      way: the E2E harness re-prices its OWN observed token counts under Sonnet's rate card, giving
      identical prompts and identical call counts with only the price list changed.

### Phase B — transport + router
- ☑ B1. `lib/openai.ts` — OpenAI transport mirroring `lib/gemini.ts` (json_schema strict / json_object, retry on
      408/429/5xx, abort/timeout, generation-budget aware, normalized usage out). 343 lines.
- ☑ B2. `lib/modelPolicy.ts` — 14 roles → ordered waterfalls, env-overridable via `LLM_CHAIN_<ROLE>`,
      `assertNoAnthropic()` enforced on built-ins AND on overrides. 401 lines.
- ☑ B3. `lib/llmRouter.ts` — `runLlm` / `runLlmJson` / `runLlmDraft`. One chain walk; parsing happens INSIDE
      the tier loop so an off-contract answer advances the waterfall instead of surfacing to the caller.
      Per-**model** breakers (shared across roles). `GenerationDeadlineError` rethrown, never scored
      against a tier. 617 lines.
- ☑ B4. Pricing: 13 OpenAI + 11 Gemini models added; per-model cache-read multiplier (gpt-4.1-x is 0.25x,
      not 0.10x); dated-suffix stripping now handles OpenAI's `-2026-03-17` shape too. Anthropic rows kept
      so historical ledger rows still re-cost correctly.
- ☑ B5. `recordLlmUsageBestEffort` / `recordLlmAuxUsageBestEffort` — provider-neutral ledger writers.
- ☑ B6. `lib/gemini.ts`: per-model thinking floors (`gemini-3.7-flash` 400s on MINIMAL; `gemini-2.5-*`
      rejects `thinkingConfig` outright). A 400 is non-retryable, so an un-clamped level would have burned
      a whole tier on every call.

### Phase C — migrate the 12 call sites  — **ALL DONE**
- ☑ C1. #3/#6/#9 critic → router. `criticProvider` is now prompts + contract only; `sonnetCritique` gone.
- ☑ C2. #2/#4 writer → router. `writerProvider` is a 134-line adapter (was 402). Grey-area became a
      *role* (`grey_draft`/`grey_rewriter`) instead of a boolean threaded through the fallback loop.
- ☑ C3. #5/#7 context generator + rewriter → router, on the exemplar-less chain.
- ☑ C4. #8/#10 anti-ghosting generator + rewriter → router. Calls `runLlmJson` directly rather than
      `runWriter`, because this flow legitimately allows an EMPTY body (subject-only re-engagement tiers)
      and the shared draft contract requires one.
- ☑ C5. #1 summarizer → router. Two provider paths collapsed into one.
- ☑ C6. #11 reply sentiment → router. Behaviour change recorded: an unparseable verdict used to return
      `"negative"`; it now advances the waterfall, and only a fully exhausted chain returns `"unknown"`.
      Both are equally safe downstream (`gmailSync` cascades only on `positive` above the confidence
      floor), so this strictly buys another model's opinion where the old code gave up.
- ☑ C7. #12 ack-confirm → router. Answer moved from a bare `YES`/`NO` word to `{"answer":"YES"}`, because
      OpenAI's `json_object` mode refuses a prompt that never says "json" and both vendors want a schema.
- ☑ C8. `lib/anthropic.ts` is inert: the eager client + boot-time `ANTHROPIC_API_KEY` throw is replaced by
      a lazy Proxy that throws only if something actually *calls* it. Importing is free, so the archived
      scripts still typecheck, and the server boots with no Anthropic key at all.
- ☑ C9. Archived 4 Anthropic-era comparison harnesses to `src/scripts/archive-anthropic-era/` (excluded
      from tsconfig) with a README explaining what each measured and what replaced it. Ported
      `smoke-writer-heal-all-languages.ts`, `smoke-critic.ts`, `adversarial-critic.ts` and
      `smoke-competitor.ts` onto the router instead of archiving them — they still earn their keep.
- ☑ C10. `tsc -b` clean across the whole package.

### Phase D — tests
- ☑ D1. `tests/test-llm-router.ts` — **32 tests, all passing.** Covers: the waterfall advances on 503,
      429 (both vendors' wordings), 500, timeout/abort, network fault, safety block, empty completion and
      missing content; walks to tier 3; `AllTiersFailedError` names every tier and cause; a missing API
      key skips a tier without calling it; an off-contract answer (unparseable, or valid JSON failing the
      caller's check) advances the chain and is **not re-picked**; tolerant parsing does not waste a tier
      on a fenced answer; a spent generation budget stops the chain and does not touch the breaker;
      usage is recorded for a billed call *even when the answer was unusable*; cached tokens are
      subtracted from input and thinking tokens folded into output; OpenAI reasoning tokens are **not**
      double-counted; breakers open at threshold, skip without calling, are keyed by model, and reset on
      success.
- ☑ D1b. `tests/test-writer-provider.ts` rewritten: role mapping, plus chain invariants asserted for all
      8 writer roles (>=2 tiers, spans both vendors, no Anthropic model) and a lock that the two
      exemplar-less flows keep their own chain.
- ☑ D1c. `tests/test-f37b-honest-tick.ts` ported: the budget-outranks-fallback guarantee now asserts the
      chain **stops** (tiers attempted == 1), not merely that it throws.
- ☑ D3a. Quality A/B round 1 — 6 models, 12 languages x 2 verticals, 24 cells each. Results in §4.3.
- ☑ D3b. Quality A/B round 2 — thinking/effort sweep + two untested cheap models. Results in §4.4.
- ☑ D3c. Critic A/B — `scripts/bench-llm-critic.ts`. Results in §4.7.
- ☑ D2. `scripts/smoke-llm-waterfall.ts` — **33 live checks, all passing.** Static: all 14 chains have
      >=2 tiers, span both vendors, name no Anthropic model, price every tier, repeat no model. Live:
      every role answers on its real chain (reporting the serving tier and cost); **L2** a dead tier 1
      (a model id that does not exist -> real vendor 404) falls through to the real primary; **L3** a
      dead tier from EACH vendor still lands; **L4** with `GEMINI_API_KEY` deliberately broken, the
      writer is served by `openai:gpt-5.4-nano` — a real whole-vendor outage, survived. $0.013 a run.
- ☑ D4. `tests/test-no-anthropic-on-production-paths.ts` — a source-level guard that crawls the import
      graph from `index.ts` and fails if any reachable file imports the Anthropic SDK, `lib/anthropic.ts`,
      `anthropicRetry`, or calls `anthropic.messages.create`. Plus a sweep of `services/ lib/ routes/
      middlewares/` so a not-yet-imported file cannot slip in. **It immediately found real dead code**:
      `lib/usageTracker.ts` still carried four vendor-specific recorders and the SDK import. Removed
      (313 -> 165 lines).
- ☑ D5. E2E: `scripts/smoke-writer-heal-all-languages.ts` ported onto the production waterfalls. Runs the
      real 2-iteration healing loop — draft -> lint -> rewrite -> lint -> humanize -> lint — and reports
      SHIP CLEAN rate and total cost per shipped email. Results in §4.5.
- ☑ D6. Cost: the heal harness now re-prices its OWN observed token counts under `--baseline-model`
      (default `claude-sonnet-4-6`), so the saving is measured on identical prompts and identical call
      counts with only the rate card changed. Results in §4.5.
- ☑ D3c. Boot-time validation: `index.ts` resolves and logs all 14 chains before listening, throws if any
      names an Anthropic model, and refuses to start if BOTH vendor keys are missing (warns loudly if
      only one is, since that halves every waterfall).

### Phase E — ship
- ☑ E1. Env/secrets: see §5 below.
- ☑ E2. Rollout + rollback: see §5 below.
- ☑ E4. Dashboard: `admin-activity.tsx`'s `modelShort()` only shortened Anthropic ids, so every model we
      now actually use rendered as a long raw string in the cost table. Extended to Gemini and OpenAI
      (`gemini-3.1-flash-lite` → `3.1 Flash-Lite`, `gpt-5.4-nano` → `5.4 nano`). The Anthropic branches
      are kept deliberately — the ledger still holds rows naming those models, and re-labelling them
      would make the past unreadable. Unknown ids fall through unchanged.
- ☑ E3. Runnable scripts added to `artifacts/api-server/package.json`:
      `llm:chains` (free, no network) · `llm:test` (free) · `llm:smoke` (live, ~$0.013) ·
      `llm:bench:writer` · `llm:bench:critic` · `llm:e2e` (the ship-clean + cost number).

---

## 3. Decisions log

Every entry here is backed by a measurement in §4, not by intuition.

| # | Decision | Why | Evidence |
|---|---|---|---|
| D1 | `gemini-3.1-flash-lite` stays the doctrine writer primary | best quality-per-dollar in the field | §4.3 |
| D2 | `gpt-5.4-nano` is writer tier 2 | lowest $/clean of the field, and it is the *other vendor* | §4.3 |
| D3 | `gpt-4.1-mini` dropped from every chain | worst clean rate measured | §4.3 |
| D4 | `gemini-3.6-flash` and `gemini-3.5-flash-lite` dropped | no quality gain over cheaper options | §4.4 |
| D5 | Writer primary thinking defaults to MINIMAL, `WRITER_THINKING=LOW` is the lever | LOW wins on quality, MINIMAL wins on cost-per-shipped-email; the trade is a business call | §4.4, §4.5 |
| D6 | Context + anti-ghosting get their OWN, higher chain | they have no exemplar library, and the cheap writer measurably regresses nativeness there | pre-existing cross-language smoke, recorded in the code |
| D7 | Grey-area verticals start at the strongest tier, not the cheapest | their realistic failure is a safety block, not capacity; volume is low so price barely matters | §4.8 |
| D8 | Critic head moved from `@MEDIUM` to `@LOW` thinking | identical verdicts at 2.5x less cost and 3.7x less latency | §4.7 |
| D9 | `gemini-3.1-flash-lite` NOT promoted to critic head despite the best precision at equal recall and lowest price | n=7 planted faults and n=4 controls cannot distinguish judgment quality, and the critic is the one role where a miss ships a bad email | §4.7 |
| D10 | Every chain alternates vendors | a single-vendor chain shares one quota pool and one incident page — that is not a fallback | §4.4 (the TPM finding), §4.8 |
| D11 | Anthropic ban enforced in code, not convention | "we moved off Anthropic" has to be a property the code holds, not a claim in a commit message | `assertNoAnthropic` + 2 test files |
| D12 | Thinking/reasoning headroom added at the transport layer | the cap trap is a vendor property, so the fix belongs where the vendors are, not in each caller | §4.6 |
| D13 | Visual-shape layout taken OUT of the critic's scope (rule 5a rewritten; opener-repetition 5b stays) | the critic's shape verdicts were measured to be noisy — it flagged a structurally-verified conforming draft with a miscounted complaint — and the deterministic linter+shaper own the ship-time floor; `CRITIC_JUDGES_LAYOUT=1` restores | §7.10 |
| D14 | Offline benches suppress the usage ledger via `__setLedgerSuppressedForOfflineRuns` | the aux recorder writes without a usage context by design, so dev runs were landing real rows on the ledger the daily budget cap reads; production is guarded against calling the switch by a source-sweep test | §7.9 |

## 4. Findings / measurements

### 4.1 Live API probe (2026-08-27)

Both keys present in the environment and working: `GEMINI_API_KEY`, `OPENAI_API_KEY`.
`ANTHROPIC_API_KEY` is still set but must not be used.

- OpenAI: Chat Completions + `response_format: {type:"json_object"}` works on every candidate.
  `gpt-5-nano` / `gpt-5-mini` burn heavy **reasoning tokens** on a trivial prompt (576 / 320 for a
  12-token answer) — billed as output, so they are *not* as cheap as their sticker price.
  `gpt-5.4-nano` / `gpt-5.4-mini` returned **0 reasoning tokens** on the same prompt.
- Gemini: `gemini-3.7-flash` **rejects `thinkingLevel: MINIMAL`** (400) — its floor is LOW.
  `gemini-2.5-flash-lite` rejects `thinkingConfig` entirely. Both need per-model thinking floors.

### 4.2 Price table (USD per 1M tokens, verified from vendor pricing pages 2026-08-27)

| Model | Input | Output | Cached in | Note |
|---|---|---|---|---|
| gpt-5-nano | 0.05 | 0.40 | 0.005 | heavy hidden reasoning tokens |
| gemini-2.5-flash-lite | 0.10 | 0.40 | 0.01 | no thinkingConfig |
| gpt-4.1-nano | 0.10 | 0.40 | 0.025 | |
| gpt-4o-mini | 0.15 | 0.60 | 0.075 | |
| **gpt-5.4-nano** | **0.20** | **1.25** | 0.02 | 0 reasoning tokens observed |
| **gemini-3.1-flash-lite** | **0.25** | **1.50** | 0.025 | today's writer primary |
| gpt-5-mini | 0.25 | 2.00 | 0.025 | heavy hidden reasoning tokens |
| gemini-3.5-flash-lite | 0.30 | 2.50 | 0.03 | |
| gemini-2.5-flash | 0.30 | 2.50 | 0.03 | |
| gpt-4.1-mini | 0.40 | 1.60 | 0.10 | |
| **gemini-3-flash-preview** | **0.50** | **3.00** | 0.05 | today's critic |
| **gemini-3.7-flash** | **0.75** | **3.75** | 0.075 | newest flash; price doubles 2027-01-01 |
| gemini-3.6-flash | 0.75 | 3.75 | 0.075 | price doubles 2027-01-01 |
| **gpt-5.4-mini** | **0.75** | **4.50** | 0.075 | |
| *claude-haiku-4-5* | *1.00* | *5.00* | — | today's ack-confirm — **to remove** |
| gpt-5.1 | 1.25 | 10.00 | 0.125 | |
| gemini-3.5-flash | 1.50 | 9.00 | 0.15 | |
| gemini-3.1-pro-preview | 2.00 | 12.00 | 0.20 | |
| gpt-5.4 | 2.50 | 15.00 | 0.25 | |
| *claude-sonnet-4-6* | *3.00* | *15.00* | — | today's fallback everywhere — **to remove** |
| gpt-5.5 | 5.00 | 30.00 | 0.50 | |

**Read:** everything Anthropic does today can be done by a model that is 4x–15x cheaper.
The biggest single win is not the primaries (already Gemini) — it is the **Sonnet-only flows**
(context generator/rewriter, anti-ghosting generator/rewriter, reply sentiment) and the
**Sonnet fallbacks** behind every Gemini primary.

### 4.3 Writer quality A/B, round 1 (2026-08-27)

`node --import tsx src/scripts/bench-llm-quality.ts --max-usd 8 --concurrency 6`
12 languages (en es de pt-BR tr ru el ja zh ar he hi) x 2 verticals (gaming_ua, cps) = **24 cells per model**.
Production prompts, production lint gate. Total spend for the whole round: **$0.53**.

| Model | clean% | pass/fail | $/email | $/clean | mean ms | p95 ms |
|---|---|---|---|---|---|---|
| gemini-3.7-flash @LOW | **70.8** | 17/7 | 0.007214 | 0.010184 | 2321 | 4007 |
| **gemini-3.1-flash-lite @MINIMAL** | **66.7** | 16/8 | **0.001587** | 0.002380 | 1391 | 1739 |
| **gpt-5.4-nano @none** | 54.2 | 13/11 | **0.001229** | **0.002269** | 1745 | 2023 |
| gemini-3-flash-preview @MINIMAL | 54.2 | 13/11 | 0.004865 | 0.008981 | 3037 | 10198 |
| gpt-5.4-mini @none | 50.0 | 12/12 | 0.004464 | 0.008928 | 1628 | 2128 |
| gpt-4.1-mini | 45.8 | 11/13 | 0.002620 | 0.005717 | 2301 | 2982 |

**What this changes:**

1. **flash-lite stays the writer primary.** 66.7% clean at $0.0016 — nothing beats it on
   quality-per-dollar. The repo's earlier claim of 75% was measured on a different language set;
   66.7% here is the number to hold against.
2. **gpt-5.4-nano is a real tier 2**, not a token cross-vendor gesture: 54.2% clean and the *lowest*
   $/clean of the whole field. Its failure mode is specific and repairable —
   `FORBIDDEN-ENGLISH-SINGLETON` was 7 of its 11 failures (it leaves English words in a non-English
   email), which is exactly what the deterministic linter catches and the rewriter fixes.
3. **gemini-3-flash-preview is a bad WRITER** — 54.2% clean at 3x flash-lite's price. It is today's
   *critic* model, which is a different job; it must not be promoted into the writer chain.
4. **gpt-4.1-mini is out.** Worst clean rate in the field. Dropped from every chain.
5. **gemini-3.7-flash is the quality ceiling** at 70.8%, 4.5x the price — the right *step-up* tier 3,
   the wrong default.

Shared failure mode across every model: `LAYOUT-GREETING-RUNON` (4-5 cells each). That is a
deterministic rule the linter catches and the rewriter repairs, and it is model-independent, so it
is not a discriminator between candidates — but it is worth a prompt fix later, independently of
this migration.

### 4.4 Writer quality A/B, round 2 (2026-08-27) — thinking sweep

36 cells per model (12 languages x 3 verticals). Spend: $0.76.

| Model | clean% | err | $/email | $/clean |
|---|---|---|---|---|
| **gemini-3.1-flash-lite @LOW** | **72.2** | 0 | 0.004251 | 0.005886 |
| gemini-3.6-flash @LOW | 66.7 | 0 | 0.010657 | 0.015986 |
| gemini-3.1-flash-lite @MINIMAL | 61.1 | 0 | 0.001683 | 0.002753 |
| gemini-3.5-flash-lite @MINIMAL | 61.1 | 0 | 0.003008 | 0.004922 |
| gpt-5.4-nano @none | 36.1 | 4 | 0.000898 | 0.002487 |
| gpt-5.4-nano @low | 11.1 | **24** | 0.000586 | 0.005270 |

**Finding 1 — thinking is the biggest quality lever on the primary.** Same model, same cells,
`@LOW` vs `@MINIMAL` is **72.2% vs 61.1%**, a paired comparison so the 11-point gap is not sample
noise (the unpaired run-to-run noise on this harness is about +/-6 points: flash-lite@MINIMAL scored
66.7% in round 1 and 61.1% here). It costs 2.5x per draft. Whether that is worth paying is an
END-TO-END question — a dirty draft costs a critic call plus a rewrite — so it is settled by the
pipeline bench (D5), not by this table.

**Finding 2 — the OpenAI account is rate-limit constrained, and that is a routing fact, not a test
artifact.** Both `gpt-5.4-nano` rows are polluted by `429 Rate limit reached ... on tokens per min
(TPM)`. Measured account limits (all models, from the `x-ratelimit-*` response headers):

    x-ratelimit-limit-requests: 500      (RPM)
    x-ratelimit-limit-tokens: 200000     (TPM)

A writer call is ~4.5k input tokens, so the account sustains **~44 writer calls/minute**. Normal
production is far below that (a 15-minute cron over a handful of rows), so OpenAI is a sound tier-2
for ordinary operation. But it means an OpenAI tier **cannot absorb a full Gemini outage at batch
volume** — which is exactly why every chain has a *fourth* tier and why the tier-4 slot is a
different model class (separate capacity accounting), not just a different model name.
**Action:** raise the OpenAI account tier when convenient; until then the 4-tier chains stand.

**Finding 3 — models dropped from every chain:** `gemini-3.6-flash` (66.7% at 2.5x flash-lite@LOW's
price), `gemini-3.5-flash-lite` (same quality as flash-lite@MINIMAL at 1.8x the price),
`gpt-4.1-mini` (worst in round 1). `gpt-5.4-nano@low` is dropped as a *setting*: reasoning effort
made it slower and no better, and burned TPM.

**Finding 4 — gpt-5.4-nano's failure mode is stable and specific:** `FORBIDDEN-ENGLISH-SINGLETON`
was 13 of its 19 lint failures — it leaves English words inside a non-English email. That is a
nativeness weakness the deterministic linter catches every time and the rewriter repairs, so it is
tolerable in a *fallback* tier and disqualifying for a *primary* one.

### 4.5 END-TO-END: the number that decides it (2026-08-27)

`node --import tsx src/scripts/smoke-writer-heal-all-languages.ts --max-usd 6 --concurrency 4`
**All 36 doctrine languages x 2 verticals = 72 cells** — deliberately the identical shape as the
archived Sonnet-era heal runs (`emails-healed-2026-06-24T*.md`), so the two are directly comparable.

The loop is production's: draft -> deterministic lint -> rewrite with the findings -> re-lint
(2 iterations max) -> humanize -> lint the humanized body. SHIP CLEAN counts what would actually
have been sent clean.

| | **Sonnet era** (Jun 2026, archived run) | **Gemini/OpenAI waterfall** (Aug 2026) |
|---|---|---|
| cells | 72 | 72 |
| clean on first draft | — | 42 |
| fixed by the heal loop | — | 22 |
| cleared by the humanizer | — | 5 |
| **SHIP CLEAN** | **70 / 72 = 97.2%** | **69 / 72 = 95.8%** |
| still failing after 2 rewrites | 2 | 3 |
| **cost per shipped email** | **$0.030248** | **$0.002595** |
| tiers that served | — | 114/114 calls on `gemini-3.1-flash-lite` (tier 1) |

> The Sonnet cost column is not a guess. The harness re-prices its OWN observed token counts under
> `claude-sonnet-4-6`'s rate card: identical prompts, identical call counts, only the price list
> differs. What it does not model is whether Sonnet would have needed fewer heal iterations — which
> is exactly why the SHIP CLEAN row is measured separately against Sonnet's own archived run.

## → **91.4% cheaper on the writer stages, for 1.4 points of ship-clean quality (97.2% → 95.8%).**

> **Scope correction (audit, §7.8):** this harness does not run the LLM critic, so the cost figure
> here is the writer stages only — a floor, not the bill. The **true full-pipeline cost is
> $0.011077 per shipped email, 87.2% cheaper than Sonnet**, measured in §7.8 with
> `bench-llm-pipeline.ts`. The quality comparison in this section is unaffected and remains the
> right writer-chain measurement.

That is the compromise. One extra cell in seventy-two needs a human eye, and the LLM bill drops by a
factor of 11.7x.

**The quality is buyable back if you want it.** `WRITER_THINKING=LOW` — one env var, no deploy —
measured on a paired 24-cell run:

| | ship clean | spend (24 cells) | per shipped email |
|---|---|---|---|
| `WRITER_THINKING` unset (MINIMAL, default) | 22/24 = 91.7% | $0.0709 | $0.00295 |
| `WRITER_THINKING=LOW` | **23/24 = 95.8%** | $0.1586 | $0.00661 |

LOW buys ~4 points of ship-clean for 2.2x the draft cost — still **~78% cheaper than Sonnet**. It is
left OFF by default because the cheaper draft wins on total cost per shipped email, and because that
trade is a business call rather than an engineering one.

### 4.6 A real bug the E2E testing caught: the thinking-budget trap

**Gemini counts thinking tokens against `maxOutputTokens`. OpenAI counts reasoning tokens against
`max_completion_tokens`.** So a caller that sizes the cap to its *answer* is silently also capping the
model's reasoning — and the failure is not an error:

- **Gemini** returns a **truncated string**, which arrives as unparseable JSON.
- **OpenAI** returns `finish_reason=length` with an **empty message**, so the tier looks broken.

I introduced this by putting `@LOW` thinking on `reply_sentiment`, whose caller asks for
`maxOutputTokens: 200` because its answer is ~35 tokens. Measured on the real task,
`gemini-3-flash-preview@LOW` spends **138–181 thinking tokens**. 200 − 181 = 19 tokens left for a
35-token answer. It failed roughly half the time — the worst way for something to be wrong.

The waterfall *did* cover it (the answer arrived from tier 2), which is the system working, but it was
burning a tier on every other reply classification.

**Fixed at the transport layer**, so it protects every caller and every future role:
`budgetForThinking()` in `lib/gemini.ts` and `budgetForReasoning()` in `lib/openai.ts` add headroom
above the caller's cap when reasoning is on (0 for MINIMAL/none, 1024/2048/4096/8192 by level). They
never *lower* a cap, and unused headroom costs nothing — only generated tokens bill.

Verified: **27/27** live calls now succeed at `maxOutputTokens: 200` across all three
`reply_sentiment` tiers, and all three tiers returned the **same verdict** on all three test replies
(negative / positive / ooo) — which is the property you actually want from a safety-critical
classifier's fallback chain.

Locked by 4 regression tests, including a structural one asserting that every tightly-capped role
(`ack_confirm` 32, `reply_sentiment` 200, `summarizer` 300) has ≥512 tokens of headroom on every
tier of its chain that reasons at all.

### 4.7 Critic A/B — `@MEDIUM` was buying nothing

`scripts/bench-llm-critic.ts` — 7 drafts each planted with one doctrine fault the deterministic
linter *cannot* catch, plus 2 clean controls, x2 repeats. Final run, with controls that are real
pipeline output (see the fixture note below):

| Model | recall | named | precision | false flags | $/call | latency |
|---|---|---|---|---|---|---|
| gemini-3.1-flash-lite @LOW | 100% | 100% | 75% | 1/4 | $0.003016 | 4,122 ms |
| **gemini-3-flash-preview @LOW** | 100% | 100% | 25% | 3/4 | **$0.003619** | **3,125 ms** |
| gemini-3-flash-preview **@MEDIUM** | 100% | 100% | 25% | 3/4 | $0.009765 | **12,598 ms** |
| gpt-5.4-mini @low | 100% | 100% | 0% | 4/4 | $0.004129 | 3,447 ms |

**Decision: critic head moved from `@MEDIUM` to `@LOW`.** On the corrected fixture the two are
*identical on every quality axis* — same recall, same naming, same precision, same misses (none) — at
**2.7x the cost and 4x the wall-clock**. The latency is the part that stings: the critic runs inside a
180-second per-row generation deadline (`lib/generationDeadline.ts`), so a 12.6-second critic spends
7% of a row's entire budget for nothing. Override with `CRITIC_THINKING` if a future battery finds a
fault class only deeper thinking catches — but bring the battery.

Every candidate caught every planted fault *and* named it well enough for the rewriter to fix the
right thing (the rewriter is driven by `issues`, so naming is not cosmetic).

#### Two things this measurement does NOT license

**`gemini-3.1-flash-lite@LOW` is not promoted to critic head**, despite the best precision and the
lowest price at equal recall. n=7 planted faults and n=4 clean gradings cannot distinguish judgment
quality, and the critic is the one role where a miss ships a bad email. Worth a much larger battery;
not worth a change on this evidence.

**The 25% precision is an observation, not a conclusion.** Read literally it says the critic asks for
a rewrite on 3 of 4 genuinely pipeline-clean drafts, which would be a real production cost driver —
every clean draft reaching the LLM critic pays for a rewrite. But n=4, and this is *pre-existing*
behaviour that the migration did not change. Flagged for a proper investigation with a larger control
set, not acted on here.

#### The fixture was wrong three times, and each time the critics were right

Worth recording, because it nearly produced an expensive wrong conclusion. The first two runs reported
**0% precision for every candidate**, which reads as "the critic demands a rewrite on everything" — a
finding that, if believed, would have justified loosening the critic prompt and shipping worse email.

Both times the critics were correct and the *control* was not clean:

| attempt | control shape | what the critics flagged | verdict |
|---|---|---|---|
| v1 | single-line body | `LAYOUT-GREETING-RUNON` | fixture wrong |
| v2 | greeting on its own line, 1+1+1 blocks, 3 sentences | the doctrine prompt's specific **1+3 block shape and 4-6 sentence count** — which the deterministic linter does *not* check, because checking it is precisely the LLM critic's job | fixture wrong |
| v3 | real drafts from an actual `smoke-writer-heal-all-languages.ts` run that shipped clean through the full production gate | 3/4 flagged (see above) | fixture finally right |

The lesson, written into the bench's own comments so the next person does not repeat it: **a control
has to be clean by the rules the grader is actually applying, and the only reliable source of such a
draft is the pipeline itself.** Do not hand-write replacements; regenerate them from a real run if the
doctrine prompt changes.

One interpretation had to be retracted along the way. On the v2 fixture, `gemini-3.1-flash-lite`
appeared to have better precision, and a per-verdict diagnostic showed it passing a draft the others
flagged — which read as *laxness*, the wrong property for a critic. On the v3 fixture that reading
does not hold: the controls really are clean, so passing them is correct and flagging them is the
error. Same numbers, opposite meaning, because the ground truth changed. The `@MEDIUM → @LOW`
decision never depended on the precision column — it rests on recall, naming, cost and latency, all
of which were measured cleanly and were identical across all three attempts.

### 4.8 Grey-area verticals survive losing their Sonnet pin

The single riskiest change in this migration. Casino / betting / crypto / forex used to be **pinned
to Sonnet** on compliance grounds, and the realistic failure after moving them is not capacity but a
**safety block** — a vendor simply declining the content.

Tested live on the real production prompts, tier 1 of the grey chain:

| vertical | language | served by | result |
|---|---|---|---|
| online_casino | en | `gemini-3.7-flash` (tier 1) | clean draft |
| sports_betting | de | `gemini-3.7-flash` (tier 1) | clean draft |
| crypto | es | `gemini-3.7-flash` (tier 1) | clean draft |
| forex / CFD | ar | `gemini-3.7-flash` (tier 1) | clean draft |

No refusals, no fallbacks needed. And the chain is built for the case where that changes:
`lib/gemini.ts` throws on `promptFeedback.blockReason`, which the router treats like any other tier
failure, so a future Gemini refusal lands on `openai:gpt-5.4-mini` rather than on the floor.

### 4.9 The three residual E2E failures are pre-existing, not migration damage

All three are classes the Sonnet-era runs also failed on (see the archived `emails-healed-*.md`):

- `it/cps` and `id/cps` — `FORBIDDEN-ENGLISH-SINGLETON` ("validate", "model" surviving untranslated)
- `pt-BR/gaming_ua` — `X-NOT-Y` (", não apenas" comma-negation cadence)

Worth a prompt fix, but that is a doctrine-prompt problem, independent of which model writes.


---

### 4.10 A pre-existing gap closed on the way past

Not caused by this migration, but found by it and fixed in code I was already rewriting.

The F-3.7b row-level generation deadline has a documented rule: **a spent row budget is terminal for
the row and must outrank every fail-open path below it.** `followupGenerator.ts` obeys it — its
fail-open critic rethrows `GenerationDeadlineError` rather than shipping the best draft seen, because
"ship the draft anyway" on the strength of a *deadline* would put an un-critiqued email in a client's
inbox.

The **context** and **anti-ghosting** flows never had that guard (verified against `HEAD`: zero
references to `GenerationDeadlineError` in either file before this change). Their critic and rewriter
catches would swallow a deadline and ship the original draft.

The window is narrow — `withGenerationDeadline` races the caller's promise, so the row usually fails
anyway — but it is real: `assertGenerationBudget` can throw slightly *before* the race timer fires,
and in that gap the swallowed error lets a value return and win the race.

Added to both flows (4 catch sites), so all three now obey the same rule. Full suite still green.

## 5. Operating it

### 5.1 Secrets — set on BOTH the Replit workspace and the deployment

| Var | Required? | Notes |
|---|---|---|
| `GEMINI_API_KEY` | **yes** | Serves tier 1 of nearly every role. https://aistudio.google.com/apikey |
| `OPENAI_API_KEY` | **yes** | Serves the cross-vendor tiers. Without it every waterfall runs at half depth. |
| `ANTHROPIC_API_KEY` | no | Unused. Safe to leave set or to delete. The server no longer reads it at boot. |

The server **refuses to start** if both LLM keys are missing, and logs a loud warning if only one is —
because one key means a single-vendor outage stops follow-up generation, which is the exact failure
this migration exists to prevent.

### 5.2 Boot output tells you what is running

`index.ts` resolves and logs all 14 chains before it listens:

    INFO  LLM chain resolved  role=draft  chain=gemini:gemini-3.1-flash-lite@MINIMAL -> openai:gpt-5.4-nano@none -> gemini:gemini-3.7-flash@LOW -> openai:gpt-5.4-mini@none

So "what did this deployment actually run on?" is answerable from the deploy log alone, without
reading the source at the deployed commit.

### 5.3 Levers, in the order you would reach for them

| Want | Do | Cost effect |
|---|---|---|
| More writer quality | `WRITER_THINKING=LOW` | ~2.2x draft cost, +4 pts ship-clean (still ~78% under Sonnet) |
| Change one role's models | `LLM_CHAIN_<ROLE>="gemini:model@LEVEL,openai:model@effort,..."` | as chosen |
| Swap a model everywhere it appears | `GEMINI_FLASH_LITE_MODEL`, `GEMINI_FLASH_MODEL`, `GEMINI_FLASH_37_MODEL`, `OPENAI_NANO_MODEL`, `OPENAI_MINI_MODEL`, `OPENAI_MINI_41_MODEL` | as chosen |
| Slower/faster vendor retries | `GEMINI_MAX_ATTEMPTS`, `GEMINI_TIMEOUT_MS`, `OPENAI_MAX_ATTEMPTS`, `OPENAI_TIMEOUT_MS` | latency only |
| Turn off the ack-confirm LLM call | `FOLLOWUP_ACK_LLM_CONFIRM=0` | saves a fraction of a cent, costs some false FOLLOWUP-ACK rewrites |
| Restore critic layout re-policing | `CRITIC_JUDGES_LAYOUT=1` (set before boot) | re-enables the pre-Aug-2026 rule 5a + removes the focus carve-out; expect noisy layout rewrites to return (§7.10) |

Role names for `LLM_CHAIN_*`: `DRAFT`, `REWRITER`, `CRITIC`, `GREY_DRAFT`, `GREY_REWRITER`,
`CONTEXT_DRAFT`, `CONTEXT_CRITIC`, `CONTEXT_REWRITER`, `AG_DRAFT`, `AG_CRITIC`, `AG_REWRITER`,
`SUMMARIZER`, `REPLY_SENTIMENT`, `ACK_CONFIRM`.

### 5.4 Rollback

There is no "switch back to Anthropic" flag, deliberately — the account is unfunded, so a flag would
only produce 401s. Rolling back means one of:

1. **A single model is bad.** Set that role's `LLM_CHAIN_*` to skip it. No deploy.
2. **A vendor is down.** Nothing to do; that is what the waterfall is for. Watch for
   `LLM tier unavailable ... advancing the waterfall` and `LLM served by a fallback tier` in the logs.
3. **The whole migration is wrong.** `git revert` the range. `lib/anthropic.ts` was deliberately kept
   importable with a lazy client, so the Anthropic path comes back intact the moment the key is funded.

**To re-enable Anthropic when billing is restored:** add a tier to the chain in `lib/modelPolicy.ts`
and delete `assertNoAnthropic`. That is deliberately a visible code edit rather than an env var,
because turning a vendor back on is a billing decision, not a runtime one. Two tests will fail until
you also update them, which is the point: `test-model-policy.ts` ("no built-in chain names an
Anthropic model") and `test-no-anthropic-on-production-paths.ts`.

### 5.5 Before you change any chain

    cd artifacts/api-server
    pnpm run llm:chains        # free, no network — chain invariants
    pnpm run llm:test          # free — 149 assertions across router + policy + guards
    pnpm run llm:smoke         # live, ~$0.013 — proves the waterfall against real vendors
    pnpm run llm:e2e           # live, ~$0.18 — ship-clean rate + cost per shipped email

The last one is the one that decides. First-draft clean rate is a leading indicator; SHIP CLEAN is
the outcome, and a cheaper draft that heals twice is not cheaper.

### 5.6 Known operational limit

The OpenAI account is on **500 RPM / 200,000 TPM** (measured from `x-ratelimit-*` headers, 27 Aug
2026). A writer call is ~4.5k input tokens, so it sustains ~44 writer calls/minute. Ordinary
production is far below that. But an OpenAI tier **cannot absorb a full Gemini outage at batch
volume** — which is why every chain has a fourth tier, and why the tier-4 slot is a different model
*class* (separate capacity accounting) rather than just a different model name.
**Raise the OpenAI account tier when convenient.**


---

## 6. Pre-publish checklist (2026-08-27)

Everything below is done and verified locally. The one thing that is **not** done is a secret only
Michael can set.

### 6.1 ONE THING TO DO BEFORE PUBLISHING

> **Add `OPENAI_API_KEY` to the DEPLOYMENT secrets, not just the workspace.**

It is in the workspace already, which is why every bench and smoke in this document ran. It is not on
the deployment yet.

What happens if it ships without it — verified by booting the real built bundle with the key removed:

    WARN  Only one LLM vendor is configured — every fallback waterfall is running at half depth,
          and a single-vendor outage will stop follow-up generation   geminiConfigured: true
    INFO  Server listening

So it **degrades safely rather than breaking**: the Gemini tiers still serve, and the OpenAI tiers are
skipped without being called. But every chain loses its cross-vendor half, which is the specific
protection this whole migration was built for. Add the key, then publish.

`ANTHROPIC_API_KEY` can stay or go — nothing reads it. Verified by booting the built bundle with it
blank.

### 6.2 Verified locally before handing over

| Check | Result |
|---|---|
| `tsc -b` across the package | clean |
| Full test suite (53 files) | **1,355 assertions, 0 failures** |
| `pnpm run build` (esbuild bundle) | clean, 7.9mb |
| `grep anthropic.messages.create dist/index.mjs` | **0 hits** — not in the shipped bundle |
| Built server boots with `ANTHROPIC_API_KEY=` empty | starts, logs all 14 chains, listens |
| Built server with BOTH LLM keys missing | **refuses to start**, with a message naming the fix |
| Built server with only Gemini | warns loudly, starts |
| `llm:smoke` — 33 live checks incl. real fault injection | **all pass**, $0.013 |
| `llm:e2e` — 72 cells, all 36 languages | **69/72 ship clean**, $0.002595/email |
| Adversarial critic gate on the live chain | 8 passed, 0 failed |

### 6.3 What to run after publishing

On the deployment, in this order:

    cd artifacts/api-server
    pnpm run llm:chains            # free — confirms the deployed chains resolve as expected
    pnpm run llm:test              # free — 1,357 assertions incl. the Anthropic guard
    pnpm run llm:smoke             # ~$0.016 — L4 is the one to watch: it breaks the Gemini key
                                   # on purpose and must be served by openai:gpt-5.4-nano.
                                   # If L4 fails, OPENAI_API_KEY did not reach the deployment.
    pnpm run llm:bench:pipeline    # ~$0.18 — the TRUE cost per shipped email, critic included,
                                   # with the per-role split. This is the one to trust for cost.
    pnpm run llm:e2e               # ~$0.18 — writer-chain ship-clean rate across all 36 languages

Per-flow smokes, if something looks wrong in one product:

    pnpm run llm:smoke:summarizer  # primary vs cross-vendor fallback, language accuracy
    pnpm run llm:smoke:context     # context flow end-to-end ship-clean gate
    pnpm run llm:smoke:critic      # critic chain shape + live transport

Then queue one real test-mode follow-up and read the log line `LLM chain resolved` at boot plus
`Writer produced draft` / `LLM served by a fallback tier` during generation.

**The single most diagnostic check is `llm:smoke` L4.** It is the only one that proves the OpenAI half
of every waterfall is actually reachable from the deployment.


---

## 7. Audit pass (2026-08-27, after the migration was called done)

A full re-read of everything the migration touched. Ten findings, all fixed.

### 7.1 Correctness — the deadline guard was defeated one frame up

The most serious finding. I had added the F-3.7b `GenerationDeadlineError` rethrow to the context and
anti-ghosting **inner** helpers (`rewriteContextDraft`, `rewriteAntiGhostingDraft`) — but the
**outer** catches in `generateContextFollowup` / `generateAntiGhostingFollowup` still swallowed it and
returned the original draft. A guard that rethrows into a catch that swallows is not a guard. The
doctrine flow's rewriter catch had never had one either.

Fixed at all three outer sites, and locked with a **sweep test** (`test-f37b-honest-tick.ts`) that
walks every fail-open log marker in the three generators and asserts the rethrow appears above it.
A new fail-open path added without the guard now fails by name.

### 7.2 Two smoke tests that could not fail

`smoke-summarizer-cheap.ts` and `smoke-context-cheap-chain.ts` were still setting
`SUMMARIZER_PROVIDER` / `WRITER_PROVIDER` / `CRITIC_PROVIDER` to select a "Sonnet baseline" arm.
Those switches no longer exist, so **both arms ran the identical config** and the comparison passed
vacuously. A green smoke that cannot fail is worse than no smoke, because it buys false confidence.

Repurposed to test something real:
- **summarizer** → primary tier vs the **cross-vendor fallback tier**, i.e. what a Gemini outage
  actually degrades to. Live result: **14/14 language accuracy on both**, so an outage will not
  silently produce wrong-language follow-ups.
- **context flow** → a single-config **absolute ship-clean gate** (floor 70%) instead of a delta
  against a baseline that can no longer be produced. Live result: **7/10**; the 3 failures are the
  same pre-existing untranslated-`"test"` singleton class seen in §4.9.

### 7.3 A cost report that had already drifted

`critic-cost-report.ts` carried its own hardcoded price list, already stale against `pricing.ts`.
Now derived from `MODEL_PRICES`, so it cannot drift again, and its candidate set is the real critic
chain rather than the pre-migration one.

### 7.4 The archive was not actually revivable

Moving the four Anthropic-era harnesses one directory deeper broke every `../` import, silently
contradicting the README's "they still typecheck / here is how to revive them". Imports fixed. The
README now states honestly that only **two of four** still compile against the live tree, and gives
the `git log --follow` recipe for running the other two from their own era.

### 7.5 Docs that would actively mislead the next reader

- `lib/gemini.ts` header still said failures "fall back to the Sonnet critic"
- `lib/llmRouter.ts` header documented `runLlmJsonParsed`, a function that no longer exists
- `lib/usageContext.ts` and `services/scheduler.ts` referenced the deleted `recordUsageBestEffort`
- `services/anthropicRetry.ts` had no indication it was retired
- **`replit.md`** — the project's own architecture doc — still described "Draft: Claude Sonnet →
  Critic: Claude Opus → Rewrite: Claude Sonnet" and listed the Replit Anthropic integration vars as
  required. Rewritten to describe the actual waterfall, the deterministic gate that precedes the
  critic, and the real required secrets.
- `modelPolicy.ts` claimed omitting `@level` takes "the per-model default"; it actually takes the
  *transport's* default (`GEMINI_CRITIC_THINKING`, else MEDIUM, for Gemini). Corrected, with advice
  to always write the level explicitly in overrides.

### 7.6 The `source-code/` mirror was stale

Re-synced with the repo's own `source-code/sync.sh`, twice — the repo's convention is that the mirror
tracks `artifacts/`, and a mirror that lags is a trap for anyone reading it as the source of truth.

### 7.7 A fixture that was wrong for the fourth time

`adversarial-critic.ts`'s clean control was the same hand-written single-line body that broke
`bench-llm-critic.ts` three times — itself a layout violation, so the critic flagged it correctly and
the gate reported a false positive. Replaced with real pipeline output.

### 7.8 THE HEADLINE NUMBER HAD A SCOPE GAP — now measured

The most consequential finding, and it corrects §4.5.

`smoke-writer-heal-all-languages.ts` runs draft → deterministic lint → rewrite → lint. **It never
calls the LLM critic**, because it deliberately replicates the *deterministic* heal loop. That makes
it the right tool for comparing writer chains and the **wrong tool for costing production**, which
runs the critic on every deterministically-clean draft and rewrites again when the critic says so.

So the §4.5 figure of **$0.002595/email is a floor, not the bill.**

Diagnosis of why the critic fires so often: the writer prompt injects a randomized per-thread layout
*directive* (`selectLayoutProfile`, e.g. "greeting alone, blank, one opening sentence, blank, then
three sentences with a soft break after the first"). The **critic judges against that full
directive**, but the deterministic linter and `shapeFollowupBody` only enforce a much weaker floor
(greeting on its own line, more than one block) — verified directly: the shaper left a
critic-flagged body **byte-identical**. So the critic demands rewrites for layout that the ship gate
does not require and the shaper will not fix.

That is **pre-existing** — the critic prompt and the shaper are both unchanged by this migration —
but it is a real cost driver and my cost claim did not account for it.

Closed by building `scripts/bench-llm-pipeline.ts`, which drives the **real `generateFollowupEmail()`**
(critic, ack-confirm, humanizer, everything) and totals every billed call underneath via a new opt-in
router observer (`setLlmCallObserver`, off in production, 2 tests). It reports the **per-role cost
split** — the column the writer-only harness structurally cannot show.

#### The corrected end-to-end number

`node --import tsx src/scripts/bench-llm-pipeline.ts` — 10 languages x 2 verticals = 20 cells through
the **real** `generateFollowupEmail()`:

| | writer-only harness (§4.5) | **full pipeline (true)** |
|---|---|---|
| LLM calls per follow-up | ~1.6 | **3.00** |
| ships clean | 95.8% (72 cells) | 80% (20 cells) |
| **cost per shipped email** | $0.002595 | **$0.011077** |
| same tokens on `claude-sonnet-4-6` | $0.030248 | **$0.086** |
| **cheaper than Sonnet** | 91.4% | **87.2%** |

**The saving holds — 87.2%, not 91.4%.** The direction and the order of magnitude are unchanged; the
absolute per-email cost is **4.3x** what §4.5 reported, because §4.5 omitted the critic stage.

#### Where the money actually goes

| role | calls | cost | share |
|---|---|---|---|
| **critic** | 22 | $0.118629 | **66.9%** |
| draft | 20 | $0.033136 | 18.7% |
| rewriter | 14 | $0.024921 | 14.1% |
| ack_confirm | 4 | $0.000547 | 0.3% |

**The critic is two thirds of the LLM bill.** That reframes the whole cost picture: the writer chain
— which is where nearly all the tuning effort in §4.3–§4.5 went — is under a fifth of spend. The
critic stage is now the only lever that matters, and there are two credible moves on it, neither of
which should be made without a bigger battery than the one in §4.7:

1. **Promote `gemini-3.1-flash-lite@LOW` to critic head.** It measured 100% recall, the best
   precision, and the lowest price of the field. Deferred under D9 on n=18; the fact that the critic
   is 67% of spend makes that battery worth running properly.
2. **Stop the critic judging the layout directive** (the diagnosis above). Every layout rewrite it
   demands is work the deterministic shaper neither requires nor performs.

A note on the clean rate: 80% here vs 95.8% in §4.5 is not a regression, it is a different
measurement. §4.5 lints the humanized body after up to 2 deterministic heal iterations; this bench
lints whatever the full pipeline returns, and the pipeline stops as soon as the LLM critic is
satisfied — which is not the same gate. The 4 dirty cells are all `FOLLOWUP-ACK` on ru/hi, the same
pre-existing class as §4.9.


---

## 8. Audit round 2 (2026-08-27, xhigh)

### 8.1 Offline runs were writing to the production ledger — fixed

`bench-llm-pipeline.ts`'s header claimed "nothing reaches the followup_usage ledger" because the
pipeline recorders no-op without a usage context. **The claim was wrong for aux rows**: the aux
recorder (ack-confirm, summarizer) writes WITHOUT a context by design — that is its production
contract — so each bench run was landing real rows on the ledger the daily budget cap reads, and
`smoke-summarizer-cheap.ts` was landing 28 per run.

Fixed with `__setLedgerSuppressedForOfflineRuns()` in `usageTracker.ts`: an in-process switch the two
offline drivers flip at startup. Dunder-named because production must never call it — and that is
enforced, not hoped: the guard test now sweeps every file reachable from `index.ts` and fails if any
of them references the switch. A service that could silently stop recording spend would defeat the
budget cap, so the seam is locked the same way the Anthropic ban is.

### 8.2 The critic's layout judging was noisy — descoped, measured, reversible

The v4 fixture work (below) produced a control draft **structurally verified** — by a sentence/block
counter, no LLM involved — to match its seeded layout directive exactly (`tight-soft`, pattern [1,3],
soft break after sentence 1). The critic still flagged it, with a **miscounted** complaint ("the
second block is two sentences" — it is one, then two after the soft break, exactly as directed). So
the critic was not merely strict about layout; it was WRONG about it, and every false flag buys a
rewrite + re-critique cycle inside the 180s row budget.

The division of labour was already deterministic at ship time — the linter catches greeting-run-on /
single-block BEFORE the critic, the shaper guarantees the floor AFTER it — so visual shape was taken
out of the critic's scope in both places it was ordered:

- **rule 5a of the critic system prompt** (followupPrompts.ts) rewritten: visual shape out of scope,
  `layout` score key kept for rule 5b
- **the critic focus clause** (criticProvider.ts) sharpened to match

with one deliberate carve-out: **rule 5b, opener repetition across the thread, stays with the critic**
— it stores its verdict in the `layout` score but it is content judgment no regex can make, and the
first draft of the descoping clause would have wrongly suppressed it.

Reversible with `CRITIC_JUDGES_LAYOUT=1` (set before boot).

**A finding inside the finding:** the first attempt changed only the focus clause, leaving rule 5a
contradicting it — and a pipeline re-run showed no behaviour change. Two contradictory instructions
resolve model-dependently. The lesson: descope at the source instruction, not by appending a
counter-instruction.

### 8.3 Precision, the full arc — the judge was fine; the fixture and its scope were not

| fixture | clean-control precision (head model) | what was actually wrong |
|---|---|---|
| v1 hand-written, single line | 0% | control violated the linter floor |
| v2 hand-written, layout-ish | 0% | control violated the block-shape directive |
| v3 real pipeline output | 25% | control passed the ship gate but not the directive the critic was ORDERED to judge |
| **v4 structurally verified + descoping** | **100%** | nothing |

Final battery (v4 controls, 7 planted faults x2, 2 controls x2):

| model | recall | named | precision | $/call | ms |
|---|---|---|---|---|---|
| **gemini-3-flash-preview @LOW** (production head) | **100%** | **100%** | **100%** | $0.003546 | 3,126 |
| gpt-5.4-mini @low | 100% | 100% | 75% | $0.003899 | 4,187 |
| gemini-3.1-flash-lite @LOW | 100% | 100% | 75% | $0.002948 | 4,557 |

Re-confirmed under the FINAL config (rule 5a rewritten + sharpened focus clause): the head model
again scored **100% recall / 100% named / 100% precision, 0 false flags**, and the full adversarial
battery WITH the rewrite phase ran **11 passed, 0 failed** — every planted fault caught and healed,
clean control passing. (The §8.4 cost figures were measured under the focus-clause-only config; the
final config was verified for correctness rather than re-costed, since the descoping only removes
work.)

The production critic head posts a perfect scorecard. The v4 controls are pinned into
`bench-llm-critic.ts` AND `adversarial-critic.ts` (which had the same v1-era control; its standing
"clean control flagged" warning is gone — first fully clean adversarial run: **7 passed, 0 failed,
0 warnings**).

### 8.4 What the cost picture actually is — a correction to §7.8's implication

§7.8 implied layout churn was where the critic's 66.9% of spend went. Re-measured: **it is not.**
With the descoping clause active, the pipeline bench moved from $0.011077 to $0.011312 per shipped
email (noise), critic share 66.9% → 66.3%. The critic's share is **structural**: one critic call per
draft at ~3x a draft's price, driven by its ~8.7k-token system prompt (the full doctrine rubric +
per-language tables) plus thinking — not by rewrite cycles. The descoping earns its keep on
JUDGMENT QUALITY (no more rewrites of good drafts on miscounted grounds), not on the bill.

The real critic-cost levers, still deliberately NOT pulled without a larger battery:
1. a cheaper critic head (flash-lite measured 100/100/75 here — n is still too small for the one
   role where a miss ships a bad email),
2. slimming the critic prompt (the deterministic linter already owns most of the rubric it carries).

### 8.5 Smaller fixes in this round

- `getCriticProvider()` — dead export (nothing called it), removed.
- `chiefSpend.vendorForModel` verified against the live chains: gemini-/gpt- both mapped; only
  o1-/o3- of the o-family are named, but no chain uses o-series — fine as is.
- Stale "Sonnet/Opus pipeline" headers fixed in `contextFollowupPrompts.ts`,
  `antiGhostingFollowupPrompts.ts`, `competitorLibrary.ts` (x2), `circuitBreaker.ts`.
- Context/AG critic prompts confirmed layout-free — the noise problem was doctrine-flow-only.
- Root helper scripts (`prepublish-check.sh`, `smoke-budget.sh`) confirmed clean of dead LLM env vars.
