/* Regression pin for the ◇ Debugger page (owner, 2026-11-24: "add debugger to").
 *
 * The page is only worth having if three things hold, and each of them is a way
 * it can silently go wrong:
 *
 *   1. it is reachable with /debug and it renders its real sections — a page
 *      that opens empty is worse than no page;
 *   2. the numbers are MEASURED: app renders are counted (every render), and
 *      the event-loop lag timer is running while the page is open, so both
 *      buffers hold real samples with finite values;
 *   3. the cost rule holds: the lag timer runs ONLY while the page is open. If
 *      it kept ticking after esc, the debugger would be taxing the thing it
 *      measures — that is the bug this check exists for.
 *
 * Runs under Bun (`bun ui/__smoke__/debug-probe.mjs`) — @opentui/core loads a
 * native binary through Bun's FFI.
 */
import React from 'react';
process.env.HOME = '/tmp/probe-home';
process.env.HAKSTER_NO_INTRO = '1';
process.env.HAKSTER_NO_HISTORY = '1';
const { createTestRenderer } = await import('@opentui/core/testing');
const { createRoot, flushSync } = await import('@opentui/react');
const { default: App } = await import('../src/App.jsx');
// The same module instance App records into, so the probe reads the buffers the
// page is showing rather than a second, empty copy.
const metrics = await import('../src/utils/debug-metrics.js');

const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass += 1; console.log(`  ok  ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/api/version')) {
    return new Response(JSON.stringify({
      build: 'PROBEBUILD1',
      server: { build: 'SRVPROBE', stale: true, pending: 2, idle: false, applying: false, cliAttached: true, holdReason: 'CLI session attached' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (u.includes('/api/tui/status')) {
    return new Response(JSON.stringify({ phase: 'IDLE', connected: true, model: 'glm-5.2:cloud', trust: 12, tokens: 41000 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return new Response(JSON.stringify({ servers: [], creatives: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

async function run(cols, rows) {
  const setup = await createTestRenderer({ width: cols, height: rows });
  const root = createRoot(setup.renderer);
  flushSync(() => root.render(React.createElement(App, { version: 'probe' })));
  await setup.flush();
  await settle(700);
  await setup.flush();
  const frame = () => setup.captureCharFrame().split('\n').map((l) => strip(l).replace(/\s+$/, ''));

  check(`${cols}x${rows}: debugger absent before it is opened`, frame().filter((l) => l.includes('◇ Debugger')).length === 0);

  // Open it the way the operator does: type the command, press enter.
  flushSync(() => { for (const ch of '/debug') setup.mockInput.pressKey(ch); });
  await setup.flush();
  flushSync(() => setup.mockInput.pressEnter());
  await settle(400);
  await setup.flush();

  const top = frame();
  const topJoined = top.join('\n');
  check(`${cols}x${rows}: /debug opens the debugger`, topJoined.includes('◇ Debugger'));
  check(`${cols}x${rows}: top sections render`, topJoined.includes('▸ RENDER') && topJoined.includes('▸ EVENT LOOP'));
  check(`${cols}x${rows}: nothing on the top of the page exceeds the width`, top.every((l) => l.length <= cols), `widest=${Math.max(...top.map((l) => l.length))}`);

  // The page is taller than a short terminal on purpose: it scrolls like the
  // dashboard (§ all-panels rule), so the bottom half is reached with end
  // rather than clipped. Asserting the whole page from ONE frame was wrong —
  // this is the check that caught it.
  flushSync(() => setup.mockInput.pressKey('END'));
  await settle(300);
  await setup.flush();
  const bottom = frame();
  const joined = bottom.join('\n');
  for (const section of ['PROCESS', 'TERMINAL', 'SESSION', 'TOOLS', 'SERVER']) {
    check(`${cols}x${rows}: section ${section} renders after scrolling`, joined.includes(`▸ ${section}`));
  }
  check(`${cols}x${rows}: server section reports the live build`, joined.includes('PROBEBUILD1'), 'no build id on the page');
  check(`${cols}x${rows}: cli attach state is reported`, /cli attach/.test(joined) && /yes/.test(joined));
  check(`${cols}x${rows}: nothing at the bottom exceeds the width`, bottom.every((l) => l.length <= cols), `widest=${Math.max(...bottom.map((l) => l.length))}`);

  // Real samples: every App render is counted, and the lag timer is ticking.
  const r = metrics.renderStats();
  check(`${cols}x${rows}: renders were counted`, r.total > 0, `total=${r.total}`);
  check(`${cols}x${rows}: render samples are finite ms`, r.samples > 0 && Number.isFinite(r.p50) && Number.isFinite(r.max), JSON.stringify(r));
  await settle(1200);
  await setup.flush();
  const lagOpen = metrics.lagStats();
  check(`${cols}x${rows}: lag timer runs while the page is open`, lagOpen.total >= 5, `samples=${lagOpen.total}`);
  check(`${cols}x${rows}: lag samples are finite ms`, lagOpen.samples > 0 && Number.isFinite(lagOpen.p50), JSON.stringify(lagOpen));

  // The cost rule: closing the page stops the timer.
  flushSync(() => setup.mockInput.pressEscape());
  await settle(150);
  await setup.flush();
  check(`${cols}x${rows}: esc returns to the chat`, frame().filter((l) => l.includes('◇ Debugger')).length === 0);
  const lagClosed = metrics.lagStats().total;
  await settle(900);
  await setup.flush();
  check(`${cols}x${rows}: lag timer STOPS when the page is closed`, metrics.lagStats().total === lagClosed, `before=${lagClosed} after=${metrics.lagStats().total}`);

  // Reopen and prove `r` resets the counters (the page's own control).
  flushSync(() => { for (const ch of '/debug') setup.mockInput.pressKey(ch); });
  await setup.flush();
  flushSync(() => setup.mockInput.pressEnter());
  await settle(300);
  await setup.flush();
  const beforeReset = metrics.renderStats().total;
  flushSync(() => setup.mockInput.pressKey('r'));
  await settle(200);
  await setup.flush();
  const afterReset = metrics.renderStats().total;
  check(`${cols}x${rows}: r resets the counters`, afterReset < beforeReset, `before=${beforeReset} after=${afterReset}`);
  check(`${cols}x${rows}: page still shows after a reset`, frame().join('\n').includes('◇ Debugger'));

  root.unmount();
  setup.renderer.destroy();
}

await run(120, 40);
await run(80, 30);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
