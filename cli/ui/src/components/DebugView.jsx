import React from 'react';
import { TextAttributes } from '@opentui/core';
import { BrandLine } from './HeroLogo.jsx';

/* DebugView — the TUI's own debugger (owner, 2026-11-24: "add debugger to").
 *
 * It answers the questions the last two sessions were answered by hand: why
 * does the CLI feel slow, what is it actually doing, and what does the server
 * think its own state is. Every line is either a measurement taken in this
 * process or a field the server reported — nothing here is derived from a
 * guess, and anything without a sample prints "—".
 *
 *   RENDER       app renders, per-second rate, p50/p95/max of render→commit
 *   EVENT LOOP   how late a 50 ms timer fires (the real "is it blocking" signal)
 *   PROCESS      pid, uptime, rss, heap, open handles, runtime versions
 *   TERMINAL     size, graphics support, bundle version
 *   SESSION      what the run is doing: phase, model, turns, tools, tokens, ctx
 *   TOOLS        the slowest calls this session, with their measured durations
 *   SERVER       the build the box is serving and its apply/hold state
 *
 * Keys belong to App: 'r' resets the counters, pgup/pgdn/↑/↓ scroll, esc back.
 */
const clip = (s, n) => {
  const t = String(s == null ? '' : s);
  if (n <= 0) return '';
  return t.length <= n ? t : `${t.slice(0, Math.max(0, n - 1))}…`;
};

const fmtMs = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return n < 10 ? `${n.toFixed(1)} ms` : `${Math.round(n)} ms`;
};

const fmtNum = (v) => (Number.isFinite(Number(v)) ? String(Math.round(Number(v))) : '—');

const fmtBytes = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(n / 1024)} KB`;
};

const fmtDur = (sec) => {
  const n = Math.max(0, Math.round(Number(sec) || 0));
  if (n < 60) return `${n}s`;
  const m = Math.floor(n / 60);
  if (m < 60) return `${m}m ${n % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
};

const yesNo = (v) => (v ? 'yes' : 'no');

function Row({ width, labelW, label, value, color = 'white' }) {
  const valueW = Math.max(4, width - labelW - 4);
  return (
    <box style={{ width, flexDirection: 'row', flexShrink: 0 }}>
      <text fg="gray">{`  ${clip(label, labelW).padEnd(labelW)} `}</text>
      <text fg={color}>{clip(value, valueW)}</text>
    </box>
  );
}

function Section({ width, title, hint }) {
  return (
    <box style={{ width, flexDirection: 'row', flexShrink: 0, justifyContent: 'space-between' }}>
      <text fg="cyan" attributes={TextAttributes.BOLD}>{`▸ ${title}`}</text>
      {hint ? <text fg="gray">{clip(hint, Math.max(0, width - title.length - 8))}</text> : null}
    </box>
  );
}

/** The slowest calls this session actually completed, measured by the stream. */
function slowestTools(messages, limit = 5) {
  const out = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!Array.isArray(m.tools)) continue;
    for (const t of m.tools) {
      if (!t || t.ms == null) continue;
      out.push({ name: String(t.name || 'tool'), ms: Number(t.ms) || 0, ok: t.result != null && !t.error });
    }
  }
  out.sort((a, b) => b.ms - a.ms);
  return out.slice(0, limit);
}

