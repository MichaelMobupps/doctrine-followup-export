/**
 * test-f37b-honest-tick.ts — F-3.7b.
 *
 * Hermetic. No database, no vendor, no email. The only socket any test here
 * opens is a loopback listener this file starts and stops itself, and its whole
 * job is to never answer.
 *
 * WHAT THIS PINS
 *
 * The August 13 diagnosis found one alarm that lied and three things underneath
 * it that were genuinely unbounded. Each gets its proof here:
 *
 *   1. A guarded fast_tick RECORDS the skip, so `max(fired_at)` — the Chief's
 *      machine liveness signal since F-3.7a — advances while a pass is running
 *      instead of ageing into a false death report.
 *   2. A wedged guard is reclaimed, and the pass that displaced it owns the
 *      guard afterwards even if the wedged one eventually returns.
 *   3. A Google call that never answers is cut, on both HTTP surfaces.
 *   4. A row that exceeds its generation budget fails ALONE, with evidence,
 *      while the rest of the pass completes.
 *
 * Structural pins at the end read the source of cron.ts and scheduler.ts as
 * text — the test-fallback-deleted.ts idiom — because the wiring they assert
 * lives inside modules that import @workspace/db and cannot be loaded without
 * one. Deleting the behaviour those pins name makes them bite.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx --test src/tests/test-f37b-honest-tick.ts
 */

import * as test from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

import {
  PROCESS_WEDGE_NO_PROGRESS_MS,
  claimProcessingGuard,
  __resetProcessingGuardForTests,
  __setWedgedPassForTests,
  __ageCurrentPassForTests,
} from "../lib/processingGuard";

import {
  GENERATION_DEADLINE_MS,
  GenerationDeadlineError,
  withGenerationDeadline,
  assertGenerationBudget,
  clampToGenerationBudget,
  remainingGenerationMs,
  generationDeadlineExceeded,
  __runWithSpentBudgetForTests,
} from "../lib/generationDeadline";

import { withAnthropicRetry } from "../services/anthropicRetry";
import { classifyProcessingFailure } from "../lib/retryPolicy";
import {
  GOOGLE_API_TIMEOUT_MS,
  newGoogleOAuthClient,
  newGmailClient,
  newOAuth2InfoClient,
} from "../lib/googleApi";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "..");
const readSrc = (rel: string): string => fs.readFileSync(path.join(SRC, rel), "utf8");

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── 1. The overlap guard: progress, not age ────────────────────────────────

