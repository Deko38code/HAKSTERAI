const { getDb } = require('./db');

function saveSession(sessionId, userId, data) {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId);
  if (existing) {
    db.prepare(`UPDATE sessions SET user_id = ?, workspace = ?, metadata = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(userId || null, data.workspace || null, JSON.stringify(data.metadata || {}), sessionId);
  } else {
    db.prepare(`INSERT INTO sessions (id, user_id, workspace, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`)
      .run(sessionId, userId || null, data.workspace || null, JSON.stringify(data.metadata || {}));
  }
  return sessionId;
}

function loadSession(sessionId) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  if (!row) return null;
  if (row.metadata && typeof row.metadata === 'string') {
    try { row.metadata = JSON.parse(row.metadata); } catch (_) { row.metadata = {}; }
  }
  return row;
}

function listSessions(userId) {
  const db = getDb();
  if (userId) {
    return db.prepare('SELECT * FROM sessions WHERE user_id = ? ORDER BY updated_at DESC').all(userId);
  }
  return db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC').all();
}

function deleteSession(sessionId) {
  const db = getDb();
  return db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

function updateSessionTokenUsage(sessionId, inputTokens, outputTokens, cost) {
  const db = getDb();
  const existing = loadSession(sessionId);
  const meta = existing?.metadata || {};
  meta.inputTokens = (meta.inputTokens || 0) + (inputTokens || 0);
  meta.outputTokens = (meta.outputTokens || 0) + (outputTokens || 0);
  meta.cost = (meta.cost || 0) + (cost || 0);
  db.prepare(`UPDATE sessions SET metadata = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(JSON.stringify(meta), sessionId);
}

module.exports = { saveSession, loadSession, listSessions, deleteSession, updateSessionTokenUsage };