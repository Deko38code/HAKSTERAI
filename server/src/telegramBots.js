'use strict';
/**
 * haksterAi — Telegram Bot Fleet
 * 6 BotFather bots wired to different roles.
 */

const TelegramApi = require('node-telegram-bot-api');
const TelegramBot = TelegramApi.TelegramBot || TelegramApi.default || TelegramApi;
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const http = require('http');
const readline = require('readline');
const { chat } = require('./providers');

const ENV_ROOT = path.join(__dirname, '..');
const SERVER_PORT = parseInt(process.env.PORT || '3579', 10);

function loadHaksterConfig() {
  try {
    const raw = fs.readFileSync(path.join(ENV_ROOT, 'hakster-config.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return { provider: 'ollama', model: 'glm-5.2:cloud' };
  }
}

/**
 * Call the internal /api/agent/run endpoint and collect the streamed agent output.
 */
function runAgent(prompt, sessionId) {
  const cfg = loadHaksterConfig();
  const body = JSON.stringify({
    provider: cfg.provider || 'ollama',
    model: cfg.model || undefined,
    messages: [{ role: 'user', content: prompt }],
    sessionId,
    thinking: false,
    approvalMode: 'full-auto', // telegram bots can't show confirmation dialogs
  });

  return new Promise((resolve, reject) => {
    const contentParts = [];
    let reason = null;

    const req = http.request({
      hostname: '127.0.0.1',
      port: SERVER_PORT,
      path: '/api/agent/run',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...(process.env.HAKSTER_API_KEY ? { 'x-api-key': process.env.HAKSTER_API_KEY } : {}),
      },
      timeout: 5 * 60 * 1000,
    }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => reject(new Error(`agent endpoint returned ${res.statusCode}: ${body.slice(0, 200)}`)));
        return;
      }
      const rl = readline.createInterface({ input: res });
      rl.on('line', (line) => {
        if (!line.startsWith('data:')) return;
        const json = line.slice(5).trim();
        if (!json) return;
        try {
          const data = JSON.parse(json);
          if (data.type === 'delta' && data.content) contentParts.push(data.content);
          if (data.type === 'error') reason = data.error || data.message || 'agent error';
          // loop_detected: use whatever content was collected so far instead of rejecting
          if (data.type === 'loop_detected') {
            console.warn('[telegram] agent loop detected:', data.reason, '— returning partial content (' + contentParts.length + ' chunks)');
          }
        } catch {}
      });
      rl.on('close', () => {
        if (reason) return reject(new Error(reason));
        resolve(contentParts.join(''));
      });
      res.on('error', reject);
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('agent request timed out')); });
    req.write(body);
    req.end();
  });
}

async function safeSendMarkdown(bot, chatId, text) {
  const chunks = splitMessage(String(text || 'No response'), 4000);
  for (const chunk of chunks) {
    try {
      await bot.sendMessage(chatId, chunk, { parse_mode: 'Markdown' });
    } catch (mdErr) {
      try {
        await bot.sendMessage(chatId, chunk);
      } catch (plainErr) {
        console.error('[telegram] send failed:', plainErr.message);
      }
    }
  }
}


const ROLES = {
  TELEGRAM_BOT_TOKEN_1: { name: 'haksterAi command', username: null, bot: null, chatIds: new Set() },
  TELEGRAM_BOT_TOKEN_2: { name: 'deploy/status', username: null, bot: null, chatIds: new Set() },
  TELEGRAM_BOT_TOKEN_3: { name: 'recon/pentest', username: null, bot: null, chatIds: new Set() },
  TELEGRAM_BOT_TOKEN_4: { name: 'personal companion', username: null, bot: null, chatIds: new Set() },
  TELEGRAM_BOT_TOKEN_5: { name: 'uptime watchdog', username: null, bot: null, chatIds: new Set() },
  TELEGRAM_BOT_TOKEN_6: { name: 'system health', username: null, bot: null, chatIds: new Set() },
};

const CHAT_IDS_FILE = path.join(ENV_ROOT, 'data', 'telegram_chat_ids.json');

