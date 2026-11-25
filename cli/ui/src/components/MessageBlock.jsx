import React, { useEffect, useMemo, useState } from 'react';
import { TextAttributes } from '@opentui/core';
import { clip } from './LiveSidebar.jsx';
import {
  SC_TICK_MS,
  nextScrambleNonce,
  scReasonBox,
  waveColor,
  waveFrames,
  wavePlan,
  waveText,
} from '../utils/crush-scrambler.js';

/* A shell result is capped in the transcript. A 4 KB `npm run build` dump is
 * ~40 wrapped rows: at that size the turn's prose is shoved above the window
 * and the operator sees nothing but tool rows (owner, 2026-11-23: "its not
 * showing agents output what he says something only shell call tools i see").
 * The transcript shows the first few lines of each result; the whole tail
 * stays one panel lower in ▶ Output and in the sidebar.
 */
const RESULT_LINES = 3;

/* MessageBlock — one turn in the transcript, drawn as its own bordered box.
 *
 * Freebuff's transcript is a tree of block renderers; this harness only needs
 * three roles, so one component branches instead of many. What is worth
 * keeping from upstream is the shape of the information: reasoning is shown
 * separately from the answer and dimmed, and each tool call is a row of its own
 * with its result underneath — never merged into the prose, because a merged
 * block is what makes a transcript impossible to skim.
 *
 * The border colour is the only thing that distinguishes roles, which keeps a
 * long scrollback readable at a glance without spending rows on headers.
 */

const ROLE_STYLE = {
  user: { border: 'cyan', label: 'you' },
  assistant: { border: 'gray', label: 'hakster' },
  system: { border: 'yellow', label: 'system' },
};

const TONE_COLOR = { error: 'red', warn: 'yellow', notice: 'cyan' };

/** The newest non-empty line of a streamed field — what "keep up" means when
 *  a turn is too dense to show the whole reasoning block. */
const lastLine = (s) => String(s || '').replace(/\r/g, '').split('\n').filter((l) => l.trim()).pop() || '';

/* Reasoning is drawn the way OMP draws its thinking blocks (oh-my-pi
 * packages/tui/src/chat/assistant-message.ts): while it streams you read the
 * TAIL inside a fixed body, and once it stops it folds to one line — "Thought
 * for 12s" — which Ctrl+T reopens (owner, 2026-11-24: "i want the win"). The
 * fixed body is the point: a long thought used to push the whole transcript up
 * a row at a time while it was written. */
const LIVE_THINK_LINES = 4;
const LIVE_TEXT_LINES = 8;

/** A tail window over a streamed field: the last `n` non-blank lines, plus how
 *  many were dropped, so the cut is stated rather than silent. */
function tailWindow(value, n) {
  const lines = String(value == null ? '' : value).replace(/\r/g, '').split('\n').filter((l) => l.trim());
  return { lines: lines.slice(-n), hidden: Math.max(0, lines.length - n) };
}

/** "12s" — seconds, never a fake tenth. Sub-second thoughts read "1s". */
const thoughtFor = (ms) => `Thought for ${Math.max(1, Math.round((Number(ms) || 0) / 1000))}s`;

/** One reasoning block. Live while it is being written (spinner, elapsed, tail
 *  of the text); finished it is one line unless `expand` is on. */
/** One decode ticker. Stops itself once the wave has settled, so a finished
 *  block costs zero renders — the same rule the pending-card spinner follows. */
function useWaveClock(steps, key) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    setFrame(0);
    if (!steps) return undefined;
    const id = setInterval(() => {
      setFrame((f) => {
        if (f + 1 >= steps) {
          clearInterval(id);
          return steps;
        }
        return f + 1;
      });
    }, SC_TICK_MS);
    return () => clearInterval(id);
    // `key` restarts the wave when the text it was planned for changes.
  }, [steps, key]);
  return frame;
}

/** Reasoning drawn through the CrushTerminal decoder: the "Reasoning" box,
 *  scrambled, then wave-decoded band by band (10 visual lines at a time — the
 *  owner's number). Used for the reopened block; the live block decodes only
 *  its newest line, because the rest is still being written. */
function DecodedReasoning({ text, width }) {
  const columns = Math.max(24, Number(width) || 72);
  const plain = useMemo(() => scReasonBox(text, { columns }), [text, columns]);
  const nonce = useMemo(() => nextScrambleNonce(), [text, columns]);
  const plan = useMemo(() => wavePlan(plain.text, { columns, nonce }), [plain, columns, nonce]);
  const steps = waveFrames(plan);
  const frame = useWaveClock(steps, plan);
  const out = plan ? waveText(plan, frame) : { text: plain.text, done: true, progress: 1 };
  const color = out.done ? plain.color : waveColor(0, frame, out.progress);
  const lines = out.text.replace(/^\n/, '').replace(/\n$/, '').split('\n');
  return (
    <box style={{ flexDirection: 'column', width: columns, flexShrink: 0, overflow: 'hidden' }}>
      {lines.map((line, i) => (
        <text key={`rd-${i}`} fg={color}>{line}</text>
      ))}
    </box>
  );
}

