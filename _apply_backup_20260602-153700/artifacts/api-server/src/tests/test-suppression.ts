/**
 * test-suppression.ts
 *
 * Unit tests for the pure helper in the suppression module. The db-backed
 * functions are integration-tested against the live database; here we lock
 * the normalization contract that keys the whole list.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx --test src/tests/test-suppression.ts
 */

import * as test from "node:test";
import * as assert from "node:assert/strict";

import { normalizeEmail } from "../lib/emailNormalize";

test.describe("normalizeEmail", () => {
  test.it("lowercases and trims", () => {
    assert.equal(normalizeEmail("  Sanjay.Sri@Shinhan.COM "), "sanjay.sri@shinhan.com");
  });
  test.it("empty and null-ish are empty", () => {
    assert.equal(normalizeEmail(""), "");
    assert.equal(normalizeEmail("   "), "");
  });
  test.it("leaves a clean address unchanged", () => {
    assert.equal(normalizeEmail("ops@mobupps.com"), "ops@mobupps.com");
  });
});
