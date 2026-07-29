'use strict';

// Load .env FIRST — before any other code
const fs = require('fs');
const path = require('path');
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) process.env[match[1]] = match[2].trim();
  });
}

/**
 * Telegram → Miniapps.ai Bot Bridge
 * 
 * Wires 6 Telegram BotFather bots to miniapps.ai bots via Miniforge.
 * Each Telegram bot maps to a miniapps.ai bot slug.
 * When a user messages the Telegram bot, it forwards to the miniapps.ai bot
 * via Miniforge's chat API and returns the response.
 *
 * Architecture:
 *   Telegram user → BotFather → this bridge → Miniforge (localhost:5555) → miniapps.ai API
 *   Response flows back: miniapps.ai → Miniforge → this bridge → Telegram user
 */

const https = require('https');
const http = require('http');

// --- Config ---
const MINIFORGE_URL = process.env.MINIFORGE_URL || 'http://localhost:5555';
const TELEGRAM_API = 'https://api.telegram.org';

// Load Telegram bot tokens from env
const BOT_TOKENS = [];
for (let i = 1; i <= 6; i++) {
  const token = process.env[`TELEGRAM_BOT_TOKEN_${i}`];
  if (token) BOT_TOKENS.push(token);
}

// Map each Telegram bot index to a miniapps.ai bot slug
// Bot 1 = hack/exploit bot, Bot 2 = coding, Bot 3 = AI chat, Bot 4 = roleplay, Bot 5 = security, Bot 6 = general
const BOT_MAPPING = {
  0: { slug: 'cheat', name: 'HackBot', desc: 'Hacking & exploit assistant' },
  1: { slug: 'chatgpt', name: 'CodeBot', desc: 'Coding & development assistant' },
  2: { slug: 'claude-4-6-sonnet', name: 'AIBot', desc: 'General AI assistant' },
  3: { slug: 'dream-roleplay', name: 'RoleBot', desc: 'Roleplay & creative chat' },
  4: { slug: 'promptsmith', name: 'SecBot', desc: 'Security & prompt engineering' },
  5: { slug: 'chatgpt-5', name: 'GenBot', desc: 'General purpose chat' },
};

// Per-bot conversation history (in-memory, keyed by chatId+botIndex)
const chatHistories = new Map();
const MAX_HISTORY = 10;

// --- HTTP helpers ---
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 30000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(null); }
      });
    }).on('error', reject);
  });
}

function httpsPost(url, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const postData = JSON.stringify(body);
    const options = {
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
      timeout: 60000, // miniapps bots can take a while to respond
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(postData);
    req.end();
  });
}

function httpPost(url, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const postData = JSON.stringify(body);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || 80,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
      timeout: 60000,
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(postData);
    req.end();
  });
}

// --- Telegram API ---
async function tgGetMe(token) {
  return httpsGet(`${TELEGRAM_API}/bot${token}/getMe`);
}

async function tgGetUpdates(token, offset) {
  const url = `${TELEGRAM_API}/bot${token}/getUpdates?timeout=30&offset=${offset}&allowed_updates=["message"]`;
  return httpsGet(url);
}

async function tgSendMessage(token, chatId, text, replyToId) {
  return httpsPost(`${TELEGRAM_API}/bot${token}/sendMessage`, {
    chat_id: chatId,
    text: text,
    parse_mode: 'HTML',
    reply_to_message_id: replyToId || undefined,
  });
}

async function tgSendPhoto(token, chatId, photoUrl, caption) {
  return httpsPost(`${TELEGRAM_API}/bot${token}/sendPhoto`, {
    chat_id: chatId,
    photo: photoUrl,
    caption: caption || undefined,
    parse_mode: 'HTML',
  });
}

async function tgSendTyping(token, chatId) {
  return httpsPost(`${TELEGRAM_API}/bot${token}/sendChatAction`, {
    chat_id: chatId,
    action: 'typing',
  });
}

// --- Miniapps.ai chat via Miniforge ---
async function chatWithMiniappsBot(slug, message, history) {
  try {
    const resp = await httpPost(`${MINIFORGE_URL}/api/apps/${slug}/chat`, {
      message: message,
      history: history || [],
    });
    if (resp && resp.response) return resp.response;
    if (resp && resp.text) return resp.text;
    if (resp && resp.reply) return resp.reply;
    if (typeof resp === 'string') return resp;
    return '⚠️ Bot returned no response. Try again.';
  } catch (err) {
    // Fallback: try direct miniapps.ai API
    console.error(`[bridge] Miniforge chat failed for ${slug}: ${err.message}`);
    try {
      const direct = await httpsPost(`https://api.miniapps.ai/tools/${slug}/chat`, {
        message: message,
        history: history || [],
      });
      if (direct && direct.response) return direct.response;
      if (direct && direct.text) return direct.text;
      return '⚠️ Bot unavailable right now.';
    } catch (err2) {
      console.error(`[bridge] Direct miniapps chat also failed: ${err2.message}`);
      return `⚠️ Could not reach bot. Error: ${err2.message}`;
    }
  }
}

// --- Bot list command ---
async function getBotList() {
  try {
    const resp = await httpPost(`${MINIFORGE_URL}/api/apps/search`, { query: '', limit: 20 });
    if (resp && resp.bots) return resp.bots;
    if (resp && resp.items) return resp.items;
    return null;
  } catch {
    return null;
  }
}

