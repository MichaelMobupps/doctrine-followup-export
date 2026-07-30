import { Router, type Request, type Response } from "express";
import { google } from "googleapis";
import crypto from "crypto";
import { db, oauthNoncesTable } from "@workspace/db";
import { eq, lt, and, gt } from "drizzle-orm";
import { logger } from "../lib/logger";

const router = Router();

const LOGIN_SCOPES = [
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];

const NONCE_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 2 * 60 * 1000;

async function cleanExpired() {
  await db.delete(oauthNoncesTable).where(lt(oauthNoncesTable.expiresAt, new Date()));
}

function getRedirectUri(): string {
  if (process.env.APP_URL) {
    return process.env.APP_URL.replace(/\/$/, '') + '/api/auth/callback';
  }
  const domain = process.env.REPLIT_DEV_DOMAIN || process.env.REPLIT_DOMAINS?.split(",")[0] || "localhost";
  return `https://${domain}/api/auth/callback`;
}

function getOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    getRedirectUri(),
  );
}

router.get("/auth/google", async (_req: Request, res: Response) => {
  try {
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
      res.status(500).json({ error: "Google OAuth not configured" });
      return;
    }

    await cleanExpired();
    const nonce = crypto.randomBytes(32).toString("hex");
    await db.insert(oauthNoncesTable).values({
      nonce,
      flowType: "login",
      expiresAt: new Date(Date.now() + NONCE_TTL_MS),
    });

    const oauth2Client = getOAuth2Client();
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: "online",
      prompt: "select_account",
      scope: LOGIN_SCOPES,
      state: nonce,
    });

    logger.info({ redirectUri: getRedirectUri() }, "Starting dashboard login OAuth");
    res.json({ authUrl });
  } catch (err) {
    logger.error({ err }, "Failed to generate login OAuth URL");
    res.status(500).json({ error: "Failed to start login" });
  }
});

router.get("/auth/callback", async (req: Request, res: Response) => {
  const dashboardBase = process.env.APP_URL?.replace(/\/$/, '') || "";

  try {
    const { code, state, error: oauthError } = req.query;

    if (oauthError) {
      logger.warn({ oauthError }, "Login OAuth denied");
      res.redirect(dashboardBase + "/?login_error=denied");
      return;
    }

    if (!code || !state) {
      res.redirect(dashboardBase + "/?login_error=missing_params");
      return;
    }

    const [nonceData] = await db.delete(oauthNoncesTable)
      .where(and(
        eq(oauthNoncesTable.nonce, state as string),
        eq(oauthNoncesTable.flowType, "login"),
        gt(oauthNoncesTable.expiresAt, new Date()),
      ))
      .returning();
    if (!nonceData) {
      logger.warn("Invalid or expired login nonce");
      res.redirect(dashboardBase + "/?login_error=expired");
      return;
    }
    cleanExpired().catch(() => {});

    const oauth2Client = getOAuth2Client();
    const { tokens } = await oauth2Client.getToken(code as string);
    oauth2Client.setCredentials(tokens);

    const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
    const userInfo = await oauth2.userinfo.get();
    const email = userInfo.data.email || "";

    if (!email) {
      res.redirect(dashboardBase + "/?login_error=no_email");
      return;
    }

    // Domain allowlist: only accept logins from configured domains.
    // Defaults to Mobupps/WMAdv domains. Override via ALLOWED_LOGIN_DOMAINS env var
    // with a comma-separated list (e.g. "mobupps.com,mobupps.net,partner.com").
    const DEFAULT_ALLOWED_DOMAINS = ["mobupps.com", "mobupps.net", "wmadv.com", "wmadv.net"];
    const allowedDomainsRaw = process.env.ALLOWED_LOGIN_DOMAINS || "";
    const allowedDomains = allowedDomainsRaw.trim()
      ? allowedDomainsRaw.split(",").map((d) => d.trim().toLowerCase()).filter(Boolean)
      : DEFAULT_ALLOWED_DOMAINS;
    const emailDomain = email.split("@")[1]?.toLowerCase() || "";
    if (!allowedDomains.includes(emailDomain)) {
      logger.warn({ email, emailDomain, allowedDomains }, "Login denied: email domain not in allowlist");
      res.redirect(dashboardBase + "/?login_error=unauthorized_domain");
      return;
    }

    const loginCode = crypto.randomBytes(32).toString("hex");
    await db.insert(oauthNoncesTable).values({
      nonce: loginCode,
      flowType: "login_code",
      metadata: email,
      expiresAt: new Date(Date.now() + CODE_TTL_MS),
    });

    logger.info({ email }, "Dashboard login successful");
    res.redirect(dashboardBase + "/?login_code=" + loginCode);
  } catch (err) {
    logger.error({ err }, "Login OAuth callback failed");
    res.redirect(dashboardBase + "/?login_error=failed");
  }
});

router.post("/auth/exchange", async (req: Request, res: Response) => {
  try {
    const { code } = req.body;
    const apiKey = process.env.ADDON_API_KEY;

    if (!apiKey) {
      res.status(500).json({ error: "Server misconfigured" });
      return;
    }

    if (!code) {
      res.status(400).json({ error: "Missing code" });
      return;
    }

    const [codeData] = await db.delete(oauthNoncesTable)
      .where(and(
        eq(oauthNoncesTable.nonce, code),
        eq(oauthNoncesTable.flowType, "login_code"),
        gt(oauthNoncesTable.expiresAt, new Date()),
      ))
      .returning();
    if (!codeData) {
      res.status(401).json({ error: "Invalid or expired login code" });
      return;
    }
    cleanExpired().catch(() => {});

    res.json({ token: apiKey, email: codeData.metadata });
  } catch (err) {
    logger.error({ err }, "Login code exchange failed");
    res.status(500).json({ error: "Exchange failed" });
  }
});

export default router;
