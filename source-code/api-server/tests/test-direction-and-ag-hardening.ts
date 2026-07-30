/**
 * test-direction-and-ag-hardening.ts
 *
 * Hermetic tests for the 2026-07-29 fixes:
 *
 *  1. isFromSender (via the isFromSenderHelper export): address-equality
 *     comparison instead of raw substring — a prospect whose display name
 *     quotes the operator's address must not classify as outbound.
 *  2. isOutboundMessage: Gmail SENT label is authoritative for "our own
 *     message" so send-as aliases (michael.a.g@... while connected as
 *     michael@...) never classify as prospect replies. DRAFT never counts.
 *  3. parseGmailThread (AntiGhosting validators): direction now flows
 *     through isOutboundMessage — an alias-sent operator reply with the
 *     SENT label is "outbound" even though its From header doesn't match
 *     the connected account.
 *  4. listThreadsWithAnyLabel: one threads.list call PER label ID with the
 *     results unioned (OR semantics). A single call with several labelIds
 *     would be an AND filter in the Gmail API and silently match nothing.
 *
 * No DB, no network — Gmail is a hand-rolled fake.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx --test src/tests/test-direction-and-ag-hardening.ts
 */

import * as test from "node:test";
import * as assert from "node:assert/strict";
import type { gmail_v1 } from "googleapis";

import { isFromSenderHelper, isOutboundMessage, classifyThreadInbound } from "../services/gmailClient";
import { parseGmailThread } from "../services/antiGhostingValidators";
import { listThreadsWithAnyLabel } from "../services/antiGhostingIngest";

// ── isFromSender hardening ───────────────────────────────────────────────

test.describe("isFromSender (address equality, not substring)", () => {
  test.it("matches a plain address", () => {
    assert.equal(isFromSenderHelper("michael@mobupps.com", "michael@mobupps.com"), true);
  });

  test.it("matches display-name + bracketed address, case-insensitive", () => {
    assert.equal(
      isFromSenderHelper("Michael Goder <MICHAEL@mobupps.com>", "michael@mobupps.com"),
      true,
    );
  });

  test.it("does NOT match a different alias address (michael.a.g vs michael)", () => {
    assert.equal(
      isFromSenderHelper("Michael A.G <michael.a.g@mobupps.com>", "michael@mobupps.com"),
      false,
    );
  });

  test.it("does NOT match when the sender address only appears in the display name", () => {
    // Old substring behaviour classified this PROSPECT message as outbound.
    assert.equal(
      isFromSenderHelper('"assistant to michael@mobupps.com" <other@example.com>', "michael@mobupps.com"),
      false,
    );
  });

  test.it("empty sender never matches", () => {
    assert.equal(isFromSenderHelper("someone@example.com", ""), false);
  });
});

// ── isOutboundMessage ────────────────────────────────────────────────────

function msg(labelIds: string[] | undefined, from: string): Pick<gmail_v1.Schema$Message, "labelIds" | "payload"> {
  return {
    labelIds,
    payload: { headers: [{ name: "From", value: from }] },
  };
}

test.describe("isOutboundMessage", () => {
  test.it("SENT label is authoritative even when From is an alias", () => {
    assert.equal(
      isOutboundMessage(msg(["SENT"], "Michael A.G <michael.a.g@mobupps.com>"), "michael@mobupps.com"),
      true,
    );
  });

  test.it("DRAFT is never outbound-sent, even with a matching From", () => {
    assert.equal(
      isOutboundMessage(msg(["DRAFT"], "michael@mobupps.com"), "michael@mobupps.com"),
      false,
    );
  });

  test.it("no labels: falls back to From-header equality", () => {
    assert.equal(
      isOutboundMessage(msg(undefined, "Michael <michael@mobupps.com>"), "michael@mobupps.com"),
      true,
    );
    assert.equal(
      isOutboundMessage(msg(undefined, "Prospect <jess@tilt.com>"), "michael@mobupps.com"),
      false,
    );
  });

  test.it("INBOX-only message from a prospect is inbound", () => {
    assert.equal(
      isOutboundMessage(msg(["INBOX"], "Jess <jess@tilt.com>"), "michael@mobupps.com"),
      false,
    );
  });
});

