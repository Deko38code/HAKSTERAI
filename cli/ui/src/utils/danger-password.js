import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* Where the approval password comes from.
 *
 * Deliberately the same two sources and the same precedence as
 * `getDangerPassword()` in cli/index.js — the environment first, then
 * `~/.hakster/config.json` — so an operator who set it up for the text CLI gets
 * the same behaviour in the TUI without a second configuration step.
 *
 * Read fresh on every call rather than cached. The value is only needed when a
 * dangerous command is actually held, and a long-lived TUI that cached it at
 * startup would keep accepting a password the operator has since rotated away.
 */

const CONFIG_DIR = path.join(os.homedir(), '.hakster');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

/** The configured approval password, or null when none is set. */
export function getDangerPassword() {
  if (process.env.HAKSTER_DANGER_PASSWORD) return process.env.HAKSTER_DANGER_PASSWORD;
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (cfg && typeof cfg.dangerPassword === 'string') return cfg.dangerPassword;
  } catch {
    /* no config yet, or unreadable — there is simply no password */
  }
  return null;
}

/** True when the command needs elevated privileges, which changes the prompt. */
export function isSudoCommand(command) {
  return /^\s*sudo\b/i.test(String(command || ''));
}

/** Where the password in force comes from: 'env', 'config' or null. */
export function dangerPasswordSource() {
  if (process.env.HAKSTER_DANGER_PASSWORD) return 'env';
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (cfg && typeof cfg.dangerPassword === 'string' && cfg.dangerPassword) return 'config';
  } catch {
    /* no config yet — there is simply no password */
  }
  return null;
}

/**
 * What may be shown about the password: whether it is set, how long it is and
 * where it comes from. Never the value itself (§9, §23).
 */
export function dangerPasswordState() {
  const source = dangerPasswordSource();
  const pw = getDangerPassword();
  return { set: !!pw, length: pw ? pw.length : 0, source };
}

/**
 * Save the approval password the owner typed into a masked field.
 *
 * Operator action, not an agent tool: this runs in the CLI process because the
 * human typed it, and it is the same value `hakster config sudo` writes. The
 * file keeps mode 0600 and every other config key is preserved. The value is
 * never returned, logged or printed — only the fact that it was saved.
 *
 * The self-config guard (§38) closes *tool* writes to ~/.hakster/config.json;
 * an owner typing into the CLI's own prompt is the operator, not a tool.
 */
export function setDangerPassword(value) {
  const pw = String(value == null ? '' : value);
  if (!pw) return { ok: false, reason: 'empty' };
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {};
  } catch {
    cfg = {};
  }
  cfg.dangerPassword = pw;
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(CONFIG_FILE, 0o600);
  } catch (e) {
    return { ok: false, reason: (e && e.message) || 'write failed' };
  }
  return { ok: true, envOverride: !!process.env.HAKSTER_DANGER_PASSWORD };
}

/** Remove the stored approval password. Never touches the env variable. */
export function clearDangerPassword() {
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {};
  } catch {
    return { ok: true, removed: false };
  }
  if (!('dangerPassword' in cfg)) return { ok: true, removed: false };
  delete cfg.dangerPassword;
  try {
    fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(CONFIG_FILE, 0o600);
  } catch (e) {
    return { ok: false, reason: (e && e.message) || 'write failed' };
  }
  return { ok: true, removed: true };
}
