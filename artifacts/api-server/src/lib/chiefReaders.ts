/**
 * chiefReaders.ts — F-3.7a. The database side of the Chief uplink.
 *
 * Every function here READS. Nothing in this file inserts, updates, deletes or
 * calls a vendor, and nothing it returns depends on anything the caller sent —
 * the uplink's identity comes from the order-token and from nowhere else.
 *
 * ── WHY THESE READS THROW, WHEN THEIR SIBLINGS FAIL OPEN ─────────────────────
 *
 * `getDailyBudgetState()` swallows a read error and returns `spentUsd: 0`, and
 * `isGlobalPauseEnabled()` swallows one and returns `false`. Both are right for
 * their own callers: a database blip must never freeze sending for the whole
 * team, and it must never silently pause every campaign either.
 *
 * Both are exactly wrong here. A status endpoint that answers `ok: true` with a
 * fabricated zero tells the Chief this app has spent nothing and that nothing
 * is paused, at the precise moment it cannot see whether either is true. The
 * Chief's own contract says so in as many words — "`503` if you cannot read
 * your own numbers — **never a fabricated zero**" (CONTRACT.md §13).
 *
 * So the reads below are composed from the same PURE helpers those two modules
 * use (`startOfBudgetDayUtc`, `resolveCapUsd`, the settings keys) and they let
 * the error out. The arithmetic is shared; only the failure direction differs,
 * and that difference is the point.
 */

import {
  db,
  appSettingsTable,
  cronHeartbeatsTable,
  followupsTable,
  followupUsageTable,
  prospectsTable,
  usersTable,
  GLOBAL_PAUSE_KEY,
} from "@workspace/db";
import { and, eq, gte, inArray, isNull, lte, notInArray, or, sql } from "drizzle-orm";
import { HEARTBEAT_RUNNING, NON_CADENCE_TICKS } from "./heartbeatLifecycle";
import {
  DAILY_BUDGET_CAP_KEY,
  DAILY_BUDGET_ENABLED_KEY,
  getBudgetTimeZone,
  resolveCapUsd,
  startOfBudgetDayUtc,
} from "./dailyBudgetMath";
import {
  type AccountCensus,
  type AccountRow,
  type CronPulse,
  accountLabel,
  accountState,
  startOfUtcDay,
} from "./chiefView";

/** The raw account columns both the census and the page are derived from. */
interface AccountBase {
  id: number;
  name: string | null;
  isConnected: boolean;
  authDeadAt: Date | null;
  authDeadReason: string | null;
  pausedByAdmin: boolean;
}

/**
 * Spend across every vendor since the start of the UTC day containing `now`.
 *
 * The UTC day, deliberately, and NOT this app's Asia/Jerusalem budget day: it
 * is the window every spend report to the Chief is bucketed by
 * (`chiefSpend.ts`), so the card's figure and the ledger's figure describe the
 * same hours. The budget-day figure travels too, under `budget.app_budget_day`,
 * because it is the one an operator can reconcile against this app's own admin
 * surface.
 */
export async function readSpendTodayUsd(now: Date): Promise<number> {
  const rows = await db
    .select({ total: sql<string>`COALESCE(SUM(${followupUsageTable.costUsd}), 0)` })
    .from(followupUsageTable)
    .where(gte(followupUsageTable.generatedAt, startOfUtcDay(now)));
  return Number(rows[0]?.total ?? 0);
}

/**
 * Two `app_settings` values in one round trip. Throws — see the header.
 * Returns a map so a missing key is `undefined` rather than a silent default.
 */
async function readSettings(keys: string[]): Promise<Map<string, string>> {
  const rows = await db
    .select({ key: appSettingsTable.key, value: appSettingsTable.value })
    .from(appSettingsTable)
    .where(inArray(appSettingsTable.key, keys));
  return new Map(rows.map((r) => [r.key, r.value]));
}

export interface BudgetDayFacts {
  timeZone: string;
  windowStartUtc: Date;
  spentUsd: number;
  capUsd: number;
  enabled: boolean;
  exceeded: boolean;
}

