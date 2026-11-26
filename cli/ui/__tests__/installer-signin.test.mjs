/* The paid-plan install finishes by signing in (owner, 2026-11-26: the Windows
 * install flow must carry the sign-in, so a plan is usable the moment it ends).
 *
 * What this pins, so a later edit cannot quietly reopen any of it:
 *   1. `hakster whoami --json` exists and answers one machine-readable object —
 *      both installers read it, and a missing flag would make them fall back to
 *      "not signed in" forever.
 *   2. That object never carries the key (§9, §23). It is the one piece of CLI
 *      output a shell script pipes, so it is the one that must stay keyless.
 *   3. Each installer binds its own absolute path to the shim before the block
 *      runs (`$HaksterCmd` / `$HAKSTER_BIN`), so the sign-in step works in the
 *      terminal that ran the installer — before PATH is reloaded.
 *   4. Both offer the non-interactive escape (HAKSTER_NO_LOGIN / CI / no tty)
 *      and print the command instead, and the POSIX one prompts on /dev/tty so
 *      `curl … | sh` still works.
 *   5. Neither installer prints a key: the fallback is the env-var *form*.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..', '..', '..');
const read = (...p) => fs.readFileSync(path.join(repo, ...p), 'utf8');

const ps1 = read('install.ps1');
const sh = read('install.sh');
const cliIndex = read('cli', 'index.js');

/** The whoami --json action body. */
function whoamiJsonBlock(src) {
  const at = src.indexOf("if (opts.json)");
  assert.ok(at !== -1, 'whoami has no --json branch');
  return src.slice(at, at + 900);
}

test('whoami --json answers one object the installers can read', () => {
  assert.match(cliIndex, /\.option\('--json',/, 'whoami must declare --json');
  const block = whoamiJsonBlock(cliIndex);
  for (const field of ['signedIn', 'username', 'plan', 'included']) {
    assert.ok(block.includes(field), `whoami --json must carry ${field}`);
  }
});

test('whoami --json never carries the key', () => {
  const block = whoamiJsonBlock(cliIndex);
  for (const leak of ['apiKey', 'api_key', 'token', 'secret', 'password']) {
    assert.ok(!block.includes(leak), `whoami --json must not emit ${leak} (§9, §23)`);
  }
});

test('the Windows installer resolves the shim before the sign-in block', () => {
  const bind = ps1.indexOf("$HaksterCmd = Join-Path $NpmPrefix 'hakster.cmd'");
  const use = ps1.indexOf('whoami --json');
  assert.ok(bind !== -1, '$HaksterCmd must be bound to the installed shim');
  assert.ok(use !== -1, 'the Windows installer must read whoami --json');
  assert.ok(bind < use, '$HaksterCmd must be bound before sign-in runs — PATH is not reloaded yet');
});

test('the POSIX installer uses the shim path it just set', () => {
  const use = sh.indexOf('"$HAKSTER_BIN" whoami --json');
  assert.ok(use !== -1, 'install.sh must read whoami --json');
  assert.ok(sh.indexOf('HAKSTER_BIN=') < use, 'HAKSTER_BIN must be set before sign-in runs');
});

test('both installers keep a non-interactive escape', () => {
  assert.match(ps1, /HAKSTER_NO_LOGIN/, 'install.ps1 needs the HAKSTER_NO_LOGIN escape');
  assert.match(sh, /HAKSTER_NO_LOGIN/, 'install.sh needs the HAKSTER_NO_LOGIN escape');
  assert.match(ps1, /Read-Host/, 'install.ps1 must actually offer the prompt');
  assert.match(sh, /read -r ANSWER < \/dev\/tty/, 'install.sh must prompt on /dev/tty so `curl | sh` works');
});

test('a declined or skipped sign-in still tells the operator what to run', () => {
  assert.match(ps1, /skipped - run "hakster login"/);
  assert.match(sh, /skipped — run 'hakster login'/);
});

test('neither installer prints a key', () => {
  const keyFormPs = /\$env:HAKSTER_API_KEY='<key from/;
  const keyFormSh = /export HAKSTER_API_KEY=<key from/;
  assert.match(ps1, keyFormPs, 'the fallback is the env-var form, never a value');
  assert.match(sh, keyFormSh);
  for (const [name, src] of [['install.ps1', ps1], ['install.sh', sh]]) {
    assert.ok(!/Say\s+".*\$session\.key/.test(src), `${name} must never echo the session key`);
  }
});
