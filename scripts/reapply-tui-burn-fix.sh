#!/usr/bin/env bash
# Idempotent guard for the TUI-dashboard-burn fix in server/src/agent/index.js.
# - If the patch (_writeDashboardInPlace sentinel) is present: no-op.
# - If missing: restore from index.js.bak.tuiburn (pre-patch snapshot that the
#   original patcher created) — then the patcher must be re-run to re-apply.
# Usage: bash scripts/reapply-tui-burn-fix.sh
set -euo pipefail
SRC=/home/ghost/haksterAi/server/src/agent/index.js
BAK=/home/ghost/haksterAi/server/src/agent/index.js.bak.tuiburn
if grep -q "_writeDashboardInPlace" "$SRC"; then
  echo "✓ TUI burn fix present ($(grep -c "_writeDashboardInPlace" "$SRC") refs). Nothing to do."
  exit 0
fi
echo "✗ TUI burn fix MISSING in $SRC"
if [ ! -f "$BAK" ]; then
  echo "  No pre-patch backup at $BAK — cannot auto-restore. Re-patch manually." >&2
  exit 2
fi
echo "  Restoring pre-patch snapshot from $BAK (you must then re-apply the patch)."
cp -a "$BAK" "$SRC"
echo "  Restored. Re-run the original patcher to re-apply the fix."
