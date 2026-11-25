#!/usr/bin/env bash
# Detached restart + HONEST verification for the codex-cli lane fix (a4a74ef).
# Lives outside the CLI session so it completes even when a restart happens
# after that session ends. Uses pm2 (never a raw kill) per CLAUDE.md §37 and
# never terminates a CLI/TUI process (§45).
#
# Why this was rewritten (2026-11-26): the first version probed the ROUTER door
# (:3579) with no key, one second after boot, so it could only ever report two
# failures that were not failures:
#   · {"error":"upstream unavailable"} — the router had not re-armed yet
#   · 401 "Sign in required to use chat" — the router is not a localhost caller
# Both were the probe's fault, not the lane's. This version checks what the fix
# actually changed:
#   1. THE LANE, on the app itself (:3580). A header-less localhost request is an
#      internal caller (isInternalCaller), so this hits the real dispatch.
#   2. THE PUBLIC DOOR (:3579), with the owner key read IN-PROCESS. §23: a secret
#      is used, never printed, never put in argv, never written to this log.
#
# Reads APP_URL / DOOR_URL from the environment, defaulting to the live ports.
# SKIP_RESTART=1 verifies the current state without bouncing anything.
#
# Exits 0 only when the app answers, the lane answers, and the door answers.
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
LOG="${1:-/home/ghost/haksterAi/logs/hakster-restart-$(date -u +%Y%m%dT%H%M%SZ).log}"
APP="${APP_URL:-http://127.0.0.1:3580}"
DOOR="${DOOR_URL:-http://127.0.0.1:3579}"
EXPECT="${EXPECT_TOKEN:-LIVE_CODEX_OK}"
PROVIDER="${PROVIDER:-codex-cli}"
VERIFY_ONLY="${SKIP_RESTART:-0}"

mkdir -p "$(dirname "$LOG")"
exec >>"$LOG" 2>&1
say(){ printf '%s  %s\n' "$(date -u +%FT%TZ)" "$*"; }

HEAD_COMMIT=$(git -C "$(cd "$HERE/.." && pwd)" rev-parse --short HEAD 2>/dev/null || echo unknown)
say "=== hakster restart + lane verify starting (tree at commit ${HEAD_COMMIT}) ==="
say "app=$APP door=$DOOR provider=$PROVIDER verify_only=$VERIFY_ONLY"

BEFORE=$(pm2 jlist 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const a=JSON.parse(s);const p=a.find(x=>x.name==="hakster");console.log(p?`${p.pid} ${p.pm2_env.restart_time} ${p.pm2_env.status}`:"missing")}catch(e){console.log("parse-error")}})')
say "before: pid/restarts/status = $BEFORE"

if [ "$VERIFY_ONLY" = "1" ]; then
  say "SKIP_RESTART=1 — verifying the running server, nothing will be bounced"
else
  # let the calling turn flush its final message before the restart lands
  sleep 12
  say "restarting pm2 hakster"
  pm2 restart hakster --update-env >/dev/null 2>&1
  say "restart issued, rc=$?"
fi

# --- 1. Readiness, measured on the APP, not on the router ---------------------
# The router answers /api/health while the app is still booting, which is how the
# old probe fooled itself into "health=up" and then reported a dead upstream.
APP_UP=down
for i in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 3 "$APP/api/version" 2>/dev/null)
  if [ "$code" = "200" ]; then APP_UP=up; say "app /api/version 200 after ${i}s"; break; fi
  sleep 1
done
say "app=$APP_UP"

AFTER=$(pm2 jlist 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const a=JSON.parse(s);const p=a.find(x=>x.name==="hakster");console.log(p?`${p.pid} ${p.pm2_env.restart_time} ${p.pm2_env.status} uptime_ms=${Date.now()-p.pm2_env.pm_uptime}`:"missing")}catch(e){console.log("parse-error")}})')
say "after: pid/restarts/status = $AFTER"

say "--- app /api/version ---"
curl -s -m 5 "$APP/api/version" 2>/dev/null | head -c 800; echo

# --- 2. The lane, through its own dispatch, on the app ------------------------
# probe-agent-lane.cjs sends the key in-process and pulls the text out of the SSE
# stream. One bounded retry absorbs a boot race; three attempts is the ceiling
# (§11 bounded retries) and every attempt is reported.
LANE=fail
if [ "$APP_UP" = "up" ]; then
  for attempt in 1 2 3; do
    say "--- lane probe attempt $attempt/3: $PROVIDER on $APP ---"
    if PROBE_BASE="$APP" PROBE_TIMEOUT_MS=150000 timeout 170 node "$HERE/probe-agent-lane.cjs" "$PROVIDER" "$EXPECT"; then
      LANE=pass; break
    fi
    say "attempt $attempt did not pass"
    [ "$attempt" = "3" ] || { say "waiting 10s before retry"; sleep 10; }
  done
else
  say "app never came up; skipping the lane probe"
fi
say "lane=$LANE"

# --- 3. The public door, authenticated, without printing the key --------------
DOOR_VER=$(curl -s -o /dev/null -w '%{http_code}' -m 8 "$DOOR/api/version" 2>/dev/null)
say "door /api/version = $DOOR_VER"
DOOR_AUTH=$(node -e '
const fs=require("fs"),os=require("os"),p=require("path").join(os.homedir(),".hakster","config.json");
let k; try{const c=JSON.parse(fs.readFileSync(p,"utf8"));k=c.ownerApiKey||c.apiKey}catch(e){console.log("no-key ("+e.message+")");process.exit(0)}
if(!k){console.log("no-key");process.exit(0)}
fetch(process.argv[1]+"/api/auth/me",{headers:{"x-api-key":k}}).then(async r=>{
  const t=await r.text(); let j=null; try{j=JSON.parse(t)}catch{}
  const u=(j&&j.user)||{};
  // Never echo the key, the token or any account identifier (§23, §25).
  console.log("me="+r.status+" owner="+(u.is_owner===true)+" active="+(u.status==="active")+" plan="+(u.plan||"-"));
}).catch(e=>console.log("me=unreachable ("+e.message+")"));
' "$DOOR")
say "door auth: $DOOR_AUTH"
case "$DOOR_AUTH" in
  *"me=200 owner=true active=true"*) DOOR_OK=pass ;;
  *) DOOR_OK=fail ;;
esac
say "door=$DOOR_OK"

# --- 4. Verdict, stated as measured ------------------------------------------
say "=== verdict: app=$APP_UP lane=$LANE door=$DOOR_OK (version=$DOOR_VER) ==="
if [ "$APP_UP" = "up" ] && [ "$LANE" = "pass" ] && [ "$DOOR_OK" = "pass" ]; then
  say "RESULT: PASS — the lane answered and the door serves a signed-in owner"
  exit 0
fi
say "RESULT: FAIL — see the checks above; nothing is claimed that did not pass"
exit 1
