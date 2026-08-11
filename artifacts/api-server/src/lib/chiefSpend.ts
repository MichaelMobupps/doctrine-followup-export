/**
 * chiefSpend.ts — F-3.7a. The outbound half of the uplink: telling the Chief
 * what this app spent.
 *
 * The Chief's inbound seam is `POST <origin>/api/ingest/spend`, specified in
 * its `CONTRACT.md`. Every rule encoded here cites the section it comes from.
 * This is the Prospector's proven pattern (`lib/chiefSpend.ts` in
 * `prospector-clean`, orders P-3.1c / P-3.1e / P-3.4a) with one simplification
 * that is called out where it happens: this app has no inbound command seam, so
 * every dollar it spends is human-caused and the initiator dimension collapses.
 *
 * Three properties this module exists to guarantee:
 *
 *  1. INERT unless both `CHIEF_URL` and `CHIEF_INGEST_TOKEN` are set.
 *     `resolveChiefConfig()` returns null otherwise; no reporter is ever
 *     constructed, no timer runs, no socket opens, no row is written, and the
 *     cursor table is never touched.
 *  2. NEVER blocking, NEVER raising, NEVER able to fail a send or a generation.
 *     `send()` is only ever driven from a background tick, carries a per-attempt
 *     abort, and returns an outcome object. It has no throwing path, so there is
 *     no rejection for a caller to inherit.
 *  3. NEVER retry a 4xx; retry a 5xx with the SAME `external_id`, bounded. A 4xx
 *     means a human must change something — a payload bug, or on 401 an operator
 *     secret — so the reporter latches OFF and says so loudly rather than
 *     hammering a request that cannot start working on its own.
 *
 * A factory rather than a module singleton, so the halt latch is per-instance:
 * a test can build one, drive it into the halted state and throw it away
 * without leaving process-global state behind.
 *
 * Deliberately dependency-free — no db, no pino, no express. It is handed a log
 * sink and (in tests) a fetch, and nothing else.
 */

// ─── Bounds and rules taken from the Chief's CONTRACT.md §4 and §6 ───────────

/** `vendor` — required, 64 chars. */
const VENDOR_MAX = 64;
/** `note` — 200 chars. */
const NOTE_MAX = 200;
/** `external_id` — 128 chars, taken BYTE FOR BYTE or refused with a 400. */
const EXTERNAL_ID_MAX = 128;
/** `amount_usd` — a JSON number, > 0, and at most this sanity ceiling. */
const AMOUNT_MAX_USD = 10_000;

/**
 * The quantum. One report per $0.50 of confirmed-owed spend, per UTC day, per
 * vendor.
 *
 * Whole cents throughout, so there is no float residue to reason about
 * anywhere in the accounting.
 */
export const SPEND_QUANTUM_CENTS = 50;

/**
 * Per-attempt abort.
 *
 * CONTRACT.md §6: the Chief sets no request timeout of its own, does one local
 * SQLite insert per report, and has no outbound call or queue to block on — a
 * healthy response is milliseconds. 3s is ~100x headroom for a cold Reserved VM
 * and a TLS handshake, and keeps a fully exhausted send (3s + 250ms + 3s + 1s +
 * 3s = 10.25s) far inside one sweep interval. It is a background wait in every
 * case; no person is ever behind it.
 */
const DEFAULT_TIMEOUT_MS = 3_000;

/**
 * Backoff before retry N. The array length also sets the attempt count: two
 * delays means at most three attempts. Bounded on purpose — the sweep runs
 * again shortly, and the quantum scheme means a later attempt is deduped rather
 * than double-booked.
 */
const DEFAULT_RETRY_DELAYS_MS = [250, 1_000];

/** Response bodies can be HTML (CONTRACT.md §5). Cap what we log. */
const BODY_LOG_MAX = 300;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ChiefConfig {
  /** Origin with no trailing slash, e.g. `https://chief-ship.replit.app`. */
  origin: string;
  /** The order-token, trimmed. Never logged. */
  token: string;
}

