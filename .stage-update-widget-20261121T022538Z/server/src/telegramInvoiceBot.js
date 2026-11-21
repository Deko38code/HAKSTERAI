'use strict';
/**
 * haksterAi — invoice desk (owner-only).
 *
 * Creates and keeps the owner's client invoices, holds the rate card
 * (the owner's own rates + sourced market reference), and renders invoices
 * as PDF through headless Chromium. Reached from any fleet bot:
 *
 *   /invnew <client> | <email or -> | <description> | <amount> | [qty]
 *   /invadd <number> <description> | <amount> | [qty]
 *   /invrec <number> [YYYY-MM] — clone as a new draft for that month
 *   /invlist · /invshow <number> · /invpdf <number>
 *   /invsent <number> · /invpaid <number> · /invvoid <number>
 *   /invdisc <number> <pct> · /invtax <number> <pct>
 *   /rates · /setrate <key> <amount> · /difficulty <tier> <multiplier> · /quote <key> [qty] [difficulty]
 *
 * Rules followed here:
 *   * Owner-only: every command checks the owner chat id.
 *   * Never deletes: void keeps the invoice, saves keep timestamped backups.
 *   * No invented numbers: a quote uses the owner's set rate, or shows the
 *     sourced market range and says it is a reference, never a price.
 *   * Nothing is emailed. Invoices leave as PDF in the owner's own chat.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const siteKeys = require('./telegramSiteKeys');

const DATA_DIR = process.env.HAKSTER_INVOICE_DIR || path.join(__dirname, '..', 'data');
const LEDGER = path.join(DATA_DIR, 'invoices.json');
const RATE_CARD = path.join(DATA_DIR, 'invoice-rate-card.json');
const SETTINGS = path.join(DATA_DIR, 'invoice-settings.json');
const EVENT_LOG = path.join(DATA_DIR, 'invoice-log.jsonl');
const PDF_DIR = path.join(DATA_DIR, 'invoice-pdfs');
const CHROME = '/usr/bin/chromium';

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

// ─── market reference ────────────────────────────────────────────────────────
// Ranges below were published by the sources shown, read 2026-11-20. They are
// reference only — /quote never presents a market range as the owner's price.
const MARKET = {
  seo_foundation: { label: 'SEO foundation — on-page + schema + Google Business Profile + Search Console (one-time)', low: 30000, high: 50000, unit: 'one-time', source: 'websitework.ca', checked: '2026-11-20' },
  seo_retainer: { label: 'SEO retainer — small business (monthly)', low: 100000, high: 250000, unit: 'per month', source: 'backlinko.com', checked: '2026-11-20' },
  local_seo: { label: 'Local SEO package (monthly)', low: 24900, high: 69900, unit: 'per month', source: 'getahana.com / websitework.ca', checked: '2026-11-20' },
  seo_audit: { label: 'Technical SEO audit (one-time, small/mid site)', low: 75000, high: 250000, unit: 'one-time', source: 'localranky.com / ignax.dev', checked: '2026-11-20' },
  web_5page: { label: '5-page small business website build', low: 150000, high: 250000, unit: 'one-time', source: 'oxellab.com / inkysites.com', checked: '2026-11-20' },
  web_10page: { label: '10–15 page website build', low: 300000, high: 500000, unit: 'one-time', source: 'oxellab.com', checked: '2026-11-20' },
  care_basic: { label: 'Website care plan — basic (monthly)', low: 7500, high: 9900, unit: 'per month', source: 'inkysites.com / chykalophia.com', checked: '2026-11-20' },
  care_mid: { label: 'Website care plan — mid, with edit time (monthly)', low: 15000, high: 25000, unit: 'per month', source: 'chykalophia.com', checked: '2026-11-20' },
  gbp_setup: { label: 'Google Business Profile setup/optimization (one-time)', low: 29900, high: 39900, unit: 'one-time', source: 'ratulroy.com / getprofileboost.com', checked: '2026-11-20' },
  gbp_mgmt: { label: 'Google Business Profile management (monthly)', low: 17500, high: 39900, unit: 'per month', source: 'zioadvertising.com', checked: '2026-11-20' },
  bot_simple: { label: 'Simple Telegram bot — notifications, menus, lead capture', low: 50000, high: 200000, unit: 'one-time', source: 'quoteabot.com', checked: '2026-11-20' },
  bot_custom: { label: 'Custom bot / AI assistant with database and integrations', low: 150000, high: 600000, unit: 'one-time', source: 'raftlabs.com', checked: '2026-11-20' },
  hourly: { label: 'Hourly rate — development/SEO work', low: 7500, high: 15000, unit: 'per hour', source: 'backlinko.com', checked: '2026-11-20' },
};

// ─── difficulty rule ─────────────────────────────────────────────────────────
// Owner (2026-11-21): "we bill by hr and difficulty rule". The rule is real but
// the multipliers are the owner's to set — they are never invented here. A tier
// with no multiplier set is refused in /quote instead of being assumed to be 1x.
const DIFFICULTY = {
  normal: { label: 'Normal — routine build, fix or content work' },
  hard: { label: 'Hard — complex debugging, integrations, migrations' },
  critical: { label: 'Critical — outage recovery, data-risk work, live-client emergency' },
};

// ─── files ───────────────────────────────────────────────────────────────────
function readJson(file, fallback) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value;
  } catch (_) { return fallback; }
}

function backupFile(file) {
  try { fs.copyFileSync(file, `${file}.bak-invoice-${stamp()}`); } catch (_) { /* first write */ }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  backupFile(file);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function loadSettings() {
  const current = readJson(SETTINGS, null);
  const defaults = {
    business: 'PhantomIDE',
    owner: 'Deke Needem',
    email: 'dekekenneth840@gmail.com',
    phone: '',
    address: '',
    footer: 'Thank you for your business.',
    dueDays: 14,
  };
  if (!current) { writeJson(SETTINGS, defaults); return defaults; }
  let changed = false;
  for (const key of Object.keys(defaults)) {
    if (!(key in current)) { current[key] = defaults[key]; changed = true; }
  }
  if (changed) writeJson(SETTINGS, current);
  return current;
}

