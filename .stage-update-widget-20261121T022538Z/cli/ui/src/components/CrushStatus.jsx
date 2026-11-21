import React, { useEffect, useState } from 'react';

const FRAMES = ['❄', '✦', '✧', '✶', '✧', '✦'];
const SHIMMER = ['❅', '❄', '✧', '❄', '❅'];
const GRADIENT = [51, 87, 117, 153, 117, 87];
const PHASES = {
  THINK: { color: '#58a6ff', emoji: '🧠', phrases: ['Thinking through the problem…', 'Reasoning carefully…', 'Analyzing the request…', 'Connecting concepts…'] },
  PLAN: { color: '#c084fc', emoji: '📋', phrases: ['Formulating a plan…', 'Mapping out steps…', 'Structuring the approach…'] },
  ACT: { color: '#3fb950', emoji: '⚡', phrases: ['Executing command…', 'Running tool…', 'Taking action…'] },
  OBSERVE: { color: '#39c5cf', emoji: '👁', phrases: ['Observing output…', 'Reading results…', 'Checking response…'] },
  REFLECT: { color: '#d29922', emoji: '🪞', phrases: ['Assessing the outcome…', 'Learning from this step…'] },
  CONSOLIDATE: { color: '#ffd700', emoji: '📦', phrases: ['Consolidating findings…', 'Compiling the answer…', 'Putting it all together…'] },
  DEFAULT: { color: '#58a6ff', emoji: '◇', phrases: ['Working on it…', 'Processing…', 'Hold tight…'] },
};

function formatElapsed(ms) {
  const seconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
}

export default function CrushStatus({ width, phase, activity, elapsedMs }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setFrame((value) => value + 1), 80);
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
      </text>
    </box>
  );
}
