#!/usr/bin/env node
'use strict';

/*
 * merge-banks-from-dir.cjs <sourceDir> [--prune] [--dry-run] [--target DIR] [--archive DIR]
 *
 * Carries bank cluster files (~/.hakster/memories/banks/*.json) from another copy
 * of the banks into this box's own bank dir. Used to carry the primary's memory
 * banks to the standby (§41: a standby that boots without the memories is the
 * wrong server).
 *
 *   default (append-only) — an entry the destination already has is left exactly
 *                           as it is, and a destination-only entry is never
 *                           removed. The standby's own consolidated notes survive.
 *
 *   --prune (mirror)      — the destination is made identical to the source: the
 *                           source file's own bytes are installed, so both boxes
 *                           recall the same set, in the same order. Anything the
 *                           destination had that the source does not — plus any
 *                           version of a shared id that differs — is archived
 *                           under <archive>/<stamp>/ FIRST. Nothing is deleted
 *                           outright. A mirror run with nothing to remove writes
 *                           nothing at all.
 *
 * Guards on --prune (owner, 2026-11-26: "prune but dont break"):
 *   · an empty source never replaces the destination (a damaged primary must not
 *     wipe the standby's memories);
 *   · a source with less than half the destination's entries is refused for the
 *     same reason, and reported as `refused`, never applied;
 *   · every removal is archived before the swap, and the swap is atomic.
 *
 *   node scripts/merge-banks-from-dir.cjs /tmp/banks-primary [--prune] [--dry-run]
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
// The source dir is always the first argument; never pick it out of the flags,
// or `--target DIR` would be mistaken for the source.
const SRC = args[0] && !args[0].startsWith('--') ? args[0] : null;
const DRY = args.includes('--dry-run');
const PRUNE = args.includes('--prune');
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };

const BANK_DIR = flag('--target') || path.join(os.homedir(), '.hakster', 'memories', 'banks');
const ARCHIVE_ROOT = flag('--archive') || path.join(os.homedir(), '.hakster', 'memories', 'banks-pruned');

// Below this share of the destination's entries, a mirror run is refused: an
// empty or half-written primary must never empty a healthy standby.
const PRUNE_FLOOR = 0.5;

if (!SRC || !fs.existsSync(SRC)) {
  console.error(JSON.stringify({ ok: false, error: 'source-missing', src: SRC || null }));
  process.exit(1);
}

const result = { ok: true, dryRun: DRY, prune: PRUNE, files: {}, added: 0, kept: 0 };

function loadDir(dir) {
  const m = new Map();
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return m; }
  for (const f of names) {
    try { m.set(f, JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); } catch { /* unreadable: skipped, counted below */ }
  }
  return m;
}

function readEntries(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(j) ? j : [];
  } catch { return []; }
}

// What makes two entries "the same memory": the observation and its classification,
// never the bookkeeping fields (id, timestamp, bankedAt) that differ per write.
function contentHash(e) {
  const tags = Array.isArray(e && e.tags) ? [...e.tags].sort() : [];
  const body = JSON.stringify([e && e.observation, e && e.type, e && e.confidence, tags]);
  return crypto.createHash('sha256').update(String(body)).digest('hex');
}

function writeFileAtomic(target, body, mode) {
  const tmp = path.join(path.dirname(target), '.' + path.basename(target) + '.merge-' + process.pid + '.tmp');
  fs.writeFileSync(tmp, body, { mode: mode || 0o644 });
  fs.renameSync(tmp, target);
}

try { fs.mkdirSync(BANK_DIR, { recursive: true }); } catch { /* the dir usually exists; a failure below reports */ }

const src = loadDir(SRC);
const dst = loadDir(BANK_DIR);
const srcArrays = [...src.entries()].filter(([, v]) => Array.isArray(v));
const srcTotal = srcArrays.reduce((n, [, v]) => n + v.length, 0);
const dstTotal = [...dst.values()].filter(Array.isArray).reduce((n, v) => n + v.length, 0);

if (PRUNE && (srcTotal === 0 || srcTotal < dstTotal * PRUNE_FLOOR)) {
  console.error(JSON.stringify({
    ok: false,
    refused: 'source-too-small',
    prune: true,
    sourceEntries: srcTotal,
    destinationEntries: dstTotal,
    floor: PRUNE_FLOOR,
    note: 'a damaged or partial source never replaces the destination; nothing was written',
  }, null, 2));
  process.exit(2);
}