function ThinkingBlock({ text, startedAt, endedAt, live, width, compact, expand, label = true }) {
  const frame = useSpinnerFrame(live);
  const started = Number(startedAt) || 0;
  const ended = Number(endedAt) || 0;
  // The newest reasoning line runs through the decoder while it is being
  // written: it stays scrambled and settles the moment the next line starts.
  // Earlier lines are already settled prose and are drawn plainly.
  const window = tailWindow(text, compact ? 1 : LIVE_THINK_LINES);
  const newest = window.lines.length ? window.lines[window.lines.length - 1] : '';
  const settled = window.lines.slice(0, -1);
  const newestPlan = useMemo(
    () => (live ? wavePlan(newest, { columns: Math.max(24, Number(width) || 72), nonce: nextScrambleNonce() }) : null),
    [live, newest, width],
  );
  const newestSteps = waveFrames(newestPlan);
  const newestFrame = useWaveClock(newestSteps, newestPlan);
  const newestWave = newestPlan ? waveText(newestPlan, newestFrame) : { text: newest, done: true, progress: 1 };
  if (live) {
    return (
      <box style={{ flexDirection: 'column', width, flexShrink: 0 }}>
        {/* The run's own spinner row under the composer already states the
            phase, the activity and the elapsed time. When that row is on
            screen (owner, 2026-11-24: "the live spinner phrase then theres 1
            under that not live just says what agents doing") this block keeps
            the reasoning text and drops the duplicate label + timer. */}
        {label ? (
          <text>
            <span fg="yellow">{`${SPINNER_FRAMES[frame]} `}</span>
            <span fg="gray">{`thinking…${started ? ` ${fmtDur(Date.now() - started)}` : ''}`}</span>
          </text>
        ) : null}
        {/* Not clipped: reasoning is prose and must keep its words; the count is
            what stays bounded while it streams. */}
        {settled.map((line, i) => (
          <text key={`th-${i}`} fg="gray">{line.trim()}</text>
        ))}
        {newest ? (
          <text fg={newestWave.done ? 'gray' : waveColor(0, newestFrame, newestWave.progress)}>
            {(newestWave.done ? newest : newestWave.text).trim()}
          </text>
        ) : null}
      </box>
    );
  }
  if (!expand) {
    const label = started && ended ? thoughtFor(ended - started) : lastLine(text);
    return <text fg="gray">{clip(`⋯ ${label}`, Math.max(4, width))}</text>;
  }
  return <DecodedReasoning text={text} width={width} />;
}

/** One prose block. Live it shows its tail inside the same bounded body; once
 *  the run ends the whole answer is drawn, exactly as it was written. */
function ProseBlock({ text, live, width, compact }) {
  if (!live) return <text fg="white">{String(text)}</text>;
  const window = tailWindow(text, compact ? 3 : LIVE_TEXT_LINES);
  return (
    <box style={{ flexDirection: 'column', width, flexShrink: 0 }}>
      {window.hidden ? (
        <text fg="gray">{`⋯ ${window.hidden} earlier line${window.hidden === 1 ? '' : 's'} (writing)`}</text>
      ) : null}
      {window.lines.map((line, i) => (
        <text key={`pr-${i}`} fg="white">{line.trim()}</text>
      ))}
    </box>
  );
}

/** A tool call is still running until its result arrives. In a compact turn
 *  the result is one clipped line instead of the full output.
 *
 *  The card behaviours here are ported from the old CLI's ToolPanels
 *  (cli/ui/src/components/ToolPanels.jsx on the Lenovo box), which the owner
 *  says read better than the flat rows this TUI had:
 *    - an animated spinner while the call runs, not a static "…";
 *    - the call's own measured duration ("1.2s") once it lands;
 *    - args as `k=v` inside a fixed budget instead of raw JSON, which wrapped
 *      a six-key args object into several rows and pushed the result away;
 *    - a failed call drawn in red with ✗, the same success test the server and
 *      the old CLI use;
 *    - "waiting for output…" while a running call has produced nothing yet.
 */
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
/* A pending card's spinner. Each tick is a full-screen repaint — OpenTUI lays
 * the frame out as a unit — so on a long scrollback a bash call used to cost a
 * repaint every 100 ms for a rotating glyph (owner, 2026-11-24: "bash tools
 * making cli lagg"). 300 ms keeps the motion and cuts the cost to a third. */
