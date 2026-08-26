/**
 * B9b.1: AntiGhosting marking UI.
 *
 * Single page surface for the third product. Lists Gmail threads tagged
 * with the user's "AntiGhosting Followuper" label that haven't been
 * marked yet, runs validator preview (most-recent-outbound, has-inbound,
 * not-in-followups), and lets the operator mark a candidate with one
 * click. F1 schedules automatically; later stages dispatch via the
 * scheduler + B9c.2 generator pipeline.
 *
 * Auth pattern mirrors the other product pages (useApiKey + useCurrentUser
 * with the email passed to the endpoint). Cyan #06b6d4 is the product
 * accent so the page reads as distinct from Doctrine blue / Context amber.
 */

import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useApiKey } from "@/hooks/use-api-key";
import { useCurrentUser } from "@/hooks/use-current-user";
import {
  Check,
  X,
  Minus,
  Loader2,
  ArrowRight,
  AlertCircle,
  Clock,
  RefreshCw,
  Tag,
  CheckCircle2,
  Inbox,
} from "lucide-react";
import { apiUrl } from "@/lib/app-urls";

// Inline SVG logo (full wordmark). Kept inline rather than imported as an
// asset URL so the component has no dependency on the host's Vite asset
// pipeline configuration. The standalone .svg files in dashboard/assets/
// are still shipped for design-system reuse.
function AntiGhostingLogo({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 280 300" role="img" aria-label="Anti-Ghosting Followuper" className={className}>
      <defs>
        <linearGradient id="agLoopGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#6db4ff" />
          <stop offset="100%" stopColor="#3b82f6" />
        </linearGradient>
        {/* B9d.9.1: wordmark gradient darkened for light-bg contrast. */}
        <linearGradient id="agWordGrad" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#1e3a8a" />
          <stop offset="100%" stopColor="#2563eb" />
        </linearGradient>
      </defs>
      <g transform="translate(140, 100)">
        <circle cx="0" cy="0" r="78" fill="none" stroke="url(#agLoopGrad)" strokeWidth="14" strokeLinecap="round" strokeDasharray="380 1000" transform="rotate(-30)" />
        <polygon points="70,-40 95,-30 80,-8" fill="#3b82f6" />
        <path d="M -88 35 L -70 22 L -60 52 Z" fill="url(#agLoopGrad)" />
        <g stroke="#6db4ff" strokeWidth="3" strokeLinecap="round">
          <line x1="70" y1="-78" x2="78" y2="-88" />
          <line x1="82" y1="-68" x2="94" y2="-72" />
          <line x1="58" y1="-92" x2="62" y2="-104" />
        </g>
        <path d="M -34 -42 C -34 -68, 34 -68, 34 -42 L 34 30 L 22 42 L 10 30 L -2 42 L -14 30 L -26 42 L -34 30 Z" fill="#ffffff" />
        <circle cx="-12" cy="-18" r="3.5" fill="#0a0b0d" />
        <circle cx="14" cy="-18" r="3.5" fill="#0a0b0d" />
        <path d="M -8 -5 Q 1 4 10 -5" fill="none" stroke="#0a0b0d" strokeWidth="2" strokeLinecap="round" />
        <path d="M 34 -8 C 46 -6, 50 6, 42 14 C 38 8, 36 4, 34 0 Z" fill="#ffffff" />
      </g>
      {/* B9d.9.1: Anti-Ghosting fill swapped from near-white #e8e9ed to slate-900 for light-bg. */}
      <text x="140" y="240" textAnchor="middle" fill="#0f172a" fontFamily="Geist, system-ui, sans-serif" fontSize="32" fontWeight="500" letterSpacing="-0.5">Anti-Ghosting</text>
      <text x="140" y="282" textAnchor="middle" fill="url(#agWordGrad)" fontFamily="Geist, system-ui, sans-serif" fontSize="32" fontWeight="500" letterSpacing="-0.5">FollowUper</text>
    </svg>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Types — match the /api/anti-ghosting/{candidates,mark} response shapes
// ──────────────────────────────────────────────────────────────────────

type DaysSinceSeedTier = "lt_30d" | "30d_to_6mo" | "gt_6mo";

interface ValidatorResults {
  mostRecentIsOutbound: boolean;
  threadHasInbound: boolean;
  mostRecentOutboundNotInFollowups: boolean;
}

interface CandidateSeed {
  gmailMessageId: string;
  subject: string;
  snippet: string;
  sentAt: string;
  daysSinceSeedTier: DaysSinceSeedTier;
}

interface Candidate {
  gmailThreadId: string;
  ok: boolean;
  results: ValidatorResults;
  failureReason: string | null;
  prospect: { email: string; name: string } | null;
  seed: CandidateSeed | null;
  // 2026-07-29: rejection-card fields. `readError` is true only when the
  // thread could not actually be fetched/parsed; `subject`/`snippet` carry
  // the last message's context so validator rejections render as proper
  // "not eligible" cards instead of "Could not read thread <id>".
  // Optional so the UI still renders against an older API build.
  readError?: boolean;
  subject?: string | null;
  snippet?: string | null;
}

interface CandidatesResponse {
  ok: boolean;
  candidates: Candidate[];
  note?: string;
}

interface MarkResponse {
  ok: boolean;
  prospectId: number;
  scheduledAt: string;
  seed: { gmailMessageId: string; subject: string; sentAt: string };
  prospect: { email: string; name: string };
  results: ValidatorResults;
}

// ──────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────

const ACCENT = "#06b6d4"; // cyan — the AntiGhosting product color
const ACCENT_MUTED = "rgba(6,182,212,0.10)";
const ACCENT_BORDER = "rgba(6,182,212,0.30)";
const ACCENT_HOVER = "rgba(6,182,212,0.45)";

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

function daysBetween(iso: string, now: Date): number {
  const sentAt = new Date(iso);
  return Math.floor((now.getTime() - sentAt.getTime()) / (24 * 60 * 60 * 1000));
}

function formatGapBadge(iso: string, tier: DaysSinceSeedTier): { label: string; tone: "neutral" | "warning" | "danger" } {
  const days = daysBetween(iso, new Date());
  let label: string;
  if (days < 60) {
    label = `${days} days`;
  } else if (days < 365) {
    label = `${Math.round(days / 30)} months`;
  } else {
    label = `${(days / 365).toFixed(1)} years`;
  }
  if (tier === "lt_30d") return { label, tone: "neutral" };
  if (tier === "30d_to_6mo") return { label, tone: "warning" };
  return { label, tone: "danger" };
}

function formatScheduledAt(iso: string): string {
  const d = new Date(iso);
  const dayDiff = Math.round((d.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
  const dayLabel = dayDiff === 1 ? "tomorrow" : `in ${dayDiff} days`;
  const time = d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return `${time} (${dayLabel})`;
}

// ──────────────────────────────────────────────────────────────────────
// Page
// ──────────────────────────────────────────────────────────────────────

export default function AntiGhosting() {
  const { apiKey } = useApiKey();
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  const [markedFeedback, setMarkedFeedback] = useState<Record<string, MarkResponse>>({});

  const candidatesQuery = useQuery<CandidatesResponse, Error>({
    queryKey: ["anti-ghosting-candidates", user?.email],
    enabled: Boolean(apiKey && user?.email),
    queryFn: async () => {
      const res = await fetch(
        apiUrl(`/api/anti-ghosting/candidates?email=${encodeURIComponent(user!.email)}`),
        { headers: { "x-api-key": apiKey! } },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      return (await res.json()) as CandidatesResponse;
    },
  });

  const markMutation = useMutation<MarkResponse, Error, { gmailThreadId: string }>({
    mutationFn: async (input) => {
      const res = await fetch(apiUrl("/api/anti-ghosting/mark"), {
        method: "POST",
        headers: { "x-api-key": apiKey!, "content-type": "application/json" },
        body: JSON.stringify({ email: user!.email, gmailThreadId: input.gmailThreadId }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      return (await res.json()) as MarkResponse;
    },
    onSuccess: (data, variables) => {
      // 2026-07-29: POST /mark returns HTTP 200 with ok:false when the
      // thread flipped ineligible between listing and clicking Mark (e.g.
      // the prospect replied in the interim). Rendering the success card
      // then produced "F1 scheduled Invalid Date … Prospect ID #undefined".
      // Refresh the list instead so the row re-renders with its real state.
      if (!data.ok) {
        queryClient.invalidateQueries({ queryKey: ["anti-ghosting-candidates"] });
        return;
      }
      setMarkedFeedback((prev) => ({ ...prev, [variables.gmailThreadId]: data }));
      // Soft refresh after the row materialises in DB
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ["anti-ghosting-candidates"] });
      }, 1500);
    },
  });

  // ────────────────────────────────────────────────────────────────────
  // Render branches
  // ────────────────────────────────────────────────────────────────────

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <Header onRefresh={() => candidatesQuery.refetch()} refreshing={candidatesQuery.isFetching} />

      {!apiKey || !user ? (
        <NoticeCard
          icon={<AlertCircle className="w-5 h-5" />}
          title="Sign in to continue"
          body="Open the Accounts page to connect your account, then come back here."
        />
      ) : candidatesQuery.isLoading ? (
        <LoadingState />
      ) : candidatesQuery.isError ? (
        <NoticeCard
          icon={<AlertCircle className="w-5 h-5" />}
          title="Could not load candidates"
          body={candidatesQuery.error.message}
          tone="danger"
        />
      ) : candidatesQuery.data?.note ? (
        <SetupHelpCard note={candidatesQuery.data.note} />
      ) : (candidatesQuery.data?.candidates?.length ?? 0) === 0 ? (
        <NoticeCard
          icon={<Inbox className="w-5 h-5" />}
          title="No ghosted threads found"
          body="Apply your 'AntiGhosting Followuper' label to a thread in Gmail to surface it here. Threads already marked or that don't match the validators will not appear."
        />
      ) : (
        <ul className="space-y-3 list-none p-0 m-0">
          {candidatesQuery.data!.candidates.map((c) => (
            <CandidateRow
              key={c.gmailThreadId}
              candidate={c}
              feedback={markedFeedback[c.gmailThreadId] ?? null}
              isMarking={markMutation.isPending && markMutation.variables?.gmailThreadId === c.gmailThreadId}
              markError={
                markMutation.isError && markMutation.variables?.gmailThreadId === c.gmailThreadId
                  ? markMutation.error.message
                  : null
              }
              onMark={() => markMutation.mutate({ gmailThreadId: c.gmailThreadId })}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Subcomponents
// ──────────────────────────────────────────────────────────────────────

function Header({ onRefresh, refreshing }: { onRefresh: () => void; refreshing: boolean }) {
  return (
    <div className="flex items-start justify-between mb-8">
      <div className="flex items-center gap-4">
        <AntiGhostingLogo className="w-20 h-20 flex-shrink-0" />
        <div>
          <h1 className="text-[20px] font-semibold tracking-tight mb-1" style={{ color: "var(--text-primary)" }}>
            Anti-Ghosting Followuper
          </h1>
          <p className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
            Re-engage conversations that went quiet. Tag a thread in Gmail with your AntiGhosting label, then mark it here.
          </p>
        </div>
      </div>
      <button
        type="button"
        onClick={onRefresh}
        disabled={refreshing}
        className="flex items-center gap-1.5 text-[13px] px-3 py-1.5 rounded-md transition-colors disabled:opacity-50"
        style={{
          color: "var(--text-secondary)",
          background: "var(--bg-secondary)",
          border: "1px solid var(--border-default)",
        }}
        aria-label="Refresh candidate list"
      >
        {refreshing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
        Refresh
      </button>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="flex items-center justify-center py-16" style={{ color: "var(--text-secondary)" }}>
      <Loader2 className="w-5 h-5 animate-spin mr-2" />
      <span className="text-[14px]">Reading your AntiGhosting label from Gmail...</span>
    </div>
  );
}

function NoticeCard({
  icon,
  title,
  body,
  tone = "neutral",
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  tone?: "neutral" | "danger";
}) {
  const bg = tone === "danger" ? "var(--danger-muted)" : "var(--bg-secondary)";
  const border = tone === "danger" ? "var(--danger-border)" : "var(--border-default)";
  const iconColor = tone === "danger" ? "var(--color-destructive)" : "var(--text-secondary)";
  return (
    <div className="rounded-lg p-5" style={{ background: bg, border: `1px solid ${border}` }}>
      <div className="flex items-start gap-3">
        <div style={{ color: iconColor }}>{icon}</div>
        <div>
          <h3 className="text-[14px] font-semibold mb-1" style={{ color: "var(--text-primary)" }}>
            {title}
          </h3>
          <p className="text-[13px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
            {body}
          </p>
        </div>
      </div>
    </div>
  );
}

function SetupHelpCard({ note }: { note: string }) {
  return (
    <div className="rounded-lg p-6" style={{ background: ACCENT_MUTED, border: `1px solid ${ACCENT_BORDER}` }}>
      <div className="flex items-start gap-3 mb-4">
        <Tag className="w-5 h-5 flex-shrink-0" style={{ color: ACCENT }} />
        <div>
          <h3 className="text-[15px] font-semibold mb-1" style={{ color: "var(--text-primary)" }}>
            One-time setup
          </h3>
          <p className="text-[13px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
            {note}
          </p>
        </div>
      </div>
      <ol className="text-[13px] space-y-2 ml-8" style={{ color: "var(--text-secondary)" }}>
        <li>
          1. Open Gmail. Settings &rarr; See all settings &rarr; Labels &rarr; Create new label.
        </li>
        <li>
          2. Name the label exactly: <code className="px-1.5 py-0.5 rounded text-[12px] font-mono" style={{ background: "var(--bg-tertiary)", color: "var(--text-primary)" }}>AntiGhosting Followuper</code>.
        </li>
        <li>
          3. Apply that label to one or more ghosted threads. Threads where you sent the last message and the other side replied at least once will appear here.
        </li>
      </ol>
    </div>
  );
}

function CandidateRow({
  candidate,
  feedback,
  isMarking,
  markError,
  onMark,
}: {
  candidate: Candidate;
  feedback: MarkResponse | null;
  isMarking: boolean;
  markError: string | null;
  onMark: () => void;
}) {
  const { seed, prospect, results, ok, failureReason } = candidate;
  const wasMarked = feedback !== null;

  if (!seed) {
    // 2026-07-29: only a true fetch/parse failure is a "could not read"
    // card. A validator REJECTION also arrives with seed=null, but the
    // thread itself was read fine — rendering it as a read error made
    // operators think label detection was broken. Rejections now render
    // as an explicit "Not eligible" card with the subject, the failing
    // validator chips, and the operator-facing reason.
    // Old-server fallback (readError field absent): recognize the two
    // read-failure reason strings the validators emit, so a Gmail outage
    // is never dressed up as "not eligible".
    const isReadFailure =
      candidate.readError ??
      (!(candidate.subject || prospect) ||
        /^(Failed to fetch thread|Thread has no parseable)/.test(failureReason ?? ""));
    if (isReadFailure) {
      return (
        <li className="rounded-lg p-5" style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-default)" }}>
          <div className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
            Could not read thread {candidate.gmailThreadId} {failureReason ? `– ${failureReason}` : ""}
          </div>
        </li>
      );
    }
    return (
      <li className="rounded-lg p-5" style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-default)" }}>
        <div className="flex items-center gap-2 mb-2">
          <span
            className="text-[11px] font-mono uppercase tracking-wide px-1.5 py-0.5 rounded"
            style={{ background: "var(--warning-muted)", color: "var(--warning)", border: "1px solid var(--warning-border)" }}
          >
            Label detected — not eligible
          </span>
          {prospect && (
            <span className="text-[12px]" style={{ color: "var(--text-secondary)" }}>
              {prospect.name || prospect.email}
              {prospect.name && <span style={{ color: "var(--text-tertiary)" }}> &middot; {prospect.email}</span>}
            </span>
          )}
        </div>
        {candidate.subject && (
          <h3 className="text-[14px] font-medium mb-2 truncate" style={{ color: "var(--text-primary)" }} title={candidate.subject}>
            {candidate.subject}
          </h3>
        )}
        <ValidatorChips results={results} sequential />
        {failureReason && (
          <div className="mt-3 text-[12px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
            {failureReason}
          </div>
        )}
      </li>
    );
  }

  const badge = formatGapBadge(seed.sentAt, seed.daysSinceSeedTier);
  const badgeStyle =
    badge.tone === "neutral"
      ? { background: "var(--bg-tertiary)", color: "var(--text-secondary)", border: "1px solid var(--border-default)" }
      : badge.tone === "warning"
      ? { background: "var(--warning-muted)", color: "var(--warning)", border: "1px solid var(--warning-border)" }
      : { background: "var(--danger-muted)", color: "var(--color-destructive)", border: "1px solid var(--danger-border)" };

  return (
    <li
      className="rounded-lg p-5 transition-colors"
      style={{
        background: wasMarked ? ACCENT_MUTED : "var(--bg-secondary)",
        border: `1px solid ${wasMarked ? ACCENT_BORDER : "var(--border-default)"}`,
      }}
    >
      <div className="flex items-start gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-2">
            <span
              className="text-[11px] font-mono uppercase tracking-wide px-1.5 py-0.5 rounded inline-flex items-center gap-1"
              style={badgeStyle}
            >
              <Clock className="w-3 h-3" />
              {badge.label}
            </span>
            {prospect && (
              <span className="text-[12px]" style={{ color: "var(--text-secondary)" }}>
                {prospect.name || prospect.email}
                {prospect.name && (
                  <span style={{ color: "var(--text-tertiary)" }}> &middot; {prospect.email}</span>
                )}
              </span>
            )}
          </div>

          <h3 className="text-[14px] font-medium mb-2 truncate" style={{ color: "var(--text-primary)" }} title={seed.subject}>
            {seed.subject || "(no subject)"}
          </h3>

          {seed.snippet && (
            <p className="text-[12px] mb-3 leading-relaxed line-clamp-2" style={{ color: "var(--text-tertiary)" }}>
              {seed.snippet}
            </p>
          )}

          <ValidatorChips results={results} />

          {!ok && failureReason && (
            <div className="mt-3 text-[12px]" style={{ color: "var(--text-secondary)" }}>
              {failureReason}
            </div>
          )}

          {markError && (
            <div
              className="mt-3 text-[12px] px-3 py-2 rounded"
              style={{ background: "var(--danger-muted)", color: "var(--color-destructive)", border: "1px solid var(--danger-border)" }}
            >
              {markError}
            </div>
          )}

          {wasMarked && feedback && (
            <div
              className="mt-3 text-[12px] px-3 py-2 rounded flex items-start gap-2"
              style={{ background: ACCENT_MUTED, color: "var(--text-primary)", border: `1px solid ${ACCENT_BORDER}` }}
            >
              <CheckCircle2 className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: ACCENT }} />
              <div>
                <div className="font-medium mb-0.5">Marked. F1 scheduled {formatScheduledAt(feedback.scheduledAt)}.</div>
                <div style={{ color: "var(--text-secondary)" }}>
                  Prospect ID #{feedback.prospectId}. Output lands in the pipeline when ready.
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="flex-shrink-0">
          {ok && !wasMarked && (
            <button
              type="button"
              onClick={onMark}
              disabled={isMarking}
              className="flex items-center gap-1.5 text-[13px] font-medium px-4 py-2 rounded-md transition-colors disabled:opacity-50"
              style={{ background: ACCENT, color: "#ffffff" }}
              onMouseEnter={(e) => {
                if (!isMarking) e.currentTarget.style.background = "#0891b2";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = ACCENT;
              }}
            >
              {isMarking ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Marking...
                </>
              ) : (
                <>
                  Mark
                  <ArrowRight className="w-3.5 h-3.5" />
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

function ValidatorChips({ results, sequential = false }: { results: ValidatorResults; sequential?: boolean }) {
  // Items are listed in the SERVER'S validator run order (validateThreadForMarking
  // short-circuits: mostRecentIsOutbound → threadHasInbound → notInFollowups).
  const items: Array<{ label: string; ok: boolean }> = [
    { label: "Last message is yours (the seed)", ok: results.mostRecentIsOutbound },
    { label: "Thread has at least one reply", ok: results.threadHasInbound },
    { label: "Not already in active follow-up", ok: results.mostRecentOutboundNotInFollowups },
  ];
  // 2026-07-29: on a rejection card (`sequential`), validators AFTER the
  // first failure never ran — the server initializes them to false and
  // short-circuits. Rendering them as red ✗ told operators "thread has no
  // reply" on threads whose prospect demonstrably replied. Chips past the
  // first failure render as neutral "not checked" instead.
  const firstFailure = items.findIndex((it) => !it.ok);
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1.5">
      {items.map((it, idx) => {
        const notChecked = sequential && firstFailure !== -1 && idx > firstFailure;
        return (
          <span
            key={it.label}
            className="inline-flex items-center gap-1.5 text-[12px]"
            style={{ color: notChecked ? "var(--text-tertiary)" : it.ok ? "var(--success)" : "var(--color-destructive)" }}
          >
            {notChecked ? <Minus className="w-3.5 h-3.5" /> : it.ok ? <Check className="w-3.5 h-3.5" /> : <X className="w-3.5 h-3.5" />}
            <span style={{ color: notChecked ? "var(--text-tertiary)" : "var(--text-secondary)" }}>
              {it.label}
              {notChecked ? " (not checked)" : ""}
            </span>
          </span>
        );
      })}
    </div>
  );
}
