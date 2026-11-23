/* prefs.js — the CLI's own settings, stored on this machine.
 *
 * Owner 2026-11-23: "make sure our cli has its own setting prewfrence".
 * One file, ~/.hakster/cli-prefs.json (mode 600), owned by the CLI alone —
 * never the server's config, never another project's (§16), never a secret.
 * Unknown keys are refused so a typo cannot leave junk behind, and a bad file
 * falls back to defaults instead of breaking a session.
 *
 * The older ~/.hakster/tui-prefs.json is read as a fallback (it held the auto
 * handoff choice); it is never rewritten or removed.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const PREFS_DIR = path.join(os.homedir(), '.hakster');
const PREFS_FILE = path.join(PREFS_DIR, 'cli-prefs.json');
const LEGACY_FILE = path.join(PREFS_DIR, 'tui-prefs.json');

const DEFAULTS = {
  model: '', // '' = the pinned primary model (§22)
  provider: '',
  autoHandoff: true, // DeepSeek → Codex → server waterfall
  ads: true, // the TUI's ad rail
  monitorFollow: true, // the monitor view follows the newest line
  updateCheck: true, // background CLI update check
  opaqueBackdrop: false, // false = transparent over the terminal's wallpaper
  intro: true, // the five-line decode splash on start
  graphics: true, // real logo image in kitty / Ghostty / WezTerm (no-op elsewhere)
  usageRefresh: 15, // the usage page's poll, seconds (0 = paused)
};

const KEYS = Object.keys(DEFAULTS);

function readJson(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** Current settings: defaults, then the legacy file, then this CLI's file. */
function load() {
  const legacy = readJson(LEGACY_FILE) || {};
  const current = readJson(PREFS_FILE) || {};
  const out = { ...DEFAULTS };
  for (const key of KEYS) {
    if (typeof legacy[key] === typeof DEFAULTS[key] && legacy[key] !== undefined) out[key] = legacy[key];
    if (typeof current[key] === typeof DEFAULTS[key] && current[key] !== undefined) out[key] = current[key];
  }
  return out;
}

/** Merge a patch of known keys and persist. Returns the effective settings. */
function save(patch) {
  const next = { ...load() };
  for (const key of KEYS) {
    if (patch && Object.prototype.hasOwnProperty.call(patch, key)) next[key] = patch[key];
  }
  try {
    fs.mkdirSync(PREFS_DIR, { recursive: true, mode: 0o700 });
    const tmp = `${PREFS_FILE}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, PREFS_FILE);
  } catch {
    /* preferences are a convenience; never let them break a session */
  }
  return next;
}

/** Turn a command-line value into the type the setting already has. */
function coerce(key, value) {
  const fallback = DEFAULTS[key];
  if (typeof fallback === 'boolean') {
    const v = String(value || '').toLowerCase();
    if (['1', 'true', 'on', 'yes', 'y'].includes(v)) return true;
    if (['0', 'false', 'off', 'no', 'n'].includes(v)) return false;
    return null;
  }
  if (typeof fallback === 'number') {
    const n = Number(String(value == null ? '' : value).trim());
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.min(3600, Math.round(n));
  }
  return String(value == null ? '' : value).trim();
}

function isKnown(key) {
  return KEYS.includes(String(key || ''));
}

function list() {
  const current = load();
  return KEYS.map((key) => ({ key, value: current[key], default: DEFAULTS[key] }));
}

module.exports = { DEFAULTS, KEYS, PREFS_FILE, load, save, coerce, isKnown, list };
