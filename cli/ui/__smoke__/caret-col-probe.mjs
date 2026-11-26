/* One case per process: how wide does the textarea actually wrap?
 *
 * Usage: bun ui/__smoke__/caret-col-probe.mjs <chars> [terminalWidth]
 *
 * Mounts the App once, types `chars` copies of a character, prints the composer
 * box and exits without tearing the renderer down — a mount/destroy loop hung,
 * so each case is its own short run.
 */
import React from 'react';
process.env.HOME = '/tmp/probe-home';
process.env.HAKSTER_NO_INTRO = '1';
process.env.HAKSTER_NO_HISTORY = '1';
const { createTestRenderer } = await import('@opentui/core/testing');
const { createRoot, flushSync } = await import('@opentui/react');
const { default: App } = await import('/home/ghost/haksterAi/cli/ui/src/App.jsx');

const settle = (ms) => new Promise((r) => setTimeout(r, ms));
globalThis.fetch = async () =>
  new Response(JSON.stringify({ phase: 'idle', connected: true, model: 'p', trust: 3, tokens: 0 }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

const N = Number(process.argv[2] || 32);
const W = Number(process.argv[3] || 40);
const CH = process.argv[4] || 'x';

const setup = await createTestRenderer({ width: W, height: 24 });
const root = createRoot(setup.renderer);
flushSync(() => root.render(React.createElement(App, { version: 'probe' })));
await setup.flush();
await settle(500);
await setup.flush();

await setup.mockInput.typeText(CH.repeat(N));
await setup.flush();
await settle(120);
await setup.flush();

const f = setup.captureCharFrame().split('\n');
const gi = f.findIndex((l) => l.includes('›'));
let top = gi;
while (top > 0 && !/^\s*[╭┌]/.test(f[top])) top -= 1;
let bot = gi;
while (bot < f.length - 1 && !/^\s*[╰└]/.test(f[bot])) bot += 1;
const lines = f.slice(top, bot + 1);
const input = lines.slice(1, -2).filter((l) => !/⟪composer⟫/.test(l));
console.log(`\n${N} chars of '${CH}' at terminal ${W}`);
console.log(`  box height ${lines.length} · input rows ${input.length}`);
input.forEach((l, i) => console.log(`   ${i}: ${JSON.stringify(l.replace(/\s+$/, ''))}`));
process.exit(0);
