import { useCallback, useEffect, useRef, useState } from 'react';

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
} = {}) {
  const [messages, setMessages] = useState([]);
  const [todos, setTodos] = useState([]);
  const [status, setStatus] = useState('idle'); // idle | connecting | thinking | streaming | error
  const [error, setError] = useState(null);
  const [elapsedMs, setElapsedMs] = useState(0);

  // A blocking approval request from the server, or null. Mirrored in a ref as
  // well as state because the answer can come from a key handler, which must
  // not depend on a stale closure to find out what it is answering.
  const [pendingConfirm, setPendingConfirm] = useState(null);
  const pendingConfirmRef = useRef(null);

  const setPending = useCallback((value) => {
    pendingConfirmRef.current = value;
    setPendingConfirm(value);
  }, []);

  const abortRef = useRef(null);
  const startedAtRef = useRef(null);
  // Mirrors `status` for the stream loop, which outlives any single render.
  const statusRef = useRef('idle');

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

  const abort = useCallback(() => {
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

  const send = useCallback(
    async (text) => {
      const prompt = String(text == null ? '' : text).trim();
      if (!prompt || statusRef.current === 'connecting' || statusRef.current === 'streaming') {
        return;
      }

      append({ id: nextId('user'), role: 'user', text: prompt });
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

      const controller = new AbortController();
      abortRef.current = controller;
      const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

      /** Apply one decoded SSE payload to the transcript. */
      const applyEvent = (evt) => {
        if (!evt || typeof evt !== 'object') return;
        switch (evt.type) {
          case 'delta':
            setStatusBoth('streaming');
            patch(assistantId, (m) => ({ ...m, text: m.text + (evt.content || '') }));
            break;

          case 'thinking_start':
            setStatusBoth('thinking');
            patch(assistantId, (m) => ({ ...m, thinking: '' }));
            break;

          case 'thinking':
            setStatusBoth('thinking');
            patch(assistantId, (m) => ({ ...m, thinking: m.thinking + (evt.content || '') }));
            break;

          case 'thinking_end':
            // The reasoning is kept on the message so the operator can still
            // read it after the answer lands; only the spinner stops.
            break;

          case 'phase':
            if (evt.phase) patch(assistantId, (m) => ({ ...m, phase: evt.phase }));
            break;

          case 'tool_call_start': {
            const name = evt.tool_name || 'unknown';
            // The checklist is a tool call, not a panel event, so this is where
            // the panel's data actually comes from.
            if (name === 'update_todo' || name === 'plan') {
              const raw = (evt.tool_args && (evt.tool_args.todos || evt.tool_args.steps)) || null;
              const next = name === 'plan'
                ? normalizeTodos((raw || []).map((s) => ({ text: s, status: 'pending' })))
                : normalizeTodos(raw);
              if (next) setTodos(next);
            }
            patch(assistantId, (m) => ({
              ...m,
              tools: [
                ...m.tools,
                {
                  id: evt.tool_call_id || nextId('tool'),
                  name,
                  args: evt.tool_args || {},
                  result: null,
                },
              ],
            }));
            break;
          }

          case 'tool_call_result':
          case 'tool_result': {
            const result = String(
              evt.tool_result != null ? evt.tool_result : evt.result != null ? evt.result : '',
            );
            patch(assistantId, (m) => {
              const tools = m.tools.slice();
              // Match by id when the server sent one; otherwise attribute the
              // result to the most recent call still waiting for one.
              let idx = evt.tool_call_id ? tools.findIndex((t) => t.id === evt.tool_call_id) : -1;
              if (idx === -1) {
                for (let i = tools.length - 1; i >= 0; i--) {
                  if (tools[i].result === null) {
                    idx = i;
                    break;
                  }
                }
              }
              if (idx !== -1) tools[idx] = { ...tools[idx], result };
              return { ...m, tools };
            });
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
            setPending({
              toolCallId: evt.tool_call_id || null,
              toolName: evt.tool_name || 'tool',
              reason: evt.reason || 'Approval needed',
              command: evt.command || '',
            });
            break;
          }

          case 'loop_detected':
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
            setError(evt.error || 'agent error');
            setStatusBoth('error');
            append({ id: nextId('sys'), role: 'system', tone: 'error', text: evt.error || 'agent error' });
            break;

          case 'done':
            patch(assistantId, (m) => ({
              ...m,
              model: evt.model || m.model,
              tokens: evt.inputTokens != null || evt.outputTokens != null
                ? { in: evt.inputTokens, out: evt.outputTokens }
                : m.tokens,
            }));
            break;

          default:
            // Heartbeats, turn_end and any event added later are deliberately
            // ignored rather than rendered: an unknown event should be able to
            // appear on the wire without breaking an installed client.
            break;
        }
      };

      try {
        const res = await fetch(`${api}/api/agent/run`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(process.env.HAKSTER_API_KEY ? { 'x-api-key': process.env.HAKSTER_API_KEY } : {}) },
          signal: controller.signal,
          body: JSON.stringify({
            messages: [
              ...(system ? [{ role: 'system', content: system }] : []),
              { role: 'user', content: prompt },
            ],
            stream: true,
            provider,
            model,
            ...(cwd ? { cwd } : {}),
            ...(sessionId ? { sessionId } : {}),
            ...(approvalMode ? { approvalMode } : {}),
          }),
        });

        if (!res.ok) throw new Error(`server replied ${res.status}`);
        if (!res.body) throw new Error('server sent no stream');

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // SSE frames are newline-delimited. A partial trailing line stays in
          // the buffer, because a chunk boundary is not a frame boundary.
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

        // Only clear the spinner if the error branch has not already set one.
        if (statusRef.current !== 'error') setStatusBoth('idle');
      } catch (e) {
        if (e && e.name === 'AbortError') {
          append({ id: nextId('sys'), role: 'system', tone: 'warn', text: 'run cancelled' });
          setStatusBoth('idle');
        } else {
          const msg = (e && e.message) || 'request failed';
          setError(msg);
          setStatusBoth('error');
          append({ id: nextId('sys'), role: 'system', tone: 'error', text: msg });
        }
      } finally {
        clearTimeout(timeout);
        abortRef.current = null;
        // Once the stream is over there is nothing left to answer: a pending
        // approval whose socket has closed can no longer be reported anywhere.
        setPending(null);
        setElapsedMs(startedAtRef.current ? Date.now() - startedAtRef.current : 0);
      }
    },
    [api, append, approvalMode, cwd, model, patch, provider, sessionId, setPending, setStatusBoth, system],
  );

  const clear = useCallback(() => {
    abort();
    setPending(null);
    setMessages([]);
    setTodos([]);
    setError(null);
    setElapsedMs(0);
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
    pendingConfirm,
    answerConfirm,
    send,
    abort,
    clear,
  };
}

export default useAgentStream;
