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
  log(`🔄 RESTARTING ${PM2_NAME} — reason: ${reason}`);
  pm2(`restart ${PM2_NAME} --update-env`);
  _failStreak = 0;
}

async function tick() {
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

log(`🐕 system-watchdog started — target=${HOST} pm2=${PM2_NAME} interval=${INTERVAL_MS}ms failThreshold=${FAIL_THRESHOLD}`);
setInterval(tick, INTERVAL_MS);
tick();
