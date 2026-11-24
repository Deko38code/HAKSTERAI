#!/usr/bin/env node
/* Mid-stream live-steering probe.
 *
 * The drain at the top of the turn loop only runs when the run takes another
 * turn, and the run-end checkpoint only fires once the answer is already
 * finished — so a steer typed while a long reply streamed still produced
 * "answer, then a correction after it". The owner's requirement (2026-11-24)
 * is the opposite: the agent must get the message BEFORE it finishes doing the
 * work, and answer once with it applied.
 *
 * This pins both halves of that:
 *   1. the server interrupt block in server/src/index.js — read the inbox at a
 *      chunk boundary, abort the stream, and regenerate the same turn; and
 *   2. the TUI retraction in cli/ui/src/hooks/useAgentStream.js — drop the
 *      partial prose of the current round (keeping completed rounds) so the
 *      regenerated answer replaces it.
 *
 * Both blocks are extracted from the real source and executed, so deleting or
 * reordering either one fails here instead of silently at the operator's
 * keyboard.
 *
 * Run: node server/__smoke__/mid-stream-steer-probe.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverSrc = fs.readFileSync(path.resolve(here, '../src/index.js'), 'utf8');
const hookSrc = fs.readFileSync(path.resolve(here, '../../cli/ui/src/hooks/useAgentStream.js'), 'utf8');

const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};
let passed = 0;
const ok = (msg) => { passed++; console.log(`✓ ${msg}`); };

// ── Server block: interruptible steering inside the stream loop ───────────
const START = '        // ── Interruptible steering';
const END = '        const delta = chunk.choices[0]?.delta;';

const startAt = serverSrc.indexOf(START);
const endAt = serverSrc.indexOf(END, startAt);
if (startAt === -1) fail('the mid-stream interrupt block is missing from server/src/index.js');
if (endAt === -1) fail('could not find the chunk body after the interrupt block');
const serverBlock = serverSrc.slice(startAt, endAt);

// The regeneration must follow the stream, not end the run.
if (!/supersede: true/.test(serverSrc)) fail('the steer event no longer carries `supersede` — the TUI cannot retract the partial reply');
if (!/turn--;\s*\/\/ regenerate the same turn/.test(serverSrc)) fail('the interrupt no longer regenerates the same turn');
if (!/steerInterrupts < 6/.test(serverBlock)) fail('the interrupt is not bounded — a chatty operator could pin one turn open');

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const runServer = new AsyncFunction(
  'runId', 'steerInterrupts', 'agentSteerRuns', 'streamAbort',
  `let steerInterrupt = '';
   let chunks = 0;
   const stream = (async function* () { for (let i = 0; i < 3; i++) yield { choices: [{ delta: { content: 'x' } }] }; })();
   try {
     for await (const chunk of stream) {
       chunks++;
${serverBlock}
     }
   } catch (_) { /* the abort path may reject — that is expected */ }
   return { steerInterrupt, chunks };`,
);

// ── Case 1: no steer waiting — the stream is left completely alone ────────
{
  const abort = { called: false, abort() { this.called = true; } };
  const inbox = new Map([['run-1', { items: [], at: 0 }]]);
  const out = await runServer('run-1', 0, inbox, abort);
  if (out.steerInterrupt !== '') fail('an empty inbox interrupted the stream');
  if (out.chunks !== 3) fail(`an empty inbox shortened the stream (${out.chunks}/3 chunks)`);
  if (abort.called) fail('an empty inbox aborted the stream');
  ok('empty inbox: the reply streams to completion untouched');
}

// ── Case 2: a steer lands mid-stream — stop, take it, regenerate ──────────
{
  const abort = { called: false, abort() { this.called = true; } };
  const items = ['  use port 8081 instead  '];
  const inbox = new Map([['run-1', { items, at: 0 }]]);
  const out = await runServer('run-1', 0, inbox, abort);
  if (out.steerInterrupt !== 'use port 8081 instead') fail(`steer not captured cleanly (got ${JSON.stringify(out.steerInterrupt)})`);
  if (!abort.called) fail('the stream was not aborted — the reply would finish before the steer is read');
  if (out.chunks !== 1) fail(`the stream kept going after the steer (${out.chunks} chunks)`);
  if (items.length !== 0) fail('the steer was left in the inbox — it would be applied twice');
  ok('steer mid-stream: generation stops at the next chunk and the steer is taken');
}

// ── Case 3: the bound holds — past 6 interrupts the reply finishes ────────
{
  const abort = { called: false, abort() { this.called = true; } };
  const items = ['one more'];
  const inbox = new Map([['run-1', { items, at: 0 }]]);
  const out = await runServer('run-1', 6, inbox, abort);
  if (out.steerInterrupt !== '') fail('past the bound the stream was still interrupted');
  if (abort.called) fail('past the bound the stream was aborted');
  if (items.length !== 1) fail('past the bound the steer was consumed anyway');
  ok('bound holds: after 6 interrupts the reply is allowed to finish');
}

// ── TUI block: retract the partial prose of the current round ────────────
const hStart = hookSrc.indexOf("case 'steer': {");
const hEnd = hookSrc.indexOf("case 'steer_undelivered': {", hStart);
if (hStart === -1) fail("the TUI's `case 'steer'` handler is missing");
if (hEnd === -1) fail("could not find `case 'steer_undelivered'` after the steer handler");

let hookBody = hookSrc.slice(hStart + "case 'steer': {".length, hEnd);
const lastBreak = hookBody.lastIndexOf('break;');
hookBody = hookBody.slice(0, lastBreak);
if (!/evt\.supersede/.test(hookBody)) fail('the TUI steer handler no longer retracts a superseded reply');
if (!/cur\.text = ''/.test(hookBody)) fail('the TUI steer handler no longer clears the partial round text');

const runHook = new Function('evt', 'patch', 'assistantId', 'append', 'nextId', 'pushActivity', hookBody);

// A turn with one completed round and one partial round that is streaming.
const msg = {
  text: 'earlier answer partial answ',
  rounds: [
    { text: 'earlier answer ', thinking: '', tools: [{ name: 'exec_shell', result: 'ok' }] },
    { text: 'partial answ', thinking: '', tools: [] },
  ],
};
const appended = [];
const activity = [];
const patch = (id, fn) => { Object.assign(msg, fn(msg)); };
runHook(
  { type: 'steer', content: 'no — use the other file', supersede: true },
  patch, 'ai-1',
  (m) => appended.push(m),
  () => 'user-1',
  (kind, text) => activity.push([kind, text]),
);

if (msg.rounds.length !== 2) fail(`rounds were dropped (${msg.rounds.length})`);
if (msg.rounds[0].text !== 'earlier answer ') fail('a completed round lost its text');
if (!msg.rounds[0].tools.length) fail('a completed round lost its tool rows');
if (msg.rounds[1].text !== '') fail(`the partial prose was not retracted (${JSON.stringify(msg.rounds[1].text)})`);
if (msg.text !== 'earlier answer ') fail(`flat text still carries the retracted prose (${JSON.stringify(msg.text)})`);
if (!appended.some((m) => m.role === 'user' && m.text === 'no — use the other file')) fail('the steer was not shown as the operator line');
ok('TUI: the partial reply is retracted, completed work is kept, the steer is shown');

// A steer that did NOT supersede anything must leave the transcript alone.
const msg2 = { text: 'a b', rounds: [{ text: 'a b', thinking: '', tools: [] }] };
const patch2 = (id, fn) => { Object.assign(msg2, fn(msg2)); };
runHook({ type: 'steer', content: 'add tests too' }, patch2, 'ai-2', () => {}, () => 'u2', () => {});
if (msg2.text !== 'a b' || msg2.rounds[0].text !== 'a b') fail('a normal (non-supersede) steer wiped the transcript');
ok('TUI: a normal steer leaves the transcript intact');

console.log(`\n${passed} checks passed`);
