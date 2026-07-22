// ══════════════════════════════════════════════════════════════════
// haksterAi Agent — connects to the haksterAi server (port 3579)
// via WebSocket, exposes event emitter style callbacks for the TUI
// ══════════════════════════════════════════════════════════════════

import { EventEmitter } from 'events';

const SERVER_URL = process.env.HAKSTER_URL || 'ws://localhost:3579/ws';
const API_URL = process.env.HAKSTER_API_URL || 'http://localhost:3579';

// Rough context-window map so the TUI token bar reflects the actual ceiling.
const MODEL_CONTEXT = {
  'glm-5.2:cloud': 128000,
  'thudm/glm-5.2:cloud': 128000,
  'thudm/glm-5.1:cloud-ctx': 128000,
  'thudm/glm-5.1:cloud': 128000,
  'gpt-oss:120b-cloud': 131072,
  'openai/gpt-oss-120b': 131072,
  'claude-sonnet-4-5': 200000,
  'claude-opus-4-5': 200000,
  'claude-haiku-3-5': 200000,
  'gpt-4o': 128000,
  'openai/gpt-5.5': 128000,
  'gemini-2.5-flash': 1000000,
  'gemini-2.0-flash-lite': 1000000,
};
function getContextMax(model) {
  if (!model) return 128000;
  if (MODEL_CONTEXT[model]) return MODEL_CONTEXT[model];
  if (model.includes('claude')) return 200000;
  if (model.includes('gpt-oss') || model.includes('120b')) return 131072;
  if (model.includes('glm')) return 128000;
  return parseInt(process.env.HAKSTER_CONTEXT_MAX || '128000', 10) || 128000;
}
function estimateContextChars(msgs) {
  // O(N) but only called when the message window actually changes (see getContextInfo cache).
  let chars = 0;
  for (const m of msgs) {
    chars += (m.content?.length || 0);
    if (m.tool_calls) {
      for (const tc of m.tool_calls) {
        // Cheap size estimate: name + serialized args length. Avoids a full JSON.stringify
        // of the whole tool_calls array every poll, which burned cycles (and thus CPU
        // "tokens") every second while idle.
        chars += (tc?.function?.name?.length || 0) + (tc?.function?.arguments?.length || 0) + 16;
      }
    }
  }
  return chars;
}

