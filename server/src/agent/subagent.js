// haksterAi Sub-Agent Module
// Spawns sub-agents with optional git worktree isolation.
// Prevents conflicts between parent and child agents.

const { execSync } = require('child_process');
const path = require('path');
const crypto = require('crypto');

let _worktreeEnabled = false;
let _worktreeBase = null;  // Base directory for worktrees

function initialize(opts = {}) {
  _worktreeEnabled = !!opts.worktreeEnabled;
  _worktreeBase = opts.worktreeBase || path.join(process.cwd(), '.hakster/worktrees');
}

function isWorktreeEnabled() {
  return _worktreeEnabled;
}

/**
 * Create a git worktree for isolated sub-agent work.
 * Returns the worktree path or null if not applicable.
 */
function createWorktree(cwd, branchName) {
  if (!_worktreeEnabled) return null;

  const gitRoot = _runGit('rev-parse --show-toplevel', cwd);
  if (!gitRoot) return null;

  const branch = branchName || `subagent-${crypto.randomBytes(4).toString('hex')}`;
  const worktreePath = path.join(_worktreeBase, branch);

  try {
    _runGit(`worktree add -b ${branch} ${JSON.stringify(worktreePath)}`, gitRoot);
    return { path: worktreePath, branch, gitRoot };
  } catch (e) {
    return null;
  }
}

/**
 * Remove a worktree after merging changes back.
 */
function removeWorktree(worktreeInfo, merge = true) {
  if (!worktreeInfo || !worktreeInfo.gitRoot) return false;

  if (merge) {
    // Merge the branch back to the current branch
    const currentBranch = _runGit('rev-parse --abbrev-ref HEAD', worktreeInfo.gitRoot);
    if (currentBranch && currentBranch !== worktreeInfo.branch) {
      _runGit(`merge ${worktreeInfo.branch} --no-edit`, worktreeInfo.gitRoot);
    }
  }

  // Remove the worktree
  _runGit(`worktree remove --force ${JSON.stringify(worktreeInfo.path)}`, worktreeInfo.gitRoot);
  // Delete the branch
  _runGit(`branch -D ${worktreeInfo.branch}`, worktreeInfo.gitRoot);
  return true;
}

/**
 * Get the working directory for a sub-agent.
 * If worktree isolation is enabled, creates a worktree and returns its path.
 * Otherwise returns the current cwd.
 */
function getSubagentCwd(cwd, taskDescription) {
  if (!_worktreeEnabled) return { cwd, worktree: null };

  const branchName = `subagent-${crypto.randomBytes(4).toString('hex')}`;
  const worktree = createWorktree(cwd, branchName);
  if (!worktree) return { cwd, worktree: null };

  return { cwd: worktree.path, worktree };
}

function _runGit(cmd, cwd) {
  try {
    return execSync(`git ${cmd}`, { cwd: cwd || process.cwd(), encoding: 'utf-8', timeout: 10000 }).trim();
  } catch (e) {
    return null;
  }
}

module.exports = {
  initialize,
  isWorktreeEnabled,
  createWorktree,
  removeWorktree,
  getSubagentCwd,
};