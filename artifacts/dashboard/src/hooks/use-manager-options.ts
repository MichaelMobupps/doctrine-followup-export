// use-manager-options.ts — fetch the list of sales managers for the admin
// pipeline user picker, ONCE, from the existing admin activity endpoint.
//
// The picker only needs id + name pairs. The admin activity payload carries a
// `users` array of { id, email, name, ... }; we fetch it once when the user is
// a real admin and map it to PickerOption[] via the shared (unit-tested)
// helper. We deliberately do NOT add an endpoint — this reuses
// GET /api/admin/activity, now gated on the admin token (x-admin-key).
//
// A normal sales manager is not an admin and holds no admin token, so this
// never fetches for them and the picker never renders.

import { useState, useEffect } from "react";
import { useAdmin } from "@/hooks/use-admin";
import {
  mapActivityUsersToPickerOptions,
  type PickerOption,
  type ActivityUserLike,
} from "../../../api-server/src/lib/pipelineUserPicker";
import { BASE_PATH } from "@/lib/app-urls";

interface ManagerOptionsState {
  options: PickerOption[];
  loading: boolean;
  error: string | null;
}

export function useManagerOptions(apiKey: string | null): ManagerOptionsState {
  const { isAdmin, adminToken } = useAdmin();
  const [state, setState] = useState<ManagerOptionsState>({
    options: [],
    loading: false,
    error: null,
  });

  useEffect(() => {
    // Only an admin holding the admin token can list managers; the activity
    // endpoint now requires x-admin-key. For everyone else, no fetch, no
    // options (and the picker stays hidden).
    if (!apiKey || !isAdmin || !adminToken) {
      setState({ options: [], loading: false, error: null });
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));

    const base = BASE_PATH;
    fetch(`${base}api/admin/activity`, {
      headers: { "x-api-key": apiKey, "x-admin-key": adminToken },
    })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data: { users?: ActivityUserLike[] }) => {
        if (cancelled) return;
        const options = mapActivityUsersToPickerOptions(data?.users);
        setState({ options, loading: false, error: null });
      })
      .catch((err) => {
        if (cancelled) return;
        setState({
          options: [],
          loading: false,
          error: err instanceof Error ? err.message : "Failed to load managers",
        });
      });

    return () => {
      cancelled = true;
    };
  }, [apiKey, isAdmin, adminToken]);

  return state;
}