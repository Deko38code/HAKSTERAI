'use strict';
/**
 * Anomaly detector agent (Codex lane) — learns this box's normal patterns.
 *
 * How it works, in order:
 *   1. SAMPLE   — read a small, cheap set of real numbers: load average, CPU
 *                 busy %, RAM used %, swap used %, pm2 processes not online,
 *                 listening ports, SSH failures (24h), IP-guard blocks (24h),
 *                 and the last security sweep's state.
 *   2. LEARN    — every sample is appended to a rolling window (24h at 15 min).
 *                 Each metric gets a mean + standard deviation from that window,
 *                 so "normal" is measured on THIS box, not a fixed guess.
 *   3. DETECT   — a value is anomalous at 3σ from the learned mean (with a
 *                 minimum spread so a quiet metric cannot trip on noise), or on
 *                 a hard floor (e.g. a process that should be online is down).
 *   4. REMEMBER — every anomaly signature is remembered with first/last seen and
 *                 a count. A repeat is reported as a KNOWN PATTERN, not news.
 *                 This is the "learning patterns" part: the detector gets quieter
 *                 about things it has already seen and louder about new ones.
 *   5. EXPLAIN  — only when there is something to explain, the Codex lane reads
 *                 the anomalies + context and writes a short assessment. The
 *                 numeric detection never depends on the model.
 *
 * Read-only: this module never changes a process, service or config. New or
 * changed patterns are pushed to the Telegram recon bot.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SAMPLES_FILE = path.join(DATA_DIR, 'anomaly-samples.json');
const PATTERNS_FILE = path.join(DATA_DIR, 'anomaly-patterns.json');
const STATE_FILE = path.join(DATA_DIR, 'anomaly-state.json');

const SAMPLE_EVERY_MS = 15 * 60 * 1000;   // learning cadence
const WINDOW = 96;                        // samples kept (24h at 15 min)
const MIN_SAMPLES = 8;                    // learn before calling anything odd
const SIGMA = 3;
const MAX_PATTERNS = 120;
const MAX_ANOMALIES_KEPT = 60;

let lastState = null;
let currentRun = null;
let timer = null;
let startedAt = Date.now();

const METRICS = [
  { key: 'load1', label: 'load average (1m)', floorSpread: 0.35, unit: '' },
  { key: 'cpuBusyPct', label: 'CPU busy %', floorSpread: 4, unit: '%' },
  { key: 'memUsedPct', label: 'RAM used %', floorSpread: 3, unit: '%' },
  { key: 'swapUsedPct', label: 'swap used %', floorSpread: 3, unit: '%' },
  { key: 'portsListening', label: 'listening ports', floorSpread: 1, unit: '' },
  { key: 'pm2Down', label: 'pm2 not online', floorSpread: 1, unit: '' },
  { key: 'sshFailures24h', label: 'SSH failures 24h', floorSpread: 3, unit: '' },
  { key: 'ipGuardBlocked24h', label: 'IP-guard blocks 24h', floorSpread: 1, unit: '' },
];

function ensureDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
}

function readJson(file, fallback) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed == null ? fallback : parsed;
  } catch { return fallback; }
}

function writeJson(file, value) {
  ensureDir();
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function round(n, digits = 2) {
  const f = Math.pow(10, digits);
  return Math.round(Number(n || 0) * f) / f;
}

// ── 1) SAMPLE ──────────────────────────────────────────────────────────────
async function sample() {
  const { execFile } = require('child_process');
  const systemSensors = require('./systemSensors');
  const autoAgent = require('./autoAgent');

  const [cpu, mem] = await Promise.all([systemSensors.cpuSnapshot(200), Promise.resolve(systemSensors.memorySnapshot())]);

  let portsListening = null;
  let pm2Down = null;
  try {
    const out = await new Promise((resolve) => {
      execFile('ss', ['-ltnH'], { timeout: 6000, maxBuffer: 2 * 1024 * 1024 }, (err, stdout) => resolve(err ? '' : String(stdout || '')));
    });
    portsListening = out.split('\n').filter((l) => l.trim()).length;
  } catch { portsListening = null; }

  try {
    const out = await new Promise((resolve) => {
      execFile('pm2', ['jlist'], { timeout: 8000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve(err ? '' : String(stdout || '')));
    });
    const list = JSON.parse(out);
    pm2Down = list.filter((p) => (p.pm2_env && p.pm2_env.status) !== 'online').length;
  } catch { pm2Down = null; }

  let securitySweep = null;
  let sshFailures24h = null;
  let ipGuardBlocked24h = null;
  try {
    const state = autoAgent.getState ? autoAgent.getState() : null;
    const latest = (state && (state.last || (state.history && state.history[0]))) || null;
    if (latest && Array.isArray(latest.checks)) {
      securitySweep = latest.state || null;
      const ip = latest.ip || {};
      sshFailures24h = Number.isFinite(Number(ip.failures)) ? Number(ip.failures) : null;
    }
  } catch { /* one line of context, never fatal */ }
  try {
    const db = require('./db').getDb();
    const row = db.prepare("SELECT COUNT(*) AS c FROM ip_guard_events WHERE action = 'blocked' AND created_at > unixepoch() - 86400").get();
    ipGuardBlocked24h = row ? row.c : null;
  } catch { ipGuardBlocked24h = null; }

  const load = require('os').loadavg();
  return {
    at: new Date().toISOString(),
    ts: Math.floor(Date.now() / 1000),
    load1: round(load[0]),
    load5: round(load[1]),
    cpuBusyPct: cpu ? round(cpu.busyPct) : null,
    memUsedPct: mem ? round(mem.usedPct) : null,
    swapUsedPct: mem && mem.swap ? round(mem.swap.usedPct) : null,
    portsListening,
    pm2Down,
    sshFailures24h,
    ipGuardBlocked24h,
    securitySweep,
  };
}

