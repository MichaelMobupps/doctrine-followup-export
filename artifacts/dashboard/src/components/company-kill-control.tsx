// company-kill-control.tsx — the company-level destructive "Kill" action plus
// its confirmation dialog. Sibling of prospect-kill-control.tsx.
//
// Company-level Kill hard-stops EVERY doctrine campaign at one company: it
// calls POST /api/admin/company/kill with body
//   { company, confirmCompany, userId? }.
// The server requires confirmCompany to equal company (the user-Kill
// name-match guard, re-used), so the dialog makes the operator re-type the
// company name before the Kill button enables — a deliberate guard because
// this can stop many campaigns at once.
//
// `userId` scopes the kill to the pipeline currently in view (one
// salesperson). Pass null to target every salesperson's campaigns at the
// company.
//
// On success it shows the returned counts and calls onKilled() so the page can
// refresh. On error it shows the message and leaves the list unchanged.

import { useState, useCallback } from "react";
import { Button, Input } from "@/components/ui";
import { useAdmin } from "@/hooks/use-admin";
import { XOctagon, Loader2 } from "lucide-react";
import { BASE_PATH } from "@/lib/app-urls";

// The endpoint's success response shape (POST /api/admin/company/kill).
interface CompanyKillResponse {
  killed: boolean;
  company: string;
  scoped_user_id: number | null;
  campaigns_paused: number;
  followups_cancelled: number;
}

interface CompanyKillControlProps {
  company: string;
  // Pipeline being viewed; scopes the kill to one salesperson. null = all.
  userId: number | null;
  apiKey: string | null;
  // How many campaigns for this company are currently visible, for the dialog
  // copy. Display-only; the server computes the real match set.
  visibleCount?: number;
  // Called after a successful kill so the page can refresh its list.
  onKilled?: () => void;
  // When true the trigger button is disabled (e.g. no API key).
  disabled?: boolean;
}

