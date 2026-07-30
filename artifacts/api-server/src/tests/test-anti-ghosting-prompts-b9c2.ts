/**
 * test-anti-ghosting-prompts-b9c2.ts — Batch B9c.2 unit tests
 *
 * Covers the pure-function surface of the AntiGhosting prompt module:
 *
 *   - computeDaysSinceSeedTier: 30d / 6mo boundaries, exact-day edges
 *   - getAntiGhostingGeneratorUserPrompt: parameter rendering, tier
 *     guidance inclusion, cycle awareness, thread formatting
 *   - getAntiGhostingCriticUserPrompt: draft inclusion, parameter
 *     rendering, last-inbound anchor presence
 *   - getAntiGhostingRewriterUserPrompt: critique inclusion, fallback
 *     when issues/suggestions are empty
 *   - ANTI_GHOSTING_FORBIDDEN_PHRASES: catalogue check, no
 *     unintended overlap with legitimate phrases
 *
 * The actual LLM call paths (generateAntiGhostingFollowup, critic,
 * rewriter) require a real Anthropic API and live under integration
 * tests rather than this unit suite.
 *
 * Run via:
 *   pnpm --filter @workspace/api-server exec tsx --test \\
 *     artifacts/api-server/src/tests/test-anti-ghosting-prompts-b9c2.ts
 */

import * as test from "node:test";
import * as assert from "node:assert/strict";

import {
  computeDaysSinceSeedTier,
  getAntiGhostingGeneratorUserPrompt,
  getAntiGhostingCriticUserPrompt,
  getAntiGhostingRewriterUserPrompt,
  ANTI_GHOSTING_FORBIDDEN_PHRASES,
  ANTI_GHOSTING_GENERATOR_SYSTEM,
  ANTI_GHOSTING_CRITIC_SYSTEM,
  ANTI_GHOSTING_REWRITER_SYSTEM,
} from "../services/antiGhostingFollowupPrompts";
import type { AntiGhostingFollowupContext } from "../services/antiGhostingFollowupPrompts";

// ──────────────────────────────────────────────────────────────────────
// Fixture
// ──────────────────────────────────────────────────────────────────────

