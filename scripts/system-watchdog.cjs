#!/usr/bin/env node
'use strict';
// haksterAi System-Check Watchdog
// Polls the haksterAi server health endpoint + system resources and
// auto-restarts the PM2 process if it's unhealthy or burning resources.
// Runs as its own PM2 process (hakster-watchdog) so it survives server crashes.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const HOST = process.env.HAKSTER_HOST || 'http://127.0.0.1:3579';
const PM2_NAME = process.env.WATCHDOG_PM2_NAME || 'haksterAi';
const INTERVAL_MS = parseInt(process.env.WATCHDOG_INTERVAL_MS || '15000', 10);
const FAIL_THRESHOLD = parseInt(process.env.WATCHDOG_FAIL_THRESHOLD || '3', 10);
const DISK_PCT = parseInt(process.env.WATCHDOG_DISK_PCT || '95', 10);
const MEM_PCT = parseInt(process.env.WATCHDOG_MEM_PCT || '95', 10);
const LOG = path.join(__dirname, '..', 'data', 'system-watchdog.log');

let _failStreak = 0;
let _lastRestart = 0;
const RESTART_COOLDOWN_MS = 60000; // don't hammer restarts

function ts() { return new Date().toISOString(); }
function log(line) {
  const entry = `[${ts()}] ${line}`;
  console.log(entry);
  try { fs.appendFileSync(LOG, entry + '\n'); } catch (_) {}
}

function pm2(args) {
  try { return execSync(`pm2 ${args}`, { encoding: 'utf-8', timeout: 15000 }); }
  catch (e) { return (e.stdout || '') + (e.stderr || ''); }
}

function pm2Online() {
  try {
    const out = execSync('pm2 jlist', { encoding: 'utf-8', timeout: 10000 });
    const list = JSON.parse(out || '[]');
    const p = list.find(x => x.name === PM2_NAME);
    return !!(p && p.pm2_env && p.pm2_env.status === 'online');
  } catch (_) { return false; }
}

function checkHealth() {
  return new Promise((resolve) => {
    const url = new URL('/api/health', HOST);
    const req = http.request({ hostname: url.hostname, port: url.port, path: url.pathname, method: 'GET', timeout: 6000 }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const j = JSON.parse(body);
            resolve({ ok: j.status === 'ok', status: res.statusCode, detail: j });
          } catch (_) { resolve({ ok: false, status: res.statusCode, detail: 'bad json' }); }
        } else {
          resolve({ ok: false, status: res.statusCode, detail: body.slice(0, 200) });
        }
      });
    });
    req.on('error', e => resolve({ ok: false, status: 0, detail: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, detail: 'timeout' }); });
    req.end();
  });
}

const REPO_ROOT = path.join(__dirname, '..');
let _tickCount = 0;
let _lastKnownHead = '';
function repoFreshnessReport() {
  log('── Repository & docs freshness ──');
  try {
    const gl = execSync('git -C "' + REPO_ROOT + '" log --oneline -3 2>/dev/null', { encoding: 'utf-8', timeout: 5000 }).trim();
    log('Recent commits:'); (gl || '(none)').split('\n').forEach(l => l && log('  ' + l));
    const gs = execSync('git -C "' + REPO_ROOT + '" status --short 2>/dev/null', { encoding: 'utf-8', timeout: 5000 }).trim();
    const n = gs ? gs.split('\n').filter(Boolean).length : 0;
    log('Working tree: ' + (n ? n + ' uncommitted change(s)' : 'clean'));
    if (gs) gs.split('\n').slice(0, 6).forEach(l => l && log('  ' + l));
  } catch (e) { log('  git log/status unavailable: ' + e.message); }
  try {
    const mds = execSync('find "' + REPO_ROOT + '" -maxdepth 3 -name "*.md" -not -path "*/node_modules/*" -not -path "*/.git/*" -printf "%TY-%Tm-%Td %p\n" 2>/dev/null | sort -r | head -5', { encoding: 'utf-8', timeout: 6000 }).trim();
    log('Recently touched docs (.md):'); (mds || '(none)').split('\n').forEach(l => { if (l) { const sp = l.indexOf(' '); const d = l.slice(0, sp), f = l.slice(sp + 1).replace(REPO_ROOT + '/', ''); log('  ' + d + '  ' + f); } });
  } catch (e) { log('  docs scan unavailable: ' + e.message); }
}
// Periodic: fetch upstream + report any NEW commits since last check (latest docs/commits).
function checkForNewCommits() {
  try {
    execSync('git -C "' + REPO_ROOT + '" fetch --quiet --all 2>/dev/null', { encoding: 'utf-8', timeout: 15000 });
    const head = execSync('git -C "' + REPO_ROOT + '" rev-parse --short HEAD 2>/dev/null', { encoding: 'utf-8', timeout: 5000 }).trim();
    if (_lastKnownHead && _lastKnownHead !== head) {
      const newLog = execSync('git -C "' + REPO_ROOT + '" log --oneline ' + _lastKnownHead + '..HEAD 2>/dev/null', { encoding: 'utf-8', timeout: 5000 }).trim();
      log('📦 NEW commits detected:'); (newLog || '(none)').split('\n').forEach(l => l && log('  ' + l));
    }
    _lastKnownHead = head;
    // behind upstream?
    const behind = execSync('git -C "' + REPO_ROOT + '" rev-list --count HEAD..@{u} 2>/dev/null', { encoding: 'utf-8', timeout: 5000 }).trim();
    if (behind && parseInt(behind, 10) > 0) log('⬆️ ' + behind + ' commit(s) behind upstream — `git pull` to update (docs/specs/agent code).');
  } catch (_) { /* no upstream / offline — non-fatal */ }
}

