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
const LEARNING_FILE = path.join(DATA_DIR, 'stability-learning.jsonl');
const HEAL_FILE = path.join(DATA_DIR, 'stability-heal.jsonl');
let lastHealKey = '';

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

/**
 * Watchdog (owner, 2026-11-21: "add watchdog to it for debugging").
 * The monitor is only as good as its last measurement, and a stall used to read
 * as whatever old state the caller happened to hold. This beats on its own
 * timer, pre-warms the snapshot so the applet's first read is never empty,
 * records slow or failed beats to an append-only debug log, and lets every
 * snapshot say how old its evidence is.
 */
const WATCHDOG_MS = Math.max(5000, Number(process.env.HAKSTER_STABILITY_WATCHDOG_MS) || 60000);
const WATCHDOG_STALE_MS = Math.max(30000, Number(process.env.HAKSTER_STABILITY_STALE_MS) || 180000);
const WATCHDOG_LOG = path.join(DATA_DIR, 'stability-watchdog.jsonl');
const SLOW_BEAT_MS = 15000;
const watchdog = { startedAt: null, beats: 0, failures: 0, lastBeatAt: null, lastDurationMs: null, lastError: null, timer: null };

function watchdogLog(kind, extra = {}) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(WATCHDOG_LOG, JSON.stringify({ at: new Date().toISOString(), kind, ...extra }) + '\n', { mode: 0o600 });
  } catch (_) {}
}

function watchdogReport() {
  const ageMs = last.at ? Date.now() - last.at : null;
  return {
    running: Boolean(watchdog.timer),
    intervalMs: WATCHDOG_MS,
    startedAt: watchdog.startedAt,
    beats: watchdog.beats,
    failures: watchdog.failures,
    lastBeatAt: watchdog.lastBeatAt,
    lastDurationMs: watchdog.lastDurationMs,
    lastError: watchdog.lastError,
    evidenceAgeSec: ageMs == null ? null : Math.round(ageMs / 1000),
    stale: ageMs == null ? true : ageMs > WATCHDOG_STALE_MS,
  };
}

function startWatchdog() {
  if (watchdog.timer) return watchdogReport();
  watchdog.startedAt = new Date().toISOString();
  watchdog.timer = setInterval(async () => {
    const t0 = Date.now();
    try {
      const s = await refresh();
      const durationMs = Date.now() - t0;
      watchdog.beats += 1;
      watchdog.lastBeatAt = new Date().toISOString();
      watchdog.lastDurationMs = durationMs;
      const err = s && s.reason && /monitor error/.test(s.reason) ? s.reason : null;
      if (err) { watchdog.failures += 1; watchdog.lastError = err; watchdogLog('beat-failed', { error: err, durationMs }); }
      else if (durationMs > SLOW_BEAT_MS) watchdogLog('beat-slow', { durationMs, state: s && s.state });
    } catch (e) {
      watchdog.failures += 1;
      watchdog.lastError = e.code || e.message;
      watchdogLog('beat-threw', { error: watchdog.lastError, durationMs: Date.now() - t0 });
    }
  }, WATCHDOG_MS);
  if (watchdog.timer.unref) watchdog.timer.unref();
  watchdogLog('started', { intervalMs: WATCHDOG_MS, staleMs: WATCHDOG_STALE_MS });
  return watchdogReport();
}

function stopWatchdog() {
  if (watchdog.timer) { clearInterval(watchdog.timer); watchdog.timer = null; }
}

