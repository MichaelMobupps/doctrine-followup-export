/**
 * test-chief-auth.ts — F-3.7a.
 *
 * The inbound order-token gate, as a pure contract. No DB, no network, no
 * express: `lib/chiefAuth.ts` imports nothing but `node:crypto`, which is what
 * makes this file possible and what keeps the gate mountable ahead of every
 * other middleware in the app.
 *
 * The properties pinned here are the ones whose failure is silent:
 *
 *   1. THE SCHEME IS CASE-SENSITIVE. A lax `bearer` would work perfectly
 *      against the Chief (which always sends `Bearer`) and would quietly widen
 *      what this app accepts from everyone else.
 *   2. LENGTH IS CHECKED BEFORE `timingSafeEqual`. Without it the comparison
 *      THROWS on a mismatched length, and a throwing auth check answers 500 —
 *      which tells a prober more than a 401 does.
 *   3. AN UNSET SECRET AUTHENTICATES NOBODY. The empty string must never be a
 *      usable token: `Authorization: Bearer ` with `FOLLOWUP_CHIEF_TOKEN` unset
 *      is the exact request that would otherwise open the seam to the internet.
 *   4. ONE 401 BODY. Byte-identical for every failure. Asserted on the SERIALIZED
 *      bytes, because two objects can be deep-equal and serialize differently.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx --test src/tests/test-chief-auth.ts
 */
import * as test from "node:test";
import * as assert from "node:assert/strict";
import {
  APP_NAME,
  CHIEF_CONTRACT_VERSION,
  INBOUND_TOKEN_VAR,
  UNAUTHORISED_BODY,
  UNAVAILABLE_BODY,
  chiefTokenFromEnv,
  chiefTokenMismatchWarning,
  isAuthorisedChiefRequest,
} from "../lib/chiefAuth";

const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

test.describe("chief identity", () => {
  test.it("reports as `followup`, the Chief's renamed identity — never `followuper`", () => {
    // C-3.2b renamed `followuper` -> `followup` with no fallback. Getting this
    // wrong does not fail anything loudly; it files this app's spend under an
    // identity the Chief does not know.
    assert.equal(APP_NAME, "followup");
  });

  test.it("carries a contract version", () => {
    assert.equal(CHIEF_CONTRACT_VERSION, "f-3.7a");
  });
});

test.describe("chiefTokenFromEnv", () => {
  test.it("reads FOLLOWUP_CHIEF_TOKEN", () => {
    assert.equal(chiefTokenFromEnv({ [INBOUND_TOKEN_VAR]: TOKEN }), TOKEN);
  });

  test.it("trims, so a secret pasted with a newline still works", () => {
    assert.equal(chiefTokenFromEnv({ [INBOUND_TOKEN_VAR]: `  ${TOKEN}\n` }), TOKEN);
  });

  test.it("treats unset, empty and whitespace-only as UNSET", () => {
    assert.equal(chiefTokenFromEnv({}), null);
    assert.equal(chiefTokenFromEnv({ [INBOUND_TOKEN_VAR]: "" }), null);
    assert.equal(chiefTokenFromEnv({ [INBOUND_TOKEN_VAR]: "   " }), null);
  });

  test.it("does NOT fall back to the outbound token", () => {
    // Two names for one value is already a footgun; a silent fallback would
    // make a half-configured seam look whole.
    assert.equal(chiefTokenFromEnv({ CHIEF_INGEST_TOKEN: TOKEN }), null);
  });
});

