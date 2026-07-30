import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "path";
import { fileURLToPath } from "url";
import router from "./routes";
import { logger } from "./lib/logger";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

const publicDir = path.join(__dirname, "public");
// 2026-07-29: serve HTML with no-cache so a re-publish is picked up on the
// next normal reload. Without an explicit Cache-Control, browsers
// heuristically cached index.html and kept referencing the PREVIOUS
// deploy's hashed bundle — operators saw stale UI after fixes shipped.
// Hashed assets (JS/CSS) keep default caching; their filenames change per
// content, so they are safe to cache indefinitely.
app.use(
  express.static(publicDir, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith(".html")) res.setHeader("Cache-Control", "no-cache");
    },
  }),
);
app.get("/", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"), {
    headers: { "Cache-Control": "no-cache" },
  });
});

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = err instanceof Error ? err.message : String(err);
  logger.error({ err }, "Unhandled route error");
  if (!res.headersSent) {
    res.status(500).json({ error: message });
  }
});

export default app;
