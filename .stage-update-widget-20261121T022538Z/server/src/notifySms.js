'use strict';
/**
 * haksterAI — SMS mirror for owner notifications.
 *
 * Why: everything already reaches the owner's Telegram DM. This adds a text
 * message path so a purchase, build or gated guest also lands as an SMS when the
 * owner wants that.
 *
 * This module is the POLICY half — who may be texted, how often, what gets logged.
 * The transport is ours: ./smsGateway.js routes each message to the owner's phone
 * over SSH (Termux:API, real SMS from his own SIM), or to a carrier's email-to-SMS
 * bridge, or — if nothing else is configured — to the rented Ez Texting API.
 *
 * Configuration is owner-supplied in server/.env (agents never write it).
 * Both the gateway and the legacy provider are documented in
 * docs/sms-own-gateway.md; the short version:
 *   SMS_TO=<owner's own mobile, digits>         destination (required)
 *   SMS_PHONE_HOST / SMS_PHONE_PORT / SMS_PHONE_USER / SMS_PHONE_KEY
 *   SMS_CARRIER_GATEWAY + SMS_SMTP_* + SMS_FROM_EMAIL
 *   EZ_TEXTING_USER / EZ_TEXTING_PASSWORD / EZ_TEXTING_TO (optional, legacy)
 *
 * Safety:
 *   * Off by default; `/sms on` enables the mirror, `/sms off` stops it.
 *   * Sends only to the owner's own number. No lists, no bulk, no messaging
 *     anyone who has not asked for it.
 *   * Credentials are read from env and never logged, echoed or stored.
 *   * Every attempt appends to data/sms-log.jsonl with the last four digits only.
 */

const fs = require('fs');
const path = require('path');
const { getDb } = require('./db');
const siteKeys = require('./telegramSiteKeys');
const gateway = require('./smsGateway');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SMS_LOG = path.join(DATA_DIR, 'sms-log.jsonl');
const API_BASE = 'https://a.eztexting.com/v1';
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

// ── Trial restrictions (owner instruction, 2026-11-17) ──────────────────────
// The Ez Texting account is a trial: one verified recipient, no customer messaging,
// no bulk. These guards run BEFORE any network call, so an unauthorized recipient is
// rejected locally and never reaches the provider.
//   SMS_TRIAL_MODE=true            only the single authorized number may be texted
//   SMS_ALLOWED_RECIPIENT=<E164>  the one authorized number (digits); falls back to the
//                                 single number already saved in the account
//   SMS_ENABLED=false             master switch — nothing sends until this is "true"
//   SMS_MAX_MESSAGES_PER_DAY=3    hard daily cap, counted from the send log
//   SMS_CUSTOMER_MESSAGING=false customers are never texted; owner alerts only
function trialConfig() {
  const allowed = String(process.env.SMS_ALLOWED_RECIPIENT || '').replace(/[^\d]/g, '');
  const raw = Number(process.env.SMS_MAX_MESSAGES_PER_DAY);
  const cap = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 20) : 3;
  return {
    trialMode: String(process.env.SMS_TRIAL_MODE || 'true').toLowerCase() !== 'false',
    allowed,
    maxPerDay: cap,
    enabled: String(process.env.SMS_ENABLED || 'false').toLowerCase() === 'true',
    customerMessaging: String(process.env.SMS_CUSTOMER_MESSAGING || 'false').toLowerCase() === 'true',
  };
}

// Count sends in the last 24 h straight from the append-only log, so a restart
// cannot reset the cap by losing an in-memory counter.
function sentInLast24h() {
  try {
    const since = Date.now() - 24 * 60 * 60 * 1000;
    return fs.readFileSync(SMS_LOG, 'utf8').trim().split('\n').reduce((n, line) => {
      try {
        const row = JSON.parse(line);
        return row.event === 'sms.sent' && Date.parse(row.at) >= since ? n + 1 : n;
      } catch { return n; }
    }, 0);
  } catch { return 0; }
}

function deny(reason) {
  logEvent({ event: 'sms.denied', reason });
  return { ok: false, error: reason, denied: true };
}

function smsConfigured() {
  // Any transport plus a named destination is enough to send now — the Ez Texting
  // login is only one of three ways out.
  return hasTransport() && Boolean(gateway.explicitDestination() || config().to);
}

// Our own transports (phone SIM, carrier email bridge) need no Ez Texting login,
// so "can this send at all" is a question for the gateway, not for the EZ creds.
function hasTransport() {
  try { return gateway.anyTransportConfigured(); } catch (_) { return false; }
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
  // Our own gateway only ever uses a number named in env — never one it guessed.
  const explicit = gateway.explicitDestination();
  if (explicit) return explicit;
  if (!gateway.eztextingConfigured()) return null;
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
  if (!hasTransport()) return false;
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
  // Master switch first: nothing is looked up, resolved or dialled while it is false.
  if (!trialConfig().enabled) {
    return deny('SMS_ENABLED is false — the SMS path is disabled until API access and the single-recipient check are verified');
  }
  if (!smsEnabled()) return { ok: false, error: 'SMS mirror is off — /sms on enables it' };
  if (!hasTransport()) {
    return { ok: false, error: 'SMS has no transport — configure the phone gateway or the carrier email bridge in server/.env (see docs/sms-own-gateway.md)' };
  }
  const to = await resolveDestination();
  if (!to) {
    return { ok: false, error: 'No destination: set SMS_TO in server/.env to your own mobile number (digits only)' };
  }
  const trial = trialConfig();
  if (trial.trialMode) {
    const permitted = trial.allowed || to;
    if (to !== permitted) return deny('recipient is not the authorized trial number');
  }
  const sent = sentInLast24h();
  if (sent >= trial.maxPerDay) {
    return deny(`daily cap reached (${sent}/${trial.maxPerDay})`);
  }
  const message = String(text || '').slice(0, 640);
  if (!message) return { ok: false, error: 'nothing to send' };
  // Transport is chosen by the gateway (phone SIM, carrier email, or the legacy
  // Ez Texting API). Every policy check above already ran, so nothing reaches here
  // for a recipient that was not authorized.
  const result = await gateway.deliver({ to, text: message });
  if (result.ok) {
    const id = result.id || null;
    logEvent({ event: 'sms.sent', to: maskNumber(to), provider: result.provider || null, id, chars: message.length });
    return { ok: true, provider: result.provider || null, id };
  }
  logEvent({ event: 'sms.failed', to: maskNumber(to), provider: result.provider || null, error: String(result.error || '').slice(0, 200) });
  return { ok: false, provider: result.provider || null, error: result.error || 'send failed' };
}

