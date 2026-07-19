'use strict';
/**
 * haksterAi — Persistent Memory Module
 * Stores and retrieves facts, preferences, decisions, and context
 * so the agent can recall information across sessions.
 */

const { getDb } = require('./db');
const { v4: uuidv4 } = require('uuid');

const CATEGORIES = [
  'preference',   // User preferences (style, tools, formats)
  'fact',         // Facts about user, projects, or environment
  'decision',     // Past decisions and their reasoning
  'procedure',    // How-to steps, runbooks, sequences
  'context',      // Project context, tech stack, architecture
  'relationship', // People, machines, services, connections
  'general',      // Catch-all
];

const VALID_CATEGORIES = new Set(CATEGORIES);

/**
 * Save a new memory or update an existing one by key.
 * If a memory with the same key exists, it updates the value and bumps updated_at.
 */
function saveMemory({ category = 'general', key, value, source = 'agent', sessionId = null, confidence = 1.0, expiresAt = null }) {
  if (!key || typeof key !== 'string') throw new Error('key is required');
  if (!value || typeof value !== 'string') throw new Error('value is required');
  if (!VALID_CATEGORIES.has(category)) throw new Error(`Invalid category: ${category}. Valid: ${CATEGORIES.join(', ')}`);

  const db = getDb();
  const id = uuidv4();
  const now = Math.floor(Date.now() / 1000);

  // Check if memory with same key already exists — update it
  const existing = db.prepare('SELECT id FROM memories WHERE key = ?').get(key);
  if (existing) {
    db.prepare(
      `UPDATE memories SET value = ?, category = ?, source = ?, confidence = ?, updated_at = ?, session_id = COALESCE(?, session_id), expires_at = COALESCE(?, expires_at) WHERE key = ?`
    ).run(value, category, source, confidence, now, sessionId, expiresAt ? Math.floor(expiresAt / 1000) : null, key);
    return db.prepare('SELECT * FROM memories WHERE key = ?').get(key);
  }

  db.prepare(
    `INSERT INTO memories (id, category, key, value, source, session_id, confidence, access_count, created_at, updated_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
  ).run(id, category, key, value, source, sessionId, confidence, now, now, expiresAt ? Math.floor(expiresAt / 1000) : null);
  return db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
}

/**
 * Retrieve a specific memory by key.
 */
function getMemory(key) {
  const db = getDb();
  const mem = db.prepare('SELECT * FROM memories WHERE key = ?').get(key);
  if (mem) {
    db.prepare('UPDATE memories SET access_count = access_count + 1, updated_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000), mem.id);
  }
  return mem;
}

/**
 * Search memories by keyword match across key, value, and category.
 * Returns results sorted by relevance (confidence * recency * access frequency).
 */
function searchMemories(query, { limit = 20, category = null } = {}) {
  const db = getDb();
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return listMemories({ category, limit });

  // Build WHERE clause with LIKE for each term — OR logic (any term match is relevant)
  const whereParts = terms.map(() => `(lower(key) LIKE ? OR lower(value) LIKE ? OR lower(category) LIKE ?)`);
  const whereClause = whereParts.join(' OR ');
  const params = terms.flatMap(t => [`%${t}%`, `%${t}%`, `%${t}%`]);

  // Also search the full query as a phrase (boosts exact matches)
  whereParts.push(`(lower(key) LIKE ? OR lower(value) LIKE ?)`);
  params.push(`%${query.toLowerCase()}%`, `%${query.toLowerCase()}%`);
  const fullWhere = whereParts.join(' OR ');

  let sql = `SELECT *, (confidence * (1.0 + access_count * 0.1) * (1.0 / (1.0 + (unixepoch() - updated_at) / 86400.0))) as relevance
             FROM memories WHERE (${fullWhere})`;
  const allParams = [...params];

  if (category) {
    sql += ` AND category = ?`;
    allParams.push(category);
  }

  sql += ` ORDER BY relevance DESC, updated_at DESC LIMIT ?`;
  allParams.push(limit);

  return db.prepare(sql).all(...allParams);
}

/**
 * List all memories, optionally filtered by category.
 */
function listMemories({ category = null, limit = 100, offset = 0 } = {}) {
  const db = getDb();
  let sql = 'SELECT * FROM memories';
  const params = [];
  if (category) {
    sql += ' WHERE category = ?';
    params.push(category);
  }
  sql += ' ORDER BY updated_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  return db.prepare(sql).all(...params);
}

/**
 * Delete a memory by key or id.
 */
function deleteMemory(keyOrId) {
  const db = getDb();
  // Try by key first, then by id
  let result = db.prepare('DELETE FROM memories WHERE key = ?').run(keyOrId);
  if (result.changes === 0) {
    result = db.prepare('DELETE FROM memories WHERE id = ?').run(keyOrId);
  }
  return result.changes > 0;
}

/**
 * Get a formatted context block of relevant memories for injection into the agent system prompt.
 * Searches by the user's message content and returns a concise summary.
 */
function getMemoryContext(userMessage, { maxMemories = 15, maxChars = 3000 } = {}) {
  const db = getDb();

  // Always include high-confidence, recently accessed memories (core context)
  const coreMemories = db.prepare(
    `SELECT * FROM memories
     WHERE confidence >= 0.8
     ORDER BY confidence DESC, access_count DESC, updated_at DESC
     LIMIT 5`
  ).all();

  // Search for memories relevant to the user's message
  let relevantMemories = [];
  if (userMessage && userMessage.trim().length > 0) {
    const terms = userMessage.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 10);
    const likeParts = terms.map(() => `(lower(key) LIKE ? OR lower(value) LIKE ? OR lower(category) LIKE ?)`);
    const whereClause = likeParts.join(' OR ');
    const params = terms.flatMap(t => [`%${t}%`, `%${t}%`, `%${t}%`]);

    relevantMemories = db.prepare(
      `SELECT * FROM memories
       WHERE (${whereClause})
       ORDER BY confidence DESC, access_count DESC, updated_at DESC
       LIMIT ?`
    ).all(...params, maxMemories);
  }

  // Merge, dedupe by id
  const seen = new Set();
  const merged = [];
  for (const m of [...coreMemories, ...relevantMemories]) {
    if (!seen.has(m.id)) {
      seen.add(m.id);
      merged.push(m);
    }
  }

  // Bump access count for all retrieved memories
  const now = Math.floor(Date.now() / 1000);
  const bumpStmt = db.prepare('UPDATE memories SET access_count = access_count + 1, updated_at = ? WHERE id = ?');
  for (const m of merged) {
    bumpStmt.run(now, m.id);
  }

  if (merged.length === 0) return '';

  // Format as compact context block
  const lines = merged.map(m => {
    const age = now - m.updated_at;
    const ageStr = age < 60 ? 'just now' : age < 3600 ? `${Math.floor(age / 60)}m ago` : age < 86400 ? `${Math.floor(age / 3600)}h ago` : `${Math.floor(age / 86400)}d ago`;
    return `[${m.category}] ${m.key}: ${m.value} (${ageStr})`;
  });

  let context = '=== PERSISTENT MEMORY ===\nThe following are facts and preferences I should remember across all sessions:\n';
  context += lines.join('\n');
  context += '\n=== END PERSISTENT MEMORY ===';

  // Truncate if too long
  if (context.length > maxChars) {
    context = context.substring(0, maxChars) + '\n...(memory context trimmed)';
  }

  return context;
}

/**
 * Get memory stats.
 */
function getMemoryStats() {
  const db = getDb();
  const total = db.prepare('SELECT COUNT(*) as count FROM memories').get().count;
  const byCategory = db.prepare('SELECT category, COUNT(*) as count FROM memories GROUP BY category ORDER BY count DESC').all();
  const recentAccessed = db.prepare('SELECT * FROM memories ORDER BY updated_at DESC LIMIT 5').all();
  return { total, byCategory, recentAccessed };
}

/**
 * Autocompact: consolidate older, lower-priority memories into summary entries
 * to keep the active context window lean. Keeps recent + high-confidence items,
 * merges older ones into per-category summary memories.
 * Returns { compacted, kept, summaries }.
 */
function compactMemories({ maxKeep = 40, maxAgeDays = 14 } = {}) {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - (maxAgeDays * 86400);

  // Memories to keep: high confidence OR recently updated
  const keep = db.prepare(
    `SELECT * FROM memories
     WHERE confidence >= 0.85 OR updated_at >= ?
     ORDER BY updated_at DESC
     LIMIT ?`
  ).all(cutoff, maxKeep);

  const keepIds = new Set(keep.map(m => m.id));

  // Memories to compact: everything else
  const toCompact = db.prepare(
    `SELECT * FROM memories WHERE id NOT IN (${keepIds.size ? keep.map(() => '?').join(',') : 'NULL'})`
  ).all(...keepIds);

  if (toCompact.length === 0) {
    return { compacted: 0, kept: keep.length, summaries: [] };
  }

  // Group by category and build summary text
  const byCategory = {};
  for (const m of toCompact) {
    const cat = m.category || 'general';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(m);
  }

  const summaries = [];
  const now_iso = new Date().toISOString();
  const insertStmt = db.prepare(
    `INSERT INTO memories (id, category, key, value, source, session_id, confidence, access_count, created_at, updated_at, expires_at)
     VALUES (?, ?, ?, ?, 'autocompact', NULL, 0.9, 0, ?, ?, NULL)`
  );
  const deleteStmt = db.prepare('DELETE FROM memories WHERE id = ?');

  for (const [cat, mems] of Object.entries(byCategory)) {
    const summaryKey = `autocompact:${cat}:${now_iso}`;
    const lines = mems.map(m => `- [${m.key}] ${m.value.slice(0, 200)}`);
    const summaryValue = `Autocompacted ${mems.length} ${cat} memories:\n${lines.join('\n')}`;
    const id = uuidv4();
    insertStmt.run(id, cat, summaryKey, summaryValue, now, now);
    for (const m of mems) deleteStmt.run(m.id);
    summaries.push({ category: cat, count: mems.length, summaryId: id });
  }

  return { compacted: toCompact.length, kept: keep.length, summaries };
}

module.exports = {
  saveMemory,
  getMemory,
  searchMemories,
  listMemories,
  deleteMemory,
  getMemoryContext,
  getMemoryStats,
  compactMemories,
  CATEGORIES,
};