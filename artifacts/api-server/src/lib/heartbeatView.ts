/**
 * heartbeatView.ts — F-3.6a.
 *
 * Pure query parsing and output redaction for the cron-heartbeat read
 * endpoint. No DB, no network.
 *
 * `cron_heartbeats` has been written on every tick since Phase 7n and has
 * never been readable by anything. F-D4 could not answer "are the crons
 * firing right now" from any production surface for exactly that reason, and
 * had to fall back to inferring a tick from an LLM usage row. This closes it.
 *
 * WHY REDACTION IS NOT OPTIONAL
 *
 * `details` is jsonb written by the cron wrappers, and one of the things it
 * carries is `perUser[].ingestError` / `.replyError` — raw error text from
 * googleapis. A googleapis failure can serialise its request config, and a
 * request config carries `Authorization: Bearer ya29.…`. Nothing in the
 * write path stops that, so the read path must assume it happened.
 */

/** Default rows returned when the caller does not ask. */
export const DEFAULT_HEARTBEAT_LIMIT = 50;
/** Hard ceiling, whatever the caller asks for. */
export const MAX_HEARTBEAT_LIMIT = 200;
/** Longest tick-name filter accepted. Longer means a caller is probing. */
const MAX_TICK_NAME = 64;
/** How deep into `details` the redactor will walk. */
const MAX_DEPTH = 6;
/** Longest string kept in a redacted value. */
const MAX_STRING = 2000;
/** Most array entries kept per array. */
const MAX_ARRAY = 200;

export interface HeartbeatQuery {
  limit: number;
  tickName: string | null;
  since: Date | null;
  until: Date | null;
}

/**
 * Parse the query string. Garbage falls back to the default rather than
 * 400-ing: this is an observability endpoint, and an operator who mistypes
 * `limit` wants their heartbeats, not a lecture.
 */
export function parseHeartbeatQuery(query: Record<string, unknown>): HeartbeatQuery {
  return {
    limit: parseLimit(query.limit),
    tickName: parseTickName(query.tick ?? query.tickName),
    since: parseDate(query.since),
    until: parseDate(query.until),
  };
}

function parseLimit(raw: unknown): number {
  const n = parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_HEARTBEAT_LIMIT;
  return Math.min(n, MAX_HEARTBEAT_LIMIT);
}

function parseTickName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (!t || t.length > MAX_TICK_NAME) return null;
  return t;
}

function parseDate(raw: unknown): Date | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const d = new Date(String(raw));
  return isNaN(d.getTime()) ? null : d;
}

// ── Redaction ────────────────────────────────────────────────────────────

export const REDACTED = "[redacted]";

/**
 * Key names whose VALUE is replaced wholesale, whatever it looks like.
 * Matched on the key, case-insensitively, as a substring.
 */
const SENSITIVE_KEY = /(token|secret|password|passwd|authorization|auth_header|credential|api[-_]?key|apikey|private[-_]?key|cookie|session)/i;

/**
 * Token shapes replaced INSIDE any string value, wherever they appear.
 *
 * Ordered longest-context-first so `Bearer ya29.x` collapses to one marker
 * rather than leaving a dangling "Bearer".
 */
const TOKEN_PATTERNS: RegExp[] = [
  // Authorization header values, any scheme.
  /\b(?:Bearer|Basic|OAuth)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  // Google OAuth refresh tokens.
  /\b1\/\/[A-Za-z0-9_-]{10,}/g,
  // Google access tokens.
  /\bya29\.[A-Za-z0-9._-]{10,}/g,
  // JWTs / id_tokens.
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g,
  // Anything handed over in a query string or form body.
  /\b(?:access_token|refresh_token|id_token|client_secret|client_id|api_key|apikey|key)=[^&\s"']{6,}/gi,
  // Replit/Neon-style prefixed secrets.
  /\b(?:npg|sk|pk|ghp|gho|xoxb|xoxp)_[A-Za-z0-9_-]{12,}/g,
  // Postgres/AMQP-style URLs with inline credentials.
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@"']+:[^\s:/@"']+@/gi,
];

/** Replace every token shape found in a single string. */
export function redactString(input: string): string {
  let out = input;
  for (const re of TOKEN_PATTERNS) {
    // Fresh lastIndex per call — these are module-level /g regexes.
    re.lastIndex = 0;
    out = out.replace(re, REDACTED);
  }
  return out.length > MAX_STRING ? `${out.slice(0, MAX_STRING - 1)}…` : out;
}

/**
 * Walk a heartbeat `details` value and return a safe copy.
 *
 * Depth-, width- and length-bounded, so a serialised axios error cannot turn
 * one heartbeat row into a megabyte of response. Never throws: an
 * unserialisable value becomes a string marker.
 */
export function redactHeartbeatDetails(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null;

  if (depth >= MAX_DEPTH) return "[depth-limited]";

  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;

  if (Array.isArray(value)) {
    const kept = value.slice(0, MAX_ARRAY).map((v) => redactHeartbeatDetails(v, depth + 1));
    if (value.length > MAX_ARRAY) kept.push(`[${value.length - MAX_ARRAY} more truncated]`);
    return kept;
  }

  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redactHeartbeatDetails(v, depth + 1);
    }
    return out;
  }

  // Functions, symbols, bigints — nothing the cron writes, but be total.
  return String(value);
}
