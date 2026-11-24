/* A staged package that is OLDER than the running CLI is not an update.
 *
 * This is the bug the header badge exposed (2026-11-24): ~/.hakster/updates keeps
 * the record of the last check. When the CLI is upgraded, that record still names
 * the version that was running a moment ago, so the next start read it as
 * "v0.3.23 is ready" — one release BEHIND the install — and applyPending() would
 * have copied it over the newer CLI: a downgrade presented as an update.
 *
 * updater.js decides this from the version, so it is testable without a terminal.
 * os.homedir() honours $HOME on POSIX (Node), and UPDATES_DIR is resolved when the
 * module loads, so the whole state lives in a throwaway directory.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const UPDATER = require.resolve('../../src/updater.js');

const REAL_HOME = process.env.HOME;

/** A fake install: a home directory holding update state, and a CLI directory
 *  whose package.json names the version that "is running". */
function makeInstall({ running, pending, blocked = null }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hakster-supersede-'));
  const home = path.join(root, 'home');
  const cli = path.join(root, 'cli');
  const staged = path.join(home, '.hakster', 'updates', 'staged', 'cli');
  fs.mkdirSync(staged, { recursive: true });
  fs.mkdirSync(cli, { recursive: true });
  fs.writeFileSync(path.join(cli, 'package.json'), JSON.stringify({ version: running }));
  // Same version means the same build: the bundle has to match too, or the
  // record would read as "same version, newer build" instead of current.
  const sameBuild = running === pending;
  fs.writeFileSync(path.join(cli, 'ui-fb.mjs'), `// ${sameBuild ? 'build' : 'running'} ${running}\n`);
  const stagedBundle = path.join(staged, 'ui-fb.mjs');
  fs.writeFileSync(stagedBundle, `// ${sameBuild ? 'build' : 'staged'} ${pending}\n`);
  fs.writeFileSync(path.join(staged, 'package.json'), JSON.stringify({ version: pending }));
  const bundleSha = crypto.createHash('sha256').update(fs.readFileSync(stagedBundle)).digest('hex');
  fs.writeFileSync(
    path.join(home, '.hakster', 'updates', 'pending.json'),
    JSON.stringify({ version: pending, bundleSha, stagedAt: new Date().toISOString(), state: blocked ? 'blocked' : 'staged', blocked }),
  );
  return { root, home, cli };
}

/** Load a fresh copy of updater.js with its module-level paths pointed at `home`. */
function loadUpdater(home) {
  process.env.HOME = home;
  // A CJS module resolves UPDATES_DIR once, at load: drop it from the cache so
  // each case really reads its own home directory.
  delete require.cache[UPDATER];
  return require(UPDATER);
}

test.after(() => {
  if (REAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = REAL_HOME;
});

test('a stage from an older version is superseded, not pending', async () => {
  const { home, cli, root } = makeInstall({ running: '0.3.24', pending: '0.3.1' });
  try {
    const updater = loadUpdater(home);
    const info = updater.pendingInfo(cli);
    assert.equal(info.superseded, true);
    assert.equal(info.isCurrent, false);
    assert.equal(info.runningVersion, '0.3.24');

    // Applying must refuse — and must leave the running CLI exactly as it was.
    const before = fs.readFileSync(path.join(cli, 'ui-fb.mjs'), 'utf8');
    const res = updater.applyPending(cli);
    assert.equal(res.applied, false);
    assert.match(String(res.reason), /superseded/);
    assert.equal(fs.readFileSync(path.join(cli, 'ui-fb.mjs'), 'utf8'), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a stage from a newer version is a real pending update', async () => {
  const { home, cli, root } = makeInstall({ running: '0.3.24', pending: '0.3.99' });
  try {
    const updater = loadUpdater(home);
    const info = updater.pendingInfo(cli);
    assert.equal(info.superseded, false);
    assert.equal(info.isCurrent, false);
    assert.equal(info.version, '0.3.99');
    // applyPending is deliberately NOT called here: on a newer stage it copies
    // files, and this test only needs the classification.
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a stage of the running build is current, not an update', async () => {
  const { home, cli, root } = makeInstall({ running: '0.3.24', pending: '0.3.24' });
  try {
    const updater = loadUpdater(home);
    const info = updater.pendingInfo(cli);
    assert.equal(info.isCurrent, true);
    assert.equal(info.superseded, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
