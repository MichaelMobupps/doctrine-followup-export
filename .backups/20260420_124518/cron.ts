import cron from "node-cron";
import { syncEmails } from "./services/gmailSync";
import { processDueFollowups, autoQueueNextStages, autoQueueAllCampaigns } from "./services/scheduler";
import { logger } from "./lib/logger";

export function startCronJobs(): void {
  cron.schedule("*/15 * * * *", async () => {
    logger.info("Running Gmail sync...");
    try {
      const result = await syncEmails();
      logger.info(
        { synced: result.synced, repliesDetected: result.repliesDetected },
        "Sync done",
      );
    } catch (err) {
      logger.error({ err }, "Sync error");
    }

    try {
      const autoQueued = await autoQueueAllCampaigns();
      if (autoQueued > 0) {
        logger.info({ autoQueued }, "Auto-queued follow-up stages (all campaigns)");
      }
    } catch (err) {
      logger.error({ err }, "Auto-queue (all campaigns) error");
    }
  });

  cron.schedule("5,20,35,50 * * * *", async () => {
    logger.info("Processing due follow-ups...");
    try {
      const result = await processDueFollowups();
      logger.info(
        { sent: result.sent, failed: result.failed },
        "Follow-up processing done",
      );
    } catch (err) {
      logger.error({ err }, "Scheduler error");
    }
  });

  cron.schedule("*/3 * * * *", async () => {
    try {
      const result = await processDueFollowups();
      if (result.sent > 0 || result.processed > 0) {
        logger.info(
          { sent: result.sent, failed: result.failed },
          "Test-mode tick processed follow-ups",
        );
      }
    } catch (err) {
      logger.error({ err }, "Test-mode tick error");
    }

    try {
      const autoQueued = await autoQueueNextStages();
      if (autoQueued > 0) {
        logger.info({ autoQueued }, "Auto-queued next follow-up stages (test)");
      }
    } catch (err) {
      logger.error({ err }, "Auto-queue error");
    }

    try {
      const allQueued = await autoQueueAllCampaigns();
      if (allQueued > 0) {
        logger.info({ allQueued }, "Auto-queued follow-up stages (all campaigns, 3-min tick)");
      }
    } catch (err) {
      logger.error({ err }, "Auto-queue all error");
    }
  });

  logger.info("Cron jobs active: sync @*/15, process @5,20,35,50, test-mode @*/3");
}
