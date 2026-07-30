/**
 * B9b: AntiGhosting scheduling formula.
 *
 * Computes the scheduledAt timestamp for the first follow-up after an
 * operator marks a thread for re-engagement. The formula deliberately
 * splits two concerns:
 *
 *   1. CADENCE GAP — how long after the seed message we want the
 *      re-engagement to land. Default 7 days, matching the F1 max
 *      window in the existing draft-mode timing.
 *   2. MIN BUFFER — minimum delay after marking, no matter how stale
 *      the seed is. Guards against immediate fires when the operator
 *      marks a thread from a months-old seed: gives them time to spot
 *      a wrong mark before the email goes out.
 *
 * Result = max(sentAt + cadenceGap, markedAt + minBuffer).
 *
 * For a fresh seed (sent recently), the cadence gap wins: we wait the
 * full gap after the seed. For a stale seed (sent long ago), the min
 * buffer wins: we don't fire until at least one day after marking.
 *
 * The full per-stage cadence (F2 / F3 / ...) lives in B9c's scheduler
 * extensions. B9b only schedules F1.
 *
 * The module is pure — no DB, no Gmail, no I/O. Fully unit-testable.
 */

export const ANTI_GHOSTING_F1_CADENCE_GAP_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const ANTI_GHOSTING_MIN_BUFFER_MS = 1 * 24 * 60 * 60 * 1000;    // 1 day

export interface ComputeFirstFollowupAtParams {
  /** When the seed message was originally sent. */
  sentAt: Date;
  /** When the operator marked the thread (typically Date.now()). */
  markedAt: Date;
  /** Override the cadence gap. Defaults to ANTI_GHOSTING_F1_CADENCE_GAP_MS. */
  cadenceGapMs?: number;
  /** Override the min buffer. Defaults to ANTI_GHOSTING_MIN_BUFFER_MS. */
  minBufferMs?: number;
}

/**
 * Compute the F1 followup scheduledAt timestamp for an AntiGhosting prospect.
 * See module docstring for the formula and its rationale.
 */
export function computeFirstFollowupAt(params: ComputeFirstFollowupAtParams): Date {
  const cadenceGap = params.cadenceGapMs ?? ANTI_GHOSTING_F1_CADENCE_GAP_MS;
  const minBuffer = params.minBufferMs ?? ANTI_GHOSTING_MIN_BUFFER_MS;

  const fromSeed = params.sentAt.getTime() + cadenceGap;
  const fromMark = params.markedAt.getTime() + minBuffer;

  return new Date(Math.max(fromSeed, fromMark));
}
