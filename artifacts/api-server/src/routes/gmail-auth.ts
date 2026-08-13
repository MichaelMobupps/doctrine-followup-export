import { Router, type Request, type Response, type NextFunction } from "express";
import crypto from "crypto";
import {
  db,
  usersTable,
  oauthNoncesTable,
  DEFAULT_STAGE_TIMING,
  FOLLOWUP_MODES,
  type FollowupMode,
} from "@workspace/db";
import { eq, lt, and, gt, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { HARD_FOLLOWUP_CAP } from "../lib/followupLimits";
// Bundle 1: appPath (not redirectPath) — these callback redirects are
// same-origin RELATIVE today and stay relative, unlike the login callback
// in auth.ts which prefixes the configured public origin.
import { publicUrl, appPath } from "../lib/appUrls";
// F-3.6a: the connection-health vocabulary. Pure; see lib/connectionHealth.ts.
import { connectionState, authDeadMessage } from "../lib/connectionHealth";
import { newGoogleOAuthClient, newOAuth2InfoClient } from "../lib/googleApi";

const router = Router();

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.labels",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];

const NONCE_TTL_MS = 10 * 60 * 1000;

async function cleanExpiredNonces() {
  await db.delete(oauthNoncesTable).where(lt(oauthNoncesTable.expiresAt, new Date()));
}

function getRedirectUri(): string {
  return publicUrl("/api/gmail/callback");
}

function getOAuth2Client() {
  // F-3.7b: bounded token-refresh transporter — see lib/googleApi.ts.
  return newGoogleOAuthClient(getRedirectUri());
}

function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const key = req.headers["x-api-key"];
  const expected = process.env.ADDON_API_KEY;
  if (!expected) { res.status(500).json({ error: "ADDON_API_KEY not set" }); return; }
  if (!key || key !== expected) { res.status(401).json({ error: "Invalid API key" }); return; }
  next();
}

const ACCOUNT_SELECT = {
  id: usersTable.id,
  email: usersTable.email,
  name: usersTable.name,
  isConnected: usersTable.isConnected,
  stageTiming: usersTable.stageTiming,
  sendDays: usersTable.sendDays,
  sendHourStart: usersTable.sendHourStart,
  sendHourEnd: usersTable.sendHourEnd,
  maxFollowups: usersTable.maxFollowups,
  doctrineLabel: usersTable.doctrineLabel,
  contextLabel: usersTable.contextLabel,
  // B9b.2: surface the AntiGhosting label to the dashboard so the
  // operator can rename it via Settings rather than SQL.
  antiGhostingLabel: usersTable.antiGhostingLabel,
  followupMode: usersTable.followupMode,
  draftStageTiming: usersTable.draftStageTiming,
  hasSeenDraftModeWarning: usersTable.hasSeenDraftModeWarning,
  weeklyDigestEnabled: usersTable.weeklyDigestEnabled,
  lastWeeklyDigestAt: usersTable.lastWeeklyDigestAt,
  createdAt: usersTable.createdAt,
  // 2026-07-29 admin-pause visibility: an admin-paused account keeps
  // SYNCING (prospects appear in the inspector) but never auto-queues
  // follow-ups, so its Pipeline stays empty with zero explanation — the
  // flag was previously visible only on the admin-key-gated Admin
  // Activity page. Surfacing it here lets the dashboard warn the
  // operator on their own pages.
  pausedByAdmin: usersTable.pausedByAdmin,
  // F-3.6a: the auth-dead state. Six accounts reported CONNECTED here on
  // 2026-08-09 while Google refused every one of their grants; this is the
  // column that stops that lie, and the two derived fields below are what
  // the Accounts page actually renders.
  authDeadAt: usersTable.authDeadAt,
  authDeadReason: usersTable.authDeadReason,
} as const;

