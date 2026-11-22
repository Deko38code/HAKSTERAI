#!/usr/bin/env bash
# hakster-guardrails.sh
#
# Additive helper for haksterAi (or any tool-calling agent with a round budget).
# It does NOT modify your project. It just gives you three commands you can
# shell out to from your Node/Ink harness:
#
#   preflight [port] [entryfile]   -> diagnoses "server won't start" issues
#   track "<command>"              -> logs a command, detects repeat-loops
#   nudge <round> <max_rounds>     -> prints a system-prompt nudge for this round
#   reset                          -> clears state (call at the start of a new task)
#
# State lives in ~/.hakster/ so it survives across your stateless run_command calls.

set -uo pipefail

STATE_DIR="${HOME}/.hakster"
HIST_FILE="${STATE_DIR}/cmd_history.log"
LOOP_FLAG="${STATE_DIR}/loop_count"
mkdir -p "$STATE_DIR"

cmd="${1:-}"
shift || true

case "$cmd" in

  preflight)
    port="${1:-3000}"
    entry="${2:-}"
    echo "== hakster preflight: port $port =="

    # 1. Node/npm present?
    if ! command -v node >/dev/null 2>&1; then
      echo "FAIL: node not found on PATH"
    else
      echo "OK: node $(node -v)"
    fi
    if ! command -v npm >/dev/null 2>&1; then
      echo "FAIL: npm not found on PATH"
    else
      echo "OK: npm $(npm -v)"
    fi

    # 2. package.json / node_modules sanity
    if [ -f package.json ]; then
      echo "OK: package.json present"
      if [ ! -d node_modules ]; then
        echo "WARN: node_modules missing — likely needs 'npm install'"
      fi
    else
      echo "WARN: no package.json in $(pwd) — wrong cwd, or project not initialized"
    fi

    # 3. Is the port already taken? (this is the #1 cause of "server won't start")
    if command -v lsof >/dev/null 2>&1; then
      hit=$(lsof -i ":${port}" -sTCP:LISTEN -t 2>/dev/null || true)
      if [ -n "$hit" ]; then
        echo "FAIL: port $port already in use by PID(s): $hit"
        echo "      -> a previous run is probably still alive. Kill it or pick another port."
      else
        echo "OK: port $port is free"
      fi
    elif command -v ss >/dev/null 2>&1; then
      if ss -ltn "( sport = :${port} )" 2>/dev/null | grep -q ":${port}"; then
        echo "FAIL: port $port already in use (via ss)"
      else
        echo "OK: port $port appears free"
      fi
    else
      echo "WARN: neither lsof nor ss available — can't check port $port directly"
    fi

    # 4. Entry file syntax check, if given
    if [ -n "$entry" ]; then
      if [ -f "$entry" ]; then
        if node --check "$entry" 2>/tmp/hakster_syntax_err; then
          echo "OK: $entry has valid syntax"
        else
          echo "FAIL: syntax error in $entry:"
          sed 's/^/      /' /tmp/hakster_syntax_err
        fi
      else
        echo "WARN: entry file '$entry' not found relative to $(pwd)"
      fi
    fi
    echo "== end preflight =="
    ;;

  track)
    thecmd="${1:-}"
    ts=$(date +%s)
    echo "${ts}|${thecmd}" >> "$HIST_FILE"

    # Count how many of the last 5 logged commands are identical to this one
    last5=$(tail -n 5 "$HIST_FILE" | cut -d'|' -f2-)
    repeats=$(echo "$last5" | grep -Fxc "$thecmd" || true)

    if [ "$repeats" -ge 3 ]; then
      echo "$repeats" > "$LOOP_FLAG"
      echo "LOOP_DETECTED: '$thecmd' has repeated ${repeats}x in the last 5 actions." >&2
    else
      rm -f "$LOOP_FLAG" 2>/dev/null || true
    fi
    ;;

  nudge)
    round="${1:-0}"
    max="${2:-50}"
    pct=$(( round * 100 / (max > 0 ? max : 1) ))
    loop_n=0
    [ -f "$LOOP_FLAG" ] && loop_n=$(cat "$LOOP_FLAG")

    if [ "$loop_n" -ge 3 ]; then
      idx=$(( round % 4 ))
      case "$idx" in
        0) echo "NUDGE: You've repeated the same command 3+ times with the same result. Stop retrying it verbatim. Read the actual last error output before your next action.";;
        1) echo "NUDGE: Loop detected. Check assumptions: correct cwd? correct port? is a stale process already running from a prior attempt?";;
        2) echo "NUDGE: Loop detected. Try a smaller diagnostic step (e.g. 'node --check file.js', or 'lsof -i :PORT') instead of repeating the full run.";;
        3) echo "NUDGE: Loop detected. Explain in one sentence why the last attempt failed before trying again — if you can't, that's the signal to change approach.";;
      esac
    elif [ "$round" -ge "$max" ]; then
      echo "NUDGE: Round budget exhausted ($round/$max). Ship now — emit your best current result and a one-line note on what remains. Do not start anything new."
    elif [ "$pct" -ge 80 ]; then
      echo "NUDGE: You are past 80% of your round budget ($round/$max). Stop exploring alternatives. Commit to the simplest fix, apply it, run one verification command, then stop."
    elif [ "$pct" -ge 50 ]; then
      echo "NUDGE: Past halfway ($round/$max rounds). Prefer verifying with the smallest possible command over broad re-exploration."
    fi
    # else: no nudge needed, print nothing
    ;;

  reset)
    rm -f "$HIST_FILE" "$LOOP_FLAG"
    echo "hakster guardrail state cleared."
    ;;

  *)
    echo "usage: $0 {preflight [port] [entryfile] | track \"<cmd>\" | nudge <round> <max> | reset}" >&2
    exit 1
    ;;
esac
