import React, { useState, useRef } from 'react';
const { createTestRenderer } = await import('@opentui/core/testing');
const { createRoot, flushSync } = await import('@opentui/react');
const { default: Transcript } = await import('../src/components/Transcript.jsx');
const e = React.createElement;
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

const big = Array.from({ length: 12 }, (_, i) => `result line ${i + 1}`).join('\n');
function make(text, done) {
  return [
    { id: 'u1', role: 'user', text: 'check the build' },
    { id: 'a1', role: 'assistant', text, thinking: '', tools: [{ id: 't1', name: 'exec_shell', args: { command: 'npm run build' }, result: done ? big : null }] },
  ];
}
const sharedRef = { current: null };
function Tree({ msgs, height }) {
  return e('box', { style: { width: 60, height: 20, flexDirection: 'column' } },
    e(Transcript, { messages: msgs, width: 60, height, scrollRef: sharedRef }));
}
const HEIGHTS = [5, 10, 20];
for (const h of HEIGHTS) {
  const setup = await createTestRenderer({ width: 60, height: 20 });
  const root = createRoot(setup.renderer);
  flushSync(() => root.render(e(Tree, { msgs: [], height: h })));
  await setup.flush();
  flushSync(() => root.render(e(Tree, { msgs: make('I will check', false), height: h })));
  await setup.flush(); await settle(120);
  flushSync(() => root.render(e(Tree, { msgs: make("I'll check the build output first, then patch the handler. Done - the handler is patched.", true), height: h })));
  await setup.flush(); await settle(250);
  await setup.flush();
  const f = setup.captureCharFrame();
  const r = sharedRef.current;
  console.log('ref', r ? { scrollTop: r.scrollTop, scrollHeight: r.scrollHeight, viewportH: r.viewport && r.viewport.height, manual: r._hasManualScroll, sticky: r._stickyScroll, start: r._stickyStart } : null);
  console.log(`h=${h} tail=${f.includes('result line 12')} lastText=${f.includes('the handler is patched')} firstLine=${f.includes('result line 1 ')}`);
  if (h === 10) console.log(f);
  root.unmount(); setup.renderer.destroy();
}
