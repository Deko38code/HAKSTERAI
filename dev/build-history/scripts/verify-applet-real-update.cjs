'use strict';
/**
 * Live check: does the applet really fire for a real update?
 *
 * Unlike verify-applet-close.cjs this stubs nothing. It opens the real
 * haksterai.com page, lets the applet settle, then performs the ordinary
 * page-only deploy (build to dist-next, swap dist) and watches the applet in
 * the already-open tab. That is exactly the event a visitor sees.
 *
 * Read-only unless APPLY=1 is set — without it the deploy step is skipped and
 * the script only reports what it would have done.
 *
 * Run: APPLY=1 node dev/build-history/scripts/verify-applet-real-update.cjs
 */
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const URL = process.env.APP_URL || 'https://haksterai.com/';
const ROOT = path.resolve(__dirname, '../../..');
const APPLY = process.env.APPLY === '1';

const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok, detail });
  console.log((ok ? 'PASS ' : 'FAIL ') + name.padEnd(56) + (detail || ''));
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const candidates = [process.env.CHROME_PATH, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].filter(Boolean);
  const executablePath = candidates.find((p) => { try { return fs.existsSync(p); } catch (_) { return false; } });
  const browser = await puppeteer.launch({ headless: 'new', executablePath, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const hardStop = setTimeout(async () => {
    console.log('WATCHDOG: still running after 180s');
    try { await browser.close(); } catch (_) {}
    process.exit(3);
  }, 180000);
  hardStop.unref();

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 45000 });

    const read = () => page.evaluate(() => {
      const root = document.getElementById('phantom-server-applet');
      const detail = document.getElementById('psa-detail');
      return {
        mode: root ? (root.dataset.mode || 'card') : null,
        state: root ? (root.dataset.state || '') : '',
        detail: detail ? detail.textContent.trim() : '',
        pageBuild: document.documentElement.dataset.haksterBuild || '',
      };
    }).catch(() => null);

    // ── settle: the applet must be docked before the update arrives ──────
    let first = null;
    const settleBy = Date.now() + 30000;
    while (Date.now() < settleBy) {
      const snap = await read();
      if (snap) {
        first = snap;
        if (snap.mode === 'chip' || snap.mode === 'tab') break;
      }
      await sleep(400);
    }
    check('applet docked before the update', !!first && (first.mode === 'chip' || first.mode === 'tab'),
      first ? 'mode ' + first.mode : 'no applet');
    const pageBuild = (first && first.pageBuild) || '';
    console.log('tab build: ' + pageBuild);
    if (!pageBuild) throw new Error('page did not expose data-hakster-build');

    // ── the real update: the ordinary page-only deploy ───────────────────
    if (!APPLY) {
      console.log('APPLY not set — skipping the deploy and the watch.');
      return;
    }
    console.log('deploying the current source as a new page build...');
    execFileSync('npx', ['astro', 'build', '--outDir', 'dist-next'], { cwd: ROOT, stdio: 'pipe', timeout: 300000 });
    const builtPage = fs.existsSync(path.join(ROOT, 'dist-next', 'index.html'));
    check('build produced a new artifact', builtPage, builtPage ? 'dist-next/index.html present' : 'dist-next missing');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    execFileSync('mv', [path.join(ROOT, 'dist'), path.join(ROOT, 'dist.bak-realupdate-' + stamp)], { stdio: 'pipe' });
    execFileSync('mv', [path.join(ROOT, 'dist-next'), path.join(ROOT, 'dist')], { stdio: 'pipe' });
    console.log('swapped dist (previous kept as dist.bak-realupdate-' + stamp + ')');

    // ── watch the open tab: the card must announce the new build ─────────
    const timeline = [];
    let last = '';
    const watchBy = Date.now() + 45000;
    let openedAt = null;
    const started = Date.now();
    while (Date.now() < watchBy) {
      const snap = await read();
      if (snap) {
        const key = snap.mode + '|' + snap.state + '|' + snap.detail;
        if (key !== last) {
          last = key;
          timeline.push({ t: Date.now() - started, ...snap });
          console.log('  ' + String(Date.now() - started).padStart(6) + 'ms  ' + snap.mode + ' / ' + snap.state + ' — ' + snap.detail.slice(0, 110));
        }
        if (!openedAt && snap.mode === 'card' && /new page build/i.test(snap.detail)) openedAt = { t: Date.now() - started, ...snap };
      }
      await sleep(400);
    }

    check('new page build: the applet opened itself', !!openedAt,
      openedAt ? 'card opened at ' + openedAt.t + 'ms — ' + openedAt.detail.slice(0, 90) : 'the applet never opened in 45s');
    check('new page build: the card names the new build', !!openedAt && /nothing was reloaded/i.test(openedAt.detail),
      openedAt ? openedAt.detail : 'not shown');
    check('new page build: the page did not reload under the user', !!openedAt && openedAt.pageBuild === pageBuild,
      'tab still on ' + ((openedAt && openedAt.pageBuild) || '?') + ' (was ' + pageBuild + ')');

    const fails = checks.filter((c) => !c.ok);
    console.log(`\n${checks.length - fails.length}/${checks.length} checks passed`);
    process.exitCode = fails.length ? 1 : 0;
  } catch (e) {
    console.error('verifier crashed:', e.message);
    process.exitCode = 2;
  } finally {
    clearTimeout(hardStop);
    try { await browser.close(); } catch (_) {}
  }
})();