/**
 * This app's OWN budget day, the window the daily cap governs.
 *
 * Same arithmetic as `getDailyBudgetState()` — the pure helpers are imported,
 * not re-derived — with the fail-open catch removed. `enabled` defaults to
 * true on a missing key exactly as it does there: only an explicit `'false'`
 * disables enforcement.
 */
export async function readBudgetDay(now: Date): Promise<BudgetDayFacts> {
  const timeZone = getBudgetTimeZone();
  const windowStartUtc = startOfBudgetDayUtc(now, timeZone);
  const [settings, spentRows] = await Promise.all([
    readSettings([DAILY_BUDGET_CAP_KEY, DAILY_BUDGET_ENABLED_KEY]),
    db
      .select({ total: sql<string>`COALESCE(SUM(${followupUsageTable.costUsd}), 0)` })
      .from(followupUsageTable)
      .where(gte(followupUsageTable.generatedAt, windowStartUtc)),
  ]);
  const spentUsd = Number(spentRows[0]?.total ?? 0);
  const capUsd = resolveCapUsd(settings.get(DAILY_BUDGET_CAP_KEY) ?? null);
  const enabledRaw = settings.get(DAILY_BUDGET_ENABLED_KEY);
  const enabled = enabledRaw === undefined ? true : enabledRaw !== "false";
  return {
    timeZone,
    windowStartUtc,
    spentUsd,
    capUsd,
    enabled,
    exceeded: spentUsd >= capUsd,
  };
}

/** The app-wide sending switch. Throws rather than defaulting — see the header. */
export async function readGlobalPause(): Promise<boolean> {
  const settings = await readSettings([GLOBAL_PAUSE_KEY]);
  return settings.get(GLOBAL_PAUSE_KEY) === "true";
}

/**
 * Every account's state-deciding columns, ordered by id.
 *
 * `id` ascending is the paging order and it must stay stable: a page boundary
 * walked with `offset` is only coherent if the sort key does not move, and an
 * account's id never does. Sorting by label or by state would reshuffle the
 * whole set the moment one account went auth-dead mid-walk, so a caller
 * following `next_offset` could skip a row — which on this endpoint means
 * skipping the one account it exists to surface.
 */
function accountBaseQuery() {
  return db
    .select({
      id: usersTable.id,
      name: usersTable.name,
      isConnected: usersTable.isConnected,
      authDeadAt: usersTable.authDeadAt,
      authDeadReason: usersTable.authDeadReason,
      pausedByAdmin: usersTable.pausedByAdmin,
    })
    .from(usersTable)
    .orderBy(usersTable.id);
}

async function readAccountBases(): Promise<AccountBase[]> {
  return accountBaseQuery();
}

async function countAccounts(): Promise<number> {
  const rows = await db.select({ n: sql<number>`count(*)::int` }).from(usersTable);
  return Number(rows[0]?.n ?? 0);
}

/**
 * The account census.
 *
 * Folded in TypeScript over the same rows the page is built from, rather than
 * counted with SQL `FILTER` clauses. That is a deliberate trade of a few
 * microseconds for the elimination of a drift class: a `FILTER` census is a
 * SECOND implementation of `accountState()`'s precedence, and the two would
 * disagree the first time somebody reorders the state rules in one place. The
 * table holds the operator team — fifteen rows today — so there is no size
 * argument on the other side.
 */
export async function readAccountCensus(): Promise<AccountCensus> {
  const rows = await readAccountBases();
  const census: AccountCensus = {
    connected: 0,
    auth_dead: 0,
    paused: 0,
    disconnected: 0,
    total: rows.length,
  };
  for (const r of rows) {
    census[accountState(r)] += 1;
  }
  return census;
}

/**
 * How many follow-ups the next processing pass would consider.
 *
 * Byte-for-byte the WHERE clause `processDueFollowups()` builds, minus the
 * batch limit — so this number answers "how deep is the queue", not "how many
 * will run this tick". Held users (admin-paused, auth-dead) are excluded here
 * for the same reason they are excluded there: since F-3.6a they are not
 * eligible work, and counting them would restate the starvation F-D4 found as
 * if it were backlog.
 */
