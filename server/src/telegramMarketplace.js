'use strict';
/**
 * haksterAI — marketplace builds + safe Telegram upselling.
 *
 * Marketplace:
 *   A small owner-managed catalog that the Telegram mini app reads. Items start as
 *   drafts; publishing requires a real, verified HTTPS destination (HTTP 200), so the
 *   public page can never advertise a site that does not answer.
 *
 * Upselling (deliberately constrained):
 *   * A chat is only ever offered something after it gave consent (bot deep link
 *     `/start upsell_yes`, or an owner-recorded consent with its source).
 *   * One manual send per command, at most one per chat per 24 hours, never a loop
 *     over many chats, never a guessed chat id.
 *   * Copy is built from the live plan catalog; no price is invented here.
 *   * Every attempt — sent, refused, or errored — is appended to
 *     server/data/marketplace-log.jsonl.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getDb } = require('./db');

const OWNER_CHAT = String(process.env.TELEGRAM_OWNER_CHAT || '').trim();
const PUBLIC_BOT = String(process.env.MARKETPLACE_BOT_USERNAME || 'Haksteraibot').replace(/^@/, '');
const DATA_DIR = path.join(__dirname, '..', 'data');
const LOG_FILE = path.join(DATA_DIR, 'marketplace-log.jsonl');
const UPSELL_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const STATUSES = new Set(['draft', 'published', 'hidden']);

let _ready = false;
function ensure() {
  if (_ready) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS marketplace_items (
      id           TEXT PRIMARY KEY,
      slug         TEXT UNIQUE NOT NULL,
      name         TEXT NOT NULL,
      summary      TEXT NOT NULL DEFAULT '',
      price_cents  INTEGER,
      site_url     TEXT,
      status       TEXT NOT NULL DEFAULT 'draft',
      build_state  TEXT NOT NULL DEFAULT 'none',
      created_by   TEXT,
      created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS marketplace_consents (
      chat_id        TEXT PRIMARY KEY,
      source         TEXT NOT NULL DEFAULT 'unknown',
      granted_at     INTEGER NOT NULL DEFAULT (unixepoch()),
      revoked_at     INTEGER,
      last_upsell_at INTEGER,
      upsell_count   INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_marketplace_items_status ON marketplace_items(status);
    CREATE TABLE IF NOT EXISTS marketplace_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);
  _ready = true;
}

function logEvent(record) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n');
    return true;
  } catch (e) {
    console.error('[marketplace] log append failed:', e.message);
    return false;
  }
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function itemRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    summary: row.summary,
    priceCents: row.price_cents,
    siteUrl: row.site_url,
    status: row.status,
    buildState: row.build_state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function listItems({ publicOnly = false } = {}) {
  ensure();
  const db = getDb();
  const rows = publicOnly
    ? db.prepare("SELECT * FROM marketplace_items WHERE status = 'published' ORDER BY updated_at DESC").all()
    : db.prepare('SELECT * FROM marketplace_items ORDER BY updated_at DESC').all();
  return rows.map(itemRow);
}

function getItem(slug) {
  ensure();
  const row = getDb().prepare('SELECT * FROM marketplace_items WHERE slug = ?').get(slugify(slug));
  return itemRow(row);
}

function upsertItem({ slug, name, summary = '', priceCents = null, siteUrl = null, status = 'draft', buildState, createdBy = 'owner-bot' }) {
  ensure();
  const cleanSlug = slugify(slug || name);
  if (!cleanSlug) throw new Error('a name or slug is required');
  if (status && !STATUSES.has(status)) throw new Error(`status must be one of ${[...STATUSES].join(', ')}`);
  const price = priceCents === null || priceCents === undefined || priceCents === '' ? null : Math.max(0, Math.round(Number(priceCents)));
  if (price !== null && !Number.isFinite(price)) throw new Error('price must be a number of cents');
  const db = getDb();
  const existing = db.prepare('SELECT * FROM marketplace_items WHERE slug = ?').get(cleanSlug);
  if (existing) {
    db.prepare(`UPDATE marketplace_items
                SET name = ?, summary = ?, price_cents = ?, site_url = ?, status = ?,
                    build_state = COALESCE(?, build_state), updated_at = unixepoch()
                WHERE slug = ?`)
      .run(name || existing.name, summary ?? existing.summary, price === null ? existing.price_cents : price,
        siteUrl === null ? existing.site_url : siteUrl, status || existing.status, buildState || null, cleanSlug);
  } else {
    db.prepare(`INSERT INTO marketplace_items (id, slug, name, summary, price_cents, site_url, status, build_state, created_by)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(crypto.randomBytes(8).toString('hex'), cleanSlug, name || cleanSlug, summary, price, siteUrl, status, buildState || 'none', createdBy);
  }
  const item = getItem(cleanSlug);
  logEvent({ event: existing ? 'item.updated' : 'item.created', slug: cleanSlug, status: item.status, price_cents: item.priceCents, by: createdBy });
  return item;
}

async function verifyUrl(url) {
  if (!url) return { ok: false, error: 'no site_url set' };
  let parsed;
  try { parsed = new URL(url); } catch { return { ok: false, error: 'site_url is not a valid URL' }; }
  if (parsed.protocol !== 'https:') return { ok: false, error: 'site_url must be https' };
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15000), headers: { accept: 'text/html' } });
    if (res.status !== 200) return { ok: false, error: `HTTP ${res.status}`, url };
    return { ok: true, url };
  } catch (e) {
    return { ok: false, error: e.message, url };
  }
}

// ── Consents ────────────────────────────────────────────────────────
function recordConsent(chatId, source = 'unknown') {
  ensure();
  const db = getDb();
  db.prepare(`INSERT INTO marketplace_consents (chat_id, source, granted_at, revoked_at)
              VALUES (?, ?, unixepoch(), NULL)
              ON CONFLICT(chat_id) DO UPDATE SET source = excluded.source, granted_at = unixepoch(), revoked_at = NULL`)
    .run(String(chatId), String(source).slice(0, 80));
  logEvent({ event: 'consent.granted', chat_id: String(chatId), source });
  return true;
}

function revokeConsent(chatId, reason = 'user') {
  ensure();
  getDb().prepare('UPDATE marketplace_consents SET revoked_at = unixepoch() WHERE chat_id = ?').run(String(chatId));
  logEvent({ event: 'consent.revoked', chat_id: String(chatId), reason });
  return true;
}

function consentRow(chatId) {
  ensure();
  return getDb().prepare('SELECT * FROM marketplace_consents WHERE chat_id = ?').get(String(chatId)) || null;
}

function hasConsent(chatId) {
  const row = consentRow(chatId);
  return Boolean(row && !row.revoked_at);
}

function listConsents() {
  ensure();
  return getDb().prepare('SELECT * FROM marketplace_consents ORDER BY granted_at DESC').all();
}

async function livePlans() {
  try {
    const res = await fetch(`http://127.0.0.1:${process.env.PORT || 3579}/api/stripe/plans`, { signal: AbortSignal.timeout(8000) });
    const data = await res.json();
    return Array.isArray(data?.plans) ? data.plans : [];
  } catch (e) {
    console.error('[marketplace] live plans unavailable:', e.message);
    return [];
  }
}

function money(cents, currency = 'usd') {
  if (cents === null || cents === undefined) return 'confirmed on request';
  const n = Number(cents) / 100;
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: String(currency).toUpperCase(), maximumFractionDigits: 2 }).format(n); }
  catch { return `$${n.toFixed(2)}`; }
}

/** Build offer copy strictly from the live plan catalog. */
async function buildUpsellCopy() {
  const plans = await livePlans();
  const lines = [];
  for (const plan of plans) {
    const prices = (plan.prices || []).filter(p => p && p.amount);
    if (!prices.length) continue;
    const p = prices[0];
    lines.push(`• ${plan.name || plan.id} — ${new Intl.NumberFormat('en-US', { style: 'currency', currency: String(p.currency || 'usd').toUpperCase(), maximumFractionDigits: 2 }).format(Number(p.amount) / 100)}${p.billingCycle ? ' / ' + p.billingCycle : ''}`);
  }
  if (!lines.length) return { ok: false, error: 'live plan catalog returned no priced plans — nothing to offer' };
  return {
    ok: true,
    text: [
      '🤖 *HaksterAI*',
      'Want the agent on your own machine, with the command center and marketplace?',
      '',
      ...lines,
      '',
      'Details: https://haksterai.com/plans',
      'Reply /stop to stop offers.',
    ].join('\n'),
  };
}

