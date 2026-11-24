/* The render harness driven by ui/smoke.mjs.
 *
 * Everything here exists to make the TUI observable without a terminal: OpenTUI's
 * test renderer captures frames, and the mock input feeds keystrokes.
 *
 * The agent mock reproduces the server's BLOCKING approval behaviour rather than
 * just replaying a script: on `needs_confirmation` it holds the SSE stream open
 * and only sends the rest of the turn once /api/agent/confirm arrives. A client
 * that displays the prompt but never posts the decision therefore hangs here,
 * which is the failure this test exists to catch.
 */
import React from 'react';
import { createTestRenderer } from '@opentui/core/testing';
import { createRoot, flushSync } from '@opentui/react';
import App from '../src/App.jsx';

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

// The decode splash is a start screen, not part of what these frames assert:
// with the owner's prefs it lasts ~1.6 s and would swallow the first keystrokes.
// App honours this flag once, for this process only.
process.env.HAKSTER_NO_INTRO = '1';
// Scripted prompts must never reach the operator's real ~/.hakster/history.
process.env.HAKSTER_NO_HISTORY = '1';

/* A turn the way a real agent run looks on a small screen: reasoning, a
 * couple of spoken lines, then one shell call whose result is 40 long lines.
 * The transcript must still show what the agent SAID — that is the owner's
 * 2026-11-23 report ("only shell call tools i see"). */
const BIG_RESULT = Array.from(
  { length: 40 },
  (_, i) => `webpack asset bundle-${i + 1}.js 4.2 MiB [emitted] asset annotation that is far longer than the column width and would wrap without clipping`,
);
const BIG_TURN = {
  holds: false,
  pre: [
    { type: 'phase', phase: 'ACT', turn: 1 },
    { type: 'thinking_start' },
    { type: 'thinking', content: 'Checking the bundle sizes first.' },
    { type: 'thinking_end' },
    { type: 'delta', content: 'The bundle is too big — splitting the vendor chunk now.' },
    {
      type: 'tool_call_start',
      tool_call_id: 'b1',
      tool_name: 'exec_shell',
      tool_args: { command: 'npm run build' },
    },
    {
      type: 'tool_call_result',
      tool_call_id: 'b1',
      tool_name: 'exec_shell',
      tool_result: BIG_RESULT.join('\n'),
    },
    { type: 'delta', content: 'Answer: the build passes after the split.' },
    // A call left running: the card must show the spinner state with a live
    // duration instead of an empty body (old ToolPanels: "waiting for output…").
    {
      type: 'tool_call_start',
      tool_call_id: 'b2',
      tool_name: 'web_search',
      tool_args: { query: 'webpack splitChunks vendor chunk' },
    },
    { type: 'done', model: 'glm-5.2:cloud', provider: 'ollama', inputTokens: 200, outputTokens: 40 },
  ],
};

/* A sub-agent call the way "testing agents" looks: an MCP tool call whose result
 * is the peer's output, then a done. The MCP Output box must show it while the
 * call is in flight and clear itself once the turn is idle (owner, 2026-11-24:
 * "clear after sub agents output stops then clear panel for your workspace"). */
const MCP_TURN = {
  holds: false,
  pre: [
    { type: 'phase', phase: 'ACT', turn: 1 },
    { type: 'thinking_start' },
    { type: 'thinking', content: 'Handing this to the codex sub-agent.' },
    { type: 'thinking_end' },
    {
      type: 'tool_call_start',
      tool_call_id: 'm1',
      tool_name: 'mcp__codex__codex_readonly',
      tool_args: { prompt: 'list the repo root' },
    },
    {
      type: 'tool_call_result',
      tool_call_id: 'm1',
      tool_name: 'mcp__codex__codex_readonly',
      tool_result: 'CODEX-MARKER output from the peer',
    },
    { type: 'done', model: 'glm-5.2:cloud', provider: 'ollama', inputTokens: 10, outputTokens: 5 },
  ],
};

