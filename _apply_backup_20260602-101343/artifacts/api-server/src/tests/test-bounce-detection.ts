/**
 * test-bounce-detection.ts
 *
 * Self-contained tests for the bounce / NDR classifier. Uses Node's built-in
 * test runner (no jest/vitest). Run with:
 *   pnpm --filter @workspace/api-server exec tsx --test tests/test-bounce-detection.ts
 *
 * Coverage:
 *  1. mailer-daemon hard bounce (550 No such user) → hard bounce.
 *  2. Postmaster soft bounce (mailbox full / 4xx) → soft bounce.
 *  3. DSN subject with no parseable code → bounce (defaults hard).
 *  4. Out-of-office auto-reply from a real mailbox → NOT a bounce.
 *  5. Plain human reply → NOT a bounce.
 *  6. The exact production sample (Shinhan 550 5.1.1 No such user) → hard.
 */

import * as test from "node:test";
import * as assert from "node:assert/strict";

import { classifyBounce } from "../lib/bounceDetection";

test.describe("classifyBounce", () => {
  test.it("mailer-daemon 550 No such user is a hard bounce", () => {
    const v = classifyBounce(
      "Mail Delivery System <mailer-daemon@ppe-hosted.com>",
      "Undelivered Mail Returned to Sender",
      "host mail.shinhan.com said: 550 5.1.1 No such user",
    );
    assert.equal(v.isBounce, true);
    assert.equal(v.kind, "hard");
  });

  test.it("postmaster mailbox-full 452 is a soft bounce", () => {
    const v = classifyBounce(
      "postmaster@example.com",
      "Delivery Status Notification (Delay)",
      "452 4.2.2 The recipient's mailbox is full and cannot accept messages now",
    );
    assert.equal(v.isBounce, true);
    assert.equal(v.kind, "soft");
  });

  test.it("DSN subject with no code still flags as bounce", () => {
    const v = classifyBounce(
      "Mail Delivery Subsystem <mailer-daemon@googlemail.com>",
      "Delivery Status Notification (Failure)",
      "There was a problem delivering your message.",
    );
    assert.equal(v.isBounce, true);
    assert.equal(v.kind, "hard");
  });

  test.it("out-of-office auto-reply from a real mailbox is NOT a bounce", () => {
    const v = classifyBounce(
      "Sanjay Sri <sanjaysri@shinhan.com>",
      "Automatic reply: Funded-account campaigns",
      "I am currently out of the office and will return Monday.",
    );
    assert.equal(v.isBounce, false);
  });

  test.it("a normal human reply is NOT a bounce", () => {
    const v = classifyBounce(
      "Sanjay Sri <sanjaysri@shinhan.com>",
      "Re: Funded-account campaigns for Shinhan Bank India",
      "Thanks Michael, happy to discuss. Can we talk Thursday?",
    );
    assert.equal(v.isBounce, false);
  });

  test.it("production Shinhan sample classifies hard", () => {
    const v = classifyBounce(
      "Mail Delivery System <mailer-daemon@ppe-hosted.com>",
      "Undelivered Mail Returned to Sender",
      "<sanjaysri@shinhan.com>: host mail.shinhan.com[14.36.212.1] said: 550 5.1.1 No such user <sanjaysri@shinhan.com> (in reply to RCPT TO command)",
    );
    assert.equal(v.isBounce, true);
    assert.equal(v.kind, "hard");
    assert.ok((v.detail || "").length > 0);
  });
});
