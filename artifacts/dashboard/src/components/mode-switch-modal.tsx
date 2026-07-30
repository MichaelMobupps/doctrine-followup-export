import React from "react";
import { Modal, Button } from "@/components/ui";
import { AlertTriangle } from "lucide-react";

interface ModeSwitchModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  confirming?: boolean;
}

/**
 * One-time confirmation modal shown the first time a user switches their
 * follow-up mode to "Draft in Gmail". After acknowledgment the user's
 * `hasSeenDraftModeWarning` flag is flipped TRUE and they will not see
 * this modal again — even if they switch back and then switch to Draft
 * mode a second time.
 *
 * Phase 3c.
 */
export function ModeSwitchModal({ isOpen, onClose, onConfirm, confirming }: ModeSwitchModalProps) {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Switch to Draft in Gmail mode?"
      description="Read this once before continuing — it changes how follow-ups behave."
    >
      <div className="space-y-4 mt-2">
        <div
          className="flex items-start gap-3 p-3 rounded-md"
          style={{
            background: "var(--warning-muted)",
            border: "1px solid var(--warning-border)",
          }}
        >
          <AlertTriangle
            className="h-4 w-4 flex-shrink-0 mt-0.5"
            style={{ color: "var(--warning)" }}
          />
          <div className="text-[13px] leading-relaxed" style={{ color: "var(--text-primary)" }}>
            In Draft mode, follow-ups are <strong>not sent automatically</strong>.
            They are created as Gmail drafts in your account at the scheduled
            time, and you must manually open Gmail and click Send for each one.
          </div>
        </div>

        <div className="space-y-3 text-[13px]" style={{ color: "var(--text-primary)" }}>
          <div>
            <p className="font-medium mb-1" style={{ color: "var(--text-primary)" }}>
              What changes:
            </p>
            <ul className="space-y-1.5 ml-4 list-disc" style={{ color: "var(--text-secondary)" }}>
              <li>Each follow-up is created as a Gmail draft in your Drafts folder.</li>
              <li>Stage timing measures days from your <em>previous manual send</em>, not from the original outreach.</li>
              <li>You will see Drafts in the Pipeline marked with day-counters showing how long they have been sitting.</li>
              <li>If a draft sits unsent for more than 30 days, the campaign for that prospect is automatically stalled.</li>
            </ul>
          </div>

          <div>
            <p className="font-medium mb-1" style={{ color: "var(--text-primary)" }}>
              You can switch back any time:
            </p>
            <p style={{ color: "var(--text-secondary)" }}>
              Returning to Auto-send or Review-in-app affects only future stages — drafts already created stay as drafts in your Gmail until you send or delete them.
            </p>
          </div>
        </div>

        <div className="pt-3 flex gap-3 justify-end" style={{ borderTop: "1px solid var(--border-default)" }}>
          <Button type="button" variant="ghost" onClick={onClose} disabled={confirming}>
            Cancel
          </Button>
          <Button type="button" onClick={onConfirm} isLoading={confirming}>
            I understand — switch to Draft mode
          </Button>
        </div>
      </div>
    </Modal>
  );
}