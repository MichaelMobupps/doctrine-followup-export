/**
 * test-followup-limits.ts
 *
 * Hermetic tests for the rigid follow-up limits in lib/followupLimits.ts.
 * No database and no network: the pure helpers are exercised directly, the
 * same pattern test-admin-kill.ts and test-suppression.ts use.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx --test src/tests/test-followup-limits.ts
 */

import * as test from "node:test";
import * as assert from "node:assert/strict";

import {
  HARD_FOLLOWUP_CAP,
  CAMPAIGN_MAX_AGE_DAYS,
  effectiveFollowupCap,
  isCampaignExpired,
} from "../lib/followupLimits";

// ── The rigid cap ──────────────────────────────────────────────────

test.describe("effectiveFollowupCap", () => {
  test.it("clamps a stored value above the hard cap down to it", () => {
    assert.equal(effectiveFollowupCap(10), HARD_FOLLOWUP_CAP);
    assert.equal(effectiveFollowupCap(100), HARD_FOLLOWUP_CAP);
  });

  test.it("resolves the legacy unlimited value (0) to the hard cap", () => {
    assert.equal(effectiveFollowupCap(0), HARD_FOLLOWUP_CAP);
  });

  test.it("resolves a negative, null, or undefined value to the hard cap", () => {
    assert.equal(effectiveFollowupCap(-1), HARD_FOLLOWUP_CAP);
    assert.equal(effectiveFollowupCap(null), HARD_FOLLOWUP_CAP);
    assert.equal(effectiveFollowupCap(undefined), HARD_FOLLOWUP_CAP);
  });

  test.it("passes through a value at or below the cap", () => {
    assert.equal(effectiveFollowupCap(1), 1);
    assert.equal(effectiveFollowupCap(2), 2);
    assert.equal(effectiveFollowupCap(3), 3);
  });

  test.it("never returns null and never returns above the hard cap", () => {
    for (let v = -5; v <= 20; v++) {
      const cap = effectiveFollowupCap(v);
      assert.equal(typeof cap, "number");
      assert.ok(cap >= 1 && cap <= HARD_FOLLOWUP_CAP);
    }
  });
});

// ── The 30-day expiry boundary ─────────────────────────────────────

test.describe("isCampaignExpired", () => {
  const now = new Date("2026-06-09T00:00:00Z");
  const day = 24 * 60 * 60 * 1000;

  test.it("flags a campaign sent more than the max age ago", () => {
    const sent = new Date(now.getTime() - (CAMPAIGN_MAX_AGE_DAYS + 1) * day);
    assert.equal(isCampaignExpired(sent, now), true);
  });

  test.it("flags a campaign sent exactly the max age ago (inclusive boundary)", () => {
    const sent = new Date(now.getTime() - CAMPAIGN_MAX_AGE_DAYS * day);
    assert.equal(isCampaignExpired(sent, now), true);
  });

  test.it("does not flag a campaign sent inside the window", () => {
    const sent = new Date(now.getTime() - (CAMPAIGN_MAX_AGE_DAYS - 1) * day);
    assert.equal(isCampaignExpired(sent, now), false);
  });

  test.it("does not flag a campaign sent just now", () => {
    assert.equal(isCampaignExpired(now, now), false);
  });

  test.it("honors a custom max age", () => {
    const sent = new Date(now.getTime() - 5 * day);
    assert.equal(isCampaignExpired(sent, now, 3), true);
    assert.equal(isCampaignExpired(sent, now, 7), false);
  });
});
