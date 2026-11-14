'use strict';

// Access guard — decides who may use a gated surface, records every decision, and
// keeps a temporary IP denial list the owner controls from Telegram.
//
// Design rules (deliberate):
//   • "not paid" is NOT "unauthorized". Free and trialing accounts keep their
//     documented allowance; they are never auto-denied.
//   • Deny is reserved for: banned/suspended accounts, an expired subscription that
//     still claims paid access, and repeated probing of owner-only / gated routes.
//   • OBSERVE mode is the default. Decisions are recorded and reported, nothing is
//     blocked, until the owner flips the mode in server/data/access-guard.json.
//   • Loopback, private LAN and owner-declared IPs are never auto-denied — the
//     owner must not be able to lock himself out.
//   • Nothing here edits config, touches a process or changes a firewall rule.
//     Denials are app-level rows with an expiry.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { getDb } = require('./db');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'access-guard.json');
const OWNER_FILE = path.join(DATA_DIR, 'owner-identities.json');

const DEFAULTS = {
  mode: 'observe',            // 'observe' | 'enforce'
  strikesToDeny: 5,           // unauthorized probes before an IP is denied
  strikeWindowMinutes: 30,
  ttlMinutes: 60,             // how long an automatic denial lasts
  graceDays: 3,               // days after a paid period ends before access lapses
  surfaces: {
    hakster: { enforce: false, gatedRoutes: ['/api/agent/run', '/api/chat', '/api/chat/stream', '/api/generate'], paidOnlyRoutes: [], ownerOnlyRoutes: [] },
    phantom: { enforce: false, gatedRoutes: [], paidOnlyRoutes: [], ownerOnlyRoutes: [] },
    miniforge: { enforce: false, gatedRoutes: [], paidOnlyRoutes: [], ownerOnlyRoutes: [] },
  },
};

function now() { return Math.floor(Date.now() / 1000); }

function ensureDir() { try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {} }

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, value) {
  ensureDir();
  try { if (fs.existsSync(file)) fs.copyFileSync(file, file + '.prev'); } catch {}
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

// ── settings / owners ───────────────────────────────────────────────────────────────

function loadSettings() {
  const s = readJson(SETTINGS_FILE, null);
  if (!s) return { ...DEFAULTS, surfaces: JSON.parse(JSON.stringify(DEFAULTS.surfaces)) };
  return {
    ...DEFAULTS,
    ...s,
    surfaces: { ...JSON.parse(JSON.stringify(DEFAULTS.surfaces)), ...(s.surfaces || {}) },
  };
}

function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  writeJson(SETTINGS_FILE, next);
  return next;
}

function loadOwners() {
  const o = readJson(OWNER_FILE, null);
  return { emails: (o && o.emails) || [], ips: (o && o.ips) || [], userIds: (o && o.userIds) || [] };
}

function saveOwners(o) { writeJson(OWNER_FILE, o); return o; }

function addOwner({ email, ip, userId }) {
  const o = loadOwners();
  if (email && !o.emails.includes(String(email).toLowerCase())) o.emails.push(String(email).toLowerCase());
  if (ip && !o.ips.includes(ip)) o.ips.push(ip);
  if (userId && !o.userIds.includes(userId)) o.userIds.push(userId);
  return saveOwners(o);
}

function removeOwner({ email, ip, userId }) {
  const o = loadOwners();
  if (email) o.emails = o.emails.filter((e) => e !== String(email).toLowerCase());
  if (ip) o.ips = o.ips.filter((e) => e !== ip);
  if (userId) o.userIds = o.userIds.filter((e) => e !== userId);
  return saveOwners(o);
}

// ── schema (additive, created on demand) ────────────────────────────────────────────

