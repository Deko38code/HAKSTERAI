import React from 'react';
import { TextAttributes } from '@opentui/core';

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
 * The ad slot is passed in as `adSlot` and drawn inside this box on purpose:
 * Freebuff's `CLI-Composer` placement sits with the input, and an input bar that
 * grows by one row when a creative arrives is far less disruptive than one that
 * pushes the transcript around.
 */
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
}) {
  const inner = Math.max(8, (width || 80) - 4);

  return (
    <box
      style={{
        width,
        flexDirection: 'column',
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
          <input
            value={value}
            placeholder={disabled ? 'working…' : placeholder}
            onInput={onChange}
            onSubmit={(text) => {
              if (typeof onSubmit === 'function') onSubmit(text);
            }}
            focused={true}
          />
        ) : (
          <text fg="gray">{value || (disabled ? 'working…' : placeholder)}</text>
        )}
      </box>

      {adSlot}

      <box style={{ width: inner }}>
        <text fg="gray">{hint || 'enter send · esc stop · tab focus · ctrl+c quit'}</text>
      </box>
    </box>
  );
}