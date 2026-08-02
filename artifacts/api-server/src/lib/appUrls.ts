/**
 * Single source of truth for this app's own public address and rooted paths.
 *
 * Bundle 1 (URL centralization) moves every hardcoded occurrence here WITHOUT
 * changing behavior. With neither BASE_PATH nor PUBLIC_URL set, every value
 * produced by this module is byte-for-byte identical to the string the call
 * site produced before centralization. Bundle 2 makes the two knobs live.
 *
 * Two distinct notions of "our address" exist in this codebase and they are
 * NOT interchangeable — collapsing them would be a behavior change:
 *
 *   publicOrigin()  The absolute origin used to build the OAuth redirect URIs
 *                   handed to Google. When unconfigured it falls back to the
 *                   Replit domain, because Google rejects a relative URI.
 *
 *   PUBLIC_URL      The configured origin, or "" when unconfigured. The login
 *                   callback prepends this to its redirects, so "" yields a
 *                   same-origin relative redirect. This is what auth.ts did
 *                   with `process.env.APP_URL?.replace(...) || ""`.
 */

/** Strip every trailing slash. `""` and `"/"` both normalize to `""`. */
function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * Mount prefix this app is served under, normalized to always start with "/"
 * and never end with one — EXCEPT the root case, which stays exactly "/".
 *
 * Default "/" reproduces today's behavior: every rooted path is emitted at the
 * server root.
 */
export const BASE_PATH: string = normalizeBasePath(process.env.BASE_PATH);

function normalizeBasePath(raw: string | undefined): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return "/";

  // Reject anything that is not a plain rooted path. A value like
  // "//evil.example" or "https://evil.example" would turn every joined path
  // into an off-site absolute URL — an open redirect reachable by whoever can
  // set the env var. Fail safe to "/" rather than propagate it.
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return "/";

  // Backslashes are NOT interchangeable with a literal path character here.
  // The WHATWG URL parser treats "\" as "/" for special schemes, so a base
  // path of "/\evil.example" makes `new URL("/\evil.example/accounts",
  // "https://good.example")` resolve to "https://evil.example/accounts" — an
  // open redirect that a leading-"//" check alone does not catch.
  if (trimmed.includes("\\")) return "/";

  // A control character (CR/LF/NUL/tab) in a Location header is a response
  // splitting vector.
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return "/";

  const stripped = stripTrailingSlashes(trimmed);
  return stripped === "" ? "/" : stripped;
}

/**
 * The configured public origin, without a trailing slash, or "" when neither
 * PUBLIC_URL nor APP_URL is set.
 *
 * PUBLIC_URL is the Bundle 2 knob; APP_URL is the name production already
 * uses (see `.replit` [userenv.shared]). Reading APP_URL as the fallback is
 * what makes this bundle a no-op: production keeps resolving to exactly the
 * address it resolves to today.
 */
export const PUBLIC_URL: string = normalizePublicUrl(
  process.env.PUBLIC_URL || process.env.APP_URL,
);

function normalizePublicUrl(raw: string | undefined): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return "";

  // Must be an absolute http(s) origin. Anything else — "//evil.example",
  // "javascript:…", a bare hostname, a control character — is rejected and
  // treated as unconfigured. Without this check a protocol-relative value
  // flows straight into redirectPath() and every login redirect lands
  // off-site: `res.redirect("//evil.example/?login_code=…")` sends the
  // browser (and the login code in the query string) to the attacker.
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return "";
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "";
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return "";

  // Bundle 2: PUBLIC_URL may now carry a path prefix
  // ("https://tools.mobupps.net/followup"), so return the PARSER'S canonical
  // form rather than the raw string. A raw "https://host/\evil" would keep its
  // backslash and re-open the Bundle 1 parser-divergence defect one level up;
  // parsed.href has already normalized it. For an origin-only value the href
  // gains a trailing "/", which stripTrailingSlashes removes — so the dark
  // path stays byte-for-byte identical.
  return stripTrailingSlashes(parsed.href);
}

/**
 * Absolute origin for outbound registrations (OAuth redirect URIs).
 *
 * Falls back to the Replit-provided domain exactly as the two getRedirectUri()
 * helpers did before centralization, because Google requires an absolute URI.
 *
 * Read at call time, not at module load: the previous helpers were functions,
 * and the Replit domain vars are injected by the platform. Freezing them at
 * import time would be a behavior change.
 */
export function publicOrigin(): string {
  // PUBLIC_URL is the operator-supplied PUBLIC BASE and already includes any
  // path prefix. Returning it verbatim is what keeps outgoing links at
  // exactly one prefix — appending BASE_PATH here would emit
  // ".../followup/followup/api/auth/callback".
  if (PUBLIC_URL) return PUBLIC_URL;

  const domain =
    process.env.REPLIT_DEV_DOMAIN ||
    process.env.REPLIT_DOMAINS?.split(",")[0] ||
    "localhost";
  const origin = `https://${domain}`;

  // No public base configured but the app IS mounted under a prefix: the
  // best available answer is our own domain plus that prefix. With BASE_PATH
  // "/" this appends nothing, so the dark path is unchanged.
  return BASE_PATH === "/" ? origin : `${origin}${BASE_PATH}`;
}

/**
 * Join the mount prefix to a rooted in-app path.
 *
 *   BASE_PATH "/"      + "/accounts" -> "/accounts"     (today's exact string)
 *   BASE_PATH "/email" + "/accounts" -> "/email/accounts"
 *
 * Security: the result is always a single-slash-rooted path. It can never be
 * protocol-relative ("//host", which browsers resolve as an absolute URL to a
 * foreign host) and never carries a scheme, so it cannot be used as an open
 * redirect. `path` is trusted-internal (a literal at every call site); the
 * guard below exists so that stays true if a caller ever passes something
 * else.
 */
