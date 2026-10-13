import React from 'react';
import { TextAttributes } from '@opentui/core';

/* TodoPanel — the agent's checklist, drawn outside the transcript.
 *
 * Freebuff derives this from the message list and renders it in a scrollbox;
 * here the caller passes the todos in, so the panel stays a pure function of
 * its props and can be rendered in a test. The clipping is not cosmetic: the
 * terminal grid is the contract, and a long todo that is allowed to overflow
 * pushes the box's own border off the right edge, which looks like a crash.
 *
 * PORTED FROM: CodebuffAI/freebuff `cli/src/components/todo-panel.tsx`
 * (Apache-2.0). See cli/src/ads/ATTRIBUTION.md for how this repo handles
 * derived files. Changes: rendered with OpenTUI (<box>/<text>/TextAttributes),
 * the theme and ClickableTitleBox dropped, and the visible-row cap applied by
 * slicing rather than by scrolling — a transcript already scrolls, so a
 * second scroll container inside it would fight the first for the arrow keys.
 */
const GLYPH_DONE = '✓';
const GLYPH_TODO = '○';
const EMPTY_TEXT = "No todos yet — the agent's checklist appears here once it creates one.";

/** Clip to `n` columns, ellipsizing rather than overflowing. */
function clip(text, n) {
  const t = String(text == null ? '' : text);
  if (n <= 0) return '';
  return t.length <= n ? t : t.slice(0, Math.max(0, n - 1)) + '…';
}

export default function TodoPanel({ todos = [], width, hint, maxVisibleRows = 8 }) {
  const list = Array.isArray(todos) ? todos : [];
  const completed = list.filter((t) => t && t.done).length;
  const inner = Math.max(0, (width || 80) - 4); // borders + horizontal padding
  const visible = list.slice(0, Math.max(0, maxVisibleRows));
  const overflow = list.length - visible.length;

  const rows = [];
  if (list.length === 0) {
    rows.push(
      <text key="empty" fg="gray">
        {clip(EMPTY_TEXT, inner)}
      </text>,
    );
  } else {
    visible.forEach((todo, i) => {
      const done = !!(todo && todo.done);
      const text = clip((todo && todo.text) || '', Math.max(0, inner - 2));
      rows.push(
        <box key={`row-${i}`} style={{ width: '100%', flexDirection: 'row' }}>
          <text fg={done ? 'green' : 'gray'} attributes={done ? 0 : TextAttributes.DIM}>
            {done ? GLYPH_DONE : GLYPH_TODO}
          </text>
          <text fg={done ? 'white' : 'gray'}>{` ${text}`}</text>
        </box>,
      );
    });
    if (overflow > 0) {
      rows.push(
        <text key="more" fg="gray">
          {`+${overflow} more`}
        </text>,
      );
    }
  }

  return (
    <box style={{ width, flexDirection: 'column', border: true, borderStyle: 'rounded', borderColor: 'gray', paddingLeft: 1, paddingRight: 1 }}>
      <text fg="cyan" attributes={TextAttributes.BOLD}>{`Todos — ${completed}/${list.length} completed`}</text>
      {rows}
      {hint ? <text fg="gray">{hint}</text> : null}
    </box>
  );
}