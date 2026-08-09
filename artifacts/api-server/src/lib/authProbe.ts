/**
 * authProbe.ts — F-3.6a.
 *
 * One cheap question to Google: "is this grant still honoured?"
 *
 * `users.getProfile` is the smallest authenticated Gmail call there is — no
 * message list, no thread fetch, one round trip, and it exercises exactly the
 * thing that fails when a grant dies (the refresh-token exchange). It reads;
 * it cannot send, label, or modify anything.
 *
 * The Gmail client is a parameter, not an import, so the tests drive this
 * with a hand-rolled fake and never touch a network or a vendor.
 */

import { isAuthError } from "./connectionHealth";

/** The one method this module needs. Structural, so a fake satisfies it. */
export interface GmailProfileReader {
  users: {
    getProfile(params: { userId: string }): Promise<unknown>;
  };
}

export type ProbeResult =
  /** Gmail answered. The grant is good. */
  | { ok: true }
  /**
   * Gmail refused. `authFailure` distinguishes "the grant is dead" from
   * "something else went wrong" — a 5xx, a timeout, a quota error — because
   * only the former may mark an account dead.
   */
  | { ok: false; authFailure: boolean; error: string };

/**
 * Probe one grant. Never throws: every caller of this is a boot-time or
 * cron-time sweep over many accounts, and one bad account must not stop the
 * sweep.
 */
export async function probeGmailGrant(gmail: GmailProfileReader): Promise<ProbeResult> {
  try {
    await gmail.users.getProfile({ userId: "me" });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      authFailure: isAuthError(err),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Map a probe result onto the sync-outcome vocabulary the state machine takes. */
export function signalFromProbe(result: ProbeResult): "auth_failure" | "healthy" | "inconclusive" {
  if (result.ok) return "healthy";
  return result.authFailure ? "auth_failure" : "inconclusive";
}
