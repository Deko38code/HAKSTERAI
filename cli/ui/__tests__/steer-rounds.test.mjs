/* A live steer must land INSIDE the run it corrected.
 *
 * Regression pin for the owner's 2026-11-25 report: "when i send messeages
 * steer they dont clear and block my outputpanel". The steer used to be a
 * separate trailing turn, so the answer that kept streaming (patched into the
 * assistant turn ABOVE it) never became the newest row again.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { applySteer } from '../src/utils/steer-rounds.js';

const assistant = (rounds) => ({ id: 'a1', role: 'assistant', rounds, text: rounds.map((r) => r.text || '').join('') });

test('a steer becomes one marker round inside the run, with a writable round under it', () => {
  const before = assistant([{ text: 'Looking at the file now.', thinking: '', tools: [] }]);
  const after = applySteer(before, 'use the python path instead');

  assert.deepEqual(after.rounds.map((r) => r.steer || r.text), [
    'Looking at the file now.',
    'use the python path instead',
    '',
  ]);
  // The message is still one assistant turn: nothing is appended after it, so
  // the transcript tail cannot freeze on the operator's line.
  assert.equal(after.role, 'assistant');
  // The flat text used by the live output panel never carries the steer.
  assert.equal(after.text, 'Looking at the file now.');
});

test('the answer streamed after a steer continues UNDER the marker', () => {
  let m = assistant([{ text: 'part one ', thinking: '', tools: [] }]);
  m = applySteer(m, 'shorter please');
  // The next token patches the trailing round, exactly as the delta handler does.
  const rounds = m.rounds.map((r) => ({ ...r }));
  rounds[rounds.length - 1].text += 'part two';
  const order = rounds.map((r) => r.steer || r.text).filter(Boolean);
  assert.deepEqual(order, ['part one ', 'shorter please', 'part two']);
});

test('supersede retracts only the round being written, keeping completed rounds', () => {
  const before = assistant([
    { text: 'first answer.', thinking: '', tools: [] },
    { text: 'half of a sec', thinking: '', tools: [{ name: 'run_shell', result: 'ok' }] },
  ]);
  const after = applySteer(before, 'actually use curl', true);
  assert.equal(after.rounds[0].text, 'first answer.');
  assert.equal(after.rounds[1].text, '');
  assert.equal(after.rounds[1].tools.length, 1, 'completed tool rows survive the retraction');
  assert.equal(after.rounds[2].steer, 'actually use curl');
});

test('an empty steer adds no marker, and the input message is not mutated', () => {
  const before = assistant([{ text: 'answer', thinking: '', tools: [] }]);
  const snapshot = JSON.stringify(before);
  const after = applySteer(before, '   ');
  assert.equal(after.rounds.filter((r) => r.steer).length, 0);
  assert.equal(JSON.stringify(before), snapshot);
});

test('a steer on a run with no rounds yet still ends with a writable round', () => {
  const after = applySteer({ id: 'a2', role: 'assistant', rounds: [], text: '' }, 'focus on auth');
  assert.equal(after.rounds.length, 2);
  assert.equal(after.rounds[0].steer, 'focus on auth');
  assert.deepEqual(after.rounds[1], { text: '', thinking: '', tools: [] });
});
