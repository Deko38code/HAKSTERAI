/* Regression pin for TUI auto-reconnect (owner, 2026-11-24: "and add auto
 * reconnect in tui").
 *
 * A server restart refuses the connection for a few seconds. Before this, the
 * turn died with a red error and the operator had to retype it. The behaviour
 * has to be right in two opposite directions, so both are asserted here:
 *
 *   A. NOTHING PRODUCED → the turn is resent. The connection drop is followed
 *      by the port coming back, the same turn goes out again, the status bar
 *      says "reconnecting…" while waiting, the transcript explains what
 *      happened, and the answer lands exactly once.
 *
 *   B. SOMETHING PRODUCED → the turn is NOT resent. Once prose has been shown,
 *      replaying it would duplicate work the operator watched happen, so the
 *      run keeps what it has and reports the failure. One request only.
 *
 * Runs under Bun (`bun ui/__smoke__/reconnect-probe.mjs`) — @opentui/core loads
 * a native binary through Bun's FFI.
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

/* Probe-wide mock state. `mode` picks the scenario; `runCalls` is the number of
 * POSTs that actually reached /api/agent/run — the assertion for "was the turn
 * resent?" is exactly this number. */
let mode = 'A';
let runCalls = 0;
let downUntil = 0;

function sse(controller, f) {
  controller.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`));
}

/** A complete turn: one prose delta, then the done frame. */
function cleanTurn() {
  return new ReadableStream({
    start(controller) {
      sse(controller, { type: 'phase', phase: 'ACT', turn: 1 });
      sse(controller, { type: 'delta', content: 'answer after reconnect' });
      setTimeout(() => {
        sse(controller, { type: 'done', model: 'glm-5.2:cloud', provider: 'ollama', inputTokens: 900, outputTokens: 120 });
        controller.close();
      }, 120);
    },
  });
}

/** A turn that prints prose and THEN loses the socket. */
const PROSE = 'partial answer before the drop';
function brokenTurn() {
  return new ReadableStream({
    start(controller) {
      sse(controller, { type: 'delta', content: PROSE });
      setTimeout(() => controller.error(new TypeError('fetch failed')), 80);
    },
  });
}

globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/api/agent/run')) {
    runCalls += 1;
    // Scenario A, first dispatch: the server is not listening at all.
    if (mode === 'A' && runCalls === 1) {
      downUntil = Date.now() + 400; // keep the port down long enough to observe
      throw new TypeError('fetch failed');
    }
    if (mode === 'B') return new Response(brokenTurn(), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    return new Response(cleanTurn(), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }
  if (u.includes('/api/tui/status')) {
    if (Date.now() < downUntil) return new Response('down', { status: 503 });
    return new Response(JSON.stringify({ phase: 'IDLE', connected: true, model: 'glm-5.2:cloud', trust: 3, tokens: 41000 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (u.includes('/api/agent/mcp-status') || u.includes('/api/ads')) {
    return new Response(JSON.stringify({ servers: [], creatives: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
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
  await settle(500);
  await setup.flush();
  return { setup, root };
}

const send = async (setup) => {
  flushSync(() => { for (const ch of 'do the thing') setup.mockInput.pressKey(ch); });
  await setup.flush();
  await settle(60);
  flushSync(() => setup.mockInput.pressEnter());
};

async function scenarioA() {
  mode = 'A';
  runCalls = 0;
  downUntil = 0;
  const { setup, root } = await mount();
  const frame = () => setup.captureCharFrame().split('\n').map((l) => strip(l)).join('\n');

  await send(setup);
  // Sample the frames across the whole drop-and-resend window.
  let sawReconnecting = false;
  let sawGone = false;
  for (let i = 0; i < 60; i += 1) {
    await settle(40);
    await setup.flush();
    const t = frame();
    if (/reconnecting…/.test(t)) sawReconnecting = true;
    if (/server went away/.test(t)) sawGone = true;
  }
  await settle(600);
  await setup.flush();
  const end = frame();

  check('A: the turn was resent after the port came back', runCalls === 2, `runCalls=${runCalls}`);
  check('A: status bar showed "reconnecting…" while waiting', sawReconnecting);
  check('A: transcript said the server went away', sawGone);
  check('A: transcript confirmed the resend', /reconnected — resending/.test(end));
  // The side Output panel mirrors the newest assistant line inside its own
  // narrow column, so only transcript-width rows count as messages; a resent
  // turn would show a second wide row.
  const answerRows = end
    .split('\n')
    .filter((l) => l.includes('answer after reconnect') && l.trim().length > 40);
  check('A: the answer landed exactly once (one transcript row)', answerRows.length === 1, `rows=${answerRows.length}`);
  check('A: no error state left behind', !/\berror\b/.test(end) && /\bready\b/.test(end));

  root.unmount();
  setup.renderer.destroy();
}

async function scenarioB() {
  mode = 'B';
  runCalls = 0;
  downUntil = 0;
  const { setup, root } = await mount();
  const frame = () => setup.captureCharFrame().split('\n').map((l) => strip(l)).join('\n');

  await send(setup);
  await settle(1200);
  await setup.flush();
  const end = frame();

  check('B: a turn that already produced output is NOT resent', runCalls === 1, `runCalls=${runCalls}`);
  check('B: the prose that was already shown is kept', end.includes(PROSE));
  check('B: the failure is reported', /\berror\b/.test(end));
  check('B: nothing claims a reconnect', !/reconnecting…/.test(end));

  root.unmount();
  setup.renderer.destroy();
}

await scenarioA();
await scenarioB();

console.log(`\nRESULT pass=${pass} fail=${fail}`);
if (fail) process.exitCode = 1;
