import React, { useState, useMemo, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { format, formatDistanceToNow, isPast } from "date-fns";
import { useApiKey } from "@/hooks/use-api-key";
import { useAdmin } from "@/hooks/use-admin";
import { useCurrentUser } from "@/hooks/use-current-user";
import { useGetFollowups, useCancelFollowups, useQueueBatch } from "@workspace/api-client-react";
import { Card, Button, Badge, Select, Modal, Input } from "@/components/ui";
import {
  Send, AlertCircle, Check, X, ChevronDown, ChevronUp, Loader2,
  Pause, Play, Plus, Clock, Ban, Square, Eye, EyeOff, MoreHorizontal, Mail, ExternalLink,
  Layers, CheckSquare, MinusSquare,
} from "lucide-react";
import { ProspectKillControl } from "@/components/prospect-kill-control";
import { CompanyKillControl } from "@/components/company-kill-control";
import { PipelineUserPicker, ViewingAsAdminBanner } from "@/components/pipeline-user-picker";
import { useManagerOptions } from "@/hooks/use-manager-options";
import {
  SELF_SELECTION,
  type PickerSelection,
  resolveEffectiveUserId,
} from "../../../api-server/src/lib/pipelineUserPicker";
import { BASE_PATH } from "@/lib/app-urls";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface FollowupRow {
  id: number;
  prospect_id: number;
  stage: number;
  status: string;
  scheduled_at: string;
  generated_body: string | null;
  generated_subject: string | null;
  sent_at: string | null;
  gmail_message_id: string | null;
  error_message: string | null;
  created_at: string;
  prospect_name: string;
  company: string;
  email: string;
  vertical: string;
  original_subject: string;
  original_body_summary?: string | null;
  original_body?: string | null;
  original_language?: string | null;
  original_sent_at?: string | null;
  gmail_thread_id?: string | null;
  followup_paused?: boolean;
  replied?: number;
  pause_reason?: string | null;
  bounce_type?: string | null;
  archived?: boolean;
  max_followups?: number;
  followup_mode?: string;
}

interface EmailThread {
  prospect_id: number;
  prospect_name: string;
  company: string;
  email: string;
  vertical: string;
  original_subject: string;
  original_body_summary: string;
  original_body: string;
  original_language: string;
  original_sent_at: string | null;
  gmail_thread_id: string | null;
  followup_paused: boolean;
  replied: boolean;
  pause_reason: string | null;
  bounce_type: string | null;
  archived: boolean;
  max_followups: number;
  followup_mode: string;
  stages: FollowupRow[];
  current_stage: number;
  next_followup: FollowupRow | null;
  has_more_scheduled: boolean;
  all_done: boolean;
}

function isUnlimitedFollowups(maxFollowups?: number | null): boolean {
  return typeof maxFollowups !== "number" || maxFollowups <= 0;
}

// Mirror of api-server effectiveFollowupCap / HARD_FOLLOWUP_CAP. The scheduler
// clamps every campaign to this many stages and the legacy "0 = unlimited"
// convention is gone product-wide, so the pipeline must clamp the same way.
// Without this, a stale stored max_followups (e.g. 4, set before the cap was
// lowered) makes the row show "/4" and — worse — keeps all_done false forever,
// so a campaign that has already received its 3 sends never registers as done
// and wrongly sorts above genuinely-paused rows. Keep in sync with
// HARD_FOLLOWUP_CAP in api-server/src/lib/followupLimits.ts.
const HARD_FOLLOWUP_CAP = 3;
function effectiveFollowupCap(maxFollowups?: number | null): number {
  const stored =
    typeof maxFollowups === "number" && maxFollowups > 0 ? maxFollowups : HARD_FOLLOWUP_CAP;
  return Math.min(stored, HARD_FOLLOWUP_CAP);
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function groupByThread(followups: FollowupRow[]): EmailThread[] {
  const map = new Map<number, FollowupRow[]>();

  for (const f of followups) {
    const pid = f.prospect_id;
    if (!map.has(pid)) map.set(pid, []);
    map.get(pid)!.push(f);
  }

  const threads: EmailThread[] = [];

  for (const [pid, rows] of map) {
    const sorted = [...rows].sort((a, b) => a.stage - b.stage);
    const first = sorted[0];

    const sentStages = sorted.filter(r => r.status === "sent");
    const activeStages = sorted.filter(r =>
      // B7p: include drafted so the dashboard surface matches the
      // scheduler's notion of "active" (status='drafted' blocks autoqueue).
      ["queued", "generating", "pending_approval", "drafted"].includes(r.status)
    );
    const maxSentStage = sentStages.length > 0
      ? Math.max(...sentStages.map(s => s.stage))
      : 0;

    const currentStage = maxSentStage;
    // Clamp to the rigid cap, mirroring the scheduler. This drives the stage
    // denominator, the all_done decision, and therefore the active-first sort.
    const maxFollowups = effectiveFollowupCap(first.max_followups);
    const unlimitedFollowups = isUnlimitedFollowups(maxFollowups);

    const nextQueued = activeStages.length > 0
      ? activeStages.sort((a, b) =>
          new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime()
        )[0]
      : null;

    const allDone = !unlimitedFollowups && activeStages.length === 0 && currentStage >= maxFollowups;

    // B7w: prospect_name fallback chain. The old "Unknown" rendered
    // every name-less prospect identically, which made 22 hwholestorm@
    // test prospects indistinguishable on the pipeline screen. Walk
    // down: real extracted name → email local-part → original subject
    // truncated → finally "Unknown" as a last resort. The result
    // doesn't change generation (the follow-up writer reads
    // prospect_name from the prospects row directly), only the row's
    // visual identity here.
    const subjectFallback = (first.original_subject || "").trim();
    const emailLocal = (first.email || "").split("@")[0] || "";
    const displayName =
      (first.prospect_name && first.prospect_name.trim()) ||
      (subjectFallback ? subjectFallback.slice(0, 48) : "") ||
      (emailLocal || "") ||
      "Unknown";

    threads.push({
      prospect_id: pid,
      prospect_name: displayName,
      company: first.company || "",
      email: first.email,
      vertical: first.vertical,
      original_subject: first.original_subject,
      original_body_summary: first.original_body_summary || "",
      original_body: first.original_body || "",
      original_language: first.original_language || "en",
      original_sent_at: first.original_sent_at || null,
      gmail_thread_id: first.gmail_thread_id || null,
      followup_paused: !!first.followup_paused,
      replied: !!first.replied,
      pause_reason: first.pause_reason ?? null,
      bounce_type: first.bounce_type ?? null,
      archived: !!first.archived,
      max_followups: maxFollowups,
      followup_mode: first.followup_mode || "auto_send",
      stages: sorted,
      current_stage: currentStage,
      next_followup: nextQueued,
      has_more_scheduled: activeStages.length > 0,
      all_done: allDone,
    });
  }

  return threads.sort((a, b) => {
    // Active-first ordering. Opening a pipeline, an operator wants the
    // campaigns that are actually in flight at the top — not whichever email
    // happened to be sent most recently. We sort primarily by a lifecycle
    // tier and keep newest-first recency only as the within-tier order, so a
    // fresh send still surfaces near the top of its own tier without burying
    // older campaigns that are still firing.
    //
    //   0  active  — live, not paused, not closed, has a queued/in-flight stage
    //   1  idle    — live, not paused, not closed, nothing queued yet
    //   2  paused
    //   3  closed  — replied or all_done (sinks to the bottom)
    const tier = (t: EmailThread): number => {
      if (t.replied || t.all_done) return 3;
      if (t.followup_paused) return 2;
      if (t.has_more_scheduled) return 0;
      return 1;
    };
    const aTier = tier(a);
    const bTier = tier(b);
    if (aTier !== bTier) return aTier - bTier;
    // Within a tier: newest original_sent_at first, then more-progressed first.
    const aSent = a.original_sent_at ? new Date(a.original_sent_at).getTime() : 0;
    const bSent = b.original_sent_at ? new Date(b.original_sent_at).getTime() : 0;
    if (bSent !== aSent) return bSent - aSent;
    return b.current_stage - a.current_stage;
  });
}

const VERTICAL_LABELS: Record<string, string> = {
  gaming_ua: "Gaming UA",
  non_gaming_ua: "Non-Gaming UA",
  cps: "CPS",
  retargeting: "Retargeting",
};

/* ------------------------------------------------------------------ */
/*  Sub-components                                                     */
/* ------------------------------------------------------------------ */


/* PHASE_3C_PILLS_PRESENT */
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
        style={{ background: c.bg, color: c.fg, border: `1px solid ${c.border}`, cursor: resuming ? "wait" : "pointer" }}
        title={`Draft has been sitting unsent for ${info.days} days. Click to re-queue the next stage.`}
      >
        {resuming ? "Resuming..." : "Stalled — resume?"}
      </button>
    );
  }

  const label = `Draft ${info.days}d`;
  return (
    <span
      className="inline-flex items-center text-[10px] font-mono font-medium px-1.5 py-0.5 rounded uppercase tracking-[0.04em]"
      style={{ background: c.bg, color: c.fg, border: `1px solid ${c.border}` }}
      title={`Gmail draft has been unsent for ${info.days} days.`}
    >
      {label}
    </span>
  );
}

