/* Pin for the server-restart notice (owner, 2026-11-24: "if server drops after
 * updates").
 *
 * A server restart after an update is the expected outcome, but from the
 * operator's chair it used to look exactly like a crash: the panels went
 * OFFLINE and then quietly came back. The TUI now names the cause using the
 * server's own build stamp (`server.build` in /api/version):
 *
 *   C. port dropped, build CHANGED → "server updated — restarted in Ns · build X"
 *   C2. build changed, no drop seen → "server updated — now on · build X"
 *       (PM2 respawns in ~1 s, faster than the 3 s poll; an update must still be
 *       reported, and no downtime is claimed because none was measured)
 *   D. port dropped, build UNCHANGED → "server restarted — back in Ns · build X"
 *   E. no drop, same build → silence. A watch that talks while healthy is noise.
 *   F. drop during a run → silence. The turn prints its own reconnecting /
 *      resending lines; a second story about the same restart would read as two
 *      failures.
 *
 * Asserted on the transcript row, not the toast: the toast is gone in six
 * seconds, the row is the record (§10 — say only what was measured, once).
 *
 * Runs under Bun: `bun ui/__smoke__/server-restart-probe.mjs`.
 */
import React from 'react';
process.env.HOME = '/tmp/probe-home';
process.env.HAKSTER_NO_INTRO = '1';
process.env.HAKSTER_NO_HISTORY = '1';
const { createTestRenderer } = await import('@opentui/core/testing');
const { createRoot, flushSync } = await import('@opentui/react');
const { default: App } = await import('../src/App.jsx');

const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = new TextEncoder();

const OLD = '2026-11-24T06:00:00.000Z';
const NEW = '2026-11-24T06:31:42.635Z';
let serverBuild = OLD;
let downUntil = 0;
let runCalls = 0;
let turnMs = 200;

const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
const down = () => new Response('down', { status: 503 });
const sse = (controller, f) => controller.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`));

function slowTurn() {
  return new ReadableStream({
    start(controller) {
      sse(controller, { type: 'phase', phase: 'ACT', turn: 1 });
      sse(controller, { type: 'delta', content: 'work finished' });
      setTimeout(() => {
        sse(controller, { type: 'done', model: 'glm-5.2:cloud', provider: 'ollama', inputTokens: 500, outputTokens: 40 });
        controller.close();
      }, turnMs);
    },
  });
}

globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/api/agent/run')) {
    runCalls += 1;
    return new Response(slowTurn(), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }
  // While the process is down every route refuses, version included.
  if (Date.now() < downUntil) {
    if (u.includes('/api/tui/status') || u.includes('/api/version')) return down();
  }
  if (u.includes('/api/tui/status')) {
    return json({ phase: 'IDLE', connected: true, model: 'glm-5.2:cloud', trust: 3, tokens: 41000 });
  }
  if (u.includes('/api/version')) {
    return json({ build: 'web-probe', server: { build: serverBuild, stale: false, pending: 0, applying: false, cliAttached: false } });
  }
  return json({ servers: [], creatives: [] });
};

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass += 1; console.log(`  ok  ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

async function mount() {
  const setup = await createTestRenderer({ width: 120, height: 40 });
  const root = createRoot(setup.renderer);
  flushSync(() => root.render(React.createElement(App, { version: 'probe' })));
  await setup.flush();
  await settle(600); // first tick records the baseline build
  await setup.flush();
  const frame = () => setup.captureCharFrame().split('\n').map((l) => strip(l)).join('\n');
  return { setup, root, frame };
}

/** Wait until `re` appears in a frame, or give up. */
async function waitFor(frame, re, tries = 70) {
  for (let i = 0; i < tries; i += 1) {
    await settle(80);
    if (re.test(frame())) return true;
  }
  return false;
}

const rows = (text, re) => text.split('\n').filter((l) => re.test(l)).length;
/** How many times the phrase appears at all — toast plus transcript row — and,
 *  once the six-second toast has faded, the transcript row by itself. The row
 *  is the record; the toast is the moment. */
const hits = (text, re) => (text.match(new RegExp(re.source, 'g')) || []).length;
async function afterToast(frame, noticedAt, re) {
  const wait = noticedAt + 6600 - Date.now();
  if (wait > 0) await settle(wait);
  return frame();
}

const reset = () => { serverBuild = OLD; downUntil = 0; runCalls = 0; turnMs = 200; };

