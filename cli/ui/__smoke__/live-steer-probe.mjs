#!/usr/bin/env bun
/* Live-steering probe.
 *
 * Checks the one thing the queue can't: a message typed while a run streams
 * must be handed to THAT run (POST /api/agent/steer naming the run's id) and
 * must NOT sit in the queue waiting for the run to end. A refusal has to fall
 * back to the queue, because nothing typed may ever be dropped.
 *
 * Run: bun ui/__smoke__/live-steer-probe.mjs
 */
import React from 'react';
process.env.HAKSTER_NO_INTRO = '1';
const { createTestRenderer } = await import('@opentui/core/testing');
const { createRoot, flushSync } = await import('@opentui/react');
const { default: App } = await import('../src/App.jsx');

const enc = new TextEncoder();
const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const ROWS = Number(process.env.PROBE_ROWS || 40);
const COLS = Number(process.env.PROBE_COLS || 140);
const STEER_OK = process.env.PROBE_STEER_REFUSE !== '1';

let release;
const gate = new Promise((r) => { release = r; });
const seen = { runBody: null, steers: [], runIdMatched: null };

const events = [
  { type: 'phase', phase: 'THINK', turn: 1 },
  { type: 'thinking', content: 'weighing the options' },
  { type: 'delta', content: 'Working on the first half. ' },
];

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.includes('/api/tui/status')) {
    return new Response(JSON.stringify({ phase: 'ACT', connected: true, model: 'phantom-flash', trust: 3, tokens: 1000 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (u.includes('/api/agent/mcp-status')) return new Response(JSON.stringify({ servers: [] }), { status: 200 });
  if (u.includes('/api/agent/steer')) {
    const body = JSON.parse(init.body || '{}');
    seen.steers.push(body);
    seen.runIdMatched = !!seen.runBody && seen.runBody.runId === body.runId;
    if (!STEER_OK) return new Response(JSON.stringify({ ok: false, error: 'no active run' }), { status: 409, headers: { 'Content-Type': 'application/json' } });
    // Echo it back the way the server does when the next round drains it.
    return new Response(JSON.stringify({ ok: true, queued: 1 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (u.includes('/api/agent/run')) {
    seen.runBody = JSON.parse(init.body || '{}');
    const stream = new ReadableStream({
      async start(c) {
        for (const e of events) { c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`)); await settle(30); }
        // what the server emits when it applies a steer on the next round
        if (STEER_OK) {
          c.enqueue(enc.encode(`data: ${JSON.stringify({ type: 'steer', content: 'and also check the logs' })}\n\n`));
        }
        await gate;
        c.enqueue(enc.encode(`data: ${JSON.stringify({ type: 'delta', content: 'Steered.' })}\n\n`));
        c.enqueue(enc.encode(`data: ${JSON.stringify({ type: 'done', model: 'phantom-flash', provider: 'ollama', inputTokens: 10, outputTokens: 5 })}\n\n`));
        c.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }
  return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
};

const setup = await createTestRenderer({ width: COLS, height: ROWS });
const root = createRoot(setup.renderer);
flushSync(() => root.render(React.createElement(App, { version: 'probe' })));
await setup.flush();
await settle(300);

// 1) start a run
flushSync(() => { for (const ch of 'start the job') setup.mockInput.pressKey(ch); });
flushSync(() => setup.mockInput.pressEnter());
await settle(500);
await setup.flush();

// 2) type into the composer WHILE busy and submit
flushSync(() => { for (const ch of 'and also check the logs') setup.mockInput.pressKey(ch); });
flushSync(() => setup.mockInput.pressEnter());
await settle(400);
await setup.flush();

const frame = setup.captureCharFrame();
const lines = frame.split('\n');
const lastNonEmpty = lines.reduce((a, l, i) => (l.trim() ? i : a), -1);

// 3) release the run so the harness can finish cleanly
release();
await settle(400);
await setup.flush();

const result = {
  ROWS,
  mode: STEER_OK ? 'delivered' : 'refused',
  runIdSent: !!seen.runBody?.runId,
  steerRequests: seen.steers.length,
  runIdMatched: seen.runIdMatched,
  noticeSent: frame.includes('↳ steer sent'),
  noticeQueued: /⏳ steer queued/.test(frame),
  steerRenderedInTranscript: frame.includes('and also check the logs'),
  noOverflow: lastNonEmpty <= ROWS - 1,
};
console.log(JSON.stringify(result, null, 2));

root.unmount();
setup.renderer.destroy();

const pass = STEER_OK
  ? result.runIdSent && result.steerRequests === 1 && result.runIdMatched && result.noticeSent && !result.noticeQueued && result.steerRenderedInTranscript && result.noOverflow
  : result.steerRequests === 1 && result.noticeQueued && result.noOverflow;
process.exit(pass ? 0 : 1);
