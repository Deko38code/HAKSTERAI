#!/usr/bin/env node
'use strict';

/*
 * seed-banks-from-db-memories.cjs
 *
 * Owner, 2026-11-26: "now add backup memorys to clusters".
 *
 * The restored keyed memories live in data/hakster.db (table `memories`), but the
 * memory-bank clusters the TUI shows and the runs pull from live at
 * ~/.hakster/memories/banks/<slug>.json — built only by consolidation, the recap
 * writer and direct bank adds. Nothing ever mirrored the keyed store into them,
 * so the backup memories were invisible to clusters and to pullMemoryBanks().
 *
 * This seeds every restored keyed memory into its matching bank file in the same
 * format production reads (tags / observation / type / confidence / bankedAt),
 * keyed on the memory's own DB id so a re-run is a no-op and four near-identical
 * account rows stay four entries instead of collapsing into one. BANK_CAP is the
 * same 300 the banks use.
 *
 * Read-only on the DB (node:sqlite, readOnly). Writes only bank JSON files.
 * Never prints an observation's text — counts and tags only (§9, §23).
 *
 *   node scripts/seed-banks-from-db-memories.cjs [--dry-run]
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DB_PATH = process.env.HAKSTER_DB || path.join(ROOT, 'data', 'hakster.db');
const BANK_DIR = path.join(os.homedir(), '.hakster', 'memories', 'banks');
const DRY = process.argv.includes('--dry-run');

// Label every seeded entry so a re-run, a prune or an audit can find exactly the
// set this script added — and so the cluster view shows them as one group.
const SEED_TAGS = ['backup-memory', 'db-backup'];

// Keyed category -> bank section. Unknown categories land in Project Facts
// (they are notes about this system), never silently dropped.
const SECTION_BY_CATEGORY = {
  context: 'Project Facts',
  relationship: 'Project Facts',
  fact: 'Project Facts',
  decision: 'Conventions',
  convention: 'Conventions',
  preference: 'User Preferences',
  procedure: 'Playbooks & Workflows',
  playbook: 'Playbooks & Workflows',
  lesson: 'Lessons & Anti-patterns',
  antipattern: 'Lessons & Anti-patterns',
  error: 'Errors Encountered',
  pattern: 'Patterns',
  general: 'Patterns',
  tool: 'Tools & Commands',
  command: 'Tools & Commands',
  infra: 'Infrastructure & Network',
  network: 'Infrastructure & Network',
  recon: 'Recon & Targets',
  vuln: 'Vulnerabilities & Findings',
  finding: 'Vulnerabilities & Findings',
};

const TYPE_BY_CATEGORY = {
  context: 'fact',
  relationship: 'fact',
  fact: 'fact',
  decision: 'convention',
  convention: 'convention',
  preference: 'preference',
  procedure: 'lesson',
  playbook: 'lesson',
  lesson: 'lesson',
  antipattern: 'lesson',
  error: 'error',
  pattern: 'pattern',
  general: 'pattern',
  tool: 'tool',
  command: 'tool',
  infra: 'infra',
  network: 'infra',
  recon: 'recon',
  vuln: 'vuln',
  finding: 'vuln',
};

// A secret-shaped observation is not copied into a prompt-fed bank. The guard
// matches a secret *value*, not the word: a note that merely says "token" or
// names ".env" is prose, and the two such rows in the restored set are kept.
const SECRET_ASSIGNMENT = /(?:api[_ -]?key|secret|password|passwd|token|credential|authorization|private[_ -]?key)\s*[:=]\s*['"`]?[A-Za-z0-9_\-.\/+=]{12,}/i;
const SECRET_BLOB = /(?:gh[pousr]_[A-Za-z0-9]{20,}|sk[-_][A-Za-z0-9_\-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b[a-f0-9]{40,}\b|\b[A-Za-z0-9_\-]{48,}\b)/;
function isSecretShaped(text) {
  return SECRET_ASSIGNMENT.test(text) || SECRET_BLOB.test(text);
}

function readBanks(dir) {
  const out = new Map();
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return out; }
  for (const file of files) {
    try {
      const entries = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      out.set(file.replace(/\.json$/, ''), Array.isArray(entries) ? entries : []);
    } catch { /* half-written bank is counted as unreadable, never as empty */ }
  }
  return out;
}

const normalize = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

