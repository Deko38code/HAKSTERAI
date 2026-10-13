/* Layout maths shared by the grid container and anything that needs to agree
 * with it about how many columns exist.
 *
 * Kept out of the component on purpose: the column count is a plain function of
 * the item count and the terminal width, so a test can assert the 2x2-not-3+1
 * rule without mounting a React tree, and the initial render and the resize
 * path cannot disagree about the shape of the grid.
 *
 * PORTED FROM: CodebuffAI/freebuff `cli/src/utils/layout-helpers.ts`
 * (Apache-2.0 — Copyright 2025 Freebuff, Inc.; see that repository's LICENSE
 * and NOTICE). Changes: TypeScript -> ESM JavaScript. The two constants below
 * only matter to the agent-block renderer, but they are kept here so the module
 * stays a drop-in for its upstream counterpart.
 */

/** Minimum width (in characters) for a grid column. */
export const MIN_COLUMN_WIDTH = 10;

/** Maximum nesting depth for agent blocks. */
export const MAX_AGENT_DEPTH = 10;

/** Horizontal padding (in characters) inside agent content boxes. */
export const AGENT_CONTENT_HORIZONTAL_PADDING = 12;

/**
 * Compute the ideal number of columns for a grid layout.
 * Tries to create a balanced grid (e.g. 2x2 instead of 3x1 + 1) while respecting
 * maxColumns.
 */
export function computeSmartColumns(itemCount, maxColumns) {
  if (itemCount === 0) return 1;
  if (itemCount <= maxColumns) return itemCount;

  // If we can make a perfect grid with maxColumns, do it.
  if (itemCount % maxColumns === 0) return maxColumns;

  // Special case for 4 items on a 3-column screen: prefer 2x2 over 3+1.
  if (itemCount === 4 && maxColumns === 3) return 2;

  // Iterate down from maxColumns to find a divisor or better balance. We
  // prioritise using more columns (larger width) over perfect balance, unless
  // it is very egregious.
  for (let c = maxColumns; c >= 2; c--) {
    if (itemCount % c === 0) return c;
  }

  // Default to max columns if no nice divisor was found.
  return maxColumns;
}
