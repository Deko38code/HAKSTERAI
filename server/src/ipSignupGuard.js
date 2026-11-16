'use strict';
/**
 * IP signup guard — "free, one account per IP; paid IPs are trusted".
 *
 * Rule set (owner request, 2026-11-16):
 *   - A network that already has a free HaksterAI account cannot mint another
 *     free one. One free account per IP.
 *   - Anyone on an IP that has a PAID account is exempt: the same household,
 *     office or shared connection can still add accounts once someone pays.
 *   - The paid checkout path (`createGuestUser` / Stripe) is never gated — a
 *     buyer is never turned away at the door.
 *   - The owner can hard-block or explicitly allow an IP from the dashboard.
 *     A hard block denies free signups AND free logins on that IP; paid
 *     accounts on the same IP keep working.
 *
 * Everything here is additive: it reads the existing `users.last_login_ip`
 * column, and creates its own two tables (`ip_guard_actions`, `ip_guard_events`).
 * It never edits, deletes or rewrites any user row.
 *
 * IP identification: behind the Cloudflare tunnel every direct peer is
 * loopback, so the real client is read from CF-Connecting-IP / X-Forwarded-For
 * when (and only when) the socket peer is itself private. Private, loopback
 * and CGNAT addresses are treated as "unidentified" and are NEVER used to
 * block a signup — otherwise one NATed household would lock the site for
 * everyone else.
 */

const FREE_ACCOUNTS_PER_IP = 1;
const PAID_PLANS = new Set(['lite', 'starter', 'starter_plus', 'pro', 'enterprise']);
const ALERT_THROTTLE_MS = 10 * 60 * 1000;

const lastAlertByIp = new Map();
let countsCache = { at: 0, byIp: null };

function ipOf(value) {
  return String(value || '').trim().replace(/^\[|\]$/g, '');
}

function normalizeIp(value) {
  let ip = ipOf(value);
  if (!ip) return '';
  if (ip.toLowerCase().startsWith('::ffff:')) ip = ip.slice(7);
  // XFF entries can carry a port ("1.2.3.4:5678"); strip it for IPv4 only.
  if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(ip)) ip = ip.slice(0, ip.lastIndexOf(':'));
  return ip;
}

