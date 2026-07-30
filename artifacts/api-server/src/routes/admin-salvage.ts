// B7o: admin salvage endpoint for stuck prospects.
//
// What a "stuck prospect" is in practice:
//   - replied=0, followupPaused=false, app=doctrine
//   - either has zero active follow-up rows (autoqueue never ran for it), OR
//   - has an orphan active row that the cron will never advance:
//       * status='generating' older than 30 min (processDueFollowups
//         crashed mid-claim, no watchdog reclaims these)
//       * status='drafted' but user.followupMode is not draft_in_gmail
//         (mode was switched after the row was created; nothing will
//         ever flip this row off active)
//
// Default behavior is dry-run: read-only summary and stuck examples.
// Pass {"apply": true} to actually repair.
//
// Auth: requireAdmin — x-admin-key header must match ADMIN_API_KEY (a
// distinct secret issued only to allowlisted admins at the OAuth exchange).

import { Router, type Request, type Response } from "express";
import { db, prospectsTable, followupsTable, usersTable } from "@workspace/db";
import { eq, and, inArray } from "drizzle-orm";
import { logger } from "../lib/logger";
import { computeNextStageScheduledAt } from "../services/timingEngine";
import { queueStageForProspect } from "../services/scheduler";
// B7q: digest preview + send-test endpoints. The cron only runs Tuesday
// 00:00 UTC, so without these we cannot test or preview the digest at all.
import { gatherDigestData, formatDigestHtml, sendWeeklyDigestForUser } from "../services/weeklyDigest";

import { requireAdmin } from "../middlewares/requireAdmin";

const router = Router();

router.use(requireAdmin);

const ACTIVE_STATUSES = ["queued", "generating", "pending_approval", "drafted"];
const GENERATING_ORPHAN_MIN_AGE_MS = 30 * 60 * 1000;

type StuckReason =
  | "no_active_row"
  | "generating_orphan"
  | "drafted_in_autosend_mode"
  | "drafted_in_review_mode";

