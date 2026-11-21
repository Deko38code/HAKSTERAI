'use strict';
/**
 * Failure + lost-telemetry verification for the HaksterAI applet.
 *
 * Two paths that matter more than the happy one:
 *   1. a FAILED build must show a red indicator and keep the failure log
 *   2. lost telemetry must read DISCONNECTED / UNKNOWN, never a false success
 *
 * The failure case is driven by a clearly-marked fixture written to the dev
 * job file (dev/build-history/data/current-job.json) — no production build is
 * broken to produce it. The original file is restored immediately afterwards.
 * The disconnect case is driven by Chrome's offline mode on a real running
 * build, so nothing on the host is disturbed.
 *
 * Run: node dev/build-history/scripts/verify-failure.cjs
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('/home/ghost/haksterAi/node_modules/puppeteer');
const { execSync, spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BASE = 'http://127.0.0.1:3999';
const TOKEN = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'dev-owner.json'), 'utf8')).token;
const JOB_FILE = path.join(ROOT, 'data', 'current-job.json');
const SHOTS = path.join(ROOT, 'shots');

const checks = [];
const rec = (area, detail, ok) => { checks.push({ area, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${area.padEnd(36)} ${detail}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (p, init = {}) => {
  const res = await fetch(BASE + p, { ...init, headers: { 'x-api-key': TOKEN, 'Content-Type': 'application/json', ...(init.headers || {}) } });
  return { status: res.status, body: await res.json().catch(() => null) };
};

(async () => {
  const original = fs.readFileSync(JOB_FILE, 'utf8');
  const browser = await puppeteer.launch({
    headless: 'new', executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.evaluateOnNewDocument((t) => { try { localStorage.setItem('hakster_api_key', t); } catch (_) {} }, TOKEN);
    await page.goto(BASE + '/applet/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => document.getElementById('phantom-status').textContent !== 'Connecting…', { timeout: 20000 });

    // ── 1. FAILED build ──────────────────────────────────────────────────
    const now = new Date();
    fs.writeFileSync(JOB_FILE + '.verify-tmp', JSON.stringify({
      buildId: 'hak-VERIFY-FIXTURE-failed',
      project: 'haksterai',
      box: 'dell',
      status: 'failed',
      startedAt: new Date(now - 40000).toISOString(),
      heartbeatAt: now.toISOString(),
      finishedMs: Date.now(),
      stages: [
        { id: 'capture-git', label: 'Capture Git state', status: 'done', startedAt: null, finishedAt: null, ms: 5 },
        { id: 'dependencies', label: 'Snapshot dependencies', status: 'done', startedAt: null, finishedAt: null, ms: 2 },
        { id: 'build', label: 'Astro build (isolated outDir)', status: 'failed', startedAt: null, finishedAt: null, ms: 9000 },
        { id: 'verify', label: 'Verify build output', status: 'pending', startedAt: null, finishedAt: null, ms: null },
        { id: 'health', label: 'Server health check', status: 'pending', startedAt: null, finishedAt: null, ms: null },
      ],
      updates: [
        { at: new Date(now - 40000).toISOString(), text: 'Build queued' },
        { at: new Date(now - 31000).toISOString(), text: 'Astro build (isolated outDir): running' },
        { at: new Date(now).toISOString(), text: 'Astro build (isolated outDir): failed — astro build exited 1' },
      ],
      history: null,
      error: 'astro build exited 1',
      errorTail: ['[build] error: fixture failure for UI verification', 'astro build exited 1'],
    }, null, 2), { mode: 0o600 });
    fs.renameSync(JOB_FILE + '.verify-tmp', JOB_FILE);

    let failedUi = null;
    for (let i = 0; i < 40; i++) {
      failedUi = await page.evaluate(() => {
        const err = document.getElementById('hp-error');
        const pill = document.getElementById('hp-pill');
        return {
          status: document.getElementById('phantom-status').textContent,
          statusColor: getComputedStyle(document.getElementById('phantom-status')).color,
          headline: document.getElementById('phantom-percent').textContent,
          headlineColor: getComputedStyle(document.getElementById('phantom-percent')).color,
          pillPct: document.getElementById('hp-pct').textContent,
          pillPctColor: getComputedStyle(document.getElementById('hp-pct')).color,
          errorVisible: !err.hidden,
          errorText: err.textContent,
        };
      });
      if (failedUi.errorVisible) break;
      await sleep(300);
    }
    const red = (c) => /rgb\(255, (107|138), (107|138)\)/.test(c);
    rec('failure shows red indicator', `status "${failedUi.status}" · colour ${failedUi.statusColor} · headline "${failedUi.headline}" ${failedUi.headlineColor}`,
      /FAILED/.test(failedUi.status) && red(failedUi.statusColor) && red(failedUi.headlineColor));
    rec('failure log preserved on screen', `${failedUi.errorVisible ? 'shown' : 'hidden'} · "${String(failedUi.errorText).split('\n')[0]}"`,
      failedUi.errorVisible && /exited 1/.test(failedUi.errorText));
    rec('spinner shows the failure, not progress', `pill text "${failedUi.pillPct}" in ${failedUi.pillPctColor}`, failedUi.pillPct === '✗');
    await page.screenshot({ path: path.join(SHOTS, 'spinner-failed.png') });

    // restore the real job state
    fs.writeFileSync(JOB_FILE + '.verify-tmp', original, { mode: 0o600 });
    fs.renameSync(JOB_FILE + '.verify-tmp', JOB_FILE);

    // ── 2. lost telemetry on a REAL running build ───────────────────────
    await api('/api/build-history/run', { method: 'POST', body: JSON.stringify({ trigger: 'disconnect-verify' }) });
    await page.waitForFunction(() => document.getElementById('hp-pill').dataset.active === '1', { timeout: 20000 }).catch(() => {});
    await sleep(2500);

    // Cut the telemetry host itself: stop the ISOLATED dev server (port 3999,
    // not PM2, not a tunnel). Existing SSE sockets really close, the page keeps
    // its last frame, and it must age it out to DISCONNECTED by itself.
    const devPid = execSync("ss -ltnp 2>/dev/null | grep ':3999' | grep -o 'pid=[0-9]*' | cut -d= -f2 || true", { shell: '/bin/bash' }).toString().trim();
    if (devPid) { try { process.kill(Number(devPid), 'SIGTERM'); } catch (_) {} }
    await sleep(1500);

    let offline = null;
    for (let i = 0; i < 60; i++) {           // 30 s of silence is the threshold
      offline = await page.evaluate(() => ({
        live: document.getElementById('hp-live').textContent,
        status: document.getElementById('phantom-status').textContent,
        headline: document.getElementById('phantom-percent').textContent,
      }));
      if (/DISCONNECTED/.test(offline.live) && /DISCONNECTED/.test(offline.status)) break;
      await sleep(1000);
    }
    rec('lost telemetry reads DISCONNECTED', `live "${offline.live}" · status "${offline.status}" · headline "${offline.headline}"`,
      /DISCONNECTED/.test(offline.live) && /DISCONNECTED/.test(offline.status) && !/%$/.test(offline.headline));
    rec('never a false success while disconnected', `${/STABLE|COMPLETE|SUCCESS/.test(offline.status) ? 'FALSE SUCCESS SHOWN' : 'no success shown'}`,
      !/STABLE|COMPLETE|SUCCESS/.test(offline.status));
    await page.screenshot({ path: path.join(SHOTS, 'spinner-disconnected.png') });

    // bring the isolated server back and let the page reconnect
    const child = spawn('node', ['server.cjs'], { cwd: ROOT, detached: true, stdio: 'ignore' });
    child.unref();
    let restored = null;
    for (let i = 0; i < 90; i++) {
      restored = await page.evaluate(() => document.getElementById('hp-live').textContent);
      if (/LIVE/.test(restored)) break;
      await sleep(1000);
    }
    rec('telemetry restoration announced', `live "${restored}"`, /LIVE/.test(restored));
  } finally {
    try { fs.writeFileSync(JOB_FILE, fs.readFileSync(JOB_FILE, 'utf8')); } catch (_) {}
    await browser.close();
  }

  const failed = checks.filter((c) => !c.ok).length;
  console.log(`\n${checks.length - failed} passed, ${failed} failed, ${checks.length} checks`);
  process.exitCode = failed ? 1 : 0;
})().catch((e) => { console.error('VERIFY ERROR', e); process.exit(2); });
