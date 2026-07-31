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

  return stripTrailingSlashes(trimmed);
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
  if (PUBLIC_URL) return PUBLIC_URL;
  const domain =
    process.env.REPLIT_DEV_DOMAIN ||
    process.env.REPLIT_DOMAINS?.split(",")[0] ||
    "localhost";
  return `https://${domain}`;
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
  const rooted = path.startsWith("/") ? path : `/${path}`;

  // Collapse a leading run of slashes AND backslashes to one "/". Without
  // this, appPath("//x") emits a protocol-relative URL, and appPath("/\\x")
  // emits one too — the WHATWG URL parser reads "/\" as "//" for http(s),
  // so "/\evil.example" resolves to "https://evil.example".
  const safe = rooted.replace(/^[/\\]+/, "/");

  if (BASE_PATH === "/") return safe;
  return safe === "/" ? BASE_PATH : `${BASE_PATH}${safe}`;
}

/**
 * Absolute URL to a rooted in-app path, built on the outbound origin.
 * Used for values handed to third parties (Google OAuth redirect URIs).
 */
export function publicUrl(path: string): string {
  return `${publicOrigin()}${appPath(path)}`;
}

/**
 * Path for a same-app redirect issued by the server (`res.redirect`).
 *
 * Prefixed with PUBLIC_URL when it is configured, matching what the login
 * callback did with its `dashboardBase` local; relative otherwise. Because the
 * path half always comes from appPath(), the relative form can never begin
 * with "//".
 */
export function redirectPath(path: string): string {
  return `${PUBLIC_URL}${appPath(path)}`;
}
