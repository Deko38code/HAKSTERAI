#!/bin/sh
# failover-sync.sh — keep the Lenovo standby current, without ever taking it down.
#
# Owner, 2026-11-25: "if dell server drops for period of time lenovo kicks in" /
# "how can we make it to where no user gets errors we need both online at all
# times".
#
# The standby runs TWO slots on two ports. Only the slot the router calls active
# serves traffic. Each run puts the fresh database and code into the IDLE slot,
# boots it, waits until it answers, moves the router to it, and only then stops
# the old slot — so at no instant is there no standby serving, and an update
# costs a visitor nothing.
#
# Safety rules this script enforces (CLAUDE.md §2, §4):
#   · It never touches the Dell's running server or its database in place — the
#     snapshot comes from SQLite's own backup API, which is safe on a live DB.
#   · It refuses to sync while the standby is the one serving (`primary_alive`
#     false): those writes exist only on the Lenovo. The owner decides that case.
#   · It refuses to sync if a failover happened since the last run (`failovers`
#     rose): the standby may hold writes the Dell does not.
#   · Nothing is deleted: the previous database is kept as hakster.db.prev.
#
# Env (all optional):
#   STANDBY_SSH      default mint
#   STANDBY_URL      default http://10.0.0.210:3581   (the door the Dell dials)
#   SLOT_A_DIR       default haksterAi-standby-a      (relative to the standby's home)
#   SLOT_A_PORT      default 3591
#   SLOT_B_DIR       default haksterAi-standby-b
#   SLOT_B_PORT      default 3592
#   ROUTER_STATUS    default http://127.0.0.1:3579/router/status   (the Dell's own router)
#   STATE_FILE       default /tmp/hakster-failover-sync.state
#   ENV_FILES        default "server/.env .env"  (secret env files to mirror)
#   BANK_MIRROR      default 1    (1 = the standby's banks are the primary's exact
#                                  copy; 0 = append-only, nothing ever removed)
set -eu

# Cron runs with a minimal PATH and no profile, and with $HOME as the working
# directory — so both the PATH and the repo root are named, never assumed.
PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
export PATH
REPO_DIR="${REPO_DIR:-/home/ghost/haksterAi}"
cd "$REPO_DIR" || { echo "cannot enter $REPO_DIR"; exit 1; }

STANDBY_SSH="${STANDBY_SSH:-mint}"
STANDBY_URL="${STANDBY_URL:-http://10.0.0.210:3581}"
STANDBY_HOST=$(printf '%s' "$STANDBY_URL" | sed 's#^[a-zA-Z]*://##; s#[:/].*##')
SLOT_A_DIR="${SLOT_A_DIR:-haksterAi-standby-a}"
SLOT_A_PORT="${SLOT_A_PORT:-3591}"
SLOT_B_DIR="${SLOT_B_DIR:-haksterAi-standby-b}"
SLOT_B_PORT="${SLOT_B_PORT:-3592}"
ROUTER_STATUS="${ROUTER_STATUS:-http://127.0.0.1:3579/router/status}"
STATE_FILE="${STATE_FILE:-/tmp/hakster-failover-sync.state}"
# The standby's own databases, as they stood at the last sync: the evidence a
# failover is judged on (size + mtime, both slots, WAL included).
DBFP_FILE="${DBFP_FILE:-/tmp/hakster-failover-sync.dbfp}"
ENV_FILES="${ENV_FILES:-server/.env .env}"
LOCAL_DB="${LOCAL_DB:-/home/ghost/haksterAi/data/hakster.db}"
BANK_DIR_SRC="${BANK_DIR_SRC:-/home/ghost/.hakster/memories/banks}"
# 1 = the standby's banks are made the primary's exact copy (the default, so a
# failover recalls identically); 0 = the old append-only merge, which keeps any
# entry the standby learned on its own. See step 5c.
BANK_MIRROR="${BANK_MIRROR:-1}"
TMP="${TMPDIR:-/tmp}/hakster-sync.$$"

say() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
# Digest of the USER STATE the standby's live slot carries — row count and top
# rowid for every table a person's work lands in. Read-only, one ssh, and it
# never fails the run: an unreadable answer is an empty string, which holds.
# A whole-file fingerprint was the wrong measure: the standby's own server
# rewrites its database every minute (auto-heal, security scans), so the file
# always moves while the thing that can be lost — an account, a session, a
# message, a memory — does not.
standby_db_fingerprint() {
  # The Python travels on stdin, so no shell quoting can mangle it.
  ssh -o BatchMode=yes -o ConnectTimeout=8 "$STANDBY_SSH" \
    "SLOT_A='$SLOT_A_DIR' SLOT_B='$SLOT_B_DIR' python3 -I -" 2>/dev/null <<'PYFP'
import os, sqlite3, json
out = {}
for key in ('SLOT_A', 'SLOT_B'):
    slot = os.environ.get(key, '')
    try:
        c = sqlite3.connect('file:/home/ghost/%s/data/hakster.db?mode=ro' % slot, uri=True)
        row = {}
        for t in ('users','accounts','subscriptions','memories','sessions','messages','conversations'):
            try:
                n, top = c.execute('select count(*), coalesce(max(rowid),0) from "%s"' % t).fetchone()
                row[t] = [n, top]
            except Exception:
                pass
        out[slot] = row
        c.close()
    except Exception as e:
        out[slot] = str(e)
print(json.dumps(out, sort_keys=True))
PYFP
}
LOCK_DIR="${TMPDIR:-/tmp}/hakster-failover-sync.lock"
LOCK_PID="$LOCK_DIR/pid"
cleanup() { rm -rf "$TMP"; rm -f "$LOCK_PID" 2>/dev/null; rmdir "$LOCK_DIR" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

# One sync at a time: a slow copy must never overlap the next timer tick.
# A run killed mid-flight leaves its lock behind and would block every later sync
# forever (seen 2026-11-26 when a commit's background sync was killed with its tool
# process group). The lock records its owner's pid, so a stale lock is one whose
# owner is no longer running. Asking pgrep instead never worked: this script's own
# command line matches the pattern it searched for, so the stale branch was dead
# code and a killed run blocked every later sync permanently.
# Three details keep a live lock from being swept away:
#   · the holder must be alive AND actually a failover-sync process, so a recycled
#     pid belonging to something else is not mistaken for a running sync;
#   · a lock with no pid file yet is not stale while it is brand new — mkdir lands
#     microseconds before the pid is written, and that gap is a live run starting;
#   · the sweep is a rename, which only one process can win, so two runs that both
#     see a stale lock cannot both take it.
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  HOLDER=$(cat "$LOCK_PID" 2>/dev/null || true)
  if [ -n "$HOLDER" ] && kill -0 "$HOLDER" 2>/dev/null \
     && ps -p "$HOLDER" -o args= 2>/dev/null | grep -q 'failover-sync'; then
    say "held: another sync is still running (pid $HOLDER)"
    exit 0
  fi
  if [ -z "$HOLDER" ]; then
    LOCK_MT=$(stat -c %Y "$LOCK_DIR" 2>/dev/null || echo 0)
    if [ $(( $(date +%s) - LOCK_MT )) -lt 10 ]; then
      say "held: another sync is starting up"
      exit 0
    fi
  fi
  STALE="$LOCK_DIR.stale.$$"
  if mv "$LOCK_DIR" "$STALE" 2>/dev/null; then
    rm -rf "$STALE"
    mkdir "$LOCK_DIR" 2>/dev/null || { say "held: another sync is still running"; exit 0; }
    say "clearing a stale sync lock (holder pid ${HOLDER:-unknown} is not running)"
  else
    say "held: another sync is still running"
    exit 0
  fi
fi
printf '%s' "$$" > "$LOCK_PID" 2>/dev/null || true
mkdir -p "$TMP"

ctl() { ssh -n -o BatchMode=yes "$STANDBY_SSH" "sh ~/hakster-standby-ctl.sh $*"; }

# node on the standby lives under nvm, which a non-login ssh may not put on PATH.
# Resolve it once, with `node` as the fallback, so the bank merge can always run.
NODE_REMOTE=$(ssh -n -o BatchMode=yes -o ConnectTimeout=6 "$STANDBY_SSH" 'command -v node 2>/dev/null' || true)
[ -n "$NODE_REMOTE" ] || NODE_REMOTE=node
NODE_LOCAL="${NODE_LOCAL:-$(command -v node 2>/dev/null || echo node)}"

# ── 1. refuse while a failover has happened since the last sync ────────────
STATUS=$(curl -s -m 5 "$ROUTER_STATUS" 2>/dev/null || true)
if [ -n "$STATUS" ]; then
  FAILOVERS=$(printf '%s' "$STATUS" | sed -n 's/.*"failovers": *\([0-9]*\).*/\1/p')
  PRIMARY_ALIVE=$(printf '%s' "$STATUS" | sed -n 's/.*"primary_alive": *\([a-z]*\).*/\1/p')
  LAST=$(cat "$STATE_FILE" 2>/dev/null || echo 0)
  if [ "$PRIMARY_ALIVE" = "false" ]; then
    say "held: the primary is down; the standby is the one serving right now"
    exit 0
  fi
  if [ -n "$FAILOVERS" ] && [ "$FAILOVERS" != "$LAST" ]; then
    # A failover means the standby may have answered stateful traffic. The only
    # thing that can actually be lost is a write on the standby's own database,
    # so ask that file rather than the counter: the router's `failovers` rises
    # on every probe it loses, while half the static traffic is shared with the
    # standby by design (`staticMode: share`) and carries no state at all.
    # Unchanged since the last sync -> nothing to lose -> continue. Unreadable
    # or changed -> hold, exactly as before (§41.5).
    NOW_FP=$(standby_db_fingerprint || true)
    if [ -n "$NOW_FP" ] && [ -f "$DBFP_FILE" ] && [ "$NOW_FP" = "$(cat "$DBFP_FILE" 2>/dev/null)" ]; then
      say "failover seen ($FAILOVERS, was $LAST) but the standby's database is unchanged since the last sync - nothing to lose, continuing"
    else
      say "held: the standby answered $FAILOVERS request(s) during a failover (was $LAST)."
      say "       Its database may hold writes the Dell does not - not copying over them."
      say "       Decide which copy wins, then set $STATE_FILE to the current count."
      exit 0
    fi
  fi
  printf '%s' "$FAILOVERS" > "$STATE_FILE"
else
  say "held: router status unreadable at $ROUTER_STATUS (is the router running?)"
  exit 0
fi

# ── 2. consistent snapshot of the live database ────────────────────────────
python3 -I -c "
import sqlite3, sys
src = sqlite3.connect('file:$LOCAL_DB?mode=ro', uri=True)
dst = sqlite3.connect('$TMP/hakster.db')
src.backup(dst); dst.close(); src.close()
" || { say "failed: could not snapshot $LOCAL_DB"; exit 1; }
WANT=$(sha256sum "$TMP/hakster.db" | cut -d' ' -f1)
say "snapshot made ($(du -h "$TMP/hakster.db" | cut -f1) sha256 ${WANT%%????????????????????????????????????????})"

# ── 3. which slot is live, and which one is idle ───────────────────────────
# The switch needs the standby's router to be the blue-green one. Until it is,
# hold: starting a second slot that nothing routes to would only confuse the
# picture, and swapping the live tree's database under it would be worse.
STANDBY_ROUTER=$(ssh -n -o BatchMode=yes "$STANDBY_SSH" \
  'curl -s -m 4 http://127.0.0.1:3579/router/status' 2>/dev/null || true)
case "$STANDBY_ROUTER" in
  *'"peers"'*) : ;;
  *) say "held: the standby's router is not the blue-green one yet (cutover pending)"
     exit 0 ;;