/**
 * Who caused the spend, in the Chief's closed set (CONTRACT.md §4.1).
 *
 * Mirrored in full even though nothing in this app can emit `chief` today —
 * there is no inbound command seam for a chief-caused dollar to come from, and
 * v1 of F-3.7a deliberately does not add one. A narrower local set would mean
 * the order that adds that seam has to remember to widen this one, and
 * forgetting would silently downgrade chief-attributed spend to unattributed,
 * which is precisely the direction that stops the Chief's budget braking.
 */
export const SPEND_INITIATORS = ["chief", "human"] as const;
export type SpendInitiator = (typeof SPEND_INITIATORS)[number];

/**
 * The initiator every dollar this app spends falls under today.
 *
 * Not a neutral default — a true statement. Every LLM call in this app is
 * caused by a person: a sales manager labelling a thread, or the cron
 * continuing a campaign a person started. The Chief brakes its budget only on
 * `chief` spend, so this is also the safe direction if the statement ever stops
 * being true: an under-attributed dollar is recoverable, a wrongly
 * chief-attributed one brakes the orchestrator on work it never ordered.
 */
export const DEFAULT_SPEND_INITIATOR: SpendInitiator = "human";

export interface SpendReport {
  /** Who was paid. Truncated to 64 chars before sending. */
  vendor: string;
  /** USD. Rounded to cents; a report that rounds to zero is skipped, not sent. */
  amountUsd: number;
  /** The idempotency key. Sent byte for byte or the report is skipped. */
  externalId: string;
  note?: string;
  /** Who started the work. Omitted from the payload when absent — never guessed. */
  initiatedBy?: SpendInitiator;
}

export interface ChiefLog {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export type SendOutcome =
  /** 201 (new row) or 200 (an earlier report already used this id). Both are success. */
  | { kind: "recorded"; deduped: boolean; attempts: number }
  /** Refused locally — the payload could not be made to satisfy §4. Nothing was sent. */
  | { kind: "skipped"; reason: string }
  /** The reporter is latched off; nothing was sent. */
  | { kind: "halted"; reason: string }
  /** A 4xx, or a redirect we refused to follow. Not retried; the reporter latches off. */
  | { kind: "refused"; status: number; reason: string; attempts: number }
  /** 5xx, network failure or timeout, retries exhausted. The reporter stays live. */
  | { kind: "unavailable"; reason: string; attempts: number };

export interface ChiefReporter {
  readonly origin: string;
  /** Post one spend report. Never throws. */
  send(report: SpendReport): Promise<SendOutcome>;
  /** Latched-off state, and why. */
  haltedReason(): string | null;
}

export interface ChiefReporterOptions {
  log?: ChiefLog;
  /** Injected in tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retryDelaysMs?: number[];
}

// ─── Config ──────────────────────────────────────────────────────────────────

const NOOP_LOG: ChiefLog = { info() {}, warn() {}, error() {} };

/**
 * Both variables, both non-empty after trimming, or null.
 *
 * Trimming matters on both. CONTRACT.md §3 records that the Chief trims its own
 * copy of a token so a value pasted with a trailing newline still
 * authenticates — but "the Chief trims only its own copy", and §7 says a value
 * empty after trimming counts as unset. Matching that here means
 * `CHIEF_INGEST_TOKEN=" "` is inert rather than a permanent 401 loop, and that
 * our copy of the secret is byte-identical to the Chief's before it goes on the
 * wire. `lib/chiefAuth.ts chiefTokenFromEnv()` applies the identical rule to the
 * inbound copy.
 */
export function resolveChiefConfig(
  env: NodeJS.ProcessEnv = process.env,
): ChiefConfig | null {
  const rawUrl = (env.CHIEF_URL || "").trim();
  const token = (env.CHIEF_INGEST_TOKEN || "").trim();
  if (!rawUrl || !token) return null;

  let origin: string;
  try {
    // Parsed, never string-matched: the origin is the only part kept, so a
    // CHIEF_URL carrying a path, query or fragment cannot bend the endpoint.
    const u = new URL(rawUrl);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    origin = u.origin;
  } catch {
    return null;
  }
  return { origin, token };
}

// ─── Payload preparation (CONTRACT.md §4) ────────────────────────────────────

/**
 * One rule from §4 explains all of this: identity fields are validated, prose is
 * truncated. `external_id` is checked and refused locally rather than clipped —
 * clipping it here would recreate the exact collision (the Chief's gap G7) that
 * once lost a real spend behind a `200`.
 */
export function preparePayload(
  report: SpendReport,
): { ok: true; body: Record<string, unknown> } | { ok: false; reason: string } {
  const vendor = String(report.vendor ?? "").trim().slice(0, VENDOR_MAX);
  if (!vendor) return { ok: false, reason: "vendor empty" };

  const id = report.externalId;
  if (typeof id !== "string") return { ok: false, reason: "external_id not a string" };
  if (id.length === 0 || id.trim().length === 0) return { ok: false, reason: "external_id empty" };
  if (id !== id.trim()) return { ok: false, reason: "external_id padded" };
  if (id.length > EXTERNAL_ID_MAX) return { ok: false, reason: "external_id too long" };

  const raw = report.amountUsd;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return { ok: false, reason: "amount_usd not a finite number" };
  }
  // Rounded to cents so the figure reported is the figure the operator sees.
  // §4 accepts sub-cent amounts, but a report that rounds away to nothing is not
  // worth a row and would be a guaranteed 400 at exactly 0.
  const amountUsd = Math.round(raw * 100) / 100;
  if (amountUsd <= 0) return { ok: false, reason: "amount_usd rounds to zero or below" };
  if (amountUsd > AMOUNT_MAX_USD) return { ok: false, reason: "amount_usd above the sanity ceiling" };

