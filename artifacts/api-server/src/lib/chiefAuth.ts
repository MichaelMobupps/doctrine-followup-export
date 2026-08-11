/**
 * chiefAuth.ts — F-3.7a. The inbound order-token gate for the Chief's uplink.
 *
 * The Chief's FLIGHT deck probes each app through `FOLLOWUP_URL` +
 * `FOLLOWUP_TOKEN`. This module is the app side of that token: it decides
 * whether a request carries it, and nothing else.
 *
 * Deliberately dependency-free — `node:crypto` and nothing more. No express at
 * runtime (the express types below are erased at build), no db, no logger. That
 * is what lets the whole auth contract be exercised hermetically, and it is
 * also why this module can be mounted ahead of every other gate in the app.
 *
 * THREE PROPERTIES, AND WHY EACH IS LOAD-BEARING
 *
 *  1. THE SCHEME IS CASE-SENSITIVE. `Bearer ` matches; `bearer ` does not.
 *     This mirrors the Chief's own inbound rule (CONTRACT.md §3,
 *     `appFromBearer()`) rather than inventing a second convention for the same
 *     secret. Two ends of one seam should agree about what a valid header is.
 *
 *  2. THE COMPARISON IS CONSTANT-TIME. `crypto.timingSafeEqual` over byte
 *     buffers, with an explicit byte-length check first because it throws on a
 *     length mismatch. Token LENGTH stays observable through timing; the
 *     Chief's CONTRACT.md §10 records the same caveat about its own comparison
 *     and it is irrelevant at the recommended fixed length (`openssl rand -hex
 *     32`).
 *
 *  3. THE 401 IS ONE FIXED BODY. Missing header, wrong scheme, wrong token,
 *     unset secret, unknown path under the mount — every one of them produces
 *     byte-identical bytes. A caller who cannot authenticate learns that it
 *     cannot authenticate and learns nothing else. In particular the 401 is
 *     never an oracle for WHICH half of the check failed, nor for which paths
 *     exist under `/api/chief`.
 *
 * The token is compared and discarded. It is never logged, never echoed, never
 * reflected in a status, a header or a body.
 */

import crypto from "crypto";

/**
 * This app's name in the Chief's closed identity set — `leadfinder`,
 * `prospector`, `followup`, `chat` (CONTRACT.md §3, `src/util.ts AppName`).
 *
 * A constant, not config: an app can only ever report as itself, and the Chief
 * resolves identity from the token rather than from anything we send. This is
 * `followup`, NOT `followuper` — C-3.2b renamed it to match the gateway path
 * vocabulary and left no fallback.
 */
export const APP_NAME = "followup" as const;

/**
 * The version string this seam reports.
 *
 * It names the ORDER that last changed the contract, not a release: this repo
 * has no release versioning (`package.json` has said `0.0.0` since the first
 * commit), and a fabricated semver would be less true than the order id an
 * operator can actually grep for in `TODO.md`. Bump it in the order that
 * changes the wire shape, and nowhere else.
 */
export const CHIEF_CONTRACT_VERSION = "f-3.7a" as const;

/** The scheme prefix, matched CASE-SENSITIVELY. `bearer …` is a 401. */
const BEARER = "Bearer ";

/**
 * The environment variable holding the inbound order-token.
 *
 * Named for what it is from this side: the token the Chief presents to THIS
 * app. Its value must equal the Chief's own `FOLLOWUP_TOKEN`, which the Chief
 * uses in BOTH directions (CONTRACT.md §7 marks it `both`) — see
 * `chiefTokenMismatchWarning()` for the boot check that catches half a seam.
 */
export const INBOUND_TOKEN_VAR = "FOLLOWUP_CHIEF_TOKEN";

/**
 * The order-token this app accepts, or null when there is none to accept.
 *
 * Trimmed, and empty-after-trim counts as UNSET — the identical rule the
 * outbound half applies to its copy of the same secret, and the one the Chief
 * applies to its own (CONTRACT.md §7: a `TOKEN=" "` behaves as unset). Matching
 * all three means an operator can never end up with a token that authenticates
 * in one direction and not the other.
 *
 * Read per request rather than latched at module load. Nothing is gained by
 * caching a string, and a latch would make the endpoint's behaviour depend on
 * when the process happened to start relative to a secret being set.
 */
export function chiefTokenFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const token = (env[INBOUND_TOKEN_VAR] || "").trim();
  return token === "" ? null : token;
}

