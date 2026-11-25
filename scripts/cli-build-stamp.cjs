#!/usr/bin/env node
/* cli/.build-stamp.json — which commit this CLI package was built from.
 *
 * Owner, 2026-11-26: "i want our cli to say in tui how many commits is behind
 * before installs like hermes" and "so it always is upto date".
 *
 * The published package travels to two kinds of machine: the primary (the
 * Dell, which has the git tree) and the standby slot (which has no .git —
 * failover-sync excludes it on purpose). A commit count can therefore only be
 * read from git in one of them, so the count is written into a stamp file
 * beside the package and synced with it. The route reads git first (always
 * current on the primary) and the stamp second (the standby, and any install
 * that has no repository at all).
 *
 * The file is derived data, never a source: it is gitignored, rewritten by the
 * sync, and shipped inside /cli/pkg.tar.gz so an installed copy also knows
 * which commit it is running.
 *
 *   node scripts/cli-build-stamp.cjs            # print the current reading
 *   node scripts/cli-build-stamp.cjs --write    # refresh the stamp on disk
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STAMP = path.join(ROOT, 'cli', '.build-stamp.json');

function git(root, args) {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
  } catch {
    return '';
  }
}

/** { commit, commits } from the real repository, or null when there is none. */
function fromGit(root = ROOT) {
  const commit = git(root, ['rev-parse', '--short', 'HEAD']);
  const count = git(root, ['rev-list', '--count', 'HEAD']);
  const commits = parseInt(count, 10);
  if (!commit || !Number.isFinite(commits) || commits <= 0) return null;
  return { commit, commits };
}

function readStamp(root = ROOT) {
  try {
    const stamp = JSON.parse(fs.readFileSync(path.join(root, 'cli', '.build-stamp.json'), 'utf8'));
    const commits = parseInt(stamp.commits, 10);
    if (!Number.isFinite(commits) || commits <= 0) return null;
    return {
      commit: String(stamp.commit || ''),
      commits,
      version: String(stamp.version || ''),
      builtAt: stamp.builtAt || null,
    };
  } catch {
    return null;
  }
}

/** Refresh the stamp from git. Only a machine with the repository can do this;
 *  everywhere else the file arrives by sync, as it left here. */
function writeStamp(root = ROOT) {
  const g = fromGit(root);
  if (!g) return null;
  let version = '';
  try {
    version = String(JSON.parse(fs.readFileSync(path.join(root, 'cli', 'package.json'), 'utf8')).version || '');
  } catch { /* version is informational only */ }
  const stamp = { version, commit: g.commit, commits: g.commits, builtAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(path.join(root, 'cli', '.build-stamp.json')), { recursive: true });
  fs.writeFileSync(path.join(root, 'cli', '.build-stamp.json'), `${JSON.stringify(stamp, null, 2)}\n`);
  return stamp;
}

/** What the published package is: git when this machine has it, else the stamp. */
function current(root = ROOT) {
  const g = fromGit(root);
  if (g) {
    let version = '';
    try {
      version = String(JSON.parse(fs.readFileSync(path.join(root, 'cli', 'package.json'), 'utf8')).version || '');
    } catch { /* informational only */ }
    return { ...g, version };
  }
  return readStamp(root);
}

module.exports = { fromGit, readStamp, writeStamp, current };

if (require.main === module) {
  const wantWrite = process.argv.includes('--write');
  const stamp = wantWrite ? writeStamp() : current();
  if (!stamp) {
    console.error('no git reading and no cli/.build-stamp.json');
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify(stamp)}\n`);
}
