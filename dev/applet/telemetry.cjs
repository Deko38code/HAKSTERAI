'use strict';
/**
 * HaksterAI live applet — telemetry collectors.
 *
 * Independent of PhantomIDE: nothing here is imported from the PhantomIDE box
 * and nothing here writes anywhere. Every value is measured on THIS host (the
 * Dell) at read time; anything that cannot be measured is reported as null and
 * rendered as unknown by the client. No number is ever estimated.
 *
 * Sources:
 *   process.*                 -> the running haksterAi Node process itself
 *   serverBuild.status()      -> boot stamp, pending server files, idle state
 *   dist/index.html meta      -> the page build actually being served
 *   pm2 jlist                 -> PM2 process table (name/status/cpu/mem only)
 *   data/update-seen.jsonl    -> real deployment / update events, when present
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const stability = require('../build-history/lib/stability.cjs');
const livejob = require('../build-history/lib/livejob.cjs');

const ROOT = path.join(__dirname, '..', '..');  // dev/applet -> dev -> repo root
const DIST_INDEX = path.join(ROOT, 'dist', 'index.html');
const SRC_DIR = path.join(ROOT, 'src');
const UPDATE_LOG = path.join(ROOT, 'data', 'update-seen.jsonl');

const PM2_TTL_MS = 10000;
const UPDATE_LOG_TTL_MS = 15000;

let pm2Cache = { at: 0, rows: null, error: null, inflight: null };
let buildCache = { at: 0, mtimeMs: 0, id: '', builtAt: null };
let logCache = { at: 0, rows: [] };
let srcNewestCache = { at: 0, mtimeMs: 0 };

/** The build id the page shell carries — the exact build this host serves. */
function pageBuild() {
  try {
    const st = fs.statSync(DIST_INDEX);
    if (buildCache.id && buildCache.mtimeMs === st.mtimeMs) return buildCache;
    const html = fs.readFileSync(DIST_INDEX, 'utf8');
    const m = html.match(/<meta\s+name=["']haksterai-build["']\s+content=["']([^"']+)/i);
    buildCache = { at: Date.now(), mtimeMs: st.mtimeMs, id: m ? m[1] : '', builtAt: new Date(st.mtimeMs).toISOString() };
    return buildCache;
  } catch (e) {
    return { at: Date.now(), mtimeMs: 0, id: '', builtAt: null, error: e.code || e.message };
  }
}

/** Newest mtime under src/ — used to say whether the page build is behind the source. */
function newestSourceMtime() {
  if (Date.now() - srcNewestCache.at < 5000) return srcNewestCache;
  let newest = 0;
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
        walk(full, depth + 1);
      } else if (ent.isFile()) {
        try { const st = fs.statSync(full); if (st.mtimeMs > newest) newest = st.mtimeMs; } catch (_) {}
      }
    }
  };
  walk(SRC_DIR, 0);
  srcNewestCache = { at: Date.now(), mtimeMs: newest };
  return srcNewestCache;
}

/**
 * PM2 table. `pm2 jlist` carries each process's env — which can hold secrets —
 * so only the five safe fields are copied out and the raw output is dropped.
 */
function readPm2() {
  if (Date.now() - pm2Cache.at < PM2_TTL_MS) return pm2Cache;
  if (pm2Cache.inflight) return pm2Cache;
  pm2Cache.inflight = new Promise((resolve) => {
    execFile('pm2', ['jlist', '--silent'], { timeout: 8000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      let rows = null;
      let error = null;
      if (err) error = 'pm2 unavailable';
      else {
        try {
          const list = JSON.parse(stdout);
          rows = list.map((p) => ({
            name: String(p.name || ''),
            status: String(p.pm2_env?.status || 'unknown'),
            pid: Number(p.pid) || 0,
            cpu: Number(p.monit?.cpu) || 0,
            memory: Number(p.monit?.memory) || 0,
            restarts: Number(p.pm2_env?.restart_time ?? p.pm2_env?.unstable_restarts) || 0,
            uptimeMs: Number(p.pm2_env?.pm_uptime) || 0,
            port: Number(p.pm2_env?.env?.PORT) || null,
          }));
        } catch (_) { error = 'pm2 output unreadable'; }
      }
      pm2Cache = { at: Date.now(), rows, error, inflight: null };
      resolve(pm2Cache);
    });
  });
  return pm2Cache;
}

