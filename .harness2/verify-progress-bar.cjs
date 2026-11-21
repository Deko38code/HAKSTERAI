// Progress bar, copied word for word from Junkalot's UpdateToast (owner,
// 2026-11-21: "my widget is missing progress bar while updateing like junkalots
// has", "copy code word for word", "the applet").
//
// Two cases, both against the real page with the live-job feed stubbed:
//   A. the server reports a measured percent -> determinate fill, number shown;
//   B. the server reports work with no percent  -> indeterminate pulse, no number
//      (§10: never invent a percentage).
// Then the card + bar are measured at the five §18 viewports.
const puppeteer = require('/home/ghost/haksterAi/node_modules/puppeteer');

const URL = process.argv[2] || 'http://127.0.0.1:3579/';
const VIEWPORTS = [
  { w: 360, h: 640, label: 'phone 360x640' },
  { w: 390, h: 844, label: 'phone 390x844' },
  { w: 414, h: 896, label: 'phone 414x896' },
  { w: 1440, h: 900, label: 'desktop 1440x900' },
  { w: 1920, h: 1080, label: 'TV 1920x1080' },
];

const HARD = setTimeout(() => { console.log('HARD TIMEOUT'); process.exit(2); }, 240000);
HARD.unref && HARD.unref();

const rows = [];
const ok = (name, cond, detail) => { rows.push(!!cond); console.log((cond ? 'PASS ' : 'FAIL ') + name + ' — ' + detail); };

function jobFrame(percent) {
  const job = {
    buildId: 'harness-bar-' + Date.now(),
    state: 'RUNNING',
    status: 'running',
    startedAt: new Date().toISOString(),
    elapsedSec: 12,
    etaSec: 40,
    stage: { id: 'rebuild', label: 'Rebuilding pages' },
  };
  if (percent != null) job.percent = percent;
  return JSON.stringify({ job, stability: { state: 'BUILDING' } });
}

async function openStubbed(browser, percent) {
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const u = req.url();
    if (u.includes('/api/applet/stream')) return req.abort(); // let the 5 s status poll drive it
    if (u.includes('/api/applet/status')) {
      return req.respond({ status: 200, contentType: 'application/json', body: jobFrame(percent) });
    }
    if (u.includes('/api/version')) {
      return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ server: { pending: 0, stale: false, applying: false, idle: false } }) });
    }
    return req.continue();
  });
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForFunction(() => {
    const r = document.getElementById('phantom-server-applet');
    return r && r.dataset.mode === 'card';
  }, { timeout: 30000 });
  await page.waitForFunction(() => {
    const b = document.getElementById('psa-bar');
    return b && !b.hidden;
  }, { timeout: 15000 });
  return page;
}

