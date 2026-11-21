'use strict';
/**
 * Live check: does the update applet close itself once an update is done?
 *
 * Read-only. The real haksterai.com page is loaded and its own applet code
 * runs unchanged; only the two telemetry endpoints are answered in-page with
 * a synthetic job, so no build is started and no server state is touched.
 *
 * Scenario A — a finished build (livejob reports a COMPLETED build as
 *   VERIFYING): the card must say the update is complete and dock itself
 *   within a few seconds. Before the fix it stayed pinned for 15 minutes.
 * Scenario B — a build that is still RUNNING: the card must NOT dock.
 *
 * Run: node dev/build-history/scripts/verify-applet-close.cjs
 */
const puppeteer = require('puppeteer');
const fs = require('fs');

const URL = process.env.APP_URL || 'https://haksterai.com/';
const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok, detail });
  console.log((ok ? 'PASS ' : 'FAIL ') + name.padEnd(56) + (detail || ''));
};

async function runScenario(browser, job, label) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.evaluateOnNewDocument((jobSpec) => {
    const orig = window.fetch;
    window.__job = jobSpec;
    const loadedAt = Date.now();
    const delay = Number(jobSpec.delayMs) || 0;
    window.fetch = function (input, init) {
      const u = String(input && input.url ? input.url : input);
      if (u.indexOf('/api/applet/status') !== -1) {
        // Before `delayMs` the site reports no build at all, so the applet
        // docks the way it does for any idle visitor. Then the job appears —
        // exactly the moment an update has to announce itself.
        const job = Date.now() - loadedAt >= delay
          ? window.__job
          : { state: 'IDLE', label: 'Idle · no build running', percent: null };
        return Promise.resolve(new Response(JSON.stringify({ job, stability: null }), {
          status: 200, headers: { 'content-type': 'application/json' },
        }));
      }
      if (window.__job.queued && Date.now() - loadedAt >= delay && u.indexOf('/api/version?') !== -1) {
        // A queued server update: same page build, so nothing reloads, but the
        // server has changes waiting to apply. Held back until the applet has
        // docked so the card really has to open itself. With `applyAfterMs` the
        // queue turns into a real apply, then back to normal — the full lifecycle.
        const t = Date.now() - loadedAt;
        const applyAt = Number(window.__job.applyAfterMs) || 0;
        const doneAt = applyAt ? applyAt + (Number(window.__job.applyForMs) || 6000) : 0;
        const server = t < applyAt || !doneAt
          ? { build: 'server-build', stale: true, pending: 3, files: [], idle: true, applying: false }
          : t < doneAt
            ? { build: 'server-build', stale: true, pending: 0, files: [], idle: false, applying: true }
            : { build: 'server-build', stale: false, pending: 0, files: [], idle: true, applying: false };
        return Promise.resolve(new Response(JSON.stringify({
          build: window.__job.versionBuild || document.documentElement.dataset.haksterBuild || 'page-build',
          server,
          checkedAt: new Date().toISOString(),
        }), { status: 200, headers: { 'content-type': 'application/json' } }));
      }
      if (window.__job.versionBuild && Date.now() - loadedAt >= delay && u.indexOf('/api/version?') !== -1) {
        // A page build newer than this tab's: the "update available" path. Held
        // back until the applet has docked, so the card really does have to open
        // itself — a version answered at load would find it already open.
        return Promise.resolve(new Response(JSON.stringify({
          build: window.__job.versionBuild,
          server: { build: window.__job.versionBuild, stale: false, pending: 0, applying: false, idle: true },
          checkedAt: new Date().toISOString(),
        }), { status: 200, headers: { 'content-type': 'application/json' } }));
      }
      if (u.indexOf('/api/applet/stream') !== -1) {
        // An empty stream: the applet falls straight back to polling, which is
        // answered above. Nothing hangs.
        return Promise.resolve(new Response('', { status: 200, headers: { 'content-type': 'text/event-stream' } }));
      }
      return orig.apply(this, arguments);
    };
  }, job);

  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 45000 });

  const read = () => page.evaluate(() => {
    const root = document.getElementById('phantom-server-applet');
    const detail = document.getElementById('psa-detail');
    const dbg = window.__phantomApplet && window.__phantomApplet.snapshot ? window.__phantomApplet.snapshot() : null;
    return root ? { mode: root.dataset.mode || 'card', state: root.dataset.state || '', detail: detail ? detail.textContent.trim() : '', dbg } : null;
  }).catch(() => null);

  // Watch it dock (idle visitor), then open for the update, then close.
  const timeline = [];
  const started = Date.now();
  let sawCard = false;
  let dockedBefore = null;
  let openedAt = null;
  let chipAt = null;
  let lastMode = '';
  const watchMs = Number(job.watchMs) || 26000;
  while (Date.now() - started < watchMs) {
    const snap = await read();
    if (snap) {
      const t = Date.now() - started;
      timeline.push({ t, ...snap });
      if (snap.mode !== lastMode) {
        lastMode = snap.mode;
        const d = snap.dbg || {};
        console.log('  ' + label.padEnd(16) + String(t).padStart(6) + 'ms  ' + snap.mode + ' / ' + snap.state
          + ' · dock ' + (d.dockPending ? d.dockDelay + 'ms pending' : (d.hasDockTimer ? 'timer?' : 'none'))
          + ' · closed ' + (d.closedBuild || '—') + ' — ' + String(snap.detail || '').slice(0, 70));
      }
      if (snap.mode === 'card') sawCard = true;
      if (!dockedBefore && (snap.mode === 'chip' || snap.mode === 'tab')) dockedBefore = { t, ...snap };
      if (dockedBefore && !openedAt && snap.mode === 'card') openedAt = { t, ...snap };
      if (openedAt && !chipAt && snap.mode === 'chip' && t > openedAt.t + 500) { chipAt = { t, ...snap }; break; }
    }
    await new Promise((r) => setTimeout(r, 400));
  }

  // A card that closed must stay closed: the next telemetry frames arrive
  // within seconds and must not re-open it.
  let reopenedAt = null;
  if (chipAt) {
    const after = Date.now();
    while (Date.now() - after < 7000) {
      const snap = await read();
      if (snap && snap.mode === 'card') { reopenedAt = Date.now() - after; timeline.push({ t: Date.now() - started, reopened: true, ...snap }); break; }
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  const saidDone = timeline.some((x) => /update complete/i.test(x.detail));
  await page.close().catch(() => {});
  return { timeline, chipAt, saidDone, sawCard, reopenedAt, dockedBefore, openedAt, label };
}

(async () => {
  const candidates = [process.env.CHROME_PATH, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].filter(Boolean);
  const executablePath = candidates.find((p) => { try { return fs.existsSync(p); } catch (_) { return false; } });
  const browser = await puppeteer.launch({ headless: 'new', executablePath, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const hardStop = setTimeout(async () => {
    console.log('WATCHDOG: still running after 150s');
    try { await browser.close(); } catch (_) {}
    process.exit(3);
  }, 150000);
  hardStop.unref();

  try {
    const nowIso = new Date().toISOString();

    // ── A: an update arriving on an idle, docked applet ───────────────────
    const done = await runScenario(browser, {
      state: 'VERIFYING', status: 'completed', percent: 100, startedAt: nowIso,
      buildId: 'applet-close-verifier', label: 'Build complete', delayMs: 12000,
    }, 'finished build');
    check('update: applet had docked while the site was idle', !!done.dockedBefore,
      done.dockedBefore ? 'docked at ' + done.dockedBefore.t + 'ms' : 'never docked before the update');
    check('update: the applet opened itself for the update', !!done.openedAt,
      done.openedAt ? 'card opened at ' + done.openedAt.t + 'ms' : 'update arrived and the applet stayed away');
    check('update: card said the update is complete', done.saidDone,
      (done.timeline.find((x) => /update complete/i.test(x.detail)) || {}).detail || 'never shown');
    check('update: card closed itself within 6s of opening',
      !!(done.chipAt && done.openedAt && done.chipAt.t - done.openedAt.t <= 6000),
      done.chipAt ? 'closed ' + (done.chipAt.t - done.openedAt.t) + 'ms after opening' : 'still a card after 26s');
    check('update: card stayed closed as more frames arrived', !!done.chipAt && !done.reopenedAt,
      done.reopenedAt ? 're-opened ' + done.reopenedAt + 'ms after closing' : 'no re-open in the 7s after closing');

    // ── B: a running build must keep the card open ───────────────────────
    const running = await runScenario(browser, {
      state: 'RUNNING', status: 'running', percent: 42, startedAt: nowIso,
      buildId: 'applet-close-verifier-b', label: 'Building', delayMs: 12000,
      stage: { id: 'build', label: 'build' },
    }, 'running build');
    check('running build: applet opened for the build', !!running.openedAt,
      running.openedAt ? 'card opened at ' + running.openedAt.t + 'ms' : 'applet stayed away');
    // ── C: a new page build (the ordinary update) must announce itself ────
    const pageBuild = await runScenario(browser, {
      state: 'IDLE', label: 'Idle · no build running', delayMs: 12000,
      versionBuild: '2099-01-01T00:00:00.000Z',
    }, 'new page build');
    check('new page build: applet opened with the update offer', !!pageBuild.openedAt,
      pageBuild.openedAt ? 'card opened at ' + pageBuild.openedAt.t + 'ms' : 'applet stayed away');
    check('new page build: card says an update is available',
      pageBuild.timeline.some((x) => /update available|new page build|update now/i.test(x.detail) || x.state === 'ready'),
      (pageBuild.timeline.find((x) => x.state === 'ready') || {}).detail || 'never shown');
    check('running build: card stays open (no early close)', !!running.openedAt && !running.chipAt,
      running.chipAt ? 'docked at ' + running.chipAt.t + 'ms — too early' : 'still a card at the end');

    // ── D: a queued server update must announce itself ────────────────────
    const queued = await runScenario(browser, {
      state: 'IDLE', label: 'Idle · no build running', delayMs: 12000, queued: true,
    }, 'queued update');
    check('queued update: applet opened itself', !!queued.openedAt,
      queued.openedAt ? 'card opened at ' + queued.openedAt.t + 'ms' : 'the applet stayed away');
    check('queued update: card says the update is queued',
      queued.timeline.some((x) => /update queued/i.test(x.detail)),
      (queued.timeline.find((x) => /update queued/i.test(x.detail)) || {}).detail || 'never shown');
    check('queued update: card stays open while the update is outstanding', !queued.chipAt,
      queued.chipAt ? 'retracted at ' + queued.chipAt.t + 'ms — before the update ran' : 'still a card at the end');

    // ── E: the full lifecycle — queued, applying, done, retract ───────────
    const cycle = await runScenario(browser, {
      state: 'IDLE', label: 'Idle · no build running', delayMs: 12000, queued: true,
      applyAfterMs: 15000, applyForMs: 6000, watchMs: 40000,
    }, 'update cycle');
    const duringApply = cycle.timeline.filter((x) => x.t > 16000 && x.t < 20000);
    check('update cycle: card opened when the update queued', !!cycle.openedAt,
      cycle.openedAt ? 'card opened at ' + cycle.openedAt.t + 'ms' : 'the applet stayed away');
    check('update cycle: card stayed open through the apply', duringApply.length > 0 && duringApply.every((x) => x.mode === 'card'),
      duringApply.length ? 'mode ' + duringApply.map((x) => x.mode).join(',') : 'no samples during the apply');
    check('update cycle: card retracted after the update finished', !!cycle.chipAt,
      cycle.chipAt ? 'retracted at ' + cycle.chipAt.t + 'ms, ' + (cycle.chipAt.t - (cycle.openedAt ? cycle.openedAt.t : 0)) + 'ms after opening' : 'still a card at the end');

    const fails = checks.filter((c) => !c.ok);
    console.log(`\n${checks.length - fails.length}/${checks.length} checks passed`);
    process.exitCode = fails.length ? 1 : 0;
  } catch (e) {
    console.error('verifier crashed:', e.message);
    process.exitCode = 2;
  } finally {
    clearTimeout(hardStop);
    try { await browser.close(); } catch (_) {}
  }
})();