// Seed by stable identity, NOT by similarity. persistBank()'s 0.6 similarity
// merge is right for consolidation, where two differently-worded notes of the
// same lesson are one lesson — but the keyed records include near-identical
// shaped rows for four different Google accounts, and similarity-merging them
// collapses distinct users into one entry. Each keyed memory therefore keeps its
// own entry, keyed on its DB id; a re-run is a no-op, and only a byte-identical
// observation is merged (tags combined) rather than duplicated.
const BANK_CAP = 300;
function seedEntry(dir, section, row, observation) {
  const file = path.join(dir, `${slug(section)}.json`);
  let all = [];
  let hadNewline = true;
  try {
    const raw = fs.readFileSync(file, 'utf8');
    hadNewline = raw.endsWith('\n');
    all = JSON.parse(raw);
    if (!Array.isArray(all)) all = [];
  } catch { all = []; }

  const keyedId = String(row.id);
  if (all.some((e) => e && e.keyedId === keyedId)) return { status: 'already' };

  const normalized = normalize(observation);
  const same = all.find((e) => e && normalize(e.observation) === normalized);
  if (same) {
    same.keyedId = same.keyedId || keyedId;
    same.source = same.source || 'hakster.db';
    const tags = new Set([...(Array.isArray(same.tags) ? same.tags : []), ...SEED_TAGS, String(row.category || 'general').toLowerCase()]);
    same.tags = [...tags];
    fs.writeFileSync(file, JSON.stringify(all, null, 2) + (hadNewline ? '\n' : ''));
    return { status: 'merged-identical' };
  }

  all.push({
    id: `dbm_${keyedId}`,
    keyedId,
    source: 'hakster.db',
    timestamp: row.created_at ? new Date(Number(row.created_at) * 1000).toISOString() : new Date().toISOString(),
    tags: [...SEED_TAGS, String(row.category || 'general').toLowerCase()],
    observation,
    type: TYPE_BY_CATEGORY[String(row.category || '').toLowerCase()] || 'fact',
    confidence: 0.8,
    bankedAt: new Date().toISOString(),
  });
  while (all.length > BANK_CAP) all.shift();
  fs.writeFileSync(file, JSON.stringify(all, null, 2) + (hadNewline ? '\n' : ''));
  return { status: 'added' };
}

function slug(section) {
  return String(section).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function main() {
  const { DatabaseSync } = require('node:sqlite');

  if (!fs.existsSync(DB_PATH)) {
    console.error(JSON.stringify({ ok: false, error: 'db-missing', db: DB_PATH }));
    process.exit(1);
  }

  const before = readBanks(BANK_DIR);

  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  let rows;
  try {
    rows = db.prepare('SELECT rowid AS rid, id, category, key, value, created_at FROM memories ORDER BY rowid').all();
  } finally {
    try { db.close(); } catch { /* read-only handle */ }
  }

  const summary = {
    ok: true,
    dryRun: DRY,
    db: path.relative(ROOT, DB_PATH),
    rows: rows.length,
    added: 0,
    alreadyBanked: 0,
    mergedIdentical: 0,
    skippedEmpty: 0,
    skippedSecretShaped: 0,
    perSection: {},
  };

  for (const row of rows) {
    const observation = String(row.value == null ? '' : row.value).replace(/\s+/g, ' ').trim();
    const category = String(row.category || 'general').toLowerCase();
    const section = SECTION_BY_CATEGORY[category] || 'Project Facts';

    if (!observation) { summary.skippedEmpty += 1; continue; }
    if (isSecretShaped(observation)) { summary.skippedSecretShaped += 1; continue; }

    const stat = summary.perSection[section] || (summary.perSection[section] = { attempted: 0, added: 0, already: 0, merged: 0 });
    stat.attempted += 1;

    const result = DRY ? { status: 'dry-run' } : seedEntry(BANK_DIR, section, row, observation);
    if (result.status === 'added' || result.status === 'dry-run') { stat.added += 1; summary.added += 1; }
    else if (result.status === 'merged-identical') { stat.merged += 1; summary.mergedIdentical += 1; }
    else { stat.already += 1; summary.alreadyBanked += 1; }
  }

  void before;

  const after = readBanks(BANK_DIR);
  const tagCounts = new Map();
  let totalEntries = 0;
  for (const entries of after.values()) {
    totalEntries += entries.length;
    for (const entry of entries) {
      for (const tag of (Array.isArray(entry.tags) ? entry.tags : [])) {
        const key = String(tag).trim().toLowerCase();
        if (!key) continue;
        tagCounts.set(key, (tagCounts.get(key) || 0) + 1);
      }
    }
  }

  summary.after = {
    banks: after.size,
    entries: totalEntries,
    clusters: tagCounts.size,
    seedTagged: (after.get(slug('Project Facts')) || []).length >= 0
      ? [...after.values()].reduce((n, entries) => n + entries.filter((e) => (e.tags || []).includes('backup-memory')).length, 0)
      : 0,
  };

  console.log(JSON.stringify(summary, null, 2));
}

main();