export async function readDueQueueDepth(now: Date): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(followupsTable)
    .innerJoin(prospectsTable, eq(followupsTable.prospectId, prospectsTable.id))
    // LEFT, matching the scheduler: `prospects.user_id` is nullable for legacy
    // rows and an inner join would drop every one of them from the count.
    .leftJoin(usersTable, eq(prospectsTable.userId, usersTable.id))
    .where(
      and(
        eq(followupsTable.status, "queued"),
        lte(followupsTable.scheduledAt, now),
        or(eq(prospectsTable.replied, 0), eq(prospectsTable.app, "anti_ghosting"))!,
        eq(prospectsTable.followupPaused, false),
        or(
          isNull(prospectsTable.userId),
          and(eq(usersTable.pausedByAdmin, false), isNull(usersTable.authDeadAt)),
        )!,
      ),
    );
  return Number(rows[0]?.n ?? 0);
}

/**
 * One pulse per cron tick: when it last fired, and how it has behaved for a
 * day. The same rollup `GET /api/admin/cron-heartbeats` renders, minus the
 * heartbeat rows themselves — the Chief needs the ages, not the payloads, and
 * the payloads are the part that can carry a serialised provider error.
 *
 * NOTE what is NOT here: `details`. That column is where a googleapis error can
 * serialise an `Authorization: Bearer …`, which is why F-3.6a wrote a redactor
 * for it. Not selecting it at all is a stronger guarantee than redacting it.
 *
 * F-3.7c CHANGES WHAT `last_fired_at` MEANS, and the Chief has to know: it is
 * now the instant the tick FIRED, not the instant its row was written. Before
 * this order a tick stamped its row when its body finished, so a tick with a
 * long body reported an age that was younger than the truth by however long the
 * work took — `sync_and_autoqueue` fired at 18:00:00 on 2026-08-17 and stamped
 * 18:05:19. The honest figure is larger, and it climbs to the tick's full
 * cadence between firings. A staleness rule set at exactly 1x cadence will now
 * alarm on a healthy tick; the "sane multiple" C-3.7b §4 specifies will not.
 */
export async function readCronPulses(): Promise<CronPulse[]> {
  const rows = await db
    .select({
      tickName: cronHeartbeatsTable.tickName,
      lastFiredAt: sql<string | null>`max(${cronHeartbeatsTable.firedAt})`,
      // F-3.7c: computed HERE, by the database, in the same snapshot as the two
      // counters beside it. It used to be `new Date()` in the route minus this
      // timestamp — the app's clock against the database's — which is the one
      // way these three figures could contradict each other while every row
      // they read agreed. `greatest(0, …)` because an age is never negative and
      // a status endpoint is the wrong place to discover a clock going
      // backwards.
      ageSeconds: sql<
        number | null
      >`greatest(0, round(extract(epoch from (now() - max(${cronHeartbeatsTable.firedAt})))))::int`,
      ticks24h: sql<number>`count(*) filter (where ${cronHeartbeatsTable.firedAt} > now() - interval '24 hours')::int`,
      // F-3.7c: `not in ('ok', 'running')` rather than `<> 'ok'`. A row sits at
      // `running` between its tick's firing and its result, and an in-flight
      // tick is not a failed one — with the 15-minute ticks running for minutes
      // at a time, `<> 'ok'` would report an error on nearly every probe.
      // Written as an exclusion rather than as `in ('partial','error')` so that
      // an outcome nobody here has thought of yet counts as a problem instead
      // of disappearing.
      errors24h: sql<number>`count(*) filter (where ${cronHeartbeatsTable.firedAt} > now() - interval '24 hours' and ${cronHeartbeatsTable.outcome} not in ('ok', ${HEARTBEAT_RUNNING}))::int`,
    })
    .from(cronHeartbeatsTable)
    // F-3.7c: the restart marker and anything else without a cadence is
    // withheld. The Chief's staleness rule is "age over a sane multiple of
    // this tick's cadence" (C-3.7b §4), and `process_start`'s age is the
    // process's uptime — a number that is SUPPOSED to grow without bound. It
    // stays on the admin surface, which is where a hole gets explained.
    .where(notInArray(cronHeartbeatsTable.tickName, [...NON_CADENCE_TICKS]))
    .groupBy(cronHeartbeatsTable.tickName)
    .orderBy(cronHeartbeatsTable.tickName);

  return rows.map((r) => {
    const last = r.lastFiredAt ? new Date(r.lastFiredAt) : null;
    const valid = last && !Number.isNaN(last.getTime()) ? last : null;
    const age = Number(r.ageSeconds);
    return {
      tick_name: r.tickName,
      last_fired_at: valid ? valid.toISOString() : null,
      age_seconds: Number.isFinite(age) ? age : null,
      ticks_24h: Number(r.ticks24h ?? 0),
      errors_24h: Number(r.errors24h ?? 0),
    };
  });
}

