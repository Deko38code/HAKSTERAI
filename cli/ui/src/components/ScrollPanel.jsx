import React from 'react';
import { Panel, ScrollRow, clip } from './LiveSidebar.jsx';
import { overflows } from '../utils/panel-scroll.js';
import { usePanelScroll } from '../hooks/usePanelScroll.js';

/* ScrollPanel — the house shell for a fixed-height, scrolling panel.
 *
 * Every small panel (todos, activity, output, MCP list, the models list, the
 * monitor's feed) renders through this so they cannot drift apart:
 *
 *   - exactly `rows` content rows, padded when the list is shorter, so a panel
 *     can never push the status bar off the screen;
 *   - one scrollbar column with ▲ / ▼ ends and a █ thumb whenever the content
 *     overflows (`gutterChar`), hidden when it fits;
 *   - auto-follow: the window sits on the newest rows while data streams, and
 *     a caller-supplied binding set pages it back;
 *   - auto-compact: the child is told `compact` when the body is narrow or the
 *     window short, and the caller can pass `compactWhen` for a panel-specific
 *     rule (the owner's "auto compact like this cli").
 *
 * `children(index, { width, compact, selected })` returns one row of content.
 * Returning null leaves a blank padded row.
 */
export function ScrollPanel({
  width = 40,
  title = '',
  hint = '',
  total = 0,
  rows = 0,
  bindings = null,
  initial = 'follow',
  selected = null,
  empty = '—',
  busy = false,
  compactWhen = null,
  borderColor = 'gray',
  children,
}) {
  const w = Math.max(12, Number(width) || 40);
  const r = Math.max(0, Math.trunc(Number(rows) || 0));
  const n = Math.max(0, Math.trunc(Number(total) || 0));
  const inner = Math.max(1, w - 4);
  const state = usePanelScroll({
    total: n,
    rows: r,
    bindings,
    enabled: r > 0,
    initial,
    selected,
  });
  const gutterOn = selected == null && r > 0 && overflows(n, r);
  const bodyW = Math.max(1, inner - (gutterOn ? 1 : 0));
  const compact = compactWhen == null ? bodyW < 24 || r < 5 : !!compactWhen;

  const titleHint = n === 0
    ? (busy ? 'waiting' : hint)
    : overflows(n, r)
      ? state.hint(hint)
      : hint || String(n);

  return (
    <Panel width={w} title={title} hint={titleHint} borderColor={borderColor}>
      {n === 0 || r === 0 ? (
        <box style={{ width: inner }}>
          <text fg="gray">{clip(busy ? 'waiting…' : empty, inner)}</text>
        </box>
      ) : (
        Array.from({ length: r }, (_, i) => {
          const index = state.start + i;
          const row = index < n ? children(index, { width: bodyW, compact, selected: index === selected }) : null;
          return (
            <ScrollRow key={`row-${i}`} width={inner} gutter={gutterOn ? state.gutter(i) : null}>
              {row == null ? (
                <box style={{ width: bodyW }}>
                  <text> </text>
                </box>
              ) : (
                row
              )}
            </ScrollRow>
          );
        })
      )}
    </Panel>
  );
}

export default ScrollPanel;
