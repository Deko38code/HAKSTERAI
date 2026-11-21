#!/bin/bash
# Redeploy freebuff-auth.js with corrected manicode credential paths.
set -uo pipefail
APP=/home/ghost694/workspace/dekekenneth840@gmail.com
MOD=$APP/email-monitor/freebuff-auth.js
SRC=/home/ghost/haksterAi/.work/freebuff-auth.js

node -c "$SRC" && echo "LOCAL_SYNTAX_OK" || { echo "LOCAL_SYNTAX_FAIL"; exit 1; }

timeout 45 scp -o BatchMode=yes -o ConnectTimeout=8 "$SRC" "parrot:$MOD" >/dev/null 2>&1 \
  && echo "uploaded" || { echo "UPLOAD_FAILED"; exit 1; }

timeout 30 ssh -o BatchMode=yes -o ConnectTimeout=8 parrot "node -c $MOD && echo REMOTE_SYNTAX_OK"

timeout 70 ssh -o BatchMode=yes -o ConnectTimeout=8 parrot "
APP='$APP'
PID=\$(ss -ltnp 2>/dev/null | grep 9191 | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2)
[ -n \"\$PID\" ] && kill \$PID 2>/dev/null
sleep 2
cd \$APP
export NODE_PATH=\$APP/omp-preview/node_modules:\$APP/node_modules:/home/ghost694/node_modules
setsid nohup node email-monitor-server.js > /tmp/em.log 2>&1 < /dev/null &
sleep 8
echo \"listening=\$(ss -ltnp 2>/dev/null | grep -c 9191)\"
grep -i freebuff /tmp/em.log | tail -2
"
