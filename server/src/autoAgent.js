'use strict';

// Dell Auto Agent — real, read-only security checks + IP audit.
//
// Runs automatically:
//   • on server startup (startAutoAgent(), a few seconds after listen)
//   • when the owner opens the Dell server panel (POST /api/admin/autoagent/run
//     with trigger=panel; throttled so a page refresh cannot hammer the box)
//   • manually ("Run now" button, trigger=manual, force=1)
//
// It READS ONLY: auth.log via loginAudit, listening sockets via `ss`, package
// state via `apt list`, accounts via /etc/passwd and `getent`, the app's own
// security audit, and its own ip_denials table. It never stops, kills, edits
// config, changes firewall rules, or installs anything. Findings are reported;
// every response stays with Deke.

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const loginAudit = require('./loginAudit');
const { runSecurityAudit } = require('./security');
const accessGuard = require('./accessGuard');
const { getDb } = require('./db');

const DATA_DIR = path.join(__dirname, '..', 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'auto-agent-history.json');
const THROTTLE_MS = 60 * 1000;      // panel opens inside this window reuse the last run
const HISTORY_KEEP = 50;
const FAILURE_WINDOW_H = 24;
const MAX_OUTPUT = 512 * 1024;

let currentRun = null;              // in-flight promise
let lastResult = null;              // most recent completed result

function run(cmd, args, timeout = 15000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: MAX_OUTPUT }, (err, stdout, stderr) => {
      const out = String(stdout || '');
      const errText = String(stderr || (err && err.message) || '');
      resolve({ ok: !err, out, err: errText, needsRoot: /permission denied|operation not permitted|must be root|you need to be root/i.test(errText + out) });
    });
  });
}

function ensureDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
}

function readHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')) || []; } catch { return []; }
}

function writeHistory(list) {
  ensureDir();
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(list.slice(0, HISTORY_KEEP), null, 2)); } catch {}
}

// ── individual checks (each returns { id, label, state, detail }) ────────
// state: pass | warn | fail | info — the panel colours them and the run's
// overall state is derived from the worst one.

async function checkPorts() {
  const ss = await run('ss', ['-ltnp']);
  if (!ss.ok && !ss.out) return { id: 'ports', label: 'Listening ports', state: 'warn', detail: 'ss unavailable: ' + (ss.err.split('\n')[0] || 'unknown') };
  const lines = ss.out.split('\n').filter((l) => /LISTEN/.test(l));
  let allInterfaces = 0;
  for (const l of lines) {
    const cols = l.trim().split(/\s+/);
    const local = cols[3] || '';
    if (/^(0\.0\.0\.0|\*|\[::\]):/.test(local)) allInterfaces += 1;
  }
  const state = lines.length ? (allInterfaces > 30 ? 'warn' : 'pass') : 'warn';
  return {
    id: 'ports',
    label: 'Listening ports',
    state,
    count: lines.length,
    detail: lines.length
      ? `${lines.length} listening · ${allInterfaces} on all interfaces`
      : 'no LISTEN sockets parsed',
  };
}

function groupByIp(events) {
  const map = new Map();
  for (const e of events) {
    if (!e || !e.ip) continue;
    const row = map.get(e.ip) || { ip: e.ip, count: 0, kinds: {}, users: new Set(), lastTs: '' };
    row.count += 1;
    row.kinds[e.kind] = (row.kinds[e.kind] || 0) + 1;
    if (e.user) row.users.add(e.user);
    if (e.ts && e.ts > row.lastTs) row.lastTs = e.ts;
    map.set(e.ip, row);
  }
  return [...map.values()]
    .map((r) => ({ ip: r.ip, count: r.count, kinds: r.kinds, users: [...r.users].slice(0, 5), lastTs: r.lastTs, public: loginAudit.isPublicIp(r.ip) }))
    .sort((a, b) => b.count - a.count);
}

async function collectDellLogins() {
  // Dell auth log only — the panel is about this box, and Parrot's journal is
  // not readable by ghost anyway. Uses loginAudit's maintained parser so the
  // panel and the SSH/IP tooling can never drift apart.
  try {
    return await loginAudit.collectLocalDell();
  } catch (e) {
    return { ok: false, detail: 'auth log unreadable: ' + e.message, events: [], source: 'none' };
  }
}

