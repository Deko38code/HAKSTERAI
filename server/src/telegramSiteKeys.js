'use strict';
/**
 * haksterAI — owner self-service site API keys + purchase ledger, driven from the
 * Telegram fleet.
 *
 * Scope and safety:
 *   * Every command here is owner-only. "Owner" means the chat is the fleet's own
 *     TELEGRAM_OWNER_CHAT (the DM the bots already deliver reports to) — a stranger
 *     who finds a bot cannot mint keys.
 *   * Keys are generated here, written to users.api_key for the single owner
 *     account, and mirrored into api_key_audit plus an append-only JSONL log so a
 *     rotation is always recoverable and attributable.
 *   * Nothing is printed into logs, and every message shows a masked key except the
 *     one delivery that hands the owner the new value.
 *   * This module never creates Telegram bots. BotFather has no public API; see
 *     docs in telegram-fleet.js for the supported half of that workflow.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getDb } = require('./db');

const OWNER_EMAIL = String(process.env.OWNER_EMAIL || 'dekekenneth840@gmail.com').toLowerCase();
const OWNER_CHAT = String(process.env.TELEGRAM_OWNER_CHAT || '').trim();
const DATA_DIR = path.join(__dirname, '..', 'data');
const PURCHASE_LOG = path.join(DATA_DIR, 'purchase-log.jsonl');
const KEY_LOG = path.join(DATA_DIR, 'site-key-log.jsonl');
const KEY_PREFIX = 'hkai_';

function mask(key) {
  if (!key) return '(none)';
  const s = String(key);
  if (s.length <= 12) return '••••';
  return `${s.slice(0, 9)}…${s.slice(-4)}`;
}

function isOwnerChat(chatId) {
  if (!OWNER_CHAT) return false;
  return String(chatId) === OWNER_CHAT;
}

function ownerUser() {
  try {
    return getDb().prepare('SELECT * FROM users WHERE lower(email) = ?').get(OWNER_EMAIL) || null;
  } catch (e) {
    console.error('[sitekeys] owner lookup failed:', e.message);
    return null;
  }
}

function appendJsonl(file, record) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(record) + '\n');
    return true;
  } catch (e) {
    console.error('[sitekeys] log append failed:', e.message);
    return false;
  }
}

function generateKey() {
  return KEY_PREFIX + crypto.randomBytes(24).toString('hex');
}

/** Rotate (or first-time issue) the owner's site API key. Returns the live key once. */
function createSiteKey({ label = 'owner-bot', performedBy = 'telegram-bot' } = {}) {
  const user = ownerUser();
  if (!user) return { ok: false, error: `owner account ${OWNER_EMAIL} was not found` };
  const db = getDb();
  const oldKey = user.api_key || null;
  const newKey = generateKey();
  const now = Math.floor(Date.now() / 1000);
  const action = oldKey ? 'rotate' : 'create';
  try {
    const tx = db.transaction(() => {
      db.prepare('UPDATE users SET api_key = ?, updated_at = ? WHERE id = ?').run(newKey, now, user.id);
      db.prepare(`INSERT INTO api_key_audit (user_id, action, old_key, new_key, reason, performed_by)
                  VALUES (?, ?, ?, ?, ?, ?)`)
        .run(user.id, action, mask(oldKey), mask(newKey), `telegram bot /key (${label})`, performedBy);
    });
    tx();
  } catch (e) {
    return { ok: false, error: `key write failed: ${e.message}` };
  }
  appendJsonl(KEY_LOG, {
    at: new Date().toISOString(),
    action,
    user_id: user.id,
    email: user.email,
    old_key: mask(oldKey),
    new_key: mask(newKey),
    label,
    performed_by: performedBy,
  });
  return { ok: true, key: newKey, action, old: mask(oldKey), userId: user.id, createdAt: now };
}

function keyInfo() {
  const user = ownerUser();
  if (!user) return { ok: false, error: 'owner account not found' };
  let audit = [];
  try {
    audit = getDb()
      .prepare('SELECT action, old_key, new_key, reason, performed_by, created_at FROM api_key_audit WHERE user_id = ? ORDER BY created_at DESC LIMIT 5')
      .all(user.id);
  } catch (e) {
    console.error('[sitekeys] audit read failed:', e.message);
  }
  return { ok: true, current: mask(user.api_key), hasKey: Boolean(user.api_key), userId: user.id, email: user.email, audit };
}

/** Append-only purchase record. Called from the Stripe webhook on first application. */
function logPurchase(record = {}) {
  const entry = {
    at: new Date().toISOString(),
    source: record.source || 'stripe',
    event: record.event || 'checkout.paid',
    payment_id: record.paymentId || null,
    provider_id: record.providerId || null,
    user_id: record.userId || null,
    email: record.email || null,
    plan: record.plan || null,
    billing_cycle: record.billingCycle || null,
    amount: record.amount ?? null,
    currency: record.currency || null,
    mode: record.mode || null,
    subscription_id: record.subscriptionId || null,
    note: record.note || null,
  };
  const saved = appendJsonl(PURCHASE_LOG, entry);
  return { ok: saved, path: PURCHASE_LOG, entry };
}

