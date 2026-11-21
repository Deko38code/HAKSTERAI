'use strict';
/**
 * haksterAI — in-chat bot factory ("HaksterFather").
 *
 * The fleet's own version of @BotFather, run from any fleet bot in the owner's DM:
 *   /newbot <slug> | <job>   guided steps + the exact name/username to use
 *   /addbot <slug> <token>   verify the token with getMe, register the sub-agent,
 *                            set its commands, description and menu button
 *   /bots                    every registered bot with live status
 *   /botinfo <slug>          one bot's record + which env slot it occupies
 *   /setcommands <slug>      re-apply the marketplace command list
 *   /setmenu <slug>          re-point that bot's menu button at the mini app
 *
 * Hard rules:
 *   * Owner-only. A chat that is not TELEGRAM_OWNER_CHAT gets nothing.
 *   * Tokens are never written to disk, never logged, and only ever shown masked.
 *     Registration records name/username/job/slot/timestamp in
 *     data/telegram-subagents.json; the token itself goes to server/.env, which
 *     is the owner's file — the bot prints the exact line for him to paste.
 *   * Creating a bot in @BotFather is the owner's step; Telegram has no public API
 *     for it, and a userbot login is never used here.
 */

const fs = require('fs');
const path = require('path');
const siteKeys = require('./telegramSiteKeys');

const DATA_DIR = path.join(__dirname, '..', 'data');
const MANIFEST = path.join(DATA_DIR, 'telegram-subagents.json');
const ROLE_NAMES = { 1: 'command', 2: 'coder', 3: 'recon', 4: 'debugger', 5: 'uptime', 6: 'health', 7: 'security', 8: 'domains' };
const ROLE_JOBS = {
  command: 'main agent (on-demand)', coder: 'code/build/git status reporter', recon: 'wifi + port + recon scanner',
  debugger: 'error-log / crashed-service hunter', uptime: 'uptime monitor', health: 'system health reporter',
  security: 'read-only security posture + audit', domains: 'marketplace domain desk',
};
const MARKETPLACE_URL = String(process.env.MARKETPLACE_APP_URL || 'https://haksterai.com/marketplace/');

function loadManifest() {
  try {
    const data = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    if (!Array.isArray(data.bots)) data.bots = [];
    return data;
  } catch { return { bots: [] }; }
}

function saveManifest(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(MANIFEST, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}

function slugsFromRoles() {
  const out = new Map();
  for (const [slot, name] of Object.entries(ROLE_NAMES)) out.set(name, Number(slot));
  return out;
}

function nextSlot() {
  const { bots } = loadManifest();
  const taken = new Set([...Object.keys(ROLE_NAMES).map(Number), ...bots.map(b => Number(b.slot))]);
  let slot = 1;
  while (taken.has(slot)) slot++;
  return slot;
}

function maskToken(token) {
  const t = String(token || '');
  if (t.length < 12) return '••••';
  return `${t.slice(0, 6)}…${t.slice(-4)}`;
}

async function tgCall(token, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: payload ? 'POST' : 'GET',
    headers: payload ? { 'content-type': 'application/json' } : {},
    body: payload ? JSON.stringify(payload) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    const reason = data.description || `HTTP ${res.status}`;
    const err = new Error(reason);
    err.telegram = data;
    throw err;
  }
  return data.result;
}

function commandList() {
  return [
    { command: 'start', description: 'Start the bot' },
    { command: 'market', description: 'Open the HaksterAI marketplace' },
    { command: 'plans', description: 'Live plans and prices' },
    { command: 'build', description: 'Build an app (paid plans)' },
    { command: 'subscribe', description: 'Pick a plan and pay' },
    { command: 'stop', description: 'Stop marketplace offers' },
    { command: 'help', description: 'What this bot can do' },
  ];
}