function withinHours(ts, hours) {
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return false;
  return Date.now() - t <= hours * 3600 * 1000;
}

function sshFromLog(log) {
  if (!log.ok) return { id: 'ssh', label: 'SSH / logins', state: 'info', detail: log.detail, log: null };
  const events = log.events;
  const recent = events.filter((e) => withinHours(e.ts, FAILURE_WINDOW_H));
  const failures = recent.filter((e) => e.kind === 'failure' || e.kind === 'invalid');
  const successes = recent.filter((e) => e.kind === 'success');
  const publicFailures = failures.filter((e) => loginAudit.isPublicIp(e.ip));
  const state = publicFailures.length > 20 ? 'warn' : failures.length === 0 ? 'pass' : 'info';
  return {
    id: 'ssh',
    label: 'SSH / logins',
    state,
    detail: `${failures.length} failed · ${successes.length} ok in ${FAILURE_WINDOW_H}h` + (publicFailures.length ? ` · ${publicFailures.length} from public IPs` : ''),
    log,
    recent,
  };
}

// Firewall state, read without root.
//
// `ufw status` and `iptables -S` both require root, and the old check stopped
// there — the panel showed "not readable without root" and told Deke nothing.
// These readers are world-readable and answer the real question:
//   • /etc/ufw/ufw.conf            ENABLED=yes|no — ufw's own on/off switch
//   • systemctl is-active/is-enabled ufw|nftables|firewalld — unit state
//   • /proc/modules                are netfilter tables actually loaded?
//     (a firewall that is applying rules has nf_tables/iptable_filter/xt_* in
//     the kernel; an "active" but empty unit has none)
//   • ss -ltn                      how many ports listen on every interface
// Nothing here changes firewall state — that is the owner's call.
function netfilterKernelState() {
  try {
    const mods = fs.readFileSync('/proc/modules', 'utf8').match(/^(nf_tables|iptable_\w+|ip6table_\w+|nft_\w+|xt_\w+)\b/gm) || [];
    return { loaded: mods.length > 0, modules: mods.length };
  } catch {
    return { loaded: false, modules: 0 };
  }
}

async function exposedPortCount() {
  const ss = await run('ss', ['-ltnH'], 6000);
  const lines = ss.out.split('\n').filter((l) => l.trim());
  const all = lines.filter((l) => {
    const local = l.trim().split(/\s+/)[3] || '';
    return /^(0\.0\.0\.0|\*|\[::\]|\[::ffff:0\.0\.0\.0\]):/.test(local);
  });
  return { listening: lines.length, allInterfaces: all.length };
}

