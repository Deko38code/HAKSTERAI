/* The Windows flow carries a real secrets gate, not a permanent grey note.
 *
 * Owner, 2026-11-26: "windows flow is only thing left linux flow work we need
 * to ace this".
 *
 * The gap: `~/bin/secret-scan.sh` is POSIX shell, so a Windows package install
 * had no scanner, and the start card's `secrets gate` rail could never be green
 * there — a security rail that was permanently unproven for a whole platform
 * (§48). The package now ships `src/secret-scan.js` with the same rules, and the
 * rail PROVES it in-process by catching a fixture.
 *
 * Pinned here:
 *   1. the bundled scanner catches each hard rule family on a fixture;
 *   2. the canonical safe form (process.env.NAME) and placeholder-looking lines
 *      stay clean — a gate that flags everything proves nothing;
 *   3. values are never echoed: only `file:line rule` comes out;
 *   4. the git modes answer 0 clean / 1 findings on a real temp repo;
 *   5. on a stubbed win32 box with an empty home, the secrets rail is green and
 *      scored — not optional, not "not on Windows".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '..', '..');
const SCANNER = path.join(CLI, 'src', 'secret-scan.js');
const GUARD = require.resolve('../../src/guardrail-check.js');

function tmp(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hakster-win-' + tag + '-'));
}

/** A fake credential assembled at runtime, so this file never carries a
 *  key-shaped literal that our own scan would (correctly) flag. */
const fake = {
  anthropic: 'sk-ant-' + 'A'.repeat(30),
  github: 'ghp_' + 'B'.repeat(36),
  openai: 'sk-' + 'C'.repeat(40),
  google: 'AIzaSy' + 'D'.repeat(33),
  aws: 'AKIA' + 'E'.repeat(16),
  stripe: 'sk_live_' + 'F'.repeat(24),
};

test('every hard rule family is caught on a fixture', () => {
  const scan = require(SCANNER);
  for (const [rule, value] of Object.entries(fake)) {
    const hits = scan.scanText('const k = "' + value + '"');
    assert.ok(hits.length, 'no hit for ' + rule);
    assert.equal(hits[0].rule, rule, 'wrong rule for ' + rule);
    assert.equal(hits[0].tier, 'hard');
  }
});

test('the safe form and placeholders stay clean', () => {
  const scan = require(SCANNER);
  assert.equal(scan.scanText('const k = process.env.ANTHROPIC_API_KEY').length, 0);
  assert.equal(scan.scanText('AKIAIOSFODNN7EXAMPLE').length, 0);
  assert.equal(scan.scanText('// your_key = "..."').length, 0);
});

