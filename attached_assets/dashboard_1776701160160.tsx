import React, { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useApiKey } from "@/hooks/use-api-key";
import { useCurrentUser } from "@/hooks/use-current-user";
import {
  useGetStats,
  useTriggerSync,
  useTriggerProcess,
  useGetCampaignStatus,
  useStopCampaign,
} from "@workspace/api-client-react";
import { Card, Button, Badge, Modal } from "@/components/ui";
import { RefreshCw, Play, AlertCircle, Square, Loader2, Send, Zap } from "lucide-react";
import { formatNumber } from "@/lib/utils";

export default function Dashboard() {
  const { apiKey } = useApiKey();
  const { user: currentUser } = useCurrentUser();
  const queryClient = useQueryClient();
  const requestOpts = { request: { headers: { "x-api-key": apiKey || "" } } };

  const [showStopConfirm, setShowStopConfirm] = useState(false);
  const [campaignMsg, setCampaignMsg] = useState<string | null>(null);
  const [campaignError, setCampaignError] = useState(false);
  const [targetUserId, setTargetUserId] = useState<number | null>(null);
  const [queueLoading, setQueueLoading] = useState<string | null>(null);

  const { data: stats, isLoading, isError } = useGetStats({ ...requestOpts, query: { enabled: !!apiKey } });

  const { data: campaignStatus, isLoading: campaignLoading } = useGetCampaignStatus({
    ...requestOpts,
    query: { enabled: !!apiKey, refetchInterval: 10000 },
  });

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
    queryClient.invalidateQueries({ queryKey: ["/api/prospects"] });
    queryClient.invalidateQueries({ queryKey: ["/api/followups"] });
    queryClient.invalidateQueries({ queryKey: ["/api/campaign/status"] });
  };

  const syncMutation = useTriggerSync({
    ...requestOpts,
    mutation: { onSuccess: invalidateAll },
  });

  const processMutation = useTriggerProcess({
    ...requestOpts,
    mutation: { onSuccess: invalidateAll },
  });

  const stopMutation = useStopCampaign({
    ...requestOpts,
    mutation: {
      onSuccess: (data: any) => {
        setShowStopConfirm(false);
        setTargetUserId(null);
        setCampaignError(false);
        setCampaignMsg(data.message);
        invalidateAll();
        setTimeout(() => setCampaignMsg(null), 8000);
      },
      onError: (err: any) => {
        setShowStopConfirm(false);
        setTargetUserId(null);
        setCampaignError(true);
        setCampaignMsg(err?.message || "Failed to stop campaign");
        setTimeout(() => setCampaignMsg(null), 5000);
      },
    },
  });

  const handleQueueFollowups = async (userId: number) => {
    const loadingKey = String(userId);
    setQueueLoading(loadingKey);
    try {
      const base = import.meta.env.BASE_URL || "/";
      const res = await fetch(`${base}api/campaign/queue`, {
        method: "POST",
        headers: { "x-api-key": apiKey || "", "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: String(userId) }),
      });
      const data = await res.json();
      if (!res.ok) {
        setCampaignError(true);
        setCampaignMsg(data.error || "Failed to queue follow-ups");
      } else {
        setCampaignError(false);
        setCampaignMsg(data.message);
      }
      invalidateAll();
      setTimeout(() => setCampaignMsg(null), 8000);
    } catch (err: any) {
      setCampaignError(true);
      setCampaignMsg(err.message || "Failed to queue follow-ups");
      setTimeout(() => setCampaignMsg(null), 5000);
    } finally {
      setQueueLoading(null);
    }
  };

  const handleStopUser = async (userId: number) => {
    setQueueLoading(`stop-${userId}`);
    try {
      const base = import.meta.env.BASE_URL || "/";
      const res = await fetch(`${base}api/campaign/stop`, {
        method: "POST",
        headers: { "x-api-key": apiKey || "", "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: String(userId) }),
      });
      const data = await res.json();
      if (!res.ok) {
        setCampaignError(true);
        setCampaignMsg(data.error || "Failed to stop");
      } else {
        setCampaignError(false);
        setCampaignMsg(data.message);
      }
      invalidateAll();
      setTimeout(() => setCampaignMsg(null), 8000);
    } catch (err: any) {
      setCampaignError(true);
      setCampaignMsg(err.message || "Failed to stop");
      setTimeout(() => setCampaignMsg(null), 5000);
    } finally {
      setQueueLoading(null);
    }
  };

  if (isLoading) {
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <RefreshCw className="h-5 w-5 animate-spin" style={{ color: "var(--text-tertiary)" }} />
      </div>
    );
  }

  if (isError || !stats) {
    return (
      <div className="flex h-[60vh] flex-col items-center justify-center text-center">
        <AlertCircle className="h-8 w-8 mb-4" style={{ color: "var(--danger)" }} />
        <h2 className="font-semibold" style={{ fontSize: "14px" }}>Failed to load statistics</h2>
        <p className="mt-2 text-[13px]" style={{ color: "var(--text-secondary)" }}>Check your API key or server status.</p>
      </div>
    );
  }

  const statCards = [
    { label: "TOTAL SENT", value: stats.total_sent },
    { label: "UNREPLIED", value: stats.unreplied },
    { label: "REPLIED", value: stats.replied },
    { label: "QUEUED", value: stats.queued_followups },
    { label: "SENT FOLLOW-UPS", value: stats.sent_followups },
  ];

  const isActive = campaignStatus?.active || false;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 style={{ fontSize: "20px", fontWeight: 600, letterSpacing: "-0.02em" }}>Overview</h1>
        <div className="flex gap-3">
          <Button
            variant="secondary"
            onClick={() => syncMutation.mutate()}
            isLoading={syncMutation.isPending}
            className="gap-2"
          >
            <RefreshCw className="h-4 w-4" />
            Sync Gmail
          </Button>
          <Button
            onClick={() => processMutation.mutate()}
            isLoading={processMutation.isPending}
            className="gap-2"
          >
            <Play className="h-4 w-4" />
            Process queue
          </Button>
        </div>
      </div>

      {campaignMsg && (
        <div
          className="rounded-lg px-4 py-3 text-[13px]"
          style={{
            background: campaignError ? "rgba(239, 68, 68, 0.1)" : "rgba(34, 197, 94, 0.1)",
            border: `1px solid ${campaignError ? "rgba(239, 68, 68, 0.3)" : "rgba(34, 197, 94, 0.3)"}`,
            color: campaignError ? "var(--danger)" : "var(--success)",
          }}
        >
          {campaignMsg}
        </div>
      )}

      <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(5, 1fr)" }}>
        {statCards.map((s, i) => (
          <Card key={s.label} className="p-4" style={{ animation: `fadeUp 0.3s ease both`, animationDelay: `${i * 0.05}s` }}>
            <p className="text-[11px] tracking-wide font-medium mb-2" style={{ color: "var(--text-tertiary)" }}>{s.label}</p>
            <p className="font-semibold font-mono" style={{ fontSize: "24px", letterSpacing: "-0.02em" }}>{formatNumber(s.value || 0)}</p>
          </Card>
        ))}
      </div>

      <Card className="p-5" style={{ animation: `fadeUp 0.3s ease both`, animationDelay: "0.3s" }}>
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-3">
            <h2 style={{ fontSize: "14px", fontWeight: 600 }}>Campaign Control</h2>
            {campaignLoading && (
              <Loader2 className="h-3.5 w-3.5 animate-spin" style={{ color: "var(--text-tertiary)" }} />
            )}
          </div>
          {isActive && (
            <Button
              variant="secondary"
              onClick={() => { setTargetUserId(null); setShowStopConfirm(true); }}
              className="gap-2"
              style={{ borderColor: "var(--danger)", color: "var(--danger)" }}
              size="sm"
            >
              <Square className="h-3.5 w-3.5" />
              Stop All
            </Button>
          )}
        </div>

        <div
          className="rounded-lg p-3 mb-5"
          style={{
            background: "rgba(59, 130, 246, 0.06)",
            border: "1px solid rgba(59, 130, 246, 0.15)",
          }}
        >
          <p className="text-[12px]" style={{ color: "var(--text-secondary)" }}>
            <strong>How it works:</strong> Gmail sync detects labeled emails and creates prospects.
            To start follow-ups, click <strong>"Queue follow-ups"</strong> on a campaign below.
            The system will generate AI drafts and send them on schedule.
          </p>
        </div>

        {campaignStatus?.users && campaignStatus.users.filter((u: any) => !currentUser?.userId || u.id === currentUser.userId).length > 0 && (
          <div className="space-y-5">
            {campaignStatus.users.filter((u: any) => !currentUser?.userId || u.id === currentUser.userId).map((u: any) => {
              const allCampaigns = u.campaigns || [];
              const totalProspects = allCampaigns.reduce((sum: number, c: any) => sum + c.total, 0);
              const totalQueued = allCampaigns.reduce((sum: number, c: any) => sum + c.queued, 0);
              const totalSent = allCampaigns.reduce((sum: number, c: any) => sum + c.sent, 0);
              const totalUnreplied = allCampaigns.reduce((sum: number, c: any) => sum + c.unreplied, 0);
              const totalPaused = allCampaigns.reduce((sum: number, c: any) => sum + c.paused, 0);
              const totalActionable = allCampaigns.reduce((sum: number, c: any) => sum + c.actionable, 0);
              const loadingKey = String(u.id);

              return (
                <div
                  key={u.id}
                  className="rounded-lg p-3 flex items-center justify-between"
                  style={{ background: "var(--bg-tertiary)", border: "1px solid transparent" }}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div
                      className="w-7 h-7 rounded flex items-center justify-center shrink-0"
                      style={{ background: "rgba(59, 130, 246, 0.12)" }}
                    >
                      <Send className="h-3.5 w-3.5" style={{ color: "var(--accent)" }} />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="text-[12px] font-medium" style={{ color: "var(--text-primary)" }}>
                          {u.name || u.email.split("@")[0]}
                        </span>
                        <span className="text-[10px] font-mono" style={{ color: "var(--text-tertiary)" }}>
                          {u.email}
                        </span>
                      </div>
                      <div className="flex gap-3 text-[11px]" style={{ color: "var(--text-tertiary)" }}>
                        <span>
                          <span className="font-mono font-semibold">{totalProspects}</span> prospects
                        </span>
                        <span>
                          <span className="font-mono font-semibold" style={{ color: totalQueued > 0 ? "var(--warning)" : "inherit" }}>
                            {totalQueued}
                          </span> queued
                        </span>
                        <span>
                          <span className="font-mono font-semibold" style={{ color: totalSent > 0 ? "var(--success)" : "inherit" }}>
                            {totalSent}
                          </span> sent
                        </span>
                        <span><span className="font-mono font-semibold">{totalUnreplied}</span> unreplied</span>
                        {totalPaused > 0 && (
                          <span>
                            <span className="font-mono font-semibold" style={{ color: "var(--warning)" }}>{totalPaused}</span> paused
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex gap-2 ml-3 shrink-0">
                    {totalActionable > 0 && (
                      <Button
                        size="sm"
                        onClick={() => handleQueueFollowups(u.id)}
                        disabled={queueLoading === loadingKey}
                        className="gap-1.5"
                        style={{
                          background: "var(--accent)",
                          borderColor: "var(--accent)",
                          fontSize: "12px",
                        }}
                      >
                        {queueLoading === loadingKey ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <Zap className="h-3 w-3" />
                        )}
                        Queue follow-ups ({totalActionable})
                      </Button>
                    )}
                    {totalQueued > 0 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleStopUser(u.id)}
                        disabled={queueLoading === `stop-${u.id}`}
                        className="gap-1"
                        style={{ color: "var(--danger)", fontSize: "12px" }}
                      >
                        {queueLoading === `stop-${u.id}` ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <Square className="h-3 w-3" />
                        )}
                        Stop
                      </Button>
                    )}
                    {totalActionable === 0 && totalQueued === 0 && totalProspects === 0 && (
                      <span className="text-[11px]" style={{ color: "var(--text-tertiary)", opacity: 0.5 }}>
                        No prospects yet
                      </span>
                    )}
                    {totalActionable === 0 && totalQueued === 0 && totalProspects > 0 && (
                      <span className="text-[11px]" style={{ color: "var(--text-tertiary)" }}>
                        All caught up
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="mt-4 rounded-lg p-3" style={{ background: "var(--bg-tertiary)" }}>
          <p className="text-[11px]" style={{ color: "var(--text-tertiary)" }}>
            Follow-ups are queued on a scheduled basis and sent automatically.
            Use <strong>"Send now"</strong> on the Prospects page to immediately trigger the next stage for any prospect.
          </p>
        </div>
      </Card>

      <Modal
        isOpen={showStopConfirm}
        onClose={() => setShowStopConfirm(false)}
        title="Stop All Campaigns"
      >
        <div className="space-y-4">
          <p className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
            This will cancel all your queued follow-ups and stop auto-sending.
            Follow-ups already sent will not be affected.
          </p>
          <div className="flex justify-end gap-3">
            <Button variant="secondary" onClick={() => setShowStopConfirm(false)}>Cancel</Button>
            <Button
              onClick={() => stopMutation.mutate()}
              isLoading={stopMutation.isPending}
              className="gap-2"
              style={{ background: "var(--danger)", borderColor: "var(--danger)" }}
            >
              <Square className="h-4 w-4" />
              Stop All
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