router.get("/gmail/auth", authMiddleware, async (req: Request, res: Response) => {
  try {
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
      res.status(500).json({ error: "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set" });
      return;
    }

    await cleanExpiredNonces();
    const nonce = crypto.randomBytes(32).toString("hex");
    await db.insert(oauthNoncesTable).values({
      nonce,
      flowType: "gmail",
      expiresAt: new Date(Date.now() + NONCE_TTL_MS),
    });

    const oauth2Client = getOAuth2Client();
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: SCOPES,
      state: nonce,
    });

    logger.info({ redirectUri: getRedirectUri() }, "Starting Gmail OAuth flow");
    res.json({ authUrl });
  } catch (err) {
    logger.error({ err }, "Failed to generate OAuth URL");
    res.status(500).json({ error: "Failed to start OAuth flow" });
  }
});

router.get("/gmail/callback", async (req: Request, res: Response) => {
  try {
    const { code, state, error: oauthError } = req.query;

    if (oauthError) {
      logger.warn({ oauthError }, "OAuth flow denied by user");
      res.redirect(appPath("/?oauth_error=denied"));
      return;
    }

    if (!code || !state) {
      res.redirect(appPath("/?oauth_error=missing_params"));
      return;
    }

    const [nonceData] = await db.delete(oauthNoncesTable)
      .where(and(
        eq(oauthNoncesTable.nonce, state as string),
        eq(oauthNoncesTable.flowType, "gmail"),
        gt(oauthNoncesTable.expiresAt, new Date()),
      ))
      .returning();
    if (!nonceData) {
      logger.warn("Invalid or expired OAuth nonce");
      res.redirect(appPath("/?oauth_error=invalid_state"));
      return;
    }
    cleanExpiredNonces().catch(() => {});

    const oauth2Client = getOAuth2Client();
    const { tokens } = await oauth2Client.getToken(code as string);

    if (!tokens.refresh_token) {
      logger.error("No refresh token received from Google");
      res.redirect(appPath("/accounts?oauth_error=no_refresh_token"));
      return;
    }

    oauth2Client.setCredentials(tokens);

    // F-3.7b: bounded like every other Google call — see lib/googleApi.ts.
    const oauth2 = newOAuth2InfoClient(oauth2Client);
    const userInfo = await oauth2.userinfo.get();
    // Normalize email at write time. Google occasionally returns
    // mixed-case emails depending on the tenant, and downstream lookups
    // (in particular the per-user /api/sync path) compare case-insensitively
    // — but storing lowercase is cleaner and avoids cross-row inconsistency
    // if the same address is reconnected later under a different case.
    const email = (userInfo.data.email || "").trim().toLowerCase();
    const name = userInfo.data.name || email.split("@")[0];

    if (!email) {
      res.redirect(appPath("/accounts?oauth_error=no_email"));
      return;
    }

    const existing = await db.select().from(usersTable).where(sql`LOWER(${usersTable.email}) = ${email}`).limit(1);

    if (existing.length > 0) {
      await db.update(usersTable)
        .set({
          googleRefreshToken: tokens.refresh_token,
          isConnected: true,
          name: name || existing[0].name,
          // F-3.6a: a successful reconnect clears the auth-dead state
          // immediately. Waiting for the next sync tick to notice would
          // leave the operator staring at "dead since …" for up to 15
          // minutes after doing exactly what the message asked them to do.
          authDeadAt: null,
          authDeadReason: null,
          updatedAt: new Date(),
        })
        .where(sql`LOWER(${usersTable.email}) = ${email}`);
      logger.info(
        { email, clearedAuthDead: Boolean(existing[0].authDeadAt) },
        "Reconnected Gmail account via OAuth",
      );
    } else {
      await db.insert(usersTable).values({
        email,
        name,
        googleRefreshToken: tokens.refresh_token,
        isConnected: true,
        stageTiming: DEFAULT_STAGE_TIMING,
      });
      logger.info({ email }, "Connected new Gmail account via OAuth");
    }

    res.redirect(appPath("/accounts?oauth_success=true&email=" + encodeURIComponent(email)));
  } catch (err) {
    logger.error({ err }, "OAuth callback failed");
    res.redirect(appPath("/accounts?oauth_error=callback_failed"));
  }
});

