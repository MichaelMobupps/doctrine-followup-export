/**
 * test-chief-spend.ts — F-3.7a.
 *
 * The outbound half: the accounting that decides WHAT to report, and the client
 * that reports it. `lib/chiefSpend.ts` has no db, no express and no logger, so
 * every case below runs against the real code with an injected `fetch` and no
 * network of any kind.
 *
 * The properties pinned here are the ones that cost real money when they break:
 *
 *   1. AN AMOUNT IS A PURE FUNCTION OF ITS `external_id`. That is the entire
 *      basis on which a retry is safe against the Chief's first-write-wins
 *      dedupe. If two different amounts could ever share an id, one of them is
 *      silently discarded with a `200`.
 *   2. THE CURSOR IS A DOLLAR TOTAL, NOT A COUNT. Changing the quantum must
 *      never re-report money already on file.
 *   3. A 4xx IS NEVER RETRIED AND LATCHES THE REPORTER OFF; a 5xx IS retried
 *      with the SAME id. Retrying a 400 hammers a request that cannot start
 *      working; changing the id on a 5xx retry books the money twice.
 *   4. UNCONFIGURED IS INERT. No origin, no token, no reporter.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx --test src/tests/test-chief-spend.ts
 */
import * as test from "node:test";
import * as assert from "node:assert/strict";
import {
  SPEND_QUANTUM_CENTS,
  chiefSpendExternalId,
  createChiefReporter,
  pendingReportOffsets,
  preparePayload,
  resolveChiefConfig,
  vendorForModel,
} from "../lib/chiefSpend";

const CFG = { origin: "https://chief-ship.replit.app", token: "t".repeat(64) };

interface Seen {
  url: string;
  body: Record<string, unknown>;
  auth: string | undefined;
  redirect: string | undefined;
}

/** A fake Chief. Answers a scripted sequence; records every request. */
function fakeChief(script: Array<{ status: number; body?: string }>): {
  fetchImpl: typeof fetch;
  seen: Seen[];
} {
  const seen: Seen[] = [];
  let n = 0;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seen.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? "{}")),
      auth: headers.authorization,
      redirect: init?.redirect,
    });
    const step = script[Math.min(n, script.length - 1)];
    n += 1;
    return new Response(step.body ?? "", { status: step.status });
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

/** A fake Chief that always throws — a DNS failure, a refused connection. */
function deadChief(): { fetchImpl: typeof fetch; calls: () => number } {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    throw Object.assign(new Error("connect ECONNREFUSED"), { name: "TypeError" });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls: () => calls };
}

const FAST = { retryDelaysMs: [1, 1], timeoutMs: 50 };

test.describe("resolveChiefConfig", () => {
  test.it("is null unless BOTH variables are set and non-empty after trimming", () => {
    assert.equal(resolveChiefConfig({}), null);
    assert.equal(resolveChiefConfig({ CHIEF_URL: "https://x.example" }), null);
    assert.equal(resolveChiefConfig({ CHIEF_INGEST_TOKEN: "t" }), null);
    assert.equal(resolveChiefConfig({ CHIEF_URL: "https://x.example", CHIEF_INGEST_TOKEN: "  " }), null);
    assert.equal(resolveChiefConfig({ CHIEF_URL: "   ", CHIEF_INGEST_TOKEN: "t" }), null);
  });

  test.it("keeps only the ORIGIN, so a URL carrying a path cannot bend the endpoint", () => {
    const cfg = resolveChiefConfig({
      CHIEF_URL: "https://chief-ship.replit.app/some/prefix?x=1#y",
      CHIEF_INGEST_TOKEN: " tok \n",
    });
    assert.deepEqual(cfg, { origin: "https://chief-ship.replit.app", token: "tok" });
  });

  test.it("refuses a scheme a token must never be handed to", () => {
    assert.equal(resolveChiefConfig({ CHIEF_URL: "file:///etc/passwd", CHIEF_INGEST_TOKEN: "t" }), null);
    assert.equal(resolveChiefConfig({ CHIEF_URL: "not a url", CHIEF_INGEST_TOKEN: "t" }), null);
  });
});

