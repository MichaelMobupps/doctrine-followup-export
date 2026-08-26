import cron from "node-cron";
import { syncEmails, SyncAlreadyRunningError, NoConnectedAccountsError } from "./services/gmailSync";
import { processDueFollowups, autoQueueAllCampaigns, stallDraftedFollowups, archiveStalePausedCampaigns, detectStrandedGeneratingFollowups, pauseExpiredCampaigns, pauseOverCapCampaigns } from "./services/scheduler";
// CSD v1: daily prune of company-shared drafts past retention.
import { pruneSharedDrafts } from "./services/companyDraftCache";
import { runWeeklyDigest } from "./services/weeklyDigest";
import { logger } from "./lib/logger";
// Phase 7n: per-tick heartbeat recording for cron-firing observability.
// F-3.7c: a tick records its FIRING (beginHeartbeat) and then its result
// (hb.finish), so the liveness signal no longer waits for the work to end
// and cannot be lost by an early return. See lib/heartbeatLifecycle.ts.
import { beginHeartbeat, recordProcessStart } from "./lib/cronHeartbeat";
// F-3.7a: outbound spend reporting to the Chief. Registers its own tick, and
// only when CHIEF_URL + CHIEF_INGEST_TOKEN are both set.
import { startChiefSpendReporting } from "./lib/chiefSpendSweep";

// F-3.7b: the processing overlap guard moved to lib/processingGuard.ts. It is
// pure module state with no database or vendor import, which is what lets the
// wedge watchdog be proven hermetically — the same reasoning retryPolicy.ts
// applies to the failed-row rules.
import { claimProcessingGuard } from "./lib/processingGuard";

/**
 * The armed schedule, in one string.
 *
 * Logged at boot, as it always was, and — F-3.7c — also written into the
 * `process_start` heartbeat's details, so the table itself says which tick set
 * this process came up with. A hole in the stream is then readable after the
 * fact by somebody who no longer has the log lines.
 */
const TICK_SET_SUMMARY =
  "sync+auto-queue @*/15, process @5,20,35,50, draft-stall @00:30, " +
  "campaign-expiry @00:15, over-cap @00:20, archive-sweep @00:45, " +
  "shared-draft-prune @01:00, weekly-digest @Tue 00:00 UTC + retry @Tue " +
  "06:00 UTC, fast-tick @*/3, chief-spend @*/5 (only when the Chief seam is " +
  "configured)";

