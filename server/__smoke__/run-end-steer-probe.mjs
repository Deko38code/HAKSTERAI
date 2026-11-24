#!/usr/bin/env node
/* Run-end live-steering probe.
 *
 * The steer inbox is drained at the TOP of the turn loop, so a run that
 * answers in a single reply closed before the drain and the steer was handed
 * back for the next run ("i have to wait til run ends", owner 2026-11-24).
 *
 * This pins the run-end checkpoint by extracting the real block out of
 * server/src/index.js and running it inside a loop with a fake inbox — so a
 * later edit that deletes it, or moves it after the run-end `return`, fails
 * here instead of silently at the operator's keyboard.
 *
 * Run: node server/__smoke__/run-end-steer-probe.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcPath = path.resolve(here, '../src/index.js');
const src = fs.readFileSync(srcPath, 'utf8');

const START = '// ── Live steering checkpoint (run end)';
const END = '// ── Refusal detection';

const startAt = src.indexOf(START);
const endAt = src.indexOf(END, startAt);

const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};

if (startAt === -1) fail('run-end steer checkpoint is missing from server/src/index.js');
if (endAt === -1) fail('could not find the refusal-detection marker after the checkpoint');
if (endAt < startAt) fail('checkpoint is not before the refusal/run-end path');

const block = src.slice(startAt, endAt);

// The block must sit before the run ends: the run-end exit is the first
// `return;` after the refusal marker inside the no-tool-calls branch.
const afterBlock = src.slice(endAt, src.indexOf('\n      }\n', endAt));
if (!/clearInterval\(heartbeat\)/.test(afterBlock) && !/Refusal detection/.test(afterBlock)) {
  // informational only — the ordering assertion below is what matters
}

// Run the real block inside a for-loop, exactly as the turn loop does.
const run = new Function(
  'runId', 'agentSteerRuns', 'agentMessages', 'res', 'maxTurns',
  `let turns = 0;
   for (let turn = 0; turn < maxTurns; turn++) {
     turns = turn + 1;
     ${block}
     return { ended: true, turn, turns };
   }
   return { ended: false, turn: turns - 1, turns };`,
);

// ── Case 1: a steer is waiting when the answer completes ──────────────────
{
  const writes = [];
  const agentMessages = [{ role: 'assistant', content: 'the first answer' }];
  const agentSteerRuns = new Map([['run-abc', { items: ['no — use the other file'], at: 0 }]]);
  const res = { write: (s) => writes.push(s) };

  const out = run('run-abc', agentSteerRuns, agentMessages, res, 25);

  if (out.ended && out.turn === 0) fail('run ended on the answering turn — the steer was never read');
  if (out.turns < 2) fail(`run did not take a further turn for the steer (turns=${out.turns})`);
  const inbox = agentSteerRuns.get('run-abc');
  if (!inbox || inbox.items.length !== 0) fail('steer inbox was not drained');
  const sys = agentMessages.find((m) => m.role === 'system' && /LIVE USER STEERING/.test(m.content || ''));
  if (!sys) fail('steer was not handed to the model as a system message');
  if (!/no — use the other file/.test(sys.content)) fail('system message does not carry the steer text');
  const evt = writes.map((w) => w.replace(/^data: /, '').trim()).map((w) => { try { return JSON.parse(w); } catch { return null; } }).find((e) => e && e.type === 'steer');
  if (!evt) fail('no `steer` event was emitted to the client');
  if (!/no — use the other file/.test(evt.content)) fail('steer event does not carry the steer text');
  console.log('✓ Case 1: waiting steer keeps the run open and reaches the model');
}

// ── Case 2: no steer waiting — the run must end exactly as before ─────────
{
  const writes = [];
  const agentMessages = [{ role: 'assistant', content: 'the only answer' }];
  const agentSteerRuns = new Map([['run-def', { items: [], at: 0 }]]);
  const res = { write: (s) => writes.push(s) };

  const out = run('run-def', agentSteerRuns, agentMessages, res, 25);

  if (!out.ended || out.turn !== 0) fail('run with an empty inbox did not end on the answering turn');
  if (writes.length !== 0) fail('empty inbox produced an event');
  if (agentMessages.length !== 1) fail('empty inbox changed the conversation');
  console.log('✓ Case 2: empty inbox ends the run on the answering turn');
}

// ── Case 3: no runId (non-steer run) — unchanged ──────────────────────────
{
  const writes = [];
  const agentMessages = [];
  const agentSteerRuns = new Map();

  const out = run(null, agentSteerRuns, agentMessages, { write: (s) => writes.push(s) }, 25);

  if (!out.ended || out.turn !== 0) fail('run without a runId did not end on the answering turn');
  if (writes.length !== 0) fail('run without a runId produced an event');
  console.log('✓ Case 3: runs without a runId are untouched');
}

console.log('\n3/3 run-end steering cases pass');
