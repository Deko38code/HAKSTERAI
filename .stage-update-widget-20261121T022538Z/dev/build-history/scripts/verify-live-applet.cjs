'use strict';
/**
 * CLAUDE.md §18 verification of the LIVE haksterai.com applet.
 *
 * Measures real rendered boxes in Chromium at the five required viewports:
 *   360x640, 390x844, 414x896 (phone), 1920x1080 (FireStick/TV), 1440x900 (desktop)
 *
 * Per viewport, in each of the three overlay modes the applet can be in
 * (card, chip, tab), it asserts:
 *   - the layout viewport does not scroll horizontally;
 *   - the applet sits fully inside the layout viewport with a visible corner gap;
 *   - the documented --phantom-applet-h equals the real rendered height, so
 *     other fixed panels dock above it instead of covering it;
 *   - every interactive target inside the applet is at least 32x32 px
 *     (touch and TV-remote usable).
 *
 * The browser is always closed in `finally`, and a hard timer exits the process
 * so a hung page can never leave an orphaned headless Chromium behind.
 *
 * Run: node dev/build-history/scripts/verify-live-applet.cjs [url]
 */
const puppeteer = require('/home/ghost/haksterAi/node_modules/puppeteer');

const URL = process.argv[2] || 'https://haksterai.com/';
const MIN_TARGET = 32;
const CORNER_GAP = 4;

const VIEWPORTS = [
  { name: '360x640', width: 360, height: 640, mobile: true },
  { name: '390x844', width: 390, height: 844, mobile: true },
  { name: '414x896', width: 414, height: 896, mobile: true },
  { name: '1920x1080', width: 1920, height: 1080, mobile: false },
  { name: '1440x900', width: 1440, height: 900, mobile: false },
];

const rows = [];
const rec = (vp, mode, check, detail, ok) => rows.push({ vp, mode, check, detail, ok: ok ? 'PASS' : 'FAIL' });

const HARD_STOP = setTimeout(() => {
  console.log('\nHARD TIMEOUT — aborting so no browser is left running.');
  process.exit(2);
}, 240000);
HARD_STOP.unref && HARD_STOP.unref();

