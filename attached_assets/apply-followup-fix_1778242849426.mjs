#!/usr/bin/env node
/**
 * Idempotent patch: fix follow-up stage collapse.
 *
 * Bug: when prospect.sentAt is older than the configured stage windows
 * (e.g., 3-7 / 10-14 / 21-28 days), generateScheduledTime returns a date
 * in the past for every stage. The fallback bumped every stage to
 * "now + 1 hour", so F1, F2, F3 fired ~1 hour apart on the same day
 * instead of days apart per the configured cadence.
 *
 * Fix:
 *  - Add computeNextStageScheduledAt() in timingEngine.ts. For stage > 1
 *    when the absolute window has passed, it anchors on the previous
 *    stage's actual sent time and applies the inter-stage gap implied
 *    by the user's configured windows (e.g. 10-14 vs 3-7 -> gap 3-11
 *    days). For stage 1 with no previous stage to anchor on, it keeps
 *    the existing "send soon" catch-up behavior.
 *  - Replace all four call sites (autoQueueAllCampaigns + 3 routes) to
 *    use the helper and pass lastFollowupSentAt where available.
 *  - Extend the existingFollowups SELECTs at three sites to include
 *    followupsTable.sentAt and track the latest sent stage's sentAt.
 *
 * Idempotent: every step checks for an "already applied" anchor before
 * writing. Re-running is a no-op.
 */
import fs from "node:fs";
import path from "node:path";

// Default to live Replit path. Override via SRC_BASE env var if needed.
const SRC_BASE = process.env.SRC_BASE || "artifacts/api-server/src";

const TIMING = path.join(SRC_BASE, "services/timingEngine.ts");
const SCHED = path.join(SRC_BASE, "services/scheduler.ts");
const DOCTRINE = path.join(SRC_BASE, "routes/doctrine.ts");

const APPLIED_MARKER = "computeNextStageScheduledAt";

let changed = 0;
let skipped = 0;

function read(p) {
  if (!fs.existsSync(p)) {
    console.error(`[fail] file not found: ${p}`);
    process.exit(1);
  }
  return fs.readFileSync(p, "utf8");
}

function write(p, s) {
  fs.writeFileSync(p, s, "utf8");
}

function replaceOnce(filePath, label, oldStr, newStr) {
  const src = read(filePath);
  if (src.includes(newStr)) {
    console.log(`  [skip] ${label} (already applied)`);
    skipped++;
    return;
  }
  const occurrences = src.split(oldStr).length - 1;
  if (occurrences === 0) {
    console.error(`  [fail] ${label}: anchor not found`);
    console.error(`         expected:\n${oldStr.split("\n").slice(0, 3).join("\n")}...`);
    process.exit(1);
  }
  if (occurrences > 1) {
    console.error(`  [fail] ${label}: anchor matched ${occurrences} times — must be unique`);
    process.exit(1);
  }
  write(filePath, src.replace(oldStr, newStr));
  console.log(`  [ok] ${label}`);
  changed++;
}

// ---------- 1. timingEngine.ts: add computeNextStageScheduledAt helper ----------

console.log(`\n[1/4] ${TIMING}`);

