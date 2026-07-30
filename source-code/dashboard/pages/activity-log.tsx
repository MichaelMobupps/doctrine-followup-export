import React, { useState, useEffect, useCallback } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useApiKey } from "@/hooks/use-api-key";
import { Card, Badge, Button } from "@/components/ui";
import {
  Activity, RefreshCw, Users, Send, Clock, Pause,
  ChevronDown, ChevronUp, Mail, Zap, AlertCircle,
  CheckCircle2, Loader2, Target, BarChart3,
} from "lucide-react";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface CampaignInfo {
  label: string;
  total: number;
  unreplied: number;
  paused: number;
  queued: number;
  sent: number;
  actionable: number;
}

interface UserActivity {
  id: number;
  email: string;
  name: string;
  max_followups: number;
  doctrine_label: string;
  campaigns: CampaignInfo[];
}

interface CampaignStatus {
  active: boolean;
  queued_count: number;
  sent_count: number;
  unreplied_prospects: number;
  users: UserActivity[];
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function StatPill({ icon: Icon, label, value, color }: {
  icon: React.ElementType;
  label: string;
  value: number;
  color: string;
}) {
  return (
    <div
      className="flex items-center gap-2 rounded-md px-3 py-2"
      style={{ background: `var(--${color}-muted)`, border: `1px solid var(--${color}-border)` }}
    >
      <Icon className="h-3.5 w-3.5" style={{ color: `var(--${color})` }} strokeWidth={1.5} />
      <span className="text-[11px] font-medium" style={{ color: `var(--${color})` }}>{value}</span>
      <span className="text-[10px]" style={{ color: "var(--text-tertiary)" }}>{label}</span>
    </div>
  );
}

function CampaignRow({ campaign }: { campaign: CampaignInfo }) {
  const replied = campaign.total - campaign.unreplied;
  const replyRate = campaign.total > 0 ? ((replied / campaign.total) * 100).toFixed(1) : "0.0";
  const hasActivity = campaign.total > 0;

  if (!hasActivity) return null;

  return (
    <div
      className="rounded-lg p-4"
      style={{
        background: "var(--bg-primary)",
        border: "1px solid var(--border-default)",
      }}
    >
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-[12px] font-mono" style={{ color: "var(--text-secondary)" }}>
            {campaign.label}
          </span>
        </div>
        <span className="text-[11px] font-mono" style={{ color: "var(--text-tertiary)" }}>
          {replyRate}% reply rate
        </span>
      </div>

      <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
        <MiniStat label="Total" value={campaign.total} />
        <MiniStat label="Unreplied" value={campaign.unreplied} warn={campaign.unreplied > 0} />
        <MiniStat label="Replied" value={replied} success={replied > 0} />
        <MiniStat label="Queued" value={campaign.queued} accent={campaign.queued > 0} />
        <MiniStat label="Sent F/U" value={campaign.sent} />
        <MiniStat label="Actionable" value={campaign.actionable} accent={campaign.actionable > 0} />
      </div>

      {/* Progress bar */}
      {campaign.total > 0 && (
        <div className="mt-3">
          <div className="flex h-1.5 w-full rounded-full overflow-hidden" style={{ background: "var(--bg-tertiary)" }}>
            {replied > 0 && (
              <div
                style={{
                  width: `${(replied / campaign.total) * 100}%`,
                  background: "var(--success)",
                  transition: "width 0.4s ease",
                }}
              />
            )}
            {campaign.sent > 0 && (
              <div
                style={{
                  width: `${(campaign.sent / campaign.total) * 100}%`,
                  background: "var(--accent)",
                  transition: "width 0.4s ease",
                }}
              />
            )}
            {campaign.paused > 0 && (
              <div
                style={{
                  width: `${(campaign.paused / campaign.total) * 100}%`,
                  background: "var(--warning)",
                  transition: "width 0.4s ease",
                }}
              />
            )}
          </div>
          <div className="flex items-center gap-3 mt-1.5">
            <span className="flex items-center gap-1 text-[10px]" style={{ color: "var(--success)" }}>
              <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: "var(--success)" }} />
              replied
            </span>
            <span className="flex items-center gap-1 text-[10px]" style={{ color: "var(--accent)" }}>
              <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: "var(--accent)" }} />
              follow-ups sent
            </span>
            {campaign.paused > 0 && (
              <span className="flex items-center gap-1 text-[10px]" style={{ color: "var(--warning)" }}>
                <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: "var(--warning)" }} />
                paused
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function MiniStat({ label, value, warn, success, accent }: {
  label: string;
  value: number;
  warn?: boolean;
  success?: boolean;
  accent?: boolean;
}) {
  let valueColor = "var(--text-primary)";
  if (warn) valueColor = "var(--warning)";
  if (success) valueColor = "var(--success)";
  if (accent) valueColor = "var(--accent)";

  return (
    <div className="text-center">
      <p className="text-[15px] font-semibold font-mono tabular-nums" style={{ color: valueColor }}>
        {value}
      </p>
      <p className="text-[10px] uppercase tracking-[0.05em]" style={{ color: "var(--text-tertiary)" }}>
        {label}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  User Card                                                          */
/* ------------------------------------------------------------------ */

function UserCard({ user, index }: { user: UserActivity; index: number }) {
  const [expanded, setExpanded] = useState(true);

  const totals = user.campaigns.reduce(
    (acc, c) => ({
      total: acc.total + c.total,
      queued: acc.queued + c.queued,
      sent: acc.sent + c.sent,
      unreplied: acc.unreplied + c.unreplied,
      paused: acc.paused + c.paused,
      actionable: acc.actionable + c.actionable,
    }),
    { total: 0, queued: 0, sent: 0, unreplied: 0, paused: 0, actionable: 0 }
  );

  const activeCampaigns = user.campaigns.filter(c => c.total > 0);
  const hasActiveWork = totals.queued > 0 || totals.actionable > 0;

  return (
    <Card initial={false}>
        <div
          className="p-5 cursor-pointer select-none"
          onClick={() => setExpanded(!expanded)}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              {/* Avatar */}
              <div
                className="h-9 w-9 rounded-full flex items-center justify-center text-[13px] font-semibold uppercase"
                style={{
                  background: hasActiveWork ? "var(--accent-muted)" : "var(--bg-tertiary)",
                  color: hasActiveWork ? "var(--accent)" : "var(--text-tertiary)",
                  border: `1px solid ${hasActiveWork ? "var(--accent-border)" : "var(--border-default)"}`,
                }}
              >
                {user.name.slice(0, 2)}
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <p className="text-[13px] font-semibold" style={{ color: "var(--text-primary)" }}>
                    {user.name}
                  </p>
                  {hasActiveWork && (
                    <span className="flex items-center gap-1">
                      <span
                        className="inline-block h-1.5 w-1.5 rounded-full"
                        style={{
                          background: "var(--success)",
                          boxShadow: "0 0 6px var(--success)",
                          animation: "pulse-dot 2s ease-in-out infinite",
                        }}
                      />
                      <span className="text-[10px] font-medium" style={{ color: "var(--success)" }}>ACTIVE</span>
                    </span>
                  )}
                </div>
                <p className="text-[12px] font-mono" style={{ color: "var(--text-tertiary)" }}>
                  {user.email}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <div className="hidden sm:flex items-center gap-2">
                <StatPill icon={Target} label="prospects" value={totals.total} color="accent" />
                <StatPill icon={Send} label="f/u sent" value={totals.sent} color="success" />
                {totals.queued > 0 && (
                  <StatPill icon={Clock} label="queued" value={totals.queued} color="warning" />
                )}
              </div>
              {expanded ? (
                <ChevronUp className="h-4 w-4" style={{ color: "var(--text-tertiary)" }} />
              ) : (
                <ChevronDown className="h-4 w-4" style={{ color: "var(--text-tertiary)" }} />
              )}
            </div>
          </div>
        </div>

        <AnimatePresence>
          {expanded && activeCampaigns.length > 0 && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              style={{ overflow: "hidden" }}
            >
              <div className="px-5 pb-5 space-y-3" style={{ borderTop: "1px solid var(--border-default)", paddingTop: "16px" }}>
                <div className="flex items-center justify-between mb-1">
                  <p className="text-[11px] font-medium uppercase tracking-[0.04em]" style={{ color: "var(--text-tertiary)" }}>
                    Campaigns ({activeCampaigns.length})
                  </p>
                  <p className="text-[11px]" style={{ color: "var(--text-tertiary)" }}>
                    Max {user.max_followups} follow-ups · Label: <span className="font-mono">{user.doctrine_label}</span>
                  </p>
                </div>
                {activeCampaigns.map((c, i) => (
                  <CampaignRow key={`${c.label}-${i}`} campaign={c} />
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/*  Main Page                                                          */
/* ------------------------------------------------------------------ */

export default function ActivityLog() {
  const { apiKey } = useApiKey();
  const [data, setData] = useState<CampaignStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const fetchData = useCallback(async (silent = false) => {
    if (!apiKey) return;
    if (!silent) setLoading(true);
    else setRefreshing(true);
    setError(null);
    try {
      const base = import.meta.env.BASE_URL || "/";
      const res = await fetch(`${base}api/campaign/status`, {
        headers: { "x-api-key": apiKey },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
      setLastRefresh(new Date());
    } catch (err: any) {
      setError(err.message || "Failed to load activity data");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [apiKey]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(() => fetchData(true), 30000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const activeUsers = data?.users?.filter(u => {
    return u.campaigns.some(c => c.total > 0);
  }) || [];
  const idleUsers = data?.users?.filter(u => {
    return !u.campaigns.some(c => c.total > 0);
  }) || [];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 style={{ fontSize: "20px", fontWeight: 600, letterSpacing: "-0.02em" }}>
            Activity Log
          </h1>
          {data && (
            <Badge variant={data.active ? "success" : "secondary"}>
              {data.active ? "SYSTEM ACTIVE" : "IDLE"}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-3">
          {lastRefresh && (
            <span className="text-[11px]" style={{ color: "var(--text-tertiary)" }}>
              Updated {lastRefresh.toLocaleTimeString()}
            </span>
          )}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => fetchData(true)}
            disabled={refreshing}
            className="gap-2"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Global summary cards */}
      {data && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <SummaryCard
            icon={Users}
            label="Connected Users"
            value={data.users.length}
            color="accent"
          />
          <SummaryCard
            icon={BarChart3}
            label="Total Unreplied"
            value={data.unreplied_prospects}
            color="warning"
          />
          <SummaryCard
            icon={Clock}
            label="Queued Follow-ups"
            value={data.queued_count}
            color="info"
          />
          <SummaryCard
            icon={CheckCircle2}
            label="Follow-ups Sent"
            value={data.sent_count}
            color="success"
          />
        </div>
      )}

      {/* Loading state */}
      {loading && (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-5 w-5 animate-spin" style={{ color: "var(--text-tertiary)" }} />
          <span className="ml-3 text-[13px]" style={{ color: "var(--text-tertiary)" }}>Loading activity...</span>
        </div>
      )}

      {/* Error state */}
      {error && (
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          className="rounded-lg p-4 flex items-center gap-3 text-[13px]"
          style={{ background: "var(--danger-muted)", border: "1px solid var(--danger-border)", color: "var(--danger)" }}
        >
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          {error}
        </motion.div>
      )}

      {/* Active Users */}
      {!loading && activeUsers.length > 0 && (
        <div className="space-y-3">
          <p className="text-[11px] font-medium uppercase tracking-[0.04em]" style={{ color: "var(--text-tertiary)" }}>
            Active Users ({activeUsers.length})
          </p>
          {activeUsers.map((user, i) => (
            <UserCard key={user.id} user={user} index={i} />
          ))}
        </div>
      )}

      {/* Idle Users */}
      {!loading && idleUsers.length > 0 && (
        <div className="space-y-3">
          <p className="text-[11px] font-medium uppercase tracking-[0.04em]" style={{ color: "var(--text-tertiary)" }}>
            Connected · No campaigns ({idleUsers.length})
          </p>
          {idleUsers.map((user, i) => (
            <Card key={user.id} initial={false} className="p-4">
                <div className="flex items-center gap-3">
                  <div
                    className="h-8 w-8 rounded-full flex items-center justify-center text-[12px] font-semibold uppercase"
                    style={{ background: "var(--bg-tertiary)", color: "var(--text-tertiary)", border: "1px solid var(--border-default)" }}
                  >
                    {user.name.slice(0, 2)}
                  </div>
                  <div>
                    <p className="text-[13px] font-medium" style={{ color: "var(--text-secondary)" }}>
                      {user.name}
                    </p>
                    <p className="text-[11px] font-mono" style={{ color: "var(--text-tertiary)" }}>
                      {user.email}
                    </p>
                  </div>
                  <Badge variant="secondary" className="ml-auto">IDLE</Badge>
                </div>
            </Card>
          ))}
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && data && data.users.length === 0 && (
        <Card className="p-16 text-center" style={{ borderStyle: "dashed" }}>
          <Users className="h-8 w-8 mx-auto mb-3" style={{ color: "var(--text-tertiary)" }} />
          <p className="text-[14px] font-medium" style={{ color: "var(--text-secondary)" }}>
            No connected users
          </p>
          <p className="text-[12px] mt-1" style={{ color: "var(--text-tertiary)" }}>
            Gmail accounts will appear here once connected via Settings.
          </p>
        </Card>
      )}

      <style>{`
        @keyframes pulse-dot {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Summary Card                                                       */
/* ------------------------------------------------------------------ */

function SummaryCard({ icon: Icon, label, value, color }: {
  icon: React.ElementType;
  label: string;
  value: number;
  color: string;
}) {
  return (
    <Card className="p-4">
      <div className="flex items-center gap-3">
        <div
          className="h-9 w-9 rounded-lg flex items-center justify-center"
          style={{ background: `var(--${color}-muted)`, border: `1px solid var(--${color}-border)` }}
        >
          <Icon className="h-4 w-4" style={{ color: `var(--${color})` }} strokeWidth={1.5} />
        </div>
        <div>
          <p className="text-[18px] font-semibold font-mono tabular-nums leading-tight" style={{ color: "var(--text-primary)" }}>
            {value}
          </p>
          <p className="text-[10px] uppercase tracking-[0.04em]" style={{ color: "var(--text-tertiary)" }}>
            {label}
          </p>
        </div>
      </div>
    </Card>
  );
}
