import React from 'react';
import { TextAttributes } from '@opentui/core';
import ScrollPanel from './ScrollPanel.jsx';
import { META } from '../../../src/prefs.js';

/* SettingsView — the full settings page, the terminal's answer to Claude CLI's
 * `/config`. Owner, 2026-11-24: "fix our popout /menu for all our cli settings
 * mcps etc like claude cli has".
 *
 * One row per key in ~/.hakster/cli-prefs.json, in the file's own order, with
 * its live value and what it does. Nothing is invented: a row exists because
 * prefs.js lists the key, and its value comes from the same load() the rest of
 * the CLI reads.
 *
 *   ↑/↓     move
 *   enter   change — a switch flips, a number steps through its sensible
 *           values, `model` opens the model picker, other text says how
 *   r       reset the selected key to its default
 *   esc     back to the chat
 *
 * The panel scrolls with the house gutter when the screen is short.
 */
const clip = (s, n) => {
  const t = String(s == null ? '' : s);
  return t.length <= n ? t : `${t.slice(0, Math.max(0, n - 1))}…`;
};

export const showValue = (v) => {
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  if (typeof v === 'number') return String(v);
  return v === '' ? '(default)' : String(v);
};

const valueColor = (v) => (typeof v === 'boolean' ? (v ? 'green' : 'gray') : typeof v === 'number' ? 'yellow' : 'cyan');

export default function SettingsView({
  width = 72,
  rows = 16,
  list = [],
  selected = 0,
}) {
  const w = Math.max(24, Number(width) || 72);
  const contentRows = Math.max(3, Number(rows) || 16);
  const keyW = Math.min(14, Math.max(8, ...list.map((r) => String(r.key).length)));
  const changed = list.filter((r) => String(r.value) !== String(r.default)).length;

  return (
    <ScrollPanel
      width={w}
      title={`⚙ Settings${changed ? ` · ${changed} changed` : ''}`}
      hint="↑↓ select · enter change · r reset · esc back"
      total={list.length}
      rows={contentRows}
      selected={Math.min(selected, Math.max(0, list.length - 1))}
      initial="top"
      empty="no settings — prefs.js lists none"
      compactWhen={w < 70}
    >
      {(index, { width: rowW, compact }) => {
        const row = list[index];
        if (!row) return null;
        const active = index === selected;
        const meta = META[row.key] || {};
        const isChanged = String(row.value) !== String(row.default);
        const value = showValue(row.value);
        const valueW = Math.min(12, Math.max(3, value.length));
        const detailW = Math.max(0, rowW - keyW - valueW - 6);
        return (
          <box style={{ width: rowW, flexDirection: 'row', flexShrink: 0 }}>
            <text fg={active ? 'yellow' : 'gray'} attributes={active ? TextAttributes.BOLD : 0}>
              {`${active ? '▸ ' : '  '}${clip(String(row.key).padEnd(keyW), keyW)}`}
            </text>
            <text fg={active ? 'yellow' : valueColor(row.value)} attributes={isChanged ? TextAttributes.BOLD : 0}>
              {` ${clip(value, valueW).padEnd(valueW)}`}
            </text>
            <text fg={isChanged ? 'yellow' : 'gray'}>{isChanged ? '*' : ' '}</text>
            {!compact && detailW > 3 ? (
              <text fg="gray">{` ${clip(meta.detail || meta.label || '', detailW - 1)}`}</text>
            ) : null}
          </box>
        );
      }}
    </ScrollPanel>
  );
}