// Load is only reported unhealthy when it stays above the limit across several
// consecutive samples — memory and disk still fail immediately.
const LOAD_LIMIT = 6;       // load per core — genuine saturation on a shared desktop
const LOAD_SAMPLES = 4;     // consecutive samples (~20 s at the 5 s cadence)
const loadHistory = [];
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
    // Every probe must settle exactly once. The old body cap called
    // res.destroy() and then waited for 'end', which never fires on a
    // destroyed stream — any page larger than 100 KB hung the whole
    // evaluation, so the applet sat on zeros (owner 2026-11-21: "its been
    // on zero"). Now truncation resolves immediately, the response socket is
    // closed, and a hard deadline settles the promise no matter what the
    // server or the socket does.
    let settled = false;
    let res = null;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      try { if (res) res.destroy(); } catch (_) { /* already closed */ }
      try { req.destroy(); } catch (_) { /* already closed */ }
      resolve(value);
    };
    const req = lib.get(url, { timeout, headers: headers || {} }, (response) => {
      res = response;
      let body = '';
      const finish = (truncated) => done({
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode,
        ms: Date.now() - started,
        body,
        truncated: !!truncated,
        location: res.headers.location || null,
      });
      res.on('data', (c) => {
        if (settled) return;
        body += c;
        if (body.length > 100000) finish(true);
      });
      res.on('end', () => finish(false));
      res.on('close', () => finish(false));
      res.on('error', (e) => done({ ok: false, status: res.statusCode || 0, ms: Date.now() - started, error: e.code || e.message }));
    });
    const deadline = setTimeout(() => done({ ok: false, status: 0, ms: Date.now() - started, error: 'deadline' }), Number(timeout) > 0 ? Number(timeout) + 2000 : 10000);
    req.on('timeout', () => done({ ok: false, status: 0, ms: Date.now() - started, error: 'timeout' }));
    req.on('error', (e) => done({ ok: false, status: 0, ms: Date.now() - started, error: e.code || e.message }));
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

/**
 * Transient-failure retry. One dropped probe on a busy box or a Cloudflare blip
 * is not evidence that the service is broken, and the applet must not flash
 * DEGRADED for it. Every network check gets one immediate retry before it is
 * marked fail (owner, 2026-11-21: "always or fails til gets build right",
 * "for smoothest updates etc always").
 */
async function httpGetRetry(url, timeout = 6000, maxHops = 3, headers = null) {
  const first = await httpGet(url, timeout, maxHops, headers);
  if (first.ok) return first;
  await new Promise((z) => setTimeout(z, 500));
  const second = await httpGet(url, timeout, maxHops, headers);
  return second.ok
    ? { ...second, retried: true }
    : { ...second, retried: true, firstStatus: first.status, firstError: first.error };
}

