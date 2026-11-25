#!/bin/sh
# failover-sync.sh — keep the Lenovo standby current, without ever taking it down.
#
# Owner, 2026-11-25: "if dell server drops for period of time lenovo kicks in" /
# "how can we make it to where no user gets errors we need both online at all
# times".
#
# The standby runs TWO slots on two ports. Only the slot the router calls active
# serves traffic. Each run puts the fresh database and code into the IDLE slot,
# boots it, waits until it answers, moves the router to it, and only then stops
# the old slot — so at no instant is there no standby serving, and an update
# costs a visitor nothing.
#
# Safety rules this script enforces (CLAUDE.md §2, §4):
#   · It never touches the Dell's running server or its database in place — the
#     snapshot comes from SQLite's own backup API, which is safe on a live DB.
#   · It refuses to sync while the standby is the one serving (`primary_alive`
#     false): those writes exist only on the Lenovo. The owner decides that case.
#   · It refuses to sync if a failover happened since the last run (`failovers`
#     rose): the standby may hold writes the Dell does not.
#   · Nothing is deleted: the previous database is kept as hakster.db.prev.
#
# Env (all optional):
#   STANDBY_SSH      default mint
#   STANDBY_URL      default http://10.0.0.210:3581   (the door the Dell dials)
#   SLOT_A_DIR       default haksterAi-standby-a      (relative to the standby's home)
#   SLOT_A_PORT      default 3591
#   SLOT_B_DIR       default haksterAi-standby-b
#   SLOT_B_PORT      default 3592
#   ROUTER_STATUS    default http://127.0.0.1:3579/router/status   (the Dell's own router)
#   STATE_FILE       default /tmp/hakster-failover-sync.state
set -eu

# Cron runs with a minimal PATH and no profile; name the one we depend on.
PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
export PATH

STANDBY_SSH="${STANDBY_SSH:-mint}"
STANDBY_URL="${STANDBY_URL:-http://10.0.0.210:3581}"
STANDBY_HOST=$(printf '%s' "$STANDBY_URL" | sed 's#^[a-zA-Z]*://##; s#[:/].*##')
SLOT_A_DIR="${SLOT_A_DIR:-haksterAi-standby-a}"
SLOT_A_PORT="${SLOT_A_PORT:-3591}"
SLOT_B_DIR="${SLOT_B_DIR:-haksterAi-standby-b}"
SLOT_B_PORT="${SLOT_B_PORT:-3592}"
ROUTER_STATUS="${ROUTER_STATUS:-http://127.0.0.1:3579/router/status}"
STATE_FILE="${STATE_FILE:-/tmp/hakster-failover-sync.state}"
LOCAL_DB="${LOCAL_DB:-/home/ghost/haksterAi/data/hakster.db}"
TMP="${TMPDIR:-/tmp}/hakster-sync.$$"

say() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
LOCK_DIR="${TMPDIR:-/tmp}/hakster-failover-sync.lock"
cleanup() { rm -rf "$TMP"; rmdir "$LOCK_DIR" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

# One sync at a time: a slow copy must never overlap the next timer tick.
mkdir "$LOCK_DIR" 2>/dev/null || { say "held: another sync is still running"; exit 0; }
mkdir -p "$TMP"

ctl() { ssh -n -o BatchMode=yes "$STANDBY_SSH" "sh ~/hakster-standby-ctl.sh $*"; }

# ── 1. refuse while a failover has happened since the last sync ────────────
STATUS=$(curl -s -m 5 "$ROUTER_STATUS" 2>/dev/null || true)
if [ -n "$STATUS" ]; then
  FAILOVERS=$(printf '%s' "$STATUS" | sed -n 's/.*"failovers": *\([0-9]*\).*/\1/p')
  PRIMARY_ALIVE=$(printf '%s' "$STATUS" | sed -n 's/.*"primary_alive": *\([a-z]*\).*/\1/p')
  LAST=$(cat "$STATE_FILE" 2>/dev/null || echo 0)
  if [ "$PRIMARY_ALIVE" = "false" ]; then
    say "held: the primary is down; the standby is the one serving right now"
    exit 0
  fi
  if [ -n "$FAILOVERS" ] && [ "$FAILOVERS" != "$LAST" ]; then
    say "held: the standby answered $FAILOVERS request(s) during a failover (was $LAST)."
    say "       Its database may hold writes the Dell does not - not copying over them."
    say "       Decide which copy wins, then set $STATE_FILE to the current count."
    exit 0
  fi
  printf '%s' "$FAILOVERS" > "$STATE_FILE"
else
  say "held: router status unreadable at $ROUTER_STATUS (is the router running?)"
  exit 0
fi

# ── 2. consistent snapshot of the live database ────────────────────────────
python3 -I -c "
import sqlite3, sys
src = sqlite3.connect('file:$LOCAL_DB?mode=ro', uri=True)
dst = sqlite3.connect('$TMP/hakster.db')
src.backup(dst); dst.close(); src.close()
" || { say "failed: could not snapshot $LOCAL_DB"; exit 1; }
WANT=$(sha256sum "$TMP/hakster.db" | cut -d' ' -f1)
say "snapshot made ($(du -h "$TMP/hakster.db" | cut -f1) sha256 ${WANT%%????????????????????????????????????????})"

# ── 3. which slot is live, and which one is idle ───────────────────────────
ACTIVE_PORT=$(ctl active 2>/dev/null || true)
if [ -z "$ACTIVE_PORT" ]; then
  # No router answer: fall back to whichever slot is actually listening.
  for p in "$SLOT_A_PORT" "$SLOT_B_PORT"; do
    if [ "$(curl -s -m 3 -o /dev/null -w '%{http_code}' "http://$STANDBY_HOST:$p/api/version" 2>/dev/null || true)" = "200" ]; then
      ACTIVE_PORT="$p"; break
    fi
  done
fi

if [ "$ACTIVE_PORT" = "$SLOT_A_PORT" ]; then
  TARGET_DIR="$SLOT_B_DIR"; TARGET_PORT="$SLOT_B_PORT"; OLD_PORT="$SLOT_A_PORT"
elif [ "$ACTIVE_PORT" = "$SLOT_B_PORT" ]; then
  TARGET_DIR="$SLOT_A_DIR"; TARGET_PORT="$SLOT_A_PORT"; OLD_PORT="$SLOT_B_PORT"
else
  TARGET_DIR="$SLOT_A_DIR"; TARGET_PORT="$SLOT_A_PORT"; OLD_PORT=""
fi
say "active slot: ${ACTIVE_PORT:-none} -> installing into $TARGET_DIR ($TARGET_PORT)"

# ── 4. keep the standby's *code* identical, not just its data ──────────────
# The router serves half the static traffic from the standby, and ad landing
# pages are static. A stale build there would show an old site to real ad
# clicks, so the deployable tree is synced with every data sync — into the IDLE
# slot, so the live one keeps the code it booted with.
scp -q -o BatchMode=yes scripts/failover-slot.sh "$STANDBY_SSH:~/hakster-standby-ctl.sh" \
  && ssh -n -o BatchMode=yes "$STANDBY_SSH" 'chmod 700 ~/hakster-standby-ctl.sh' \
  || { say "failed: could not install the slot helper"; exit 1; }

# The standby's own router is kept current the same way. Copying it does not
# change the running process: a router code change still needs its own restart,
# which is a deliberate decision, never a side effect of a data sync.
scp -q -o BatchMode=yes scripts/failover-router.cjs "$STANDBY_SSH:~/hakster-standby-router.cjs" \
  || { say "warning: could not update the standby's router file"; }

ssh -n -o BatchMode=yes "$STANDBY_SSH" "mkdir -p ~/$TARGET_DIR/data" \
  || { say "failed: could not create $TARGET_DIR"; exit 1; }

if [ "${SKIP_CODE:-0}" != "1" ]; then
  rsync -a --safe-links \
    --exclude='node_modules' --exclude='.git' --exclude='*.bak*' --exclude='*.db' --exclude='*.db-*' \
    --exclude='.env*' --exclude='*.key' --exclude='*.pem' --exclude='*.p12' \
    --exclude='google-oauth-client.json' --exclude='archives' --exclude='backups' --exclude='data' \
    -e "ssh -o BatchMode=yes" \
    /home/ghost/haksterAi/cli /home/ghost/haksterAi/server /home/ghost/haksterAi/dist \
    /home/ghost/haksterAi/scripts /home/ghost/haksterAi/public /home/ghost/haksterAi/package.json \
    "$STANDBY_SSH:$TARGET_DIR/" \
    && say "code synced into $TARGET_DIR (dist, server, cli, scripts)" \
    || { say "warning: code sync did not complete - the slot keeps its previous build"; }
else
  say "code sync skipped (SKIP_CODE=1)"
fi

# ── 5. install the database into the IDLE slot (nobody is serving from it) ─
scp -q -o BatchMode=yes "$TMP/hakster.db" "$STANDBY_SSH:$TARGET_DIR/data/hakster.db.new" \
  || { say "failed: copy did not arrive"; exit 1; }
ssh -n -o BatchMode=yes "$STANDBY_SSH" \
  "sh ~/hakster-standby-ctl.sh install ~/$TARGET_DIR $WANT" \
  | sed 's/^/  /' || { say "failed: install refused (checksum?)"; exit 1; }

# ── 6. boot the idle slot and wait until it really answers ─────────────────
if [ "$(curl -s -m 3 -o /dev/null -w '%{http_code}' "http://$STANDBY_HOST:$TARGET_PORT/api/version" 2>/dev/null || true)" != "200" ]; then
  ssh -n -o BatchMode=yes "$STANDBY_SSH" \
    "sh ~/hakster-standby-ctl.sh start ~/$TARGET_DIR $TARGET_PORT" | sed 's/^/  /' \
    || { say "failed: slot would not start"; exit 1; }
fi

i=0; up=""
while [ $i -lt 40 ]; do
  if [ "$(curl -s -m 3 -o /dev/null -w '%{http_code}' "http://$STANDBY_HOST:$TARGET_PORT/api/version" 2>/dev/null || true)" = "200" ]; then
    up="yes"; break
  fi
  i=$((i + 1)); sleep 1
done
if [ -z "$up" ]; then
  say "failed: $TARGET_DIR did not answer on $TARGET_PORT within 40 s - the old slot keeps the traffic"
  exit 1
fi
say "idle slot is answering on $TARGET_PORT - switching the router to it"

# ── 7. move traffic, then stop the old slot ────────────────────────────────
ssh -n -o BatchMode=yes "$STANDBY_SSH" \
  "sh ~/hakster-standby-ctl.sh switch $TARGET_PORT" | sed 's/^/  /' \
  || { say "failed: the router did not accept the switch - the old slot keeps the traffic"; exit 1; }

if [ -n "$OLD_PORT" ] && [ "$OLD_PORT" != "$TARGET_PORT" ]; then
  # Let in-flight requests finish on the old slot before it goes away.
  sleep 2
  ssh -n -o BatchMode=yes "$STANDBY_SSH" \
    "sh ~/hakster-standby-ctl.sh stop $OLD_PORT" | sed 's/^/  /' || true
fi

# ── 8. confirm what the Dell actually sees through the door ────────────────
code=""
i=0
while [ $i -lt 10 ]; do
  code=$(curl -s -m 3 -o /dev/null -w '%{http_code}' "$STANDBY_URL/api/version" 2>/dev/null || true)
  [ "$code" = "200" ] && break
  i=$((i + 1)); sleep 1
done
say "done: standby door answered ${code:-nothing} on $STANDBY_URL (active slot $TARGET_PORT)"
[ "$code" = "200" ]
