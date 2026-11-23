import React, { useCallback, useEffect, useRef, useState } from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { useKeyboard, useRenderer, useTerminalDimensions } from '@opentui/react';
import { TextAttributes } from '@opentui/core';
import AdRailSlot from './components/DockAd.jsx';
import ApprovalPrompt from './components/ApprovalPrompt.jsx';
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
import ScrollPanel from './components/ScrollPanel.jsx';
import ScriptsView from './components/ScriptsView.jsx';
import SquadView from './components/SquadView.jsx';
import ServicesPanel, { servicesGridRows } from './components/ServicesPanel.jsx';
import StatusBar from './components/StatusBar.jsx';
import SystemPanel from './components/SystemPanel.jsx';
import CrushStatus from './components/CrushStatus.jsx';
import TodoPanel from './components/TodoPanel.jsx';
import Transcript from './components/Transcript.jsx';
import useAgentStream from './hooks/useAgentStream.js';
import useHostStats from './hooks/useHostStats.js';
import useMemoryBank from './hooks/useMemoryBank.js';
import useCliUpdate from './hooks/useCliUpdate.js';
import useScriptRunner from './hooks/useScriptRunner.js';
import { peersFromMcp } from './utils/squad.js';
import cliPrefs from '../../src/prefs.js';
import { barColor, fileGuard, otherListening, scanPorts, serviceStates, smartLabel } from '../../smartness.mjs';
import { MODEL_LADDER, PRIMARY_MODEL, PRIMARY_PROVIDER } from '../../src/models/ladder.js';
import catalog from '../../src/models/catalog.js';
import { isSupported as kittyGraphicsSupported } from '../../src/kitty-graphics.js';
import ads from '../../src/ads/ad-client.js';

