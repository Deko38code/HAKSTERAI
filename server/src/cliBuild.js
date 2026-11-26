/* The CLI build this box serves — one reading, cached.
 *
 * Owner, 2026-11-26: "make sure our cli is updating on startup and shows in
 * server cli when its installed always with version bump in tui". The CLI's own
 * side of that (apply a verified stage at start, say which version landed, keep
 * the header on the version this session runs) already lives in
 * cli/src/updater.js, cli/tui-entry.mjs and cli/ui/src/hooks/useCliUpdate.js.
 * This module is the server half: the version, bundle hash and commit that
 * /cli/latest.json publishes and an installer receives, read the same way from
 * the same files so the two answers can never drift (§13, §39.3).
 *
 * Cached deliberately. /api/version is polled by the dashboard and the applet,
 * and hashing a 430 KB bundle plus three git calls on every poll is exactly the
 * request-path blocking that was removed on 2026-11-26 (§47.2 no setbacks).
 * The cache is keyed by the files' own mtime+size, so a build or a version bump
 * invalidates it immediately — the TTL only bounds how often git is asked.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CLI_ROOT = path.join(__dirname, '..', '..', 'cli');
const REPO_ROOT = path.join(CLI_ROOT, '..');

// How often the commit reading is refreshed when the files have not changed.
const GIT_TTL_MS = 60 * 1000;

let filesKey = '';
let filesReading = null; // { version, bundleSha256, builtAt }
let gitReading = { at: 0, value: null };

function readFiles() {
  const pkgPath = path.join(CLI_ROOT, 'package.json');
  const bundlePath = path.join(CLI_ROOT, 'ui-fb.mjs');
  const pkgStat = fs.statSync(pkgPath);
  const bundleStat = fs.existsSync(bundlePath) ? fs.statSync(bundlePath) : null;
  const key = [pkgStat.mtimeMs, pkgStat.size, bundleStat ? bundleStat.mtimeMs : 0, bundleStat ? bundleStat.size : 0].join(':');
  if (filesReading && key === filesKey) return filesReading;
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  filesReading = {
    version: String(pkg.version || ''),
    bundleSha256: bundleStat ? crypto.createHash('sha256').update(fs.readFileSync(bundlePath)).digest('hex') : '',
    builtAt: bundleStat ? bundleStat.mtime.toISOString() : null,
  };
  filesKey = key;
  return filesReading;
}

function readGit() {
  if (Date.now() - gitReading.at < GIT_TTL_MS) return gitReading.value;
  let value = null;
  try {
    // Git on the primary (always current); the synced stamp on a slot with no
    // .git (§44.2, §44.3). A reading that cannot be taken is null, never guessed.
    value = require('../../scripts/cli-build-stamp.cjs').current(REPO_ROOT);
  } catch {
    value = null;
  }
  gitReading = { at: Date.now(), value };
  return value;
}

/** { version, bundleSha256, builtAt, commit, commits, package } for this box. */
function cliBuildInfo() {
  const files = readFiles();
  const build = readGit();
  return {
    version: files.version,
    bundleSha256: files.bundleSha256,
    builtAt: files.builtAt,
    commit: build ? build.commit : '',
    commits: build ? build.commits : null,
    package: '/cli/pkg.tar.gz',
  };
}

module.exports = { cliBuildInfo, CLI_ROOT };
