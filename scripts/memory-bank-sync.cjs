#!/usr/bin/env node
'use strict';

/*
 * memory-bank-sync.cjs — keep the memory banks the SAME on both boxes.
 *
 * Owner (2026-11-27): "i always want the memory count correct and the same on
 * both boxes for better memory recalling … we need a auto update feat that
 * checks banks that are connected to any cli per user who uses me owner paid
 * users … and will stay in sync with cli's signed in accounts".
 *
 * The problem it fixes: each box counts its own ~/.hakster/memories/banks, so a
 * memory banked on the Dell after the last commit shows 438 here and 437 on the
 * standby — the CLI reads its own disk, so the two boxes tell two stories and
 * recall is worse on whichever box is behind.
 *
 * What it does — a UNION of every root, both directions, nothing removed:
 *   1. pull the peer's memories (banks + every users/<slug>/banks) and count
 *      both sides (the "before");
 *   2. push ours and merge there with the CONTENT-KEYED union
 *      (scripts/memory-bank-union.cjs --merge-tree): the same fact banked on
 *      both boxes under two different ids collapses to one entry, so the count
 *      is CORRECT as well as equal. Measured 2026-11-28: an id-keyed merge took
 *      438 → 450 with no new knowledge, because both boxes held the same 12
 *      facts under 12 ids;
 *   3. pull the peer's union back and merge it here the same way;
 *   4. push once more, so anything this box gained or banked during the run is
 *      on the peer too (push-then-pull alone leaves drift by construction);
 *   5. measure both boxes again — per root, per file: entry count AND a
 *      content fingerprint — and report equal / drift. Equal by that measure
 *      means a union from either side is a no-op, which is exactly "stable".
 *
 * Roots never cross: the box's own `banks` unions with the peer's `banks`, and
 * `users/<slug>/banks` unions with that same slug's set — a paid user's facts
 * are never folded into the owner's set (§29.6).
 *
 * Safety:
 *   · union only, in both directions — no --prune, no mirror, nothing deleted;
 *     every rewritten file is archived by the union helper before it is swapped;
 *   · an unreachable peer is an error and NOTHING local is written;
 *   · a lock file stops two syncs running at once;
 *   · every command is bounded by a timeout and a buffer cap;
 *   · --dry-run reads and counts only.
 *
 * Usage:
 *   node scripts/memory-bank-sync.cjs [--peer mint] [--dry-run] [--quiet] [--json]
 *   node scripts/memory-bank-sync.cjs --merge-from DIR [--target DIR]     (one bank dir)
 *   node scripts/memory-bank-sync.cjs --verify --peer-dir DIR [--target DIR]
 * Exits: 0 both boxes match · 2 drift remains or a write failed · 3 peer
 * unreachable · 4 another sync holds the lock.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const flagValue = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const PEER = flagValue('--peer', process.env.HAKSTER_BANK_PEER || 'mint');
const DRY = has('--dry-run');
const QUIET = has('--quiet');
const MERGE_FROM = flagValue('--merge-from', null);
const PEER_DIR = flagValue('--peer-dir', null);
const VERIFY_ONLY = has('--verify');
const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=accept-new'];
const STEP_TIMEOUT = Math.max(20000, Number(process.env.HAKSTER_BANK_SYNC_TIMEOUT_MS) || 90000);
const MAX_BUFFER = 64 * 1024 * 1024;
const LOCK_STALE_MS = 10 * 60 * 1000;

const HOME = process.env.HAKSTER_HOME || os.homedir();
const MEM_DIR = path.join(HOME, '.hakster', 'memories');
const BANK_DIR = flagValue('--target', path.join(MEM_DIR, 'banks'));
const LOCK = path.join(MEM_DIR, '.bank-sync.lock');
const UNION_LOCAL = path.join(__dirname, 'memory-bank-union.cjs');
const UNION_REMOTE = 'hakster-bank-union.cjs';
const REMOTE_MEM = '$HOME/.hakster/memories';

const say = (msg) => { if (!QUIET) process.stderr.write(msg + '\n'); };

// ── the same content key the union helper uses, so "equal" means the same
//    knowledge — not merely the same number ------------------------------------
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
function contentKey(e) {
  const text = e && (e.observation || e.text || e.title || e.value);
  const key = norm(text);
  return key ? sha(key).slice(0, 24) : 'id:' + String((e && e.id) || sha(JSON.stringify(e)).slice(0, 24));
}

const bankFiles = (dir) => {
  try { return fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !/\.bak[-.]/.test(f)).sort(); } catch { return []; }
};

function readBank(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(j) ? j : null;
  } catch { return null; }
}

/** The same roots the union uses: `banks` plus every `users/<slug>/banks`. */
function rootRels(memDir) {
  const rels = [];
  if (fs.existsSync(path.join(memDir, 'banks'))) rels.push('banks');
  let users = [];
  try {
    users = fs.readdirSync(path.join(memDir, 'users'), { withFileTypes: true })
      .filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch { users = []; }
  for (const slug of users) {
    if (fs.existsSync(path.join(memDir, 'users', slug, 'banks'))) rels.push(`users/${slug}/banks`);
  }
  return rels;
}

/** Per-file entry count plus a fingerprint of the distinct facts, per root. */
function manifestTree(memDir) {
  const roots = {};
  const files = {};
  let total = 0;
  for (const rel of rootRels(memDir)) {
    const dir = path.join(memDir, rel);
    let rootTotal = 0;
    for (const name of bankFiles(dir)) {
      const list = readBank(path.join(dir, name));
      const label = `${rel}/${name}`;
      if (list === null) { files[label] = { entries: null, fingerprint: null, unreadable: true }; continue; }
      const keys = [...new Set(list.filter((e) => e && typeof e === 'object').map(contentKey))].sort();
      files[label] = { entries: list.length, fingerprint: sha(keys.join('\n')).slice(0, 16) };
      rootTotal += list.length;
    }
    roots[rel] = rootTotal;
    total += rootTotal;
  }
  return { memDir, roots, files, total, present: fs.existsSync(memDir) };
}

/** One bank dir on its own — used when a caller names an explicit --target. */
function manifestDir(dir) {
  const files = {};
  let total = 0;
  for (const name of bankFiles(dir)) {
    const list = readBank(path.join(dir, name));
    if (list === null) { files[name] = { entries: null, fingerprint: null, unreadable: true }; continue; }
    const keys = [...new Set(list.filter((e) => e && typeof e === 'object').map(contentKey))].sort();
    files[name] = { entries: list.length, fingerprint: sha(keys.join('\n')).slice(0, 16) };
    total += list.length;
  }
  return { memDir: dir, roots: { '.': total }, files, total, present: fs.existsSync(dir) };
}

function driftBetween(a, b) {
  const names = new Set([...Object.keys(a.files || {}), ...Object.keys(b.files || {})]);
  const files = {};
  for (const name of names) {
    const x = (a.files || {})[name] || { entries: 0, fingerprint: null };
    const y = (b.files || {})[name] || { entries: 0, fingerprint: null };
    if (x.entries !== y.entries || x.fingerprint !== y.fingerprint) {
      files[name] = { local: x.entries, peer: y.entries, sameKnowledge: x.fingerprint === y.fingerprint };
    }
  }
  return { differs: Object.keys(files).length > 0, files, delta: (b.total || 0) - (a.total || 0) };
}

function run(cmd, argv, input) {
  return execFileSync(cmd, argv, { input, timeout: STEP_TIMEOUT, maxBuffer: MAX_BUFFER, stdio: ['pipe', 'pipe', 'pipe'] });
}

const ssh = (remoteCmd, input) => run('ssh', [...SSH_OPTS, PEER, remoteCmd], input);
const tmpDir = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `hakster-banks-${tag}-`));
const parseJson = (text, fallback) => { try { return JSON.parse(text); } catch { return fallback; } };

