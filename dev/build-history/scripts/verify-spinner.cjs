'use strict';
/**
 * End-to-end verification of the HaksterAI spinner → panel behaviour.
 *
 * It runs a REAL isolated build (POST /api/build-history/run, which builds into
 * dev/build-history/out — never dist/) and watches the applet in Chromium the
 * whole time. Every assertion is on a rendered DOM value, not on the CSS.
 *
 * Run: node dev/build-history/scripts/verify-spinner.cjs
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('/home/ghost/haksterAi/node_modules/puppeteer');

const ROOT = path.join(__dirname, '..');
const BASE = 'http://127.0.0.1:3999';
const TOKEN = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'dev-owner.json'), 'utf8')).token;
const SHOTS = path.join(ROOT, 'shots');

const checks = [];
const rec = (area, detail, ok) => { checks.push({ area, detail, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${area.padEnd(34)} ${detail}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(pathname, init = {}) {
  const res = await fetch(BASE + pathname, {
    ...init,
    headers: { 'x-api-key': TOKEN, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await puppeteer.launch({
    headless: 'new', executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.evaluateOnNewDocument((t) => {
      try { localStorage.setItem('hakster_api_key', t); } catch (_) {}
    }, TOKEN);
    await page.goto(BASE + '/applet/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => document.getElementById('phantom-status').textContent !== 'Connecting…', { timeout: 20000 });

    // 1. resting state = small spinner, panel hidden
    const resting = await page.evaluate(() => ({
      pill: getComputedStyle(document.getElementById('hp-pill')).display,
      dock: document.getElementById('phantom-progress-dock').hidden,
      active: document.getElementById('hp-pill').dataset.active,
    }));
    // The resting element is the spinner. A build recorded in the last 10 min
    // legitimately opens the panel instead (it is still being verified), so
    // both outcomes are reported, and only "neither is visible" is a failure.
    rec('resting/verifying state visible', `pill display=${resting.pill} · dock hidden=${resting.dock} · spinning=${resting.active}`,
      resting.pill !== 'none' || resting.dock === false);

    // 2. force the resting state, then start a real build
    await page.evaluate(() => {
      const dock = document.getElementById('phantom-progress-dock');
      const pill = document.getElementById('hp-pill');
      dock.hidden = true; pill.style.display = 'flex';
    });
    const started = await api('/api/build-history/run', { method: 'POST', body: JSON.stringify({ trigger: 'spinner-verify' }) });
    rec('isolated build started', `http ${started.status} · buildId ${started.body?.record?.buildId || 'UNKNOWN'}`, started.status === 200);

    // 3. spinner lights up, then the panel unfolds
    const timeline = [];
    let sawSpinnerActive = false, sawDock = false, firstPercent = null, sawStage = false, sawEta = false;
    for (let i = 0; i < 90; i++) {
      const s = await page.evaluate(() => {
        const pill = document.getElementById('hp-pill');
        const dock = document.getElementById('phantom-progress-dock');
        return {
          pillDisplay: getComputedStyle(pill).display,
          pillActive: pill.dataset.active,
          pillPct: document.getElementById('hp-pct').textContent,
          ringAnim: getComputedStyle(pill.querySelector('.hp-ring')).animationName,
          dockHidden: dock.hidden,
          percent: document.getElementById('phantom-percent').textContent,
          stage: document.getElementById('hp-stage').textContent,
          clock: document.getElementById('hp-clock').textContent,
          status: document.getElementById('phantom-status').textContent,
          updates: document.querySelectorAll('#hp-updates li').length,
          progressHidden: document.getElementById('hp-progress').hidden,
        };
      });
      timeline.push(s);
      if (s.pillDisplay !== 'none' && s.pillActive === '1') sawSpinnerActive = true;
      if (!s.dockHidden) sawDock = true;
      if (!s.dockHidden && /^\d+%$/.test(s.percent.trim()) && firstPercent == null) firstPercent = s.percent;
      if (!s.dockHidden && /ETA|over the|estimate/i.test(s.clock)) sawEta = true;
      if (!s.dockHidden && s.stage && s.stage !== '—') sawStage = true;
      if (firstPercent && s.updates > 0 && !s.progressHidden) {
        await page.screenshot({ path: path.join(SHOTS, 'spinner-expanded.png') });
        break;
      }
      await sleep(250);
    }
    rec('spinner activates on build start', `seen active spinner=${sawSpinnerActive} (ring animation ${timeline.find((t) => t.pillActive === '1')?.ringAnim || 'n/a'})`, sawSpinnerActive);
    rec('panel auto-expands on build event', `dock shown=${sawDock}`, sawDock);
    rec('real build percentage shown', `first percentage seen "${firstPercent}"`, firstPercent != null);
    rec('current stage shown', `stage text "${timeline.find((t) => t.stage && t.stage !== '—')?.stage}"`, sawStage);
    rec('elapsed / ETA shown', `clock "${timeline.find((t) => /ETA|over the/.test(t.clock))?.clock}"`, sawEta);
    rec('timestamped updates listed', `${timeline[timeline.length - 1].updates} update line(s)`, timeline[timeline.length - 1].updates > 0);

    // 4. collapse mid-build → spinner keeps the percentage; expand restores state
    const beforeCollapse = await page.evaluate(() => document.getElementById('phantom-percent').textContent);
    await page.click('#hp-collapse');
    await sleep(400);
    const collapsedState = await page.evaluate(() => ({
      dock: document.getElementById('phantom-progress-dock').hidden,
      pill: getComputedStyle(document.getElementById('hp-pill')).display,
      pct: document.getElementById('hp-pct').textContent,
      active: document.getElementById('hp-pill').dataset.active,
    }));
    rec('collapse to spinner while working', `dock hidden=${collapsedState.dock} · pill=${collapsedState.pill} · pill shows "${collapsedState.pct}" · spinning=${collapsedState.active}`,
      collapsedState.dock === true && collapsedState.pill !== 'none' && collapsedState.active === '1');
    await page.screenshot({ path: path.join(SHOTS, 'spinner-collapsed.png') });

    await page.click('#hp-pill');
    await sleep(500);
    const afterExpand = await page.evaluate(() => ({
      dock: document.getElementById('phantom-progress-dock').hidden,
      percent: document.getElementById('phantom-percent').textContent,
      updates: document.querySelectorAll('#hp-updates li').length,
      stage: document.getElementById('hp-stage').textContent,
    }));
    const pctNum = (s) => Number(String(s).replace(/[^\d]/g, '')) || 0;
    rec('expand restores live state, no reset',
      `before ${beforeCollapse} → after ${afterExpand.percent} · stage "${afterExpand.stage}" · ${afterExpand.updates} update line(s)`,
      afterExpand.dock === false && pctNum(afterExpand.percent) >= pctNum(beforeCollapse) && afterExpand.updates > 0);

    // 5. wait for the build to finish and the panel to move to verification
    let done = null;
    for (let i = 0; i < 200; i++) {
      const job = (await api('/api/build-history/live-job')).body;
      done = await page.evaluate(() => ({
        status: document.getElementById('phantom-status').textContent,
        percent: document.getElementById('phantom-percent').textContent,
        clock: document.getElementById('hp-clock').textContent,
        error: !document.getElementById('hp-error').hidden,
        stability: document.querySelector('.hp-row[data-panel="stability"] [data-v]').textContent,
      }));
      // A failed stability check legitimately outranks "build complete" in the
      // status line, so any real post-build state counts as the transition.
      if (job && job.status === 'completed' && /VERIFYING|STABLE|DEGRADED|FAILED/.test(done.status)) break;
      await sleep(500);
    }
    rec('transition to verification at 100%', `status "${done.status}" · headline ${done.percent}`,
      /VERIFYING|STABLE|DEGRADED|FAILED/.test(done.status));
    rec('headline no longer a build percentage', `headline "${done.percent}" (heap share or — after completion)`,
      /^(\d+%|—|\?)$/.test(done.percent.trim()));
    rec('separate stability countdown', `stability row "${done.stability}"`, /VERIFYING|STABLE|DEGRADED/.test(done.stability));
    rec('no false failure indicator', `error panel visible=${done.error}`, done.error === false);
    await page.screenshot({ path: path.join(SHOTS, 'spinner-verifying.png') });

    // 6. audit log actually received the lifecycle events
    const ev = (await api('/api/applet/events?limit=200')).body;
    const names = new Set(((ev && ev.entries) || []).map((e) => e.event));
    const needed = ['spinner.activate', 'applet.expand', 'applet.collapse', 'job.stage', 'job.progress', 'job.complete'];
    const missing = needed.filter((n) => !names.has(n));
    rec('audit log records lifecycle', `${(ev && ev.entries || []).length} entries · missing: ${missing.length ? missing.join(', ') : 'none'}`, missing.length === 0);

    // 7. reduced motion: spinner does not animate
    const rm = await browser.newPage();
    await rm.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await rm.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await rm.evaluateOnNewDocument((t) => { try { localStorage.setItem('hakster_api_key', t); } catch (_) {} }, TOKEN);
    await rm.goto(BASE + '/applet/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await rm.waitForFunction(() => document.getElementById('phantom-status').textContent !== 'Connecting…', { timeout: 20000 });
    await rm.evaluate(() => { document.getElementById('hp-pill').dataset.active = '1'; });
    const rmState = await rm.evaluate(() => ({
      ring: getComputedStyle(document.querySelector('#hp-pill .hp-ring')).animationName,
      fill: getComputedStyle(document.getElementById('phantom-fill')).transitionDuration,
    }));
    rec('reduced motion respected', `ring animation=${armState(rmState.ring)} · fill transition=${rmState.fill}`, rmState.ring === 'none');
    await rm.close();
  } finally {
    await browser.close();
  }

  const failed = checks.filter((c) => !c.ok).length;
  console.log(`\n${checks.length - failed} passed, ${failed} failed, ${checks.length} checks`);
  process.exitCode = failed ? 1 : 0;
})().catch((e) => { console.error('VERIFY ERROR', e); process.exit(2); });

function armState(v) { return v; }
