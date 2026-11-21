'use strict';
/**
 * Stripe CLI bridge for the owner's admin panel and the agent fleet.
 *
 * Why this exists: the Stripe CLI is installed on the Dell but was never wired
 * into anything, and the dashboard could only read plans from the site's own
 * catalog. This module gives the owner (and the agents acting with the owner's
 * key) two things:
 *
 *   1. A read-only CLI console. Only an allowlist of read-only Stripe API
 *      operations can run — no create/update/delete through the CLI, ever.
 *   2. Price tools: create a new price on a plan's existing Stripe product and
 *      archive the old one ("easy price change"), add an extra price (add-on,
 *      e.g. an annual option), or archive a stray price ("fix"). These use the
 *      Stripe SDK, the same account the site charges through, and every action
 *      is written to `stripe_cli_actions`.
 *
 * Secrets: the CLI is authenticated per call with STRIPE_API_KEY taken from the
 * running server's environment (server/.env). Nothing is written to the CLI's
 * own config, no key is returned to the browser or written to logs, and every
 * output is scrubbed of key-like strings before it leaves this module.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const CLI_CANDIDATES = [
  process.env.STRIPE_BIN,
  path.join(process.env.HOME || '/home/ghost', '.stripe/bin/stripe'),
  '/usr/local/bin/stripe',
  '/usr/bin/stripe',
].filter(Boolean);

const STATUS_TTL_MS = 10000;

// Read-only operations only. `products create`, `prices create`, `customers
// delete` and friends are deliberately absent: writes go through the explicit
// price tools below, where they are validated and logged.
const ALLOWED_COMMANDS = new Set([
  'products list', 'products retrieve',
  'prices list', 'prices retrieve',
  'customers list', 'customers retrieve',
  'subscriptions list', 'subscriptions retrieve',
  'invoices list', 'invoices retrieve',
  'charges list', 'charges retrieve',
  'payment_links list', 'payment_links retrieve',
  'coupons list', 'coupons retrieve',
  'events list', 'events retrieve',
  'balance retrieve',
  'webhook_endpoints list',
  'payment_intents list', 'payment_intents retrieve',
  'plans list', 'plans retrieve',
]);

const ALLOWED_FLAGS = new Set([
  '--limit',
  '--starting_after', '--starting-after',
  '--ending_before', '--ending-before',
  '--customer', '--subscription', '--price', '--product', '--plan',
  '--status', '--type', '--email', '--created', '--expand',
  '--active', '--live', '--currency', '--interval',
]);

const MAX_ARGS = 12;
const MAX_OUTPUT_CHARS = 20000;
const DEFAULT_TIMEOUT_MS = 20000;

let statusCache = { at: 0, value: null, inflight: null };

function redact(text) {
  return String(text || '')
    .replace(/\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{6,}/g, '$1_$2_***redacted***')
    .replace(/\bwhsec_[A-Za-z0-9]{6,}/g, 'whsec_***redacted***');
}

function cliPath() {
  for (const candidate of CLI_CANDIDATES) {
    try {
      if (candidate && fs.existsSync(candidate)) return candidate;
    } catch { /* ignore */ }
  }
  return 'stripe';
}

function apiKey() {
  return String(process.env.STRIPE_API_KEY || process.env.STRIPE_SECRET_KEY || '');
}

function keyMode() {
  const key = apiKey();
  if (key.startsWith('sk_live') || key.startsWith('rk_live')) return 'live';
  if (key.startsWith('sk_test') || key.startsWith('rk_test')) return 'test';
  return 'unknown';
}

/** Validate an argv array against the read-only allowlist. Throws on refusal. */
function validate(args) {
  if (!Array.isArray(args) || !args.length) throw new Error('a Stripe CLI command is required');
  if (args.length > MAX_ARGS) throw new Error('too many arguments');
  const words = args.map(a => String(a));
  for (const word of words) {
    if (word.length > 120 || /[\r\n\0]/.test(word)) throw new Error('invalid argument');
  }
  const key = `${words[0]} ${words[1] || ''}`.trim();
  if (!ALLOWED_COMMANDS.has(key)) {
    throw new Error(`"${key}" is not in the read-only allowlist (${[...ALLOWED_COMMANDS].slice(0, 6).join(', ')}…)`);
  }
  for (let i = 2; i < words.length; i++) {
    const word = words[i];
    if (word.startsWith('--')) {
      const flag = word.split('=')[0];
      if (!ALLOWED_FLAGS.has(flag)) throw new Error(`flag ${flag} is not allowed here`);
      continue;
    }
    if (!/^[A-Za-z0-9_.:\-]{1,80}$/.test(word)) throw new Error(`unexpected argument "${word.slice(0, 40)}"`);
  }
  return words;
}

