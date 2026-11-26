/* updater.js — check for a newer CLI while the session runs, stage it, and
 * let the next launch apply it (the update model the owner asked for:
 * "when cli has updates they update in live session then apply after cli
 * restarts").
 *
 * Read-only to the running install: the check downloads the published package
 * to ~/.hakster/updates, verifies its SHA-256, and writes pending.json. The
 * swap happens at the next CLI start, before any of the new code is imported,
 * and never into a source checkout — a git tree is the owner's to move (§8),
 * so a checkout only ever learns that an update is staged.
 *
 * Nothing restarts a service, nothing runs in argv, and no config value is
 * printed. If anything fails the state is reported as 'error' and the running
 * CLI is untouched.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

// The CLI directory is wherever the running copy of this file's own package
// lives. Called directly (cli/index.js, cli/tui-entry.mjs) the caller passes
// __dirname-derived paths; the TUI bundle passes HAKSTER_CLI_DIR, because a
// bundled module's __dirname is the bundle's directory, not cli/src.
//
// Whichever path a session is started by, the directory must be the one that
// holds THIS CLI's package.json — the version it reports is what every update
// answer is compared against. A launch path that resolved to a directory with
// no package.json made the running build read as 0.0.0, so every published
// version looked like an update and the header told the owner to "pull to
// update" on a tree that was already current (2026-11-26). So each candidate is
// checked for a real version before it is used, and a version that still cannot
// be read is reported as unknown — never compared (§10, §44.3).
const DEFAULT_CLI_DIR = process.env.HAKSTER_CLI_DIR || (typeof __dirname === 'string' ? path.join(__dirname, '..') : '');
function hasPkgVersion(dir) {
  const pkg = readJson(path.join(String(dir), 'package.json'), null);
  return !!(pkg && pkg.version);
}
function cliDirOf(explicit) {
  const candidates = [];
  const add = (dir) => {
    if (!dir) return;
    try {
      const abs = path.resolve(String(dir));
      if (!candidates.includes(abs)) candidates.push(abs);
    } catch {
      /* an unusable candidate is simply skipped */
    }
  };
  // A caller that names a directory holding a package.json means it — that is
  // the callers' own install (tests do the same). It is not silently replaced.
  if (explicit) {
    try {
      const named = path.resolve(String(explicit));
      if (fs.existsSync(path.join(named, 'package.json'))) return named;
    } catch {
      /* fall through to the candidates */
    }
  }
  add(explicit);
  add(process.env.HAKSTER_CLI_DIR);
  try { if (typeof __dirname === 'string' && __dirname) add(path.join(__dirname, '..')); } catch { /* ESM bundle */ }
  try {
    if (process.argv[1]) {
      const entry = path.dirname(path.resolve(process.argv[1]));
      add(entry);
      if (path.basename(entry) === 'src') add(path.dirname(entry));
    }
  } catch {
    /* no argv: fall through to the configured directory */
  }
  add(process.cwd());
  for (const dir of candidates) if (hasPkgVersion(dir)) return dir;
  return candidates[0] || path.resolve(process.cwd());
}
/** A version this CLI can actually be compared against. */
function versionKnown(version) {
  const v = String(version || '');
  return !!v && v !== '0.0.0';
}
const UPDATES_DIR = path.join(os.homedir(), '.hakster', 'updates');
const STAGED_DIR = path.join(UPDATES_DIR, 'staged');
const TARBALL = path.join(UPDATES_DIR, 'latest.tar.gz');
const PENDING_FILE = path.join(UPDATES_DIR, 'pending.json');
const MAX_TARBALL = 32 * 1024 * 1024; // a package far past this is not ours

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function sha256File(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return '';
  }
}

/** Which commit this install was built from. The package ships
 *  cli/.build-stamp.json (scripts/cli-build-stamp.cjs), so an installed copy —
 *  which has no .git — can still count how far behind it is. Owner, 2026-11-26:
 *  "i want our cli to say in tui how many commits is behind before installs
 *  like hermes". */
