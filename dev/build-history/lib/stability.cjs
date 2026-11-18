'use strict';
/**
 * Build stability monitor — evidence-based states only.
 *
 * The monitor watches the DEPLOYED build (the one `dist/index.html` identifies)
 * plus the running service, and never derives a state from one signal. A green
 * npm build, an HTTP 200 or a PM2 "online" is one check, not a verdict.
 *
 * States and the rules used here:
 *   BUILDING   a build is running right now (real job state, not a guess)
 *   BUILT      build finished successfully, nothing deployed yet
 *   TESTING    automated verification running
 *   READY      required pre-deployment checks pass, deployment not started
 *   DEPLOYING  an authorised deployment is running
 *   VERIFYING  deployed; health checks running, observation window not complete
 *   STABLE     every required check passed for the whole approved window
 *   DEGRADED   app up, at least one required check failing
 *   FAILED     a required build/test/deploy check failed, or the service is down
 *   ROLLED_BACK a rollback was recorded and the restored build verified
 *   UNKNOWN    not enough fresh evidence to say anything
 *
 * Stability window: proposed 5–15 minutes, 10 minutes by default. It is NOT
 * approved, and while `windowApproved` is false the monitor never reports
 * STABLE — it stays VERIFYING and says the window is awaiting owner approval.
 *
 * Reset policy (documented in POLICY below and in the panel): the window
 * restarts at zero when the deployed build id changes, when the service
 * restarts, or when any required check fails. A single failing sample is
 * enough to leave STABLE; returning to STABLE requires a fresh full window.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const { execFile } = require('child_process');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'stability-config.json');
const STATE_FILE = path.join(DATA_DIR, 'stability-state.json');
const AUDIT_FILE = path.join(DATA_DIR, 'stability-audit.jsonl');

const REPO = path.join(__dirname, '..', '..', '..');
const DIST_INDEX = path.join(REPO, 'dist', 'index.html');
const DB_PATH = path.join(REPO, 'data', 'hakster.db');
const ERROR_LOG = path.join(process.env.HOME || '/home/ghost', '.pm2', 'logs', 'hakster-error.log');
const DEV_TOKEN_FILE = path.join(DATA_DIR, 'dev-owner.json');

const POLICY = {
  observationWindowSec: 600,
  proposedRangeSec: [300, 900],
  windowApproved: false,
  onBuildChange: 'reset',
  onServiceRestart: 'reset',
  onCheckFailure: 'reset',
  maxCheckAgeSec: 120,
};

let last = { at: 0, snapshot: null, inflight: null };
let previous = { restartTime: null, buildId: null, at: 0 };

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}
function writeJson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (_) { /* persistence is best-effort; the audit log stays authoritative */ }
}

function config() {
  const cfg = readJson(CONFIG_FILE, null);
  if (cfg && Number.isFinite(cfg.observationWindowSec)) return { ...POLICY, ...cfg };
  const initial = { ...POLICY, createdAt: new Date().toISOString(), note: 'Window proposed, not approved by the owner.' };
  writeJson(CONFIG_FILE, initial);
  return initial;
}

// ── probes ────────────────────────────────────────────────────────────────
function httpOnce(url, timeout, headers) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https') ? https : http;
    const started = Date.now();
    const req = lib.get(url, { timeout, headers: headers || {} }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; if (body.length > 100000) res.destroy(); });
      res.on('end', () => resolve({
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode,
        ms: Date.now() - started,
        body,
        location: res.headers.location || null,
      }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, ms: Date.now() - started, error: 'timeout' }); });
    req.on('error', (e) => resolve({ ok: false, status: 0, ms: Date.now() - started, error: e.code || e.message }));
  });
}

/**
 * Follow up to 3 redirects and judge the FINAL response.
 *
 * A 301 is a pointer, not a working page: counting it as "available" would let
 * a redirect to a login wall or a 404 pass the check. The hop chain is reported
 * so the evidence shows where the request actually landed.
 */
async function httpGet(url, timeout = 6000, maxHops = 3, headers = null) {
  let current = url;
  const hops = [];
  for (let i = 0; i <= maxHops; i++) {
    const r = await httpOnce(current, timeout, headers);
    if (r.status >= 300 && r.status < 400 && r.location) {
      hops.push(`${r.status} → ${r.location}`);
      try { current = new URL(r.location, current).toString(); } catch (_) { return { ...r, ok: false, hops }; }
      continue;
    }
    return { ...r, hops, finalUrl: current };
  }
  return { ok: false, status: 0, ms: 0, error: 'too many redirects', hops };
}

