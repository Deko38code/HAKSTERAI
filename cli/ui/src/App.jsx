import React, { useCallback, useEffect, useRef, useState } from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { useKeyboard, useRenderer, useTerminalDimensions } from '@opentui/react';
import { TextAttributes } from '@opentui/core';
import AdRailSlot from './components/DockAd.jsx';
import ApprovalPrompt from './components/ApprovalPrompt.jsx';
import DangerPasswordPrompt from './components/DangerPasswordPrompt.jsx';
import { clearDangerPassword, dangerPasswordState, setDangerPassword } from './utils/danger-password.js';
import Composer from './components/Composer.jsx';
import GridLayout from './components/GridLayout.jsx';
import GridPanel, { Cell, Meter, Spark } from './components/GridPanel.jsx';
import LiveSidebar from './components/LiveSidebar.jsx';
import LiveOutputPanel from './components/LiveOutputPanel.jsx';
import UsageView from './components/UsageView.jsx';
import { useServerUsage } from './hooks/useServerUsage.js';
import { findImageSource } from '../../src/live-image.js';
import MonitorFeed from './components/MonitorFeed.jsx';
import DecodeSplash from './components/DecodeSplash.jsx';
import { MENU_ITEMS } from './components/MenuPalette.jsx';
import CatalogPopout from './components/CatalogPopout.jsx';
import SettingsView, { showValue } from './components/SettingsView.jsx';
import McpView from './components/McpView.jsx';
import ScrollPanel from './components/ScrollPanel.jsx';
import ScriptsView from './components/ScriptsView.jsx';
import SquadView from './components/SquadView.jsx';
import ServicesPanel, { servicesGridRows } from './components/ServicesPanel.jsx';
import StatusServicesPanel, { statusServicesRows } from './components/StatusServicesPanel.jsx';
import StatusBar from './components/StatusBar.jsx';
import SystemPanel from './components/SystemPanel.jsx';
import CrushStatus from './components/CrushStatus.jsx';
import Recap from './components/Recap.jsx';
import DebugView from './components/DebugView.jsx';
import TodoPanel from './components/TodoPanel.jsx';
import Transcript from './components/Transcript.jsx';
import { composerRows as composerHeight } from './utils/wrap.js';
import useAgentStream from './hooks/useAgentStream.js';
import useServerWatch from './hooks/useServerWatch.js';
import useHostStats from './hooks/useHostStats.js';
import useDebugStats from './hooks/useDebugStats.js';
import { noteRenderStart, noteRenderEnd } from './utils/debug-metrics.js';
import useMemoryBank from './hooks/useMemoryBank.js';
import useCliUpdate from './hooks/useCliUpdate.js';
import useScriptRunner from './hooks/useScriptRunner.js';
import { peersFromMcp } from './utils/squad.js';
import { countWebCallsInMessages } from './utils/web-usage.js';
import { richBar } from './utils/bar.js';
import cliPrefs from '../../src/prefs.js';
import { appendInputHistory, loadInputHistory } from '../../src/input-history.js';
import { barColor, fileGuard, otherListening, scanPorts, serviceStates, smartLabel, meterArrow as arrowFor, arrowColor as arrowFg } from '../../smartness.mjs';
import { MODEL_LADDER, PRIMARY_MODEL, PRIMARY_PROVIDER, displayModel } from '../../src/models/ladder.js';
import catalog from '../../src/models/catalog.js';
import { isSupported as kittyGraphicsSupported } from '../../src/kitty-graphics.js';
import ads from '../../src/ads/ad-client.js';

const API = process.env.HAKSTER_API_URL || 'http://localhost:3579';
const MCP_OUTPUT_LINES = 6;
// How long a finished sub-agent's output stays in the MCP Output box before the
// box clears itself (owner, 2026-11-24: "clear after sub agents output stops then
// clear panel for your workspace"). Long enough to read the last lines, short
// enough that the workspace gets its rows back without a keypress.
const MCP_PANEL_SETTLE_MS = 8000;
// The dashboard and models pages are native OpenTUI scroll boxes: the same ▲ /
// █ / ▼ bar the transcript uses, clickable with the mouse, auto-hidden when the
// page fits (owner's 2026-11-23 all-panels rule).
const PAGE_SCROLLBAR = {
  width: 1,
  showArrows: true,
  arrowOptions: {
    foregroundColor: '#9ca3af',
    arrowChars: { up: '▲', down: '▼' },
  },
  trackOptions: {
    backgroundColor: '#374151',
    foregroundColor: '#22d3ee',
  },
};
const SYSTEM = process.env.HAKSTER_TUI_SYSTEM
  || 'You are haksterAi running inside a terminal dashboard. Answer briefly and use tools when they are needed.';

/* Image attachments.
 *
 * The server's /api/agent/run already accepts OpenAI-style content parts, and
 * pre-processes an `image_url` block for models without vision — so the TUI
 * only has to read the file and hand over a data URL. Nothing is uploaded
 * anywhere else, and nothing is written back to disk.
 */
const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
};
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

/* The three amounts of autonomy /api/agent/run understands (server's
 * agent/approval.js). Stored in cli-prefs as `autoMode`. */
const AUTO_MODES = new Set(['suggest', 'auto-edit', 'full-auto']);
// The dial's order — safe → autonomous, so no keystroke jumps straight from
// asking to running unattended. Shift+Tab walks it and `/auto` names it.
const AUTO_ORDER = ['suggest', 'auto-edit', 'full-auto'];
// One sentence per amount, so the dial and `/auto` can never describe the same
// mode two different ways.
const autoNotice = (mode) => (
  mode === 'full-auto'
    ? 'auto FULL — the agent runs and finishes without asking (sudo still confirms)'
    : mode === 'auto-edit'
      ? 'auto EDIT — it works and finishes on its own; a dangerous shell command still asks'
      : 'auto ASK — every command that changes the box waits for you'
);

/* The auto-handoff switch is the owner's, and it stays where he left it.
 * One small file under ~/.hakster, read at start and rewritten on change; a
 * missing or unreadable file simply means "on" (the default order). */
// The CLI's own settings (owner 2026-11-23: "make sure our cli has its own
// setting prewfrence"): ~/.hakster/cli-prefs.json, written only by this CLI,
// with the older tui-prefs.json read as a fallback by prefs.load().
function readPrefs() {
  try {
    return cliPrefs.load();
  } catch {
    return {};
  }
}
function writePrefs(patch) {
  try {
    return cliPrefs.save(patch);
  } catch {
    return null;
  }
}

/* The crush CLI's own model config, read only. The owner asked for "1 big
 * catalog with all agents deepseek crush catalog combined", so the popout lists
 * the models crush is configured with next to ours. Read at start; a missing or
 * invalid file simply means no crush section — nothing is written back. */
const CRUSH_CONFIG_PATHS = [
  path.join(process.env.HOME || '/home/ghost', '.crush.json'),
  path.join(process.env.HOME || '/home/ghost', '.config', 'crush', 'crush.json'),
];
function readCrushModels() {
  for (const p of CRUSH_CONFIG_PATHS) {
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      const out = [];
      for (const [slot, m] of Object.entries(j.models || {})) {
        if (m && m.model) out.push({ slot, model: m.model, provider: m.provider || 'ollama' });
      }
      if (out.length) return out;
    } catch {
      /* no crush config here — keep looking */
    }
  }
  return [];
}

const clipLine = (s, n) => {
  const t = String(s == null ? '' : s);
  return t.length <= n ? t : `${t.slice(0, Math.max(0, n - 1))}…`;
};

/** The short argument a tool call is remembered by (the command, path, …). */
const toolArgLine = (args) => {
  if (!args || typeof args !== 'object') return '';
  const raw = args.command || args.path || args.file || args.query || args.url || args.pattern || '';
  const s = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  return s ? ` ${s}` : '';
};

function readImageAttachment(file) {
  const raw = String(file || '').trim();
  if (!raw) throw new Error('no file given');
  const abs = path.resolve(raw.replace(/^~(?=\/)/, process.env.HOME || ''));
  const mime = IMAGE_MIME[path.extname(abs).toLowerCase()];
  if (!mime) throw new Error('not an image (png, jpg, webp, gif, bmp)');
  const st = fs.statSync(abs);
  if (!st.isFile()) throw new Error('not a file');
  if (st.size > MAX_IMAGE_BYTES) {
    throw new Error(`too large (${Math.round(st.size / 1024 / 1024)}MB, max 12MB)`);
  }
  const buf = fs.readFileSync(abs);
  return {
    path: abs,
    name: path.basename(abs),
    bytes: buf.length,
    dataUrl: `data:${mime};base64,${buf.toString('base64')}`,
  };
}

/* The harness TUI.
 *
 * Layout is the Freebuff shape — a header, a body, and a status bar pinned to
 * the foot — but every value comes from this harness's own server, and the ad
 * slots are served by the local ad service in server/src/ads.js.
 *
 * Two ideas hold this file together:
 *
 * 1. Focus decides what a plain letter means. While the composer holds focus
 *    every printable key belongs to the input, and the `a`/`d`/`m`/`q` shortcuts
 *    are reachable only once focus moves away (Tab). The alternative — global
 *    single-letter shortcuts that also let you type — is not implementable, and
 *    a shortcut that steals a keystroke mid-sentence is worse than no shortcut.
 *
 * 2. Row budget is computed, not guessed. The renderer fills a full-screen tree,
 *    so a panel that grows by one row does not scroll the transcript, it pushes
 *    the status bar off the bottom. Each chrome element's height is derived
 *    below and the transcript receives exactly what is left.
 */
