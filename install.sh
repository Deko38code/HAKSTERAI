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
# Before any of that, one read-only pass prints what this machine already has —
# node, bun, Guake, Claude Code and an older CLI (owner, 2026-11-26: "on install
# our cli checks for missing guake node claude code etc for fast instal"). It
# downloads, starts and changes nothing; it only says what will be brought and
# what is already in use, so the install spends its time on the gaps.
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

# ── what this machine already has ────────────────────────────────────────
# Owner, 2026-11-26: "on install our cli checks for missing guake node claude
# code etc for fast instal". One read-only pass before anything is fetched: the
# steps below then bring only the parts that are missing. Every line here is a
# lookup (PATH, a file, a version) — nothing is downloaded, started or changed.
usable_claude() { # -> the path of a Claude Code binary that is the real one
  # Same rule as cli/src/claude-code-provision.js: before its native binary
  # lands, the package's placeholder is a ~500-byte instructions stub, so size
  # is the test. The user's own copy on PATH always wins. Nothing is executed.
  for p in "$(command -v claude 2>/dev/null || true)" \
           "$HOME/.hakster/claude-code/node_modules/.bin/claude" \
           "$HOME/.hakster/claude-code/node_modules/@anthropic-ai/claude-code/bin/claude"; do
    if [ -n "$p" ] && [ -f "$p" ]; then
      size=$(wc -c < "$p" 2>/dev/null | tr -d '[:space:]' || echo 0)
      if [ "${size:-0}" -gt 4096 ] 2>/dev/null; then printf '%s' "$p"; return 0; fi
    fi
  done
  return 1
}

say ""
say "What this machine already has — only the missing parts are installed:"
if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 \
   && [ "$(node_major)" -ge 20 ] 2>/dev/null; then
  say "  ✓ node $(node -v 2>/dev/null) · npm $(npm -v 2>/dev/null) — used as it is"
elif command -v node >/dev/null 2>&1; then
  say "  ✗ node $(node -v 2>/dev/null) is older than 20 — a Node 20+ runtime comes with this install"
else
  say "  ✗ node — a Node 20+ runtime comes with this install (~31 MB, one time)"
fi
if command -v bun >/dev/null 2>&1; then
  say "  ✓ bun on PATH — our TUI runs on it"
elif [ -x "$RUNTIME/bun/node_modules/.bin/bun" ]; then
  say "  ✓ bun in $RUNTIME/bun — our TUI runs on it"
else
  say "  ✗ bun — installed below (~90 MB, one time); without it the CLI uses its built-in Ink UI"
fi
if command -v guake >/dev/null 2>&1; then
  say "  ✓ guake — our drop-down look is applied below"
elif [ "$(uname -s)" = Linux ]; then
  say "  ✗ guake — installed below when this machine has a graphical session"
else
  say "  · guake — a Linux terminal only; nothing to do on $(uname -s 2>/dev/null || echo this system)"
fi
if CLAUDE_FOUND=$(usable_claude); then
  say "  ✓ claude code at $CLAUDE_FOUND — your own copy is used, never moved"
else
  say "  · claude code — not installed; 'hakster claude' sets it up once, on a paid plan"
  say "    (nothing is downloaded now: free plans never pay for ~400 MB they cannot use)"
fi
if command -v hakster >/dev/null 2>&1; then
  say "  · hakster CLI — already on PATH; this install puts the published package in place of it"
else
  say "  ✗ hakster CLI — installed below"
fi
say ""

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

