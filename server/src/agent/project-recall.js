/**
 * project-recall.js — the memory bank's view of PAST PROJECTS.
 *
 * Owner, 2026-11-26: "and build where are agent uses are memory bank to recall
 * past projects".
 *
 * The system prompt already carries a structural project map (`_buildProjectTOC`
 * — paths, ports, section ranges). What it never carried was the *memory*: what
 * earlier runs learned about each project, and which mistakes were already paid
 * for there. This module closes that gap.
 *
 * It is read-only over the bank. Three sources are merged into one index:
 *
 *   1. disk      — top-level dirs with a package.json: name, description, stack,
 *                  the PM2 name from ecosystem.config.js, PORT, and the last
 *                  commit (bounded `git -C` call; skipped when there is no .git).
 *   2. the bank  — `Errors Encountered`, `Lessons & Anti-patterns`, `Project
 *                  Facts`, `Patterns`; each entry is attributed to a project by
 *                  its name/aliases, and counted — never estimated.
 *   3. skills    — `~/.hakster/skills/index.json` rows whose text names a project.
 *
 * `recallProjects(task, opts)` scores those projects against the task text and
 * `projectPromptBlock(task, opts)` renders the ones that actually matched, with
 * their measured counts. A task that names no project yields '' — the block is
 * never decoration and never invents a figure (§10, §13).
 *
 * The index is cached on disk (`~/.hakster/memories/projects-index.json`) with a
 * TTL so a hot loop does not rescan the home directory on every turn.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const HOME = process.env.HOME || os.homedir() || '/home/ghost';
const HAKSTER_DIR = path.join(HOME, '.hakster');
const INDEX_FILE = path.join(HAKSTER_DIR, 'memories', 'projects-index.json');
const SKILLS_INDEX = path.join(HAKSTER_DIR, 'skills', 'index.json');

const INDEX_TTL_MS = 10 * 60 * 1000;   // rescan at most every 10 minutes
const MAX_PROJECTS = 3;                // how many matched projects the block shows
const MAX_BLOCK_CHARS = 2200;

/* Words that mean "this project" in a task, per project. Kept short on purpose:
 * a project is matched by name, its directory, or an alias — never by a fuzzy
 * guess from unrelated prose. */
const EXTRA_ALIASES = {
  'cine-vault-live': ['cinevault', 'cine-vault', 'cine vault', 'flixchill'],
  haksterai: ['hakster', 'hakster-ai', 'hakster ai'],
  hakster: ['haksterai', 'hakster-ai'],
  'phantom-ide': ['phantomide', 'phantom ide'],
  junkalot: ['junkalot.co', 'junk alot'],
  'rent-my-trailer': ['rentmytrailer', 'rent my trailer', 'rmt'],
};

/* ── small helpers ───────────────────────────────────────────────────────── */

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2);
}

function safeRead(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function safeJson(file, fallback) {
  try { return JSON.parse(safeRead(file)); } catch { return fallback; }
}

function oneLine(s, max) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/* ── disk scan ───────────────────────────────────────────────────────────── */

function lastCommit(dir) {
  if (!fs.existsSync(path.join(dir, '.git'))) return null;
  try {
    const out = execFileSync('git', ['-C', dir, 'log', '-1', '--format=%cI|%s'], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!out) return null;
    const [when, ...rest] = out.split('|');
    return { at: when, subject: rest.join('|') };
  } catch { return null; }
}

function pm2Name(dir) {
  const eco = safeRead(path.join(dir, 'ecosystem.config.js'));
  if (eco) {
    const m = eco.match(/name\s*:\s*['"]([^'"]+)['"]/);
    if (m) return m[1];
  }
  return null;
}

function portOf(dir, pkg) {
  if (pkg && (pkg.port || (pkg.config && pkg.config.port))) return Number(pkg.port || pkg.config.port) || null;
  // Only the PORT line is read — no other .env value is ever touched (§9, §23).
  const env = safeRead(path.join(dir, '.env'));
  const m = env.match(/^\s*PORT\s*=\s*(\d{2,5})\s*$/m);
  return m ? Number(m[1]) : null;
}

function scanDisk() {
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(HOME, { withFileTypes: true });
  } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
    const dir = path.join(HOME, e.name);
    const pkgPath = path.join(dir, 'package.json');
    if (!fs.existsSync(pkgPath)) continue;
    const pkg = safeJson(pkgPath, {});
    const name = pkg.name || e.name;
    const aliases = new Set([name.toLowerCase(), e.name.toLowerCase(), ...(EXTRA_ALIASES[e.name] || []), ...(EXTRA_ALIASES[name] || [])]);
    out.push({
      key: e.name,
      name,
      dir,
      description: oneLine(pkg.description || '', 120),
      stack: oneLine(pkg.tech || [pkg.name, pkg.version].filter(Boolean).join(' '), 60),
      pm2: pm2Name(dir),
      port: portOf(dir, pkg),
      lastCommit: lastCommit(dir),
      aliases: [...aliases].filter(Boolean),
    });
  }
  return out;
}

