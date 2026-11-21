import React from 'react';
import { TextAttributes } from '@opentui/core';

/* MessageBlock — one turn in the transcript, drawn as its own bordered box.
 *
 * Freebuff's transcript is a tree of block renderers; this harness only needs
 * three roles, so one component branches instead of many. What is worth
 * keeping from upstream is the shape of the information: reasoning is shown
 * separately from the answer and dimmed, and each tool call is a row of its own
 * with its result underneath — never merged into the prose, because a merged
 * block is what makes a transcript impossible to skim.
 *
 * The border colour is the only thing that distinguishes roles, which keeps a
 * long scrollback readable at a glance without spending rows on headers.
 */

const ROLE_STYLE = {
  user: { border: 'cyan', label: 'you' },
  assistant: { border: 'gray', label: 'hakster' },
  system: { border: 'yellow', label: 'system' },
};

const TONE_COLOR = { error: 'red', warn: 'yellow', notice: 'cyan' };

/** A tool call is still running until its result arrives. */
function ToolRow({ tool, width }) {
  const pending = tool.result === null;
  const glyph = pending ? '…' : '✓';
  const colour = pending ? 'yellow' : 'green';
  const args = tool.args && Object.keys(tool.args).length
    ? ` ${JSON.stringify(tool.args).slice(0, 60)}`
    : '';

  return (
    <box style={{ flexDirection: 'column', width }}>
      <text>
        <span fg={colour}>{glyph} </span>
        <span fg="white">{tool.name || 'tool'}</span>
        {args ? <span fg="gray">{args}</span> : null}
      </text>
      {tool.result != null ? (
        <text fg="gray">{`  ${String(tool.result).slice(0, 120)}`}</text>
      ) : null}
    </box>
  );
}

export default function MessageBlock({ message, width }) {
  if (!message) return null;

  const roleStyle = ROLE_STYLE[message.role] || ROLE_STYLE.system;
  const border =
    message.role === 'system' && message.tone
      ? TONE_COLOR[message.tone] || roleStyle.border
      : roleStyle.border;

  const inner = Math.max(8, (width || 80) - 4); // borders + horizontal padding

  // The system role carries harness notices, not user prose, so it gets a
  // single-line treatment with no label header to spend a row on.
  if (message.role === 'system') {
    return (
      <box style={{ width, border: true, borderStyle: 'rounded', borderColor: border, paddingLeft: 1, paddingRight: 1 }}>
        <text fg={border}>{String(message.text || '')}</text>
      </box>
    );
  }

  const tools = Array.isArray(message.tools) ? message.tools : [];

  return (
    <box style={{ width, flexDirection: 'column', border: true, borderStyle: 'rounded', borderColor: border, paddingLeft: 1, paddingRight: 1 }}>
      <text fg={border} attributes={TextAttributes.BOLD}>{roleStyle.label}</text>
      {message.thinking ? (
        <text fg="gray">{String(message.thinking)}</text>
      ) : null}
      {message.text ? (
        <text fg="white">{String(message.text)}</text>
      ) : !message.thinking && tools.length === 0 ? (
        <text fg="gray">thinking…</text>
      ) : null}
      {tools.map((tool, i) => (
        <ToolRow key={`tool-${i}`} tool={tool} width={inner} />
      ))}
    </box>
  );
}

export { ToolRow };