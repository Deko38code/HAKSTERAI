'use strict';
/**
 * Owner spec 2026-11-21, "FIX LIVE UPDATE APPLET, HARD REFRESH, QUEUE AND
 * AUTO-HIDE": automated state-transition and hard-refresh proof.
 *
 * Runs against an ISOLATED dev build (default http://127.0.0.1:4322, started
 * with `astro dev`) — never the production site. Every /api answer is stubbed
 * in the browser; no project server, tunnel or database is touched.
 *
 * Scenarios:
 *   A  hard refresh, idle                   -> hidden, no bar
 *   B  hard refresh, update queued          -> hidden, no bar, no spinner
 *   C  hard refresh, build RUNNING          -> card opens, real percent
 *   D  hard refresh, completed build        -> never opens (history)
 *   E  hard refresh, stale FAILED           -> hidden
 *   F  queued while the page is open        -> stays hidden, no bar/spinner
 *   G  queued -> running                    -> card opens, bar follows server %
 *   H  running with no measured percent     -> indeterminate bar, no number
 *   I  percentage regression (older seq)    -> ignored, bar stays at 80%
 *   J  identical frames                     -> one card, bar does not restart
 *   K  verified completion                  -> success, closes in ~2 s
 *   L  failure after running                -> error shown, closes ~6 s, chip ✗
 *   M  prefers-reduced-motion               -> no transitions/animations
 *   N  §18 viewports while RUNNING          -> card inside viewport, 20px gutter
 *
 * Run: node dev/build-history/scripts/verify-applet-state-machine.cjs [url]
 */
const puppeteer = require('/home/ghost/haksterAi/node_modules/puppeteer');

const URL = process.argv[2] || process.env.URL || 'http://127.0.0.1:4322/';
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log((ok ? 'PASS ' : 'FAIL ') + name.padEnd(62) + (detail || ''));
};

const frame = (job, extra = {}) => ({
  seq: extra.seq || Date.now(),
  job: Object.assign({ percent: null, elapsedSec: null, etaSec: null, stage: null, updates: [], buildId: 'b1' }, job),
  stability: extra.stability || { state: 'STABLE', timestamps: {} },
  ...extra,
});

async function openPage(browser, stub) {
  const page = await browser.newPage();
  await page.setCacheEnabled(false);
  await page.setViewport({ width: 1440, height: 900 });
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const u = req.url();
    if (u.includes('/api/version')) {
      return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(stub.version) });
    }
    if (u.includes('/api/applet/status')) {
      return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(stub.status) });
    }
    if (u.includes('/api/applet/stream')) {
      // One synthetic frame, then close: the reconnect path is exercised too.
      return req.respond({
        status: 200, contentType: 'text/event-stream',
        body: 'data: ' + JSON.stringify(Object.assign({ type: 'snapshot' }, stub.status)) + '\n\n',
      });
    }
    if (u.includes('/api/')) return req.respond({ status: 200, contentType: 'application/json', body: '{}' });
    req.continue();
  });
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => !!document.getElementById('phantom-server-applet'), { timeout: 30000 });
  return page;
}

