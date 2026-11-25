import React from 'react';
import { Panel, ScrollRow, clip } from './LiveSidebar.jsx';
import LiveImageViewer from './LiveImageViewer.jsx';
import { overflows } from '../utils/panel-scroll.js';
import { usePanelScroll } from '../hooks/usePanelScroll.js';
import durSuffix from '../utils/duration.js';

/* LiveOutputPanel — the run's RESULT, pinned at the bottom of the transcript
 * column so it can be read without looking away from the composer.
 *
 * Owner, 2026-11-23: "need the output showing in panel at the bottom over
 * thinking phrase and input bar so i can see it". The sidebar keeps its own
 * ▶ Output panel for wide terminals; this is the same data, placed where the
 * eye already is while typing.
 *
 * Owner, 2026-11-23 (the two boxes): "top one needs to be reasoning and bot
 * the final result output". The transcript above is the reasoning/history;
 * this box is what the run is producing.
 *
 * Owner, 2026-11-24: "the output dosent reach panels until results are in …
 * live panels rendering in place live". So while a run streams this box is
 * LIVE, not a result: the answer as it is written, updating in place, newest
 * line at the bottom — fed by `liveLines`, which carries the prose ONLY.
 *
 * Owner, 2026-11-24 (the duplication): "its suppose to have agents reasoning
 * output thinking etc and final word in results … shouldnt say same in both
 * grids". The reasoning is the thinking area's job (it streams into the
 * transcript above); this box is the final word. It never repeats reasoning —
 * while the answer has not started it says what the run is doing, then fills
 * with the answer. Its height is a fixed budget whether or not a turn is
 * running, so the box never moves the panels above it; only its contents
 * update. It stays on the finished answer (and the ▶ Result title) when the
 * run ends.
 *
 * It follows the newest line while a run streams (offset null = follow) and
 * carries the house ▲/█/▼ scrollbar when it overflows; a parked window comes
 * back to the tail by itself as new lines land (`autoResume`).
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
  phase = '',
  // Who is answering, and how long he took. Owner, 2026-11-26: "add on hakster
  // output card to HAKSTER-AI AND HIS TIME HE TOOK TO RESPOND ON CARD" — the
  // card above the input bar now names HAKSTER-AI and prints the turn's own
  // measured duration beside it (`ms` is the run clock: 0 before a turn, the
  // finished turn's total after it — see useAgentStream's stamp). No reading,
  // no suffix: a card with nothing measured says nothing (§10).
  name = 'HAKSTER-AI',
  ms = null,
}) {
  const w = Math.max(20, Number(width) || 80);
  const inner = Math.max(1, w - 4);
  const r = Math.max(1, Math.trunc(Number(rows) || 1));
  const list = Array.isArray(lines) ? lines : [];
  // Same threshold App.jsx budgets the extra call row with.
  const callRow = w >= 44;
  const compact = !callRow;
  const state = usePanelScroll({ total: list.length, rows: r, bindings, enabled: r > 0, autoResume: busy });
  const gutterOn = overflows(list.length, r);
  const bodyW = Math.max(1, inner - (gutterOn ? 1 : 0));
  // The box no longer repeats the phase in its title (owner, 2026-11-24: "all
  // those lines that are dupes can be more room for our panels"): the spinner
  // row under the composer already names the phase, and the title itself
  // already says ▶ Live. The body keeps the one line that is not said
  // anywhere else — what this box is waiting for.
  // While the answer has not started, the box says what the run is doing so a
  // still box does not read as a stalled agent. It names the phase — it never
  // copies the reasoning down here (owner, 2026-11-24: the two grids must not
  // say the same thing).
  const emptyHint = phase === 'thinking'
    ? 'reasoning above — the answer lands here'
    : phase === 'running'
      ? 'tool running…'
      : 'waiting for the first token…';
  const hint = image
    ? `image${call && compact ? ` · ${clip(call, Math.max(6, inner - 12))}` : ''}`
    : list.length
      ? `${state.hint('')}${call && compact ? ` · ${clip(call, Math.max(6, inner - 12))}` : ''}`
      : busy ? '' : 'last';

  return (
    <Panel width={w} title={`${busy ? '▶ Live' : '▶ Result'} · ${name}${durSuffix(ms)}`} hint={hint}>
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
            <text fg="gray">{busy ? clip(emptyHint, inner) : ' '}</text>
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
