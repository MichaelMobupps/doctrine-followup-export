# Diagnostic F-D3 — were these behaviours ever different? (2026-08-05)

Repo: Email Followupper (Doctrine Follow-up). Read-only order; the only writes
are this file and a blast-radius entry in TODO.md. Every claim below carries a
commit hash and date, or the explicit statement "no commit anywhere on any ref
ever contained this". Search space: all refs (`--all`), the shallow-boundary
tree `962d47d` (2026-04-08, earliest state visible in this clone), and the
three unreachable commits from `git fsck` (`845543a`, `79a3619`, `9f49ade`).

---

## TOP: "existed and vanished" census (step 8)

**Zero confirmed rollbacks.** Nothing newer ever vanished leaving something
older in its place. Everything that ever disappeared from this codebase is
listed below; in every single case the thing that replaced it is the *newer*
work, and the removal is recorded in a commit:

| What vanished | Vanished at | Replaced by / reason |
|---|---|---|
| Test mode | `84a4b7a`/`3eb2e64` 2026-04-16, `a821d8b`/`44bfbe4` 2026-04-20 | deliberate feature removal, four commits |
| Critic model `claude-opus-4-6` (active) | `ecdad0c` 2026-04-20 | newer `claude-opus-4-7` |
| Inline model literals | `e4934c4` 2026-05-08 | centralized `MODEL_*` constants |
| Bulk send-now cap 100 | `0523bd1`/`2868302` 2026-05-08 | lowered to 25, comment records "Phase 6: lowered from 100 → 25" (doctrine.ts:969) |
| `followups.tsx`, `prospects.tsx` pages | `4d413fe` 2026-05-08 16:00 | `pipeline.tsx` + expanded `accounts.tsx` (same-day stash `845543a` confirms it was WIP→landed) |
| drizzle migration files `lib/db/drizzle/*` | `725f93f` 2026-05-17 | schema-push workflow |
| 3D tilt / staggered animations | `0e21c6f`, `561b417`, `d770248` 2026-05-18 | deliberate UI flattening |
| Critic model `claude-opus-4-7` (active) | `cd1cc9f` 2026-05-31 | newer `claude-opus-4-8` |
| ENGLISH-TOLERANT / ENGLISH-HEAVY language carve-outs | v3 critic rewrite (followupPrompts.ts history 2026-05-14 → 06-08) | stricter all-35-languages standard; the removal is stated inside the prompt text itself (followupPrompts.ts:264) |
| Critic model `claude-opus-4-8` (active) | `9383374` 2026-06-11 | Opus **banned as critic on cost grounds**; `MODEL_CRITIC` → `claude-sonnet-4-6`, enforced by `assertCriticModelAllowed()` (anthropic.ts:67-71) and `test-critic-no-opus.ts` |
| "0 = unlimited" follow-up cap convention | removed from scheduler/context per followupLimits.ts:8-11 (created `772d9e6` 2026-06-09) | **partial removal**: `doctrine.ts:25-26` still keeps a local `getFollowupCap` with the old convention — divergence, not rollback; flagged in PA-1 |
| `doctrine-integration/doctrineFollowupLabel.ts` | `f9a290a` 2026-06-24 | module retired |
| Legacy redirect status 308 | `cf6c06e` 2026-08-02 17:10 | 307 (L1a, rollback-safety; ROADMAP mandates it). 308 lived exactly 10 minutes on an unpublished branch (`e1766f1` 17:00 → `cf6c06e` 17:10) |

---

## 1. Blast radius

Read: every ref, the reflog, three dangling commits, and file contents at
eleven historical epochs. Written: `diagnostic.md` (this file), one entry in
`TODO.md`. Not touched: tracked source, database, secrets, deployments, the
running workflow, the add-on.

## 2. Non-platform commits from 2026-07-20 onwards (all refs)

| Hash | Date | Subject | Class |
|---|---|---|---|
| `858102c` | 2026-07-30 | Snapshot 2026-07-30 - fresh history | migration |
| `e1f594e` | 2026-07-31 | docs: add ROADMAP.md and TODO.md | docs |
| `783564d` | 2026-07-31 | Bundle 1: centralize public URL | migration |
| `d812614` | 2026-07-31 | Bundle 2: BASE_PATH prefix, dark | migration |
| `12af611` | 2026-07-31 | Cutover C1: dashboard build base | migration |
| `e1766f1` | 2026-08-02 | Repair L1: legacy address survival | migration |
| `cf6c06e` | 2026-08-02 | Repair L1a: 308 → 307 | migration |
| `918d996` | 2026-08-02 | Repair L1b: pin redirect status | migration (test-only) |

