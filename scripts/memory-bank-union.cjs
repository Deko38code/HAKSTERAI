#!/usr/bin/env node
'use strict';

/*
 * memory-bank-union.cjs — the content-keyed union the bank sync merges with.
 *
 * Owner (2026-11-28): "i always want the memory count correct and the same on both boxes for better
 * memory recalling". Each box counts its own ~/.hakster/memories/banks, and the two drifted apart.
 *
 * Why this exists next to merge-banks-from-dir.cjs: that helper merges by entry ID, and two boxes that
 * bank the same fact get two ids. Measured 2026-11-28: merging the standby's 12 infrastructure entries
 * into the primary took 438 → 450 with no new knowledge. Keying on the normalised observation text
 * collapses them, so the count is CORRECT as well as equal.
 *
 * Deterministic, so both boxes independently derive byte-identical files:
 *   key        sha256(normalised observation text)
 *   canonical  the entry with the smaller id (both sides pick the same one)
 *   tags       sorted union (a tag added on either box survives on both)
 *   timestamp  the earlier of the two
 *   order      timestamp desc, then id asc (readMemoryBanks is max-timestamp, pullMemoryBanks ranks by
 *              score, so the order changes no recall)
 *
 * Nothing is deleted: a destination-only bank file is kept, a destination-only entry is kept, and every
 * file rewritten is archived under <bankdir>/../banks-sync-backup/<stamp>/ first, then swapped atomically.
 *
 * Roots — one box can hold more than the owner's banks. `banks` is the box's own set; every
 * `users/<slug>/banks` is that user's set and is unioned the same way, never merged into another user's
 * (§29.6, §53). No per-user root exists on this box yet, so the tree modes are a no-op until one does.
 *
 * Usage
 *   node scripts/memory-bank-union.cjs --manifest [--json] [--target DIR]
 *   node scripts/memory-bank-union.cjs --merge-from DIR [--json] [--dry-run] [--target DIR]
 *   node scripts/memory-bank-union.cjs --verify --peer-dir DIR [--json] [--target DIR]
 *   node scripts/memory-bank-union.cjs --self-dedup            collapse duplicate facts in this box
 *   node scripts/memory-bank-union.cjs --roots [--json]        list every bank root this box holds
 *   node scripts/memory-bank-union.cjs --merge-tree SRC_MEM_DIR [--json] [--dry-run]
 *   node scripts/memory-bank-union.cjs --verify-tree PEER_MEM_DIR [--json]
 * Exits: 0 equal / done · 1 drift found · 2 usage or read error.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = process.env.HAKSTER_HOME || os.homedir();
const DEFAULT_ROOT = path.join(HOME, '.hakster', 'memories', 'banks');

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const flag = (n, fb) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : fb; };

const TARGET = flag('--target', DEFAULT_ROOT);
const BACKUP_ROOT = path.join(path.dirname(TARGET), 'banks-sync-backup');
const JSON_OUT = has('--json');
const DRY = has('--dry-run');
const MERGE_FROM = flag('--merge-from', null);
const MERGE_TREE = flag('--merge-tree', null);
const VERIFY_TREE = flag('--verify-tree', null);
const PEER_DIR = flag('--peer-dir', null);
const SELF = has('--self-dedup');
const ROOTS = has('--roots');

// The memories dir that holds `banks` and, when they exist, `users/<slug>/banks`.
const MEM_DIR = flag('--mem-dir', path.dirname(DEFAULT_ROOT));

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
const stampNow = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, 'Z');

function contentKey(e) {
  const text = e.observation || e.text || e.title || e.value || '';
  const key = norm(text);
  return key ? sha(key).slice(0, 24) : 'id:' + String(e.id || sha(JSON.stringify(e)).slice(0, 24));
}

const ts = (e) => Date.parse(e.timestamp || e.bankedAt || '') || 0;
const bankFiles = (dir) => {
  try { return fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !/\.bak[-.]/.test(f)).sort(); } catch { return []; }
};
const readBankList = (f) => {
  try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); return Array.isArray(j) ? j : null; } catch { return null; }
};

function mergeEntry(a, b) {
  const canon = String(a.id || '') <= String(b.id || '') ? a : b;
  const other = canon === a ? b : a;
  const tags = new Set();
  for (const t of [...(Array.isArray(a.tags) ? a.tags : []), ...(Array.isArray(b.tags) ? b.tags : [])]) {
    const s = String(t).trim();
    if (s) tags.add(s);
  }
  const out = { ...canon };
  if (tags.size) out.tags = [...tags].sort((x, y) => (x.toLowerCase() < y.toLowerCase() ? -1 : x.toLowerCase() > y.toLowerCase() ? 1 : 0));
  if (ts(other) && (!ts(canon) || ts(other) < ts(canon))) out.timestamp = other.timestamp || other.bankedAt;
  // Confidence is knowledge too: the same fact recorded more confidently on one
  // box must not be downgraded by picking the canonical id (autolearn's own
  // persistBank keeps the max for exactly this reason).
  const conf = Math.max(Number(canon.confidence) || 0, Number(other.confidence) || 0);
  if (conf > 0) out.confidence = conf;
  return out;
}

/** Deterministic: union(A,B) and union(B,A) serialise identically. */
function unionEntries(aList, bList) {
  const by = new Map();
  for (const e of [...aList, ...bList]) {
    if (!e || typeof e !== 'object') continue;
    const k = contentKey(e);
    if (!by.has(k)) by.set(k, e);
    else by.set(k, mergeEntry(by.get(k), e));
  }
  return [...by.values()].sort((x, y) => (ts(y) - ts(x))
    || (String(x.id || '') < String(y.id || '') ? -1 : String(x.id || '') > String(y.id || '') ? 1 : 0));
}

