// Behaviour check for the owner's three rules (2026-11-21):
//   "only on update ques" — a page load that lands on a queued update must NOT
//                            pop the card open by itself;
//   "opening on time"      — an update that APPEARS while the tab is open opens
//                            the card within one poll cycle;
//   "should open then only autohides" — the card then docks to the chip (10 s)
//                            and to the edge tab (20 s) on its own.
// The /api/version answer is stubbed; everything else is the real page.
const puppeteer = require('/home/ghost/haksterAi/node_modules/puppeteer');

const URL = process.argv[2] || 'http://127.0.0.1:3579/';
let queued = false; // flipped mid-session to simulate an update appearing

const HARD = setTimeout(() => { console.log('HARD TIMEOUT'); process.exit(2); }, 150000);
HARD.unref && HARD.unref();

const mode = (page) => page.evaluate(() => document.getElementById('phantom-server-applet')?.getAttribute('data-mode') || 'missing');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu'],
  });
  const page = await browser.newPage();
  const rows = [];
  const ok = (name, cond, detail) => { rows.push({ name, ok: !!cond, detail }); console.log((cond ? 'PASS ' : 'FAIL ') + name + ' — ' + detail); };
  try {
    await page.setViewport({ width: 1440, height: 900 });
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (req.url().includes('/api/version')) {
        return req.respond({
          status: 200,
          contentType: 'application/json',
          // No build id: a queued update is code waiting to apply, NOT a newer
          // page build — a newer build id takes the ready/apply branch instead.
          body: JSON.stringify({ server: { pending: queued ? 2 : 0, stale: queued, applying: false, idle: false } }),
        });
      }
      return req.continue();
    });

    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await new Promise((r) => setTimeout(r, 6000));
    const loadMode = await mode(page);
    ok('page load with nothing queued does not open the card', loadMode !== 'card', 'mode ' + loadMode);

    // A real page load landing on a queued update: reload with queued=true.
    queued = true;
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
    await new Promise((r) => setTimeout(r, 6000));
    const freshMode = await mode(page);
    ok('page load on an already-queued update stays off the card', freshMode !== 'card', 'mode ' + freshMode);

    // Now the same tab sits open and the update APPEARS: flip the answer and
    // wait one version-poll cycle (10 s) plus slack.
    queued = false;
    await new Promise((r) => setTimeout(r, 12000));
    const quietMode = await mode(page);
    ok('update clears again without the card reappearing', quietMode !== 'card', 'mode ' + quietMode);

    const t0 = Date.now();
    queued = true;
    let opened = 0;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      if ((await mode(page)) === 'card') { opened = Date.now() - t0; break; }
    }
    ok('update queued while the tab is open opens the card', opened > 0, opened ? 'opened after ' + Math.round(opened / 1000) + 's' : 'never opened within 30s');

    let docked = 0, hidden = 0;
    const tOpen = Date.now();
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const m = await mode(page);
      const el = (Date.now() - tOpen) / 1000;
      if (!docked && m === 'chip') docked = el;
    }
    ok('card auto-docks to the chip', docked > 0, docked ? 'docked after ' + Math.round(docked) + 's' : 'still open after 20s');
    // A queued update stays visible as a chip by design ("hide when no update
    // are que"); once the queue clears the applet leaves the corner entirely.
    ok('chip holds while the update is still queued', (await mode(page)) === 'chip', 'mode ' + (await mode(page)));
    queued = false;
    const tClear = Date.now();
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const m = await mode(page);
      if (m === 'hidden' || m === 'tab') { hidden = (Date.now() - tClear) / 1000; break; }
    }
    ok('chip tucks away once the queue clears', hidden > 0, hidden ? 'hidden after ' + Math.round(hidden) + 's' : 'still a chip 25s after the queue cleared');
  } finally {
    await browser.close();
  }
  const bad = rows.filter((r) => !r.ok).length;
  console.log(bad ? `\n${bad} check(s) FAILED` : '\nALL PASS');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('HARNESS FAIL', e.message); process.exit(1); });
