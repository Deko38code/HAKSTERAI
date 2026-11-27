'use strict';

/**
 * bankSync — one memory bank set, the same on both boxes, checked per account.
 *
 * Owner (2026-11-27): "i always want the memory count correct and the same on
 * both boxes for better memory recalling … we need a auto update feat that
 * checks banks that are connected to any cli per user who uses me owner paid
 * users and will stay in sync with cli's signed in accounts".
 *
 * The CLI counts its OWN disk (~/.hakster/memories/banks). A memory banked on
 * the Dell after the last commit therefore reads 438 here and 437 on the
 * standby, and recall is worse on whichever box is behind. This module:
 *
 *   1. COUNTS both boxes — local from disk, the peer over one bounded `ssh
 *      cat` (read only, cached, single-flight, exactly like peerMemory), and
 *      names the account each box's CLI is signed in as (email only — never a
 *      key);
 *   2. REPORTS the drift per bank file, never inventing a number (§10, §13);
 *   3. HEALS by running scripts/memory-bank-sync.cjs, which unions the two
 *      bank dirs APPEND-ONLY in both directions — nothing is ever removed;
 *   4. RUNS THE CHECK ON ITS OWN, on an interval, and only syncs when the two
 *      boxes actually disagree (HK_BANK_SYNC=off disables it).
 *
 * Rules it follows:
 *   - READ before write: the health read is the gate, and a sync only happens
 *     when the measured counts differ.
 *   - NEVER INVENTED: an unreachable peer says unreachable; a peer with no
 *     banks says zero; a failed sync is reported as drift, not as synced.
 *   - NEVER WRITTEN INTO ANOTHER PROJECT: this is HaksterAI's own memory on
 *     its own two boxes (§16, §41).
 *   - NOTHING IS RESTARTED (§37, §45): the scheduler only reads, merges bank
 *     files atomically, and appends one log line.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

let autolearn;
try { autolearn = require('./agent/autolearn'); } catch { autolearn = null; }

function ghostHome() {
  if (process.env.HAKSTER_HOME) return process.env.HAKSTER_HOME;
  if (autolearn && typeof autolearn.resolveGhostHome === 'function') {
    try { return autolearn.resolveGhostHome(); } catch { /* fall through */ }
  }
  return require('os').homedir();
}

function bankDir() {
  return path.join(ghostHome(), '.hakster', 'memories', 'banks');
}

// The one peer that must carry the same banks: the standby box. Adding a box
// is data, not a code change (§26.5). `sshAlias` lives in ~/.ssh/config.
const PEER = {
  host: 'lenovo',
  sshAlias: process.env.HAKSTER_BANK_PEER || 'mint',
  label: 'Lenovo (standby)',
  address: '10.0.0.210',
  role: 'standby / failover peer',
};

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'memory-bank-sync.cjs');
const LOG_PATH = path.join(ghostHome(), 'haksterAi', 'logs', 'memory-bank-sync.log');
const SPLIT = '__HAKSTER_BANK_SPLIT__';
const CACHE_MS = 60 * 1000;
const FAIL_CACHE_MS = 30 * 1000;

// One remote command: the CLI account (email field only — the file's keys are
// never read out), then every bank file with its own name and a split marker so
// the parser never guesses where one file ends.
const REMOTE_CMD = [
  `grep -o '"email"[^,}]*' $HOME/.hakster/config.json 2>/dev/null || true`,
  `echo "${SPLIT}"`,
  `for f in $HOME/.hakster/memories/banks/*.json; do [ -f "$f" ] && { echo "__BANK__ $(basename "$f")"; cat "$f"; echo "${SPLIT}"; }; done`,
  // Per-user roots (§29.6, §53): a paid user's banks are that user's own set and
  // are counted as their own root, never added into the box total.
  `for f in $HOME/.hakster/memories/users/*/banks/*.json; do [ -f "$f" ] && { echo "__UBANK__ \${f#$HOME/.hakster/memories/}"; cat "$f"; echo "${SPLIT}"; }; done`,
  'true', // a peer with no banks leaves the loop at status 1 — success, no banks
].join('; ');

