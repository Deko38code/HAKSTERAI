import React, { useState } from 'react';
import { useKeyboard } from '@opentui/react';
import {
  EVENT_COLOR,
  EVENT_GLYPH,
  Panel,
  ScrollRow,
  clampStart,
  clip,
  clock,
  gutterChar,
} from './LiveSidebar.jsx';

/* MonitorFeed — the live monitor view's big columns: the full activity feed
 * (phase / tool start / scored result / handoff / error / turn end, newest at
 * the bottom) and the live output tail. It is the same data the sidebar shows,
 * given the whole screen: "live monitor mode" the way the owner asked for it —
 * open it (`/monitor` or `v`) and watch a run without the transcript in the
 * way.
 *
 * Keys: shift+↑/↓ scroll the feed, shift+PgUp/PgDn page it, shift+Home jumps to
 * the oldest line, shift+End returns to the newest and resumes auto-follow.
 * Nothing here estimates: an event line exists only because the stream sent it.
 */
function EventLine({ width, line }) {
  const compact = width < 30;
  return (
    <box style={{ width, flexShrink: 0 }}>
      <text>
        {compact ? null : <span fg="gray">{`${clock(line.ts)} `}</span>}
        <span fg={EVENT_COLOR[line.kind] || 'white'}>{`${EVENT_GLYPH[line.kind] || '•'} `}</span>
        <span fg={line.kind === 'err' ? 'red' : 'white'}>{clip(line.text, Math.max(1, width - (compact ? 2 : 8)))}</span>
      </text>
    </box>
  );
}

export default function MonitorFeed({
  width = 60,
  height = 20,
  activity = [],
  liveTool = '',
  liveLines = [],
  busy = false,
}) {
  const inner = Math.max(1, width - 4);
  const h = Math.max(0, Number(height) || 0);

  // ▶ Output keeps the newest lines; ⚡ Activity takes everything else.
  const outRows = h >= 44 ? 12 : h >= 32 ? 8 : h >= 22 ? 5 : h >= 14 ? 3 : 0;
  const feedRows = Math.max(0, h - (outRows ? outRows + 4 : 0) - 3);

  const [offset, setOffset] = useState(null);
  const [outOffset, setOutOffset] = useState(null);
  const feedStart = clampStart(offset, activity.length, feedRows || 1);
  const outStart = clampStart(outOffset, liveLines.length, outRows || 1);

  const feedGutter = feedRows > 0 && activity.length > feedRows;
  const outGutter = outRows > 0 && liveLines.length > outRows;
  const feedBody = Math.max(1, inner - (feedGutter ? 1 : 0));
  const outBody = Math.max(1, inner - (outGutter ? 1 : 0));

  useKeyboard((key) => {
    if (!key || key.ctrl || key.meta || !key.shift) return;
    const name = key.name;
    const setter = feedRows ? setOffset : outRows ? setOutOffset : null;
    const total = feedRows ? activity.length : liveLines.length;
    const rows = feedRows || outRows;
    if (!setter || !rows) return;
    if (name === 'home' || name === 'end') {
      setter(name === 'end' ? null : 0);
      return;
    }
    if (name !== 'up' && name !== 'down' && name !== 'pageup' && name !== 'pagedown') return;
    const page = name === 'pageup' ? -1 : name === 'pagedown' ? 1 : 0;
    const step = page ? page * Math.max(1, rows) : name === 'up' ? -1 : 1;
    const max = Math.max(0, total - rows);
    setter((cur) => {
      const base = cur == null ? max : cur;
      const next = Math.max(0, Math.min(max, base + step));
      return next >= max ? null : next;
    });
  });

  const feedHint = !activity.length
    ? busy ? 'waiting' : '0'
    : feedGutter
      ? `${feedStart + 1}-${Math.min(activity.length, feedStart + feedRows)}/${activity.length}${offset != null ? ' ⇣' : ''}`
      : String(activity.length);
  const outHint = outGutter
    ? `${outStart + 1}-${Math.min(liveLines.length, outStart + outRows)}/${liveLines.length}${outOffset != null ? ' ⇣' : ''}`
    : busy ? 'live' : 'last';

  return (
    <box style={{ width, flexDirection: 'column', flexShrink: 0 }}>
      {feedRows ? (
        <Panel width={width} title="⚡ Live activity" hint={feedHint}>
          {activity.length === 0 ? (
            <>
              <box style={{ width: inner }}>
                <text fg="gray">{clip(busy ? 'waiting for events…' : 'no events this session — run a task', inner)}</text>
              </box>
              {/* Keep the panel's measured height: the feed is the monitor's
                  main column and must not collapse to one row while idle. */}
              {Array.from({ length: Math.max(0, feedRows - 1) }, (_, i) => (
                <box key={`pad:${i}`} style={{ width: inner, flexShrink: 0 }}>
                  <text> </text>
                </box>
              ))}
            </>
          ) : (
            activity.slice(feedStart, feedStart + feedRows).map((line, i) => (
              <ScrollRow
                key={`e:${line.ts}:${i}`}
                width={inner}
                gutter={feedGutter ? gutterChar(i, feedRows, activity.length, feedStart) : null}
              >
                <EventLine width={feedBody} line={line} />
              </ScrollRow>
            ))
          )}
        </Panel>
      ) : null}
      {outRows ? (
        <Panel width={width} title="▶ Output" hint={outHint}>
          <box style={{ width: inner, flexShrink: 0 }}>
            <text fg={liveTool ? 'cyan' : 'gray'}>{clip(liveTool || 'no tool call yet', inner)}</text>
          </box>
          {liveLines.length === 0 ? (
            <>
              <box style={{ width: inner }}>
                <text fg="gray">{clip(busy ? 'waiting for output…' : '—', inner)}</text>
              </box>
              {Array.from({ length: Math.max(0, outRows - 1) }, (_, i) => (
                <box key={`pad:${i}`} style={{ width: inner, flexShrink: 0 }}>
                  <text> </text>
                </box>
              ))}
            </>
          ) : (
            liveLines.slice(outStart, outStart + outRows).map((line, i) => (
              <ScrollRow
                key={`o:${i}`}
                width={inner}
                gutter={outGutter ? gutterChar(i, outRows, liveLines.length, outStart) : null}
              >
                <box style={{ width: outBody }}>
                  <text fg={i === outRows - 1 ? 'white' : 'gray'}>{clip(line, outBody)}</text>
                </box>
              </ScrollRow>
            ))
          )}
        </Panel>
      ) : null}
    </box>
  );
}