test.describe("vendorForModel", () => {
  test.it("maps this app's real models onto the Chief's vendor names", () => {
    // Every model in lib/pricing.ts, so a new tier cannot silently become
    // `other` and split a vendor into two console lines.
    assert.equal(vendorForModel("claude-opus-4-8"), "anthropic");
    assert.equal(vendorForModel("claude-sonnet-4-5-20250929"), "anthropic");
    assert.equal(vendorForModel("claude-haiku-4-5"), "anthropic");
    assert.equal(vendorForModel("gemini-3.5-flash"), "google");
    assert.equal(vendorForModel("gemini-3.1-flash-lite"), "google");
    assert.equal(vendorForModel("gpt-4o"), "openai");
    assert.equal(vendorForModel("something-else"), "other");
    assert.equal(vendorForModel(""), "other");
  });

  test.it("is case- and whitespace-insensitive", () => {
    assert.equal(vendorForModel("  CLAUDE-Opus-4-8 "), "anthropic");
  });
});

test.describe("pendingReportOffsets — the accounting", () => {
  test.it("emits one offset per whole quantum of the gap", () => {
    assert.deepEqual(pendingReportOffsets(160, 0, 50, 10), [0, 50, 100]);
  });

  test.it("resumes from the cursor, never from zero", () => {
    assert.deepEqual(pendingReportOffsets(160, 100, 50, 10), [100]);
  });

  test.it("reports NOTHING for a residual under one quantum — the safe direction", () => {
    // The Chief under-counts by less than one quantum per vendor per day and can
    // never over-count. There is no correction path on the Chief, so this is the
    // only direction the error is allowed to go.
    assert.deepEqual(pendingReportOffsets(49, 0, 50, 10), []);
    assert.deepEqual(pendingReportOffsets(149, 100, 50, 10), []);
  });

  test.it("emits nothing when the cursor is level with or ahead of the spend", () => {
    assert.deepEqual(pendingReportOffsets(100, 100, 50, 10), []);
    assert.deepEqual(pendingReportOffsets(100, 150, 50, 10), []);
  });

  test.it("honours the per-sweep cap", () => {
    assert.deepEqual(pendingReportOffsets(1000, 0, 50, 3), [0, 50, 100]);
  });

  test.it("is total against nonsense rather than throwing or looping", () => {
    assert.deepEqual(pendingReportOffsets(NaN, 0, 50, 10), []);
    assert.deepEqual(pendingReportOffsets(100, NaN, 50, 10), []);
    assert.deepEqual(pendingReportOffsets(100, 0, 0, 10), []);
    assert.deepEqual(pendingReportOffsets(100, 0, -50, 10), []);
    assert.deepEqual(pendingReportOffsets(100, 0, 50, 0), []);
  });

  test.it("LOWERING the quantum cannot re-report money already on file", () => {
    // The cursor is a dollar total. Five $0.50 reports have confirmed 250c; at
    // a $0.10 quantum the next id starts at 250, not at 0.
    const spent = 300;
    const afterFive = 250;
    assert.deepEqual(pendingReportOffsets(spent, afterFive, 10, 10), [250, 260, 270, 280, 290]);
    // A chunk COUNTER would have restarted at chunk 5 * 10c = 50c and re-sent
    // 200c of history under fresh ids. It cannot happen here because the state
    // is a total.
  });
});

test.describe("chiefSpendExternalId", () => {
  test.it("names the app, the UTC day, the vendor and the running total", () => {
    assert.equal(
      chiefSpendExternalId({ dayKey: "2026-08-11", vendor: "anthropic", offsetCents: 150 }),
      "followup-2026-08-11-anthropic-150",
    );
  });

  test.it("an id determines its amount — the same id can only ever mean one quantum", () => {
    // The whole basis of retry safety. Two distinct buckets or two distinct
    // offsets must never collide.
    const ids = new Set<string>();
    for (const day of ["2026-08-10", "2026-08-11"]) {
      for (const vendor of ["anthropic", "google", "openai", "other"]) {
        for (let off = 0; off < 500; off += SPEND_QUANTUM_CENTS) {
          ids.add(chiefSpendExternalId({ dayKey: day, vendor, offsetCents: off }));
        }
      }
    }
    assert.equal(ids.size, 2 * 4 * 10);
  });

  test.it("stays inside the Chief's 128-character bound at every plausible size", () => {
    const id = chiefSpendExternalId({
      dayKey: "2026-08-11",
      vendor: "anthropic",
      offsetCents: 99_999_999,
    });
    assert.ok(id.length <= 128, id);
  });
});

