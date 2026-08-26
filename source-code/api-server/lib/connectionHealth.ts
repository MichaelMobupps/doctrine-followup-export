/**
 * connectionHealth.ts — F-3.6a.
 *
 * The pure state machine for a Gmail account's connection health. No DB, no
 * network, no imports from @workspace/db, so the whole contract is testable
 * hermetically (that package throws at import unless DATABASE_URL is set).
 *
 * WHY A THIRD STATE EXISTS
 *
 * Until F-3.6a there were two: connected and disconnected. Google refusing a
 * refresh token produced NEITHER — the sync logged the failure, set
 * `authFailure: true` in a heartbeat nobody could read, and left
 * `is_connected` true. On 2026-08-09 six of twelve "connected" accounts were
 * in that state: the dashboard showed CONNECTED, the auto-queue kept
 * generating, and 196 follow-ups were produced that could never be sent —
 * 75% of the week's LLM spend (F-D4).
 *
 * So: `auth_dead` is its own state. It is NOT a disconnect — the grant still
 * exists and the refresh token is preserved (discarding it would destroy the
 * evidence and force a support conversation about what was lost). It is not
 * "connected" either, because it cannot send.
 */

/** What the operator is told, and what the scheduler branches on. */
export type ConnectionState = "connected" | "auth_dead" | "disconnected";

/** The three columns that decide the state. */
export interface ConnectionFields {
  isConnected: boolean;
  authDeadAt?: Date | string | null;
}

/**
 * Resolve the state.
 *
 * Precedence is deliberate: an explicit disconnect WINS over auth-dead. A
 * user who pressed Disconnect has no grant at all, so reporting "dead since
 * <date> — reconnect" over the top of that would be noise. The disconnect
 * route clears the auth-dead columns for the same reason.
 */
export function connectionState(user: ConnectionFields): ConnectionState {
  if (!user.isConnected) return "disconnected";
  return user.authDeadAt ? "auth_dead" : "connected";
}

/** True when this account must not generate, queue or send. */
export function isHeldByAuth(user: ConnectionFields): boolean {
  return connectionState(user) === "auth_dead";
}

/**
 * What one sync pass proved about one user's grant.
 *
 * The three-way split is load-bearing. "Not an auth error" is NOT the same
 * as "the grant works": a pass can fail on a database write, a summarizer
 * outage or a malformed message without Gmail ever being asked. Treating
 * those as health would clear a genuinely dead grant and put the account
 * straight back into the burn loop this order exists to stop.
 *
 *   auth_failure — isAuthError() matched: invalid_grant / invalid_client /
 *                  unauthorized_client. Never a 5xx, never a quota error, so
 *                  a Gmail outage cannot mark an account dead.
 *   healthy      — Gmail answered. Positive proof the grant is good.
 *   inconclusive — something else went wrong, or nothing was attempted.
 *                  Changes nothing in either direction.
 */
export type AuthSignal = "auth_failure" | "healthy" | "inconclusive";

/**
 * The transition. Six cases, and only two of them write:
 *
 *   healthy-state + auth_failure  → mark dead now.
 *   dead-state    + auth_failure  → NO WRITE. The first date is the useful
 *                                   one — "dead since 2026-07-31" is
 *                                   actionable, "dead since four minutes ago"
 *                                   is not — and rewriting it every 15
 *                                   minutes would churn the row forever.
 *   dead-state    + healthy       → clear. A false positive self-heals on the
 *                                   next tick, having cost zero sends.
 *   dead-state    + inconclusive  → NO WRITE. Stays dead.
 *   healthy-state + healthy       → NO WRITE.
 *   healthy-state + inconclusive  → NO WRITE.
 */
export interface AuthTransition {
  /** True when the caller must persist authDeadAt/authDeadReason. */
  changed: boolean;
  authDeadAt: Date | null;
  authDeadReason: string | null;
}

export function nextAuthState(args: {
  currentAuthDeadAt: Date | string | null | undefined;
  signal: AuthSignal;
  reason?: string | null;
  now: Date;
}): AuthTransition {
  const current = toDate(args.currentAuthDeadAt);
  const currentlyDead = current !== null;
  const noWrite: AuthTransition = {
    changed: false,
    authDeadAt: current,
    authDeadReason: null,
  };

  if (args.signal === "auth_failure") {
    if (currentlyDead) return noWrite;
    return {
      changed: true,
      authDeadAt: args.now,
      authDeadReason: classifyAuthReason(args.reason),
    };
  }

  if (args.signal === "healthy" && currentlyDead) {
    return { changed: true, authDeadAt: null, authDeadReason: null };
  }

  return noWrite;
}

