#!/usr/bin/env bash
#
# diagnose-gmail-oauth.sh
#
# Purpose: find out why Email Inspector shows "Failed to load emails".
# It is READ ONLY. It makes no changes to the database, no changes to
# Gmail, and no changes to secrets. Safe to run as many times as you want.
#
# What it checks, in order:
#   1. Are the Google + API secrets present and clean (no stray spaces)?
#   2. Does the legacy refresh token (GOOGLE_REFRESH_TOKEN env) still work
#      with the current client id and secret?
#   3. Does each connected user's stored refresh token still work?
#   4. What does the live /api/gmail/sent-emails endpoint actually return?
#   5. A plain verdict that names the cause and the fix.
#
# Run it from the repo root of the api-server repl:
#   bash diagnose-gmail-oauth.sh
#
# It never prints the value of any secret. Only lengths and pass/fail.

RESULTS="$(mktemp)"
trap 'rm -f "$RESULTS"' EXIT

line() { printf '%s\n' "----------------------------------------------------------------"; }
note() { printf '%s\n' "$*"; }

# ---------------------------------------------------------------------------
# Section 1: secret hygiene
# ---------------------------------------------------------------------------
line
note "1. SECRET CHECK (values are never printed)"
line

check_var() {
  local name="$1"
  local val="$2"
  if [ -z "$val" ]; then
    note "  [MISSING] $name is empty or not set"
    echo "MISSING:$name" >> "$RESULTS"
    return
  fi
  local len=${#val}
  local trimmed
  trimmed="$(printf '%s' "$val" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  local ws="no"
  [ "$trimmed" != "$val" ] && ws="yes"
  local cr="no"
  case "$val" in *$'\r'*) cr="yes";; esac
  note "  [PRESENT] $name  len=$len  stray_space=$ws  carriage_return=$cr"
  if [ "$ws" = "yes" ] || [ "$cr" = "yes" ]; then
    echo "DIRTY:$name" >> "$RESULTS"
  fi
}

check_var "GOOGLE_CLIENT_ID"     "${GOOGLE_CLIENT_ID:-}"
check_var "GOOGLE_CLIENT_SECRET" "${GOOGLE_CLIENT_SECRET:-}"
check_var "GOOGLE_REFRESH_TOKEN" "${GOOGLE_REFRESH_TOKEN:-}"
check_var "ADDON_API_KEY"        "${ADDON_API_KEY:-}"
check_var "DATABASE_URL"         "${DATABASE_URL:-}"
check_var "PORT"                 "${PORT:-}"

