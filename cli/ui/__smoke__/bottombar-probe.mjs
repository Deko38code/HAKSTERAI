import React from 'react';
process.env.HAKSTER_NO_INTRO = '1';
const { createTestRenderer } = await import('@opentui/core/testing');
const { createRoot, flushSync } = await import('@opentui/react');
const { default: App } = await import('../src/App.jsx');

const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const ROWS = Number(process.env.PROBE_ROWS || 40);
const COLS = Number(process.env.PROBE_COLS || 120);

globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/api/tui/status')) return new Response(JSON.stringify({ phase: 'ACT', connected: true, model: 'glm-5.2:cloud', trust: 3, tokens: 41000, user: { username: 'ghost' } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (u.includes('/api/agent/mcp-status')) return new Response(JSON.stringify({ servers: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (u.includes('/api/agent/mcp-output')) return new Response(JSON.stringify({ output: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (u.includes('ads') || u.includes('/api/ads')) return new Response(JSON.stringify({ creatives: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
};

const setup = await createTestRenderer({ width: COLS, height: ROWS });
const root = createRoot(setup.renderer);
flushSync(() => root.render(React.createElement(App, { version: 'probe' })));
await setup.flush();
await settle(500);
const frame = setup.captureCharFrame();
const lines = frame.split('\n');
console.log('FRAME ROWS=' + ROWS + ' capturedLines=' + lines.length);
lines.forEach((l, i) => console.log(String(i).padStart(2) + '|' + l.replace(/\x1b\[[0-9;]*m/g, '')));
console.log('\nRESULT lines=' + lines.length);
root.unmount(); setup.renderer.destroy();