const timingOldEnd = `export function generateBatchSchedule(`;
const timingHelper = `/**
 * Compute scheduledAt for the next stage of a follow-up sequence.
 *
 * Default semantics: stages are anchored to the prospect's initial email
 * (e.g. "stage 2 = 10-14 days after initial"). When the initial email is
 * recent enough that the absolute window is still in the future, we use
 * it directly.
 *
 * Catch-up semantics: when the initial email is older than the configured
 * windows (imported prospects, paused-and-resumed campaigns, system
 * downtime), the absolute window for every stage falls in the past. The
 * earlier behavior collapsed every stage onto "now + 1 hour", which sent
 * F1, F2, F3 within an hour of each other instead of days apart.
 *
 * Catch-up path:
 *   - Stage 1 (no previous stage to space against): send "now + 1 hour".
 *   - Stage > 1: anchor on the previous stage's sent time and apply the
 *     inter-stage gap implied by the user's configured windows:
 *       minGap = max(1, currentStage.minDays - previousStage.maxDays)
 *       maxGap = max(minGap, currentStage.maxDays - previousStage.minDays)
 *     This preserves the user's intended cadence between consecutive
 *     stages and snaps to the configured send-day / send-hour window.
 */
export function computeNextStageScheduledAt(args: {
  stage: number;
  initialSentAt: Date;
  lastFollowupSentAt?: Date | null;
  userSettings?: UserTimingSettings;
  now?: Date;
}): Date {
  const { stage, initialSentAt, lastFollowupSentAt, userSettings } = args;
  const now = args.now ?? new Date();

  const window = getScheduleWindow(stage, userSettings);

  // Primary path: honor the configured "X days after initial" window
  // when the result is still in the future.
  const absolute = new Date(generateScheduledTime(window, initialSentAt));
  if (absolute > now) return absolute;

  // Catch-up path: absolute window is in the past.
  if (stage <= 1) {
    // No previous stage to anchor on. Send F1 in roughly an hour.
    return new Date(now.getTime() + 60 * 60 * 1000);
  }

  // Stage > 1: anchor on the previous stage's send time and apply the
  // inter-stage gap implied by the user's configured windows.
  const prev = getScheduleWindow(stage - 1, userSettings);
  const minGapDays = Math.max(1, window.min_days - prev.max_days);
  const maxGapDays = Math.max(minGapDays, window.max_days - prev.min_days);

  const anchor = lastFollowupSentAt
    ? new Date(Math.max(lastFollowupSentAt.getTime(), now.getTime()))
    : now;

  const gapWindow: ScheduleWindow = {
    min_days: minGapDays,
    max_days: maxGapDays,
    hour_start: window.hour_start,
    hour_end: window.hour_end,
    sendDays: window.sendDays,
  };

  return new Date(generateScheduledTime(gapWindow, anchor));
}

export function generateBatchSchedule(`;

replaceOnce(TIMING, "add computeNextStageScheduledAt helper", timingOldEnd, timingHelper);

// ---------- 2. scheduler.ts: fetch sentAt, track lastSentAt, use helper ----------

console.log(`\n[2/4] ${SCHED}`);

// 2a. Import the new helper
replaceOnce(
  SCHED,
  "import computeNextStageScheduledAt",
  `import { getScheduleWindow, generateScheduledTime } from "./timingEngine";`,
  `import { computeNextStageScheduledAt } from "./timingEngine";`,
);

// 2b. Extend existingFollowups SELECT to include sentAt
replaceOnce(
  SCHED,
  "select sentAt on existingFollowups",
  `  const existingFollowups = await db
    .select({
      prospectId: followupsTable.prospectId,
      stage: followupsTable.stage,
      status: followupsTable.status,
    })
    .from(followupsTable)
    .where(inArray(followupsTable.prospectId, prospectIds));

  const prospectFollowupMap = new Map<number, { maxSentStage: number; hasActive: boolean }>();
  for (const f of existingFollowups) {
    const entry = prospectFollowupMap.get(f.prospectId) || { maxSentStage: 0, hasActive: false };
    if (f.status === "sent" && f.stage > entry.maxSentStage) entry.maxSentStage = f.stage;
    if (["queued", "generating", "pending_approval"].includes(f.status)) entry.hasActive = true;
    prospectFollowupMap.set(f.prospectId, entry);
  }`,
  `  const existingFollowups = await db
    .select({
      prospectId: followupsTable.prospectId,
      stage: followupsTable.stage,
      status: followupsTable.status,
      sentAt: followupsTable.sentAt,
    })
    .from(followupsTable)
    .where(inArray(followupsTable.prospectId, prospectIds));

  const prospectFollowupMap = new Map<number, { maxSentStage: number; hasActive: boolean; lastSentAt: Date | null }>();
  for (const f of existingFollowups) {
    const entry = prospectFollowupMap.get(f.prospectId) || { maxSentStage: 0, hasActive: false, lastSentAt: null };
    if (f.status === "sent" && f.stage > entry.maxSentStage) {
      entry.maxSentStage = f.stage;
      entry.lastSentAt = f.sentAt;
    }
    if (["queued", "generating", "pending_approval"].includes(f.status)) entry.hasActive = true;
    prospectFollowupMap.set(f.prospectId, entry);
  }`,
);