# ---------------------------------------------------------------------------
# Google token test helper. Sends the refresh token to Google over TLS only.
# ---------------------------------------------------------------------------
google_token_test() {
  local tag="$1"      # short id for the results file
  local label="$2"    # human label
  local cid="$3"
  local csec="$4"
  local rtok="$5"

  if [ -z "$cid" ] || [ -z "$csec" ] || [ -z "$rtok" ]; then
    note "  [SKIP] $label: missing client id, secret, or refresh token"
    echo "$tag:SKIP:missing" >> "$RESULTS"
    return
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
# Section 2: legacy env token
# ---------------------------------------------------------------------------
line
note "2. LEGACY TOKEN (GOOGLE_REFRESH_TOKEN env) vs current client"
line
google_token_test "LEGACY" "Legacy env token" \
  "${GOOGLE_CLIENT_ID:-}" "${GOOGLE_CLIENT_SECRET:-}" "${GOOGLE_REFRESH_TOKEN:-}"

# ---------------------------------------------------------------------------
# Section 3: per-user tokens from the database
# ---------------------------------------------------------------------------
line
note "3. PER-USER TOKENS (users.google_refresh_token) vs current client"
line

read_users() {
  local sql="select id || '|' || email || '|' || coalesce(google_refresh_token,'') from users where is_connected = true;"
  if [ -z "${DATABASE_URL:-}" ]; then return; fi
  if command -v psql >/dev/null 2>&1; then
    psql "$DATABASE_URL" -t -A -c "$sql" 2>/dev/null
    return
  fi
  # fallback: node + pg (needs to run where node_modules/pg resolves, i.e. repo root)
  node - "$DATABASE_URL" <<'NODE' 2>/dev/null
const { Client } = require('pg');
const c = new Client({ connectionString: process.argv[2] });
(async () => {
  try {
    await c.connect();
    const r = await c.query("select id, email, coalesce(google_refresh_token,'') as t from users where is_connected = true");
    for (const row of r.rows) console.log(`${row.id}|${row.email}|${row.t}`);
  } catch (e) {} finally { try { await c.end(); } catch {} }
})();
NODE
}

USERS="$(read_users)"
FIRST_USER_ID=""

if [ -z "$USERS" ]; then
  note "  [SKIP] Could not read the users table."
  note "         Either psql is not installed and the pg module did not resolve,"
  note "         or there are no connected users. Run this from the repo root so"
  note "         the pg module loads. The legacy test above still tells us if the"
  note "         client id and secret themselves are valid."
  echo "USERS:NONE" >> "$RESULTS"
else
  while IFS='|' read -r uid uemail utok; do
    [ -z "$uid" ] && continue
    [ -z "$FIRST_USER_ID" ] && FIRST_USER_ID="$uid"
    if [ -z "$utok" ]; then
      note "  [SKIP] user $uemail (id=$uid): marked connected but has no stored token"
      echo "USER:FAIL:no_token" >> "$RESULTS"
      continue
    fi
    google_token_test "USER" "user $uemail (id=$uid)" \
      "${GOOGLE_CLIENT_ID:-}" "${GOOGLE_CLIENT_SECRET:-}" "$utok"
  done <<< "$USERS"
fi

# ---------------------------------------------------------------------------
# Section 4: live endpoint reproduction
# ---------------------------------------------------------------------------
line
note "4. LIVE ENDPOINT (what the Email Inspector actually calls)"
line

BASE=""
FOUND_PORT=""
for p in "${PORT:-}" 3000 8080 80 5000 8000; do
  [ -z "$p" ] && continue
  hc="$(curl -s -m 5 -o /dev/null -w '%{http_code}' "http://localhost:$p/api/healthz" 2>/dev/null)"
  if [ "$hc" = "200" ]; then
    BASE="http://localhost:$p"
    FOUND_PORT="$p"
    break
  fi
done

extract_err() {
  grep -oE '"error"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n1 | sed -E 's/.*"([^"]*)"$/\1/'
}

if [ -z "$BASE" ]; then
  note "  [SKIP] No local server answered /api/healthz. The api-server may be"
  note "         stopped, or it binds a port not in the probe list. Start it and"
  note "         re-run, or read the PORT secret and add it."
  echo "ENDPOINT:DOWN" >> "$RESULTS"
else
  note "  Server is up on $BASE (healthz returned 200)."
  if [ -z "${ADDON_API_KEY:-}" ]; then
    note "  [SKIP] ADDON_API_KEY not set in this shell, cannot call the gated route."
  else
    # legacy path (no userId)
    r1="$(curl -s -m 30 -w $'\n%{http_code}' -H "x-api-key: $ADDON_API_KEY" \
      "$BASE/api/gmail/sent-emails?limit=1" 2>/dev/null)"
    c1="$(printf '%s' "$r1" | tail -n1)"
    b1="$(printf '%s' "$r1" | sed '$d')"
    e1="$(printf '%s' "$b1" | extract_err)"
    note "  legacy path  (no userId):    HTTP $c1 ${e1:+error=$e1}"
    echo "ENDPOINT:legacy:$c1:${e1:-ok}" >> "$RESULTS"

    # per-user path (with first connected userId, if known)
    if [ -n "$FIRST_USER_ID" ]; then
      r2="$(curl -s -m 30 -w $'\n%{http_code}' -H "x-api-key: $ADDON_API_KEY" \
        "$BASE/api/gmail/sent-emails?userId=$FIRST_USER_ID&limit=1" 2>/dev/null)"
      c2="$(printf '%s' "$r2" | tail -n1)"
      b2="$(printf '%s' "$r2" | sed '$d')"
      e2="$(printf '%s' "$b2" | extract_err)"
      note "  per-user path (userId=$FIRST_USER_ID): HTTP $c2 ${e2:+error=$e2}"
      echo "ENDPOINT:user:$c2:${e2:-ok}" >> "$RESULTS"
    else
      note "  [SKIP] per-user path: no connected userId known."
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Section 5: verdict
# ---------------------------------------------------------------------------
line
note "5. VERDICT"
line