// ── 2) LEARN ───────────────────────────────────────────────────────────────
function statsFor(samples, key) {
  const values = samples.map((s) => s[key]).filter((v) => Number.isFinite(v));
  if (values.length < MIN_SAMPLES) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / values.length;
  return { mean, sd: Math.sqrt(variance), n: values.length, min: Math.min(...values), max: Math.max(...values) };
}

// ── 3) DETECT ──────────────────────────────────────────────────────────────
function detect(sampleRow, history) {
  const anomalies = [];
  for (const metric of METRICS) {
    const value = sampleRow[metric.key];
    if (!Number.isFinite(value)) continue;
    const stats = statsFor(history, metric.key);
    if (!stats) continue;
    const spread = Math.max(stats.sd, metric.floorSpread);
    const z = (value - stats.mean) / spread;
    if (Math.abs(z) >= SIGMA) {
      anomalies.push({
        metric: metric.key,
        label: metric.label,
        value: round(value),
        mean: round(stats.mean),
        sd: round(stats.sd),
        z: round(z),
        direction: z > 0 ? 'high' : 'low',
        message: `${metric.label} ${round(value)} is ${z > 0 ? 'above' : 'below'} the learned normal ${round(stats.mean)} (±${round(spread)})`,
      });
    }
  }
  // Hard floor: a process that should be online is not.
  if (Number.isFinite(sampleRow.pm2Down) && sampleRow.pm2Down > 0) {
    const stats = statsFor(history, 'pm2Down');
    const normal = stats ? stats.mean : 0;
    if (sampleRow.pm2Down > Math.max(0, normal)) {
      anomalies.push({
        metric: 'pm2Down',
        label: 'pm2 not online',
        value: sampleRow.pm2Down,
        mean: stats ? round(stats.mean) : 0,
        sd: stats ? round(stats.sd) : 0,
        z: null,
        direction: 'high',
        message: `${sampleRow.pm2Down} pm2 process(es) not online (learned normal ${stats ? round(stats.mean) : 0})`,
      });
    }
  }
  return anomalies;
}

// ── 4) REMEMBER (patterns) ─────────────────────────────────────────────────
function patternKey(a) {
  return `${a.metric}:${a.direction}`;
}

