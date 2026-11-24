/* Probe: the reasoning transcript is taller now that the middle live box is
 * gone. Owner, 2026-11-24: "make our reasoning panel replace live middle to be
 * taller".
 *
 * Streams a 40-line answer into the real App at 120x40 and counts how many of
 * those lines the transcript can show. Before the change the column shared its
 * leftover rows between the ▶ Result strip and the transcript (the strip took
 * 35 %, capped at 18); the transcript now owns all of it, so a fixed 40-row
 * window must show the same 40-line answer at least as fully as the strip ever
 * allowed — and definitely more than the strip's own cap.
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
const LINES = Array.from({ length: 40 }, (_, i) => `reasoning line ${i + 1}`);
const stream = () => new ReadableStream({
  start(controller) {
    controller.enqueue(enc.encode(`data: ${JSON.stringify({ type: 'delta', content: LINES.join('\n') })}\n\n`));
    controller.enqueue(enc.encode(`data: ${JSON.stringify({ type: 'done', model: 'glm-5.2:cloud', provider: 'ollama', inputTokens: 10, outputTokens: 5 })}\n\n`));
    controller.close();
  },
});

globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/api/tui/status')) return new Response(JSON.stringify({ phase: 'ACT', connected: true, model: 'glm-5.2:cloud', trust: 3, tokens: 41000 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (u.includes('/api/agent/mcp-status')) return new Response(JSON.stringify({ servers: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (u.includes('/api/agent/run')) return new Response(stream(), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  if (u.includes('/api/ads')) return new Response(JSON.stringify({ creatives: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
};

const setup = await createTestRenderer({ width: 120, height: 40 });
const root = createRoot(setup.renderer);
flushSync(() => root.render(React.createElement(App, { version: 'probe' })));
await setup.flush();
await settle(500);
flushSync(() => { for (const ch of 'go') setup.mockInput.pressKey(ch); });
await setup.flush();
flushSync(() => setup.mockInput.pressEnter());
await settle(900);
await setup.flush();
const frame = setup.captureCharFrame();
const shown = frame.split('\n').filter((l) => /reasoning line \d+/.test(l)).length;
const middle = frame.split('\n').filter((l) => l.includes('▶ Live') || l.includes('▶ Result')).length;
const right = frame.split('\n').filter((l) => l.includes('◈ Live')).length;
console.log(`reasoning lines visible: ${shown}/40 · rightLive=${right} · middleLive=${middle}`);
console.log(frame.split('\n').map((l) => l.replace(/\s+$/, '')).join('\n'));
root.unmount();
const ok = right === 1 && middle === 0 && shown >= 18;
console.log(ok ? '\nPASS  one live panel on the right, transcript holds the tall box' : '\nFAIL  layout not as expected');
process.exit(ok ? 0 : 1);
