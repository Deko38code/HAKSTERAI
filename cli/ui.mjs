// Built by esbuild — do not edit. Run: node build.mjs

// src/index.jsx
import React12 from "react";
import { render } from "ink";

// src/App.jsx
import React11, { useState as useState4, useEffect as useEffect3, useRef, useCallback, useMemo as useMemo2 } from "react";
import { Box as Box10, Text as Text11, useInput as useInput2, useApp, useStdout } from "ink";

// src/agent.jsx
import { EventEmitter } from "events";
var SERVER_URL = process.env.HAKSTER_URL || "ws://localhost:3579/ws";
var API_URL = process.env.HAKSTER_API_URL || "http://localhost:3579";
var HaksterAgent = class extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.model = process.env.HAKSTER_MODEL || "glm-5.2:cloud";
    this.sessionId = null;
    this.connected = false;
    this.lowToken = process.env.HAKSTER_LOW_TOKEN === "1" || process.env.HAKSTER_LOW_TOKEN === "true";
    this.contextMax = 0;
    this._messages = [];
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
        const lines = buffer.split("\n");
        buffer = lines.pop();
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const data = JSON.parse(line.slice(6));
              this._handleMessage(data);
            } catch {
            }
          }
        }
      }
    } catch (e) {
      if (this._errorCb) this._errorCb(e.message || "Request failed");
    }
  }
  // ── Model selection ──────────────────────────────────
  setModel(model) {
    this.model = model;
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
  async respondApproval(toolCallId, approved, permanent = false) {
    try {
      await fetch(`${API_URL}/api/agent/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: this.sessionId || "",
          toolCallId,
          approved,
          command: "",
          permanent
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

// src/components/ApprovalPrompt.jsx
import React4 from "react";
import { Box as Box4, Text as Text4, useInput } from "ink";
import { jsx as jsx4, jsxs as jsxs4 } from "react/jsx-runtime";
function ApprovalPrompt({
  action = "",
  command = "",
  risk = "medium",
  // low, medium, high, critical
  reason = "",
  onApprove,
  onDeny,
  onAllowlist
}) {
  const isSudo = typeof risk === "string" && risk === "critical";
  const riskConfig = {
    low: { color: "green", icon: "\u2713", label: "LOW" },
    medium: { color: "yellow", icon: "\u26A0\uFE0F", label: "MEDIUM" },
    high: { color: "red", icon: "\u26A0\uFE0F", label: "HIGH" },
    critical: { color: "red", icon: "\u{1F511}", label: "SUDO" }
  };
  const rc = riskConfig[risk] || riskConfig.medium;
  useInput((raw, key) => {
    if (key.escape || raw === "n" || raw === "N") {
      onDeny?.();
      return;
    }
    if (raw === "y" || raw === "Y") {
      onApprove?.();
      return;
    }
    if (raw === "a" || raw === "A") {
      onAllowlist?.();
      return;
    }
  });
  const displayCommand = (command || "").slice(0, 120) + ((command || "").length > 120 ? "\u2026" : "");
  const displayReason = (reason || (isSudo ? "SUDO ELEVATED COMMAND" : "Dangerous command detected")).slice(0, 90);
  return /* @__PURE__ */ jsxs4(
    Box4,
    {
      flexDirection: "column",
      borderStyle: "double",
      borderColor: rc.color,
      paddingX: 2,
      paddingY: 1,
      width: Math.min(90, 48),
      children: [
        /* @__PURE__ */ jsxs4(Box4, { justifyContent: "space-between", children: [
          /* @__PURE__ */ jsxs4(Text4, { color: rc.color, bold: true, children: [
            rc.icon,
            " ",
            rc.label,
            " \u2014 Approval Required"
          ] }),
          /* @__PURE__ */ jsx4(Text4, { color: "gray", dim: true, children: "[ Esc = deny ]" })
        ] }),
        /* @__PURE__ */ jsx4(Box4, { marginTop: 0, children: /* @__PURE__ */ jsxs4(Text4, { color: "white", children: [
          isSudo ? "\u{1F511} SUDO " : "\u26A0\uFE0F ",
          displayReason
        ] }) }),
        command && /* @__PURE__ */ jsx4(Box4, { marginTop: 0, children: /* @__PURE__ */ jsxs4(Text4, { color: "gray", children: [
          "$ ",
          displayCommand
        ] }) }),
        /* @__PURE__ */ jsxs4(Box4, { marginTop: 1, children: [
          /* @__PURE__ */ jsx4(Text4, { color: "green", bold: true, children: "[Y]" }),
          /* @__PURE__ */ jsx4(Text4, { color: "gray", children: " Approve this run \u2502 " }),
          /* @__PURE__ */ jsx4(Text4, { color: "red", bold: true, children: "[N]" }),
          /* @__PURE__ */ jsx4(Text4, { color: "gray", children: " Deny \u2502 " }),
          /* @__PURE__ */ jsx4(Text4, { color: "yellow", bold: true, children: "[A]" }),
          /* @__PURE__ */ jsx4(Text4, { color: "gray", children: " Approve & Add to allowlist" })
        ] })
      ]
    }
  );
}

// src/components/DiffPreview.jsx
import React5 from "react";
import { Box as Box5, Text as Text5 } from "ink";
import { jsx as jsx5, jsxs as jsxs5 } from "react/jsx-runtime";
function DiffPreview({ diff, cols = 80, onApprove, onDeny }) {
  if (!diff) return null;
  const lines = diff.split("\n").slice(0, 20);
  return /* @__PURE__ */ jsxs5(Box5, { flexDirection: "column", borderStyle: "round", borderColor: "yellow", paddingX: 1, children: [
    /* @__PURE__ */ jsxs5(Box5, { justifyContent: "space-between", children: [
      /* @__PURE__ */ jsx5(Text5, { color: "yellow", bold: true, children: "\u26A0 Diff Preview \u2014 Review Before Apply" }),
      /* @__PURE__ */ jsx5(Text5, { color: "gray", dim: true, children: "Y=approve \u2502 N=deny \u2502 V=view more" })
    ] }),
    /* @__PURE__ */ jsxs5(Box5, { flexDirection: "column", marginTop: 0, children: [
      lines.map((line, i) => {
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
        return /* @__PURE__ */ jsxs5(Text5, { color, wrap: "truncate", children: [
          prefix,
          " ",
          line.slice(0, cols - 4)
        ] }, i);
      }),
      diff.split("\n").length > 20 && /* @__PURE__ */ jsxs5(Text5, { color: "gray", dim: true, children: [
        "... ",
        diff.split("\n").length - 20,
        " more lines (press V to view)"
      ] })
    ] }),
    /* @__PURE__ */ jsxs5(Box5, { marginTop: 0, children: [
      /* @__PURE__ */ jsx5(Text5, { color: "green", bold: true, children: "[Y]" }),
      /* @__PURE__ */ jsx5(Text5, { color: "gray", children: " approve \u2502 " }),
      /* @__PURE__ */ jsx5(Text5, { color: "red", bold: true, children: "[N]" }),
      /* @__PURE__ */ jsx5(Text5, { color: "gray", children: " deny \u2502 " }),
      /* @__PURE__ */ jsx5(Text5, { color: "blue", bold: true, children: "[V]" }),
      /* @__PURE__ */ jsx5(Text5, { color: "gray", children: " view full" })
    ] })
  ] });
}

// src/components/PlanDisplay.jsx
import React6 from "react";
import { Box as Box6, Text as Text6 } from "ink";
import { jsx as jsx6, jsxs as jsxs6 } from "react/jsx-runtime";
function PlanDisplay({ plan = null, cols = 80 }) {
  if (!plan) return null;
  const { goal, steps = [], files = [] } = plan;
  return /* @__PURE__ */ jsxs6(
    Box6,
    {
      flexDirection: "column",
      borderStyle: "single",
      borderColor: "blue",
      paddingX: 1,
      children: [
        /* @__PURE__ */ jsx6(Text6, { color: "blue", bold: true, underline: true, children: "\u{1F4CB} Plan" }),
        goal && /* @__PURE__ */ jsxs6(Text6, { color: "white", children: [
          "Goal: ",
          /* @__PURE__ */ jsx6(Text6, { color: "cyan", children: goal })
        ] }),
        steps.length > 0 && /* @__PURE__ */ jsx6(Box6, { flexDirection: "column", marginTop: 0, children: steps.map((step, i) => {
          const done = step.status === "done";
          const active = step.status === "active";
          const icon = done ? "\u2713" : active ? "\u25C9" : "\u25CB";
          const color = done ? "green" : active ? "yellow" : "gray";
          return /* @__PURE__ */ jsxs6(Text6, { color, children: [
            icon,
            " [",
            i + 1,
            "] ",
            step.text || step.desc || step
          ] }, i);
        }) }),
        files.length > 0 && /* @__PURE__ */ jsx6(Box6, { marginTop: 0, children: /* @__PURE__ */ jsxs6(Text6, { color: "magenta", dim: true, children: [
          "Files: ",
          files.join(", ")
        ] }) })
      ]
    }
  );
}

// src/components/SessionList.jsx
import React7 from "react";
import { Box as Box7, Text as Text7 } from "ink";
import { jsx as jsx7, jsxs as jsxs7 } from "react/jsx-runtime";
function SessionList({ sessions = [], cols = 80, onSelect }) {
  if (sessions.length === 0) {
    return /* @__PURE__ */ jsx7(Box7, { borderStyle: "round", borderColor: "gray", paddingX: 1, children: /* @__PURE__ */ jsx7(Text7, { color: "gray", dim: true, children: "No saved sessions. Use /save to save current session." }) });
  }
  return /* @__PURE__ */ jsxs7(Box7, { flexDirection: "column", borderStyle: "round", borderColor: "cyan", paddingX: 1, children: [
    /* @__PURE__ */ jsx7(Text7, { color: "cyan", bold: true, underline: true, children: "Saved Sessions" }),
    sessions.map((s, i) => {
      const date = s.updatedAt ? new Date(s.updatedAt).toLocaleDateString() : "?";
      const time = s.updatedAt ? new Date(s.updatedAt).toLocaleTimeString() : "";
      return /* @__PURE__ */ jsxs7(Box7, { children: [
        /* @__PURE__ */ jsxs7(Text7, { color: "green", bold: true, children: [
          "[",
          (i + 1).toString().padStart(2),
          "]"
        ] }),
        /* @__PURE__ */ jsx7(Text7, { color: "cyan", children: " " + (s.id || "").slice(0, 12) }),
        /* @__PURE__ */ jsx7(Text7, { color: "gray", children: " " + (s.provider || "").padEnd(8) }),
        /* @__PURE__ */ jsx7(Text7, { color: "magenta", children: " " + (s.model || "").padEnd(16) }),
        /* @__PURE__ */ jsx7(Text7, { color: "gray", dim: true, children: " " + date + " " + time })
      ] }, s.id || i);
    }),
    /* @__PURE__ */ jsxs7(Text7, { color: "gray", dim: true, marginTop: 0, children: [
      "Use /resume ",
      "<id>",
      " to resume a session"
    ] })
  ] });
}

// src/components/Spinner.jsx
import React8, { useState as useState2, useEffect } from "react";
import { Text as Text8 } from "ink";
import { jsxs as jsxs8 } from "react/jsx-runtime";
var FRAMES = ["\u280B", "\u2819", "\u2839", "\u2838", "\u283C", "\u2834", "\u2826", "\u2827", "\u2807", "\u280F"];
var FRAMES_DOTS = ["\u28FE", "\u28FD", "\u28FB", "\u28BF", "\u287F", "\u28DF", "\u28EF", "\u28F7"];
function Spinner({ type = "braille", label = "", color = "yellow" }) {
  const [frame, setFrame] = useState2(0);
  const frames = type === "dots" ? FRAMES_DOTS : FRAMES;
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % frames.length), 80);
    return () => clearInterval(id);
  }, [frames.length]);
  return /* @__PURE__ */ jsxs8(Text8, { color, children: [
    frames[frame],
    " ",
    label
  ] });
}

// src/components/SplashScreen.jsx
import React9, { useState as useState3, useEffect as useEffect2 } from "react";
import { Box as Box8, Text as Text9 } from "ink";
import { jsx as jsx8, jsxs as jsxs9 } from "react/jsx-runtime";
var LOGO = [
  " \u2554\u2550\u2557 \u2566 \u2566 \u2554\u2550\u2557 \u2566\u2554\u2550 \u2554\u2550\u2557 \u2566   \u2554\u2566\u2557 \u2554\u2550\u2557 \u2566 \u2566",
  " \u2551   \u2551 \u2551 \u2560\u2550\u255D \u2560\u2569\u2557 \u2551   \u2551    \u2551  \u2551 \u2551 \u2551 \u2551",
  " \u255A\u2550\u255D \u255A\u2550\u255D \u2569   \u2569 \u2569 \u255A\u2550\u255D \u255A\u2550\u255D  \u2569  \u255A\u2550\u255D \u255A\u2550\u255D"
];
function SplashScreen({ onDone, version = "0.1.0" }) {
  const [frame, setFrame] = useState3(0);
  useEffect2(() => {
    if (frame >= LOGO.length + 2) {
      onDone && onDone();
      return;
    }
    const id = setTimeout(() => setFrame((f) => f + 1), 120);
    return () => clearTimeout(id);
  }, [frame, onDone]);
  return /* @__PURE__ */ jsxs9(Box8, { flexDirection: "column", alignItems: "center", justifyContent: "center", children: [
    LOGO.slice(0, frame).map((line, i) => /* @__PURE__ */ jsx8(Text9, { color: "green", bold: true, children: line }, i)),
    frame >= LOGO.length && /* @__PURE__ */ jsxs9(Box8, { flexDirection: "column", marginTop: 1, children: [
      /* @__PURE__ */ jsxs9(Text9, { color: "cyan", bold: true, children: [
        "HaksterAI CLI v",
        version
      ] }),
      /* @__PURE__ */ jsx8(Text9, { color: "gray", dim: true, children: "Pentester AI Agent \xB7 Autonomous Coding \xB7 IPTV Ops" }),
      /* @__PURE__ */ jsx8(Text9, { color: "magenta", dim: true, children: "Type ? for help \xB7 Enter to start \xB7 Ctrl+C to exit" })
    ] })
  ] });
}

// src/components/TokenBar.jsx
import React10 from "react";
import { Box as Box9, Text as Text10 } from "ink";
import { jsx as jsx9, jsxs as jsxs10 } from "react/jsx-runtime";
function TokenBar({ used = 0, max = 128e3, cols = 80 }) {
  const pct = Math.min(100, Math.round(used / max * 100));
  const barWidth = Math.max(10, cols - 30);
  const filled = Math.floor(pct / 100 * barWidth);
  const bar = "\u2588".repeat(filled).padEnd(barWidth, "\u2591");
  const color = pct > 85 ? "red" : pct > 60 ? "yellow" : "green";
  const label = `${(used / 1e3).toFixed(1)}K/${(max / 1e3).toFixed(0)}K`;
  return /* @__PURE__ */ jsxs10(Box9, { width: cols, paddingX: 1, children: [
    /* @__PURE__ */ jsx9(Text10, { color: "gray", dim: true, children: "tokens " }),
    /* @__PURE__ */ jsxs10(Text10, { color, children: [
      "[",
      bar,
      "]"
    ] }),
    /* @__PURE__ */ jsxs10(Text10, { color, bold: true, children: [
      " ",
      pct,
      "%"
    ] }),
    /* @__PURE__ */ jsxs10(Text10, { color: "gray", dim: true, children: [
      " ",
      label
    ] })
  ] });
}

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
import { jsx as jsx10, jsxs as jsxs11 } from "react/jsx-runtime";
var MAX_OUTPUT = 500;
var MAX_TOOLS = 50;
var REASONING_TYPES = [
  { pattern: /^(?:checking|scanning|looking|reading|inspecting)/i, type: "inspect", color: "blue" },
  { pattern: /^(?:found|detected|identified|located)/i, type: "find", color: "green" },
  { pattern: /^(?:error|fail|issue|problem|bug|crash|exception)/i, type: "error", color: "red" },
  { pattern: /^(?:plan|step|approach|strategy|decide|will|should)/i, type: "plan", color: "yellow" },
  { pattern: /^(?:conclusion|therefore|so |thus|result)/i, type: "conclusion", color: "yellow" },
  { pattern: /^(?:root cause|the issue is|the problem is)/i, type: "diagnosis", color: "orange" }
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
  const [showSplash, setShowSplash] = useState4(true);
  const [themeName, setThemeName] = useState4("default");
  const theme = useMemo2(() => THEMES[themeName] || THEMES.default, [themeName]);
  const [output, setOutput] = useState4([]);
  const [tools, setTools] = useState4([]);
  const [input, setInput] = useState4("");
  const [thinking, setThinking] = useState4(false);
  const [status, setStatus] = useState4({ task: "idle", model: agent_default.model || "unknown", phase: "IDLE", tokens: 0, trust: 0, provider: "ollama" });
  const [phase, setPhase] = useState4("IDLE");
  const [queue, setQueue] = useState4([]);
  const [scrollOffset, setScrollOffset] = useState4(0);
  const [showHelp, setShowHelp] = useState4(false);
  const [showSlashMenu, setShowSlashMenu] = useState4(false);
  const [showPlan, setShowPlan] = useState4(false);
  const [showSessions, setShowSessions] = useState4(false);
  const [showDiff, setShowDiff] = useState4(false);
  const [diffData, setDiffData] = useState4(null);
  const [plan, setPlan] = useState4(null);
  const [sessions, setSessions] = useState4([]);
  const [approval, setApproval] = useState4(null);
  const [contextMax, setContextMax] = useState4(128e3);
  const inputRef = useRef("");
  const batchRef = useRef({ timer: null, text: "" });
  const maxScroll = Math.max(0, output.length - outputHeight);
  const effectiveOffset = Math.min(maxScroll, scrollOffset);
  const visible = output.slice(
    Math.max(0, output.length - outputHeight - effectiveOffset),
    output.length - effectiveOffset
  );
  // Shared render clock: streamed tokens are flushed AND the thinking spinner
  // advances on the SAME tick, so output + spinner always render in sync
  // (no more disconnected spinner frame that makes the TUI "disappear").
  const [renderTick, setRenderTick] = useState4(0);
  const thinkingRef = useRef(false);
  const renderClockRef = useRef(null);
  const flushTokens = useCallback(() => {
    const b = batchRef.current;
    if (!b.text) return;
    const text = b.text;
    b.text = "";
    b.timer = null;
    setOutput((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.type === "assistant") {
        return [...prev.slice(0, -1), { type: "assistant", text: last.text + text }].slice(-MAX_OUTPUT);
      }
      return [...prev, { type: "assistant", text }].slice(-MAX_OUTPUT);
    });
  }, []);
  const startRenderClock = useCallback(() => {
    if (renderClockRef.current) return;
    renderClockRef.current = setInterval(() => {
      flushTokens();
      setRenderTick((t) => (t + 1) % 1000000000);
      if (!batchRef.current.text && !thinkingRef.current) {
        clearInterval(renderClockRef.current);
        renderClockRef.current = null;
      }
    }, 50);
  }, [flushTokens]);
  const appendToken = useCallback((token) => {
    batchRef.current.text += token;
    startRenderClock();
  }, [startRenderClock]);
  useEffect3(() => {
    if (showSplash) return;
    agent_default.onToken((token) => appendToken(token));
    agent_default.onThinking((text) => {
      setThinking(true);
      setOutput((prev) => {
        if (prev.length && prev[prev.length - 1].type === "thinking" && prev[prev.length - 1].text === text) return prev;
        return [...prev, { type: "thinking", text }].slice(-MAX_OUTPUT);
      });
    });
    agent_default.onThinkingEnd(() => setThinking(false));
    agent_default.onToolStart((name) => {
      setTools((p) => [...p, { name, status: "running", start: Date.now(), result: "" }].slice(-MAX_TOOLS));
    });
    agent_default.onToolEnd((name, result) => {
      setTools((p) => {
        const idx = [...p].reverse().findIndex((t) => t.name === name && t.status === "running");
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
        onApprove: () => {
          agent_default.respondApproval(toolCallId, true);
          setOutput((p) => [...p, { type: "system", text: `\u2705 Approved${isSudo ? " sudo" : ""}: ${command}` }].slice(-MAX_OUTPUT));
        },
        onAllowlist: () => {
          agent_default.respondApproval(toolCallId, true, true);
          setOutput((p) => [...p, { type: "system", text: `\u2705 Approved & allowlisted${isSudo ? " sudo" : ""}: ${command}` }].slice(-MAX_OUTPUT));
        },
        onDeny: () => {
          agent_default.respondApproval(toolCallId, false);
          setOutput((p) => [...p, { type: "system", text: `\u{1F6AB} Denied${isSudo ? " sudo" : ""}: ${command}` }].slice(-MAX_OUTPUT));
        }
      });
    });
    agent_default.onSessions((list) => setSessions(list || []));
    agent_default.onError((err) => {
      setOutput((p) => [...p, { type: "error", text: typeof err === "string" ? err : err?.message || "Unknown error" }].slice(-MAX_OUTPUT));
      setThinking(false);
    });
    agent_default.onDone(() => {
      setThinking(false);
      setStatus((p) => ({ ...p, phase: "done" }));
    });
    if (agent_default.contextMax) setContextMax(agent_default.contextMax);
    return () => {
    };
  }, [showSplash, appendToken]);
  // ── Thinking spinner sync: keep the shared render clock alive while the
  // agent is thinking so the spinner advances in lockstep with output. ──
  useEffect3(() => {
    thinkingRef.current = thinking;
    if (thinking) startRenderClock();
  }, [thinking, startRenderClock]);
  const handleSlashCommand = useCallback((cmd) => {
    const parts = cmd.trim().split(/\s+/);
    const command = parts[0];
    const arg = parts.slice(1).join(" ");
    switch (command) {
      case "/help":
        setShowHelp(true);
        break;
      case "/status":
        setOutput((p) => [...p, { type: "system", text: `Model: ${status.model} | Provider: ${status.provider || "ollama"} | Phase: ${phase} | Trust: ${status.trust} | Tokens: ${status.tokens}` }].slice(-MAX_OUTPUT));
        break;
      case "/model":
        if (arg) {
          agent_default.setModel?.(arg);
          setStatus((p) => ({ ...p, model: arg }));
        }
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
  useInput2((raw, key) => {
    if (showSplash) return;
    if (showHelp && (key.escape || raw === "q")) {
      setShowHelp(false);
      return;
    }
    if (showSessions && (key.escape || raw === "q")) {
      setShowSessions(false);
      return;
    }
    if (approval) {
      if (raw === "y" || raw === "Y") {
        approval.onApprove?.();
        setApproval(null);
        return;
      }
      if (raw === "n" || raw === "N") {
        approval.onDeny?.();
        setApproval(null);
        return;
      }
      if (raw === "a" || raw === "A") {
        approval.onAllowlist?.();
        setApproval(null);
        return;
      }
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
      setShowSlashMenu(true);
      return;
    }
    if (showSlashMenu) {
      if (key.escape) {
        setShowSlashMenu(false);
        return;
      }
      if (key.return) {
        handleSlashCommand(input);
        setInput("");
        setShowSlashMenu(false);
        return;
      }
      if (key.backspace || key.delete) {
        setInput((p) => p.slice(0, -1));
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
    return /* @__PURE__ */ jsx10(SplashScreen, { version: "0.1.0", onDone: () => setShowSplash(false) });
  }
  return /* @__PURE__ */ jsxs11(Box10, { flexDirection: "column", height: rows, width: cols, children: [
    /* @__PURE__ */ jsx10(
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
    /* @__PURE__ */ jsxs11(Box10, { flexDirection: "column", height: outputHeight + 1, width: cols, overflow: "hidden", children: [
      visible.map((line, i) => {
        if (line.type === "user") {
          return /* @__PURE__ */ jsx10(Text11, { color: "green", bold: true, children: "> " + line.text }, i);
        }
        if (line.type === "assistant") {
          return /* @__PURE__ */ jsx10(Text11, { color: "white", children: line.text }, i);
        }
        if (line.type === "thinking") {
          const cls = classifyReasoning(line.text);
          const color = cls ? cls.color : theme.dim;
          return /* @__PURE__ */ jsxs11(Text11, { color, dim: true, children: [
            "  ",
            line.text
          ] }, i);
        }
        if (line.type === "system") {
          return /* @__PURE__ */ jsx10(Text11, { color: "cyan", dim: true, children: "[sys] " + line.text }, i);
        }
        return /* @__PURE__ */ jsx10(Text11, { color: "white", children: line.text }, i);
      }),
      thinking && /* @__PURE__ */ jsxs11(Text11, { color: theme.primary, children: [FRAMES[renderTick % FRAMES.length], " thinking..."] })
    ] }),
    tools.length > 0 && /* @__PURE__ */ jsxs11(Box10, { width: cols, flexDirection: "row", overflow: "hidden", children: [
      /* @__PURE__ */ jsx10(Text11, { color: "gray", dim: true, children: "tools: " }),
      tools.slice(-6).map((t, i) => /* @__PURE__ */ jsxs11(Text11, { color: t.status === "running" ? "yellow" : theme.success, children: [
        t.status === "running" ? "\u25C9" : "\u2713",
        t.name,
        t.duration ? `(${t.duration})` : "",
        " "
      ] }, i))
    ] }),
    showPlan && plan && /* @__PURE__ */ jsx10(PlanDisplay, { plan, cols }),
    /* @__PURE__ */ jsx10(TokenBar, { used: status.tokens, max: contextMax, cols }),
    showDiff && diffData && /* @__PURE__ */ jsx10(DiffPreview, { diff: diffData.text || diffData, cols, onApprove: diffData.onApprove, onDeny: diffData.onDeny }),
    approval && /* @__PURE__ */ jsx10(
      ApprovalPrompt,
      {
        action: approval.action,
        command: approval.command,
        reason: approval.reason || "",
        risk: approval.risk || "medium",
        onApprove: () => {
          approval.onApprove?.();
          setApproval(null);
        },
        onAllowlist: () => {
          approval.onAllowlist?.();
          setApproval(null);
        },
        onDeny: () => {
          approval.onDeny?.();
          setApproval(null);
        }
      }
    ),
    showSessions && /* @__PURE__ */ jsx10(SessionList, { sessions, cols, onSelect: (s) => {
      agent_default.resume?.(s.id);
      setShowSessions(false);
    } }),
    showHelp && /* @__PURE__ */ jsx10(HelpOverlay, { onDismiss: () => setShowHelp(false) }),
    showSlashMenu && /* @__PURE__ */ jsx10(SlashMenu, { input, cols }),
    /* @__PURE__ */ jsxs11(Box10, { width: cols, borderStyle: "single", borderColor: theme.border, paddingX: 1, children: [
      /* @__PURE__ */ jsxs11(Text11, { color: phase === "ACT" ? theme.warning : theme.primary, bold: true, children: [
        phase === "ACT" ? "\u25C6" : ">",
        " "
      ] }),
      /* @__PURE__ */ jsx10(Text11, { color: "white", children: input }),
      /* @__PURE__ */ jsx10(Text11, { color: "gray", dim: true, children: showSlashMenu ? "" : "  (/help, Tab for commands, Ctrl+C to exit)" })
    ] })
  ] });
}

// src/index.jsx
import { jsx as jsx11 } from "react/jsx-runtime";
var rendered = false;
function start() {
  if (rendered) return;
  rendered = true;
  render(/* @__PURE__ */ jsx11(App, {}));
}
export {
  start
};