/** Real deployment / update events the site has recorded. Never synthesised. */
function recentDeployments(limit = 6) {
  if (Date.now() - logCache.at < UPDATE_LOG_TTL_MS) return logCache.rows;
  const rows = [];
  try {
    const text = fs.readFileSync(UPDATE_LOG, 'utf8');
    const lines = text.trim().split('\n').filter(Boolean).slice(-40).reverse();
    for (const line of lines) {
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (e.site && e.site !== 'haksterai') continue;
      rows.push({
        at: e.at || null,
        build: e.build || null,
        from: e.from || null,
        action: e.action || null,
        actor: e.actor || 'anonymous',
      });
      if (rows.length >= limit) break;
    }
  } catch (_) { /* no log yet — reported as empty, never invented */ }
  logCache = { at: Date.now(), rows };
  return rows;
}

/**
 * The job state. A live recorder job wins, because it is the only source that
 * knows a build is actually running and how far it has got. With no live job
 * the serverBuild flags still describe queued/applying work honestly. Percent
 * stays null unless stages have really completed.
 */
function jobState(server) {
  let live = null;
  try { live = livejob.summary(); } catch (_) { live = null; }
  if (live && live.state !== 'IDLE') {
    return { ...live, source: 'recorder' };
  }
  if (server.applying) {
    return { state: 'RUNNING', label: 'Applying server build', percent: null, indeterminate: true };
  }
  if (server.pending > 0) {
    return {
      state: server.idle ? 'QUEUED' : 'BLOCKED',
      label: server.idle
        ? `${server.pending} server file${server.pending === 1 ? '' : 's'} queued · applies when idle`
        : `${server.pending} server file${server.pending === 1 ? '' : 's'} pending · live work in progress`,
      percent: null,
      indeterminate: true,
    };
  }
  return { state: 'IDLE', label: 'Idle · no build running', percent: null, indeterminate: false, source: 'idle' };
}

/** Scope projections of the job block: same numbers, less detail as you go out. */
function jobFor(scope, job) {
  const base = {
    state: job.state, label: job.label, percent: job.percent,
    indeterminate: job.indeterminate, buildId: job.buildId, startedAt: job.startedAt,
    elapsedSec: job.elapsedSec, etaSec: job.etaSec, etaBasis: job.etaBasis, etaNote: job.etaNote,
    stage: job.stage, stages: job.stages, status: job.status,
  };
  if (scope === 'owner') return { ...base, updates: job.updates, error: job.error, errorTail: job.errorTail, source: job.source };
  if (scope === 'user') return { ...base, updates: (job.updates || []).slice(-4) };
  return base;
}

function baseSnapshot(scope) {
  const mem = process.memoryUsage();
  const heapLimit = (() => {
    try {
      const v8 = require('v8');
      return v8.getHeapStatistics().heap_size_limit;
    } catch (_) { return 0; }
  })();
  let serverStatus = { build: null, stale: false, pending: 0, files: [], idle: true, applying: false };
  try {
    const sb = require('../serverBuild.cjs');
    const st = sb.status();
    serverStatus = {
      build: st.serverBuild,
      stale: st.stale,
      pending: st.pendingCount,
      files: (st.pendingFiles || []).slice(0, 8),
      idle: st.idle,
      applying: st.applying,
    };
  } catch (e) {
    serverStatus.error = e.message;
  }

  const pb = pageBuild();
  const src = newestSourceMtime();
  const memPct = heapLimit ? Math.round((mem.heapUsed / heapLimit) * 1000) / 10 : null;

  const snap = {
    type: 'snapshot',
    scope,
    site: 'haksterai',
    box: 'dell',
    ts: new Date().toISOString(),
    server: {
      status: serverStatus.applying ? 'applying' : 'online',
      pid: process.pid,
      node: process.version,
      startedAt: serverStatus.build,
      uptimeSec: Math.round(process.uptime()),
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      heapLimit,
      heapPct: memPct,
      load1: Math.round((os.loadavg()[0] || 0) * 100) / 100,
      cores: os.cpus().length,
    },
    build: {
      id: pb.id,
      builtAt: pb.builtAt,
      ageSec: pb.builtAt ? Math.max(0, Math.round((Date.now() - Date.parse(pb.builtAt)) / 1000)) : null,
      serverBuild: serverStatus.build,
      serverStale: Boolean(serverStatus.stale),
      pending: serverStatus.pending,
      pendingFiles: serverStatus.files,
      sourceNewer: Boolean(pb.mtimeMs && src.mtimeMs && src.mtimeMs > pb.mtimeMs + 1000),
      pageBuildBehindSource: Boolean(pb.mtimeMs && src.mtimeMs && src.mtimeMs > pb.mtimeMs + 1000),
    },
  };
  snap.job = jobState(serverStatus);
  return { snap, serverStatus };
}

