'use strict';

// Login audit + pattern learning (read-only).
//
// Parses sshd/sudo entries from the host's own auth log, records every event to an
// append-only JSONL, and keeps a learned baseline of source IPs, accounts and hours so
// later events can be compared against what "normal" looks like on this box.
//
// Nothing here changes the system: no log edit, no user change, no firewall/sshd rule,
// no process touch. Findings are reported; any response stays with Deke.
//
// SCOPE: the Dell (this host). Parrot's auth log is not readable by the ghost694 account
// (not in adm/systemd-journal), so it is probed and reported as unavailable rather than
// silently skipped. Fixing that needs a group change = owner decision.

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const EVENTS_FILE = path.join(DATA_DIR, 'login-events.jsonl');
const ANOMALIES_FILE = path.join(DATA_DIR, 'login-anomalies.jsonl');
const BASELINE_FILE = path.join(DATA_DIR, 'login-baseline.json');
const PENDING_FILE = path.join(DATA_DIR, 'login-pending-anomalies.json');
const TRUSTED_FILE = path.join(DATA_DIR, 'login-trusted-ips.json');

const AUTH_LOG = '/var/log/auth.log';
const LEARNING_EVENTS = 50;   // below this the baseline is still being taught, not judging
const SEEN_CAP = 8000;

const LINE_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[-+]\d{2}:?\d{2}|Z)?)\s+(\S+)\s+([A-Za-z0-9_.-]+)\[(\d+)\]:\s*(.*)$/;

function hashLine(line) {
  return crypto.createHash('sha1').update(line, 'utf8').digest('hex').slice(0, 16);
}

function isPublicIp(ip) {
  if (!ip) return false;
  if (/^(10\.|127\.|192\.168\.|169\.254\.|0\.|::1$|fe80:|fc|fd)/i.test(ip)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return false;
  return /^\d+\.\d+\.\d+\.\d+$/.test(ip) || /:/.test(ip);
}

function execFileP(file, args, timeout) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || (err && err.message) || '').slice(0, 300) });
    });
  });
}

// ── parsing ──────────────────────────────────────────────────────────────────────────

function parseLine(line, host) {
  const m = LINE_RE.exec(line);
  if (!m) return null;
  const [, ts, h, proc, pid, msg] = m;
  const base = { ts, host: h || host, proc, pid: Number(pid), raw: hashLine(line) };

  let a;
  if ((a = /^Accepted (\S+) for (\S+) from (\S+) port \d+/.exec(msg))) {
    return { ...base, kind: 'success', method: a[1], user: a[2], ip: a[3] };
  }
  if ((a = /^Failed (\S+) for (?:invalid user )?(\S+) from (\S+) port \d+/.exec(msg))) {
    return { ...base, kind: 'failure', method: a[1], user: a[2], ip: a[3] };
  }
  if ((a = /^Invalid user (\S+) from (\S+)/.exec(msg))) {
    return { ...base, kind: 'invalid', method: null, user: a[1], ip: a[2] };
  }
  if ((a = /^error: PAM: Authentication failure for (\S+) from (\S+)/.exec(msg))) {
    return { ...base, kind: 'failure', method: 'pam', user: a[1], ip: a[2] };
  }
  if (proc === 'sudo' && (a = /^\s*(\S+) : .*USER=(\S+) ; COMMAND=(.*)$/.exec(msg))) {
    return { ...base, kind: 'sudo', method: null, user: a[1], runAs: a[2], command: a[3].slice(0, 200), ip: null };
  }
  return null;
}

function parseLines(text, host) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (!line || line[0] === ' ') continue;      // "Hint:" continuation lines
    const ev = parseLine(line, host);
    if (ev) out.push(ev);
  }
  return out;
}

// ── collection ──────────────────────────────────────────────────────────────────────

async function collectLocalDell() {
  let text = '';
  try {
    const buf = fs.readFileSync(AUTH_LOG, 'utf8');
    const lines = buf.split('\n');
    text = lines.slice(Math.max(0, lines.length - 4000)).join('\n');
  } catch (e) {
    const j = await execFileP('journalctl', ['-u', 'ssh', '-u', 'sshd', '-o', 'short-iso', '--no-pager', '-n', '4000'], 20000);
    if (!j.ok || /No entries/.test(j.out)) {
      return { host: 'ghost-Inspiron-7348', ok: false, detail: `auth.log unreadable (${e.code || e.message})`, events: [] };
    }
    text = j.out;
  }
  return { host: 'ghost-Inspiron-7348', ok: true, detail: AUTH_LOG, events: parseLines(text, 'ghost-Inspiron-7348') };
}

