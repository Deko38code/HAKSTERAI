#!/usr/bin/env node
/* Live-steering probe — steering must never interrupt a live run.
 *
 * History: this file used to pin the *opposite* behaviour. On 2026-11-24 the
 * requirement was "get the message before you finish", which was implemented by
 * aborting the SSE stream at a chunk boundary and regenerating the turn. On
 * 2026-11-26 the owner changed it: "fix our steer to not interrupt you but you
 * still grab message before your run to kill 2 birds 1 stone".
 *
 * So the invariant now is:
 *   1. the standard lane's stream loop reads NOTHING from the steer inbox —
 *      no abort, no retraction, no regeneration (killing 2 birds 1 stone: the
 *      answer already on screen survives, and the message is still drained at
 *      the top of the next turn, inside the same run);
 *   2. the `claude-cli` lane drains its inbox once the turn has CLOSED and
 *      never kills the child to take a steer;
 *   3. a steer the run never reached is handed back to the client instead of
 *      being dropped;
 *   4. the TUI records the operator's line and leaves a non-supersede steer's
 *      transcript completely intact.
 *
 * Every block below is read out of the real source, so deleting the boundary
 * drain or re-introducing a mid-stream kill fails here instead of at the
 * operator's keyboard.
 *
 * Run: node server/__smoke__/mid-stream-steer-probe.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverSrc = fs.readFileSync(path.resolve(here, '../src/index.js'), 'utf8');
import { applySteer } from '../../cli/ui/src/utils/steer-rounds.js';
const hookSrc = fs.readFileSync(path.resolve(here, '../../cli/ui/src/hooks/useAgentStream.js'), 'utf8');

const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};
let passed = 0;
const ok = (msg) => { passed++; console.log(`✓ ${msg}`); };

// ── 1. The standard lane's stream loop must not touch the inbox ───────────
const loopStart = serverSrc.indexOf('for await (const chunk of stream) {');
if (loopStart === -1) fail('the standard lane stream loop is missing from server/src/index.js');
const loopEnd = serverSrc.indexOf('// Stream finished successfully', loopStart);
if (loopEnd === -1) fail('could not find the end of the standard lane stream loop');
const streamLoop = serverSrc.slice(loopStart, loopEnd);

if (/steerInterrupt/.test(streamLoop)) fail('the stream loop grew a steer interrupt again — a steer would cut the live answer');
if (/streamAbort\.abort\(\)/.test(streamLoop)) fail('the stream loop aborts the reply again — that is exactly what the owner ruled out');
if (/agentSteerRuns/.test(streamLoop)) fail('the stream loop reads the steer inbox mid-answer; delivery belongs to the boundaries');
ok('standard lane: the stream loop never reads the inbox and never aborts');

// No leftover dead block: the post-stream interrupt referenced a variable that
// no longer exists and threw on every completed answer.
if (/if \(steerInterrupt\) \{/.test(serverSrc)) fail('a dead `if (steerInterrupt)` block is still present — it throws on every finished answer');
if (/steerInterrupts/.test(serverSrc)) fail('the retired interrupt counter is still declared');
ok('no dead interrupt path is left behind');

// ── 2. The boundary drains still exist ────────────────────────────────────
const turnStart = serverSrc.indexOf('for (let turn = 0; turn < maxTurns; turn++) {');
if (turnStart === -1) fail('the turn loop is missing');
const turnTop = serverSrc.slice(turnStart, turnStart + 4000);
if (!/agentSteerRuns\.get\(runId\)/.test(turnTop)) fail('the turn loop no longer drains the steer inbox before the next model call');
if (!/before the next model call/i.test(turnTop)) fail('the turn-loop drain lost its own description');
ok('standard lane: the inbox is still drained before each model call (inside the run)');

if (!/steer_undelivered/.test(serverSrc)) fail('an undelivered steer is no longer handed back to the client — it would be dropped');
ok('run end: a steer the run never reached is returned to the client, not dropped');

// ── 3. claude-cli takes its steer at the boundary, never by killing ───────
const laneStart = serverSrc.indexOf("if (cfg.type === 'claude-cli') {");
if (laneStart === -1) fail('the claude-cli lane is missing');
const laneEnd = serverSrc.indexOf("// ── codex-cli: a CLI lane", laneStart);
if (laneEnd === -1) fail('could not find the end of the claude-cli lane');
const lane = serverSrc.slice(laneStart, laneEnd);

if (!/takeSteerAtBoundary/.test(lane)) fail('the claude-cli lane has no boundary steer drain');
const takeIdx = lane.indexOf('const takeSteerAtBoundary');
const takeBody = lane.slice(takeIdx, lane.indexOf('};', takeIdx));
if (!/agentSteerRuns\.get\(runId\)/.test(takeBody)) fail('the boundary drain does not read the run\'s inbox');
if (!/items\.splice\(0, 8\)/.test(takeBody)) fail('the boundary drain does not consume the inbox (it would apply twice)');
if (/supersede: true/.test(takeBody)) fail('the boundary steer still asks the TUI to retract a delivered answer');
if (/child\.kill/.test(takeBody)) fail('the boundary drain kills the child — a steer must never cut a live turn');

if (/setInterval\(\s*\(\)\s*=>\s*\{[^}]*child\.kill/.test(lane)) fail('a steer poll still kills the running claude child mid-turn');
if (/steerPoll/.test(lane)) fail('the retired mid-turn steer poll is still in the lane');
if (!/steered: takeSteerAtBoundary\(\)/.test(lane)) fail('the turn no longer resolves with the steer taken at its boundary');
ok('claude-cli: the steer is taken after the turn closes; the child is never killed for it');

// ── 4. The TUI keeps the operator's line and the transcript ───────────────
const hStart = hookSrc.indexOf("case 'steer': {");
const hEnd = hookSrc.indexOf("case 'steer_undelivered': {", hStart);
if (hStart === -1) fail("the TUI's `case 'steer'` handler is missing");
if (hEnd === -1) fail("could not find `case 'steer_undelivered'` after the steer handler");

let hookBody = hookSrc.slice(hStart + "case 'steer': {".length, hEnd);
const lastBreak = hookBody.lastIndexOf('break;');
hookBody = hookBody.slice(0, lastBreak);

const runHook = new Function('evt', 'patch', 'assistantId', 'append', 'nextId', 'pushActivity', 'applySteer', hookBody);

const msg = { text: 'a b', rounds: [{ text: 'a b', thinking: '', tools: [] }] };
const appended = [];
const activity = [];
const patch = (id, fn) => { Object.assign(msg, fn(msg)); };
runHook(
  { type: 'steer', content: 'also check the port' },
  patch, 'ai-3',
  (m) => appended.push(m),
  () => 'user-3',
  (kind, text) => activity.push([kind, text]),
  applySteer,
);

if (msg.text !== 'a b' || msg.rounds[0].text !== 'a b') fail('a boundary steer wiped the delivered answer');
const marker = (msg.rounds || []).find((r) => r.steer === 'also check the port');
if (!marker) fail('the steer was not drawn as the operator line where it landed');
if ((msg.rounds[msg.rounds.length - 1] || {}).text !== '') fail('no fresh round after the marker — the answer would be written back inside it');
if (appended.length) fail('the steer was appended as a new turn (that is the panel-blocking shape)');
const said = activity.map(([, t]) => String(t)).join(' | ');
if (!/killing 2 birds 1 stone/.test(said)) fail('the applied-steer row no longer names the two things it did at once');
if (!/answer kept/.test(said)) fail('the applied-steer row does not say the answer was kept');
ok('TUI: the delivered answer survives, the operator line shows, the row names both wins');

// A legacy supersede event must still retract cleanly (older servers).
const msg2 = {
  text: 'earlier answer partial answ',
  rounds: [
    { text: 'earlier answer ', thinking: '', tools: [{ name: 'exec_shell', result: 'ok' }] },
    { text: 'partial answ', thinking: '', tools: [] },
  ],
};
const patch2 = (id, fn) => { Object.assign(msg2, fn(msg2)); };
runHook({ type: 'steer', content: 'no — use the other file', supersede: true }, patch2, 'ai-4', () => {}, () => 'u4', () => {}, applySteer);
if (msg2.rounds.length !== 4) fail(`rounds were dropped or not appended (${msg2.rounds.length})`);
if (msg2.rounds[0].text !== 'earlier answer ') fail('a completed round lost its text');
if (msg2.rounds[1].text !== '') fail(`a superseded partial was not retracted (${JSON.stringify(msg2.rounds[1].text)})`);
if (msg2.rounds[0].tools.length !== 1) fail('a completed round lost its tool rows');
if ((msg2.rounds[2] || {}).steer !== 'no — use the other file') fail('the operator line was not drawn where it landed');
if (msg2.text !== 'earlier answer ') fail(`the delivered text was not kept (${JSON.stringify(msg2.text)})`);
ok('TUI: a legacy supersede still retracts only the round being written');

console.log(`\n${passed} checks passed`);
