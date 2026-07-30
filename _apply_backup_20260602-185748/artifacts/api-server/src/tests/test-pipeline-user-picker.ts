/**
 * test-pipeline-user-picker.ts
 *
 * Hermetic unit tests for the pure helpers that back the admin pipeline user
 * picker. No DB, no network — these lock the contract the three pipeline pages
 * rely on: option mapping, effective-userId resolution, and banner name/visibility.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx --test src/tests/test-pipeline-user-picker.ts
 */

import * as test from "node:test";
import * as assert from "node:assert/strict";

import {
  SELF_SELECTION,
  userDisplayLabel,
  mapActivityUsersToPickerOptions,
  resolveEffectiveUserId,
  isViewingOther,
  resolveViewedManagerName,
} from "../lib/pipelineUserPicker";

test.describe("userDisplayLabel", () => {
  test.it("uses trimmed name when present", () => {
    assert.equal(userDisplayLabel("  Murat Solendil ", "m@x.com"), "Murat Solendil");
  });
  test.it("falls back to email when name blank/null", () => {
    assert.equal(userDisplayLabel("", "m@x.com"), "m@x.com");
    assert.equal(userDisplayLabel("   ", "m@x.com"), "m@x.com");
    assert.equal(userDisplayLabel(null, "m@x.com"), "m@x.com");
    assert.equal(userDisplayLabel(undefined, "m@x.com"), "m@x.com");
  });
});

test.describe("mapActivityUsersToPickerOptions", () => {
  test.it("returns [] for null/undefined/non-array", () => {
    assert.deepEqual(mapActivityUsersToPickerOptions(null), []);
    assert.deepEqual(mapActivityUsersToPickerOptions(undefined), []);
    // @ts-expect-error intentionally wrong type
    assert.deepEqual(mapActivityUsersToPickerOptions({}), []);
  });

  test.it("maps id+name into options, sorted by label", () => {
    const opts = mapActivityUsersToPickerOptions([
      { id: 2, email: "z@x.com", name: "Zara" },
      { id: 1, email: "a@x.com", name: "Aaron" },
    ]);
    assert.deepEqual(opts, [
      { id: 1, label: "Aaron" },
      { id: 2, label: "Zara" },
    ]);
  });

  test.it("falls back to email label when name missing", () => {
    const opts = mapActivityUsersToPickerOptions([
      { id: 5, email: "noname@x.com", name: null },
    ]);
    assert.deepEqual(opts, [{ id: 5, label: "noname@x.com" }]);
  });

  test.it("skips entries without a finite numeric id", () => {
    const opts = mapActivityUsersToPickerOptions([
      // @ts-expect-error bad id
      { id: "7", email: "s@x.com", name: "Str" },
      { id: NaN, email: "n@x.com", name: "Nan" },
      { id: 3, email: "ok@x.com", name: "Ok" },
    ]);
    assert.deepEqual(opts, [{ id: 3, label: "Ok" }]);
  });

  test.it("de-dupes by id, first occurrence wins", () => {
    const opts = mapActivityUsersToPickerOptions([
      { id: 1, email: "first@x.com", name: "First" },
      { id: 1, email: "dupe@x.com", name: "Dupe" },
    ]);
    assert.deepEqual(opts, [{ id: 1, label: "First" }]);
  });
});

test.describe("resolveEffectiveUserId", () => {
  test.it("SELF resolves to the current user id", () => {
    assert.equal(resolveEffectiveUserId(SELF_SELECTION, 42), 42);
  });
  test.it("SELF with no current user resolves to null (omit param)", () => {
    assert.equal(resolveEffectiveUserId(SELF_SELECTION, null), null);
  });
  test.it("a concrete selection resolves to that id", () => {
    assert.equal(resolveEffectiveUserId(7, 42), 7);
  });
  test.it("selecting own id resolves to own id (no surprise null)", () => {
    assert.equal(resolveEffectiveUserId(42, 42), 42);
  });
});

test.describe("isViewingOther", () => {
  test.it("SELF is never other", () => {
    assert.equal(isViewingOther(SELF_SELECTION, 42), false);
    assert.equal(isViewingOther(SELF_SELECTION, null), false);
  });
  test.it("a different concrete id is other", () => {
    assert.equal(isViewingOther(7, 42), true);
  });
  test.it("own id selected is not other (admin is itself a manager)", () => {
    assert.equal(isViewingOther(42, 42), false);
  });
  test.it("any concrete id is other when current user unknown", () => {
    assert.equal(isViewingOther(7, null), true);
  });
});

test.describe("resolveViewedManagerName", () => {
  const options = [
    { id: 1, label: "Aaron" },
    { id: 7, label: "Murat Solendil" },
  ];
  test.it("null when viewing self", () => {
    assert.equal(resolveViewedManagerName(SELF_SELECTION, 42, options), null);
    assert.equal(resolveViewedManagerName(42, 42, options), null);
  });
  test.it("names the manager from the same options list", () => {
    assert.equal(resolveViewedManagerName(7, 42, options), "Murat Solendil");
  });
  test.it("stable fallback when id not yet in options", () => {
    assert.equal(resolveViewedManagerName(99, 42, options), "manager #99");
  });
});