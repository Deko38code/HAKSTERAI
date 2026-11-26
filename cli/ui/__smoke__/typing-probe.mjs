/* Typing-stability probe (owner, 2026-11-26: "fix input bar when i type keeps
 * glitching bad").
 *
 * lag-probe.mjs proves a keystroke *lands fast*; this measures whether it lands
 * *cleanly*. It mounts the real App against mocked endpoints and, for each
 * typed character, diffs the captured frame against the previous one and
 * records:
 *
 *   - which rows changed (should be the composer only),
 *   - what the composer actually shows (should be the draft typed so far),
 *   - whether the screen keeps changing with NO input (a timer repainting the
 *     bar while the operator types is exactly what reads as "glitching").
 *
 * Run under Bun: bun ui/__smoke__/typing-probe.mjs
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
  if (u.includes('/api/tui/status')) {
    return new Response(JSON.stringify({ phase: 'idle', connected: true, model: 'probe', trust: 3, tokens: 0 }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }
  return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
};

const setup = await createTestRenderer({ width: 100, height: 30 });
const root = createRoot(setup.renderer);
flushSync(() => root.render(React.createElement(App, { version: 'probe' })));
await setup.flush();
await settle(700);
await setup.flush();

const rowsOf = (frame) => frame.split('\n');
const changed = (a, b) => {
  const A = rowsOf(a);
  const B = rowsOf(b);
  const out = [];
  const n = Math.max(A.length, B.length);
  for (let i = 0; i < n; i += 1) if ((A[i] || '') !== (B[i] || '')) out.push(i);
  return out;
};

let prev = setup.captureCharFrame();
const base = prev;

// 1. Idle stability: does the screen change on its own with no typing?
let idleChanges = 0;
const idleRows = new Set();
for (let i = 0; i < 12; i += 1) {
  await settle(150);
  await setup.flush();
  const now = setup.captureCharFrame();
  for (const r of changed(prev, now)) idleRows.add(r);
  if (prev !== now) idleChanges += 1;
  prev = now;
}
console.log(`\n[idle] frames changed with no input: ${idleChanges}/12 · rows: ${[...idleRows].sort((a, b) => a - b).join(',') || 'none'}`);

// 2. Typing: one char at a time, note every row that moves besides the composer.
const draft = 'hello world this is a typing test';
const anomalies = [];
const rowHits = new Map();
for (const ch of draft) {
  const before = setup.captureCharFrame();
  flushSync(() => setup.mockInput.pressKey(ch));
  await setup.flush();
  const after = setup.captureCharFrame();
  const rows = changed(before, after);
  for (const r of rows) rowHits.set(r, (rowHits.get(r) || 0) + 1);
  // The composer is the bottom block: find the line carrying the prompt glyph.
  const lines = rowsOf(after);
  const caretIdx = lines.findIndex((l) => l.includes('›'));
  if (caretIdx < 0) anomalies.push({ ch, why: 'composer prompt missing' });
}

console.log(`\n[typing] rows that changed while typing (row → keystrokes):`);
for (const [row, n] of [...rowHits.entries()].sort((a, b) => a[0] - b[0])) {
  const text = rowsOf(setup.captureCharFrame())[row] || '';
  console.log(`   row ${String(row).padStart(2)} ×${String(n).padStart(2)}  ${JSON.stringify(text.slice(0, 70))}`);
}
if (anomalies.length) console.log('[typing] anomalies:', anomalies);

// 3. What the composer shows for the full draft, and the whole bottom block.
const finalFrame = setup.captureCharFrame();
const fLines = rowsOf(finalFrame);
console.log('\n[frame] bottom 8 rows:');
fLines.slice(-8).forEach((l, i) => console.log(`   ${String(fLines.length - 8 + i).padStart(2)} ${JSON.stringify(l.replace(/\s+$/, ''))}`));

// 4. Fast typing: several keys pressed in one flush (a real held-down key).
const before = setup.captureCharFrame();
flushSync(() => { for (const ch of 'abcde') setup.mockInput.pressKey(ch); });
await setup.flush();
const after = setup.captureCharFrame();
console.log('\n[fast] rows changed by 5 keys in one flush:', changed(before, after).join(','));
console.log('[fast] composer line:', JSON.stringify(rowsOf(after).find((l) => l.includes('›')) || ''));

// 5. Backspacing: does the bar redraw cleanly, and does it shrink?
for (let i = 0; i < 5; i += 1) {
  flushSync(() => setup.mockInput.pressKey('BACKSPACE'));
  await setup.flush();
}
console.log('[back] composer line:', JSON.stringify(rowsOf(setup.captureCharFrame()).find((l) => l.includes('›')) || ''));

console.log(`\n[base] first frame had ${rowsOf(base).length} rows; last has ${rowsOf(setup.captureCharFrame()).length}`);

root.unmount();
setup.renderer.destroy();
