/**
 * deployRecovery.ts — F-3.6a.
 *
 * The two NAMED deploy-time passes this order authorises, and nothing else.
 * Both run once, after listen(), fire-and-forget.
 *
 *   1. backfillAuthDeadFromProbe() — one cheap Gmail read per connected
 *      account, so the six grants F-D4 found dead on 2026-08-09 are marked
 *      on the first boot instead of waiting for each one to fail a sync.
 *
 *   2. recoverStrandedGenerating() — runs the stranded pass immediately
 *      rather than waiting up to 15 minutes for the first sync tick, so the
 *      rows frozen since 2026-07-21 and 07-28 become visible at boot.
 *
 * Neither pass sends, generates, or deletes anything. The probe is a
 * read-only `users.getProfile`; the recovery moves rows out of a frozen
 * state into a visible one and preserves every field it finds.
 */

import { db, usersTable } from "@workspace/db";
import { eq, and, isNotNull } from "drizzle-orm";
import { logger } from "./logger";
import { getGmailForUser } from "../services/gmailClient";
import { probeGmailGrant, signalFromProbe } from "./authProbe";
import { nextAuthState } from "./connectionHealth";
import { detectStrandedGeneratingFollowups } from "../services/scheduler";

export interface BackfillResult {
  probed: number;
  markedDead: number;
  cleared: number;
  inconclusive: number;
}

/**
 * Probe every connected account and reconcile its auth-dead state.
 *
 * Sequential on purpose: fifteen accounts at one cheap call each is under a
 * second of wall clock, and a burst of parallel token exchanges against one
 * OAuth client is exactly the shape that earns a rate limit.
 *
 * Uses the same state machine as the sync pass, so a probe cannot reach a
 * conclusion the cron would not: a non-auth failure is `inconclusive` and
 * changes nothing in either direction.
 */
export async function backfillAuthDeadFromProbe(): Promise<BackfillResult> {
  const result: BackfillResult = { probed: 0, markedDead: 0, cleared: 0, inconclusive: 0 };

  const accounts = await db
    .select({
      id: usersTable.id,
      email: usersTable.email,
      name: usersTable.name,
      googleRefreshToken: usersTable.googleRefreshToken,
      authDeadAt: usersTable.authDeadAt,
    })
    .from(usersTable)
    .where(and(eq(usersTable.isConnected, true), isNotNull(usersTable.googleRefreshToken)));

  if (accounts.length === 0) {
    logger.info("F-3.6a backfill: no connected accounts to probe");
    return result;
  }

  for (const account of accounts) {
    try {
      if (!account.googleRefreshToken) continue;
      const gmail = getGmailForUser({
        refreshToken: account.googleRefreshToken,
        email: account.email,
        name: account.name ?? undefined,
      });

      const probe = await probeGmailGrant(gmail);
      result.probed++;

      const signal = signalFromProbe(probe);
      if (signal === "inconclusive") result.inconclusive++;

      const now = new Date();
      const transition = nextAuthState({
        currentAuthDeadAt: account.authDeadAt,
        signal,
        reason: probe.ok ? null : probe.error,
        now,
      });
      if (!transition.changed) continue;

      await db
        .update(usersTable)
        .set({
          authDeadAt: transition.authDeadAt,
          authDeadReason: transition.authDeadReason,
          updatedAt: now,
        })
        .where(eq(usersTable.id, account.id));

      if (transition.authDeadAt) {
        result.markedDead++;
        logger.error(
          { userId: account.id, email: account.email, reason: transition.authDeadReason },
          "F-3.6a backfill: grant is AUTH-DEAD — account will not queue, generate or send until reconnected",
        );
      } else {
        result.cleared++;
        logger.info(
          { userId: account.id, email: account.email },
          "F-3.6a backfill: grant is healthy — auth-dead cleared",
        );
      }
    } catch (err) {
      // One account's failure never stops the sweep.
      result.inconclusive++;
      logger.error(
        { err, userId: account.id, email: account.email },
        "F-3.6a backfill: probe threw — account state left unchanged",
      );
    }
  }

  logger.warn(result, "F-3.6a backfill: auth-dead probe pass complete");
  return result;
}

/**
 * Run the whole deploy-time recovery. Never throws.
 *
 * Guarded by DEPLOY_RECOVERY_ENABLED (default on). A single env name is
 * cheaper than a redeploy if the probe ever misbehaves against a rate limit,
 * and it means the smoke run can boot the server with the passes off.
 */
export async function runDeployRecovery(): Promise<void> {
  if (process.env.DEPLOY_RECOVERY_ENABLED === "0") {
    logger.warn("F-3.6a: deploy-time recovery disabled by DEPLOY_RECOVERY_ENABLED=0");
    return;
  }

  try {
    await backfillAuthDeadFromProbe();
  } catch (err) {
    logger.error({ err }, "F-3.6a: auth-dead backfill failed (non-fatal; the sync tick reaches the same state)");
  }

  try {
    const recovered = await detectStrandedGeneratingFollowups();
    if (recovered > 0) {
      logger.warn({ recovered }, "F-3.6a: deploy-time stranded-generating recovery moved rows to 'failed'");
    }
  } catch (err) {
    logger.error({ err }, "F-3.6a: stranded recovery failed (non-fatal; the 15-minute tick retries it)");
  }
}