test.describe("isAuthorisedChiefRequest", () => {
  test.it("accepts the exact header the Chief sends", () => {
    assert.equal(isAuthorisedChiefRequest(`Bearer ${TOKEN}`, TOKEN), true);
  });

  test.it("tolerates extra whitespace after the scheme, both sides", () => {
    assert.equal(isAuthorisedChiefRequest(`Bearer   ${TOKEN}  `, TOKEN), true);
  });

  test.it("REFUSES a lower-case scheme", () => {
    assert.equal(isAuthorisedChiefRequest(`bearer ${TOKEN}`, TOKEN), false);
    assert.equal(isAuthorisedChiefRequest(`BEARER ${TOKEN}`, TOKEN), false);
  });

  test.it("refuses another scheme carrying the right value", () => {
    assert.equal(isAuthorisedChiefRequest(`Basic ${TOKEN}`, TOKEN), false);
    assert.equal(isAuthorisedChiefRequest(TOKEN, TOKEN), false);
  });

  test.it("refuses a wrong token of the SAME length without throwing", () => {
    const sameLength = "f".repeat(TOKEN.length);
    assert.equal(sameLength.length, TOKEN.length);
    assert.equal(isAuthorisedChiefRequest(`Bearer ${sameLength}`, TOKEN), false);
  });

  test.it("refuses a wrong token of a DIFFERENT length without throwing", () => {
    // The length pre-check is what stops `timingSafeEqual` throwing here. A
    // throw would escape as a 500.
    assert.doesNotThrow(() => isAuthorisedChiefRequest("Bearer short", TOKEN));
    assert.equal(isAuthorisedChiefRequest("Bearer short", TOKEN), false);
    assert.equal(isAuthorisedChiefRequest(`Bearer ${TOKEN}${TOKEN}`, TOKEN), false);
  });

  test.it("refuses everything when the expected token is unset", () => {
    assert.equal(isAuthorisedChiefRequest(`Bearer ${TOKEN}`, null), false);
    assert.equal(isAuthorisedChiefRequest("Bearer ", null), false);
    assert.equal(isAuthorisedChiefRequest("Bearer ", ""), false);
  });

  test.it("refuses a missing, empty or duplicated header", () => {
    assert.equal(isAuthorisedChiefRequest(undefined, TOKEN), false);
    assert.equal(isAuthorisedChiefRequest("", TOKEN), false);
    // Express surfaces a duplicated Authorization header as an array. Joining
    // it would let a caller append a valid value after a junk one.
    assert.equal(isAuthorisedChiefRequest([`Bearer ${TOKEN}`, "Bearer x"], TOKEN), false);
  });

  test.it("compares BYTES, so a multi-byte token matches itself and nothing else", () => {
    const utf8 = "tökén-ünïcödé-secret";
    assert.equal(isAuthorisedChiefRequest(`Bearer ${utf8}`, utf8), true);
    // Same JS string length, different bytes.
    assert.equal(isAuthorisedChiefRequest(`Bearer ${"a".repeat(utf8.length)}`, utf8), false);
  });
});

test.describe("the fixed bodies", () => {
  test.it("the 401 is the Chief's own wording and is frozen", () => {
    assert.equal(JSON.stringify(UNAUTHORISED_BODY), '{"error":"valid order-token required"}');
    assert.equal(Object.isFrozen(UNAUTHORISED_BODY), true);
  });

  test.it("the 503 says nothing about why", () => {
    assert.equal(JSON.stringify(UNAVAILABLE_BODY), '{"error":"status unavailable"}');
    assert.equal(Object.isFrozen(UNAVAILABLE_BODY), true);
  });
});

test.describe("chiefTokenMismatchWarning", () => {
  test.it("says nothing when the seam is entirely unconfigured", () => {
    assert.equal(chiefTokenMismatchWarning({}), null);
  });

  test.it("says nothing when both halves hold the same value", () => {
    assert.equal(
      chiefTokenMismatchWarning({ [INBOUND_TOKEN_VAR]: TOKEN, CHIEF_INGEST_TOKEN: TOKEN }),
      null,
    );
  });

  test.it("tolerates whitespace differences, because both readers trim", () => {
    assert.equal(
      chiefTokenMismatchWarning({ [INBOUND_TOKEN_VAR]: `${TOKEN}\n`, CHIEF_INGEST_TOKEN: ` ${TOKEN}` }),
      null,
    );
  });

  test.it("warns when only the inbound half is set", () => {
    const w = chiefTokenMismatchWarning({ [INBOUND_TOKEN_VAR]: TOKEN });
    assert.ok(w && w.includes("CHIEF_INGEST_TOKEN"));
  });

  test.it("warns when only the outbound half is set", () => {
    const w = chiefTokenMismatchWarning({ CHIEF_INGEST_TOKEN: TOKEN });
    assert.ok(w && w.includes(INBOUND_TOKEN_VAR));
  });

  test.it("warns when the two halves DISAGREE, and never prints either value", () => {
    const other = "9".repeat(64);
    const w = chiefTokenMismatchWarning({
      [INBOUND_TOKEN_VAR]: TOKEN,
      CHIEF_INGEST_TOKEN: other,
    });
    assert.ok(w && w.includes("DIFFERENT"));
    assert.ok(!w!.includes(TOKEN), "the warning must not carry the token");
    assert.ok(!w!.includes(other), "the warning must not carry the token");
  });
});
