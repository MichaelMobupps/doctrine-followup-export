// B7s: admin activity endpoint.
//
// Reads the followup_usage table (populated by B7r) and returns a
// rolled-up view suitable for an admin dashboard. Shape mirrors the
// Email Prospector's /admin/activity adapted for the Followuper's
// event-based attribution (one row per LLM call, not per job).
//
// Auth: requireAdmin — x-admin-key must match ADMIN_API_KEY (same gate as
// /admin/salvage from B7o).
//
// Query params (all optional):
//   user_id  — restrict to one user
//   app      — "doctrine" | "context"
//   since    — ISO timestamp; default = now - 7 days
//   until    — ISO timestamp; default = now
//
// Response shape (see end of this file for the canonical example).
//
// Cost values are returned as JavaScript numbers (float8 cast from
// the numeric column). Precision is fine through ~$1M; we'll never
// be anywhere near that ceiling for a single window.

import { Router, type Request, type Response } from "express";
import {
  db,
  followupUsageTable,
  usersTable,
  prospectsTable,
  followupsTable,
} from "@workspace/db";
import { and, eq, gte, lte, desc, sql } from "drizzle-orm";
import { logger } from "../lib/logger";

import { requireAdmin } from "../middlewares/requireAdmin";
// F-3.6a: the retry budget, so the "held" count means the same thing here as
// it does in the policy that produces it.
import { MAX_AUTO_RETRIES } from "../lib/retryPolicy";

const router = Router();

router.use(requireAdmin);

const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_EVENTS_RETURNED = 200;

function parseWindow(req: Request): { since: Date; until: Date } {
  const now = Date.now();
  const sinceRaw = req.query.since ? String(req.query.since) : null;
  const untilRaw = req.query.until ? String(req.query.until) : null;
  const since = sinceRaw ? new Date(sinceRaw) : new Date(now - DEFAULT_WINDOW_MS);
  const until = untilRaw ? new Date(untilRaw) : new Date(now);
  // If the user passes garbage, fall back to default rather than 500.
  if (isNaN(since.getTime())) return { since: new Date(now - DEFAULT_WINDOW_MS), until: new Date(now) };
  if (isNaN(until.getTime())) return { since, until: new Date(now) };
  return { since, until };
}

