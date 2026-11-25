import React from 'react';
import { barColor } from '../../../smartness.mjs';

/* Recap — the run's receipt, on the row the live spinner vacates.
 *
 * Owner, 2026-11-24: "add recap in cli when agent is idle". While a run is
 * going, CrushStatus owns this row and animates the phase. The moment the run
 * ends there is nothing on that row, and the operator is left to reconstruct
 * what happened from the transcript. This replaces that gap with one line of
 * facts: how many turns, how many tool calls and how they scored, how much web
 * work, how long the run took, what it cost the context in tokens, and whether
 * the run failed.
 *
 * Every number is a count of something that actually happened — the same
 * `usage` derivation the ◔ Usage panel and the ◈ meters row already show, plus
 * the hook's own token reports. Nothing here is estimated, and a token total
 * that was never reported by the server is omitted rather than printed as a
 * zero the session cannot stand behind (§10).
 *
 * One row, always (the owner's panel rule): segments are fitted by character
 * count — the richest set that provably fits the column — so a narrow terminal
 * loses the least important facts instead of wrapping onto a second line and
 * taking a row from the transcript. Glyphs stay inside DejaVu Sans Mono
 * (▣ · — no colour emoji, see __tests__/glyphs.test.mjs).
 */

/** 1234 -> '1.2K', 12345678 -> '12.3M'. Never invents a figure. */
function fmtCount(n) {
  const v = Math.max(0, Number(n) || 0);
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e4) return `${Math.round(v / 1e3)}K`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(Math.round(v));
}

/** Millisecond duration as '4.2s' / '38s' / '1m42s'. Null when not worth a row. */
function fmtElapsed(ms) {
  const s = Math.max(0, Number(ms) || 0) / 1000;
  if (!Number.isFinite(s) || s < 1) return null;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  const m = Math.floor(s / 60);
  return `${m}m${String(Math.round(s % 60)).padStart(2, '0')}s`;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many || `${one}s`}`;

export default function Recap({
  width,
  recapId = '',
  points = 0,
  learned = 0,
  learnedSkills = 0,
  memWritten = 0,
  turns = 0,
  tools = 0,
  ok = 0,
  fail = 0,
  web = 0,
  requests = 0,
  elapsedMs = 0,
  inTok = 0,
  outTok = 0,
  tokensKnown = false,
  ctxPct = null,
  failed = false,
  todosDone = 0,
  todosTotal = 0,
}) {
  const t = Math.max(0, Number(turns) || 0);
  const tc = Math.max(0, Number(tools) || 0);
  const bad = Math.max(0, Number(fail) || 0);
  const good = Math.max(0, Number(ok) || 0);
  const w = Math.max(0, Number(web) || 0);
  const req = Math.max(0, Number(requests) || 0);

  // Richest first; the fit pass below drops from the tail, so the least
  // important facts go first on a narrow column.
  const segs = [
    { key: 'label', fg: failed ? 'red' : '#3fb950', text: failed ? '▣ recap · run failed' : '▣ recap' },
  ];
  // The recap's own id, second so it survives the fit pass (owner, 2026-11-25:
  // "each recap will have id # to go stright to for issues in mem"). It is the
  // same id the run's lessons and mistakes were written under, so `/recap #id`
  // lands on exactly this run.
  const rid = String(recapId || '').trim();
  if (rid) segs.push({ key: 'id', fg: '#58a6ff', text: rid });
  // What was learned and from what: the server's consolidated-memory count for
  // the session, against the outcomes it learned from.
  const lrn = Math.max(0, Number(learned) || 0);
  if (lrn > 0) {
    // "learned N from what" — the errors it hit are the source that matters, so
    // they lead when there were any; a clean run learned from the calls that
    // worked. The tools segment below already carries the ok/fail split, so
    // this one never repeats the full pair.
    const from = bad > 0 ? plural(bad, 'error') : `${good} ok`;
    const skills = Math.max(0, Number(learnedSkills) || 0);
    segs.push({ key: 'learned', fg: '#3fb950', text: `learned ${lrn} from ${from}${skills ? ` · ${skills} skill${skills === 1 ? '' : 's'}` : ''}` });
  }
  const pts = Math.max(0, Math.round(Number(points) || 0));
  if (pts > 0) segs.push({ key: 'points', fg: barColor('points', pts), text: `✦ ${pts}p` });
  // What this run actually wrote into memory — the server's accepted-entry
  // count, so "logged to his mem" is a fact on the row, not a promise.
  const memN = Math.max(0, Number(memWritten) || 0);
  if (memN > 0) segs.push({ key: 'mem', fg: '#58a6ff', text: `mem +${memN}` });
  if (t > 0) segs.push({ key: 'turns', fg: 'gray', text: plural(t, 'turn') });
  if (tc > 0) {
    const tail = bad > 0 ? ` (${good} ok · ${bad} fail)` : good > 0 ? ` (${good} ok)` : '';
    segs.push({ key: 'tools', fg: bad > 0 ? 'yellow' : 'gray', text: `${plural(tc, 'tool')}${tail}` });
  }
  if (w > 0) segs.push({ key: 'web', fg: 'gray', text: `${w} web` });
  if (req > t) segs.push({ key: 'reqs', fg: 'gray', text: `${req} req` });
  const el = fmtElapsed(elapsedMs);
  if (el) segs.push({ key: 'elapsed', fg: 'gray', text: el });
  if (tokensKnown) segs.push({ key: 'tokens', fg: 'gray', text: `${fmtCount(inTok)} in / ${fmtCount(outTok)} out` });
  const pct = Number(ctxPct);
  if (ctxPct !== null && ctxPct !== undefined && Number.isFinite(pct)) {
    segs.push({ key: 'ctx', fg: 'gray', text: `ctx ${Math.max(0, Math.min(100, Math.round(pct)))}%` });
  }
  const td = Math.max(0, Number(todosDone) || 0);
  const tt = Math.max(0, Number(todosTotal) || 0);
  if (tt > 0) segs.push({ key: 'todos', fg: td >= tt ? '#3fb950' : 'gray', text: `${td}/${tt} todos` });

  // Same fit rule as the status bar: longest prefix that provably fits, then a
  // clip if even one segment is too wide. The row can never wrap.
  const barW = Math.max(12, Number(width) || 80);
  const avail = Math.max(8, barW - 2);
  const joinedLen = (list) => list.reduce((n, one, i) => n + one.text.length + (i ? 3 : 0), 0);
  const shown = segs.slice();
  while (shown.length > 1 && joinedLen(shown) > avail) shown.pop();
  if (shown.length === 1 && shown[0].text.length > avail) {
    shown[0] = { ...shown[0], text: `${shown[0].text.slice(0, Math.max(0, avail - 1))}…` };
  }

  return (
    <box style={{ width: barW, flexDirection: 'row', paddingLeft: 1, overflow: 'hidden', flexShrink: 0 }}>
      <text>
        {shown.map((seg, i) => (
          <span key={seg.key} fg={seg.fg}>{`${i ? ' · ' : ''}${seg.text}`}</span>
        ))}
      </text>
    </box>
  );
}
