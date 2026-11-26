/* home-dir.test.mjs — our files land on the system drive, and nowhere else.
 *
 * Owner, 2026-11-26: "need to make sure file on windows go to c drive".
 *
 * The rule lives in cli/src/home-dir.js and the installer (install.ps1) repeats
 * it for the files it unpacks. Both halves are pinned here, because the two
 * drifting apart is exactly how an install ends up split across drives: the
 * installer writes to one folder and the CLI then reads another.
 *
 * The resolver's own decisions are proven by passing a fake homedir and a fake
 * "does this already exist?" — that keeps the Windows behaviour testable on a
 * Linux box instead of being asserted by reading the code and hoping (§13).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..'); // repo root
const require = createRequire(import.meta.url);
const { homeDir, haksterDir } = require(path.join(ROOT, 'cli', 'src', 'home-dir.js'));

const env = (extra = {}) => Object.assign({ SystemDrive: 'C:', USERNAME: 'deke' }, extra);
const nothingExists = () => false;

test('non-Windows keeps the real home, unchanged', () => {
  assert.equal(
    homeDir({}, 'linux', { homedir: '/home/ghost' }),
    '/home/ghost',
    'a Linux box is untouched by a Windows drive rule',
  );
  assert.equal(haksterDir({}, 'linux', { homedir: '/home/ghost' }), '/home/ghost/.hakster');
});

test('HAKSTER_HOME is the home root and always wins', () => {
  const out = homeDir(env({ HAKSTER_HOME: 'C:\\Users\\deke' }), 'win32', {
    homedir: 'D:\\Users\\deke',
    exists: () => true,
  });
  assert.equal(out, 'C:\\Users\\deke', 'an explicit answer is never second-guessed');
  assert.equal(
    haksterDir(env({ HAKSTER_HOME: 'C:\\Users\\deke' }), 'win32'),
    'C:\\Users\\deke\\.hakster',
    '.hakster is appended to the root — the same meaning quake.js already gave it',
  );
});

test('Windows: a home already on the system drive is used as it is', () => {
  assert.equal(homeDir(env(), 'win32', { homedir: 'C:\\Users\\deke' }), 'C:\\Users\\deke');
  // Case of the drive letter must not matter.
  assert.equal(homeDir(env(), 'win32', { homedir: 'c:\\Users\\deke' }), 'c:\\Users\\deke');
});

test('Windows: a home on another drive with no install moves to the system profile', () => {
  assert.equal(
    homeDir(env(), 'win32', { homedir: 'D:\\Users\\deke', exists: nothingExists }),
    'C:\\Users\\deke',
    'nothing is installed on D:, so the new install goes to C: as asked',
  );
});

test('Windows: an EXISTING install is never moved or split', () => {
  const keptD = homeDir(env(), 'win32', {
    homedir: 'D:\\Users\\deke',
    exists: (p) => p === 'D:\\Users\\deke\\.hakster',
  });
  assert.equal(
    keptD,
    'D:\\Users\\deke',
    'a working install on another drive stays put rather than being split across two folders',
  );
});

test('Windows: a missing or relative home falls back to the system profile', () => {
  assert.equal(homeDir(env(), 'win32', { homedir: '' }), 'C:\\Users\\deke');
  assert.equal(homeDir(env(), 'win32', { homedir: '.\\somewhere' }), 'C:\\Users\\deke');
});

test('Windows: the system drive itself is read, never assumed to be C:', () => {
  const e = env({ SystemDrive: 'E:' });
  assert.equal(
    homeDir(e, 'win32', { homedir: 'D:\\Users\\deke', exists: nothingExists }),
    'E:\\Users\\deke',
    'a machine whose system drive is E: installs to E:, not to a hardcoded C:',
  );
});

test('haksterDir is always one folder under the resolved home', () => {
  const dir = haksterDir(env(), 'win32', { homedir: 'C:\\Users\\deke' });
  assert.equal(dir, 'C:\\Users\\deke\\.hakster');
  assert.ok(dir.split('\\').includes('.hakster'));
});

test('the installer resolves the same folder and hands it to the CLI', () => {
  const ps = fs.readFileSync(path.join(ROOT, 'install.ps1'), 'utf8');
  assert.match(ps, /\$env:HAKSTER_HOME/, 'the installer sets HAKSTER_HOME, the value home-dir.js reads first');
  assert.match(ps, /Get-DriveOf/, 'it compares the drive rather than trusting $HOME');
  assert.match(ps, /SetEnvironmentVariable\('HAKSTER_HOME'/, 'it is persisted, so later terminals agree too');
  assert.match(ps, /files: \$HaksterHome/, 'and the folder it chose is printed — an install that cannot say where it wrote has not made anything sure');
  assert.doesNotMatch(ps, /Join-Path \$HOME '\.hakster\\runtime'/, 'no file path is built from a bare $HOME any more');
});