# ── what the server says the newest build is ──────────────────────────────
# Owner, 2026-11-26: "all cli any user etc install need to get latest updates".
# The update contract (§39.3) is /cli/latest.json: the version and the SHA-256
# of ui-fb.mjs. A cached copy from a CDN or a proxy would otherwise install an
# older build than the one advertised, so the package is checked against it.
# Best effort — if the endpoint is missing, the install goes ahead unverified
# and says so (§13: never claim a check that did not run).
LATEST_VERSION=""
LATEST_BUNDLE=""
json_field() { # json_field <file> <key>
  node -e 'try{const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(j[process.argv[2]]||""))}catch{}' "$1" "$2" 2>/dev/null || true
}
if fetch "$ORIGIN/cli/latest.json" "$TMP/latest.json" 2>/dev/null; then
  LATEST_VERSION=$(json_field "$TMP/latest.json" version)
  LATEST_BUNDLE=$(json_field "$TMP/latest.json" bundleSha256)
  if [ -n "$LATEST_VERSION" ]; then say "✓ latest published build is v$LATEST_VERSION"; fi
fi

# ── the CLI itself ────────────────────────────────────────────────────────
# Installed from the package the server publishes, never from a git checkout:
# an installed package updates itself (§42), a checkout cannot.
say "… downloading the CLI from $ORIGIN"
CLI_SRC="$TMP/cli"
CHECKOUT=no
if fetch "$ORIGIN/cli/pkg.tar.gz" "$TMP/cli.tar.gz"; then
  tar -xzf "$TMP/cli.tar.gz" -C "$TMP" || fail "could not unpack the CLI package"
  [ -f "$TMP/cli/package.json" ] || fail "the downloaded package has no cli/package.json"
  if [ -n "$LATEST_BUNDLE" ]; then
    GOT_BUNDLE=$(sha256_of "$TMP/cli/ui-fb.mjs" || true)
    if [ "$GOT_BUNDLE" != "$LATEST_BUNDLE" ]; then
      say "… the copy served did not match the advertised build — asking once more past the cache"
      if fetch "$ORIGIN/cli/pkg.tar.gz?t=$(date +%s 2>/dev/null || echo 1)" "$TMP/cli-fresh.tar.gz" 2>/dev/null; then
        mkdir -p "$TMP/cli-fresh"
        if tar -xzf "$TMP/cli-fresh.tar.gz" -C "$TMP/cli-fresh" 2>/dev/null \
           && [ -f "$TMP/cli-fresh/cli/package.json" ]; then
          CLI_SRC="$TMP/cli-fresh/cli"
          GOT_BUNDLE=$(sha256_of "$CLI_SRC/ui-fb.mjs" || true)
        fi
      fi
    fi
    if [ -n "$GOT_BUNDLE" ] && [ "$GOT_BUNDLE" = "$LATEST_BUNDLE" ]; then
      say "✓ the package matches the published build (sha256 verified)"
    else
      say "⚠ the package served does not match the published bundle hash — installing the copy that arrived; re-run this installer later to pick up the newest build"
    fi
  else
    say "… the server did not advertise a build to verify against — installing the package as served"
  fi
else
  # Fallback: the package endpoint did not answer, so build from source. This
  # works, but a checkout never rewrites itself (§8) — re-run this installer to
  # move it forward. Nothing existing is removed.
  say "… the package endpoint did not answer — falling back to a source clone"
  command -v git >/dev/null 2>&1 || fail "could not download the CLI package and git is not available for the fallback"
  DEST="$HOME/.local/share/haksterai-cli"
  if [ -e "$DEST" ]; then DEST="$DEST-$(date +%Y%m%dT%H%M%S 2>/dev/null || echo backup)"; fi
  mkdir -p "$(dirname "$DEST")"
  git clone --depth 1 https://github.com/Deko38code/haksterAi.git "$DEST" >/dev/null 2>&1 \
    || fail "could not download the CLI package or fetch its source"
  CLI_SRC="$DEST/cli"
  CHECKOUT=yes
  say "⚠ installed from a source checkout at $DEST — it will report 'pull to update'; re-run this installer to move it forward"
fi
cd "$CLI_SRC"
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

