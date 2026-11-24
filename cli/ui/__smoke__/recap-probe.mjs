/* Regression pin for the ▣ recap row (owner, 2026-11-24: "add recap in cli when
 * agent is idle").
 *
 * Renders the real App against a mock /api/agent/run that streams a complete
 * turn (one tool call, one reportable token total) and then closes. Three
 * things are asserted, because each is a way this can silently break:
 *
 *   1. before anything runs, the row is ABSENT — a fresh TUI must not open with
 *      a row of zeros the run never earned;
 *   2. while the run is live, the row is ABSENT and the spinner owns the row —
 *      a recap printed over a working run would read as "already finished";
 *   3. once the run ends, the row is present exactly ONCE, carries the run's
 *      own counts (turns, tools, ok, tokens), and still fits on one line at a
 *      narrow width instead of wrapping into the transcript's rows.
 *
 * Runs under Bun (`bun ui/__smoke__/recap-probe.mjs`) — @opentui/core loads a
 * native binary through Bun's FFI.
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

/* One finished turn: a todo call that marks a step done, one shell call, the
 * answer, and a token report the panel is allowed to show. The done frame and
 * the close are delayed so a frame can be captured while the run is still
 * live — that is the assertion `live` below. */
const LIVE_MS = 700;

function turnStream() {
  return new ReadableStream({
    start(controller) {
      const send = (f) => controller.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`));
      send({ type: 'phase', phase: 'ACT', turn: 1 });
      send({
        type: 'tool_call_start',
        tool_call_id: 'td1',
        tool_name: 'update_todo',
        tool_args: { todos: [{ text: 'read the file', status: 'done' }, { text: 'patch it', status: 'done' }] },
      });
      send({ type: 'tool_call_result', tool_call_id: 'td1', tool_name: 'update_todo', tool_result: 'ok' });
      send({ type: 'tool_call_start', tool_call_id: 't1', tool_name: 'exec_shell', tool_args: { command: 'node -c server.js' } });
      send({ type: 'tool_call_result', tool_call_id: 't1', tool_name: 'exec_shell', tool_result: 'ok' });
      send({ type: 'delta', content: 'Patched and checked.' });
      setTimeout(() => {
        send({ type: 'done', model: 'glm-5.2:cloud', provider: 'ollama', inputTokens: 1200, outputTokens: 340 });
        controller.close();
      }, LIVE_MS);
    },
  });
}

globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/api/agent/run')) {
    return new Response(turnStream(), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }
  if (u.includes('/api/tui/status')) {
    return new Response(JSON.stringify({ phase: 'IDLE', connected: true, model: 'glm-5.2:cloud', trust: 3, tokens: 41000 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (u.includes('/api/agent/mcp-status') || u.includes('/api/ads')) {
    return new Response(JSON.stringify({ servers: [], creatives: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
};

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass += 1; console.log(`  ok  ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const recapRows = (lines) => lines.filter((l) => l.includes('▣ recap'));

async function run(cols, rows) {
  const setup = await createTestRenderer({ width: cols, height: rows });
  const root = createRoot(setup.renderer);
  flushSync(() => root.render(React.createElement(App, { version: 'probe' })));
  await setup.flush();
  await settle(600);
  await setup.flush();
  const frame = () => setup.captureCharFrame().split('\n').map((l) => strip(l).replace(/\s+$/, ''));

  const before = frame();
  check(`${cols}x${rows}: no recap before any run`, recapRows(before).length === 0);

  // Submit one prompt.
  flushSync(() => {
    for (const ch of 'patch it') setup.mockInput.pressKey(ch);
  });
  await setup.flush();
  await settle(80);
  flushSync(() => setup.mockInput.pressEnter());
  await settle(150);
  await setup.flush();
  const live = frame();
  check(`${cols}x${rows}: no recap while the run is live`, recapRows(live).length === 0);

  // Let the turn finish and the stream close.
  await settle(LIVE_MS + 900);
  await setup.flush();
  const after = frame();
  const rowsWithRecap = recapRows(after);
  console.log(`\n[${cols}x${rows}] recap: ${rowsWithRecap.map((l) => l.trim()).join(' | ') || '(none)'}`);
  check(`${cols}x${rows}: recap appears exactly once when idle`, rowsWithRecap.length === 1, `rows=${rowsWithRecap.length}`);

  const line = rowsWithRecap[0] || '';
  check(`${cols}x${rows}: states the turn count`, /\b1 turn\b/.test(line), line.trim());
  check(`${cols}x${rows}: states the tool count`, /\b2 tools\b/.test(line), line.trim());
  check(`${cols}x${rows}: states the token report`, /1\.2K in \/ 340 out/.test(line), line.trim());
  check(`${cols}x${rows}: states the todo tally`, /2\/2 todos/.test(line), line.trim());
  check(`${cols}x${rows}: fits inside the column`, line.length <= cols, `len=${line.length} cols=${cols}`);
  // The row is a single line: no second row carries a continuation of it.
  check(`${cols}x${rows}: does not wrap onto a second row`, after.filter((l) => /in \/ .* out/.test(l)).length === 1);

  root.unmount();
  setup.renderer.destroy();
}

await run(120, 40);
await run(80, 30);

console.log(`\nRESULT pass=${pass} fail=${fail}`);
if (fail) process.exitCode = 1;