const measure = (page) => page.evaluate(() => {
  const q = (id) => document.getElementById(id);
  const card = q('psa-card') || document.querySelector('#phantom-server-applet .psa-card');
  const bar = q('psa-bar');
  const track = q('psa-bar-track');
  const fill = q('psa-bar-fill');
  const shine = bar && bar.querySelector('.jl-shine');
  const label = q('psa-bar-label');
  const pct = q('psa-bar-pct');
  const root = document.getElementById('phantom-server-applet');
  const cb = card && card.getBoundingClientRect();
  const tb = track && track.getBoundingClientRect();
  const fb = fill && fill.getBoundingClientRect();
  const sb = shine && shine.getBoundingClientRect();
  const lb = label && label.getBoundingClientRect();
  const pb = pct && !pct.hidden ? pct.getBoundingClientRect() : null;
  const fillStyle = fill && getComputedStyle(fill);
  const shineStyle = shine && getComputedStyle(shine);
  const trackStyle = track && getComputedStyle(track);
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  return {
    mode: root && root.dataset.mode,
    barVisible: !!bar && !bar.hidden && bar.getBoundingClientRect().height > 0,
    card: cb && { x: cb.x, y: cb.y, w: cb.width, h: cb.height, right: cb.right, bottom: cb.bottom },
    track: tb && { x: tb.x, y: tb.y, w: tb.width, h: tb.height, right: tb.right },
    fillW: fb && fb.width,
    shineW: sb && sb.width,
    shineAnim: shineStyle && (shineStyle.animationName + ' ' + shineStyle.animationDuration),
    fillAnim: fillStyle && (fillStyle.animationName + ' ' + fillStyle.animationDuration),
    fillClass: fill && fill.className,
    fillBackground: fillStyle && fillStyle.backgroundImage.slice(0, 90),
    fillShadow: fillStyle && fillStyle.boxShadow,
    trackH: trackStyle && trackStyle.height,
    trackRadius: trackStyle && trackStyle.borderTopLeftRadius,
    trackBg: trackStyle && trackStyle.backgroundColor,
    role: track && track.getAttribute('role'),
    ariaMin: track && track.getAttribute('aria-valuemin'),
    ariaMax: track && track.getAttribute('aria-valuemax'),
    ariaNow: track && track.getAttribute('aria-valuenow'),
    ariaText: track && track.getAttribute('aria-valuetext'),
    ariaLabel: track && track.getAttribute('aria-label'),
    labelText: label && label.textContent,
    labelBox: lb && { x: lb.x, y: lb.y, w: lb.width, h: lb.height, right: lb.right },
    pctVisible: !!pb,
    pctText: pct && pct.textContent,
    pctBox: pb && { x: pb.x, y: pb.y, w: pb.width, h: pb.height, right: pb.right },
    vw, vh,
    docOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ghostClass: (q('psa-ghost') || {}).className || '',
    ghostAnim: q('psa-ghost') ? getComputedStyle(q('psa-ghost')).animationName + ' ' + getComputedStyle(q('psa-ghost')).animationDuration + ' ' + getComputedStyle(q('psa-ghost')).animationIterationCount : '',
    ghostTransform: q('psa-ghost') ? getComputedStyle(q('psa-ghost')).transform : '',
  };
});

