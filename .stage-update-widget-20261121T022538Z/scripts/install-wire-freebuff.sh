#!/bin/bash
# Install freebuff CLI on parrot, wire the auth module into the server, restart.
set -uo pipefail
APP=/home/ghost694/workspace/dekekenneth840@gmail.com
SRV=$APP/email-monitor-server.js
MOD=$APP/email-monitor/freebuff-auth.js

echo "=== 1. install freebuff on parrot ==="
timeout 180 ssh -o BatchMode=yes -o ConnectTimeout=8 parrot \
  'export PATH=$HOME/.npm-global/bin:$PATH; npm install -g freebuff --silent 2>&1 | tail -3; ls -l $HOME/.npm-global/bin/freebuff 2>/dev/null || echo INSTALL_FAILED'

echo "=== 2. wire mount into server (idempotent) ==="
timeout 40 ssh -o BatchMode=yes -o ConnectTimeout=8 parrot "grep -q freebuff-auth $SRV && echo ALREADY_WIRED || (printf '\n// Freebuff CLI auth (ban-safe: spawns real CLI)\ntry { require(\"./email-monitor/freebuff-auth\").mount(app); } catch (e) { console.error(\"[freebuff] mount failed:\", e.message); }\n' >> $SRV && echo WIRED)"

echo "=== 3. syntax + restart ==="
timeout 30 ssh -o BatchMode=yes -o ConnectTimeout=8 parrot "node -c $SRV && echo SERVER_SYNTAX_OK"
timeout 40 ssh -o BatchMode=yes -o ConnectTimeout=8 parrot 'PID=$(ss -ltnp 2>/dev/null | grep 9191 | grep -oE "pid=[0-9]+" | head -1 | cut -d= -f2); echo "old pid=$PID"; kill $PID 2>/dev/null; sleep 2; cd /home/ghost694/workspace/dekekenneth840@gmail.com && nohup node email-monitor-server.js > /tmp/em.log 2>&1 & sleep 4; echo "new pid=$(ss -ltnp 2>/dev/null | grep 9191 | grep -oE "pid=[0-9]+" | head -1)"'