**No behaviour bug fixes exist as standalone commits in this window.** But on
this repo, Replit checkpoint publishes carry real work. Three publishes since
07-20 contain app changes; the rest (`da507e9`, `cf5725f`, `e7d3e2a`,
`c819103`, `bd06214`, `5088adb`) touch zero app files:

| Hash | Date | Hidden content | Class |
|---|---|---|---|
| `65f4529` | 2026-07-23 | spamRiskLint.ts + send-time spam gate, +2720 lines ("2026-07-23 deliverability incident") | **fix/feature** |
| `dbd7e7e` | 2026-07-29 | `pool.on("error")` handler — daily crash-loop fix (lib/db/src/index.ts:40) + anti-ghosting UI | **fix** |
| `c942f1a` | 2026-07-29 | HTML `Cache-Control: no-cache` — stale-UI-after-republish fix (app.ts:161-176) | **fix** |

## 3. Fix-string archaeology

| String / identifier | First entered | Ever left? | At HEAD |
|---|---|---|---|
| `assessSpamRisk`, `spamGateEnabled`, `spamGateMode`, `SPAM_GATE_MODE` | `65f4529` 2026-07-23 | never | scheduler.ts:40,550-551 — **never existed before** |
| `Cache-Control: no-cache` (app.ts) | `c942f1a` 2026-07-29 | never; extended by `d812614` (Bundle 2 prefixed mount, app.ts:213) | app.ts:161,170,176,213 — **never existed before, then evolved** |
| `pool.on("error")` (lib/db) | `dbd7e7e` 2026-07-29 | never | lib/db/src/index.ts:40 — **never existed before** |
| `legacyRedirectTarget`, 308 | `e1766f1` 2026-08-02 17:00 | 308 → 307 at `cf6c06e` 17:10 | 307 pinned by test (`918d996`) — **existed and evolved** |

## 4–5. The never-changed list, proven value by value

For each behaviour: today's code default and every value any commit on any ref
(and every unreachable commit) has ever held.

| Behaviour | Today | Every value ever | Verdict |
|---|---|---|---|
| Hourly send cap | `DOCTRINE_HOURLY_SEND_CAP` default **30** (sendBudget.ts:55) | 30 only. Created `2868302` 2026-05-08; `-G` finds no other touch. Before 2026-05-08 **no cap mechanism existed** (boundary tree `962d47d` has none) | **single value ever** → production deviation = configuration |
| Daily send cap | default **200** (sendBudget.ts:56) | 200 only, same commits | **single value ever** |
| Bulk send-now cap | **25** (doctrine.ts:972) | 100 (from `ab72168` 2026-05-08) → 25 (`0523bd1`/`2868302` same day) | evolved once, 25 is newest |
| Cron batch size | `.limit(20)` (scheduler.ts:171) | 20 only, present at boundary `962d47d` 2026-04-08, never touched | **single value ever** |
| Follow-up stage cap | `HARD_FOLLOWUP_CAP = 3` (followupLimits.ts:21) | 3 only since creation `772d9e6` 2026-06-09 | **single value ever** |
| Scheduling window hours | 8–18 UTC defaults (timingEngine.ts:97-98,113-114) | 8/18 only — present at boundary `962d47d` 2026-04-08, in both dangling stash trees, never touched | **single value ever** |
| Scheduling days | `DEFAULT_SEND_DAYS = [1,2,3,4,5]` (scheduleWindow.ts:19, timingEngine.ts:22) | Mon–Fri only, present at boundary, never touched | **single value ever** |
| Stage day bands | `{3,7},{10,14},{21,28}…{120,126}` (timingEngine.ts:24-35) | identical at `962d47d` 2026-04-08; only other touches `bd82a61`/`9d906dd` 2026-05-08 kept values | **single value ever** |
| Bounce classifier | bounceDetection.ts whole file | created `833bd09` 2026-06-02; zero modifications since (only the snapshot re-add `858102c`); **no bounce logic existed anywhere before 2026-06-02** (`git log --all --before=2026-06-01 -S'bounce'` over the app tree: empty) | **single implementation ever** |
| Structural lint toggle | `STRUCTURAL_LINT_ENABLED` default ON, `STRUCTURAL_MAX_SENTENCES` 7 (structuralLint.ts:291,299) | ON/7 in all five commits touching the file (`95e0680` 06-10 creation, `6b3ffae`/`152423a` 06-14, `5cfd63d` 06-24, `858102c`) | **single value ever** |
| Discourse marker autofix wiring | not wired; detector-only + LLM rewrite (doctrineLint.ts:414) | `git log --all -S'autoFixRepeatingDiscourseMarkers'` over services/ and routes/: **empty**. In every tree ever (incl. dangling `9f49ade`) the only non-test references are the lib file itself and its source-code mirror copy | **no commit anywhere on any ref ever wired it** |
| Lint-stage selection (main generator) | doctrine+nativeness, structural, competitor-script, spam-risk (followupGenerator.ts:527-537) | strictly additive: doctrine+nativeness `f157812` 05-14 → +structural `95e0680` 06-10 → +competitor-script `73e6b2c` 06-22 → +spam-risk `65f4529` 07-23. No stage ever removed | additive only |
| Lint-stage selection (context & anti-ghosting generators) | doctrine+nativeness + spam-risk only | `git log --all -S'detectStructuralViolations'` on both files: **empty** — structural/competitor lint **never existed there** | they never had the full stack; not a regression |
| Critic criteria | v3 c10, v4 c11-13, v4.2 13a-k, v4r3 c14 (followupPrompts.ts:276-286) | additive across the file's history (05-14 ×4, 05-17 ×2, 06-04, 06-08, 06-09 ×2, 07-23); file content at HEAD is identical to old tip `da507e9` | additive only |
| maxHealingIterations | 2 (followupGenerator.ts:523) | 3 (`f157812` 05-14) → 2 (`5cfd63d` 06-24) | evolved once, 2 is newest |
| Send gate mode | `SPAM_GATE_MODE` default `"block"` (spamRiskLint.ts:651) | "block" only since creation `65f4529` 07-23 | **single value ever** |

