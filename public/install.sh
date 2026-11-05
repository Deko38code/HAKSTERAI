#!/usr/bin/env bash
set -euo pipefail

REPOSITORY="https://github.com/Deko38code/haksterAi.git"
INSTALL_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/haksterai-cli"

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  printf 'Hakster CLI requires Node.js 22.12+ and npm. Install Node.js first: https://nodejs.org/\n' >&2
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  printf 'Hakster CLI installation requires Git. Install Git, then run this command again.\n' >&2
  exit 1
fi

node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 12)) { console.error(`Node.js 22.12+ is required (found ${process.versions.node}).`); process.exit(1); }'

if [[ -e "$INSTALL_DIR" ]]; then
  printf 'Install directory already exists: %s\nFinish or inspect that install, then run `npm link` inside it. No files were changed.\n' "$INSTALL_DIR" >&2
  exit 1
fi

printf 'Cloning HaksterAI into %s…\n' "$INSTALL_DIR"
git clone --depth 1 "$REPOSITORY" "$INSTALL_DIR"
cd "$INSTALL_DIR"
cd "$INSTALL_DIR/cli"
npm install
npm link

printf '\nHakster CLI linked. Run `hakster --help` to view commands.\n'