export default function App({ version = '0.1.0' }) {
  // Debugger timing (owner, 2026-11-24: "add debugger to"). The timestamp is
  // the first statement in the component so the measured span is the render
  // itself, and the layout effect below closes it at commit — that pair is the
  // RENDER block on the /debug page. Nothing else reads it.
  const renderT0 = noteRenderStart();
  const renderer = useRenderer();
  const { width: cols, height: rows } = useTerminalDimensions();
  // Sample on every render, not on a timer: a slow frame is exactly what the
  // debugger exists to catch, and one measurement is two numbers in a buffer.
  React.useLayoutEffect(() => { noteRenderEnd(renderT0); });

  const [view, setView] = useState('chat'); // chat | dashboard | models | monitor
  const [focus, setFocus] = useState('composer'); // composer | ad
  const [adsOn, setAdsOn] = useState(() => readPrefs().ads !== false);
  const [dockExpanded, setDockExpanded] = useState(false);
  const [draft, setDraft] = useState('');
  // Input recall (owner, 2026-11-24: "fix my history in input for my previous
  // typed commands chats etc"): the typed lines from ~/.hakster/history, read
  // oldest→newest and walked with ↑/↓ while the composer holds focus.
  // `histIdx` is -1 while composing new text; otherwise it points at the entry
  // on screen. `draftStash` keeps what you were writing before ↑ walked back,
  // so ↓ past the newest entry restores it instead of losing it.
  const [inputHistory, setInputHistory] = useState(() => loadInputHistory());
  const [histIdx, setHistIdx] = useState(-1);
  const draftStash = useRef('');
  // Start on the owner's cheap DeepSeek config; a GLM env tag is the old
  // default and falls through (§22 — the pinned HAKSTERAI-FLASH config;
  // the wire model and relay are unchanged, only the display name moved).
  const [model, setModel] = useState(() => (process.env.HAKSTER_MODEL && !/^glm/i.test(process.env.HAKSTER_MODEL) ? process.env.HAKSTER_MODEL : readPrefs().model || PRIMARY_MODEL));
  // No provider pin by default: the ladder's tier 1 answers (CLAUDE.md §22 —
  // the pinned HAKSTERAI-FLASH config; the wire model and relay are unchanged,
  // only the display name moved). The 2026-11-25 speed commit pinned
  // PRIMARY_PROVIDER here to skip the claude-cli spawn cost, but that lane
  // breaks tool calling on this box (owner, 2026-11-25: "model skipped tool
  // calling ... fix back"): driven through the server loop, a turn that calls a
  // tool comes back with empty content after the tool result and the model
  // re-issues the identical call until the duplicate-call loop guard stops the
  // run — measured on ollama/deepseek-v4.1-flash:cloud, 3x list_dir, then
  // loop_detected, where claude-cli makes one tool call and answers. So tier 1
  // (claude-cli) answers again and the ladder behind it is unchanged. An
  // explicit HAKSTER_PROVIDER, a saved /provider pick or a model picked in
  // /model still wins.
  const [provider, setProvider] = useState(() => process.env.HAKSTER_PROVIDER || readPrefs().provider || '');
  const [modelIdx, setModelIdx] = useState(0);
  // Auto handoff: HAKSTERAI-FLASH → Codex → server waterfall. On unless the
  // owner turned it off; the choice is remembered between sessions.
  const prefsRef = useRef(null);
  if (!prefsRef.current) prefsRef.current = readPrefs();
  const [handoffOn, setHandoffOn] = useState(() => prefsRef.current.autoHandoff !== false);
  // How much the agent may do without asking. 'auto-edit' is the Claude-CLI
  // default the owner asked for ("running like u do in claude cli ... finishing
  // job til the end"): edits, reads and safe commands run themselves, a
  // dangerous shell command still waits for a yes. 'full-auto' never asks;
  // 'suggest' asks before anything that changes the box. Remembered.
  const [autoMode, setAutoMode] = useState(() => {
    const saved = String(prefsRef.current.autoMode || '');
    return AUTO_MODES.has(saved) ? saved : 'auto-edit';
  });
  // Reasoning fold (owner, 2026-11-24: "i want the win", after OMP's thinking
  // blocks). A finished thought draws as one "Thought for 12s" line; Ctrl+T
  // reopens every thought in the transcript. Remembered between sessions.
  const [expandThinking, setExpandThinking] = useState(() => prefsRef.current.thinkingExpanded === true);
  // The usage page's own poll rate (owner, 2026-11-23: "live graphs refresh
  // rate"). Seconds; 0 pauses. It is a CLI preference, saved on this machine.
  const [usageRefresh, setUsageRefresh] = useState(() => {
    const n = Number(prefsRef.current.usageRefresh);
    return Number.isFinite(n) && n >= 0 ? n : 15;
  });
  // Start screen: five lines decode together, then the dashboard. Remembered
  // in cli-prefs (`/settings intro off` skips it). HAKSTER_NO_INTRO=1 skips it
  // for one process — the render smoke test sets it, so its frames are the
  // app's and not the splash's.
  const [introDone, setIntroDone] = useState(() => process.env.HAKSTER_NO_INTRO === '1' || readPrefs().intro === false);

  const [status, setStatus] = useState(null);
  const [statusErr, setStatusErr] = useState(null);
  const [mcp, setMcp] = useState(null);
  const [history, setHistory] = useState([]);
  // `/menu` popout (HakTerm's command palette, in the terminal). Closed on
  // start — never auto-opens; esc closes it without running anything.
  const [menuOpen, setMenuOpen] = useState(false);
  // `/danger set` — the masked entry for the approval password dangerous
  // commands ask for. Closed until asked for; it owns the keyboard while open.
  const [dangerSetup, setDangerSetup] = useState(false);
  // The Lab views: our live scripts (with the OMP snapshot compare window) and
  // the sub-agent squad. Both are read from real state — the checkout and the
  // server's own /api/agent/mcp-status.
  const [scriptIdx, setScriptIdx] = useState(0);
  const [squadIdx, setSquadIdx] = useState(0);
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuQuery, setMenuQuery] = useState('');
  // The two full pages the /menu catalog opens: all of the CLI's own settings
  // (Claude CLI's `/config`) and the MCP server manager (`/mcp`). Owner,
  // 2026-11-24: "fix our popout /menu for all our cli settings mcps etc".
  const [settingsIdx, setSettingsIdx] = useState(0);
  const [mcpIdx, setMcpIdx] = useState(0);
  // A settings change is written to cli-prefs.json; this tick forces the page
  // and the catalog to re-read it, so a flipped switch shows its new value
  // immediately instead of on the next launch.
  const [prefsTick, setPrefsTick] = useState(0);
  const [notice, setNotice] = useState(null);
  // Services on ports — the old CLI's ONLINE PORTS panel, scanned read-only
  // and refreshed every 30 s. It starts empty rather than guessing.
  const [scan, setScan] = useState({ ok: false, ports: [], procs: {}, at: 0 });
  // The 13 code files the agent counts; rechecked every 10 s so a file the
  // agent loses (or restores) shows up immediately.
  const [guard, setGuard] = useState(null);
  const [pointsHistory, setPointsHistory] = useState([]);
  // One image waiting to ride on the next message (`/attach <path>`).
  const [attachment, setAttachment] = useState(null);
  // Steer queue (owner, 2026-11-24: "i can type while agent is working need
  // steer que"). A message typed while a run is streaming joins this queue and
  // is sent as the next turn the moment the current one ends — in order, one at
  // a time. The running turn is never restarted and nothing typed is dropped.
  const [steerQueue, setSteerQueue] = useState([]);
  const scrollRef = useRef(null);
  // The dashboard and models views are scroll boxes too: a short terminal must
  // scroll the page, not push the status bar off the bottom (§ owner's
  // 2026-11-23 panel rule).
  const dashRef = useRef(null);
  // The usage page is a scroll box for the same reason: on a short terminal
  // every measured row stays reachable and the bar tracks the page instead of
  // the bottom of the list being clipped (§ all-panels rule).
  const usageRef = useRef(null);
  // The debugger page scrolls like the dashboard and usage pages (§ all-panels).
  const debugRef = useRef(null);

  const agent = useAgentStream({
    // A steer the run could not deliver comes back here and joins the same
    // queue an undelivered POST uses, so it sends with the next run.
    onSteerUndelivered: (items) => {
      setSteerQueue((q) => [
        ...q,
        ...items.map((text, i) => ({ id: `steer-ud-${Date.now()}-${i}`, text, image: '', imageName: '' })),
      ]);
    },
    api: API,
    model,
    provider,
    system: SYSTEM,
    cwd: process.env.HAKSTER_AGENT_CWD || null,
    autoHandoff: handoffOn,
    // Autonomy: the server turns this into its autonomous directive + the
    // "you replied with text only, act" nudge, so a run drives to the end.
    approvalMode: autoMode === 'suggest' ? undefined : autoMode,
  });

  // Per-user usage, only fetched while the page is open (see the hook).
  const usagePage = useServerUsage(usageRefresh, view === 'usage');
  // ◇ Debugger: sampled only while its page is open, so a closed page costs
  // nothing — no lag timer, no poll, no render.
  const debugStats = useDebugStats({ enabled: view === 'debug', api: API });

  useEffect(() => {
    writePrefs({ autoHandoff: handoffOn });
  }, [handoffOn]);

  useEffect(() => {
    writePrefs({ autoMode });
  }, [autoMode]);

  // ── Machine status: unchanged contract with the server's /api/tui/status ──
  const load = useCallback(async () => {
    try {
      const r = await fetch(`${API}/api/tui/status`, { signal: AbortSignal.timeout(4000), headers: { ...(process.env.HAKSTER_API_KEY ? { 'x-api-key': process.env.HAKSTER_API_KEY } : {}) } });
      if (!r.ok) throw new Error(`status ${r.status}`);
      const j = await r.json();
      setStatus(j);
      setStatusErr(null);
      setHistory((h) => [...h.slice(-59), Number(j.tokens || j.messages || 0)]);
    } catch (e) {
      setStatusErr(e.message);
    }
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [load]);

  // MCP inventory: the same /api/agent/mcp-status the browser HakTerm lists.
  // Read-only, every 30s; a failed read keeps the last good panel. The tick is
  // kept on a ref so the MCP page's `r` can ask for a fresh read immediately.
  const mcpRefreshRef = useRef(null);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch(`${API}/api/agent/mcp-status`, {
          signal: AbortSignal.timeout(5000),
          headers: { ...(process.env.HAKSTER_API_KEY ? { 'x-api-key': process.env.HAKSTER_API_KEY } : {}) },
        });
        if (!r.ok) return;
        const j = await r.json();
        if (alive && j && Array.isArray(j.servers)) setMcp(j);
      } catch { /* keep the previous reading */ }
    };
    mcpRefreshRef.current = tick;
    tick();
    const t = setInterval(tick, 30000);
    return () => { alive = false; mcpRefreshRef.current = null; clearInterval(t); };
  }, []);

  // Services/ports: one bounded `ss -tlnp` on boot and every 30 s. Read-only.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const next = await scanPorts();
      if (alive) setScan(next);
    };
    tick();
    const t = setInterval(tick, 30000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  // File guards: the same 13 entries the agent's integrity check counts.
  useEffect(() => {
    const tick = () => {
      try { setGuard(fileGuard()); } catch { /* leave the last reading */ }
    };
    tick();
    const t = setInterval(tick, 10000);
    return () => clearInterval(t);
  }, []);

  // The autolearn sparkline is the session's point total over time — one
  // sample whenever a tool result actually moves the meter.
  const meterPoints = Number(agent.meters && agent.meters.points) || 0;
  useEffect(() => {
    setPointsHistory((h) => [...h.slice(-59), meterPoints]);
  }, [meterPoints]);

  const models = catalog.REFERENCE_CATALOG || [];
  // The ladder sits at the top of the picker. Tier 1 is not a lookalike of the
  // owner's Claude CLI config — it is that config: the same wire model and the
  // same provider, stated literally (§22). Tier 2 is Codex on the Pro plan.
  // Everything below is the reference catalogue, unchanged.
  const pickerModels = [
    { key: '__claude', vendor: 'Claude', value: `Claude Code · ${displayModel(PRIMARY_MODEL)}`, model: PRIMARY_MODEL, provider: 'claude-cli' },
    { key: '__deepseek', vendor: 'DeepSeek', value: `DeepSeek relay · ${displayModel(PRIMARY_MODEL)}`, model: PRIMARY_MODEL, provider: PRIMARY_PROVIDER },
    { key: '__codex', vendor: 'Codex', value: 'Codex (Pro) · provider default', model: '', provider: 'codex-cli' },
    ...models.map((m) => ({ key: `c:${m.id}`, vendor: m.vendor, value: m.id, model: m.id, provider: PRIMARY_PROVIDER })),
  ];
  const pickerIndexFor = (m, p) => {
    const i = pickerModels.findIndex((x) => x.model === (m || '') && x.provider === (p || ''));
    return i < 0 ? 0 : i;
  };
  // What the header and the status bar call the current model. Codex is picked
  // by provider (no model string is invented for it), so it needs its own name.
  const modelText = model ? displayModel(model) : (provider === 'codex-cli' ? 'Codex (Pro)' : provider || 'auto');
  // The window the reading is measured against: what the answering lane said it
  // compacts at (the claude-cli lane reports 200000), else the model catalog's.
  // Reporting only — no model, route or config is read or changed (§22).
  const ctxMax = Number(agent.contextWindow) > 0
    ? Number(agent.contextWindow)
    : (catalog.contextMaxFor(model || PRIMARY_MODEL) || 1);
  // Prefer the measured conversation size (the last call's prompt, from the
  // stream — see useAgentStream), then whatever the TUI status reports.
  const ctxUsed = Number(agent.contextUsed || (status && (status.tokens || status.contextUsed)) || 0);
  const meters = agent.meters || null;
  // The run's live output for the sidebar: the newest tool call and the tail of
  // whatever it produced (or the answer being streamed). Derived from the same
  // messages the transcript renders, so the two can never disagree.
  const lastAssistant = React.useMemo(() => {
    for (let i = agent.messages.length - 1; i >= 0; i--) {
      if (agent.messages[i].role === 'assistant') return agent.messages[i];
    }
    return null;
  }, [agent.messages]);
  const lastTool = lastAssistant && Array.isArray(lastAssistant.tools) && lastAssistant.tools.length
    ? lastAssistant.tools[lastAssistant.tools.length - 1]
    : null;
  const liveToolTxt = lastTool ? `${lastTool.name}${toolArgLine(lastTool.args)}` : '';
  // Which half of the run the panel is showing, so the box can say it: the
  // operator reads "thinking" and knows the model is working even when no
  // words have arrived yet (a slow first token looked like a dead panel).
  const livePhase = !agent.busy
    ? 'result'
    : (lastAssistant && String(lastAssistant.text || '').trim())
      ? 'writing'
      : (lastAssistant && String(lastAssistant.thinking || '').trim())
        ? 'thinking'
        : (lastTool && lastTool.result == null)
          ? 'running'
          : 'waiting';
  // Re-splitting the newest answer or shell result is only needed when that
  // value actually changed — the timers that re-render App (elapsed clock,
  // host stats, memory bank, status poll) must not pay for it on every tick
  // (owner, 2026-11-24: "bash tools making cli lagg").
  const liveLines = React.useMemo(() => {
    if (!lastAssistant) return [];
    const toLines = (v) => String(v == null ? '' : v).replace(/\r/g, '').split('\n').filter((l) => l.trim());
    const text = toLines(lastAssistant.text);
    const result = lastTool && lastTool.result != null ? toLines(lastTool.result) : [];
    // Two boxes, two jobs (owner, 2026-11-24: "its suppose to have agents
    // reasoning output thinking etc and final word in results … shouldnt say
    // same in both grids"). The reasoning streams into the thinking area above,
    // so this box carries the ANSWER and nothing else — while it is being
    // written, and when the run ends. Reasoning is never copied down here; only
    // a turn that ends with no prose at all falls back to the newest tool
    // result, so the box is never blank after work was done.
    return text.length ? text : result;
  }, [lastAssistant, lastTool]);
  // The picture behind live-URL work (owner, 2026-11-23: "live image viewer in
  // the output panels when showing live url work"): a screenshot path, an image
  // URL or an inline data: image in what the last tool returned. The panels show
  // it; this only finds it. This scans the whole result string with regexes, so
  // it runs only when that result changed.
  const liveImage = React.useMemo(() => (lastAssistant
    ? findImageSource([lastTool && lastTool.result != null ? String(lastTool.result) : '', String(lastAssistant.text || '')])
    : null), [lastAssistant, lastTool]);
  // This machine's own vitals — cpu, ram, swap, disk, load — sampled in-process.
  // One tick a second, smoothed and change-gated in the hook (owner, 2026-11-25:
  // "make sure the cpu ram meters run smoothly in cli with nice refresh rate but
  // not make lagg"), so the meters glide without re-rendering on idle ticks.
  const host = useHostStats(1000);
  // ◈ Memory: the same banks autolearn writes and the next run recalls,
  // counted from disk every 10 s (see useMemoryBank — counts only, no text).
  const memory = useMemoryBank(10000);
  // ⬆ Update: the Claude Code model — check in the background while this
  // session runs, download and verify a newer CLI into ~/.hakster/updates and
  // let the next launch apply it. The session itself is never restarted.
  const update = useCliUpdate(undefined, version);
  // ⌘ Live scripts: discovered from this checkout, run one at a time, bounded.
  const runner = useScriptRunner();
  // ◔ Usage, counted from the session itself: tool calls actually streamed,
  // the meter's scored wins and losses, requests sent (handoffs included),
  // operator turns, the turn-reported token totals and the context share. No
  // figure here is estimated; each is a count of something that happened.
  // Counted once per message-list change, not once per timer tick: each of
  // these walks every turn and every call it made.
  const { userTurns, toolCalls, webCalls } = React.useMemo(() => {
    const msgs = agent.messages;
    let turns = 0;
    let calls = 0;
    for (const m of msgs) {
      if (m.role === 'user') turns += 1;
      if (Array.isArray(m.tools)) calls += m.tools.length;
    }
    // Web calls are a subset of `tools`: the search/fetch/scrape calls this
    // session actually made (owner, 2026-11-24: "add web tool usage in the usage
    // panel … just for our count"). Counted from the same streamed call events,
    // so it moves live with the run — a count of calls, never an estimate.
    return { userTurns: turns, toolCalls: calls, webCalls: countWebCallsInMessages(msgs) };
  }, [agent.messages]);
  const usage = {
    tools: toolCalls,
    web: webCalls,
    ok: Number(meters && meters.successes) || 0,
    fail: Number(meters && meters.failures) || 0,
    requests: Number(agent.requests) || 0,
    turns: userTurns,
    inTok: agent.tokens ? agent.tokens.in : 0,
    outTok: agent.tokens ? agent.tokens.out : 0,
    // The agent stream's `done` event only carries token counts when the
    // answering path reports them (the claude-cli path does; the plain provider
    // loop does not). Until one does, the panel says "—" rather than a zero it
    // cannot stand behind (§10).
    tokensKnown: !!(agent.tokens && agent.tokens.reported),
    ctxPct: ctxUsed > 0 && ctxMax > 0 ? Math.max(0, Math.min(100, Math.round((ctxUsed / ctxMax) * 100))) : null,
  };
  const peers = peersFromMcp(mcp);
  const services = serviceStates(scan);
  const otherPorts = otherListening(scan);

  const showNotice = useCallback((text) => {
    setNotice(text);
    setTimeout(() => setNotice((cur) => (cur === text ? null : cur)), 6000);
  }, []);

  /* A server restart is now named by its cause (owner, 2026-11-24: "if server
   * drops after updates"). The panels already recover on their own — the
   * status poll re-reads every 3 s and a turn in flight reconnects and resends
   * — but an update landing on the server looked identical to a crash. The
   * build stamp tells them apart: a changed `server.build` is the update we
   * just shipped, an unchanged one is a restart of the same code. A restart
   * during a run is left to the turn's own reconnect lines, so this only
   * speaks while the session is idle.
   */
  useServerWatch({
    api: API,
    busy: agent.busy,
    onRecovered: ({ text, updated }) => {
      showNotice(text);
      // Toast for the moment, transcript line for the record. `notice` when a
      // build landed (expected, good), `warn` when the same code came back
      // (something restarted it, and that is worth looking at).
      agent.note(text, updated ? 'notice' : 'warn');
    },
  });

  // ⬆ Install confirmation (owner, 2026-11-24: "need our updates to show when
  // updates have been installed upon starting cli"). When an earlier start
  // swapped in a newer package, say so once per launch — the stderr line from
  // tui-entry is lost the moment the TUI takes the alternate screen, so this is
  // the one place the operator actually sees it.
  const installedAnnounced = useRef(false);
  useEffect(() => {
    if (installedAnnounced.current) return;
    if (!update || !update.applied || !update.applied.version) return;
    installedAnnounced.current = true;
    // Same version, newer build is possible (the package hash decides when the
    // version is equal), so say that instead of "was v0.3.6 (was v0.3.6)".
    const from =
      update.applied.from && update.applied.from !== update.applied.version
        ? ` (was v${update.applied.from})`
        : ' (newer build, same version)';
    showNotice(`✓ CLI updated to v${update.applied.version}${from} — installed on this start`);
  }, [update, showNotice]);

  // ⬆ Update announcement: say it once per staged version. The swap happens at
  // the next launch (src/updater.js applies a verified stage before the bundle
  // loads); a source checkout is only ever told, never written into (§8).
  const updateAnnounced = useRef('');
  useEffect(() => {
    // A build that is already installed is not a pending update — the install
    // notice above covers it, and announcing "staged" would contradict it.
    if (update && update.applied) return;
    if (!update || !update.version) return;
    // Already on disk, this session is the older build: say it once, so the
    // badge on the top line is not the only place it appears.
    if (update.status === 'installed') {
      const key = `installed:${update.version}`;
      if (updateAnnounced.current === key) return;
      updateAnnounced.current = key;
      showNotice('✔ Update installed · Restart to update');
      return;
    }
    if (update.status !== 'staged' && update.status !== 'blocked') return;
    const key = `${update.status}:${update.version}`;
    if (updateAnnounced.current === key) return;
    updateAnnounced.current = key;
    showNotice(
      update.status === 'blocked'
        ? `⬆ CLI v${update.version} staged — this is a source checkout; nothing was written, pull/install when ready`
        : `⬆ CLI v${update.version} staged — applies when the CLI restarts`,
    );
  }, [update, showNotice]);

  // ── Settings: one list for the settings page and the /menu SETTINGS section.
  // Read from the same cli-prefs.json the rest of the CLI uses; `prefsTick`
  // re-reads it after every change so the displayed value is never stale.
  const settingsRows = React.useMemo(() => {
    void prefsTick;
    let rows = [];
    try { rows = cliPrefs.list(); } catch { rows = []; }
    // The live values the running view already honours win over the file read,
    // so a toggle shows its new state in the same frame it is flipped.
    return rows.map((r) => {
      if (r.key === 'ads') return { ...r, value: adsOn };
      if (r.key === 'autoHandoff') return { ...r, value: handoffOn };
      if (r.key === 'usageRefresh') return { ...r, value: usageRefresh };
      if (r.key === 'graphics') return { ...r, value: prefsRef.current.graphics !== false };
      return r;
    });
  }, [prefsTick, adsOn, handoffOn, usageRefresh]);

  // Write one setting and apply it to the running view where the view can honour
  // it now; the rest say "next launch" in the notice. Never touches another
  // project and never a secret (§16, §23) — every key here is the CLI's own.
  const applySetting = useCallback((key, value) => {
    writePrefs({ [key]: value });
    prefsRef.current = { ...prefsRef.current, [key]: value };
    if (key === 'ads') setAdsOn(!!value);
    else if (key === 'autoHandoff') setHandoffOn(!!value);
    else if (key === 'model') { setModel(String(value) || ''); setProvider(PRIMARY_PROVIDER); }
    else if (key === 'provider') setProvider(String(value) || PRIMARY_PROVIDER);
    else if (key === 'usageRefresh') setUsageRefresh(Number(value) || 0);
    setPrefsTick((t) => t + 1);
    const shown = typeof value === 'boolean' ? (value ? 'on' : 'off') : value === '' ? '(default)' : value;
    showNotice(`⚙ ${key} → ${shown}${key === 'opaqueBackdrop' || key === 'intro' ? ' — applies on the next launch' : ''}`);
  }, [showNotice]);

  // Enter on a settings row. A switch flips; a number steps through sensible
  // values; `model` opens the picker; any other text explains how to set it.
  const changeSetting = useCallback((key) => {
    const row = settingsRows.find((r) => r.key === key);
    if (!row) return;
    if (typeof row.value === 'boolean') { applySetting(key, !row.value); return; }
    if (typeof row.value === 'number') {
      const steps = [0, 5, 15, 30, 60, 120];
      const next = steps.find((s) => s > Number(row.value));
      applySetting(key, next == null ? steps[0] : next);
      return;
    }
    if (key === 'model') { setView('models'); return; }
    showNotice(`⚙ ${key} is text — set it with /settings ${key} <value>`);
  }, [settingsRows, applySetting, showNotice]);

  // Slash commands from the composer — the terminal counterpart of HakTerm's
  // palette actions. Unknown commands say so instead of being sent to the
  // model, so a typo never becomes a prompt.
  const runCommand = useCallback((raw) => {
    const parts = String(raw || '').trim().split(/\s+/);
    const cmd = (parts[0] || '').toLowerCase();
    const arg = parts.slice(1).join(' ');
    switch (cmd) {
      case '/menu':
        setMenuIndex(0);
        setMenuQuery('');
        setMenuOpen(true);
        return;
      case '/attach':
      case '/image': {
        if (!arg || arg === 'clear' || arg === 'off') {
          setAttachment(null);
          showNotice('image attachment cleared');
          return;
        }
        try {
          const next = readImageAttachment(arg);
          setAttachment(next);
          showNotice(`⊸ ${next.name} · ${Math.round(next.bytes / 1024)}K — enter sends it with your message`);
        } catch (e) {
          showNotice(`attach failed: ${(e && e.message) || 'could not read the file'}`);
        }
        return;
      }
      case '/model':
        if (arg) {
          setModel(arg);
          // A typed model always runs on the pinned provider — otherwise a
          // leftover Codex pick would be sent with a different model id.
          setProvider(PRIMARY_PROVIDER);
          showNotice(`model → ${arg} · provider ${PRIMARY_PROVIDER}`);
        }
        else {
          setModelIdx(pickerIndexFor(model, provider));
          setView('models');
        }
        return;
      case '/mcp': {
        const list = mcp && Array.isArray(mcp.servers) ? mcp.servers : [];
        if (!list.length) { showNotice('MCP — no server list yet (server unreachable?)'); return; }
        if (arg) {
          const at = list.findIndex((x) => String(x.name) === String(arg));
          setMcpIdx(at > 0 ? at : 0);
        } else {
          setMcpIdx(0);
        }
        setView('mcp');
        return;
      }
      case '/handoff': {
        const want = arg === 'on' ? true : arg === 'off' ? false : !handoffOn;
        setHandoffOn(want);
        showNotice(
          want
            ? `auto handoff ON — ${MODEL_LADDER.map((e) => e.label).join(' → ')} (a failed run moves on)`
            : 'auto handoff OFF — a run that fails stays on the model it started on',
        );
        return;
      }
      case '/auto': {
        // How much the agent does on its own. The cycle a bare `/auto` walks is
        // the safe → autonomous order: ask, edit, full — never a jump to
        // full-auto without saying so.
        const want = String(arg || '').trim().toLowerCase();
        const next = want === 'on' ? 'auto-edit'
          : want === 'off' || want === 'ask' ? 'suggest'
          : want === 'full' ? 'full-auto'
          : AUTO_MODES.has(want) ? want
          : autoMode === 'suggest' ? 'auto-edit' : autoMode === 'auto-edit' ? 'full-auto' : 'suggest';
        setAutoMode(next);
        showNotice(autoNotice(next));
        return;
      }
      case '/ports': {
        const up = services.filter((s) => s.up).length;
        setView('dashboard');
        showNotice(
          `services ${up}/${services.length} online · ${otherPorts.length} other listening`
          + `${otherPorts.length ? ` · ${otherPorts.slice(0, 10).map((p) => `:${p.port}`).join(' ')}${otherPorts.length > 10 ? ' …' : ''}` : ''}`
          + `${scan.ok ? '' : ' · scan unavailable'}`,
        );
        return;
      }
      case '/dashboard':
        setView('dashboard');
        return;
      case '/monitor':
        setView('monitor');
        return;
      case '/usage':
        setView('usage');
        return;
      case '/scripts':
        setView('scripts');
        return;
      case '/squad':
        setView('squad');
        return;
      case '/debug':
        setView('debug');
        return;
      case '/status':
        showNotice(status
          ? `phase ${status.phase} · model ${displayModel(status.model)} · tokens ${status.tokens} · trust ${status.trust} · ${status.connected ? 'connected' : 'offline'}`
          : `server ${statusErr || 'connecting…'}`);
        return;
      case '/settings': {
        // The CLI's own settings (~/.hakster/cli-prefs.json). Bare `/settings`
        // lists them; `/settings <key> <value>` sets one. Values that the
        // running view can honour change now; the rest say "next launch".
        const [key, ...rest] = arg.split(/\s+/).filter(Boolean);
        if (!key) {
          // Bare `/settings` opens the full settings page — one row per key,
          // changed values marked, enter changes and r resets. `/settings <key>`
          // still reads one value in a line, for scripts and quick checks.
          setSettingsIdx(0);
          setView('settings');
          return;
        }
        if (!cliPrefs.isKnown(key)) {
          showNotice(`⚙ settings — unknown key ${key} · known: ${cliPrefs.KEYS.join(', ')}`);
          return;
        }
        if (!rest.length) {
          const row = cliPrefs.list().find((r) => r.key === key);
          const show = (v) => (typeof v === 'boolean' ? (v ? 'on' : 'off') : v || '(unset)');
          showNotice(`⚙ ${key}:${show(row.value)} · default ${show(row.default)}`);
          return;
        }
        const value = cliPrefs.coerce(key, rest.join(' '));
        if (value === null) {
          showNotice(`⚙ settings — ${key} takes on/off`);
          return;
        }
        writePrefs({ [key]: value });
        if (key === 'ads') setAdsOn(!!value);
        else if (key === 'autoHandoff') setHandoffOn(!!value);
        else if (key === 'model') setModel(String(value) || PRIMARY_MODEL);
        else if (key === 'provider') setProvider(String(value) || PRIMARY_PROVIDER);
        showNotice(`⚙ ${key} → ${typeof value === 'boolean' ? (value ? 'on' : 'off') : value || '(unset)'}${key === 'opaqueBackdrop' || key === 'intro' ? ' — applies on the next launch' : ''}`);
        return;
      }
      case '/graphics': {
        // Kitty graphics protocol: a real PNG (not half-block art) in terminals
        // that speak it. Plain terminals are never touched — every sequence is
        // sent with q=2 and only when support is detected.
        const want = String(arg || '').trim().toLowerCase();
        if (want === 'on' || want === 'off') {
          writePrefs({ graphics: want === 'on' });
          showNotice(`◆ kitty graphics → ${want}${want === 'on' ? ' (takes effect on the next launch)' : ''}`);
          return;
        }
        const sup = kittyGraphicsSupported(process.env, process.stdout);
        showNotice(`◆ kitty graphics — ${sup ? 'supported by this terminal' : 'not in this terminal (kitty · Ghostty · WezTerm)'} · logo ${prefsRef.current.graphics !== false ? 'on' : 'off'} · /graphics on|off`);
        return;
      }
      case '/update':
        showNotice(
          !update || update.status === 'idle' || update.status === 'checking'
            ? '⬆ update — checking the server for a newer CLI…'
            : update.status === 'applied' || (update.applied && update.applied.version)
              ? `⬆ update — running v${version}, installed on this start${update.applied && update.applied.from ? ` (was v${update.applied.from})` : ''}`
              : update.status === 'current'
              ? `⬆ update — up to date (v${update.version || version})`
              : update.status === 'installed'
                ? `✓ update — v${update.version} is installed on disk; this session is v${version} — restart the CLI to see the changes`
                : update.status === 'staged'
                ? `⬆ update — v${update.version} staged; applies when the CLI restarts`
                : update.status === 'blocked'
                  ? `⬆ update — v${update.version} staged; source checkout, not applied (pull/install when ready)`
                  : `⬆ update — check failed: ${update.reason || 'unknown'}`,
        );
        return;
      case '/danger': {
        // The approval password dangerous commands ask for, set from inside the
        // CLI instead of a second terminal. `/danger set` opens a masked field;
        // `/danger clear` removes the stored one. It is the same value and the
        // same file `hakster config sudo` uses, so both surfaces agree (§9, §23:
        // the password is never echoed, logged or put in argv).
        const verb = String(arg || '').trim().toLowerCase();
        if (verb === 'set') { setDangerSetup(true); return; }
        if (verb === 'clear') {
          const r = clearDangerPassword();
          showNotice(r.ok ? '◆ approval password cleared' : `◆ not cleared — ${r.reason || 'write failed'}`);
          return;
        }
        const s = dangerPasswordState();
        if (!s.set) { showNotice('◆ no approval password — /danger set (typed hidden)'); return; }
        showNotice(`◆ password set · ${s.length} chars · from ${s.source === 'env' ? 'HAKSTER_DANGER_PASSWORD' : '~/.hakster/config.json'} · /danger set to change · /danger clear to remove`);
        return;
      }
      case '/clear':
        agent.clear();
        setSteerQueue([]);
        showNotice('transcript cleared · steer queue emptied');
        return;
      case '/help':
        showNotice('keys: tab focus · shift+tab auto mode · pgup/pgdn scroll · ^P catalog · h handoff · d dashboard · v monitor · m models · s scripts · g squad · u usage · c clear · q quit · esc stop — commands: /menu /model /auto /graphics /mcp /handoff /ports /attach /dashboard /monitor /scripts /squad /usage /debug /status /update /settings /danger /recap /clear /quit');
        return;
      case '/recap': {
        // The idle recap row carries an id (`#a3f9k2`) because every run's
        // mistakes and lessons are written under it (owner, 2026-11-25: "each
        // recap will have id # to go stright to for issues in mem"). Bare
        // `/recap` reports the last id; `/recap #id` reads that run back out of
        // memory: the summary line, its mistakes and any banked lessons.
        const want = String(arg || '').trim().toLowerCase().replace(/^#?/, '#');
        const last = agent.lastRecap;
        if (!arg) {
          showNotice(last && last.id
            ? `▣ recap ${last.id} · ${last.tools} tools (${last.ok} ok · ${last.fail} err) · ✦ ${last.points}p — /recap ${last.id} reads it from memory`
            : '▣ recap — no finished run yet · /recap #id reads any run from memory');
          return;
        }
        if (!/^#[a-z0-9]{3,16}$/.test(want)) { showNotice('▣ recap — the id looks like #a3f9k2'); return; }
        (async () => {
          try {
            const res = await fetch(`${API}/api/agent/recap/${encodeURIComponent(want.slice(1))}`, {
              headers: { ...(process.env.HAKSTER_API_KEY ? { 'x-api-key': process.env.HAKSTER_API_KEY } : {}) },
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data || data.ok !== true) throw new Error((data && data.error) || `lookup failed (${res.status})`);
            if (!data.found) { showNotice(`▣ recap ${want} — nothing in memory under that id`); return; }
            const lines = [`▣ recap ${want}${data.line ? '' : ' — from the banks'}`];
            if (data.line) lines.push(`  ${data.line}`);
            for (const f of (data.raw || []).filter((m) => m.type === 'error').slice(0, 5)) {
              lines.push(`  ✗ ${String(f.observation || '').slice(0, 160)}`);
            }
            const lessons = (data.raw || []).filter((m) => m.type !== 'error');
            for (const l of lessons.slice(0, 2)) lines.push(`  · ${String(l.observation || '').slice(0, 160)}`);
            for (const b of (data.banked || []).filter((x) => x.type !== 'error').slice(0, 2)) {
              lines.push(`  ${b.section}: ${String(b.observation || '').slice(0, 160)}`);
            }
            agent.note(lines.join('\n'), 'notice');
          } catch (e) {
            showNotice(`▣ recap ${want} — ${(e && e.message) || 'lookup failed'}`);
          }
        })();
        return;
      }
      case '/quit':
      case '/exit':
        agent.abort();
        renderer.destroy();
        return;
      default:
        showNotice(`unknown command ${cmd} — /menu lists them`);
    }
  }, [agent, models, model, mcp, status, statusErr, renderer, showNotice, services, otherPorts, scan, handoffOn, autoMode, update, version]);

  // ── One catalog: our agents, crush's models, the reference list, the live MCP
  // servers and every slash command. Built from state — nothing invented, and a
  // row only appears if its source actually exists on this machine.
  const crushModelList = useRef(null);
  if (!crushModelList.current) crushModelList.current = readCrushModels();
  const catalogRows = (() => {
    const q = menuQuery.trim().toLowerCase();
    const match = (label, detail) => !q || `${label} ${detail}`.toLowerCase().includes(q);
    const rows = [];
    const pushSection = (section, items) => {
      const hits = items.filter((it) => match(it.label, it.detail));
      if (!hits.length) return;
      rows.push({ kind: 'header', label: section });
      rows.push(...hits);
    };
    pushSection('AGENTS', [
      { kind: 'agent', label: `Claude · ${displayModel(PRIMARY_MODEL)}`, detail: 'our config · ollama', action: { model: PRIMARY_MODEL, provider: PRIMARY_PROVIDER } },
      { kind: 'agent', label: 'Codex (Pro)', detail: 'provider default · ladder 2', action: { model: '', provider: 'codex-cli' } },
      ...(crushModelList.current || []).map((c) => ({
        kind: 'agent',
        label: `Crush ${c.slot} · ${c.model}`,
        detail: `crush · ${c.provider}`,
        action: { model: c.model, provider: c.provider },
      })),
    ]);
    pushSection('MODELS', models.map((m) => ({
      kind: 'model',
      label: m.id,
      detail: `${m.vendor}${m.context ? ` · ${Math.round(m.context / 1000)}K` : ''}`,
      action: { model: m.id, provider: PRIMARY_PROVIDER },
    })));
    const servers = (mcp && Array.isArray(mcp.servers)) ? mcp.servers : [];
    pushSection('MCP', servers.map((s) => ({
      kind: 'mcp',
      label: `${s.initialized === false && !(Number(s.toolCount) || 0) ? '○' : '●'} ${s.name}`,
      detail: `mcp · ${s.toolCount == null ? '?' : s.toolCount} tools${s.lazy ? ' · lazy' : ''}${s.initialized === false ? ' · down' : ''}`,
      action: { mcp: s.name },
    })));
    pushSection('SETTINGS', settingsRows.map((r) => ({
      kind: 'setting',
      label: `${r.key} ${showValue(r.value)}`,
      detail: `setting · ${String(r.value) !== String(r.default) ? 'changed · ' : 'default · '}enter changes`,
      action: { setting: r.key },
    })));
    pushSection('COMMANDS', MENU_ITEMS.map((i) => ({
      kind: 'cmd',
      label: `${i.cmd} ${i.label}`,
      detail: i.detail,
      action: { cmd: i.cmd },
    })));
    return rows;
  })();
  const catalogSelectable = catalogRows
    .map((r, i) => (r.kind === 'header' ? -1 : i))
    .filter((i) => i >= 0);

  const applyCatalogRow = useCallback((row) => {
    if (!row || !row.action) return;
    if ('model' in row.action) {
      setModel(row.action.model || '');
      setProvider(row.action.provider || PRIMARY_PROVIDER);
      showNotice(`model → ${row.action.model || row.label} · provider ${row.action.provider || PRIMARY_PROVIDER}`);
      return;
    }
    if (row.action.setting) { changeSetting(row.action.setting); return; }
    if (row.action.mcp) {
      const at = (mcp && Array.isArray(mcp.servers) ? mcp.servers : []).findIndex((s) => s.name === row.action.mcp);
      setMcpIdx(at > 0 ? at : 0);
      setView('mcp');
      return;
    }
    if (row.action.cmd) runCommand(row.action.cmd);
  }, [runCommand, showNotice, changeSetting, mcp]);

  const submit = useCallback(
    (text) => {
      const v = String(text == null ? '' : text).trim();
      if (!v) return;
      // Every line the operator sends is recallable — slash commands and
      // prompts alike. appendInputHistory refuses junk and anything that looks
      // like a secret, so recall can never echo a credential back (§9, §23).
      if (appendInputHistory(v)) {
        setInputHistory((h) => {
          const next = h.filter((x) => x !== v);
          next.push(v);
          return next.slice(-200);
        });
      }
      setHistIdx(-1);
      draftStash.current = '';
      // Commands run even while a turn is streaming — /quit and /clear must
      // always be reachable.
      if (v.startsWith('/')) {
        setDraft('');
        runCommand(v);
        return;
      }
      const att = attachment;
      setDraft('');
      setAttachment(null);
      // A running turn does not lock the input. What you type while the agent
      // works joins the steer queue and is sent as the next turn when this run
      // ends (see the drain effect below).
      if (agent.busy) {
        // An attachment can only travel on a real turn, so it queues outright.
        // Text goes to the LIVE run first: the server reads it before the run
        // ends, so a correction lands inside the answer instead of after it
        // (owner, 2026-11-24). Only a refusal (run already closed, or a server
        // without the steer endpoint) falls back to the queue — nothing typed
        // is ever dropped.
        const queued = {
          id: `steer-${Date.now()}-${steerQueue.length}`,
          text: v,
          image: att ? att.dataUrl : '',
          imageName: att ? att.name : '',
        };
        if (att) {
          setSteerQueue((q) => [...q, queued]);
          showNotice(`◌ steer queued (${steerQueue.length + 1}) — an attachment sends when this run ends`);
          return;
        }
        Promise.resolve(agent.steer(v)).then((delivered) => {
          if (delivered) {
            showNotice('↳ steer sent — the running agent reads it before this run ends');
            return;
          }
          setSteerQueue((q) => [...q, queued]);
          showNotice(`◌ steer queued (${steerQueue.length + 1}) — sends when this run ends`);
        });
        return;
      }
      agent.send(v, att ? { images: [att.dataUrl], imageName: att.name } : undefined);
    },
    [agent, attachment, runCommand, showNotice, steerQueue.length],
  );

  // The steer queue drains itself: one queued message per finished run, in
  // order. flushLock makes the drain exactly-once — `agent.busy` is React
  // state, so without it a second render in the same idle window would shift
  // the queue twice and lose a message. The lock releases as soon as a run is
  // actually live (`agent.busy`), which is when the next message may be sent.
  const steerFlushLock = useRef(false);
  useEffect(() => {
    if (agent.busy) { steerFlushLock.current = false; return; }
    if (steerFlushLock.current || steerQueue.length === 0) return;
    const [next, ...rest] = steerQueue;
    // send() answers synchronously whether the turn started. If it did not,
    // the message stays queued — nothing typed is ever dropped.
    if (agent.send(next.text, next.image ? { images: [next.image], imageName: next.imageName } : undefined) === false) return;
    steerFlushLock.current = true;
    setSteerQueue(rest);
  }, [agent.busy, steerQueue]);

  // A pending approval blocks the run, so it takes the keyboard. Both halves are
  // needed: the composer stops accepting input, AND the shortcut layer stands
  // down below. The renderer runs every useKeyboard handler, so without the
  // stand-down a `y` meant for the prompt would also reach the shortcut switch.
  const approving = !!agent.pendingConfirm;
  const showCrushStatus = view === 'chat' && agent.busy;
  // ▣ Recap: the run's receipt, shown while the agent is idle (owner, 2026-11-24:
  // "add recap in cli when agent is idle"). It takes the SAME row the live
  // spinner uses, so the chat layout gains no height — the spinner becomes the
  // recap the moment a run ends, and goes back to animating when the next one
  // starts. It appears only once something has actually run this session (a
  // restored transcript or a /clear leaves it off rather than printing a row of
  // zeros the run never earned).
  const todosDone = agent.todos.reduce((n, t) => n + (t.done ? 1 : 0), 0);
  const showRecap = view === 'chat' && !agent.busy && (usage.turns > 0 || usage.tools > 0);
  const activeAssistant = [...agent.messages].reverse().find((message) => message.role === 'assistant');
  const activeTool = activeAssistant?.tools?.slice().reverse().find((tool) => tool.result === null);
  const latestMcpTool = agent.messages
    .filter((message) => message.role === 'assistant')
    .flatMap((message) => message.tools || [])
    .filter((tool) => tool.mcp || String(tool.name || '').startsWith('mcp__'))
    .slice(-1)[0] || null;
  const mcpOutputText = latestMcpTool?.result == null
    ? 'Waiting for MCP server output…'
    : String(latestMcpTool.result).replace(/\r/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  // Owner, 2026-11-24: "the middle panels need bigger". The MCP output box is
  // the one middle panel that was pinned at six lines — it now grows with the
  // terminal so a tool result can actually be read where it lands.
  const mcpOutLines = (rows || 30) >= 44 ? 10 : (rows || 30) >= 30 ? 8 : MCP_OUTPUT_LINES;
  const mcpPanelRows = mcpOutLines + 3;
  const mcpPanelWidth = Math.max(1, Math.max(40, Math.min((cols || 100) - 2, 140)) - 10);
  const mcpOutputLines = mcpOutputText.split('\n').flatMap((line) => {
    if (!line) return [' '];
    const rows = [];
    for (let i = 0; i < line.length; i += mcpPanelWidth) rows.push(line.slice(i, i + mcpPanelWidth));
    return rows;
  });
  // Owner, 2026-11-24: "our panel when testing agents … when they're done the panel
  // clears … need to clear after sub agents output stops then clear panel for your
  // workspace". The MCP Output box exists to show a sub-agent call WHILE it runs; it
  // used to pin the last result forever and eat the reasoning workspace's rows. It now
  // clears itself a settle-window after the call returns AND the turn goes idle, and
  // comes straight back the moment another MCP call starts. Nothing is lost from the
  // transcript: the tool row and the run's own output stay there.
  const [mcpPanelCleared, setMcpPanelCleared] = useState(false);
  const mcpToolCallKey = latestMcpTool
    ? `${latestMcpTool.id || latestMcpTool.name || 'mcp'}:${latestMcpTool.result == null ? 'live' : 'done'}`
    : '';
  useEffect(() => {
    // "Live" means the call is still running inside the current turn. A tool with
    // NO result whose turn has already ended is abandoned — a restored session or
    // a run that died mid-call — and must not pin the box forever. Owner,
    // 2026-11-24: "phantom's output is stuck in purple panel" was exactly that: the
    // old code kept result==null up as if it were still waiting.
    const live = !!latestMcpTool && latestMcpTool.result == null && agent.busy;
    if (live) {
      // In flight: the panel stays up.
      setMcpPanelCleared(false);
      return undefined;
    }
    if (!latestMcpTool) return undefined;
    // Read at effect time (not module load) so a render probe can shorten the
    // window without touching the shipped default.
    const settleMs = Number(process.env.HAKSTER_MCP_SETTLE_MS) || MCP_PANEL_SETTLE_MS;
    const timer = setTimeout(() => setMcpPanelCleared(true), settleMs);
    return () => clearTimeout(timer);
  }, [mcpToolCallKey, agent.busy]);

  const crushPhase = activeAssistant?.phase
    || (agent.status === 'thinking' ? 'THINK' : (agent.status === 'connecting' || agent.status === 'reconnecting') ? 'PLAN' : 'ACT');

  const answerApproval = useCallback(
    (approved, opts) => {
      agent.answerConfirm(approved, opts);
    },
    [agent],
  );

  // Save the approval password the owner typed into the masked field. The
  // value goes straight into ~/.hakster/config.json (mode 600) by
  // setDangerPassword and is never echoed back — the notice states its length,
  // not its content (§9, §23).
  const saveDangerPassword = useCallback((value) => {
    const r = setDangerPassword(value);
    setDangerSetup(false);
    if (!r.ok) {
      showNotice(r.reason === 'empty' ? '◆ nothing saved — the field was empty' : `◆ not saved — ${r.reason}`);
      return;
    }
    showNotice(r.envOverride
      ? '◆ saved to config, but HAKSTER_DANGER_PASSWORD is set and takes precedence'
      : `◆ approval password saved (${String(value || '').length} chars) — dangerous and sudo commands will ask for it`);
  }, [showNotice]);

  const cycleFocus = useCallback(() => {
    setFocus((f) => (f === 'composer' ? 'ad' : 'composer'));
  }, []);

  useKeyboard((key) => {
    // Optional key log for debugging the popout in odd terminals (set
    // HAKSTER_TUI_KEYLOG to a file path). Never active by default.
    if (process.env.HAKSTER_TUI_KEYLOG) {
      try {
        fs.appendFileSync(process.env.HAKSTER_TUI_KEYLOG, JSON.stringify({ name: key.name, ctrl: !!key.ctrl, meta: !!key.meta, shift: !!key.shift }) + '\n');
      } catch {}
    }
    // Ctrl+C copies the current selection and only exits when nothing is
    // selected (owner, 2026-11-25: "fix the copy & paste don't work ... in his
    // cli"). The TUI holds the mouse for its own drag-selection, so the
    // terminal's native copy never sees the text; this hands it over with OSC
    // 52, which is the clipboard every modern terminal understands over SSH too.
    // Nothing selected keeps the old behaviour — Ctrl+C still quits.
    if (key.ctrl && key.name === 'c') {
      let copied = 0;
      try {
        if (renderer && renderer.hasSelection) {
          const text = renderer.getSelection ? renderer.getSelection()?.getSelectedText?.() : '';
          if (text && text.length) {
            renderer.copyToClipboardOSC52(text);
            copied = text.length;
          }
          renderer.clearSelection();
        }
      } catch {
        /* no selection, no clipboard — fall through and quit as before */
      }
      if (copied) {
        showNotice(`✔ copied ${copied} chars`);
        return;
      }
      agent.abort();
      renderer.destroy();
      return;
    }

    // The approval-password entry owns every key while it is open, exactly as
    // the approval gate does. The field is masked because DangerPasswordPrompt
    // reads the keys itself; nothing here ever sees the value.
    if (dangerSetup) return;

    // The /menu popout owns the keyboard while it is open; esc closes it
    // without running anything, enter runs the highlighted command.
    if (menuOpen) {
      // The popout owns the keyboard while it is open: type to filter, ↑↓ to
      // move, enter to apply, esc to close without running anything.
      const n = catalogSelectable.length || 1;
      if (key.name === 'escape') { setMenuOpen(false); return; }
      if (key.name === 'up') { setMenuIndex((i) => (i - 1 + n) % n); return; }
      if (key.name === 'down') { setMenuIndex((i) => (i + 1) % n); return; }
      if (key.name === 'backspace') { setMenuQuery((q) => q.slice(0, -1)); setMenuIndex(0); return; }
      if (key.name === 'return') {
        const row = catalogRows[catalogSelectable[Math.min(menuIndex, catalogSelectable.length - 1)]];
        // A settings row toggles in place and the catalog stays open, so several
        // switches can be flipped without reopening the menu; anything else
        // closes the popout and does its thing.
        if (row && row.action && row.action.setting) { applyCatalogRow(row); return; }
        setMenuOpen(false);
        setMenuQuery('');
        applyCatalogRow(row);
        return;
      }
      if (key.ctrl || key.meta) return;
      const ch = key.name === 'space' ? ' ' : (key.name && key.name.length === 1 ? key.name : '');
      if (ch) { setMenuQuery((q) => q + ch); setMenuIndex(0); }
      return;
    }

    // While an approval is pending it owns every key but Ctrl+C (handled
    // above); ApprovalPrompt reads the answer itself.
    if (approving) return;

    if (view === 'models') {
      if (key.name === 'escape' || key.name === 'm') {
        setView('dashboard');
        return;
      }
      if (pickerModels.length) {
        if (key.name === 'up') setModelIdx((i) => (i - 1 + pickerModels.length) % pickerModels.length);
        if (key.name === 'down') setModelIdx((i) => (i + 1) % pickerModels.length);
        if (key.name === 'return') {
          const pick = pickerModels[modelIdx] || pickerModels[0];
          setModel(pick.model || '');
          setProvider(pick.provider || PRIMARY_PROVIDER);
          writePrefs({ model: pick.model || '', provider: pick.provider || PRIMARY_PROVIDER });
          setView('chat');
          showNotice(`model → ${pick.value} · provider ${pick.provider || PRIMARY_PROVIDER}`);
        }
      }
      return;
    }

    // The usage page owns four keys: r re-measures now, ] faster, [ slower,
    // esc back. Every rate change is saved, so the page opens at the rate the
    // operator chose. PgUp/PgDn (and ↑/↓/Home/End) scroll the page itself, the
    // way the dashboard does — the bar keeps pace with what is drawn.
    if (view === 'usage') {
      if (key.name === 'escape') { setView('chat'); return; }
      if (key.name === 'r') { usagePage.refresh(); showNotice('◔ usage — refreshed'); return; }
      if (key.name === ']' || key.name === '=' || key.name === '+') {
        const next = Math.min(300, (usageRefresh || 0) + 15);
        setUsageRefresh(next); writePrefs({ usageRefresh: next });
        showNotice(`◔ usage refresh — every ${next}s`); return;
      }
      if (key.name === '[' || key.name === '-') {
        const next = Math.max(0, (usageRefresh || 0) - 15);
        setUsageRefresh(next); writePrefs({ usageRefresh: next });
        showNotice(next ? `◔ usage refresh — every ${next}s` : '◔ usage refresh — paused'); return;
      }
      const page = usageRef.current;
      if (page && typeof page.scrollBy === 'function') {
        if (key.name === 'pageup' || key.name === 'pagedown') {
          page.scrollBy(key.name === 'pageup' ? -1 : 1, 'viewport');
          return;
        }
        if (key.name === 'up' || key.name === 'down') {
          page.scrollBy(key.name === 'up' ? -1 : 1, 'absolute');
          return;
        }
        if (key.name === 'home') { page.scrollTo(0); return; }
        if (key.name === 'end') { page.scrollBy(1000, 'viewport'); return; }
      }
      return;
    }

    // ◇ Debugger: r resets the counters, esc leaves, pgup/pgdn/↑/↓ scroll it.
    if (view === 'debug') {
      if (key.name === 'escape') { setView('chat'); return; }
      if (key.name === 'r') { debugStats.reset(); showNotice('◇ debugger — counters reset'); return; }
      const page = debugRef.current;
      if (page && typeof page.scrollBy === 'function') {
        if (key.name === 'pageup' || key.name === 'pagedown') { page.scrollBy(key.name === 'pageup' ? -1 : 1, 'viewport'); return; }
        if (key.name === 'up' || key.name === 'down') { page.scrollBy(key.name === 'up' ? -1 : 1, 'absolute'); return; }
        if (key.name === 'home') { page.scrollTo(0); return; }
        if (key.name === 'end') { page.scrollBy(1000, 'viewport'); return; }
      }
      return;
    }

    // The settings page owns its keys: ↑↓ select, enter changes, r resets the
    // row to its default, esc returns to the chat.
    if (view === 'settings') {
      const n = settingsRows.length || 1;
      if (key.name === 'escape') { setView('chat'); return; }
      if (key.name === 'up') { setSettingsIdx((i) => (i - 1 + n) % n); return; }
      if (key.name === 'down') { setSettingsIdx((i) => (i + 1) % n); return; }
      if (key.name === 'return') {
        const row = settingsRows[Math.min(settingsIdx, settingsRows.length - 1)];
        if (row) changeSetting(row.key);
        return;
      }
      if (key.name === 'r') {
        const row = settingsRows[Math.min(settingsIdx, settingsRows.length - 1)];
        if (row) applySetting(row.key, row.default);
        return;
      }
      return;
    }

    // The MCP page: ↑↓ walk the servers, r re-reads the list now, esc back.
    if (view === 'mcp') {
      const n = (mcp && Array.isArray(mcp.servers) ? mcp.servers.length : 0) || 1;
      if (key.name === 'escape') { setView('chat'); return; }
      if (key.name === 'up') { setMcpIdx((i) => (i - 1 + n) % n); return; }
      if (key.name === 'down') { setMcpIdx((i) => (i + 1) % n); return; }
      if (key.name === 'r') {
        mcpRefreshRef.current && mcpRefreshRef.current();
        showNotice('◎ MCP — re-reading /api/agent/mcp-status');
        return;
      }
      return;
    }

    // The Lab views own the keyboard while they are open: ↑↓ select, enter
    // runs the script / places a delegation, esc returns to the chat.
    if (view === 'scripts' || view === 'squad') {
      const isScripts = view === 'scripts';
      const n = (isScripts ? runner.scripts.length : peers.length) || 1;
      const move = (d) => {
        if (isScripts) setScriptIdx((i) => (i + d + n) % n);
        else setSquadIdx((i) => (i + d + n) % n);
      };
      if (key.name === 'escape') { setView('chat'); return; }
      if (key.name === 'up') { move(-1); return; }
      if (key.name === 'down') { move(1); return; }
      if (key.name === 'return') {
        if (isScripts) {
          const entry = runner.scripts[scriptIdx];
          if (entry) {
            runner.start(entry);
            showNotice(`⌘ ${entry.label} — running`);
          }
        } else {
          const peer = peers[squadIdx];
          if (peer) {
            const tool = peer.tools[0];
            setDraft(`Delegate this to the ${peer.name} sub-agent${tool ? ` (mcp__${peer.name}__${tool})` : ''}: `);
            setView('chat');
            setFocus('composer');
            showNotice(`⍟ ${peer.name} — delegation placed on the composer`);
          }
        }
        return;
      }
      return;
    }

    // Shift+Tab — the autonomy dial, where the CLIs the owner runs put it
    // (owner, 2026-11-25: "add the auto mode on off where composer was like
    // this cli and work with shift+tab to cycle"). It walks ask → edit → full
    // in that order and says what it landed on. Plain Tab still moves focus
    // between the composer and the ad rail. Some terminals send shift+tab as
    // the CSI Z sequence instead of a shifted Tab; both are taken.
    if (key.name === 'tab' && (key.shift || key.sequence === '\x1b[Z')) {
      const next = AUTO_ORDER[(AUTO_ORDER.indexOf(autoMode) + 1) % AUTO_ORDER.length];
      setAutoMode(next);
      writePrefs({ autoMode: next });
      showNotice(autoNotice(next));
      return;
    }

    if (key.name === 'tab') {
      cycleFocus();
      return;
    }

    if (key.name === 'escape') {
      if (agent.busy) agent.abort();
      else if (view === 'monitor') setView('chat');
      else if (focus !== 'composer') setFocus('composer');
      return;
    }

    // PgUp/PgDn (and, on the dashboard, ↑/↓/Home/End) scroll the pane the
    // current view owns. The composer never wants them, so this runs before
    // the "printable keys belong to the input" stand-down.
    if (view === 'dashboard') {
      const dash = dashRef.current;
      if (dash && typeof dash.scrollBy === 'function') {
        if (key.name === 'pageup' || key.name === 'pagedown') {
          dash.scrollBy(key.name === 'pageup' ? -1 : 1, 'viewport');
          return;
        }
        if (key.name === 'up' || key.name === 'down') {
          dash.scrollBy(key.name === 'up' ? -1 : 1, 'absolute');
          return;
        }
        if (key.name === 'home') {
          dash.scrollTo(0);
          return;
        }
        if (key.name === 'end') {
          dash.scrollBy(1000, 'viewport');
          return;
        }
      }
    }
    // PgUp/PgDn on the chat view belong to <Transcript>: it owns the scroll
    // window and has to park or re-arm its follow-the-tail state with them.
    // A second handler here fought it row-for-row.
    if (key.name === 'pageup' || key.name === 'pagedown') return;

    // ↑/↓ in the composer walk the typed-line history (the one place in the
    // chat view an arrow is not a scroll — the transcript owns PgUp/PgDn).
    // Shift/Ctrl/Alt chords are left for other bindings.
    //
    // The composer is a wrapping textarea now (owner, 2026-11-25), so a draft
    // that already holds a newline keeps its arrows: there ↑/↓ move the caret
    // between lines, which is what anyone writing a multi-line task expects.
    // Only a single-line draft recalls history, and the event is consumed so
    // the editor does not also move its cursor.
    if (focus === 'composer' && !key.ctrl && !key.meta && !key.shift
      && (key.name === 'up' || key.name === 'down') && inputHistory.length > 0
      && !String(draft ?? '').includes('\n')) {
      if (typeof key.preventDefault === 'function') key.preventDefault();
      if (key.name === 'up') {
        if (histIdx === -1) draftStash.current = draft;
        const next = histIdx === -1 ? inputHistory.length - 1 : Math.max(0, histIdx - 1);
        setHistIdx(next);
        setDraft(inputHistory[next]);
      } else if (histIdx !== -1) {
        if (histIdx < inputHistory.length - 1) {
          setHistIdx(histIdx + 1);
          setDraft(inputHistory[histIdx + 1]);
        } else {
          setHistIdx(-1);
          setDraft(draftStash.current || '');
          draftStash.current = '';
        }
      }
      return;
    }

    // While the composer has focus, printable keys belong to the input and the
    // shortcut layer below must stay out of the way.
    if (focus === 'composer' && !key.ctrl && !key.meta) return;

    if (key.ctrl && key.name === 'p') {
      // The popout's shortcut, the way crush opens its palette from anywhere.
      setMenuQuery('');
      setMenuIndex(0);
      setMenuOpen(true);
      return;
    }
    if (key.ctrl && key.name === 'o') {
      setDockExpanded((v) => !v);
      return;
    }
    if (key.ctrl && key.name === 't') {
      // Reasoning fold, the OMP block behaviour: finished thoughts are one line
      // by default; this opens or folds them all.
      const want = !expandThinking;
      setExpandThinking(want);
      writePrefs({ thinkingExpanded: want });
      showNotice(want
        ? '◈ reasoning expanded — Ctrl+T folds it to "Thought for …"'
        : '◈ reasoning folded — Ctrl+T expands it');
      return;
    }

    // Only plain letters reach the shortcuts: a Ctrl/Alt chord must never
    // toggle a view. (Ctrl+D, sent by a pipe at EOF, used to flip to the
    // dashboard mid-session because it arrives as name 'd' with ctrl set.)
    if (key.ctrl || key.meta) return;

    switch (key.name) {
      case 'a': {
        const want = !adsOn;
        setAdsOn(want);
        writePrefs({ ads: want });
        break;
      }
      case 'h': {
        const want = !handoffOn;
        setHandoffOn(want);
        showNotice(want
          ? `auto handoff ON — ${MODEL_LADDER.map((e) => e.label).join(' → ')}`
          : 'auto handoff OFF — a failed run stays on its model');
        break;
      }
      case 'd':
        setView((v) => (v === 'chat' ? 'dashboard' : 'chat'));
        break;
      case 'v':
        setView((v) => (v === 'monitor' ? 'chat' : 'monitor'));
        break;
      case 'm':
        setModelIdx(pickerIndexFor(model, provider));
        setView('models');
        break;
      case 's':
        setView('scripts');
        break;
      case 'g':
        setView('squad');
        break;
      case 'u':
        setView((v) => (v === 'usage' ? 'chat' : 'usage'));
        break;
      case 'c':
        agent.clear();
        break;
      case 'r':
        load();
        break;
      case 'q':
        agent.abort();
        renderer.destroy();
        break;
      default:
        break;
    }
  });

  const panelW = Math.max(40, Math.min((cols || 100) - 2, 140));

  // Header fitting: [dot + brand + state + files] on the left, a right-hand
  // variant chosen so the pair fits the panel. Files survive longer than the
  // right-hand detail because the owner asked for the guard count always on.
  const headerState = statusErr ? 'OFFLINE' : status ? 'ONLINE' : 'connecting…';
  // The chat column's status box already prints brand · state · file guard ·
  // TUI version on its own top line (owner, 2026-11-24: "services panel on top
  // with haksterai online 13/13 files tui 0.3.6"). Printing the same words one
  // row higher is the dupe the owner flagged ("you have dupes 13/13 files
  // online"), so in the chat view this header row carries only the meters and
  // the right-hand detail. Every other view has no status box and keeps the
  // full line — the state and the guard count stay visible everywhere.
  const statusBoxShown = view === 'chat';
  const ctxK = Math.round(ctxMax / 1000);
  // `ctx <window>` used to ride this header line, but it only ever named the
  // window size and it competed with the ◈ memory bar for the right edge
  // (owner, 2026-11-26: "we have ctx up top of panels … move it to the right
  // side panel … move top one for space for our mem bar"). The reading lives in
  // the sidebar's ◔ Usage panel now, measured against the window, so nothing is
  // lost and the bar keeps the corner to itself.
  const headerDetailVariants = statusBoxShown
    ? // `tui <version>` lives on the status box's top line here, not twice.
      [[view].filter(Boolean).join(' · ')]
    : [
      ['tui ' + version, view].filter(Boolean).join(' · '),
      view,
    ];
  const headerInner = panelW - 2;
  const guardTxt = guard ? `${guard.present}/${guard.total} files` : '';
  const headerLeftLen = (withFiles) =>
    `● ◆ haksterAi · ${headerState}`.length + (withFiles && guardTxt ? `   ${guardTxt}`.length : 0);
  const showGuard = !statusBoxShown && !!guardTxt && headerLeftLen(true) + 8 <= headerInner;
  const headerFiles = showGuard ? guardTxt : '';
  const headerLeftText = statusBoxShown ? 0 : headerLeftLen(showGuard);

  // ◈ Memory-bank bar, pinned to the header's right edge (owner, 2026-11-24:
  // "add a real live bar at top right of tui for our memory bank % to know when
  // full or low and to keep count"). Fill is the fullest bank measured against
  // autolearn's per-bank storage cap — BANK_CAP = 300 in
  // server/src/agent/autolearn.js, the point where the oldest entries start
  // being dropped — so the bar goes yellow near it and red as a bank fills. The
  // trailing number is the running total across every bank, counted from disk
  // by useMemoryBank (counts only; no bank text ever reaches this row).
  const BANK_CAP = 300;
  const memBanks = memory && Array.isArray(memory.banks) ? memory.banks : [];
  const memFullest = memBanks.reduce((m, b) => Math.max(m, Number(b.entries) || 0), 0);
  const memTotal = memory && Number.isFinite(memory.total) ? memory.total : null;
  const memPct = !memory
    ? null
    : (memBanks.length ? Math.max(0, Math.min(100, Math.round((memFullest / BANK_CAP) * 100))) : 0);
  const memFg = memPct == null || memPct === 0
    ? 'gray'
    : memPct >= 90 ? '#f85149' : memPct >= 70 ? '#d29922' : '#3fb950';
  const MEMBAR_W = 5;
  const memBar = richBar(memPct, MEMBAR_W, memFg);
  // Health ratio beside the ◈ memory bar (owner, 2026-11-25: "the mem bar up top
  // in right tui add heath ratio green red for bad good slipping getting smarter
  // by the sec"). It is the share of the last 90 s of metered tool calls that
  // worked — green good, amber shaky, red bad — with the trend that window's own
  // movement points at: ▲ smarter, ▼ slipping, ◆ steady. Measured from real
  // events in smartness.mjs; with nothing recent it reads the smartness score and
  // says steady rather than inventing a direction.
  const health = (meters && meters.health) || { pct: meterScore, trend: 'steady', samples: 0 };
  const healthPct = Math.max(0, Math.min(100, Math.round(Number(health.pct) || 0)));
  const healthFg = healthPct >= 80 ? '#3fb950' : healthPct >= 60 ? '#d29922' : '#f85149';
  const healthGlyph = health.trend === 'smarter' ? '▲' : health.trend === 'slipping' ? '▼' : '◆';
  const healthWord = health.trend === 'smarter' ? 'smarter' : health.trend === 'slipping' ? 'slipping' : 'steady';
  // The same bar as the cpu/ram readings (owner, 2026-11-25: "some nice bars
  // that look rich not generic"), in the same place — the right edge of this row.
  const memParts = memPct == null || !memBar ? null : [
    { t: '◈ ', fg: memFg, bold: true },
    ...memBar,
    { t: ` ${memPct}%`, fg: memPct >= 90 ? 'red' : memPct === 0 ? 'gray' : 'white', bold: memPct > 0 },
    ...(memTotal != null ? [{ t: ` ${memTotal}`, fg: 'gray' }] : []),
    { t: '  ♥ ', fg: healthFg, bold: true },
    { t: `${healthPct}%`, fg: healthFg, bold: true },
    { t: ` ${healthGlyph} ${healthWord}`, fg: healthFg },
  ];
  // Same reading, shorter forms for a narrow row: the word goes first, then the
  // percentage, then the heart — the bar itself is what the owner pinned there.
  const memPartsVariants = !memParts ? [null] : [
    memParts,
    [
      { t: '◈ ', fg: memFg, bold: true },
      ...memBar,
      { t: ` ${memPct}%`, fg: memPct >= 90 ? 'red' : memPct === 0 ? 'gray' : 'white', bold: memPct > 0 },
      ...(memTotal != null ? [{ t: ` ${memTotal}`, fg: 'gray' }] : []),
      { t: ` ♥${healthPct}%`, fg: healthFg, bold: true },
      { t: healthGlyph, fg: healthFg },
    ],
    [
      { t: '◈ ', fg: memFg, bold: true },
      ...memBar,
      { t: ` ${memPct}%`, fg: memPct >= 90 ? 'red' : memPct === 0 ? 'gray' : 'white', bold: memPct > 0 },
      { t: healthGlyph, fg: healthFg, bold: true },
    ],
  ];
  // Right side of the header, richest first: the ◈ memory bar leads (the owner
  // asked to see it at the top right), then the view/ctx detail fills what room
  // is left. It walks from bar + longest detail down to the bar alone, so the
  // memory readout outlives the detail on a narrow terminal instead of being
  // the first thing dropped.
  const headerRightSets = [];
  for (const memo of memPartsVariants) {
    if (!memo) continue;
    for (const detail of headerDetailVariants) {
      const parts = [...memo];
      if (detail) parts.push({ t: `  ${detail}`, fg: 'gray' });
      headerRightSets.push({ parts, text: parts.map((p) => p.t).join('') });
    }
  }
  for (const detail of headerDetailVariants) {
    if (detail) headerRightSets.push({ parts: [{ t: detail, fg: 'gray' }], text: detail });
  }

  // Meters on the very top line (owner, 2026-11-24: "move the autolearn cpu ram
  // meters up top also"). The readings that had their own line inside the status
  // box move onto the header row itself, so the top box is exactly the status
  // line + the two service rows. Only the chat view does this — dashboard and
  // monitor already draw their own meters panels. If the line is too narrow for
  // any meter form, the box keeps its meters line: nothing disappears.
  const meterScore = Math.max(0, Math.min(100, Math.round(Number(meters && meters.score) || 0)));
  const meterPts = Math.max(0, Math.round(Number(meters && meters.points) || 0));
  const meterDelta = Number(meters && meters.delta) || 0;
  // Autolearn moves on its own arrow: points keep changing after the 0-100
  // score pins at its ceiling, so `delta` alone showed a flat marker on an
  // up-move. No percentage here — the top line already carries one and the
  // points bar below shows the same scale (owner, 2026-11-24: "a dupe % i
  // already had one up top").
  const meterPtsDelta = Number(meters && meters.pointsDelta) || 0;
  const meterArrowCh = arrowFor(meterDelta);
  const meterArrowFg = arrowFg(meterDelta);
  const meterPtsArrow = arrowFor(meterPtsDelta);
  const meterPtsArrowFg = arrowFg(meterPtsDelta);
  const meterCpu = host && host.cpuPct != null ? `${host.cpuPct}%` : '\u2014';
  const meterRam = host && host.memPct != null ? `${host.memPct}%` : '\u2014';
  const heatFg = (v) => (v == null ? 'gray' : v > 85 ? 'red' : v > 60 ? 'yellow' : 'green');
  const meterFg = {
    smart: barColor('smart', meterScore),
    pts: barColor('points', meterPts),
    cpu: heatFg(host && host.cpuPct),
    ram: heatFg(host && host.memPct),
  };
  // ⬆ Update on the top line (owner, 2026-11-24: "in our tui cli up top with cpu
  // etc add when our cli has updates will say updates will install on restart").
  // A staged package is already downloaded and hash-verified, so the only step
  // left is a restart — that is all this says. A source checkout is never
  // written into (§8), so it says pull rather than promising an install.
  // Nothing renders for current / checking / error: a badge that cries wolf is
  // worse than none, and the check re-runs on its own interval.
  // A build already installed on disk that this session is not running. On a
  // source checkout this is the normal case after an update lands: nothing can
  // be swapped under a git tree (§8), so the only step left is a restart —
  // and that is exactly what it says (owner, 2026-11-25: "should say installed
  // restart cli to see changes", to the right of cpu/ram; and 2026-11-25:
  // "i want our update to say this when its done in cli —
  // ✔ Update installed · Restart to update", which is the wording used here,
  // U+2714 without a variation selector so it stays a mono glyph).
  const updateInstalled = !!(update && !update.applied && update.status === 'installed' && update.version);
  const updatePending = updateInstalled || !!(update && !update.applied
    && (update.status === 'staged' || update.status === 'blocked'));
  const updateBlocked = !updateInstalled && updatePending && update.status === 'blocked';
  const updateVer = updatePending && update.version ? ` v${update.version}` : '';
  const updateBadgeVariants = !updatePending
    ? [null]
    : (updateInstalled
      ? [
          '✔ Update installed · Restart to update',
          '✔ installed · Restart to update',
          '✔ Restart to update',
          '✔ restart',
        ]
      : updateBlocked
      ? [
          `\u2B06 update${updateVer} \u00b7 pull to update`,
          '\u2B06 update \u00b7 pull to update',
          '\u2B06 pull to update',
        ]
      : [
          `\u2B06 update${updateVer} \u00b7 installs on restart`,
          '\u2B06 update \u00b7 installs on restart',
          '\u2B06 installs on restart',
        ])
      .filter((text, i, all) => all.indexOf(text) === i)
      .map((text) => ({ text, fg: updateBlocked ? 'yellow' : 'green' }));

  const mkMeter = (parts) => ({ text: parts.map((x) => x.t).join(''), parts });
  // Append the badge to an already-built meter form (or stand it alone).
  const withBadge = (meter, badge) => {
    if (!badge) return meter;
    const parts = meter.parts.length
      ? [...meter.parts, { t: `  ${badge.text}`, fg: badge.fg, bold: true }]
      : [{ t: badge.text, fg: badge.fg, bold: true }];
    return { text: parts.map((x) => x.t).join(''), parts };
  };
  // \u25c8 Mini bars beside the cpu and ram readings, drawn the same way as the \u25c8
  // memory-bank bar at the right edge of this row (owner, 2026-11-25: "with cpu
  // and ram can you add bars that go with the % next to them up top with other 1
  // on right side the cpu ram ones on left and the mem 1 on right where it is").
  // The cpu/ram pair stays in the left cluster; the memory bar does not move.
  // Fill is the reading itself, so the bar and the number beside it can never
  // disagree; an unmeasured host draws no bar at all rather than an empty one,
  // which would read as 0 %.
  const HOST_BAR_W = 5;
  const cpuBarParts = richBar(host && host.cpuPct, HOST_BAR_W, meterFg.cpu);
  const ramBarParts = richBar(host && host.memPct, HOST_BAR_W, meterFg.ram);
  const hostReading = (label, barParts, text, fg, lead = '  ') => [
    { t: `${lead}${label} `, fg: 'gray' },
    ...(barParts ? [...barParts, { t: ' ', fg: 'gray' }] : []),
    { t: text, fg },
  ];
  const smartPart = [
    { t: '\ud83e\udde0 ', fg: meterFg.smart, bold: true },
    { t: `${meterScore}% `, fg: 'white', bold: true },
    { t: meterArrowCh, fg: meterArrowFg },
  ];
  const ptsPart = [
    { t: `  \u2726 ${meterPts}p`, fg: meterFg.pts },
    { t: meterPtsArrow, fg: meterPtsArrowFg },
  ];
  // Richest first. The bars are the last thing dropped before the bare numbers,
  // because they were the request; a terminal too narrow for even that still
  // shows both percentages. The `ctx <N>%` reading that used to sit between the
  // points and cpu moved to the sidebar's \u25d4 Usage panel (owner, 2026-11-26), so
  // the top line is shorter and the update badge keeps its place beside cpu/ram.
  const baseMeterVariants = [
    mkMeter([
      ...smartPart,
      ...ptsPart,
      ...hostReading('cpu', cpuBarParts, meterCpu, meterFg.cpu),
      ...hostReading('ram', ramBarParts, meterRam, meterFg.ram),
    ]),
    mkMeter([
      ...smartPart,
      ...ptsPart,
      ...hostReading('cpu', null, meterCpu, meterFg.cpu),
      ...hostReading('ram', null, meterRam, meterFg.ram),
    ]),
    mkMeter([
      { t: `\u2726 ${meterPts}p`, fg: meterFg.pts },
      { t: meterPtsArrow, fg: meterPtsArrowFg },
      ...hostReading('cpu', null, meterCpu, meterFg.cpu, ' '),
      ...hostReading('ram', null, meterRam, meterFg.ram, ' '),
    ]),
  ];
  // Richest meter × longest badge first; a badge-only form closes the list so a
  // pending update outlives the cpu/ram readings on a narrow terminal instead of
  // being the first thing dropped when the row gets tight.
  const headerMeterVariants = [];
  for (const base of baseMeterVariants) {
    for (const badge of updateBadgeVariants) headerMeterVariants.push(withBadge(base, badge));
  }
  if (updatePending) {
    for (const badge of updateBadgeVariants) headerMeterVariants.push(withBadge(mkMeter([]), badge));
  }
  // Meters outrank the right-hand detail here (the owner just asked for them up
  // top, while the model is repeated on the bottom status bar and the TUI
  // version in the status box): walk the meter forms richest-first and take the
  // richest right-hand set that still fits beside it. The +2 slack absorbs the
  // brain emoji measuring two cells wide; only when nothing fits beside the
  // terse form does the status box keep its own meters line.
  let headerRight = null;
  let headerMeter = null;
  if (view === 'chat') {
    for (const meter of headerMeterVariants) {
      const fit = headerRightSets.find((s) => (
        headerLeftText + 3 + meter.text.length + 2 + (s.text ? s.text.length + 2 : 0) + 2 <= headerInner
      ));
      if (fit) {
        headerRight = fit;
        headerMeter = meter;
        break;
      }
    }
  }
  if (!headerMeter) {
    headerRight = headerRightSets.find((s) => headerLeftText + s.text.length + 2 <= headerInner) || null;
  }

  // HakTerm-style live column: only when there is room for it beside a readable
  // transcript (>=96 cols). Narrower terminals keep the panels full width.
  const sideW = (cols || 100) >= 96 ? 30 : 0;
  // The body sits inside the same one-column gutter the header and status bar
  // pad with, so the panel borders, the header text and the status bar share
  // one left edge and one right edge instead of drifting a column apart. The
  // sidebar column also takes a one-column gap, not two, so the row can fill
  // the padded width exactly (owner, 2026-11-23: "alignment tweaks ... in sync
  // with output and grids").
  const bodyW = panelW - 2;
  const mainW = bodyW - (sideW ? sideW + 1 : 0);
  // The meters row is one line; the services box is its own grid (3 rows when
  // compact, a wrapped grid when wide). Both sit above the composer, so their
  // rows come out of the transcript budget — and out of the sidebar's too.
  // Auto-compact: below this height every two-line cell becomes one line and
  // the panels shrink instead of the transcript disappearing (§ owner's
  // 2026-11-23 panel rule).
  const dense = (rows || 30) < 34;
  // The dashboard is one scrollable page (dashRows below), so its panels are
  // not height-constrained: keep the full two-line cells (taller panels) until
  // the screen is genuinely tiny, instead of folding them a row early.
  const dashDense = (rows || 30) < 26;
  const systemRows = 1;
  // The services grid is capped so it can never eat the transcript: two rows
  // of cells (three when dense), and the panel summarises the rest as "+N".
  // Height and cell count are derived from the width the box is DRAWN at —
  // the chat column, the monitor page and the dashboard page are three
  // different widths, and a grid budgeted for the wrong one is the classic way
  // this layout pushes its status bar off the screen.
  const servicesCapacityFor = (w, d = dense) => Math.max(4, Math.max(1, Math.floor(Math.max(1, w - 4) / 17)) * (d ? 3 : 2));
  const servicesRowsFor = (w, capacity, rawCount) => {
    if (w < 96) return 3; // the narrow one-line Services box
    return servicesGridRows(w, Math.min(Math.max(1, rawCount), capacity), dense);
  };
  // Chat folds the "other ports" count into the panel's title hint instead of
  // spending a whole extra grid row on it — those two rows go to the middle
  // boxes. The dashboard/monitor still list every other port as cells.
  const servicesRaw = Math.max(1, services.length);
  const servicesRawAll = services.length + (otherPorts.length ? 1 : 0);
  // Chat column: the meters row and the services grid are ONE box now (owner,
  // 2026-11-24: "combined the 2 panels into 1"), so its height replaces both.
  const statusRows = statusServicesRows(mainW, servicesRaw, true, !headerMeter);
  const dashServicesWidth = Math.max(1, panelW - 1);
  const dashServicesCapacity = servicesCapacityFor(dashServicesWidth, dashDense);
  const monitorServicesCapacity = servicesCapacityFor(panelW);
  const monitorServicesRows = servicesRowsFor(panelW, monitorServicesCapacity, servicesRawAll);
  // The live output panel the owner asked to sit lowest, right above the input
  // bar. Its height is a FIXED budget, not a streaming one: the box that shows
  // the run must never grow or shrink when a turn starts, or every panel above
  // it moves. This is only the CAP — the row budget below hands it whatever the
  // screen can spare, never starving the transcript.
  // Owner, 2026-11-24: "panels need to be bigger, taller — they're already wide
  // enough, adjust the grids". Both boxes now scale UP with the terminal
  // instead of pinning at 8/5/3 rows, so a tall screen fills with real content.
  const liveOutputLineCap = (rows || 30) >= 48 ? 18 : (rows || 30) >= 34 ? 12 : 8;
  const liveOutputCallRows = mainW >= 44 ? 1 : 0;
  // border 2 + title 1 + the call row when the column is wide enough
  const liveOutputChrome = 3 + liveOutputCallRows;
  // Owner, 2026-11-24: "we have 2 live panels 1 on right and middle keep right
  // one remove middle live panel make our reasoning panel replace live middle
  // to be taller". The right ◈ Live sidebar already carries the run's output,
  // activity, live image and meters, so the middle ▶ Live/Result box is only
  // drawn where that sidebar cannot be (narrower than 96 cols, sideW = 0).
  // Everywhere both could show, the middle box is gone and its rows go to the
  // reasoning transcript instead of leaving a hole in the column.
  const showLiveBox = sideW === 0;
  // Dashboard scroll box: the whole page scrolls, so a short terminal cannot
  // push the status bar off the bottom. Header + status bar are the fixed
  // chrome; the offline banner takes its own rows when it is showing.
  const dashRows = Math.max(6, (rows || 30) - 2 - (statusErr ? 3 : 0));
  // Models picker: header + status bar + the panel's border/title.
  const modelRows = Math.max(3, (rows || 30) - 5);
  // The sidebar spans the transcript column's area, so its vertical allowance
  // is the terminal minus the header and the status bar. LiveSidebar fits its
  // own panels (Live → Usage → Activity → Output → MCP) inside that number.
  const sidebarRows = Math.max(0, (rows || 30) - 2);
  // Live monitor: the system + services rows, then the feed and sidebar fill
  // everything down to the status bar. No composer, no rail — watch only.
  const monitorRows = Math.max(
    8,
    (rows || 30) - 2 - systemRows - monitorServicesRows - (notice ? 1 : 0),
  );

  // ── Row budget ────────────────────────────────────────────────────────────
  // header 1 · status bar 1 · composer 5 (border 2, input 1, inline ad 1, hint 1)
  // · rail 1 collapsed or 7 expanded · todos: border 2 + header 1 + rows + hint 1
  // The run row is one row whichever face it wears: the live spinner while it
  // works, the ▣ recap once it is idle.
  const CHROME_ROWS = 1 + 1 + (showCrushStatus || showRecap ? 1 : 0);
  // The offline banner is a bordered 3-row box rendered above every view, so it
  // must come out of the row budget — it used to be drawn without being counted,
  // which pushed the status bar off the bottom by exactly its height.
  const errRows = statusErr ? 3 : 0;
  const noticeRows = notice ? 1 : 0;
  const railRows = dockExpanded ? 7 : 1;
  // approval: border 2 + header 1 + reason 1 + command 1 + answer row 1
  const approvalRows = approving ? 6 : 0;
  // Everything the chat column draws before the composer and the two middle
  // boxes. Used to cap the /menu popout so it can never grow past the screen.
  const chromeNoComposer = CHROME_ROWS + errRows + noticeRows + railRows
    + approvalRows + statusRows + (showLiveBox ? liveOutputChrome : 0);
  // The /menu popout takes the composer's slot: bordered, title + filter + list
  // + footer. It is capped by what the terminal can spare AFTER the chrome and
  // two rows for the middle boxes, so a short window shrinks the popout instead
  // of pushing the status bar off the bottom (it windows its own list anyway).
  const MENU_ROWS = Math.max(6, Math.min(26, (rows || 30) - 12, (rows || 30) - chromeNoComposer - 2));
  // The composer is a wrapping textarea, so it takes the rows its draft actually
  // needs (owner, 2026-11-25: "needs to know when to go to new line not go off
  // the screen"). The measurement is shared with the component that draws it —
  // ui/src/utils/wrap.js — so the row budget and the real box cannot disagree.
  const composerInputW = Math.max(8, mainW - 6);
  const composerRows = menuOpen ? MENU_ROWS : composerHeight(draft, composerInputW, 6);
  // A short terminal gets a shorter checklist rather than a status bar that has
  // been pushed off the bottom — the panel scrolls, so nothing is hidden.
  const todoVisible = (rows || 30) >= 34 ? 6 : 3;
  // Optional panels are fitted, not assumed. Everything below is mandatory and
  // is what the column cannot live without: the header and status bar, the
  // composer, the rail, the meters, the services grid, and one row each for the
  // result box and the transcript. Anything left over may hold the checklist
  // (first, it is the agent's own plan) and then the MCP output box — so a
  // 20-row window with a todo list open shows the list and drops the MCP panel
  // instead of running off the bottom of the screen.
  const mandatoryRows = CHROME_ROWS + errRows + noticeRows + composerRows + railRows
    + approvalRows + statusRows + (showLiveBox ? liveOutputChrome : 0) + 2;
  const optionalBudget = (rows || 30) - mandatoryRows;
  const wantTodoRows = agent.todos.length ? Math.min(agent.todos.length, todoVisible) + 3 : 0;
  const showTodo = wantTodoRows > 0 && optionalBudget >= wantTodoRows;
  const todoRows = showTodo ? wantTodoRows : 0;
  const showMcpPanel = !!latestMcpTool && !mcpPanelCleared && optionalBudget - todoRows >= mcpPanelRows;
  // Everything except the transcript and the live box. Whatever is left is
  // shared between them. Owner, 2026-11-24: the two boxes swapped, and the
  // sizes follow them — the THINKING transcript is now the large area at the
  // bottom of the column and the RESULT box is the compact strip at the top.
  // So the live box keeps a small, readable cap and the transcript takes the
  // leftover (large) rows; a screen carrying a big todo list, an approval card
  // and the MCP panel shrinks them instead of pushing the status bar off.
  const fixedRows = CHROME_ROWS + errRows + noticeRows + composerRows + railRows + todoRows
    + approvalRows + statusRows + (showLiveBox ? liveOutputChrome : 0)
    + (showMcpPanel ? mcpPanelRows : 0);
  const sharedRows = (rows || 30) - fixedRows;
  // Owner, 2026-11-24: taller panels. The reasoning transcript keeps a real
  // floor that GROWS on a tall screen (10 rows at ≥34, 6 below), and the two
  // boxes can never take each other's last row — the old floors (6 + 3) could
  // together exceed the budget on a short screen carrying todos, an approval
  // card and the MCP panel, which pushed the status bar off the bottom.
  const sharedBudget = Math.max(2, sharedRows);
  // The result strip keeps a readable floor and a share that grows with the
  // screen, and the transcript always gets the remainder — so the two boxes
  // sum to exactly the budget on every height. The old min/max pair could hand
  // the strip a single row when a todo list, an approval card and the MCP panel
  // were all up; this one cannot starve either box.
  const liveFloor = sharedBudget >= 24 ? 6 : sharedBudget >= 14 ? 4 : 2;
  // Where the middle box is gone, the reasoning transcript takes the whole
  // budget — that is the "make our reasoning panel replace live middle to be
  // taller" half of the same request.
  const liveOutputLines = showLiveBox
    ? Math.max(
      1,
      Math.min(liveOutputLineCap, sharedBudget - 1, Math.max(liveFloor, Math.round(sharedBudget * 0.35))),
    )
    : 0;
  const transcriptRows = Math.max(1, sharedBudget - liveOutputLines);

  const dashboardItems = [
    {
      key: 'system',
      title: 'System',
      hint: status ? 'live' : 'connecting…',
      cells: [
        { label: 'phase', value: status ? status.phase : '—', color: 'cyan' },
        { label: 'connected', value: status ? (status.connected ? 'yes' : 'no') : '—', color: status && status.connected ? 'green' : 'red' },
        { label: 'server model', value: status ? displayModel(status.model) : '—' },
        { label: 'trust', value: status ? status.trust : '—' },
        { label: 'file guards', value: guard ? `${guard.present}/${guard.total}` : '…', color: guard && guard.missing && guard.missing.length ? 'red' : 'green' },
      ],
    },
    {
      key: 'host',
      title: 'Host',
      hint: '5s refresh',
      cells: [
        { label: 'cpu', value: host && host.cpuPct != null ? `${host.cpuPct}%` : '—', color: !host || host.cpuPct == null ? 'gray' : host.cpuPct > 85 ? 'red' : host.cpuPct > 60 ? 'yellow' : 'green' },
        { label: 'load 1m', value: host ? `${host.load1}/${host.cores}` : '—', color: !host ? 'gray' : host.load1 > host.cores ? 'red' : host.load1 > host.cores * 0.7 ? 'yellow' : 'green' },
        { label: 'ram', value: host && host.memPct != null ? `${host.memPct}%` : '—', color: !host || host.memPct == null ? 'gray' : host.memPct > 90 ? 'red' : host.memPct > 75 ? 'yellow' : 'green' },
        { label: 'swap', value: host && host.swapTotalMb ? `${host.swapUsedMb}/${host.swapTotalMb}M` : 'none', color: !host ? 'gray' : host.swapPct > 85 ? 'red' : host.swapPct > 50 ? 'yellow' : 'green' },
        { label: 'disk free', value: host && host.diskFreeGb != null ? `${host.diskFreeGb.toFixed(1)}G / ${host.diskTotalGb.toFixed(0)}G` : '—', color: !host || host.diskPct == null ? 'gray' : host.diskPct > 95 ? 'red' : host.diskPct > 90 ? 'yellow' : 'green' },
        { label: 'uptime', value: host ? `${Math.floor(host.uptimeS / 3600)}h ${Math.floor((host.uptimeS % 3600) / 60)}m` : '—' },
      ],
    },
    {
      key: 'session',
      title: 'Session',
      hint: '3s refresh',
      cells: [
        { label: 'tokens', value: ctxUsed },
        { label: 'ad requests', value: ads.adSessionSnapshot().adsServed, color: 'cyan' },
        { label: 'ads held', value: ads.adSessionSnapshot().adsHeld },
      ],
    },
    {
      key: 'context',
      title: 'Context',
      hint: `${ctxK}K window`,
      cells: [
        { label: 'used', value: ctxUsed },
        { label: 'window', value: `${ctxK}K` },
        { label: 'share', value: ctxUsed > 0 && ctxMax > 0 ? `${Math.round((ctxUsed / ctxMax) * 100)}%` : '—', color: ctxUsed / ctxMax > 0.8 ? 'red' : 'green' },
      ],
    },
    {
      key: 'agent',
      title: 'Agent',
      hint: agent.status,
      cells: [
        { label: 'state', value: agent.status, color: agent.status === 'error' ? 'red' : agent.status === 'reconnecting' ? 'yellow' : 'green' },
        { label: 'turns', value: agent.messages.filter((m) => m.role === 'user').length },
        { label: 'todos done', value: `${agent.todos.filter((t) => t.done).length}/${agent.todos.length}` },
        { label: 'elapsed', value: `${(agent.elapsedMs / 1000).toFixed(1)}s` },
      ],
    },
  ];

  // One sidebar, two placements: beside the transcript and in the monitor
  // view (where the big feed owns Activity/Output, so feed={false}).
  const sidebarProps = {
    width: sideW || 30,
    height: sidebarRows,
    agentStatus: agent.status,
    phase: crushPhase,
    tool: activeTool?.name || '',
    turns: userTurns,
    elapsedMs: agent.elapsedMs,
    version,
    mcp,
    serverOk: !statusErr && !!status,
    liveTool: liveToolTxt,
    liveLines,
    liveImage,
    graphics: prefsRef.current.graphics !== false,
    busy: agent.busy,
    activity: agent.activity || [],
    usage,
    memory,
    update,
  };

  // ── Start screen: five lines decode at once, then the dashboard ───────────
  // All hooks above have run; this only chooses what the first ~1.2 s shows.
  // Every line is live state — version, update state, model, server — so the
  // splash never tells the owner anything the session doesn't know.
  if (!introDone) {
    // Line 2 answers the owner's question directly (2026-11-24): was an update
    // installed? Then say it — green, with the version it replaced.
    const updateLine =
      update && update.applied && update.applied.version
        ? {
            text:
              update.applied.from && update.applied.from !== update.applied.version
                ? `✓ updated from v${update.applied.from}`
                : '✓ updated to the newest build',
            color: '#00ff41',
            bold: true,
          }
        : update && update.status === 'blocked'
          ? { text: `update v${update.version} held · source checkout`, color: 'gray' }
          : update && update.status === 'staged'
            ? { text: `update v${update.version} staged · applies on restart`, color: 'yellow' }
            : { text: 'up to date · updates check live', color: 'gray' };
    return (
      <DecodeSplash
        width={cols || 100}
        height={rows || 30}
        // HAKSTER_INTRO_STEP_MS slows or speeds the decode (default 55 ms);
        // useful on a slow terminal or for a screenshot.
        stepMs={Number(process.env.HAKSTER_INTRO_STEP_MS) > 0 ? Number(process.env.HAKSTER_INTRO_STEP_MS) : 55}
        graphics={prefsRef.current.graphics !== false}
        lines={[
          // Lime green on the hacker-desk hero, per the owner's 2026-11-23 note.
          { text: '◆ haksterAi', color: '#00ff41', bold: true },
          { text: `CLI v${version} · ${updateLine.text}`, color: updateLine.color || 'gray', bold: !!updateLine.bold },
          { text: `model ${modelText}`, color: '#a3e635' },
          {
            text: statusErr ? `server offline — ${statusErr}` : status ? 'server online' : 'connecting…',
            color: statusErr ? 'red' : status ? '#00ff41' : 'yellow',
          },
          { text: 'type a task · /menu commands · v live monitor', color: 'gray' },
        ]}
        onDone={() => setIntroDone(true)}
      />
    );
  }

  return (
    <box style={{ flexDirection: 'column', width: cols || 100, height: rows || 30, overflow: 'hidden' }}>
      {/* header — one row at every terminal width. The right-hand variants are
          tried longest-first against the measured left side, so a narrow
          terminal shortens the line instead of wrapping it onto the panels. */}
      <box style={{ width: panelW, flexDirection: 'row', justifyContent: 'space-between', flexShrink: 0, paddingLeft: 1, paddingRight: 1 }}>
        <box style={{ flexDirection: 'row' }}>
          {/* Brand · state · files are drawn by the chat view's status box, so
              they are not repeated here. Other views keep them. */}
          {statusBoxShown ? null : (
            <>
              <text fg={status ? (statusErr ? 'red' : 'green') : 'yellow'} attributes={TextAttributes.BOLD}>{statusErr ? '○ ' : status ? '● ' : '◌ '}</text>
              <text fg="cyan" attributes={TextAttributes.BOLD}>{'◆ haksterAi'}</text>
              <text fg={statusErr ? 'red' : status ? 'green' : 'yellow'}>{` · ${headerState}`}</text>
              {headerFiles ? (
                <text fg={guard.missing && guard.missing.length ? 'red' : 'gray'}>{`   ${headerFiles}`}</text>
              ) : null}
            </>
          )}
          {headerMeter ? (
            <text>
              {statusBoxShown ? null : <span fg="gray">{'   '}</span>}
              {headerMeter.parts.map((part, i) => (
                <span key={i} fg={part.fg} attributes={part.bold ? TextAttributes.BOLD : 0}>{part.t}</span>
              ))}
            </text>
          ) : null}
        </box>
        {headerRight ? (
          <text>
            {headerRight.parts.map((part, i) => (
              <span key={i} fg={part.fg} attributes={part.bold ? TextAttributes.BOLD : 0}>{part.t}</span>
            ))}
          </text>
        ) : null}
      </box>

      {statusErr ? (
        <box style={{ width: panelW, border: true, borderStyle: 'rounded', borderColor: 'red', paddingLeft: 1, paddingRight: 1 }}>
          <text fg="red">server unreachable — {statusErr}</text>
        </box>
      ) : null}

      {view === 'models' ? (
        <ScrollPanel
          width={panelW}
          title="Models"
          hint="↑↓ select · enter apply · esc back"
          total={pickerModels.length}
          rows={modelRows}
          selected={modelIdx}
          initial="top"
          compactWhen={panelW < 70}
        >
          {(index, { width: rowW, compact }) => {
            const pick = pickerModels[index];
            const active = index === modelIdx;
            const vendorW = compact ? 7 : 11;
            return (
              <box style={{ width: rowW, flexDirection: 'row', flexShrink: 0 }}>
                <text fg={active ? 'yellow' : 'gray'} attributes={active ? TextAttributes.BOLD : 0}>
                  {`${active ? '▸ ' : '  '}${clipLine(pick.vendor, vendorW)}`}
                </text>
                <text fg={active ? 'yellow' : 'white'}>
                  {` ${clipLine(pick.value, Math.max(4, rowW - vendorW - 3))}`}
                </text>
              </box>
            );
          }}
        </ScrollPanel>
      ) : view === 'settings' ? (
        /* The full settings page: every key in cli-prefs.json, its live value
           and what it does. Same row budget as the models picker so the status
           bar never moves. */
        <SettingsView
          width={panelW}
          rows={modelRows}
          list={settingsRows}
          selected={settingsIdx}
        />
      ) : view === 'mcp' ? (
        /* The MCP server manager: each server's real state from
           /api/agent/mcp-status, with the selected server's tool names. */
        <McpView
          width={panelW}
          height={Math.max(7, (rows || 30) - 2)}
          servers={(mcp && Array.isArray(mcp.servers)) ? mcp.servers : []}
          selected={mcpIdx}
        />
      ) : view === 'scripts' ? (
        <ScriptsView
          width={panelW}
          height={dashRows}
          scripts={runner.scripts}
          selected={scriptIdx}
          run={runner.run}
        />
      ) : view === 'squad' ? (
        <SquadView
          width={panelW}
          height={dashRows}
          peers={peers}
          selected={squadIdx}
        />
      ) : view === 'usage' ? (
        /* One scrollable page, like the dashboard: the page can be taller than
           a short terminal, so it scrolls with OpenTUI's own ▲/█/▼ bar instead
           of clipping the last measured rows (§ all-panels rule). */
        <box style={{ width: panelW, height: dashRows, flexShrink: 0, overflow: 'hidden' }}>
          <scrollbox
            ref={usageRef}
            style={{ width: panelW, height: dashRows, scrollY: true, scrollX: false, viewportCulling: true }}
            scrollbarOptions={PAGE_SCROLLBAR}
          >
            <UsageView
              width={Math.max(1, panelW - 1)}
              height={dashRows}
              usage={usagePage}
              refreshSeconds={usageRefresh}
              account={(status && status.user && status.user.username) || ''}
            />
          </scrollbox>
        </box>
      ) : view === 'debug' ? (
        /* ◇ Debugger (owner, 2026-11-24: "add debugger to"): the app's own
           measurements — render cost, event-loop lag, process, session counts —
           plus the box's build state from /api/version. Every field is a sample
           this process took or a value the server reported; "\u2014" is printed
           where there is no sample yet. */
        <box style={{ width: panelW, height: dashRows, flexShrink: 0, overflow: 'hidden' }}>
          <scrollbox
            ref={debugRef}
            style={{ width: panelW, height: dashRows, scrollY: true, scrollX: false, viewportCulling: true }}
            scrollbarOptions={PAGE_SCROLLBAR}
          >
            <DebugView
              width={Math.max(1, panelW - 1)}
              stats={debugStats.snap}
              version={debugStats.version}
              versionErr={debugStats.versionErr}
              session={{
                view,
                phase: status && status.phase,
                model: displayModel(model),
                provider,
                autoMode,
                handoff: handoffOn,
                connected: !!status && !statusErr,
                turns: usage.turns,
                tools: usage.tools,
                ok: usage.ok,
                fail: usage.fail,
                web: usage.web,
                inTok: usage.inTok,
                outTok: usage.outTok,
                tokensKnown: usage.tokensKnown,
                ctxPct: usage.ctxPct,
                guard,
                trust: status && status.trust,
                mcp: (mcp && Array.isArray(mcp.servers))
                  ? {
                    up: mcp.servers.filter((x) => !(x.initialized === false && !(Number(x.toolCount) || 0))).length,
                    total: mcp.servers.length,
                  }
                  : null,
              }}
              messages={agent.messages}
              terminal={{
                cols,
                rows,
                graphics: kittyGraphicsSupported(process.env, process.stdout),
                version,
              }}
            />
          </scrollbox>
        </box>
      ) : view === 'dashboard' ? (
        /* The dashboard is one scrollable page. Before this it was a fixed
           stack, so a short terminal clipped the services grid and pushed the
           status bar off the bottom. PgUp/PgDn (and ↑/↓, Home/End) scroll it;
           the panel cells auto-compact to one line on a short screen. */
        <box style={{ width: panelW, height: dashRows, flexShrink: 0, overflow: 'hidden' }}>
          <scrollbox
            ref={dashRef}
            style={{ width: panelW, height: dashRows, scrollY: true, scrollX: false, viewportCulling: true }}
            scrollbarOptions={PAGE_SCROLLBAR}
          >
            <box style={{ width: Math.max(1, panelW - 1), flexDirection: 'column' }}>
              <GridLayout
                items={dashboardItems}
                availableWidth={Math.max(1, panelW - 1)}
                getItemKey={(item) => item.key}
                renderItem={(item, index, columnWidth) => (
                  <GridPanel title={item.title} width={columnWidth} hint={item.hint} dense={dashDense}>
                    {item.cells.map((c) => (
                      <Cell key={c.label} label={c.label} value={c.value} color={c.color} w={Math.max(1, Math.floor((columnWidth - 6) / 2))} dense={dashDense} />
                    ))}
                  </GridPanel>
                )}
              />
              {/* The three bars the old CLI measured: smartness, autolearn and the
                  context window. Each is labelled and reads from live state. */}
              <GridPanel
                title="◉ Meters"
                width={Math.max(1, panelW - 1)}
                hint={`${smartLabel(meters ? meters.score : 0)} · ${meterPoints}p autolearn`}
              >
                <box style={{ width: Math.max(10, panelW - 5), flexDirection: 'row', flexShrink: 0 }}>
                  <text fg="gray">{'smartness   '}</text>
                  <Meter value={meters ? meters.score : 0} max={100} w={Math.min(40, Math.max(10, panelW - 40))} color={barColor('smart', meters ? meters.score : 0)} />
                  <text fg="white">{` ${meters ? meters.score : 0}% ${meters && meters.delta > 0 ? '▲' : meters && meters.delta < 0 ? '▼' : '◆'} ${smartLabel(meters ? meters.score : 0)}`}</text>
                </box>
                <box style={{ width: Math.max(10, panelW - 5), flexDirection: 'row', flexShrink: 0 }}>
                  <text fg="gray">{'autolearn   '}</text>
                  <Meter value={Math.min(100, meterPoints)} max={100} w={Math.min(40, Math.max(10, panelW - 40))} color={barColor('points', meterPoints)} />
                  <text fg="white">{` ${meterPoints}p`}</text>
                  <text fg={arrowFg(meters && meters.pointsDelta)}>{arrowFor(meters && meters.pointsDelta)}</text>
                  <box style={{ marginLeft: 2 }}>
                    <Spark data={pointsHistory} w={Math.min(24, Math.max(8, panelW - 70))} />
                  </box>
                </box>
                <box style={{ width: Math.max(10, panelW - 5), flexDirection: 'row', flexShrink: 0 }}>
                  <text fg="gray">{'context     '}</text>
                  <Meter value={ctxUsed} max={ctxMax} w={Math.min(40, Math.max(10, panelW - 40))} color={ctxUsed / ctxMax > 0.8 ? 'red' : 'green'} />
                  <text fg="white">{` ${Math.round(ctxUsed / ctxMax * 100)}%`}</text>
                </box>
              </GridPanel>
              <ServicesPanel width={dashServicesWidth} services={services} scan={scan} showAll dense={dashDense} maxCells={dashServicesCapacity} />
            </box>
          </scrollbox>
        </box>
      ) : view === 'monitor' ? (
        /* Live monitor — the whole screen watching one run: host meters and
           services on top, then the big activity feed and live output beside
           the sidebar. Shift+↑/↓ scrolls the feed, shift+End resumes follow,
           esc returns to the chat. Nothing runs from here; it only watches. */
        <>
          <box style={{ width: panelW, paddingLeft: 1, paddingRight: 1, flexDirection: 'column', flexShrink: 0 }}>
            <SystemPanel width={bodyW} meters={meters} ctxUsed={ctxUsed} ctxMax={ctxMax} host={host} />
            <ServicesPanel width={bodyW} services={services} scan={scan} dense={dense} maxCells={monitorServicesCapacity} />
          </box>
          <box style={{ flexDirection: 'row', width: panelW, paddingLeft: 1, paddingRight: 1, flexGrow: 1, flexShrink: 1, overflow: 'hidden' }}>
            <box style={{ width: sideW ? Math.max(20, bodyW - sideW - 1) : bodyW, flexDirection: 'column', flexShrink: 0, overflow: 'hidden' }}>
              <MonitorFeed
                width={sideW ? Math.max(20, bodyW - sideW - 1) : bodyW}
                height={monitorRows}
                activity={agent.activity || []}
                liveTool={liveToolTxt}
                liveLines={liveLines}
                busy={agent.busy}
              />
            </box>
            {sideW ? (
              <box style={{ marginLeft: 1 }}>
                <LiveSidebar {...sidebarProps} height={monitorRows} feed={false} />
              </box>
            ) : null}
          </box>
        </>
      ) : (
        <box style={{ flexDirection: 'row', width: panelW, paddingLeft: 1, paddingRight: 1, flexGrow: 1, flexShrink: 1, overflow: 'hidden' }}>
          <box style={{ width: mainW, flexDirection: 'column', flexShrink: 0, overflow: 'hidden' }}>
            {/* One status box pinned at the top of the column (owner,
                2026-11-24: "combined the 2 panels into 1 ... services panel
                on top with haksterai online 13/13 files tui 0.3.6 ... 2 row
                panel for services"). Brand · state · file guard · version on
                the top line, the meters under it, the ports grid in two rows. */}
            <StatusServicesPanel
              width={mainW}
              showMeters={!headerMeter}
              services={services}
              version={version}
              guard={guard}
              online={!!status}
              offline={!!statusErr}
              meters={meters}
              ctxUsed={ctxUsed}
              ctxMax={ctxMax}
              host={host}
              dense
            />
            {showTodo ? (
              <box style={{ flexShrink: 0 }}>
                <TodoPanel
                  todos={agent.todos}
                  width={mainW}
                  hint="the agent's checklist · updates live"
                  maxVisibleRows={Math.min(agent.todos.length, todoVisible)}
                />
              </box>
            ) : null}

            {/* ▶ Result — the compact strip at the top of the column. Only
                drawn when the right ◈ Live sidebar is not on screen (owner,
                2026-11-24: keep the right live panel, drop the middle one, so
                the reasoning transcript is the tall box). Narrow terminals
                keep this box as the fallback live view. It follows the newest
                line while the run streams; shift+↑/↓ pages it when the
                sidebar is hidden (the sidebar owns those keys when wide). */}
            {showLiveBox ? (
              <box style={{ flexShrink: 0, overflow: 'hidden' }}>
                <LiveOutputPanel
                  width={mainW}
                  rows={liveOutputLines}
                  lines={liveLines}
                  image={liveImage}
                  graphics={prefsRef.current.graphics !== false}
                  call={liveToolTxt}
                  busy={agent.busy}
                  phase={livePhase}
                  bindings={sideW ? null : { up: 'shift', down: 'shift', pageup: 'shift', pagedown: 'shift', home: 'shift', end: 'shift' }}
                />
              </box>
            ) : null}

            {showMcpPanel ? (
              <ScrollPanel
                key={latestMcpTool.id || latestMcpTool.name || 'mcp'}
                width={mainW}
                title={`MCP Output · ${String(latestMcpTool.name || '').split('__')[1] || 'server'}`}
                hint="Ctrl+↑/↓"
                total={mcpOutputLines.length}
                rows={mcpOutLines}
                initial="follow"
                bindings={{ up: 'ctrl', down: 'ctrl', pageup: 'ctrl', pagedown: 'ctrl', home: 'ctrl', end: 'ctrl' }}
                empty="Waiting for MCP server output…"
                borderColor="magenta"
              >
                {(index, { width: rowW }) => (
                  <box style={{ width: rowW }}>
                    <text fg="white">{clipLine(String(mcpOutputLines[index] || ' '), rowW)}</text>
                  </box>
                )}
              </ScrollPanel>
            ) : null}

            <box style={{ flexShrink: 0 }}>
              <AdRailSlot
                width={mainW}
                placementId={ads.PLACEMENTS.tuiRail}
                enabled={adsOn}
                focused={focus === 'ad'}
                expanded={dockExpanded}
              />
            </box>

            {approving ? (
              <box style={{ flexShrink: 0 }}>
                <ApprovalPrompt
                  width={mainW}
                  request={agent.pendingConfirm}
                  onAnswer={answerApproval}
                />
              </box>
            ) : null}

            {dangerSetup ? (
              <box style={{ flexShrink: 0 }}>
                <DangerPasswordPrompt
                  width={mainW}
                  onSave={saveDangerPassword}
                  onCancel={() => { setDangerSetup(false); showNotice('◆ cancelled — nothing changed'); }}
                />
              </box>
            ) : null}

            {notice ? (
              <box style={{ flexShrink: 0, width: mainW }}>
                {/* One row, always — a long /ports or /help notice is clipped
                    rather than allowed to wrap the layout. */}
                <text fg="cyan">{clipLine(`◆ ${notice}`, Math.max(8, mainW - 2))}</text>
              </box>
            ) : null}

            {/* The THINKING transcript is the tall box at the bottom of the
                column, directly over the input bar. It now owns the rows the
                middle live box used to take (owner, 2026-11-24: one live panel,
                on the right), so the reasoning is the large area on every wide
                screen. PgUp/PgDn page it and Ctrl+T opens the full reasoning;
                a capped tool result points at the pane that holds the rest —
                ▶ Output in the right sidebar, ▶ Result on a narrow terminal. */}
            {/* The wrapper grows into any height the row arithmetic left over
                (owner, 2026-11-25: the input bar must start at the bottom, never
                mid-screen), so leftover rows become transcript space instead of
                a gap under the status bar. */}
            <box style={{ flexGrow: 1, flexShrink: 0, overflow: 'hidden' }}>
              <Transcript
                messages={agent.messages}
                width={mainW}
                height={transcriptRows}
                grow
                scrollRef={scrollRef}
                live={agent.status !== 'idle'}
                expandThinking={expandThinking}
                // The spinner row under the composer owns the live label and
                // timer; the transcript only repeats them when that row is not
                // on screen (short terminal / non-chat view).
                liveLabel={!showCrushStatus}
                outputLabel={showLiveBox ? '▶ Result' : '▶ Output'}
                emptyHint="Type a task and the agent runs it with tools. /attach <path> sends an image. PgUp/PgDn scroll the transcript; Ctrl+T opens the reasoning; esc stops a run."
              />
            </box>

            <box style={{ flexShrink: 0 }}>
              {menuOpen ? (
                <CatalogPopout
                  width={mainW}
                  height={MENU_ROWS}
                  rows={catalogRows}
                  selectable={catalogSelectable}
                  selected={menuIndex}
                  query={menuQuery}
                />
              ) : (
                <Composer
                  width={mainW}
                  value={draft}
                  onChange={setDraft}
                  onSubmit={submit}
                  focused={focus === 'composer' && !approving && !dangerSetup}
                  // The old `⟪ composer ⟫` tag under the bar now sits on the
                  // hint row instead, because the owner put the auto-mode dial
                  // in that slot (2026-11-25).
                  focusTag={focus === 'ad' ? 'ad' : 'composer'}
                  // The input never locks while the agent works (owner,
                  // 2026-11-24: "i can type while agent is working need steer
                  // que"). Enter queues the text; the drain effect above sends
                  // it as the next turn when this run ends.
                  disabled={false}
                  hint={
                    approving
                      ? 'answer the request above — it is holding the run'
                      : agent.busy
                        ? `enter queues a steer${steerQueue.length ? ` (${steerQueue.length} waiting)` : ''} · it sends when this run ends · esc stop`
                        : attachment
                          ? `⊸ ${attachment.name} ${Math.round(attachment.bytes / 1024)}K · enter sends it · /attach clear`
                          : 'enter send · alt+enter newline · ctrl+c copies · ↑ history · /menu'
                  }
                  adSlot={
                    <AdRailSlot
                      width={Math.max(8, mainW - 4)}
                      placementId={ads.PLACEMENTS.tuiComposer}
                      enabled={adsOn}
                      focused={false}
                      expanded={false}
                    />
                  }
                />
              )}
            </box>

            {/* The thinking spinner sits UNDER the input bar (owner, 2026-11-24:
                "the thinking phrase spinner needs to go under the input bar not
                in the middle of tui"). One row, still budgeted in CHROME_ROWS,
                and it carries the steer-queue count so a queued message is
                visible without moving a single panel. */}
            {showCrushStatus ? (
              <box style={{ flexShrink: 0 }}>
                <CrushStatus
                  width={mainW}
                  phase={crushPhase}
                  tool={activeTool}
                  elapsedMs={agent.elapsedMs}
                  queued={steerQueue.length}
                  // The run's own stall clock and the meter's measured trend:
                  // HakTerm's hot/warming/cooling/cold wording and its
                  // stuck-then-call-a-tool nudge read from these, so the row
                  // describes the real run and not a timer (owner, 2026-11-25).
                  progressAt={agent.progressAtRef?.current || 0}
                  trend={agent.meters?.health?.trend || 'steady'}
                  loopAt={agent.loopAt || 0}
                />
              </box>
            ) : showRecap ? (
              // Idle: the same row states what the finished run did instead of
              // leaving it blank (owner, 2026-11-24: "add recap in cli when
              // agent is idle").
              <box style={{ flexShrink: 0 }}>
                <Recap
                  width={mainW}
                  recapId={agent.lastRecap?.id || ''}
                  points={agent.meters?.points || 0}
                  learned={agent.learned?.added || 0}
                  learnedSkills={agent.learned?.skills || 0}
                  memWritten={agent.lastRecap?.memWritten || 0}
                  turns={usage.turns}
                  tools={usage.tools}
                  ok={usage.ok}
                  fail={usage.fail}
                  web={usage.web}
                  requests={usage.requests}
                  elapsedMs={agent.elapsedMs}
                  inTok={usage.inTok}
                  outTok={usage.outTok}
                  tokensKnown={usage.tokensKnown}
                  ctxPct={usage.ctxPct}
                  failed={agent.status === 'error'}
                  todosDone={todosDone}
                  todosTotal={agent.todos.length}
                />
              </box>
            ) : null}
          </box>
          {sideW ? (
            <box style={{ marginLeft: 1 }}>
              <LiveSidebar {...sidebarProps} />
            </box>
          ) : null}
        </box>
      )}

      <box style={{ flexShrink: 0 }}>
        <StatusBar
          width={panelW}
          // The run's state (and its timer) are already on the spinner row
          // directly above this bar. Repeating it here printed a second
          // "thinking…" under the spinner (owner, 2026-11-24: "theres another
          // thinking under our live spinner we can remove"). While the spinner
          // row is up the bar drops the duplicate and keeps the session facts
          // (model, handoff, auto, width, ads); elsewhere it still reports it.
          status={showCrushStatus ? null : agent.status}
          model={modelText}
          cols={cols || 100}
          focus={focus}
          adsOn={adsOn}
          elapsedMs={agent.elapsedMs}
          handoff={handoffOn}
          autoMode={autoMode}
          hint={focus === 'ad' ? 'enter opens · ^O details' : null}
        />
      </box>
    </box>
  );
}