function learnPatterns(anomalies, store) {
  const patterns = store || { patterns: {} };
  if (!patterns.patterns) patterns.patterns = {};
  const now = new Date().toISOString();
  const results = [];
  for (const a of anomalies) {
    const key = patternKey(a);
    const prev = patterns.patterns[key];
    const entry = prev || {
      key,
      metric: a.metric,
      label: a.label,
      direction: a.direction,
      firstSeen: now,
      count: 0,
      examples: [],
    };
    entry.count += 1;
    entry.lastSeen = now;
    entry.lastValue = a.value;
    entry.lastMessage = a.message;
    entry.examples = [a.message].concat(entry.examples || []).slice(0, 5);
    patterns.patterns[key] = entry;
    results.push({
      key,
      label: a.label,
      known: Boolean(prev),
      timesSeen: entry.count,
      firstSeen: entry.firstSeen,
      message: a.message,
    });
  }
  const keys = Object.keys(patterns.patterns);
  if (keys.length > MAX_PATTERNS) {
    keys.sort((x, y) => String(patterns.patterns[x].lastSeen).localeCompare(String(patterns.patterns[y].lastSeen)));
    for (const k of keys.slice(0, keys.length - MAX_PATTERNS)) delete patterns.patterns[k];
  }
  patterns.updatedAt = now;
  return { store: patterns, results };
}

// ── 5) EXPLAIN (only when there is something to explain) ───────────────────
function explainSystem() {
  return [
    'You are the Codex anomaly analyst for a small production server (haksterai.com; the Dell box).',
    'The detector below compares real samples against this box\'s own learned baseline and has flagged the anomalies listed.',
    'Write a short, plain assessment for the owner.',
    'Rules:',
    '- Use only the numbers given. Never invent metrics, hosts, log lines, CVEs or counts.',
    '- Say whether this looks like a known recurring pattern or a new one, and why.',
    '- Recommend, never execute. Changes needing shell/config/firewall/service work go under FIX NEEDED (OWNER APPROVAL).',
    '- Never suggest killing processes, dropping caches, reinstalling packages, or changing the Cloudflare tunnels.',
    '- No secrets, tokens or private user data. Plain text, no markdown fences, under 150 words.',
    '',
    'Format: one line "ANSWER:", then optionally numbered "FIX NEEDED (OWNER APPROVAL):" (or "none"), then one line "PATTERN:" saying known or new and the evidence.',
  ].join('\n');
}

async function explain(anomalies, sampleRow, learned) {
  const lines = [
    `host: ${require('os').hostname()} · sampled ${sampleRow.at}`,
    `current: load ${sampleRow.load1} · cpu busy ${sampleRow.cpuBusyPct}% · ram ${sampleRow.memUsedPct}% · swap ${sampleRow.swapUsedPct}% · listening ports ${sampleRow.portsListening} · pm2 down ${sampleRow.pm2Down} · ssh failures 24h ${sampleRow.sshFailures24h} · ip-guard blocks 24h ${sampleRow.ipGuardBlocked24h}`,
    '',
    'anomalies:',
    ...anomalies.map((a) => `- ${a.message} [z=${a.z == null ? 'n/a' : a.z}]`),
    '',
    'learned patterns:',
    ...learned.map((p) => `- ${p.label}: ${p.known ? 'known, seen ' + p.timesSeen + 'x since ' + p.firstSeen : 'NEW first sighting'}`),
  ];
  const startedAt = Date.now();
  try {
    const providers = require('./providers');
    const res = await providers.chat({
      provider: 'codex-cli',
      model: process.env.CODEX_CLI_MODEL || 'gpt-6-luna',
      maxTokens: 900,
      system: explainSystem(),
      messages: [{ role: 'user', content: lines.join('\n') }],
    });
    const text = String((res && res.content) || '').replace(/```[a-zA-Z]*\n?/g, '').replace(/`/g, '').trim();
    return { ok: Boolean(text), text: text.slice(0, 3000), ms: Date.now() - startedAt, model: (res && res.model) || 'gpt-6-luna', provider: (res && res.provider) || 'codex-cli', error: text ? '' : 'empty answer' };
  } catch (err) {
    return { ok: false, text: '', ms: Date.now() - startedAt, model: process.env.CODEX_CLI_MODEL || 'gpt-6-luna', provider: 'codex-cli', error: String(err && err.message ? err.message : err).slice(0, 300) };
  }
}