function loadChatIds() {
  try {
    const raw = fs.readFileSync(CHAT_IDS_FILE, 'utf8');
    const data = JSON.parse(raw);
    for (const key of Object.keys(ROLES)) {
      if (Array.isArray(data[key])) data[key].forEach(id => ROLES[key].chatIds.add(id));
    }
  } catch {
    // no file yet
  }
}

function saveChatIds() {
  try {
    fs.mkdirSync(path.dirname(CHAT_IDS_FILE), { recursive: true });
    const data = {};
    for (const key of Object.keys(ROLES)) data[key] = Array.from(ROLES[key].chatIds);
    fs.writeFileSync(CHAT_IDS_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('[telegram] failed to save chat ids:', e.message);
  }
}

function rememberChat(roleKey, chatId) {
  if (!ROLES[roleKey].chatIds.has(chatId)) {
    ROLES[roleKey].chatIds.add(chatId);
    saveChatIds();
  }
}

function splitMessage(text, limit = 4000) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + limit, text.length);
    if (end < text.length) {
      const lastBreak = Math.max(text.lastIndexOf('\n', end), text.lastIndexOf(' ', end));
      if (lastBreak > start) end = lastBreak + 1;
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

async function sendToRole(roleKey, text, options = {}) {
  const role = ROLES[roleKey];
  if (!role || !role.bot) return false;
  const ids = Array.from(role.chatIds);
  if (!ids.length) {
    console.warn(`[telegram:${role.name}] no known chats`);
    return false;
  }
  const chunks = splitMessage(String(text || 'Empty message'));
  for (const chatId of ids) {
    for (const chunk of chunks) {
      try {
        await role.bot.sendMessage(chatId, chunk, options);
      } catch (e) {
        console.error(`[telegram:${role.name}] send failed to ${chatId}:`, e.message);
      }
    }
  }
  return true;
}

function shellExec(command, timeout = 30000) {
  return new Promise((resolve) => {
    exec(command, { timeout, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) resolve(`ERROR: ${err.message}\nSTDERR:\n${stderr || ''}`.slice(0, 4000));
      else resolve((stdout || '').slice(0, 4000));
    });
  });
}

function initBots() {
  loadChatIds();

  for (const key of Object.keys(ROLES)) {
    const token = process.env[key];
    if (!token) {
      console.warn(`[telegram] missing ${key} — skipping ${ROLES[key].name} bot`);
      continue;
    }
    const bot = new TelegramBot(token, { polling: true });
    ROLES[key].bot = bot;

    bot.getMe().then(me => {
      ROLES[key].username = me.username;
      console.log(`[telegram] ${ROLES[key].name} bot live @${me.username}`);
    }).catch(e => console.error(`[telegram] ${ROLES[key].name} getMe failed:`, e.message));

    bot.on('message', msg => {
      if (!msg.text) return;
      rememberChat(key, msg.chat.id);
      handleMessage(key, msg);
    });
  }

  startWatchdog();
  startHealthReporter();
}