### Model chains (generation, critique, classification)

| Role | Chain (every value ever, with hashes) | Today |
|---|---|---|
| Critic (Anthropic path) | `claude-opus-4-6` (≤`962d47d` 04-08) → `claude-opus-4-7` (`ecdad0c` 04-20; centralized as `MODEL_CRITIC` in `e4934c4` 05-08) → `claude-opus-4-8` (`cd1cc9f` 05-31) → `claude-sonnet-4-6` (`9383374` 06-11, Opus banned + `MODEL_CRITIC_FALLBACK` added) | `claude-sonnet-4-6` (anthropic.ts:72) |
| Critic (provider) | knob `CRITIC_PROVIDER` entered `caeb572` 06-10 default `"anthropic"` → default flipped to `"gemini"` `304a787` 06-11; `GEMINI_CRITIC_MODEL` default `gemini-3-flash-preview` since 06-10, never changed | gemini / `gemini-3-flash-preview` (gemini.ts:34) |
| Writer (provider) | hardcoded Anthropic until `WRITER_PROVIDER` entered `6b3ffae` 06-14, default `"gemini"` from day one | gemini (writerProvider.ts:88) |
| Writer primary model | `gemini-3.5-flash` (`6b3ffae` 06-14) → `gemini-3.1-flash-lite` (`b490315` 07-15) | `gemini-3.1-flash-lite` (writerProvider.ts:98) |
| Writer secondary model | `gemini-3.1-pro-preview` since `6b3ffae`/`73e6b2c`, never changed; tier OFF unless `WRITER_GEMINI_SECONDARY` | `gemini-3.1-pro-preview` (writerProvider.ts:102) |
| Writer/rewriter/draft (Anthropic constants) | `claude-sonnet-4-6` since ≤04-08 (inline) / `e4934c4` 05-08 (constants), never changed | `claude-sonnet-4-6` ×12 constants (anthropic.ts:65-102) |
| Summarizer | `claude-sonnet-4-6` (≤04-08) → provider knob `SUMMARIZER_PROVIDER` entered `b490315` 07-15, default gemini / `gemini-3.1-flash-lite` | gemini / `gemini-3.1-flash-lite` (emailSummarizer.ts:44,47) |
| Reply classifier | `MODEL_REPLY_CLASSIFIER = claude-sonnet-4-6` since `9a7458c` 06-08, never changed | same |
| Ack-confirm | `ACK_CONFIRM_MODEL` default `claude-haiku-4-5` since `27d63c3` 06-24, never changed | same (followupAckConfirm.ts:32) |

`claude-opus-4-8`, `-4-7`, `-4-6`, `claude-opus-5-0` etc. surviving at HEAD are
pricing-table rows (pricing.ts:23-28), comments, and test fixtures — not
callable paths; `assertCriticModelAllowed()` blocks Opus at every critic site.