router.get("/gmail/accounts", authMiddleware, async (_req: Request, res: Response) => {
  try {
    const users = await db.select(ACCOUNT_SELECT).from(usersTable).orderBy(usersTable.createdAt);
    // F-3.6a: derive the state and the sentence server-side so the dashboard,
    // the add-on and any future client all say the same thing. `isConnected`
    // is left exactly as it was for backward compatibility — an old add-on
    // build keeps working — and the new truth rides alongside it.
    const accounts = users.map((u) => ({
      ...u,
      connectionState: connectionState(u),
      authDeadMessage: authDeadMessage(u.authDeadAt),
    }));
    res.json({ accounts });
  } catch (err) {
    logger.error({ err }, "Failed to list accounts");
    res.status(500).json({ error: "Failed to list accounts" });
  }
});

router.delete("/gmail/accounts/:id", authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = parseInt((req.params.id as string));
    if (isNaN(userId)) { res.status(400).json({ error: "Invalid user ID" }); return; }

    const user = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    if (user.length === 0) { res.status(404).json({ error: "Account not found" }); return; }

    await db.update(usersTable)
      .set({
        googleRefreshToken: null,
        isConnected: false,
        // F-3.6a: an explicit disconnect clears auth-dead too. There is no
        // grant left to be dead, and connectionState() gives disconnect
        // precedence anyway — leaving the columns set would only put stale
        // "dead since …" data behind a state that no longer reads it.
        authDeadAt: null,
        authDeadReason: null,
        updatedAt: new Date(),
      })
      .where(eq(usersTable.id, userId));

    logger.info({ userId, email: user[0].email }, "Disconnected Gmail account");
    res.json({ success: true, email: user[0].email });
  } catch (err) {
    logger.error({ err }, "Failed to disconnect account");
    res.status(500).json({ error: "Failed to disconnect" });
  }
});

