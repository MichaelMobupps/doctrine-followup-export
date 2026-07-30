/**
 * test-gmail-sync-hardening.ts
 *
 * Hermetic tests for the 2026-07-16 sync-starvation fixes in gmailClient.ts:
 *  - safeSentAt(): malformed Date headers must never produce Invalid Date
 *    (an Invalid Date sentAt used to throw inside the prospects INSERT and
 *    abort the user's whole sync pass).
 *  - fetchLabeledSentEmails(): the skipIds prefilter must skip the expensive
 *    per-message format:"full" fetch for already-ingested IDs, paginate
 *    fully, keep per-message error containment, and build the label query
 *    with spaces folded to hyphens ("Doctrine SDR" → label:Doctrine-SDR).
 *
 * No DB, no network — the Gmail client is a hand-rolled fake.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx --test src/tests/test-gmail-sync-hardening.ts
 */

import * as test from "node:test";
import * as assert from "node:assert/strict";
import type { gmail_v1 } from "googleapis";

import { safeSentAt, fetchLabeledSentEmails } from "../services/gmailClient";

test.describe("safeSentAt", () => {
  test.it("uses a valid RFC2822 Date header", () => {
    const d = safeSentAt({ date: "Tue, 14 Jul 2026 09:15:00 +0100", internalDate: "0" });
    assert.equal(d.toISOString(), "2026-07-14T08:15:00.000Z");
  });

  test.it("falls back to internalDate when the header is malformed", () => {
    const d = safeSentAt({ date: "mardi 14 juillet 2026", internalDate: "1784178900000" });
    assert.equal(d.getTime(), 1784178900000);
  });

  test.it("falls back to internalDate when the header is empty", () => {
    const d = safeSentAt({ date: "", internalDate: "1784178900000" });
    assert.equal(d.getTime(), 1784178900000);
  });

  test.it("falls back to now when both are unusable — never Invalid Date", () => {
    const before = Date.now();
    const d = safeSentAt({ date: "not a date", internalDate: "" });
    assert.ok(!isNaN(d.getTime()), "must be a valid Date");
    assert.ok(d.getTime() >= before && d.getTime() <= Date.now() + 1000);
  });
});

// ── Fake Gmail client ────────────────────────────────────────────────────
// Two list pages; messages.get returns a minimal full-format payload and
// records every fetched ID so tests can assert what was (not) fetched.

type FakeMsg = { id: string; threadId: string; date?: string; getThrows?: boolean };

function makeFakeGmail(msgs: FakeMsg[], pageSize: number) {
  const fetchedIds: string[] = [];
  const listQueries: string[] = [];
  const byId = new Map(msgs.map((m) => [m.id, m]));

  const gmail = {
    users: {
      messages: {
        list: async (params: { q?: string; pageToken?: string; maxResults?: number }) => {
          listQueries.push(params.q || "");
          const start = params.pageToken ? parseInt(params.pageToken, 10) : 0;
          const page = msgs.slice(start, start + pageSize);
          const next = start + pageSize < msgs.length ? String(start + pageSize) : undefined;
          return { data: { messages: page.map((m) => ({ id: m.id })), nextPageToken: next } };
        },
        get: async (params: { id: string }) => {
          const m = byId.get(params.id)!;
          if (m.getThrows) throw new Error(`simulated Gmail 429 for ${params.id}`);
          fetchedIds.push(params.id);
          return {
            data: {
              id: m.id,
              threadId: m.threadId,
              internalDate: "1784178900000",
              snippet: "",
              labelIds: ["Label_42"],
              payload: {
                mimeType: "text/plain",
                body: { data: Buffer.from("hello body").toString("base64") },
                headers: [
                  { name: "From", value: "shama@mobupps.com" },
                  { name: "To", value: "Talya <tweigl@jellycat.com>" },
                  { name: "Subject", value: "Jellycat & MobUpps" },
                  { name: "Date", value: m.date ?? "Tue, 14 Jul 2026 09:15:00 +0000" },
                ],
              },
            },
          };
        },
      },
    },
  };
  return { gmail: gmail as unknown as gmail_v1.Gmail, fetchedIds, listQueries };
}

test.describe("fetchLabeledSentEmails", () => {
  test.it("skips detail fetches for known IDs and counts them", async () => {
    const msgs: FakeMsg[] = [
      { id: "new1", threadId: "t1" },
      { id: "old1", threadId: "t2" },
      { id: "old2", threadId: "t3" },
      { id: "new2", threadId: "t4" },
    ];
    const { gmail, fetchedIds } = makeFakeGmail(msgs, 3);
    const res = await fetchLabeledSentEmails(
      ["Doctrine SDR"],
      "2026/05/17",
      gmail,
      new Set(["old1", "old2"]),
    );
    assert.deepEqual(fetchedIds, ["new1", "new2"], "known IDs must not be detail-fetched");
    assert.equal(res.skippedKnown, 2);
    assert.deepEqual(res.messages.map((m) => m.id), ["new1", "new2"]);
    assert.equal(res.messages[0].internalDate, "1784178900000");
  });

  test.it("paginates across list pages", async () => {
    const msgs: FakeMsg[] = Array.from({ length: 7 }, (_, i) => ({ id: `m${i}`, threadId: `t${i}` }));
    const { gmail, listQueries } = makeFakeGmail(msgs, 3);
    const res = await fetchLabeledSentEmails(["Doctrine SDR"], undefined, gmail);
    assert.equal(res.messages.length, 7);
    assert.equal(listQueries.length, 3, "7 items at page size 3 → 3 list calls");
  });

  test.it("folds label spaces to hyphens and scopes to in:sent + after:", async () => {
    const { gmail, listQueries } = makeFakeGmail([], 100);
    await fetchLabeledSentEmails(["Doctrine SDR", "Context Followuper"], "2026/05/17", gmail);
    assert.equal(
      listQueries[0],
      "in:sent (label:Doctrine-SDR OR label:Context-Followuper) after:2026/05/17",
    );
  });

  test.it("one throwing messages.get does not abort the rest", async () => {
    const msgs: FakeMsg[] = [
      { id: "a", threadId: "t1" },
      { id: "boom", threadId: "t2", getThrows: true },
      { id: "b", threadId: "t3" },
    ];
    const { gmail } = makeFakeGmail(msgs, 100);
    const res = await fetchLabeledSentEmails(["Doctrine SDR"], undefined, gmail);
    assert.deepEqual(res.messages.map((m) => m.id), ["a", "b"]);
  });
});