/* ── memory-declared projects ────────────────────────────────────────────── */

/**
 * Projects the memory itself declares, even when their directory is not on this
 * box. Two honest sources, no inference:
 *
 *   - `data/projects.json` — the owner's own registry (data, not code).
 *   - `.hakster/MEMORY.md` — a `### Name` heading immediately followed by
 *     `- **Location**: `<path>``.
 */
function declaredFromRegistry() {
  // The registry ships with the code (tracked source, §41 — both boxes carry it).
  // A box may add its own `data/projects.json` (gitignored, local-only) and it is
  // merged on top, so a machine can teach the agent a project without a commit.
  const files = [path.join(__dirname, 'project-registry.json'), path.join(__dirname, '..', '..', '..', 'data', 'projects.json')];
  const rows = [];
  for (const file of files) {
    const raw = safeJson(file, null);
    const list = raw && Array.isArray(raw.projects) ? raw.projects : [];
    for (const r of list) {
      if (!r || !r.name || !r.dir) continue;
      const key = path.basename(String(r.dir)) || String(r.name);
      if (rows.some((x) => path.basename(String(x.dir)) === key)) continue;
      rows.push(r);
    }
  }
  return rows
    .filter((r) => r && r.name && r.dir)
    .map((r) => ({
      key: path.basename(String(r.dir)) || String(r.name),
      name: String(r.name),
      dir: String(r.dir),
      host: r.host || null,
      description: oneLine(r.description || '', 120),
      stack: oneLine(r.stack || '', 60),
      pm2: r.pm2 || null,
      port: Number(r.port) || null,
      lastCommit: null,
      aliases: [...new Set([
        String(r.name).toLowerCase(),
        path.basename(String(r.dir)).toLowerCase(),
        ...(Array.isArray(r.aliases) ? r.aliases.map((a) => String(a).toLowerCase()) : []),
        ...(EXTRA_ALIASES[path.basename(String(r.dir))] || []),
      ].filter(Boolean))],
      declared: true,
    }));
}

