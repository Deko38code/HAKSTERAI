/* Probe: the chat frame must print the brand · state · file guard ONCE.
 * Owner, 2026-11-24: "you have dupes 13/13 files online".
 *
 * Renders the real App on the chat view and counts how many rows carry the
 * guard text. Two = the header and the status box both drew it (the dupe).
 */
import React from 'react';
process.env.HOME = '/tmp/probe-home';
process.env.HAKSTER_NO_INTRO = '1';
process.env.HAKSTER_NO_HISTORY = '1';
const { createTestRenderer } = await import('@opentui/core/testing');
const { createRoot, flushSync } = await import('@opentui/react');
const { default: App } = await import('../src/App.jsx');
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/api/tui/status')) return new Response(JSON.stringify({ phase: 'ACT', connected: true, model: 'glm-5.2:cloud', trust: 3, tokens: 41000 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (u.includes('/api/agent/mcp-status')) return new Response(JSON.stringify({ servers: [{ name: 'filesystem', toolCount: 12, initialized: true }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (u.includes('/api/ads')) return new Response(JSON.stringify({ creatives: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
};

for (const [cols, rows] of [[120, 34], [120, 50], [80, 30]]) {
  const setup = await createTestRenderer({ width: cols, height: rows });
  const root = createRoot(setup.renderer);
  flushSync(() => root.render(React.createElement(App, { version: 'probe' })));
  await setup.flush();
  await settle(500);
  await setup.flush();
  const frame = setup.captureCharFrame();
  const lines = frame.split('\n').map((l) => l.replace(/\s+$/, ''));
  const guardRows = lines.filter((l) => /\d+\/\d+ files/.test(l));
  const onlineRows = lines.filter((l) => /ONLINE/.test(l));
  console.log(`\n──── chat ${cols}x${rows} · rows-with-guard=${guardRows.length} · rows-with-ONLINE=${onlineRows.length} ────`);
  guardRows.forEach((l) => console.log(`  guard:  ${l.trim()}`));
  onlineRows.forEach((l) => console.log(`  online: ${l.trim()}`));
  if (cols === 120 && rows === 34) {
    console.log('\n' + lines.slice(0, 8).join('\n'));
  }
  root.unmount();
}
process.exit(0);