/** Public view — what any visitor's applet may know. No pids, no paths, no process table. */
async function publicSnapshot() {
  const { snap } = baseSnapshot('public');
  const pubStability = await stabilitySummary('public');
  return {
    type: 'snapshot',
    scope: 'public',
    site: 'haksterai',
    box: 'dell',
    ts: snap.ts,
    server: { status: snap.server.status, uptimeSec: snap.server.uptimeSec, node: snap.server.node },
    build: { id: snap.build.id, builtAt: snap.build.builtAt, ageSec: snap.build.ageSec },
    job: jobFor('public', snap.job),
    stability: pubStability,
  };
}

/** Signed-in view: adds measured resource use, still no paths or process table. */
async function userSnapshot() {
  const { snap } = baseSnapshot('user');
  return {
    ...snap,
    scope: 'user',
    job: jobFor('user', snap.job),
    build: { ...snap.build, pendingFiles: undefined, serverStale: snap.build.serverStale },
    stability: await stabilitySummary('user'),
  };
}

/** Owner view: the full picture, including the PM2 table and deployment history. */
async function ownerSnapshot() {
  const { snap } = baseSnapshot('owner');
  const pm2 = readPm2();
  return {
    ...snap,
    scope: 'owner',
    job: jobFor('owner', snap.job),
    pm2: pm2.rows,
    pm2Error: pm2.error,
    deployments: recentDeployments(),
    stability: await stabilitySummary('owner'),
    npm: {
      packageVersion: readPackageVersion(),
      lastBuildAt: snap.build.builtAt,
      buildAgeSec: snap.build.ageSec,
      pageBuildBehindSource: snap.build.sourceNewer,
    },
  };
}

function readPackageVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    return pkg.version || null;
  } catch (_) { return null; }
}

/**
 * Stability is owned by the monitor, not by this collector. Each scope gets a
 * projection of the same evaluation: everyone sees the state and the countdown,
 * only an owner sees per-check detail text.
 */
async function stabilitySummary(scope) {
  // A snapshot read never waits for a fresh evaluation (see stability.cjs),
  // so the very first read after a start can come back empty. Report UNKNOWN
  // for that instant — never a borrowed or invented state.
  const s = (await stability.snapshot()) || {
    state: 'UNKNOWN',
    reason: 'monitor has not completed its first evaluation yet',
    window: { configuredSec: stability.config().observationWindowSec, approved: false, startedAt: null, elapsedSec: 0, remainingSec: null },
    timestamps: { lastCheckAt: null },
    evidence: { checks: 0, passing: 0, ratio: 0 },
    checks: [],
  };
  const base = {
    state: s.state,
    reason: s.reason,
    window: s.window,
    timestamps: {
      lastCheckAt: s.timestamps.lastCheckAt,
      lastDeployedAt: s.timestamps.lastDeployedAt,
      deployedBuildId: s.timestamps.deployedBuildId,
      buildFirstStableAt: s.timestamps.buildFirstStableAt,
      stableForSec: s.timestamps.stableForSec,
      deployedAgeSec: s.timestamps.deployedAgeSec,
    },
    evidence: s.evidence,
  };
  if (scope === 'public') {
    return {
      ...base,
      checks: (s.checks || []).map((c) => ({ id: c.id, status: c.status })),
    };
  }
  if (scope === 'user') {
    return {
      ...base,
      checks: (s.checks || []).map((c) => ({ id: c.id, label: c.label, status: c.status })),
    };
  }
  return s;
}

module.exports = { publicSnapshot, userSnapshot, ownerSnapshot, pageBuild, stabilitySummary };
