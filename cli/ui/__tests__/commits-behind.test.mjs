/* "N commits behind", shown before it installs — Hermes-style (§44).
 *
 * Owner, 2026-11-26: "i want our cli to say in tui how many commits is behind
 * before installs like hermes" and "so it always is upto date".
 *
 * Pinned here:
 *   1. the running install reads its commit count from cli/.build-stamp.json
 *      (an installed copy has no .git);
 *   2. a stamp that is missing or garbage reads null/unknown, never a guess;
 *   3. the staged record carries the published count and the `behind` figure;
 *   4. the endpoint reports commit/commits, and the badge renders the count on
 *      its richest form while the pinned "installs on restart" wording stays.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const UPDATER = require.resolve('../../src/updater.js');
const STAMP = require.resolve('../../../scripts/cli-build-stamp.cjs');
const ROUTE = path.join(here, '..', '..', '..', 'server', 'src', 'index.js');
// The reading itself lives in the shared module both /cli/latest.json and
// /api/version serve from, so the two answers cannot drift (§39.3).
const CLI_BUILD = path.join(here, '..', '..', '..', 'server', 'src', 'cliBuild.js');
const APP = path.join(here, '..', 'src', 'App.jsx');
const REAL_HOME = process.env.HOME;

function makeRoot({ stamp } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hakster-behind-'));
  const home = path.join(root, 'home');
  const cli = path.join(root, 'cli');
  fs.mkdirSync(cli, { recursive: true });
  fs.writeFileSync(path.join(cli, 'package.json'), JSON.stringify({ version: '0.3.62' }));
  fs.writeFileSync(path.join(cli, 'ui-fb.mjs'), '// running\n');
  if (stamp) fs.writeFileSync(path.join(cli, '.build-stamp.json'), JSON.stringify(stamp));
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
});

test('the running install reads its commit count from the shipped stamp', () => {
  const { home, cli, root } = makeRoot({ stamp: { commit: 'abc1234', commits: 280, version: '0.3.62' } });
  try {
    const updater = loadUpdater(home);
    const info = updater.runningInfo(cli);
    assert.equal(info.commits, 280);
    assert.equal(info.commit, 'abc1234');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a missing or malformed stamp is unknown, never a guess', () => {
  const a = makeRoot();
  const b = makeRoot({ stamp: { commit: 'abc', commits: 'not-a-number' } });
  try {
    const updater = loadUpdater(a.home);
    assert.equal(updater.runningInfo(a.cli).commits, null);
    delete require.cache[UPDATER];
    const updaterB = loadUpdater(b.home);
    assert.equal(updaterB.runningInfo(b.cli).commits, null);
  } finally {
    fs.rmSync(a.root, { recursive: true, force: true });
    fs.rmSync(b.root, { recursive: true, force: true });
  }
});

test('the staged record carries the published count and the behind figure', () => {
  const { home, root } = makeRoot({ stamp: { commit: 'abc1234', commits: 280 } });
  try {
    const pendingFile = path.join(home, '.hakster', 'updates', 'pending.json');
    fs.mkdirSync(path.dirname(pendingFile), { recursive: true });
    fs.writeFileSync(pendingFile, JSON.stringify({
      version: '0.3.63', bundleSha: 'x', stagedAt: new Date().toISOString(),
      latestCommit: 'def5678', latestCommits: 283, behind: 3, state: 'staged',
    }));
    const updater = loadUpdater(home);
    const info = updater.pendingInfo(path.join(root, 'cli'));
    assert.equal(info.behind, 3);
    assert.equal(info.latestCommits, 283);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the stamp helper reads a stamp and refuses a bad one', () => {
  const { root } = makeRoot({ stamp: { commit: 'abc1234', commits: 280, version: '0.3.62' } });
  const bad = makeRoot({ stamp: { commit: '', commits: 0 } });
  try {
    delete require.cache[STAMP];
    const helpers = require(STAMP);
    const ok = helpers.readStamp(root);
    assert.equal(ok.commits, 280);
    assert.equal(ok.commit, 'abc1234');
    assert.equal(helpers.readStamp(bad.root), null);
    // The route's reading on a machine with git prefers git; with none it falls
    // back to the stamp rather than inventing a count.
    assert.equal(helpers.current(bad.root), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(bad.root, { recursive: true, force: true });
  }
});

test('a directory that is merely INSIDE a repository has no reading of its own', () => {
  // The standby slot lives under a home that may itself be a repository; git
  // would answer with that ancestor's history (seen 2026-11-26: 77 commits for
  // a 281-commit tree). Only a root that is its own work tree may report.
  delete require.cache[STAMP];
  const helpers = require(STAMP);
  const repoRoot = path.join(here, '..', '..', '..');
  const nested = path.join(here, '..'); // cli/ui — inside the repo, not its root
  const own = helpers.fromGit(repoRoot);
  assert.ok(own && own.commits > 0, 'the repository itself reports its own count');
  assert.equal(helpers.fromGit(nested), null, 'a nested directory reports nothing');
});

test('the endpoint reports the commit, and the badge renders the count', () => {
  const route = fs.readFileSync(ROUTE, 'utf8');
  const cliBuild = fs.readFileSync(CLI_BUILD, 'utf8');
  assert.ok(route.includes("require('./cliBuild').cliBuildInfo()"), 'the endpoint serves the shared reading');
  assert.ok(cliBuild.includes('cli-build-stamp.cjs'), 'the reading comes from the build stamp');
  assert.ok(/commit: build \? build\.commit/.test(cliBuild), 'latest.json carries commit');
  assert.ok(/commits: build \? build\.commits/.test(cliBuild), 'latest.json carries commits');
  // "shows in server cli when its installed" (owner, 2026-11-26): the server
  // reports the CLI build it serves on /api/version, so the dashboard and the
  // applet can show it without a second endpoint.
  assert.ok(/res\.json\(\{ build: buildIdCache\.id, server: serverBuildInfo, cli: cliInfo,/.test(route),
    '/api/version reports the CLI build it serves');
  // The SERVER view shows the CLI build this box serves, bound from the same
  // /api/version payload (owner, 2026-11-26: "shows in server cli when its installed").
  const dbg = fs.readFileSync(path.join(here, '..', 'src', 'components', 'DebugView.jsx'), 'utf8');
  assert.ok(dbg.includes("const cliInfo = version && version.cli ? version.cli : null;"),
    'DebugView reads the CLI build from /api/version');
  assert.ok(dbg.includes('label="cli build"'), 'the SERVER view renders a cli build row');
  const app = fs.readFileSync(APP, 'utf8');
  assert.ok(app.includes('updateBehindText'), 'the badge builds a behind-text');
  assert.ok(/\$\{updateBehind\} commit\$\{updateBehind === 1 \? '' : 's'\} behind/.test(app),
    'the count is rendered honestly, singular and plural');
  // The pinned staged wording is untouched — the count is added, not swapped in.
  assert.ok(app.includes('installs on restart'), 'staged wording stays staged');
  assert.ok(app.includes('✔ Update installed · Restart to update'), 'installed wording unchanged');
});

test('a stale stamp is refreshed before the package is packed', () => {
  // /cli/pkg.tar.gz packs the tree as it sits on disk, and the shipped stamp is
  // an installed copy's ONLY commit reading — it has no .git. Measured
  // 2026-11-26: the packaged stamp said v0.3.83 / 324 commits while the tree was
  // at v0.3.86 / 333, so a fresh install counted itself "0 commits behind" the
  // build it had just received. ensureFresh must close that gap at pack time and
  // must not churn a stamp that is already true.
  delete require.cache[STAMP];
  const helpers = require(STAMP);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hakster-stamp-refresh-'));
  const cli = path.join(root, 'cli');
  fs.mkdirSync(cli, { recursive: true });
  fs.writeFileSync(path.join(cli, 'package.json'), JSON.stringify({ version: '0.3.86' }));
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
  };
  execFileSync('git', ['-C', root, 'init', '-q'], { env: gitEnv });
  fs.writeFileSync(path.join(cli, 'file.txt'), 'x\n');
  execFileSync('git', ['-C', root, 'add', '.'], { env: gitEnv });
  execFileSync('git', ['-C', root, 'commit', '-qm', 'one'], { env: gitEnv });
  const head = execFileSync('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], { env: gitEnv }).toString().trim();

  // A stamp left behind by an older build: right shape, wrong facts.
  fs.writeFileSync(path.join(cli, '.build-stamp.json'), JSON.stringify({
    version: '0.3.83', commit: 'deadbee', commits: 1, builtAt: '2026-11-26T01:18:44.840Z',
  }));

  const fresh = helpers.ensureFresh(root);
  assert.ok(fresh, 'a repository can be read');
  assert.equal(fresh.commit, head, 'the stamp is rewritten from this repository');
  assert.equal(fresh.version, '0.3.86', 'the version comes from the package beside it');

  const written = JSON.parse(fs.readFileSync(path.join(cli, '.build-stamp.json'), 'utf8'));
  assert.equal(written.commit, head, 'the file on disk matches, so the package ships the truth');

  // A stamp that is already true is left alone — packing must not churn it.
  const again = helpers.ensureFresh(root);
  assert.equal(again.builtAt, fresh.builtAt, 'a current stamp is not rewritten');
});

test('the package route refreshes the stamp before it builds the tarball', () => {
  const route = fs.readFileSync(ROUTE, 'utf8');
  assert.match(route, /cli-build-stamp\.cjs'\)\)\.ensureFresh\(root\)/, 'the pack route refreshes the stamp');
  const iEnsure = route.indexOf('.ensureFresh(root)');
  const iTar = route.indexOf("spawn('tar'");
  assert.ok(iEnsure > 0 && iTar > iEnsure, 'refreshed before the tarball is built, not after');
  // A stamp failure must never cost a user the download.
  const around = route.slice(iEnsure, iTar);
  assert.match(around, /catch\s*\{/, 'a stamp error is caught; the package still ships');
});

test('hakster update prints the same count as the header', () => {
  const src = fs.readFileSync(path.join(here, '..', '..', 'index.js'), 'utf8');
  assert.match(src, /const behind = Number\(res\.behind\) > 0/, 'the command reads the updater\'s figure');
  assert.match(src, /v\$\{res\.version\}\$\{behind\} downloaded and verified/, 'the staged line carries it');
  assert.match(src, /v\$\{res\.version\}\$\{behind\} downloaded and verified[\s\S]{0,300}source checkout/, 'the checkout line carries it');
});