const retryNote = (r) => (r && r.retried && !r.ok)
  ? ` · retried, first attempt ${r.firstError || `http ${r.firstStatus}`}`
  : '';

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
  let serverUptimeSec = null;
  if (!hakster) {
    add('process-uptime', 'Node process uptime', 'unknown', 'hakster not visible in PM2');
  } else {
    const uptimeSec = Math.round((now - hakster.uptimeMs) / 1000);
    serverUptimeSec = uptimeSec;
    const restarted = previous.restartTime != null && hakster.restarts > previous.restartTime;
    add('process-uptime', 'Node process uptime', restarted ? 'fail' : 'pass',
      `up ${uptimeSec}s · restarts ${hakster.restarts}${restarted ? ' · INCREASED since last sample' : ''}`);
    previous.restartTime = hakster.restarts;
  }

  // 2 — PM2 state. No PM2 data is a measurement gap, not a failing service:
  // marking it 'fail' let a PM2 visibility hiccup drive a FAILED verdict (codex
  // review, 2026-11-21). The service's own health checks still decide.
  add('pm2-state', 'PM2 process state',
    !hakster ? 'unknown' : (hakster.status === 'online' ? 'pass' : 'fail'),
    hakster ? `${hakster.name} ${hakster.status} · ${Math.round(hakster.cpu)}% cpu` : 'no PM2 data');

  // 3 — database connectivity and a real query
  const db = dbCheck();
  add('database', 'Database connectivity', db.status, db.detail);

  // 4 — application health endpoint
  const health = await httpGetRetry('http://127.0.0.1:3579/api/health');
  add('health-endpoint', 'Health endpoint', health.ok ? 'pass' : 'fail', `http ${health.status} · ${health.ms}ms${retryNote(health)}`,
    { latencyMs: health.ms, retried: Boolean(health.retried), healed: Boolean(health.retried && health.ok) });

  // 5 — public availability and latency
  const site = await httpGetRetry('https://haksterai.com/');
  add('public-site', 'Public site availability', site.ok ? 'pass' : 'fail',
    `http ${site.status} · ${site.ms}ms${site.hops && site.hops.length ? ' · ' + site.hops.join(' · ') : ''}${retryNote(site)}`,
    { latencyMs: site.ms, retried: Boolean(site.retried), healed: Boolean(site.retried && site.ok) });

  // 6 — API + stream surface
  const api = await httpGetRetry('http://127.0.0.1:3579/api/version');
  let apiOk = false;
  try { apiOk = api.ok && Boolean(JSON.parse(api.body).build); } catch (_) {}
  add('api', 'API responses', apiOk ? 'pass' : 'fail', `http ${api.status} · ${api.ms}ms${retryNote(api)}`,
    { latencyMs: api.ms, retried: Boolean(api.retried), healed: Boolean(api.retried && apiOk) });

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
  // This box is also the owner's desktop, so routine browsing and a Claude/IDE
  // session already put ~1.5–2 load per core on it without the service being in
  // trouble. Service latency is measured directly by the endpoint checks above;
  // this check watches for genuine host pressure (memory nearly gone, disk
  // nearly full, or load four-times oversubscribed). Load must stay high across
  // consecutive samples before it counts — a single spike from the app's own
  // boot-time secret scan or a build must not flip the applet to DEGRADED
  // (owner, 2026-11-21: "its failing resources — fix asap", "need stable
  // stability"). Numbers stay in the detail either way.
  loadHistory.push(load);
  while (loadHistory.length > LOAD_SAMPLES) loadHistory.shift();
  const sustainedLoad = loadHistory.length >= LOAD_SAMPLES && loadHistory.every((v) => v >= LOAD_LIMIT);
  const resourcesOk = free > 0.05 && !sustainedLoad && (!disk || disk.pct > 2);
  add('resources', 'CPU, memory and disk', resourcesOk ? 'pass' : 'fail',
    `mem available ${(free * 100).toFixed(1)}% · load ${load.toFixed(2)}/core${sustainedLoad ? ' sustained' : ''} · disk free ${disk ? disk.pct + '%' : 'unknown'}`);

  // 8 — error rate, measured as a delta since the previous sample
  const errs = errorRate();
  add('error-rate', 'Error log rate (since last sample)', errs.status, errs.detail);

  // 9 — deployed artifact identity
  const dep = deployedBuild();
  add('artifact', 'Deployed build identity', dep.id ? 'pass' : 'unknown', dep.id ? `build ${dep.id} · ${dep.builtAt}` : 'dist build id unreadable');

  // 10 — critical client workflows
  const plans = await httpGetRetry('https://haksterai.com/plans');
  add('workflow', 'Client workflow (/plans)', plans.ok ? 'pass' : 'fail',
    `http ${plans.status} · ${plans.ms}ms · landed ${plans.finalUrl || 'n/a'}` +
    (plans.hops && plans.hops.length ? ' · ' + plans.hops.join(' · ') : '') + retryNote(plans), { latencyMs: plans.ms });

  // ── state ────────────────────────────────────────────────────────────────
  const prev = readJson(STATE_FILE, {});
  const buildChanged = prev.deployedBuildId && dep.id && prev.deployedBuildId !== dep.id;
  const restartSeen = checks.find((c) => c.id === 'process-uptime')?.status === 'fail';

  const critical = ['database', 'public-site', 'pm2-state', 'health-endpoint'];
  const criticalFail = checks.some((c) => critical.includes(c.id) && c.status === 'fail');
  const anyFail = checks.some((c) => c.status === 'fail');
  const passCount = checks.filter((c) => c.status === 'pass').length;
  // UNKNOWN means "the monitor could not measure", never "several checks
  // failed". Counting only passes made a boot or a busy moment — where the
  // checks DID answer, just with fail — drop below 0.5 and flash UNKNOWN before
  // flipping back to DEGRADED (owner, 2026-11-21: "says stability unknown then
  // degraded again"). A pass or a fail is both evidence; only 'unknown' means
  // no measurement was produced.
  const measuredCount = checks.filter((c) => c.status === 'pass' || c.status === 'fail').length;
  const evidenceRatio = measuredCount / checks.length;
  const passRatio = passCount / checks.length;

  const windowSec = cfg.observationWindowSec;
  let windowStartedAt = prev.windowStartedAt || null;
  const mustReset = !windowStartedAt || buildChanged || restartSeen || anyFail ||
    (prev.deployedBuildId && dep.id && prev.deployedBuildId !== dep.id);

  if (mustReset) windowStartedAt = new Date(now).toISOString();
  const elapsedSec = Math.max(0, Math.round((now - Date.parse(windowStartedAt)) / 1000));
  const remainingSec = Math.max(0, windowSec - elapsedSec);

  const booting = serverUptimeSec != null && serverUptimeSec < 25;
  // A restart we can see in PM2 explains the failing probes underneath it: the
  // process is not up yet, so health/api/public checks answer 404/502. That is a
  // deploy window, not a silent outage — report VERIFYING, never FAILED, and let
  // the next samples decide once the process answers again.
  // Only a PM2 row that EXISTS and is not online is a restart. With no PM2 data
  // at all we cannot claim one — treating "pm2 unavailable" as "restarting"
  // would mask a real failure as a deploy window. The checks themselves then
  // decide (a dead process still fails health/public/api), and the pm2-state
  // check's own detail says the data was unavailable.
  const pm2Stopped = Boolean(hakster) && hakster.status !== 'online';
  const restarting = pm2Stopped || restartSeen;
  let state;
  const reasons = [];
  // Name the failing checks in the reason itself — the applet prints this line
  // verbatim, and "one or more checks failing" told the owner nothing (2026-11-21:
  // "stability degrading one or more feat failing ... on applet").
  const failing = checks.filter((c) => c.status === 'fail');
  const nameFails = (list) => list.map((c) => (c.detail ? `${c.id} (${c.detail})` : c.id)).join(' · ');
  // Self-heal summary: which checks a bounded retry rescued, and which stayed
  // failing after the retry (escalated for a human, never force-restarted).
  const healed = checks.filter((c) => c.healed).map((c) => c.id);
  const escalated = failing.map((c) => c.id);
  const healKey = healed.join(',') + '|' + escalated.join(',');
  if (healKey !== lastHealKey) {
    lastHealKey = healKey;
    if (healed.length) healLog('retry-saved', { checks: healed });
    if (escalated.length) healLog('escalated', { checks: escalated, reason: reasons.join(' · ') });
  }
  if (evidenceRatio < 0.5) { state = 'UNKNOWN'; reasons.push('fewer than half of the checks could be measured'); }
  else if (booting) { state = 'VERIFYING'; reasons.push(`server restarted ${serverUptimeSec}s ago — checks resume`); }
  else if (restarting) { state = 'VERIFYING'; reasons.push('service restarting — checks resume when it answers'); }
  else if (criticalFail) { state = 'FAILED'; reasons.push('critical check failed: ' + nameFails(failing.filter((c) => critical.includes(c.id)))); }
  else if (anyFail) { state = 'DEGRADED'; reasons.push('failing: ' + nameFails(failing)); }
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
    evidence: { checks: checks.length, passing: passCount, measured: measuredCount, ratio: Math.round(passRatio * 100) / 100, evidenceRatio: Math.round(evidenceRatio * 100) / 100 },
    heal: {
      policy: 'retry + record only — no restart, no delete, no config edit',
      attemptsPerCheck: 2,
      healed,
      escalated,
    },
    watchdog: watchdogReport(),
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

  recordLearning(snapshot, prev.lastState);
  audit(snapshot, prev.lastState);
  return snapshot;
}

