#!/bin/bash
# Restore email-monitor on parrot with the correct NODE_PATH.
set -uo pipefail
APP=/home/ghost694/workspace/dekekenneth840@gmail.com

timeout 60 ssh -o BatchMode=yes -o ConnectTimeout=8 parrot "
APP='$APP'
PID=\$(ss -ltnp 2>/dev/null | grep 9191 | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2)
[ -n \"\$PID\" ] && kill -9 \$PID 2>/dev/null
sleep 1
cd \$APP
export NODE_PATH=\$APP/omp-preview/node_modules:\$APP/node_modules:/home/ghost694/node_modules
setsid nohup node email-monitor-server.js > /tmp/em.log 2>&1 < /dev/null &
sleep 6
echo \"pid=\$(ss -ltnp 2>/dev/null | grep 9191 | grep -oE 'pid=[0-9]+' | head -1)\"
tail -6 /tmp/em.log
"
