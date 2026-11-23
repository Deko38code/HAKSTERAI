import React from 'react';
const { createTestRenderer } = await import('@opentui/core/testing');
const { createRoot, flushSync } = await import('@opentui/react');
const { default: MessageBlock } = await import('../src/components/MessageBlock.jsx');
const e = React.createElement;
const BAR = { width: 1, showArrows: true, arrowOptions: { foregroundColor: '#9ca3af', arrowChars: { up: '▲', down: '▼' } }, trackOptions: { backgroundColor: '#374151', foregroundColor: '#22d3ee' } };
const big = Array.from({ length: 12 }, (_, i) => `result line ${i + 1}`).join('\n');
const messages = [
  { id: 'u1', role: 'user', text: 'check the build' },
  { id: 'a1', role: 'assistant', text: "I'll check the build output first, then patch the handler.", thinking: '', tools: [{ id: 't1', name: 'exec_shell', args: { command: 'npm run build' }, result: big }] },
];
const sref = { current: null };
function T({ width, height, compact }) {
  const contentW = Math.max(8, width - 1);
  return e('box', { style: { width, height, flexShrink: 0, overflow: 'hidden' } },
    e('scrollbox', { ref: sref, scrollbarOptions: BAR, style: { width, height, stickyScroll: true, stickyStart: 'bottom', scrollY: true, scrollX: false, viewportCulling: true } },
      e('box', { style: { flexDirection: 'column', width: contentW } },
        ...messages.map((m) => e('box', { key: m.id, style: { marginBottom: compact ? 0 : 1, flexShrink: 0 } },
          e(MessageBlock, { message: m, width: contentW, compact }))))));
}
for (const compact of [true, false]) for (const h of [5, 10]) {
  sref.current = null;
  const setup = await createTestRenderer({ width: 60, height: 24 });
  const root = createRoot(setup.renderer);
  flushSync(() => root.render(e(T, { width: 60, height: h, compact })));
  await setup.flush(); await new Promise((r) => setTimeout(r, 250)); await setup.flush();
  const f = setup.captureCharFrame();
  const r = sref.current;
  if (compact && h === 5) console.log(f);
  console.log(`compact=${compact} h=${h} tail=${f.includes('result line 12')} top=${f.includes('check the build')} scrollH=${r && r.scrollHeight} scrollTop=${r && r.scrollTop}`);
  root.unmount(); setup.renderer.destroy();
}
