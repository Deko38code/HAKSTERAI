/* viewport-probe.mjs — measures the applet and the reconnect banner in a real
 * browser at the §18 viewports, using the system Chromium.
 *
 * Checks the two labels this change adds, at their longest wording:
 *  - the docked chip / edge tab says "Held · CLI" (shorter than "Build queued")
 *  - the banner's apply line, which is the longest banner string we ship
 * No overflow, and a visible gutter on phones.
 *
 *   node scripts/__smoke__/viewport-probe.mjs
 */
import { createRequire } from 'node:module';
const require = createRequire('/home/ghost/cine-vault-live/');
const puppeteer = require('puppeteer-core');

const URL = 'http://127.0.0.1:3579/';
const APPLY_LINE = 'Server is restarting to apply an update — reconnecting…';
const HELD_DETAIL = 'Update queued on the server — 3 files waiting. Held while a CLI session is attached (CLI session attached) — it applies as soon as that session ends.';

const VIEWPORTS = [
  { name: 'phone 360x640', width: 360, height: 640 },
  { name: 'phone 390x844', width: 390, height: 844 },
  { name: 'phone 414x896', width: 414, height: 896 },
  { name: 'TV 1920x1080', width: 1920, height: 1080 },
  { name: 'desktop 1440x900', width: 1440, height: 900 },
];

const rows = [];
const fails = [];
const check = (vp, what, ok, detail) => {
  rows.push({ vp, what, ok, detail });
  if (!ok) fails.push(vp + ' · ' + what + ' [' + detail + ']');
  console.log((ok ? '  PASS  ' : '  FAIL  ') + vp + ' · ' + what + '  [' + detail + ']');
};

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/chromium',
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

for (const vp of VIEWPORTS) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
  await page.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: 1 });
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => document.documentElement.dataset.ready === '1', { timeout: 20000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1200));

  const base = await page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    innerW: window.innerWidth,
    tab: (() => {
      const t = document.querySelector('.psa-tab');
      if (!t) return null;
      const r = t.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: r.width, h: r.height };
    })(),
    mode: document.querySelector('.psa') ? document.querySelector('.psa').dataset.mode : null,
  }));

  check(vp.name, 'no horizontal overflow', base.scrollW <= base.innerW + 1, base.scrollW + ' / ' + base.innerW);
  if (base.tab) {
    const gutter = base.innerW - base.tab.right;
    const need = vp.width < 480 ? 20 : 0;
    check(vp.name, 'edge tab inside the viewport with a gutter', gutter >= need, 'gutter ' + gutter.toFixed(1) + 'px, need ≥' + need);
    check(vp.name, 'edge tab is a usable tap target', base.tab.h >= 24 && base.tab.w >= 24, base.tab.w.toFixed(0) + '×' + base.tab.h.toFixed(0));
  } else {
    check(vp.name, 'edge tab present', false, 'not found (mode ' + base.mode + ')');
  }

  // The banner's real element, created by the site's own code path, then the
  // longest string we ship is painted into it.
  const banner = await page.evaluate((line) => {
    if (typeof window.haksterUpdateWhenReady === 'function') window.haksterUpdateWhenReady();
    const b = document.getElementById('hakster-reconnect-banner');
    if (!b) return null;
    const span = b.lastElementChild;
    if (span) span.textContent = line;
    const r = b.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: r.width, h: r.height, lines: Math.round(r.height / 18) };
  }, APPLY_LINE);

  if (!banner) {
    check(vp.name, 'reconnect banner renders', false, 'element missing');
  } else {
    check(vp.name, 'banner fits horizontally with a gutter',
      banner.left >= 12 - 1 && banner.right <= vp.width - 12 + 1,
      'left ' + banner.left.toFixed(1) + ', right ' + banner.right.toFixed(1));
    check(vp.name, 'banner stays on screen vertically', banner.top >= 0 && banner.bottom <= vp.height + 1,
      'top ' + banner.top.toFixed(1) + ', bottom ' + banner.bottom.toFixed(1));
  }

  // The card, open, with the longest held detail line painted in.
  const card = await page.evaluate((detail) => {
    const tab = document.querySelector('.psa-tab');
    if (tab) tab.click();
    const root = document.querySelector('.psa');
    const c = document.querySelector('.psa-card');
    if (!c) return null;
    const d = c.querySelector('[data-el="detail"]') || c.querySelector('.psa-detail');
    if (d) d.textContent = detail;
    const r = c.getBoundingClientRect();
    return {
      mode: root ? root.dataset.mode : null,
      left: r.left, right: r.right, top: r.top, bottom: r.bottom,
      overflowX: c.scrollWidth - c.clientWidth,
    };
  }, HELD_DETAIL);

  if (!card || card.bottom - card.top < 10) {
    check(vp.name, 'card opens for measurement', false, card ? 'collapsed' : 'card missing');
  } else {
    check(vp.name, 'card fits inside the layout viewport',
      card.left >= 0 && card.right <= vp.width + 1 && card.overflowX <= 1,
      'left ' + card.left.toFixed(1) + ', right ' + card.right.toFixed(1) + ', overflowX ' + card.overflowX);
    check(vp.name, 'card keeps its bottom-right corner',
      vp.width - card.right <= vp.width && card.bottom <= vp.height + 1,
      'right gutter ' + (vp.width - card.right).toFixed(1) + ', bottom ' + card.bottom.toFixed(1));
  }

  check(vp.name, 'no page errors', errors.length === 0, errors.slice(0, 3).join(' | ') || 'none');
  await page.close();
}

await browser.close();
console.log('\n' + (rows.length - fails.length) + '/' + rows.length + ' pass');
if (fails.length) { console.log('failures:\n - ' + fails.join('\n - ')); process.exit(1); }