# OpenTUI's native renderer for this machine. The dashboard draws through
# @opentui/core, which loads a per-OS/CPU package npm publishes as an OPTIONAL
# dependency — and an npm that skips optional packages leaves the dashboard
# dying the instant it opens, with nothing useful on screen (Surface Pro,
# 2026-11-26). The name comes from uname, never a guess, and it is installed
# only when the lookup below finds it absent: nothing here replaces a package
# that is already there, and nothing is installed silently.
OT_OS=$(uname -s 2>/dev/null | tr '[:upper:]' '[:lower:]')
OT_ARCH=$(uname -m 2>/dev/null)
case "$OT_ARCH" in
  x86_64|amd64) OT_ARCH=x64 ;;
  aarch64|arm64) OT_ARCH=arm64 ;;
  *) OT_ARCH="" ;;
esac
case "$OT_OS" in linux|darwin) ;; *) OT_OS="" ;; esac
if [ -n "$OT_OS" ] && [ -n "$OT_ARCH" ]; then
  OT_NAME="@opentui/core-$OT_OS-$OT_ARCH"
  if [ "$OT_OS" = linux ] && (ldd --version 2>&1 || true) | grep -qi musl; then
    OT_NAME="$OT_NAME-musl"
  fi
  OT_ROOT=""
  for r in "$(npm root -g 2>/dev/null | tail -n 1)" "$HOME/.local/lib/node_modules"; do
    if [ -n "$r" ] && [ -d "$r/hakster-cli" ]; then OT_ROOT="$r"; break; fi
  done
  if [ -z "$OT_ROOT" ]; then
    say "⚠ could not tell where the CLI was installed — the dashboard renderer was not checked"
  elif [ -f "$OT_ROOT/$OT_NAME/package.json" ]; then
    say "✓ dashboard renderer present ($OT_NAME)"
  else
    OT_VER=""
    if [ -f "$OT_ROOT/@opentui/core/package.json" ] && command -v node >/dev/null 2>&1; then
      OT_VER=$(node -e "try{process.stdout.write(String(require('$OT_ROOT/@opentui/core/package.json').version))}catch(e){}" 2>/dev/null || true)
    fi
    OT_SPEC="$OT_NAME"; [ -n "$OT_VER" ] && OT_SPEC="$OT_NAME@$OT_VER"
    say "… installing the dashboard renderer for this machine ($OT_SPEC)"
    if npm install -g --prefix "$(dirname "$OT_ROOT")" --no-audit --no-fund "$OT_SPEC" >/dev/null 2>&1 \
       && [ -f "$OT_ROOT/$OT_NAME/package.json" ]; then
      say "✓ dashboard renderer installed ($OT_NAME)"
    else
      say "⚠ the dashboard renderer could not be installed — the CLI still runs, with its built-in Ink UI"
      say "  To get the full dashboard, run this once and start the CLI again:"
      say "    npm install -g --prefix \"$(dirname \"$OT_ROOT\")\" $OT_SPEC"
    fi
  fi
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
  if [ -n "$LATEST_VERSION" ] && [ "$VERSION" != "$LATEST_VERSION" ]; then
    say "  the server advertises v$LATEST_VERSION — re-run this installer to pick it up"
  fi
else
  say "Installed: HaksterAI CLI (version did not answer — check 'hakster --version')"
fi
# §42: every install stays on the newest released build. This one is a package
# install, so it does that by itself — say it, and say how to ask now. An older
# git-checkout install left on the machine is untouched and never rewritten (§8).
if [ "$CHECKOUT" = no ] && [ -d "$HOME/.local/share/haksterai-cli/.git" ]; then
  say "  an older source checkout is still at ~/.local/share/haksterai-cli — left untouched; 'hakster' now runs the self-updating package"
fi
if [ "$CHECKOUT" = yes ]; then
  say "  updates: this is a source checkout — re-run this installer to update it"
else
  say "  updates: automatic — 'hakster update' checks now; a newer build applies at the next start"
