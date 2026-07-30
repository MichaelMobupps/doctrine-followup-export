import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

// RH-1 (2026-06-08): pool hardening against "Authentication timed out".
//
// Root cause of the recurring error: the production database is serverless,
// and the default pool reaps idle connections after 10 seconds while the
// Opus critic calls in the generation pipeline run 30 to 90 seconds. Nearly
// every database write after an LLM call therefore rode a brand-new
// TCP + TLS + SCRAM handshake, and occasionally that handshake stalled past
// the driver's window. Settings below keep connections warm across LLM
// calls (idleTimeoutMillis 60s), keep the sockets alive (keepAlive), and
// bound how long an acquisition may hang (connectionTimeoutMillis 15s)
// instead of the default infinite wait.
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  keepAlive: true,
  idleTimeoutMillis: 60_000,
  connectionTimeoutMillis: 15_000,
});

// 2026-07-29 crash-loop fix: node-postgres re-emits idle-client socket errors
// as an 'error' event on the Pool. With no listener, that event throws as an
// uncaughtException, which the api-server's handler turns into process.exit(1)
// — the daily "artifact process exited with error error=exit status 1" crash
// loop in production (idle connections killed server-side by the serverless
// DB / network resets). The pool already discards the broken client and opens
// a fresh one on next acquire, so logging is the complete recovery.
// console.error (not a logger import) keeps this package dependency-free.
pool.on("error", (err) => {
  console.error(
    `[db] idle client error (recovered, pool will reconnect): ${err instanceof Error ? err.message : String(err)}`,
  );
});

export const db = drizzle(pool, { schema });

export * from "./schema";
