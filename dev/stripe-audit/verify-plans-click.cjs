'use strict';
/**
 * Live check: do the Subscribe buttons on /plans actually start Stripe Checkout?
 *
 * One fresh page per plan. Each click really calls POST /api/stripe/checkout and
 * really creates a live Checkout Session; the redirect into Stripe is blocked so
 * no card can be entered and nothing can be paid. The session is abandoned and
 * expires by itself.
 *
 * Also measures the page at the §18 viewports: no horizontal overflow, every
 * Subscribe button visible with a real, tappable box.
 *
 * Run: node dev/stripe-audit/verify-plans-click.cjs
 */
const puppeteer = require('puppeteer');
const fs = require('fs');

const URL = 'https://haksterai.com/plans';
const VIEWPORTS = [
  { name: 'desktop 1440x900', width: 1440, height: 900 },
  { name: 'tv 1920x1080', width: 1920, height: 1080 },
  { name: 'phone 390x844', width: 390, height: 844 },
  { name: 'phone 360x640', width: 360, height: 640 },
];

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log((ok ? 'PASS ' : 'FAIL ') + name.padEnd(48) + (detail || ''));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function wire(page, sink) {
  page.on('console', (m) => { if (m.type() === 'error') sink.consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => sink.consoleErrors.push('pageerror: ' + e.message));
}

const SUBSCRIBE = () => [...document.querySelectorAll('button')].filter((b) => b.textContent.trim() === 'Subscribe');

(async () => {
  const candidates = [process.env.CHROME_PATH, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].filter(Boolean);
  const executablePath = candidates.find((p) => { try { return fs.existsSync(p); } catch (_) { return false; } });
  const browser = await puppeteer.launch({ headless: 'new', executablePath, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const hardStop = setTimeout(async () => {
    console.log('WATCHDOG: still running after 160s');
    try { await browser.close(); } catch (_) {}
    process.exit(3);
  }, 160000);
  hardStop.unref();

  let sessions = 0;
  const consoleErrors = [];

  try {
    // ── what the cards are ────────────────────────────────────────────────
    const first = await browser.newPage();
    wire(first, { consoleErrors });
    await first.setViewport({ width: 1440, height: 900 });
    const resp = await first.goto(URL, { waitUntil: 'networkidle2', timeout: 45000 });
    check('plans page loads', resp.status() === 200, 'http ' + resp.status());
    await first.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Subscribe'), { timeout: 20000 });

    const cards = await first.evaluate(() => {
      const out = [];
      for (const b of [...document.querySelectorAll('button')].filter((x) => x.textContent.trim() === 'Subscribe')) {
        const card = b.closest('div[class*="rounded-2xl"]');
        const h = card && card.querySelector('h2');
        const amount = b.parentElement && b.parentElement.querySelector('div');
        out.push({ title: h ? h.textContent.trim() : '(no title)', amount: amount ? amount.textContent.trim() : '' });
      }
      return out;
    });
    check('every paid plan row renders a Subscribe button', cards.length === 8, cards.length + ' buttons');
    await first.close();

    // ── click each one on its own page ────────────────────────────────────
    for (let i = 0; i < cards.length; i++) {
      const page = await browser.newPage();
      wire(page, { consoleErrors });
      await page.setViewport({ width: 1440, height: 900 });
      // Block only the destination; the POST that creates the session is allowed.
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        const u = req.url();
        if (u.startsWith('https://checkout.stripe.com') || u.startsWith('https://js.stripe.com')) return req.abort().catch(() => {});
        req.continue().catch(() => {});
      });

      await page.goto(URL, { waitUntil: 'networkidle2', timeout: 45000 });
      await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Subscribe'), { timeout: 20000 });

      // Capture the checkout response inside the page. Reading it from the
      // DevTools side races the `window.location.href = data.url` that follows,
      // and an aborted navigation can detach the body mid-read. Wrapping fetch
      // records exactly what the click handler received.
      await page.evaluate(() => {
        const orig = window.fetch;
        window.__checkout = null;
        window.fetch = async (...args) => {
          const res = await orig(...args);
          if (String(args[0]).includes('/api/stripe/checkout')) {
            try {
              const clone = res.clone();
              window.__checkout = { status: res.status, body: await clone.json() };
            } catch (e) { window.__checkout = { status: res.status, parseError: String(e) }; }
            // Hand the page a body without a url: the handler then cannot
            // navigate, so the context survives long enough to read what the
            // real server sent. The session itself was already created.
            return new Response(JSON.stringify({ error: 'verifier: redirect suppressed' }), {
              status: res.status, headers: { 'content-type': 'application/json' },
            });
          }
          return res;
        };
      });

      const clicked = await page.evaluate((idx) => {
        const bs = [...document.querySelectorAll('button')].filter((b) => b.textContent.trim() === 'Subscribe');
        if (!bs[idx]) return false;
        bs[idx].click();
        return true;
      }, i);

      let out = { status: 0, url: null, error: null, note: '' };
      try {
        await page.waitForFunction(() => window.__checkout !== null, { timeout: 20000 });
        const cap = await page.evaluate(() => window.__checkout);
        out.status = cap.status;
        const j = cap.body || {};
        out.url = j.url || null;
        out.error = j.error || null;
        if (cap.parseError) out.note = 'unparsable body: ' + cap.parseError;
      } catch (_) { out.note = 'no response captured'; }

      const good = clicked && out.status === 200 && typeof out.url === 'string' &&
        /^https:\/\/checkout\.stripe\.com\//.test(out.url) && /cs_live_/.test(out.url);
      if (good) sessions++;
      check(`click "${cards[i].title} ${cards[i].amount}" opens Checkout`, good,
        out.status ? `http ${out.status}` + (out.error ? ' error=' + out.error : '') : out.note);

      // A failing case deserves the server's own words.
      if (!good && out.note && out.note.startsWith('non-JSON')) console.log('      body: ' + out.note);
      await page.close().catch(() => {});
    }

    check('no console errors on the plans page', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

    // ── §18 viewports, measured ───────────────────────────────────────────
    for (const vp of VIEWPORTS) {
      const page = await browser.newPage();
      await page.setViewport({ width: vp.width, height: vp.height });
      await page.goto(URL, { waitUntil: 'networkidle2', timeout: 45000 });
      await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Subscribe'), { timeout: 20000 });
      await sleep(400);
      const m = await page.evaluate(() => {
        const de = document.documentElement;
        const btns = [...document.querySelectorAll('button')].filter((b) => b.textContent.trim() === 'Subscribe')
          .map((b) => { const r = b.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), inView: r.top >= 0 && r.left >= 0 && r.right <= innerWidth + 0.5 }; });
        const applet = document.getElementById('phantom-server-applet');
        const ab = applet ? applet.getBoundingClientRect() : null;
        return { overflow: de.scrollWidth - de.clientWidth, innerWidth, btns, appletBottomRight: ab ? Math.abs(innerWidth - ab.right) < 24 : null };
      });
      const smallest = m.btns.reduce((a, b) => Math.min(a, b.h), Infinity);
      const allInView = m.btns.every((b) => b.inView && b.w > 0 && b.h > 0);
      check(`${vp.name}: no horizontal overflow`, m.overflow <= 0, 'scrollWidth-clientWidth = ' + m.overflow + 'px');
      check(`${vp.name}: Subscribe buttons visible and tappable`, allInView && smallest >= 28,
        `${m.btns.length} buttons, smallest height ${smallest === Infinity ? 'n/a' : smallest}px`);
      await page.close().catch(() => {});
    }

    const fails = results.filter((r) => !r.ok);
    console.log(`\n${results.length - fails.length}/${results.length} checks passed · ${sessions} live Checkout Sessions created (abandoned, none paid)`);
    process.exitCode = fails.length ? 1 : 0;
  } catch (e) {
    console.error('verifier crashed:', e.message);
    process.exitCode = 2;
  } finally {
    clearTimeout(hardStop);
    try { await browser.close(); } catch (_) {}
  }
})();
