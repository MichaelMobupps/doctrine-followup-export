// prospect-kill-control.tsx — the per-campaign destructive "Kill" action plus
// its confirmation dialog, shared by the doctrine, context, and anti-ghosting
// pipeline pages.
//
// Prospect-level Kill hard-stops ONE campaign (one prospect). It calls
// POST /api/admin/prospects/:id/kill with body { confirmId: <prospect id> }.
// The id-confirm is what the server requires (a prospect name is not unique),
// so the dialog shows the prospect name + company purely for the human to
// recognise the campaign, and the confirm button sends the prospect id.
//
// On success it shows the returned counts and calls onKilled() so the page can
// refresh. On error it shows the message and leaves the list unchanged.
//
// This component is self-contained: it owns its open/pending/error/result
// state and renders its own overlay dialog (mirroring the admin-activity kill
// dialog style), so a page only needs to drop <ProspectKillControl .../> into
// a campaign row.

import { useState, useCallback } from "react";
import { Button } from "@/components/ui";
import { useAdmin } from "@/hooks/use-admin";
import { XOctagon, Loader2 } from "lucide-react";
import { BASE_PATH } from "@/lib/app-urls";

// The endpoint's success response shape (POST /api/admin/prospects/:id/kill).
interface ProspectKillResponse {
  killed: boolean;
  prospect: { id: number; prospect_name: string; company: string };
  followups_cancelled: number;
  prospect_paused: boolean;
}

interface ProspectKillControlProps {
  prospectId: number;
  prospectName: string;
  company: string;
  apiKey: string | null;
  // Called after a successful kill so the page can refresh its list.
  onKilled?: () => void;
  // When true the trigger button is disabled (e.g. no API key).
  disabled?: boolean;
}

export function ProspectKillControl({
  prospectId,
  prospectName,
  company,
  apiKey,
  onKilled,
  disabled,
}: ProspectKillControlProps) {
  const { adminToken } = useAdmin();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ProspectKillResponse | null>(null);

  const openDialog = useCallback(() => {
    setOpen(true);
    setError(null);
    setResult(null);
    setPending(false);
  }, []);

  const closeDialog = useCallback(() => {
    setOpen(false);
    setError(null);
    setResult(null);
    setPending(false);
  }, []);

  const handleKill = useCallback(async () => {
    if (!apiKey) {
      setError("No API key set. Cannot kill this campaign.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const base = BASE_PATH;
      const res = await fetch(`${base}api/admin/prospects/${prospectId}/kill`, {
        method: "POST",
        headers: { "x-api-key": apiKey, "x-admin-key": adminToken || "", "Content-Type": "application/json" },
        // The server requires confirmId === the path id. Sending the prospect
        // id here is the explicit campaign confirmation.
        body: JSON.stringify({ confirmId: prospectId }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Any error: show the message, leave the list unchanged. The dialog
        // stays open so the admin can read it.
        setError((body && body.error) || `HTTP ${res.status}`);
      } else {
        setResult(body as ProspectKillResponse);
        // Refresh the list so the paused state appears.
        onKilled?.();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }, [apiKey, prospectId, onKilled]);

  const displayName = (prospectName && prospectName.trim()) || `Prospect #${prospectId}`;

  return (
    <>
      {/* Destructive trigger, separated from the pause/resume/restore group so
          it is not hit by accident. */}
      <Button
        variant="destructive"
        size="sm"
        onClick={(e) => { e.stopPropagation(); openDialog(); }}
        disabled={disabled}
        title="Kill this campaign: cancel all queued/in-flight follow-ups and stop further sending. Records are kept."
      >
        <XOctagon className="h-3.5 w-3.5" />
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
                {result ? "Campaign killed" : "Kill this campaign"}
              </h2>
            </div>

            {result ? (
              // Success: show the returned counts.
              <div>
                <p className="text-[13px] mb-3" style={{ color: "var(--text-secondary)" }}>
                  Hard-stopped{" "}
                  <strong style={{ color: "var(--text-primary)" }}>
                    {result.prospect.prospect_name || displayName}
                  </strong>
                  {result.prospect.company ? <> at <strong style={{ color: "var(--text-primary)" }}>{result.prospect.company}</strong></> : null}.
                  Every record was kept.
                </p>
                <div
                  className="rounded-lg p-3 mb-3"
                  style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-default)" }}
                >
                  <div className="text-[12px]" style={{ color: "var(--text-primary)" }}>
                    <strong>{result.followups_cancelled}</strong> follow-up(s) cancelled
                    {result.prospect_paused ? ", campaign paused." : "."}
                  </div>
                </div>
                <p className="text-[11px] mb-4" style={{ color: "var(--text-tertiary)" }}>
                  This is not a one-click undo. Resuming the campaign clears the pause, but it does not
                  un-cancel the cancelled follow-ups.
                </p>
                <div className="flex justify-end">
                  <Button onClick={closeDialog} variant="outline" size="sm">Close</Button>
                </div>
              </div>
            ) : (
              <div>
                <p className="text-[13px] mb-3" style={{ color: "var(--text-secondary)" }}>
                  This cancels all queued and in-flight follow-ups for this one campaign and stops any
                  further follow-ups. It keeps every record. It does not affect this salesperson's other
                  campaigns.
                </p>
                <div
                  className="rounded-lg p-3 mb-4"
                  style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-default)" }}
                >
                  <div className="text-[13px] font-medium" style={{ color: "var(--text-primary)" }}>
                    {displayName}
                  </div>
                  {company && company.trim() && (
                    <div className="text-[12px] mt-0.5" style={{ color: "var(--text-tertiary)" }}>
                      {company}
                    </div>
                  )}
                  <div className="text-[11px] mt-1 font-mono" style={{ color: "var(--text-tertiary)" }}>
                    Campaign #{prospectId}
                  </div>
                </div>

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
                    disabled={pending}
                    className="inline-flex items-center justify-center gap-1.5 h-8 px-3 text-[12px] font-medium rounded-md transition-all"
                    style={{
                      background: pending ? "var(--bg-tertiary)" : "var(--danger)",
                      border: "1px solid var(--danger)",
                      color: pending ? "var(--text-tertiary)" : "var(--danger-foreground, #fff)",
                      cursor: pending ? "not-allowed" : "pointer",
                      opacity: pending ? 0.7 : 1,
                    }}
                  >
                    {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <XOctagon className="h-3.5 w-3.5" />}
                    {pending ? "Killing…" : "Kill campaign"}
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

export default ProspectKillControl;