import React from 'react';
const { createTestRenderer } = await import('@opentui/core/testing');
const { createRoot, flushSync } = await import('@opentui/react');
const { default: Transcript } = await import('../src/components/Transcript.jsx');
const e = React.createElement;
const big = Array.from({ length: 40 }, (_, i) => `webpack asset bundle-${i + 1}.js 4.2 MiB [emitted] asset annotation that is far longer than the column width and would wrap without clipping`).join('\n');
const messages = [
  { id: 'u1', role: 'user', text: 'build it' },
  {
    id: 'a1', role: 'assistant', text: 'The bundle is too big — splitting the vendor chunk now.Answer: the build passes after the split.', thinking: 'Checking the bundle sizes first.',
    rounds: [
      { text: 'The bundle is too big — splitting the vendor chunk now.', thinking: 'Checking the bundle sizes first.', tools: [{ id: 'b1', name: 'exec_shell', args: { command: 'npm run build' }, result: big }] },
      { text: 'Answer: the build passes after the split.', thinking: '', tools: [] },
    ],
    tools: [{ id: 'b1', name: 'exec_shell', args: { command: 'npm run build' }, result: big }],
  },
];
const sref = { current: null };
function T({ budget }) {
  return e('box', { style: { width: 120, height: 30, flexDirection: 'column' } },
    e('box', { style: { height: 12, flexShrink: 0 } }, e('text', null, 'header row')),
    e('box', { style: { flexGrow: 1, flexShrink: 1, overflow: 'hidden' } },
      e(Transcript, { messages, width: 90, height: budget, scrollRef: sref, emptyHint: 'x' })),
    e('box', { style: { height: 5, flexShrink: 0 } }, e('text', null, 'composer')));
}
for (const budget of [10, 4]) {
  sref.current = null;
  const setup = await createTestRenderer({ width: 120, height: 30 });
  const root = createRoot(setup.renderer);
  flushSync(() => root.render(e(T, { budget })));
  await setup.flush(); await new Promise((r) => setTimeout(r, 250)); await setup.flush();
  const r = sref.current;
  const f = setup.captureCharFrame();
  console.log(`=== budget=${budget} scrollH=${r && r.scrollHeight} scrollTop=${r && r.scrollTop} view=${r && r.viewport && r.viewport.height} boxH=${r && r.height} y=${r && r.y}`);
  console.log(f.split('\n').slice(0, 24).join('\n'));
  root.unmount(); setup.renderer.destroy();
}