// ── Run ────────────────────────────────────────────────────────────────────
async function doRun({ trigger = 'manual', notify = false } = {}) {
  const started = Date.now();
  const priorSamples = readJson(SAMPLES_FILE, []);
  const history = Array.isArray(priorSamples) ? priorSamples : [];
  const row = await sample();
  const anomalies = detect(row, history);
  const learnedResult = learnPatterns(anomalies, readJson(PATTERNS_FILE, { patterns: {} }));
  writeJson(PATTERNS_FILE, learnedResult.store);

  const nextSamples = [row].concat(history).slice(0, WINDOW);
  writeJson(SAMPLES_FILE, nextSamples);

  let assessment = null;
  if (anomalies.length) {
    assessment = await explain(anomalies, row, learnedResult.results);
  }

  const previous = lastState || readJson(STATE_FILE, null) || {};
  const historyRows = Array.isArray(previous.history) ? previous.history : [];
  const newPatterns = learnedResult.results.filter((p) => !p.known).length;

  const stats = {};
  for (const m of METRICS) {
    const s = statsFor(nextSamples, m.key);
    if (s) stats[m.key] = { mean: round(s.mean), sd: round(s.sd), n: s.n, min: round(s.min), max: round(s.max) };
  }

  const state = {
    running: false,
    trigger,
    sampleEveryMs: SAMPLE_EVERY_MS,
    ranAt: new Date().toISOString(),
    startedAt: new Date(startedAt).toISOString(),
    ms: Date.now() - started,
    baselineSamples: nextSamples.length,
    learning: nextSamples.length < MIN_SAMPLES,
    sample: row,
    stats,
    anomalies: anomalies.slice(0, MAX_ANOMALIES_KEPT),
    learned: learnedResult.results,
    newPatterns,
    assessment,
    patterns: Object.values(learnedResult.store.patterns || {}).sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen))).slice(0, 20),
    history: [{
      ranAt: new Date().toISOString(),
      trigger,
      anomalies: anomalies.length,
      newPatterns,
      state: anomalies.length ? 'watch' : 'clear',
    }].concat(historyRows).slice(0, MAX_ANOMALIES_KEPT),
    readOnly: true,
  };
  writeJson(STATE_FILE, state);
  lastState = state;

  if (notify && (anomalies.length || newPatterns)) {
    try {
      const bots = require('./telegramBots');
      const lines = [
        `anomaly detector · ${anomalies.length} anomaly(ies) · ${newPatterns} new pattern(s)`,
        ...learnedResult.results.slice(0, 6).map((p) => `- ${p.label}: ${p.known ? 'known x' + p.timesSeen : 'NEW'} — ${p.message}`),
      ];
      if (assessment && assessment.ok) lines.push('', assessment.text.slice(0, 1200));
      if (typeof bots.sendReconResult === 'function') await bots.sendReconResult('anomaly detector', lines.join('\n'));
    } catch (err) { console.warn('[anomaly] telegram alert failed:', err.message); }
  }
  return state;
}

async function runAnomalyAgent({ trigger = 'manual', notify = false } = {}) {
  if (currentRun) return { ...(await currentRun), reused: true };
  currentRun = doRun({ trigger, notify }).finally(() => { currentRun = null; });
  return currentRun;
}

function getState() {
  const cached = lastState || readJson(STATE_FILE, null);
  const patterns = Object.values((readJson(PATTERNS_FILE, { patterns: {} }).patterns) || {});
  if (!cached) {
    return {
      running: Boolean(currentRun),
      ranAt: null,
      learning: true,
      baselineSamples: 0,
      sampleEveryMs: SAMPLE_EVERY_MS,
      anomalies: [],
      learned: [],
      newPatterns: 0,
      assessment: null,
      patterns: patterns.slice(0, 20),
      history: [],
    };
  }
  return { ...cached, running: Boolean(currentRun), patterns: (cached.patterns || patterns.slice(0, 20)) };
}

function startAnomalyAgent() {
  if (timer) clearInterval(timer);
  const kick = setTimeout(() => {
    runAnomalyAgent({ trigger: 'startup', notify: false })
      .then((s) => console.log(`  ✓ Anomaly detector sampled: ${s.anomalies.length} anomalies, baseline ${s.baselineSamples}`))
      .catch((e) => console.warn('  ⚠ Anomaly detector startup run failed:', e && e.message));
  }, 120 * 1000);
  if (typeof kick.unref === 'function') kick.unref();
  timer = setInterval(() => {
    runAnomalyAgent({ trigger: 'schedule', notify: true })
      .catch((e) => console.warn('  ⚠ Anomaly detector scheduled run failed:', e && e.message));
  }, SAMPLE_EVERY_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return kick;
}

module.exports = {
  METRICS,
  SAMPLE_EVERY_MS,
  MIN_SAMPLES,
  sample,
  detect,
  learnPatterns,
  explain,
  runAnomalyAgent,
  getState,
  startAnomalyAgent,
};
