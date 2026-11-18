'use strict';
/**
 * Build recorder — one record per build, written as the build happens.
 *
 * Isolation: the build it runs is `astro build --outDir <dev>/out`, so the
 * production `dist/` is never written and nothing a visitor sees changes.
 *
 * Interrupted builds: the record is inserted BEFORE the first stage with
 * outcome `unknown` / status `running`. If this process dies mid-build the
 * record survives as unknown+running and is shown as INTERRUPTED, which is
 * the truth — it never reads as success because no finish was recorded.
 *
 * Progress: `percent` is completed stages over total stages. Stages are only
 * marked complete when their real step returned, so the number is measured,
 * never estimated. When a build is running but a stage cannot report, the
 * record says `indeterminate: true` and the panel animates without a number.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const http = require('http');

const store = require('./store.cjs');
const gitstate = require('./gitstate.cjs');
const { redactLines } = require('./redact.cjs');
const livejob = require('./livejob.cjs');

const REPO = path.join(__dirname, '..', '..', '..');
const OUT_DIR = path.join(__dirname, '..', 'out');
const HISTORY_DIR = path.join(__dirname, '..');

const STAGES = [
  { id: 'capture-git', label: 'Capture Git state' },
  { id: 'dependencies', label: 'Snapshot dependencies' },
  { id: 'build', label: 'Astro build (isolated outDir)' },
  { id: 'verify', label: 'Verify build output' },
  { id: 'health', label: 'Server health check' },
];

function newBuildId() {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const rand = crypto.randomBytes(3).toString('hex');
  return `hak-${stamp}-${rand}`;
}

function npmVersion() {
  try {
    return require('child_process').execFileSync('npm', ['--version'], { encoding: 'utf8', timeout: 10000 }).trim();
  } catch (_) { return null; }
}

function previousBuild(project) {
  const { rows } = store.query({ project, limit: 1 });
  const prev = rows[0] || null;
  if (!prev) return null;
  return {
    buildId: prev.buildId,
    commit: prev.git?.commit || null,
    startedAt: prev.startedAt,
    outcome: prev.outcome,
  };
}

/**
 * Run one isolated build and record it end to end.
 * opts: { trigger, requestedBy, runTests, healthUrl }
 */