async function checkFirewall() {
  const [{ loaded }, exposure, ...units] = await Promise.all([
    Promise.resolve(netfilterKernelState()),
    exposedPortCount(),
    run('systemctl', ['is-active', 'ufw'], 5000),
    run('systemctl', ['is-enabled', 'ufw'], 5000),
    run('systemctl', ['is-active', 'nftables'], 5000),
    run('systemctl', ['is-active', 'firewalld'], 5000),
  ]);
  const [ufwActive, ufwEnabled, nftActive, firewalldActive] = units.map((u) => (u.out || '').trim().split('\n')[0] || 'unknown');

  let conf = '';
  try { conf = fs.readFileSync('/etc/ufw/ufw.conf', 'utf8'); } catch {}
  const confReadable = conf.length > 0;
  const ufwSwitchOn = /^\s*ENABLED\s*=\s*yes/im.test(conf);
  const ufwInstalled = fs.existsSync('/usr/sbin/ufw');
  const exposed = `${exposure.allInterfaces} port(s) on all interfaces`;

  // Rule count, only when root-owned rule files happen to be readable.
  let rules = null;
  for (const file of ['/etc/ufw/user.rules', '/etc/ufw/user6.rules']) {
    try {
      const txt = fs.readFileSync(file, 'utf8');
      rules = (rules || 0) + (txt.match(/^-A /gm) || []).length;
    } catch {}
  }

  const base = { id: 'firewall', label: 'Firewall' };

  if (firewalldActive === 'active' || (nftActive === 'active' && loaded)) {
    const name = firewalldActive === 'active' ? 'firewalld' : 'nftables';
    return { ...base, state: 'pass', count: rules ?? undefined, detail: `${name} active · kernel filtering loaded · ${exposed}` };
  }
  if (ufwInstalled && ufwSwitchOn && loaded) {
    return {
      ...base,
      state: 'pass',
      count: rules ?? undefined,
      detail: `ufw active${rules != null ? ` · ${rules} rule(s)` : ''} · ${exposed}`,
    };
  }
  if (ufwInstalled && !ufwSwitchOn) {
    // The honest finding: the unit says "active (exited)" while ufw.conf says
    // ENABLED=no, so no filtering is applied. Report it plainly.
    const why = confReadable ? 'ufw is OFF (ENABLED=no in /etc/ufw/ufw.conf)' : 'ufw is not enabled';
    return {
      ...base,
      state: 'warn',
      count: exposure.allInterfaces,
      detail: `${why} · no netfilter rules loaded · ${exposed} — enabling needs owner approval`,
    };
  }
  if (ufwInstalled && ufwSwitchOn && !loaded) {
    return { ...base, state: 'warn', count: exposure.allInterfaces, detail: `ufw says enabled but no netfilter rules are loaded · ${exposed}` };
  }
  if (ufwInstalled) {
    return { ...base, state: 'warn', count: exposure.allInterfaces, detail: `ufw unit ${ufwActive}/${ufwEnabled}, filtering state unreadable · ${exposed}` };
  }
  return { ...base, state: 'warn', count: exposure.allInterfaces, detail: `no host firewall found · ${exposed}` };
}

async function checkUpdates() {
  const apt = await run('apt', ['list', '--upgradable'], 20000);
  if (apt.needsRoot) return { id: 'updates', label: 'Updates', state: 'info', detail: 'package state not readable' };
  const lines = apt.out.split('\n').map((l) => l.trim()).filter((l) => l && !/^WARNING/.test(l) && !/^Listing/.test(l));
  const count = lines.length;
  return { id: 'updates', label: 'Updates', state: count > 25 ? 'warn' : count === 0 ? 'pass' : 'info', count, detail: count ? `${count} upgradable package(s)` : 'up to date' };
}

async function checkAccounts() {
  const uid0 = [];
  try {
    for (const line of fs.readFileSync('/etc/passwd', 'utf8').split('\n')) {
      const p = line.split(':');
      if (p.length > 3 && p[2] === '0') uid0.push(p[0]);
    }
  } catch {}
  const sudo = await run('getent', ['group', 'sudo'], 5000);
  const sudoMembers = (sudo.out.split(':')[3] || '').split(',').filter(Boolean);
  let permitRoot = '';
  try {
    const m = fs.readFileSync('/etc/ssh/sshd_config', 'utf8').match(/^\s*PermitRootLogin\s+(\S+)/im);
    if (m) permitRoot = m[1];
  } catch {}
  const rootLoginOn = /^yes$/i.test(permitRoot);
  const state = uid0.length > 1 || rootLoginOn ? 'warn' : 'pass';
  return {
    id: 'accounts',
    label: 'Accounts',
    state,
    detail: `uid-0: ${uid0.join(', ') || 'none'} · sudo: ${sudoMembers.length} · root login ${permitRoot || 'default'}`,
  };
}

