#!/bin/sh
# failover-slot.sh — the standby box's half of the blue-green swap.
#
# Owner, 2026-11-25: "no user gets errors we need both online at all times".
# A box runs its app in two slots (A and B) on two ports. Only the slot the
# router calls active takes traffic. This helper never decides anything about
# which slot should be live — the sync on the primary owns that — it only
# performs one step at a time and says truthfully what happened.
#
#   failover-slot.sh active                  active slot's port, from the router (empty if unknown)
#   failover-slot.sh port-up <port>          200 | down
#   failover-slot.sh install <dir> <sha256>  verify hakster.db.new, keep .prev, swap in
#   failover-slot.sh start <dir> <port>      boot the slot; refuses if the port is taken
#   failover-slot.sh stop <port>             stop whatever listens on that port
#   failover-slot.sh switch <port>           point the router at this slot (loopback only)
#
# Nothing is deleted except this helper's own failed download (hakster.db.new
# on a checksum mismatch), and the previous database is always kept as
# hakster.db.prev (CLAUDE.md §2.1, §4).
set -eu

# The standby's own router. Overridable so a rehearsal can drive a test router
# without touching the production one.
ROUTER="${FAILOVER_ROUTER:-http://127.0.0.1:3579}"

say() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

pid_on_port() {
  ss -ltnp 2>/dev/null | grep ":$1 " | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -n 1
}

case "${1:-}" in
  active)
    # Read-only: the router owns the answer. No router, no answer, no guessing.
    url=$(curl -s -m 4 "$ROUTER/router/status" 2>/dev/null |
          sed -n 's/.*"activePeerUrl": *"http:\/\/[^:]*:\([0-9]*\)".*/\1/p')
    printf '%s\n' "$url"
    ;;

  port-up)
    port="$2"
    if curl -s -m 3 -o /dev/null -w '' "http://127.0.0.1:$port/api/version" 2>/dev/null; then
      echo 200
    else
      echo down
    fi
    ;;

  install)
    dir="$2"; want="$3"
    cd "$dir/data" || { say "install: no $dir/data"; exit 1; }
    [ -f hakster.db.new ] || { say "install: nothing to install"; exit 1; }
    got=$(sha256sum hakster.db.new | cut -d' ' -f1)
    if [ "$got" != "$want" ]; then
      say "install: checksum mismatch (got ${got%%????????????????????????????????????????}) - keeping the old copy"
      rm -f hakster.db.new
      exit 1
    fi
    if [ -f hakster.db ]; then cp -p hakster.db hakster.db.prev; fi
    mv hakster.db.new hakster.db
    chmod 600 hakster.db
    say "install: installed ${got%%????????????????????????????????????????}"
    ;;

  start)
    dir="$2"; port="$3"
    if [ -n "$(pid_on_port "$port")" ]; then
      say "start: port $port already in use - not starting a second writer"
      exit 1
    fi
    [ -d "$dir/server" ] || { say "start: no $dir/server"; exit 1; }
    cd "$dir/server" || exit 1
    setsid env PORT="$port" node src/index.js </dev/null >> "$dir/failover.log" 2>&1 &
    say "start: slot $dir booting on $port"
    ;;

  stop)
    port="$2"
    pid=$(pid_on_port "$port")
    if [ -z "$pid" ]; then
      say "stop: nothing on $port"
      exit 0
    fi
    kill "$pid"
    n=0
    while [ "$n" -lt 40 ] && [ -n "$(pid_on_port "$port")" ]; do
      sleep 0.25; n=$((n + 1))
    done
    if [ -n "$(pid_on_port "$port")" ]; then
      say "stop: pid $pid still holding $port after 10 s"
      exit 1
    fi
    say "stop: $port released"
    ;;

  switch)
    port="$2"
    # Loopback on the standby's own router: the sync never crosses the LAN to
    # change routing, so the control surface is not exposed.
    out=$(curl -s -m 5 -X POST -H 'content-type: application/json' \
      -d "{\"url\":\"http://127.0.0.1:$port\"}" "$ROUTER/router/peer" 2>/dev/null || true)
    case "$out" in
      *'"activePeerUrl"'*) say "switch: router now serves $port" ;;
      *) say "switch: refused -> ${out:-no answer}"; exit 1 ;;
    esac
    ;;

  *)
    echo "usage: $0 active|port-up <port>|install <dir> <sha256>|start <dir> <port>|stop <port>|switch <port>" >&2
    exit 2
    ;;
esac