const API = process.env.HAKSTER_API_URL || 'http://localhost:3579';
const MCP_OUTPUT_LINES = 4;
const MCP_OUTPUT_PANEL_ROWS = MCP_OUTPUT_LINES + 3;
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
  const renderer = useRenderer();
  const { width: cols, height: rows } = useTerminalDimensions();

  const [view, setView] = useState('chat'); // chat | dashboard | models | monitor
  const [focus, setFocus] = useState('composer'); // composer | ad
  const [adsOn, setAdsOn] = useState(() => readPrefs().ads !== false);
  const [dockExpanded, setDockExpanded] = useState(false);
  const [draft, setDraft] = useState('');
  // Start on the owner's cheap DeepSeek config; a GLM env tag is the old
  // default and falls through (§22 — the pinned Phantom Flash config).
  const [model, setModel] = useState(() => (process.env.HAKSTER_MODEL && !/^glm/i.test(process.env.HAKSTER_MODEL) ? process.env.HAKSTER_MODEL : readPrefs().model || PRIMARY_MODEL));
  const [provider, setProvider] = useState(process.env.HAKSTER_PROVIDER || PRIMARY_PROVIDER);
  const [modelIdx, setModelIdx] = useState(0);
  // Auto handoff: DeepSeek Flash → Codex → server waterfall. On unless the
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
  // The Lab views: our live scripts (with the OMP snapshot compare window) and
  // the sub-agent squad. Both are read from real state — the checkout and the
  // server's own /api/agent/mcp-status.
  const [scriptIdx, setScriptIdx] = useState(0);
  const [squadIdx, setSquadIdx] = useState(0);
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuQuery, setMenuQuery] = useState('');
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
  const scrollRef = useRef(null);
  // The dashboard and models views are scroll boxes too: a short terminal must
  // scroll the page, not push the status bar off the bottom (§ owner's
  // 2026-11-23 panel rule).
  const dashRef = useRef(null);
  // The usage page is a scroll box for the same reason: on a short terminal
  // every measured row stays reachable and the bar tracks the page instead of
  // the bottom of the list being clipped (§ all-panels rule).
  const usageRef = useRef(null);

  const agent = useAgentStream({
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
  // Read-only, every 30s; a failed read keeps the last good panel.
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
    tick();
    const t = setInterval(tick, 30000);
    return () => { alive = false; clearInterval(t); };
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
    { key: '__claude', vendor: 'Claude', value: `Claude · ${PRIMARY_MODEL}`, model: PRIMARY_MODEL, provider: PRIMARY_PROVIDER },
    { key: '__codex', vendor: 'Codex', value: 'Codex (Pro) · provider default', model: '', provider: 'codex-cli' },
    ...models.map((m) => ({ key: `c:${m.id}`, vendor: m.vendor, value: m.id, model: m.id, provider: PRIMARY_PROVIDER })),
  ];
  const pickerIndexFor = (m, p) => {
    const i = pickerModels.findIndex((x) => x.model === (m || '') && x.provider === (p || ''));
    return i < 0 ? 0 : i;
  };
  // What the header and the status bar call the current model. Codex is picked
  // by provider (no model string is invented for it), so it needs its own name.
  const modelText = model || (provider === 'codex-cli' ? 'Codex (Pro)' : provider || 'auto');
  const ctxMax = catalog.contextMaxFor(model || PRIMARY_MODEL) || 1;
  const ctxUsed = Number((status && (status.tokens || status.contextUsed)) || 0);
  const meters = agent.meters || null;
  // The run's live output for the sidebar: the newest tool call and the tail of
  // whatever it produced (or the answer being streamed). Derived from the same
  // messages the transcript renders, so the two can never disagree.
  const lastAssistant = (() => {
    for (let i = agent.messages.length - 1; i >= 0; i--) {
      if (agent.messages[i].role === 'assistant') return agent.messages[i];
    }
    return null;
  })();
  const lastTool = lastAssistant && Array.isArray(lastAssistant.tools) && lastAssistant.tools.length
    ? lastAssistant.tools[lastAssistant.tools.length - 1]
    : null;
  const liveToolTxt = lastTool ? `${lastTool.name}${toolArgLine(lastTool.args)}` : '';
  const liveLines = (() => {
    if (!lastAssistant) return [];
    const text = String(lastAssistant.text || '').trim();
    const result = lastTool && lastTool.result != null ? String(lastTool.result).trim() : '';
    // The bottom box is the RESULT, the top box is the REASONING (owner,
    // 2026-11-23: "top one needs to be reasoning and bottom the final result
    // output"). So the answer wins, then what the newest tool returned — never
    // the thinking, which belongs to the transcript above and made this panel
    // read as a second copy of it.
    const src = text || result;
    return src ? src.split('\n').filter((l) => l.trim()).slice(-6) : [];
  })();
  // The picture behind live-URL work (owner, 2026-11-23: "live image viewer in
  // the output panels when showing live url work"): a screenshot path, an image
  // URL or an inline data: image in what the last tool returned. The panels show
  // it; this only finds it.
  const liveImage = lastAssistant
    ? findImageSource([lastTool && lastTool.result != null ? String(lastTool.result) : '', String(lastAssistant.text || '')])
    : null;
  // This machine's own vitals — cpu, ram, swap, disk, load — sampled in-process.
  const host = useHostStats(5000);
  // 🧠 Memory: the same banks autolearn writes and the next run recalls,
  // counted from disk every 10 s (see useMemoryBank — counts only, no text).
  const memory = useMemoryBank(10000);
  // ⬆ Update: the Claude Code model — check in the background while this
  // session runs, download and verify a newer CLI into ~/.hakster/updates and
  // let the next launch apply it. The session itself is never restarted.
  const update = useCliUpdate();
  // ⌘ Live scripts: discovered from this checkout, run one at a time, bounded.
  const runner = useScriptRunner();
  // ◔ Usage, counted from the session itself: tool calls actually streamed,
  // the meter's scored wins and losses, requests sent (handoffs included),
  // operator turns, the turn-reported token totals and the context share. No
  // figure here is estimated; each is a count of something that happened.
  const userTurns = agent.messages.filter((m) => m.role === 'user').length;
  const toolCalls = agent.messages.reduce((n, m) => n + (Array.isArray(m.tools) ? m.tools.length : 0), 0);
  const usage = {
    tools: toolCalls,
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

  // ⬆ Update announcement: say it once per staged version. The swap happens at
  // the next launch (src/updater.js applies a verified stage before the bundle
  // loads); a source checkout is only ever told, never written into (§8).
  const updateAnnounced = useRef('');
  useEffect(() => {
    if (!update || !update.version) return;
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
          showNotice(`📎 ${next.name} · ${Math.round(next.bytes / 1024)}K — enter sends it with your message`);
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
        const live = list.filter((x) => x.initialized || (x.toolCount || 0) > 0).length;
        const tools = list.reduce((n, x) => n + (Number(x.toolCount) || 0), 0);
        const names = list
          .filter((x) => x.initialized || (x.toolCount || 0) > 0)
          .slice(0, 5)
          .map((x) => `${x.name}(${x.toolCount || 0})`)
          .join(' · ');
        showNotice(`MCP ${live}/${list.length} live · ${tools} tools · ${names}${list.length > 5 ? ' …' : ''}`);
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
        showNotice(
          next === 'full-auto'
            ? 'auto FULL — the agent runs and finishes without asking (sudo still confirms)'
            : next === 'auto-edit'
              ? 'auto EDIT — it works and finishes on its own; a dangerous shell command still asks'
              : 'auto ASK — every command that changes the box waits for you',
        );
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
      case '/status':
        showNotice(status
          ? `phase ${status.phase} · model ${status.model} · tokens ${status.tokens} · trust ${status.trust} · ${status.connected ? 'connected' : 'offline'}`
          : `server ${statusErr || 'connecting…'}`);
        return;
      case '/settings': {
        // The CLI's own settings (~/.hakster/cli-prefs.json). Bare `/settings`
        // lists them; `/settings <key> <value>` sets one. Values that the
        // running view can honour change now; the rest say "next launch".
        const [key, ...rest] = arg.split(/\s+/).filter(Boolean);
        if (!key) {
          // One line that fits beside the sidebar: how many keys, which ones
          // the owner has changed, and how to read or set one. Reading a key
          // (`/settings ads`) prints its value on its own.
          const changed = cliPrefs.list().filter((r) => String(r.value) !== String(r.default)).map((r) => r.key);
          showNotice(`⚙ ${cliPrefs.KEYS.length} keys · ${changed.length ? `changed: ${changed.join(', ')}` : 'all default'} · /settings <key> [on|off]`);
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
            : update.status === 'current'
              ? `⬆ update — up to date (v${update.version || version})`
              : update.status === 'staged'
                ? `⬆ update — v${update.version} staged; applies when the CLI restarts`
                : update.status === 'blocked'
                  ? `⬆ update — v${update.version} staged; source checkout, not applied (pull/install when ready)`
                  : `⬆ update — check failed: ${update.reason || 'unknown'}`,
        );
        return;
      case '/clear':
        agent.clear();
        showNotice('transcript cleared');
        return;
      case '/help':
        showNotice('keys: tab focus · pgup/pgdn scroll · ^P catalog · h handoff · d dashboard · v monitor · m models · s scripts · g squad · u usage · c clear · q quit · esc stop — commands: /menu /model /auto /graphics /mcp /handoff /ports /attach /dashboard /monitor /scripts /squad /usage /status /update /settings /clear /quit');
        return;
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
      { kind: 'agent', label: `Claude · ${PRIMARY_MODEL}`, detail: 'our config · ollama', action: { model: PRIMARY_MODEL, provider: PRIMARY_PROVIDER } },
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
      label: s.name,
      detail: `${s.toolCount == null ? '?' : s.toolCount} tools${s.initialized === false ? ' · down' : ''}`,
      action: { cmd: '/mcp' },
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
    if (row.action.cmd) runCommand(row.action.cmd);
  }, [runCommand, showNotice]);

  const submit = useCallback(
    (text) => {
      const v = String(text == null ? '' : text).trim();
      if (!v) return;
      // Commands run even while a turn is streaming — /quit and /clear must
      // always be reachable.
      if (v.startsWith('/')) {
        setDraft('');
        runCommand(v);
        return;
      }
      if (agent.busy) return;
      const att = attachment;
      setDraft('');
      setAttachment(null);
      agent.send(v, att ? { images: [att.dataUrl], imageName: att.name } : undefined);
    },
    [agent, attachment, runCommand],
  );

  // A pending approval blocks the run, so it takes the keyboard. Both halves are
  // needed: the composer stops accepting input, AND the shortcut layer stands
  // down below. The renderer runs every useKeyboard handler, so without the
  // stand-down a `y` meant for the prompt would also reach the shortcut switch.
  const approving = !!agent.pendingConfirm;
  const showCrushStatus = view === 'chat' && agent.busy;
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
  const mcpPanelWidth = Math.max(1, Math.max(40, Math.min((cols || 100) - 2, 140)) - 10);
  const mcpOutputLines = mcpOutputText.split('\n').flatMap((line) => {
    if (!line) return [' '];
    const rows = [];
    for (let i = 0; i < line.length; i += mcpPanelWidth) rows.push(line.slice(i, i + mcpPanelWidth));
    return rows;
  });
  const crushPhase = activeAssistant?.phase
    || (agent.status === 'thinking' ? 'THINK' : agent.status === 'connecting' ? 'PLAN' : 'ACT');

  const answerApproval = useCallback(
    (approved, opts) => {
      agent.answerConfirm(approved, opts);
    },
    [agent],
  );

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
    // Ctrl+C always exits, from anywhere.
    if (key.ctrl && key.name === 'c') {
      agent.abort();
      renderer.destroy();
      return;
    }

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
            showNotice(`⛨ ${peer.name} — delegation placed on the composer`);
          }
        }
        return;
      }
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
  const ctxK = Math.round(ctxMax / 1000);
  const ctxPart = model ? `ctx ${ctxK}K` : null;
  const headerRightVariants = [
    ['tui ' + version, view, modelText, ctxPart].filter(Boolean).join(' · '),
    [view, modelText, ctxPart].filter(Boolean).join(' · '),
    [view, modelText].filter(Boolean).join(' · '),
    [view, ctxPart].filter(Boolean).join(' · '),
    view,
  ];
  const headerInner = panelW - 2;
  const guardTxt = guard ? `${guard.present}/${guard.total} files` : '';
  const headerLeftLen = (withFiles) =>
    `● ◆ haksterAi · ${headerState}`.length + (withFiles && guardTxt ? `   ${guardTxt}`.length : 0);
  const showGuard = !!guardTxt && headerLeftLen(true) + 8 <= headerInner;
  const headerFiles = showGuard ? guardTxt : '';
  const headerLeftText = headerLeftLen(showGuard);
  const headerRight = headerRightVariants.find((t) => headerLeftText + t.length + 2 <= headerInner) || '';

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
  const systemRows = 1;
  // The services grid is capped so it can never eat the transcript: two rows
  // of cells (three when dense), and the panel summarises the rest as "+N".
  // Height and cell count are derived from the width the box is DRAWN at —
  // the chat column, the monitor page and the dashboard page are three
  // different widths, and a grid budgeted for the wrong one is the classic way
  // this layout pushes its status bar off the screen.
  const servicesCapacityFor = (w) => Math.max(4, Math.max(1, Math.floor(Math.max(1, w - 4) / 17)) * (dense ? 3 : 2));
  const servicesRowsFor = (w, capacity) => {
    if (w < 96) return 3; // the narrow one-line Services box
    const raw = services.length + (otherPorts.length ? 1 : 0);
    return servicesGridRows(w, Math.min(raw, capacity), dense);
  };
  const servicesCapacity = servicesCapacityFor(mainW);
  const servicesRows = servicesRowsFor(mainW, servicesCapacity);
  const dashServicesWidth = Math.max(1, panelW - 1);
  const dashServicesCapacity = servicesCapacityFor(dashServicesWidth);
  const monitorServicesCapacity = servicesCapacityFor(panelW);
  const monitorServicesRows = servicesRowsFor(panelW, monitorServicesCapacity);
  // The live output panel the owner asked to sit lowest, right above the input
  // bar: a short window that follows the newest line while a run streams.
  const liveOutputLines = (rows || 30) >= 48 ? 4 : 3;
  const liveOutputCallRows = mainW >= 44 ? 1 : 0;
  const liveOutputRows = liveOutputLines + 3 + liveOutputCallRows; // border 2 + title 1
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
  const CHROME_ROWS = 1 + 1 + (showCrushStatus ? 1 : 0);
  // The /menu popout takes the composer's slot, so its height is budgeted in
  // the same place: border 2 + header 1 + one row per command + hint 1.
  // The catalog popout: bordered, title + filter + list + footer. It windows
  // its own rows, so it is capped by the terminal rather than by catalog size.
  const MENU_ROWS = Math.max(10, Math.min(26, (rows || 30) - 12));
  const composerRows = menuOpen ? MENU_ROWS : 5;
  const noticeRows = notice ? 1 : 0;
  const railRows = dockExpanded ? 7 : 1;
  const todoRows = agent.todos.length ? Math.min(agent.todos.length, 6) + 3 : 0;
  // approval: border 2 + header 1 + reason 1 + command 1 + answer row 1
  const approvalRows = approving ? 6 : 0;
  const transcriptRows = Math.max(
    4,
    (rows || 30) - CHROME_ROWS - noticeRows - composerRows - railRows - todoRows
      - approvalRows - systemRows - servicesRows - liveOutputRows - (latestMcpTool ? MCP_OUTPUT_PANEL_ROWS : 0),
  );

  const dashboardItems = [
    {
      key: 'system',
      title: 'System',
      hint: status ? 'live' : 'connecting…',
      cells: [
        { label: 'phase', value: status ? status.phase : '—', color: 'cyan' },
        { label: 'connected', value: status ? (status.connected ? 'yes' : 'no') : '—', color: status && status.connected ? 'green' : 'red' },
        { label: 'server model', value: status ? status.model : '—' },
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
        { label: 'model', value: modelText, color: 'yellow' },
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
        { label: 'model', value: modelText, color: 'yellow' },
      ],
    },
    {
      key: 'agent',
      title: 'Agent',
      hint: agent.status,
      cells: [
        { label: 'state', value: agent.status, color: agent.status === 'error' ? 'red' : 'green' },
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
    model,
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
    const updateLine =
      update && update.status === 'blocked'
        ? `update v${update.version} held · source checkout`
        : update && update.status === 'staged'
          ? `update v${update.version} staged · applies on restart`
          : 'updates check live · apply on restart';
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
          { text: `CLI v${version} · ${updateLine}`, color: 'gray' },
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
          <text fg={status ? (statusErr ? 'red' : 'green') : 'yellow'} attributes={TextAttributes.BOLD}>{statusErr ? '○ ' : status ? '● ' : '◌ '}</text>
          <text fg="cyan" attributes={TextAttributes.BOLD}>{'◆ haksterAi'}</text>
          <text fg={statusErr ? 'red' : status ? 'green' : 'yellow'}>{` · ${headerState}`}</text>
          {headerFiles ? (
            <text fg={guard.missing && guard.missing.length ? 'red' : 'gray'}>{`   ${headerFiles}`}</text>
          ) : null}
        </box>
        {headerRight ? <text fg="gray">{headerRight}</text> : null}
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
                  <GridPanel title={item.title} width={columnWidth} hint={item.hint} dense={dense}>
                    {item.cells.map((c) => (
                      <Cell key={c.label} label={c.label} value={c.value} color={c.color} w={Math.max(1, Math.floor((columnWidth - 6) / 2))} dense={dense} />
                    ))}
                  </GridPanel>
                )}
              />
              {/* The three bars the old CLI measured: smartness, autolearn and the
                  context window. Each is labelled and reads from live state. */}
              <GridPanel
                title="◉ Meters"
                width={Math.max(1, panelW - 1)}
                hint={`${smartLabel(meters ? meters.score : 0)} · ${meterPoints}p autolearn · ${catalog.labelFor(catalog.findModel(model) || { id: modelText, vendor: 'local', context: null })}`}
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
              <ServicesPanel width={dashServicesWidth} services={services} scan={scan} showAll dense={dense} maxCells={dashServicesCapacity} />
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
            {agent.todos.length ? (
              <box style={{ flexShrink: 0 }}>
                <TodoPanel
                  todos={agent.todos}
                  width={mainW}
                  hint="the agent's checklist · updates live"
                  maxVisibleRows={Math.min(agent.todos.length, 6)}
                />
              </box>
            ) : null}

            <box style={{ flexGrow: 1, flexShrink: 1, overflow: 'hidden' }}>
              <Transcript
                messages={agent.messages}
                width={mainW}
                height={transcriptRows}
                scrollRef={scrollRef}
                emptyHint="Type a task and the agent runs it with tools. /attach <path> sends an image. PgUp/PgDn scroll the transcript; esc stops a run."
              />
            </box>

            {latestMcpTool ? (
              <ScrollPanel
                key={latestMcpTool.id || latestMcpTool.name || 'mcp'}
                width={mainW}
                title={`MCP Output · ${String(latestMcpTool.name || '').split('__')[1] || 'server'}`}
                hint="Ctrl+↑/↓"
                total={mcpOutputLines.length}
                rows={MCP_OUTPUT_LINES}
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

            {showCrushStatus ? (
              <box style={{ flexShrink: 0 }}>
                <CrushStatus
                  width={mainW}
                  phase={crushPhase}
                  activity={activeTool?.name || ''}
                  elapsedMs={agent.elapsedMs}
                />
              </box>
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

            {notice ? (
              <box style={{ flexShrink: 0, width: mainW }}>
                {/* One row, always — a long /ports or /help notice is clipped
                    rather than allowed to wrap the layout. */}
                <text fg="cyan">{clipLine(`◆ ${notice}`, Math.max(8, mainW - 2))}</text>
              </box>
            ) : null}

            {/* Old CLI's two meters + the context bar, then their ports grid. */}
            <SystemPanel width={mainW} meters={meters} ctxUsed={ctxUsed} ctxMax={ctxMax} host={host} />
            <ServicesPanel width={mainW} services={services} scan={scan} dense={dense} maxCells={servicesCapacity} />

            {/* ▶ Output sits LOWEST, directly over the input bar (owner,
                2026-11-23: "the lowest over the input bar cause reasonning
                pushes context up screen hard to see or keep up"). It follows
                the newest line while the run streams; shift+↑/↓ pages it when
                the sidebar is hidden (the sidebar owns those keys when wide). */}
            <LiveOutputPanel
              width={mainW}
              rows={liveOutputLines}
              lines={liveLines}
              image={liveImage}
              graphics={prefsRef.current.graphics !== false}
              call={liveToolTxt}
              busy={agent.busy}
              bindings={sideW ? null : { up: 'shift', down: 'shift', pageup: 'shift', pagedown: 'shift', home: 'shift', end: 'shift' }}
            />

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
                  focused={focus === 'composer' && !approving}
                  disabled={agent.busy}
                  hint={
                    approving
                      ? 'answer the request above — it is holding the run'
                      : agent.busy
                        ? 'esc stop · the run is streaming'
                        : attachment
                          ? `📎 ${attachment.name} ${Math.round(attachment.bytes / 1024)}K · enter sends it · /attach clear`
                          : 'enter send · /menu commands · /attach image · pgup scroll · q quit'
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
          status={agent.status}
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