function declaredFromMemoryMd() {
  const files = [
    path.join(process.cwd(), '.hakster', 'MEMORY.md'),
    path.join(HAKSTER_DIR, 'MEMORY.md'),
    path.join(HOME, 'haksterAi', '.hakster', 'MEMORY.md'),
  ];
  const seen = new Set();
  const out = [];
  for (const file of files) {
    let text = '';
    try {
      const real = fs.realpathSync(file);
      if (seen.has(real)) continue;
      seen.add(real);
      text = safeRead(file);
    } catch { continue; }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const h = lines[i].match(/^###\s+(.+?)\s*$/);
      if (!h) continue;
      // Look for the Location line within the next few lines, before another heading.
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        if (/^#{2,4}\s/.test(lines[j])) break;
        const loc = lines[j].match(/-\s*\*\*Location\*\*:\s*`([^`]+)`/);
        if (!loc) continue;
        const name = h[1].replace(/\[[^\]]*\]\s*/g, '').trim();
        const dir = loc[1].trim();
        const key = path.basename(dir) || name;
        if (out.some((p) => p.dir === dir || p.key === key)) break;
        out.push({
          key,
          name: name.replace(/\s*\(.*?\)\s*$/, '') || key,
          dir,
          host: null,
          description: '',
          stack: '',
          pm2: null,
          port: null,
          lastCommit: null,
          aliases: [...new Set([name.toLowerCase(), key.toLowerCase(), ...(EXTRA_ALIASES[key] || []), ...(EXTRA_ALIASES[name.toLowerCase()] || [])])],
          declared: true,
        });
        break;
      }
    }
  }
  return out;
}

function declaredProjects() {
  const out = declaredFromRegistry();
  for (const d of declaredFromMemoryMd()) {
    if (out.some((p) => p.dir === d.dir || p.key === d.key)) continue;
    out.push(d);
  }
  for (const p of out) p.present = fs.existsSync(p.dir);
  return out;
}

/* ── bank attribution ────────────────────────────────────────────────────── */

function aliasRegex(a) {
  return new RegExp(`(^|[^a-z0-9])${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`);
}

/**
 * Attribute one bank entry to at most one project, and say how sure that is.
 *
 * Strong: the entry's own tags name the project, or the text carries the
 * project's full directory. Medium: the alias appears in the first ~160 chars
 * (a title, not a passing mention). Weak: the alias appears later on.
 *
 * A weak hit still counts — the project is genuinely named — but only strong
 * and medium quotes are shown, so the block does not present an entry about
 * something else as if it were this project's own lesson.
 */
function projectForTextDetailed(projects, text, tags) {
  const t = String(text || '').toLowerCase();
  if (!t) return null;
  const tagList = (Array.isArray(tags) ? tags : []).map((x) => String(x).toLowerCase());
  let best = null;
  let bestLen = 0;
  for (const p of projects) {
    for (const a of p.aliases) {
      if (a.length < 3) continue;
      if (!aliasRegex(a).test(t)) continue;
      let strength = 'weak';
      if (tagList.some((tg) => tg === a || tg.includes(a))) strength = 'strong';
      else if (p.dir && t.includes(String(p.dir).toLowerCase())) strength = 'strong';
      else if (t.slice(0, 160).includes(a)) strength = 'medium';
      const rank = strength === 'strong' ? 3 : strength === 'medium' ? 2 : 1;
      const score = rank * 100 + a.length;
      if (score > bestLen) { best = { project: p, strength }; bestLen = score; }
    }
  }
  return best;
}

function projectForText(projects, text, tags) {
  const hit = projectForTextDetailed(projects, text, tags);
  return hit ? hit.project : null;
}

function attachMemory(projects, banks) {
  for (const p of projects) {
    p.memory = { facts: 0, lessons: 0, mistakes: 0, patterns: 0, conventions: 0, samples: [], mistakesList: [] };
  }
  // Quotes are collected with their strength, then only the sure ones are shown.
  const quotes = new Map();
  const addQuote = (p, kind, obs, strength) => {
    if (!quotes.has(p.key)) quotes.set(p.key, []);
    quotes.get(p.key).push({ kind, obs: oneLine(obs, 150), rank: strength === 'strong' ? 3 : strength === 'medium' ? 2 : 1 });
  };

  for (const { section, entries } of banks) {
    for (const e of entries || []) {
      const obs = String(e.observation || '');
      if (!obs) continue;
      const hit = projectForTextDetailed(projects, obs, e.tags);
      if (!hit) continue;
      const p = hit.project;
      const type = String(e.type || '');
      if (section === 'Errors Encountered' || type === 'error') {
        p.memory.mistakes += 1;
        addQuote(p, 'mistake', obs, hit.strength);
      } else if (section === 'Lessons & Anti-patterns' || type === 'lesson' || type === 'anti-pattern') {
        p.memory.lessons += 1;
      } else if (section === 'Project Facts' || type === 'fact') {
        p.memory.facts += 1;
        addQuote(p, 'fact', obs, hit.strength);
      } else if (section === 'Conventions' || type === 'convention') {
        p.memory.conventions += 1;
      } else if (section === 'Patterns' || type === 'pattern') {
        p.memory.patterns += 1;
      }
    }
  }

  for (const p of projects) {
    const all = (quotes.get(p.key) || []).sort((a, b) => b.rank - a.rank);
    const shown = all.filter((q) => q.rank >= 2);
    const pick = (shown.length ? shown : all);
    p.memory.samples = pick.filter((q) => q.kind === 'fact').slice(0, 3).map((q) => q.obs);
    p.memory.mistakesList = pick.filter((q) => q.kind === 'mistake').slice(0, 2).map((q) => q.obs);
  }
  return projects;
}

function attachSkills(projects) {
  const idx = safeJson(SKILLS_INDEX, { skills: [] });
  const rows = Array.isArray(idx) ? idx : (idx.skills || []);
  for (const p of projects) p.skills = 0;
  for (const row of rows) {
    const text = `${row.name || ''} ${row.description || ''}`;
    const p = projectForText(projects, text);
    if (p) p.skills += 1;
  }
  return projects;
}

/* ── index build + cache ─────────────────────────────────────────────────── */

let _cache = null;

function readBanksForRecall() {
  // Required lazily so this module never creates a cycle at require time.
  let autolearn;
  try { autolearn = require('./autolearn'); } catch { return []; }
  const sections = ['Errors Encountered', 'Lessons & Anti-patterns', 'Project Facts', 'Patterns', 'Conventions'];
  const out = [];
  for (const section of sections) {
    try { out.push({ section, entries: autolearn.readBank(null, section) || [] }); }
    catch { out.push({ section, entries: [] }); }
  }
  return out;
}

/** Disk projects first; memory-declared ones fill in what is not on this box. */
function mergeDeclared(disk) {
  const declared = declaredProjects();
  const out = [...disk];
  for (const d of declared) {
    const clash = out.find((p) => p.dir === d.dir || p.key === d.key || p.name.toLowerCase() === d.name.toLowerCase());
    if (clash) {
      // Keep the disk row (it has the real pm2/port/commit) but take the memory
      // name it declares, and inherit aliases so both spellings match.
      clash.aliases = [...new Set([...(clash.aliases || []), ...d.aliases])];
      continue;
    }
    out.push(d);
  }
  return out;
}

/**
 * Build (or load from cache) the project index.
 * @param {{ force?: boolean, ttlMs?: number }} [opts]
 */
function buildProjectIndex(opts = {}) {
  const ttl = Number.isFinite(opts.ttlMs) ? opts.ttlMs : INDEX_TTL_MS;
  const now = Date.now();

  if (!opts.force) {
    if (_cache && now - _cache.builtAt < ttl) return _cache;
    const disk = safeJson(INDEX_FILE, null);
    if (disk && Array.isArray(disk.projects) && now - Number(disk.builtAt || 0) < ttl) {
      _cache = disk;
      return _cache;
    }
  }

  const projects = attachSkills(attachMemory(mergeDeclared(scanDisk()), readBanksForRecall()));
  const index = { builtAt: now, projects };
  _cache = index;
  try {
    fs.mkdirSync(path.dirname(INDEX_FILE), { recursive: true });
    fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2));
  } catch { /* a cache write is best-effort; the in-memory copy is authoritative */ }
  return index;
}

/* ── scoring ─────────────────────────────────────────────────────────────── */

/**
 * Score one project against the task's terms. Name/alias matches are worth the
 * most (a task that says "cinevault" is about CineVault), the directory next,
 * and description words least. Pure function so a probe can pin it.
 */
function _scoreProject(project, terms) {
  if (!terms || !terms.length) return 0;
  const nameWords = new Set(tokenize(project.name));
  const aliasWords = new Set((project.aliases || []).flatMap(tokenize));
  const dirWords = new Set(tokenize(project.key));
  const descWords = new Set(tokenize(project.description));
  let score = 0;
  for (const t of terms) {
    if (nameWords.has(t)) score += 3;
    else if (aliasWords.has(t)) score += 3;
    else if (dirWords.has(t)) score += 2;
    else if (descWords.has(t)) score += 1;
  }
  return score;
}

/**
 * Projects that this task is about, strongest first.
 * @returns {Array<object>} the index rows, each with a `match` field.
 */
function recallProjects(task, opts = {}) {
  const terms = [...new Set(tokenize(task))];
  if (!terms.length) return [];
  const limit = Math.max(1, opts.limit || MAX_PROJECTS);
  const minScore = Number.isFinite(opts.minScore) ? opts.minScore : 2;
  const index = opts.index || buildProjectIndex(opts);
  const scored = [];
  for (const p of index.projects || []) {
    const match = _scoreProject(p, terms);
    if (match >= minScore) scored.push({ ...p, match });
  }
  scored.sort((a, b) => b.match - a.match);
  return scored.slice(0, limit);
}

/* ── prompt block ────────────────────────────────────────────────────────── */

function memoryLine(p) {
  const m = p.memory || {};
  const bits = [];
  if (m.facts) bits.push(`${m.facts} fact${m.facts === 1 ? '' : 's'}`);
  if (m.lessons) bits.push(`${m.lessons} lesson${m.lessons === 1 ? '' : 's'}`);
  if (m.mistakes) bits.push(`${m.mistakes} mistake${m.mistakes === 1 ? '' : 's'}`);
  if (m.patterns) bits.push(`${m.patterns} pattern${m.patterns === 1 ? '' : 's'}`);
  if (m.conventions) bits.push(`${m.conventions} convention${m.conventions === 1 ? '' : 's'}`);
  if (p.skills) bits.push(`${p.skills} skill${p.skills === 1 ? '' : 's'}`);
  return bits.join(' · ');
}

function renderProject(p) {
  const present = p.present !== false && fs.existsSync(p.dir);
  const where = [p.dir];
  if (p.pm2) where.push(`pm2 \`${p.pm2}\``);
  if (p.port) where.push(`:${p.port}`);
  const lines = [`### ${p.name} — ${where.join(' · ')}`];
  if (!present) {
    lines.push(`  on the ${p.host || 'other'} box, not this machine — work there stays there (§16), do not copy it here.`);
  }
  if (p.description) lines.push(`  ${p.description}`);
  if (p.lastCommit && p.lastCommit.at) {
    lines.push(`  last commit ${String(p.lastCommit.at).slice(0, 10)}: ${oneLine(p.lastCommit.subject, 90)}`);
  }
  const mem = memoryLine(p);
  if (mem) lines.push(`  memory bank: ${mem}`);
  for (const s of (p.memory && p.memory.samples) || []) lines.push(`  · ${s}`);
  for (const s of (p.memory && p.memory.mistakesList) || []) lines.push(`  ✗ already paid for: ${s}`);
  if (present) {
    lines.push(`  → open ${path.join(p.dir, '.hakster', 'MEMORY.md')} (if present) before editing — it is what we learned there.`);
  }
  return lines.join('\n');
}

/**
 * The `PAST PROJECTS` block for a run's system prompt, or '' when the task
 * names no project we hold memory for. Counts come from the bank; nothing is
 * estimated, and a project with no memory rows is not presented as if it had.
 *
 * @param {string} task  the operator's message for this run
 * @param {{ limit?: number, index?: object, force?: boolean }} [opts]
 * @returns {{ text: string, count: number, projects: string[] }}
 */
function projectPromptBlock(task, opts = {}) {
  let matched = [];
  try { matched = recallProjects(task, opts); } catch { return { text: '', count: 0, projects: [] }; }
  if (!matched.length) return { text: '', count: 0, projects: [] };

  const body = matched.map(renderProject).join('\n\n');
  const text = [
    '=== PAST PROJECTS (recalled from the memory bank for this task) ===',
    body,
    'These are projects already on this machine and what earlier runs learned there.',
    'Build on that knowledge instead of rediscovering it; do not repeat a ✗ mistake already recorded.',
    '=== END PAST PROJECTS ===',
  ].join('\n');

  const capped = text.length > MAX_BLOCK_CHARS
    ? text.slice(0, MAX_BLOCK_CHARS) + '\n… (truncated — recall one project with the memory tool)'
    : text;

  return { text: capped, count: matched.length, projects: matched.map((p) => p.name) };
}

module.exports = {
  buildProjectIndex,
  recallProjects,
  projectPromptBlock,
  // exposed for probes
  _scoreProject,
  _projectForText: projectForText,
  _INDEX_FILE: INDEX_FILE,
};