fi
# The full install brings the drop-down (owner, 2026-11-26: "make sure guake
# come with the full install painted and all"). Guake is installed only where it
# can actually run — Linux with a graphical session — only when the machine has
# none, and through its own package manager, announced before it happens. A
# password is never stored or guessed: sudo asks for it on your own terminal,
# and only when a human is watching this output. With no terminal, or when you
# answer no, the exact command is printed and the install continues.
GUAKE_HINT=''
GUAKE_DONE=no
GUAKE_SKIPPED=no
if [ "$(uname -s)" = Linux ] && { [ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ]; } \
   && ! command -v guake >/dev/null 2>&1; then
  OS_ID=''
  if [ -r /etc/os-release ]; then
    OS_ID=$(. /etc/os-release 2>/dev/null; printf '%s %s' "${ID:-}" "${ID_LIKE:-}")
  fi
  case "$OS_ID" in
    *arch*|*manjaro*) GUAKE_HINT='pacman -S --noconfirm guake' ;;
    *fedora*|*rhel*|*centos*) GUAKE_HINT='dnf install -y guake' ;;
    *suse*) GUAKE_HINT='zypper --non-interactive install guake' ;;
    *alpine*) GUAKE_HINT='apk add guake' ;;
    *) GUAKE_HINT='apt-get install -y guake' ;;
  esac
  if [ "$(id -u)" = 0 ]; then
    say "  Guake: installing it — $GUAKE_HINT"
    if $GUAKE_HINT >/dev/null 2>&1; then GUAKE_DONE=yes; fi
  elif [ -t 1 ] && [ -c /dev/tty ] && sudo -n true 2>/dev/null; then
    say "  Guake: installing it — sudo $GUAKE_HINT"
    if sudo $GUAKE_HINT >/dev/null 2>&1; then GUAKE_DONE=yes; fi
  elif [ -t 1 ] && [ -c /dev/tty ]; then
    printf 'Install Guake — our drop-down look? [Y/n] ' >/dev/tty 2>/dev/null || GUAKE_SKIPPED=yes
    if [ "$GUAKE_SKIPPED" = no ]; then
      answer=''
      read -r answer < /dev/tty 2>/dev/null || answer=''
      case "$answer" in
        n|N|no|NO) GUAKE_SKIPPED=yes ;;
        *)
          say "  Guake: installing it — sudo $GUAKE_HINT"
          if sudo $GUAKE_HINT >/dev/null 2>&1; then GUAKE_DONE=yes; fi
          ;;
      esac
    fi
  fi
  if [ "$GUAKE_SKIPPED" = yes ]; then
    say "  Guake: skipped — 'sudo $GUAKE_HINT' installs it whenever you want the drop-down"
  elif [ "$GUAKE_DONE" != yes ] && ! command -v guake >/dev/null 2>&1; then
    say "  Guake: not installed — 'sudo $GUAKE_HINT' installs it"
  fi
fi
# The look comes with the install (owner, 2026-11-26: "i want it to come with our
# install the png"; "yes it should add"; "painted and all"). assets/guake-hakster.conf
# and assets/haksterai-backdrop.png ship inside the package; our profile is applied
# through Guake's own preference import with the previous profile backed up first —
# never by writing Guake's files. Anything that goes wrong is reported and the
# install stands.
if [ "${HAKSTER_NO_QUAKE:-0}" = 1 ]; then
  say "  Guake: look not applied (HAKSTER_NO_QUAKE=1)"
elif command -v guake >/dev/null 2>&1; then
  if QUAKE_OUT=$("$HAKSTER_BIN" quake --setup 2>&1); then
    if printf '%s' "$QUAKE_OUT" | grep -q "Guake look applied"; then
      say "  Guake: our look applied — our palette, font and the backdrop behind the drop-down"
    elif printf '%s' "$QUAKE_OUT" | grep -q "not applied"; then
      say "  Guake: found, but our look did not apply — run: hakster quake --setup --repair"
    else
      say "  Guake: our look is already applied for this version"
    fi
  else
    say "  Guake: found, but the look could not be applied — run: hakster quake --setup --repair"
  fi
