// Built by esbuild — do not edit. Run: node build.mjs

// src/index.jsx
import React18 from "react";
import { render } from "ink";

// src/App.jsx
import React17, { useState as useState9, useEffect as useEffect6, useRef as useRef3, useCallback, useMemo as useMemo4 } from "react";
import { Box as Box16, Text as Text17, useInput as useInput5, useApp, useStdout } from "ink";

// src/agent.jsx
import { EventEmitter } from "events";
var SERVER_URL = process.env.HAKSTER_URL || "ws://localhost:3579/ws";
var API_URL = process.env.HAKSTER_API_URL || "http://localhost:3579";
var MODEL_CONTEXT = {
  "glm-5.2:cloud": 128e3,
  "thudm/glm-5.2:cloud": 128e3,
  "thudm/glm-5.1:cloud-ctx": 128e3,
  "thudm/glm-5.1:cloud": 128e3,
  "gpt-oss:120b-cloud": 131072,
  "openai/gpt-oss-120b": 131072,
  "claude-sonnet-4-5": 2e5,
  "claude-opus-4-5": 2e5,
  "claude-haiku-3-5": 2e5,
  "gpt-4o": 128e3,
  "openai/gpt-5.5": 128e3,
  "gemini-2.5-flash": 1e6,
  "gemini-2.0-flash-lite": 1e6
};
function getContextMax(model) {
  if (!model) return 128e3;
  if (MODEL_CONTEXT[model]) return MODEL_CONTEXT[model];
  if (model.includes("claude")) return 2e5;
  if (model.includes("gpt-oss") || model.includes("120b")) return 131072;
  if (model.includes("glm")) return 128e3;
  return parseInt(process.env.HAKSTER_CONTEXT_MAX || "128000", 10) || 128e3;
}
function estimateContextChars(msgs) {
  let chars = 0;
  for (const m of msgs) {
    chars += m.content?.length || 0;
    if (m.tool_calls) {
      for (const tc of m.tool_calls) {
        chars += (tc?.function?.name?.length || 0) + (tc?.function?.arguments?.length || 0) + 16;
      }
    }
  }
  return chars;
}
var HaksterAgent = class extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.model = process.env.HAKSTER_MODEL || "glm-5.2:cloud";
    this.sessionId = null;
    this.connected = false;
    this.lowToken = process.env.HAKSTER_LOW_TOKEN === "1" || process.env.HAKSTER_LOW_TOKEN === "true";
    this.contextMax = getContextMax(this.model);
    this._messages = [];
    this._ctxSig = "";
    this._ctxChars = 0;
    this._pendingContent = "";
    this._pendingThinking = "";
    this._pendingToolCalls = [];
    this._pendingToolResults = [];
    this._usePolling = false;
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
  onToken(cb) {
    this._tokenCb = cb;
  }
  onThinkingStart(cb) {
    this._thinkingStartCb = cb;
  }
  onThinking(cb) {
    this._thinkingCb = cb;
  }
  onThinkingEnd(cb) {
    this._thinkingEndCb = cb;
  }
  onToolStart(cb) {
    this._toolStartCb = cb;
  }
  onToolEnd(cb) {
    this._toolEndCb = cb;
  }
  onStatus(cb) {
    this._statusCb = cb;
  }
  onQueue(cb) {
    this._queueCb = cb;
  }
  onQueueUpdate(cb) {
    this._queueCb = cb;
  }
  onPhase(cb) {
    this._phaseCb = cb;
  }
  onPlan(cb) {
    this._planCb = cb;
  }
  onDiff(cb) {
    this._diffCb = cb;
  }
  onApproval(cb) {
    this._approvalCb = cb;
  }
  onSessions(cb) {
    this._sessionsCb = cb;
  }
  onSessionChange(cb) {
    this._sessionCb = cb;
  }
  onStream(cb) {
    this._streamCb = cb;
  }
  onDone(cb) {
    this._doneCb = cb;
  }
  onError(cb) {
    this._errorCb = cb;
  }
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
            const data = JSON.parse(typeof event.data === "string" ? event.data : event.data.toString());
            this._handleMessage(data);
          } catch (e) {
          }
        };
        this.ws.onerror = (err) => {
          if (!this.connected) {
            this._usePolling = true;
            resolve();
          } else if (this._errorCb) {
            this._errorCb("WebSocket error");
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
        }, 2e3);
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
      case "token":
      case "content":
      case "delta":
        if (content) this._pendingContent += content;
        break;
      case "thinking":
        if (content) this._pendingThinking += content;
        break;
      case "tool_call_start":
        this._pendingToolCalls.push({
          id: rest.tool_call_id || `call_${this._pendingToolCalls.length}`,
          type: "function",
          function: {
            name: rest.tool_name || rest.tool || rest.name || "tool",
            arguments: typeof rest.tool_args === "object" ? JSON.stringify(rest.tool_args || {}) : String(rest.tool_args || "{}")
          }
        });
        break;
      case "tool_call_result":
      case "tool_result":
        this._pendingToolResults.push({
          tool_call_id: rest.tool_call_id || rest.tool_call_id,
          name: rest.tool_name || rest.tool || rest.name || "tool",
          content: rest.tool_result || rest.result || content || ""
        });
        break;
      case "done":
      case "complete":
        this._flushPendingMessages();
        break;
    }
  }
  _flushPendingMessages() {
    if (!this._pendingContent && !this._pendingThinking && this._pendingToolCalls.length === 0 && this._pendingToolResults.length === 0) return;
    const toolCalls = this._pendingToolCalls.length ? this._pendingToolCalls : void 0;
    this._messages.push({
      role: "assistant",
      content: this._pendingContent.trim() || (this._pendingThinking ? `${this._pendingThinking.trim()}` : ""),
      ...toolCalls ? { tool_calls: toolCalls } : {}
    });
    for (const tr of this._pendingToolResults) {
      this._messages.push({
        role: "tool",
        tool_call_id: tr.tool_call_id,
        name: tr.name,
        content: tr.content
      });
    }
    if (this._messages.length > 60) {
      this._messages = this._messages.slice(-60);
    }
    this._pendingContent = "";
    this._pendingThinking = "";
    this._pendingToolCalls = [];
    this._pendingToolResults = [];
  }
  // ── Handle incoming messages ──────────────────────────
  _handleMessage(msg) {
    const { type, content, ...rest } = msg;
    switch (type) {
      case "token":
      case "content":
      case "delta":
        if (content && this._tokenCb) this._tokenCb(content);
        break;
      case "thinking":
        if (this._thinkingStartCb) this._thinkingStartCb();
        if (content && this._thinkingCb) this._thinkingCb(content);
        break;
      case "thinking_end":
        if (this._thinkingEndCb) this._thinkingEndCb();
        break;
      case "tool_start":
        if (this._toolStartCb) this._toolStartCb(rest.tool || rest.name || content || "tool");
        break;
      case "tool_end":
      case "tool_result":
        if (this._toolEndCb) this._toolEndCb(rest.tool || rest.name || content || "tool", rest.result || content);
        break;
      case "status":
        if (this._statusCb) this._statusCb(content || rest);
        break;
      case "queue":
        if (this._queueCb) this._queueCb(rest.items || content || []);
        if (this._queueUpdateCb) this._queueUpdateCb(rest.items || content || []);
        break;
      case "phase":
        if (this._phaseCb) this._phaseCb(content || rest.phase);
        break;
      case "plan":
        if (this._planCb) this._planCb(rest.plan || content || rest);
        break;
      case "diff":
        if (this._diffCb) this._diffCb(rest.diff || content || rest);
        break;
      case "approval":
        if (this._approvalCb) this._approvalCb(rest);
        break;
      case "needs_confirmation":
        if (this._approvalCb) this._approvalCb(rest);
        break;
      case "done":
      case "complete":
        if (this._doneCb) this._doneCb(rest);
        break;
      case "error":
        if (this._errorCb) this._errorCb(content || "Unknown error");
        break;
      default:
        if (content && this._tokenCb) this._tokenCb(content);
    }
    this._accumulateMessage(msg);
  }
  // ── Send message to server ────────────────────────────
  async send(message) {
    this._messages.push({ role: "user", content: message });
    await this._sendAgentRun(message);
  }
  async _sendAgentRun(message) {
    try {
      const res = await fetch(`${API_URL}/api/agent/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: this._messages.slice(-20),
          model: this.model,
          sessionId: this.sessionId,
          cwd: this.cwd || process.cwd()
        })
      });
      if (!res.ok) {
        if (this._errorCb) this._errorCb(`HTTP ${res.status}`);
        return;
      }
      const reader = res.body?.getReader();
      if (!reader) {
        const text = await res.text();
        try {
          const data = JSON.parse(text);
          this._handleMessage(data);
        } catch {
        }
        return;
      }
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          let line = buffer.slice(0, nl);
          if (line.endsWith("\r")) line = line.slice(0, -1);
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          if (line[0] === "d" && line.startsWith("data:")) {
            const payload = line[5] === " " ? line.slice(6) : line.slice(5);
            if (!payload) continue;
            try {
              this._handleMessage(JSON.parse(payload));
            } catch {
            }
          }
        }
      }
      this._flushPendingMessages();
    } catch (e) {
      if (this._errorCb) this._errorCb(e.message || "Request failed");
    }
  }
  // ── Model selection ──────────────────────────────────
  setModel(model) {
    this.model = model;
    this.contextMax = getContextMax(model);
  }
  setProvider(p) {
    this.provider = p;
  }
  setTrust(lvl) {
    this.trust = lvl;
  }
  getModel() {
    return this.model;
  }
  getContextInfo() {
    const m = this._messages;
    const last = m[m.length - 1];
    const sig = `${m.length}:${last ? last.content?.length || 0 : 0}:${last ? last.tool_calls?.length || 0 : 0}`;
    if (this._ctxSig !== sig) {
      this._ctxSig = sig;
      this._ctxChars = estimateContextChars(m);
    }
    return {
      chars: this._ctxChars,
      max: this.contextMax,
      messages: m.length
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
    } catch {
    }
    return [];
  }
  // ── Approval response ────────────────────────────────
  async respondApproval(toolCallId, approved, permanent = false, session = false, password = "") {
    try {
      await fetch(`${API_URL}/api/agent/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: this.sessionId || "",
          toolCallId,
          approved,
          command: "",
          permanent,
          session,
          password
        })
      });
    } catch {
    }
  }
  // ── Abort current request ─────────────────────────────
  abort() {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
      }
    }
    this._messages = [];
    this._pendingContent = "";
    this._pendingThinking = "";
    this._pendingToolCalls = [];
    this._pendingToolResults = [];
  }
};
var agent = new HaksterAgent();
var agent_default = agent;

// src/components/StatusBar.jsx
import React from "react";
import { Box, Text } from "ink";
import { jsx, jsxs } from "react/jsx-runtime";
var TRUST_LABELS = {
  0: { label: "SUGGEST", color: "yellow" },
  10: { label: "AUTO_EDIT", color: "cyan" },
  30: { label: "FULL_AUTO", color: "green" }
};
function getTrustInfo(level = 0) {
  if (level >= 30) return TRUST_LABELS[30];
  if (level >= 10) return TRUST_LABELS[10];
  return TRUST_LABELS[0];
}
function StatusBar({
  model = "unknown",
  provider = "unknown",
  trustLevel = 0,
  approvalMode = "on-request",
  contextUsed = 0,
  contextMax = 128e3,
  phase = "IDLE",
  cols = 80,
  sessionId = ""
}) {
  const trust = getTrustInfo(trustLevel);
  const ctxPct = Math.round(contextUsed / contextMax * 100);
  const ctxColor = ctxPct > 85 ? "red" : ctxPct > 60 ? "yellow" : "green";
  const ctxBar = "\u2588".repeat(Math.floor(ctxPct / 5)).padEnd(20, "\u2591");
  const left = `${model}\u2502${provider}`;
  const right = `${trust.label}\u2502${approvalMode}\u2502ctx ${ctxPct}%`;
  const sid = sessionId ? sessionId.slice(0, 8) : "--------";
  const phaseStr = `[${phase}]`;
  return /* @__PURE__ */ jsxs(Box, { flexDirection: "column", children: [
    /* @__PURE__ */ jsxs(Box, { width: cols, paddingX: 1, justifyContent: "space-between", children: [
      /* @__PURE__ */ jsx(Text, { color: "cyan", bold: true, children: left }),
      /* @__PURE__ */ jsx(Text, { color: "magenta", bold: true, children: phaseStr }),
      /* @__PURE__ */ jsxs(Text, { color: "gray", dim: true, children: [
        "session:",
        sid
      ] })
    ] }),
    /* @__PURE__ */ jsxs(Box, { width: cols, paddingX: 1, justifyContent: "space-between", children: [
      /* @__PURE__ */ jsx(Text, { color: trust.color, bold: true, children: right }),
      /* @__PURE__ */ jsxs(Text, { color: ctxColor, children: [
        "[",
        ctxBar,
        "]"
      ] })
    ] })
  ] });
}

