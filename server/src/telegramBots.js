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
const { chat, firecrawlScrape } = require('./providers');
const { getDb } = require('./db');
let _autolearn = null, _memoryEngine = null, _smartRouter = null;
try { _autolearn = require('./agent/autolearn'); } catch (_) {}
try { _memoryEngine = require('./agent/memory-engine'); } catch (_) {}
try { _smartRouter = require('./agent/smart-router'); _smartRouter.init(); } catch (_) {}

const ENV_ROOT = path.join(__dirname, '..');
const SERVER_PORT = parseInt(process.env.PORT || '3579', 10);

function loadHaksterConfig() {
  try {
    const raw = fs.readFileSync(path.join(ENV_ROOT, 'hakster-config.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
  return { provider: process.env.DEFAULT_PROVIDER || 'ollama', model: process.env.DEFAULT_MODEL || 'hp-1000:latest' };
  }
}

/**
 * Call the internal /api/agent/run endpoint and collect the streamed agent output.
 */
// Loads prior turns for this session from the shared sessions/messages tables
// (same store /api/agent/run writes to — see persistUserTurn in index.js) so
// a Telegram conversation has memory across messages, and so it shares history
// with a website chat tab pointed at the same sessionId. Read-only here: the
// server persists the user turn itself when this request hits /api/agent/run.
function loadSessionHistory(sessionId, limit = 20) {
  try {
    const db = getDb();
    const rows = db.prepare('SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at ASC LIMIT ?').all(sessionId, limit);
    return rows.map(r => ({ role: r.role, content: r.content }));
  } catch (e) {
    console.error('[telegram] session history load failed:', e.message);
    return [];
  }
}

// Persists the assistant's reply so the next loadSessionHistory() call (and
// anything else reading this sessionId, e.g. GET /api/sessions/:id/messages)
// sees a complete back-and-forth, not just the user's side.
function persistAssistantTurn(sessionId, content) {
  try {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(now, sessionId);
    db.prepare('INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(require('crypto').randomBytes(12).toString('hex'), sessionId, 'assistant', content, now);
  } catch (e) {
    console.error('[telegram] assistant turn persist failed:', e.message);
  }
}

function runAgent(prompt, sessionId) {
  const cfg = loadHaksterConfig();
  const history = loadSessionHistory(sessionId);

  // Smart router: pick cheapest model for this task
  let model = cfg.model || process.env.DEFAULT_MODEL || 'hp-1000:latest';
  let provider = cfg.provider || process.env.DEFAULT_PROVIDER || 'ollama';
  if (_smartRouter) {
    const backend = _smartRouter.route({ message: prompt });
    model = backend.model;
    if (backend.tier === 'T1_FREE_CLOUD') {
      // Free cloud: Groq, Cerebras, SambaNova, etc via Phantom
      provider = backend.model;  // 'groq', 'cerebras', 'sambanova', etc.
    } else if (backend.tier === 'T2_MINIFORGE') {
      provider = 'hackbot';
    } else if (backend.tier === 'T3_GLM_CLOUD' || backend.tier === 'T8_CLOUD_ALIAS') {
      provider = 'ollama';  // GLM cloud proxies through Ollama
    } else if (backend.tier === 'T7_LOCAL') {
      provider = 'ollama';
    } else {
      provider = 'ollama';
    }
  }

  const body = JSON.stringify({
    provider,
    model,
    messages: [...history, { role: 'user', content: prompt }],
    sessionId,
    thinking: false,
    approvalMode: 'full-auto', // telegram bots can't show confirmation dialogs
    maxTurns: 200,             // no limits — deep cracking sessions
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

// Small in-process JSON API helper — same 127.0.0.1:SERVER_PORT pattern as
// runAgent(), for calling the pricing/checkout endpoints.
function apiJson(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: '127.0.0.1', port: SERVER_PORT, path, method,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
      timeout: 15000,
    }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('request timed out')); });
    if (payload) req.write(payload);
    req.end();
  });
}

