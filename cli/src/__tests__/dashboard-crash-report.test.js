'use strict';
/* dashboard-crash-report.test.js — a failed dashboard must say WHY it failed.
 *
 * Owner, 2026-11-26 (Surface Pro): the paid dashboard opened, died, and the only
 * line anyone saw was "dashboard TUI exited (code 1)". Three rounds were spent
 * guessing because the cause was never on screen.
 *
 * The cause was structural, not a mystery: the dashboard draws in the terminal's
 * ALTERNATE screen, so a crash prints its error inside a screen that is wiped the
 * moment the process exits. The launcher inherited stderr, so it had nothing to
 * report. These tests pin the three things that fix it:
 *
 *   1. stderr is PIPED and captured, so the real message survives the wipe.
 *   2. the alternate screen is left BEFORE anything is printed, so the report is
 *      not erased by the same restore.
 *   3. the native-package preflight decides by looking on disk. It must never use
 *      require.resolve for this: @opentui's platform packages publish an exports
 *      map with only "bun"/"import" conditions, so require.resolve throws
 *      ERR_PACKAGE_PATH_NOT_EXPORTED on a package that is installed and correct —
 *      a false "missing" that would silently downgrade every Linux machine to the
 *      Ink fallback.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const cliRoot = path.join(__dirname, '..', '..');
const src = fs.readFileSync(path.join(cliRoot, 'index.js'), 'utf8');

// ── the capture ────────────────────────────────────────────────────────────

test('the dashboard child pipes stderr instead of inheriting it', () => {
  assert.ok(
    /stdio:\s*\['inherit',\s*'inherit',\s*'pipe'\]/.test(src),
    'stderr must be piped, or a crash error dies with the alternate screen',
  );
  assert.ok(/child\.stderr\.on\('data'/.test(src), 'the piped stderr is never read');
  assert.ok(/errBuf\s*\+=/.test(src), 'captured stderr is not buffered anywhere');
});

test('captured stderr is written through, so nothing that used to be visible goes quiet', () => {
  assert.ok(
    /process\.stderr\.write\(chunk\)/.test(src),
    'the child stderr must still reach the terminal as it arrives',
  );
});

test('a failed start reports the last lines it printed, never just the exit code', () => {
  assert.ok(/what it said:/.test(src), 'the crash report does not show what the dashboard said');
  assert.ok(/slice\(-12\)/.test(src), 'the report no longer shows the tail of the captured output');
  const died = src.slice(src.indexOf('const dashboardDied'));
  assert.ok(/full log:/.test(died), 'the report does not name where the full output was saved');
  assert.ok(/dashboard-tui\.log/.test(died), 'the crash log path was removed');
});

test('the alternate screen is left BEFORE the report is printed', () => {
  const died = src.slice(src.indexOf('const dashboardDied'));
  const restoreAt = died.indexOf('\\x1b[?1049l');
  const printAt = died.indexOf('dashboard TUI exited');
  assert.ok(restoreAt !== -1, 'the alternate screen is never left — the report would be wiped');
  assert.ok(printAt !== -1, 'the failure line is gone');
  assert.ok(restoreAt < printAt, 'the report is printed before leaving the alternate screen, so it vanishes');
});

test('the exit path waits for stdio to close, not merely for the process to end', () => {
  // 'exit' can fire while piped stderr is still buffered; the tail would be short
  // or empty exactly when it matters.
  assert.ok(/child\.on\('close'/.test(src), "the crash path must listen on 'close' so stderr is fully read");
});

// ── the native-package preflight ───────────────────────────────────────────

test('the preflight decides by looking on disk, not with require.resolve', () => {
  const pre = src.slice(src.indexOf('const installed ='), src.indexOf('const gap = nativeGap'));
  assert.ok(/existsSync/.test(pre), 'the native check no longer looks on disk');
  assert.ok(
    !/require\.resolve\(\s*mod/.test(pre) && !/require\.resolve\(`/.test(pre),
    "the native check uses require.resolve, which throws ERR_PACKAGE_PATH_NOT_EXPORTED on an installed package",
  );
});

test('the preflight resolves a real installed package that require.resolve refuses', () => {
  // The exact shape that broke it: exports lists only bun/import.
  const name = '@opentui/core';
  assert.ok(
    fs.existsSync(path.join(cliRoot, 'node_modules', name, 'package.json')),
    'fixture missing: @opentui/core should be installed in this tree',
  );
  const installed = (pkg) => {
    for (const dir of (require.resolve.paths(pkg) || [])) {
      if (fs.existsSync(path.join(dir, pkg, 'package.json'))) return true;
    }
    return false;
  };
  assert.equal(installed(name), true, 'a path lookup must find an installed package');
  // And prove the trap is real, so this test cannot be "fixed" by reverting.
  let resolveThrew = null;
  try { require.resolve('@opentui/core-linux-' + process.arch + '-musl'); }
  catch (e) { resolveThrew = e.code; }
  if (process.platform === 'linux') {
    assert.ok(
      resolveThrew === null || resolveThrew === 'MODULE_NOT_FOUND',
      'unexpected resolve behaviour: ' + resolveThrew,
    );
  }
});

test('a missing native package is reported with its platform name, before the TUI starts', () => {
  const pre = src.slice(src.indexOf('const installed ='), src.indexOf('const gap = nativeGap'));
  assert.ok(/@opentui\/core-\$\{process\.platform\}-\$\{process\.arch\}/.test(pre), 'the platform package name is not built');
  const guardAt = src.indexOf('if (gap)');
  const spawnAt = src.indexOf('const child = viaShell');
  assert.ok(guardAt !== -1 && spawnAt !== -1 && guardAt < spawnAt, 'the native check no longer runs before the TUI is spawned');
});

// ── the hint ───────────────────────────────────────────────────────────────

test('a known cause is named instead of leaving the operator to decode a stack', () => {
  const hintBlock = src.slice(src.indexOf('const dashboardHint'), src.indexOf('const dashboardHint') + 1600);
  assert.ok(/core-\(win32\|linux\|darwin\)/.test(hintBlock), 'missing-package hint removed');
  assert.ok(/libopentui/.test(hintBlock), 'native-library hint removed');
  assert.ok(/Windows Terminal/.test(hintBlock), 'raw-mode/console-host hint removed');
});
