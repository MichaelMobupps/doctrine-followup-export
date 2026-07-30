// Pure, DB-free helpers for the global daily budget cap.
//
// Kept separate from dailyBudget.ts (which talks to the DB) so the boundary
// and cap-resolution logic can be unit-tested with node:test without a
// database connection. dailyBudget.ts re-uses everything exported here.

export const DAILY_BUDGET_CAP_KEY = "daily_budget_cap_usd";
export const DAILY_BUDGET_ENABLED_KEY = "daily_budget_enabled";

// Hard default when neither app_settings nor the env override supplies a cap.
export const DEFAULT_CAP_USD = 500;

const DEFAULT_TZ = "Asia/Jerusalem";

export function getBudgetTimeZone(): string {
  return process.env.DOCTRINE_BUDGET_TZ || DEFAULT_TZ;
}

// Milliseconds the local wall-clock in `timeZone` is ahead of UTC at the
// given instant (e.g. +3h during Israel DST -> 10_800_000). Derived from
// Intl, so it is correct under a UTC-pinned process (see index.ts) where the
// local Date methods would all report UTC.
function tzOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  const asUtcMs = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second),
  );
  return asUtcMs - instant.getTime();
}

// The most recent local-midnight in `timeZone`, returned as a UTC Date.
// This is the start of the current budget day. Israel switches DST at 02:00,
// so midnight is never inside a skipped or repeated hour and the single
// offset correction below is exact.
export function startOfBudgetDayUtc(now: Date, timeZone: string): Date {
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const [y, m, d] = ymd.split("-").map(Number);
  // Treat that wall-clock midnight as if it were UTC, then correct by the
  // zone's actual offset at that instant.
  const guessUtcMs = Date.UTC(y, m - 1, d, 0, 0, 0);
  const offsetMs = tzOffsetMs(new Date(guessUtcMs), timeZone);
  return new Date(guessUtcMs - offsetMs);
}

function parseCap(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

// Resolve the cap in USD. Precedence: app_settings value -> env
// DOCTRINE_DAILY_BUDGET_USD -> DEFAULT_CAP_USD. Invalid values fall through
// to the next source rather than throwing, so a bad setting can never crash
// the scheduler.
export function resolveCapUsd(settingValue: string | null | undefined): number {
  const fromSetting = parseCap(settingValue);
  if (fromSetting !== null) return fromSetting;
  const fromEnv = parseCap(process.env.DOCTRINE_DAILY_BUDGET_USD);
  if (fromEnv !== null) return fromEnv;
  return DEFAULT_CAP_USD;
}
