import React, { useMemo } from 'react';
import { TextAttributes } from '@opentui/core';
import { BrandLine } from './HeroLogo.jsx';
import ScrollPanel from './ScrollPanel.jsx';
import { diffLines, lastSnapshot, linesOf } from '../utils/scripts.js';

/* ScriptsView — our live scripts, run live, compared against what we ran.
 *
 * Owner, 2026-11-23: "make a side panel for our live scripts to show and run
 * live to compare code when need to ours use omp snapshot to render the window
 * live panel for live code comparisons".
 *
 * The layout is the OMP snapshot's shape: one framed window, a green title bar,
 * and the pane(s) filling it edge to edge. Two panes when there is width for
 * them —
 *
 *   OURS  the script's source, marked + or - for what changed since its last
 *         run (diffLines against the snapshot taken before that run);
 *   LIVE  its stdout/stderr as it streams.
 *
 * On a narrow terminal the panes stack to one: the live output, with the
 * changed-line count carried in the title. Every window is a ScrollPanel, so
 * it has the house autoscroll and ▲/█/▼ bars and can never push the status bar
 * off the screen.
 *
 * Nothing here invents state: a script that has not run says "not run yet", a
 * runner says its real status, and the exit code is the child's own.
 */
const STATUS_COLOR = {
  idle: 'gray',
  running: 'yellow',
  done: 'green',
  failed: 'red',
  stopped: 'yellow',
};

const clipLine = (s, n) => {
  const t = String(s == null ? '' : s);
  return t.length <= n ? t : `${t.slice(0, Math.max(0, n - 1))}…`;
};

const statusText = (run) => {
  switch (run.status) {
    case 'running': return `running${run.script ? ` · ${Math.max(0, Math.round((Date.now() - run.startedAt) / 1000))}s` : ''}`;
    case 'done': return `done · exit ${run.exit ?? 0}`;
    case 'failed': return `failed · exit ${run.exit == null ? '?' : run.exit}`;
    case 'stopped': return 'stopped';
    default: return 'not run yet';
  }
};

export default function ScriptsView({
  width = 80,
  height = 20,
  scripts = [],
  selected = 0,
  run = { status: 'idle', lines: [], script: null },
  onSelect,
  onRun,
}) {
  const w = Math.max(24, Number(width) || 80);
  const h = Math.max(8, Number(height) || 20);
  const chosen = scripts[Math.min(selected, Math.max(0, scripts.length - 1))] || null;

  // Row budget: the script list (title + rows + border), the snapshot title,
  // then the panes get everything else. Nothing may exceed `h`.
  const listRows = Math.min(6, Math.max(1, scripts.length || 1));
  const listPanelRows = listRows + 3; // border 2 + title 1
  // -2: the brand line and the snapshot title each take a row.
  const snapshotRows = Math.max(5, h - listPanelRows - 2);
  const paneRows = Math.max(2, snapshotRows - 3); // pane panels: border 2 + title 1

  const src = useMemo(() => (chosen ? linesOf(chosen) : []), [chosen]);
  const prev = chosen ? lastSnapshot(chosen) : null;
  const diff = useMemo(() => diffLines(prev, src), [prev, src]);
  const changed = diff.filter((d) => d.mark).length;

  // The diff view is the source with its marks; the tail is what matters, so
  // the pane follows it like the live output does.
  const diffRows = diff.map((d) => `${d.mark === '+' ? '+' : d.mark === '-' ? '-' : ' '} ${d.text}`);
  const lines = Array.isArray(run.lines) ? run.lines : [];
  const wide = w >= 100;
  const halfW = Math.floor((w - 2) / 2);

  return (
    <box style={{ width: w, height: h, flexDirection: 'column', overflow: 'hidden', flexShrink: 0 }}>
      <BrandLine width={w} subtitle="live scripts" />
      <ScrollPanel
        width={w}
        title={`⌘ Live scripts · ${scripts.length}`}
        hint="↑↓ select · enter run · esc back"
        total={scripts.length}
        rows={listRows}
        selected={Math.min(selected, Math.max(0, scripts.length - 1))}
        initial="top"
        empty="no scripts found in this checkout"
      >
        {(index, { width: rowW, compact }) => {
          const s = scripts[index];
          if (!s) return null;
          const active = index === selected;
          const isRunning = run.status === 'running' && run.script && run.script.id === s.id;
          const tag = compact ? '' : `${s.tag} `;
          return (
            <box style={{ width: rowW, flexDirection: 'row', flexShrink: 0 }}>
              <text fg={active ? 'yellow' : 'gray'} attributes={active ? TextAttributes.BOLD : 0}>
                {`${active ? '▸ ' : '  '}${clipLine(`${tag}${s.label}`, Math.max(8, rowW - 12))}`}
              </text>
              {isRunning ? <text fg="yellow">{' ● running'}</text> : null}
            </box>
          );
        }}
      </ScrollPanel>

      {/* OMP snapshot: the window's own title bar, then the panes. */}
      <box style={{ width: w, height: 1, flexShrink: 0, flexDirection: 'row' }}>
        <text fg="#00ff41" attributes={TextAttributes.BOLD}>{clipLine(`◆ OMP SNAPSHOT · ${chosen ? chosen.label : '—'}`, Math.max(8, w - 24))}</text>
        <text fg="gray">{`  ${changed ? `${changed} changed` : 'source'} · ours vs live`}</text>
      </box>

      {wide ? (
        <box style={{ width: w, flexDirection: 'row', flexShrink: 0 }}>
          <ScrollPanel
            width={halfW}
            title="OURS"
            hint={changed ? `${changed} changed since last run` : 'source'}
            total={diffRows.length}
            rows={paneRows}
            borderColor="#00ff41"
            initial="follow"
          >
            {(index, { width: rowW }) => {
              const mark = diff[index]?.mark || '';
              return (
                <box style={{ width: rowW }}>
                  <text fg={mark === '+' ? 'green' : mark === '-' ? 'red' : 'gray'}>
                    {clipLine(diffRows[index] || ' ', rowW)}
                  </text>
                </box>
              );
            }}
          </ScrollPanel>
          <ScrollPanel
            width={w - halfW}
            title="LIVE"
            hint={statusText(run)}
            total={lines.length}
            rows={paneRows}
            borderColor={STATUS_COLOR[run.status] || 'gray'}
            initial="follow"
            empty={run.status === 'running' ? 'waiting for output…' : 'not run yet — enter runs the selected script'}
          >
            {(index, { width: rowW }) => (
              <box style={{ width: rowW }}>
                <text fg={index === lines.length - 1 ? 'white' : 'gray'}>{clipLine(lines[index] || ' ', rowW)}</text>
              </box>
            )}
          </ScrollPanel>
        </box>
      ) : (
        <ScrollPanel
          width={w}
          title="LIVE"
          hint={statusText(run)}
          total={lines.length}
          rows={Math.max(2, snapshotRows - 3)}
          borderColor={STATUS_COLOR[run.status] || 'gray'}
          initial="follow"
          empty={run.status === 'running' ? 'waiting for output…' : 'not run yet — enter runs the selected script'}
        >
          {(index, { width: rowW }) => (
            <box style={{ width: rowW }}>
              <text fg={index === lines.length - 1 ? 'white' : 'gray'}>{clipLine(lines[index] || ' ', rowW)}</text>
            </box>
          )}
        </ScrollPanel>
      )}
    </box>
  );
}
