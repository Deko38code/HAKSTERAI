import React from 'react';
const { createTestRenderer } = await import('@opentui/core/testing');
const { createRoot, flushSync } = await import('@opentui/react');
const e = React.createElement;
const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
function Tree({ h, variant }) {
  const kid = variant === 'plain'
    ? e('box', { style: { flexDirection: 'column', width: 38, flexShrink: 0 } }, ...lines.map((l) => e('text', { key: l }, l)))
    : e('box', { style: { width: 38, flexShrink: 0, flexDirection: 'column', border: true, borderStyle: 'rounded', borderColor: 'gray', paddingLeft: 1, paddingRight: 1 } },
        ...lines.map((l) => e('text', { key: l }, l)));
  return e('box', { style: { width: 40, height: h, flexShrink: 0, overflow: 'hidden' } },
    e('scrollbox', { scrollbarOptions: { width: 1, showArrows: true, arrowOptions: { foregroundColor: '#9ca3af', arrowChars: { up: '▲', down: '▼' } }, trackOptions: { backgroundColor: '#374151', foregroundColor: '#22d3ee' } }, style: { width: 40, height: h, stickyScroll: true, stickyStart: 'bottom', scrollY: true, scrollX: false, viewportCulling: true } },
      e('box', { style: { flexDirection: 'column', width: 39 } }, kid)));
}
const ref = { current: null };
for (const variant of ['plain', 'border']) for (const h of [5, 10, 20]) {
  const setup = await createTestRenderer({ width: 40, height: 24 });
  const root = createRoot(setup.renderer);
  flushSync(() => root.render(e(Tree, { h, variant })));
  await setup.flush(); await new Promise((r) => setTimeout(r, 250)); await setup.flush();
  const f = setup.captureCharFrame();
  console.log(`${variant} h=${h} tail=${f.includes('line 30')}`);
  root.unmount(); setup.renderer.destroy();
}
