import { Router, type Request, type Response, type NextFunction } from "express";
import { google } from "googleapis";
import crypto from "crypto";
import { db, usersTable, oauthNoncesTable, DEFAULT_STAGE_TIMING } from "@workspace/db";
import { eq, lt, and, gt } from "drizzle-orm";
import { logger } from "../lib/logger";

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
  if (process.env.APP_URL) {
    return process.env.APP_URL.replace(/\/$/, '') + '/api/gmail/callback';
  }
  const domain = process.env.REPLIT_DEV_DOMAIN || process.env.REPLIT_DOMAINS?.split(",")[0] || "localhost";
  return `https://${domain}/api/gmail/callback`;
}

function getOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    getRedirectUri(),
  );
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
  testMode: usersTable.testMode,
  requireApproval: usersTable.requireApproval,
  createdAt: usersTable.createdAt,
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
      res.redirect("/?oauth_error=denied");
      return;
    }

    if (!code || !state) {
      res.redirect("/?oauth_error=missing_params");
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
      res.redirect("/?oauth_error=invalid_state");
      return;
    }
    cleanExpiredNonces().catch(() => {});

    const oauth2Client = getOAuth2Client();
    const { tokens } = await oauth2Client.getToken(code as string);

    if (!tokens.refresh_token) {
      logger.error("No refresh token received from Google");
      res.redirect("/accounts?oauth_error=no_refresh_token");
      return;
    }

    oauth2Client.setCredentials(tokens);

    const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
    const userInfo = await oauth2.userinfo.get();
    const email = userInfo.data.email || "";
    const name = userInfo.data.name || email.split("@")[0];

    if (!email) {
      res.redirect("/accounts?oauth_error=no_email");
      return;
    }

    const existing = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);

    if (existing.length > 0) {
      await db.update(usersTable)
        .set({
          googleRefreshToken: tokens.refresh_token,
          isConnected: true,
          name: name || existing[0].name,
          updatedAt: new Date(),
        })
        .where(eq(usersTable.email, email));
      logger.info({ email }, "Reconnected Gmail account via OAuth");
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

    res.redirect("/accounts?oauth_success=true&email=" + encodeURIComponent(email));
  } catch (err) {
    logger.error({ err }, "OAuth callback failed");
    res.redirect("/accounts?oauth_error=callback_failed");
  }
});

router.get("/gmail/accounts", authMiddleware, async (_req: Request, res: Response) => {
  try {
    const users = await db.select(ACCOUNT_SELECT).from(usersTable).orderBy(usersTable.createdAt);
    res.json({ accounts: users });
  } catch (err) {
    logger.error({ err }, "Failed to list accounts");
    res.status(500).json({ error: "Failed to list accounts" });
  }
});

router.delete("/gmail/accounts/:id", authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = parseInt(req.params.id);
    if (isNaN(userId)) { res.status(400).json({ error: "Invalid user ID" }); return; }

    const user = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    if (user.length === 0) { res.status(404).json({ error: "Account not found" }); return; }

    await db.update(usersTable)
      .set({
        googleRefreshToken: null,
        isConnected: false,
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
    const userId = parseInt(req.params.id);
    if (isNaN(userId)) { res.status(400).json({ error: "Invalid user ID" }); return; }

    const {
      stageTiming, sendDays,
      sendHourStart, sendHourEnd,
      maxFollowups, doctrineLabel,
      testMode, requireApproval,
    } = req.body;

    const updates: Record<string, any> = { updatedAt: new Date() };
    if (stageTiming !== undefined && Array.isArray(stageTiming)) {
      updates.stageTiming = stageTiming.map((s: any) => ({
        minDays: parseInt(s.minDays) || 1,
        maxDays: parseInt(s.maxDays) || 7,
      }));
    }
    if (sendDays !== undefined && Array.isArray(sendDays)) {
      updates.sendDays = sendDays.filter((d: any) => typeof d === "number" && d >= 0 && d <= 6);
    }
    if (sendHourStart !== undefined) updates.sendHourStart = parseInt(sendHourStart);
    if (sendHourEnd !== undefined) updates.sendHourEnd = parseInt(sendHourEnd);
    if (maxFollowups !== undefined) {
      const parsed = parseInt(maxFollowups);
      updates.maxFollowups = !isNaN(parsed) && parsed > 0 ? parsed : 0;
    }
    if (doctrineLabel !== undefined) updates.doctrineLabel = String(doctrineLabel);
    if (testMode !== undefined) updates.testMode = Boolean(testMode);
    if (requireApproval !== undefined) updates.requireApproval = Boolean(requireApproval);

    await db.update(usersTable).set(updates).where(eq(usersTable.id, userId));

    const updated = await db.select(ACCOUNT_SELECT).from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    res.json({ success: true, account: updated[0] || null });
  } catch (err) {
    logger.error({ err }, "Failed to update settings");
    res.status(500).json({ error: "Failed to update settings" });
  }
});

export default router;
