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
  flushSync(() => setup.mockInput.pressKey('d'));
  await settle(200);
  await setup.flush();
  flushSync(() => setup.mockInput.pressKey('o', { ctrl: true }));
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

  const c0 = confirmCalls[0] || {};
  const c1 = confirmCalls[1] || {};
  const cPassword = confirmCalls[2] || {};

  const checks = [
    // ── baseline chrome ──
    ['header renders', /haksterAi/.test(idleFrame)],
    ['status bar renders', /ads on/.test(idleFrame)],
    ['live ad rail fills from the real ad service', /your own agent harness/.test(idleFrame)],
    ['composer shows the placeholder', /describe a task/.test(idleFrame)],

    // ── plain chat turn ──
    ['submitted prompt appears in the transcript', /fix the bug/.test(chatFrame)],
    ['streamed answer appears', /Patched the handler and added a test\./.test(chatFrame)],
    ['reasoning is shown separately', /look at the handler first/.test(chatFrame)],
    ['todo panel reflects the checklist tool', /1\/2 completed/.test(chatFrame)],
    // Anchored to the keystroke: the dashboard panel titles must appear in the
    // frame captured right after the `d` keypress.
    ['tab then d reaches the dashboard view', /Session/.test(dashFrame) && /Agent/.test(dashFrame) && /Context/.test(dashFrame)],
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
  ];


  let failed = 0;
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