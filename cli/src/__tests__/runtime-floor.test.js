'use strict';
/*
 * The Bun floor is per machine, and the renderer is loaded before the screen.
 *
 * Owner, 2026-11-26 (Surface Pro): the paid CLI opened with an input bar, no
 * grids, and nothing answering. Two defects made that possible and both are
 * pinned here:
 *
 *   1. a flat `bun >= 1.3.14` floor, while the dashboard's renderer is a native
 *      library loaded through bun:ffi and Bun 1.3 has no FFI on Windows arm64 —
 *      so an arm64 Surface Pro accepted a Bun that cannot load the renderer;
 *   2. only the BUNDLE was probed, never the library — a Bun that imports the
 *      JavaScript and dies at the first native call reported "loads: yes".
 *
 * The fix must be a reading, not a guess: this asserts the floor, asserts the
 * launcher and the doctor both ask for it, and runs the real dlopen probe both
 * ways (a good library loads, a bogus one is refused with a reason).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const rp = require('../runtime-paths');
const doctor = require('../doctor');

const CLI_DIR = path.resolve(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(CLI_DIR, p), 'utf8');

test('Windows on ARM needs Bun 1.4.0 — 1.3 has no FFI there', () => {
  assert.deepStrictEqual(rp.minBunFor('win32', 'arm64'), [1, 4, 0]);
});

test("every other machine keeps the renderer's own 1.3.14 floor", () => {
  for (const [platform, arch] of [
    ['win32', 'x64'], ['linux', 'x64'], ['linux', 'arm64'], ['darwin', 'x64'], ['darwin', 'arm64'],
  ]) {
    assert.deepStrictEqual(rp.minBunFor(platform, arch), [1, 3, 14], `${platform} ${arch}`);
  }
});

test('a 1.3.x Bun is refused on Windows arm64 and accepted elsewhere', () => {
  assert.strictEqual(rp.atLeast([1, 3, 20], rp.minBunFor('win32', 'arm64')), false);
  assert.strictEqual(rp.atLeast([1, 4, 0], rp.minBunFor('win32', 'arm64')), true);
  assert.strictEqual(rp.atLeast([1, 3, 20], rp.minBunFor('win32', 'x64')), true);
});

test('the launcher computes the floor instead of hardcoding one number', () => {
  const src = read('index.js');
  assert.match(src, /minBunFor\(\)/, 'the launcher must ask minBunFor()');
  assert.match(src, /MIN_BUN = rpFloor\.minBunFor\(\)/);
});

test('the doctor reports the floor the launcher actually enforces', () => {
  assert.deepStrictEqual(doctor.minBun(), rp.minBunFor());
});

test('the installer floors Bun at 1.4.0 on arm64 and reuses that one answer', () => {
  const ps1 = read('../install.ps1');
  assert.match(ps1, /\$IsWinArm64 = \$false/);
  assert.match(ps1, /\$MinBun = if \(\$IsWinArm64\) \{ @\(1, 4, 0\) \} else \{ @\(1, 3, 14\) \}/);
  assert.match(ps1, /\$otArch = if \(\$IsWinArm64\) \{ 'arm64' \} else \{ 'x64' \}/);
  // Only ONE architecture probe: a second copy is how the two can disagree.
  const probes = ps1.match(/RuntimeInformation\]::OSArchitecture/g) || [];
  assert.strictEqual(probes.length, 1, `found ${probes.length} arch probes`);
});

test('the renderer is loaded BEFORE the dashboard takes the screen', () => {
  const src = read('index.js');
  const probeAt = src.indexOf('nativeProbe = rpNative.probeNative');
  const spawnAt = src.indexOf('const child = viaShell');
  assert.ok(probeAt > 0, 'the launcher does not load the renderer before starting it');
  assert.ok(spawnAt > probeAt, 'the native probe must run before the dashboard process is spawned');
  // A failure must be visible on the operator's own screen, not only in a log.
  assert.match(src, /renderer will not load under this Bun/);
});

test('the native probe refuses a library that cannot load, and names why', (t) => {
  const pick = rp.findSupportedBun(rp.minBunFor());
  if (!pick || !pick.path) { t.skip('no Bun on this machine'); return; }
  const bogus = path.join(os.tmpdir(), `hakster-no-such-renderer-${process.pid}.so`);
  const r = rp.probeNative(pick.path, bogus, { timeoutMs: 15000 });
  assert.strictEqual(r.ok, false);
  assert.ok(r.reason && r.reason.length > 0, 'a refused load must carry a reason');
});

test('the native probe passes the renderer this machine actually runs on', (t) => {
  const pick = rp.findSupportedBun(rp.minBunFor());
  const lib = rp.nativeLibrary();
  if (!pick || !pick.path) { t.skip('no Bun on this machine'); return; }
  if (!lib) { t.skip('no OpenTUI platform package in this tree'); return; }
  // The other half of the proof: the probe must not refuse a working renderer,
  // or it would replace every launch with a false failure.
  const r = rp.probeNative(pick.path, lib.file, { timeoutMs: 15000 });
  assert.strictEqual(r.ok, true, r.reason);
});