const read = (page) => page.evaluate(() => {
  const root = document.getElementById('phantom-server-applet');
  const bar = document.getElementById('psa-bar');
  const track = document.getElementById('psa-bar-track');
  const chip = document.getElementById('psa-chip');
  const card = root.querySelector('.psa-card');
  const cs = getComputedStyle(root);
  const bcs = bar ? getComputedStyle(bar) : null;
  const m = window.__phantomApplet && window.__phantomApplet.snapshot ? window.__phantomApplet.snapshot() : {};
  const rect = card ? card.getBoundingClientRect() : null;
  return {
    mode: root.dataset.mode,
    state: root.dataset.state,
    stateVar: m.state || m.jobState,
    barVisible: !!(bcs && bcs.display !== 'none' && bcs.visibility !== 'hidden' && !bar.hidden),
    barNow: track ? track.getAttribute('aria-valuenow') : null,
    barText: track ? track.getAttribute('aria-valuetext') : null,
    spinner: chip ? chip.dataset.active : null,
    failed: chip ? chip.dataset.failed : null,
    chipTitle: (document.getElementById('psa-chip-title') || {}).textContent,
    clock: (document.getElementById('psa-clock') || {}).textContent,
    stage: (document.getElementById('psa-stage') || {}).textContent,
    errorVisible: (() => { const e = document.getElementById('psa-error'); return !!(e && !e.hidden && e.textContent); })(),
    detail: (document.getElementById('psa-detail') || {}).textContent,
    visibility: cs.visibility, opacity: cs.opacity, transition: cs.transitionDuration,
    rect: rect ? { left: Math.round(rect.left), right: Math.round(rect.right), top: Math.round(rect.top), bottom: Math.round(rect.bottom), w: Math.round(rect.width) } : null,
    vw: window.innerWidth, vh: window.innerHeight,
    docW: document.documentElement.scrollWidth,
  };
});

const call = (page, fn, arg) => page.evaluate(fn, arg);