  const body: Record<string, unknown> = { vendor, amount_usd: amountUsd, external_id: id };

  const note = String(report.note ?? "").trim().slice(0, NOTE_MAX);
  if (note) body.note = note;

  // Attribution. An out-of-set value is OMITTED rather than sent: the Chief has
  // closed the set, an out-of-set value is a 400, and a 4xx latches this
  // reporter off for the life of the process. One bad string would stop
  // reporting entirely. An unattributed report is recoverable by a later order;
  // a latched-off reporter is not. TypeScript makes this unreachable; the wire
  // does not care about types and the cost of being wrong is asymmetric.
  const initiatedBy: unknown = report.initiatedBy;
  if (
    typeof initiatedBy === "string" &&
    (SPEND_INITIATORS as readonly string[]).includes(initiatedBy)
  ) {
    body.initiated_by = initiatedBy;
  }

  return { ok: true, body };
}

// ─── Reporter ────────────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Bodies may be HTML (§5). Never `JSON.parse` blindly. */
function describeBody(text: string): string {
  const clipped = text.slice(0, BODY_LOG_MAX);
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object") {
      const e = (parsed as Record<string, unknown>).error;
      if (typeof e === "string") return e;
    }
  } catch {
    /* HTML, or a stack trace outside production. The clipped text is the answer. */
  }
  return clipped;
}

