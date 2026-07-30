#!/usr/bin/env bash
# Daily budget cap - pre-Republish smoke test.
# Run in the Replit Shell AFTER Restart and BEFORE Republish.
# It hits the DEV server on localhost (the published URL still runs old code
# until you Republish). It performs ZERO sends and restores your settings at
# the end. Green tally => safe to Republish.
set -uo pipefail

PASS=0; FAIL=0; SKIP=0
ok(){ echo "  PASS  $1"; PASS=$((PASS+1)); }
no(){ echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
sk(){ echo "  SKIP  $1"; SKIP=$((SKIP+1)); }

jget(){ python3 -c "import sys,json
try:
    d=json.load(open('/tmp/sb_body'))
except Exception:
    print(''); sys.exit(0)
v=d.get('$1','')
print(v if v is not None else '')"; }

# 0. keys: admin endpoints sit behind BOTH the shared x-api-key (ADDON_API_KEY)
#    gate and the x-admin-key (ADMIN_API_KEY) gate, so we need both.
if [ -z "${ADMIN_API_KEY:-}" ]; then
  echo "FATAL: ADMIN_API_KEY is not set in this shell."
  echo "       It lives in the Repl Secrets; the Shell normally inherits it."
  echo "       Or run: ADMIN_API_KEY=<key> ADDON_API_KEY=<key> bash smoke-budget.sh"
  exit 2
fi
if [ -z "${ADDON_API_KEY:-}" ]; then
  echo "FATAL: ADDON_API_KEY is not set in this shell."
  echo "       It lives in the Repl Secrets; the Shell normally inherits it."
  echo "       Or run: ADMIN_API_KEY=<key> ADDON_API_KEY=<key> bash smoke-budget.sh"
  exit 2
fi

# 1. discover dev base url via /api/healthz
# Gather candidate ports from: $PORT, the running node server's PORT env,
# kernel LISTEN sockets (/proc/net/tcp[6]), then a small static fallback.
CANDIDATES=$(python3 - <<'PY'
import glob
ports=[]
def add(p):
    try:
        p=int(p)
        if 1<=p<=65535 and p not in ports: ports.append(p)
    except Exception: pass
# LISTEN sockets (state 0A) from /proc/net/tcp and tcp6
for f in ("/proc/net/tcp","/proc/net/tcp6"):
    try:
        for line in open(f).read().splitlines()[1:]:
            c=line.split()
            if len(c)>3 and c[3]=="0A":
                add(int(c[1].split(":")[1],16))
    except Exception: pass
# PORT env of any running process (catches the node dev server)
for envf in glob.glob("/proc/*/environ"):
    try:
        for kv in open(envf,"rb").read().split(b"\x00"):
            if kv.startswith(b"PORT="): add(kv.split(b"=",1)[1].decode())
    except Exception: pass
print(" ".join(str(p) for p in ports))
PY
)
BASE=""
for p in ${PORT:-} $CANDIDATES 3000 80 8080 5000 8000 3001; do
  [ -z "$p" ] && continue
  if curl -fsS --connect-timeout 2 --max-time 5 "http://localhost:$p/api/healthz" >/dev/null 2>&1; then BASE="http://localhost:$p"; break; fi
done
if [ -z "$BASE" ]; then
  echo "FATAL: no dev API server answered /api/healthz on localhost."
  echo "       Listening ports seen: ${CANDIDATES:-none}"
  if ! pgrep -af "node" >/dev/null 2>&1; then
    echo "       No node process is running. Start the Repl (press Run); it should be up after Restart."
  else
    echo "       A node process is running but did not answer. Set the port explicitly:"
    echo "       PORT=<devport> bash smoke-budget.sh"
  fi
  exit 2
fi
EP="$BASE/api/admin/daily-budget"
echo "Dev server: $BASE"
echo "Endpoint:   $EP"
echo "----------------------------------------------------------------"

req(){ # METHOD [data]  -> prints status code, body in /tmp/sb_body
  local m="$1" data="${2:-}"
  if [ -n "$data" ]; then
    curl -s --connect-timeout 2 --max-time 8 -o /tmp/sb_body -w "%{http_code}" -X "$m" \
      -H "x-api-key: $ADDON_API_KEY" -H "x-admin-key: $ADMIN_API_KEY" -H "Content-Type: application/json" -d "$data" "$EP"
  else
    curl -s --connect-timeout 2 --max-time 8 -o /tmp/sb_body -w "%{http_code}" -X "$m" \
      -H "x-api-key: $ADDON_API_KEY" -H "x-admin-key: $ADMIN_API_KEY" "$EP"
  fi
}

echo "[A] Auth (two layers: shared x-api-key, then x-admin-key)"
c=$(curl -s --connect-timeout 2 --max-time 8 -o /dev/null -w "%{http_code}" "$EP")
[ "$c" = "401" ] && ok "no keys -> 401 (shared gate)" || no "no keys -> $c (want 401)"
c=$(curl -s --connect-timeout 2 --max-time 8 -o /dev/null -w "%{http_code}" -H "x-api-key: WRONG" "$EP")
[ "$c" = "401" ] && ok "bad x-api-key -> 401 (shared gate)" || no "bad x-api-key -> $c (want 401)"
c=$(curl -s --connect-timeout 2 --max-time 8 -o /dev/null -w "%{http_code}" -H "x-api-key: $ADDON_API_KEY" "$EP")
[ "$c" = "403" ] && ok "valid api key, no admin key -> 403 (admin gate)" || no "no admin key -> $c (want 403)"
c=$(curl -s --connect-timeout 2 --max-time 8 -o /dev/null -w "%{http_code}" -H "x-api-key: $ADDON_API_KEY" -H "x-admin-key: WRONG" "$EP")
[ "$c" = "403" ] && ok "valid api key, wrong admin key -> 403 (admin gate)" || no "wrong admin key -> $c (want 403)"
c=$(req GET)
[ "$c" = "200" ] && ok "both keys -> 200" || { no "both keys -> $c (want 200)"; echo "  body: $(cat /tmp/sb_body)"; }

echo "[B] Shape + defaults"
req GET >/dev/null
SAVED_CAP=$(jget cap_usd); SAVED_ENABLED=$(jget enabled)
TZ=$(jget time_zone); EXC=$(jget exceeded); SPENT=$(jget spent_usd); WIN=$(jget window_start)
python3 -c "import sys;v='$SAVED_CAP';
sys.exit(0 if (v.replace('.','',1).isdigit() and float(v)>0) else 1)" && ok "cap_usd is positive number ($SAVED_CAP)" || no "cap_usd not positive ($SAVED_CAP)"
[ "$SAVED_ENABLED" = "True" ] || [ "$SAVED_ENABLED" = "False" ]; [ $? -eq 0 ] && ok "enabled is boolean ($SAVED_ENABLED)" || no "enabled not boolean ($SAVED_ENABLED)"
[ "$TZ" = "Asia/Jerusalem" ] && ok "time_zone = Asia/Jerusalem" || no "time_zone = $TZ (want Asia/Jerusalem)"
[ "$EXC" = "True" ] || [ "$EXC" = "False" ]; [ $? -eq 0 ] && ok "exceeded is boolean ($EXC)" || no "exceeded not boolean ($EXC)"
python3 -c "import sys;v='$SPENT';
sys.exit(0 if (v.replace('.','',1).replace('-','',1).isdigit() and float(v)>=0) else 1)" && ok "spent_usd is number >=0 ($SPENT)" || no "spent_usd invalid ($SPENT)"
# window_start must be local midnight in Asia/Jerusalem, and <= now
python3 - "$WIN" <<'PY' && ok "window_start is Israel midnight, <= now" || no "window_start wrong ($WIN)"
import sys,datetime
try:
    from zoneinfo import ZoneInfo
    w=datetime.datetime.fromisoformat(sys.argv[1].replace('Z','+00:00'))
    loc=w.astimezone(ZoneInfo('Asia/Jerusalem'))
    now=datetime.datetime.now(datetime.timezone.utc)
    ok = (loc.hour==0 and loc.minute==0 and loc.second==0 and w<=now)
    sys.exit(0 if ok else 1)
except Exception as e:
    print(e); sys.exit(1)
PY

echo "[C] Settings round-trip + validation"
c=$(req POST '{"cap_usd": 1234.56}'); v=$(jget cap_usd); { [ "$c" = "200" ] && [ "$v" = "1234.56" ]; } && ok "set cap_usd=1234.56 persists" || no "set cap_usd -> code $c value $v"
c=$(req POST '{"enabled": false}');  v=$(jget enabled);  { [ "$c" = "200" ] && [ "$v" = "False" ]; } && ok "set enabled=false persists" || no "set enabled=false -> code $c value $v"
c=$(req POST '{"cap_usd": -5}');     [ "$c" = "400" ] && ok "reject cap_usd=-5 -> 400" || no "cap_usd=-5 -> $c (want 400)"
c=$(req POST '{"cap_usd": 0}');      [ "$c" = "400" ] && ok "reject cap_usd=0 -> 400"  || no "cap_usd=0 -> $c (want 400)"
c=$(req POST '{}');                  [ "$c" = "400" ] && ok "reject empty body -> 400"  || no "empty body -> $c (want 400)"

echo "[D] Behavioral: exceeded tracks real spend (no sends)"
if python3 -c "import sys;sys.exit(0 if float('$SPENT')>0 else 1)"; then
  LOW=$(python3 -c "print(max(round(float('$SPENT')/2,6),0.000001))")
  req POST "{\"cap_usd\": $LOW}" >/dev/null; req GET >/dev/null; e1=$(jget exceeded)
  [ "$e1" = "True" ] && ok "cap below spend -> exceeded=true (gate would defer)" || no "cap below spend -> exceeded=$e1 (want true)"
else
  sk "spent_usd is 0 today; cannot force exceeded with a positive cap (boundary covered by unit tests)"
fi

echo "[E] Restore your original settings"
c=$(req POST "{\"cap_usd\": $SAVED_CAP}"); [ "$c" = "200" ] && ok "cap_usd restored to $SAVED_CAP" || no "restore cap -> $c"
EN=$([ "$SAVED_ENABLED" = "True" ] && echo true || echo false)
c=$(req POST "{\"enabled\": $EN}"); [ "$c" = "200" ] && ok "enabled restored to $EN" || no "restore enabled -> $c"
req GET >/dev/null; fc=$(jget cap_usd); fe=$(jget enabled)
{ [ "$fc" = "$SAVED_CAP" ] && [ "$fe" = "$SAVED_ENABLED" ]; } && ok "final state matches original (cap=$fc enabled=$fe)" || no "final state cap=$fc enabled=$fe (want $SAVED_CAP/$SAVED_ENABLED)"

echo "----------------------------------------------------------------"
echo "RESULT: $PASS passed, $FAIL failed, $SKIP skipped"
if [ "$FAIL" -eq 0 ]; then
  echo "GREEN. The cap is wired correctly on dev. Safe to Republish."
  exit 0
else
  echo "RED. Do not Republish. Restore from the apply backup folder and send me the output above."
  exit 1
fi
