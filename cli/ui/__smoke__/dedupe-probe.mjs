/* Probe: the dedupe — no status/phase rows in ◈ Live, no phase in ▶ Live title,
 * and the three freed rows land in the panels below. */
import React from 'react';
const { createTestRenderer } = await import('@opentui/core/testing');
const { createRoot, flushSync } = await import('@opentui/react');
const { default: LiveSidebar } = await import('../src/components/LiveSidebar.jsx');
const { default: LiveOutputPanel } = await import('../src/components/LiveOutputPanel.jsx');

const e = React.createElement;
const settle = async (s) => { await s.flush(); await new Promise((r) => setTimeout(r, 150)); await s.flush(); };

const activity = Array.from({ length: 30 }, (_, i) => ({ ts: Date.now() + i, kind: 'tool', text: `tool call ${i + 1}` }));
const lines = Array.from({ length: 40 }, (_, i) => `answer line ${i + 1}`);
const servers = Array.from({ length: 12 }, (_, i) => ({ name: `srv${i}`, initialized: true, toolCount: 3 }));

for (const h of [30, 38, 44, 50]) {
  const setup = await createTestRenderer({ width: 34, height: h });
  const root = createRoot(setup.renderer);
  flushSync(() => root.render(e('box', { style: { width: 34, height: h } },
    e(LiveSidebar, {
      width: 34, height: h, agentStatus: 'thinking', phase: 'THINK', tool: 'shell',
      turns: 4, version: '0.3.9', mcp: { servers }, serverOk: true, busy: true,
      activity, liveLines: lines, usage: { tools: 9, ok: 7, fail: 2, requests: 3, turns: 4, tokensKnown: true, inTok: 1200, outTok: 300 },
      memory: { total: 40, banks: [{ slug: 'core', entries: 12 }, { slug: 'proj', entries: 8 }], clusters: 5, newest: { slug: 'core', last: Date.now() } }, update: null,
    }))));
  await settle(setup);
  const frame = setup.captureCharFrame();
  root.unmount();
  const rows = frame.split('\n');
  const live = rows.findIndex((l) => l.includes('◈ Live'));
  console.log(`\n──── sidebar ${34}x${h} ────`);
  console.log(rows.filter((l) => l.trim()).map((l) => l.replace(/\s+$/,'')).join('\n'));
  console.log(`has-status-row=${/status/.test(frame)} has-phase-row=${/phase/.test(frame)} live-title-line=${live}`);
}

// ▶ Live strip: busy, no lines yet — its title must not say "thinking".
for (const phase of ['thinking', 'running']) {
  const setup = await createTestRenderer({ width: 80, height: 12 });
  const root = createRoot(setup.renderer);
  flushSync(() => root.render(e('box', { style: { width: 80, height: 12 } },
    e(LiveOutputPanel, { width: 80, rows: 6, lines: [], call: 'shell ls -la', busy: true, phase }))));
  await settle(setup);
  const frame = setup.captureCharFrame();
  root.unmount();
  const title = frame.split('\n').find((l) => l.includes('Live')) || '';
  console.log(`\n▶ Live phase=${phase}: title=[${title.replace(/\s+$/,'')}] says-thinking=${/thinking/.test(title)}`);
}