let schemaReady = false;
function ensureSchema() {
  if (schemaReady) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS access_decisions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      at         INTEGER NOT NULL,
      ip         TEXT,
      user_id    TEXT,
      email      TEXT,
      surface    TEXT,
      route      TEXT,
      action     TEXT NOT NULL,
      reason     TEXT,
      plan       TEXT,
      paid_until INTEGER,
      mode       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_access_decisions_at ON access_decisions(at);
    CREATE INDEX IF NOT EXISTS idx_access_decisions_ip ON access_decisions(ip, at);
    CREATE INDEX IF NOT EXISTS idx_access_decisions_user ON access_decisions(user_id, at);

    CREATE TABLE IF NOT EXISTS ip_denials (
      ip         TEXT PRIMARY KEY,
      reason     TEXT,
      surface    TEXT,
      created_at INTEGER NOT NULL,
      until      INTEGER NOT NULL,
      created_by TEXT
    );

    CREATE TABLE IF NOT EXISTS access_strikes (
      ip     TEXT NOT NULL,
      at     INTEGER NOT NULL,
      reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_access_strikes_ip ON access_strikes(ip, at);
  `);
  schemaReady = true;
}

// ── client IP ───────────────────────────────────────────────────────────────────────

function normalizeIp(ip) {
  const s = String(ip || '').trim();
  if (!s) return '';
  if (s.startsWith('::ffff:')) return s.slice(7);
  if (s === '::1') return '127.0.0.1';
  return s;
}

function isPrivateOrLocal(ip) {
  const s = normalizeIp(ip);
  if (!s) return true;
  if (s === '127.0.0.1' || s === 'localhost') return true;
  if (/^10\./.test(s)) return true;
  if (/^192\.168\./.test(s)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(s)) return true;
  if (/^169\.254\./.test(s)) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(s)) return true; // CGNAT
  if (/^f[cd][0-9a-f]{2}:/i.test(s)) return true;                        // ULA
  if (/^fe80:/i.test(s)) return true;
  return false;
}

// Through the Cloudflare tunnel the socket peer is loopback, so the real client
// address arrives in CF-Connecting-IP. Trust it ONLY when the peer is loopback
// (that is where cloudflared connects) — a LAN or public peer that sends the header
// is either spoofing it or double-proxied, and either way its own address is truer.
function isLoopback(ip) {
  const s = normalizeIp(ip);
  return s === '127.0.0.1' || s === 'localhost';
}

function clientIp(req) {
  if (!req) return '';
  const sock = normalizeIp(req.socket && (req.socket.remoteAddress || req.connection && req.connection.remoteAddress));
  const hdr = req.headers || {};
  const cf = normalizeIp(hdr['cf-connecting-ip']);
  const xff = String(hdr['x-forwarded-for'] || '').split(',')[0].trim();
  if (isLoopback(sock) && cf) return cf;
  if (isLoopback(sock) && xff && /^[0-9a-f.:]+$/i.test(xff)) return normalizeIp(xff);
  return sock || cf || '';
}

// ── identity / paid state ───────────────────────────────────────────────────────────

function findUser({ userId, email, apiKey } = {}) {
  ensureSchema();
  const db = getDb();
  try {
    if (userId) return db.prepare('SELECT id, username, email, role, plan, status FROM users WHERE id = ?').get(userId) || null;
    if (email) return db.prepare('SELECT id, username, email, role, plan, status FROM users WHERE lower(email) = lower(?)').get(email) || null;
    if (apiKey) return db.prepare('SELECT id, username, email, role, plan, status FROM users WHERE api_key = ?').get(apiKey) || null;
  } catch { return null; }
  return null;
}

function isOwnerUser(user, owners) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  const o = owners || loadOwners();
  if (user.id && o.userIds.includes(user.id)) return true;
  if (user.email && o.emails.includes(String(user.email).toLowerCase())) return true;
  return false;
}

// A verified paid state comes from the subscriptions table (written by the Stripe
// webhook), not from a plan string someone typed. Manual/comped accounts fall back
// to users.plan only when no subscription row exists at all.
function paidState(userId, settings) {
  ensureSchema();
  const s = settings || loadSettings();
  const db = getDb();
  const grace = (s.graceDays || 0) * 86400;
  let sub = null;
  try {
    sub = db.prepare(
      `SELECT plan, status, current_period_end, cancel_at_period_end, provider_sub_id
         FROM subscriptions
        WHERE user_id = ?
        ORDER BY COALESCE(current_period_end, 0) DESC
        LIMIT 1`
    ).get(userId) || null;
  } catch { sub = null; }
  const t = now();

  if (sub) {
    const end = Number(sub.current_period_end) || 0;
    const live = sub.status === 'active' || sub.status === 'trialing';
    const inGrace = end > 0 && t <= end + grace;
    const paid = live && end > 0 && t <= end + grace;
    let reason;
    if (paid) reason = sub.status === 'trialing' ? 'trialing subscription' : 'active subscription';
    else if (sub.status === 'past_due') reason = 'payment past due';
    else if (sub.status === 'cancelled') reason = inGrace ? 'cancelled — inside grace period' : 'subscription cancelled';
    else if (sub.status === 'expired' || (end > 0 && t > end + grace)) reason = 'subscription expired';
    else reason = `subscription status ${sub.status}`;
    return { paid, plan: sub.plan || null, status: sub.status, paidUntil: end || null, reason, source: 'stripe', cancelling: !!sub.cancel_at_period_end };
  }

  const user = findUser({ userId });
  const manual = user && (user.plan === 'pro' || user.plan === 'enterprise');
  if (manual) {
    return { paid: true, plan: user.plan, status: 'manual', paidUntil: null, reason: `plan set manually (${user.plan})`, source: 'users.plan' };
  }
  return { paid: false, plan: (user && user.plan) || 'free', status: 'none', paidUntil: null, reason: 'no subscription on record', source: 'none' };
}

// ── denials / strikes ───────────────────────────────────────────────────────────────

function activeDenial(ip) {
  ensureSchema();
  const db = getDb();
  const row = db.prepare('SELECT * FROM ip_denials WHERE ip = ?').get(String(ip || ''));
  if (!row) return null;
  if (row.until <= now()) {
    db.prepare('DELETE FROM ip_denials WHERE ip = ?').run(String(ip));
    return null;
  }
  return row;
}

function denyIp(ip, { minutes = 60, reason = '', surface = 'all', by = 'owner' } = {}) {
  ensureSchema();
  const db = getDb();
  const target = String(ip || '').trim();
  if (!target) throw new Error('ip is required');
  const createdAt = now();
  const until = createdAt + Math.max(1, Number(minutes) || 60) * 60;
  db.prepare(
    `INSERT INTO ip_denials (ip, reason, surface, created_at, until, created_by)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(ip) DO UPDATE SET reason = excluded.reason, surface = excluded.surface,
       until = excluded.until, created_by = excluded.created_by`
  ).run(target, String(reason || '').slice(0, 200), surface, createdAt, until, by);
  return { ip: target, until, minutes: Math.max(1, Number(minutes) || 60), reason, surface };
}

function undenyIp(ip) {
  ensureSchema();
  const db = getDb();
  const res = db.prepare('DELETE FROM ip_denials WHERE ip = ?').run(String(ip || ''));
  return res.changes > 0;
}

function listDenials() {
  ensureSchema();
  const db = getDb();
  const t = now();
  try { db.prepare('DELETE FROM ip_denials WHERE until <= ?').run(t); } catch {}
  return db.prepare('SELECT * FROM ip_denials ORDER BY until ASC').all();
}

function pruneStrikes() {
  const s = loadSettings();
  const cutoff = now() - (s.strikeWindowMinutes || 30) * 60;
  const db = getDb();
  try { db.prepare('DELETE FROM access_strikes WHERE at < ?').run(cutoff); } catch {}
  return cutoff;
}

function strike(ip, reason) {
  ensureSchema();
  const s = loadSettings();
  const db = getDb();
  const target = String(ip || '');
  if (!target || isPrivateOrLocal(target)) return { count: 0, denied: null, exempt: true };
  const o = loadOwners();
  if (o.ips.includes(target)) return { count: 0, denied: null, exempt: true };
  pruneStrikes();
  db.prepare('INSERT INTO access_strikes (ip, at, reason) VALUES (?, ?, ?)').run(target, now(), String(reason || '').slice(0, 120));
  const { c } = db.prepare('SELECT COUNT(*) AS c FROM access_strikes WHERE ip = ?').get(target);
  if (c >= (s.strikesToDeny || 5)) {
    const denied = denyIp(target, { minutes: s.ttlMinutes || 60, reason: `auto: ${c} unauthorized attempts (${reason})`, surface: 'auto', by: 'autoguard' });
    db.prepare('DELETE FROM access_strikes WHERE ip = ?').run(target);
    return { count: c, denied };
  }
  return { count: c, denied: null, exempt: false };
}

// ── the decision ────────────────────────────────────────────────────────────────────

/**
 * decide({ ip, user, route, surface, gated, paidOnly, ownerOnly })
 *   gated     = needs a signed-in account (a free account is fine)
 *   paidOnly  = needs a verified paid plan
 * returns { action: 'allow'|'challenge'|'deny'|'limited', reason, plan, paid, enforce }
 * 'challenge' = needs an account or an upgrade (401/402), 'limited' = allowed but degraded.
 */
function decide({ ip, user, route, surface = 'hakster', gated = false, paidOnly = false, ownerOnly = false } = {}) {
  const settings = loadSettings();
  const owners = loadOwners();
  const clientAddress = normalizeIp(ip);
  // Global mode is the kill switch; a surface must also opt in.
  const enforcementOn = settings.mode === 'enforce' && !!(settings.surfaces[surface] && settings.surfaces[surface].enforce);
  const base = { enforce: enforcementOn, mode: settings.mode };

  // An active denial wins over everything except the owner's own addresses.
  const denied = clientAddress ? activeDenial(clientAddress) : null;
  if (denied && !owners.ips.includes(clientAddress) && !user) {
    return { ...base, action: 'deny', reason: `IP denied until ${new Date(denied.until * 1000).toISOString()} — ${denied.reason}`, plan: null, paid: false };
  }

  if (isOwnerUser(user, owners) || (clientAddress && owners.ips.includes(clientAddress))) {
    return { ...base, action: 'allow', reason: 'owner', plan: (user && user.plan) || 'owner', paid: true };
  }

  if (user && (user.status === 'banned' || user.status === 'suspended')) {
    return { ...base, action: 'deny', reason: `account ${user.status}`, plan: user.plan, paid: false };
  }

  const state = user ? paidState(user.id, settings) : { paid: false, plan: 'free', reason: 'no account', paidUntil: null };

  if (ownerOnly) {
    if (enforcementOn) {
      strike(clientAddress, `owner-only route ${route}`);
      return { ...base, action: 'challenge', reason: 'owner-only route', plan: state.plan, paid: false };
    }
    return { ...base, action: 'allow', reason: 'observe: owner-only route would be refused', plan: state.plan, paid: false };
  }

  if (!gated && !paidOnly) {
    return { ...base, action: 'allow', reason: 'public route', plan: state.plan, paid: state.paid };
  }

  if (!user) {
    if (enforcementOn) strike(clientAddress, `unauthenticated ${paidOnly ? 'paid' : 'account'} route ${route}`);
    return { ...base, action: 'challenge', reason: `no account — sign in required${paidOnly ? ' (paid feature)' : ''}`, plan: null, paid: false };
  }

  if (state.paid) return { ...base, action: 'allow', reason: state.reason, plan: state.plan, paid: true };

  // Unpaid but has a real account.
  if (state.status === 'past_due') {
    return { ...base, action: 'limited', reason: 'payment past due — billing prompt', plan: state.plan, paid: false };
  }
  // An account-gated route is satisfied by ANY real account: free tier keeps its
  // documented allowance and is never kicked.
  if (gated && !paidOnly) {
    return { ...base, action: 'allow', reason: `account allowance — ${state.reason}`, plan: state.plan, paid: false };
  }
  if (enforcementOn) {
    return { ...base, action: 'challenge', reason: `plan not active — ${state.reason}`, plan: state.plan, paid: false };
  }
  return { ...base, action: 'allow', reason: `observe: paid route would need a plan — ${state.reason}`, plan: state.plan, paid: false };
}

// ── recording / reporting ───────────────────────────────────────────────────────────

function recordDecision({ ip, user, route, surface, action, reason, plan, paidUntil }) {
  ensureSchema();
  const db = getDb();
  try {
    const settings = loadSettings();
    db.prepare(
      `INSERT INTO access_decisions (at, ip, user_id, email, surface, route, action, reason, plan, paid_until, mode)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(now(), normalizeIp(ip), (user && user.id) || null, (user && user.email) || null,
      surface || null, String(route || '').slice(0, 120), action, String(reason || '').slice(0, 200),
      plan || null, paidUntil || null, settings.mode);
  } catch (e) { console.error('[accessguard] record failed:', e.message); }
}

