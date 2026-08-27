/**
 * test-no-anthropic-on-production-paths.ts
 *
 * A source-level guard: no file that a running server can reach may import the
 * Anthropic client or SDK.
 *
 * WHY A GREP TEST AND NOT A RUNTIME ONE
 *
 * lib/anthropic.ts is deliberately still importable — the archived comparison
 * harnesses reference its model constants, and its lazy client throws only when
 * something actually calls it. That laziness is what makes a runtime check
 * useless here: a reintroduced `anthropic.messages.create` on a rarely-taken
 * path (the grey-area writer, say, or the critic's degraded branch) would sit
 * quietly in the build and only surface as a 401 on a live send, at whatever
 * hour that path first ran.
 *
 * So this test reads the source. It walks every file reachable from src/index.ts
 * — following relative imports, which is exactly the set the esbuild bundle
 * contains — and fails if any of them names the SDK or the client module. It
 * cannot be satisfied by a comment, and it cannot be silently bypassed by an
 * env var.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx --test src/tests/test-no-anthropic-on-production-paths.ts
 */
import * as test from "node:test";
import * as assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = resolve(SRC, "index.ts");

/** Resolve a relative import specifier to a real file on disk. */
function resolveImport(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null; // package import — not our source
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, resolve(base, "index.ts")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/g;
const DYNAMIC_IMPORT_RE = /\bimport\(\s*["']([^"']+)["']\s*\)/g;

/** Every file reachable from the entry point by following relative imports. */
function reachableFromEntry(): string[] {
  const seen = new Set<string>();
  const queue = [ENTRY];
  while (queue.length) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const src = readFileSync(file, "utf8");
    for (const re of [IMPORT_RE, DYNAMIC_IMPORT_RE]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        const target = resolveImport(file, m[1]);
        if (target) queue.push(target);
      }
    }
  }
  return [...seen];
}

const BANNED = [
  { pattern: /from\s+["']@anthropic-ai\/sdk["']/, what: "the Anthropic SDK" },
  { pattern: /from\s+["'][^"']*\/lib\/anthropic["']/, what: "lib/anthropic.ts" },
  { pattern: /from\s+["']\.\.?\/anthropic["']/, what: "lib/anthropic.ts" },
  { pattern: /from\s+["'][^"']*anthropicRetry["']/, what: "services/anthropicRetry.ts" },
  { pattern: /\banthropic\.messages\.create\b/, what: "an anthropic.messages.create() call" },
];

test.describe("no Anthropic on any production path", () => {
  test.it("the reachable set from index.ts is non-trivial (the crawler works)", () => {
    const files = reachableFromEntry();
    // If the import crawler silently stopped resolving, every assertion below
    // would pass vacuously. Anchor it: the real graph is well over 50 files and
    // must include the generator the whole product exists to run.
    assert.ok(files.length > 50, `only ${files.length} files reachable — the crawler is broken`);
    assert.ok(
      files.some((f) => f.endsWith("services/followupGenerator.ts")),
      "followupGenerator.ts must be reachable from index.ts",
    );
    assert.ok(files.some((f) => f.endsWith("lib/llmRouter.ts")), "llmRouter.ts must be reachable");
  });

  test.it("no reachable file imports Anthropic or calls its client", () => {
    const offenders: string[] = [];
    for (const file of reachableFromEntry()) {
      const src = readFileSync(file, "utf8");
      for (const { pattern, what } of BANNED) {
        if (pattern.test(src)) {
          offenders.push(`${relative(SRC, file)} references ${what}`);
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      "Anthropic is disabled (the account is unfunded as of Aug 2026). " +
        "Route this through lib/llmRouter.ts instead:\n  " +
        offenders.join("\n  "),
    );
  });

  test.it("the archived harnesses are NOT reachable from index.ts", () => {
    // They still import Anthropic on purpose. They must stay out of the bundle.
    const reachable = reachableFromEntry();
    assert.ok(
      !reachable.some((f) => f.includes("archive-anthropic-era")),
      "an archived Anthropic-era script has been pulled onto a production path",
    );
  });

  test.it("no production path can switch the usage ledger off", () => {
    // __setLedgerSuppressedForOfflineRuns exists so offline benches keep their
    // dev traffic off the followup_usage ledger (which the daily budget cap
    // reads). It is dunder-named because nothing production may ever call it —
    // a service that could silently stop recording spend would defeat the cap.
    for (const file of reachableFromEntry()) {
      const src = readFileSync(file, "utf8");
      if (file.endsWith("lib/usageTracker.ts")) continue; // the definition itself
      assert.ok(
        !src.includes("__setLedgerSuppressedForOfflineRuns"),
        `${relative(SRC, file)} calls the offline-only ledger switch`,
      );
    }
  });

  test.it("every service and lib file is Anthropic-free, reachable or not", () => {
    // Belt and braces: the crawler follows imports, so a file added to
    // services/ but not yet imported anywhere would slip past the check above
    // and then become production code the moment someone wires it up.
    const offenders: string[] = [];
    for (const dir of ["services", "lib", "routes", "middlewares"]) {
      const root = resolve(SRC, dir);
      if (!existsSync(root)) continue;
      const walk = (d: string): void => {
        for (const name of readdirSync(d)) {
          const full = resolve(d, name);
          if (statSync(full).isDirectory()) {
            // Skip the dated .backups / .pi-backup snapshots the repo keeps.
            if (name.startsWith(".")) continue;
            walk(full);
            continue;
          }
          if (!name.endsWith(".ts")) continue;
          // lib/anthropic.ts is the retired module itself, and
          // services/anthropicRetry.ts is its retry helper. Both are kept for
          // the archived harnesses and are unreachable from index.ts (asserted
          // by the crawler test above).
          if (full.endsWith("lib/anthropic.ts") || full.endsWith("services/anthropicRetry.ts")) continue;
          const src = readFileSync(full, "utf8");
          for (const { pattern, what } of BANNED) {
            if (pattern.test(src)) offenders.push(`${relative(SRC, full)} references ${what}`);
          }
        }
      };
      walk(root);
    }
    assert.deepEqual(offenders, [], offenders.join("\n  "));
  });
});