test.describe("preparePayload", () => {
  test.it("builds exactly the fields the Chief's §4 accepts", () => {
    const p = preparePayload({
      vendor: "anthropic",
      amountUsd: 0.5,
      externalId: "followup-2026-08-11-anthropic-0",
      initiatedBy: "human",
    });
    assert.ok(p.ok);
    assert.deepEqual(p.body, {
      vendor: "anthropic",
      amount_usd: 0.5,
      external_id: "followup-2026-08-11-anthropic-0",
      initiated_by: "human",
    });
  });

  test.it("REFUSES an over-long or padded external_id rather than clipping it", () => {
    // Clipping is the Chief's gap G7: two distinct ids sharing a prefix
    // collided, the second came back `200 deduped`, and a real spend vanished.
    const long = "x".repeat(129);
    assert.deepEqual(preparePayload({ vendor: "v", amountUsd: 1, externalId: long }), {
      ok: false,
      reason: "external_id too long",
    });
    assert.deepEqual(preparePayload({ vendor: "v", amountUsd: 1, externalId: " id " }), {
      ok: false,
      reason: "external_id padded",
    });
  });

  test.it("refuses an amount that is not a positive finite number", () => {
    for (const bad of [0, -1, Number.POSITIVE_INFINITY, NaN, 0.004]) {
      const p = preparePayload({ vendor: "v", amountUsd: bad, externalId: "k" });
      assert.equal(p.ok, false, String(bad));
    }
    assert.equal(preparePayload({ vendor: "v", amountUsd: 10_001, externalId: "k" }).ok, false);
  });

  test.it("OMITS an out-of-set initiator rather than sending it", () => {
    // An out-of-set value is a 400, and a 4xx latches the reporter off for the
    // life of the process. One bad string must not stop all reporting.
    const p = preparePayload({
      vendor: "v",
      amountUsd: 1,
      externalId: "k",
      initiatedBy: "Chief" as unknown as "chief",
    });
    assert.ok(p.ok);
    assert.equal("initiated_by" in p.body, false);
  });
});