router.post("/admin/salvage", async (req: Request, res: Response) => {
  try {
    const email = String(req.body?.email || "").trim();
    const apply = req.body?.apply === true;
    const app = (req.body?.app === "context" ? "context" : "doctrine") as
      | "doctrine"
      | "context";

    if (!email) {
      res.status(400).json({ error: "email is required in the JSON body" });
      return;
    }

    const user = (
      await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1)
    )[0];
    if (!user) {
      res.status(404).json({ error: `User not found: ${email}` });
      return;
    }

    const eligibleProspects = await db
      .select()
      .from(prospectsTable)
      .where(
        and(
          eq(prospectsTable.userId, user.id),
          eq(prospectsTable.app, app),
          eq(prospectsTable.replied, 0),
          eq(prospectsTable.followupPaused, false),
        ),
      );

    const cap =
      typeof user.maxFollowups === "number" && user.maxFollowups > 0
        ? user.maxFollowups
        : null;

    const userMeta = {
      id: user.id,
      email: user.email,
      isConnected: user.isConnected,
      followupMode: user.followupMode,
      maxFollowups: user.maxFollowups,
      maxFollowupsLabel: cap === null ? "unlimited" : String(cap),
    };

    if (eligibleProspects.length === 0) {
      res.json({
        summary: `No active prospects for ${email} (app=${app})`,
        user: userMeta,
        scoped_app: app,
        totals: { prospects_active: 0, prospects_stuck: 0 },
        stuck_breakdown: {},
        stuck_examples: [],
        apply,
      });
      return;
    }

    const prospectIds = eligibleProspects.map((p) => p.id);
    const allFollowups = await db
      .select()
      .from(followupsTable)
      .where(inArray(followupsTable.prospectId, prospectIds));

    const followupsByProspect = new Map<number, typeof allFollowups>();
    for (const f of allFollowups) {
      const arr = followupsByProspect.get(f.prospectId);
      if (arr) arr.push(f);
      else followupsByProspect.set(f.prospectId, [f]);
    }

    const now = Date.now();
    type StuckEntry = {
      prospect: (typeof eligibleProspects)[number];
      maxSentStage: number;
      nextStage: number;
      reason: StuckReason;
      orphanRow: (typeof allFollowups)[number] | null;
    };

    const stuck: StuckEntry[] = [];
    let prospects_completed_capped = 0;

    for (const p of eligibleProspects) {
      const rows = followupsByProspect.get(p.id) || [];
      const sentRows = rows.filter((r) => r.status === "sent");
      const maxSentStage =
        sentRows.length > 0 ? Math.max(...sentRows.map((r) => r.stage)) : 0;
      const activeRows = rows.filter((r) => ACTIVE_STATUSES.includes(r.status));

      if (cap !== null && maxSentStage >= cap) {
        prospects_completed_capped++;
        continue;
      }

      if (activeRows.length === 0) {
        stuck.push({
          prospect: p,
          maxSentStage,
          nextStage: maxSentStage + 1,
          reason: "no_active_row",
          orphanRow: null,
        });
        continue;
      }

      const generatingOrphan = activeRows.find(
        (r) =>
          r.status === "generating" &&
          now - new Date(r.createdAt).getTime() > GENERATING_ORPHAN_MIN_AGE_MS,
      );
      if (generatingOrphan) {
        stuck.push({
          prospect: p,
          maxSentStage,
          nextStage: generatingOrphan.stage,
          reason: "generating_orphan",
          orphanRow: generatingOrphan,
        });
        continue;
      }

      const draftedRow = activeRows.find((r) => r.status === "drafted");
      if (draftedRow && user.followupMode !== "draft_in_gmail") {
        stuck.push({
          prospect: p,
          maxSentStage,
          nextStage: maxSentStage + 1,
          reason:
            user.followupMode === "review_in_app"
              ? "drafted_in_review_mode"
              : "drafted_in_autosend_mode",
          orphanRow: draftedRow,
        });
        continue;
      }

      // Has legit active row in current mode → not stuck.
    }

    const breakdown: Record<StuckReason, number> = {
      no_active_row: 0,
      generating_orphan: 0,
      drafted_in_autosend_mode: 0,
      drafted_in_review_mode: 0,
    };
    for (const s of stuck) breakdown[s.reason]++;

    const examples = stuck.slice(0, 15).map((s) => ({
      prospect_id: s.prospect.id,
      prospect_name: s.prospect.prospectName,
      company: s.prospect.company,
      email: s.prospect.email,
      max_sent_stage: s.maxSentStage,
      next_stage_to_queue: s.nextStage,
      reason: s.reason,
      orphan_row_id: s.orphanRow?.id || null,
      orphan_row_status: s.orphanRow?.status || null,
      orphan_age_minutes: s.orphanRow
        ? Math.floor((now - new Date(s.orphanRow.createdAt).getTime()) / 60000)
        : null,
    }));

    const summary = `${eligibleProspects.length} active prospects | ${stuck.length} stuck | ${prospects_completed_capped} completed at cap | apply=${apply}`;

    const result: Record<string, unknown> = {
      summary,
      user: userMeta,
      scoped_app: app,
      totals: {
        prospects_active: eligibleProspects.length,
        prospects_stuck: stuck.length,
        prospects_completed_at_cap: prospects_completed_capped,
      },
      stuck_breakdown: breakdown,
      stuck_examples: examples,
      apply,
    };

    if (!apply) {
      res.json(result);
      return;
    }

    // ---------- APPLY PHASE ----------
    if (!user.isConnected) {
      res.status(409).json({
        ...result,
        error:
          "User is not connected (isConnected=false). Reconnect Gmail before applying salvage.",
      });
      return;
    }

    const userSettings = {
      stageTiming: user.stageTiming,
      draftStageTiming: user.draftStageTiming,
      sendDays: user.sendDays,
      sendHourStart: user.sendHourStart,
      sendHourEnd: user.sendHourEnd,
    };
    const mode =
      user.followupMode === "draft_in_gmail" ? "draft_in_gmail" : "auto_send";

    let generating_reverted = 0;
    let drafted_cancelled = 0;
    let queued_new = 0;
    let skipped_cap = 0;
    let errors = 0;

    for (const s of stuck) {
      try {
        if (s.reason === "generating_orphan" && s.orphanRow) {
          await db
            .update(followupsTable)
            .set({
              status: "queued",
              scheduledAt: new Date(now + 60 * 60 * 1000),
              errorMessage: "B7o salvage: reverted from generating orphan",
            })
            .where(eq(followupsTable.id, s.orphanRow.id));
          generating_reverted++;
          continue;
        }

        if (
          (s.reason === "drafted_in_autosend_mode" ||
            s.reason === "drafted_in_review_mode") &&
          s.orphanRow
        ) {
          await db
            .update(followupsTable)
            .set({
              status: "cancelled",
              errorMessage:
                "B7o salvage: drafted row found in non-draft mode; cancelled before requeue",
            })
            .where(eq(followupsTable.id, s.orphanRow.id));
          drafted_cancelled++;
          // fall through and queue the next stage
        }

        if (cap !== null && s.nextStage > cap) {
          skipped_cap++;
          continue;
        }

        const lastSentRow = (followupsByProspect.get(s.prospect.id) || [])
          .filter((r) => r.status === "sent")
          .sort((a, b) => b.stage - a.stage)[0];

        const scheduledAt = computeNextStageScheduledAt({
          stage: s.nextStage,
          initialSentAt: s.prospect.sentAt,
          lastFollowupSentAt: lastSentRow?.sentAt ?? null,
          userSettings,
          mode,
        });

        const { queued } = await queueStageForProspect(
          s.prospect.id,
          s.nextStage,
          scheduledAt,
        );
        if (queued) queued_new++;
      } catch (err) {
        errors++;
        logger.error(
          { err, prospectId: s.prospect.id, reason: s.reason },
          "B7o salvage: failed to repair prospect",
        );
      }
    }

    result.fixed = {
      generating_orphans_reverted: generating_reverted,
      drafted_mismatch_cancelled: drafted_cancelled,
      queued_new_stages: queued_new,
      skipped_cap_reached: skipped_cap,
      errors,
    };
    result.summary = `Repaired: ${generating_reverted} generating + ${drafted_cancelled} drafted-mismatch + ${queued_new} new stages queued | skipped ${skipped_cap} at cap | ${errors} errors`;

    logger.info({ email, fixed: result.fixed }, "B7o salvage applied");
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err }, "B7o salvage endpoint error");
    res.status(500).json({ error: msg });
  }
});

