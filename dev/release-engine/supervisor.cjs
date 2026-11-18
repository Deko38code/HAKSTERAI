'use strict';
/**
 * Release supervisor — queue, single slot, out-of-process builds.
 *
 * It never builds in its own event loop: each build is a child process, so an
 * HTTP server that imported this module would stay responsive while a build
 * runs. One build at a time, always: a second request joins the queue instead
 * of competing for CPU and disk with the first.
 *
 * Commands:
 *   node supervisor.cjs run [--project haksterai] [--root <repo>] [--install]
 *   node supervisor.cjs status
 *   node supervisor.cjs queue
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const journal = require('./lib/journal.cjs');

const QUEUE_FILE = path.join(__dirname, 'data', 'queue.json');
const LOCK_FILE = path.join(__dirname, 'data', 'running.json');

function readQueue() {
  try { return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8')); } catch (_) { return []; }
}
function writeQueue(q) {
  try {
    fs.mkdirSync(path.dirname(QUEUE_FILE), { recursive: true });
    fs.writeFileSync(QUEUE_FILE + '.tmp', JSON.stringify(q, null, 2), { mode: 0o600 });
    fs.renameSync(QUEUE_FILE + '.tmp', QUEUE_FILE);
  } catch (_) {}
}

// The running build is recorded on disk and keyed by the worker's PID, not in
// a variable: a supervisor that lives inside the HTTP process would otherwise
// forget its queue on every restart and leave work stranded in queue.json.
function currentRun() {
  let lock = null;
  try { lock = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')); } catch (_) { return null; }
  if (!lock || !lock.pid) return null;
  try {
    process.kill(lock.pid, 0); // signal 0 only tests existence
    return lock;
  } catch (_) {
    return null; // the worker is gone: the queue may proceed
  }
}
function setRun(lock) {
  try {
    fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
    if (!lock) { try { fs.unlinkSync(LOCK_FILE); } catch (_) {} return; }
    fs.writeFileSync(LOCK_FILE, JSON.stringify(lock), { mode: 0o600 });
  } catch (_) {}
}

/**
 * Start one release. Returns { queued } immediately; never blocks the caller.
 * If a build is already running, the request is persisted to the queue and
 * will be drained by the next start/status/drain call.
 */
function start(opts = {}) {
  const project = opts.project || 'haksterai';
  const root = path.resolve(opts.root || path.join(__dirname, '..', '..'));
  const release = opts.release || new Date().toISOString().replace(/[:.]/g, '-');
  const job = { id: release, project, root, install: Boolean(opts.install), queuedAt: new Date().toISOString() };

  const running = currentRun();
  if (running) {
    const q = readQueue();
    q.push(job);
    writeQueue(q);
    journal.append({ project, release, type: 'release.queued', reason: 'another release is running (' + running.id + ')' });
    return { queued: true, position: q.length, running: running.id };
  }
  return runNow(job);
}

/** Start the next queued release if nothing is running. Safe to call often. */
function drain() {
  if (currentRun()) return { running: true };
  const q = readQueue();
  if (!q.length) return { queued: 0 };
  const next = q[0];
  writeQueue(q.slice(1));
  return runNow(next);
}

