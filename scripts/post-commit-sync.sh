#!/bin/sh
# post-commit-sync.sh — keep BOTH servers carrying the same commit.
#
# Owner, 2026-11-26: "add a rule that when add or commit stuff both boxes stay up to date in sync no
# misses" / "for server sake". §41 in /home/ghost/CLAUDE.md.
#
# Started in the background by .git/hooks/post-commit with the new HEAD. It never blocks or slows the
# commit, and it writes only to logs/failover-sync.log.
#
# What it will and will not do:
#   · Runs only on the PRIMARY — the box that holds the live database. On the standby, `ssh mint`
#     answers with this box's own hostname, and the script stands down.
#   · Runs only for a commit that touches something failover-sync actually ships (server/, cli/,
#     scripts/, dist/, public/, package.json). A docs-only commit does not churn the standby.
#   · Retries while another sync holds the lock, so a commit that lands mid-sync is not missed.
#   · A policy hold (primary down, the standby answered during a failover, ...) is logged as HELD and
#     never as synced — it is a decision for the owner, not something this script overrides.
#
# Usage: post-commit-sync.sh [<sha>]      (sha defaults to HEAD)
set -eu
PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
export PATH
REPO_DIR="${REPO_DIR:-/home/ghost/haksterAi}"
cd "$REPO_DIR" || exit 0
LOG="${SYNC_LOG:-$REPO_DIR/logs/failover-sync.log}"
mkdir -p "$(dirname "$LOG")"
say() { printf '%s post-commit %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG"; }

SHA="${1:-HEAD}"

# ── which box am I, and is the standby reachable ───────────────────────────
STANDBY_SSH="${STANDBY_SSH:-mint}"
THIS_BOX=$(hostname 2>/dev/null || echo unknown)
THAT_BOX=$(ssh -n -o BatchMode=yes -o ConnectTimeout=5 "$STANDBY_SSH" hostname 2>/dev/null || echo '')
[ "$THAT_BOX" != "$THIS_BOX" ] || exit 0   # we ARE the standby; the primary drives this

# ── only a commit that changes the shipped server ──────────────────────────
TOUCHED=$(git show --pretty=format: --name-only "$SHA" 2>/dev/null || true)
[ -n "$TOUCHED" ] || exit 0
# AGENTS.md (and its CLAUDE.md symlink) is the agent's steering, loaded by walk-up from the
# slot's own working directory. A rule change that never reaches the standby leaves it steering
# blind after a failover, so a rules-only commit is a shipped commit. (§41.1, §41.3)
RELEVANT=$(printf '%s\n' "$TOUCHED" | grep -E '^(server|cli|scripts|dist|public)/|^package\.json$|^AGENTS\.md$|^CLAUDE\.md$' || true)
[ -n "$RELEVANT" ] || exit 0

say "commit $SHA touches $(printf '%s\n' "$RELEVANT" | wc -l | tr -d ' ') shipped file(s)"

# ── 0. publish: a shipped commit pushes itself to origin ───────────────────
# Owner, 2026-11-26: "all cli installed are updates should auto push on commited to our cli" /
# "both boxes are suppose to update". An install only sees a build once origin carries the
# commit, so every shipped commit publishes itself — behind the same §48 secret scan a
# pre-push hook runs. Never forced and never rebased: if origin has moved ahead the push is
# refused, logged, and the owner decides (§28.3, §42.6, §49.2).
# It runs BEFORE the standby check, so a standby that is down can never block a publish.
push_origin() {
  BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)
  case "$BRANCH" in ''|HEAD) say "push: detached HEAD — nothing pushed"; return 0 ;; esac
  git remote get-url origin >/dev/null 2>&1 || { say "push: no origin remote — nothing pushed"; return 0; }
  if ! git rev-parse --verify --quiet "refs/remotes/origin/$BRANCH" >/dev/null 2>&1; then
    git fetch -q origin "$BRANCH" 2>/dev/null || true
  fi
  if git rev-parse --verify --quiet "refs/remotes/origin/$BRANCH" >/dev/null 2>&1; then
    RANGE="origin/$BRANCH..HEAD"
    BEHIND=$(git rev-list --count "$RANGE" 2>/dev/null || echo 0)
    SCAN_ARGS="--commits $RANGE"
  else
    RANGE="HEAD"          # first push of this branch: scan the whole tree, by shape and value
    BEHIND=1
    SCAN_ARGS="--tree --deep"
  fi
  if [ "$BEHIND" -eq 0 ]; then say "push: origin/$BRANCH already current — nothing to push"; return 0; fi
  SCANNER="${HOME:-/home/ghost}/bin/secret-scan.sh"
  if [ -x "$SCANNER" ]; then
    # shellcheck disable=SC2086
    if ! out=$(timeout 180 "$SCANNER" $SCAN_ARGS 2>&1); then
      say "push: BLOCKED by the secret scan on $BEHIND commit(s) — nothing pushed (§48). Shape only:"
      printf '%s\n' "$out" | tail -20 | sed 's/^/       /' >> "$LOG"
      return 0
    fi
  else
    say "push: no secret scanner at $SCANNER — REFUSED rather than push unscanned (§48.5)"
    return 0
  fi
  if out=$(GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND='ssh -o BatchMode=yes -o ConnectTimeout=10' \
           timeout 180 git push --porcelain origin "HEAD:refs/heads/$BRANCH" 2>&1); then
    say "push: published $BEHIND commit(s) — origin/$BRANCH is now $(git rev-parse --short "$SHA" 2>/dev/null || git rev-parse --short HEAD)"
  else
    say "push: FAILED — nothing forced, origin untouched; the owner decides (§28.3, §49.2)"
    printf '%s\n' "$out" | tail -8 | sed 's/^/       /' >> "$LOG"
  fi
}
push_origin

# ── the standby must answer before the sync can run ────────────────────────
[ -n "$THAT_BOX" ] || { say "commit $SHA: standby $STANDBY_SSH unreachable — push done above, nothing synced"; exit 0; }

say "commit $SHA — syncing both boxes"

# ── run the sync, waiting out a sync already in progress ───────────────────
i=0
while : ; do
  i=$((i + 1))
  if out=$(sh scripts/failover-sync.sh 2>&1); then code=0; else code=$?; fi

  case "$out" in
    *"another sync is still running"*)
      if [ "$i" -ge 30 ]; then
        say "commit $SHA: gave up waiting for the running sync after $i tries — it will pick this commit up on its next tick"
        exit 0
      fi
      sleep 5
      continue ;;
  esac

  printf '%s\n' "$out" >> "$LOG"
  LAST=$(printf '%s\n' "$out" | tail -1)
  case "$out" in
    *"held:"*)
      say "commit $SHA: HELD, not synced — $(printf '%s\n' "$out" | grep -m1 'held:')" ;;
    *)
      if [ "$code" -eq 0 ]; then
        say "commit $SHA: synced — $LAST"
      else
        say "commit $SHA: sync FAILED (exit $code) — $LAST"
      fi ;;
  esac
  exit 0
done
