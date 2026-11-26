'use strict';
/* Quake terminal (Guake) — shipped with the CLI, not left to the customer.
 *
 * Owner, 2026-11-25: "make sure our cli when paid users download it it comes
 * with quake terminal no matter what for best looks graphics render speed color
 * and makes our cli tui dope out of the competition" and "the startup like my
 * cli does the matrix and my backsolash i have all included".
 *
 * So the package carries the whole look, and the CLI applies it:
 *
 *   - `assets/guake-hakster.conf` is the owner's own Guake profile — his neon
 *     palette, DejaVu Sans Mono 11, 100 % drop-down geometry, the same
 *     transparency — with one placeholder (`@BACKDROP@`) for the background.
 *   - `assets/haksterai-backdrop.png` is that backdrop, shipped in the tarball,
 *     so the drop-down looks the same on a customer's machine as here.
 *   - `hakster quake` offers to install Guake when it is missing (never without
 *     consent — no silent sudo), applies the profile once per version, backs up
 *     whatever profile was there first, and then opens the TUI in a drop-down
 *     tab.
 *
 * The profile is applied the way Guake itself supports it — `--save-preferences`
 * for the backup and `--restore-preferences` for ours — so nothing here writes
 * Guake's own config files directly (§2.9: no guessed config formats).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { homeDir } = require('./home-dir');
const { spawnSync } = require('child_process');

const ASSETS = path.join(__dirname, '..', 'assets');
const TEMPLATE = path.join(ASSETS, 'guake-hakster.conf');
const BACKDROP = path.join(ASSETS, 'haksterai-backdrop.png');

function home() {
  return homeDir();
}

function markerPath() {
  return path.join(home(), '.hakster', 'quake-profile.json');
}

/** The Guake binary, or ''. Read-only probe; never starts it.
 *
 *  A login shell may print a banner before the path — the owner's bashrc
 *  prints "[haksterAI] terminal functions loaded: …" — so the whole stdout is
 *  NOT the binary name. Take the last line that is an existing absolute path;
 *  anything else is no answer. (Seen 2026-11-26: on Mint the blob was passed to
 *  spawnSync as the program, which failed ENOENT, so `hakster quake --setup`
 *  never applied the backdrop.)
 */
function findGuake({ run = spawnSync, exists = fs.existsSync } = {}) {
  try {
    const out = run('bash', ['-lc', 'command -v guake'], { encoding: 'utf8', timeout: 5000 });
    const lines = String((out && out.stdout) || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (lines[i].startsWith('/') && exists(lines[i])) return lines[i];
    }
    return '';
  } catch {
    return '';
  }
}

/** The package's own profile, with the backdrop's real path filled in. */
function renderProfile(backdrop = BACKDROP) {
  const raw = fs.readFileSync(TEMPLATE, 'utf8');
  return raw.split('@BACKDROP@').join(String(backdrop || ''));
}

/**
 * How to install Guake on this distribution. Pure: takes the contents of
 * /etc/os-release, returns `{ id, manager, argv }`. Debian/Ubuntu/Parrot/Mint
 * lead because that is what we run; the rest are real package managers with
 * the same package name rather than a guess dressed up as an install.
 */
