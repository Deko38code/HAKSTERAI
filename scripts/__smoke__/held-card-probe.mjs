/* held-card-probe.mjs — measures the one state this change makes visible.
 *
 * The card's detail line is display:none in every ordinary state. A held build
 * reveals it via [data-state="queued"][data-held="1"]. There is no held build
 * on the server at rest, so this drives the real attributes and the real text
 * and measures the resulting box in Chromium at a phone and a TV viewport —
 * enough to prove the sentence fits, wraps, and never clips the card.
 *
 *   node scripts/__smoke__/held-card-probe.mjs
 */
import { createRequire } from 'node:module';
const require = createRequire('/home/ghost/cine-vault-live/');
const puppeteer = require('puppeteer-core');

const URL = 'http://127.0.0.1:3579/';
const DETAIL = 'Update queued on the server — 3 files waiting. Held while a CLI session is attached (live request open) — it applies as soon as that session ends.';
const VIEWPORTS = [
  { name: 'phone 360x640', width: 360, height: 640 },
  { name: 'TV 1920x1080', width: 1920, height: 1080 },
];

const fails = [];
const check = (vp, what, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + vp + ' · ' + what + '  [' + detail + ']');
  if (!ok) fails.push(vp + ' · ' + what);
};

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/chromium',
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

for (const vp of VIEWPORTS) {
  const page = await browser.newPage();
  await page.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: 1 });
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => document.documentElement.dataset.ready === '1', { timeout: 15000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1200));

  const m = await page.evaluate((detail) => {
    document.querySelector('.psa-tab')?.click();
    const root = document.getElementById('phantom-server-applet');
    root.dataset.state = 'queued';
    root.dataset.held = '1';
    const card = document.querySelector('.psa-card');
    const d = document.getElementById('psa-detail');
    if (d) d.textContent = detail;
    const title = document.getElementById('psa-title');
    if (title) title.textContent = 'Held — CLI attached';
    const chipTitle = document.getElementById('psa-chip-title');
    if (chipTitle) chipTitle.textContent = 'Held · CLI';
    const cr = card.getBoundingClientRect();
    const dr = d ? d.getBoundingClientRect() : null;
    const cs = getComputedStyle(d);
    const tr = title ? title.getBoundingClientRect() : null;
    const ts = title ? getComputedStyle(title) : null;
    return {
      card: { left: cr.left, right: cr.right, top: cr.top, bottom: cr.bottom, w: cr.width, h: cr.height },
      detail: dr ? { top: dr.top, bottom: dr.bottom, w: dr.width, h: dr.height, display: cs.display, lines: Math.round(dr.height / 13) } : null,
      detailOverflow: d ? d.scrollWidth - d.clientWidth : null,
      cardOverflow: card.scrollWidth - card.clientWidth,
      title: tr ? { w: tr.width, clipped: title.scrollWidth > title.clientWidth + 1, text: title.textContent } : null,
      chip: (() => { const c = document.getElementById('psa-chip'); if (!c) return null; const r = c.getBoundingClientRect(); return { w: r.width, left: r.left, right: r.right }; })(),
    };
  }, DETAIL);

  check(vp.name, 'held detail is actually displayed', m.detail && m.detail.display === 'block' && m.detail.h > 0,
    m.detail ? 'display ' + m.detail.display + ', ' + m.detail.h.toFixed(1) + 'px' : 'missing');
  check(vp.name, 'held detail wraps inside the card', m.detailOverflow === 0,
    'overflowX ' + m.detailOverflow);
  check(vp.name, 'card does not overflow horizontally', m.cardOverflow <= 1, 'overflowX ' + m.cardOverflow);
  check(vp.name, 'card stays on screen', m.card.left >= 0 && m.card.right <= vp.width + 1 && m.card.top >= 0 && m.card.bottom <= vp.height + 1,
    'L' + m.card.left.toFixed(0) + ' R' + m.card.right.toFixed(0) + ' T' + m.card.top.toFixed(0) + ' B' + m.card.bottom.toFixed(0));
  check(vp.name, 'state chip shows "Held — CLI attached" unclipped', m.title && !m.title.clipped,
    m.title ? '"' + m.title.text + '", clipped ' + m.title.clipped : 'missing');
  check(vp.name, 'chip stays in the corner', m.chip && m.chip.right <= vp.width + 1,
    m.chip ? 'right ' + m.chip.right.toFixed(0) + ' of ' + vp.width : 'missing');
  await page.close();
}

await browser.close();
console.log('\n' + (12 - fails.length) + '/12 pass');
if (fails.length) { console.log('failures:\n - ' + fails.join('\n - ')); process.exit(1); }
