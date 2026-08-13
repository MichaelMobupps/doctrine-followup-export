/**
 * googleApi.ts — F-3.7b.
 *
 * The only place in this codebase that constructs a Google client, so that the
 * one thing every Google call needs cannot be forgotten at a call site: a
 * request timeout.
 *
 * WHY THIS FILE EXISTS
 *
 * "No googleapis request timeouts anywhere (a hung socket can still stall a
 * pass; wedge watchdog now bounds the damage to 4h)" — recorded as a known
 * unfixed gap by the 2026-07-16 sync-starvation order, and still true until
 * now. googleapis sets no default deadline of its own, so a socket that opens
 * and then goes quiet hangs the caller until the peer or the kernel gives up,
 * which can be many minutes or never.
 *
 * That is not a theoretical hazard here. It is the failure the F-3.7b wedge
 * watchdog exists to survive, and a watchdog cannot honestly claim to reclaim
 * a wedged pass while the thing that wedges it is unbounded — it would only be
 * trading a permanent hang for a periodic one.
 *
 * TWO SURFACES, BOTH REQUIRED
 *
 * A Gmail call is two HTTP requests, not one, and they are made by two
 * different stacks:
 *
 *   1. The API request itself (`gmail.users.messages.send`, ...) travels via
 *      googleapis -> gaxios -> node-fetch. `timeout` on the service options is
 *      merged into every request (googleapis-common apirequest.js merges
 *      google-level, per-API and per-method options) and node-fetch rejects
 *      with a `request-timeout` FetchError when it expires.
 *
 *   2. The OAuth token refresh, which google-auth-library makes on its OWN
 *      transporter before the API request goes out. Service options do not
 *      reach it. It is bounded through `transporterOptions`, which the client
 *      assigns to `transporter.defaults`, and gaxios merges its defaults into
 *      every request it makes.
 *
 * Bounding only the first would leave the more dangerous half unbounded: a
 * hung token refresh stalls the row before the API call is ever attempted.
 *
 * THE VALUE
 *
 * 30 seconds, for both surfaces. Every call this app makes to Google is a
 * small JSON request — a label list, a message get, a send, a token refresh —
 * and the healthy latency is tens to hundreds of milliseconds. 30s is roughly
 * a hundred times the healthy case, so it cannot fire on a merely slow network,
 * and it is well inside every budget layered above it: a row's 180s generation
 * deadline, and the 10-minute no-progress wedge limit that assumes a row's
 * Gmail calls are individually bounded.
 *
 * This is per REQUEST, not per pass. A sync pass legitimately makes thousands
 * of requests and may run for many minutes; nothing here shortens that.
 */

import { google, gmail_v1, oauth2_v2, Auth } from "googleapis";

// google-auth-library is not a direct dependency of this package; googleapis
// re-exports it as `Auth`, which keeps the type accurate without adding one.
type OAuth2Client = Auth.OAuth2Client;

/** Per-request deadline for every Google call, both surfaces. See the header. */
export const GOOGLE_API_TIMEOUT_MS = 30_000;

/**
 * An OAuth2 client whose token-refresh transporter is bounded.
 *
 * The options-object constructor form is required: `transporterOptions` has no
 * positional equivalent, and the positional form this codebase used before is
 * exactly the form that leaves the refresh unbounded.
 */
export function newGoogleOAuthClient(redirectUri?: string): OAuth2Client {
  return new google.auth.OAuth2({
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    ...(redirectUri ? { redirectUri } : {}),
    transporterOptions: { timeout: GOOGLE_API_TIMEOUT_MS },
  });
}

/** A Gmail client whose every API request is bounded. */
export function newGmailClient(auth: OAuth2Client): gmail_v1.Gmail {
  return google.gmail({ version: "v1", auth, timeout: GOOGLE_API_TIMEOUT_MS });
}

/**
 * The userinfo client used to resolve who just completed an OAuth consent.
 *
 * It is a googleapis service like any other and gets the same bound: it sits
 * in the middle of the connect flow, where an unbounded hang would leave the
 * operator staring at a browser tab that never returns.
 */
export function newOAuth2InfoClient(auth: OAuth2Client): oauth2_v2.Oauth2 {
  return google.oauth2({ version: "v2", auth, timeout: GOOGLE_API_TIMEOUT_MS });
}