fi
# ── sign in ─────────────────────────────────────────────────────────────────
# Same flow as install.ps1 (owner, 2026-11-26: the paid-plan flow carries its own
# sign-in): the CLI asks the server for a device code, a magic link opens in the
# browser, the operator checks the short code matches and presses Allow — only
# then does this machine hold the account's key, written straight into
# ~/.hakster/config.json and never printed, logged or put in a command line
# (§9, §23). Signing in proves who you are; the plan decides what the CLI may
# do, so the plan is read back rather than assumed.
# HAKSTER_NO_LOGIN=1, CI, or no terminal skips the prompt and prints the command.
json_str() { printf '%s' "$1" | sed -n "s/.*\"$2\":\"\([^\"]*\)\".*/\1/p" | head -1; }
signed_in() { [ -n "$1" ] && printf '%s' "$1" | grep -q '"signedIn":true'; }

SESSION=$("$HAKSTER_BIN" whoami --json 2>/dev/null | tail -1) || SESSION=''
INTERACTIVE=yes
[ -n "${HAKSTER_NO_LOGIN:-}" ] && INTERACTIVE=no
[ -n "${CI:-}" ] && INTERACTIVE=no
[ -r /dev/tty ] || INTERACTIVE=no

say ""
if signed_in "$SESSION"; then
  say "OK already signed in on this machine"
elif [ "$INTERACTIVE" = yes ]; then
  printf 'Sign in now? A magic link opens in your browser — press Allow there and this finishes by itself. [Y/n] ' > /dev/tty
  ANSWER=''
  read -r ANSWER < /dev/tty || ANSWER='n'
  case "$ANSWER" in
    ''|y|Y|yes|YES)
      "$HAKSTER_BIN" login || say "  ! sign-in did not finish — run 'hakster login' whenever you are ready"
      SESSION=$("$HAKSTER_BIN" whoami --json 2>/dev/null | tail -1) || SESSION=''
      ;;
    *) say "  skipped — run 'hakster login' whenever you are ready" ;;
  esac
else
  say "  sign in:  hakster login"
fi

CLI_INCLUDED=no
if signed_in "$SESSION"; then
  P_USER=$(json_str "$SESSION" username)
  P_PLAN=$(json_str "$SESSION" plan)
  [ -n "$P_USER" ] && say "OK signed in as @$P_USER — plan $P_PLAN" || say "OK signed in — plan $P_PLAN"
  if printf '%s' "$SESSION" | grep -q '"included":true'; then
    CLI_INCLUDED=yes
    say "OK this plan includes the CLI"
  else
    say "! this plan does not include the CLI — upgrade at $ORIGIN/plans/"
  fi
fi

say ""
if [ "$CLI_INCLUDED" = yes ]; then
  say "Next (open a new terminal if PATH was just changed):"
  say "  1) start your agent, or run Claude Code on this plan:"
  say "       hakster            # our own terminal agent"
  say "       hakster claude     # Claude Code on this plan (sets it up once if you have none)"
  say "       hakster quake      # the same CLI in a Guake drop-down"
  say ""
  say "  Check any time:  hakster whoami"
else
  say "Next (open a new terminal if PATH was just changed):"
  say "  1) sign in — a magic link opens in your browser, press Allow:"
  say "       hakster login"
  say "  2) start your agent once your plan includes the CLI:"
  say "       hakster            # our own terminal agent"
  say "       hakster quake      # the same CLI in a Guake drop-down"
  say ""
  say "  Plans:  $ORIGIN/plans/    Check any time:  hakster whoami"
fi
say "  No browser handy?  export HAKSTER_API_KEY=<key from $ORIGIN/dashboard/>"

cd /
rm -rf "$TMP"
