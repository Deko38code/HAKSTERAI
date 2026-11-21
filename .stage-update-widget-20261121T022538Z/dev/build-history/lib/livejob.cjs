'use strict';
/**
 * Live build job — the single source of truth for "is a build happening now,
 * and where is it".
 *
 * The recorder writes here before each stage and again when each ends, so the
 * applet streams stage transitions and a measured percentage while work is in
 * flight. Isolation rules followed here:
 *
 *   - state lives in dev/build-history/data, never in production paths
 *   - no build is started from this module; it only reports one the recorder
 *     is already running
 *   - reads are cached for 1 s so an SSE tick cannot re-read the disk per client
 *   - a job whose heartbeat is older than STALE_MS is reported UNKNOWN
 *     ("interrupted or stalled"), never as success
 *
 * Progress: `percent` is completed stages over total stages — computed, not
 * estimated. `etaSec` is only produced from measured data (this run's finished
 * stages plus the same project's recorded stage durations); when nothing has
 * been measured yet it is null and the client must say "ETA unknown".
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const JOB_FILE = path.join(DATA_DIR, 'current-job.json');
const AUDIT_FILE = path.join(DATA_DIR, 'applet-audit.jsonl');
const STALE_MS = 180000;      // 3 min without a heartbeat => stalled
const KEEP_FINISHED_MS = 900000; // finished jobs stay readable for 15 min

let cache = { at: 0, job: null };

function readJobFile() {
  try { return JSON.parse(fs.readFileSync(JOB_FILE, 'utf8')); } catch (_) { return null; }
}

function writeJob(job) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = JOB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(job, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, JOB_FILE);
  } catch (_) { /* best effort: the recorder's own record file stays authoritative */ }
  cache = { at: 0, job };
}

function median(values) {
  const v = values.filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : Math.round((v[mid - 1] + v[mid]) / 2);
}

/**
 * Per-stage duration medians from previous recorded builds of the same project.
 * Supplied by the caller (store stays the owner of history) so this module
 * never reads build records itself.
 */
function stageHistory(rows) {
  const out = {};
  for (const rec of rows || []) {
    for (const st of rec.stages || []) {
      if (st.status !== 'done' || !Number.isFinite(st.ms)) continue;
      (out[st.id] = out[st.id] || []).push(st.ms);
    }
  }
  const medians = {};
  for (const id of Object.keys(out)) medians[id] = median(out[id]);
  return medians;
}

/** Estimate from measured data only. Returns {etaSec, basis} or {etaSec:null}. */
function estimate(job, history) {
  const stages = job.stages || [];
  const done = stages.filter((s) => s.status === 'done');
  const remaining = stages.filter((s) => s.status === 'pending' || s.status === 'running');
  if (!remaining.length) return { etaSec: 0, basis: 'all stages complete' };

  const inRun = median(done.map((s) => s.ms));
  const useHistory = history && Object.keys(history).length > 0;
  if (!done.length && !useHistory) return { etaSec: null, basis: null, reason: 'no measured stage durations yet' };

  let total = 0;
  let measured = 0;
  for (const st of remaining) {
    const predicted = useHistory && Number.isFinite(history[st.id]) ? history[st.id] : inRun;
    if (!Number.isFinite(predicted)) continue;
    measured++;
    total += predicted;
    // a running stage has already spent part of its budget
    if (st.status === 'running' && st.startedAt) {
      total -= Math.max(0, Date.now() - Date.parse(st.startedAt));
    }
  }
  if (!measured) return { etaSec: null, basis: null, reason: 'no measurable stage duration for the remaining stages' };
  return {
    etaSec: Math.max(0, Math.round(total / 1000)),
    basis: useHistory ? 'measured stage durations from earlier recorded builds' : 'measured stages in this run',
  };
}

/** Append one audit line. Caller supplies only whitelisted fields. */
const EVENT_TYPES = new Set([
  'spinner.activate',
  'applet.expand',
  'applet.collapse',
  'job.progress',
  'job.stage',
  'job.complete',
  'job.failed',
  'stability.verified',
  'stability.degraded',
  'telemetry.lost',
  'telemetry.restored',
]);

function audit(entry) {
  const event = String(entry.event || '');
  if (!EVENT_TYPES.has(event)) return { ok: false, error: 'event type not allowed' };
  const line = {
    at: new Date().toISOString(),          // server clock, UTC — client clocks are not trusted
    project: 'haksterai',
    box: 'dell',
    source: 'applet',
    event,
    buildId: entry.buildId ? String(entry.buildId).slice(0, 64) : null,
    stage: entry.stage ? String(entry.stage).slice(0, 48) : null,
    percent: Number.isFinite(entry.percent) ? Math.max(0, Math.min(100, Math.round(entry.percent))) : null,
    detail: entry.detail ? String(entry.detail).replace(/[\r\n]+/g, ' ').slice(0, 300) : null,
    scope: entry.scope === 'owner' ? 'owner' : entry.scope === 'user' ? 'user' : 'public',
  };
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(AUDIT_FILE, JSON.stringify(line) + '\n', { mode: 0o600 });
    return { ok: true, line };
  } catch (e) {
    return { ok: false, error: e.code || e.message };
  }
}

