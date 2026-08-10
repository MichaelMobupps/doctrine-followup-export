/**
 * test-fallback-deleted.ts — F-3.6b.
 *
 * Structural. Reads the source of the send and sync paths and asserts the
 * env-var fallback identity is not in them. No DB, no network.
 *
 * WHY A SOURCE-LEVEL TEST
 *
 * The two things F-3.6b deletes are both DEFAULTS — a value that appears when
 * nothing else was supplied. That is precisely the kind of code that comes
 * back: one `|| getGmail()`, one `process.env.SENDER_EMAIL ||`, and an
 * ownerless prospect is silently delivered from a shared mailbox again, with
 * every unit test still green because the fallback only fires on the path
 * they do not exercise.
 *
 * The behavioural cover lives in test-owner-missing.ts and in
 * scripts/smoke-f36b.ts. This file covers the reintroduction itself, which is
 * the failure mode the ledger records twice (D2, 2026-07-31; F-3.6a's smoke,
 * 2026-08-09).
 *
 * Run: pnpm --filter @workspace/api-server exec tsx --test src/tests/test-fallback-deleted.ts
 */

import * as test from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(relative: string): string {
  return fs.readFileSync(path.join(SRC, relative), "utf8");
}

/** Strip line and block comments so the prose below does not match itself. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

/** The variables that made up the fallback identity. */
const FALLBACK_VARS = ["GOOGLE_REFRESH_TOKEN", "SENDER_EMAIL", "SENDER_NAME"];

/** Every file on the send / sync path, relative to src/. */
const SEND_PATH_FILES = [
  "services/gmailClient.ts",
  "services/gmailSync.ts",
  "services/scheduler.ts",
  "lib/ownerIdentity.ts",
  "routes/doctrine.ts",
];

// ---------------------------------------------------------------------------
// A. the fallback identity is gone from the send path
// ---------------------------------------------------------------------------
test.describe("the env-var fallback identity", () => {
  for (const file of SEND_PATH_FILES) {
    for (const variable of FALLBACK_VARS) {
      test.it(`${file} does not read process.env.${variable}`, () => {
        const source = code(read(file));
        assert.ok(
          !source.includes(`process.env.${variable}`),
          `${file} reads ${variable} again. An ownerless prospect will be sent from the ` +
            `shared fallback mailbox — the F-3.6b landmine, restored.`,
        );
      });
    }
  }

  test.it("gmailClient.ts no longer defines a token-less Gmail client", () => {
    const source = code(read("services/gmailClient.ts"));
    assert.ok(
      !/function\s+getGmail\s*\(\s*\)/.test(source),
      "getGmail() is back. It authorises with GOOGLE_REFRESH_TOKEN and every " +
        "optional `gmail?` parameter falls through to it.",
    );
  });

  test.it("no function in gmailClient.ts takes an optional Gmail client", () => {
    // The optionality WAS the bug: `gmail?` plus `|| getGmail()` is what made a
    // shared mailbox the identity of last resort for the whole file.
    const source = code(read("services/gmailClient.ts"));
    assert.ok(
      !/gmail\?\s*:\s*gmail_v1\.Gmail/.test(source),
      "an optional `gmail?: gmail_v1.Gmail` parameter is back — the compiler no " +
        "longer proves each call carries the account it belongs to.",
    );
  });

  test.it("ownerIdentity.ts contains no process.env at all", () => {
    assert.ok(!code(read("lib/ownerIdentity.ts")).includes("process.env"));
  });
});

