import React, { useState, useMemo, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { format, formatDistanceToNow, isPast } from "date-fns";
import { useApiKey } from "@/hooks/use-api-key";
import { useGetFollowups, useCancelFollowups } from "@workspace/api-client-react";
import { Card, Button, Badge, Select } from "@/components/ui";
import {
  Send, AlertCircle, Check, X, ChevronDown, ChevronUp, Loader2,
  Pause, Play, Plus, Clock, Ban, Square, Eye, EyeOff,
} from "lucide-react";

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
  batch_label?: string;
  is_test_campaign?: boolean;
  followup_paused?: boolean;
  replied?: number;
  max_followups?: number;
}

interface EmailThread {
  prospect_id: number;
  prospect_name: string;
  company: string;
  email: string;
  vertical: string;
  original_subject: string;
  is_test_campaign: boolean;
  followup_paused: boolean;
  replied: boolean;
  max_followups: number;
  stages: FollowupRow[];
  current_stage: number;
  next_followup: FollowupRow | null;
  has_more_scheduled: boolean;
  all_done: boolean;
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
      ["queued", "generating", "pending_approval"].includes(r.status)
    );
    const maxSentStage = sentStages.length > 0
      ? Math.max(...sentStages.map(s => s.stage))
      : 0;

    const currentStage = maxSentStage;
    const maxFollowups = first.max_followups ?? 3;

    const nextQueued = activeStages.length > 0
      ? activeStages.sort((a, b) =>
          new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime()
        )[0]
      : null;

    const allDone = activeStages.length === 0 && currentStage >= maxFollowups;

    threads.push({
      prospect_id: pid,
      prospect_name: first.prospect_name || "Unknown",
      company: first.company || "",
      email: first.email,
      vertical: first.vertical,
      original_subject: first.original_subject,
      is_test_campaign: !!first.is_test_campaign,
      followup_paused: !!first.followup_paused,
      replied: !!first.replied,
      max_followups: maxFollowups,
      stages: sorted,
      current_stage: currentStage,
      next_followup: nextQueued,
      has_more_scheduled: activeStages.length > 0,
      all_done: allDone,
    });
  }

  return threads.sort((a, b) => {
    if (a.has_more_scheduled && !b.has_more_scheduled) return -1;
    if (!a.has_more_scheduled && b.has_more_scheduled) return 1;
    if (a.next_followup && b.next_followup) {
      return new Date(a.next_followup.scheduled_at).getTime() -
             new Date(b.next_followup.scheduled_at).getTime();
    }
    return b.current_stage - a.current_stage;
  });
}

const VERTICAL_LABELS: Record<string, string> = {
  gaming_ua: "Gaming UA",
  non_gaming_ua: "Non-Gaming UA",
  cps: "CPS / Fintech",
  retargeting: "Retargeting",
};

/* ------------------------------------------------------------------ */
/*  Sub-components                                                     */
/* ------------------------------------------------------------------ */

function CampaignBadge({ isTest }: { isTest: boolean }) {
  return isTest ? (
    <Badge
      variant="outline"
      style={{
        background: "rgba(139, 92, 246, 0.1)",
        color: "#a78bfa",
        border: "1px solid rgba(139, 92, 246, 0.3)",
        fontSize: "10px",
        letterSpacing: "0.05em",
      }}
    >
      TEST
    </Badge>
  ) : (
    <Badge
      variant="outline"
      style={{
        background: "rgba(34, 197, 94, 0.08)",
        color: "var(--success)",
        border: "1px solid rgba(34, 197, 94, 0.25)",
        fontSize: "10px",
        letterSpacing: "0.05em",
      }}
    >
      PROD
    </Badge>
  );
}