const TAB = '\t';
const ENTER = '\r';
const ESC = '\u001b';
const CTRL_O = '\u000f';

/** One turn per run: a plain reply, then two that stop for approval. */
const TURNS = [
  {
    pre: [
      { type: 'phase', phase: 'THINK', turn: 1 },
      {
        type: 'tool_call_start',
        tool_call_id: 't0',
        tool_name: 'update_todo',
        tool_args: {
          todos: [
            { text: 'read the file', status: 'done' },
            { text: 'patch it', status: 'in_progress' },
          ],
        },
      },
      { type: 'tool_call_result', tool_call_id: 't0', tool_name: 'update_todo', tool_result: 'ok' },
      { type: 'thinking_start' },
      { type: 'thinking', content: 'I should look at the handler first.' },
      { type: 'thinking_end' },
      { type: 'delta', content: 'Patched the handler ' },
      { type: 'delta', content: 'and added a test.' },
      { type: 'done', model: 'glm-5.2:cloud', provider: 'ollama', inputTokens: 120, outputTokens: 30 },
    ],
    holds: false,
  },
  {
    // Non-sudo, so `a` (allow always) is offered and must be honoured.
    command: 'rm -rf /tmp/hakster-build',
    reason: 'rm requires confirmation in suggest mode',
    holds: true,
  },
  {
    // Sudo, so `a` must be refused and only `y` may approve.
    command: 'sudo systemctl restart nginx',
    reason: 'Elevated privilege command: sudo systemctl restart nginx',
    holds: true,
  },
  {
    // Sudo with an approval password configured: only the password approves.
    command: 'sudo apt-get install -y nmap',
    reason: 'Elevated privilege command: sudo apt-get install -y nmap',
    holds: true,
  },
];

/** The frames a held turn emits before it stops for approval. */
function heldPreFrame(run) {
  return [
    { type: 'phase', phase: 'ACT', turn: 1 },
    { type: 'delta', content: 'About to run the command. ' },
    {
      type: 'needs_confirmation',
      tool_call_id: 'c1',
      tool_name: 'shell',
      reason: run.reason,
      command: run.command,
      args: { command: run.command },
    },
  ];
}

/**
 * What the server sends once the decision arrives.
 *
 * The completion line names the command so each held run leaves a marker that
 * belongs to that run alone. Without it, "the run resumed" is indistinguishable
 * between runs in an accumulated capture and silently matches an earlier one.
 */
function heldPostFrames(run) {
  return [
    { type: 'tool_call_result', tool_call_id: 'c1', tool_name: 'shell', tool_result: 'command finished' },
    { type: 'delta', content: `and ${run.command} is finished.` },
    { type: 'done', model: 'glm-5.2:cloud', provider: 'ollama', inputTokens: 10, outputTokens: 5 },
  ];
}

