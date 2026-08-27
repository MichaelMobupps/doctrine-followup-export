// B7t + B7u + B7v: admin activity dashboard.
//
// B7v additions:
//   - Auto-refresh toggle (default ON, 30s interval)
//   - Silent background polling (no spinner flicker)
//   - "Updated Ns ago" indicator next to Refresh
//   - Visibility-aware polling (pause when tab is hidden)
//   - "In flight" stat card pulses subtly when > 0
//
// Admin Kill: per-row destructive "Kill" action that hard-stops one user's
// entire follow-up pipeline across all three subproducts. Behind a typed-name
// confirmation dialog that echoes the consequence (POST
// /api/admin/users/:id/kill). No other backend changes.

import React, { useState, useEffect, useCallback, useMemo } from "react";
import { useApiKey } from "@/hooks/use-api-key";
import { useAdmin } from "@/hooks/use-admin";
import { Card, Button } from "@/components/ui";
import {
  RefreshCw, Users, Zap, DollarSign, Activity,
  ChevronDown, ChevronRight, Filter, Download, Pause, Play,
  ShieldOff, Plus, Trash2, XOctagon,
} from "lucide-react";
import { BASE_PATH } from "@/lib/app-urls";

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

// Admin Kill: the endpoint's response shape (POST /api/admin/users/:id/kill).
interface KillSubCounts { followups_cancelled: number; campaigns_paused: number; }
interface KillResponse {
  killed: boolean;
  user: { id: number; email: string; name: string };
  followups_cancelled: number;
  campaigns_paused: number;
  by_app: Record<string, KillSubCounts>;
}

// The subproducts shown in the kill result, in a stable order with friendly
// labels. The endpoint always returns all three keys.
const KILL_APP_LABELS: Array<{ key: string; label: string }> = [
  { key: "doctrine", label: "Doctrine" },
  { key: "context", label: "Context" },
  { key: "anti_ghosting", label: "Anti-Ghosting" },
];

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

