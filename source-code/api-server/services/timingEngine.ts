import type { StageTiming } from "@workspace/db";
import { DEFAULT_DRAFT_STAGE_TIMING } from "@workspace/db";

export interface ScheduleWindow {
  min_days: number;
  max_days: number;
  hour_start: number;
  hour_end: number;
  sendDays: number[];
}

export type FollowupScheduleMode = "auto_send" | "review_in_app" | "draft_in_gmail";

export interface UserTimingSettings {
  stageTiming: StageTiming[];
  draftStageTiming?: StageTiming[];
  sendDays: number[];
  sendHourStart: number;
  sendHourEnd: number;
}

const DEFAULT_SEND_DAYS = [1, 2, 3, 4, 5];

const DEFAULT_STAGE_DEFAULTS: { min: number; max: number }[] = [
  { min: 3, max: 7 },
  { min: 10, max: 14 },
  { min: 21, max: 28 },
  { min: 35, max: 42 },
  { min: 49, max: 56 },
  { min: 63, max: 70 },
  { min: 77, max: 84 },
  { min: 90, max: 98 },
  { min: 105, max: 112 },
  { min: 120, max: 126 },
];

function findNextAllowedDay(date: Date, sendDays: number[]): Date {
  if (sendDays.length === 0) return date;
  const result = new Date(date);
  let attempts = 0;
  // Phase 6: use getUTCDay/setUTCDate so day-of-week math is timezone-free.
  while (!sendDays.includes(result.getUTCDay()) && attempts < 7) {
    result.setUTCDate(result.getUTCDate() + 1);
    attempts++;
  }
  return result;
}

export function generateScheduledTime(
  window: ScheduleWindow,
  fromDate?: Date,
): string {
  const now = fromDate || new Date();

  const dayOffset =
    window.min_days +
    Math.floor(Math.random() * (window.max_days - window.min_days + 1));

  const hour =
    window.hour_start +
    Math.floor(Math.random() * (window.hour_end - window.hour_start));

  const minute = Math.floor(Math.random() * 46);

  // Phase 6: all clock math uses UTC variants. The TZ pin in index.ts
  // already guarantees Node operates on UTC, but explicit calls here
  // make the intent unambiguous and survive future TZ regressions.
  const scheduled = new Date(now);
  scheduled.setUTCDate(scheduled.getUTCDate() + dayOffset);
  scheduled.setUTCHours(hour, minute, 0, 0);

  const adjusted = findNextAllowedDay(scheduled, window.sendDays);
  adjusted.setUTCHours(hour, minute, 0, 0);

  return adjusted.toISOString();
}

export function getScheduleWindow(stage: number, userSettings?: UserTimingSettings): ScheduleWindow {
  const stageIndex = stage - 1;

  if (userSettings && userSettings.stageTiming && stageIndex < userSettings.stageTiming.length) {
    const timing = userSettings.stageTiming[stageIndex];
    return {
      min_days: timing.minDays,
      max_days: timing.maxDays,
      hour_start: userSettings.sendHourStart,
      hour_end: userSettings.sendHourEnd,
      sendDays: userSettings.sendDays || DEFAULT_SEND_DAYS,
    };
  }

  const d = DEFAULT_STAGE_DEFAULTS[stageIndex] || { min: 7 * (stageIndex + 1), max: 7 * (stageIndex + 1) + 7 };

  return {
    min_days: parseInt(process.env[`FOLLOWUP_${stage}_MIN_DAYS`] || String(d.min)),
    max_days: parseInt(process.env[`FOLLOWUP_${stage}_MAX_DAYS`] || String(d.max)),
    hour_start: parseInt(process.env.SEND_HOUR_START || "8"),
    hour_end: parseInt(process.env.SEND_HOUR_END || "18"),
    sendDays: DEFAULT_SEND_DAYS,
  };
}

function getDraftScheduleWindow(stage: number, userSettings?: UserTimingSettings): ScheduleWindow {
  const stageIndex = stage - 1;
  const configured = userSettings?.draftStageTiming?.length
    ? userSettings.draftStageTiming
    : DEFAULT_DRAFT_STAGE_TIMING;
  const timing = configured[Math.min(stageIndex, configured.length - 1)] || DEFAULT_DRAFT_STAGE_TIMING[0];

  return {
    min_days: timing.minDays,
    max_days: timing.maxDays,
    hour_start: userSettings?.sendHourStart ?? parseInt(process.env.SEND_HOUR_START || "8"),
    hour_end: userSettings?.sendHourEnd ?? parseInt(process.env.SEND_HOUR_END || "18"),
    sendDays: userSettings?.sendDays || DEFAULT_SEND_DAYS,
  };
}

