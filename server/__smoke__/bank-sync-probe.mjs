#!/usr/bin/env node
/* bank-sync probe — one memory count, correct and the same on both boxes.
 *
 * Owner, 2026-11-27: "i always want the memory count correct and the same on
 * both boxes for better memory recalling … this box has 438 and lenonvo cli
 * says 437 … we need a auto update feat that checks banks that are connected to
 * any cli per user … and will stay in sync".
 *
 * What this pins:
 *   1. a bank dir is counted per file and summed, and a missing dir is 0/absent;
 *   2. one peer `cat` is parsed into that peer's per-file counts + its CLI
 *      account, and a bank file the peer does not have is simply absent;
 *   3. drift is per file and names the side that is short;
 *   4. the sync heals by CONTENT-KEYED union: the same fact banked under two
 *      different ids collapses to one entry (the measured 438 → 450 inflation),
 *      tags survive from both sides, confidence is never downgraded, and an
 *      entry only the destination has is never removed;
 *   5. the orchestrator passes an explicit --target, merges with the union in
 *      both directions, pushes twice, supports the failover flags, and never
 *      requests the mirror/prune mode;
 *   6. both routes exist and are owner-gated (403 to everyone else);
 *   7. the scheduler is started on the listen path and can be turned off;
 *   8. the CLI header renders the two-box pair and the hook reads the route.
 *
 * Run: node server/__smoke__/bank-sync-probe.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const require = createRequire(import.meta.url);
const bankSync = require(path.join(root, 'server/src/bankSync.js'));
const UNION = path.join(root, 'scripts/memory-bank-union.cjs');
const SYNC = path.join(root, 'scripts/memory-bank-sync.cjs');

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`✔ ${name}`); }
  else { fail++; console.log(`✘ ${name}${detail ? ` — ${detail}` : ''}`); }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-bank-probe-'));
const mk = (name, entries) => {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, list] of Object.entries(entries)) {
    fs.writeFileSync(path.join(dir, file), JSON.stringify(list));
  }
  return dir;
};
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

try {
  // 1. counting
  const a = mk('a', {
    'patterns.json': [{ id: 'p1', observation: 'one' }, { id: 'p2', observation: 'two' }],
    'errors-encountered.json': [{ id: 'e1', observation: 'err' }],
    'half-written.json': '{"not":"an array"',
  });
  const ca = bankSync.countBankDir(a);
  check('counts entries per bank file', ca.files['patterns.json'] === 2 && ca.files['errors-encountered.json'] === 1);
  check('sums to the total', ca.total === 3);
  check('a half-written bank counts as 0, never as memories', ca.files['half-written.json'] === 0);
  const missing = bankSync.countBankDir(path.join(tmp, 'nope'));
  check('a missing dir is absent with 0, not invented', missing.present === false && missing.total === 0);

  // 2. peer parsing (one cat, markers)
  const SPLIT = '__HAKSTER_BANK_SPLIT__';
  const peerText = [
    '"email": "owner@example.com"',
    SPLIT,
    '__BANK__ patterns.json',
    JSON.stringify([{ id: 'p1' }, { id: 'p3' }]),
    SPLIT,
    '__BANK__ lessons-anti-patterns.json',
    JSON.stringify([{ id: 'l1' }]),
    SPLIT,
  ].join('\n');
  const peer = bankSync.summarizePeerText(peerText);
  check('peer counts come from its own bank files', peer.files['patterns.json'] === 2 && peer.total === 3);
  check('peer names the CLI account it is signed in as', peer.account === 'owner@example.com');
  check('a bank the peer lacks is absent, not zero-filled', !('project-facts.json' in peer.files));

  // 2b. per-user roots are their own set, never folded into the box total
  const peerWithUser = [
    '"email": "owner@example.com"',
    SPLIT,
    '__BANK__ patterns.json',
    JSON.stringify([{ id: 'p1' }, { id: 'p2' }]),
    SPLIT,
    '__UBANK__ users/u1/banks/lessons.json',
    JSON.stringify([{ id: 'u1' }, { id: 'u2' }, { id: 'u3' }]),
    SPLIT,
  ].join('\n');
  const pu = bankSync.summarizePeerText(peerWithUser);
  check('a user root is counted as its own root', pu.roots['users/u1/banks'] === 3);
  check('a user root never joins the box total', pu.total === 2 && pu.totalAll === 5);
  const memDirWithUser = path.join(tmp, 'memdir');
  fs.mkdirSync(path.join(memDirWithUser, 'banks'), { recursive: true });
  fs.mkdirSync(path.join(memDirWithUser, 'users', 'u1', 'banks'), { recursive: true });
  fs.writeFileSync(path.join(memDirWithUser, 'banks', 'p.json'), JSON.stringify([{ id: 'a' }]));
  fs.writeFileSync(path.join(memDirWithUser, 'users', 'u1', 'banks', 'q.json'), JSON.stringify([{ id: 'b' }, { id: 'c' }]));
  check('countRoots sees both roots separately', JSON.stringify(bankSync.countRoots(memDirWithUser)) === JSON.stringify({ banks: 1, 'users/u1/banks': 2 }));
  const rd = bankSync.rootDrift({ banks: 1 }, { banks: 1, 'users/u1/banks': 2 });
  check('root drift names the user root that differs', rd.differs === true && rd.roots['users/u1/banks'].peer === 2);

  // 3. drift names the short side
  const local = { total: 3, files: { 'patterns.json': 2, 'errors-encountered.json': 1 } };
  const remote = { total: 2, files: { 'patterns.json': 2 } };
  const d = bankSync.driftBetween(local, remote);
  check('drift is per file and names the short side', d.differs === true && d.files['errors-encountered.json'].local === 1 && d.files['errors-encountered.json'].peer === 0);
  check('equal counts report no drift', bankSync.driftBetween(local, { ...local }).differs === false);

  // 4a. content-keyed union: the same fact under two ids is ONE fact
  const dest = mk('dest', {
    'patterns.json': [{ id: 'mem_1', observation: 'a shared fact', tags: ['one'], confidence: 0.7, timestamp: '2026-10-01T00:00:00Z' }],
    'project-facts.json': [{ id: 'dest-only', observation: 'only on the standby' }],
  });
  const src = mk('src', {
    'patterns.json': [
      { id: 'mem_9', observation: 'A  Shared   Fact', tags: ['two'], confidence: 0.9, timestamp: '2026-11-01T00:00:00Z' },
      { id: 'mem_5', observation: 'a genuinely new fact', tags: ['new'] },
    ],
  });
  execFileSync('node', [UNION, '--merge-from', src, '--target', dest], { stdio: 'pipe' });
  const destPatterns = readJson(path.join(dest, 'patterns.json'));
  const destFacts = readJson(path.join(dest, 'project-facts.json'));
  const shared = destPatterns.filter((e) => norm(e.observation) === 'a shared fact');
  check('union: the same fact banked under two ids is one entry (not 438 → 450)', destPatterns.filter((e) => /shared fact/.test(norm(e.observation))).length === 1);
  check('union: the genuinely new fact is added', destPatterns.some((e) => e.id === 'mem_5'));
  check('union: tags from both boxes survive', shared.length === 1 && ['one', 'two'].every((t) => (shared[0].tags || []).includes(t)));
  check('union: confidence is never downgraded', shared.length === 1 && Number(shared[0].confidence) === 0.9);
  check('union: a destination-only bank file survives (nothing deleted)', destFacts.some((e) => e.id === 'dest-only'));

  // 4b. re-running is a no-op, and the union is order-independent
  const snapshot = fs.readFileSync(path.join(dest, 'patterns.json'), 'utf8');
  execFileSync('node', [UNION, '--merge-from', src, '--target', dest], { stdio: 'pipe' });
  check('union: a second run adds nothing and rewrites nothing', fs.readFileSync(path.join(dest, 'patterns.json'), 'utf8') === snapshot);
  const ab = mk('ab', { 'patterns.json': [{ id: 'm1', observation: 'x' }, { id: 'm2', observation: 'y' }] });
  const ba = mk('ba', { 'patterns.json': [{ id: 'm3', observation: 'y' }, { id: 'm4', observation: 'x' }] });
  execFileSync('node', [UNION, '--merge-from', ba, '--target', ab], { stdio: 'pipe' });
  check('union: order-independent — A∪B and B∪A hold the same facts', readJson(path.join(ab, 'patterns.json')).length === 2);

  // 5. the orchestrator's shape
  const syncSrc = fs.readFileSync(SYNC, 'utf8');
  // A quoted flag in an argv array is a request; the word in a comment is not.
  check('the orchestrator never requests mirror/prune', !/['"]--prune['"]/.test(syncSrc));
  check('the orchestrator merges with the content-keyed union', syncSrc.includes('memory-bank-union.cjs'));
  check('the orchestrator syncs every root, per user', syncSrc.includes('--merge-tree') && syncSrc.includes('users/'));
  check('no id-keyed merge is left in the sync path', !/merge-banks-from-dir/.test(syncSrc));
  check('every merge passes an explicit --target', (syncSrc.match(/--merge-from[^`\n]*--target|--merge-from[\s\S]{0,60}--target/g) || []).length >= 2);
  check('the peer is pushed again after the local merge', (syncSrc.match(/pushToPeer\(\)/g) || []).length >= 2);
  for (const flag of ['--target', '--merge-from', '--verify', '--peer-dir']) {
    check(`the orchestrator accepts ${flag} (failover-sync.sh calls it)`, syncSrc.includes(`'${flag}'`));
  }
  check('an unreachable peer exits 3 and writes nothing local', /code: 3/.test(syncSrc) && !/peer-unreachable[\s\S]{0,400}mergeLocally/.test(syncSrc));

  // 5b. the local modes work end to end against temp dirs
  const mDest = mk('mdest', { 'patterns.json': [{ id: 'k1', observation: 'kept here' }] });
  const mSrc = mk('msrc', { 'patterns.json': [{ id: 'k2', observation: 'merged in' }] });
  const mergeOut = JSON.parse(execFileSync('node', [SYNC, '--merge-from', mSrc, '--target', mDest, '--quiet'], { encoding: 'utf8' }));
  check('--merge-from writes the source facts into --target', mergeOut.ok === true && readJson(path.join(mDest, 'patterns.json')).some((e) => e.id === 'k2'));
  const verifyOut = execFileSync('node', [SYNC, '--verify', '--peer-dir', mDest, '--target', mDest, '--quiet'], { encoding: 'utf8' });
  check('--verify reports equal for the same dir', JSON.parse(verifyOut).equal === true);
  let driftRc = 0;
  try { execFileSync('node', [SYNC, '--verify', '--peer-dir', mSrc, '--target', mDest, '--quiet'], { stdio: 'pipe' }); }
  catch (e) { driftRc = e.status; }
  check('--verify exits 2 when the boxes differ', driftRc === 2);

  // 6. routes, owner-gated
  const idx = fs.readFileSync(path.join(root, 'server/src/index.js'), 'utf8');
  for (const route of ['/api/agent/memory-banks/health', '/api/agent/memory-banks/sync']) {
    const line = idx.split('\n').find((l) => l.includes(`app.get('${route}'`) || l.includes(`app.post('${route}'`)) || '';
    check(`${route} exists and is owner-gated`, !!line && line.includes('requireOwnerForbidden'));
  }

  // 7. the scheduler is started on the listen path and is switchable
  check('the auto check is started at boot', /bankSync\.startAutoSync\(/.test(idx));
  const off = bankSync.startAutoSync({ intervalMs: 60000 });
  check('startAutoSync returns a state instead of throwing', off && typeof off.running === 'boolean');
  bankSync.stopAutoSync();

  // 8. the CLI shows the pair and reads the route
  const app = fs.readFileSync(path.join(root, 'cli/ui/src/App.jsx'), 'utf8');
  const hook = fs.readFileSync(path.join(root, 'cli/ui/src/hooks/useBankDrift.js'), 'utf8');
  check('the header renders the two-box pair', app.includes('bankDrift.localTotal}/${bankDrift.peerTotal'));
  check('the hook reads the owner-only health route', hook.includes('/api/agent/memory-banks/health'));
  check('a non-owner key renders no pair (403 is a permission, not a fault)', hook.includes('res.status === 403'));
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
