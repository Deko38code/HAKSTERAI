/* runtime-paths.js — where a runtime can live, and how to find one.
 *
 * Owner, 2026-11-25: "so can we add node to it so evething whats needed to run
 * come plug and play" / "like make the install xheck if users have whats needed
 * if not install". The installer (`install.sh` at the repo root) brings Node and
 * Bun into ~/.hakster/runtime when a machine has none — so anything the CLI
 * spawns must look in that runtime as well as on PATH.
 *
 * Nothing here installs, writes or changes a PATH entry. It only answers
 * "where is this executable?", preferring what the machine already has (§2:
 * never move or replace a working tool).
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { homeDir, haksterDir } = require('./home-dir');

/** Where our installer puts the runtimes it had to bring. */
function runtimeRoot(env = process.env) {
  const override = String(env.HAKSTER_RUNTIME || '').trim();
  return override ? path.resolve(override) : path.join(haksterDir(), 'runtime');
}

function isExecutableFile(file) {
  try {
    const st = fs.statSync(file); // follows the symlink npm writes in .bin/
    if (!st.isFile()) return false;
    // Windows shims (.cmd/.bat) are plain text and carry no exec bits.
    if (process.platform === 'win32') return true;
    return (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function names(bin, platform = process.platform) {
  return platform === 'win32' ? [`${bin}.exe`, `${bin}.cmd`, `${bin}.bat`, bin] : [bin];
}

/** `bin` on PATH, or null. Does not execute it. */
function findOnPath(bin, env = process.env) {
  for (const dir of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const name of names(bin)) {
      const full = path.join(dir, name);
      if (isExecutableFile(full)) return full;
    }
  }
  return null;
}

/**
 * Where Bun's own installers write on Windows.
 *
 * Owner, 2026-11-26 (Surface Pro): `hakster` opened the OLD Ink screen — input
 * bar, no grids, no logo — because this function only looked at PATH and our
 * own runtime folder. Bun was installed somewhere else on that machine, so the
 * paid dashboard was skipped in silence. PATH in a PowerShell session is often
 * stale after a fresh install, so these are checked directly, most likely
 * first. Read-only: nothing here installs, moves or edits anything.
 */
function wellKnownBun(env = process.env, platform = process.platform) {
  if (platform !== 'win32') return [];
  const home = homeDir();
  const localAppData = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const programFiles = env.ProgramFiles || 'C:\\Program Files';
  const dirs = [
    path.join(home, '.bun', 'bin'), // bun.sh/install.ps1 (the official one)
    path.join(localAppData, 'Programs', 'bun'), // newer installer / winget
    path.join(home, 'scoop', 'shims'), // scoop
    path.join(appData, 'npm'), // npm install -g bun
    path.join(programFiles, 'Bun'),
  ];
  const out = [];
  for (const dir of dirs) {
    for (const name of names('bun', platform)) out.push(path.join(dir, name));
  }
  return out;
}

/**
 * Every Bun this machine could run, in the order they should be tried: PATH,
 * then the one our installer brought, then the Windows locations its own
 * installers write to. Answers paths only — never installs or runs anything
 * (§11: no auto-changes).
 */
function bunCandidates(env = process.env) {
  const out = [];
  const add = (p) => { if (p && !out.includes(p)) out.push(p); };

  add(findOnPath('bun', env));

  const root = runtimeRoot(env);
  // The bun package ships the real executable here on every platform (it is
  // named bun.exe even on Linux); on Windows this is preferred over npm's .cmd
  // shim, which needs a shell to start.
  for (const name of names('bun')) add(path.join(root, 'bun', 'node_modules', 'bun', 'bin', name));
  // install.sh / install.ps1: npm install --prefix <root>/bun bun@<version>
  for (const name of names('bun')) add(path.join(root, 'bun', 'node_modules', '.bin', name));
  // A bootstrapped Node tree can also carry one; checked newest-first.
  let dirs = [];
  try { dirs = fs.readdirSync(root).filter((d) => d.startsWith('node-')).sort().reverse(); } catch { /* none */ }
  for (const d of dirs) {
    for (const name of names('bun')) add(path.join(root, d, 'bin', name));
  }
  // Windows installers that PATH may not reflect in this session (see
  // wellKnownBun). Last, so a working PATH or our own runtime always wins.
  for (const candidate of wellKnownBun(env)) add(candidate);

  return out.filter((p) => isExecutableFile(p));
}

/** Bun: the first place it can live. Returns a path or null. */
function findBun(env = process.env) {
  const found = bunCandidates(env);
  return found.length ? found[0] : null;
}

/**
 * `[major, minor, patch]` from `bun --version`, or null when it cannot answer.
 *
 * Being installed is not the same as being usable: the dashboard's renderer
 * (@opentui/core 0.9.x) declares `bun >= 1.3.14`, and an older Bun loads the
 * bundle and then dies inside the native library. A .cmd/.bat shim (Windows
 * npm) only starts through a shell, so that case is run through one.
 */
function bunVersion(file, opts = {}) {
  const { spawnSync } = require('child_process');
  const timeout = opts.timeoutMs === undefined ? 5000 : opts.timeoutMs;
  try {
    const shim = /\.(cmd|bat)$/i.test(String(file || ''));
    const common = { encoding: 'utf8', timeout, windowsHide: true };
    const r = shim
      ? spawnSync(`"${file}" --version`, { ...common, shell: true })
      : spawnSync(file, ['--version'], common);
    const m = String((r && r.stdout) || '').trim().match(/(\d+)\.(\d+)\.(\d+)/);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  } catch { return null; }
}

/** `v` is at least `min`, component by component. */
function atLeast(v, min) {
  for (let i = 0; i < min.length; i += 1) {
    if (v[i] !== min[i]) return v[i] > min[i];
  }
  return true;
}

/**
 * The first Bun that can actually run the dashboard's renderer.
 *
 * The machine's own Bun is tried first — but an OLD one must not shadow a
 * supported one our own installer brought. That is exactly what happened on a
 * Windows box with an early Bun still on PATH: the installer said "Bun is
 * already here", the launcher refused that Bun for being below the renderer's
 * floor, and the paid dashboard was replaced by the input-only Ink screen while
 * every step reported success (Surface Pro, 2026-11-26). So every candidate is
 * measured and the unusable ones are skipped, with what was skipped reported.
 *
 * Returns { path, version, skipped }. `path` is null when nothing usable exists;
 * `skipped` holds the Buns that were found and refused, for an honest message.
 */
function findSupportedBun(min, env = process.env, opts = {}) {
  const skipped = [];
  let unmeasurable = null;
  for (const candidate of bunCandidates(env)) {
    const v = bunVersion(candidate, opts);
    if (!v) {
      // A shim that will not answer --version cannot start the TUI either, but
      // it is kept as a last resort rather than claimed usable up front.
      if (!unmeasurable) unmeasurable = { path: candidate, version: null };
      continue;
    }
    if (!atLeast(v, min)) { skipped.push({ path: candidate, version: v }); continue; }
    return { path: candidate, version: v, skipped };
  }
  if (unmeasurable) return { path: unmeasurable.path, version: null, skipped };
  return { path: null, version: null, skipped };
}

/** Node: PATH first, then the installer's runtime. Returns a path or null. */
function findNode(env = process.env) {
  const onPath = findOnPath('node', env);
  if (onPath) return onPath;
  const root = runtimeRoot(env);
  let dirs = [];
  try { dirs = fs.readdirSync(root).filter((d) => d.startsWith('node-')).sort().reverse(); } catch { /* none */ }
  for (const d of dirs) {
    for (const name of names('node')) {
      const full = path.join(root, d, 'bin', name);
      if (isExecutableFile(full)) return full;
    }
  }
  return null;
}

module.exports = {
  runtimeRoot, findOnPath, findBun, findNode, isExecutableFile, wellKnownBun,
  bunCandidates, bunVersion, findSupportedBun, atLeast,
};