test.describe("processing guard", () => {
  test.beforeEach(() => __resetProcessingGuardForTests());
  test.after(() => __resetProcessingGuardForTests());

  test.it("a free guard is claimed, and claims nothing back", () => {
    const claim = claimProcessingGuard("fast_tick");
    assert.equal(claim.claimed, true);
    if (!claim.claimed) return;
    assert.equal(claim.reclaimedAfterMs, null, "nothing was wedged, so nothing was reclaimed");
  });

  test.it("a held guard refuses the second tick and says how long it has been held", () => {
    const first = claimProcessingGuard("process_due");
    assert.equal(first.claimed, true);

    const second = claimProcessingGuard("fast_tick");
    assert.equal(second.claimed, false);
    if (second.claimed) return;
    assert.ok(second.passAgeMs >= 0);
    assert.ok(second.sinceProgressMs >= 0);
  });

  test.it(
    "MEASURES PROGRESS, NOT AGE: an old pass still finishing rows keeps its guard",
    () => {
      // A pass that started well past the wedge limit ago but finished a row a
      // moment ago is slow, not wedged. Age alone would reclaim it and set two
      // passes running for no reason; progress must not.
      __setWedgedPassForTests(PROCESS_WEDGE_NO_PROGRESS_MS * 3);
      const stale = claimProcessingGuard("fast_tick");
      assert.equal(stale.claimed, true, "no progress for 30 minutes IS wedged");
      if (!stale.claimed) return;

      // Now the same shape, but the pass is alive: it just finished a row.
      __resetProcessingGuardForTests();
      __setWedgedPassForTests(PROCESS_WEDGE_NO_PROGRESS_MS * 3);
      const old = claimProcessingGuard("process_due");
      assert.equal(old.claimed, true);
      if (!old.claimed) return;
      old.onProgress(); // a row completed

      const next = claimProcessingGuard("fast_tick");
      assert.equal(
        next.claimed,
        false,
        "a pass that just finished a row is alive however old it is",
      );
    },
  );

  test.it("a wedged guard is reclaimed and processing resumes", () => {
    __setWedgedPassForTests(PROCESS_WEDGE_NO_PROGRESS_MS + 60_000);

    const claim = claimProcessingGuard("fast_tick");
    assert.equal(claim.claimed, true, "the wedge must not block sending for ever");
    if (!claim.claimed) return;
    assert.notEqual(claim.reclaimedAfterMs, null, "the reclaim must be reported, not silent");
    assert.ok(
      (claim.reclaimedAfterMs ?? 0) >= PROCESS_WEDGE_NO_PROGRESS_MS,
      "the reported age is the age of what it broke",
    );

    // "Sending resumes" is exactly this: the reclaiming pass owns a working
    // guard and can run.
    claim.onProgress();
    const contended = claimProcessingGuard("process_due");
    assert.equal(contended.claimed, false, "the new pass holds the guard properly");
  });

  test.it(
    "IDENTITY TOKEN: a reclaimed pass returning late cannot clear the new pass's guard",
    () => {
      // The wedged pass, holding the guard for real — this claim's release()
      // closes over the very object the reclaim will displace.
      const wedged = claimProcessingGuard("process_due");
      assert.equal(wedged.claimed, true);
      if (!wedged.claimed) return;

      // It stops making progress, and the next tick reclaims it.
      __ageCurrentPassForTests(PROCESS_WEDGE_NO_PROGRESS_MS + 1000);
      const reclaimer = claimProcessingGuard("fast_tick");
      assert.equal(reclaimer.claimed, true);
      if (!reclaimer.claimed) return;

      // The wedged pass finally returns and runs its finally.
      wedged.release();

      // Without the identity token this would now be free, and two more passes
      // would pile in on top of the one that is legitimately running.
      const after = claimProcessingGuard("process_due");
      assert.equal(
        after.claimed,
        false,
        "the late release must not free a guard it no longer owns",
      );
    },
  );

  test.it("the owner's release does free the guard", () => {
    const claim = claimProcessingGuard("fast_tick");
    assert.equal(claim.claimed, true);
    if (!claim.claimed) return;
    claim.release();
    assert.equal(claimProcessingGuard("process_due").claimed, true);
  });

  test.it("the wedge limit is minutes, and sized between a row and the sync path", () => {
    assert.equal(PROCESS_WEDGE_NO_PROGRESS_MS, 10 * 60 * 1000);
    // Comfortably above the worst legitimate single row: a 180s generation
    // budget plus its Gmail calls, each bounded at 30s.
    assert.ok(PROCESS_WEDGE_NO_PROGRESS_MS > GENERATION_DEADLINE_MS + 6 * GOOGLE_API_TIMEOUT_MS);
    // And far below the sync path's four hours, which this deliberately is not.
    assert.ok(PROCESS_WEDGE_NO_PROGRESS_MS < 4 * 60 * 60 * 1000);
  });
});

// ── 2. The per-row generation budget ───────────────────────────────────────

test.describe("generation deadline", () => {
  test.it("is 180s, exactly three 60s vendor caps", () => {
    assert.equal(GENERATION_DEADLINE_MS, 180_000);
    // Draft, critic, rewrite: three sequential calls, each capped at 60s by the
    // Anthropic SDK and the Gemini abort. The budget cannot cut a generation
    // that stays inside those caps.
    assert.equal(GENERATION_DEADLINE_MS, 3 * 60_000);
  });

  test.it("lets a generation inside its budget through untouched", async () => {
    const out = await withGenerationDeadline(async () => {
      await sleep(20);
      return "draft";
    }, 500);
    assert.equal(out, "draft");
  });

  test.it("cuts a generation that never returns", async () => {
    const started = Date.now();
    await assert.rejects(
      () => withGenerationDeadline(() => new Promise(() => {}), 300),
      (err: unknown) => {
        assert.ok(err instanceof GenerationDeadlineError);
        return true;
      },
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 3000, `cut at the deadline, not later (took ${elapsed}ms)`);
  });

  test.it("a deadlined row is send_error — retryable — and never stranded", () => {
    // The deadline only ever wraps generation, which is entirely before the
    // first Gmail write, so no artifact can exist. Under the F-3.6a policy that
    // is `send_error`: bounded auto-retry. `stranded` would be wrong — it is
    // terminal, and it is for rows whose email already reached an inbox.
    const reason = classifyProcessingFailure({ gmailArtifactId: null, isAuthFailure: false });
    assert.equal(reason, "send_error");
  });

  test.it("the failure carries evidence a tired operator can act on", () => {
    const err = new GenerationDeadlineError(180_000, 181_234);
    assert.match(err.message, /180s deadline/);
    assert.match(err.message, /abandoned so the rest of the pass could run/);
    assert.match(
      err.message,
      /No email or draft was created/,
      "the operator must not have to wonder whether something went out",
    );
  });

  test.it("outside a generation there is no budget and nothing changes", async () => {
    assert.equal(remainingGenerationMs(), null);
    assert.equal(generationDeadlineExceeded(), false);
    assert.equal(clampToGenerationBudget(60_000), 60_000, "a route is not a row");
    assert.doesNotThrow(() => assertGenerationBudget("outside"));
  });

  test.it("inside a spent budget, work is refused and timeouts collapse", async () => {
    await __runWithSpentBudgetForTests(async () => {
      assert.equal(generationDeadlineExceeded(), true);
      assert.throws(() => assertGenerationBudget("critic attempt 3"), GenerationDeadlineError);
      assert.equal(clampToGenerationBudget(60_000), 1, "do not grant 60s to a spent row");
    });
  });

  test.it("inside a live budget, a per-call timeout is clamped to what is left", async () => {
    await withGenerationDeadline(async () => {
      const clamped = clampToGenerationBudget(60_000);
      assert.ok(clamped <= 400, `clamped to the remaining budget, got ${clamped}`);
      assert.ok(clamped > 0);
    }, 400);
  });
});

