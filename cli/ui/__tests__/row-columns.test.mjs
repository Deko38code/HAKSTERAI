/* row-columns — a catalog row splits name and detail without clipping a name
 * that fits, and without ever drawing past its body width.
 *
 * The menu's PORTS block is the reason this exists: at 44 columns a port row
 * rendered `▸ 1 ● :3579 HAKSTE…` with a clipped name and a detail column it
 * could not use — the same shape of bug the owner reported on the ports grid
 * ("better wrapping"). The split is now one pure function, pinned here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { splitRowColumns, MIN_DETAIL, MIN_LABEL } from '../src/utils/row-columns.js';

test('a name that fits keeps every character; the detail shortens instead', () => {
  const label = '▸ 1 ● :3579 HAKSTER-AI'; // 22
  const detail = 'online · pm2 hakster-router'; // 26
  const { labelW, valueW } = splitRowColumns(label, detail, 39);
  assert.equal(labelW, label.length, 'the name must not be clipped');
  assert.equal(labelW + 1 + valueW, 39, 'the row fills its body exactly');
  assert.ok(valueW > 0, 'the detail keeps what is left');
});

test('a wide body shows the whole detail', () => {
  const detail = 'online · pm2 hakster-router';
  const { labelW, valueW } = splitRowColumns('▸ 1 ● :3579 HAKSTER-AI', detail, 76);
  assert.equal(labelW, 22);
  assert.equal(valueW, detail.length, 'the detail is drawn whole when there is room');
});

test('a row with no detail gives the whole body to the name', () => {
  assert.deepEqual(splitRowColumns('  /help Help', '', 60), { labelW: 60, valueW: 0 });
});

test('a body too narrow for both keeps the name and drops the detail', () => {
  const { labelW, valueW } = splitRowColumns('  1 ● :3579 HAKSTER-AI', 'online · pm2 hakster-router', 8);
  assert.equal(valueW, 0);
  assert.equal(labelW, 8);
  assert.ok(labelW >= MIN_LABEL, 'nothing narrower than the readable minimum is claimed');
});

test('no row ever draws past its body width, at any size', () => {
  const labels = ['', 'a', '  1 ● :3579 HAKSTER-AI', 'x'.repeat(80), '  10 ● :5599 tools-gateway'];
  const details = ['', 'down', 'online · pm2 hakster-router', 'y'.repeat(90)];
  for (let body = 8; body <= 200; body += 1) {
    for (const label of labels) {
      for (const detail of details) {
        const { labelW, valueW } = splitRowColumns(label, detail, body);
        const used = labelW + (valueW ? valueW + 1 : 0);
        assert.ok(used <= body, `body ${body}: ${labelW}+${valueW} overflows`);
        // An empty label honestly gets no column; any real label gets at least
        // one so a caller can always draw something.
        assert.ok(labelW >= (label.length ? 1 : 0) && valueW >= 0);
      }
    }
  }
});

test('the guarantee holds for every row the menu actually draws', () => {
  // The real labels from ports-quickstart.mjs, against every popout width the
  // TUI opens at.
  const rows = [
    '▸ 1 ● :3579 HAKSTER-AI',
    '  3 ○ :4000 phantom',
    '  10 ● :5599 tools-gateway',
  ];
  for (let body = 20; body <= 120; body += 1) {
    for (const label of rows) {
      const { labelW } = splitRowColumns(label, 'online · pm2 hakster-router', body);
      if (label.length + 1 + MIN_DETAIL <= body) {
        assert.equal(labelW, label.length, `body ${body}: ${label} must read whole`);
      }
    }
  }
});
