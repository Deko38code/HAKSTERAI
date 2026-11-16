'use strict';
/**
 * haksterAI — SMS mirror for owner notifications (EZ Texting v1 API).
 *
 * Why: everything already reaches the owner's Telegram DM. This adds a text
 * message path so a purchase, build or gated guest also lands as an SMS when the
 * owner wants that.
 *
 * How it talks to EZ Texting (official API only — never the dashboard, never a
 * logged-in browser session):
 *   POST https://a.eztexting.com/v1/messages
 *   Authorization: Basic base64(user:password)
 *   { "toNumbers": ["15551234567"], "message": "..." }   → 201 { id }
 *
 * Configuration is owner-supplied in server/.env (agents never write it):
 *   EZ_TEXTING_USER=<account username or email>
 *   EZ_TEXTING_PASSWORD=<account password>
 *   EZ_TEXTING_TO=<owner's mobile number, digits, e.g. 15551234567>
 *   EZ_TEXTING_FROM=<optional sending number>
 *
 * Safety:
 *   * Off by default; `/sms on` enables the mirror, `/sms off` stops it.
 *   * Sends only to EZ_TEXTING_TO — the owner's own number. No lists, no bulk,
 *     no messaging anyone who has not asked for it.
 *   * Credentials are read from env and never logged, echoed or stored.
 *   * Every attempt appends to data/sms-log.jsonl with the last four digits only.
 */

const fs = require('fs');
const path = require('path');
const { getDb } = require('./db');
const siteKeys = require('./telegramSiteKeys');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SMS_LOG = path.join(DATA_DIR, 'sms-log.jsonl');
const API_BASE = 'https://a.eztexting.com/v1';
const API_URL = API_BASE + '/messages';
let _ready = false;

function ensure() {
  if (_ready) return;
  getDb().exec(`CREATE TABLE IF NOT EXISTS notify_settings (
    key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT (unixepoch()))`);
  _ready = true;
}

function getSetting(key, fallback) {
  ensure();
  const row = getDb().prepare('SELECT value FROM notify_settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  ensure();
  getDb().prepare(`INSERT INTO notify_settings (key, value, updated_at) VALUES (?, ?, unixepoch())
                   ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()`)
    .run(key, String(value));
}

function logEvent(record) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(SMS_LOG, JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n');
  } catch (e) { console.error('[sms] log append failed:', e.message); }
}

function config() {
  return {
    user: String(process.env.EZ_TEXTING_USER || '').trim(),
    password: String(process.env.EZ_TEXTING_PASSWORD || ''),
    to: String(process.env.EZ_TEXTING_TO || '').replace(/[^\d]/g, ''),
    from: String(process.env.EZ_TEXTING_FROM || '').replace(/[^\d]/g, ''),
  };
}

function smsConfigured() {
  const c = config();
  return Boolean(c.user && c.password && /^\d{10,15}$/.test(c.to));
}

function hasCreds() {
  const c = config();
  return Boolean(c.user && c.password);
}

// The destination does not have to be typed into .env. A trial account already
// has exactly one number saved, and the API shows it: GET /v1/messages returns
// outbound records whose contactNumber is the recipient and whose userNumber is
// the account's own sending number. If — and only if — every recent outbound
// message went to one distinct number (and it is not the sending number), that
// number is used. Anything ambiguous resolves to null and nothing is sent.
let _resolved = { at: 0, number: null };
const RESOLVE_TTL_MS = 10 * 60 * 1000;

