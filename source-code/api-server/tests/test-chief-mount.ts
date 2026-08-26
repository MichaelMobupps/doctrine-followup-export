/**
 * test-chief-mount.ts — F-3.7a.
 *
 * ONE property, and it is invisible everywhere else: the Chief uplink is
 * reachable with an order-token ALONE.
 *
 * `routes/doctrine.ts` calls `router.use(authMiddleware)` at its top level and
 * `routes/index.ts` mounts it with no path, so the shared `x-api-key` /
 * `ADDON_API_KEY` gate applies to everything that reaches that line — which is
 * why every admin router below it needs two keys. The Chief holds an
 * order-token and nothing else and will never send `x-api-key`.
 *
 * Moving `router.use("/chief", …)` below `router.use(doctrineRouter)` passes
 * typecheck, passes every unit test of the handlers, and turns the Chief's card
 * into `token rejected` for ever. Nothing but a booted app can see it, so this
 * file boots one.
 *
 * It also pins the second thing only a booted app can see: the uplink answers
 * under the gateway prefix as well as at the root, because `app.ts` mounts the
 * `/api` router twice and `FOLLOWUP_URL` will carry `/followup`.
 *
 * Hermetic despite booting the app, by the same four measures
 * `test-legacy-redirect-http.ts` documents: env set before a DYNAMIC import,
 * an unroutable dummy `DATABASE_URL` (the pool is lazy; a 503 here proves the
 * request got past every gate and reached a reader, which is exactly the
 * assertion), `NODE_ENV=production` + `LOG_LEVEL=silent` so the `pino-pretty`
 * worker cannot outlive the run, and port 0.
 *
 * Safe by construction: `app.ts` does not call `startCronJobs()` — that lives in
 * `index.ts` — so booting it dispatches no email and starts no sweep.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx --test src/tests/test-chief-mount.ts
 */
import * as test from "node:test";
import * as assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

process.env.BASE_PATH = "/followup";
process.env.PUBLIC_URL = "https://followupper.mobupps.net/followup";
process.env.DATABASE_URL = "postgresql://f37a:f37a@127.0.0.1:1/none-this-test-never-queries";
process.env.NODE_ENV = "production";
process.env.LOG_LEVEL = "silent";
process.env.FOLLOWUP_CHIEF_TOKEN = TOKEN;
// Deliberately SET, and deliberately different from the token above, so that a
// request carrying only this one proves nothing about the chief mount.
process.env.ADDON_API_KEY = "addon-key-for-this-test-only";
// Never read by these paths; set so that a misroute into an admin router would
// 403 rather than 500 and would therefore be obvious in the assertion below.
process.env.ADMIN_API_KEY = "admin-key-for-this-test-only";

const { default: app } = await import("../app");

const server = http.createServer(app);
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as AddressInfo).port;

test.after(() => {
  server.close();
});

async function get(path: string, headers: Record<string, string> = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
  return { status: res.status, text: await res.text(), cache: res.headers.get("cache-control") };
}

const AUTH = { authorization: `Bearer ${TOKEN}` };

for (const base of ["/api/chief", "/followup/api/chief"]) {
  test.describe(`the uplink at ${base}`, () => {
    test.it("is NOT behind the shared x-api-key gate", async () => {
      // The failure this pins: `{"error":"Invalid API key"}` with status 401.
      // A 503 is the pass — it means auth succeeded and a reader was reached,
      // and the reader is the unroutable dummy database.
      const r = await get(`${base}/status`, AUTH);
      assert.notEqual(r.text, '{"error":"Invalid API key"}');
      assert.equal(r.status, 503, `expected the reader to be reached, got ${r.status} ${r.text}`);
      assert.equal(r.text, '{"error":"status unavailable"}');
      assert.equal(r.cache, "no-store");
    });

    test.it("answers its OWN 401, not the addon's, for a bad order-token", async () => {
      const r = await get(`${base}/status`, { authorization: "Bearer nope" });
      assert.equal(r.status, 401);
      assert.equal(r.text, '{"error":"valid order-token required"}');
      assert.equal(r.cache, "no-store");
    });

    test.it("is not opened by the addon key", async () => {
      // An ADDON_API_KEY holder is every sales manager with the Gmail add-on.
      // They must not be able to read the fleet health page.
      const r = await get(`${base}/accounts`, { "x-api-key": "addon-key-for-this-test-only" });
      assert.equal(r.status, 401);
      assert.equal(r.text, '{"error":"valid order-token required"}');
    });

    test.it("serves accounts on the same terms", async () => {
      const r = await get(`${base}/accounts`, AUTH);
      assert.equal(r.status, 503);
      assert.equal(r.text, '{"error":"status unavailable"}');
    });
  });
}

test.describe("the rest of the app is untouched", () => {
  test.it("the addon gate still guards a doctrine route", async () => {
    const r = await get("/api/stats");
    assert.equal(r.status, 401);
    assert.equal(r.text, '{"error":"Invalid API key"}');
  });

  test.it("an order-token does NOT open a doctrine route", async () => {
    // The uplink's token is scoped to `/api/chief` and nothing else. If the gate
    // had been mounted app-wide rather than on the prefix, this would 500 or 200.
    const r = await get("/api/stats", AUTH);
    assert.equal(r.status, 401);
    assert.equal(r.text, '{"error":"Invalid API key"}');
  });

  test.it("the platform health check still answers without any key", async () => {
    const r = await get("/api/healthz");
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.text), { status: "ok" });
  });
});