export default function DebugView({
  width = 72,
  stats = null,
  version = null,
  versionErr = null,
  session = {},
  messages = [],
  terminal = {},
}) {
  const w = Math.max(24, Number(width) || 72);
  const labelW = 13;
  const render = stats && stats.render ? stats.render : null;
  const lag = stats && stats.lag ? stats.lag : null;
  const proc = stats && stats.proc ? stats.proc : null;
  const srv = version && version.server ? version.server : null;
  const tools = React.useMemo(() => slowestTools(messages), [messages]);

  const ctx = session.ctxPct == null ? '—' : `${session.ctxPct}%`;
  const tokens = session.tokensKnown
    ? `${fmtNum(session.inTok)} in / ${fmtNum(session.outTok)} out`
    : 'not reported';
  const auto = session.autoMode || '—';

  return (
    <box style={{ width: w, flexDirection: 'column' }}>
      <box style={{ width: w, flexDirection: 'row', justifyContent: 'space-between' }}>
        <text fg="cyan" attributes={TextAttributes.BOLD}>◇ Debugger</text>
        <text fg="gray">{clip(stats ? `live · ${Math.max(0, Math.round((Date.now() - stats.at) / 1000))}s ago` : 'sampling…', Math.max(0, w - 12))}</text>
      </box>
      <BrandLine width={w} subtitle="debugger" />
      <text fg="gray">{clip('r reset counters · pgup/pgdn scroll · esc back — every figure is measured, "—" means no sample yet', w - 2)}</text>

      <Section width={w} title="RENDER" hint={render ? `${fmtNum(render.total)} app renders` : ''} />
      <Row width={w} labelW={labelW} label="rate" value={render && render.perSec != null ? `${render.perSec.toFixed(1)} / s` : '—'} color={(render && render.perSec != null && render.perSec > 8) ? 'yellow' : 'white'} />
      <Row width={w} labelW={labelW} label="last" value={fmtMs(render && render.last)} color={(render && render.last > 50) ? 'red' : 'white'} />
      <Row width={w} labelW={labelW} label="p50 / p95" value={render ? `${fmtMs(render.p50)} / ${fmtMs(render.p95)}` : '—'} color={(render && render.p95 > 50) ? 'yellow' : 'white'} />
      <Row width={w} labelW={labelW} label="max" value={fmtMs(render && render.max)} color={(render && render.max > 120) ? 'red' : 'white'} />
      <Row width={w} labelW={labelW} label="samples" value={render ? `${fmtNum(render.samples)} renders in this window` : '—'} />

      <Section width={w} title="EVENT LOOP" hint={lag ? `${fmtNum(lag.samples)} samples · 50 ms timer` : ''} />
      <Row width={w} labelW={labelW} label="lag p50" value={fmtMs(lag && lag.p50)} color={(lag && lag.p50 > 20) ? 'yellow' : 'white'} />
      <Row width={w} labelW={labelW} label="lag p95" value={fmtMs(lag && lag.p95)} color={(lag && lag.p95 > 40) ? 'yellow' : 'white'} />
      <Row width={w} labelW={labelW} label="lag max" value={fmtMs(lag && lag.max)} color={(lag && lag.max > 120) ? 'red' : 'white'} />

      <Section width={w} title="PROCESS" />
      <Row width={w} labelW={labelW} label="pid" value={proc ? `${proc.pid} · up ${fmtDur(proc.uptimeSec)} (page open)` : '—'} />
      <Row width={w} labelW={labelW} label="rss / heap" value={proc ? `${fmtBytes(proc.rss)} · ${fmtBytes(proc.heapUsed)} of ${fmtBytes(proc.heapTotal)}` : '—'} />
      <Row width={w} labelW={labelW} label="handles" value={proc ? (proc.handles == null ? 'unavailable' : fmtNum(proc.handles)) : '—'} />
      <Row width={w} labelW={labelW} label="runtime" value={proc ? `node ${proc.node}${proc.bun ? ` · bun ${proc.bun}` : ''}` : '—'} />

      <Section width={w} title="TERMINAL" />
      <Row width={w} labelW={labelW} label="size" value={`${fmtNum(terminal.cols)} x ${fmtNum(terminal.rows)}`} />
      <Row width={w} labelW={labelW} label="graphics" value={terminal.graphics ? 'kitty supported' : 'none (half-block only)'} color={terminal.graphics ? 'green' : 'gray'} />
      <Row width={w} labelW={labelW} label="bundle" value={terminal.version ? `v${terminal.version}` : '—'} />

      <Section width={w} title="SESSION" hint={session.connected ? 'server connected' : 'server offline'} />
      <Row width={w} labelW={labelW} label="view · phase" value={`${session.view || 'chat'} · ${session.phase || 'idle'}`} />
      <Row width={w} labelW={labelW} label="model" value={`${session.model || '—'} · ${session.provider || '—'}`} />
      <Row width={w} labelW={labelW} label="auto · handoff" value={`${auto}${session.handoff ? ' · handoff on' : ' · handoff off'}`} />
      <Row width={w} labelW={labelW} label="turns · tools" value={`${fmtNum(session.turns)} turns · ${fmtNum(session.tools)} calls (${fmtNum(session.ok)} ok, ${fmtNum(session.fail)} failed) · ${fmtNum(session.web)} web`} />
      <Row width={w} labelW={labelW} label="tokens · ctx" value={`${tokens} · ctx ${ctx}`} color={session.tokensKnown ? 'white' : 'gray'} />
      <Row width={w} labelW={labelW} label="files" value={session.guard ? `${session.guard.present}/${session.guard.total} guarded` : '—'} />
      <Row width={w} labelW={labelW} label="trust" value={session.trust == null ? '—' : fmtNum(session.trust)} />

      <Section width={w} title="TOOLS" hint={tools.length ? 'slowest calls this session' : ''} />
      {tools.length === 0 ? (
        <Row width={w} labelW={labelW} label="none" value="no timed tool calls yet" color="gray" />
      ) : tools.map((t, i) => (
        <Row
          key={`${t.name}-${i}`}
          width={w}
          labelW={labelW}
          label={i === 0 ? 'slowest' : ''}
          value={`${clip(t.name, 22).padEnd(22)} ${fmtMs(t.ms).padStart(7)}  ${t.ok ? 'ok' : 'failed'}`}
          color={t.ok ? (t.ms > 10000 ? 'yellow' : 'white') : 'red'}
        />
      ))}

      <Section width={w} title="SERVER" hint={versionErr ? '' : (version ? 'live /api/version' : '')} />
      {versionErr ? (
        <Row width={w} labelW={labelW} label="error" value={versionErr} color="red" />
      ) : null}
      <Row width={w} labelW={labelW} label="web build" value={version && version.build ? version.build : '—'} />
      <Row width={w} labelW={labelW} label="server build" value={srv && srv.build ? srv.build : '—'} />
      <Row
        width={w}
        labelW={labelW}
        label="apply"
        value={srv
          ? `${srv.applying ? 'applying' : srv.stale ? 'stale' : 'current'} · pending ${fmtNum(srv.pending)} · idle ${yesNo(srv.idle)}`
          : '—'}
        color={srv && srv.applying ? 'yellow' : srv && srv.stale ? 'yellow' : 'white'}
      />
      <Row
        width={w}
        labelW={labelW}
        label="cli attach"
        value={srv ? `${yesNo(srv.cliAttached)} · ${srv.holdReason || 'no hold'}` : '—'}
        color={srv && srv.cliAttached ? 'green' : 'white'}
      />
      <Row width={w} labelW={labelW} label="mcp" value={session.mcp ? `${fmtNum(session.mcp.up)}/${fmtNum(session.mcp.total)} servers up` : '—'} />
      <box style={{ width: w, flexShrink: 0 }}>
        <text fg="gray"> </text>
      </box>
    </box>
  );
}

export { slowestTools, fmtMs, fmtBytes };
