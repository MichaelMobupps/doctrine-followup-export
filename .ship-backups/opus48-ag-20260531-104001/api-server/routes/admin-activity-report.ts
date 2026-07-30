// B7u: admin activity report Excel export.
//
// GET /api/admin/activity-report
//   Auth: X-API-Key
//   Query params: user_id, app, since, until (same as /admin/activity)
//
// Returns a .xlsx file with sheets:
//   - Summary           top-level totals + window + pricing reference link
//   - Per User          one row per user with totals + per-app subtotals
//   - Per Model         global model totals (tokens, calls, cost)
//   - Per Stage         global stage totals (calls, cost)
//   - Events            up to 5000 most recent events with full detail
//   - Pricing Reference snapshot of MODEL_PRICES so the report is self-documenting
//
// Uses SheetJS (xlsx). Added as a dependency in api-server/package.json.

import { Router, type Request, type Response, type NextFunction } from "express";
import { db, followupUsageTable, usersTable, prospectsTable } from "@workspace/db";
import { and, eq, gte, lte, desc, sql } from "drizzle-orm";
import * as XLSX from "xlsx";
import { logger } from "../lib/logger";
import { MODEL_PRICES } from "../lib/pricing";

const router = Router();

function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const key = req.headers["x-api-key"];
  const expected = process.env.ADDON_API_KEY;
  if (!expected) { res.status(500).json({ error: "ADDON_API_KEY not set" }); return; }
  if (!key || key !== expected) { res.status(401).json({ error: "Invalid API key" }); return; }
  next();
}

router.use(authMiddleware);

const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_EVENTS_IN_REPORT = 5000;

function parseWindow(req: Request): { since: Date; until: Date } {
  const now = Date.now();
  const sinceRaw = req.query.since ? String(req.query.since) : null;
  const untilRaw = req.query.until ? String(req.query.until) : null;
  const since = sinceRaw ? new Date(sinceRaw) : new Date(now - DEFAULT_WINDOW_MS);
  const until = untilRaw ? new Date(untilRaw) : new Date(now);
  if (isNaN(since.getTime())) return { since: new Date(now - DEFAULT_WINDOW_MS), until: new Date(now) };
  if (isNaN(until.getTime())) return { since, until: new Date(now) };
  return { since, until };
}

