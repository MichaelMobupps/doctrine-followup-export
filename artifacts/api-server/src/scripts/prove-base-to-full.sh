#!/usr/bin/env bash
# F-3.6b premise-corrected schema proof.
#
# CLAIM (the true, narrower one — see the premise correction in TODO.md):
#   From a BASE-TABLES-ONLY database, runStartupMigrations() alone brings the
#   schema to the current full state — every table, column and index dev has,
#   including cron_heartbeats and its (tick_name, fired_at DESC) index — and a
#   second run changes nothing.
#
# NOT claimed: that a bare database boots. startupMigrations only ALTERs the
# four base tables; drizzle-kit push alone creates them.
#
# Self-contained. Run from the repo root with DATABASE_URL pointing at DEV:
#   bash artifacts/api-server/src/scripts/prove-base-to-full.sh
# Dev is read only (pg_dump --schema-only). The ephemeral database is created
# and dropped by this script. Production is never touched.
set -uo pipefail

DEV="$DATABASE_URL"
BASEURL=$(node -e 'const u=new URL(process.env.DATABASE_URL);u.pathname="/f36b_smoke_base";process.stdout.write(u.toString())')
ADMIN=$(node -e 'const u=new URL(process.env.DATABASE_URL);u.pathname="/postgres";process.stdout.write(u.toString())')
if [ "$BASEURL" = "${PROD_DATABASE_URL:-}" ] || [ "$DEV" = "${PROD_DATABASE_URL:-}" ]; then
  echo "REFUSING: production database"; exit 1
fi
case "$DEV" in *helium*) ;; *) echo "REFUSING: source is not the dev (helium) database"; exit 1 ;; esac

W=$(mktemp -d)
trap 'psql -q "$ADMIN" -c "DROP DATABASE IF EXISTS f36b_smoke_base" >/dev/null 2>&1; rm -rf "$W"' EXIT

# ── Build the base-tables-only database: dev's schema minus the six tables
#    the migration owns, leaving exactly the four drizzle-kit push owns. ──
psql -q "$ADMIN" -c "DROP DATABASE IF EXISTS f36b_smoke_base" >/dev/null 2>&1
psql -q "$ADMIN" -c "CREATE DATABASE f36b_smoke_base" >/dev/null
pg_dump --schema-only --no-owner --no-privileges "$DEV" | psql -q "$BASEURL" >/dev/null
psql -q "$BASEURL" -c 'DROP TABLE IF EXISTS followup_usage, thread_messages, app_settings,
                       suppressed_addresses, company_shared_drafts, cron_heartbeats CASCADE' >/dev/null