function installHint(osRelease = '') {
  const text = String(osRelease || '');
  const id = (/^ID=(.+)$/m.exec(text) || [])[1] || '';
  const like = (/^ID_LIKE=(.+)$/m.exec(text) || [])[1] || '';
  const family = `${id} ${like}`.toLowerCase().replace(/["']/g, '');
  if (/arch|manjaro/.test(family)) {
    return { id: id.trim() || 'arch', manager: 'pacman', argv: ['sudo', 'pacman', '-S', '--noconfirm', 'guake'] };
  }
  if (/fedora|rhel|centos/.test(family)) {
    return { id: id.trim() || 'fedora', manager: 'dnf', argv: ['sudo', 'dnf', 'install', '-y', 'guake'] };
  }
  if (/suse|opensuse/.test(family)) {
    return { id: id.trim() || 'opensuse', manager: 'zypper', argv: ['sudo', 'zypper', '--non-interactive', 'install', 'guake'] };
  }
  if (/alpine/.test(family)) {
    return { id: 'alpine', manager: 'apk', argv: ['sudo', 'apk', 'add', 'guake'] };
  }
  return { id: id.trim() || 'debian', manager: 'apt', argv: ['sudo', 'apt-get', 'install', '-y', 'guake'] };
}

function readOsRelease(file = '/etc/os-release') {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** Has this exact profile (for this CLI version) already been applied? */
function isSetup(version, { backdrop = BACKDROP, marker = markerPath() } = {}) {
  try {
    const saved = JSON.parse(fs.readFileSync(marker, 'utf8'));
    return saved.version === String(version || '') && saved.backdrop === backdrop && !!saved.at;
  } catch {
    return false;
  }
}

function writeMarker(version, { backdrop = BACKDROP, marker = markerPath() } = {}) {
  try {
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, `${JSON.stringify({ version: String(version || ''), backdrop, at: new Date().toISOString() }, null, 2)}\n`, { mode: 0o644 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Apply the shipped profile through Guake's own preferences import, after
 * saving whatever was there first (so it can always be put back).
 * Returns `{ ok, backup, reason }`.
 */
function applyProfile({ version = '', run = spawnSync, backdrop = BACKDROP, find = findGuake } = {}) {
  const guake = find();
  if (!guake) return { ok: false, reason: 'guake-missing' };
  const confDir = path.join(home(), '.config', 'guake');
  let backup = '';
  try {
    fs.mkdirSync(confDir, { recursive: true });
    backup = path.join(confDir, `hakster-backup-${new Date().toISOString().replace(/[:.]/g, '')}.conf`);
    const saved = run(guake, ['--save-preferences', backup], { encoding: 'utf8', timeout: 15000 });
    if (saved && saved.status !== 0) backup = '';
  } catch {
    backup = '';
  }
  let rendered;
  try {
    rendered = renderProfile(backdrop);
  } catch (err) {
    return { ok: false, reason: `no-template: ${err.message}` };
  }
  const tmp = path.join(os.tmpdir(), `hakster-guake-${process.pid}.conf`);
  try {
    fs.writeFileSync(tmp, rendered, { mode: 0o600 });
    const out = run(guake, ['--restore-preferences', tmp], { encoding: 'utf8', timeout: 20000 });
    if (!out || out.status !== 0) {
      return { ok: false, reason: 'restore-failed', backup, stderr: String((out && out.stderr) || '').slice(0, 300) };
    }
  } catch (err) {
    return { ok: false, reason: `restore-error: ${err.message}`, backup };
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* temp file only */ }
  }
  writeMarker(version, { backdrop });
  return { ok: true, backup };
}

/**
 * Make sure Guake exists. Never installs without `yes`, and never at all when
 * the caller is non-interactive — the printed command is the fallback.
 */
function ensureGuake({ yes = false, interactive = Boolean(process.stdin.isTTY), run = spawnSync, log = console.log, osRelease, find = findGuake } = {}) {
  const found = find();
  if (found) return { ok: true, path: found, installed: false };
  const hint = installHint(osRelease === undefined ? readOsRelease() : osRelease);
  const cmd = hint.argv.join(' ');
  if (!yes && !interactive) {
    log(`✗ Guake is not installed. Install it: ${cmd}`);
    return { ok: false, reason: 'guake-missing', cmd };
  }
  if (!yes) {
    log(`◆ Guake is not installed. Install it with: ${cmd}`);
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = new Promise((resolve) => rl.question('  install now? [y/N] ', (a) => { rl.close(); resolve(/^y(es)?$/i.test(String(a || '').trim())); }));
    return answer.then((wants) => {
      if (!wants) return { ok: false, reason: 'declined', cmd };
      const out = run(hint.argv[0], hint.argv.slice(1), { stdio: 'inherit', timeout: 300000 });
      const ok = !out || out.status === 0;
      return { ok, reason: ok ? '' : 'install-failed', cmd, installed: ok };
    });
  }
  const out = run(hint.argv[0], hint.argv.slice(1), { stdio: 'inherit', timeout: 300000 });
  const ok = !out || out.status === 0;
  return { ok, reason: ok ? '' : 'install-failed', cmd, installed: ok };
}

/** The command Guake runs in the new tab: the CLI's TUI, in this directory. */
function tabCommand({ cwd = process.cwd(), execPath = process.execPath, entry = path.join(__dirname, '..', 'index.js'), extra = 'tui' } = {}) {
  const q = (v) => `'${String(v).replace(/'/g, "'\\''")}'`;
  return `cd ${q(cwd)} && HAKSTER_NO_SPLASH=1 ${q(execPath)} ${q(entry)} ${extra}`;
}

/** Guake arguments for the drop-down tab. Pure, so the shape is testable. */
function launchArgs({ cwd = process.cwd(), command, title = 'hakster' } = {}) {
  return ['--show', '--new-tab', String(cwd), '--rename-tab', String(title), '-e', String(command || tabCommand({ cwd }))];
}

module.exports = {
  ASSETS,
  BACKDROP,
  TEMPLATE,
  applyProfile,
  ensureGuake,
  findGuake,
  installHint,
  isSetup,
  launchArgs,
  markerPath,
  readOsRelease,
  renderProfile,
  tabCommand,
  writeMarker,
};
