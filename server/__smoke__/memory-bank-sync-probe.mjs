#!/usr/bin/env node
'use strict';

/*
 * memory-bank-sync-probe.mjs — proves the bank reconciliation does what the rule says.
 *
 * Owner (2026-11-28): the memory count must be correct and the same on both boxes.
 * This runs the real scripts/memory-bank-union.cjs against throwaway dirs, so it
 * proves the shipped code (never a copy of it) and never touches ~/.hakster.
 *
 * Checks:
 *   1. manifest counts entries and skips .bak sidecars
 *   2. the same fact banked under two ids collapses to ONE entry (no doubling) — the 438→450 defect
 *   3. --self-dedup collapses duplicates already in a box
 *   4. a tag added on one box survives on both (sorted union)
 *   5. a destination-only and a source-only entry are both kept
 *   6. --verify reports drift (exit 1) then equal (exit 0) after a two-way union
 *   7. after both directions every bank file is byte-identical on both sides
 *   8. a second merge writes nothing (idempotent)
 *   9. a rewrite archives the previous file first
 *  10. a half-written bank is skipped, never overwritten
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, '..', '..', 'scripts', 'memory-bank-union.cjs');

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
};

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const tmpRoot = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `mbank-${label}-`));

function writeBank(dir, slug, entries) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${slug}.json`), JSON.stringify(entries, null, 2) + '\n');
}

function run(args) {
  try { return { code: 0, out: execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' }) }; }
  catch (err) { return { code: err.status ?? 1, out: String(err.stdout || '') + String(err.stderr || '') }; }
}

const entry = (id, observation, extra = {}) => ({ id, timestamp: '2026-11-27T10:00:00.000Z', tags: ['infra'], observation, ...extra });

console.log('memory-bank-union probe');

// 1. manifest
{
  const root = tmpRoot('manifest');
  writeBank(root, 'infra', [entry('mem_1', 'fact one'), entry('mem_2', 'fact two')]);
  fs.writeFileSync(path.join(root, 'infra.json.bak-20260101T000000Z'), '[]');
  const m = JSON.parse(run(['--manifest', '--json', '--target', root]).out);
  check('manifest counts entries and ignores .bak sidecars', m.total === 2 && Object.keys(m.banks).length === 1, JSON.stringify(m).slice(0, 160));
}

// 2 + 3. content dedupe across boxes, and duplicates already present
{
  const root = tmpRoot('dupe');
  const D = path.join(root, 'D');
  const L = path.join(root, 'L');
  writeBank(D, 'infra', [entry('mem_dell_1', 'the standby door answers on 3581'), entry('mem_dell_2', 'dell only fact')]);
  writeBank(L, 'infra', [entry('mem_len_1', 'the standby door answers on 3581'), entry('mem_len_2', 'lenovo only fact')]);
  const r = run(['--merge-from', L, '--target', D, '--json']);
  const merged = JSON.parse(fs.readFileSync(path.join(D, 'infra.json'), 'utf8'));
  check('same fact under two ids collapses to one entry', merged.length === 3, `len=${merged.length}`);

  const dup = path.join(root, 'dup');
  writeBank(dup, 'infra', [entry('mem_a', 'one fact'), entry('mem_b', 'one fact')]);
  run(['--self-dedup', '--target', dup]);
  const deduped = JSON.parse(fs.readFileSync(path.join(dup, 'infra.json'), 'utf8'));
  check('--self-dedup collapses duplicates already in a box', deduped.length === 1, `len=${deduped.length}`);

  // 4 + 5. tag union, both directions keep entries
  writeBank(D, 'infra', [{ ...merged[0], tags: ['infra', 'net'] }, { ...merged[1] }, { ...merged[2] }]);
  const B = path.join(root, 'B');
  writeBank(B, 'infra', [{ id: 'mem_len_x', timestamp: '2026-11-27T10:00:00.000Z', tags: ['infra', 'box'], observation: String(merged[0].observation) }]);
  run(['--merge-from', B, '--target', D]);
  const afterTags = JSON.parse(fs.readFileSync(path.join(D, 'infra.json'), 'utf8'));
  const tags = afterTags.flatMap((e) => e.tags || []);
  check('a tag from either box survives on both', tags.includes('net') && tags.includes('box'), JSON.stringify(tags));
  const texts = afterTags.map((e) => e.observation);
  check('a destination-only entry is kept', texts.includes('dell only fact'));
  check('a source-only entry is brought in', texts.includes('lenovo only fact'));

  // 6 + 7. drift then equal, byte-identical
  const A2 = path.join(root, 'A2');
  const B2 = path.join(root, 'B2');
  fs.cpSync(D, A2, { recursive: true });
  writeBank(B2, 'infra', [entry('mem_z', 'a fact only on the second box')]);
  const v1 = run(['--verify', '--peer-dir', B2, '--target', A2]);
  check('verify reports drift before the second direction (exit 1)', v1.code === 1 && /DRIFT/.test(v1.out), v1.out.slice(0, 120));
  run(['--merge-from', B2, '--target', A2]);
  run(['--merge-from', A2, '--target', B2]);
  const v2 = run(['--verify', '--peer-dir', B2, '--target', A2]);
  check('verify reports equal after both directions (exit 0)', v2.code === 0 && /EQUAL/.test(v2.out), v2.out.slice(0, 120));
  check('every bank file is byte-identical on both sides', sha(path.join(A2, 'infra.json')) === sha(path.join(B2, 'infra.json')));

  // 8. idempotent
  const before = sha(path.join(A2, 'infra.json'));
  const mtime = fs.statSync(path.join(A2, 'infra.json')).mtimeMs;
  const again = run(['--merge-from', B2, '--target', A2]);
  check('a second merge writes nothing (idempotent)', again.code === 0 && sha(path.join(A2, 'infra.json')) === before && fs.statSync(path.join(A2, 'infra.json')).mtimeMs === mtime, again.out.slice(0, 120));

  // 9. archive before swap
  const backupRoot = path.join(path.dirname(A2), 'banks-sync-backup');
  check('a rewrite archives the previous file first', fs.existsSync(backupRoot) && fs.readdirSync(backupRoot).length > 0, backupRoot);

  // 10. half-written bank untouched
  const rootB = tmpRoot('broken');
  const C = path.join(rootB, 'C');
  const S = path.join(rootB, 'S');
  writeBank(C, 'ok', [entry('mem_c', 'kept fact')]);
  writeBank(S, 'ok', [entry('mem_s', 'new fact')]);
  fs.writeFileSync(path.join(C, 'broken.json'), '[{"id":"half",');
  const brokenBefore = sha(path.join(C, 'broken.json'));
  const r10 = run(['--merge-from', S, '--target', C]);
  check('a half-written bank is not overwritten', r10.code === 0 && sha(path.join(C, 'broken.json')) === brokenBefore, r10.out.slice(0, 120));
}

// 11–13. per-user roots: every CLI user's banks sync too, and never into another user's set
{
  const root = tmpRoot('roots');
  const A = path.join(root, 'A');
  const B = path.join(root, 'B');
  writeBank(path.join(A, 'banks'), 'infra', [entry('mem_a', 'shared fact')]);
  writeBank(path.join(B, 'banks'), 'infra', [entry('mem_b', 'shared fact'), entry('mem_c', 'peer only fact')]);
  writeBank(path.join(B, 'users', 'u1', 'banks'), 'lessons', [entry('mem_u1', 'user one fact')]);
  writeBank(path.join(B, 'users', 'u2', 'banks'), 'lessons', [entry('mem_u2', 'user two fact')]);

  const m = run(['--mem-dir', A, '--merge-tree', B]);
  check('tree merge names the root it wrote into', m.code === 0 && !/undefined/.test(m.out), m.out.slice(0, 120));
  const box = JSON.parse(fs.readFileSync(path.join(A, 'banks', 'infra.json'), 'utf8'));
  check('a per-user root is brought across without joining the box root', box.length === 2 && box.every((e) => /fact/.test(e.observation)) && !box.some((e) => /user (one|two) fact/.test(e.observation)), JSON.stringify(box.map((e) => e.observation)));
  const u1 = fs.readFileSync(path.join(A, 'users', 'u1', 'banks', 'lessons.json'), 'utf8');
  const u2 = fs.readFileSync(path.join(A, 'users', 'u2', 'banks', 'lessons.json'), 'utf8');
  check('each user root keeps only its own entries', /user one fact/.test(u1) && !/user two fact/.test(u1) && /user two fact/.test(u2) && !/user one fact/.test(u2));

  run(['--mem-dir', A, '--merge-tree', B]);
  run(['--mem-dir', B, '--merge-tree', A]);
  const va = run(['--mem-dir', A, '--verify-tree', B]);
  check('every root verifies equal on both boxes', va.code === 0 && /EQUAL/.test(va.out) && /2 root\(s\)|3 root\(s\)/.test(va.out), va.out.slice(0, 120));
  const idem = run(['--mem-dir', A, '--merge-tree', B]);
  check('a second tree merge adds nothing', idem.code === 0 && /0 added/.test(idem.out), idem.out.slice(0, 120));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
