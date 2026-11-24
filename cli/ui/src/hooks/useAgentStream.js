import { useCallback, useEffect, useRef, useState } from 'react';
import { createMeter } from '../../../smartness.mjs';
import { attemptsFor } from '../../../src/models/ladder.js';

/* useAgentStream — the TUI's one connection to the agent.
 *
 * The CLI already speaks this protocol: `hakster chat` and `hakster agent`
 * consume the same `/api/agent/run` SSE stream in cli/index.js. Reusing the
 * endpoint rather than inventing a TUI-only one means the terminal dashboard
 * cannot drift from the terminal CLI — a phase or tool event added to the
 * server shows up in both, and neither has to be taught the other's shape.
 *
 * The event vocabulary handled below is exactly what the server writes:
 *   delta | thinking_start | thinking | thinking_end | phase
 *   tool_call_start | tool_call_result | tool_result
 *   error | loop_detected | auto_nudge | max_turns | needs_confirmation
 *   file_created | file_changed | artifact | notification | done
 *
 * Two deliberate choices worth naming:
 *
 * 1. `needs_confirmation` is surfaced as a notice rather than a modal. The CLI
 *    answers it by replying to the run; here the operator reads the notice and
 *    sends their answer as the next message. A blocking prompt inside a
 *    full-screen Ink tree is the thing that most often wedges a terminal, so
 *    the cheaper honest option wins.
 *
 * 2. The transcript is append-only per turn, in one assistant message that the
 *    stream patches in place. Remounting a message per delta would refire the
 *    ad rail's and the panel's effects on every token.
 */

const DEFAULT_API = process.env.HAKSTER_API_URL || 'http://localhost:3579';
const DEFAULT_TIMEOUT_MS = Math.max(30000, Number(process.env.HAKSTER_AGENT_TIMEOUT_MS) || 300000);

/** A stable id per appended entry, independent of how fast the stream runs. */
let seq = 0;
const nextId = (prefix) => `${prefix}-${++seq}`;

/** How long a tool call took, from the start stamp kept with its args. */
const toolMs = (meta) => (meta && meta.t0 ? ` · ${Math.max(0, Date.now() - meta.t0)}ms` : '');

/** Token counts as the panels print them: 1_234 → 1.2k, 950 → 950. */
const fmtTok = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '0';
  return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(Math.round(v));
};

/* Conversation replay for continuity.
 *
 * /api/agent/run runs one request per turn and does not reload stored turns
 * into the prompt (it only persists the incoming user turn), so the client is
 * the one holding the conversation. Before this the TUI sent just the newest
 * prompt, which meant every message started a brand-new conversation: the
 * agent forgot the task it was halfway through and stopped, and the operator
 * had to restate it. Sending the transcript back is what makes a run continue
 * like a CLI session instead of restarting each time.
 *
 * Capped by count and by characters so a long session cannot grow the request
 * without bound. Only real prose is replayed — a turn that produced tools but
 * no text has nothing a model can read back.
 */
const HISTORY_MAX_MESSAGES = 16;
const HISTORY_MAX_CHARS = 24000;
const HISTORY_MSG_CHARS = 6000;

function buildHistory(msgs) {
  if (!Array.isArray(msgs) || msgs.length === 0) return [];
  const out = [];
  let chars = 0;
  for (let i = msgs.length - 1; i >= 0 && out.length < HISTORY_MAX_MESSAGES; i -= 1) {
    const m = msgs[i];
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const text = String(m.text || '').trim();
    if (!text) continue;
    const clipped = text.length > HISTORY_MSG_CHARS ? `${text.slice(0, HISTORY_MSG_CHARS)}…` : text;
    if (chars + clipped.length > HISTORY_MAX_CHARS) break;
    chars += clipped.length;
    out.push({ role: m.role, content: clipped });
  }
  return out.reverse();
}

/** Map the server's todo status vocabulary onto the panel's `{ text, done }`. */
function normalizeTodos(raw) {
  if (!Array.isArray(raw)) return null;
  return raw
    .filter((t) => t && typeof t === 'object')
    .map((t) => ({
      text: String(t.text || '').trim(),
      done: t.status === 'done',
    }))
    .filter((t) => t.text);
}

