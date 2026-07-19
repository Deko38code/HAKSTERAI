#!/usr/bin/env bash
# =============================================================================
# HAKSTER LIVE AUTO-SCROLLING GRID TUI
# Grids auto-cycle and always show latest output
# =============================================================================

set -euo pipefail

# ─── Configuration (overridable via env, matching hakster-grids.sh) ───────────
REFRESH_MS="${REFRESH_MS:-500}"           # Grid refresh rate (ms)
SCROLL_SPEED="${SCROLL_SPEED:-2}"         # Spinner/nudge speed multiplier
MAX_LOG_LINES="${MAX_LOG_LINES:-100}"      # Max stored log lines

# ─── ANSI Colors ─────────────────────────────────────────────────────────────
RESET='\033[0m'
BOLD='\033[1m'
DIM='\033[2m'
BLINK='\033[5m'

BLACK='\033[30m'
RED='\033[31m'
GREEN='\033[32m'
YELLOW='\033[33m'
BLUE='\033[34m'
MAGENTA='\033[35m'
CYAN='\033[36m'
WHITE='\033[37m'
ORANGE='\033[38;5;208m'

# ─── Screen ──────────────────────────────────────────────────────────────────
COLS=$(tput cols 2>/dev/null || echo 80)
LINES=$(tput lines 2>/dev/null || echo 24)

# ─── State ───────────────────────────────────────────────────────────────────
declare -a LOG_BUFFER=()           # Rolling log buffer
declare -a GRID_PANELS=()          # Panel names
SCROLL_POS=0                       # Current scroll position
PANEL_INDEX=0                      # Which panel is focused
TICK=0

# ─── Data Generators ─────────────────────────────────────────────────────────

# Simulates live pentest output lines
generate_output() {
  local timestamp; timestamp=$(date '+%H:%M:%S')
  local r=$(( RANDOM % 20 ))
  local line=""

  case $r in
    0)  line="[${timestamp}] 📡  nmap -sV -sC -p- 10.10.10.42 → Port 22 (SSH) open" ;;
    1)  line="[${timestamp}] 📡  nmap -sV -sC -p- 10.10.10.42 → Port 80 (HTTP) open" ;;
    2)  line="[${timestamp}] 📡  nmap -sV -sC -p- 10.10.10.42 → Port 443 (HTTPS) open" ;;
    3)  line="[${timestamp}] 🧠  Apache 2.4.49 detected → CVE-2021-41773 🚩" ;;
    4)  line="[${timestamp}] 🧠  Tomcat 9.0.30 detected → CVE-2020-1938 🚩" ;;
    5)  line="[${timestamp}] 🧠  SSH 8.2 → No known vulns ✅" ;;
    6)  line="[${timestamp}] ⚡  Exploiting CVE-2021-41773: Path Traversal" ;;
    7)  line="[${timestamp}] ⚡  Payload: ..%2e..%2e/cgi-bin/bin/bash" ;;
    8)  line="[${timestamp}] ⚡  WAF detected! Bypassing with URL encoding..." ;;
    9)  line="[${timestamp}] ⚡  Bypass success! 200 OK" ;;
    10) line="[${timestamp}] 🔥  RCE achieved! User: www-data" ;;
    11) line="[${timestamp}] 🔥  cat /etc/passwd | head -5" ;;
    12) line="[${timestamp}] 🔥  Escalating: sudo -l → NOPASSWD: /bin/su" ;;
    13) line="[${timestamp}] 🔑  Root shell obtained! uid=0(root)" ;;
    14) line="[${timestamp}] 🔑  Dumping /etc/shadow..." ;;
    15) line="[${timestamp}] 📋  Cracking hashes with john..." ;;
    16) line="[${timestamp}] 📋  Pivoting to 10.10.10.43 via SSH tunnel" ;;
    17) line="[${timestamp}] 📋  Internal scan: 10.10.10.0/24 → 3 hosts up" ;;
    18) line="[${timestamp}] 📋  Report: CVSS 9.8 (CVE-2020-1938) - Critical" ;;
    19) line="[${timestamp}] ✅  Phase complete. Moving to next target." ;;
  esac

  echo "$line"
}

# ─── Grid Panel Definitions ──────────────────────────────────────────────────

# Each panel has: name, color, data source, width factor
define_panels() {
  GRID_PANELS=(
    "REASONING|$CYAN|reasoning"
    "THINKING|$MAGENTA|thinking"
    "TOOLS|$YELLOW|tools"
    "VULNS|$RED|vulns"
    "OUTPUT|$GREEN|output"
  )
}

