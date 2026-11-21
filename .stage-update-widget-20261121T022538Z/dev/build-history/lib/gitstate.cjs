'use strict';
/**
 * Git state for a build record — read-only.
 *
 * The build is what ships, not the commit. A working tree can carry changes
 * that no commit contains, so this module records BOTH sides and keeps them
 * apart:
 *
 *   committed   previous build's commit .. current HEAD   (git diff --name-status)
 *   uncommitted HEAD .. working tree                      (git status --porcelain)
 *
 * Nothing is staged, reset, cleaned or checked out. Only read commands run,
 * each with a short timeout, and a failure is reported as `unknown` rather
 * than guessed.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function git(cwd, args) {
  try {
    return execFileSync('git', args, {
      cwd, encoding: 'utf8', timeout: 8000, maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    return null;
  }
}

function parseNameStatusZ(out) {
  // `--name-status -z` emits: STATUS \0 path \0 (and a second path for R/C).
  if (!out) return [];
  const parts = out.split('\0').filter((p) => p.length);
  const rows = [];
  for (let i = 0; i < parts.length; i += 2) {
    const status = parts[i];
    const p1 = parts[i + 1];
    if (!status || !p1) break;
    const code = status.charAt(0);
    if (code === 'R' || code === 'C') {
      const p2 = parts[i + 2];
      rows.push({ status: code === 'R' ? 'renamed' : 'copied', from: p1, path: p2 || p1 });
      i += 1;
    } else {
      rows.push({
        status: code === 'A' ? 'added' : code === 'D' ? 'deleted' : code === 'M' ? 'modified' : 'changed',
        path: p1,
      });
    }
  }
  return rows;
}

function parseStatusPorcelainZ(out) {
  if (!out) return [];
  const parts = out.split('\0').filter((p) => p.length);
  const rows = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    const code = entry.slice(0, 2);
    const p = entry.slice(3);
    if (code.charAt(0) === 'R' || code.charAt(0) === 'C') {
      const from = parts[i + 1] || '';
      rows.push({ status: code.charAt(0) === 'R' ? 'renamed' : 'copied', from, path: p });
      i += 1;
      continue;
    }
    const a = code.charAt(0);
    const b = code.charAt(1);
    let status = 'modified';
    if (a === '?' || a === 'A') status = 'added';
    else if (a === 'D' || b === 'D') status = 'deleted';
    rows.push({ status, path: p });
  }
  return rows;
}

function groupByStatus(rows) {
  const out = { added: [], modified: [], deleted: [], renamed: [], copied: [], changed: [] };
  for (const r of rows) {
    if (!out[r.status]) out[r.status] = [];
    out[r.status].push(r.from ? `${r.from} → ${r.path}` : r.path);
  }
  return out;
}

/** Full read-only snapshot of the repo state for a build record. */
function capture(repoDir, previousCommit) {
  if (!git(repoDir, ['rev-parse', '--is-inside-work-tree'])) {
    return { available: false, reason: 'not a git work tree' };
  }
  const branch = (git(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD']) || '').trim() || null;
  const commit = (git(repoDir, ['rev-parse', 'HEAD']) || '').trim() || null;
  const shortCommit = commit ? commit.slice(0, 12) : null;
  const describe = (git(repoDir, ['describe', '--tags', '--always']) || '').trim() || null;
  // Source-control reference, only when it really is a GitHub remote — used for
  // links in the admin panel and nothing else.
  const remoteUrl = (git(repoDir, ['remote', 'get-url', 'origin']) || '').trim() || null;
  const github = remoteUrl && /github\.com[:/]([^/]+)\/([^/.]+)/i.exec(remoteUrl);
  const remote = github ? { provider: 'github', owner: github[1], repo: github[2].replace(/\.git$/, '') } : (remoteUrl ? { provider: 'other' } : null);

  const porcelain = git(repoDir, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']);
  const uncommittedRows = parseStatusPorcelainZ(porcelain || '');
  const dirty = uncommittedRows.length > 0;

  let committedRows = [];
  let commitRange = null;
  if (previousCommit && commit && previousCommit !== commit) {
    const out = git(repoDir, ['diff', '--name-status', '-z', previousCommit, commit]);
    committedRows = parseNameStatusZ(out || '');
    commitRange = { from: previousCommit, to: commit };
  }

  const subjects = [];
  if (previousCommit && commit && previousCommit !== commit) {
    const log = git(repoDir, ['log', '--no-merges', '--pretty=%h %s', `${previousCommit}..${commit}`]);
    if (log) subjects.push(...log.trim().split('\n').filter(Boolean).slice(0, 25));
  }

  return {
    available: true,
    branch,
    commit,
    shortCommit,
    describe,
    dirty,
    committed: groupByStatus(committedRows),
    uncommitted: groupByStatus(uncommittedRows),
    committedCount: committedRows.length,
    uncommittedCount: uncommittedRows.length,
    commitRange,
    remote,
    commitSubjects: subjects,
    // A commit alone never describes the build: say plainly when the shipped
    // tree carried more than the commit did.
    committedOnlyIncomplete: dirty,
  };
}

/** Dependency snapshot — package.json + lock hash, for before/after diffing. */
function dependencySnapshot(repoDir) {
  const pkgPath = path.join(repoDir, 'package.json');
  const lockPath = path.join(repoDir, 'package-lock.json');
  let deps = {};
  let version = null;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    version = pkg.version || null;
    deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  } catch (_) { /* unknown, reported as null */ }
  let lockHash = null;
  try {
    const crypto = require('crypto');
    lockHash = crypto.createHash('sha256').update(fs.readFileSync(lockPath)).digest('hex').slice(0, 16);
  } catch (_) {}
  return { version, deps, lockHash, packageCount: Object.keys(deps).length };
}

function diffDependencies(before, after) {
  if (!before || !after) return null;
  const added = [];
  const removed = [];
  const updated = [];
  const names = new Set([...Object.keys(before.deps || {}), ...Object.keys(after.deps || {})]);
  for (const name of names) {
    const a = (before.deps || {})[name];
    const b = (after.deps || {})[name];
    if (a && !b) removed.push({ name, version: a });
    else if (!a && b) added.push({ name, version: b });
    else if (a !== b) updated.push({ name, from: a, to: b });
  }
  return {
    added, removed, updated,
    lockChanged: before.lockHash !== after.lockHash,
    changed: added.length + removed.length + updated.length > 0 || before.lockHash !== after.lockHash,
  };
}

module.exports = { capture, dependencySnapshot, diffDependencies, groupByStatus };