// /subscribe — fetch live plans and show them as inline "Pay" buttons.
async function sendPlanPicker(bot, chatId) {
  try {
    const data = await apiJson('GET', '/api/pricing');
    const paidPrices = (data.plans || []).flatMap(plan => plan.prices.filter(pr => pr.amount > 0).map(pr => ({ plan, price: pr })));
    if (paidPrices.length === 0) return bot.sendMessage(chatId, 'No paid plans configured yet.');
    const keyboard = paidPrices.map(({ plan, price }) => ([{
      text: `${plan.name} — ${price.name} ($${(price.amount / 100).toFixed(2)}/${price.billingCycle === 'yearly' ? 'yr' : 'mo'})`,
      callback_data: `sub:${plan.id}:${price.id}`,
    }]));
    await bot.sendMessage(chatId, '💳 *Choose a plan:*', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
  } catch (e) {
    await bot.sendMessage(chatId, `❌ Couldn't load plans: ${e.message}`);
  }
}

// Handles the "sub:<planId>:<priceId>" button tap — creates a real Stripe
// checkout session (same dynamic price_data flow as the website) tied to this
// Telegram user's account, and sends back a Pay button with the real URL.
async function handleSubscribeCallback(bot, query) {
  const chatId = query.message.chat.id;
  const [, planId, priceId] = query.data.split(':');
  try {
    await bot.answerCallbackQuery(query.id, { text: 'Creating checkout…' });
    const result = await apiJson('POST', '/api/stripe/checkout', {
      planId, priceId,
      telegramUser: { id: query.from.id, first_name: query.from.first_name, last_name: query.from.last_name, username: query.from.username },
    });
    if (!result.ok) return bot.sendMessage(chatId, `❌ Checkout failed: ${result.error}`);
    await bot.sendMessage(chatId, '✅ Tap below to complete payment:', {
      reply_markup: { inline_keyboard: [[{ text: '💳 Pay with Stripe', url: result.url }]] },
    });
  } catch (e) {
    await bot.sendMessage(chatId, `❌ Checkout error: ${e.message}`);
  }
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
  TELEGRAM_BOT_TOKEN_1: { name: 'command',      job: 'main agent (on-demand)',         username: null, bot: null, chatIds: new Set() },
  TELEGRAM_BOT_TOKEN_2: { name: 'coder',        job: 'code/build/git status reporter', username: null, bot: null, chatIds: new Set() },
  TELEGRAM_BOT_TOKEN_3: { name: 'recon',        job: 'wifi + port + recon scanner',    username: null, bot: null, chatIds: new Set() },
  TELEGRAM_BOT_TOKEN_4: { name: 'debugger',     job: 'error-log / crashed-service hunter', username: null, bot: null, chatIds: new Set() },
  TELEGRAM_BOT_TOKEN_5: { name: 'uptime watchdog', job: 'uptime monitor',              username: null, bot: null, chatIds: new Set() },
  TELEGRAM_BOT_TOKEN_6: { name: 'system health',   job: 'system health reporter',       username: null, bot: null, chatIds: new Set() },
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
  // Seed EVERY bot with the owner chat so they all have a place to send
  // (otherwise role bots with no /start say "no known chats" and never fire).
  const owner = process.env.TELEGRAM_OWNER_CHAT ? Number(process.env.TELEGRAM_OWNER_CHAT) : null;
  if (owner) {
    let added = false;
    for (const key of Object.keys(ROLES)) {
      if (!ROLES[key].chatIds.has(owner)) { ROLES[key].chatIds.add(owner); added = true; }
    }
    if (added) saveChatIds();
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
        const emsg = e?.message || String(e);
        // 400 "chat not found" / "forbidden" — the bot can't message a chat that
        // never pressed /start on it. Prune the stale id so we stop spamming errors;
        // rememberChat() re-adds it the moment the owner /start's this bot.
        if (/chat not found|forbidden|deactivated|chat_id_not_found|PEER_ID_INVALID/i.test(emsg)) {
          if (role.chatIds.has(chatId)) {
            role.chatIds.delete(chatId);
            saveChatIds();
            console.warn(`[telegram:${role.name}] pruned unreachable chat ${chatId} (not /start'd) — re-adds on next /start`);
          }
          continue;
        }
        // 400 "can't parse entities" — unmatched markdown in the report payload.
        // Retry the SAME chunk once as plain text (strip parse_mode) so the report
        // still lands instead of being silently dropped.
        if (/parse entities|can't parse|entity starting at|CHARACTER_*|MARKDOWN_/i.test(emsg)) {
          try {
            const { parse_mode, ...plainOpts } = options;
            await role.bot.sendMessage(chatId, chunk, plainOpts);
          } catch (e2) {
            console.error(`[telegram:${role.name}] send failed to ${chatId}:`, (e2?.message || e2));
          }
          continue;
        }
        console.error(`[telegram:${role.name}] send failed to ${chatId}:`, emsg);
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
    // BUGFIX: 409 Conflict — "terminated by other getUpdates request"
    // Caused by PM2 restarts not killing old polling connections cleanly.
    // Fix: use polling with interval + retry, and clear any existing webhook
    // before starting polling (Telegram only allows one active connection).
    const bot = new TelegramBot(token, {
      polling: {
        interval: 300,     // poll every 300ms
        autoStart: false,  // don't start polling until we clear webhooks
        params: { timeout: 10 },
      },
    });
    ROLES[key].bot = bot;

    // Clear any existing webhook before starting polling — prevents 409
    bot.deleteWebHook().then(() => {
      return bot.startPolling();
    }).catch(() => {
      // deleteWebHook might fail if no webhook exists — that's fine
      bot.startPolling().catch(() => {});
    });

    bot.getMe().then(me => {
      ROLES[key].username = me.username;
      console.log(`[telegram] ${ROLES[key].name} bot live @${me.username}`);
    }).catch(e => console.error(`[telegram] ${ROLES[key].name} getMe failed:`, e.message));

    // Handle polling errors gracefully instead of crashing
    // 409 fix: the old 2s restart was SHORTER than the long-poll timeout (10s),
    // so the stale getUpdates connection was still alive when we restarted ->
    // instant 409 -> infinite loop (see log spam). Now back off 15s (> timeout),
    // dedupe concurrent restarts, clear any webhook first, and cap retries at 3
    // before giving up to avoid CPU-thrashing the box.
    let _poll409Busy = false;
    let _poll409Count = 0;
    let _poll409Dead = false;
    bot.on('polling_error', (error) => {
      const msg = error?.message || String(error);
      if (msg.includes('409') || msg.includes('terminated by other')) {
        if (_poll409Busy || _poll409Dead) return;  // already mid-backoff or dead — don't pile on
        _poll409Count++;
        if (_poll409Count > 3) {
          console.error(`[telegram] ${ROLES[key].name}: 409 conflict persisted ${_poll409Count}x — stopping polling to save CPU`);
          _poll409Dead = true;
          bot.stopPolling().catch(() => {});
          return;
        }
        _poll409Busy = true;
        console.warn(`[telegram] ${ROLES[key].name}: 409 conflict (attempt ${_poll409Count}/3) — backing off 15s`);
        bot.stopPolling().catch(() => {});
        setTimeout(async () => {
          try { await bot.deleteWebHook(); } catch {}
          try { await bot.startPolling(); } catch {}
          _poll409Busy = false;
        }, 15000);
      } else if (msg.includes('EFATAL') || msg.includes('fetch failed')) {
        console.warn(`[telegram] ${ROLES[key].name}: network error — will auto-retry`);
      } else if (msg.includes('401') || msg.includes('Unauthorized')) {
        // Invalid/revoked token — the library retries with no backoff on 401,
        // which busy-loops getUpdates and pegs the event loop. Retrying is
        // pointless (token won't fix itself), so stop this bot's polling for good.
        console.error(`[telegram] ${ROLES[key].name}: 401 Unauthorized (bad/revoked token) — stopping polling permanently`);
        bot.stopPolling().catch(() => {});
        _poll409Dead = true;
      } else {
        console.error(`[telegram] ${ROLES[key].name} polling error:`, msg);
      }
    });

    bot.on('message', msg => {
      if (!msg.text) return;
      rememberChat(key, msg.chat.id);
      handleMessage(key, msg);
    });

    if (key === 'TELEGRAM_BOT_TOKEN_1') {
      bot.on('callback_query', query => {
        if (typeof query.data === 'string' && query.data.startsWith('sub:')) {
          handleSubscribeCallback(bot, query).catch(e => console.error('[telegram] subscribe callback error:', e.message));
        }
      });
    }
  }

  startWatchdog();
  startHealthReporter();
  startCoderReport();
  startReconReport();
  startDebuggerReport();
  startDocsScraper();

  // ── Immediate startup broadcast: every bot announces its job so you see all 6 are live ──
  const JOBS = {
    TELEGRAM_BOT_TOKEN_1: '🤖 haksterAI command bot online — send me a target or a task',
    TELEGRAM_BOT_TOKEN_2: '💻 coder bot online — git/build status every 30m + daily docs scrape',
    TELEGRAM_BOT_TOKEN_3: '🔍 recon bot online — wifi + port + iface sweep every 30m',
    TELEGRAM_BOT_TOKEN_4: '🐞 debugger bot online — scans crashed services + error logs every 15m',
    TELEGRAM_BOT_TOKEN_5: '🛡 uptime watchdog online — uptime checks every 15m',
    TELEGRAM_BOT_TOKEN_6: '🏥 system health bot online — health report every 30m',
  };
  setTimeout(() => {
    for (const [key, msg] of Object.entries(JOBS)) {
      sendToRole(key, msg).catch(() => {});
    }
  }, 5000);
}

async function handleMessage(roleKey, msg) {
  const text = msg.text.trim();
  const chatId = msg.chat.id;
  const bot = ROLES[roleKey].bot;

  // ── Role 1: haksterAi command bot ──
  if (roleKey === 'TELEGRAM_BOT_TOKEN_1') {
    if (/^\/(?:subscribe|pay|plans)\b/i.test(text)) {
      return sendPlanPicker(bot, chatId);
    }
    const match = text.match(/^\/(?:ask|hakster)\s+([\s\S]+)$/i);
    if (!match) {
      return bot.sendMessage(chatId,
        '⚡ *haksterAI Command Bot*\n\nUsage:\n`/ask <prompt>` — ask the agent\n`/subscribe` — pick a plan and pay\n`/status` — server status',
        { parse_mode: 'Markdown' });
    }
    await bot.sendChatAction(chatId, 'typing');
    const prompt = match[1].trim();
    const typingInterval = setInterval(() => {
      try { bot.sendChatAction(chatId, 'typing'); } catch {}
    }, 4000);
    try {
      const sessionId = `telegram-${chatId}`;
      const response = await runAgent(prompt, sessionId);
      persistAssistantTurn(sessionId, response);
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
    const askMatch = text.match(/^\/(?:ask|hakster)\s+([\s\S]+)$/i);
    if (!recon && !askMatch) {
      return bot.sendMessage(chatId,
        '⚡ *Recon Bot* — haksterAI pentest agent\n\n`/recon <target>` — ping + quick nmap top ports\n`/ask <prompt>` — full agent w/ MCP tools (nmap, bounty-platforms, writeup-search, playwright, sqlite)',
        { parse_mode: 'Markdown' });
    }
    // /ask → full agent loop with all MCP tools
    if (askMatch) {
      const prompt = askMatch[1].trim();
      await bot.sendChatAction(chatId, 'typing');
      const typingInterval = setInterval(() => { try { bot.sendChatAction(chatId, 'typing'); } catch {} }, 4000);
      try {
        const sessionId = `telegram-recon-${chatId}`;
        const response = await runAgent(prompt, sessionId);
        persistAssistantTurn(sessionId, response);
        clearInterval(typingInterval);
        await safeSendMarkdown(bot, chatId, response);
      } catch (e) {
        clearInterval(typingInterval);
        await bot.sendMessage(chatId, `❌ Agent error: ${e.message}`);
      }
      return;
    }
    const target = recon[1];
    await bot.sendChatAction(chatId, 'typing');
    await bot.sendMessage(chatId, `🔍 starting recon on *${target}*...`, { parse_mode: 'Markdown' });
    const ping = await shellExec(`ping -c 2 -W 2 ${target}`);
    const nmap = await shellExec(`nmap -F -T4 --open ${target}`).catch(() => 'nmap not available');
    await bot.sendMessage(chatId, `*PING:*\n\`\`\`\n${ping}\n\`\`\`\n*NMAP:*\n\`\`\`\n${nmap}\n\`\`\``, { parse_mode: 'Markdown' });
    return;
  }

  // ── Role 4: debugger / agent bot ──
  if (roleKey === 'TELEGRAM_BOT_TOKEN_4') {
    const note = text.match(/^\/note\s+([\s\S]+)$/i);
    if (note) {
      const entry = note[1].trim();
      const file = path.join(ENV_ROOT, 'data', 'telegram_notes.txt');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `[${new Date().toISOString()}] ${entry}\n`);
      return bot.sendMessage(chatId, '✅ note saved.');
    }
    // general chat → full haksterAi agent loop (MCP tools, 200 turns, no limits)
    await bot.sendChatAction(chatId, 'typing');
    const typingInterval = setInterval(() => { try { bot.sendChatAction(chatId, 'typing'); } catch {} }, 4000);
    try {
      const sessionId = `telegram-debug-${chatId}`;
      const response = await runAgent(text, sessionId);
      persistAssistantTurn(sessionId, response);
      clearInterval(typingInterval);
      await safeSendMarkdown(bot, chatId, response);
    } catch (e) {
      clearInterval(typingInterval);
      await bot.sendMessage(chatId, `❌ Agent error: ${e.message}`);
    }
    return;
  }

  // ── Role 5: uptime watchdog ──
  if (roleKey === 'TELEGRAM_BOT_TOKEN_5') {
    if (/^\/(?:status|check)/i.test(text)) {
      const report = await runUptimeCheck();
      return bot.sendMessage(chatId, report, { parse_mode: 'Markdown' });
    }
    return bot.sendMessage(chatId, '🛡 *haksterAI Watchdog*\n\n`/status` — check haksterAi / cinevault / kiro-gateway');
  }

  // ── Role 6: system health bot ──
  if (roleKey === 'TELEGRAM_BOT_TOKEN_6') {
    if (/^\/(?:health|temp|sys)/i.test(text)) {
      const report = await runSystemHealth();
      return bot.sendMessage(chatId, report, { parse_mode: 'Markdown' });
    }
    return bot.sendMessage(chatId, '🌡 *haksterAI System Health*\n\n`/health` — load, temps, uptime');
  }

  // ── Role 2: deploy/status bot (mostly passive) ──
  if (roleKey === 'TELEGRAM_BOT_TOKEN_2') {
    return bot.sendMessage(chatId,
      '🚀 *haksterAI Deploy / Status Bot*\n\nThis channel receives server alerts automatically.\n`/status` — current server status',
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

// ── Coder bot: periodic code/build/git status of the repo ──
function startCoderReport() {
  const MS = 30 * 60 * 1000;
  setInterval(async () => {
    const root = ENV_ROOT;
    const git = await shellExec(`cd ${root} && git status -s 2>/dev/null | head -20 && echo "---" && git log --oneline -3 2>/dev/null`);
    const lint = await shellExec(`cd ${root} && node -c server/src/agent/index.js 2>&1 | head -5`);
    const dirty = (git || '').split('\n').filter(l => l && !l.startsWith('---') && !l.match(/^[0-9a-f]{7} /)).length;
    await sendToRole('TELEGRAM_BOT_TOKEN_2', `💻 *Coder report*\n${dirty} dirty file(s)\n\n\`\`\`\n${(git || '').slice(0, 1200)}\n\`\`\``, { parse_mode: 'Markdown' });
  }, MS);
}

// ── Recon bot: periodic wifi + listening-port + local recon sweep ──
function startReconReport() {
  const MS = 30 * 60 * 1000;
  let _lastSig = '';
  setInterval(async () => {
    const wifi = await shellExec(`(command -v nmcli >/dev/null && nmcli -t -f SSID,SIGNAL,SECURITY dev wifi list 2>/dev/null | head -12) || (command -v iwlist >/dev/null && iwlist wlan0 scan 2>/dev/null | grep -E 'ESSID|Quality' | head -20) || echo 'no wifi tools'`);
    const ports = await shellExec(`ss -tlnp 2>/dev/null | grep LISTEN | awk '{print $4}' | sort -u | head -15`);
    const ifaces = await shellExec(`ip -br addr 2>/dev/null | head -8`);
    // Dedupe: only send the recon sweep when the SECURITY-relevant part CHANGED
    // (a new listening port or an interface change). WiFi signal fluctuates every
    // scan, so it's included in the report but NOT the trigger — otherwise the ghost
    // bot would dump the identical network script every 30 min forever.
    const sig = `${ports || ''}|${ifaces || ''}`;
    if (sig === _lastSig) return;          // unchanged — stay quiet (no noti spam)
    _lastSig = sig;
    await sendToRole('TELEGRAM_BOT_TOKEN_3', `🔍 *Recon sweep* (changed since last)\n\n*WiFi:*\n\`\`\`\n${(wifi || '').slice(0, 800)}\n\`\`\`\n*Listening:*\n\`\`\`\n${(ports || '').slice(0, 400)}\n\`\`\`\n*Ifaces:*\n\`\`\`\n${(ifaces || '').slice(0, 400)}\n\`\`\``, { parse_mode: 'Markdown' });
  }, MS);
}

// ── Debugger bot: hunt for crashed services + recent error logs ──
function startDebuggerReport() {
  const MS = 15 * 60 * 1000;
  let _lastSig = '';
  // Filter the bot fleet's OWN chatter out of "Recent errors" — telegram polling /
  // no-known-chat / 409 / deprecation noise isn't an app error, but it matched the
  // old 'error' grep and made the debugger re-send the same "error" sweep every 15 min.
  const _noiseRe = /\[telegram[:\] ].*(no known chats|pruned unreachable|409 conflict|stale polling|network error.*auto-retry|deleteWebHook)|node-telegram-bot-api|DeprecationWarning/i;
  const _filterErrs = (raw) => {
    const f = String(raw || '').split('\n').filter(l => l.trim() && !_noiseRe.test(l)).join('\n').trim();
    return f || 'no recent errors';
  };
  setInterval(async () => {
    const pm2 = await shellExec(`pm2 jlist 2>/dev/null | node -e 'let a=[];try{a=JSON.parse(require("fs").readFileSync(0,"utf8"))}catch{};console.log(a.filter(p=>p.pm2_env&&p.pm2_env.status!=="online").map(p=>p.name+":"+p.pm2_env.status).join("\n")||"all online")' 2>/dev/null`);
    const errsRaw = await shellExec(`grep -iE 'error|fatal|unhandled|crash' /home/ghost/haksterAi/server/logs/*.log 2>/dev/null | tail -8 || (pm2 logs haksterAi --nostream --lines 50 --err 2>/dev/null | grep -iE 'error|fatal' | tail -8) || echo 'no recent errors'`);
    const errs = _filterErrs(errsRaw);
    const down = !/all online/.test(pm2 || '');
    const hasRealErr = !/no recent errors/.test(errs);
    // Dedupe: only send on CHANGE. Stops the bot re-sending the identical error
    // message every 15 min — it now alerts once when an error appears, again only
    // when it clears or a new one shows up.
    const sig = `${down ? 'DOWN' : 'up'}|${hasRealErr ? errs : 'clean'}`;
    if (sig === _lastSig) return;        // unchanged since last sweep — stay quiet
    _lastSig = sig;
    if (!down && !hasRealErr) {
      await sendToRole('TELEGRAM_BOT_TOKEN_4', `🐞 *Debugger sweep* ✓ clean — all services online, no new errors. (next alert only on change)`, { parse_mode: 'Markdown' });
      return;
    }
    await sendToRole('TELEGRAM_BOT_TOKEN_4', `🐞 *Debugger sweep* ${down ? '⚠ issues' : '⚠ errors'}\n\n*Services:*\n\`\`\`\n${(pm2 || '').slice(0, 600)}\n\`\`\`\n*Recent errors:*\n\`\`\`\n${errs.slice(0, 1000)}\n\`\`\``, { parse_mode: 'Markdown' });
  }, MS);
}

// ── Docs scraper: daily firecrawl-scrape of codex/hermes/crush/kiro/claude docs → md cache + memory + consolidate ──
const DOC_SOURCES = [
  { name: 'codex',  url: 'https://developers.openai.com/codex/cli' },
  { name: 'codex-quickstart', url: 'https://developers.openai.com/codex/cli/quickstart' },
  { name: 'claude', url: 'https://docs.anthropic.com/en/docs/claude-code/overview' },
  { name: 'claude-cli-usage', url: 'https://docs.anthropic.com/en/docs/claude-code/cli-usage' },
  { name: 'kiro',   url: 'https://kiro.dev/docs/cli' },
  { name: 'kiro-custom-agents', url: 'https://kiro.dev/docs/cli/custom-agents' },
  { name: 'crush',  url: 'https://docs.crush.ai/' },
  { name: 'hermes', url: 'https://docs.nousresearch.com/' },
];
function startDocsScraper() {
  const MS = 24 * 60 * 60 * 1000;   // daily
  const cacheDir = path.join(ENV_ROOT, '.firecrawl', 'cli-skills', '.firecrawl');
  const fsSync = fs, pth = path;
  async function scrapeAndIngest() {
    if (!firecrawlScrape) { await sendToRole('TELEGRAM_BOT_TOKEN_2', '📄 docs scraper: firecrawl not available'); return; }
    try { fsSync.mkdirSync(cacheDir, { recursive: true }); } catch (_) {}
    const summary = [];
    for (const src of DOC_SOURCES) {
      try {
        const md = await firecrawlScrape(src.url);
        const ok = md && !/^Error/i.test(String(md)) && String(md).length > 200;
        if (ok) {
          const file = pth.join(cacheDir, `daily-${src.name}.md`);
          fsSync.writeFileSync(file, `<!-- daily scrape: ${src.url} — ${new Date().toISOString()} -->\n${String(md).slice(0, 60000)}\n`);
          summary.push(`✓ ${src.name} (${Math.round(String(md).length / 1024)}KB)`);
          // add to memory so the agent consolidates the freshest docs
          try {
            if (_autolearn && _autolearn.addRawMemory) _autolearn.addRawMemory({
              id: `doc_${src.name}_${Date.now()}`, timestamp: new Date().toISOString(),
              type: 'pattern', tags: ['docs', src.name, 'daily-scrape'],
              observation: `Daily doc scrape: ${src.name} (${src.url}). Cached to ${file}.`,
              confidence: 0.7,
            }, ENV_ROOT);
          } catch (_) {}
          try {
            if (_memoryEngine && _memoryEngine.addMemory) _memoryEngine.addMemory({
              type: 'observation',
              observation: `Daily docs scrape refreshed ${src.name} (${src.url}) → ${file}`,
              context: { source: 'docs-scraper', tool: src.name },
              tags: ['docs', src.name, 'daily-scrape'],
              timestamp: new Date().toISOString(),
            }, ENV_ROOT);
          } catch (_) {}
        } else {
          summary.push(`✗ ${src.name} (scrape failed)`);
        }
      } catch (e) {
        summary.push(`✗ ${src.name} (${String(e.message || e).slice(0, 60)})`);
      }
    }
    // consolidate memory after the batch
    try { if (_memoryEngine && _memoryEngine.consolidate) _memoryEngine.consolidate(ENV_ROOT); } catch (_) {}
    try { if (_autolearn && _autolearn.consolidateMemories) _autolearn.consolidateMemories(ENV_ROOT); } catch (_) {}
    await sendToRole('TELEGRAM_BOT_TOKEN_2',
      `📄 *Daily docs scrape + memory*\nScraped ${DOC_SOURCES.length} sources:\n${summary.join('\n')}\n\nCached to .firecrawl/cli-skills/.firecrawl/daily-*.md and ingested into memory (consolidated).`,
      { parse_mode: 'Markdown' });
  }
  setTimeout(scrapeAndIngest, 90000);   // first run ~90s after startup
  setInterval(scrapeAndIngest, MS);     // then daily
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
  const cpus = require('os').cpus().length || 4;
  let _lastAlert = '';
  // The health report (load/uptime/temp/mem) fluctuates EVERY run, so the old code
  // dumped a full stats "script" every 30 min forever. Now: only ALERT on actionable
  // thresholds (temp >= 80°C, RAM >= 90%, load >= cpus*2), deduped by state — one
  // alert per breach, one "all clear" on recovery, quiet otherwise.
  setInterval(async () => {
    let maxTemp = 0;
    try {
      const t = await shellExec('sensors 2>/dev/null | grep -oE "[0-9]+\\.[0-9]" | head -20; for f in /sys/class/hwmon/*/temp*_input; do cat $f 2>/dev/null; done 2>/dev/null | head -20');
      maxTemp = Math.max(0, ...String(t || '').split(/[\s\n]+/).map(Number).filter(n => n > 0 && n < 200).map(n => n > 1000 ? n / 1000 : n));
    } catch (_) {}
    let memPct = 0;
    try { const f = await shellExec("free | awk '/Mem:/ {printf \"%d\", $3/$2*100}'"); memPct = parseInt(f, 10) || 0; } catch (_) {}
    const load1 = require('os').loadavg()[0] || 0;
    const issues = [];
    if (maxTemp && maxTemp >= 80) issues.push(`🌡 TEMP ${maxTemp.toFixed(0)}°C ≥ 80`);
    if (memPct >= 90) issues.push(`💾 RAM ${memPct}% ≥ 90`);
    if (load1 >= cpus * 2) issues.push(`📈 Load ${load1.toFixed(2)} ≥ ${cpus * 2}`);
    const sig = issues.join('|') || 'ok';
    if (sig === _lastAlert) return;            // same state as last sweep — stay quiet
    _lastAlert = sig;
    if (!issues.length) {
      await sendToRole('TELEGRAM_BOT_TOKEN_6', `✅ *System health OK* — temp/RAM/load within thresholds. (next ping only on a breach)`, { parse_mode: 'Markdown' });
      return;
    }
    const report = await runSystemHealth();
    await sendToRole('TELEGRAM_BOT_TOKEN_6', `⚠️ *Health Alert*: ${issues.join(', ')}\n\n${report}`, { parse_mode: 'Markdown' });
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