// src/components/SlashMenu.jsx
import React2, { useState, useMemo } from "react";
import { Box as Box2, Text as Text2 } from "ink";
import { jsx as jsx2, jsxs as jsxs2 } from "react/jsx-runtime";
var COMMANDS = [
  "/help",
  "/status",
  "/model",
  "/provider",
  "/trust",
  "/approve",
  "/deny",
  "/clear",
  "/compact",
  "/diff",
  "/review",
  "/plan",
  "/sessions",
  "/resume",
  "/save",
  "/memory",
  "/skills",
  "/theme",
  "/fast",
  "/health",
  "/undo",
  "/commands",
  "/exit"
];
var DESCRIPTIONS = {
  "/help": "Show help overlay",
  "/status": "Server status",
  "/model": "Switch model",
  "/provider": "Switch provider",
  "/trust": "Set trust level",
  "/approve": "Approve pending",
  "/deny": "Deny pending",
  "/clear": "Clear output",
  "/compact": "Compact context",
  "/diff": "Toggle diff preview",
  "/review": "Code review",
  "/plan": "Show/hide plan",
  "/sessions": "List sessions",
  "/resume": "Resume session",
  "/save": "Save session",
  "/memory": "Memory summary",
  "/skills": "List skills",
  "/theme": "Switch theme",
  "/fast": "Toggle fast mode",
  "/commands": "Open commands palette popup",
  "/health": "Server health",
  "/undo": "Undo last edit",
  "/exit": "Exit CLI"
};
function SlashMenu({ query, input, cols = 80, onSelect }) {
  const q = input ?? query ?? "";
  const matches = useMemo(() => {
    if (!q) return COMMANDS;
    const lower = q.toLowerCase();
    return COMMANDS.filter((c) => c.startsWith(lower)).slice(0, 12);
  }, [q]);
  if (matches.length === 0) return null;
  return /* @__PURE__ */ jsx2(Box2, { flexDirection: "column", paddingX: 1, children: matches.map((cmd, i) => /* @__PURE__ */ jsxs2(Box2, { children: [
    /* @__PURE__ */ jsxs2(Text2, { color: i === 0 ? "green" : "gray", bold: i === 0, children: [
      i === 0 ? "\u276F " : "  ",
      cmd.padEnd(14)
    ] }),
    /* @__PURE__ */ jsx2(Text2, { color: "gray", dim: true, children: DESCRIPTIONS[cmd] || "" })
  ] }, cmd)) });
}

// src/components/HelpOverlay.jsx
import React3 from "react";
import { Box as Box3, Text as Text3 } from "ink";
import { jsx as jsx3, jsxs as jsxs3 } from "react/jsx-runtime";
var SLASH_COMMANDS = [
  { cmd: "/help", desc: "Show this help overlay" },
  { cmd: "/status", desc: "Show server status (model, trust, uptime)" },
  { cmd: "/model [name]", desc: "Switch model (e.g. /model gpt-5.2)" },
  { cmd: "/provider [name]", desc: "Switch provider (ollama, openai, anthropic, glm)" },
  { cmd: "/trust [level]", desc: "Set trust level (0=suggest, 10=auto-edit, 30=full-auto)" },
  { cmd: "/approve", desc: "Approve pending action" },
  { cmd: "/deny", desc: "Deny pending action" },
  { cmd: "/clear", desc: "Clear output buffer" },
  { cmd: "/compact", desc: "Compact context window" },
  { cmd: "/diff", desc: "Toggle diff preview before edits" },
  { cmd: "/review", desc: "Run code review on current changes" },
  { cmd: "/plan", desc: "Show/hide plan panel" },
  { cmd: "/sessions", desc: "List saved sessions" },
  { cmd: "/resume [id]", desc: "Resume a session by ID" },
  { cmd: "/save", desc: "Save current session" },
  { cmd: "/memory", desc: "Show memory summary" },
  { cmd: "/skills", desc: "List available skills" },
  { cmd: "/theme [name]", desc: "Switch color theme (default, dark, light, cyberpunk)" },
  { cmd: "/fast [on|off]", desc: "Toggle fast mode" },
  { cmd: "/health", desc: "Check server health" },
  { cmd: "/undo", desc: "Undo last file edit" },
  { cmd: "/exit", desc: "Exit haksterAi CLI" }
];
var KEYBINDINGS = [
  { key: "Enter", desc: "Send message" },
  { key: "Ctrl+C", desc: "Exit" },
  { key: "Ctrl+L", desc: "Clear screen" },
  { key: "Ctrl+U", desc: "Clear input line" },
  { key: "Ctrl+D", desc: "Exit (EOF)" },
  { key: "Ctrl+P / \u2191", desc: "Previous message (history)" },
  { key: "Ctrl+N / \u2193", desc: "Next message (history)" },
  { key: "Ctrl+\u2191", desc: "Scroll output up" },
  { key: "Ctrl+\u2193", desc: "Scroll output down" },
  { key: "PageUp", desc: "Scroll output up (page)" },
  { key: "PageDown", desc: "Scroll output down (page)" },
  { key: "Tab", desc: "Autocomplete slash command" },
  { key: "Esc", desc: "Close overlay / cancel action" },
  { key: "?", desc: "Toggle this help overlay" }
];
function HelpOverlay({ cols = 80, rows = 24, onDismiss }) {
  const half = Math.ceil(SLASH_COMMANDS.length / 2);
  const leftCol = SLASH_COMMANDS.slice(0, half);
  const rightCol = SLASH_COMMANDS.slice(half);
  const cmdWidth = cols > 100 ? 48 : cols - 30;
  return /* @__PURE__ */ jsxs3(
    Box3,
    {
      flexDirection: "column",
      borderStyle: "round",
      borderColor: "cyan",
      paddingX: 2,
      paddingY: 1,
      width: Math.min(cols, 100),
      children: [
        /* @__PURE__ */ jsx3(Box3, { justifyContent: "center", children: /* @__PURE__ */ jsx3(Text3, { color: "cyan", bold: true, children: "\u250C\u2500 haksterAi CLI \u2014 Help \u2500\u2510" }) }),
        /* @__PURE__ */ jsx3(Box3, { marginTop: 1, children: /* @__PURE__ */ jsx3(Text3, { color: "yellow", bold: true, underline: true, children: "Slash Commands" }) }),
        /* @__PURE__ */ jsxs3(Box3, { flexDirection: "row", gap: 4, marginTop: 0, children: [
          /* @__PURE__ */ jsx3(Box3, { flexDirection: "column", children: leftCol.map((c, i) => /* @__PURE__ */ jsxs3(Box3, { children: [
            /* @__PURE__ */ jsx3(Text3, { color: "green", bold: true, children: c.cmd.padEnd(18) }),
            /* @__PURE__ */ jsx3(Text3, { color: "gray", children: c.desc.slice(0, cmdWidth - 20) })
          ] }, i)) }),
          /* @__PURE__ */ jsx3(Box3, { flexDirection: "column", children: rightCol.map((c, i) => /* @__PURE__ */ jsxs3(Box3, { children: [
            /* @__PURE__ */ jsx3(Text3, { color: "green", bold: true, children: c.cmd.padEnd(18) }),
            /* @__PURE__ */ jsx3(Text3, { color: "gray", children: c.desc.slice(0, cmdWidth - 20) })
          ] }, i)) })
        ] }),
        /* @__PURE__ */ jsx3(Box3, { marginTop: 1, children: /* @__PURE__ */ jsx3(Text3, { color: "yellow", bold: true, underline: true, children: "Keybindings" }) }),
        /* @__PURE__ */ jsxs3(Box3, { flexDirection: "row", gap: 4, children: [
          /* @__PURE__ */ jsx3(Box3, { flexDirection: "column", children: KEYBINDINGS.slice(0, Math.ceil(KEYBINDINGS.length / 2)).map((k, i) => /* @__PURE__ */ jsxs3(Box3, { children: [
            /* @__PURE__ */ jsx3(Text3, { color: "magenta", bold: true, children: k.key.padEnd(16) }),
            /* @__PURE__ */ jsx3(Text3, { color: "gray", children: k.desc })
          ] }, i)) }),
          /* @__PURE__ */ jsx3(Box3, { flexDirection: "column", children: KEYBINDINGS.slice(Math.ceil(KEYBINDINGS.length / 2)).map((k, i) => /* @__PURE__ */ jsxs3(Box3, { children: [
            /* @__PURE__ */ jsx3(Text3, { color: "magenta", bold: true, children: k.key.padEnd(16) }),
            /* @__PURE__ */ jsx3(Text3, { color: "gray", children: k.desc })
          ] }, i)) })
        ] }),
        /* @__PURE__ */ jsx3(Box3, { marginTop: 1, justifyContent: "center", children: /* @__PURE__ */ jsx3(Text3, { color: "gray", dim: true, children: "Press Esc or ? to dismiss" }) })
      ]
    }
  );
}

