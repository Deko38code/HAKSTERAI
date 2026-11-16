'use strict';
/**
 * Client portfolio & audit IDs — owner records.
 *
 * 2026-11-16 (owner): "we always keep portfollio per client starting with
 * junkalot for our records and ids for audit report".
 *
 * One entry per client build the provider has delivered. Each entry gets a
 * stable client ID, a stable audit ID, and record IDs for the licence version,
 * the build record and the invoice ledger. The IDs are minted once and written
 * to server/data/client-portfolio.json; every later read reuses them, so a
 * printed audit report always carries the same identifiers.
 *
 * Nothing here is a live figure of its own: money and lock state are read from
 * hostingLock (which reads Junkalot's ledger), and a document ID carries the
 * SHA-256 of the exact licence text it identifies. If a source cannot be read,
 * the field is reported as unknown — never invented.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const REGISTRY = path.join(DATA_DIR, 'client-portfolio.json');
const EVENTS = path.join(DATA_DIR, 'client-audit.jsonl');
const DOCS_DIR = path.join(__dirname, '..', '..', 'docs');
const LICENCE_DOC = path.join(DOCS_DIR, 'haksterai-hosting-licence.md');

function clean(v, n) {
  return String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').trim().slice(0, n);
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function writeJson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch (_) { return false; }
}

function pad(n, w) {
  return String(n).padStart(w, '0');
}

// The starting portfolio. Junkalot is the first client build, so its IDs are
// minted from this seed the first time the registry is read. Later clients are
// added by appending a seed here (or through addClient) — never by rewriting an
// existing entry's IDs.
const SEEDS = [
  {
    key: 'junk-a-lot',
    name: 'Junk-A-Lot',
    hostname: 'junkalot.co',
    box: 'parrot',
    service: 'junkalot',
    hostingClientId: 'junkalot',
    deliveredAt: '2026-11-16',
    scope: 'Website build, booking/email, AI visitor chat and coaching assistant, admin dashboard, hosting and care',
    licenceVersion: '2026-11-16',
  },
];

/** Read the registry, minting the seed entries the first time. Additive only. */
function ensureRegistry() {
  const existing = readJson(REGISTRY);
  if (existing && Array.isArray(existing.clients) && existing.clients.length) return existing;
  const clients = SEEDS.map((seed, i) => ({
    clientId: 'CLI-' + pad(i + 1, 4),
    auditId: 'AUD-2026-' + pad(i + 1, 4),
    key: seed.key,
    name: seed.name,
    hostname: seed.hostname,
    box: seed.box,
    service: seed.service,
    hostingClientId: seed.hostingClientId,
    deliveredAt: seed.deliveredAt,
    scope: seed.scope,
    licenceVersion: seed.licenceVersion,
    recordIds: {
      licence: 'LIC-' + seed.licenceVersion + '-' + pad(i + 1, 4),
      build: 'BLD-' + seed.hostname.replace(/[^a-z0-9]+/gi, '-').toUpperCase(),
      invoices: 'INV-' + pad(i + 1, 4),
    },
    createdAt: new Date().toISOString(),
  }));
  const value = {
    schema: 'client-portfolio/1',
    note: 'Owner record. IDs are stable once minted; never renumber an existing client.',
    clients,
  };
  writeJson(REGISTRY, value);
  return value;
}

/** SHA-256 + size + mtime of the licence document, so a record ID names exact text. */
function licenceDocument() {
  try {
    const buf = fs.readFileSync(LICENCE_DOC);
    const st = fs.statSync(LICENCE_DOC);
    return {
      path: 'docs/haksterai-hosting-licence.md',
      sha256: sha256(buf),
      bytes: buf.length,
      updatedAt: st.mtime.toISOString(),
      downloadPath: '/api/admin/license/document',
    };
  } catch (err) {
    return { path: 'docs/haksterai-hosting-licence.md', sha256: '', bytes: 0, updatedAt: '', error: clean(err.message, 160) };
  }
}

/** Owner-authored audit events for one client (append-only file). */
function eventsFor(clientId) {
  try {
    const text = fs.readFileSync(EVENTS, 'utf8');
    const rows = [];
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t || t[0] !== '{') continue;
      try {
        const e = JSON.parse(t);
        if (e && e.clientId === clientId) rows.push(e);
      } catch (_) { /* skip unreadable line */ }
    }
    return rows.slice(-50);
  } catch (_) { return []; }
}

