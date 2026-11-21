import { useMemo } from 'react';
import { computeSmartColumns, MIN_COLUMN_WIDTH } from '../utils/layout-helpers.js';

/* Responsive grid geometry for the terminal.
 *
 * The terminal has no CSS, so the breakpoints have to be explicit character
 * counts rather than media queries. Putting them in one memoised hook means a
 * panel that fills the width and a panel that sizes itself to a column both
 * read the same number, which is what stops the dashboard from shearing when
 * the window is resized or when a panel is added mid-render.
 *
 * PORTED FROM: CodebuffAI/freebuff `cli/src/hooks/use-grid-layout.ts`
 * (Apache-2.0 — Copyright 2025 Freebuff, Inc.; see that repository's LICENSE
 * and NOTICE). Changes: TypeScript -> ESM JavaScript, and the generics dropped
 * because this is plain JS.
 *
 * Thresholds (character columns, not pixels):
 * - Below 100 cols: 1 column  (narrow terminal)
 * - 100-149 cols:   up to 2   (medium terminal)
 * - 150-199 cols:   up to 3   (large terminal)
 * - 200+ cols:      up to 4   (extra large terminal)
 */
export const WIDTH_MD_THRESHOLD = 100;
export const WIDTH_LG_THRESHOLD = 150;
export const WIDTH_XL_THRESHOLD = 200;

/** Ordered thresholds for determining max columns based on terminal width. */
const WIDTH_THRESHOLDS = [WIDTH_MD_THRESHOLD, WIDTH_LG_THRESHOLD, WIDTH_XL_THRESHOLD];

/** Gap between columns in the multi-column layout. */
const COLUMN_GAP = 1;

/**
 * Resolve `items` into a column count, a per-column width and the grouped items.
 *
 * The grouping is round-robin (`idx % columns`) rather than contiguous slices,
 * which is what keeps reading order top-to-bottom down each column.
 */
export function computeGridLayout(items, availableWidth) {
  // Force a single column for very narrow terminals, where two columns would
  // each be narrower than MIN_COLUMN_WIDTH.
  const minWidthForTwoColumns = MIN_COLUMN_WIDTH * 2 + COLUMN_GAP;
  if (availableWidth < minWidthForTwoColumns) {
    return {
      columns: 1,
      columnWidth: Math.max(1, availableWidth),
      columnGroups: [items],
    };
  }

  // Determine max columns from the width thresholds.
  const maxColumns = WIDTH_THRESHOLDS.filter((t) => availableWidth >= t).length + 1;

  const columns = computeSmartColumns(items.length, maxColumns);

  let columnWidth;
  if (columns === 1) {
    columnWidth = availableWidth;
  } else {
    const totalGap = columns - 1;
    const rawWidth = Math.floor((availableWidth - totalGap) / columns);
    columnWidth = Math.max(MIN_COLUMN_WIDTH, rawWidth);
  }

  const columnGroups = Array.from({ length: columns }, () => []);
  items.forEach((item, idx) => {
    columnGroups[idx % columns].push(item);
  });

  return { columns, columnWidth, columnGroups };
}

/** Memoised {@link computeGridLayout}, keyed on the items array and the width. */
export function useGridLayout(items, availableWidth) {
  return useMemo(
    () => computeGridLayout(items, availableWidth),
    [items, availableWidth],
  );
}