// ---------------------------------------------------------------------------
// B. the legacy zero-users sync branch is gone
// ---------------------------------------------------------------------------
test.describe("the legacy zero-users sync branch", () => {
  test.it("syncForLegacyUser no longer exists", () => {
    const source = code(read("services/gmailSync.ts"));
    assert.ok(
      !source.includes("syncForLegacyUser"),
      "the legacy single-mailbox sync is back. It swallows per-message ingest " +
        "errors, returns no failed count, and hands back perUser: [] — the " +
        "ok/synced:0 shape that masked total sync death for months (D2).",
    );
  });

  test.it("zero connected accounts throws instead of returning a count", () => {
    const source = code(read("services/gmailSync.ts"));
    assert.ok(source.includes("class NoConnectedAccountsError"), "the typed error is declared");
    assert.ok(
      source.includes("throw new NoConnectedAccountsError()"),
      "and it is thrown, not logged-and-returned",
    );
  });

  test.it("the zero-account condition is never answered with synced: 0", () => {
    const source = code(read("services/gmailSync.ts"));
    assert.ok(
      !/connectedUsers\.length === 0[\s\S]{0,400}?return\s*\{/.test(source),
      "the zero-connected-users branch returns a result object again — that is " +
        "the shape the cron reads as `ok`.",
    );
  });

  test.it("the cron surfaces it as an error, not a partial and not a skip", () => {
    const source = code(read("cron.ts"));
    assert.ok(source.includes("NoConnectedAccountsError"), "the cron knows the error type");
    assert.ok(
      /NoConnectedAccountsError\)\s*\{[\s\S]{0,400}?outcome\s*=\s*"error"/.test(source),
      "a zero-account tick must record outcome 'error' — nothing is degraded, " +
        "everything is down.",
    );
  });
});

// ---------------------------------------------------------------------------
// C. cron_heartbeats is owned by the startup migration
// ---------------------------------------------------------------------------
test.describe("cron_heartbeats creation", () => {
  const migrations = read("lib/startupMigrations.ts");

  test.it("the table is created by the startup migration", () => {
    assert.ok(
      /CREATE TABLE IF NOT EXISTS cron_heartbeats/.test(migrations),
      "a database brought up by boot alone has no cron_heartbeats, and " +
        "GET /api/admin/cron-heartbeats — the liveness surface — 500s.",
    );
  });

  test.it("with the live production columns", () => {
    for (const column of [
      "id SERIAL PRIMARY KEY",
      "tick_name TEXT NOT NULL",
      "fired_at TIMESTAMPTZ NOT NULL DEFAULT NOW()",
      "outcome TEXT NOT NULL",
      "duration_ms INTEGER NOT NULL DEFAULT 0",
      "details JSONB",
    ]) {
      assert.ok(migrations.includes(column), `column definition missing: ${column}`);
    }
  });

  test.it("and the index in the live sort order, DESC", () => {
    // Verified read-only against both databases on 2026-08-10. Creating it
    // ASC would put a fresh database in a state neither real one is in.
    assert.ok(
      /idx_cron_heartbeats_tick_fired_at[\s\S]{0,120}?cron_heartbeats\(tick_name, fired_at DESC\)/.test(migrations),
      "the index must match production byte-for-byte, including `fired_at DESC`",
    );
  });

  test.it("both statements are idempotent, so boots after the first are no-ops", () => {
    assert.ok(migrations.includes("CREATE TABLE IF NOT EXISTS cron_heartbeats"));
    assert.ok(migrations.includes("CREATE INDEX IF NOT EXISTS idx_cron_heartbeats_tick_fired_at"));
  });
});

// ---------------------------------------------------------------------------
// D. the stale index declaration
// ---------------------------------------------------------------------------
test.describe("idx_prospects_app", () => {
  test.it("is not declared — it exists in neither database and nothing creates it", () => {
    const schema = fs.readFileSync(
      path.resolve(SRC, "../../../lib/db/src/schema/prospects.ts"),
      "utf8",
    );
    assert.ok(
      !code(schema).includes('index("idx_prospects_app")'),
      "the stale single-column declaration is back. `app` is filtered on " +
        "constantly, but idx_prospects_app_replied_paused leads with the same " +
        "column and already serves every one of those predicates.",
    );
  });

  test.it("the composite index that actually serves those queries is still declared", () => {
    const schema = fs.readFileSync(
      path.resolve(SRC, "../../../lib/db/src/schema/prospects.ts"),
      "utf8",
    );
    assert.ok(schema.includes('index("idx_prospects_app_replied_paused")'));
  });
});
