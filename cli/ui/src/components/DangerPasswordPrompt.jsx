import React, { useState } from 'react';
import { useKeyboard } from '@opentui/react';
import { TextAttributes } from '@opentui/core';
import HeroLogo from './HeroLogo.jsx';

/* DangerPasswordPrompt — set the approval password without leaving the TUI.
 *
 * Owner, 2026-11-25: "make sure the dangerous commands prompt popout win works
 * for my password etc". The gate could only ever ask for a password that had
 * been set with `hakster config sudo` from a shell, so in practice it never
 * asked at all. `/danger set` opens this panel: the owner types the password
 * masked — twice, so a typo is caught here rather than locking him out of the
 * gate — and it is written to ~/.hakster/config.json (mode 600) by the CLI
 * process, exactly where the text CLI and the server already look for it.
 *
 * The value never leaves this component except into that file: no echo, no
 * notice text, no log, no argv (§9, §23). The panel reports its length only
 * while typing, which is how the owner knows a keystroke landed.
 */
export default function DangerPasswordPrompt({ width = 60, onSave, onCancel }) {
  const [first, setFirst] = useState('');
  const [value, setValue] = useState('');
  const [mismatch, setMismatch] = useState(false);
  const w = Math.max(24, Number(width) || 60);
  const inner = Math.max(8, w - 4);
  const confirming = first !== '';

  useKeyboard((key) => {
    if (key.ctrl && key.name === 'c') return; // App owns Ctrl+C
    const name = key.name ? String(key.name) : '';
    if (name === 'escape') { onCancel(); return; }
    if (name === 'return') {
      if (!confirming) {
        if (!value) return; // nothing typed yet — enter does nothing
        setFirst(value);
        setValue('');
        return;
      }
      if (value === first) { onSave(value); return; }
      // A mismatch is the one failure worth retyping both for: saving a value
      // the owner did not mean would lock the gate, not open it.
      setFirst('');
      setValue('');
      setMismatch(true);
      return;
    }
    if (name === 'backspace' || name === 'delete') {
      if (mismatch) setMismatch(false);
      setValue((v) => v.slice(0, -1));
      return;
    }
    if (name.length === 1) {
      if (mismatch) setMismatch(false);
      setValue((v) => v + name);
    }
  });

  return (
    <box
      style={{
        width: w,
        flexDirection: 'column',
        border: true,
        borderStyle: 'rounded',
        borderColor: 'yellow',
        paddingLeft: 1,
        paddingRight: 1,
        flexShrink: 0,
      }}
    >
      <HeroLogo width={inner} subtitle="approval password" />
      <text fg="gray">{'Dangerous and sudo commands will ask for this password in the approval window.'}</text>
      <box style={{ width: inner, flexDirection: 'row' }}>
        <text fg="yellow" attributes={TextAttributes.BOLD}>{confirming ? 'again    ' : 'password '}</text>
        <text fg={value ? 'white' : 'gray'}>
          {value ? '*'.repeat(value.length) : (confirming ? 'type it again' : 'typed hidden')}
        </text>
        {value ? <text fg="gray">{`  ${value.length} chars`}</text> : null}
      </box>
      {mismatch ? (
        <text fg="red">{'they did not match — nothing saved, start again'}</text>
      ) : null}
      <text fg="gray">
        {confirming
          ? 'enter saves · esc cancels · stored in ~/.hakster/config.json (mode 600)'
          : 'enter continues · esc cancels · typed hidden, never echoed'}
      </text>
    </box>
  );
}
