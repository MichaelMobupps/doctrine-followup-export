/**
 * admin-cron-heartbeats.ts — F-3.6a.
 *
 * GET /api/admin/cron-heartbeats — the read surface over `cron_heartbeats`.
 *
 * That table has recorded one row per cron tick since Phase 7n and nothing
 * has ever been able to read it. F-D4 (2026-08-09) could not answer "are the
 * crons firing right now" from any production surface because of it, and had
 * to infer a tick from an LLM usage row eighteen hours old. This closes that
 * gap: liveness becomes checkable with an admin key and a URL, no repo
 * access and no deployment-log pane required.
 *
 * Auth: requireAdmin (x-admin-key === ADMIN_API_KEY), on top of the shared
 * x-api-key gate that the doctrine router already applies to everything
 * mounted under /api. Two keys, same as every other /api/admin route.
 *
 * Every `details` payload passes through redactHeartbeatDetails() first —
 * the cron writes raw googleapis error text into that column, and a
 * googleapis error can serialise a request config carrying
 * `Authorization: Bearer …`.
 *
 * Query params (all optional):
 *   limit  — 1..200, default 50
 *   tick   — restrict to one tickName
 *   since  — ISO timestamp lower bound on fired_at
 *   until  — ISO timestamp upper bound on fired_at
 */

import { Router, type Request, type Response } from "express";
import { db, cronHeartbeatsTable } from "@workspace/db";
import { and, eq, gte, lte, desc, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { requireAdmin } from "../middlewares/requireAdmin";
import {
  parseHeartbeatQuery,
  redactHeartbeatDetails,
} from "../lib/heartbeatView";
import { HEARTBEAT_RUNNING } from "../lib/heartbeatLifecycle";

const router = Router();

router.use(requireAdmin);

router.get("/admin/cron-heartbeats", async (req: Request, res: Response) => {
  try {
    const q = parseHeartbeatQuery(req.query as Record<string, unknown>);

    const conditions = [];
    if (q.tickName) conditions.push(eq(cronHeartbeatsTable.tickName, q.tickName));
    if (q.since) conditions.push(gte(cronHeartbeatsTable.firedAt, q.since));
    if (q.until) conditions.push(lte(cronHeartbeatsTable.firedAt, q.until));
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const rows = await db
      .select({
        id: cronHeartbeatsTable.id,
        tick_name: cronHeartbeatsTable.tickName,
        fired_at: cronHeartbeatsTable.firedAt,
        outcome: cronHeartbeatsTable.outcome,
        duration_ms: cronHeartbeatsTable.durationMs,
        details: cronHeartbeatsTable.details,
      })
      .from(cronHeartbeatsTable)
      .where(where)
      .orderBy(desc(cronHeartbeatsTable.firedAt))
      .limit(q.limit);

    // The "is it alive RIGHT NOW" answer, per tick, independent of the
    // limit/filter the caller asked for. Without this an operator has to
    // eyeball a list and do date arithmetic in their head — which is what
    // made the 48-hour-dead incident class hard to spot in the first place.
    const latestPerTick = await db
      .select({
        tick_name: cronHeartbeatsTable.tickName,
        last_fired_at: sql<string>`max(${cronHeartbeatsTable.firedAt})`,
        // F-3.7c: the database's clock, in the same snapshot as the counters,
        // for the same reason as `readCronPulses()` — the app clock had no
        // business in a comparison against a stored timestamp. Unlike the Chief
        // seam, NO tick is withheld here: `process_start` is the row that tells
        // an operator a hole in the stream was a restart, so this is the surface
        // that must show it.
        seconds_since_last: sql<
          number
        >`greatest(0, round(extract(epoch from (now() - max(${cronHeartbeatsTable.firedAt})))))::int`,
        ticks_24h: sql<number>`count(*) filter (where ${cronHeartbeatsTable.firedAt} > now() - interval '24 hours')::int`,
        // F-3.7c: an in-flight tick sits at `running` and is not an error.
        errors_24h: sql<number>`count(*) filter (where ${cronHeartbeatsTable.firedAt} > now() - interval '24 hours' and ${cronHeartbeatsTable.outcome} not in ('ok', ${HEARTBEAT_RUNNING}))::int`,
        running_now: sql<number>`count(*) filter (where ${cronHeartbeatsTable.outcome} = ${HEARTBEAT_RUNNING} and ${cronHeartbeatsTable.firedAt} > now() - interval '24 hours')::int`,
        // F-3.7c: seconds since the last firing that reached an OUTCOME. Sits
        // beside seconds_since_last for the same reason the Chief gets both: a
        // tick firing into a hang keeps the first small while this one climbs.
        // CASE rather than a bare greatest(): `greatest(0, NULL)` is 0 in
        // Postgres, which would report "nothing has ever finished" as "finished
        // this second". Same spelling as readCronPulses() for the same reason.
        seconds_since_last_result: sql<number | null>`case
          when max(${cronHeartbeatsTable.firedAt}) filter (where ${cronHeartbeatsTable.outcome} <> ${HEARTBEAT_RUNNING}) is null then null
          else greatest(0, round(extract(epoch from (now() - max(${cronHeartbeatsTable.firedAt}) filter (where ${cronHeartbeatsTable.outcome} <> ${HEARTBEAT_RUNNING})))))::int
        end`,
      })
      .from(cronHeartbeatsTable)
      .groupBy(cronHeartbeatsTable.tickName)
      .orderBy(cronHeartbeatsTable.tickName);

    const now = new Date();
    res.json({
      now: now.toISOString(),
      query: {
        limit: q.limit,
        tick: q.tickName,
        since: q.since?.toISOString() ?? null,
        until: q.until?.toISOString() ?? null,
      },
      ticks: latestPerTick.map((t) => {
        const last = t.last_fired_at ? new Date(t.last_fired_at) : null;
        const age = Number(t.seconds_since_last);
        return {
          tick_name: t.tick_name,
          last_fired_at: last ? last.toISOString() : null,
          seconds_since_last: Number.isFinite(age) ? age : null,
          seconds_since_last_result:
            t.seconds_since_last_result === null ? null : Number(t.seconds_since_last_result),
          ticks_24h: t.ticks_24h,
          errors_24h: t.errors_24h,
          // F-3.7c: rows still at `running`. Normally 0 or 1 — one firing that
          // has not finished yet. A number that stays above 1 for a tick means
          // firings are starting and not finishing, which is the state that
          // used to be invisible entirely.
          running_24h: t.running_now,
        };
      }),
      heartbeats: rows.map((r) => ({
        id: r.id,
        tick_name: r.tick_name,
        fired_at: r.fired_at.toISOString(),
        outcome: r.outcome,
        duration_ms: r.duration_ms,
        details: redactHeartbeatDetails(r.details),
      })),
    });
  } catch (err) {
    logger.error({ err }, "Failed to read cron heartbeats");
    res.status(500).json({ error: "Failed to read cron heartbeats" });
  }
});

export default router;
