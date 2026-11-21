// haksterAi Session Persistence Module
// Stores conversation sessions in SQLite for resume/replay across restarts.
// Schema v1.

const path = require('path');
const Database = require('better-sqlite3');

let _db = null;

function getDb(dbPath) {
  if (_db && _db.path === dbPath) return _db;
  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('busy_timeout = 5000');
  _db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      provider TEXT,
      model TEXT,
      approval_mode TEXT DEFAULT 'suggest',
      cwd TEXT,
      title TEXT,
      messages TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
  `);
  return _db;
}

function _dbPath() {
  return path.join(getDbPath());
}

function getDbPath() {
  // Try env, then default location
  if (process.env.HAKSTER_SESSION_DB) return process.env.HAKSTER_SESSION_DB;
  const haksterRoot = process.env.HAKSTER_ROOT || path.join(process.env.HOME || '/home/ghost', 'haksterAi');
  return path.join(haksterRoot, 'data', 'sessions.db');
}

function saveSession(session) {
  const db = getDb(getDbPath());
  const now = Date.now();
  const stmt = db.prepare(`
    INSERT INTO sessions (id, created_at, updated_at, provider, model, approval_mode, cwd, title, messages)
    VALUES (@id, @created_at, @updated_at, @provider, @model, @approval_mode, @cwd, @title, @messages)
    ON CONFLICT(id) DO UPDATE SET
      updated_at = @updated_at,
      provider = @provider,
      model = @model,
      approval_mode = @approval_mode,
      cwd = @cwd,
      title = @title,
      messages = @messages
  `);
  stmt.run({
    id: session.id,
    created_at: session.created_at || now,
    updated_at: now,
    provider: session.provider || null,
    model: session.model || null,
    approval_mode: session.approval_mode || 'suggest',
    cwd: session.cwd || null,
    title: session.title || null,
    messages: JSON.stringify(session.messages || []),
  });
  return session.id;
}

function loadSession(id) {
  const db = getDb(getDbPath());
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  if (!row) return null;
  return {
    id: row.id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    provider: row.provider,
    model: row.model,
    approval_mode: row.approval_mode,
    cwd: row.cwd,
    title: row.title,
    messages: JSON.parse(row.messages || '[]'),
  };
}

function listSessions(limit = 20, offset = 0) {
  const db = getDb(getDbPath());
  const rows = db.prepare(
    'SELECT id, created_at, updated_at, provider, model, approval_mode, cwd, title FROM sessions ORDER BY updated_at DESC LIMIT ? OFFSET ?'
  ).all(limit, offset);
  return rows.map(r => ({
    id: r.id,
    created_at: r.created_at,
    updated_at: r.updated_at,
    provider: r.provider,
    model: r.model,
    approval_mode: r.approval_mode,
    cwd: r.cwd,
    title: r.title,
  }));
}

function deleteSession(id) {
  const db = getDb(getDbPath());
  const result = db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  return result.changes > 0;
}

function generateId() {
  const crypto = require('crypto');
  return 'sess_' + crypto.randomBytes(8).toString('hex') + '_' + Date.now();
}

module.exports = {
  saveSession,
  loadSession,
  listSessions,
  deleteSession,
  generateId,
  getDbPath,
};