import React, { useEffect, useRef, useState } from 'react';
import { useKeyboard } from '@opentui/react';
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
 *
 * Owner's 2026-11-23 rule ("all the panels have autoscroll and bars with
 * arrows and auto compact"): the scroll box now carries OpenTUI's own
 * scrollbar with ▲/▼ ends (mouse-clickable, auto-hides when the transcript
 * fits), and the turns auto-compact when the window is short or narrow — the
 * role label and reasoning line are dropped and tool output is first-line only,
 * so a small terminal still reads as a transcript instead of two boxes.
 */
const MAX_TURNS = 80;

/** The native scrollbar: one column, arrow ends, a dim track and a bright
 *  thumb. `trackOptions` and `arrowOptions` are the ScrollBar primitive's own
 *  names — this is OpenTUI's bar, not a hand-drawn one. */
const SCROLLBAR_OPTIONS = {
  width: 1,
  showArrows: true,
  arrowOptions: {
    foregroundColor: '#9ca3af',
    arrowChars: { up: '▲', down: '▼' },
  },
  trackOptions: {
    backgroundColor: '#374151',
    foregroundColor: '#22d3ee',
  },
};

/** Every row drawn by one turn: prose, reasoning, and each tool's args and
 *  result — including rounds, which is where an agent's tool history lives. */
function turnWeight(message) {
  const textLen = (v) => String(v == null ? '' : v).length;
  const toolLen = (t) => textLen(t && t.result) + 4;
  let n = textLen(message.text) + textLen(message.thinking);
  for (const t of (Array.isArray(message.tools) ? message.tools : [])) n += toolLen(t);
  for (const r of (Array.isArray(message.rounds) ? message.rounds : [])) {
    n += textLen(r && r.text) + textLen(r && r.thinking);
    for (const t of (Array.isArray(r && r.tools) ? r.tools : [])) n += toolLen(t);
  }
  return n;
}

export default function Transcript({ messages = [], width, height, emptyHint, scrollRef, live = false, expandThinking = false, liveLabel = true }) {
  const list = Array.isArray(messages) ? messages : [];
  const budget = Math.max(1, Number(height) || 20);
  const boxRef = useRef(null);
  // `follow` is the operator's intent, not a guess from scrollTop: a run that
  // streams a row pushes the content down before the sticky logic can notice,
  // so "is it at the bottom?" is false exactly when we need it to be true.
  const [follow, setFollow] = useState(true);
  const capped = list.slice(-MAX_TURNS);
  const hidden = list.length - capped.length;
  // Signature of everything on screen, not just the newest turn: a tool result
  // can land in an earlier round, a compaction can rewrite rows above the tail,
  // and the window has to keep up with either. Built over the capped list so it
  // stays cheap on a long session.
  const listSig = `${capped.reduce((n, m) => n + turnWeight(m) + 7, 0)}:${capped.length}:${hidden}`;

  const setBox = (node) => {
    boxRef.current = node;
    if (!scrollRef) return;
    if (typeof scrollRef === 'function') scrollRef(node);
    else scrollRef.current = node;
  };

  // Follow the tail while the run streams: after every content change, put the
  // window on the last row. Without this the transcript drew the TOP of an
  // overflowing turn — the operator saw the start of the reasoning and missed
  // the sentence the agent had just written under it.
  //
  // Three passes, because a delta burst outruns layout: the scroll box measures
  // its content on the next two layout passes, so an immediate set plus 0 ms and
  // 25 ms re-sets catches the row a tool result just added. While a run is live
  // and the operator has not paged up, a 100 ms pin keeps the window glued to
  // the tail between content changes — a streaming answer must never scroll
  // itself off the bottom of the screen.
  const pinToTail = () => {
    const box = boxRef.current;
    if (!box) return;
    const view = box.viewport && box.viewport.height ? box.viewport.height : 0;
    if (!view) return;
    const max = Math.max(0, (box.scrollHeight || 0) - view);
    if (max <= 0) return;
    if (box.scrollTop < max) box.scrollTo(max);
  };

  useEffect(() => {
    if (!follow) return undefined;
    pinToTail();
    const t1 = setTimeout(pinToTail, 0);
    const t2 = setTimeout(pinToTail, 25);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [listSig, budget, follow]);

  useEffect(() => {
    if (!follow || !live) return undefined;
    const id = setInterval(pinToTail, 100);
    return () => clearInterval(id);
  }, [follow, live]);

  // PgUp/PgDn (and Home/End) page this window. Moving up parks the window
  // where the operator put it; returning to the bottom re-arms the follow.
  useKeyboard((key) => {
    const box = boxRef.current;
    if (!box) return;
    const name = key.name;
    if (name !== 'pageup' && name !== 'pagedown' && name !== 'home' && name !== 'end') return;
    const view = box.viewport && box.viewport.height ? box.viewport.height : budget;
    const max = Math.max(0, (box.scrollHeight || 0) - view);
    if (name === 'pageup') {
      box.scrollTop = Math.max(0, box.scrollTop - Math.max(1, view - 1));
      setFollow(false);
    } else if (name === 'pagedown') {
      const next = Math.min(max, box.scrollTop + Math.max(1, view - 1));
      box.scrollTop = next;
      setFollow(next >= max);
    } else if (name === 'home') {
      box.scrollTop = 0;
      setFollow(false);
    } else {
      box.scrollTop = max;
      setFollow(true);
    }
  });

  if (list.length === 0) {
    return (
      <box style={{ width, flexDirection: 'column' }}>
        <text fg="gray">{emptyHint || 'Ask for something and the agent runs it.'}</text>
      </box>
    );
  }

  // Leave one column for the scroll bar so a long line never collides with it.
  const contentW = Math.max(8, (Number(width) || 80) - 1);
  // Auto-compact: a short window or a narrow column gets the dense turn shape
  // (no label row, no reasoning line, one-line tool results).
  // A 40-row screen with the todos, meters, services and output panels leaves
  // the transcript ~14 rows; that still fits a role label and the reasoning
  // line, so only a genuinely tiny window drops them.
  const compact = budget < 12 || contentW < 40;

  return (
    <box style={{ width, height: budget, flexShrink: 0, overflow: 'hidden' }}>
      <scrollbox
        ref={setBox}
        style={{
          width,
          height: budget,
          stickyScroll: true,
          stickyStart: 'bottom',
          scrollY: true,
          scrollX: false,
          viewportCulling: true,
        }}
        scrollbarOptions={SCROLLBAR_OPTIONS}
      >
        {hidden > 0 ? (
          <text fg="gray">{`… ${hidden} earlier turn${hidden === 1 ? '' : 's'} (PgUp)`}</text>
        ) : null}
        <box style={{ flexDirection: 'column', width: contentW }}>
          {capped.map((message, i) => (
            <box key={message.id} style={{ marginBottom: compact ? 0 : 1, flexShrink: 0 }}>
              <MessageBlock
                message={message}
                width={contentW}
                compact={compact}
                // Only the newest turn can be streaming; every turn above it is
                // finished and draws its full answer.
                live={live && i === capped.length - 1 && message.role === 'assistant'}
                expandThinking={expandThinking}
                showLiveLabel={liveLabel}
              />
            </box>
          ))}
        </box>
      </scrollbox>
    </box>
  );
}

export { estimateRows };