/**
 * Does this `Authorization` header carry the order-token?
 *
 * Returns false — never throws — for every malformed input, so this can never
 * be the reason a request 500s. An auth check that can throw is an auth check
 * that can answer 500, and a 500 says more than a 401 does.
 *
 * The presented value is trimmed after the scheme, matching the Chief
 * (CONTRACT.md §3: "everything after the first 7 characters is trimmed"). Both
 * sides of the comparison are therefore trimmed, so a secret pasted with a
 * trailing newline at one end still authenticates instead of failing forever
 * with no diagnostic beyond a 401.
 */
export function isAuthorisedChiefRequest(
  authorizationHeader: string | undefined | string[],
  expected: string | null,
): boolean {
  if (!expected) return false;
  // Express hands back `string | string[] | undefined`. A duplicated
  // Authorization header arrives as an array, and concatenating it would let a
  // caller smuggle a second value past the scheme check.
  if (typeof authorizationHeader !== "string") return false;
  if (!authorizationHeader.startsWith(BEARER)) return false;

  const presented = Buffer.from(authorizationHeader.slice(BEARER.length).trim(), "utf8");
  const want = Buffer.from(expected, "utf8");
  // timingSafeEqual throws on a length mismatch, so the check has to happen
  // either way. Doing it on the BUFFERS rather than the strings is what makes
  // it correct for a non-ASCII value.
  if (presented.length !== want.length) return false;
  try {
    return crypto.timingSafeEqual(presented, want);
  } catch {
    /* Equal lengths were just checked, so this is unreachable. Total anyway. */
    return false;
  }
}

/**
 * The ONE 401 body. Frozen so a future edit cannot mutate the shared object
 * into a per-case message by accident.
 *
 * The wording is the Chief's own (CONTRACT.md §3) because it is the same token
 * family, and somebody debugging one end of this seam should not have to learn
 * two vocabularies.
 */
export const UNAUTHORISED_BODY = Object.freeze({ error: "valid order-token required" });

/**
 * 503, never a fabricated 200.
 *
 * Every number this seam reports is read from the database, and a read can
 * fail. Answering `ok: true` with a spend of zero and an all-healthy account
 * census would tell the Chief this app is fine at the exact moment it cannot
 * see whether it is — which is the failure mode the whole uplink exists to end.
 * 5xx is the class the Chief already treats as "ask again later"
 * (CONTRACT.md §5).
 */
export const UNAVAILABLE_BODY = Object.freeze({ error: "status unavailable" });

/**
 * The boot-time warning for the one misconfiguration that gives an operator
 * half a working seam, or null when there is nothing to say.
 *
 * The Chief holds ONE secret per app and uses it in both directions
 * (CONTRACT.md §7: `FOLLOWUP_TOKEN` … `both`). This app reads it under two
 * names — `FOLLOWUP_CHIEF_TOKEN` inbound, `CHIEF_INGEST_TOKEN` outbound —
 * because the order names them separately, and two names for one value is
 * exactly the shape that ends with the status card live and spend reporting
 * silently 401-ing, or the reverse.
 *
 * Deliberately a WARNING and not a refusal: neither half is wrong on its own
 * (an operator may legitimately wire one direction first), and refusing to boot
 * over a reporting misconfiguration would take down sending. The Chief makes
 * the same trade for its own duplicate-token case and says so.
 *
 * The values themselves never appear in the returned string.
 */
export function chiefTokenMismatchWarning(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const inbound = (env[INBOUND_TOKEN_VAR] || "").trim();
  const outbound = (env.CHIEF_INGEST_TOKEN || "").trim();

  if (!inbound && !outbound) return null;
  if (inbound && !outbound) {
    return `${INBOUND_TOKEN_VAR} is set but CHIEF_INGEST_TOKEN is not — the Chief can read this app's status, but this app cannot report its spend. Both must hold the Chief's FOLLOWUP_TOKEN.`;
  }
  if (!inbound && outbound) {
    return `CHIEF_INGEST_TOKEN is set but ${INBOUND_TOKEN_VAR} is not — this app can report spend, but every status probe from the Chief will be answered 401. Both must hold the Chief's FOLLOWUP_TOKEN.`;
  }
  if (inbound !== outbound) {
    return `${INBOUND_TOKEN_VAR} and CHIEF_INGEST_TOKEN hold DIFFERENT values. The Chief holds one token per app and uses it in both directions, so at most one of these two can be right and one half of the seam is dead.`;
  }
  return null;
}
