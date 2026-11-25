import React from 'react';
import { TextAttributes } from '@opentui/core';
import SystemPanel from './SystemPanel.jsx';
import { Cell } from './GridPanel.jsx';

/* StatusServicesPanel — ONE box carrying the status line, the meters row and
 * the service ports grid.
 *
 * Owner (2026-11-24): "combined the 2 panels into 1 ... add the services panel
 * on top with haksterai online 13/13 files tui 0.3.6 put under that make it 2
 * row panel for services". So the old SystemPanel (one meters line) and the
 * "▣ Services on ports" grid are now a single bordered box: the top line is the
 * brand · state · file-guard · TUI version, the meters line sits under it, and
 * the ports grid is drawn as exactly two rows of one-line cells beneath.
 *
 * Every value is real: state from the server status, the file count from
 * existsSync on this checkout (smartness.mjs fileGuard), the ports from
 * `ss -tlnp` through smartness.mjs. Nothing here invents a reading.
 */
export const CELL_W = 16;

/** Split `n` cells across exactly two rows at `width`: at most `perRow` per
 *  row, and never more than `capacity` cells shown (the rest become "+N"). */
function gridShape(width, n) {
  const inner = Math.max(1, (Number(width) || 80) - 4);
  const perRowCap = Math.max(1, Math.floor(inner / (CELL_W + 1)));
  const perRow = Math.max(1, Math.min(perRowCap, Math.ceil(Math.max(1, n) / 2)));
  const capacity = perRow * 2;
  return { perRow, capacity };
}

/** Rows this panel occupies at `width` for `count` service cells, for the row
 *  budget: border 2 + status line 1 + meters line 1 + the two cell rows. */
export function statusServicesRows(width, count, dense = true, showMeters = true) {
  const n = Math.max(1, Number(count) || 1);
  const { perRow, capacity } = gridShape(width, n);
  const shown = Math.min(n, capacity);
  const rows = Math.max(1, Math.min(2, Math.ceil(shown / perRow)));
  return 3 + (showMeters ? 1 : 0) + rows * (dense ? 1 : 2);
}

export default function StatusServicesPanel({
  width = 100,
  services = [],
  version = '',
  guard = null,
  online = true,
  offline = false,
  meters = null,
  ctxUsed = 0,
  ctxMax = 1,
  host = null,
  dense = true,
  showMeters = true,
}) {
  const w = Math.max(24, Number(width) || 80);
  const inner = Math.max(1, w - 4);
  const list = Array.isArray(services) ? services : [];
  const up = list.filter((s) => s.up).length;
  const allUp = list.length > 0 && up === list.length;
  const guardTxt = guard ? `${guard.present}/${guard.total} files` : '';
  const guardBad = !!(guard && guard.missing && guard.missing.length);
  const stateTxt = offline ? 'OFFLINE' : online ? 'ONLINE' : 'connecting…';
  const stateColor = offline ? 'red' : online ? 'green' : 'yellow';

  // Header fitting: the left side carries brand · state · file guard; the
  // right side tries ports + version, then version, then ports, then nothing —
  // picked by measured length so a narrow column shortens the line instead of
  // wrapping it onto a second row (which would throw the row budget off). The
  // file guard outranks the version: it stays on the line as long as it fits,
  // because the owner asked for "13/13 files" to always be visible.
  const leftBase = `${offline ? '○ ' : online ? '● ' : '◌ '}◆ HAKSTER-AI · ${stateTxt}`;
  const leftFull = guardTxt ? `${leftBase}   ${guardTxt}` : leftBase;
  const rightFull = `ports ${up}/${list.length}${version ? ` · tui ${version}` : ''}`;
  const candidates = [
    { left: leftFull, right: rightFull, guard: true },
    { left: leftFull, right: version ? `tui ${version}` : '', guard: true },
    { left: leftFull, right: '', guard: true },
    { left: leftBase, right: version ? `tui ${version}` : '', guard: false },
    { left: leftBase, right: '', guard: false },
  ];
  const head = candidates.find(
    (c) => c.left.length + (c.right ? c.right.length + 2 : 0) <= inner,
  ) || { left: leftBase, right: '', guard: false };
  const showGuardHere = head.guard && !!guardTxt;
  const rightText = head.right;

  const cells = list.map((s) => ({
    key: String(s.port),
    label: `:${s.port}`,
    value: `● ${s.name}`,
    color: s.up ? 'green' : 'red',
  }));
  const { perRow, capacity } = gridShape(w, cells.length);
  const shown = cells.length > capacity ? cells.slice(0, capacity - 1) : cells;
  const hidden = cells.length - shown.length;
  const items = hidden > 0
    ? [...shown, { key: '__more', label: 'more', value: `+${hidden}`, color: 'cyan' }]
    : shown;
  const rows = [];
  for (let i = 0; i < items.length; i += perRow) rows.push(items.slice(i, i + perRow));

  return (
    <box style={{ width: w, flexDirection: 'column', border: true, borderStyle: 'rounded', borderColor: 'gray', paddingLeft: 1, paddingRight: 1, flexShrink: 0 }}>
      {/* Row 1 — brand · state · file guard (left), ports + TUI version (right). */}
      <box style={{ width: inner, flexDirection: 'row', justifyContent: 'space-between' }}>
        <text>
          <span fg={stateColor} attributes={TextAttributes.BOLD}>{offline ? '○ ' : online ? '● ' : '◌ '}</span>
          <span fg="cyan" attributes={TextAttributes.BOLD}>{'◆ HAKSTER-AI'}</span>
          <span fg={stateColor}>{` · ${stateTxt}`}</span>
          {showGuardHere ? <span fg={guardBad ? 'red' : 'gray'}>{`   ${guardTxt}`}</span> : null}
        </text>
        {rightText ? <text fg={allUp ? 'green' : up > 0 ? 'yellow' : 'red'}>{rightText}</text> : null}
      </box>
      {/* Row 2 — the meters line, unchanged from the old SystemPanel. The chat
          header takes this row over when it has the width for it (owner,
          2026-11-24: "move the autolearn cpu ram meters up top also"), so the
          box is exactly the status line + the two service rows there. */}
      {showMeters ? <SystemPanel width={inner} meters={meters} ctxUsed={ctxUsed} ctxMax={ctxMax} host={host} /> : null}
      {/* Rows 3-4 — the ports grid, always exactly two rows of one-line cells. */}
      {rows.map((row, i) => (
        <box key={`r${i}`} style={{ width: inner, flexDirection: 'row' }}>
          {row.map((c) => (
            <Cell key={c.key} label={c.label} value={c.value} w={CELL_W} color={c.color} dense={dense} />
          ))}
        </box>
      ))}
    </box>
  );
}
