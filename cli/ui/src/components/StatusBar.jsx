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

  const right = [];
  if (label) {
    right.push(
      <text key="status" fg={known ? known.color : 'gray'}>
        {label}
      </text>,
    );
  }
  if (elapsed) {
    right.push(<text key="elapsed" fg="gray">{elapsed}</text>);
  }
  if (model) {
    right.push(<text key="model" fg="yellow">{model}</text>);
  }
  // The owner's switch, always visible: green means a failed run will move on
  // to the next ladder model, red means it will stay where it failed.
  if (handoff !== undefined && handoff !== null) {
    right.push(
      <text key="handoff" fg={handoff ? 'green' : 'red'}>
        {handoff ? 'handoff auto' : 'handoff off'}
      </text>,
    );
  }
  // How much the agent does without asking (/auto). Green = it works and
  // finishes on its own, yellow = it will never stop to ask, gray = it asks.
  if (autoMode) {
    right.push(
      <text
        key="auto"
        fg={autoMode === 'full-auto' ? 'yellow' : autoMode === 'suggest' ? 'gray' : 'green'}
      >
        {autoMode === 'full-auto' ? 'auto full' : autoMode === 'suggest' ? 'auto ask' : 'auto edit'}
      </text>,
    );
  }
  if (cols !== undefined && cols !== null) {
    right.push(<text key="cols" fg="gray">{`${cols}c`}</text>);
  }
  right.push(
    <text key="ads" fg={adsOn ? 'green' : 'red'}>
      {adsOn ? 'ads on' : 'ads off'}
    </text>,
  );

  // Separators are interleaved rather than baked into each label so a label
  // that is absent because its value is missing never leaves a dangling gap.
  const rightNodes = [];
  right.forEach((node, i) => {
    if (i > 0) {
      rightNodes.push(<text key={`sep-${i}`} fg="gray">{' · '}</text>);
    }
    rightNodes.push(node);
  });

  return (
    <box style={{ width, flexDirection: 'row', justifyContent: 'space-between', paddingLeft: 1, paddingRight: 1 }}>
      <box style={{ flexDirection: 'row' }}>
        {focus === 'ad' ? (
          <text fg="cyan" attributes={TextAttributes.BOLD}>{'⟪ ad ⟫'}</text>
        ) : (
          <text fg="gray">{'⟪ composer ⟫'}</text>
        )}
        {hint ? <text fg="gray">{`  ${hint}`}</text> : null}
      </box>
      <box style={{ flexDirection: 'row' }}>
        {rightNodes}
      </box>
    </box>
  );
}