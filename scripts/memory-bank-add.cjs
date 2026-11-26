#!/usr/bin/env node
'use strict';

/*
 * memory-bank-add.cjs
 *
 * Owner, 2026-11-26: "and always add memory to bank up top in tui to".
 *
 * The ◈ memory-bank bar at the top right of the TUI counts the files in
 * ~/.hakster/memories/banks/<slug>.json (cli/ui/src/hooks/useMemoryBank.js,
 * polling every 10 s). Only consolidation, the recap writer and direct bank
 * adds ever write there — a memory saved through POST /api/agent/memory lives
 * in data/hakster.db and does not move the bar until a consolidation run.
 *
 * This is the direct add: one observation into one bank, in exactly the entry
 * shape the banks use (id / timestamp / tags / observation / type / confidence
 * / bankedAt), deduped at the server's own 0.6 similarity threshold, capped at
 * the same BANK_CAP = 300, written atomically under a lock so a concurrent
 * server write is not clobbered.
 *
 * It prints counts only — never an observation's text (§9, §23).
 *
 *   node scripts/memory-bank-add.cjs --bank "User Preferences" \
 *        --text "one-line fact" [--type preference] [--tags a,b] [--id KEY]
 *   node scripts/memory-bank-add.cjs --list [--json]
 *
 * Exit 0 on write/no-op, 2 on usage error, 1 on failure.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const BANK_CAP = 300;                       // same cap as autolearn.js BANK_CAP
const SIMILARITY_THRESHOLD = 0.6;           // autolearn OBSERVATION_SIMILARITY_THRESHOLD
const LOCK_WAIT_MS = 3000;
const LOCK_STALE_MS = 15000;

// The eleven banks consolidation writes (autolearn.js MEMORY_SECTIONS).
const SECTIONS = [
  'Patterns',
  'Errors Encountered',
  'User Preferences',
  'Conventions',
  'Project Facts',
  'Tools & Commands',
  'Recon & Targets',
  'Vulnerabilities & Findings',
  'Infrastructure & Network',
  'Lessons & Anti-patterns',
  'Playbooks & Workflows',
];

// Same routing table consolidation uses: a type names the bank it belongs in.
const SECTION_BY_TYPE = {
  pattern: 'Patterns',
  error: 'Errors Encountered',
  preference: 'User Preferences',
  convention: 'Conventions',
  fact: 'Project Facts',
  tool: 'Tools & Commands',
  command: 'Tools & Commands',
  recon: 'Recon & Targets',
  target: 'Recon & Targets',
  vuln: 'Vulnerabilities & Findings',
  vulnerability: 'Vulnerabilities & Findings',
  finding: 'Vulnerabilities & Findings',
  infra: 'Infrastructure & Network',
  network: 'Infrastructure & Network',
  lesson: 'Lessons & Anti-patterns',
  antipattern: 'Lessons & Anti-patterns',
  playbook: 'Playbooks & Workflows',
  workflow: 'Playbooks & Workflows',
};

function haksterHome() {
  return process.env.HAKSTER_HOME || os.homedir();
}

function bankDir() {
  return path.join(haksterHome(), '.hakster', 'memories', 'banks');
}

function bankSlug(section) {
  return String(section).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function resolveSection(value) {
  if (!value) return null;
  const slug = bankSlug(value);
  return SECTIONS.find((s) => bankSlug(s) === slug) || null;
}

function substringSimilarity(a, b) {
  if (!a || !b) return 0;
  const sa = String(a).toLowerCase();
  const sb = String(b).toLowerCase();
  if (sa === sb) return 1;
  if (sa.includes(sb) || sb.includes(sa)) {
    const longer = sa.length > sb.length ? sa : sb;
    const shorter = sa.length > sb.length ? sb : sa;
    return shorter.length / longer.length;
  }
  const bigramsA = new Set();
  for (let i = 0; i < sa.length - 1; i++) bigramsA.add(sa.substring(i, i + 2));
  const bigramsB = new Set();
  for (let i = 0; i < sb.length - 1; i++) bigramsB.add(sb.substring(i, i + 2));
  let overlap = 0;
  for (const bg of bigramsA) if (bigramsB.has(bg)) overlap++;
  const total = bigramsA.size + bigramsB.size;
  return total === 0 ? 0 : (2 * overlap) / total;
}

function readBank(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return null; // missing or half-written: caller decides, never guessed at
  }
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// One writer at a time. The server writes these same files from consolidation,
// so a read-modify-write without a lock could drop an entry it just filed.
function withLock(file, fn) {
  const lock = `${file}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fd = fs.openSync(lock, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        const age = Date.now() - fs.statSync(lock).mtimeMs;
        if (age > LOCK_STALE_MS) { fs.unlinkSync(lock); continue; }
      } catch { /* lock vanished between open and stat — just retry */ }
      if (Date.now() > deadline) throw new Error(`bank is locked (${path.basename(lock)})`);
      sleepMs(50);
    }
  }
  try {
    return fn();
  } finally {
    try { fs.unlinkSync(lock); } catch { /* already gone */ }
  }
}