const _cache = { at: 0, ttl: 0, value: null };
const _inflight = { promise: null };
const state = {
  enabled: false,
  intervalMs: 0,
  lastRunAt: null,
  lastResult: null,
  lastSyncAt: null,
  lastSyncResult: null,
  failures: 0,
};

function countBankDir(dir) {
  const files = {};
  let total = 0;
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return { dir, files, total, present: false }; }
  for (const name of names) {
    let n = 0;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      n = Array.isArray(parsed) ? parsed.length : 0;
    } catch { n = 0; } // a half-written bank is skipped, never counted as a memory
    files[name] = n;
    total += n;
  }
  return { dir, files, total, present: true };
}

function localAccount() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ghostHome(), '.hakster', 'config.json'), 'utf8'));
    return typeof cfg.email === 'string' && cfg.email ? cfg.email : null;
  } catch { return null; }
}

/** Every bank root under a memories dir: `banks` plus `users/<slug>/banks`. */
function rootRels(memDir) {
  const rels = [];
  if (fs.existsSync(path.join(memDir, 'banks'))) rels.push('banks');
  let users = [];
  try {
    users = fs.readdirSync(path.join(memDir, 'users'), { withFileTypes: true })
      .filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch { users = []; }
  for (const slug of users) {
    if (fs.existsSync(path.join(memDir, 'users', slug, 'banks'))) rels.push(`users/${slug}/banks`);
  }
  return rels;
}

/** Entry count per root — a user's set is its own root, never added to the box's. */
function countRoots(memDir) {
  const roots = {};
  for (const rel of rootRels(memDir)) roots[rel] = countBankDir(path.join(memDir, rel)).total;
  return roots;
}

/** Pure: turn one peer's raw `cat` output into counts + account. */
function summarizePeerText(text) {
  const segments = String(text || '').split(SPLIT);
  const accountMatch = /"email"\s*:\s*"([^"]*)"/.exec(segments[0] || '');
  const files = {};
  const userRoots = {};
  let total = 0;
  for (const seg of segments.slice(1)) {
    const trimmed = seg.replace(/^\s+/, '');
    const marker = /^__(U?)BANK__\s+(\S+)\s*\n/.exec(trimmed);
    if (!marker) continue;
    const isUser = marker[1] === 'U';
    const name = marker[2];
    let n = 0;
    try {
      const parsed = JSON.parse(trimmed.slice(marker[0].length));
      n = Array.isArray(parsed) ? parsed.length : 0;
    } catch { n = 0; }
    if (isUser) {
      const rel = name.replace(/\/[^/]+$/, ''); // users/<slug>/banks
      userRoots[rel] = (userRoots[rel] || 0) + n;
    } else {
      files[name] = n;
      total += n;
    }
  }
  const roots = { banks: total, ...userRoots };
  return { account: accountMatch ? accountMatch[1] : null, files, userRoots, roots, total, totalAll: Object.values(roots).reduce((a, b) => a + b, 0) };
}

/** Drift between two per-root maps, naming the root that differs. */
function rootDrift(localRoots, peerRoots) {
  const names = new Set([...Object.keys(localRoots || {}), ...Object.keys(peerRoots || {})]);
  const roots = {};
  for (const rel of names) {
    const a = (localRoots || {})[rel] || 0;
    const b = (peerRoots || {})[rel] || 0;
    if (a !== b) roots[rel] = { local: a, peer: b };
  }
  return { differs: Object.keys(roots).length > 0, roots };
}

function driftBetween(a, b) {
  const names = new Set([...Object.keys((a && a.files) || {}), ...Object.keys((b && b.files) || {})]);
  const files = {};
  for (const name of names) {
    const x = ((a && a.files) || {})[name] || 0;
    const y = ((b && b.files) || {})[name] || 0;
    if (x !== y) files[name] = { local: x, peer: y };
  }
  return { differs: Object.keys(files).length > 0, files, delta: ((b && b.total) || 0) - ((a && a.total) || 0) };
}