function stampOf(dir) {
  const stamp = readJson(path.join(dir, '.build-stamp.json'), null);
  if (!stamp) return null;
  const commits = parseInt(stamp.commits, 10);
  if (!Number.isFinite(commits) || commits <= 0) return null;
  return { commit: String(stamp.commit || ''), commits };
}

function runningInfo(explicitDir) {
  const dir = cliDirOf(explicitDir);
  const pkg = readJson(path.join(dir, 'package.json'), {});
  const stamp = stampOf(dir);
  return {
    version: String(pkg.version || '0.0.0'),
    bundleSha: sha256File(path.join(dir, 'ui-fb.mjs')),
    commit: stamp ? stamp.commit : '',
    commits: stamp ? stamp.commits : null,
    dir,
  };
}

function isSourceCheckout(explicitDir) {
  return fs.existsSync(path.join(cliDirOf(explicitDir), '..', '.git'));
}

function serverUrl() {
  const cfg = readJson(path.join(os.homedir(), '.hakster', 'config.json'), {});
  return String(cfg.server || process.env.HAKSTER_SERVER || '').replace(/\/+$/, '');
}

/** Semantic-ish compare: -1 / 0 / 1. Unparseable versions compare equal and
 *  the bundle hash decides instead. */
function cmpVersion(a, b) {
  const pa = String(a || '').split(/[.+-]/).map((n) => parseInt(n, 10)).filter((n) => Number.isFinite(n));
  const pb = String(b || '').split(/[.+-]/).map((n) => parseInt(n, 10)).filter((n) => Number.isFinite(n));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

async function fetchJson(url, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { accept: 'application/json', 'x-hakster-client': 'cli' },
    });
    const type = String(res.headers.get('content-type') || '');
    if (!res.ok || !type.includes('json')) return null; // 404 or the SPA page: no endpoint yet
    const body = await res.json();
    return body && typeof body === 'object' ? body : null;
  } finally {
    clearTimeout(timer);
  }
}

