/**
 * Single source of truth for the dashboard's mount prefix and API URLs.
 *
 * Bundle 1 (URL centralization) replaces 65 inline copies of
 * `import.meta.env.BASE_URL || "/"` with the constants below WITHOUT changing
 * behavior. Vite substitutes `import.meta.env.BASE_URL` at build time from the
 * `base` option, which `vite.config.ts` already reads from `process.env.BASE_PATH`
 * (default "/"). So with no env var set every value here is byte-for-byte what
 * the inline expressions produced.
 *
 * NOTE: the generated API client (`@workspace/api-client-react`) does NOT go
 * through this module — it emits rooted `/api/...` paths and ignores the
 * prefix. Wiring it up via its existing `setBaseUrl()` is a Bundle 2 item,
 * recorded in TODO.md.
 */

/**
 * Mount prefix, always with a trailing slash ("/" or "/email/").
 *
 * Vite normalizes `base` to start and end with "/", so callers append
 * WITHOUT a leading slash: `${BASE_PATH}api/stats`. That is the convention
 * every existing call site already uses, preserved verbatim.
 */
export const BASE_PATH: string = import.meta.env.BASE_URL || "/";

/**
 * Prefix for wouter's `<Router base>`, which wants no trailing slash
 * (root becomes ""). Mirrors the previous inline
 * `import.meta.env.BASE_URL.replace(/\/$/, "")` in App.tsx.
 */
export const ROUTER_BASE: string = BASE_PATH.replace(/\/$/, "");

/**
 * Build a URL for an API route.
 *
 * Accepts either convention and normalizes: `apiUrl("/api/stats")` and
 * `apiUrl("api/stats")` both yield `${BASE_PATH}api/stats`.
 *
 * Security: BASE_PATH ends with "/" and every leading slash AND backslash of
 * `path` is stripped before joining, so the result can never start with "//"
 * — nor with "/\", which the WHATWG URL parser also reads as "//" for http(s)
 * and would resolve against a foreign host instead of this origin.
 */
export function apiUrl(path: string): string {
  return `${BASE_PATH}${path.replace(/^[/\\]+/, "")}`;
}
