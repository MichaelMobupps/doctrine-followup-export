import React, { useEffect } from "react";
import { useLocation } from "wouter";
import { Workflow, MessageSquare, ArrowRight } from "lucide-react";

const STORAGE_KEY = "doctrine.lastProduct";

/**
 * Product picker. Three cards (Sales Doctrine, Context Based, AntiGhosting).
 * Remembers the last choice in localStorage so the next visit can
 * deep-link the user back to their last product.
 *
 * Phase 7d shipped the doctrine/context split as `/picker`. B9b.1 adds the
 * third option — AntiGhosting Followuper — which re-engages threads that
 * went quiet mid-conversation.
 */
export default function Picker() {
  const [, navigate] = useLocation();

  useEffect(() => {
    // No auto-redirect — the user explicitly requested the picker by
    // navigating to /picker. Auto-redirecting would defeat the point.
  }, []);

  const choose = (product: "doctrine" | "context" | "anti_ghosting") => {
    try { localStorage.setItem(STORAGE_KEY, product); } catch {}
    if (product === "doctrine") navigate("/");
    else if (product === "context") navigate("/context/pipeline");
    else navigate("/anti-ghosting");
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-[70vh] py-12">
      <div className="text-center mb-10">
        <h1 className="text-2xl font-semibold tracking-tight mb-2" style={{ color: "var(--text-primary)" }}>
          Choose a follow-up flow
        </h1>
        <p className="text-[14px]" style={{ color: "var(--text-secondary)" }}>
          Three flows share the same engine. Pick the one you want to work in.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-5 max-w-5xl w-full">
        {/* Doctrine card */}
        <button
          onClick={() => choose("doctrine")}
          className="text-left rounded-lg p-6 transition-all duration-200 group"
          style={{
            background: "var(--bg-secondary)",
            border: "1px solid var(--border-default)",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = "rgba(59,130,246,0.40)";
            e.currentTarget.style.background = "var(--bg-tertiary)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = "var(--border-default)";
            e.currentTarget.style.background = "var(--bg-secondary)";
          }}
        >
          <div
            className="w-10 h-10 rounded-md flex items-center justify-center mb-4"
            style={{ background: "rgba(59,130,246,0.10)", color: "#3b82f6" }}
          >
            <Workflow className="w-5 h-5" strokeWidth={1.75} />
          </div>
          <h2 className="text-[16px] font-semibold tracking-tight mb-2" style={{ color: "var(--text-primary)" }}>
            Sales Doctrine Followuper
          </h2>
          <p className="text-[13px] leading-relaxed mb-5" style={{ color: "var(--text-secondary)" }}>
            Outbound SDR flow. Structured doctrine framework, verticals, MAFO positioning,
            multi-stage cadence. Best for cold outreach to publishers and advertisers.
          </p>
          <div className="flex items-center gap-1.5 text-[13px] font-medium" style={{ color: "#3b82f6" }}>
            Open Doctrine
            <ArrowRight className="w-4 h-4 transition-transform duration-200 group-hover:translate-x-0.5" strokeWidth={2} />
          </div>
        </button>

        {/* Context card */}
        <button
          onClick={() => choose("context")}
          className="text-left rounded-lg p-6 transition-all duration-200 group"
          style={{
            background: "var(--bg-secondary)",
            border: "1px solid var(--border-default)",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = "rgba(245,158,11,0.40)";
            e.currentTarget.style.background = "var(--bg-tertiary)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = "var(--border-default)";
            e.currentTarget.style.background = "var(--bg-secondary)";
          }}
        >
          <div
            className="w-10 h-10 rounded-md flex items-center justify-center mb-4"
            style={{ background: "rgba(245,158,11,0.10)", color: "#f59e0b" }}
          >
            <MessageSquare className="w-5 h-5" strokeWidth={1.75} />
          </div>
          <h2 className="text-[16px] font-semibold tracking-tight mb-2" style={{ color: "var(--text-primary)" }}>
            Context Based Followuper
          </h2>
          <p className="text-[13px] leading-relaxed mb-5" style={{ color: "var(--text-secondary)" }}>
            Reply-driven flow. Drafts a short, context-faithful follow-up from any labelled
            email thread. No marketing layer, no doctrine — tone, language, and content
            mirror the original conversation.
          </p>
          <div className="flex items-center gap-1.5 text-[13px] font-medium" style={{ color: "#f59e0b" }}>
            Open Context
            <ArrowRight className="w-4 h-4 transition-transform duration-200 group-hover:translate-x-0.5" strokeWidth={2} />
          </div>
        </button>

        {/* AntiGhosting card — B9b.1 */}
        <button
          onClick={() => choose("anti_ghosting")}
          className="text-left rounded-lg p-6 transition-all duration-200 group"
          style={{
            background: "var(--bg-secondary)",
            border: "1px solid var(--border-default)",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = "rgba(6,182,212,0.40)";
            e.currentTarget.style.background = "var(--bg-tertiary)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = "var(--border-default)";
            e.currentTarget.style.background = "var(--bg-secondary)";
          }}
        >
          <div
            className="w-10 h-10 rounded-md flex items-center justify-center mb-4"
            style={{ background: "rgba(6,182,212,0.10)" }}
          >
            <AntiGhostingMark className="w-7 h-7" />
          </div>
          <h2 className="text-[16px] font-semibold tracking-tight mb-2" style={{ color: "var(--text-primary)" }}>
            Anti-Ghosting Followuper
          </h2>
          <p className="text-[13px] leading-relaxed mb-5" style={{ color: "var(--text-secondary)" }}>
            Re-engagement flow. Surfaces conversations that went quiet mid-thread and drafts
            a follow-up that acknowledges, bridges, and asks one clear next step. Mark a
            tagged Gmail thread, the system handles the cadence.
          </p>
          <div className="flex items-center gap-1.5 text-[13px] font-medium" style={{ color: "#06b6d4" }}>
            Open Anti-Ghosting
            <ArrowRight className="w-4 h-4 transition-transform duration-200 group-hover:translate-x-0.5" strokeWidth={2} />
          </div>
        </button>
      </div>
    </div>
  );
}

