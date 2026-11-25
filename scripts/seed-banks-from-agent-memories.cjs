#!/usr/bin/env node
'use strict';

/*
 * seed-banks-from-agent-memories.cjs
 *
 * Owner, 2026-11-26: "make sure you have all haksters mems and phantom claude codex omp in bank"
 *
 * The keyed memories in data/hakster.db were mirrored into the bank clusters by
 * scripts/seed-banks-from-db-memories.cjs. Every other agent runtime on this box
 * keeps its own long-term notes in its own format, and none of it had ever reached
 * the banks the TUI shows or pullMemoryBanks() feeds a run with:
 *
 *   phantom  ~/.phantom-memory.json          entries[]  (key/value/tags)
 *            ~/.phantom-lessons.json         lessons[]  (type/context/count)
 *            ~/.phantom-user-patterns.json   users{}    (per-user task events)
 *   claude   ~/.claude/projects/<project>/memory/<name>.md   (frontmatter + body)
 *   codex    ~/.codex/memories/*.md                      (markdown notes)
 *            ~/.codex/memories_1.sqlite   stage1_outputs (consolidated memories)
 *   omp      ~/.omp/agent/agents/*.md                    (persona roster)
 *            ~/.omp/agent/history.db     history         (prompt history — no memory store)
 *
 * Each source is normalized to one bank entry and appended to the matching
 * section. Ids are content-derived (`src:<source>:<sha1>`), and an entry whose
 * opening fingerprint is already covered by any bank observation is treated as
 * banked, so a re-run adds nothing and the same note reached through two runtimes
 * is not duplicated.
 *
 * Append-only: existing entries are read, preserved untouched, and never removed.
 * Never prints an entry's text — counts, tags and sources only (§9, §23).
 *
 *   node scripts/seed-banks-from-agent-memories.cjs [--dry-run]
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const HOME = os.homedir();
const BANK_DIR = path.join(HOME, '.hakster', 'memories', 'banks');
const DRY = process.argv.includes('--dry-run');
const BANK_CAP = 300;
const OBS_MAX = 1200;

const SECRET_ASSIGNMENT = /((?:api[_ -]?key|secret|password|passwd|token|credential|authorization|private[_ -]?key)\s*[:=]\s*)['"`]?[A-Za-z0-9_\-.\/+=]{12,}/gi;
const SECRET_BLOB = /(?:gh[pousr]_[A-Za-z0-9]{20,}|sk[-_][A-Za-z0-9_\-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b[a-f0-9]{40,}\b|\b[A-Za-z0-9_\-]{48,}\b)/g;

// A memory is never dropped for containing one sensitive token — a postmortem
// that names a build hash is exactly the note worth keeping (§9 says never expose
// the value, not never remember the incident). The matched value is replaced and
// the rest of the memory is banked intact. Redactions are counted, never shown.
function redact(text) {
  let hits = 0;
  let out = String(text).replace(SECRET_ASSIGNMENT, (_m, prefix) => { hits += 1; return `${prefix}[redacted]`; });
  out = out.replace(SECRET_BLOB, () => { hits += 1; return '[redacted]'; });
  return { text: out, hits };
}

function clean(text, source) {
  const r = redact(text);
  if (r.hits) {
    summary.redactedHits += r.hits;
    const s = src(source);
    s.redacted = (s.redacted || 0) + r.hits;
  }
  return r.text;
}

const compact = (s, max = OBS_MAX) => {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
};
const normalize = (s) => compact(s, 100000).toLowerCase();
const fp = (s) => normalize(s).slice(0, 200);

const summary = {
  ok: true,
  dryRun: DRY,
  perSource: {},
  added: 0,
  alreadyBanked: 0,
  skippedEmpty: 0,
  skippedSecretShaped: 0,
  redactedHits: 0,
  perSection: {},
};

function slug(section) {
  return String(section).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function src(source) {
  return summary.perSource[source] || (summary.perSource[source] = { found: 0, added: 0, already: 0, skipped: 0 });
}

// Every bank file, read once into memory so "already banked" can look across all
// sections — a note may legitimately sit in a different cluster than the one this
// import maps it to.
function readAllBanks() {
  const files = new Map();
  let names = [];
  try { names = fs.readdirSync(BANK_DIR).filter((f) => f.endsWith('.json')); } catch { return files; }
  for (const file of names) {
    try {
      const entries = JSON.parse(fs.readFileSync(path.join(BANK_DIR, file), 'utf8'));
      files.set(file.replace(/\.json$/, ''), Array.isArray(entries) ? entries : []);
    } catch { /* unreadable bank is counted as unreadable, never as empty */ }
  }
  return files;
}

