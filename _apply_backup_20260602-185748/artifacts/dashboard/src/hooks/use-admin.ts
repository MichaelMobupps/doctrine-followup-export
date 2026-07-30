// use-admin.ts — holds the admin grant returned by /auth/exchange.
//
// The OAuth exchange decides admin status from the server-verified email and
// returns { isAdmin, adminToken? }. A normal manager gets isAdmin=false and no
// token; an allowlisted admin gets isAdmin=true and a distinct ADMIN_API_KEY
// as adminToken. We persist both the same way the shared api key is persisted
// (localStorage), exposing them through useAdmin() for the admin UI to gate on
// and to send as the x-admin-key header on every /api/admin/* call.
//
// SECURITY NOTE: this is UI/transport convenience only. The real boundary is
// the server's requireAdmin guard, which checks x-admin-key against
// ADMIN_API_KEY. A manager who flips isAdmin in localStorage still has no
// adminToken, so every admin call 403s. isAdmin gates VISIBILITY; the token
// gates ACCESS.

import { createContext, useContext, useState, useEffect, type ReactNode } from "react";
import React from "react";

interface AdminContextValue {
  isAdmin: boolean;
  adminToken: string | null;
  setAdmin: (grant: { isAdmin: boolean; adminToken?: string | null }) => void;
  clearAdmin: () => void;
  isLoaded: boolean;
}

const ADMIN_TOKEN_KEY = "doctrine_admin_token";
const ADMIN_FLAG_KEY = "doctrine_is_admin";

const AdminContext = createContext<AdminContextValue | null>(null);

export function AdminProvider({ children }: { children: ReactNode }) {
  const [adminToken, setAdminToken] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState<boolean>(false);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    const storedToken = localStorage.getItem(ADMIN_TOKEN_KEY);
    const storedFlag = localStorage.getItem(ADMIN_FLAG_KEY) === "true";
    // Only honour the admin flag when a token is actually present. A flag
    // without a token cannot do anything (every admin call would 403), so we
    // treat that inconsistent state as not-admin.
    if (storedToken && storedFlag) {
      setAdminToken(storedToken);
      setIsAdmin(true);
    }
    setIsLoaded(true);
  }, []);

  const setAdmin = (grant: { isAdmin: boolean; adminToken?: string | null }) => {
    if (grant.isAdmin && grant.adminToken) {
      localStorage.setItem(ADMIN_TOKEN_KEY, grant.adminToken);
      localStorage.setItem(ADMIN_FLAG_KEY, "true");
      setAdminToken(grant.adminToken);
      setIsAdmin(true);
    } else {
      localStorage.removeItem(ADMIN_TOKEN_KEY);
      localStorage.removeItem(ADMIN_FLAG_KEY);
      setAdminToken(null);
      setIsAdmin(false);
    }
  };

  const clearAdmin = () => {
    localStorage.removeItem(ADMIN_TOKEN_KEY);
    localStorage.removeItem(ADMIN_FLAG_KEY);
    setAdminToken(null);
    setIsAdmin(false);
  };

  return React.createElement(
    AdminContext.Provider,
    { value: { isAdmin, adminToken, setAdmin, clearAdmin, isLoaded } },
    children
  );
}

export function useAdmin(): AdminContextValue {
  const ctx = useContext(AdminContext);
  if (!ctx) {
    throw new Error("useAdmin must be used within an AdminProvider");
  }
  return ctx;
}