// Shorten a model id for the table. Keeps the tier, drops the vendor prefix and
// the version noise, so a column of mixed-vendor rows stays scannable.
//
// The Anthropic branches are retained for HISTORICAL rows only — nothing calls
// Anthropic since Aug 2026 (see api-server/src/lib/modelPolicy.ts) — but the
// ledger still holds rows that name those models, and re-labelling them would
// make the past unreadable.
function modelShort(model: string): string {
  if (model.startsWith("claude-opus-")) return "Opus";
  if (model.startsWith("claude-sonnet-")) return "Sonnet";
  if (model.startsWith("claude-haiku-")) return "Haiku";
  // Gemini: "gemini-3.1-flash-lite" -> "3.1 Flash-Lite", "gemini-3-flash-preview" -> "3 Flash"
  const gem = model.match(/^gemini-([\d.]+)-(.+)$/);
  if (gem) {
    const tier = gem[2]
      .replace(/-preview$/, "")
      .replace(/flash-lite/, "Flash-Lite")
      .replace(/^flash$/, "Flash")
      .replace(/^pro$/, "Pro");
    return `${gem[1]} ${tier}`;
  }
  // OpenAI: "gpt-5.4-nano" -> "5.4 nano", "gpt-4.1-mini" -> "4.1 mini", "gpt-5.5" -> "5.5"
  const gpt = model.match(/^gpt-([\d.]+)(?:-(.+))?$/);
  if (gpt) return gpt[2] ? `${gpt[1]} ${gpt[2]}` : gpt[1];
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
  const { adminToken, isAdmin } = useAdmin();
  const [data, setData] = useState<ActivityResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [windowPreset, setWindowPreset] = useState<WindowPreset>("7d");
  const [userFilter, setUserFilter] = useState<string>("all");
  const [appFilter, setAppFilter] = useState<string>(lockedApp ?? "all");
  const [expandedUser, setExpandedUser] = useState<number | null>(null);
  const [pendingPause, setPendingPause] = useState<Set<number>>(new Set());
  const [downloading, setDownloading] = useState(false);
  // Global pause switch (cross-product view only).
  const [globalPaused, setGlobalPaused] = useState<boolean | null>(null);
  const [globalPending, setGlobalPending] = useState(false);
  const [stopStalePending, setStopStalePending] = useState(false);
  // Suppression list panel.
  const [supOpen, setSupOpen] = useState(false);
  const [supList, setSupList] = useState<Array<{ email: string; reason: string; source: string | null; created_at: string }>>([]);
  const [supCount, setSupCount] = useState<number | null>(null);
  const [supInput, setSupInput] = useState("");
  const [supBusy, setSupBusy] = useState(false);
  // Admin Kill dialog state. killTarget holds the user being killed (with the
  // trimmed stored name the admin must type back). killResult holds the
  // returned counts after a successful kill so the dialog can show them.
  const [killTarget, setKillTarget] = useState<{ id: number; name: string; email: string | null } | null>(null);
  const [killConfirm, setKillConfirm] = useState("");
  const [killPending, setKillPending] = useState(false);
  const [killError, setKillError] = useState<string | null>(null);
  const [killResult, setKillResult] = useState<KillResponse | null>(null);
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
      const base = BASE_PATH;
      const { since, until } = windowFor(windowPreset);
      const params = new URLSearchParams({ since, until });
      if (userFilter !== "all") params.set("user_id", userFilter);
      if (appFilter !== "all") params.set("app", appFilter);
      const res = await fetch(`${base}api/admin/activity?${params.toString()}`, {
        headers: { "x-api-key": apiKey, "x-admin-key": adminToken || "" },
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

  const fetchGlobalPause = useCallback(async () => {
    if (!apiKey || lockedApp) return;
    try {
      const base = BASE_PATH;
      const res = await fetch(`${base}api/admin/global-pause`, { headers: { "x-api-key": apiKey, "x-admin-key": adminToken || "" } });
      if (!res.ok) return;
      const json = (await res.json()) as { paused: boolean };
      setGlobalPaused(!!json.paused);
    } catch {
      // leave as null; the control just shows a neutral state.
    }
  }, [apiKey, lockedApp]);

  useEffect(() => { fetchGlobalPause(); }, [fetchGlobalPause]);

  const handleToggleGlobalPause = useCallback(async () => {
    if (!apiKey) return;
    const pausing = !globalPaused;
    if (!window.confirm(
      pausing
        ? "Pause ALL campaigns?\n\nThe scheduler stops queueing and sending follow-ups for every user until you resume. Gmail sync and bounce detection keep running. Per-user pauses are not affected."
        : "Resume ALL campaigns?\n\nThe scheduler resumes for everyone. Users you paused individually stay paused."
    )) return;
    setGlobalPending(true);
    try {
      const base = BASE_PATH;
      const res = await fetch(`${base}api/admin/${pausing ? "pause-all" : "resume-all"}`, {
        method: "POST",
        headers: { "x-api-key": apiKey, "x-admin-key": adminToken || "" },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        window.alert(`${pausing ? "Pause all" : "Resume all"} failed: ${body?.error || `HTTP ${res.status}`}`);
      } else {
        setGlobalPaused(pausing);
      }
    } catch (err) {
      window.alert(`${pausing ? "Pause all" : "Resume all"} failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setGlobalPending(false);
    }
  }, [apiKey, globalPaused]);

  const handleStopStale = useCallback(async () => {
    if (!apiKey) return;
    if (!window.confirm(
      "Stop ALL stale campaigns now?\n\nThis pauses every campaign — for EVERY salesperson — that is older than 30 days OR has already sent more than 3 follow-ups. Their scheduled follow-ups are cancelled so nothing else goes out. Already-paused campaigns are not touched.\n\nThis is the same nightly clean-up, run right now. Safe to click again later."
    )) return;
    setStopStalePending(true);
    try {
      const base = BASE_PATH;
      const res = await fetch(`${base}api/admin/stop-stale`, {
        method: "POST",
        headers: { "x-api-key": apiKey, "x-admin-key": adminToken || "" },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        window.alert(`Stop stale failed: ${body?.error || `HTTP ${res.status}`}`);
      } else {
        window.alert(
          `Stopped ${body.total ?? 0} stale campaign(s):\n` +
          `• ${body.expired_paused ?? 0} over 30 days old\n` +
          `• ${body.over_cap_paused ?? 0} over the 3-follow-up cap`
        );
        fetchActivity();
      }
    } catch (err) {
      window.alert(`Stop stale failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setStopStalePending(false);
    }
  }, [apiKey, adminToken, fetchActivity]);

  const fetchSuppression = useCallback(async () => {
    if (!apiKey || lockedApp) return;
    try {
      const base = BASE_PATH;
      const res = await fetch(`${base}api/admin/suppression`, { headers: { "x-api-key": apiKey, "x-admin-key": adminToken || "" } });
      if (!res.ok) return;
      const json = (await res.json()) as { count: number; addresses: typeof supList };
      setSupCount(json.count);
      setSupList(json.addresses || []);
    } catch {
      // leave prior state
    }
  }, [apiKey, lockedApp]);

  useEffect(() => { fetchSuppression(); }, [fetchSuppression]);

  const handleAddSuppression = useCallback(async () => {
    const email = supInput.trim().toLowerCase();
    if (!email || !email.includes("@") || !apiKey) return;
    setSupBusy(true);
    try {
      const base = BASE_PATH;
      const res = await fetch(`${base}api/admin/suppression`, {
        method: "POST",
        headers: { "x-api-key": apiKey, "x-admin-key": adminToken || "", "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        window.alert(`Add failed: ${body?.error || `HTTP ${res.status}`}`);
      } else {
        setSupInput("");
        await fetchSuppression();
      }
    } catch (err) {
      window.alert(`Add failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSupBusy(false);
    }
  }, [apiKey, supInput, fetchSuppression]);

  const handleRemoveSuppression = useCallback(async (email: string) => {
    if (!apiKey) return;
    if (!window.confirm(`Remove ${email} from the suppression list? It will be eligible for sending again.`)) return;
    setSupBusy(true);
    try {
      const base = BASE_PATH;
      const res = await fetch(`${base}api/admin/suppression`, {
        method: "DELETE",
        headers: { "x-api-key": apiKey, "x-admin-key": adminToken || "", "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        window.alert(`Remove failed: ${body?.error || `HTTP ${res.status}`}`);
      } else {
        await fetchSuppression();
      }
    } catch (err) {
      window.alert(`Remove failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSupBusy(false);
    }
  }, [apiKey, fetchSuppression]);

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

  // Admin Kill: the stored name keyed by user id, taken from the same
  // data.users record that drives the row label. The dialog requires the
  // admin to type THIS exact name, so there is no guessing.
  const nameByUserId = useMemo(() => {
    const m = new Map<number, string>();
    for (const u of data?.users ?? []) m.set(u.id, (u.name ?? "").trim());
    return m;
  }, [data]);

  const allUsers = useMemo(() => data?.users ?? [], [data]);

  // 2026-07-29: rows for the Per-user totals table. Previously this was
  // data.user_totals verbatim — users with ZERO usage events in the selected
  // window had no row, which made the Pause/Resume/Kill actions unreachable
  // for exactly the users an admin most needs to reach (e.g. a paused user
  // generates no usage, so shrinking the window hid their Resume button).
  // Users absent from the ledger get a zero row, honoring the user filter.
  const userTotalRows = useMemo<UserTotal[]>(() => {
    const totals = data?.user_totals ?? [];
    const present = new Set(totals.map((t) => t.user_id));
    const zeroRows: UserTotal[] = (data?.users ?? [])
      .filter((u) => !present.has(u.id))
      .filter((u) => userFilter === "all" || String(u.id) === userFilter)
      .map((u) => ({
        user_id: u.id,
        email: u.email,
        name: u.name,
        events: 0,
        followups: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_tokens: 0,
        cache_read_tokens: 0,
        web_searches: 0,
        cost_usd: 0,
        by_app: {},
        by_stage: {},
        by_model: {},
      }));
    return [...totals, ...zeroRows];
  }, [data, userFilter]);

  const handleDownloadExcel = useCallback(async () => {
    if (!apiKey) return;
    setDownloading(true);
    try {
      const base = BASE_PATH;
      const { since, until } = windowFor(windowPreset);
      const params = new URLSearchParams({ since, until });
      if (userFilter !== "all") params.set("user_id", userFilter);
      if (appFilter !== "all") params.set("app", appFilter);
      const res = await fetch(`${base}api/admin/activity-report?${params.toString()}`, {
        headers: { "x-api-key": apiKey, "x-admin-key": adminToken || "" },
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
      const base = BASE_PATH;
      const res = await fetch(`${base}api/admin/users/${userId}/${action}`, {
        method: "POST",
        headers: { "x-api-key": apiKey, "x-admin-key": adminToken || "" },
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

  // Admin Kill: open the typed-name dialog for a user. The stored name is
  // pulled from nameByUserId (same source as the row label) so the name the
  // admin must type matches exactly what they see.
  const openKillDialog = useCallback((userId: number, email: string | null) => {
    setKillTarget({ id: userId, name: nameByUserId.get(userId) ?? "", email });
    setKillConfirm("");
    setKillError(null);
    setKillResult(null);
    setKillPending(false);
  }, [nameByUserId]);

  const closeKillDialog = useCallback(() => {
    setKillTarget(null);
    setKillConfirm("");
    setKillError(null);
    setKillResult(null);
    setKillPending(false);
  }, []);

  // Admin Kill: fire the kill. The confirm button is only enabled when the
  // typed name matches, but we re-check here as a belt-and-braces guard.
  const handleKill = useCallback(async () => {
    if (!apiKey || !killTarget) return;
    const storedName = killTarget.name;
    const typed = killConfirm.trim();
    if (!storedName || typed !== storedName) return;
    setKillPending(true);
    setKillError(null);
    try {
      const base = BASE_PATH;
      const res = await fetch(`${base}api/admin/users/${killTarget.id}/kill`, {
        method: "POST",
        headers: { "x-api-key": apiKey, "x-admin-key": adminToken || "", "Content-Type": "application/json" },
        body: JSON.stringify({ confirmName: typed }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Name mismatch or any error: show the message, leave the table
        // unchanged. The dialog stays open so the admin can read it.
        setKillError((body && body.error) || `HTTP ${res.status}`);
      } else {
        setKillResult(body as KillResponse);
        // Refresh the table so the paused badge appears.
        await fetchActivity({ silent: true });
      }
    } catch (err) {
      setKillError(err instanceof Error ? err.message : String(err));
    } finally {
      setKillPending(false);
    }
  }, [apiKey, killTarget, killConfirm, fetchActivity]);

  // Derived dialog flags.
  const killHasName = !!killTarget && killTarget.name.length > 0;
  const killTypedMatches = !!killTarget && killHasName && killConfirm.trim() === killTarget.name;

  // Real admin gate: a normal manager has no admin token and isAdmin is
  // false, so they never see the dashboard. The server enforces the same
  // boundary on every endpoint regardless of what the client renders.
  if (!isAdmin) {
    return (
      <div className="p-6 max-w-[1400px] mx-auto">
        <div
          className="rounded-lg p-4 text-[13px]"
          style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-default)", color: "var(--text-secondary)" }}
        >
          You do not have admin access.
        </div>
      </div>
    );
  }

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
          {!lockedApp && (
            <Button
              onClick={handleStopStale}
              disabled={stopStalePending}
              variant="outline"
              size="sm"
              title="Pause every campaign older than 30 days or over the 3-follow-up cap — for all users — right now."
            >
              <Trash2 className={`h-3.5 w-3.5 mr-1.5 ${stopStalePending ? "animate-pulse" : ""}`} />
              {stopStalePending ? "Stopping…" : "Stop stale"}
            </Button>
          )}
          {!lockedApp && (
            <Button
              onClick={handleToggleGlobalPause}
              disabled={globalPending}
              variant={globalPaused ? "default" : "outline"}
              size="sm"
              title={globalPaused
                ? "All campaigns are paused. Click to resume everyone."
                : "Pause queueing and sending for every user."}
            >
              {globalPaused
                ? <Play className={`h-3.5 w-3.5 mr-1.5 ${globalPending ? "animate-pulse" : ""}`} />
                : <Pause className={`h-3.5 w-3.5 mr-1.5 ${globalPending ? "animate-pulse" : ""}`} />}
              {globalPending ? "Working…" : (globalPaused ? "Resume all" : "Pause all")}
            </Button>
          )}
          <Button onClick={() => fetchActivity()} disabled={loading} variant="outline" size="sm">
            <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      {!lockedApp && globalPaused && (
        <div
          className="rounded-lg p-3 mb-4 flex items-center gap-2 text-[13px]"
          style={{ background: "var(--bg-tertiary)", border: "1px solid var(--border-default)", color: "var(--text-primary)" }}
        >
          <Pause className="h-4 w-4" />
          All campaigns are paused. The scheduler is not queueing or sending follow-ups for any user. Gmail sync and bounce detection continue.
        </div>
      )}

      {!lockedApp && (
        <div
          className="rounded-lg mb-4"
          style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-default)" }}
        >
          <button
            type="button"
            onClick={() => setSupOpen((v) => !v)}
            className="w-full flex items-center justify-between p-3 text-left"
          >
            <span className="flex items-center gap-2 text-[13px] font-medium" style={{ color: "var(--text-primary)" }}>
              <ShieldOff className="h-4 w-4" /> Suppressed addresses
              {supCount !== null && (
                <span className="text-[12px] font-normal" style={{ color: "var(--text-tertiary)" }}>({supCount})</span>
              )}
            </span>
            {supOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
          {supOpen && (
            <div className="px-3 pb-3">
              <p className="text-[12px] mb-2" style={{ color: "var(--text-tertiary)" }}>
                These addresses are never emailed by any user. Hard bounces add them automatically. Add one by hand for do-not-contact requests.
              </p>
              <div className="flex items-center gap-2 mb-3">
                <input
                  type="email"
                  value={supInput}
                  onChange={(e) => setSupInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleAddSuppression(); }}
                  placeholder="address@example.com"
                  className="flex-1 px-2 py-1 rounded text-[13px]"
                  style={{ background: "var(--bg-primary)", border: "1px solid var(--border-default)", color: "var(--text-primary)" }}
                />
                <Button onClick={handleAddSuppression} disabled={supBusy || !supInput.includes("@")} variant="outline" size="sm">
                  <Plus className="h-3.5 w-3.5 mr-1" /> Add
                </Button>
              </div>
              {supList.length === 0 ? (
                <p className="text-[12px]" style={{ color: "var(--text-tertiary)" }}>No suppressed addresses.</p>
              ) : (
                <div className="max-h-64 overflow-auto">
                  {supList.map((s) => (
                    <div key={s.email} className="flex items-center justify-between py-1.5 text-[12px]" style={{ borderTop: "1px solid var(--border-default)" }}>
                      <span style={{ color: "var(--text-primary)" }}>{s.email}</span>
                      <span className="flex items-center gap-2">
                        <span style={{ color: "var(--text-tertiary)" }}>{s.reason === "hard_bounce" ? "hard bounce" : "manual"}</span>
                        <button
                          type="button"
                          onClick={() => handleRemoveSuppression(s.email)}
                          disabled={supBusy}
                          title="Remove from suppression list"
                          style={{ color: "var(--danger)" }}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

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
      {data && userTotalRows.length > 0 && (
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
                {userTotalRows.map((u) => {
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
                            <div className="inline-flex items-center gap-2">
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
                              {/* Visual separator so the destructive Kill action
                                  is not adjacent to the benign Pause/Resume. */}
                              <span
                                aria-hidden
                                style={{ display: "inline-block", width: 1, height: 16, background: "var(--border-default)" }}
                              />
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); openKillDialog(u.user_id!, u.email); }}
                                title="Hard-stop this person's entire follow-up pipeline (cancels in-flight work, keeps records)."
                                className="text-[11px] px-2 py-1 rounded inline-flex items-center gap-1"
                                style={{
                                  background: "var(--danger-muted, var(--bg-tertiary))",
                                  border: "1px solid var(--danger-border, var(--border-default))",
                                  color: "var(--danger)",
                                  cursor: "pointer",
                                }}
                              >
                                <XOctagon className="h-3 w-3" />
                                Kill
                              </button>
                            </div>
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

      {/* Admin Kill: typed-name confirmation dialog. Destructive action behind
          an explicit name match that echoes the consequence in plain words. */}
      {killTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: "rgba(0,0,0,0.5)" }}
          onClick={() => { if (!killPending) closeKillDialog(); }}
        >
          <div
            className="rounded-lg w-full max-w-[480px] p-5"
            style={{ background: "var(--bg-primary)", border: "1px solid var(--border-default)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 mb-3">
              <XOctagon className="h-5 w-5" style={{ color: "var(--danger)" }} />
              <h2 className="text-[15px] font-semibold" style={{ color: "var(--text-primary)" }}>
                {killResult ? "Pipeline killed" : "Kill follow-up pipeline"}
              </h2>
            </div>

            {killResult ? (
              // Success: show the returned per-subproduct counts.
              <div>
                <p className="text-[13px] mb-3" style={{ color: "var(--text-secondary)" }}>
                  Hard-stopped <strong style={{ color: "var(--text-primary)" }}>{killResult.user.name}</strong>.
                  Every record was kept.
                </p>
                <div className="rounded-lg p-3 mb-3" style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-default)" }}>
                  <div className="text-[12px] mb-2" style={{ color: "var(--text-primary)" }}>
                    <strong>{killResult.followups_cancelled}</strong> follow-up(s) cancelled,{" "}
                    <strong>{killResult.campaigns_paused}</strong> campaign(s) paused.
                  </div>
                  <table className="w-full text-[12px]">
                    <thead>
                      <tr style={{ color: "var(--text-tertiary)" }}>
                        <th className="text-left py-1 font-medium">Product</th>
                        <th className="text-right py-1 font-medium">Cancelled</th>
                        <th className="text-right py-1 font-medium">Paused</th>
                      </tr>
                    </thead>
                    <tbody>
                      {KILL_APP_LABELS.map(({ key, label }) => {
                        const c = killResult.by_app[key] || { followups_cancelled: 0, campaigns_paused: 0 };
                        return (
                          <tr key={key}>
                            <td className="py-1" style={{ color: "var(--text-secondary)" }}>{label}</td>
                            <td className="py-1 text-right font-mono" style={{ color: "var(--text-primary)" }}>{c.followups_cancelled}</td>
                            <td className="py-1 text-right font-mono" style={{ color: "var(--text-primary)" }}>{c.campaigns_paused}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <p className="text-[11px] mb-4" style={{ color: "var(--text-tertiary)" }}>
                  This is not a one-click undo. Resuming the user clears the admin pause, but it does not
                  un-cancel the cancelled follow-ups and does not clear the per-campaign pause.
                </p>
                <div className="flex justify-end">
                  <Button onClick={closeKillDialog} variant="outline" size="sm">Close</Button>
                </div>
              </div>
            ) : !killHasName ? (
              // No stored name: the endpoint would reject a kill, so do not
              // offer a confirm the server will refuse.
              <div>
                <p className="text-[13px] mb-4" style={{ color: "var(--text-secondary)" }}>
                  This person has no name set, so they cannot be killed until a name is added to their
                  account. The kill is gated on typing the exact name, and an empty name would defeat that
                  guard.
                </p>
                {killTarget.email && (
                  <p className="text-[12px] mb-4" style={{ color: "var(--text-tertiary)" }}>
                    User: {killTarget.email}
                  </p>
                )}
                <div className="flex justify-end">
                  <Button onClick={closeKillDialog} variant="outline" size="sm">Close</Button>
                </div>
              </div>
            ) : (
              // Typed-name confirmation.
              <div>
                <p className="text-[13px] mb-3" style={{ color: "var(--text-secondary)" }}>
                  This cancels all queued and in-flight follow-ups for this person across all three products
                  (Doctrine, Context, Anti-Ghosting), stops any further follow-ups from being sent or queued,
                  and keeps every record for history and audit. Nothing is deleted.
                </p>
                <p className="text-[12px] mb-2" style={{ color: "var(--text-secondary)" }}>
                  To confirm, type this person's exact name:
                </p>
                <div
                  className="rounded px-2 py-1 mb-2 text-[13px] font-mono select-all"
                  style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-default)", color: "var(--text-primary)" }}
                >
                  {killTarget.name}
                </div>
                <input
                  type="text"
                  autoFocus
                  value={killConfirm}
                  onChange={(e) => setKillConfirm(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && killTypedMatches && !killPending) handleKill(); }}
                  placeholder="Type the name to enable Kill"
                  className="w-full px-2 py-1.5 rounded text-[13px] mb-3"
                  style={{ background: "var(--bg-primary)", border: "1px solid var(--border-default)", color: "var(--text-primary)" }}
                />
                {killError && (
                  <div
                    className="rounded p-2 mb-3 text-[12px]"
                    style={{ background: "var(--danger-muted)", border: "1px solid var(--danger-border)", color: "var(--danger)" }}
                  >
                    {killError}
                  </div>
                )}
                <div className="flex justify-end gap-2">
                  <Button onClick={closeKillDialog} disabled={killPending} variant="outline" size="sm">Cancel</Button>
                  <button
                    type="button"
                    onClick={handleKill}
                    disabled={!killTypedMatches || killPending}
                    className="text-[13px] px-3 py-1.5 rounded inline-flex items-center gap-1.5 font-medium"
                    style={{
                      background: (!killTypedMatches || killPending) ? "var(--bg-tertiary)" : "var(--danger)",
                      border: "1px solid var(--danger-border, var(--border-default))",
                      color: (!killTypedMatches || killPending) ? "var(--text-tertiary)" : "var(--danger-foreground, #fff)",
                      cursor: (!killTypedMatches || killPending) ? "not-allowed" : "pointer",
                      opacity: killPending ? 0.7 : 1,
                    }}
                  >
                    <XOctagon className="h-3.5 w-3.5" />
                    {killPending ? "Killing…" : "Kill pipeline"}
                  </button>
                </div>
              </div>
            )}
          </div>
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