/** Append one audit event. Never rewrites an earlier row. */
function recordEvent(clientId, action, detail) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const row = {
      at: new Date().toISOString(),
      clientId: clean(clientId, 20),
      action: clean(action, 60),
      detail: clean(detail, 300),
    };
    fs.appendFileSync(EVENTS, JSON.stringify(row) + '\n', 'utf8');
    return row;
  } catch (_) { return null; }
}

/**
 * The portfolio with live figures attached. hostingState is the value from
 * hostingLock.getState(); when it is unavailable every money field is null and
 * the entry reports why, so an audit report never carries a guessed number.
 *
 * 2026-11-16 (owner): "and any other app site we build gets one". Every client
 * the hosting records know about is in the portfolio: a client that appears
 * there without an entry is minted one (next free CLI-/AUD- numbers) and written
 * to the registry, so no build is ever left without IDs. Existing entries are
 * never renumbered or rewritten.
 */
function build(hostingState) {
  const registry = ensureRegistry();
  const doc = licenceDocument();
  const state = hostingState && Array.isArray(hostingState.clients) ? hostingState : null;

  if (state) {
    let added = 0;
    for (const live of state.clients) {
      const id = clean(live && live.id, 40);
      if (!id || registry.clients.some((c) => c.hostingClientId === id)) continue;
      const n = registry.clients.length + 1;
      registry.clients.push({
        clientId: 'CLI-' + pad(n, 4),
        auditId: 'AUD-' + new Date().getUTCFullYear() + '-' + pad(n, 4),
        key: clean(id, 60),
        name: clean((live && live.name) || id, 80),
        hostname: clean(live && live.hostname, 120),
        box: clean(live && live.box, 20),
        service: clean(live && live.service && live.service.name, 60) || clean(live && live.site, 60),
        hostingClientId: id,
        deliveredAt: clean(live && live.since, 20) || new Date().toISOString().slice(0, 10),
        scope: 'Client website build on the provider platform (recorded when the build first appears in the hosting records)',
        licenceVersion: (live && live.gate && live.gate.licenceVersion) || '',
        recordIds: {
          licence: 'LIC-' + ((live && live.gate && live.gate.licenceVersion) || new Date().toISOString().slice(0, 10)) + '-' + pad(n, 4),
          build: 'BLD-' + String((live && live.hostname) || id).replace(/[^a-z0-9]+/gi, '-').toUpperCase(),
          invoices: 'INV-' + pad(n, 4),
        },
        createdAt: new Date().toISOString(),
      });
      added += 1;
    }
    if (added) {
      writeJson(REGISTRY, registry);
      recordEvent('portfolio', 'minted-ids', added + ' new client entr' + (added === 1 ? 'y' : 'ies') + ' added from the hosting records');
    }
  }
  const clients = registry.clients.map((c) => {
    const live = state ? state.clients.find((x) => x.id === c.hostingClientId) : null;
    const gate = live && live.gate ? live.gate : null;
    const payoff = live && live.payoff ? live.payoff : null;
    const known = !!(gate && gate.totalsKnown);
    return {
      clientId: c.clientId,
      auditId: c.auditId,
      name: c.name,
      hostname: c.hostname,
      box: c.box,
      service: c.service,
      deliveredAt: c.deliveredAt,
      scope: c.scope,
      recordIds: {
        ...c.recordIds,
        licenceDocument: doc.sha256 ? 'SHA256-' + doc.sha256.slice(0, 16) : 'unknown',
      },
      licence: {
        version: c.licenceVersion || (gate && gate.licenceVersion) || '',
        document: doc,
      },
      build: known
        ? {
          total: Number(payoff && payoff.total) || 0,
          paid: Number(payoff && payoff.confirmedPaid) || 0,
          remaining: Number(payoff && payoff.remaining) || 0,
          projectedPayoffMonth: (payoff && payoff.estimatedPayoffMonth) || '',
          source: (payoff && payoff.source) || '',
          readAt: (payoff && payoff.updatedAt) || '',
        }
        : null,
      gate: gate
        ? {
          state: gate.state,
          totalsKnown: known,
          totalDue: known ? gate.totalDue : null,
          overdueTotal: known ? gate.overdueTotal : null,
          overdueMonths: known ? gate.overdueMonths : null,
          dueAt: gate.dueAt || '',
          graceEndsAt: gate.graceEndsAt || '',
          lienSaleAt: gate.lienSaleAt || '',
          lienCureDeadlineAt: gate.lienCureDeadlineAt || '',
          lienNoticeRecorded: !!gate.lienNoticeRecorded,
          note: gate.note || '',
        }
        : null,
      why: known ? '' : (state ? (live ? 'the ledger or gate could not be read' : 'no live hosting record for this client') : 'the hosting reader is unavailable'),
      events: eventsFor(c.clientId),
    };
  });
  const value = {
    at: new Date().toISOString(),
    schema: 'client-portfolio/1',
    registry: 'server/data/client-portfolio.json',
    events: 'server/data/client-audit.jsonl',
    licenceDocument: doc,
    clients,
    readOnly: true,
  };
  // A licence version whose document hash changed is worth one audit row, so the
  // record shows which text was current on which day. Appended once per hash.
  for (const c of clients) {
    if (!doc.sha256) break;
    const seen = c.events.some((e) => e.action === 'licence-text-hash' && e.detail === doc.sha256);
    if (!seen) recordEvent(c.clientId, 'licence-text-hash', doc.sha256);
  }
  return value;
}

