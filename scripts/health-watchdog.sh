#!/usr/bin/env bash
# haksterAi health watchdog — checks /api/health and restarts PM2 if degraded
# Designed to run via cron every 5 minutes

HEALTH_URL="http://localhost:3579/api/health"
PM2_NAME="haksterAi"
MAX_RESTARTS=3  # don't restart more than this many times in a row
STATE_FILE="/tmp/hakster-health-failures"

failures=0
if [ -f "$STATE_FILE" ]; then
  failures=$(cat "$STATE_FILE")
fi

# Hit health endpoint with 5s timeout
HTTP_CODE=$(curl -s -o /tmp/hakster-health-body -w "%{http_code}" --max-time 5 "$HEALTH_URL" 2>/dev/null)

if [ "$HTTP_CODE" = "200" ]; then
  # Reset failure counter on success
  echo "0" > "$STATE_FILE"
  exit 0
fi

# Health check failed
failures=$((failures + 1))
echo "$failures" > "$STATE_FILE"

echo "[watchdog] health check FAILED (HTTP $HTTP_CODE, attempt $failures/$MAX_RESTARTS)"
cat /tmp/hakster-health-body 2>/dev/null | head -5

if [ "$failures" -ge "$MAX_RESTARTS" ]; then
  echo "[watchdog] 3 consecutive failures — attempting PM2 restart"
  pm2 restart "$PM2_NAME" --update-env 2>&1
  
  # If restart didn't fix it, try rebuilding better-sqlite3
  sleep 5
  RECHECK=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$HEALTH_URL" 2>/dev/null)
  if [ "$RECHECK" != "200" ]; then
    echo "[watchdog] still unhealthy after restart — rebuilding better-sqlite3"
    cd /home/ghost/haksterAi/server && npm rebuild better-sqlite3 2>&1 | tail -3
    pm2 restart "$PM2_NAME" --update-env 2>&1
    sleep 5
    RECHECK2=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$HEALTH_URL" 2>/dev/null)
    if [ "$RECHECK2" != "200" ]; then
      echo "[watchdog] CRITICAL: still unhealthy after rebuild+restart"
      echo "[watchdog] Manual intervention required"
    else
      echo "[watchdog] RECOVERED after rebuild"
      echo "0" > "$STATE_FILE"
    fi
  else
    echo "[watchdog] RECOVERED after PM2 restart"
    echo "0" > "$STATE_FILE"
  fi
fi