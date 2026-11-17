'use strict';
/**
 * haksterAi — Telegram Bot Fleet
 * 6 BotFather bots wired to different roles.
 */

const TelegramApi = require('node-telegram-bot-api');
const TelegramBot = TelegramApi.TelegramBot || TelegramApi.default || TelegramApi;
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const http = require('http');
const readline = require('readline');
const { chat, firecrawlScrape } = require('./providers');
const { getDb } = require('./db');
const { handleSecurityCommand, securityDigest } = require('./telegramSecurityBot');
const {
  scanAll: webScanAll,
  formatReport: webScanFormat,
  persistScan: webScanPersist,
  loadState: webScanState,
  loadHistoryLast: webScanHistoryLast,
  describeNewFindings: webScanNewFindings,
  markReported: webScanMarkReported,
} = require('./webVulnScanner');
const accessGuard = require('./accessGuard');
const {
  collectDetailed: loginCollectDetailed,
  updateBaseline: loginUpdateBaseline,
  anomaliesText: loginAnomaliesText,
  baselineText: loginBaselineText,
  loadPending: loginPending,
  clearPending: loginClearPending,
} = require('./loginAudit');
const { handleDomainCommand } = require('./telegramDomainBot');
const siteKeys = require('./telegramSiteKeys');
const marketplace = require('./telegramMarketplace');
const builds = require('./telegramBuilds');
const entitlements = require('./telegramEntitlements');
const botFactory = require('./telegramBotFather');
const guestGate = require('./telegramGuestGate');
const notifySms = require('./notifySms');
// Shared only in process memory with index.js; this lets Telegram-originated
// billing requests reach the checkout route without exposing an API credential.
const internalBillingToken = crypto.randomBytes(32).toString('hex');
let _autolearn = null, _memoryEngine = null, _smartRouter = null;
try { _autolearn = require('./agent/autolearn'); } catch (_) {}
try { _memoryEngine = require('./agent/memory-engine'); } catch (_) {}
try { _smartRouter = require('./agent/smart-router'); _smartRouter.init(); } catch (_) {}

const ENV_ROOT = path.join(__dirname, '..');
const SERVER_PORT = parseInt(process.env.PORT || '3579', 10);

// Miniforge owns apps and the Create Builds pipeline. Its internal builder API
// is loopback-only, so the fleet reaches it directly on the local listener.
const MINIFORGE_INTERNAL = process.env.MINIFORGE_INTERNAL_URL || 'http://127.0.0.1:5555';

