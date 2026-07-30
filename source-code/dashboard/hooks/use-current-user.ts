import { createContext, useContext, useState, useEffect, type ReactNode } from "react";
import React from "react";

interface CurrentUser {
  email: string;
  userId: number | null;
  name: string;
}

// 2026-07-16 main-screen-hang fix: how the logged-in email resolved against
// the connected Gmail accounts list. Pipeline pages use this to decide
// whether a null userId means "legacy single-user install → unfiltered list
// is fine" or "this login has no connected account → do NOT issue the
// unfiltered all-users fetch" (which returned every user's follow-ups with
// full email bodies and froze the tab + server).
//  - "unknown":   resolution has not completed yet (or not needed).
//  - "matched":   the login email matched a connected account (userId set).
//  - "unmatched": accounts exist but none matches this login email.
//  - "legacy":    no connected accounts at all (env-var single-user mode).
export type IdentityStatus = "unknown" | "matched" | "unmatched" | "legacy";

interface CurrentUserContextValue {
  user: CurrentUser | null;
  setUser: (user: CurrentUser) => void;
  clearUser: () => void;
  isLoaded: boolean;
  identityStatus: IdentityStatus;
  setIdentityStatus: (status: IdentityStatus) => void;
}

const CurrentUserContext = createContext<CurrentUserContextValue | null>(null);

export function CurrentUserProvider({ children }: { children: ReactNode }) {
  const [user, setUserValue] = useState<CurrentUser | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const [identityStatus, setIdentityStatus] = useState<IdentityStatus>("unknown");

  useEffect(() => {
    const stored = localStorage.getItem("doctrine_current_user");
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        setUserValue(parsed);
        // A stored concrete userId is a previously verified account match;
        // null/absent stays "unknown" until ApiKeyGate re-resolves it.
        if (parsed && typeof parsed.userId === "number") {
          setIdentityStatus("matched");
        }
      } catch {}
    }
    setIsLoaded(true);
  }, []);

  const setUser = (u: CurrentUser) => {
    localStorage.setItem("doctrine_current_user", JSON.stringify(u));
    setUserValue(u);
    if (typeof u.userId === "number") setIdentityStatus("matched");
  };

  const clearUser = () => {
    localStorage.removeItem("doctrine_current_user");
    setUserValue(null);
    setIdentityStatus("unknown");
  };

  return React.createElement(
    CurrentUserContext.Provider,
    { value: { user, setUser, clearUser, isLoaded, identityStatus, setIdentityStatus } },
    children
  );
}

export function useCurrentUser(): CurrentUserContextValue {
  const ctx = useContext(CurrentUserContext);
  if (!ctx) {
    throw new Error("useCurrentUser must be used within a CurrentUserProvider");
  }
  return ctx;
}
