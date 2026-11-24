import React, { useEffect, useState } from 'react';

/* How often the run's own glyphs change. Every tick is a full-screen repaint
 * (see the effect's comment), so this is a cost knob, not a taste knob. */
const SPINNER_MS = 300;

const FRAMES = ['❄', '✦', '✧', '✶', '✧', '✦'];const SHIMMER = ['❅', '❄', '✧', '❄', '❅'];
const GRADIENT = [51, 87, 117, 153, 117, 87];
const PHASES = {
  THINK: { color: '#58a6ff', emoji: '◈', phrases: ['Thinking through the problem…', 'Reasoning carefully…', 'Analyzing the request…', 'Connecting concepts…'] },
  PLAN: { color: '#c084fc', emoji: '≡', phrases: ['Formulating a plan…', 'Mapping out steps…', 'Structuring the approach…'] },
  ACT: { color: '#3fb950', emoji: '⚡', phrases: ['Executing command…', 'Running tool…', 'Taking action…'] },
  OBSERVE: { color: '#39c5cf', emoji: '◉', phrases: ['Observing output…', 'Reading results…', 'Checking response…'] },
  REFLECT: { color: '#d29922', emoji: '⊙', phrases: ['Assessing the outcome…', 'Learning from this step…'] },
  CONSOLIDATE: { color: '#ffd700', emoji: '▣', phrases: ['Consolidating findings…', 'Compiling the answer…', 'Putting it all together…'] },
  DEFAULT: { color: '#58a6ff', emoji: '◇', phrases: ['Working on it…', 'Processing…', 'Hold tight…'] },
};

function formatElapsed(ms) {
  const seconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
}

export default function CrushStatus({ width, phase, activity, elapsedMs, queued = 0 }) {
  const [frame, setFrame] = useState(0);
  // One commit here repaints the WHOLE screen: OpenTUI lays the frame out as a
  // unit, so this row's glyphs are priced at the transcript's size. At 80 ms a
  // live run on a long scrollback cost a full core — 12 repaints a second for a
  // decoration (owner, 2026-11-24: "bash tools making cli lagg"). 300 ms still
  // reads as animated and costs a quarter of that. The row is only mounted
  // while a run is live, so an idle TUI never ticks at all.
  useEffect(() => {
    const timer = setInterval(() => setFrame((value) => value + 1), SPINNER_MS);
    return () => clearInterval(timer);
  }, []);

  const normalizedPhase = String(phase || 'DEFAULT').toUpperCase();
  const info = PHASES[normalizedPhase] || PHASES.DEFAULT;
  const color = Number(elapsedMs || 0) < 5000 ? '#3fb950' : Number(elapsedMs || 0) < 15000 ? '#d29922' : '#f85149';
  const grad = GRADIENT[frame % GRADIENT.length];
  const gradColor = `rgb(${grad},${Math.floor(grad * 0.7)},${Math.floor(grad * 1.2)})`;
  const phrase = activity || info.phrases[Math.floor(frame / 20) % info.phrases.length];
  const shimmer = [0, 1, 2].map((offset) => SHIMMER[(frame + offset) % SHIMMER.length]).join('');

  return (
    <box style={{ width, flexDirection: 'row', paddingLeft: 1, overflow: 'hidden' }}>
      <text>
        <span fg={gradColor}>⟦</span>
        <span fg={color}>{FRAMES[frame % FRAMES.length]}</span>
        <span fg={gradColor}>⟧</span>
        {' '}
        <span>{info.emoji}</span>
        {' '}
        <span fg={info.color}>{normalizedPhase}</span>
        {' '}
        <span fg="#a5b4c3">{phrase}</span>
        {' '}
        <span fg={gradColor}>{shimmer}</span>
        {' '}
        <span fg="gray">{formatElapsed(elapsedMs)}</span>
        {/* The steer queue is part of the run's state, so it is stated on the
            run's own line — a queued message is never invisible. */}
        {Number(queued) > 0 ? (
          <span fg="#d29922">{`  ◌ ${Number(queued)} queued`}</span>
        ) : null}
      </text>
    </box>
  );
}