function readPeerRaw() {
  if (_inflight.promise) return _inflight.promise;
  const promise = new Promise((resolve) => {
    execFile(
      'ssh',
      ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=accept-new', PEER.sshAlias, REMOTE_CMD],
      { timeout: 12000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        _inflight.promise = null;
        if (err) return resolve({ error: String((err && err.message) || 'unreachable').slice(0, 160) });
        return resolve({ text: String(stdout || '') });
      },
    );
  });
  _inflight.promise = promise;
  return promise;
}

/**
 * Both boxes' counts + the account each CLI is signed in as, and the drift
 * between them. `budgetMs` bounds the wait: past it the answer is `pending`
 * and the read keeps warming so the next poll carries it.
 */
async function health(opts = {}) {
  const budgetMs = Math.max(200, Number(opts.budgetMs) || 6000);
  const local = countBankDir(bankDir());
  const localRoots = countRoots(path.dirname(bankDir()));
  const localBox = {
    host: require('os').hostname(),
    account: localAccount(),
    total: local.total, // the box's own banks — the count the CLI header shows
    roots: localRoots, // every root it holds, per-user sets kept separate
    totalAll: Object.values(localRoots).reduce((a, b) => a + b, 0),
    files: local.files,
    dir: local.dir,
    present: local.present,
  };

  let peer;
  if (_cache.value && Date.now() - _cache.at < _cache.ttl) {
    peer = { ..._cache.value, cached: true };
  } else {
    let timer;
    const work = readPeerRaw().then((raw) => {
      let value;
      if (raw.error) {
        value = { reachable: false, error: raw.error, total: 0, files: {}, roots: {}, account: null };
        _cache.at = Date.now(); _cache.ttl = FAIL_CACHE_MS;
      } else {
        const sum = summarizePeerText(raw.text);
        value = { reachable: true, account: sum.account, total: sum.total, files: sum.files, roots: sum.roots, error: null };
        _cache.at = Date.now(); _cache.ttl = CACHE_MS;
      }
      value.host = PEER.host;
      value.label = PEER.label;
      value.address = PEER.address;
      _cache.value = value;
      return value;
    });
    peer = await Promise.race([
      work,
      new Promise((resolve) => { timer = setTimeout(() => resolve({ pending: true }), budgetMs); }),
    ]);
    clearTimeout(timer);
  }

  const drift = peer && peer.reachable === true
    ? { ...driftBetween(localBox, peer), rootDrift: rootDrift(localRoots, peer.roots) }
    : { differs: null, files: {}, delta: null, rootDrift: { differs: null, roots: {} } };
  // A per-user root that differs is drift too, even when the box totals match.
  if (drift.rootDrift && drift.rootDrift.differs === true) drift.differs = true;

  return {
    ok: !!(peer && peer.reachable === true),
    checkedAt: new Date().toISOString(),
    local: localBox,
    peer: {
      host: PEER.host,
      label: PEER.label,
      address: PEER.address,
      role: PEER.role,
      reachable: peer ? peer.reachable : null,
      pending: !!(peer && peer.pending),
      account: peer ? peer.account || null : null,
      total: peer ? peer.total || 0 : 0,
      roots: peer ? peer.roots || {} : {},
      files: peer ? peer.files || {} : {},
      error: peer ? peer.error || null : null,
    },
    drift,
    equal: drift.differs === false,
    // One row per signed-in CLI account, each with its own box's count — the
    // figures are never summed across accounts or boxes (§29.6, §52.3).
    accounts: [
      { box: 'this box', host: localBox.host, account: localBox.account, total: localBox.total },
      { box: PEER.label, host: PEER.host, account: peer ? peer.account || null : null, total: peer ? peer.total || 0 : 0 },
    ],
    auto: {
      enabled: state.enabled,
      intervalMs: state.intervalMs,
      lastRunAt: state.lastRunAt,
      lastResult: state.lastResult,
      lastSyncAt: state.lastSyncAt,
      lastSyncResult: state.lastSyncResult,
      failures: state.failures,
    },
  };
}