export function useAgentStream({
  api = DEFAULT_API,
  model,
  provider,
  system,
  sessionId,
  cwd,
  approvalMode,
  // Owner's switch (2026-11-23): when a run fails before producing anything,
  // move to the next entry of the ladder (src/models/ladder.js). Off means the
  // run fails where it failed — no silent model change.
  autoHandoff = true,
} = {}) {
  const [messages, setMessages] = useState([]);
  // Mirror of `messages` for send(): the callback is long-lived, so reading the
  // state variable inside it would replay the history from when it was built.
  const messagesRef = useRef([]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  const [todos, setTodos] = useState([]);
  const [status, setStatus] = useState('idle'); // idle | connecting | thinking | streaming | error
  const [error, setError] = useState(null);
  const [elapsedMs, setElapsedMs] = useState(0);

  // ── Activity + usage ──────────────────────────────────────────────────────
  // HakTerm's right-hand column keeps a live ACTIVITY feed and a USAGE block
  // beside the terminal. These are their data: every event the stream already
  // carries (phase change, tool start, tool result with its measured duration,
  // handoff, error, done) is appended here, and the counters are the same
  // events counted — never an estimate. The feed is capped so a long session
  // costs bounded memory; the counters are session totals and only reset on
  // /clear.
  const [activity, setActivity] = useState([]);
  const [requests, setRequests] = useState(0);
  const [tokens, setTokens] = useState({ in: 0, out: 0, reported: false });
  const requestsRef = useRef(0);
  const pushActivity = useCallback((kind, text) => {
    const line = { kind: String(kind || 'sys'), text: String(text == null ? '' : text), ts: Date.now() };
    setActivity((prev) => (prev.length >= 60 ? [...prev.slice(prev.length - 59), line] : [...prev, line]));
  }, []);

  // A blocking approval request from the server, or null. Mirrored in a ref as
  // well as state because the answer can come from a key handler, which must
  // not depend on a stale closure to find out what it is answering.
  const [pendingConfirm, setPendingConfirm] = useState(null);
  const pendingConfirmRef = useRef(null);

  // ── Smartness + autolearn ────────────────────────────────────────────────
  // The same meter the old CLI (and the Ink TUI) uses: scoreToolCall's rules
  // are in smartness.mjs, seeded from the last old-CLI session so a fresh TUI
  // starts where the operator left off. Every tool result the stream delivers
  // is scored once, and a loop break costs the same -10 it always has.
  const meterRef = useRef(null);
  if (!meterRef.current) meterRef.current = createMeter();
  const [meters, setMeters] = useState(() => meterRef.current.snapshot());
  // tool_call_id → the call that produced a later result, so a result is
  // scored against its own name/args even when several tools run in parallel.
  const toolMetaRef = useRef(new Map());
  const lastToolRef = useRef(null);
  const syncMeters = useCallback(() => setMeters(meterRef.current.snapshot()), []);
  const scoreTool = useCallback((name, args, result) => {
    // The server tags a failed tool result as `Error:` / `❌` — the same
    // success test the old CLI scores with.
    const text = String(result == null ? '' : result).trim();
    const ok = !/^Error[:\n]|^❌/i.test(text);
    try {
      meterRef.current.tool(name || 'tool', args || {}, ok, text);
      syncMeters();
    } catch {
      /* metering must never break the run */
    }
    // The caller logs the call as a win or a loss; the test lives in one place.
    return ok;
  }, [syncMeters]);

  const setPending = useCallback((value) => {
    pendingConfirmRef.current = value;
    setPendingConfirm(value);
  }, []);

  const abortRef = useRef(null);
  // Did the operator press esc/ctrl+c, or did our own timeout fire? Both
  // arrive as AbortError, but only the second one is a handoff candidate.
  const userAbortRef = useRef(false);
  // Per-attempt bookkeeping for the ladder: what this attempt produced and
  // whether the stream ended in an `error` event.
  const attemptCtxRef = useRef({ produced: false, sawError: null, status: null });
  const startedAtRef = useRef(null);
  // Mirrors `status` for the stream loop, which outlives any single render.
  const statusRef = useRef('idle');
  // The id of the turn currently on the wire. POST /api/agent/steer names it,
  // so a message typed mid-run lands in THAT run instead of a new one.
  const activeRunIdRef = useRef(null);

  const setStatusBoth = useCallback((next) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  // The elapsed timer is owned here, not by the caller: every consumer of this
  // hook wants the same "how long has this turn been running" answer, and a
  // second interval elsewhere would drift from this one.
  useEffect(() => {
    // 'approval' still counts as a live run: the server is holding the stream
    // open against a five-minute timer, so the clock has to keep running.
    const ticking =
      status === 'thinking' || status === 'streaming' || status === 'approval';
    if (!ticking) return undefined;
    const id = setInterval(() => {
      if (startedAtRef.current) setElapsedMs(Date.now() - startedAtRef.current);
    }, 250);
    return () => clearInterval(id);
  }, [status]);

  /** Patch the trailing assistant message for `id`, creating fields as needed. */
  const patch = useCallback((id, fn) => {
    setMessages((prev) => {
      const idx = prev.findIndex((m) => m.id === id);
      if (idx === -1) return prev;
      const next = prev.slice();
      next[idx] = fn(next[idx]) || next[idx];
      return next;
    });
  }, []);

  const append = useCallback((entry) => {
    setMessages((prev) => [...prev, entry]);
  }, []);

  /* A turn is not one text block followed by one list of calls: the model
   * says something, calls a tool, then says the next thing. Flattening that
   * into `text` + `tools` put every sentence ABOVE every tool row, so with the
   * window on the tail the newest prose was never the newest row — a tool-
   * heavy turn read as shell calls only (owner, 2026-11-23: "its not showing
   * agents output what he says something only shell call tools i see").
   * `rounds` keeps the real order; `text`/`thinking`/`tools` stay as the flat
   * totals the rest of the UI (live output, meters) already reads. */
  const withRound = useCallback((m, opensNew, mutate) => {
    const rounds = Array.isArray(m.rounds)
      ? m.rounds.map((r) => ({ ...r, tools: Array.isArray(r.tools) ? r.tools.slice() : [] }))
      : [];
    let cur = rounds[rounds.length - 1];
    if (!cur || opensNew(cur)) {
      cur = { text: '', thinking: '', tools: [] };
      rounds.push(cur);
    }
    mutate(cur);
    return { ...m, rounds };
  }, []);

  /** Drop an entry — used for a turn's empty assistant bubble when every
   *  attempt failed before writing a single character. */
  const drop = useCallback((id) => {
    setMessages((prev) => prev.filter((m) => m.id !== id));
  }, []);

  /* Attribute a result to the tool that asked for it — in the flat list and in
   * its round — so the row that is drawn in order gets the same result the
   * live-output panel reads. Matching by id first, then the newest call still
   * waiting, exactly as the flat list always did. */
  const withToolResult = useCallback((m, id, result, mcp = false) => {
    const pick = (list) => {
      let idx = id ? list.findIndex((t) => t.id === id) : -1;
      if (idx === -1) {
        for (let i = list.length - 1; i >= 0; i--) {
          if (list[i].result === null && (mcp ? list[i].mcp : true)) { idx = i; break; }
        }
      }
      return idx;
    };
    // A landed call carries how long it took. The old CLI's tool cards printed
    // a measured duration ("1.2s") on every finished call; the timing starts
    // at tool_call_start (t0) and is stamped here, once, so a re-render never
    // makes the number drift while the transcript is scrolled.
    const settled = (entry) => ({
      ...entry,
      result,
      ms: Math.max(0, Date.now() - (Number(entry.t0) || Date.now())),
      ...(mcp ? { mcp: true } : {}),
    });
    const tools = m.tools.slice();
    const idx = pick(tools);
    if (idx !== -1) tools[idx] = settled(tools[idx]);
    const rounds = Array.isArray(m.rounds)
      ? m.rounds.map((r) => {
        const rt = Array.isArray(r.tools) ? r.tools.slice() : [];
        const at = pick(rt);
        if (at !== -1) rt[at] = settled(rt[at]);
        return { ...r, tools: rt };
      })
      : m.rounds;
    return { ...m, tools, rounds };
  }, []);

  const abort = useCallback(() => {
    userAbortRef.current = true;
    // A run parked on an approval has to be released explicitly. Aborting our
    // fetch closes the socket but leaves the server's pending entry to time out
    // for five minutes on a response nobody is reading.
    if (pendingConfirmRef.current) {
      const pending = pendingConfirmRef.current;
      setPending(null);
      fetch(`${api}/api/agent/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(process.env.HAKSTER_API_KEY ? { 'x-api-key': process.env.HAKSTER_API_KEY } : {}) },
        body: JSON.stringify({
          sessionId: sessionId || 'default',
          toolCallId: pending.toolCallId,
          approved: false,
          command: pending.command || '',
          permanent: false,
        }),
      }).catch(() => {});
    }
    if (abortRef.current) {
      try {
        abortRef.current.abort();
      } catch {
        /* the run may already have finished; nothing to cancel */
      }
      abortRef.current = null;
    }
    setStatusBoth('idle');
    setElapsedMs(startedAtRef.current ? Date.now() - startedAtRef.current : 0);
  }, [api, sessionId, setPending, setStatusBoth]);

  /**
   * Answer a pending approval. `approved` lets the run continue; `permanent`
   * additionally persists the command to the server's allowlist.
   *
   * `permanent` is always sent, even when false, because
   * /api/agent/confirm treats a MISSING `permanent` as permanent
   * (`permanent !== false`). Saying nothing therefore allowlists the command
   * forever, so the only way a session-scoped yes stays session-scoped is to
   * say so out loud. The text CLI omits the field and allowlists forever; this
   * deliberately does not.
   */
  const answerConfirm = useCallback(
    async (approved, { permanent = false } = {}) => {
      const pending = pendingConfirmRef.current;
      if (!pending) return false;
      const cmd = pending.command || '';
      setPending(null);
      // The run resumes as soon as the server hears back, so leave the parked
      // state immediately rather than waiting on the round trip.
      setStatusBoth('streaming');
      try {
        const res = await fetch(`${api}/api/agent/confirm`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(process.env.HAKSTER_API_KEY ? { 'x-api-key': process.env.HAKSTER_API_KEY } : {}) },
          body: JSON.stringify({
            sessionId: sessionId || 'default',
            toolCallId: pending.toolCallId,
            approved: !!approved,
            command: cmd,
            permanent: !!permanent,
          }),
        });
        if (!res.ok) throw new Error(`confirm failed (${res.status})`);
        append({
          id: nextId('sys'),
          role: 'system',
          tone: approved ? 'notice' : 'warn',
          text: `${approved ? 'approved' : 'denied'}${cmd ? `: ${cmd}` : ''}${
            approved && permanent ? ' — allowed from now on' : ''
          }`,
        });
        return true;
      } catch (e) {
        const msg = (e && e.message) || 'could not report the decision';
        append({ id: nextId('sys'), role: 'system', tone: 'error', text: msg });
        setError(msg);
        return false;
      }
    },
    [api, append, sessionId, setPending, setStatusBoth],
  );

  const runTurn = useCallback(
    async (text, opts = {}) => {
      const prompt = String(text == null ? '' : text).trim();
      if (!prompt || statusRef.current === 'connecting' || statusRef.current === 'streaming') {
        return;
      }
      // Data URLs supplied by /attach. The server accepts OpenAI-style
      // image_url parts and converts them for models without vision.
      const images = Array.isArray(opts && opts.images)
        ? opts.images.filter((url) => typeof url === 'string' && url.startsWith('data:image/'))
        : [];

      append({
        id: nextId('user'),
        role: 'user',
        text: prompt,
        images: images.length,
        imageName: (opts && opts.imageName) || '',
      });
      const assistantId = nextId('ai');
      append({
        id: assistantId,
        role: 'assistant',
        text: '',
        thinking: '',
        phase: null,
        tools: [],
        model: model || null,
      });

      setError(null);
      setStatusBoth('connecting');
      startedAtRef.current = Date.now();
      setElapsedMs(0);
      // A new turn starts a new round budget for the meter; the session's
      // smartness and points carry over, exactly as the old CLI's did.
      try { meterRef.current.resetTask(); syncMeters(); } catch { /* metering is best-effort */ }
      toolMetaRef.current.clear();

      // ── The ladder ──────────────────────────────────────────────────────
      // Cheap DeepSeek first, Codex next, the server's own waterfall last
      // (src/models/ladder.js). One attempt at a time; an attempt that failed
      // before producing anything hands the same prompt to the next entry when
      // the owner's auto-handoff switch is on.
      const attempts = attemptsFor(model, provider);
      if (attempts.length && provider && attempts[0].provider !== provider) {
        // An explicit HAKSTER_PROVIDER / caller provider wins for tier 1.
        attempts[0] = { ...attempts[0], provider };
      }
      // Statuses that another model cannot fix: a signed-out session, an
      // entitlement problem, a malformed turn, or a body the server refused.
      const terminalStatus = (status) =>
        status === 400 || status === 401 || status === 402 || status === 403 ||
        status === 413 || status === 415 || status === 422;
      userAbortRef.current = false;

      /** Apply one decoded SSE payload to the transcript. */
      const applyEvent = (evt) => {
        if (!evt || typeof evt !== 'object') return;
        switch (evt.type) {
          case 'delta':
            setStatusBoth('streaming');
            attemptCtxRef.current.produced = true;
            patch(assistantId, (m) => withRound(
              { ...m, text: m.text + (evt.content || '') },
              (r) => r.tools.length > 0,
              // Prose starting ends the reasoning clock: the transcript folds a
              // finished thought to "Thought for 12s" (see MessageBlock).
              (r) => {
                if (r.thinkingT0 && !r.thinkingT1) r.thinkingT1 = Date.now();
                r.text += evt.content || '';
              },
            ));
            break;

          case 'thinking_start': {
            setStatusBoth('thinking');
            const thinkAt = Date.now();
            // A reasoning block that opens after prose or tool rows is its own
            // round: the transcript draws blocks in the order they were written,
            // so reasoning is never parked above an answer it came after.
            patch(assistantId, (m) => withRound(
              { ...m, thinking: '' },
              (r) => r.tools.length > 0 || String(r.text || '').trim() !== '',
              (r) => { r.thinkingT0 = thinkAt; r.thinkingT1 = undefined; },
            ));
            break;
          }

          case 'thinking':
            setStatusBoth('thinking');
            attemptCtxRef.current.produced = true;
            patch(assistantId, (m) => withRound(
              { ...m, thinking: m.thinking + (evt.content || '') },
              (r) => r.tools.length > 0,
              (r) => {
                if (!r.thinkingT0) r.thinkingT0 = Date.now();
                r.thinking += evt.content || '';
              },
            ));
            break;

          case 'thinking_end':
            // The reasoning is kept on the message so the operator can still
            // read it after the answer lands; only the spinner stops. The end
            // stamp is what lets the block fold to "Thought for 12s" instead of
            // holding dozens of rows open for the rest of the session.
            patch(assistantId, (m) => {
              const rounds = Array.isArray(m.rounds) ? m.rounds.map((r) => ({ ...r })) : [];
              const cur = rounds[rounds.length - 1];
              if (cur && cur.thinkingT0 && !cur.thinkingT1) cur.thinkingT1 = Date.now();
              return { ...m, rounds };
            });
            break;

          case 'phase':
            if (evt.phase) {
              patch(assistantId, (m) => ({ ...m, phase: evt.phase }));
              pushActivity('phase', evt.phase);
            }
            break;

          case 'tool_call_start': {
            const name = evt.tool_name || 'unknown';
            lastToolRef.current = { name, args: evt.tool_args || {}, t0: Date.now() };
            if (evt.tool_call_id) toolMetaRef.current.set(evt.tool_call_id, lastToolRef.current);
            pushActivity('start', name);
            // The checklist is a tool call, not a panel event, so this is where
            // the panel's data actually comes from.
            if (name === 'update_todo' || name === 'plan') {
              const raw = (evt.tool_args && (evt.tool_args.todos || evt.tool_args.steps)) || null;
              const next = name === 'plan'
                ? normalizeTodos((raw || []).map((s) => ({ text: s, status: 'pending' })))
                : normalizeTodos(raw);
              if (next) setTodos(next);
            }
            patch(assistantId, (m) => {
              const call = {
                id: evt.tool_call_id || nextId('tool'),
                name,
                args: evt.tool_args || {},
                result: null,
                mcp: name.startsWith('mcp__'),
                // Start of the call, for the live duration on its card.
                t0: Date.now(),
              };
              return withRound(
                { ...m, tools: [...m.tools, call] },
                () => false, // a call joins the round the prose before it opened
                (r) => {
                  if (r.thinkingT0 && !r.thinkingT1) r.thinkingT1 = Date.now();
                  r.tools.push(call);
                },
              );
            });
            break;
          }

          case 'mcp_result': {
            const result = String(evt.data == null ? '' : evt.data);
            const meta = (evt.tool_call_id && toolMetaRef.current.get(evt.tool_call_id)) || lastToolRef.current;
            if (meta) {
              const ok = scoreTool(meta.name, meta.args, result);
              pushActivity(ok ? 'mcp' : 'err', `${meta.name}${toolMs(meta)}`);
            }
            patch(assistantId, (m) => withToolResult(m, evt.tool_call_id, result, true));
            break;
          }

          case 'tool_call_result':
          case 'tool_result': {
            const result = String(
              evt.tool_result != null ? evt.tool_result : evt.result != null ? evt.result : '',
            );
            // Score the call before patching: the meter must move the moment
            // the result arrives, even if the run is about to fail.
            const meta = (evt.tool_call_id && toolMetaRef.current.get(evt.tool_call_id)) || lastToolRef.current;
            if (meta) {
              const ok = scoreTool(meta.name, meta.args, result);
              pushActivity(ok ? 'ok' : 'err', `${meta.name}${toolMs(meta)}`);
            }
            patch(assistantId, (m) => withToolResult(m, evt.tool_call_id, result));
            break;
          }

          case 'needs_confirmation': {
            // The server BLOCKS here — awaitUserConfirmation holds the stream
            // open until something POSTs /api/agent/confirm, or five minutes
            // pass and it auto-denies. So this cannot be answered by sending a
            // chat message: the stream is still open, and `send` refuses while
            // a run is live. The answer has to go back out of band, which is
            // what answerConfirm does.
            setStatusBoth('approval');
            pushActivity('confirm', `${evt.tool_name || 'tool'} needs approval`);
            setPending({
              toolCallId: evt.tool_call_id || null,
              toolName: evt.tool_name || 'tool',
              reason: evt.reason || 'Approval needed',
              command: evt.command || '',
            });
            break;
          }

          case 'steer': {
            // The server read this mid-run and put it in front of the model on
            // the next round. Shown as the operator's own line, because that is
            // whose words they are — and because a steer that never appeared
            // would look like it was dropped.
            const text = String(evt.content || '').trim();
            if (text) {
              append({ id: nextId('user'), role: 'user', text });
              pushActivity('sys', '↳ live steer applied');
            }
            break;
          }

          case 'loop_detected':
            // A loop break is a real penalty in the old CLI (-10) — the same
            // cost here, so the bar tells the truth about a bad run.
            try { meterRef.current.bump(-10); syncMeters(); } catch { /* metering is best-effort */ }
            pushActivity('err', 'loop detected');
            append({ id: nextId('sys'), role: 'system', tone: 'warn', text: evt.message || 'loop detected' });
            break;

          case 'auto_nudge':
            append({
              id: nextId('sys'),
              role: 'system',
              tone: 'notice',
              text: evt.message || 'nudging the model to use tools…',
            });
            break;

          case 'max_turns':
            append({
              id: nextId('sys'),
              role: 'system',
              tone: 'warn',
              text: `stopped at the turn limit (${evt.maxTurns ?? '?'} turns)`,
            });
            break;

          case 'file_created':
          case 'file_changed':
          case 'artifact':
            append({
              id: nextId('sys'),
              role: 'system',
              tone: 'notice',
              text: `${evt.type.replace('_', ' ')}: ${evt.path || evt.file || evt.name || ''}`.trim(),
            });
            break;

          case 'aborted':
            append({ id: nextId('sys'), role: 'system', tone: 'warn', text: 'run aborted' });
            break;

          case 'error':
            // Recorded, not rendered: the attempt loop decides whether this
            // becomes a handoff to the next model or the turn's final error.
            attemptCtxRef.current.sawError = evt.error || 'agent error';
            pushActivity('err', evt.error || 'agent error');
            setStatusBoth('error');
            break;

          case 'done': {
            // The turn's own token report is the only honest token count there
            // is, so the session totals are a sum of exactly these reports.
            const inTok = Number(evt.inputTokens);
            const outTok = Number(evt.outputTokens);
            if (Number.isFinite(inTok) || Number.isFinite(outTok)) {
              setTokens((t) => ({
                in: t.in + (Number.isFinite(inTok) ? inTok : 0),
                out: t.out + (Number.isFinite(outTok) ? outTok : 0),
                reported: true,
              }));
              pushActivity('done', `turn done · ${fmtTok(inTok)} in / ${fmtTok(outTok)} out`);
            } else {
              pushActivity('done', 'turn done');
            }
            patch(assistantId, (m) => ({
              ...m,
              model: evt.model || m.model,
              tokens: evt.inputTokens != null || evt.outputTokens != null
                ? { in: evt.inputTokens, out: evt.outputTokens }
                : m.tokens,
            }));
            break;
          }

          default:
            // Heartbeats, turn_end and any event added later are deliberately
            // ignored rather than rendered: an unknown event should be able to
            // appear on the wire without breaking an installed client.
            break;
        }
      };

      /** Run one attempt and report what happened; decide nothing. */
      const runAttempt = async (target) => {
        // One attempt is one request to /api/agent/run — the session's request
        // count is these, counted at the moment the request goes out.
        requestsRef.current += 1;
        setRequests(requestsRef.current);
        pushActivity('sys', `→ ${target.label || target.provider || 'auto'}`);
        // One id per request: the server registers a steer inbox under it and
        // removes it when the stream closes, so a late steer is refused rather
        // than delivered into a run that already answered.
        const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        activeRunIdRef.current = runId;
        const controller = new AbortController();
        abortRef.current = controller;
        const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
        const ctx = { produced: false, sawError: null, status: null };
        attemptCtxRef.current = ctx;
        try {
          const res = await fetch(`${api}/api/agent/run`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(process.env.HAKSTER_API_KEY ? { 'x-api-key': process.env.HAKSTER_API_KEY } : {}) },
            signal: controller.signal,
            body: JSON.stringify({
              messages: [
                ...(system ? [{ role: 'system', content: system }] : []),
                // The conversation so far, so this turn continues the task
                // instead of starting a fresh one (see buildHistory above).
                ...buildHistory(messagesRef.current),
                {
                  role: 'user',
                  content: images.length
                    ? [{ type: 'text', text: prompt }, ...images.map((url) => ({ type: 'image_url', image_url: { url } }))]
                    : prompt,
                },
              ],
              stream: true,
              runId,
              // Tier 3 sends neither, so the server's own waterfall decides —
              // that is what "others last" means here.
              ...(target.provider ? { provider: target.provider } : {}),
              ...(target.model ? { model: target.model } : {}),
              ...(cwd ? { cwd } : {}),
              ...(sessionId ? { sessionId } : {}),
              ...(approvalMode ? { approvalMode } : {}),
              // An autonomous run is allowed the server's full round budget so a
              // long job is finished in one go rather than stopping at a cap.
              ...(approvalMode === 'full-auto' || approvalMode === 'auto-edit' ? { maxTurns: 120 } : {}),
            }),
          });

          ctx.status = res.status;
          if (!res.ok) {
            throw new Error(
              res.status === 413
                ? 'the server refused the body (413) — image too large'
                : `server replied ${res.status}`,
            );
          }
          if (!res.body) throw new Error('server sent no stream');

          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';

          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            // SSE frames are newline-delimited. A partial trailing line stays
            // in the buffer, because a chunk boundary is not a frame boundary.
            let idx;
            while ((idx = buffer.indexOf('\n')) !== -1) {
              const line = buffer.slice(0, idx).replace(/\r$/, '');
              buffer = buffer.slice(idx + 1);
              // `:heartbeat` comments exist to keep the socket warm; they carry
              // no data and must not be parsed.
              if (!line.startsWith('data:')) continue;
              const payload = line.slice(5).trim();
              if (!payload) continue;
              try {
                applyEvent(JSON.parse(payload));
              } catch {
                /* a malformed frame is not worth killing the run over */
              }
            }
          }

          if (ctx.sawError) return { ok: false, aborted: false, ...ctx, error: ctx.sawError };
          // Only clear the spinner if an error event has not already set one.
          if (statusRef.current !== 'error') setStatusBoth('idle');
          return { ok: true, aborted: false, ...ctx, error: null };
        } catch (e) {
          if (e && e.name === 'AbortError') {
            return {
              ok: false,
              aborted: true,
              ...ctx,
              error: userAbortRef.current ? 'run cancelled' : 'timed out',
            };
          }
          return { ok: false, aborted: false, ...ctx, error: (e && e.message) || 'request failed' };
        } finally {
          clearTimeout(timeout);
        }
      };

      // Did any attempt write anything? A turn where nothing was ever
      // produced must not leave an empty "thinking…" bubble behind.
      let spoke = false;

      for (let i = 0; i < attempts.length; i++) {
        const target = attempts[i];
        const res = await runAttempt(target);
        spoke = spoke || !!res.produced;
        if (res.ok) break;

        if (res.aborted && userAbortRef.current) {
          append({ id: nextId('sys'), role: 'system', tone: 'warn', text: 'run cancelled' });
          setStatusBoth('idle');
          break;
        }

        const next = attempts[i + 1];
        // A handoff only ever follows a failure that produced nothing: partial
        // output is kept and reported rather than replayed on another model.
        // 400/401/402/403 are the request's own fault — another model cannot
        // fix a signed-out session or a malformed turn.
        const canHandoff =
          autoHandoff && !!next && !res.produced && !res.aborted && !terminalStatus(res.status);

        if (!canHandoff) {
          const msg = res.error || 'request failed';
          setError(msg);
          setStatusBoth('error');
          if (!spoke) drop(assistantId);
          append({ id: nextId('sys'), role: 'system', tone: 'error', text: msg });
          break;
        }

        // Honest, visible handoff: which model failed, why, and which one is
        // taking over — never a silent swap.
        append({
          id: nextId('sys'),
          role: 'system',
          tone: 'warn',
          text: `handoff ${target.label} → ${next.label}: ${res.error}`,
        });
        pushActivity('handoff', `${target.label} → ${next.label}`);
        patch(assistantId, (m) => ({
          ...m,
          text: '',
          thinking: '',
          tools: [],
          phase: null,
          model: next.model || next.provider || 'auto',
        }));
        toolMetaRef.current.clear();
        setError(null);
        setStatusBoth('connecting');
      }

      abortRef.current = null;
      activeRunIdRef.current = null;
      // Once the stream is over there is nothing left to answer: a pending
      // approval whose socket has closed can no longer be reported anywhere.
      setPending(null);
      setElapsedMs(startedAtRef.current ? Date.now() - startedAtRef.current : 0);
    },
    [api, append, approvalMode, autoHandoff, cwd, drop, model, patch, provider, pushActivity, sessionId, setPending, setStatusBoth, system],
  );

  /* The public entry point, and the reason it is a wrapper: it answers "did
   * this turn actually start?" synchronously. runTurn() bails silently when a
   * run is already live, and the TUI's steer queue must keep the message
   * queued rather than assume it was delivered (owner, 2026-11-24: the steer
   * queue may never drop what was typed). */
  const send = useCallback((text, opts = {}) => {
    const prompt = String(text == null ? '' : text).trim();
    if (!prompt || statusRef.current === 'connecting' || statusRef.current === 'streaming') return false;
    runTurn(text, opts);
    return true;
  }, [runTurn]);

  /* Hand a message to the run that is streaming right now. Resolves true only
   * when the server accepted it for THIS run — a run that has already closed
   * answers 409, and an older server a 404. Either way the caller queues the
   * message instead of dropping it. */
  const steer = useCallback(async (text) => {
    const prompt = String(text == null ? '' : text).trim();
    const runId = activeRunIdRef.current;
    if (!prompt || !runId) return false;
    try {
      const res = await fetch(`${api}/api/agent/steer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(process.env.HAKSTER_API_KEY ? { 'x-api-key': process.env.HAKSTER_API_KEY } : {}) },
        body: JSON.stringify({ runId, text: prompt }),
      });
      if (!res.ok) return false;
      const data = await res.json().catch(() => ({}));
      return data && data.ok === true;
    } catch {
      return false;
    }
  }, [api]);

  const clear = useCallback(() => {
    abort();
    setPending(null);
    setMessages([]);
    setTodos([]);
    setError(null);
    setElapsedMs(0);
    setActivity([]);
    setRequests(0);
    setTokens({ in: 0, out: 0, reported: false });
    requestsRef.current = 0;
    startedAtRef.current = null;
  }, [abort, setPending]);

  const busy =
    status === 'connecting' ||
    status === 'streaming' ||
    status === 'thinking' ||
    status === 'approval';

  return {
    messages,
    todos,
    status,
    error,
    elapsedMs,
    busy,
    meters,
    activity,
    requests,
    tokens,
    pendingConfirm,
    answerConfirm,
    send,
    steer,
    abort,
    clear,
  };
}

export default useAgentStream;
