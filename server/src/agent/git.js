// haksterAi Git Integration Module
// Auto-checkpoint before destructive file operations.
// Auto-commit after successful task completion.

const { execSync } = require('child_process');
const path = require('path');

function _run(cmd, cwd) {
  try {
    return execSync(cmd, { cwd: cwd || process.cwd(), encoding: 'utf-8', timeout: 10000 }).trim();
  } catch (e) {
    return null;
  }
}

function isGitRepo(cwd) {
  const result = _run('git rev-parse --is-inside-work-tree', cwd);
  return result === 'true';
}

function getGitRoot(cwd) {
  return _run('git rev-parse --show-toplevel', cwd);
}

function hasChanges(cwd) {
  const status = _run('git status --porcelain', cwd);
  return !!(status && status.trim().length > 0);
}

/**
 * Create a checkpoint commit before agent makes changes.
 * Only commits if there are uncommitted changes.
 * Returns commit hash or null.
 */
function checkpoint(cwd, reason) {
  if (!isGitRepo(cwd)) return null;
  if (!hasChanges(cwd)) return null;

  _run('git add -A', cwd);
  const msg = `checkpoint: ${reason || 'before agent action'} [auto]`;
  _run(`git commit -m ${JSON.stringify(msg)} --no-gpg-sign`, cwd);
  return _run('git rev-parse --short HEAD', cwd);
}

/**
 * Commit changes after a successful task.
 * Returns commit hash or null.
 */
function commitChanges(cwd, message) {
  if (!isGitRepo(cwd)) return null;
  if (!hasChanges(cwd)) return null;

  _run('git add -A', cwd);
  const msg = message || 'agent: completed task [auto]';
  _run(`git commit -m ${JSON.stringify(msg)} --no-gpg-sign`, cwd);
  return _run('git rev-parse --short HEAD', cwd);
}

/**
 * Get a diff of uncommitted changes.
 */
function getDiff(cwd) {
  if (!isGitRepo(cwd)) return null;
  return _run('git diff --stat', cwd);
}

/**
 * Get recent commit log.
 */
function getLog(cwd, count = 10) {
  if (!isGitRepo(cwd)) return null;
  return _run(`git log --oneline -${count}`, cwd);
}

/**
 * Revert to a specific commit (undo).
 */
function revertTo(cwd, commitHash) {
  if (!isGitRepo(cwd)) return null;
  return _run(`git revert --no-commit ${commitHash}`, cwd);
}

/**
 * Get the last checkpoint commit hash.
 */
function getLastCommit(cwd) {
  if (!isGitRepo(cwd)) return null;
  return _run('git rev-parse --short HEAD', cwd);
}

module.exports = {
  isGitRepo,
  getGitRoot,
  hasChanges,
  checkpoint,
  commitChanges,
  getDiff,
  getLog,
  revertTo,
  getLastCommit,
};