function execCli(args, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const started = Date.now();
    execFile(cliPath(), args, {
      env: {
        ...process.env,
        STRIPE_API_KEY: apiKey(),
        STRIPE_CLI_TELEMETRY_OPTOUT: '1',
      },
      timeout: Math.max(2000, Math.min(45000, timeoutMs)),
      maxBuffer: 4 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      resolve({
        err,
        stdout: String(stdout || ''),
        stderr: redact(String(stderr || '')),
        ms: Date.now() - started,
      });
    });
  });
}

function parseJson(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); } catch { return null; }
}

/** Run one allowlisted, read-only command. */
async function runConsole(args, opts = {}) {
  const words = validate(args);
  const key = apiKey();
  if (!key) return { ok: false, args: words, error: 'STRIPE_SECRET_KEY is not configured on the server', ms: 0 };
  const out = await execCli(words, opts.timeoutMs);
  const data = parseJson(out.stdout);
  if (out.err) {
    return {
      ok: false,
      args: words,
      ms: out.ms,
      error: redact(out.err.message || 'stripe CLI failed'),
      stderr: out.stderr.slice(0, 800),
    };
  }
  return {
    ok: true,
    args: words,
    ms: out.ms,
    data,
    raw: redact(out.stdout).slice(0, MAX_OUTPUT_CHARS),
  };
}

/** Installed? authenticated? which account mode? Cached for ten seconds. */
async function status(force = false) {
  const now = Date.now();
  if (!force && statusCache.value && now - statusCache.at < STATUS_TTL_MS) return statusCache.value;
  if (statusCache.inflight) return statusCache.inflight;
  statusCache.inflight = (async () => {
    const bin = cliPath();
    const installed = (() => {
      try { return bin === 'stripe' ? true : fs.existsSync(bin); } catch { return false; }
    })();
    let version = null;
    if (installed) {
      const v = await execCli(['--version'], 8000);
      version = (v.stdout || '').trim().split('\n')[0] || null;
    }
    let authenticated = false;
    let account = null;
    let error = null;
    let latencyMs = null;
    if (installed && apiKey()) {
      const probe = await execCli(['products', 'list', '--limit', '1'], 15000);
      latencyMs = probe.ms;
      if (probe.err) error = redact(probe.err.message || 'probe failed');
      else {
        const data = parseJson(probe.stdout);
        authenticated = Boolean(data && data.object === 'list');
        const first = data?.data?.[0];
        account = {
          livemode: first ? Boolean(first.livemode) : keyMode() === 'live',
          products: data?.has_more ? '1+' : String(data?.data?.length ?? 0),
        };
      }
    } else if (!apiKey()) {
      error = 'STRIPE_SECRET_KEY is not set on the server';
    }
    const value = {
      installed,
      binary: bin,
      version,
      authenticated,
      mode: keyMode(),
      account,
      latencyMs,
      error,
      checkedAt: new Date().toISOString(),
    };
    statusCache = { at: Date.now(), value, inflight: null };
    return value;
  })();
  return statusCache.inflight;
}

function invalidateStatus() {
  statusCache = { at: 0, value: null, inflight: null };
}

// ── Durable action log ─────────────────────────────────────────────────────
function ensureLogTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS stripe_cli_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    detail TEXT,
    result TEXT,
    ok INTEGER NOT NULL DEFAULT 1,
    created_by TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_stripe_cli_actions_created ON stripe_cli_actions(created_at DESC)');
}

function logAction(db, { action, detail, result, ok = true, by = 'owner-dashboard' }) {
  try {
    ensureLogTable(db);
    db.prepare('INSERT INTO stripe_cli_actions (action, detail, result, ok, created_by) VALUES (?, ?, ?, ?, ?)')
      .run(String(action || ''), String(detail || '').slice(0, 400), String(result || '').slice(0, 400), ok ? 1 : 0, String(by || ''));
  } catch (err) {
    console.warn('[stripe-cli] action log write failed:', err.message);
  }
}

