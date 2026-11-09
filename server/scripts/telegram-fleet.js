#!/usr/bin/env node
'use strict';

// Telegram fleet builder — adds bots as sub-agents without ever touching server/.env.
//
// Telegram has no official API for creating bots: a new key comes from @BotFather in
// the owner's Telegram app. This script does the part that CAN be scripted:
//
//   node server/scripts/telegram-fleet.js --hint marketplace   # exact BotFather steps + name
//   node server/scripts/telegram-fleet.js --next-slot          # next free TELEGRAM_BOT_TOKEN_N
//   node server/scripts/telegram-fleet.js --add --name shop --job "storefront support" \
//        --token <token from BotFather>                        # verifies getMe, records the sub-agent
//   node server/scripts/telegram-fleet.js --check              # getMe for every configured role
//
// The token is verified and never written anywhere: the manifest stores only the bot slug,
// username, job and timestamp. Deke pastes the key into server/.env himself (frozen to agents).

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
try { require(path.join(ROOT, 'node_modules', 'dotenv')).config({ path: path.join(ROOT, '.env') }); } catch {}

const DATA_DIR = path.join(ROOT, '..', 'data');
const MANIFEST = path.join(DATA_DIR, 'telegram-subagents.json');
const ROLE_NAMES = { 1: 'command', 2: 'coder', 3: 'recon', 4: 'debugger', 5: 'uptime', 6: 'health', 7: 'security', 8: 'domains' };

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
          resolve(json.ok ? { ok: true, result: json.result } : { ok: false, error: String(json.description || 'error').slice(0, 120) });
        } catch { resolve({ ok: false, error: 'unparsable response' }); }
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: 'network: ' + e.message.slice(0, 60) }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    if (body) req.write(body);
    req.end();
  });
}

function loadManifest() {
  try { return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch { return { bots: [] }; }
}
function saveManifest(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(MANIFEST, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : '';
}

function nextSlot() {
  for (let i = 1; i <= 50; i++) if (!process.env[`TELEGRAM_BOT_TOKEN_${i}`]) return i;
  return null;
}

async function check() {
  const rows = [];
  for (let i = 1; i <= 50; i++) {
    const token = process.env[`TELEGRAM_BOT_TOKEN_${i}`];
    if (!token) continue;
    const me = await call('getMe', token);
    rows.push(me.ok
      ? `slot ${i} (${ROLE_NAMES[i] || 'extra'}): OK @${me.result.username}`
      : `slot ${i} (${ROLE_NAMES[i] || 'extra'}): FAIL ${me.error}`);
  }
  const manifest = loadManifest();
  for (const bot of manifest.bots) {
    rows.push(`sub-agent "${bot.name}": @${bot.username} — ${bot.job}${bot.token_slot ? ` (slot ${bot.token_slot})` : ' (token not in env yet)'}`);
  }
  console.log(rows.length ? rows.join('\n') : 'no bots configured');
}

async function add() {
  const name = (arg('--name') || '').trim();
  const job = (arg('--job') || '').trim();
  const token = (arg('--token') || '').trim();
  if (!name || !token) {
    console.error('usage: --add --name <slug> --job "<what it does>" --token <token>');
    process.exit(2);
  }
  const me = await call('getMe', token);
  if (!me.ok) {
    console.error(`token rejected: ${me.error}`);
    process.exit(1);
  }
  const slot = Number(arg('--slot')) || nextSlot();
  const manifest = loadManifest();
  const existing = manifest.bots.find((b) => b.username === me.result.username);
  const record = {
    name,
    username: me.result.username,
    job: job || 'sub-agent',
    token_slot: slot || null,
    added_at: new Date().toISOString(),
  };
  if (existing) Object.assign(existing, record, { added_at: existing.added_at });
  else manifest.bots.push(record);
  saveManifest(manifest);

  console.log(`verified bot @${me.result.username} (${existing ? 'updated' : 'added'})`);
  console.log(`manifest: ${path.relative(ROOT, MANIFEST)}`);
  if (slot) console.log(`next step for the owner: add TELEGRAM_BOT_TOKEN_${slot}=<token> to server/.env, then restart hakster`);
  const isSecurity = /security|audit|soc/i.test(`${name} ${job}`);
  const isDomain = /domain|dns|registrar/i.test(`${name} ${job}`);
  const commands = isSecurity
    ? [
      { command: 'security', description: 'Security posture summary' },
      { command: 'ports', description: 'Listening ports' },
      { command: 'ssh', description: 'Recent failed SSH logins' },
      { command: 'fw', description: 'Firewall state' },
      { command: 'updates', description: 'Pending package updates' },
      { command: 'users', description: 'Root and sudo accounts' },
      { command: 'help', description: 'Read-only security checks' },
    ]
    : isDomain
      ? [
        { command: 'check', description: 'Check if a domain is registered' },
        { command: 'find', description: 'Short name ideas for a keyword' },
        { command: 'tlds', description: 'Suffixes this desk quotes' },
        { command: 'market', description: 'Open the HaksterAI marketplace' },
        { command: 'waitlist', description: 'Get told when the marketplace opens' },
        { command: 'help', description: 'Domain desk commands' },
      ]
      : [
        { command: 'market', description: 'Open the HaksterAI marketplace' },
        { command: 'plans', description: 'See membership and site prices' },
        { command: 'start', description: 'Start the bot' },
      ];
  await call('setMyCommands', token, { commands })
    .then((r) => console.log(`setMyCommands (${isSecurity ? 'security' : isDomain ? 'domains' : 'marketplace'}):`, r.ok ? 'OK' : `FAIL ${r.error}`));
}

function hint() {
  const name = (arg('--hint') || 'marketplace').trim();
  const suggested = name.replace(/[^a-z0-9_]/gi, '').toLowerCase() || 'hakster';
  const isSecurity = /security|audit|soc/i.test(name);
  const isDomain = /domain|dns|registrar/i.test(name);
  const firstCommand = isSecurity ? '/security' : isDomain ? '/check example.com' : '/market';
  const botFatherCommands = isSecurity
    ? 'Optional BotFather settings: /setcommands (security, ports, ssh, fw, updates, users, help)'
    : isDomain
      ? 'Optional BotFather settings: /setcommands (check, find, tlds, market, waitlist, help)'
      : 'Optional BotFather settings: /setcommands (market, plans, start), /setmenubutton → https://haksterai.com/marketplace/';
  console.log([
    'BotFather has no public API for creating bots — the key has to come from your Telegram app:',
    '  1. Open @BotFather → /newbot',
    `  2. Display name: ${name}`,
    `  3. Username: ${suggested}_bot (add numbers if taken)`,
    '  4. Copy the token BotFather sends and give it to the agent only to verify — do not paste it in chat.',
    '  5. The agent records the sub-agent and gives you the exact TELEGRAM_BOT_TOKEN_N line for server/.env.',
    `  6. After the .env line is added: pm2 restart hakster --update-env, then ${firstCommand} in the new bot.`,
    '',
    botFatherCommands,
    'Mini app registration: /newapp → name, description, photo, then set the web app URL.',
  ].join('\n'));
}

(async () => {
  if (process.argv.includes('--add')) return add();
  if (process.argv.includes('--check')) return check();
  if (process.argv.includes('--next-slot')) {
    const slot = nextSlot();
    console.log(slot ? `TELEGRAM_BOT_TOKEN_${slot}` : 'no free slot in 1..50');
    return;
  }
  return hint();
})().catch((e) => { console.error('fleet error:', e.message); process.exit(1); });
