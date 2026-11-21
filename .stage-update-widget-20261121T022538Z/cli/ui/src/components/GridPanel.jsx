import React from 'react';
import { TextAttributes } from '@opentui/core';

/* GridPanel — a bordered box holding a label/value grid.
 *
 * The house style for this TUI: every panel is a rounded box with a title in
 * the top border, and its contents are laid out in equal-width cells. Keeping
 * one component for it means the whole dashboard lines up without each caller
 * re-deriving column widths from the terminal size.
 *
 * `cols` is honoured by wrapping the cells into rows of that many, so a wide
 * terminal gets more across rather than longer rows.
 */
export function GridPanel({ title, cols = 4, width, children, borderColor = 'gray', hint }) {
  // A bordered box with one cell of padding on each side leaves width - 4
  // cells for its contents. Keep both the heading and the wrapped cell row
  // inside that exact width so terminal borders cannot drift on the right.
  const inner = Math.max(1, (width || 80) - 4);
  const titleText = String(title || '');
  const hintText = String(hint || '');
  const hintWidth = Math.max(0, inner - titleText.length - 1);
  const clippedHint = hintText.length <= hintWidth
    ? hintText
    : hintWidth > 1 ? `${hintText.slice(0, hintWidth - 1)}…` : '';
  return (
    <box style={{ width, flexDirection: 'column', border: true, borderStyle: 'rounded', borderColor, paddingLeft: 1, paddingRight: 1 }}>
      <box style={{ width: inner, justifyContent: 'space-between' }}>
        <text fg="cyan" attributes={TextAttributes.BOLD}>{titleText.slice(0, inner)}</text>
        {clippedHint ? <text fg="gray">{clippedHint}</text> : null}
      </box>
      <box style={{ width: inner, flexWrap: 'wrap' }}>{children}</box>
    </box>
  );
}

/** One cell of a GridPanel: a label above a value, both clipped to `w`. */
export function Cell({ label, value, w = 18, color = 'white' }) {
  const clip = (s, n) => {
    const t = String(s == null ? '—' : s);
    return t.length <= n ? t : t.slice(0, Math.max(0, n - 1)) + '…';
  };
  return (
    <box style={{ width: Math.max(1, w), flexDirection: 'column', flexShrink: 0, marginRight: 1 }}>
      <text fg="gray">{clip(label, w)}</text>
      <text fg={color} attributes={TextAttributes.BOLD}>{clip(value, w)}</text>
    </box>
  );
}

/** A horizontal bar, used for CPU/mem/token style readings. */
export function Meter({ value, max = 100, w = 16, color = 'green' }) {
  const pct = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  const filled = Math.round(pct * w);
  return (
    <text>
      <span fg={color}>{'█'.repeat(filled)}</span>
      <span fg="gray">{'░'.repeat(Math.max(0, w - filled))}</span>
      <span fg="gray">{` ${String(Math.round(pct * 100)).padStart(3)}%`}</span>
    </text>
  );
}

/** A rolling sparkline for a series of samples. */
export function Spark({ data = [], w = 24 }) {
  const blocks = '▁▂▃▄▅▆▇█';
  if (!data.length) return <text fg="gray">{'▁'.repeat(w)}</text>;
  const window = data.slice(-w);
  const max = Math.max(...window, 1);
  const min = Math.min(...window, 0);
  const span = max - min || 1;
  return (
    <text fg="cyan">
      {window.map((v, i) => {
        const idx = Math.round(((v - min) / span) * (blocks.length - 1));
        return blocks[Math.max(0, Math.min(blocks.length - 1, idx))];
      }).join('')}
    </text>
  );
}

export default GridPanel;
