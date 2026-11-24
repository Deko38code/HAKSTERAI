import React from 'react';
import { TextAttributes } from '@opentui/core';

/* McpView — the MCP server manager, the terminal's answer to Claude CLI's
 * `/mcp`. Owner, 2026-11-24: "fix our popout /menu for all our cli settings
 * mcps etc like claude cli has".
 *
 * Every server the server reports on /api/agent/mcp-status, with the truth as
 * it was last polled:
 *
 *   ●/○     connected (initialized) or down
 *   tools   how many tools that server exposes
 *   lazy    a server that connects on first use
 *   pid     the child process, when there is one
 *
 * The selected server's tool names are listed underneath, wrapped to the panel
 * width — the same list the agent has, not a summary.
 *
 *   ↑/↓  move    esc  back    r  re-read now
 *
 * Nothing here writes: MCP servers are configured in .hakster/mcp.json and this
 * page only reports what the running server says.
 */
const clip = (s, n) => {
  const t = String(s == null ? '' : s);
  return t.length <= n ? t : `${t.slice(0, Math.max(0, n - 1))}…`;
};

const wrap = (words, width) => {
  const lines = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} · ${word}` : word;
    if (next.length > width && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
};

export default function McpView({
  width = 72,
  height = 20,
  servers = [],
  selected = 0,
}) {
  const w = Math.max(24, Number(width) || 72);
  const h = Math.max(7, Number(height) || 20);
  const inner = Math.max(1, w - 4);
  const live = servers.filter((s) => s.initialized || (Number(s.toolCount) || 0) > 0).length;
  const tools = servers.reduce((n, s) => n + (Number(s.toolCount) || 0), 0);

  // Budget inside the box: border 2 + title 1 + footer 1 = 4 chrome rows; the
  // server list takes at most half of what is left so the tool list always has
  // somewhere to render.
  const body = Math.max(3, h - 4);
  const listRows = Math.max(1, Math.min(servers.length, Math.ceil(body / 2)));
  const sel = Math.max(0, Math.min(selected, Math.max(0, servers.length - 1)));
  const start = Math.max(0, Math.min(sel - Math.floor(listRows / 2), Math.max(0, servers.length - listRows)));
  const shown = servers.slice(start, start + listRows);
  const active = servers[sel];
  const toolRows = Math.max(0, body - listRows - 1);
  const toolLines = active
    ? wrap(Array.isArray(active.tools) && active.tools.length ? active.tools : ['(no tools listed)'], inner - 2)
    : [];

  return (
    <box style={{ width: w, flexDirection: 'column', border: true, borderStyle: 'rounded', borderColor: 'blue', paddingLeft: 1, paddingRight: 1, flexShrink: 0 }}>
      <box style={{ width: inner, flexDirection: 'row', justifyContent: 'space-between' }}>
        <text fg="blue" attributes={TextAttributes.BOLD}>{'⬡ MCP servers'}</text>
        <text fg="gray">
          {clip(`${live}/${servers.length} live · ${tools} tools${servers.length > listRows ? ` · ${start}↑ ${Math.max(0, servers.length - start - shown.length)}↓` : ''}`, inner - 14)}
        </text>
      </box>
      <box style={{ width: inner, flexDirection: 'column' }}>
        {shown.length === 0 ? (
          <text fg="gray">{clip('no servers reported — is the server reachable?', inner)}</text>
        ) : shown.map((s, i) => {
          const abs = start + i;
          const isSel = abs === sel;
          const up = s.initialized || (Number(s.toolCount) || 0) > 0;
          const count = s.toolCount == null ? '?' : String(s.toolCount);
          const notes = [
            `${count} tools`,
            s.lazy ? 'lazy' : '',
            s.initialized === false ? 'down' : '',
            s.pid ? `pid ${s.pid}` : '',
          ].filter(Boolean).join(' · ');
          return (
            <box key={`s:${s.name}`} style={{ width: inner, flexDirection: 'row', flexShrink: 0 }}>
              <text fg={isSel ? 'yellow' : up ? 'green' : 'red'} attributes={isSel ? TextAttributes.BOLD : 0}>
                {`${isSel ? '▸ ' : '  '}${up ? '●' : '○'} ${clip(s.name, Math.max(8, Math.floor(inner / 2)))}`}
              </text>
              <text fg={isSel ? 'white' : 'gray'}>{` ${clip(notes, Math.max(4, inner - Math.floor(inner / 2) - 5))}`}</text>
            </box>
          );
        })}
      </box>
      {toolRows > 0 ? (
        <>
          <box style={{ width: inner, flexShrink: 0 }}>
            <text fg="gray" attributes={TextAttributes.BOLD}>{clip(`— tools · ${active ? active.name : '—'} —`, inner)}</text>
          </box>
          <box style={{ width: inner, flexDirection: 'column' }}>
            {(() => {
              // Keep the tool block inside toolRows: when the list overflows,
              // spend the last row on "… N more" instead of drawing past it.
              const overflow = toolLines.length > toolRows;
              const visible = overflow ? toolLines.slice(0, Math.max(0, toolRows - 1)) : toolLines.slice(0, toolRows);
              const pad = Math.max(0, toolRows - visible.length - (overflow ? 1 : 0));
              return (
                <>
                  {visible.map((line, i) => (
                    <box key={`t:${i}`} style={{ width: inner, flexShrink: 0 }}>
                      <text fg="white">{clip(`  ${line}`, inner)}</text>
                    </box>
                  ))}
                  {overflow ? (
                    <box style={{ width: inner, flexShrink: 0 }}>
                      <text fg="gray">{clip(`  … ${toolLines.length - visible.length} more tool rows`, inner)}</text>
                    </box>
                  ) : null}
                  {Array.from({ length: pad }, (_, i) => (
                    <box key={`tp:${i}`} style={{ width: inner, flexShrink: 0 }}>
                      <text> </text>
                    </box>
                  ))}
                </>
              );
            })()}
          </box>
        </>
      ) : null}
      <box style={{ width: inner }}>
        <text fg="gray">{clip('↑↓ select · r re-read · esc back · servers come from .hakster/mcp.json', inner)}</text>
      </box>
    </box>
  );
}