const serialize = (entries) => JSON.stringify(entries, null, 2) + '\n';

function backupAndWrite(file, body, stamp, backupRoot) {
  const dir = path.join(backupRoot, stamp);
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* archive is best-effort */ }
  if (fs.existsSync(file)) { try { fs.copyFileSync(file, path.join(dir, path.basename(file))); } catch { /* keep going */ } }
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, body, { mode: 0o644 });
  fs.renameSync(tmp, file);
}

/** Entries + a fingerprint of the DISTINCT FACTS — not the raw bytes.
 *  A file the union never needed to rewrite keeps its old formatting, so two
 *  boxes can hold identical knowledge in different bytes; comparing bytes called
 *  that drift (measured 2026-11-28 on a cross-box per-user root) and would send
 *  an auto-sync chasing a difference that is only whitespace. */
function manifestOf(dir) {
  const banks = {};
  let total = 0;
  for (const f of bankFiles(dir)) {
    const list = readBankList(path.join(dir, f));
    if (list === null) { banks[f] = { entries: null, sha: null, unreadable: true }; continue; }
    const keys = [...new Set(list.filter((e) => e && typeof e === 'object').map(contentKey))].sort();
    banks[f] = { entries: list.length, sha: sha(keys.join('\n')).slice(0, 16) };
    total += list.length;
  }
  return { dir, total, banks, present: fs.existsSync(dir) };
}