export interface AccountsSlice {
  rows: AccountRow[];
  total: number;
}

/**
 * One slice of the accounts page.
 *
 * Three reads rather than one join with two aggregates: the account rows are
 * paged, and the two per-account aggregates are then fetched for exactly the
 * ids on this page. A single query with two correlated sub-selects would be
 * tidier to look at and would compute both aggregates for every account in the
 * table on every page.
 *
 * `queue_depth` counts follow-ups in `queued` whose campaign is live — not
 * paused and not archived. It deliberately does NOT apply the due-time or
 * held-user filters that `readDueQueueDepth()` uses: this is "what is waiting
 * for this account", which is a backlog question, and an account whose work is
 * all held by its own auth-dead state must still show that the work exists.
 */
export async function readAccountsSlice(limit: number, offset: number): Promise<AccountsSlice> {
  const [slice, total] = await Promise.all([
    accountBaseQuery().limit(limit).offset(offset),
    countAccounts(),
  ]);
  if (slice.length === 0) return { rows: [], total };

  const ids = slice.map((a) => a.id);

  const [lastSends, queueDepths] = await Promise.all([
    db
      .select({
        userId: prospectsTable.userId,
        lastSentAt: sql<string | null>`max(${followupsTable.sentAt})`,
      })
      .from(followupsTable)
      .innerJoin(prospectsTable, eq(followupsTable.prospectId, prospectsTable.id))
      .where(
        and(
          eq(followupsTable.status, "sent"),
          inArray(prospectsTable.userId, ids),
        ),
      )
      .groupBy(prospectsTable.userId),
    db
      .select({
        userId: prospectsTable.userId,
        depth: sql<number>`count(*)::int`,
      })
      .from(followupsTable)
      .innerJoin(prospectsTable, eq(followupsTable.prospectId, prospectsTable.id))
      .where(
        and(
          eq(followupsTable.status, "queued"),
          eq(prospectsTable.followupPaused, false),
          eq(prospectsTable.archived, false),
          inArray(prospectsTable.userId, ids),
        ),
      )
      .groupBy(prospectsTable.userId),
  ]);

  const lastSendById = new Map<number, string | null>();
  for (const r of lastSends) {
    if (r.userId === null) continue;
    const d = r.lastSentAt ? new Date(r.lastSentAt) : null;
    lastSendById.set(r.userId, d && !Number.isNaN(d.getTime()) ? d.toISOString() : null);
  }
  const depthById = new Map<number, number>();
  for (const r of queueDepths) {
    if (r.userId === null) continue;
    depthById.set(r.userId, Number(r.depth ?? 0));
  }

  const rows: AccountRow[] = slice.map((a) => ({
    id: a.id,
    label: accountLabel(a.id, a.name),
    state: accountState(a),
    paused_by_admin: a.pausedByAdmin,
    // Date only. `authDeadMessage()` renders the same day for the operator's
    // page; this seam sends the date itself so the Chief can age it.
    auth_dead_since: a.authDeadAt ? a.authDeadAt.toISOString().slice(0, 10) : null,
    // Already a closed vocabulary at write time (`classifyAuthReason()`), so
    // nothing an external system controls reaches this field.
    auth_dead_reason: a.authDeadAt ? a.authDeadReason : null,
    last_send_at: lastSendById.get(a.id) ?? null,
    queue_depth: depthById.get(a.id) ?? 0,
  }));

  return { rows, total };
}
