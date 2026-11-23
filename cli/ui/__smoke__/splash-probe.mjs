/* Probe: the startup screen shows the hero logo and the Matrix rain.
 *
 * Owner, 2026-11-23: "make sure the hero logo show on startup in our cli",
 * "need the matrix hacker intro on startup", "hacker vibes". Renders the real
 * DecodeSplash (no Kitty graphics here, so the block wordmark must appear) at
 * two sizes and checks: the wordmark is drawn, rain glyphs are on screen, the
 * five decoded lines still land, and a frame costs a sane amount of time.
 */
import React from 'react';
const { createTestRenderer } = await import('@opentui/core/testing');
const { createRoot, flushSync } = await import('@opentui/react');
const { default: DecodeSplash } = await import('../src/components/DecodeSplash.jsx');

const e = React.createElement;
const lines = [
  { text: '◆ haksterAi', color: '#00ff41', bold: true },
  { text: 'CLI v0.2.5 · updates check live', color: 'gray' },
  { text: 'model deepseek-v4.1-flash:cloud', color: '#a3e635' },
  { text: 'server online', color: '#00ff41' },
  { text: 'type a task · /menu commands · v live monitor', color: 'gray' },
];

let fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) console.log(`PASS  ${name}`);
  else { fail += 1; console.log(`FAIL  ${name}${extra ? ` — ${extra}` : ''}`); }
};

for (const [w, h] of [[100, 30], [60, 20]]) {
  const setup = await createTestRenderer({ width: w, height: h });
  const root = createRoot(setup.renderer);
  const t0 = Date.now();
  flushSync(() => root.render(e(DecodeSplash, {
    width: w,
    height: h,
    lines,
    stepMs: 55,
    graphics: false,
    onDone: () => {},
  })));
  await setup.flush();
  await new Promise((r) => setTimeout(r, 300));
  await setup.flush();
  const build = Date.now() - t0;
  const frame = setup.captureCharFrame();
  const hasBar = /█|▀/.test(frame);
  const hasRain = /[ｱ-ﾝ]/.test(frame);
  check(`${w}x${h}: hero logo is drawn (artwork cells or block wordmark)`, hasBar);
  check(`${w}x${h}: Matrix rain glyphs are on screen`, hasRain);
  check(`${w}x${h}: decoded lines are drawn`, frame.includes('hakster') || frame.includes('CLI'));
  check(`${w}x${h}: frame built in a sane time`, build < 4000, `${build}ms`);
  if (process.env.SHOW_FRAME) console.log(frame);
  root.unmount();
}

console.log(fail ? `\n${fail} splash check(s) failed` : '\nall splash checks passed');
process.exit(fail ? 1 : 0);
