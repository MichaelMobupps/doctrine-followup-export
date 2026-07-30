/**
 * test-anti-ghosting-b9b.ts — Batch B9b unit tests
 *
 * Covers the pure / mock-friendly surfaces of the AntiGhosting marking
 * flow:
 *
 *   - computeFirstFollowupAt: scheduling formula across fresh / stale
 *     / boundary seeds, plus custom cadence and buffer overrides.
 *   - parseGmailThread: chronological sort, direction classification,
 *     header / body extraction (mocked gmail client).
 *   - validateThreadForMarking: structural failure paths that short-
 *     circuit before the DB check (empty thread, recent-inbound,
 *     no-inbound).
 *
 * Full DB-integration coverage of validator 3 and of /mark's prospect
 * insertion belong in a separate integration suite (next batch when
 * the test DB seed pattern lands; B9b ships unit only).
 *
 * Run via:
 *   pnpm --filter @workspace/api-server exec tsx --test tests/test-anti-ghosting-b9b.ts
 */

import * as test from "node:test";
import * as assert from "node:assert/strict";
import type { gmail_v1 } from "googleapis";

import {
  computeFirstFollowupAt,
  ANTI_GHOSTING_F1_CADENCE_GAP_MS,
  ANTI_GHOSTING_MIN_BUFFER_MS,
} from "../services/antiGhostingScheduling";
import {
  parseGmailThread,
  validateThreadForMarking,
} from "../services/antiGhostingValidators";

// ──────────────────────────────────────────────────────────────────────
// Section 1 — computeFirstFollowupAt
// ──────────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

test.describe("B9b computeFirstFollowupAt", () => {
  test.it("fresh seed: cadence gap wins, fires 7 days after sentAt", () => {
    const sentAt = new Date("2026-01-01T12:00:00Z");
    const markedAt = new Date("2026-01-01T12:00:00Z"); // marked the same moment
    const result = computeFirstFollowupAt({ sentAt, markedAt });
    assert.equal(result.toISOString(), new Date("2026-01-08T12:00:00Z").toISOString());
  });

  test.it("stale seed (30 days old): min buffer wins, fires 1 day after marking", () => {
    const sentAt = new Date("2025-12-01T12:00:00Z");
    const markedAt = new Date("2026-01-01T12:00:00Z");
    const result = computeFirstFollowupAt({ sentAt, markedAt });
    assert.equal(result.toISOString(), new Date("2026-01-02T12:00:00Z").toISOString());
  });

  test.it("boundary: marked exactly 6 days after seed, both branches equal at +1 day", () => {
    // sentAt + 7d = markedAt + 1d => fromSeed == fromMark; Math.max picks
    // either, both return the same instant.
    const sentAt = new Date("2026-01-01T12:00:00Z");
    const markedAt = new Date("2026-01-07T12:00:00Z");
    const result = computeFirstFollowupAt({ sentAt, markedAt });
    assert.equal(result.toISOString(), new Date("2026-01-08T12:00:00Z").toISOString());
  });

  test.it("custom cadenceGapMs overrides the default 7d", () => {
    const sentAt = new Date("2026-01-01T00:00:00Z");
    const markedAt = new Date("2026-01-01T00:00:00Z");
    const result = computeFirstFollowupAt({
      sentAt,
      markedAt,
      cadenceGapMs: 14 * DAY_MS,
    });
    assert.equal(result.toISOString(), new Date("2026-01-15T00:00:00Z").toISOString());
  });

  test.it("custom minBufferMs overrides the default 1d", () => {
    const sentAt = new Date("2025-06-01T00:00:00Z"); // ancient
    const markedAt = new Date("2026-01-01T00:00:00Z");
    const result = computeFirstFollowupAt({
      sentAt,
      markedAt,
      minBufferMs: 3 * DAY_MS,
    });
    assert.equal(result.toISOString(), new Date("2026-01-04T00:00:00Z").toISOString());
  });

  test.it("default constants match the documented values (7d, 1d)", () => {
    assert.equal(ANTI_GHOSTING_F1_CADENCE_GAP_MS, 7 * DAY_MS);
    assert.equal(ANTI_GHOSTING_MIN_BUFFER_MS, 1 * DAY_MS);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Section 2 — parseGmailThread (with mocked Gmail client)
// ──────────────────────────────────────────────────────────────────────

/**
 * Build a Gmail-shaped Schema$Message with the minimum fields parseGmailThread
 * needs. Body is encoded as base64url in `payload.body.data`, matching what
 * Gmail returns for text/plain parts.
 */
function buildMessage(opts: {
  id: string;
  fromHeader: string;
  subject: string;
  bodyText: string;
  internalDate: number; // unix ms
  snippet?: string;
}): gmail_v1.Schema$Message {
  return {
    id: opts.id,
    threadId: "thread_test",
    snippet: opts.snippet ?? "",
    internalDate: String(opts.internalDate),
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: opts.fromHeader },
        { name: "Subject", value: opts.subject },
      ],
      body: {
        size: opts.bodyText.length,
        data: Buffer.from(opts.bodyText, "utf-8").toString("base64url"),
      },
    },
  };
}

/**
 * Build a stub Gmail client whose users.threads.get returns the supplied
 * messages. Used to exercise parseGmailThread without a real Gmail
 * connection.
 */
function buildMockGmail(messages: gmail_v1.Schema$Message[]): gmail_v1.Gmail {
  return {
    users: {
      threads: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/require-await
        get: async (_params: unknown) => ({
          data: {
            id: "thread_test",
            messages,
          },
        }),
      },
    },
  } as unknown as gmail_v1.Gmail;
}

