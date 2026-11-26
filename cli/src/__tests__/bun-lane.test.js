'use strict';
/* bun-lane.test.js — an old Bun must never be reported as ready.
 *
 * Owner, 2026-11-26 (Surface Pro): "windows install for paid users its not
 * working all the way only shows input missing all other grids on powershell".
 * That screen is the Ink fallback, and the chain that produced it was:
 *
 *   installer  →  "OK Bun is already here"  (any version, never measured)
 *   launcher   →  refuses that Bun for being below the dashboard's floor
 *   result     →  input bar only, while every step said success
 *
 * So three things are pinned here:
 *   1. the locator prefers a Bun the renderer can actually use, and reports
 *      what it refused instead of silently taking the first one it finds;
 *   2. both installers measure the version instead of trusting presence;
 *   3. the reason for the fallback is written down, so it survives the Ink
 *      alternate screen and `hakster doctor` can show it.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const rp = require('../runtime-paths.js');

const CLI_DIR = path.join(__dirname, '..', '..');
const REPO_DIR = path.join(CLI_DIR, '..');
const read = (p) => fs.readFileSync(path.join(CLI_DIR, p), 'utf8');

const FLOOR = [1, 3, 14];

/** A fake Bun that answers --version with `version` (POSIX hosts). */
function fakeBun(dir, version) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'bun');
  fs.writeFileSync(file, `#!/bin/sh\necho ${version}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

function fixture({ pathBun, runtimeBun } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hakster-bun-'));
  const binDir = path.join(root, 'path-bin');
  fs.mkdirSync(binDir, { recursive: true });
  if (pathBun) fakeBun(binDir, pathBun);
  if (runtimeBun) fakeBun(path.join(root, 'runtime', 'bun', 'node_modules', 'bun', 'bin'), runtimeBun);
  const env = { PATH: `${binDir}${path.delimiter}/usr/bin${path.delimiter}/bin`, HAKSTER_RUNTIME: path.join(root, 'runtime'), HOME: root };
  return { root, env };
}

test('an old Bun on PATH does not shadow a supported one in our runtime', () => {
  const { env } = fixture({ pathBun: '1.1.30', runtimeBun: '1.4.5' });
  const pick = rp.findSupportedBun(FLOOR, env);
  assert.equal(pick.version.join('.'), '1.4.5', 'the usable Bun was not chosen');
  assert.match(pick.path, /runtime[\\/]bun[\\/]node_modules[\\/]bun[\\/]bin/, 'a skipped Bun was returned as the pick');
  assert.equal((pick.skipped || []).length, 1, 'the refused Bun is not reported');
  assert.equal(pick.skipped[0].version.join('.'), '1.1.30');
});

test('with only an old Bun, nothing is claimed usable and it is named', () => {
  const { env } = fixture({ pathBun: '1.2.9' });
  const pick = rp.findSupportedBun(FLOOR, env);
  assert.equal(pick.path, null, 'an unsupported Bun was returned as the pick');
  assert.equal((pick.skipped || [])[0].version.join('.'), '1.2.9', 'the refused Bun is not named');
});

test('exactly at the floor counts, one patch below does not', () => {
  assert.equal(rp.atLeast([1, 3, 14], FLOOR), true);
  assert.equal(rp.atLeast([1, 3, 13], FLOOR), false);
  assert.equal(rp.atLeast([2, 0, 0], FLOOR), true);
  assert.equal(rp.atLeast([1, 2, 99], FLOOR), false, 'a minor below the floor must not pass on a higher patch');
});

test('a Bun that will not answer --version is measured as unknown, never as fine', () => {
  const { root } = fixture({});
  const silent = path.join(root, 'silent-bun');
  fs.writeFileSync(silent, '#!/bin/sh\nexit 1\n');
  fs.chmodSync(silent, 0o755);
  assert.equal(rp.bunVersion(silent), null);
});

// ── the installers must measure, not assume ────────────────────────────────

test('both installers gate on the renderer\'s Bun floor', () => {
  const sh = fs.readFileSync(path.join(REPO_DIR, 'install.sh'), 'utf8');
  assert.ok(/BUN_MIN="1\.3\.14"/.test(sh), 'install.sh no longer declares the Bun floor');
  assert.ok(/bun_usable\(\)/.test(sh), 'install.sh no longer tests a Bun before using it');
  assert.ok(/bun_usable "\$\(command -v bun\)"/.test(sh), 'the PATH Bun is used without a version test');
  assert.ok(/older than the dashboard's \$BUN_MIN/.test(sh), 'an old Bun is no longer reported as too old');

  const ps1 = fs.readFileSync(path.join(REPO_DIR, 'install.ps1'), 'utf8');
  assert.ok(/\$MinBun = @\(1, 3, 14\)/.test(ps1), 'install.ps1 no longer declares the Bun floor');
  assert.ok(/function Find-UsableBun/.test(ps1), 'install.ps1 picks a Bun without measuring it');
  assert.ok(/function Test-BunUsable/.test(ps1), 'install.ps1 has no usable-version test');
  assert.ok(/function Bun-Candidates/.test(ps1), 'install.ps1 no longer lists every Bun location in one place');
  // Every place that decides which Bun to use goes through the measuring picker
  // (one definition + the preflight + the install decision + the post-install check).
  const calls = ps1.match(/Find-UsableBun/g) || [];
  assert.ok(calls.length >= 4, `Find-UsableBun is used ${calls.length} times — a decision point still trusts presence`);
  assert.ok(/older than the dashboard's/.test(ps1), 'an old Bun is no longer reported as too old on Windows');
});

// ── the reason must survive the screen it is printed on ────────────────────

test('the fallback reason is written down, not just printed', () => {
  const launcher = read('index.js');
  assert.ok(/noteDashboard/.test(launcher), 'the fallback reason is no longer recorded');
  assert.ok(/dashboard-tui\.log/.test(launcher), 'nothing names the file the reason is kept in');
  assert.ok(/findSupportedBun/.test(launcher), 'the launcher no longer measures Bun candidates');
  const m = launcher.match(/const MIN_BUN = \[(\d+),\s*(\d+),\s*(\d+)\]/);
  assert.ok(m, 'the launcher no longer declares the Bun floor');
  assert.deepEqual([Number(m[1]), Number(m[2]), Number(m[3])], FLOOR);
});

test('hakster doctor exists, and it answers the lane question', () => {
  const doctor = require('../doctor.js');
  assert.equal(typeof doctor.report, 'function');
  assert.equal(typeof doctor.lane, 'function');
  const lines = doctor.report().join('\n');
  assert.match(lines, /bun floor\s+1\.3\.14/, 'doctor does not state the Bun floor');
  assert.match(lines, /renderer\s+@opentui\/core/, 'doctor does not report the renderer');
  assert.match(lines, /dashboard\s+will (start|NOT start)/, 'doctor does not state the lane result');
  // read-only: the report must never print a key value (§9, §23)
  assert.ok(!/apiKey|sk_|Bearer\s+\w{8}/.test(lines), 'doctor printed credential material');
});
