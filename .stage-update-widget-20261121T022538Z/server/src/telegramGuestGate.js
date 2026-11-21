'use strict';
/**
 * haksterAI — Telegram guest gate: keeps unwanted accounts out of the owner's
 * groups and channels using Telegram's own identity (stable user id), not IPs —
 * Telegram never gives a bot an IP address, so the account id plus membership is
 * the identity we can actually enforce.
 *
 * What it does:
 *   * chat_join_request → approve only accounts on the allowlist, decline the
 *     rest (works when the group/channel requires join approval).
 *   * new_chat_members → if the gate is on and someone not allowlisted joins a
 *     group where the bot is admin, ban them and post one short note.
 *   * /allow, /deny, /kick, /allowlist, /requests, /gate on|off — owner-only from
 *     any fleet bot.
 *
 * Safety:
 *   * The gate ships OFF. Nothing is ever declined or banned until the owner
 *     turns it on with /gate on.
 *   * The owner's own chat can never be gated.
 *   * Every decision is appended to data/telegram-gate-log.jsonl.
 *   * If the bot lacks admin rights Telegram answers 400; that is reported, not
 *     retried in a loop.
 */

const fs = require('fs');
const path = require('path');
const { getDb } = require('./db');
const siteKeys = require('./telegramSiteKeys');

const DATA_DIR = path.join(__dirname, '..', 'data');
const GATE_LOG = path.join(DATA_DIR, 'telegram-gate-log.jsonl');
let _ready = false;

function ensure() {
  if (_ready) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS telegram_access (
      telegram_id TEXT PRIMARY KEY,
      status      TEXT NOT NULL CHECK (status IN ('allowed','denied')),
      note        TEXT,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS telegram_gate_settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);
  _ready = true;
}

function logEvent(record) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(GATE_LOG, JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n');
  } catch (e) { console.error('[gate] log append failed:', e.message); }
}