function StageProgress({ thread }: { thread: EmailThread }) {
  const highestStage = thread.stages.length > 0 ? Math.max(...thread.stages.map((s) => s.stage)) : 0;
  // Phase 7m: capped branch must also fit highestStage so stages added
  // beyond max_followups (manual "Send Now" force, or post-reduction
  // legacy stages) render visually instead of being silently capped.
  const maxStages = isUnlimitedFollowups(thread.max_followups)
    ? Math.max(3, highestStage)
    : Math.max(thread.max_followups, highestStage);
  const stages: React.ReactNode[] = [];

  for (let i = 1; i <= maxStages; i++) {
    const stage = thread.stages.find(s => s.stage === i);
    let bg = "var(--bg-tertiary)";
    let border = "var(--border-default)";
    let title = `Stage ${i}: not scheduled`;

    if (stage) {
      switch (stage.status) {
        case "sent":
          bg = "var(--success)"; border = "var(--success)";
          title = `Stage ${i}: sent`; break;
        case "queued": case "generating":
          bg = "var(--warning)"; border = "var(--warning)";
          title = `Stage ${i}: queued`; break;
        case "pending_approval":
          bg = "var(--accent)"; border = "var(--accent)";
          title = `Stage ${i}: pending approval`; break;
        case "cancelled":
          bg = "transparent"; border = "var(--border-hover)";
          title = `Stage ${i}: cancelled`; break;
        case "failed":
          bg = "var(--danger)"; border = "var(--danger)";
          title = `Stage ${i}: failed`; break;
        // B7p: previously these two fell through to grey "not scheduled"
        // and the user could not see that a row existed at all.
        case "drafted":
          bg = "rgba(255,140,0,0.4)"; border = "rgb(255,140,0)";
          title = `Stage ${i}: drafted in Gmail (send manually)`; break;
        case "stalled_awaiting_manual_send":
          bg = "var(--danger-muted)"; border = "var(--danger)";
          title = `Stage ${i}: stalled (draft unsent 30+ days)`; break;
      }
    }

    stages.push(
      <div
        key={i}
        title={title}
        style={{
          width: "10px", height: "10px", borderRadius: "2px",
          background: bg, border: `1.5px solid ${border}`,
          transition: "all 0.15s ease",
        }}
      />
    );
  }

  return <div className="flex items-center gap-1">{stages}</div>;
}

function StatusSummary({ thread }: { thread: EmailThread }) {
  if (thread.archived) {
    return (
      <span className="text-[12px] font-medium flex items-center gap-1" style={{ color: "var(--text-tertiary)" }}>
        <Ban className="h-3 w-3" /> Archived
      </span>
    );
  }
  if (thread.replied) {
    return (
      <span className="text-[12px] font-medium" style={{ color: "var(--success)" }}>
        Replied — thread closed
      </span>
    );
  }
  if (thread.followup_paused) {
    if (thread.pause_reason === "bounced") {
      return (
        <span className="text-[12px] font-medium flex items-center gap-1" style={{ color: "var(--danger)" }}>
          <Ban className="h-3 w-3" /> Bounced ({thread.bounce_type === "soft" ? "soft" : "hard"}) — paused
        </span>
      );
    }
    // Reason-aware label so an auto-paused campaign (age / over-cap / admin
    // kill / company-reply cascade) is distinguishable from a manual pause at a
    // glance — this is how you spot which old campaigns the sweeps stopped.
    const PAUSE_REASON_LABELS: Record<string, string> = {
      campaign_expired_30d: "Paused — expired (30d)",
      over_followup_cap: "Paused — over 3-follow-up cap",
      admin_killed: "Paused — killed",
      company_reply_cascade: "Paused — company replied",
      manual_intervention: "Paused",
    };
    const pauseLabel =
      (thread.pause_reason && PAUSE_REASON_LABELS[thread.pause_reason]) || "Paused";
    return (
      <span className="text-[12px] font-medium flex items-center gap-1" style={{ color: "var(--warning)" }}>
        <Pause className="h-3 w-3" /> {pauseLabel}
      </span>
    );
  }
  if (thread.all_done) {
    return (
      <span className="text-[12px] font-medium flex items-center gap-1" style={{ color: "var(--text-tertiary)" }}>
        <Ban className="h-3 w-3" /> No more followups scheduled
      </span>
    );
  }
  if (thread.next_followup) {
    if (thread.next_followup.status === "pending_approval") {
      return (
        <span className="text-[12px] font-medium flex items-center gap-1" style={{ color: "var(--accent)" }}>
          <Eye className="h-3 w-3" /> Awaiting approval
        </span>
      );
    }
    // B7p: drafted rows surface here instead of as a countdown. In
    // draft_in_gmail mode this is the normal "waiting for the user to
    // manually click Send in Gmail" state. The StallPill on the right
    // still escalates after 14/21/28 days.
    if (thread.next_followup.status === "drafted") {
      return (
        <span className="text-[12px] font-medium flex items-center gap-1" style={{ color: "rgb(255,140,0)" }}>
          <Mail className="h-3 w-3" /> Draft ready in Gmail — F{thread.next_followup.stage}
        </span>
      );
    }
    return null; // handled by CountdownTimer in the main row
  }
  if (isUnlimitedFollowups(thread.max_followups)) {
    return (
      <span className="text-[12px]" style={{ color: "var(--text-tertiary)" }}>
        Ready for another follow-up
      </span>
    );
  }
  return (
    <span className="text-[12px]" style={{ color: "var(--text-tertiary)" }}>
      No stages queued
    </span>
  );
}