function catchUpSoon(now: Date): Date {
  return new Date(now.getTime() + 60 * 60 * 1000);
}

function computeDraftStageScheduledAt(args: {
  stage: number;
  initialSentAt: Date;
  lastFollowupSentAt?: Date | null;
  userSettings?: UserTimingSettings;
  now: Date;
}): Date {
  const { stage, initialSentAt, lastFollowupSentAt, userSettings, now } = args;
  const window = getDraftScheduleWindow(stage, userSettings);

  if (stage <= 1) {
    const absolute = new Date(generateScheduledTime(window, initialSentAt));
    return absolute > now ? absolute : catchUpSoon(now);
  }

  if (!lastFollowupSentAt) {
    return catchUpSoon(now);
  }

  const scheduledFromManualSend = new Date(generateScheduledTime(window, lastFollowupSentAt));
  return scheduledFromManualSend > now ? scheduledFromManualSend : catchUpSoon(now);
}

/**
 * Compute scheduledAt for the next stage of a follow-up sequence.
 *
 * Auto-send / review-in-app semantics: stages are anchored to the prospect's
 * initial email (e.g. "stage 2 = 10-14 days after initial"). When the initial
 * email is recent enough that the absolute window is still in the future, we
 * use it directly.
 *
 * Auto-send catch-up semantics: when the initial email is older than the
 * configured windows, stage 1 goes to "now + 1 hour" and stage > 1 anchors on
 * the previous stage's actual sent time. This preserves the user's intended
 * inter-stage cadence instead of collapsing every stage onto the same day.
 *
 * Draft-in-Gmail semantics: stage 1 still anchors to the initial email, but
 * stage > 1 anchors to the previous stage's manual sent time. The next draft is
 * not queued until that prior draft is detected as sent by the user.
 */
export function computeNextStageScheduledAt(args: {
  stage: number;
  initialSentAt: Date;
  lastFollowupSentAt?: Date | null;
  userSettings?: UserTimingSettings;
  mode?: FollowupScheduleMode;
  now?: Date;
}): Date {
  const { stage, initialSentAt, lastFollowupSentAt, userSettings } = args;
  const now = args.now ?? new Date();
  const mode = args.mode ?? "auto_send";

  if (mode === "draft_in_gmail") {
    return computeDraftStageScheduledAt({
      stage,
      initialSentAt,
      lastFollowupSentAt,
      userSettings,
      now,
    });
  }

  const window = getScheduleWindow(stage, userSettings);

  // Primary path: honor the configured "X days after initial" window
  // when the result is still in the future.
  const absolute = new Date(generateScheduledTime(window, initialSentAt));
  if (absolute > now) return absolute;

  // Catch-up path: absolute window is in the past.
  if (stage <= 1) {
    // No previous stage to anchor on. Send F1 in roughly an hour.
    return catchUpSoon(now);
  }

  // Stage > 1: anchor on the previous stage's send time and apply the
  // inter-stage gap implied by the user's configured windows.
  const prev = getScheduleWindow(stage - 1, userSettings);
  const minGapDays = Math.max(1, window.min_days - prev.max_days);
  const maxGapDays = Math.max(minGapDays, window.max_days - prev.min_days);

  const anchor = lastFollowupSentAt
    ? new Date(Math.max(lastFollowupSentAt.getTime(), now.getTime()))
    : now;

  const gapWindow: ScheduleWindow = {
    min_days: minGapDays,
    max_days: maxGapDays,
    hour_start: window.hour_start,
    hour_end: window.hour_end,
    sendDays: window.sendDays,
  };

  return new Date(generateScheduledTime(gapWindow, anchor));
}

export function generateBatchSchedule(
  prospectIds: number[],
  stage: number,
  userSettings?: UserTimingSettings,
): Map<number, string> {
  const window = getScheduleWindow(stage, userSettings);
  const schedule = new Map<number, string>();
  const usedMinutes = new Set<string>();

  for (const pid of prospectIds) {
    let attempts = 0;
    let time: string;

    do {
      time = generateScheduledTime(window);
      attempts++;
    } while (usedMinutes.has(time.slice(0, 16)) && attempts < 50);

    usedMinutes.add(time.slice(0, 16));
    schedule.set(pid, time);
  }

  return schedule;
}
