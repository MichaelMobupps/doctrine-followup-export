import React, { useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
// B7t: BarChart3 import for the Admin Activity nav entry.
import { Eye, LogOut, Workflow, Radio, Activity, Settings as SettingsIcon, ArrowLeftRight, BarChart3 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useApiKey } from "@/hooks/use-api-key";
import { useCurrentUser } from "@/hooks/use-current-user";

interface LayoutProps {
  children: React.ReactNode;
}

export function Layout({ children }: LayoutProps) {
  const [location] = useLocation();
  // Phase 7d: derive product scope from URL. /context/* → context (amber theme),
  // anything else → doctrine (blue, default). The picker route renders inside
  // the doctrine theme since localStorage is not yet read here.
  const onContext = location.startsWith("/context");
  // B9b.8.2: AntiGhosting is the third product alongside Doctrine and Context.
  const onAntiGhosting = location.startsWith("/anti-ghosting");
  const dataProduct = onAntiGhosting ? "anti_ghosting" : onContext ? "context" : "doctrine";
  const brandLabel = onAntiGhosting ? "AntiGhosting" : onContext ? "Context Based" : "Doctrine AI";
  const { apiKey, clearApiKey } = useApiKey();
  const { user: currentUser, clearUser } = useCurrentUser();
  const [activity, setActivity] = useState<{ queued: number; next_due: string | null } | null>(null);

  // Poll activity status every 30s.
  // Phase 7i: URL switches based on onContext so the sidebar indicator
  // shows the right product's queue numbers. `onContext` is in the
  // deps so the effect re-fires immediately on product switch (instead
  // of waiting up to 30s for the next interval tick).
  useEffect(() => {
    if (!apiKey || !currentUser?.userId) return;
    // B9b.13: AG activity endpoint now exists; include it in the routing.
    const activityPath = onAntiGhosting
      ? "api/anti-ghosting/my/activity"
      : onContext
      ? "api/context/my/activity"
      : "api/my/activity";
    const fetchActivity = async () => {
      try {
        const base = import.meta.env.BASE_URL || "/";
        const res = await fetch(`${base}${activityPath}?userId=${currentUser.userId}`, {
          headers: { "x-api-key": apiKey },
        });
        if (res.ok) setActivity(await res.json());
      } catch {}
    };
    fetchActivity();
    const interval = setInterval(fetchActivity, 30000);
    return () => clearInterval(interval);
  }, [apiKey, currentUser?.userId, onContext, onAntiGhosting]);

  const handleLogout = () => {
    clearUser();
    clearApiKey();
  };

  // Phase 7d: nav items target the active product's URL family.
  const navItems = onAntiGhosting
    ? [
        // B9b.8.2 + B9b.12: AntiGhosting nav. Workflow icon reused for
        // Candidates and Pipeline; Eye icon (matching context inspector)
        // for the Email Inspector.
        { name: "Candidates", href: "/anti-ghosting", icon: Workflow },
        { name: "Pipeline", href: "/anti-ghosting/pipeline", icon: Workflow },
        { name: "Email Inspector", href: "/anti-ghosting/inspector", icon: Eye },
        { name: "Activity Log", href: "/anti-ghosting/activity", icon: Activity },
        // AG-scoped cost ledger (shared AdminActivity locked to anti_ghosting).
        { name: "Admin Activity", href: "/anti-ghosting/admin-activity", icon: BarChart3 },
      ]
    : onContext
    ? [
        { name: "Pipeline", href: "/context/pipeline", icon: Workflow },
        { name: "Email Inspector", href: "/context/inspector", icon: Eye },
        { name: "Activity Log", href: "/context/activity", icon: Activity },
        // B7t: nav context admin-activity. Same URL as doctrine since the
        // page itself is cross-product (filter shows both apps).
        { name: "Admin Activity", href: "/admin-activity", icon: BarChart3 },
      ]
    : [
        { name: "Pipeline", href: "/", icon: Workflow },
        { name: "Email Inspector", href: "/inspector", icon: Eye },
        { name: "Activity Log", href: "/activity", icon: Activity },
        // B7t: nav doctrine admin-activity. Cross-product LLM cost ledger.
        { name: "Admin Activity", href: "/admin-activity", icon: BarChart3 },
      ];

  const isSettingsActive = location === "/accounts";

  return (
    <div className="flex min-h-screen w-full" data-product={dataProduct}>
      <aside
        className="w-[220px] flex-shrink-0 flex flex-col fixed top-0 left-0 h-screen z-20"
        style={{ background: "var(--bg-secondary)", borderRight: "1px solid var(--border-default)" }}
      >
        <div className="px-5 py-5 flex items-center gap-2.5">
          <span
            className="font-semibold tracking-tight"
            style={{ fontSize: "14px", letterSpacing: "-0.01em", color: "var(--text-primary)" }}
          >
            {brandLabel}
          </span>
        </div>

        <nav className="flex-1 px-3 py-1 space-y-0.5">
          {navItems.map((item) => {
            const isActive = location === item.href;
            return (
              <Link key={item.href} href={item.href} className="block">
                {/* B9d.10: active nav item gets accent-tinted treatment. */}
                <div
                  className={cn(
                    "flex items-center gap-2.5 px-3 py-2.5 rounded-md text-[13px] transition-all duration-200 border",
                    isActive
                      ? "font-semibold text-[var(--accent)] bg-[var(--accent-muted)] border-[var(--accent-border)]"
                      : "font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] border-transparent"
                  )}
                >
                  <item.icon
                    className="h-4 w-4"
                    style={{ color: isActive ? "var(--accent)" : "var(--text-secondary)" }}
                    strokeWidth={1.5}
                  />
                  {item.name}
                </div>
              </Link>
            );
          })}
        </nav>

        <div className="p-3 mt-auto space-y-2">
          {/* Promoted Settings entry — visually separated, accent treatment */}
          <Link href="/accounts" className="block">
            <div
              className="flex items-center gap-2.5 px-3 py-3 rounded-md text-[13px] font-semibold transition-all duration-150"
              style={{
                background: isSettingsActive ? "var(--accent-muted)" : "var(--bg-tertiary)",
                border: `1px solid ${isSettingsActive ? "var(--accent-border)" : "var(--border-default)"}`,
                color: isSettingsActive ? "var(--accent)" : "var(--text-primary)",
              }}
            >
              <SettingsIcon className="h-4 w-4" strokeWidth={1.75} />
              Settings
            </div>
          </Link>

          {/* Live activity indicator */}
          <div
            className="rounded-lg p-3"
            style={{ background: "var(--bg-tertiary)", border: "1px solid var(--border-default)" }}
          >
            <div className="flex items-center gap-2 mb-1.5">
              <div style={{ position: "relative" }}>
                <Radio className="h-3.5 w-3.5" style={{ color: "var(--success)" }} strokeWidth={1.5} />
                <div
                  style={{
                    position: "absolute", top: 0, left: 0, width: "14px", height: "14px",
                    borderRadius: "50%", background: "var(--success)", opacity: 0.3,
                    animation: "pulse 2s ease-in-out infinite",
                  }}
                />
              </div>
              <p className="text-[11px] font-medium uppercase tracking-[0.04em]" style={{ color: "var(--success)" }}>
                Auto-detecting
              </p>
            </div>
            {currentUser?.email && (
              <p className="text-[11px] truncate mb-1" style={{ color: "var(--text-secondary)" }}>
                {currentUser.email}
              </p>
            )}
            {activity && (
              <div className="text-[10px] space-y-0.5" style={{ color: "var(--text-tertiary)" }}>
                {activity.queued > 0 && (
                  <p>{activity.queued} followup{activity.queued !== 1 ? "s" : ""} queued</p>
                )}
                {activity.queued === 0 && (
                  <p>All caught up</p>
                )}
              </div>
            )}
          </div>

          {/* Phase 7d: Switch product — flips between Doctrine and Context. */}
          <Link href="/picker" className="block">
            <div
              className="flex items-center gap-2.5 px-3 py-2 rounded-md text-[12px] font-medium transition-all duration-150"
              style={{ color: "var(--text-secondary)" }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = "var(--text-primary)";
                e.currentTarget.style.background = "var(--bg-tertiary)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = "var(--text-secondary)";
                e.currentTarget.style.background = "transparent";
              }}
            >
              <ArrowLeftRight className="h-3.5 w-3.5" strokeWidth={1.5} />
              Switch product
            </div>
          </Link>

          <button
            onClick={handleLogout}
            className="flex w-full items-center gap-2.5 px-3 py-2.5 rounded-md text-[13px] font-medium transition-all duration-150"
            style={{ color: "var(--text-tertiary)" }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = "var(--danger)";
              e.currentTarget.style.background = "var(--danger-muted)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = "var(--text-tertiary)";
              e.currentTarget.style.background = "transparent";
            }}
          >
            <LogOut className="h-4 w-4" strokeWidth={1.5} />
            Sign out
          </button>
        </div>
      </aside>

      <main className="flex-1 ml-[220px]" style={{ background: "var(--bg-primary)" }}>
        <div className="p-8 max-w-[1100px]">
          {children}
        </div>
      </main>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 0.3; transform: scale(1); }
          50% { opacity: 0.6; transform: scale(1.4); }
        }
      `}</style>
    </div>
  );
}
