import React, { useState, useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { format } from "date-fns";
import { useApiKey } from "@/hooks/use-api-key";
import { useCurrentUser } from "@/hooks/use-current-user";
import { useGetSentEmails, useGetThread, useGetGmailAccounts } from "@workspace/api-client-react";
import { Card, Button, Badge, Input, Select } from "@/components/ui";
import {
  Search, RefreshCw, AlertCircle, Mail, Tag, ArrowRight,
  CheckCircle2, XCircle, ChevronDown, ChevronRight, Inbox,
  MessageSquare, Building2, Sparkles, Database, Loader2, Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";

type SentEmail = {
  id: string;
  threadId: string;
  from: string;
  to: string;
  recipientEmail: string;
  recipientName: string;
  subject: string;
  snippet: string;
  bodyPreview: string;
  date: string;
  timestamp: number;
  labelIds: string[];
  labelNames: string[];
  hasDoctrineLabel: boolean;
  matchedDoctrineLabels: string[];
  isSentByMe: boolean;
  detection: {
    wouldBePickedUp: boolean;
    whyNot?: string[];
    vertical: string;
    verticalReason: string;
    withinSyncWindow?: boolean;
    company: string;
  };
  inDatabase: boolean;
  dbRecord: { gmailMessageId: string; id: number; replied: number; vertical: string; matchType?: string } | null;
};

type SentEmailsMeta = {
  total: number;
  withDoctrineLabel: number;
  inDatabase: number;
  wouldBePickedUp: number;
};

const verticalLabels: Record<string, string> = {
  gaming_ua: "Gaming UA",
  non_gaming_ua: "Non-Gaming UA",
  cps: "CPS",
  retargeting: "Retargeting",
};

function StatusPill({ active, label }: { active: boolean; label: string }) {
  return (
    <span
      className="text-[11px] font-mono font-medium px-2 py-0.5 rounded"
      style={
        active
          ? { background: "var(--success-muted)", color: "var(--success)" }
          : { background: "var(--bg-tertiary)", color: "var(--text-tertiary)" }
      }
    >
      {label}
    </span>
  );
}

function DetectionPipeline({ email }: { email: SentEmail }) {
  const steps = [
    { label: "SENT", active: email.isSentByMe },
    { label: "LABEL", active: email.hasDoctrineLabel },
    { label: "DB", active: email.inDatabase },
  ];

  return (
    <div className="flex items-center gap-1.5">
      {steps.map((step, i) => (
        <React.Fragment key={step.label}>
          <StatusPill {...step} />
          {i < steps.length - 1 && (
            <ArrowRight
              className="h-3 w-3 flex-shrink-0"
              style={{ color: step.active ? "var(--text-tertiary)" : "var(--border-default)" }}
            />
          )}
        </React.Fragment>
      ))}
    </div>
  );
}

function ThreadView({ threadId, apiKey }: { threadId: string; apiKey: string }) {
  const { data, isLoading, isError } = useGetThread(threadId, {
    request: { headers: { "x-api-key": apiKey } },
    query: { enabled: !!threadId },
  });

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-4 text-[13px]" style={{ color: "var(--text-secondary)" }}>
        <RefreshCw className="h-4 w-4 animate-spin" />
        Loading thread...
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="flex items-center gap-2 py-4 text-[13px]" style={{ color: "var(--danger)" }}>
        <AlertCircle className="h-4 w-4" />
        Failed to load thread
      </div>
    );
  }

  return (
    <div className="space-y-3 max-h-96 overflow-y-auto pr-2">
      <div className="flex items-center gap-3 text-[11px] mb-2" style={{ color: "var(--text-secondary)" }}>
        <span>{data.messageCount} message{data.messageCount !== 1 ? "s" : ""}</span>
        {data.hasExternalReply ? (
          <Badge variant="success">REPLY</Badge>
        ) : (
          <Badge variant="outline">NO REPLY</Badge>
        )}
      </div>
      {data.messages?.map((msg: any) => (
        <div
          key={msg.id}
          className={cn("rounded-lg p-3 text-[13px]", msg.isFromMe ? "ml-6" : "mr-6")}
          style={{
            background: msg.isFromMe ? "var(--accent-muted)" : "var(--success-muted)",
            border: msg.isFromMe ? "1px solid var(--accent-border)" : "1px solid var(--success-border)",
          }}
        >
          <div className="flex items-center justify-between mb-2">
            <span className="font-medium text-[12px]" style={{ color: "var(--text-primary)" }}>
              {msg.isFromMe ? "Me" : msg.from}
            </span>
            <span className="text-[11px]" style={{ color: "var(--text-tertiary)" }}>
              {msg.date ? format(new Date(msg.date), "MMM d, HH:mm") : ""}
            </span>
          </div>
          <p className="whitespace-pre-wrap text-[12px] leading-relaxed max-h-32 overflow-hidden" style={{ color: "var(--text-secondary)" }}>
            {msg.body || msg.snippet}
          </p>
        </div>
      ))}
    </div>
  );
}