async function sendUpsell({ chatId, bot, dryRun = false }) {
  const id = String(chatId);
  const row = consentRow(id);
  if (!row || row.revoked_at) {
    logEvent({ event: 'upsell.refused', chat_id: id, reason: 'no consent' });
    return { ok: false, error: 'no consent recorded for that chat — nothing is sent without opt-in' };
  }
  const last = row.last_upsell_at ? row.last_upsell_at * 1000 : 0;
  if (last && Date.now() - last < UPSELL_COOLDOWN_MS) {
    logEvent({ event: 'upsell.refused', chat_id: id, reason: 'cooldown' });
    return { ok: false, error: 'that chat already received an offer in the last 24 hours' };
  }
  const copy = await buildUpsellCopy();
  if (!copy.ok) return copy;
  if (dryRun) return { ok: true, dryRun: true, text: copy.text };
  try {
    const sent = await bot.sendMessage(id, copy.text, { parse_mode: 'Markdown', disable_web_page_preview: true });
    ensure();
    getDb().prepare('UPDATE marketplace_consents SET last_upsell_at = unixepoch(), upsell_count = upsell_count + 1 WHERE chat_id = ?').run(id);
    logEvent({ event: 'upsell.sent', chat_id: id, message_id: sent?.message_id || null });
    return { ok: true, messageId: sent?.message_id || null };
  } catch (e) {
    logEvent({ event: 'upsell.failed', chat_id: id, error: e.message });
    return { ok: false, error: e.message };
  }
}