async function handleMessage(roleKey, msg) {
  const text = msg.text.trim();
  const chatId = msg.chat.id;
  const bot = ROLES[roleKey].bot;

  // ── Role 1: haksterAi command bot ──
  if (roleKey === 'TELEGRAM_BOT_TOKEN_1') {
    const match = text.match(/^\/(?:ask|hakster)\s+([\s\S]+)$/i);
    if (!match) {
      return bot.sendMessage(chatId,
        '⚡ *HaksterAi Command Bot*\n\nUsage:\n`/ask <prompt>` — ask the agent\n`/status` — server status',
        { parse_mode: 'Markdown' });
    }
    await bot.sendChatAction(chatId, 'typing');
    const prompt = match[1].trim();
    const typingInterval = setInterval(() => {
      try { bot.sendChatAction(chatId, 'typing'); } catch {}
    }, 4000);
    try {
      const response = await runAgent(prompt, `telegram-${chatId}`);
      clearInterval(typingInterval);
      await safeSendMarkdown(bot, chatId, response);
    } catch (e) {
      clearInterval(typingInterval);
      await bot.sendMessage(chatId, `❌ Agent error: ${e.message}`);
    }
    return;
  }

  // ── Role 3: recon/pentest bot ──
  if (roleKey === 'TELEGRAM_BOT_TOKEN_3') {
    const recon = text.match(/^\/(?:recon|scan)\s+(\S+)(?:\s+(.+))?$/i);
    if (!recon) {
      return bot.sendMessage(chatId,
        '⚡ *Recon Bot*\n\n`/recon <target>` — ping + quick nmap top ports',
        { parse_mode: 'Markdown' });
    }
    const target = recon[1];
    await bot.sendChatAction(chatId, 'typing');
    await bot.sendMessage(chatId, `🔍 starting recon on *${target}*...`, { parse_mode: 'Markdown' });
    const ping = await shellExec(`ping -c 2 -W 2 ${target}`);
    const nmap = await shellExec(`nmap -F -T4 --open ${target}`).catch(() => 'nmap not available');
    await bot.sendMessage(chatId, `*PING:*\n\`\`\`\n${ping}\n\`\`\`\n*NMAP:*\n\`\`\`\n${nmap}\n\`\`\``, { parse_mode: 'Markdown' });
    return;
  }

  // ── Role 4: personal companion / notes ──
  if (roleKey === 'TELEGRAM_BOT_TOKEN_4') {
    const note = text.match(/^\/note\s+([\s\S]+)$/i);
    if (note) {
      const entry = note[1].trim();
      const file = path.join(ENV_ROOT, 'data', 'telegram_notes.txt');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `[${new Date().toISOString()}] ${entry}\n`);
      return bot.sendMessage(chatId, '✅ note saved.');
    }
    // general chat → haksterAi agent
    await bot.sendChatAction(chatId, 'typing');
    try {
      const cfg = loadHaksterConfig();
      const response = await chat({
        provider: cfg.provider || 'ollama',
        model: cfg.model || 'glm-5.2:cloud',
        messages: [{ role: 'user', content: text }],
        system: 'You are a helpful AI companion. Keep responses short and practical.',
      });
      await bot.sendMessage(chatId, String(response?.content || response || 'No response').slice(0, 4000));
    } catch (e) {
      await bot.sendMessage(chatId, `❌ Error: ${e.message}`);
    }
    return;
  }

  // ── Role 5: uptime watchdog ──
  if (roleKey === 'TELEGRAM_BOT_TOKEN_5') {
    if (/^\/(?:status|check)/i.test(text)) {
      const report = await runUptimeCheck();
      return bot.sendMessage(chatId, report, { parse_mode: 'Markdown' });
    }
    return bot.sendMessage(chatId, '🛡 *Watchdog*\n\n`/status` — check haksterAi / cinevault / kiro-gateway');
  }

  // ── Role 6: system health bot ──
  if (roleKey === 'TELEGRAM_BOT_TOKEN_6') {
    if (/^\/(?:health|temp|sys)/i.test(text)) {
      const report = await runSystemHealth();
      return bot.sendMessage(chatId, report, { parse_mode: 'Markdown' });
    }
    return bot.sendMessage(chatId, '🌡 *System Health*\n\n`/health` — load, temps, uptime');
  }

  // ── Role 2: deploy/status bot (mostly passive) ──
  if (roleKey === 'TELEGRAM_BOT_TOKEN_2') {
    return bot.sendMessage(chatId,
      '🚀 *Deploy / Status Bot*\n\nThis channel receives server alerts automatically.\n`/status` — current server status',
      { parse_mode: 'Markdown' });
  }
}

