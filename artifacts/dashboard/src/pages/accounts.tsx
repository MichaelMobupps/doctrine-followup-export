import React, { useState, useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useApiKey } from "@/hooks/use-api-key";
import { useCurrentUser } from "@/hooks/use-current-user";
import { useGetGmailAccounts } from "@workspace/api-client-react";
import { Card, Button, Input } from "@/components/ui";
import { ModeSwitchModal } from "@/components/mode-switch-modal";
import {
  Plus,
  Trash2,
  Save,
  ChevronDown,
  ChevronUp,
  Loader2,
  Send,
  Eye,
  FileEdit,
  X,
} from "lucide-react";
import { BASE_PATH } from "@/lib/app-urls";

interface StageTiming {
  minDays: number;
  maxDays: number;
}

type FollowupMode = "auto_send" | "review_in_app" | "draft_in_gmail";

// The rigid per-prospect follow-up cap. The scheduler clamps every campaign to
// this many stages (HARD_FOLLOWUP_CAP in api-server/src/lib/followupLimits.ts),
// so the settings editor must never let an operator configure a stage beyond
// it — a 4th+ stage window would be dead config that can never fire. Keep this
// in sync with HARD_FOLLOWUP_CAP.
const MAX_FOLLOWUP_STAGES = 3;

const DEFAULT_STAGE_TIMING: StageTiming[] = [
  { minDays: 3, maxDays: 7 },
  { minDays: 10, maxDays: 14 },
  { minDays: 21, maxDays: 28 },
];

const DEFAULT_DRAFT_STAGE_TIMING: StageTiming[] = [
  { minDays: 3, maxDays: 7 },
  { minDays: 5, maxDays: 10 },
  { minDays: 7, maxDays: 14 },
];

function ensureStages(existing: StageTiming[] | undefined, count: number, fallback: StageTiming[]): StageTiming[] {
  const base = (existing && existing.length > 0 ? existing : fallback);
  const result = [...base];
  while (result.length < count) {
    const lastMax = result.length > 0 ? result[result.length - 1].maxDays : 0;
    result.push({ minDays: lastMax + 7, maxDays: lastMax + 14 });
  }
  return result.slice(0, count);
}

