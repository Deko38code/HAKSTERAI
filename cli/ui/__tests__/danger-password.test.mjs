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

import { getDangerPassword, isSudoCommand } from '../src/utils/danger-password.js';

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