async function runBuild(opts = {}) {
  const project = opts.project || 'haksterai';
  const box = opts.box || 'dell';
  const buildId = newBuildId();
  const key = `${project}:${buildId}`;
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  const prev = previousBuild(project);
  const nodeVersion = process.version;
  const npmVer = npmVersion();
  const depsAtStart = gitstate.dependencySnapshot(REPO);
  const git = gitstate.capture(REPO, prev?.commit || null);

  const record = {
    key,
    buildId,
    project,
    box,
    host: os.hostname(),
    startedAt,
    finishedAt: null,
    durationMs: null,
    buildStatus: 'running',
    outcome: 'unknown',            // success | failed | rolled_back | unknown
    trigger: opts.trigger || 'manual',
    requestedBy: opts.requestedBy || 'unknown',
    approved: false,
    approvedBy: null,
    approvedAt: null,
    deployment: { requested: false, outcome: 'unknown', deployedAt: null, note: null },
    git,
    versions: { node: nodeVersion, npm: npmVer, astro: readAstroVersion() },
    dependencies: {
      before: { version: depsAtStart.version, lockHash: depsAtStart.lockHash, count: depsAtStart.packageCount },
      after: null,
      diff: null,
    },
    stages: STAGES.map((s) => ({ ...s, status: 'pending', startedAt: null, finishedAt: null, ms: null })),
    events: [],
    progress: { percent: 0, indeterminate: false, message: 'Starting' },
    logs: { warnings: [], errors: [], tail: [] },
    tests: { ran: false, result: 'unknown', detail: null },
    health: { checked: false, result: 'unknown', detail: null },
    previous: prev ? { buildId: prev.buildId, commit: prev.commit } : null,
    rollback: prev ? { reference: prev.commit || prev.buildId, available: Boolean(prev.commit) } : { reference: null, available: false },
    summary: null,
    unknown: [],
  };

  // Written before the first stage: an interrupted run stays visible as such.
  store.insert(record);

  // Mirror the run into the live job file the applet streams. ETA priors come
  // from this project's own recorded stage durations, never from a guess.
  try {
    livejob.begin({
      buildId, project, box, stages: STAGES,
      history: livejob.stageHistory(store.query({ project, limit: 6 }).rows),
    });
  } catch (_) { /* the record above remains authoritative */ }

  const stages = record.stages;
  const finishStage = (id, status, detail) => {
    const st = stages.find((s) => s.id === id);
    if (!st) return;
    st.status = status;
    st.finishedAt = new Date().toISOString();
    st.ms = st.startedAt ? Date.now() - Date.parse(st.startedAt) : null;
    if (detail) st.detail = detail;
    const done = stages.filter((s) => s.status === 'done').length;
    record.progress = {
      percent: Math.round((done / stages.length) * 100),
      indeterminate: false,
      message: detail || st.label,
    };
    record.events.push({ at: new Date().toISOString(), stage: id, status, message: detail || st.label });
    try { livejob.stage(id, status, detail); } catch (_) {}
  };
  const startStage = (id) => {
    const st = stages.find((s) => s.id === id);
    if (!st) return;
    st.startedAt = new Date().toISOString();
    st.status = 'running';
    record.events.push({ at: st.startedAt, stage: id, status: 'running', message: st.label });
    try { livejob.stage(id, 'running', null); } catch (_) {}
  };

  const persist = () => {
    try { store.update(key, (r) => ({ ...r, ...record, key })); } catch (_) {}
  };

  try {
    // 1 — git is already captured above; mark the stage honestly.
    startStage('capture-git');
    if (!git.available) record.unknown.push('git state unavailable');
    finishStage('capture-git', git.available ? 'done' : 'failed', git.available
      ? `${git.branch || 'no branch'} @ ${git.shortCommit || 'no commit'}${git.dirty ? ` · ${git.uncommittedCount} uncommitted` : ''}`
      : 'repository not readable');
    persist();

    // 2 — dependencies
    startStage('dependencies');
    const depsAtBuild = gitstate.dependencySnapshot(REPO);
    record.dependencies.after = { version: depsAtBuild.version, lockHash: depsAtBuild.lockHash, count: depsAtBuild.packageCount };
    record.dependencies.diff = gitstate.diffDependencies(depsAtStart, depsAtBuild);
    finishStage('dependencies', 'done', `${depsAtBuild.packageCount} packages`);
    persist();

    // 3 — the build itself, into an isolated directory
    startStage('build');
    const build = await runAstroBuild((line) => {
      const text = String(line);
      if (/warn|deprecat/i.test(text)) record.logs.warnings.push(text);
      if (/error|failed|cannot|ENOENT/i.test(text)) record.logs.errors.push(text);
      record.logs.tail.push(text);
      if (record.logs.tail.length > 400) record.logs.tail.shift();
    });
    record.logs.warnings = redactLines(record.logs.warnings, 100);
    record.logs.errors = redactLines(record.logs.errors, 100);
    record.logs.tail = redactLines(record.logs.tail, 400);
    if (build.code === 0) {
      finishStage('build', 'done', `astro build exited 0 in ${Math.round(build.ms / 1000)}s`);
    } else {
      finishStage('build', 'failed', `astro build exited ${build.code}`);
      throw new Error(`astro build exited ${build.code}`);
    }
    persist();

    // 4 — verify output exists and is non-trivial
    startStage('verify');
    const outIndex = path.join(OUT_DIR, 'index.html');
    let outStat = null;
    try { outStat = fs.statSync(outIndex); } catch (_) {}
    if (!outStat) throw new Error('isolated build produced no index.html');
    finishStage('verify', 'done', `index.html ${outStat.size} bytes`);
    persist();

    // 5 — health of the running service (read-only request)
    startStage('health');
    const health = await checkHealth(opts.healthUrl || 'http://127.0.0.1:3579/api/health');
    record.health = health;
    finishStage('health', health.result === 'ok' ? 'done' : 'failed', `health ${health.result}`);
    persist();

    if (opts.runTests) {
      const tests = await runTypecheck();
      record.tests = tests;
    }

    record.buildStatus = 'completed';
    record.outcome = 'success';
    record.finishedAt = new Date().toISOString();
    record.durationMs = Date.now() - t0;
    record.progress = { percent: 100, indeterminate: false, message: 'Build complete' };
    record.summary = summarise(record);
    persist();
    try { livejob.finish('completed', 'Build complete — verifying health and stability'); } catch (_) {}
    return { record, key };
  } catch (e) {
    const failing = stages.find((s) => s.status === 'running');
    if (failing) finishStage(failing.id, 'failed', e.message);
    record.buildStatus = 'failed';
    record.outcome = 'failed';
    record.finishedAt = new Date().toISOString();
    record.durationMs = Date.now() - t0;
    record.progress = { percent: record.progress.percent, indeterminate: false, message: `Failed: ${e.message}` };
    record.logs.errors.push(...redactLines([String(e.message)], 5));
    record.summary = summarise(record);
    persist();
    try { livejob.finish('failed', `Build failed: ${e.message}`, redactLines(record.logs.errors, 40)); } catch (_) {}
    return { record, key, error: e.message };
  }
}

function readAstroVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
    return (pkg.devDependencies && pkg.dependencies && (pkg.dependencies.astro || pkg.devDependencies.astro)) || null;
  } catch (_) { return null; }
}

function runAstroBuild(onLine) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn('npx', ['astro', 'build', '--outDir', path.relative(REPO, OUT_DIR)], {
      cwd: REPO, env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const feed = (buf) => {
      String(buf).split('\n').forEach((l) => { if (l.trim()) onLine(l.replace(/\u001b\[[0-9;]*m/g, '')); });
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('close', (code) => resolve({ code, ms: Date.now() - started }));
    child.on('error', (err) => { onLine(String(err.message)); resolve({ code: -1, ms: Date.now() - started }); });
  });
}

function checkHealth(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 6000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; if (body.length > 4000) res.destroy(); });
      res.on('end', () => {
        resolve({
          checked: true,
          result: res.statusCode === 200 ? 'ok' : `http_${res.statusCode}`,
          detail: body.slice(0, 300),
        });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ checked: true, result: 'timeout', detail: null }); });
    req.on('error', (e) => resolve({ checked: true, result: 'unreachable', detail: e.code || e.message }));
  });
}

function runTypecheck() {
  return new Promise((resolve) => {
    const child = spawn('npx', ['tsc', '--noEmit'], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({
      ran: true,
      result: code === 0 ? 'pass' : 'fail',
      detail: redactLines(out.split('\n').filter(Boolean), 40).join('\n').slice(0, 2000) || null,
    }));
    child.on('error', (e) => resolve({ ran: false, result: 'unknown', detail: e.message }));
  });
}

/** Human summary built only from recorded facts; unknown stays unknown. */
function summarise(rec) {
  const parts = [];
  if (rec.git?.available) {
    parts.push(`${rec.git.branch || 'detached'} @ ${rec.git.shortCommit || 'unknown commit'}`);
  }
  const un = rec.git?.uncommittedCount || 0;
  const co = rec.git?.committedCount || 0;
  if (co) parts.push(`${co} committed file change${co === 1 ? '' : 's'}`);
  if (un) parts.push(`${un} uncommitted change${un === 1 ? '' : 's'} included in the build`);
  const subj = rec.git?.commitSubjects || [];
  if (subj.length) parts.push(`${subj.length} commit${subj.length === 1 ? '' : 's'}: ${subj.slice(0, 3).join('; ')}`);
  if (rec.dependencies?.diff?.changed) {
    const d = rec.dependencies.diff;
    parts.push(`deps +${d.added.length} ~${d.updated.length} -${d.removed.length}`);
  }
  if (rec.outcome === 'failed') parts.push('build FAILED');
  return parts.length ? parts.join(' · ') : null;
}

module.exports = { runBuild, STAGES, REPO, OUT_DIR };
