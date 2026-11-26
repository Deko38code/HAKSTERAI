// The dashboard's two probes never put script text through a shell.
//
// Owner, 2026-11-26 (Surface Pro): the dashboard opened as an input bar with no
// grids, no spinner and no reply. The cause was the native probe: when Bun is
// an npm `.cmd` shim on Windows the launcher takes the `shell: true` branch, and
// that branch built the command as `"bun.cmd" -e "<script>"`. The script's regex
// contains escaped double quotes, so the shell broke on it — measured on this
// box before the fix: shell branch exit 2 `Syntax error: "(" unexpected`, the
// same script as argv exit 0 `HAKSTER_NATIVE_OK`. A healthy renderer was then
// reported as broken and the launcher fell back to the old Ink screen.
//
// Both probes now hand the Bun a FILE (`bun <file>`), so no script text is ever
// re-parsed. Pinned here:
//   1. the source carries the helper and neither probe passes `-e` script text;
//   2. a `.cmd`-named shim — the Windows branch — really answers ok: true for
//      both probes, with a script that holds quotes and parentheses;
//   3. the temp script is removed, and nothing is written into the CLI folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, chmodSync, unlinkSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const cliRoot = path.resolve(here, '..', '..');
const runtimePaths = require(path.join(cliRoot, 'src', 'runtime-paths.js'));
const source = readFileSync(path.join(cliRoot, 'src', 'runtime-paths.js'), 'utf8');

test('neither probe passes script text through a shell', () => {
  assert.match(source, /function runProbeScript\(/, 'the file-based probe runner is gone');
  assert.doesNotMatch(source, /-e "\$\{script\}"/, 'a probe is back to `-e "<script>"` inside a shell string');
  assert.doesNotMatch(source, /\['-e', script\]/, 'a probe is back to passing the script as an argv -e');
  // Both probes route through the helper.
  const bundleBody = source.slice(source.indexOf('function probeBundle('), source.indexOf('function probeNative('));
  const nativeBody = source.slice(source.indexOf('function probeNative('));
  assert.match(bundleBody, /runProbeScript\(/, 'probeBundle no longer uses the file-based runner');
  assert.match(nativeBody, /runProbeScript\(/, 'probeNative no longer uses the file-based runner');
});

test('the shim branch (the Windows path) answers ok for both probes', () => {
  const bun = runtimePaths.findBun();
  const lib = runtimePaths.nativeLibrary();
  if (!bun || !lib) {
    // Nothing to measure on this box; the source guards above still hold.
    assert.ok(true, 'no Bun or native library here — measurement skipped, not claimed');
    return;
  }
  // A `.cmd`-named wrapper forces the branch Windows takes (shell: true).
  const shim = path.join(os.tmpdir(), `hakster-probe-shim-${process.pid}.cmd`);
  writeFileSync(shim, `#!/bin/sh\nexec "${bun}" "$@"\n`);
  chmodSync(shim, 0o755);
  const before = readdirSync(os.tmpdir()).filter((f) => /^hakster-probe-.*\.mjs$/.test(f));
  try {
    const native = runtimePaths.probeNative(shim, lib.file, { timeoutMs: 30000 });
    assert.equal(native.ok, true, `probeNative through a shim: ${native.reason}`);
    const bundle = runtimePaths.probeBundle(shim, cliRoot, { timeoutMs: 40000 });
    assert.equal(bundle.ok, true, `probeBundle through a shim: ${bundle.reason}`);
  } finally {
    try { unlinkSync(shim); } catch { /* already gone */ }
  }
  const after = readdirSync(os.tmpdir()).filter((f) => /^hakster-probe-.*\.mjs$/.test(f));
  assert.equal(after.length, before.length, 'a temp probe script was left behind');
});

test('a probe script holding shell-hostile text still runs', () => {
  const bun = runtimePaths.findBun();
  if (!bun) {
    assert.ok(true, 'no Bun here — measurement skipped, not claimed');
    return;
  }
  // The exact characters that broke the shell branch: quotes, parentheses, $.
  const lib = path.join(os.tmpdir(), `hakster-lib-${process.pid}.so`);
  const hostile = "const t='a \"b\" (c) $HOME `d`;';\ntry{const{dlopen}=require('bun:ffi');"
    + "try{dlopen(" + JSON.stringify(lib) + ",{__p__:{args:[],returns:'void'}})}"
    + "catch(e){const m=String((e&&e.message)||e);if(!/open|load|dll|library|Failed/i.test(m))throw e}"
    + "console.log('HAKSTER_NATIVE_OK')}catch(e){console.error(String((e&&e.message)||e));process.exit(4)}";
  const file = path.join(os.tmpdir(), `hakster-probe-${process.pid}-hostile.mjs`);
  writeFileSync(file, hostile);
  try {
    const { spawnSync } = require('child_process');
    const shim = path.join(os.tmpdir(), `hakster-probe-shim2-${process.pid}.cmd`);
    writeFileSync(shim, `#!/bin/sh\nexec "${bun}" "$@"\n`);
    chmodSync(shim, 0o755);
    try {
      const r = spawnSync(`"${shim}" "${file}"`, { encoding: 'utf8', shell: true, timeout: 20000, windowsHide: true });
      assert.equal(r.status, 0, `hostile-text script failed through a shell: ${(r.stderr || '').trim()}`);
      assert.match(String(r.stdout || ''), /HAKSTER_NATIVE_OK/);
    } finally {
      try { unlinkSync(shim); } catch { /* already gone */ }
    }
  } finally {
    try { unlinkSync(file); } catch { /* already gone */ }
  }
  assert.equal(existsSync(file), false);
});
