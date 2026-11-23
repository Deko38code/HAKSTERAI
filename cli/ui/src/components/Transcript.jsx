import React from 'react';
import MessageBlock from './MessageBlock.jsx';
import { estimateRows } from '../utils/transcript-rows.js';

/* Transcript — the scrolling window of turns, newest at the bottom.
 *
 * Earlier this window fitted the newest turns that fit and dropped the rest,
 * which clipped the bottom of a long answer: the operator saw the start of a
 * turn and not what the agent was still saying. It is now a real scroll box
 * (OpenTUI's <scrollbox>) that follows the tail while a run streams and can be
 * paged back with PgUp/PgDn, so every line the agent produced is reachable.
 *
 * Bottom alignment is preserved for a short session: stickyStart 'bottom'
 * keeps the newest turn against the composer instead of floating it mid-screen.
 */
const MAX_TURNS = 80;

export default function Transcript({ messages = [], width, height, emptyHint, scrollRef }) {
  const list = Array.isArray(messages) ? messages : [];

  if (list.length === 0) {
    return (
      <box style={{ width, flexDirection: 'column' }}>
        <text fg="gray">{emptyHint || 'Ask for something and the agent runs it.'}</text>
      </box>
    );
  }

  const budget = Math.max(1, Number(height) || 20);
  const capped = list.slice(-MAX_TURNS);
  const hidden = list.length - capped.length;
  // Leave one column for the scroll bar so a long line never collides with it.
  const contentW = Math.max(8, (Number(width) || 80) - 1);

  return (
    <box style={{ width, height: budget, flexShrink: 0, overflow: 'hidden' }}>
      <scrollbox
        ref={scrollRef}
        style={{
          width,
          height: budget,
          stickyScroll: true,
          stickyStart: 'bottom',
          scrollY: true,
          scrollX: false,
          viewportCulling: true,
        }}
      >
        {hidden > 0 ? (
          <text fg="gray">{`… ${hidden} earlier turn${hidden === 1 ? '' : 's'} (PgUp)`}</text>
        ) : null}
        <box style={{ flexDirection: 'column', width: contentW }}>
          {capped.map((message) => (
            <box key={message.id} style={{ marginBottom: 1 }}>
              <MessageBlock message={message} width={contentW} />
            </box>
          ))}
        </box>
      </scrollbox>
    </box>
  );
}

export { estimateRows };
