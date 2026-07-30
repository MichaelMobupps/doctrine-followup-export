import cron from "node-cron";
import { syncEmails, SyncAlreadyRunningError } from "./services/gmailSync";
import { processDueFollowups, autoQueueAllCampaigns, stallDraftedFollowups, archiveStalePausedCampaigns, detectStrandedGeneratingFollowups, pauseExpiredCampaigns, pauseOverCapCampaigns } from "./services/scheduler";
// CSD v1: daily prune of company-shared drafts past retention.
import { pruneSharedDrafts } from "./services/companyDraftCache";
import { runWeeklyDigest } from "./services/weeklyDigest";
import { logger } from "./lib/logger";
// Phase 7n: per-tick heartbeat recording for cron-firing observability.
import { recordHeartbeat } from "./lib/cronHeartbeat";

// Overlap guard for follow-up processing ticks. processDueFollowups() is
// CAS-protected against double sends, so overlap is safe — but process_due
// (4x/hour) and fast_tick (every 3 min) calling it concurrently multiplies
// DB round-trips and Gmail reads for zero benefit. One processing pass at
// a time; an overlapping tick simply skips. (The all-users SYNC overlap
// guard lives inside syncEmails() itself so it also covers the /sync
// routes — see SyncAlreadyRunningError.)
let processTickRunning = false;