// Mirror an owner notification by SMS when the mirror is on and configured.
// Never throws: the caller's primary channel must not fail because SMS did.
function notifyOwnerSms(text) {
  try {
    if (!smsEnabled() || !hasTransport()) return Promise.resolve({ ok: false });
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
    if (!smsEnabled() || !hasTransport()) return Promise.resolve({ ok: false, skipped: 'off-or-unconfigured' });
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
    else if (!hasTransport()) line = '📱 SMS mirror ON — but it cannot send yet: no SMS transport is configured in server/.env. /sms test shows the exact lines.';
    else {
      const to = await resolveDestination();
      line = to
        ? `📱 SMS mirror ON — purchases, builds and gated guests will also be texted to ${maskNumber(to)} via ${gateway.providerOrder().join(' → ')}.`
        : '📱 SMS mirror ON — but no destination: set SMS_TO in server/.env to your own mobile number.';
    }
    await bot.sendMessage(chatId, line);
    return true;
  }
  if (arg === 'test') {
    if (!hasTransport()) {
      await bot.sendMessage(chatId, [
        '📱 SMS has no transport yet. Add ONE of these to server/.env yourself (agents cannot edit it):',
        '',
        'Own phone (real SMS from your SIM, needs Termux:API on the phone):',
        'SMS_PHONE_HOST=10.0.0.147',
        'SMS_PHONE_PORT=8022',
        'SMS_PHONE_USER=u0_a584',
        'SMS_PHONE_KEY=/home/ghost/haksterAi/server/data/phone_sms_key',
        '',
        'Carrier email bridge (free, your phone only):',
        'SMS_CARRIER_GATEWAY=<your carrier gateway domain>',
        'SMS_SMTP_HOST=... SMS_SMTP_USER=... SMS_SMTP_PASS=... SMS_FROM_EMAIL=...',
        '',
        'Both need: SMS_TO=<your mobile, digits only>',
        'Then: pm2 restart hakster --update-env and /sms on',
        'Full steps: docs/sms-own-gateway.md',
      ].join('\n'));
      return true;
    }
    if (!smsEnabled()) { setSetting('sms', 'on'); await bot.sendMessage(chatId, '📱 Mirror was off — turning it on for the test.'); }
    const to = await resolveDestination();
    if (!to) {
      await bot.sendMessage(chatId, '📱 A transport is configured, but no destination: set SMS_TO in server/.env to your own mobile number.');
      return true;
    }
    const res = await sendSms('HaksterAI SMS test — notifications are working.');
    await bot.sendMessage(chatId, res.ok
      ? `✅ Test SMS sent to ${maskNumber(to)} via ${res.provider || 'gateway'} (id ${res.id || 'n/a'}).`
      : `❌ Test SMS failed to ${maskNumber(to)}: ${res.error}`);
    return true;
  }
  const c = config();
  const tc = trialConfig();
  const resolved = hasTransport() ? await resolveDestination() : null;
  let st = {};
  try { st = gateway.status(); } catch (_) { st = {}; }
  await bot.sendMessage(chatId, [
    '📱 *SMS gateway*',
    `State: ${smsEnabled() ? 'on' : 'off'}`,
    `Transports: ${(st.providerOrder || []).length ? st.providerOrder.join(' → ') : 'none configured'}`,
    `Phone: ${st.phone?.configured ? `${st.phone.host} (${st.phone.auth})` : 'not configured'}`,
    `Carrier bridge: ${st.carrierEmail?.configured ? `${st.carrierEmail.gateway} via ${st.carrierEmail.smtp}` : 'not configured'}`,
    `Ez Texting: ${st.eztexting?.configured ? 'credentials in place' : 'not configured'}`,
    `Destination: ${resolved ? maskNumber(resolved) + (c.to ? ' (EZ_TEXTING_TO)' : ' (SMS_TO)') : 'not set'}`,
    `Trial mode: ${tc.trialMode ? 'on — one authorized number only' : 'OFF'}`,
    `Authorized: ${(tc.allowed || resolved) ? maskNumber(tc.allowed || resolved) : 'not set'}`,
    `Sends today: ${sentInLast24h()}/${tc.maxPerDay} · master switch SMS_ENABLED=${tc.enabled ? 'true' : 'false'}`,
    '',
    'Commands: /sms on · /sms off · /sms test',
  ].join('\n'));
  return true;
}

module.exports = { handleSmsCommand, sendSms, notifyOwnerSms, mirrorOwner, toPlainText, resolveDestination, smsEnabled, smsConfigured, smsReady, trialConfig, sentInLast24h, hasTransport, SMS_LOG };