function apiKeyFrom(req) {
  const h = (req && req.headers) || {};
  const auth = h['authorization'] || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  return h['x-api-key'] || bearer || (req && req.body && req.body.apiKey) || null;
}

function resolveRequestUser(req) {
  if (req && req.user) return req.user;
  const key = apiKeyFrom(req);
  return key ? findUser({ apiKey: key }) : null;
}

/**
 * Convenience middleware factory. Records meaningful decisions; only blocks when
 * the surface is enforcing. Never throws into the request path.
 * Volume control: every non-allow decision is recorded; plain allows are recorded
 * only on gated/paid/owner-only routes, so the table stays readable.
 */
function middleware({ surface = 'hakster', gatedRoutes = [], paidOnlyRoutes = [], ownerOnlyRoutes = [] } = {}) {
  const gatedSet = new Set(gatedRoutes);
  const paidSet = new Set(paidOnlyRoutes);
  const ownerSet = new Set(ownerOnlyRoutes);
  return function accessGuardMiddleware(req, res, next) {
    let d;
    try {
      const route = (req.originalUrl || req.url || '').split('?')[0];
      const ip = clientIp(req);
      const user = resolveRequestUser(req);
      const gated = gatedSet.has(route);
      const paidOnly = paidSet.has(route);
      const ownerOnly = ownerSet.has(route);
      d = decide({ ip, user, route, surface, gated, paidOnly, ownerOnly });
      if (d.action !== 'allow' || gated || paidOnly || ownerOnly) {
        recordDecision({ ip, user, route, surface, action: d.action, reason: d.reason, plan: d.plan, paidUntil: d.paid });
      }
      req.accessDecision = d;
    } catch (e) {
      console.error('[accessguard] decide failed:', e.message);
      return next();
    }
    if (!d.enforce) return next();
    if (d.action === 'deny') {
      return res.status(403).json({ error: 'access denied', reason: d.reason });
    }
    if (d.action === 'challenge') {
      return res.status(401).json({ error: 'sign in or upgrade required', reason: d.reason, plan: d.plan || 'free' });
    }
    return next();
  };
}

