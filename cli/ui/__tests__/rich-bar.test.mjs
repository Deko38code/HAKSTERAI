/* The bar every reading in the header is drawn with.
 *
 * Owner, 2026-11-25: "with cpu and ram can you add bars that go with the % next
 * to them up top" and "see if you can find some nice bars that look rich not
 * generic". The bar has to be accurate (the number beside it is the exact
 * reading), honest (no measurement is not 0 %) and always exactly as wide as it
 * was asked to be, or the header row it sits in reflows.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { richBar } from '../src/utils/bar.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...p) => fs.readFileSync(path.join(here, '..', ...p), 'utf8');
const text = (parts) => (parts || []).map((p) => p.t).join('');
const FULL = '█';
const TRACK = '╌';

test('the bar is exactly as wide as asked, at every reading', () => {
  for (const pct of [0, 1, 7, 25, 33, 49, 50, 62, 87, 99, 100]) {
    for (const w of [2, 3, 5, 8]) {
      const t = text(richBar(pct, w, 'green'));
      assert.equal([...t].length, w, `${pct}% at width ${w} drew ${JSON.stringify(t)}`);
    }
  }
});

test('0 and 100 are the whole bar, not a near miss', () => {
  assert.equal(text(richBar(0, 5)), TRACK.repeat(5));
  assert.equal(text(richBar(100, 5)), FULL.repeat(5));
});

test('the fill ends on an eighth-block head, so the shape matches the number', () => {
  // 62 % of five cells is 3.1 cells: three full and one eighth.
  assert.equal(text(richBar(62, 5)), `${FULL.repeat(3)}▏${TRACK}`);
  // 50 % of five is 2.5: two full and a half block.
  assert.equal(text(richBar(50, 5)), `${FULL.repeat(2)}▌${TRACK.repeat(2)}`);
  // A fill past 7/8 of a cell rounds up to that whole cell rather than drawing
  // a head one eighth past the end.
  assert.equal(text(richBar(99, 5)), FULL.repeat(5));
});

test('out-of-range and missing readings are clamped or absent', () => {
  assert.equal(text(richBar(140, 4)), FULL.repeat(4));
  assert.equal(text(richBar(-5, 4)), TRACK.repeat(4));
  // No measurement is not zero — it is no bar at all.
  assert.equal(richBar(null, 5), null);
  assert.equal(richBar(undefined, 5), null);
  assert.equal(richBar(NaN, 5), null);
  // A zero reading is a real measurement and still draws the track.
  assert.equal(text(richBar(0, 5)), TRACK.repeat(5));
});

test('the filled and empty parts carry their own colours', () => {
  const parts = richBar(60, 5, 'yellow');
  assert.equal(parts[0].fg, 'yellow');
  assert.equal(parts[parts.length - 1].fg, 'gray');
});

test('the header draws cpu, ram and the memory bank with the same bar', () => {
  const app = read('src', 'App.jsx');
  assert.match(app, /import \{ richBar \} from '\.\/utils\/bar\.js';/);
  assert.match(app, /const cpuBarParts = richBar\(host && host\.cpuPct/);
  assert.match(app, /const ramBarParts = richBar\(host && host\.memPct/);
  assert.match(app, /const memBar = richBar\(memPct, MEMBAR_W, memFg\)/);
  // The memory bar keeps its slot at the right edge of the row and its ◈.
  assert.match(app, /\.\.\.memBar,/);
  // The generic block-against-block bar is gone from the host readings.
  assert.doesNotMatch(app, /hostBar\(/);
});