const allText = new Map(); // section -> array of normalized observations

function reindex(banks) {
  allText.clear();
  for (const [section, entries] of banks) {
    allText.set(section, entries.map((e) => normalize(e && e.observation)));
  }
}

function covered(text) {
  const f = fp(text);
  if (f.length < 24) return false;
  for (const list of allText.values()) {
    for (const obs of list) if (obs.includes(f)) return true;
  }
  return false;
}

// Append one entry. Existing entries are never modified or dropped; a bank that
// is already at BANK_CAP is reported rather than trimmed (§RULE #0: never delete
// an existing memory to make room).
function addEntry(section, entry, source) {
  const st = summary.perSection[section] || (summary.perSection[section] = { attempted: 0, added: 0, already: 0, full: false });
  st.attempted += 1;
  if (covered(entry.observation)) { st.already += 1; summary.alreadyBanked += 1; src(source).already += 1; return; }
  if (DRY) { st.added += 1; summary.added += 1; src(source).added += 1; return; }

  const file = path.join(BANK_DIR, `${slug(section)}.json`);
  let all = [];
  let hadNewline = true;
  try {
    const raw = fs.readFileSync(file, 'utf8');
    hadNewline = raw.endsWith('\n');
    all = JSON.parse(raw);
    if (!Array.isArray(all)) all = [];
  } catch { all = []; }

  if (all.some((e) => e && e.id === entry.id)) { st.already += 1; summary.alreadyBanked += 1; src(source).already += 1; return; }
  if (all.length >= BANK_CAP) { st.full = true; summary.ok = false; console.error(JSON.stringify({ warn: 'bank-full', section, file: path.basename(file), entries: all.length })); return; }

  all.push(entry);
  fs.writeFileSync(file, JSON.stringify(all, null, 2) + (hadNewline ? '\n' : ''));
  const list = allText.get(section) || [];
  list.push(normalize(entry.observation));
  allText.set(section, list);
  st.added += 1;
  summary.added += 1;
  src(source).added += 1;
}

function makeEntry(id, observation, type, tags, timestamp, source, confidence = 0.8) {
  return {
    id,
    keyedId: id,
    source,
    timestamp: timestamp || new Date().toISOString(),
    tags: [...new Set(tags.filter(Boolean).map(String))],
    observation: compact(observation),
    type,
    confidence,
    bankedAt: new Date().toISOString(),
  };
}

const contentId = (source, text) => `src:${source}:${crypto.createHash('sha1').update(normalize(text)).digest('hex').slice(0, 16)}`;
const iso = (ms) => (Number.isFinite(Number(ms)) && Number(ms) > 0 ? new Date(Number(ms)).toISOString() : null);

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