function loadRateCard() {
  const current = readJson(RATE_CARD, null) || { updated: null, rates: {}, market: MARKET };
  let changed = false;
  if (!current.market || typeof current.market !== 'object') { current.market = MARKET; changed = true; }
  if (!current.rates || typeof current.rates !== 'object') { current.rates = {}; changed = true; }
  for (const key of Object.keys(MARKET)) {
    if (!current.market[key]) { current.market[key] = MARKET[key]; changed = true; }
    if (!(key in current.rates)) {
      // $100/hour is the owner's confirmed rate (junkalot AGENTS.md, stated
      // 2026-11-21: "we bill by hr and difficulty rule"). Everything else
      // starts unset so no price is ever invented.
      current.rates[key] = key === 'hourly' ? 10000 : null;
      changed = true;
    }
  }
  if (!current.difficulty || typeof current.difficulty !== 'object') { current.difficulty = {}; changed = true; }
  for (const tier of Object.keys(DIFFICULTY)) {
    if (!current.difficulty[tier]) { current.difficulty[tier] = { multiplier: null }; changed = true; }
    if (!('multiplier' in current.difficulty[tier])) { current.difficulty[tier].multiplier = null; changed = true; }
  }
  if (!current.updated) { current.updated = new Date().toISOString(); changed = true; }
  if (changed) writeJson(RATE_CARD, current);
  return current;
}

function loadLedger() {
  const value = readJson(LEDGER, []);
  return Array.isArray(value) ? value : [];
}

let writeChain = Promise.resolve();
function updateLedger(mutator) {
  let release;
  const before = writeChain;
  writeChain = new Promise(resolve => { release = resolve; });
  return before.then(async () => {
    try {
      const list = loadLedger();
      const result = await mutator(list);
      writeJson(LEDGER, list);
      return result;
    } finally { release(); }
  });
}

function logEvent(entry) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(EVENT_LOG, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', { mode: 0o600 });
  } catch (e) { console.error('[invoice] log write failed:', e.message); }
}

// ─── helpers ─────────────────────────────────────────────────────────────────
const money = cents => '$' + (Number(cents || 0) / 100).toFixed(2);