// The snapshot route returns a real headless screenshot; post it before the
// text summary so the build report shows the actual rendered app.
async function sendSnapPhoto(bot, chatId, snap, caption) {
  if (!snap || !snap.ok || !snap.screenshot || !snap.screenshot.base64) return false;
  try {
    await bot.sendPhoto(chatId, Buffer.from(snap.screenshot.base64, 'base64'), { caption: String(caption || '').slice(0, 1000) });
    return true;
  } catch (e) {
    console.error('[telegramBots] snapshot photo failed:', e.message);
    return false;
  }
}
async function miniforgeBuilder(action, payload) {
  const res = await fetch(`${MINIFORGE_INTERNAL}/api/internal/builder/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
    signal: AbortSignal.timeout(320000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Keep the HTTP status and the quota snapshot on the error so the build desk
    // can tell "allowance used up" (402/429 → upgrade prompt) apart from a real
    // builder failure, instead of matching on message text.
    const err = new Error(data.error || `Miniforge returned ${res.status}`);
    err.status = res.status;
    err.quota = data.quota || null;
    throw err;
  }
  return data;
}

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

// ── Fast lane ────────────────────────────────────────────────────────
// A short conversational message does not need the full agent loop: going
// through /api/agent/run costs ~4s of round overhead before the model answers
// at all (measured: 4,430ms for "Say OK"). Measured lane latency on this box:
// deepseek 340ms, ollama 1,533ms, hackbot 1,266ms (currently 500s). So plain
// chat goes straight at the fastest lane and only falls back to the loop when
// the message actually needs tools, or when the fast call fails.
const BOT_FAST_PROVIDER = process.env.BOT_FAST_PROVIDER || 'deepseek';
const BOT_FAST_MODEL = process.env.BOT_FAST_MODEL || 'deepseek-v4.1-flash:cloud';
const TOOLISH = /\b(build|deploy|scan|install|patch|fix|run|execute|test|search|look ?up|research|open|create|write|edit|delete|remove|backup|restore|restart|start|stop|pm2|sql|database|git|commit|push|file|folder|path|code|script|error|log|debug|trace|config|api|webhook|domain|dns|stripe|email|telegram|bot|agent|memory|skill|screenshot|crawl|scrape)\b/i;
function isQuickChat(prompt) {
  const text = String(prompt || '').trim();
  if (!text || text.length > 280) return false;
  if (/https?:\/\/|www\./i.test(text)) return false;
  if (/[`$]|```|\n/.test(text)) return false; // code blocks, shell, multi-line tasks
  if (TOOLISH.test(text)) return false;
  return true;
}
function persistUserTurnLocal(sessionId, content) {
  try {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    db.prepare('INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(require('crypto').randomBytes(12).toString('hex'), sessionId, 'user', content, now);
    db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(now, sessionId);
  } catch (e) {
    console.error('[telegram] user turn persist failed:', e.message);
  }
}

// apiKey: the chat's own HaksterAI account key. /api/agent/run meters usage,
// applies customer-mode tool limits and writes the token ledger against that
// account, so Telegram usage lands on the same credit monitor as the website.
// Falls back to the shared fleet key only when a caller intentionally omits one.
function runAgent(prompt, sessionId, allowFast = true, apiKey = null) {
  const cfg = loadHaksterConfig();
  const history = loadSessionHistory(sessionId);

  if (allowFast && isQuickChat(prompt)) {
    return chat({ provider: BOT_FAST_PROVIDER, model: BOT_FAST_MODEL, messages: [...history, { role: 'user', content: prompt }] })
      .then((res) => {
        const text = String(res?.content || '').trim();
        if (!text) throw new Error('fast lane returned an empty answer');
        persistUserTurnLocal(sessionId, prompt);
        persistAssistantTurn(sessionId, text);
        console.log(`[telegram] fast lane answered in ${res?.latency || '?'}ms via ${res?.provider || BOT_FAST_PROVIDER}`);
        return text;
      })
      .catch((err) => {
        console.warn('[telegram] fast lane unavailable, using the agent loop:', err.message);
        return runAgent(prompt, sessionId, false, apiKey);
      });
  }

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
      // Was 'hackbot'; that lane is the local proxy chain and costs ~45s. Route the
      // mid tier to the unmetered DeepSeek lane instead (measured ~1.6s).
      provider = 'deepseek';
      model = process.env.BOT_FAST_MODEL || 'deepseek-v4.1-flash:cloud';
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
    // The agent loop streams every turn's text, including narration before a
    // tool call. Telegram users saw that as the same answer repeated 3-4 times
    // with "I used web_search" notes glued on. Keep only the current turn's
    // text and drop it each time a tool boundary is crossed, so what gets sent
    // is the final answer.
    let turnParts = [];
    let reason = null;

    const req = http.request({
      hostname: '127.0.0.1',
      port: SERVER_PORT,
      path: '/api/agent/run',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...((apiKey || process.env.HAKSTER_API_KEY) ? { 'x-api-key': apiKey || process.env.HAKSTER_API_KEY } : {}),
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
          if (data.type === 'delta' && data.content) { contentParts.push(data.content); turnParts.push(data.content); }
          if (data.type === 'tool_call_start' || data.type === 'auto_nudge' || data.type === 'refusal_blocked' || data.type === 'loop_nudge') turnParts = [];
          if (data.type === 'error') reason = data.error || data.message || 'agent error';
          // loop_detected: use whatever content was collected so far instead of rejecting
          if (data.type === 'loop_detected') {
            console.warn('[telegram] agent loop detected:', data.reason, '— returning partial content (' + contentParts.length + ' chunks)');
          }
        } catch {}
      });
      rl.on('close', () => {
        if (reason) return reject(new Error(reason));
        // turnParts holds only the text after the last tool call; fall back to
        // the full stream if the run ended mid-tool (loop detected, error).
        const answer = turnParts.join('').trim() || contentParts.join('');
        resolve(answer);
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
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...(path === '/api/stripe/telegram-checkout' ? { 'x-hakster-telegram-internal': internalBillingToken } : {}),
      },
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
      text: `${plan.name} — ${price.name} ($${(price.amount / 100).toFixed(2)}/${price.billingCycle === 'yearly' ? 'yr' : 'mo'}${price.introLabel ? ` · ${price.introLabel}` : ''})`,
      callback_data: `sub:${plan.id}:${price.id}`,
    }]));
    await bot.sendMessage(chatId, '💳 *Choose a plan:*', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
  } catch (e) {
    await bot.sendMessage(chatId, `❌ Couldn't load plans: ${e.message}`);
  }
}

// ── Per-chat entitlement gate ───────────────────────────────────────
// Every paid surface in the fleet (agent chat, web tools, app builds) draws on
// the chat's own HaksterAI account, so Telegram usage, per-plan limits and the
// usage/credit monitor all match the website. Owner chat is never gated.
// Returns the entitlement when the chat may proceed; otherwise sends the
// upgrade prompt (paywall + real Stripe plan picker) and returns null.
async function gateChatSurface(bot, chatId, surface) {
  let ent;
  try {
    ent = await entitlements.chatEntitlement(chatId);
  } catch (e) {
    console.error('[telegram] entitlement check failed:', e.message);
    ent = { allowed: false, isOwner: false, plan: 'unknown', reason: 'account not active', apiKey: '', user: null, limit: 0, remaining: 0 };
  }
  if (ent.allowed) return ent;
  entitlements.noteRefusal({ chatId, ent, surface });
  await entitlements.sendUpgradePrompt({ bot, chatId, ent, sendPlanPicker });
  return null;
}

// A 402 from /api/agent/run means the account's own allowance ran out between
// the pre-check and the call. Same answer as the pre-check: upgrade, not a raw
// HTTP error in the chat.
async function replyAgentError(bot, chatId, error) {
  const message = String((error && error.message) || error || 'unknown error');
  if (/returned 402|usage limit reached/i.test(message)) {
    const ent = await entitlements.chatEntitlement(chatId).catch(() => null);
    // Only treat it as an allowance refusal if the account still reads as capped;
    // a 402 that raced with a reset/upgrade falls through to the real error.
    if (ent && !ent.allowed) {
      entitlements.noteRefusal({ chatId, ent, surface: 'agent-402' });
      await entitlements.sendUpgradePrompt({ bot, chatId, ent, sendPlanPicker });
      return;
    }
  }
  await bot.sendMessage(chatId, `❌ Agent error: ${message}`);
}