test.describe("the reporter", () => {
  test.it("posts to /api/ingest/spend with a Bearer token and refuses redirects", async () => {
    const { fetchImpl, seen } = fakeChief([{ status: 201, body: '{"recorded":true,"deduped":false}' }]);
    const r = createChiefReporter(CFG, { fetchImpl, ...FAST });
    const out = await r.send({ vendor: "anthropic", amountUsd: 0.5, externalId: "k1", initiatedBy: "human" });
    assert.deepEqual(out, { kind: "recorded", deduped: false, attempts: 1 });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, "https://chief-ship.replit.app/api/ingest/spend");
    assert.equal(seen[0].auth, `Bearer ${CFG.token}`);
    // A followed 307 would replay both the token and the body at another origin.
    assert.equal(seen[0].redirect, "manual");
  });

  test.it("treats a 200 as success — the idempotency path", async () => {
    const { fetchImpl } = fakeChief([{ status: 200, body: '{"recorded":true,"deduped":true}' }]);
    const r = createChiefReporter(CFG, { fetchImpl, ...FAST });
    const out = await r.send({ vendor: "anthropic", amountUsd: 0.5, externalId: "k1" });
    assert.deepEqual(out, { kind: "recorded", deduped: true, attempts: 1 });
  });

  test.it("a replayed report is byte-identical, which is what makes the dedupe safe", async () => {
    const { fetchImpl, seen } = fakeChief([
      { status: 201, body: '{"recorded":true,"deduped":false}' },
      { status: 200, body: '{"recorded":true,"deduped":true}' },
    ]);
    const r = createChiefReporter(CFG, { fetchImpl, ...FAST });
    const report = {
      vendor: "anthropic",
      amountUsd: 0.5,
      externalId: "followup-2026-08-11-anthropic-0",
      initiatedBy: "human" as const,
    };
    const first = await r.send(report);
    const second = await r.send(report);
    assert.deepEqual(first, { kind: "recorded", deduped: false, attempts: 1 });
    assert.deepEqual(second, { kind: "recorded", deduped: true, attempts: 1 });
    assert.deepEqual(seen[0].body, seen[1].body);
  });

  test.it("retries a 5xx with the SAME external_id and the SAME amount", async () => {
    const { fetchImpl, seen } = fakeChief([
      { status: 503, body: "<pre>Service Unavailable</pre>" },
      { status: 500, body: "boom" },
      { status: 201, body: '{"recorded":true,"deduped":false}' },
    ]);
    const r = createChiefReporter(CFG, { fetchImpl, ...FAST });
    const out = await r.send({ vendor: "anthropic", amountUsd: 0.5, externalId: "k5" });
    assert.deepEqual(out, { kind: "recorded", deduped: false, attempts: 3 });
    assert.equal(seen.length, 3);
    assert.equal(new Set(seen.map((s) => JSON.stringify(s.body))).size, 1);
  });

  test.it("gives up after bounded retries and STAYS LIVE for the next sweep", async () => {
    const { fetchImpl, calls } = deadChief();
    const r = createChiefReporter(CFG, { fetchImpl, ...FAST });
    const out = await r.send({ vendor: "anthropic", amountUsd: 0.5, externalId: "k6" });
    assert.equal(out.kind, "unavailable");
    assert.equal(calls(), 3);
    assert.equal(r.haltedReason(), null);
  });

  test.it("NEVER retries a 400, and latches off", async () => {
    const { fetchImpl, seen } = fakeChief([{ status: 400, body: '{"error":"vendor required"}' }]);
    const r = createChiefReporter(CFG, { fetchImpl, ...FAST });
    const out = await r.send({ vendor: "anthropic", amountUsd: 0.5, externalId: "k7" });
    assert.equal(out.kind, "refused");
    assert.equal(seen.length, 1, "a 4xx must not be retried");
    assert.ok(r.haltedReason());
    // And every later report is refused locally, without a socket.
    const after = await r.send({ vendor: "anthropic", amountUsd: 0.5, externalId: "k8" });
    assert.equal(after.kind, "halted");
    assert.equal(seen.length, 1);
  });

  test.it("a 401 halts loudly and names the operator fix, without printing the token", async () => {
    const lines: string[] = [];
    const log = {
      info: () => {},
      warn: () => {},
      error: (_o: Record<string, unknown>, m: string) => lines.push(m),
    };
    const { fetchImpl } = fakeChief([{ status: 401, body: '{"error":"valid order-token required"}' }]);
    const r = createChiefReporter(CFG, { fetchImpl, log, ...FAST });
    const out = await r.send({ vendor: "anthropic", amountUsd: 0.5, externalId: "k9" });
    assert.equal(out.kind, "refused");
    assert.equal((out as { status: number }).status, 401);
    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes("FOLLOWUP_TOKEN"));
    assert.ok(!lines.join(" ").includes(CFG.token));
  });

  test.it("scrubs the order-token out of anything the other side says back", async () => {
    // Not the Chief itself — its 401 body is fixed. The realistic source is a
    // proxy or a deployment interstitial in front of it echoing the request
    // headers into an error page, which would otherwise walk the token into
    // this app's log where nobody would ever notice it.
    const lines: Array<Record<string, unknown>> = [];
    const log = {
      info: () => {},
      warn: () => {},
      error: (o: Record<string, unknown>) => lines.push(o),
    };
    const { fetchImpl } = fakeChief([
      { status: 400, body: `<pre>Bad Request: Authorization: Bearer ${CFG.token}</pre>` },
    ]);
    const r = createChiefReporter(CFG, { fetchImpl, log, ...FAST });
    const out = await r.send({ vendor: "anthropic", amountUsd: 0.5, externalId: "kS" });
    assert.equal(out.kind, "refused");
    const everything = JSON.stringify(lines) + JSON.stringify(out) + String(r.haltedReason());
    assert.ok(!everything.includes(CFG.token), "the token must not survive into a log or an outcome");
    assert.ok(everything.includes("[redacted]"));
  });

  test.it("a 3xx is a refusal, not a hop — the token never follows a redirect", async () => {
    const { fetchImpl, seen } = fakeChief([{ status: 307, body: "" }]);
    const r = createChiefReporter(CFG, { fetchImpl, ...FAST });
    const out = await r.send({ vendor: "anthropic", amountUsd: 0.5, externalId: "k10" });
    assert.equal(out.kind, "refused");
    assert.equal(seen.length, 1);
  });

  test.it("refuses a bad payload locally, without opening a socket", async () => {
    const { fetchImpl, seen } = fakeChief([{ status: 201 }]);
    const r = createChiefReporter(CFG, { fetchImpl, ...FAST });
    const out = await r.send({ vendor: "", amountUsd: 0.5, externalId: "k11" });
    assert.equal(out.kind, "skipped");
    assert.equal(seen.length, 0);
  });

  test.it("never throws, whatever the transport does", async () => {
    const fetchImpl = (() => {
      throw new Error("synchronous explosion");
    }) as unknown as typeof fetch;
    const r = createChiefReporter(CFG, { fetchImpl, ...FAST });
    const out = await r.send({ vendor: "v", amountUsd: 1, externalId: "k12" });
    assert.equal(out.kind, "unavailable");
  });
});