// ── mirror (--prune) ────────────────────────────────────────────────────────
if (PRUNE) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '');
  const archiveDir = path.join(ARCHIVE_ROOT, stamp + '-' + process.pid);
  const archive = { stamp, source: SRC, target: BANK_DIR, removed: {}, removedFiles: [] };
  let toRemove = 0;

  for (const [file, srcEntries] of srcArrays) {
    const target = path.join(BANK_DIR, file);
    const srcBuf = fs.readFileSync(path.join(SRC, file));
    const dstEntries = readEntries(target);
    const srcById = new Map(srcEntries.filter((e) => e && e.id).map((e) => [e.id, e]));
    const srcIds = new Set(srcById.keys());

    const gone = dstEntries.filter((e) => !e || !e.id || !srcIds.has(e.id));
    const differing = dstEntries.filter((e) => e && e.id && srcIds.has(e.id) && contentHash(e) !== contentHash(srcById.get(e.id)));
    const removedHere = [...gone, ...differing];

    let bytesEqual = false;
    try { bytesEqual = fs.readFileSync(target).equals(srcBuf); } catch { bytesEqual = false; }

    const stat = result.files[file] = {
      before: dstEntries.length,
      after: bytesEqual ? dstEntries.length : srcEntries.length,
      added: bytesEqual ? 0 : Math.max(0, srcEntries.length - (dstEntries.length - gone.length)),
      removed: removedHere.length,
      collisions: differing.length,
    };
    result.added += stat.added;
    result.kept += bytesEqual ? dstEntries.length : srcEntries.length;

    if (!removedHere.length && bytesEqual) continue;
    if (removedHere.length) { archive.removed[file] = removedHere; toRemove += removedHere.length; }
    if (DRY) continue;

    if (removedHere.length) {
      for (const e of removedHere) {
        if (e && e.id) result.removed = (result.removed || 0) + 1;
      }
    }
    try {
      let replacingOtherOwner = false;
      try {
        const st = fs.statSync(target);
        if (typeof process.getuid === 'function' && st.uid !== process.getuid()) replacingOtherOwner = true;
      } catch { /* no target yet: a plain create */ }
      writeFileAtomic(target, srcBuf);
      if (replacingOtherOwner) stat.replacedOwner = true;
    } catch (err) {
      stat.blocked = String(err.code || err.message || err);
      result.blocked = result.blocked || [];
      result.blocked.push({ file, reason: stat.blocked });
      result.added -= stat.added;
      stat.added = 0;
      stat.after = dstEntries.length;
    }
  }

  // A bank file the destination has and the source does not cannot be part of an
  // exact mirror. Archive the whole file, then move it aside.
  for (const [file, dstEntries] of dst) {
    if (src.has(file)) continue;
    if (!Array.isArray(dstEntries)) continue;
    archive.removedFiles.push(file);
    toRemove += dstEntries.length;
    if (DRY) continue;
    const target = path.join(BANK_DIR, file);
    try {
      fs.mkdirSync(path.join(archiveDir), { recursive: true, mode: 0o755 });
      const keep = path.join(archiveDir, file);
      writeFileAtomic(keep, JSON.stringify(dstEntries, null, 2) + '\n');
      fs.unlinkSync(target);
      result.files[file] = { before: dstEntries.length, after: 0, added: 0, removed: dstEntries.length, fileRemoved: true };
      result.removed = (result.removed || 0) + dstEntries.length;
    } catch (err) {
      result.files[file] = { before: dstEntries.length, after: dstEntries.length, blocked: String(err.code || err.message || err) };
      result.blocked = result.blocked || [];
      result.blocked.push({ file, reason: 'file-removal: ' + String(err.code || err.message || err) });
    }
  }

  if (toRemove && !DRY) {
    try {
      fs.mkdirSync(archiveDir, { recursive: true, mode: 0o755 });
      writeFileAtomic(path.join(archiveDir, 'removed.json'), JSON.stringify(archive, null, 2) + '\n');
      result.archived = { dir: archiveDir, entries: toRemove, files: Object.keys(archive.removed).length + archive.removedFiles.length };
    } catch (err) {
      // The swap already happened for the written files; say so loudly rather
      // than pretend the removal was archived.
      result.archiveError = String(err.code || err.message || err);
    }
  }
  result.mirrored = true;
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

// ── append-only (default) ───────────────────────────────────────────────────
for (const [file, srcEntries] of src) {
  if (!Array.isArray(srcEntries)) continue;
  const target = path.join(BANK_DIR, file);
  let cur = [];
  let hadNewline = true;
  try {
    const raw = fs.readFileSync(target, 'utf8');
    hadNewline = raw.endsWith('\n');
    cur = JSON.parse(raw);
    if (!Array.isArray(cur)) cur = [];
  } catch { cur = []; }

  const have = new Set(cur.map((e) => e && e.id));
  const add = srcEntries.filter((e) => e && e.id && !have.has(e.id));
  const stat = result.files[file] = { before: cur.length, added: add.length, after: cur.length + add.length };
  result.added += add.length;
  result.kept += cur.length;
  if (!add.length || DRY) continue;

  // Write to a temp file in the same directory and rename it over the target.
  // rename() needs only directory write permission, so a bank left root-owned by
  // an old root-run server no longer blocks the merge — and because the swap is
  // atomic, a slot reading banks mid-sync never parses a half-written file.
  const body = JSON.stringify([...cur, ...add], null, 2) + (hadNewline ? '\n' : '');
  try {
    let replacingOtherOwner = false;
    try {
      const st = fs.statSync(target);
      if (typeof process.getuid === 'function' && st.uid !== process.getuid()) replacingOtherOwner = true;
    } catch { /* no target yet: a plain create */ }
    writeFileAtomic(target, body, 0o644);
    if (replacingOtherOwner) stat.replacedOwner = true;
  } catch (err) {
    // Still unwritable (e.g. the directory is not ours): reported, never forced.
    stat.blocked = String(err.code || err.message || err);
    result.blocked = result.blocked || [];
    result.blocked.push({ file, reason: stat.blocked });
    result.added -= add.length;
    stat.added = 0;
    stat.after = cur.length;
  }
}

console.log(JSON.stringify(result, null, 2));