test('only file:line and the rule name are printed, never the value', () => {
  const dir = tmp('quiet');
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const g = (args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  g(['init', '-q', '.']);
  g(['config', 'user.email', 't@t']);
  g(['config', 'user.name', 't']);
  fs.writeFileSync(path.join(repo, 'leak.js'), 'const k = "' + fake.anthropic + '";\n');
  g(['add', 'leak.js']);
  const r = spawnSync(process.execPath, [SCANNER, '--staged'], { cwd: repo, encoding: 'utf8' });
  assert.equal(r.status, 1, 'a staged leak must fail the scan');
  assert.match(r.stdout, /anthropic\s+leak\.js:1/);
  assert.ok(!r.stdout.includes(fake.anthropic), 'the value must never be printed');
  assert.ok(!r.stdout.includes('AAAA'), 'no fragment of the value may appear');
});

test('git modes answer 0 clean and 1 on a committed leak', () => {
  const dir = tmp('modes');
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const g = (args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  g(['init', '-q', '.']);
  g(['config', 'user.email', 't@t']);
  g(['config', 'user.name', 't']);
  fs.writeFileSync(path.join(repo, 'a.js'), 'const a = 1;\n');
  g(['add', 'a.js']);
  g(['commit', '-qm', 'init']);
  const clean = spawnSync(process.execPath, [SCANNER, '--tree'], { cwd: repo, encoding: 'utf8' });
  assert.equal(clean.status, 0, 'clean tree must pass: ' + clean.stdout);
  fs.writeFileSync(path.join(repo, 'b.js'), 'const k = "' + fake.github + '";\n');
  g(['add', 'b.js']);
  g(['commit', '-qm', 'leak']);
  const dirty = spawnSync(process.execPath, [SCANNER, '--commits', 'HEAD~1..HEAD'], { cwd: repo, encoding: 'utf8' });
  assert.equal(dirty.status, 1, 'a committed leak must fail');
  assert.match(dirty.stdout, /github\s+b\.js:1/);
});

test('deep mode catches an unknown key format by value', () => {
  const dir = tmp('deep');
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const g = (args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  g(['init', '-q', '.']);
  g(['config', 'user.email', 't@t']);
  g(['config', 'user.name', 't']);
  const live = 'ZQ7f9k2m4p8s1v';
  fs.writeFileSync(path.join(repo, 'conf.js'), 'const x = "' + live + '";\n');
  g(['add', 'conf.js']);
  g(['commit', '-qm', 'conf']);
  const values = path.join(dir, 'secrets.env');
  fs.writeFileSync(values, 'ODD_KEY=' + live + '\n');
  const r = spawnSync(process.execPath, [SCANNER, '--tree', '--deep'], {
    cwd: repo, encoding: 'utf8', env: { ...process.env, SECRET_VALUES_FILE: values, SECRET_SCAN_ALLOW: '/nonexistent' },
  });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /LIVE:ODD_KEY\s+conf\.js:1/);
  assert.ok(!r.stdout.includes(live));
});

test('on a stubbed win32 box with an empty home the rail is green and scored', () => {
  const home = tmp('home');
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  let mod;
  try {
    delete require.cache[GUARD];
    delete require.cache[require.resolve('../../src/secret-scan.js')];
    mod = require(GUARD);
  } finally {
    if (realPlatform) Object.defineProperty(process, 'platform', realPlatform);
    process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
  }
  const rail = mod.runGuardrailCheck().items.find((i) => i.id === 'secrets');
  assert.ok(rail, 'the secrets rail must exist');
  assert.equal(rail.ok, true, 'the bundled scanner must satisfy the rail: ' + rail.detail);
  assert.equal(rail.optional, false, 'the gate is scored on Windows, not a grey note');
  assert.match(rail.detail, /bundled scanner/);
  assert.doesNotMatch(rail.detail, /not on Windows/);
});

test('HOME is pinned from home-dir before the modules that read it load', () => {
  const src = fs.readFileSync(path.join(CLI, 'index.js'), 'utf8');
  const pin = src.indexOf('process.env.HOME = resolveHomeRoot()');
  const providers = src.indexOf("const providers = require('./providers')");
  assert.ok(pin > 0, 'index.js must pin HOME');
  assert.ok(providers > pin, 'the pin must run before providers/tools/memory are required');
  // A Windows box leaves HOME unset; the pin must not be conditional on win32
  // only — it applies wherever HOME is missing or HAKSTER_HOME overrides it.
  assert.match(src, /if \(!process\.env\.HOME \|\| process\.env\.HAKSTER_HOME\)/);
});

test('shipped modules never fall back to the owner’s home directory', () => {
  for (const rel of ['memory.js', 'providers.js', 'tools.js']) {
    const src = fs.readFileSync(path.join(CLI, rel), 'utf8');
    assert.doesNotMatch(src, /process\.env\.HOME \|\| '\/home\/ghost'/, rel + ' still falls back to the owner home');
    assert.match(src, /process\.env\.HOME \|\| (os|require\('os'\))\.homedir\(\)/, rel + ' needs a platform fallback');
  }
});

test('the trust list and repo scan come from this machine, not a hardcoded tree', () => {
  const src = fs.readFileSync(path.join(CLI, 'memory.js'), 'utf8');
  assert.match(src, /const trusted = \[HOME, path\.join\(HOME, 'workspace'\), os\.tmpdir\(\)\]/);
  assert.match(src, /const scanDirs = \[HOME, path\.join\(HOME, 'workspace'\), process\.cwd\(\)\]/);
  // Legacy owner paths may still be honoured, but only when they exist.
  assert.match(src, /if \(fs\.existsSync\(legacy\) && !trusted\.includes\(legacy\)\) trusted\.push\(legacy\)/);
});

test('the TUI entry pins the same home root before the bundle loads', () => {
  const src = fs.readFileSync(path.join(CLI, 'tui-entry.mjs'), 'utf8');
  const pin = src.indexOf('process.env.HOME = homeDirPkg.homeDir()');
  const bundle = src.indexOf("await import('./ui-fb.mjs')");
  assert.ok(pin > 0, 'tui-entry must pin HOME');
  assert.ok(bundle > pin, 'the pin must run before ui-fb.mjs is imported');
});

test('the bundled scanner is listed in the package files, so it installs', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(CLI, 'package.json'), 'utf8'));
  // `src/` already covers it; this pins that the gate cannot ship empty.
  assert.ok((pkg.files || []).some((f) => f === 'src/' || f.startsWith('src/')), 'package ships src/');
  assert.ok(fs.existsSync(SCANNER), 'src/secret-scan.js exists in the tree');
});