// 2c. Replace per-prospect schedule computation
replaceOnce(
  SCHED,
  "use helper in autoQueueAllCampaigns",
  `    const userFull = prospect.userId ? userById.get(prospect.userId) : undefined;
    const userSettings = userFull ? {
      stageTiming: userFull.stageTiming,
      sendDays: userFull.sendDays,
      sendHourStart: userFull.sendHourStart,
      sendHourEnd: userFull.sendHourEnd,
    } : undefined;
    const window = getScheduleWindow(nextStage, userSettings);
    const scheduledIso = generateScheduledTime(window, prospect.sentAt);
    let scheduledAt = new Date(scheduledIso);
    if (scheduledAt < new Date()) {
      scheduledAt = new Date(Date.now() + 60 * 60 * 1000);
    }`,
  `    const userFull = prospect.userId ? userById.get(prospect.userId) : undefined;
    const userSettings = userFull ? {
      stageTiming: userFull.stageTiming,
      sendDays: userFull.sendDays,
      sendHourStart: userFull.sendHourStart,
      sendHourEnd: userFull.sendHourEnd,
    } : undefined;
    const scheduledAt = computeNextStageScheduledAt({
      stage: nextStage,
      initialSentAt: prospect.sentAt,
      lastFollowupSentAt: info?.lastSentAt ?? null,
      userSettings,
    });`,
);

// ---------- 3. doctrine.ts: 3 sites + add helper to imports ----------

console.log(`\n[3/4] ${DOCTRINE}`);

// 3a. Add computeNextStageScheduledAt to imports
replaceOnce(
  DOCTRINE,
  "import computeNextStageScheduledAt",
  `import { generateBatchSchedule, generateScheduledTime, getScheduleWindow } from "../services/timingEngine";`,
  `import { generateBatchSchedule, generateScheduledTime, getScheduleWindow, computeNextStageScheduledAt } from "../services/timingEngine";`,
);

// 3b. Site 1: POST /prospect/:id/resume — fetch sentAt + use helper
replaceOnce(
  DOCTRINE,
  "resume route: select sentAt + lastSentAt + helper",
  `    const existingFollowups = await db
      .select({ stage: followupsTable.stage, status: followupsTable.status })
      .from(followupsTable)
      .where(eq(followupsTable.prospectId, prospectId));

    const sentStages = existingFollowups.filter((f) => f.status === "sent").map((f) => f.stage);
    const activeStages = existingFollowups.filter((f) => ["queued", "generating", "pending_approval"].includes(f.status));

    let queued_stage: number | null = null;

    if (activeStages.length === 0) {
      const nextStage = sentStages.length > 0 ? Math.max(...sentStages) + 1 : 1;
      if (maxFollowups === null || nextStage <= maxFollowups) {
        const userSettings: UserTimingSettings | undefined = user ? {
          stageTiming: user.stageTiming,
          sendDays: user.sendDays,
          sendHourStart: user.sendHourStart,
          sendHourEnd: user.sendHourEnd,
        } : undefined;
        const window = getScheduleWindow(nextStage, userSettings);
        const scheduledIso = generateScheduledTime(window, p.sentAt);
        let scheduledAt = new Date(scheduledIso);

        if (scheduledAt < new Date()) {
          scheduledAt = new Date(Date.now() + 60 * 60 * 1000);
        }`,
  `    const existingFollowups = await db
      .select({ stage: followupsTable.stage, status: followupsTable.status, sentAt: followupsTable.sentAt })
      .from(followupsTable)
      .where(eq(followupsTable.prospectId, prospectId));

    const sentRows = existingFollowups.filter((f) => f.status === "sent");
    const sentStages = sentRows.map((f) => f.stage);
    const activeStages = existingFollowups.filter((f) => ["queued", "generating", "pending_approval"].includes(f.status));

    let queued_stage: number | null = null;

    if (activeStages.length === 0) {
      const nextStage = sentStages.length > 0 ? Math.max(...sentStages) + 1 : 1;
      if (maxFollowups === null || nextStage <= maxFollowups) {
        const userSettings: UserTimingSettings | undefined = user ? {
          stageTiming: user.stageTiming,
          sendDays: user.sendDays,
          sendHourStart: user.sendHourStart,
          sendHourEnd: user.sendHourEnd,
        } : undefined;
        const lastSentAt = sentRows.length > 0
          ? sentRows.reduce((a, b) => (a.stage > b.stage ? a : b)).sentAt
          : null;
        const scheduledAt = computeNextStageScheduledAt({
          stage: nextStage,
          initialSentAt: p.sentAt,
          lastFollowupSentAt: lastSentAt,
          userSettings,
        });`,
);