export function appPath(path: string): string {
  const safe = safeRootedPath(path);
  if (BASE_PATH === "/") return safe;
  return safe === "/" ? BASE_PATH : `${BASE_PATH}${safe}`;
}

/**
 * Normalize an in-app path to exactly one leading "/", with NO prefix applied.
 *
 * Collapses a leading run of slashes AND backslashes. Without this,
 * "//x" is a protocol-relative URL, and "/\x" is one too — the WHATWG URL
 * parser reads "/\" as "//" for http(s), so "/\evil.example" resolves to
 * "https://evil.example". Every path that reaches an outgoing string goes
 * through here, including the ones that skip appPath() to avoid double
 * prefixing.
 */
function safeRootedPath(path: string): string {
  const rooted = path.startsWith("/") ? path : `/${path}`;
  return rooted.replace(/^[/\\]+/, "/");
}

/**
 * Is `pathname` the prefix itself, or beneath it?
 *
 * Compared on SEGMENT boundaries, never as a bare `startsWith`. "/followup"
 * is a prefix of the string "/followupper", so a substring test would claim
 * that a genuinely unprefixed route already lives under the mount and skip
 * the repair for it. The same class of bug bit Bundle 2's one-prefix oracle,
 * which counted "/followup" inside the real route "/followups".
 *
 * A `prefix` of "/" answers "everything is under it", which is the only
 * coherent reading of a root mount. That branch is NOT what keeps the dark
 * path inert — legacyRedirectTarget() returns early on BASE_PATH "/" and this
 * is never reached with it. Darkness lives at the caller; this is a correct
 * default so the function cannot mislead a future one.
 *
 * Module-private, like safeRootedPath: the only supported entry point is
 * legacyRedirectTarget(), so callers cannot make half a decision.
 */
function isUnderPrefix(pathname: string, prefix: string): boolean {
  if (prefix === "/") return true;
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * Repair L1 — where an unprefixed legacy request should be sent, or `null`
 * when it must be left exactly as it is.
 *
 * Three refusals, in order, and each one is load-bearing:
 *
 *   1. BASE_PATH "/" — the rule does not exist when the prefix is not active.
 *      Rollback is "unset the env vars", so this branch is what makes the
 *      rolled-back app byte-identical rather than merely similar.
 *   2. Already under the prefix — without this the rule matches its own
 *      target and every request becomes an infinite redirect. Bundle 2's
 *      bare-prefix redirect hit the sibling form of this trap.
 *   3. Under "/api" — the unprefixed API mount is FIRST-CLASS and must stay
 *      that way. It is what the Apps Script add-on, both Google OAuth
 *      callbacks and the platform startup health check call. Redirecting a
 *      POST is not equivalent to serving it: plenty of senders drop the body
 *      or the method on a 3xx, and a health check that 3xxs reads as
 *      unhealthy on some platforms.
 *
 * The path is normalized through safeRootedPath BEFORE the two membership
 * tests, not after. A caller that joins a trailing-slash base URL to a rooted
 * path sends "//api/sync"; tested raw, that fails the "/api" test and this
 * rule would 308 it to "/followup//api/sync".
 *
 * Be precise about what the normalization does and does NOT buy. "//api/sync"
 * still 404s: Express does not match a doubled slash to the "/api" mount, and
 * it 404s identically on main and in dark mode, so that is pre-existing rather
 * than something this rule introduces (recorded in TODO.md Open items). What
 * the normalization prevents is converting that honest 404 into a redirect
 * pointing even further from the mount the caller was aiming at.
 */
export function legacyRedirectTarget(pathname: string): string | null {
  if (BASE_PATH === "/") return null;

  const rooted = safeRootedPath(pathname);
  if (isUnderPrefix(rooted, BASE_PATH)) return null;
  if (isUnderPrefix(rooted, "/api")) return null;

  return `${BASE_PATH}${rooted}`;
}

/**
 * Absolute URL to a rooted in-app path, built on the outbound origin.
 * Used for values handed to third parties (Google OAuth redirect URIs).
 */
export function publicUrl(path: string): string {
  // safeRootedPath, NOT appPath: publicOrigin() already carries the prefix
  // (either from PUBLIC_URL, which the operator sets to the full public base,
  // or from the BASE_PATH suffix added in the fallback branch). Using
  // appPath() here would apply the prefix a second time and emit
  // "https://tools.mobupps.net/followup/followup/api/auth/callback".
  return `${publicOrigin()}${safeRootedPath(path)}`;
}

/**
 * Path for a same-app redirect issued by the server (`res.redirect`).
 *
 * Prefixed with PUBLIC_URL when it is configured, matching what the login
 * callback did with its `dashboardBase` local; relative otherwise.
 *
 * The two branches use different path helpers on purpose:
 *   - PUBLIC_URL set   -> safeRootedPath, because PUBLIC_URL already carries
 *                         the prefix. appPath() would double it.
 *   - PUBLIC_URL unset -> appPath, because a relative Location must carry the
 *                         prefix itself or the browser resolves it at the
 *                         server root and leaves the mounted app.
 *
 * With BASE_PATH "/" the two are the same function, which is why the dark
 * path is unchanged. Either way the result can never begin with "//".
 */
export function redirectPath(path: string): string {
  return PUBLIC_URL ? `${PUBLIC_URL}${safeRootedPath(path)}` : appPath(path);
}