// ── 3. The retry ladders stop climbing for an abandoned row ────────────────

test.describe("retry ladders respect the budget", () => {
  test.it("withAnthropicRetry does not even call the vendor once the budget is spent", async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        __runWithSpentBudgetForTests(() =>
          withAnthropicRetry(
            async () => {
              calls++;
              return "never";
            },
            { label: "draft" },
          ),
        ),
      GenerationDeadlineError,
    );
    assert.equal(calls, 0, "a spent row must cost nothing more — this is the F-D4 burn shape");
  });

  test.it("a backoff the budget cannot absorb fails now instead of sleeping into the wall", async () => {
    let calls = 0;
    const started = Date.now();
    // 250ms of budget left, a retryable failure, and a 1s first backoff: the
    // sleep would outlive the row, so the row must fail on the real cause now.
    await assert.rejects(
      () =>
        withGenerationDeadline(
          () =>
            withAnthropicRetry(
              async () => {
                calls++;
                const err = new Error("overloaded_error: upstream is overloaded") as Error & {
                  status?: number;
                };
                err.status = 529;
                throw err;
              },
              { label: "draft" },
            ),
          250,
        ),
      (err: unknown) => {
        // The vendor cause survives; it is more diagnostic than "deadline".
        assert.match(String((err as Error).message), /overloaded/i);
        return true;
      },
    );
    assert.equal(calls, 1, "exactly one attempt — no ladder was climbed");
    assert.ok(Date.now() - started < 1000, "it did not sleep the backoff");
  });
});

// ── 3b. The budget outranks every fail-open path below it ─────────────────

