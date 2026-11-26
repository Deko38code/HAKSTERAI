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
  // Git walks up the directory tree, so a slot dir on a machine whose home is
  // some other repository would answer with THAT repo's history (seen on the
  // standby 2026-11-26: 77 commits, commit a109219, for a tree of 281). The
  // root must be its own work tree, or there is no reading here at all.
  let top = '';
  try {
    top = fs.realpathSync(git(root, ['rev-parse', '--show-toplevel']) || '');
  } catch { return null; }
  let here = '';
  try {
    here = fs.realpathSync(root);
  } catch { return null; }
  if (!top || top !== here) return null;
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

/** Refresh the stamp only when it disagrees with the repository.
 *
 *  /cli/pkg.tar.gz packs the tree exactly as it sits on disk, so whatever
 *  cli/.build-stamp.json holds is what every install receives — and an
 *  installed copy has no .git, so that file is its only commit reading (§44.2).
 *  Measured 2026-11-26: the packaged stamp said v0.3.83 / 324 commits while the
 *  tree was at v0.3.86 / 333 (three version bumps after the last sync), so a
 *  fresh install computed "0 commits behind" from a stamp older than the code
 *  it had just received. The pack is the moment the stamp must be true.
 *
 *  Only a machine with its own work tree can write it; everywhere else the file
 *  arrives by sync, unchanged. Returns the stamp in force, or null when there is
 *  no reading at all.
 */
function ensureFresh(root = ROOT) {
  const g = fromGit(root);
  if (!g) return readStamp(root);
  let version = '';
  try {
    version = String(JSON.parse(fs.readFileSync(path.join(root, 'cli', 'package.json'), 'utf8')).version || '');
  } catch { /* version is informational only */ }
  const onDisk = readStamp(root);
  if (onDisk && onDisk.commit === g.commit && onDisk.commits === g.commits && onDisk.version === version && onDisk.builtAt) {
    return onDisk; // already true — no write, no churn
  }
  return writeStamp(root);
}

module.exports = { fromGit, readStamp, writeStamp, ensureFresh, current };

if (require.main === module) {
  const wantWrite = process.argv.includes('--write');
  const stamp = wantWrite ? writeStamp() : current();
  if (!stamp) {
    console.error('no git reading and no cli/.build-stamp.json');
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify(stamp)}\n`);
}
