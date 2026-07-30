import React, { useState, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { useApiKey } from "@/hooks/use-api-key";
import { useCurrentUser } from "@/hooks/use-current-user";
import { useGetProspects, useQueueBatch, useGetGmailAccounts } from "@workspace/api-client-react";
import { Card, Button, Badge, Table, TableHeader, TableRow, TableHead, TableBody, TableCell, Select, Modal, Input } from "@/components/ui";
import { Layers, Shield, MailPlus, AlertCircle, Zap, Loader2, Pause, Play, FlaskConical, ArrowRightLeft } from "lucide-react";

export default function Prospects() {
  const { apiKey } = useApiKey();
  const { user: currentUser } = useCurrentUser();
  const queryClient = useQueryClient();
  const requestOpts = { request: { headers: { "x-api-key": apiKey || "" } } };

  // Load current user's approval setting
  const { data: accountsData } = useGetGmailAccounts({ ...requestOpts, query: { enabled: !!apiKey } });
  const accounts: any[] = (accountsData as any)?.accounts || [];
  const myAccount = accounts.find((a: any) => currentUser?.userId ? a.id === currentUser.userId : false) || accounts[0];
  const requireApproval = myAccount?.requireApproval ?? false;

  const handleToggleApproval = async () => {
    if (!myAccount) return;
    try {
      const base = import.meta.env.BASE_URL || "/";
      await fetch(`${base}api/gmail/accounts/${myAccount.id}/settings`, {
        method: "PUT",
        headers: { "x-api-key": apiKey || "", "Content-Type": "application/json" },
        body: JSON.stringify({ requireApproval: !requireApproval }),
      });
      queryClient.invalidateQueries({ queryKey: ["/api/gmail/accounts"] });
    } catch {}
  };

  const [filterVertical, setFilterVertical] = useState<string>("all");
  const [filterReplied, setFilterReplied] = useState<string>("all");
  const [filterCampaign, setFilterCampaign] = useState<string>("all");

  const [isQueueModalOpen, setIsQueueModalOpen] = useState(false);
  const [queueVertical, setQueueVertical] = useState("all");
  const [queueDate, setQueueDate] = useState("");
  const [queueStage, setQueueStage] = useState("1");
  const [followingUpId, setFollowingUpId] = useState<number | null>(null);
  const [followUpMsg, setFollowUpMsg] = useState<string | null>(null);
  const [followUpError, setFollowUpError] = useState(false);
  const [togglingPauseId, setTogglingPauseId] = useState<number | null>(null);
  const [togglingCampaignId, setTogglingCampaignId] = useState<number | null>(null);

  const queryParams = {
    ...(filterVertical !== "all" ? { vertical: filterVertical } : {}),
    ...(filterReplied !== "all" ? { replied: filterReplied } : {})
  };

  const { data: prospectGroups, isLoading, isError } = useGetProspects({ ...queryParams, ...(currentUser?.userId ? { userId: String(currentUser.userId) } : {}) }, { ...requestOpts, query: { enabled: !!apiKey } });

  const queueBatchMutation = useQueueBatch({
    ...requestOpts,
    mutation: {
      onSuccess: () => {
        setIsQueueModalOpen(false);
        queryClient.invalidateQueries({ queryKey: ["/api/prospects"] });
        queryClient.invalidateQueries({ queryKey: ["/api/followups"] });
        queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      }
    }
  });

  const handleQueueBatch = (e: React.FormEvent) => {
    e.preventDefault();
    queueBatchMutation.mutate({
      data: {
        stage: parseInt(queueStage),
        ...(queueVertical !== "all" ? { vertical: queueVertical } : {}),
        ...(queueDate ? { sent_date: queueDate } : {})
      }
    });
  };

  const handleFollowUpNow = async (prospectId: number) => {
    setFollowingUpId(prospectId);
    setFollowUpMsg(null);
    setFollowUpError(false);
    try {
      const base = import.meta.env.BASE_URL || "/";
      const res = await fetch(`${base}api/followup-now/${prospectId}`, {
        method: "POST",
        headers: { "x-api-key": apiKey || "", "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) {
        setFollowUpError(true);
        setFollowUpMsg(data.error || "Failed to trigger follow-up");
        setTimeout(() => setFollowUpMsg(null), 5000);
        return;
      }
      setFollowUpMsg(data.message);
      queryClient.invalidateQueries({ queryKey: ["/api/followups"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/prospects"] });
      setTimeout(() => setFollowUpMsg(null), 8000);
    } catch (err: any) {
      setFollowUpError(true);
      setFollowUpMsg(err.message || "Failed to trigger follow-up");
      setTimeout(() => setFollowUpMsg(null), 5000);
    } finally {
      setFollowingUpId(null);
    }
  };

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
      if (!res.ok) {
        setFollowUpError(true);
        setFollowUpMsg(data.error || `Failed to ${endpoint} prospect`);
        setTimeout(() => setFollowUpMsg(null), 5000);
        return;
      }
      setFollowUpError(false);
      const name = currentlyPaused ? "Resumed" : "Paused";
      const extra = data.queued_stage ? ` — queued F${data.queued_stage}` : data.cancelled_queued ? ` — cancelled ${data.cancelled_queued} queued` : "";
      setFollowUpMsg(`${name} follow-ups for prospect #${prospectId}${extra}`);
      queryClient.invalidateQueries({ queryKey: ["/api/prospects"] });
      queryClient.invalidateQueries({ queryKey: ["/api/followups"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      setTimeout(() => setFollowUpMsg(null), 5000);
    } catch (err: any) {
      setFollowUpError(true);
      setFollowUpMsg(err.message || "Failed to toggle pause");
      setTimeout(() => setFollowUpMsg(null), 5000);
    } finally {
      setTogglingPauseId(null);
    }
  };

  const handleToggleCampaign = async (prospectId: number, currentlyTest: boolean) => {
    setTogglingCampaignId(prospectId);
    setFollowUpMsg(null);
    setFollowUpError(false);
    try {
      const base = import.meta.env.BASE_URL || "/";
      const newType = currentlyTest ? "production" : "test";
      const res = await fetch(`${base}api/prospect/${prospectId}/campaign-type`, {
        method: "POST",
        headers: { "x-api-key": apiKey || "", "Content-Type": "application/json" },
        body: JSON.stringify({ campaign_type: newType }),
      });
      const data = await res.json();
      if (!res.ok) {
        setFollowUpError(true);
        setFollowUpMsg(data.error || "Failed to change campaign");
        setTimeout(() => setFollowUpMsg(null), 5000);
        return;
      }
      setFollowUpError(false);
      setFollowUpMsg(data.message);
      queryClient.invalidateQueries({ queryKey: ["/api/prospects"] });
      queryClient.invalidateQueries({ queryKey: ["/api/campaign/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      setTimeout(() => setFollowUpMsg(null), 5000);
    } catch (err: any) {
      setFollowUpError(true);
      setFollowUpMsg(err.message || "Failed to change campaign");
      setTimeout(() => setFollowUpMsg(null), 5000);
    } finally {
      setTogglingCampaignId(null);
    }
  };

  const renderStatusBadge = (status?: string | null, scheduled?: string | null, error?: string | null) => {
    if (!status) return <span style={{ color: "var(--text-tertiary)", fontSize: "12px" }}>{'\u2014'}</span>;
    const scheduledLabel = scheduled ? format(new Date(scheduled), 'MMM d, HH:mm') : null;
    switch (status) {
      case "queued": return (
        <div className="flex flex-col items-center gap-0.5">
          <Badge variant="warning">QUEUED</Badge>
          {scheduledLabel && <span className="font-mono text-[10px]" style={{ color: "var(--text-tertiary)" }}>{scheduledLabel}</span>}
        </div>
      );
      case "sent": return <Badge variant="success">SENT</Badge>;
      case "generating": return <Badge variant="outline" style={{ borderColor: "var(--accent)", color: "var(--accent)" }}>GENERATING</Badge>;
      case "pending_approval": return (
        <div className="flex flex-col items-center gap-0.5">
          <Badge variant="outline" style={{ borderColor: "var(--accent)", color: "var(--accent)" }}>PENDING</Badge>
          {scheduledLabel && <span className="font-mono text-[10px]" style={{ color: "var(--text-tertiary)" }}>{scheduledLabel}</span>}
        </div>
      );
      case "cancelled": return <Badge variant="secondary">CANCELLED</Badge>;
      case "failed": return (
        <div className="flex flex-col items-center gap-0.5 max-w-[140px]">
          <Badge variant="destructive">FAILED</Badge>
          {error && (
            <span
              className="text-[10px] text-center truncate w-full"
              style={{ color: "var(--text-tertiary)" }}
              title={error}
            >
              {error}
            </span>
          )}
        </div>
      );
      default: return <Badge variant="outline">{status}</Badge>;
    }
  };

  const filteredGroups = useMemo(() => {
    if (!prospectGroups) return [];
    if (filterCampaign === "all") return prospectGroups;
    return (prospectGroups as any[]).map((group: any) => {
      const filtered = group.prospects.filter((p: any) =>
        filterCampaign === "test" ? p.is_test_campaign : !p.is_test_campaign
      );
      if (filtered.length === 0) return null;
      return {
        ...group,
        prospects: filtered,
        total: filtered.length,
        unreplied: filtered.filter((p: any) => !p.replied).length,
        replied: filtered.filter((p: any) => p.replied).length,
      };
    }).filter(Boolean);
  }, [prospectGroups, filterCampaign]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 style={{ fontSize: "20px", fontWeight: 600, letterSpacing: "-0.02em" }}>Prospects</h1>
        <div className="flex items-center gap-3">
          <button
            onClick={handleToggleApproval}
            className="flex items-center gap-2 px-3 py-2 rounded-md text-[12px] font-medium transition-all"
            style={{
              background: requireApproval ? "var(--accent-muted)" : "var(--bg-tertiary)",
              border: `1px solid ${requireApproval ? "var(--accent-border)" : "var(--border-default)"}`,
              color: requireApproval ? "var(--accent)" : "var(--text-secondary)",
            }}
            title={requireApproval ? "Pre-approval ON: followups need manual approval before sending" : "Pre-approval OFF: followups send automatically"}
          >
            <Shield className="h-3.5 w-3.5" />
            {requireApproval ? "Pre-approval ON" : "Pre-approval OFF"}
          </button>
          <Button onClick={() => setIsQueueModalOpen(true)} className="gap-2">
            <Layers className="h-4 w-4" />
            Queue follow-ups
          </Button>
        </div>
      </div>

      <div className="flex gap-4">
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
        <div className="w-48">
          <label
            className="block mb-1.5 font-medium uppercase tracking-[0.04em]"
            style={{ fontSize: "11px", color: "var(--text-tertiary)" }}
          >
            REPLY STATUS
          </label>
          <Select value={filterReplied} onChange={e => setFilterReplied(e.target.value)}>
            <option value="all">All</option>
            <option value="0">Unreplied</option>
            <option value="1">Replied</option>
          </Select>
        </div>
        <div className="w-48">
          <label
            className="block mb-1.5 font-medium uppercase tracking-[0.04em]"
            style={{ fontSize: "11px", color: "var(--text-tertiary)" }}
          >
            CAMPAIGN
          </label>
          <Select value={filterCampaign} onChange={e => setFilterCampaign(e.target.value)}>
            <option value="all">All campaigns</option>
            <option value="production">Production</option>
            <option value="test">Test</option>
          </Select>
        </div>
      </div>

      {followUpMsg && (
        <div
          className="rounded-lg p-3 text-[13px]"
          style={{
            background: followUpError ? "var(--danger-muted)" : "var(--success-muted)",
            border: `1px solid ${followUpError ? "var(--danger-border)" : "var(--success-border)"}`,
            color: followUpError ? "var(--danger)" : "var(--success)",
          }}
        >
          {followUpMsg}
        </div>
      )}

      {isError ? (
        <Card className="flex flex-col items-center justify-center h-64 text-center p-8">
          <AlertCircle className="h-6 w-6 mb-3" style={{ color: "var(--danger)" }} />
          <p className="font-medium text-[13px]" style={{ color: "var(--text-primary)" }}>Failed to load prospects</p>
          <p className="text-[13px]" style={{ color: "var(--text-secondary)" }}>Check API key or server.</p>
        </Card>
      ) : isLoading ? (
        <div className="space-y-4">
          {[1, 2].map(i => (
            <Card key={i} className="h-48 animate-pulse" style={{ background: "var(--bg-tertiary)", opacity: 0.4 }} />
          ))}
        </div>
      ) : filteredGroups.length === 0 ? (
        <Card className="flex flex-col items-center justify-center h-64 text-center p-8" style={{ borderStyle: "dashed" }}>
          <MailPlus className="h-6 w-6 mb-3" style={{ color: "var(--text-tertiary)" }} />
          <p className="font-medium text-[13px]" style={{ color: "var(--text-primary)" }}>No prospects found</p>
          <p className="text-[13px] max-w-sm mt-1" style={{ color: "var(--text-secondary)" }}>Adjust filters or sync Gmail to fetch new sent emails.</p>
        </Card>
      ) : (
        <div className="space-y-8">
          {filteredGroups.map((group: any, idx: number) => (
            <div key={group.label} style={{ animation: `fadeUp 0.3s ease both`, animationDelay: `${idx * 0.05}s` }}>
              <div className="flex items-center justify-between mb-3 px-1">
                <div className="flex items-center gap-3">
                  <h2 className="font-semibold" style={{ fontSize: "14px", letterSpacing: "-0.01em" }}>{group.label}</h2>
                  <Badge variant="outline">{group.total}</Badge>
                </div>
                <div className="flex gap-4 text-[12px]" style={{ color: "var(--text-secondary)" }}>
                  <span><span className="font-mono font-semibold" style={{ color: "var(--warning)" }}>{group.unreplied}</span> unreplied</span>
                  <span><span className="font-mono font-semibold" style={{ color: "var(--success)" }}>{group.replied}</span> replied</span>
                </div>
              </div>

              <Card className="overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Prospect</TableHead>
                      <TableHead>Company</TableHead>
                      <TableHead>Sent</TableHead>
                      <TableHead>Status</TableHead>
                      {Array.from({ length: 10 }, (_, i) => {
                        const stage = i + 1;
                        const hasData = group.prospects.some((p: any) => p[`followup_${stage}_status`]);
                        if (!hasData && stage > 3) return null;
                        return <TableHead key={stage} className="text-center">F{stage}</TableHead>;
                      })}
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {group.prospects.map((p: any) => {
                      return (
                      <TableRow key={p.id} className="group">
                        <TableCell>
                          <p className="font-medium text-[13px]" style={{ color: "var(--text-primary)" }}>{p.prospect_name || 'Unknown'}</p>
                          <p className="text-[12px] truncate max-w-[200px]" style={{ color: "var(--text-secondary)" }}>
                            {p.email}
                            {p.is_test_campaign && !p.replied && (
                              <span style={{ color: "var(--text-tertiary)", marginLeft: "6px" }}>
                                (max {p.max_followups}x)
                              </span>
                            )}
                          </p>
                        </TableCell>
                        <TableCell>
                          <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>{p.company || '\u2014'}</span>
                        </TableCell>
                        <TableCell>
                          <span className="font-mono text-[12px] whitespace-nowrap" style={{ color: "var(--text-secondary)" }}>
                            {format(new Date(p.sent_at), 'MMM d, HH:mm')}
                          </span>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1.5">
                            {p.replied ? (
                              <Badge variant="success">REPLIED</Badge>
                            ) : p.followup_paused ? (
                              <Badge variant="secondary" style={{ background: "var(--warning-muted)", color: "var(--warning)", border: "1px solid var(--warning-border)" }}>PAUSED</Badge>
                            ) : (
                              <Badge variant="outline">WAITING</Badge>
                            )}
                            {p.is_test_campaign ? (
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
                            )}
                          </div>
                        </TableCell>
                        {Array.from({ length: 10 }, (_, i) => {
                          const stage = i + 1;
                          const hasGroupData = group.prospects.some((pr: any) => pr[`followup_${stage}_status`]);
                          if (!hasGroupData && stage > 3) return null;
                          return <TableCell key={stage} className="text-center">{renderStatusBadge(p[`followup_${stage}_status`], p[`followup_${stage}_scheduled`], p[`followup_${stage}_error`])}</TableCell>;
                        })}
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            {!p.replied && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleTogglePause(p.id, !!p.followup_paused)}
                                disabled={togglingPauseId === p.id}
                                className="gap-1"
                                style={{ color: p.followup_paused ? "var(--success)" : "var(--warning)" }}
                                title={p.followup_paused ? "Resume follow-ups" : "Pause follow-ups"}
                              >
                                {togglingPauseId === p.id ? (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                ) : p.followup_paused ? (
                                  <Play className="h-3 w-3" />
                                ) : (
                                  <Pause className="h-3 w-3" />
                                )}
                                {p.followup_paused ? "Resume" : "Pause"}
                              </Button>
                            )}
                            {!p.replied && !p.followup_paused && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleFollowUpNow(p.id)}
                                disabled={followingUpId === p.id}
                                className="opacity-0 group-hover:opacity-100 transition-opacity gap-1"
                                style={{ color: "var(--accent)" }}
                              >
                                {followingUpId === p.id ? (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                ) : (
                                  <Zap className="h-3 w-3" />
                                )}
                                Send now
                              </Button>
                            )}
                            {!p.replied && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleToggleCampaign(p.id, !!p.is_test_campaign)}
                                disabled={togglingCampaignId === p.id}
                                className="opacity-0 group-hover:opacity-100 transition-opacity gap-1"
                                style={{ color: p.is_test_campaign ? "var(--success)" : "#a78bfa" }}
                                title={p.is_test_campaign ? "Move to production" : "Move to test"}
                              >
                                {togglingCampaignId === p.id ? (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                ) : (
                                  <ArrowRightLeft className="h-3 w-3" />
                                )}
                                {p.is_test_campaign ? "→ Prod" : "→ Test"}
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </Card>
            </div>
          ))}
        </div>
      )}

      <Modal
        isOpen={isQueueModalOpen}
        onClose={() => setIsQueueModalOpen(false)}
        title="Queue batch follow-ups"
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

          {queueBatchMutation.isSuccess && (
            <div className="p-3 rounded-lg text-[13px]" style={{ background: "var(--success-muted)", color: "var(--success)", border: "1px solid var(--success-border)" }}>
              Queued {queueBatchMutation.data?.queued} follow-ups.
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