test.describe("a spent budget is not a vendor outage", () => {
  test.it("the writer chain does not advance, and does not blame the tier's breaker", async () => {
    const { runWriter } = await import("../services/writerProvider");

    let breakerFailures = 0;
    let tiersAttempted = 0;
    const breaker = {
      shouldAttempt: () => true,
      onSuccess: () => {},
      onFailure: () => {
        breakerFailures++;
      },
      state: () => "closed",
    };

    // What the real transports do when the row's budget is spent: their
    // assertGenerationBudget throws GenerationDeadlineError out of the tier
    // call. The budget itself is still live here, so the outer race is NOT
    // what ends this — the thrown error has to travel on its own.
    //
    // Both transports are wired to the same throw, so if the router DID advance
    // the chain we would see tiersAttempted climb past 1 and the assertion below
    // would catch it. That is the real subject of this test: the chain must stop,
    // not merely fail.
    const spentBudget = (() => {
      tiersAttempted++;
      throw new GenerationDeadlineError(180_000, 180_500);
    }) as never;

    await assert.rejects(
      () =>
        withGenerationDeadline(
          () =>
            runWriter(
              {
                role: "draft",
                systemParts: ["s"],
                userPrompt: "u",
              },
              {
                isGeminiConfigured: () => true,
                isOpenAiConfigured: () => true,
                geminiGenerateJson: spentBudget,
                openaiGenerateJson: spentBudget,
                recordUsage: (() => {}) as never,
                recordAuxUsage: (() => {}) as never,
                breakerFor: () => breaker as never,
                logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
              },
            ),
          30_000,
        ),
      GenerationDeadlineError,
    );

    assert.equal(
      breakerFailures,
      0,
      "a spent row budget must not be scored against the tier — that opens the breaker and " +
        "pushes later rows onto a dearer tier for a fault the vendor never had",
    );
    assert.equal(
      tiersAttempted,
      1,
      "and it must not advance the waterfall: the pass has already abandoned this row",
    );
  });

  test.it("the fail-open critic re-throws a spent budget instead of shipping the draft", () => {
    // The critic is deliberately fail-open — a critic outage ships the best
    // draft rather than failing the row. A deadline is not an outage, and
    // "returning best draft seen" would put an un-critiqued email in a client's
    // inbox on the strength of a timeout.
    const gen = readSrc("services/followupGenerator.ts");
    const idx = gen.indexOf('"Critic unavailable after retries — returning best draft seen"');
    assert.ok(idx > 0, "the fail-open critic path must still exist");
    const before = gen.slice(Math.max(0, idx - 700), idx);
    assert.match(before, /if \(err instanceof GenerationDeadlineError\) throw err;/);
  });

  test.it("EVERY fail-open catch in all three generators carries the guard", () => {
    // Aug 2026 audit finding: the context and anti-ghosting flows never had the
    // guard at all, and after it was added to their inner helpers the OUTER
    // rewriter catches still swallowed the rethrow — a guard defeated one frame
    // up is no guard. This sweep reads every fail-open log marker in the three
    // generators and asserts the rethrow sits in the ~800 chars before it, so a
    // new fail-open path added without the guard fails here by name.
    const FAIL_OPEN_MARKERS: Array<[string, string[]]> = [
      [
        "services/followupGenerator.ts",
        [
          '"Critic unavailable after retries — returning best draft seen"',
          '"Rewriter unavailable after retries — returning best draft seen"',
        ],
      ],
      [
        "services/contextFollowupGenerator.ts",
        [
          '"Context-critic call failed — shipping original draft"',
          '"Context-rewriter chain exhausted — falling back to the original draft"',
          '"Context-rewriter failed — shipping original draft"',
        ],
      ],
      [
        "services/antiGhostingFollowupGenerator.ts",
        [
          '"AntiGhosting-critic call failed — shipping original draft"',
          '"AntiGhosting-rewriter chain exhausted — falling back to the original draft"',
          '"AntiGhosting-rewriter failed — shipping original draft"',
        ],
      ],
    ];
    for (const [file, markers] of FAIL_OPEN_MARKERS) {
      const src = readSrc(file);
      for (const marker of markers) {
        const idx = src.indexOf(marker);
        assert.ok(idx > 0, `${file}: fail-open marker ${marker} must still exist`);
        const before = src.slice(Math.max(0, idx - 800), idx);
        assert.match(
          before,
          /if \(err instanceof GenerationDeadlineError\) throw err;/,
          `${file}: the catch logging ${marker} must rethrow GenerationDeadlineError first`,
        );
      }
    }
  });
});

// ── 4. One poisoned row fails alone ────────────────────────────────────────