function parseAmount(raw) {
  const cleaned = String(raw || '').replace(/[$,\s]/g, '');
  if (!cleaned || !/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const cents = Math.round(parseFloat(cleaned) * 100);
  if (!Number.isFinite(cents) || cents < 0 || cents > 100000000) return null;
  return cents;
}

function parseQty(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return 1;
  const n = Number(String(raw).trim());
  return Number.isInteger(n) && n >= 1 && n <= 999 ? n : null;
}

function today() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + days);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function currentPeriod() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// "2026-11" -> "November 2026"; anything unrecognised is passed through as-is.
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function monthLabel(period) {
  const m = String(period || '').match(/^(\d{4})-(0[1-9]|1[0-2])$/);
  if (!m) return String(period || '');
  return `${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

function totals(inv) {
  const subtotal = (inv.items || []).reduce((sum, item) => sum + item.amountCents, 0);
  const discount = Math.round(subtotal * Math.max(0, Math.min(100, Number(inv.discountPct) || 0)) / 100);
  const taxable = subtotal - discount;
  const tax = Math.round(taxable * Math.max(0, Math.min(100, Number(inv.taxPct) || 0)) / 100);
  return { subtotal, discount, tax, total: taxable + tax };
}

function nextNumber(list) {
  const year = new Date().getFullYear();
  const prefix = `INV-${year}-`;
  const max = list
    .filter(inv => String(inv.number).startsWith(prefix))
    .reduce((m, inv) => Math.max(m, Number(String(inv.number).slice(prefix.length)) || 0), 0);
  return `${prefix}${String(max + 1).padStart(4, '0')}`;
}

function findInvoice(list, number) {
  const wanted = String(number || '').trim().toUpperCase();
  return list.find(inv => String(inv.number).toUpperCase() === wanted);
}

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function invoiceHtml(inv, settings) {
  const t = totals(inv);
  const rows = inv.items.map(item => `
      <tr>
        <td style="padding:10px 8px;border-bottom:1px solid #e5e5e5">${esc(item.description)}</td>
        <td style="padding:10px 8px;border-bottom:1px solid #e5e5e5;text-align:center">${item.qty}</td>
        <td style="padding:10px 8px;border-bottom:1px solid #e5e5e5;text-align:right">${money(item.rateCents)}</td>
        <td style="padding:10px 8px;border-bottom:1px solid #e5e5e5;text-align:right">${money(item.amountCents)}</td>
      </tr>`).join('');
  const discountRow = t.discount ? `<tr><td colspan="3" style="padding:6px 8px;text-align:right">Discount ${Number(inv.discountPct)}%</td><td style="padding:6px 8px;text-align:right">-${money(t.discount)}</td></tr>` : '';
  const taxRow = t.tax ? `<tr><td colspan="3" style="padding:6px 8px;text-align:right">Tax ${Number(inv.taxPct)}%</td><td style="padding:6px 8px;text-align:right">${money(t.tax)}</td></tr>` : '';
  const statusColor = inv.status === 'paid' ? '#15803d' : inv.status === 'void' ? '#b91c1c' : '#b45309';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(inv.number)}</title></head>
<body style="margin:0;background:#f4f3ef;font-family:Arial,Helvetica,sans-serif;color:#1f2430">
<main style="max-width:720px;margin:24px auto;background:#fff;border:1px solid #e2e0d8;border-radius:10px;overflow:hidden">
  <header style="padding:26px 32px;background:#1a1a2e;color:#fff">
    <div style="font-size:12px;letter-spacing:2px;color:#c9a840;font-weight:bold">${esc(String(settings.business || '').toUpperCase())}</div>
    <h1 style="margin:6px 0 0;font-size:26px">Invoice ${esc(inv.number)}</h1>
    <div style="margin-top:6px;font-size:12px;color:#c9c8d2">Status: <b style="color:${statusColor}">${esc(String(inv.status).toUpperCase())}</b></div>
  </header>
  <section style="padding:24px 32px">
    <table style="width:100%;font-size:13px;margin-bottom:18px"><tr>
      <td style="vertical-align:top">
        <div style="color:#6b7280;font-size:11px;text-transform:uppercase;letter-spacing:1px">Bill to</div>
        <div style="font-weight:bold;margin-top:3px">${esc(inv.client)}</div>
        ${inv.email ? `<div style="color:#4b5563">${esc(inv.email)}</div>` : ''}
      </td>
      <td style="vertical-align:top;text-align:right">
        <div><b>Invoice:</b> ${esc(inv.number)}</div>
        <div><b>Date:</b> ${esc(inv.date)}</div>
        ${inv.period ? `<div><b>Period:</b> ${esc(monthLabel(inv.period))}</div>` : ''}
        <div><b>Due:</b> ${esc(inv.dueDate || '—')}</div>
      </td>
    </tr></table>
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr style="background:#f4f3ef">
        <th style="padding:9px 8px;text-align:left">Work</th>
        <th style="padding:9px 8px;text-align:center;width:50px">Qty</th>
        <th style="padding:9px 8px;text-align:right;width:100px">Rate</th>
        <th style="padding:9px 8px;text-align:right;width:110px">Amount</th>
      </tr></thead>
      <tbody>${rows}
        ${discountRow}${taxRow}
        <tr><td colspan="3" style="padding:14px 8px;text-align:right;font-weight:bold">Total due</td>
            <td style="padding:14px 8px;text-align:right;font-weight:bold;font-size:16px">${money(t.total)}</td></tr>
      </tbody>
    </table>
    ${inv.notes ? `<p style="margin-top:18px;font-size:12px;color:#4b5563;white-space:pre-line">${esc(inv.notes)}</p>` : ''}
    <p style="margin-top:22px;font-size:12px;color:#6b7280">${esc(settings.footer || '')}<br>${esc(settings.owner || '')}${settings.email ? ' · ' + esc(settings.email) : ''}${settings.phone ? ' · ' + esc(settings.phone) : ''}</p>
  </section>
</main>
</body></html>`;
}

