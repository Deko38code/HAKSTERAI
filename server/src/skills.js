'use strict';
/**
 * haksterAi — Skills Module
 * Discovers, indexes, and serves the agent's skill library.
 * Skills live as markdown files under:
 *   - <repo>/.hakster/skills/
 *   - <repo>/pentest-agents/skills/
 * The agent always pulls from ALL available skills — never a capped subset.
 * A file watcher fires an 'update' event so the UI can auto-notify on new skills.
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const SKILL_ROOTS = [
  path.resolve(process.cwd(), '.hakster/skills'),
  path.resolve(process.cwd(), 'pentest-agents/skills'),
  path.resolve(process.cwd(), '.hakster'),
  path.resolve(process.cwd(), 'pentest-agents'),
];

const events = new EventEmitter();
let cache = [];          // [{ id, name, relPath, absPath, category, size, mtime }]
let watcher = null;
let lastCount = 0;

function walkSkills(rootDir, base = rootDir, out = []) {
  let entries;
  try { entries = fs.readdirSync(rootDir, { withFileTypes: true }); }
  catch { return out; }
  for (const ent of entries) {
    // Skip noise dirs
    if (ent.isDirectory() && ['node_modules', '.git', '.cache', 'dist', 'build'].includes(ent.name)) continue;
    const full = path.join(rootDir, ent.name);
    if (ent.isDirectory()) {
      walkSkills(full, base, out);
    } else if (ent.isFile() && /\.(md|markdown|txt)$/i.test(ent.name)) {
      const rel = path.relative(base, full);
      const stat = fs.statSync(full);
      const category = path.relative(base, path.dirname(full)).split(path.sep)[0] || 'general';
      out.push({
        id: rel.replace(/\\/g, '/'),
        name: ent.name.replace(/\.(md|markdown|txt)$/i, ''),
        relPath: rel.replace(/\\/g, '/'),
        absPath: full,
        category,
        size: stat.size,
        mtime: stat.mtimeMs,
      });
    }
  }
  return out;
}

function refreshCache() {
  const all = [];
  for (const root of SKILL_ROOTS) {
    walkSkills(root, root, all);
  }
  // Dedupe by absPath
  const seen = new Set();
  cache = all.filter(s => {
    if (seen.has(s.absPath)) return false;
    seen.add(s.absPath);
    return true;
  });
  if (cache.length !== lastCount) {
    const delta = cache.length - lastCount;
    lastCount = cache.length;
    if (delta !== 0) events.emit('update', { count: cache.length, delta });
  }
  return cache;
}

function listSkills({ category = null, limit = 1000, offset = 0, query = null, search = null } = {}) {
  let items = cache;
  const searchTerm = query || search;
  if (category) items = items.filter(s => s.category === category);
  if (searchTerm) {
    const q = searchTerm.toLowerCase();
    items = items.filter(s =>
      s.name.toLowerCase().includes(q) ||
      s.relPath.toLowerCase().includes(q) ||
      s.category.toLowerCase().includes(q)
    );
  }
  return items.slice(offset, offset + limit);
}

function readSkill(skillId) {
  const item = cache.find(s => s.id === skillId || s.relPath === skillId || s.name === skillId);
  if (!item) return null;
  const content = fs.readFileSync(item.absPath, 'utf8');
  return { ...item, content };
}

function getSkillStats() {
  refreshCache();
  const byCategory = {};
  for (const s of cache) {
    byCategory[s.category] = (byCategory[s.category] || 0) + 1;
  }
  return { total: cache.length, byCategory, roots: SKILL_ROOTS };
}

function startWatcher() {
  if (watcher) return;
  // Watch each skill root individually instead of a recursive watch on CWD.
  // A recursive fs.watch('.') on a large home directory exhausts the inotify
  // watcher limit (ENOSPC) and spams the error log. Skill roots are small and bounded.
  const watchers = [];
  for (const root of SKILL_ROOTS) {
    try {
      if (!fs.existsSync(root)) continue;
      const w = fs.watch(root, { recursive: true }, (eventType, filename) => {
        if (!filename) return;
        if (!/\.(md|markdown|txt)$/i.test(filename)) return;
        if (/node_modules|\.git\/|\.cache|dist\/|build\//.test(filename)) return;
        scheduleRefresh();
      });
      watchers.push(w);
    } catch (_) { /* root not watchable — skip */ }
  }
  watcher = watchers;

  // Fallback: if no root was watchable, poll instead.
  if (watchers.length === 0) {
    setInterval(() => refreshCache(), 30000);
  }

  function scheduleRefresh() {
    clearTimeout((watcher && watcher._t) || null);
    if (watcher) watcher._t = setTimeout(() => {
      const before = cache.length;
      refreshCache();
      const after = cache.length;
      events.emit('update', { count: after, delta: after - before });
    }, 400);
  }
  refreshCache();
}

// Initialize on require
refreshCache();
startWatcher();

module.exports = {
  listSkills,
  readSkill,
  getSkillStats,
  refreshCache,
  events,
  SKILL_ROOTS,
};