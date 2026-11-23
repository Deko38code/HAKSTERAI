import React from 'react';
process.env.HAKSTER_NO_INTRO = '1';
const { createTestRenderer } = await import('@opentui/core/testing');
const { createRoot, flushSync } = await import('@opentui/react');
const { default: App } = await import('../src/App.jsx');

const enc = new TextEncoder();
const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const ROWS = Number(process.env.PROBE_ROWS || 30);
const COLS = Number(process.env.PROBE_COLS || 120);

const bigResult = Array.from({ length: 30 }, (_, i) => `src/app/page.tsx:${i + 10}: some build output line ${i + 1}`).join('\n');
const events = [
  { type: 'phase', phase: 'ACT', turn: 1 },
  { type: 'delta', content: "I'll check the build output first, then patch the handler.\n\n" },
  { type: 'tool_call_start', tool_call_id: 'c1', tool_name: 'exec_shell', tool_args: { command: 'npm run build 2>&1 | tail -40' } },
  { type: 'tool_call_result', tool_call_id: 'c1', tool_name: 'exec_shell', tool_result: bigResult },
  { type: 'delta', content: 'Done — the handler is patched and the build passes.' },
  { type: 'done', model: 'glm-5.2:cloud', provider: 'ollama', inputTokens: 100, outputTokens: 20 },
];

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes('/api/tui/status')) return new Response(JSON.stringify({ phase: 'ACT', connected: true, model: 'glm-5.2:cloud', trust: 3, tokens: 41000 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (u.includes('/api/agent/mcp-status')) return new Response(JSON.stringify({ servers: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (u.includes('/api/agent/run')) {
    const stream = new ReadableStream({ async start(c) { for (const e of events) { c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`)); await new Promise((r) => setTimeout(r, 60)); } c.close(); } });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }
  if (u.includes('ads') || u.includes('/api/ads')) return new Response(JSON.stringify({ creatives: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
};

const setup = await createTestRenderer({ width: COLS, height: ROWS });
const root = createRoot(setup.renderer);
flushSync(() => root.render(React.createElement(App, { version: 'probe' })));
await setup.flush();
await settle(400);
flushSync(() => { for (const ch of 'check the build') setup.mockInput.pressKey(ch); });
await setup.flush();
flushSync(() => setup.mockInput.pressEnter());
await settle(900);
await setup.flush();
const frame = setup.captureCharFrame();
console.log(frame);
const seesText = frame.includes('I\'ll check the build output');
const seesTail = frame.includes('Done — the handler is patched');
const seesToolOutput = frame.includes('build output line');
console.log('\nRESULT text=' + seesText + ' tailText=' + seesTail + ' toolOut=' + seesToolOutput);
root.unmount(); setup.renderer.destroy();