// 3c. Site 2: POST /campaign/queue — fetch sentAt + use helper
replaceOnce(
  DOCTRINE,
  "campaign/queue: select sentAt + lastSentAt + helper",
  `    const prospectIds = unrepliedProspects.map((p) => p.id);
    const existingFollowups = await db
      .select({
        prospectId: followupsTable.prospectId,
        stage: followupsTable.stage,
        status: followupsTable.status,
      })
      .from(followupsTable)
      .where(inArray(followupsTable.prospectId, prospectIds));

    const prospectFollowupMap = new Map<number, { maxSentStage: number; hasQueued: boolean }>();
    for (const f of existingFollowups) {
      const entry = prospectFollowupMap.get(f.prospectId) || { maxSentStage: 0, hasQueued: false };
      if (f.status === "sent" && f.stage > entry.maxSentStage) entry.maxSentStage = f.stage;
      if (["queued", "generating", "pending_approval"].includes(f.status)) entry.hasQueued = true;
      prospectFollowupMap.set(f.prospectId, entry);
    }

    const userSettingsMap = new Map<number, UserTimingSettings>();
    for (const u of users) {
      userSettingsMap.set(u.id, {
        stageTiming: u.stageTiming,
        sendDays: u.sendDays,
        sendHourStart: u.sendHourStart,
        sendHourEnd: u.sendHourEnd,
      });
    }

    let queued = 0;
    const now = new Date();

    for (const prospect of unrepliedProspects) {
      const info = prospectFollowupMap.get(prospect.id);
      if (info?.hasQueued) continue;

      const userMaxFollowups = getFollowupCap(users.find(u => u.id === prospect.userId)?.maxFollowups);
      const nextStage = (info?.maxSentStage || 0) + 1;
      if (userMaxFollowups !== null && nextStage > userMaxFollowups) continue;

      const userSettings = prospect.userId ? userSettingsMap.get(prospect.userId) : undefined;
      const window = getScheduleWindow(nextStage, userSettings);
      const scheduledIso = generateScheduledTime(window, prospect.sentAt);
      let scheduledAt = new Date(scheduledIso);

      if (scheduledAt < now) {
        scheduledAt = new Date(now.getTime() + 60 * 60 * 1000);
      }`,
  `    const prospectIds = unrepliedProspects.map((p) => p.id);
    const existingFollowups = await db
      .select({
        prospectId: followupsTable.prospectId,
        stage: followupsTable.stage,
        status: followupsTable.status,
        sentAt: followupsTable.sentAt,
      })
      .from(followupsTable)
      .where(inArray(followupsTable.prospectId, prospectIds));

    const prospectFollowupMap = new Map<number, { maxSentStage: number; hasQueued: boolean; lastSentAt: Date | null }>();
    for (const f of existingFollowups) {
      const entry = prospectFollowupMap.get(f.prospectId) || { maxSentStage: 0, hasQueued: false, lastSentAt: null };
      if (f.status === "sent" && f.stage > entry.maxSentStage) {
        entry.maxSentStage = f.stage;
        entry.lastSentAt = f.sentAt;
      }
      if (["queued", "generating", "pending_approval"].includes(f.status)) entry.hasQueued = true;
      prospectFollowupMap.set(f.prospectId, entry);
    }

    const userSettingsMap = new Map<number, UserTimingSettings>();
    for (const u of users) {
      userSettingsMap.set(u.id, {
        stageTiming: u.stageTiming,
        sendDays: u.sendDays,
        sendHourStart: u.sendHourStart,
        sendHourEnd: u.sendHourEnd,
      });
    }

    let queued = 0;

    for (const prospect of unrepliedProspects) {
      const info = prospectFollowupMap.get(prospect.id);
      if (info?.hasQueued) continue;

      const userMaxFollowups = getFollowupCap(users.find(u => u.id === prospect.userId)?.maxFollowups);
      const nextStage = (info?.maxSentStage || 0) + 1;
      if (userMaxFollowups !== null && nextStage > userMaxFollowups) continue;

      const userSettings = prospect.userId ? userSettingsMap.get(prospect.userId) : undefined;
      const scheduledAt = computeNextStageScheduledAt({
        stage: nextStage,
        initialSentAt: prospect.sentAt,
        lastFollowupSentAt: info?.lastSentAt ?? null,
        userSettings,
      });`,
);

