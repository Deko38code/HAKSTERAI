/* Probe: render the combined StatusServicesPanel and print the frame. */
import React from 'react';
const { createTestRenderer } = await import('@opentui/core/testing');
const { createRoot, flushSync } = await import('@opentui/react');
const { default: StatusServicesPanel, statusServicesRows } = await import('../src/components/StatusServicesPanel.jsx');

const e = React.createElement;
const settle = async (setup) => { await setup.flush(); await new Promise((r) => setTimeout(r, 150)); await setup.flush(); };

const services = [
  { port: 3579, name: 'haksterAi', proto: 'http', up: true, proc: 'node' },
  { port: 8081, name: 'cinevault', proto: 'http', up: true, proc: 'node' },
  { port: 4000, name: 'phantom', proto: 'http', up: true, proc: 'node' },
  { port: 8082, name: 'claude-proxy', proto: 'http', up: false, proc: '' },
  { port: 5555, name: 'miniforge', proto: 'http', up: true, proc: 'python' },
];
const guard = { present: 13, total: 13, missing: [] };
const meters = { score: 92, points: 480, delta: 2 };

for (const width of [98, 66, 44]) {
  const setup = await createTestRenderer({ width, height: 20 });
  const root = createRoot(setup.renderer);
  flushSync(() => root.render(e('box', { style: { width, flexDirection: 'column' } },
    e(StatusServicesPanel, { width, services, version: '0.3.6', guard, online: true, meters, ctxUsed: 12000, ctxMax: 128000, host: { cpuPct: 13, memPct: 70, swapPct: 0 } }),
    e('text', null, 'MARKER-UNDER'),
  )));
  await settle(setup);
  const frame = setup.captureCharFrame();
  console.log(`\n===== width ${width} (budget rows=${statusServicesRows(width, services.length, true)}) =====`);
  console.log(frame);
  root.unmount();
}
process.exit(0);
