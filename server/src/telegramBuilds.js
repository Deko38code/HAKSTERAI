'use strict';
/**
 * haksterAI — Telegram build desk: paid app builds, plans and purchases,
 * shared by every live fleet bot.
 *
 * Why this module exists:
 *   `/build`, `/image`, `/snap` and `/subscribe` used to live only in the
 *   command-bot branch of telegramBots.js. That bot's token is revoked, so in
 *   practice every build in Telegram was dead — and every build that did run
 *   was unmetered: the bot called Miniforge's internal builder with no account
 *   and no charge.
 *
 * Rules this module keeps:
 *   * Builds are included with a paid plan. A free or unknown chat gets an
 *     honest paywall that opens the real Stripe checkout for the live plan
 *     catalog — no invented prices and no pretend unlock.
 *   * The owner chat keeps its operator access.
 *   * Every build attempt (allowed or refused) is appended to
 *     data/build-log.jsonl so a build is never invisible.
 *   * Buying a marketplace item uses the item's own owner-set price only;
 *     an item without a price says "confirmed on request" and never charges.
 */

const fs = require('fs');
const path = require('path');
const { getDb } = require('./db');
const siteKeys = require('./telegramSiteKeys');

const DATA_DIR = path.join(__dirname, '..', 'data');
const BUILD_LOG = path.join(DATA_DIR, 'build-log.jsonl');
const PAID_PLANS = new Set(['lite', 'starter', 'starter_plus', 'pro', 'enterprise']);

function appendJsonl(file, record) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(record) + '\n');
    return true;
  } catch (e) {
    console.error('[builds] log append failed:', e.message);
    return false;
  }
}

function userForChat(chatId) {
  try {
    return getDb().prepare('SELECT * FROM users WHERE telegram_id = ?').get(String(chatId)) || null;
  } catch (e) {
    console.error('[builds] user lookup failed:', e.message);
    return null;
  }
}

// A chat may build when the owner is asking, or when its account holds a paid
// plan with a subscription that has not lapsed.
function buildAccess(chatId) {
  if (siteKeys.isOwnerChat(chatId)) return { allowed: true, plan: 'owner', user: null, reason: 'owner chat' };
  const user = userForChat(chatId);
  if (!user) return { allowed: false, plan: 'none', user: null, reason: 'no account yet' };
  if (user.status && user.status !== 'active') return { allowed: false, plan: user.plan || 'free', user, reason: 'account not active' };
  const plan = String(user.plan || 'free');
  if (!PAID_PLANS.has(plan)) return { allowed: false, plan, user, reason: 'no paid plan' };
  try {
    const sub = getDb().prepare(`SELECT status, current_period_end FROM subscriptions
      WHERE user_id = ? ORDER BY current_period_end DESC LIMIT 1`).get(user.id);
    const end = Number(sub?.current_period_end || 0);
    if (sub && sub.status !== 'active' && end && end * 1000 < Date.now()) {
      return { allowed: false, plan, user, reason: 'subscription expired' };
    }
  } catch (_) { /* no subscription table row: the plan column is the source */ }
  return { allowed: true, plan, user };
}

function logBuild(record) {
  return appendJsonl(BUILD_LOG, { at: new Date().toISOString(), ...record });
}

// Everything that happens at the build desk lands on the owner's phone too.
function notifyOwner(text) {
  try { require('./notifySms').notifyOwnerSms(text); } catch (_) {}
  try {
    const chat = String(process.env.TELEGRAM_OWNER_CHAT || '').trim();
    if (!chat) return Promise.resolve({ ok: false });
    return require('./telegramBots').notifyTelegramChat(chat, text).catch(() => ({ ok: false }));
  } catch (_) { return Promise.resolve({ ok: false }); }
}

function paywallText(access) {
  const who = access.user ? 'this account' : 'this chat';
  return `🔒 Building apps is included with a paid plan.\n\n${who}: ${access.plan === 'none' ? 'no plan yet' : 'plan "' + access.plan + '"'}`;
}