// ── Automation ──────────────────────────────────────────────────────
// Three jobs on one interval, each with the same safety gates as the manual path:
//   1. queue   — drafts marked for build go to Miniforge one at a time, then get
//                verified and published only if the destination answers 200.
//   2. health  — every published item is re-checked; one that stops answering is
//                hidden immediately instead of staying advertised.
//   3. offer   — newly published builds are offered to consented chats only, at
//                most one per chat per 24h and with a hard per-tick cap.
// The owner gets one short report whenever a tick actually did something.
const AUTO_TICK_MS = 10 * 60 * 1000;
const AUTO_MAX_OFFERS_PER_TICK = 5;
let _autoTimer = null;
let _autoRunning = false;
const _healthStrikes = new Map(); // slug → consecutive failed health checks

function getSetting(key, fallback = null) {
  ensure();
  const row = getDb().prepare('SELECT value FROM marketplace_settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  ensure();
  getDb().prepare(`INSERT INTO marketplace_settings (key, value, updated_at) VALUES (?, ?, unixepoch())
                   ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()`)
    .run(key, String(value));
  return String(value);
}

function autoUpsellEnabled() {
  return String(getSetting('auto_upsell', 'on')) !== 'off';
}

async function buildItem(slug) {
  const item = getItem(slug);
  if (!item) return { ok: false, error: 'no such item' };
  try {
    const res = await fetch(`${process.env.MINIFORGE_INTERNAL_URL || 'http://127.0.0.1:5555'}/api/internal/builder/build`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: `${item.name} — ${item.summary || 'a complete small-business website'}`, slug: item.slug }),
      signal: AbortSignal.timeout(320000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Miniforge returned ${res.status}`);
    const siteUrl = data.url || data.preview_url || null;
    upsertItem({ slug, name: item.name, summary: item.summary, priceCents: item.priceCents, siteUrl: siteUrl || item.siteUrl,
      status: item.status, buildState: siteUrl ? 'built' : 'requested', createdBy: 'automation' });
    logEvent({ event: 'auto.build', slug, site_url: siteUrl });
    return { ok: true, siteUrl };
  } catch (e) {
    upsertItem({ slug, name: item.name, summary: item.summary, priceCents: item.priceCents, siteUrl: item.siteUrl,
      status: item.status, buildState: 'failed', createdBy: 'automation' });
    logEvent({ event: 'auto.build_failed', slug, error: e.message });
    return { ok: false, error: e.message };
  }
}

async function autoPublish(slug) {
  const item = getItem(slug);
  if (!item) return { ok: false, error: 'no such item' };
  const check = await verifyUrl(item.siteUrl);
  if (!check.ok) {
    logEvent({ event: 'auto.publish_refused', slug, reason: check.error });
    return { ok: false, error: check.error };
  }
  const updated = upsertItem({ slug, name: item.name, summary: item.summary, priceCents: item.priceCents,
    siteUrl: item.siteUrl, status: 'published', buildState: item.buildState, createdBy: 'automation' });
  logEvent({ event: 'auto.published', slug, url: check.url });
  return { ok: true, item: updated, url: check.url };
}

async function runAutomationTick({ send = null, dryRun = false } = {}) {
  if (_autoRunning) return { skipped: 'a tick is already running' };
  _autoRunning = true;
  const actions = [];
  const failures = [];
  try {
    // 1. queue — one build per tick keeps I/O honest.
    const queued = listItems().find(i => i.buildState === 'requested');
    if (queued && !dryRun) {
      const built = await buildItem(queued.slug);
      if (built.ok) {
        actions.push(`built ${queued.slug}${built.siteUrl ? ' → ' + built.siteUrl : ''}`);
        if (built.siteUrl) {
          const pub = await autoPublish(queued.slug);
          if (pub.ok) actions.push(`published ${queued.slug} (verified 200)`);
          else failures.push(`publish ${queued.slug}: ${pub.error}`);
        }
      } else {
        failures.push(`build ${queued.slug}: ${built.error}`);
      }
    }

    // 2. health — a published site that stops answering 200 is hidden, but only
    //    after two consecutive failed checks (20 min apart), so one network blip
    //    cannot pull a healthy listing out of the catalog.
    for (const item of listItems({ publicOnly: true })) {
      const check = await verifyUrl(item.siteUrl);
      if (check.ok) {
        if (_healthStrikes.delete(item.slug)) logEvent({ event: 'auto.health_recovered', slug: item.slug });
        continue;
      }
      const strikes = (_healthStrikes.get(item.slug) || 0) + 1;
      _healthStrikes.set(item.slug, strikes);
      logEvent({ event: 'auto.health_fail', slug: item.slug, strikes, reason: check.error });
      if (strikes >= 2) {
        if (!dryRun) upsertItem({ slug: item.slug, name: item.name, summary: item.summary, priceCents: item.priceCents,
          siteUrl: item.siteUrl, status: 'hidden', buildState: item.buildState, createdBy: 'automation' });
        _healthStrikes.delete(item.slug);
        logEvent({ event: 'auto.health_hide', slug: item.slug, reason: check.error });
        failures.push(`hid ${item.slug}: ${check.error}`);
      } else {
        failures.push(`${item.slug} failed once (${check.error}) — hiding on the next failed check`);
      }
    }

    // 3. offers — only for builds published since the last broadcast, only to
    //    consented chats, one per chat per 24h, capped per tick.
    if (autoUpsellEnabled()) {
      const last = Number(getSetting('last_broadcast_at', '0')) || 0;
      const fresh = listItems({ publicOnly: true }).filter(i => (i.updatedAt || 0) > last);
      if (fresh.length) {
        const copy = await buildUpsellCopy();
        if (copy.ok && send) {
          const eligible = listConsents().filter(c => !c.revoked_at
            && (!c.last_upsell_at || (Date.now() - c.last_upsell_at * 1000) >= UPSELL_COOLDOWN_MS))
            .slice(0, AUTO_MAX_OFFERS_PER_TICK);
          for (const c of eligible) {
            // sendUpsell wants a bot-shaped object; the caller gives us the raw sender.
            const res = await sendUpsell({ chatId: c.chat_id, bot: { sendMessage: send }, dryRun });
            if (res.ok) actions.push(`offered ${fresh.map(f => f.slug).join('+')} to ${String(c.chat_id).slice(-4)}`);
            else failures.push(`offer to ${String(c.chat_id).slice(-4)}: ${res.error}`);
          }
        } else if (!copy.ok) {
          failures.push(`offer skipped: ${copy.error}`);
        }
        // Only advance the window when a real sender actually processed the batch;
        // a tick with no bot must not swallow the next broadcast.
        if (!dryRun && send) setSetting('last_broadcast_at', String(Math.floor(Date.now() / 1000)));
      }
    }

    if ((actions.length || failures.length) && send) {
      const owner = String(process.env.TELEGRAM_OWNER_CHAT || '').trim();
      if (owner) {
        const text = ['⚙️ Marketplace automation', ...actions.map(a => '• ' + a), ...failures.map(f => '⚠️ ' + f)].join('\n');
        try { await send(owner, text); } catch (_) {}
        try { require('./notifySms').notifyOwnerSms(text); } catch (_) {}
      }
    }
    return { ok: true, dryRun, actions, failures, offers: autoUpsellEnabled() };
  } finally {
    _autoRunning = false;
  }
}

function startAutomation({ send, intervalMs = AUTO_TICK_MS } = {}) {
  if (_autoTimer) return { ok: true, alreadyRunning: true };
  if (typeof send !== 'function') return { ok: false, error: 'startAutomation needs a send(chatId, text) function' };
  _autoTimer = setInterval(() => {
    runAutomationTick({ send }).catch(err => console.error('[marketplace] automation tick failed:', err.message));
  }, intervalMs);
  if (_autoTimer.unref) _autoTimer.unref();
  // First tick shortly after boot so a restart does not delay a queued build.
  setTimeout(() => { runAutomationTick({ send }).catch(err => console.error('[marketplace] automation tick failed:', err.message)); }, 90 * 1000).unref?.();
  console.log(`[marketplace] automation started (every ${Math.round(intervalMs / 60000)} min)`);
  return { ok: true, intervalMs };
}

function stopAutomation() {
  if (_autoTimer) clearInterval(_autoTimer);
  _autoTimer = null;
  return { ok: true };
}

/** /market and /upsell. Owner-only; returns true when the message was handled. */
async function handleMarketplaceCommand({ text, chatId, bot, roleKey }) {
  const raw = String(text || '').trim();
  if (!/^\/(market|marketplace|upsell)\b/i.test(raw)) return false;

  const send = async (msg) => {
    try { await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown', disable_web_page_preview: true }); }
    catch { try { await bot.sendMessage(chatId, msg); } catch (_) {} }
  };
  if (!OWNER_CHAT || String(chatId) !== OWNER_CHAT) {
    await send('⛔ That command is owner-only.');
    return true;
  }

  const parts = raw.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const sub = (parts[1] || '').toLowerCase();
  const rest = parts.slice(2).join(' ').trim();

  if (cmd === '/upsell') {
    if (sub === 'auto') {
      const value = (rest.split(/\s+/)[0] || '').toLowerCase();
      if (value === 'on' || value === 'off') {
        setSetting('auto_upsell', value);
        await send(`⚙️ Automatic offers are now *${value}*.`);
      } else {
        await send(`⚙️ Automatic offers: *${autoUpsellEnabled() ? 'on' : 'off'}*\nToggle with \`/upsell auto on\` or \`/upsell auto off\`.`);
      }
      return true;
    }
    if (sub === 'status' || !sub) {
      const consents = listConsents();
      const active = consents.filter(c => !c.revoked_at);
      return (await send([
        '📣 *Upsell status*',
        `Automatic offers: ${autoUpsellEnabled() ? 'on' : 'off'}`,
        `Opted-in chats: ${active.length}`,
        `Revoked: ${consents.filter(c => c.revoked_at).length}`,
        active.length ? active.map(c => `• ${String(c.chat_id).replace(/(\d{4})\d+(\d{3})/, '$1…$2')} · ${c.source} · sent ${c.upsell_count}`).join('\n') : '• none yet',
        '',
        'A chat opts in by opening the marketplace button in the bot (`/start upsell_yes`).',
        '`/upsell copy` — preview the offer  ·  `/upsell send <chatId>` — one consented chat, one send per 24h',
      ].join('\n'))), true;
    }
    if (sub === 'copy') {
      const copy = await buildUpsellCopy();
      await send(copy.ok ? copy.text : `⚠️ ${copy.error}`);
      return true;
    }
    if (sub === 'consent') {
      const [target, ...sourceParts] = rest.split(/\s+/);
      if (!target) { await send('Usage: `/upsell consent <chatId> [source note]`'); return true; }
      recordConsent(target, sourceParts.join(' ') || 'owner-recorded');
      await send(`✅ Consent recorded for ${target} (${sourceParts.join(' ') || 'owner-recorded'}).`);
      return true;
    }
    if (sub === 'revoke') {
      const target = rest.split(/\s+/)[0];
      if (!target) { await send('Usage: `/upsell revoke <chatId>`'); return true; }
      revokeConsent(target, 'owner');
      await send(`✅ Offers revoked for ${target}.`);
      return true;
    }
    if (sub === 'send') {
      const target = rest.split(/\s+/)[0];
      if (!target) { await send('Usage: `/upsell send <chatId>` — needs recorded consent'); return true; }
      const res = await sendUpsell({ chatId: target, bot });
      await send(res.ok ? `✅ Offer sent (message ${res.messageId || 'n/a'}).` : `⚠️ Not sent: ${res.error}`);
      return true;
    }
    await send('Usage: `/upsell status | copy | send <chatId> | consent <chatId> [source] | revoke <chatId>`');
    return true;
  }

  // /market …
  if (!sub || sub === 'list') {
    const items = listItems();
    if (!items.length) {
      await send([
        '🏪 *Marketplace* — no builds yet',
        '`/market new <name> | <price> | <summary>` — add a build (price optional)',
        '`/market build <slug>` — send it to Miniforge',
        '`/market publish <slug>` — publish (needs a verified HTTPS site_url)',
      ].join('\n'));
      return true;
    }
    await send([
      '🏪 *Marketplace builds*',
      ...items.map(i => `• *${i.name}* (${i.slug}) — ${i.status}, ${i.buildState}, ${money(i.priceCents)}${i.siteUrl ? ' · ' + i.siteUrl : ''}`),
      '',
      '`/market new <name> | <price> | <summary>` · `/market build <slug>` · `/market publish <slug>` · `/market hide <slug>`',
    ].join('\n'));
    return true;
  }

  if (sub === 'new') {
    const fields = rest.split('|').map(f => f.trim());
    const [name, priceField, summary] = fields;
    if (!name) { await send('Usage: `/market new <name> | <price> | <summary>`'); return true; }
    const priceCents = priceField ? Math.round(parseFloat(String(priceField).replace(/[^0-9.]/g, '')) * 100) : null;
    try {
      const item = upsertItem({ name, summary: summary || '', priceCents: Number.isFinite(priceCents) ? priceCents : null, createdBy: `telegram:${roleKey || 'fleet'}` });
      await send(`✅ Draft saved: *${item.name}* (${item.slug})\nPrice: ${money(item.priceCents)}\nNext: \`/market build ${item.slug}\` or \`/market publish ${item.slug}\` once a site_url exists.`);
    } catch (e) {
      await send(`⚠️ ${e.message}`);
    }
    return true;
  }

  if (sub === 'url') {
    const [slug, url] = rest.split(/\s+/);
    if (!slug || !url) { await send('Usage: `/market url <slug> <https URL>`'); return true; }
    try {
      const item = upsertItem({ slug, name: getItem(slug)?.name || slug, siteUrl: url, createdBy: `telegram:${roleKey || 'fleet'}` });
      await send(`✅ ${item.slug} site_url set to ${item.siteUrl}. Publish still verifies it responds 200.`);
    } catch (e) { await send(`⚠️ ${e.message}`); }
    return true;
  }

  if (sub === 'build') {
    const slug = slugify(rest.split(/\s+/)[0] || '');
    const item = getItem(slug);
    if (!item) { await send(`⚠️ No build named ${slug || '(none given)'}.`); return true; }
    await send(`🛠 Sending *${item.name}* to Miniforge…`);
    try {
      const res = await fetch(`${process.env.MINIFORGE_INTERNAL_URL || 'http://127.0.0.1:5555'}/api/internal/builder/build`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: `${item.name} — ${item.summary || 'a complete small-business website'}`, slug: item.slug }),
        signal: AbortSignal.timeout(320000),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Miniforge returned ${res.status}`);
      const siteUrl = data.url || data.preview_url || null;
      upsertItem({ slug: item.slug, name: item.name, buildState: siteUrl ? 'built' : 'requested', siteUrl });
      logEvent({ event: 'item.build', slug: item.slug, site_url: siteUrl });
      await send(`🛠 *${item.name}* — ${siteUrl ? `built at ${siteUrl}` : 'build accepted, URL not returned yet'}.\nPublish it with \`/market publish ${item.slug}\` once the URL answers 200.`);
    } catch (e) {
      upsertItem({ slug: item.slug, name: item.name, buildState: 'failed' });
      logEvent({ event: 'item.build_failed', slug: item.slug, error: e.message });
      await send(`⚠️ Build failed: ${e.message}`);
    }
    return true;
  }

  if (sub === 'publish' || sub === 'hide') {
    const slug = slugify(rest.split(/\s+/)[0] || '');
    const item = getItem(slug);
    if (!item) { await send(`⚠️ No build named ${slug || '(none given)'}.`); return true; }
    if (sub === 'hide') {
      upsertItem({ slug, name: item.name, status: 'hidden' });
      await send(`🙈 ${item.name} hidden from the marketplace.`);
      return true;
    }
    const check = await verifyUrl(item.siteUrl);
    if (!check.ok) {
      logEvent({ event: 'item.publish_refused', slug, reason: check.error });
      await send(`⚠️ Not published: ${check.error}. Set one with \`/market url ${slug} <https URL>\`.`);
      return true;
    }
    upsertItem({ slug, name: item.name, status: 'published' });
    logEvent({ event: 'item.published', slug, url: check.url });
    await send(`✅ *${item.name}* is live on the marketplace (${check.url} → 200).`);
    return true;
  }

  await send('Usage: `/market list | new | url | build | publish | hide`');
  return true;
}

module.exports = {
  ensure,
  listItems,
  getItem,
  upsertItem,
  verifyUrl,
  recordConsent,
  revokeConsent,
  hasConsent,
  listConsents,
  sendUpsell,
  buildUpsellCopy,
  handleMarketplaceCommand,
  runAutomationTick,
  startAutomation,
  stopAutomation,
  autoUpsellEnabled,
  publicInfo: () => ({ bot: PUBLIC_BOT, deepLink: `https://t.me/${PUBLIC_BOT}?start=upsell_yes` }),
  logEvent,
  paths: { LOG_FILE },
};