function buildCtx(overrides: Partial<AntiGhostingFollowupContext> = {}): AntiGhostingFollowupContext {
  return {
    prospect_name: "Sarah Chen",
    prospect_email: "sarah@acme.com",
    company: "Acme Corp",
    sender_name: "Michael Goder",
    seed_subject: "MAFO integration kickoff",
    seed_body: "Hi Sarah, here is the integration spec we discussed...",
    thread_messages: [
      {
        direction: "outbound",
        sentAt: new Date("2026-02-10T10:00:00Z"),
        fromName: "Michael Goder",
        fromEmail: "michael@mobupps.com",
        subject: "MAFO integration kickoff",
        body: "Hi Sarah, here is the integration spec we discussed...",
      },
      {
        direction: "inbound",
        sentAt: new Date("2026-02-12T14:00:00Z"),
        fromName: "Sarah Chen",
        fromEmail: "sarah@acme.com",
        subject: "Re: MAFO integration kickoff",
        body: "Thanks Michael, the spec looks good. I'll loop in our engineering lead this week.",
      },
      {
        direction: "outbound",
        sentAt: new Date("2026-02-19T09:00:00Z"),
        fromName: "Michael Goder",
        fromEmail: "michael@mobupps.com",
        subject: "Re: MAFO integration kickoff",
        body: "Sounds good. Let me know once they have eyes on it and we can set up a working session.",
      },
    ],
    stage: 1,
    cycle: 1,
    days_since_seed: 12,
    days_since_seed_tier: "lt_30d",
    original_language: "en",
    previous_followups: undefined,
    ...overrides,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Section 1 — computeDaysSinceSeedTier
// ──────────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

test.describe("B9c.2 computeDaysSinceSeedTier", () => {
  test.it("1 day ago is lt_30d", () => {
    const now = new Date("2026-05-17T00:00:00Z");
    const sentAt = new Date(now.getTime() - 1 * DAY_MS);
    assert.equal(computeDaysSinceSeedTier(sentAt, now), "lt_30d");
  });

  test.it("29 days ago is lt_30d", () => {
    const now = new Date("2026-05-17T00:00:00Z");
    const sentAt = new Date(now.getTime() - 29 * DAY_MS);
    assert.equal(computeDaysSinceSeedTier(sentAt, now), "lt_30d");
  });

  test.it("30 days ago crosses to 30d_to_6mo", () => {
    const now = new Date("2026-05-17T00:00:00Z");
    const sentAt = new Date(now.getTime() - 30 * DAY_MS);
    assert.equal(computeDaysSinceSeedTier(sentAt, now), "30d_to_6mo");
  });

  test.it("90 days ago is 30d_to_6mo", () => {
    const now = new Date("2026-05-17T00:00:00Z");
    const sentAt = new Date(now.getTime() - 90 * DAY_MS);
    assert.equal(computeDaysSinceSeedTier(sentAt, now), "30d_to_6mo");
  });

  test.it("179 days ago is 30d_to_6mo (just under 6mo)", () => {
    const now = new Date("2026-05-17T00:00:00Z");
    const sentAt = new Date(now.getTime() - 179 * DAY_MS);
    assert.equal(computeDaysSinceSeedTier(sentAt, now), "30d_to_6mo");
  });

  test.it("180 days ago crosses to gt_6mo", () => {
    const now = new Date("2026-05-17T00:00:00Z");
    const sentAt = new Date(now.getTime() - 180 * DAY_MS);
    assert.equal(computeDaysSinceSeedTier(sentAt, now), "gt_6mo");
  });

  test.it("365 days ago is gt_6mo", () => {
    const now = new Date("2026-05-17T00:00:00Z");
    const sentAt = new Date(now.getTime() - 365 * DAY_MS);
    assert.equal(computeDaysSinceSeedTier(sentAt, now), "gt_6mo");
  });
});

// ──────────────────────────────────────────────────────────────────────
// Section 2 — getAntiGhostingGeneratorUserPrompt
// ──────────────────────────────────────────────────────────────────────

test.describe("B9c.2 getAntiGhostingGeneratorUserPrompt", () => {
  test.it("includes the prospect identity and seed subject", () => {
    const prompt = getAntiGhostingGeneratorUserPrompt(buildCtx());
    assert.match(prompt, /Sarah Chen/);
    assert.match(prompt, /sarah@acme\.com/);
    assert.match(prompt, /Acme Corp/);
    assert.match(prompt, /MAFO integration kickoff/);
  });

  test.it("renders the last inbound as the ACKNOWLEDGE anchor", () => {
    const prompt = getAntiGhostingGeneratorUserPrompt(buildCtx());
    assert.match(prompt, /LAST INBOUND \(what they said before going quiet\)/);
    assert.match(prompt, /I'll loop in our engineering lead/);
  });

  test.it("includes tier guidance specific to lt_30d", () => {
    const prompt = getAntiGhostingGeneratorUserPrompt(buildCtx({ days_since_seed_tier: "lt_30d" }));
    assert.match(prompt, /lt_30d: standard re-engagement/);
    assert.doesNotMatch(prompt, /know it's been a while/i);
  });

  test.it("includes tier guidance specific to 30d_to_6mo", () => {
    const prompt = getAntiGhostingGeneratorUserPrompt(buildCtx({ days_since_seed_tier: "30d_to_6mo" }));
    assert.match(prompt, /light gap acknowledgment/i);
    assert.match(prompt, /Coming back to this/i);
  });

  test.it("includes tier guidance specific to gt_6mo with mandatory bridge", () => {
    const prompt = getAntiGhostingGeneratorUserPrompt(buildCtx({ days_since_seed_tier: "gt_6mo" }));
    assert.match(prompt, /explicit gap framing/i);
    assert.match(prompt, /know it's been a while/i);
    assert.match(prompt, /bridge is MANDATORY/);
    assert.match(prompt, /BRIDGE_REQUIRED/);
  });

  test.it("cycle=1 shows no-prior-renewals message", () => {
    const prompt = getAntiGhostingGeneratorUserPrompt(buildCtx({ cycle: 1 }));
    assert.match(prompt, /first AntiGhosting cycle/i);
    assert.match(prompt, /cycle=1/);
  });

  test.it("cycle=2 shows renewal awareness without meta-acknowledgment", () => {
    const prompt = getAntiGhostingGeneratorUserPrompt(buildCtx({ cycle: 2 }));
    assert.match(prompt, /cycle 2 \(a renewal\)/);
    assert.match(prompt, /returning to this/i);
    // No "this is my Nth attempt" — soft cycle awareness only
    assert.match(prompt, /no meta-acknowledgment/i);
  });

  test.it("F1 stage shows soft ASK guidance", () => {
    const prompt = getAntiGhostingGeneratorUserPrompt(buildCtx({ stage: 1 }));
    assert.match(prompt, /F1 \(first re-engagement attempt\)/);
  });

  test.it("F3 stage shows close-the-loop framing", () => {
    const prompt = getAntiGhostingGeneratorUserPrompt(buildCtx({ stage: 3 }));
    assert.match(prompt, /F3 \(third attempt — close the loop\)/);
  });

  test.it("previous followups absent shows 'first AntiGhosting attempt'", () => {
    const prompt = getAntiGhostingGeneratorUserPrompt(buildCtx({ previous_followups: undefined }));
    assert.match(prompt, /first AntiGhosting attempt in this cycle/);
  });

  test.it("previous followups present are rendered with their stage", () => {
    const prompt = getAntiGhostingGeneratorUserPrompt(buildCtx({
      stage: 2,
      previous_followups: [
        { stage: 1, subject: "Re: MAFO integration kickoff", body: "Quick nudge on the engineering review." },
      ],
    }));
    assert.match(prompt, /STAGE 1/);
    assert.match(prompt, /Quick nudge on the engineering review/);
  });

  test.it("thread is rendered chronologically with direction labels", () => {
    const prompt = getAntiGhostingGeneratorUserPrompt(buildCtx());
    assert.match(prompt, /\[1\] SENT \(you\)/);
    assert.match(prompt, /\[2\] RECEIVED \(prospect\)/);
    assert.match(prompt, /\[3\] SENT \(you\)/);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Section 3 — getAntiGhostingCriticUserPrompt
// ──────────────────────────────────────────────────────────────────────

test.describe("B9c.2 getAntiGhostingCriticUserPrompt", () => {
  test.it("includes the draft subject and body verbatim", () => {
    const draft = { subject: "Re: MAFO integration kickoff", body: "Hi Sarah, hope this finds you well. Just checking in." };
    const prompt = getAntiGhostingCriticUserPrompt(buildCtx(), draft);
    assert.match(prompt, /Re: MAFO integration kickoff/);
    assert.match(prompt, /hope this finds you well/);
    assert.match(prompt, /Just checking in/);
  });

  test.it("surfaces tier + stage + cycle so the critic can apply the right rules", () => {
    const prompt = getAntiGhostingCriticUserPrompt(
      buildCtx({ stage: 2, cycle: 2, days_since_seed_tier: "30d_to_6mo" }),
      { subject: "Re: X", body: "Body." },
    );
    assert.match(prompt, /Stage: 2/);
    assert.match(prompt, /Cycle: 2/);
    assert.match(prompt, /tier: 30d_to_6mo/);
  });

  test.it("provides the last inbound as the ACKNOWLEDGE anchor for grading", () => {
    const prompt = getAntiGhostingCriticUserPrompt(buildCtx(), { subject: "x", body: "y" });
    assert.match(prompt, /Last inbound \(the anchor for ACKNOWLEDGE\)/);
    assert.match(prompt, /loop in our engineering lead/);
  });

  test.it("truncates the last inbound body if it exceeds 500 chars (with ellipsis marker)", () => {
    const longBody = "x".repeat(2000);
    const prompt = getAntiGhostingCriticUserPrompt(
      buildCtx({
        thread_messages: [
          {
            direction: "inbound",
            sentAt: new Date("2026-02-12T14:00:00Z"),
            fromName: "Sarah Chen",
            fromEmail: "sarah@acme.com",
            subject: "Re: x",
            body: longBody,
          },
        ],
      }),
      { subject: "x", body: "y" },
    );
    assert.match(prompt, /\.\.\.$|\.\.\.\n/m);
    // Ensure the prompt itself isn't 2000+ chars from the body
    assert.ok(prompt.length < 3000, `prompt unexpectedly long: ${prompt.length} chars`);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Section 4 — getAntiGhostingRewriterUserPrompt
// ──────────────────────────────────────────────────────────────────────

test.describe("B9c.2 getAntiGhostingRewriterUserPrompt", () => {
  test.it("lists each critic issue as a bullet", () => {
    const prompt = getAntiGhostingRewriterUserPrompt(
      buildCtx(),
      { subject: "Re: X", body: "Y" },
      { issues: ["generic_acknowledge: no specific reference to last inbound", "forbidden_phrase: 'just checking in'"], suggestions: [] },
    );
    assert.match(prompt, /- generic_acknowledge/);
    assert.match(prompt, /- forbidden_phrase/);
  });

  test.it("lists each suggestion as a bullet", () => {
    const prompt = getAntiGhostingRewriterUserPrompt(
      buildCtx(),
      { subject: "Re: X", body: "Y" },
      { issues: [], suggestions: ["reference the engineering review explicitly", "remove 'just checking in'"] },
    );
    assert.match(prompt, /- reference the engineering review explicitly/);
    assert.match(prompt, /- remove 'just checking in'/);
  });

  test.it("falls back to '(none flagged)' when no issues are provided", () => {
    const prompt = getAntiGhostingRewriterUserPrompt(
      buildCtx(),
      { subject: "Re: X", body: "Y" },
      { issues: [], suggestions: [] },
    );
    assert.match(prompt, /CRITIC ISSUES.*\n\(none flagged\)/);
  });

  test.it("includes the original draft for the rewriter to revise", () => {
    const prompt = getAntiGhostingRewriterUserPrompt(
      buildCtx(),
      { subject: "Re: MAFO integration kickoff", body: "The first attempt body." },
      { issues: [], suggestions: [] },
    );
    assert.match(prompt, /The first attempt body\./);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Section 5 — ANTI_GHOSTING_FORBIDDEN_PHRASES + system prompts
// ──────────────────────────────────────────────────────────────────────

test.describe("B9c.2 forbidden phrases and system prompts", () => {
  test.it("forbidden list contains the locked design entries", () => {
    const required = [
      "just checking in",
      "just wanted to follow up",
      "bumping this up",
      "wanted to touch base",
      "hope this finds you well",
    ];
    for (const phrase of required) {
      assert.ok(
        ANTI_GHOSTING_FORBIDDEN_PHRASES.includes(phrase),
        `forbidden list missing "${phrase}"`,
      );
    }
  });

  test.it("'circling back' is NOT forbidden (legitimate per locked design)", () => {
    assert.ok(
      !ANTI_GHOSTING_FORBIDDEN_PHRASES.some((p) => p.toLowerCase().includes("circling")),
      "'circling back' should be allowed but appeared in the forbidden list",
    );
  });

  test.it("writer system prompt enumerates all forbidden phrases explicitly", () => {
    for (const phrase of ANTI_GHOSTING_FORBIDDEN_PHRASES) {
      assert.ok(
        ANTI_GHOSTING_GENERATOR_SYSTEM.toLowerCase().includes(phrase.toLowerCase()),
        `writer system missing forbidden phrase: "${phrase}"`,
      );
    }
  });

  test.it("critic system prompt mentions every score dimension", () => {
    const dimensions = [
      "acknowledge_quality",
      "bridge_legitimacy",
      "ask_specificity",
      "tone_tier_match",
      "forbidden_phrase",
      "language_consistency",
      "structural_completeness",
    ];
    for (const dim of dimensions) {
      assert.ok(
        ANTI_GHOSTING_CRITIC_SYSTEM.includes(dim),
        `critic system missing dimension: ${dim}`,
      );
    }
  });

  test.it("rewriter system prompt repeats the forbidden list (so rewriter doesn't re-introduce them)", () => {
    for (const phrase of ANTI_GHOSTING_FORBIDDEN_PHRASES) {
      assert.ok(
        ANTI_GHOSTING_REWRITER_SYSTEM.toLowerCase().includes(phrase.toLowerCase()),
        `rewriter system missing forbidden phrase: "${phrase}"`,
      );
    }
  });

  test.it("all three system prompts require JSON-only output", () => {
    assert.match(ANTI_GHOSTING_GENERATOR_SYSTEM, /JSON only/i);
    assert.match(ANTI_GHOSTING_CRITIC_SYSTEM, /JSON only/i);
    assert.match(ANTI_GHOSTING_REWRITER_SYSTEM, /JSON only/i);
  });
});
