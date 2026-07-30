import React, { useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import { useApiKey } from "@/hooks/use-api-key";
import { useCurrentUser } from "@/hooks/use-current-user";
import { useGetGmailAccounts } from "@workspace/api-client-react";
import { Card, Button, Input } from "@/components/ui";
import {
  Plus,
  Trash2,
  Save,
  ChevronDown,
  ChevronUp,
  Loader2,
} from "lucide-react";

interface StageTiming {
  minDays: number;
  maxDays: number;
}

const DEFAULT_STAGE_TIMING: StageTiming[] = [
  { minDays: 3, maxDays: 7 },
  { minDays: 10, maxDays: 14 },
  { minDays: 21, maxDays: 28 },
];

function ensureStages(existing: StageTiming[], count: number): StageTiming[] {
  const result = [...existing];
  while (result.length < count) {
    const lastMax = result.length > 0 ? result[result.length - 1].maxDays : 0;
    result.push({ minDays: lastMax + 7, maxDays: lastMax + 14 });
  }
  return result.slice(0, count);
}

export default function Accounts() {
  const { apiKey } = useApiKey();
  const { user: currentUser, setUser } = useCurrentUser();
  const queryClient = useQueryClient();
  const requestOpts = { request: { headers: { "x-api-key": apiKey || "" } } };

  const { data, isLoading, refetch } = useGetGmailAccounts({
    ...requestOpts,
    query: { enabled: !!apiKey },
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
      const base = import.meta.env.BASE_URL || "/";
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
      const base = import.meta.env.BASE_URL || "/";
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
      const base = import.meta.env.BASE_URL || "/";
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
        <h1 style={{ fontSize: "20px", fontWeight: 600, letterSpacing: "-0.02em" }}>Accounts</h1>
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
            apiKey={apiKey || ""}
            onSettingsSaved={() => refetch()}
          />
        ))}
      </div>
    </div>
  );
}