export function startCronJobs(): void {
  // Gmail sync + auto-queue every 15 minutes.
  // Phase 7n: heartbeat tickName="sync_and_autoqueue".
  cron.schedule("*/15 * * * *", async () => {
    const hb = await beginHeartbeat("sync_and_autoqueue");
    let outcome: "ok" | "partial" | "error" = "ok";
    const details: Record<string, unknown> = {};
    try {
      logger.info("Running Gmail sync...");
      try {
        const result = await syncEmails();
        details.synced = result.synced;
        details.repliesDetected = result.repliesDetected;
        // Per-user outcomes, so a persistently failing mailbox is visible
        // in the heartbeat row instead of only in ephemeral stdout logs.
        details.perUser = result.perUser;
        const failures = result.perUser.filter((u) => u.ingestError || u.replyError || (u.ingestFailed ?? 0) > 0);
        if (failures.length > 0) {
          outcome = "partial";
          logger.error(
            { failures: failures.map((f) => ({ email: f.email, ingestError: f.ingestError, replyError: f.replyError, ingestFailed: f.ingestFailed, authFailure: f.authFailure })) },
            "Sync completed with per-user failures",
          );
        }
        logger.info(
          { synced: result.synced, repliesDetected: result.repliesDetected },
          "Sync done",
        );
      } catch (err) {
        if (err instanceof SyncAlreadyRunningError) {
          // Not a failure: a previous pass (cron or route-triggered) is
          // still running. Record the skip so tick cadence stays auditable.
          details.skipped = err.message;
          logger.warn(err.message + " — skipping this tick");
        } else if (err instanceof NoConnectedAccountsError) {
          // F-3.6b: the loudest thing this tick can say. Zero connected
          // accounts used to be answered by the legacy env-var mailbox, or
          // by `ok` with `synced: 0` — the shape that hid total sync death
          // for months (D2). It is `error`, not `partial`: nothing is
          // degraded, everything is down.
          outcome = "error";
          details.noConnectedAccounts = true;
          details.syncError = err.message;
          logger.error({ err }, "NO CONNECTED ACCOUNTS — sync did not run");
        } else {
          outcome = "partial";
          details.syncError = err instanceof Error ? err.message : String(err);
          logger.error({ err }, "Sync error");
        }
      }

      try {
        const autoQueued = await autoQueueAllCampaigns();
        details.autoQueued = autoQueued;
        if (autoQueued > 0) {
          logger.info({ autoQueued }, "Auto-queued follow-up stages");
        }
      } catch (err) {
        outcome = "partial";
        details.autoQueueError = err instanceof Error ? err.message : String(err);
        logger.error({ err }, "Auto-queue error");
      }

      // RH-1: stranded-'generating' detector. Pure visibility, no state
      // mutation; the count lands in the heartbeat details so a frozen
      // campaign can never go unnoticed for more than 15 minutes.
      try {
        const stranded = await detectStrandedGeneratingFollowups();
        details.strandedGenerating = stranded;
      } catch (err) {
        outcome = "partial";
        details.strandedDetectorError = err instanceof Error ? err.message : String(err);
        logger.error({ err }, "RH-1: stranded-generating detector error");
      }
    } catch (err) {
      outcome = "error";
      details.wrapperError = err instanceof Error ? err.message : String(err);
      logger.error({ err }, "sync_and_autoqueue wrapper error");
    } finally {
      await hb.finish({ outcome, details });
    }
  });

  // Process due follow-ups four times per hour on the main tick.
  // Phase 7n: heartbeat tickName="process_due".
  cron.schedule("5,20,35,50 * * * *", runProcessDueTick);


  // Daily stall watcher: draft-mode follow-ups that sit unsent for 30 days
  // pause the prospect and move the row to stalled_awaiting_manual_send.
  // Phase 7n: heartbeat tickName="draft_stall_watcher".
  cron.schedule("30 0 * * *", async () => {
    const hb = await beginHeartbeat("draft_stall_watcher");
    let outcome: "ok" | "partial" | "error" = "ok";
    const details: Record<string, unknown> = {};
    try {
      logger.info("Running draft-mode stall watcher...");
      const stalled = await stallDraftedFollowups();
      details.stalled = stalled;
      if (stalled > 0) {
        logger.info({ stalled }, "Stalled stale Gmail draft follow-ups");
      }
    } catch (err) {
      outcome = "error";
      details.error = err instanceof Error ? err.message : String(err);
      logger.error({ err }, "Draft stall watcher error");
    } finally {
      await hb.finish({ outcome, details });
    }
  });

  // CB-3: daily 30-day expiry sweep. Force-pauses any active campaign whose
  // original outreach was sent more than 30 days ago, across all
  // subproducts. Runs at 00:15, before the draft stall watcher (00:30) and
  // the archival sweep (00:45), so an expired campaign is paused first and
  // then follows the normal paused -> archived lifecycle.
  cron.schedule("15 0 * * *", async () => {
    const hb = await beginHeartbeat("campaign_expiry_sweep");
    let outcome: "ok" | "partial" | "error" = "ok";
    const details: Record<string, unknown> = {};
    try {
      logger.info("Running 30-day campaign expiry sweep...");
      const paused = await pauseExpiredCampaigns();
      details.paused = paused;
      if (paused > 0) {
        logger.info({ paused }, "Paused campaigns older than 30 days");
      }
    } catch (err) {
      outcome = "error";
      details.error = err instanceof Error ? err.message : String(err);
      logger.error({ err }, "Campaign expiry sweep error");
    } finally {
      await hb.finish({ outcome, details });
    }
  });

  // Daily over-cap sweep. Force-pauses any active campaign that has already
  // sent more follow-ups than the rigid cap allows (legacy over-cap rows),
  // across all subproducts. Runs at 00:20, after the 30-day expiry sweep
  // (00:15) and before the draft stall watcher (00:30). Paused rows then
  // follow the normal paused -> archived lifecycle.
  cron.schedule("20 0 * * *", async () => {
    const hb = await beginHeartbeat("over_cap_sweep");
    let outcome: "ok" | "partial" | "error" = "ok";
    const details: Record<string, unknown> = {};
    try {
      logger.info("Running over-cap campaign sweep...");
      const paused = await pauseOverCapCampaigns();
      details.paused = paused;
      if (paused > 0) {
        logger.info({ paused }, "Paused campaigns that had sent more than the follow-up cap");
      }
    } catch (err) {
      outcome = "error";
      details.error = err instanceof Error ? err.message : String(err);
      logger.error({ err }, "Over-cap sweep error");
    } finally {
      await hb.finish({ outcome, details });
    }
  });

  // Daily archival sweep: archive campaigns paused for >= 14 days.
  // Runs at 00:45, after the draft stall watcher at 00:30.
  cron.schedule("45 0 * * *", async () => {
    const hb = await beginHeartbeat("archive_sweep");
    let outcome: "ok" | "partial" | "error" = "ok";
    const details: Record<string, unknown> = {};
    try {
      logger.info("Running archival sweep...");
      const archived = await archiveStalePausedCampaigns();
      details.archived = archived;
      if (archived > 0) {
        logger.info({ archived }, "Archived campaigns paused >= 14 days");
      }
    } catch (err) {
      outcome = "error";
      details.error = err instanceof Error ? err.message : String(err);
      logger.error({ err }, "Archival sweep error");
    } finally {
      await hb.finish({ outcome, details });
    }
  });

  // Fast tick every 3 minutes to pick up "Send now" items that were just
  // queued with scheduledAt=now and shouldn't wait 15 min for the main tick.
  // No longer tied to test mode — this runs for all users and is scoped to
  // picking up already-due rows only.
  // Phase 7n: heartbeat tickName="fast_tick".
  cron.schedule("*/3 * * * *", runFastTick);

  // Weekly digest: Tuesday 00:00 UTC. The runWeeklyDigest() function
  // self-dedupes via users.last_weekly_digest_at (6-day window) so any
  // accidental rerun within the same Tuesday is a no-op.
  // Phase 7n: heartbeat tickName="weekly_digest".
  cron.schedule("0 0 * * 2", async () => {
    const hb = await beginHeartbeat("weekly_digest");
    let outcome: "ok" | "partial" | "error" = "ok";
    const details: Record<string, unknown> = {};
    try {
      logger.info("Running weekly digest...");
      const result = await runWeeklyDigest();
      details.considered = result.considered;
      details.sent = result.sent;
      details.skipped = result.skipped;
      details.failed = result.failed;
      logger.info(
        { considered: result.considered, sent: result.sent, skipped: result.skipped, failed: result.failed },
        "Weekly digest done",
      );
    } catch (err) {
      outcome = "error";
      details.error = err instanceof Error ? err.message : String(err);
      logger.error({ err }, "Weekly digest error");
    } finally {
      await hb.finish({ outcome, details });
    }
  }, { timezone: "UTC" });

  // B7q: retry tick for failed weekly digests. The runWeeklyDigest()
  // function's 6-day dedupe window means any user whose digest already
  // sent at 00:00 UTC will be skipped here. Only users whose digest
  // FAILED earlier today (lastWeeklyDigestAt is older than 6 days, or
  // unset) actually get a fresh send.
  cron.schedule("0 6 * * 2", async () => {
    const hb = await beginHeartbeat("weekly_digest_retry");
    let outcome: "ok" | "partial" | "error" = "ok";
    const details: Record<string, unknown> = {};
    try {
      logger.info("Running weekly digest retry tick...");
      const result = await runWeeklyDigest();
      details.considered = result.considered;
      details.sent = result.sent;
      details.skipped = result.skipped;
      details.failed = result.failed;
      logger.info(
        { considered: result.considered, sent: result.sent, skipped: result.skipped, failed: result.failed },
        "Weekly digest retry done",
      );
    } catch (err) {
      outcome = "error";
      details.error = err instanceof Error ? err.message : String(err);
      logger.error({ err }, "Weekly digest retry error");
    } finally {
      await hb.finish({ outcome, details });
    }
  }, { timezone: "UTC" });

  // CSD v1: daily prune of company-shared drafts older than retention.
  // Runs at 01:00, after the archival sweep at 00:45. Fail-open inside
  // pruneSharedDrafts(); the heartbeat records the outcome either way.
  cron.schedule("0 1 * * *", async () => {
    const hb = await beginHeartbeat("shared_draft_prune");
    let outcome: "ok" | "partial" | "error" = "ok";
    const details: Record<string, unknown> = {};
    try {
      const pruned = await pruneSharedDrafts();
      details.pruned = pruned;
      if (pruned > 0) {
        logger.info({ pruned }, "CSD: pruned aged company-shared drafts");
      }
    } catch (err) {
      outcome = "error";
      details.error = err instanceof Error ? err.message : String(err);
      logger.error({ err }, "CSD: shared-draft prune error");
    } finally {
      await hb.finish({ outcome, details });
    }
  });

  // F-3.7a: the outbound half of the Chief uplink. The schedule for this one
  // lives with its own config decision rather than here, because whether it
  // exists at all depends on CHIEF_URL + CHIEF_INGEST_TOKEN: unset means no
  // tick is registered, no socket is opened and no cursor row is touched, and
  // the app says so once, loudly. See lib/chiefSpendSweep.ts. It registers
  // `chief_spend_report` @*/5 when configured.
  startChiefSpendReporting();

  // F-3.7c: one row per process start, written now that the tick set is
  // registered and firing again. This is the difference between "the cron
  // died" and "the app restarted" — the in-process scheduler fires nothing
  // while the process is down, so a restart leaves the same hole in the
  // heartbeat stream that a dead tick does, and until this row existed
  // nothing in the database could tell an operator which one had happened.
  // Fire-and-forget: boot waits on nothing and fails on nothing here.
  recordProcessStart({ tickSet: TICK_SET_SUMMARY });

  logger.info(`Cron jobs active: ${TICK_SET_SUMMARY}`);
}

