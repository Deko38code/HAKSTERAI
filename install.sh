#!/bin/sh
# HaksterAI CLI installer — one command, and it brings what it needs.
#
# Owner, 2026-11-25: "so can we add node to it so evething whats needed to run
# come plug and play" / "like make the install xheck if users have whats needed
# if not install". So this checks first and installs only what is missing:
#
#   node + npm  — reused when already present and version 20+, otherwise the
#                 official Node.js build for this platform is downloaded into
#                 ~/.hakster/runtime and checksum-verified before it is unpacked.
#   bun         — what our TUI runs on; installed into ~/.hakster/runtime/bun
#                 when the machine has none. Without it the CLI still runs on
#                 its Ink fallback, so this step is reported, never fatal.
#   the CLI     — installed with npm as before (global, then ~/.local if the
#                 global prefix needs permissions we do not have).
#
# Claude Code is NOT downloaded here: `hakster claude` sets it up on first use,
# on paid plans only, so free plans never pay for 400 MB they cannot use.
#
# Nothing existing is removed or overwritten. A Node or Bun the machine already
# has stays exactly where it is and is the one used.
set -eu
ORIGIN="__ORIGIN__"
NODE_VERSION="${HAKSTER_NODE_VERSION:-v24.22.3}"
BUN_VERSION="${HAKSTER_BUN_VERSION:-1.4.5}"
RUNTIME="$HOME/.hakster/runtime"
TMP="${TMPDIR:-/tmp}/hakster-cli-install.$$"
mkdir -p "$TMP"
say() { printf '%s\n' "$*"; }
fail() { say "✗ $*"; say "  Nothing was installed."; exit 1; }

fetch() { # fetch <url> <out>
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --max-time 600 "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1"
  else
    return 1
  fi
}

sha256_of() { # sha256_of <file>
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 "$1" | awk '{print $NF}'
  else return 1
  fi
}

node_major() {
  v=$(node -p 'process.versions.node' 2>/dev/null || echo "")
  case "$v" in
    "") echo 0 ;;
    *) echo "${v%%.*}" ;;
  esac
}

platform_tag() { # -> "<tag> <ext>"  (xz|gz)
  os=$(uname -s 2>/dev/null || echo unknown)
  arch=$(uname -m 2>/dev/null || echo unknown)
  case "$os:$arch" in
    Linux:x86_64|Linux:amd64) echo "linux-x64 xz" ;;
    Linux:aarch64|Linux:arm64) echo "linux-arm64 xz" ;;
    Darwin:arm64) echo "darwin-arm64 gz" ;;
    Darwin:x86_64) echo "darwin-x64 gz" ;;
    MINGW*|MSYS*|CYGWIN*) return 1 ;;
    *) return 1 ;;
  esac
}

say "HaksterAI CLI — from $ORIGIN"

BOOTSTRAPPED=no
if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 \
   && [ "$(node_major)" -ge 20 ] 2>/dev/null; then
  NODE_BIN_DIR=$(dirname "$(command -v node)")
  say "✓ Node $(node -v) and npm $(npm -v) are already here — using them"
else
  if command -v node >/dev/null 2>&1; then
    say "… Node $(node -v) is older than 20, so the CLI cannot use it"
  else
    say "… no Node.js found"
  fi
  tag_and_ext=$(platform_tag) || {
    say "✗ This installer does not know how to bring Node to $(uname -s) $(uname -m)."
    say "  Install Node.js 20+ from https://nodejs.org, then run this again."
    exit 1
  }
  TAG=$(printf '%s' "$tag_and_ext" | cut -d' ' -f1)
  EXT=$(printf '%s' "$tag_and_ext" | cut -d' ' -f2)
  NAME="node-$NODE_VERSION-$TAG"
  URL="https://nodejs.org/dist/$NODE_VERSION/$NAME.tar.$EXT"
  say "… installing Node $NODE_VERSION into $RUNTIME (one time, ~$( [ "$EXT" = "xz" ] && echo 31 || echo 51 ) MB)"
  mkdir -p "$RUNTIME"
  fetch "$URL" "$TMP/$NAME.tar.$EXT" || fail "could not download $URL"
  fetch "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" "$TMP/SHASUMS256.txt" \
    || fail "could not download the published checksums"
  WANT=$(awk -v f="$NAME.tar.$EXT" '$2 == f { print $1 }' "$TMP/SHASUMS256.txt")
  [ -n "$WANT" ] || fail "no published checksum for $NAME.tar.$EXT"
  GOT=$(sha256_of "$TMP/$NAME.tar.$EXT") || fail "no sha256 tool available to verify the download"
  [ "$WANT" = "$GOT" ] || fail "the Node download does not match its published checksum — not using it"
  say "✓ checksum verified"
  tar -xf "$TMP/$NAME.tar.$EXT" -C "$RUNTIME" || fail "could not unpack Node"
  NODE_BIN_DIR="$RUNTIME/$NAME/bin"
  [ -x "$NODE_BIN_DIR/node" ] || fail "Node unpacked but $NODE_BIN_DIR/node is missing"
  PATH="$NODE_BIN_DIR:$PATH"
  export PATH
  BOOTSTRAPPED=yes
  say "✓ Node $(node -v) installed in $RUNTIME/$NAME"
fi

