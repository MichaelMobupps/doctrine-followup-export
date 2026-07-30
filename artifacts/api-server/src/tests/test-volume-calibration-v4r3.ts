/**
 * test-volume-calibration-v4r3.ts
 *
 * Test suite for the v4 Round-3 volume calibration module.
 * Mirrors the Prospector test_volume_calibration_v4r3.py structure.
 *
 * Run with:
 *   pnpm --filter @workspace/api-server exec tsx --test tests/test-volume-calibration-v4r3.ts
 */

import * as test from "node:test";
import * as assert from "node:assert/strict";

import {
  FUNNEL_DEPTH_MULTIPLIERS,
  MARKET_SCALE_TIERS,
  MARKET_TIER_MULTIPLIERS,
  VERTICAL_BASE_INSTALL_FLOOR,
  DEFAULT_FUNNEL_MULTIPLIER,
  DEFAULT_MARKET_TIER,
  DEFAULT_VERTICAL_FLOOR,
  getFunnelMultiplier,
  getMarketTier,
  getMarketMultiplier,
  getVerticalBaseFloor,
  computeVolumeFloor,
  computeVolumeCeiling,
  isVolumePlausible,
  isFunnelCoherent,
  extractVolumeClaims,
} from "../lib/volumeCalibration";


// ============================================================================
// 1. FUNNEL MULTIPLIERS
// ============================================================================

test.test("v4r3 funnel: install is top-of-funnel (1.0)", () => {
  assert.equal(getFunnelMultiplier("install"), 1.0);
});

test.test("v4r3 funnel: install normalized case", () => {
  assert.equal(getFunnelMultiplier("Install"), 1.0);
  assert.equal(getFunnelMultiplier("INSTALL"), 1.0);
});

test.test("v4r3 funnel: first_deposit is deep (0.10)", () => {
  assert.equal(getFunnelMultiplier("first_deposit"), 0.10);
  assert.equal(getFunnelMultiplier("First Deposit"), 0.10);
  assert.equal(getFunnelMultiplier("first-deposit"), 0.10);
});

test.test("v4r3 funnel: purchase is mid-deep (0.15)", () => {
  assert.equal(getFunnelMultiplier("purchase"), 0.15);
});

test.test("v4r3 funnel: approved_loan is very deep (0.05)", () => {
  assert.equal(getFunnelMultiplier("approved_loan"), 0.05);
});

test.test("v4r3 funnel: unknown defaults to 0.20", () => {
  assert.equal(getFunnelMultiplier("xyz_unknown"), DEFAULT_FUNNEL_MULTIPLIER);
});

test.test("v4r3 funnel: empty/null defaults", () => {
  assert.equal(getFunnelMultiplier(null), DEFAULT_FUNNEL_MULTIPLIER);
  assert.equal(getFunnelMultiplier(""), DEFAULT_FUNNEL_MULTIPLIER);
});


// ============================================================================
// 2. MARKET TIERS
// ============================================================================

test.test("v4r3 tier: India is tier-S", () => {
  assert.equal(getMarketTier("India"), "S");
  assert.equal(getMarketTier("india"), "S");
  assert.equal(getMarketTier("in"), "S");
});

test.test("v4r3 tier: US is tier-S", () => {
  assert.equal(getMarketTier("United States"), "S");
  assert.equal(getMarketTier("us"), "S");
});

test.test("v4r3 tier: Brazil is tier-S", () => {
  assert.equal(getMarketTier("Brazil"), "S");
  assert.equal(getMarketTier("br"), "S");
});

test.test("v4r3 tier: UK is tier-A", () => {
  assert.equal(getMarketTier("UK"), "A");
  assert.equal(getMarketTier("united kingdom"), "A");
});

test.test("v4r3 tier: Thailand is tier-B", () => {
  assert.equal(getMarketTier("Thailand"), "B");
});

