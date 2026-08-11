#!/usr/bin/env bash
# kaggle-remote.sh — Manage remote hp-1000 on Kaggle GPU
#
# Usage:
#   ./scripts/kaggle-remote.sh push    — Upload notebook to Kaggle
#   ./scripts/kaggle-remote.sh run     — Push + start the notebook on GPU
#   ./scripts/kaggle-remote.sh url     — Get the tunnel URL from running notebook
#   ./scripts/kaggle-remote.sh connect — Get URL + set OLLAMA_HOST in .env
#   ./scripts/kaggle-remote.sh status   — Check if notebook is running
#   ./scripts/kaggle-remote.sh stop     — Stop the notebook
#
# Prerequisites:
#   - Kaggle CLI installed (pip install kaggle)
#   - ~/.kaggle/kaggle.json with API credentials
#   - Notebook slug defined below

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$PROJECT_DIR/server/.env"

# Config — change these if needed
NOTEBOOK_SLUG="hakster-hp1000-gpu"
KERNEL_SLUG="hakster-hp1000-gpu"
USERNAME="" # Auto-detected from kaggle.json

# ── Helpers ────────────────────────────────────────────────────────────

check_kaggle() {
  if ! command -v kaggle &>/dev/null; then
    echo "ERROR: kaggle CLI not installed. Run: pip install kaggle"
    exit 1
  fi
  if [ ! -f ~/.kaggle/kaggle.json ]; then
    echo "ERROR: ~/.kaggle/kaggle.json not found."
    echo "Go to kaggle.com → Settings → Create New Token → save to ~/.kaggle/kaggle.json"
    echo "Then: chmod 600 ~/.kaggle/kaggle.json"
    exit 1
  fi
  chmod 600 ~/.kaggle/kaggle.json 2>/dev/null || true
}

get_username() {
  if [ -z "$USERNAME" ]; then
    USERNAME=$(python3 -c "import json; print(json.load(open('$HOME/.kaggle/kaggle.json'))['username'])" 2>/dev/null || echo "")
    if [ -z "$USERNAME" ]; then
      echo "ERROR: Could not read username from kaggle.json"
      exit 1
    fi
  fi
  echo "$USERNAME"
}

# ── Commands ────────────────────────────────────────────────────────────

cmd_push() {
  check_kaggle
  local username=$(get_username)
  echo "=== Pushing notebook to Kaggle as $username/$NOTEBOOK_SLUG ==="

  # Create kernel metadata if it doesn't exist
  local meta_file="$SCRIPT_DIR/kernel-metadata.json"
  if [ ! -f "$meta_file" ]; then
    cat > "$meta_file" << EOF
{
  "id": "$username/$NOTEBOOK_SLUG",
  "title": "hakster Remote Ollama",
  "code_file": "kaggle-remote-ollama.ipynb",
  "language": "python",
  "kernel_type": "notebook",
  "is_private": true,
  "enable_gpu": true,
  "enable_internet": true,
  "dataset_sources": [],
  "competition_sources": [],
  "kernel_sources": []
}
EOF
    echo "Created kernel metadata: $meta_file"
  fi

  # Update username in metadata if needed
  sed -i "s|\"id\": \"/.*\"|\"id\": \"$username/$NOTEBOOK_SLUG\"|" "$meta_file"

  # Push
  kaggle kernels push -p "$SCRIPT_DIR"
  echo "Notebook pushed to kaggle.com/$username/$NOTEBOOK_SLUG"
}

cmd_run() {
  cmd_push
  echo ""
  echo "=== Notebook pushed. Kaggle will start it automatically. ==="
  echo "=== Wait ~2-3 min for GPU allocation, then run: ==="
  echo "===   ./scripts/kaggle-remote.sh url    ==="
  echo "=== to get the tunnel URL.               ==="
}

