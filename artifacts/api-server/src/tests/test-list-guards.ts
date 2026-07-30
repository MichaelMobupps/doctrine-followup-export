/**
 * test-list-guards.ts
 *
 * Hermetic tests for the 2026-07-16 main-screen-hang fix in lib/listGuards.ts:
 * the pure narrowing-param decision that decides whether a list request may
 * proceed. An unfiltered GET /api/followups used to return EVERY user's
 * follow-ups with full email bodies (up to 50k rows) in one synchronous
 * res.json(), freezing the requesting tab and the server's event loop.
 *
 * The DB-dependent multi-user probe is exercised by the live smoke check
 * (unfiltered request → 400 on a multi-user install); these tests lock the
 * pure contract only. No DB, no network.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx --test src/tests/test-list-guards.ts
 */

import * as test from "node:test";
import * as assert from "node:assert/strict";

import { hasNarrowingParam } from "../lib/listGuards";

test.describe("hasNarrowingParam", () => {
  test.it("false for a fully unfiltered query", () => {
    assert.equal(hasNarrowingParam({}, ["userId", "status"]), false);
  });

  test.it("true when userId is present (dashboard pipeline path)", () => {
    assert.equal(hasNarrowingParam({ userId: "7" }, ["userId", "status"]), true);
  });

  test.it("true when status is present (add-on queued path)", () => {
    assert.equal(hasNarrowingParam({ status: "queued" }, ["userId", "status"]), true);
  });

  test.it("true when email is present (context per-thread path)", () => {
    assert.equal(hasNarrowingParam({ email: "p@x.com" }, ["userId", "email"]), true);
  });

  test.it("replied=0 counts as a narrower (add-on homepage path)", () => {
    // The value "0" is falsy-looking but a real filter — must count.
    assert.equal(hasNarrowingParam({ replied: "0" }, ["userId", "vertical", "replied"]), true);
  });

  test.it("empty-string params do not count as narrowers", () => {
    assert.equal(hasNarrowingParam({ userId: "" }, ["userId", "status"]), false);
  });

  test.it("includeArchived is a widener, never a narrower", () => {
    assert.equal(hasNarrowingParam({ includeArchived: "1" }, ["userId", "status"]), false);
  });

  test.it("params outside the route's narrower list are ignored", () => {
    assert.equal(hasNarrowingParam({ foo: "bar" }, ["userId", "status"]), false);
  });
});
