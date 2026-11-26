/* Smartness + autolearn meters and the services/ports inventory, ported from
 * the old CLI (server/src/agent/index.js). The rules are the same ones that
 * file uses: a 0–100 smartness score that moves on real per-tool outcomes,
 * unbounded session points, and a fixed list of expected services checked
 * against live listening ports.
 *
 * The Ink TUI (`hakster ui`) is a separate process from the old REPL, so it
 * feeds these meters from the events it actually receives and seeds the score
 * from the last old-CLI session in ~/.hakster/perf_history.json. Nothing here
 * invents a number: with no events the bars sit at the seed, and when the
 * platform's own port tool cannot run the services line says "scan unavailable"
 * and names the tool (src/listening-ports.js picks ss / netstat per platform).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import homeDirPkg from './src/home-dir.js';
import { fileURLToPath } from 'node:url';
import listeningPorts from './src/listening-ports.js';

// cli/ — this file and both TUI bundles (ui.mjs, ui-fb.mjs) live here, so the
// repository root is one level up however this module was loaded.
const CLI_DIR = path.dirname(fileURLToPath(import.meta.url));

// Same list and ports as the old CLI's ONLINE PORTS panel.
export const EXPECTED_SERVICES = [
  { port: 3579, name: 'HAKSTER-AI', proto: 'http' },
  { port: 8081, name: 'cinevault', proto: 'http' },
  { port: 4000, name: 'phantom', proto: 'http' },
  { port: 8082, name: 'claude-proxy', proto: 'http' },
  { port: 5555, name: 'miniforge', proto: 'http' },
];

const DEFAULT_SCORE = 98;

// How far back the header's ◈ memory-bar health ratio looks. It is a window of
// real metered actions, not a timer: the ratio moves because work happened, and
// it falls back to the smartness score once the window is empty (owner,
// 2026-11-25: "the mem bar up top in right tui add heath ratio green red for bad
// good slipping getting smarter by the sec").
const HEALTH_WINDOW_MS = 90000;

// recentSmartnessAnchor() from the old CLI: the most recent session's end/peak
// score, floored at 50. Missing/unreadable history falls back to the default.
export function anchorScore() {
  try {
    const file = path.join(homeDirPkg.haksterDir(), 'perf_history.json');
    const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
    const last = Array.isArray(rows) ? rows[rows.length - 1] : null;
    const n = Number(last && (last.smartnessEnd ?? last.smartnessPeak));
    if (!Number.isFinite(n)) return DEFAULT_SCORE;
    return Math.max(50, Math.min(100, Math.round(n)));
  } catch {
    return DEFAULT_SCORE;
  }
}

// Last session's autolearn point total. The old CLI resumed the meter from
// here (server/src/agent/index.js: `_sessionPerf.points = Math.max(_smartScore,
// lastPts)`) so points are cumulative across launches; the TUI used to start at
// 0, which made the ✦ autolearn figure look reset every time — learning that had
// already happened read as lost (owner, 2026-11-25: "make sure autolearn meter
// with brain emoji is working with learning etc"). `file` is injectable so a
// test can read a fixture instead of the operator's real history.
export function anchorPoints(file = path.join(homeDirPkg.haksterDir(), 'perf_history.json')) {
  try {
    const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
    const last = Array.isArray(rows) ? rows[rows.length - 1] : null;
    const n = Number(last && last.points);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
  } catch {
    return 0;
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
  const seed = anchorScore();
  const meter = {
    score: seed,
    delta: 0,
    // The last movement of the point total, BEFORE the score's 0–100 clamp is
    // applied. `delta` is the score's change and pins at 0 once the score sits
    // at 100 or 0 — so it cannot tell an up-move from a down-move any more,
    // even though points keep climbing (owner, 2026-11-24: "make sure the
    // autolearn points have the up down when points go up or down"). The
    // autolearn arrow reads this, the smartness arrow keeps reading `delta`.
    pointsDelta: 0,
    // Cumulative, like the old CLI: resume from the last session's total so the
    // ✦ autolearn meter reflects what has already been learned, not a zero.
    points: Math.max(seed, anchorPoints()),
    rounds: 0,
    successes: 0,
    failures: 0,
    peak: 0,
    // Recent actions for the health ratio: one row per metered tool call, with
    // whether it worked and what it moved. Pruned on read, so it can never grow
    // past a few hundred entries even in a very long session.
    recent: [],
  };
  meter.peak = meter.score;
  const apply = (d) => {
    if (!Number.isFinite(d) || d === 0) return 0;
    const before = meter.score;
    meter.score = Math.max(0, Math.min(100, meter.score + d));
    meter.delta = meter.score - before;
    meter.pointsDelta = d;
    meter.points += d;
    if (meter.score > meter.peak) meter.peak = meter.score;
    return meter.delta;
  };
  // A tool call with its reported outcome. `ok === false` is the same test the
  // server uses to tag a result as an error.
  meter.tool = (name, args, ok, out) => {
    if (ok) meter.successes++; else meter.failures++;
    meter.rounds += 1; // one metered action — the snapshot's `rounds` is a real count
    const d = scoreToolCall(name, args, ok, out);
    const delta = apply(d);
    meter.recent.push({ at: Date.now(), ok: !!ok, d });
    if (meter.recent.length > 400) meter.recent.splice(0, meter.recent.length - 400);
    return delta;
  };
  // A named event (loop detected, turn finished, …) worth the same kind of delta.
  meter.bump = (d) => apply(d);
  meter.resetTask = () => { meter.rounds = 0; meter.delta = 0; meter.pointsDelta = 0; };
  // The header health readout, measured: the share of recent actions that
  // worked, and where the last window's movement points. With no recent actions
  // it reports the smartness score and a steady trend — never an invented one.
  meter.health = () => {
    const now = Date.now();
    const win = meter.recent.filter((e) => now - e.at <= HEALTH_WINDOW_MS);
    if (!win.length) return { pct: meter.score, trend: 'steady', samples: 0 };
    const good = win.filter((e) => e.ok).length;
    const sum = win.reduce((n, e) => n + (Number(e.d) || 0), 0);
    return {
      pct: Math.max(0, Math.min(100, Math.round((good / win.length) * 100))),
      trend: sum > 0 ? 'smarter' : sum < 0 ? 'slipping' : 'steady',
      samples: win.length,
    };
  };
  meter.snapshot = () => ({
    score: meter.score,
    delta: meter.delta,
    pointsDelta: meter.pointsDelta,
    points: meter.points,
    rounds: meter.rounds,
    successes: meter.successes,
    failures: meter.failures,
    peak: meter.peak,
    health: meter.health(),
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

// The autolearn percentage, on exactly the scale the points bar draws: the
// 0–100 display ceiling, never the raw total (so 150p reads 100%). Same value
// as barCells(points, 100) fills, so the number and the bar can never disagree.
export function pointsPct(points) {
  const n = Number(points) || 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

// ▲ up / ▼ down / ◆ unchanged, for either meter's last movement. One helper so
// the header, the status row and the dashboard can never drift apart.
export function meterArrow(delta) {
  const d = Number(delta) || 0;
  return d > 0 ? '▲' : d < 0 ? '▼' : '◆';
}

// The colour that pairs with meterArrow.
export function arrowColor(delta) {
  const d = Number(delta) || 0;
  return d > 0 ? 'green' : d < 0 ? 'red' : 'gray';
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

// Listening ports once, bounded — the platform's own tool, through
// src/listening-ports.js (linux `ss`, Windows `netstat -ano`, macOS
// `netstat -an -p tcp`). Owner, 2026-11-26 (Windows Surface Pro): "says scan
// unavailable ss not readable" — the scanner used to be Linux-only, so the
// panel was honest and the machine was Windows. Returns
// `{ ok, ports, procs, backend, reason?, at }`; a missing tool is
// `ok: false` with `reason: '<tool>-not-installed'`, never a fake reading.
export function scanPorts(timeoutMs = 4000) {
  return listeningPorts.scanPorts(timeoutMs);
}

// The tool the current platform scans with — so a service line can name it.
export function scanBackend() {
  return listeningPorts.backendFor();
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

// Files every published CLI package ships — the tarball carries `cli/` only,
// so the 13 project files above cannot exist in a package install. Counting
// them there read as lost work (owner, 2026-11-26: "hakster made some files
// missing says 2/13 fix on dell"): a package install legitimately has
// cli/index.js and cli/memory.js only, i.e. "2/13 files". This list is the
// install's own guard — same count, the files that are really shipped.
export const INSTALL_FILES = [
  'cli/index.js',
  'cli/ui-fb.mjs',
  'cli/tui-entry.mjs',
  'cli/smartness.mjs',
  'cli/tools.js',
  'cli/memory.js',
  'cli/providers.js',
  'cli/package.json',
  'cli/ui.mjs',
  'cli/src/updater.js',
  'cli/src/prefs.js',
  'cli/src/listening-ports.js',
  'cli/src/home-dir.js',
  'cli/src/models/ladder.js',
  'cli/src/self-config-guard.js',
];

// The source tree this copy lives in, if it lives in one: the nearest ancestor
// that is a real repo (`AGENTS.md`/`.git`) carrying the server's agent loop. A
// package install, a deploy slot or a staged update has no such ancestor —
// that is exactly why its "missing" files were never missing.
function findProjectTree(start) {
  let dir = start;
  for (let i = 0; i < 6; i += 1) {
    try {
      const isRepo = fs.existsSync(path.join(dir, 'AGENTS.md')) || fs.existsSync(path.join(dir, '.git'));
      if (isRepo && fs.existsSync(path.join(dir, 'server', 'src', 'agent', 'index.js'))) return dir;
    } catch { /* keep walking */ }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

function countFiles(root, list, mode) {
  const present = [];
  const missing = [];
  for (const rel of list) {
    try {
      if (fs.existsSync(path.join(root, rel))) present.push(rel);
      else missing.push(rel);
    } catch {
      missing.push(rel);
    }
  }
  return { present: present.length, total: list.length, missing, mode, root };
}

// Check the files against `root` (default: the source tree this copy lives in,
// else the package it is). Read-only — existsSync only; nothing is created,
// repaired or deleted here.
export function fileGuard(root) {
  if (root) return countFiles(root, IMPORTANT_FILES, 'project');
  const project = findProjectTree(CLI_DIR);
  if (project) return countFiles(project, IMPORTANT_FILES, 'project');
  return countFiles(path.resolve(CLI_DIR, '..'), INSTALL_FILES, 'install');
}

// A short human label for a listening port that is not a known service: the
// command's first word, clipped, or "listening" when `ss` could not name it.
export function portLabel(entry, max = 14) {
  const proc = String((entry && entry.proc) || '').split(/\s+/)[0];
  const text = proc || 'listening';
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;
}