esac

ACTIVE_PORT=$(printf '%s' "$STANDBY_ROUTER" |
  sed -n 's/.*"activePeerUrl": *"http:\/\/[^:"]*:\([0-9]*\)".*/\1/p')
if [ -z "$ACTIVE_PORT" ]; then
  # No router answer: fall back to whichever slot is actually listening.
  for p in "$SLOT_A_PORT" "$SLOT_B_PORT"; do
    if [ "$(curl -s -m 3 -o /dev/null -w '%{http_code}' "http://$STANDBY_HOST:$p/api/version" 2>/dev/null || true)" = "200" ]; then
      ACTIVE_PORT="$p"; break
    fi
  done
fi

if [ "$ACTIVE_PORT" = "$SLOT_A_PORT" ]; then
  TARGET_DIR="$SLOT_B_DIR"; TARGET_PORT="$SLOT_B_PORT"; OLD_PORT="$SLOT_A_PORT"
elif [ "$ACTIVE_PORT" = "$SLOT_B_PORT" ]; then
  TARGET_DIR="$SLOT_A_DIR"; TARGET_PORT="$SLOT_A_PORT"; OLD_PORT="$SLOT_B_PORT"
else
  TARGET_DIR="$SLOT_A_DIR"; TARGET_PORT="$SLOT_A_PORT"; OLD_PORT=""
fi
say "active slot: ${ACTIVE_PORT:-none} -> installing into $TARGET_DIR ($TARGET_PORT)"

# ── 4. keep the standby's *code* identical, not just its data ──────────────
# The router serves half the static traffic from the standby, and ad landing
# pages are static. A stale build there would show an old site to real ad
# clicks, so the deployable tree is synced with every data sync — into the IDLE
# slot, so the live one keeps the code it booted with.
scp -q -o BatchMode=yes scripts/failover-slot.sh "$STANDBY_SSH:~/hakster-standby-ctl.sh" \
  && ssh -n -o BatchMode=yes "$STANDBY_SSH" 'chmod 700 ~/hakster-standby-ctl.sh' \
  || { say "failed: could not install the slot helper"; exit 1; }

# The standby's own router is kept current the same way. Copying it does not
# change the running process: a router code change still needs its own restart,
# which is a deliberate decision, never a side effect of a data sync.
#
# That gap is silent by nature — on 2026-11-26 the pinned-prefix fix reached the
# standby's disk and the running router kept the old list, so half the public
# loads still hit the stale page for ~2 h. The hash is therefore read either
# side of the copy: when the file really changed, the run says a restart is
# owed instead of leaving it to be discovered from the public door (§50.2).
router_before=$(ssh -n -o BatchMode=yes "$STANDBY_SSH" \
  'sha256sum ~/hakster-standby-router.cjs 2>/dev/null | cut -d" " -f1' 2>/dev/null || true)
scp -q -o BatchMode=yes scripts/failover-router.cjs "$STANDBY_SSH:~/hakster-standby-router.cjs" \
  || { say "warning: could not update the standby's router file"; }
router_after=$(ssh -n -o BatchMode=yes "$STANDBY_SSH" \
  'sha256sum ~/hakster-standby-router.cjs 2>/dev/null | cut -d" " -f1' 2>/dev/null || true)
if [ -n "$router_before" ] && [ -n "$router_after" ] && [ "$router_before" != "$router_after" ]; then
  say "standby router file updated — restart hakster-router-lenovo there to load it (routing pins do not apply until it does)"
fi

# The bank merge helper travels the same way, so a standby can carry the primary's
# memory banks by entry id without ever removing one of its own (§41).
scp -q -o BatchMode=yes scripts/merge-banks-from-dir.cjs "$STANDBY_SSH:~/hakster-bank-merge.cjs" \
  || { say "warning: could not update the standby's bank merge helper"; }
scp -q -o BatchMode=yes scripts/memory-bank-union.cjs "$STANDBY_SSH:~/hakster-bank-union.cjs" \
  || { say "warning: could not update the standby's bank union helper"; }

ssh -n -o BatchMode=yes "$STANDBY_SSH" "mkdir -p ~/$TARGET_DIR/data" \
  || { say "failed: could not create $TARGET_DIR"; exit 1; }

# The commit the package was built from travels with it, so the standby (which
# has no .git) can answer /cli/latest.json with the same count the primary
# reads from git. Owner, 2026-11-26: "i want our cli to say in tui how many
# commits is behind before installs like hermes". Derived data only — the file
# is gitignored and rewritten here on every sync.
if [ "${SKIP_CODE:-0}" != "1" ]; then
  node /home/ghost/haksterAi/scripts/cli-build-stamp.cjs --write >/dev/null 2>&1 \
    && say "build stamp refreshed ($(node /home/ghost/haksterAi/scripts/cli-build-stamp.cjs 2>/dev/null || echo unknown))" \
    || say "warning: could not refresh the CLI build stamp"
  rsync -a --safe-links \
    --exclude='node_modules' --exclude='.git' --exclude='*.bak*' --exclude='*.db' --exclude='*.db-*' \
    --exclude='.env*' --exclude='*.key' --exclude='*.pem' --exclude='*.p12' \
    --exclude='google-oauth-client.json' --exclude='archives' --exclude='backups' --exclude='data' \
    -e "ssh -o BatchMode=yes" \
    /home/ghost/haksterAi/cli /home/ghost/haksterAi/server /home/ghost/haksterAi/dist \
    /home/ghost/haksterAi/scripts /home/ghost/haksterAi/public /home/ghost/haksterAi/package.json \
    /home/ghost/haksterAi/AGENTS.md /home/ghost/haksterAi/CLAUDE.md \
    /home/ghost/haksterAi/install.sh /home/ghost/haksterAi/install.ps1 \
    "$STANDBY_SSH:$TARGET_DIR/" \
    && say "code synced into $TARGET_DIR (dist, server, cli, scripts, installers, steering)" \
    || { say "warning: code sync did not complete - the slot keeps its previous build"; }
else
  say "code sync skipped (SKIP_CODE=1)"
fi

# ── 5. install the database into the IDLE slot (nobody is serving from it) ─
scp -q -o BatchMode=yes "$TMP/hakster.db" "$STANDBY_SSH:$TARGET_DIR/data/hakster.db.new" \
  || { say "failed: copy did not arrive"; exit 1; }
ssh -n -o BatchMode=yes "$STANDBY_SSH" \
  "sh ~/hakster-standby-ctl.sh install ~/$TARGET_DIR $WANT" \
  | sed 's/^/  /' || { say "failed: install refused (checksum?)"; exit 1; }

# ── 5b. the standby's env files, by hash (owner, 2026-11-25: "go copy") ────
# Secrets never pass through a log, an argument or a report: the file goes over
# ssh stdin, is compared by SHA-256, and only the outcome is printed. A copy is
# staged as .new and swapped in only once it verifies, with the previous file
# kept as .prev — a half-written env can never be booted. A file that is
# unreadable on the Dell is skipped, so a fault here cannot blank the standby.
if [ "${SKIP_ENV:-0}" = "1" ]; then
  say "env sync skipped (SKIP_ENV=1)"
else
  for f in $ENV_FILES; do
    if [ ! -r "$f" ]; then
      say "env: $f unreadable here - the standby keeps its copy"
      continue
    fi
    want=$(sha256sum "$f" | cut -d' ' -f1)
    have=$(ssh -n -o BatchMode=yes "$STANDBY_SSH" \
      "sha256sum ~/$TARGET_DIR/$f 2>/dev/null | cut -d' ' -f1" || true)
    if [ "$have" = "$want" ]; then
      say "env: $f already current in $TARGET_DIR"
      continue
    fi
    if ! ssh -n -o BatchMode=yes "$STANDBY_SSH" "mkdir -p ~/$TARGET_DIR/$(dirname "$f")"; then
      say "env: could not create $(dirname "$f") in $TARGET_DIR - keeping the copy"
      continue
    fi
    ssh -o BatchMode=yes "$STANDBY_SSH" \
      "cat > ~/$TARGET_DIR/$f.new && chmod 600 ~/$TARGET_DIR/$f.new" < "$f"
    got=$(ssh -n -o BatchMode=yes "$STANDBY_SSH" \
      "sha256sum ~/$TARGET_DIR/$f.new 2>/dev/null | cut -d' ' -f1" || true)
    if [ "$got" != "$want" ]; then
      ssh -n -o BatchMode=yes "$STANDBY_SSH" "rm -f ~/$TARGET_DIR/$f.new" || true
      say "env: $f copy did not verify - the standby keeps its previous copy"
      continue
    fi
    if ! ssh -n -o BatchMode=yes "$STANDBY_SSH" \
      "if [ -f ~/$TARGET_DIR/$f ]; then cp -p ~/$TARGET_DIR/$f ~/$TARGET_DIR/$f.prev; fi
       mv ~/$TARGET_DIR/$f.new ~/$TARGET_DIR/$f; chmod 600 ~/$TARGET_DIR/$f"; then
      say "env: $f could not be swapped in - the previous copy stands"
      continue
    fi
    say "env: $f updated in $TARGET_DIR (sha ${want%%????????????????????????????????????????}, previous kept as .prev)"
  done
fi

# ── 5c. reconcile the memory banks (union both ways by default) ─────────────
# Owner, 2026-11-28: "i always want the memory count correct and the same on
# both boxes". The one-way --prune mirror archived anything the standby learned
# on its own, so the two counts drifted between syncs (438 here / 437 there).
# BANK_MODE=union (default) unions by CONTENT in both directions: either box's
# entry is kept, the same fact banked under two ids collapses to one, and both
# sides end byte-identical so the count matches by construction. BANK_MODE=mirror
# keeps the old one-way prune for a deliberate reset.
# The agent pulls the banks before every task (pullMemoryBanks, called per run),
# so a standby that boots without them recalls nothing. Banks change on
# consolidation, not on commits, so this rides the five-minute timer rather than
# only the post-commit path.
#
# Owner, 2026-11-26: "prune but dont break". BANK_MIRROR=1 (default) makes the
# standby the primary's exact copy, file for file, so a failover recalls exactly
# what the Dell recalls. It is safe because of what surrounds it: step 1 already
# refused this run unless the primary is alive and no failover happened since the
# last sync, and the helper archives every entry it removes under
# ~/.hakster/memories/banks-pruned/<stamp>/ before the swap, refuses an empty or
# implausibly small source (a damaged primary cannot wipe the standby), and swaps
# each file atomically so a request reading banks mid-sync never sees a partial.
# BANK_MIRROR=0 restores the old append-only merge (nothing ever removed).
if [ "${SKIP_BANKS:-0}" = "1" ]; then
  say "banks sync skipped (SKIP_BANKS=1)"
elif [ ! -d "$BANK_DIR_SRC" ]; then
  say "banks: no bank dir at $BANK_DIR_SRC - the standby keeps its copy"
elif ! ssh -n -o BatchMode=yes "$STANDBY_SSH" 'test -f ~/hakster-bank-union.cjs'; then
  say "banks: union helper missing on the standby - the standby keeps its copy"
elif [ "${BANK_MODE:-union}" = "mirror" ]; then
  if tar -C "$BANK_DIR_SRC" -cf - --exclude='*.bak-*' . 2>/dev/null |
       ssh -o BatchMode=yes "$STANDBY_SSH" \
         'rm -rf ~/.hakster-banks-incoming && mkdir -p ~/.hakster-banks-incoming && tar -C ~/.hakster-banks-incoming -xf -'; then
    if [ "$BANK_MIRROR" = "0" ]; then BANK_MODE=""; MODE_WORD="merged"; else BANK_MODE="--prune"; MODE_WORD="mirrored"; fi
    BOUT=$(ssh -n -o BatchMode=yes "$STANDBY_SSH" \
      "cd \$HOME && $NODE_REMOTE \$HOME/hakster-bank-merge.cjs \$HOME/.hakster-banks-incoming $BANK_MODE 2>&1; rc=\$?; rm -rf \$HOME/.hakster-banks-incoming; exit \$rc" 2>&1 || true)
    added=$(printf '%s\n' "$BOUT" | sed -n 's/^  "added": \([0-9][0-9]*\),\{0,1\}$/\1/p' | tail -1)
    kept=$(printf '%s\n' "$BOUT" | sed -n 's/^  "kept": \([0-9][0-9]*\),\{0,1\}$/\1/p' | tail -1)
    removed=$(printf '%s\n' "$BOUT" | sed -n 's/^  "removed": \([0-9][0-9]*\),\{0,1\}$/\1/p' | tail -1)
    if printf '%s' "$BOUT" | grep -q '"refused"'; then
      say "banks: refused to $MODE_WORD - the primary's bank dir looks empty or partial; the standby keeps its copy"
    elif [ -n "$added" ]; then
      if [ -n "$removed" ] && [ "$removed" != "0" ]; then
        say "banks: $MODE_WORD into the standby ($added new, $removed removed and archived, ${kept:-?} kept)"
      else
        say "banks: $MODE_WORD into the standby ($added new entr(y/ies), ${kept:-?} kept, none removed)"
      fi
    else
      say "banks: $MODE_WORD returned no count - the standby keeps its copy"
      printf '%s\n' "$BOUT" | sed 's/^/  /'
    fi
    if printf '%s' "$BOUT" | grep -q '"blocked"'; then
      say "banks: at least one bank file could not be written - the standby keeps its previous copy of it"
    fi
    if printf '%s' "$BOUT" | grep -q '"replacedOwner"'; then
      say "banks: a previous root-owned bank file was replaced (derived cache, nothing removed)"
    fi
  else
    say "warning: could not ship the banks to the standby - it keeps its copy"
  fi
else
  # Union, both ways, every root. Push, let the standby union us in, pull its own
  # entries home, then re-read its banks and prove the two sides are identical.
  # --merge-tree walks `banks` plus each `users/<slug>/banks`, so a paid user's
  # own banks sync with that same user's banks on the other box and never into
  # anyone else's root (§53.4). With one root today it is the same union as before.
  MEM_DIR_SRC=$(dirname "$BANK_DIR_SRC")
  BANKS_TMP="$TMP/banks"; rm -rf "$BANKS_TMP"; mkdir -p "$BANKS_TMP/peer" "$BANKS_TMP/verify"
  if ( cd "$MEM_DIR_SRC" && tar -cf - --exclude='*.bak-*' banks $(ls -d users/*/banks 2>/dev/null || true) ) 2>/dev/null |
       ssh -o BatchMode=yes "$STANDBY_SSH" \
         'rm -rf ~/.hakster-banks-incoming && mkdir -p ~/.hakster-banks-incoming && tar -C ~/.hakster-banks-incoming -xf -'; then
    ROUT=$(ssh -n -o BatchMode=yes "$STANDBY_SSH" \
      "cd \$HOME && $NODE_REMOTE \$HOME/hakster-bank-union.cjs --merge-tree \$HOME/.hakster-banks-incoming --json 2>&1; rc=\$?; rm -rf \$HOME/.hakster-banks-incoming; exit \$rc" 2>&1 || true)
    radded=$(printf '%s\n' "$ROUT" | sed -n 's/^  "added": \([0-9][0-9]*\),\{0,1\}$/\1/p' | tail -1)
    rtotal=$(printf '%s\n' "$ROUT" | sed -n 's/^  "total": \([0-9][0-9]*\),\{0,1\}$/\1/p' | tail -1)
    if [ -z "$radded" ]; then
      say "banks: union into the standby returned no count - the standby keeps its copy"
      printf '%s\n' "$ROUT" | sed 's/^/  /' | head -6
    else
      say "banks: union into the standby ($radded new, ${rtotal:-?} entries there)"
      if ssh -o BatchMode=yes "$STANDBY_SSH" 'cd ~/.hakster/memories && tar -cf - --exclude="*.bak-*" banks $(ls -d users/*/banks 2>/dev/null || true)' 2>/dev/null | tar -C "$BANKS_TMP/peer" -xf -; then
        LOUT=$($NODE_LOCAL "$REPO_DIR/scripts/memory-bank-union.cjs" --mem-dir "$MEM_DIR_SRC" --merge-tree "$BANKS_TMP/peer" --json 2>&1 || true)
        ladded=$(printf '%s\n' "$LOUT" | sed -n 's/^  "added": \([0-9][0-9]*\),\{0,1\}$/\1/p' | tail -1)
        ltotal=$(printf '%s\n' "$LOUT" | sed -n 's/^  "total": \([0-9][0-9]*\),\{0,1\}$/\1/p' | tail -1)
        if [ -z "$ladded" ]; then
          say "banks: union back into the primary returned no count"
          printf '%s\n' "$LOUT" | sed 's/^/  /' | head -6
        else
          say "banks: union back into the primary ($ladded new, ${ltotal:-?} entries here)"
        fi
        if ssh -o BatchMode=yes "$STANDBY_SSH" 'cd ~/.hakster/memories && tar -cf - --exclude="*.bak-*" banks $(ls -d users/*/banks 2>/dev/null || true)' 2>/dev/null | tar -C "$BANKS_TMP/verify" -xf -; then
          if VOUT=$($NODE_LOCAL "$REPO_DIR/scripts/memory-bank-union.cjs" --mem-dir "$MEM_DIR_SRC" --verify-tree "$BANKS_TMP/verify" 2>&1); then
            say "banks: both boxes verified equal ($(printf '%s\n' "$VOUT" | sed -n 's/^EQUAL.*local \([0-9][0-9]*\) .*/\1/p') entries)"
          else
            say "banks: DRIFT after union - $(printf '%s\n' "$VOUT" | tail -1)"
            printf '%s\n' "$VOUT" | sed 's/^/  /' | head -14
          fi
        else
          say "banks: could not re-read the standby's banks - equality not verified"
        fi
      else
        say "banks: could not pull the standby's banks home - its own entries stay there"
      fi
    fi
  else
    say "warning: could not ship the banks to the standby - it keeps its copy"
  fi
fi

# ── 6. boot the idle slot and wait until it really answers ─────────────────
if [ "$(curl -s -m 3 -o /dev/null -w '%{http_code}' "http://$STANDBY_HOST:$TARGET_PORT/api/version" 2>/dev/null || true)" != "200" ]; then
  ssh -n -o BatchMode=yes "$STANDBY_SSH" \
    "sh ~/hakster-standby-ctl.sh start ~/$TARGET_DIR $TARGET_PORT" | sed 's/^/  /' \
    || { say "failed: slot would not start"; exit 1; }
fi

i=0; up=""
while [ $i -lt 40 ]; do
  if [ "$(curl -s -m 3 -o /dev/null -w '%{http_code}' "http://$STANDBY_HOST:$TARGET_PORT/api/version" 2>/dev/null || true)" = "200" ]; then
    up="yes"; break
  fi
  i=$((i + 1)); sleep 1
done
if [ -z "$up" ]; then
  say "failed: $TARGET_DIR did not answer on $TARGET_PORT within 40 s - the old slot keeps the traffic"
  exit 1
fi
say "idle slot is answering on $TARGET_PORT - switching the router to it"

# ── 7. move traffic, then stop the old slot ────────────────────────────────
ssh -n -o BatchMode=yes "$STANDBY_SSH" \
  "sh ~/hakster-standby-ctl.sh switch $TARGET_PORT" | sed 's/^/  /' \
  || { say "failed: the router did not accept the switch - the old slot keeps the traffic"; exit 1; }

if [ -n "$OLD_PORT" ] && [ "$OLD_PORT" != "$TARGET_PORT" ]; then
  # Let in-flight requests finish on the old slot before it goes away.
  sleep 2
  ssh -n -o BatchMode=yes "$STANDBY_SSH" \
    "sh ~/hakster-standby-ctl.sh stop $OLD_PORT" | sed 's/^/  /' || true
fi

# ── 8. confirm what the Dell actually sees through the door ────────────────
code=""
i=0
while [ $i -lt 10 ]; do
  code=$(curl -s -m 3 -o /dev/null -w '%{http_code}' "$STANDBY_URL/api/version" 2>/dev/null || true)
  [ "$code" = "200" ] && break
  i=$((i + 1)); sleep 1
done
# The databases as they now stand on the standby: the baseline the next run
# compares a failover against. Written only after the door answered.
standby_db_fingerprint > "$DBFP_FILE" 2>/dev/null || true
say "done: standby door answered ${code:-nothing} on $STANDBY_URL (active slot $TARGET_PORT)"
[ "$code" = "200" ]