cmd_url() {
  check_kaggle
  local username=$(get_username)
  echo "=== Checking notebook output for tunnel URL ==="

  # Get notebook output
  local output=$(kaggle kernels output "$username/$NOTEBOOK_SLUG" -p /tmp/kaggle-output 2>&1 || true)

  # Check status
  local status=$(kaggle kernels status "$username/$NOTEBOOK_SLUG" 2>&1 || echo "unknown")
  echo "Status: $status"

  # Look for tunnel URL in output
  local url=$(grep -oP 'https://[a-z0-9-]+\.trycloudflare\.com' /tmp/kaggle-output/*.log 2>/dev/null | head -1 || true)
  if [ -z "$url" ]; then
    # Try reading the notebook output directly
    url=$(echo "$output" | grep -oP 'https://[a-z0-9-]+\.trycloudflare\.com' | head -1 || true)
  fi

  if [ -n "$url" ]; then
    echo ""
    echo "===================================="
    echo "  TUNNEL URL: $url"
    echo "===================================="
    echo ""
    echo "To connect haksterAi:"
    echo "  export OLLAMA_HOST=$url"
    echo "  pm2 restart haksterAi --update-env"
    echo ""
    echo "Or run: ./scripts/kaggle-remote.sh connect"
  else
    echo "Tunnel URL not found yet."
    echo "The notebook might still be starting. Wait 1-2 min and retry."
    echo ""
    echo "Check notebook logs at:"
    echo "  https://www.kaggle.com/code/$username/$NOTEBOOK_SLUG"
  fi
}

cmd_connect() {
  check_kaggle
  local username=$(get_username)

  # Get URL
  local url=$(grep -oP 'https://[a-z0-9-]+\.trycloudflare\.com' /tmp/kaggle-output/*.log 2>/dev/null | head -1 || true)
  if [ -z "$url" ]; then
    kaggle kernels output "$username/$NOTEBOOK_SLUG" -p /tmp/kaggle-output 2>/dev/null || true
    url=$(grep -oP 'https://[a-z0-9-]+\.trycloudflare\.com' /tmp/kaggle-output/*.log 2>/dev/null | head -1 || true)
  fi

  if [ -z "$url" ]; then
    echo "Tunnel URL not found. Run './scripts/kaggle-remote.sh run' first."
    exit 1
  fi

  echo "=== Connecting haksterAi to remote Ollama: $url ==="

  # Update .env
  if [ -f "$ENV_FILE" ]; then
    # Remove old OLLAMA_HOST line
    sed -i '/^OLLAMA_HOST=/d' "$ENV_FILE"
    # Add new one
    echo "OLLAMA_HOST=$url" >> "$ENV_FILE"
    echo "Updated $ENV_FILE with OLLAMA_HOST=$url"
  else
    echo "OLLAMA_HOST=$url" > "$ENV_FILE"
    echo "Created $ENV_FILE with OLLAMA_HOST=$url"
  fi

  echo ""
  echo "To apply, restart haksterAi:"
  echo "  pm2 restart haksterAi --update-env"
  echo ""
  echo "Then in TUI, set model to hp-1000:"
  echo "  /model hp-1000"
}

cmd_status() {
  check_kaggle
  local username=$(get_username)
  echo "=== Notebook status ==="
  kaggle kernels status "$username/$NOTEBOOK_SLUG" 2>&1 || echo "Not found"
}

cmd_stop() {
  check_kaggle
  local username=$(get_username)
  echo "=== Stopping notebook ==="
  # Kaggle doesn't have a direct stop command, but we can comment
  echo "To stop the notebook, go to:"
  echo "  https://www.kaggle.com/code/$username/$NOTEBOOK_SLUG"
  echo "  Click 'Stop' in the top right"
  echo ""
  echo "Or: kaggle kernels output $username/$NOTEBOOK_SLUG -p /tmp/kaggle-stop 2>/dev/null"
  echo "(Kaggle auto-stops after 12 hours or idle timeout)"
}

# ── Main ────────────────────────────────────────────────────────────────

case "${1:-help}" in
  push)    cmd_push ;;
  run)     cmd_run ;;
  url)     cmd_url ;;
  connect) cmd_connect ;;
  status)  cmd_status ;;
  stop)    cmd_stop ;;
  *)
    echo "Usage: $0 {push|run|url|connect|status|stop}"
    echo ""
    echo "  push    — Upload notebook to Kaggle"
    echo "  run     — Push + start on GPU"
    echo "  url     — Get tunnel URL from running notebook"
    echo "  connect — Get URL + update server/.env with OLLAMA_HOST"
    echo "  status  — Check notebook status"
    echo "  stop    — Show how to stop the notebook"
    ;;
esac