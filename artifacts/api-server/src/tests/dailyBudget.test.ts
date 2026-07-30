/**
 * Tests for the pure daily-budget math. Uses node:test + node:assert to match
 * the rest of the suite (vitest is not a dependency in this repo). DB-free, so
 * it runs in the ship gate without a database connection.
 */
import * as test from "node:test";
import * as assert from "node:assert/strict";

import {
  startOfBudgetDayUtc,
  resolveCapUsd,
  DEFAULT_CAP_USD,
} from "../lib/dailyBudgetMath";

const TZ = "Asia/Jerusalem";

test.describe("startOfBudgetDayUtc (Asia/Jerusalem)", () => {
  test.it("summer / DST (UTC+3): midday maps to previous 21:00Z", () => {
    // 2026-06-21 12:00 Jerusalem == 09:00Z. Local midnight that day is
    // 2026-06-21 00:00 +03:00 == 2026-06-20T21:00:00Z.
    const now = new Date("2026-06-21T09:00:00Z");
    assert.strictEqual(
      startOfBudgetDayUtc(now, TZ).toISOString(),
      "2026-06-20T21:00:00.000Z",
    );
  });

  test.it("winter / standard (UTC+2): midday maps to previous 22:00Z", () => {
    // 2026-01-15 11:00 Jerusalem == 09:00Z. Local midnight is
    // 2026-01-15 00:00 +02:00 == 2026-01-14T22:00:00Z.
    const now = new Date("2026-01-15T09:00:00Z");
    assert.strictEqual(
      startOfBudgetDayUtc(now, TZ).toISOString(),
      "2026-01-14T22:00:00.000Z",
    );
  });

  test.it("exactly at local midnight returns that same instant", () => {
    const now = new Date("2026-06-20T21:00:00Z"); // 2026-06-21 00:00 +03:00
    assert.strictEqual(
      startOfBudgetDayUtc(now, TZ).toISOString(),
      "2026-06-20T21:00:00.000Z",
    );
  });

  test.it("one minute before local midnight still belongs to the prior day", () => {
    const now = new Date("2026-06-20T20:59:00Z"); // 2026-06-20 23:59 +03:00
    assert.strictEqual(
      startOfBudgetDayUtc(now, TZ).toISOString(),
      "2026-06-19T21:00:00.000Z",
    );
  });

  test.it("window start is always at or before now", () => {
    for (const iso of [
      "2026-03-28T01:30:00Z",
      "2026-10-25T00:30:00Z",
      "2026-07-04T23:59:59Z",
      "2026-12-31T22:00:01Z",
    ]) {
      const now = new Date(iso);
      assert.ok(startOfBudgetDayUtc(now, TZ).getTime() <= now.getTime());
    }
  });
});

test.describe("resolveCapUsd precedence and validation", () => {
  const ENV = "DOCTRINE_DAILY_BUDGET_USD";

  test.it("uses a valid app_settings value", () => {
    assert.strictEqual(resolveCapUsd("500"), 500);
    assert.strictEqual(resolveCapUsd("750.5"), 750.5);
  });

  test.it("falls back to the env override when the setting is absent", () => {
    const prev = process.env[ENV];
    process.env[ENV] = "1200";
    try {
      assert.strictEqual(resolveCapUsd(null), 1200);
      assert.strictEqual(resolveCapUsd(""), 1200);
    } finally {
      if (prev === undefined) delete process.env[ENV];
      else process.env[ENV] = prev;
    }
  });

  test.it("falls back to the hard default when nothing is set", () => {
    const prev = process.env[ENV];
    delete process.env[ENV];
    try {
      assert.strictEqual(resolveCapUsd(null), DEFAULT_CAP_USD);
      assert.strictEqual(resolveCapUsd(undefined), DEFAULT_CAP_USD);
    } finally {
      if (prev !== undefined) process.env[ENV] = prev;
    }
  });

  test.it("rejects zero, negative, and non-numeric values", () => {
    const prev = process.env[ENV];
    delete process.env[ENV];
    try {
      assert.strictEqual(resolveCapUsd("0"), DEFAULT_CAP_USD);
      assert.strictEqual(resolveCapUsd("-5"), DEFAULT_CAP_USD);
      assert.strictEqual(resolveCapUsd("abc"), DEFAULT_CAP_USD);
    } finally {
      if (prev !== undefined) process.env[ENV] = prev;
    }
  });
});