// ── parseGmailThread direction via SENT ──────────────────────────────────

type FakeThreadMsg = {
  id: string;
  from: string;
  labelIds: string[];
  internalDate: string;
};

function makeFakeGmailThread(messages: FakeThreadMsg[]) {
  const gmail = {
    users: {
      threads: {
        get: async (_params: { id: string }) => ({
          data: {
            messages: messages.map((m) => ({
              id: m.id,
              labelIds: m.labelIds,
              internalDate: m.internalDate,
              snippet: "snippet",
              payload: {
                mimeType: "text/plain",
                body: { data: Buffer.from("body").toString("base64") },
                headers: [
                  { name: "From", value: m.from },
                  { name: "Subject", value: "Re: test" },
                ],
              },
            })),
          },
        }),
      },
    },
  };
  return gmail as unknown as gmail_v1.Gmail;
}

test.describe("parseGmailThread direction classification", () => {
  test.it("alias-sent operator reply with SENT label is outbound", async () => {
    const gmail = makeFakeGmailThread([
      { id: "m1", from: "Michael <michael@mobupps.com>", labelIds: ["SENT"], internalDate: "1784178900000" },
      { id: "m2", from: "Jess <jess@tilt.com>", labelIds: ["INBOX"], internalDate: "1784179000000" },
      // The alias reply that the old substring check classified as inbound,
      // which failed Validator 1 with "most recent message is from the
      // prospect" on correctly-labeled ghosted threads.
      { id: "m3", from: "Michael A.G <michael.a.g@mobupps.com>", labelIds: ["SENT"], internalDate: "1784179100000" },
    ]);

    const briefs = await parseGmailThread(gmail, "t1", "michael@mobupps.com");
    assert.equal(briefs.length, 3);
    assert.deepEqual(
      briefs.map((b) => b.direction),
      ["outbound", "inbound", "outbound"],
    );
  });

  test.it("prospect reply stays inbound", async () => {
    const gmail = makeFakeGmailThread([
      { id: "m1", from: "michael@mobupps.com", labelIds: ["SENT"], internalDate: "1784178900000" },
      { id: "m2", from: "jess@tilt.com", labelIds: ["INBOX"], internalDate: "1784179000000" },
    ]);
    const briefs = await parseGmailThread(gmail, "t1", "michael@mobupps.com");
    assert.deepEqual(briefs.map((b) => b.direction), ["outbound", "inbound"]);
  });

  test.it("DRAFT messages are excluded from the parsed thread entirely", async () => {
    // The draft_in_gmail flow puts an open draft in every campaign thread;
    // it must be invisible to the validators (neither the seed nor a
    // "prospect reply", and never the source of the prospect identity).
    const gmail = makeFakeGmailThread([
      { id: "m1", from: "michael@mobupps.com", labelIds: ["SENT"], internalDate: "1784178900000" },
      { id: "m2", from: "jess@tilt.com", labelIds: ["INBOX"], internalDate: "1784179000000" },
      { id: "m3", from: "michael@mobupps.com", labelIds: ["SENT"], internalDate: "1784179100000" },
      { id: "d1", from: "michael@mobupps.com", labelIds: ["DRAFT"], internalDate: "1784179200000" },
    ]);
    const briefs = await parseGmailThread(gmail, "t1", "michael@mobupps.com");
    assert.deepEqual(briefs.map((b) => b.id), ["m1", "m2", "m3"]);
    // Most recent surviving message is the operator's SENT follow-up, so
    // Validator 1 ("last message is yours") still holds despite the draft.
    assert.equal(briefs[briefs.length - 1].direction, "outbound");
  });
});

// ── classifyThreadInbound: drafts are never replies ──────────────────────

function makeFakeGmailMetadataThread(messages: FakeThreadMsg[]) {
  const gmail = {
    users: {
      threads: {
        get: async (_params: { id: string; format?: string }) => ({
          data: {
            messages: messages.map((m) => ({
              id: m.id,
              labelIds: m.labelIds,
              internalDate: m.internalDate,
              snippet: "snippet",
              payload: {
                headers: [
                  { name: "From", value: m.from },
                  { name: "Subject", value: "Re: test" },
                ],
              },
            })),
          },
        }),
      },
    },
  };
  return gmail as unknown as gmail_v1.Gmail;
}