function renderPdf(inv, settings) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(PDF_DIR, { recursive: true });
    const htmlPath = path.join(PDF_DIR, `${inv.number}.html`);
    const pdfPath = path.join(PDF_DIR, `${inv.number}.pdf`);
    fs.writeFileSync(htmlPath, invoiceHtml(inv, settings), { mode: 0o600 });
    execFile(CHROME, [
      '--headless', '--no-sandbox', '--disable-gpu', '--no-pager',
      `--print-to-pdf=${pdfPath}`, `file://${htmlPath}`,
    ], { timeout: 45000 }, err => {
      if (err) return reject(new Error('PDF render failed: ' + err.message));
      try {
        const size = fs.statSync(pdfPath).size;
        if (!size) return reject(new Error('PDF render produced an empty file.'));
        try { fs.chmodSync(pdfPath, 0o600); } catch (_) { /* best effort */ }
        resolve(pdfPath);
      } catch (statErr) { reject(new Error('PDF render failed: ' + statErr.message)); }
    });
  });
}

// ─── commands ────────────────────────────────────────────────────────────────
const COMMANDS = /^\/(?:invoice|invnew|invrec|invadd|invlist|invshow|invpdf|invsent|invpaid|invvoid|invdisc|invtax|invset|rates|setrate|difficulty|quote)\b/i;

function helpText() {
  return [
    '🧾 Invoice desk — owner only',
    '',
    'Create: /invnew <client> | <email or -> | <description> | <amount> | [qty]',
    '   e.g. /invnew Junk-A-Lot | - | SEO integration and technical setup | 497',
    'Add a line: /invadd <number> <description> | <amount> | [qty]',
    'Repeat monthly: /invrec <number> [YYYY-MM] — clones it as this month\'s draft',
    'Disc/tax: /invdisc <number> <pct> · /invtax <number> <pct>',
    '',
    'See: /invlist · /invshow <number> · /invpdf <number>',
    'Status: /invsent <number> · /invpaid <number> · /invvoid <number>',
    '',
    'Pricing: /rates · /quote <key> [qty] [difficulty] · /setrate <key> <amount>',
    'Difficulty rule: /difficulty <tier> <multiplier> — normal, hard, critical',
    'Settings: /invset <key> <value> — business, owner, email, phone, address, footer, dueDays',
    'Amounts are USD. Invoices are PDFs sent to this chat — nothing is emailed.',
  ].join('\n');
}

