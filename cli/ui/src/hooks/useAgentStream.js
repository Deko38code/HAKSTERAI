import { useCallback, useEffect, useRef, useState } from 'react';
import { createMeter } from '../../../smartness.mjs';
import { attemptsFor } from '../../../src/models/ladder.js';
import { applySteer } from '../utils/steer-rounds.js';

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

/* Auto-reconnect (owner, 2026-11-24: "and add auto reconnect in tui").
 *
 * A server restart — a build hand-off, a PM2 respawn, a crash recovery — leaves
 * the port refusing connections for a few seconds. That is not a failed turn,
 * and ending the session on it made a routine restart look like a broken CLI.
 * The TUI now waits for the port to answer and sends the same turn again.
 *
 * It is only ever safe while nothing has been produced: a turn that already
 * printed prose or ran a tool cannot be replayed without duplicating work the
 * operator watched happen. That case keeps its output and reports the error
 * exactly as before.
 */
const RECONNECT_WINDOW_MS = Math.max(5000, Number(process.env.HAKSTER_RECONNECT_MS) || 60000);
const RECONNECT_PROBE_MS = 2500;
const RECONNECT_MAX_TRIES = 40;

/** Does this thrown value mean "the server was not there", not "the turn was bad"? */
function isTransportError(e) {
  if (!e || e.name === 'AbortError') return false;
  const code = String((e.cause && e.cause.code) || e.code || '');
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|EHOSTUNREACH|ENETUNREACH/.test(code)) return true;
  const msg = `${e.message || e} ${(e.cause && e.cause.message) || ''}`;
  return /fetch failed|failed to fetch|network|socket hang up|connection (?:refused|reset|closed)|stream closed/i.test(msg);
}

/**
 * Poll the server's own status route until it answers again. Returns true once
 * the port is serving, false when the window runs out or the operator aborts.
 * Never throws: a refused connection is the expected state while the process
 * is down, and it must not surface as a second, different error.
 */