class HaksterAgent extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.model = process.env.HAKSTER_MODEL || 'glm-5.2:cloud';
    this.sessionId = null;
    this.connected = false;
    this.lowToken = process.env.HAKSTER_LOW_TOKEN === '1' || process.env.HAKSTER_LOW_TOKEN === 'true';
    this.contextMax = getContextMax(this.model);
    this._messages = [];
    this._ctxSig = '';
    this._ctxChars = 0;
    this._pendingContent = '';
    this._pendingThinking = '';
    this._pendingToolCalls = [];
    this._pendingToolResults = [];
    this._usePolling = false;

    // Callbacks
    this._tokenCb = null;
    this._thinkingCb = null;
    this._thinkingStartCb = null;
    this._thinkingEndCb = null;
    this._toolStartCb = null;
    this._toolEndCb = null;
    this._planCb = null;
    this._diffCb = null;
    this._approvalCb = null;
    this._statusCb = null;
    this._queueCb = null;
    this._queueUpdateCb = null;
    this._phaseCb = null;
    this._doneCb = null;
    this._errorCb = null;
    this._sessionsCb = null;
    this._sessionCb = null;
    this._streamCb = null;
  }

  // ── Event registration (TUI calls these) ──────────────
  onToken(cb)           { this._tokenCb = cb; }
  onThinkingStart(cb)    { this._thinkingStartCb = cb; }
  onThinking(cb)         { this._thinkingCb = cb; }
  onThinkingEnd(cb)      { this._thinkingEndCb = cb; }
  onToolStart(cb)        { this._toolStartCb = cb; }
  onToolEnd(cb)          { this._toolEndCb = cb; }
  onStatus(cb)           { this._statusCb = cb; }
  onQueue(cb)            { this._queueCb = cb; }
  onQueueUpdate(cb)      { this._queueCb = cb; }
  onPhase(cb)            { this._phaseCb = cb; }
  onPlan(cb)             { this._planCb = cb; }
  onDiff(cb)             { this._diffCb = cb; }
  onApproval(cb)         { this._approvalCb = cb; }
  onSessions(cb)         { this._sessionsCb = cb; }
  onSessionChange(cb)    { this._sessionCb = cb; }
  onStream(cb)           { this._streamCb = cb; }
  onDone(cb)             { this._doneCb = cb; }
  onError(cb)            { this._errorCb = cb; }

  // ── Connect via WebSocket ────────────────────────────
  async connect() {
    return new Promise((resolve) => {
      try {
        this.ws = new WebSocket(SERVER_URL);
        this.ws.onopen = () => {
          this.connected = true;
          resolve();
        };
        this.ws.onmessage = (event) => {
          try {
            const data = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString());
            this._handleMessage(data);
          } catch (e) {
            // ignore parse errors
          }
        };
        this.ws.onerror = (err) => {
          if (!this.connected) {
            this._usePolling = true;
            resolve();
          } else if (this._errorCb) {
            this._errorCb('WebSocket error');
          }
        };
        this.ws.onclose = () => {
          this.connected = false;
        };
        setTimeout(() => {
          if (!this.connected) {
            this._usePolling = true;
            resolve();
          }
        }, 2000);
      } catch (e) {
        this._usePolling = true;
        resolve();
      }
    });
  }

  // ── Accumulate assistant/tool messages for history ────
  _accumulateMessage(msg) {
    const { type, content, ...rest } = msg;
    switch (type) {
      case 'token':
      case 'content':
      case 'delta':
        if (content) this._pendingContent += content;
        break;
      case 'thinking':
        if (content) this._pendingThinking += content;
        break;
      case 'tool_call_start':
        this._pendingToolCalls.push({
          id: rest.tool_call_id || `call_${this._pendingToolCalls.length}`,
          type: 'function',
          function: {
            name: rest.tool_name || rest.tool || rest.name || 'tool',
            arguments: typeof rest.tool_args === 'object' ? JSON.stringify(rest.tool_args || {}) : String(rest.tool_args || '{}'),
          },
        });
        break;
      case 'tool_call_result':
      case 'tool_result':
        this._pendingToolResults.push({
          tool_call_id: rest.tool_call_id || rest.tool_call_id,
          name: rest.tool_name || rest.tool || rest.name || 'tool',
          content: rest.tool_result || rest.result || content || '',
        });
        break;
      case 'done':
      case 'complete':
        this._flushPendingMessages();
        break;
    }
  }

  _flushPendingMessages() {
    if (!this._pendingContent && !this._pendingThinking && this._pendingToolCalls.length === 0 && this._pendingToolResults.length === 0) return;
    const toolCalls = this._pendingToolCalls.length ? this._pendingToolCalls : undefined;
    this._messages.push({
      role: 'assistant',
      content: this._pendingContent.trim() || (this._pendingThinking ? `${this._pendingThinking.trim()}` : ''),
      ...(toolCalls ? { tool_calls: toolCalls } : {}),
    });
    for (const tr of this._pendingToolResults) {
      this._messages.push({
        role: 'tool',
        tool_call_id: tr.tool_call_id,
        name: tr.name,
        content: tr.content,
      });
    }
    // Keep a bounded rolling window so we don't burn tokens on ancient history
    if (this._messages.length > 60) {
      this._messages = this._messages.slice(-60);
    }
    this._pendingContent = '';
    this._pendingThinking = '';
    this._pendingToolCalls = [];
    this._pendingToolResults = [];
  }

  // ── Handle incoming messages ──────────────────────────
  _handleMessage(msg) {
    const { type, content, ...rest } = msg;
    switch (type) {
      case 'token':
      case 'content':
      case 'delta':
        if (content && this._tokenCb) this._tokenCb(content);
        break;
      case 'thinking':
        if (this._thinkingStartCb) this._thinkingStartCb();
        if (content && this._thinkingCb) this._thinkingCb(content);
        break;
      case 'thinking_end':
        if (this._thinkingEndCb) this._thinkingEndCb();
        break;
      case 'tool_start':
        if (this._toolStartCb) this._toolStartCb(rest.tool || rest.name || content || 'tool');
        break;
      case 'tool_end':
      case 'tool_result':
        if (this._toolEndCb) this._toolEndCb(rest.tool || rest.name || content || 'tool', rest.result || content);
        break;
      case 'status':
        if (this._statusCb) this._statusCb(content || rest);
        break;
      case 'queue':
        if (this._queueCb) this._queueCb(rest.items || content || []);
        if (this._queueUpdateCb) this._queueUpdateCb(rest.items || content || []);
        break;
      case 'phase':
        if (this._phaseCb) this._phaseCb(content || rest.phase);
        break;
      case 'plan':
        if (this._planCb) this._planCb(rest.plan || content || rest);
        break;
      case 'diff':
        if (this._diffCb) this._diffCb(rest.diff || content || rest);
        break;
      case 'approval':
        if (this._approvalCb) this._approvalCb(rest);
        break;
      case 'needs_confirmation':
        if (this._approvalCb) this._approvalCb(rest);
        break;
      case 'done':
      case 'complete':
        if (this._doneCb) this._doneCb(rest);
        break;
      case 'error':
        if (this._errorCb) this._errorCb(content || 'Unknown error');
        break;
      default:
        if (content && this._tokenCb) this._tokenCb(content);
    }
    // Accumulate assistant/tool context for history tracking
    this._accumulateMessage(msg);
  }

  // ── Send message to server ────────────────────────────
  async send(message) {
    this._messages.push({ role: 'user', content: message });
    await this._sendAgentRun(message);
  }

  async _sendAgentRun(message) {
    try {
      const res = await fetch(`${API_URL}/api/agent/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: this._messages.slice(-20),
          model: this.model,
          sessionId: this.sessionId,
          cwd: this.cwd || process.cwd(),
        }),
      });
      if (!res.ok) {
        if (this._errorCb) this._errorCb(`HTTP ${res.status}`);
        return;
      }
      // Read SSE stream
      const reader = res.body?.getReader();
      if (!reader) {
        const text = await res.text();
        try {
          const data = JSON.parse(text);
          this._handleMessage(data);
        } catch {}
        return;
      }
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // Split on newlines; keep the trailing partial line in the buffer.
        // Handle CRLF robustly and tolerate `data:` with no trailing space.
        let nl;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          let line = buffer.slice(0, nl);
          if (line.endsWith('\r')) line = line.slice(0, -1);
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          if (line[0] === 'd' && line.startsWith('data:')) {
            const payload = line[5] === ' ' ? line.slice(6) : line.slice(5);
            if (!payload) continue;
            try {
              this._handleMessage(JSON.parse(payload));
            } catch {}
          }
        }
      }
      this._flushPendingMessages();
    } catch (e) {
      if (this._errorCb) this._errorCb(e.message || 'Request failed');
    }
  }

  // ── Model selection ──────────────────────────────────
  setModel(model) {
    this.model = model;
    this.contextMax = getContextMax(model);
  }
  setProvider(p) { this.provider = p; }
  setTrust(lvl) { this.trust = lvl; }
  getModel() { return this.model; }
  getContextInfo() {
    // Cache by message-window signature so the TUI's periodic poll does NOT recompute
    // (and re-render) when nothing changed. Recompute only when length, last content
    // size, or tool-call count changes.
    const m = this._messages;
    const last = m[m.length - 1];
    const sig = `${m.length}:${last ? (last.content?.length || 0) : 0}:${last ? (last.tool_calls?.length || 0) : 0}`;
    if (this._ctxSig !== sig) {
      this._ctxSig = sig;
      this._ctxChars = estimateContextChars(m);
    }
    return {
      chars: this._ctxChars,
      max: this.contextMax,
      messages: m.length,
    };
  }

  // ── Session management ───────────────────────────────
  setSession(id) {
    this.sessionId = id;
    if (this._sessionCb) this._sessionCb(id);
  }

  async listSessions() {
    try {
      const res = await fetch(`${API_URL}/api/sessions`);
      if (res.ok) {
        const data = await res.json();
        if (this._sessionsCb) this._sessionsCb(data.sessions || data || []);
        return data.sessions || data || [];
      }
    } catch {}
    return [];
  }

  // ── Approval response ────────────────────────────────
  async respondApproval(toolCallId, approved, permanent = false, session = false, password = '') {
    try {
      await fetch(`${API_URL}/api/agent/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: this.sessionId || '',
          toolCallId,
          approved,
          command: '',
          permanent,
          session,
          password,
        }),
      });
    } catch {}
  }

  // ── Abort current request ─────────────────────────────
  abort() {
    if (this.ws) {
      try { this.ws.close(); } catch {}
    }
    this._messages = [];
    this._pendingContent = '';
    this._pendingThinking = '';
    this._pendingToolCalls = [];
    this._pendingToolResults = [];
  }
}

const agent = new HaksterAgent();
export default agent;
export { HaksterAgent };