/** Pull the peer's memories (banks + every per-user root) into a temp dir. */
function pullPeer(tag) {
  const dir = tmpDir(tag);
  const tar = ssh(`set -- banks; [ -d users ] && set -- banks users; tar -C ${REMOTE_MEM} -cf - --exclude=banks-sync-backup --exclude='*.tmp-*' "$@" 2>/dev/null; true`);
  if (!tar || !tar.length) throw new Error('peer sent no bank data');
  run('tar', ['-C', dir, '-xf', '-'], tar);
  return dir; // a memories-shaped dir: banks/ + users/
}

/** Ship the union helper + this box's memories to the peer and merge there. */
function pushToPeer() {
  if (!fs.existsSync(MEM_DIR)) throw new Error('no local memories dir');
  const tar = execFileSync('sh', ['-c',
    `set -- banks; [ -d users ] && set -- banks users; tar -C "${MEM_DIR}" -cf - --exclude=banks-sync-backup --exclude='*.tmp-*' "$@"`],
  { timeout: STEP_TIMEOUT, maxBuffer: MAX_BUFFER });
  ssh('rm -rf ~/.hakster-banks-incoming && mkdir -p ~/.hakster-banks-incoming && tar -C ~/.hakster-banks-incoming -xf -', tar);
  run('scp', ['-q', ...SSH_OPTS, UNION_LOCAL, `${PEER}:~/${UNION_REMOTE}`]);
  // --mem-dir is always explicit: the union's own default is os.homedir(), which
  // is the wrong dir under sudo or a HAKSTER_HOME peer (measured 2026-11-28 — an
  // implicit target merged a test dir into the live banks).
  const out = ssh(`cd $HOME && node $HOME/${UNION_REMOTE} --merge-tree $HOME/.hakster-banks-incoming --mem-dir ${REMOTE_MEM} --json`).toString();
  ssh('rm -rf ~/.hakster-banks-incoming');
  return parseJson(out, { raw: String(out).slice(0, 400) });
}

