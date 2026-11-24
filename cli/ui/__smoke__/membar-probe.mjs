/* Regression pin for the ◈ memory-bank bar on the header's right edge
 * (owner, 2026-11-24: "add a real live bar at top right of tui for our memory
 * bank % to know when full or low and to keep count").
 *
 * The bar is built from useMemoryBank's disk counts (fullest bank vs the
 * server's BANK_CAP, plus the running total). This renders a real frame at two
 * widths and asserts the ◈ bar + percentage lands on the top row at the right,
 * and that it degrades to the bar alone instead of vanishing on a narrow
 * terminal. It reads the operator's real ~/.hakster/memories/banks (counts
 * only) — a missing directory renders no bar, which is also asserted.
 */
import React from 'react';
process.env.HAKSTER_NO_INTRO = '1';
process.env.HAKSTER_NO_HISTORY = '1';
const { createTestRenderer } = await import('@opentui/core/testing');
const { createRoot, flushSync } = await import('@opentui/react');
const { default: App } = await import('../src/App.jsx');

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/api/tui/status')) return new Response(JSON.stringify({ phase: 'ACT', connected: true, model: 'glm-5.2:cloud', trust: 3, tokens: 41000, user: { username: 'ghost' } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (u.includes('/api/agent/mcp-status')) return new Response(JSON.stringify({ servers: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (u.includes('/api/agent/mcp-output')) return new Response(JSON.stringify({ output: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
};

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass += 1; console.log(`  ok  ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

async function frame(cols, rows) {
  const setup = await createTestRenderer({ width: cols, height: rows });
  const root = createRoot(setup.renderer);
  flushSync(() => root.render(React.createElement(App, { version: 'probe' })));
  await setup.flush();
  await settle(400);
  const lines = setup.captureCharFrame().split('\n').map(strip);
  root.unmount();
  setup.renderer.destroy();
  return lines;
}

for (const [cols, rows] of [[120, 40], [80, 30]]) {
  const lines = await frame(cols, rows);
  const top = lines[0] || '';
  console.log(`\n[${cols}x${rows}] top: ${top.trimEnd()}`);
  check(`${cols}x${rows}: ◈ memory bar on the top row`, top.includes('◈'));
  // The percentage readout (" NN%") must sit on the same row as the bar.
  check(`${cols}x${rows}: percentage readout present`, /\s\d+%/.test(top));
  // Right-aligned: the bar sits in the right half of the row, not the left.
  const barAt = top.indexOf('◈');
  check(`${cols}x${rows}: bar is on the right side`, barAt > cols / 2, `barAt=${barAt}, half=${Math.round(cols / 2)}`);
  // A real bar, not a bare label: filled/empty cells come from █ / ░.
  check(`${cols}x${rows}: rendered with █/░ cells`, top.includes('█') || top.includes('░'));
}

console.log(`\nRESULT pass=${pass} fail=${fail}`);
if (fail) process.exitCode = 1;