const measure = () => {
  const el = document.getElementById('phantom-server-applet');
  if (!el) return { missing: true };
  const r = el.getBoundingClientRect();
  const mode = el.getAttribute('data-mode') || '';
  // Effective visibility: an element inside a [hidden] ancestor is still
  // display:block on itself but renders at zero size — measuring it would
  // report a phantom 0x0 tap target that no one can ever touch.
  const shown_ = (n) => {
    if (!n) return false;
    if (n.closest('[hidden]')) return false;
    const cs = getComputedStyle(n);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    const b = n.getBoundingClientRect();
    return b.width > 0 && b.height > 0;
  };
  const visible = (sel) => {
    const n = el.querySelector(sel);
    if (!shown_(n)) return null;
    const b = n.getBoundingClientRect();
    return { w: Math.round(b.width), h: Math.round(b.height), left: Math.round(b.left), top: Math.round(b.top), right: Math.round(b.right), bottom: Math.round(b.bottom) };
  };
  const targets = [...el.querySelectorAll('button,a,[role="button"]')]
    .filter(shown_)
    .map((n) => {
      const b = n.getBoundingClientRect();
      return { tag: n.tagName.toLowerCase(), id: n.id || n.className || '', w: Math.round(b.width), h: Math.round(b.height) };
    });
  const cs = getComputedStyle(document.documentElement);
  const declared = cs.getPropertyValue('--phantom-applet-h').trim();
  return {
    mode,
    vw: window.innerWidth,
    vh: window.innerHeight,
    scrollWidth: document.scrollingElement ? document.scrollingElement.scrollWidth : document.documentElement.scrollWidth,
    rect: { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom), width: Math.round(r.width), height: Math.round(r.height) },
    card: visible('.psa-card'),
    chip: visible('.psa-chip'),
    tab: visible('.psa-tab'),
    declaredH: declared,
    targets,
  };
};

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: '/usr/bin/chromium',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  try {
    for (const vp of VIEWPORTS) {
      const page = await browser.newPage();
      try {
        await page.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: 1, isMobile: vp.mobile, hasTouch: vp.mobile });
        await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForSelector('#phantom-server-applet', { timeout: 20000 }).catch(() => {});
        await new Promise((r) => setTimeout(r, 1200));

        // ── card (default) ──
        let m = await page.evaluate(measure);
        if (m.missing) {
          rec(vp.name, 'card', 'applet present', 'applet element not in the served page', false);
          continue;
        }
        const judge = (mode, m) => {
          const tag = mode + ' (' + m.mode + ')';
          // In tab mode the container itself is zero-size (the tab is fixed
          // inside it), so measure the element that is actually on screen.
          const box = m.card || m.chip || m.tab || m.rect;
          rec(vp.name, tag, 'no horizontal page scroll',
            `scrollWidth ${m.scrollWidth} vs viewport ${m.vw}`, m.scrollWidth <= m.vw);
          rec(vp.name, tag, 'inside viewport',
            `applet ${box.left}..${box.right} x ${box.top}..${box.bottom} in ${m.vw}x${m.vh}`,
            box.left >= 0 && box.top >= 0 && box.right <= m.vw && box.bottom <= m.vh);
          const gapR = m.vw - box.right;
          const gapB = m.vh - box.bottom;
          rec(vp.name, tag, 'bottom-right corner + gap',
            `right gap ${gapR}px · bottom gap ${gapB}px`, gapR >= CORNER_GAP && gapB >= CORNER_GAP);
          // --phantom-applet-h is the dock footprint measured from the viewport
          // bottom (the applet's own 6px corner offset included), because that
          // is what other fixed panels need to clear.
          const declaredPx = m.declaredH ? parseFloat(m.declaredH) : NaN;
          const footprint = m.vh - box.top;
          rec(vp.name, tag, '--phantom-applet-h matches footprint',
            `declared ${m.declaredH || '(unset)'} · footprint ${footprint}px (box ${box.h}px + ${gapB}px gap)`,
            Number.isFinite(declaredPx) && Math.abs(declaredPx - footprint) <= 2);
          if (m.targets.length) {
            const small = m.targets.filter((t) => t.w < MIN_TARGET || t.h < MIN_TARGET);
            rec(vp.name, tag, 'tap targets >= ' + MIN_TARGET + 'px',
              small.length ? small.map((t) => `${t.tag}#${t.id} ${t.w}x${t.h}`).join(', ')
                : m.targets.map((t) => `${t.tag} ${t.w}x${t.h}`).join(', '),
              small.length === 0);
          }
        };
        judge('card', m);

        // ── chip ──
        // Real transitions in production run through the applet's own setMode(),
        // which republishes --phantom-applet-h. Forcing the attribute alone would
        // leave a stale published value, so the applet's own resize handler is
        // fired afterwards — the same code path the live widget uses.
        await page.evaluate(() => {
          const a = document.getElementById('phantom-server-applet');
          if (a) a.setAttribute('data-mode', 'chip');
          window.dispatchEvent(new Event('resize'));
        });
        await new Promise((r) => setTimeout(r, 350));
        const c = await page.evaluate(measure);
        if (c.chip) judge('chip', c); else rec(vp.name, 'chip', 'chip visible', 'chip mode set but .psa-chip not rendered', false);

        // ── tab ──
        await page.evaluate(() => {
          const a = document.getElementById('phantom-server-applet');
          if (a) a.setAttribute('data-mode', 'tab');
          window.dispatchEvent(new Event('resize'));
        });
        await new Promise((r) => setTimeout(r, 350));
        const t = await page.evaluate(measure);
        if (t.tab) judge('tab', t); else rec(vp.name, 'tab', 'tab visible', 'tab mode set but .psa-tab not rendered', false);

        await page.evaluate(() => { const a = document.getElementById('phantom-server-applet'); if (a) a.setAttribute('data-mode', 'card'); });
      } finally {
        await page.close().catch(() => {});
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  const w = [0, 22, 7, 5];
  console.log(['RESULT', 'VIEWPORT', 'MODE', 'CHECK'].map((h, i) => h.padEnd(w[i])).join('') + 'DETAIL');
  for (const r of rows) {
    console.log([r.ok, r.vp, r.mode, r.check].map((cell, i) => String(cell).padEnd(w[i])).join('') + r.detail);
  }
  const fails = rows.filter((r) => r.ok === 'FAIL');
  console.log(`\n${rows.length - fails.length}/${rows.length} checks passed`);
  for (const f of fails) console.log('FAIL ' + f.vp + ' · ' + f.mode + ' · ' + f.check + ' — ' + f.detail);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => {
  console.error('verify failed:', e.message);
  process.exit(2);
});
