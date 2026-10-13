import React from 'react';
import MessageBlock from './MessageBlock.jsx';
import { estimateRows, fitTranscript } from '../utils/transcript-rows.js';

/* Transcript — the scrolling window of turns, newest at the bottom.
 *
 * OpenTUI renders a full-screen tree and has no scroll container we use here,
 * so "scrolling" is really "decide which turns are on screen". The arithmetic
 * for that lives in utils/transcript-rows.js so it can be asserted without
 * mounting a tree; this component only decides how the result reads.
 *
 * Bottom alignment is deliberate: an almost-empty transcript pads from the top
 * so the newest turn sits against the composer instead of floating in the
 * middle of a half-blank screen.
 */
export default function Transcript({ messages = [], width, height, emptyHint }) {
  const list = Array.isArray(messages) ? messages : [];

  if (list.length === 0) {
    return (
      <box style={{ width, flexDirection: 'column' }}>
        <text fg="gray">{emptyHint || 'Ask for something and the agent runs it.'}</text>
      </box>
    );
  }

  const budget = Math.max(1, Number(height) || 20);
  const { visible, hidden, used } = fitTranscript(list, width, budget);
  const pad = Math.max(0, budget - used);

  return (
    <box style={{ width, flexDirection: 'column', height: budget }}>
      {hidden > 0 ? (
        <text fg="gray">{`… ${hidden} earlier turn${hidden === 1 ? '' : 's'}`}</text>
      ) : null}
      <box style={{ flexDirection: 'column', marginTop: pad }}>
        {visible.map((message) => (
          <box key={message.id} style={{ marginBottom: 1 }}>
            <MessageBlock message={message} width={width} />
          </box>
        ))}
      </box>
    </box>
  );
}

export { estimateRows };