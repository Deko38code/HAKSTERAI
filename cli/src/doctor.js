/* doctor.js — one block that answers "why is the dashboard not opening?".
 *
 * Owner, 2026-11-26 (Surface Pro): the paid CLI opened with an input bar and no
 * grids, and every command along the way had reported success. The pieces that
 * decide it live in five different places — the Bun locator, the Bun version
 * floor the renderer declares, the optional @opentui platform package, the
 * launcher's lane choice, and the server it dials — so a paid operator had no
 * way to see which one had failed.
 *
 * Read-only by construction: this measures what is on disk and what answers
 * --version, and it prints the lane the launcher will take with the reason for
 * it. It never installs, moves, edits or starts anything (§11, §49).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { haksterDir } = require('./home-dir');
const rp = require('./runtime-paths');

const CLI_DIR = path.resolve(__dirname, '..');

/** The Bun floor the dashboard's renderer declares, read from the launcher. */
function minBun() {
  try {
    const src = fs.readFileSync(path.join(CLI_DIR, 'index.js'), 'utf8');
    const m = src.match(/const MIN_BUN = \[(\d+),\s*(\d+),\s*(\d+)\]/);
    if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  } catch { /* fall through to the renderer's own declaration */ }
  return [1, 3, 14];
}

/** `[major, minor, patch]` from a package's engines.bun, or null. */
function rendererBunFloor() {
  try {
    // Where core actually lives, not where this file assumes it lives: a global
    // install nests it under the app or puts it flat in the prefix (§ packageDir).
    const coreDir = rp.packageDir('@opentui/core') || path.join(CLI_DIR, 'node_modules', '@opentui', 'core');
    const pkg = JSON.parse(fs.readFileSync(path.join(coreDir, 'package.json'), 'utf8'));
    const m = String((pkg.engines && pkg.engines.bun) || '').match(/(\d+)\.(\d+)\.(\d+)/);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  } catch { return null; }
}

/** An installed package's version, found the way the renderer finds it. */
function installedVersion(name) {
  const dir = rp.packageDir(name);
  if (!dir) return '';
  try { return String(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version || ''); } catch { return ''; }
}

/** The per-platform renderer package for this OS/CPU, if it is installed. */
function rendererState() {
  const names = process.platform === 'linux'
    ? [`@opentui/core-linux-${process.arch}-musl`, `@opentui/core-linux-${process.arch}`]
    : [`@opentui/core-${process.platform}-${process.arch}`];
  const core = installedVersion('@opentui/core');
  if (!core) return { core: '', pkg: '', have: '', ok: false, why: 'the OpenTUI runtime is not installed with this copy' };
  for (const name of names) {
    const v = installedVersion(name);
    if (!v) continue;
    if (v === core) return { core, pkg: name, have: v, ok: true, why: '' };
    return { core, pkg: name, have: v, ok: false, why: `${name} is ${v} but @opentui/core is ${core}` };
  }
  return { core, pkg: names[0], have: '', ok: false, why: `${names[0]} is not installed (npm skipped the optional package)` };
}

/** npm as this machine can actually run it, or '' when it cannot. */
function npmVersion() {
  const shim = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  try {
    const r = spawnSync(shim, ['--version'], { encoding: 'utf8', timeout: 15000, windowsHide: true, shell: process.platform === 'win32' });
    const v = String((r && r.stdout) || '').trim();
    if (/^\d+\.\d+\./.test(v)) return v.split(/\r?\n/)[0];
  } catch { /* not runnable */ }
  return '';
}

/** The dashboard lane the launcher will take, and why. */
function lane() {
  const floor = minBun();
  const pick = rp.findSupportedBun(floor);
  const renderer = rendererState();
  if (!renderer.ok) {
    return { lane: 'ink', why: `${renderer.why} — fix: cd "${CLI_DIR}" && npm install --no-save --no-package-lock ${renderer.pkg}${renderer.core ? '@' + renderer.core : ''}` };
  }
  if (!pick.path) {
    const stale = (pick.skipped || [])[0];
    return {
      lane: 'ink',
      why: stale
        ? `Bun ${stale.version.join('.')} (${stale.path}) is older than the dashboard's ${floor.join('.')} — re-run the installer, or install Bun from bun.sh`
        : 'no Bun was found — re-run the installer, or install Bun from bun.sh',
    };
  }
  const v = pick.version ? pick.version.join('.') : 'version unknown';
  const skipped = (pick.skipped || []).map((s) => `${s.path} (${s.version.join('.')}, too old)`);
  return { lane: 'dashboard', why: `Bun ${v} at ${pick.path}`, skipped };
}