async function collectParrot() {
  const j = await execFileP('ssh', [
    '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=6', '-o', 'StrictHostKeyChecking=accept-new',
    'ghost694@parrot', "journalctl _COMM=sshd -o short-iso --no-pager -n 2000 2>/dev/null || true",
  ], 15000);
  if (!j.ok) return { host: 'parrot', ok: false, detail: `ssh failed: ${j.err.split('\n')[0]}`, events: [] };
  const events = parseLines(j.out, 'parrot');
  if (!events.length && /No entries|not seeing messages|Hint:/i.test(j.out)) {
    return { host: 'parrot', ok: false, detail: 'journal not readable by ghost694 (needs adm or systemd-journal group)', events: [] };
  }
  if (!j.out.trim()) {
    return { host: 'parrot', ok: false, detail: 'no journal output', events: [] };
  }
  return { host: 'parrot', ok: true, detail: 'journalctl _COMM=sshd', events };
}

async function collectDetailed() {
  const [dell, parrot] = await Promise.all([collectLocalDell(), collectParrot()]);
  return { sources: [dell, parrot], events: [...dell.events, ...parrot.events] };
}

async function collectAll() {
  const { events } = await collectDetailed();
  return events;
}

// ── baseline / learning ─────────────────────────────────────────────────────────────

function ensureDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
}

function emptyBaseline() {
  return {
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    totalEvents: 0,
    ips: {},
    users: {},
    hours: {},
    seen: [],
    lastRunAt: null,
    lastAnomalyCount: 0,
  };
}