function readAudit(limit = 100) {
  try {
    const text = fs.readFileSync(AUDIT_FILE, 'utf8').trim();
    if (!text) return [];
    return text.split('\n').slice(-limit).reverse().map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch (_) { return []; }
}

/** Public projection of the live job — no paths, no logs, no identities. */
function summary() {
  const job = readJobFile();
  if (!job) return { state: 'IDLE', label: 'Idle · no build running', percent: null, indeterminate: false };
  if (Date.now() - cache.at < 1000 && cache.job) return cache.job;

  const age = Date.now() - Date.parse(job.heartbeatAt || job.startedAt || 0);
  const finished = job.status === 'completed' || job.status === 'failed';
  if (finished && Date.now() - job.finishedMs > KEEP_FINISHED_MS) {
    const idle = { state: 'IDLE', label: 'Idle · no build running', percent: null, indeterminate: false };
    cache = { at: Date.now(), job: idle };
    return idle;
  }

  const stages = job.stages || [];
  const done = stages.filter((s) => s.status === 'done').length;
  const failed = stages.find((s) => s.status === 'failed');
  const runningStage = stages.find((s) => s.status === 'running');
  const elapsedSec = Math.max(0, Math.round((Date.now() - Date.parse(job.startedAt)) / 1000));
  const percent = stages.length ? Math.round((done / stages.length) * 100) : null;
  const { etaSec, basis, reason } = estimate(job, job.history || null);

  let state;
  let label;
  if (age > STALE_MS && !finished) {
    state = 'UNKNOWN';
    label = 'Build telemetry stalled — last update ' + Math.round(age / 1000) + 's ago';
  } else if (job.status === 'failed') {
    state = 'FAILED';
    label = `Build failed${failed ? ' at ' + failed.label : ''}`;
  } else if (job.status === 'completed') {
    state = 'VERIFYING';
    label = 'Build complete · verifying health and stability';
  } else if (runningStage) {
    state = 'RUNNING';
    label = runningStage.label;
  } else {
    state = 'RUNNING';
    label = 'Build running';
  }

  const out = {
    state,
    label,
    percent: state === 'RUNNING' || state === 'VERIFYING' ? percent : percent,
    indeterminate: !Number.isFinite(percent),
    buildId: job.buildId || null,
    project: job.project || 'haksterai',
    startedAt: job.startedAt,
    elapsedSec,
    etaSec: Number.isFinite(etaSec) ? etaSec : null,
    etaBasis: basis || null,
    etaNote: Number.isFinite(etaSec) ? null : (reason || null),
    stage: runningStage ? { id: runningStage.id, label: runningStage.label } : null,
    stages: stages.map((s) => ({ id: s.id, label: s.label, status: s.status, ms: s.ms })),
    updates: (job.updates || []).slice(-8),
    error: job.error || null,
    errorTail: (job.errorTail || []).slice(-40),
    status: job.status || 'running',
  };
  cache = { at: Date.now(), job: out };
  return out;
}

/** Called by the recorder. Never throws into the build path. */
function begin(meta) {
  const now = new Date();
  writeJob({
    buildId: meta.buildId,
    project: meta.project || 'haksterai',
    box: meta.box || 'dell',
    status: 'running',
    startedAt: now.toISOString(),
    heartbeatAt: now.toISOString(),
    stages: (meta.stages || []).map((s) => ({ ...s, status: 'pending', startedAt: null, finishedAt: null, ms: null })),
    updates: [{ at: now.toISOString(), text: 'Build queued' }],
    history: meta.history || null,
    error: null,
    errorTail: [],
    finishedMs: null,
  });
}

function stage(id, status, detail) {
  const job = readJobFile();
  if (!job) return;
  const st = (job.stages || []).find((s) => s.id === id);
  const now = new Date().toISOString();
  if (st) {
    st.status = status;
    if (status === 'running') st.startedAt = now;
    if (status === 'done' || status === 'failed') {
      st.finishedAt = now;
      st.ms = st.startedAt ? Date.now() - Date.parse(st.startedAt) : null;
    }
  }
  job.heartbeatAt = now;
  job.updates = (job.updates || []).concat({ at: now, text: `${st ? st.label : id}: ${status}${detail ? ' — ' + String(detail).slice(0, 160) : ''}` }).slice(-40);
  writeJob(job);
}

function heartbeat() {
  const job = readJobFile();
  if (!job) return;
  job.heartbeatAt = new Date().toISOString();
  writeJob(job);
}

function finish(outcome, detail, errorTail, history) {
  const job = readJobFile();
  if (!job) return;
  job.status = outcome;
  job.finishedMs = Date.now();
  job.heartbeatAt = new Date().toISOString();
  if (detail) job.updates = (job.updates || []).concat({ at: job.heartbeatAt, text: detail }).slice(-40);
  if (outcome === 'failed') {
    job.error = detail || 'build failed';
    job.errorTail = (errorTail || []).slice(-40);
  }
  if (history) job.history = history;
  writeJob(job);
}

module.exports = { summary, begin, stage, heartbeat, finish, audit, readAudit, stageHistory, EVENT_TYPES, JOB_FILE, AUDIT_FILE };
