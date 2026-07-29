'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Pre-start safety: crash early if better-sqlite3 native module can't load.
// PM2 will auto-restart. This prevents the server running as a zombie where
// every DB call throws silently (e.g. after a Node.js version upgrade).
let Database;
try {
  Database = require('better-sqlite3');
  // Smoke test: actually open an in-memory DB and run a query
  const _smoke = new Database(':memory:');
  _smoke.prepare('SELECT 1 as ok').get();
  _smoke.close();
} catch (e) {
  console.error('[FATAL] better-sqlite3 native module failed to load:', e.message);
  console.error('[FATAL] Run "npm rebuild better-sqlite3" in the server/ directory.');
  console.error('[FATAL] Aborting startup — PM2 will auto-restart.');
  process.exit(1);
}

const DB_PATH = path.join(__dirname, '../../data/hakster.db');

// Ensure data dir exists
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    // BUG FIX: Set busy_timeout so background audit writes wait for the lock
    // instead of throwing "attempt to write a readonly database" when the
    // WAL is momentarily locked by another writer.
    db.pragma('busy_timeout = 5000');
    initSchema(db);
  }
  return db;
}

// BUG FIX: Allow callers (e.g. security audit retry) to force-close and
// reopen the DB handle to recover from a stale/locked state.
function resetDb() {
  try {
    if (db) db.close();
  } catch {}
  db = null;
  return getDb();
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
      google_id     TEXT UNIQUE,
      referral_code TEXT UNIQUE,
      referred_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
      token_balance INTEGER NOT NULL DEFAULT 0,
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
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

    -- Referrals — tracks friend signups and one-time token rewards
    CREATE TABLE IF NOT EXISTS referrals (
      id                TEXT PRIMARY KEY,
      referrer_user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      referred_user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      referral_code     TEXT NOT NULL,
      reward_tokens     INTEGER NOT NULL DEFAULT 0,
      referred_tokens   INTEGER NOT NULL DEFAULT 0,
      status            TEXT NOT NULL DEFAULT 'credited' CHECK(status IN ('pending','credited','void')),
      created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(referred_user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_user_id);
    CREATE INDEX IF NOT EXISTS idx_referrals_code ON referrals(referral_code);

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

    -- User activity log — tracks every user action with full IP/device tracking
    CREATE TABLE IF NOT EXISTS user_activity (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       TEXT REFERENCES users(id) ON DELETE SET NULL,
      action        TEXT NOT NULL,  -- login, logout, signup, chat_start, tool_use, api_call, google_auth
      ip_address    TEXT,
      user_agent    TEXT,
      endpoint      TEXT,
      method        TEXT DEFAULT 'POST',
      status_code   INTEGER DEFAULT 200,
      device_type   TEXT,           -- desktop, tablet, mobile
      os_name       TEXT,
      browser       TEXT,
      screen_size   TEXT,           -- e.g. "1920x1080"
      language      TEXT,
      timezone      TEXT,
      session_id    TEXT,
      metadata      TEXT,           -- JSON blob for extra context
      created_at    INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_user_activity_user ON user_activity(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_activity_action ON user_activity(action);
    CREATE INDEX IF NOT EXISTS idx_user_activity_ip ON user_activity(ip_address);
    CREATE INDEX IF NOT EXISTS idx_user_activity_created ON user_activity(created_at);

    -- Per-user token ledger — tracks live token burn by Google-backed user.
    CREATE TABLE IF NOT EXISTS user_token_usage (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       TEXT REFERENCES users(id) ON DELETE SET NULL,
      google_id     TEXT,
      session_id    TEXT,
      endpoint      TEXT NOT NULL DEFAULT '/api/agent/run',
      provider      TEXT,
      model         TEXT,
      input_tokens  INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      tool_calls    INTEGER NOT NULL DEFAULT 0,
      fast_mode     INTEGER NOT NULL DEFAULT 0,
      created_at    INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_user_token_usage_user ON user_token_usage(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_token_usage_google ON user_token_usage(google_id);
    CREATE INDEX IF NOT EXISTS idx_user_token_usage_created ON user_token_usage(created_at);

    -- Payments / receipts — tracks every payment transaction
    CREATE TABLE IF NOT EXISTS payments (
      id              TEXT PRIMARY KEY,          -- internal receipt ID (e.g. rcpt_xxx)
      user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      amount          REAL NOT NULL DEFAULT 0,
      currency        TEXT NOT NULL DEFAULT 'USD',
      plan            TEXT NOT NULL DEFAULT 'pro',  -- free, pro, enterprise
      billing_cycle   TEXT NOT NULL DEFAULT 'monthly', -- monthly, yearly, lifetime
      status          TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed','failed','refunded','cancelled')),
      payment_method  TEXT,  -- stripe, paypal, crypto, manual
      provider_id     TEXT,  -- Stripe charge/sub ID, PayPal txn ID, etc.
      description     TEXT,
      metadata        TEXT,  -- JSON blob for extra context
      created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at      INTEGER NOT NULL DEFAULT (unixepoch()),
      completed_at    INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id);
    CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
    CREATE INDEX IF NOT EXISTS idx_payments_created ON payments(created_at);
    CREATE INDEX IF NOT EXISTS idx_payments_provider ON payments(provider_id);

    -- User devices — remembers every device a user has logged in from (for "remember me" and device management)
    CREATE TABLE IF NOT EXISTS user_devices (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      device_fingerprint TEXT NOT NULL,  -- hash of UA + screen + GPU + timezone
      device_name       TEXT,            -- e.g. "iPhone 15 Pro" or "Windows Desktop"
      device_type       TEXT,            -- desktop, mobile, tablet, tv
      os_name           TEXT,
      os_version        TEXT,
      browser           TEXT,
      browser_version   TEXT,
      user_agent        TEXT,
      ip_address        TEXT,
      screen_resolution TEXT,
      gpu               TEXT,
      timezone          TEXT,
      language          TEXT,
      is_trusted        INTEGER NOT NULL DEFAULT 0,
      last_seen_at      INTEGER NOT NULL DEFAULT (unixepoch()),
      first_seen_at     INTEGER NOT NULL DEFAULT (unixepoch()),
      created_at        INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_user_devices_user ON user_devices(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_devices_fp ON user_devices(device_fingerprint);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_user_devices_user_fp ON user_devices(user_id, device_fingerprint);

    -- Subscriptions — active subscription state per user
    CREATE TABLE IF NOT EXISTS subscriptions (
      id              TEXT PRIMARY KEY,
      user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      plan            TEXT NOT NULL DEFAULT 'pro',
      billing_cycle   TEXT NOT NULL DEFAULT 'monthly',
      status          TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','cancelled','expired','past_due','trialing')),
      current_period_start INTEGER,
      current_period_end   INTEGER,
      cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
      payment_id      TEXT REFERENCES payments(id) ON DELETE SET NULL,
      provider_sub_id TEXT,  -- Stripe subscription ID
      metadata        TEXT,
      created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id);
    CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);
  `);

  // ── Migrations: add columns to existing tables if missing ──
  try {
    const userCols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
    if (!userCols.includes('google_id')) {
      db.prepare("ALTER TABLE users ADD COLUMN google_id TEXT").run();
      console.log('  [migration] Added google_id column to users');
    }
    if (!userCols.includes('usage_count')) {
      db.prepare("ALTER TABLE users ADD COLUMN usage_count INTEGER NOT NULL DEFAULT 0").run();
      console.log('  [migration] Added usage_count column to users');
    }
    if (!userCols.includes('usage_reset_at')) {
      db.prepare("ALTER TABLE users ADD COLUMN usage_reset_at INTEGER NOT NULL DEFAULT 0").run();
      console.log('  [migration] Added usage_reset_at column to users');
    }
    if (!userCols.includes('referral_code')) {
      db.prepare("ALTER TABLE users ADD COLUMN referral_code TEXT").run();
      console.log('  [migration] Added referral_code column to users');
    }
    if (!userCols.includes('referred_by')) {
      db.prepare("ALTER TABLE users ADD COLUMN referred_by TEXT REFERENCES users(id) ON DELETE SET NULL").run();
      console.log('  [migration] Added referred_by column to users');
    }
    if (!userCols.includes('token_balance')) {
      db.prepare("ALTER TABLE users ADD COLUMN token_balance INTEGER NOT NULL DEFAULT 0").run();
      console.log('  [migration] Added token_balance column to users');
    }
    if (!userCols.includes('telegram_id')) {
      db.prepare("ALTER TABLE users ADD COLUMN telegram_id TEXT").run();
      console.log('  [migration] Added telegram_id column to users');
    }
    if (!userCols.includes('stripe_customer_id')) {
      db.prepare("ALTER TABLE users ADD COLUMN stripe_customer_id TEXT").run();
      console.log('  [migration] Added stripe_customer_id column to users');
    }
    // Create google_id index after column is added
    db.prepare("CREATE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id)").run();
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_telegram_id_unique ON users(telegram_id) WHERE telegram_id IS NOT NULL").run();
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_referral_code_unique ON users(referral_code) WHERE referral_code IS NOT NULL").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code)").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_users_referred_by ON users(referred_by)").run();
  } catch (e) { /* table may not exist yet */ }

  // ── Migrate sessions: add user_id column ──
  try {
    const sessCols = db.prepare("PRAGMA table_info(sessions)").all().map(c => c.name);
    if (!sessCols.includes('user_id')) {
      db.prepare("ALTER TABLE sessions ADD COLUMN user_id TEXT REFERENCES users(id)").run();
      console.log('  [migration] Added user_id column to sessions');
    }
    if (!sessCols.includes('workspace')) {
      db.prepare("ALTER TABLE sessions ADD COLUMN workspace TEXT").run();
      console.log('  [migration] Added workspace column to sessions');
    }
    if (!sessCols.includes('metadata')) {
      db.prepare("ALTER TABLE sessions ADD COLUMN metadata TEXT").run();
      console.log('  [migration] Added metadata column to sessions');
    }
    db.prepare("CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)").run();
  } catch (e) { /* table may not exist yet */ }

  // ── Migrate client_contexts: add enhanced detection columns ──
  try {
    const ctxCols = db.prepare("PRAGMA table_info(client_contexts)").all().map(c => c.name);
    const newCtxCols = [
      'device_model', 'engine', 'engine_version', 'languages', 'timezone_offset',
      'screen_avail_width', 'screen_avail_height', 'screen_color_depth',
      'screen_orientation', 'viewport_width', 'viewport_height',
      'max_touch_points', 'connection_type', 'connection_downlink', 'connection_rtt',
      'connection_save_data', 'cookies_enabled', 'do_not_track', 'pdf_viewer',
      'webdriver', 'is_bot', 'gpu', 'dark_mode', 'reduced_motion',
    ];
    for (const col of newCtxCols) {
      if (!ctxCols.includes(col)) {
        db.prepare(`ALTER TABLE client_contexts ADD COLUMN ${col} TEXT`).run();
        console.log(`  [migration] Added ${col} column to client_contexts`);
      }
    }
  } catch (e) { /* table may not exist yet */ }

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

module.exports = { getDb, resetDb };
