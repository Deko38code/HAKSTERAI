import React from 'react';
import { barColor } from '../../../smartness.mjs';
import { fmtCount, fmtElapsed, plural } from './Recap.jsx';

/* RecapPanel — the FULL recap, idle, at the bottom of the chat column.
 *
 * Owner, 2026-11-26: "fix our recap to work like claude's does with fullrecap
 * while idle in bottom where our recap ids are".
 *
 * The one-row receipt (Recap.jsx) states the run in a single line and has to
 * drop the least important facts to fit. This is the other face of the same
 * row once the run is over and there is room to spare: a short block that says
 * what the run was, what it did, what it got wrong, and — the part the owner
 * asked for — the recap ids themselves, so a run can be reached from the panel
 * that summarises it (`/recap #id` reads it back out of memory).
 *
 * Every figure is a counted one (§10): the meter's own tool split, the server's
 * accepted memory-entry count, the hook's reported tokens. A number that was
 * never reported is omitted, never printed as a zero.
 *
 * Fitting: the terminal gives this panel a row budget and it never exceeds it.
 * Lines are chosen by priority — the id line outranks the counts — then drawn
 * in reading order, so a short screen loses the least useful line rather than
 * the ids. Each line is clipped to the column, so the block can never wrap and
 * take a row from the transcript.
 */

/** Clip a list of spans to `avail` characters, marking a cut with an ellipsis. */
function clipSpans(spans, avail) {
  let left = Math.max(0, avail);
  const out = [];
  for (const span of spans) {
    if (left <= 0) break;
    const text = String(span.text == null ? '' : span.text);
    if (text.length > left) {
      out.push({ ...span, text: `${text.slice(0, Math.max(0, left - 1))}…` });
      left = 0;
      break;
    }
    out.push({ ...span, text });
    left -= text.length;
  }
  return out;
}

