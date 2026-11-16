'use strict';
/**
 * Ez Texting inbound receiver — the "forwarding" half of the SMS infrastructure.
 *
 * Two independent Ez Texting mechanisms post here:
 *   1. Webhook subscriptions (inbound_text.received, keyword.opt_in, contact.created)
 *      → JSON body.
 *   2. A keyword's own forwardUrl setting (PUT /v1/keywords/{keyword} { forwardUrl })
 *      → classic form post (application/x-www-form-urlencoded).
 *
 * The route is mounted before express.urlencoded(), so a form post arrives with an
 * unparsed stream. This module reads and parses either shape itself.
 *
 * Behaviour:
 *   * EZ_TEXTING_WEBHOOK_SECRET set  → the delivery must carry it in one of the
 *     common header names, otherwise 401. Accepted deliveries are appended to
 *     data/inbound-sms-log.jsonl and forwarded to the owner's Telegram.
 *   * Secret not set yet             → the endpoint is publicly postable, so the
 *     delivery is recorded but NOT forwarded anywhere.
 *
 * Never logs the full phone number (last four digits only), never logs a secret.
 */

const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, '..', 'data', 'inbound-sms-log.jsonl');

function readRaw(req, limit = 64 * 1024) {
  return new Promise(resolve => {
    if (req.body && typeof req.body === 'object' && Object.keys(req.body).length) return resolve(null);
    // A parser earlier in the chain may already have drained the stream
    // (e.g. "{}" parsed by express.json) — waiting for 'end' again would hang.
    if (req.readableEnded || req.complete) return resolve('');
    let size = 0;
    const chunks = [];
    let settled = false;
    const done = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => done(''), 5000);
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) { chunks.length = 0; req.destroy(); done(''); return; }
      chunks.push(chunk);
    });
    req.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => done(''));
    req.on('close', () => done(''));
  });
}

function parseBody(raw) {
  const s = String(raw || '').trim();
  if (!s) return {};
  if (s.startsWith('{') || s.startsWith('[')) {
    try { const parsed = JSON.parse(s); return parsed && typeof parsed === 'object' ? parsed : {}; } catch { return {}; }
  }
  const out = {};
  const decode = v => { try { return decodeURIComponent(String(v).replace(/\+/g, ' ')); } catch { return String(v); } };
  for (const pair of s.split('&')) {
    const i = pair.indexOf('=');
    if (i < 0) continue;
    out[decode(pair.slice(0, i))] = decode(pair.slice(i + 1));
  }
  return out;
}

function pick(obj, keys) {
  for (const key of keys) {
    const value = obj ? obj[key] : undefined;
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return '';
}

const PHONE_KEYS = [
  'phoneNumber', 'phone_number', 'mobileNumber', 'mobile_number', 'from', 'fromNumber',
  'from_number', 'number', 'phone', 'src', 'sender',
];
const TEXT_KEYS = ['message', 'messageBody', 'message_body', 'body', 'text', 'content', 'msgs', 'msg'];

/** Extract the normalised fields from either delivery shape. */
function extract(payload) {
  const envelope = payload && typeof payload.data === 'object' && payload.data ? payload.data : payload;
  const type = String(pick(payload, ['type', 'event', 'eventType', 'event_type']) || 'inbound_text.received');
  const keyword = String(pick(envelope, ['keyword', 'keywordName', 'keyword_name']) || pick(payload, ['keyword'])).slice(0, 64);
  const phone = String(pick(envelope, PHONE_KEYS) || pick(payload, ['phoneNumber', 'from', 'phone'])).replace(/[^\d+]/g, '');
  const text = String(pick(envelope, TEXT_KEYS) || pick(payload, ['message', 'body', 'text'])).slice(0, 1600);
  const contactName = [envelope.firstName || envelope.first_name, envelope.lastName || envelope.last_name]
    .filter(Boolean).join(' ').trim();
  return { type, keyword, phone, text, contactName };
}

function appendLog(record) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, JSON.stringify(record) + '\n');
  } catch (e) { console.error('[eztexting] inbound log failed:', e.message); }
}

/** Format the owner-facing message for one delivery. */
function ownerMessage(fields) {
  const who = [fields.contactName, fields.phone ? `…${fields.phone.slice(-4)}` : ''].filter(Boolean).join(' ');
  const label = `📨 ${fields.type}${fields.keyword ? ` · ${fields.keyword}` : ''}${who ? ` — ${who}` : ''}`;
  return `${label}\n${fields.text || '(no message text)'}`;
}

async function handle(req, res) {
  try {
    const secret = String(process.env.EZ_TEXTING_WEBHOOK_SECRET || '').trim();
    const provided = String(
      req.get('x-eztexting-secret') || req.get('x-webhook-secret') ||
      req.get('x-eztexting-signature') || req.get('authorization') || ''
    ).replace(/^Bearer\s+/i, '').trim();
    if (secret && provided !== secret) {
      console.warn('[eztexting] inbound rejected: secret mismatch');
      return res.status(401).json({ error: 'unauthorized' });
    }

    const payload = req.body && typeof req.body === 'object' && Object.keys(req.body).length
      ? req.body
      : parseBody(await readRaw(req));
    const fields = extract(payload);

    appendLog({
      at: new Date().toISOString(),
      type: fields.type,
      keyword: fields.keyword,
      phone_tail: fields.phone.slice(-4),
      contact: fields.contactName || undefined,
      text: fields.text,
      raw_keys: Object.keys(payload || {}),
    });

    if (!secret) {
      return res.json({ ok: true, forwarded: false, reason: 'EZ_TEXTING_WEBHOOK_SECRET is not set' });
    }
    const owner = String(process.env.TELEGRAM_OWNER_CHAT || '').trim();
    if (owner) {
      try {
        require('./telegramBots').notifyTelegramChat(owner, ownerMessage(fields))
          .catch(e => console.error('[eztexting] forward failed:', e.message));
      } catch (e) { console.error('[eztexting] forward failed:', e.message); }
    }
    return res.json({ ok: true, forwarded: Boolean(owner) });
  } catch (e) {
    console.error('[eztexting] inbound handler error:', e.message);
    return res.status(500).json({ error: 'inbound handler failed' });
  }
}

module.exports = { handle, extract, parseBody, ownerMessage, LOG_FILE };