function mergeInto(src, destDir, stamp) {
  if (!fs.existsSync(src)) return { ok: false, error: 'source-missing', src };
  try { fs.mkdirSync(destDir, { recursive: true }); } catch { return { ok: false, error: 'target-unwritable', dir: destDir }; }
  const backupRoot = path.join(path.dirname(destDir), 'banks-sync-backup');
  const r = { ok: true, mode: 'merge', src, dir: destDir, stamp, files: {}, added: 0, kept: 0, wrote: [], total: 0 };
  for (const f of bankFiles(src)) {
    const srcList = readBankList(path.join(src, f));
    if (srcList === null) continue; // never merge a half-written file
    const destFile = path.join(destDir, f);
    const destList = fs.existsSync(destFile) ? readBankList(destFile) : [];
    if (destList === null) { r.files[f] = 'skipped-unreadable-destination'; continue; }
    const before = destList.length;
    const merged = unionEntries(destList, srcList);
    const body = serialize(merged);
    const current = fs.existsSync(destFile) ? fs.readFileSync(destFile, 'utf8') : null;
    if (!DRY && current !== body) { backupAndWrite(destFile, body, stamp, backupRoot); r.wrote.push(f); }
    const added = merged.length - before;
    r.files[f] = { before, after: merged.length, added: added > 0 ? added : 0 };
    if (added > 0) r.added += added; else r.kept += before;
  }
  r.total = manifestOf(destDir).total;
  return r;
}

function mergeFrom(src) {
  return mergeInto(src, TARGET, stampNow());
}

/** Collapse duplicate facts already sitting in this box (merging a dir into itself). */
function selfDedup() {
  return mergeFrom(TARGET);
}

function verify(peerDir, targetDir = TARGET) {
  const L = manifestOf(targetDir);
  const P = manifestOf(peerDir);
  const names = new Set([...Object.keys(L.banks), ...Object.keys(P.banks)]);
  const banks = [];
  const drift = [];
  let equal = true;
  for (const n of [...names].sort()) {
    const a = L.banks[n] || { entries: 0, sha: null };
    const b = P.banks[n] || { entries: 0, sha: null };
    const same = a.entries === b.entries && a.sha === b.sha;
    banks.push({ bank: n.replace(/\.json$/, ''), local: a.entries, peer: b.entries, same });
    if (!same) { equal = false; drift.push({ bank: n, local: a.entries, peer: b.entries }); }
  }
  return { ok: equal, mode: 'verify', peer: peerDir, equal, localTotal: L.total, peerTotal: P.total, banks, drift };
}

