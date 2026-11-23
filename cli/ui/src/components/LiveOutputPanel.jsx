import React from 'react';
import { Panel, ScrollRow, clip } from './LiveSidebar.jsx';
import LiveImageViewer from './LiveImageViewer.jsx';
import { overflows } from '../utils/panel-scroll.js';
import { usePanelScroll } from '../hooks/usePanelScroll.js';

/* LiveOutputPanel — the run's output, pinned at the bottom of the transcript
 * column so it can be read without looking away from the composer.
 *
 * Owner, 2026-11-23: "need the output showing in panel at the bottom over
 * thinking phrase and input bar so i can see it". The sidebar keeps its own
 * ▶ Output panel for wide terminals; this is the same data, placed where the
 * eye already is while typing. It follows the newest line while a run streams
 * (offset null = follow) and carries the house ▲/█/▼ scrollbar when it
 * overflows.
 *
 * The rendered height is CONSTANT — border 2 + title 1 + call row (one at
 * ≥44 cols, folded into the title below that) + `rows` output lines. The
 * caller budgets `liveOutputLines + 3 + (mainW >= 44 ? 1 : 0)`, and the box
 * must draw exactly that whether or not a tool call is in flight: a panel that
 * shrank by a row when it went quiet would move every panel above it.
 */
export default function LiveOutputPanel({
  width = 80,
  rows = 3,
  lines = [],
  call = '',
  busy = false,
  bindings = null,
  image = null,
  graphics = true,
}) {
  const w = Math.max(20, Number(width) || 80);
  const inner = Math.max(1, w - 4);
  const r = Math.max(1, Math.trunc(Number(rows) || 1));
  const list = Array.isArray(lines) ? lines : [];
  // Same threshold App.jsx budgets the extra call row with.
  const callRow = w >= 44;
  const compact = !callRow;
  const state = usePanelScroll({ total: list.length, rows: r, bindings, enabled: r > 0 });
  const gutterOn = overflows(list.length, r);
  const bodyW = Math.max(1, inner - (gutterOn ? 1 : 0));
  const hint = image
    ? `image${call && compact ? ` · ${clip(call, Math.max(6, inner - 12))}` : ''}`
    : list.length
      ? `${state.hint('')}${call && compact ? ` · ${clip(call, Math.max(6, inner - 12))}` : ''}`
      : busy ? 'live' : 'last';

  return (
    <Panel width={w} title="▶ Output" hint={hint}>
      {callRow ? (
        <box style={{ width: inner, flexShrink: 0 }}>
          <text fg={call ? 'cyan' : 'gray'}>{clip(call || '—', inner)}</text>
        </box>
      ) : null}
      {image && r >= 3 ? (
        <LiveImageViewer width={bodyW} height={r} source={image} graphics={graphics} />
      ) : list.length === 0 ? (
        <>
          <box style={{ width: inner, flexShrink: 0 }}>
            <text fg="gray">{busy ? clip('waiting for output…', inner) : ' '}</text>
          </box>
          {Array.from({ length: Math.max(0, r - 1) }, (_, i) => (
            <box key={`pad:${i}`} style={{ width: inner, flexShrink: 0 }}>
              <text> </text>
            </box>
          ))}
        </>
      ) : (
        Array.from({ length: r }, (_, i) => {
          const index = state.start + i;
          return (
            <ScrollRow key={`o:${i}`} width={inner} gutter={gutterOn ? state.gutter(i) : null}>
              {index < list.length ? (
                <box style={{ width: bodyW }}>
                  <text fg={index === list.length - 1 ? 'white' : 'gray'}>{clip(list[index], bodyW)}</text>
                </box>
              ) : (
                <box style={{ width: bodyW }}>
                  <text> </text>
                </box>
              )}
            </ScrollRow>
          );
        })
      )}
    </Panel>
  );
}
