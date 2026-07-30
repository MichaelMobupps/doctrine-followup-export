#!/usr/bin/env bash
#
# diagnose-gmail-oauth-v3.sh
# READ ONLY. Shows the users table state and which DB this shell points at.
# Never prints a token value, only its length. Run from the repo root.

line() { printf '%s\n' "----------------------------------------------------------------"; }
note() { printf '%s\n' "$*"; }

# --- which database is this shell pointing at? -----------------------------
line; note "DATABASE this shell points at"; line
if [ -n "${DATABASE_URL:-}" ]; then
  host="$(printf '%s' "$DATABASE_URL" | sed -E 's#^[a-z]+://[^@]*@##; s#[/?].*$##')"
  masked="$(printf '%s' "$host" | sed -E 's/^([^.]{0,4})[^.]*/\1***/')"
  note "  host = $masked"
  note "  (compare this against the Deployment's DATABASE_URL host)"
else
  note "  DATABASE_URL not set in this shell"
fi

# --- read every user -------------------------------------------------------
read_all() {
  local sql="select id||'|'||email||'|'||is_connected||'|'||length(coalesce(google_refresh_token,''))||'|'||coalesce(google_refresh_token,'') from users order by id;"
  [ -z "${DATABASE_URL:-}" ] && return
  if command -v psql >/dev/null 2>&1; then
    local out; out="$(psql "$DATABASE_URL" -t -A -c "$sql" 2>/dev/null)"
    if [ -n "$out" ]; then printf '%s\n' "$out"; return; fi
  fi
  local pgpkg pgnm
  pgpkg="$(find . -maxdepth 8 -path '*/node_modules/pg/package.json' 2>/dev/null | head -n1)"
  [ -z "$pgpkg" ] && { note "  pg module not found; cd to repo root"; return; }
  pgnm="$(cd "$(dirname "$pgpkg")/.." && pwd)"
  NODE_PATH="$pgnm" node - "$DATABASE_URL" <<'NODE' 2>/tmp/diag_v3_err
const { Client } = require('pg');
const c = new Client({ connectionString: process.argv[2] });
(async () => {
  try {
    await c.connect();
    const r = await c.query("select id, email, is_connected, coalesce(google_refresh_token,'') as t from users order by id");
    for (const row of r.rows) console.log(`${row.id}|${row.email}|${row.is_connected}|${(row.t||'').length}|${row.t||''}`);
  } catch (e) { process.stderr.write('PGERR:'+e.message); }
  finally { try { await c.end(); } catch {} }
})();
NODE
}

google_token_test() {
  local label="$1" rtok="$2"
  local resp code body err
  resp="$(curl -s -m 20 -w $'\n%{http_code}' \
    --data-urlencode "client_id=${GOOGLE_CLIENT_ID:-}" \
    --data-urlencode "client_secret=${GOOGLE_CLIENT_SECRET:-}" \
    --data-urlencode "refresh_token=$rtok" \
    --data-urlencode "grant_type=refresh_token" \
    https://oauth2.googleapis.com/token 2>/dev/null)"
  code="$(printf '%s' "$resp" | tail -n1)"
  body="$(printf '%s' "$resp" | sed '$d')"
  if printf '%s' "$body" | grep -q '"access_token"'; then
    note "      token check: PASS (HTTP $code)"
  else
    err="$(printf '%s' "$body" | grep -oE '"error"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n1 | sed -E 's/.*"([^"]*)"$/\1/')"
    note "      token check: FAIL (HTTP $code, error=${err:-no_response})"
  fi
}

line; note "USERS table (token values hidden, length only)"; line
ROWS="$(read_all)"
if [ -z "$ROWS" ]; then
  [ -s /tmp/diag_v3_err ] && note "  read error: $(cat /tmp/diag_v3_err)"
  note "  No rows. This database has no users at all."
else
  count=0
  while IFS='|' read -r id email conn len tok; do
    [ -z "$id" ] && continue
    count=$((count+1))
    note "  id=$id  email=$email  is_connected=$conn  token_len=$len"
    case "$conn" in
      t|true|TRUE|True)
        if [ "${len:-0}" -gt 0 ] 2>/dev/null; then
          google_token_test "$email" "$tok"
        else
          note "      connected but NO stored token"
        fi
        ;;
    esac
  done <<< "$ROWS"
  note ""
  note "  total users: $count"
fi
rm -f /tmp/diag_v3_err
line; note "Done. Nothing was changed."