export function createChiefReporter(
  cfg: ChiefConfig,
  opts: ChiefReporterOptions = {},
): ChiefReporter {
  const log = opts.log ?? NOOP_LOG;
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryDelays = opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const endpoint = `${cfg.origin}/api/ingest/spend`;

  let halted: string | null = null;

  // Cleartext warning. The URL parser is the oracle for both the scheme and the
  // host — a string-shape test would have to get IPv6 bracketing right and the
  // parser already does. Wrapped because a throw at construction would take the
  // boot down, which is precisely the class of failure this reporter must not
  // cause.
  try {
    const u = new URL(cfg.origin);
    const loopback =
      u.hostname === "127.0.0.1" ||
      u.hostname === "[::1]" ||
      u.hostname === "::1" ||
      u.hostname === "localhost";
    if (u.protocol !== "https:" && !loopback) {
      log.warn(
        { origin: cfg.origin },
        "CHIEF_URL is not https — the order-token will cross the network in cleartext",
      );
    }
  } catch {
    /* resolveChiefConfig already refuses anything the parser rejects. */
  }

  /** One HTTP attempt. Returns a classification; never throws. */
  async function attempt(bodyJson: string): Promise<
    | { class: "ok"; deduped: boolean }
    | { class: "refused"; status: number; reason: string }
    | { class: "retry"; reason: string }
  > {
    let res: Response;
    try {
      res = await doFetch(endpoint, {
        method: "POST",
        headers: {
          // §3: the scheme prefix is matched case-sensitively.
          authorization: `Bearer ${cfg.token}`,
          // §4: without this exact content type the body is not parsed at all.
          "content-type": "application/json",
        },
        body: bodyJson,
        // Never follow a redirect: it would replay the order-token at whatever
        // host the redirect names, and a 307 would replay the BODY too. The
        // Chief issues none (§1), so a 3xx here is a wiring fault for a human
        // and is classified as refused below.
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // Timeout, DNS failure, connection refused, TLS error. §6: retry.
      const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      return { class: "retry", reason };
    }

    let text = "";
    try {
      text = await res.text();
    } catch {
      /* Body unreadable; the status is what decides. */
    }

    // §5: 201 is a new row, 200 is a dedupe. Both mean the spend is on file.
    if (res.status === 201) return { class: "ok", deduped: false };
    if (res.status === 200) return { class: "ok", deduped: true };

    if (res.status >= 500) {
      return { class: "retry", reason: `HTTP ${res.status}: ${describeBody(text)}` };
    }

    // Everything else — every 4xx, and any redirect we refused to follow — is a
    // human's problem. Never retried, here or on a later sweep.
    return { class: "refused", status: res.status, reason: describeBody(text) };
  }

  return {
    origin: cfg.origin,
    haltedReason: () => halted,

    async send(report: SpendReport): Promise<SendOutcome> {
      try {
        if (halted) return { kind: "halted", reason: halted };

        const prepared = preparePayload(report);
        if (!prepared.ok) {
          log.warn(
            {
              vendor: report.vendor,
              externalId: report.externalId,
              amountUsd: report.amountUsd,
              reason: prepared.reason,
            },
            "Chief spend report skipped before sending",
          );
          return { kind: "skipped", reason: prepared.reason };
        }

        // Serialised ONCE, outside the retry loop. Every attempt therefore
        // carries the identical `external_id` and the identical amount, which is
        // what makes a 5xx retry safe rather than a second charge (§6).
        const bodyJson = JSON.stringify(prepared.body);
        const maxAttempts = retryDelays.length + 1;
        let lastReason = "no attempt made";

        for (let n = 1; n <= maxAttempts; n++) {
          const r = await attempt(bodyJson);

          if (r.class === "ok") {
            return { kind: "recorded", deduped: r.deduped, attempts: n };
          }

          if (r.class === "refused") {
            if (r.status === 401) {
              // §5: retrying cannot fix it. The fix is an operator setting the
              // matching FOLLOWUP_TOKEN on the Chief and restarting it. Loud, once.
              halted = `401 from the Chief — the order-token is not accepted (${r.reason})`;
              log.error(
                { endpoint, status: 401, chiefError: r.reason },
                "CHIEF SPEND REPORTING HALTED: the Chief rejected this app's order-token (401). " +
                  "Spend will NOT be reported until an operator sets FOLLOWUP_TOKEN on the Chief to the " +
                  "same value as CHIEF_INGEST_TOKEN here and restarts both. Nothing in this app can fix it.",
              );
            } else {
              halted = `HTTP ${r.status} from the Chief — ${r.reason}`;
              log.error(
                { endpoint, status: r.status, chiefError: r.reason },
                "CHIEF SPEND REPORTING HALTED: the Chief refused the report and a retry cannot help. " +
                  "Spend will NOT be reported until this is fixed and the app is restarted.",
              );
            }
            return { kind: "refused", status: r.status, reason: r.reason, attempts: n };
          }

          lastReason = r.reason;
          const delay = retryDelays[n - 1];
          if (delay === undefined) break; // attempts exhausted
          log.warn(
            { endpoint, attempt: n, of: maxAttempts, reason: r.reason },
            "Chief spend report failed; retrying with the same external_id",
          );
          await sleep(delay);
        }

        log.warn(
          { endpoint, externalId: report.externalId, attempts: maxAttempts, reason: lastReason },
          "Chief spend report gave up after bounded retries; it will be re-sent on a later sweep",
        );
        return { kind: "unavailable", reason: lastReason, attempts: maxAttempts };
      } catch (err) {
        // Belt and braces. Nothing above is expected to throw, and this function
        // must not be the thing that breaks a caller if something does.
        const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        log.warn({ reason }, "Chief spend reporter hit an internal error");
        return { kind: "unavailable", reason, attempts: 0 };
      }
    },
  };
}

// ─── How much is owed, and under which ids ───────────────────────────────────

/**
 * Given what a (UTC day, vendor) has SPENT and what the Chief has already
 * CONFIRMED — both in whole cents — return the running total each still-owed
 * report starts from. Each report is worth exactly `quantumCents`, and that
 * starting total is what NAMES it, so `amount_usd` is a pure function of
 * `external_id`. That is the property that makes a retry safe against the
 * Chief's first-write-wins dedupe (CONTRACT.md §6).
 *
 * Two consequences, both deliberate:
 *
 *  - A residual smaller than one quantum is NOT reported. It stays owed and is
 *    swept up the moment more spend lands; only a day that closes inside a
 *    quantum drops it. The Chief under-counts by less than one quantum per
 *    vendor per day, which is the safe direction — never a double charge.
 *  - Changing the quantum can never re-report money already on file, because the
 *    cursor is a dollar total rather than a count of reports. Raising it simply
 *    pauses until the gap is wide enough; lowering it resumes from the same
 *    total under fresh ids.
 */
export function pendingReportOffsets(
  spentCents: number,
  reportedCents: number,
  quantumCents: number,
  max: number,
): number[] {
  const out: number[] = [];
  if (!Number.isFinite(spentCents) || !Number.isFinite(reportedCents)) return out;
  if (!Number.isFinite(quantumCents) || quantumCents <= 0 || max <= 0) return out;
  const spent = Math.trunc(spentCents);
  const q = Math.trunc(quantumCents);
  let at = Math.max(0, Math.trunc(reportedCents));
  while (spent - at >= q && out.length < max) {
    out.push(at);
    at += q;
  }
  return out;
}

// ─── The external_id namespace ───────────────────────────────────────────────

/**
 * The id one spend report is filed under — the whole namespace in one function,
 * so it cannot be spelled two ways in two places.
 *
 * `followup-<utc day>-<vendor>-<offset in cents>`. The app segment is the
 * Chief's identity for this app, and it is redundant (ids are already scoped per
 * app on the Chief, CONTRACT.md §6) — it is there so an id read out of a ledger
 * row during an incident says which app wrote it without a join.
 *
 * NO INITIATOR SEGMENT, deliberately, and this is where a future order must be
 * careful. Every dollar this app spends is `human` (see
 * `DEFAULT_SPEND_INITIATOR`), so there is exactly one bucket per (day, vendor)
 * and one form of id. When an inbound command seam eventually makes `chief`
 * spend possible, the human namespace must NOT move one byte: putting the
 * initiator into every id would re-name money already on file, and the Chief —
 * which dedupes on `(app, external_id)` and cannot know the two forms mean the
 * same bucket — would book up to a day of history a second time as phantom
 * spend. Encode `chief` as an ADDED segment and leave `human` as the absence of
 * one, exactly as the Prospector did in P-3.4a.
 */
export function chiefSpendExternalId(opts: {
  dayKey: string;
  vendor: string;
  /** The running cents total this report starts from — see pendingReportOffsets. */
  offsetCents: number;
}): string {
  return `followup-${opts.dayKey}-${opts.vendor}-${opts.offsetCents}`;
}

// ─── Vendor naming ───────────────────────────────────────────────────────────

/**
 * Map a model id to the company that bills for it.
 *
 * The Chief rolls spend up BY VENDOR (§4), so this string has to stay stable
 * across reports for ever — an inconsistent value silently splits one vendor
 * into two lines in the operator's console, and the cursor keyed on it would
 * restart from zero. Model ids come and go; these names do not.
 *
 * The same three names the Prospector uses, so one console line means the same
 * thing whichever app reported it.
 */
export function vendorForModel(model: string): string {
  const m = String(model || "").trim().toLowerCase();
  if (m.startsWith("claude-")) return "anthropic";
  if (m.startsWith("gemini-")) return "google";
  if (m.startsWith("gpt-") || m.startsWith("o1-") || m.startsWith("o3-")) return "openai";
  return "other";
}
