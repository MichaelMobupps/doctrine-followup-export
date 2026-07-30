#!/usr/bin/env bash
#
# diagnose-gmail-oauth-v2.sh
#
# Same job as v1, but fixes the two parts that skipped:
#   - reads the users table even in a pnpm workspace (finds the pg module)
#   - finds the running server port from the listening sockets
#
# READ ONLY. No database writes, no Gmail writes, no secret changes.
# Run from the repo root:  bash diagnose-gmail-oauth-v2.sh

RESULTS="$(mktemp)"
trap 'rm -f "$RESULTS"' EXIT
line() { printf '%s\n' "----------------------------------------------------------------"; }
note() { printf '%s\n' "$*"; }

# ---------------------------------------------------------------------------
google_token_test() {
  local tag="$1" label="$2" cid="$3" csec="$4" rtok="$5"
  if [ -z "$cid" ] || [ -z "$csec" ] || [ -z "$rtok" ]; then
    note "  [SKIP] $label: missing client id, secret, or refresh token"
    echo "$tag:SKIP:missing" >> "$RESULTS"; return
  fi
  local resp code body err
  resp="$(curl -s -m 20 -w $'\n%{http_code}' \
    --data-urlencode "client_id=$cid" \
    --data-urlencode "client_secret=$csec" \
    --data-urlencode "refresh_token=$rtok" \
    --data-urlencode "grant_type=refresh_token" \
    https://oauth2.googleapis.com/token 2>/dev/null)"
  code="$(printf '%s' "$resp" | tail -n1)"
  body="$(printf '%s' "$resp" | sed '$d')"
  if printf '%s' "$body" | grep -q '"access_token"'; then
    note "  [PASS] $label: token works under the current client (HTTP $code)"
    echo "$tag:PASS:$code" >> "$RESULTS"
  else
    err="$(printf '%s' "$body" | grep -oE '"error"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n1 | sed -E 's/.*"([^"]*)"$/\1/')"
    [ -z "$err" ] && err="no_response"
    note "  [FAIL] $label: token rejected (HTTP $code, error=$err)"
    echo "$tag:FAIL:$err" >> "$RESULTS"
  fi
}

# ---------------------------------------------------------------------------
line; note "2. LEGACY TOKEN (re-confirm)"; line
google_token_test "LEGACY" "Legacy env token" \
  "${GOOGLE_CLIENT_ID:-}" "${GOOGLE_CLIENT_SECRET:-}" "${GOOGLE_REFRESH_TOKEN:-}"

# ---------------------------------------------------------------------------
line; note "3. PER-USER TOKENS (pnpm-aware database read)"; line

read_users() {
  local sql="select id || '|' || email || '|' || coalesce(google_refresh_token,'') from users where is_connected = true;"
  [ -z "${DATABASE_URL:-}" ] && { note "  [SKIP] DATABASE_URL not set in this shell"; return; }

  # 1) psql if present
  if command -v psql >/dev/null 2>&1; then
    local out
    out="$(psql "$DATABASE_URL" -t -A -c "$sql" 2>/dev/null)"
    if [ -n "$out" ]; then printf '%s\n' "$out"; return; fi
  fi

  # 2) node + pg, locating pg anywhere in the workspace
  local pgpkg pgnm
  pgpkg="$(find . -maxdepth 8 -path '*/node_modules/pg/package.json' 2>/dev/null | head -n1)"
  if [ -z "$pgpkg" ]; then
    note "  [SKIP] pg module not found under this directory. cd to the repo root and re-run."
    return
  fi
  pgnm="$(cd "$(dirname "$pgpkg")/.." && pwd)"   # the node_modules dir that holds pg
  NODE_PATH="$pgnm" node - "$DATABASE_URL" <<'NODE' 2>/tmp/diag_pg_err
const { Client } = require('pg');
const c = new Client({ connectionString: process.argv[2] });
(async () => {
  try {
    await c.connect();
    const r = await c.query("select id, email, coalesce(google_refresh_token,'') as t from users where is_connected = true");
    for (const row of r.rows) console.log(`${row.id}|${row.email}|${row.t}`);
  } catch (e) { process.stderr.write('PGERR:'+e.message); }
  finally { try { await c.end(); } catch {} }
})();
NODE
}

USERS="$(read_users)"
FIRST_USER_ID=""

if [ -z "$USERS" ]; then
  if [ -s /tmp/diag_pg_err ]; then
    note "  [INFO] database read error: $(cat /tmp/diag_pg_err)"
  fi
  note "  [SKIP] No connected users read. If you have connected accounts, send me"
  note "         the line above and I will adjust the reader."
  echo "USERS:NONE" >> "$RESULTS"
else
  while IFS='|' read -r uid uemail utok; do
    [ -z "$uid" ] && continue
    [ -z "$FIRST_USER_ID" ] && FIRST_USER_ID="$uid"
    if [ -z "$utok" ]; then
      note "  [WARN] user $uemail (id=$uid): connected but no stored token"
      echo "USER:FAIL:no_token" >> "$RESULTS"; continue
    fi
    google_token_test "USER" "user $uemail (id=$uid)" \
      "${GOOGLE_CLIENT_ID:-}" "${GOOGLE_CLIENT_SECRET:-}" "$utok"
  done <<< "$USERS"
fi
rm -f /tmp/diag_pg_err

# ---------------------------------------------------------------------------
line; note "4. LIVE ENDPOINT (find the real port from listening sockets)"; line

# gather candidate ports from listening sockets and any running node process
ports=""
if command -v ss >/dev/null 2>&1; then
  ports="$(ss -ltnH 2>/dev/null | awk '{print $4}' | sed -E 's/.*:([0-9]+)$/\1/' | sort -un)"
elif command -v netstat >/dev/null 2>&1; then
  ports="$(netstat -ltn 2>/dev/null | awk '/LISTEN/{print $4}' | sed -E 's/.*:([0-9]+)$/\1/' | sort -un)"
fi
for pid in $(pgrep -f node 2>/dev/null); do
  p="$(tr '\0' '\n' < /proc/$pid/environ 2>/dev/null | sed -n 's/^PORT=//p')"
  [ -n "$p" ] && ports="$ports $p"
done
ports="$(printf '%s\n' $ports 3000 8080 80 5000 8000 | sort -un)"

BASE=""
for p in $ports; do
  [ -z "$p" ] && continue
  hc="$(curl -s -m 4 -o /dev/null -w '%{http_code}' "http://localhost:$p/api/healthz" 2>/dev/null)"
  if [ "$hc" = "200" ]; then BASE="http://localhost:$p"; break; fi
done

extract_err() { grep -oE '"error"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n1 | sed -E 's/.*"([^"]*)"$/\1/'; }

if [ -z "$BASE" ]; then
  note "  [SKIP] No local server answered /api/healthz on ports: $(printf '%s ' $ports)"
  note "         The dev process is probably stopped and only the Deployment is"
  note "         live. That is fine; section 3 is the decisive test."
  echo "ENDPOINT:DOWN" >> "$RESULTS"
else
  note "  Server up on $BASE"
  if [ -n "${ADDON_API_KEY:-}" ]; then
    r1="$(curl -s -m 30 -w $'\n%{http_code}' -H "x-api-key: $ADDON_API_KEY" "$BASE/api/gmail/sent-emails?limit=1" 2>/dev/null)"
    note "  legacy path  (no userId):    HTTP $(printf '%s' "$r1" | tail -n1) $(printf '%s' "$r1" | sed '$d' | extract_err | sed 's/^/error=/')"
    if [ -n "$FIRST_USER_ID" ]; then
      r2="$(curl -s -m 30 -w $'\n%{http_code}' -H "x-api-key: $ADDON_API_KEY" "$BASE/api/gmail/sent-emails?userId=$FIRST_USER_ID&limit=1" 2>/dev/null)"
      note "  per-user path (userId=$FIRST_USER_ID): HTTP $(printf '%s' "$r2" | tail -n1) $(printf '%s' "$r2" | sed '$d' | extract_err | sed 's/^/error=/')"
    fi
  else
    note "  [SKIP] ADDON_API_KEY not set in this shell."
  fi
fi

# ---------------------------------------------------------------------------
line; note "5. VERDICT"; line
has() { grep -q "$1" "$RESULTS"; }

if grep -qE 'USER:FAIL:invalid_grant' "$RESULTS" && has "LEGACY:PASS"; then
  note "  CAUSE CONFIRMED: client id and secret are valid (legacy token passed),"
  note "  but the per-user stored tokens were minted under the OLD client and are"
  note "  now dead (invalid_grant). This is the credential-rotation failure."
  note ""
  note "  FIX: reconnect each connected account through the Google consent screen."
  note "  You do NOT need to touch GOOGLE_REFRESH_TOKEN. After reconnecting,"
  note "  restart the api-server so it reloads the new secrets."
elif grep -qE '(USER|LEGACY):FAIL:(invalid_client|unauthorized_client|deleted_client)' "$RESULTS"; then
  note "  CAUSE: Google rejected the client itself. Fix GOOGLE_CLIENT_ID and"
  note "  GOOGLE_CLIENT_SECRET to match the new OAuth client before anything else."
elif has "USER:PASS" && has "LEGACY:PASS"; then
  note "  All tokens passed the Google check. The tokens are not the cause."
  note "  Likely the running process is using STALE secrets (changed in Secrets"
  note "  but never restarted), or a missing Gmail scope. Restart the api-server"
  note "  and re-run. If still failing, send me the section 4 error string."
elif has "USERS:NONE"; then
  note "  Legacy token is valid, but I could not read the per-user tokens, so I"
  note "  cannot confirm the per-user path directly. Send me the section 3 INFO"
  note "  line. Given the legacy pass, reconnecting accounts is still the likely fix."
else
  note "  Mixed signals. Send me the section 2, 3, and 4 lines."
fi
line; note "Done. Nothing was changed."
