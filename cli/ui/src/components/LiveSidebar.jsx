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
const clip = (s, n) => {
  const t = String(s == null ? '—' : s);
  return t.length <= n ? t : t.slice(0, Math.max(0, n - 1)) + '…';
};

function Row({ width, k, v, color = 'white' }) {
  const kw = Math.min(10, Math.max(4, Math.floor(width / 3)));
  return (
    <box style={{ width, justifyContent: 'space-between', flexShrink: 0 }}>
      <text fg="gray">{clip(k, kw)}</text>
      <text fg={color} attributes={TextAttributes.BOLD}>{clip(v, Math.max(1, width - kw - 1))}</text>
    </box>
  );
}

function Panel({ width, title, hint, children }) {
  const inner = Math.max(1, width - 4);
  return (
    <box style={{ width, flexDirection: 'column', border: true, borderStyle: 'rounded', borderColor: 'gray', paddingLeft: 1, paddingRight: 1, flexShrink: 0 }}>
      <box style={{ width: inner, justifyContent: 'space-between' }}>
        <text fg="cyan" attributes={TextAttributes.BOLD}>{clip(title, inner)}</text>
        {hint ? <text fg="gray">{clip(hint, Math.max(0, inner - title.length - 1))}</text> : null}
      </box>
      <box style={{ width: inner, flexDirection: 'column' }}>{children}</box>
    </box>
  );
}

export default function LiveSidebar({
  width = 30,
  agentStatus = 'idle',
  phase = 'IDLE',
  tool = '',
  turns = 0,
  elapsedMs = 0,
  model = '',
  version = '0.1.0',
  mcp = null,
  serverOk = false,
  maxServers = 8,
}) {
  const inner = Math.max(1, width - 4);
  const servers = mcp && Array.isArray(mcp.servers) ? mcp.servers : [];
  const live = servers.filter((s) => s.initialized || (s.toolCount || 0) > 0).length;
  const ordered = [...servers].sort((a, b) => {
    const rank = (x) => (x.initialized || (x.toolCount || 0) > 0 ? 0 : x.lazy ? 1 : 2);
    return rank(a) - rank(b) || String(a.name).localeCompare(String(b.name));
  });
  const shown = ordered.slice(0, Math.max(0, maxServers));
  const hidden = ordered.length - shown.length;
  return (
    <box style={{ width, flexDirection: 'column', flexShrink: 0 }}>
      <Panel width={width} title="Live" hint={serverOk ? 'online' : 'offline'}>
        <Row width={inner} k="status" v={agentStatus || 'idle'} color={agentStatus === 'error' ? 'red' : agentStatus === 'idle' ? 'gray' : 'green'} />
        <Row width={inner} k="phase" v={phase || 'IDLE'} color="cyan" />
        <Row width={inner} k="tool" v={tool || '—'} />
        <Row width={inner} k="turns" v={turns} />
        <Row width={inner} k="elapsed" v={`${(Number(elapsedMs || 0) / 1000).toFixed(1)}s`} />
        <Row width={inner} k="model" v={model} color="yellow" />
        <Row width={inner} k="version" v={`tui ${version}`} />
      </Panel>
      <Panel width={width} title="MCP servers" hint={servers.length ? `${live}/${servers.length}` : '…'}>
        {shown.length === 0 ? (
          <Row width={inner} k="servers" v="—" color="gray" />
        ) : (
          shown.map((s) => {
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
          })
        )}
        {hidden > 0 ? <Row width={inner} k="more" v={`+${hidden}`} color="gray" /> : null}
      </Panel>
    </box>
  );
}
