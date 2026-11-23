import React from 'react';
import { TextAttributes } from '@opentui/core';

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
const isWide = (cp) =>
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
const cellWidth = (ch) => {
  const cp = ch.codePointAt(0);
  if (cp === 0xfe0f || cp === 0x200d) return 0;
  return isWide(cp) ? 2 : 1;
};
const clip = (s, n) => {
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

const EVENT_COLOR = {
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
const EVENT_GLYPH = {
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

const clock = (ts) => {
  const d = new Date(Number(ts) || Date.now());
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** One line of the activity feed: time, glyph, then the event text. One
 *  <text> with spans so it can only ever be one row — three sibling texts
 *  would become three Yoga columns and a long one could wrap. */
function EventLine({ width, line }) {
  return (
    <box style={{ width, flexShrink: 0 }}>
      <text>
        <span fg="gray">{`${clock(line.ts)} `}</span>
        <span fg={EVENT_COLOR[line.kind] || 'white'}>{`${EVENT_GLYPH[line.kind] || '•'} `}</span>
        <span fg={line.kind === 'err' ? 'red' : 'white'}>{clip(line.text, Math.max(1, width - 8))}</span>
      </text>
    </box>
  );
}

function Panel({ width, title, hint, children }) {
  const inner = Math.max(1, width - 4);
  return (
    <box style={{ width, flexDirection: 'column', border: true, borderStyle: 'rounded', borderColor: 'gray', paddingLeft: 1, paddingRight: 1, flexShrink: 0 }}>
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
  agentStatus = 'idle',
  phase = 'IDLE',
  tool = '',
  turns = 0,
  elapsedMs = 0,
  model = '',
  version = '0.1.0',
  mcp = null,
  serverOk = false,
  liveTool = '',
  liveLines = [],
  busy = false,
  activity = [],
  usage = null,
}) {
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
  let left = h - 10; // ◈ Live: 3 + 7 rows
  const showUsage = left >= 9; // ◔ Usage: 3 + 6 rows
  if (showUsage) left -= 9;
  const wantOutput = huge ? 6 : tall ? 4 : 3; // output lines
  const outputCost = wantOutput + 4; // border 2 + title 1 + call row 1 + lines
  const MCP_MIN = 6; // 3 + two servers + the "+N" row
  const activityMax = huge ? 8 : tall ? 5 : 4;
  const room = left - outputCost - MCP_MIN - 3; // rows left for the feed itself
  const activityRows = room >= 2 ? Math.min(activityMax, room) : 0;
  if (activityRows) left -= activityRows + 3;
  // ▶ Output: the call row plus the newest lines, fewer if the height shrank.
  const outputRows = left - 4 >= wantOutput ? wantOutput : left - 4 >= 2 ? left - 4 : 0;
  if (outputRows) left -= outputRows + 4;
  // ⬡ MCP: whatever is left. One row is reserved for the "+N" line when the
  // list is longer than the space, so the panel cannot grow by one.
  const maxServers = Math.max(0, left - 4);

  const live = servers.filter((s) => s.initialized || (s.toolCount || 0) > 0).length;
  const ordered = [...servers].sort((a, b) => {
    const rank = (x) => (x.initialized || (x.toolCount || 0) > 0 ? 0 : x.lazy ? 1 : 2);
    return rank(a) - rank(b) || String(a.name).localeCompare(String(b.name));
  });
  const shown = ordered.slice(0, Math.max(0, maxServers));
  const hidden = ordered.length - shown.length;
  return (
    <box style={{ width, flexDirection: 'column', flexShrink: 0 }}>
      <Panel width={width} title="◈ Live" hint={serverOk ? 'online' : 'offline'}>
        <Row width={inner} k="status" v={agentStatus || 'idle'} color={agentStatus === 'error' ? 'red' : agentStatus === 'idle' ? 'gray' : 'green'} />
        <Row width={inner} k="phase" v={phase || 'IDLE'} color="cyan" />
        <Row width={inner} k="tool" v={tool || '—'} />
        <Row width={inner} k="turns" v={turns} />
        <Row width={inner} k="elapsed" v={`${(Number(elapsedMs || 0) / 1000).toFixed(1)}s`} />
        <Row width={inner} k="model" v={model} color="yellow" />
        <Row width={inner} k="version" v={`tui ${version}`} />
      </Panel>
      {/* ◔ Usage — the session counted from the same stream events the run
          renders: tool calls actually made, how many the meter scored as wins
          and losses, requests sent to /api/agent/run (handoffs included),
          operator turns, the turn-reported token totals, and context share. */}
      {showUsage ? (
        <Panel width={width} title="◔ Usage" hint={busy ? 'live' : 'session'}>
          <Row width={inner} k="tools" v={`${Number(usage && usage.tools) || 0} calls`} color="cyan" />
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
      {/* ⚡ Activity — HakTerm's live event feed: every phase change, tool start,
          scored result (with its measured duration), handoff, error and turn
          end, newest at the bottom. */}
      {activityRows ? (
        <Panel width={width} title="⚡ Activity" hint={busy ? 'live' : `${activity.length}`}>
          {activity.length === 0 ? (
            <box style={{ width: inner }}>
              <text fg="gray">{clip(busy ? 'waiting for events…' : '—', inner)}</text>
            </box>
          ) : (
            activity.slice(-activityRows).map((line, i) => (
              <EventLine key={`e:${line.ts}:${i}`} width={inner} line={line} />
            ))
          )}
        </Panel>
      ) : null}
      {/* The run's own output, live — the terminal counterpart of the inline
          tool output in the IDE: the call as it starts, then the tail of what
          it returned, updated on every stream event. */}
      {outputRows ? (
        <Panel width={width} title="▶ Output" hint={busy ? 'live' : 'last'}>
          <Row width={inner} k="call" v={liveTool ? clip(liveTool, Math.max(1, inner - 5)) : '—'} color={liveTool ? 'cyan' : 'gray'} />
          {liveLines.length === 0 ? (
            <box style={{ width: inner }}>
              <text fg="gray">{clip(busy ? 'waiting for output…' : '—', inner)}</text>
            </box>
          ) : (
            liveLines.slice(-outputRows).map((line, i) => (
              <box key={`o:${i}`} style={{ width: inner }}>
                <text fg={i === liveLines.slice(-outputRows).length - 1 ? 'white' : 'gray'}>{clip(line, inner)}</text>
              </box>
            ))
          )}
        </Panel>
      ) : null}
      {maxServers > 0 ? (
        <Panel width={width} title="⬡ MCP servers" hint={servers.length ? `${live}/${servers.length}` : '…'}>
          {shown.map((s) => {
            const up = !!s.initialized || (s.toolCount || 0) > 0;
            const lazy = !!s.lazy && !up;
            return (
              <Row
                key={s.name}
                width={inner}
                k={s.name}
                v={up ? `${s.toolCount || 0} tools` : lazy ? 'lazy' : 'down'}
                color={up ? 'green' : lazy ? 'yellow' : 'red'}
              />
            );
          })}
          {hidden > 0 ? <Row width={inner} k="more" v={`+${hidden}`} color="gray" /> : null}
        </Panel>
      ) : null}
    </box>
  );
}