test.describe("classifyThreadInbound draft handling", () => {
  test.it("an open draft in the thread is NOT a reply (draft_in_gmail regression)", async () => {
    const gmail = makeFakeGmailMetadataThread([
      { id: "m1", from: "michael@mobupps.com", labelIds: ["SENT"], internalDate: "1784178900000" },
      // The scheduler's own in-thread draft: From = operator, not a bounce,
      // not OOO. Before the DRAFT skip this set sawHumanReply=true and
      // killed the campaign one tick after F1 was drafted.
      { id: "d1", from: "michael@mobupps.com", labelIds: ["DRAFT"], internalDate: "1784179000000" },
    ]);
    const verdict = await classifyThreadInbound("t1", "michael@mobupps.com", gmail);
    assert.equal(verdict.kind, "none");
  });

  test.it("a genuine prospect reply alongside a draft still classifies as reply", async () => {
    const gmail = makeFakeGmailMetadataThread([
      { id: "m1", from: "michael@mobupps.com", labelIds: ["SENT"], internalDate: "1784178900000" },
      { id: "m2", from: "jess@tilt.com", labelIds: ["INBOX"], internalDate: "1784179000000" },
      { id: "d1", from: "michael@mobupps.com", labelIds: ["DRAFT"], internalDate: "1784179100000" },
    ]);
    const verdict = await classifyThreadInbound("t1", "michael@mobupps.com", gmail);
    assert.equal(verdict.kind, "reply");
    assert.equal(verdict.latestInboundMessageId, "m2");
  });

  test.it("alias-sent operator follow-up (SENT label) is not a reply", async () => {
    const gmail = makeFakeGmailMetadataThread([
      { id: "m1", from: "michael@mobupps.com", labelIds: ["SENT"], internalDate: "1784178900000" },
      { id: "m2", from: "Michael A.G <michael.a.g@mobupps.com>", labelIds: ["SENT"], internalDate: "1784179000000" },
    ]);
    const verdict = await classifyThreadInbound("t1", "michael@mobupps.com", gmail);
    assert.equal(verdict.kind, "none");
  });
});

// ── listThreadsWithAnyLabel (OR union, not AND) ──────────────────────────

function makeFakeGmailThreadList(byLabel: Record<string, string[]>) {
  const calls: Array<{ labelIds?: string[]; maxResults?: number }> = [];
  const gmail = {
    users: {
      threads: {
        list: async (params: { labelIds?: string[]; maxResults?: number }) => {
          calls.push(params);
          // Emulate the REAL Gmail AND semantics: with multiple labelIds a
          // thread must carry all of them; our fake only serves single-label
          // queries, mirroring how the helper is supposed to call it.
          assert.equal(params.labelIds?.length, 1, "helper must query one label at a time");
          const ids = byLabel[params.labelIds![0]] ?? [];
          return { data: { threads: ids.map((id) => ({ id })) } };
        },
      },
    },
  };
  return { gmail: gmail as unknown as gmail_v1.Gmail, calls };
}

test.describe("listThreadsWithAnyLabel", () => {
  test.it("unions results across labels, deduping by thread id", async () => {
    const { gmail, calls } = makeFakeGmailThreadList({
      L1: ["t1", "t2"],
      L2: ["t2", "t3"],
    });
    const threads = await listThreadsWithAnyLabel(gmail, ["L1", "L2"], 50);
    assert.deepEqual(threads.map((t) => t.id), ["t1", "t2", "t3"]);
    assert.equal(calls.length, 2);
  });

  test.it("caps the union at maxResults", async () => {
    const { gmail } = makeFakeGmailThreadList({
      L1: ["t1", "t2", "t3"],
      L2: ["t4", "t5"],
    });
    const threads = await listThreadsWithAnyLabel(gmail, ["L1", "L2"], 3);
    assert.deepEqual(threads.map((t) => t.id), ["t1", "t2", "t3"]);
  });

  test.it("empty label list returns empty without calling Gmail", async () => {
    const { gmail, calls } = makeFakeGmailThreadList({});
    const threads = await listThreadsWithAnyLabel(gmail, [], 50);
    assert.deepEqual(threads, []);
    assert.equal(calls.length, 0);
  });
});
