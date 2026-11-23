import React from 'react';
const { createTestRenderer } = await import('@opentui/core/testing');
const { createRoot, flushSync } = await import('@opentui/react');
const e = React.createElement;
const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
function Tree({ many }) {
  return e('box', { style: { width: 40, height: 12, flexDirection: 'column' } },
    e('scrollbox', { style: { width: 40, height: 12, stickyScroll: true, stickyStart: 'bottom', scrollY: true, scrollX: false } },
      e('box', { style: { flexDirection: 'column', width: 39 } },
        ...lines.slice(0, many).map((l) => e('text', { key: l }, l)))));
}
// Mount with the full content already in place (the Transcript's real case).
const setup = await createTestRenderer({ width: 40, height: 12 });
const root = createRoot(setup.renderer);
flushSync(() => root.render(e(Tree, { many: 30 })));
await setup.flush();
await new Promise((r) => setTimeout(r, 400));
await setup.flush();
const f = setup.captureCharFrame();
console.log(f);
root.unmount(); setup.renderer.destroy();
