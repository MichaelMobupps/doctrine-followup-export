/**
 * test-admin-access.ts
 *
 * Hermetic unit tests for the pure admin-gate helpers + the requireAdmin
 * middleware. No DB, no network. These lock the security contract:
 *   - admin status is decided ONLY from the verified email vs ADMIN_EMAILS;
 *   - an unset ADMIN_API_KEY fails closed (nobody is admin, no empty token);
 *   - the admin token is never an empty string;
 *   - requireAdmin returns 500 when unset, 403 on missing/wrong header, and
 *     calls next() only on the exact key.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx --test src/tests/test-admin-access.ts
 */

import * as test from "node:test";
import * as assert from "node:assert/strict";

import {
  parseAdminEmails,
  isAdminEmail,
  resolveAdminGrant,
} from "../lib/adminAccess";
import { requireAdmin } from "../middlewares/requireAdmin";

test.describe("parseAdminEmails", () => {
  test.it("returns [] for null/undefined/empty", () => {
    assert.deepEqual(parseAdminEmails(null), []);
    assert.deepEqual(parseAdminEmails(undefined), []);
    assert.deepEqual(parseAdminEmails(""), []);
    assert.deepEqual(parseAdminEmails("   "), []);
  });
  test.it("splits, trims, lowercases, drops empties", () => {
    assert.deepEqual(
      parseAdminEmails(" A@x.com, B@Y.com ,, c@z.com "),
      ["a@x.com", "b@y.com", "c@z.com"],
    );
  });
});

test.describe("isAdminEmail", () => {
  const list = "admin@x.com, boss@y.com";
  test.it("true for a listed email (case/space-insensitive)", () => {
    assert.equal(isAdminEmail("admin@x.com", list), true);
    assert.equal(isAdminEmail("  ADMIN@X.com ", list), true);
    assert.equal(isAdminEmail("Boss@Y.com", list), true);
  });
  test.it("false for an unlisted email", () => {
    assert.equal(isAdminEmail("nobody@x.com", list), false);
  });
  test.it("false for empty/missing email or empty list", () => {
    assert.equal(isAdminEmail("", list), false);
    assert.equal(isAdminEmail(null, list), false);
    assert.equal(isAdminEmail(undefined, list), false);
    assert.equal(isAdminEmail("admin@x.com", ""), false);
    assert.equal(isAdminEmail("admin@x.com", null), false);
  });
});

test.describe("resolveAdminGrant", () => {
  const key = "super-secret-admin-key";
  const list = "admin@x.com";

  test.it("issues the admin token for a listed email when the key is set", () => {
    const g = resolveAdminGrant("admin@x.com", list, key);
    assert.equal(g.isAdmin, true);
    assert.equal(g.adminToken, key);
  });

  test.it("non-admin email gets isAdmin=false and NO token field", () => {
    const g = resolveAdminGrant("nobody@x.com", list, key);
    assert.equal(g.isAdmin, false);
    assert.equal(g.adminToken, undefined);
  });

  test.it("fails closed when ADMIN_API_KEY is unset — even for a listed email", () => {
    for (const missing of [undefined, null, "", "   "]) {
      const g = resolveAdminGrant("admin@x.com", list, missing as any);
      assert.equal(g.isAdmin, false, `unset=${JSON.stringify(missing)}`);
      assert.equal(g.adminToken, undefined);
      // The token is NEVER an empty string that could match an empty header.
      assert.notEqual(g.adminToken, "");
    }
  });

  test.it("a client-controlled email not in the list never becomes admin", () => {
    // Simulates an attacker asserting an arbitrary email — only the
    // server-verified email reaches this function, but even so a non-listed
    // value is rejected.
    assert.equal(resolveAdminGrant("attacker@evil.com", list, key).isAdmin, false);
  });
});

// Minimal Express req/res doubles for the middleware.
function makeReq(headers: Record<string, string | undefined>): any {
  return { headers };
}
function makeRes(): any {
  const res: any = {
    statusCode: 0,
    body: undefined,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
  };
  return res;
}

test.describe("requireAdmin middleware", () => {
  const KEY = "the-admin-key";
  const ORIGINAL = process.env.ADMIN_API_KEY;

  test.afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = ORIGINAL;
  });

  test.it("500 when ADMIN_API_KEY is unset (fails closed, never checks header)", () => {
    delete process.env.ADMIN_API_KEY;
    const res = makeRes();
    let nexted = false;
    // Even with a header present, an unset key 500s rather than matching.
    requireAdmin(makeReq({ "x-admin-key": "" }), res, () => { nexted = true; });
    assert.equal(res.statusCode, 500);
    assert.equal(nexted, false);
  });

  test.it("403 when the header is missing", () => {
    process.env.ADMIN_API_KEY = KEY;
    const res = makeRes();
    let nexted = false;
    requireAdmin(makeReq({}), res, () => { nexted = true; });
    assert.equal(res.statusCode, 403);
    assert.equal(nexted, false);
  });

  test.it("403 when the header is wrong", () => {
    process.env.ADMIN_API_KEY = KEY;
    const res = makeRes();
    let nexted = false;
    requireAdmin(makeReq({ "x-admin-key": "nope" }), res, () => { nexted = true; });
    assert.equal(res.statusCode, 403);
    assert.equal(nexted, false);
  });

  test.it("403 when the header is an empty string (no empty-match bypass)", () => {
    process.env.ADMIN_API_KEY = KEY;
    const res = makeRes();
    let nexted = false;
    requireAdmin(makeReq({ "x-admin-key": "" }), res, () => { nexted = true; });
    assert.equal(res.statusCode, 403);
    assert.equal(nexted, false);
  });

  test.it("calls next() on the exact key", () => {
    process.env.ADMIN_API_KEY = KEY;
    const res = makeRes();
    let nexted = false;
    requireAdmin(makeReq({ "x-admin-key": KEY }), res, () => { nexted = true; });
    assert.equal(nexted, true);
    assert.equal(res.statusCode, 0);
  });
});