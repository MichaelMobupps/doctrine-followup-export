// B7t + B7u + B7v: admin activity dashboard.
//
// B7v additions:
//   - Auto-refresh toggle (default ON, 30s interval)
//   - Silent background polling (no spinner flicker)
//   - "Updated Ns ago" indicator next to Refresh
//   - Visibility-aware polling (pause when tab is hidden)
//   - "In flight" stat card pulses subtly when > 0
//
// No backend changes. Same /api/admin/activity endpoint.

import React, { useState, useEffect, useCallback, useMemo } from "react";
import { useApiKey } from "@/hooks/use-api-key";
import { Card, Button } from "@/components/ui";
import {
  RefreshCw, Users, Zap, DollarSign, Activity,
  ChevronDown, ChevronRight, Filter, Download, Pause, Play,
} from "lucide-react";

// ── Types (unchanged from B7u) ─────────────────────────────────────

interface UserSummary {
  id: number;
  email: string;
  name: string;
  paused_by_admin?: boolean;
}

interface AppRollup { events: number; input_tokens: number; output_tokens: number; cost_usd: number; }
interface StageRollup { events: number; cost_usd: number; }
interface ModelRollup { events: number; input_tokens: number; output_tokens: number; cost_usd: number; }

interface UserTotal {
  user_id: number | null;
  email: string | null;
  name: string | null;
  events: number;
  followups: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  web_searches: number;
  cost_usd: number;
  by_app: Record<string, AppRollup>;
  by_stage: Record<string, StageRollup>;
  by_model: Record<string, ModelRollup>;
}

interface UsageEvent {
  id: number;
  followup_id: number | null;
  prospect_id: number | null;
  user_id: number | null;
  user_email: string | null;
  user_name: string | null;
  prospect_name: string | null;
  prospect_company: string | null;
  app: string;
  stage: number;
  label: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  web_searches: number;
  cost_usd: number;
  generated_at: string;
}

interface ActivityResponse {
  window: { since: string; until: string };
  filter: { user_id: number | null; app: string | null };
  active_generations: number;
  totals: {
    events: number;
    followups: number;
    input_tokens: number;
    output_tokens: number;
    cache_creation_tokens: number;
    cache_read_tokens: number;
    web_searches: number;
    cost_usd: number;
  };
  users: UserSummary[];
  user_totals: UserTotal[];
  events: UsageEvent[];
}

// ── Helpers ────────────────────────────────────────────────────────

function formatTokens(n: number): string {
  if (!n || n < 1000) return String(n || 0);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function formatCost(usd: number): string {
  if (!usd || usd === 0) return "—";
  if (usd < 0.01) return "<$0.01";
  if (usd < 1) return `$${usd.toFixed(3)}`;
  if (usd < 100) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(0)}`;
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  const date = d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return `${date} ${time}`;
}

function formatRelative(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  const ms = Date.now() - d.getTime();
  const s = Math.round(ms / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const dys = Math.round(h / 24);
  return `${dys}d ago`;
}

function prospectLabel(e: UsageEvent): string {
  const name = (e.prospect_name || "").trim();
  const company = (e.prospect_company || "").trim();
  if (name && company) return `${name} · ${company}`;
  if (name) return name;
  if (company) return company;
  if (e.prospect_id) return `Prospect #${e.prospect_id}`;
  return "—";
}

function userLabel(name: string | null, email: string | null): string {
  if (name && name.trim()) return name;
  if (email) return email.split("@")[0];
  return "—";
}

function modelShort(model: string): string {
  if (model.startsWith("claude-opus-")) return "Opus";
  if (model.startsWith("claude-sonnet-")) return "Sonnet";
  if (model.startsWith("claude-haiku-")) return "Haiku";
  return model;
}

