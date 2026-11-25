// Plug-and-play installers: the script checks what a machine has and brings
// only what is missing (owner, 2026-11-25: "so can we add node to it so evething
// whats needed to run come plug and play"; "and we need avalible for windows to
// 11 10 etc"; "make sure its solid please").
//
// Two halves are pinned here:
//   1. `runtime-paths` finds Bun/Node on PATH first and then in the runtime the
//      installer brought — the CLI must never fall back to Ink while a Bun it
//      just installed sits unused.
//   2. The installer scripts keep the properties that make them safe: origin
//      substitution, a published checksum on every download, and no writes into
//      the user's own ~/.claude.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const cliRoot = path.resolve(here, '..', '..');
const repoRoot = path.resolve(cliRoot, '..');
const runtimePaths = require(path.join(cliRoot, 'src', 'runtime-paths.js'));

function tmpdir() {
  return mkdtempSync(path.join(os.tmpdir(), 'hakster-runtime-test-'));
}

function makeExecutable(file) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, '#!/bin/sh\nexit 0\n');
  chmodSync(file, 0o755);
}

test('findBun returns null when nothing is installed', () => {
  const home = tmpdir();
  try {
    assert.equal(runtimePaths.findBun({ PATH: '', HAKSTER_RUNTIME: path.join(home, 'runtime') }), null);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('findBun finds the copy our installer put in the runtime', () => {
  const home = tmpdir();
  try {
    const runtime = path.join(home, 'runtime');
    const bun = path.join(runtime, 'bun', 'node_modules', '.bin', 'bun');
    makeExecutable(bun);
    assert.equal(runtimePaths.findBun({ PATH: '', HAKSTER_RUNTIME: runtime }), bun);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('a Bun already on PATH wins over the one we installed', () => {
  const home = tmpdir();
  try {
    const runtime = path.join(home, 'runtime');
    const own = path.join(home, 'bin', 'bun');
    makeExecutable(path.join(runtime, 'bun', 'node_modules', '.bin', 'bun'));
    makeExecutable(own);
    assert.equal(runtimePaths.findBun({ PATH: path.join(home, 'bin'), HAKSTER_RUNTIME: runtime }), own);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('the bun package\'s own binary directory is found too', () => {
  const home = tmpdir();
  try {
    const runtime = path.join(home, 'runtime');
    const bundled = path.join(runtime, 'bun', 'node_modules', 'bun', 'bin', process.platform === 'win32' ? 'bun.exe' : 'bun');
    makeExecutable(bundled);
    assert.equal(runtimePaths.findBun({ PATH: '', HAKSTER_RUNTIME: runtime }), bundled);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('findNode finds a bootstrapped Node tree, newest first', () => {
  const home = tmpdir();
  try {
    const runtime = path.join(home, 'runtime');
    const older = path.join(runtime, 'node-v22.0.0-linux-x64', 'bin', 'node');
    const newer = path.join(runtime, 'node-v24.22.3-linux-x64', 'bin', 'node');
    makeExecutable(older);
    makeExecutable(newer);
    assert.equal(runtimePaths.findNode({ PATH: '', HAKSTER_RUNTIME: runtime }), newer);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('both installers exist at the repo root and take the origin as a placeholder', () => {
  for (const name of ['install.sh', 'install.ps1']) {
    const file = path.join(repoRoot, name);
    assert.equal(existsSync(file), true, `${name} must exist at the repo root`);
    const src = readFileSync(file, 'utf8');
    assert.match(src, /__ORIGIN__/, `${name} must keep __ORIGIN__ for the server to substitute`);
  }
});

test('the Linux/macOS installer verifies every download against the published checksum', () => {
  const src = readFileSync(path.join(repoRoot, 'install.sh'), 'utf8');
  assert.match(src, /SHASUMS256\.txt/, 'the Node download must be checked against SHASUMS256.txt');
  assert.match(src, /\[ "\$WANT" = "\$GOT" \]/, 'the checksum must actually be compared');
  // The archive URL once read node-...-linux-x64.tar.tar.xz; the platform tag
  // must carry the bare extension (xz|gz), not "tar.xz".
  assert.doesNotMatch(src, /\.tar\.tar\./, 'no doubled archive extension in the download URL');
  assert.match(src, /npm pack/, 'the CLI must be installed from a packed tarball, never a link into the temp dir');
  const commands = src.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
  assert.doesNotMatch(commands, /npm install -g \./, 'a directory install links back into the temp dir and breaks on cleanup');
});

test('the Windows installer verifies its download and installs per-user', () => {
  const src = readFileSync(path.join(repoRoot, 'install.ps1'), 'utf8');
  assert.match(src, /SHASUMS256\.txt/);
  assert.match(src, /Get-FileHash .*SHA256/, 'the Node zip must be hashed and compared');
  assert.match(src, /npm pack/, 'pack then install the tarball');
  assert.match(src, /--prefix \$NpmPrefix/, 'Windows installs into a per-user prefix, no admin');
  assert.match(src, /win-x64/, 'x64 Windows');
  assert.match(src, /win-arm64/, 'ARM64 Windows');
});

test('neither installer touches the user\'s own Claude Code config', () => {
  for (const name of ['install.sh', 'install.ps1']) {
    const src = readFileSync(path.join(repoRoot, name), 'utf8');
    assert.doesNotMatch(src, /\.claude(\/|\\)/, `${name} must never read or write ~/.claude`);
  }
});

test('the installer applies our Guake look when Guake is already there', () => {
  // Owner, 2026-11-26: "i want it to come with our install the png" and
  // "yes it should add". The package carries the profile and the backdrop; the
  // installer applies the look through `hakster quake --setup` (Guake's own
  // import, previous profile backed up first) when the machine has Guake.
  const src = readFileSync(path.join(repoRoot, 'install.sh'), 'utf8');
  const block = src.slice(src.indexOf('The look comes with the install'));
  const apply = block.slice(0, block.indexOf('say "Next:'));

  assert.match(apply, /elif command -v guake >\/dev\/null 2>&1; then/, 'only when Guake is already installed');
  assert.match(apply, /"\$HAKSTER_BIN" quake --setup/, 'the shipped CLI applies it, not the installer');
  assert.match(apply, /Guake look applied/, 'a real apply is claimed only when it reports one');
  assert.match(apply, /hakster quake --setup --repair/, 'a failure is reported with the way to fix it');
  assert.match(apply, /HAKSTER_NO_QUAKE/, 'an operator can opt out');

  // It never installs Guake and never elevates: no sudo, no package manager.
  const commands = apply.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
  assert.doesNotMatch(commands, /sudo/, 'no elevation in the installer');
  assert.doesNotMatch(commands, /apt-get|apt install|pacman|dnf|zypper|apk add/, 'Guake is never installed here');
  assert.match(commands, /2>&1/, 'the apply output is captured, not dumped into the install log');

  // Windows has no Guake: the look is not mentioned there at all.
  const ps = readFileSync(path.join(repoRoot, 'install.ps1'), 'utf8');
  assert.doesNotMatch(ps, /guake/i, 'install.ps1 stays quiet about a Linux-only terminal');
});