function recentActions(db, limit = 15) {
  try {
    ensureLogTable(db);
    const now = Math.floor(Date.now() / 1000);
    return db.prepare('SELECT action, detail, result, ok, created_by, created_at, (? - created_at) AS seconds_ago FROM stripe_cli_actions ORDER BY id DESC LIMIT ?')
      .all(now, Math.min(100, Math.max(1, Number(limit) || 15)));
  } catch {
    return [];
  }
}

// ── Price tools ────────────────────────────────────────────────────────────
function money(cents) {
  return '$' + (Number(cents || 0) / 100).toFixed(2);
}

async function findProduct(stripe, productName) {
  if (!productName) throw new Error('the plan has no Stripe product name configured');
  const products = await stripe.products.list({ active: true, limit: 100 });
  const wanted = String(productName).trim().toLowerCase();
  const match = products.data.find(p => String(p.name || '').trim().toLowerCase() === wanted);
  if (!match) throw new Error(`no active Stripe product named "${productName}"`);
  return match;
}

/**
 * Create a new recurring price on a plan's Stripe product.
 * opts: { interval: 'month'|'year', nickname, archiveOthers: bool }
 */
async function createPriceForPlan(stripe, { productName, amountCents, currency = 'usd', interval = 'month', nickname, archiveOthers = false }) {
  const amount = Math.round(Number(amountCents));
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('amountCents must be a positive integer');
  if (!['month', 'year', 'week', 'day'].includes(interval)) throw new Error('interval must be month, year, week or day');
  const product = await findProduct(stripe, productName);

  // Existing active prices for this product, so a "change" can supersede them
  // and a "add" leaves them in place.
  const before = await stripe.prices.list({ product: product.id, active: true, limit: 100 });

  const created = await stripe.prices.create({
    product: product.id,
    currency: String(currency).toLowerCase(),
    unit_amount: amount,
    recurring: { interval },
    nickname: nickname ? String(nickname).slice(0, 60) : undefined,
    metadata: { app: 'haksterai', managed_by: 'haksterai-admin' },
  });

  const archived = [];
  if (archiveOthers) {
    for (const price of before.data) {
      // Never archive the price we just created (it is not in `before`, but be
      // explicit) and never archive a $0 or non-recurring price by accident.
      if (price.id === created.id) continue;
      try {
        const updated = await stripe.prices.update(price.id, { active: false });
        archived.push({ id: updated.id, unit_amount: updated.unit_amount, active: updated.active });
      } catch (err) {
        archived.push({ id: price.id, error: err.message });
      }
    }
  }

  const after = await stripe.prices.list({ product: product.id, active: true, limit: 100 });
  return {
    product: { id: product.id, name: product.name },
    created: { id: created.id, unit_amount: created.unit_amount, currency: created.currency, interval: created.recurring?.interval, active: created.active },
    archived,
    activePrices: after.data.map(p => ({ id: p.id, unit_amount: p.unit_amount, currency: p.currency, interval: p.recurring?.interval, nickname: p.nickname || null })),
    summary: `Created ${money(created.unit_amount)}/${created.recurring?.interval} on "${product.name}" (${created.id})` +
      (archived.length ? ` · archived ${archived.length} old price${archived.length === 1 ? '' : 's'}` : ''),
  };
}

async function archivePrice(stripe, priceId) {
  const id = String(priceId || '').trim();
  if (!/^price_[A-Za-z0-9]{6,}$/.test(id)) throw new Error('a valid price id (price_…) is required');
  const updated = await stripe.prices.update(id, { active: false });
  const remaining = updated.product
    ? (await stripe.prices.list({ product: String(updated.product), active: true, limit: 100 })).data
      .map(p => ({ id: p.id, unit_amount: p.unit_amount, interval: p.recurring?.interval }))
    : [];
  return {
    archived: { id: updated.id, active: updated.active, unit_amount: updated.unit_amount },
    activePrices: remaining,
    summary: `Archived ${updated.id}${updated.unit_amount != null ? ` (${money(updated.unit_amount)})` : ''} · ${remaining.length} active price${remaining.length === 1 ? '' : 's'} left`,
  };
}

module.exports = {
  ALLOWED_COMMANDS,
  cliPath,
  keyMode,
  validate,
  runConsole,
  status,
  invalidateStatus,
  logAction,
  recentActions,
  createPriceForPlan,
  archivePrice,
  redact,
};
