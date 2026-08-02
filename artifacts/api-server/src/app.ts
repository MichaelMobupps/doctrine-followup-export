import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "path";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import router from "./routes";
import healthRouter from "./routes/health";
import { logger } from "./lib/logger";
import { BASE_PATH, legacyRedirectTarget } from "./lib/appUrls";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Bundle 2: every mount below is gated on this. When BASE_PATH is unset it is
// "/" and NOTHING in this file changes — same mounts, same order, same
// responses as before the bundle.
const PREFIXED = BASE_PATH !== "/";

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

// ---------------------------------------------------------------------------
// Bare-prefix redirect:  GET /followup  ->  /followup/
//
// Registered as plain middleware with an EXACT string compare, deliberately
// NOT as `app.get(BASE_PATH, ...)`. Express routing is non-strict, so a route
// registered at "/followup" also matches "/followup/" — the handler would then
// redirect "/followup/" to itself and the main page would hang in a redirect
// loop. Two sibling apps in this migration hit exactly that. An exact
// `req.path === BASE_PATH` test cannot match the trailing-slash form, so the
// loop is structurally impossible rather than merely avoided.
//
// 302 rather than 301: rollback for this bundle is unsetting the env vars, and
// a 301 would sit in browser caches long after the prefix was withdrawn.
// ---------------------------------------------------------------------------
if (PREFIXED) {
  app.use((req, res, next) => {
    if (req.path !== BASE_PATH) {
      next();
      return;
    }
    const queryStart = req.originalUrl.indexOf("?");
    const query = queryStart === -1 ? "" : req.originalUrl.slice(queryStart);
    res.redirect(302, `${BASE_PATH}/${query}`);
  });
}

// Platform startup health check. `.replit-artifact/artifact.toml` declares
// [services.production.health.startup] path = "/api/healthz" as a LITERAL,
// unprefixed path, and that file's health path is intentionally left alone.
// Mounting the same handler unconditionally keeps both states healthy: the
// prefixed one, and the rolled-back one that rollback produces by unsetting
// the env vars.
app.use("/api", healthRouter);

// ---------------------------------------------------------------------------
// THE LEGACY API MOUNT. Unprefixed, unconditional, first-class — NOT a
// redirect, and it must stay that way.
//
// Repair L1 verified against production that every machine caller of this app
// still addresses the unprefixed form:
//   - the Apps Script add-on, which builds `BACKEND_URL + "/api/..."` and has
//     9 such call sites (4 POST, 5 GET) — see addon/Config.gs:17-42;
//   - both Google OAuth callbacks, /api/auth/callback and /api/gmail/callback;
//   - the platform startup health check, which artifact.toml declares as the
//     LITERAL path "/api/healthz".
//
// A 308 would satisfy a browser but not these: senders routinely drop the
// body or downgrade the method on a redirect, and a health check that answers
// 3xx is not reliably read as healthy. The prefixed mount below is ADDITIVE —
// both forms are served, neither forwards to the other.
// ---------------------------------------------------------------------------
app.use("/api", router);

// The API under the prefix. Mounted BEFORE the SPA static/catch-all below so
// that an API path always wins and can never be answered with index.html.
if (PREFIXED) {
  app.use(`${BASE_PATH}/api`, router);

  // Terminator for prefixed API paths that no route matched. Without it they
  // fall through to the SPA catch-all and come back as index.html with status
  // 200, which turns a typo into a silent success for any API client.
  // Deliberately NOT mounted on the unprefixed "/api": that would change the
  // dark path's existing fall-through behavior.
  app.use(`${BASE_PATH}/api`, (_req, res) => {
    res.status(404).json({ error: "Not found" });
  });
}

// ---------------------------------------------------------------------------
// Repair L1: legacy address survival for BROWSER paths.
//
//   GET /pipeline?x=1   ->  308  /followup/pipeline?x=1
//
// Registered here on purpose: AFTER both /api mounts, so an API request can
// never be turned into a redirect, and BEFORE the api-server's own static
// dir, so the legacy root "/" is redirected into the app rather than
// answering with the pre-prefix API test console.
//
// 308, not 302: it preserves the method and the body, and the roadmap treats
// the old address as a permanent move. The cost is that browsers cache it —
// see the Open items note in TODO.md, because rollback for this migration is
// "unset the env vars" and a cached 308 outlives that. The client-side
// pre-mount redirect in dashboard/src/main.tsx is what actually fires for
// real browsers today (the platform routes these paths to the dashboard's
// static artifact, so they never reach Express in production); this rule is
// the backstop for anything addressing the api-server directly.
//
// Every exclusion, the loop guard and the path normalization live in
// legacyRedirectTarget() so that this middleware and the unit tests exercise
// ONE implementation rather than two that can drift apart.
// ---------------------------------------------------------------------------
if (PREFIXED) {
  app.use((req, res, next) => {
    const target = legacyRedirectTarget(req.path);
    if (target === null) {
      next();
      return;
    }
    const queryStart = req.originalUrl.indexOf("?");
    const query = queryStart === -1 ? "" : req.originalUrl.slice(queryStart);
    res.redirect(308, `${target}${query}`);
  });
}

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

// ---------------------------------------------------------------------------
// SPA under the prefix.
//
// Only when BASE_PATH is set. The dashboard is normally its own statically
// served artifact; under a prefix this server serves it so that one origin
// answers for both the API and the UI.
//
// `app.use(BASE_PATH, ...)` rather than a wildcard route: under Express 5 /
// path-to-regexp v8, `app.get("/followup/*", ...)` THROWS at registration
// ("Missing parameter name"), which is a boot crash rather than a 404. Prefix
// middleware sidesteps path-to-regexp entirely.
// ---------------------------------------------------------------------------
if (PREFIXED) {
  // Resolves to artifacts/dashboard/dist/public from BOTH src/ (dev, via tsx)
  // and dist/ (production bundle), since both are one level under
  // artifacts/api-server/.
  const spaDir = path.resolve(__dirname, "..", "..", "dashboard", "dist", "public");

  // Fail loudly at boot instead of serving 500s per request. Without the
  // dashboard build present, every SPA route would sendFile a missing
  // index.html and surface as an opaque 500 with no hint of the cause.
  if (!existsSync(path.join(spaDir, "index.html"))) {
    logger.warn(
      { spaDir, basePath: BASE_PATH },
      "BASE_PATH is set but the dashboard build is missing — SPA routes under " +
        "the prefix will fail. Build @workspace/dashboard with the same BASE_PATH.",
    );
  }

  app.use(
    BASE_PATH,
    express.static(spaDir, {
      setHeaders: (res, filePath) => {
        if (filePath.endsWith(".html")) res.setHeader("Cache-Control", "no-cache");
      },
    }),
  );

  app.use(BASE_PATH, (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      next();
      return;
    }

    // A request that looks like a file is an ASSET request. express.static
    // already had its chance, so the file genuinely is not there: answer 404
    // honestly. Serving index.html with status 200 here is the classic SPA
    // catch-all bug — a missing bundle then reports success and the page fails
    // later with an opaque MIME/parse error instead of a clean 404.
    if (path.extname(req.path) !== "") {
      next();
      return;
    }

    res.sendFile(path.join(spaDir, "index.html"), {
      headers: { "Cache-Control": "no-cache" },
    });
  });
}

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = err instanceof Error ? err.message : String(err);
  logger.error({ err }, "Unhandled route error");
  if (!res.headersSent) {
    res.status(500).json({ error: message });
  }
});

export default app;
