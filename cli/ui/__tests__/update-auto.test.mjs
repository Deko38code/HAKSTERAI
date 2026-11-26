/* Updates install themselves, like Claude Code (§43).
 *
 * Owner, 2026-11-26: "need ours to update like claude does says update installed
 * restart cli need ours auto and users to get newest add ons always"; and, about
 * his own box, "dont dell auto install on its own" / "it says it already on dell
 * up top … and tells me to restart to".
 *
 * Pinned here:
 *   1. a verified stage on an INSTALLED copy is applied at start without asking
 *      (promptStagedUpdate → 'auto'), which is what lets the header say
 *      "✔ Update installed · Restart to update" truthfully;
 *   2. a SOURCE CHECKOUT is refused before that — never auto-installed (§8);
 *   3. the TUI never reports "installed" for a checkout (the Dell's header).
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

// The running CLI's own version decides whether a stage is "superseded", so the
// fake install tracks this checkout's version instead of a pinned literal — a
// version bump must never turn these tests into a downgrade story.
const REAL_VERSION = JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'package.json'), 'utf8')).version;
const bump = (v) => {
  const p = String(v).split('.');
  p[p.length - 1] = String((parseInt(p[p.length - 1], 10) || 0) + 1);
  return p.join('.');
};
const NEXT_VERSION = bump(REAL_VERSION);

function makeInstall({ running = REAL_VERSION, pending = NEXT_VERSION, checkout = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hakster-auto-update-'));
  const home = path.join(root, 'home');
  const cli = path.join(root, 'cli');
  const staged = path.join(home, '.hakster', 'updates', 'staged', 'cli');
  fs.mkdirSync(staged, { recursive: true });
  fs.mkdirSync(cli, { recursive: true });
  if (checkout) fs.mkdirSync(path.join(root, '.git'), { recursive: true }); // one level above cli
  fs.writeFileSync(path.join(cli, 'package.json'), JSON.stringify({ version: running }));
  fs.writeFileSync(path.join(cli, 'ui-fb.mjs'), `// running ${running}\n`);
  const stagedBundle = path.join(staged, 'ui-fb.mjs');
  fs.writeFileSync(stagedBundle, `// staged ${pending}\n`);
  fs.writeFileSync(path.join(staged, 'package.json'), JSON.stringify({ version: pending }));
  const bundleSha = crypto.createHash('sha256').update(fs.readFileSync(stagedBundle)).digest('hex');
  fs.writeFileSync(
    path.join(home, '.hakster', 'updates', 'pending.json'),
    JSON.stringify({ version: pending, bundleSha, stagedAt: new Date().toISOString(), state: 'staged' }),
  );
  return { root, home, cli };
}

function loadUpdater(home) {
  process.env.HOME = home;
  delete require.cache[UPDATER];
  return require(UPDATER);
}

test.after(() => {
  if (REAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = REAL_HOME;
  delete process.env.HAKSTER_UPDATE_PROMPT;
});

test('an installed copy applies a verified stage at start without asking', async () => {
  const { home, cli, root } = makeInstall();
  try {
    const updater = loadUpdater(home);
    const res = await updater.promptStagedUpdate({ cliDir: cli, timeoutMs: 50 });
    assert.equal(res.action, 'auto', 'no [i/w] prompt on a normal start');
    // And the copy really happens — the badge can say "installed" afterwards.
    const applied = updater.applyPending(cli);
    assert.equal(applied.applied, true);
    assert.equal(applied.version, NEXT_VERSION);
    assert.match(fs.readFileSync(path.join(cli, 'ui-fb.mjs'), 'utf8'), new RegExp(`staged ${NEXT_VERSION.replace(/\./g, '\\.')}`));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a source checkout is refused, never auto-installed', async () => {
  const { home, cli, root } = makeInstall({ checkout: true });
  try {
    const updater = loadUpdater(home);
    const res = await updater.promptStagedUpdate({ cliDir: cli, timeoutMs: 50 });
    assert.equal(res.action, 'blocked', 'a git tree is never written into (§8)');
    const applied = updater.applyPending(cli);
    assert.equal(applied.applied, false);
    assert.equal(applied.reason, 'source-checkout');
    assert.match(fs.readFileSync(path.join(cli, 'ui-fb.mjs'), 'utf8'), new RegExp(`running ${REAL_VERSION.replace(/\./g, '\\.')}`));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('HAKSTER_UPDATE_PROMPT=ask keeps the old choice, and a checkout still wins', async () => {
  const { home, cli, root } = makeInstall();
  try {
    process.env.HAKSTER_UPDATE_PROMPT = 'ask';
    const updater = loadUpdater(home);
    const res = await updater.promptStagedUpdate({ cliDir: cli, timeoutMs: 50 });
    // No TTY in a test run, so asking is not possible — the verified stage is
    // still applied rather than dropped.
    assert.equal(res.action, 'auto');
  } finally {
    delete process.env.HAKSTER_UPDATE_PROMPT;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the TUI reports no "installed" badge for a source checkout', () => {
  const src = fs.readFileSync(HOOK, 'utf8');
  assert.ok(src.includes('isSourceCheckout'), 'the hook asks whether this is a checkout');
  const diskNewer = src.slice(src.indexOf('const diskNewer'), src.indexOf('const diskNewer') + 900);
  assert.ok(/if \(isSourceCheckout\(\)\) return null;/.test(diskNewer),
    'the disk-newer probe must return nothing on a checkout (the Dell header rule)');
  assert.ok(src.includes('applyPending'), 'and a verified stage is installed from the session');
});

test('the backup keeps the install that was replaced, not the stage', async () => {
  const { home, cli, root } = makeInstall();
  try {
    // A file only the installed tree has. A backup copied from the STAGE can
    // never contain it — that was the defect measured 2026-11-26: the directory
    // named backup-<old version> held the NEW build, so a copy that failed
    // halfway had nothing to restore from (§4/§5: never lose the last good copy).
    fs.writeFileSync(path.join(cli, 'OLD-ONLY.txt'), 'the replaced install\n');
    const updater = loadUpdater(home);
    const applied = updater.applyPending(cli);
    assert.equal(applied.applied, true);
    assert.ok(applied.backupDir, 'the apply names the backup it made');
    const backed = JSON.parse(fs.readFileSync(path.join(applied.backupDir, 'package.json'), 'utf8'));
    assert.equal(backed.version, REAL_VERSION, 'the backup is the version that was replaced');
    assert.ok(fs.existsSync(path.join(applied.backupDir, 'OLD-ONLY.txt')), 'and carries that install’s own files');
    // The install itself moved on to the staged build.
    assert.equal(JSON.parse(fs.readFileSync(path.join(cli, 'package.json'), 'utf8')).version, NEXT_VERSION);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
