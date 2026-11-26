#!/usr/bin/env bash
# hakster-launch.sh — the `hakster` entry point on this box (Dell, 10.0.0.131).
#
# Owner, 2026-11-26: "make dell cli update with this box always".
#
# One rule: run the NEWEST build available for this box, never an older one.
#
#   dev  /home/ghost/haksterAi/cli                 the dev tree — where every
#                                                 release is made. Runs when it
#                                                 is equal to or ahead of pkg.
#   pkg  ~/.hakster/pkg/node_modules/hakster-cli  a real package copy with no
#                                                 .git, so its own updater can
#                                                 apply a verified stage (§43).
#                                                 A checkout can never do that
#                                                 (§8, §43.4) — this is the
#                                                 copy that keeps the box
#                                                 current.
#
# A tie goes to the checkout, so a normal dev day is exactly as it was. When the
# published build on this box is newer than both, the checkout runs this once
# and the package copy is refreshed from that published build in the background;
# the next launch runs it. An older package copy is never run (§44.4, §50.1).
#
# Nothing here moves a model, route, provider, rate, plan or allowance
# (§19.3, §22.4, §26), and nothing is written into another project (§16).

set -uo pipefail

DEV_DIR="${HAKSTER_DEV_DIR:-/home/ghost/haksterAi/cli}"
PKG_DIR="${HAKSTER_PKG_DIR:-$HOME/.hakster/pkg/node_modules/hakster-cli}"
ORIGIN="${HAKSTER_ORIGIN:-http://127.0.0.1:3580}"
STAMP="$HOME/.hakster/updates/launcher-refresh.json"
LOG="$HOME/.hakster/updates/launcher-refresh.log"

entry() { [ -n "${1:-}" ] && [ -f "$1/index.js" ] && printf '%s' "$1/index.js"; }

# Version of a CLI tree, read from its package.json — no node spawn.
ver_of() { [ -f "$1/package.json" ] && grep -m1 '"version"' "$1/package.json" 2>/dev/null \
  | sed 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/'; }

# vcmp A B -> -1 when A < B, 0 when equal, 1 when A > B.
vcmp() {
  local a b i x y n
  a=${1%%[+-]*}; b=${2%%[+-]*}
  local -a A B
  IFS='.' read -r -a A <<<"$a"; IFS='.' read -r -a B <<<"$b"
  n=${#A[@]}; [ "${#B[@]}" -gt "$n" ] && n=${#B[@]}
  for ((i = 0; i < n; i++)); do
    x=${A[i]:-0}; y=${B[i]:-0}
    x=${x//[^0-9]/}; y=${y//[^0-9]/}
    x=$((10#${x:-0})); y=$((10#${y:-0}))
    if ((x < y)); then printf '%s' -1; return; fi
    if ((x > y)); then printf '%s' 1; return; fi
  done
  printf '0'
}

DEV_ENTRY=$(entry "$DEV_DIR")
PKG_ENTRY=$(entry "$PKG_DIR")

if [ -z "$DEV_ENTRY" ] && [ -z "$PKG_ENTRY" ]; then
  printf 'hakster: no CLI found (looked in %s and %s).\n' "$DEV_DIR" "$PKG_DIR" >&2
  exit 1
fi
command -v node >/dev/null 2>&1 || { printf 'hakster: node is not on PATH — install Node.js 22.12+ first.\n' >&2; exit 1; }

# Which copy is newest? A tie goes to the checkout.
CHOICE=dev
[ -n "$DEV_ENTRY" ] || CHOICE=pkg
if [ -n "$DEV_ENTRY" ] && [ -n "$PKG_ENTRY" ]; then
  dev_v=$(ver_of "$DEV_DIR"); pkg_v=$(ver_of "$PKG_DIR")
  if [ -n "$dev_v" ] && [ -n "$pkg_v" ] && [ "$(vcmp "$pkg_v" "$dev_v")" = "1" ]; then CHOICE=pkg; fi
fi

# The package copy only ever becomes the answer by being newer. Refresh it from
# this box's published build when that build is ahead of it, so it can take over
# the moment the checkout falls behind. Bounded, silent, at most every 30 min.
refresh_pkg() {
  [ "$CHOICE" = "dev" ] || return 0
  [ -n "$PKG_ENTRY" ] || return 0

  if [ -f "$STAMP" ]; then
    last=$(sed 's/.*"at"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/' "$STAMP" 2>/dev/null)
    case "${last:-}" in
      ''|*[!0-9]*) : ;;
      *) [ $(( $(date +%s) - last )) -lt 1800 ] && return 0 ;;
    esac
  fi
  command -v curl >/dev/null 2>&1 || return 0

  latest=$(curl -fsS --connect-timeout 0.3 --max-time 0.5 "$ORIGIN/cli/latest.json" 2>/dev/null) || return 0
  pub=$(printf '%s' "$latest" | sed 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
  case "${pub:-}" in ''|*[!0-9.]*) return 0 ;; esac
  pkg_v=$(ver_of "$PKG_DIR"); [ -n "$pkg_v" ] || return 0
  [ "$(vcmp "$pub" "$pkg_v")" = "1" ] || return 0   # pkg already this build or newer

  mkdir -p "$(dirname "$STAMP")" 2>/dev/null
  # Refresh with the product's own updater — the same path a user machine uses.
  ( HAKSTER_SERVER="$ORIGIN" node -e '
const up = require(process.argv[1] + "/src/updater.js");
up.checkForUpdate({ timeoutMs: 12000 })
  .then(r => { if (r && r.status === "staged") up.applyPending(process.argv[1]); })
  .catch(() => {});
' "$PKG_DIR" >>"$LOG" 2>&1 & ) >/dev/null 2>&1

  printf '{"at":%s,"published":"%s"}\n' "$(date +%s)" "$pub" >"$STAMP" 2>/dev/null
}

if [ "$CHOICE" = "pkg" ]; then
  exec node "$PKG_ENTRY" "$@"
fi
refresh_pkg
exec node "$DEV_ENTRY" "$@"