function loadBaseline() {
  try { return JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')); } catch { return null; }
}

function saveBaseline(b) {
  ensureDir();
  try {
    const prev = loadBaseline();
    if (prev) fs.writeFileSync(BASELINE_FILE + '.prev', JSON.stringify(prev));
  } catch {}
  fs.writeFileSync(BASELINE_FILE, JSON.stringify(b, null, 2));
}

// Anomalies waiting for a confirmed Telegram delivery.
function loadPending() {
  try { const j = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8')); return Array.isArray(j) ? j : []; } catch { return []; }
}

function savePending(list) {
  ensureDir();
  try { fs.writeFileSync(PENDING_FILE, JSON.stringify(list.slice(-200), null, 2)); } catch (e) { console.error('[loginaudit] savePending failed:', e.message); }
}

function clearPending() {
  savePending([]);
}

// ── owner-declared source IPs ───────────────────────────────────────────────────────
// IPs the owner says are his own (LAN boxes, his phone, his laptop). They are NOT
// silenced: a failure pattern from a trusted IP still reports, because it usually means
// a client is retrying a wrong username — but it is labelled and graded as owner LAN
// instead of being called an intrusion. root logins stay high regardless.

function loadTrusted() {
  try {
    const j = JSON.parse(fs.readFileSync(TRUSTED_FILE, 'utf8'));
    return (j && typeof j.ips === 'object' && j.ips) || {};
  } catch { return {}; }
}

function saveTrusted(ips) {
  ensureDir();
  try {
    if (fs.existsSync(TRUSTED_FILE)) {
      fs.copyFileSync(TRUSTED_FILE, TRUSTED_FILE + '.prev');
    }
  } catch {}
  fs.writeFileSync(TRUSTED_FILE, JSON.stringify({ updatedAt: new Date().toISOString(), ips }, null, 2));
}

function isTrusted(ip, trusted) {
  if (!ip) return false;
  const t = trusted || loadTrusted();
  return Object.prototype.hasOwnProperty.call(t, ip);
}

function trustIp(ip, label) {
  if (!ip) return null;
  const ips = loadTrusted();
  ips[ip] = { label: label || 'owner device', addedAt: new Date().toISOString() };
  saveTrusted(ips);
  return ips[ip];
}

function untrustIp(ip) {
  const ips = loadTrusted();
  if (!ips[ip]) return false;
  delete ips[ip];
  saveTrusted(ips);
  return true;
}

function hourOf(ts) {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d.getHours();
}

// Compares a batch against the learned baseline, then folds it in. Returns anomalies.
function updateBaseline(events) {
  ensureDir();
  const b = loadBaseline() || emptyBaseline();
  const trusted = loadTrusted();
  const seen = new Set(b.seen || []);
  const fresh = events.filter((e) => !seen.has(e.raw));
  const anomalies = [];
  const learning = (b.totalEvents || 0) < LEARNING_EVENTS;

  // Pre-pass: per-IP failure counts inside this batch (brute-force detection).
  const failsByIp = {};
  for (const e of fresh) if (e.kind === 'failure' || e.kind === 'invalid') failsByIp[e.ip] = (failsByIp[e.ip] || 0) + 1;
  const seenFail = new Set();
  const seenOk = new Set();

  for (const e of fresh) {
    const ipKnown = e.ip && b.ips[e.ip];
    const userKnown = b.users[e.user];

    if (e.kind === 'success' || e.kind === 'failure' || e.kind === 'invalid') {
      if (!learning) {
        if (e.ip && !ipKnown) {
          const own = isTrusted(e.ip, trusted);
          anomalies.push({
            severity: own ? 'info' : (e.kind === 'success' && isPublicIp(e.ip) ? 'high' : 'medium'),
            id: own ? 'trusted-ip' : 'new-ip',
            title: own ? 'Login from a known owner device' : 'Login from a new source IP',
            detail: `${e.kind} ${e.user}@${e.host} from ${e.ip}${own ? ' (owner-declared)' : isPublicIp(e.ip) ? ' (public)' : ''}`,
            ip: e.ip, user: e.user, host: e.host, ts: e.ts,
          });
        }
        if (!userKnown && e.kind === 'success') {
          anomalies.push({ severity: 'medium', id: 'new-user', title: 'New account seen logging in', detail: `${e.user}@${e.host} from ${e.ip || '?'}`, ip: e.ip, user: e.user, host: e.host, ts: e.ts });
        }
      }
      if (e.kind === 'failure' || e.kind === 'invalid') {
        if (failsByIp[e.ip] >= 10 && !seenFail.has(e.ip)) {
          seenFail.add(e.ip);
          const own = isTrusted(e.ip, trusted);
          anomalies.push({
            severity: own ? 'medium' : 'high',
            id: 'brute-force',
            title: own ? 'Repeated login failures from an owner device' : 'Repeated login failures from one IP',
            detail: `${failsByIp[e.ip]} failures from ${e.ip}${own ? ' (owner-declared — usually a saved client retrying a wrong username)' : isPublicIp(e.ip) ? ' (public)' : ''}`,
            ip: e.ip, user: e.user, host: e.host, ts: e.ts,
          });
        }
      }
      if (e.kind === 'success' && failsByIp[e.ip] > 0 && !seenOk.has(e.ip)) {
        seenOk.add(e.ip);
        const own = isTrusted(e.ip, trusted);
        anomalies.push({
          severity: own ? 'low' : 'high',
          id: 'fail-then-success',
          title: own ? 'Owner device logged in after a failed attempt' : 'Successful login after failures from the same IP',
          detail: `${e.user}@${e.host} from ${e.ip}${own ? ' (owner-declared)' : ''}`,
          ip: e.ip, user: e.user, host: e.host, ts: e.ts,
        });
      }
      if (e.kind === 'success' && /^root$/i.test(e.user || '')) {
        anomalies.push({ severity: 'high', id: 'root-login', title: 'Direct root login succeeded', detail: `${e.host} from ${e.ip || '?'}`, ip: e.ip, user: e.user, host: e.host, ts: e.ts });
      }
    }

    // Fold into the baseline.
    if (e.ip) {
      const rec = b.ips[e.ip] || (b.ips[e.ip] = { count: 0, success: 0, failure: 0, users: [], hosts: [], firstSeen: e.ts, lastSeen: e.ts, public: isPublicIp(e.ip) });
      rec.count++;
      if (e.kind === 'success') rec.success++;
      if (e.kind === 'failure' || e.kind === 'invalid') rec.failure++;
      if (e.user && !rec.users.includes(e.user)) rec.users.push(e.user);
      if (e.host && !rec.hosts.includes(e.host)) rec.hosts.push(e.host);
      rec.lastSeen = e.ts;
    }
    if (e.user) {
      const u = b.users[e.user] || (b.users[e.user] = { count: 0, ips: [], firstSeen: e.ts, lastSeen: e.ts });
      u.count++;
      if (e.ip && !u.ips.includes(e.ip)) u.ips.push(e.ip);
      u.lastSeen = e.ts;
    }
    const h = hourOf(e.ts);
    if (h !== null) b.hours[h] = (b.hours[h] || 0) + 1;

    b.totalEvents = (b.totalEvents || 0) + 1;
    seen.add(e.raw);
  }

  b.updatedAt = new Date().toISOString();
  b.lastRunAt = b.updatedAt;
  if (fresh.length) b.lastAnomalyCount = anomalies.length;
  b.seen = Array.from(seen).slice(-SEEN_CAP);

  // Append-only history: never rewritten, never pruned by the bot.
  if (fresh.length) {
    try {
      fs.appendFileSync(EVENTS_FILE, fresh.map((e) => JSON.stringify({ ...e, learned: learning })).join('\n') + '\n');
    } catch (err) { console.error('[loginaudit] write events failed:', err.message); }
  }
  if (anomalies.length) {
    try {
      fs.appendFileSync(ANOMALIES_FILE, anomalies.map((a) => JSON.stringify({ at: new Date().toISOString(), ...a })).join('\n') + '\n');
    } catch (err) { console.error('[loginaudit] write anomalies failed:', err.message); }
    // Queue for delivery. Cleared only once a report actually reaches Telegram, so a
    // failed send retries next cycle instead of the anomaly disappearing into a log file.
    try { savePending([...loadPending(), ...anomalies]); } catch (err) { console.error('[loginaudit] queue anomalies failed:', err.message); }
  }

  saveBaseline(b);
  return anomalies;
}

// ── text output ─────────────────────────────────────────────────────────────────────

function shortTs(ts) {
  return String(ts).slice(0, 19).replace('T', ' ');
}

function recentLoginsText(events, limit = 15) {
  const notable = events
    .filter((e) => e.kind === 'success' || e.kind === 'failure' || e.kind === 'invalid' || e.kind === 'sudo')
    .slice(-limit)
    .reverse();
  if (!notable.length) return 'No login or sudo events in the last 24h.';
  const lines = ['🔑 *Recent logins* (newest first)', ''];
  for (const e of notable) {
    const tag = e.kind === 'success' ? '✅' : e.kind === 'sudo' ? '⚙️' : '❌';
    const who = e.kind === 'sudo' ? `${e.user} → ${e.runAs || 'root'}` : `${e.user}${e.ip ? '@' + e.ip : ''}`;
    lines.push(`${tag} ${shortTs(e.ts)} ${who} (${e.host}${e.method ? ', ' + e.method : ''})`);
  }
  lines.push('', 'Read-only parse of the host auth log. Nothing changed.');
  return lines.join('\n');
}

function topIpsText(base, limit = 15) {
  if (!base || !base.ips || !Object.keys(base.ips).length) {
    return 'No source IPs recorded yet. Send /logins once to start the baseline.';
  }
  const rows = Object.entries(base.ips)
    .sort((a, b2) => b2[1].count - a[1].count)
    .slice(0, limit);
  const trusted = loadTrusted();
  const lines = ['🌐 *Source IPs seen* (most active first)', ''];
  for (const [ip, r] of rows) {
    const own = isTrusted(ip, trusted);
    const mark = own ? '✅' : r.public ? '⚠️' : '•';
    const tag = own ? ` (owner: ${(trusted[ip] && trusted[ip].label) || 'declared'})` : r.public ? ' (public)' : '';
    lines.push(`${mark} ${ip} — ${r.count} events, ${r.success} ok / ${r.failure} failed${tag}`);
    if (r.users && r.users.length) lines.push(`   users: ${r.users.slice(0, 5).join(', ')}`);
  }
  if (Object.keys(trusted).length) {
    lines.push('', `✅ = owner-declared source (${Object.keys(trusted).length}): ${Object.keys(trusted).join(', ')}`);
  }
  lines.push('', 'Failures from an owner device still report — they usually mean a saved client is retrying a wrong username.');
  lines.push('', `Baseline started ${shortTs(base.createdAt)} · ${base.totalEvents || 0} events learned`);
  return lines.join('\n');
}

function baselineText() {
  const b = loadBaseline();
  if (!b) return 'No baseline yet. Send /logins or wait for the scheduled login audit.';
  const hours = Object.entries(b.hours || {}).sort((a, c) => c[1] - a[1]).slice(0, 4);
  const users = Object.entries(b.users || {}).sort((a, c) => c[1].count - a[1].count).slice(0, 6);
  const publicIps = Object.entries(b.ips || {}).filter(([, r]) => r.public).map(([ip]) => ip);
  const trusted = loadTrusted();
  const learning = (b.totalEvents || 0) < LEARNING_EVENTS;
  return [
    '🧠 *Learned login baseline*',
    '',
    `Status: ${learning ? `learning (${b.totalEvents || 0}/${LEARNING_EVENTS} events before it judges)` : 'active'}`,
    `Baseline since: ${shortTs(b.createdAt)}`,
    `Last updated: ${shortTs(b.updatedAt)}`,
    `Events learned: ${b.totalEvents || 0}`,
    `Distinct source IPs: ${Object.keys(b.ips || {}).length}${publicIps.length ? ` (${publicIps.length} public: ${publicIps.slice(0, 4).join(', ')})` : ''}`,
    `Owner-declared IPs: ${Object.keys(trusted).length ? Object.entries(trusted).map(([ip, t]) => `${ip}${t.label ? ' (' + t.label + ')' : ''}`).join(', ') : 'none — all sources judged as unknown'}`,
    `Accounts seen: ${Object.keys(b.users || {}).join(', ') || 'none'}`,
    `Busiest hours: ${hours.map(([h, n]) => `${h}:00(${n})`).join(' ') || 'n/a'}`,
    `Anomalies last run: ${b.lastAnomalyCount || 0}`,
    '',
    'Top accounts:',
    ...users.map(([u, r]) => `• ${u}: ${r.count} events from ${(r.ips || []).length} IP(s)`),
    '',
    'Learned from the host auth log only. Read-only.',
  ].join('\n');
}

function anomaliesText(anomalies, hosts) {
  if (!anomalies.length) return null;
  const order = { high: 0, medium: 1, low: 2 };
  const sorted = [...anomalies].sort((a, b) => order[a.severity] - order[b.severity]);
  const dot = { high: '🔴', medium: '🟠', low: '🟡' };
  const lines = [`🔐 *Login audit* — ${sorted.length} pattern change(s)`, ''];
  for (const a of sorted.slice(0, 12)) lines.push(`${dot[a.severity] || '•'} ${a.title} — ${a.detail}`);
  if (hosts) {
    const bad = (hosts.sources || []).filter((s) => !s.ok);
    if (bad.length) lines.push('', ...bad.map((s) => `⚠️ ${s.host}: ${s.detail}`));
  }
  lines.push('', 'Read-only. No account, rule or log was changed.');
  return lines.join('\n');
}

function sourceStatusText(detailed) {
  return (detailed.sources || []).map((s) => `${s.ok ? '✅' : '⚠️'} ${s.host}: ${s.detail} (${s.events.length} events)`).join('\n');
}

module.exports = {
  collectAll,
  collectDetailed,
  updateBaseline,
  loadBaseline,
  recentLoginsText,
  topIpsText,
  baselineText,
  anomaliesText,
  sourceStatusText,
  anomaliesFrom: (r) => r.anomalies || [],
  loadPending,
  savePending,
  clearPending,
  loadTrusted,
  saveTrusted,
  isTrusted,
  trustIp,
  untrustIp,
  isPublicIp,
  EVENTS_FILE,
  BASELINE_FILE,
  ANOMALIES_FILE,
  TRUSTED_FILE,
};

if (require.main === module) {
  (async () => {
    const [cmd, arg, ...rest] = process.argv.slice(2);

    // node server/src/loginAudit.js --trust 10.0.0.210 "owner laptop"
    if (cmd === '--trust') {
      if (!arg) { console.error('usage: --trust <ip> [label]'); process.exit(2); }
      const rec = trustIp(arg, rest.join(' '));
      console.log(`trusted ${arg} — ${rec.label}`);
      return;
    }
    if (cmd === '--untrust') {
      if (!arg) { console.error('usage: --untrust <ip>'); process.exit(2); }
      console.log(untrustIp(arg) ? `removed ${arg}` : `${arg} was not trusted`);
      return;
    }
    if (cmd === '--trusted') {
      const t = loadTrusted();
      const keys = Object.keys(t);
      if (!keys.length) { console.log('no owner-declared IPs'); return; }
      for (const ip of keys) console.log(`${ip}\t${t[ip].label || ''}\t${t[ip].addedAt || ''}`);
      return;
    }

    const d = await collectDetailed();
    console.log(sourceStatusText(d));
    const anomalies = updateBaseline(d.events);
    console.log(`\nevents parsed: ${d.events.length} · anomalies: ${anomalies.length}`);
    const txt = anomaliesText(anomalies, d);
    if (txt) console.log('\n' + txt);
    else console.log('\nno pattern changes');
    console.log('\n' + baselineText());
  })().catch((e) => { console.error('login audit failed:', e.message); process.exit(1); });
}
