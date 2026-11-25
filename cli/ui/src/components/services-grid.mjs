/* services-grid — the pure wrapping math behind the top status box's ports grid.
 *
 * Its own module rather than part of the JSX for one reason: the row budget in
 * App.jsx, the renderer and the tests must read ONE implementation. A panel that
 * draws a different number of rows than the budget reserved pushes every panel
 * below it off the screen, so those two can never be allowed to drift.
 *
 * Owner, 2026-11-26: "did u fix the ports service grid up top with better
 * wrapping". The old shape gave every cell a fixed 16 columns, so `claude-proxy`
 * rendered as `● clau…` even with forty columns of empty space beside it, and a
 * narrow terminal dropped services into "+N". Now the cells are sized from the
 * width actually available: as many columns as fit with whole names, never fewer
 * than the row budget needs, and the leftover width is shared out so the row
 * fills its box instead of ending ragged.
 */

export const CELL_MIN = 11; // narrowest readable ":8080 ● n…" cell
export const CELL_TARGET = 20; // ":8082 ● claude-proxy" fits whole at this width
export const GAP = 1;

/** Rows the grid may use. A wide box keeps two (cheap); a narrow one gets a
 *  third, because two columns of readable names beat three columns of "● haks…". */
export function maxRowsFor(width) {
  return Math.max(24, Number(width) || 80) - 4 >= 60 ? 2 : 3;
}

/** The grid's shape at `width` for `count` cells.
 *  Returns { inner, cols, cellW, capacity, rows } — `capacity` is how many cells
 *  fit, so anything past it becomes the "+N" cell, and `rows` is exactly how many
 *  cell rows will be drawn. */
export function gridShape(width, count, maxRows = null) {
  const w = Math.max(24, Number(width) || 80);
  const inner = Math.max(1, w - 4);
  const n = Math.max(0, Math.floor(Number(count) || 0));
  const rowCap = Math.max(1, Math.min(4, Math.floor(Number(maxRows) || maxRowsFor(w))));
  if (n === 0) return { inner, cols: 1, cellW: inner, capacity: 0, rows: 0 };

  // Columns that fit with a full-width cell, the columns the row budget needs at
  // minimum, and the most columns a still-readable cell allows.
  const colsAtTarget = Math.max(1, Math.floor((inner + GAP) / (CELL_TARGET + GAP)));
  const colsAtMin = Math.max(1, Math.floor((inner + GAP) / (CELL_MIN + GAP)));
  const colsNeeded = Math.ceil(n / rowCap);
  const widest = Math.max(1, Math.min(n, colsAtMin, Math.max(colsAtTarget, colsNeeded)));
  const rows = Math.max(1, Math.min(rowCap, Math.ceil(Math.min(n, widest * rowCap) / widest)));
  // Balance the rows: five cells in four columns would draw as 4 + 1, a lone
  // cell on a nearly empty line. Ceil(n / rows) wraps them 3 + 2 instead, which
  // also hands each cell the width that line actually has.
  const cols = Math.max(1, Math.min(widest, rows > 1 ? Math.ceil(n / rows) : widest));
  // Share the spare width out evenly: cols * cellW + gaps fills `inner`, so the
  // grid's right edge meets the box's right edge at every terminal size.
  const cellW = Math.max(1, Math.min(inner, Math.floor((inner - (cols - 1) * GAP) / cols)));
  const capacity = cols * rowCap;
  return { inner, cols, cellW, capacity, rows };
}

/** Rows the panel occupies at `width` for `count` services, for the row budget:
 *  border 2 + status line 1 + the meters line (when shown) + the cell rows. */
export function statusServicesRows(width, count, dense = true, showMeters = true) {
  const { rows } = gridShape(width, count);
  return 3 + (showMeters ? 1 : 0) + Math.max(1, rows) * (dense ? 1 : 2);
}