/**
 * The process_due tick body, `5,20,35,50 * * * *`.
 *
 * F-3.7b: named and exported rather than inline, so the smoke can run the
 * REAL tick — guard, heartbeat and all — instead of a re-implementation of it
 * that could drift from the thing production runs.
 */
export async function runProcessDueTick(): Promise<void> {
  const hb = await beginHeartbeat("process_due");
  let outcome: "ok" | "partial" | "error" = "ok";
  const details: Record<string, unknown> = {};
  const claim = claimProcessingGuard("process_due");
  if (!claim.claimed) {
    logger.warn("Previous follow-up processing pass still running — skipping process_due tick");
    await hb.finish({
      outcome: "ok",
      details: {
        skipped: "previous processing pass still running",
        passAgeMs: claim.passAgeMs,
        sinceProgressMs: claim.sinceProgressMs,
      },
    });
    return;
  }
  if (claim.reclaimedAfterMs !== null) {
    // F-3.7b: a reclaim is not a healthy tick. `partial` puts it in the
    // Chief's errors_24h instead of letting it pass as ok.
    outcome = "partial";
    details.wedgeReclaimedAfterMs = claim.reclaimedAfterMs;
  }
  try {
    logger.info("Processing due follow-ups...");
    const result = await processDueFollowups({ onProgress: claim.onProgress });
    details.processed = result.processed;
    details.sent = result.sent;
    details.drafted = result.drafted;
    details.failed = result.failed;
    logger.info(
      { sent: result.sent, drafted: result.drafted, failed: result.failed },
      "Follow-up processing done",
    );
  } catch (err) {
    outcome = "error";
    details.error = err instanceof Error ? err.message : String(err);
    logger.error({ err }, "Scheduler error");
  } finally {
    claim.release();
    await hb.finish({ outcome, details });
  }
}

