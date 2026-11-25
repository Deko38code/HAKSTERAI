import React from 'react';
import { TextAttributes } from '@opentui/core';
import SystemPanel from './SystemPanel.jsx';
import { Cell } from './GridPanel.jsx';
import { gridShape, statusServicesRows } from './services-grid.mjs';

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
// The wrapping math lives in ./services-grid.mjs so this renderer, the row
// budget in App.jsx and the tests all read one implementation — a panel that
// drew more rows than were reserved would push every panel below it down.
// Re-exported here because callers import it from this panel.
export { statusServicesRows };

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
    // Port + name: two entries can share a port (a v4 and a v6 bind), and a
    // duplicate React key silently drops one of them from the grid.
    key: `:${s.port} ${s.name}`,
    label: `:${s.port}`,
    value: `● ${s.name}`,
    color: s.up ? 'green' : 'red',
  }));
  const { cols, cellW, capacity } = gridShape(w, cells.length);
  const shown = cells.length > capacity ? cells.slice(0, capacity - 1) : cells;
  const hidden = cells.length - shown.length;
  // One cell is always drawn, even with nothing to list, so the box occupies
  // exactly the rows statusServicesRows() reserved for it.
  const items = cells.length === 0
    ? [{ key: '__none', label: 'ports', value: online ? 'none up' : 'waiting', color: 'gray' }]
    : hidden > 0
      ? [...shown, { key: '__more', label: 'more', value: `+${hidden}`, color: 'cyan' }]
      : shown;
  const rows = [];
  for (let i = 0; i < items.length; i += cols) rows.push(items.slice(i, i + cols));

  return (
    <box style={{ width: w, flexDirection: 'column', border: true, borderStyle: 'rounded', borderColor: 'gray', paddingLeft: 1, paddingRight: 1, flexShrink: 0 }}>
      {/* Row 1 — brand · state · file guard (left), ports + TUI version (right). */}
      <box style={{ width: inner, flexDirection: 'row', justifyContent: 'space-between' }}>
        <text>
          <span fg={stateColor} attributes={TextAttributes.BOLD}>{offline ? '○ ' : online ? '● ' : '◌ '}</span>
          <span fg="cyan" attributes={TextAttributes.BOLD}>{'◆ HAKSTER-AI'}</span>
          <span fg={stateColor}>{` · ${stateTxt}`}</span>
          {showGuardHere ? <span fg={guardBad ? 'red' : 'green'}>{`   ${guardTxt}`}</span> : null}
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
            <Cell key={c.key} label={c.label} value={c.value} w={cellW} color={c.color} dense={dense} />
          ))}
        </box>
      ))}
    </box>
  );
}
