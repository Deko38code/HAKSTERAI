/* The quake terminal ships with the CLI.
 *
 * Owner, 2026-11-25: "make sure our cli when paid users download it it comes
 * with quake terminal no matter what for best looks graphics render speed color
 * and makes our cli tui dope out of the competition" / "the startup like my cli
 * does the matrix and my backsolash i have all included".
 *
 * Pinned here:
 *   1. the package carries the Guake profile AND the backdrop it points at;
 *   2. the profile is the owner's look (neon palette, DejaVu Sans Mono 11, the
 *      drop-down geometry) with the backdrop's real path filled in;
 *   3. Guake is never installed without consent — no silent sudo;
 *   4. the profile is applied through Guake's own --save/--restore-preferences,
 *      after a backup, and only once per CLI version;
 *   5. the drop-down tab runs the CLI's TUI, and `quake` uses all of it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..', '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const require = createRequire(import.meta.url);
const quake = require(path.join(root, 'cli/src/quake.js'));

test('the package carries the Guake profile and the backdrop it needs', () => {
  const pkg = JSON.parse(read('cli/package.json'));
  assert.ok(pkg.files.includes('assets/'), 'assets ship in the tarball');
  assert.ok(fs.existsSync(path.join(root, 'cli/assets/guake-hakster.conf')), 'the profile ships');
  const backdrop = path.join(root, 'cli/assets/haksterai-backdrop.png');
  assert.ok(fs.existsSync(backdrop), 'the backdrop ships');
  assert.ok(fs.statSync(backdrop).size > 100000, 'and it is the real image, not a placeholder');

  const conf = read('cli/assets/guake-hakster.conf');
  assert.ok(conf.includes("background-image-file='@BACKDROP@'"), 'the backdrop path is a placeholder');
  assert.ok(conf.includes("palette-name='HaksterAI'"), 'the owner\'s palette is named');
  assert.ok(conf.includes("style='DejaVu Sans Mono 11'"));
  assert.ok(conf.includes('use-default-font=false'), 'our font is the one that renders');
  assert.ok(conf.includes('window-width=100') && conf.includes('window-height=100'), 'full drop-down');
  assert.ok(conf.includes('[style/background]') && conf.includes('transparency=90'));
});

test('the profile is rendered with a real absolute backdrop path', () => {
  const out = quake.renderProfile('/opt/hakster/assets/haksterai-backdrop.png');
  assert.ok(out.includes("background-image-file='/opt/hakster/assets/haksterai-backdrop.png'"));
  assert.ok(!out.includes('@BACKDROP@'), 'no placeholder survives');
  // The shipped default is the package's own asset, wherever it is installed.
  assert.equal(quake.BACKDROP, path.join(root, 'cli/assets/haksterai-backdrop.png'));
});

test('install hints are real commands per distribution', () => {
  const deb = quake.installHint('ID=linuxmint\nID_LIKE="ubuntu debian"\n');
  assert.deepEqual(deb.argv, ['sudo', 'apt-get', 'install', '-y', 'guake']);
  assert.equal(quake.installHint('ID=parrot\nID_LIKE=debian\n').manager, 'apt');
  assert.deepEqual(quake.installHint('ID=arch\n').argv, ['sudo', 'pacman', '-S', '--noconfirm', 'guake']);
  assert.deepEqual(quake.installHint('ID=fedora\n').argv, ['sudo', 'dnf', 'install', '-y', 'guake']);
  assert.deepEqual(quake.installHint('').argv, ['sudo', 'apt-get', 'install', '-y', 'guake']);
});

test('nothing installs Guake without consent', async () => {
  const calls = [];
  const run = (...args) => { calls.push(args); return { status: 0 }; };
  const missing = () => '';
  // Non-interactive, no --yes: the command is printed and nothing is run.
  const quiet = await quake.ensureGuake({ interactive: false, yes: false, run, log: () => {}, find: missing });
  assert.equal(quiet.ok, false);
  assert.match(quiet.cmd, /guake/);
  assert.equal(calls.length, 0, 'no package manager was touched');
  // An interactive prompt that never gets a "yes" is also a decline.
  const declined = await quake.ensureGuake({ interactive: false, yes: false, run, log: () => {}, find: missing });
  assert.equal(declined.reason, 'guake-missing');
  assert.equal(calls.length, 0, 'a printed hint is not an install');
  // --yes is the explicit consent, and then the hint is what runs.
  const yes = await quake.ensureGuake({ yes: true, run, log: () => {}, osRelease: 'ID=fedora\n', find: missing });
  assert.equal(yes.ok, true);
  assert.deepEqual(calls[0].slice(0, 2), ['sudo', ['dnf', 'install', '-y', 'guake']]);
  // Already installed is a no-op with no install call at all.
  const present = await quake.ensureGuake({ run, log: () => {}, find: () => '/usr/bin/guake' });
  assert.equal(present.ok, true);
  assert.equal(present.installed, false);
  assert.equal(calls.length, 1, 'nothing else was run');
});

test('the profile goes in through Guake\'s own import, backed up first', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quake-home-'));
  const prev = process.env.HAKSTER_HOME;
  process.env.HAKSTER_HOME = home;
  try {
    const calls = [];
    let restored = '';
    const run = (bin, argv) => {
      calls.push([bin, argv]);
      if (argv[0] === '--restore-preferences') restored = fs.readFileSync(argv[1], 'utf8');
      return { status: 0, stdout: '', stderr: '' };
    };
    // A machine with Guake: the profile is saved, then imported, then marked.
    const out = quake.applyProfile({ version: '9.9.9', run, find: () => '/usr/bin/guake' });
    assert.equal(out.ok, true, out.reason);
    assert.match(out.backup, /hakster-backup-.*\.conf$/, 'the previous profile is saved first');
    assert.equal(calls[0][1][0], '--save-preferences', 'save comes first');
    assert.equal(calls[1][1][0], '--restore-preferences', 'then our profile is imported');
    assert.ok(restored.includes(`background-image-file='${quake.BACKDROP}'`), 'with the backdrop filled in');
    assert.ok(!restored.includes('@BACKDROP@'));
    assert.equal(quake.isSetup('9.9.9'), true, 'the marker records exactly this version');
    assert.equal(quake.isSetup('9.9.8'), false, 'a different version is not "already set up"');
    // A machine without Guake: honest refusal, nothing run.
    const empty = [];
    const none = quake.applyProfile({ version: '9.9.8', run: (...a) => { empty.push(a); return { status: 0 }; }, find: () => '' });
    assert.deepEqual(none, { ok: false, reason: 'guake-missing' });
    assert.equal(empty.length, 0, 'no guake binary, no guake call');
  } finally {
    if (prev === undefined) delete process.env.HAKSTER_HOME; else process.env.HAKSTER_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('the drop-down tab runs the CLI TUI, and quake uses the module', () => {
  const cmd = quake.tabCommand({ cwd: '/tmp/a b', execPath: '/usr/bin/node', entry: '/opt/h/cli/index.js' });
  assert.ok(cmd.startsWith("cd '/tmp/a b' && HAKSTER_NO_SPLASH=1 '/usr/bin/node' '/opt/h/cli/index.js' tui"));
  const args = quake.launchArgs({ cwd: '/tmp/x' });
  assert.deepEqual(args.slice(0, 5), ['--show', '--new-tab', '/tmp/x', '--rename-tab', 'hakster']);
  assert.equal(args[5], '-e');

  const src = read('cli/index.js');
  assert.ok(src.includes("require('./src/quake')"), 'the command uses the module');
  assert.match(src, /quake\.ensureGuake\(\{ yes: Boolean\(opts\.yes\)/, 'install is consent-gated');
  assert.match(src, /quake\.isSetup\(version\)/, 'the look is applied once per version');
  assert.match(src, /quake\.launchArgs\(\{ cwd: process\.cwd\(\) \}\)/, 'and the tab is launched through it');
});
