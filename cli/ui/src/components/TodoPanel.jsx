import React from 'react';
import { TextAttributes } from '@opentui/core';
import ScrollPanel from './ScrollPanel.jsx';
import { clip } from './LiveSidebar.jsx';

/* TodoPanel — the agent's checklist, drawn outside the transcript.
 *
 * Freebuff derives this from the message list and renders it in a scrollbox;
 * here the caller passes the todos in, so the panel stays a pure function of
 * its props and can be rendered in a test.
 *
 * The owner's 2026-11-23 rule ("all the panels have autoscroll and bars with
 * arrows and auto compact") applies here too: the checklist is a fixed-height
 * window that follows the newest item while the agent works, carries the
 * house ▲/▼ + █ scrollbar when it overflows, and drops to a one-line compact
 * form when the terminal is narrow. A long todo can never push the panel's
 * border off the right edge, which is what used to look like a crash.
 *
 * PORTED FROM: CodebuffAI/freebuff `cli/src/components/todo-panel.tsx`
 * (Apache-2.0). See cli/src/ads/ATTRIBUTION.md for how this repo handles
 * derived files. Changes: rendered with OpenTUI (<box>/<text>/TextAttributes),
 * the theme and ClickableTitleBox dropped, and the old slice-with-"+N more"
 * replaced by the shared ScrollPanel window so overflow is scrollable rather
 * than silently truncated.
 */
const GLYPH_DONE = '✓';
const GLYPH_TODO = '○';
const EMPTY_TEXT = "No todos yet — the agent's checklist appears here once it creates one.";

export default function TodoPanel({ todos = [], width, hint, maxVisibleRows = 8 }) {
  const list = Array.isArray(todos) ? todos : [];
  const completed = list.filter((t) => t && t.done).length;
  const title = width && width < 34
    ? `Todos ${completed}/${list.length}`
    : `Todos — ${completed}/${list.length} completed`;

  return (
    <ScrollPanel
      width={width}
      title={title}
      hint={hint}
      total={list.length}
      rows={Math.max(1, Math.min(Number(maxVisibleRows) || 1, Math.max(1, list.length)))}
      empty={EMPTY_TEXT}
      compactWhen={width != null && width < 46}
    >
      {(index, { width: bodyW, compact }) => {
        const todo = list[index] || {};
        const done = !!todo.done;
        const text = clip(todo.text || '', Math.max(1, bodyW - 2));
        return (
          <box style={{ width: bodyW, flexDirection: 'row', flexShrink: 0 }}>
            <text fg={done ? 'green' : 'gray'} attributes={done || compact ? 0 : TextAttributes.DIM}>
              {done ? GLYPH_DONE : GLYPH_TODO}
            </text>
            <text fg={done ? 'white' : 'gray'}>{` ${text}`}</text>
          </box>
        );
      }}
    </ScrollPanel>
  );
}
