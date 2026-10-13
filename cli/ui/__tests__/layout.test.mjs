/* Tests for the ported layout maths and the transcript row estimator.
 *
 * These are the two places in the TUI where a wrong number is silent rather
 * than loud: a bad column count shears the dashboard, and a bad row estimate
 * pushes the status bar off the bottom. Both are pure functions precisely so
 * they can be pinned here instead of eyeballed in a terminal.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { computeSmartColumns, MIN_COLUMN_WIDTH } from '../src/utils/layout-helpers.js';
import {
  computeGridLayout,
  WIDTH_MD_THRESHOLD,
  WIDTH_LG_THRESHOLD,
  WIDTH_XL_THRESHOLD,
} from '../src/hooks/useGridLayout.js';
import { wrappedRows, estimateRows, fitTranscript } from '../src/utils/transcript-rows.js';

test('computeSmartColumns never returns zero columns', () => {
  assert.equal(computeSmartColumns(0, 3), 1);
  assert.equal(computeSmartColumns(1, 3), 1);
});

test('computeSmartColumns uses one column per item while they fit', () => {
  assert.equal(computeSmartColumns(2, 4), 2);
  assert.equal(computeSmartColumns(3, 3), 3);
});

test('computeSmartColumns prefers a balanced grid over a ragged one', () => {
  // The upstream special case this port must not lose: 4 panels on a
  // three-column terminal read as 2x2, not 3 + 1.
  assert.equal(computeSmartColumns(4, 3), 2);
  assert.equal(computeSmartColumns(6, 3), 3);
  assert.equal(computeSmartColumns(9, 4), 3);
});

test('computeGridLayout forces a single column when two would not fit', () => {
  const narrow = MIN_COLUMN_WIDTH * 2; // one column short of the gap-inclusive minimum
  const { columns, columnWidth, columnGroups } = computeGridLayout([1, 2, 3], narrow);
  assert.equal(columns, 1);
  assert.equal(columnWidth, narrow);
  assert.deepEqual(columnGroups, [[1, 2, 3]]);
});

test('computeGridLayout widens with the terminal at each threshold', () => {
  const items = [1, 2, 3, 4, 5, 6, 7, 8];
  // Below the medium threshold the extra width cannot buy a column.
  assert.equal(computeGridLayout(items, WIDTH_MD_THRESHOLD - 1).columns, 1);
  assert.equal(computeGridLayout(items, WIDTH_MD_THRESHOLD).columns, 2);
  assert.equal(computeGridLayout(items, WIDTH_LG_THRESHOLD).columns, 2);
  // At 200 all three thresholds clear, so the ceiling is 4 columns — which is
  // what upstream's "200+: up to 4 columns" comment means. Eight items then
  // make a perfect 4-wide grid rather than a smart-balanced one.
  assert.equal(computeGridLayout(items, WIDTH_XL_THRESHOLD).columns, 4);
});

test('computeGridLayout never returns a column narrower than the floor', () => {
  for (let width = 1; width <= 260; width += 1) {
    const { columnWidth, columns } = computeGridLayout([1, 2, 3, 4], width);
    assert.ok(columnWidth >= Math.min(MIN_COLUMN_WIDTH, width), `width=${width}`);
    assert.ok(columns >= 1, `width=${width}`);
  }
});

test('computeGridLayout groups round-robin so reading order runs down each column', () => {
  const { columns, columnGroups } = computeGridLayout(['a', 'b', 'c', 'd', 'e', 'f'], 160);
  assert.equal(columns, 3);
  assert.deepEqual(columnGroups, [['a', 'd'], ['b', 'e'], ['c', 'f']]);
});

test('wrappedRows counts a newline as its own row and charges full rows', () => {
  assert.equal(wrappedRows('', 10), 0);
  assert.equal(wrappedRows('short', 10), 1);
  assert.equal(wrappedRows('x'.repeat(40), 10), 4);
  assert.equal(wrappedRows('a\nb', 10), 2);
  // A width of zero must not divide by zero.
  assert.equal(wrappedRows('abc', 0), 3);
});

test('estimateRows includes the border rows of a message box', () => {
  const plain = { id: '1', role: 'assistant', text: 'hi', thinking: '', tools: [] };
  assert.equal(estimateRows(plain, 80), 4); // 3 chrome rows + 1 text row

  const notice = { id: '2', role: 'system', text: 'a notice' };
  assert.equal(estimateRows(notice, 80), 2); // a single bordered line

  const withTool = {
    id: '3',
    role: 'assistant',
    text: 'done',
    thinking: '',
    tools: [{ id: 't', name: 'shell', args: {}, result: 'ok' }],
  };
  assert.equal(estimateRows(withTool, 80), 6); // 3 chrome + 1 tool + 1 result + 1 text

  assert.equal(estimateRows(null, 80), 0);
});

test('fitTranscript keeps the newest turns and counts what it dropped', () => {
  const mk = (id, rows) => ({
    id,
    role: 'assistant',
    text: 'x'.repeat(rows * 74), // ~1 row per 74 columns at width 80
    thinking: '',
    tools: [],
  });
  const messages = [mk('old', 20), mk('mid', 4), mk('new', 4)];

  const { visible, hidden } = fitTranscript(messages, 80, 20);
  assert.equal(hidden, 1);
  assert.deepEqual(visible.map((m) => m.id), ['mid', 'new']);
});

test('fitTranscript always returns at least one turn, even when it overflows', () => {
  const huge = { id: 'only', role: 'assistant', text: 'x'.repeat(5000), thinking: '', tools: [] };
  const { visible, hidden } = fitTranscript([huge], 80, 10);
  assert.equal(visible.length, 1);
  assert.equal(hidden, 0);
});

test('fitTranscript of an empty transcript is empty, not a crash', () => {
  const { visible, hidden } = fitTranscript([], 80, 20);
  assert.deepEqual(visible, []);
  assert.equal(hidden, 0);
});
