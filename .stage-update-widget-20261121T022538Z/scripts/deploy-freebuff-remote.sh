#!/bin/bash
# Deploy freebuff auth module to parrot (:9191) and wire it into the server.
set -uo pipefail
APP=/home/ghost694/workspace/dekekenneth840@gmail.com
SRV=$APP/email-monitor-server.js
LOCALMOD=/home/ghost/haksterAi/.work/freebuff-auth.js
REMOTEMOD=$APP/email-monitor/freebuff-auth.js
TS=$(date -u +%Y%m%dT%H%M%SZ)

echo "=== 1. backup server ==="
timeout 30 ssh -o BatchMode=yes -o ConnectTimeout=8 parrot "cp -a $SRV $SRV.bak-fb-$TS && echo backed-up:\$?"
echo "=== 2. upload module ==="
timeout 45 scp -o BatchMode=yes -o ConnectTimeout=8 "$LOCALMOD" "parrot:$REMOTEMOD" >/dev/null 2>&1 \
  && echo "uploaded -> $REMOTEMOD" || echo "UPLOAD FAILED"

echo "=== 3. syntax check on remote ==="
timeout 30 ssh -o BatchMode=yes -o ConnectTimeout=8 parrot "node -c $REMOTEMOD && echo REMOTE_SYNTAX_OK"

echo "=== 4. check freebuff binary exists there ==="
timeout 30 ssh -o BatchMode=yes -o ConnectTimeout=8 parrot "ls -l /home/ghost694/.npm-global/bin/freebuff 2>/dev/null || command -v freebuff || echo NO_FREEBUFF_BIN"
