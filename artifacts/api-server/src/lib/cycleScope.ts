/**
 * cycleScope.ts — F-3.6b.
 *
 * The cycle-scoped stage rules, as pure functions. No db, no network.
 *
 * ONE implementation, two consumers: `scheduler.ts` builds its SQL from the
 * rules stated here, and the tests drive these functions directly with a
 * fixture. Same discipline as `dueEligibility.ts` and `legacyRedirectTarget()`
 * — a rule that lives in two places drifts.
 *
 * THE DEFECT THIS FIXES
 *
 * B9a moved the unique constraint on `followups` from `(prospect_id, stage)`
 * to `(prospect_id, cycle, stage)` so a renewed AntiGhosting campaign can
 * re-use stage numbers 1..3 under a new cycle. The queueing path never
 * followed:
 *
 *   - `queueStageForProspect` looked up `(prospect_id, stage)` with
 *     `.limit(1)` and no `ORDER BY`, then INSERTed without a `cycle`, taking
 *     the column default of 1.
 *   - `autoQueueAllCampaigns` computed `maxSentStage` across **every** cycle.
 *
 * For an AntiGhosting prospect on cycle 2 whose cycle-1 stage 1 is `sent`,
 * the lookup finds that cycle-1 row, sees `sent`, and returns
 * `{queued: false}`. The cycle-2 stage is never queued and the renewed
 * campaign is stranded. Where the stage numbers do not collide the other
 * half bites instead: stage counting across cycles pushes `nextStage` past
 * the cap and the sweep skips the prospect for ever.
 *
 * Doctrine and Context are unaffected either way — every one of their rows is
 * cycle 1 on both sides — which is why this sat unnoticed since B9a.
 *
 * `cycleScoped: false` reproduces the pre-F-3.6b behaviour against the same
 * single implementation, so the regression test demonstrates the defect
 * rather than asserting it.
 */

/** The follow-up fields the cycle decision reads. */
export interface StageRow {
  id: number;
  cycle: number;
  stage: number;
  status: string;
  sentAt: Date | null;
}

export interface CycleScopeOptions {
  /**
   * Whether rows are scoped to the prospect's current cycle.
   *
   * Production always passes true — it is the fix. The tests pass false to
   * reproduce the pre-F-3.6b behaviour against the same fixture.
   */
  cycleScoped?: boolean;
}

/** Statuses that mean "this campaign already has work in flight". */
const ACTIVE_STATUSES = ["queued", "generating", "pending_approval", "drafted"];

function scoped(options: CycleScopeOptions): boolean {
  return options.cycleScoped !== false;
}

/**
 * The rows a decision about `cycle` may look at.
 *
 * Scoped: only that cycle's rows. Unscoped (the old behaviour): every row the
 * prospect has ever had, including the previous cycles' `sent` history.
 */
export function rowsInCycle(
  rows: StageRow[],
  cycle: number,
  options: CycleScopeOptions = {},
): StageRow[] {
  return scoped(options) ? rows.filter((r) => r.cycle === cycle) : rows.slice();
}

/**
 * The row occupying `(cycle, stage)` — what `queueStageForProspect`'s
 * existing-row lookup returns.
 *
 * Unscoped this is the old `WHERE prospect_id = ? AND stage = ? LIMIT 1` with
 * no `ORDER BY`: it returns whichever row the planner hands back first, which
 * for a renewed campaign is routinely the previous cycle's. Scoped, the tuple
 * is the unique key, so there is at most one row and no ambiguity.
 */
export function findStageRow(
  rows: StageRow[],
  cycle: number,
  stage: number,
  options: CycleScopeOptions = {},
): StageRow | undefined {
  return rowsInCycle(rows, cycle, options).find((r) => r.stage === stage);
}

export interface CampaignPosition {
  /** Highest stage already SENT within scope. 0 when none. */
  maxSentStage: number;
  /** When that stage was sent. Null when nothing has been sent in scope. */
  lastSentAt: Date | null;
  /** True when some row in scope is queued/generating/pending/drafted. */
  hasActive: boolean;
  /** The stage the next queue attempt should use. */
  nextStage: number;
}

/**
 * Where a campaign stands — what `autoQueueAllCampaigns` and
 * `queueNextFollowupStageForProspect` compute before choosing a stage.
 *
 * Scoped, a renewal starts again at stage 1, which is what the renewal model
 * means. Unscoped, cycle 1's three sent stages make `nextStage` 4 on a cycle
 * that has sent nothing, and the follow-up cap then rejects it silently.
 */
export function campaignPosition(
  rows: StageRow[],
  cycle: number,
  options: CycleScopeOptions = {},
): CampaignPosition {
  const inScope = rowsInCycle(rows, cycle, options);

  let maxSentStage = 0;
  let lastSentAt: Date | null = null;
  let hasActive = false;

  for (const row of inScope) {
    if (row.status === "sent" && row.stage > maxSentStage) {
      maxSentStage = row.stage;
      lastSentAt = row.sentAt;
    }
    if (ACTIVE_STATUSES.includes(row.status)) hasActive = true;
  }

  return { maxSentStage, lastSentAt, hasActive, nextStage: maxSentStage + 1 };
}
