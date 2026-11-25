#!/bin/sh
# failover-sync.sh — keep the Lenovo standby's database close to the Dell's.
#
# Owner, 2026-11-25: "if dell server drops for period of time lenovo kicks in".
# A standby is only useful if its account data is current, so this copies the
# Dell's live SQLite snapshot to the Lenovo standby on a timer.
#
# Safety rules this script enforces (CLAUDE.md §2, §4):
#   · It never touches the Dell's running server or its database in place — the
#     snapshot comes from SQLite's own backup API, which is safe on a live DB.
#   · It refuses to sync if the standby has answered traffic during a failover
#     (`failovers` rose since the last run): those writes exist only on the
#     Lenovo and a copy now would destroy them. The owner decides that case.
#   · The standby instance is stopped for the copy and started again after it,
#     because a running SQLite process keeps the old inode open.
#   · Nothing is deleted: the previous standby DB is kept as hakster.db.prev.
#
# Env (all optional):
#   STANDBY_SSH      default mint
#   STANDBY_DIR      default ~/haksterAi-failover-<newest>   (resolved on the peer)
#   STANDBY_PORT     default 3581
#   ROUTER_STATUS    default http://127.0.0.1:3579/router/status
#   STATE_FILE       default /tmp/hakster-failover-sync.state
set -eu

STANDBY_SSH="${STANDBY_SSH:-mint}"
STANDBY_URL="${STANDBY_URL:-http://10.0.0.210:3581}"
STANDBY_PORT="${STANDBY_PORT:-3581}"
ROUTER_STATUS="${ROUTER_STATUS:-http://127.0.0.1:3579/router/status}"
STATE_FILE="${STATE_FILE:-/tmp/hakster-failover-sync.state}"
LOCAL_DB="${LOCAL_DB:-/home/ghost/haksterAi/data/hakster.db}"
TMP="${TMPDIR:-/tmp}/hakster-sync.$$"

say() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT INT TERM
mkdir -p "$TMP"

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

# ── 2b. keep the standby's *code* identical, not just its data ─────────────
# The router serves half the static traffic from the standby, and ad landing
# pages are static. A stale build there would show an old site to real ad
# clicks, so the deployable tree is synced with every data sync.
REMOTE_DIR=$(ssh -o BatchMode=yes "$STANDBY_SSH" \
  'ls -1d ~/haksterAi-failover-* 2>/dev/null | sort | tail -n 1')
[ -n "$REMOTE_DIR" ] || { say "failed: no standby directory on $STANDBY_SSH"; exit 1; }
if [ "${SKIP_CODE:-0}" != "1" ]; then
  rsync -a --safe-links \
    --exclude='node_modules' --exclude='.git' --exclude='*.bak*' --exclude='*.db' --exclude='*.db-*' \
    --exclude='.env*' --exclude='*.key' --exclude='*.pem' --exclude='*.p12' \
    --exclude='google-oauth-client.json' --exclude='archives' --exclude='backups' --exclude='data' \
    -e "ssh -o BatchMode=yes" \
    /home/ghost/haksterAi/cli /home/ghost/haksterAi/server /home/ghost/haksterAi/dist \
    /home/ghost/haksterAi/scripts /home/ghost/haksterAi/public /home/ghost/haksterAi/package.json \
    "$STANDBY_SSH:$REMOTE_DIR/" \
    && say "code synced to the standby (dist, server, cli, scripts)" \
    || { say "warning: code sync did not complete - standby keeps its previous build"; }
else
  say "code sync skipped (SKIP_CODE=1)"
fi

# ── 3. stop the standby, swap the file in, start it again ──────────────────
say "standby: $STANDBY_SSH:$REMOTE_DIR (port $STANDBY_PORT)"

ssh -n -o BatchMode=yes "$STANDBY_SSH" "
  pid=\$(ss -ltnp 2>/dev/null | grep ':$STANDBY_PORT ' | sed -n 's/.*pid=\\([0-9]*\\).*/\\1/p' | head -n 1)
  if [ -n \"\$pid\" ]; then kill \"\$pid\"; sleep 1; fi
" || true

scp -q -o BatchMode=yes "$TMP/hakster.db" "$STANDBY_SSH:$REMOTE_DIR/data/hakster.db.new" || {
  say "failed: copy did not arrive"; exit 1; }

ssh -n -o BatchMode=yes "$STANDBY_SSH" "
  cd '$REMOTE_DIR/data' || exit 1
  got=\$(sha256sum hakster.db.new | cut -d' ' -f1)
  [ \"\$got\" = '$WANT' ] || { echo 'checksum mismatch - keeping the old copy'; rm -f hakster.db.new; exit 1; }
  [ -f hakster.db ] && cp -p hakster.db hakster.db.prev
  mv hakster.db.new hakster.db
  chmod 600 hakster.db
  echo \"installed \$got\"
  cd '$REMOTE_DIR/server' || exit 1
  setsid env PORT=$STANDBY_PORT node src/index.js </dev/null >> ../failover.log 2>&1 &
" || { say "failed: standby swap did not complete"; exit 1; }

# ── 4. confirm the standby is answering again ─────────────────────────────
i=0
while [ $i -lt 12 ]; do
  code=$(curl -s -m 3 -o /dev/null -w '%{http_code}' "$STANDBY_URL/api/version" 2>/dev/null || true)
  [ "$code" = "200" ] && break
  i=$((i + 1)); sleep 2
done
say "done: standby answered ${code:-nothing} after the swap"