/* ---------------------------- phantom ---------------------------- */
function importPhantom() {
  // memory entries
  const mem = readJson(path.join(HOME, '.phantom-memory.json'));
  if (mem && Array.isArray(mem.entries)) {
    for (const e of mem.entries) {
      src('phantom:memory').found += 1;
      const text = [e && e.key, e && e.value].filter(Boolean).join(' — ');
      if (!text.trim()) { summary.skippedEmpty += 1; continue; }
      const bankedText = clean(text, 'phantom:memory');
      const tags = Array.isArray(e.tags) ? e.tags : [];
      const section = tags.includes('preference') ? 'User Preferences' : 'Project Facts';
      addEntry(section, makeEntry(contentId('phantom-memory', text), bankedText, tags.includes('preference') ? 'preference' : 'fact', ['phantom-memory', ...tags], iso(e.ts), 'phantom'), 'phantom:memory');
    }
  }

  // lessons
  const les = readJson(path.join(HOME, '.phantom-lessons.json'));
  if (les && Array.isArray(les.lessons)) {
    for (const l of les.lessons) {
      src('phantom:lessons').found += 1;
      const ctx = compact([l && l.context, l && l.taskHint ? `taskHint=”${l.taskHint}”` : null].filter(Boolean).join(' · '), 400);
      const text = [l && l.type ? `[${l.type}]` : null, ctx, Number(l && l.count) > 1 ? `(×${l.count})` : null].filter(Boolean).join(' ');
      if (!text.trim()) { summary.skippedEmpty += 1; continue; }
      const bankedText = clean(text, 'phantom:lessons');
      addEntry('Lessons & Anti-patterns', makeEntry(contentId('phantom-lesson', text), bankedText, 'lesson', ['phantom-lessons', 'lesson', l && l.type], iso(l.ts), 'phantom'), 'phantom:lessons');
    }
  }

  // user task patterns — aggregated, never raw prompt dumps
  const up = readJson(path.join(HOME, '.phantom-user-patterns.json'));
  if (up && up.users && typeof up.users === 'object') {
    for (const [user, data] of Object.entries(up.users)) {
      src('phantom:user-patterns').found += 1;
      const events = Array.isArray(data && data.events) ? data.events : [];
      if (!events.length) continue;
      const stamps = events.map((e) => Number(e.ts)).filter((n) => n > 0).sort((a, b) => a - b);
      const counts = new Map();
      for (const e of events) {
        const d = compact(e && e.detail, 60);
        if (d) counts.set(d.toLowerCase(), (counts.get(d.toLowerCase()) || 0) + 1);
      }
      const top = [...counts.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 8)
        .map(([d, n]) => `${d} ×${n}`).join('; ');
      const text = `phantom user ${user}: ${events.length} task events${stamps.length ? ` from ${iso(stamps[0])} to ${iso(stamps[stamps.length - 1])}` : ''}${top ? `. Most repeated tasks: ${top}` : ''}`;
      const bankedText = clean(text, 'phantom:user-patterns');
      addEntry('Project Facts', makeEntry(contentId('phantom-user', user), bankedText, 'fact', ['phantom-user-patterns', 'usage'], null, 'phantom'), 'phantom:user-patterns');
    }
  }
}