router.get("/admin/activity", async (req: Request, res: Response) => {
  try {
    const { since, until } = parseWindow(req);
    const userIdRaw = req.query.user_id ? parseInt(String(req.query.user_id), 10) : NaN;
    const userFilter = Number.isFinite(userIdRaw) ? userIdRaw : null;
    const appRaw = req.query.app ? String(req.query.app) : null;
    const appFilter = appRaw === "doctrine" || appRaw === "context" || appRaw === "anti_ghosting" ? appRaw : null;

    const conditions = [
      gte(followupUsageTable.generatedAt, since),
      lte(followupUsageTable.generatedAt, until),
    ];
    if (userFilter !== null) conditions.push(eq(followupUsageTable.userId, userFilter));
    if (appFilter) conditions.push(eq(followupUsageTable.app, appFilter));
    const where = and(...conditions);

    // Q1 — window totals (single aggregate row).
    const totalsRow = (await db
      .select({
        events: sql<number>`count(*)::int`,
        followups: sql<number>`count(distinct ${followupUsageTable.followupId})::int`,
        input_tokens: sql<number>`coalesce(sum(${followupUsageTable.inputTokens}), 0)::int`,
        output_tokens: sql<number>`coalesce(sum(${followupUsageTable.outputTokens}), 0)::int`,
        cache_creation_tokens: sql<number>`coalesce(sum(${followupUsageTable.cacheCreationTokens}), 0)::int`,
        cache_read_tokens: sql<number>`coalesce(sum(${followupUsageTable.cacheReadTokens}), 0)::int`,
        web_searches: sql<number>`coalesce(sum(${followupUsageTable.webSearches}), 0)::int`,
        cost_usd: sql<number>`coalesce(sum(${followupUsageTable.costUsd}), 0)::float8`,
      })
      .from(followupUsageTable)
      .where(where))[0] ?? {
        events: 0,
        followups: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_tokens: 0,
        cache_read_tokens: 0,
        web_searches: 0,
        cost_usd: 0,
      };

    // Q2 — per-user totals (joined to users for email/name display).
    const perUser = await db
      .select({
        user_id: followupUsageTable.userId,
        email: usersTable.email,
        name: usersTable.name,
        events: sql<number>`count(*)::int`,
        followups: sql<number>`count(distinct ${followupUsageTable.followupId})::int`,
        input_tokens: sql<number>`coalesce(sum(${followupUsageTable.inputTokens}), 0)::int`,
        output_tokens: sql<number>`coalesce(sum(${followupUsageTable.outputTokens}), 0)::int`,
        cache_creation_tokens: sql<number>`coalesce(sum(${followupUsageTable.cacheCreationTokens}), 0)::int`,
        cache_read_tokens: sql<number>`coalesce(sum(${followupUsageTable.cacheReadTokens}), 0)::int`,
        web_searches: sql<number>`coalesce(sum(${followupUsageTable.webSearches}), 0)::int`,
        cost_usd: sql<number>`coalesce(sum(${followupUsageTable.costUsd}), 0)::float8`,
      })
      .from(followupUsageTable)
      .leftJoin(usersTable, eq(followupUsageTable.userId, usersTable.id))
      .where(where)
      .groupBy(followupUsageTable.userId, usersTable.email, usersTable.name)
      .orderBy(sql`coalesce(sum(${followupUsageTable.costUsd}), 0) desc`);

    // Q3 — per-user-by-app rollup (sparse: only rows that have data).
    const perUserApp = await db
      .select({
        user_id: followupUsageTable.userId,
        app: followupUsageTable.app,
        events: sql<number>`count(*)::int`,
        input_tokens: sql<number>`coalesce(sum(${followupUsageTable.inputTokens}), 0)::int`,
        output_tokens: sql<number>`coalesce(sum(${followupUsageTable.outputTokens}), 0)::int`,
        cost_usd: sql<number>`coalesce(sum(${followupUsageTable.costUsd}), 0)::float8`,
      })
      .from(followupUsageTable)
      .where(where)
      .groupBy(followupUsageTable.userId, followupUsageTable.app);

    // Q4 — per-user-by-stage rollup.
    const perUserStage = await db
      .select({
        user_id: followupUsageTable.userId,
        stage: followupUsageTable.stage,
        events: sql<number>`count(*)::int`,
        cost_usd: sql<number>`coalesce(sum(${followupUsageTable.costUsd}), 0)::float8`,
      })
      .from(followupUsageTable)
      .where(where)
      .groupBy(followupUsageTable.userId, followupUsageTable.stage);

    // Q5 — per-user-by-model rollup.
    const perUserModel = await db
      .select({
        user_id: followupUsageTable.userId,
        model: followupUsageTable.model,
        events: sql<number>`count(*)::int`,
        input_tokens: sql<number>`coalesce(sum(${followupUsageTable.inputTokens}), 0)::int`,
        output_tokens: sql<number>`coalesce(sum(${followupUsageTable.outputTokens}), 0)::int`,
        cost_usd: sql<number>`coalesce(sum(${followupUsageTable.costUsd}), 0)::float8`,
      })
      .from(followupUsageTable)
      .where(where)
      .groupBy(followupUsageTable.userId, followupUsageTable.model);

    // Q6 — most recent events, with user + prospect display data.
    const events = await db
      .select({
        id: followupUsageTable.id,
        followup_id: followupUsageTable.followupId,
        prospect_id: followupUsageTable.prospectId,
        user_id: followupUsageTable.userId,
        user_email: usersTable.email,
        user_name: usersTable.name,
        prospect_name: prospectsTable.prospectName,
        prospect_company: prospectsTable.company,
        app: followupUsageTable.app,
        stage: followupUsageTable.stage,
        label: followupUsageTable.label,
        model: followupUsageTable.model,
        input_tokens: followupUsageTable.inputTokens,
        output_tokens: followupUsageTable.outputTokens,
        cache_creation_tokens: followupUsageTable.cacheCreationTokens,
        cache_read_tokens: followupUsageTable.cacheReadTokens,
        web_searches: followupUsageTable.webSearches,
        cost_usd: sql<number>`${followupUsageTable.costUsd}::float8`,
        generated_at: followupUsageTable.generatedAt,
      })
      .from(followupUsageTable)
      .leftJoin(usersTable, eq(followupUsageTable.userId, usersTable.id))
      .leftJoin(prospectsTable, eq(followupUsageTable.prospectId, prospectsTable.id))
      .where(where)
      .orderBy(desc(followupUsageTable.generatedAt))
      .limit(MAX_EVENTS_RETURNED);

    // Q7 — current "in flight" count. NOT filtered by window; shows
    // the live state right now. Pre-B7v this is the only signal that
    // generation is actively in progress.
    const activeRow = (await db
      .select({ count: sql<number>`count(*)::int` })
      .from(followupsTable)
      .where(eq(followupsTable.status, "generating")))[0];

    // Q7b (F-3.6a) — failed rows, by reason, live.
    //
    // Before this order these counts were structurally meaningless: a failed
    // row was revived and wiped by the next auto-queue pass within 15
    // minutes, so the whole fleet showed two of them on 2026-08-09 while six
    // accounts were failing every send they attempted. Now failures persist,
    // and this is where an operator sees them.
    //
    // `held` is the subset the next automatic sweep will NOT pick up as
    // things stand: retries spent, or a reason the policy refuses. Note the
    // `auth_dead` rows in it are held only while their owner's grant is
    // dead — those resume by themselves on reconnect, and leave this census
    // when they do. `stranded` and `retries_exhausted` are the ones that
    // genuinely want a human.
    const failedRows = await db
      .select({
        failure_reason: followupsTable.failureReason,
        count: sql<number>`count(*)::int`,
        held: sql<number>`count(*) filter (where ${followupsTable.retryCount} >= ${MAX_AUTO_RETRIES} or ${followupsTable.failureReason} in ('stranded', 'auth_dead'))::int`,
      })
      .from(followupsTable)
      .where(eq(followupsTable.status, "failed"))
      .groupBy(followupsTable.failureReason);

    const failures = {
      total: failedRows.reduce((acc, r) => acc + r.count, 0),
      held: failedRows.reduce((acc, r) => acc + r.held, 0),
      by_reason: Object.fromEntries(
        failedRows.map((r) => [r.failure_reason ?? "unclassified", r.count]),
      ) as Record<string, number>,
    };

    // Q8 — full user list for filter UI dropdown (independent of window).
    // B7u: paused_by_admin in users response so the dashboard can show
    // pause/resume buttons in the correct state.
    const users = await db
      .select({
        id: usersTable.id,
        email: usersTable.email,
        name: usersTable.name,
        paused_by_admin: usersTable.pausedByAdmin,
      })
      .from(usersTable)
      .orderBy(usersTable.email);

    // Stitch the per-user rollups together. We do this in JS rather
    // than as one mega-query because the sparse nature of stage/model
    // dimensions doesn't translate well to a single grouped query.
    type AppRollup = { events: number; input_tokens: number; output_tokens: number; cost_usd: number };
    type StageRollup = { events: number; cost_usd: number };
    type ModelRollup = AppRollup;

    const userTotals = perUser.map((u) => {
      const by_app: Record<string, AppRollup> = {};
      for (const r of perUserApp) {
        if (r.user_id !== u.user_id) continue;
        by_app[r.app] = {
          events: r.events,
          input_tokens: r.input_tokens,
          output_tokens: r.output_tokens,
          cost_usd: Number(r.cost_usd),
        };
      }
      const by_stage: Record<string, StageRollup> = {};
      for (const r of perUserStage) {
        if (r.user_id !== u.user_id) continue;
        by_stage[String(r.stage)] = {
          events: r.events,
          cost_usd: Number(r.cost_usd),
        };
      }
      const by_model: Record<string, ModelRollup> = {};
      for (const r of perUserModel) {
        if (r.user_id !== u.user_id) continue;
        by_model[r.model] = {
          events: r.events,
          input_tokens: r.input_tokens,
          output_tokens: r.output_tokens,
          cost_usd: Number(r.cost_usd),
        };
      }
      return {
        user_id: u.user_id,
        email: u.email,
        name: u.name,
        events: u.events,
        followups: u.followups,
        input_tokens: u.input_tokens,
        output_tokens: u.output_tokens,
        cache_creation_tokens: u.cache_creation_tokens,
        cache_read_tokens: u.cache_read_tokens,
        web_searches: u.web_searches,
        cost_usd: Number(u.cost_usd),
        by_app,
        by_stage,
        by_model,
      };
    });

    // Numeric columns come back as strings from Drizzle by default
    // (we cast to float8 in SELECT but the row objects still need a
    // belt-and-braces Number() for the costUsd in events).
    const eventsCoerced = events.map((e) => ({
      ...e,
      cost_usd: Number(e.cost_usd),
    }));

    res.json({
      window: { since: since.toISOString(), until: until.toISOString() },
      filter: {
        user_id: userFilter,
        app: appFilter,
      },
      active_generations: activeRow?.count ?? 0,
      // F-3.6a: live failed-row census. Not window-filtered — a failure that
      // has been sitting for a week is exactly the one worth seeing.
      failures,
      totals: {
        events: totalsRow.events,
        followups: totalsRow.followups,
        input_tokens: totalsRow.input_tokens,
        output_tokens: totalsRow.output_tokens,
        cache_creation_tokens: totalsRow.cache_creation_tokens,
        cache_read_tokens: totalsRow.cache_read_tokens,
        web_searches: totalsRow.web_searches,
        cost_usd: Number(totalsRow.cost_usd),
      },
      users,
      user_totals: userTotals,
      events: eventsCoerced,
    });
  } catch (err) {
    logger.error({ err }, "B7s: /admin/activity failed");
    res.status(500).json({ error: "Failed to fetch activity" });
  }
});