type WindowPreset = "24h" | "7d" | "30d";
function windowFor(preset: WindowPreset): { since: string; until: string } {
  const now = new Date();
  const since = new Date(now.getTime());
  if (preset === "24h") since.setHours(since.getHours() - 24);
  else if (preset === "7d") since.setDate(since.getDate() - 7);
  else if (preset === "30d") since.setDate(since.getDate() - 30);
  return { since: since.toISOString(), until: now.toISOString() };
}

// B7v: poll interval for auto-refresh. 30s is the cron-tick rhythm
// for fast-tick; a higher rate would be wasted.
const AUTO_REFRESH_INTERVAL_MS = 30 * 1000;
// "Ns ago" indicator refresh — 5s gives a sub-minute precision feel
// without burning CPU.
const RELATIVE_TIME_TICK_MS = 5 * 1000;

// ── Page ───────────────────────────────────────────────────────────

// `lockedApp` scopes the whole page to a single product (e.g. the
// Anti-Ghosting nav renders this with lockedApp="anti_ghosting"). When
// set, the App filter is hidden and locked to that value. Rendered with
// no props (component={AdminActivity}) it stays the cross-product view.
export default function AdminActivity({ lockedApp }: { lockedApp?: string } = {}) {
  const { apiKey } = useApiKey();
  const [data, setData] = useState<ActivityResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [windowPreset, setWindowPreset] = useState<WindowPreset>("7d");
  const [userFilter, setUserFilter] = useState<string>("all");
  const [appFilter, setAppFilter] = useState<string>(lockedApp ?? "all");
  const [expandedUser, setExpandedUser] = useState<number | null>(null);
  const [pendingPause, setPendingPause] = useState<Set<number>>(new Set());
  const [downloading, setDownloading] = useState(false);
  // B7v state.
  const [autoRefresh, setAutoRefresh] = useState<boolean>(true);
  const [lastFetchedAt, setLastFetchedAt] = useState<Date | null>(null);
  // tick state advances every RELATIVE_TIME_TICK_MS so the "Updated Ns
  // ago" string and event-row times re-render without re-fetching.
  const [, setTick] = useState(0);

  const fetchActivity = useCallback(async (opts?: { silent?: boolean }) => {
    if (!apiKey) return;
    if (!opts?.silent) setLoading(true);
    setError(null);
    try {
      const base = import.meta.env.BASE_URL || "/";
      const { since, until } = windowFor(windowPreset);
      const params = new URLSearchParams({ since, until });
      if (userFilter !== "all") params.set("user_id", userFilter);
      if (appFilter !== "all") params.set("app", appFilter);
      const res = await fetch(`${base}api/admin/activity?${params.toString()}`, {
        headers: { "x-api-key": apiKey },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as ActivityResponse;
      setData(json);
      setLastFetchedAt(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load activity");
    } finally {
      if (!opts?.silent) setLoading(false);
    }
  }, [apiKey, windowPreset, userFilter, appFilter]);

  // Initial fetch + refetch when filters change.
  useEffect(() => { fetchActivity(); }, [fetchActivity]);

  // B7v: auto-refresh loop. Silent (no spinner). Skips when the tab is
  // hidden so we don't burn cycles on a backgrounded tab.
  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      fetchActivity({ silent: true });
    }, AUTO_REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [autoRefresh, fetchActivity]);

  // B7v: "Ns ago" tick. Independent of auto-refresh — keeps the
  // staleness indicator honest even when auto-refresh is off.
  useEffect(() => {
    const interval = setInterval(() => setTick((t) => (t + 1) % 1_000_000), RELATIVE_TIME_TICK_MS);
    return () => clearInterval(interval);
  }, []);

  // B7v: refetch on visibility change (regardless of auto-refresh state).
  // If a user comes back to the tab after a few minutes, they should
  // see fresh data on the first frame, not stale data until the next tick.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisChange = () => {
      if (document.visibilityState === "visible") {
        fetchActivity({ silent: true });
      }
    };
    document.addEventListener("visibilitychange", onVisChange);
    return () => document.removeEventListener("visibilitychange", onVisChange);
  }, [fetchActivity]);

  const pausedByUserId = useMemo(() => {
    const m = new Map<number, boolean>();
    for (const u of data?.users ?? []) m.set(u.id, !!u.paused_by_admin);
    return m;
  }, [data]);

  const allUsers = useMemo(() => data?.users ?? [], [data]);

  const handleDownloadExcel = useCallback(async () => {
    if (!apiKey) return;
    setDownloading(true);
    try {
      const base = import.meta.env.BASE_URL || "/";
      const { since, until } = windowFor(windowPreset);
      const params = new URLSearchParams({ since, until });
      if (userFilter !== "all") params.set("user_id", userFilter);
      if (appFilter !== "all") params.set("app", appFilter);
      const res = await fetch(`${base}api/admin/activity-report?${params.toString()}`, {
        headers: { "x-api-key": apiKey },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `activity-report-${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      window.alert(`Download failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setDownloading(false);
    }
  }, [apiKey, windowPreset, userFilter, appFilter]);

  const handleTogglePause = useCallback(async (userId: number, currentlyPaused: boolean) => {
    if (!apiKey) return;
    const action = currentlyPaused ? "resume" : "pause";
    const who = data?.users.find((u) => u.id === userId);
    const label = who?.name || who?.email || `User #${userId}`;
    if (!window.confirm(`${currentlyPaused ? "Resume" : "Pause"} ${label}?\n\n` +
      (currentlyPaused
        ? "Their queued follow-ups will be eligible for generation and sending again on the next cron tick."
        : "Their queued follow-ups will be skipped by the scheduler until resumed. Existing queued rows are NOT cancelled — they wait."))) return;
    setPendingPause((prev) => new Set(prev).add(userId));
    try {
      const base = import.meta.env.BASE_URL || "/";
      const res = await fetch(`${base}api/admin/users/${userId}/${action}`, {
        method: "POST",
        headers: { "x-api-key": apiKey },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const msg = body?.error || `HTTP ${res.status}`;
        window.alert(`${action} failed: ${msg}`);
      } else {
        await fetchActivity({ silent: true });
      }
    } catch (err) {
      window.alert(`${action} failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setPendingPause((prev) => {
        const next = new Set(prev);
        next.delete(userId);
        return next;
      });
    }
  }, [apiKey, data, fetchActivity]);

  return (
    <div className="p-6 max-w-[1400px] mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1
            className="text-[20px] font-semibold tracking-tight"
            style={{ color: "var(--text-primary)" }}
          >
            {lockedApp === "anti_ghosting" ? "Anti-Ghosting · Admin Activity" : "Admin Activity"}
          </h1>
          <p
            className="text-[12px] mt-1"
            style={{ color: "var(--text-tertiary)" }}
          >
            Per-LLM-call usage and cost ledger for follow-up generation.
            One row in followup_usage = one Anthropic API call.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* B7v: auto-refresh toggle + last-updated indicator */}
          {lastFetchedAt && (
            <span
              className="text-[11px] mr-1"
              style={{ color: "var(--text-tertiary)" }}
              title={lastFetchedAt.toLocaleString()}
            >
              Updated {formatRelative(lastFetchedAt.toISOString())}
            </span>
          )}
          <button
            type="button"
            onClick={() => setAutoRefresh((v) => !v)}
            className="text-[11px] px-2 py-1 rounded inline-flex items-center gap-1.5"
            style={{
              background: autoRefresh ? "var(--accent-muted, var(--bg-tertiary))" : "var(--bg-tertiary)",
              border: "1px solid var(--border-default)",
              color: autoRefresh ? "var(--accent)" : "var(--text-tertiary)",
            }}
            title={autoRefresh ? "Auto-refresh every 30s (click to turn off)" : "Auto-refresh is off (click to turn on)"}
          >
            <span
              className="inline-block w-1.5 h-1.5 rounded-full"
              style={{
                background: autoRefresh ? "var(--accent)" : "var(--text-tertiary)",
                animation: autoRefresh ? "pulse 2s ease-in-out infinite" : undefined,
              }}
            />
            Auto: {autoRefresh ? "ON" : "OFF"}
          </button>
          <Button onClick={handleDownloadExcel} disabled={downloading || !data} variant="outline" size="sm">
            <Download className={`h-3.5 w-3.5 mr-1.5 ${downloading ? "animate-pulse" : ""}`} />
            {downloading ? "Building…" : "Download Excel"}
          </Button>
          <Button onClick={() => fetchActivity()} disabled={loading} variant="outline" size="sm">
            <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Filters */}
      <div
        className="rounded-lg p-3 mb-5 flex items-center gap-3 flex-wrap"
        style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-default)" }}
      >
        <Filter className="h-3.5 w-3.5" style={{ color: "var(--text-tertiary)" }} />
        <FilterSelect
          label="Window"
          value={windowPreset}
          options={[
            { value: "24h", label: "Last 24h" },
            { value: "7d", label: "Last 7 days" },
            { value: "30d", label: "Last 30 days" },
          ]}
          onChange={(v) => setWindowPreset(v as WindowPreset)}
        />
        <FilterSelect
          label="User"
          value={userFilter}
          options={[
            { value: "all", label: "All users" },
            ...allUsers.map((u) => ({ value: String(u.id), label: u.name || u.email })),
          ]}
          onChange={setUserFilter}
        />
        {!lockedApp && (
          <FilterSelect
            label="App"
            value={appFilter}
            options={[
              { value: "all", label: "All" },
              { value: "doctrine", label: "Doctrine" },
              { value: "context", label: "Context" },
              { value: "anti_ghosting", label: "Anti-Ghosting" },
            ]}
            onChange={setAppFilter}
          />
        )}
        {data && (
          <span
            className="ml-auto text-[11px]"
            style={{ color: "var(--text-tertiary)" }}
          >
            {formatDateTime(data.window.since)} → {formatDateTime(data.window.until)}
          </span>
        )}
      </div>

      {error && (
        <div
          className="rounded-lg p-3 mb-5 text-[12px]"
          style={{ background: "var(--danger-muted)", border: "1px solid var(--danger-border)", color: "var(--danger)" }}
        >
          {error}
        </div>
      )}

      {/* Stat cards */}
      {data && (
        <div className="grid grid-cols-4 gap-3 mb-6">
          <StatCard
            icon={Zap}
            label="Events"
            value={data.totals.events.toLocaleString()}
            sublabel={`${data.totals.followups} follow-ups`}
          />
          <StatCard
            icon={DollarSign}
            label="Total cost"
            value={formatCost(data.totals.cost_usd)}
            sublabel={`${formatTokens(data.totals.input_tokens + data.totals.output_tokens)} tokens`}
          />
          <StatCard
            icon={Activity}
            label="In flight"
            value={String(data.active_generations)}
            sublabel="rows generating right now"
            // B7v: pulse the In-flight card when there's actual activity,
            // since this is the one stat that changes between refreshes.
            pulse={data.active_generations > 0}
          />
          <StatCard
            icon={Users}
            label="Active users"
            value={String(data.user_totals.length)}
            sublabel={`${allUsers.length} users total`}
          />
        </div>
      )}

      {/* Per-user totals */}
      {data && data.user_totals.length > 0 && (
        <Card className="mb-6 overflow-hidden">
          <div
            className="px-4 py-3 text-[11px] font-medium uppercase tracking-wider"
            style={{ color: "var(--text-tertiary)", borderBottom: "1px solid var(--border-default)" }}
          >
            Per-user totals (click a row to expand breakdowns)
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr style={{ color: "var(--text-tertiary)" }}>
                  <th className="text-left px-4 py-2 font-medium" style={{ borderBottom: "1px solid var(--border-default)" }}>User</th>
                  <th className="text-right px-3 py-2 font-medium" style={{ borderBottom: "1px solid var(--border-default)" }}>Events</th>
                  <th className="text-right px-3 py-2 font-medium" style={{ borderBottom: "1px solid var(--border-default)" }}>Follow-ups</th>
                  <th className="text-right px-3 py-2 font-medium" style={{ borderBottom: "1px solid var(--border-default)" }}>Input tok</th>
                  <th className="text-right px-3 py-2 font-medium" style={{ borderBottom: "1px solid var(--border-default)" }}>Output tok</th>
                  <th className="text-right px-3 py-2 font-medium" style={{ borderBottom: "1px solid var(--border-default)" }}>Cache R</th>
                  <th className="text-right px-3 py-2 font-medium" style={{ borderBottom: "1px solid var(--border-default)" }}>Cost</th>
                  <th className="text-right px-3 py-2 font-medium" style={{ borderBottom: "1px solid var(--border-default)" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.user_totals.map((u) => {
                  const key = u.user_id ?? -1;
                  const isExpanded = expandedUser === key;
                  const isPaused = u.user_id != null && (pausedByUserId.get(u.user_id) ?? false);
                  const isPending = u.user_id != null && pendingPause.has(u.user_id);
                  return (
                    <React.Fragment key={key}>
                      <tr
                        onClick={() => setExpandedUser(isExpanded ? null : key)}
                        className="cursor-pointer"
                        style={{
                          background: isExpanded ? "var(--bg-tertiary)" : "transparent",
                          borderBottom: "1px solid var(--border-subtle)",
                        }}
                      >
                        <td className="px-4 py-2.5" style={{ color: "var(--text-primary)" }}>
                          <div className="flex items-center gap-2">
                            {isExpanded
                              ? <ChevronDown className="h-3 w-3" style={{ color: "var(--text-tertiary)" }} />
                              : <ChevronRight className="h-3 w-3" style={{ color: "var(--text-tertiary)" }} />}
                            <span>{userLabel(u.name, u.email)}</span>
                            {isPaused && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded font-medium" style={{ background: "var(--warning-muted, var(--bg-tertiary))", color: "var(--warning, var(--text-tertiary))" }}>
                                paused
                              </span>
                            )}
                            {!u.user_id && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: "var(--bg-tertiary)", color: "var(--text-tertiary)" }}>
                                no user
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono" style={{ color: "var(--text-primary)" }}>{u.events}</td>
                        <td className="px-3 py-2.5 text-right font-mono" style={{ color: "var(--text-primary)" }}>{u.followups}</td>
                        <td className="px-3 py-2.5 text-right font-mono" style={{ color: "var(--text-secondary)" }}>{formatTokens(u.input_tokens)}</td>
                        <td className="px-3 py-2.5 text-right font-mono" style={{ color: "var(--text-secondary)" }}>{formatTokens(u.output_tokens)}</td>
                        <td className="px-3 py-2.5 text-right font-mono" style={{ color: "var(--text-tertiary)" }}>{formatTokens(u.cache_read_tokens)}</td>
                        <td className="px-3 py-2.5 text-right font-mono font-semibold" style={{ color: "var(--accent)" }}>{formatCost(u.cost_usd)}</td>
                        <td className="px-3 py-2.5 text-right">
                          {u.user_id != null && (
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); handleTogglePause(u.user_id!, isPaused); }}
                              disabled={isPending}
                              className="text-[11px] px-2 py-1 rounded inline-flex items-center gap-1"
                              style={{
                                background: "var(--bg-tertiary)",
                                border: "1px solid var(--border-default)",
                                color: isPaused ? "var(--accent)" : "var(--text-secondary)",
                                opacity: isPending ? 0.5 : 1,
                                cursor: isPending ? "wait" : "pointer",
                              }}
                            >
                              {isPaused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
                              {isPending ? "…" : (isPaused ? "Resume" : "Pause")}
                            </button>
                          )}
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr style={{ background: "var(--bg-secondary)" }}>
                          <td colSpan={8} className="px-4 py-3">
                            <UserBreakdown user={u} />
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Recent events table */}
      {data && (
        <Card className="overflow-hidden">
          <div
            className="px-4 py-3 text-[11px] font-medium uppercase tracking-wider flex items-center justify-between"
            style={{ color: "var(--text-tertiary)", borderBottom: "1px solid var(--border-default)" }}
          >
            <span>Recent events</span>
            <span className="text-[10px] normal-case tracking-normal">
              {data.events.length} shown {data.events.length === 200 ? "(capped at 200 — use Download Excel for up to 5000)" : ""}
            </span>
          </div>
          {data.events.length === 0 ? (
            <div className="p-8 text-center text-[12px]" style={{ color: "var(--text-tertiary)" }}>
              No events in this window. Follow-up generations write rows here as they happen.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead>
                  <tr style={{ color: "var(--text-tertiary)" }}>
                    <th className="text-left px-4 py-2 font-medium" style={{ borderBottom: "1px solid var(--border-default)" }}>Time</th>
                    <th className="text-left px-3 py-2 font-medium" style={{ borderBottom: "1px solid var(--border-default)" }}>User</th>
                    <th className="text-left px-3 py-2 font-medium" style={{ borderBottom: "1px solid var(--border-default)" }}>Prospect</th>
                    <th className="text-left px-3 py-2 font-medium" style={{ borderBottom: "1px solid var(--border-default)" }}>App</th>
                    <th className="text-right px-3 py-2 font-medium" style={{ borderBottom: "1px solid var(--border-default)" }}>Stage</th>
                    <th className="text-left px-3 py-2 font-medium" style={{ borderBottom: "1px solid var(--border-default)" }}>Step</th>
                    <th className="text-left px-3 py-2 font-medium" style={{ borderBottom: "1px solid var(--border-default)" }}>Model</th>
                    <th className="text-right px-3 py-2 font-medium" style={{ borderBottom: "1px solid var(--border-default)" }}>In</th>
                    <th className="text-right px-3 py-2 font-medium" style={{ borderBottom: "1px solid var(--border-default)" }}>Out</th>
                    <th className="text-right px-3 py-2 font-medium" style={{ borderBottom: "1px solid var(--border-default)" }}>Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {data.events.map((e) => (
                    <tr key={e.id} style={{ borderBottom: "1px solid var(--border-subtle)" }}>
                      <td className="px-4 py-2 font-mono text-[11px]" style={{ color: "var(--text-tertiary)" }} title={formatDateTime(e.generated_at)}>
                        {formatRelative(e.generated_at)}
                      </td>
                      <td className="px-3 py-2" style={{ color: "var(--text-secondary)" }}>
                        {userLabel(e.user_name, e.user_email)}
                      </td>
                      <td className="px-3 py-2" style={{ color: "var(--text-secondary)" }}>
                        <span title={`prospect_id=${e.prospect_id}`}>{prospectLabel(e)}</span>
                      </td>
                      <td className="px-3 py-2 font-mono text-[11px]" style={{ color: "var(--text-tertiary)" }}>{e.app}</td>
                      <td className="px-3 py-2 text-right font-mono" style={{ color: "var(--text-secondary)" }}>{e.stage}</td>
                      <td className="px-3 py-2 font-mono text-[11px]" style={{ color: "var(--text-tertiary)" }}>{e.label}</td>
                      <td className="px-3 py-2 font-mono text-[11px]" style={{ color: "var(--text-tertiary)" }} title={e.model}>
                        {modelShort(e.model)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono" style={{ color: "var(--text-secondary)" }}>{formatTokens(e.input_tokens)}</td>
                      <td className="px-3 py-2 text-right font-mono" style={{ color: "var(--text-secondary)" }}>{formatTokens(e.output_tokens)}</td>
                      <td className="px-3 py-2 text-right font-mono font-semibold" style={{ color: "var(--accent)" }}>{formatCost(e.cost_usd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {loading && !data && (
        <div className="text-[12px] py-8 text-center" style={{ color: "var(--text-tertiary)" }}>
          Loading activity...
        </div>
      )}

      {/* B7v: inline pulse keyframes. Defined locally so we don't need
          to touch the global stylesheet. Safe to inline — same name as
          Tailwind's "pulse" but the animation definition matches. */}
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>
    </div>
  );
}

// ── Subcomponents ──────────────────────────────────────────────────

function StatCard({ icon: Icon, label, value, sublabel, pulse }: {
  icon: React.ElementType;
  label: string;
  value: string;
  sublabel?: string;
  pulse?: boolean;
}) {
  return (
    <Card>
      <div className="p-4">
        <div className="flex items-center gap-2 mb-2">
          <Icon
            className="h-3.5 w-3.5"
            style={{
              color: "var(--text-tertiary)",
              animation: pulse ? "pulse 1.5s ease-in-out infinite" : undefined,
            }}
            strokeWidth={1.5}
          />
          <span className="text-[10px] uppercase tracking-wider font-medium" style={{ color: "var(--text-tertiary)" }}>{label}</span>
        </div>
        <div
          className="text-[22px] font-semibold"
          style={{
            color: pulse ? "var(--accent)" : "var(--text-primary)",
          }}
        >
          {value}
        </div>
        {sublabel && <div className="text-[11px] mt-0.5" style={{ color: "var(--text-tertiary)" }}>{sublabel}</div>}
      </div>
    </Card>
  );
}

function FilterSelect({ label, value, options, onChange }: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] uppercase tracking-wider" style={{ color: "var(--text-tertiary)" }}>{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="px-2.5 py-1.5 rounded text-[12px] focus:outline-none"
        style={{
          background: "var(--bg-primary)",
          border: "1px solid var(--border-default)",
          color: "var(--text-primary)",
        }}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
    </div>
  );
}

function UserBreakdown({ user }: { user: UserTotal }) {
  const apps = Object.entries(user.by_app).sort((a, b) => b[1].cost_usd - a[1].cost_usd);
  const stages = Object.entries(user.by_stage).sort((a, b) => Number(a[0]) - Number(b[0]));
  const models = Object.entries(user.by_model).sort((a, b) => b[1].cost_usd - a[1].cost_usd);

  return (
    <div className="grid grid-cols-3 gap-4">
      <BreakdownTable
        title="By app"
        rows={apps.map(([k, v]) => ({ key: k, label: k, events: v.events, cost: v.cost_usd }))}
      />
      <BreakdownTable
        title="By stage"
        rows={stages.map(([k, v]) => ({ key: k, label: `Stage ${k}`, events: v.events, cost: v.cost_usd }))}
      />
      <BreakdownTable
        title="By model"
        rows={models.map(([k, v]) => ({ key: k, label: modelShort(k), events: v.events, cost: v.cost_usd }))}
      />
    </div>
  );
}

function BreakdownTable({ title, rows }: {
  title: string;
  rows: { key: string; label: string; events: number; cost: number }[];
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider mb-1.5 font-medium" style={{ color: "var(--text-tertiary)" }}>{title}</div>
      <table className="w-full text-[11px]">
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td className="py-1 pr-2" style={{ color: "var(--text-secondary)" }}>{r.label}</td>
              <td className="py-1 px-2 text-right font-mono" style={{ color: "var(--text-tertiary)" }}>{r.events}</td>
              <td className="py-1 pl-2 text-right font-mono" style={{ color: "var(--accent)" }}>{formatCost(r.cost)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
