/* Transcript re-render bench (owner, 2026-11-24: "bash tools making cli lagg").
 *
 * The transcript is the expensive node: at 20 turns one lay-out cost ~70 ms, and
 * App re-renders on timers that must not pay for it (elapsed clock, host stats,
 * memory bank, status poll). This pins the two shapes that matter:
 *
 *   tick  — same props, i.e. a timer tick. Memoised Transcript costs ~nothing.
 *   patch — the stream patched the newest turn, so a new `messages` identity:
 *           only that turn may re-render (memoised MessageBlock), not the 19
 *           finished ones above it.
 *
 * Run under Bun (`bun ui/__smoke__/transcript-bench.mjs`).
 */
import React from 'react';
process.env.HOME = '/tmp/probe-home';
const { createTestRenderer } = await import('@opentui/core/testing');
const { createRoot, flushSync } = await import('@opentui/react');
const { default: Transcript } = await import('../src/components/Transcript.jsx');

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

function bigResult(lines) {
  return Array.from({ length: lines }, (_, i) => `src/module-${i}.js  webpack asset 4.2 MiB [emitted] done in ${i}ms`).join('\n');
}

function turns(n, lines) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push({
      id: `m${i}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      text: `Turn ${i}: ran a build.`,
      tools: i % 2 === 0 ? [] : [{ name: 'exec_shell', args: { command: 'npm run build' }, result: bigResult(lines), ms: 1200 }],
    });
  }
  return out;
}

const TURNS = 20;
const LINES = 4000;
const BUDGET_TICK_MS = 20;
const BUDGET_PATCH_MS = 120;

async function bench() {
  const setup = await createTestRenderer({ width: 120, height: 40 });
  const root = createRoot(setup.renderer);
  const base = turns(TURNS, LINES);
  const draw = (list) => React.createElement(Transcript, { messages: list, width: 120, height: 30, live: false });

  flushSync(() => root.render(draw(base)));
  await setup.flush();
  await settle(50);

  // tick: identical props, which is what every timer-driven App re-render does.
  const tickSamples = [];
  for (let i = 0; i < 5; i += 1) {
    const t0 = performance.now();
    flushSync(() => root.render(draw(base)));
    await setup.flush();
    tickSamples.push(performance.now() - t0);
  }

  // patch: only the newest turn's text changes, as a stream delta does.
  const patchSamples = [];
  for (let i = 0; i < 5; i += 1) {
    const next = base.slice();
    next[next.length - 1] = { ...next[next.length - 1], text: `Turn ${TURNS - 1}: ran a build. ${i}` };
    const t0 = performance.now();
    flushSync(() => root.render(draw(next)));
    await setup.flush();
    patchSamples.push(performance.now() - t0);
  }

  const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const tick = med(tickSamples);
  const patch = med(patchSamples);
  console.log(`[${TURNS} turns, ${LINES}-line results] tick=${tick.toFixed(1)}ms  patch=${patch.toFixed(1)}ms`);
  console.log(`  tick samples  [${tickSamples.map((s) => s.toFixed(0)).join(', ')}]`);
  console.log(`  patch samples [${patchSamples.map((s) => s.toFixed(0)).join(', ')}]`);

  root.unmount();
  setup.renderer.destroy();
  return { tick, patch };
}

const { tick, patch } = await bench();
const okTick = tick <= BUDGET_TICK_MS;
const okPatch = patch <= BUDGET_PATCH_MS;
console.log(`\n${okTick ? 'ok  ' : 'FAIL'} a timer tick no longer re-lays-out the transcript (${tick.toFixed(1)}ms <= ${BUDGET_TICK_MS}ms)`);
console.log(`${okPatch ? 'ok  ' : 'FAIL'} a stream patch stays within budget (${patch.toFixed(1)}ms <= ${BUDGET_PATCH_MS}ms)`);
process.exitCode = okTick && okPatch ? 0 : 1;
