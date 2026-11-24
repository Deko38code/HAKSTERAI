import React from 'react';
import { TextAttributes } from '@opentui/core';

/* StatusBar — the one pinned row at the foot of the TUI.
 *
 * Freebuff reads this line out of a zustand store; here every value is a plain
 * prop, because the status bar is the single row that must never reflow or
 * throw. Deciding what is true belongs to the caller; deciding how it reads
 * belongs here. The switch below is deliberately exhaustive so a session state
 * this bar does not know about renders as itself rather than as blank — a bar
 * that silently drops a state is worse than one that shows an ugly label.
 *
 * PORTED FROM: CodebuffAI/freebuff `cli/src/components/status-bar.tsx`
 * (Apache-2.0). See cli/src/ads/ATTRIBUTION.md for how this repo handles
 * derived files. Changes: OpenTUI (<box>/<text>/<span>/TextAttributes) used
 * directly, and the Freebuff-only inputs (theme, session progress, freebucks,
 * BYOK, scroll-to-bottom, end-session, the Ctrl-C and reconnect states)
 * dropped as this harness has no equivalents.
 */
const STATUS_STYLES = {
  idle: { text: 'ready', color: 'gray' },
  connecting: { text: "can't reach server…", color: 'yellow' },
  thinking: { text: 'thinking…', color: 'yellow' },
  streaming: { text: 'working…', color: 'cyan' },
  // The run is parked on a decision the operator has to make. Naming it here
  // matters: the composer is disabled and otherwise nothing on this bar would
  // explain why the session has gone quiet.
  approval: { text: 'needs approval', color: 'yellow' },
  error: { text: 'error', color: 'red' },
};

/** Elapsed milliseconds as seconds with one decimal, e.g. 4200 -> '4.2s'. */
function formatElapsed(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return null;
  return `${(n / 1000).toFixed(1)}s`;
}

export default function StatusBar({ width, status, model, cols, focus, adsOn, elapsedMs, hint, handoff, autoMode }) {
  const known = status ? STATUS_STYLES[status] : null;
  // An unrecognised but truthy status is shown verbatim and dim, so a new state
  // is visible the moment it appears instead of vanishing.
  const label = known ? known.text : status ? String(status) : '';

  // The timer only runs while the agent is actually doing something; a frozen
  // "0.0s" next to "ready" would read as a stalled request.
  const elapsed =
    status === 'streaming' || status === 'thinking' || status === 'approval'
      ? formatElapsed(elapsedMs)
      : null;

  // One row, always (the owner's panel rule). The bar used to be two flex rows
  // of text nodes with no clip: below ~110 columns the right-hand list was
  // wider than the space left of it, the bar wrapped onto a second line, and
  // that second line was taken from the spinner under the composer. Segments
  // are now fitted by character count — the longest set that provably fits —
  // so the status bar can never reflow.
  const segs = [];
  if (label) segs.push({ key: 'status', color: known ? known.color : 'gray', text: label });
  if (elapsed) segs.push({ key: 'elapsed', color: 'gray', text: elapsed });
  if (model) segs.push({ key: 'model', color: 'yellow', text: model });
  // The owner's switch, always visible: green means a failed run will move on
  // to the next ladder model, red means it will stay where it failed.
  if (handoff !== undefined && handoff !== null) {
    segs.push({ key: 'handoff', color: handoff ? 'green' : 'red', text: handoff ? 'handoff auto' : 'handoff off' });
  }
  // How much the agent does without asking (/auto). Green = it works and
  // finishes on its own, yellow = it will never stop to ask, gray = it asks.
  if (autoMode) {
    segs.push({
      key: 'auto',
      color: autoMode === 'full-auto' ? 'yellow' : autoMode === 'suggest' ? 'gray' : 'green',
      text: autoMode === 'full-auto' ? 'auto full' : autoMode === 'suggest' ? 'auto ask' : 'auto edit',
    });
  }
  if (cols !== undefined && cols !== null) segs.push({ key: 'cols', color: 'gray', text: `${cols}c` });
  segs.push({ key: 'ads', color: adsOn ? 'green' : 'red', text: adsOn ? 'ads on' : 'ads off' });

  const leftText = focus === 'ad' ? '\u27ea ad \u27eb' : '\u27ea composer \u27eb';
  const hintText = hint ? `  ${hint}` : '';
  const barW = Math.max(20, Number(width) || 80);
  // paddingLeft/Right (2) + two spaces that keep the halves apart.
  const avail = Math.max(8, barW - 2 - leftText.length - hintText.length - 2);
  const joinedLen = (list) => list.reduce((n, one, i) => n + one.text.length + (i ? 3 : 0), 0);
  const shown = segs.slice();
  while (shown.length > 1 && joinedLen(shown) > avail) shown.pop();
  // A single segment still too wide (a long model id on a narrow screen) is
  // clipped rather than allowed to wrap the bar.
  if (shown.length === 1 && shown[0].text.length > avail) {
    shown[0] = { ...shown[0], text: `${shown[0].text.slice(0, Math.max(0, avail - 1))}\u2026` };
  }

  return (
    <box style={{ width: barW, flexDirection: 'row', justifyContent: 'space-between', paddingLeft: 1, paddingRight: 1, overflow: 'hidden', flexShrink: 0 }}>
      <text fg="gray">{`${leftText}${hintText}`}</text>
      <text>
        {shown.map((seg, i) => (
          <span key={seg.key} fg={seg.color}>{`${i ? ' \u00b7 ' : ''}${seg.text}`}</span>
        ))}
      </text>
    </box>
  );
}
