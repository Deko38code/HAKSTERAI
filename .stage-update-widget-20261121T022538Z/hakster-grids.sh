#!/usr/bin/env bash
# ┌──────────────────────────────────────────────────────────────────────────┐
# │  hakster-grids.sh — TUI dashboard tuning wrapper                       │
# │                                                                          │
# │  Controls refresh rate, scroll speed, and log capacity for the           │
# │  haksterAi pentest TUI dashboard panels.                                 │
# │                                                                          │
# │  AI Waterfall env vars (for Ink TUI):                                    │
# │    HAKSTER_WATERFALL=1            Enable waterfall (default)             │
# │    HAKSTER_WATERFALL=0            Disable waterfall                      │
# │    HAKSTER_WATERFALL_COMPACT=1    Compact mode (shorter lines)           │
# │    HAKSTER_WATERFALL_TS=1         Show timestamps (default)              │
# │    HAKSTER_WATERFALL_TS=0         Hide timestamps                        │
# │    HAKSTER_WATERFALL_MAX=100      Max waterfall steps (default: 50)      │
# │                                                                          │
# │  Usage:                                                                  │
# │    ./hakster-grids.sh                  # defaults (REFRESH_MS=200,     │
# │                                        #   SCROLL_SPEED=1,             │
# │                                        #   MAX_LOG_LINES=12)          │
# │    REFRESH_MS=100 ./hakster-grids.sh   # faster refresh (more CPU)    │
# │    SCROLL_SPEED=2 ./hakster-grids.sh   # faster spinner/nudge ticks   │
# │    MAX_LOG_LINES=50 ./hakster-grids.sh # show more tool entries        │
# │                                                                          │
# │  All three env vars are optional. Unset values fall back to defaults.   │
# └──────────────────────────────────────────────────────────────────────────┘
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Defaults ──────────────────────────────────────────────────────────────
export REFRESH_MS="${REFRESH_MS:-200}"        # Panel refresh throttle (ms). Lower = smoother, more CPU.
export SCROLL_SPEED="${SCROLL_SPEED:-1}"       # Spinner/nudge speed multiplier. Higher = faster.
export MAX_LOG_LINES="${MAX_LOG_LINES:-12}"    # Tool entries shown in TOOL GRID panel.

echo "╔══════════════════════════════════════════════════════╗"
echo "║  haksterAi TUI Dashboard                            ║"
echo "╠══════════════════════════════════════════════════════╣"
echo "║  REFRESH_MS    = ${REFRESH_MS}$(printf '%*s' $((5-${#REFRESH_MS})) '')  ms between panel redraws    ║"
echo "║  SCROLL_SPEED  = ${SCROLL_SPEED}$(printf '%*s' $((5-${#SCROLL_SPEED})) '')  spinner/nudge multiplier  ║"
echo "║  MAX_LOG_LINES = ${MAX_LOG_LINES}$(printf '%*s' $((5-${#MAX_LOG_LINES})) '')  tool entries in grid       ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

# ── Launch haksterAi with env vars propagated ──────────────────────────────
# The agent reads these at boot: REFRESH_MS, SCROLL_SPEED, MAX_LOG_LINES
# They throttle _writePanel(), spinner/nudge intervals, and TOOL GRID row count.
if [ "${1:-}" = "--pm2" ]; then
  echo "→ Restarting haksterAi via PM2 with updated env..."
  pm2 restart haksterAi --update-env
elif [ "${1:-}" = "--tui" ]; then
  # Launch the blessed TUI dashboard (live grids & panels in terminal)
  echo "→ Launching TUI dashboard with REFRESH_MS=${REFRESH_MS} SCROLL_SPEED=${SCROLL_SPEED} MAX_LOG_LINES=${MAX_LOG_LINES}"
  exec node "${SCRIPT_DIR}/tui-dashboard.cjs"
elif [ "${1:-}" = "--tui-pm2" ]; then
  # Register and start TUI dashboard via PM2
  if pm2 describe hakster-tui > /dev/null 2>&1; then
    echo "→ Restarting existing hakster-tui via PM2..."
    pm2 restart hakster-tui --update-env
  else
    echo "→ Registering hakster-tui with PM2..."
    pm2 start "${SCRIPT_DIR}/tui-dashboard.cjs" --name hakster-tui --update-env
  fi
elif [ "${1:-}" = "--cli" ]; then
  # Launch the blessed CLI chat (entity selection, streaming agent, approval prompts)
  echo "→ Launching CLI chat with MAX_LOG_LINES=${MAX_LOG_LINES}"
  exec node "${SCRIPT_DIR}/haksterai-cli.cjs"
else
  exec node "${SCRIPT_DIR}/server/src/agent/index.js" "$@"
fi