async function resolveDestination() {
  const c = config();
  if (/^\d{10,15}$/.test(c.to)) return c.to;
  if (!hasCreds()) return null;
  if (_resolved.number && Date.now() - _resolved.at < RESOLVE_TTL_MS) return _resolved.number;
  try {
    const res = await fetch(`${API_BASE}/messages?size=50&sort=sentAt,desc&filters[incoming][eq]=false`, {
      headers: { accept: 'application/json', authorization: 'Basic ' + Buffer.from(`${c.user}:${c.password}`).toString('base64') },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      logEvent({ event: 'sms.destination_lookup_failed', status: res.status });
      return null;
    }
    const body = await res.json().catch(() => null);
    const rows = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
    const sending = new Set(rows.map(r => String(r.userNumber || '').replace(/[^\d]/g, '')).filter(Boolean));
    const counts = new Map();
    for (const row of rows) {
      if (row.inbound === true) continue;
      const target = String(row.contactNumber || '').replace(/[^\d]/g, '');
      if (!/^\d{10,15}$/.test(target)) continue;
      if (sending.has(target)) continue;                 // never text our own number
      counts.set(target, (counts.get(target) || 0) + 1);
    }
    let number = null;
    if (counts.size === 1) number = [...counts.keys()][0];
    _resolved = { at: Date.now(), number };
    logEvent({ event: number ? 'sms.destination_resolved' : 'sms.destination_ambiguous',
      to: maskNumber(number), distinct: counts.size });
    return number;
  } catch (e) {
    logEvent({ event: 'sms.destination_lookup_failed', error: e.message });
    return null;
  }
}

async function smsReady() {
  if (!hasCreds()) return false;
  return Boolean(await resolveDestination());
}

function smsEnabled() {
  return String(getSetting('sms', 'off')) === 'on';
}

function maskNumber(n) {
  const s = String(n || '');
  return s.length >= 4 ? `…${s.slice(-4)}` : '…';
}

async function sendSms(text) {
  if (!smsEnabled()) return { ok: false, error: 'SMS mirror is off — /sms on enables it' };
  const c = config();
  if (!hasCreds()) {
    return { ok: false, error: 'SMS is not configured — set EZ_TEXTING_USER and EZ_TEXTING_PASSWORD in server/.env' };
  }
  const to = await resolveDestination();
  if (!to) {
    return { ok: false, error: 'No destination: set EZ_TEXTING_TO in server/.env, or keep exactly one saved number in the Ez Texting account so it can be read from your message history' };
  }
  const message = String(text || '').slice(0, 640);
  if (!message) return { ok: false, error: 'nothing to send' };
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        accept: '*/*',
        'content-type': 'application/json',
        authorization: 'Basic ' + Buffer.from(`${c.user}:${c.password}`).toString('base64'),
      },
      body: JSON.stringify({
        toNumbers: [to],
        message,
        ...(c.from ? { fromNumber: c.from } : {}),
      }),
      signal: AbortSignal.timeout(15000),
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 201 || res.status === 200) {
      logEvent({ event: 'sms.sent', to: maskNumber(to), id: body.id || null, chars: message.length });
      return { ok: true, id: body.id || null };
    }
    const error = body?.errors?.[0]?.message || body?.message || `HTTP ${res.status}`;
    logEvent({ event: 'sms.failed', to: maskNumber(to), error: String(error).slice(0, 200) });
    return { ok: false, error };
  } catch (e) {
    logEvent({ event: 'sms.failed', to: maskNumber(to), error: e.message });
    return { ok: false, error: e.message };
  }
}

// Mirror an owner notification by SMS when the mirror is on and configured.
// Never throws: the caller's primary channel must not fail because SMS did.
function notifyOwnerSms(text) {
  try {
    if (!smsEnabled() || !hasCreds()) return Promise.resolve({ ok: false });
    return sendSms(text).catch(() => ({ ok: false }));
  } catch (_) { return Promise.resolve({ ok: false }); }
}

// Telegram alerts are written in Markdown; a text message should not show the
// `*` markers. Strip the formatting characters the fleet actually uses.
function toPlainText(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, block => block.replace(/```\w*/g, ''))
    .replace(/^#{1,6}\s+/gm, '')            // headings
    .replace(/[*`]+/g, '')                   // bold / code markers
    .replace(/^>\s?/gm, '')                  // quotes
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 $2')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// One event must not text the phone twice when it reaches both the role-alert
// path and the owner-DM path. Same text within a minute is sent once.
const _recentMirrors = new Map();
const MIRROR_DEDUPE_MS = 60 * 1000;

