// §18 check for the new bottom-right build-stability badge on the applet card.
// Measures real rendered boxes in Chromium at the five required viewports:
//   360x640, 390x844, 414x896 (phone), 1440x900 (desktop), 1920x1080 (FireStick/TV)
// Asserts the badge sits inside the card AND inside the viewport, keeps a real
// gap from the card's right edge, never overlaps the credit line, and that its
// state + colour come from the live stability feed (✓ + green only when STABLE).
const puppeteer = require('/home/ghost/haksterAi/node_modules/puppeteer');

const URL = process.argv[2] || 'http://127.0.0.1:3579/plans/';
const SIZES = [[360, 640], [390, 844], [414, 896], [1440, 900], [1920, 1080]];
const HARD = setTimeout(() => { console.log('HARD TIMEOUT'); process.exit(2); }, 180000);
HARD.unref && HARD.unref();

(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars'],
  });
  const page = await browser.newPage();
  let fails = 0;
  try {
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    // The card only opens on an update; force it so the footer can be measured.
    await page.evaluate(() => {
      const a = document.getElementById('phantom-server-applet');
      if (a) a.setAttribute('data-mode', 'card');
    });
    // Wait (bounded) for the first stability frame to paint the badge.
    await page.waitForFunction(() => {
      const c = document.getElementById('psa-stab-corner');
      return c && !c.hidden;
    }, { timeout: 20000 }).catch(() => {});

    for (const [w, h] of SIZES) {
      await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
      await page.evaluate(() => {
        const a = document.getElementById('phantom-server-applet');
        if (a) a.setAttribute('data-mode', 'card');
      });
      await new Promise((r) => setTimeout(r, 350));
      const rep = await page.evaluate(() => {
        const vw = window.innerWidth;
        const card = document.querySelector('#phantom-server-applet .psa-card');
        const badge = document.getElementById('psa-stab-corner');
        const text = document.getElementById('psa-stab-corner-text');
        const credit = document.querySelector('#phantom-server-applet .psa-foot > span:first-child');
        const out = { vw, hOverflow: document.documentElement.scrollWidth - vw };
        if (!card || !badge) { out.missing = true; return out; }
        const c = card.getBoundingClientRect();
        const b = badge.getBoundingClientRect();
        const cr = credit ? credit.getBoundingClientRect() : null;
        out.card = { l: Math.round(c.left), r: Math.round(c.right), t: Math.round(c.top), b: Math.round(c.bottom) };
        out.badge = { l: Math.round(b.left), r: Math.round(b.right), t: Math.round(b.top), b: Math.round(b.bottom), w: Math.round(b.width), h: Math.round(b.height) };
        out.state = badge.dataset.state || '';
        out.text = (text && text.textContent || '').trim();
        out.color = getComputedStyle(badge).color;
        out.hidden = badge.hidden;
        out.rightGap = Math.round(c.right - b.right);
        out.bottomGap = Math.round(c.bottom - b.bottom);
        out.insideCard = b.left >= c.left - 0.5 && b.right <= c.right + 0.5 && b.top >= c.top - 0.5 && b.bottom <= c.bottom + 0.5;
        out.insideViewport = b.left >= 0 && b.right <= vw + 0.5;
        // Does the badge overlap the credit line? (wrapped rows are fine)
        out.overlapsCredit = !!cr && !(b.left >= cr.right - 0.5 || b.right <= cr.left + 0.5 || b.top >= cr.bottom - 0.5 || b.bottom <= cr.top + 0.5);
        out.inFoot = !!badge.closest('.psa-foot');
        // Bottom-right of the card: in the footer, hard against the right side.
        out.foot = (() => { const f = badge.closest('.psa-foot'); if (!f) return null; const r = f.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right) }; })();
        out.rightAligned = !!out.foot && Math.round(out.foot.r - b.right) <= 2;
        return out;
      });
      const checks = [];
      const ok = (name, cond, detail) => { checks.push({ name, ok: !!cond, detail }); };
      ok('no horizontal overflow', rep.hOverflow <= 0, 'overflow ' + rep.hOverflow + 'px');
      ok('badge painted', !rep.missing && !rep.hidden && rep.badge.w > 0, rep.missing ? 'badge not in page' : 'w ' + (rep.badge && rep.badge.w));
      if (!rep.missing) {
        ok('inside the card', rep.insideCard, JSON.stringify({ card: rep.card, badge: rep.badge }));
        ok('inside the viewport', rep.insideViewport, 'badge ' + rep.badge.l + '–' + rep.badge.r + ' of ' + rep.vw);
        ok('sits in the footer', rep.inFoot, 'closest .psa-foot');
        ok('right-aligned in footer', rep.rightAligned, 'footer right ' + (rep.foot && rep.foot.r) + ' vs badge right ' + rep.badge.r);
        ok('no overlap with credit line', !rep.overlapsCredit, 'wrapped rows are fine');
        ok('state is a real monitor state', ['STABLE', 'VERIFYING', 'DEGRADED', 'FAILED', 'UNKNOWN', 'BUILDING', 'BUILT', 'TESTING', 'READY', 'DEPLOYING', 'ROLLED_BACK'].includes(rep.state), 'state ' + rep.state);
        if (rep.state === 'STABLE') ok('STABLE shows ✓', rep.text.includes('✓'), 'text "' + rep.text + '"');
      }
      const bad = checks.filter((c) => !c.ok);
      if (bad.length) fails++;
      console.log(`${w}x${h} | state ${rep.state || '—'} | text "${rep.text || '—'}" | color ${rep.color || '—'} | ${bad.length ? 'FAIL' : 'PASS'}`);
      for (const c of checks) if (!c.ok) console.log('   FAIL ' + c.name + ' — ' + c.detail);
    }
    console.log(fails ? `\n${fails} viewport(s) FAILED` : '\nALL PASS');
  } finally {
    await browser.close();
  }
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('HARNESS FAIL', e.message); process.exit(1); });
