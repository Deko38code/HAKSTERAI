import React, { useEffect, useRef, useState } from 'react';
import { TextAttributes } from '@opentui/core';
import { useKeyboard } from '@opentui/react';
import { clampStart, gutterChar, overflows, scrollHint } from '../utils/panel-scroll.js';
import LiveImageViewer from './LiveImageViewer.jsx';

/* LiveSidebar — the HakTerm side panel, ported to the terminal.
 *
 * HakTerm (haksterai.com/hakterm) keeps a fixed column beside the terminal
 * with STATUS / PHASE / TOOL / TURNS and the configured agents. The CLI reads
 * the same stream and the same /api/agent/mcp-status payload, so a session in
 * the browser and a session in the terminal cannot tell two different stories.
 *
 * Every row is one line: a label on the left and a clipped value on the right.
 * The row count is capped by the caller (`maxServers`) so the panel can never
 * grow taller than the transcript column beside it.
 */
// Terminal cells, not code points: an emoji or a CJK glyph takes two columns,
// so clipping by string length overflows the panel and the row wraps. The
// ranges are the usual wide/emoji blocks; the variation selector and the
// zero-width joiner take none.
export const isWide = (cp) =>
  (cp >= 0x1100 && cp <= 0x115f) ||
  cp === 0x2329 || cp === 0x232a ||
  (cp >= 0x2600 && cp <= 0x27bf) ||
  (cp >= 0x2b00 && cp <= 0x2bff) ||
  (cp >= 0x2e80 && cp <= 0xa4cf) ||
  (cp >= 0xac00 && cp <= 0xd7a3) ||
  (cp >= 0xf900 && cp <= 0xfaff) ||
  (cp >= 0xfe30 && cp <= 0xfe6f) ||
  (cp >= 0xff00 && cp <= 0xff60) ||
  (cp >= 0xffe0 && cp <= 0xffe6) ||
  (cp >= 0x1f000 && cp <= 0x1faff);
export const cellWidth = (ch) => {
  const cp = ch.codePointAt(0);
  if (cp === 0xfe0f || cp === 0x200d) return 0;
  return isWide(cp) ? 2 : 1;
};
export const clip = (s, n) => {
  const t = String(s == null ? '—' : s);
  let w = 0;
  for (const ch of t) w += cellWidth(ch);
  if (w <= n) return t;
  let out = '';
  let acc = 0;
  for (const ch of t) {
    const c = cellWidth(ch);
    if (acc + c > Math.max(0, n - 1)) break;
    out += ch;
    acc += c;
  }
  return `${out}…`;
};

function Row({ width, k, v, color = 'white' }) {
  const kw = Math.min(10, Math.max(4, Math.floor(width / 3)));
  return (
    <box style={{ width, flexDirection: 'row', justifyContent: 'space-between', flexShrink: 0 }}>
      <text fg="gray">{clip(k, kw)}</text>
      <text fg={color} attributes={TextAttributes.BOLD}>{clip(v, Math.max(1, width - kw - 1))}</text>
    </box>
  );
}

export const EVENT_COLOR = {
  phase: 'cyan',
  start: 'yellow',
  ok: 'green',
  err: 'red',
  mcp: 'blue',
  done: 'green',
  handoff: 'magenta',
  confirm: 'yellow',
  sys: 'gray',
};
export const EVENT_GLYPH = {
  phase: '◈',
  start: '⚙',
  ok: '✓',
  err: '✗',
  mcp: '⬡',
  done: '●',
  handoff: '⇄',
  confirm: '⚠',
  sys: '•',
};

/** 1_234 → 1.2k, 950 → 950 — the same rounding the hook's event lines use. */
const fmtTok = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '0';
  return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(Math.round(v));
};

