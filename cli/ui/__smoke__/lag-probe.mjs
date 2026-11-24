/* Keystroke-latency probe (owner, 2026-11-24: "bash tools making cli lagg").
 *
 * The complaint is that a shell call makes the TUI sluggish. This measures the
 * thing the operator actually feels — how long one keystroke takes to reach the
 * screen — with the same App, the same mock stream, and the same renderer the
 * other probes use. It runs the same turn twice with only the size of the shell
 * result changed, so any difference is attributable to that result and nothing
 * else:
 *
 *   control — 40 lines  (~4 KB, the size tools.js already shows in a card)
 *   bash    — 4000 lines (~300 KB, an `npm run build` / `rg` / log dump)
 *
 * PASS is a latency budget, not a comparison: a keystroke must land within
 * KEYS_BUDGET_MS on both. Run under Bun (`bun ui/__smoke__/lag-probe.mjs`).
 */
import React from 'react';
process.env.HOME = '/tmp/probe-home';
process.env.HAKSTER_NO_INTRO = '1';
process.env.HAKSTER_NO_HISTORY = '1';
const { createTestRenderer } = await import('@opentui/core/testing');
const { createRoot, flushSync } = await import('@opentui/react');
const { default: App } = await import('../src/App.jsx');

const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = new TextEncoder();

const KEYS_BUDGET_MS = 120;

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass += 1; console.log(`  ok  ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

function resultOf(lines) {
  return Array.from({ length: lines }, (_, i) => `src/module-${i}.js  webpack asset 4.2 MiB [emitted] done in ${i}ms`).join('\n');
}

/* A shell call that streams its result, then holds the run open so the probe can
 * measure keystrokes while the result is in state and the spinner is live. */
function shellStream(lines, holdMs) {
  return new ReadableStream({
    start(controller) {
      const send = (f) => controller.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`));
      send({ type: 'phase', phase: 'ACT', turn: 1 });
      send({ type: 'tool_call_start', tool_call_id: 's1', tool_name: 'exec_shell', tool_args: { command: 'npm run build' } });
      send({ type: 'tool_call_result', tool_call_id: 's1', tool_name: 'exec_shell', tool_result: resultOf(lines) });
      send({ type: 'delta', content: 'Build finished; reading it now.' });
      // A second call left running keeps a spinner ticker alive, which is the
      // worst case for re-render frequency.
      send({ type: 'tool_call_start', tool_call_id: 's2', tool_name: 'exec_shell', tool_args: { command: 'rg -n foo src' } });
      setTimeout(() => {
        send({ type: 'tool_call_result', tool_call_id: 's2', tool_name: 'exec_shell', tool_result: 'ok' });
        send({ type: 'done', inputTokens: 900, outputTokens: 200 });
        controller.close();
      }, holdMs);
    },
  });
}

async function measure(lines, holdMs) {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/api/agent/run')) {
      return new Response(shellStream(lines, holdMs), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    if (u.includes('/api/tui/status')) {
      return new Response(JSON.stringify({ phase: 'ACT', connected: true, model: 'gpt-oss:120b', trust: 3, tokens: 41000 }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const setup = await createTestRenderer({ width: 120, height: 40 });
  const root = createRoot(setup.renderer);
  flushSync(() => root.render(React.createElement(App, { version: 'probe' })));
  await setup.flush();
  await settle(600);

  flushSync(() => { for (const ch of 'list it') setup.mockInput.pressKey(ch); });
  await setup.flush();
  flushSync(() => setup.mockInput.pressEnter());
  // Let the result land in state and the run settle into its live shape.
  await settle(900);
  await setup.flush();

  // One keystroke, timed end-to-end through React + OpenTUI layout.
  const samples = [];
  for (let i = 0; i < 6; i += 1) {
    const t0 = performance.now();
    flushSync(() => setup.mockInput.pressKey('x'.charAt(0)));
    await setup.flush();
    samples.push(performance.now() - t0);
    await settle(60);
  }
  const worst = Math.max(...samples);
  const median = samples.slice().sort((a, b) => a - b)[Math.floor(samples.length / 2)];

  root.unmount();
  setup.renderer.destroy();
  return { worst, median, samples };
}

for (const [label, lines, holdMs] of [['control (40 lines)', 40, 1500], ['bash (4000 lines)', 4000, 1500]]) {
  const r = await measure(lines, holdMs);
  console.log(`\n[${label}] median=${r.median.toFixed(1)}ms worst=${r.worst.toFixed(1)}ms  [${r.samples.map((n) => n.toFixed(0)).join(', ')}]`);
  check(`${label}: keystroke lands within ${KEYS_BUDGET_MS}ms`, r.worst <= KEYS_BUDGET_MS, `worst=${r.worst.toFixed(1)}ms`);
}

console.log(`\nRESULT pass=${pass} fail=${fail}`);
if (fail) process.exitCode = 1;
