/* quake-windows.js — the drop-down terminal on Windows.
 *
 * Owner, 2026-11-26 (Surface Pro): "none of our grids tui guake for windows".
 * `hakster quake` shipped only the Guake path, which is Linux — on Windows the
 * command had nothing to do, so a paid machine got no drop-down and none of the
 * look that ships with the CLI (src/quake.js, assets/guake-hakster.conf).
 *
 * Windows Terminal has the two halves Guake gives us, and both are supported
 * ways in rather than files we overwrite:
 *
 *   look     a FRAGMENT — Windows Terminal merges every *.json under
 *            %LOCALAPPDATA%\Microsoft\Windows Terminal\Fragments\<name>\ into
 *            its own settings, so our scheme and profile ship as one file and
 *            the operator's settings.json is never edited (§2.9, §49.7).
 *   drop-down  Windows Terminal's own quake mode (Win+`), which is the same
 *            gesture as Guake's F12. We open the profile; the window slides.
 *
 * The palette is the owner's own Guake palette, converted from Guake's 12-digit
 * RGBA to the #rrggbb Windows Terminal reads — the same colours, not a new
 * theme. Nothing here installs anything, starts a service or changes a model,
 * route, rate or plan (§19.3, §22.4, §26). Every failure returns a reason the
 * CLI prints, never a silent no-op (§10, §13).
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PROFILE_NAME = 'HaksterAI';
const SCHEME_NAME = 'HaksterAI';

// The owner's Guake palette (assets/guake-hakster.conf, [style/font] palette),
// verbatim and in ANSI order, plus its foreground and background.
const GUake_PALETTE = [
  '#000000000000', '#afaf42425b5b', '#3737a3a31515', '#acac5b5b4141',
  '#efc8132e132e', '#000000000000', '#000000000000', '#8464f7761152',
  '#5c5c31312525', '#ffff63638787', '#2828e5e51f1f', '#f0f080806161',
  '#85857979eded', '#a0a05d5deeee', '#eaeaeaeaeaea', '#bfbfa3a3ffff',
];
const GUake_FOREGROUND = '#8464f7761152';
const GUake_BACKGROUND = '#1b1b1b1b2323';

// Windows Terminal's names for the 16 ANSI slots, in the same order.
const ANSI_SLOTS = [
  'black', 'red', 'green', 'yellow', 'blue', 'purple', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow',
  'brightBlue', 'brightPurple', 'brightCyan', 'brightWhite',
];

/** Guake writes 12 hex digits per channel (rgba); Windows Terminal wants #rrggbb. */
function toHex6(value) {
  const hex = String(value || '').replace(/^#+/, '');
  if (hex.length === 12) return `#${hex[0]}${hex[1]}${hex[4]}${hex[5]}${hex[8]}${hex[9]}`;
  if (hex.length === 8) return `#${hex.slice(0, 6)}`;
  if (hex.length === 6) return `#${hex}`;
  return value;
}

/** The colour scheme, in Windows Terminal's shape. */
function colorScheme() {
  const scheme = { name: SCHEME_NAME, foreground: toHex6(GUake_FOREGROUND), background: toHex6(GUake_BACKGROUND), cursorColor: '#00ff41', selectionBackground: '#2a2a35' };
  ANSI_SLOTS.forEach((slot, i) => { scheme[slot] = toHex6(GUake_PALETTE[i]); });
  return scheme;
}

/**
 * The fragment Windows Terminal merges in: one scheme and one profile that
 * opens our dashboard. `commandline` is left to the caller so it can name the
 * launcher this install actually has.
 */
function fragment({ commandline = 'hakster', startDir = '%USERPROFILE%' } = {}) {
  return {
    $help: 'HaksterAI drop-down — installed by `hakster quake`. Delete this file to remove it; nothing else was changed.',
    schemes: [colorScheme()],
    profiles: [
      {
        name: PROFILE_NAME,
        commandline,
        colorScheme: SCHEME_NAME,
        font: { face: 'Cascadia Mono', size: 11 },
        opacity: 90,
        useAcrylic: true,
        startingDirectory: startDir,
        hidden: false,
      },
    ],
  };
}

/** Where Windows Terminal looks for fragments. */
function fragmentDir(env = process.env) {
  const local = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(local, 'Microsoft', 'Windows Terminal', 'Fragments', 'HaksterAI');
}

function fragmentPath(env = process.env) {
  return path.join(fragmentDir(env), 'hakster.json');
}

/**
 * Write the fragment. An existing file is copied aside first and the backup
 * path is returned, so nothing of the operator's is ever lost (§2.9, §49.4).
 */
function writeFragment({ env = process.env, commandline, startDir, exists = fs.existsSync, write = fs.writeFileSync, mkdir = fs.mkdirSync, copy = fs.copyFileSync, stamp = () => new Date().toISOString().replace(/[-:.]/g, '').replace('T', 'T').slice(0, 16) } = {}) {
  try {
    const dir = fragmentDir(env);
    const file = fragmentPath(env);
    let backup = '';
    if (exists(file)) {
      backup = `${file}.bak-${stamp()}Z`;
      copy(file, backup);
    }
    mkdir(dir, { recursive: true });
    write(file, `${JSON.stringify(fragment({ commandline, startDir }), null, 2)}\n`, 'utf8');
    return { ok: true, path: file, backup };
  } catch (err) {
    return { ok: false, reason: (err && err.message) || 'write-failed' };
  }
}

/** Windows Terminal's launcher, or ''. Read-only: never starts it. */
function findWindowsTerminal({ run = spawnSync, exists = fs.existsSync, env = process.env } = {}) {
  try {
    const r = run('where.exe', ['wt.exe'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    const first = String((r && r.stdout) || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (first && exists(first)) return first;
  } catch { /* fall through to the well-known location */ }
  const local = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const known = path.join(local, 'Microsoft', 'WindowsApps', 'wt.exe');
  return exists(known) ? known : '';
}

/**
 * The argv that opens our profile in this directory. Windows Terminal takes the
 * profile by name and the start directory separately; the profile itself is
 * what runs the CLI, so nothing is typed into the operator's shell.
 */
function launchArgs({ cwd = process.cwd(), profile = PROFILE_NAME } = {}) {
  return ['-p', profile, '-d', cwd];
}

/** The drop-down gesture, for the message the command prints. */
function quakeModeHint() {
  return 'Win+` toggles Windows Terminal quake mode (the drop-down), like F12 in Guake';
}

module.exports = {
  PROFILE_NAME,
  SCHEME_NAME,
  colorScheme,
  fragment,
  fragmentDir,
  fragmentPath,
  writeFragment,
  findWindowsTerminal,
  launchArgs,
  quakeModeHint,
  toHex6,
};