has() { grep -q "$1" "$RESULTS"; }

CLIENT_BAD=no
if grep -qE '(LEGACY|USER):FAIL:(invalid_client|unauthorized_client|deleted_client)' "$RESULTS"; then
  CLIENT_BAD=yes
fi
LEGACY_PASS=no;   has "LEGACY:PASS"            && LEGACY_PASS=yes
LEGACY_GRANT=no;  has "LEGACY:FAIL:invalid_grant" && LEGACY_GRANT=yes
USER_GRANT=no;    has "USER:FAIL:invalid_grant"   && USER_GRANT=yes
USER_PASS=no;     has "USER:PASS"              && USER_PASS=yes
DIRTY=no;         grep -q "^DIRTY:" "$RESULTS" && DIRTY=yes

if [ "$DIRTY" = "yes" ]; then
  note "  WARNING: a secret has leading/trailing whitespace or a carriage return."
  note "  Re-paste it cleanly in Replit Secrets before trusting anything below."
  note ""
fi

if [ "$CLIENT_BAD" = "yes" ]; then
  note "  CAUSE: the new GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET is wrong or"
  note "  mismatched (Google answered invalid_client / unauthorized_client)."
  note "  FIX: correct the client id and secret in Replit Secrets to match the"
  note "  new OAuth client, and confirm the OAuth client still exists."
  note "  Reconnecting accounts will NOT help until this is fixed."
elif [ "$LEGACY_GRANT" = "yes" ] && { [ "$USER_GRANT" = "yes" ] || has "USERS:NONE"; }; then
  note "  CAUSE: the client id and secret are accepted, but the refresh tokens"
  note "  were minted under the OLD client and are now dead (invalid_grant)."
  note "  This is the credential-rotation failure."
  note "  FIX: 1) reconnect every account through the Google consent screen,"
  note "       2) regenerate GOOGLE_REFRESH_TOKEN under the new client."
elif [ "$LEGACY_PASS" = "yes" ] && [ "$USER_GRANT" = "yes" ]; then
  note "  CAUSE: the legacy token and client are fine, but the per-user stored"
  note "  tokens are dead (invalid_grant). Only the saved accounts are stale."
  note "  FIX: reconnect every connected account through the Google consent"
  note "  screen. No need to touch GOOGLE_REFRESH_TOKEN."
elif [ "$LEGACY_PASS" = "yes" ] && [ "$USER_PASS" = "yes" ]; then
  note "  All tokens passed the Google check. If the endpoint still returns an"
  note "  error above, the cause is not the tokens. Likely a missing Gmail scope,"
  note "  a label-lookup failure, or the dropped-header code path. Send me the"
  note "  exact endpoint error string from section 4."
else
  note "  Mixed or incomplete signals. Read sections 2, 3, and 4 above. Send me:"
  note "    - the LEGACY result line"
  note "    - the USER result line(s)"
  note "    - the section 4 HTTP codes and error strings"
  note "  and I will name the exact fix."
fi
line
note "Done. Nothing was changed."