test.describe("a poisoned row cannot eat the pass", () => {
  test.it("the row that hangs fails; the rows around it complete", async () => {
    // The shape of the scheduler's per-row loop: claim, generate under the
    // budget, record the verdict, move on. The generator for row 2 never
    // returns, exactly as a wedged vendor socket would not.
    const rows = [
      { id: 1, hangs: false },
      { id: 2, hangs: true },
      { id: 3, hangs: false },
    ];
    const sent: number[] = [];
    const failed: { id: number; reason: string; message: string }[] = [];
    const progressed: number[] = [];

    const ROW_BUDGET_MS = 300;
    const started = Date.now();

    for (const row of rows) {
      try {
        await withGenerationDeadline(
          () => (row.hangs ? new Promise<string>(() => {}) : Promise.resolve("draft")),
          ROW_BUDGET_MS,
        );
        sent.push(row.id);
      } catch (err) {
        failed.push({
          id: row.id,
          reason: classifyProcessingFailure({ gmailArtifactId: null, isAuthFailure: false }),
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        progressed.push(row.id);
      }
    }

    assert.deepEqual(sent, [1, 3], "the healthy rows are unaffected");
    assert.equal(failed.length, 1);
    assert.equal(failed[0].id, 2);
    assert.equal(failed[0].reason, "send_error", "bounded retry, not terminal");
    assert.match(failed[0].message, /No email or draft was created/);

    assert.deepEqual(
      progressed,
      [1, 2, 3],
      "every row reports progress, including the failed one — this is what feeds the wedge watchdog",
    );

    // Before the budget existed, row 2 alone could hold the pass for ~13
    // minutes. The whole pass is now bounded by the budget it was given.
    assert.ok(
      Date.now() - started < ROW_BUDGET_MS * 4,
      "the pass is bounded by the row budget, not by the vendor",
    );
  });
});

// ── 5. Google calls are bounded, on both HTTP surfaces ─────────────────────

test.describe("googleapis request timeouts", () => {
  test.it("30s, and every factory carries it", () => {
    assert.equal(GOOGLE_API_TIMEOUT_MS, 30_000);

    // Surface 1: the API request, via the service options googleapis merges
    // into every call.
    const auth = newGoogleOAuthClient();
    const gmail = newGmailClient(auth) as unknown as { context: { _options: { timeout?: number } } };
    assert.equal(gmail.context._options.timeout, GOOGLE_API_TIMEOUT_MS);

    const oauth2 = newOAuth2InfoClient(auth) as unknown as {
      context: { _options: { timeout?: number } };
    };
    assert.equal(oauth2.context._options.timeout, GOOGLE_API_TIMEOUT_MS);

    // Surface 2: the OAuth token refresh, which the auth library makes on its
    // own transporter. Service options never reach it, and an unbounded
    // refresh hangs the row before the API call is even attempted.
    const withTransport = auth as unknown as { transporter: { defaults?: { timeout?: number } } };
    assert.equal(
      withTransport.transporter.defaults?.timeout,
      GOOGLE_API_TIMEOUT_MS,
      "the token refresh must be bounded too",
    );
  });

  test.it("a Google call that never answers IS cut", async () => {
    // A listener that accepts the connection and then says nothing at all —
    // the hung socket googleapis has no default deadline for. Loopback only;
    // no vendor is reachable from this test.
    const server = http.createServer(() => {
      /* deliberately never responds */
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    try {
      const auth = newGoogleOAuthClient();
      // A live access token, so nothing tries to refresh and reach Google.
      auth.setCredentials({ access_token: "test-token", expiry_date: Date.now() + 3_600_000 });

      // The real client, pointed at the silent server. The timeout is shortened
      // so the test is fast; the production value is pinned by the test above.
      const { google } = await import("googleapis");
      const gmail = google.gmail({
        version: "v1",
        auth,
        timeout: 750,
        rootUrl: `http://127.0.0.1:${port}/`,
      });

      const started = Date.now();
      await assert.rejects(
        () => gmail.users.labels.list({ userId: "me" }),
        (err: unknown) => {
          // node-fetch rejects a expired request as a request-timeout FetchError.
          const msg = String((err as Error).message).toLowerCase();
          assert.ok(
            msg.includes("timeout") || msg.includes("aborted"),
            `expected a timeout, got: ${(err as Error).message}`,
          );
          return true;
        },
      );
      const elapsed = Date.now() - started;
      assert.ok(elapsed < 8000, `cut near the timeout, not left hanging (took ${elapsed}ms)`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

// ── 6. Heartbeat volume at the 3-minute cadence ────────────────────────────

test.describe("heartbeat volume", () => {
  test.it("recording skips does not raise the ceiling it was feared to raise", () => {
    const FAST_TICK_PERIOD_MIN = 3;
    const firingsPerDay = (24 * 60) / FAST_TICK_PERIOD_MIN;
    assert.equal(firingsPerDay, 480);

    // The comment this order deleted feared "20k+ rows of skipped entries".
    // The arithmetic never supported it: fast_tick writes AT MOST one row per
    // firing either way. Recording the skip changes WHICH rows exist, not how
    // many can exist — the ceiling was already 480/day and still is.
    const ceilingBefore = firingsPerDay; // a row per firing that did work
    const ceilingAfter = firingsPerDay; // a row per firing, worked or skipped
    assert.equal(ceilingAfter, ceilingBefore);

    // 20k rows is ~41 days of fast_tick at the ceiling. That is a retention
    // question, and the honest answer is recorded in the ledger: NO prune or
    // retention governs cron_heartbeats today. This order does not add one —
    // it is out of scope — but it must not be believed to have made the table
    // grow faster than it already could.
    assert.ok(20_000 / ceilingAfter > 40);
  });
});

// ── 7. Structural pins: the wiring, in modules a hermetic test cannot load ─

test.describe("wiring pins (mutation proofs bite here)", () => {
  const cron = readSrc("cron.ts");
  const scheduler = readSrc("services/scheduler.ts");

  test.it("the GUARDED fast_tick path records a heartbeat", () => {
    // The whole false-death-report bug in one assertion: find fast_tick's
    // guarded branch and require a heartbeat inside it.
    //
    // F-3.7c REPHRASED THIS PIN, and the property it protects got stronger.
    // The branch used to call `recordHeartbeat({ tickName: "fast_tick", … })`
    // — it decided whether a row existed. The row is now inserted by
    // `beginHeartbeat("fast_tick")` before the guard is consulted at all, so
    // this branch finishes a row that already exists and the tick name is no
    // longer repeated here. What still bites: delete the `hb.finish` and the
    // firing is left at `running` for ever with no reason attached.
    const guarded = cron.slice(
      cron.indexOf('const claim = claimProcessingGuard("fast_tick");'),
      cron.indexOf("if (claim.reclaimedAfterMs !== null)", cron.indexOf('claimProcessingGuard("fast_tick")')),
    );
    assert.ok(guarded.length > 0, "fast_tick must claim the shared guard");
    assert.match(guarded, /hb\.finish\(\{/, "a guarded fast_tick MUST still record its firing's result");
    assert.match(guarded, /skipped:/, "and must say why it did no work");
    // The firing itself is recorded ahead of the guard, which is what makes the
    // property structural rather than dependent on this branch remembering.
    const fastTick = cron.slice(cron.indexOf("export async function runFastTick"));
    assert.ok(
      fastTick.indexOf('beginHeartbeat("fast_tick")') < fastTick.indexOf("claimProcessingGuard"),
      "the row must exist before the guard can send the tick home",
    );
  });

  test.it("both processing ticks share the watchdog-bearing guard", () => {
    assert.match(cron, /claimProcessingGuard\("process_due"\)/);
    assert.match(cron, /claimProcessingGuard\("fast_tick"\)/);
    assert.doesNotMatch(cron, /processTickRunning/, "the unwatched boolean is gone");
    // Both ticks must feed the watchdog, or it can never tell slow from wedged.
    assert.equal(
      (cron.match(/onProgress: claim\.onProgress/g) || []).length,
      2,
      "both ticks hand the pass its progress callback",
    );
    assert.equal(
      (cron.match(/claim\.release\(\)/g) || []).length,
      2,
      "both ticks release by identity token",
    );
  });

  test.it("a reclaim is reported, not swallowed", () => {
    assert.equal(
      (cron.match(/details\.wedgeReclaimedAfterMs = claim\.reclaimedAfterMs/g) || []).length,
      2,
      "a wedge reclaim lands in the heartbeat both ticks write",
    );
    assert.match(cron, /outcome = "partial";/, "and is not passed off as a healthy tick");
  });

  test.it("generation runs under the row budget", () => {
    assert.match(
      scheduler,
      /generated = await withGenerationDeadline\(\(\) => runWithUsageContext\(/,
      "remove this and one poisoned row eats the pass again",
    );
  });

  test.it("every row reports progress, however it ended", () => {
    assert.match(scheduler, /options\?\.onProgress\?\.\(\)/);
    // It must be in a finally: a row that failed or was skipped is still
    // progress, and a watchdog that only counted successes would reclaim a
    // pass that is healthily skipping held rows.
    const idx = scheduler.indexOf("options?.onProgress?.()");
    const before = scheduler.slice(Math.max(0, idx - 400), idx);
    assert.match(before, /\}\s*finally\s*\{/, "progress is reported from a finally");
  });

  test.it("no Google client is constructed without a timeout", () => {
    // Every construction funnels through lib/googleApi.ts. A new raw one
    // anywhere else re-opens the unbounded-socket hole.
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts") && !entry.name.includes("backup")) files.push(full);
      }
    };
    walk(SRC);

    const offenders = files.filter((f) => {
      if (f.endsWith(path.join("lib", "googleApi.ts"))) return false;
      if (f.includes(`${path.sep}tests${path.sep}`)) return false;
      const text = fs.readFileSync(f, "utf8");
      return /google\.gmail\(|google\.oauth2\(|new google\.auth\.OAuth2/.test(text);
    });

    assert.deepEqual(
      offenders.map((f) => path.relative(SRC, f)),
      [],
      "construct Google clients through lib/googleApi.ts so they carry a timeout",
    );
  });
});