## 6. Environment variables that can change these behaviours

The check-against-Secrets-pane list. Full ~60-var inventory with read sites
verified; the behaviour-relevant subset:

| Variable | Default when unset | Unset behaviour |
|---|---|---|
| `DOCTRINE_HOURLY_SEND_CAP` | 30 | falls back to 30; invalid → warn + 30 |
| `DOCTRINE_DAILY_SEND_CAP` | 200 | falls back to 200; invalid → warn + 200 |
| `SEND_HOUR_START` / `SEND_HOUR_END` | 8 / 18 (UTC) | fall back; per-user DB settings win when set |
| `FOLLOWUP_<n>_MIN_DAYS` / `_MAX_DAYS` | stage table {3,7}…{120,126} | fall back per stage; per-user `stageTiming` wins |
| `STRUCTURAL_LINT_ENABLED` | ON | only `0/false/no/off` disables the whole structural layer |
| `STRUCTURAL_MAX_SENTENCES` | 7 | invalid/≤0 → 7 |
| `SPAM_LINT_ENABLED` | ON | off → spam layer inert AND send gate can never trip |
| `SPAM_GATE_ENABLED` | ON | off → high-risk drafts ship |
| `SPAM_GATE_MODE` | `block` | only exact `warn` weakens it; typos → block |
| `SPAM_CHECK_FOLLOWUP_COUNT` (+ `_TRIGGERS/_LISTS/_SHOUTING/_MONEY/_LINKS/_SUBJECT`) | ON each | per-rule off switches |
| `WRITER_PROVIDER` | `gemini` | only exact `anthropic` forces Sonnet-only chain |
| `CRITIC_PROVIDER` | `gemini` | only exact `anthropic` forces Sonnet critic; gemini path has 3-failure/60s circuit breaker to Sonnet |
| `SUMMARIZER_PROVIDER` | `gemini` | only exact `anthropic` forces Sonnet |
| `GEMINI_WRITER_PRIMARY_MODEL` | `gemini-3.1-flash-lite` | fallback literal |
| `GEMINI_WRITER_SECONDARY_MODEL` | `gemini-3.1-pro-preview` | fallback literal |
| `GEMINI_CRITIC_MODEL` | `gemini-3-flash-preview` | **frozen at import** — a live secret change needs a restart |
| `GEMINI_SUMMARIZER_MODEL` | `gemini-3.1-flash-lite` | fallback literal |
| `GEMINI_WRITER_PRIMARY_THINKING` / `_SECONDARY_THINKING` / `GEMINI_CRITIC_THINKING` | MINIMAL / LOW / MEDIUM | invalid values silently fall back to those defaults |
| `GEMINI_MAX_ATTEMPTS` / `GEMINI_TIMEOUT_MS` | 3 / 60000 | clamped [1,6] / [5000,300000] |
| `GEMINI_API_KEY` | none | **absence silently reshapes the pipeline**: writer chain collapses to Anthropic-only, critic falls back to Sonnet, summarizer to Sonnet — behaviour that looks exactly like "the old (pre-Gemini) app" |
| `WRITER_EXEMPLARS` / `WRITER_EXEMPLAR_COUNT` | on / 2 (clamp 1-4) | only exact `off` disables |
| `WRITER_COMPETITORS` / `WRITER_COMPETITOR_COUNT` | on / 8 (clamp 3-16) | only exact `off` disables |
| `WRITER_GREY_VERTICALS` / `WRITER_GREY_SCAN_BODY` | [] / off | grey-list off by default; body scan needs exact `on` |
| `WRITER_GEMINI_SECONDARY` | off | Pro tier needs `on/1/true/yes` |
| `FOLLOWUP_ACK_LLM_CONFIRM` | enabled | only literal `"0"` disables; **frozen at module load** |
| `ACK_CONFIRM_MODEL` | `claude-haiku-4-5` | `??` → empty string would be honored (and fail); frozen at load |
| `DOCTRINE_DAILY_BUDGET_USD` | 500 (app_settings row wins over env) | invalid → 500, never crashes |
| `DOCTRINE_BUDGET_TZ` | `Asia/Jerusalem` | budget-day boundary only |
| `PROMPT_CACHE_TTL` | `1h` | only exact `5m` changes it; frozen at load |
| `BASE_PATH` | `/` (legacy layout) | unset = pre-cutover behaviour by design (rollback path); malformed → fail-safe `/` |
| `DOCTRINE_LABELS` | `doctrine` | label-scan fallback when per-user label empty |
| `SENDER_EMAIL` / `SENDER_NAME` | "" / `Team` | legacy sync skipped when unset with no connected users |
| `GOOGLE_REFRESH_TOKEN` | none | legacy single-account sync path disabled |
| `ADMIN_EMAILS` / `ADMIN_API_KEY` / `ADDON_API_KEY` | none | admin surface off (fail-closed 500s); add-on gets 500s |
| `ALLOWED_LOGIN_DOMAINS` | 4 Mobupps/WMAdv domains | fallback list |
| Hard-fail-at-boot vars | `PORT`, `DATABASE_URL`, `ANTHROPIC_API_KEY`, `AI_INTEGRATIONS_ANTHROPIC_*`, TZ≠UTC | process refuses to start — cannot mimic a rollback, only an outage |