/**
 * The fast_tick body, the every-three-minutes schedule.
 *
 * F-3.7b: named and exported for the same reason as runProcessDueTick. The
 * property this order turns on — that a GUARDED fast_tick still writes a
 * heartbeat — lives in here, so the proof has to be able to call in here.
 */
export async function runFastTick(): Promise<void> {
  const hb = await beginHeartbeat("fast_tick");
  let outcome: "ok" | "partial" | "error" = "ok";
  const details: Record<string, unknown> = {};
  const claim = claimProcessingGuard("fast_tick");
  if (!claim.claimed) {
    // Shares the guard with process_due — both run processDueFollowups(),
    // and overlapped passes just re-select rows another pass will claim.
    //
    // ── F-3.7b: the skip is RECORDED. ─────────────────────────────────
    //
    // This path used to return bare, on the reasoning that 20k+ rows of
    // "skipped" entries would drown a human reading the stream. That was
    // true of a stream only a human read. F-3.7a made `max(fired_at)` per
    // tick the Chief's machine liveness signal, and from that moment a
    // silent skip was indistinguishable from a dead tick: every fast_tick
    // suppressed by a long pass aged the Chief's figure until it alarmed,
    // all day, while the tick was firing exactly on schedule. The heartbeat
    // stream now answers the question it is actually asked — "did this tick
    // fire", not "did this tick do work" — and the reason it did no work
    // travels in `details.skipped`, where process_due has always put it.
    //
    // The volume fear was also arithmetic that never held: a recorded skip
    // replaces a row this tick would have written anyway on a pass it did
    // not have to skip. The ceiling is unchanged at one row per firing,
    // 480/day, which is what the tick has always been budgeted for.
    //
    // ── F-3.7c: and now it cannot be un-recorded. ─────────────────────
    //
    // The row was inserted by `beginHeartbeat` above, before the guard was
    // even consulted, so this branch is finishing a row that already
    // exists rather than deciding whether one gets written. F-3.7b's fix
    // stopped being a code path an early return could skip and became a
    // property of the shape: every path out of this function, including
    // one somebody adds later without reading this comment, leaves the
    // firing recorded.
    await hb.finish({
      outcome: "ok",
      details: {
        skipped: "previous processing pass still running",
        passAgeMs: claim.passAgeMs,
        sinceProgressMs: claim.sinceProgressMs,
      },
    });
    return;
  }
  if (claim.reclaimedAfterMs !== null) {
    outcome = "partial";
    details.wedgeReclaimedAfterMs = claim.reclaimedAfterMs;
  }
  try {
    const result = await processDueFollowups({ onProgress: claim.onProgress });
    details.processed = result.processed;
    details.sent = result.sent;
    details.drafted = result.drafted;
    details.failed = result.failed;
    if (result.sent > 0 || result.drafted > 0 || result.processed > 0) {
      logger.info(
        { sent: result.sent, drafted: result.drafted, failed: result.failed },
        "Fast-tick processed follow-ups",
      );
    }
  } catch (err) {
    outcome = "error";
    details.error = err instanceof Error ? err.message : String(err);
    logger.error({ err }, "Fast-tick error");
  } finally {
    claim.release();
    await hb.finish({ outcome, details });
  }
}