test.test("v4r3 tier: Singapore is tier-C", () => {
  assert.equal(getMarketTier("Singapore"), "C");
  assert.equal(getMarketTier("sg"), "C");
});

test.test("v4r3 tier: Israel is tier-C", () => {
  assert.equal(getMarketTier("Israel"), "C");
  assert.equal(getMarketTier("il"), "C");
});

test.test("v4r3 tier: unknown defaults to B", () => {
  assert.equal(getMarketTier("Atlantis"), DEFAULT_MARKET_TIER);
});

test.test("v4r3 tier: market with qualifier", () => {
  assert.equal(getMarketTier("India (Mumbai)"), "S");
});

test.test("v4r3 multiplier: chain", () => {
  assert.equal(getMarketMultiplier("India"), 15.0);
  assert.equal(getMarketMultiplier("UK"), 5.0);
  assert.equal(getMarketMultiplier("Thailand"), 2.0);
  assert.equal(getMarketMultiplier("Singapore"), 1.0);
});


// ============================================================================
// 3. VERTICAL FLOORS
// ============================================================================

test.test("v4r3 vertical: hypercasual is high (1500)", () => {
  assert.equal(getVerticalBaseFloor("hypercasual_gaming"), 1500);
});

test.test("v4r3 vertical: fintech is 200", () => {
  assert.equal(getVerticalBaseFloor("fintech"), 200);
});

test.test("v4r3 vertical: ecommerce is 300", () => {
  assert.equal(getVerticalBaseFloor("ecommerce"), 300);
});

test.test("v4r3 vertical: unknown defaults", () => {
  assert.equal(getVerticalBaseFloor("xyz"), DEFAULT_VERTICAL_FLOOR);
});


// ============================================================================
// 4. CARS24 SCENARIO
// ============================================================================

test.test("v4r3 cars24: 500/day below floor", () => {
  assert.equal(isVolumePlausible(500, "India", "ecommerce", "install"), false);
});

test.test("v4r3 cars24: floor is 2250", () => {
  assert.equal(computeVolumeFloor("India", "ecommerce", "install"), 2250);
});

test.test("v4r3 cars24: 5000/day plausible", () => {
  assert.equal(isVolumePlausible(5000, "India", "ecommerce", "install"), true);
});

test.test("v4r3 cars24: 15000/day plausible", () => {
  assert.equal(isVolumePlausible(15000, "India", "ecommerce", "install"), true);
});


// ============================================================================
// 5. DENISE XP SCENARIO (must remain plausible)
// ============================================================================

test.test("v4r3 xp: 500 first_deposits/day plausible", () => {
  assert.equal(isVolumePlausible(500, "Brazil", "fintech", "first_deposit"), true);
});

test.test("v4r3 xp: floor around 150", () => {
  assert.equal(computeVolumeFloor("Brazil", "fintech", "first_deposit"), 150);
});


// ============================================================================
// 6. SINGAPORE SCENARIO
// ============================================================================

test.test("v4r3 sg: floor 10 for first_deposit", () => {
  assert.equal(computeVolumeFloor("Singapore", "fintech", "first_deposit"), 10);
});

test.test("v4r3 sg: 500/day implausibly high", () => {
  assert.equal(isVolumePlausible(500, "Singapore", "fintech", "first_deposit"), false);
});

test.test("v4r3 sg: 20/day plausible", () => {
  assert.equal(isVolumePlausible(20, "Singapore", "fintech", "first_deposit"), true);
});


// ============================================================================
// 7. FUNNEL COHERENCE
// ============================================================================

test.test("v4r3 coherence: 500 installs + 500 deposits incoherent", () => {
  assert.equal(isFunnelCoherent(500, 500, "first_deposit"), false);
});

test.test("v4r3 coherence: 500 installs + 50 deposits coherent", () => {
  assert.equal(isFunnelCoherent(500, 50, "first_deposit"), true);
});

