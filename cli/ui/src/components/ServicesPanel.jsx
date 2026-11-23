import React from 'react';
import { TextAttributes } from '@opentui/core';
import GridPanel, { Cell } from './GridPanel.jsx';
import { otherListening, portLabel } from '../../../smartness.mjs';

/* ServicesPanel — its own boxed grid of the service ports in use.
 *
 * The old TUI printed one "services 4/5 ● :3579 haksterAi …" line. The owner
 * asked for a real grid box with online/offline state: one cell per service,
 * a green dot when the port is listening and a red one when it is not, plus —
 * on the dashboard — every other listening port the scan saw.
 *
 * States come from `ss -tlnp` through smartness.mjs; the panel renders exactly
 * what was scanned and says "scan unavailable" rather than inventing a state.
 */
export const CELL_W = 16;

/** Height of this panel at `width` for `count` cells, for the row budget. */
export function servicesGridRows(width, count) {
  const inner = Math.max(1, (Number(width) || 80) - 4);
  const perRow = Math.max(1, Math.floor(inner / (CELL_W + 1)));
  const rows = Math.max(1, Math.ceil(Math.max(1, Number(count) || 1) / perRow));
  return 2 + rows * 2; // border 2 + each Cell is a label row + a value row
}

const clip = (s, n) => {
  const t = String(s == null ? '' : s);
  return t.length <= n ? t : `${t.slice(0, Math.max(0, n - 1))}…`;
};

export default function ServicesPanel({
  width = 100,
  services = [],
  scan = null,
  showAll = false,
}) {
  const w = Math.max(24, Number(width) || 80);
  const list = Array.isArray(services) ? services : [];
  const known = new Set(list.map((s) => s.port));
  const others = otherListening(scan).filter((p) => !known.has(p.port));
  const up = list.filter((s) => s.up).length;
  const scanOk = !!(scan && scan.ok);
  const allUp = list.length > 0 && up === list.length;

  // Narrow column (sidebar open): one row of green/red dots plus the counts.
  // It is ONE line by construction — the dot list is fitted to the width and
  // the remainder summarised, because a wrapped second line would push the
  // composer off the bottom of the screen.
  if (w < 96) {
    const inner = Math.max(8, w - 4);
    const head = `Services ${up}/${list.length} online  `;
    const room = Math.max(0, inner - head.length);
    const shown = [];
    let used = 0;
    for (const s of list) {
      const text = `● :${s.port}  `;
      if (used + text.length > room) break;
      shown.push({ ...s, text });
      used += text.length;
    }
    const hiddenSvc = list.length - shown.length;
    const leftover = Math.max(0, inner - head.length - used);
    const tails = !scanOk
      ? ['scan unavailable', 'scan …', '…']
      : hiddenSvc > 0
        ? [`+${hiddenSvc}  +${others.length} ports`, `+${hiddenSvc}  +${others.length}`, `+${hiddenSvc + others.length}`]
        : others.length
          ? [`+${others.length} other ports`, `+${others.length} ports`, `+${others.length}`]
          : [];
    const tail = tails.find((t) => t.length <= leftover) || '';
    return (
      <box style={{ width: w, flexDirection: 'column', border: true, borderStyle: 'rounded', borderColor: 'gray', paddingLeft: 1, paddingRight: 1, flexShrink: 0 }}>
        <text>
          <span fg="cyan" attributes={TextAttributes.BOLD}>{'Services '}</span>
          <span fg={allUp ? 'green' : up > 0 ? 'yellow' : 'red'}>{`${up}/${list.length} online  `}</span>
          {shown.map((s) => (
            <span key={s.port} fg={s.up ? 'green' : 'red'}>{s.text}</span>
          ))}
          <span fg={scanOk ? 'gray' : 'yellow'}>{tail}</span>
        </text>
      </box>
    );
  }

  const cells = list.map((s) => ({
    key: String(s.port),
    label: `:${s.port}`,
    value: `● ${s.name}`,
    color: s.up ? 'green' : 'red',
  }));
  if (showAll) {
    // Dashboard: every other listening port, capped so the grid stays legible.
    const shown = others.slice(0, 15);
    for (const p of shown) {
      cells.push({
        key: `x${p.port}`,
        label: `:${p.port}`,
        value: `● ${portLabel(p)}`,
        color: 'green',
      });
    }
    if (others.length > shown.length) {
      cells.push({
        key: 'more',
        label: 'other',
        value: `+${others.length - shown.length} ports`,
        color: 'cyan',
      });
    }
  } else if (others.length) {
    cells.push({
      key: 'more',
      label: 'other',
      value: `+${others.length} ports`,
      color: 'cyan',
    });
  }

  return (
    <GridPanel
      title="▣ Services on ports"
      width={w}
      borderColor="gray"
      hint={clip(
        `${up}/${list.length} online${others.length ? ` · ${others.length} other ports` : ''}${scanOk ? '' : ' · scan unavailable'}`,
        Math.max(6, w - 24),
      )}
    >
      {cells.map((c) => (
        <Cell key={c.key} label={c.label} value={c.value} w={CELL_W} color={c.color} />
      ))}
    </GridPanel>
  );
}
