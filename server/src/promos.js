// ── Win-back promos ────────────────────────────────────────────────────────
// Owner, 2026-11-21: "always have agents have promo deal to suck users back in."
//
// One active deal lives in data/promos.json so the owner can change it without
// touching code, and every agent reads promoLine() so it always has an offer
// ready instead of inventing one. A redemption grants AI-call credits — the
// same unit the Try Me Now and Token Pack products sell — so a win-back costs
// us calls, never a plan change and never a made-up percentage discount
// (§19: nothing here bills anyone or edits the AI setup).
//
// Truth rules enforced here:
//   • a promo only counts when active AND inside its date window;
//   • a redemption is one per account per promo, recorded in promo_redemptions;
//   • an expired or missing promo yields no line, so an agent says nothing
//     rather than quoting a deal that has ended.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PROMO_FILE = path.join(__dirname, '../../data/promos.json');

// Seeded once. $0 cost to serve at this size: 10 calls x $0.00208 = ~2c.
const DEFAULT_PROMOS = {
  currency: 'calls',
  promos: [
    {
      id: 'winback_2026_11',
      code: 'COMEBACK10',
      label: 'Come back and get 10 free AI calls',
      credits: 10,
      audience: 'quiet-accounts',
      quietDays: 14,
      active: true,
      startsAt: '2026-11-21',
      endsAt: null,
      maxRedemptions: null,
      message:
        'Any account that has been quiet for 14 days or more can take 10 free AI calls, once. '
        + 'Credits are drawn after the plan allowance, never expire, and change no plan.',
    },
  ],
};

let _cache = { at: 0, data: null };
const CACHE_TTL = 30000;

function loadPromos() {
  const now = Date.now();
  if (_cache.data && now - _cache.at < CACHE_TTL) return _cache.data;
  let data = null;
  try {
    if (fs.existsSync(PROMO_FILE)) {
      data = JSON.parse(fs.readFileSync(PROMO_FILE, 'utf8'));
    } else {
      fs.mkdirSync(path.dirname(PROMO_FILE), { recursive: true });
      fs.writeFileSync(PROMO_FILE, JSON.stringify(DEFAULT_PROMOS, null, 2));
      data = DEFAULT_PROMOS;
      console.log('[promos] seeded ' + PROMO_FILE);
    }
  } catch (err) {
    console.warn('[promos] could not read ' + PROMO_FILE + ':', err.message);
    data = DEFAULT_PROMOS;
  }
  if (!data || !Array.isArray(data.promos)) data = DEFAULT_PROMOS;
  _cache = { at: now, data };
  return data;
}

function inWindow(promo, nowMs = Date.now()) {
  if (!promo || promo.active !== true) return false;
  const start = promo.startsAt ? Date.parse(promo.startsAt) : null;
  const end = promo.endsAt ? Date.parse(promo.endsAt) : null;
  if (start && Number.isFinite(start) && nowMs < start) return false;
  if (end && Number.isFinite(end) && nowMs > end) return false;
  return true;
}

function activePromos() {
  return loadPromos().promos.filter(p => inWindow(p));
}

function activePromo() {
  return activePromos()[0] || null;
}

function publicPromo(p) {
  if (!p) return null;
  return {
    id: p.id,
    code: p.code,
    label: p.label,
    credits: p.credits,
    audience: p.audience || 'all',
    quietDays: p.quietDays || null,
    startsAt: p.startsAt || null,
    endsAt: p.endsAt || null,
    message: p.message || '',
  };
}

// The single line an agent can always say. Empty string when no promo is live,
// so a caller can skip the sentence entirely.
function promoLine() {
  const p = activePromo();
  if (!p) return '';
  const until = p.endsAt ? ` Ends ${String(p.endsAt).slice(0, 10)}.` : '';
  return `Current promo: ${p.label} — code ${p.code}. ${p.message}${until}`.trim();
}

function ensureRedemptionTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS promo_redemptions (
    id         TEXT PRIMARY KEY,
    promo_id   TEXT NOT NULL,
    code       TEXT,
    user_id    TEXT NOT NULL,
    credits    INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_promo_redemption_once ON promo_redemptions(promo_id, user_id)');
}

/**
 * Redeem a promo code for a user.
 * @param {object} db better-sqlite3 handle
 * @param {object} user users row (needs id)
 * @param {string} rawCode the code the user typed
 * @param {function} grantCredits (db, userId, count, reason, ref) => newBalance
 * @returns {{ok:boolean, credits?:number, balance?:number, promo?:object, error?:string}}
 */
function redeemPromo(db, user, rawCode, grantCredits) {
  if (!user?.id) return { ok: false, error: 'Sign in first, then redeem the promo.' };
  const code = String(rawCode || '').trim().toUpperCase();
  if (!code) return { ok: false, error: 'Enter the promo code.' };
  const promo = loadPromos().promos.find(p => String(p.code || '').toUpperCase() === code);
  if (!promo) return { ok: false, error: 'That promo code is not recognised.' };
  if (!inWindow(promo)) return { ok: false, error: 'That promo has ended.' };

  ensureRedemptionTable(db);
  const already = db.prepare('SELECT id FROM promo_redemptions WHERE promo_id = ? AND user_id = ?').get(promo.id, user.id);
  if (already) return { ok: false, error: 'You have already taken this promo.', promo: publicPromo(promo) };

  const credits = Math.max(0, Math.round(Number(promo.credits) || 0));
  if (!credits) return { ok: false, error: 'That promo has nothing to grant.', promo: publicPromo(promo) };

  if (promo.maxRedemptions) {
    const taken = db.prepare('SELECT COUNT(*) AS n FROM promo_redemptions WHERE promo_id = ?').get(promo.id)?.n || 0;
    if (taken >= promo.maxRedemptions) return { ok: false, error: 'That promo has been fully claimed.', promo: publicPromo(promo) };
  }

  const id = 'pr_' + crypto.randomBytes(12).toString('hex');
  const apply = db.transaction(() => {
    db.prepare('INSERT INTO promo_redemptions (id, promo_id, code, user_id, credits) VALUES (?, ?, ?, ?, ?)')
      .run(id, promo.id, promo.code, user.id, credits);
    return grantCredits(db, user.id, credits, 'promo:' + promo.id, id);
  });
  let balance;
  try {
    balance = apply();
  } catch (err) {
    if (String(err.message || '').includes('UNIQUE')) return { ok: false, error: 'You have already taken this promo.', promo: publicPromo(promo) };
    throw err;
  }
  return { ok: true, credits, balance, promo: publicPromo(promo) };
}

module.exports = { loadPromos, activePromos, activePromo, publicPromo, promoLine, redeemPromo, inWindow, PROMO_FILE };
