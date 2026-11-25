import React, { useEffect, useRef, useState } from 'react';
import {
  PHRASE_MS,
  RESUME_MS,
  heatColor,
  heatOf,
  heatWord,
  isResume,
  phraseFor,
} from '../utils/spin-phrases.js';

/* How often the run's own glyphs change. Every tick is a full-screen repaint
 * (see the effect's comment), so this is a cost knob, not a taste knob. */
const SPINNER_MS = 300;

const FRAMES = ['❄', '✦', '✧', '✶', '✧', '✦'];const SHIMMER = ['❅', '❄', '✧', '❄', '❅'];
const GRADIENT = [51, 87, 117, 153, 117, 87];
/* Phase identity (colour + glyph) lives here; the WORDING lives in
 * utils/spin-phrases.js so it can be tested without a terminal. */
const PHASES = {
  THINK: { color: '#58a6ff', emoji: '◈' },
  PLAN: { color: '#c084fc', emoji: '≡' },
  ACT: { color: '#3fb950', emoji: '⚡' },
  OBSERVE: { color: '#39c5cf', emoji: '◉' },
  REFLECT: { color: '#d29922', emoji: '⊙' },
  CONSOLIDATE: { color: '#ffd700', emoji: '▣' },
  DEFAULT: { color: '#58a6ff', emoji: '◇' },
};

function formatElapsed(ms) {
  const seconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
}

/** Keep one row on one line: the phrase gives way, never the clock or queue. */
function clip(text, max) {
  const s = String(text || '');
  if (max <= 1) return '';
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
}

export default function CrushStatus({
  width,
  phase,
  activity,
  tool = null,
  elapsedMs,
  queued = 0,
  progressAt = 0,
  trend = 'steady',
}) {
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

  // ── Stuck and resumed, from real clocks ───────────────────────────────────
  // `progressAt` is the timestamp of the last event the run delivered (the hook
  // updates it on every delta, phase, tool start and tool result). With no event
  // for STUCK_MS the row stops describing the phase and says what to do next —
  // HakTerm's own 12 s no-progress guard (owner: "when agent is stuck to know
  // when to stop and use tools"). Before any event arrives the run's own
  // elapsed time stands in, so the row still knows it has been quiet.
  const now = Date.now();
  const sinceProgress = progressAt ? now - Number(progressAt) : Number(elapsedMs || 0);
  const stalledMs = Math.max(0, sinceProgress);

  // Resuming after doing: a THINK that follows ACT/OBSERVE/REFLECT is the agent
  // back on the task, not a fresh start (HakTerm: "Back on task · continuing the
  // checklist"). Held for RESUME_MS, then the phase's own phrases take over.
  const prevPhaseRef = useRef(normalizedPhase);
  const resumeUntilRef = useRef(0);
  useEffect(() => {
    const prev = prevPhaseRef.current;
    if (prev !== normalizedPhase) {
      if (isResume(prev, normalizedPhase)) resumeUntilRef.current = Date.now() + RESUME_MS;
      prevPhaseRef.current = normalizedPhase;
    }
  }, [normalizedPhase]);
  const resumed = Date.now() < resumeUntilRef.current;

  // Phrase rotation is timed, not frame-counted: one phrase every PHRASE_MS no
  // matter what the paint interval is set to.
  const phraseIndex = Math.floor(now / PHRASE_MS);
  const phrase = phraseFor({
    phase: normalizedPhase,
    tool: tool && (tool.name || tool.tool_name) ? tool : null,
    activity,
    index: phraseIndex,
    resumed,
    stalledMs,
  });

  // The heat reading is the meter's measured trend plus this stall clock — the
  // same numbers the ◈ memory bar reads, so the run row and the header agree.
  const heat = heatOf({ trend, stalledMs });
  const tint = heatColor(heat);

  const shimmer = [0, 1, 2].map((offset) => SHIMMER[(frame + offset) % SHIMMER.length]).join('');
  // What is left for the phrase after the fixed parts of the row (spinner 3,
  // phase label + glyph, the heat word, the shimmer, the clock, a little air).
  const room = Math.max(8, Number(width || 80) - 44);
  const shown = clip(phrase.text, room);

  return (
    <box style={{ width, flexDirection: 'row', paddingLeft: 1, overflow: 'hidden', flexShrink: 0 }}>
      <text>
        <span fg={gradColor}>⟦</span>
        <span fg={color}>{FRAMES[frame % FRAMES.length]}</span>
        <span fg={gradColor}>⟧</span>
        {' '}
        <span>{info.emoji}</span>
        {' '}
        <span fg={info.color}>{normalizedPhase}</span>
        {' '}
        {/* Warm/cool, from the measured trend and the stall clock. */}
        <span fg={tint}>{heatWord(heat)}</span>
        {' · '}
        <span fg={phrase.kind === 'stuck' ? '#f85149' : phrase.kind === 'tool' ? '#3fb950' : '#a5b4c3'}>
          {shown}
        </span>
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
