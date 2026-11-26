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

/**
 * The directory a package actually resolves from, as the loader sees it.
 *
 * `@opentui/core` imports its platform renderer (`@opentui/core-<os>-<arch>`)
 * from ITS OWN location, not from the launcher's. A global npm install can put
 * core under `<prefix>/lib/node_modules/hakster-cli/node_modules` or flat under
 * `<prefix>/node_modules`, and a package present in one tree is invisible from
 * the other. A check that only looks from the launcher's own directory reports
 * "installed" for a renderer the core cannot load — and the dashboard then dies
 * the instant it opens, with every check above it reporting success. So the
 * search starts where core lives and walks up exactly as Node/Bun do, then falls
 * back to the launcher's own paths.
 */
function packageDir(name, env = process.env, opts = {}) {
  // opts.paths lets a test answer the question for a tree the running process is
  // not inside; production always uses the real loader's list.
  const searchPaths = (n) => {
    if (typeof opts.paths === 'function') return opts.paths(n) || [];
    try { return require.resolve.paths(n) || []; } catch { return []; }
  };
  const paths = searchPaths('@opentui/core');
  const roots = [];
  let coreRoot = null;
  for (const dir of paths) {
    if (fs.existsSync(path.join(dir, '@opentui', 'core', 'package.json'))) { coreRoot = dir; break; }
  }
  if (coreRoot) {
    roots.push(coreRoot);
    let at = coreRoot;
    for (let i = 0; i < 6; i += 1) {
      const next = path.dirname(at.replace(/[\\/]node_modules$/, ''));
      if (!next || next === at) break;
      at = next;
      roots.push(path.join(at, 'node_modules'));
    }
  }
  for (const dir of searchPaths(name)) roots.push(dir);
  const seen = new Set();
  for (const dir of roots) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    if (fs.existsSync(path.join(dir, name, 'package.json'))) return path.join(dir, name);
  }
  return null;
}

/**
 * The native renderer library this OS/CPU needs, and where it actually is.
 *
 * `@opentui/core` finds it by importing `@opentui/core-<os>-<arch>` from its own
 * directory, which is the one thing a global npm install can place differently
 * from what any path check here assumes. The library file itself is always
 * `<package>/libopentui.so` (darwin: `.dylib`, win32: `opentui.dll`) and the
 * package's own `index.bun.js` imports exactly that file, so the name is read
 * from there and only defaulted when it cannot be read.
 *
 * The launcher passes this back as OPENTUI_LIB_PATH, which the core honours
 * before any resolution — so a renderer that is on disk but in another
 * node_modules tree loads anyway. Nothing is installed, moved or edited (§11).
 */
function nativeLibrary(platform = process.platform, arch = process.arch, env = process.env) {
  const libName = { linux: 'libopentui.so', darwin: 'libopentui.dylib', win32: 'opentui.dll' }[platform] || '';
  // Mirrors the core's own choice: glibc unless OPENTUI_LIBC says musl.
  const names = platform === 'linux'
    ? (String(env.OPENTUI_LIBC || '') === 'musl'
      ? [`@opentui/core-linux-${arch}-musl`, `@opentui/core-linux-${arch}`]
      : [`@opentui/core-linux-${arch}`, `@opentui/core-linux-${arch}-musl`])
    : [`@opentui/core-${platform}-${arch}`];
  for (const name of names) {
    const dir = packageDir(name, env);
    if (!dir) continue;
    let file = '';
    try {
      const entry = fs.readFileSync(path.join(dir, 'index.bun.js'), 'utf8');
      const m = entry.match(/import\(\s*["']\.\/([^"']+)["']/);
      if (m) file = path.join(dir, m[1]);
    } catch { /* no entry file: use the platform default name */ }
    if (!file && libName) file = path.join(dir, libName);
    if (file && fs.existsSync(file)) return { package: name, dir, file };
  }
  return null;
}

/**
 * Does the dashboard bundle actually load under this Bun?
 *
 * The launcher can check files all day; only the chosen Bun knows whether the
 * bundle and its native renderer load. This runs the import the TUI itself runs
 * — the bundle, not a renderer — so a crash is answered with a real reason
 * instead of "it exited" (§10, §13, §50.1). Bounded, read-only, no installs.
 *
 * Returns { ok, reason }. ok is true when the bundle imported, false when the
 * Bun named a reason, and null when nothing could be measured.
 */
function probeBundle(bunPath, cliDir, opts = {}) {
  const { spawnSync } = require('child_process');
  const timeout = opts.timeoutMs === undefined ? 20000 : opts.timeoutMs;
  const script = "try{await import('./ui-fb.mjs');console.log('HAKSTER_PROBE_OK')}"
    + "catch(e){console.error(String((e&&e.message)||e));process.exit(3)}";
  const shim = /\.(cmd|bat)$/i.test(String(bunPath || ''));
  const common = { cwd: cliDir, encoding: 'utf8', timeout, windowsHide: true, env: opts.env || process.env };
  try {
    const r = shim
      ? spawnSync(`"${bunPath}" -e "${script}"`, { ...common, shell: true })
      : spawnSync(bunPath, ['-e', script], common);
    if (r && r.status === 0 && String(r.stdout || '').includes('HAKSTER_PROBE_OK')) return { ok: true, reason: '' };
    const line = String((r && (r.stderr || r.stdout)) || '').trim()
      .split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-3).join(' | ');
    return { ok: false, reason: line || `the probe exited ${r && r.status}` };
  } catch (err) {
    return { ok: false, reason: String((err && err.message) || err) };
  }
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
  bunCandidates, bunVersion, findSupportedBun, atLeast, packageDir, probeBundle, nativeLibrary,
};
