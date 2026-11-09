#!/usr/bin/env node
'use strict';

// Telegram fleet reporting CLI.
//
//   node server/scripts/telegram-report.js --role health  --text "load 2.8, swap 70%"
//   node server/scripts/telegram-report.js --role coder   --file /tmp/deploy.txt
//   echo "dirty tree: 3 files" | node server/scripts/telegram-report.js --role coder
//   node server/scripts/telegram-report.js --list
//
// Why this exists: server/src/telegramBots.js only sends through live bot
// objects created by initBots(). A standalone script that required that module
// without initializing polling got an empty chat set and a silent `false`, so
// health/deploy/brain-save reports could vanish with no error. This talks to
// the Bot API directly: no polling, no 409 conflicts, no second poller.
//
// Reads the token from server/.env and the chat ids from
// server/data/telegram_chat_ids.json. Never prints a token or a chat id.

const path = require('path');
const fs = require('fs');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
try { require(path.join(ROOT, 'node_modules', 'dotenv')).config({ path: path.join(ROOT, '.env') }); } catch {}

const CHAT_IDS_FILE = path.join(ROOT, 'data', 'telegram_chat_ids.json');

// role name -> env slot + the matching sender used by telegramBots.js
const ROLES = {
  health:   { key: 'TELEGRAM_BOT_TOKEN_6', label: '⚠️ Health Report' },
  uptime:   { key: 'TELEGRAM_BOT_TOKEN_5', label: '🛡 Uptime Report' },
  coder:    { key: 'TELEGRAM_BOT_TOKEN_2', label: '🚀 Deploy / Code Report' },
  recon:    { key: 'TELEGRAM_BOT_TOKEN_3', label: '🔍 Recon Report' },
  debugger: { key: 'TELEGRAM_BOT_TOKEN_4', label: '🐞 Debugger Report' },
  command:  { key: 'TELEGRAM_BOT_TOKEN_1', label: '⚙️ Command Report' },
  security: { key: 'TELEGRAM_BOT_TOKEN_7', label: '🔒 Security Report' },
};

function parseArgs(argv) {
  const out = { role: 'health', text: null, file: null, stdin: false, list: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--role') out.role = String(argv[++i] || '').toLowerCase();
    else if (a === '--text') out.text = argv[++i] || '';
    else if (a === '--file') out.file = argv[++i] || '';
    else if (a === '--stdin') out.stdin = true;
    else if (a === '--list') out.list = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function loadChatIds() {
  try {
    const j = JSON.parse(fs.readFileSync(CHAT_IDS_FILE, 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

function splitMessage(text, limit = 4000) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + limit, text.length);
    if (end < text.length) {
      const br = Math.max(text.lastIndexOf('\n', end), text.lastIndexOf(' ', end));
      if (br > start) end = br + 1;
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks.length ? chunks : [''];
}

function sendMessage(token, chatId, text) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true });
    const req = https.request(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      timeout: 20000,
    }, (res) => {
      let raw = '';
      res.on('data', d => { raw += d; });
      res.on('end', () => {
        try {
          const j = JSON.parse(raw);
          resolve(j.ok ? { ok: true, id: j.result && j.result.message_id } : { ok: false, desc: j.description || 'unknown' });
        } catch {
          resolve({ ok: false, desc: 'unparseable response' });
        }
      });
    });
    req.on('error', e => resolve({ ok: false, desc: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, desc: 'timeout' }); });
    req.write(body);
    req.end();
  });
}

function readBody(args) {
  if (typeof args.text === 'string' && args.text.length) return args.text;
  if (args.file) {
    try { return fs.readFileSync(path.resolve(args.file), 'utf8'); }
    catch (e) { return `ERROR reading ${args.file}: ${e.message}`; }
  }
  if (args.stdin || !process.stdin.isTTY) {
    try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
  }
  return '';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log('usage: telegram-report.js --role <health|uptime|coder|recon|debugger|command|security> [--text "..."] [--file path] [--stdin] [--dry-run]');
    console.log('       telegram-report.js --list');
    return 0;
  }

  if (args.list) {
    const ids = loadChatIds();
    for (const [name, r] of Object.entries(ROLES)) {
      const token = process.env[r.key];
      const chats = Array.isArray(ids[r.key]) ? ids[r.key].length : 0;
      console.log(`${name.padEnd(9)} token=${token ? 'set' : 'MISSING'} chats=${chats}`);
    }
    return 0;
  }

  const role = ROLES[args.role];
  if (!role) {
    console.error(`unknown role "${args.role}" — one of: ${Object.keys(ROLES).join(', ')}`);
    return 2;
  }

  const token = process.env[role.key];
  if (!token) {
    console.error(`${args.role}: ${role.key} is not set in server/.env — owner must add it`);
    return 1;
  }

  const ids = loadChatIds()[role.key] || [];
  if (!ids.length) {
    console.error(`${args.role}: no registered chat — open the bot in Telegram and press Start`);
    return 1;
  }

  const body = readBody(args).trim();
  if (!body) {
    console.error('nothing to send (use --text, --file, or pipe stdin)');
    return 2;
  }

  const text = `${role.label}\n\n${body}`;
  const chunks = splitMessage(text);

  if (args.dryRun) {
    console.log(`[dry-run] ${args.role}: ${chunks.length} chunk(s), ${text.length} chars, ${ids.length} chat(s)`);
    return 0;
  }

  let sent = 0;
  let failed = 0;
  for (const chatId of ids) {
    for (const chunk of chunks) {
      const r = await sendMessage(token, chatId, chunk);
      if (r.ok) { sent++; console.log(`${args.role}: delivered (msg ${r.id})`); }
      else { failed++; console.error(`${args.role}: FAILED — ${r.desc}`); }
    }
  }
  console.log(`summary: role=${args.role} sent=${sent} failed=${failed}`);
  return failed ? 1 : 0;
}

main().then(code => process.exit(code)).catch(e => {
  console.error('telegram-report failed:', e && e.message ? e.message : e);
  process.exit(1);
});
