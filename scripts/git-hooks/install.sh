#!/usr/bin/env bash
# Installs the secret-scanning pre-commit hook on this machine.
# Run once per clone: bash scripts/git-hooks/install.sh
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$DIR" rev-parse --show-toplevel)"
cp "$DIR/pre-commit" "$REPO_ROOT/.git/hooks/pre-commit"
chmod +x "$REPO_ROOT/.git/hooks/pre-commit"
echo "Installed pre-commit secret guard into $REPO_ROOT/.git/hooks/pre-commit"
