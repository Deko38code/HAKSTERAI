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

/** Where our installer puts the runtimes it had to bring. */
function runtimeRoot(env = process.env) {
  const override = String(env.HAKSTER_RUNTIME || '').trim();
  return override ? path.resolve(override) : path.join(os.homedir(), '.hakster', 'runtime');
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

function names(bin) {
  return process.platform === 'win32' ? [`${bin}.exe`, `${bin}.cmd`, `${bin}.bat`, bin] : [bin];
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
 * Bun: the machine's own first, then the one our installer brought.
 * Returns a path or null — never installs anything (§11: no auto-changes).
 */
function findBun(env = process.env) {
  const onPath = findOnPath('bun', env);
  if (onPath) return onPath;

  const root = runtimeRoot(env);
  // install.sh / install.ps1: npm install --prefix <root>/bun bun@<version>
  for (const name of names('bun')) {
    const installed = path.join(root, 'bun', 'node_modules', '.bin', name);
    if (isExecutableFile(installed)) return installed;
  }
  // The bun package ships a real executable here on every platform; on Windows
  // this is preferred over npm's .cmd shim, which needs a shell to start.
  for (const name of names('bun')) {
    const bundled = path.join(root, 'bun', 'node_modules', 'bun', 'bin', name);
    if (isExecutableFile(bundled)) return bundled;
  }
  // A bootstrapped Node tree can also carry one; checked newest-first.
  let dirs = [];
  try { dirs = fs.readdirSync(root).filter((d) => d.startsWith('node-')).sort().reverse(); } catch { /* none */ }
  for (const d of dirs) {
    for (const name of names('bun')) {
      const full = path.join(root, d, 'bin', name);
      if (isExecutableFile(full)) return full;
    }
  }
  return null;
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

module.exports = { runtimeRoot, findOnPath, findBun, findNode, isExecutableFile };