// /build, /image, /snap, /subscribe|/pay|/plans, /buy and /market buy.
// Returns true when the message was handled here.
async function handleBuildCommand({ text, chatId, bot, msg, miniforgeBuilder, sendSnapPhoto, sendPlanPicker }) {
  const match = /^\/build\s+([\s\S]+)$/i.exec(text);
  if (match) {
    const prompt = match[1].trim();
    if (!prompt) return bot.sendMessage(chatId, 'Usage: /build <what you want built>').then(() => true);
    const access = buildAccess(chatId);
    if (!access.allowed) {
      logBuild({ event: 'build.refused', chat_id: String(chatId), plan: access.plan, reason: access.reason, prompt: prompt.slice(0, 200) });
      notifyOwner(`🔒 Build refused — plan "${access.plan}" (${access.reason})\nRequest: ${prompt.slice(0, 140)}\nPaywall + plan picker shown.`);
      await bot.sendMessage(chatId, `${paywallText(access)}\n\nPick a plan below to start building — checkout is Stripe-hosted.`);
      if (typeof sendPlanPicker === 'function') await sendPlanPicker(bot, chatId);
      return true;
    }
    await bot.sendChatAction(chatId, 'typing');
    const status = await bot.sendMessage(chatId, `⚡ Building "${prompt}"…\nReal builder → saved app → image → OMP snapshot.`);
    // The build is charged to this chat's own account: Miniforge resolves the
    // HaksterAI account from this key, meters the same daily build allowance the
    // Create tab uses, and saves the app under that account so it shows up in
    // the user's own My Apps list — not under a fallback first user.
    const accountKey = (access.user && access.user.api_key)
      ? access.user.api_key
      : (siteKeys.isOwnerChat(chatId) ? require('./telegramEntitlements').ownerApiKey() : '');
    try {
      const built = await miniforgeBuilder('build', { prompt, haksterApiKey: accountKey });
      logBuild({
        event: 'build.ok', chat_id: String(chatId), plan: access.plan,
        user_id: access.user ? access.user.id : null,
        prompt: prompt.slice(0, 200), slug: built.slug, url: built.url, bytes: Number(built.bytes || 0),
        saved_owner: built.savedOwnerId || null, quota_remaining: built.quota ? built.quota.remaining : null,
      });
      notifyOwner(`⚡ Build done — ${built.name}\n${built.url}\nPlan: ${access.plan}`);
      const quotaLine = built.quota && Number.isFinite(Number(built.quota.remaining)) && Number(built.quota.remaining) >= 0
        ? `\nBuilds left today: ${built.quota.remaining}${built.quota.limit === -1 ? ' (unlimited)' : ' of ' + built.quota.limit}`
        : '';
      await bot.editMessageText(
        `✅ App built: ${built.name}\n${built.url}\nSource: ${Number(built.bytes || 0).toLocaleString()} bytes\nPlan: ${access.plan}\n📚 Saved in your My Apps list on haksterai.com${quotaLine}`,
        { chat_id: chatId, message_id: status.message_id }
      ).catch(() => {});
      try {
        const img = await miniforgeBuilder('image', { slug: built.slug, prompt });
        if (img.image) await bot.sendPhoto(chatId, Buffer.from(img.image, 'base64'), { caption: `🎨 ${built.name} · ${img.provider || 'image'}` });
        else await bot.sendMessage(chatId, `🎨 Image unavailable: ${img.error || 'no image returned'}`);
      } catch (e) { await bot.sendMessage(chatId, `🎨 Image failed: ${e.message}`); }
      try {
        const snap = await miniforgeBuilder('snap', { slug: built.slug });
        await sendSnapPhoto(bot, chatId, snap, `📸 ${snap.title || built.name}`);
      } catch (e) { await bot.sendMessage(chatId, `📸 Snapshot failed: ${e.message}`); }
    } catch (e) {
      logBuild({ event: 'build.failed', chat_id: String(chatId), plan: access.plan, prompt: prompt.slice(0, 200), error: e.message, status: e.status || null });
      // The account's own build allowance is used up (or the key could not be
      // verified so nothing could be charged): say so and offer the real plans.
      if (e.status === 402 || e.status === 429) {
        const quota = e.quota || {};
        const left = Number.isFinite(Number(quota.remaining)) ? Number(quota.remaining) : 0;
        notifyOwner(`🔒 Build allowance exhausted — plan "${access.plan}"\nRemaining: ${left}\nUpgrade prompt + plan picker shown.`);
        await bot.editMessageText(
          `🔒 Your daily build allowance is used up${quota.limit && quota.limit !== -1 ? ` (${quota.used || quota.limit}/${quota.limit})` : ''}.\n\nUpgrade to keep building — the same allowance covers the site's Create tab and these bots.`,
          { chat_id: chatId, message_id: status.message_id }
        ).catch(() => {});
        if (typeof sendPlanPicker === 'function') await sendPlanPicker(bot, chatId);
        return true;
      }
      if (e.status === 401) {
        await bot.editMessageText(
          '🔒 Could not verify the HaksterAI account behind this chat, so the app could not be saved to your list.\n\nSign in once at https://haksterai.com with the Google account you paid with, then send /build again.',
          { chat_id: chatId, message_id: status.message_id }
        ).catch(() => {});
        return true;
      }
      await bot.editMessageText(`❌ Build failed: ${e.message}`, { chat_id: chatId, message_id: status.message_id }).catch(() => {});
    }
    return true;
  }

  const imageMatch = /^\/image\s+(\S+)(?:\s+([\s\S]+))?$/i.exec(text);
  if (imageMatch) {
    const access = buildAccess(chatId);
    if (!access.allowed) {
      await bot.sendMessage(chatId, paywallText(access));
      if (typeof sendPlanPicker === 'function') await sendPlanPicker(bot, chatId);
      return true;
    }
    const slug = imageMatch[1];
    const prompt = (imageMatch[2] || '').trim() || `App artwork for ${slug}`;
    await bot.sendChatAction(chatId, 'upload_photo');
    try {
      const img = await miniforgeBuilder('image', { slug, prompt });
      if (img.image) await bot.sendPhoto(chatId, Buffer.from(img.image, 'base64'), { caption: `🎨 ${slug} · ${img.provider || 'image'}` });
      else await bot.sendMessage(chatId, `🎨 Image unavailable: ${img.error || 'no image returned'}`);
    } catch (e) { await bot.sendMessage(chatId, `🎨 Image failed: ${e.message}`); }
    return true;
  }

  const snapMatch = /^\/snap\s+(\S+)$/i.exec(text);
  if (snapMatch) {
    const snap = await miniforgeBuilder('snap', { slug: snapMatch[1] }).catch(e => ({ error: e.message }));
    if (snap.error) return bot.sendMessage(chatId, `📸 Snapshot failed: ${snap.error}`).then(() => true);
    await sendSnapPhoto(bot, chatId, snap, `📸 ${snap.title || snapMatch[1]}`);
    return true;
  }

  if (/^\/(?:subscribe|pay|plans)\b/i.test(text)) {
    if (typeof sendPlanPicker === 'function') await sendPlanPicker(bot, chatId);
    return true;
  }
  return false;
}

