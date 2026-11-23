/* Smartness + autolearn meters and the services/ports inventory, ported from
 * the old CLI (server/src/agent/index.js). The rules are the same ones that
 * file uses: a 0–100 smartness score that moves on real per-tool outcomes,
 * unbounded session points, and a fixed list of expected services checked
 * against live listening ports.
 *
 * The Ink TUI (`hakster ui`) is a separate process from the old REPL, so it
 * feeds these meters from the events it actually receives and seeds the score
 * from the last old-CLI session in ~/.hakster/perf_history.json. Nothing here
 * invents a number: with no events the bars sit at the seed, and with no `ss`
 * output the services line says "scan unavailable".
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

// cli/ — this file and both TUI bundles (ui.mjs, ui-fb.mjs) live here, so the
// repository root is one level up however this module was loaded.
const CLI_DIR = path.dirname(fileURLToPath(import.meta.url));

// Same list and ports as the old CLI's ONLINE PORTS panel.
export const EXPECTED_SERVICES = [
  { port: 3579, name: 'haksterAi', proto: 'http' },
  { port: 8081, name: 'cinevault', proto: 'http' },
  { port: 4000, name: 'phantom', proto: 'http' },
  { port: 8082, name: 'claude-proxy', proto: 'http' },
  { port: 5555, name: 'miniforge', proto: 'http' },
];

const DEFAULT_SCORE = 98;

// recentSmartnessAnchor() from the old CLI: the most recent session's end/peak
// score, floored at 50. Missing/unreadable history falls back to the default.
export function anchorScore() {
  try {
    const file = path.join(os.homedir(), '.hakster', 'perf_history.json');
    const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
    const last = Array.isArray(rows) ? rows[rows.length - 1] : null;
    const n = Number(last && (last.smartnessEnd ?? last.smartnessPeak));
    if (!Number.isFinite(n)) return DEFAULT_SCORE;
    return Math.max(50, Math.min(100, Math.round(n)));
  } catch {
    return DEFAULT_SCORE;
  }
}

// scoreToolCall() from the old CLI, kept to the outcome rules that the stream
// exposes: failures cost, known error signatures cost more, destructive file
// commands cost hardest, a successful action earns a little, and successful
// writes earn in proportion to how much real content they produced.
export function scoreToolCall(name, args, ok, out) {
  const cmd = String((args && args.command) || '');
  const o = String(out || '').toLowerCase();
  let d = 0;
  if (ok === false) {
    d -= 5;
    if (/(eaddrinuse|err_dlopen_failed|npm error|syntaxerror|cannot find module|enoent|eacces|permission denied|module not found)/.test(o)) d -= 5;
  }
  if (/\brm\s+-[rf]/i.test(cmd) || /\bgit\s+(reset\s+--hard|checkout\s+--|clean)\b/i.test(cmd)) {
    if (/\.(md|json|env|js|ts|astro|sh|py)$|(agents\.md|package\.json|config|\.env)/i.test(cmd)) d -= 10;
    else d -= 5;
  }
  if (ok !== false) {
    if (/(http\/1\.1\s+200|\b200\s+ok\b|\bok\b|rebuilt|\bbuilt\b|success|✓|applied)/.test(o)) d += 2;
    else d += 1;
    if (['write_file', 'patch_file', 'multi_patch', 'edit_file', 'insert_lines', 'replace_regex', 'append_file'].includes(name)) {
      const content = String((args && (args.content || args.patch || args.text || args.new_string)) || '');
      const fp = String((args && (args.path || args.file)) || '');
      const isDataDoc = /\.(md|json|ya?ml|txt|csv|py|js|ts|astro|sh)$/i.test(fp);
      const len = content.length;
      const pts = isDataDoc ? Math.min(10, Math.round(len / 200)) : Math.min(8, Math.round(len / 300));
      d += Math.max(2, pts);
    }
    if (/scrape|firecrawl/i.test(name) || /firecrawl|scrape/.test(cmd)) d += 3;
    if (/\b(npm\s+install|npm\s+rebuild|pip\s+install|chown|chmod|pm2\s+(restart|start))\b/i.test(cmd)) d += 1;
  }
  return Math.max(-12, Math.min(10, d));
}

export function createMeter() {
  const meter = {
    score: anchorScore(),
    delta: 0,
    points: 0,
    rounds: 0,
    successes: 0,
    failures: 0,
    peak: 0,
  };
  meter.peak = meter.score;
  const apply = (d) => {
    if (!Number.isFinite(d) || d === 0) return 0;
    const before = meter.score;
    meter.score = Math.max(0, Math.min(100, meter.score + d));
    meter.delta = meter.score - before;
    meter.points += d;
    if (meter.score > meter.peak) meter.peak = meter.score;
    return meter.delta;
  };
  // A tool call with its reported outcome. `ok === false` is the same test the
  // server uses to tag a result as an error.
  meter.tool = (name, args, ok, out) => {
    if (ok) meter.successes++; else meter.failures++;
    return apply(scoreToolCall(name, args, ok, out));
  };
  // A named event (loop detected, turn finished, …) worth the same kind of delta.
  meter.bump = (d) => apply(d);
  meter.resetTask = () => { meter.rounds = 0; meter.delta = 0; };
  meter.snapshot = () => ({
    score: meter.score,
    delta: meter.delta,
    points: meter.points,
    rounds: meter.rounds,
    successes: meter.successes,
    failures: meter.failures,
    peak: meter.peak,
  });
  return meter;
}

export function smartLabel(score) {
  if (score >= 80) return 'Sharp';
  if (score >= 66) return 'Strong';
  if (score >= 50) return 'Steady';
  if (score >= 33) return 'Slipping';
  return 'Struggling';
}

// Filled/empty cell counts for a bar. Smartness is 0–100; points are clamped
// the same way the old CLI clamps them for display (the number itself stays
// unbounded and is shown in full).
export function barCells(value, total, len = 16) {
  const ratio = total > 0 ? Math.max(0, Math.min(1, value / total)) : 0;
  const filled = Math.round(ratio * len);
  return { filled, empty: Math.max(0, len - filled) };
}

export function barColor(kind, value) {
  if (kind === 'points') {
    if (value >= 150) return '#58a6ff';
    if (value >= 66) return '#3fb950';
    if (value >= 33) return '#d29922';
    return '#f85149';
  }
  if (value >= 66) return '#3fb950';
  if (value >= 33) return '#d29922';
  return '#f85149';
}

// `ss -tlnp` once, bounded. Returns the listening ports and their processes.
export function scanPorts(timeoutMs = 4000) {
  return new Promise((resolve) => {
    execFile('ss', ['-tlnp'], { timeout: timeoutMs, maxBuffer: 1 << 20 }, (err, stdout) => {
      const text = String(stdout || '');
      const ports = new Set();
      const procs = {};
      for (const line of text.split('\n')) {
        const m = line.match(/:([0-9]{2,5})\s+\S+\s+.*users:\(\("([^"]+)"/);
        if (m) { ports.add(Number(m[1])); procs[m[1]] = m[2]; continue; }
        const m2 = line.match(/:([0-9]{2,5})\s+\S+/);
        if (m2) ports.add(Number(m2[1]));
      }
      if (err && !text) return resolve({ ok: false, ports: [], procs: {}, at: Date.now() });
      resolve({ ok: true, ports: [...ports].sort((a, b) => a - b), procs, at: Date.now() });
    });
  });
}

// Expected services with their live state, in the old panel's order.
export function serviceStates(scan) {
  const open = new Set((scan && scan.ports) || []);
  return EXPECTED_SERVICES.map((svc) => ({
    ...svc,
    up: open.has(svc.port),
    proc: (scan && scan.procs && scan.procs[String(svc.port)]) || '',
  }));
}

// Everything else the scan saw listening, so the panel can say "all ports in
// use" instead of only the services this harness knows by name. `proc` is the
// command `ss` reported for the socket, empty when the process is not ours.
export function otherListening(scan) {
  const known = new Set(EXPECTED_SERVICES.map((svc) => svc.port));
  const ports = (scan && scan.ports) || [];
  return ports
    .filter((port) => !known.has(port))
    .map((port) => ({
      port,
      proc: (scan && scan.procs && scan.procs[String(port)]) || '',
    }));
}

// The 13 code files the agent's own integrity check counts (server/src/agent/
// index.js `IMPORTANT_FILES`). The CLI mirrors it read-only so a lost
// guardrails script or brain file is never silent — the same 13/13 the
// Miniforge card shows.
export const IMPORTANT_FILES = [
  'AGENTS.md',
  'package.json',
  'cli/index.js',
  'cli/memory.js',
  'server/src/index.js',
  'server/src/agent/index.js',
  'server/src/agent/loop.js',
  'server/src/agent/autolearn.js',
  'server/hakster-config.json',
  'server/src/hakster-config.json',
  'scripts/hakster-guardrails.sh',
  'HAKSTERAI-PHANTOM-MERGED.md',
  '.env',
];

// Check the list against `root` (default: this repository). Read-only —
// existsSync only; nothing is created, repaired or deleted here.
export function fileGuard(root = path.resolve(CLI_DIR, '..')) {
  const present = [];
  const missing = [];
  for (const rel of IMPORTANT_FILES) {
    try {
      if (fs.existsSync(path.join(root, rel))) present.push(rel);
      else missing.push(rel);
    } catch {
      missing.push(rel);
    }
  }
  return { present: present.length, total: IMPORTANT_FILES.length, missing };
}

// A short human label for a listening port that is not a known service: the
// command's first word, clipped, or "listening" when `ss` could not name it.
export function portLabel(entry, max = 14) {
  const proc = String((entry && entry.proc) || '').split(/\s+/)[0];
  const text = proc || 'listening';
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;
}
