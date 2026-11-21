'use strict';
/**
 * haksterAi — CLI provenance guard (2026-11-22, owner request).
 *
 * Owner: "find the best security anomaly detector that Microsoft uses for
 * pattern and if someone runs our scripts with any other cli but ours will
 * detect and notify us."
 *
 * The design follows the three Microsoft detection patterns that fit this job:
 *
 *   1. UEBA-style baselining (Microsoft Sentinel UEBA) — every launch of one of
 *      our scripts is a behaviour record: which script, which launcher, which
 *      process lineage, which user. Each script learns its own normal launchers.
 *   2. Adaptive application control (Microsoft Defender for Cloud) — the first
 *      time a launcher is seen for a script it becomes a pattern the owner can
 *      review; a launcher outside the learned pattern is the alert, and repeats
 *      update the same pattern instead of spamming.
 *   3. SR-CNN volume scoring (Microsoft Anomaly Detector: Spectral Residual +
 *      dynamic threshold) — invocation counts per script per hour are scored
 *      with the spectral-residual saliency test the Azure Anomaly Detector is
 *      built on, so a burst of runs stands out even when the launcher looks
 *      ordinary.
 *
 * Detection, not enforcement: this module records and notifies. It never kills
 * a process, blocks a launcher, edits config, restarts anything or touches
 * another project (§11, §16, §17). The log table is append-only. Alerts go to
 * the dashboard (security_notifications, category cli-provenance / cli-volume)
 * and to the owner's Telegram through the existing security report channel.
 *
 * Our CLI is `hak` (haksterai-cli.cjs) and the haksterAi CLI entrypoints. A run
 * launched by any other agent CLI — Claude Code, Codex, Kiro, Gemini CLI, Aider,
 * Cursor Agent, OpenHands, Goose, Cline, Copilot, Continue — is reported as
 * `foreign` and alerted. A plain owner shell is baselined without an alert.
 * HK_CLI_GUARD=off is a hard kill switch.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getDb } = require('./db');

const SCAN_INTERVAL_MS = 60_000;
const STATE_FILE_VERSION = 1;
const NOTIFY_REPEAT_MS = 24 * 60 * 60_000; // one Telegram per pattern per day

// ─── What counts as one of our scripts ─────────────────────────────────────
const OUR_SCRIPTS = [
  ['hak', 'hak CLI (haksterai-cli.cjs)', (argv) => argv.some((a) => /(^|\/)haksterai-cli\.cjs$/.test(a))],
  ['cli-index', 'haksterAi CLI (cli/index.js)', (argv) => argv.some((a) => /\/haksterAi\/cli\/index\.js$/.test(a))],
  ['cli-ui', 'haksterAi CLI (cli/ui.mjs)', (argv) => argv.some((a) => /\/haksterAi\/cli\/ui\.mjs$/.test(a))],
  ['cli-tui', 'haksterAi CLI (cli/tui-entry.mjs)', (argv) => argv.some((a) => /\/haksterAi\/cli\/tui-entry\.mjs$/.test(a))],
];

// Foreign agent CLIs are matched by process name and by env marker. Names are
// checked on the argv[0] basename so a shell function or symlink is covered.
const FOREIGN_NAMES = [
  [/^claude$/, 'Claude Code'],
  [/^codex$/, 'Codex CLI'],
  [/^kiro$/i, 'Kiro'],
  [/^gemini$/, 'Gemini CLI'],
  [/^aider$/i, 'Aider'],
  [/^cursor-agent$/i, 'Cursor Agent'],
  [/^windsurf$/i, 'Windsurf'],
  [/^openhands$/i, 'OpenHands'],
  [/^goose$/i, 'Goose'],
  [/^cline$/i, 'Cline'],
  [/^copilot$/i, 'Copilot CLI'],
  [/^continue$/i, 'Continue'],
  [/^qwen$/i, 'Qwen CLI'],
  [/^hermes$/i, 'Hermes CLI'],
];

const ENV_MARKERS = [
  ['CLAUDECODE', 'Claude Code'],
  ['CLAUDE_CODE_ENTRYPOINT', 'Claude Code'],
  ['CODEX_SANDBOX', 'Codex CLI'],
  ['KIRO_SESSION_ID', 'Kiro'],
  ['GEMINI_CLI', 'Gemini CLI'],
  ['CURSOR_AGENT', 'Cursor Agent'],
  ['AIDER_MODEL', 'Aider'],
  ['OPENHANDS', 'OpenHands'],
  ['GOOSE_SESSION_ID', 'Goose'],
  ['CLINE_SESSION_ID', 'Cline'],
  ['COPILOT_AGENT', 'Copilot CLI'],
  ['HERMES_CLI', 'Hermes CLI'],
];

const SHELLS = /^(bash|zsh|sh|dash|fish|tcsh|ksh)$/;
const SERVICES = /^(pm2|cron|crond|systemd|init)$/;

function isHardOff() {
  return String(process.env.HK_CLI_GUARD || '').toLowerCase() === 'off';
}

function nowIso() {
  return new Date().toISOString();
}

// ─── Storage ───────────────────────────────────────────────────────────────
let ready = false;
function ensureTables() {
  const db = getDb();
  if (!ready) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS cli_invocations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        script TEXT NOT NULL,
        launcher TEXT NOT NULL,
        kind TEXT NOT NULL,
        pid INTEGER,
        starttime TEXT,
        ppid INTEGER,
        uid INTEGER,
        user TEXT,
        cwd TEXT,
        chain TEXT,
        source TEXT,
        detail TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS cli_inv_uniq
        ON cli_invocations(pid, starttime, script);
      CREATE INDEX IF NOT EXISTS cli_inv_time ON cli_invocations(created_at);

      CREATE TABLE IF NOT EXISTS cli_guard_patterns (
        key TEXT PRIMARY KEY,
        script TEXT NOT NULL,
        launcher TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        occurrences INTEGER DEFAULT 1,
        first_seen TEXT,
        last_seen TEXT,
        last_notified_at TEXT,
        notes TEXT
      );

      CREATE TABLE IF NOT EXISTS cli_guard_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        last_scan_at TEXT,
        data TEXT,
        updated_at TEXT
      );
    `);
    ready = true;
  }
  return db;
}

function getStateRow() {
  const db = ensureTables();
  let row = db.prepare('SELECT * FROM cli_guard_state WHERE id = 1').get();
  if (!row) {
    db.prepare('INSERT INTO cli_guard_state (id, last_scan_at, data, updated_at) VALUES (1, ?, ?, ?)')
      .run(null, JSON.stringify({ version: STATE_FILE_VERSION, scans: 0, anomalies: [] }), nowIso());
    row = db.prepare('SELECT * FROM cli_guard_state WHERE id = 1').get();
  }
  return row;
}

function loadData() {
  const row = getStateRow();
  let data = {};
  try { data = JSON.parse(row.data || '{}') || {}; } catch (_) { data = {}; }
  return {
    version: data.version || STATE_FILE_VERSION,
    scans: Number(data.scans) || 0,
    anomalies: Array.isArray(data.anomalies) ? data.anomalies : [],
  };
}

function saveData(patch) {
  const db = ensureTables();
  const merged = { ...loadData(), ...patch, version: STATE_FILE_VERSION };
  db.prepare('UPDATE cli_guard_state SET last_scan_at = ?, data = ?, updated_at = ? WHERE id = 1')
    .run(merged.lastScanAt || null, JSON.stringify(merged), nowIso());
}

// ─── /proc inspection ──────────────────────────────────────────────────────
function readProc(pid) {
  try {
    const dir = `/proc/${pid}`;
    const cmdline = fs.readFileSync(`${dir}/cmdline`, 'utf8');
    const argv = cmdline.split('\0').filter(Boolean);
    const comm = fs.readFileSync(`${dir}/comm`, 'utf8').trim();
    const stat = fs.readFileSync(`${dir}/stat`, 'utf8');
    const tail = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ppid = Number(tail[1]);
    const starttime = tail[19]; // field 22 (starttime) in ticks since boot
    if (!argv.length) return null;
    return { pid: Number(pid), argv, comm, ppid, starttime };
  } catch (_) {
    return null;
  }
}

function readEnvKeys(pid) {
  const keys = new Set();
  try {
    const raw = fs.readFileSync(`/proc/${pid}/environ`, 'utf8');
    for (const entry of raw.split('\0')) {
      const at = entry.indexOf('=');
      if (at > 0) keys.add(entry.slice(0, at));
    }
  } catch (_) { /* other users' processes, or gone */ }
  return keys;
}

