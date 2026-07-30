#!/usr/bin/env bash
# Provision an ISOLATED test database, load the real schema, run the kill
# verification harness against it with an inert send path, then drop the DB.
#
# Never touches the source database's data: we only pg_dump --schema-only from
# it (read), create a brand-new database, and operate exclusively there.
set -uo pipefail

WORKSPACE=/home/runner/workspace
cd "$WORKSPACE"

TESTDB="relay_kill_verify_$(date +%s)_$$"
SCHEMA_SQL="$WORKSPACE/_schema_only.sql"

echo "==> Source DB (schema source, read-only):"
python3 - <<'PY'
import os
from urllib.parse import urlparse
u = urlparse(os.environ["DATABASE_URL"])
print("   host:", u.hostname, "db:", u.path.lstrip("/"))
PY

echo "==> Dumping real schema (schema-only, no data)"
pg_dump --schema-only --no-owner --no-privileges "$DATABASE_URL" > "$SCHEMA_SQL" || { echo "pg_dump failed"; exit 1; }

echo "==> Creating isolated test DB: $TESTDB"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "CREATE DATABASE $TESTDB;" || { echo "CREATE DATABASE failed"; exit 1; }

# Build the test DB URL by swapping the path of the source URL.
TEST_DB_URL="$(python3 - "$TESTDB" <<'PY'
import os, sys
from urllib.parse import urlparse, urlunparse
db = sys.argv[1]
u = urlparse(os.environ["DATABASE_URL"])
print(urlunparse(u._replace(path="/"+db)))
PY
)"

cleanup() {
  echo "==> Dropping isolated test DB: $TESTDB"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS $TESTDB;" \
    && echo "   dropped" || echo "   WARNING: drop failed; DB $TESTDB may remain"
  rm -f "$SCHEMA_SQL"
}
trap cleanup EXIT

echo "==> Loading schema into test DB"
psql "$TEST_DB_URL" -v ON_ERROR_STOP=1 -f "$SCHEMA_SQL" >/dev/null 2>&1 || { echo "schema load failed"; exit 1; }
echo "   schema loaded"

echo "==> Running verification harness (inert send path)"
cd "$WORKSPACE/artifacts/api-server"
DATABASE_URL="$TEST_DB_URL" \
ADDON_API_KEY="zz_relay_verify_key" \
PORT="0" \
TZ="UTC" \
SENDER_EMAIL="" \
SENDER_NAME="" \
NODE_ENV="test" \
pnpm exec tsx src/scripts/verify-kill.ts
RC=$?

echo ""
echo "==> Harness exit code: $RC"
exit $RC