router.get("/admin/activity-report", async (req: Request, res: Response) => {
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

    // Pull totals, per-user, per-model, per-stage, events.
    const totalsRow = (await db
      .select({
        events: sql<number>`count(*)::int`,
        followups: sql<number>`count(distinct ${followupUsageTable.followupId})::int`,
        input_tokens: sql<number>`coalesce(sum(${followupUsageTable.inputTokens}), 0)::int`,
        output_tokens: sql<number>`coalesce(sum(${followupUsageTable.outputTokens}), 0)::int`,
        cache_creation: sql<number>`coalesce(sum(${followupUsageTable.cacheCreationTokens}), 0)::int`,
        cache_read: sql<number>`coalesce(sum(${followupUsageTable.cacheReadTokens}), 0)::int`,
        web_searches: sql<number>`coalesce(sum(${followupUsageTable.webSearches}), 0)::int`,
        cost_usd: sql<number>`coalesce(sum(${followupUsageTable.costUsd}), 0)::float8`,
      })
      .from(followupUsageTable)
      .where(where))[0] ?? { events: 0, followups: 0, input_tokens: 0, output_tokens: 0, cache_creation: 0, cache_read: 0, web_searches: 0, cost_usd: 0 };

    const perUser = await db
      .select({
        user_id: followupUsageTable.userId,
        email: usersTable.email,
        name: usersTable.name,
        events: sql<number>`count(*)::int`,
        followups: sql<number>`count(distinct ${followupUsageTable.followupId})::int`,
        input_tokens: sql<number>`coalesce(sum(${followupUsageTable.inputTokens}), 0)::int`,
        output_tokens: sql<number>`coalesce(sum(${followupUsageTable.outputTokens}), 0)::int`,
        cache_read: sql<number>`coalesce(sum(${followupUsageTable.cacheReadTokens}), 0)::int`,
        cost_usd: sql<number>`coalesce(sum(${followupUsageTable.costUsd}), 0)::float8`,
      })
      .from(followupUsageTable)
      .leftJoin(usersTable, eq(followupUsageTable.userId, usersTable.id))
      .where(where)
      .groupBy(followupUsageTable.userId, usersTable.email, usersTable.name)
      .orderBy(sql`coalesce(sum(${followupUsageTable.costUsd}), 0) desc`);

    const perModel = await db
      .select({
        model: followupUsageTable.model,
        events: sql<number>`count(*)::int`,
        input_tokens: sql<number>`coalesce(sum(${followupUsageTable.inputTokens}), 0)::int`,
        output_tokens: sql<number>`coalesce(sum(${followupUsageTable.outputTokens}), 0)::int`,
        cost_usd: sql<number>`coalesce(sum(${followupUsageTable.costUsd}), 0)::float8`,
      })
      .from(followupUsageTable)
      .where(where)
      .groupBy(followupUsageTable.model)
      .orderBy(sql`coalesce(sum(${followupUsageTable.costUsd}), 0) desc`);

    const perStage = await db
      .select({
        stage: followupUsageTable.stage,
        events: sql<number>`count(*)::int`,
        cost_usd: sql<number>`coalesce(sum(${followupUsageTable.costUsd}), 0)::float8`,
      })
      .from(followupUsageTable)
      .where(where)
      .groupBy(followupUsageTable.stage)
      .orderBy(followupUsageTable.stage);

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
      .limit(MAX_EVENTS_IN_REPORT);

    const wb = XLSX.utils.book_new();

    // ── Sheet 1: Summary ──────────────────────────────────────────
    const summaryRows = [
      ["Email Followuper — Activity Report"],
      [],
      ["Generated at (UTC)", new Date().toISOString()],
      ["Window — since (UTC)", since.toISOString()],
      ["Window — until (UTC)", until.toISOString()],
      ["Filter — user_id", userFilter === null ? "all" : String(userFilter)],
      ["Filter — app", appFilter ?? "all"],
      [],
      ["TOTALS"],
      ["Events (LLM calls)", totalsRow.events],
      ["Follow-ups (distinct)", totalsRow.followups],
      ["Input tokens", totalsRow.input_tokens],
      ["Output tokens", totalsRow.output_tokens],
      ["Cache creation tokens", totalsRow.cache_creation],
      ["Cache read tokens", totalsRow.cache_read],
      ["Web search uses", totalsRow.web_searches],
      ["Total cost (USD)", Number(totalsRow.cost_usd)],
      [],
      ["This report is sourced from the followup_usage table populated by B7r."],
      ["Costs are estimated from the Pricing Reference sheet."],
      ["Events sheet capped at " + MAX_EVENTS_IN_REPORT + " most recent rows; aggregates above use the full window."],
    ];
    const ws1 = XLSX.utils.aoa_to_sheet(summaryRows);
    ws1["!cols"] = [{ wch: 32 }, { wch: 40 }];
    XLSX.utils.book_append_sheet(wb, ws1, "Summary");

    // ── Sheet 2: Per User ──────────────────────────────────────────
    const perUserData = perUser.map((u) => ({
      User: u.name || u.email || (u.user_id ? `User #${u.user_id}` : "(no user)"),
      Email: u.email ?? "",
      "User ID": u.user_id ?? "",
      Events: u.events,
      "Follow-ups": u.followups,
      "Input tokens": u.input_tokens,
      "Output tokens": u.output_tokens,
      "Cache read tokens": u.cache_read,
      "Cost (USD)": Number(u.cost_usd),
    }));
    const ws2 = XLSX.utils.json_to_sheet(perUserData);
    ws2["!cols"] = [{ wch: 22 }, { wch: 28 }, { wch: 8 }, { wch: 8 }, { wch: 10 }, { wch: 14 }, { wch: 14 }, { wch: 16 }, { wch: 12 }];
    XLSX.utils.book_append_sheet(wb, ws2, "Per User");

    // ── Sheet 3: Per Model ────────────────────────────────────────
    const perModelData = perModel.map((m) => ({
      Model: m.model,
      Calls: m.events,
      "Input tokens": m.input_tokens,
      "Output tokens": m.output_tokens,
      "Cost (USD)": Number(m.cost_usd),
    }));
    const ws3 = XLSX.utils.json_to_sheet(perModelData);
    ws3["!cols"] = [{ wch: 28 }, { wch: 8 }, { wch: 14 }, { wch: 14 }, { wch: 12 }];
    XLSX.utils.book_append_sheet(wb, ws3, "Per Model");

    // ── Sheet 4: Per Stage ────────────────────────────────────────
    const perStageData = perStage.map((s) => ({
      Stage: s.stage,
      Calls: s.events,
      "Cost (USD)": Number(s.cost_usd),
    }));
    const ws4 = XLSX.utils.json_to_sheet(perStageData);
    ws4["!cols"] = [{ wch: 8 }, { wch: 8 }, { wch: 12 }];
    XLSX.utils.book_append_sheet(wb, ws4, "Per Stage");

    // ── Sheet 5: Events ───────────────────────────────────────────
    const eventsData = events.map((e) => ({
      "Generated at (UTC)": e.generated_at instanceof Date ? e.generated_at.toISOString() : String(e.generated_at),
      "Event ID": e.id,
      "Follow-up ID": e.followup_id ?? "",
      "Prospect ID": e.prospect_id ?? "",
      "Prospect": e.prospect_name || (e.prospect_id ? `Prospect #${e.prospect_id}` : ""),
      "Company": e.prospect_company ?? "",
      "User ID": e.user_id ?? "",
      "User": e.user_name || e.user_email || "",
      App: e.app,
      Stage: e.stage,
      Step: e.label,
      Model: e.model,
      "Input tokens": e.input_tokens,
      "Output tokens": e.output_tokens,
      "Cache W": e.cache_creation_tokens,
      "Cache R": e.cache_read_tokens,
      "Web": e.web_searches,
      "Cost (USD)": Number(e.cost_usd),
    }));
    const ws5 = XLSX.utils.json_to_sheet(eventsData);
    ws5["!cols"] = [
      { wch: 22 }, { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 24 },
      { wch: 20 }, { wch: 8 }, { wch: 20 }, { wch: 10 }, { wch: 6 },
      { wch: 18 }, { wch: 24 }, { wch: 14 }, { wch: 14 }, { wch: 10 },
      { wch: 10 }, { wch: 6 }, { wch: 12 },
    ];
    XLSX.utils.book_append_sheet(wb, ws5, "Events");

    // ── Sheet 6: Pricing Reference ────────────────────────────────
    // Snapshot so a reader can verify how costs were computed.
    const pricingData = Object.entries(MODEL_PRICES).map(([model, p]) => ({
      Model: model,
      "Input ($/1M tokens)": p.input,
      "Output ($/1M tokens)": p.output,
    }));
    const ws6 = XLSX.utils.json_to_sheet(pricingData);
    ws6["!cols"] = [{ wch: 32 }, { wch: 22 }, { wch: 22 }];
    XLSX.utils.book_append_sheet(wb, ws6, "Pricing Reference");

    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
    const filename = `activity-report-${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Length", buf.length.toString());
    res.send(buf);
  } catch (err) {
    logger.error({ err }, "B7u: /admin/activity-report failed");
    res.status(500).json({ error: "Failed to generate activity report" });
  }
});

export default router;
