/**
 * test-thread-reader-b9a.ts — Batch B9a unit tests
 *
 * Covers the pure-function surface of the AntiGhosting threadReader:
 *
 *   - classifyDirection: From header vs user email -> 'inbound' | 'outbound'
 *   - extractBodyText: text/plain / text/html / multipart payload parsing
 *
 * The async surfaces (getThreadMessages, syncThreadFromGmail) require
 * a live DB + Gmail mock and live under integration tests rather than
 * this unit suite.
 *
 * Run via:
 *   pnpm --filter @workspace/api-server exec tsx --test tests/test-thread-reader-b9a.ts
 */

import * as test from "node:test";
import * as assert from "node:assert/strict";
import { classifyDirection, extractBodyText } from "../services/threadReader";

// ──────────────────────────────────────────────────────────────────────
// classifyDirection
// ──────────────────────────────────────────────────────────────────────

test.describe("B9a classifyDirection", () => {
  test.it("bare email match returns outbound", () => {
    assert.equal(classifyDirection("mike@mobupps.com", "mike@mobupps.com"), "outbound");
  });

  test.it("display-name with angle brackets returns outbound", () => {
    assert.equal(
      classifyDirection("Mike Goder <mike@mobupps.com>", "mike@mobupps.com"),
      "outbound",
    );
  });

  test.it("case-insensitive match returns outbound", () => {
    assert.equal(
      classifyDirection("MIKE@MOBUPPS.COM", "mike@mobupps.com"),
      "outbound",
    );
    assert.equal(
      classifyDirection("Mike <Mike@Mobupps.com>", "mike@mobupps.com"),
      "outbound",
    );
  });

  test.it("different email returns inbound", () => {
    assert.equal(
      classifyDirection("prospect@otherco.com", "mike@mobupps.com"),
      "inbound",
    );
  });

  test.it("display-name without user's email returns inbound", () => {
    assert.equal(
      classifyDirection("Sarah Chen <sarah@otherco.com>", "mike@mobupps.com"),
      "inbound",
    );
  });

  test.it("empty user email returns inbound (defensive)", () => {
    // isFromSender requires sender.length > 0; without a user email
    // every message is classified inbound. This is the safe default
    // because misclassifying outbound is worse than misclassifying
    // inbound (would cause the bridge to use the wrong "voice" in the
    // generator).
    assert.equal(classifyDirection("anyone@anywhere.com", ""), "inbound");
  });

  test.it("empty From header returns inbound", () => {
    assert.equal(classifyDirection("", "mike@mobupps.com"), "inbound");
  });

  test.it("user email as a substring of a longer address no longer matches (2026-07-29 hardening)", () => {
    // The old substring heuristic classified any From header CONTAINING
    // the user's email as outbound — including phishing-style
    // "mike@m.com.evil.com". The predicted fix from the original note
    // ("switch to full email-token extraction") landed on 2026-07-29:
    // isFromSender now compares the extracted address for equality, so
    // this spoofed variant correctly classifies as inbound.
    assert.equal(
      classifyDirection("mike@m.com.evil.com", "mike@m.com"),
      "inbound",
    );
  });
});

// ──────────────────────────────────────────────────────────────────────
// extractBodyText
// ──────────────────────────────────────────────────────────────────────

// Helper to build a base64url-encoded body part as Gmail returns it.
function b64url(text: string): string {
  return Buffer.from(text, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

test.describe("B9a extractBodyText", () => {
  test.it("text/plain payload returns the decoded body", () => {
    const result = extractBodyText({
      mimeType: "text/plain",
      body: { data: b64url("Hello from the prospect.") },
    } as any);
    assert.equal(result, "Hello from the prospect.");
  });

  test.it("text/html payload returns plain text with tags stripped", () => {
    const result = extractBodyText({
      mimeType: "text/html",
      body: {
        data: b64url("<p>Hello <b>from</b> the prospect.</p>"),
      },
    } as any);
    // Whitespace normalisation runs inside stripHtmlForComparison.
    // The exact whitespace shape isn't important — only that no tags
    // remain.
    assert.ok(!result.includes("<"));
    assert.ok(!result.includes(">"));
    assert.ok(result.includes("Hello"));
    assert.ok(result.includes("from"));
    assert.ok(result.includes("the prospect"));
  });

  test.it("multipart payload returns the first text/plain part", () => {
    const result = extractBodyText({
      mimeType: "multipart/alternative",
      parts: [
        {
          mimeType: "text/plain",
          body: { data: b64url("Plain version of the body.") },
        },
        {
          mimeType: "text/html",
          body: { data: b64url("<p>HTML version</p>") },
        },
      ],
    } as any);
    assert.equal(result, "Plain version of the body.");
  });

  test.it("multipart with only HTML falls back to HTML-with-tags-stripped", () => {
    const result = extractBodyText({
      mimeType: "multipart/related",
      parts: [
        {
          mimeType: "text/html",
          body: { data: b64url("<div>HTML only body</div>") },
        },
      ],
    } as any);
    assert.ok(!result.includes("<"));
    assert.ok(result.includes("HTML only body"));
  });

  test.it("nested multipart (parts within parts) recurses to find text/plain", () => {
    const result = extractBodyText({
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "multipart/alternative",
          parts: [
            {
              mimeType: "text/plain",
              body: { data: b64url("Deeply nested plain text.") },
            },
          ],
        },
      ],
    } as any);
    assert.equal(result, "Deeply nested plain text.");
  });

  test.it("undefined payload returns empty string", () => {
    assert.equal(extractBodyText(undefined), "");
  });

  test.it("payload with no body data and no parts returns empty string", () => {
    assert.equal(extractBodyText({ mimeType: "text/plain" } as any), "");
    assert.equal(extractBodyText({ mimeType: "multipart/related", parts: [] } as any), "");
  });
});