function systemStats() {
  const stats = {};
  try {
    // Disk usage of root
    const df = execSync("df -P / | tail -1 | awk '{print $5}'", { encoding: 'utf-8', timeout: 5000 }).trim();
    stats.diskPct = parseInt(df, 10);
  } catch (_) { stats.diskPct = -1; }
  try {
    // Memory usage %
    const free = execSync("free | awk '/Mem:/ {printf \"%d\", $3/$2*100}'", { encoding: 'utf-8', timeout: 5000 }).trim();
    stats.memPct = parseInt(free, 10);
  } catch (_) { stats.memPct = -1; }
  try { stats.load = require('os').loadavg()[0]; } catch (_) { stats.load = -1; }
  return stats;
}

function restart(reason) {
  const now = Date.now();
  if (now - _lastRestart < RESTART_COOLDOWN_MS) {
    log(`⏳ restart skipped (cooldown) — reason: ${reason}`);
    return;
  }
  _lastRestart = now;

  // ── Crash-loop auto-fix: if the fail streak hit the threshold, rebuild native
  //    modules BEFORE restarting to break the loop. The #1 crash cause is
  //    better-sqlite3 NODE_MODULE_VERSION mismatch after a node upgrade.
  if (_failStreak >= FAIL_THRESHOLD) {
    log('🔧 Crash-loop detected (' + _failStreak + ' failures) — auto-rebuilding native modules...');
    try { execSync('npm rebuild better-sqlite3 sharp --quiet', { encoding: 'utf-8', timeout: 120000, cwd: path.join(__dirname, '..', 'server') }); log('✓ Native modules rebuilt in server/'); } catch (e) { log('✗ server rebuild failed: ' + e.message); }
    try { execSync('npm rebuild sharp --quiet', { encoding: 'utf-8', timeout: 120000, cwd: path.join(__dirname, '..') }); log('✓ sharp rebuilt in root'); } catch (e) { log('✗ root rebuild failed: ' + e.message); }
  }

  log(`🔄 RESTARTING ${PM2_NAME} — reason: ${reason}`);
  pm2(`restart ${PM2_NAME}`);  // NO --update-env (causes node version switch → crash loop)
  _failStreak = 0;
}

async function tick() {
  if ((++_tickCount) % 20 === 0) checkForNewCommits();  // latest commits/docs check ~every 5min
  const pm2Up = pm2Online();
  const health = await checkHealth();
  const stats = systemStats();
  const ok = pm2Up && health.ok;
  if (!ok) {
    _failStreak++;
    log(`✗ unhealthy (${_failStreak}/${FAIL_THRESHOLD}) — pm2Online=${pm2Up} health=${health.status} ${health.detail} disk=${stats.diskPct}% mem=${stats.memPct}%`);
    if (_failStreak >= FAIL_THRESHOLD) restart(`health failed ${_failStreak}x (pm2Online=${pm2Up}, http=${health.status})`);
  } else {
    if (_failStreak > 0) log(`✓ recovered after ${_failStreak} fail(s)`);
    _failStreak = 0;
    // Resource-based restarts (don't count toward health streak)
    if (stats.diskPct >= DISK_PCT) log(`⚠ disk ${stats.diskPct}% >= ${DISK_PCT}% — no auto-restart, needs cleanup`);
    if (stats.memPct >= MEM_PCT) restart(`memory ${stats.memPct}% >= ${MEM_PCT}%`);
  }
}