/**
 * Reduce one user's sync outcome to a signal.
 *
 * Health is claimed only when the ingest phase completed — that phase always
 * calls Gmail, so its completion is proof the grant was accepted. A reply-scan
 * error alone is inconclusive: that phase can fail on the summarizer or the
 * database long after Gmail has already answered.
 */
export function signalFromSyncOutcome(outcome: {
  authFailure?: boolean;
  ingestError?: string;
  replyError?: string;
}): AuthSignal {
  if (outcome.authFailure) return "auth_failure";
  if (outcome.ingestError) return "inconclusive";
  return "healthy";
}

/**
 * Does this error mean "Google refuses the grant"?
 *
 * Moved here from gmailSync.ts in F-3.6a so that the sync pass, the
 * deploy-time probe and the tests all share ONE predicate — three copies of a
 * security-relevant regex is how they drift. Behaviour is byte-identical to
 * the version that shipped with the per-user sync hardening.
 *
 * Deliberately narrow: it must never match a 5xx, a timeout or a quota
 * error, because marking a healthy account dead stops that person's
 * follow-ups. The three tokens below are the only ones Google uses to say
 * the refresh token itself is no longer honoured.
 */
export function isAuthError(err: unknown): boolean {
  const msg =
    err instanceof Error
      ? `${err.message} ${safeJson((err as { response?: { data?: unknown } }).response?.data)}`
      : String(err);
  return /invalid_grant|invalid_client|unauthorized_client/i.test(msg);
}

/**
 * Serialise a provider error payload for matching.
 *
 * Circular-safe by construction rather than by try/catch. googleapis errors
 * routinely carry a `response` whose `config`/`request` reference each other,
 * and both naive alternatives are wrong:
 *
 *   - a bare JSON.stringify THROWS on the cycle, and it is called inside the
 *     sync's own catch block, so the throw escapes and takes the rest of that
 *     user's pass with it (the shape this predicate inherited);
 *   - falling back to String(v) yields "[object Object]", which silently
 *     LOSES the nested `error: "unauthorized_client"` — the account then
 *     stays "connected" and keeps burning generations, which is the exact
 *     failure F-3.6a exists to end.
 *
 * The seen-set drops repeat references and keeps every first-visit value, so
 * the token survives.
 */
function safeJson(v: unknown): string {
  if (v === undefined || v === null) return "";
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(v, (_key, value) => {
      if (typeof value === "object" && value !== null) {
        if (seen.has(value as object)) return "[circular]";
        seen.add(value as object);
      }
      return value;
    }) ?? "";
  } catch {
    // BigInt, a throwing getter, anything else exotic. Never let a predicate
    // in an error path become a second error.
    return String(v);
  }
}

/**
 * Reduce a provider error string to the grant-failure class it names.
 *
 * Stored and displayed, so it is deliberately a closed vocabulary plus a
 * bounded fallback rather than the raw provider text: an unbounded string
 * from an external system has no business being rendered into an operator's
 * page, however it is escaped.
 */
export function classifyAuthReason(raw?: string | null): string {
  const text = (raw ?? "").toLowerCase();
  if (text.includes("unauthorized_client")) return "unauthorized_client";
  if (text.includes("invalid_grant")) return "invalid_grant";
  if (text.includes("invalid_client")) return "invalid_client";
  if (text.includes("deleted_client")) return "deleted_client";
  return "auth_rejected";
}

/**
 * The sentence the operator reads, in plain words, on the Accounts page and
 * in the accounts API. Date only — an exact timestamp implies a precision
 * the 15-minute tick does not have.
 */
export function authDeadMessage(since: Date | string | null | undefined): string | null {
  const d = toDate(since);
  if (!d) return null;
  const day = d.toISOString().slice(0, 10);
  return `Gmail connection dead since ${day} — reconnect`;
}

function toDate(v: Date | string | null | undefined): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return isNaN(d.getTime()) ? null : d;
}
