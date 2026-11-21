#!/bin/bash
# Fetch the remote email-monitor server source locally for safe editing.
set -uo pipefail
REMOTE=/home/ghost694/workspace/dekekenneth840@gmail.com/email-monitor-server.js
LOCAL=/home/ghost/haksterAi/.work/email-monitor-server.js
mkdir -p /home/ghost/haksterAi/.work

timeout 45 ssh -o BatchMode=yes -o ConnectTimeout=8 parrot "cat $REMOTE" > "$LOCAL" 2>/tmp/fetch.err
RC=$?
echo "ssh rc=$RC"
if [ -s /tmp/fetch.err ]; then echo "--- stderr ---"; head -5 /tmp/fetch.err; fi
echo "--- size ---"
wc -l "$LOCAL" 2>/dev/null
echo "--- kiro / spawn / profile lines ---"
grep -n "kiro\|spawn\|execFile\|node-pty\|profile\|terminal" "$LOCAL" 2>/dev/null | head -30