# ── the CLI itself ────────────────────────────────────────────────────────
say "… downloading the CLI from $ORIGIN"
fetch "$ORIGIN/cli/pkg.tar.gz" "$TMP/cli.tar.gz" || fail "could not download the CLI package"
tar -xzf "$TMP/cli.tar.gz" -C "$TMP" || fail "could not unpack the CLI package"
cd "$TMP/cli"
say "… installing the CLI (this takes a minute)"
# Installing this folder with `npm install -g .` would create a link back into
# this temp directory, and the cleanup at the end would then delete what the
# link points at. Pack it first and install the tarball — a real copy.
PKG=$(npm pack --silent --pack-destination "$TMP" . 2>/dev/null | tail -n 1)
case "$PKG" in
  *.tgz) ;;
  *) fail "could not pack the CLI for install" ;;
esac
[ -f "$TMP/$PKG" ] || fail "could not pack the CLI for install"

HAKSTER_BIN=""
if npm install -g "$TMP/$PKG" >/dev/null 2>&1; then
  # npm's global bin is not always on PATH yet (a fresh prefix, a new shell),
  # so the launcher is located from npm's own prefix, not from `command -v`.
  GP=$(npm prefix -g 2>/dev/null | tr -d '\n' || true)
  for c in "$GP/bin/hakster" "$GP/bin/hakster.cmd" "$GP/hakster.cmd" \
           "$(command -v hakster 2>/dev/null || true)"; do
    if [ -n "$c" ] && [ -e "$c" ]; then HAKSTER_BIN="$c"; break; fi
  done
  [ -n "$HAKSTER_BIN" ] || fail "the CLI installed but no hakster launcher was found under $GP"
  case ":$PATH:" in
    *":$GP/bin:"*) : ;;
    *) say "  Add this to your shell profile:  export PATH=\"$GP/bin:\$PATH\"" ;;
  esac
else
  say "… the global install needs permissions we do not have — installing into ~/.local"
  npm install -g "$TMP/$PKG" --prefix "$HOME/.local" >/dev/null 2>&1 \
    || fail "npm could not install the CLI into ~/.local"
  HAKSTER_BIN="$HOME/.local/bin/hakster"
  [ -e "$HAKSTER_BIN" ] || fail "the CLI installed but $HAKSTER_BIN is missing"
  say "  Add this to your shell profile:  export PATH=\"\$HOME/.local/bin:\$PATH\""
fi

# Bun runs our TUI. Installed next to the CLI when the machine has none, so a
# clean machine gets the same screen as the owner's.
if command -v bun >/dev/null 2>&1; then
  say "✓ Bun $(bun --version 2>/dev/null || echo '') is already here — using it"
elif [ -x "$RUNTIME/bun/node_modules/.bin/bun" ]; then
  say "✓ Bun already installed in $RUNTIME/bun — using it"
else
  say "… installing Bun for the full TUI (~90 MB, one time)"
  if npm install --prefix "$RUNTIME/bun" --omit=dev --no-audit --no-fund "bun@$BUN_VERSION" >/dev/null 2>&1; then
    say "✓ Bun installed in $RUNTIME/bun"
  else
    say "⚠ Bun could not be installed — the CLI still runs with its built-in Ink UI"
  fi
fi

# When we brought Node, the user's shell has no node on PATH, so a launcher
# that pins our runtime is written into ~/.local/bin (§23: nothing secret in it).
if [ "$BOOTSTRAPPED" = yes ]; then
  mkdir -p "$HOME/.local/bin"
  for name in hakster haksterai; do
    cat > "$HOME/.local/bin/$name" <<LAUNCHER
#!/bin/sh
# Installed by the HaksterAI installer: runs the CLI on the Node it brought.
export PATH="$NODE_BIN_DIR:$RUNTIME/bun/node_modules/.bin:\$PATH"
exec "$HAKSTER_BIN" "\$@"
LAUNCHER
    chmod 755 "$HOME/.local/bin/$name"
  done
  HAKSTER_BIN="$HOME/.local/bin/hakster"
  say "✓ launcher written to ~/.local/bin/hakster"
  say "  Add this to your shell profile:  export PATH=\"\$HOME/.local/bin:\$PATH\""
fi

# Point the freshly installed CLI at the server it came from, so the only step
# left for the operator is signing in (magic link, verified in browser).
PATH="$NODE_BIN_DIR:$PATH"
export PATH
"$HAKSTER_BIN" config set server "$ORIGIN" >/dev/null 2>&1 || true

VERSION=$("$HAKSTER_BIN" --version 2>/dev/null | tr -d '\n' || echo "")
say ""
if [ -n "$VERSION" ]; then
  say "Installed: HaksterAI CLI $VERSION"
else
  say "Installed: HaksterAI CLI (version did not answer — check 'hakster --version')"
fi
say ""
say "Next:"
say "  1) sign in — a magic link opens in your browser, press Allow:"
say "       hakster login"
say "  2) start your agent, or run Claude Code on this plan:"
say "       hakster            # our own terminal agent"
say "       hakster claude     # Claude Code on this plan (sets it up once if you have none)"
say "       hakster quake      # the same CLI in a Guake drop-down"
say ""
say "  Check any time:  hakster whoami"
say "  No browser handy?  export HAKSTER_API_KEY=<key from $ORIGIN/dashboard/>"

cd /
rm -rf "$TMP"
