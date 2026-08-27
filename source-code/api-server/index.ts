// Phase 6: pin the process timezone to UTC before ANY Date arithmetic
// runs. The schedule math in timingEngine.ts uses setUTCHours/getUTCDay
// explicitly, but this guarantees that any code path which still uses
// the local-tz variants (third-party libs, future code) also operates
// on UTC. Set it as early as possible — before importing modules that
// may read/cache the tz.
process.env.TZ = "UTC";

import app from "./app";
import { logger } from "./lib/logger";
// Aug 2026: every LLM role runs on a Gemini/OpenAI fallback waterfall. Resolve
// and validate all of them before listening.
import { validateAllChains, describeChain } from "./lib/modelPolicy";
import { isGeminiConfigured } from "./lib/gemini";
import { isOpenAiConfigured } from "./lib/openai";
import { startCronJobs } from "./cron";
// B7r: startup migrations import (currently: ensure followup_usage table exists).
import { runStartupMigrations } from "./lib/startupMigrations";
// F-3.6a: deploy-time auth-dead backfill + stranded-generating recovery.
import { runDeployRecovery } from "./lib/deployRecovery";

if (Intl.DateTimeFormat().resolvedOptions().timeZone !== "UTC") {
  // The TZ env var should pin Node's date math, but if Intl reports
  // something else, the host has overridden it in a way Node respects.
  // Fail loudly rather than silently miscompute send-windows.
  throw new Error(
    `Process timezone is ${Intl.DateTimeFormat().resolvedOptions().timeZone}, not UTC. ` +
    `Doctrine schedule math assumes UTC. Refusing to start.`,
  );
}

/**
 * Resolve every LLM role's model chain at boot.
 *
 * This is a deliberate fail-fast. `validateAllChains` throws if any chain — a
 * built-in or an `LLM_CHAIN_*` env override — names an Anthropic model, and a
 * malformed override is the kind of thing you want to discover in the deploy
 * log, not at 2am on the first follow-up of the night.
 *
 * It also logs the resolved chains, so "what did this deployment actually run
 * on?" is answerable from the boot output alone rather than by reading the
 * source at the commit that was deployed.
 */
const resolvedChains = validateAllChains();
for (const [role, chain] of Object.entries(resolvedChains)) {
  logger.info({ role, chain: describeChain(chain) }, "LLM chain resolved");
}

// A missing key does not stop the server — the router simply skips that
// vendor's tiers — but it silently halves every waterfall, so say so loudly.
// Losing BOTH is fatal: there would be nothing left to write a follow-up with.
const geminiOk = isGeminiConfigured();
const openaiOk = isOpenAiConfigured();
if (!geminiOk && !openaiOk) {
  throw new Error(
    "Neither GEMINI_API_KEY nor OPENAI_API_KEY is set. Every LLM role would " +
      "have no usable tier, so no follow-up could be generated. Add at least " +
      "one as a Replit Secret on BOTH the workspace and the deployment.",
  );
}
if (!geminiOk || !openaiOk) {
  logger.warn(
    { geminiConfigured: geminiOk, openaiConfigured: openaiOk },
    "Only one LLM vendor is configured — every fallback waterfall is running at " +
      "half depth, and a single-vendor outage will stop follow-up generation",
  );
}

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// B7r: kick off startup migrations. Fire-and-forget so a slow DB
// connection cannot block the listen() call (Replit healthchecks
// could time out otherwise). recordUsageBestEffort() is already
// best-effort, so the rare window where the table is not yet
// present just results in warnings, not failed sends.
const migrationsDone = runStartupMigrations().catch((err) =>
  logger.error({ err }, "B7r: startup migration kickoff failed (non-fatal)"),
);

const server = app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  logger.info("This is a headless API — the UI lives in the Gmail Add-on");

  startCronJobs();

  // F-3.6a: the two named deploy-time recovery passes. AFTER listen() and
  // fire-and-forget, so a slow OAuth exchange can never hold up the platform
  // health check. Read-only probe plus a status move; neither sends,
  // generates, nor deletes. See lib/deployRecovery.ts.
  //
  // Chained off the migration promise, NOT started in parallel with it: the
  // backfill reads users.auth_dead_at, and that column is created by the
  // migration above. Racing them would have the first boot after this order
  // ships fail on "column does not exist" — recoverably, but the backfill
  // would then not happen until the next restart, which is exactly the pass
  // that has to run once.
  migrationsDone
    .then(() => runDeployRecovery())
    .catch((err) =>
      logger.error({ err }, "F-3.6a: deploy-time recovery kickoff failed (non-fatal)"),
    );
});

process.on("SIGTERM", () => {
  logger.info("SIGTERM received — draining connections");
  server.close(() => {
    logger.info("Server closed cleanly");
    process.exit(0);
  });
});

process.on("SIGINT", () => {
  logger.info("SIGINT received — shutting down");
  server.close(() => process.exit(0));
});

process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "Uncaught exception — shutting down");
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logger.error({ reason }, "Unhandled promise rejection");
});
