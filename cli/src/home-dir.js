/* home-dir.js — where our per-user files live, on every platform.
 *
 * Owner, 2026-11-26: "need to make sure file on windows go to c drive".
 *
 * On Windows everything we write lives under one folder, `%HOMEDRIVE%%HOMEPATH%`
 * + `\.hakster` — normally `C:\Users\<you>\.hakster`. That is *normally* true,
 * not always: a redirected profile, or a PowerShell session started with HOME
 * pointed somewhere else, can resolve `os.homedir()` onto another drive, and
 * then an install silently lands off C: where the operator cannot find it and a
 * second copy of the config can appear. §49: put the answer in one place, and
 * never split a working install to satisfy a rule.
 *
 * Three rules, in this order:
 *
 *   1. `HAKSTER_HOME` wins. It is the *home root* (the installer sets it to
 *      `C:\Users\<you>`), and `.hakster` is appended to it — the same meaning
 *      `quake.js` already gives it. An explicit answer is never second-guessed.
 *   2. On Windows, a home that is absolute and on the system drive is used as
 *      is. This is the ordinary case and costs nothing.
 *   3. Only then, when the home is missing, relative, or on another drive: an
 *      existing `<home>\.hakster` is KEPT (never split a working install), and
 *      otherwise the system-drive profile (`C:\Users\<you>`) is used.
 *
 * Nothing here creates, moves or deletes a directory. It answers a path.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function pathFor(platform) {
  return platform === 'win32' ? path.win32 : path;
}

/** `C:` for a Windows path, '' for anything else. */
function driveOf(p) {
  const m = /^([A-Za-z]):/.exec(String(p || ''));
  return m ? m[1].toUpperCase() : '';
}

/** The system drive as `C:\`. */
function systemRoot(env) {
  const sd = String((env && env.SystemDrive) || '').trim();
  if (/^[A-Za-z]:/.test(sd)) return sd.slice(0, 2) + '\\';
  return 'C:\\';
}

/**
 * The home root our files hang off.
 * `opts.homedir` / `opts.exists` exist so this can be proven without a Windows
 * machine in front of it (see cli/ui/__tests__/home-dir.test.mjs).
 */
function homeDir(env = process.env, platform = process.platform, opts = {}) {
  const P = pathFor(platform);

  const override = String((env && env.HAKSTER_HOME) || '').trim();
  if (override) return P.resolve(override);

  const raw = opts.homedir !== undefined ? opts.homedir : os.homedir();
  const home = String(raw || '');

  if (platform !== 'win32') return home;

  const root = systemRoot(env);
  const want = driveOf(root);
  const user = String((env && env.USERNAME) || P.basename(home) || 'user');

  if (!home || !P.isAbsolute(home)) return P.join(root, 'Users', user);
  if (driveOf(home) === want) return home;

  const exists = opts.exists || ((p) => { try { return fs.existsSync(p); } catch { return false; } });
  if (exists(P.join(home, '.hakster'))) return home;
  return P.join(root, 'Users', user);
}

/** Our own folder: `<home>/.hakster`. */
function haksterDir(env = process.env, platform = process.platform, opts = {}) {
  return pathFor(platform).join(homeDir(env, platform, opts), '.hakster');
}

module.exports = { homeDir, haksterDir, driveOf, systemRoot };
