/* Tests for the approval-password lookup and sudo detection.
 *
 * `isSudoCommand` decides whether an approval prompt demands the password, so a
 * false negative downgrades a password gate to a bare `y`. It is tested for the
 * false-positive direction too — treating an ordinary command as elevated only
 * annoys, but the point of pinning both is that the regex cannot be quietly
 * widened later.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getDangerPassword, isSudoCommand } from '../src/utils/danger-password.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...p) => fs.readFileSync(path.join(here, '..', ...p), 'utf8');

test('isSudoCommand recognises elevated commands', () => {
  assert.equal(isSudoCommand('sudo systemctl restart nginx'), true);
  assert.equal(isSudoCommand('  sudo rm -rf /tmp/x'), true);
  assert.equal(isSudoCommand('SUDO rm -rf /tmp/x'), true);
  assert.equal(isSudoCommand('sudo'), true);
});

test('isSudoCommand does not treat an ordinary command as elevated', () => {
  // `sudo` has to be the command being run, not a word inside it — otherwise a
  // log line or a grep pattern would demand a password.
  assert.equal(isSudoCommand('echo sudo'), false);
  assert.equal(isSudoCommand('grep sudo /var/log/auth.log'), false);
  assert.equal(isSudoCommand('rm -rf /tmp/build'), false);
  assert.equal(isSudoCommand(''), false);
  assert.equal(isSudoCommand(null), false);
  assert.equal(isSudoCommand(undefined), false);
});

test('the environment password takes precedence over any config file', () => {
  const previous = process.env.HAKSTER_DANGER_PASSWORD;
  try {
    process.env.HAKSTER_DANGER_PASSWORD = 'hunter2';
    assert.equal(getDangerPassword(), 'hunter2');
  } finally {
    if (previous === undefined) delete process.env.HAKSTER_DANGER_PASSWORD;
    else process.env.HAKSTER_DANGER_PASSWORD = previous;
  }
});

/* Owner (2026-11-25): "make sure the dangerous commands prompt popout win works
 * for my password etc". Two things had to be true for that to be possible, and
 * both are pinned here by source, because neither can be exercised without a
 * real terminal: the gate must ask for the password on EVERY dangerous command
 * (not only sudo, which is what the text CLI has always done), and there must
 * be a way to set one from inside the TUI.
 */
const approvalSource = read('src', 'components', 'ApprovalPrompt.jsx');
const utilSource = read('src', 'utils', 'danger-password.js');
const appSource = read('src', 'App.jsx');

test('the approval gate asks for the password on any dangerous command', () => {
  assert.match(approvalSource, /const needsPassword = !!dangerPassword;/, 'the gate no longer asks for a password on every dangerous command');
  assert.doesNotMatch(approvalSource, /needsPassword = sudo &&/, 'the TUI is back to gating only sudo commands — the text CLI gates them all');
});

test('the password can be set from inside the TUI, hidden', () => {
  // The masked entry panel exists, is wired to /danger, and writes through the
  // util that keeps the file at mode 600 — never an echo, never a log.
  assert.ok(fs.existsSync(path.join(here, '..', 'src', 'components', 'DangerPasswordPrompt.jsx')), 'DangerPasswordPrompt is missing');
  assert.match(appSource, /case '\/danger'/, '/danger is not handled in App.jsx');
  assert.match(appSource, /setDangerSetup\(true\)/, '/danger set does not open the masked field');
  assert.match(utilSource, /export function setDangerPassword\(/, 'setDangerPassword is missing');
  assert.match(utilSource, /mode: 0o600/, 'the written config is not mode 600');
  assert.doesNotMatch(utilSource, /console\.log\([^)]*(pw|value)/i, 'the util logs the password');
});

test('the hero mark is shared, not copied, and carries the name', () => {
  const hero = read('src', 'components', 'HeroLogo.jsx');
  // Renamed 2026-11-26 at the owner's direction ("WHERE IT SAYS HAKSTER CHANGE
  // TO HAKSTER-AI"); the wordmark is now HAKSTER-AI, so this pins that name.
  assert.match(hero, /export const HERO_NAME = 'HAKSTER-AI';/);
  assert.match(read('src', 'components', 'DecodeSplash.jsx'), /from '\.\/HeroLogo\.jsx'/, 'the splash stopped importing the shared wordmark');
  assert.match(read('src', 'components', 'CatalogPopout.jsx'), /<HeroLogo width=\{inner\} \/>/, 'the /menu popout does not draw the hero logo');
  assert.match(approvalSource, /<HeroLogo width=\{inner\}/, 'the approval window does not draw the hero logo');
});

test('getDangerPassword yields a string or null and never throws', () => {
  // With the env var cleared it falls through to ~/.hakster/config.json, which
  // may or may not exist on the machine running the suite. The contract being
  // pinned is that a missing or malformed config is "no password", not a crash
  // in the middle of drawing an approval prompt.
  const previous = process.env.HAKSTER_DANGER_PASSWORD;
  try {
    delete process.env.HAKSTER_DANGER_PASSWORD;
    const value = getDangerPassword();
    assert.ok(
      value === null || typeof value === 'string',
      `expected a string or null, got ${typeof value}`,
    );
  } finally {
    if (previous !== undefined) process.env.HAKSTER_DANGER_PASSWORD = previous;
  }
});