const TOOL_SPINNER_MS = 300;
const ARGS_BUDGET = 64;
const ARG_VALUE_MAX = 40;

function flattenArgs(args) {
  if (args === null || args === undefined) return '';
  if (typeof args === 'string') return args.trim().replace(/\s+/g, ' ');
  if (Array.isArray(args)) return flattenArgs(args.join(' '));
  if (typeof args === 'object') {
    return Object.entries(args)
      .map(([k, v]) => {
        let val = typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v);
        if (val.length > ARG_VALUE_MAX) val = `${val.slice(0, ARG_VALUE_MAX - 1)}…`;
        return `${k}=${val}`;
      })
      .join(' ');
  }
  return String(args);
}

/** The server marks a failed tool result as `Error:` / `❌` — the same test
 *  smartness.mjs scores with, so the card and the meter agree. */
const isErrorResult = (result) => /^Error[:\n]|^❌/i.test(String(result == null ? '' : result).trim());

function fmtDur(ms) {
  const n = Math.max(0, Math.round(Number(ms) || 0));
  return n < 1000 ? `${n}ms` : `${(n / 1000).toFixed(1)}s`;
}

/** One shared ticker per pending card — idle turns cost zero renders. */
function useSpinnerFrame(active) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    const id = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), TOOL_SPINNER_MS);
    return () => clearInterval(id);
  }, [active]);
  return frame;
}

