import React from 'react';
import { TextAttributes } from '@opentui/core';
import { clip } from './LiveSidebar.jsx';

/* A shell result is capped in the transcript. A 4 KB `npm run build` dump is
 * ~40 wrapped rows: at that size the turn's prose is shoved above the window
 * and the operator sees nothing but tool rows (owner, 2026-11-23: "its not
 * showing agents output what he says something only shell call tools i see").
 * The transcript shows the first few lines of each result; the whole tail
 * stays one panel lower in ▶ Output and in the sidebar.
 */
const RESULT_LINES = 3;

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

/** The newest non-empty line of a streamed field — what "keep up" means when
 *  a turn is too dense to show the whole reasoning block. */
const lastLine = (s) => String(s || '').replace(/\r/g, '').split('\n').filter((l) => l.trim()).pop() || '';

/** A tool call is still running until its result arrives. In a compact turn
 *  the result is one clipped line instead of the full output. */
function ToolRow({ tool, width, compact = false }) {
  const pending = tool.result === null;
  const glyph = pending ? '…' : '✓';
  const colour = pending ? 'yellow' : 'green';
  const name = tool.name || 'tool';
  const args = tool.args && Object.keys(tool.args).length
    ? ` ${JSON.stringify(tool.args)}`
    : '';
  const nameW = name.length + 2; // glyph + space
  const head = `${args}`;
  const shown = tool.result == null
    ? null
    : String(tool.result).replace(/\r/g, '').split('\n');
  const limit = compact ? 1 : RESULT_LINES;
  const lines = shown ? shown.slice(0, limit) : [];
  const hidden = shown ? Math.max(0, shown.length - lines.length) : 0;

  return (
    <box style={{ flexDirection: 'column', width, flexShrink: 0 }}>
      <text>
        <span fg={colour}>{glyph} </span>
        <span fg="white">{name}</span>
        {args ? <span fg="gray">{clip(head, Math.max(4, width - nameW))}</span> : null}
      </text>
      {/* One row per line, each clipped to the column: an unclipped 300-char
          build line used to wrap into three rows, so a handful of calls could
          fill the whole transcript. */}
      {lines.map((line, i) => (
        <text key={`r-${i}`} fg="gray">{clip(line.trim() || ' ', Math.max(4, width - 1))}</text>
      ))}
      {hidden > 0 ? (
        <text fg="gray">{`… +${hidden} more line${hidden === 1 ? '' : 's'} · ▶ Result`}</text>
      ) : null}
    </box>
  );
}

export default function MessageBlock({ message, width, compact = false }) {
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
      <box style={{ width, flexShrink: 0, border: true, borderStyle: 'rounded', borderColor: border, paddingLeft: 1, paddingRight: 1 }}>
        <text fg={border}>{String(message.text || '')}</text>
      </box>
    );
  }

  const tools = Array.isArray(message.tools) ? message.tools : [];
  /* Chronological rounds (see withRound in useAgentStream): the model's prose,
   * then the calls it made, then its next prose. Drawing the flat `text` above
   * every tool row is what made a streaming turn read as shell calls only —
   * the newest sentence was never the newest row. */
  const rounds = (Array.isArray(message.rounds) ? message.rounds : []).filter(
    (r) => r && ((r.text && String(r.text).trim()) || (r.thinking && String(r.thinking).trim()) || (Array.isArray(r.tools) && r.tools.length)),
  );

  return (
    <box style={{ width, flexShrink: 0, flexDirection: 'column', border: true, borderStyle: 'rounded', borderColor: border, paddingLeft: 1, paddingRight: 1 }}>
      {/* Auto-compact drops the label row: the border colour still says whose
          turn it is (cyan = you, gray = hakster, yellow = system). */}
      {compact ? null : (
        <text fg={border} attributes={TextAttributes.BOLD}>{roleStyle.label}</text>
      )}
      {message.images ? (
        <text fg="gray">{`📎 ${message.imageName || `${message.images} image`}`}</text>
      ) : null}
      {rounds.length ? (
        rounds.map((round, i) => (
          <box key={`round-${i}`} style={{ flexDirection: 'column', width: inner, flexShrink: 0 }}>
            {round.thinking && String(round.thinking).trim() ? (
              // A reasoning model doing tool rounds may spend most of a turn
              // thinking; dropping the line entirely in a dense turn is why
              // the transcript read as tool rows only. Compact keeps the newest
              // line of the round's reasoning.
              compact
                ? <text fg="gray">{clip(`⋯ ${lastLine(round.thinking)}`, Math.max(4, inner))}</text>
                : <text fg="gray">{String(round.thinking)}</text>
            ) : null}
            {round.text && String(round.text).trim() ? (
              <text fg="white">{String(round.text)}</text>
            ) : null}
            {(Array.isArray(round.tools) ? round.tools : []).map((tool, j) => (
              <ToolRow key={`tool-${i}-${j}`} tool={tool} width={inner} compact={compact} />
            ))}
          </box>
        ))
      ) : (
        <>
          {message.thinking ? (
            compact
              ? <text fg="gray">{clip(`⋯ ${lastLine(message.thinking)}`, Math.max(4, inner))}</text>
              : <text fg="gray">{String(message.thinking)}</text>
          ) : null}
          {message.text ? (
            <text fg="white">{String(message.text)}</text>
          ) : !message.thinking && tools.length === 0 ? (
            <text fg="gray">thinking…</text>
          ) : null}
          {tools.map((tool, i) => (
            <ToolRow key={`tool-${i}`} tool={tool} width={inner} compact={compact} />
          ))}
        </>
      )}
    </box>
  );
}

export { ToolRow };