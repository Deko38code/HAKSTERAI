import React from 'react';
import { TextAttributes } from '@opentui/core';
import { gutterChar, overflows } from '../utils/panel-scroll.js';

/* CatalogPopout — the `/menu` popout, crush-style.
 *
 * The owner asked for "the popout function it uses to open it" with all of our
 * agents and catalogues in one place: "1 big catalog with all agents deepseek
 * crush catalog combined". So this is one list, opened by `/menu` (or ctrl+m)
 * from anywhere in the TUI, with:
 *
 *   - a filter line: type to narrow, backspace to widen, esc to close
 *   - sections: AGENTS (our ladder + the crush config on this machine),
 *     MODELS (the reference catalogue), MCP (the live server list with tool
 *     counts) and COMMANDS (every slash command the TUI implements)
 *   - ↑/↓ move, enter applies — a model row sets model+provider, an MCP row
 *     opens /mcp, a command row runs it.
 *
 * The panel is placed in the transcript area with the composer hidden while it
 * is open; OpenTUI has no absolute positioning, so this is the terminal's
 * honest equivalent of a floating popout: it owns the screen, and esc gives the
 * session back untouched. Nothing here invents data — every row is passed in.
 */
const clip = (s, n) => {
  const t = String(s == null ? '' : s);
  return t.length <= n ? t : `${t.slice(0, Math.max(0, n - 1))}…`;
};

const KIND_COLOR = {
  agent: 'magenta',
  model: 'cyan',
  mcp: 'blue',
  cmd: 'green',
};

export default function CatalogPopout({
  width = 72,
  height = 20,
  rows = [],
  selectable = [],
  selected = 0,
  query = '',
  filter = '',
}) {
  const w = Math.max(24, Number(width) || 72);
  const inner = Math.max(1, w - 4);
  const h = Math.max(6, Number(height) || 20);

  // Window the list around the selection so the popout never needs to scroll
  // the terminal itself. The box is exactly `h` rows: border 2 + title 1 +
  // filter 1 + list + footer 1, so the list gets h - 5. (It used to claim
  // h - 4, one row more than it drew, which pushed the row under it — the
  // composer slot — down the screen.)
  const bodyRows = Math.max(3, h - 5);
  const selRow = selectable[Math.min(selected, selectable.length - 1)] ?? 0;
  const start = Math.max(0, Math.min(selRow - Math.floor(bodyRows / 2), Math.max(0, rows.length - bodyRows)));
  const shown = rows.slice(start, start + bodyRows);
  const hiddenAbove = start;
  const hiddenBelow = Math.max(0, rows.length - start - shown.length);
  // The house scrollbar (▲ / █ / ▼) when the catalog is longer than the
  // window. It follows the selection, so the bar's thumb is the cursor.
  const gutterOn = overflows(rows.length, bodyRows);
  const bodyW = Math.max(8, inner - (gutterOn ? 1 : 0));
  // Auto-compact: a narrow popout drops the right-hand detail column and
  // spends every column on the label, instead of clipping both to nothing.
  const compact = bodyW < 40;

  return (
    <box style={{ width: w, flexDirection: 'column', border: true, borderStyle: 'rounded', borderColor: 'cyan', paddingLeft: 1, paddingRight: 1, flexShrink: 0 }}>
      <box style={{ width: inner, flexDirection: 'row', justifyContent: 'space-between' }}>
        <text fg="cyan" attributes={TextAttributes.BOLD}>◇ Catalog</text>
        <text fg="gray">{clip(hiddenAbove || hiddenBelow ? `${hiddenAbove}↑ ${hiddenBelow}↓ · ↑↓ · enter · esc` : '↑↓ select · enter apply · esc close', inner - 10)}</text>
      </box>
      <box style={{ width: inner, flexDirection: 'row' }}>
        <text fg="yellow">{'⌕ '}</text>
        <text fg="white">{clip(query, inner - 2)}</text>
      </box>
      <box style={{ width: inner, flexDirection: 'column' }}>
        {shown.length === 0 ? (
          <text fg="gray">{clip('no match — backspace to widen, esc to close', inner)}</text>
        ) : shown.map((row, i) => {
          const abs = start + i;
          // Every row is the same width: the content column, then the shared
          // ▲/█/▼ gutter when the catalog is longer than the window. That is
          // what keeps the list, the headers and the right border in one line
          // with the rest of the panels.
          const gutter = gutterOn ? gutterChar(i, bodyRows, rows.length, start) : null;
          if (row.kind === 'header') {
            return (
              <box key={`h:${row.label}`} style={{ width: inner, flexDirection: 'row', flexShrink: 0 }}>
                <text fg="gray" attributes={TextAttributes.BOLD}>{clip(`— ${row.label} —`, bodyW)}</text>
                {gutter ? <text fg="gray">{gutter}</text> : null}
              </box>
            );
          }
          const isSel = abs === selRow;
          const color = KIND_COLOR[row.kind] || 'white';
          const detail = compact ? '' : String(row.detail || '');
          const valueW = detail ? Math.min(detail.length, Math.max(0, Math.floor(bodyW / 2))) : 0;
          const labelW = Math.max(8, bodyW - (valueW ? valueW + 1 : 0));
          return (
            <box key={`${row.kind}:${row.label}`} style={{ width: inner, flexDirection: 'row', flexShrink: 0 }}>
              <text fg={isSel ? 'yellow' : color} attributes={isSel ? TextAttributes.BOLD : 0}>
                {clip(`${isSel ? '▸ ' : '  '}${row.label}`, labelW)}
              </text>
              {valueW ? <text fg={isSel ? 'white' : 'gray'}>{` ${clip(detail, valueW)}`}</text> : null}
              {gutter ? <text fg="gray">{gutter}</text> : null}
            </box>
          );
        })}
        {/* Pad the window to exactly `bodyRows` so the popout is the same
            height whether the filter matched three rows or thirty. */}
        {Array.from({ length: Math.max(0, bodyRows - Math.max(1, shown.length)) }, (_, i) => (
          <box key={`pad:${i}`} style={{ width: inner, flexShrink: 0 }}>
            <text> </text>
          </box>
        ))}
      </box>
      <box style={{ width: inner, flexDirection: 'row' }}>
        <text fg="gray">{clip(filter || 'type to filter · a model row switches this session · esc closes', inner)}</text>
      </box>
    </box>
  );
}
