/**
 * chiefView.ts — F-3.7a. Everything the Chief uplink puts on the wire, shaped
 * by pure functions.
 *
 * No db, no express, no network, no `process.env`. The handlers in
 * `routes/chief.ts` read the numbers; this file decides what they look like as
 * JSON. That split is what lets the identity discipline, the state precedence
 * and the 64 KB page ceiling be tested against fixtures rather than asserted in
 * prose.
 *
 * ── WHY A LABEL IS NEVER AN EMAIL ADDRESS ────────────────────────────────────
 *
 * F-3.6b established that this app's accounts are real people's mailboxes and
 * that their addresses do not travel. The Chief is another app on another host
 * with another database and another operator console; handing it twelve
 * corporate email addresses so that a card can say who is auth-dead would be a
 * data transfer nobody asked for and nobody could take back.
 *
 * So `accountLabel()` is total and it fails CLOSED: anything that could BE an
 * address — anything containing `@` — is discarded in favour of a positional
 * label. `users.name` is operator-supplied and is, in practice, sometimes the
 * address itself.
 *
 * A regex on the way out is not the guarantee; the label rule is. `containsEmail()`
 * exists as a second, independent check over the FINISHED payload so that the
 * property is structural rather than conventional — see `routes/chief.ts`.
 */

import { CHIEF_CONTRACT_VERSION } from "./chiefAuth";

// ── Account identity ─────────────────────────────────────────────────────────

/** Longest label put on the wire. Bounds the page-size math below. */
export const MAX_LABEL_CHARS = 64;

/**
 * Something that looks like an email address, anywhere in a string.
 *
 * ONE implementation, three consumers: the label rule, the outbound payload
 * guard, and the smoke's leak grep over every captured response body. Three
 * copies of this predicate is how one of them ends up laxer than the others.
 *
 * Deliberately permissive about what counts as an address (a bare
 * `a@b.co` matches) — a false positive here costs a label, and a false negative
 * costs a person's address.
 */
export const EMAIL_LIKE = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;

/** Does this text contain something that reads as an email address? */
export function containsEmail(text: string): boolean {
  // Fresh test each call; EMAIL_LIKE carries no /g flag, so there is no
  // lastIndex to reset and no cross-call state to leak.
  return EMAIL_LIKE.test(text);
}

/**
 * The label one account is known by on this seam.
 *
 * Precedence, and each fallback is deliberate:
 *
 *  1. `users.name`, when it is non-empty, carries no `@`, and survives control
 *     -character stripping. This is the operator's own word for the person and
 *     is what makes the page readable.
 *  2. `Account <id>` otherwise. Positional, stable across restarts, and enough
 *     to correlate with this app's own admin surface — which is where an
 *     operator goes to act on the finding anyway.
 *
 * Control characters are stripped, not escaped: the value ends up in the
 * Chief's console and in log lines, and a `\n` in a label is a forged log line.
 */
