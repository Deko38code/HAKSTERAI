/* Probe: the autolearn meters with the bug's exact state.
 *
 * score pinned at 100 (so `delta` is 0 on every success) and pointsDelta = +1.
 * The autolearn arrow must read ▲ and the percent must follow the points, in
 * the status row and on the chat header — the bug was a stuck ◆ here.
 */
import React from 'react';
const { createTestRenderer } = await import('@opentui/core/testing');
const { createRoot, flushSync } = await import('@opentui/react');
const { default: StatusServicesPanel } = await import('../src/components/StatusServicesPanel.jsx');
const { default: SystemPanel } = await import('../src/components/SystemPanel.jsx');
const { pointsPct, meterArrow } = await import('../../smartness.mjs');

const e = React.createElement;
const settle = async (setup) => { await setup.flush(); await new Promise((r) => setTimeout(r, 150)); await setup.flush(); };

const services = [
  { port: 3579, name: 'haksterAi', proto: 'http', up: true, proc: 'node' },
  { port: 8081, name: 'cinevault', proto: 'http', up: true, proc: 'node' },
];
const cases = [
  { label: 'score pinned 100, points up', meters: { score: 100, delta: 0, points: 42, pointsDelta: 1 } },
  { label: 'points down', meters: { score: 90, delta: 0, points: 31, pointsDelta: -10 } },
  { label: 'nothing moved', meters: { score: 100, delta: 0, points: 42, pointsDelta: 0 } },
];

for (const c of cases) {
  console.log(`\n######## ${c.label}  (arrow=${meterArrow(c.meters.pointsDelta)} pct=${pointsPct(c.meters.points)})`);
  for (const width of [110, 80]) {
    const setup = await createTestRenderer({ width, height: 12 });
    const root = createRoot(setup.renderer);
    flushSync(() => root.render(e('box', { style: { width, flexDirection: 'column' } },
      e(SystemPanel, { width, meters: c.meters, ctxUsed: 12000, ctxMax: 128000, host: { cpuPct: 13, memPct: 70, swapPct: 0 } }),
      e(StatusServicesPanel, { width, services, version: '0.3.21', guard: { present: 13, total: 13, missing: [] }, online: true, meters: c.meters, ctxUsed: 12000, ctxMax: 128000, host: { cpuPct: 13, memPct: 70, swapPct: 0 } }),
    )));
    await settle(setup);
    console.log(`----- width ${width} -----`);
    console.log(setup.captureCharFrame());
    root.unmount();
  }
}
process.exit(0);
