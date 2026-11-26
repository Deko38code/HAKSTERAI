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
  assert.match(src, /pack --silent --pack-destination/, 'the CLI must be installed from a packed tarball, never a link into the temp dir');
  const commands = src.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
  assert.doesNotMatch(commands, /npm install -g \./, 'a directory install links back into the temp dir and breaks on cleanup');
});

test('the Windows installer verifies its download and installs per-user', () => {
  const src = readFileSync(path.join(repoRoot, 'install.ps1'), 'utf8');
  assert.match(src, /SHASUMS256\.txt/);
  assert.match(src, /Get-FileHash .*SHA256/, 'the Node zip must be hashed and compared');
  assert.match(src, /'pack', '--silent', '--pack-destination'/, 'pack then install the tarball');
  assert.match(src, /'-g', \$pkgPath, '--prefix', \$NpmPrefix/, 'Windows installs into a per-user prefix, no admin');
  // Owner, 2026-11-26: the Surface Pro install died with "The term 'npm' is not
  // recognized as the name of a cmdlet" one line after node reported OK. A name
  // Get-Command can find is not proof npm runs, so the command must be proven by
  // running it, with node's own npm-cli.js as the shim-free fallback, and a
  // native call that never started must not be reported as exit 0.
  assert.match(src, /function Get-NpmCommand/, 'npm is resolved by running it, not by name');
  assert.match(src, /function Test-NpmRuns/, 'each candidate is proven with --version');
  assert.match(src, /node_modules\\npm\\bin\\npm-cli\.js/, 'node + npm-cli.js is the no-shim fallback');
  assert.match(src, /cmd \/c npm/, 'cmd.exe is the PATHEXT/policy-proof fallback');
  assert.match(src, /\$global:LASTEXITCODE = \$null/, 'a native call that never starts must not keep a stale 0');
  assert.match(src, /could not be started/, 'a command that never started says so, never "npm exited 0"');
  assert.match(src, /win-x64/, 'x64 Windows');
  assert.match(src, /win-arm64/, 'ARM64 Windows');
});

test('neither installer touches the user\'s own Claude Code config', () => {
  for (const name of ['install.sh', 'install.ps1']) {
    const src = readFileSync(path.join(repoRoot, name), 'utf8');
    assert.doesNotMatch(src, /\.claude(\/|\\)/, `${name} must never read or write ~/.claude`);
  }
});

test('the installer checks what the machine already has — only the gaps are fetched', () => {
  // Owner, 2026-11-26: "on install our cli checks for missing guake node claude
  // code etc for fast instal". Each installer prints one read-only pass before
  // anything is downloaded, so the install only brings what is missing.
  const src = readFileSync(path.join(repoRoot, 'install.sh'), 'utf8');
  const start = src.indexOf('── what this machine already has');
  const check = src.slice(start, src.indexOf('BOOTSTRAPPED=no'));
  assert.ok(start > 0, 'the check block exists');
  assert.ok(start < src.indexOf('nodejs.org/dist'), 'it runs before any download');
  for (const part of ['node', 'bun', 'guake', 'claude code', 'hakster CLI']) {
    assert.ok(check.includes(part), `the report covers ${part}`);
  }
  assert.match(src, /^usable_claude\(\) \{/m, 'Claude Code detection has its own lookup');
  assert.match(src, /-gt 4096/, 'the package\'s ~500-byte stub is not counted as a real binary');
  assert.match(check, /\.hakster\/claude-code/, 'our private prefix is checked, like claude-code-provision.js');
  assert.match(check, /hakster claude/, 'a missing Claude Code points at the command that sets it up');
  assert.match(check, /paid plan/, 'and never promises a free download');
  // The pass is lookups only: it fetches, installs and starts nothing.
  assert.doesNotMatch(check, /fetch |npm install|curl |wget |HAKSTER_BIN/, 'the check is read-only');
  // Same pass on Windows, and no Guake there (Linux terminal only).
  const ps = readFileSync(path.join(repoRoot, 'install.ps1'), 'utf8');
  const psStart = ps.indexOf('── what this machine already has');
  const psCheck = ps.slice(psStart, ps.indexOf('# ── Node.js'));
  assert.ok(psStart > 0, 'the Windows installer checks too');
  for (const part of ['node', 'bun', 'claude code', 'hakster CLI']) assert.ok(ps.includes(part));
  assert.match(psCheck, /\$HOME '\.hakster\\claude-code/, 'the same private prefix is checked on Windows');
  assert.match(psCheck, /hakster claude/, 'and the same provisioning command is offered');
  assert.doesNotMatch(psCheck, /guake/i, 'Windows has no Guake to check');
});

test('the full install brings Guake, painted — without guessing a password', () => {
  // Owner, 2026-11-26: "make sure guake come with the full install painted and
  // all". The package carries the profile and the backdrop; the installer
  // installs Guake where it can run and then applies our look through
  // `hakster quake --setup` (Guake's own import, previous profile backed up).
  const src = readFileSync(path.join(repoRoot, 'install.sh'), 'utf8');
  const install = src.slice(src.indexOf('The full install brings the drop-down'), src.indexOf('# The look comes with the install'));
  const look = src.slice(src.indexOf('# The look comes with the install'), src.indexOf('say "Next:'));

  // Where it can run, and only when it is missing.
  assert.match(install, /\[ "\$\(uname -s\)" = Linux \]/, 'Linux only');
  assert.match(install, /DISPLAY:-/, 'a graphical session is required');
  assert.match(install, /! command -v guake >\/dev\/null 2>&1/, 'never reinstalls a Guake that is there');
  // The package manager is chosen from the distribution, not assumed.
  for (const hint of ['apt-get install -y guake', 'pacman -S --noconfirm guake', 'dnf install -y guake', 'zypper', 'apk add guake']) {
    assert.ok(install.includes(hint), `has a real command for ${hint}`);
  }
  // A password is never captured: no -S, no piped echo into sudo.
  assert.doesNotMatch(install, /sudo -S/, 'never feeds sudo a password');
  assert.doesNotMatch(install, /echo .*\|\s*sudo/, 'never pipes a password into sudo');
  // The prompt only appears when a human is watching, and "n" is honoured.
  assert.match(install, /\[ -t 1 \] && \[ -c \/dev\/tty \]/, 'prompts only on a real terminal');
  assert.match(install, /n\|N\|no\|NO\) GUAKE_SKIPPED=yes/, 'a declined install is skipped, not retried');
  assert.match(install, /Guake: skipped/, 'and it says so');
  assert.match(install, /Guake: not installed — 'sudo/, 'no terminal prints the exact command instead');

  // The look is applied by the shipped CLI, and a failure tells you the fix.
  assert.match(look, /elif command -v guake >\/dev\/null 2>&1; then/);
  assert.match(look, /"\$HAKSTER_BIN" quake --setup/);
  assert.match(look, /Guake look applied/, 'a real apply is claimed only when it reports one');
  assert.match(look, /hakster quake --setup --repair/, 'a failure is reported with the way to fix it');
  assert.match(look, /HAKSTER_NO_QUAKE/, 'an operator can opt out');

  // Windows has no Guake: the look is not mentioned there at all.
  const ps = readFileSync(path.join(repoRoot, 'install.ps1'), 'utf8');
  assert.doesNotMatch(ps, /guake/i, 'install.ps1 stays quiet about a Linux-only terminal');
});