export async function run({ adsPort }) {
  const realFetch = globalThis.fetch;
  const enc = new TextEncoder();

  const confirmCalls = [];
  const runBatch = [];
  let bigMode = false;
  let mcpMode = false;
  let runIndex = 0;
  let heldController = null;
  let heldRun = null;

  globalThis.fetch = async (url, opts) => {
    const u = String(url);

    if (u.includes('/api/tui/status')) {
      return new Response(
        JSON.stringify({
          phase: 'ACT',
          connected: true,
          model: 'glm-5.2:cloud',
          trust: 3,
          tokens: 41_200,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    // The Squad view lists the server's own MCP peers; mock one live, one
    // lazy and one non-agent server so both the filter and the ordering show.
    if (u.includes('/api/agent/mcp-status')) {
      return new Response(
        JSON.stringify({
          servers: [
            { name: 'filesystem', initialized: true, lazy: false, toolCount: 14, tools: ['read_file'] },
            { name: 'subagents', initialized: true, lazy: false, toolCount: 2, tools: ['dispatch_subagent', 'list_subagents'] },
            { name: 'codex', initialized: false, lazy: true, toolCount: 1, tools: ['codex_readonly'] },
          ],
          totalMcpTools: 17,
          totalTools: 9,
          builtinTools: 9,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    if (u.includes('/api/agent/confirm')) {
      const body = JSON.parse(opts.body);
      confirmCalls.push(body);
      // Hold the run exactly as the server does, then release it.
      if (heldController && heldRun) {
        for (const f of heldPostFrames(heldRun)) {
          heldController.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`));
        }
        heldController.close();
        heldController = null;
        heldRun = null;
      }
      return new Response(JSON.stringify({ ok: true, approved: body.approved }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (u.includes('/api/agent/run')) {
      if (mcpMode) {
        const stream = new ReadableStream({
          start(controller) {
            for (const f of MCP_TURN.pre) controller.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`));
            controller.close();
          },
        });
        return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      if (bigMode) {
        const stream = new ReadableStream({
          start(controller) {
            for (const f of BIG_TURN.pre) controller.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`));
            controller.close();
          },
        });
        return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      const turn = TURNS[Math.min(runIndex, TURNS.length - 1)];
      runIndex += 1;
      const batch = { turn, confirms: [] };
      runBatch.push(batch);

      const stream = new ReadableStream({
        start(controller) {
          for (const f of turn.holds ? heldPreFrame(turn) : turn.pre) {
            controller.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`));
          }
          if (turn.holds) {
            // Deliberately NOT closed: the real server blocks here until
            // /api/agent/confirm arrives.
            heldController = controller;
            heldRun = turn;
          } else {
            controller.close();
          }
        },
      });

      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }

    // Anything else — the ad service — hits the real server on adsPort.
    return realFetch(url, opts);
  };

  // ── Set up the OpenTUI test renderer ────────────────────────────────────
  const setup = await createTestRenderer({ width: 120, height: 40 });
  const root = createRoot(setup.renderer);
  flushSync(() => root.render(React.createElement(App, { version: 'smoke' })));
  await setup.flush();

  const frame = () => setup.captureCharFrame();
  const type = async (text, wait = 700) => {
    flushSync(() => {
      for (const ch of text) setup.mockInput.pressKey(ch);
    });
    await setup.flush();
    await settle(80);
    flushSync(() => setup.mockInput.pressEnter());
    await settle(wait);
    await setup.flush();
  };

  // Give the ad service time to respond and the initial status poll to land.
  await settle(900);
  await setup.flush();
  const idleFrame = frame();

  // ── 1. A plain turn ──────────────────────────────────────────────────────
  await type('fix the bug', 800);
  await setup.flush();
  const chatFrame = frame();

  // ── 2. The chrome reachable once focus leaves the composer ───────────────
  flushSync(() => setup.mockInput.pressTab());
  await settle(60);
  await setup.flush();
  flushSync(() => setup.mockInput.pressKey('d'));
  await settle(200);
  await setup.flush();
  const dashFrame = frame();
  flushSync(() => setup.mockInput.pressKey('s')); // Lab: live scripts
  await settle(250);
  await setup.flush();
  const scriptsFrame = frame();
  flushSync(() => setup.mockInput.pressEscape());
  await settle(120);
  await setup.flush();
  flushSync(() => setup.mockInput.pressKey('g')); // Lab: squad
  await settle(250);
  await setup.flush();
  const squadFrame = frame();
  flushSync(() => setup.mockInput.pressEscape()); // back to the chat…
  await settle(120);
  await setup.flush();
  flushSync(() => setup.mockInput.pressKey('o', { ctrl: true })); // …where the dock lives
  await settle(100);
  await setup.flush();
  const dockFrame = frame();
  flushSync(() => setup.mockInput.pressTab()); // back to the composer
  await settle(60);
  await setup.flush();

  // ── 3. A held approval, answered with `a` (allow always) ─────────────────
  await type('remove the build dir', 600);
  await setup.flush();
  const approvalFrame = frame();
  const adsBeforeApprove = /ads on/.test(approvalFrame);
  flushSync(() => setup.mockInput.pressKey('a'));
  await settle(600);
  await setup.flush();
  const afterApprove = frame();
  const confirmCountAfterA = confirmCalls.length;

  // ── 4. A sudo approval: `a` must be refused, `y` must approve ────────────
  await type('restart nginx', 600);
  await setup.flush();
  const sudoFrame = frame();
  flushSync(() => setup.mockInput.pressKey('a')); // must be ignored
  await settle(300);
  await setup.flush();
  const afterSudoA = frame();
  const confirmCountAfterSudoA = confirmCalls.length;
  flushSync(() => setup.mockInput.pressKey('y'));
  await settle(600);
  await setup.flush();
  const sudoResolved = frame();
  const confirmCountAfterSudoY = confirmCalls.length;

  // ── 5. Sudo with an approval password: only the password approves ────────
  // getDangerPassword() reads the environment on every call, so setting it here
  // is picked up by the next render without restarting anything.
  process.env.HAKSTER_DANGER_PASSWORD = 'correct-horse-battery';
  await type('install nmap', 600);
  await setup.flush();
  const passwordFrame = frame();
  const beforePasswordKeys = confirmCalls.length;
  flushSync(() => setup.mockInput.pressKey('y')); // must be ignored: this prompt wants the password
  await settle(200);
  await setup.flush();
  const afterYOnPassword = confirmCalls.length;
  flushSync(() => {
    for (const ch of 'wrong-horse') setup.mockInput.pressKey(ch);
  });
  await setup.flush();
  await settle(80);
  // Captured BEFORE enter: this is the only frame in the suite that shows the
  // field mid-entry, so it is the only place masking can actually be checked.
  const whileTypingPassword = frame();
  flushSync(() => setup.mockInput.pressEnter());
  await settle(300);
  await setup.flush();
  const afterWrongPassword = frame();
  const afterWrongCount = confirmCalls.length;
  flushSync(() => {
    for (const ch of 'correct-horse-battery') setup.mockInput.pressKey(ch);
  });
  await setup.flush();
  await settle(80);
  flushSync(() => setup.mockInput.pressEnter());
  await settle(600);
  await setup.flush();
  const passwordResolved = frame();
  const confirmCountAfterPassword = confirmCalls.length;
  delete process.env.HAKSTER_DANGER_PASSWORD;

  root.unmount();
  setup.renderer.destroy();
  await settle(50);

  // ── 7. The sub-agent (MCP) panel clears when its output stops ───────────
  // Owner, 2026-11-24: "our panel when testing agents … need to clear after sub
  // agents output stops then clear panel for your workspace". Shorten the settle
  // window for the probe; the shipped default is 8 s.
  process.env.HAKSTER_MCP_SETTLE_MS = '400';
  mcpMode = true;
  const mcpSetup = await createTestRenderer({ width: 120, height: 44 });
  const mcpRoot = createRoot(mcpSetup.renderer);
  flushSync(() => mcpRoot.render(React.createElement(App, { version: 'smoke' })));
  await mcpSetup.flush();
  await settle(400);
  flushSync(() => {
    for (const ch of 'run codex') mcpSetup.mockInput.pressKey(ch);
  });
  await mcpSetup.flush();
  flushSync(() => mcpSetup.mockInput.pressEnter());
  // Right after the call lands, the panel is up with the peer's output.
  await settle(250);
  await mcpSetup.flush();
  const mcpLiveFrame = mcpSetup.captureCharFrame();
  // Then the turn goes idle and the panel clears on its own.
  await settle(1400);
  await mcpSetup.flush();
  const mcpClearFrame = mcpSetup.captureCharFrame();
  mcpRoot.unmount();
  mcpSetup.renderer.destroy();
  mcpMode = false;
  delete process.env.HAKSTER_MCP_SETTLE_MS;
  await settle(50);

  // ── 6. A small screen with a huge shell result ─────────────────────────
  // The owner's report: "its not showing agents output what he says something
  // only shell call tools i see". 120x30 is a realistic split-terminal size,
  // and this turn dumps 40 long lines from one command — the layout must keep
  // the agent's own words on screen and cap what the dump can cost.
  bigMode = true;
  const small = await createTestRenderer({ width: 120, height: 30 });
  const smallRoot = createRoot(small.renderer);
  flushSync(() => smallRoot.render(React.createElement(App, { version: 'smoke' })));
  await small.flush();
  await settle(500);
  flushSync(() => {
    for (const ch of 'build it') small.mockInput.pressKey(ch);
  });
  await small.flush();
  flushSync(() => small.mockInput.pressEnter());
  await settle(900);
  await small.flush();
  const bigFrame = small.captureCharFrame();
  // Reasoning fold (the OMP block behaviour, owner 2026-11-24: "i want the
  // win"): a finished thought is one "Thought for Ns" line; Ctrl+T reopens it.
  flushSync(() => small.mockInput.pressKey('t', { ctrl: true }));
  await small.flush();
  await settle(120);
  const expandedFrame = small.captureCharFrame();
  flushSync(() => small.mockInput.pressKey('t', { ctrl: true }));
  await small.flush();
  smallRoot.unmount();
  small.renderer.destroy();
  bigMode = false;
  await settle(50);

  const c0 = confirmCalls[0] || {};
  const c1 = confirmCalls[1] || {};
  const cPassword = confirmCalls[2] || {};

  const checks = [
    // ── baseline chrome ──
    ['header renders', /haksterAi/.test(idleFrame)],
    ['status bar renders', /ads on/.test(idleFrame)],
    // The creative is laid out across the rail's width, so its copy wraps;
    // this asserts the real ad service filled the rail, not one exact line.
    ['live ad rail fills from the real ad service', /haksterAi — your own/.test(idleFrame)],
    ['composer shows the placeholder', /describe a task/.test(idleFrame)],

    // ── plain chat turn ──
    ['submitted prompt appears in the transcript', /fix the bug/.test(chatFrame)],
    ['streamed answer appears', /Patched the handler and added a test\./.test(chatFrame)],
    ['finished reasoning folds to one line', /⋯ Thought for \d+s/.test(chatFrame)],
    ['ctrl+t reopens a folded thought', /Checking the bundle sizes first/.test(expandedFrame)],
    ['todo panel reflects the checklist tool', /1\/2 completed/.test(chatFrame)],
    // Anchored to the keystroke: the dashboard panel titles must appear in the
    // frame captured right after the `d` keypress.
    ['tab then d reaches the dashboard view', /Session/.test(dashFrame) && /Agent/.test(dashFrame) && /Context/.test(dashFrame)],
    // ── the Lab views ──
    // Scripts discovers real files, so this asserts the OMP-snapshot window and
    // both panes are drawn — at 120 cols the compare view is two-up.
    [
      's opens the live-scripts snapshot window',
      /Live scripts/.test(scriptsFrame) && /OMP SNAPSHOT/.test(scriptsFrame) && /OURS/.test(scriptsFrame) && /LIVE/.test(scriptsFrame),
    ],
    // The status bar is fixed chrome: if a Lab view overran its budget it would
    // fall off the bottom of the 40-row frame.
    ['the scripts view fits the screen', /ads on/.test(scriptsFrame)],
    [
      'g lists the server\'s own agent peers, lazy ones marked',
      /Squad/.test(squadFrame) && /subagents/.test(squadFrame) && /1\/2 live · 1 lazy/.test(squadFrame) && /codex/.test(squadFrame),
    ],
    ['the squad view fits the screen', /ads on/.test(squadFrame)],

    // ── a 40-line shell dump on a 30-row screen ──
    // What the agent said, not just what the shell printed.
    ['the agent\'s spoken line stays on screen', /The bundle is too big/.test(bigFrame)],
    ['its closing answer stays on screen', /Answer: the build passes after the split/.test(bigFrame)],
    // A dense turn still states its reasoning — as the fold line, not silently.
    ['a dense turn still states its reasoning', /⋯ Thought for \d+s/.test(bigFrame)],
    // The dump is capped and says where the rest is. On a wide terminal the
    // only live panel is the right sidebar's ▶ Output (owner, 2026-11-24: "keep
    // right one remove middle live panel"), so the pointer names that pane.
    ['the shell result is capped, with a pointer to the live pane', /more lines · ▶ Output/.test(bigFrame)],
    ['the cap is real: line 40 of the dump is not drawn', !/bundle-40\.js/.test(bigFrame)],
    // ── the tool card (ported from the old CLI's ToolPanels) ──
    // Args are `k=v`, not raw JSON: JSON.stringify wrapped a six-key args
    // object across rows and pushed the result out of the card.
    ['the tool card flattens args to k=v', /✓ exec_shell command=npm run build/.test(bigFrame)],
    ['the tool card shows the call duration', /exec_shell command=npm run build +\d+(?:\.\d+)?(?:ms|s)/.test(bigFrame)],
    // A call still running renders its spinner state, not an empty card.
    ['a running call says it is waiting for output', /waiting for output…/.test(bigFrame)],
    ['a running call shows a live duration', /web_search query=webpack splitChunks[^\n]*\d+(?:\.\d+)?(?:ms|s)/.test(bigFrame)],
    ['the small screen still keeps its status bar', /ads on/.test(bigFrame)],

    // The caret is escaped: unescaped it is a start-of-string anchor, and the
    // check then silently asks whether the frame BEGINS with "O collapse".
    ['ctrl+o expands the dock', /enter open/.test(dockFrame) && /\^O collapse/.test(dockFrame)],

    // ── a held approval ──
    ['approval prompt replaces nothing and is shown', /approval required/.test(approvalFrame)],
    ['approval prompt names the command', /rm -rf \/tmp\/hakster-build/.test(approvalFrame)],
    ['the run is still parked while the prompt is up', !/is finished\./.test(approvalFrame)],
    ['answering releases the held stream', /rm -rf \/tmp\/hakster-build is finished\./.test(afterApprove)],
    [
      'the prompt is gone once answered',
      /rm -rf \/tmp\/hakster-build is finished\./.test(afterApprove) && !/allow this session/.test(afterApprove),
    ],
    ['exactly one confirm was posted', confirmCountAfterA === 1, `got ${confirmCountAfterA}`],
    ['approve sends approved:true', c0.approved === true],
    ['`a` sends permanent:true', c0.permanent === true],
    ['confirm echoes the tool_call_id', c0.toolCallId === 'c1'],
    ['confirm scopes the session', c0.sessionId === 'default'],
    ['confirm carries the exact command', c0.command === 'rm -rf /tmp/hakster-build'],
    // The decisive one: if App's shortcut layer were not stood down while a
    // prompt is up, this `a` would ALSO have toggled the ad rail off.
    ['`a` did not leak into the ad shortcut', adsBeforeApprove && /ads on/.test(afterApprove)],

    // ── a sudo approval ──
    ['sudo prompts with the stricter variant', /sudo approval required/.test(sudoFrame)],
    [
      'sudo does not offer `a`',
      /sudo approval required/.test(afterSudoA) && !/allow always/.test(afterSudoA),
    ],
    ['`a` is refused for sudo (nothing posted)', confirmCountAfterSudoA === 1, `got ${confirmCountAfterSudoA}`],
    [
      'sudo is still parked after the refused `a`',
      /sudo approval required/.test(afterSudoA) && !/is finished\./.test(afterSudoA),
    ],
    ['`y` approves the sudo command', confirmCountAfterSudoY === 2, `got ${confirmCountAfterSudoY}`],
    ['sudo approval is session-scoped, never permanent', c1.approved === true && c1.permanent === false],
    ['sudo run resumes after approval', /sudo systemctl restart nginx is finished\./.test(sudoResolved)],

    // ── sudo with an approval password configured ──
    ['a configured password switches the prompt to the masked input', /password/.test(passwordFrame) && /the agent approval password/.test(passwordFrame)],
    // The two assertions the old label above only implied. It matched the
    // placeholder text alone, so it passed against an input that echoed every
    // keystroke in plaintext — exactly the regression that was repaired here.
    ['the typed password is never echoed', !/wrong-horse/.test(whileTypingPassword)],
    // 11 characters were typed, so the field must show exactly 11 asterisks:
    // masking that lost count would hide characters that were actually entered.
    ['the field masks it, one asterisk per character', /\*{11}/.test(whileTypingPassword)],
    ['`y` cannot approve a password prompt', afterYOnPassword === beforePasswordKeys, `posted ${afterYOnPassword - beforePasswordKeys}`],
    ['a wrong password does not post a decision', afterWrongCount === beforePasswordKeys, `posted ${afterWrongCount - beforePasswordKeys}`],
    ['a wrong password says so and clears the field', /wrong password/.test(afterWrongPassword)],
    ['the cleared field falls back to the placeholder', /the agent approval password/.test(afterWrongPassword) && !/\*{11}/.test(afterWrongPassword)],
    ['the correct password approves', confirmCountAfterPassword === 3, `got ${confirmCountAfterPassword}`],
    ['password approval is approved:true and session-scoped', cPassword.approved === true && cPassword.permanent === false],
    ['the password run resumes', /sudo apt-get install -y nmap is finished\./.test(passwordResolved)],
    // ── the sub-agent panel ──
    ['the sub-agent panel shows while the call runs', /MCP Output/.test(mcpLiveFrame) && /CODEX-MARKER/.test(mcpLiveFrame)],
    ['the sub-agent panel clears once its output stops', !/MCP Output/.test(mcpClearFrame)],
    ['the workspace keeps the sub-agent output after the panel clears', /CODEX-MARKER/.test(mcpClearFrame)],
  ];


  let failed = 0;
  if (process.env.HAKSTER_SMOKE_DUMP) {
    // Full frames, for diagnosing a layout failure (e.g. a panel one row too
    // tall, which clips the status bar). Never printed unless asked for.
    console.log('──── FULL IDLE FRAME ────');
    console.log(idleFrame);
    console.log('──── FULL CHAT FRAME ────');
    console.log(chatFrame);
    console.log('──── FULL DASH FRAME ────');
    console.log(dashFrame);
    console.log('──── FULL SCRIPTS FRAME ────');
    console.log(scriptsFrame);
    console.log('──── FULL SQUAD FRAME ────');
    console.log(squadFrame);
    console.log('──── FULL SUDO FRAME ────');
    console.log(sudoFrame);
    console.log('──── FULL BIG-OUTPUT FRAME ────');
    console.log(bigFrame);
  }
  console.log('──────── CHECKS ────────');
  for (const [name, pass, extra] of checks) {
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${!pass && extra ? ` — ${extra}` : ''}`);
    if (!pass) failed += 1;
  }

  if (failed) {
    console.log('\n──────── DIAGNOSTICS ────────');
    console.log('confirmCalls:', JSON.stringify(confirmCalls, null, 1));
    console.log('\n── idle frame (first 600 chars) ──');
    console.log(idleFrame.slice(0, 600));
    console.log('\n── chat frame (first 600 chars) ──');
    console.log(chatFrame.slice(0, 600));
    console.log('\n── approval frame (first 600 chars) ──');
    console.log(approvalFrame.slice(0, 600));
    console.log('\n── after approve (first 600 chars) ──');
    console.log(afterApprove.slice(0, 600));
    console.log('\n── sudo frame (first 600 chars) ──');
    console.log(sudoFrame.slice(0, 600));
    console.log('\n── password frame (first 600 chars) ──');
    console.log(passwordFrame.slice(0, 600));

  } else {
    console.log('\nall TUI render checks passed');
  }

  return failed;
}

export default run;