export default function Accounts() {
  const { apiKey } = useApiKey();
  const { user: currentUser, setUser } = useCurrentUser();
  const requestOpts = { request: { headers: { "x-api-key": apiKey || "" } } };

  const { data, isLoading, refetch } = useGetGmailAccounts({
    ...requestOpts,
    query: { queryKey: ["/api/accounts"], enabled: !!apiKey },
  });

  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("oauth_success") === "true") {
      const connectedEmail = decodeURIComponent(params.get("email") || "");
      setSuccessMsg(`Connected ${connectedEmail || "account"}`);
      window.history.replaceState({}, "", window.location.pathname);
      setTimeout(() => setSuccessMsg(null), 5000);
      const base = BASE_PATH;
      fetch(`${base}api/gmail/accounts`, { headers: { "x-api-key": apiKey || "" } })
        .then(r => r.json())
        .then(acctData => {
          const accts = acctData.accounts || [];
          const me = connectedEmail
            ? accts.find((a: any) => a.email.toLowerCase() === connectedEmail.toLowerCase())
            : accts[0];
          if (me) {
            localStorage.setItem("doctrine_user_email", me.email);
            setUser({ email: me.email, userId: me.id, name: me.name || me.email });
          }
          refetch();
        })
        .catch(() => refetch());
    }
    const oauthError = params.get("oauth_error");
    if (oauthError) {
      const errorMessages: Record<string, string> = {
        denied: "Google sign-in was cancelled",
        missing_params: "Missing parameters from Google redirect",
        invalid_state: "OAuth session expired. Please try again.",
        no_refresh_token: "Google did not provide a refresh token. Try disconnecting the app from your Google account settings and connecting again.",
        no_email: "Could not retrieve email from Google",
        callback_failed: "OAuth callback failed. Please try again.",
      };
      setErrorMsg(errorMessages[oauthError] || `OAuth error: ${oauthError}`);
      window.history.replaceState({}, "", window.location.pathname);
      setTimeout(() => setErrorMsg(null), 10000);
    }
  }, []);

  const handleConnect = async () => {
    setConnecting(true);
    setErrorMsg(null);
    try {
      const base = BASE_PATH;
      const res = await fetch(`${base}api/gmail/auth`, {
        headers: { "x-api-key": apiKey || "" },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to start OAuth");
      window.location.href = data.authUrl;
    } catch (err: any) {
      setErrorMsg(err.message || "Failed to start Gmail connection");
      setConnecting(false);
      setTimeout(() => setErrorMsg(null), 8000);
    }
  };

  const handleDisconnect = async (id: number) => {
    if (!confirm("Disconnect this Gmail account? Existing prospects and follow-ups will remain.")) return;
    try {
      const base = BASE_PATH;
      const res = await fetch(`${base}api/gmail/accounts/${id}`, {
        method: "DELETE",
        headers: { "x-api-key": apiKey || "" },
      });
      if (!res.ok) throw new Error("Failed to disconnect");
      refetch();
    } catch (err) {
      setErrorMsg("Failed to disconnect account");
      setTimeout(() => setErrorMsg(null), 5000);
    }
  };

  const allAccounts = (data as any)?.accounts || [];
  const accounts = currentUser?.userId
    ? allAccounts.filter((a: any) => a.id === currentUser.userId || a.email.toLowerCase() === (currentUser.email || "").toLowerCase())
    : allAccounts;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 style={{ fontSize: "20px", fontWeight: 600, letterSpacing: "-0.02em" }}>Settings</h1>
        <Button onClick={handleConnect} disabled={connecting} className="gap-2">
          {connecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          {connecting ? "Redirecting..." : "Connect Gmail"}
        </Button>
      </div>

      <AnimatePresence>
        {successMsg && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="rounded-lg p-4 flex items-center gap-3 text-[13px]"
            style={{ background: "var(--success-muted)", border: "1px solid var(--success-border)", color: "var(--success)" }}
          >
            {successMsg}
          </motion.div>
        )}
        {errorMsg && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="rounded-lg p-4 flex items-center gap-3 text-[13px]"
            style={{ background: "var(--danger-muted)", border: "1px solid var(--danger-border)", color: "var(--danger)" }}
          >
            {errorMsg}
          </motion.div>
        )}
      </AnimatePresence>

      {isLoading && (
        <div className="space-y-4">
          {[1, 2].map((i) => (
            <Card key={i} className="p-5 animate-pulse" style={{ opacity: 0.4 }}>
              <div className="h-5 w-48 rounded" style={{ background: "var(--bg-tertiary)" }} />
              <div className="h-4 w-32 rounded mt-2" style={{ background: "var(--bg-tertiary)", opacity: 0.6 }} />
            </Card>
          ))}
        </div>
      )}

      {!isLoading && accounts.length === 0 && (
        <Card className="p-12 text-center" style={{ borderStyle: "dashed" }}>
          <p className="font-medium text-[13px] mb-2" style={{ color: "var(--text-primary)" }}>No accounts connected</p>
          <p className="text-[13px] mb-5" style={{ color: "var(--text-secondary)" }}>
            Connect a Gmail account to start syncing and scheduling follow-ups.
          </p>
          <Button onClick={handleConnect} disabled={connecting} className="gap-2">
            {connecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            {connecting ? "Redirecting..." : "Connect Gmail"}
          </Button>
        </Card>
      )}

      <div className="space-y-4">
        {accounts.map((account: any) => (
          <AccountCard
            key={account.id}
            account={account}
            isExpanded={expandedId === account.id}
            onToggle={() => setExpandedId(expandedId === account.id ? null : account.id)}
            onDisconnect={() => handleDisconnect(account.id)}
            onReconnect={handleConnect}
            apiKey={apiKey || ""}
            onSettingsSaved={() => refetch()}
          />
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Mode card                                                          */
/* ------------------------------------------------------------------ */

interface ModeCardProps {
  mode: FollowupMode;
  active: boolean;
  onSelect: () => void;
}

function ModeCard({ mode, active, onSelect }: ModeCardProps) {
  const meta: Record<FollowupMode, { title: string; tagline: string; icon: any; tone: "neutral" | "accent" | "warning" }> = {
    auto_send: {
      title: "Auto-send",
      tagline: "Follow-ups send automatically at the scheduled time.",
      icon: Send,
      tone: "neutral",
    },
    review_in_app: {
      title: "Review in app",
      tagline: "We generate the follow-up; you approve in the Pipeline before it sends.",
      icon: Eye,
      tone: "accent",
    },
    draft_in_gmail: {
      title: "Draft in Gmail",
      tagline: "We create a Gmail draft. You open Gmail and click Send manually.",
      icon: FileEdit,
      tone: "warning",
    },
  };

  const m = meta[mode];
  const Icon = m.icon;

  // Tone-based color mapping. Active state inverts to filled background.
  const toneStyles: Record<typeof m.tone, { activeBg: string; activeBorder: string; activeText: string; idleAccent: string }> = {
    neutral: {
      activeBg: "var(--bg-tertiary)",
      activeBorder: "var(--text-secondary)",
      activeText: "var(--text-primary)",
      idleAccent: "var(--text-tertiary)",
    },
    accent: {
      activeBg: "var(--accent-muted)",
      activeBorder: "var(--accent-border)",
      activeText: "var(--accent)",
      idleAccent: "var(--accent)",
    },
    warning: {
      activeBg: "var(--warning-muted)",
      activeBorder: "var(--warning-border)",
      activeText: "var(--warning)",
      idleAccent: "var(--warning)",
    },
  };
  const ts = toneStyles[m.tone];

  return (
    <button
      type="button"
      onClick={onSelect}
      className="text-left p-4 rounded-md transition-all duration-150 flex flex-col gap-2"
      style={{
        background: active ? ts.activeBg : "transparent",
        border: `1px solid ${active ? ts.activeBorder : "var(--border-default)"}`,
        boxShadow: active ? `inset 0 0 0 1px ${ts.activeBorder}` : "none",
        cursor: "pointer",
        minHeight: "120px",
      }}
      role="radio"
      aria-checked={active}
      data-mode={mode}
    >
      <div className="flex items-center gap-2">
        <span
          className="flex items-center justify-center rounded-full"
          style={{
            width: "16px",
            height: "16px",
            border: `1.5px solid ${active ? ts.activeText : "var(--border-hover)"}`,
            flexShrink: 0,
          }}
        >
          {active && (
            <span
              className="rounded-full"
              style={{ width: "8px", height: "8px", background: ts.activeText }}
            />
          )}
        </span>
        <Icon className="h-4 w-4" style={{ color: active ? ts.activeText : ts.idleAccent }} />
        <span
          className="font-semibold text-[13px]"
          style={{ color: active ? ts.activeText : "var(--text-primary)" }}
        >
          {m.title}
        </span>
      </div>
      <p className="text-[12px] leading-relaxed" style={{ color: active ? ts.activeText : "var(--text-secondary)" }}>
        {m.tagline}
      </p>
      {mode === "draft_in_gmail" && (
        <p
          className="text-[11px] mt-auto pt-1 font-medium"
          style={{ color: active ? "var(--warning)" : "var(--text-tertiary)" }}
        >
          Drafts unsent for 30+ days are stalled.
        </p>
      )}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/*  Timing block (shared by auto-send + draft modes)                   */
/* ------------------------------------------------------------------ */

interface TimingBlockProps {
  title: string;
  tone: "neutral" | "warning";
  active: boolean;
  stages: StageTiming[];
  onChange: (next: StageTiming[]) => void;
  helperText: string;
  maxStages: number;
}

function TimingBlock({ title, tone, active, stages, onChange, helperText, maxStages }: TimingBlockProps) {
  const toneColor = tone === "warning" ? "var(--warning)" : "var(--text-secondary)";
  const toneBorder = tone === "warning" ? "var(--warning-border)" : "var(--border-default)";

  const updateStage = (i: number, field: "minDays" | "maxDays", value: number) => {
    const updated = [...stages];
    updated[i] = { ...updated[i], [field]: Math.max(1, Math.min(365, value)) };
    onChange(updated);
  };

  const atStageCap = stages.length >= maxStages;

  const addStage = () => {
    // The follow-up cap is rigid. Never configure a stage past the cap: the
    // scheduler clamps every campaign to maxStages, so a further window could
    // never fire and only misleads the operator.
    if (stages.length >= maxStages) return;
    const lastMax = stages.length > 0 ? stages[stages.length - 1].maxDays : 0;
    onChange([...stages, { minDays: lastMax + 7, maxDays: lastMax + 14 }]);
  };

  const removeStage = (i: number) => {
    if (stages.length <= 1) return;
    onChange(stages.filter((_, idx) => idx !== i));
  };

  return (
    <div
      className="rounded-md p-4 flex-1"
      style={{
        background: active ? "var(--bg-secondary)" : "var(--bg-tertiary)",
        border: `1px solid ${active ? toneBorder : "var(--border-default)"}`,
        opacity: active ? 1 : 0.55,
        pointerEvents: active ? "auto" : "none",
        transition: "opacity 0.15s ease",
      }}
      aria-disabled={!active}
    >
      <div className="flex items-center justify-between mb-3">
        <span
          className="font-semibold uppercase tracking-[0.04em] text-[11px]"
          style={{ color: active ? toneColor : "var(--text-tertiary)" }}
        >
          {title}
        </span>
        <span className="text-[11px] font-mono" style={{ color: "var(--text-tertiary)" }}>
          {stages.length} stage{stages.length !== 1 ? "s" : ""}
        </span>
      </div>

      <div className="space-y-2">
        {stages.map((stage, i) => (
          <div
            key={i}
            className="flex items-end gap-2 p-2 rounded"
            style={{ background: "var(--bg-tertiary)", border: "1px solid var(--border-default)" }}
          >
            <div className="font-mono text-[12px] font-semibold w-8 flex-shrink-0 mb-1.5" style={{ color: "var(--text-secondary)" }}>
              F{i + 1}
            </div>
            <div>
              <label className="block mb-1 text-[10px] uppercase tracking-[0.04em]" style={{ color: "var(--text-tertiary)" }}>
                Min
              </label>
              <Input
                type="number"
                min={1}
                max={365}
                value={stage.minDays}
                onChange={(e) => updateStage(i, "minDays", parseInt(e.target.value) || 1)}
                className="w-16"
                disabled={!active}
              />
            </div>
            <span className="mb-2 text-[12px]" style={{ color: "var(--text-tertiary)" }}>–</span>
            <div>
              <label className="block mb-1 text-[10px] uppercase tracking-[0.04em]" style={{ color: "var(--text-tertiary)" }}>
                Max
              </label>
              <Input
                type="number"
                min={1}
                max={365}
                value={stage.maxDays}
                onChange={(e) => updateStage(i, "maxDays", parseInt(e.target.value) || 1)}
                className="w-16"
                disabled={!active}
              />
            </div>
            <span className="ml-auto text-[10px] mb-1.5" style={{ color: "var(--text-tertiary)" }}>days</span>
            {stages.length > 1 && (
              <button
                type="button"
                onClick={() => removeStage(i)}
                className="mb-1 p-1 rounded hover:bg-[var(--danger-muted)] transition-colors"
                style={{ color: "var(--text-tertiary)" }}
                title={`Remove stage ${i + 1}`}
                disabled={!active}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between mt-3">
        {atStageCap ? (
          <span className="text-[11px] font-medium" style={{ color: "var(--text-tertiary)" }}>
            Maximum {maxStages} follow-up stages reached
          </span>
        ) : (
          <button
            type="button"
            onClick={addStage}
            className="inline-flex items-center gap-1.5 text-[12px] font-medium px-2 py-1 rounded transition-all"
            style={{
              color: active ? "var(--accent)" : "var(--text-tertiary)",
              background: "transparent",
              border: `1px dashed ${active ? "var(--accent-border)" : "var(--border-default)"}`,
            }}
            disabled={!active}
          >
            <Plus className="h-3 w-3" /> Add stage
          </button>
        )}
        <span className="text-[11px] italic" style={{ color: "var(--text-tertiary)" }}>
          System cap: {maxStages} follow-ups per prospect
        </span>
      </div>

      <p className="text-[11px] mt-2" style={{ color: "var(--text-tertiary)" }}>
        {helperText}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  AccountCard — main                                                 */
/* ------------------------------------------------------------------ */

function AccountCard({
  account,
  isExpanded,
  onToggle,
  onDisconnect,
  onReconnect,
  apiKey,
  onSettingsSaved,
}: {
  account: any;
  isExpanded: boolean;
  onToggle: () => void;
  onDisconnect: () => void;
  // F-3.6a: starts the same OAuth flow as the page-level Connect Gmail
  // button. Present so the "— reconnect" instruction has a control next to
  // it rather than sending the operator hunting up the page.
  onReconnect: () => void;
  apiKey: string;
  onSettingsSaved: () => void;
}) {
  const initialMode: FollowupMode = (["auto_send", "review_in_app", "draft_in_gmail"].includes(account.followupMode)
    ? account.followupMode
    : "auto_send") as FollowupMode;

  const [followupMode, setFollowupMode] = useState<FollowupMode>(initialMode);
  const [hasSeenDraftWarning, setHasSeenDraftWarning] = useState<boolean>(!!account.hasSeenDraftModeWarning);

  // Track stage timing arrays per mode independently so users see their
  // configured rows when toggling between blocks. The auto-send block uses
  // `stageTiming`; the draft block uses `draftStageTiming`.
  // Clamp displayed stages to the hard cap. A stored array with more than
  // MAX_FOLLOWUP_STAGES windows (legacy config) has dead stages that never
  // fire; trimming them here keeps the editor honest and stops the next save
  // from re-persisting them.
  const initialAutoStages = ensureStages(account.stageTiming, MAX_FOLLOWUP_STAGES, DEFAULT_STAGE_TIMING);
  const initialDraftStages = ensureStages(account.draftStageTiming, MAX_FOLLOWUP_STAGES, DEFAULT_DRAFT_STAGE_TIMING);

  const [autoStages, setAutoStages] = useState<StageTiming[]>(initialAutoStages);
  const [draftStages, setDraftStages] = useState<StageTiming[]>(initialDraftStages);

  const [sendDays, setSendDays] = useState<number[]>(account.sendDays || [1, 2, 3, 4, 5]);
  const [sendHourStart, setSendHourStart] = useState<number>(account.sendHourStart ?? 8);
  const [sendHourEnd, setSendHourEnd] = useState<number>(account.sendHourEnd ?? 18);
  // CB-2: the cap is rigid. "Unlimited" was removed; the maximum is hard at
  // MAX_FOLLOWUPS_CAP and the backend clamps any stored value into
  // 1..MAX_FOLLOWUPS_CAP on save. Keep this literal in sync with
  // HARD_FOLLOWUP_CAP in api-server/src/lib/followupLimits.ts.
  const MAX_FOLLOWUPS_CAP = MAX_FOLLOWUP_STAGES;
  const initialMaxFollowups = Math.min(
    typeof account.maxFollowups === "number" && account.maxFollowups > 0
      ? account.maxFollowups
      : MAX_FOLLOWUPS_CAP,
    MAX_FOLLOWUPS_CAP,
  );
  const [maxFollowups, setMaxFollowups] = useState<number>(initialMaxFollowups);
  const [doctrineLabel, setDoctrineLabel] = useState<string>(account.doctrineLabel || "Doctrine SDR");
  // Phase 7d: Context Followuper label, settable per-account.
  const [contextLabel, setContextLabel] = useState<string>(account.contextLabel || "Context Followuper");
  // B9b.2: AntiGhosting label, settable per-account. Cast through
  // Record<string, any> until the Orval-generated GmailAccount type
  // is regenerated to include the new field.
  const [antiGhostingLabel, setAntiGhostingLabel] = useState<string>(
    ((account as Record<string, any>).antiGhostingLabel as string) || "AntiGhosting Followuper",
  );
  const [weeklyDigestEnabled, setWeeklyDigestEnabled] = useState<boolean>(account.weeklyDigestEnabled === true);

  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");

  // Mode-switch confirmation modal state
  const [showModeWarning, setShowModeWarning] = useState(false);
  const [pendingMode, setPendingMode] = useState<FollowupMode | null>(null);

  // Resync state when account prop changes (e.g. after a successful save refresh)
  useEffect(() => {
    setFollowupMode(initialMode);
    setHasSeenDraftWarning(!!account.hasSeenDraftModeWarning);
  }, [account.id, account.followupMode, account.hasSeenDraftModeWarning]);

  const handleModeSelect = (mode: FollowupMode) => {
    if (mode === followupMode) return;
    // First-time switch to draft_in_gmail triggers the warning modal.
    if (mode === "draft_in_gmail" && !hasSeenDraftWarning) {
      setPendingMode(mode);
      setShowModeWarning(true);
      return;
    }
    setFollowupMode(mode);
  };

  const handleConfirmDraftWarning = () => {
    if (pendingMode) {
      setFollowupMode(pendingMode);
      setHasSeenDraftWarning(true); // optimistic; persisted on save
    }
    setShowModeWarning(false);
    setPendingMode(null);
  };

  const handleCancelDraftWarning = () => {
    setShowModeWarning(false);
    setPendingMode(null);
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveMsg("");
    try {
      const base = BASE_PATH;
      const body: Record<string, any> = {
        followupMode,
        stageTiming: autoStages,
        draftStageTiming: draftStages,
        sendDays,
        sendHourStart,
        sendHourEnd,
        doctrineLabel,
        contextLabel,
        antiGhostingLabel,
        weeklyDigestEnabled,
        // CB-2: always persist a clamped 1..MAX_FOLLOWUPS_CAP value.
        maxFollowups: Math.min(Math.max(maxFollowups, 1), MAX_FOLLOWUPS_CAP),
      };
      // Only persist warning-acknowledgment if it changed from false to true in
      // this session. Sending TRUE on every save is harmless but redundant.
      if (hasSeenDraftWarning && !account.hasSeenDraftModeWarning) {
        body.hasSeenDraftModeWarning = true;
      }
      const res = await fetch(`${base}api/gmail/accounts/${account.id}/settings`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to save");
      }
      setSaveMsg("Settings saved");
      onSettingsSaved();
      setTimeout(() => setSaveMsg(""), 3000);
    } catch (err: any) {
      setSaveMsg(err.message || "Failed to save settings");
    } finally {
      setSaving(false);
    }
  };

  // F-3.6a: connection health, as the server decided it. Read through `as any`
  // for the same reason pausedByAdmin is — the Orval-generated account type is
  // regenerated from the OpenAPI spec, and widening that spec is a separate
  // change with its own blast radius. `connectionState` is the authority;
  // `authDeadAt` is the fallback if an older server build is answering.
  const acct = account as any;
  const authDead: boolean =
    acct.connectionState === "auth_dead" || (Boolean(acct.authDeadAt) && account.isConnected);
  const authDeadMessage: string =
    typeof acct.authDeadMessage === "string" && acct.authDeadMessage
      ? acct.authDeadMessage
      : "Gmail connection dead — reconnect";

  return (
    <Card className="overflow-hidden">
      <div className="p-5 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="font-semibold text-[13px]" style={{ color: "var(--text-primary)" }}>
                {account.name || account.email}
              </h3>
              {/* F-3.6a: three states, not two. Until this order an account
                  whose Gmail grant Google refuses still rendered CONNECTED —
                  on 2026-08-09 six of twelve did, while none of them could
                  send a thing. AUTH-DEAD is its own badge and it must win
                  over CONNECTED, because "connected" was the lie. */}
              {authDead ? (
                <span
                  className="text-[11px] font-mono font-medium px-2 py-0.5 rounded"
                  style={{ background: "var(--danger-muted)", color: "var(--danger)" }}
                  title="Google is refusing this account's Gmail grant. No follow-ups are queued, generated or sent for it until it is reconnected."
                >
                  AUTH-DEAD
                </span>
              ) : account.isConnected ? (
                <span
                  className="text-[11px] font-mono font-medium px-2 py-0.5 rounded"
                  style={{ background: "var(--success-muted)", color: "var(--success)" }}
                >
                  CONNECTED
                </span>
              ) : (
                <span
                  className="text-[11px] font-mono font-medium px-2 py-0.5 rounded"
                  style={{ background: "var(--danger-muted)", color: "var(--danger)" }}
                >
                  DISCONNECTED
                </span>
              )}
              {/* 2026-07-29 admin-pause visibility: an admin-paused account
                  still syncs but never queues follow-ups — surface it here
                  instead of only on the admin-key-gated Admin Activity page. */}
              {(account as any).pausedByAdmin && (
                <span
                  className="text-[11px] font-mono font-medium px-2 py-0.5 rounded"
                  style={{ background: "var(--warning-muted)", color: "var(--warning)" }}
                  title="Follow-ups are not queued for this account until an admin resumes it"
                >
                  PAUSED BY ADMIN
                </span>
              )}
            </div>
            <p className="text-[12px] mt-0.5" style={{ color: "var(--text-secondary)" }}>{account.email}</p>
            {/* F-3.6a: the sentence, in plain words, under the address. The
                server builds it (lib/connectionHealth.authDeadMessage) so
                every client says the same thing. Rendered as text — it is
                data from an external system and never markup. */}
            {authDead && (
              <p className="text-[12px] mt-1" style={{ color: "var(--danger)" }}>
                {authDeadMessage}
              </p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* F-3.6a: the instruction says "reconnect", so the control sits
              next to it. Same OAuth flow as the page-level Connect Gmail
              button — the callback matches on the address and clears the
              auth-dead state on the way through. */}
          {authDead && (
            <Button size="sm" onClick={onReconnect} className="gap-1.5">
              <Plus className="h-3.5 w-3.5" />
              Reconnect
            </Button>
          )}
          <Button variant="secondary" size="sm" onClick={onToggle} className="gap-1.5">
            Settings
            {isExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </Button>
          <Button variant="destructive" size="sm" onClick={onDisconnect} className="gap-1.5">
            <Trash2 className="h-3.5 w-3.5" />
            Disconnect
          </Button>
        </div>
      </div>

      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="overflow-hidden"
          >
            <div className="p-5 space-y-6" style={{ borderTop: "1px solid var(--border-default)" }}>

              {/* Mode picker */}
              <div>
                <label
                  className="block mb-2 font-medium uppercase tracking-[0.04em]"
                  style={{ fontSize: "11px", color: "var(--text-tertiary)" }}
                >
                  Follow-up mode
                </label>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3" role="radiogroup" aria-label="Follow-up mode">
                  <ModeCard
                    mode="auto_send"
                    active={followupMode === "auto_send"}
                    onSelect={() => handleModeSelect("auto_send")}
                  />
                  <ModeCard
                    mode="review_in_app"
                    active={followupMode === "review_in_app"}
                    onSelect={() => handleModeSelect("review_in_app")}
                  />
                  <ModeCard
                    mode="draft_in_gmail"
                    active={followupMode === "draft_in_gmail"}
                    onSelect={() => handleModeSelect("draft_in_gmail")}
                  />
                </div>
              </div>

              {/* Side-by-side timing blocks */}
              <div>
                <label
                  className="block mb-2 font-medium uppercase tracking-[0.04em]"
                  style={{ fontSize: "11px", color: "var(--text-tertiary)" }}
                >
                  Stage timing
                </label>
                <div className="flex flex-col lg:flex-row gap-4">
                  <TimingBlock
                    title="Auto-send / Review-in-app"
                    tone="neutral"
                    active={followupMode === "auto_send" || followupMode === "review_in_app"}
                    stages={autoStages}
                    onChange={setAutoStages}
                    helperText="Days are measured from the original outreach send time."
                    maxStages={MAX_FOLLOWUPS_CAP}
                  />
                  <TimingBlock
                    title="Draft in Gmail"
                    tone="warning"
                    active={followupMode === "draft_in_gmail"}
                    stages={draftStages}
                    onChange={setDraftStages}
                    helperText="Days are measured from when you manually sent the previous stage."
                    maxStages={MAX_FOLLOWUPS_CAP}
                  />
                </div>
              </div>

              {/* CB-2: Maximum follow-ups per prospect. Rigid cap, no Unlimited. */}
              <div>
                <label className="block mb-1.5 font-medium uppercase tracking-[0.04em]" style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>
                  Maximum follow-ups per prospect
                </label>
                <div className="flex items-center gap-3">
                  <Input
                    type="number"
                    min={1}
                    max={MAX_FOLLOWUPS_CAP}
                    value={maxFollowups}
                    onChange={(e) => setMaxFollowups(Math.min(Math.max(parseInt(e.target.value) || 1, 1), MAX_FOLLOWUPS_CAP))}
                    className="w-24"
                  />
                </div>
                <p className="text-[11px] mt-1" style={{ color: "var(--text-tertiary)" }}>
                  Cap on how many follow-up stages each prospect can receive. The system maximum is {MAX_FOLLOWUPS_CAP}, and campaigns also stop automatically after 30 days.
                </p>
              </div>

              {/* Send window — shared across modes */}
              <div>
                <label className="block mb-3 font-medium uppercase tracking-[0.04em]" style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>
                  Send window
                </label>

                <div className="mb-4">
                  <p className="text-[11px] mb-2" style={{ color: "var(--text-tertiary)" }}>Send on these days</p>
                  <div className="flex gap-2 flex-wrap">
                    {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day, i) => {
                      const isActive = sendDays.includes(i);
                      return (
                        <button
                          key={day}
                          type="button"
                          onClick={() => {
                            if (isActive) {
                              setSendDays(sendDays.filter((d) => d !== i));
                            } else {
                              setSendDays([...sendDays, i].sort());
                            }
                          }}
                          className="px-3 py-1.5 rounded-full text-[12px] font-medium transition-all duration-150"
                          style={
                            isActive
                              ? { background: "var(--accent-muted)", border: "1px solid var(--accent-border)", color: "var(--accent)" }
                              : { background: "transparent", border: "1px solid var(--border-default)", color: "var(--text-secondary)" }
                          }
                        >
                          {day}
                        </button>
                      );
                    })}
                  </div>
                  <p className="text-[11px] mt-1.5" style={{ color: "var(--text-tertiary)" }}>Emails landing on excluded days shift to the next allowed day</p>
                </div>

                <div className="flex items-center gap-4">
                  <div>
                    <label className="block mb-1 font-medium uppercase tracking-[0.04em]" style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>Start hour</label>
                    <Input
                      type="number"
                      min={0}
                      max={23}
                      value={sendHourStart}
                      onChange={(e) => setSendHourStart(parseInt(e.target.value) || 0)}
                      className="w-20"
                    />
                  </div>
                  <span className="mt-5" style={{ color: "var(--text-tertiary)" }}>to</span>
                  <div>
                    <label className="block mb-1 font-medium uppercase tracking-[0.04em]" style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>End hour</label>
                    <Input
                      type="number"
                      min={0}
                      max={23}
                      value={sendHourEnd}
                      onChange={(e) => setSendHourEnd(parseInt(e.target.value) || 0)}
                      className="w-20"
                    />
                  </div>
                </div>
                <p className="text-[11px] mt-1" style={{ color: "var(--text-tertiary)" }}>24-hour format, UTC</p>
              </div>

              {/* Gmail label — Doctrine */}
              <div>
                <label className="block mb-1.5 font-medium uppercase tracking-[0.04em]" style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>
                  Doctrine Gmail label
                </label>
                <Input
                  value={doctrineLabel}
                  onChange={(e) => setDoctrineLabel(e.target.value)}
                  placeholder="Doctrine SDR"
                  className="max-w-xs"
                />
                <p className="text-[11px] mt-1" style={{ color: "var(--text-tertiary)" }}>Comma-separated label names to sync into the Doctrine flow</p>
              </div>

              {/* Phase 7d: Gmail label — Context */}
              <div>
                <label className="block mb-1.5 font-medium uppercase tracking-[0.04em]" style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>
                  Context Gmail label
                </label>
                <Input
                  value={contextLabel}
                  onChange={(e) => setContextLabel(e.target.value)}
                  placeholder="Context Followuper"
                  className="max-w-xs"
                />
                <p className="text-[11px] mt-1" style={{ color: "var(--text-tertiary)" }}>Comma-separated label names to sync into the Context flow</p>
              </div>

              {/* B9b.2: Gmail label — AntiGhosting */}
              <div>
                <label className="block mb-1.5 font-medium uppercase tracking-[0.04em]" style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>
                  Anti-Ghosting Gmail label
                </label>
                <Input
                  value={antiGhostingLabel}
                  onChange={(e) => setAntiGhostingLabel(e.target.value)}
                  placeholder="AntiGhosting Followuper"
                  className="max-w-xs"
                />
                <p className="text-[11px] mt-1" style={{ color: "var(--text-tertiary)" }}>Comma-separated label names to sync into the Anti-Ghosting flow</p>
              </div>

              {/* Phase 4: Weekly digest toggle */}
              <div>
                <label className="block mb-1.5 font-medium uppercase tracking-[0.04em]" style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>
                  Weekly digest
                </label>
                <button
                  type="button"
                  role="switch"
                  aria-checked={weeklyDigestEnabled}
                  onClick={() => setWeeklyDigestEnabled(!weeklyDigestEnabled)}
                  className="inline-flex items-center gap-3 px-3 py-2 rounded-md transition-all"
                  style={{
                    background: weeklyDigestEnabled ? "var(--accent-muted)" : "var(--bg-tertiary)",
                    border: `1px solid ${weeklyDigestEnabled ? "var(--accent-border)" : "var(--border-default)"}`,
                    cursor: "pointer",
                  }}
                >
                  <span
                    className="inline-block rounded-full transition-transform"
                    style={{
                      width: "32px",
                      height: "18px",
                      background: weeklyDigestEnabled ? "var(--accent)" : "var(--border-hover)",
                      position: "relative",
                    }}
                  >
                    <span
                      className="inline-block rounded-full bg-white shadow"
                      style={{
                        width: "14px",
                        height: "14px",
                        position: "absolute",
                        top: "2px",
                        left: weeklyDigestEnabled ? "16px" : "2px",
                        transition: "left 0.15s ease",
                      }}
                    />
                  </span>
                  <span className="text-[13px] font-medium" style={{ color: "var(--text-primary)" }}>
                    {weeklyDigestEnabled ? "Enabled" : "Disabled"}
                  </span>
                </button>
                <p className="text-[11px] mt-1" style={{ color: "var(--text-tertiary)" }}>
                  Sends a recap of the last 7 days every Tuesday at 00:00 UTC, delivered to your own Gmail inbox.
                </p>
              </div>

              <div className="flex items-center gap-3">
                <Button onClick={handleSave} disabled={saving} className="gap-2">
                  <Save className="h-4 w-4" />
                  {saving ? "Saving..." : "Save settings"}
                </Button>
                {saveMsg && (
                  <span
                    className="text-[13px]"
                    style={{ color: saveMsg.includes("Failed") || saveMsg.includes("ailed") ? "var(--danger)" : "var(--success)" }}
                  >
                    {saveMsg}
                  </span>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <ModeSwitchModal
        isOpen={showModeWarning}
        onClose={handleCancelDraftWarning}
        onConfirm={handleConfirmDraftWarning}
      />
    </Card>
  );
}