export function CompanyKillControl({
  company,
  userId,
  apiKey,
  visibleCount,
  onKilled,
  disabled,
}: CompanyKillControlProps) {
  const { adminToken } = useAdmin();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CompanyKillResponse | null>(null);
  const [confirmText, setConfirmText] = useState("");

  const openDialog = useCallback(() => {
    setOpen(true);
    setError(null);
    setResult(null);
    setPending(false);
    setConfirmText("");
  }, []);

  const closeDialog = useCallback(() => {
    setOpen(false);
    setError(null);
    setResult(null);
    setPending(false);
    setConfirmText("");
  }, []);

  const confirmed = confirmText.trim() === company.trim() && company.trim().length > 0;

  const handleKill = useCallback(async () => {
    if (!apiKey) {
      setError("No API key set. Cannot kill these campaigns.");
      return;
    }
    if (!confirmed) return;
    setPending(true);
    setError(null);
    try {
      const base = BASE_PATH;
      const res = await fetch(`${base}api/admin/company/kill`, {
        method: "POST",
        headers: { "x-api-key": apiKey, "x-admin-key": adminToken || "", "Content-Type": "application/json" },
        body: JSON.stringify({
          company,
          confirmCompany: confirmText.trim(),
          ...(userId ? { userId } : {}),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError((body && body.error) || `HTTP ${res.status}`);
      } else {
        setResult(body as CompanyKillResponse);
        onKilled?.();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }, [apiKey, adminToken, company, confirmText, confirmed, userId, onKilled]);

  return (
    <>
      <Button
        variant="destructive"
        size="sm"
        onClick={(e) => { e.stopPropagation(); openDialog(); }}
        disabled={disabled}
        className="gap-1.5"
        title={`Kill every campaign at ${company}: cancel all queued/in-flight follow-ups and stop further sending. Records are kept.`}
      >
        <XOctagon className="h-3.5 w-3.5" />
        Kill all for {company}
      </Button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: "rgba(0,0,0,0.5)" }}
          onClick={() => { if (!pending) closeDialog(); }}
        >
          <div
            className="rounded-lg w-full max-w-[460px] p-5"
            style={{ background: "var(--bg-primary)", border: "1px solid var(--border-default)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 mb-3">
              <XOctagon className="h-5 w-5" style={{ color: "var(--danger)" }} />
              <h2 className="text-[15px] font-semibold" style={{ color: "var(--text-primary)" }}>
                {result ? "Company campaigns killed" : "Kill every campaign at this company"}
              </h2>
            </div>

            {result ? (
              <div>
                <p className="text-[13px] mb-3" style={{ color: "var(--text-secondary)" }}>
                  Hard-stopped every campaign at{" "}
                  <strong style={{ color: "var(--text-primary)" }}>{result.company}</strong>. Every record was kept.
                </p>
                <div
                  className="rounded-lg p-3 mb-3"
                  style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-default)" }}
                >
                  <div className="text-[12px]" style={{ color: "var(--text-primary)" }}>
                    <strong>{result.campaigns_paused}</strong> campaign(s) paused,{" "}
                    <strong>{result.followups_cancelled}</strong> follow-up(s) cancelled.
                  </div>
                </div>
                <p className="text-[11px] mb-4" style={{ color: "var(--text-tertiary)" }}>
                  This is not a one-click undo. Resuming a campaign clears its pause, but it does not
                  un-cancel the cancelled follow-ups.
                </p>
                <div className="flex justify-end">
                  <Button onClick={closeDialog} variant="outline" size="sm">Close</Button>
                </div>
              </div>
            ) : (
              <div>
                <p className="text-[13px] mb-3" style={{ color: "var(--text-secondary)" }}>
                  This cancels all queued and in-flight follow-ups and stops further sending for{" "}
                  <strong style={{ color: "var(--text-primary)" }}>every</strong> campaign at this company
                  {userId ? " in the pipeline you are viewing" : " across all salespeople"}. It keeps every record.
                </p>
                <div
                  className="rounded-lg p-3 mb-4"
                  style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-default)" }}
                >
                  <div className="text-[13px] font-medium" style={{ color: "var(--text-primary)" }}>
                    {company}
                  </div>
                  {typeof visibleCount === "number" && (
                    <div className="text-[12px] mt-0.5" style={{ color: "var(--text-tertiary)" }}>
                      {visibleCount} campaign{visibleCount !== 1 ? "s" : ""} currently visible for this company
                    </div>
                  )}
                </div>

                <label className="block mb-1.5 text-[12px]" style={{ color: "var(--text-secondary)" }}>
                  Type the company name to confirm:
                </label>
                <Input
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  placeholder={company}
                  disabled={pending}
                  className="mb-3 w-full"
                />

                {error && (
                  <div
                    className="rounded-md p-2 mb-3 text-[12px]"
                    style={{ background: "var(--danger-muted)", color: "var(--danger)", border: "1px solid var(--danger-border)" }}
                  >
                    {error}
                  </div>
                )}

                <div className="flex justify-end gap-2">
                  <Button onClick={closeDialog} disabled={pending} variant="outline" size="sm">Cancel</Button>
                  <button
                    type="button"
                    onClick={handleKill}
                    disabled={pending || !confirmed}
                    className="inline-flex items-center justify-center gap-1.5 h-8 px-3 text-[12px] font-medium rounded-md transition-all"
                    style={{
                      background: (pending || !confirmed) ? "var(--bg-tertiary)" : "var(--danger)",
                      border: "1px solid var(--danger)",
                      color: (pending || !confirmed) ? "var(--text-tertiary)" : "var(--danger-foreground, #fff)",
                      cursor: (pending || !confirmed) ? "not-allowed" : "pointer",
                      opacity: (pending || !confirmed) ? 0.7 : 1,
                    }}
                  >
                    {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <XOctagon className="h-3.5 w-3.5" />}
                    {pending ? "Killing…" : "Kill all campaigns"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

export default CompanyKillControl;