// /market buy <slug> — one-time purchase of a published marketplace build at
// the item's own owner-set price. Never charges an item with no price.
async function handleMarketBuy({ text, chatId, bot, msg, apiJson }) {
  const m = /^\/market\s+buy\s+(\S+)$/i.exec(text) || /^\/buy\s+site\s+(\S+)$/i.exec(text);
  if (!m) return false;
  const marketplace = require('./telegramMarketplace');
  const item = marketplace.getItem(m[1]);
  if (!item || item.status !== 'published') {
    await bot.sendMessage(chatId, 'That build is not listed right now. Send /market list to see what is available.');
    return true;
  }
  if (!item.priceCents || item.priceCents <= 0) {
    await bot.sendMessage(chatId, `💬 ${item.name} is priced on request — the owner confirms the quote and availability before any charge. Nothing has been charged.`);
    return true;
  }
  try {
    const result = await apiJson('POST', '/api/stripe/telegram-checkout', {
      kind: 'marketplace_item',
      slug: item.slug,
      telegramUser: { id: msg.from.id, first_name: msg.from.first_name, last_name: msg.from.last_name, username: msg.from.username },
    });
    if (!result.ok) return bot.sendMessage(chatId, `❌ Checkout failed: ${result.error}`).then(() => true);
    appendJsonl(path.join(DATA_DIR, 'marketplace-log.jsonl'), {
      at: new Date().toISOString(), event: 'marketplace.checkout_created',
      chat_id: String(chatId), slug: item.slug, price_cents: item.priceCents,
    });
    notifyOwner(`💳 Checkout started — ${item.name} · $${(item.priceCents / 100).toFixed(2)}`);
    await bot.sendMessage(chatId, `💳 ${item.name} — one-time payment. Tap below to pay with Stripe:`, {
      reply_markup: { inline_keyboard: [[{ text: '💳 Pay with Stripe', url: result.url }]] },
    });
  } catch (e) {
    await bot.sendMessage(chatId, `❌ Checkout error: ${e.message}`);
  }
  return true;
}

module.exports = {
  buildAccess,
  logBuild,
  handleBuildCommand,
  handleMarketBuy,
  BUILD_LOG,
  PAID_PLANS,
};