function appendLog(line) {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${line}\n`);
    // Bound the log without losing recent history.
    try {
      const st = fs.statSync(LOG_PATH);
      if (st.size > 1024 * 1024) {
        const lines = fs.readFileSync(LOG_PATH, 'utf8').split('\n').slice(-200);
        fs.writeFileSync(LOG_PATH, lines.join('\n'));
      }
    } catch { /* log trimming is best-effort */ }
  } catch { /* logging never breaks the feature */ }
}

/** Run the union sync. Bounded; its JSON is returned as-is. */
function syncNow(opts = {}) {
  const argv = [SCRIPT];
  if (opts.dryRun) argv.push('--dry-run');
  return new Promise((resolve) => {
    execFile('node', argv, { timeout: Math.max(30000, Number(opts.timeoutMs) || 180000), maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const text = String(stdout || '');
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { parsed = null; }
      const out = parsed || {
        ok: false,
        error: 'sync-unparseable',
        note: String(stderr || (err && err.message) || '').slice(0, 300),
      };
      if (err && !parsed) out.exitCode = err.code || null;
      state.lastSyncAt = new Date().toISOString();
      state.lastSyncResult = out.ok ? 'equal' : (out.error || 'drift-remains');
      if (out.ok) _cache.at = 0;
      resolve(out);
    });
  });
}

let _timer = null;
let _busy = false;

/**
 * The automatic check. Every interval it measures both boxes; when they
 * disagree it unions them (append-only) and records what happened. It never
 * restarts, never deletes and never writes into another project.
 */
function startAutoSync(opts = {}) {
  if (process.env.HK_BANK_SYNC === 'off') {
    appendLog('auto sync disabled by HK_BANK_SYNC=off');
    return { running: false, reason: 'disabled' };
  }
  const intervalMs = Math.max(60 * 1000, Number(opts.intervalMs) || 10 * 60 * 1000);
  state.enabled = true;
  state.intervalMs = intervalMs;
  if (_timer) return { running: true, intervalMs: state.intervalMs };

  const tick = async () => {
    if (_busy) return;
    _busy = true;
    try {
      const h = await health({ budgetMs: 8000 });
      state.lastRunAt = new Date().toISOString();
      if (!h.peer.reachable) {
        state.failures += 1;
        state.lastResult = `peer-${h.peer.pending ? 'pending' : 'unreachable'}`;
        return;
      }
      state.failures = 0;
      if (h.equal) {
        state.lastResult = `equal ${h.local.total}/${h.peer.total}`;
        return;
      }
      state.lastResult = `drift ${h.local.total}/${h.peer.total} — syncing`;
      appendLog(`drift local=${h.local.total} peer=${h.peer.total} files=${Object.keys(h.drift.files).join(',') || 'total'}`);
      const res = await syncNow();
      appendLog(`sync ${res.ok ? 'equal' : 'INCOMPLETE'} local=${res.after && res.after.local ? res.after.local.total : '?'} peer=${res.after && res.after.peer ? res.after.peer.total : '?'}`);
      if (!res.ok && typeof opts.alert === 'function') {
        try {
          opts.alert(`memory banks still out of sync after a sync attempt: local ${res.after && res.after.local ? res.after.local.total : '?'} · peer ${res.after && res.after.peer ? res.after.peer.total : '?'}`);
        } catch { /* alerting is best-effort */ }
      }
    } catch (err) {
      state.failures += 1;
      state.lastResult = `error ${String((err && err.message) || err).slice(0, 120)}`;
    } finally {
      _busy = false;
    }
  };

  _timer = setInterval(tick, intervalMs);
  try { if (typeof _timer.unref === 'function') _timer.unref(); } catch { /* Bun timers */ }
  // First measurement shortly after boot, not on top of the boot burst.
  const kick = setTimeout(tick, 20000);
  try { if (typeof kick.unref === 'function') kick.unref(); } catch { /* ignore */ }
  appendLog(`auto sync started (${Math.round(intervalMs / 60000)} min)`);
  return { running: true, intervalMs };
}

function stopAutoSync() {
  if (_timer) clearInterval(_timer);
  _timer = null;
  state.enabled = false;
}

module.exports = {
  PEER,
  LOG_PATH,
  REMOTE_CMD,
  bankDir,
  countBankDir,
  countRoots,
  rootDrift,
  rootRels,
  summarizePeerText,
  driftBetween,
  health,
  syncNow,
  startAutoSync,
  stopAutoSync,
  state,
};
