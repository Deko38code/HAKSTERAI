'use strict';
/**
 * House accounts — the owner's own addresses, and the "first real signup" signal.
 *
 * 2026-11-16 (owner): "system need to know my emails for free enterprise to know
 * when we get 1st real signup". So the system classifies every account it sees:
 *
 *   house   — one of the owner's addresses. Gets the enterprise feature set for
 *             free and is NEVER counted as a customer. Logins are reported as
 *             house logins, not as new users.
 *   system  — service/admin addresses (role admin, @hakster.ai, or seed rows).
 *             Never a customer; never announced as one.
 *   real    — everyone else: a real customer signup, and the first one is
 *             announced once, high priority, with its source flow.
 *
 * This module applies to EVERY signup path (Google OAuth callback, Google ID-token
 * sign-in, Telegram, and paid web checkout), not just Telegram.
 *
 * Rules it keeps:
 *  - additive only. The one write to an existing row is a narrow upgrade: a house
 *    address still on the 'free' plan is moved to 'enterprise'. A paid plan on a
 *    house address is left exactly as Stripe set it. No row is ever deleted.
 *  - it creates its own tiny state table (house_state) so the first-real-signup
 *    milestone fires exactly once across restarts. No config is touched and no
 *    secrets are read or written.
 *  - every notification failure is swallowed: a signup must never fail because a
 *    notice could not be delivered.
 *
 * Extra house addresses can be supplied through HAKSTER_HOUSE_EMAILS (comma or
 * space separated) without editing this file.
 */

// Kept in step with BUILTIN_OWNER_EMAILS in server/src/index.js, plus the other
// addresses the owner confirmed as his on 2026-11-16 (dekoneedo@gmail.com,
// kalilinuxneed@gmail.com).
const BUILTIN_HOUSE_EMAILS = [
  'dekekenneth840@gmail.com',
  'dekoneed@gmail.com',
  'dekeneed@yahoo.com',
  'savannahscott899@gmail.com',
  'dekoneedo@gmail.com',
  'kalilinuxneed@gmail.com',
];

// Service/platform addresses. Never customers, never house upgrades.
const SYSTEM_EMAIL_DOMAINS = ['hakster.ai', 'haksterai.com'];

const STATE_TABLE = 'house_state';

function norm(email) {
  return String(email || '').toLowerCase().trim();
}

function domainOf(email) {
  const at = norm(email).lastIndexOf('@');
  return at === -1 ? '' : norm(email).slice(at + 1);
}

function houseEmails() {
  const extra = String(process.env.HAKSTER_HOUSE_EMAILS || process.env.OWNER_EMAILS || '')
    .split(/[,\s]+/)
    .filter(Boolean);
  return Array.from(new Set([...BUILTIN_HOUSE_EMAILS, ...extra].map(norm).filter(Boolean)));
}

function isHouse(email) {
  return houseEmails().includes(norm(email));
}

function isSystem(email) {
  const d = domainOf(email);
  return !!d && SYSTEM_EMAIL_DOMAINS.includes(d);
}

/** 'house' | 'system' | 'real' | 'unknown' for one users row. */
function classify(row) {
  if (!row) return 'unknown';
  const email = norm(row.email);
  // House first: the owner's primary address is also an admin row, and it must
  // still read as "house", not as an anonymous platform account.
  if (email && isHouse(email)) return 'house';
  if (email && isSystem(email)) return 'system';
  if (String(row.role || '') === 'admin') return 'system';
  if (!email) return row.telegram_id ? 'real' : 'unknown';
  return 'real';
}

function ensureStateTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${STATE_TABLE} (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at INTEGER NOT NULL DEFAULT 0
  )`);
}

function getState(db, key) {
  try {
    ensureStateTable(db);
    const row = db.prepare(`SELECT value FROM ${STATE_TABLE} WHERE key = ?`).get(key);
    if (!row || !row.value) return null;
    try { return JSON.parse(row.value); } catch (_) { return row.value; }
  } catch (_) {
    return null;
  }
}

function setState(db, key, value) {
  try {
    ensureStateTable(db);
    db.prepare(`INSERT INTO ${STATE_TABLE} (key, value, updated_at) VALUES (?, ?, unixepoch())
                ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()`)
      .run(key, JSON.stringify(value));
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * House accounts get the enterprise feature set for free. Only a plan that is
 * still 'free' is touched — a paid plan on a house address is left exactly as
 * Stripe set it.
 */
function ensureEnterprise(db, email) {
  if (!db || !isHouse(email)) return { house: false, changed: false };
  try {
    const row = db.prepare('SELECT id, plan FROM users WHERE lower(email) = ?').get(norm(email));
    if (!row) return { house: true, changed: false };
    if (row.plan === 'enterprise') return { house: true, changed: false };
    if (row.plan !== 'free') return { house: true, changed: false, kept: row.plan };
    db.prepare("UPDATE users SET plan = 'enterprise', updated_at = unixepoch() WHERE id = ?").run(row.id);
    return { house: true, changed: true, plan: 'enterprise' };
  } catch (err) {
    return { house: true, changed: false, error: err.message };
  }
}

/** Who is who on this box, right now. */
function realSignupSummary(db) {
  const house = houseEmails();
  const empty = {
    houseEmails: house,
    houseCount: house.length,
    systemCount: 0,
    realCount: 0,
    telegramCount: 0,
    first: null,
    milestone: null,
  };
  if (!db) return empty;
  try {
    const rows = db.prepare("SELECT id, username, email, role, plan, telegram_id, created_at FROM users").all();
    const real = [];
    let systemCount = 0;
    let telegramCount = 0;
    for (const r of rows) {
      const kind = classify(r);
      if (kind === 'system') systemCount++;
      else if (kind === 'real') {
        real.push(r);
        if (!norm(r.email) && r.telegram_id) telegramCount++;
      }
    }
    real.sort((a, b) => Number(a.created_at || 0) - Number(b.created_at || 0));
    const first = real[0] || null;
    return {
      houseEmails: house,
      houseCount: house.length,
      systemCount,
      realCount: real.length,
      telegramCount,
      first: first ? { email: norm(first.email) || null, username: first.username || null, at: first.created_at || null } : null,
      milestone: getState(db, 'first_real_signup'),
    };
  } catch (err) {
    return { ...empty, error: err.message };
  }
}

function safeNotify(notify, message, opts) {
  if (typeof notify !== 'function') return;
  try { notify(message, opts); } catch (_) { /* a notice must never fail a signup */ }
}

/**
 * The one call every signup/login path makes after its user row exists.
 *
 *   noteSignup(db, { email, username, display, wasSignup, ip, source }, notifPush)
 *
 * Returns { kind, house, real, first, summary } so a caller can adjust its own
 * behaviour if it wants to; it always sends the right notification itself.
 */
function noteSignup(db, info = {}, notify) {
  const email = norm(info.email);
  const who = info.display || info.username || email || 'unknown';
  const source = String(info.source || 'signup').slice(0, 40);
  const verb = info.wasSignup ? 'signup' : 'login';

  if (isHouse(email)) {
    const ensured = ensureEnterprise(db, email);
    safeNotify(notify,
      `🔐 House account ${verb}: ${who} (${email}) — your own address, not a customer` +
        (ensured.changed ? ' · plan set to enterprise' : ''),
      { type: 'user_login', priority: 'normal', source: 'house' });
    return { kind: 'house', house: true, real: false, first: false, ensured, summary: realSignupSummary(db) };
  }

  if (!email && !info.telegramId) {
    return { kind: 'unknown', house: false, real: false, first: false, summary: realSignupSummary(db) };
  }

  if (isSystem(email)) {
    safeNotify(notify,
      `🔐 System account ${verb}: ${who} (${email}) — platform address, not a customer`,
      { type: 'user_login', priority: 'normal', source: 'system' });
    return { kind: 'system', house: false, real: false, first: false, summary: realSignupSummary(db) };
  }

  // A real customer. The first one ever is a milestone; every later one is the
  // ordinary new-user notice.
  let milestone = getState(db, 'first_real_signup');
  let first = false;
  if (!milestone) {
    milestone = {
      email: email || null,
      username: info.username || who,
      telegram: info.telegramId ? String(info.telegramId) : null,
      source,
      at: Math.floor(Date.now() / 1000),
    };
    first = setState(db, 'first_real_signup', milestone);
  }

  if (first) {
    safeNotify(notify,
      `🎉 First real customer signup: ${email || who} via ${source}. House and system accounts are excluded — this is the first account that is not yours.`,
      { type: 'user_signup', priority: 'high', source: 'signup' });
  } else {
    safeNotify(notify,
      `👤 ${info.wasSignup ? 'New customer' : 'Customer login'}: ${who}${email ? ' (' + email + ')' : ''} via ${source}`,
      { type: 'user_signup', priority: info.wasSignup ? 'high' : 'normal', source: 'auth' });
  }

  return { kind: 'real', house: false, real: true, first, milestone, summary: realSignupSummary(db) };
}

module.exports = {
  BUILTIN_HOUSE_EMAILS,
  SYSTEM_EMAIL_DOMAINS,
  houseEmails,
  isHouse,
  isSystem,
  classify,
  ensureEnterprise,
  realSignupSummary,
  noteSignup,
  _norm: norm,
};
