import React from 'react';
import { useGridLayout } from '../hooks/useGridLayout.js';
import { MIN_COLUMN_WIDTH } from '../utils/layout-helpers.js';

/* GridLayout — lays a list of panels out across as many terminal columns as fit.
 *
 * The dashboard's panels are independent boxes, and the only thing they need
 * from a parent is to be told how wide they are. Doing that here (rather than
 * in each panel) means adding a panel re-flows the whole grid, and resizing the
 * terminal re-flows it without any panel keeping a stale width.
 *
 * `minWidth={MIN_COLUMN_WIDTH}` on each column is deliberate rather than a
 * decoration: without a floor, Yoga will happily collapse a column to zero
 * width for the frame or two between "wide enough for two columns" and "wide
 * enough for one", and the items inside it flash off-screen.
 *
 * PORTED FROM: CodebuffAI/freebuff `cli/src/components/grid-layout.tsx`
 * (Apache-2.0 — Copyright 2025 Freebuff, Inc.; see that repository's LICENSE
 * and NOTICE). Now rendered with OpenTUI `<box style={{...}}>` primitives,
 * matching the upstream source. TypeScript -> JSX, and React.memo dropped
 * (OpenTUI's reconciler does not need it and memo would hide a width change
 * behind an identity check).
 */
export function GridLayout({ items, availableWidth, getItemKey, renderItem, footer, marginTop = 0 }) {
  const { columns, columnWidth, columnGroups } = useGridLayout(items, availableWidth);

  if (items.length === 0) return null;

  // One structure for both single- and multi-column layouts, so a resize that
  // changes the column count reuses the same boxes instead of remounting them.
  const isMultiColumn = columns > 1;

  return (
    <box style={{ flexDirection: 'column', gap: isMultiColumn ? 1 : 0, width: availableWidth, marginTop }}>
      <box
        style={{
          flexDirection: 'row',
          gap: isMultiColumn ? 1 : 0,
          width: availableWidth,
          alignItems: 'flex-start',
        }}
      >
        {columnGroups.map((columnItems, colIdx) => {
          // Keying by the first item keeps a column stable across re-flows that
          // only reshuffle where the column boundaries land.
          const columnKey = columnItems[0] ? getItemKey(columnItems[0]) : `col-${colIdx}`;
          return (
            <box
              key={columnKey}
              style={{
                flexDirection: 'column',
                gap: 0,
                flexGrow: 1,
                flexShrink: 1,
                flexBasis: 0,
                minWidth: MIN_COLUMN_WIDTH,
              }}
            >
              {columnItems.map((item, idx) => (
                <box key={getItemKey(item)} style={{ width: columnWidth }}>
                  {renderItem(item, idx, columnWidth)}
                </box>
              ))}
            </box>
          );
        })}
      </box>
      {footer}
    </box>
  );
}

export default GridLayout;