async function checkCodeAudit() {
  try {
    const report = await runSecurityAudit(path.join(__dirname, '..'), []);
    const s = report.summary || {};
    const findings = report.findings || [];
    // "Secret in .env file" is one finding per key by design — secrets are SUPPOSED
    // to live there. Counting those as a failure would make the panel permanently
    // red, so they are reported separately and never drive the state.
    const envSecret = findings.filter((f) => f.title === 'Secret in .env file');
    const actionable = findings.filter((f) => f.title !== 'Secret in .env file');
    const act = {
      critical: actionable.filter((f) => f.severity === 'critical').length,
      high: actionable.filter((f) => f.severity === 'high').length,
      medium: actionable.filter((f) => f.severity === 'medium').length,
      low: actionable.filter((f) => f.severity === 'low').length,
    };
    const state = act.critical > 0 ? 'fail' : act.high > 0 || act.medium > 0 ? 'warn' : 'pass';
    const detail = [
      `${act.critical} critical`,
      `${act.high} high`,
      `${act.medium} medium`,
      `${act.low} low`,
      `${envSecret.length} .env secret key(s) present (expected)`,
    ].join(' · ');
    return {
      id: 'code',
      label: 'App audit',
      state,
      detail,
      summary: { ...s, actionable: act, envSecretKeys: envSecret.length },
      findings: actionable.filter((f) => ['critical', 'high', 'medium'].includes(f.severity)).slice(0, 8).map((f) => ({ severity: f.severity, title: f.title, category: f.category })),
    };
  } catch (e) {
    return { id: 'code', label: 'App audit', state: 'warn', detail: 'audit failed: ' + e.message };
  }
}

// ── IP audit ─────────────────────────────────────────────────────────────
// Every address comes from a real source: the Dell auth log for SSH, the app's
// own access_logs table for web requests, and ip_denials for active blocks.
// Nothing is inferred, geolocated, or invented.
function auditIps(sshCheck, anomalies = []) {
  const recent = sshCheck.recent || [];
  const failures = recent.filter((e) => e.kind === 'failure' || e.kind === 'invalid');
  const successes = recent.filter((e) => e.kind === 'success');
  const byIp = groupByIp(recent);
  const failureIps = groupByIp(failures);
  const successIps = groupByIp(successes);

  let denials = [];
  try { denials = accessGuard.listDenials() || []; } catch {}

  let webIps = 0;
  let webTop = [];
  try {
    const db = getDb();
    const since = Math.floor(Date.now() / 1000) - FAILURE_WINDOW_H * 3600;
    webIps = db.prepare('SELECT COUNT(DISTINCT ip_address) AS c FROM access_logs WHERE created_at >= ?').get(since)?.c || 0;
    webTop = db.prepare(`SELECT ip_address AS ip, COUNT(*) AS count FROM access_logs WHERE created_at >= ? GROUP BY ip_address ORDER BY count DESC LIMIT 5`).all(since) || [];
  } catch {}

  const baseline = (() => { try { return loginAudit.loadBaseline(); } catch { return null; } })();
  const pendingAnomalies = (() => { try { const p = loginAudit.loadPending(); return Array.isArray(p) ? p.length : (p && p.items ? p.items.length : 0); } catch { return 0; } })();

  const state = failureIps.some((r) => r.public && r.count >= 10) ? 'warn' : failures.length === 0 ? 'pass' : 'info';
  return {
    state,
    windowHours: FAILURE_WINDOW_H,
    events: recent.length,
    failures: failures.length,
    successes: successes.length,
    invalidUsers: recent.filter((e) => e.kind === 'invalid').length,
    uniqueIps: byIp.length,
    publicIps: byIp.filter((r) => r.public).length,
    topFailureIps: failureIps.slice(0, 8),
    successIps: successIps.slice(0, 8),
    denials: denials.map((d) => ({ ip: d.ip, until: d.until, reason: d.reason || '' })),
    webIps,
    webTop,
    baseline: baseline ? { events: baseline.totalEvents || 0, ips: Object.keys(baseline.ips || {}).length, lastRunAt: baseline.lastRunAt || null } : null,
    pendingAnomalies,
    newAnomalies: (anomalies || []).slice(0, 8),
    source: sshCheck.log ? (sshCheck.log.source || (/auth\.log/.test(String(sshCheck.log.detail)) ? 'auth.log' : 'journal')) : 'none',
    loggedTo: loginAudit.EVENTS_FILE,
  };
}

// ── orchestration ────────────────────────────────────────────────────────
function worst(states) {
  if (states.includes('fail')) return 'fail';
  if (states.includes('warn')) return 'warn';
  if (states.includes('info')) return 'info';
  return 'pass';
}

