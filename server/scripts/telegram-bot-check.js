#!/usr/bin/env node
'use strict';

// Telegram bot fleet check.
//
//   node server/scripts/telegram-bot-check.js           # getMe only (safe, read-only)
//   node server/scripts/telegram-bot-check.js --send    # also send one test message per bot
//
// Never prints tokens or chat ids. Exits non-zero if any configured bot fails
// getMe, so it can be used as a health gate after a deploy or env change.

const path = require('path');
const fs = require('fs');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
try { require(path.join(ROOT, 'node_modules', 'dotenv')).config({ path: path.join(ROOT, '.env') }); } catch {}

const ROLES = [
  { key: 'TELEGRAM_BOT_TOKEN_1', name: 'command' },
  { key: 'TELEGRAM_BOT_TOKEN_2', name: 'coder' },
  { key: 'TELEGRAM_BOT_TOKEN_3', name: 'recon' },
  { key: 'TELEGRAM_BOT_TOKEN_4', name: 'debugger' },
  { key: 'TELEGRAM_BOT_TOKEN_5', name: 'uptime' },
  { key: 'TELEGRAM_BOT_TOKEN_6', name: 'health' },
  { key: 'TELEGRAM_BOT_TOKEN_7', name: 'security', optional: true },
];

function call(method, token, payload) {
  return new Promise((resolve) => {
    const body = payload ? JSON.stringify(payload) : null;
    const req = https.request(`https://api.telegram.org/bot${token}/${method}`, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {},
      timeout: 15000,
    }, (res) => {
      let raw = '';
      res.on('data', (d) => { raw += d; });
      res.on('end', () => {
        try {
          const json = JSON.parse(raw);
          resolve(json.ok ? { ok: true, result: json.result } : { ok: false, error: String(json.description || 'error').slice(0, 80) });
        } catch { resolve({ ok: false, error: 'unparsable response' }); }
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: 'network: ' + e.message.slice(0, 60) }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    if (body) req.write(body);
    req.end();
  });
}

function knownChatIds() {
  const ids = new Set();
  try {
    const file = path.join(ROOT, '..', 'data', 'telegram_chat_ids.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const list of Object.values(data)) if (Array.isArray(list)) list.forEach((id) => ids.add(String(id)));
  } catch { /* no file yet */ }
  if (process.env.TELEGRAM_OWNER_CHAT) ids.add(String(process.env.TELEGRAM_OWNER_CHAT));
  return [...ids];
}

(async () => {
  const send = process.argv.includes('--send');
  const chatIds = send ? knownChatIds() : [];
  const rows = [];
  let failures = 0;

  for (const role of ROLES) {
    const token = process.env[role.key];
    if (!token) {
      rows.push(role.optional ? `${role.name}: not configured (${role.key} unset)` : `${role.name}: MISSING (${role.key} not set)`);
      if (!role.optional) failures++;
      continue;
    }
    const me = await call('getMe', token);
    if (!me.ok) { rows.push(`${role.name}: FAIL getMe — ${me.error}`); failures++; continue; }
    let line = `${role.name}: OK @${me.result.username}`;
    if (send) {
      if (!chatIds.length) { line += ' | send skipped (no known chat)'; }
      else {
        const msg = `✅ haksterAi bot check — ${role.name} delivery OK (${new Date().toISOString().slice(0, 16)}Z)`;
        const sent = await call('sendMessage', token, { chat_id: chatIds[0], text: msg });
        line += sent.ok ? ' | send OK' : ` | send FAIL — ${sent.error}`;
        if (!sent.ok) failures++;
      }
    }
    rows.push(line);
  }

  console.log(rows.join('\n'));
  console.log(failures === 0 ? 'TELEGRAM_BOTS_OK' : `TELEGRAM_BOTS_FAILURES=${failures}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('telegram-bot-check error:', e.message); process.exit(1); });
