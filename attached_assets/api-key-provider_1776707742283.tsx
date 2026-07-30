import React, { useState, useEffect } from "react";
import { useApiKey } from "@/hooks/use-api-key";
import { useCurrentUser } from "@/hooks/use-current-user";
import { Card } from "@/components/ui";
import { Loader2 } from "lucide-react";
import { motion } from "framer-motion";

export function ApiKeyGate({ children }: { children: React.ReactNode }) {
  const { apiKey, setApiKey, isLoaded } = useApiKey();
  const { user: currentUser, setUser } = useCurrentUser();
  const [error, setError] = useState<string | null>(null);
  const [exchanging, setExchanging] = useState(false);
  const [resolving, setResolving] = useState(false);

  // Handle login code exchange (new login flow)
  useEffect(() => {
    if (!isLoaded) return;
    const params = new URLSearchParams(window.location.search);

    const loginCode = params.get("login_code");
    if (loginCode) {
      window.history.replaceState({}, "", window.location.pathname);
      setExchanging(true);
      const base = import.meta.env.BASE_URL || "/";
      fetch(`${base}api/auth/exchange`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: loginCode }),
      })
        .then((res) => res.json())
        .then((data) => {
          if (data.token) {
            setApiKey(data.token);
            localStorage.setItem("doctrine_user_email", data.email || "");
            const base2 = import.meta.env.BASE_URL || "/";
            fetch(`${base2}api/gmail/accounts`, { headers: { "x-api-key": data.token } })
              .then(r => r.json())
              .then(accts => {
                const me = (accts.accounts || []).find((a: any) => a.email.toLowerCase() === (data.email || "").toLowerCase());
                setUser({ email: data.email || "", userId: me?.id || null, name: me?.name || data.email || "" });
              })
              .catch(() => setUser({ email: data.email || "", userId: null, name: data.email || "" }));
          } else {
            setError(data.error || "Login failed");
          }
          setExchanging(false);
        })
        .catch(() => {
          setError("Could not verify login");
          setExchanging(false);
        });
      return;
    }

    const loginError = params.get("login_error");
    if (loginError) {
      window.history.replaceState({}, "", window.location.pathname);
      const messages: Record<string, string> = {
        denied: "Sign-in was cancelled",
        expired: "Login session expired. Please try again.",
        no_email: "Could not get email from Google",
        failed: "Login failed. Please try again.",
        missing_params: "Login failed. Please try again.",
        unauthorized_domain: "Access restricted. Only company accounts are permitted to sign in.",
      };
      setError(messages[loginError] || "Login failed");
    }
  }, [isLoaded]);

  // Auto-resolve: when apiKey exists but currentUser is missing, look up identity
  useEffect(() => {
    if (!apiKey || !isLoaded || currentUser?.userId || resolving || exchanging) return;

    setResolving(true);
    const base = import.meta.env.BASE_URL || "/";
    fetch(`${base}api/gmail/accounts`, { headers: { "x-api-key": apiKey } })
      .then(r => r.json())
      .then(data => {
        const accounts = data.accounts || [];
        if (accounts.length === 0) {
          setResolving(false);
          return;
        }

        const storedEmail = localStorage.getItem("doctrine_user_email");
        let me = storedEmail
          ? accounts.find((a: any) => a.email.toLowerCase() === storedEmail.toLowerCase())
          : null;

        if (!me && accounts.length === 1) {
          me = accounts[0];
        }

        if (me) {
          localStorage.setItem("doctrine_user_email", me.email);
          setUser({ email: me.email, userId: me.id, name: me.name || me.email });
        } else if (storedEmail) {
          setUser({ email: storedEmail, userId: null, name: storedEmail });
        }
        setResolving(false);
      })
      .catch(() => {
        setResolving(false);
      });
  }, [apiKey, isLoaded, currentUser?.userId, exchanging]);

  if (!isLoaded || exchanging || resolving) {
    return (
      <div
        className="min-h-screen w-full flex items-center justify-center"
        style={{ background: "var(--bg-primary)" }}
      >
        <Loader2 className="h-6 w-6 animate-spin" style={{ color: "var(--accent)" }} />
      </div>
    );
  }

  const handleGoogleLogin = async () => {
    setError(null);
    try {
      const base = import.meta.env.BASE_URL || "/";
      const res = await fetch(`${base}api/auth/google`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to start login");
      window.location.href = data.authUrl;
    } catch (err: any) {
      setError(err.message || "Could not connect to server");
    }
  };

  if (!apiKey) {
    return (
      <div
        className="min-h-screen w-full flex items-center justify-center"
        style={{ background: "var(--bg-primary)" }}
      >
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
          className="w-full max-w-sm px-4"
        >
          <Card className="p-8">
            <div className="flex flex-col items-center text-center mb-6">
              <div
                className="h-12 w-12 rounded-lg flex items-center justify-center mb-5"
                style={{ background: "var(--bg-tertiary)" }}
              >
                <svg width="24" height="24" viewBox="0 0 24 24">
                  <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
                  <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                  <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                  <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
                </svg>
              </div>
              <h1 className="font-semibold mb-1" style={{ fontSize: "20px", letterSpacing: "-0.02em" }}>
                Doctrine AI
              </h1>
              <p className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
                Sign in with your Google account to continue.
              </p>
            </div>

            {error && (
              <p className="text-[12px] text-center mb-4" style={{ color: "var(--danger)" }}>
                {error}
              </p>
            )}

            <button
              onClick={handleGoogleLogin}
              className="w-full h-10 rounded-md flex items-center justify-center gap-3 text-[14px] font-medium transition-colors duration-150"
              style={{
                background: "#fff",
                color: "#1f1f1f",
                border: "1px solid #dadce0",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "#f8f9fa"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "#fff"; }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
              </svg>
              Sign in with Google
            </button>
          </Card>
        </motion.div>
      </div>
    );
  }

  return <>{children}</>;
}