function summary(hours = 24) {
  ensureSchema();
  const db = getDb();
  const since = now() - hours * 3600;
  // Retention: the audit table keeps 90 days, then rolls off. Nothing else is removed.
  try { db.prepare('DELETE FROM access_decisions WHERE at < ?').run(now() - 90 * 86400); } catch {}
  const rows = db.prepare(
    `SELECT surface, action, COUNT(*) AS n FROM access_decisions WHERE at >= ? GROUP BY surface, action ORDER BY n DESC`
  ).all(since);
  const topIps = db.prepare(
    `SELECT ip, COUNT(*) AS n FROM access_decisions
      WHERE at >= ? AND action IN ('challenge','deny') AND ip <> '' GROUP BY ip ORDER BY n DESC LIMIT 8`
  ).all(since);
  const users = db.prepare(
    `SELECT email, action, COUNT(*) AS n FROM access_decisions
      WHERE at >= ? AND email IS NOT NULL AND action IN ('challenge','deny','limited')
      GROUP BY email, action ORDER BY n DESC LIMIT 8`
  ).all(since);
  return { hours, rows, topIps, users, denials: listDenials() };
}

function summaryText(hours = 24) {
  const s = loadSettings();
  const r = summary(hours);
  const lines = [`🔐 *Access guard* — last ${r.hours}h · mode *${s.mode}*`, ''];
  if (!r.rows.length) lines.push('No decisions recorded yet.');
  for (const row of r.rows) lines.push(`• ${row.surface || 'n/a'} · ${row.action}: ${row.n}`);
  const enforcing = Object.entries(s.surfaces || {}).filter(([, v]) => v.enforce).map(([k]) => k);
  lines.push('', `Enforcing: ${enforcing.length ? enforcing.join(', ') : 'none (observe mode)'}`);
  if (r.topIps.length) {
    lines.push('', 'Most challenged source IPs:');
    for (const i of r.topIps) lines.push(`  ${i.ip} — ${i.n}`);
  }
  if (r.users.length) {
    lines.push('', 'Accounts hitting limits:');
    for (const u of r.users) lines.push(`  ${u.email} — ${u.action} ×${u.n}`);
  }
  if (r.denials.length) {
    lines.push('', 'Active denials:');
    for (const d of r.denials) lines.push(`  ${d.ip} → ${new Date(d.until * 1000).toISOString().slice(0, 16)}Z (${d.reason})`);
  } else {
    lines.push('', 'No active IP denials.');
  }
  lines.push('', 'Free and trialing accounts are never auto-denied. Read-only unless a surface is enforcing.');
  return lines.join('\n');
}