function runNow(job) {
  journal.append({ project: job.project, release: job.id, type: 'release.start', root: job.root });
  const argv = [path.join(__dirname, 'worker.cjs'), '--project', job.project, '--release', job.id, '--root', job.root];
  if (job.install) argv.push('--install');
  // Background form: the worker writes its own journal, so it must not depend
  // on a parent's stdout staying open — a supervisor embedded in the HTTP
  // process may exit or the pipe may close, and an EPIPE must never kill a
  // build halfway through. The last 4 KB of a failing build still reaches the
  // journal through the worker's release.failed / build.output events.
  const logPath = path.join(__dirname, 'data', 'worker-' + job.id.replace(/[:.]/g, '-') + '.log');
  let out = 'ignore';
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    out = fs.openSync(logPath, 'a');
  } catch (_) { out = 'ignore'; }
  const child = spawn(process.execPath, argv, { stdio: ['ignore', out, out], env: process.env });
  setRun({ id: job.id, project: job.project, pid: child.pid, startedAt: new Date().toISOString() });
  let tail = '';
  const readTail = () => {
    try {
      const st = fs.statSync(logPath);
      const span = Math.min(st.size, 4096);
      const fd = fs.openSync(logPath, 'r');
      const buf = Buffer.alloc(span);
      fs.readSync(fd, buf, 0, span, st.size - span);
      fs.closeSync(fd);
      tail = buf.toString('utf8');
    } catch (_) {}
  };
  child.on('exit', (code) => {
    setRun(null);
    if (code !== 0) readTail();
    journal.append({
      project: job.project, release: job.id, type: code === 0 ? 'release.finished' : 'release.aborted',
      exitCode: code, tail: code === 0 ? undefined : tail,
    });
    const q = readQueue();
    if (q.length) {
      const next = q[0];
      writeQueue(q.slice(1));
      runNow(next);
    }
  });
  return { started: true, release: job.id, pid: child.pid };
}

/** Latest position of a release, from the journal only. */
function status(project = 'haksterai') {
  const rows = journal.read(20000).filter((e) => e.project === project);
  const byRelease = new Map();
  for (const e of rows) {
    if (!e.release) continue;
    let r = byRelease.get(e.release);
    if (!r) { r = { release: e.release, completed: [], current: null, startedAt: null, ready: null, failed: null, buildId: null }; byRelease.set(e.release, r); }
    if (e.type === 'release.start') r.startedAt = e.at;
    if (e.type === 'stage.start') r.current = e.stage;
    if (e.type === 'stage.end') { r.completed.push(e.stage); r.current = null; }
    if (e.type === 'release.ready') { r.ready = e.at; r.buildId = e.buildId; }
    if (e.type === 'release.failed') r.failed = { at: e.at, reason: e.reason };
  }
  const list = [...byRelease.values()].map((r) => ({ ...r, progress: journal.progress(project, r.completed, r.current) }));
  return { running: currentRun(), queued: readQueue(), releases: list.slice(-5) };
}

module.exports = { start, drain, status, QUEUE_FILE, LOCK_FILE };

if (require.main === module) {
  const cmd = process.argv[2] || 'status';
  const args = {};
  for (let i = 3; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1] === undefined ? true : process.argv[i + 1];
  if (cmd === 'run') {
    // CLI form: stay attached to the child so its output is not lost to a
    // closed pipe. The server-side form (`start`) returns immediately.
    const job = {
      id: args.release || new Date().toISOString().replace(/[:.]/g, '-'),
      project: args.project || 'haksterai',
      root: path.resolve(args.root || path.join(__dirname, '..', '..')),
      install: Boolean(args.install),
    };
    journal.append({ project: job.project, release: job.id, type: 'release.start', root: job.root });
    const argv = [path.join(__dirname, 'worker.cjs'), '--project', job.project, '--release', job.id, '--root', job.root];
    if (job.install) argv.push('--install');
    const child = spawn(process.execPath, argv, { stdio: 'inherit', env: process.env });
    setRun({ id: job.id, project: job.project, pid: child.pid, startedAt: new Date().toISOString() });
    child.on('exit', (code) => {
      setRun(null);
      journal.append({ project: job.project, release: job.id, type: code === 0 ? 'release.finished' : 'release.aborted', exitCode: code });
      process.exit(code === 0 ? 0 : 1);
    });
  } else if (cmd === 'drain') {
    console.log(JSON.stringify(drain(), null, 2));
  } else {
    const drained = drain(); // any queued work resumes even after a restart
    const st = status(args.project || 'haksterai');
    if (drained.started) st.drainedNow = drained.release;
    console.log(JSON.stringify(st, null, 2));
  }
}