router.put("/gmail/accounts/:id/settings", authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = parseInt((req.params.id as string));
    if (isNaN(userId)) { res.status(400).json({ error: "Invalid user ID" }); return; }

    // Phase 3c: legacy `requireApproval` is removed. Reject any caller still
    // sending it so unmigrated clients fail loudly instead of silently doing
    // nothing. UI now sends `followupMode` directly (one of FOLLOWUP_MODES).
    if (Object.prototype.hasOwnProperty.call(req.body, "requireApproval")) {
      res.status(400).json({
        error: "Field `requireApproval` is no longer accepted. Send `followupMode` (auto_send | review_in_app | draft_in_gmail) instead.",
      });
      return;
    }

    const {
      stageTiming,
      sendDays,
      sendHourStart,
      sendHourEnd,
      maxFollowups,
      doctrineLabel,
      contextLabel,
      antiGhostingLabel,
      followupMode,
      draftStageTiming,
      hasSeenDraftModeWarning,
      weeklyDigestEnabled,
    } = req.body;

    const updates: Record<string, any> = { updatedAt: new Date() };

    if (stageTiming !== undefined && Array.isArray(stageTiming)) {
      updates.stageTiming = stageTiming.map((s: any) => ({
        minDays: parseInt(s.minDays) || 1,
        maxDays: parseInt(s.maxDays) || 7,
      }));
    }
    if (draftStageTiming !== undefined && Array.isArray(draftStageTiming)) {
      updates.draftStageTiming = draftStageTiming.map((s: any) => ({
        minDays: parseInt(s.minDays) || 1,
        maxDays: parseInt(s.maxDays) || 7,
      }));
    }
    if (sendDays !== undefined && Array.isArray(sendDays)) {
      // Phase 6: require at least one valid day. An empty array silently
      // disabled the day filter via the early-return in findNextAllowedDay,
      // which surprised users who expected a tighter window.
      const validDays = sendDays.filter((d: any) => typeof d === "number" && d >= 0 && d <= 6);
      if (validDays.length === 0) {
        res.status(400).json({ error: "sendDays must contain at least one valid day (0=Sunday..6=Saturday)" });
        return;
      }
      updates.sendDays = validDays;
    }
    if (sendHourStart !== undefined) updates.sendHourStart = parseInt(sendHourStart);
    if (sendHourEnd !== undefined) updates.sendHourEnd = parseInt(sendHourEnd);
    // Phase 6: send-hour bounds must form a non-empty interval. The schedule
    // math uses Math.random() * (end - start), which produces NaN/negative
    // hours when end <= start. Resolve effective values from the incoming
    // payload OR the current row defaults to validate the COMBINED state.
    {
      const effStart = updates.sendHourStart !== undefined
        ? updates.sendHourStart
        : (await db.select({ v: usersTable.sendHourStart }).from(usersTable).where(eq(usersTable.id, userId)).limit(1))[0]?.v ?? 8;
      const effEnd = updates.sendHourEnd !== undefined
        ? updates.sendHourEnd
        : (await db.select({ v: usersTable.sendHourEnd }).from(usersTable).where(eq(usersTable.id, userId)).limit(1))[0]?.v ?? 18;
      if (!Number.isFinite(effStart) || !Number.isFinite(effEnd) || effStart < 0 || effStart > 23 || effEnd < 1 || effEnd > 24 || effEnd <= effStart) {
        res.status(400).json({
          error: `sendHourStart and sendHourEnd must satisfy 0 <= start < end <= 24 (got start=${effStart}, end=${effEnd})`,
        });
        return;
      }
    }
    if (maxFollowups !== undefined) {
      // CB-2: clamp into 1..HARD_FOLLOWUP_CAP. The legacy "0 = unlimited"
      // convention is removed; a missing or non-positive value resolves to
      // the hard cap rather than to unlimited.
      const parsed = parseInt(maxFollowups);
      updates.maxFollowups =
        !isNaN(parsed) && parsed > 0 ? Math.min(parsed, HARD_FOLLOWUP_CAP) : HARD_FOLLOWUP_CAP;
    }
    if (doctrineLabel !== undefined) updates.doctrineLabel = String(doctrineLabel);
    if (contextLabel !== undefined) updates.contextLabel = String(contextLabel);
    if (antiGhostingLabel !== undefined) updates.antiGhostingLabel = String(antiGhostingLabel);
    if (followupMode !== undefined) {
      if (!FOLLOWUP_MODES.includes(followupMode as FollowupMode)) {
        res.status(400).json({
          error: `Invalid followupMode. Must be one of: ${FOLLOWUP_MODES.join(", ")}`,
        });
        return;
      }
      updates.followupMode = followupMode;
    }
    if (hasSeenDraftModeWarning !== undefined) {
      // Boolean coercion: only set TRUE if explicitly truthy. Once TRUE we
      // never want to flip back to FALSE via this endpoint, so ignore false
      // payloads. (Schema-level constraint is NOT NULL DEFAULT FALSE; the
      // operator can manually reset via SQL if ever needed.)
      if (hasSeenDraftModeWarning === true) {
        updates.hasSeenDraftModeWarning = true;
      }
    }
    if (weeklyDigestEnabled !== undefined) {
      // Phase 4: weekly digest opt-in is a true two-way toggle. Users can
      // turn it off (and back on) freely from the Settings UI.
      updates.weeklyDigestEnabled = weeklyDigestEnabled === true;
    }

    await db.update(usersTable).set(updates).where(eq(usersTable.id, userId));

    const updated = await db.select(ACCOUNT_SELECT).from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    res.json({ success: true, account: updated[0] || null });
  } catch (err) {
    logger.error({ err }, "Failed to update settings");
    res.status(500).json({ error: "Failed to update settings" });
  }
});

export default router;