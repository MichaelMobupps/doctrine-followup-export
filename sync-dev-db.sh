#!/usr/bin/env bash
# sync-dev-db.sh
# Applies sync-dev-db.sql to the DEVELOPMENT database ($DATABASE_URL in the
# Replit shell), then verifies every object now exists. Idempotent: safe to
# re-run. No data is dropped.
#
# Run from the Replit shell:
#     bash sync-dev-db.sh

set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is not set in this shell. Aborting."
  exit 1
fi

echo "==> Applying sync-dev-db.sql to the development database"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$HERE/sync-dev-db.sql"

echo ""
echo "==> Verifying objects now exist in the development database"
MISSING=0

COLS=$(psql "$DATABASE_URL" -tAc "select count(*) from information_schema.columns where table_schema='public' and table_name='prospects' and column_name in ('bounce_type','paused_at','archived','archived_at');")
echo "    prospects new columns present: $COLS / 4"
[ "$COLS" = "4" ] || MISSING=1

TBL=$(psql "$DATABASE_URL" -tAc "select count(*) from information_schema.tables where table_schema='public' and table_name='app_settings';")
echo "    app_settings table present:    $TBL / 1"
[ "$TBL" = "1" ] || MISSING=1

IDX=$(psql "$DATABASE_URL" -tAc "select count(*) from pg_indexes where schemaname='public' and tablename='prospects' and indexname in ('idx_prospects_archive_sweep','idx_prospects_active_dispatch');")
echo "    partial indexes present:       $IDX / 2"
[ "$IDX" = "2" ] || MISSING=1

echo ""
if [ "$MISSING" = "0" ]; then
  echo "SUCCESS. Development database now matches production and the schema."
  echo "Next: Republish. The deploy diff for these objects will be empty."
else
  echo "INCOMPLETE. One or more objects are still missing. Do not Republish; send me this output."
  exit 1
fi