/** Union a pulled memories dir into this box, root for root. */
function mergeTreeLocally(fromMemDir) {
  const out = run('node', [UNION_LOCAL, '--merge-tree', fromMemDir, '--mem-dir', MEM_DIR, '--json']).toString();
  return parseJson(out, { raw: String(out).slice(0, 400) });
}

/** One bank dir only — the shape failover-sync.sh and older callers use. */
function mergeLocally(fromDir) {
  const out = run('node', [UNION_LOCAL, '--merge-from', fromDir, '--target', BANK_DIR, '--json']).toString();
  return parseJson(out, { raw: String(out).slice(0, 400) });
}

function acquireLock() {
  try {
    fs.mkdirSync(path.dirname(LOCK), { recursive: true });
    fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: 'wx' });
    return true;
  } catch {
    if (!fs.existsSync(LOCK)) return false;
    let age = 0;
    try { age = Date.now() - fs.statSync(LOCK).mtimeMs; } catch { age = 0; }
    if (age < LOCK_STALE_MS) return false;
    try { fs.unlinkSync(LOCK); } catch { /* fall through */ }
    try {
      fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: 'wx' });
      return true;
    } catch { return false; }
  }
}

const releaseLock = () => { try { fs.unlinkSync(LOCK); } catch { /* already gone */ } };

/** --merge-from DIR, or --verify --peer-dir DIR: local-only, one bank dir. */
function localOnly() {
  if (MERGE_FROM) {
    if (!fs.existsSync(MERGE_FROM)) return { code: 3, result: { ok: false, error: 'source-missing', src: MERGE_FROM } };
    const measure = args.includes('--target') ? manifestDir : manifestTree;
    const where = args.includes('--target') ? BANK_DIR : MEM_DIR;
    if (DRY) return { code: 0, result: { ok: true, dryRun: true, src: MERGE_FROM, target: where, before: measure(where) } };
    const merged = mergeLocally(MERGE_FROM);
    const after = measure(where);
    return { code: merged && merged.ok === false ? 2 : 0, result: { ok: !(merged && merged.ok === false), mode: 'merge', src: MERGE_FROM, merge: merged, after } };
  }
  if (VERIFY_ONLY || PEER_DIR) {
    if (!PEER_DIR) return { code: 2, result: { ok: false, error: 'need --peer-dir' } };
    // An explicit --target means "these two bank dirs, nothing else".
    const measure = args.includes('--target') ? manifestDir : manifestTree;
    const local = measure(args.includes('--target') ? BANK_DIR : MEM_DIR);
    const peer = measure(PEER_DIR);
    const drift = driftBetween(local, peer);
    return { code: drift.differs ? 2 : 0, result: { ok: !drift.differs, mode: 'verify', local, peer, drift, equal: !drift.differs } };
  }
  return null;
}