function whoisText(ip) {
  ensureSchema();
  const db = getDb();
  const target = normalizeIp(ip);
  if (!target) return 'usage: /whois <ip>';
  const denial = activeDenial(target);
  const strikes = db.prepare('SELECT COUNT(*) AS n FROM access_strikes WHERE ip = ?').get(target);
  const rec = db.prepare(
    `SELECT at, surface, action, reason, email, plan FROM access_decisions WHERE ip = ? ORDER BY at DESC LIMIT 8`
  ).all(target);
  const lines = [`🔎 *${target}*`, ''];
  lines.push(denial ? `🚫 denied until ${new Date(denial.until * 1000).toISOString().slice(0, 16)}Z — ${denial.reason}` : '✅ no active denial');
  if (isPrivateOrLocal(target)) lines.push('(private/local address — exempt from automatic denial)');
  if (strikes.n) lines.push(`Strikes in window: ${strikes.n}`);
  if (!rec.length) {
    lines.push('', 'No recorded decisions for this address.');
  } else {
    lines.push('', 'Recent decisions (newest first):');
    for (const r of rec) lines.push(`  ${new Date(r.at * 1000).toISOString().slice(5, 16).replace('T', ' ')} ${r.action} · ${r.route || r.surface || ''} · ${r.reason || ''}`);
  }
  return lines.join('\n');
}