/** Plain-text audit report handed to the owner (IDs + verified facts). */
function auditReport(portfolio) {
  const p = portfolio;
  const lines = [];
  lines.push('# HaksterAI — client portfolio audit report');
  lines.push('');
  lines.push('Generated: ' + p.at + ' (UTC)');
  lines.push('Registry: ' + p.registry);
  lines.push('Audit events: ' + p.events);
  lines.push('Licence document: ' + p.licenceDocument.path + ' · ' + p.licenceDocument.bytes + ' bytes · SHA-256 ' + (p.licenceDocument.sha256 || 'unreadable') + ' · updated ' + (p.licenceDocument.updatedAt || 'unknown'));
  lines.push('');
  for (const c of p.clients) {
    lines.push('## ' + c.name + ' — ' + c.clientId + ' · audit ' + c.auditId);
    lines.push('');
    lines.push('- Hostname: ' + c.hostname + ' (' + c.box + ', service ' + c.service + ')');
    lines.push('- Delivered: ' + c.deliveredAt);
    lines.push('- Scope: ' + c.scope);
    lines.push('- Record IDs: licence ' + c.recordIds.licence + ' · build ' + c.recordIds.build + ' · invoices ' + c.recordIds.invoices + ' · licence text ' + c.recordIds.licenceDocument);
    lines.push('- Licence version: ' + c.licence.version + ' (' + c.licence.document.path + ')');
    if (c.build) {
      lines.push('- Build: total $' + c.build.total.toFixed(2) + ' · paid $' + c.build.paid.toFixed(2) + ' · remaining $' + c.build.remaining.toFixed(2) + ' · projected payoff ' + (c.build.projectedPayoffMonth || 'unknown') + ' · source ' + (c.build.source || 'unknown') + ' · read ' + c.build.readAt);
    } else {
      lines.push('- Build: not reported — ' + (c.why || 'no ledger read'));
    }
    if (c.gate) {
      lines.push('- Admin gate: ' + c.gate.state + (c.gate.totalsKnown ? ' · total due $' + Number(c.gate.totalDue).toFixed(2) + ' · overdue $' + Number(c.gate.overdueTotal).toFixed(2) : ' · totals not known') + ' · due ' + (c.gate.dueAt || '—') + ' · lien notice ' + (c.gate.lienSaleAt || '—') + ' · cure ' + (c.gate.lienCureDeadlineAt || '—'));
    } else {
      lines.push('- Admin gate: not reported');
    }
    if (c.events.length) {
      lines.push('- Audit rows:');
      for (const e of c.events.slice(-10)) lines.push('  - ' + e.at + ' · ' + e.action + (e.detail ? ' · ' + e.detail : ''));
    }
    lines.push('');
  }
  lines.push('Figures are read from the live invoice ledger at generation time. Where a source could not be read, the report says so instead of showing a number. IDs are stable; the licence-text hash identifies the exact document.');
  return lines.join('\n') + '\n';
}

module.exports = { build, auditReport, recordEvent, ensureRegistry, REGISTRY, EVENTS, LICENCE_DOC };