async function runUptimeCheck() {
  const ports = [
    { name: 'haksterAi', port: 3579 },
    { name: 'cine-vault-live', port: 8081 },
    { name: 'kiro-gateway', port: 8000 },
  ];
  const lines = [];
  for (const svc of ports) {
    try {
      await new Promise((resolve, reject) => {
        const net = require('net');
        const s = net.connect(svc.port, '127.0.0.1', () => { s.end(); resolve(); });
        s.on('error', reject);
        s.setTimeout(3000, () => { s.destroy(); reject(new Error('timeout')); });
      });
      lines.push(`✅ *${svc.name}* up on port ${svc.port}`);
    } catch {
      lines.push(`❌ *${svc.name}* down (port ${svc.port})`);
    }
  }
  return lines.join('\n');
}

async function runSystemHealth() {
  const load = require('os').loadavg().map(n => n.toFixed(2)).join(', ');
  const uptime = require('os').uptime();
  const uptimeStr = `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`;
  let temp = 'sensors not available';
  try {
    // Try sensors first — match common temp labels across AMD/Intel
    const sensorsOut = await shellExec('sensors 2>/dev/null | grep -iE "Core|Tctl|Tdie|Package|temp1|edge|Tcc" | grep -i "°C\\|temp" | head -n 6');
    if (sensorsOut.trim()) {
      temp = sensorsOut;
    } else {
      // Fallback: read from /sys/class/hwmon directly
      const hwmon = await shellExec('for f in /sys/class/hwmon/*/temp*_input; do name=$(cat $(dirname $f)/name 2>/dev/null); val=$(cat $f 2>/dev/null); echo "$name: $((val/1000))°C"; done 2>/dev/null | head -n 6');
      if (hwmon.trim()) temp = hwmon;
    }
  } catch {}
  // Also grab CPU frequency and memory for a richer report
  let memInfo = '';
  try {
    const memOut = await shellExec("free -h | grep -E 'Mem|Swap'");
    if (memOut.trim()) memInfo = memOut;
  } catch {}
  let cpuInfo = '';
  try {
    const cpuOut = await shellExec("lscpu | grep -iE 'Model name|CPU\\(s\\):|MHz' | head -n 4");
    if (cpuOut.trim()) cpuInfo = cpuOut;
  } catch {}
  let report = `🌡 *System Health*\n\nLoad: \`${load}\`\nUptime: \`${uptimeStr}\`\n\n*Temps:*\n\`\`\`\n${temp}\n\`\`\``;
  if (memInfo) report += `\n*Memory:*\n\`\`\`\n${memInfo}\n\`\`\``;
  if (cpuInfo) report += `\n*CPU:*\n\`\`\`\n${cpuInfo}\n\`\`\``;
  return report;
}

function startWatchdog() {
  // 15 minutes
  const WATCHDOG_MS = 15 * 60 * 1000;
  setInterval(async () => {
    const report = await runUptimeCheck();
    await sendToRole('TELEGRAM_BOT_TOKEN_5', `🛡 *15-min watchdog*\n\n${report}`, { parse_mode: 'Markdown' });
  }, WATCHDOG_MS);
}

function startHealthReporter() {
  const HEALTH_MS = 30 * 60 * 1000;
  setInterval(async () => {
    const report = await runSystemHealth();
    await sendToRole('TELEGRAM_BOT_TOKEN_6', report, { parse_mode: 'Markdown' });
  }, HEALTH_MS);
}

// Public push helpers used by index.js or other modules
module.exports = {
  initBots,
  runAgent,
  sendDeployStatus: (text) => sendToRole('TELEGRAM_BOT_TOKEN_2', `🚀 *Deploy*\n\n${text}`, { parse_mode: 'Markdown' }),
  sendHealthAlert: (text) => sendToRole('TELEGRAM_BOT_TOKEN_6', `⚠️ *Health Alert*\n\n${text}`, { parse_mode: 'Markdown' }),
  sendUptimeAlert: (text) => sendToRole('TELEGRAM_BOT_TOKEN_5', `🛡 *Uptime Alert*\n\n${text}`, { parse_mode: 'Markdown' }),
  sendReconResult: (target, text) => sendToRole('TELEGRAM_BOT_TOKEN_3', `🔍 *Recon: ${target}*\n\n\`\`\`\n${text}\n\`\`\``, { parse_mode: 'Markdown' }),
  ROLES,
};