export const clock = (ts) => {
  const d = new Date(Number(ts) || Date.now());
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** One line of the activity feed: time, glyph, then the event text. One
 *  <text> with spans so it can only ever be one row — three sibling texts
 *  would become three Yoga columns and a long one could wrap. In compact mode
 *  (a narrow sidebar) the clock is dropped and the glyph carries the time. */
export function EventLine({ width, line, compact = false }) {
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

/** Auto-scroll window for a fixed number of rows. `offset === null` means
 *  "follow the newest line"; the value is clamped on every render, so content
 *  arriving while scrolled back never jumps the view. The maths lives in
 *  utils/panel-scroll.js so every panel shares one implementation. */
export { clampStart, gutterChar };

/** A content row plus, when needed, its scrollbar cell. */
export function ScrollRow({ width, children, gutter }) {
  return (
    <box style={{ width, flexDirection: 'row', flexShrink: 0 }}>
      {children}
      {gutter ? <text fg="gray">{gutter}</text> : null}
    </box>
  );
}

export function Panel({ width, title, hint, children, borderColor = 'gray' }) {
  const inner = Math.max(1, width - 4);
  return (
    <box style={{ width, flexDirection: 'column', border: true, borderStyle: 'rounded', borderColor, paddingLeft: 1, paddingRight: 1, flexShrink: 0 }}>
      <box style={{ width: inner, flexDirection: 'row', justifyContent: 'space-between' }}>
        <text fg="cyan" attributes={TextAttributes.BOLD}>{clip(title, inner)}</text>
        {hint ? <text fg="gray">{clip(hint, Math.max(0, inner - title.length - 1))}</text> : null}
      </box>
      <box style={{ width: inner, flexDirection: 'column' }}>{children}</box>
    </box>
  );
}

export default function LiveSidebar({
  width = 30,
  // The sidebar's whole vertical allowance, in rows (header + status already
  // removed by the caller). Every panel is fitted inside it; nothing below is
  // allowed to push the layout apart, so a short terminal simply shows fewer
  // panels rather than a broken screen.
  height = 34,
  // agentStatus / phase are still accepted so both call sites keep working,
  // but they no longer draw a row: the spinner row, the status bar and the
  // monitor feed own the run state and the phase (owner, 2026-11-24).
  agentStatus: _agentStatus = 'idle',
  phase: _phase = 'IDLE',
  tool = '',
  turns = 0,
  elapsedMs = 0,
  version = '0.1.0',
  mcp = null,
  serverOk = false,
  liveTool = '',
  liveLines = [],
  liveImage = null,
  graphics = true,
  busy = false,
  activity = [],
  usage = null,
  memory = null,
  update = null,
  // The monitor view renders the big Activity/Output columns itself, so it
  // asks the sidebar for the same panels minus those two; their rows go to
  // the MCP list instead.
  feed = true,
}) {
  // Kept in the signature for call-site compatibility; nothing below reads them.
  void _agentStatus; void _phase;
  const inner = Math.max(1, width - 4);
  const servers = mcp && Array.isArray(mcp.servers) ? mcp.servers : [];

  // ── Panel budget ────────────────────────────────────────────────────────
  // Priority order: Live (always) → Usage → Activity → Output → MCP.
  // A panel costs its border (2), its title row (1) and its content rows, so
  // the numbers below are 3 + rows. A panel that cannot meet its minimum is
  // not rendered at all, so a short terminal shows fewer panels instead of a
  // layout whose bottom rows are cut off by the screen edge.
  const h = Math.max(0, Number(height) || 0);
  const tall = h >= 44; // room for five output lines and a longer feed
  const huge = h >= 50;
  // ◈ Live: border 2 + title 1 + its three info rows (tool · turns · version).
  // The status and phase rows are gone (owner, 2026-11-24: "all those lines
  // that are dupes can be more room for our panels"): the spinner row under
  // the composer already names the phase and the run state, the status bar
  // repeats the run state in every view, and the monitor's activity feed
  // carries the phase events — so those two rows cost three lines and said
  // nothing new. They are now room for the panels below. On a terminal too
  // short for the three, the panel gives rows up from the bottom instead of
  // pushing the status bar off the screen (its own budget, so `left` stays
  // truthful).
  const liveRows = Math.min(3, Math.max(0, h - 3));
  let left = h - (3 + liveRows);
  const showUsage = left >= 9; // ◔ Usage: 3 + 6 rows
  if (showUsage) left -= 9;
  // 🧠 Memory: 3 + 5 rows. It is the newest panel and the least time-critical,
  // so it only appears where the taller layout leaves room for the feed, the
  // output tail and at least a couple of MCP rows beside it.
  const showMemory = left >= 26;
  if (showMemory) left -= 8;
  const wantOutput = huge ? 10 : tall ? 7 : 4; // output lines
  const outputCost = wantOutput + 4; // border 2 + title 1 + call row 1 + lines
  const MCP_MIN = 6; // 3 + two servers + the "+N" row
  // Owner, 2026-11-24: the side panels read taller — the feed and the output
  // tail grow with the terminal instead of pinning at four or five lines.
  const activityMax = huge ? (showMemory ? 8 : 10) : tall ? 7 : 5;
  const room = left - outputCost - MCP_MIN - 3; // rows left for the feed itself
  const activityRows = feed && room >= 2 ? Math.min(activityMax, room) : 0;
  if (activityRows) left -= activityRows + 3;
  // ▶ Output: the call row plus the newest lines, fewer if the height shrank.
  const outputRows = feed ? (left - 4 >= wantOutput ? wantOutput : left - 4 >= 2 ? left - 4 : 0) : 0;
  if (outputRows) left -= outputRows + 4;
  // ⬡ MCP: whatever is left. One row is reserved for the "+N" line when the
  // list is longer than the space, so the panel cannot grow by one.
  const maxServers = Math.max(0, left - 4);

  const live = servers.filter((s) => s.initialized || (s.toolCount || 0) > 0).length;
  const ordered = [...servers].sort((a, b) => {
    const rank = (x) => (x.initialized || (x.toolCount || 0) > 0 ? 0 : x.lazy ? 1 : 2);
    return rank(a) - rank(b) || String(a.name).localeCompare(String(b.name));
  });

  // ── Scrolling ───────────────────────────────────────────────────────────
  // Both feeds auto-scroll to the newest line (offset `null` = follow). Shift+
  // ↑/↓ scrolls the Activity feed, shift+PgUp/PgDn pages it; when Activity is
  // not shown the same keys move the Output tail. Alt+↑/↓ (and alt+PgUp/PgDn)
  // page the MCP list, which follows its top (best-ranked first). Reaching the
  // bottom hands a feed back to auto-scroll, so a run that is producing output
  // is never left behind by an old scroll position.
  const [actOffset, setActOffset] = useState(null);
  const [outOffset, setOutOffset] = useState(null);
  const [mcpOffset, setMcpOffset] = useState(null);
  // While a run is producing output the feeds come back to the tail by
  // themselves — a parked window used to need a key or a click before it
  // followed again (owner, 2026-11-24: "the scroll is working auto not just
  // when i click it — in all panels").
  const prevAct = useRef(activity.length);
  const prevOut = useRef(liveLines.length);
  useEffect(() => {
    if (busy && activity.length > prevAct.current) setActOffset(null);
    if (busy && liveLines.length > prevOut.current) setOutOffset(null);
    prevAct.current = activity.length;
    prevOut.current = liveLines.length;
  }, [activity.length, liveLines.length, busy]);
  const actStart = clampStart(actOffset, activity.length, activityRows || 1);
  const outStart = clampStart(outOffset, liveLines.length, outputRows || 1);
  const compact = inner < 24;

  // ⬡ MCP window: the allocator's rows, one of which becomes the "more" row
  // whenever the list is longer than the space.
  const mcpCapacity = maxServers + 1; // list rows + the "more" row the allocator reserved
  const mcpOverflow = ordered.length > mcpCapacity;
  const mcpVisible = Math.max(0, mcpOverflow ? mcpCapacity - 1 : ordered.length);
  const mcpStart = mcpOffset == null
    ? 0
    : Math.max(0, Math.min(mcpOffset, Math.max(0, ordered.length - mcpVisible)));
  const shownServers = ordered.slice(mcpStart, mcpStart + mcpVisible);
  const moreAbove = mcpStart;
  const moreBelow = ordered.length - mcpStart - shownServers.length;

  const scrollBy = (setter, total, rows, delta) => {
    if (!rows) return;
    const max = Math.max(0, total - rows);
    setter((cur) => {
      const base = cur == null ? max : cur;
      const next = Math.max(0, Math.min(max, base + delta));
      return next >= max ? null : next;
    });
  };

  useKeyboard((key) => {
    if (!key || key.ctrl) return;
    const name = key.name;
    // Jump: shift+Home = oldest, shift+End = back to the live bottom (which is
    // also how a feed resumes auto-scroll). alt+Home/End does the same for the
    // MCP list — alt+End reaches the last server, alt+Home returns to the top.
    if (name === 'home' || name === 'end') {
      const bottom = name === 'end';
      if (key.meta) {
        setMcpOffset(bottom && !mcpOverflow ? null : bottom ? Math.max(0, ordered.length - mcpVisible) : null);
      } else if (key.shift) {
        if (activityRows) setActOffset(bottom ? null : 0);
        else if (outputRows) setOutOffset(bottom ? null : 0);
      }
      return;
    }
    if (name !== 'up' && name !== 'down' && name !== 'pageup' && name !== 'pagedown') return;
    const page = name === 'pageup' ? -1 : name === 'pagedown' ? 1 : 0;
    // alt+arrows page the MCP list; shift+arrows scroll the feeds.
    if (key.meta) {
      const step = page ? page * Math.max(1, mcpVisible) : name === 'up' ? -1 : 1;
      scrollBy(setMcpOffset, ordered.length, mcpVisible, step);
      return;
    }
    if (!key.shift) return;
    if (activityRows) {
      const step = page ? page * Math.max(1, activityRows) : name === 'up' ? -1 : 1;
      scrollBy(setActOffset, activity.length, activityRows, step);
    } else if (outputRows) {
      const step = page ? page * Math.max(1, outputRows) : name === 'up' ? -1 : 1;
      scrollBy(setOutOffset, liveLines.length, outputRows, step);
    }
  });

  const actGutter = overflows(activity.length, activityRows);
  const outGutter = overflows(liveLines.length, outputRows);
  const actBody = Math.max(1, inner - (actGutter ? 1 : 0));
  const outBody = Math.max(1, inner - (outGutter ? 1 : 0));
  const actHint = !activity.length
    ? busy ? 'waiting' : '0'
    : scrollHint(activity.length, activityRows, actStart, actOffset == null);
  const outHint = !liveLines.length
    ? busy ? 'live' : 'last'
    : scrollHint(liveLines.length, outputRows, outStart, outOffset == null);

  return (
    <box style={{ width, flexDirection: 'column', flexShrink: 0 }}>
      <Panel width={width} title="◈ Live" hint={serverOk ? 'online' : 'offline'}>
        {liveRows >= 1 ? (
          <Row width={inner} k="tool" v={tool || '—'} />
        ) : null}
        {liveRows >= 2 ? (
          <Row width={inner} k="turns" v={turns} />
        ) : null}
        {/* No status or phase row: the run state is on the spinner row and the
            status bar, and the phase is on the spinner row (and in the
            monitor's feed) — printing them here again was the duplication the
            owner asked to trade for panel room (owner, 2026-11-24).
            No elapsed row either: the run's spinner row under the composer is
            the single home for the timer (owner, 2026-11-24: "the elaspse time
            twice in bottom spinner and time in right panel"). */}
        {liveRows >= 3 ? (
        <Row
          width={inner}
          k="version"
          v={
            update && update.version && (update.status === 'staged' || update.status === 'blocked')
              ? `tui ${version} ${update.status === 'blocked' ? '⟂' : '⬆'}${update.version}`
              : `tui ${version}`
          }
          color={update && update.status === 'blocked' ? 'yellow' : update && update.status === 'staged' ? 'green' : 'white'}
        />
        ) : null}
      </Panel>
      {/* ◔ Usage — the session counted from the same stream events the run
          renders: tool calls actually made, how many the meter scored as wins
          and losses, requests sent to /api/agent/run (handoffs included),
          operator turns, the turn-reported token totals, and context share. */}
      {showUsage ? (
        <Panel width={width} title="◔ Usage" hint={busy ? 'live' : 'session'}>
          <Row width={inner} k="tools" v={compact ? String(Number(usage && usage.tools) || 0) : `${Number(usage && usage.tools) || 0} calls`} color="cyan" />
          <Row
            width={inner}
            k="wins"
            v={`${Number(usage && usage.ok) || 0}✓ ${Number(usage && usage.fail) || 0}✗`}
            color={Number(usage && usage.fail) > 0 ? 'yellow' : 'green'}
          />
          <Row width={inner} k="requests" v={Number(usage && usage.requests) || 0} />
          <Row width={inner} k="turns" v={Number(usage && usage.turns) || 0} />
          <Row width={inner} k="tokens" v={usage && usage.tokensKnown ? `${fmtTok(usage.inTok)} / ${fmtTok(usage.outTok)}` : '—'} color="white" />
          <Row
            width={inner}
            k="ctx"
            v={usage && usage.ctxPct != null ? `${usage.ctxPct}%` : '—'}
            color={Number(usage && usage.ctxPct) > 85 ? 'red' : Number(usage && usage.ctxPct) > 60 ? 'yellow' : 'green'}
          />
        </Panel>
      ) : null}
      {/* 🧠 Memory — the banks the server's autolearn writes and the next run
          recalls (pullMemoryBanks reads the same files), counted here so the
          session can see what it is starting from. Counts, slugs and tag
          clusters only; no observation text ever leaves the bank file. */}
      {showMemory ? (
        <Panel width={width} title="🧠 Memory" hint={memory ? `${memory.total} entries` : '…'}>
          {!memory ? (
            <box style={{ width: inner }}>
              <text fg="gray">{clip('—', inner)}</text>
            </box>
          ) : memory.banks.length === 0 ? (
            <box style={{ width: inner }}>
              <text fg="gray">{clip('empty', inner)}</text>
            </box>
          ) : (
            <>
              {(memory.banks.length > 4 ? memory.banks.slice(0, 4) : memory.banks).map((b) => (
                <Row
                  key={b.slug}
                  width={inner}
                  k={b.slug}
                  v={compact ? String(b.entries) : `${b.entries} ${b.entries === 1 ? 'entry' : 'entries'}`}
                  color="green"
                />
              ))}
              {memory.banks.length < 4 && memory.newest ? (
                <Row width={inner} k="newest" v={`${memory.newest.slug} ${clock(memory.newest.last)}`} color="gray" />
              ) : null}
              <Row
                width={inner}
                k="clusters"
                v={compact ? String(memory.clusters) : `${memory.clusters} tags`}
                color="cyan"
              />
            </>
          )}
        </Panel>
      ) : null}
      {/* ⚡ Activity — HakTerm's live event feed: every phase change, tool start,
          scored result (with its measured duration), handoff, error and turn
          end, newest at the bottom. */}
      {activityRows ? (
        <Panel width={width} title="⚡ Activity" hint={actHint}>
          {activity.length === 0 ? (
            <>
              <box style={{ width: inner }}>
                <text fg="gray">{clip(busy ? 'waiting for events…' : '—', inner)}</text>
              </box>
              {Array.from({ length: Math.max(0, activityRows - 1) }, (_, i) => (
                <box key={`apad:${i}`} style={{ width: inner, flexShrink: 0 }}>
                  <text> </text>
                </box>
              ))}
            </>
          ) : (
            // Exactly `activityRows` rows whether two events or twenty have
            // arrived: the panel (and the bar's track) keeps its height while a
            // run streams, so the panels below never jump and the thumb keeps
            // pace with the newest line.
            Array.from({ length: activityRows }, (_, i) => {
              const line = activity[actStart + i];
              return (
                <ScrollRow
                  key={`e:${actStart + i}:${i}`}
                  width={inner}
                  gutter={actGutter ? gutterChar(i, activityRows, activity.length, actStart) : null}
                >
                  {line ? (
                    <EventLine width={actBody} line={line} compact={compact} />
                  ) : (
                    <box style={{ width: actBody }}>
                      <text> </text>
                    </box>
                  )}
                </ScrollRow>
              );
            })
          )}
        </Panel>
      ) : null}
      {/* The run's own output, live — the terminal counterpart of the inline
          tool output in the IDE: the call as it starts, then the tail of what
          it returned, updated on every stream event. The call row stays pinned;
          the returned lines scroll under it with their own bar. */}
      {outputRows ? (
        <Panel width={width} title="▶ Output" hint={outHint}>
          <Row width={inner} k="call" v={liveTool ? clip(liveTool, Math.max(1, inner - 5)) : '—'} color={liveTool ? 'cyan' : 'gray'} />
          {liveImage && outputRows >= 3 ? (
            <LiveImageViewer width={inner} height={outputRows} source={liveImage} graphics={graphics} />
          ) : liveLines.length === 0 ? (
            <>
              <box style={{ width: inner }}>
                <text fg="gray">{clip(busy ? 'waiting for output…' : '—', inner)}</text>
              </box>
              {Array.from({ length: Math.max(0, outputRows - 1) }, (_, i) => (
                <box key={`opad:${i}`} style={{ width: inner, flexShrink: 0 }}>
                  <text> </text>
                </box>
              ))}
            </>
          ) : (
            // Same contract as Activity: the tail is drawn in a fixed-height
            // window, padded to `outputRows`, with the ▲/█/▼ bar on every row —
            // the bar tracks the newest line as output streams instead of
            // appearing late on a panel that grew to meet it.
            Array.from({ length: outputRows }, (_, i) => {
              const index = outStart + i;
              return (
                <ScrollRow
                  key={`o:${index}:${i}`}
                  width={inner}
                  gutter={outGutter ? gutterChar(i, outputRows, liveLines.length, outStart) : null}
                >
                  {index < liveLines.length ? (
                    <box style={{ width: outBody }}>
                      <text fg={index === liveLines.length - 1 ? 'white' : 'gray'}>{clip(liveLines[index], outBody)}</text>
                    </box>
                  ) : (
                    <box style={{ width: outBody }}>
                      <text> </text>
                    </box>
                  )}
                </ScrollRow>
              );
            })
          )}
        </Panel>
      ) : null}
      {maxServers > 0 ? (
        <Panel width={width} title="⬡ MCP servers" hint={servers.length ? `${live}/${servers.length}` : '…'}>
          {shownServers.map((s, i) => {
            const up = !!s.initialized || (s.toolCount || 0) > 0;
            const lazy = !!s.lazy && !up;
            const bar = mcpOverflow ? gutterChar(i, mcpVisible, ordered.length, mcpStart) : null;
            return (
              <ScrollRow key={s.name} width={inner} gutter={bar}>
                <Row
                  width={Math.max(1, inner - (bar ? 1 : 0))}
                  k={s.name}
                  v={up ? `${s.toolCount || 0} tools` : lazy ? 'lazy' : 'down'}
                  color={up ? 'green' : lazy ? 'yellow' : 'red'}
                />
              </ScrollRow>
            );
          })}
          {moreAbove || moreBelow ? (
            <Row
              width={inner}
              k="more"
              v={`${moreAbove ? `▲ ${moreAbove} ` : ''}${moreBelow ? `▼ ${moreBelow}` : ''}`.trim()}
              color="gray"
            />
          ) : null}
        </Panel>
      ) : null}
    </box>
  );
}