function recentPurchases(limit = 10) {
  try {
    return getDb()
      .prepare(`SELECT p.id, p.amount, p.currency, p.plan, p.billing_cycle, p.status, p.provider_id,
                       COALESCE(u.email, '') email, p.created_at, p.completed_at
                FROM payments p LEFT JOIN users u ON u.id = p.user_id
                ORDER BY p.created_at DESC LIMIT ?`)
      .all(Math.max(1, Math.min(50, Number(limit) || 10)));
  } catch (e) {
    console.error('[sitekeys] purchase read failed:', e.message);
    return [];
  }
}

function money(amount, currency) {
  if (amount === null || amount === undefined) return '—';
  const code = String(currency || 'usd').toUpperCase();
  const value = Number(amount);
  // Stripe stores cents; the bot never guesses a unit it was not given.
  const human = Number.isFinite(value) && value >= 100 ? (value / 100).toFixed(2) : String(value);
  return `${code} ${human}`;
}

/**
 * Handles /key, /apikey, /keys, /keyinfo and /purchases.
 * Returns true when the message was ours, so the fleet skips its normal routing.
 */
async function handleSiteKeyCommand({ text, chatId, bot, roleKey }) {
  const raw = String(text || '').trim();
  if (!/^\/(key|keys|apikey|keyinfo|purchases|payments)\b/i.test(raw)) return false;

  const send = async (msg, extra = {}) => {
    try { await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown', disable_web_page_preview: true, ...extra }); }
    catch (_) { try { await bot.sendMessage(chatId, msg); } catch (_) {} }
  };

  if (!isOwnerChat(chatId)) {
    // Do not hint at what exists; one neutral line and stop.
    await send('⛔ That command is owner-only.');
    return true;
  }

  const parts = raw.split(/\s+/);
  const command = parts[0] || '';      // "/key" — split() keeps it at index 0
  const rest = parts.slice(1);
  const tail = rest.join(' ').trim().toLowerCase();

  if (/^\/(key|apikey|keyinfo)$/i.test(command) && tail !== 'new' && !tail) {
    const info = keyInfo();
    if (!info.ok) { await send(`⚠️ ${info.error}`); return true; }
    const last = info.audit[0];
    await send([
      '🔑 *Site API key*',
      `Account: ${info.email}`,
      `Current: \`${info.current}\``,
      last ? `Last ${last.action}: ${new Date(last.created_at * 1000).toISOString()} by ${last.performed_by}` : 'No rotations recorded yet.',
      '',
      '`/key new [label]` — rotate and show the new key',
      '`/purchases` — recent paid records',
    ].join('\n'));
    return true;
  }

  if (/^\/(key|apikey)\s+new\b/i.test(raw) || /\bnew\b/.test(tail)) {
    const label = rest.filter(w => !/^new$/i.test(w)).join(' ').slice(0, 60) || 'owner-bot';
    const created = createSiteKey({ label, performedBy: `telegram:${roleKey || 'fleet'}` });
    if (!created.ok) { await send(`⚠️ ${created.error}`); return true; }
    await send([
      `🔑 *New site API key* (${created.action})`,
      `\`${created.key}\``,
      '',
      `Previous: ${created.old}`,
      'This message is the only place the full key appears. It is logged masked in api_key_audit and data/site-key-log.jsonl.',
    ].join('\n'));
    return true;
  }

  if (/^\/(keys)$/i.test(command)) {
    const info = keyInfo();
    if (!info.ok) { await send(`⚠️ ${info.error}`); return true; }
    const rows = info.audit.map(a => `• ${a.action} ${new Date(a.created_at * 1000).toISOString().slice(0, 16)} → ${a.new_key}`).join('\n');
    await send(['🔑 *Key history*', `Current: \`${info.current}\``, rows || 'No history yet.'].join('\n'));
    return true;
  }

  if (/^\/(purchases|payments)\b/i.test(command)) {
    const rows = recentPurchases(10);
    if (!rows.length) { await send('🧾 No payments recorded yet.'); return true; }
    const body = rows.map(r => `• ${money(r.amount, r.currency)} · ${r.plan || '—'} · ${r.status} · ${r.email || 'n/a'} · ${new Date((r.completed_at || r.created_at) * 1000).toISOString().slice(0, 16)}`).join('\n');
    await send(['🧾 *Recent purchases*', body, '', `Ledger file: \`${path.relative(process.cwd(), PURCHASE_LOG)}\``].join('\n'));
    return true;
  }

  await send('Usage:\n`/key` — show current key\n`/key new [label]` — rotate\n`/keys` — history\n`/purchases` — recent payments');
  return true;
}

module.exports = {
  handleSiteKeyCommand,
  createSiteKey,
  keyInfo,
  logPurchase,
  recentPurchases,
  isOwnerChat,
  // Exported so the per-chat entitlement gate can charge the owner's own chat to
  // the owner's account instead of the shared fleet key.
  ownerUser,
  paths: { PURCHASE_LOG, KEY_LOG },
};
