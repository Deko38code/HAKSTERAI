/* Probe: the ◔ Usage panel shows the session's web-call count, and the row it
 * costs comes out of ◈ Live — never out of ▶ Output.
 *
 * Owner (2026-11-24): "we need to add web tool usage in the usage panel in right
 * of our cli just for our count", then "no dont change outputs rows use the live
 * row … never touch output bottom right". This mounts the real sidebar at a
 * typical phone-ish 24-row terminal and a tall 50-row one and asserts:
 *   1. the `web` row is printed with the count the props carry;
 *   2. ▶ Output keeps exactly the tail it had before the web row existed
 *      (6 live lines at 24 rows, 12 at 50 — the pre-change budget);
 *   3. the sidebar stays inside the height it was budgeted, so nothing is cut
 *      off by the screen edge;
 *   4. with ◈ Live down to one content row, the ⬆ staged-update marker rides the
 *      panel's title row instead of disappearing with the version row.
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
// Distinct, clipped-safe lines so the rows that actually reach ▶ Output can be
// counted in the frame rather than inferred from the code.
const liveLines = Array.from({ length: 24 }, (_, i) => `out${String(i).padStart(2, '0')} tail of the tool result`);

// ▶ Output's tail BEFORE the web row was added: 6 lines at 24 rows, 12 at 50.
const expectOut = { 24: 6, 50: 12 };

for (const height of [24, 50]) {
  const captured = await frame(
    e('box', { style: { flexDirection: 'column', width: 34 } },
      e(LiveSidebar, {
        width: 34, height, usage, activity: [], liveLines, liveTool: 'bash', busy: false,
        mcp: null, serverOk: true, memory: null, version: '0.3.17', graphics: false,
        update: { version: '0.3.18', status: 'staged' },
      })),
    height,
  );
  const rows = captured.split('\n');
  const webRow = rows.find((l) => /\bweb\b/.test(l) && l.includes('4'));
  check(`h=${height}: ◔ Usage prints the web row with its count`, !!webRow, rows.filter((l) => l.includes('◔ Usage')).join(' | '));
  const outSeen = rows.filter((l) => /out\d\d/.test(l)).length;
  check(`h=${height}: ▶ Output keeps its ${expectOut[height]}-line tail`, outSeen === expectOut[height], `saw ${outSeen} output line(s)`);
  const markerAt = rows.findIndex((l) => l.includes('MARKER'));
  check(`h=${height}: sidebar stays within its ${height}-row budget`, markerAt >= 0 && markerAt <= height, `MARKER at row ${markerAt}`);
  const liveTitle = rows.find((l) => l.includes('◈ Live'));
  check(`h=${height}: ⬆ staged marker rides the ◈ Live title row`, !!liveTitle && /⬆\s*0\.3\.18/.test(liveTitle), liveTitle || 'no ◈ Live row');
}

console.log(fail ? `\n${fail} web-usage check(s) failed` : "\nall web-usage checks passed");
process.exit(fail ? 1 : 0);
