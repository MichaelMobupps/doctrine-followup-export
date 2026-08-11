/**
 * chief.ts — F-3.7a. The Chief's uplink into the Email Followupper.
 *
 *   GET <prefix>/api/chief/status     — the card, and the health pulse
 *   GET <prefix>/api/chief/accounts   — per-account connection state, paged
 *
 * Both are order-token gated, strictly read-only, and answer `Cache-Control:
 * no-store` on every path including the 401.
 *
 * ── WHY THIS ROUTER IS MOUNTED FIRST, AND WHY THAT IS NOT COSMETIC ───────────
 *
 * `routes/doctrine.ts` calls `router.use(authMiddleware)` at its top level, and
 * `routes/index.ts` mounts that router with `router.use(doctrineRouter)` — at
 * the ROOT of `/api`, with no path. Express therefore runs the shared
 * `x-api-key`/`ADDON_API_KEY` gate for every request that reaches that line,
 * whatever it was addressed to; the admin routers mounted after it are gated by
 * both keys for exactly this reason, and say so.
 *
 * The Chief holds an order-token and nothing else. It will never send
 * `x-api-key`, and it must not have to. So this router is mounted BEFORE
 * `doctrineRouter`. That ordering is the whole of the endpoint's reachability
 * and it is invisible at the call site, so `test-chief-mount.ts` boots the real
 * app and pins it: a `/api/chief/status` with no `x-api-key` must never come
 * back `{"error":"Invalid API key"}`.
 *
 * ── THE 401 IS AN ORACLE FOR NOTHING ─────────────────────────────────────────
 *
 * Every failure under this mount produces byte-identical bytes: missing header,
 * wrong scheme, wrong token, unset secret — and an unknown path or an
 * unsupported method under `/api/chief`, WHATEVER token it carries. The last
 * one is a deliberate departure from the Chief's own convention (CONTRACT.md §5
 * makes a `404` from its ingest mount the proof that your token was accepted),
 * and it has a cost that the contract states out loud: while wiring, a typo in
 * the path reads on the Chief's console as `token rejected` rather than as a
 * 404. That is the price of the 401 never enumerating what exists here, and the
 * two real paths are written verbatim in the contract so the typo is cheap to
 * find.
 */

import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import {
  APP_NAME,
  UNAUTHORISED_BODY,
  UNAVAILABLE_BODY,
  chiefTokenFromEnv,
  isAuthorisedChiefRequest,
} from "../lib/chiefAuth";
import {
  type AccountCensus,
  type CronPulse,
  buildStatusBody,
  containsEmail,
  packAccountsPage,
  parseAccountsQuery,
  startOfUtcDay,
} from "../lib/chiefView";
import {
  type AccountsSlice,
  type BudgetDayFacts,
  readAccountCensus,
  readAccountsSlice,
  readBudgetDay,
  readCronPulses,
  readDueQueueDepth,
  readGlobalPause,
  readSpendTodayUsd,
} from "../lib/chiefReaders";
import { logger } from "../lib/logger";

/**
 * The facts this router needs, injected rather than imported.
 *
 * That is what lets `test-chief-status.ts` and `test-chief-accounts.ts` drive
 * the real handlers — the real auth, the real shaping, the real 503 path —
 * against fixtures, with no database anywhere near the gate. `@workspace/db`
 * throws at import unless `DATABASE_URL` is set, so a handler that imported its
 * readers directly could only ever be tested through a live Postgres.
 */
export interface ChiefSources {
  spendTodayUsd(now: Date): Promise<number>;
  budgetDay(now: Date): Promise<BudgetDayFacts>;
  globalPause(): Promise<boolean>;
  census(): Promise<AccountCensus>;
  dueQueueDepth(now: Date): Promise<number>;
  cronPulses(now: Date): Promise<CronPulse[]>;
  accountsSlice(limit: number, offset: number): Promise<AccountsSlice>;
  /** Overridable for tests. Defaults to the real clock. */
  now?(): Date;
  /** Overridable for tests. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Never receives the token. */
  log?: { warn(obj: Record<string, unknown>, msg: string): void; error(obj: Record<string, unknown>, msg: string): void };
}