// Stripe CLI bridge: present, authenticated, and answering. Read-only, and it
// reports the mode (test/live) so an agent never confuses the two.
async function checkStripe() {
  const base = { id: 'stripe', label: 'Stripe CLI' };
  try {
    const cli = require('./stripeCli');
    const st = await cli.status();
    if (!st.installed) return { ...base, state: 'warn', detail: 'stripe CLI not found on this box' };
    if (!st.authenticated) return { ...base, state: 'warn', detail: 'CLI present but not authenticated: ' + (st.error || 'no key') };
    return {
      ...base,
      state: 'pass',
      detail: `${st.version || 'stripe'} · ${st.mode} mode · probe ${st.latencyMs || 0}ms · read-only allowlist`,
    };
  } catch (e) {
    return { ...base, state: 'warn', detail: 'stripe check failed: ' + (e.message || 'unknown error') };
  }
}

async function doRun(trigger) {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  // Collect the Dell auth log once, then persist through loginAudit.updateBaseline:
  // that appends every fresh event (timestamp, kind, user, IP) to the append-only
  // login-events.jsonl, updates the learned baseline, and returns new anomalies.
  // Deduped by line hash, so startup + panel opens can never double-log.
  const log = await collectDellLogins();
  let newAnomalies = [];
  if (log.ok) {
    try { newAnomalies = loginAudit.updateBaseline(log.events) || []; }
    catch (e) { console.warn('[autoagent] login persistence failed:', e.message); }
  }

  const [ports, firewall, updates, accounts, code, stripe] = await Promise.all([
    checkPorts(), checkFirewall(), checkUpdates(), checkAccounts(), checkCodeAudit(), checkStripe(),
  ]);
  const ssh = sshFromLog(log);
  const ip = auditIps(ssh, newAnomalies);

  const checks = [ports, ssh, firewall, updates, accounts, code, stripe]
    .map((c) => ({ id: c.id, label: c.label, state: c.state, detail: c.detail, count: c.count }));
  const overall = worst([...checks.map((c) => c.state), ip.state]);

  const history = readHistory();
  const previous = history[0] ? history[0].checks || [] : [];
  const changed = checks
    .filter((c) => {
      const prev = previous.find((p) => p.id === c.id);
      return prev && prev.state !== c.state;
    })
    .map((c) => c.id);

  const result = {
    trigger,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - t0,
    host: { hostname: require('os').hostname() },
    state: overall,
    checks,
    ip,
    codeFindings: code.findings || [],
    changed,
    readOnly: true,
  };
  history.unshift({ trigger: result.trigger, startedAt, finishedAt: result.finishedAt, durationMs: result.durationMs, state: overall, checks: result.checks, webIps: ip.webIps, sshFailures: ip.failures });
  writeHistory(history);
  lastResult = result;
  return result;
}

async function runAutoAgent({ trigger = 'manual', force = false } = {}) {
  if (currentRun) return { ...(await currentRun), reused: true };
  if (!force && lastResult) {
    const age = Date.now() - Date.parse(lastResult.finishedAt);
    if (Number.isFinite(age) && age >= 0 && age < THROTTLE_MS) {
      return { ...lastResult, reused: true, nextRunInMs: THROTTLE_MS - age };
    }
  }
  currentRun = doRun(trigger).finally(() => { currentRun = null; });
  return currentRun;
}

function getState() {
  const history = readHistory();
  return {
    running: Boolean(currentRun),
    throttleMs: THROTTLE_MS,
    last: lastResult || history[0] || null,
    history: history.slice(0, 10),
  };
}

function startAutoAgent(delay = 8000) {
  const t = setTimeout(() => {
    runAutoAgent({ trigger: 'startup', force: true })
      .then((r) => console.log(`  ✓ Auto agent (security + IP audit) ran on startup: ${r.state} in ${r.durationMs}ms`))
      .catch((e) => console.warn('  ⚠ Auto agent startup run failed:', e.message));
  }, delay);
  if (typeof t.unref === 'function') t.unref();
  return t;
}

module.exports = { runAutoAgent, getState, startAutoAgent, HISTORY_FILE };
