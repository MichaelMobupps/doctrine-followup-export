/**
 * test-base-path.ts
 *
 * Bundle 2 contract tests for BASE_PATH / PUBLIC_URL, in BOTH modes.
 *
 * The three properties pinned here are the ones whose failure modes are
 * silent or catastrophic:
 *
 *   1. DARKNESS — with both env vars unset every helper returns byte-for-byte
 *      what it returned before Bundle 2. Rollback is "unset the vars", so this
 *      is the property the rollback depends on.
 *   2. ONE PREFIX — PUBLIC_URL already carries the prefix, so an outgoing URL
 *      must never contain it twice. A doubled prefix produces an OAuth
 *      redirect_uri Google rejects, and the failure only shows at cutover.
 *   3. NO SELF-REDIRECT LOOP — the bare-prefix redirect must never target the
 *      path it was reached at. Express routing is non-strict, so the naive
 *      spelling of this redirect matches its own target and takes the main
 *      page down. Two sibling apps in this migration hit it.
 *
 * Security regression guards for the two Bundle 1 defects are included and
 * use a URL-PARSER ORACLE, not string shape: the Bundle 1 string check passed
 * while "/\evil.example" still resolved off-site.
 *
 * appUrls reads env at module load, so each mode re-imports it under a
 * distinct query string to defeat the module cache.
 *
 * No DB, no network.
 * Run: pnpm --filter @workspace/api-server exec tsx --test src/tests/test-base-path.ts
 */
import * as test from "node:test";
import * as assert from "node:assert/strict";

type AppUrls = typeof import("../lib/appUrls");

const ENV_KEYS = [
  "BASE_PATH",
  "PUBLIC_URL",
  "APP_URL",
  "REPLIT_DEV_DOMAIN",
  "REPLIT_DOMAINS",
] as const;

let loadCounter = 0;

