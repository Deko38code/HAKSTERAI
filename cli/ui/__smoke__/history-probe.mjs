/* Input-history probe: does ↑/↓ walk the typed lines in the composer?
 *
 * Isolated install: HAKSTER_HOME points at a temp dir with a known history
 * file, so the probe never reads or writes the operator's real ~/.hakster.
 */
import React from 'react';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HAKSTER_NO_INTRO = '1';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-'));
fs.mkdirSync(tmp, { recursive: true });
const histFile = path.join(tmp, 'history');
const SEED = ['list the disks', 'restart the tunnel', 'check pm2 status'];
fs.writeFileSync(histFile, SEED.join('\n') + '\n');
process.env.HAKSTER_HOME = tmp;

const { createTestRenderer } = await import('@opentui/core/testing');
const { createRoot, flushSync } = await import('@opentui/react');
const { default: App } = await import('../src/App.jsx');

const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const ROWS = 34;
const COLS = 140;

globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/api/tui/status')) {
    return new Response(JSON.stringify({ phase: 'ACT', connected: true, model: 'phantom-flash', trust: 3, tokens: 1000 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (u.includes('/api/agent/mcp-status')) return new Response(JSON.stringify({ servers: [] }), { status: 200 });
  return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
};

const setup = await createTestRenderer({ width: COLS, height: ROWS });
const root = createRoot(setup.renderer);
flushSync(() => root.render(React.createElement(App, { version: 'probe' })));
await setup.flush();
await settle(300);

// The composer draws its draft on the line beginning with "› ".
const draftLine = (frame) => {
  const line = frame.split('\n').find((l) => l.includes('›'));
  if (!line) return '';
  const v = line.replace(/^.*?›\s*/, '').replace(/[\s│┃|]+$/, '').replace(/\s+/g, ' ').trim();
  // An empty draft renders the placeholder, which means "no draft".
  return /^describe a task…?$/.test(v) ? '' : v;
};
const step = async (fn) => { flushSync(fn); await setup.flush(); await settle(40); return draftLine(setup.captureCharFrame()); };

const results = {};
results.initial = await step(() => {});
results.up1 = await step(() => setup.mockInput.pressArrow('up'));   // newest
results.up2 = await step(() => setup.mockInput.pressArrow('up'));   // older
results.up3 = await step(() => setup.mockInput.pressArrow('up'));   // oldest
results.up4 = await step(() => setup.mockInput.pressArrow('up'));   // clamps
results.down1 = await step(() => setup.mockInput.pressArrow('down'));
results.down2 = await step(() => setup.mockInput.pressArrow('down'));
results.down3 = await step(() => setup.mockInput.pressArrow('down')); // back to empty draft

const pass =
  results.initial === '' &&
  results.up1 === SEED[2] &&
  results.up2 === SEED[1] &&
  results.up3 === SEED[0] &&
  results.up4 === SEED[0] &&
  results.down1 === SEED[1] &&
  results.down2 === SEED[2] &&
  results.down3 === '';

console.log(JSON.stringify({ pass, seed: SEED, results }, null, 2));
root.unmount();
setup.renderer.destroy();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(pass ? 0 : 1);