export default router;

/* ── Canonical response example ─────────────────────────────────────
{
  "window": { "since": "...", "until": "..." },
  "filter": { "user_id": null, "app": null },
  "active_generations": 0,
  "failures": {
    "total": 3,
    "held": 3,
    "by_reason": { "stranded": 2, "auth_dead": 1 }
  },
  "totals": {
    "events": 2,
    "followups": 1,
    "input_tokens": 7744,
    "output_tokens": 671,
    "cache_creation_tokens": 0,
    "cache_read_tokens": 0,
    "web_searches": 0,
    "cost_usd": 0.044729
  },
  "users": [ { "id": 2, "email": "...", "name": "..." }, ... ],
  "user_totals": [
    {
      "user_id": 2, "email": "...", "name": "...",
      "events": 2, "followups": 1,
      "input_tokens": 7744, "output_tokens": 671,
      "cache_creation_tokens": 0, "cache_read_tokens": 0,
      "web_searches": 0, "cost_usd": 0.044729,
      "by_app": { "doctrine": { "events": 2, "input_tokens": 7744, "output_tokens": 671, "cost_usd": 0.044729 } },
      "by_stage": { "4": { "events": 2, "cost_usd": 0.044729 } },
      "by_model": {
        "claude-sonnet-4-6": { "events": 1, "input_tokens": 3748, "output_tokens": 327, "cost_usd": 0.016149 },
        "claude-opus-4-7":   { "events": 1, "input_tokens": 3996, "output_tokens": 344, "cost_usd": 0.028580 }
      }
    }
  ],
  "events": [
    {
      "id": 2, "followup_id": 14479, "prospect_id": 96689,
      "user_id": 2, "user_email": "...", "user_name": "...",
      "prospect_name": "...", "prospect_company": "...",
      "app": "doctrine", "stage": 4, "label": "critic",
      "model": "claude-opus-4-7",
      "input_tokens": 3996, "output_tokens": 344,
      "cache_creation_tokens": 0, "cache_read_tokens": 0,
      "web_searches": 0, "cost_usd": 0.028580,
      "generated_at": "2026-05-12T11:29:48.193Z"
    }
  ]
}
─────────────────────────────────────────────────────────────────── */
