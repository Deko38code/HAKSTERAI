#!/usr/bin/env bash
# haksterAi installer — curl | bash
#   curl -fsSL https://haksterai.com/install.sh | bash
# Clones the repo, installs deps, builds the site, starts the server under pm2,
# and puts the `haksterai` CLI on your PATH. Safe to re-run (idempotent-ish).
set -euo pipefail

REPO="https://github.com/Deko38code/haksterAi.git"
DEST="${HAKSTER_INSTALL_DIR:-$HOME/haksterAi}"
BRANCH="${HAKSTER_BRANCH:-main}"

say(){ printf '\033[1;36m[hakster]\033[0m %s\n' "$*"; }
err(){ printf '\033[1;31m[hakster:err]\033[0m %s\n' "$*" >&2; }
need(){ command -v "$1" >/dev/null 2>&1 || { err "missing dependency: $1 — install it first"; exit 1; }; }

say "checking dependencies..."
need node; need npm; need git
if ! command -v pm2 >/dev/null 2>&1; then say "pm2 not found — installing globally..."; npm install -g pm2; fi

say "cloning haksterAi into $DEST ..."
if [ -d "$DEST/.git" ]; then
  say "existing repo at $DEST — pulling latest ($BRANCH)..."
  git -C "$DEST" fetch --quiet origin "$BRANCH"
  git -C "$DEST" checkout -q "$BRANCH"
  git -C "$DEST" reset --hard "origin/$BRANCH"
else
  git clone --depth 1 -b "$BRANCH" "$REPO" "$DEST"
fi
cd "$DEST"

say "installing dependencies (npm install)..."
npm install --no-audit --no-fund

say "building the site (npm run build)..."
npm run build

say "starting the server under pm2..."
pm2 delete haksterAi 2>/dev/null || true
pm2 start "npm run server" --name haksterAi --update-env
pm2 save 2>/dev/null || true

say "installing the haksterai CLI on your PATH..."
npm install -g . 2>/dev/null || say "(global install skipped — run 'node cli/index.js chat' from $DEST)"

cat <<EOF

\033[1;32m✓ haksterAi installed.\033[0m

Next steps:
  haksterai init        # one-time config
  haksterai chat        # start the agent (HP-1000 TUI)
  haksterai --help      # all commands

Web:      http://localhost:3579
Cockpit:  http://localhost:3579/cockpit
Repo:     https://github.com/Deko38code/haksterAi

EOF