async function loadWith(env: Partial<Record<(typeof ENV_KEYS)[number], string>>): Promise<AppUrls> {
  for (const k of ENV_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  return (await import(`../lib/appUrls.ts?case=${loadCounter++}`)) as AppUrls;
}

/**
 * Count how many PATH SEGMENTS equal the prefix.
 *
 * Substring counting is wrong here and it bit the live smoke: "/followup" also
 * occurs inside "/followups", a real route name, so `url.split("/followup")`
 * reports a false double-prefix for "/followup/api/followups".
 */
function prefixSegmentCount(value: string, prefix: string): number {
  const seg = prefix.replace(/^\/+|\/+$/g, "");
  const pathOnly = value.split("?")[0].replace(/^https?:\/\/[^/]+/, "");
  return pathOnly.split("/").filter(Boolean).filter((s) => s === seg).length;
}

/** Resolve as a browser resolves a Location header, and report the host. */
function resolvedHost(value: string, ourOrigin = "https://good.example"): string {
  try {
    return new URL(value, ourOrigin).host;
  } catch {
    return "<unparseable>";
  }
}

const PROD_APP_URL = "https://followupper.mobupps.net";
const LIT_BASE = "/followup/";
const LIT_PUBLIC = "https://tools.mobupps.net/followup";

// The exact literals the two OAuth routers pass.
const AUTH_REDIRECTS = [
  "/?login_error=denied",
  "/?login_error=missing_params",
  "/?login_error=expired",
  "/?login_error=no_email",
  "/?login_error=unauthorized_domain",
  "/?login_error=failed",
];
const GMAIL_REDIRECTS = [
  "/?oauth_error=denied",
  "/?oauth_error=missing_params",
  "/?oauth_error=invalid_state",
  "/accounts?oauth_error=no_refresh_token",
  "/accounts?oauth_error=no_email",
  "/accounts?oauth_error=callback_failed",
];

// ---------------------------------------------------------------------------
// 1. DARK MODE — byte-for-byte identical to pre-Bundle-2
// ---------------------------------------------------------------------------

test.describe("dark mode (BASE_PATH and PUBLIC_URL unset)", () => {
  test.it("BASE_PATH defaults to /", async () => {
    const m = await loadWith({});
    assert.equal(m.BASE_PATH, "/");
  });

  test.it("appPath is the identity on rooted paths", async () => {
    const m = await loadWith({});
    for (const p of [...AUTH_REDIRECTS, ...GMAIL_REDIRECTS, "/", "/accounts"]) {
      assert.equal(m.appPath(p), p);
    }
  });

  test.it("production APP_URL reproduces the exact legacy redirect URIs", async () => {
    const m = await loadWith({ APP_URL: PROD_APP_URL });
    assert.equal(m.publicUrl("/api/auth/callback"), `${PROD_APP_URL}/api/auth/callback`);
    assert.equal(m.publicUrl("/api/gmail/callback"), `${PROD_APP_URL}/api/gmail/callback`);
  });

  test.it("login redirects keep the absolute form built from APP_URL", async () => {
    const m = await loadWith({ APP_URL: PROD_APP_URL });
    for (const p of AUTH_REDIRECTS) {
      assert.equal(m.redirectPath(p), `${PROD_APP_URL}${p}`);
    }
  });

  test.it("with no APP_URL, login redirects are relative (the legacy '' base)", async () => {
    const m = await loadWith({});
    for (const p of AUTH_REDIRECTS) assert.equal(m.redirectPath(p), p);
  });

  test.it("gmail redirects stay RELATIVE even when APP_URL is set", async () => {
    // The deliberate asymmetry Bundle 1 recorded: gmail-auth.ts uses appPath,
    // auth.ts uses redirectPath. Collapsing them is a behavior change.
    const m = await loadWith({ APP_URL: PROD_APP_URL });
    for (const p of GMAIL_REDIRECTS) assert.equal(m.appPath(p), p);
  });

  test.it("falls back to the Replit domain with no prefix appended", async () => {
    const m = await loadWith({ REPLIT_DEV_DOMAIN: "abc.riker.replit.dev" });
    assert.equal(m.publicOrigin(), "https://abc.riker.replit.dev");
    assert.equal(
      m.publicUrl("/api/auth/callback"),
      "https://abc.riker.replit.dev/api/auth/callback",
    );
  });

  test.it("a trailing slash on APP_URL is stripped, as before", async () => {
    const m = await loadWith({ APP_URL: `${PROD_APP_URL}/` });
    assert.equal(m.publicUrl("/api/auth/callback"), `${PROD_APP_URL}/api/auth/callback`);
  });
});

// ---------------------------------------------------------------------------
// 2. LIT MODE — prefix applied exactly once
// ---------------------------------------------------------------------------

test.describe("lit mode (BASE_PATH=/followup/)", () => {
  test.it("BASE_PATH normalizes away the trailing slash", async () => {
    const m = await loadWith({ BASE_PATH: LIT_BASE });
    assert.equal(m.BASE_PATH, "/followup");
  });

  test.it("both spellings of the prefix normalize identically", async () => {
    const withSlash = await loadWith({ BASE_PATH: "/followup/" });
    const without = await loadWith({ BASE_PATH: "/followup" });
    assert.equal(withSlash.BASE_PATH, without.BASE_PATH);
    assert.equal(withSlash.appPath("/accounts"), without.appPath("/accounts"));
  });

  test.it("appPath prefixes relative redirects exactly once", async () => {
    const m = await loadWith({ BASE_PATH: LIT_BASE, PUBLIC_URL: LIT_PUBLIC });
    assert.equal(m.appPath("/accounts?oauth_error=no_email"), "/followup/accounts?oauth_error=no_email");
    assert.equal(m.appPath("/?oauth_error=denied"), "/followup/?oauth_error=denied");
    assert.equal(m.appPath("/"), "/followup");
  });

  test.it("publicUrl carries EXACTLY ONE prefix", async () => {
    const m = await loadWith({ BASE_PATH: LIT_BASE, PUBLIC_URL: LIT_PUBLIC });
    for (const cb of ["/api/auth/callback", "/api/gmail/callback"]) {
      const out = m.publicUrl(cb);
      assert.equal(out, `${LIT_PUBLIC}${cb}`);
      assert.equal(
        prefixSegmentCount(out, "/followup"),
        1,
        `expected exactly one "/followup" in ${out}`,
      );
    }
  });

  test.it("redirectPath carries EXACTLY ONE prefix", async () => {
    const m = await loadWith({ BASE_PATH: LIT_BASE, PUBLIC_URL: LIT_PUBLIC });
    for (const p of AUTH_REDIRECTS) {
      const out = m.redirectPath(p);
      assert.equal(out, `${LIT_PUBLIC}${p}`);
      assert.equal(prefixSegmentCount(out, "/followup"), 1, `doubled prefix in ${out}`);
    }
  });

  test.it("PUBLIC_URL unset but BASE_PATH set still yields one prefix", async () => {
    const m = await loadWith({ BASE_PATH: LIT_BASE, REPLIT_DEV_DOMAIN: "abc.riker.replit.dev" });
    assert.equal(m.publicOrigin(), "https://abc.riker.replit.dev/followup");
    const out = m.publicUrl("/api/gmail/callback");
    assert.equal(out, "https://abc.riker.replit.dev/followup/api/gmail/callback");
    assert.equal(prefixSegmentCount(out, "/followup"), 1);
  });

  test.it("gmail redirects stay relative AND prefixed", async () => {
    const m = await loadWith({ BASE_PATH: LIT_BASE, PUBLIC_URL: LIT_PUBLIC });
    for (const p of GMAIL_REDIRECTS) {
      const out = m.appPath(p);
      assert.ok(out.startsWith("/followup/"), `${out} must be relative and prefixed`);
      assert.ok(!out.includes("://"), `${out} must stay relative`);
      assert.equal(prefixSegmentCount(out, "/followup"), 1);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. BARE-PREFIX REDIRECT — must never target itself
// ---------------------------------------------------------------------------

/**
 * The decision app.ts makes, in isolation. app.ts compares `req.path` to
 * BASE_PATH by exact string equality and redirects to BASE_PATH + "/".
 */
function barePrefixTarget(basePath: string, reqPath: string): string | null {
  if (reqPath !== basePath) return null;
  return `${basePath}/`;
}

test.describe("bare-prefix redirect", () => {
  test.it("redirects the bare prefix to the trailing-slash form", async () => {
    const m = await loadWith({ BASE_PATH: LIT_BASE });
    assert.equal(barePrefixTarget(m.BASE_PATH, "/followup"), "/followup/");
  });

  test.it("does NOT fire on the trailing-slash form — no self-redirect loop", async () => {
    const m = await loadWith({ BASE_PATH: LIT_BASE });
    // Express's non-strict routing would have matched this path too. If the
    // guard ever regresses to a route match, this returns "/followup/" and the
    // main page redirects to itself forever.
    assert.equal(barePrefixTarget(m.BASE_PATH, "/followup/"), null);
  });

  test.it("the redirect target never equals the request path", async () => {
    const m = await loadWith({ BASE_PATH: LIT_BASE });
    for (const reqPath of ["/followup", "/followup/", "/followup/pipeline", "/followup/api/stats"]) {
      const target = barePrefixTarget(m.BASE_PATH, reqPath);
      if (target !== null) {
        assert.notEqual(target, reqPath, `self-redirect loop at ${reqPath}`);
      }
    }
  });

  test.it("does not fire on deeper paths or on a prefix-lookalike", async () => {
    const m = await loadWith({ BASE_PATH: LIT_BASE });
    for (const p of ["/followup/pipeline", "/followupper", "/", "/api/healthz"]) {
      assert.equal(barePrefixTarget(m.BASE_PATH, p), null, `should not fire on ${p}`);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. REPAIR L1 — legacy address survival
//
// The prefix is live in production while the unprefixed address is still
// reachable, so both must work at once. Two rules cooperate and they must
// agree: the server 307 (legacyRedirectTarget, exercised directly here) and
// the client pre-mount redirect in dashboard/src/main.tsx.
// ---------------------------------------------------------------------------

/** Every path the Apps Script add-on calls. addon/*.gs, verbatim. */
const ADDON_PATHS = [
  "/api/sync",
  "/api/queue",
  "/api/queue-batch",
  "/api/cancel",
  "/api/stats",
  "/api/prospects",
  "/api/followups",
  "/api/prospect/by-thread/abc123",
];

/** The other unprefixed machine callers: OAuth callbacks + platform health. */
const MACHINE_PATHS = [
  "/api/auth/callback",
  "/api/gmail/callback",
  "/api/auth/google",
  "/api/gmail/auth",
  "/api/healthz",
];

/** Browser paths that exist only at the legacy address. */
const LEGACY_BROWSER_PATHS = ["/", "/pipeline", "/accounts", "/anti-ghosting", "/favicon.svg"];

/**
 * MIRROR of the client rule in dashboard/src/main.tsx. Kept here because the
 * dashboard has no test runner, and pinned by the agreement test below: if
 * either side's boundary logic drifts, that test fails rather than the two
 * quietly disagreeing about which paths are "already prefixed".
 *
 * `clientBase` is main.tsx's BASE_PATH (trailing slash); `routerBase` is its
 * ROUTER_BASE (no trailing slash).
 */
function clientRedirectTarget(
  clientBase: string,
  pathname: string,
  search = "",
  hash = "",
): string | null {
  if (clientBase === "/") return null;
  const routerBase = clientBase.replace(/\/$/, "");
  if (pathname === routerBase || pathname.startsWith(clientBase)) return null;
  return `${routerBase}${pathname}${search}${hash}`;
}

test.describe("repair L1: legacy address survival", () => {
  test.it("dark mode has no rule at all — every path is left alone", async () => {
    const m = await loadWith({});
    for (const p of [...LEGACY_BROWSER_PATHS, ...ADDON_PATHS, ...MACHINE_PATHS, "/followup/x"]) {
      assert.equal(m.legacyRedirectTarget(p), null, `dark mode must not redirect ${p}`);
    }
    assert.equal(clientRedirectTarget("/", "/pipeline"), null);
  });

  test.it("lit mode sends legacy BROWSER paths to the prefixed path", async () => {
    const m = await loadWith({ BASE_PATH: LIT_BASE, PUBLIC_URL: LIT_PUBLIC });
    assert.equal(m.legacyRedirectTarget("/"), "/followup/");
    assert.equal(m.legacyRedirectTarget("/pipeline"), "/followup/pipeline");
    assert.equal(m.legacyRedirectTarget("/accounts"), "/followup/accounts");
    assert.equal(m.legacyRedirectTarget("/favicon.svg"), "/followup/favicon.svg");
  });

  test.it("lit mode NEVER redirects a machine caller — the /api mount stays first-class", async () => {
    const m = await loadWith({ BASE_PATH: LIT_BASE, PUBLIC_URL: LIT_PUBLIC });
    for (const p of [...ADDON_PATHS, ...MACHINE_PATHS]) {
      assert.equal(m.legacyRedirectTarget(p), null, `${p} must reach its handler, not a 307`);
    }
  });

  test.it("a doubled-slash API path is never redirected away from the /api mount", async () => {
    // A trailing slash on the add-on's BACKEND_URL produces "//api/sync".
    // Tested raw it fails the "/api" membership test and would be 307'd to
    // "/followup//api/sync". It still 404s either way — Express does not match
    // a doubled slash to the mount, on main and in dark mode alike — so this
    // pins "no misleading redirect", not "the misconfiguration works".
    const m = await loadWith({ BASE_PATH: LIT_BASE });
    for (const p of ADDON_PATHS) {
      assert.equal(m.legacyRedirectTarget(`/${p}`), null, `//${p} must not be redirected`);
    }
  });

  test.it("already-prefixed paths are left alone — no redirect loop", async () => {
    const m = await loadWith({ BASE_PATH: LIT_BASE });
    for (const p of ["/followup", "/followup/", "/followup/pipeline", "/followup/api/stats"]) {
      assert.equal(m.legacyRedirectTarget(p), null, `loop risk at ${p}`);
    }
  });

  test.it("the rule is idempotent — its own target never re-enters it", async () => {
    const m = await loadWith({ BASE_PATH: LIT_BASE });
    for (const p of LEGACY_BROWSER_PATHS) {
      const first = m.legacyRedirectTarget(p);
      assert.notEqual(first, null, `${p} should redirect once`);
      assert.notEqual(first, p, `self-redirect loop at ${p}`);
      assert.equal(m.legacyRedirectTarget(first as string), null, `second hop at ${first}`);
    }
  });

  test.it("a prefix-lookalike is NOT mistaken for an already-prefixed path", async () => {
    // "/followupper" startsWith "/followup". A substring test would skip it and
    // leave exactly the blank page this repair exists to remove.
    const m = await loadWith({ BASE_PATH: LIT_BASE });
    assert.equal(m.legacyRedirectTarget("/followupper"), "/followup/followupper");
    assert.equal(m.legacyRedirectTarget("/followups"), "/followup/followups");
  });

  test.it("client and server agree on every path", async () => {
    const m = await loadWith({ BASE_PATH: LIT_BASE });
    const corpus = [
      ...LEGACY_BROWSER_PATHS,
      ...ADDON_PATHS,
      ...MACHINE_PATHS,
      "/followup",
      "/followup/",
      "/followup/pipeline",
      "/followupper",
      "/followups",
      "/context/pipeline",
    ];
    for (const p of corpus) {
      const server = m.legacyRedirectTarget(p);
      const client = clientRedirectTarget(LIT_BASE, p);
      if (p.startsWith("/api")) {
        // The only deliberate divergence: /api is server-only. The client rule
        // never sees these paths — no SPA bundle is loaded at an API URL.
        assert.equal(server, null, `${p}`);
        continue;
      }
      assert.equal(client, server, `client/server disagree on ${p}`);
    }
  });

  test.it("query and hash survive the client redirect", async () => {
    // The login callback hands the code back in the query string. Dropping it
    // turns a working login into a silent bounce to the sign-in screen.
    assert.equal(
      clientRedirectTarget(LIT_BASE, "/", "?login_code=abc&x=1"),
      "/followup/?login_code=abc&x=1",
    );
    assert.equal(
      clientRedirectTarget(LIT_BASE, "/pipeline", "?a=1", "#row-7"),
      "/followup/pipeline?a=1#row-7",
    );
  });

  test.it("no legacy target can leave this origin", async () => {
    const m = await loadWith({ BASE_PATH: LIT_BASE });
    for (const p of ["//evil.example", "///evil.example/p", "/\\evil.example", "//", "////x"]) {
      const server = m.legacyRedirectTarget(p);
      if (server !== null) {
        assert.equal(resolvedHost(server), "good.example", `server target escaped: ${server}`);
        assert.ok(!server.startsWith("//"), `protocol-relative: ${server}`);
      }
      const client = clientRedirectTarget(LIT_BASE, p);
      if (client !== null) {
        assert.equal(resolvedHost(client), "good.example", `client target escaped: ${client}`);
        assert.ok(!client.startsWith("//"), `protocol-relative: ${client}`);
      }
    }
  });

  test.it("a hostile BASE_PATH disables the rule instead of arming it", async () => {
    for (const bp of ["//evil.example", "https://evil.example", "/\\evil.example", "javascript:x"]) {
      const m = await loadWith({ BASE_PATH: bp });
      // normalizeBasePath degrades these to "/", which is the dark state.
      assert.equal(m.BASE_PATH, "/");
      assert.equal(m.legacyRedirectTarget("/pipeline"), null, `armed by hostile BASE_PATH ${bp}`);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. SECURITY — Bundle 1's two defects must not recur in the switched state
// ---------------------------------------------------------------------------

test.describe("security: no protocol-relative output, no open redirect", () => {
  const HOSTILE_BASE_PATHS = [
    "//evil.example",
    "///evil.example",
    "https://evil.example",
    "/\\evil.example",
    "\\\\evil.example",
    "/x/\\evil.example",
    "javascript:alert(1)",
    "/ok\r\nSet-Cookie: a=b",
  ];
  const HOSTILE_PATHS = [
    "//evil.example",
    "///evil.example/p",
    "/\\evil.example",
    "\\\\evil.example",
    "https://evil.example",
    "//",
    "////x",
  ];

  test.it("a hostile BASE_PATH can never move the resolved host", async () => {
    for (const bp of HOSTILE_BASE_PATHS) {
      const m = await loadWith({ BASE_PATH: bp });
      for (const p of [...HOSTILE_PATHS, "/accounts", "/"]) {
        assert.equal(resolvedHost(m.appPath(p)), "good.example", `appPath(${bp}, ${p}) escaped`);
        assert.equal(
          resolvedHost(m.redirectPath(p)),
          "good.example",
          `redirectPath(${bp}, ${p}) escaped`,
        );
      }
    }
  });

  test.it("a hostile path can never move the host in lit mode", async () => {
    const m = await loadWith({ BASE_PATH: LIT_BASE });
    for (const p of HOSTILE_PATHS) {
      assert.equal(resolvedHost(m.appPath(p)), "good.example", `appPath(${p}) escaped`);
      assert.equal(resolvedHost(m.redirectPath(p)), "good.example", `redirectPath(${p}) escaped`);
    }
  });

  test.it("no helper emits a protocol-relative value", async () => {
    for (const bp of [...HOSTILE_BASE_PATHS, "/followup", "/"]) {
      const m = await loadWith({ BASE_PATH: bp });
      for (const p of [...HOSTILE_PATHS, "/accounts"]) {
        for (const out of [m.appPath(p), m.redirectPath(p)]) {
          assert.ok(!out.startsWith("//"), `protocol-relative: ${JSON.stringify(out)}`);
          assert.ok(!/^\/[\\]/.test(out), `backslash-relative: ${JSON.stringify(out)}`);
        }
      }
    }
  });

  test.it("a protocol-relative PUBLIC_URL is rejected, not propagated", async () => {
    const m = await loadWith({ PUBLIC_URL: "//evil.example" });
    assert.equal(m.PUBLIC_URL, "");
    assert.equal(resolvedHost(m.redirectPath("/?login_code=secret")), "good.example");
  });

  test.it("a backslash in PUBLIC_URL is normalized by the parser", async () => {
    const m = await loadWith({ PUBLIC_URL: "https://good.example/\\evil" });
    assert.ok(!m.PUBLIC_URL.includes("\\"), `raw backslash survived: ${m.PUBLIC_URL}`);
    assert.equal(resolvedHost(m.redirectPath("/x")), "good.example");
  });

  test.it("a non-http scheme in PUBLIC_URL is rejected", async () => {
    for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "ftp://evil.example"]) {
      const m = await loadWith({ PUBLIC_URL: bad });
      assert.equal(m.PUBLIC_URL, "", `${bad} should be rejected`);
    }
  });
});
