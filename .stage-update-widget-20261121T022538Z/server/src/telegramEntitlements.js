'use strict';
/**
 * haksterAi — Telegram per-chat entitlements.
 *
 * Why this module exists:
 *   The fleet used to answer every chat with one shared enterprise key
 *   (HAKSTER_API_KEY). Anyone who found a bot got unlimited agent runs and web
 *   research, nothing was metered against their own account, and the usage /
 *   credit monitor had no idea the usage happened at all.
 *
 * What it does now:
 *   * Resolves the Telegram chat to its own HaksterAI account (users.telegram_id).
 *   * Reads that account's real allowance from the live /api/usage counters, so
 *     Telegram and the website share ONE meter — no second, drifting limit.
 *   * Paid plans (pro / enterprise / starter) are unmetered; free and lite use
 *     the same free-call and web-research counters the site enforces.
 *   * A chat with no account, an inactive account, or an exhausted allowance is
 *     told plainly to upgrade, and the real Stripe plan picker is offered.
 *
 * Safety:
 *   * Owner chat is never gated.
 *   * Read-only: this module never writes usage counters. The agent endpoint
 *     (/api/agent/run) and Miniforge's builder are what consume a credit, so a
 *     refusal here can never double-charge an account.
 *   * No key, token or chat id is ever logged or printed.
 */

const fs = require('fs');
const path = require('path');
const { getDb } = require('./db');
const siteKeys = require('./telegramSiteKeys');

const DATA_DIR = path.join(__dirname, '..', 'data');
const ENTITLEMENT_LOG = path.join(DATA_DIR, 'telegram-entitlements.jsonl');
const SERVER_PORT = parseInt(process.env.PORT || '3579', 10);
const SITE_URL = 'https://haksterai.com';

// Same plan sets the website uses (index.js: PAID_PLAN_IDS / paid tiers), kept
// in one place here so the bot gate and the site can never disagree about who
// is paying. 'lite' is a capped paid plan: it passes the plan check but still
// stops at LITE limits (30 calls / 10 lookups a month).
const PAID_PLANS = new Set(['lite', 'starter', 'starter_plus', 'pro', 'enterprise']);
const UNLIMITED_PLANS = new Set(['starter', 'starter_plus', 'pro', 'enterprise']);
const FREE_CALL_LIMIT = 5;
const LITE_CALL_LIMIT = 30;
const FREE_WEB_LIMIT = 5;
const LITE_WEB_LIMIT = 10;

function appendJsonl(file, record) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(record) + '\n');
    return true;
  } catch (e) {
    console.error('[entitlements] log append failed:', e.message);
    return false;
  }
}

function userForChat(chatId) {
  const chat = String(chatId || '').trim();
  if (!chat) return null;
  try {
    return getDb().prepare('SELECT * FROM users WHERE telegram_id = ?').get(chat) || null;
  } catch (e) {
    console.error('[entitlements] user lookup failed:', e.message);
    return null;
  }
}

function ownerAccount() {
  try { return siteKeys.ownerUser(); } catch (_) { return null; }
}

function ownerApiKey() {
  const owner = ownerAccount();
  return String((owner && owner.api_key) || process.env.HAKSTER_API_KEY || '');
}

// Local fallback when the live counters cannot be read (server busy, restarting).
// Same numbers the site would show: capped plans get their limit, everything
// else is unlimited. Never stricter than the site, so a blip cannot lock out a
// paying customer.
function localAllowance(user) {
  const plan = String((user && user.plan) || 'free').toLowerCase();
  if (UNLIMITED_PLANS.has(plan)) {
    return { plan, limit: -1, remaining: -1, webLimit: -1, webRemaining: -1, source: 'local' };
  }
  const limit = plan === 'lite' ? LITE_CALL_LIMIT : FREE_CALL_LIMIT;
  const webLimit = plan === 'lite' ? LITE_WEB_LIMIT : FREE_WEB_LIMIT;
  const used = Math.max(0, Number(user && user.usage_count) || 0);
  return {
    plan,
    limit,
    remaining: Math.max(0, limit - used),
    webLimit,
    webRemaining: webLimit, // web uses live in their own table; checked live only
    source: 'local',
  };
}

