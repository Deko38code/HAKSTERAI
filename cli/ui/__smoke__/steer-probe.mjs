import React from 'react';
process.env.HAKSTER_NO_INTRO = '1';
const { createTestRenderer } = await import('@opentui/core/testing');
const { createRoot, flushSync } = await import('@opentui/react');
const { default: App } = await import('../src/App.jsx');

const enc = new TextEncoder();
const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const ROWS = Number(process.env.PROBE_ROWS || 34);
const COLS = Number(process.env.PROBE_COLS || 140);

// A SLOW stream: the run stays busy long enough to type into the composer and
// watch the steer queue take the text.
let release;
const gate = new Promise((r) => { release = r; });
const events = [
  { type: 'phase', phase: 'THINK', turn: 1 },
  { type: 'thinking', content: 'weighing the options' },
  { type: 'delta', content: 'Working on the first half of the answer. ' },
];
const events2 = [
  { type: 'delta', content: 'Second turn answering the steer.' },
  { type: 'done', model: 'phantom-flash', provider: 'ollama', inputTokens: 10, outputTokens: 5 },
];

globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/api/tui/status')) return new Response(JSON.stringify({ phase: 'ACT', connected: true, model: 'phantom-flash', trust: 3, tokens: 1000 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (u.includes('/api/agent/mcp-status')) return new Response(JSON.stringify({ servers: [] }), { status: 200 });
  if (u.includes('/api/agent/run')) {
    const first = !globalThis.__second;
    globalThis.__second = true;
    const stream = new ReadableStream({
      async start(c) {
        for (const e of first ? events : events2) {
          c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
          await settle(40);
        }
        if (first) await gate;   // hold the run open while the operator types
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

// 1. start a run
flushSync(() => { for (const ch of 'start the job') setup.mockInput.pressKey(ch); });
flushSync(() => setup.mockInput.pressEnter());
await settle(600);
await setup.flush();

const busyFrame = setup.captureCharFrame();
const busyLines = busyFrame.split('\n');

// 2. type and enter WHILE BUSY -> must enqueue, not be dropped
flushSync(() => { for (const ch of 'and also check logs') setup.mockInput.pressKey(ch); });
await setup.flush();
const typedFrame = setup.captureCharFrame();
const composerShowsDraft = typedFrame.includes('and also check logs');

flushSync(() => setup.mockInput.pressEnter());
await settle(200);
await setup.flush();
const queuedFrame = setup.captureCharFrame();
const showsQueued = /⏳\s*1 queued/.test(queuedFrame);

// 3. release the run -> the queue drains itself into a second turn
release();
await settle(900);
await setup.flush();
const doneFrame = setup.captureCharFrame();

// 4. geometry: the spinner must sit BELOW the composer input row, and the
//    status bar must be the very last non-empty row.
const rowOf = (frame, needle) => frame.split('\n').findIndex((l) => l.includes(needle));
const inputRow = rowOf(busyFrame, '›');
const spinnerRow = rowOf(busyFrame, '⟦');
const statusRow = rowOf(busyFrame, 'ready') >= 0 ? rowOf(busyFrame, 'ready') : rowOf(busyFrame, 'working…');
const lastNonEmpty = busyFrame.split('\n').reduce((acc, l, i) => (l.trim() ? i : acc), -1);
const frameRows = busyFrame.split('\n').length;

console.log(busyFrame);
console.log('---');
console.log(JSON.stringify({
  ROWS,
  frameRows,
  inputRow,
  spinnerRow,
  spinnerUnderInput: spinnerRow > inputRow,
  statusRow,
  statusIsLast: statusRow === lastNonEmpty,
  composerShowsDraft,
  showsQueued,
  drainedSecondTurn: doneFrame.includes('Second turn answering the steer'),
  busyLines: busyLines.length,
}, null, 2));
root.unmount();
setup.renderer.destroy();