export function startCronJobs(): void {
  // Gmail sync + auto-queue every 15 minutes.
  // Phase 7n: heartbeat tickName="sync_and_autoqueue".
  cron.schedule("*/15 * * * *", async () => {
    const startedAt = Date.now();
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
      await recordHeartbeat({
        tickName: "sync_and_autoqueue",
        durationMs: Date.now() - startedAt,
        outcome,
        details,
      });
    }
  });

  // Process due follow-ups four times per hour on the main tick.
  // Phase 7n: heartbeat tickName="process_due".
  cron.schedule("5,20,35,50 * * * *", async () => {
    const startedAt = Date.now();
    let outcome: "ok" | "partial" | "error" = "ok";
    const details: Record<string, unknown> = {};
    if (processTickRunning) {
      logger.warn("Previous follow-up processing pass still running — skipping process_due tick");
      await recordHeartbeat({
        tickName: "process_due",
        durationMs: 0,
        outcome: "ok",
        details: { skipped: "previous processing pass still running" },
      });
      return;
    }
    processTickRunning = true;
    try {
      logger.info("Processing due follow-ups...");
      const result = await processDueFollowups();
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
      processTickRunning = false;
      await recordHeartbeat({
        tickName: "process_due",
        durationMs: Date.now() - startedAt,
        outcome,
        details,
      });
    }
  });


  // Daily stall watcher: draft-mode follow-ups that sit unsent for 30 days
  // pause the prospect and move the row to stalled_awaiting_manual_send.
  // Phase 7n: heartbeat tickName="draft_stall_watcher".
  cron.schedule("30 0 * * *", async () => {
    const startedAt = Date.now();
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
      await recordHeartbeat({
        tickName: "draft_stall_watcher",
        durationMs: Date.now() - startedAt,
        outcome,
        details,
      });
    }
  });

  // CB-3: daily 30-day expiry sweep. Force-pauses any active campaign whose
  // original outreach was sent more than 30 days ago, across all
  // subproducts. Runs at 00:15, before the draft stall watcher (00:30) and
  // the archival sweep (00:45), so an expired campaign is paused first and
  // then follows the normal paused -> archived lifecycle.
  cron.schedule("15 0 * * *", async () => {
    const startedAt = Date.now();
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
      await recordHeartbeat({
        tickName: "campaign_expiry_sweep",
        durationMs: Date.now() - startedAt,
        outcome,
        details,
      });
    }
  });

  // Daily over-cap sweep. Force-pauses any active campaign that has already
  // sent more follow-ups than the rigid cap allows (legacy over-cap rows),
  // across all subproducts. Runs at 00:20, after the 30-day expiry sweep
  // (00:15) and before the draft stall watcher (00:30). Paused rows then
  // follow the normal paused -> archived lifecycle.
  cron.schedule("20 0 * * *", async () => {
    const startedAt = Date.now();
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
      await recordHeartbeat({
        tickName: "over_cap_sweep",
        durationMs: Date.now() - startedAt,
        outcome,
        details,
      });
    }
  });

  // Daily archival sweep: archive campaigns paused for >= 14 days.
  // Runs at 00:45, after the draft stall watcher at 00:30.
  cron.schedule("45 0 * * *", async () => {
    const startedAt = Date.now();
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
      await recordHeartbeat({
        tickName: "archive_sweep",
        durationMs: Date.now() - startedAt,
        outcome,
        details,
      });
    }
  });

  // Fast tick every 3 minutes to pick up "Send now" items that were just
  // queued with scheduledAt=now and shouldn't wait 15 min for the main tick.
  // No longer tied to test mode — this runs for all users and is scoped to
  // picking up already-due rows only.
  // Phase 7n: heartbeat tickName="fast_tick".
  cron.schedule("*/3 * * * *", async () => {
    const startedAt = Date.now();
    let outcome: "ok" | "partial" | "error" = "ok";
    const details: Record<string, unknown> = {};
    if (processTickRunning) {
      // Shares the guard with process_due — both run processDueFollowups(),
      // and overlapped passes just re-select rows another pass will claim.
      // Skipping silently (no heartbeat) keeps the fast_tick heartbeat
      // stream meaningful: 20k+ rows of "skipped" entries would drown it.
      return;
    }
    processTickRunning = true;
    try {
      const result = await processDueFollowups();
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
      processTickRunning = false;
      await recordHeartbeat({
        tickName: "fast_tick",
        durationMs: Date.now() - startedAt,
        outcome,
        details,
      });
    }
  });

  // Weekly digest: Tuesday 00:00 UTC. The runWeeklyDigest() function
  // self-dedupes via users.last_weekly_digest_at (6-day window) so any
  // accidental rerun within the same Tuesday is a no-op.
  // Phase 7n: heartbeat tickName="weekly_digest".
  cron.schedule("0 0 * * 2", async () => {
    const startedAt = Date.now();
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
      await recordHeartbeat({
        tickName: "weekly_digest",
        durationMs: Date.now() - startedAt,
        outcome,
        details,
      });
    }
  }, { timezone: "UTC" });

  // B7q: retry tick for failed weekly digests. The runWeeklyDigest()
  // function's 6-day dedupe window means any user whose digest already
  // sent at 00:00 UTC will be skipped here. Only users whose digest
  // FAILED earlier today (lastWeeklyDigestAt is older than 6 days, or
  // unset) actually get a fresh send.
  cron.schedule("0 6 * * 2", async () => {
    const startedAt = Date.now();
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
      await recordHeartbeat({
        tickName: "weekly_digest_retry",
        durationMs: Date.now() - startedAt,
        outcome,
        details,
      });
    }
  }, { timezone: "UTC" });

  // CSD v1: daily prune of company-shared drafts older than retention.
  // Runs at 01:00, after the archival sweep at 00:45. Fail-open inside
  // pruneSharedDrafts(); the heartbeat records the outcome either way.
  cron.schedule("0 1 * * *", async () => {
    const startedAt = Date.now();
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
      await recordHeartbeat({
        tickName: "shared_draft_prune",
        durationMs: Date.now() - startedAt,
        outcome,
        details,
      });
    }
  });

  logger.info("Cron jobs active: sync+auto-queue @*/15, process @5,20,35,50, draft-stall @00:30, campaign-expiry @00:15, over-cap @00:20, archive-sweep @00:45, shared-draft-prune @01:00, weekly-digest @Tue 00:00 UTC + retry @Tue 06:00 UTC, fast-tick @*/3");
}