async function downloadTarball(url, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/gzip', 'x-hakster-client': 'cli' } });
    if (!res.ok) return { ok: false, reason: `http ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return { ok: false, reason: 'empty package' };
    if (buf.length > MAX_TARBALL) return { ok: false, reason: 'package too large' };
    fs.mkdirSync(UPDATES_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(TARBALL, buf, { mode: 0o600 });
    return { ok: true, bytes: buf.length };
  } catch (e) {
    return { ok: false, reason: e && e.name === 'AbortError' ? 'timeout' : String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}

function extractStaged() {
  fs.mkdirSync(STAGED_DIR, { recursive: true, mode: 0o700 });
  // Untarring over the tree an earlier check left behind keeps the files the new
  // package no longer ships, so the directory stops describing exactly one
  // package — and the record then names a bundle hash that is not what is on
  // disk, which reads as a corrupt download. Owner, 2026-11-26: the Dell's
  // "update not applied · staged pkg failed verification", on a stage that was
  // fine. The stage is rebuilt from this tarball alone; only the extracted tree
  // is removed, never the tarball or pending.json, which are the record of the
  // last check (§4: nothing else is touched).
  try {
    fs.rmSync(path.join(STAGED_DIR, 'cli'), { recursive: true, force: true });
  } catch { /* an unclearable tree is still caught by the hash check below */ }
  return new Promise((resolve) => {
    const tar = spawn('tar', ['-xzf', TARBALL, '-C', STAGED_DIR], { stdio: 'ignore' });
    tar.on('error', (e) => resolve({ ok: false, reason: String(e.message || e) }));
    tar.on('close', (code) => resolve(code === 0 ? { ok: true } : { ok: false, reason: `tar exited ${code}` }));
  });
}

function stagedInfo() {
  const pkg = readJson(path.join(STAGED_DIR, 'cli', 'package.json'), {});
  return {
    version: String(pkg.version || ''),
    bundleSha: sha256File(path.join(STAGED_DIR, 'cli', 'ui-fb.mjs')),
    deps: JSON.stringify((pkg && pkg.dependencies) || {}),
  };
}

function sameDeps(installedDeps, stagedDeps) {
  const norm = (obj) => {
    const out = {};
    for (const key of Object.keys(obj || {}).sort()) out[key] = String(obj[key]);
    return JSON.stringify(out);
  };
  return norm(JSON.parse(installedDeps || '{}')) === norm(JSON.parse(stagedDeps || '{}'));
}

/**
 * Check the configured server for a newer CLI. Never throws: every failure is
 * a state the panel can show. Resolves to
 *   { status: 'current' | 'staged' | 'blocked' | 'unknown' | 'error', ... }
 */
async function checkForUpdate(opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) || 8000;
  const running = runningInfo(opts.cliDir);
  const origin = opts.server || serverUrl();
  if (!origin) return { status: 'unknown', reason: 'no server configured', checkedAt: new Date().toISOString(), running };
  // Without this CLI's own version there is nothing truthful to compare: every
  // published release would read as "newer than 0.0.0" and stage itself. That is
  // how the Dell's header came to say "v0.3.68 · pull to update" on a tree that
  // was already v0.3.68 (owner, 2026-11-26). Report unknown, stage nothing and
  // leave the record alone (§10, §13, §44.3).
  if (!versionKnown(running.version)) {
    return { status: 'unknown', reason: 'cannot read this install’s package.json', checkedAt: new Date().toISOString(), running };
  }

  // 1. Cheap path: an endpoint that reports the published version without a
  // download. It is absent until the server next restarts, so a null answer
  // falls through to the package itself.
  const latest = await fetchJson(`${origin}/cli/latest.json`, timeoutMs).catch(() => null);
  if (latest && latest.version) {
    const version = String(latest.version);
    const bundleSha = String(latest.bundleSha256 || '');
    const upToDate = cmpVersion(version, running.version) === 0 && (!bundleSha || bundleSha === running.bundleSha);
    if (upToDate) {
      const pending = readJson(PENDING_FILE, null);
      if (pending && !pending.appliedAt && pending.state !== 'current') {
        writeJson(PENDING_FILE, { ...pending, verifiedAt: new Date().toISOString(), state: 'current', blocked: null });
      }
      return { status: 'current', version, checkedAt: new Date().toISOString(), running };
    }
  }

  // 2. Download the published package and inspect it. Only a differing bundle
  // is kept as a staged update; on a match the download is left in place (0.3
  // MB, overwritten by the next check — nothing is deleted).
  const dl = await downloadTarball(`${origin}/cli/pkg.tar.gz`, timeoutMs);
  if (!dl.ok) return { status: 'error', reason: dl.reason, checkedAt: new Date().toISOString(), running };
  const ex = await extractStaged();
  if (!ex.ok) return { status: 'error', reason: ex.reason, checkedAt: new Date().toISOString(), running };
  const staged = stagedInfo();
  if (!staged.version || !staged.bundleSha) {
    return { status: 'error', reason: 'staged package unreadable', checkedAt: new Date().toISOString(), running };
  }
  // How far behind the published build this install is, in commits. The staged
  // package carries its own stamp, so this describes exactly what was
  // downloaded; the endpoint's count (git on the primary) is the fallback for a
  // package built before the stamp existed. Unknown on either side reads null,
  // never a guessed number (§10).
  const stagedStamp = stampOf(path.join(STAGED_DIR, 'cli'));
  const latestCommit = (stagedStamp && stagedStamp.commit)
    || (latest && latest.commit ? String(latest.commit) : '');
  const latestCommits = (stagedStamp && stagedStamp.commits)
    || (latest && Number.isFinite(parseInt(latest.commits, 10)) ? parseInt(latest.commits, 10) : null);
  const behind = Number.isFinite(running.commits) && Number.isFinite(latestCommits) && latestCommits > running.commits
    ? latestCommits - running.commits
    : 0;
  const upToDate = cmpVersion(staged.version, running.version) === 0 && staged.bundleSha === running.bundleSha;
  if (upToDate) {
    // A stage left by an earlier check is marked current, not deleted: the
    // file is the record of the last check.
    const pending = readJson(PENDING_FILE, null);
    if (pending && pending.version === staged.version && pending.bundleSha === staged.bundleSha && !pending.appliedAt) {
      writeJson(PENDING_FILE, { ...pending, verifiedAt: new Date().toISOString(), state: 'current', blocked: null });
    }
    return { status: 'current', version: staged.version, checkedAt: new Date().toISOString(), running };
  }

  // Same version with a different bundle is a newer build of it (§28.2 keys the
  // release on the version AND the hash); anything OLDER than what is installed
  // is not an update at all. Without this, running an unreleased local build
  // would "stage" the published package as a downgrade on every check.
  const cmp = cmpVersion(staged.version, running.version);
  const isNewer = cmp > 0 || (cmp === 0 && staged.bundleSha !== running.bundleSha);
  if (!isNewer) {
    const prev = readJson(PENDING_FILE, null);
    if (!(prev && prev.appliedAt)) {
      writeJson(PENDING_FILE, {
        version: staged.version,
        bundleSha: staged.bundleSha,
        checkedAt: new Date().toISOString(),
        state: 'current',
        runningVersion: running.version,
      });
    }
    return { status: 'current', version: running.version, checkedAt: new Date().toISOString(), running };
  }

  const blocked = isSourceCheckout(opts.cliDir) ? 'source-checkout' : null;
  const pending = {
    version: staged.version,
    bundleSha: staged.bundleSha,
    stagedAt: new Date().toISOString(),
    verifiedAt: new Date().toISOString(),
    runningVersion: running.version,
    latestCommit,
    latestCommits,
    behind,
    source: origin,
    dir: path.join(STAGED_DIR, 'cli'),
    state: blocked ? 'blocked' : 'staged',
    blocked,
  };
  writeJson(PENDING_FILE, pending);
  return { status: blocked ? 'blocked' : 'staged', reason: blocked || undefined, ...pending, checkedAt: pending.stagedAt, running };
}

/** A pending record describes the build this CLI is already running. */
function sameBuild(pending, running) {
  if (!pending || !running) return false;
  if (String(pending.version || '') !== String(running.version || '')) return false;
  return !pending.bundleSha || pending.bundleSha === running.bundleSha;
}

/** What a previous session left ready, without touching anything.
 *
 *  `isCurrent` is the honest answer to "is this the build I'm on?" — a stage
 *  whose version AND bundle hash match the running install is not an update
 *  waiting to apply, it is this CLI. The startup screens use it so they never
 *  announce a restart that would change nothing. */
function pendingInfo(explicitDir) {
  const pending = readJson(PENDING_FILE, null);
  if (!pending || !pending.version) return null;
  const ok = !!pending.bundleSha && sha256File(path.join(STAGED_DIR, 'cli', 'ui-fb.mjs')) === pending.bundleSha;
  const running = runningInfo(explicitDir);
  // A stage from an OLDER version is not an update: it is the leftover record of
  // a check taken before this install was upgraded. Reporting it as staged would
  // announce a downgrade and offer to install one on the next start.
  // A record taken from an unreadable install (runningVersion 0.0.0) describes
  // no update at all — it is the same 0.0.0 mistake as checkForUpdate's, and the
  // startup screens must not paint a badge from it (§10, §44.3).
  const runningKnown = versionKnown(running.version);
  return {
    ...pending,
    verified: ok,
    isCurrent: sameBuild(pending, running),
    superseded: runningKnown && cmpVersion(pending.version, running.version) < 0,
    runningVersion: running.version,
    unknown: !runningKnown,
  };
}

/**
 * The "an update was installed on an earlier start" record, if there is one.
 *
 * Owner, 2026-11-24: "need our updates to show when updates have been installed
 * upon starting cli". applyPending() writes appliedAt/appliedOver into
 * pending.json; the TUI reads it here and says so on the start screen. It only
 * reports while the installed version is still the one running (a later release
 * supersedes it) and within the freshness window, so a months-old install is
 * not announced as news.
 */
const APPLIED_NOTICE_MS = 24 * 60 * 60 * 1000; // show it for the first day after install
function appliedNotice(explicitDir, maxAgeMs) {
  const pending = readJson(PENDING_FILE, null);
  if (!pending || !pending.appliedAt || !pending.appliedOver) return null;
  const at = Date.parse(pending.appliedAt);
  if (!Number.isFinite(at)) return null;
  if (Date.now() - at > (Number(maxAgeMs) || APPLIED_NOTICE_MS)) return null;
  if (!sameBuild(pending, runningInfo(explicitDir))) return null; // superseded by a newer release
  return {
    version: String(pending.version || ''),
    from: String(pending.appliedOver || ''),
    appliedAt: pending.appliedAt,
    backupDir: pending.backupDir || '',
  };
}

/**
 * Apply a staged update at process start, before the new code is loaded.
 * Only a verified stage is applied, and never into a source checkout; if the
 * staged package changes dependencies the update is left for `npm install`.
 */
function applyPending(explicitDir) {
  // The record is judged against the same directory it would be copied into:
  // "is this stage newer than the install?" is a question about that install.
  const pending = pendingInfo(explicitDir);
  if (!pending) return null;
  const target = cliDirOf(explicitDir);
  // Copying files needs to know what it is upgrading. With no readable version
  // the "target" could be any directory this process happened to be started
  // from, so nothing is written (§2.1, §8).
  if (pending.unknown) return { applied: false, reason: 'cannot read this install’s package.json', version: pending.version };
  if (pending.appliedAt) return { applied: false, reason: 'already applied', version: pending.version };
  // "Is this even an update?" is answered without hashing anything, and it comes
  // first: a stage the running install already supersedes, and a source checkout
  // that never installs anything (§43.4), are both refusals for reasons that have
  // nothing to do with the download's integrity. Deciding them before the hash
  // check is what stops a stale record on a checkout from being reported as
  // "staged package failed verification" — a stage that was never going to be
  // applied, on a tree that was never going to receive it (owner, 2026-11-26).
  if (pending.superseded) {
    writeJson(PENDING_FILE, { ...pending, state: 'superseded', supersededAt: new Date().toISOString() });
    return {
      applied: false,
      reason: `superseded by the running v${runningInfo(target).version}`,
      version: pending.version,
      superseded: true,
    };
  }
  const running = runningInfo(target);
  if (sameBuild(pending, running)) {
    // The stage is this very build — nothing was installed, so it must not
    // leave an appliedAt behind (that record is the "update was installed"
    // notice, and a false one would be a lie on the next start screen).
    // Answered before the checkout and hash refusals: a record describing the
    // running build is not a downgrade to announce and not a download to
    // distrust, on a checkout or anywhere else (§10).
    writeJson(PENDING_FILE, { ...pending, matchedAt: new Date().toISOString(), state: 'current' });
    return { applied: false, reason: 'current', version: pending.version };
  }
  if (isSourceCheckout(target)) return { applied: false, reason: 'source-checkout', version: pending.version };
  if (!pending.verified) return { applied: false, reason: 'staged package failed verification', version: pending.version };
  const installedDeps = readJson(path.join(target, 'package.json'), {}).dependencies || {};
  const staged = stagedInfo();
  if (!sameDeps(JSON.stringify(installedDeps), staged.deps)) {
    return { applied: false, reason: 'dependencies changed — run npm install for the new version', version: pending.version };
  }

  // Keep a copy of every file about to be replaced (§4/§5: never lose the last
  // good copy). The backup sits beside the stage, named for the version it
  // replaced.
  const backupDir = path.join(UPDATES_DIR, `backup-${running.version}-${Date.now()}`);
  const stagedCli = path.join(STAGED_DIR, 'cli');
  try {
    fs.cpSync(stagedCli, backupDir, {
      recursive: true,
      filter: (src) => !src.includes(`${path.sep}node_modules`) && !src.includes(`${path.sep}.git`),
    });
    fs.cpSync(stagedCli, target, {
      recursive: true,
      force: true,
      filter: (src) => !src.includes(`${path.sep}node_modules`) && !src.includes(`${path.sep}.git`),
    });
  } catch (e) {
    return { applied: false, reason: `copy failed: ${(e && e.message) || e}`, version: pending.version, backupDir };
  }
  writeJson(PENDING_FILE, {
    ...pending,
    appliedAt: new Date().toISOString(),
    state: 'applied',
    appliedFrom: pending.version,
    appliedOver: running.version,
    backupDir,
  });
  return { applied: true, version: pending.version, from: running.version, backupDir };
}

/**
 * The startup choice (owner, 2026-11-23: "it says install now or wait til next
 * one option on startup if update available").
 *
 * A staged, hash-verified package means the update is already on disk; the only
 * question is whether THIS session starts on it. Answering 'install' swaps it in
 * before the bundle is imported, so the session that opens is the new CLI.
 * Answering 'wait' leaves the running install untouched and the stage in place —
 * the next start asks again. A non-interactive start keeps the old behaviour
 * (apply what was verified) because there is nobody to ask.
 *
 * Resolves to { action: 'none'|'current'|'blocked'|'auto'|'install'|'wait', pending, running }.
 * It never applies anything itself and never prints a secret.
 */
async function promptStagedUpdate(opts = {}) {
  const pending = pendingInfo();
  if (!pending || !pending.version) return { action: 'none' };
  if (pending.appliedAt) return { action: 'none', pending };
  const running = runningInfo(opts.cliDir);
  if (sameBuild(pending, running)) {
    return { action: 'current', pending, running };
  }
  if (pending.superseded) return { action: 'none', pending, running };
  if (isSourceCheckout(opts.cliDir)) return { action: 'blocked', pending, running };

  // Claude-Code behaviour (owner, 2026-11-26: "need ours auto like claude does
  // says update installed restart cli"). A stage is already downloaded and
  // hash-verified; the only question left was "install now or next time", and
  // the answer is now — so a start applies it without asking. The old [i/w]
  // prompt stays available behind HAKSTER_UPDATE_PROMPT=ask for anyone who
  // wants to choose. Never reached on a source checkout (refused above, §8).
  if (String(process.env.HAKSTER_UPDATE_PROMPT || '').toLowerCase() !== 'ask') {
    return { action: 'auto', pending, running };
  }

  const stdin = process.stdin;
  const stdout = process.stdout;
  const tty = !!(stdin && stdin.isTTY && stdout && stdout.isTTY);
  if (!tty || process.env.HAKSTER_NO_UPDATE_PROMPT) {
    return { action: 'auto', pending, running };
  }

  const mark = (state) => {
    try {
      writeJson(PENDING_FILE, { ...pending, deferredAt: state === 'wait' ? new Date().toISOString() : pending.deferredAt || null, promptState: state });
    } catch { /* the prompt is a convenience; never let bookkeeping stop the CLI */ }
  };

  stdout.write(`\n⬆ CLI v${pending.version} is ready — this session is on v${running.version}.\n`);
  stdout.write('  [i] Install now  · this session runs the new CLI\n');
  stdout.write('  [w] Wait until next one  · keep the current version for now\n');
  stdout.write('Choice [i/w]: ');

  const answer = await readChoice(opts.timeoutMs || 20000);
  stdout.write('\n');
  const k = String(answer || '').trim().toLowerCase();
  if (k === 'i' || k === 'y' || k === '1' || k === '\r' || k === '\n') {
    mark('install');
    return { action: 'install', pending, running };
  }
  mark('wait');
  return { action: 'wait', pending, running };
}

/** One keypress from a raw TTY, or '' when the timer wins. Restores the terminal
 *  before the renderer takes it over. */
function readChoice(timeoutMs) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { stdin.removeListener('data', onData); } catch { /* closed */ }
      try { stdin.setRawMode(false); } catch { /* not a tty */ }
      try { stdin.pause(); } catch { /* already paused */ }
      resolve(value);
    };
    const onData = (buf) => {
      const text = buf.toString('utf8');
      // Enter arrives as \r; treat it as the typed key's confirmation.
      if (text === '\r' || text === '\n') finish('\r');
      else finish(text);
    };
    const timer = setTimeout(() => finish(''), Math.max(1000, Number(timeoutMs) || 20000));
    try { stdin.setRawMode(true); } catch { /* not a tty */ }
    stdin.resume();
    stdin.on('data', onData);
  });
}

module.exports = {
  checkForUpdate,
  applyPending,
  extractStaged,
  appliedNotice,
  pendingInfo,
  promptStagedUpdate,
  runningInfo,
  isSourceCheckout,
  cliDirOf,
  UPDATES_DIR,
  PENDING_FILE,
};
