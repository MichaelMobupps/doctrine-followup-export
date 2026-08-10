/**
 * ownerIdentity.ts — F-3.6b.
 *
 * Who a follow-up is sent AS. A pure function: no db, no network, and — the
 * whole point of this file — no `process.env`.
 *
 * WHAT THIS DELETES
 *
 * Until F-3.6b the send path opened with:
 *
 *     let senderEmail = process.env.SENDER_EMAIL || "";
 *     let senderName  = process.env.SENDER_NAME  || "Team";
 *     let gmail       = undefined;
 *     if (item.userId) { …resolve the owner, overwrite all three… }
 *
 * and `sendFollowupReply` fell back to `getGmail()`, which authorised with
 * `process.env.GOOGLE_REFRESH_TOKEN`. Both variables are set in this
 * deployment. So a prospect with `user_id = NULL` never entered the `if`,
 * kept the env values, and was **delivered from the fallback mailbox** —
 * a client's follow-up going out under an identity that has nothing to do
 * with the campaign that owns it.
 *
 * F-3.6a's smoke found this by accident: a fixture row seeded with a null
 * user, expected to be skipped, reached Google and came back "Invalid
 * thread_id value" (TODO Open items, 2026-08-09). Nothing was delivered
 * because the thread id was fake. In production the thread ids are real.
 *
 * The fallback is gone. There is no identity of last resort: a row either
 * resolves to the account that owns its prospect, or it does not send.
 */

/** The account fields the send identity is built from. */
export interface SendIdentityOwner {
  email: string;
  name: string | null;
  googleRefreshToken: string | null;
  isConnected: boolean;
}

export type SendIdentityRefusal =
  /**
   * The prospect has no owning user at all (`prospects.user_id IS NULL`).
   * Terminal until a human assigns an owner — no retry can invent one, and
   * the row records it so the gap is countable instead of invisible.
   */
  | "owner_missing"
  /**
   * The owner exists but holds no usable Gmail grant (never connected, or
   * disconnected). Pre-existing behaviour, unchanged by F-3.6b: the row stays
   * queued and waits for the account to connect.
   */
  | "credentials_unavailable";

export type SendIdentity =
  | { ok: true; senderEmail: string; senderName: string; refreshToken: string }
  | { ok: false; reason: SendIdentityRefusal };

/**
 * Resolve the identity a follow-up sends as, or refuse.
 *
 * `userId` is the prospect's owner id — null for legacy rows that predate
 * multi-user. `owner` is that user's row, or null/undefined when the id
 * points at nothing (a deleted account, a stale foreign key).
 *
 * A missing owner and an unusable grant are deliberately DIFFERENT refusals.
 * The second is a waiting state that a reconnect fixes on its own; the first
 * is a data defect that no amount of waiting repairs, and conflating them is
 * how it stayed invisible for a year.
 */
export function resolveSendIdentity(args: {
  userId: number | null | undefined;
  owner: SendIdentityOwner | null | undefined;
}): SendIdentity {
  if (args.userId === null || args.userId === undefined) {
    return { ok: false, reason: "owner_missing" };
  }
  const owner = args.owner;
  if (!owner || !owner.googleRefreshToken || !owner.isConnected) {
    return { ok: false, reason: "credentials_unavailable" };
  }
  return {
    ok: true,
    senderEmail: owner.email,
    senderName: owner.name || owner.email.split("@")[0],
    refreshToken: owner.googleRefreshToken,
  };
}

/**
 * The sentence written onto a row refused for `owner_missing`.
 *
 * Rendered as data on the admin surface, like every other `error_message`.
 * It says what is wrong and what fixes it, because a row that fails with an
 * unexplained reason gets re-queued by a human who assumes it was transient.
 */
export const OWNER_MISSING_MESSAGE =
  "No owning account: this prospect has no user_id, so there is no Gmail grant to send from. " +
  "REFUSED — nothing was generated and nothing was sent. " +
  "Before F-3.6b this row would have been sent from the shared fallback mailbox, under an " +
  "identity unrelated to the campaign. Assign the prospect to an account, then re-queue.";