function isPrivateIp(value) {
  const ip = normalizeIp(value).toLowerCase();
  if (!ip) return true;
  if (ip === '::1' || ip === 'localhost' || ip === '127.0.0.1') return true;
  if (/^127\./.test(ip)) return true;
  if (/^10\./.test(ip)) return true;
  if (/^192\.168\./.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  if (/^169\.254\./.test(ip)) return true;
  if (/^(100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(ip)) return true; // CGNAT
  if (/^(fc|fd)[0-9a-f]{2}:/.test(ip)) return true; // unique-local IPv6
  if (/^fe80:/.test(ip)) return true; // link-local IPv6
  return false;
}

/**
 * The address a signup/login actually came from.
 * Trusts forwarded headers only when the socket peer is private — that is the
 * tunnel/local case, never a direct Internet connection.
 */
function clientIp(req) {
  if (!req) return '';
  const directRaw = req.socket?.remoteAddress || req.connection?.remoteAddress || '';
  const direct = normalizeIp(directRaw);
  const trustForwarded = !direct || isPrivateIp(direct);
  if (trustForwarded) {
    const cf = normalizeIp(req.headers?.['cf-connecting-ip']);
    if (cf && !isPrivateIp(cf)) return cf;
    const xff = String(req.headers?.['x-forwarded-for'] || '')
      .split(',').map(normalizeIp).filter(Boolean);
    const firstPublic = xff.find(ip => !isPrivateIp(ip));
    if (firstPublic) return firstPublic;
  }
  // Last resort: keep whatever the server already used, normalised.
  return direct || normalizeIp(req.ip || req.headers?.['x-forwarded-for'] || '');
}

function ensureTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS ip_guard_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('block','allow')),
    reason TEXT,
    created_by TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    expires_at INTEGER
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_ip_guard_actions_ip ON ip_guard_actions(ip, id DESC)');
  db.exec(`CREATE TABLE IF NOT EXISTS ip_guard_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip TEXT NOT NULL,
    action TEXT NOT NULL,
    code TEXT,
    source TEXT,
    detail TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_ip_guard_events_created ON ip_guard_events(created_at DESC)');
}

function ensureReady(db) {
  if (!db.__ipGuardReady) {
    ensureTables(db);
    db.__ipGuardReady = true;
  }
}

/** Newest non-expired owner action for an IP, or null. */
function activeAction(db, ip) {
  if (!ip) return null;
  ensureReady(db);
  const row = db.prepare(
    'SELECT action, reason, created_at, expires_at FROM ip_guard_actions WHERE ip = ? ORDER BY id DESC LIMIT 1'
  ).get(ip);
  if (!row) return null;
  if (row.expires_at && row.expires_at <= Math.floor(Date.now() / 1000)) return null;
  return row;
}

function allCounts(db) {
  const now = Date.now();
  if (countsCache.byIp && now - countsCache.at < 1500 && countsCache.db === db) return countsCache.byIp;
  const rows = db.prepare("SELECT last_login_ip AS ip, plan FROM users WHERE status = 'active'").all();
  const byIp = new Map();
  for (const row of rows) {
    const ip = normalizeIp(row.ip);
    if (!ip || isPrivateIp(ip)) continue;
    const entry = byIp.get(ip) || { free: 0, paid: 0 };
    if (PAID_PLANS.has(String(row.plan || ''))) entry.paid += 1;
    else entry.free += 1;
    byIp.set(ip, entry);
  }
  countsCache = { at: now, byIp, db };
  return byIp;
}

function countsFor(db, ip) {
  const key = normalizeIp(ip);
  if (!key || isPrivateIp(key)) return { free: 0, paid: 0, identified: false };
  const entry = allCounts(db).get(key) || { free: 0, paid: 0 };
  return { free: entry.free, paid: entry.paid, identified: true };
}

function invalidate() {
  countsCache = { at: 0, byIp: null, db: null };
}

/**
 * Decide whether a *new* account may be created/attached on this IP.
 * opts: { paidPath?: boolean, isOwner?: boolean, source?: string }
 * Never throws on a policy decision; only a broken database throws.
 */
function evaluateSignup(db, ip, opts = {}) {
  ensureReady(db);
  const key = normalizeIp(ip);
  const base = {
    ip: key,
    identified: !!key && !isPrivateIp(key),
    freeAccounts: 0,
    paidAccounts: 0,
    paidIp: false,
    blocked: false,
    allowed: true,
    code: 'ok',
    message: '',
    freeLimit: FREE_ACCOUNTS_PER_IP,
  };
  if (opts.isOwner) return { ...base, code: 'owner', message: 'owner account' };
  if (opts.paidPath) return { ...base, code: 'paid-checkout', message: 'paid checkout is never gated' };
  if (!base.identified) return { ...base, code: 'unidentified-ip', message: 'no public client IP to apply the rule to' };

  const counts = countsFor(db, key);
  const verdict = { ...base, freeAccounts: counts.free, paidAccounts: counts.paid, paidIp: counts.paid > 0 };

  const action = activeAction(db, key);
  if (action && action.action === 'allow') {
    return { ...verdict, code: 'owner-allow', message: action.reason || 'this IP is explicitly allowed' };
  }
  if (action && action.action === 'block') {
    verdict.blocked = true;
    if (verdict.paidIp) {
      return { ...verdict, code: 'block-bypassed-paid', message: 'IP is blocked but has a paid account' };
    }
    return { ...verdict, allowed: false, code: 'ip-blocked', message: action.reason || 'this network is blocked' };
  }
  if (verdict.paidIp) {
    return { ...verdict, code: 'paid-ip', message: 'this network already has a paid account' };
  }
  if (verdict.freeAccounts >= FREE_ACCOUNTS_PER_IP) {
    return {
      ...verdict,
      allowed: false,
      code: 'free-limit',
      message: `this network already has ${verdict.freeAccounts} free account${verdict.freeAccounts === 1 ? '' : 's'} — sign in, or upgrade to add more`,
    };
  }
  return verdict;
}

/**
 * Login check for an existing account. Only hard blocks bite here; the
 * one-free-account rule applies to creating accounts, never to signing into
 * one that already exists. Paid accounts are never blocked.
 */
function evaluateLogin(db, ip, user) {
  ensureReady(db);
  const key = normalizeIp(ip);
  const plan = String(user?.plan || 'free');
  const paid = PAID_PLANS.has(plan);
  const base = { ip: key, allowed: true, code: 'ok', blocked: false, paid, message: '' };
  if (paid || !key || isPrivateIp(key)) return base;
  const action = activeAction(db, key);
  if (action && action.action === 'block') {
    return { ...base, allowed: false, blocked: true, code: 'ip-blocked', message: action.reason || 'this network is blocked' };
  }
  return base;
}

function logEvent(db, { ip, action, code, source, detail }) {
  try {
    ensureReady(db);
    db.prepare('INSERT INTO ip_guard_events (ip, action, code, source, detail) VALUES (?, ?, ?, ?, ?)')
      .run(normalizeIp(ip) || '', String(action || ''), String(code || ''), String(source || ''), String(detail || '').slice(0, 300));
  } catch (err) {
    console.warn('[ip-guard] event log write failed:', err.message);
  }
}

/** Log a blocked signup and alert the owner at most once per IP per 10 min. */
function reportBlocked(db, verdict, meta = {}) {
  if (!verdict || verdict.allowed) return;
  logEvent(db, {
    ip: verdict.ip,
    action: 'blocked',
    code: verdict.code,
    source: meta.source || '',
    detail: verdict.message || '',
  });
  const now = Date.now();
  const last = lastAlertByIp.get(verdict.ip) || 0;
  if (now - last < ALERT_THROTTLE_MS) return;
  lastAlertByIp.set(verdict.ip, now);
  if (lastAlertByIp.size > 500) {
    for (const [ip, at] of lastAlertByIp) if (now - at > ALERT_THROTTLE_MS) lastAlertByIp.delete(ip);
  }
  try {
    const bots = require('./telegramBots');
    const text = [
      '🛡️ IP signup guard blocked a free signup',
      `IP: ${verdict.ip}`,
      `Reason: ${verdict.code} — ${verdict.message}`,
      `Free accounts on that IP: ${verdict.freeAccounts ?? 0} · paid: ${verdict.paidAccounts ?? 0}`,
      `Source: ${meta.source || 'signup'}`,
      'Paid accounts and paid checkouts are never blocked.',
    ].join('\n');
    if (typeof bots.sendReconResult === 'function') bots.sendReconResult(text);
    else if (typeof bots.sendHealthAlert === 'function') bots.sendHealthAlert(text);
  } catch (err) {
    console.warn('[ip-guard] alert not sent:', err.message);
  }
}

/** Record a successful signup so the audit trail explains every account. */
function reportAllowed(db, verdict, meta = {}) {
  if (!verdict) return;
  logEvent(db, {
    ip: verdict.ip,
    action: 'allowed',
    code: verdict.code,
    source: meta.source || '',
    detail: meta.detail || '',
  });
}

function setAction(db, { ip, action, reason, hours, by }) {
  ensureReady(db);
  const key = normalizeIp(ip);
  if (!key) throw new Error('an IP address is required');
  if (action !== 'block' && action !== 'allow') throw new Error("action must be 'block' or 'allow'");
  const ttl = Number(hours) > 0 ? Number(hours) : 0;
  const expiresAt = ttl ? Math.floor(Date.now() / 1000) + Math.floor(ttl * 3600) : null;
  db.prepare('INSERT INTO ip_guard_actions (ip, action, reason, created_by, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(key, action, String(reason || '').slice(0, 200), String(by || 'owner'), expiresAt);
  logEvent(db, { ip: key, action: action === 'block' ? 'blocked' : 'allowed', code: 'owner-' + action, source: 'dashboard', detail: reason || '' });
  invalidate();
  return { ip: key, action, reason: reason || '', expiresAt };
}

/** Owner-facing snapshot for the dashboard panel. */
function ownerSummary(db, limit = 25) {
  ensureReady(db);
  const now = Math.floor(Date.now() / 1000);
  const byIp = allCounts(db);
  const multi = [...byIp.entries()]
    .filter(([, c]) => c.free > FREE_ACCOUNTS_PER_IP || c.free + c.paid > 1)
    .map(([ip, c]) => ({ ip, free: c.free, paid: c.paid }))
    .sort((a, b) => (b.free + b.paid) - (a.free + a.paid))
    .slice(0, limit);

  const rawActions = db.prepare(
    `SELECT ip, action, reason, created_by, created_at, expires_at
       FROM ip_guard_actions
      WHERE expires_at IS NULL OR expires_at > ?
      ORDER BY id DESC LIMIT 200`
  ).all(now);
  // Only the newest non-expired action per IP is in force; an `allow` lifted a
  // block by superseding it, so a stale block must not keep counting.
  const effective = new Map();
  for (const row of rawActions) {
    if (!effective.has(row.ip)) effective.set(row.ip, row);
  }
  const all = [...effective.values()].slice(0, limit);
  const blocks = all.filter(a => a.action === 'block');
  const allows = all.filter(a => a.action === 'allow');

  const events = db.prepare(
    `SELECT ip, action, code, source, detail, created_at,
            (? - created_at) AS seconds_ago
       FROM ip_guard_events ORDER BY id DESC LIMIT ?`
  ).all(now, limit);

  const blocked24h = db.prepare(
    `SELECT COUNT(*) AS c FROM ip_guard_events WHERE action = 'blocked' AND created_at > ?`
  ).get(now - 86400).c;

  return {
    freeLimit: FREE_ACCOUNTS_PER_IP,
    rule: `one free account per IP · paid accounts and paid checkouts are exempt`,
    totals: {
      ipCount: byIp.size,
      multiAccountIps: multi.length,
      blockedIps: blocks.length,
      allowedIps: allows.length,
      blockedAttempts24h: blocked24h,
    },
    multi,
    blocks,
    allows,
    events,
    checkedAt: now,
  };
}

module.exports = {
  FREE_ACCOUNTS_PER_IP,
  PAID_PLANS,
  normalizeIp,
  isPrivateIp,
  clientIp,
  ensureTables,
  evaluateSignup,
  evaluateLogin,
  reportBlocked,
  reportAllowed,
  activeAction,
  countsFor,
  setAction,
  ownerSummary,
  invalidate,
};
