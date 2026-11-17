#!/bin/bash
# Inspect freebuff credential/profile layout on parrot.
echo "=== real HOME creds (~/.config/codebuff) ==="
ls -la "$HOME/.config/codebuff" "$HOME/.codebuff" 2>/dev/null || echo "NO_REAL_CREDS"

echo ""
echo "=== isolated homes created by our module ==="
BASE=/home/ghost694/workspace/dekekenneth840@gmail.com/data/freebuff-accounts
ls -d $BASE/home-* 2>/dev/null | head -5

echo ""
echo "=== stored profile ==="
cat $BASE/profile.json 2>/dev/null || echo "NO_PROFILE"

echo ""
echo "=== any credentials.json inside isolated homes? ==="
find $BASE -name "*.json" 2>/dev/null | head -10

echo ""
echo "=== freebuff --help (does it take login/account flags?) ==="
timeout 25 /home/ghost694/.local/bin/freebuff --help 2>&1 | head -40
