/* A session that cannot read its own version must say "unknown", never "pull".
 *
 * Owner, 2026-11-26: "mint says this still dell dosnt update v0.3.68 · pull to
 * update" — on a tree that was already v0.3.68. The staged record behind that
 * badge was taken with `runningVersion: "0.0.0"`: the launch path had resolved
 * to a directory with no CLI package.json, so every published release compared
 * as "newer than 0.0.0" and the header offered an update that did not exist
 * (§10 no false claims, §44.3 an unknown count never blocks or invents).
 *
 * Pinned here:
 *   1. checkForUpdate reports `unknown` and writes nothing when the running
 *      version cannot be read;
 *   2. pendingInfo marks such a record `unknown` so no startup screen paints a
 *      badge from it;
 *   3. applyPending refuses — the copy target would be whatever directory the
 *      process happened to start in;
 *   4. cliDirOf falls back to a directory that really holds a version.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const UPDATER = require.resolve('../../src/updater.js');
const HOOK = path.join(here, '..', 'src', 'hooks', 'useCliUpdate.js');
const REAL_HOME = process.env.HOME;
const REAL_VERSION = JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'package.json'), 'utf8')).version;

/** A fake install whose package.json carries NO version — the exact state a
 *  launch path with the wrong cli directory produces. */
function makeUnreadableInstall() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hakster-unknown-version-'));
  const home = path.join(root, 'home');
  const cli = path.join(root, 'cli');
  const staged = path.join(home, '.hakster', 'updates', 'staged', 'cli');
  fs.mkdirSync(staged, { recursive: true });
  fs.mkdirSync(cli, { recursive: true });
  fs.writeFileSync(path.join(cli, 'package.json'), JSON.stringify({ name: 'hakster-cli' }));
  fs.writeFileSync(path.join(cli, 'ui-fb.mjs'), '// running, version unreadable\n');
  const stagedBundle = path.join(staged, 'ui-fb.mjs');
  fs.writeFileSync(stagedBundle, '// staged 9.9.9\n');
  fs.writeFileSync(path.join(staged, 'package.json'), JSON.stringify({ version: '9.9.9' }));
  const bundleSha = crypto.createHash('sha256').update(fs.readFileSync(stagedBundle)).digest('hex');
  const pendingPath = path.join(home, '.hakster', 'updates', 'pending.json');
  const record = {
    version: '9.9.9',
    bundleSha,
    stagedAt: '2026-11-26T17:17:31.217Z',
    runningVersion: '0.0.0',
    state: 'blocked',
    blocked: 'source-checkout',
  };
  fs.writeFileSync(pendingPath, JSON.stringify(record, null, 2));
  return { root, home, cli, pendingPath, record };
}

function loadUpdater(home) {
  process.env.HOME = home;
  delete require.cache[UPDATER];
  return require(UPDATER);
}

test.after(() => {
  if (REAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = REAL_HOME;
  delete require.cache[UPDATER];
});

test('an unreadable running version is reported unknown, and stages nothing', async () => {
  const { home, cli, root, pendingPath, record } = makeUnreadableInstall();
  try {
    const updater = loadUpdater(home);
    // No server is reached: the guard answers before any request is made, which
    // is also why this test cannot depend on a network.
    const res = await updater.checkForUpdate({ cliDir: cli, server: 'http://127.0.0.1:1', timeoutMs: 50 });
    assert.equal(res.status, 'unknown');
    assert.match(String(res.reason), /package\.json/);
    assert.deepEqual(JSON.parse(fs.readFileSync(pendingPath, 'utf8')), record, 'the record is not rewritten');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a record taken from an unreadable install is marked unknown, never staged', () => {
  const { home, cli, root } = makeUnreadableInstall();
  try {
    const updater = loadUpdater(home);
    const info = updater.pendingInfo(cli);
    assert.equal(info.unknown, true);
    assert.equal(info.isCurrent, false, 'it is not evidence that this build is current');
    assert.equal(info.superseded, false, 'and not evidence of a downgrade either');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('applyPending refuses instead of copying into an unknown target', () => {
  const { home, cli, root } = makeUnreadableInstall();
  try {
    const updater = loadUpdater(home);
    const res = updater.applyPending(cli);
    assert.equal(res.applied, false);
    assert.match(String(res.reason), /package\.json/);
    // Nothing was written over the target.
    assert.match(fs.readFileSync(path.join(cli, 'ui-fb.mjs'), 'utf8'), /version unreadable/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('cliDirOf lands on a directory that really carries this CLI\'s version', () => {
  const updater = loadUpdater(REAL_HOME || os.homedir());
  const dir = updater.cliDirOf();
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  assert.equal(pkg.version, REAL_VERSION, 'the default cli directory is the running CLI, never the cwd');
});

test('the TUI startup does not paint a badge from an unknown record', () => {
  const src = fs.readFileSync(HOOK, 'utf8');
  assert.match(src, /if \(pending\.unknown\) return \{ applied: null, status: \{ status: 'idle' \} \}/,
    'an unknown record shows nothing rather than a false "pull to update"');
});
