#!/usr/bin/env node
/**
 * In-place patch for artifacts/dashboard/src/pages/pipeline.tsx (Phase 3c).
 *
 * Changes:
 *   1. Add `followup_mode` to FollowupRow + EmailThread interfaces.
 *   2. groupByThread carries followup_mode through.
 *   3. Add ModePill + StallPill components.
 *   4. Add handleResumeStalled action calling POST /api/prospect/:id/resume.
 *   5. Wire ModePill + StallPill into the thread summary row.
 *
 * Idempotent: re-running is a no-op (skips when sentinel marker is present).
 */
import fs from "node:fs";
import path from "node:path";

const TARGET = path.resolve("artifacts/dashboard/src/pages/pipeline.tsx");
let src = fs.readFileSync(TARGET, "utf8");

const SENTINEL = "/* PHASE_3C_PILLS_PRESENT */";
if (src.includes(SENTINEL)) {
  console.log("[skip] pipeline.tsx already patched (sentinel present)");
  process.exit(0);
}

// ---------- 1. Extend FollowupRow ----------
{
  const a = `  followup_paused?: boolean;
  replied?: number;
  max_followups?: number;
}`;
  const b = `  followup_paused?: boolean;
  replied?: number;
  max_followups?: number;
  followup_mode?: string;
}`;
  if (!src.includes(a)) throw new Error("anchor 1 (FollowupRow) not found");
  src = src.replace(a, b);
}

// ---------- 2. Extend EmailThread ----------
{
  const a = `  followup_paused: boolean;
  replied: boolean;
  max_followups: number;
  stages: FollowupRow[];`;
  const b = `  followup_paused: boolean;
  replied: boolean;
  max_followups: number;
  followup_mode: string;
  stages: FollowupRow[];`;
  if (!src.includes(a)) throw new Error("anchor 2 (EmailThread) not found");
  src = src.replace(a, b);
}

// ---------- 3. groupByThread carries followup_mode ----------
{
  const a = `      max_followups: maxFollowups,
      stages: sorted,`;
  const b = `      max_followups: maxFollowups,
      followup_mode: first.followup_mode || "auto_send",
      stages: sorted,`;
  if (!src.includes(a)) throw new Error("anchor 3 (groupByThread mapping) not found");
  src = src.replace(a, b);
}

// ---------- 4. Add ModePill + StallPill + getStallInfo above StageProgress ----------
{
  const anchor = `function StageProgress({ thread }: { thread: EmailThread }) {`;
  if (!src.includes(anchor)) throw new Error("anchor 4 (StageProgress) not found");

  const insertion = `${SENTINEL}
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Pipeline mode pill. "Auto" (neutral) for auto_send + review_in_app modes
 * (both flow through the system; review just adds an approval gate). "Draft"
 * (warning yellow) for draft_in_gmail mode where rows produce Gmail drafts
 * the user must manually send.
 */
function ModePill({ mode }: { mode: string }) {
  const isDraft = mode === "draft_in_gmail";
  return (
    <span
      className="text-[10px] font-mono font-medium px-1.5 py-0.5 rounded uppercase tracking-[0.04em]"
      style={
        isDraft
          ? { background: "var(--warning-muted)", color: "var(--warning)", border: "1px solid var(--warning-border)" }
          : { background: "var(--bg-tertiary)", color: "var(--text-secondary)", border: "1px solid var(--border-default)" }
      }
      title={isDraft ? "Draft mode: follow-ups create Gmail drafts you must manually send" : "Auto mode: follow-ups send (or are reviewed) automatically"}
    >
      {isDraft ? "Draft" : "Auto"}
    </span>
  );
}

interface StallInfo {
  days: number;
  tone: "yellow" | "orange" | "red";
  isStalled: boolean; // true if the underlying status is stalled_awaiting_manual_send
  followupId: number;
}

/**
 * Returns stall info if the thread has any drafted (or stalled) follow-up
 * older than the 14-day yellow threshold. Returns null otherwise.
 *
 * Tiers:
 *   - status = stalled_awaiting_manual_send -> red "Stalled — resume?" (always)
 *   - status = drafted, age >= 28d -> red
 *   - status = drafted, age >= 21d -> orange
 *   - status = drafted, age >= 14d -> yellow
 */
function getStallInfo(thread: EmailThread): StallInfo | null {
  // Stalled status takes priority — it's already past the 30d cutoff.
  const stalled = thread.stages.find(s => s.status === "stalled_awaiting_manual_send");
  if (stalled) {
    const ref = stalled.scheduled_at ? new Date(stalled.scheduled_at).getTime() : Date.now();
    const days = Math.floor((Date.now() - ref) / DAY_MS);
    return { days, tone: "red", isStalled: true, followupId: stalled.id };
  }

  const drafted = thread.stages.filter(s => s.status === "drafted");
  if (drafted.length === 0) return null;

  // Use oldest drafted row (lowest scheduled_at).
  const oldest = drafted.reduce((a, b) =>
    new Date(a.scheduled_at).getTime() <= new Date(b.scheduled_at).getTime() ? a : b
  );
  const days = Math.floor((Date.now() - new Date(oldest.scheduled_at).getTime()) / DAY_MS);
  if (days < 14) return null;
  const tone: "yellow" | "orange" | "red" = days >= 28 ? "red" : days >= 21 ? "orange" : "yellow";
  return { days, tone, isStalled: false, followupId: oldest.id };
}

function StallPill({ info, onResume, resuming }: { info: StallInfo; onResume?: () => void; resuming?: boolean }) {
  const colors: Record<StallInfo["tone"], { bg: string; fg: string; border: string }> = {
    yellow: { bg: "var(--warning-muted)", fg: "var(--warning)", border: "var(--warning-border)" },
    orange: { bg: "rgba(255,140,0,0.12)", fg: "rgb(255,140,0)", border: "rgba(255,140,0,0.4)" },
    red:    { bg: "var(--danger-muted)", fg: "var(--danger)", border: "var(--danger-border)" },
  };
  const c = colors[info.tone];

  if (info.isStalled) {
    return (
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onResume?.(); }}
        disabled={resuming}
        className="inline-flex items-center gap-1.5 text-[10px] font-mono font-medium px-1.5 py-0.5 rounded uppercase tracking-[0.04em] transition-all hover:brightness-110"
        style={{ background: c.bg, color: c.fg, border: \`1px solid \${c.border}\`, cursor: resuming ? "wait" : "pointer" }}
        title={\`Draft has been sitting unsent for \${info.days} days. Click to re-queue the next stage.\`}
      >
        {resuming ? "Resuming..." : "Stalled — resume?"}
      </button>
    );
  }

  const label = \`Draft \${info.days}d\`;
  return (
    <span
      className="inline-flex items-center text-[10px] font-mono font-medium px-1.5 py-0.5 rounded uppercase tracking-[0.04em]"
      style={{ background: c.bg, color: c.fg, border: \`1px solid \${c.border}\` }}
      title={\`Gmail draft has been unsent for \${info.days} days.\`}
    >
      {label}
    </span>
  );
}

`;
  src = src.replace(anchor, insertion + anchor);
}