async function applyBotProfile(token, { description, slug }) {
  const applied = [];
  try {
    await tgCall(token, 'setMyCommands', { commands: commandList() });
    applied.push('commands');
  } catch (e) { applied.push(`commands failed: ${e.message}`); }
  try {
    await tgCall(token, 'setChatMenuButton', {
      menu_button: { type: 'web_app', text: 'Marketplace', web_app: { url: MARKETPLACE_URL } },
    });
    applied.push('menu button');
  } catch (e) { applied.push(`menu button failed: ${e.message}`); }
  try {
    await tgCall(token, 'setMyDescription', {
      description: `${description || slug || 'HaksterAI'} — powered by HaksterAI. Plans and builds: ${MARKETPLACE_URL}`,
    });
    applied.push('description');
  } catch (e) { applied.push(`description failed: ${e.message}`); }
  return applied;
}

function statusLine(bot) {
  const envKey = `TELEGRAM_BOT_TOKEN_${bot.slot}`;
  const configured = Boolean(process.env[envKey]);
  return `${configured ? '🟢' : '⚪'} ${bot.name}${bot.username ? ' (@' + bot.username + ')' : ''} — ${bot.job || 'no job set'}${configured ? '' : ` · needs ${envKey}`}`;
}

/** Returns true when the message was handled. */
async function handleBotFactoryCommand({ text, chatId, bot, msg }) {
  if (!/^\/(?:newbot|addbot|bots|botinfo|setcommands|setmenu|factory)\b/i.test(text)) return false;
  if (!siteKeys.isOwnerChat(chatId)) {
    await bot.sendMessage(chatId, '⛔ That command is owner-only.');
    return true;
  }
  const parts = text.trim().split(/\s+/);
  const command = parts[0].toLowerCase().replace(/^\//, '').replace(/@\S+$/, '');
  const rest = parts.slice(1);

  if (command === 'factory' || command === 'bots') {
    const { bots } = loadManifest();
    const lines = ['🤖 HaksterAI bot factory', ''];
    for (const [slot, name] of Object.entries(ROLE_NAMES)) {
      const extra = bots.find(b => b.name === name);
      lines.push(statusLine({ name, slot: Number(slot), username: extra?.username || null, job: extra?.job || ROLE_JOBS[name] }));
    }
    const registered = bots.filter(b => !ROLE_NAMES[b.slot]);
    if (registered.length) {
      lines.push('');
      for (const b of registered) lines.push(statusLine(b));
    }
    lines.push('', `Commands: /newbot <slug> | <job> · /addbot <slug> <token> · /botinfo <slug>`, `Mini app: ${MARKETPLACE_URL}`);
    await bot.sendMessage(chatId, lines.join('\n'));
    return true;
  }

  if (command === 'newbot') {
    const raw = rest.join(' ');
    const [slugPart, jobPart] = raw.split('|').map(s => (s || '').trim());
    const slug = (slugPart || '').toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 24);
    if (!slug) {
      await bot.sendMessage(chatId, 'Usage: /newbot <slug> | <what it does>\nExample: /newbot shop | storefront support and orders');
      return true;
    }
    const slot = nextSlot();
    const suggestion = `HaksterAI ${slug.replace(/_/g, ' ')}`.slice(0, 64);
    await bot.sendMessage(chatId, [
      `🏗 New bot: ${slug} — ${jobPart || 'no job set'}`,
      `Next free env slot: TELEGRAM_BOT_TOKEN_${slot}`,
      '',
      'Owner step in @BotFather (Telegram has no API for this):',
      '1. /newbot',
      `2. Name: ${suggestion}`,
      `3. Username: something ending in "bot", e.g. hakster_${slug}_bot`,
      '4. Copy the token it returns',
      '',
      `Then send it here once: /addbot ${slug} <token>`,
      'I verify it with getMe, set its commands/description/menu, record it, and give you the exact .env line. The token is never stored by me.',
    ].join('\n'));
    return true;
  }

  if (command === 'addbot') {
    const slug = (rest[0] || '').toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 24);
    const token = rest[1] || '';
    if (!slug || !/^\d{6,}:[A-Za-z0-9_-]{20,}$/.test(token)) {
      await bot.sendMessage(chatId, 'Usage: /addbot <slug> <token>\nThe token comes from @BotFather; it must look like 123456789:ABC…');
      return true;
    }
    // Remove the owner's message carrying the token so it is not left in chat history.
    if (msg?.message_id) { try { await bot.deleteMessage(chatId, msg.message_id); } catch (_) {} }
    try {
      const me = await tgCall(token, 'getMe');
      const manifest = loadManifest();
      const existing = manifest.bots.find(b => b.name === slug || (me.username && b.username === me.username));
      const slot = existing ? Number(existing.slot) : nextSlot();
      const record = {
        name: slug,
        username: me.username,
        job: existing?.job || 'registered from chat',
        slot,
        added_at: new Date().toISOString(),
      };
      if (existing) Object.assign(existing, record);
      else manifest.bots.push(record);
      saveManifest(manifest);
      const applied = await applyBotProfile(token, { description: `${slug} bot`, slug });
      await bot.sendMessage(chatId, [
        `✅ ${slug} verified: @${me.username} (id ${me.id})`,
        `Registered at slot ${slot}. Applied: ${applied.join(', ')}`,
        '',
        `Paste this into server/.env:`,
        `TELEGRAM_BOT_TOKEN_${slot}=<token — shown only in this message: ${maskToken(token)}>`,
        '',
        'The full token was not saved anywhere by the bot. After you add it:',
        `pm2 restart hakster --update-env  then  /bots to confirm 🟢`,
      ].join('\n'));
      return true;
    } catch (e) {
      await bot.sendMessage(chatId, `❌ Token rejected by Telegram: ${e.message}\nNothing was recorded. Check the token from @BotFather and try again.`);
      return true;
    }
  }

  if (command === 'botinfo') {
    const slug = (rest[0] || '').toLowerCase();
    const { bots } = loadManifest();
    const found = bots.find(b => b.name === slug || b.username === slug);
    if (!found) return bot.sendMessage(chatId, `No bot "${slug}" in the manifest. Send /bots.`).then(() => true);
    await bot.sendMessage(chatId, [
      `🤖 ${found.name}${found.username ? ' (@' + found.username + ')' : ''}`,
      `Job: ${found.job || 'none'}`,
      `Slot: TELEGRAM_BOT_TOKEN_${found.slot} (${process.env[`TELEGRAM_BOT_TOKEN_${found.slot}`] ? 'configured' : 'NOT configured'})`,
      `Added: ${found.added_at || 'unknown'}`,
      `Commands: ${commandList().map(c => '/' + c.command).join(' ')}`,
    ].join('\n'));
    return true;
  }

  if (command === 'setcommands' || command === 'setmenu') {
    const slug = (rest[0] || '').toLowerCase();
    const { bots } = loadManifest();
    const found = bots.find(b => b.name === slug || b.username === slug);
    if (!found) return bot.sendMessage(chatId, `No bot "${slug}" in the manifest. Send /bots.`).then(() => true);
    const token = process.env[`TELEGRAM_BOT_TOKEN_${found.slot}`];
    if (!token) return bot.sendMessage(chatId, `That bot's token is not in .env yet (TELEGRAM_BOT_TOKEN_${found.slot}).`).then(() => true);
    const applied = command === 'setmenu'
      ? await applyBotProfile(token, { description: found.job, slug: found.name })
      : await tgCall(token, 'setMyCommands', { commands: commandList() }).then(() => ['commands']).catch(e => ['commands failed: ' + e.message]);
    await bot.sendMessage(chatId, `✅ ${found.name}: ${applied.join(', ')}`);
    return true;
  }

  return false;
}

module.exports = { handleBotFactoryCommand, loadManifest, commandList, MANIFEST, ROLE_NAMES };