function getSetting(key, fallback) {
  ensure();
  const row = getDb().prepare('SELECT value FROM telegram_gate_settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  ensure();
  getDb().prepare(`INSERT INTO telegram_gate_settings (key, value, updated_at) VALUES (?, ?, unixepoch())
                   ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()`)
    .run(key, String(value));
}

function gateEnabled() {
  return String(getSetting('gate', 'off')) === 'on';
}

function accessRow(id) {
  ensure();
  return getDb().prepare('SELECT * FROM telegram_access WHERE telegram_id = ?').get(String(id)) || null;
}

function isAllowed(id) {
  const row = accessRow(id);
  return Boolean(row && row.status === 'allowed');
}

function setAccess(id, status, note = '') {
  ensure();
  getDb().prepare(`INSERT INTO telegram_access (telegram_id, status, note, created_at) VALUES (?, ?, ?, unixepoch())
                   ON CONFLICT(telegram_id) DO UPDATE SET status = excluded.status, note = excluded.note`)
    .run(String(id), status, note);
  logEvent({ event: 'access.' + status, telegram_id: String(id), note });
  return accessRow(id);
}

function notifyOwner(text) {
  try { require('./notifySms').notifyOwnerSms(text); } catch (_) {}
  try {
    const chat = String(process.env.TELEGRAM_OWNER_CHAT || '').trim();
    if (!chat) return;
    require('./telegramBots').notifyTelegramChat(chat, text).catch(() => {});
  } catch (_) {}
}

function who(user) {
  if (!user) return 'unknown';
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ');
  return user.username ? `@${user.username}` : (name || String(user.id));
}

// ── update listeners ────────────────────────────────────────────────
async function onJoinRequest(bot, update) {
  const req = update.chat_join_request;
  if (!req) return;
  const userId = String(req.from.id);
  if (siteKeys.isOwnerChat(userId)) return;
  const allowed = isAllowed(userId);
  try {
    if (allowed) await bot.approveChatJoinRequest(req.chat.id, req.from.id);
    else if (gateEnabled()) await bot.declineChatJoinRequest(req.chat.id, req.from.id);
    else return; // gate off: leave the request for the owner to decide
    logEvent({ event: allowed ? 'join.approved' : 'join.declined', chat: req.chat.id, telegram_id: userId, user: who(req.from) });
    if (!allowed) notifyOwner(`🚪 Join declined — ${who(req.from)} (${userId}) in chat ${req.chat.id}`);
  } catch (e) {
    logEvent({ event: 'join.error', chat: req.chat.id, telegram_id: userId, error: e.message });
  }
}

async function onNewMembers(bot, msg) {
  const members = msg.new_chat_members || [];
  if (!members.length || !gateEnabled()) return;
  for (const member of members) {
    const userId = String(member.id);
    if (userId === String(bot.botInfo?.id || '')) continue;         // the bot itself
    if (siteKeys.isOwnerChat(userId)) continue;                     // never the owner
    if (isAllowed(userId)) { logEvent({ event: 'join.allowed', chat: msg.chat.id, telegram_id: userId, user: who(member) }); continue; }
    try {
      // Ban + immediately unban so they are removed but not blocked forever.
      await bot.banChatMember(msg.chat.id, member.id);
      await bot.unbanChatMember(msg.chat.id, member.id).catch(() => {});
      logEvent({ event: 'join.removed', chat: msg.chat.id, telegram_id: userId, user: who(member) });
      notifyOwner(`🚪 Guest removed — ${who(member)} (${userId}) from chat ${msg.chat.id}`);
      await bot.sendMessage(msg.chat.id, `🚪 ${who(member)} was removed: this group is invite-only. Ask the owner to /allow <id>.`).catch(() => {});
    } catch (e) {
      logEvent({ event: 'join.remove_failed', chat: msg.chat.id, telegram_id: userId, error: e.message });
      await bot.sendMessage(msg.chat.id, `⚠️ Could not remove ${who(member)}: ${e.message} (make the bot an admin with ban rights).`).catch(() => {});
    }
  }
}

// Attach the gate to one live bot instance. Safe to call once per bot.
function attach(bot) {
  if (bot.__guestGateAttached) return;
  bot.__guestGateAttached = true;
  bot.on('chat_join_request', update => onJoinRequest(bot, update).catch(e => console.error('[gate] join request failed:', e.message)));
  bot.on('new_chat_members', msg => onNewMembers(bot, msg).catch(e => console.error('[gate] new member failed:', e.message)));
}

// ── owner commands ──────────────────────────────────────────────────
async function handleGateCommand({ text, chatId, bot }) {
  if (!/^\/(?:allow|deny|kick|allowlist|requests|gate)\b/i.test(text)) return false;
  if (!siteKeys.isOwnerChat(chatId)) {
    await bot.sendMessage(chatId, '⛔ That command is owner-only.');
    return true;
  }
  const parts = text.trim().split(/\s+/);
  const command = parts[0].toLowerCase().replace(/^\//, '').replace(/@\S+$/, '');
  const rest = parts.slice(1);

  if (command === 'gate') {
    const value = (rest[0] || '').toLowerCase();
    if (value !== 'on' && value !== 'off') {
      await bot.sendMessage(chatId, `🚪 Guest gate is *${gateEnabled() ? 'on' : 'off'}*.\nToggle with /gate on or /gate off.\nWhen on: unknown accounts are declined on join requests and removed from groups where this bot is admin.`);
      return true;
    }
    setSetting('gate', value);
    await bot.sendMessage(chatId, value === 'on'
      ? '🚪 Guest gate ON — only /allow-listed accounts get in; unknown joiners are declined or removed. The bot needs admin (ban) rights in each group.'
      : '🚪 Guest gate OFF — join requests are left for you and nobody is removed.');
    return true;
  }

  if (command === 'allow' || command === 'deny' || command === 'kick') {
    const target = (rest[0] || '').replace(/^@/, '');
    if (!/^\d{4,20}$/.test(target)) {
      await bot.sendMessage(chatId, `Usage: /${command} <numeric telegram id>\nTip: ids are stable — the bot prints them when it declines or removes a guest.`);
      return true;
    }
    if (command === 'kick') {
      const chatTarget = rest[1];
      if (!/^-\d{4,20}$/.test(String(chatTarget || ''))) {
        await bot.sendMessage(chatId, 'Usage: /kick <telegram id> <group chat id> (group ids are negative, e.g. -1001234567890)');
        return true;
      }
      try {
        await bot.banChatMember(chatTarget, Number(target));
        await bot.unbanChatMember(chatTarget, Number(target)).catch(() => {});
        logEvent({ event: 'kick', chat: chatTarget, telegram_id: target, by: 'owner' });
        await bot.sendMessage(chatId, `✅ Removed ${target} from ${chatTarget}.`);
      } catch (e) {
        await bot.sendMessage(chatId, `❌ Could not remove ${target}: ${e.message}`);
      }
      return true;
    }
    const row = setAccess(target, command === 'allow' ? 'allowed' : 'denied', `owner command`);
    await bot.sendMessage(chatId, `✅ ${target} is now *${row.status}*.`);
    return true;
  }

  if (command === 'allowlist' || command === 'requests') {
    ensure();
    const rows = getDb().prepare('SELECT * FROM telegram_access ORDER BY created_at DESC LIMIT 40').all();
    const lines = [`🚪 Guest gate: ${gateEnabled() ? 'on' : 'off'}`, ''];
    if (!rows.length) lines.push('No accounts on the list yet. /allow <id> adds one, /deny <id> blocks one.');
    for (const r of rows) lines.push(`${r.status === 'allowed' ? '✅' : '⛔'} ${r.telegram_id}${r.note ? ' — ' + r.note : ''}`);
    lines.push('', `Log: data/telegram-gate-log.jsonl`);
    await bot.sendMessage(chatId, lines.join('\n'));
    return true;
  }
  return false;
}

module.exports = { attach, handleGateCommand, gateEnabled, isAllowed, setAccess, GATE_LOG };