// ── Auto-debugger: full startup debug report (runs once on boot) ──
async function debugReport() {
  log('══════ STARTUP DEBUG REPORT ══════');
  // PM2 processes
  try {
    const list = JSON.parse(execSync('pm2 jlist', { encoding: 'utf-8', timeout: 10000 }) || '[]');
    log(`PM2 processes (${list.length}):`);
    for (const p of list) log(`  • ${p.name} — ${(p.pm2_env && p.pm2_env.status) || '?'} (pid=${p.pid}, restarts=${(p.pm2_env && p.pm2_env.restart_time) || 0})`);
  } catch (e) { log(`  PM2 list unavailable: ${e.message}`); }
  // Listening ports
  try {
    const ports = execSync("ss -ltn 2>/dev/null | awk 'NR>1 {print $4}' | sed 's/.*://' | sort -un | tr '\n' ' '", { encoding: 'utf-8', timeout: 5000 }).trim();
    log(`Listening ports: ${ports || '(none)'}`);
  } catch (e) { log(`  ports unavailable: ${e.message}`); }
  // System stats
  const stats = systemStats();
  let up = ''; try { up = execSync('uptime -p 2>/dev/null || uptime', { encoding: 'utf-8', timeout: 5000 }).trim(); } catch (_) {}
  log(`System: disk=${stats.diskPct}% mem=${stats.memPct}% load=${stats.load} | ${up}`);
  // haksterAi health
  try {
    const h = await checkHealth();
    const det = typeof h.detail === 'string' ? h.detail : JSON.stringify(h.detail).slice(0, 140);
    log(`haksterAi health: ${h.ok ? 'OK' : 'FAIL'} (http=${h.status}) ${det}`);
  } catch (e) { log(`haksterAi health: ERROR ${e.message}`); }
  // Agent process (in-process CLI)
  try {
    const ag = execSync("pgrep -af 'server/src/agent/index.js' 2>/dev/null | grep -v pgrep", { encoding: 'utf-8', timeout: 5000 }).trim();
    log(`Agent process: ${ag ? ag.split('\n').join(' | ') : 'NOT RUNNING'}`);
  } catch (_) { log('Agent process: NOT RUNNING'); }
  // Critical file integrity
  const root = path.join(__dirname, '..');
  const crit = ['AGENTS.md','package.json','server/src/agent/index.js','server/src/index.js','cli/index.js','cli/memory.js','server/hakster-config.json','scripts/hakster-guardrails.sh','.env'];
  const missing = crit.filter(f => { try { return !fs.existsSync(path.join(root, f)); } catch { return true; } });
  log(`Critical files: ${crit.length - missing.length}/${crit.length} present${missing.length ? ' — MISSING: ' + missing.join(', ') : ' ✓'}`);
  // Guardrails state
  try {
    const hf = path.join(process.env.HOME || '/root', '.hakster', 'cmd_history.log');
    if (fs.existsSync(hf)) log(`Guardrails history: ${fs.readFileSync(hf, 'utf-8').split('\n').filter(Boolean).length} tracked cmds`);
    else log('Guardrails history: (empty / reset)');
    const lf = path.join(process.env.HOME || '/root', '.hakster', 'loop_count');
    if (fs.existsSync(lf)) log(`Guardrails loop flag: ${fs.readFileSync(lf, 'utf-8').trim()}`);
  } catch (_) {}
  // Recent watchdog log tail
  try {
    if (fs.existsSync(LOG)) {
      const tail = fs.readFileSync(LOG, 'utf-8').split('\n').filter(Boolean).slice(-3).join(' | ');
      log(`Recent watchdog log: ${tail}`);
    }
  } catch (_) {}
  repoFreshnessReport();
  log('══════ END DEBUG REPORT ══════');
}

log(`🐕 system-watchdog started — target=${HOST} pm2=${PM2_NAME} interval=${INTERVAL_MS}ms failThreshold=${FAIL_THRESHOLD}`);
try { _lastKnownHead = execSync('git -C "' + REPO_ROOT + '" rev-parse --short HEAD 2>/dev/null', { encoding: 'utf-8', timeout: 5000 }).trim(); } catch (_) {}
debugReport();
setInterval(tick, INTERVAL_MS);
tick();