function accessText(needle) {
  const user = findUser({ email: needle }) || findUser({ userId: needle });
  if (!user) return `No account found for "${needle}".`;
  const state = paidState(user.id);
  const owners = loadOwners();
  const lines = [
    `👤 *${user.email || user.username}*  (${user.role}, ${user.status})`,
    '',
    `Plan column: ${user.plan}`,
    `Verified paid: ${state.paid ? '✅ yes' : '❌ no'} — ${state.reason}`,
    `Source: ${state.source}`,
  ];
  if (state.paidUntil) lines.push(`Paid through: ${new Date(state.paidUntil * 1000).toISOString().slice(0, 10)}`);
  if (state.cancelling) lines.push('⚠️ set to cancel at period end');
  if (isOwnerUser(user, owners)) lines.push('👑 owner — never blocked');
  lines.push('', 'Access is decided from the subscriptions row the Stripe webhook writes, not from the plan column alone.');
  return lines.join('\n');
}

function setMode(mode, surface) {
  const m = String(mode || '').toLowerCase();
  if (!['observe', 'enforce'].includes(m)) return `mode must be observe or enforce (got "${mode}")`;
  const s = loadSettings();
  if (surface && s.surfaces[surface]) {
    s.surfaces[surface].enforce = m === 'enforce';
    // Turning a surface on implies the global switch; turning it off leaves the
    // global switch alone so other enforcing surfaces keep working.
    saveSettings({ surfaces: s.surfaces, ...(m === 'enforce' ? { mode: 'enforce' } : {}) });
    return `surface ${surface} → ${m === 'enforce' ? 'ENFORCING' : 'observing'}`;
  }
  saveSettings({ mode: m });
  return `access guard → ${m === 'enforce' ? 'ENFORCING (surfaces still need their own flag)' : 'observing'}`;
}

