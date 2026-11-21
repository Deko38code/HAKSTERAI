#!/bin/bash
# haksterai-tunnel-watchdog.sh
# Restarts haksterai-dell-tunnel when the public URL goes unreachable.
# Solves: WiFi switches break cloudflared edge connections -> Error 1033
# while the PM2 process stays "online" and never triggers PM2 restart.

LOG="/home/ghost/.pm2/logs/tunnel-watchdog.log"
FAIL_COUNT=0
MAX_FAILS=3
INTERVAL=20
LAST_RESTART=0
COOLDOWN=120  # don't restart more than once per 2 min

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $1" >> "$LOG"; }

log "watchdog started (interval=${INTERVAL}s, fails=${MAX_FAILS}, cooldown=${COOLDOWN}s)"

while true; do
  # Probe the PUBLIC url through Cloudflare edge — this is what actually breaks
  HTTP=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 https://haksterai.com/api/health 2>/dev/null)

  if [ "$HTTP" = "200" ]; then
    if [ "$FAIL_COUNT" -gt 0 ]; then
      log "recovered (200) after $FAIL_COUNT fails"
    fi
    FAIL_COUNT=0
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    log "probe failed: http=$HTTP (fail $FAIL_COUNT/$MAX_FAILS)"

    if [ "$FAIL_COUNT" -ge "$MAX_FAILS" ]; then
      NOW=$(date +%s)
      if [ $((NOW - LAST_RESTART)) -ge "$COOLDOWN" ]; then
        log "RESTARTING haksterai-dell-tunnel (public URL down: http=$HTTP)"
        pm2 restart haksterai-dell-tunnel >> "$LOG" 2>&1
        LAST_RESTART=$NOW
        FAIL_COUNT=0
        sleep 15  # give tunnel time to register edge connections
      else
        log "in cooldown, skipping restart"
        FAIL_COUNT=0
      fi
    fi
  fi

  sleep "$INTERVAL"
done
