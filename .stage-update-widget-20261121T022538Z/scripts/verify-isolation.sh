#!/bin/bash
# Verify Option A: per-session isolated HOME, real HOME untouched.
APP=/home/ghost694/workspace/dekekenneth840@gmail.com
BASE=$APP/data/freebuff-accounts

echo "=== 1. snapshot real HOME config (must be unchanged) ==="
md5sum /home/ghost694/.config/manicode/settings.json 2>/dev/null
md5sum /home/ghost694/.config/manicode/analytics-id.json 2>/dev/null

echo ""
echo "=== 2. count isolated homes BEFORE ==="
BEFORE=$(ls -d $BASE/home-* 2>/dev/null | wc -l)
echo "homes=$BEFORE"

echo ""
echo "=== 3. trigger two logins ==="
for i in 1 2; do
  curl -s --max-time 30 -X POST http://127.0.0.1:9191/api/freebuff/start \
    -H 'Content-Type: application/json' -d '{}' | head -c 150
  echo ""
done

echo ""
echo "=== 4. count isolated homes AFTER (should be +2) ==="
AFTER=$(ls -d $BASE/home-* 2>/dev/null | wc -l)
echo "homes=$AFTER"

echo ""
echo "=== 5. distinct HOMEs prove isolation ==="
ls -d $BASE/home-* 2>/dev/null | tail -3

echo ""
echo "=== 6. real HOME still unchanged? ==="
md5sum /home/ghost694/.config/manicode/settings.json 2>/dev/null
md5sum /home/ghost694/.config/manicode/analytics-id.json 2>/dev/null