test.test("v4r3 coherence: 500 installs + 5 deposits coherent", () => {
  assert.equal(isFunnelCoherent(500, 5, "first_deposit"), true);
});

test.test("v4r3 coherence: 1000 + 100 purchases coherent", () => {
  assert.equal(isFunnelCoherent(1000, 100, "purchase"), true);
});

test.test("v4r3 coherence: 1000 + 750 purchases incoherent", () => {
  assert.equal(isFunnelCoherent(1000, 750, "purchase"), false);
});

test.test("v4r3 coherence: zero installs returns true (no conflict)", () => {
  assert.equal(isFunnelCoherent(0, 100, "first_deposit"), true);
});


// ============================================================================
// 8. EDGE CASES
// ============================================================================

test.test("v4r3 edge: negative volume not plausible", () => {
  assert.equal(isVolumePlausible(-50, "India", "ecommerce", "install"), false);
});

test.test("v4r3 edge: zero volume not plausible", () => {
  assert.equal(isVolumePlausible(0, "India", "ecommerce", "install"), false);
});

test.test("v4r3 edge: floor minimum is 10", () => {
  assert.ok(computeVolumeFloor("Singapore", "real_estate", "approved_loan") >= 10);
});

test.test("v4r3 edge: constants populated", () => {
  assert.ok(Object.keys(FUNNEL_DEPTH_MULTIPLIERS).length >= 25);
  assert.ok(Object.keys(MARKET_SCALE_TIERS).length >= 50);
  assert.ok(Object.keys(VERTICAL_BASE_INSTALL_FLOOR).length >= 20);
  assert.equal(Object.keys(MARKET_TIER_MULTIPLIERS).length, 4);
});


// ============================================================================
// 9. MARKET TIER COVERAGE
// ============================================================================

test.test("v4r3 coverage: tier-S includes required", () => {
  for (const m of ["India", "China", "Indonesia", "United States", "Brazil"]) {
    assert.equal(getMarketTier(m), "S", `${m} should be tier S`);
  }
});

test.test("v4r3 coverage: tier-C includes required", () => {
  for (const m of ["Singapore", "Israel", "Netherlands", "Sweden",
                   "UAE", "Hong Kong", "Switzerland"]) {
    assert.equal(getMarketTier(m), "C", `${m} should be tier C`);
  }
});


// ============================================================================
// 10. VOLUME CLAIM EXTRACTION FROM EMAIL BODY
// ============================================================================

test.test("v4r3 extract: Cars24 email body — 500/day installs caught", () => {
  const body = "we are delivering 500+ qualified installs per day with car purchase booking CVR above 3%";
  const claims = extractVolumeClaims(body);
  assert.ok(claims.length >= 1);
  assert.equal(claims[0].number, 500);
  assert.equal(claims[0].unit, "daily");
});

test.test("v4r3 extract: Denise PT-BR — 500 contas por dia caught", () => {
  const body = "temos conseguido entregar 500+ contas com primeiro aporte por dia";
  const claims = extractVolumeClaims(body);
  assert.ok(claims.length >= 1);
  assert.equal(claims[0].number, 500);
});

test.test("v4r3 extract: ES — al día caught", () => {
  const body = "entregamos 1000 instalaciones al día";
  const claims = extractVolumeClaims(body);
  assert.ok(claims.length >= 1);
  assert.equal(claims[0].number, 1000);
});

test.test("v4r3 extract: thousands suffix k", () => {
  const body = "we deliver 5k qualified installs per day";
  const claims = extractVolumeClaims(body);
  assert.ok(claims.length >= 1);
  assert.equal(claims[0].number, 5000);
});

test.test("v4r3 extract: no number returns empty", () => {
  assert.deepStrictEqual(extractVolumeClaims("just some prose"), []);
});

test.test("v4r3 extract: empty body returns empty", () => {
  assert.deepStrictEqual(extractVolumeClaims(""), []);
});
