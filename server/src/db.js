'use strict';
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DB_PATH = path.join(__dirname, '../../data/hakster.db');

// Ensure data dir exists
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema(db);
  }
  return db;
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id          TEXT PRIMARY KEY,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at  INTEGER NOT NULL DEFAULT (unixepoch()),
      title       TEXT,
      provider    TEXT NOT NULL,
      model       TEXT NOT NULL,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      total_cost  REAL NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS messages (
      id            TEXT PRIMARY KEY,
      session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role          TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
      content       TEXT NOT NULL,
      created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
      input_tokens  INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      latency_ms    INTEGER NOT NULL DEFAULT 0,
      provider      TEXT,
      model         TEXT
    );

    CREATE TABLE IF NOT EXISTS requests (
      id            TEXT PRIMARY KEY,
      session_id    TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      type          TEXT NOT NULL,
      provider      TEXT NOT NULL,
      model         TEXT NOT NULL,
      input_tokens  INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      latency_ms    INTEGER NOT NULL DEFAULT 0,
      cost          REAL NOT NULL DEFAULT 0,
      status        TEXT NOT NULL DEFAULT 'ok',
      error         TEXT,
      created_at    INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
    CREATE INDEX IF NOT EXISTS idx_requests_created ON requests(created_at);
    CREATE INDEX IF NOT EXISTS idx_requests_provider ON requests(provider);

    CREATE TABLE IF NOT EXISTS artifacts (
      id          TEXT PRIMARY KEY,
      session_id  TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
      title       TEXT NOT NULL,
      description TEXT,
      provider    TEXT NOT NULL,
      model       TEXT NOT NULL,
      files       TEXT NOT NULL DEFAULT '[]',
      main_file   TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_artifacts_session ON artifacts(session_id);
    CREATE INDEX IF NOT EXISTS idx_artifacts_created ON artifacts(created_at);

    -- Users table with API keys and billing
    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      username      TEXT UNIQUE NOT NULL,
      email         TEXT,
      api_key       TEXT UNIQUE NOT NULL,
      role          TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin','user','guest')),
      plan          TEXT NOT NULL DEFAULT 'free' CHECK(plan IN ('free','pro','enterprise')),
      status        TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended','banned')),
      password_hash TEXT,
      created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at    INTEGER NOT NULL DEFAULT (unixepoch()),
      last_login_at INTEGER,
      last_login_ip TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_users_api_key ON users(api_key);
    CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
    CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

    -- Access logs — every session start logs IP, user agent, session ID
    CREATE TABLE IF NOT EXISTS access_logs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       TEXT REFERENCES users(id),
      session_id    TEXT,
      ip_address    TEXT NOT NULL,
      user_agent    TEXT,
      endpoint      TEXT NOT NULL,
      method        TEXT NOT NULL DEFAULT 'GET',
      status_code   INTEGER,
      created_at    INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_access_logs_user ON access_logs(user_id);
    CREATE INDEX IF NOT EXISTS idx_access_logs_ip ON access_logs(ip_address);
    CREATE INDEX IF NOT EXISTS idx_access_logs_created ON access_logs(created_at);

    -- API key audit log — tracks key creation, revocation, rotation
    CREATE TABLE IF NOT EXISTS api_key_audit (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       TEXT NOT NULL REFERENCES users(id),
      action        TEXT NOT NULL CHECK(action IN ('create','revoke','rotate','suspend','reactivate')),
      old_key       TEXT,
      new_key       TEXT,
      reason        TEXT,
      performed_by  TEXT,
      created_at    INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_api_key_audit_user ON api_key_audit(user_id);

    -- Client device contexts — one per session, tracks the connecting device
    CREATE TABLE IF NOT EXISTS client_contexts (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id    TEXT UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
      ip_address    TEXT,
      user_agent    TEXT,
      platform      TEXT,
      os_name       TEXT,
      os_version    TEXT,
      browser       TEXT,
      browser_version TEXT,
      device_type   TEXT,  -- desktop, tablet, mobile
      screen_width  INTEGER,
      screen_height INTEGER,
      device_pixel_ratio REAL,
      language      TEXT,
      timezone      TEXT,
      online        INTEGER DEFAULT 1,
      cores         INTEGER,
      memory_gb     REAL,
      touch_support INTEGER DEFAULT 0,
      created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_client_contexts_session ON client_contexts(session_id);
    CREATE INDEX IF NOT EXISTS idx_client_contexts_ip ON client_contexts(ip_address);

    -- Persistent memories — facts, preferences, decisions, and context the agent should recall
    CREATE TABLE IF NOT EXISTS memories (
      id          TEXT PRIMARY KEY,
      category    TEXT NOT NULL DEFAULT 'general',
      key         TEXT NOT NULL,
      value       TEXT NOT NULL,
      source      TEXT NOT NULL DEFAULT 'agent',
      session_id  TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      confidence  REAL NOT NULL DEFAULT 1.0,
      access_count INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at  INTEGER NOT NULL DEFAULT (unixepoch()),
      expires_at  INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
    CREATE INDEX IF NOT EXISTS idx_memories_key ON memories(key);
    CREATE INDEX IF NOT EXISTS idx_memories_source ON memories(source);
    CREATE INDEX IF NOT EXISTS idx_memories_updated ON memories(updated_at);

    -- Command allowlist — dangerous commands the user has explicitly approved
    CREATE TABLE IF NOT EXISTS command_allowlist (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      command     TEXT NOT NULL,
      pattern     TEXT,
      source      TEXT NOT NULL DEFAULT 'user',
      session_id  TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_command_allowlist_command ON command_allowlist(command);
  `);

  // Seed admin user if no users exist
  const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  if (userCount === 0) {
    const adminId = crypto.randomUUID();
    const adminKey = 'hkai_' + crypto.randomBytes(24).toString('hex');
    db.prepare(
      `INSERT INTO users (id, username, email, api_key, role, plan, status) VALUES (?, ?, ?, ?, 'admin', 'enterprise', 'active')`
    ).run(adminId, 'admin', 'admin@hakster.ai', adminKey);
    console.log(`\n  🔑 Admin user seeded! API key: ${adminKey}\n`);
  }
}

module.exports = { getDb };