(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
  try {
    // ---- Case A: measured percent ----
    let page = await openStubbed(browser, 42);
    await page.setViewport({ width: 1440, height: 900 });
    await new Promise((r) => setTimeout(r, 700));
    let m = await measure(page);
    ok('A: bar appears while the update runs', m.barVisible, 'bar ' + (m.barVisible ? 'shown' : 'hidden'));
    ok('A: track is the 8px rounded Junkalot track', m.trackH === '8px' && m.trackRadius === '999px' && m.trackBg === 'rgb(4, 18, 10)',
      'h ' + m.trackH + ', radius ' + m.trackRadius + ', bg ' + m.trackBg);
    const ratio = m.track && m.fillW ? m.fillW / m.track.w : 0;
    ok('A: measured 42% fills 42% of the track', Math.abs(ratio - 0.42) < 0.03, 'fill ' + (ratio * 100).toFixed(1) + '% of track');
    ok('A: no pulse on a measured fill', m.fillClass === 'jl-fill', 'class "' + m.fillClass + '"');
    ok('A: gradient fill copied from Junkalot', /#00b83a|#00ff41|rgb\(0, 255, 65\)/i.test(m.fillBackground), m.fillBackground);
    ok('A: green glow on the fill', /rgba\(0, 255, 65/.test(m.fillShadow || ''), m.fillShadow);
    ok('A: shine sweep running', /jl-shine/.test(m.shineAnim) && m.shineW > 0, m.shineAnim + ', width ' + Math.round(m.shineW) + 'px');
    ok('A: number shown for a measured percent', m.pctVisible && m.pctText === '42%', 'pct "' + m.pctText + '"');
    ok('A: label is the server stage label', m.labelText === 'Rebuilding pages', '"' + m.labelText + '"');
    ok('A: progressbar aria is complete', m.role === 'progressbar' && m.ariaMin === '0' && m.ariaMax === '100' && m.ariaNow === '42'
      && /Rebuilding pages 42%/.test(m.ariaText || '') && !!m.ariaLabel, 'now ' + m.ariaNow + ', text "' + m.ariaText + '"');
    ok('A: the ghost spins while the update works', /phantom-spin/.test(m.ghostClass)
      && /^phantom-spin 1\.1s infinite/.test(m.ghostAnim), 'class "' + m.ghostClass + '", ' + m.ghostAnim);
    ok('A: the spinning ghost really rotates', /matrix\(/.test(m.ghostTransform) && m.ghostTransform !== 'none', m.ghostTransform);

    // Five viewports with a determinate bar.
    for (const v of VIEWPORTS) {
      await page.setViewport({ width: v.w, height: v.h });
      await new Promise((r) => setTimeout(r, 500));
      const x = await measure(page);
      const gutter = x.card && x.vw - x.card.right;
      const insideX = x.card && x.card.x >= 0 && x.card.right <= x.vw;
      const insideY = x.card && x.card.y >= 0 && x.card.bottom <= x.vh;
      const barInside = x.track && x.labelBox && x.track.x >= x.card.x - 0.5 && x.track.right <= x.card.right + 0.5
        && x.labelBox.right <= x.card.right + 0.5;
      const gutterOk = v.w >= 480 ? gutter >= 0 : gutter >= 20;
      ok(v.label + ': card sits fully inside the viewport', !!insideX && !!insideY && gutterOk,
        'card x ' + Math.round(x.card.x) + '–' + Math.round(x.card.right) + ' of ' + x.vw + ', gutter ' + Math.round(gutter) + 'px');
      ok(v.label + ': bar, label and percent stay inside the card', !!barInside, 'track right ' + Math.round(x.track.right) + ' vs card right ' + Math.round(x.card.right));
      ok(v.label + ': no horizontal page overflow', x.docOverflowX <= 0, 'scrollWidth - clientWidth = ' + x.docOverflowX);
    }
    await page.close();

    // ---- Case B: work with no measured percent ----
    page = await openStubbed(browser, null);
    await page.setViewport({ width: 1440, height: 900 });
    await new Promise((r) => setTimeout(r, 700));
    m = await measure(page);
    ok('B: bar still appears with no percent', m.barVisible, m.barVisible ? 'shown' : 'hidden');
    ok('B: indeterminate fill pulses', m.fillClass === 'jl-fill jl-indeterminate' && /jl-pulse/.test(m.fillAnim), 'class "' + m.fillClass + '", ' + m.fillAnim);
    // The track's rect includes its 1px borders; the fill covers the content box.
    ok('B: indeterminate fill spans the track', m.track && m.fillW >= m.track.w - 4, 'fill ' + Math.round(m.fillW) + ' of ' + Math.round(m.track.w) + ' (1px border each side)');
    ok('B: no invented percentage', !m.pctVisible && m.ariaNow === null, 'pct visible ' + m.pctVisible + ', aria-valuenow ' + m.ariaNow);
    ok('B: label names the stage, not a number', m.labelText === 'Rebuilding pages' && !/%/.test(m.labelText), '"' + m.labelText + '"');
    await page.close();

    // ---- Case C: nothing working -> the ghost stands still ----
    page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const u = req.url();
      if (u.includes('/api/applet/stream')) return req.abort();
      if (u.includes('/api/applet/status')) return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ job: {}, stability: { state: 'STABLE' } }) });
      if (u.includes('/api/version')) return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ server: { pending: 0, stale: false, applying: false, idle: true } }) });
      return req.continue();
    });
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await new Promise((r) => setTimeout(r, 3500));
    await page.evaluate(() => { const t = document.getElementById('psa-tab') || document.getElementById('psa-chip'); if (t) t.click(); });
    await new Promise((r) => setTimeout(r, 800));
    const c = await measure(page);
    ok('C: card opens on demand', c.mode === 'card', 'mode ' + c.mode);
    ok('C: ghost stands still when nothing is working', !/phantom-spin/.test(c.ghostClass) && c.ghostAnim.split(' ')[0] === 'none',
      'class "' + c.ghostClass + '", ' + c.ghostAnim);
    await page.close();
  } finally {
    await browser.close();
  }
  const bad = rows.filter((r) => !r).length;
  console.log(bad ? `\n${bad} check(s) FAILED` : '\nALL PASS');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('HARNESS FAIL', e.message); process.exit(1); });
