import React from 'react';
const { createTestRenderer } = await import('@opentui/core/testing');
const { createRoot, flushSync } = await import('@opentui/react');
const e = React.createElement;
const BAR = { width: 1, showArrows: true, arrowOptions: { foregroundColor: '#9ca3af', arrowChars: { up: '▲', down: '▼' } }, trackOptions: { backgroundColor: '#374151', foregroundColor: '#22d3ee' } };
const rows = Array.from({ length: 40 }, (_, i) => `line ${i + 1} of the dump`).join('\n');
const sref = { current: null };
function Body() {
  return e('box', { style: { flexDirection: 'column', width: 90 } },
    e('box', { style: { flexShrink: 0, border: true, borderStyle: 'rounded' } },
      e('box', { style: { flexDirection: 'column', flexShrink: 0 } },
        e('text', null, 'build it'),
        e('text', null, 'thinking about it'),
        e('text', null, 'the vendor chunk is too big'),
        ...Array.from({ length: 3 }, (_, i) => e('text', { key: `r${i}` }, `result ${i}`)),
        e('text', null, '… +37 more lines · ▶ Output'),
        e('text', null, 'Answer: the build passes after the split.'))));
}
const variants = {
  fixed: (b) => ({ root: { width: 90, height: b, flexShrink: 0, overflow: 'hidden' }, sc: { width: 90, height: b } }),
  shrink: (b) => ({ root: { width: 90, height: b, flexShrink: 1, minHeight: 3, overflow: 'hidden' }, sc: { width: 90, height: '100%' } }),
  flex: (b) => ({ root: { width: 90, flexGrow: 1, flexShrink: 1, minHeight: 0, overflow: 'hidden' }, sc: { width: 90, height: '100%' } }),
};
for (const [name, mk] of Object.entries(variants)) {
  sref.current = null;
  const setup = await createTestRenderer({ width: 90, height: 26 });
  const root = createRoot(setup.renderer);
  const v = mk(9);
  function T() {
    return e('box', { style: { width: 90, height: 26, flexDirection: 'column' } },
      e('box', { style: { height: 12, flexShrink: 0 } }, e('text', null, 'header 12 rows')),
      e('box', { style: { flexGrow: 1, flexShrink: 1, overflow: 'hidden' } },
        e('box', { style: v.root },
          e('scrollbox', { ref: sref, scrollbarOptions: BAR, style: { ...v.sc, stickyScroll: true, stickyStart: 'bottom', scrollY: true, scrollX: false } },
            e(Body)))),
      e('box', { style: { height: 7, flexShrink: 0 } }, e('text', null, 'composer 7 rows')));
  }
  flushSync(() => root.render(e(T)));
  await setup.flush(); await new Promise((r) => setTimeout(r, 250)); await setup.flush();
  let r = sref.current;
  if (!r) { await new Promise((res) => setTimeout(res, 300)); await setup.flush(); r = sref.current; }
  const f = setup.captureCharFrame();
  console.log(`=== ${name} scrollH=${r && r.scrollHeight} scrollTop=${r && r.scrollTop} view=${r && r.viewport && r.viewport.height} h=${r && r.height} y=${r && r.y}`);
  console.log(f.split('\n').slice(10, 21).map((l, i) => `${i + 11}|${l}`).join('\n'));
  root.unmount(); setup.renderer.destroy();
}
