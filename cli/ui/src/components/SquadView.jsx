import React from 'react';
import { TextAttributes } from '@opentui/core';
import { BrandLine } from './HeroLogo.jsx';
import ScrollPanel from './ScrollPanel.jsx';

/* SquadView — the sub-agents this CLI can call, with their real tools.
 *
 * Owner, 2026-11-23: "make sure we have sub agents", "for side calls peer sync
 * help", "phantom etc", "codex kiro", "freebuff agents".
 *
 * The peers are exactly what the server reported from /api/agent/mcp-status —
 * the same payload the sidebar's MCP panel reads — filtered to the servers that
 * are agents rather than utilities. Nothing is listed that the running server
 * did not report, and every tool name shown is one the server said it has.
 *
 * Enter does not invent a dispatch path: it puts a ready-to-send delegation on
 * the composer, naming the peer and its first tool, so the agent makes the
 * side call through the same MCP bridge the browser HakTerm uses. That keeps
 * one code path for sub-agent work and leaves the decision with the operator.
 */
import { peersFromMcp } from '../utils/squad.js';

export default function SquadView({
  width = 80,
  height = 20,
  peers = [],
  selected = 0,
  onPick,
}) {
  const w = Math.max(24, Number(width) || 80);
  const h = Math.max(8, Number(height) || 20);
  const chosen = peers[Math.min(selected, Math.max(0, peers.length - 1))] || null;
  const listRows = Math.min(8, Math.max(1, peers.length || 1));
  const listPanelRows = listRows + 3;
  // -4: the brand line sits above the two panels.
  const toolsRows = Math.max(2, h - listPanelRows - 4);
  const up = peers.filter((p) => p.up).length;
  const lazy = peers.filter((p) => p.state === 'lazy').length;
  const DOT = { live: '● ', lazy: '◐ ', down: '○ ' };
  const TINT = { live: 'green', lazy: 'cyan', down: 'red' };

  return (
    <box style={{ width: w, height: h, flexDirection: 'column', overflow: 'hidden', flexShrink: 0 }}>
      <BrandLine width={w} subtitle="sub-agents" />
      <ScrollPanel
        width={w}
        title={`⍟ Squad · ${up}/${peers.length} live${lazy ? ` · ${lazy} lazy` : ''}`}
        hint="↑↓ select · enter delegate · esc back"
        total={peers.length}
        rows={listRows}
        selected={Math.min(selected, Math.max(0, peers.length - 1))}
        initial="top"
        empty="no agent peers reported by the server yet"
      >
        {(index, { width: rowW }) => {
          const p = peers[index];
          if (!p) return null;
          const active = index === selected;
          return (
            <box style={{ width: rowW, flexDirection: 'row', flexShrink: 0 }}>
              <text fg={active ? 'yellow' : TINT[p.state] || 'red'} attributes={active ? TextAttributes.BOLD : 0}>
                {`${active ? '▸ ' : '  '}${DOT[p.state] || '○ '}`}
              </text>
              <text fg={active ? 'yellow' : 'white'}>{p.name.padEnd(Math.min(16, Math.max(8, rowW - 16)))}</text>
              <text fg="gray">{`${p.tools.length} tools · ${p.state}`}</text>
            </box>
          );
        }}
      </ScrollPanel>
      <ScrollPanel
        width={w}
        title={chosen ? `${chosen.name} · tools` : 'tools'}
        hint={chosen ? `${chosen.tools.length} available` : ''}
        total={chosen ? chosen.tools.length : 0}
        rows={toolsRows}
        borderColor="magenta"
        initial="top"
        empty="—"
      >
        {(index, { width: rowW, compact }) => {
          const tool = chosen && chosen.tools[index];
          if (!tool) return null;
          return (
            <box style={{ width: rowW }}>
              <text fg="white">
                {compact ? tool : `mcp__${chosen.name}__${tool}`}
              </text>
            </box>
          );
        }}
      </ScrollPanel>
    </box>
  );
}