// B7q: POST /admin/digest/preview — render the digest HTML for a user
// without sending. Returns text/html so the caller can pipe it to a file
// and open it in a browser:
//   curl ... > preview.html && xdg-open preview.html
router.post("/admin/digest/preview", async (req: Request, res: Response) => {
  try {
    const email = String(req.body?.email || "").trim();
    if (!email) { res.status(400).json({ error: "email is required" }); return; }
    const user = (await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1))[0];
    if (!user) { res.status(404).json({ error: `User not found: ${email}` }); return; }
    const data = await gatherDigestData({ userId: user.id, followupMode: user.followupMode });
    const html = formatDigestHtml(data, user.name || user.email);
    res.set("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err }, "B7q digest preview error");
    res.status(500).json({ error: msg });
  }
});

// B7q: POST /admin/digest/send-test — send the digest to a user right
// now, bypassing the Tuesday cron + dedupe window. Body: { email }.
// Useful for verifying the digest end-to-end without waiting a week.
router.post("/admin/digest/send-test", async (req: Request, res: Response) => {
  try {
    const email = String(req.body?.email || "").trim();
    if (!email) { res.status(400).json({ error: "email is required" }); return; }
    const user = (await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1))[0];
    if (!user) { res.status(404).json({ error: `User not found: ${email}` }); return; }
    if (!user.isConnected || !user.googleRefreshToken) {
      res.status(409).json({ error: "User is not connected (Gmail OAuth missing). Reconnect first." });
      return;
    }
    const result = await sendWeeklyDigestForUser({
      id: user.id,
      email: user.email,
      name: user.name,
      googleRefreshToken: user.googleRefreshToken,
      followupMode: user.followupMode,
    });
    res.json({ email: user.email, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err }, "B7q digest send-test error");
    res.status(500).json({ error: msg });
  }
});

export default router;