// ── roots: the box's own banks plus every per-user set ───────────────────────
/** Sorted relative root names ("banks", "users/<slug>/banks") that exist under a memories dir. */
function rootRels(memDir) {
  const rels = [];
  if (fs.existsSync(path.join(memDir, 'banks'))) rels.push('banks');
  let users = [];
  try { users = fs.readdirSync(path.join(memDir, 'users'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort(); } catch { users = []; }
  for (const slug of users) {
    if (fs.existsSync(path.join(memDir, 'users', slug, 'banks'))) rels.push(`users/${slug}/banks`);
  }
  return rels;
}

function rootsManifest(memDir) {
  const roots = rootRels(memDir).map((rel) => {
    const m = manifestOf(path.join(memDir, rel));
    return { root: rel, dir: m.dir, entries: m.total, present: m.present, unreadable: Object.values(m.banks).some((b) => b.unreadable) };
  });
  return { mode: 'roots', memDir, roots, total: roots.reduce((n, r) => n + r.entries, 0) };
}

/** Union every root in SRC_MEM_DIR into this box, root for root — never across roots. */
function mergeTree(srcMemDir) {
  if (!fs.existsSync(srcMemDir)) return { ok: false, mode: 'merge-tree', error: 'source-missing', src: srcMemDir };
  const stamp = stampNow();
  const rels = [...new Set([...rootRels(MEM_DIR), ...rootRels(srcMemDir)])].sort();
  const roots = {};
  let added = 0;
  let total = 0;
  for (const rel of rels) {
    const src = path.join(srcMemDir, rel);
    if (!fs.existsSync(src)) { roots[rel] = { skipped: 'not-on-peer' }; continue; }
    const r = mergeInto(src, path.join(MEM_DIR, rel), stamp);
    roots[rel] = { added: r.added || 0, total: r.total || 0, wrote: r.wrote || [], error: r.error };
    added += r.added || 0;
    total += r.total || 0;
  }
  return { ok: true, mode: 'merge-tree', src: srcMemDir, memDir: MEM_DIR, stamp, roots, added, total };
}

/** Verify every root this box holds against the peer's same root name. */
function verifyTree(peerMemDir) {
  const rels = [...new Set([...rootRels(MEM_DIR), ...rootRels(peerMemDir)])].sort();
  const roots = {};
  let equal = true;
  let localTotal = 0;
  let peerTotal = 0;
  for (const rel of rels) {
    const local = path.join(MEM_DIR, rel);
    const peer = path.join(peerMemDir, rel);
    const v = verify(peer, local);
    roots[rel] = { equal: v.equal, local: v.localTotal, peer: v.peerTotal, drift: v.drift };
    if (!v.equal) equal = false;
    localTotal += v.localTotal;
    peerTotal += v.peerTotal;
  }
  return { ok: equal, mode: 'verify-tree', equal, peer: peerMemDir, localTotal, peerTotal, roots };
}

let result;
if (ROOTS) result = rootsManifest(MEM_DIR);
else if (MERGE_TREE) result = mergeTree(MERGE_TREE);
else if (VERIFY_TREE) result = verifyTree(VERIFY_TREE);
else if (MERGE_FROM) result = mergeFrom(MERGE_FROM);
else if (SELF) result = selfDedup();
else if (PEER_DIR) result = verify(PEER_DIR);
else result = { ok: true, mode: 'manifest', ...manifestOf(TARGET) };

if (JSON_OUT) {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} else if (result.mode === 'verify') {
  console.log(`${result.equal ? 'EQUAL' : 'DRIFT'}  local ${result.localTotal} / peer ${result.peerTotal}`);
  for (const b of result.banks) if (!b.same) console.log(`  ${b.bank}: local ${b.local} / peer ${b.peer}`);
  console.log(result.equal ? 'both boxes hold the same banks' : `${result.drift.length} bank(s) differ`);
} else if (result.mode === 'verify-tree') {
  console.log(`${result.equal ? 'EQUAL' : 'DRIFT'}  local ${result.localTotal} / peer ${result.peerTotal} across ${Object.keys(result.roots).length} root(s)`);
  for (const [rel, r] of Object.entries(result.roots)) if (!r.equal) console.log(`  ${rel}: local ${r.local} / peer ${r.peer}`);
  console.log(result.equal ? 'both boxes hold the same banks in every root' : 'drift remains');
} else if (result.mode === 'roots') {
  console.log(`${result.memDir}  ${result.roots.length} root(s), ${result.total} entries`);
  for (const r of result.roots) console.log(`  ${r.root.padEnd(34)} ${String(r.entries).padStart(4)}${r.unreadable ? '  unreadable' : ''}`);
} else if (result.mode === 'merge-tree') {
  if (!result.ok) { console.log(`tree merge failed: ${result.error}`); }
  else {
    console.log(`merged ${result.src} into ${result.memDir}: ${result.added} added, ${result.total} total across ${Object.keys(result.roots).length} root(s)`);
    for (const [rel, r] of Object.entries(result.roots)) if (r.added) console.log(`  ${rel}: +${r.added} -> ${r.total}`);
  }
} else if (result.mode === 'merge') {
  if (!result.ok) { console.log(`merge failed: ${result.error}`); }
  else {
    console.log(`merged ${result.src} into ${result.dir}: ${result.added} added, ${result.total} total${DRY ? ' (dry run)' : ''}`);
    if (result.wrote.length) console.log(`  rewritten: ${result.wrote.join(', ')} (previous copies in ${path.join(path.dirname(result.dir), 'banks-sync-backup')}/${result.stamp})`);
  }
} else {
  console.log(`${result.dir}  ${result.total} entries`);
  for (const [f, b] of Object.entries(result.banks)) console.log(`  ${f.replace(/\.json$/, '').padEnd(26)} ${b.entries === null ? 'unreadable' : String(b.entries).padStart(4)}  ${b.sha || '-'}`);
}

process.exit(result.ok === false || result.equal === false ? 1 : 0);
