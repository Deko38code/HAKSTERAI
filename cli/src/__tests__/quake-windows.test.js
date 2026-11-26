'use strict';
/* quake-windows.test.js — the Windows drop-down ships the same look as Guake.
 *
 * `hakster quake` was Linux-only, so a paid Windows machine had no drop-down and
 * none of the shipped theme (Surface Pro, 2026-11-26: "none of our grids tui
 * guake for windows"). Windows Terminal takes the same look as a FRAGMENT, and
 * these tests pin that the fragment is real, that its palette is the owner's own
 * Guake palette rather than a new theme, and that writing it never loses an
 * existing file.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const qw = require('../quake-windows.js');

const CLI_DIR = path.join(__dirname, '..', '..');
const GUAKE = fs.readFileSync(path.join(CLI_DIR, 'assets', 'guake-hakster.conf'), 'utf8');

test('the shipped Guake palette converts to the #rrggbb Windows Terminal reads', () => {
  assert.equal(qw.toHex6('#000000000000'), '#000000');
  assert.equal(qw.toHex6('#afaf42425b5b'), '#af425b');
  assert.equal(qw.toHex6('#00ff41'), '#00ff41');
  assert.equal(qw.toHex6(''), '');
});

test('the scheme is the owner’s own Guake palette, slot for slot', () => {
  const line = GUAKE.match(/^palette='([^']+)'/m);
  assert.ok(line, 'assets/guake-hakster.conf no longer carries a palette');
  const guake = line[1].split(':');
  // Guake writes 16 ANSI slots followed by foreground and background.
  assert.equal(guake.length, 18, 'the Guake palette is no longer 16 slots + foreground/background');
  const scheme = qw.colorScheme();
  assert.equal(scheme.foreground, qw.toHex6(guake[16]), 'foreground drifted from the Guake palette');
  assert.equal(scheme.background, qw.toHex6(guake[17]), 'background drifted from the Guake palette');
  const slots = ['black', 'red', 'green', 'yellow', 'blue', 'purple', 'cyan', 'white',
    'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightPurple', 'brightCyan', 'brightWhite'];
  slots.forEach((slot, i) => {
    assert.equal(scheme[slot], qw.toHex6(guake[i]), `slot ${slot} drifted from the Guake palette`);
  });
  for (const key of Object.keys(scheme)) {
    if (key === 'name') continue;
    assert.match(scheme[key], /^#[0-9a-f]{6}$/i, `${key} is not a #rrggbb colour: ${scheme[key]}`);
  }
});

test('the fragment defines the scheme and the profile that opens our dashboard', () => {
  const f = qw.fragment({ commandline: '"C:\\Program Files\\nodejs\\node.exe" "C:\\h\\index.js" tui' });
  assert.equal(f.schemes.length, 1);
  assert.equal(f.schemes[0].name, qw.SCHEME_NAME);
  assert.equal(f.profiles.length, 1);
  const p = f.profiles[0];
  assert.equal(p.name, qw.PROFILE_NAME);
  assert.equal(p.colorScheme, qw.SCHEME_NAME, 'the profile does not point at our scheme');
  assert.ok(/index\.js"? tui$/.test(p.commandline), 'the profile no longer runs the dashboard');
  assert.ok(p.font && p.font.face, 'no font is set, so the profile inherits whatever is there');
});

test('the fragment lives where Windows Terminal merges fragments', () => {
  const env = { LOCALAPPDATA: 'C:\\Users\\deke\\AppData\\Local' };
  assert.equal(
    qw.fragmentPath(env),
    path.join('C:\\Users\\deke\\AppData\\Local', 'Microsoft', 'Windows Terminal', 'Fragments', 'HaksterAI', 'hakster.json')
  );
});

test('writing the fragment keeps any earlier copy', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hakster-quake-'));
  const env = { LOCALAPPDATA: tmp };
  const file = qw.fragmentPath(env);
  const first = qw.writeFragment({ env, commandline: 'hakster tui' });
  assert.ok(first.ok, first.reason);
  assert.ok(fs.existsSync(file), 'the fragment was not written');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).profiles[0].name, qw.PROFILE_NAME);
  const second = qw.writeFragment({ env, commandline: 'hakster tui' });
  assert.ok(second.ok, second.reason);
  assert.ok(second.backup && fs.existsSync(second.backup), 'an existing fragment was overwritten without a backup');
});

test('the launcher opens the profile in this directory', () => {
  assert.deepEqual(qw.launchArgs({ cwd: 'C:\\work' }), ['-p', qw.PROFILE_NAME, '-d', 'C:\\work']);
  assert.match(qw.quakeModeHint(), /Win\+`/, 'the drop-down gesture is no longer named');
});

test('a Windows Terminal that is not there is reported, never guessed', () => {
  const none = qw.findWindowsTerminal({
    run: () => ({ stdout: '', status: 1 }),
    exists: () => false,
    env: { LOCALAPPDATA: 'C:\\nope' },
  });
  assert.equal(none, '');
  const found = qw.findWindowsTerminal({
    run: () => ({ stdout: 'C:\\WT\\wt.exe\r\n', status: 0 }),
    exists: (p) => p === 'C:\\WT\\wt.exe',
    env: {},
  });
  assert.equal(found, 'C:\\WT\\wt.exe');
});
