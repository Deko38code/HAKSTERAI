import React, { useEffect, useRef } from 'react';
import { TextAttributes } from '@opentui/core';
import { usePaste } from '@opentui/react';
import { visualRows } from '../utils/wrap.js';
import { pasteText } from '../utils/paste.js';

/* Composer — where the operator types, and where the inline ad lives.
 *
 * The draft is owned by the caller rather than by this component. That is not
 * ceremony: submitting has to clear the field, an aborted run has to be able to
 * restore it, and a slash command may rewrite it, and all three are decisions
 * the parent is already making. A self-owned draft would need an imperative
 * handle to do any of them.
 *
 * When the composer is not focused it still renders the draft, so looking away
 * from the input never hides what you were writing.
 *
 * Owner, 2026-11-25: "when i type needs to know when to go to new line not go
 * off the screen in input bar". The editing surface is a <textarea> now: it
 * word-wraps the draft instead of scrolling it off the right edge, grows by the
 * wrapped rows (capped — past the cap it scrolls internally), and keeps the
 * selection/undo/cursor behaviour of a real editor. Enter still sends, and
 * Shift+Enter is the explicit newline.
 *
 * Owner, 2026-11-25: "fix the copy & paste don't work" — textarea renders its
 * own paste, but its built-in handler strips every newline. The usePaste below
 * runs first (global handlers run before renderable ones) and inserts the text
 * as pasted, newlines and all; it calls preventDefault so the stripping handler
 * cannot run as well. Copy is handled in App: Ctrl+C with a selection copies it
 * to the terminal clipboard (OSC 52) instead of quitting.
 *
 * The ad slot is passed in as `adSlot` and drawn inside this box on purpose:
 * Freebuff's `CLI-Composer` placement sits with the input, and an input bar that
 * grows by one row when a creative arrives is far less disruptive than one that
 * pushes the transcript around.
 */
const clipHint = (s, n) => {
  const t = String(s == null ? '' : s);
  return t.length <= n ? t : `${t.slice(0, Math.max(0, n - 1))}…`;
};

/** Enter sends, everything that means "a line break" inserts one.
 *
 * Shift+Enter is the obvious pair, but most terminals send a plain Enter for it
 * unless they speak the kitty protocol, so Alt+Enter (which arrives as a real
 * ESC+CR from nearly every terminal) and Ctrl+J (linefeed) are bound to the
 * same action. Whatever the terminal can actually report, one of them breaks
 * the line instead of sending the draft.
 */
const KEY_BINDINGS = [
  { name: 'return', action: 'submit' },
  { name: 'kpenter', action: 'submit' },
  { name: 'return', shift: true, action: 'newline' },
  { name: 'kpenter', shift: true, action: 'newline' },
  { name: 'return', meta: true, action: 'newline' },
  { name: 'kpenter', meta: true, action: 'newline' },
  { name: 'linefeed', action: 'newline' },
];

/** Pasted bytes to text: ANSI stripped, CRLF normalised — see utils/paste.js. */

export default function Composer({
  width,
  value = '',
  onChange,
  onSubmit,
  focused = true,
  disabled = false,
  placeholder = 'describe a task…',
  hint,
  adSlot,
  focusTag = 'composer',
  maxInputRows = 6,
}) {
  const inner = Math.max(8, (width || 80) - 4);
  const inputWidth = Math.max(1, inner - 2);
  const inputRows = visualRows(value, inputWidth, maxInputRows);
  const ref = useRef(null);
  // The textarea is uncontrolled (it owns its buffer); the caller still owns the
  // value. When the caller changes it under us — submit clears, ↑ recalls
  // history, a slash command rewrites — push the difference in with the caret at
  // the end, and skip it while they are the same string so typing never fights
  // the sync.
  useEffect(() => {
    const el = ref.current;
    if (!el || disabled) return;
    if (el.plainText === String(value ?? '')) return;
    el.setText(String(value ?? ''));
    el.cursorOffset = String(value ?? '').length;
  }, [value, disabled]);

  usePaste((event) => {
    if (!focused || disabled) return;
    const text = pasteText(event);
    if (!text) return;
    // Handled here, not by the textarea's own handler (which drops newlines).
    if (typeof event?.preventDefault === 'function') event.preventDefault();
    const el = ref.current;
    if (el) {
      el.insertText(text);
      if (typeof onChange === 'function') onChange(el.plainText);
    } else if (typeof onChange === 'function') {
      onChange(`${value || ''}${text}`);
    }
  });

  return (
    <box
      style={{
        width,
        flexDirection: 'column',
        flexShrink: 0,
        border: true,
        borderStyle: 'rounded',
        borderColor: focused ? 'cyan' : 'gray',
        paddingLeft: 1,
        paddingRight: 1,
      }}
    >
      <box style={{ width: inner, flexDirection: 'row' }}>
        <text fg={disabled ? 'gray' : 'cyan'} attributes={TextAttributes.BOLD}>
          {disabled ? '… ' : '› '}
        </text>
        {focused && !disabled ? (
          <textarea
            ref={ref}
            style={{ width: inputWidth, height: inputRows, flexGrow: 0, flexShrink: 0 }}
            initialValue={String(value ?? '')}
            placeholder={placeholder}
            wrapMode="word"
            focused={focused}
            keyBindings={KEY_BINDINGS}
            onContentChange={() => {
              const el = ref.current;
              if (el && typeof onChange === 'function') onChange(el.plainText);
            }}
            onSubmit={() => {
              const el = ref.current;
              const text = el ? el.plainText : String(value ?? '');
              if (typeof onSubmit === 'function') onSubmit(text);
            }}
          />
        ) : (
          <text fg="gray">{(value || (disabled ? 'working…' : placeholder)).split('\n')[0]}</text>
        )}
      </box>

      {adSlot}

      <box style={{ width: inner }}>
        {/* One row, always: the hint is clipped to the box so a long hint can
            never wrap and push the layout down by a line. */}
        {/* The focus tag used to live in the status bar under the input; the
            owner moved the auto-mode dial there (2026-11-25), so it sits here
            instead: same information, one row higher, and it can never push a
            panel because it shares the hint's single clipped row. */}
        <text>
          <span fg={focused ? 'cyan' : 'gray'}>{`⟪${focusTag}⟫ `}</span>
          <span fg="gray">{clipHint(hint || 'enter send · alt+enter newline · ctrl+c copies', Math.max(4, inner - focusTag.length - 4))}</span>
        </text>
      </box>
    </box>
  );
}