export function accountLabel(id: number, name: string | null | undefined): string {
  const cleaned = String(name ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return `Account ${id}`;
  if (containsEmail(cleaned)) return `Account ${id}`;
  // A bare `@` is not an address but is still the shape of one; refuse it too
  // rather than reasoning about which halves of an address are harmless.
  if (cleaned.includes("@")) return `Account ${id}`;
  return cleaned.length > MAX_LABEL_CHARS ? cleaned.slice(0, MAX_LABEL_CHARS) : cleaned;
}

// ── Account state ────────────────────────────────────────────────────────────

/**
 * The four honest states of an account on this seam.
 *
 * PREMISE REFINEMENT, recorded here because it is where the decision lives.
 * The order names three — `connected | auth_dead | paused`. This app has four
 * distinguishable conditions, because `is_connected` and `auth_dead_at` are
 * different facts (F-3.6a: a withdrawn grant is not a refused one) and
 * `paused_by_admin` is orthogonal to both. Collapsing `disconnected` into
 * `paused` would report an operator decision where there is none, and
 * collapsing it into `auth_dead` would invent a Google refusal that never
 * happened. So the set is four, and the contract says so.
 */
export type ChiefAccountState = "connected" | "auth_dead" | "paused" | "disconnected";

/** The account fields the state decision reads. */
export interface AccountStateFields {
  isConnected: boolean;
  authDeadAt: Date | string | null | undefined;
  pausedByAdmin: boolean;
}

/**
 * Resolve one account's state.
 *
 * PRECEDENCE, and the ordering is the whole point:
 *
 *   disconnected  — there is no grant at all. Nothing else can be true of an
 *                   account Google was never asked about.
 *   auth_dead     — OUTRANKS `paused`. This is the state that sat unnoticed for
 *                   ten days in early August and the reason this endpoint
 *                   exists; an admin pause must never be allowed to hide it.
 *   paused        — an operator stopped this account deliberately.
 *   connected     — none of the above.
 *
 * Because `auth_dead` outranks `paused`, a single state string cannot say that
 * an account is BOTH. `paused_by_admin` therefore rides alongside it on every
 * row (see `AccountRow`), so nothing is lost — the state is the headline, the
 * boolean is the detail.
 */
export function accountState(u: AccountStateFields): ChiefAccountState {
  if (!u.isConnected) return "disconnected";
  if (u.authDeadAt) return "auth_dead";
  if (u.pausedByAdmin) return "paused";
  return "connected";
}

/** One account as it appears on the wire. Every field is a closed shape. */
export interface AccountRow {
  id: number;
  label: string;
  state: ChiefAccountState;
  /** True independently of `state`, so an auth-dead pause is fully described. */
  paused_by_admin: boolean;
  /** Date only (`YYYY-MM-DD`). An instant implies a precision the 15-minute tick does not have. */
  auth_dead_since: string | null;
  /** Closed vocabulary from `classifyAuthReason()`; never raw provider text. */
  auth_dead_reason: string | null;
  /** The last follow-up this account actually sent, ISO-8601, or null. */
  last_send_at: string | null;
  /** Follow-ups sitting in `queued` for this account's live campaigns. */
  queue_depth: number;
}

// ── Paging ───────────────────────────────────────────────────────────────────

/**
 * The byte ceiling this page is packed to.
 *
 * The Chief refuses a response over 64 KB as the bytes arrive
 * (`appClient.ts MAX_RESPONSE_BYTES`) and reports it as `bad_response` — a card
 * that reads "unreachable" for an app that answered perfectly. 48 KB leaves a
 * quarter of the budget as headroom for the two things this process does not
 * control: the platform's own headers, and any future additive field.
 *
 * It is enforced by MEASURING the encoded page, not by trusting a row-count
 * estimate. A label is bounded, so an estimate would be sound today — and would
 * quietly stop being sound the first time someone adds a field.
 */
export const ACCOUNTS_PAGE_BYTE_BUDGET = 48 * 1024;

/** Rows requested when the caller does not ask. */
export const DEFAULT_ACCOUNTS_LIMIT = 50;
/** Hard ceiling on `limit`, whatever the caller asks for. */
export const MAX_ACCOUNTS_LIMIT = 200;

export interface AccountsPageQuery {
  limit: number;
  offset: number;
}

/**
 * Parse the paging query.
 *
 * Garbage falls back to the default rather than 400-ing, matching
 * `parseHeartbeatQuery()`: this is an observability endpoint and a caller that
 * mistypes `limit` wants its accounts, not a lecture. The Chief's client sends
 * neither parameter today, so every value here comes from a human with curl.
 */
export function parseAccountsQuery(query: Record<string, unknown>): AccountsPageQuery {
  return {
    limit: parseBounded(query.limit, DEFAULT_ACCOUNTS_LIMIT, 1, MAX_ACCOUNTS_LIMIT),
    offset: parseBounded(query.offset, 0, 0, Number.MAX_SAFE_INTEGER),
  };
}

function parseBounded(raw: unknown, fallback: number, min: number, max: number): number {
  const n = parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return fallback;
  return Math.min(n, max);
}

export interface AccountsPageBody {
  app: string;
  server_time: string;
  page: {
    limit: number;
    offset: number;
    returned: number;
    total: number;
    /** Where the next request should start, or null when this is the last page. */
    next_offset: number | null;
  };
  accounts: AccountRow[];
}

/**
 * Pack as many of `rows` into one page as the byte budget allows.
 *
 * The rows handed in are already the SQL `LIMIT`/`OFFSET` slice. This function
 * can only ever return FEWER, never more, and when it does it says so through
 * `next_offset` — so a caller that follows `next_offset` walks the whole set
 * whatever the budget did. A page that drops rows silently and reports the
 * requested count is the failure this shape exists to make impossible.
 *
 * Measured, not estimated: the envelope is re-serialised on each step, so the
 * count digits growing from `9` to `10` cannot push a page one byte over.
 */
export function packAccountsPage(args: {
  rows: AccountRow[];
  limit: number;
  offset: number;
  total: number;
  serverTime: string;
  appName: string;
  byteBudget?: number;
}): AccountsPageBody {
  const budget = args.byteBudget ?? ACCOUNTS_PAGE_BYTE_BUDGET;
  const accounts: AccountRow[] = [];

  const build = (): AccountsPageBody => {
    const returned = accounts.length;
    const consumed = args.offset + returned;
    return {
      app: args.appName,
      server_time: args.serverTime,
      page: {
        limit: args.limit,
        offset: args.offset,
        returned,
        total: args.total,
        next_offset: consumed < args.total ? consumed : null,
      },
      accounts,
    };
  };

  for (const row of args.rows) {
    accounts.push(row);
    if (Buffer.byteLength(JSON.stringify(build()), "utf8") > budget) {
      accounts.pop();
      break;
    }
  }

  // The envelope's own counters shrink as rows come off, so a single trailing
  // check is enough — but loop anyway rather than reason about it, since the
  // cost is one serialisation of a page that is already at the ceiling.
  let body = build();
  while (
    accounts.length > 0 &&
    Buffer.byteLength(JSON.stringify(body), "utf8") > budget
  ) {
    accounts.pop();
    body = build();
  }
  return body;
}

// ── Status ───────────────────────────────────────────────────────────────────

/** One cron tick's liveness, as the status endpoint reports it. */
export interface CronPulse {
  tick_name: string;
  last_fired_at: string | null;
  /** Seconds since that tick last fired. Null when it has never fired. */
  age_seconds: number | null;
  ticks_24h: number;
  errors_24h: number;
}

/** The census the health summary is built from. */
export interface AccountCensus {
  connected: number;
  auth_dead: number;
  paused: number;
  disconnected: number;
  total: number;
}

export interface ChiefStatusFacts {
  /** Every vendor, this UTC day, in USD. The figure the card renders. */
  spendTodayUsd: number;
  /** Start of the current UTC day, for the reader who wants to reconcile it. */
  utcDayStart: Date;
  census: AccountCensus;
  /** Follow-ups eligible for the next processing pass. */
  dueQueueDepth: number;
  crons: CronPulse[];
  /** The app-wide sending switch (`app_settings.global_pause`). */
  sendingPausedGlobally: boolean;
  /** This app's OWN budget day — a different window from the UTC one above. */
  budgetDay: {
    timeZone: string;
    windowStartUtc: Date;
    spentUsd: number;
    capUsd: number;
    enabled: boolean;
    exceeded: boolean;
  };
  now: Date;
}

/**
 * What this app can and cannot do on this seam, stated rather than implied.
 *
 * THIS IS THE ANSWER TO `accepting_jobs`, AND IT IS WHY THAT FIELD IS ABSENT.
 *
 * The Chief's card reads six optional fields and renders a dash for any it does
 * not receive (`src/probe.ts readStatus()`, `fields_present`). Two of the six —
 * `accepting_jobs` and `active_jobs` — presuppose an app that takes jobs. This
 * app takes none: there is no inbound command seam, and v1 of this order
 * deliberately does not add one. Sending `accepting_jobs: false` would render
 * as "accepting jobs: no", which an operator reads as "normally yes, currently
 * no" — a temporary condition somebody should go fix. Sending `true` would
 * advertise a seam that does not exist.
 *
 * Omission is not a gap here, it is the designed way to say "that question does
 * not apply to me": the Chief built `fields_present` precisely to distinguish a
 * field that was not sent from a field that was sent as zero. So the two fields
 * are omitted and the real answer travels in this object instead.
 */
export interface ChiefCapabilities {
  /** No inbound command seam exists. The Chief cannot cause work here. */
  accepts_jobs: false;
  /** Read-only health, this endpoint and `/api/chief/accounts`. */
  health_pulse: true;
  /** This app reports its own spend to the Chief; the Chief never pushes. */
  spend_reporting: "outbound";
  /** No Chief-commanded write of any kind: no enrol, no pause, no send. */
  chief_writes: false;
  /** Reply/sentiment data is deliberately not on this seam (a later order). */
  reply_intelligence: false;
}

export const CHIEF_CAPABILITIES: Readonly<ChiefCapabilities> = Object.freeze({
  accepts_jobs: false,
  health_pulse: true,
  spend_reporting: "outbound",
  chief_writes: false,
  reply_intelligence: false,
});

export interface ChiefStatusBody {
  app: string;
  ok: true;
  version: string;
  server_time: string;
  /** All vendors, this UTC day. The one number the Chief's card renders. */
  spend_today_usd: number;
  capabilities: ChiefCapabilities;
  health: {
    accounts: AccountCensus;
    due_queue_depth: number;
    sending_paused_globally: boolean;
    /** The worst per-tick age — the "oldest heartbeat". Null when nothing has ever fired. */
    oldest_heartbeat_age_seconds: number | null;
    crons: CronPulse[];
  };
  budget: {
    /** The window `spend_today_usd` is measured over. */
    utc_day_start: string;
    /**
     * This app's own budget day, which is NOT the UTC day: the daily cap runs
     * on local midnight in `time_zone` (default Asia/Jerusalem). Both windows
     * are reported because they genuinely differ by up to three hours, and an
     * operator reconciling the card against this app's admin surface needs to
     * know which one they are looking at.
     */
    app_budget_day: {
      time_zone: string;
      window_start_utc: string;
      spent_usd: number;
      cap_usd: number;
      enabled: boolean;
      exceeded: boolean;
    };
  };
}

/** How many cron pulses may appear. The tick set is closed and currently 10. */
export const MAX_CRON_PULSES = 50;

/** Shape the status body. Pure: every number is handed in. */
export function buildStatusBody(facts: ChiefStatusFacts, appName: string): ChiefStatusBody {
  const crons = facts.crons.slice(0, MAX_CRON_PULSES);
  const ages = crons
    .map((c) => c.age_seconds)
    .filter((a): a is number => typeof a === "number");
  return {
    app: appName,
    ok: true,
    version: CHIEF_CONTRACT_VERSION,
    server_time: facts.now.toISOString(),
    spend_today_usd: round6(facts.spendTodayUsd),
    capabilities: CHIEF_CAPABILITIES,
    health: {
      accounts: facts.census,
      due_queue_depth: facts.dueQueueDepth,
      sending_paused_globally: facts.sendingPausedGlobally,
      oldest_heartbeat_age_seconds: ages.length > 0 ? Math.max(...ages) : null,
      crons,
    },
    budget: {
      utc_day_start: facts.utcDayStart.toISOString(),
      app_budget_day: {
        time_zone: facts.budgetDay.timeZone,
        window_start_utc: facts.budgetDay.windowStartUtc.toISOString(),
        spent_usd: round6(facts.budgetDay.spentUsd),
        cap_usd: facts.budgetDay.capUsd,
        enabled: facts.budgetDay.enabled,
        exceeded: facts.budgetDay.exceeded,
      },
    },
  };
}

/**
 * Six decimals — the precision `followup_usage.cost_usd` is stored at
 * (`numeric(12,6)`). Rounding here rather than at the reader keeps the wire
 * figure identical to the stored one instead of carrying float residue from a
 * SUM into somebody else's console.
 */
function round6(usd: number): number {
  if (!Number.isFinite(usd)) return 0;
  return Math.round(usd * 1_000_000) / 1_000_000;
}

/** Seconds between two instants, floored at zero and rounded. */
export function ageSeconds(now: Date, then: Date | null): number | null {
  if (!then) return null;
  return Math.max(0, Math.round((now.getTime() - then.getTime()) / 1000));
}

/** Start of the UTC day containing `now`. The window every spend report uses. */
export function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** `YYYY-MM-DD` in UTC — the day key in a spend report's `external_id`. */
export function utcDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}