function mirrorOwner(text) {
  try {
    if (!smsEnabled() || !hasCreds()) return Promise.resolve({ ok: false, skipped: 'off-or-unconfigured' });
    const plain = toPlainText(text);
    if (!plain) return Promise.resolve({ ok: false, skipped: 'empty' });
    const key = plain.slice(0, 200);
    const now = Date.now();
    const seen = _recentMirrors.get(key);
    if (seen && now - seen < MIRROR_DEDUPE_MS) return Promise.resolve({ ok: false, skipped: 'duplicate' });
    _recentMirrors.set(key, now);
    if (_recentMirrors.size > 200) {
      for (const [k, at] of _recentMirrors) if (now - at > MIRROR_DEDUPE_MS) _recentMirrors.delete(k);
    }
    return sendSms(plain).catch(() => ({ ok: false }));
  } catch (_) { return Promise.resolve({ ok: false }); }
}

/** /sms, /sms on|off, /sms status, /sms test — owner only. */
async function handleSmsCommand({ text, chatId, bot }) {
  if (!/^\/sms\b/i.test(text)) return false;
  if (!siteKeys.isOwnerChat(chatId)) {
    await bot.sendMessage(chatId, '⛔ That command is owner-only.');
    return true;
  }
  const parts = text.trim().split(/\s+/);
  const arg = (parts[1] || '').toLowerCase();
  if (arg === 'on' || arg === 'off') {
    setSetting('sms', arg);
    let line;
    if (arg === 'off') line = '📱 SMS mirror OFF — Telegram only.';
    else if (!hasCreds()) line = '📱 SMS mirror ON — but it cannot send yet: EZ_TEXTING_USER / EZ_TEXTING_PASSWORD are not in server/.env. /sms test shows the exact lines.';
    else {
      const to = await resolveDestination();
      line = to
        ? `📱 SMS mirror ON — purchases, builds and gated guests will also be texted to ${maskNumber(to)}.`
        : '📱 SMS mirror ON — but no destination: set EZ_TEXTING_TO, or keep exactly one saved number in the Ez Texting account so it can be read from your message history.';
    }
    await bot.sendMessage(chatId, line);
    return true;
  }
  if (arg === 'test') {
    if (!hasCreds()) {
      await bot.sendMessage(chatId, [
        '📱 SMS is not configured yet. Add these to server/.env yourself (agents cannot edit it):',
        'EZ_TEXTING_USER=<your Ez Texting login>',
        'EZ_TEXTING_PASSWORD=<your password>',
        'EZ_TEXTING_TO=<your mobile, digits only — optional if the account has one saved number>',
        'EZ_TEXTING_FROM=<optional sending number, e.g. the trial number>',
        'Then: pm2 restart hakster --update-env and /sms on',
      ].join('\n'));
      return true;
    }
    if (!smsEnabled()) { setSetting('sms', 'on'); await bot.sendMessage(chatId, '📱 Mirror was off — turning it on for the test.'); }
    const to = await resolveDestination();
    if (!to) {
      await bot.sendMessage(chatId, '📱 Credentials are in, but no destination could be confirmed: set EZ_TEXTING_TO, or keep exactly one saved number in the account so it can be read from your message history.');
      return true;
    }
    const res = await sendSms('HaksterAI SMS test — notifications are working.');
    await bot.sendMessage(chatId, res.ok ? `✅ Test SMS sent to ${maskNumber(to)} (id ${res.id || 'n/a'}).` : `❌ Test SMS failed to ${maskNumber(to)}: ${res.error}`);
    return true;
  }
  const c = config();
  const resolved = hasCreds() ? await resolveDestination() : null;
  await bot.sendMessage(chatId, [
    '📱 *SMS mirror*',
    `State: ${smsEnabled() ? 'on' : 'off'}`,
    `Credentials: ${hasCreds() ? 'in place' : 'missing'}`,
    `Destination: ${c.to ? maskNumber(c.to) + ' (EZ_TEXTING_TO)' : resolved ? maskNumber(resolved) + ' (read from account history)' : 'not set'}`,
    `Provider: EZ Texting v1 (official API)`,
    '',
    'Commands: /sms on · /sms off · /sms test',
  ].join('\n'));
  return true;
}

module.exports = { handleSmsCommand, sendSms, notifyOwnerSms, mirrorOwner, toPlainText, resolveDestination, smsEnabled, smsConfigured, smsReady, SMS_LOG };
