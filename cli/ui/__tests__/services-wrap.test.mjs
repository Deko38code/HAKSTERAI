/* services-wrap — the ports grid wraps by content, and its row budget agrees.
 *
 * Owner, 2026-11-26: "did u fix the ports service grid up top with better
 * wrapping". Every cell used to be a fixed 16 columns, so `● claude-proxy`
 * rendered as `● clau…` even at 98 columns with ~40 columns of empty space to
 * the right, and a narrow terminal dropped services into "+N". These tests pin
 * the replacement behaviour, measured rather than eyeballed:
 *
 *   - a wide box uses the width it has (all five names whole, no "+N");
 *   - no grid ever draws past its own inner width (no border drift);
 *   - the drawn row count equals what statusServicesRows() reserved, because a
 *     panel taller than its budget pushes every panel below it off the screen.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  gridShape,
  statusServicesRows,
  maxRowsFor,
  CELL_MIN,
  GAP,
} from '../src/components/services-grid.mjs';

const CLI_DIR = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const REPO = path.resolve(CLI_DIR, '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

const SERVICES = [
  { port: 3579, name: 'haksterAi' },
  { port: 8081, name: 'cinevault' },
  { port: 4000, name: 'phantom' },
  { port: 8082, name: 'claude-proxy' },
  { port: 5555, name: 'miniforge' },
];

/** Width a `:port ● name` cell needs to render whole, after Cell's label split. */
const naturalWidth = (s) => String(`:${s.port}`).length + 1 + String(`● ${s.name}`).length;

test('no grid ever draws past the inner width, at any size', () => {
  for (let width = 24; width <= 200; width += 1) {
    for (let n = 0; n <= 24; n += 1) {
      const { inner, cols, cellW, capacity } = gridShape(width, n);
      assert.ok(cols >= 1, `width ${width} n ${n}: no columns`);
      assert.ok(cellW >= 1, `width ${width} n ${n}: cell width ${cellW}`);
      assert.ok(
        cols * cellW + (cols - 1) * GAP <= inner,
        `width ${width} n ${n}: ${cols}x${cellW} overflows inner ${inner}`,
      );
      assert.ok(cols <= Math.max(1, n), `width ${width} n ${n}: more columns than cells`);
      assert.ok(capacity >= 0, `width ${width} n ${n}: negative capacity`);
    }
  }
});

test('the drawn rows are exactly the rows the budget reserved', () => {
  for (let width = 24; width <= 200; width += 1) {
    for (let n = 1; n <= 24; n += 1) {
      const { cols, capacity, rows } = gridShape(width, n);
      // The panel draws ceil(shown / cols) rows, where shown is capped at
      // capacity by the "+N" cell, and always at least one.
      const drawn = Math.max(1, Math.ceil(Math.min(n, capacity) / cols));
      assert.equal(rows, drawn, `width ${width} n ${n}: budget ${rows} vs drawn ${drawn}`);
      assert.equal(statusServicesRows(width, n, true, true), 3 + 1 + rows);
      assert.equal(statusServicesRows(width, n, true, false), 3 + rows);
      // Two-line cells take two rows each.
      assert.equal(statusServicesRows(width, n, false, true), 3 + 1 + rows * 2);
    }
  }
});

test('a wide box uses its width instead of truncating names', () => {
  const need = Math.max(...SERVICES.map(naturalWidth)); // ":8082 ● claude-proxy" = 20
  for (const width of [98, 140]) {
    const { cols, cellW, capacity, rows } = gridShape(width, SERVICES.length);
    assert.ok(capacity >= SERVICES.length, `width ${width}: capacity ${capacity} hides a service`);
    assert.ok(cellW >= need, `width ${width}: cell ${cellW} cannot hold a ${need}-char name`);
    assert.ok(rows <= 2, `width ${width}: ${rows} rows`);
  }
  const wide = gridShape(140, SERVICES.length);
  assert.equal(wide.rows, 1, '140 columns fit all five on one row');
});

test('a narrow box wraps onto extra rows rather than hiding services behind "+N"', () => {
  const { cols, capacity, rows } = gridShape(44, SERVICES.length);
  assert.ok(maxRowsFor(44) >= 3, 'a narrow box may use a third row');
  assert.equal(capacity, cols * rows, 'capacity matches the rows that are drawn');
  assert.ok(capacity >= SERVICES.length, `44 columns hid ${SERVICES.length - capacity} services`);
  assert.ok(cols >= 2, 'one column per row wastes a narrow screen');
});

test('long names are not clipped when the width allows them whole', () => {
  // Cell dense mode gives the label min(len, w/2, 8) and the value the rest.
  const fits = (cellW, s) => {
    const lw = Math.max(3, Math.min(Math.floor(cellW / 2), 8, `:${s.port}`.length));
    return `● ${s.name}`.length <= cellW - lw - 1;
  };
  for (const width of [66, 98, 140]) {
    const { cellW } = gridShape(width, SERVICES.length);
    for (const s of SERVICES) {
      assert.ok(fits(cellW, s), `width ${width}: :${s.port} ${s.name} clipped at cell ${cellW}`);
    }
  }
});

test('the panel and the bundle read the shared wrapping module, not a fixed cell', () => {
  const panel = read('cli/ui/src/components/StatusServicesPanel.jsx');
  assert.ok(
    panel.includes("from './services-grid.mjs'"),
    'StatusServicesPanel must import the shared wrapping math',
  );
  assert.ok(
    /w=\{cellW\}/.test(panel),
    'the panel must give each Cell the computed width, not a constant',
  );
  assert.ok(
    !/const CELL_W = 16/.test(panel),
    'the fixed 16-column cell is what truncated every name — it must not come back',
  );
  const bundle = read('cli/ui-fb.mjs');
  assert.ok(
    bundle.includes('CELL_TARGET'),
    'ui-fb.mjs is stale — run npm run build:ui so the shipped TUI carries the wrap',
  );
});

test('the wrap never squeezes a cell below the readable minimum', () => {
  for (let width = 24; width <= 200; width += 1) {
    for (let n = 1; n <= 24; n += 1) {
      const { cellW, inner } = gridShape(width, n);
      // Either the cell is readable, or the box is simply too narrow to offer
      // one and the single column takes what there is.
      assert.ok(
        cellW >= CELL_MIN || cellW === inner || cellW === inner - 1,
        `width ${width} n ${n}: ${cellW}-wide cell in a ${inner}-wide box`,
      );
    }
  }
});