function AccountCard({
  account,
  isExpanded,
  onToggle,
  onDisconnect,
  apiKey,
  onSettingsSaved,
}: {
  account: any;
  isExpanded: boolean;
  onToggle: () => void;
  onDisconnect: () => void;
  apiKey: string;
  onSettingsSaved: () => void;
}) {
  const initialMaxFollowups = typeof account.maxFollowups === "number" ? account.maxFollowups : 3;
  const initialStageCount = initialMaxFollowups > 0
    ? initialMaxFollowups
    : Math.max((account.stageTiming || DEFAULT_STAGE_TIMING).length, DEFAULT_STAGE_TIMING.length);
  const [maxFollowups, setMaxFollowups] = useState(initialMaxFollowups);
  const [stageTiming, setStageTiming] = useState<StageTiming[]>(
    ensureStages(account.stageTiming || DEFAULT_STAGE_TIMING, initialStageCount)
  );
  const [sendDays, setSendDays] = useState<number[]>(account.sendDays || [1, 2, 3, 4, 5]);
  const [sendHourStart, setSendHourStart] = useState(account.sendHourStart);
  const [sendHourEnd, setSendHourEnd] = useState(account.sendHourEnd);
  const [doctrineLabel, setDoctrineLabel] = useState(account.doctrineLabel);
  // testMode removed — auto-queue handles all campaigns
  const [requireApproval, setRequireApproval] = useState(account.requireApproval ?? false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");
  const isUnlimitedFollowups = maxFollowups <= 0;
  const displayedStageCount = isUnlimitedFollowups ? stageTiming.length : maxFollowups;

  useEffect(() => {
    if (!isUnlimitedFollowups) {
      setStageTiming((prev) => ensureStages(prev, maxFollowups));
    }
  }, [maxFollowups, isUnlimitedFollowups]);

  const updateStage = (index: number, field: "minDays" | "maxDays", value: number) => {
    const updated = [...stageTiming];
    updated[index] = { ...updated[index], [field]: value };
    setStageTiming(updated);
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveMsg("");
    try {
      const base = import.meta.env.BASE_URL || "/";
      const res = await fetch(`${base}api/gmail/accounts/${account.id}/settings`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
        },
        body: JSON.stringify({
          stageTiming,
          sendDays,
          sendHourStart,
          sendHourEnd,
          maxFollowups,
          doctrineLabel,
          requireApproval,
        }),
      });
      if (!res.ok) throw new Error("Failed to save");
      setSaveMsg("Settings saved");
      onSettingsSaved();
      setTimeout(() => setSaveMsg(""), 3000);
    } catch {
      setSaveMsg("Failed to save settings");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="overflow-hidden">
      <div className="p-5 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="font-semibold text-[13px]" style={{ color: "var(--text-primary)" }}>
                {account.name || account.email}
              </h3>
              {account.isConnected ? (
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
            </div>
            <p className="text-[12px] mt-0.5" style={{ color: "var(--text-secondary)" }}>{account.email}</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
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
              <div className="flex gap-6">
                <label
                  className="flex items-center gap-3 cursor-pointer select-none rounded-lg px-4 py-3"
                  style={{ display: "none", background: false ? "var(--warning-muted)" : "var(--bg-tertiary)", border: `1px solid ${false ? "var(--warning-border)" : "var(--border-default)"}` }}
                >
                  <input
                    type="checkbox"
                    checked={false}
                    onChange={() => {}}
                    className="accent-current"
                    style={{ accentColor: "var(--warning)" }}
                  />
                  <div>
                    <p className="text-[13px] font-medium" style={{ color: "var(--text-primary)" }}>
                      Test Mode
                    </p>
                    <p className="text-[11px]" style={{ color: "var(--text-tertiary)" }}>
                      Uses "followup app test" label, 3 min apart
                    </p>
                  </div>
                </label>

                <label
                  className="flex items-center gap-3 cursor-pointer select-none rounded-lg px-4 py-3"
                  style={{ display: "none", background: requireApproval ? "var(--accent-muted)" : "var(--bg-tertiary)", border: `1px solid ${requireApproval ? "var(--accent-border)" : "var(--border-default)"}` }}
                >
                  <input
                    type="checkbox"
                    checked={requireApproval}
                    onChange={(e) => setRequireApproval(e.target.checked)}
                    className="accent-current"
                    style={{ accentColor: "var(--accent)" }}
                  />
                  <div>
                    <p className="text-[13px] font-medium" style={{ color: requireApproval ? "var(--accent)" : "var(--text-primary)" }}>
                      Pre-Approval
                    </p>
                    <p className="text-[11px]" style={{ color: "var(--text-tertiary)" }}>
                      Review & approve emails before sending
                    </p>
                  </div>
                </label>
              </div>

              <div>
                <label className="block mb-1.5 font-medium uppercase tracking-[0.04em]" style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>
                  GMAIL LABEL
                </label>
                <Input
                  value={doctrineLabel}
                  onChange={(e) => setDoctrineLabel(e.target.value)}
                  placeholder="Doctrine SDR"
                  className="max-w-xs"
                />
                <p className="text-[11px] mt-1" style={{ color: "var(--text-tertiary)" }}>Comma-separated label names to sync</p>
              </div>

              <div>
                <label className="block mb-1.5 font-medium uppercase tracking-[0.04em]" style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>
                  MAX FOLLOW-UPS
                </label>
                <div className="flex items-center gap-3">
                  <Input
                    type="number"
                    min={1}
                    value={isUnlimitedFollowups ? "" : maxFollowups}
                    placeholder={isUnlimitedFollowups ? "Unlimited" : undefined}
                    onChange={(e) => setMaxFollowups(Math.max(1, parseInt(e.target.value) || 1))}
                    className="w-24"
                    disabled={isUnlimitedFollowups}
                  />
                  <label className="flex items-center gap-2 text-[12px]" style={{ color: "var(--text-primary)" }}>
                    <input
                      type="checkbox"
                      checked={isUnlimitedFollowups}
                      onChange={(e) => setMaxFollowups(e.target.checked ? 0 : Math.max(stageTiming.length, 3))}
                    />
                    Unlimited
                  </label>
                </div>
                <p className="text-[11px] mt-1" style={{ color: "var(--text-tertiary)" }}>
                  Unlimited mode keeps auto-queueing new stages. Extra stages beyond the configured timing cards use automatic defaults.
                </p>
              </div>

              <div>
                <label className="block mb-3 font-medium uppercase tracking-[0.04em]" style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>
                  STAGE TIMING ({isUnlimitedFollowups ? `${displayedStageCount}+ stages` : `${displayedStageCount} stages`})
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {stageTiming.map((stage, i) => (
                    <div
                      key={i}
                      className="rounded-lg p-4"
                      style={{ background: "var(--bg-tertiary)", border: "1px solid var(--border-default)" }}
                    >
                      <p className="text-[13px] font-semibold mb-3" style={{ color: "var(--text-primary)" }}>Stage {i + 1}</p>
                      <div className="flex items-center gap-2">
                        <div>
                          <label className="block mb-1 font-medium uppercase tracking-[0.04em]" style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>MIN (days)</label>
                          <Input
                            type="number"
                            min={1}
                            max={365}
                            value={stage.minDays}
                            onChange={(e) => updateStage(i, "minDays", parseInt(e.target.value) || 1)}
                            className="w-16"
                          />
                        </div>
                        <span className="mt-5" style={{ color: "var(--text-tertiary)" }}>{'\u2013'}</span>
                        <div>
                          <label className="block mb-1 font-medium uppercase tracking-[0.04em]" style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>MAX (days)</label>
                          <Input
                            type="number"
                            min={1}
                            max={365}
                            value={stage.maxDays}
                            onChange={(e) => updateStage(i, "maxDays", parseInt(e.target.value) || 1)}
                            className="w-16"
                          />
                        </div>
                      </div>
                      <p className="text-[10px] mt-2" style={{ color: "var(--text-tertiary)" }}>
                        Send {stage.minDays}–{stage.maxDays} days after initial email
                      </p>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <label className="block mb-3 font-medium uppercase tracking-[0.04em]" style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>
                  SEND WINDOW
                </label>

                <div className="mb-4">
                  <p className="text-[11px] mb-2" style={{ color: "var(--text-tertiary)" }}>Send on these days</p>
                  <div className="flex gap-2">
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
                    <label className="block mb-1 font-medium uppercase tracking-[0.04em]" style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>START HOUR</label>
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
                    <label className="block mb-1 font-medium uppercase tracking-[0.04em]" style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>END HOUR</label>
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

              <div className="flex items-center gap-3">
                <Button onClick={handleSave} disabled={saving} className="gap-2">
                  <Save className="h-4 w-4" />
                  {saving ? "Saving..." : "Save settings"}
                </Button>
                {saveMsg && (
                  <span
                    className="text-[13px]"
                    style={{ color: saveMsg.includes("Failed") ? "var(--danger)" : "var(--success)" }}
                  >
                    {saveMsg}
                  </span>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </Card>
  );
}