function writeAtomic(file, entries) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2), 'utf8');
  fs.renameSync(tmp, file); // atomic replace: the 10 s poll never reads half a bank
}

function usage(msg) {
  if (msg) process.stderr.write(`memory-bank-add: ${msg}\n`);
  process.stderr.write(
    'usage: memory-bank-add --bank "<section>" --text "<observation>" ' +
    '[--type <type>] [--tags a,b] [--id <key>]\n' +
    '       memory-bank-add --list [--json]\n' +
    `banks: ${SECTIONS.map(bankSlug).join(', ')}\n`
  );
  process.exit(2);
}

function parseArgs(argv) {
  const out = { tags: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) usage(`${a} needs a value`);
      return v;
    };
    if (a === '--bank' || a === '-b') out.bank = next();
    else if (a === '--text' || a === '-t') out.text = next();
    else if (a === '--type') out.type = next();
    else if (a === '--tags') out.tags = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--id') out.id = next();
    else if (a === '--confidence') out.confidence = Number(next());
    else if (a === '--list' || a === '-l') out.list = true;
    else if (a === '--json') out.json = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--help' || a === '-h') usage();
    else usage(`unknown argument ${a}`);
  }
  return out;
}

function listBanks(asJson) {
  const dir = bankDir();
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    files = [];
  }
  const rows = [];
  let total = 0;
  for (const file of files.sort()) {
    const entries = readBank(path.join(dir, file));
    const count = entries ? entries.length : 0;
    total += count;
    rows.push({ bank: file.replace(/\.json$/, ''), entries: count });
  }
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ dir, total, banks: rows }, null, 2)}\n`);
  } else {
    for (const r of rows) process.stdout.write(`${r.bank.padEnd(34)} ${String(r.entries).padStart(4)}\n`);
    process.stdout.write(`${'total'.padEnd(34)} ${String(total).padStart(4)}\n`);
  }
  return 0;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.list) return listBanks(args.json);

  if (!args.bank && !args.type) usage('--bank or --type is required');
  if (!args.text || !String(args.text).trim()) usage('--text is required');

  const section = args.bank ? resolveSection(args.bank) : SECTION_BY_TYPE[String(args.type).toLowerCase()];
  if (!section) usage(`unknown bank "${args.bank}"`);

  const observation = String(args.text).replace(/\s+/g, ' ').trim();
  const type = args.type && SECTION_BY_TYPE[String(args.type).toLowerCase()] === section
    ? String(args.type).toLowerCase()
    : section === 'Errors Encountered' ? 'error'
      : section === 'User Preferences' ? 'preference'
        : section === 'Conventions' ? 'convention'
          : section === 'Lessons & Anti-patterns' ? 'lesson'
            : section === 'Playbooks & Workflows' ? 'playbook'
              : 'fact';
  const tags = args.tags.slice();
  if (!tags.includes('memory-bank-add')) tags.push('memory-bank-add');

  const dir = bankDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${bankSlug(section)}.json`);

  const result = withLock(file, () => {
    const before = readBank(file);
    if (before === null) throw new Error(`cannot read ${path.basename(file)} — refusing to overwrite it`);
    const entries = before.slice();
    const now = new Date().toISOString();

    // Dedup exactly like the server: a near-identical entry is merged, not doubled.
    for (const existing of entries) {
      if (substringSimilarity(observation, existing.observation) > SIMILARITY_THRESHOLD) {
        existing.confidence = Math.max(existing.confidence || 0, args.confidence || 0.8);
        existing.tags = Array.isArray(existing.tags) ? existing.tags : [];
        for (const t of tags) if (!existing.tags.includes(t)) existing.tags.push(t);
        if (!args.dryRun) writeAtomic(file, entries);
        return { banked: false, entries: entries.length, was: before.length, dropped: 0 };
      }
    }

    entries.push({
      id: args.id || `mem_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
      timestamp: now,
      tags,
      observation,
      type,
      confidence: Number.isFinite(args.confidence) ? args.confidence : 0.85,
      bankedAt: now,
    });

    let dropped = 0;
    while (entries.length > BANK_CAP) { entries.shift(); dropped++; }
    if (!args.dryRun) writeAtomic(file, entries);
    return { banked: true, entries: entries.length, was: before.length, dropped };
  });

  if (args.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, section, slug: bankSlug(section), ...result, dryRun: !!args.dryRun }, null, 2)}\n`);
    return 0;
  }
  const verb = args.dryRun ? 'would bank' : result.banked ? 'banked' : 'merged (already present)';
  process.stdout.write(
    `${verb} · ${section} · ${result.entries} entries` +
    (result.banked ? ` (was ${result.was})` : '') +
    (result.dropped ? ` · ${result.dropped} oldest dropped at cap ${BANK_CAP}` : '') +
    '\n'
  );
  process.stdout.write('the ◈ header reads these files directly — it shows this within 10 s, no restart\n');
  return 0;
}

try {
  process.exitCode = main();
} catch (err) {
  process.stderr.write(`memory-bank-add: ${err.message}\n`);
  process.exitCode = 1;
}
