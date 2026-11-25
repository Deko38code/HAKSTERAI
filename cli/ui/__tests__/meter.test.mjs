/* The autolearn meter's own movement, and the arrow/percent it is drawn with.
 *
 * The bug these pin: the score is clamped 0–100, so once it sits at its
 * ceiling `delta` is 0 on every successful tool while `points` keeps climbing —
 * the autolearn arrow then showed the flat marker (◆) on an up-move. `pointsDelta`
 * is the movement before that clamp, and the autolearn arrow reads it instead.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { anchorPoints, createMeter, pointsPct, meterArrow, arrowColor } from '../../smartness.mjs';

// The anchor is read from ~/.hakster/perf_history.json, so pin the score where
// the bug lives: at the 100 ceiling. A success then earns points but no score.
function meterAtTop() {
  const m = createMeter();
  m.bump(100 - m.snapshot().score); // lift the score to 100
  m.resetTask();
  return m;
}

test('a success at score 100 still reports an up-move on points', () => {
  const m = meterAtTop();
  assert.equal(m.snapshot().score, 100);
  m.tool('read_file', {}, true, 'some file contents');
  const s = m.snapshot();
  assert.equal(s.delta, 0, 'the clamped score did not move');
  assert.ok(s.pointsDelta > 0, 'but the point total did');
  assert.equal(meterArrow(s.pointsDelta), '▲');
  assert.equal(arrowColor(s.pointsDelta), 'green');
});

test('a failure reports a down-move on points', () => {
  const m = meterAtTop();
  m.tool('bash', {}, false, 'Error: ENOENT cannot find module x');
  const s = m.snapshot();
  assert.ok(s.pointsDelta < 0);
  assert.equal(meterArrow(s.pointsDelta), '▼');
  assert.equal(arrowColor(s.pointsDelta), 'red');
});

test('resetTask clears both arrows at the start of a turn', () => {
  const m = meterAtTop();
  const before = m.snapshot().points; // seeded from real history — compare relative
  m.tool('read_file', {}, true, 'x');
  m.resetTask();
  const s = m.snapshot();
  assert.equal(s.delta, 0);
  assert.equal(s.pointsDelta, 0);
  assert.equal(meterArrow(s.pointsDelta), '◆');
  assert.equal(s.points, before + 1, 'the session total itself carries over');
});

test('the point total resumes from the last session instead of starting at zero', () => {
  // Owner, 2026-11-25: the ✦ figure reset on every launch, so learning that had
  // already happened read as lost. anchorPoints reads the last session's total.
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hakster-meter-')), 'perf_history.json');
  fs.writeFileSync(file, JSON.stringify([{ points: 12 }, { points: 413 }]));
  assert.equal(anchorPoints(file), 413);
  fs.writeFileSync(file, JSON.stringify([]));
  assert.equal(anchorPoints(file), 0);
  assert.equal(anchorPoints(path.join(path.dirname(file), 'missing.json')), 0);
});

test('the health ratio is the share of recent actions that worked, with the window’s trend', () => {
  // Owner, 2026-11-25: the ◈ memory bar's health reading — green good, red bad,
  // "slipping" / "getting smarter" — measured, never guessed.
  const m = createMeter();
  const empty = m.snapshot().health;
  assert.equal(empty.samples, 0);
  assert.equal(empty.trend, 'steady', 'nothing recent is steady, not an invented direction');
  assert.equal(empty.pct, m.snapshot().score, 'and reads the smartness score');
  m.tool('read_file', {}, true, 'ok');
  m.tool('read_file', {}, true, 'ok');
  m.tool('read_file', {}, true, 'ok');
  m.tool('bash', {}, false, 'Error: ENOENT cannot find module x');
  const h = m.snapshot().health;
  assert.equal(h.samples, 4);
  assert.equal(h.pct, 75, '3 of 4 worked');
  assert.equal(h.trend, 'slipping', 'the window’s movement points down');
});

test('pointsPct is the same 0-100 scale the points bar draws', () => {
  assert.equal(pointsPct(0), 0);
  assert.equal(pointsPct(42), 42);
  assert.equal(pointsPct(100), 100);
  assert.equal(pointsPct(150), 100, 'clamped to the bar ceiling, never past it');
  assert.equal(pointsPct(-5), 0);
  assert.equal(pointsPct(null), 0);
});