// The live meter. /api/usage answers with the account's real plan, call
// remaining and web-research remaining — the exact numbers the site shows.
async function liveAllowance(apiKey) {
  const key = String(apiKey || '');
  if (!/^hkai_[A-Za-z0-9]+$/.test(key)) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/usage`, {
      headers: { 'x-api-key': key, accept: 'application/json' },
      signal: AbortSignal.timeout(6000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return null;
    return {
      plan: String(data.plan || 'free').toLowerCase(),
      limit: Number.isFinite(Number(data.limit)) ? Number(data.limit) : -1,
      remaining: Number.isFinite(Number(data.remaining)) ? Number(data.remaining) : -1,
      webLimit: Number.isFinite(Number(data.webResearchLimit)) ? Number(data.webResearchLimit) : -1,
      webRemaining: Number.isFinite(Number(data.webResearchRemaining)) ? Number(data.webResearchRemaining) : -1,
      source: 'live',
    };
  } catch (_) {
    return null;
  }
}

/**
 * Resolve one chat's right to use the paid surfaces (agent chat, web tools,
 * app builds). Never throws: a failed lookup returns a refusal with a reason
 * instead of an exception in the middle of a bot handler.
 *
 * @param {string|number} chatId
 * @returns {Promise<{allowed:boolean, isOwner:boolean, plan:string, reason:string,
 *                    apiKey:string, user:object|null, limit:number, remaining:number,
 *                    webLimit:number, webRemaining:number, source:string}>}
 */
async function chatEntitlement(chatId) {
  const chat = String(chatId || '').trim();
  if (siteKeys.isOwnerChat(chat)) {
    return {
      allowed: true, isOwner: true, plan: 'owner', reason: 'owner chat',
      apiKey: ownerApiKey(), user: ownerAccount(),
      limit: -1, remaining: -1, webLimit: -1, webRemaining: -1, source: 'owner',
    };
  }

  const user = userForChat(chat);
  if (!user) {
    return {
      allowed: false, isOwner: false, plan: 'none', reason: 'no account',
      apiKey: '', user: null, limit: 0, remaining: 0, webLimit: 0, webRemaining: 0, source: 'none',
    };
  }
  if (user.status && user.status !== 'active') {
    return {
      allowed: false, isOwner: false, plan: String(user.plan || 'free'), reason: 'account not active',
      apiKey: String(user.api_key || ''), user, limit: 0, remaining: 0, webLimit: 0, webRemaining: 0, source: 'local',
    };
  }
  const apiKey = String(user.api_key || '');
  if (!/^hkai_[A-Za-z0-9]+$/.test(apiKey)) {
    return {
      allowed: false, isOwner: false, plan: String(user.plan || 'free'), reason: 'no site key',
      apiKey: '', user, limit: 0, remaining: 0, webLimit: 0, webRemaining: 0, source: 'local',
    };
  }

  const allowance = (await liveAllowance(apiKey)) || localAllowance(user);
  const unlimited = allowance.limit === -1;
  const allowed = unlimited || allowance.remaining > 0;
  return {
    allowed,
    isOwner: false,
    plan: allowance.plan,
    reason: allowed ? 'allowance available' : 'allowance used up',
    apiKey,
    user,
    limit: allowance.limit,
    remaining: allowance.remaining,
    webLimit: allowance.webLimit,
    webRemaining: allowance.webRemaining,
    source: allowance.source,
  };
}

function planLabel(plan) {
  const value = String(plan || 'free');
  return value === 'none' ? 'no plan yet' : value.toUpperCase();
}

function allowanceLine(ent) {
  if (ent.limit === -1) return `Plan: ${planLabel(ent.plan)} · unlimited agent use`;
  const used = Math.max(0, Number(ent.limit) - Math.max(0, Number(ent.remaining)));
  return `Plan: ${planLabel(ent.plan)} · ${Math.max(0, Number(ent.remaining))} of ${ent.limit} agent runs left · ${used} used`;
}

// One plain refusal sentence per reason. No internal paths, keys or ids.
function refusalText(ent) {
  switch (ent.reason) {
    case 'no account':
      return [
        '🔒 HaksterAI bots run on your own paid account.',
        '',
        `Open ${SITE_URL} and sign in with Google once, link this Telegram chat, then pick a plan. Until then this chat has no allowance to draw from.`,
      ].join('\n');
    case 'account not active':
      return `🔒 This account is not active (plan: ${planLabel(ent.plan)}). Reactivate it at ${SITE_URL}/plans to keep using the bots.`;
    case 'no site key':
      return `🔒 This account has no site key to charge usage to. Sign in at ${SITE_URL} once to issue one, then try again.`;
    case 'allowance used up':
    default:
      return [
        `🔒 You have used all ${ent.limit} runs on your ${planLabel(ent.plan)} allowance.`,
        '',
        'Upgrade and the bots, web research and app builds keep working — usage stays on this same account.',
      ].join('\n');
  }
}

/**
 * Send the upgrade prompt (text + the real Stripe plan picker). Returns true
 * when the chat got the prompt. Never invents a price: the picker loads the
 * live plan catalog.
 */
async function sendUpgradePrompt({ bot, chatId, ent, sendPlanPicker }) {
  if (!bot) return false;
  const text = `${refusalText(ent)}\n\n${ent.reason === 'allowance used up' ? allowanceLine(ent) : `Plan: ${planLabel(ent.plan)}`}`;
  try { await bot.sendMessage(chatId, text); } catch (e) {
    console.error('[entitlements] refusal message failed:', e.message);
    return false;
  }
  if (typeof sendPlanPicker === 'function') {
    try { await sendPlanPicker(bot, chatId); } catch (e) {
      console.error('[entitlements] plan picker failed:', e.message);
    }
  }
  return true;
}

// ── Owner visibility ────────────────────────────────────────────────
// An upgrade refusal is worth one line on the owner's phone the first time it
// happens to a chat each day — not on every message, and never with a key.
function alertOwnerOnce(chatId, reason, plan) {
  const day = new Date().toISOString().slice(0, 10);
  try {
    const db = getDb();
    db.exec(`CREATE TABLE IF NOT EXISTS telegram_entitlement_alerts (
      chat_id TEXT NOT NULL,
      day     TEXT NOT NULL,
      reason  TEXT,
      plan    TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (chat_id, day)
    )`);
    const insert = db.prepare('INSERT OR IGNORE INTO telegram_entitlement_alerts (chat_id, day, reason, plan) VALUES (?, ?, ?, ?)');
    if (!insert.run(String(chatId), day, String(reason || ''), String(plan || '')).changes) return false;
  } catch (e) {
    console.error('[entitlements] alert dedupe failed:', e.message);
    return false;
  }
  try {
    const chat = String(process.env.TELEGRAM_OWNER_CHAT || '').trim();
    if (!chat) return false;
    require('./telegramBots').notifyTelegramChat(chat, `🔔 Upgrade prompt shown — plan "${plan || 'none'}" (${reason || 'no reason'}). The chat was given the plan picker.`).catch(() => {});
    return true;
  } catch (_) { return false; }
}

/**
 * Log a refusal and (best-effort) tell the owner once per chat per day.
 * Never surfaces the chat id in the message text.
 */
function noteRefusal({ chatId, ent, surface }) {
  appendJsonl(ENTITLEMENT_LOG, {
    at: new Date().toISOString(),
    event: 'entitlement.refused',
    surface: surface || 'agent',
    chat_id: String(chatId || ''),
    plan: ent && ent.plan,
    reason: ent && ent.reason,
    user_id: ent && ent.user ? ent.user.id : null,
    limit: ent && ent.limit,
    remaining: ent && ent.remaining,
  });
  alertOwnerOnce(chatId, ent && ent.reason, ent && ent.plan);
}

module.exports = {
  chatEntitlement,
  sendUpgradePrompt,
  noteRefusal,
  refusalText,
  allowanceLine,
  planLabel,
  userForChat,
  ownerApiKey,
  PAID_PLANS,
  UNLIMITED_PLANS,
  ENTITLEMENT_LOG,
};