// --- Message handler ---
async function handleMessage(token, botIndex, msg) {
  if (!msg || !msg.text) return;
  const chatId = msg.chat.id;
  const text = msg.text.trim();
  const mapping = BOT_MAPPING[botIndex] || BOT_MAPPING[0];
  const historyKey = `${chatId}:${botIndex}`;

  // /start command
  if (text === '/start') {
    await tgSendMessage(token, chatId,
      `🤖 <b>${mapping.name}</b>\n` +
      `📋 ${mapping.desc}\n\n` +
      `Connected to miniapps.ai bot: <code>${mapping.slug}</code>\n\n` +
      `Just send me a message and I'll forward it to the AI bot!\n\n` +
      `Commands:\n` +
      `/start - Show this help\n` +
      `/bots - List available miniapps.ai bots\n` +
      `/switch <slug> - Switch to a different miniapps.ai bot\n` +
      `/clear - Clear conversation history\n` +
      `/info - Show current bot info`
    );
    return;
  }

  // /bots command
  if (text === '/bots') {
    await tgSendTyping(token, chatId);
    const bots = await getBotList();
    if (bots && bots.length > 0) {
      let list = '🤖 <b>Available miniapps.ai bots:</b>\n\n';
      bots.slice(0, 20).forEach((b, i) => {
        const slug = b.slug || b.id;
        const title = b.title || b.name || slug;
        list += `${i + 1}. <code>${slug}</code> — ${title}\n`;
      });
      list += '\nUse /switch <slug> to switch bots';
      await tgSendMessage(token, chatId, list);
    } else {
      await tgSendMessage(token, chatId, '⚠️ Could not fetch bot list. Miniforge may be offline.');
    }
    return;
  }

  // /switch command
  if (text.startsWith('/switch ')) {
    const newSlug = text.split(' ')[1].trim();
    BOT_MAPPING[botIndex] = { ...mapping, slug: newSlug };
    chatHistories.delete(historyKey);
    await tgSendMessage(token, chatId,
      `✅ Switched to bot: <code>${newSlug}</code>\nHistory cleared. Start chatting!`
    );
    return;
  }

  // /clear command
  if (text === '/clear') {
    chatHistories.delete(historyKey);
    await tgSendMessage(token, chatId, '✅ Conversation history cleared.');
    return;
  }

  // /info command
  if (text === '/info') {
    await tgSendMessage(token, chatId,
      `ℹ️ <b>Current Bot Info</b>\n` +
      `Name: ${mapping.name}\n` +
      `Miniapps slug: <code>${mapping.slug}</code>\n` +
      `Description: ${mapping.desc}\n` +
      `History entries: ${chatHistories.get(historyKey)?.length || 0}`
    );
    return;
  }

  // Regular message — forward to miniapps.ai bot
  await tgSendTyping(token, chatId);

  // Get history
  let history = chatHistories.get(historyKey) || [];

  // Add user message to history
  history.push({ role: 'user', content: text });

  // Trim history
  if (history.length > MAX_HISTORY * 2) {
    history = history.slice(-MAX_HISTORY * 2);
  }

  // Chat with miniapps.ai bot
  const response = await chatWithMiniappsBot(mapping.slug, text, history);

  // Add bot response to history
  history.push({ role: 'assistant', content: response });
  chatHistories.set(historyKey, history);

  // Send response to Telegram (split if too long — Telegram limit is 4096 chars)
  const chunks = [];
  let remaining = response;
  while (remaining.length > 4000) {
    let split = remaining.lastIndexOf('\n', 4000);
    if (split < 1000) split = 4000;
    chunks.push(remaining.slice(0, split));
    remaining = remaining.slice(split).trim();
  }
  chunks.push(remaining);

  for (const chunk of chunks) {
    await tgSendMessage(token, chatId, chunk, msg.message_id);
  }
}

// --- Long-polling loop per bot ---
async function pollBot(token, botIndex) {
  let offset = 0;
  const me = await tgGetMe(token);
  if (!me || !me.ok) {
    console.error(`[bridge] Bot ${botIndex + 1}: getMe failed — invalid token`);
    return;
  }
  const botName = me.result.username;
  const mapping = BOT_MAPPING[botIndex] || BOT_MAPPING[0];
  console.log(`[bridge] Bot ${botIndex + 1} @${botName} → miniapps.ai/${mapping.slug} (online)`);

  while (true) {
    try {
      const updates = await tgGetUpdates(token, offset);
      if (!updates || !updates.ok || !updates.result) {
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }
      for (const update of updates.result) {
        offset = update.update_id + 1;
        if (update.message) {
          // Handle in background — don't block polling
          handleMessage(token, botIndex, update.message).catch(err => {
            console.error(`[bridge] Message handler error: ${err.message}`);
          });
        }
      }
    } catch (err) {
      console.error(`[bridge] Polling error for bot ${botIndex + 1}: ${err.message}`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

// --- Start all bots ---
async function startBridge() {
  if (BOT_TOKENS.length === 0) {
    console.error('[bridge] No TELEGRAM_BOT_TOKEN_* env vars found');
    return;
  }
  console.log(`[bridge] Starting ${BOT_TOKENS.length} Telegram bots → miniapps.ai bridge`);
  console.log(`[bridge] Miniforge URL: ${MINIFORGE_URL}`);

  // Start each bot in parallel
  for (let i = 0; i < BOT_TOKENS.length; i++) {
    pollBot(BOT_TOKENS[i], i).catch(err => {
      console.error(`[bridge] Bot ${i + 1} crashed: ${err.message}`);
    });
    // Stagger start to avoid rate limits
    await new Promise(r => setTimeout(r, 1000));
  }
}

// Export for use by haksterAi server
module.exports = { startBridge, chatWithMiniappsBot, getBotList, BOT_MAPPING };

// Auto-start if run directly
// Auto-start if run directly
if (require.main === module) {
  startBridge();
}