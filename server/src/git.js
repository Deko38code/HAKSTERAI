const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function isGitRepo(cwd) {
  return fs.existsSync(path.join(cwd, '.git'));
}

function initRepo(cwd) {
  if (!isGitRepo(cwd)) {
    execSync('git init', { cwd });
    try { execSync('git config user.name "hakster-agent"', { cwd }); } catch (_) {}
    try { execSync('git config user.email "agent@hakster.ai"', { cwd }); } catch (_) {}
  }
}

function checkpoint(cwd, message) {
  if (!cwd) cwd = process.cwd();
  try {
    initRepo(cwd);
    const status = execSync('git status --porcelain', { cwd, encoding: 'utf8' }).trim();
    if (!status) return { committed: false, reason: 'no_changes' };
    if (!message) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      message = `agent-checkpoint ${ts}`;
    }
    execSync('git add -A', { cwd });
    const diff = execSync('git diff --cached --stat', { cwd, encoding: 'utf8' }).trim();
    try { execSync(`git commit -m ${JSON.stringify(message)}`, { cwd }); } catch (e) {
      if (e.stderr && e.stderr.includes('nothing to commit')) return { committed: false, reason: 'no_changes' };
      throw e;
    }
    return { committed: true, message, diff };
  } catch (err) {
    return { committed: false, error: err.message };
  }
}

function getDiff(cwd) {
  if (!cwd) cwd = process.cwd();
  try {
    if (!isGitRepo(cwd)) return '';
    return execSync('git diff HEAD', { cwd, encoding: 'utf8', maxBuffer: 1024 * 1024 * 5 });
  } catch (_) { return ''; }
}

function getStatus(cwd) {
  if (!cwd) cwd = process.cwd();
  try {
    if (!isGitRepo(cwd)) return { isRepo: false };
    const raw = execSync('git status --porcelain', { cwd, encoding: 'utf8' }).trim();
    const files = raw ? raw.split('\n').filter(Boolean) : [];
    return { isRepo: true, dirty: files.length > 0, files };
  } catch (err) {
    return { isRepo: false, error: err.message };
  }
}

function getLog(cwd, count = 10) {
  if (!cwd) cwd = process.cwd();
  try {
    if (!isGitRepo(cwd)) return [];
    return execSync(`git log --oneline -n ${count}`, { cwd, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  } catch (_) { return []; }
}

module.exports = { checkpoint, getDiff, getStatus, getLog, isGitRepo };