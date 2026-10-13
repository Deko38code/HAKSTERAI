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
