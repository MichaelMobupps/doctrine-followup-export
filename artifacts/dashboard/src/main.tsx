import { createRoot } from "react-dom/client";
import { setBaseUrl } from "@workspace/api-client-react";
import App from "./App";
import { BASE_PATH, ROUTER_BASE } from "./lib/app-urls";
import "./index.css";

/**
 * Repair L1: land on the prefixed app when the browser opened the legacy
 * unprefixed address.
 *
 * The problem this solves is silent. After the cutover the platform still
 * serves this exact index.html at the unprefixed root — verified in
 * production: `https://followupper.mobupps.net/` returns a page byte-identical
 * to `https://tools.mobupps.net/followup/`. Its assets resolve, this bundle
 * executes, and then wouter mounts with `base="/followup"` against a location
 * of "/". Nothing matches, nothing renders, and the user gets a blank page
 * with a clean 200 and no console error.
 *
 * A server-side redirect cannot reach this case: those paths are answered by
 * the dashboard's own static artifact and never touch Express.
 *
 * Runs BEFORE createRoot so the router never mounts at the wrong base — a
 * post-mount fix would still flash the empty shell and let the app fire its
 * first API calls against the wrong prefix.
 *
 * @returns true when a navigation was started and rendering must be skipped.
 */
function redirectLegacyAddress(): boolean {
  // Dark path. BASE_PATH is substituted at BUILD time from Vite's `base`, so
  // a build made with the env unset compiles this to the constant "/" and the
  // whole function is dead weight. Rollback stays byte-identical.
  if (BASE_PATH === "/") return false;

  const { pathname, search, hash } = window.location;

  // Segment-boundary test, not startsWith(ROUTER_BASE): "/followupper" starts
  // with "/followup" while being a genuinely unprefixed path, and skipping it
  // would leave exactly the blank page this exists to prevent. BASE_PATH
  // carries the trailing slash, so it already tests the boundary; the bare
  // form needs its own equality check.
  if (pathname === ROUTER_BASE || pathname.startsWith(BASE_PATH)) return false;

  // ROUTER_BASE has no trailing slash and `pathname` always has a leading one,
  // so the join is single-slashed and, being rooted at a non-empty prefix
  // segment, can never be read as protocol-relative ("//host") — it stays on
  // this origin whatever the path contains.
  //
  // `search` and `hash` are carried verbatim: the login callback hands back
  // "?login_code=..." and dropping it turns a working login into a silent
  // bounce to the sign-in screen.
  //
  // replace(), not assign(): the legacy URL must not stay in history, or Back
  // returns the user to the blank page and traps them in it.
  window.location.replace(`${ROUTER_BASE}${pathname}${search}${hash}`);
  return true;
}

if (!redirectLegacyAddress()) {
  // Bundle 2: teach the generated API client about the mount prefix.
  //
  // The Orval-generated hooks emit rooted paths ("/api/stats", …) and must not
  // be hand-edited, but custom-fetch already ships a runtime setter: it prepends
  // the base URL to any request whose path starts with "/". This one call is
  // what makes those hooks prefix-aware.
  //
  // ROUTER_BASE is "" when BASE_PATH is unset, and setBaseUrl("") stores null —
  // the exact state the module already holds by default — so with no env var set
  // the client behaves as it did before this bundle.
  setBaseUrl(ROUTER_BASE);

  createRoot(document.getElementById("root")!).render(<App />);
}