fails=0
pass() { echo "  PASS  $1"; }
fail() { echo "  FAIL  $1"; fails=$((fails+1)); }
chk()  { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1"; echo "        expected: $3"; echo "        got:      $2"; fi }

Q_TABLES="select table_name from information_schema.tables where table_schema='public' order by 1"
Q_COLS="select table_name||'.'||column_name||'|'||data_type||'|'||is_nullable from information_schema.columns where table_schema='public' order by 1"
Q_IDX="select indexname||' = '||indexdef from pg_indexes where schemaname='public' and indexname <> 'uq_followups_prospect_cycle_stage' order by 1"

echo
echo "F-3.6b — base-tables-only → full schema, via startupMigrations alone"
echo "target: f36b_smoke_base    dev: read-only comparison"

echo
echo "── the database starts with ONLY the four tables drizzle-kit push owns ──"
psql -tA "$BASEURL" -c "$Q_TABLES" > "$W/before.tables"
chk "exactly followups, oauth_nonces, prospects, users" "$(tr '\n' ',' < "$W/before.tables")" "followups,oauth_nonces,prospects,users,"
for t in followup_usage thread_messages app_settings suppressed_addresses company_shared_drafts cron_heartbeats; do
  if grep -qx "$t" "$W/before.tables"; then fail "$t is ABSENT before the migration"; else pass "$t is ABSENT before the migration"; fi
done

echo
echo "── runStartupMigrations() — the only thing that touches the schema ──"
if env DATABASE_URL="$BASEURL" pnpm --filter @workspace/api-server exec tsx src/scripts/run-migrations-guarded.ts >"$W/mig1.log" 2>&1; then
  pass "it completed without throwing"
else
  fail "it completed without throwing"; tail -20 "$W/mig1.log"
fi

psql -tA "$BASEURL" -c "$Q_TABLES" > "$W/after.tables"
psql -tA "$BASEURL" -c "$Q_COLS"   > "$W/after.cols"
psql -tA "$BASEURL" -c "$Q_IDX"    > "$W/after.idx"
psql -tA "$DEV"     -c "$Q_TABLES" > "$W/dev.tables"
psql -tA "$DEV"     -c "$Q_COLS"   > "$W/dev.cols"
psql -tA "$DEV"     -c "$Q_IDX"    > "$W/dev.idx"

echo
echo "── the schema now equals dev's, object for object ──"
chk "all $(wc -l < "$W/dev.tables" | tr -d ' ') tables dev has now exist" "$(cat "$W/after.tables")" "$(cat "$W/dev.tables")"
if diff -q "$W/after.cols" "$W/dev.cols" >/dev/null; then
  pass "every column matches dev — name, type and nullability ($(wc -l < "$W/dev.cols" | tr -d ' ') columns)"
else
  fail "every column matches dev"; diff "$W/dev.cols" "$W/after.cols" | head -20
fi
if diff -q "$W/after.idx" "$W/dev.idx" >/dev/null; then
  pass "every index matches dev, definition for definition ($(wc -l < "$W/dev.idx" | tr -d ' ') indexes)"
else
  fail "every index matches dev"; diff "$W/dev.idx" "$W/after.idx" | head -20
fi

echo
echo "── cron_heartbeats specifically — the object F-3.6b moved ──"
if grep -qx cron_heartbeats "$W/after.tables"; then pass "the table exists"; else fail "the table exists"; fi
HB=$(grep '^idx_cron_heartbeats_tick_fired_at ' "$W/after.idx" || true)
if [ -n "$HB" ]; then pass "its tick/fired_at index exists"; else fail "its tick/fired_at index exists"; fi
case "$HB" in *"(tick_name, fired_at DESC)"*) pass "and carries fired_at DESC, matching both live databases";; *) fail "fired_at DESC ($HB)";; esac

echo
echo "── a second run changes nothing ──"
if env DATABASE_URL="$BASEURL" pnpm --filter @workspace/api-server exec tsx src/scripts/run-migrations-guarded.ts >"$W/mig2.log" 2>&1; then
  pass "the second run completed without throwing"
else
  fail "the second run completed without throwing"; tail -20 "$W/mig2.log"
fi
psql -tA "$BASEURL" -c "$Q_TABLES" > "$W/second.tables"
psql -tA "$BASEURL" -c "$Q_COLS"   > "$W/second.cols"
psql -tA "$BASEURL" -c "$Q_IDX"    > "$W/second.idx"
diff -q "$W/second.tables" "$W/after.tables" >/dev/null && pass "tables identical after the second run" || fail "tables identical"
diff -q "$W/second.cols"   "$W/after.cols"   >/dev/null && pass "columns identical after the second run" || fail "columns identical"
diff -q "$W/second.idx"    "$W/after.idx"    >/dev/null && pass "indexes identical after the second run" || fail "indexes identical"

echo
echo "── result ──"
echo "  tables: $(wc -l < "$W/before.tables" | tr -d ' ') → $(wc -l < "$W/after.tables" | tr -d ' ')   (dev has $(wc -l < "$W/dev.tables" | tr -d ' '))"
if [ "$fails" -eq 0 ]; then
  echo "  ALL CHECKS PASSED — startupMigrations alone takes base-tables-only to the full current schema."
  exit 0
else
  echo "  $fails CHECK(S) FAILED"
  exit 1
fi