async function handleInvoiceCommand({ text, chatId, bot }) {
  if (!COMMANDS.test(text)) return false;
  const reply = msg => bot.sendMessage(chatId, String(msg).slice(0, 4000));

  const raw = text.trim();
  const command = raw.split(/\s+/)[0].toLowerCase().replace(/^\//, '').replace(/@\S+$/, '');
  const rest = raw.slice(raw.split(/\s+/)[0].length).trim();

  if (!siteKeys.isOwnerChat(chatId)) {
    // /rates and /quote are ordinary words a visitor might type — let those fall
    // through to the bot's normal chat instead of answering with a denial.
    if (command === 'rates' || command === 'quote') return false;
    await reply('⛔ The invoice desk is owner-only.');
    return true;
  }

  try {
    if (command === 'invoice') { await reply(helpText()); return true; }

    if (command === 'invnew') {
      const parts = rest.split('|').map(s => s.trim());
      if (parts.length < 4) { await reply('Usage: /invnew <client> | <email or -> | <description> | <amount> | [qty]'); return true; }
      const [clientRaw, emailRaw, description, amountRaw, qtyRaw] = parts;
      const client = clientRaw.slice(0, 120);
      const email = emailRaw === '-' ? '' : emailRaw.slice(0, 160);
      const rateCents = parseAmount(amountRaw);
      const qty = parseQty(qtyRaw);
      if (!client) { await reply('The client name is empty.'); return true; }
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { await reply('That email address does not look valid — use - for none.'); return true; }
      if (!description) { await reply('Add a description of the work.'); return true; }
      if (rateCents === null) { await reply('The amount is not a valid dollar figure — e.g. 497 or $1,250.00.'); return true; }
      if (qty === null) { await reply('Qty must be a whole number from 1 to 999.'); return true; }

      const settings = loadSettings();
      const created = await updateLedger(list => {
        const invoice = {
          number: nextNumber(list),
          client,
          email,
          date: today(),
          dueDate: addDays(today(), Number(settings.dueDays) || 14),
          items: [{ description: description.slice(0, 300), qty, rateCents, amountCents: rateCents * qty }],
          discountPct: 0,
          taxPct: 0,
          notes: '',
          status: 'draft',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          sentAt: null,
          paidAt: null,
        };
        list.push(invoice);
        return invoice;
      });
      const t = totals(created);
      logEvent({ action: 'created', number: created.number, totalCents: t.total, client: created.client });
      await reply([
        `✅ ${created.number} created (draft)`,
        `Client: ${created.client}${created.email ? ' <' + created.email + '>' : ''}`,
        `1 line · Total ${money(t.total)} · due ${created.dueDate}`,
        '',
        `Add work: /invadd ${created.number} <description> | <amount>`,
        `PDF: /invpdf ${created.number}`,
      ].join('\n'));
      return true;
    }

    if (command === 'invrec') {
      const parts = rest.split(/\s+/).filter(Boolean);
      const source = parts[0];
      const period = parts[1] || currentPeriod();
      if (!source) { await reply('Usage: /invrec <number> [YYYY-MM]'); return true; }
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) { await reply('The period must look like 2026-11.'); return true; }

      const settings = loadSettings();
      const result = await updateLedger(list => {
        const src = findInvoice(list, source);
        if (!src) return { error: `No invoice ${source}.` };
        if (src.status === 'void') return { error: `${src.number} is void — nothing to repeat.` };
        if (!Array.isArray(src.items) || !src.items.length) return { error: `${src.number} has no lines.` };
        // Same client, same month, same lines = a repeat already exists. A different
        // set of lines in the same month is legitimate (build + retainer), so allow it.
        const lineKey = inv2 => (inv2.items || []).map(i => String(i.description).trim().toLowerCase()).sort().join('|');
        const already = list.find(inv2 => inv2.status !== 'void'
          && inv2.period === period
          && String(inv2.client).trim().toLowerCase() === String(src.client).trim().toLowerCase()
          && lineKey(inv2) === lineKey(src));
        if (already) return { error: `${period} is already invoiced for ${src.client} as ${already.number}.` };
        const invoice = {
          number: nextNumber(list),
          client: src.client,
          email: src.email || '',
          date: today(),
          dueDate: addDays(today(), Number(settings.dueDays) || 14),
          period,
          items: src.items.map(item => ({
            description: item.description,
            qty: item.qty,
            rateCents: item.rateCents,
            amountCents: item.rateCents * item.qty,
          })),
          discountPct: Number(src.discountPct) || 0,
          taxPct: Number(src.taxPct) || 0,
          notes: src.notes || '',
          status: 'draft',
          recurringOf: src.number,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          sentAt: null,
          paidAt: null,
        };
        list.push(invoice);
        return { inv: invoice };
      });
      if (result.error) { await reply(result.error); return true; }
      const t = totals(result.inv);
      logEvent({ action: 'recurring-created', number: result.inv.number, from: result.inv.recurringOf, period, totalCents: t.total });
      await reply([
        `✅ ${result.inv.number} created from ${result.inv.recurringOf} (draft)`,
        `${result.inv.client} · ${monthLabel(period)} · ${result.inv.items.length} line(s) · Total ${money(t.total)}`,
        `Due ${result.inv.dueDate}`,
        '',
        `Adjust: /invadd or /invdisc on ${result.inv.number} · PDF: /invpdf ${result.inv.number}`,
      ].join('\n'));
      return true;
    }

    if (command === 'invadd') {
      const match = rest.match(/^(\S+)\s+([\s\S]+)$/);
      if (!match) { await reply('Usage: /invadd <number> <description> | <amount> | [qty]'); return true; }
      const number = match[1];
      const parts = match[2].split('|').map(s => s.trim());
      if (parts.length < 2) { await reply('Usage: /invadd <number> <description> | <amount> | [qty]'); return true; }
      const [description, amountRaw, qtyRaw] = parts;
      const rateCents = parseAmount(amountRaw);
      const qty = parseQty(qtyRaw);
      if (!description) { await reply('Add a description of the work.'); return true; }
      if (rateCents === null) { await reply('The amount is not a valid dollar figure.'); return true; }
      if (qty === null) { await reply('Qty must be a whole number from 1 to 999.'); return true; }

      const result = await updateLedger(list => {
        const inv = findInvoice(list, number);
        if (!inv) return { error: `No invoice ${number}.` };
        if (['paid', 'void'].includes(inv.status)) return { error: `${inv.number} is ${inv.status} — add lines before marking it paid or void.` };
        inv.items.push({ description: description.slice(0, 300), qty, rateCents, amountCents: rateCents * qty });
        inv.updatedAt = Date.now();
        return { inv };
      });
      if (result.error) { await reply(result.error); return true; }
      const t = totals(result.inv);
      logEvent({ action: 'line-added', number: result.inv.number, totalCents: t.total });
      await reply(`✅ ${result.inv.number}: ${result.inv.items.length} lines · Total ${money(t.total)}\nPDF: /invpdf ${result.inv.number}`);
      return true;
    }

    if (command === 'invlist') {
      const list = loadLedger();
      if (!list.length) { await reply('No invoices yet. Start with /invnew.'); return true; }
      const recent = list.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 10);
      const lines = recent.map(inv => {
        const t = totals(inv);
        return `${inv.number} · ${inv.client} · ${money(t.total)} · ${inv.status}`;
      });
      const outstanding = list.filter(inv => !['paid', 'void'].includes(inv.status)).reduce((s, inv) => s + totals(inv).total, 0);
      const paid = list.filter(inv => inv.status === 'paid').reduce((s, inv) => s + totals(inv).total, 0);
      await reply(['🧾 Invoices (latest 10)', ...lines, '', `Outstanding ${money(outstanding)} · Paid ${money(paid)}`].join('\n'));
      return true;
    }

    if (command === 'invshow') {
      const inv = findInvoice(loadLedger(), rest);
      if (!inv) { await reply(`No invoice ${rest}.`); return true; }
      const t = totals(inv);
      const lines = inv.items.map(item => `• ${item.description}${item.qty !== 1 ? ` ×${item.qty}` : ''} — ${money(item.amountCents)}`);
      await reply([
        `🧾 ${inv.number} — ${inv.status.toUpperCase()}`,
        `${inv.client}${inv.email ? ' <' + inv.email + '>' : ''}`,
        `Date ${inv.date} · Due ${inv.dueDate}${inv.period ? ` · Period ${monthLabel(inv.period)}` : ''}`,
        inv.recurringOf ? `Repeat of ${inv.recurringOf}` : null,
        '',
        ...lines,
        `Subtotal ${money(t.subtotal)}${t.discount ? ` · Discount ${money(t.discount)}` : ''}${t.tax ? ` · Tax ${money(t.tax)}` : ''}`,
        `Total ${money(t.total)}`,
        '',
        `PDF: /invpdf ${inv.number}`,
      ].join('\n'));
      return true;
    }

    if (command === 'invpdf') {
      const inv = findInvoice(loadLedger(), rest);
      if (!inv) { await reply(`No invoice ${rest}.`); return true; }
      await reply(`Rendering ${inv.number}…`);
      const pdfPath = await renderPdf(inv, loadSettings());
      await bot.sendDocument(chatId, pdfPath, { caption: `${inv.number} — ${inv.client} — ${money(totals(inv).total)} (${inv.status})` });
      logEvent({ action: 'pdf-sent', number: inv.number });
      return true;
    }

    if (['invsent', 'invpaid', 'invvoid'].includes(command)) {
      const status = command === 'invsent' ? 'sent' : command === 'invpaid' ? 'paid' : 'void';
      const result = await updateLedger(list => {
        const inv = findInvoice(list, rest);
        if (!inv) return { error: `No invoice ${rest}.` };
        if (inv.status === 'void') return { error: `${inv.number} is void.` };
        inv.status = status;
        inv.updatedAt = Date.now();
        if (status === 'sent' && !inv.sentAt) inv.sentAt = Date.now();
        if (status === 'paid' && !inv.paidAt) inv.paidAt = Date.now();
        return { inv };
      });
      if (result.error) { await reply(result.error); return true; }
      logEvent({ action: `marked-${status}`, number: result.inv.number });
      await reply(`✅ ${result.inv.number} marked ${status}.`);
      return true;
    }

    if (command === 'invdisc' || command === 'invtax') {
      const parts = rest.split(/\s+/);
      const pct = Number(parts[1]);
      if (!parts[0] || !Number.isFinite(pct) || pct < 0 || pct > 100) { await reply(`Usage: /${command} <number> <0-100>`); return true; }
      const result = await updateLedger(list => {
        const inv = findInvoice(list, parts[0]);
        if (!inv) return { error: `No invoice ${parts[0]}.` };
        if (['paid', 'void'].includes(inv.status)) return { error: `${inv.number} is ${inv.status}.` };
        if (command === 'invdisc') inv.discountPct = pct; else inv.taxPct = pct;
        inv.updatedAt = Date.now();
        return { inv };
      });
      if (result.error) { await reply(result.error); return true; }
      await reply(`✅ ${result.inv.number}: total now ${money(totals(result.inv).total)}.`);
      return true;
    }

    if (command === 'invset') {
      const match = rest.match(/^(\w+)\s+([\s\S]+)$/);
      const allowed = ['business', 'owner', 'email', 'phone', 'address', 'footer', 'dueDays'];
      if (!match || !allowed.includes(match[1])) {
        await reply(`Usage: /invset <${allowed.join('|')}> <value>`);
        return true;
      }
      const key = match[1];
      const value = match[2].trim().slice(0, 200);
      if (key === 'email' && value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) { await reply('That email address does not look valid.'); return true; }
      if (key === 'dueDays') {
        const days = Number(value);
        if (!Number.isInteger(days) || days < 0 || days > 120) { await reply('dueDays must be a whole number from 0 to 120.'); return true; }
      }
      const settings = loadSettings();
      settings[key] = key === 'dueDays' ? Number(value) : value;
      writeJson(SETTINGS, settings);
      logEvent({ action: 'setting-set', key });
      await reply(`✅ ${key} set.`);
      return true;
    }

    if (command === 'rates') {
      const card = loadRateCard();
      const lines = ['💵 Rate card', ''];
      for (const key of Object.keys(MARKET)) {
        const own = card.rates[key];
        const m = card.market[key] || MARKET[key];
        const market = `${money(m.low)}–${money(m.high)} ${m.unit} · ${m.source}`;
        lines.push(`${key}: ${own === null || own === undefined ? `not set — market ${market}` : `${money(own)} ${m.unit}`}`);
      }
      lines.push('', 'Difficulty rule (multiplier on the hourly rate):');
      for (const tier of Object.keys(DIFFICULTY)) {
        const mult = card.difficulty[tier] && card.difficulty[tier].multiplier;
        lines.push(`${tier}: ${mult == null ? 'not set' : `×${mult}`} · ${DIFFICULTY[tier].label}`);
      }
      lines.push('', 'Set yours: /setrate <key> <amount> · /difficulty <tier> <multiplier>', 'Quotes use your rate only; market ranges are reference and sourced, checked 2026-11-20.');
      await reply(lines.join('\n'));
      return true;
    }

    if (command === 'setrate') {
      const parts = rest.split(/\s+/);
      const key = String(parts[0] || '').toLowerCase();
      const amount = parseAmount(parts[1]);
      if (!MARKET[key]) { await reply(`Unknown key. Use /rates to see the keys.`); return true; }
      if (amount === null) { await reply('Usage: /setrate <key> <amount>  (e.g. /setrate seo_foundation 497)'); return true; }
      const card = loadRateCard();
      card.rates[key] = amount;
      card.updated = new Date().toISOString();
      writeJson(RATE_CARD, card);
      logEvent({ action: 'rate-set', key, amountCents: amount });
      await reply(`✅ ${key} set to ${money(amount)}.`);
      return true;
    }

    if (command === 'difficulty') {
      const parts = rest.split(/\s+/);
      const tier = String(parts[0] || '').toLowerCase();
      if (!DIFFICULTY[tier]) { await reply(`Unknown tier. Use one of: ${Object.keys(DIFFICULTY).join(', ')}`); return true; }
      const raw = String(parts[1] || '').replace(/[x×\s]/gi, '');
      const multiplier = raw ? Number(raw) : NaN;
      if (!Number.isFinite(multiplier) || multiplier < 1 || multiplier > 5) {
        await reply(`Usage: /difficulty <tier> <multiplier>  (e.g. /difficulty hard 1.5 — multiplier 1.0–5.0)`);
        return true;
      }
      const card = loadRateCard();
      card.difficulty[tier] = { multiplier: Math.round(multiplier * 100) / 100 };
      card.updated = new Date().toISOString();
      writeJson(RATE_CARD, card);
      logEvent({ action: 'difficulty-set', tier, multiplier });
      await reply(`✅ ${tier} difficulty set to ×${card.difficulty[tier].multiplier}.`);
      return true;
    }

    if (command === 'quote') {
      const parts = rest.split(/\s+/);
      const key = String(parts[0] || '').toLowerCase();
      if (!key) { await reply('Usage: /quote <key> [qty] [difficulty] — /rates lists the keys.'); return true; }
      const m = MARKET[key];
      if (!m) { await reply(`Unknown key "${key}". /rates lists the keys.`); return true; }
      const tier = String(parts[2] || '').toLowerCase() || null;
      if (tier && !DIFFICULTY[tier]) { await reply(`Unknown difficulty "${tier}". Use: ${Object.keys(DIFFICULTY).join(', ')}`); return true; }
      const qty = parseQty(parts[1]);
      if (qty === null) { await reply('Qty must be a whole number from 1 to 999.'); return true; }
      const card = loadRateCard();
      const own = card.rates[key];
      if (own === null || own === undefined) {
        await reply([
          `${key}: your rate is not set.`,
          `Market reference: ${money(m.low)}–${money(m.high)} ${m.unit} (${m.source}, checked ${m.checked}) — reference only, not a quote.`,
          `Set your price with: /setrate ${key} <amount>`,
        ].join('\n'));
        return true;
      }
      let multiplier = 1;
      if (tier) {
        const set = card.difficulty[tier] && card.difficulty[tier].multiplier;
        if (set == null) {
          await reply(`${tier}: the difficulty multiplier is not set, so no quote is given.\nSet it with: /difficulty ${tier} <multiplier>`);
          return true;
        }
        multiplier = set;
      }
      const base = own * qty;
      const total = Math.round(base * multiplier);
      const label = tier ? `${m.label} (${tier} difficulty ×${multiplier})` : m.label;
      const calc = `${money(own)} ${m.unit}${qty !== 1 ? ` × ${qty}` : ''}${tier ? ` × ${multiplier}` : ''} = ${money(total)}`;
      const invLine = tier
        ? `/invnew <client> | <email or -> | ${label} | ${(total / 100).toFixed(2)} | 1`
        : `/invnew <client> | <email or -> | ${m.label} | ${(own / 100).toFixed(2)}${qty !== 1 ? ` | ${qty}` : ''}`;
      await reply(`${m.label}\nYour rate: ${calc}\n\nInvoice it: ${invLine}`);
      return true;
    }

    await reply(helpText());
    return true;
  } catch (e) {
    console.error('[invoice] command failed:', e.message);
    await reply(`Invoice desk error: ${e.message}`);
    return true;
  }
}

module.exports = { handleInvoiceCommand, MARKET, DIFFICULTY, _paths: { DATA_DIR, LEDGER, RATE_CARD, SETTINGS, PDF_DIR } };
