// pipeline-user-picker.tsx — the admin user picker + viewing-as-admin banner
// shared by the doctrine / context / anti-ghosting pipeline pages.
//
// The picker surfaces an already-gated capability: the admin activity list
// (which feeds the manager options) and the prospect-level Kill both require
// the admin token (x-admin-key) on the server, so a caller without it gets a
// 403 no matter what userId they pass. Hiding the picker is therefore NOT the
// security control — it only avoids showing a control a normal manager cannot
// use. We gate the picker's VISIBILITY on real admin status (isAdmin from the
// OAuth exchange): a normal sales manager is not an admin, so the picker never
// renders for them and they always see only their own pipeline.
//
// The parent page owns the `selection` state and the manager `options`, and
// passes both down. The banner name is resolved from the SAME options + the
// SAME selection that drive the page's fetch, so the displayed name cannot lag
// the loaded rows.

import { Select } from "@/components/ui";
import { Eye } from "lucide-react";
import {
  SELF_SELECTION,
  type PickerOption,
  type PickerSelection,
  resolveViewedManagerName,
} from "../../../api-server/src/lib/pipelineUserPicker";

interface PipelineUserPickerProps {
  // Whether the logged-in user is a real admin. The picker renders only when
  // true. (Replaces the prior mere-key-presence gate.)
  isAdmin: boolean;
  // The manager options (id + label), sourced from admin activity.
  options: PickerOption[];
  // Loading flag for the options fetch (disables the dropdown while loading).
  optionsLoading: boolean;
  // Current selection ("self" sentinel or a concrete manager id).
  selection: PickerSelection;
  // Called with the new selection when the dropdown changes.
  onChange: (next: PickerSelection) => void;
}

// The toolbar dropdown. Renders nothing for a non-admin.
export function PipelineUserPicker({
  isAdmin,
  options,
  optionsLoading,
  selection,
  onChange,
}: PipelineUserPickerProps) {
  if (!isAdmin) return null;

  const value = selection === SELF_SELECTION ? SELF_SELECTION : String(selection);

  return (
    <div className="w-56">
      <label
        className="block mb-1.5 font-medium uppercase tracking-[0.04em]"
        style={{ fontSize: "11px", color: "var(--text-tertiary)" }}
      >
        VIEW PIPELINE
      </label>
      <Select
        value={value}
        disabled={optionsLoading}
        onChange={(e) => {
          const v = e.target.value;
          onChange(v === SELF_SELECTION ? SELF_SELECTION : parseInt(v, 10));
        }}
      >
        <option value={SELF_SELECTION}>My pipeline</option>
        {options.map((o) => (
          <option key={o.id} value={String(o.id)}>
            {o.label}
          </option>
        ))}
      </Select>
    </div>
  );
}

interface ViewingAsAdminBannerProps {
  // The current selection.
  selection: PickerSelection;
  // The logged-in user's own id (null while identity resolves).
  currentUserId: number | null;
  // The manager options, used to resolve the displayed name.
  options: PickerOption[];
}

// The persistent, unmistakable banner shown whenever the pipeline is showing a
// manager other than the logged-in user. Renders nothing when viewing self.
export function ViewingAsAdminBanner({
  selection,
  currentUserId,
  options,
}: ViewingAsAdminBannerProps) {
  const name = resolveViewedManagerName(selection, currentUserId, options);
  if (!name) return null;

  return (
    <div
      role="alert"
      className="rounded-lg p-3 flex items-center gap-2.5"
      style={{
        background: "var(--danger-muted, #fde8e8)",
        border: "2px solid var(--danger, #d92d20)",
        color: "var(--danger, #d92d20)",
      }}
    >
      <Eye className="h-4 w-4 flex-shrink-0" />
      <div className="text-[13px] font-semibold">
        Viewing {name}'s pipeline as admin. Actions on these rows affect {name}'s campaigns.
      </div>
    </div>
  );
}