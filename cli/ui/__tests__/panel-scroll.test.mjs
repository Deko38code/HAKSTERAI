import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clampStart,
  gutterChar,
  keyMatches,
  maxStartOf,
  nearestStart,
  overflows,
  scrollHint,
  stepOffset,
} from '../src/utils/panel-scroll.js';

/* The maths every panel's window depends on. A wrong start silently draws the
 * wrong rows, so each rule the components rely on is pinned here. */

test('maxStartOf is the last window that still fills the panel', () => {
  assert.equal(maxStartOf(10, 4), 6);
  assert.equal(maxStartOf(4, 4), 0);
  assert.equal(maxStartOf(2, 4), 0); // content shorter than the window
  assert.equal(maxStartOf(0, 0), 0);
});

test('clampStart: null follows the tail, numbers are clamped', () => {
  assert.equal(clampStart(null, 10, 4), 6); // follow = tail
  assert.equal(clampStart(2, 10, 4), 2);
  assert.equal(clampStart(99, 10, 4), 6);
  assert.equal(clampStart(-5, 10, 4), 0);
});

test('stepOffset re-arms follow only on reaching the bottom', () => {
  assert.equal(stepOffset(null, 10, 4, -1), 5); // leaving the tail parks the window
  assert.equal(stepOffset(5, 10, 4, 1), null); // back at the tail = follow again
  assert.equal(stepOffset(0, 10, 4, 1), 1);
  assert.equal(stepOffset(0, 10, 4, -1), 0); // top is a wall
  assert.equal(stepOffset(null, 3, 4, 1), null); // nothing to scroll
});

test('overflows only when there is more content than rows', () => {
  assert.equal(overflows(5, 4), true);
  assert.equal(overflows(4, 4), false);
  assert.equal(overflows(0, 4), false);
  assert.equal(overflows(5, 0), false);
});

test('gutterChar always draws ▲ and ▼ ends while the content overflows', () => {
  const rows = 6;
  const total = 30;
  assert.equal(gutterChar(0, rows, total, 10), '▲');
  assert.equal(gutterChar(rows - 1, rows, total, 10), '▼');
  // A track cell is either the thumb or the rail, never a letter.
  for (let i = 1; i < rows - 1; i++) assert.match(gutterChar(i, rows, total, 10), /^[█│]$/);
  // Thumb is a single run: once it ends it cannot come back further down.
  const marks = Array.from({ length: rows - 2 }, (_, k) => gutterChar(k + 1, rows, total, 10));
  const first = marks.indexOf('█');
  const last = marks.lastIndexOf('█');
  assert.ok(first >= 0, 'thumb is visible at the top');
  assert.equal(last - first + 1, marks.filter((m) => m === '█').length, 'thumb is contiguous');
});

test('gutterChar thumb moves down as the window scrolls', () => {
  const rows = 10;
  const total = 100;
  const topOf = (start) => Array.from({ length: rows - 2 }, (_, k) => gutterChar(k + 1, rows, total, start)).indexOf('█');
  assert.ok(topOf(0) < topOf(40), 'thumb sits lower mid-scroll');
  assert.ok(topOf(40) < topOf(90), 'thumb sits at the bottom at the end');
});

test('gutterChar on a 1-2 row window is a solid bar, not an arrow-only bar', () => {
  assert.equal(gutterChar(0, 1, 10, 0), '█');
  assert.equal(gutterChar(0, 2, 10, 0), '█');
});

test('scrollHint reads as a window, and flags a parked window with ⇣', () => {
  assert.equal(scrollHint(3, 4, 0, true), '3'); // fits: just the count
  assert.equal(scrollHint(10, 4, null, true), '7-10/10');
  assert.equal(scrollHint(10, 4, null, true).includes('⇣'), false);
  assert.equal(scrollHint(10, 4, 0, false), '1-4/10 ⇣');
  // A selection-following panel reports `following` even when the cursor is at
  // the top; the label must still describe the rows on screen, not the tail.
  assert.equal(scrollHint(27, 6, 0, true), '1-6/27');
  assert.equal(scrollHint(27, 6, 21, true), '22-27/27');
});

test('nearestStart keeps a selected row visible and centred', () => {
  assert.equal(nearestStart(0, 100, 10), 0);
  assert.equal(nearestStart(50, 100, 10), 45);
  assert.equal(nearestStart(99, 100, 10), 90);
  assert.equal(nearestStart(3, 5, 10), 0); // list shorter than window
});

test('keyMatches requires the exact modifier set, so bindings cannot collide', () => {
  const up = { name: 'up' };
  const shiftUp = { name: 'up', shift: true };
  const ctrlUp = { name: 'up', ctrl: true };
  const altUp = { name: 'up', meta: true };
  assert.equal(keyMatches(up, 'up', 'none'), true);
  assert.equal(keyMatches(shiftUp, 'up', 'none'), false);
  assert.equal(keyMatches(shiftUp, 'up', 'shift'), true);
  assert.equal(keyMatches(ctrlUp, 'up', 'shift'), false);
  assert.equal(keyMatches(altUp, 'up', 'alt'), true);
  assert.equal(keyMatches(ctrlUp, 'up', 'ctrl'), true);
  // A ctrl chord that also happens to be shift must not fire a shift binding.
  assert.equal(keyMatches({ name: 'up', shift: true, ctrl: true }, 'up', 'shift'), false);
  assert.equal(keyMatches(up, 'down', 'none'), false);
  assert.equal(keyMatches(null, 'up', 'none'), false);
});