// ── PhantomIDE (Parrot) ─────────────────────────────────────────────────────────
// PhantomIDE runs its own guard inside phantom-server.js with its own Postgres users
// table, so it cannot be queried from this process. It is read over ssh instead: a
// read-only status call, no tokens, nothing written on either box.

function phantomGuardText(hours = 24) {
  return new Promise((resolve) => {
    const cmd = `node /home/ghost694/phantom-guard.js --status --hours ${Math.max(1, Math.min(720, Number(hours) || 24))}`;
    execFile('ssh', [
      '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=6', '-o', 'StrictHostKeyChecking=accept-new',
      'ghost694@parrot', cmd,
    ], { timeout: 25000, maxBuffer: 512 * 1024 }, (err, stdout) => {
      const out = String(stdout || '').trim();
      if (out) return resolve(out.slice(0, 2500));
      const why = String((err && err.message) || 'no output').split('\n')[0].slice(0, 90);
      resolve(`🔐 PhantomIDE access guard — unreachable over ssh (${why})`);
    });
  });
}

module.exports = {
  DEFAULTS,
  phantomGuardText,
  loadSettings,
  saveSettings,
  setMode,
  loadOwners,
  saveOwners,
  addOwner,
  removeOwner,
  clientIp,
  normalizeIp,
  isPrivateOrLocal,
  isLoopback,
  resolveRequestUser,
  apiKeyFrom,
  findUser,
  paidState,
  isOwnerUser,
  activeDenial,
  denyIp,
  undenyIp,
  listDenials,
  strike,
  decide,
  recordDecision,
  middleware,
  summary,
  summaryText,
  whoisText,
  accessText,
  SETTINGS_FILE,
  OWNER_FILE,
};

if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  const out = (x) => console.log(typeof x === 'string' ? x : JSON.stringify(x, null, 2));
  try {
    if (cmd === '--summary') out(summaryText(Number(rest[0]) || 24));
    else if (cmd === '--whois') out(whoisText(rest[0]));
    else if (cmd === '--access') out(accessText(rest[0]));
    else if (cmd === '--deny') out(denyIp(rest[0], { minutes: Number(rest[1]) || 60, reason: rest.slice(2).join(' ') || 'manual' }));
    else if (cmd === '--undeny') out(undenyIp(rest[0]) ? `removed ${rest[0]}` : `${rest[0]} was not denied`);
    else if (cmd === '--denials') out(listDenials());
    else if (cmd === '--mode') out(setMode(rest[0], rest[1]));
    else if (cmd === '--owner-add') out(addOwner({ email: rest[0], ip: rest[1] }));
    else if (cmd === '--settings') out(loadSettings());
    else out('usage: accessGuard.js --summary [hours] | --whois <ip> | --access <email> | --deny <ip> [min] [reason] | --undeny <ip> | --denials | --mode observe|enforce [surface] | --owner-add <email> [ip] | --settings');
  } catch (e) {
    console.error('access guard failed:', e.message);
    process.exit(1);
  }
}