function readCwd(pid) {
  try { return fs.readlinkSync(`/proc/${pid}/cwd`); } catch (_) { return ''; }
}

function readUser(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/status`, 'utf8')
      .split('\n').find((l) => l.startsWith('Uid:'))
      ?.split(/\s+/)[1] || '';
  } catch (_) { return ''; }
}

function userName(uid) {
  if (!uid) return '';
  try {
    const passwd = fs.readFileSync('/etc/passwd', 'utf8');
    const line = passwd.split('\n').find((l) => l.split(':')[2] === String(uid));
    return line ? line.split(':')[0] : '';
  } catch (_) { return ''; }
}

function basenameOf(value) {
  return path.basename(String(value || ''));
}

function describeChain(chain) {
  return chain.map((p) => {
    const a = (p.argv || []).join(' ').trim();
    return a || p.comm || `pid ${p.pid}`;
  }).join(' ← ');
}

/**
 * Classify who launched a process. Walks up to 10 ancestors, reads their env
 * for foreign-CLI markers, and returns {launcher, kind, evidence, chain}.
 */
function classify(procInfo) {
  const chain = [];
  const seen = new Set();
  let cur = procInfo;
  for (let depth = 0; cur && depth < 10; depth++) {
    chain.push(cur);
    if (!cur.ppid || cur.ppid <= 1 || seen.has(cur.ppid)) break;
    seen.add(cur.pid);
    cur = readProc(cur.ppid);
  }

  // 1. Foreign agent CLI — env marker first (most reliable), then process name.
  for (const p of chain) {
    const env = readEnvKeys(p.pid);
    for (const [key, name] of ENV_MARKERS) {
      if (env.has(key)) {
        return { launcher: `foreign:${name}`, kind: 'foreign', evidence: `env ${key} on pid ${p.pid}`, chain };
      }
    }
    const base = basenameOf((p.argv && p.argv[0]) || p.comm);
    for (const [rx, name] of FOREIGN_NAMES) {
      if (rx.test(base)) {
        return { launcher: `foreign:${name}`, kind: 'foreign', evidence: `process ${base} on pid ${p.pid}`, chain };
      }
    }
  }

  // 2. Our own launcher in the ancestry.
  for (const p of chain.slice(1)) {
    if ((p.argv || []).some((a) => /haksterai-cli\.cjs$/.test(a))) {
      return { launcher: 'ours:hak', kind: 'ours', evidence: 'launched through haksterai-cli.cjs', chain };
    }
  }

  // 3. Service managers.
  for (const p of chain.slice(1)) {
    const base = basenameOf((p.argv && p.argv[0]) || p.comm);
    const joined = (p.argv || []).join(' ');
    if (SERVICES.test(base) || /(^|\/)PM2\b/.test(joined) || /pm2-/.test(joined)) {
      return { launcher: `service:${base || 'pm2'}`, kind: 'service', evidence: 'service manager', chain };
    }
  }

  // 4. Remote shell vs local shell vs unknown.
  const names = chain.slice(1).map((p) => basenameOf((p.argv && p.argv[0]) || p.comm));
  if (names.includes('sshd')) {
    return { launcher: 'ssh:session', kind: 'ssh', evidence: 'SSH session', chain };
  }
  if (names.some((n) => SHELLS.test(n))) {
    return { launcher: 'shell:interactive', kind: 'shell', evidence: 'interactive shell', chain };
  }

  const parent = chain[1] || {};
  const parentName = basenameOf((parent.argv && parent.argv[0]) || parent.comm) || 'unknown';
  return { launcher: `unknown:${parentName}`, kind: 'unknown', evidence: `no known launcher (parent ${parentName})`, chain };
}

// ─── Patterns, notifications, alerts ───────────────────────────────────────
const STATUS_BY_KIND = {
  ours: 'allowed',
  service: 'allowed',
  shell: 'baselined',
  ssh: 'review',
  unknown: 'review',
  foreign: 'blocked',
};

const SEVERITY_BY_KIND = {
  foreign: 'critical',
  unknown: 'high',
  ssh: 'warning',
};

function upsertPattern({ script, launcher, kind, chain }) {
  const db = ensureTables();
  const key = `${script}|${launcher}`;
  const now = nowIso();
  const existing = db.prepare('SELECT * FROM cli_guard_patterns WHERE key = ?').get(key);
  if (existing) {
    db.prepare('UPDATE cli_guard_patterns SET occurrences = occurrences + 1, last_seen = ?, notes = ? WHERE key = ?')
      .run(now, describeChain(chain).slice(0, 300), key);
    return { key, created: false, row: db.prepare('SELECT * FROM cli_guard_patterns WHERE key = ?').get(key) };
  }
  db.prepare(`INSERT INTO cli_guard_patterns
      (key, script, launcher, kind, status, occurrences, first_seen, last_seen, last_notified_at, notes)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?, NULL, ?)`)
    .run(key, script, launcher, kind, STATUS_BY_KIND[kind] || 'review', now, now, describeChain(chain).slice(0, 300));
  return { key, created: true, row: db.prepare('SELECT * FROM cli_guard_patterns WHERE key = ?').get(key) };
}

/**
 * Write the finding into the security notification table the dashboard already
 * reads. Appends/updates only — never resolves other rows, never deletes.
 */
function upsertNotification({ script, launcher, kind, detail }) {
  const db = ensureTables();
  const key = `cli-provenance|${script}|${launcher}`;
  const severity = SEVERITY_BY_KIND[kind] || 'info';
  const now = nowIso();
  const title = `Our script "${script}" was launched by ${launcher.replace(/^foreign:/, '')} (not our CLI)`;
  const existing = db.prepare('SELECT id FROM security_notifications WHERE key = ?').get(key);
  if (existing) {
    // A repeated occurrence proves the condition is still live: reopen the row
    // if someone cleared it, so the panel never hides an active launcher.
    db.prepare('UPDATE security_notifications SET last_seen = ?, scan_count = scan_count + 1, detail = ?, acknowledged = 0 WHERE key = ?')
      .run(now, String(detail || '').slice(0, 500), key);
    return { created: false, key };
  }
  db.prepare(`INSERT INTO security_notifications
      (id, key, severity, category, title, detail, scan_count, first_seen, last_seen)
      VALUES (?, ?, ?, 'cli-provenance', ?, ?, 1, ?, ?)`)
    .run(crypto.randomUUID(), key, severity, title, String(detail || '').slice(0, 500), now, now);
  return { created: true, key, title, severity };
}

function sendTelegram(text) {
  try {
    const bots = require('./telegramBots');
    const send = bots.sendSecurityReport;
    if (typeof send === 'function') return Promise.resolve(send(text));
  } catch (_) { /* bot fleet not initialised (CLI-side hook) — row is still logged */ }
  return Promise.resolve(null);
}

/** Returns whether a notification is due; delivery is async and retried next scan on failure. */
function maybeNotify(patternRow) {
  const db = ensureTables();
  const kind = patternRow.kind;
  if (!SEVERITY_BY_KIND[kind]) return false; // shell/service/ours are baselined only
  const last = patternRow.last_notified_at ? Date.parse(patternRow.last_notified_at) : 0;
  if (Number.isFinite(last) && Date.now() - last < NOTIFY_REPEAT_MS) return false;
  const text = [
    '🔐 *CLI provenance — HaksterAI*',
    '',
    `Our script \`${patternRow.script}\` was launched by *${patternRow.launcher.replace(/^foreign:/, '')}* — not our CLI.`,
    patternRow.notes ? `Chain: \`${String(patternRow.notes).slice(0, 200)}\`` : '',
    '',
    'Logged to cli\\_invocations (append-only). Review: dashboard → CLI Provenance.',
  ].filter(Boolean).join('\n');
  // Mark sent only when a bot actually accepted it; otherwise the next scan retries.
  sendTelegram(text).then((who) => {
    if (!who) return;
    try {
      ensureTables().prepare('UPDATE cli_guard_patterns SET last_notified_at = ? WHERE key = ?').run(nowIso(), patternRow.key);
    } catch (_) { /* DB busy — retried next scan */ }
  }).catch(() => {});
  return true;
}