# Generate panel-specific content
get_panel_content() {
  local panel_type=$1
  local lines=$2
  local result=()

  case "$panel_type" in
    reasoning)
      result+=("${DIM}Phase 1: Recon${RESET}")
      result+=("  ├─ Target: ${GREEN}10.10.10.42${RESET}")
      result+=("  ├─ Ports:  ${CYAN}22, 80, 443, 8080${RESET}")
      result+=("  ├─ Services: SSH, Apache, Nginx, Tomcat")
      result+=("  └─ OS: ${YELLOW}Linux 5.x (Debian)${RESET}")
      result+=("")
      result+=("${DIM}Phase 2: Vuln Analysis${RESET}")
      result+=("  ├─ ${RED}CVE-2021-41773${RESET} - Path Traversal")
      result+=("  ├─ ${RED}CVE-2020-1938${RESET}  - Ghostcat AJP")
      result+=("  └─ ${GREEN}✅ SSH - No vulns${RESET}")
      result+=("")
      result+=("${DIM}Phase 3: Exploitation${RESET}")
      result+=("  ├─ ${YELLOW}Progress: ████░░░░ 45%${RESET}")
      result+=("  └─ ${GREEN}Chain: Apache PT → AJP → RCE${RESET}")
      ;;

    thinking)
      result+=("${DIM}Agent Reasoning:${RESET}")
      result+=("")
      result+=("  🤔 ${WHITE}We have path traversal on Apache.${RESET}")
      result+=("     Attempting to chain with Ghostcat...")
      result+=("")
      result+=("  💡 ${CYAN}WAF blocking direct ../ sequences.${RESET}")
      result+=("     Trying: %2e%2e%2f → ${GREEN}200 OK!${RESET}")
      result+=("")
      result+=("  ⚠️  ${YELLOW}Check SELinux before reverse shell.${RESET}")
      result+=("")
      result+=("  🔍 ${DIM}Scanning for privesc vectors...${RESET}")
      result+=("     ${MAGENTA}CVE-2022-0847 (Dirty Pipe)${RESET} possible")
      ;;

    tools)
      result+=("${DIM}Available Tools:${RESET}")
      result+=("")
      result+=("  ${CYAN}[1]${RESET} nmap -sV -sC -p-")
      result+=("  ${GREEN}[2]${RESET} gobuster dir -u")
      result+=("  ${YELLOW}[3]${RESET} sqlmap -u")
      result+=("  ${ORANGE}[4]${RESET} searchsploit")
      result+=("  ${RED}[5]${RESET} metasploit")
      result+=("  ${CYAN}[6]${RESET} nikto -h")
      result+=("  ${MAGENTA}[7]${RESET} custom exploit")
      result+=("  ${RED}[8]${RESET} reverse shell")
      result+=("")
      result+=("${DIM}Last Used:${RESET}")
      result+=("  ${DIM}→${RESET} ${WHITE}[$(date '+%H:%M:%S')]${RESET} tool 7")
      ;;

    vulns)
      result+=("${DIM}Vulnerability Summary:${RESET}")
      result+=("")
      result+=("  ${RED}● HIGH${RESET}  CVE-2021-41773")
      result+=("     Apache Path Traversal")
      result+=("     ${YELLOW}CVSS: 7.5${RESET}")
      result+=("")
      result+=("  ${RED}● HIGH${RESET}  CVE-2020-1938")
      result+=("     Tomcat AJP Ghostcat")
      result+=("     ${YELLOW}CVSS: 9.8${RESET}")
      result+=("")
      result+=("  ${ORANGE}● MED${RESET}   CVE-2022-22965")
      result+=("     Spring4Shell")
      result+=("     ${YELLOW}CVSS: 6.5${RESET}")
      result+=("")
      result+=("  ${GREEN}● LOW${RESET}   Server header leak")
      result+=("")
      result+=("  ${MAGENTA}⚡  Chain:${RESET} 3 vulns → RCE → Root")
      ;;

    output)
      # Show the last N lines from the live log buffer
      local start=$(( ${#LOG_BUFFER[@]} - lines ))
      (( start < 0 )) && start=0
      for (( i = start; i < ${#LOG_BUFFER[@]}; i++ )); do
        result+=("${LOG_BUFFER[$i]}")
      done
      # If buffer is empty, show placeholder
      if (( ${#result[@]} == 0 )); then
        result+=("${DIM}Waiting for output...${RESET}")
      fi
      ;;
  esac

  # Pad to requested lines
  while (( ${#result[@]} < lines )); do
    result+=("")
  done

  printf '%s\n' "${result[@]}"
}

# ─── ANSI-aware string helpers ─────────────────────────────────────────────
# Strip ANSI escape sequences for visual length calculation
_strip_ansi() {
  echo -e "$1" | sed 's/\x1b\[[0-9;]*m//g'
}

# Calculate visual length of a string (strip ANSI, then measure)
_vis_len() {
  local stripped
  stripped=$(_strip_ansi "$1")
  echo "${#stripped}"
}

# Pad a string to a target visual width, truncating with … if too long
# Handles ANSI codes by measuring stripped length and padding appropriately
_pad_vis() {
  local str="$1"
  local target_len="$2"
  local stripped
  stripped=$(_strip_ansi "$str")
  local vlen=${#stripped}
  if (( vlen >= target_len )); then
    # Truncate the stripped version if too long, append …
    echo "${stripped:0:$(( target_len - 1 ))}…"
  else
    # Pad with spaces on the right
    local pad=$(( target_len - vlen ))
    printf '%s%*s' "$str" "$pad" ''
  fi
}

# ─── Render Functions ────────────────────────────────────────────────────────

# Fetch notification queue size from haksterAi server
fetch_queue_size() {
  local port="${HAKSTER_PORT:-3579}"
  local resp
  resp=$(curl -s --connect-timeout 1 "http://localhost:${port}/api/queue" 2>/dev/null) || echo "0"
  echo "$resp" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("size",0))' 2>/dev/null || echo "?"
}

print_banner() {
  echo -e "${MAGENTA}${BOLD}"
  echo ' __  __      __        __            ___  ___ '
  echo ' / / / /___ _/ /_______/ /____  _____/   |/ / ) '
  echo '/ /_/ / __ `/ //_/ ___/ __/ _ \/ ___/ /| / / /  '
  echo '/ __  / /_/ / ,< (__  ) /_/  __/ /  / ___ / /    '
  echo '/_/ /_/\__,_/_/|_/____/\__/\___/_/  /_/  |_/_/     '
  echo -e "${RESET}"
  echo -e "${BOLD}${WHITE}  haksterAI — Agentic CLI for Developers${RESET}"
  echo ""
  # Use COLS for dynamic-width separator lines
  local sep_line
  sep_line=$(printf '━%.0s' $(seq 1 $COLS))
  echo -e "${DIM}${sep_line}${RESET}"
  echo -e " ${GREEN}●${RESET} LIVE SPLIT OUTPUT GRIDS  ${DIM}|${RESET}  ${DIM}[$(date '+%H:%M:%S')]${RESET}"
  echo -e " ${DIM}Server:${RESET} http://localhost:${HAKSTER_PORT:-3579}  ${DIM}Queue:${RESET} $(fetch_queue_size) pending  ${DIM}Log:${RESET} ${#LOG_BUFFER[@]} lines"
  echo -e " ${DIM}Refresh:${RESET} ${REFRESH_MS}ms  ${DIM}Scroll:${RESET} ${SCROLL_SPEED}  ${DIM}MaxLines:${RESET} ${MAX_LOG_LINES}"
  echo -e "${DIM}${sep_line}${RESET}"
  echo ""
}

# Render a single panel with border
# Border layout:
#   ┌─ TITLE ────────┐   ← top:    1(┌) + 2(─ ) + len(name) + 1( ) + fill + 1(┐) = inner_width + 4
#   │ content here   │   ← content: 1(│) + 1( ) + inner_width + 1( ) + 1(│) = inner_width + 4
#   └────────────────┘   ← bottom:  1(└) + (inner_width+2)(─) + 1(┘) = inner_width + 4
# Total visual width per panel = width (= inner_width + 4)
render_panel() {
  local name=$1 color=$2 type=$3 width=$4 height=$5 is_focused=$6

  # Panel dimensions
  # inner_width = content area width; total panel width = inner_width + 4 (borders + padding)
  local inner_width=$(( width - 4 ))
  local inner_height=$(( height - 2 ))
  (( inner_width < 10 )) && inner_width=10
  (( inner_height < 3 )) && inner_height=3

  # Get content
  local content
  content=$(get_panel_content "$type" "$inner_height")

  # Top border: ┌─ TITLE ────┐
  # Visual chars: ┌(1) + ─(1) + space(1) + title(N) + space(1) + fill_dashes(F) + ┐(1) = inner_width + 4
  # So fill_dashes = inner_width + 4 - 1 - 1 - 1 - N - 1 - 1 = inner_width - N - 1
  # But we need the right padding to also fill: total = inner_width + 2 (for the ─ chars inside top border)
  # Simpler: the dashes in "┌─ TITLE ────┐" total = inner_width + 2
  # Known: "─ " (2) + "TITLE" (N) + " " (1) = N + 3 chars allocated
  # Remaining dashes = inner_width + 2 - (N + 3) = inner_width - N - 1
  local name_len=${#name}
  local top_fill=$(( inner_width - name_len - 1 ))
  (( top_fill < 1 )) && top_fill=1
  if (( is_focused )); then
    echo -ne "${color}${BOLD}┌─ ${name} $(printf '─%.0s' $(seq 1 $top_fill))┐${RESET}"
  else
    echo -ne "${DIM}┌─ ${name} $(printf '─%.0s' $(seq 1 $top_fill))┐${RESET}"
  fi

  # Content lines — use _pad_vis for ANSI-aware alignment
  local line_count=0
  while IFS= read -r line; do
    (( line_count++ ))
    (( line_count > inner_height )) && break
    local padded
    padded=$(_pad_vis "$line" "$inner_width")
    if (( is_focused )); then
      echo -ne "\n${color}│${RESET} ${padded} ${color}│${RESET}"
    else
      echo -ne "\n${DIM}│${RESET} ${padded} ${DIM}│${RESET}"
    fi
  done <<< "$content"

  # Fill remaining lines with blank padded content
  local blank_padding
  blank_padding=$(printf '%*s' "$inner_width" '')
  while (( line_count < inner_height )); do
    line_count=$(( line_count + 1 ))
    if (( is_focused )); then
      echo -ne "\n${color}│${RESET} ${blank_padding} ${color}│${RESET}"
    else
      echo -ne "\n${DIM}│${RESET} ${blank_padding} ${DIM}│${RESET}"
    fi
  done

  # Bottom border: └──────┘  (dashes = inner_width + 2)
  local bot_fill=$(( inner_width + 2 ))
  if (( is_focused )); then
    echo -ne "\n${color}└$(printf '─%.0s' $(seq 1 $bot_fill))┘${RESET}"
  else
    echo -ne "\n${DIM}└$(printf '─%.0s' $(seq 1 $bot_fill))┘${RESET}"
  fi
}

# Calculate panel dimensions for a grid layout
# Layout: 2 rows x 3 cols (last row has 2 panels)
calculate_layout() {
  local total_width=$1 total_height=$2

  # We have 5 panels, layout as:
  # Row 1: [REASONING] [THINKING] [TOOLS]
  # Row 2: [VULNS] [OUTPUT]       (OUTPUT spans 2 columns)

  local border_overhead=2  # top + bottom borders
  local gap=1               # between panels

  # Row heights
  local row1_height=$(( total_height * 45 / 100 ))
  local row2_height=$(( total_height - row1_height - border_overhead - 1 ))

  # Column widths for row 1 (3 panels, 2 gaps between them)
  local col_width=$(( (total_width - gap * 2) / 3 ))

  # Row 2: VULNS takes 1/3, OUTPUT takes 2/3 (1 gap between them)
  local vuln_width=$(( (total_width - gap) / 3 ))
  local output_width=$(( total_width - vuln_width - gap ))

  echo "$row1_height $row2_height $col_width $vuln_width $output_width"
}

# ─── Main Render ─────────────────────────────────────────────────────────────

render_grids() {
  local total_width=$COLS
  local total_height=$(( LINES - 10 ))  # Reserve for banner + status

  # Get layout
  read -r row1_h row2_h col_w vuln_w out_w <<< "$(calculate_layout $total_width $total_height)"

  # Determine which panel is focused (cycles)
  local focused=$(( TICK % 5 ))

  # Clear screen and move cursor to top
  echo -ne "\033[H\033[J"

  # Print banner
  print_banner

  # ─── Row 1: REASONING | THINKING | TOOLS ─────────
  local row1_y=8  # Y position after banner

  # REASONING (focused=0)
  render_panel "REASONING" "$CYAN" "reasoning" "$col_w" "$row1_h" $(( focused == 0 ))
  echo -ne " "

  # THINKING (focused=1)
  render_panel "THINKING" "$MAGENTA" "thinking" "$col_w" "$row1_h" $(( focused == 1 ))
  echo -ne " "

  # TOOLS (focused=2)
  render_panel "TOOLS" "$YELLOW" "tools" "$col_w" "$row1_h" $(( focused == 2 ))
  echo ""

  # ─── Row 2: VULNS | OUTPUT ──────────────────────────
  # VULNS (focused=3)
  render_panel "VULNS" "$RED" "vulns" "$vuln_w" "$row2_h" $(( focused == 3 ))
  echo -ne " "

  # OUTPUT (focused=4)
  render_panel "OUTPUT" "$GREEN" "output" "$out_w" "$row2_h" $(( focused == 4 ))
  echo ""

  # ─── Status Bar ─────────────────────────────────────────
  echo ""
  echo -e "${DIM}${BOLD}━━━ STATUS ━━━${RESET}"
  echo -e " ${DIM}Tick:${RESET} $TICK  ${DIM}Focused:${RESET} ${GRID_PANELS[$focused]%%|*}  ${DIM}Lines:${RESET} ${#LOG_BUFFER[@]}  ${DIM}Scroll:${RESET} $SCROLL_POS"
  echo -e " ${DIM}[q/Esc] Quit  [↑↓] Scroll output  [Tab] Focus next panel  [Space] Pause${RESET}"
}

# ─── Main Loop ───────────────────────────────────────────────────────────────

main() {
  # Setup terminal
  tput civis          # Hide cursor
  tput smcup 2>/dev/null || true  # Save screen
  echo -ne "\033[?25l"  # Hide cursor (alternative)

  # Cleanup on exit
  cleanup() {
    tput cnorm        # Show cursor
    tput rmcup 2>/dev/null || true  # Restore screen
    echo -ne "\033[?25h"  # Show cursor
    echo -e "\n${GREEN}Exited.${RESET}"
    exit 0
  }
  trap cleanup EXIT INT TERM

  define_panels

  # Key input (non-blocking)
  local input=""
  local paused=0

  while true; do
    # Read key (non-blocking)
    if read -t 0.1 -rsn1 input 2>/dev/null; then
      case "$input" in
        q|Q) cleanup ;;
        ' ') paused=$(( 1 - paused )) ;;
        $'\x09') PANEL_INDEX=$(( (PANEL_INDEX + 1) % 5 )) ;;  # Tab
        $'\x1b')  # ESC — could be standalone (quit) or start of arrow key sequence
          # Wait a tiny bit for more characters (arrow keys send ESC [A/B)
          if read -rsn2 -t 0.05 _ 2>/dev/null; then
            # More chars followed — it's an arrow key or other escape sequence
            case "$_" in
              '[A') SCROLL_POS=$(( SCROLL_POS + 1 )) ;;  # Up
              '[B') SCROLL_POS=$(( SCROLL_POS - 1 ))     # Down
                    (( SCROLL_POS < 0 )) && SCROLL_POS=0 ;;
            esac
          else
            # No more chars — standalone ESC key, quit
            cleanup
          fi
          ;;
      esac
    fi

    # Generate new output every tick (unless paused)
    if (( ! paused )); then
      # Add new log lines
      local new_lines=$(( RANDOM % 3 + 1 ))
      for (( i = 0; i < new_lines; i++ )); do
        LOG_BUFFER+=("$(generate_output)")
      done

      # Trim buffer
      if (( ${#LOG_BUFFER[@]} > MAX_LOG_LINES )); then
        LOG_BUFFER=("${LOG_BUFFER[@]: -MAX_LOG_LINES}")
      fi

      # Auto-scroll output panel to latest
      SCROLL_POS=0

      TICK=$(( TICK + 1 ))
    fi

    # Render
    render_grids

    # Sleep for refresh rate (convert ms to seconds)
    local sleep_sec
    sleep_sec=$(awk "BEGIN { printf \"%.3f\", ${REFRESH_MS}/1000 }")
    sleep "${sleep_sec}"
  done
}

# ─── Entry Point ─────────────────────────────────────────────────────────────

# Check terminal
if [[ ! -t 1 ]]; then
  echo "This script requires a terminal (TTY)"
  exit 1
fi

main