test.describe("B9b parseGmailThread", () => {
  test.it("sorts messages chronologically oldest-first", async () => {
    const gmail = buildMockGmail([
      buildMessage({
        id: "m3",
        fromHeader: "mike@mobupps.com",
        subject: "Re: x",
        bodyText: "third",
        internalDate: Date.parse("2026-03-01T00:00:00Z"),
      }),
      buildMessage({
        id: "m1",
        fromHeader: "mike@mobupps.com",
        subject: "x",
        bodyText: "first",
        internalDate: Date.parse("2026-01-01T00:00:00Z"),
      }),
      buildMessage({
        id: "m2",
        fromHeader: "prospect@otherco.com",
        subject: "Re: x",
        bodyText: "second",
        internalDate: Date.parse("2026-02-01T00:00:00Z"),
      }),
    ]);
    const briefs = await parseGmailThread(gmail, "thread_test", "mike@mobupps.com");
    assert.deepEqual(
      briefs.map((b) => b.id),
      ["m1", "m2", "m3"],
    );
  });

  test.it("classifies direction by From header vs user email", async () => {
    const gmail = buildMockGmail([
      buildMessage({
        id: "out1",
        fromHeader: "Mike <mike@mobupps.com>",
        subject: "Hello",
        bodyText: "Hi there",
        internalDate: 1_700_000_000_000,
      }),
      buildMessage({
        id: "in1",
        fromHeader: "Sarah Chen <sarah@otherco.com>",
        subject: "Re: Hello",
        bodyText: "Hey",
        internalDate: 1_700_000_100_000,
      }),
    ]);
    const briefs = await parseGmailThread(gmail, "thread_test", "mike@mobupps.com");
    assert.equal(briefs[0].direction, "outbound");
    assert.equal(briefs[1].direction, "inbound");
  });

  test.it("extracts fromEmail and fromName from display-name format", async () => {
    const gmail = buildMockGmail([
      buildMessage({
        id: "in1",
        fromHeader: "Sarah Chen <sarah@otherco.com>",
        subject: "x",
        bodyText: "b",
        internalDate: 1_700_000_000_000,
      }),
    ]);
    const briefs = await parseGmailThread(gmail, "thread_test", "mike@mobupps.com");
    assert.equal(briefs[0].fromEmail, "sarah@otherco.com");
    assert.equal(briefs[0].fromName, "Sarah Chen");
  });

  test.it("extracts decoded body from base64url payload", async () => {
    const gmail = buildMockGmail([
      buildMessage({
        id: "out1",
        fromHeader: "mike@mobupps.com",
        subject: "Hello",
        bodyText: "First paragraph.\n\nSecond paragraph.",
        internalDate: 1_700_000_000_000,
      }),
    ]);
    const briefs = await parseGmailThread(gmail, "thread_test", "mike@mobupps.com");
    assert.match(briefs[0].body, /First paragraph/);
    assert.match(briefs[0].body, /Second paragraph/);
  });

  test.it("skips messages without parseable internalDate", async () => {
    const gmail = buildMockGmail([
      { id: "no_date", threadId: "thread_test", payload: { headers: [] } },
      buildMessage({
        id: "good",
        fromHeader: "mike@mobupps.com",
        subject: "x",
        bodyText: "b",
        internalDate: 1_700_000_000_000,
      }),
    ]);
    const briefs = await parseGmailThread(gmail, "thread_test", "mike@mobupps.com");
    assert.equal(briefs.length, 1);
    assert.equal(briefs[0].id, "good");
  });

  test.it("returns empty array when thread has no messages", async () => {
    const gmail = buildMockGmail([]);
    const briefs = await parseGmailThread(gmail, "thread_test", "mike@mobupps.com");
    assert.deepEqual(briefs, []);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Section 3 — validateThreadForMarking: structural failure paths
// ──────────────────────────────────────────────────────────────────────
//
// These paths short-circuit before the DB-backed validator 3 query, so
// they can be exercised without a live DB. Validator 3's positive and
// negative cases require a seeded DB and live in the integration suite.

test.describe("B9b validateThreadForMarking — structural failures", () => {
  test.it("empty thread: ok=false, failureReason mentions no parseable messages", async () => {
    const gmail = buildMockGmail([]);
    const outcome = await validateThreadForMarking(
      "thread_test",
      gmail,
      "mike@mobupps.com",
      999,
    );
    assert.equal(outcome.ok, false);
    assert.equal(outcome.seed, null);
    assert.match(outcome.failureReason ?? "", /no parseable messages/i);
    // None of the validators ran — all results are still default false.
    assert.equal(outcome.results.mostRecentIsOutbound, false);
    assert.equal(outcome.results.threadHasInbound, false);
    assert.equal(outcome.results.mostRecentOutboundNotInFollowups, false);
  });

  test.it("most recent is inbound: validator 1 fails with operator-facing message", async () => {
    const gmail = buildMockGmail([
      buildMessage({
        id: "m1",
        fromHeader: "mike@mobupps.com",
        subject: "Hi",
        bodyText: "Outreach",
        internalDate: Date.parse("2026-01-01T00:00:00Z"),
      }),
      buildMessage({
        id: "m2",
        fromHeader: "prospect@otherco.com",
        subject: "Re: Hi",
        bodyText: "Reply",
        internalDate: Date.parse("2026-01-02T00:00:00Z"),
      }),
    ]);
    const outcome = await validateThreadForMarking(
      "thread_test",
      gmail,
      "mike@mobupps.com",
      999,
    );
    assert.equal(outcome.ok, false);
    assert.equal(outcome.results.mostRecentIsOutbound, false);
    // Validators 2 and 3 should NOT have run.
    assert.equal(outcome.results.threadHasInbound, false);
    assert.equal(outcome.results.mostRecentOutboundNotInFollowups, false);
    // Prospect identification still populated for the dashboard.
    assert.equal(outcome.prospect?.email, "prospect@otherco.com");
    assert.match(outcome.failureReason ?? "", /from the prospect/i);
  });

  test.it("no inbound exists: validator 2 fails with cold-outreach message", async () => {
    const gmail = buildMockGmail([
      buildMessage({
        id: "m1",
        fromHeader: "mike@mobupps.com",
        subject: "Hi",
        bodyText: "Outreach",
        internalDate: Date.parse("2026-01-01T00:00:00Z"),
      }),
      buildMessage({
        id: "m2",
        fromHeader: "mike@mobupps.com",
        subject: "Re: Hi",
        bodyText: "Bumping",
        internalDate: Date.parse("2026-01-05T00:00:00Z"),
      }),
    ]);
    const outcome = await validateThreadForMarking(
      "thread_test",
      gmail,
      "mike@mobupps.com",
      999,
    );
    assert.equal(outcome.ok, false);
    assert.equal(outcome.results.mostRecentIsOutbound, true);
    assert.equal(outcome.results.threadHasInbound, false);
    // Validator 3 did not run.
    assert.equal(outcome.results.mostRecentOutboundNotInFollowups, false);
    // No inbound exists, so prospect is null.
    assert.equal(outcome.prospect, null);
    assert.match(outcome.failureReason ?? "", /no replies from the prospect/i);
  });
});
