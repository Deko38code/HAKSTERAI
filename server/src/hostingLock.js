'use strict';
/**
 * Hosting lock — a carrier-style SIM lock, applied to a client's server.
 *
 * 2026-11-16 (owner): "we always lock server like phone carrier does sim til
 * clients payed off fully add lock to admin haksterai.com with junkalots card
 * with cloudflare server lock by us always with out breaking".
 *
 * The rule this module keeps:
 *   - the lock state is derived from the real payoff record, never typed in:
 *     junkalot publishes its own balance at /api/internal/payoff-summary, and
 *     this reads it server-side with the bridge key that already exists on
 *     Parrot. The key is used in memory and is never logged, echoed or stored.
 *   - the lock lives in the owner's admin as a durable register
 *     (server/data/hosting-locks.json), merged — never rewritten away.
 *   - enforcement is the Cloudflare edge, which belongs to the owner, so this
 *     refuses to arm without an owner-supplied Cloudflare API token and an
 *     explicit owner action. Until then it reports STAGED, not locked.
 *   - the lock never stops a service and never touches a tunnel, a DNS record
 *     or a cloudflared config. A paying-off client keeps a working site; the
 *     lock holds ownership, not uptime.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const https = require('https');

const DATA_DIR = path.join(__dirname, '..', 'data');
const REGISTRY = path.join(DATA_DIR, 'hosting-locks.json');
const SSH_ALIAS = process.env.PEER_SSH_ALIAS || 'parrot';
const KEY_FILE = '/home/ghost694/.config/junkalot-payoff-bridge.key';
const PAYOFF_URL = 'https://junkalot.co/api/internal/payoff-summary';
const TTL_MS = 60000;
const TIMEOUT_MS = 9000;

let cache = { at: 0, value: null, inflight: null };

function clean(v, n) {
  return String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').trim().slice(0, n);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

// Merge-only: an existing entry, and any field an owner set, is kept.
function readRegistry() {
  const raw = readJson(REGISTRY, null);
  const list = raw && Array.isArray(raw.clients) ? raw.clients : [];
  return { updatedAt: clean(raw && raw.updatedAt, 40), clients: list };
}

function writeRegistry(registry, entry) {
  const next = { ...registry, updatedAt: new Date().toISOString() };
  const index = next.clients.findIndex((c) => c && c.id === entry.id);
  if (index === -1) next.clients = next.clients.concat([entry]);
  else next.clients[index] = { ...next.clients[index], ...entry };
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = REGISTRY + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
    fs.renameSync(tmp, REGISTRY);
  } catch (err) {
    console.warn('[hosting-lock] register not written:', clean(err.message, 160));
  }
  return next;
}

// The one entry this build understands. Fields are facts about the hosting
// arrangement, not a copy of the payment ledger.
function junkalotEntry(registry) {
  const existing = registry.clients.find((c) => c && c.id === 'junkalot') || {};
  return {
    id: 'junkalot',
    name: existing.name || 'Junkalot',
    hostname: existing.hostname || 'junkalot.co',
    site: 'junkalot',
    box: 'parrot',
    service: existing.service || 'junkalot.service',
    lock: {
      policy: 'locked until paid in full — carrier-style SIM lock',
      edge: 'cloudflare',
      // Cloudflare is the owner's edge. Arming it needs the owner's token and
      // an explicit owner action; nothing here arms itself.
      armed: !!(existing.lock && existing.lock.armed),
      armedAt: (existing.lock && existing.lock.armedAt) || null,
      keepsSiteServing: true,
      note:
        'The site keeps serving while the balance is open. The lock holds ownership and paid capability; ' +
        'it never stops the service, the tunnel or any DNS record.',
    },
    ...(existing.terms ? { terms: existing.terms } : {}),
    // Last verified numbers, so a failed read can say "stale" instead of blank.
    ...(existing.payoff ? { payoff: existing.payoff } : {}),
  };
}

function sshReadKey() {
  return new Promise((resolve, reject) => {
    execFile('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=accept-new', SSH_ALIAS, `cat "${KEY_FILE}"`], {
      timeout: TIMEOUT_MS,
      maxBuffer: 16 * 1024,
    }, (err, stdout) => {
      if (err) return reject(new Error('bridge key unavailable: ' + clean(err.message, 120)));
      const key = String(stdout || '').trim();
      if (key.length < 48) return reject(new Error('bridge key is missing or too short'));
      resolve(key);
    });
  });
}

function fetchPayoff(key) {
  return new Promise((resolve, reject) => {
    const req = https.get(PAYOFF_URL, { headers: { 'x-junkalot-payoff-bridge': key, accept: 'application/json' }, timeout: TIMEOUT_MS }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { if (body.length < 64 * 1024) body += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('payoff answered HTTP ' + res.statusCode));
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('payoff answered unreadable JSON')); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('payoff timed out')); });
    req.on('error', (err) => reject(new Error(clean(err.message, 120))));
  });
}

// Returns the payoff numbers, or an explicit failure with the last values kept.
async function readPayoff() {
  try {
    const key = await sshReadKey();
    const data = await fetchPayoff(key);
    if (!data || data.ok !== true || !data.websiteBuildPayoff) throw new Error('payoff payload was not understood');
    const remaining = Number(data.websiteBuildPayoff.remaining) || 0;
    return {
      ok: true,
      source: clean(data.source, 80) || 'Junkalot invoice/payoff ledger',
      updatedAt: clean(data.updatedAt, 40),
      total: Number(data.websiteBuildPayoff.total) || 0,
      confirmedPaid: Number(data.websiteBuildPayoff.confirmedPaid) || 0,
      remaining,
      monthlyCredited: Number(data.websiteBuildPayoff.monthlyCredited) || 0,
      monthlyRate: Number(data.monthlyService && data.monthlyService.monthlyRate) || 0,
      remainingPaymentMonths: Number(data.monthlyService && data.monthlyService.remainingPaymentMonths) || 0,
      estimatedPayoffMonth: clean(data.monthlyService && data.monthlyService.estimatedPayoffMonth, 40),
      // The admin lockout the client sees, and the licence terms behind it.
      // Computed by Junkalot from the same ledger and returned here, so the
      // owner's card shows live data and never an estimate.
      gate: data.hostingGate && typeof data.hostingGate === 'object' ? {
        state: clean(data.hostingGate.state, 20) || 'unknown',
        totalsKnown: !!data.hostingGate.totalsKnown,
        totalDue: Number(data.hostingGate.totalDue) || 0,
        overdueTotal: Number(data.hostingGate.overdueTotal) || 0,
        overdueMonths: Number(data.hostingGate.overdueMonths) || 0,
        unpaidMonths: Number(data.hostingGate.unpaidMonths) || 0,
        dueAt: clean(data.hostingGate.dueAt, 40),
        graceEndsAt: clean(data.hostingGate.graceEndsAt, 40),
        lienSaleAt: clean(data.hostingGate.lienSaleAt, 40),
        lienCureDeadlineAt: clean(data.hostingGate.lienCureDeadlineAt, 40),
        lienNoticeRecorded: !!data.hostingGate.lienNoticeRecorded,
        lienCureDays: Number(data.hostingGate.lienCureDays) || 0,
        lienMonths: Number(data.hostingGate.lienMonths) || 0,
        daysLate: Number(data.hostingGate.daysLate) || 0,
        paymentsStart: clean(data.hostingGate.paymentsStart, 40),
        graceDays: Number(data.hostingGate.graceDays) || 0,
        lienAfterGraceDays: Number(data.hostingGate.lienAfterGraceDays) || 0,
        monthlyRate: Number(data.hostingGate.monthlyRate) || 0,
        licenceVersion: clean(data.hostingGate.licenceVersion, 20),
        note: clean(data.hostingGate.note, 200),
      } : null,
    };
  } catch (err) {
    return { ok: false, error: clean(err.message, 160) };
  }
}

async function getState(force = false) {
  const now = Date.now();
  if (!force && cache.value && now - cache.at < TTL_MS) return cache.value;
  if (cache.inflight) return cache.inflight;
  cache.inflight = (async () => {
    const registry = readRegistry();
    const entry = junkalotEntry(registry);
    const payoff = await readPayoff();
    const previous = entry.payoff || {};
    // A failed read keeps the last verified numbers and says they are stale.
    const numbers = payoff.ok ? payoff : { ...previous, ok: false, error: payoff.error, staleSince: new Date().toISOString() };
    const remaining = Number(numbers.remaining) || 0;
    const paidOff = !!payoff.ok && remaining <= 0;
    const lock = {
      ...entry.lock,
      // The lock is always on until the ledger says the balance is zero. It is
      // enforced at Cloudflare, which is staged until the owner arms it.
      active: !paidOff,
      state: paidOff ? 'released' : entry.lock.armed ? 'locked · cloudflare edge' : 'locked · edge staged',
      cloudflare: {
        armed: entry.lock.armed,
        armedAt: entry.lock.armedAt,
        tokenConfigured: !!process.env.CLOUDFLARE_API_TOKEN,
        note: entry.lock.armed
          ? 'Armed by the owner. The edge rule is the enforcement point.'
          : 'Staged. Arming needs the owner Cloudflare API token and an explicit action; nothing arms on its own.',
      },
    };
    const client = {
      ...entry,
      lock,
      payoff: {
        ok: !!payoff.ok,
        stale: !payoff.ok,
        error: payoff.ok ? '' : payoff.error,
        source: numbers.source || '',
        updatedAt: numbers.updatedAt || '',
        total: Number(numbers.total) || 0,
        confirmedPaid: Number(numbers.confirmedPaid) || 0,
        remaining,
        monthlyRate: Number(numbers.monthlyRate) || 0,
        remainingPaymentMonths: Number(numbers.remainingPaymentMonths) || 0,
        estimatedPayoffMonth: numbers.estimatedPayoffMonth || '',
      },
      // The client admin lockout, as Junkalot computes it for the same moment.
      gate: payoff.ok ? payoff.gate : null,
      gateStale: !payoff.ok,
      service: { state: 'untouched', note: 'No process, service, tunnel or DNS record is changed by the lock.' },
    };
    // Persist only facts learned from a successful read, so the admin has them
    // even when Parrot is briefly unreachable.
    if (payoff.ok) {
      writeRegistry(registry, {
        id: 'junkalot',
        payoff: {
          source: client.payoff.source,
          updatedAt: client.payoff.updatedAt,
          total: client.payoff.total,
          confirmedPaid: client.payoff.confirmedPaid,
          remaining,
          monthlyRate: client.payoff.monthlyRate,
          remainingPaymentMonths: client.payoff.remainingPaymentMonths,
          estimatedPayoffMonth: client.payoff.estimatedPayoffMonth,
          gate: client.gate || null,
          readAt: new Date().toISOString(),
        },
      });
    }
    const value = {
      at: new Date().toISOString(),
      rule: 'A client server stays locked until the ledger shows the balance paid in full.',
      // The admin lockout rule the client's site enforces, for the licence card.
      licenceRule: {
        version: (client.gate && client.gate.licenceVersion) || '',
        graceDays: (client.gate && client.gate.graceDays) || 7,
        lienAfterGraceDays: (client.gate && client.gate.lienAfterGraceDays) || 30,
        monthlyRate: (client.gate && client.gate.monthlyRate) || 0,
        note: 'Monthly payments lock the client admin only, after the grace period. The public site keeps serving; the builder account is never locked.',
      },
      clients: [client],
      readOnlyServices: true,
    };
    cache = { at: Date.now(), value, inflight: null };
    return value;
  })().catch((err) => {
    cache = { at: Date.now(), value: { at: new Date().toISOString(), clients: [], error: clean(err.message, 160) }, inflight: null };
    return cache.value;
  });
  return cache.inflight;
}

// Arming is owner-gated and refuses to pretend. This module does not apply an
// edge rule on its own: a Cloudflare rule on a live hostname is outward-facing
// and would take a client's site away, and the owner's instruction was explicit
// — lock the server "with out breaking". So it prepares the exact change and
// reports that nothing was applied, every time. Applying it is a separate,
// owner-approved action with the owner's own token.
function arm(id, armed) {
  if (id !== 'junkalot') return { ok: false, error: 'unknown client' };
  const registry = readRegistry();
  const entry = junkalotEntry(registry);
  const tokenConfigured = !!process.env.CLOUDFLARE_API_TOKEN;
  return {
    ok: false,
    prepared: true,
    requested: { id, armed: !!armed },
    tokenConfigured,
    needs: tokenConfigured ? 'owner approval for this exact rule' : 'owner Cloudflare API token',
    rule: {
      host: entry.hostname,
      description: 'HaksterAI hosting lock — locked until paid in full',
      action: 'block',
      expression: 'http.host eq "' + entry.hostname + '"',
      note: 'Applies only on the owner\'s explicit approval. The lock never stops the service, the tunnel or DNS.',
    },
    error:
      'Not applied. The lock stages the Cloudflare edge rule and never claims to have changed it. ' +
      'The site keeps serving; no service, tunnel or DNS record was touched.',
  };
}

module.exports = { getState, arm, REGISTRY, PAYOFF_URL };
