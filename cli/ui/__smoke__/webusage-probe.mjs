/* Probe: the ◔ Usage panel shows the session's web-call count.
 *
 * Owner (2026-11-24): "we need to add web tool usage in the usage panel in
 * right of our cli just for our count". This mounts the real sidebar at a
 * typical phone-ish 24-row terminal and a tall 50-row one, asserts the `web`
 * row is printed with the count the props carry, and that the extra row did not
 * make the sidebar taller than the height it was budgeted — the MARKER row
 * placed after it must start at or before that row.
 */
import React from 'react';
const { createTestRenderer } = await import('@opentui/core/testing');
const { createRoot, flushSync } = await import('@opentui/react');
const { default: LiveSidebar } = await import('../src/components/LiveSidebar.jsx');

const e = React.createElement;
const settle = async (setup) => { await setup.flush(); await new Promise((r) => setTimeout(r, 200)); await setup.flush(); };

async function frame(node, height) {
  // Four spare rows under the budget, so a MARKER that lands past `height`
  // proves overflow instead of merely being clipped by the screen edge.
  const box = height + 4;
  const setup = await createTestRenderer({ width: 100, height: box });
  const root = createRoot(setup.renderer);
  flushSync(() => root.render(e('box', { style: { width: 100, height: box, flexDirection: 'column' } }, node, e('text', null, 'MARKER'))));
  await settle(setup);
  const captured = setup.captureCharFrame();
  root.unmount();
  return captured;
}

let fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) console.log(`PASS  ${name}`);
  else { fail += 1; console.log(`FAIL  ${name}${extra ? ` — ${extra}` : ''}`); }
};

const usage = { tools: 9, web: 4, ok: 7, fail: 2, requests: 3, turns: 1, inTok: 1200, outTok: 300, tokensKnown: true, ctxPct: 12 };

for (const height of [24, 50]) {
  const captured = await frame(
    e('box', { style: { flexDirection: 'column', width: 34 } },
      e(LiveSidebar, {
        width: 34, height, usage, activity: [], liveLines: [], liveTool: '', busy: false,
        mcp: null, serverOk: true, memory: null, version: '0.3.16', graphics: false,
      })),
    height,
  );
  const row = captured.split('\n').find((l) => /\bweb\b/.test(l) && l.includes('4'));
  check(`h=${height}: ◔ Usage prints the web row with its count`, !!row, captured.split('\n').filter((l) => l.includes('◔ Usage')).join(' | '));
  const markerAt = captured.split('\n').findIndex((l) => l.includes('MARKER'));
  check(`h=${height}: sidebar stays within its ${height}-row budget`, markerAt >= 0 && markerAt <= height, `MARKER at row ${markerAt}`);
}

console.log(fail ? `\n${fail} web-usage check(s) failed` : '\nall web-usage checks passed');
process.exit(fail ? 1 : 0);
