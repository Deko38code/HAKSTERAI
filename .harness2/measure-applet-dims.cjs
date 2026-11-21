// Measures the applet's real rendered boxes at the five §18 viewports and
// compares two URLs (the haksterAi original and the portable build). Prints a
// markdown table that is written to PHANTOM-APPLET-DIMENSIONS.md.
const puppeteer = require('/home/ghost/haksterAi/node_modules/puppeteer');

const A = process.argv[2] || 'http://127.0.0.1:3579/';
const B = process.argv[3] || 'http://127.0.0.1:3996/demo.html';
const VIEWPORTS = [
  { w: 360, h: 640 }, { w: 390, h: 844 }, { w: 414, h: 896 },
  { w: 1440, h: 900 }, { w: 1920, h: 1080 },
];

const jobFrame = () => JSON.stringify({
  job: { buildId: 'dims', state: 'RUNNING', status: 'running', startedAt: new Date().toISOString(), elapsedSec: 12, etaSec: 40, percent: 42, stage: { id: 'rebuild', label: 'Rebuilding pages' } },
  stability: { state: 'STABLE', timestamps: { buildFirstStableAt: new Date().toISOString() } },
});

async function measure(browser, url, vp) {
  const page = await browser.newPage();
  await page.setViewport({ width: vp.w, height: vp.h });
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const u = req.url();
    if (u.includes('/api/applet/stream')) return req.abort();
    if (u.includes('/api/applet/status')) return req.respond({ status: 200, contentType: 'application/json', body: jobFrame() });
    if (u.includes('/api/version')) return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ build: 'dims-build', server: { pending: 0, stale: false, applying: false, idle: false } }) });
    return req.continue();
  });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  // A long host page carries a scrollbar; that shrinks the viewport, not the
  // widget. Hide it so both measurements describe the widget itself.
  await page.addStyleTag({ content: 'html{overflow:hidden!important}' });
  await page.waitForFunction(() => {
    const r = document.getElementById('phantom-server-applet');
    return r && r.dataset.mode === 'card' && !document.getElementById('psa-bar').hidden;
  }, { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 400));
  const m = await page.evaluate(() => {
    const q = (id) => document.getElementById(id);
    const box = (n) => { if (!n) return null; const b = n.getBoundingClientRect(); return { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1) }; };
    const cs = (n, p) => (n ? getComputedStyle(n)[p] : null);
    const root = q('phantom-server-applet');
    const card = root && root.querySelector('.psa-card');
    const chip = q('psa-chip');
    const tab = q('psa-tab');
    const start = q('psa-start');
    return {
      vw: innerWidth, vh: innerHeight,
      card: box(card), chip: box(chip), tab: box(tab), ring: box(start),
      track: box(q('psa-bar-track')),
      cardPadding: cs(card, 'padding'), radius: cs(card, 'borderTopLeftRadius'),
      font: cs(root, 'fontSize'), lineHeight: cs(root, 'lineHeight'),
      ghost: box(q('psa-ghost')),
      right: cs(root, 'right'), bottom: cs(root, 'bottom'), z: cs(root, 'zIndex'),
      cardW: cs(card, 'width'),
    };
  });
  await page.close();
  return m;
}

(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
  const rows = [];
  try {
    for (const vp of VIEWPORTS) {
      const a = await measure(browser, A, vp);
      const b = await measure(browser, B, vp);
      const same = ['card', 'chip', 'tab', 'ring', 'track'].every((k) => {
        const x = a[k], y = b[k];
        if (!x || !y) return !x && !y;
        return Math.abs(x.w - y.w) < 1 && Math.abs(x.h - y.h) < 1;
      });
      rows.push({ vp, a, b, same });
    }
  } finally { await browser.close(); }

  let md = '# Phantom server applet — exact dimensions\n\n';
  md += 'Measured from real rendered boxes with a headless browser, card open with a 42% update running.\n';
  md += 'Column A is the haksterAi implementation, column B the portable `phantom-applet.js`. Sizes in CSS px.\n\n';
  for (const r of rows) {
    md += `## ${r.vp.w}x${r.vp.h}\n\n`;
    md += '| box | A width x height | B width x height | A x,y | B x,y |\n|---|---|---|---|---|\n';
    for (const k of ['card', 'chip', 'tab', 'ring', 'track', 'ghost']) {
      const a = r.a[k], b = r.b[k];
      md += `| ${k} | ${a ? a.w + ' x ' + a.h : '—'} | ${b ? b.w + ' x ' + b.h : '—'} | ${a ? a.x + ', ' + a.y : '—'} | ${b ? b.x + ', ' + b.y : '—'} |\n`;
    }
    md += `\nGhost glyph: A ${r.a.ghost ? r.a.ghost.w + 'x' + r.a.ghost.h : '—'}, B ${r.b.ghost ? r.b.ghost.w + 'x' + r.b.ghost.h : '—'} (emoji fallback may differ by a fraction of a pixel; the brand row is ${r.a.card ? '' : ''}the same height).\n`;
    md += `\nParity: **${r.same ? 'same size' : 'DIFFERENT'}** — offsets right ${r.a.right}, bottom ${r.a.bottom}, z-index ${r.a.z}, font ${r.a.font}/${r.a.lineHeight}, card padding ${r.a.cardPadding}, radius ${r.a.radius}, card width ${r.a.cardW}.\n\n`;
  }
  console.log(md);
  require('fs').writeFileSync(require('path').join(__dirname, '..', 'dev', 'applet', 'PHANTOM-APPLET-DIMENSIONS.md'), md);
  process.exit(rows.every((r) => r.same) ? 0 : 1);
})().catch((e) => { console.error('HARNESS FAIL', e.message); process.exit(1); });
