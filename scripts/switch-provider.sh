#!/usr/bin/env bash
# Switch haksterAi's default provider/model.
# Writes both config files the CLI/TUI and server actually read:
#   server/hakster-config.json  (server-side default + Telegram bots)
#   ~/.hakster/config.json      (the `hakster` CLI's own client-side default)
#
# Usage:
#   scripts/switch-provider.sh claude    # local `claude` CLI (Pro/Max sub, no extra billing)
#   scripts/switch-provider.sh ollama    # back to local Ollama (hp-1000)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_CFG="$ROOT/server/hakster-config.json"
CLI_CFG="$HOME/.hakster/config.json"

case "${1:-}" in
  claude|claude-cli)
    PROVIDER="claude-cli"; MODEL="sonnet"
    ;;
  ollama)
    PROVIDER="ollama"; MODEL="hp-1000:latest"
    ;;
  *)
    echo "usage: $0 claude|ollama" >&2
    exit 1
    ;;
esac

printf '{\n  "provider": "%s",\n  "model": "%s"\n}\n' "$PROVIDER" "$MODEL" > "$SERVER_CFG"

if [ -f "$CLI_CFG" ]; then
  # Preserve server/apiKey fields already in the CLI config, just swap provider/model.
  node -e "
    const fs = require('fs');
    const p = '$CLI_CFG';
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
    cfg.provider = '$PROVIDER';
    cfg.model = '$MODEL';
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
  "
else
  mkdir -p "$(dirname "$CLI_CFG")"
  printf '{\n  "server": "http://127.0.0.1:3579",\n  "apiKey": "",\n  "provider": "%s",\n  "model": "%s"\n}\n' "$PROVIDER" "$MODEL" > "$CLI_CFG"
fi

echo "-> provider set to $PROVIDER ($MODEL)"
echo "   server: $SERVER_CFG"
echo "   cli:    $CLI_CFG"
echo
echo "Restart the server for the server-side change to take effect:"
echo "   kill \$(pgrep -f 'node src/index.js' | head -1)   # PM2 (if present) or you relaunch it"
