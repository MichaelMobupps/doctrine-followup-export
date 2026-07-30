// followupLimits.ts — single source of truth for the rigid follow-up limits.
//
// Two limits live here, both pure and hermetically testable:
//
//   HARD_FOLLOWUP_CAP    a rigid ceiling on follow-up stages per campaign. No
//                        path on any subproduct may schedule more than this.
//                        It overrides any stored per-user value and removes
//                        the legacy "0 means unlimited" convention: a stored 0
//                        now resolves to the cap, and any stored value above
//                        the cap is clamped down to it. "Unlimited" no longer
//                        exists anywhere in the product.
//
//   CAMPAIGN_MAX_AGE_DAYS  the maximum number of days a campaign may run. A
//                        daily sweep force-pauses any active campaign whose
//                        original outreach was sent longer ago than this.
//
// Keep HARD_FOLLOWUP_CAP in sync with the MAX_FOLLOWUPS_CAP literal in
// dashboard/src/pages/accounts.tsx (the settings UI cannot import this module
// because it must not pull the server bundle into the frontend).

export const HARD_FOLLOWUP_CAP = 3;

export const CAMPAIGN_MAX_AGE_DAYS = 30;

// Resolve the effective follow-up cap for a stored per-user value. Always
// returns a positive integer no greater than HARD_FOLLOWUP_CAP. Replaces the
// prior getFollowupCap copies, which returned null ("unlimited") for a
// non-positive stored value.
export function effectiveFollowupCap(maxFollowups?: number | null): number {
  const stored =
    typeof maxFollowups === "number" && maxFollowups > 0
      ? maxFollowups
      : HARD_FOLLOWUP_CAP;
  return Math.min(stored, HARD_FOLLOWUP_CAP);
}

// True when a campaign whose original outreach was sent at `sentAt` has been
// running for at least `maxAgeDays` as of `now`. The boundary is inclusive: a
// campaign that is exactly maxAgeDays old counts as expired.
export function isCampaignExpired(
  sentAt: Date,
  now: Date,
  maxAgeDays: number = CAMPAIGN_MAX_AGE_DAYS,
): boolean {
  const ageMs = now.getTime() - sentAt.getTime();
  return ageMs >= maxAgeDays * 24 * 60 * 60 * 1000;
}