/** Append-only audit log: every state change, plus a heartbeat every 60 s. */
/**
 * Learning patterns. Every transition into DEGRADED/FAILED appends the set of
 * failing check ids as a reusable pattern, and every recovery appends how long
 * the pattern held. Append-only: a pattern's recurrence count is derived by
 * counting earlier lines, never stored by rewriting the file
 * (owner, 2026-11-21: "add learning pattern").
 */
/**
 * Self-heal ledger (owner, 2026-11-21: "add auto fix heal"). Append-only record
 * of what the monitor tried and what happened. The heal layer is deliberately
 * bounded by CLAUDE.md §11: it retries measurements and records evidence, and
 * NEVER restarts a service, kills a process, edits config or deletes anything —
 * those stay approval-gated. Every entry names the check and the outcome.
 */
function healLog(event, extra = {}) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(HEAL_FILE, JSON.stringify({
      at: new Date().toISOString(),
      kind: 'self-heal',
      event,
      policy: 'retry + record only — no restart, no delete, no config edit',
      ...extra,
    }) + '\n', { mode: 0o600 });
  } catch (_) {}
}

function recordLearning(snapshot, previousState) {
  const failing = snapshot.checks.filter((c) => c.status === 'fail');
  const failingFrom = (s) => s === 'DEGRADED' || s === 'FAILED';
  const intoFail = failingFrom(snapshot.state) && previousState !== snapshot.state;
  const recovered = failingFrom(previousState) && !failingFrom(snapshot.state);
  if (!intoFail && !recovered) return;
  const patternKey = failing.map((c) => c.id).sort().join(',') || 'none';
  let seen = 0;
  try {
    for (const line of fs.readFileSync(LEARNING_FILE, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { if (JSON.parse(line).patternKey === patternKey) seen++; } catch (_) {}
    }
  } catch (_) { /* first record */ }
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(LEARNING_FILE, JSON.stringify({
      at: new Date().toISOString(),
      kind: intoFail ? 'failure-pattern' : 'recovery',
      patternKey,
      seen: seen + 1,
      state: snapshot.state,
      previousState: previousState || null,
      failing: failing.map((c) => ({ id: c.id, detail: c.detail })),
      reason: snapshot.reason,
      stableForSec: (snapshot.timestamps && snapshot.timestamps.stableForSec) || 0,
    }) + '\n', { mode: 0o600 });
  } catch (_) {}
}

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
  const age = last.at ? Date.now() - last.at : Infinity;
  if (!last.snapshot || age >= 5000) refresh();
  const snap = last.snapshot || null;
  if (!snap) return null;
  // A stale snapshot must never read as a current one: if the watchdog has not
  // produced a measurement within the stale window, say so instead of showing
  // yesterday's green.
  const ageNow = last.at ? Date.now() - last.at : Infinity;
  if (ageNow > WATCHDOG_STALE_MS) {
    return {
      ...snap,
      state: 'UNKNOWN',
      reason: `watchdog: last successful check ${Math.round(ageNow / 1000)}s ago` + (watchdog.lastError ? ` · ${watchdog.lastError}` : ''),
      watchdog: watchdogReport(),
    };
  }
  return snap;
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

module.exports = { snapshot, config, POLICY, AUDIT_FILE, LEARNING_FILE, STATE_FILE, CONFIG_FILE, WATCHDOG_LOG, startWatchdog, stopWatchdog, watchdogReport };