function ToolRow({ tool, width, compact = false, outputLabel = '▶ Output' }) {
  const pending = tool.result === null || tool.result === undefined;
  const frame = useSpinnerFrame(pending);
  const failed = !pending && isErrorResult(tool.result);
  const glyph = pending ? SPINNER_FRAMES[frame] : failed ? '✗' : '✓';
  const colour = pending ? 'yellow' : failed ? 'red' : 'green';
  const name = tool.name || 'tool';
  const args = clip(flattenArgs(tool.args), ARGS_BUDGET);
  // Live while the call runs (the spinner tick re-renders this row), fixed
  // once the result stamps `ms` in useAgentStream.
  const dur = pending
    ? fmtDur(Date.now() - (Number(tool.t0) || Date.now()))
    : (tool.ms != null ? fmtDur(tool.ms) : '');
  const nameW = name.length + 2; // glyph + space
  const argW = Math.max(4, width - nameW - (args ? dur.length + 3 : 0));
  // An unclipped result line used to wrap into three rows, so a handful of
  // calls could fill the whole transcript; ANSI colour is stripped for the
  // same reason the old cards stripped it — the TUI draws its own colours.
  const shown = pending
    ? null
    : String(tool.result).replace(/\x1b\[[0-9;]*m/g, '').replace(/\r/g, '').split('\n');
  const limit = compact ? 1 : RESULT_LINES;
  const lines = shown ? shown.slice(0, limit) : [];
  const hidden = shown ? Math.max(0, shown.length - lines.length) : 0;

  return (
    <box style={{ flexDirection: 'column', width, flexShrink: 0 }}>
      <text>
        <span fg={colour}>{glyph} </span>
        <span fg="white">{name}</span>
        {args ? <span fg="gray">{` ${clip(args, argW)}`}</span> : null}
        {dur ? <span fg="gray">{`  ${dur}`}</span> : null}
      </text>
      {/* One row per line, each clipped to the column. */}
      {lines.map((line, i) => (
        <text key={`r-${i}`} fg={failed ? 'red' : 'gray'}>{clip(line.trim() || ' ', Math.max(4, width - 1))}</text>
      ))}
      {pending && !lines.length ? (
        <text fg="gray">{clip('│ waiting for output…', Math.max(4, width))}</text>
      ) : null}
      {hidden > 0 ? (
        // The pointer names the pane that actually holds the rest: the right
        // ◈ Live → ▶ Output on a wide terminal, the middle ▶ Result box on a
        // narrow one (owner, 2026-11-24: one live panel, on the right).
        <text fg="gray">{`… +${hidden} more line${hidden === 1 ? '' : 's'} · ${outputLabel}`}</text>
      ) : null}
    </box>
  );
}

function MessageBlock({ message, width, compact = false, live = false, expandThinking = false, showLiveLabel = true, outputLabel = '▶ Output' }) {
  if (!message) return null;

  const roleStyle = ROLE_STYLE[message.role] || ROLE_STYLE.system;
  const border =
    message.role === 'system' && message.tone
      ? TONE_COLOR[message.tone] || roleStyle.border
      : roleStyle.border;

  const inner = Math.max(8, (width || 80) - 4); // borders + horizontal padding

  // The system role carries harness notices, not user prose, so it gets a
  // single-line treatment with no label header to spend a row on.
  if (message.role === 'system') {
    return (
      <box style={{ width, flexShrink: 0, border: true, borderStyle: 'rounded', borderColor: border, paddingLeft: 1, paddingRight: 1 }}>
        <text fg={border}>{String(message.text || '')}</text>
      </box>
    );
  }

  const tools = Array.isArray(message.tools) ? message.tools : [];
  /* Chronological rounds (see withRound in useAgentStream): the model's prose,
   * then the calls it made, then its next prose. Drawing the flat `text` above
   * every tool row is what made a streaming turn read as shell calls only —
   * the newest sentence was never the newest row. */
  const rounds = (Array.isArray(message.rounds) ? message.rounds : []).filter(
    (r) => r && ((r.text && String(r.text).trim()) || (r.thinking && String(r.thinking).trim()) || (Array.isArray(r.tools) && r.tools.length)),
  );

  return (
    <box style={{ width, flexShrink: 0, flexDirection: 'column', border: true, borderStyle: 'rounded', borderColor: border, paddingLeft: 1, paddingRight: 1 }}>
      {/* Auto-compact drops the label row: the border colour still says whose
          turn it is (cyan = you, gray = hakster, yellow = system). */}
      {compact ? null : (
        <text fg={border} attributes={TextAttributes.BOLD}>{roleStyle.label}</text>
      )}
      {message.images ? (
        <text fg="gray">{`⊸ ${message.imageName || `${message.images} image`}`}</text>
      ) : null}
      {rounds.length ? (
        rounds.map((round, i) => {
          // Only the last round of the streaming turn is live: the blocks above
          // it are finished text and must not clamp or animate.
          const tail = live && i === rounds.length - 1;
          const roundTools = Array.isArray(round.tools) ? round.tools : [];
          const proseLive = tail && roundTools.length === 0;
          const thinkLive = proseLive && String(round.thinking || '').trim() !== '' && String(round.text || '').trim() === '';
          return (
            <box key={`round-${i}`} style={{ flexDirection: 'column', width: inner, flexShrink: 0 }}>
              {round.thinking && String(round.thinking).trim() ? (
                <ThinkingBlock
                  text={round.thinking}
                  startedAt={round.thinkingT0}
                  endedAt={round.thinkingT1}
                  live={thinkLive}
                  width={inner}
                  compact={compact}
                  expand={expandThinking}
                  label={showLiveLabel}
                />
              ) : null}
              {round.text && String(round.text).trim() ? (
                <ProseBlock text={round.text} live={proseLive} width={inner} compact={compact} />
              ) : null}
              {roundTools.map((tool, j) => (
                <ToolRow key={`tool-${i}-${j}`} tool={tool} width={inner} compact={compact} outputLabel={outputLabel} />
              ))}
            </box>
          );
        })
      ) : (
        <>
          {message.thinking ? (
            <ThinkingBlock
              text={message.thinking}
              startedAt={message.thinkingT0}
              endedAt={message.thinkingT1}
              live={live && !tools.length}
              width={inner}
              compact={compact}
              expand={expandThinking}
              label={showLiveLabel}
            />
          ) : null}
          {message.text ? (
            <ProseBlock text={message.text} live={live && !tools.length} width={inner} compact={compact} />
          ) : !message.thinking && tools.length === 0 ? (
            // Same duplicate, one row lower: the plain "thinking…" under the
            // live spinner. Only drawn where the spinner row is absent.
            showLiveLabel ? <text fg="gray">thinking…</text> : null
          ) : null}
          {tools.map((tool, i) => (
            <ToolRow key={`tool-${i}`} tool={tool} width={inner} compact={compact} outputLabel={outputLabel} />
          ))}
        </>
      )}
    </box>
  );
}

/* Memoised on purpose (owner, 2026-11-24: "bash tools making cli lagg").
 *
 * A session that has run a few shell calls re-rendered the whole transcript on
 * every elapsed-clock tick — ~70 ms per frame at 20 turns, ~4 ticks a second
 * while a run is live. The stream only ever replaces the message it patches
 * (`withToolResult` / `patch` slice the array and keep every other entry's
 * identity), so a finished turn's props are referentially identical and this
 * memo skips its work entirely: a tick now costs one turn, not twenty.
 * `live` and `width` are the only props that change for finished turns, and
 * they change rarely (a resize or the turn that starts streaming). */
const MemoMessageBlock = React.memo(MessageBlock);
export default MemoMessageBlock;
export { ToolRow };