// 3d. Site 3: POST /campaign/launch — fetch sentAt + use helper
replaceOnce(
  DOCTRINE,
  "campaign/launch: select sentAt + lastSentAt + helper",
  `    const prospectIds = unrepliedProspects.map((p) => p.id);
    const existingFollowups = await db
      .select({
        prospectId: followupsTable.prospectId,
        stage: followupsTable.stage,
        status: followupsTable.status,
      })
      .from(followupsTable)
      .where(inArray(followupsTable.prospectId, prospectIds));

    const prospectFollowupMap = new Map<number, { maxSentStage: number; hasQueued: boolean }>();
    for (const f of existingFollowups) {
      const entry = prospectFollowupMap.get(f.prospectId) || { maxSentStage: 0, hasQueued: false };
      if (f.status === "sent" && f.stage > entry.maxSentStage) entry.maxSentStage = f.stage;
      if (["queued", "generating", "pending_approval"].includes(f.status)) entry.hasQueued = true;
      prospectFollowupMap.set(f.prospectId, entry);
    }

    const userSettingsMap = new Map<number, UserTimingSettings>();
    for (const u of users) {
      userSettingsMap.set(u.id, {
        stageTiming: u.stageTiming,
        sendDays: u.sendDays,
        sendHourStart: u.sendHourStart,
        sendHourEnd: u.sendHourEnd,
      });
    }

    let queued = 0;
    const parsedMaxStage = max_stage ? parseInt(max_stage) : null;
    const now = new Date();

    for (const prospect of unrepliedProspects) {
      const info = prospectFollowupMap.get(prospect.id);
      if (info?.hasQueued) continue;

      const nextStage = (info?.maxSentStage || 0) + 1;
      const configuredCap = getFollowupCap(users.find((u) => u.id === prospect.userId)?.maxFollowups);
      const maxStageLimit = (parsedMaxStage && !isNaN(parsedMaxStage) && parsedMaxStage > 0)
        ? parsedMaxStage
        : configuredCap;
      if (maxStageLimit !== null && nextStage > maxStageLimit) continue;

      const userSettings = prospect.userId ? userSettingsMap.get(prospect.userId) : undefined;
      const window = getScheduleWindow(nextStage, userSettings);
      const scheduledIso = generateScheduledTime(window, prospect.sentAt);
      let scheduledAt = new Date(scheduledIso);
      if (scheduledAt < now) {
        scheduledAt = new Date(now.getTime() + 60 * 60 * 1000);
      }`,
  `    const prospectIds = unrepliedProspects.map((p) => p.id);
    const existingFollowups = await db
      .select({
        prospectId: followupsTable.prospectId,
        stage: followupsTable.stage,
        status: followupsTable.status,
        sentAt: followupsTable.sentAt,
      })
      .from(followupsTable)
      .where(inArray(followupsTable.prospectId, prospectIds));

    const prospectFollowupMap = new Map<number, { maxSentStage: number; hasQueued: boolean; lastSentAt: Date | null }>();
    for (const f of existingFollowups) {
      const entry = prospectFollowupMap.get(f.prospectId) || { maxSentStage: 0, hasQueued: false, lastSentAt: null };
      if (f.status === "sent" && f.stage > entry.maxSentStage) {
        entry.maxSentStage = f.stage;
        entry.lastSentAt = f.sentAt;
      }
      if (["queued", "generating", "pending_approval"].includes(f.status)) entry.hasQueued = true;
      prospectFollowupMap.set(f.prospectId, entry);
    }

    const userSettingsMap = new Map<number, UserTimingSettings>();
    for (const u of users) {
      userSettingsMap.set(u.id, {
        stageTiming: u.stageTiming,
        sendDays: u.sendDays,
        sendHourStart: u.sendHourStart,
        sendHourEnd: u.sendHourEnd,
      });
    }

    let queued = 0;
    const parsedMaxStage = max_stage ? parseInt(max_stage) : null;

    for (const prospect of unrepliedProspects) {
      const info = prospectFollowupMap.get(prospect.id);
      if (info?.hasQueued) continue;

      const nextStage = (info?.maxSentStage || 0) + 1;
      const configuredCap = getFollowupCap(users.find((u) => u.id === prospect.userId)?.maxFollowups);
      const maxStageLimit = (parsedMaxStage && !isNaN(parsedMaxStage) && parsedMaxStage > 0)
        ? parsedMaxStage
        : configuredCap;
      if (maxStageLimit !== null && nextStage > maxStageLimit) continue;

      const userSettings = prospect.userId ? userSettingsMap.get(prospect.userId) : undefined;
      const scheduledAt = computeNextStageScheduledAt({
        stage: nextStage,
        initialSentAt: prospect.sentAt,
        lastFollowupSentAt: info?.lastSentAt ?? null,
        userSettings,
      });`,
);

