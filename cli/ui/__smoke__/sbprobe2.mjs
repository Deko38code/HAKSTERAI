import React from 'react';
const { createTestRenderer } = await import('@opentui/core/testing');
const { createRoot, flushSync } = await import('@opentui/react');
const e = React.createElement;
const BAR = { width: 1, showArrows: true, arrowOptions: { foregroundColor: '#9ca3af', arrowChars: { up: '▲', down: '▼' } }, trackOptions: { backgroundColor: '#374151', foregroundColor: '#22d3ee' } };
const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
function Tree({ many, bar }) {
  return e('box', { style: { width: 40, height: 12, flexDirection: 'column' } },
    e('scrollbox', { ...(bar ? { scrollbarOptions: BAR } : {}), style: { width: 40, height: 12, stickyScroll: true, stickyStart: 'bottom', scrollY: true, scrollX: false, viewportCulling: true } },
      e('box', { style: { flexDirection: 'column', width: 38 } },
        ...lines.slice(0, many).map((l) => e('text', { key: l }, l)))));
}
for (const bar of [false, true]) {
  const setup = await createTestRenderer({ width: 40, height: 12 });
  const root = createRoot(setup.renderer);
  flushSync(() => root.render(e(Tree, { many: 4, bar })));
  await setup.flush();
  await new Promise((r) => setTimeout(r, 120));
  flushSync(() => root.render(e(Tree, { many: 10, bar })));
  await setup.flush(); await new Promise((r) => setTimeout(r, 150));
  flushSync(() => root.render(e(Tree, { many: 30, bar })));
  await setup.flush(); await new Promise((r) => setTimeout(r, 250));
  await setup.flush();
  const f = setup.captureCharFrame();
  console.log(`bar=${bar} tail="${/(line 30)/.test(f)}" top="${/line 1\s/.test(f)}"`);
  console.log(f.split('\n').slice(0, 3).join('\n'));
  root.unmount(); setup.renderer.destroy();
}
