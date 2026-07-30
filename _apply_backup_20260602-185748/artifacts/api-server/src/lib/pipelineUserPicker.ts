// pipelineUserPicker.ts — pure, dependency-free helpers for the admin
// pipeline user picker (doctrine / context / anti-ghosting pipeline pages).
//
// The picker lets an admin (anyone holding the API key) view another sales
// manager's campaigns inside the existing pipeline pages and act on specific
// ones. These helpers carry the only non-trivial logic: mapping the admin
// activity payload's user list into dropdown options, resolving the effective
// userId to send to the list endpoints, and resolving whether/which manager
// the viewing-as-admin banner should name.
//
// They are intentionally free of any React / DB / network import so they can
// be unit-tested hermetically under api-server/src/tests (the only test gate),
// while still being imported by the dashboard via a relative path.

// The shape of a user row as returned by GET /api/admin/activity (`users`).
// `name` may be null in the database, so it is optional/nullable here.
export interface ActivityUserLike {
  id: number;
  email: string;
  name?: string | null;
}

// One option in the picker dropdown.
export interface PickerOption {
  id: number;
  label: string;
}

// Sentinel selection meaning "my pipeline" — show the logged-in user's own
// campaigns (the default, current behaviour).
export const SELF_SELECTION = "self" as const;
export type SelfSelection = typeof SELF_SELECTION;

// The picker's selection is either the SELF sentinel or a concrete user id.
export type PickerSelection = SelfSelection | number;

// Human label for a user: trimmed name, falling back to the email when the
// name is missing/blank.
export function userDisplayLabel(name: string | null | undefined, email: string): string {
  const trimmed = (name ?? "").trim();
  if (trimmed) return trimmed;
  return (email ?? "").trim();
}

// Map the admin activity payload's `users` array into picker options.
// - Tolerates null/undefined/non-array input (returns []).
// - Skips entries without a finite numeric id.
// - De-dupes by id (first occurrence wins).
// - Sorts by label for a stable, readable dropdown.
export function mapActivityUsersToPickerOptions(
  users: ReadonlyArray<ActivityUserLike> | null | undefined,
): PickerOption[] {
  if (!Array.isArray(users)) return [];
  const seen = new Set<number>();
  const options: PickerOption[] = [];
  for (const u of users) {
    if (!u || typeof u.id !== "number" || !Number.isFinite(u.id)) continue;
    if (seen.has(u.id)) continue;
    seen.add(u.id);
    options.push({ id: u.id, label: userDisplayLabel(u.name, u.email) });
  }
  options.sort((a, b) => a.label.localeCompare(b.label));
  return options;
}

// Resolve the effective userId to send into the list call. When the selection
// is SELF (or — defensively — equals the current user), the effective id is
// the current user's own id, i.e. the existing behaviour. Otherwise it is the
// selected manager's id.
//
// Returns null only when SELF is selected and there is no current user id yet
// (identity still resolving); callers treat null as "omit the userId param",
// which is exactly the pre-feature behaviour.
export function resolveEffectiveUserId(
  selection: PickerSelection,
  currentUserId: number | null,
): number | null {
  if (selection === SELF_SELECTION) return currentUserId;
  return selection;
}

// True when the view is another manager's pipeline (banner must be shown).
// SELF is never "other". A concrete id equal to the current user is also not
// "other" (covers the case where the admin is itself a manager and the picker
// happens to hold their own id).
export function isViewingOther(
  selection: PickerSelection,
  currentUserId: number | null,
): boolean {
  if (selection === SELF_SELECTION) return false;
  return selection !== currentUserId;
}

// The manager name the viewing-as-admin banner should display, or null when
// viewing self (no banner). The name is resolved from the SAME options list
// that drives the picker and the SAME selection that drives the fetch, so it
// cannot lag the loaded rows. If the selected id is not found in options
// (e.g. options not loaded yet), returns a stable fallback so the banner still
// makes clear another pipeline is in view.
export function resolveViewedManagerName(
  selection: PickerSelection,
  currentUserId: number | null,
  options: ReadonlyArray<PickerOption>,
): string | null {
  if (!isViewingOther(selection, currentUserId)) return null;
  const match = options.find((o) => o.id === selection);
  if (match) return match.label;
  return `manager #${selection}`;
}