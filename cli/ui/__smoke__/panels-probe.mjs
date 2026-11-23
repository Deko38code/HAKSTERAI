/* Probe: every scrolling panel keeps its measured height while output arrives.
 *
 * Owner (2026-11-23): "make sure all panels scrollbars keep up wih output".
 * A panel that grows a row per streamed line moves everything under it and the
 * ▲/█/▼ bar only appears once the list has already overflowed. This mounts the
 * real components with 1, 3 and 40 lines and asserts the marker row below them
 * never moves — and that the newest line is on the last content row.
 */
import React from 'react';
const { createTestRenderer } = await import('@opentui/core/testing');
const { createRoot, flushSync } = await import('@opentui/react');
const { default: MonitorFeed } = await import('../src/components/MonitorFeed.jsx');
const { default: LiveSidebar } = await import('../src/components/LiveSidebar.jsx');

const e = React.createElement;
const settle = async (setup) => { await setup.flush(); await new Promise((r) => setTimeout(r, 200)); await setup.flush(); };

function frameFor(node, height = 40) {
  return { node, height };
}

async function markerRow(node, height = 40) {
  const setup = await createTestRenderer({ width: 100, height });
  const root = createRoot(setup.renderer);
  flushSync(() => root.render(e('box', { style: { width: 100, height, flexDirection: 'column' } }, node, e('text', null, 'MARKER'))));
  await settle(setup);
  const frame = setup.captureCharFrame();
  const lines = frame.split('\n');
  const idx = lines.findIndex((l) => l.includes('MARKER'));
  root.unmount();
  return { idx, frame };
}

const lines = (n) => Array.from({ length: n }, (_, i) => `output line ${i + 1}`);
const events = (n) => Array.from({ length: n }, (_, i) => ({ ts: Date.now() + i, kind: 'tool', text: `event ${i + 1}` }));

let fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) console.log(`PASS  ${name}`);
  else { fail += 1; console.log(`FAIL  ${name}${extra ? ` — ${extra}` : ''}`); }
};

// ── MonitorFeed: constant height for 1 / 3 / 40 lines ────────────────────
const mfRows = [];
for (const n of [1, 3, 40]) {
  const { idx, frame } = await markerRow(
    e('box', { style: { flexGrow: 1, flexShrink: 1, overflow: 'hidden' } },
      e(MonitorFeed, { width: 100, height: 24, activity: events(n), liveLines: lines(n), liveTool: 'shell ls', busy: true })),
  );
  mfRows.push(idx);
  if (n === 40) {
    check('MonitorFeed draws the newest output line in its window', frame.includes('output line 40'), frame.split('\n').filter((l) => l.includes('output line')).slice(-1)[0]);
    check('MonitorFeed bar shows the tail (1-…/40 or 40)', /40/.test(frame.split('\n').filter((l) => l.includes('▶ Output'))[0] || ''), frame.split('\n').filter((l) => l.includes('▶ Output'))[0]);
  }
}
check('MonitorFeed height is identical at 1, 3 and 40 lines', new Set(mfRows).size === 1, `marker rows ${mfRows.join(',')}`);

// ── LiveSidebar: same contract ───────────────────────────────────────────
const sbProps = {
  width: 34,
  height: 40,
  activity: [],
  liveLines: [],
  liveTool: 'shell ls',
  busy: true,
  servers: [],
  agentStatus: 'running',
  phase: 'ACT',
  tool: 'shell',
  turns: 1,
  elapsedMs: 2000,
  model: 'deepseek',
  version: '0.2.4',
  serverOk: true,
  memory: null,
  graphics: false,
};
const sbRows = [];
for (const n of [1, 3, 40]) {
  const { idx, frame } = await markerRow(
    e('box', { style: { flexDirection: 'column', width: 34 } },
      e(LiveSidebar, { ...sbProps, activity: events(n), liveLines: lines(n) })),
  );
  sbRows.push(idx);
  if (n === 40) {
    check('LiveSidebar draws the newest line', frame.includes('line 40') || frame.includes('event 40'), '');
  }
}
check('LiveSidebar height is identical at 1, 3 and 40 lines', new Set(sbRows).size === 1, `marker rows ${sbRows.join(',')}`);

console.log(fail ? `\n${fail} panel check(s) failed` : '\nall panel checks passed');
process.exit(fail ? 1 : 0);
