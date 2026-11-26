'use strict';
/* dashboard-lane-probe.test.js — a paid Windows dashboard must say WHY it died,
 * and must find its renderer wherever npm actually put it.
 *
 * Owner, 2026-11-26 (Surface Pro): "says tui exited on my win box". The launcher's
 * report was honest but blind — it could not tell a bundle that will not parse
 * from a native package the core cannot see, and nothing on that machine could
 * be asked. Three defects sat behind it:
 *
 *   1. The launcher checked for the platform renderer from ITS directory, while
 *      @opentui/core imports it from ITS OWN. A global npm install can put the
 *      package in a tree only one of them searches, so the launcher reported
 *      "installed", the core failed to resolve it, and the dashboard died with
 *      every check above it green. → packageDir()
 *   2. Nothing asked the chosen Bun whether the bundle even loads — the one
 *      question that separates "the code is broken" from "the screen would not
 *      open". → probeBundle(), reported on crash and by `hakster doctor`
 *   3. The crash log was written under os.homedir() while the doctor read
 *      haksterDir(), so a box with a custom HAKSTER_HOME showed no log at all.
 *
 * And the fix that makes the layout stop mattering: OPENTUI_LIB_PATH points the
 * core straight at the library file we verified. Never overriding a value the
 * operator set themselves (§2, §49).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const rp = require('../runtime-paths');
const cliRoot = path.join(__dirname, '..', '..');
const src = fs.readFileSync(path.join(cliRoot, 'index.js'), 'utf8');
const entry = fs.readFileSync(path.join(cliRoot, 'tui-entry.mjs'), 'utf8');

function tmpdir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `hakster-${tag}-`));
}

// ── packageDir: ask the loader's question ───────────────────────────────────

test('packageDir finds a package that lives beside the core, not beside the launcher', () => {
  // The shape a global npm install produces: the app (and core) under the app's
  // own node_modules, the renderer next to them. The launcher's paths never
  // include that tree; core's import does.
  const root = tmpdir('pkgdir');
  const app = path.join(root, 'lib', 'node_modules', 'hakster-cli');
  fs.mkdirSync(path.join(app, 'node_modules', '@opentui', 'core'), { recursive: true });
  fs.writeFileSync(path.join(app, 'node_modules', '@opentui', 'core', 'package.json'), '{"version":"0.9.9"}');
  const renderer = path.join(app, 'node_modules', '@opentui', 'core-linux-x64');
  fs.mkdirSync(renderer, { recursive: true });
  fs.writeFileSync(path.join(renderer, 'package.json'), '{"version":"0.9.9"}');

  // A launcher whose own search would never reach the app's tree: only the core
  // location is offered for core, and only the prefix root for the renderer —
  // exactly what require.resolve.paths reports on that machine.
  const paths = (name) => (name === '@opentui/core'
    ? [path.join(app, 'node_modules')]
    : [path.join(root, 'lib', 'node_modules')]);
  assert.equal(rp.packageDir('@opentui/core-linux-x64', process.env, { paths }), renderer,
    'the renderer beside the core must be found — the core imports it from there');
  // And the plain launcher-side search still answers when that tree is empty.
  assert.equal(rp.packageDir('@opentui/core-linux-x64', process.env, { paths: () => [] }), null);
});

test('packageDir answers null for a package that is genuinely absent', () => {
  assert.equal(rp.packageDir('@opentui/core-not-a-real-platform'), null);
});

// ── nativeLibrary: the exact file the core will dlopen ──────────────────────

test('nativeLibrary names the packaged library file and proves it exists', { skip: process.platform !== 'linux' }, () => {
  const lib = rp.nativeLibrary();
  if (!lib) return; // no renderer in this tree: nothing to prove, nothing to guess
  assert.ok(fs.existsSync(lib.file), 'the returned library path does not exist: ' + lib.file);
  assert.match(path.basename(lib.file), /^libopentui\.so$/, 'the library name does not match the core\'s own import');
  assert.ok(lib.file.startsWith(lib.dir), 'the library file must sit inside the package that declares it');
});

test('the launcher hands that file to the renderer, and never overrides the operator', () => {
  assert.ok(/spawnEnv\.OPENTUI_LIB_PATH\s*=\s*nativeLib\.file/.test(src),
    'the launcher no longer points the core at the library it resolved');
  assert.ok(/!\s*spawnEnv\.OPENTUI_LIB_PATH/.test(src),
    'the handoff must not overwrite a value the operator set themselves');
  assert.ok(/nativeLibrary\(\)/.test(src), 'the library is never resolved before the spawn');
});

// ── probeBundle: the question only Bun can answer ───────────────────────────

test('probeBundle asks the real bundle to load, and reports the real reason when it cannot', () => {
  const bun = rp.findSupportedBun([1, 3, 14]);
  if (!bun.path) return; // no Bun on this box: the lane itself is the answer
  const good = rp.probeBundle(bun.path, cliRoot, { timeoutMs: 30000 });
  assert.equal(good.ok, true, 'the shipped bundle must import under the Bun the launcher would pick: ' + good.reason);

  const empty = tmpdir('probe-empty');
  const bad = rp.probeBundle(bun.path, empty, { timeoutMs: 30000 });
  assert.equal(bad.ok, false, 'a directory with no bundle must not be reported as loading');
  assert.ok(/ui-fb\.mjs/.test(bad.reason), 'the probe must name what it could not find, not just fail: ' + bad.reason);
});

test('a crash reports the probe verdict, the machine and the install dir — not just an exit code', () => {
  const died = src.slice(src.indexOf('const dashboardDied'), src.indexOf("child.on('close'"));
  assert.ok(/probeBundle\(/.test(died), 'the crash path no longer asks whether the bundle loads');
  assert.ok(/bundle loads under that Bun:/.test(died), 'the report does not state the probe verdict');
  assert.ok(/process\.platform\}\s*\$\{process\.arch\}/.test(died), 'the report does not name the platform and arch');
  assert.ok(/native lib:/.test(died), 'the report does not name the library file it handed the core');
});

test('the crash log is the file "hakster doctor" reads', () => {
  const died = src.slice(src.indexOf('const dashboardDied'), src.indexOf("child.on('close'"));
  assert.ok(/path\.join\(haksterDir\(\),\s*'logs'\)/.test(died),
    'the crash log must be written under haksterDir(), which honours HAKSTER_HOME');
  assert.ok(!/os\.homedir\(\)/.test(died),
    'writing under os.homedir() puts the log where the doctor never looks');
});

// ── tui-entry: a renderer failure is never silent ───────────────────────────

test('the Bun entry awaits the start and prints one clear line when it fails', () => {
  assert.ok(/await start\(/.test(entry), 'start() must be awaited, or a failure is an unhandled rejection');
  assert.ok(/dashboard failed to start:/.test(entry), 'the entry prints no reason for a failed start');
  assert.ok(/process\.exitCode\s*=\s*1/.test(entry), 'a failed start must exit non-zero for the launcher to report it');
});
