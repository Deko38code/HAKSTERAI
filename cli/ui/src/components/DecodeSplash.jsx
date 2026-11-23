import React, { useEffect, useRef, useState } from 'react';
import { TextAttributes } from '@opentui/core';

/* DecodeSplash — the CLI's start screen: five lines decode at the same time.
 *
 * Owner, 2026-11-23: "the decoder feat … decodes 5 lines simultaneously".
 * Each line starts as scrambled letters and digits, keeps its real spaces and
 * punctuation, and reveals itself left to right — all five lines together, then
 * the screen hands over to the dashboard. Nothing here is decorative fiction:
 * the five lines are the CLI's real name, version, model, server state and the
 * keys that work. `/settings intro off` skips it.
 */
const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function scrambleLine(text, reveal, frame) {
  const t = String(text == null ? '' : text);
  let out = '';
  let index = 0;
  for (const ch of t) {
    if (index < reveal || !/[A-Za-z0-9]/.test(ch)) {
      out += ch;
    } else {
      const seed = (Math.imul(index + frame + 1, 2654435761) + ch.charCodeAt(0) * 101) >>> 0;
      out += GLYPHS[seed % GLYPHS.length];
    }
    index += 1;
  }
  return out;
}

export default function DecodeSplash({ width = 80, height = 24, lines = [], onDone, stepMs = 55 }) {
  const [frame, setFrame] = useState(0);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  const longest = lines.reduce((n, l) => Math.max(n, String(l.text || '').length), 1);
  // ~2.4 characters reveal per frame: the longest line settles in about a
  // second, and every line decodes at the same time (owner: "decodes 5 lines
  // simultaneously"). Then a short hold shows the settled text.
  const revealStep = 2.4;
  const settleAt = Math.ceil(longest / revealStep) + 1;
  const reveal = Math.min(longest, Math.floor(frame * revealStep));
  const done = frame >= settleAt;

  useEffect(() => {
    if (done) return undefined;
    const id = setInterval(() => {
      setFrame((f) => (f + 1 >= settleAt ? settleAt : f + 1));
    }, stepMs);
    return () => clearInterval(id);
  }, [done, settleAt, stepMs]);

  // Hold the settled text briefly, then hand over — once. The callback lives in
  // a ref so a parent re-render cannot restart the timeout.
  useEffect(() => {
    if (!done) return undefined;
    const id = setTimeout(() => {
      if (typeof doneRef.current === 'function') doneRef.current();
    }, 260);
    return () => clearTimeout(id);
  }, [done]);

  return (
    <box
      style={{
        width,
        height,
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        overflow: 'hidden',
      }}
    >
      {lines.map((line, i) => (
        <box key={`d:${i}`} style={{ flexDirection: 'row', flexShrink: 0 }}>
          <text fg={line.color || 'gray'} attributes={line.bold ? TextAttributes.BOLD : 0}>
            {scrambleLine(line.text, reveal, frame + i)}
          </text>
        </box>
      ))}
      <box style={{ flexDirection: 'row', flexShrink: 0 }}>
        <text fg="gray">{done ? ' ' : scrambleLine('▚▚▚▚▚▚▚▚', frame, frame)}</text>
      </box>
    </box>
  );
}
