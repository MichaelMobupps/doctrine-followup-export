/**
 * Send-window enforcement — Phase 6.
 *
 * Used by the dispatcher to verify, at SEND time, that the current moment
 * falls inside the user's configured `sendDays` + `sendHourStart..End`
 * window. Closes the gap where a row's `scheduledAt` fell inside-window
 * but the cron didn't actually fire it until much later (clock drift,
 * deploy backlog, missed tick).
 *
 * Uses UTC explicitly (`getUTCDay`, `getUTCHours`) so behavior does not
 * depend on the host container's TZ env. The boot-time UTC pin in
 * index.ts guarantees `setHours()` etc. also operate on UTC, but this
 * helper is defensive against any future divergence.
 *
 * Defaults match the original timingEngine defaults: Mon-Fri (1..5),
 * 8..18.
 */

const DEFAULT_SEND_DAYS = [1, 2, 3, 4, 5];

export interface SendWindowUserView {
  sendDays: number[];
  sendHourStart: number;
  sendHourEnd: number;
}

export interface SendWindowResult {
  ok: boolean;
  reason?: string;
  utcDay?: number;
  utcHour?: number;
}

export function isInSendWindow(user: SendWindowUserView, now: Date): SendWindowResult {
  const day = now.getUTCDay();
  const hour = now.getUTCHours();

  const sendDays = (user.sendDays && user.sendDays.length > 0)
    ? user.sendDays
    : DEFAULT_SEND_DAYS;

  if (!sendDays.includes(day)) {
    return {
      ok: false,
      reason: `day_${day}_not_in_allowed_${sendDays.join(",")}`,
      utcDay: day,
      utcHour: hour,
    };
  }

  if (typeof user.sendHourStart !== "number" || typeof user.sendHourEnd !== "number" || user.sendHourEnd <= user.sendHourStart) {
    // Defensive: if the hour bounds are nonsensical, treat as 8..18.
    const hStart = 8;
    const hEnd = 18;
    if (hour < hStart || hour >= hEnd) {
      return { ok: false, reason: `hour_${hour}_outside_default_${hStart}_${hEnd}_due_to_invalid_user_bounds`, utcDay: day, utcHour: hour };
    }
    return { ok: true, utcDay: day, utcHour: hour };
  }

  if (hour < user.sendHourStart || hour >= user.sendHourEnd) {
    return {
      ok: false,
      reason: `hour_${hour}_outside_${user.sendHourStart}_${user.sendHourEnd}`,
      utcDay: day,
      utcHour: hour,
    };
  }

  return { ok: true, utcDay: day, utcHour: hour };
}
