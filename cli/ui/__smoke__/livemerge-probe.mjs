/* Probe: one live panel, on the right.
 * Owner, 2026-11-24: "we have 2 live panels 1 on right and middle keep right
 * one remove middle live panel make our reasoning panel replace live middle to
 * be taller".
 *
 * Wide (>= 96 cols): the right ◈ Live sidebar is the only live panel, no ▶ Live
 * / ▶ Result box in the middle column, and the reasoning transcript owns the
 * whole shared budget (it grew by the rows the middle box stopped using).
 * Narrow (< 96 cols): no sidebar, so the middle box stays as the fallback.
 */
import React from 'react';
process.env.HOME = '/tmp/probe-home';
process.env.HAKSTER_NO_INTRO = '1';
process.env.HAKSTER_NO_HISTORY = '1';
const { createTestRenderer } = await import('@opentui/core/testing');
const { createRoot, flushSync } = await import('@opentui/react');
const { default: App } = await import('../src/App.jsx');
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/api/tui/status')) return new Response(JSON.stringify({ phase: 'ACT', connected: true, model: 'glm-5.2:cloud', trust: 3, tokens: 41000 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (u.includes('/api/agent/mcp-status')) return new Response(JSON.stringify({ servers: [{ name: 'filesystem', toolCount: 12, initialized: true }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (u.includes('/api/ads')) return new Response(JSON.stringify({ creatives: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
};

let fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) console.log(`PASS  ${name}`);
  else { fail += 1; console.log(`FAIL  ${name}${extra ? ` — ${extra}` : ''}`); }
};

const boxHeight = (lines, title) => {
  const top = lines.findIndex((l) => l.includes(title));
  if (top < 0) return 0;
  // count rows until the closing border row (a row that is only ╰ / └ corners)
  let n = 0;
  for (let i = top; i < lines.length; i += 1) {
    n += 1;
    if (/[╰└]/.test(lines[i]) && lines[i].trim().length <= 3) break;
  }
  return n;
};

for (const [cols, rows, wide] of [[120, 40, true], [120, 50, true], [80, 30, false]]) {
  const setup = await createTestRenderer({ width: cols, height: rows });
  const root = createRoot(setup.renderer);
  flushSync(() => root.render(React.createElement(App, { version: 'probe' })));
  await setup.flush();
  await settle(500);
  await setup.flush();
  const frame = setup.captureCharFrame();
  const lines = frame.split('\n').map((l) => l.replace(/\s+$/, ''));
  const right = lines.filter((l) => l.includes('◈ Live')).length;
  const middle = lines.filter((l) => l.includes('▶ Live') || l.includes('▶ Result')).length;
  const transcript = lines.findIndex((l) => l.includes('◈ Thinking') || l.includes('Thinking') || l.includes('◇ Reasoning'));
  console.log(`\n──── chat ${cols}x${rows} · rightLive=${right} · middleLive=${middle} ────`);
  lines.forEach((l) => console.log('  ' + l));
  if (wide) {
    check(`${cols}x${rows}: right ◈ Live sidebar is drawn`, right === 1, `rows ${right}`);
    check(`${cols}x${rows}: middle ▶ Live/Result box is gone`, middle === 0, `rows ${middle}`);
  } else {
    check(`${cols}x${rows}: narrow keeps the middle live box as fallback`, middle === 1, `rows ${middle}`);
    check(`${cols}x${rows}: no sidebar on a narrow terminal`, right === 0, `rows ${right}`);
  }
  root.unmount();
}
console.log(fail ? `\n${fail} FAILED` : '\nall checks passed');
process.exit(fail ? 1 : 0);
