import React from 'react';
const { createTestRenderer } = await import('@opentui/core/testing');
const { createRoot, flushSync } = await import('@opentui/react');
const e = React.createElement;
const big = Array.from({ length: 12 }, (_, i) => `result line ${i + 1}`);
const BAR = { width: 1, showArrows: true, arrowOptions: { foregroundColor: '#9ca3af', arrowChars: { up: '▲', down: '▼' } }, trackOptions: { backgroundColor: '#374151', foregroundColor: '#22d3ee' } };
function Block({ w, marginBottom }) {
  return e('box', { style: { marginBottom, flexShrink: 0 } },
    e('box', { style: { width: w, flexShrink: 0, flexDirection: 'column', border: true, borderStyle: 'rounded', borderColor: 'gray', paddingLeft: 1, paddingRight: 1 } },
      e('text', null, 'I will check the build output first, then patch the handler.'),
      e('text', null, 'exec_shell npm run build'),
      ...big.map((l, i) => e('text', { key: i }, l))));
}
const sref = { current: null };
function Tree({ h, w, mb = 1 }) {
  return e('box', { style: { width: 60, height: h, flexShrink: 0, overflow: 'hidden' } },
    e('scrollbox', { ref: sref, scrollbarOptions: BAR, style: { width: 60, height: h, stickyScroll: true, stickyStart: 'bottom', scrollY: true, scrollX: false, viewportCulling: true } },
      e('box', { style: { flexDirection: 'column', width: w } },
        e(Block, { w, marginBottom: mb }))));
}
for (const w of [59, 58]) for (const h of [5, 10]) {
  const setup = await createTestRenderer({ width: 60, height: 24 });
  const root = createRoot(setup.renderer);
  flushSync(() => root.render(e(Tree, { h, w })));
  await setup.flush(); await new Promise((r) => setTimeout(r, 250)); await setup.flush();
  const f = setup.captureCharFrame();
  const r = sref.current;
  console.log(`w=${w} h=${h} tail=${f.includes('result line 12')} top=${f.includes('I will check')} scrollH=${r && r.scrollHeight} top=${r && r.scrollTop} vh=${r && r.viewport && r.viewport.height}`);
  root.unmount(); setup.renderer.destroy();
}
