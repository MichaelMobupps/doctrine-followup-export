import app from "./app";
import { logger } from "./lib/logger";
import { startCronJobs } from "./cron";

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

const server = app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  logger.info("This is a headless API — the UI lives in the Gmail Add-on");

  startCronJobs();
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