async function outageWithNewBuild() {
  reset();
  const { setup, root, frame } = await mount();
  // The update lands and the process restarts; the port refuses across the
  // next healthy tick so the drop is actually observed.
  serverBuild = NEW;
  downUntil = Date.now() + 2600;
  const seen = await waitFor(frame, /server updated/);
  const noticedAt = Date.now();
  await settle(200);
  await setup.flush();
  const end = frame();

  check('C: a changed build after a drop is announced as an update', seen);
  check('C: the notice also reached the status toast', hits(end, /server updated/) >= 2, `hits=${hits(end, /server updated/)}`);
  check('C: it names the new build stamp', /build 06:31:42/.test(end), end.split('\n').find((l) => /server updated/.test(l)));
  check('C: the downtime it prints was measured', /restarted in \d+\.\ds/.test(end));
  check('C: it does not claim a plain restart', !/server restarted/.test(end));

  // One row, not one per tick: the toast repeats the phrase while it is up, so
  // the row is counted after the toast has faded, and again after another tick.
  const quiet = await afterToast(frame, noticedAt, /server updated/);
  check('C: exactly one transcript row', rows(quiet, /server updated/) === 1, `rows=${rows(quiet, /server updated/)}`);
  await settle(3300);
  check('C: silent once healthy again', rows(frame(), /server (?:updated|restarted)/) === 1);

  root.unmount();
  setup.renderer.destroy();
}

async function fastUpdateNoDrop() {
  reset();
  const { setup, root, frame } = await mount();
  // The real-world case: the respawn is quicker than a tick, so the port never
  // looks down. The build stamp is the only evidence, and it is enough.
  serverBuild = NEW;
  const seen = await waitFor(frame, /server updated/);
  const noticedAt = Date.now();
  await settle(200);
  await setup.flush();
  const end = frame();

  check('C2: an update too fast to see drop is still reported', seen);
  check('C2: it names the build', /build 06:31:42/.test(end));
  check('C2: it invents no downtime it did not measure', !/restarted in/.test(end) && /now on/.test(end));
  const quiet = await afterToast(frame, noticedAt, /server updated/);
  check('C2: exactly one transcript row', rows(quiet, /server updated/) === 1, `rows=${rows(quiet, /server updated/)}`);

  root.unmount();
  setup.renderer.destroy();
}

async function restartSameBuild() {
  reset();
  const { setup, root, frame } = await mount();
  downUntil = Date.now() + 2600; // bounced, same code
  const seen = await waitFor(frame, /server restarted/);
  const noticedAt = Date.now();
  await settle(200);
  await setup.flush();
  const end = frame();

  check('D: an unchanged build after a drop is a restart, not an update', seen);
  check('D: it says how long it was gone and which build came back', /back in \d+\.\ds/.test(end) && /build 06:00:00/.test(end));
  check('D: it never claims an update', !/server updated/.test(end));
  const quiet = await afterToast(frame, noticedAt, /server restarted/);
  check('D: exactly one transcript row', rows(quiet, /server restarted/) === 1, `rows=${rows(quiet, /server restarted/)}`);

  root.unmount();
  setup.renderer.destroy();
}

async function healthySilence() {
  reset();
  const { setup, root, frame } = await mount();
  await settle(3600); // more than one healthy tick
  await setup.flush();
  const t = frame();
  check('E: no restart line while the server stays up', !/server (?:updated|restarted)/.test(t));
  check('E: the panels still read the server as online', /ONLINE|server online/.test(t));
  root.unmount();
  setup.renderer.destroy();
}

async function restartDuringRun() {
  reset();
  turnMs = 6000; // the run outlives the restart
  const { setup, root, frame } = await mount();

  flushSync(() => { for (const ch of 'do the thing') setup.mockInput.pressKey(ch); });
  await setup.flush();
  await settle(60);
  flushSync(() => setup.mockInput.pressEnter());
  await settle(1800);

  downUntil = Date.now() + 3000; // the bounce lands across a tick, mid-run
  const finished = await waitFor(frame, /work finished/, 80);
  await settle(500);
  await setup.flush();
  const end = frame();

  check('F: the run started and finished', finished && runCalls === 1, `runCalls=${runCalls}`);
  check('F: the watch stays silent during a run (the turn tells its own story)', !/server (?:updated|restarted)/.test(end));

  root.unmount();
  setup.renderer.destroy();
}

await outageWithNewBuild();
await fastUpdateNoDrop();
await restartSameBuild();
await healthySilence();
await restartDuringRun();

console.log(`\nRESULT pass=${pass} fail=${fail}`);
if (fail) process.exitCode = 1;