(async () => {
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || '/usr/bin/chromium',
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });
  const stop = setTimeout(async () => { console.log('TIMEOUT'); try { await browser.close(); } catch {} process.exit(2); }, 300000);
  const build = '2026-11-21T03:51:52.673Z';
  const idleVersion = { build, server: { build, stale: false, pending: 0, idle: true, applying: false } };
  const idleStatus = { seq: 1, job: { state: 'IDLE' }, stability: { state: 'STABLE', timestamps: {} } };
  try {
    // A — idle hard refresh
    {
      const page = await openPage(browser, { version: idleVersion, status: idleStatus });
      await new Promise((r) => setTimeout(r, 2500));
      const m = await read(page);
      check('A idle hard refresh stays hidden', m.mode === 'hidden' && m.visibility === 'hidden' && !m.barVisible, JSON.stringify({ mode: m.mode, vis: m.visibility, bar: m.barVisible }));
      await page.close();
    }
    // B — queued on load: version says files pending, telemetry says QUEUED
    {
      const page = await openPage(browser, {
        version: { build, server: { build, stale: true, pending: 4, idle: true, applying: false } },
        status: { seq: 2, job: { state: 'QUEUED', percent: 0, label: '4 server files queued' }, stability: { state: 'STABLE', timestamps: {} } },
      });
      await new Promise((r) => setTimeout(r, 2500));
      const m = await read(page);
      check('B queued hard refresh: hidden, no bar, no spinner',
        m.mode === 'hidden' && !m.barVisible && m.spinner === '0' && m.visibility === 'hidden',
        JSON.stringify({ mode: m.mode, bar: m.barVisible, spinner: m.spinner, state: m.state }));
      await page.close();
    }
    // C — RUNNING on load: card opens with the real percentage
    {
      const page = await openPage(browser, {
        version: { build, server: { build, stale: false, pending: 0, idle: false, applying: true } },
        status: { seq: 3, job: { state: 'RUNNING', percent: 45, elapsedSec: 12, etaSec: 30, buildId: 'b1', stage: { id: 'build', label: 'Compiling' } }, stability: { state: 'VERIFYING', timestamps: {} } },
      });
      await new Promise((r) => setTimeout(r, 2600));
      const m = await read(page);
      check('C running hard refresh: card open with real 45%',
        m.mode === 'card' && m.barVisible && m.barNow === '45' && /45%/.test(m.clock || ''),
        JSON.stringify({ mode: m.mode, bar: m.barVisible, aria: m.barNow, clock: m.clock }));
      await page.close();
    }
    // D — a completed build found on load is history
    {
      const page = await openPage(browser, {
        version: idleVersion,
        status: { seq: 4, job: { state: 'VERIFYING', status: 'completed', percent: 100, buildId: 'b1' }, stability: { state: 'STABLE', timestamps: {} } },
      });
      await new Promise((r) => setTimeout(r, 2600));
      const m = await read(page);
      check('D completed-on-load never reopens', m.mode === 'hidden', JSON.stringify({ mode: m.mode }));
      await page.close();
    }
    // E — stale FAILED on load
    {
      const page = await openPage(browser, {
        version: idleVersion,
        status: { seq: 5, job: { state: 'FAILED', buildId: 'b0', errorTail: ['old failure'] }, stability: { state: 'STABLE', timestamps: {} } },
      });
      await new Promise((r) => setTimeout(r, 2600));
      const m = await read(page);
      check('E stale FAILED on load stays hidden', m.mode === 'hidden', JSON.stringify({ mode: m.mode }));
      await page.close();
    }
    // F–M — one page, frames driven through the debug handle (deterministic)
    {
      const page = await openPage(browser, { version: idleVersion, status: idleStatus });
      await new Promise((r) => setTimeout(r, 2200));
      const drive = (obj) => call(page, (o) => window.__phantomApplet.renderLive(o), obj);

      // F queued while open
      await drive(frame({ state: 'QUEUED', percent: 0, label: '3 files queued' }, { seq: 100 }));
      await new Promise((r) => setTimeout(r, 400));
      const f = await read(page);
      check('F queued while open stays hidden (no bar/spinner)',
        f.mode === 'hidden' && !f.barVisible && f.spinner === '0',
        JSON.stringify({ mode: f.mode, bar: f.barVisible, spinner: f.spinner }));

      // G queued -> running
      await drive(frame({ state: 'RUNNING', percent: 30, elapsedSec: 5, etaSec: 40, stage: { id: 'build', label: 'Compiling' } }, { seq: 101 }));
      await new Promise((r) => setTimeout(r, 1200));
      const g = await read(page);
      check('G running opens the card and follows the server 30%',
        g.mode === 'card' && g.barVisible && g.barNow === '30' && g.spinner === '1',
        JSON.stringify({ mode: g.mode, bar: g.barVisible, aria: g.barNow, spinner: g.spinner }));

      // G2 running 30 -> 70 updates the bar
      await drive(frame({ state: 'RUNNING', percent: 70, elapsedSec: 9, etaSec: 20, stage: { id: 'build', label: 'Compiling' } }, { seq: 102 }));
      await new Promise((r) => setTimeout(r, 300));
      const g2 = await read(page);
      check('G2 bar follows 30% -> 70%', g2.barNow === '70' && g2.mode === 'card', JSON.stringify({ aria: g2.barNow }));

      // H no measured percent -> indeterminate, no number
      await drive(frame({ state: 'RUNNING', percent: null, elapsedSec: 12, etaSec: null, stage: { id: 'apply', label: 'Applying' } }, { seq: 103 }));
      await new Promise((r) => setTimeout(r, 300));
      const h = await read(page);
      check('H unmeasured progress shows no invented percentage',
        h.mode === 'card' && h.barVisible && h.barNow === null && /no measured|in progress/i.test(h.barText || h.clock || ''),
        JSON.stringify({ aria: h.barNow, text: h.barText, clock: h.clock }));

      // I older seq ignored
      await drive(frame({ state: 'RUNNING', percent: 80, elapsedSec: 14, etaSec: 10 }, { seq: 200 }));
      await new Promise((r) => setTimeout(r, 200));
      await drive(frame({ state: 'RUNNING', percent: 40, elapsedSec: 2, etaSec: 90 }, { seq: 150 }));
      await new Promise((r) => setTimeout(r, 400));
      const i = await read(page);
      check('I a stale (older-seq) frame never walks the bar backwards', i.barNow === '80', JSON.stringify({ aria: i.barNow }));

      // J identical frames: one card, state unchanged (no re-open churn)
      await drive(frame({ state: 'RUNNING', percent: 80, elapsedSec: 15, etaSec: 10 }, { seq: 201 }));
      await drive(frame({ state: 'RUNNING', percent: 80, elapsedSec: 15, etaSec: 10 }, { seq: 202 }));
      await new Promise((r) => setTimeout(r, 300));
      const j1 = await read(page);
      check('J duplicate frames keep one card and the same bar',
        j1.mode === 'card' && j1.barNow === '80', JSON.stringify({ mode: j1.mode, aria: j1.barNow }));

      // K verified completion: success, then closed in ~2 s
      await drive(frame({ state: 'VERIFYING', status: 'completed', percent: 100, elapsedSec: 20, buildId: 'b1', stage: { id: 'done', label: 'Verified complete' } }, { seq: 203, stability: { state: 'STABLE', timestamps: { deployedBuildId: 'b1' } } }));
      await new Promise((r) => setTimeout(r, 400));
      const k1 = await read(page);
      check('K1 verified completion says 100% (server-measured)', k1.barNow === '100' && /complete|verif/i.test((k1.stage || '') + ' ' + (k1.detail || '')), JSON.stringify({ aria: k1.barNow, stage: k1.stage }));
      await new Promise((r) => setTimeout(r, 2300));
      const k2 = await read(page);
      check('K2 success card closes within ~2 s (no re-open)', k2.mode !== 'card', JSON.stringify({ mode: k2.mode, state: k2.state }));

      // L failure after running: error shown, then closed to a failed chip
      await drive(frame({ state: 'RUNNING', percent: 55, elapsedSec: 5, buildId: 'b2' }, { seq: 300 }));
      await new Promise((r) => setTimeout(r, 900));
      await drive(frame({ state: 'FAILED', buildId: 'b2', percent: 55, errorTail: ['npm ERR! build failed'] }, { seq: 301 }));
      await new Promise((r) => setTimeout(r, 400));
      const l1 = await read(page);
      check('L1 failure shows its error, not success',
        l1.mode === 'card' && l1.state === 'failed' && l1.errorVisible && l1.failed === '1' && !/100%/.test(l1.clock || ''),
        JSON.stringify({ mode: l1.mode, state: l1.state, err: l1.errorVisible, failed: l1.failed, clock: l1.clock }));
      await new Promise((r) => setTimeout(r, 6300));
      const l2 = await read(page);
      check('L2 failure closes to the red chip after ~6 s', l2.mode !== 'card' && l2.failed === '1', JSON.stringify({ mode: l2.mode, failed: l2.failed }));

      // M reduced motion
      await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
      const m = await read(page);
      check('M prefers-reduced-motion disables the applet transition', m.transition === '0s' || parseFloat(m.transition) === 0, JSON.stringify({ transition: m.transition }));
      await page.close();
    }
    // N — §18 viewports with a running card
    {
      const viewports = [
        [360, 640, '360x640'], [390, 844, '390x844'], [414, 896, '414x896'],
        [1920, 1080, '1920x1080 TV'], [1440, 900, '1440x900'],
      ];
      for (const [w, h, name] of viewports) {
        const page = await openPage(browser, {
          version: { build, server: { build, stale: false, pending: 0, idle: false, applying: true } },
          status: { seq: 9, job: { state: 'RUNNING', percent: 62, elapsedSec: 8, etaSec: 20, buildId: 'b1', stage: { id: 'build', label: 'Compiling' } }, stability: { state: 'VERIFYING', timestamps: {} } },
        });
        await page.setViewport({ width: w, height: h });
        await new Promise((r) => setTimeout(r, 2200));
        const r = await read(page);
        const gutter = w < 480 ? 20 : 0;
        const inside = r.rect && r.rect.left >= gutter - 1 && r.rect.right <= r.vw + 1 && r.rect.bottom <= r.vh + 1;
        check(`N ${name}: running card inside the viewport with a ${w < 480 ? '20px ' : ''}gutter`,
          r.mode === 'card' && inside && r.docW <= r.vw + 1,
          JSON.stringify({ rect: r.rect, vw: r.vw, vh: r.vh, doc: r.docW }));
        await page.close();
      }
    }
  } finally {
    clearTimeout(stop);
    try { await browser.close(); } catch {}
  }
  const failed = results.filter((r) => !r.ok);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
  console.log(failed.length ? 'RESULT: FAIL' : 'RESULT: PASS');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('VERIFIER ERROR', e.message); process.exit(3); });