export default function RecapPanel({
  width,
  lines = 6,
  recap = null,
  history = [],
  // Session facts, used when no single run is being described (a restored
  // transcript) and for the totals line under the run's own facts.
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
  points = 0,
  learned = 0,
  learnedSkills = 0,
  memWritten = 0,
}) {
  const barW = Math.max(12, Number(width) || 80);
  const avail = Math.max(8, barW - 2);
  const budget = Math.max(1, Math.min(8, Number(lines) || 6));

  const r = recap && typeof recap === 'object' ? recap : {};
  const rid = String(r.id || '').trim();
  const runFail = Math.max(0, Number(r.fail) || 0);
  const bad = runFail || Math.max(0, Number(fail) || 0);
  // A run is only "failed" when the run itself failed — the run's status, not
  // its tool-error count. A completed run that hit two bad commands still
  // completed, and the facts line already carries the 2 err.
  const isBad = Boolean(failed);
  // The duration belongs to the run it describes. With no finished run there is
  // no duration to print, so the header states session totals instead of
  // borrowing the last turn's clock (§10).
  const el = rid ? fmtElapsed(Number(r.ms) || Number(elapsedMs) || 0) : null;
  const outcome = rid ? (isBad ? 'run failed' : 'run complete') : 'session totals';

  // ── Line 1: what this panel is, its id, and how the run ended. ───────────
  const head = [
    { text: '▣ ', fg: isBad ? 'red' : '#3fb950' },
    { text: 'full recap', fg: isBad ? 'red' : '#3fb950' },
  ];
  if (rid) head.push({ text: ` ${rid}`, fg: '#58a6ff' });
  head.push({ text: ` · ${outcome}`, fg: isBad ? 'red' : 'gray' });
  if (el) head.push({ text: ` · ${el}`, fg: 'gray' });

  // ── The ids this session has recapped, newest first. The owner asked for
  // the full recap "where our recap ids are", so this is the last line on
  // screen and the second-highest priority when the column is short. ───────
  const idList = [];
  for (const one of Array.isArray(history) ? history : []) {
    const id = String((one && one.id) || '').trim();
    if (id && !idList.includes(id)) idList.push(id);
    if (idList.length >= 6) break;
  }
  if (rid && !idList.includes(rid)) idList.unshift(rid);
  // The header already prints this run's id, so the list is the OTHER runs —
  // the whole session's ids in one place without saying one of them twice.
  const others = idList.filter((id) => id !== rid);
  const idsSpans = others.length
    ? [
      { text: 'also ', fg: 'gray' },
      { text: others.join(' '), fg: '#58a6ff' },
      { text: ' · /recap #id reads it', fg: 'gray' },
    ]
    : [{ text: '/recap #id reads any finished run out of memory', fg: 'gray' }];

  // ── What the run was. ────────────────────────────────────────────────────
  const taskText = String(r.task || '').replace(/\s+/g, ' ').trim();
  const taskSpans = taskText
    ? [{ text: `"${taskText}"`, fg: 'white' }]
    : [{ text: 'this session', fg: 'gray' }];

  // ── What it did, counted. ────────────────────────────────────────────────
  const tc = Math.max(0, Number(r.tools) || 0);
  const gd = Math.max(0, Number(r.ok) || 0);
  const lrn = Math.max(0, Number(r.learned) || 0);
  const skills = Math.max(0, Number(r.learnedSkills) || 0);
  const pts = Math.max(0, Math.round(Number(r.points != null ? r.points : points) || 0));
  const memN = Math.max(0, Number(r.memWritten != null ? r.memWritten : memWritten) || 0);
  const facts = [];
  if (tc > 0) facts.push({ text: plural(tc, 'tool'), fg: bad > 0 ? 'yellow' : 'white' });
  if (tc > 0 && (gd > 0 || bad > 0)) {
    facts.push({ text: `${gd} ok`, fg: '#3fb950' });
    if (bad > 0) facts.push({ text: `${bad} err`, fg: 'red' });
  }
  if (lrn > 0) {
    const from = bad > 0 ? plural(bad, 'error') : `${gd} ok`;
    facts.push({ text: `learned ${lrn} from ${from}${skills ? ` · ${plural(skills, 'skill')}` : ''}`, fg: '#3fb950' });
  }
  if (pts > 0) facts.push({ text: `✦ ${pts}p`, fg: barColor('points', pts) });
  if (memN > 0) facts.push({ text: `mem +${memN}`, fg: '#58a6ff' });
  const factSpans = [];
  for (const one of facts) {
    if (factSpans.length) factSpans.push({ text: ' · ', fg: 'gray' });
    factSpans.push(one);
  }
  if (!factSpans.length) factSpans.push({ text: 'no tool calls in this run', fg: 'gray' });

  // ── The mistakes, one line each — the reason an id is worth having. ──────
  const mistakeLines = [];
  for (const f of (Array.isArray(r.failures) ? r.failures : []).slice(0, 2)) {
    const tool = String((f && f.tool) || 'tool');
    const error = String((f && f.error) || f || '').replace(/\s+/g, ' ').trim();
    if (!error) continue;
    mistakeLines.push([
      { text: '✗ ', fg: 'red' },
      { text: `${tool}: `, fg: 'yellow' },
      { text: error, fg: 'gray' },
    ]);
  }

  // ── The session totals, under the run's own facts. ───────────────────────
  const t = Math.max(0, Number(turns) || 0);
  const sess = [];
  if (t > 0) sess.push({ text: plural(t, 'turn'), fg: 'gray' });
  if (tokensKnown) sess.push({ text: `${fmtCount(inTok)} in / ${fmtCount(outTok)} out`, fg: 'gray' });
  const pct = Number(ctxPct);
  if (ctxPct !== null && ctxPct !== undefined && Number.isFinite(pct)) {
    sess.push({ text: `ctx ${Math.max(0, Math.min(100, Math.round(pct)))}%`, fg: 'gray' });
  }
  const tt = Math.max(0, Number(todosTotal) || 0);
  if (tt > 0) {
    sess.push({ text: `${Math.max(0, Number(todosDone) || 0)}/${tt} todos`, fg: Math.max(0, Number(todosDone) || 0) >= tt ? '#3fb950' : 'gray' });
  }
  if (Math.max(0, Number(web) || 0) > 0) sess.push({ text: `${Math.max(0, Number(web) || 0)} web`, fg: 'gray' });
  if (Math.max(0, Number(requests) || 0) > t) sess.push({ text: `${Math.max(0, Number(requests) || 0)} req`, fg: 'gray' });
  const sessSpans = [];
  for (const one of sess) {
    if (sessSpans.length) sessSpans.push({ text: ' · ', fg: 'gray' });
    sessSpans.push(one);
  }
  if (!sessSpans.length) sessSpans.push({ text: 'session idle', fg: 'gray' });

  // ── Priority, then reading order. The id line outranks the counts because
  // it is the handle back into memory (owner, 2026-11-25: "each recap will
  // have id # to go stright to for issues in mem"). ───────────────────────
  const candidates = [
    { key: 'head', prio: 100, spans: head },
    { key: 'ids', prio: 95, spans: idsSpans },
    { key: 'task', prio: 80, spans: taskSpans },
    ...mistakeLines.map((spans, i) => ({ key: `miss${i}`, prio: 70 - i * 5, spans })),
    { key: 'facts', prio: 60, spans: factSpans },
    { key: 'sess', prio: 40, spans: sessSpans },
  ];
  const chosen = new Set(
    candidates.slice()
      .sort((a, b) => b.prio - a.prio)
      .slice(0, budget)
      .map((line) => line.key),
  );
  const shown = candidates.filter((line) => chosen.has(line.key));

  return (
    <box style={{ width: barW, flexDirection: 'column', paddingLeft: 1, overflow: 'hidden', flexShrink: 0 }}>
      {shown.map((line) => (
        <box key={line.key} style={{ width: Math.max(8, barW - 2), height: 1, overflow: 'hidden', flexShrink: 0 }}>
          <text>
            {clipSpans(line.spans, avail).map((span, i) => (
              <span key={i} fg={span.fg}>{span.text}</span>
            ))}
          </text>
        </box>
      ))}
    </box>
  );
}