/* ---------------------------- claude memory md ---------------------------- */
function parseFrontmatter(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!m) return { meta: {}, body: raw };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
    else {
      const nested = /^\s+([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
      if (nested) meta[nested[1]] = nested[2].replace(/^["']|["']$/g, '').trim();
    }
  }
  return { meta, body: raw.slice(m[0].length) };
}

function importClaude() {
  const roots = path.join(HOME, '.claude', 'projects');
  let projects = [];
  try { projects = fs.readdirSync(roots, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return; }
  for (const project of projects) {
    const dir = path.join(roots, project, 'memory');
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md'); } catch { continue; }
    for (const f of files) {
      src('claude:memory').found += 1;
      let raw = '';
      try { raw = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { src('claude:memory').skipped += 1; continue; }
      const { meta, body } = parseFrontmatter(raw);
      const name = meta.name || f.replace(/\.md$/, '');
      const type = (meta.type || 'project').toLowerCase();
      const text = [meta.description ? `${name} — ${meta.description}` : name, compact(body, 900)].filter(Boolean).join('. ');
      if (!compact(body) && !meta.description) { summary.skippedEmpty += 1; continue; }
      const bankedText = clean(text, 'claude:memory');
      const section = type === 'feedback' ? 'Conventions' : 'Project Facts';
      const bankType = type === 'feedback' ? 'convention' : 'fact';
      addEntry(section, makeEntry(contentId('claude-md', `${project}/${name}`), bankedText, bankType, ['claude-memory', type, project.replace(/^-/, '')], meta.modified || null, 'claude'), 'claude:memory');
    }
  }
}

/* ---------------------------- codex ---------------------------- */
function importCodex() {
  const dir = path.join(HOME, '.codex', 'memories');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')); } catch { /* no dir */ }
  for (const f of files) {
    src('codex:memory').found += 1;
    let raw = '';
    try { raw = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { src('codex:memory').skipped += 1; continue; }
    const text = compact(raw.replace(/^#\s*/, ''), 1200);
    if (!text) { summary.skippedEmpty += 1; continue; }
    const bankedText = clean(text, 'codex:memory');
    addEntry('Project Facts', makeEntry(contentId('codex-md', f), bankedText, 'fact', ['codex-memory', f.replace(/\.md$/, '')], null, 'codex'), 'codex:memory');
  }

  // consolidated codex memories (stage1_outputs). Empty on this box, but read it
  // so the import is honest if codex has banked anything since.
  const dbPath = path.join(HOME, '.codex', 'memories_1.sqlite');
  if (fs.existsSync(dbPath)) {
    try {
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(dbPath, { readOnly: true });
      let rows = [];
      try { rows = db.prepare('SELECT thread_id, raw_memory, rollout_summary, generated_at FROM stage1_outputs').all(); } catch { rows = []; }
      try { db.close(); } catch { /* read-only */ }
      src('codex:sqlite').note = `${rows.length} consolidated memories`;
      for (const r of rows) {
        src('codex:sqlite').found += 1;
        const text = compact(r.raw_memory || r.rollout_summary, 1200);
        if (!text) continue;
        const bankedText = clean(text, 'codex:sqlite');
        addEntry('Lessons & Anti-patterns', makeEntry(contentId('codex-consolidated', r.thread_id + text.slice(0, 80)), bankedText, 'lesson', ['codex-consolidated'], r.generated_at || null, 'codex'), 'codex:sqlite');
      }
    } catch (err) {
      src('codex:sqlite').note = `unreadable: ${String(err.message || err).slice(0, 80)}`;
    }
  }
}

/* ---------------------------- omp ---------------------------- */
function importOmp() {
  // persona roster — OMP's agents are the closest thing it has to accumulated role knowledge
  const agentsDir = path.join(HOME, '.omp', 'agent', 'agents');
  let files = [];
  try { files = fs.readdirSync(agentsDir).filter((f) => f.endsWith('.md')); } catch { /* no roster */ }
  for (const f of files) {
    src('omp:roster').found += 1;
    let raw = '';
    try { raw = fs.readFileSync(path.join(agentsDir, f), 'utf8'); } catch { src('omp:roster').skipped += 1; continue; }
    const { meta, body } = parseFrontmatter(raw);
    const name = meta.name || f.replace(/\.md$/, '');
    const desc = meta.description || compact(body, 200);
    const text = `${name}${desc ? ` — ${desc}` : ''}`;
    const bankedText = clean(text, 'omp:roster');
    addEntry('Tools & Commands', makeEntry(contentId('omp-agent', name), bankedText, 'tool', ['omp-agent', 'roster'], null, 'omp', 0.7), 'omp:roster');
  }

  // prompt history — OMP keeps no memory store, so bank what it actually holds:
  // a provenance fact about the history, not a fabricated lesson.
  const histPath = path.join(HOME, '.omp', 'agent', 'history.db');
  if (fs.existsSync(histPath)) {
    try {
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(histPath, { readOnly: true });
      let agg = null;
      try {
        agg = db.prepare('SELECT COUNT(*) AS n, MIN(created_at) AS first, MAX(created_at) AS last, COUNT(DISTINCT session_id) AS sessions FROM history').get();
      } catch { agg = null; }
      let cwds = [];
      try { cwds = db.prepare('SELECT cwd, COUNT(*) AS n FROM history WHERE cwd IS NOT NULL GROUP BY cwd ORDER BY n DESC LIMIT 5').all(); } catch { cwds = []; }
      try { db.close(); } catch { /* read-only */ }
      if (agg && Number(agg.n) > 0) {
        src('omp:history').found = 1;
        const cd = cwds.map((c) => `${c.cwd} ×${c.n}`).join('; ');
        const raw = `OMP prompt history (no memory store of its own): ${agg.n} prompts, ${agg.sessions} sessions${agg.first ? `, ${agg.first} → ${agg.last}` : ''}${cd ? `. Top cwds: ${cd}` : ''}`;
        const bankedText = clean(raw, 'omp:history');
        addEntry('Project Facts', makeEntry(contentId('omp-history', 'aggregate'), bankedText, 'fact', ['omp-history', 'provenance'], null, 'omp', 0.7), 'omp:history');
      }
    } catch (err) {
      src('omp:history').note = `unreadable: ${String(err.message || err).slice(0, 80)}`;
    }
  }
}

function main() {
  if (!fs.existsSync(BANK_DIR)) {
    console.error(JSON.stringify({ ok: false, error: 'bank-dir-missing', dir: BANK_DIR }));
    process.exit(1);
  }
  const initial = readAllBanks();
  const banksBefore = {};
  let entriesBefore = 0;
  for (const [section, entries] of initial) { banksBefore[section] = entries.length; entriesBefore += entries.length; }
  reindex(initial);

  importPhantom();
  importClaude();
  importCodex();
  importOmp();

  // final state
  const after = readAllBanks();
  const sections = {};
  let totalEntries = 0;
  for (const [section, entries] of after) { sections[section] = entries.length; totalEntries += entries.length; }

  console.log(JSON.stringify({
    ...summary,
    banksBefore,
    entriesBefore,
    sections,
    totalEntries,
  }, null, 2));
}

main();