function configState() {
  const file = path.join(haksterDir(), 'config.json');
  try {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      file,
      server: String(cfg.server || ''),
      // Never the value: whether a key is held is the only fact printed (§9, §23).
      signedIn: Boolean(cfg.apiKey),
    };
  } catch {
    return { file, server: '', signedIn: false };
  }
}

/** The last few lines the launcher wrote about the dashboard lane. */
function lastLog(n = 4) {
  const file = path.join(haksterDir(), 'logs', 'dashboard-tui.log');
  try {
    const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean);
    return { file, lines: lines.slice(-n) };
  } catch { return { file, lines: [] }; }
}

/**
 * Every line this machine can answer, in the order they matter.
 * Returns strings; the caller decides how to colour them.
 */
function report(env = process.env) {
  const out = [];
  let version = '';
  try { version = String(require('../package.json').version); } catch { /* unknown */ }
  const floor = minBun();
  const declared = rendererBunFloor();

  out.push(`hakster doctor  v${version || '?'}`);
  out.push(`platform      ${process.platform} ${process.arch}  ·  node ${process.version}`);
  out.push(`install dir   ${CLI_DIR}`);
  out.push(`HAKSTER_HOME  ${env.HAKSTER_HOME || '(not set — resolved from the profile)'}`);
  out.push(`our folder    ${haksterDir()}`);
  const npm = npmVersion();
  out.push(`npm           ${npm || 'did not answer --version'}`);

  const pick = rp.findSupportedBun(floor);
  const cands = rp.bunCandidates();
  if (!cands.length) {
    out.push(`bun           none found`);
  } else {
    for (const cand of cands) {
      const v = rp.bunVersion(cand);
      const verdict = !v ? 'did not answer --version'
        : rp.atLeast(v, floor) ? 'OK' : `too old for the dashboard (needs ${floor.join('.')})`;
      out.push(`bun           ${v ? v.join('.') : '?'}  ${cand}  — ${verdict}`);
    }
  }
  out.push(`bun floor     ${floor.join('.')}${declared ? ` (declared by @opentui/core: ≥${declared.join('.')})` : ''}`);

  const renderer = rendererState();
  out.push(`renderer      @opentui/core ${renderer.core || '(missing)'}  ·  ${renderer.pkg} ${renderer.have || '(missing)'}`
    + `  — ${renderer.ok ? 'matching' : renderer.why}`);

  const which = lane();
  out.push(`dashboard     ${which.lane === 'dashboard'
    ? `will start — ${which.why}`
    : `will NOT start — ${which.why}`}`);
  if (which.skipped && which.skipped.length) out.push(`              skipped: ${which.skipped.join(', ')}`);
  // The last question, and the one the launcher cannot answer by looking at
  // files: does the dashboard bundle actually load under THAT Bun? One real
  // import, no renderer, bounded — so "the dashboard will open" is measured
  // rather than predicted, and a failing machine gets the reason here (§10).
  if (which.lane === 'dashboard' && pick.path) {
    const probe = rp.probeBundle(pick.path, CLI_DIR, { timeoutMs: 20000 });
    out.push(`bundle loads  ${probe.ok === true
      ? 'yes — the dashboard bundle imports under that Bun'
      : probe.ok === false
        ? `no — ${probe.reason}`
        : probe.reason}`);
  }

  const cfg = configState();
  out.push(`server        ${cfg.server || '(not configured — run: hakster config set server <url>)'}`);
  out.push(`signed in     ${cfg.signedIn ? 'yes — an API key is held in ' + cfg.file : 'no — run: hakster login'}`);

  const log = lastLog();
  if (log.lines.length) {
    out.push(`last dashboard log ${log.file}`);
    for (const line of log.lines) out.push(`              ${line}`);
  } else {
    out.push(`last dashboard log ${log.file} (nothing written yet)`);
  }
  out.push('');
  out.push(which.lane === 'dashboard'
    ? 'The paid dashboard will open. If it still does not, run: hakster tui'
    : 'Paste this block back to support: it names the one thing that is missing.');
  return out;
}

module.exports = { report, lane, rendererState, configState, lastLog, minBun, CLI_DIR };
