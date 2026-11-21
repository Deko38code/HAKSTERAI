'use strict';
/**
 * Isolated UI verification for the HaksterAI applet + build-history panel.
 *
 * Measures real rendered boxes in Chromium — reading the CSS is not evidence.
 * Viewports are the ones CLAUDE.md §18 requires: 360x640, 390x844, 414x896,
 * 1920x1080 (FireStick/TV) and 1440x900 (desktop).
 *
 * Run: node dev/build-history/scripts/verify-ui.cjs
 * Reads the dev owner token from data/dev-owner.json; it is never printed.
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('/home/ghost/haksterAi/node_modules/puppeteer');

const ROOT = path.join(__dirname, '..');
const BASE = 'http://127.0.0.1:3999';
const TOKEN = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'dev-owner.json'), 'utf8')).token;
const SHOTS = path.join(ROOT, 'shots');

const VIEWPORTS = [
  { name: '360x640', width: 360, height: 640, mobile: true },
  { name: '390x844', width: 390, height: 844, mobile: true },
  { name: '414x896', width: 414, height: 896, mobile: true },
  { name: '1920x1080', width: 1920, height: 1080, mobile: false },
  { name: '1440x900', width: 1440, height: 900, mobile: false },
];

const results = [];
const rec = (v, area, detail, ok) => results.push({ viewport: v, area, detail, ok });

(async () => {
  // Use the system Chromium this box actually has; puppeteer's bundled download
  // is not present here and installing packages needs owner approval.
  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: '/usr/bin/chromium',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    for (const vp of VIEWPORTS) {
      const page = await browser.newPage();
      await page.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: 1, isMobile: vp.mobile, hasTouch: vp.mobile });
      await page.evaluateOnNewDocument((t) => {
        try { localStorage.setItem('hakster_api_key', t); } catch (_) {}
      }, TOKEN);
      await page.goto(BASE + '/applet/', { waitUntil: 'domcontentloaded', timeout: 30000 });

      // wait for a real first frame
      await page.waitForFunction(() => {
        const v = document.querySelector('.hp-row[data-panel="node"] .hp-val');
        return v && v.textContent && v.textContent !== '—';
      }, { timeout: 20000 }).catch(() => {});

      // open the dock first (resting state is the spinner), then the details
      await page.evaluate(() => {
        const pill = document.getElementById('hp-pill');
        if (getComputedStyle(pill).display !== 'none') pill.click();
      });
      await new Promise((r) => setTimeout(r, 400));
      await page.evaluate(() => {
        const card = document.getElementById('phantom-progress');
        if (card.dataset.open !== '1') document.getElementById('hp-toggle').click();
      });
      await page.evaluate(() => {
        document.querySelectorAll('.hp-row').forEach((r) => { r.dataset.expanded = '1'; });
      });
      await new Promise((r) => setTimeout(r, 700));

      const geo = await page.evaluate(() => {
        const dock = document.getElementById('phantom-progress-dock');
        const card = document.getElementById('phantom-progress');
        const d = dock.getBoundingClientRect();
        const c = card.getBoundingClientRect();
        const rows = {};
        document.querySelectorAll('.hp-row').forEach((r) => {
          rows[r.dataset.panel] = {
            value: r.querySelector('[data-v]').textContent,
            detail: r.querySelector('[data-d]').textContent,
          };
        });
        const offenders = [];
        document.querySelectorAll('#phantom-progress *').forEach((el) => {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && (r.right > window.innerWidth + 0.5 || r.left < -0.5)) {
            offenders.push((el.className || el.tagName) + ' ' + Math.round(r.left) + '..' + Math.round(r.right));
          }
        });
        return {
          innerWidth: window.innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
          docScrollHeight: document.documentElement.scrollHeight,
          dock: { top: Math.round(d.top), bottom: Math.round(d.bottom), left: Math.round(d.left), right: Math.round(d.right), width: Math.round(d.width), height: Math.round(d.height) },
          card: { width: Math.round(c.width), height: Math.round(c.height), bottom: Math.round(c.bottom), right: Math.round(c.right) },
          status: document.getElementById('phantom-status').textContent,
          percent: document.getElementById('phantom-percent').textContent,
          live: document.getElementById('hp-live').textContent,
          scope: document.getElementById('hp-scope').textContent,
          powered: document.querySelector('.hp-powered span').textContent.trim(),
          indeterminate: document.querySelector('.phantom-track').dataset.indeterminate,
          offenders,
          rows,
        };
      });

      const gutter = vp.mobile ? 10 : 18;
      const noOverflow = geo.scrollWidth <= geo.innerWidth;
      rec(vp.name, 'applet:no-horizontal-overflow', `scrollWidth ${geo.scrollWidth} vs innerWidth ${geo.innerWidth}`, noOverflow);
      rec(vp.name, 'applet:inside-viewport',
        `dock ${geo.dock.left}..${geo.dock.right} of ${geo.innerWidth}, right gutter ${geo.innerWidth - geo.dock.right}px (need ≥${gutter})`,
        geo.dock.right <= geo.innerWidth - gutter + 1 && geo.dock.left >= 0);
      rec(vp.name, 'applet:bottom-right-corner', `bottom ${geo.dock.bottom} of ${vp.height} (${vp.height - geo.dock.bottom}px from edge)`, vp.height - geo.dock.bottom <= gutter + 2);
      rec(vp.name, 'applet:no-clipped-children', `${geo.offenders.length} overflowing child(ren)${geo.offenders.length ? ': ' + geo.offenders.slice(0, 4).join(', ') : ''}`, geo.offenders.length === 0);

      // every row must carry real text, never a placeholder dash
      const emptyRows = Object.entries(geo.rows).filter(([, r]) => !r.value || r.value === '—').map(([k]) => k);
      rec(vp.name, 'applet:rows-have-data', emptyRows.length ? 'empty: ' + emptyRows.join(', ') : Object.entries(geo.rows).map(([k, r]) => `${k}=${r.value}`).join(' | '), emptyRows.length === 0);

      const pct = geo.percent;
      rec(vp.name, 'applet:no-fake-percent', `headline "${pct}" · track indeterminate=${geo.indeterminate}`, /^(\d+%|—|…)$/.test(pct.trim()));
      rec(vp.name, 'applet:powered-by', `"${geo.powered}"`, geo.powered === 'Powered by 👻 Phantom IDE');
      rec(vp.name, 'applet:stability-row', `stability=${geo.rows.stability.value}`, /^(STABLE|VERIFYING|DEGRADED|FAILED|UNKNOWN|BUILDING|BUILT|TESTING|READY|DEPLOYING|ROLLED_BACK)$/.test(geo.rows.stability.value));

      await page.screenshot({ path: path.join(SHOTS, `applet-${vp.name}.png`) });

      // collapsed mode: the spinner must sit in the corner and stay tappable
      await page.evaluate(() => document.getElementById('hp-collapse').click());
      await new Promise((r) => setTimeout(r, 350));
      const pillGeo = await page.evaluate(() => {
        const p = document.getElementById('hp-pill');
        const r = p.getBoundingClientRect();
        return {
          display: getComputedStyle(p).display,
          left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom),
          w: Math.round(r.width), h: Math.round(r.height),
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
          dockHidden: document.getElementById('phantom-progress-dock').hidden,
        };
      });
      rec(vp.name, 'spinner:collapsed-corner',
        `${pillGeo.w}x${pillGeo.h} at ${pillGeo.left}..${pillGeo.right} / bottom ${pillGeo.bottom} of ${vp.height} · dock hidden=${pillGeo.dockHidden}`,
        pillGeo.display !== 'none' && pillGeo.dockHidden === true &&
        pillGeo.right <= vp.width - (vp.mobile ? 10 : 18) + 1 &&
        pillGeo.h >= 44 && pillGeo.w >= 44);
      rec(vp.name, 'spinner:no-overflow', `scrollWidth ${pillGeo.scrollWidth} vs innerWidth ${pillGeo.innerWidth}`,
        pillGeo.scrollWidth <= pillGeo.innerWidth);
      await page.screenshot({ path: path.join(SHOTS, `spinner-pill-${vp.name}.png`) });
      await page.close();

      // ── panel ────────────────────────────────────────────────────────────
      if (vp.name === '1440x900' || vp.name === '390x844' || vp.name === '360x640') {
        const p2 = await browser.newPage();
        await p2.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: 1, isMobile: vp.mobile, hasTouch: vp.mobile });
        await p2.goto(BASE + '/admin/build-history', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await p2.waitForFunction(() => {
          const b = document.getElementById('stability-banner');
          return b && b.classList.contains('stab');
        }, { timeout: 20000 }).catch(() => {});
        await p2.evaluate(() => { document.querySelectorAll('details.build').forEach((d) => { d.open = true; }); });
        await p2.waitForFunction(() => document.getElementById('applet-events').className === 'evs', { timeout: 15000 }).catch(() => {});
        await new Promise((r) => setTimeout(r, 600));
        const pg = await p2.evaluate(() => {
          const b = document.getElementById('stability-banner');
          const off = [];
          document.querySelectorAll('main *').forEach((el) => {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && (r.right > window.innerWidth + 0.5 || r.left < -0.5)) off.push((el.className || el.tagName) + ' ' + Math.round(r.left) + '..' + Math.round(r.right));
          });
          return {
            innerWidth: window.innerWidth,
            scrollWidth: document.documentElement.scrollWidth,
            bannerClass: b ? b.className : null,
            bannerText: b ? b.textContent.replace(/\s+/g, ' ').trim().slice(0, 400) : null,
            stateChip: b && b.querySelector('.stab-state') ? b.querySelector('.stab-state').textContent : null,
            checks: b ? b.querySelectorAll('.chk').length : 0,
            pass: b ? b.querySelectorAll('.chk.pass').length : 0,
            fail: b ? b.querySelectorAll('.chk.fail').length : 0,
            unknown: b ? b.querySelectorAll('.chk.unknown').length : 0,
            countdown: b && b.querySelector('.countdown') ? b.querySelector('.countdown').textContent.replace(/\s+/g, ' ').trim() : null,
            builds: document.querySelectorAll('details.build').length,
            phantomNote: document.getElementById('phantomide-note') ? document.getElementById('phantomide-note').textContent.slice(0, 60) : null,
            offenders: off.slice(0, 6),
            events: document.querySelectorAll('#applet-events .ev').length,
          };
        });
        rec(vp.name, 'panel:stability-banner', `class=${pg.bannerClass} · state=${pg.stateChip} · checks ${pg.checks} (${pg.pass} pass / ${pg.fail} fail / ${pg.unknown} unknown) · ${pg.countdown}`, pg.bannerClass === 'stab' && pg.checks > 0);
        rec(vp.name, 'panel:no-horizontal-overflow', `scrollWidth ${pg.scrollWidth} vs innerWidth ${pg.innerWidth} · ${pg.offenders.length} offender(s)${pg.offenders.length ? ': ' + pg.offenders.join(', ') : ''}`, pg.scrollWidth <= pg.innerWidth && pg.offenders.length === 0);
        rec(vp.name, 'panel:builds-rendered', `${pg.builds} build record(s) rendered`, pg.builds >= 1);
        rec(vp.name, 'panel:applet-events', `${pg.events} lifecycle event(s) listed`, pg.events > 0);
        await p2.screenshot({ path: path.join(SHOTS, `panel-${vp.name}.png`), fullPage: false });
        console.log('PANEL ' + vp.name + ' :: ' + JSON.stringify({ bannerText: pg.bannerText, phantomNote: pg.phantomNote }));
        await p2.close();
      }
    }
  } finally {
    await browser.close();
  }

  let pass = 0, fail = 0;
  for (const r of results) {
    if (r.ok) pass++; else fail++;
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.viewport.padEnd(10)} ${r.area.padEnd(30)} ${r.detail}`);
  }
  console.log(`\n${pass} passed, ${fail} failed, ${results.length} checks`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('VERIFY ERROR', e); process.exit(2); });