// src/components/ModelDialog.jsx
import React4, { useState as useState2, useMemo as useMemo2, useEffect } from "react";
import { Box as Box4, Text as Text4, useInput } from "ink";
import { Fragment, jsx as jsx4, jsxs as jsxs4 } from "react/jsx-runtime";
var PROVIDERS = [
  {
    id: "glm",
    name: "GLM / Charm Cloud",
    needsKey: false,
    models: [
      { id: "glm-5.2:cloud", name: "GLM 5.2 Cloud" },
      { id: "thudm/glm-5.1:cloud", name: "GLM 5.1 Cloud" },
      { id: "thudm/glm-5.1:cloud-ctx", name: "GLM 5.1 Cloud (ctx)" }
    ]
  },
  {
    id: "anthropic",
    name: "Anthropic / Claude",
    needsKey: true,
    models: [
      { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
      { id: "claude-opus-4-5", name: "Claude Opus 4.5" },
      { id: "claude-haiku-3-5", name: "Claude Haiku 3.5" }
    ]
  },
  {
    id: "openai",
    name: "OpenAI / Codex",
    needsKey: true,
    models: [
      { id: "gpt-4o", name: "GPT-4o" },
      { id: "openai/gpt-5.5", name: "GPT-5.5" },
      { id: "gpt-5.1-codex", name: "GPT-5.1 Codex" },
      { id: "codex-mini-latest", name: "Codex Mini" },
      { id: "gpt-oss:120b-cloud", name: "GPT-OSS 120B Cloud" },
      { id: "openai/gpt-oss-120b", name: "GPT-OSS 120B" }
    ]
  },
  {
    id: "openrouter",
    name: "OpenRouter / Nous",
    needsKey: true,
    models: [
      { id: "nousresearch/hermes-3-llama-3.1-405b:free", name: "Nous Hermes 3 405B" },
      { id: "nousresearch/hermes-3-llama-3.1-70b", name: "Nous Hermes 3 70B" },
      { id: "openrouter/free", name: "OpenRouter Auto (free)" }
    ]
  },
  {
    id: "gemini",
    name: "Gemini",
    needsKey: true,
    models: [
      { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
      { id: "gemini-2.0-flash-lite", name: "Gemini 2.0 Flash Lite" }
    ]
  },
  {
    id: "ollama",
    name: "Ollama (local)",
    needsKey: false,
    models: [
      { id: "llama3.2:latest", name: "Llama 3.2 (local)" },
      { id: "hermes3", name: "Nous Hermes 3 (local)" },
      { id: "qwen2.5:32b", name: "Qwen 2.5 32B (local)" }
    ]
  }
];
var ALL_OPTIONS = PROVIDERS.flatMap(
  (p) => p.models.map((m) => ({ model: m.id, name: m.name, provider: p.id, providerName: p.name, needsKey: p.needsKey }))
);
var WIDTH = 62;
var VISIBLE_ROWS = 9;
var SPIN_FRAMES = ["\u280B", "\u2819", "\u2839", "\u2838", "\u283C", "\u2834", "\u2826", "\u2827", "\u2807", "\u280F"];
function gridLine(width) {
  return Array.from({ length: Math.max(1, Math.floor(width / 2)) }, () => "\xB7").join(" ");
}
function buildRows(matches) {
  const rows = [];
  let lastProvider = null;
  matches.forEach((o, matchIndex) => {
    if (o.provider !== lastProvider) {
      rows.push({ type: "header", label: o.providerName, key: "h:" + o.provider + ":" + matchIndex });
      lastProvider = o.provider;
    }
    rows.push({ type: "item", option: o, matchIndex, key: o.model + ":" + o.provider });
  });
  return rows;
}
function ModelDialog({
  cols = 80,
  rows = 24,
  currentModel = "",
  onSelect,
  onDismiss,
  onSetProviderKey
}) {
  const [filter, setFilter] = useState2("");
  const [idx, setIdx] = useState2(0);
  const [offset, setOffset] = useState2(0);
  const [modelType, setModelType] = useState2("large");
  const [needsAPIKey, setNeedsAPIKey] = useState2(false);
  const [selected, setSelected] = useState2(null);
  const [apiKey, setApiKey] = useState2("");
  const [reveal, setReveal] = useState2(false);
  const [keyError, setKeyError] = useState2("");
  const [saving, setSaving] = useState2(false);
  const [saved, setSaved] = useState2(false);
  const [spinFrame, setSpinFrame] = useState2(0);
  const matches = useMemo2(() => {
    const q = filter.toLowerCase();
    if (!q) return ALL_OPTIONS;
    return ALL_OPTIONS.filter(
      (o) => o.name.toLowerCase().includes(q) || o.model.toLowerCase().includes(q) || o.providerName.toLowerCase().includes(q)
    );
  }, [filter]);
  const displayRows = useMemo2(() => buildRows(matches), [matches]);
  const totalRows = displayRows.length;
  const selectedRow = useMemo2(
    () => displayRows.findIndex((r) => r.type === "item" && r.matchIndex === idx),
    [displayRows, idx]
  );
  useEffect(() => {
    if (selectedRow < 0) return;
    setOffset((o) => {
      if (selectedRow < o) return selectedRow;
      if (selectedRow > o + VISIBLE_ROWS - 1) return selectedRow - VISIBLE_ROWS + 1;
      return o;
    });
  }, [selectedRow]);
  useEffect(() => {
    if (!saving) return;
    const t2 = setInterval(() => setSpinFrame((f) => (f + 1) % SPIN_FRAMES.length), 80);
    return () => clearInterval(t2);
  }, [saving]);
  useInput((raw, key) => {
    if (needsAPIKey) {
      if (saving || saved) return;
      if (key.escape) {
        setNeedsAPIKey(false);
        setSelected(null);
        setApiKey("");
        setKeyError("");
        return;
      }
      if (key.tab) {
        setReveal((r) => !r);
        return;
      }
      if (key.return) {
        if (!apiKey.trim()) {
          setKeyError("API key cannot be empty");
          return;
        }
        setKeyError("");
        setSaving(true);
        setTimeout(() => {
          const ok = onSetProviderKey ? onSetProviderKey(selected.provider, apiKey.trim()) : true;
          setSaving(false);
          if (ok === false) {
            setKeyError("Could not save key \u2014 try again");
            return;
          }
          setSaved(true);
          setTimeout(() => onSelect?.(selected.model, selected.provider, modelType), 450);
        }, 380);
        return;
      }
      if (key.backspace || key.delete) {
        setApiKey((p) => p.slice(0, -1));
        setKeyError("");
        return;
      }
      if (raw && !key.ctrl && !key.meta && raw.length === 1) {
        setApiKey((p) => p + raw);
        setKeyError("");
        return;
      }
      return;
    }
    if (key.escape) {
      onDismiss?.();
      return;
    }
    if (key.return) {
      const opt = matches[idx];
      if (!opt) return;
      if (opt.needsKey && onSetProviderKey) {
        setSelected(opt);
        setNeedsAPIKey(true);
        setApiKey("");
        setReveal(false);
        setKeyError("");
        setSaved(false);
        return;
      }
      onSelect?.(opt.model, opt.provider, modelType);
      return;
    }
    if (key.tab) {
      setModelType((t2) => t2 === "large" ? "small" : "large");
      return;
    }
    if (key.upArrow) {
      setIdx((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setIdx((i) => Math.min(matches.length - 1, i + 1));
      return;
    }
    if (key.pageUp) {
      setIdx((i) => Math.max(0, i - VISIBLE_ROWS));
      return;
    }
    if (key.pageDown) {
      setIdx((i) => Math.min(matches.length - 1, i + VISIBLE_ROWS));
      return;
    }
    if (key.backspace || key.delete) {
      setFilter((p) => p.slice(0, -1));
      setIdx(0);
      return;
    }
    if (raw && !key.ctrl && !key.meta && raw.length === 1) {
      setFilter((p) => p + raw);
      setIdx(0);
      return;
    }
  });
  const radio = modelType === "large" ? "\u25C9 Large Task  \u25CB Small Task" : "\u25CB Large Task  \u25C9 Small Task";
  const showScrollbar = totalRows > VISIBLE_ROWS;
  let thumbStart = 0, thumbSize = VISIBLE_ROWS;
  if (showScrollbar) {
    thumbSize = Math.max(1, Math.round(VISIBLE_ROWS / totalRows * VISIBLE_ROWS));
    thumbStart = Math.round(offset / Math.max(1, totalRows - VISIBLE_ROWS) * (VISIBLE_ROWS - thumbSize));
  }
  const visible = displayRows.slice(offset, offset + VISIBLE_ROWS);
  return /* @__PURE__ */ jsxs4(Box4, { flexDirection: "column", borderStyle: "round", borderColor: "cyan", width: WIDTH, paddingX: 2, paddingY: 1, children: [
    /* @__PURE__ */ jsxs4(Box4, { justifyContent: "space-between", children: [
      /* @__PURE__ */ jsx4(Text4, { color: "cyan", bold: true, children: "Switch Model" }),
      /* @__PURE__ */ jsx4(Text4, { color: "gray", dim: true, children: radio })
    ] }),
    needsAPIKey ? /* @__PURE__ */ jsxs4(Fragment, { children: [
      /* @__PURE__ */ jsx4(Box4, { marginTop: 1, children: /* @__PURE__ */ jsxs4(Text4, { color: "yellow", bold: true, children: [
        "\u{1F511} ",
        selected?.providerName,
        " API key"
      ] }) }),
      /* @__PURE__ */ jsx4(Box4, { marginTop: 1, children: /* @__PURE__ */ jsxs4(Text4, { color: "cyan", dim: true, children: [
        "\u250C",
        gridLine(WIDTH - 8),
        "\u2510"
      ] }) }),
      /* @__PURE__ */ jsxs4(Box4, { borderStyle: "round", borderColor: keyError ? "red" : saved ? "green" : "yellow", paddingX: 1, children: [
        /* @__PURE__ */ jsxs4(Text4, { color: "gray", dim: true, children: [
          saving ? SPIN_FRAMES[spinFrame] : saved ? "\u2713" : "\u276F",
          " "
        ] }),
        /* @__PURE__ */ jsx4(Text4, { color: saved ? "green" : "white", children: apiKey ? reveal ? apiKey : "\u2022".repeat(apiKey.length) : /* @__PURE__ */ jsx4(Text4, { color: "gray", dim: true, children: "paste or type your key\u2026" }) })
      ] }),
      /* @__PURE__ */ jsx4(Box4, { children: /* @__PURE__ */ jsxs4(Text4, { color: "cyan", dim: true, children: [
        "\u2514",
        gridLine(WIDTH - 8),
        "\u2518"
      ] }) }),
      keyError ? /* @__PURE__ */ jsx4(Box4, { marginTop: 1, children: /* @__PURE__ */ jsxs4(Text4, { color: "red", bold: true, children: [
        "\u2717 ",
        keyError
      ] }) }) : saving ? /* @__PURE__ */ jsx4(Box4, { marginTop: 1, children: /* @__PURE__ */ jsx4(Text4, { color: "gray", dim: true, children: "Saving key locally\u2026" }) }) : saved ? /* @__PURE__ */ jsx4(Box4, { marginTop: 1, children: /* @__PURE__ */ jsx4(Text4, { color: "green", bold: true, children: "\u2713 Saved \u2014 switching model\u2026" }) }) : /* @__PURE__ */ jsx4(Box4, { marginTop: 1, children: /* @__PURE__ */ jsx4(Text4, { color: "gray", dim: true, children: "Stored in your local hakster config, never sent anywhere else." }) }),
      /* @__PURE__ */ jsx4(Box4, { marginTop: 1, children: /* @__PURE__ */ jsxs4(Text4, { color: "gray", dim: true, children: [
        "Enter save \xB7 Tab ",
        reveal ? "hide" : "show",
        " \xB7 Esc back"
      ] }) })
    ] }) : /* @__PURE__ */ jsxs4(Fragment, { children: [
      /* @__PURE__ */ jsxs4(Box4, { marginTop: 1, children: [
        /* @__PURE__ */ jsxs4(Text4, { color: "gray", dim: true, children: [
          ">".padEnd(2),
          " "
        ] }),
        /* @__PURE__ */ jsx4(Text4, { color: "green", children: filter || "<filter models>" })
      ] }),
      /* @__PURE__ */ jsx4(Box4, { marginTop: 1, children: matches.length === 0 ? /* @__PURE__ */ jsx4(Box4, { flexDirection: "column", children: /* @__PURE__ */ jsxs4(Text4, { color: "gray", dim: true, children: [
        'No models match "',
        filter,
        '"'
      ] }) }) : /* @__PURE__ */ jsxs4(Box4, { flexDirection: "row", children: [
        /* @__PURE__ */ jsx4(Box4, { flexDirection: "column", width: WIDTH - (showScrollbar ? 8 : 5), children: visible.map(
          (r) => r.type === "header" ? /* @__PURE__ */ jsx4(Text4, { color: "magenta", dim: true, bold: true, children: r.label }, r.key) : /* @__PURE__ */ jsxs4(Box4, { children: [
            /* @__PURE__ */ jsxs4(Text4, { color: r.matchIndex === idx ? "green" : "gray", bold: r.matchIndex === idx, children: [
              r.matchIndex === idx ? "\u276F " : "  ",
              r.option.name.padEnd(26).slice(0, 26)
            ] }),
            r.option.model === currentModel ? /* @__PURE__ */ jsx4(Text4, { color: "cyan", bold: true, children: " \u2713" }) : null,
            r.option.needsKey ? /* @__PURE__ */ jsx4(Text4, { color: "yellow", dim: true, children: " \u{1F511}" }) : null
          ] }, r.key)
        ) }),
        showScrollbar && /* @__PURE__ */ jsx4(Box4, { flexDirection: "column", marginLeft: 1, children: Array.from({ length: VISIBLE_ROWS }).map((_, i) => /* @__PURE__ */ jsx4(Text4, { color: i >= thumbStart && i < thumbStart + thumbSize ? "cyan" : "gray", dim: !(i >= thumbStart && i < thumbStart + thumbSize), children: i >= thumbStart && i < thumbStart + thumbSize ? "\u2588" : "\u2502" }, i)) })
      ] }) }),
      /* @__PURE__ */ jsx4(Box4, { marginTop: 1, children: /* @__PURE__ */ jsx4(Text4, { color: "gray", dim: true, children: "\u2191\u2193 navigate \xB7 PgUp/PgDn jump \xB7 Enter select \xB7 Tab toggle task \xB7 Esc close" }) })
    ] })
  ] });
}

// src/components/CommandsDialog.jsx
import React5, { useState as useState3, useMemo as useMemo3 } from "react";
import { Box as Box5, Text as Text5, useInput as useInput2 } from "ink";
import { jsx as jsx5, jsxs as jsxs5 } from "react/jsx-runtime";
var SYSTEM_COMMANDS = [
  { id: "new_session", title: "New Session", desc: "Start a fresh session", shortcut: "ctrl+n" },
  { id: "switch_session", title: "Switch Session", desc: "List and resume a session", shortcut: "ctrl+s" },
  { id: "switch_model", title: "Switch Model", desc: "Open the model selector popup", shortcut: "" },
  { id: "summarize", title: "Summarize Session", desc: "Compact context into a summary", shortcut: "" },
  { id: "toggle_thinking", title: "Toggle Thinking", desc: "Show/hide reasoning stream", shortcut: "" },
  { id: "toggle_diff", title: "Toggle Diff Preview", desc: "Preview edits before applying", shortcut: "" },
  { id: "toggle_plan", title: "Toggle Plan Panel", desc: "Show/hide the plan display", shortcut: "" },
  { id: "toggle_help", title: "Toggle Help", desc: "Show the help overlay", shortcut: "ctrl+g" },
  { id: "file_picker", title: "Open File Picker", desc: "Attach a file to the prompt", shortcut: "ctrl+f" },
  { id: "toggle_yolo", title: "Toggle Yolo Mode", desc: "Auto-approve all tool calls", shortcut: "" },
  { id: "review", title: "Code Review", desc: "Review current changes", shortcut: "" },
  { id: "health", title: "Health Check", desc: "Check server + services", shortcut: "" },
  { id: "init", title: "Initialize Project", desc: "Create/Update CRUSH.md memory", shortcut: "" },
  { id: "quit", title: "Quit", desc: "Exit haksterAi CLI", shortcut: "ctrl+c" }
];
var USER_COMMANDS = [
  { id: "/help", title: "/help", desc: "Show help overlay" },
  { id: "/status", title: "/status", desc: "Server status" },
  { id: "/model", title: "/model", desc: "Switch model" },
  { id: "/provider", title: "/provider", desc: "Switch provider" },
  { id: "/trust", title: "/trust", desc: "Set trust level" },
  { id: "/approve", title: "/approve", desc: "Approve pending" },
  { id: "/deny", title: "/deny", desc: "Deny pending" },
  { id: "/clear", title: "/clear", desc: "Clear output" },
  { id: "/compact", title: "/compact", desc: "Compact context" },
  { id: "/diff", title: "/diff", desc: "Toggle diff preview" },
  { id: "/review", title: "/review", desc: "Code review" },
  { id: "/plan", title: "/plan", desc: "Show/hide plan" },
  { id: "/sessions", title: "/sessions", desc: "List sessions" },
  { id: "/resume", title: "/resume", desc: "Resume session" },
  { id: "/save", title: "/save", desc: "Save session" },
  { id: "/memory", title: "/memory", desc: "Memory summary" },
  { id: "/skills", title: "/skills", desc: "List skills" },
  { id: "/theme", title: "/theme", desc: "Switch theme" },
  { id: "/fast", title: "/fast", desc: "Toggle fast mode" },
  { id: "/health", title: "/health", desc: "Server health" },
  { id: "/undo", title: "/undo", desc: "Undo last edit" },
  { id: "/exit", title: "/exit", desc: "Exit CLI" }
];
var WIDTH2 = 70;
function CommandsDialog({ cols = 80, rows = 24, onSelect, onDismiss }) {
  const [filter, setFilter] = useState3("");
  const [idx, setIdx] = useState3(0);
  const [tab, setTab] = useState3("system");
  const list = tab === "system" ? SYSTEM_COMMANDS : USER_COMMANDS;
  const matches = useMemo3(() => {
    const q = filter.toLowerCase();
    if (!q) return list;
    return list.filter(
      (c) => c.title.toLowerCase().includes(q) || c.desc.toLowerCase().includes(q)
    );
  }, [filter, list]);
  useInput2((raw, key) => {
    if (key.escape) {
      onDismiss?.();
      return;
    }
    if (key.return) {
      const c = matches[idx];
      if (c) onSelect?.(c.id);
      return;
    }
    if (key.tab) {
      setTab((t2) => t2 === "system" ? "user" : "system");
      setFilter("");
      setIdx(0);
      return;
    }
    if (key.upArrow) {
      setIdx((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setIdx((i) => Math.min(matches.length - 1, i + 1));
      return;
    }
    if (key.backspace || key.delete) {
      setFilter((p) => p.slice(0, -1));
      setIdx(0);
      return;
    }
    if (raw && !key.ctrl && !key.meta && raw.length === 1) {
      setFilter((p) => p + raw);
      setIdx(0);
      return;
    }
  });
  const radio = tab === "system" ? "\u25C9 System  \u25CB User" : "\u25CB System  \u25C9 User";
  return /* @__PURE__ */ jsxs5(Box5, { flexDirection: "column", borderStyle: "round", borderColor: "magenta", width: WIDTH2, paddingX: 2, paddingY: 1, children: [
    /* @__PURE__ */ jsxs5(Box5, { justifyContent: "space-between", children: [
      /* @__PURE__ */ jsx5(Text5, { color: "magenta", bold: true, children: "Commands" }),
      /* @__PURE__ */ jsx5(Text5, { color: "gray", dim: true, children: radio })
    ] }),
    /* @__PURE__ */ jsxs5(Box5, { marginTop: 1, children: [
      /* @__PURE__ */ jsxs5(Text5, { color: "gray", dim: true, children: [
        ">".padEnd(2),
        " "
      ] }),
      /* @__PURE__ */ jsx5(Text5, { color: "green", children: filter || "<filter commands>" })
    ] }),
    /* @__PURE__ */ jsx5(Box5, { flexDirection: "column", marginTop: 1, children: matches.length === 0 ? /* @__PURE__ */ jsxs5(Text5, { color: "gray", dim: true, children: [
      'No commands match "',
      filter,
      '"'
    ] }) : matches.map((c, i) => /* @__PURE__ */ jsxs5(Box5, { children: [
      /* @__PURE__ */ jsxs5(Text5, { color: i === idx ? "green" : "gray", bold: i === idx, children: [
        i === idx ? "\u276F " : "  ",
        c.title.padEnd(22).slice(0, 22)
      ] }),
      /* @__PURE__ */ jsx5(Text5, { color: "gray", dim: true, children: c.desc.padEnd(36).slice(0, 36) }),
      c.shortcut ? /* @__PURE__ */ jsxs5(Text5, { color: "cyan", dim: true, children: [
        " ",
        c.shortcut
      ] }) : null
    ] }, c.id)) }),
    /* @__PURE__ */ jsx5(Box5, { marginTop: 1, children: /* @__PURE__ */ jsx5(Text5, { color: "gray", dim: true, children: "\u2191\u2193 navigate \xB7 Enter run \xB7 Tab system/user \xB7 Esc close" }) })
  ] });
}

// src/components/ApprovalPrompt.jsx
import React6, { useState as useState4 } from "react";
import { Box as Box6, Text as Text6, useInput as useInput3 } from "ink";
import { jsx as jsx6, jsxs as jsxs6 } from "react/jsx-runtime";
var BUTTONS = [
  { key: "r", label: "Allow this run", color: "green" },
  { key: "s", label: "Allow this session", color: "cyan" },
  { key: "a", label: "Add to allowlist", color: "yellow" },
  { key: "d", label: "Deny", color: "red" }
];
var RISK_CONFIG = {
  low: { color: "green", icon: "\u2713", label: "LOW" },
  medium: { color: "yellow", icon: "\u26A0", label: "MEDIUM" },
  high: { color: "red", icon: "\u26A0", label: "HIGH" },
  critical: { color: "red", icon: "\u{1F511}", label: "SUDO" }
};
function ApprovalPrompt({
  command = "",
  risk = "high",
  reason = "",
  isSudo = false,
  onApprove,
  onApproveSession,
  onAllowlist,
  onDeny
}) {
  const sudo = !!isSudo || risk === "critical";
  const rc = RISK_CONFIG[risk] || RISK_CONFIG.high;
  const [focus, setFocus] = useState4(0);
  const [pw, setPw] = useState4("");
  const actions = [onApprove, onApproveSession, onAllowlist, onDeny];
  useInput3((raw, key) => {
    if (key.escape) {
      onDeny?.(pw);
      return;
    }
    if (key.leftArrow) {
      setFocus((f) => (f - 1 + BUTTONS.length) % BUTTONS.length);
      return;
    }
    if (key.rightArrow || key.tab) {
      setFocus((f) => (f + 1) % BUTTONS.length);
      return;
    }
    if (key.return) {
      actions[focus]?.(pw);
      return;
    }
    if (key.backspace || key.delete) {
      if (sudo) {
        setPw((p) => p.slice(0, -1));
      }
      return;
    }
    if (sudo && raw && raw.length === 1 && !key.ctrl && !key.meta) {
      setPw((p) => p + raw);
      return;
    }
    if (!sudo && raw && raw.length === 1 && !key.ctrl && !key.meta) {
      const idx = BUTTONS.findIndex((b) => b.key === raw.toLowerCase());
      if (idx >= 0) {
        actions[idx]?.(pw);
      }
    }
  });
  const displayCommand = (command || "").slice(0, 120) + ((command || "").length > 120 ? "\u2026" : "");
  const displayReason = (reason || (sudo ? "SUDO ELEVATED COMMAND" : "Dangerous command detected")).slice(0, 90);
  return /* @__PURE__ */ jsxs6(Box6, { flexDirection: "column", borderStyle: "double", borderColor: rc.color, paddingX: 2, paddingY: 1, width: Math.min(92, 58), children: [
    /* @__PURE__ */ jsxs6(Box6, { justifyContent: "space-between", children: [
      /* @__PURE__ */ jsxs6(Text6, { color: rc.color, bold: true, children: [
        rc.icon,
        " ",
        rc.label,
        " \u2014 Approval Required"
      ] }),
      /* @__PURE__ */ jsx6(Text6, { color: "gray", dim: true, children: "[ Esc = deny ]" })
    ] }),
    /* @__PURE__ */ jsx6(Box6, { marginTop: 0, children: /* @__PURE__ */ jsxs6(Text6, { color: "white", children: [
      sudo ? "\u{1F511} SUDO " : "\u26A0 ",
      displayReason
    ] }) }),
    command && /* @__PURE__ */ jsx6(Box6, { marginTop: 0, children: /* @__PURE__ */ jsxs6(Text6, { color: "gray", children: [
      "$ ",
      displayCommand
    ] }) }),
    sudo && /* @__PURE__ */ jsxs6(Box6, { marginTop: 1, children: [
      /* @__PURE__ */ jsx6(Text6, { color: "cyan", bold: true, children: "sudo password: " }),
      /* @__PURE__ */ jsx6(Text6, { color: "white", children: "*".repeat(pw.length) }),
      /* @__PURE__ */ jsx6(Text6, { color: "gray", dim: true, children: pw ? "" : " (type to enter)" })
    ] }),
    /* @__PURE__ */ jsx6(Box6, { marginTop: 1, flexDirection: "row", flexWrap: "wrap", children: BUTTONS.map((b, i) => {
      const focused = i === focus;
      return /* @__PURE__ */ jsx6(Box6, { marginRight: 1, children: /* @__PURE__ */ jsxs6(Text6, { backgroundColor: focused ? b.color : void 0, color: focused ? "black" : b.color, bold: true, children: [
        focused ? "\u276F" : " ",
        "[",
        b.key,
        "] ",
        b.label
      ] }) }, b.key);
    }) }),
    /* @__PURE__ */ jsx6(Box6, { marginTop: 1, children: /* @__PURE__ */ jsxs6(Text6, { color: "gray", dim: true, children: [
      "\u2190/\u2192/Tab focus \xB7 Enter select",
      sudo ? " \xB7 letters type password" : " \xB7 r/s/a/d hotkeys"
    ] }) })
  ] });
}

// src/components/DiffPreview.jsx
import React7 from "react";
import { Box as Box7, Text as Text7 } from "ink";
import { jsx as jsx7, jsxs as jsxs7 } from "react/jsx-runtime";
var SIDE_BY_SIDE_MIN_COLS = 100;
function pairDiffRows(lines) {
  const rows = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("diff") || line.startsWith("---") || line.startsWith("+++")) {
      rows.push({ left: { text: line, kind: "meta" }, right: { text: line, kind: "meta" } });
      i++;
      continue;
    }
    if (line.startsWith("@@")) {
      rows.push({ left: { text: line, kind: "hunk" }, right: { text: line, kind: "hunk" } });
      i++;
      continue;
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      const removed = [];
      while (i < lines.length && lines[i].startsWith("-") && !lines[i].startsWith("---")) {
        removed.push(lines[i].slice(1));
        i++;
      }
      const added = [];
      while (i < lines.length && lines[i].startsWith("+") && !lines[i].startsWith("+++")) {
        added.push(lines[i].slice(1));
        i++;
      }
      const n = Math.max(removed.length, added.length);
      for (let r = 0; r < n; r++) {
        rows.push({
          left: r < removed.length ? { text: removed[r], kind: "del" } : { text: "", kind: "blank" },
          right: r < added.length ? { text: added[r], kind: "add" } : { text: "", kind: "blank" }
        });
      }
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      rows.push({ left: { text: "", kind: "blank" }, right: { text: line.slice(1), kind: "add" } });
      i++;
      continue;
    }
    const text = line.startsWith(" ") ? line.slice(1) : line;
    rows.push({ left: { text, kind: "ctx" }, right: { text, kind: "ctx" } });
    i++;
  }
  return rows;
}
var KIND_COLOR = { del: "red", add: "green", hunk: "cyan", meta: "magenta", ctx: "gray", blank: "gray" };
var KIND_PREFIX = { del: "-", add: "+", hunk: "@", meta: " ", ctx: " ", blank: " " };
function Cell({ cell, width }) {
  const color = KIND_COLOR[cell.kind] || "gray";
  const prefix = KIND_PREFIX[cell.kind] || " ";
  const dim = cell.kind === "ctx" || cell.kind === "blank";
  return /* @__PURE__ */ jsxs7(Text7, { color, dim, wrap: "truncate", children: [
    prefix,
    " ",
    cell.text.slice(0, Math.max(0, width - 2))
  ] });
}
function DiffPreview({ diff, cols = 80, onApprove, onDeny }) {
  if (!diff) return null;
  const allLines = diff.split("\n");
  const capped = allLines.slice(0, 40);
  const sideBySide = cols >= SIDE_BY_SIDE_MIN_COLS;
  const colWidth = Math.floor((cols - 6) / 2);
  const rows = sideBySide ? pairDiffRows(capped) : null;
  return /* @__PURE__ */ jsxs7(Box7, { flexDirection: "column", borderStyle: "round", borderColor: "yellow", paddingX: 1, children: [
    /* @__PURE__ */ jsxs7(Box7, { justifyContent: "space-between", children: [
      /* @__PURE__ */ jsxs7(Text7, { color: "yellow", bold: true, children: [
        "\u26A0 Diff Preview ",
        sideBySide ? "\u2014 old \u2502 new" : "(unified)",
        " \u2014 Review Before Apply"
      ] }),
      /* @__PURE__ */ jsx7(Text7, { color: "gray", dim: true, children: "Y=approve \u2502 N=deny \u2502 V=view more" })
    ] }),
    /* @__PURE__ */ jsxs7(Box7, { flexDirection: "column", marginTop: 0, children: [
      sideBySide ? rows.map((row, i) => /* @__PURE__ */ jsxs7(Box7, { flexDirection: "row", children: [
        /* @__PURE__ */ jsx7(Box7, { width: colWidth, children: /* @__PURE__ */ jsx7(Cell, { cell: row.left, width: colWidth }) }),
        /* @__PURE__ */ jsx7(Text7, { color: "gray", dim: true, children: " \u2502 " }),
        /* @__PURE__ */ jsx7(Box7, { width: colWidth, children: /* @__PURE__ */ jsx7(Cell, { cell: row.right, width: colWidth }) })
      ] }, i)) : capped.map((line, i) => {
        let color = "gray";
        let prefix = " ";
        if (line.startsWith("+") && !line.startsWith("+++")) {
          color = "green";
          prefix = "+";
        } else if (line.startsWith("-") && !line.startsWith("---")) {
          color = "red";
          prefix = "-";
        } else if (line.startsWith("@@")) {
          color = "cyan";
          prefix = "@";
        } else if (line.startsWith("diff") || line.startsWith("---") || line.startsWith("+++")) {
          color = "magenta";
          prefix = " ";
        }
        return /* @__PURE__ */ jsxs7(Text7, { color, wrap: "truncate", children: [
          prefix,
          " ",
          line.slice(0, cols - 4)
        ] }, i);
      }),
      allLines.length > capped.length && /* @__PURE__ */ jsxs7(Text7, { color: "gray", dim: true, children: [
        "... ",
        allLines.length - capped.length,
        " more lines (press V to view)"
      ] })
    ] }),
    /* @__PURE__ */ jsxs7(Box7, { marginTop: 0, children: [
      /* @__PURE__ */ jsx7(Text7, { color: "green", bold: true, children: "[Y]" }),
      /* @__PURE__ */ jsx7(Text7, { color: "gray", children: " approve \u2502 " }),
      /* @__PURE__ */ jsx7(Text7, { color: "red", bold: true, children: "[N]" }),
      /* @__PURE__ */ jsx7(Text7, { color: "gray", children: " deny \u2502 " }),
      /* @__PURE__ */ jsx7(Text7, { color: "blue", bold: true, children: "[V]" }),
      /* @__PURE__ */ jsx7(Text7, { color: "gray", children: " view full" })
    ] })
  ] });
}

// src/components/PlanDisplay.jsx
import React8 from "react";
import { Box as Box8, Text as Text8 } from "ink";
import { jsx as jsx8, jsxs as jsxs8 } from "react/jsx-runtime";
function PlanDisplay({ plan = null, cols = 80 }) {
  if (!plan) return null;
  const { goal, steps = [], files = [] } = plan;
  return /* @__PURE__ */ jsxs8(
    Box8,
    {
      flexDirection: "column",
      borderStyle: "single",
      borderColor: "blue",
      paddingX: 1,
      children: [
        /* @__PURE__ */ jsx8(Text8, { color: "blue", bold: true, underline: true, children: "\u{1F4CB} Plan" }),
        goal && /* @__PURE__ */ jsxs8(Text8, { color: "white", children: [
          "Goal: ",
          /* @__PURE__ */ jsx8(Text8, { color: "cyan", children: goal })
        ] }),
        steps.length > 0 && /* @__PURE__ */ jsx8(Box8, { flexDirection: "column", marginTop: 0, children: steps.map((step, i) => {
          const done = step.status === "done";
          const active = step.status === "active";
          const icon = done ? "\u2713" : active ? "\u25C9" : "\u25CB";
          const color = done ? "green" : active ? "yellow" : "gray";
          return /* @__PURE__ */ jsxs8(Text8, { color, children: [
            icon,
            " [",
            i + 1,
            "] ",
            step.text || step.desc || step
          ] }, i);
        }) }),
        files.length > 0 && /* @__PURE__ */ jsx8(Box8, { marginTop: 0, children: /* @__PURE__ */ jsxs8(Text8, { color: "magenta", dim: true, children: [
          "Files: ",
          files.join(", ")
        ] }) })
      ]
    }
  );
}

// src/components/SessionList.jsx
import React9 from "react";
import { Box as Box9, Text as Text9 } from "ink";
import { jsx as jsx9, jsxs as jsxs9 } from "react/jsx-runtime";
function SessionList({ sessions = [], cols = 80, onSelect }) {
  if (sessions.length === 0) {
    return /* @__PURE__ */ jsx9(Box9, { borderStyle: "round", borderColor: "gray", paddingX: 1, children: /* @__PURE__ */ jsx9(Text9, { color: "gray", dim: true, children: "No saved sessions. Use /save to save current session." }) });
  }
  return /* @__PURE__ */ jsxs9(Box9, { flexDirection: "column", borderStyle: "round", borderColor: "cyan", paddingX: 1, children: [
    /* @__PURE__ */ jsx9(Text9, { color: "cyan", bold: true, underline: true, children: "Saved Sessions" }),
    sessions.map((s, i) => {
      const date = s.updatedAt ? new Date(s.updatedAt).toLocaleDateString() : "?";
      const time = s.updatedAt ? new Date(s.updatedAt).toLocaleTimeString() : "";
      return /* @__PURE__ */ jsxs9(Box9, { children: [
        /* @__PURE__ */ jsxs9(Text9, { color: "green", bold: true, children: [
          "[",
          (i + 1).toString().padStart(2),
          "]"
        ] }),
        /* @__PURE__ */ jsx9(Text9, { color: "cyan", children: " " + (s.id || "").slice(0, 12) }),
        /* @__PURE__ */ jsx9(Text9, { color: "gray", children: " " + (s.provider || "").padEnd(8) }),
        /* @__PURE__ */ jsx9(Text9, { color: "magenta", children: " " + (s.model || "").padEnd(16) }),
        /* @__PURE__ */ jsx9(Text9, { color: "gray", dim: true, children: " " + date + " " + time })
      ] }, s.id || i);
    }),
    /* @__PURE__ */ jsxs9(Text9, { color: "gray", dim: true, marginTop: 0, children: [
      "Use /resume ",
      "<id>",
      " to resume a session"
    ] })
  ] });
}

// src/components/QueueBox.jsx
import React10 from "react";
import { Box as Box10, Text as Text10 } from "ink";
import { jsx as jsx10, jsxs as jsxs10 } from "react/jsx-runtime";
function QueueBox({ items = [], cols = 80 }) {
  if (!items.length) return null;
  const list = Array.isArray(items) ? items : [items];
  return /* @__PURE__ */ jsxs10(Box10, { flexDirection: "column", borderStyle: "single", borderColor: "cyan", paddingX: 1, width: cols, children: [
    /* @__PURE__ */ jsxs10(Box10, { justifyContent: "space-between", children: [
      /* @__PURE__ */ jsxs10(Text10, { color: "cyan", bold: true, children: [
        "\u23F3 Queued messages (",
        list.length,
        ")"
      ] }),
      /* @__PURE__ */ jsx10(Text10, { color: "gray", dim: true, children: "waiting\u2026" })
    ] }),
    list.slice(0, 4).map((it, i) => {
      const text = String(typeof it === "string" ? it : it?.text || it?.content || it?.message || JSON.stringify(it));
      const last = i === list.length - 1;
      return /* @__PURE__ */ jsxs10(Box10, { children: [
        /* @__PURE__ */ jsx10(Text10, { color: last ? "cyan" : "gray", dim: !last, children: last ? "\u25B8 " : "  " }),
        /* @__PURE__ */ jsx10(Text10, { color: "white", children: text.slice(0, Math.max(10, cols - 6)) })
      ] }, i);
    }),
    list.length > 4 && /* @__PURE__ */ jsxs10(Text10, { color: "gray", dim: true, children: [
      "\u2026and ",
      list.length - 4,
      " more"
    ] })
  ] });
}

// src/components/Spinner.jsx
import React11, { useState as useState5, useEffect as useEffect2 } from "react";
import { Text as Text11 } from "ink";
import { jsxs as jsxs11 } from "react/jsx-runtime";
var FRAMES = ["\u280B", "\u2819", "\u2839", "\u2838", "\u283C", "\u2834", "\u2826", "\u2827", "\u2807", "\u280F"];
var FRAMES_DOTS = ["\u28FE", "\u28FD", "\u28FB", "\u28BF", "\u287F", "\u28DF", "\u28EF", "\u28F7"];
function Spinner({ type = "braille", label = "", color = "yellow" }) {
  const [frame, setFrame] = useState5(0);
  const frames = type === "dots" ? FRAMES_DOTS : FRAMES;
  useEffect2(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % frames.length), 80);
    return () => clearInterval(id);
  }, [frames.length]);
  return /* @__PURE__ */ jsxs11(Text11, { color, children: [
    frames[frame],
    " ",
    label
  ] });
}

// src/components/SplashScreen.jsx
import React12, { useState as useState6, useEffect as useEffect3 } from "react";
import { Box as Box11, Text as Text12 } from "ink";
import { jsx as jsx11, jsxs as jsxs12 } from "react/jsx-runtime";
var LOGO = [
  " \u2554\u2550\u2557 \u2566 \u2566 \u2554\u2550\u2557 \u2566\u2554\u2550 \u2554\u2550\u2557 \u2566   \u2554\u2566\u2557 \u2554\u2550\u2557 \u2566 \u2566",
  " \u2551   \u2551 \u2551 \u2560\u2550\u255D \u2560\u2569\u2557 \u2551   \u2551    \u2551  \u2551 \u2551 \u2551 \u2551",
  " \u255A\u2550\u255D \u255A\u2550\u255D \u2569   \u2569 \u2569 \u255A\u2550\u255D \u255A\u2550\u255D  \u2569  \u255A\u2550\u255D \u255A\u2550\u255D"
];
function SplashScreen({ onDone, version = "0.1.0" }) {
  const [frame, setFrame] = useState6(0);
  useEffect3(() => {
    if (frame >= LOGO.length + 2) {
      onDone && onDone();
      return;
    }
    const id = setTimeout(() => setFrame((f) => f + 1), 120);
    return () => clearTimeout(id);
  }, [frame, onDone]);
  return /* @__PURE__ */ jsxs12(Box11, { flexDirection: "column", alignItems: "center", justifyContent: "center", children: [
    LOGO.slice(0, frame).map((line, i) => /* @__PURE__ */ jsx11(Text12, { color: "green", bold: true, children: line }, i)),
    frame >= LOGO.length && /* @__PURE__ */ jsxs12(Box11, { flexDirection: "column", marginTop: 1, children: [
      /* @__PURE__ */ jsxs12(Text12, { color: "cyan", bold: true, children: [
        "HaksterAI CLI v",
        version
      ] }),
      /* @__PURE__ */ jsx11(Text12, { color: "gray", dim: true, children: "Pentester AI Agent \xB7 Autonomous Coding \xB7 IPTV Ops" }),
      /* @__PURE__ */ jsx11(Text12, { color: "magenta", dim: true, children: "Type ? for help \xB7 Enter to start \xB7 Ctrl+C to exit" })
    ] })
  ] });
}

// src/components/ThinkingBox.jsx
import React13, { useState as useState7, useEffect as useEffect4, useRef } from "react";
import { Box as Box12, Text as Text13 } from "ink";
import { jsx as jsx12, jsxs as jsxs13 } from "react/jsx-runtime";
function ThinkingBox({ thinking = "", phase = "", cols = 80, theme }) {
  const [offset, setOffset] = useState7(0);
  const [dots, setDots] = useState7(0);
  const textRef = useRef("");
  useEffect4(() => {
    textRef.current = thinking ? thinking.trim() : "";
    setOffset(0);
  }, [thinking]);
  useEffect4(() => {
    if (!textRef.current) return;
    const id = setInterval(() => {
      setOffset((o) => {
        const textLen = textRef.current.length;
        const maxOffset = textLen + 20;
        return o >= maxOffset ? 0 : o + 1;
      });
    }, 120);
    return () => clearInterval(id);
  }, [thinking]);
  useEffect4(() => {
    if (!phase) return;
    const id = setInterval(() => setDots((d) => (d + 1) % 4), 400);
    return () => clearInterval(id);
  }, [phase]);
  if (!thinking && !phase) return null;
  const fullText = textRef.current;
  const availWidth = Math.max(0, cols - 22);
  let viewport = "";
  if (fullText) {
    const padded = "   " + fullText + "   ";
    if (padded.length <= availWidth) {
      viewport = padded.trim();
    } else {
      let window = "";
      for (let i = 0; i < availWidth; i++) {
        const idx = (offset + i) % padded.length;
        window += padded[idx];
      }
      viewport = window;
    }
  }
  const phaseLabel = phase ? ` ${phase}${".".repeat(dots)}` : "";
  const accentColor = theme?.accent || theme?.primary || "cyan";
  return /* @__PURE__ */ jsxs13(Box12, { flexDirection: "row", alignItems: "center", children: [
    /* @__PURE__ */ jsx12(Box12, { marginRight: 1, children: /* @__PURE__ */ jsx12(Spinner, {}) }),
    /* @__PURE__ */ jsx12(Text13, { color: accentColor, bold: true, children: "\u27E1" }),
    /* @__PURE__ */ jsx12(Text13, { color: "gray", dim: true, children: " thinking" }),
    /* @__PURE__ */ jsx12(Text13, { color: accentColor, children: phaseLabel ? ` ${phaseLabel}` : "" }),
    /* @__PURE__ */ jsx12(Box12, { flexGrow: 1, marginLeft: 1, overflow: "hidden", children: /* @__PURE__ */ jsx12(Text13, { color: "gray", wrap: "truncate", children: viewport }) })
  ] });
}

// src/components/InputBox.jsx
import React14, { useState as useState8, useEffect as useEffect5, useRef as useRef2 } from "react";
import { Box as Box13, Text as Text14, useInput as useInput4, useStdin } from "ink";
import { jsx as jsx13, jsxs as jsxs14 } from "react/jsx-runtime";
function InputBox({
  value = "",
  onChange,
  onSubmit,
  placeholder = "Type a message\u2026 (Enter to send, Shift+Enter for newline)",
  cols = 80,
  disabled = false,
  queueCount = 0,
  theme
}) {
  const { isRawModeSupported } = useStdin();
  const cursorRef = useRef2(value.length);
  useInput4((input, key) => {
    if (disabled) return;
    if (key.return && !key.shift) {
      if (onSubmit) onSubmit(value);
      return;
    }
    if (key.backspace || key.delete) {
      const newVal = value.slice(0, -1);
      if (onChange) onChange(newVal);
      return;
    }
    if (key.ctrl && input === "u") {
      if (onChange) onChange("");
      return;
    }
    if (key.ctrl && input === "w") {
      const parts = value.split(/\s+/);
      parts.pop();
      const newVal = parts.join(" ");
      if (onChange) onChange(newVal);
      return;
    }
    if (input && !key.ctrl && !key.meta && !key.escape && input.length === 1) {
      const newVal = value + input;
      if (onChange) onChange(newVal);
      return;
    }
  });
  const borderColor = disabled ? "gray" : theme?.primary || "green";
  const labelColor = disabled ? "gray" : theme?.primary || "green";
  const promptChar = disabled ? "\u25CB" : "\u25B6";
  const displayValue = value || "";
  const showCursor = !disabled;
  return /* @__PURE__ */ jsxs14(
    Box13,
    {
      flexDirection: "column",
      borderStyle: "round",
      borderColor,
      paddingX: 1,
      width: cols,
      flexShrink: 0,
      children: [
        queueCount > 0 && /* @__PURE__ */ jsxs14(Box13, { justifyContent: "space-between", children: [
          /* @__PURE__ */ jsxs14(Text14, { color: "cyan", bold: true, children: [
            "\u{1F4E8} ",
            queueCount,
            " message",
            queueCount > 1 ? "s" : "",
            " queued"
          ] }),
          /* @__PURE__ */ jsx13(Text14, { color: "gray", dim: true, children: "press Tab to cycle" })
        ] }),
        /* @__PURE__ */ jsxs14(Box13, { children: [
          /* @__PURE__ */ jsxs14(Text14, { color: labelColor, bold: true, children: [
            promptChar,
            " "
          ] }),
          /* @__PURE__ */ jsx13(Text14, { color: disabled ? "gray" : "white", children: displayValue }),
          showCursor && displayValue.length < cols - 6 && /* @__PURE__ */ jsx13(Text14, { color: labelColor, children: "\u2588" }),
          !displayValue && /* @__PURE__ */ jsx13(Text14, { color: "gray", dim: true, children: placeholder })
        ] }),
        /* @__PURE__ */ jsxs14(Box13, { justifyContent: "space-between", children: [
          /* @__PURE__ */ jsx13(Text14, { color: "gray", dim: true, children: "\u21B5 send  \u21E7\u21B5 newline  \u2303U clear  \u2303W del-word  /commands  ?help" }),
          /* @__PURE__ */ jsx13(Text14, { color: "gray", dim: true, children: disabled ? "\u23F8 busy" : "\u25CF ready" })
        ] })
      ]
    }
  );
}

// src/components/MessageGrid.jsx
import React15 from "react";
import { Box as Box14, Text as Text15 } from "ink";
import { jsx as jsx14, jsxs as jsxs15 } from "react/jsx-runtime";
function MessageGrid({ messages = [], cols = 80, theme }) {
  if (!messages.length) return null;
  const borderColor = theme?.border || "green";
  const maxContentWidth = cols - 4;
  return /* @__PURE__ */ jsx14(Box14, { flexDirection: "column", width: cols, children: messages.map((msg, i) => {
    const isUser = msg.role === "user";
    const isAssistant = msg.role === "assistant" || msg.role === "model";
    const isTool = msg.role === "tool" || msg.role === "system";
    const isThinking = msg.role === "thinking";
    const roleLabel = isUser ? "\u{1F464} YOU" : isAssistant ? "\u{1F916} AI" : isTool ? "\u{1F527} TOOL" : isThinking ? "\u{1F9E0} THINK" : "\u25C6";
    const roleColor = isUser ? theme?.primary || "green" : isAssistant ? theme?.secondary || "cyan" : isThinking ? "yellow" : "gray";
    const cardBorder = isUser ? theme?.primary || "green" : isThinking ? "yellow" : theme?.secondary || "cyan";
    let content = msg.content || msg.text || "";
    if (typeof content === "object") content = JSON.stringify(content);
    const lines = content.split("\n");
    const maxLines = isThinking ? 4 : 20;
    const truncated = lines.length > maxLines;
    const shownLines = lines.slice(0, maxLines);
    const shownContent = shownLines.join("\n") + (truncated ? `
\u2026 +${lines.length - maxLines} more lines` : "");
    return /* @__PURE__ */ jsxs15(
      Box14,
      {
        flexDirection: "column",
        borderStyle: isThinking ? "single" : "round",
        borderColor: cardBorder,
        paddingX: 1,
        width: cols,
        marginBottom: 0,
        marginTop: 0,
        children: [
          /* @__PURE__ */ jsxs15(Box14, { justifyContent: "space-between", alignItems: "center", children: [
            /* @__PURE__ */ jsx14(Text15, { color: roleColor, bold: true, children: roleLabel }),
            msg.model && /* @__PURE__ */ jsx14(Text15, { color: "gray", dim: true, children: msg.model }),
            msg.timestamp && /* @__PURE__ */ jsx14(Text15, { color: "gray", dim: true, children: msg.timestamp })
          ] }),
          /* @__PURE__ */ jsx14(Box14, { marginTop: 0, children: /* @__PURE__ */ jsx14(
            Text15,
            {
              color: isThinking ? "gray" : "white",
              dim: isThinking,
              wrap: "truncate",
              children: shownContent
            }
          ) })
        ]
      },
      i
    );
  }) });
}

// src/components/TokenBar.jsx
import React16 from "react";
import { Box as Box15, Text as Text16 } from "ink";
import { jsx as jsx15, jsxs as jsxs16 } from "react/jsx-runtime";

// src/components/ThemeManager.js
var THEMES = {
  default: {
    bg: "black",
    primary: "green",
    secondary: "cyan",
    accent: "magenta",
    text: "white",
    dim: "gray",
    error: "red",
    warning: "yellow",
    success: "green",
    info: "blue",
    border: "green",
    phase: {
      THINK: "cyan",
      PLAN: "yellow",
      ACT: "green",
      OBSERVE: "blue",
      REFLECT: "magenta",
      CONSOLIDATE: "gray",
      DONE: "green",
      IDLE: "gray",
      ERROR: "red"
    }
  },
  dark: {
    bg: "black",
    primary: "blue",
    secondary: "magenta",
    accent: "cyan",
    text: "white",
    dim: "gray",
    error: "red",
    warning: "yellow",
    success: "green",
    info: "cyan",
    border: "blue",
    phase: {
      THINK: "blue",
      PLAN: "yellow",
      ACT: "green",
      OBSERVE: "cyan",
      REFLECT: "magenta",
      CONSOLIDATE: "gray",
      DONE: "green",
      IDLE: "gray",
      ERROR: "red"
    }
  },
  light: {
    bg: "white",
    primary: "blue",
    secondary: "magenta",
    accent: "cyan",
    text: "black",
    dim: "gray",
    error: "red",
    warning: "yellow",
    success: "green",
    info: "blue",
    border: "blue",
    phase: {
      THINK: "blue",
      PLAN: "yellow",
      ACT: "green",
      OBSERVE: "cyan",
      REFLECT: "magenta",
      CONSOLIDATE: "gray",
      DONE: "green",
      IDLE: "gray",
      ERROR: "red"
    }
  },
  cyberpunk: {
    bg: "black",
    primary: "magenta",
    secondary: "cyan",
    accent: "yellow",
    text: "white",
    dim: "gray",
    error: "red",
    warning: "yellow",
    success: "cyan",
    info: "magenta",
    border: "magenta",
    phase: {
      THINK: "magenta",
      PLAN: "yellow",
      ACT: "cyan",
      OBSERVE: "blue",
      REFLECT: "magenta",
      CONSOLIDATE: "gray",
      DONE: "cyan",
      IDLE: "gray",
      ERROR: "red"
    }
  },
  hacker: {
    bg: "black",
    primary: "green",
    secondary: "green",
    accent: "green",
    text: "green",
    dim: "gray",
    error: "red",
    warning: "green",
    success: "green",
    info: "green",
    border: "green",
    phase: {
      THINK: "green",
      PLAN: "green",
      ACT: "green",
      OBSERVE: "green",
      REFLECT: "green",
      CONSOLIDATE: "green",
      DONE: "green",
      IDLE: "gray",
      ERROR: "red"
    }
  }
};
var THEME_NAMES = Object.keys(THEMES);

// src/App.jsx
import { jsx as jsx16, jsxs as jsxs17 } from "react/jsx-runtime";
var MAX_OUTPUT = 500;
var MAX_TOOLS = 50;
var TOKEN_BATCH_MS = 16;
var REASONING_TYPES = [
  { pattern: /^(?:checking|scanning|looking|reading|inspecting|examining|reviewing|verifying|testing|validating)/i, type: "inspect", color: "blue" },
  { pattern: /^(?:found|detected|identified|located|discovered|spotted|noticed)/i, type: "find", color: "green" },
  { pattern: /^(?:error|fail|issue|problem|bug|crash|exception|broken|invalid|unable|cannot|can't)/i, type: "error", color: "red" },
  { pattern: /^(?:plan|step|approach|strategy|decide|will|should|going to|next|i'll|i will)/i, type: "plan", color: "yellow" },
  { pattern: /^(?:conclusion|therefore|so |thus|result|hence|meaning|in short|tl;dr)/i, type: "conclusion", color: "yellow" },
  { pattern: /^(?:root cause|the issue is|the problem is|caused by|because|due to)/i, type: "diagnosis", color: "orange" },
  { pattern: /^(?:running|executing|calling|invoking|launching|starting)/i, type: "action", color: "magenta" },
  { pattern: /^(?:searching|querying|grepping|finding files|listing)/i, type: "search", color: "cyan" },
  { pattern: /^(?:analyzing|parsing|thinking|considering|wondering|pondering|maybe|perhaps|hmm|let me)/i, type: "think", color: "gray" },
  { pattern: /^(?:creating|writing|editing|modifying|updating|building|adding|removing|deleting)/i, type: "edit", color: "magenta" },
  { pattern: /^(?:connecting|fetching|loading|downloading|uploading|sending)/i, type: "io", color: "blue" },
  { pattern: /^(?:waiting|ready|done|complete|success|finished)/i, type: "status", color: "green" },
  { pattern: /^(?:warning|caution|careful|risky|danger|unsafe)/i, type: "warn", color: "yellow" }
];
function classifyReasoning(text) {
  for (const r of REASONING_TYPES) {
    if (r.pattern.test(text)) return r;
  }
  return null;
}
function App() {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const cols = stdout?.columns || 80;
  const rows = stdout?.rows || 24;
  const outputHeight = Math.max(5, rows - 10);
  const [showSplash, setShowSplash] = useState9(true);
  const [themeName, setThemeName] = useState9("default");
  const theme = useMemo4(() => THEMES[themeName] || THEMES.default, [themeName]);
  const [output, setOutput] = useState9([]);
  const [tools, setTools] = useState9([]);
  const [input, setInput] = useState9("");
  const [thinkingText, setThinkingText] = useState9("");
  const [thinking, setThinking] = useState9(false);
  const [status, setStatus] = useState9({ task: "idle", model: agent_default.model || "unknown", phase: "IDLE", tokens: 0, trust: 0, provider: "ollama" });
  const [phase, setPhase] = useState9("IDLE");
  const [queue, setQueue] = useState9([]);
  const [scrollOffset, setScrollOffset] = useState9(0);
  const [blink, setBlink] = useState9(false);
  const [showHelp, setShowHelp] = useState9(false);
  const [showModelDialog, setShowModelDialog] = useState9(false);
  const [showCommandsDialog, setShowCommandsDialog] = useState9(false);
  const [showSlashMenu, setShowSlashMenu] = useState9(false);
  const [showPlan, setShowPlan] = useState9(false);
  const [showSessions, setShowSessions] = useState9(false);
  const [showDiff, setShowDiff] = useState9(false);
  const [diffData, setDiffData] = useState9(null);
  const [plan, setPlan] = useState9(null);
  const [sessions, setSessions] = useState9([]);
  const [approval, setApproval] = useState9(null);
  const [contextMax, setContextMax] = useState9(128e3);
  const [contextChars, setContextChars] = useState9(0);
  const inputRef = useRef3("");
  const batchRef = useRef3({ timer: null, text: "" });
  const maxScroll = Math.max(0, output.length - outputHeight);
  const effectiveOffset = Math.min(maxScroll, scrollOffset);
  const olderAbove = maxScroll - effectiveOffset;
  const newerBelow = effectiveOffset;
  const scrollIndicators = (olderAbove > 0 ? 1 : 0) + (newerBelow > 0 ? 1 : 0);
  const visCount = Math.max(1, outputHeight - scrollIndicators);
  const visible = output.slice(
    Math.max(0, output.length - newerBelow - visCount),
    output.length - newerBelow
  );
  const liveTextRef = useRef3("");
  const liveThinkRef = useRef3("");
  const [, forceTick] = useState9(0);
  const flushTokens = useCallback(() => {
    const b = batchRef.current;
    if (!b.text) return;
    liveTextRef.current += b.text;
    b.text = "";
    b.timer = null;
    forceTick((n) => n + 1);
  }, []);
  const appendToken = useCallback((token) => {
    batchRef.current.text += token;
    if (token.includes("\n")) {
      const full = batchRef.current.text;
      batchRef.current.text = "";
      if (batchRef.current.timer) {
        clearTimeout(batchRef.current.timer);
        batchRef.current.timer = null;
      }
      const parts = full.split("\n");
      for (let i = 0; i < parts.length - 1; i++) {
        setOutput((prev) => [...prev, { type: "assistant", text: parts[i] }].slice(-MAX_OUTPUT));
      }
      liveTextRef.current = parts[parts.length - 1];
      forceTick((n) => n + 1);
      return;
    }
    if (!batchRef.current.timer) {
      batchRef.current.timer = setTimeout(flushTokens, TOKEN_BATCH_MS);
    }
  }, [flushTokens]);
  const thinkBatchRef = useRef3({ timer: null, text: "" });
  const flushThinking = useCallback(() => {
    const b = thinkBatchRef.current;
    if (!b.text) return;
    liveThinkRef.current += b.text;
    b.text = "";
    b.timer = null;
    forceTick((n) => n + 1);
  }, []);
  const appendThinking = useCallback((chunk) => {
    thinkBatchRef.current.text += chunk;
    if (chunk.includes("\n")) {
      const full = thinkBatchRef.current.text;
      thinkBatchRef.current.text = "";
      if (thinkBatchRef.current.timer) {
        clearTimeout(thinkBatchRef.current.timer);
        thinkBatchRef.current.timer = null;
      }
      const parts = full.split("\n");
      for (let i = 0; i < parts.length - 1; i++) {
        setOutput((prev) => {
          const filtered = prev.filter((e) => e.type !== "thinking");
          return [...filtered, { type: "thinking", text: parts[i] }].slice(-MAX_OUTPUT);
        });
      }
      liveThinkRef.current = parts[parts.length - 1];
      forceTick((n) => n + 1);
      return;
    }
    if (!thinkBatchRef.current.timer) {
      thinkBatchRef.current.timer = setTimeout(flushThinking, TOKEN_BATCH_MS);
    }
  }, [flushThinking]);
  const _working = thinking || ["PLAN", "ACT", "OBSERVE", "REFLECT", "CONSOLIDATE", "THINK"].includes(phase);
  useEffect6(() => {
    const id = setInterval(() => setBlink((b) => !b), 480);
    return () => clearInterval(id);
  }, []);
  useEffect6(() => {
    if (showSplash) return;
    agent_default.onToken((token) => appendToken(token));
    agent_default.onThinking((text) => {
      setThinking(true);
      setThinkingText(text);
      setOutput((prev) => {
        const filtered = prev.filter((e) => e.type !== "thinking");
        return [...filtered, { type: "thinking", text }].slice(-MAX_OUTPUT);
      });
      appendThinking(text);
    });
    agent_default.onThinkingEnd(() => {
      setThinking(false);
      setThinkingText("");
      flushThinking();
      if (liveThinkRef.current) {
        const t2 = liveThinkRef.current;
        liveThinkRef.current = "";
        setOutput((prev) => {
          const filtered = prev.filter((e) => e.type !== "thinking");
          return [...filtered, { type: "thinking", text: t2 }].slice(-MAX_OUTPUT);
        });
      }
    });
    agent_default.onToolStart((name) => {
      setTools((p) => [...p, { name, status: "running", start: Date.now(), result: "" }].slice(-MAX_TOOLS));
    });
    agent_default.onToolEnd((name, result) => {
      setTools((p) => {
        const idx = [...p].reverse().findIndex((t2) => t2.name === name && t2.status === "running");
        if (idx === -1) return [...p, { name, status: "done", result: String(result || "").slice(0, 80), start: Date.now() }].slice(-MAX_TOOLS);
        const real = p.length - 1 - idx;
        const next = [...p];
        const ms = Date.now() - next[real].start;
        const dur = ms < 1e3 ? `${ms}ms` : `${(ms / 1e3).toFixed(1)}s`;
        next[real] = { name, status: "done", result: String(result || "").slice(0, 80), duration: dur };
        return next;
      });
    });
    agent_default.onStatus((s) => {
      setStatus((p) => ({ ...p, ...s }));
      if (s.phase) setPhase(s.phase);
    });
    agent_default.onPhase((p) => setPhase(p));
    agent_default.onQueueUpdate((q) => setQueue(q || []));
    agent_default.onPlan((p) => setPlan(p));
    agent_default.onDiff((d) => {
      setDiffData(d);
      setShowDiff(!!d);
    });
    agent_default.onApproval((req) => {
      const toolCallId = req.tool_call_id || req.id || "";
      const command = req.command || req.args?.command || "";
      const isSudo = /^\s*sudo\b/i.test(String(command));
      setApproval({
        ...req,
        tool_call_id: toolCallId,
        command,
        action: req.tool_name || req.action || "dangerous_command",
        risk: isSudo ? "critical" : req.risk || "high",
        reason: req.reason || "Approval needed",
        isSudo,
        onApprove: (pw) => {
          agent_default.respondApproval(toolCallId, true, false, false, pw || "");
          setOutput((p) => [...p, { type: "system", text: `\u2705 Approved${isSudo ? " sudo" : ""}: ${command}` }].slice(-MAX_OUTPUT));
        },
        onApproveSession: (pw) => {
          agent_default.respondApproval(toolCallId, true, false, true, pw || "");
          setOutput((p) => [...p, { type: "system", text: `\u2705 Approved for session${isSudo ? " sudo" : ""}: ${command}` }].slice(-MAX_OUTPUT));
        },
        onAllowlist: (pw) => {
          agent_default.respondApproval(toolCallId, true, true, false, pw || "");
          setOutput((p) => [...p, { type: "system", text: `\u2705 Approved & allowlisted${isSudo ? " sudo" : ""}: ${command}` }].slice(-MAX_OUTPUT));
        },
        onDeny: (pw) => {
          agent_default.respondApproval(toolCallId, false, false, false, pw || "");
          setOutput((p) => [...p, { type: "system", text: `\u{1F6AB} Denied${isSudo ? " sudo" : ""}: ${command}` }].slice(-MAX_OUTPUT));
        }
      });
    });
    agent_default.onSessions((list) => setSessions(list || []));
    agent_default.onError((err) => {
      flushTokens();
      flushThinking();
      if (liveTextRef.current) {
        const t2 = liveTextRef.current;
        liveTextRef.current = "";
        setOutput((p) => [...p, { type: "assistant", text: t2 }].slice(-MAX_OUTPUT));
      }
      setOutput((prev) => {
        const filtered = prev.filter((e) => e.type !== "thinking");
        return [...filtered, { type: "thinking", text: t }].slice(-MAX_OUTPUT);
      });
      setOutput((p) => [...p, { type: "error", text: typeof err === "string" ? err : err?.message || "Unknown error" }].slice(-MAX_OUTPUT));
      setThinking(false);
    });
    agent_default.onDone(() => {
      flushTokens();
      flushThinking();
      if (liveTextRef.current) {
        const t2 = liveTextRef.current;
        liveTextRef.current = "";
        setOutput((p) => [...p, { type: "assistant", text: t2 }].slice(-MAX_OUTPUT));
      }
      setOutput((prev) => {
        const filtered = prev.filter((e) => e.type !== "thinking");
        return [...filtered, { type: "thinking", text: t }].slice(-MAX_OUTPUT);
      });
      setThinking(false);
      setStatus((p) => ({ ...p, phase: "done" }));
    });
    if (agent_default.contextMax) setContextMax(agent_default.contextMax);
    const ctxInterval = setInterval(() => {
      try {
        const info = agent_default.getContextInfo?.();
        if (!info) return;
        setContextChars((prev) => prev === info.chars ? prev : info.chars);
      } catch {
      }
    }, 2e3);
    return () => {
      clearInterval(ctxInterval);
    };
  }, [showSplash, appendToken]);
  const handleSlashCommand = useCallback((cmd) => {
    const parts = cmd.trim().split(/\s+/);
    const command = parts[0];
    const arg = parts.slice(1).join(" ");
    switch (command) {
      case "/help":
        setShowHelp(true);
        break;
      case "/status":
        setOutput((p) => [...p, { type: "system", text: `Model: ${status.model} | Provider: ${status.provider || "ollama"} | Phase: ${phase} | Trust: ${status.trust} | Tokens: ${status.tokens} | Context chars: ${contextChars.toLocaleString()}` }].slice(-MAX_OUTPUT));
        break;
      case "/model":
        if (arg) {
          agent_default.setModel?.(arg);
          setStatus((p) => ({ ...p, model: arg }));
        } else {
          setShowModelDialog(true);
        }
        break;
      case "/commands":
        setShowCommandsDialog(true);
        break;
      case "/provider":
        if (arg) {
          agent_default.setProvider?.(arg);
          setStatus((p) => ({ ...p, provider: arg }));
        }
        break;
      case "/trust":
        if (arg) {
          const lvl = parseInt(arg, 10);
          agent_default.setTrust?.(lvl);
          setStatus((p) => ({ ...p, trust: lvl }));
        }
        break;
      case "/approve":
        if (approval?.onApprove) {
          approval.onApprove();
          setApproval(null);
        }
        break;
      case "/deny":
        if (approval?.onDeny) {
          approval.onDeny();
          setApproval(null);
        }
        break;
      case "/clear":
        setOutput([]);
        setTools([]);
        setScrollOffset(0);
        break;
      case "/compact":
        agent_default.compact?.();
        setOutput((p) => [...p, { type: "system", text: "Context compacted." }].slice(-MAX_OUTPUT));
        break;
      case "/diff":
        setShowDiff((prev) => !prev);
        break;
      case "/review":
        agent_default.review?.();
        setOutput((p) => [...p, { type: "system", text: "Running code review..." }].slice(-MAX_OUTPUT));
        break;
      case "/plan":
        setShowPlan((prev) => !prev);
        break;
      case "/sessions":
        agent_default.listSessions?.();
        setShowSessions(true);
        break;
      case "/resume":
        if (arg) {
          agent_default.resume?.(arg);
          setShowSessions(false);
        }
        break;
      case "/save":
        agent_default.saveSession?.();
        setOutput((p) => [...p, { type: "system", text: "Session saved." }].slice(-MAX_OUTPUT));
        break;
      case "/memory":
        agent_default.showMemory?.();
        setOutput((p) => [...p, { type: "system", text: "Memory loaded." }].slice(-MAX_OUTPUT));
        break;
      case "/skills":
        agent_default.listSkills?.();
        setOutput((p) => [...p, { type: "system", text: "Skills listed." }].slice(-MAX_OUTPUT));
        break;
      case "/theme":
        if (arg && THEMES[arg]) {
          setThemeName(arg);
        } else {
          setOutput((p) => [...p, { type: "system", text: `Themes: ${Object.keys(THEMES).join(", ")}` }].slice(-MAX_OUTPUT));
        }
        break;
      case "/fast":
        agent_default.toggleFast?.();
        setOutput((p) => [...p, { type: "system", text: "Fast mode toggled." }].slice(-MAX_OUTPUT));
        break;
      case "/health":
        agent_default.health?.();
        setOutput((p) => [...p, { type: "system", text: "Health check sent." }].slice(-MAX_OUTPUT));
        break;
      case "/undo":
        agent_default.undo?.();
        setOutput((p) => [...p, { type: "system", text: "Undo requested." }].slice(-MAX_OUTPUT));
        break;
      case "/exit":
        exit();
        break;
      default:
        setOutput((p) => [...p, { type: "system", text: `Unknown command: ${command}` }].slice(-MAX_OUTPUT));
    }
  }, [approval, status, phase, exit]);
  useInput5((raw, key) => {
    if (showSplash) return;
    if (showModelDialog || showCommandsDialog) return;
    if (showHelp && (key.escape || raw === "q")) {
      setShowHelp(false);
      return;
    }
    if (showSessions && (key.escape || raw === "q")) {
      setShowSessions(false);
      return;
    }
    if (approval) {
      return;
    }
    if (showDiff && diffData) {
      if (raw === "y" || raw === "Y") {
        diffData.onApprove?.();
        setShowDiff(false);
        setDiffData(null);
        return;
      }
      if (raw === "n" || raw === "N") {
        diffData.onDeny?.();
        setShowDiff(false);
        setDiffData(null);
        return;
      }
      if (raw === "v" || raw === "V") {
        return;
      }
      return;
    }
    if (raw === "/" && !input) {
      setInput("/");
      setShowSlashMenu(true);
      return;
    }
    if (showSlashMenu) {
      if (key.escape) {
        setShowSlashMenu(false);
        setInput("");
        return;
      }
      if (key.return) {
        handleSlashCommand(input);
        setInput("");
        setShowSlashMenu(false);
        return;
      }
      if (key.backspace || key.delete) {
        const n = input.slice(0, -1);
        setInput(n);
        if (!n) setShowSlashMenu(false);
        return;
      }
      if (raw && !key.ctrl && !key.meta && raw.length === 1) {
        setInput((p) => p + raw);
        return;
      }
      return;
    }
    if (key.upArrow) {
      setScrollOffset((o) => Math.min(maxScroll + 5, o + 1));
      return;
    }
    if (key.downArrow) {
      setScrollOffset((o) => Math.max(0, o - 1));
      return;
    }
    if (key.shift && key.upArrow) {
      setScrollOffset((o) => Math.min(maxScroll + 5, o + 10));
      return;
    }
    if (key.shift && key.downArrow) {
      setScrollOffset((o) => Math.max(0, o - 10));
      return;
    }
    if (key.return) {
      const text = input;
      if (!text.trim()) return;
      if (text.startsWith("/")) {
        handleSlashCommand(text);
        setInput("");
        return;
      }
      setOutput((p) => [...p, { type: "user", text }].slice(-MAX_OUTPUT));
      setInput("");
      agent_default.send?.(text);
      return;
    }
    if (key.backspace || key.delete) {
      setInput((p) => p.slice(0, -1));
      return;
    }
    if (key.ctrl && raw === "c") {
      exit();
      return;
    }
    if (raw && !key.ctrl && !key.meta && raw.length === 1) {
      setInput((p) => p + raw);
      return;
    }
  });
  if (showSplash) {
    return /* @__PURE__ */ jsx16(SplashScreen, { version: "0.1.0", onDone: () => setShowSplash(false) });
  }
  return /* @__PURE__ */ jsxs17(Box16, { flexDirection: "column", height: rows, width: cols, children: [
    /* @__PURE__ */ jsx16(
      StatusBar,
      {
        model: status.model,
        provider: status.provider || "ollama",
        trustLevel: status.trust,
        approvalMode: "on-request",
        contextUsed: status.tokens,
        contextMax,
        phase,
        cols,
        sessionId: agent_default.sessionId || ""
      }
    ),
    /* @__PURE__ */ jsxs17(Box16, { flexDirection: "column", height: outputHeight + 1, width: cols, overflow: "hidden", children: [
      olderAbove > 0 && /* @__PURE__ */ jsxs17(Text17, { color: theme.primary, bold: true, reverse: true, children: [
        " \u2191 ",
        olderAbove,
        " line(s) above (older) \u2014 Shift+\u2191 for more "
      ] }),
      visible.map((line, i) => {
        if (line.type === "user") {
          return /* @__PURE__ */ jsx16(Text17, { color: "green", bold: true, children: "> " + line.text }, i);
        }
        if (line.type === "assistant") {
          return /* @__PURE__ */ jsx16(Text17, { color: "white", children: line.text }, i);
        }
        if (line.type === "thinking") {
          const cls = classifyReasoning(line.text);
          const color = cls ? cls.color : theme.dim;
          return /* @__PURE__ */ jsxs17(Text17, { color, dim: true, children: [
            "  ",
            line.text
          ] }, i);
        }
        if (line.type === "system") {
          return /* @__PURE__ */ jsx16(Text17, { color: "cyan", dim: true, children: "[sys] " + line.text }, i);
        }
        return /* @__PURE__ */ jsx16(Text17, { color: "white", children: line.text }, i);
      }),
      _working && liveTextRef.current && /* @__PURE__ */ jsx16(Text17, { color: blink ? theme.accent : theme.primary, bold: true, children: liveTextRef.current }),
      thinking && liveThinkRef.current && /* @__PURE__ */ jsxs17(Text17, { color: blink ? theme.secondary : theme.primary, dim: true, children: [
        "  ",
        liveThinkRef.current
      ] }),
      newerBelow > 0 && /* @__PURE__ */ jsxs17(Text17, { color: theme.secondary, bold: true, reverse: true, children: [
        " \u2193 ",
        newerBelow,
        " line(s) below (newer) \u2014 \u2193 to return to bottom "
      ] })
    ] }),
    /* @__PURE__ */ jsx16(ThinkingBox, { thinking: thinkingText, phase: status.phase, cols, theme }),
    output.length > 0 && /* @__PURE__ */ jsx16(MessageGrid, { messages: output.slice(-8).map((o) => ({
      role: o.type === "user" ? "user" : o.type === "thinking" ? "thinking" : o.type === "tool" ? "tool" : "assistant",
      content: o.text || o.content || "",
      model: o.model,
      timestamp: o.timestamp
    })), cols, theme }),
    tools.length > 0 && /* @__PURE__ */ jsxs17(Box16, { width: cols, flexDirection: "row", overflow: "hidden", children: [
      /* @__PURE__ */ jsx16(Text17, { color: "gray", dim: true, children: "tools: " }),
      tools.slice(-6).map((t2, i) => /* @__PURE__ */ jsxs17(Text17, { color: t2.status === "running" ? "yellow" : theme.success, children: [
        t2.status === "running" ? "\u25C9" : "\u2713",
        t2.name,
        t2.duration ? `(${t2.duration})` : "",
        " "
      ] }, i))
    ] }),
    queue && queue.length > 0 && /* @__PURE__ */ jsx16(QueueBox, { items: queue, cols }),
    showPlan && plan && /* @__PURE__ */ jsx16(PlanDisplay, { plan, cols }),
    /* @__PURE__ */ jsx16(
      InputBox,
      {
        value: input,
        onChange: setInput,
        onSubmit: (text) => {
          if (text.trim()) {
            agent_default.send(text);
            setInput("");
          }
        },
        cols,
        disabled: status.phase === "thinking" || status.phase === "working" || !!approval,
        queueCount: queue?.length || 0,
        theme
      }
    ),
    /* @__PURE__ */ jsx16(
      StatusBar,
      {
        model: status.model,
        phase: status.phase,
        trust: status.trust,
        cols,
        connected: status.connected,
        tokens: status.tokens
      }
    ),
    showDiff && diffData && /* @__PURE__ */ jsx16(DiffPreview, { diff: diffData.text || diffData, cols, onApprove: diffData.onApprove, onDeny: diffData.onDeny }),
    approval && /* @__PURE__ */ jsx16(
      ApprovalPrompt,
      {
        action: approval.action,
        command: approval.command,
        reason: approval.reason || "",
        risk: approval.risk || "medium",
        isSudo: approval.isSudo,
        onApprove: (pw) => {
          approval.onApprove?.(pw);
          setApproval(null);
        },
        onApproveSession: (pw) => {
          approval.onApproveSession?.(pw);
          setApproval(null);
        },
        onAllowlist: (pw) => {
          approval.onAllowlist?.(pw);
          setApproval(null);
        },
        onDeny: (pw) => {
          approval.onDeny?.(pw);
          setApproval(null);
        }
      }
    ),
    showSessions && /* @__PURE__ */ jsx16(SessionList, { sessions, cols, onSelect: (s) => {
      agent_default.resume?.(s.id);
      setShowSessions(false);
    } }),
    showHelp && /* @__PURE__ */ jsx16(HelpOverlay, { onDismiss: () => setShowHelp(false) }),
    showSlashMenu && /* @__PURE__ */ jsx16(SlashMenu, { input, cols }),
    showModelDialog && /* @__PURE__ */ jsx16(
      ModelDialog,
      {
        cols,
        rows,
        currentModel: status.model,
        onDismiss: () => setShowModelDialog(false),
        onSetProviderKey: (provider, key) => {
          agent_default._apiKeys = agent_default._apiKeys || {};
          agent_default._apiKeys[provider] = key;
          return true;
        },
        onSelect: (model, provider, modelType) => {
          agent_default.setModel?.(model);
          agent_default.setProvider?.(provider);
          setStatus((p) => ({ ...p, model, provider }));
          setOutput((p) => [...p, { type: "system", text: `Model \u2192 ${model} (${provider}) [${modelType}]` }].slice(-MAX_OUTPUT));
          setShowModelDialog(false);
        }
      }
    ),
    showCommandsDialog && /* @__PURE__ */ jsx16(
      CommandsDialog,
      {
        cols,
        rows,
        onDismiss: () => setShowCommandsDialog(false),
        onSelect: (id) => {
          setShowCommandsDialog(false);
          const map = {
            switch_model: () => setShowModelDialog(true),
            toggle_help: () => setShowHelp(true),
            toggle_diff: () => handleSlashCommand("/diff"),
            toggle_plan: () => handleSlashCommand("/plan"),
            toggle_thinking: () => agent_default.toggleThinking?.(),
            toggle_yolo: () => handleSlashCommand("/trust 30"),
            summarize: () => handleSlashCommand("/compact"),
            review: () => handleSlashCommand("/review"),
            health: () => handleSlashCommand("/health"),
            switch_session: () => handleSlashCommand("/sessions"),
            new_session: () => {
              setOutput([]);
              setTools([]);
              agent_default.newSession?.();
            },
            file_picker: () => setOutput((p) => [...p, { type: "system", text: "File picker not available in TUI." }].slice(-MAX_OUTPUT)),
            init: () => agent_default.send?.("initialize project \u2014 create/update CRUSH.md memory file"),
            quit: () => exit()
          };
          if (map[id]) {
            map[id]();
            return;
          }
          if (id.startsWith("/")) {
            handleSlashCommand(id);
            return;
          }
          setOutput((p) => [...p, { type: "system", text: `Unknown command: ${id}` }].slice(-MAX_OUTPUT));
        }
      }
    ),
    /* @__PURE__ */ jsxs17(Box16, { width: cols, borderStyle: "bold", borderColor: _working ? blink ? theme.secondary : theme.primary : theme.primary, paddingX: 1, children: [
      /* @__PURE__ */ jsxs17(Text17, { color: phase === "ACT" ? theme.warning : theme.primary, bold: true, reverse: true, children: [
        _working ? blink ? "\u25C6" : "\u25C7" : phase === "ACT" ? "\u25C6" : ">",
        " "
      ] }),
      /* @__PURE__ */ jsxs17(Text17, { color: "white", bold: true, children: [
        input,
        blink ? "\u258D" : " "
      ] }),
      /* @__PURE__ */ jsx16(Text17, { color: "gray", dim: true, children: showSlashMenu ? "" : "  (/help, Tab for commands, Ctrl+C to exit)" })
    ] })
  ] });
}

// src/index.jsx
import { jsx as jsx17 } from "react/jsx-runtime";
var rendered = false;
function start() {
  if (rendered) return;
  rendered = true;
  render(/* @__PURE__ */ jsx17(App, {}));
}
export {
  start
};
