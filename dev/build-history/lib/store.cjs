'use strict';
/**
 * Build history store — append-only JSONL on disk.
 *
 * Why not the app database: build history has to survive PM2 restarts, a
 * crashed recorder and a half-written record, and it must never be rewritten
 * by a process that dies mid-write. One JSON object per line, appended with
 * a single write, has those properties and stays readable by hand.
 *
 * Idempotency: every record carries `key = project + ':' + buildId`. A record
 * with a key already present is ignored on insert and reported as a duplicate,
 * so a retried build event can never double-count.
 *
 * Nothing here deletes or truncates. A corrupt line is skipped and counted,
 * never dropped from the file.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'builds.jsonl');

function ensureDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
}

function readAll() {
  const rows = [];
  const problems = [];
  let text;
  try { text = fs.readFileSync(FILE, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return { rows, problems, missing: true };
    problems.push({ line: 0, error: e.code || e.message });
    return { rows, problems, missing: false };
  }
  text.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    try {
      const rec = JSON.parse(line);
      if (!rec || !rec.key) throw new Error('record without key');
      rows.push(rec);
    } catch (e) {
      problems.push({ line: i + 1, error: e.message });
    }
  });
  return { rows, problems, missing: false };
}

function indexByKey(rows) {
  const map = new Map();
  for (const r of rows) map.set(r.key, r);
  return map;
}

/** Insert unless the key already exists. Returns { stored, duplicate }. */
function insert(record) {
  ensureDir();
  if (!record || !record.key) throw new Error('record.key is required');
  const { rows } = readAll();
  const seen = indexByKey(rows);
  if (seen.has(record.key)) {
    return { stored: false, duplicate: true, existing: seen.get(record.key) };
  }
  const line = JSON.stringify(record) + '\n';
  fs.appendFileSync(FILE, line, { mode: 0o600 });
  return { stored: true, duplicate: false };
}

/** Update an existing record in place (status changes), append-only rewrite. */
function update(key, mutator) {
  ensureDir();
  const { rows } = readAll();
  const idx = rows.findIndex((r) => r.key === key);
  if (idx === -1) return { updated: false, reason: 'not found' };
  const next = mutator({ ...rows[idx] });
  next.key = key;
  next.updatedAt = new Date().toISOString();
  rows[idx] = next;
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 });
  fs.renameSync(tmp, FILE);
  return { updated: true, record: next };
}

function query(filter = {}) {
  const { rows, problems } = readAll();
  let out = rows.slice();
  if (filter.project) out = out.filter((r) => r.project === filter.project);
  if (filter.status) out = out.filter((r) => r.outcome === filter.status || r.buildStatus === filter.status);
  if (filter.buildId) out = out.filter((r) => String(r.buildId || '').toLowerCase().includes(String(filter.buildId).toLowerCase()));
  if (filter.since) {
    const t = Date.parse(filter.since);
    if (Number.isFinite(t)) out = out.filter((r) => Date.parse(r.startedAt) >= t);
  }
  out.sort((a, b) => (Date.parse(b.startedAt) || 0) - (Date.parse(a.startedAt) || 0));
  const limit = Number(filter.limit) || 100;
  return { rows: out.slice(0, limit), total: out.length, problems };
}

function stats() {
  const { rows, problems } = readAll();
  const byProject = {};
  for (const r of rows) {
    byProject[r.project] = byProject[r.project] || { total: 0, success: 0, failed: 0, unknown: 0 };
    byProject[r.project].total += 1;
    const o = r.outcome || 'unknown';
    if (o === 'success') byProject[r.project].success += 1;
    else if (o === 'failed') byProject[r.project].failed += 1;
    else byProject[r.project].unknown += 1;
  }
  return { total: rows.length, byProject, problems, file: FILE };
}

module.exports = { FILE, DATA_DIR, insert, update, query, stats, readAll };