// ─── Public: report one invocation ─────────────────────────────────────────
/**
 * Record one run of one of our scripts and apply the detection policy.
 * Safe to call from any process (including the CLI itself): it never throws.
 */
function reportInvocation({ script = 'hak', pid = process.pid, source = 'hook' } = {}) {
  try {
    ensureTables();
    const info = readProc(pid);
    const result = info
      ? classify(info)
      : { launcher: 'unknown:unreadable', kind: 'unknown', evidence: 'could not read /proc', chain: [] };
    const db = ensureTables();
    const uid = info ? readUser(pid) : '';
    const detail = result.evidence || '';
    db.prepare(`INSERT OR IGNORE INTO cli_invocations
        (created_at, script, launcher, kind, pid, starttime, ppid, uid, user, cwd, chain, source, detail)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(nowIso(), script, result.launcher, result.kind,
        info ? info.pid : null, info ? info.starttime : null, info ? info.ppid : null,
        uid, userName(uid), info ? readCwd(pid) : '',
        describeChain(result.chain).slice(0, 500), source, detail);

    const pat = upsertPattern({ script, launcher: result.launcher, kind: result.kind, chain: result.chain });

    let notification = null;
    let notified = false;
    if (SEVERITY_BY_KIND[result.kind]) {
      notification = upsertNotification({
        script,
        launcher: result.launcher,
        kind: result.kind,
        detail: `${detail} · pid ${pid} · user ${userName(uid) || uid} · chain: ${describeChain(result.chain).slice(0, 300)}`,
      });
      notified = maybeNotify(pat.row);
    }
    return { ok: true, launcher: result.launcher, kind: result.kind, newPattern: pat.created, notification, notified };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

// ─── Spectral-residual volume anomaly (Microsoft SR-CNN pattern) ───────────
function fft(re, im, invert) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (invert ? 2 : -2) * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < half; j++) {
        const ur = re[i + j], ui = im[i + j];
        const vr = re[i + j + half] * cr - im[i + j + half] * ci;
        const vi = re[i + j + half] * ci + im[i + j + half] * cr;
        re[i + j] = ur + vr; im[i + j] = ui + vi;
        re[i + j + half] = ur - vr; im[i + j + half] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
  if (invert) { for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; } }
}

/** Spectral residual saliency per point, as in Microsoft's SR detector. */
function spectralSaliency(series) {
  const n = series.length;
  let N = 1;
  while (N < n) N <<= 1;
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let i = 0; i < n; i++) re[i] = Number(series[i]) || 0;
  fft(re, im, false);
  const logAmp = new Float64Array(N);
  const phase = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    logAmp[i] = Math.log(Math.hypot(re[i], im[i]) + 1e-8);
    phase[i] = Math.atan2(im[i], re[i]);
  }
  for (let i = 0; i < N; i++) {
    const prev = logAmp[(i - 1 + N) % N];
    const next = logAmp[(i + 1) % N];
    const avg = (prev + logAmp[i] + next) / 3; // 3-point average filter
    const mag = Math.exp(logAmp[i] - avg);
    re[i] = mag * Math.cos(phase[i]);
    im[i] = mag * Math.sin(phase[i]);
  }
  fft(re, im, true);
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.abs(re[i]);
  return out;
}

function meanStd(values) {
  const n = values.length || 1;
  let sum = 0;
  for (const v of values) sum += v;
  const mean = sum / n;
  let sq = 0;
  for (const v of values) sq += (v - mean) * (v - mean);
  return { mean, std: Math.sqrt(sq / n) };
}

/**
 * Hourly invocation counts for one script over the last `hours` hours,
 * oldest → newest (the newest bucket is the current hour).
 */
function hourlyCounts(script, hours) {
  const db = ensureTables();
  const rows = db.prepare(`SELECT strftime('%Y-%m-%dT%H', created_at) AS hour, COUNT(*) AS n
                             FROM cli_invocations
                            WHERE script = ? AND created_at >= ?
                            GROUP BY hour`).all(script, new Date(Date.now() - hours * 3600_000).toISOString());
  const byHour = new Map(rows.map((r) => [r.hour, r.n]));
  const series = [];
  for (let i = hours - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 3600_000);
    const key = d.toISOString().slice(0, 13);
    series.push(byHour.get(key) || 0);
  }
  return series;
}

function detectVolumeAnomalies() {
  const db = ensureTables();
  const findings = [];
  const HOURS = 48;
  for (const [script] of OUR_SCRIPTS) {
    let series;
    try { series = hourlyCounts(script, HOURS); } catch (_) { continue; }
    const total = series.reduce((a, b) => a + b, 0);
    const latest = series[series.length - 1] || 0;
    // SR on sparse series is noise: require real volume and a real burst.
    if (total < 12 || latest < 5) continue;
    const sal = spectralSaliency(series);
    const rest = sal.slice(0, -1);
    const { mean, std } = meanStd(rest);
    const last = sal[sal.length - 1];
    const z = std > 0 ? (last - mean) / std : 0;
    if (z >= 4) {
      const key = `cli-volume|${script}|${new Date().toISOString().slice(0, 13)}`;
      const detail = `${latest} runs of ${script} in the last hour vs a ${HOURS}h baseline (SR z=${z.toFixed(1)}).`;
      const existing = db.prepare('SELECT id FROM security_notifications WHERE key = ?').get(key);
      if (!existing) {
        db.prepare(`INSERT INTO security_notifications
            (id, key, severity, category, title, detail, scan_count, first_seen, last_seen)
            VALUES (?, ?, 'warning', 'cli-volume', ?, ?, 1, ?, ?)`)
          .run(crypto.randomUUID(), key, `Run-volume anomaly on "${script}"`, detail.slice(0, 400), nowIso(), nowIso());
      }
      findings.push({ script, hour: new Date().toISOString().slice(0, 13), count: latest, z: Number(z.toFixed(1)), detail });
    }
  }
  return findings;
}

// ─── Process scan ──────────────────────────────────────────────────────────
function matchScript(argv) {
  for (const [id, , test] of OUR_SCRIPTS) {
    if (test(argv)) return id;
  }
  return null;
}

function scanProcesses() {
  let pids = [];
  try { pids = fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p)); } catch (_) { return 0; }
  let seen = 0;
  for (const pidText of pids) {
    const pid = Number(pidText);
    if (pid === process.pid) continue;
    const info = readProc(pid);
    if (!info) continue;
    const script = matchScript(info.argv);
    if (!script) continue;
    seen += 1;
    reportInvocation({ script, pid, source: 'scanner' });
  }
  return seen;
}

/**
 * Retry any alert that was raised but not delivered (for example by the CLI
 * hook, which has no bot fleet). Runs inside the server, where Telegram is live.
 */
function flushDueNotifications() {
  const db = ensureTables();
  let due = 0;
  try {
    const rows = db.prepare(`SELECT * FROM cli_guard_patterns
                               WHERE kind IN ('foreign', 'unknown', 'ssh')
                               ORDER BY last_seen DESC LIMIT 10`).all();
    for (const row of rows) { if (maybeNotify(row)) due += 1; }
  } catch (_) { /* patterns table is new */ }
  return due;
}

function runScan(reason = 'timer') {
  const db = ensureTables();
  const info = readProc(process.pid);
  const self = info
    ? classify(info)
    : { launcher: 'unknown:unreadable', kind: 'unknown', evidence: 'server process unreadable', chain: [] };
  const seen = scanProcesses();
  const anomalies = detectVolumeAnomalies();
  const notified = flushDueNotifications();
  const data = loadData();
  const kept = [...anomalies, ...data.anomalies].slice(0, 20);
  saveData({
    scans: data.scans + 1,
    lastScanAt: nowIso(),
    anomalies: kept,
    serverLauncher: self.launcher,
    serverKind: self.kind,
    lastReason: reason,
    lastSeenProcesses: seen,
    pendingNotifications: notified,
  });
  return { seen, anomalies: anomalies.length, notified, server: self.launcher };
}

// ─── View for the dashboard ────────────────────────────────────────────────
function countByKind(sinceHours = 24) {
  const db = ensureTables();
  const since = new Date(Date.now() - sinceHours * 3600_000).toISOString();
  const counts = { ours: 0, shell: 0, ssh: 0, service: 0, unknown: 0, foreign: 0 };
  try {
    for (const row of db.prepare('SELECT kind, COUNT(*) AS n FROM cli_invocations WHERE created_at >= ? GROUP BY kind').all(since)) {
      if (counts[row.kind] !== undefined) counts[row.kind] = row.n;
    }
  } catch (_) { /* table is new */ }
  return counts;
}

function getCliGuardView() {
  const db = ensureTables();
  const row = getStateRow();
  const data = loadData();
  const counts = countByKind(24);
  const total24h = Object.values(counts).reduce((a, b) => a + b, 0);
  const patterns = db.prepare(`SELECT script, launcher, kind, status, occurrences, first_seen, last_seen, last_notified_at
                                 FROM cli_guard_patterns ORDER BY last_seen DESC LIMIT 30`).all();
  const recent = db.prepare(`SELECT created_at, script, launcher, kind, pid, user, source, detail
                               FROM cli_invocations ORDER BY id DESC LIMIT 25`).all();
  const alerts = db.prepare(`SELECT id, key, severity, title, detail, scan_count, first_seen, last_seen
                               FROM security_notifications
                              WHERE acknowledged = 0 AND category IN ('cli-provenance', 'cli-volume')
                              ORDER BY last_seen DESC LIMIT 20`).all();
  const totalAll = db.prepare('SELECT COUNT(*) AS n FROM cli_invocations').get().n || 0;
  return {
    enabled: !isHardOff(),
    hardOff: isHardOff(),
    intervalMs: SCAN_INTERVAL_MS,
    lastScanAt: row.last_scan_at || null,
    scans: data.scans,
    learning: patterns.length === 0,
    scripts: OUR_SCRIPTS.map(([id, label]) => ({ id, label })),
    counts24h: counts,
    total24h,
    foreign24h: counts.foreign || 0,
    totalAll,
    serverLauncher: data.serverLauncher || null,
    patterns,
    recent,
    anomalies: (data.anomalies || []).slice(0, 10),
    alerts,
  };
}

// ─── Scheduler ─────────────────────────────────────────────────────────────
let timer = null;

function startCliGuard() {
  if (timer) return;
  if (isHardOff()) {
    console.log('[cli-guard] disabled by HK_CLI_GUARD=off');
    return;
  }
  try { runScan('startup'); } catch (e) { console.warn('[cli-guard] startup scan failed:', e.message); }
  timer = setInterval(() => {
    try {
      runScan('timer');
    } catch (e) {
      console.warn('[cli-guard] scan failed:', e && e.message ? e.message : e);
    }
  }, SCAN_INTERVAL_MS);
  console.log(`[cli-guard] watching our CLIs every ${SCAN_INTERVAL_MS / 1000}s; foreign launchers alert the owner`);
}

module.exports = {
  SCAN_INTERVAL_MS,
  OUR_SCRIPTS,
  reportInvocation,
  getCliGuardView,
  runScan,
  scanProcesses,
  classify,
  spectralSaliency,
  detectVolumeAnomalies,
  startCliGuard,
  isHardOff,
  ensureTables,
};
