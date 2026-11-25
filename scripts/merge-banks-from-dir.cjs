#!/usr/bin/env node
'use strict';

/*
 * merge-banks-from-dir.cjs <sourceDir> [--dry-run]
 *
 * Merges bank cluster files from another copy of ~/.hakster/memories/banks into
 * this box's own bank dir, by entry id. Used to carry the primary's memory banks
 * to the standby (§41: a standby that boots without the memories is the wrong
 * server). Append-only: an entry the destination already has is left byte-for-byte
 * as it is, and a destination-only entry is never removed — so the standby's own
 * consolidated notes survive.
 *
 *   node scripts/merge-banks-from-dir.cjs /tmp/banks-primary [--dry-run]
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const SRC = process.argv[2];
const DRY = process.argv.includes('--dry-run');
const BANK_DIR = path.join(os.homedir(), '.hakster', 'memories', 'banks');

if (!SRC || !fs.existsSync(SRC)) {
  console.error(JSON.stringify({ ok: false, error: 'source-missing', src: SRC || null }));
  process.exit(1);
}

const result = { ok: true, dryRun: DRY, files: {}, added: 0, kept: 0 };

function loadDir(dir) {
  const m = new Map();
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return m; }
  for (const f of names) {
    try { m.set(f, JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); } catch { /* unreadable: skipped, counted below */ }
  }
  return m;
}

try { fs.mkdirSync(BANK_DIR, { recursive: true }); } catch { /* the dir usually exists; a failure below reports */ }

const src = loadDir(SRC);
const dst = loadDir(BANK_DIR);

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
  const tmp = path.join(BANK_DIR, '.' + file + '.merge-' + process.pid + '.tmp');
  try {
    fs.writeFileSync(tmp, body, { mode: 0o644 });
    let replacingOtherOwner = false;
    try {
      const st = fs.statSync(target);
      if (typeof process.getuid === 'function' && st.uid !== process.getuid()) replacingOtherOwner = true;
    } catch { /* no target yet: a plain create */ }
    fs.renameSync(tmp, target);
    if (replacingOtherOwner) stat.replacedOwner = true;
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
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