Freshness caveat: `GEMINI_CRITIC_MODEL`, `FOLLOWUP_ACK_LLM_CONFIRM`,
`ACK_CONFIRM_MODEL`, `BASE_PATH`, `PUBLIC_URL`, `PROMPT_CACHE_TTL` are read at
module load; the lint/provider/thinking knobs are read per call. A secret edit
without re-publish changes only the latter group.

## 7. The Apps Script add-on

**What the repo copy does**: four `.gs` files calling nine endpoints
(`/api/stats`, `/api/prospects`, `/api/followups`, `/api/prospect/by-thread/…`,
`/api/sync`, `/api/queue-batch`, `/api/queue` ×2, `/api/cancel` ×2 — 5 GET,
4 POST) via `BACKEND_URL` Script Property + `x-api-key` header. All paths are
literal unprefixed `/api/...`; they work only because app.ts:97 keeps the
unconditional legacy `/api` mount (the comment at app.ts:78-96 names this
add-on as the reason it must never become a redirect).

**Version determination**: impossible from this repo. No VERSION constant, no
build stamp, no custom User-Agent, no manifest version; `.clasp.json` scriptId
is the placeholder `YOUR_APPS_SCRIPT_ID_HERE`. What would settle it: the Apps
Script project's version history at script.google.com (or `clasp deployments`
after filling in the real scriptId), compared against `addon/` file contents —
`Actions.gs` (mtime 2026-04-28, per-user sync scoping) is the newest file and
the discriminator: an old deployment posts `/api/sync` without the
`{email}` body.

**Can an old deployed add-on mimic an app regression? Yes, concretely**:
(1) pre-04-28 copies fire all-tenant syncs that time out as more accounts
connect ("sync broke"); (2) any 401/500 renders as "Not a tracked email"
(ContextualTrigger.gs:22-24 swallows all errors); (3) the status ladder knows
only `queued/sent/failed/cancelled` — `drafted`/`pending_approval`/`generating`
rows render as "—", so mid-pipeline work looks like nothing is scheduled;
(4) stage-timing labels are hardcoded "3-7 / 10-14 / 21-28 days"
(BatchView.gs:51-53) regardless of per-user retuning — reads as "my settings
were reverted"; (5) stats/batches are install-wide (no `userId` param sent) —
"wrong numbers"; (6) cancel on non-queued rows reports success with 0 effect;
(7) no card refresh after actions — "the button does nothing". Every one of
these is visible in Gmail while the server runs the newest code.

## Conclusion

- The **only** behaviour values that ever changed are: bulk send-now cap
  100→25 (05-08), healing iterations 3→2 (06-24), redirect 308→307 (08-02),
  and the model/provider chain (04-20, 05-08, 05-31, 06-10, 06-11, 06-14,
  06-24, 07-15). In every case today's value is the newest, with the commit
  that introduced it named above. **Nothing newer was ever lost.**
- The send caps, scheduling window, stage bands, cron batch size, follow-up
  cap, bounce classifier, structural-lint toggle, and autofix non-wiring have
  had **exactly one value or implementation in the entire visible history**
  (back to 2026-04-08, including unreachable commits). Any production
  behaviour that differs from those values is coming from **configuration**
  (section 6 list, checked against the deployment Secrets pane — note
  especially that a missing/invalid `GEMINI_API_KEY` silently reverts the
  whole pipeline to the pre-June Anthropic shape), from **per-user database
  settings** (send hours, stage timing, follow-up mode, labels), or from the
  **separately-deployed add-on** (section 7) — not from a lost code version.
- Evidence limit, restated from PA-1: history before 2026-04-08 is not in this
  clone (shallow boundary `962d47d`; upstream deleted). Statements of "only
  value ever" mean "in every commit visible today, reachable or not".
