// adminKill.ts — pure helpers for the Admin Kill feature.
//
// Admin Kill hard-stops one salesperson's entire follow-up pipeline across
// all three subproducts (doctrine, context, anti-ghosting) in one
// transaction. It cancels in-flight work, blocks every re-queue path, and
// keeps every row. See routes/admin-user-kill.ts for the DB-backed endpoint.
//
// Everything here is pure (no DB, no I/O) so it can be unit-tested
// hermetically, following the pattern in test-suppression.ts. The route
// wires these helpers to the database inside a transaction.

import type { ProspectApp } from "@workspace/db";

// The active (non-terminal) follow-up statuses a Kill cancels. This MUST
// match the scheduler's ACTIVE_FOLLOWUP_STATUSES so the set stays correct if
// a status is added later. Terminal states — 'sent', 'failed', 'ok',
// 'cancelled' — and the parked 'stalled_awaiting_manual_send' state are NOT
// in this list and are never touched by a Kill.
export const KILL_ACTIVE_FOLLOWUP_STATUSES: readonly string[] = [
  "queued",
  "generating",
  "pending_approval",
  "drafted",
];

// The error message stamped onto every follow-up cancelled by a Kill, so the
// reason a row went to 'cancelled' is unambiguous in history and audit.
export const KILL_CANCEL_MESSAGE =
  "Pipeline killed by an admin (hard stop across all follow-up products).";

// The pause reason stamped onto every campaign (prospect) paused by a Kill.
// Distinct from a bounce, a reply, or a manual pause.
export const KILL_PAUSE_REASON = "admin_killed";

// The three subproducts a Kill spans. One user id covers all three because a
// person has one user row and their prospects carry their user id across
// doctrine, context, and anti_ghosting — so scoping by user id alone reaches
// every subproduct without filtering on `app`.
export const KILL_APPS: ProspectApp[] = ["doctrine", "context", "anti_ghosting"];

export interface NameMatchResult {
  ok: boolean;
  // Machine-readable failure cause. null when ok.
  reason:
    | null
    | "stored_name_empty" // the user has no usable stored name
    | "confirm_name_empty" // the caller sent an empty/whitespace confirmName
    | "mismatch"; // both present but they do not match
}

// The name-match guard. A Kill must refuse to act unless the caller typed the
// exact display name of the target user. We compare the trimmed confirmName
// against the trimmed stored name. An empty stored name or an empty/whitespace
// confirmName is always a rejection: an empty match would defeat the guard and
// let a kill fire against the wrong (un-named) person.
export function checkNameMatch(
  storedName: string | null | undefined,
  confirmName: unknown,
): NameMatchResult {
  const stored = typeof storedName === "string" ? storedName.trim() : "";
  if (stored.length === 0) return { ok: false, reason: "stored_name_empty" };

  const confirm = typeof confirmName === "string" ? confirmName.trim() : "";
  if (confirm.length === 0) return { ok: false, reason: "confirm_name_empty" };

  if (confirm !== stored) return { ok: false, reason: "mismatch" };
  return { ok: true, reason: null };
}

// A single subproduct's tally of what the Kill changed.
export interface SubproductCounts {
  followups_cancelled: number;
  campaigns_paused: number;
}

// The summary the endpoint returns. Totals plus a per-subproduct breakdown.
export interface KillSummary {
  followups_cancelled: number;
  campaigns_paused: number;
  by_app: Record<ProspectApp, SubproductCounts>;
}

// Build an empty per-subproduct tally with every app present and zeroed, so
// the response shape is stable even when a subproduct had nothing to kill.
export function emptyByApp(): Record<ProspectApp, SubproductCounts> {
  const out = {} as Record<ProspectApp, SubproductCounts>;
  for (const app of KILL_APPS) {
    out[app] = { followups_cancelled: 0, campaigns_paused: 0 };
  }
  return out;
}

// Roll a list of per-app rows into the KillSummary shape. Each input row
// names an app and how many follow-ups were cancelled / campaigns paused for
// that app. Rows for the same app accumulate. The totals are derived from the
// per-app tallies so the breakdown always sums to the headline numbers.
export function buildKillSummary(
  rows: Array<{ app: ProspectApp; followupsCancelled: number; campaignsPaused: number }>,
): KillSummary {
  const by_app = emptyByApp();
  for (const r of rows) {
    by_app[r.app].followups_cancelled += r.followupsCancelled;
    by_app[r.app].campaigns_paused += r.campaignsPaused;
  }
  let followups_cancelled = 0;
  let campaigns_paused = 0;
  for (const app of KILL_APPS) {
    followups_cancelled += by_app[app].followups_cancelled;
    campaigns_paused += by_app[app].campaigns_paused;
  }
  return { followups_cancelled, campaigns_paused, by_app };
}

// ── Prospect-level Kill ────────────────────────────────────────────
//
// Prospect-level Kill hard-stops ONE campaign (one prospect id), one level
// below the user-level Kill. It cancels that prospect's active follow-ups and
// pauses that one campaign, keeping every row. It deliberately has TWO layers,
// not three: it does NOT touch the owning user's paused_by_admin flag (that
// dispatch backstop belongs only to the user-level Kill, which kills the whole
// person). See routes/admin-prospect-kill.ts for the DB-backed endpoint.

export interface ProspectConfirmResult {
  ok: boolean;
  // Machine-readable failure cause. null when ok.
  reason:
    | null
    | "confirm_missing" // no usable confirmId was sent
    | "mismatch"; // a confirmId was sent but it does not equal the path id
}

// The id-confirm guard for a prospect-level Kill. A campaign Kill must refuse
// to act unless the caller echoes the prospect's own id back in the body. The
// campaign confirmation uses the prospect's id (not a name) because a prospect
// name is not unique, and an id echo blocks a kill fired from a stale row
// against the wrong campaign. We accept a numeric confirmId or a numeric
// string (JSON bodies sometimes carry ids as strings) but require strict
// numeric equality with the path id. Anything else is a rejection.
export function checkProspectConfirm(
  pathId: unknown,
  confirmId: unknown,
): ProspectConfirmResult {
  if (typeof pathId !== "number" || !Number.isFinite(pathId)) {
    return { ok: false, reason: "confirm_missing" };
  }
  let cid: number;
  if (typeof confirmId === "number" && Number.isFinite(confirmId)) {
    cid = confirmId;
  } else if (
    typeof confirmId === "string" &&
    confirmId.trim() !== "" &&
    Number.isFinite(Number(confirmId))
  ) {
    cid = Number(confirmId);
  } else {
    return { ok: false, reason: "confirm_missing" };
  }
  if (cid !== pathId) return { ok: false, reason: "mismatch" };
  return { ok: true, reason: null };
}

// The summary a prospect-level Kill returns: how many follow-ups it cancelled
// for the one campaign, and whether that campaign was paused.
export interface ProspectKillSummary {
  followups_cancelled: number;
  prospect_paused: boolean;
}