// Inline glyph-only logo for the picker tile. See dashboard/assets/
// anti-ghosting-mark.svg for the standalone file version.
function AntiGhostingMark({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 140 140" role="img" aria-label="Anti-Ghosting Followuper" className={className}>
      <defs>
        <linearGradient id="agPickerGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#6db4ff" />
          <stop offset="100%" stopColor="#3b82f6" />
        </linearGradient>
      </defs>
      <g transform="translate(70, 70)">
        <circle cx="0" cy="0" r="62" fill="none" stroke="url(#agPickerGrad)" strokeWidth="11" strokeLinecap="round" strokeDasharray="305 1000" transform="rotate(-30)" />
        <polygon points="56,-32 76,-24 64,-6" fill="#3b82f6" />
        <path d="M -70 28 L -56 18 L -48 42 Z" fill="url(#agPickerGrad)" />
        <g stroke="#6db4ff" strokeWidth="2.5" strokeLinecap="round">
          <line x1="56" y1="-62" x2="62" y2="-70" />
          <line x1="66" y1="-54" x2="76" y2="-58" />
          <line x1="46" y1="-74" x2="50" y2="-83" />
        </g>
        <path d="M -27 -34 C -27 -54, 27 -54, 27 -34 L 27 24 L 18 34 L 8 24 L -2 34 L -12 24 L -22 34 L -27 24 Z" fill="#ffffff" />
        <circle cx="-10" cy="-14" r="2.8" fill="#0a0b0d" />
        <circle cx="11" cy="-14" r="2.8" fill="#0a0b0d" />
        <path d="M -7 -3 Q 1 4 8 -3" fill="none" stroke="#0a0b0d" strokeWidth="1.6" strokeLinecap="round" />
        <path d="M 27 -6 C 37 -4, 40 5, 33 11 C 30 6, 28 3, 27 0 Z" fill="#ffffff" />
      </g>
    </svg>
  );
}
