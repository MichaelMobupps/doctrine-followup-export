/**
 * test-legacy-redirect-http.ts
 *
 * Repair L1b — pin the STATUS CODE of the legacy → prefix redirect.
 *
 * Why this file exists as its own thing. `test-base-path.ts` covers the
 * decision (`legacyRedirectTarget`), but that function returns a PATH: it
 * cannot see which status `app.ts` sends with it. So the two ways this repair
 * can silently regress were both invisible to the gate:
 *
 *   - back to 308, reintroducing the permanent, client-cached redirect that
 *     an env-unset rollback cannot reach (the reason L1a existed);
 *   - to 302, which lets a client rewrite a POST into a GET — the redirect
 *     would still "work" in a browser address bar and quietly drop the body
 *     of anything else.
 *
 * Neither shows up in a path assertion, so this file asserts over real HTTP
 * against the real app.
 *
 * It is deliberately NOT merged into `test-base-path.ts`, whose header
 * promises "No DB, no network" — booting Express there would make that promise
 * false for every case in it.
 *
 * Hermetic despite booting the app:
 *   - env is set BEFORE the app is imported, and the import is DYNAMIC —
 *     a static import is hoisted and would run before these assignments,
 *     leaving appUrls to read the ambient environment instead;
 *   - `DATABASE_URL` is a deliberately unroutable dummy. `@workspace/db`
 *     throws at import when it is unset, and `app.ts` pulls in the whole
 *     router tree, so a value is required — but the pool is lazy and none of
 *     the paths exercised here query. If one ever did, this fails loudly
 *     rather than quietly reading production data;
 *   - `NODE_ENV=production` suppresses the `pino-pretty` transport, which is
 *     a worker thread that can outlive the test and hang the runner. Be
 *     precise about the reach of that: `logger.ts` is the only place OUR code
 *     reads `NODE_ENV`, but Express reads it too (`app.get("env")`), so this
 *     also switches off dev-mode stack traces in the default error page.
 *     Nothing here asserts on that page, and running the pin closer to
 *     production is the right bias for a test whose whole job is to pin
 *     production behavior;
 *   - port 0, so it can never contend with the running workflow.
 *
 * Safe by construction: `app.ts` does not call `startCronJobs()` — that lives
 * in `index.ts` — so booting it dispatches no email.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx --test src/tests/test-legacy-redirect-http.ts
 */
import * as test from "node:test";
import * as assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

process.env.BASE_PATH = "/followup/";
process.env.PUBLIC_URL = "https://tools.mobupps.net/followup";
process.env.DATABASE_URL = "postgresql://l1b:l1b@127.0.0.1:1/none-this-test-never-queries";
process.env.NODE_ENV = "production";
process.env.LOG_LEVEL = "silent";

const { default: app } = await import("../app");

/** Every request the server received, in order, including redirect follow-ups. */
const seen: string[] = [];

const server = http.createServer(app);
// prependListener, so the recorder runs BEFORE the app handles the request.
server.prependListener("request", (req) => seen.push(`${req.method} ${req.url}`));

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

test.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

/** A path that exists at neither the legacy nor the prefixed address. */
const PROBE = "/l1b-probe";
const BODY = JSON.stringify({ k: "v" });
const JSON_HEADERS = { "content-type": "application/json" };

test.describe("repair L1b: the legacy redirect's status code, over real HTTP", () => {
  test.it("a POST to a legacy path answers 307 — not 302, not 308", async () => {
    const res = await fetch(`${base}${PROBE}?q=1`, {
      method: "POST",
      redirect: "manual",
      headers: JSON_HEADERS,
      body: BODY,
    });

    assert.equal(
      res.status,
      307,
      "308 is permanent and caches keep it, so an env-unset rollback cannot " +
        "reach it; 302 lets a client downgrade the POST to a GET and drop the " +
        "body. 307 is the only status that is both temporary and " +
        "method-preserving.",
    );
    assert.equal(res.headers.get("location"), `/followup${PROBE}?q=1`);
  });

  test.it("the POST arrives at the prefixed path STILL a POST", async () => {
    // The status code is a promise to the client; this checks the promise is
    // kept end to end. A regression to 302 makes the second hop a GET, which
    // a status assertion alone would not describe.
    seen.length = 0;

    await fetch(`${base}${PROBE}?q=1`, {
      method: "POST",
      redirect: "follow",
      headers: JSON_HEADERS,
      body: BODY,
    });

    assert.deepEqual(seen, [`POST ${PROBE}?q=1`, `POST /followup${PROBE}?q=1`]);
  });

  test.it("a GET legacy path answers 307 as well — the rule is not method-specific", async () => {
    const res = await fetch(`${base}${PROBE}?x=2`, { redirect: "manual" });
    assert.equal(res.status, 307);
    assert.equal(res.headers.get("location"), `/followup${PROBE}?x=2`);
  });

  test.it("an /api path is SERVED, never redirected", async () => {
    // The exclusion that makes any redirect here safe. The Apps Script add-on,
    // both Google OAuth callbacks and the platform startup health check all
    // address the unprefixed /api form; turning those into a 3xx is the one
    // change to this middleware that would break machine callers.
    //
    // Asserted as "not a redirect" rather than a specific code, so the case
    // does not depend on whether ADDON_API_KEY is present in the environment.
    const res = await fetch(`${base}/api${PROBE}`, {
      method: "POST",
      redirect: "manual",
      headers: JSON_HEADERS,
      body: BODY,
    });

    assert.ok(
      res.status < 300 || res.status >= 400,
      `/api must reach its handler, not a redirect; got ${res.status} -> ${res.headers.get("location")}`,
    );
  });
});