function pm2Rows() {
  return new Promise((resolve) => {
    execFile('pm2', ['jlist', '--silent'], { timeout: 8000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        const list = JSON.parse(stdout);
        resolve(list.map((p) => ({
          name: String(p.name || ''),
          status: String(p.pm2_env?.status || 'unknown'),
          restarts: Number(p.pm2_env?.restart_time) || 0,
          uptimeMs: Number(p.pm2_env?.pm_uptime) || 0,
          cpu: Number(p.monit?.cpu) || 0,
          memory: Number(p.monit?.memory) || 0,
        })));
      } catch (_) { resolve(null); }
    });
  });
}

function diskFree() {
  return new Promise((resolve) => {
    execFile('df', ['-k', '/'], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null);
      const line = String(stdout).trim().split('\n')[1] || '';
      const parts = line.split(/\s+/);
      const total = Number(parts[1]) * 1024;
      const avail = Number(parts[3]) * 1024;
      if (!total) return resolve(null);
      resolve({ total, avail, pct: Math.round((avail / total) * 1000) / 10 });
    });
  });
}

function dbCheck() {
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(DB_PATH, { readOnly: true });
    const one = db.prepare('SELECT 1 AS ok').get();
    const users = db.prepare('SELECT COUNT(*) AS c FROM users').get();
    const tables = db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table'").get();
    db.close();
    return { status: one && one.ok === 1 ? 'pass' : 'fail', detail: `${tables.c} tables · ${users.c} accounts` };
  } catch (e) {
    return { status: 'fail', detail: e.code || e.message };
  }
}

/**
 * Error rate by append-delta.
 *
 * The pm2 error log carries no timestamps (195 MB of raw stderr), so "errors in
 * the last 5 minutes" cannot be read off it directly — counting a tail of it
 * would report months of history as if it were current. Instead the monitor
 * remembers the byte offset it last read to and counts only what was appended
 * since. First sample after a start has no rate at all: it reports UNKNOWN
 * rather than inventing one.
 */
function errorRate() {
  const prevOffset = readJson(STATE_FILE, {}).errorLogOffset || 0;
  let size;
  try { size = fs.statSync(ERROR_LOG).size; } catch (e) { return { status: 'unknown', detail: 'error log unreadable: ' + (e.code || e.message) }; }
  if (!prevOffset || size < prevOffset) {
    writeJson(STATE_FILE, { ...readJson(STATE_FILE, {}), errorLogOffset: size, errorLogAt: Date.now() });
    return { status: 'unknown', detail: 'baseline established — rate available from the next sample' };
  }
  const span = Math.min(size - prevOffset, 2 * 1024 * 1024);
  let text = '';
  try {
    const fd = fs.openSync(ERROR_LOG, 'r');
    const buf = Buffer.alloc(span);
    fs.readSync(fd, buf, 0, span, size - span);
    fs.closeSync(fd);
    text = buf.toString('utf8');
  } catch (e) {
    return { status: 'unknown', detail: 'error log read failed: ' + (e.code || e.message) };
  }
  const lines = text.split('\n').filter(Boolean);
  const errors = lines.filter((l) => /error|exception|unhandled|ECONN|fatal/i.test(l)).length;
  writeJson(STATE_FILE, { ...readJson(STATE_FILE, {}), errorLogOffset: size, errorLogAt: Date.now() });
  return {
    status: errors === 0 ? 'pass' : errors > 50 ? 'fail' : 'unknown',
    detail: `${errors} error line(s) in ${(span / 1048576).toFixed(1)} MB appended since the last sample` +
      (errors > 0 && errors <= 50 ? ' — below the failure threshold, flagged for review' : ''),
    count: errors,
  };
}