async function waitForServer(api, { windowMs = RECONNECT_WINDOW_MS, key, isCancelled } = {}) {
  const deadline = Date.now() + windowMs;
  let delay = 300;
  for (let tries = 0; tries < RECONNECT_MAX_TRIES; tries += 1) {
    if (isCancelled && isCancelled()) return false;
    const left = deadline - Date.now();
    if (left <= 0) return false;
    try {
      const r = await fetch(`${api}/api/tui/status`, {
        method: 'GET',
        headers: key ? { 'x-api-key': key } : {},
        signal: AbortSignal.timeout(Math.min(RECONNECT_PROBE_MS, Math.max(500, left))),
      });
      if (r && r.ok) return true;
    } catch {
      /* still down — try again after the backoff */
    }
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(Math.round(delay * 2), 2500);
  }
  return false;
}

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
  // Called with the messages a run could not deliver: a steer typed during a
  // run that answered in a single turn ends before the next drain. The server
  // hands them back on `steer_undelivered`; the TUI queues them as the next
  // turn so nothing typed is ever dropped (owner, 2026-11-24).
  onSteerUndelivered,
} = {}) {
  const [messages, setMessages] = useState([]);
  // Mirror of `messages` for send(): the callback is long-lived, so reading the
  // state variable inside it would replay the history from when it was built.
  const messagesRef = useRef([]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  const onSteerUndeliveredRef = useRef(onSteerUndelivered);
  useEffect(() => { onSteerUndeliveredRef.current = onSteerUndelivered; }, [onSteerUndelivered]);
  const [todos, setTodos] = useState([]);
  const [status, setStatus] = useState('idle'); // idle | connecting | reconnecting | thinking | streaming | approval | error
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
  // When the run last delivered ANY event. The status row reads this to tell a
  // quiet-but-working turn from a stuck one (owner, 2026-11-25: "when agent is
  // stuck to know when to stop and use tools"): no event for 12 s swaps the
  // phase phrase for a call-a-tool nudge. A plain ref, because every event
  // already re-renders the app — this only has to be readable at paint.
  const progressAtRef = useRef(0);
  // When the server last proved a loop (same call repeated). The status row
  // reads it for a few seconds so "stuck" is visible the moment it is real, not
  // only after the silence clock runs out (owner, 2026-11-25).
  const [loopAt, setLoopAt] = useState(0);
  const [requests, setRequests] = useState(0);
  const [tokens, setTokens] = useState({ in: 0, out: 0, reported: false });
  // How full the model's context window is, measured — never guessed (owner,
  // 2026-11-26: the sidebar's `ctx` row "doesn't work"). It is the prompt size
  // of the most recent call: the `done` event's own inputTokens, or, after the
  // server compacts mid-run, the compact event's tokensAfter. Nothing else in
  // the wire reports it, so with no turn yet this stays 0 and the row says "—".
  const [contextUsed, setContextUsed] = useState(0);
  // The window `contextUsed` is measured against, when the answering lane says
  // what it compacts at (the claude-cli lane sends 200000 — its own
  // CLAUDE_CODE_AUTO_COMPACT_WINDOW). 0 = unknown, so the caller falls back to
  // the model catalog's window rather than inventing one.
  const [contextWindow, setContextWindow] = useState(0);
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
  // What this session has actually learned, from the server's own consolidation
  // events. The idle recap and the session summary both read these totals, so
  // "learned N" is a counted number, never an impression (owner, 2026-11-25).
  const [learned, setLearned] = useState({ added: 0, skills: 0, events: 0 });
  const learnedRef = useRef({ added: 0, skills: 0, events: 0 });
  // The recap of the last finished run, shown on the idle row and addressable
  // by its `#id` (owner, 2026-11-25). Null until a run has finished.
  const [lastRecap, setLastRecap] = useState(null);
  // The distinct failures of the run in flight, short and capped. They are
  // posted with the session summary so the mistakes become autolearn `error`
  // memories instead of scrolling away with the transcript.
  const failuresRef = useRef([]);
  // Where the session's learned totals stood when this run started, so the
  // recap can say what THIS run learned rather than the whole session's count.
  const learnedAtStartRef = useRef({ added: 0, skills: 0, events: 0 });
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
    if (!ok) {
      // Keep the failure, not the whole transcript: the tool and the first
      // line of what went wrong is what a later turn can act on.
      const tool = String(name || 'tool');
      const error = text.replace(/\s+/g, ' ').slice(0, 180);
      const list = failuresRef.current;
      if (list.length < 6 && !list.some((f) => f.tool === tool && f.error === error)) {
        list.push({ tool, error });
      }
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
    // 'connecting' is the run too (owner, 2026-11-24: "need live counter starts
    // when message is sent and agents recieves it"): startedAtRef is stamped the
    // moment the turn goes on the wire, and the clock must already be moving
    // while the request is in flight instead of sitting at 0s until the first
    // thinking/streaming event lands.
    const ticking =
      status === 'connecting' || status === 'reconnecting' || status === 'thinking' ||
      status === 'streaming' || status === 'approval';
    if (!ticking) return undefined;
    // Recompute on entry so a status change shows the true elapsed time now,
    // not after the first tick. The clock is displayed in whole seconds, so a
    // 250 ms tick bought no extra information while forcing a full repaint of
    // the whole scrollback four times a second (owner, 2026-11-24: "bash tools
    // making cli lagg"). One second is the resolution the row can show.
    if (startedAtRef.current) setElapsedMs(Date.now() - startedAtRef.current);
    const id = setInterval(() => {
      if (startedAtRef.current) setElapsedMs(Date.now() - startedAtRef.current);
    }, 1000);
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

  /* One system line, owned by the transcript because the transcript is owned
   * here. Callers name a fact that is not a turn — the server restarted, an
   * update was applied — and this puts it where the operator will still see it
   * after a toast has faded. Everything it is given is measured elsewhere; it
   * adds no wording of its own. */
  const note = useCallback((text, tone = 'sys') => {
    const body = String(text == null ? '' : text).trim();
    if (!body) return;
    append({ id: nextId('sys'), role: 'system', tone, text: body });
  }, [append]);

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
      if (!prompt || statusRef.current === 'connecting' || statusRef.current === 'reconnecting' || statusRef.current === 'streaming') {
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
      // The stall clock starts with the run: silence is measured from here until
      // the first event lands.
      progressAtRef.current = Date.now();
      setLoopAt(0);
      // A new turn starts a new round budget for the meter; the session's
      // smartness and points carry over, exactly as the old CLI's did.
      try { meterRef.current.resetTask(); syncMeters(); } catch { /* metering is best-effort */ }
      toolMetaRef.current.clear();
      failuresRef.current = [];
      learnedAtStartRef.current = { ...learnedRef.current };
      // This run's recap id. It is written under every memory entry the run
      // posts, so the `#id` on the idle recap is a real pointer into the
      // banks — not a label (owner, 2026-11-25: "each recap will have id # to
      // go stright to for issues in mem").
      const recapId = `#${Date.now().toString(36).slice(-6)}`;

      // ── The ladder ──────────────────────────────────────────────────────
      // Cheap DeepSeek first, Codex next, the server's own waterfall last
      // (src/models/ladder.js). One attempt at a time; an attempt that failed
      // before producing anything hands the same prompt to the next entry when
      // the owner's auto-handoff switch is on.
      let attempts = attemptsFor(model, provider);
      if (attempts.length && provider && attempts[0].provider !== provider) {
        // An explicit HAKSTER_PROVIDER / caller provider answers first. The lane
        // is MOVED to the front rather than swapping tier 1's provider in place,
        // so the rest of the ladder (claude-cli, Codex, the server waterfall)
        // stays behind it as the fallback chain.
        const chosen = attempts.find((a) => a.provider === provider) || { ...attempts[0], provider };
        attempts = [
          chosen,
          ...attempts.filter((a) => (a.provider || '') !== (chosen.provider || '') || (a.model || '') !== (chosen.model || '')),
        ];
      }
      // A handoff must never spend a turn re-running an identical request, so
      // any remaining duplicate lane is dropped.
      for (let i = attempts.length - 1; i > 0; i -= 1) {
        const dup = attempts.slice(0, i).some(
          (a) => (a.provider || '') === (attempts[i].provider || '') && (a.model || '') === (attempts[i].model || ''),
        );
        if (dup) attempts.splice(i, 1);
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
        progressAtRef.current = Date.now();
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
            // The server read this mid-run and put it in front of the model.
            // Shown as the operator's own line, because that is whose words
            // they are — and because a steer that never appeared would look
            // like it was dropped.
            const text = String(evt.content || '').trim();
            // Drawn INSIDE the run it corrected, not as a new turn after it —
            // see utils/steer-rounds.js for why a trailing turn blocked the
            // output panel (owner, 2026-11-25: "when i send messeages steer
            // they dont clear and block my outputpanel"). One marker round,
            // then a fresh round, so the answer continues underneath it.
            patch(assistantId, (m) => applySteer(m, text, !!evt.supersede));
            if (text) pushActivity('sys', evt.supersede ? '↳ live steer — reply restarted with it' : '↳ live steer applied');
            break;
          }

          case 'steer_undelivered': {
            // The run ended before it could read these. Hand them to the TUI's
            // queue instead of losing them with the run's inbox.
            const items = Array.isArray(evt.items) ? evt.items.map((t) => String(t)).filter(Boolean) : [];
            if (items.length) {
              pushActivity('sys', `\u21ba ${items.length} steer queued for the next run`);
              try { onSteerUndeliveredRef.current && onSteerUndeliveredRef.current(items); } catch { /* queueing is best-effort */ }
            }
            break;
          }

          case 'loop_detected':
            // A loop break is a real penalty in the old CLI (-10) — the same
            // cost here, so the bar tells the truth about a bad run.
            try { meterRef.current.bump(-10); syncMeters(); } catch { /* metering is best-effort */ }
            setLoopAt(Date.now());
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

          case 'memory_recall': {
            // The run started from what it already knows: the server scored the
            // task against its memories and put the matches in the prompt ahead
            // of the machine context (owner, 2026-11-25: "make him when starting
            // task cycle threw his memorys 1st for the task to get done faster").
            // Shown with the server's own counts — an empty recall sends nothing.
            const text = String(evt.message || `recalled ${evt.count || 0} memories`).trim();
            pushActivity('sys', text);
            append({ id: nextId('sys'), role: 'system', tone: 'notice', text });
            break;
          }

          case 'learn': {
            // The server consolidated raw memories into the banks this session
            // learns from. The 🧠/✦ autolearn meter moves on that real event
            // (+2, bounded by the same score rules as a tool outcome), and the
            // activity feed carries the counts the server reported — never an
            // invented number (owner, 2026-11-25).
            try { meterRef.current.bump(2); syncMeters(); } catch { /* metering is best-effort */ }
            try {
              const next = {
                added: learnedRef.current.added + Math.max(0, Number(evt.added) || 0),
                skills: learnedRef.current.skills + Math.max(0, Number(evt.skills) || 0),
                events: learnedRef.current.events + 1,
              };
              learnedRef.current = next;
              setLearned(next);
            } catch { /* the counters must never break the stream */ }
            const text = String(evt.message || `learned ${evt.added || 0} memories`).trim();
            pushActivity('ok', text);
            append({ id: nextId('sys'), role: 'system', tone: 'notice', text });
            break;
          }

          case 'compact': {
            // The server compacted the conversation this run is working on
            // (owner, 2026-11-25: "add compacting conversation while doing it").
            // Shown as one line in the activity feed and one notice turn, both
            // from the event's own counts — never a guessed percentage, and
            // nothing in the output panels changes shape (§10, §38).
            const text = String(evt.message || 'conversation compacted').trim();
            // After a compact the conversation is the summary, not what was
            // there before — the event's own tokensAfter is the new size.
            if (Number.isFinite(Number(evt.tokensAfter)) && Number(evt.tokensAfter) > 0) {
              setContextUsed(Number(evt.tokensAfter));
            }
            pushActivity('sys', text);
            append({ id: nextId('sys'), role: 'system', tone: 'notice', text });
            break;
          }

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
            attemptCtxRef.current.terminal = true;
            append({ id: nextId('sys'), role: 'system', tone: 'warn', text: 'run aborted' });
            break;

          case 'error':
            // Recorded, not rendered: the attempt loop decides whether this
            // becomes a handoff to the next model or the turn's final error.
            // Terminal for the reconnect path: the server answered, so the
            // same turn must not be resent to it.
            attemptCtxRef.current.terminal = true;
            attemptCtxRef.current.sawError = evt.error || 'agent error';
            pushActivity('err', evt.error || 'agent error');
            setStatusBoth('error');
            break;

          case 'done': {
            // A finished turn is terminal: the reconnect path never resends a
            // turn the server already answered.
            attemptCtxRef.current.terminal = true;
            // The turn's own token report is the only honest token count there
            // is, so the session totals are a sum of exactly these reports.
            const inTok = Number(evt.inputTokens);
            const outTok = Number(evt.outputTokens);
            // The prompt of this call IS the conversation the model just read,
            // so it is the context-window reading (session totals below are
            // sums across turns and cannot answer that question). The
            // claude-cli lane sends `contextTokens` for exactly this — its
            // `inputTokens` is the turn's sum and would climb past the window —
            // and `contextWindow` is the window it is measured against.
            const ctxTok = Number(evt.contextTokens);
            const ctxWin = Number(evt.contextWindow);
            if (Number.isFinite(ctxWin) && ctxWin > 0) setContextWindow(ctxWin);
            if (Number.isFinite(ctxTok) && ctxTok > 0) setContextUsed(ctxTok);
            else if (Number.isFinite(inTok) && inTok > 0) setContextUsed(inTok);
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

      /** One dispatch of the turn on the wire: reports what happened, decides nothing. */
      const dispatchOnce = async (target, ctx) => {
        // One id per request: the server registers a steer inbox under it and
        // removes it when the stream closes, so a late steer is refused rather
        // than delivered into a run that already answered.
        const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        activeRunIdRef.current = runId;
        const controller = new AbortController();
        abortRef.current = controller;
        const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
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
          // A stream that closed without a done/error frame and without ever
          // writing anything did not finish — the process went away under it.
          // Same condition as a refused connection, so it takes the same path
          // below instead of being reported as a successful empty turn.
          if (!ctx.terminal && !ctx.produced && !userAbortRef.current) {
            throw new Error('stream closed before the turn reported anything');
          }
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
          return {
            ok: false,
            aborted: false,
            transport: isTransportError(e),
            ...ctx,
            error: (e && e.message) || 'request failed',
          };
        } finally {
          clearTimeout(timeout);
        }
      };

      /* Run one attempt and report what happened; decide nothing.
       *
       * A connection that drops while the server restarts is retried on the
       * same target instead of burning a handoff or ending the session. The
       * retry is bounded by one window per attempt and only ever allowed while
       * nothing was produced — once prose or a tool result has been shown,
       * resending would duplicate work the operator already watched happen, so
       * that case is returned as an error exactly as it was before.
       */
      const runAttempt = async (target) => {
        const ctx = { produced: false, sawError: null, status: null, terminal: false };
        attemptCtxRef.current = ctx;
        pushActivity('sys', `→ ${target.label || target.provider || 'auto'}`);
        let reconnectUntil = 0;
        let announced = false;

        for (;;) {
          // Every dispatch counts against the session's request meter: the
          // retry after a restart is a request the server really served.
          requestsRef.current += 1;
          setRequests(requestsRef.current);
          const res = await dispatchOnce(target, ctx);
          if (res.ok || res.aborted) return res;
          // The server answered and refused the turn (bad request, signed-out
          // session, entitlement). A resend cannot fix that; the ladder owns
          // the decision from here.
          if (res.status >= 400) return res;
          // Anything already on screen stays as it is — never replay it.
          if (res.produced || res.sawError || userAbortRef.current) return res;
          // Only the server's absence is a reconnect. Anything else that is
          // not a transport failure belongs to the ladder's own decision.
          if (!res.transport) return res;

          if (!reconnectUntil) reconnectUntil = Date.now() + RECONNECT_WINDOW_MS;
          if (Date.now() >= reconnectUntil) {
            return { ...res, error: 'server did not come back — turn not sent' };
          }
          setStatusBoth('reconnecting');
          if (!announced) {
            append({ id: nextId('sys'), role: 'system', tone: 'warn', text: 'server went away — reconnecting…' });
            pushActivity('warn', 'server gone · reconnecting');
            announced = true;
          }
          const back = await waitForServer(api, {
            windowMs: Math.max(1000, reconnectUntil - Date.now()),
            key: process.env.HAKSTER_API_KEY,
            isCancelled: () => userAbortRef.current,
          });
          if (userAbortRef.current) return { ...res, aborted: true, error: 'run cancelled' };
          if (!back) return { ...res, error: 'server did not come back — turn not sent' };
          append({ id: nextId('sys'), role: 'system', tone: 'notice', text: 'reconnected — resending the turn' });
          pushActivity('sys', 'reconnected · resending');
          setStatusBoth('connecting');
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

      // ── Recap → memory ──────────────────────────────────────────────────
      // One summary per finished run, under the id the recap row shows: the
      // mistakes it hit and what it learned. The server writes it into the
      // autolearn pipeline (failures as `error`, the run as a `lesson`), so the
      // next session recalls it and the same mistake is not made twice. The
      // post is fire-and-forget — the TUI goes idle immediately — and every
      // number in it is the meter's own count, never an estimate (§10).
      try {
        const snap = meterRef.current.snapshot();
        const start = learnedAtStartRef.current || { added: 0, skills: 0, events: 0 };
        const recap = {
          id: recapId,
          at: Date.now(),
          // What the run was: the row states it, so the recap says what it is a
          // recap OF (owner, 2026-11-26: "make sure the recapp is working and
          // says what the recap is"). The task as sent, not a rewritten title.
          task: String(prompt || '').replace(/\s+/g, ' ').trim().slice(0, 200),
          tools: snap.rounds,
          ok: snap.successes,
          fail: snap.failures,
          points: snap.points,
          learned: Math.max(0, learnedRef.current.added - start.added),
          learnedSkills: Math.max(0, learnedRef.current.skills - start.skills),
          failures: failuresRef.current.slice(0, 5),
        };
        setLastRecap(recap);
        if (snap.rounds > 0) {
          fetch(`${api}/api/agent/session-summary`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(process.env.HAKSTER_API_KEY ? { 'x-api-key': process.env.HAKSTER_API_KEY } : {}),
            },
            body: JSON.stringify({ ...recap, task: prompt, sessionId, cwd }),
            keepalive: true,
          })
            .then((r) => (r.ok ? r.json() : null))
            .then((data) => {
              // Say what memory actually took, not that it was sent: the recap
              // row gains `mem N` only from the server's accepted-entry count.
              if (!data || data.ok !== true) return;
              setLastRecap((prev) => (prev && prev.id === recapId ? { ...prev, memWritten: Number(data.written) || 0 } : prev));
            })
            .catch(() => { /* memory capture is best-effort; the row still shows the run */ });
        }
      } catch { /* the recap must never fail a finished run */ }

      // How long the turn took, stamped on its own card (owner, 2026-11-26:
      // "add on hakster output card to HAKSTER-AI AND HIS TIME HE TOOK TO
      // RESPOND ON CARD"). One measurement taken when the ladder finishes —
      // success, failure and cancel all arrive here — written onto the turn's
      // own message so the card can state it. `patch` no-ops when the card was
      // dropped (a failed turn that never spoke), so nothing is invented and no
      // orphan time floats in the transcript (§10).
      const turnMs = startedAtRef.current ? Math.max(0, Date.now() - startedAtRef.current) : 0;
      if (turnMs) patch(assistantId, (m) => ({ ...m, ms: turnMs, finishedAt: Date.now() }));

      abortRef.current = null;
      activeRunIdRef.current = null;
      // Once the stream is over there is nothing left to answer: a pending
      // approval whose socket has closed can no longer be reported anywhere.
      setPending(null);
      setElapsedMs(turnMs);
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
    if (!prompt || statusRef.current === 'connecting' || statusRef.current === 'reconnecting' || statusRef.current === 'streaming') return false;
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
    setContextUsed(0);
    setContextWindow(0);
    setLearned({ added: 0, skills: 0, events: 0 });
    learnedRef.current = { added: 0, skills: 0, events: 0 };
    setLastRecap(null);
    failuresRef.current = [];
    requestsRef.current = 0;
    startedAtRef.current = null;
    progressAtRef.current = 0;
    setLoopAt(0);
  }, [abort, setPending]);

  const busy =
    status === 'connecting' ||
    status === 'reconnecting' ||
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
    learned,
    lastRecap,
    activity,
    progressAtRef,
    loopAt,
    requests,
    tokens,
    contextUsed,
    contextWindow,
    pendingConfirm,
    answerConfirm,
    send,
    steer,
    abort,
    clear,
    note,
  };
}

export default useAgentStream;
