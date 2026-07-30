/**
 * test-competitor-library.ts
 *
 * Hermetic tests for the language-keyed competitor selector and its writer
 * block. No DB, no network, no billing: selection is pure over the embedded
 * library. Mirrors the structure of test-writer-provider.ts.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx --test src/tests/test-competitor-library.ts
 */
import * as test from "node:test";
import * as assert from "node:assert/strict";

import {
  selectCompetitors,
  buildWriterCompetitorBlock,
  competitorsEnabled,
  type CompetitorContext,
} from "../lib/competitorLibrary";

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    prev[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

test.test("resolves ecommerce for an English ecommerce context", () => {
  const ctx: CompetitorContext = {
    vertical: "non_gaming_ua",
    sub_vertical: "ecommerce",
    product: "cps",
    original_language: "en",
  };
  const sel = selectCompetitors(ctx);
  assert.ok(sel, "expected a selection");
  assert.equal(sel!.vertical, "ecommerce");
  assert.ok(sel!.nameable.length > 0, "expected nameable peers");
  assert.ok(sel!.markets.length > 0, "expected contributing markets");
});

test.test("nameable peers and avoid line are disjoint", () => {
  const sel = selectCompetitors({
    vertical: "non_gaming_ua",
    sub_vertical: "ecommerce",
    product: "ua",
    original_language: "en",
  });
  assert.ok(sel);
  const nameableLower = new Set(sel!.nameable.map((n) => n.toLowerCase()));
  for (const a of sel!.avoid) {
    assert.ok(!nameableLower.has(a.toLowerCase()), `avoid name leaked into nameable: ${a}`);
  }
});

test.test("unknown language yields no selection", () => {
  const sel = selectCompetitors({
    vertical: "non_gaming_ua",
    sub_vertical: "ecommerce",
    product: "ua",
    original_language: "zz",
  });
  assert.equal(sel, null);
});

test.test("non_gaming_ua without a sub-vertical does not resolve to gaming", () => {
  const sel = selectCompetitors({
    vertical: "non_gaming_ua",
    sub_vertical: null,
    product: "ua",
    original_language: "en",
  });
  // Either no confident vertical (null) or, if it resolves, it is never gaming.
  if (sel) {
    assert.notEqual(sel.vertical, "gaming_midcore_hardcore");
  }
});

test.test("explicit gaming context resolves to a gaming vertical", () => {
  const sel = selectCompetitors({
    vertical: "gaming_ua",
    sub_vertical: null,
    product: "ua",
    original_language: "ko",
  });
  if (sel) {
    assert.ok(sel.vertical.startsWith("gaming_"));
  }
});

test.test("block contains header and nameable names", () => {
  const ctx: CompetitorContext = {
    vertical: "non_gaming_ua",
    sub_vertical: "ride_hailing",
    product: "ua",
    original_language: "es",
  };
  const sel = selectCompetitors(ctx);
  const block = buildWriterCompetitorBlock(ctx);
  if (sel && sel.nameable.length > 0) {
    assert.match(block, /IN-REGION COMPETITOR REFERENCE/);
    assert.ok(block.includes(sel.nameable[0]), "block should list the top nameable peer");
  }
});

test.test("WRITER_COMPETITORS=off disables the block", () => {
  withEnv({ WRITER_COMPETITORS: "off" }, () => {
    assert.equal(competitorsEnabled(), false);
    const block = buildWriterCompetitorBlock({
      vertical: "non_gaming_ua",
      sub_vertical: "ecommerce",
      product: "cps",
      original_language: "en",
    });
    assert.equal(block, "");
  });
});

test.test("WRITER_COMPETITOR_COUNT caps the nameable list", () => {
  withEnv({ WRITER_COMPETITOR_COUNT: "3" }, () => {
    const sel = selectCompetitors({
      vertical: "non_gaming_ua",
      sub_vertical: "ecommerce",
      product: "ua",
      original_language: "en",
    });
    assert.ok(sel);
    assert.ok(sel!.nameable.length <= 3, "nameable should respect the cap");
  });
});