function main() {
  const started = Date.now();
  const result = {
    ok: false, dryRun: DRY, peer: PEER, at: new Date().toISOString(),
    before: null, after: null, peerMerge: null, localMerge: null, finalPush: null,
    drift: null, equal: false,
  };

  const beforeLocal = manifestTree(MEM_DIR);
  let peerDir;
  try {
    peerDir = pullPeer('before');
  } catch (err) {
    result.error = 'peer-unreachable';
    result.note = String((err && err.message) || err).slice(0, 200);
    result.before = { local: beforeLocal, peer: null };
    return { code: 3, result };
  }
  const beforePeer = manifestTree(peerDir);
  result.before = { local: beforeLocal, peer: beforePeer };
  say(`before: local ${beforeLocal.total} · ${PEER} ${beforePeer.total}`);

  if (DRY) {
    const drift = driftBetween(beforeLocal, beforePeer);
    result.after = result.before;
    result.drift = drift;
    result.equal = !drift.differs;
    result.ok = result.equal;
    return { code: result.equal ? 0 : 2, result };
  }

  if (!acquireLock()) {
    result.error = 'locked';
    result.note = 'another memory-bank sync is running; nothing was written';
    return { code: 4, result };
  }

  try {
    // 1. ours to the peer (content-keyed union there, every root)
    try {
      result.peerMerge = pushToPeer();
    } catch (err) {
      result.error = 'push-failed';
      result.note = String((err && err.message) || err).slice(0, 200);
      return { code: 2, result };
    }

    // 2. the peer's union back here
    try {
      result.localMerge = mergeTreeLocally(pullPeer('after'));
    } catch (err) {
      result.error = 'pull-failed';
      result.note = String((err && err.message) || err).slice(0, 200);
      return { code: 2, result };
    }

    // 3. push again: anything this box gained (or banked mid-run) must be on the
    //    peer too — push-then-pull alone leaves drift by construction.
    try {
      result.finalPush = pushToPeer();
    } catch (err) {
      result.error = 'final-push-failed';
      result.note = String((err && err.message) || err).slice(0, 200);
      return { code: 2, result };
    }

    // 4. measure both boxes: counts AND knowledge, per root
    let finalPeerDir;
    try {
      finalPeerDir = pullPeer('final');
    } catch (err) {
      result.error = 'verify-read-failed';
      result.note = String((err && err.message) || err).slice(0, 200);
      return { code: 2, result };
    }
    const afterLocal = manifestTree(MEM_DIR);
    const afterPeer = manifestTree(finalPeerDir);
    const drift = driftBetween(afterLocal, afterPeer);
    result.after = { local: afterLocal, peer: afterPeer };
    result.drift = drift;
    result.equal = !drift.differs;
    result.ok = result.equal;
    result.ms = Date.now() - started;
    say(`after:  local ${afterLocal.total} · ${PEER} ${afterPeer.total}${result.equal ? ' · equal' : ' · DRIFT'}`);
    return { code: result.equal ? 0 : 2, result };
  } finally {
    releaseLock();
  }
}

let outcome;
try {
  outcome = localOnly() || main();
} catch (err) {
  outcome = { code: 2, result: { ok: false, error: 'exception', note: String((err && err.message) || err).slice(0, 200), peer: PEER } };
}
process.stdout.write(JSON.stringify(outcome.result, null, 2) + '\n');
process.exit(outcome.code);
