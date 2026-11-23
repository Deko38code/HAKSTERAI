import React from 'react';
import { TextAttributes } from '@opentui/core';
import { barCells, barColor, smartLabel } from '../../../smartness.mjs';

/* SystemPanel — the old CLI's SMARTNESS / AUTOLEARN row, plus the two readings
 * it carried elsewhere: the context-window bar (Ink TUI status row) and the
 * 13-code-file guard count (agent `IMPORTANT_FILES`, shown "13/13 files").
 *
 * One pinned row above the composer. Every value is real: the meters come from
 * the live tool stream, context from the server's token count, the file count
 * from existsSync on this checkout. A missing guard file turns the count red.
 *
 * The row is ONE `<text>` with inline `<span>`s so it can only ever be one
 * line — sibling text nodes would become separate Yoga columns, and an
 * overflowing one would wrap and push the composer off screen.
 */
const clip = (s, n) => {
  const t = String(s == null ? '' : s);
  return t.length <= n ? t : `${t.slice(0, Math.max(0, n - 1))}…`;
};

export default function SystemPanel({ width = 100, meters = null, ctxUsed = 0, ctxMax = 1 }) {
  const w = Math.max(24, Number(width) || 80);
  const score = Math.max(0, Math.min(100, Math.round(Number(meters && meters.score) || 0)));
  const points = Math.max(0, Math.round(Number(meters && meters.points) || 0));
  const delta = Number(meters && meters.delta) || 0;
  const ctxPct = ctxMax > 0 ? Math.max(0, Math.min(100, Math.round((Number(ctxUsed) || 0) / ctxMax * 100))) : 0;
  const arrow = delta > 0 ? '▲' : delta < 0 ? '▼' : '◆';
  const arrowColor = delta > 0 ? 'green' : delta < 0 ? 'red' : 'gray';
  // The file-guard count lives in the header (always visible, every view), so
  // it is not repeated here.

  const sc = barCells(score, 100, 12);
  const ac = barCells(points, 100, 10);
  const cc = barCells(ctxPct, 100, 8);

  // Three widths: full bars, bars-less labels, and a terse line for narrow
  // panels. Pick the richest one that provably fits, so the row never wraps.
  const fullLen = 3 + 12 + 13 + 3 + 2 + 10 + 16 + 3 + 4 + 8 + 7;
  const compact = `🧠 ${score}% ${arrow} ${smartLabel(score)}  ✦ ${points}p autolearn  ctx ${ctxPct}%`;
  const terse = `🧠 ${score}% ✦ ${points}p ctx ${ctxPct}%`;

  if (fullLen <= w) {
    return (
      <box style={{ width: w, flexDirection: 'column', flexShrink: 0, paddingLeft: 1, paddingRight: 1 }}>
        <text>
          <span fg={barColor('smart', score)} attributes={TextAttributes.BOLD}>{'🧠 '}</span>
          <span fg={barColor('smart', score)}>{'█'.repeat(sc.filled)}</span>
          <span fg="gray">{'░'.repeat(sc.empty)}</span>
          <span fg="white" attributes={TextAttributes.BOLD}>{` ${score}% `}</span>
          <span fg={arrowColor}>{arrow}</span>
          <span fg="gray">{` ${smartLabel(score)}`}</span>
          <span fg="gray">{'   '}</span>
          <span fg={barColor('points', points)} attributes={TextAttributes.BOLD}>{'✦ '}</span>
          <span fg={barColor('points', points)}>{'█'.repeat(ac.filled)}</span>
          <span fg="gray">{'░'.repeat(ac.empty)}</span>
          <span fg="white" attributes={TextAttributes.BOLD}>{` ${points}p`}</span>
          <span fg="gray">{' autolearn   '}</span>
          <span fg={ctxPct > 85 ? 'red' : ctxPct > 60 ? 'yellow' : 'green'}>{'ctx '}</span>
          <span fg={ctxPct > 85 ? 'red' : ctxPct > 60 ? 'yellow' : 'green'}>{'█'.repeat(cc.filled)}</span>
          <span fg="gray">{'░'.repeat(cc.empty)}</span>
          <span fg="white">{` ${ctxPct}%`}</span>
        </text>
      </box>
    );
  }

  return (
    <box style={{ width: w, flexDirection: 'column', flexShrink: 0, paddingLeft: 1, paddingRight: 1 }}>
      <text>
        <span fg={barColor('smart', score)} attributes={TextAttributes.BOLD}>{clip(compact.length <= w ? compact : terse, Math.max(10, w - 2))}</span>
      </text>
    </box>
  );
}