/** The production wiring: every reader from `lib/chiefReaders.ts`. */
export function realChiefSources(): ChiefSources {
  return {
    spendTodayUsd: readSpendTodayUsd,
    budgetDay: readBudgetDay,
    globalPause: readGlobalPause,
    census: readAccountCensus,
    dueQueueDepth: readDueQueueDepth,
    cronPulses: readCronPulses,
    accountsSlice: readAccountsSlice,
    log: logger,
  };
}

export function createChiefRouter(sources: ChiefSources): IRouter {
  const router: IRouter = Router();
  const now = sources.now ?? (() => new Date());
  const log = sources.log;

  /**
   * The gate. Runs for every path under this mount, before anything else, and
   * is the only place the token is read.
   *
   * `no-store` is set here rather than per-handler so it is on the 401 and the
   * unknown-path 401 too: a status is true for an instant, and an intermediary
   * holding one would answer for a state that has moved on.
   */
  router.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Cache-Control", "no-store");
    const env = sources.env ?? process.env;
    if (!isAuthorisedChiefRequest(req.headers.authorization, chiefTokenFromEnv(env))) {
      res.status(401).json(UNAUTHORISED_BODY);
      return;
    }
    next();
  });

  /**
   * Send a body, or 503 rather than send an email address.
   *
   * The label rule in `accountLabel()` is what actually keeps addresses off
   * this seam. This is the second, independent check, over the FINISHED bytes,
   * so the property is structural rather than a convention somebody has to
   * remember while editing a mapper. It can only fire on a defect, and when it
   * does the right answer is the one the Chief already knows how to handle —
   * "cannot read my own numbers" — not a leak.
   *
   * The offending text is deliberately NOT logged. A guard against putting an
   * address on the wire that writes the address into the log line is not a
   * guard.
   */
  function sendGuarded(res: Response, body: unknown, what: string): void {
    const text = JSON.stringify(body);
    if (containsEmail(text)) {
      log?.error(
        { endpoint: what },
        "F-3.7a: an email address reached a Chief payload — refusing to send it and answering 503. This is a defect in the payload builder, not a transient fault.",
      );
      res.status(503).json(UNAVAILABLE_BODY);
      return;
    }
    res.status(200).type("application/json").send(text);
  }

  router.get("/status", async (_req: Request, res: Response) => {
    const at = now();
    try {
      // Issued together: they are independent round trips and this endpoint
      // exists to be polled, so serialising them would multiply its latency by
      // the number of facts it reports.
      const [spendTodayUsd, budgetDay, sendingPausedGlobally, census, dueQueueDepth, crons] =
        await Promise.all([
          sources.spendTodayUsd(at),
          sources.budgetDay(at),
          sources.globalPause(),
          sources.census(),
          sources.dueQueueDepth(at),
          sources.cronPulses(at),
        ]);

      sendGuarded(
        res,
        buildStatusBody(
          {
            spendTodayUsd,
            utcDayStart: startOfUtcDay(at),
            census,
            dueQueueDepth,
            crons,
            sendingPausedGlobally,
            budgetDay,
            now: at,
          },
          APP_NAME,
        ),
        "status",
      );
    } catch (err) {
      // `err` comes from a database read. It has never been near the token, and
      // the token is not in scope here to be logged by accident.
      log?.warn({ err }, "F-3.7a: Chief status could not be answered; replied 503");
      res.status(503).json(UNAVAILABLE_BODY);
    }
  });

  router.get("/accounts", async (req: Request, res: Response) => {
    const at = now();
    try {
      const q = parseAccountsQuery(req.query as Record<string, unknown>);
      const slice = await sources.accountsSlice(q.limit, q.offset);
      sendGuarded(
        res,
        packAccountsPage({
          rows: slice.rows,
          limit: q.limit,
          offset: q.offset,
          total: slice.total,
          serverTime: at.toISOString(),
          appName: APP_NAME,
        }),
        "accounts",
      );
    } catch (err) {
      log?.warn({ err }, "F-3.7a: Chief accounts could not be answered; replied 503");
      res.status(503).json(UNAVAILABLE_BODY);
    }
  });

  /**
   * Anything else under this mount — an unknown path, or a method these two
   * endpoints do not serve — gets the identical 401. See the header: the 401 is
   * an oracle for nothing, including for what exists here.
   */
  router.use((_req: Request, res: Response) => {
    res.status(401).json(UNAUTHORISED_BODY);
  });

  return router;
}

export default createChiefRouter;
