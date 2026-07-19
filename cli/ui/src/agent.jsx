// ══════════════════════════════════════════════════════════════════
// haksterAi Agent — connects to the haksterAi server (port 3579)
// via WebSocket, exposes event emitter style callbacks for the TUI
// ══════════════════════════════════════════════════════════════════

import { EventEmitter } from 'events';

const SERVER_URL = process.env.HAKSTER_URL || 'ws://localhost:3579/ws';
const API_URL = process.env.HAKSTER_API_URL || 'http://localhost:3579';

class HaksterAgent extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.model = process.env.HAKSTER_MODEL || 'glm-5.2:cloud';
    this.sessionId = null;
    this.connected = false;
    this.lowToken = process.env.HAKSTER_LOW_TOKEN === '1' || process.env.HAKSTER_LOW_TOKEN === 'true';
    this.contextMax = 0;
    this._messages = [];
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
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              this._handleMessage(data);
            } catch {}
          }
        }
      }
    } catch (e) {
      if (this._errorCb) this._errorCb(e.message || 'Request failed');
    }
  }

  // ── Model selection ──────────────────────────────────
  setModel(model) { this.model = model; }
  setProvider(p) { this.provider = p; }
  setTrust(lvl) { this.trust = lvl; }
  getModel() { return this.model; }

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
  async respondApproval(toolCallId, approved, permanent = false) {
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
  }
}

const agent = new HaksterAgent();
export default agent;
export { HaksterAgent };