function CountdownTimer({ scheduledAt }: { scheduledAt: string }) {
  const [, setTick] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => setTick(t => t + 1), 30000);
    return () => clearInterval(interval);
  }, []);

  const target = new Date(scheduledAt);
  const diff = target.getTime() - Date.now();

  if (diff <= 0) {
    return (
      <span className="font-mono text-[12px] font-semibold" style={{ color: "var(--warning)" }}>
        Due now
      </span>
    );
  }

  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

  let display = "";
  if (days > 0) display = `${days}d ${hours}h`;
  else if (hours > 0) display = `${hours}h ${minutes}m`;
  else display = `${minutes}m`;

  return (
    <span className="font-mono text-[12px]" style={{ color: "var(--text-primary)" }}>
      {display}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

export default function Pipeline() {
  const { apiKey } = useApiKey();
  const { isAdmin } = useAdmin();
  const { user: currentUser } = useCurrentUser();
  const queryClient = useQueryClient();

  // Admin pipeline user picker. `selection` defaults to "my pipeline" (the
  // logged-in user's own campaigns). The picker only renders when an API key
  // is present. `effectiveUserId` is the id sent into the list calls.
  const [selection, setSelection] = useState<PickerSelection>(SELF_SELECTION);
  const { options: managerOptions, loading: managerOptionsLoading } = useManagerOptions(apiKey);
  const effectiveUserId = resolveEffectiveUserId(selection, currentUser?.userId ?? null);
  const requestOpts = { request: { headers: { "x-api-key": apiKey || "" } } };

  // 2026-07-16 main-screen-hang fix: a null effectiveUserId used to fall
  // through to GET /api/followups with NO userId filter — the server then
  // returned EVERY user's follow-ups with full email bodies (up to 50k rows),
  // freezing the tab (and the server's event loop while it serialized).
  // A null id is only legitimate on a legacy single-user install (no
  // connected accounts). Otherwise we block the fetch: "unknown" means
  // identity resolution is still in flight (show skeletons), "unmatched"
  // means this login has no connected Gmail account (show guidance).
  const { identityStatus } = useCurrentUser();
  const identityBlocked = effectiveUserId === null && identityStatus !== "legacy";

  const [filterState, setFilterState] = useState<string>("all");
  const [filterVertical, setFilterVertical] = useState<string>("all");
  const [filterCompany, setFilterCompany] = useState<string>("all");
  const [showArchived, setShowArchived] = useState<boolean>(false);
  const [archivedRows, setArchivedRows] = useState<FollowupRow[] | null>(null);
  const [restoringId, setRestoringId] = useState<number | null>(null);
  const [expandedThread, setExpandedThread] = useState<number | null>(null);
  const [expandedPreview, setExpandedPreview] = useState<number | null>(null);
  const [viewingOriginalFor, setViewingOriginalFor] = useState<EmailThread | null>(null);

  const [approvingId, setApprovingId] = useState<number | null>(null);
  const [rejectingId, setRejectingId] = useState<number | null>(null);
  const [togglingPauseId, setTogglingPauseId] = useState<number | null>(null);
  const [addingStageId, setAddingStageId] = useState<number | null>(null);
  const [resumingStalledId, setResumingStalledId] = useState<number | null>(null);
  const [feedbackMsg, setFeedbackMsg] = useState<string | null>(null);
  const [feedbackError, setFeedbackError] = useState(false);

  const [isQueueModalOpen, setIsQueueModalOpen] = useState(false);
  const [queueVertical, setQueueVertical] = useState("all");
  const [queueDate, setQueueDate] = useState("");
  const [queueStage, setQueueStage] = useState("1");

  // Multi-select state for bulk actions (Batch 2)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  // Anchor for shift-click range selection: the last row clicked without Shift.
  const [anchorId, setAnchorId] = useState<number | null>(null);
  const [bulkSending, setBulkSending] = useState(false);
  const [bulkPausing, setBulkPausing] = useState(false);
  const [bulkResuming, setBulkResuming] = useState(false);

  function toggleSelected(prospectId: number) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(prospectId)) next.delete(prospectId);
      else next.add(prospectId);
      return next;
    });
  }

  function clearSelection() {
    setSelectedIds(new Set());
    setAnchorId(null);
  }

  // Row checkbox click. Plain click toggles one row and moves the anchor here.
  // Shift-click selects the contiguous range from the anchor to this row in one
  // motion — no need to tick every box. The anchor is resolved by id against the
  // current visible order, so it still works if filtering or sorting changed
  // since the anchor click; if the anchor is no longer visible, it falls back to
  // a plain toggle. The anchor is kept after a range select, so a further
  // shift-click extends the range from the same starting point.
  function handleRowSelect(prospectId: number, idx: number, shiftKey: boolean) {
    if (shiftKey && anchorId !== null) {
      const anchorIdx = filteredThreads.findIndex(t => t.prospect_id === anchorId);
      if (anchorIdx !== -1) {
        const lo = Math.min(anchorIdx, idx);
        const hi = Math.max(anchorIdx, idx);
        const rangeIds = filteredThreads.slice(lo, hi + 1).map(t => t.prospect_id);
        setSelectedIds(prev => {
          const next = new Set(prev);
          for (const id of rangeIds) next.add(id);
          return next;
        });
        return;
      }
    }
    toggleSelected(prospectId);
    setAnchorId(prospectId);
  }

  const { data: followups, isLoading, isError } = useGetFollowups(
    { ...(effectiveUserId ? { userId: String(effectiveUserId) } : {}) },
    // 2026-07-16 main-screen-hang fix: `enabled` also requires the identity
    // gate — never fire the userId-less variant unless this is a legacy
    // single-user install (see identityBlocked above).
    { ...requestOpts, query: { queryKey: ["/api/followups", effectiveUserId], enabled: !!apiKey && !identityBlocked, refetchInterval: 30000 } }
  );

  const cancelMutation = useCancelFollowups({
    ...requestOpts,
    mutation: { onSuccess: () => invalidateAll() },
  });

  const queueBatchMutation = useQueueBatch({
    ...requestOpts,
    mutation: {
      onSuccess: (data: any) => {
        const queued = data?.queued ?? 0;
        showFeedback(`Queued ${queued} follow-up${queued !== 1 ? "s" : ""}`);
        setIsQueueModalOpen(false);
        invalidateAll();
      },
      onError: () => showFeedback("Failed to queue batch", true),
    },
  });

  const handleQueueBatch = (e: React.FormEvent) => {
    e.preventDefault();
    queueBatchMutation.mutate({
      data: {
        stage: parseInt(queueStage),
        ...(queueVertical !== "all" ? { vertical: queueVertical } : {}),
        ...(queueDate ? { sent_date: queueDate } : {}),
      },
    });
  };

  /* ---- Bulk actions (Batch 2) ---- */

  async function handleBulkSend() {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    if (!confirm(`Send next-stage follow-up now for ${ids.length} prospect${ids.length !== 1 ? "s" : ""}? This bypasses the schedule.`)) return;
    setBulkSending(true);
    try {
      const base = BASE_PATH;
      const res = await fetch(`${base}api/followup/send-bulk`, {
        method: "POST",
        headers: { "x-api-key": apiKey || "", "Content-Type": "application/json" },
        body: JSON.stringify({ prospectIds: ids }),
      });
      const data = await res.json();
      if (!res.ok) {
        showFeedback(data.error || "Bulk send failed", true);
        return;
      }
      const failedCount = Array.isArray(data.failed) ? data.failed.length : 0;
      const sentCount = data.sent || 0;
      const summary = failedCount > 0
        ? `Sent ${sentCount} of ${data.total}; ${failedCount} failed`
        : `Sent ${sentCount} of ${data.total}`;
      showFeedback(summary, failedCount > 0);
      clearSelection();
      invalidateAll();
    } catch (err: any) {
      showFeedback(err.message || "Bulk send failed", true);
    } finally {
      setBulkSending(false);
    }
  }

  async function handleBulkPause() {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    if (!confirm(`Pause campaigns for ${ids.length} prospect${ids.length !== 1 ? "s" : ""}? Queued follow-ups for these prospects will be cancelled.`)) return;
    setBulkPausing(true);
    try {
      const base = BASE_PATH;
      const res = await fetch(`${base}api/prospect/pause-bulk`, {
        method: "POST",
        headers: { "x-api-key": apiKey || "", "Content-Type": "application/json" },
        body: JSON.stringify({ prospectIds: ids }),
      });
      const data = await res.json();
      if (!res.ok) {
        showFeedback(data.error || "Bulk pause failed", true);
        return;
      }
      showFeedback(
        `Paused ${data.paused || 0} of ${data.requested || ids.length} — cancelled ${data.cancelled_queued || 0} queued follow-up${(data.cancelled_queued || 0) !== 1 ? "s" : ""}`,
      );
      clearSelection();
      invalidateAll();
    } catch (err: any) {
      showFeedback(err.message || "Bulk pause failed", true);
    } finally {
      setBulkPausing(false);
    }
  }

  async function handleBulkResume() {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    if (!confirm(`Resume campaigns for ${ids.length} prospect${ids.length !== 1 ? "s" : ""}? Paused prospects will be unpaused; stalled drafts will be requeued and next-stage follow-ups will be queued where appropriate.`)) return;
    setBulkResuming(true);
    try {
      const base = BASE_PATH;
      const res = await fetch(`${base}api/prospect/resume-bulk`, {
        method: "POST",
        headers: { "x-api-key": apiKey || "", "Content-Type": "application/json" },
        body: JSON.stringify({ prospectIds: ids }),
      });
      const data = await res.json();
      if (!res.ok) {
        showFeedback(data.error || "Bulk resume failed", true);
        return;
      }
      const resumed = data.resumed || 0;
      const requested = data.requested || ids.length;
      const requeued = data.requeued_stalled || 0;
      const queued = data.queued_new || 0;
      const skipped = data.skipped_replied || 0;
      const parts = [`Resumed ${resumed} of ${requested}`];
      if (requeued > 0) parts.push(`requeued ${requeued} stalled`);
      if (queued > 0) parts.push(`queued ${queued} new`);
      if (skipped > 0) parts.push(`skipped ${skipped} replied`);
      showFeedback(parts.join(" — "));
      clearSelection();
      invalidateAll();
    } catch (err: any) {
      showFeedback(err.message || "Bulk resume failed", true);
    } finally {
      setBulkResuming(false);
    }
  }

  function invalidateAll() {
    queryClient.invalidateQueries({ queryKey: ["/api/followups"] });
    queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
    queryClient.invalidateQueries({ queryKey: ["/api/prospects"] });
  }

  function showFeedback(msg: string, isError = false) {
    setFeedbackError(isError);
    setFeedbackMsg(msg);
    setTimeout(() => setFeedbackMsg(null), 5000);
  }

  const threads = useMemo(() => {
    const source = showArchived ? archivedRows : (followups as FollowupRow[] | undefined);
    if (!source || !Array.isArray(source)) return [];
    return groupByThread(source as FollowupRow[]);
  }, [followups, showArchived, archivedRows]);

  // Distinct, non-empty company names from the loaded pipeline, sorted for the
  // COMPANY filter dropdown. Recomputed only when the thread set changes.
  const companyOptions = useMemo(() => {
    const set = new Set<string>();
    for (const t of threads) {
      const c = (t.company || "").trim();
      if (c) set.add(c);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [threads]);

  // If the selected company is genuinely absent from a loaded set (e.g. after
  // switching the viewed pipeline), fall back to "all". Guarded on a non-empty
  // option list so a transient empty set during a refetch never clears a valid
  // selection.
  useEffect(() => {
    if (filterCompany !== "all" && companyOptions.length > 0 && !companyOptions.includes(filterCompany)) {
      setFilterCompany("all");
    }
  }, [companyOptions, filterCompany]);

  const filteredThreads = useMemo(() => {
    return threads.filter(t => {
      // Archived rows appear only in archived mode and are exempt from the
      // lifecycle state filter (archived is its own terminal display state).
      if (t.archived) return showArchived;
      if (filterState === "active" && (t.all_done || t.followup_paused || t.replied)) return false;
      if (filterState === "paused" && !t.followup_paused) return false;
      if (filterState === "completed" && !t.all_done) return false;
      if (filterState === "pending" && !t.stages.some(s => s.status === "pending_approval")) return false;
      if (filterVertical !== "all" && t.vertical !== filterVertical) return false;
      if (filterCompany !== "all" && (t.company || "").trim() !== filterCompany) return false;
      return true;
    });
  }, [threads, filterState, filterVertical, filterCompany, showArchived]);

  /* ---- Actions ---- */

  // Load the archived dataset on demand. The default /api/followups response
  // excludes archived rows; passing includeArchived=1 returns the full set so
  // archived campaigns render with an Archived badge and a Restore action.
  const loadArchived = React.useCallback(async () => {
    // Same identity gate as the primary list: never issue the userId-less
    // all-users variant unless this is a legacy single-user install.
    if (effectiveUserId === null && identityStatus !== "legacy") return;
    const base = BASE_PATH;
    const url = effectiveUserId
      ? `${base}api/followups?includeArchived=1&userId=${effectiveUserId}`
      : `${base}api/followups?includeArchived=1`;
    try {
      const res = await fetch(url, { headers: { "x-api-key": apiKey || "" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setArchivedRows(await res.json());
    } catch (err: any) {
      showFeedback(err?.message || "Failed to load archived", true);
      setArchivedRows([]);
    }
  }, [apiKey, effectiveUserId, identityStatus]);

  useEffect(() => {
    if (showArchived) loadArchived();
  }, [showArchived, loadArchived]);

  // When the viewed manager changes, blank the archived dataset immediately so
  // archived mode does not render the previous manager's archived rows under
  // the new (banner) name while the reload is in flight. The primary list is
  // react-query keyed by effectiveUserId and already shows loading on change.
  useEffect(() => {
    setArchivedRows(null);
  }, [effectiveUserId]);

  const handleRestore = async (prospectId: number) => {
    if (!confirm("Restore this campaign? It returns to the pipeline in its current paused state. Use Resume afterward to reactivate sending.")) return;
    setRestoringId(prospectId);
    try {
      const base = BASE_PATH;
      const res = await fetch(`${base}api/prospect/${prospectId}/restore`, {
        method: "POST",
        headers: { "x-api-key": apiKey || "" },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        showFeedback(body?.error || `Restore failed (HTTP ${res.status})`, true);
      } else {
        showFeedback("Campaign restored");
        await loadArchived();
        invalidateAll();
      }
    } catch (err: any) {
      showFeedback(err?.message || "Restore failed", true);
    } finally {
      setRestoringId(null);
    }
  };

  const handleTogglePause = async (prospectId: number, currentlyPaused: boolean) => {
    setTogglingPauseId(prospectId);
    try {
      const base = BASE_PATH;
      const endpoint = currentlyPaused ? "resume" : "pause";
      const res = await fetch(`${base}api/prospect/${prospectId}/${endpoint}`, {
        method: "POST",
        headers: { "x-api-key": apiKey || "", "Content-Type": "application/json" },
      });
      const data = await res.json();
      if (!res.ok) { showFeedback(data.error || `Failed to ${endpoint}`, true); return; }
      const verb = currentlyPaused ? "Resumed" : "Stopped";
      const extra = data.queued_stage
        ? ` — queued F${data.queued_stage}`
        : data.cancelled_queued
        ? ` — cancelled ${data.cancelled_queued} queued`
        : "";
      showFeedback(`${verb} followups for this thread${extra}`);
      invalidateAll();
    } catch (err: any) {
      showFeedback(err.message || "Failed", true);
    } finally {
      setTogglingPauseId(null);
    }
  };

  const handleAddStage = async (prospectId: number) => {
    setAddingStageId(prospectId);
    try {
      const base = BASE_PATH;
      const res = await fetch(`${base}api/followup-now/${prospectId}`, {
        method: "POST",
        headers: { "x-api-key": apiKey || "", "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) { showFeedback(data.error || "Failed to add stage", true); return; }
      showFeedback(data.message || "Stage queued");
      invalidateAll();
    } catch (err: any) {
      showFeedback(err.message || "Failed to add stage", true);
    } finally {
      setAddingStageId(null);
    }
  };

  const handleResumeStalled = async (prospectId: number) => {
    setResumingStalledId(prospectId);
    try {
      const base = BASE_PATH;
      // The /api/prospect/:id/resume endpoint internally requeues the stalled
      // draft via requeueStalledDraftForProspect when one is present.
      const res = await fetch(`${base}api/prospect/${prospectId}/resume`, {
        method: "POST",
        headers: { "x-api-key": apiKey || "", "Content-Type": "application/json" },
      });
      const data = await res.json();
      if (!res.ok) {
        showFeedback(data.error || "Failed to resume", true);
        return;
      }
      const stage = data.queued_stage ? ` — re-queued F${data.queued_stage}` : "";
      showFeedback(`Resumed campaign${stage}`);
      invalidateAll();
    } catch (err: any) {
      showFeedback(err.message || "Failed to resume", true);
    } finally {
      setResumingStalledId(null);
    }
  };

  const handleApprove = async (id: number) => {
    setApprovingId(id);
    try {
      const base = BASE_PATH;
      const res = await fetch(`${base}api/followups/${id}/approve`, {
        method: "POST",
        headers: { "x-api-key": apiKey || "", "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error("Failed to approve");
      invalidateAll();
      showFeedback("Approved and sent");
    } catch { showFeedback("Failed to approve", true); }
    finally { setApprovingId(null); }
  };

  const handleReject = async (id: number) => {
    if (!confirm("Reject this follow-up? It will be cancelled.")) return;
    setRejectingId(id);
    try {
      const base = BASE_PATH;
      const res = await fetch(`${base}api/followups/${id}/reject`, {
        method: "POST",
        headers: { "x-api-key": apiKey || "", "Content-Type": "application/json" },
      });
      if (!res.ok) throw new Error("Failed to reject");
      invalidateAll();
      showFeedback("Rejected");
    } catch { showFeedback("Failed to reject", true); }
    finally { setRejectingId(null); }
  };

  /* ---- Counters ---- */

  const liveThreads = threads.filter(t => !t.archived);
  const activeCount = liveThreads.filter(t => t.has_more_scheduled && !t.followup_paused && !t.replied).length;
  const pausedCount = liveThreads.filter(t => t.followup_paused).length;
  const pendingCount = liveThreads.filter(t => t.stages.some(s => s.status === "pending_approval")).length;
  const doneCount = liveThreads.filter(t => t.all_done).length;

  /* ---- Render ---- */

  return (
    <div className="space-y-6">
      {/* Viewing-as-admin banner: shown whenever another manager's pipeline is in view. */}
      <ViewingAsAdminBanner
        selection={selection}
        currentUserId={currentUser?.userId ?? null}
        options={managerOptions}
      />

      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 style={{ fontSize: "20px", fontWeight: 600, letterSpacing: "-0.02em" }}>
          Pipeline
        </h1>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-3 text-[12px]" style={{ color: "var(--text-secondary)" }}>
            <span>
              <span className="font-mono font-semibold" style={{ color: "var(--success)" }}>{activeCount}</span> active
            </span>
            <span>
              <span className="font-mono font-semibold" style={{ color: "var(--warning)" }}>{pausedCount}</span> paused
            </span>
            {pendingCount > 0 && (
              <span>
                <span className="font-mono font-semibold" style={{ color: "var(--accent)" }}>{pendingCount}</span> pending
              </span>
            )}
            <span>
              <span className="font-mono font-semibold" style={{ color: "var(--text-tertiary)" }}>{doneCount}</span> done
            </span>
          </div>
          <Button onClick={() => setIsQueueModalOpen(true)} className="gap-2">
            <Layers className="h-4 w-4" />
            Queue follow-ups
          </Button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-4">
        <PipelineUserPicker
          isAdmin={isAdmin}
          options={managerOptions}
          optionsLoading={managerOptionsLoading}
          selection={selection}
          onChange={setSelection}
        />
        <div className="w-48">
          <label
            className="block mb-1.5 font-medium uppercase tracking-[0.04em]"
            style={{ fontSize: "11px", color: "var(--text-tertiary)" }}
          >
            STATE
          </label>
          <Select value={filterState} onChange={e => setFilterState(e.target.value)}>
            <option value="all">All states</option>
            <option value="active">Active (has queued)</option>
            <option value="paused">Paused</option>
            <option value="pending">Pending approval</option>
            <option value="completed">Completed (all sent)</option>
          </Select>
        </div>
        <div className="w-48">
          <label
            className="block mb-1.5 font-medium uppercase tracking-[0.04em]"
            style={{ fontSize: "11px", color: "var(--text-tertiary)" }}
          >
            VERTICAL
          </label>
          <Select value={filterVertical} onChange={e => setFilterVertical(e.target.value)}>
            <option value="all">All verticals</option>
            <option value="gaming_ua">Gaming UA</option>
            <option value="non_gaming_ua">Non-Gaming UA</option>
            <option value="cps">CPS</option>
            <option value="retargeting">Retargeting</option>
          </Select>
        </div>
        <div className="w-56">
          <label
            className="block mb-1.5 font-medium uppercase tracking-[0.04em]"
            style={{ fontSize: "11px", color: "var(--text-tertiary)" }}
          >
            COMPANY
          </label>
          <Select value={filterCompany} onChange={e => setFilterCompany(e.target.value)}>
            <option value="all">All companies</option>
            {companyOptions.map(c => (
              <option key={c} value={c}>{c}</option>
            ))}
          </Select>
        </div>
        <div className="flex items-end pb-1">
          <label className="flex items-center gap-1.5 cursor-pointer text-[12px]" style={{ color: "var(--text-secondary)" }}>
            <input
              type="checkbox"
              checked={showArchived}
              onChange={e => setShowArchived(e.target.checked)}
            />
            Show archived
          </label>
        </div>
      </div>

      {/* Select-all toggle (Batch 2) */}
      {filteredThreads.length > 0 && (() => {
        const allVisibleIds = filteredThreads.map(t => t.prospect_id);
        const visibleSelected = allVisibleIds.filter(id => selectedIds.has(id)).length;
        const allSelected = visibleSelected === allVisibleIds.length;
        const someSelected = visibleSelected > 0 && !allSelected;
        const Icon = allSelected ? CheckSquare : someSelected ? MinusSquare : Square;
        const label = allSelected
          ? `Deselect all ${allVisibleIds.length}`
          : someSelected
          ? `${visibleSelected} of ${allVisibleIds.length} selected — select all`
          : `Select all ${allVisibleIds.length} visible`;
        return (
          <button
            type="button"
            onClick={() => {
              if (allSelected) clearSelection();
              else setSelectedIds(new Set(allVisibleIds));
            }}
            className="flex items-center gap-2 text-[12px] font-medium px-2 py-1.5 rounded-md transition-all"
            style={{
              color: visibleSelected > 0 ? "var(--accent)" : "var(--text-secondary)",
              background: visibleSelected > 0 ? "var(--accent-muted)" : "transparent",
              border: `1px solid ${visibleSelected > 0 ? "var(--accent-border)" : "var(--border-default)"}`,
            }}
          >
            <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
            {label}
          </button>
        );
      })()}

      {filteredThreads.length > 0 && (
        <span
          className="text-[11px]"
          style={{ color: "var(--text-tertiary)" }}
          title="Click one checkbox, then hold Shift and click another row's checkbox to select everything in between."
        >
          Tip: Shift-click to select a range
        </span>
      )}

      {/* Company-level kill: appears when a single company is filtered. Admin
          only (the control 403s without an admin token regardless). Scoped to
          the viewed pipeline via effectiveUserId. */}
      {isAdmin && filterCompany !== "all" && filteredThreads.length > 0 && (
        <div className="flex items-center gap-3">
          <CompanyKillControl
            company={filterCompany}
            userId={effectiveUserId}
            apiKey={apiKey}
            visibleCount={filteredThreads.length}
            onKilled={() => { clearSelection(); invalidateAll(); }}
            disabled={!apiKey}
          />
          <span className="text-[11px]" style={{ color: "var(--text-tertiary)" }}>
            Stops every campaign at {filterCompany} in this pipeline.
          </span>
        </div>
      )}

      {/* Feedback banner */}
      {feedbackMsg && (
        <div
          className="rounded-lg p-3 text-[13px]"
          style={{
            background: feedbackError ? "var(--danger-muted)" : "var(--success-muted)",
            border: `1px solid ${feedbackError ? "var(--danger-border)" : "var(--success-border)"}`,
            color: feedbackError ? "var(--danger)" : "var(--success)",
          }}
        >
          {feedbackMsg}
        </div>
      )}

      {/* Content */}
      {identityBlocked && identityStatus === "unmatched" ? (
        // 2026-07-16 main-screen-hang fix: this login has no connected Gmail
        // account, so there is no pipeline to show. Explain instead of
        // spinning forever on (or freezing under) an all-users fetch.
        <Card className="flex flex-col items-center justify-center h-64 text-center p-8">
          <AlertCircle className="h-6 w-6 mb-3" style={{ color: "var(--warning, #d97706)" }} />
          <p className="font-medium text-[13px]" style={{ color: "var(--text-primary)" }}>
            No Gmail account connected for {currentUser?.email || "this login"}
          </p>
          <p className="text-[13px] mt-1" style={{ color: "var(--text-secondary)" }}>
            Connect your Gmail account in Settings to start tracking follow-ups.
            {isAdmin ? " As an admin, you can also pick a manager above to view their pipeline." : ""}
          </p>
        </Card>
      ) : identityBlocked ? (
        // Identity resolution still in flight (or failed silently): show the
        // same skeletons as loading, without issuing any fetch.
        <div className="space-y-3">
          {[1, 2, 3].map(i => (
            <Card key={i} className="h-20 animate-pulse" style={{ background: "var(--bg-tertiary)", opacity: 0.4 }} />
          ))}
        </div>
      ) : isError ? (
        <Card className="flex flex-col items-center justify-center h-64 text-center p-8">
          <AlertCircle className="h-6 w-6 mb-3" style={{ color: "var(--danger)" }} />
          <p className="font-medium text-[13px]" style={{ color: "var(--text-primary)" }}>
            Failed to load follow-ups
          </p>
          <p className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
            Check API key or server.
          </p>
        </Card>
      ) : isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map(i => (
            <Card key={i} className="h-20 animate-pulse" style={{ background: "var(--bg-tertiary)", opacity: 0.4 }} />
          ))}
        </div>
      ) : filteredThreads.length === 0 ? (
        <Card className="flex flex-col items-center justify-center h-64 text-center p-8" style={{ borderStyle: "dashed" }}>
          <Send className="h-6 w-6 mb-3" style={{ color: "var(--text-tertiary)" }} />
          <p className="font-medium text-[13px]" style={{ color: "var(--text-primary)" }}>
            No email threads found
          </p>
          {/* 2026-07-29: two distinct empty states. Filtered-to-empty keeps
              the "adjust filters" hint; a truly empty pipeline explains how
              threads get here (the old copy pointed at a "Prospects" page
              that no longer exists in the nav) and calls out the
              admin-pause case, which silently stops queueing. */}
          {threads.length > 0 ? (
            <p className="text-[13px] max-w-[420px]" style={{ color: "var(--text-secondary)" }}>
              No threads match the current filters — adjust the State,
              Vertical or Company filters above{showArchived ? ", or untick Show archived" : ""}.
            </p>
          ) : (
            <p className="text-[13px] max-w-[420px]" style={{ color: "var(--text-secondary)" }}>
              Synced emails appear here once their first follow-up stage is
              queued (within ~15 min of sync). Check the Email Inspector to
              confirm syncing — and if the sidebar shows &ldquo;Paused by
              admin&rdquo;, follow-ups are not being queued for this account.
            </p>
          )}
        </Card>
      ) : (
        <div className="space-y-2">
          {filteredThreads.map((thread, idx) => {
            const isExpanded = expandedThread === thread.prospect_id;
            const pendingStage = thread.stages.find(s => s.status === "pending_approval");

            return (
              <Card
                key={thread.prospect_id}
                className="overflow-hidden"
                style={{
                  animation: `fadeUp 0.25s ease both`,
                  animationDelay: `${Math.min(idx, 15) * 0.03}s`,
                  borderColor: pendingStage
                    ? "var(--accent-border)"
                    : thread.followup_paused
                    ? "var(--warning-border)"
                    : undefined,
                }}
              >
                {/* ── Thread summary row ── */}
                <div
                  className="flex items-center gap-4 px-4 py-3 cursor-pointer"
                  style={{ minHeight: "56px" }}
                  onClick={() => setExpandedThread(isExpanded ? null : thread.prospect_id)}
                >
                  {/* Selection checkbox (Batch 2) */}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleRowSelect(thread.prospect_id, idx, e.shiftKey);
                    }}
                    onMouseDown={(e) => { if (e.shiftKey) e.preventDefault(); }}
                    className="flex items-center justify-center transition-all"
                    style={{
                      width: "20px",
                      height: "20px",
                      flexShrink: 0,
                      color: selectedIds.has(thread.prospect_id) ? "var(--accent)" : "var(--text-tertiary)",
                    }}
                    aria-label={selectedIds.has(thread.prospect_id) ? "Deselect prospect" : "Select prospect"}
                    title={selectedIds.has(thread.prospect_id) ? "Deselect" : "Select (Shift-click to select a range)"}
                  >
                    {selectedIds.has(thread.prospect_id)
                      ? <CheckSquare className="h-4 w-4" strokeWidth={1.75} />
                      : <Square className="h-4 w-4" strokeWidth={1.5} />}
                  </button>

                  {/* Chevron */}
                  <div style={{ color: "var(--text-tertiary)", flexShrink: 0 }}>
                    {isExpanded
                      ? <ChevronUp className="h-4 w-4" />
                      : <ChevronDown className="h-4 w-4" />}
                  </div>

                  {/* Prospect info */}
                  <div className="min-w-0 flex-1" style={{ maxWidth: "240px" }}>
                    <p className="font-medium text-[13px] truncate" style={{ color: "var(--text-primary)" }}>
                      {thread.prospect_name}
                    </p>
                    <div className="flex items-center gap-2">
                      <p className="text-[12px] truncate" style={{ color: "var(--text-secondary)" }}>
                        {thread.company || thread.email}
                      </p>
                      <span className="text-[10px] font-mono flex-shrink-0" style={{ color: "var(--text-tertiary)" }}>
                        {thread.stages.length > 0 ? new Date(thread.stages[0].created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : ""}
                      </span>
                    </div>
                  </div>

                  {/* Mode + stall pills (Phase 3c) */}
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
                  </div>

                  {/* Stage counter */}
                  <div className="flex-shrink-0 text-[12px] font-mono w-16 text-center" style={{ color: "var(--text-secondary)" }}>
                    {thread.current_stage}/{isUnlimitedFollowups(thread.max_followups) ? "∞" : thread.max_followups}
                  </div>

                  {/* Status / countdown */}
                  <div className="flex-shrink-0 w-48">
                    {thread.next_followup && !thread.followup_paused && !thread.replied && thread.next_followup.status !== "pending_approval" && thread.next_followup.status !== "drafted" ? (
                      <div className="flex items-center gap-2">
                        <Clock className="h-3 w-3 flex-shrink-0" style={{ color: "var(--text-tertiary)" }} />
                        <CountdownTimer scheduledAt={thread.next_followup.scheduled_at} />
                        <span className="text-[11px]" style={{ color: "var(--text-tertiary)" }}>
                          till F{thread.next_followup.stage}
                        </span>
                      </div>
                    ) : (
                      <StatusSummary thread={thread} />
                    )}
                  </div>

                  {/* Quick actions */}
                  <div className="flex items-center gap-1 flex-shrink-0" onClick={e => e.stopPropagation()}>
                    {thread.archived ? (
                      <Button
                        variant="ghost" size="sm"
                        onClick={() => handleRestore(thread.prospect_id)}
                        disabled={restoringId === thread.prospect_id}
                        title="Restore to the active pipeline (stays paused)"
                        style={{ color: "var(--accent)" }}
                      >
                        {restoringId === thread.prospect_id
                          ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          : <span className="text-[12px] font-medium">Restore</span>}
                      </Button>
                    ) : !thread.replied && (
                      <Button
                        variant="ghost" size="sm"
                        onClick={() => handleTogglePause(thread.prospect_id, thread.followup_paused)}
                        disabled={togglingPauseId === thread.prospect_id}
                        title={thread.followup_paused ? "Resume followups" : "Stop sending followups"}
                        style={{ color: thread.followup_paused ? "var(--success)" : "var(--danger)" }}
                      >
                        {togglingPauseId === thread.prospect_id
                          ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          : thread.followup_paused
                          ? <Play className="h-3.5 w-3.5" />
                          : <Square className="h-3.5 w-3.5" />}
                      </Button>
                    )}

                    {/* Prospect-level Kill: destructive, separated from pause/resume/restore. */}
                    {!thread.archived && (
                      <span className="ml-1 pl-1" style={{ borderLeft: "1px solid var(--border-default)" }}>
                        <ProspectKillControl
                          prospectId={thread.prospect_id}
                          prospectName={thread.prospect_name}
                          company={thread.company}
                          apiKey={apiKey}
                          disabled={!apiKey}
                          onKilled={() => invalidateAll()}
                        />
                      </span>
                    )}

                    <Button
                      variant="ghost" size="sm"
                      onClick={() => handleAddStage(thread.prospect_id)}
                      disabled={addingStageId === thread.prospect_id}
                      title="Add and send next stage now"
                      style={{ color: "var(--accent)" }}
                    >
                      {addingStageId === thread.prospect_id
                        ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        : <Plus className="h-3.5 w-3.5" />}
                    </Button>

                    {pendingStage && (
                      <>
                        <Button
                          size="sm"
                          onClick={() => handleApprove(pendingStage.id)}
                          disabled={approvingId === pendingStage.id}
                          className="gap-1" style={{ fontSize: "12px" }}
                        >
                          {approvingId === pendingStage.id
                            ? <Loader2 className="h-3 w-3 animate-spin" />
                            : <Check className="h-3 w-3" />}
                          Approve
                        </Button>
                        <Button
                          variant="ghost" size="sm"
                          onClick={() => handleReject(pendingStage.id)}
                          disabled={rejectingId === pendingStage.id}
                          style={{ color: "var(--danger)" }}
                        >
                          {rejectingId === pendingStage.id
                            ? <Loader2 className="h-3 w-3 animate-spin" />
                            : <X className="h-3 w-3" />}
                        </Button>
                      </>
                    )}

                    <Button
                      variant="ghost" size="sm"
                      onClick={() => setViewingOriginalFor(thread)}
                      title="View the original email this follow-up chain is based on"
                      style={{ color: "var(--text-tertiary)" }}
                    >
                      <MoreHorizontal className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>

                {/* ── Expanded detail panel ── */}
                {isExpanded && (
                  <div className="px-4 pb-4" style={{ borderTop: "1px solid var(--border-default)" }}>
                    {/* Thread subject */}
                    <div className="pt-3 pb-2 mb-3" style={{ borderBottom: "1px solid var(--border-default)" }}>
                      <span
                        className="font-medium uppercase tracking-[0.04em] block mb-1"
                        style={{ fontSize: "10px", color: "var(--text-tertiary)" }}
                      >
                        SUBJECT
                      </span>
                      <p className="text-[13px]" style={{ color: "var(--text-primary)" }}>
                        {thread.original_subject || "\u2014"}
                      </p>
                      <div className="flex items-center gap-3 mt-1.5">
                        <span className="text-[11px]" style={{ color: "var(--text-tertiary)" }}>
                          {thread.email}
                        </span>
                        <span className="text-[11px]" style={{ color: "var(--text-tertiary)" }}>
                          {VERTICAL_LABELS[thread.vertical] || thread.vertical}
                        </span>
                      </div>
                    </div>

                    {/* Stage list */}
                    <div className="space-y-2">
                      {thread.stages.map(stage => {
                        const isPreviewOpen = expandedPreview === stage.id;
                        const statusColor =
                          stage.status === "sent" ? "var(--success)"
                          : stage.status === "queued" || stage.status === "generating" ? "var(--warning)"
                          : stage.status === "pending_approval" ? "var(--accent)"
                          : stage.status === "failed" ? "var(--danger)"
                          : "var(--text-tertiary)";

                        return (
                          <div key={stage.id}>
                            <div
                              className="flex items-center gap-3 rounded-md px-3 py-2"
                              style={{ background: "var(--bg-tertiary)" }}
                            >
                              <div className="font-mono text-[12px] font-semibold w-8 text-center flex-shrink-0" style={{ color: statusColor }}>
                                F{stage.stage}
                              </div>
                              <div className="flex-shrink-0">
                                <span className="text-[11px] font-semibold uppercase tracking-[0.04em]" style={{ color: statusColor }}>
                                  {stage.status === "pending_approval" ? "PENDING" : stage.status.toUpperCase()}
                                </span>
                              </div>
                              <div className="flex-1 text-[12px]" style={{ color: "var(--text-secondary)" }}>
                                {stage.sent_at ? (
                                  <span className="font-mono">
                                    Sent {format(new Date(stage.sent_at), "MMM d, yyyy HH:mm")}
                                  </span>
                                ) : stage.status === "queued" || stage.status === "generating" ? (
                                  <span className="font-mono">
                                    Scheduled {format(new Date(stage.scheduled_at), "MMM d, yyyy HH:mm")}
                                  </span>
                                ) : stage.status === "pending_approval" ? (
                                  <span className="font-mono">Ready for review</span>
                                ) : (
                                  <span className="font-mono">
                                    {format(new Date(stage.scheduled_at), "MMM d, yyyy HH:mm")}
                                  </span>
                                )}
                              </div>
                              <div className="flex items-center gap-1 flex-shrink-0">
                                {(stage.generated_body || stage.generated_subject) && (
                                  <Button
                                    variant="ghost" size="sm"
                                    onClick={() => setExpandedPreview(isPreviewOpen ? null : stage.id)}
                                    style={{ color: "var(--text-tertiary)", padding: "4px 8px" }}
                                  >
                                    {isPreviewOpen ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                                  </Button>
                                )}
                                {stage.status === "pending_approval" && (
                                  <>
                                    <Button
                                      size="sm" onClick={() => handleApprove(stage.id)}
                                      disabled={approvingId === stage.id}
                                      className="gap-1" style={{ fontSize: "11px", padding: "4px 10px" }}
                                    >
                                      {approvingId === stage.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                                      Approve
                                    </Button>
                                    <Button
                                      variant="ghost" size="sm"
                                      onClick={() => handleReject(stage.id)}
                                      disabled={rejectingId === stage.id}
                                      style={{ color: "var(--danger)", padding: "4px 8px" }}
                                    >
                                      <X className="h-3 w-3" />
                                    </Button>
                                  </>
                                )}
                                {stage.status === "queued" && (
                                  <Button
                                    variant="ghost" size="sm"
                                    onClick={() => {
                                      if (confirm("Cancel this queued followup?")) {
                                        cancelMutation.mutate({ data: { followup_ids: [stage.id] } });
                                      }
                                    }}
                                    style={{ color: "var(--text-tertiary)", padding: "4px 8px" }}
                                    title="Cancel this stage"
                                  >
                                    <X className="h-3 w-3" />
                                  </Button>
                                )}
                              </div>
                            </div>

                            {/* Email preview */}
                            {isPreviewOpen && (stage.generated_body || stage.generated_subject) && (
                              <div
                                className="ml-11 mt-1 mb-1 p-3 rounded-md"
                                style={{ background: "var(--bg-elevated)", border: "1px solid var(--border-default)" }}
                              >
                                {stage.generated_subject && (
                                  <div className="mb-2">
                                    <span className="font-medium uppercase tracking-[0.04em] block mb-0.5" style={{ fontSize: "10px", color: "var(--text-tertiary)" }}>SUBJECT</span>
                                    <p className="text-[13px] font-medium" style={{ color: "var(--text-primary)" }}>{stage.generated_subject}</p>
                                  </div>
                                )}
                                {stage.generated_body && (
                                  <div>
                                    <span className="font-medium uppercase tracking-[0.04em] block mb-0.5" style={{ fontSize: "10px", color: "var(--text-tertiary)" }}>BODY</span>
                                    <div className="text-[12px] leading-relaxed whitespace-pre-wrap" style={{ color: "var(--text-primary)" }}>
                                      {stage.generated_body}
                                    </div>
                                  </div>
                                )}
                                {stage.error_message && (
                                  <div className="mt-2 text-[11px]" style={{ color: "var(--danger)" }}>
                                    Error: {stage.error_message}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>

                    {/* Bottom actions */}
                    <div className="flex items-center gap-2 mt-3 pt-3" style={{ borderTop: "1px solid var(--border-default)" }}>
                      <Button
                        variant="ghost" size="sm"
                        onClick={() => handleAddStage(thread.prospect_id)}
                        disabled={addingStageId === thread.prospect_id}
                        className="gap-1.5" style={{ color: "var(--accent)" }}
                      >
                        {addingStageId === thread.prospect_id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                        Add stage now
                      </Button>
                      {!thread.replied && !thread.followup_paused && (
                        <Button
                          variant="ghost" size="sm"
                          onClick={() => handleTogglePause(thread.prospect_id, false)}
                          disabled={togglingPauseId === thread.prospect_id}
                          className="gap-1.5" style={{ color: "var(--danger)" }}
                        >
                          {togglingPauseId === thread.prospect_id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Square className="h-3.5 w-3.5" />}
                          Stop all followups
                        </Button>
                      )}
                    </div>
                    {thread.followup_paused && !thread.replied && (
                      <div className="flex items-center gap-2 mt-3 pt-3" style={{ borderTop: "1px solid var(--border-default)" }}>
                        <Button
                          variant="ghost" size="sm"
                          onClick={() => handleTogglePause(thread.prospect_id, true)}
                          disabled={togglingPauseId === thread.prospect_id}
                          className="gap-1.5" style={{ color: "var(--success)" }}
                        >
                          {togglingPauseId === thread.prospect_id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                          Resume followups
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {viewingOriginalFor && (
        <OriginalEmailModal
          thread={viewingOriginalFor}
          onClose={() => setViewingOriginalFor(null)}
        />
      )}

      {/* Floating bulk-action bar (Batch 2) — appears when 1+ rows selected */}
      {selectedIds.size > 0 && (
        <div
          className="fixed left-1/2 z-30 flex items-center gap-3 px-4 py-3 rounded-lg shadow-lg"
          style={{
            bottom: "24px",
            transform: "translateX(-50%)",
            background: "var(--bg-elevated)",
            border: "1px solid var(--accent-border)",
            boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
            minWidth: "500px",
          }}
        >
          <span className="text-[13px] font-medium" style={{ color: "var(--text-primary)" }}>
            <span className="font-mono font-semibold" style={{ color: "var(--accent)" }}>{selectedIds.size}</span>
            {" "}selected
          </span>
          <div className="flex-1" />
          <Button
            size="sm"
            onClick={handleBulkSend}
            disabled={bulkSending || bulkPausing || bulkResuming}
            className="gap-1.5"
          >
            {bulkSending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
            Send all
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={handleBulkPause}
            disabled={bulkSending || bulkPausing || bulkResuming}
            className="gap-1.5"
            style={{ color: "var(--warning)", borderColor: "var(--warning-border)" }}
          >
            {bulkPausing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Pause className="h-3.5 w-3.5" />}
            Pause all
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={handleBulkResume}
            disabled={bulkSending || bulkPausing || bulkResuming}
            className="gap-1.5"
            style={{ color: "var(--success)", borderColor: "var(--success-border)" }}
          >
            {bulkResuming ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
            Resume all
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={clearSelection}
            disabled={bulkSending || bulkPausing || bulkResuming}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}

      <Modal
        isOpen={isQueueModalOpen}
        onClose={() => setIsQueueModalOpen(false)}
        title="Queue follow-ups batch"
        description="Schedule follow-ups for unreplied prospects."
      >
        <form onSubmit={handleQueueBatch} className="space-y-5 mt-4">
          <div className="space-y-1.5">
            <label className="text-[13px] font-medium" style={{ color: "var(--text-primary)" }}>Target Vertical</label>
            <Select value={queueVertical} onChange={e => setQueueVertical(e.target.value)}>
              <option value="all">All verticals</option>
              <option value="gaming_ua">Gaming UA</option>
              <option value="non_gaming_ua">Non-Gaming UA</option>
              <option value="cps">CPS</option>
              <option value="retargeting">Retargeting</option>
            </Select>
          </div>

          <div className="space-y-1.5">
            <label className="text-[13px] font-medium" style={{ color: "var(--text-primary)" }}>Initial Sent Date</label>
            <Input
              type="date"
              value={queueDate}
              onChange={e => setQueueDate(e.target.value)}
              className="w-full [color-scheme:dark]"
            />
            <p className="text-[11px]" style={{ color: "var(--text-tertiary)" }}>Leave blank to target all dates.</p>
          </div>

          <div className="space-y-1.5">
            <label className="text-[13px] font-medium" style={{ color: "var(--text-primary)" }}>Follow-up Stage</label>
            <Select value={queueStage} onChange={e => setQueueStage(e.target.value)} required>
              <option value="1">Stage 1</option>
              <option value="2">Stage 2</option>
              <option value="3">Stage 3</option>
            </Select>
          </div>

          {queueBatchMutation.isError && (
            <div className="p-3 rounded-lg flex items-center gap-2 text-[13px]" style={{ background: "var(--danger-muted)", color: "var(--danger)", border: "1px solid var(--danger-border)" }}>
              <AlertCircle className="h-4 w-4" />
              Failed to queue batch.
            </div>
          )}

          <div className="pt-4 flex gap-3 justify-end" style={{ borderTop: "1px solid var(--border-default)" }}>
            <Button type="button" variant="ghost" onClick={() => setIsQueueModalOpen(false)}>Cancel</Button>
            <Button type="submit" isLoading={queueBatchMutation.isPending}>
              Queue follow-ups
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  OriginalEmailModal                                                 */
/* ------------------------------------------------------------------ */

function OriginalEmailModal({
  thread,
  onClose,
}: {
  thread: EmailThread;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const gmailUrl = thread.gmail_thread_id
    ? `https://mail.google.com/mail/u/0/#all/${thread.gmail_thread_id}`
    : null;

  const sentLabel = thread.original_sent_at
    ? format(new Date(thread.original_sent_at), "PPP p")
    : null;

  const hasBody = !!(thread.original_body && thread.original_body.trim());
  const hasSummary = !!(thread.original_body_summary && thread.original_body_summary.trim());

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.6)" }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-lg flex flex-col"
        style={{
          background: "var(--surface-raised)",
          border: "1px solid var(--border-default)",
          maxHeight: "85vh",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-5 py-3"
          style={{ borderBottom: "1px solid var(--border-default)" }}
        >
          <div className="flex items-center gap-2">
            <Mail className="h-4 w-4" style={{ color: "var(--text-tertiary)" }} />
            <span
              className="font-medium uppercase tracking-[0.04em]"
              style={{ fontSize: "11px", color: "var(--text-tertiary)" }}
            >
              ORIGINAL EMAIL
            </span>
          </div>
          <Button
            variant="ghost" size="sm" onClick={onClose}
            style={{ color: "var(--text-tertiary)" }}
            title="Close (Esc)"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Meta */}
        <div className="px-5 py-3" style={{ borderBottom: "1px solid var(--border-default)" }}>
          <div className="grid grid-cols-[80px_1fr] gap-x-3 gap-y-1.5 text-[12px]">
            <span style={{ color: "var(--text-tertiary)" }}>To</span>
            <span style={{ color: "var(--text-primary)" }}>
              {thread.prospect_name && thread.prospect_name !== "Unknown"
                ? `${thread.prospect_name} <${thread.email}>`
                : thread.email}
            </span>
            {thread.company && (
              <>
                <span style={{ color: "var(--text-tertiary)" }}>Company</span>
                <span style={{ color: "var(--text-primary)" }}>{thread.company}</span>
              </>
            )}
            {sentLabel && (
              <>
                <span style={{ color: "var(--text-tertiary)" }}>Sent</span>
                <span style={{ color: "var(--text-primary)" }}>{sentLabel}</span>
              </>
            )}
            <span style={{ color: "var(--text-tertiary)" }}>Subject</span>
            <span className="font-medium" style={{ color: "var(--text-primary)" }}>
              {thread.original_subject || "\u2014"}
            </span>
          </div>
        </div>

        {/* Body */}
        <div className="px-5 py-4 overflow-y-auto flex-1">
          {hasBody ? (
            <pre
              className="whitespace-pre-wrap font-sans text-[13px] leading-relaxed"
              style={{ color: "var(--text-primary)", margin: 0 }}
            >
              {thread.original_body}
            </pre>
          ) : hasSummary ? (
            <div>
              <p
                className="text-[11px] uppercase tracking-[0.04em] mb-2"
                style={{ color: "var(--text-tertiary)" }}
              >
                TOPIC SUMMARY (full body not captured for this prospect)
              </p>
              <p className="text-[13px] leading-relaxed" style={{ color: "var(--text-primary)" }}>
                {thread.original_body_summary}
              </p>
            </div>
          ) : (
            <p
              className="text-[12px] italic"
              style={{ color: "var(--text-tertiary)" }}
            >
              Original email content is not available for this prospect. It was synced before body capture was enabled.
              {gmailUrl && " You can open the thread in Gmail using the link below."}
            </p>
          )}
        </div>

        {/* Footer */}
        {gmailUrl && (
          <div
            className="px-5 py-3 flex justify-end"
            style={{ borderTop: "1px solid var(--border-default)" }}
          >
            <a
              href={gmailUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-[12px] font-medium"
              style={{ color: "var(--accent)" }}
            >
              Open in Gmail
              <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