function StageProgress({ thread }: { thread: EmailThread }) {
  const maxStages = thread.max_followups;
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
  if (thread.replied) {
    return (
      <span className="text-[12px] font-medium" style={{ color: "var(--success)" }}>
        Replied — thread closed
      </span>
    );
  }
  if (thread.followup_paused) {
    return (
      <span className="text-[12px] font-medium flex items-center gap-1" style={{ color: "var(--warning)" }}>
        <Pause className="h-3 w-3" /> Paused
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
    return null; // handled by CountdownTimer in the main row
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

export default function Followups() {
  const { apiKey } = useApiKey();
  const queryClient = useQueryClient();
  const requestOpts = { request: { headers: { "x-api-key": apiKey || "" } } };

  const [filterCampaign, setFilterCampaign] = useState<string>("all");
  const [filterState, setFilterState] = useState<string>("all");
  const [expandedThread, setExpandedThread] = useState<number | null>(null);
  const [expandedPreview, setExpandedPreview] = useState<number | null>(null);

  const [approvingId, setApprovingId] = useState<number | null>(null);
  const [rejectingId, setRejectingId] = useState<number | null>(null);
  const [togglingPauseId, setTogglingPauseId] = useState<number | null>(null);
  const [addingStageId, setAddingStageId] = useState<number | null>(null);
  const [feedbackMsg, setFeedbackMsg] = useState<string | null>(null);
  const [feedbackError, setFeedbackError] = useState(false);

  const { data: followups, isLoading, isError } = useGetFollowups(
    {},
    { ...requestOpts, query: { enabled: !!apiKey, refetchInterval: 30000 } }
  );

  const cancelMutation = useCancelFollowups({
    ...requestOpts,
    mutation: { onSuccess: () => invalidateAll() },
  });

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
    if (!followups || !Array.isArray(followups)) return [];
    return groupByThread(followups as FollowupRow[]);
  }, [followups]);

  const filteredThreads = useMemo(() => {
    return threads.filter(t => {
      if (filterCampaign === "test" && !t.is_test_campaign) return false;
      if (filterCampaign === "production" && t.is_test_campaign) return false;
      if (filterState === "active" && (t.all_done || t.followup_paused || t.replied)) return false;
      if (filterState === "paused" && !t.followup_paused) return false;
      if (filterState === "completed" && !t.all_done) return false;
      if (filterState === "pending" && !t.stages.some(s => s.status === "pending_approval")) return false;
      return true;
    });
  }, [threads, filterCampaign, filterState]);

  /* ---- Actions ---- */

  const handleTogglePause = async (prospectId: number, currentlyPaused: boolean) => {
    setTogglingPauseId(prospectId);
    try {
      const base = import.meta.env.BASE_URL || "/";
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
      const base = import.meta.env.BASE_URL || "/";
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

  const handleApprove = async (id: number) => {
    setApprovingId(id);
    try {
      const base = import.meta.env.BASE_URL || "/";
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
      const base = import.meta.env.BASE_URL || "/";
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

  const activeCount = threads.filter(t => t.has_more_scheduled && !t.followup_paused && !t.replied).length;
  const pausedCount = threads.filter(t => t.followup_paused).length;
  const pendingCount = threads.filter(t => t.stages.some(s => s.status === "pending_approval")).length;
  const doneCount = threads.filter(t => t.all_done).length;

  /* ---- Render ---- */

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 style={{ fontSize: "20px", fontWeight: 600, letterSpacing: "-0.02em" }}>
          Follow-ups
        </h1>
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
      </div>

      {/* Filters */}
      <div className="flex gap-4">
        <div className="w-48">
          <label
            className="block mb-1.5 font-medium uppercase tracking-[0.04em]"
            style={{ fontSize: "11px", color: "var(--text-tertiary)" }}
          >
            CAMPAIGN
          </label>
          <Select value={filterCampaign} onChange={e => setFilterCampaign(e.target.value)}>
            <option value="all">All campaigns</option>
            <option value="production">Production only</option>
            <option value="test">Test only</option>
          </Select>
        </div>
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
      </div>

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
      {isError ? (
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
          <p className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
            Adjust filters or queue a batch from Prospects.
          </p>
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
                  {/* Chevron */}
                  <div style={{ color: "var(--text-tertiary)", flexShrink: 0 }}>
                    {isExpanded
                      ? <ChevronUp className="h-4 w-4" />
                      : <ChevronDown className="h-4 w-4" />}
                  </div>

                  {/* Prospect info */}
                  <div className="min-w-0 flex-1" style={{ maxWidth: "220px" }}>
                    <p className="font-medium text-[13px] truncate" style={{ color: "var(--text-primary)" }}>
                      {thread.prospect_name}
                    </p>
                    <p className="text-[12px] truncate" style={{ color: "var(--text-secondary)" }}>
                      {thread.company || thread.email}
                    </p>
                  </div>

                  {/* Campaign badge */}
                  <div className="flex-shrink-0">
                    <CampaignBadge isTest={thread.is_test_campaign} />
                  </div>

                  {/* Stage progress dots */}
                  <div className="flex-shrink-0">
                    <StageProgress thread={thread} />
                  </div>

                  {/* Stage counter */}
                  <div className="flex-shrink-0 text-[12px] font-mono w-16 text-center" style={{ color: "var(--text-secondary)" }}>
                    {thread.current_stage}/{thread.max_followups}
                  </div>

                  {/* Status / countdown */}
                  <div className="flex-shrink-0 w-48">
                    {thread.next_followup && !thread.followup_paused && !thread.replied && thread.next_followup.status !== "pending_approval" ? (
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
                    {!thread.replied && (
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

                    {!thread.replied && !thread.followup_paused && (
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
                    )}

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
                    {!thread.replied && !thread.followup_paused && (
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
                        <Button
                          variant="ghost" size="sm"
                          onClick={() => handleTogglePause(thread.prospect_id, false)}
                          disabled={togglingPauseId === thread.prospect_id}
                          className="gap-1.5" style={{ color: "var(--danger)" }}
                        >
                          {togglingPauseId === thread.prospect_id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Square className="h-3.5 w-3.5" />}
                          Stop all followups
                        </Button>
                      </div>
                    )}
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
    </div>
  );
}
