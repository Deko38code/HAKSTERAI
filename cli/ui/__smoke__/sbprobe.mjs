import React from 'react';
const { createTestRenderer } = await import('@opentui/core/testing');
const { createRoot, flushSync } = await import('@opentui/react');
const e = React.createElement;
const setup = await createTestRenderer({ width: 40, height: 12 });
const root = createRoot(setup.renderer);
const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
function Tree({ many }) {
  return e('box', { style: { width: 40, height: 12, flexDirection: 'column' } },
    e('scrollbox', { style: { width: 40, height: 12, stickyScroll: true, stickyStart: 'bottom', scrollY: true, scrollX: false } },
      e('box', { style: { flexDirection: 'column', width: 39 } },
        ...lines.slice(0, many).map((l) => e('text', { key: l }, l)))));
}
flushSync(() => root.render(e(Tree, { many: 8 })));
await setup.flush();
await new Promise((r) => setTimeout(r, 150));
flushSync(() => root.render(e(Tree, { many: 30 })));
await setup.flush();
await new Promise((r) => setTimeout(r, 400));
await setup.flush();
console.log(setup.captureCharFrame());
root.unmount(); setup.renderer.destroy();