function EmailCard({ email, apiKey }: { email: SentEmail; apiKey: string }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [showThread, setShowThread] = useState(false);

  const vertLabel = verticalLabels[email.detection.vertical] || email.detection.vertical;

  return (
    <Card className="overflow-hidden" style={{ animation: "fadeUp 0.3s ease both" }}>
      <div
        className="p-4 cursor-pointer transition-colors duration-100"
        style={{ borderLeft: email.detection.wouldBePickedUp ? "2px solid var(--success)" : "2px solid transparent" }}
        onClick={() => setIsExpanded(!isExpanded)}
        onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-tertiary)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
      >
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h3 className="font-semibold text-[13px] truncate" style={{ color: "var(--text-primary)" }}>
                  {email.subject || "(No Subject)"}
                </h3>
                <div className="flex items-center gap-2 mt-1 text-[12px]" style={{ color: "var(--text-secondary)" }}>
                  <span className="flex items-center gap-1">
                    <Building2 className="h-3 w-3" strokeWidth={1.5} />
                    {email.recipientName || email.recipientEmail}
                  </span>
                  <span style={{ color: "var(--text-tertiary)" }}>|</span>
                  <span>{email.recipientEmail}</span>
                </div>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <span className="font-mono text-[11px]" style={{ color: "var(--text-tertiary)" }}>
                  {email.date ? format(new Date(email.date), "MMM d, HH:mm") : ""}
                </span>
                {isExpanded ? (
                  <ChevronDown className="h-4 w-4" style={{ color: "var(--text-tertiary)" }} />
                ) : (
                  <ChevronRight className="h-4 w-4" style={{ color: "var(--text-tertiary)" }} />
                )}
              </div>
            </div>

            <div className="mt-3 flex items-center gap-2 flex-wrap">
              <DetectionPipeline email={email} />
              <div className="ml-auto flex items-center gap-1.5">
                <Badge variant="outline">{vertLabel}</Badge>
                {email.detection.wouldBePickedUp && (
                  email.inDatabase ? (
                    <Badge variant="success">SYNCED</Badge>
                  ) : (
                    <Badge variant="outline" style={{ background: "rgba(59, 130, 246, 0.12)", color: "var(--accent)", border: "1px solid rgba(59, 130, 246, 0.3)" }}>
                      PENDING SYNC
                    </Badge>
                  )
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-4 space-y-4 pt-4" style={{ borderTop: "1px solid var(--border-default)" }}>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-3">
                  <h4
                    className="font-medium uppercase tracking-[0.04em]"
                    style={{ fontSize: "11px", color: "var(--text-tertiary)" }}
                  >
                    DETECTION
                  </h4>
                  <div className="space-y-2 text-[13px]">
                    {[
                      ["Sent by me", email.isSentByMe],
                      ["Doctrine label", email.hasDoctrineLabel],
                      ["Would be picked up", email.detection.wouldBePickedUp],
                    ].map(([label, val]) => (
                      <div key={label as string} className="flex justify-between">
                        <span style={{ color: "var(--text-secondary)" }}>{label as string}</span>
                        <span
                          className="font-mono font-medium"
                          style={{ color: val ? "var(--success)" : "var(--text-tertiary)" }}
                        >
                          {val ? "YES" : "NO"}
                        </span>
                      </div>
                    ))}
                    <div className="flex justify-between">
                      <span style={{ color: "var(--text-secondary)" }}>Vertical</span>
                      <span style={{ color: "var(--text-primary)" }}>{vertLabel}</span>
                    </div>
                    <div className="flex justify-between">
                      <span style={{ color: "var(--text-secondary)" }}>Reason</span>
                      <span className="text-[12px]" style={{ color: "var(--text-secondary)" }}>{email.detection.verticalReason}</span>
                    </div>
                    {email.detection.withinSyncWindow !== undefined && (
                      <div className="flex justify-between">
                        <span style={{ color: "var(--text-secondary)" }}>60-day window</span>
                        <span className="font-mono font-medium" style={{ color: email.detection.withinSyncWindow ? "var(--success)" : "var(--danger)" }}>
                          {email.detection.withinSyncWindow ? "YES" : "NO"}
                        </span>
                      </div>
                    )}
                    <div className="flex justify-between">
                      <span style={{ color: "var(--text-secondary)" }}>Company</span>
                      <span className="capitalize" style={{ color: "var(--text-primary)" }}>{email.detection.company || "\u2014"}</span>
                    </div>
                    {email.detection.whyNot && email.detection.whyNot.length > 0 && (
                      <div className="mt-2 p-3 rounded-lg" style={{ background: "var(--warning-muted)", border: "1px solid var(--warning-border)" }}>
                        <p className="font-medium uppercase tracking-[0.04em] mb-1" style={{ fontSize: "11px", color: "var(--warning)" }}>WHY NOT DETECTED</p>
                        <ul className="space-y-0.5">
                          {email.detection.whyNot.map((reason, i) => (
                            <li key={i} className="text-[12px] flex items-center gap-1.5" style={{ color: "var(--warning)" }}>
                              <XCircle className="h-3 w-3 flex-shrink-0" />
                              {reason}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    <div className="flex justify-between">
                      <span style={{ color: "var(--text-secondary)" }}>In database</span>
                      {email.inDatabase ? (
                        <span className="font-mono font-medium" style={{ color: "var(--success)" }}>
                          YES (ID: {email.dbRecord?.id}{email.dbRecord?.matchType === "thread" ? ", via thread" : ""})
                        </span>
                      ) : email.detection.wouldBePickedUp ? (
                        <span className="font-mono font-medium" style={{ color: "var(--warning)" }}>
                          PENDING SYNC
                        </span>
                      ) : (
                        <span className="font-mono font-medium" style={{ color: "var(--text-tertiary)" }}>
                          NO
                        </span>
                      )}
                    </div>
                    {!email.inDatabase && email.detection.wouldBePickedUp && (
                      <div className="rounded-lg p-2.5" style={{ background: "rgba(59, 130, 246, 0.08)", border: "1px solid rgba(59, 130, 246, 0.2)" }}>
                        <p className="text-[11px]" style={{ color: "var(--accent)" }}>
                          This email will become a prospect on the next Gmail sync. Then queue follow-ups from the Dashboard.
                        </p>
                      </div>
                    )}
                    {email.dbRecord && (
                      <div className="flex justify-between">
                        <span style={{ color: "var(--text-secondary)" }}>Reply status (DB)</span>
                        <span className="font-mono font-medium" style={{ color: email.dbRecord.replied ? "var(--success)" : "var(--warning)" }}>
                          {email.dbRecord.replied ? "REPLIED" : "UNREPLIED"}
                        </span>
                      </div>
                    )}
                  </div>
                </div>

                <div className="space-y-3">
                  <h4
                    className="font-medium uppercase tracking-[0.04em]"
                    style={{ fontSize: "11px", color: "var(--text-tertiary)" }}
                  >
                    LABELS
                  </h4>
                  <div className="flex flex-wrap gap-1.5">
                    {email.labelNames.map((label, i) => (
                      <span
                        key={i}
                        className="px-2 py-0.5 rounded text-[11px] font-mono font-medium"
                        style={
                          email.matchedDoctrineLabels.includes(label)
                            ? { background: "var(--success-muted)", color: "var(--success)" }
                            : { background: "var(--bg-tertiary)", color: "var(--text-secondary)" }
                        }
                      >
                        {label}
                      </span>
                    ))}
                    {email.labelNames.length === 0 && (
                      <span className="text-[12px]" style={{ color: "var(--text-tertiary)" }}>No labels</span>
                    )}
                  </div>

                  <h4
                    className="font-medium uppercase tracking-[0.04em] pt-2"
                    style={{ fontSize: "11px", color: "var(--text-tertiary)" }}
                  >
                    PREVIEW
                  </h4>
                  <p
                    className="text-[12px] leading-relaxed whitespace-pre-wrap max-h-32 overflow-y-auto rounded-lg p-3"
                    style={{
                      color: "var(--text-secondary)",
                      background: "var(--bg-primary)",
                      border: "1px solid var(--border-default)",
                    }}
                  >
                    {email.bodyPreview || email.snippet || "(No content)"}
                  </p>
                </div>
              </div>

              <div className="pt-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={(e) => { e.stopPropagation(); setShowThread(!showThread); }}
                  className="gap-2 text-[12px]"
                >
                  <MessageSquare className="h-3 w-3" />
                  {showThread ? "Hide thread" : "View thread"}
                </Button>
              </div>

              {showThread && (
                <div className="pt-2">
                  <ThreadView threadId={email.threadId} apiKey={apiKey} />
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </Card>
  );
}

export default function EmailInspector() {
  const { apiKey } = useApiKey();
  const { user: currentUser } = useCurrentUser();
  const [selectedUserId, setSelectedUserId] = useState<string>("");
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [limit, setLimit] = useState(30);
  const [filter, setFilter] = useState<"all" | "detected" | "labeled" | "unlabeled">("all");
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  const requestOpts = { request: { headers: { "x-api-key": apiKey || "" } } };

  const { data: accountsData } = useGetGmailAccounts({
    ...requestOpts,
    query: { enabled: !!apiKey },
  });
  const accounts: any[] = (accountsData as any)?.accounts || [];

  useEffect(() => {
    if (currentUser?.userId) {
      setSelectedUserId(String(currentUser.userId));
    }
  }, [currentUser?.userId]);

  const { data, isLoading, isError, refetch, isFetching } = useGetSentEmails(
    { limit, ...(search ? { search } : {}), ...(selectedUserId ? { userId: selectedUserId } : {}) },
    { ...requestOpts, query: { enabled: !!apiKey && !!selectedUserId } },
  );

  const emails: SentEmail[] = (data as any)?.emails || [];
  const meta: SentEmailsMeta = (data as any)?.meta || { total: 0, withDoctrineLabel: 0, inDatabase: 0, wouldBePickedUp: 0 };

  const pendingSyncCount = emails.filter(e => e.detection.wouldBePickedUp && !e.inDatabase).length;

  const handleSyncNow = async () => {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const base = import.meta.env.BASE_URL || "/";
      const res = await fetch(`${base}api/sync`, {
        method: "POST",
        headers: { "x-api-key": apiKey || "" },
      });
      const data = await res.json();
      if (res.ok) {
        setSyncMsg(`Synced ${data.synced ?? 0} emails, ${data.repliesDetected ?? 0} replies detected.`);
        refetch();
      } else {
        setSyncMsg(data.error || "Sync failed");
      }
      setTimeout(() => setSyncMsg(null), 8000);
    } catch (err: any) {
      setSyncMsg(err.message || "Sync failed");
      setTimeout(() => setSyncMsg(null), 5000);
    } finally {
      setSyncing(false);
    }
  };

  const filteredEmails = emails.filter(e => {
    if (filter === "detected") return e.detection.wouldBePickedUp;
    if (filter === "labeled") return e.hasDoctrineLabel;
    if (filter === "unlabeled") return !e.hasDoctrineLabel;
    return true;
  });

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setSearch(searchInput);
  };

  const statCards = [
    { label: "TOTAL FETCHED", value: meta.total },
    { label: "DOCTRINE LABELED", value: meta.withDoctrineLabel },
    { label: "DETECTED", value: meta.wouldBePickedUp, highlight: pendingSyncCount > 0 },
    { label: "IN DATABASE", value: meta.inDatabase },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 style={{ fontSize: "20px", fontWeight: 600, letterSpacing: "-0.02em" }}>Email Inspector</h1>
        <Button
          variant="secondary"
          onClick={() => refetch()}
          isLoading={isFetching}
          className="gap-2"
        >
          <RefreshCw className="h-4 w-4" />
          Refresh
        </Button>
      </div>

      <div className="grid grid-cols-4 gap-4">
        {statCards.map((stat: any, i: number) => (
          <Card
            key={stat.label}
            className="p-4"
            style={{
              animation: `fadeUp 0.3s ease both`,
              animationDelay: `${i * 0.05}s`,
              ...(stat.highlight ? { border: "1px solid rgba(59, 130, 246, 0.3)", background: "rgba(59, 130, 246, 0.04)" } : {}),
            }}
          >
            <p
              className="font-medium uppercase tracking-[0.04em] mb-2"
              style={{ fontSize: "11px", color: stat.highlight ? "var(--accent)" : "var(--text-tertiary)" }}
            >
              {stat.label}
            </p>
            <p
              className="font-semibold font-mono"
              style={{ fontSize: "24px", letterSpacing: "-0.02em", color: "var(--text-primary)" }}
            >
              {stat.value}
            </p>
            {stat.highlight && (
              <p className="text-[11px] mt-1" style={{ color: "var(--accent)" }}>
                {pendingSyncCount} pending sync
              </p>
            )}
          </Card>
        ))}
      </div>

      {syncMsg && (
        <div
          className="rounded-lg px-4 py-3 text-[13px]"
          style={{
            background: "rgba(34, 197, 94, 0.1)",
            border: "1px solid rgba(34, 197, 94, 0.3)",
            color: "var(--success)",
          }}
        >
          {syncMsg}
        </div>
      )}

      {pendingSyncCount > 0 && (
        <div
          className="rounded-lg p-4 flex items-center justify-between"
          style={{
            background: "rgba(59, 130, 246, 0.06)",
            border: "1px solid rgba(59, 130, 246, 0.2)",
          }}
        >
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: "rgba(59, 130, 246, 0.12)" }}>
              <Zap className="h-4 w-4" style={{ color: "var(--accent)" }} />
            </div>
            <div>
              <p className="text-[13px] font-medium" style={{ color: "var(--text-primary)" }}>
                {pendingSyncCount} email{pendingSyncCount !== 1 ? "s" : ""} detected but not yet synced
              </p>
              <p className="text-[12px]" style={{ color: "var(--text-secondary)" }}>
                Sync now to create prospects, then queue follow-ups from the Dashboard.
              </p>
            </div>
          </div>
          <Button
            onClick={handleSyncNow}
            disabled={syncing}
            className="gap-2"
            size="sm"
            style={{ background: "var(--accent)", borderColor: "var(--accent)" }}
          >
            {syncing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Sync Now
          </Button>
        </div>
      )}

      <div className="flex gap-3">
        <div
          className="h-9 rounded-md px-3 text-[13px] flex items-center w-52"
          style={{
            background: "var(--bg-tertiary)",
            border: "1px solid var(--border-default)",
            color: "var(--text-secondary)",
          }}
        >
          {currentUser?.email || "Loading..."}
        </div>
        <form onSubmit={handleSearch} className="flex-1 flex gap-2">
          <div className="relative flex-1">
            <Search
              className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4"
              style={{ color: "var(--text-tertiary)" }}
            />
            <Input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Gmail search query..."
              className="pl-10"
            />
          </div>
          <Button type="submit" className="gap-2">
            <Search className="h-4 w-4" />
            Search
          </Button>
        </form>
        <Select
          value={filter}
          onChange={(e) => setFilter(e.target.value as any)}
          className="w-40"
        >
          <option value="all">All emails</option>
          <option value="detected">Detected</option>
          <option value="labeled">Has label</option>
          <option value="unlabeled">No label</option>
        </Select>
        <Select
          value={limit.toString()}
          onChange={(e) => setLimit(parseInt(e.target.value))}
          className="w-20"
        >
          <option value="10">10</option>
          <option value="20">20</option>
          <option value="30">30</option>
          <option value="50">50</option>
        </Select>
      </div>

      {meta.total > 0 && meta.withDoctrineLabel === 0 && (
        <div
          className="rounded-lg p-4 flex items-start gap-3"
          style={{ background: "var(--warning-muted)", border: "1px solid var(--warning-border)" }}
        >
          <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" style={{ color: "var(--warning)" }} />
          <div>
            <p className="text-[13px] font-medium" style={{ color: "var(--warning)" }}>No emails have doctrine labels</p>
            <p className="text-[12px] mt-1" style={{ color: "var(--text-secondary)" }}>
              The follow-up engine only picks up emails with doctrine Gmail labels. Integrate the labeling module into your pipeline.
            </p>
          </div>
        </div>
      )}

      {isError ? (
        <Card className="flex flex-col items-center justify-center h-64 text-center p-8">
          <AlertCircle className="h-6 w-6 mb-3" style={{ color: "var(--danger)" }} />
          <p className="font-medium text-[13px]" style={{ color: "var(--text-primary)" }}>Failed to load emails</p>
          <p className="text-[13px]" style={{ color: "var(--text-secondary)" }}>Check API key and server.</p>
        </Card>
      ) : isLoading ? (
        <div className="flex h-64 items-center justify-center">
          <RefreshCw className="h-5 w-5 animate-spin" style={{ color: "var(--text-tertiary)" }} />
        </div>
      ) : filteredEmails.length === 0 ? (
        <Card className="flex flex-col items-center justify-center h-64 text-center p-8" style={{ borderStyle: "dashed" }}>
          <Inbox className="h-6 w-6 mb-3" style={{ color: "var(--text-tertiary)" }} />
          <p className="font-medium text-[13px]" style={{ color: "var(--text-primary)" }}>No emails found</p>
          <p className="text-[13px] mt-1 max-w-sm" style={{ color: "var(--text-secondary)" }}>
            {filter !== "all" ? "Try a different filter." : "Search for emails or sync your Gmail account."}
          </p>
        </Card>
      ) : (
        <div className="space-y-3">
          {filteredEmails.map((email) => (
            <EmailCard key={email.id} email={email} apiKey={apiKey || ""} />
          ))}
        </div>
      )}
    </div>
  );
}