function deployedBuild() {
  try {
    const st = fs.statSync(DIST_INDEX);
    const html = fs.readFileSync(DIST_INDEX, 'utf8');
    const m = html.match(/<meta\s+name=["']haksterai-build["']\s+content=["']([^"']+)/i);
    return { id: m ? m[1] : null, builtAt: new Date(st.mtimeMs).toISOString(), mtimeMs: st.mtimeMs };
  } catch (e) {
    return { id: null, error: e.code || e.message };
  }
}

// ── evaluation ─────────────────────────────────────────────────────────────
async function evaluate() {
  const cfg = config();
  const now = Date.now();
  const checks = [];
  const add = (id, label, status, detail, extra = {}) =>
    checks.push({ id, label, status, detail: detail ?? null, at: new Date(now).toISOString(), ...extra });

  const [pm2, disk] = await Promise.all([pm2Rows(), diskFree()]);
  const hakster = pm2 ? pm2.find((p) => p.name === 'hakster') : null;

  // 1 — Node process uptime and unexpected restarts
  if (!hakster) {
    add('process-uptime', 'Node process uptime', 'unknown', 'hakster not visible in PM2');
  } else {
    const uptimeSec = Math.round((now - hakster.uptimeMs) / 1000);
    const restarted = previous.restartTime != null && hakster.restarts > previous.restartTime;
    add('process-uptime', 'Node process uptime', restarted ? 'fail' : 'pass',
      `up ${uptimeSec}s · restarts ${hakster.restarts}${restarted ? ' · INCREASED since last sample' : ''}`);
    previous.restartTime = hakster.restarts;
  }

  // 2 — PM2 state
  add('pm2-state', 'PM2 process state', hakster && hakster.status === 'online' ? 'pass' : 'fail',
    hakster ? `${hakster.name} ${hakster.status} · ${Math.round(hakster.cpu)}% cpu` : 'no PM2 data');

  // 3 — database connectivity and a real query
  const db = dbCheck();
  add('database', 'Database connectivity', db.status, db.detail);

  // 4 — application health endpoint
  const health = await httpGet('http://127.0.0.1:3579/api/health');
  add('health-endpoint', 'Health endpoint', health.ok ? 'pass' : 'fail', `http ${health.status} · ${health.ms}ms`, { latencyMs: health.ms });

  // 5 — public availability and latency
  const site = await httpGet('https://haksterai.com/');
  add('public-site', 'Public site availability', site.ok ? 'pass' : 'fail',
    `http ${site.status} · ${site.ms}ms${site.hops && site.hops.length ? ' · ' + site.hops.join(' · ') : ''}`, { latencyMs: site.ms });

  // 6 — API + stream surface
  const api = await httpGet('http://127.0.0.1:3579/api/version');
  let apiOk = false;
  try { apiOk = api.ok && Boolean(JSON.parse(api.body).build); } catch (_) {}
  add('api', 'API responses', apiOk ? 'pass' : 'fail', `http ${api.status} · ${api.ms}ms`, { latencyMs: api.ms });

  // The applet feed is probed on the port this project actually serves on —
  // production (PORT, default 3579) or the isolated preview (3999). Public
  // scope answers 200 with a server and job block, so no credential is needed
  // for the probe; a dev token is still sent when one exists.
  const feedToken = readJson(DEV_TOKEN_FILE, {}).token || null;
  const candidatePorts = [...new Set([Number(process.env.HAKSTER_APP_PORT), Number(process.env.PORT), 3579, 3999]
    .filter((p) => Number.isFinite(p) && p > 0))];
  const probeFeed = async (port) => {
    const headers = feedToken ? { 'x-api-key': feedToken } : null;
    const sse = await httpGet('http://127.0.0.1:' + port + '/api/applet/status', 8000, 0, headers);
    let snap = null;
    try { snap = JSON.parse(sse.body); } catch (_) {}
    return { port, sse, snap, ok: Boolean(sse.ok && snap && snap.server && snap.job) };
  };
  // The primary port is the one this project actually serves on. A localhost
  // probe can stall for a few seconds while the box is under heavy disk
  // pressure, and one stalled sample is not evidence that the feed is down —
  // so the primary gets one retry. A fallback port is only consulted to show
  // context; it can never turn the primary's failure into a pass, because a
  // feed that is healthy on a dev port says nothing about the production one.
  const primary = candidatePorts[0];
  let feed = await probeFeed(primary);
  if (!feed.ok) {
    await new Promise((z) => setTimeout(z, 400));
    feed = await probeFeed(primary);
  }
  let fallback = null;
  if (!feed.ok) {
    for (const port of candidatePorts.slice(1)) {
      const r = await probeFeed(port);
      if (r.ok) { fallback = r; break; }
    }
  }
  add('stream-endpoint', 'Applet stream endpoint', feed.ok ? 'pass' : 'fail',
    feed.ok
      ? `port ${feed.port} · http ${feed.sse.status} · ${feed.sse.ms}ms · scope ${feed.snap.scope || 'unknown'} · state ${feed.snap.job.state}`
      : `port ${feed.port} · http ${feed.sse.status}${feed.sse.error ? ' · ' + feed.sse.error : ''} · ${feed.sse.ms}ms · snapshot ${feed.snap ? 'incomplete' : 'unreadable'}` +
        (fallback ? ` · a fallback on port ${fallback.port} answered, but the serving port is ${feed.port}` : ''));

  // 7 — resources. os.freemem() on Linux excludes page cache and reads near 0%
  // on a healthy busy box, so it is not a memory-pressure signal; MemAvailable
  // from /proc/meminfo is the figure that actually means "usable memory".
  let memFreeRatio = os.freemem() / os.totalmem();
  try {
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
    const total = Number((meminfo.match(/^MemTotal:\s+(\d+)\s+kB/m) || [])[1]);
    const available = Number((meminfo.match(/^MemAvailable:\s+(\d+)\s+kB/m) || [])[1]);
    if (total && Number.isFinite(available) && available > 0) memFreeRatio = available / total;
  } catch (_) { /* keep the os.freemem fallback */ }
  const free = memFreeRatio;
  const load = os.loadavg()[0] / Math.max(1, os.cpus().length);
  const resourcesOk = free > 0.05 && load < 1.5 && (!disk || disk.pct > 2);
  add('resources', 'CPU, memory and disk', resourcesOk ? 'pass' : 'fail',
    `mem available ${(free * 100).toFixed(1)}% · load ${load.toFixed(2)}/core · disk free ${disk ? disk.pct + '%' : 'unknown'}`);

  // 8 — error rate, measured as a delta since the previous sample
  const errs = errorRate();
  add('error-rate', 'Error log rate (since last sample)', errs.status, errs.detail);

  // 9 — deployed artifact identity
  const dep = deployedBuild();
  add('artifact', 'Deployed build identity', dep.id ? 'pass' : 'unknown', dep.id ? `build ${dep.id} · ${dep.builtAt}` : 'dist build id unreadable');

  // 10 — critical client workflows
  const plans = await httpGet('https://haksterai.com/plans');
  add('workflow', 'Client workflow (/plans)', plans.ok ? 'pass' : 'fail',
    `http ${plans.status} · ${plans.ms}ms · landed ${plans.finalUrl || 'n/a'}` +
    (plans.hops && plans.hops.length ? ' · ' + plans.hops.join(' · ') : ''), { latencyMs: plans.ms });

  // ── state ────────────────────────────────────────────────────────────────
  const prev = readJson(STATE_FILE, {});
  const buildChanged = prev.deployedBuildId && dep.id && prev.deployedBuildId !== dep.id;
  const restartSeen = checks.find((c) => c.id === 'process-uptime')?.status === 'fail';

  const critical = ['database', 'public-site', 'pm2-state', 'health-endpoint'];
  const criticalFail = checks.some((c) => critical.includes(c.id) && c.status === 'fail');
  const anyFail = checks.some((c) => c.status === 'fail');
  const passCount = checks.filter((c) => c.status === 'pass').length;
  const evidenceRatio = passCount / checks.length;

  const windowSec = cfg.observationWindowSec;
  let windowStartedAt = prev.windowStartedAt || null;
  const mustReset = !windowStartedAt || buildChanged || restartSeen || anyFail ||
    (prev.deployedBuildId && dep.id && prev.deployedBuildId !== dep.id);

  if (mustReset) windowStartedAt = new Date(now).toISOString();
  const elapsedSec = Math.max(0, Math.round((now - Date.parse(windowStartedAt)) / 1000));
  const remainingSec = Math.max(0, windowSec - elapsedSec);

  let state;
  const reasons = [];
  if (evidenceRatio < 0.5) { state = 'UNKNOWN'; reasons.push('less than half of the checks produced evidence'); }
  else if (criticalFail) { state = 'FAILED'; reasons.push('a critical check failed'); }
  else if (anyFail) { state = 'DEGRADED'; reasons.push('one or more required checks failing'); }
  else if (remainingSec > 0) { state = 'VERIFYING'; reasons.push(`observation window ${elapsedSec}s of ${windowSec}s`); }
  else if (!cfg.windowApproved) { state = 'VERIFYING'; reasons.push('checks pass for the full proposed window, but the window itself is not owner-approved'); }
  else { state = 'STABLE'; reasons.push(`no failing check for ${elapsedSec}s`); }

  if (buildChanged) reasons.push('deployed build changed — window reset');

  const snapshot = {
    state,
    reason: reasons.join(' · '),
    checks,
    window: {
      configuredSec: windowSec,
      proposedRangeSec: cfg.proposedRangeSec,
      approved: Boolean(cfg.windowApproved),
      startedAt: windowStartedAt,
      elapsedSec,
      remainingSec,
    },
    timestamps: {
      lastCheckAt: new Date(now).toISOString(),
      lastDeployedAt: dep.builtAt || null,
      deployedBuildId: dep.id || null,
      buildFirstStableAt: state === 'STABLE' ? (prev.buildFirstStableAt || new Date(now).toISOString()) : null,
      stableForSec: prev.buildFirstStableAt ? Math.round((now - Date.parse(prev.buildFirstStableAt)) / 1000) : 0,
      deployedAgeSec: dep.mtimeMs ? Math.round((now - dep.mtimeMs) / 1000) : null,
    },
    evidence: { checks: checks.length, passing: passCount, ratio: Math.round(evidenceRatio * 100) / 100 },
  };

  // Merge, never replace: errorRate() keeps its read offset in this same file,
  // and overwriting the object would reset the baseline on every cycle.
  writeJson(STATE_FILE, {
    ...readJson(STATE_FILE, {}),
    deployedBuildId: dep.id || prev.deployedBuildId || null,
    windowStartedAt,
    buildFirstStableAt: state === 'STABLE' ? (prev.buildFirstStableAt || new Date(now).toISOString()) : null,
    lastState: state,
    lastEvaluatedAt: new Date(now).toISOString(),
  });

  audit(snapshot, prev.lastState);
  return snapshot;
}

/** Append-only audit log: every state change, plus a heartbeat every 60 s. */
function audit(snapshot, previousState) {
  const changed = previousState && previousState !== snapshot.state;
  const aged = !previousState || Date.now() - (last.auditAt || 0) > 60000;
  if (!changed && !aged) return;
  last.auditAt = Date.now();
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const line = JSON.stringify({
      at: new Date().toISOString(),
      state: snapshot.state,
      previousState: previousState || null,
      reason: snapshot.reason,
      checks: snapshot.checks.map((c) => ({ id: c.id, status: c.status })),
      window: snapshot.window,
      deployedBuildId: snapshot.timestamps.deployedBuildId,
    });
    fs.appendFileSync(AUDIT_FILE, line + '\n', { mode: 0o600 });
  } catch (_) {}
}

/**
 * Cached read for the applet stream (5 s), so a page poll cannot hammer the
 * probes.
 *
 * force=false must NEVER make the caller wait on a fresh evaluation. The
 * stream-endpoint check probes /api/applet/status over HTTP, and that route
 * asks for this snapshot: if this call awaited the evaluation, the evaluation
 * would be waiting on a request that is waiting on the evaluation — a
 * deadlock that can only end in the probe's timeout. So a stale read answers
 * from the last completed snapshot and refreshes behind the request.
 */
async function snapshot(force = false) {
  if (force) return refresh();
  if (!last.snapshot || Date.now() - last.at >= 5000) refresh();
  return last.snapshot || null;
}

function refresh() {
  if (last.inflight) return last.inflight;
  last.inflight = evaluate().then((s) => {
    last = { at: Date.now(), snapshot: s, inflight: null };
    return s;
  }).catch((e) => {
    const s = {
      state: 'UNKNOWN', reason: 'monitor error: ' + (e.code || e.message), checks: [],
      window: { configuredSec: config().observationWindowSec, approved: false, startedAt: null, elapsedSec: 0, remainingSec: null },
      timestamps: { lastCheckAt: new Date().toISOString() },
      evidence: { checks: 0, passing: 0, ratio: 0 },
    };
    last = { at: Date.now(), snapshot: s, inflight: null };
    return s;
  });
  return last.inflight;
}

module.exports = { snapshot, config, POLICY, AUDIT_FILE, STATE_FILE, CONFIG_FILE };