// Handles the "sub:<planId>:<priceId>" button tap — creates a real Stripe
// checkout session (same dynamic price_data flow as the website) tied to this
// Telegram user's account, and sends back a Pay button with the real URL.
async function handleSubscribeCallback(bot, query) {
  const chatId = query.message.chat.id;
  const [, planId, priceId] = query.data.split(':');
  try {
    await bot.answerCallbackQuery(query.id, { text: 'Creating checkout…' });
    const result = await apiJson('POST', '/api/stripe/telegram-checkout', {
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

// Send a plain confirmation to any Telegram chat through the fleet (coder bot
// first). Used by the Stripe webhook to tell a buyer their purchase landed.
async function notifyTelegramChat(chatId, text) {
  // Owner-facing DMs also reach the phone as a text when the SMS mirror is on.
  // Buyer/customer chats are left alone: only the owner's own chat mirrors.
  let ownerChat = false;
  try { ownerChat = require('./telegramSiteKeys').isOwnerChat(chatId); } catch (_) {}
  const mirror = () => { if (ownerChat) { try { require('./notifySms').mirrorOwner(text).catch(() => {}); } catch (_) {} } };
  const bot = (ROLES.TELEGRAM_BOT_TOKEN_2 && ROLES.TELEGRAM_BOT_TOKEN_2.bot)
    || Object.values(ROLES).map(r => r.bot).find(Boolean);
  if (!bot) { mirror(); return { ok: false, error: 'no live bot' }; }
  try {
    const sent = await bot.sendMessage(String(chatId), String(text).slice(0, 3800), { disable_web_page_preview: true });
    mirror();
    return { ok: true, messageId: sent?.message_id || null };
  } catch (e) {
    mirror();
    return { ok: false, error: e.message };
  }
}

// Send one alert to a role's chats and mirror it to the owner's phone by SMS.
// The SMS copy is best-effort and deduped, so one event never texts twice.
function alertToRole(roleKey, text, options = {}) {
  const delivery = sendToRole(roleKey, text, options);
  try { require('./notifySms').mirrorOwner(text).catch(() => {}); } catch (_) {}
  return delivery;
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
  TELEGRAM_BOT_TOKEN_7: { name: 'security',        job: 'read-only security posture + audit', username: null, bot: null, chatIds: new Set() },
  TELEGRAM_BOT_TOKEN_8: { name: 'domains',         job: 'marketplace domain desk (registry checks + name ideas)', username: null, bot: null, chatIds: new Set() },
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
  // Lazily hydrate chat ids from disk. Tool handlers and scripts that call a
  // sendToRole wrapper before initBots() used to see an empty chat set and get
  // a silent `false` back — the alert vanished with no error anywhere.
  if (role.chatIds.size === 0) {
    try { loadChatIds(); } catch {}
  }
  const ids = Array.from(role.chatIds);
  if (!ids.length) {
    // Rate-limit: only log once per 10 min per bot to avoid flooding error log
    // (periodic reporters fire every 15-30m, but PM2 restarts multiply this).
    const now = Date.now();
    if (!role._noChatsLoggedAt || now - role._noChatsLoggedAt > 600000) {
      role._noChatsLoggedAt = now;
      console.warn(`[telegram:${role.name}] no known chats (bot has no /start registrations)`);
    }
    return false;
  }
  const chunks = splitMessage(String(text || 'Empty message'));
  let delivered = 0;
  for (const chatId of ids) {
    for (const chunk of chunks) {
      try {
        await role.bot.sendMessage(chatId, chunk, options);
        delivered++;
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
            delivered++;
          } catch (e2) {
            console.error(`[telegram:${role.name}] send failed to ${chatId}:`, (e2?.message || e2));
          }
          continue;
        }
        console.error(`[telegram:${role.name}] send failed to ${chatId}:`, emsg);
      }
    }
  }
  // One row per delivery, on the shared fleet feed. Scrubbed: no chat id and
  // no token ever reaches the log — only the role, what it was, and how many
  // messages the API accepted.
  try {
    if (delivered > 0) {
      const { record: recordFleet } = require('./fleetLog');
      const firstLine = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean)[0] || '';
      recordFleet({
        agent: 'telegram · ' + role.name,
        kind: 'telegram',
        action: 'report delivered',
        detail: delivered + ' message(s) accepted by the Telegram API · ' + firstLine,
      });
    }
  } catch (_) {
    // A missing log must never break a delivery.
  }
  return delivered > 0;
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
    guestGate.attach(bot);

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
    // 409 fix: exponential backoff (15s→30s→60s→120s) with dedupe + permanent
    // stop after 4 failures. The old fixed-15s retry loop kept colliding with
    // stale getUpdates connections on every PM2 restart (34 restarts = 34 loops),
    // pegging the server event loop and making the TUI CLI unresponsive.
    let _poll409Busy = false;
    let _poll409Count = 0;
    let _poll409Dead = false;
    let _pollNetErrCount = 0;
    let _pollOtherErrCount = 0;
    let _pollOtherErrLoggedAt = 0;
    let _pollOtherErrBucket = '';
    bot.on('polling_error', (error) => {
      const msg = error?.message || String(error);
      if (msg.includes('409') || msg.includes('terminated by other')) {
        if (_poll409Busy || _poll409Dead) return;  // already mid-backoff or dead — don't pile on
        _poll409Count++;
        if (_poll409Count > 4) {
          console.error(`[telegram] ${ROLES[key].name}: 409 conflict persisted ${_poll409Count}x — stopping polling to save CPU`);
          _poll409Dead = true;
          bot.stopPolling().catch(() => {});
          return;
        }
        _poll409Busy = true;
        const backoffMs = 15000 * Math.pow(2, _poll409Count - 1); // 15s, 30s, 60s, 120s
        console.warn(`[telegram] ${ROLES[key].name}: 409 conflict (attempt ${_poll409Count}/4) — backing off ${backoffMs / 1000}s`);
        bot.stopPolling().catch(() => {});
        setTimeout(async () => {
          try { await bot.deleteWebHook(); } catch {}
          try { await bot.startPolling(); } catch {}
          _poll409Busy = false;
        }, backoffMs);
      } else if (msg.includes('EFATAL') || msg.includes('fetch failed')) {
        // Network errors: the library auto-retries with no backoff, which can
        // busy-loop. Rate-limit our own log and stop after sustained failures.
        _pollNetErrCount++;
        if (_pollNetErrCount % 10 === 0) {
          console.warn(`[telegram] ${ROLES[key].name}: network error (${_pollNetErrCount}x) — library auto-retrying`);
        }
        if (_pollNetErrCount > 50) {
          console.error(`[telegram] ${ROLES[key].name}: sustained network errors (${_pollNetErrCount}x) — stopping polling`);
          _poll409Dead = true;
          bot.stopPolling().catch(() => {});
        }
      } else if (msg.includes('401') || msg.includes('Unauthorized')) {
        // Invalid/revoked token — the library retries with no backoff on 401,
        // which busy-loops getUpdates and pegs the event loop. Retrying is
        // pointless (token won't fix itself), so stop this bot's polling for good.
        console.error(`[telegram] ${ROLES[key].name}: 401 Unauthorized (bad/revoked token) — stopping polling permanently`);
        bot.stopPolling().catch(() => {});
        _poll409Dead = true;
      } else {
        // Transient edge errors (502/504/429) and anything unexpected: log at
        // most once per 5 minutes per bot with a running count, or immediately
        // when the error type changes. A Telegram-side incident used to write
        // every occurrence and grew the PM2 error log to 195 MB.
        _pollOtherErrCount++;
        const bucket = msg.replace(/\d+/g, '#').slice(0, 80);
        const now = Date.now();
        if (bucket !== _pollOtherErrBucket || now - _pollOtherErrLoggedAt > 300000) {
          _pollOtherErrBucket = bucket;
          _pollOtherErrLoggedAt = now;
          console.error(`[telegram] ${ROLES[key].name} polling error (${_pollOtherErrCount}x): ${msg}`);
        }
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
  startSecurityReporter();
  startWebScanReporter();
  // ── Marketplace automation ──────────────────────────────────────────
  // One loop owns queued builds, published-site health, and consent-only
  // offers. It reports through whichever bot actually delivers (coder first).
  try {
    const autoBot = (ROLES.TELEGRAM_BOT_TOKEN_2 && ROLES.TELEGRAM_BOT_TOKEN_2.bot)
      || Object.values(ROLES).map(r => r.bot).find(Boolean);
    if (autoBot) {
      marketplace.startAutomation({
        send: (chatId, text, opts) => autoBot.sendMessage(String(chatId), text,
          opts || { disable_web_page_preview: true }),
      });
    } else {
      console.warn('[telegram] no live bot — marketplace automation not started');
    }
  } catch (e) {
    console.error('[telegram] marketplace automation failed to start:', e.message);
  }

  startLoginReporter();
  startAccessReporter();
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
    TELEGRAM_BOT_TOKEN_8: '🌐 domain desk online — /check <name> for registry data, /find <keyword> for short name ideas',
  };
  setTimeout(() => {
    for (const [key, msg] of Object.entries(JOBS)) {
      // Skip bots with no registered chats — sending would just log "no known chats" spam
      if (ROLES[key] && ROLES[key].chatIds.size > 0) {
        sendToRole(key, msg).catch(() => {});
      }
    }
  }, 5000);
}

async function handleMessage(roleKey, msg) {
  const text = msg.text.trim();
  const chatId = msg.chat.id;
  const bot = ROLES[roleKey].bot;

  // ── rmt (rent-my-trailer) account verification — any bot carries the code ──
  // Deep link https://t.me/…?start=rmt_<code> arrives as "/start rmt_<code>";
  // rmt returns 200 for it and marks the account telegram-verified.
  if (/^\/?start\s+|^rmt_/i.test(text) && /rmt_[a-f0-9]{8}/i.test(text)) {
    const code = (text.match(/rmt_[a-f0-9]{8}/i) || [])[0];
    try {
      const r = await fetch(`http://127.0.0.1:${process.env.RMT_PORT || 8112}/api/tg/verify/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-rmt-secret": process.env.RMT_PAY_SECRET || "" },
        body: JSON.stringify({ code, telegram_id: String(chatId), display_name: msg.from?.username ? "@" + msg.from.username : (msg.from?.first_name || "") }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.ok) return bot.sendMessage(chatId, "✅ Rent My Trailer: Telegram verified! Your account is linked to this Telegram.");
      return bot.sendMessage(chatId, `❌ RMT verification failed: ${j.error || "HTTP " + r.status} — regenerate the link in Settings and try again.`);
    } catch (e) {
      return bot.sendMessage(chatId, `❌ RMT verification unreachable (rmt server down?): ${e.message}`);
    }
  }

  // ── SMS mirror (EZ Texting v1): /sms on|off|test|status, owner-only ──
  if (/^\/sms\b/i.test(text)) {
    try {
      const handled = await notifySms.handleSmsCommand({ text, chatId, bot });
      if (handled) return;
    } catch (e) {
      return bot.sendMessage(chatId, `SMS command failed: ${e.message}`);
    }
  }

  // ── Guest gate: allow/deny/kick by Telegram account id, owner-only ──
  if (/^\/(?:allow|deny|kick|allowlist|requests|gate)\b/i.test(text)) {
    try {
      const handled = await guestGate.handleGateCommand({ text, chatId, bot });
      if (handled) return;
    } catch (e) {
      return bot.sendMessage(chatId, `Gate command failed: ${e.message}`);
    }
  }

  // ── Bot factory (our BotFather): create/manage fleet bots in chat ──
  if (/^\/(?:newbot|addbot|bots|botinfo|setcommands|setmenu|factory)\b/i.test(text)) {
    try {
      const handled = await botFactory.handleBotFactoryCommand({ text, chatId, bot, msg });
      if (handled) return;
    } catch (e) {
      return bot.sendMessage(chatId, `Bot factory error: ${e.message}`);
    }
  }

  // ── Build desk + payments — reachable from ANY live fleet bot ──
  // /build is included with a paid plan; /market buy <slug> charges the item's
  // own owner-set price. Every attempt is logged to data/build-log.jsonl.
  if (/^\/(?:build|image|snap|subscribe|pay|plans)\b/i.test(text)) {
    try {
      const handled = await builds.handleBuildCommand({
        text, chatId, bot, msg,
        miniforgeBuilder, sendSnapPhoto, sendPlanPicker,
      });
      if (handled) return;
    } catch (e) {
      return bot.sendMessage(chatId, `Build command failed: ${e.message}`);
    }
  }
  if (/^\/(?:market\s+buy|buy\s+site)\b/i.test(text)) {
    try {
      const handled = await builds.handleMarketBuy({ text, chatId, bot, msg, apiJson });
      if (handled) return;
    } catch (e) {
      return bot.sendMessage(chatId, `Purchase error: ${e.message}`);
    }
  }

  // ── Marketplace consent: a chat only receives offers after it opts in ──
  // Deep link https://t.me/<bot>?start=upsell_yes arrives as "/start upsell_yes".
  if (/^\/?start\s+upsell_yes\b/i.test(text)) {
    marketplace.recordConsent(chatId, 'bot-deeplink');
    return bot.sendMessage(chatId, '✅ You are on the list for HaksterAI offers. Reply /stop any time to stop them.');
  }
  if (/^(\/stop|\/upsell_off|\/unsubscribe)\b/i.test(text)) {
    marketplace.revokeConsent(chatId, 'user-stop');
    return bot.sendMessage(chatId, '✅ Offers stopped. You will not get marketplace messages from this bot.');
  }
  if (/^\/(market|marketplace|upsell)\b/i.test(text)) {
    try {
      const handled = await marketplace.handleMarketplaceCommand({ text, chatId, bot, roleKey });
      if (handled) return;
    } catch (e) {
      return bot.sendMessage(chatId, `Marketplace command failed: ${e.message}`);
    }
  }

  // ── Owner self-service: site API keys + purchase ledger, from any fleet bot ──
  // Owner-only (compares the chat against TELEGRAM_OWNER_CHAT inside the module);
  // anything that is not one of these commands falls through untouched.
  if (/^\/(?:key|keys|apikey|keyinfo|purchases|payments)\b/i.test(text)) {
    try {
      const handled = await siteKeys.handleSiteKeyCommand({ text, chatId, bot, roleKey });
      if (handled) return;
    } catch (e) {
      return bot.sendMessage(chatId, `Key command failed: ${e.message}`);
    }
  }

  // ── Web vulnerability scan + login audit — reachable from ANY fleet bot, so the
  //    checks work today even before the slot-7 security token exists. The security
  //    bot owns them permanently once it is created.
  if (/^\/(?:scan|scanall|scanlast|lastscan|logins|ips|baseline|files|guard|access|whois|deny|undeny|denials|enforce|observe)\b/i.test(text)) {
    try {
      const reply = await handleSecurityCommand(text);
      if (reply) return await bot.sendMessage(chatId, reply);
    } catch (e) {
      return bot.sendMessage(chatId, `Security check failed: ${e.message}`);
    }
  }

  // ── Role 7: security posture bot (read-only checks, never changes the host) ──
  if (roleKey === 'TELEGRAM_BOT_TOKEN_7') {
    const reply = await handleSecurityCommand(text);
    if (reply) {
      try { return await bot.sendMessage(chatId, reply, { parse_mode: 'Markdown' }); }
      catch { return bot.sendMessage(chatId, reply); }
    }
    return bot.sendMessage(chatId, 'Send /help for the read-only security checks (/security, /scan, /logins, /ips, /baseline, /ports, /ssh, /fw, /updates).');
  }

  // ── Marketplace mini app — any role bot opens it ──
  if (/^\/(?:market|marketplace|shop|prices?)\b/i.test(text)) {
    const appUrl = process.env.MARKETPLACE_APP_URL || 'https://haksterai.com/marketplace/';
    try {
      return await bot.sendMessage(chatId,
        '🛍 *HaksterAI Marketplace*\n\nPlans, $999 fully built catalog sites, and the site market.',
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: 'Open Marketplace', web_app: { url: appUrl } }],
              [{ text: 'All plans', url: 'https://haksterai.com/plans' }],
            ],
          },
        });
    } catch (e) {
      return bot.sendMessage(chatId, `HaksterAI Marketplace: ${appUrl}`);
    }
  }

  // ── Role 8: marketplace domain desk (registry checks only, buys nothing) ──
  // /market is handled above so it keeps opening the mini app; everything else here.
  if (roleKey === 'TELEGRAM_BOT_TOKEN_8') {
    const reply = await handleDomainCommand(text, { chatId });
    if (reply) return bot.sendMessage(chatId, reply);
    return bot.sendMessage(chatId, 'Send /help for the domain desk (/check, /find, /tlds, /market, /waitlist).');
  }

  // ── Role 1: haksterAi command bot (builds/plans are handled above, any bot) ──
  if (roleKey === 'TELEGRAM_BOT_TOKEN_1') {
    const match = text.match(/^\/(?:ask|hakster)\s+([\s\S]+)$/i);
    if (!match) {
      return bot.sendMessage(chatId,
        '⚡ *haksterAI Command Bot*\n\nUsage:\n`/build <prompt>` — build an app, then image + live snapshot\n`/image <app-slug> [prompt]` — generate app artwork\n`/snap <app-slug>` — live snapshot of a built app\n`/ask <prompt>` — ask the agent\n`/subscribe` — pick a plan and pay\n`/status` — server status',
        { parse_mode: 'Markdown' });
    }
    await bot.sendChatAction(chatId, 'typing');
    const prompt = match[1].trim();
    const ent = await gateChatSurface(bot, chatId, 'agent-ask');
    if (!ent) return;
    const typingInterval = setInterval(() => {
      try { bot.sendChatAction(chatId, 'typing'); } catch {}
    }, 4000);
    try {
      const sessionId = `telegram-${chatId}`;
      const response = await runAgent(prompt, sessionId, ent.isOwner, ent.apiKey);
      persistAssistantTurn(sessionId, response);
      clearInterval(typingInterval);
      await safeSendMarkdown(bot, chatId, response);
    } catch (e) {
      clearInterval(typingInterval);
      await replyAgentError(bot, chatId, e);
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
      const ent = await gateChatSurface(bot, chatId, 'agent-recon');
      if (!ent) return;
      await bot.sendChatAction(chatId, 'typing');
      const typingInterval = setInterval(() => { try { bot.sendChatAction(chatId, 'typing'); } catch {} }, 4000);
      try {
        const sessionId = `telegram-recon-${chatId}`;
        const response = await runAgent(prompt, sessionId, ent.isOwner, ent.apiKey);
        persistAssistantTurn(sessionId, response);
        clearInterval(typingInterval);
        await safeSendMarkdown(bot, chatId, response);
      } catch (e) {
        clearInterval(typingInterval);
        await replyAgentError(bot, chatId, e);
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
    // general chat → full haksterAi agent loop for the chat's own account.
    // The chat key means usage, tool limits and the token ledger all land on
    // that account; an unlinked or exhausted chat gets the upgrade prompt.
    const ent = await gateChatSurface(bot, chatId, 'agent-chat');
    if (!ent) return;
    await bot.sendChatAction(chatId, 'typing');
    const typingInterval = setInterval(() => { try { bot.sendChatAction(chatId, 'typing'); } catch {} }, 4000);
    try {
      const sessionId = `telegram-debug-${chatId}`;
      const response = await runAgent(text, sessionId, ent.isOwner, ent.apiKey);
      persistAssistantTurn(sessionId, response);
      clearInterval(typingInterval);
      await safeSendMarkdown(bot, chatId, response);
    } catch (e) {
      clearInterval(typingInterval);
      await replyAgentError(bot, chatId, e);
    }
    return;
  }

  // ── Role 5: uptime watchdog ──
  if (roleKey === 'TELEGRAM_BOT_TOKEN_5') {
    if (/^\/(?:status|check)/i.test(text)) {
      const report = await runUptimeCheck();
      return bot.sendMessage(chatId, report, { parse_mode: 'Markdown' });
    }
    return bot.sendMessage(chatId, '🛡 *haksterAI Watchdog*\n\n`/status` — check haksterAi / cinevault / DeepSeek');
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

async function probePort(port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const net = require('net');
    const socket = net.connect(port, '127.0.0.1', () => { socket.end(); resolve(true); });
    socket.on('error', () => resolve(false));
    socket.setTimeout(timeoutMs, () => { socket.destroy(); resolve(false); });
  });
}

async function runUptimeCheck() {
  const ports = [
    { name: 'haksterAi', port: 3579 },
    { name: 'cine-vault-live', port: 8081 },
    { name: 'DeepSeek (Ollama)', port: 11434 },
  ];
  const lines = [];
  for (const svc of ports) {
    // A deploy or idle auto-apply restarts haksterAi, and the port refuses connections for a
    // few seconds. Retry before calling a service down, so a restart stops being reported as
    // a watchdog failure every 15 minutes.
    let up = await probePort(svc.port);
    let recovered = false;
    for (let attempt = 0; !up && attempt < 3; attempt += 1) {
      await new Promise((r) => setTimeout(r, 2000));
      up = await probePort(svc.port);
      if (up) recovered = true;
    }
    if (up) lines.push(`✅ *${svc.name}* up on port ${svc.port}` + (recovered ? ' (restarted during check)' : ''));
    else lines.push(`❌ *${svc.name}* down (port ${svc.port})`);
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
  // Only report a change, plus one reminder every 6 hours while something is still down.
  // Repeating the same "❌ down" line every quarter hour is noise, not monitoring.
  let lastSignature = '';
  let lastSentAt = 0;
  const REMIND_MS = 6 * 60 * 60 * 1000;
  setInterval(async () => {
    const report = await runUptimeCheck();
    const signature = report.replace(/\(restarted during check\)/g, '');
    const changed = signature !== lastSignature;
    const due = Date.now() - lastSentAt >= REMIND_MS;
    if (!changed && !due) return;
    lastSignature = signature;
    lastSentAt = Date.now();
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
      await alertToRole('TELEGRAM_BOT_TOKEN_6', `✅ *System health OK* — temp/RAM/load within thresholds. (next ping only on a breach)`, { parse_mode: 'Markdown' });
      return;
    }
    const report = await runSystemHealth();
    await alertToRole('TELEGRAM_BOT_TOKEN_6', `⚠️ *Health Alert*: ${issues.join(', ')}\n\n${report}`, { parse_mode: 'Markdown' });
  }, HEALTH_MS);
}

// Deliver a scheduled security report. The slot-7 security bot owns this surface, but
// its BotFather token may not exist yet, so fall through to recon then coder rather than
// letting findings disappear. Returns the role name that delivered, or null.
async function sendSecurityReport(text) {
  for (const key of ['TELEGRAM_BOT_TOKEN_7', 'TELEGRAM_BOT_TOKEN_3', 'TELEGRAM_BOT_TOKEN_2']) {
    try {
      if (await alertToRole(key, text)) return ROLES[key] ? ROLES[key].name : key;
    } catch (e) {
      console.error(`[telegram:security] send via ${key} failed:`, e.message);
    }
  }
  return null;
}

// Web vulnerability scan: 4x a day (every 6h). Posts when the finding set changes;
// otherwise one quiet heartbeat a day so silence is known to mean "unchanged".
function startWebScanReporter() {
  const INTERVAL_MS = 6 * 60 * 60 * 1000;
  const HEARTBEAT_MS = 24 * 60 * 60 * 1000;
  let lastPostAt = 0;
  const tick = async () => {
    let prev = null;
    try { prev = webScanState(); } catch {}
    let res;
    try {
      res = await webScanAll();
    } catch (e) {
      console.error('[telegram:webscan] scan failed:', e.message);
      return;
    }
    // Compare with the previous recorded run so the report marks what is actually new.
    let newIds = new Set();
    try {
      const prevRun = webScanHistoryLast();
      if (prevRun) newIds = new Set(webScanNewFindings(res, prevRun).map((f) => f.id));
    } catch {}
    try { webScanPersist(res); } catch (e) { console.error('[telegram:webscan] persist failed:', e.message); }
    // Compare against what was actually DELIVERED (reportedSignature), not the last scan,
    // so an undelivered change is retried next cycle instead of going quiet.
    const changed = !prev || prev.reportedSignature !== res.signature;
    const due = Date.now() - lastPostAt >= HEARTBEAT_MS;
    if (!changed && !due) return;
    const who = await sendSecurityReport(webScanFormat(res, { maxFindings: 8, newIds }));
    if (who) {
      lastPostAt = Date.now();
      try { webScanMarkReported(res.signature); } catch {}
      console.log(`[telegram:webscan] report sent via ${who} (${changed ? 'findings changed' : 'daily heartbeat'})`);
    } else {
      console.warn('[telegram:webscan] no bot could deliver the report — will retry next cycle');
    }
  };
  setTimeout(tick, 120000);          // first scan ~2 min after boot
  setInterval(tick, INTERVAL_MS);    // then 4x daily
}

// Login audit: every 15 minutes. Records new events, folds them into the learned
// baseline, and posts only when something deviates from what the host normally sees.
function startLoginReporter() {
  const INTERVAL_MS = 15 * 60 * 1000;
  const DAY_MS = 24 * 60 * 60 * 1000;
  let lastDigestAt = 0;
  const tick = async () => {
    try {
      const detailed = await loginCollectDetailed();
      if (!detailed.events.length) return;
      loginUpdateBaseline(detailed.events);           // queues any new anomalies for delivery
      const anomalies = loginPending();
      const due = Date.now() - lastDigestAt >= DAY_MS;
      if (!anomalies.length && !due) return;
      const text = anomalies.length ? loginAnomaliesText(anomalies, detailed) : loginBaselineText();
      const who = await sendSecurityReport(text);
      if (who) {
        if (anomalies.length) loginClearPending();    // only now is it safe to forget them
        if (due) lastDigestAt = Date.now();
        console.log(`[telegram:login-audit] ${anomalies.length} anomaly(ies) sent via ${who}`);
      } else {
        console.warn('[telegram:login-audit] no bot could deliver — anomalies stay queued for retry');
      }
    } catch (e) {
      console.error('[telegram:login-audit] failed:', e.message);
    }
  };
  setTimeout(tick, 45000);           // first pass ~45s after boot
  setInterval(tick, INTERVAL_MS);
}

// Access guard digest: every 6h. Posts when the picture changed in a way the owner
// should see — new challenges/denials, an auto-denial, or an account losing access.
// Silence means "same as last time", so the channel stays usable.
function startAccessReporter() {
  const INTERVAL_MS = 6 * 60 * 60 * 1000;
  let lastSig = '';
  const tick = async () => {
    try {
      const s = accessGuard.summary(6);
      const phantom = await accessGuard.phantomGuardText(6);
      // PhantomIDE runs its own guard on Parrot. It is observe-only, so it is only worth
      // a message when something would actually be blocked or an IP denial is active.
      const phantomHot = /deny=[1-9]|challenge=[1-9]|Active IP denials:/.test(phantom);
      const sig = JSON.stringify({
        d: s.denials.map((d) => d.ip + ':' + d.reason),
        r: s.rows.map((r) => `${r.surface}/${r.action}:${r.n}`),
        u: s.users.map((u) => `${u.email}/${u.action}:${u.n}`),
        p: phantomHot ? phantom.replace(/\d+/g, '#').slice(0, 200) : '',
      });
      const hot = s.rows.some((r) => r.action === 'deny') || s.denials.length > 0 || phantomHot;
      if (sig === lastSig) return;
      if (!hot && !s.rows.length) { lastSig = sig; return; }
      lastSig = sig;
      const body = phantomHot ? `${accessGuard.summaryText(6)}\n\n${phantom}` : accessGuard.summaryText(6);
      const who = await sendSecurityReport(body);
      if (who) console.log(`[telegram:access] digest sent via ${who}`);
    } catch (e) {
      console.error('[telegram:access] digest failed:', e.message);
    }
  };
  setTimeout(tick, 5 * 60 * 1000);
  setInterval(tick, INTERVAL_MS);
}

// Security digest: every 12h, only when the posture signature changed.
function startSecurityReporter() {
  const INTERVAL_MS = 12 * 60 * 60 * 1000;
  let _lastSig = '';
  const tick = async () => {
    try {
      const report = await securityDigest();
      const sig = report.replace(/\d+/g, '#').slice(0, 400);
      if (sig === _lastSig) return;             // same posture — stay quiet
      _lastSig = sig;
      // Slot-7 owns this surface, but its BotFather token may not exist yet.
      // Fall through security -> recon -> coder so posture findings never vanish.
      const who = await sendSecurityReport(`🔒 *Security Posture*\n\n${report}`);
      if (who) console.log(`[telegram:security] digest sent via ${who}`);
      else console.error('[telegram:security] digest not delivered — no fleet bot had a usable chat');
    } catch (e) {
      console.error('[telegram:security] digest failed:', e.message);
    }
  };
  setTimeout(tick, 5 * 60 * 1000);
  setInterval(tick, INTERVAL_MS);
}

// Public push helpers used by index.js or other modules
module.exports = {
  initBots,
  runAgent,
  internalBillingToken,
  notifyTelegramChat,
  sendDeployStatus: (text) => alertToRole('TELEGRAM_BOT_TOKEN_2', `🚀 *Deploy*\n\n${text}`, { parse_mode: 'Markdown' }),
  sendHealthAlert: (text) => alertToRole('TELEGRAM_BOT_TOKEN_6', `⚠️ *Health Alert*\n\n${text}`, { parse_mode: 'Markdown' }),
  sendUptimeAlert: (text) => alertToRole('TELEGRAM_BOT_TOKEN_5', `🛡 *Uptime Alert*\n\n${text}`, { parse_mode: 'Markdown' }),
  // Every confirmed payment is reported here. Money events must never be silent:
  // the owner reads this chat to reconcile Stripe against the local ledger.
  sendPaymentAlert: (text) => alertToRole('TELEGRAM_BOT_TOKEN_2', `💰 *Payment received*\n\n${text}`, { parse_mode: 'Markdown' }),
  sendReconResult: (target, text) => alertToRole('TELEGRAM_BOT_TOKEN_3', `🔍 *Recon: ${target}*\n\n\`\`\`\n${text}\n\`\`\``, { parse_mode: 'Markdown' }),
  // Admin device enrollment: the passkey approval code goes to Deke's phone and
  // is never returned to the browser that asked for it.
  sendSecurityCode: (text) => alertToRole('TELEGRAM_BOT_TOKEN_6', `🔐 *Device verification*\n\n${text}`, { parse_mode: 'Markdown' }),
  ROLES,
};
