'use strict';
/**
 * Does the server applet stay closed on a fresh page load?
 *
 * Read-only. Loads the real haksterai.com page with its own applet code and
 * reads the applet's rendered mode after the first checks settle. Four
 * scenarios, each a separate page load:
 *   A  idle server            -> must be hidden
 *   B  queued update on load  -> must be hidden (the refresh bug)
 *   C  applying on load       -> must be card (a real update)
 *   D  stale FAILED telemetry -> must be hidden (history, not an update)
 *
 * Run: node dev/build-history/scripts/verify-applet-refresh.cjs [url]
 */
const puppeteer = require('/home/ghost/haksterAi/node_modules/puppeteer');

const URL = process.argv[2] || 'https://haksterai.com/';
const WAIT = Number(process.env.WAIT || 9000);
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + name.padEnd(52) + (detail || '')); };

const modeOf = (page) => page.evaluate(() => {
  const el = document.getElementById('phantom-server-applet');
  if (!el) return 'MISSING';
  const cs = getComputedStyle(el);
  return el.dataset.mode + '/' + el.dataset.state + (cs.display === 'none' ? ' (display:none)' : ' (visible)');
});

async function scenario(browser, label, stub, expectPrefix) {
  const page = await browser.newPage();
  await page.setCacheEnabled(false);
  await page.setViewport({ width: 1440, height: 900 });
  if (stub) {
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
        // Keep the stream open with one synthetic snapshot.
        return req.respond({ status: 200, contentType: 'text/event-stream', body: 'data: ' + JSON.stringify(stub.status) + '\n\n' });
      }
      req.continue();
    });
  }
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await new Promise((r) => setTimeout(r, WAIT));
  const mode = await modeOf(page);
  check(label, mode.startsWith(expectPrefix), 'got ' + mode);
  await page.close();
}

(async () => {
  const executablePath = process.env.CHROME_PATH || '/usr/bin/chromium';
  const browser = await puppeteer.launch({ executablePath, headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
  const hardStop = setTimeout(async () => { console.log('TIMEOUT'); try { await browser.close(); } catch {} process.exit(2); }, 120000);
  try {
    // A — real server as it is right now (idle expected).
    await scenario(browser, 'A idle load stays hidden', null, 'hidden');

    // B — a page load that finds an update queued on the server.
    const build = '2026-11-21T03:51:52.673Z';
    await scenario(browser, 'B queued-on-load stays hidden', {
      version: { build, server: { build, stale: true, pending: 4, idle: true, applying: false } },
      status: { job: { state: 'IDLE' }, stability: { state: 'STABLE' } },
    }, 'hidden');

    // C — the server is applying an update: the card must open.
    await scenario(browser, 'C applying opens the card', {
      version: { build, server: { build: '2026-11-21T04:30:00.000Z', stale: false, pending: 0, idle: false, applying: true } },
      status: { job: { state: 'RUNNING', buildId: 'x', startedAt: new Date().toISOString(), percent: 30 }, stability: { state: 'VERIFYING' } },
    }, 'card');

    // D — a FAILED build found on load is history, not an update.
    await scenario(browser, 'D stale FAILED on load stays hidden', {
      version: { build, server: { build, stale: false, pending: 0, idle: true, applying: false } },
      status: { job: { state: 'FAILED', buildId: 'old', startedAt: new Date(Date.now() - 60000).toISOString(), error: 'old failure' }, stability: { state: 'FAILED' } },
    }, 'hidden');
  } finally {
    clearTimeout(hardStop);
    try { await browser.close(); } catch {}
  }
  const failed = results.filter((r) => !r.ok);
  console.log(failed.length ? '\nRESULT: FAIL' : '\nRESULT: PASS');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e.message); process.exit(3); });