// ---------- 5. Add handleResumeStalled and resumingStalledId state ----------
{
  const a = `  const [addingStageId, setAddingStageId] = useState<number | null>(null);`;
  const b = `  const [addingStageId, setAddingStageId] = useState<number | null>(null);
  const [resumingStalledId, setResumingStalledId] = useState<number | null>(null);`;
  if (!src.includes(a)) throw new Error("anchor 5 (state) not found");
  src = src.replace(a, b);
}

{
  const a = `  const handleApprove = async (id: number) => {`;
  const b = `  const handleResumeStalled = async (prospectId: number) => {
    setResumingStalledId(prospectId);
    try {
      const base = import.meta.env.BASE_URL || "/";
      // The /api/prospect/:id/resume endpoint internally requeues the stalled
      // draft via requeueStalledDraftForProspect when one is present.
      const res = await fetch(\`\${base}api/prospect/\${prospectId}/resume\`, {
        method: "POST",
        headers: { "x-api-key": apiKey || "", "Content-Type": "application/json" },
      });
      const data = await res.json();
      if (!res.ok) {
        showFeedback(data.error || "Failed to resume", true);
        return;
      }
      const stage = data.queued_stage ? \` — re-queued F\${data.queued_stage}\` : "";
      showFeedback(\`Resumed campaign\${stage}\`);
      invalidateAll();
    } catch (err: any) {
      showFeedback(err.message || "Failed to resume", true);
    } finally {
      setResumingStalledId(null);
    }
  };

  const handleApprove = async (id: number) => {`;
  if (!src.includes(a)) throw new Error("anchor 6 (handleApprove) not found");
  src = src.replace(a, b);
}

// ---------- 6. Wire ModePill + StallPill into the summary row ----------
// Insert pills after the prospect-info block, before the stage-progress dots.
{
  const a = `                  {/* Stage progress dots */}
                  <div className="flex-shrink-0">
                    <StageProgress thread={thread} />
                  </div>`;
  const b = `                  {/* Mode + stall pills (Phase 3c) */}
                  {(() => {
                    const stallInfo = getStallInfo(thread);
                    return (
                      <div className="flex items-center gap-1.5 flex-shrink-0">
                        <ModePill mode={thread.followup_mode} />
                        {stallInfo && (
                          <StallPill
                            info={stallInfo}
                            onResume={stallInfo.isStalled ? () => handleResumeStalled(thread.prospect_id) : undefined}
                            resuming={resumingStalledId === thread.prospect_id}
                          />
                        )}
                      </div>
                    );
                  })()}

                  {/* Stage progress dots */}
                  <div className="flex-shrink-0">
                    <StageProgress thread={thread} />
                  </div>`;
  if (!src.includes(a)) throw new Error("anchor 7 (StageProgress placement) not found");
  src = src.replace(a, b);
}

fs.writeFileSync(TARGET, src);
console.log("[ok] pipeline.tsx patched with Phase 3c pills + resume action");