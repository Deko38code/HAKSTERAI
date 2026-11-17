#!/bin/bash
# Restart the email-monitor server on parrot and verify freebuff endpoints.
set -uo pipefail
APP=/home/ghost694/workspace/dekekenneth840@gmail.com

echo "=== restart ==="
timeout 45 ssh -o BatchMode=yes -o ConnectTimeout=8 parrot '
PID=$(ss -ltnp 2>/dev/null | grep 9191 | grep -oE "pid=[0-9]+" | head -1 | cut -d= -f2)
echo "old pid=$PID"
[ -n "$PID" ] && kill -9 $PID 2>/dev/null
sleep 2
cd /home/ghost694/workspace/dekekenneth840@gmail.com
setsid nohup node email-monitor-server.js > /tmp/em.log 2>&1 < /dev/null &
sleep 5
NEW=$(ss -ltnp 2>/dev/null | grep 9191 | grep -oE "pid=[0-9]+" | head -1)
echo "new $NEW"
tail -5 /tmp/em.log 2>/dev/null
'

echo "=== hit freebuff start endpoint ==="
timeout 60 curl -s --max-time 55 -X POST http://10.0.0.251:9191/api/freebuff/start \
  -H 'Content-Type: application/json' -d '{}' | head -c 400
echo ""