// ---------- 4. Verify ----------

console.log(`\n[4/4] verify`);

const finalTiming = read(TIMING);
const finalSched = read(SCHED);
const finalDoctrine = read(DOCTRINE);

const checks = [
  [TIMING,    finalTiming.includes("export function computeNextStageScheduledAt"), "timingEngine: helper exported"],
  [SCHED,     finalSched.includes("computeNextStageScheduledAt({"),               "scheduler: helper used"],
  [SCHED,    !finalSched.includes("Date.now() + 60 * 60 * 1000"),                 "scheduler: collapse fallback removed"],
  [DOCTRINE,  (finalDoctrine.match(/computeNextStageScheduledAt\(\{/g) || []).length === 3, "doctrine: helper used at 3 sites"],
  [DOCTRINE, !finalDoctrine.includes("now.getTime() + 60 * 60 * 1000"),           "doctrine: collapse fallback removed"],
  [DOCTRINE, !finalDoctrine.includes("Date.now() + 60 * 60 * 1000"),              "doctrine: legacy collapse fallback removed"],
];

let failed = 0;
for (const [_p, ok, label] of checks) {
  console.log(`  ${ok ? "[ok]" : "[fail]"} ${label}`);
  if (!ok) failed++;
}

console.log(`\nsummary: ${changed} change(s) applied, ${skipped} skipped (already applied)`);

if (failed > 0) {
  console.error(`verify: ${failed} check(s) failed`);
  process.exit(1);
}

console.log("verify: all checks passed");
