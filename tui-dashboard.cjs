#!/usr/bin/env node
/**
 * haksterAi TUI Dashboard v4 — Live terminal dashboard with WS events, users/logs, machine context
 *
 * Usage:
 *   node tui-dashboard.cjs                    # default (2s refresh)
 *   REFRESH_MS=500 node tui-dashboard.cjs     # faster refresh
 *   HAKSTER_HOST=http://host:3579 node tui-dashboard.cjs
 *
 * Features:
 *   - SYSTEM: OS, CPU model/temps, memory, load, disk, GPU, runtime
 *   - SERVICES: All running services with status dots
 *   - SESSIONS: Requests, tokens, cost, sessions, messages
 *   - PROVIDERS: Bar charts by provider/model
 *   - USERS & LOGS: Users, recent requests
 *   - HISTORY: Rolling sparkline graphs for CPU/mem/requests
 *   - PM2: Process list with CPU/mem/restarts, enter to restart
 *   - NETWORK: All listening ports
 *   - AGENT LOG: Live activity log + WS real-time events
 *   - Keys: q/esc quit, r refresh, s toggle auto-scroll, ↑↓ scroll, enter restart(pm2), 1-6 jump
 */

'use strict';

const blessed = require('blessed');
const http = require('http');
const WebSocket = require('ws');
const { execSync } = require('child_process');

// ── Config (shared with hakster-grids.sh) ─────────────────────────
const REFRESH_MS = parseInt(process.env.REFRESH_MS || '2000', 10);
// Scroll speed is a cycle of presets, not a fixed value — the '+'/'-' keys step through
// this list at runtime so a panel full of dense output (logs, PM2, network) can be
// blown through fast, then dialed back down to read carefully.
const SCROLL_SPEEDS = [1, 2, 3, 5, 10, 20];
let _scrollSpeedIdx = SCROLL_SPEEDS.indexOf(parseInt(process.env.SCROLL_SPEED || '1', 10));
if (_scrollSpeedIdx === -1) _scrollSpeedIdx = 0;
let SCROLL_SPEED = SCROLL_SPEEDS[_scrollSpeedIdx];
const MAX_LOG_LINES = parseInt(process.env.MAX_LOG_LINES || '200', 10);
const API_BASE = (process.env.HAKSTER_HOST || 'http://localhost:3579').replace(/\/$/, '');
const HISTORY_LEN = 60;

// ── Color palette ──────────────────────────────────────────────────
const C = {
  bg: '#0a0a0f', bgSubtle: '#1e1e2e', fg: '#e2e8f0',
  fgMuted: '#94a3b8', fgSubtle: '#64748b',
  primary: '#7c3aed', secondary: '#a855f7', accent: '#c084fc',
  info: '#38bdf8', success: '#4ade80', mustard: '#facc15',
  error: '#f87171', coral: '#ff577d', white: '#ffffff',
};

// ── Data stores ───────────────────────────────────────────────────
let dashData = null, healthData = null, pm2Data = [], connected = true;
let lastDashData = null, _lastLogHash = '';
let wsConn = null, wsConnected = false, wsReconnectTimer = null, wsBackoff = 1000;
let machineCtx = null;
let usersData = null;
let recentRequests = null;
let clientDevices = [];
let peopleData = null;
let machinesData = null;

// ── Rolling history ──────────────────────────────────────────────
const history = { cpu: [], mem: [], reqs: [], tokens: [], ts: [] };
function pushH(key, val) { history[key].push(val); if (history[key].length > HISTORY_LEN) history[key].shift(); }

// ── Hung-worker monitor ────────────────────────────────────────────
// Catches the exact failure mode diagnosed 2026-07-26 (haksterAi's port-3579
// worker pegged at ~85% CPU for minutes, ReDoS in consolidateMemories): a PM2
// process sustaining high CPU while still reporting 'online' is very likely
// spinning in a synchronous loop, not doing real work. Read from `pm2 jlist`
// (a separate process from the worker itself), so this keeps working even
// when the worker's own event loop is fully blocked and can't answer HTTP.
const HUNG_CPU_PCT = 50;      // sustained CPU% considered suspicious
const HUNG_SAMPLES = 4;       // consecutive polls required before flagging (~8s @ 2s refresh)
const pm2CpuHistory = new Map(); // pm2 process name -> recent cpu% samples
const hungWarned = new Set();    // names currently flagged, so the log line fires once per episode
function trackPm2Cpu(list) {
  const seen = new Set();
  for (const p of list) {
    const name = p.name || '?';
    seen.add(name);
    const cpu = p.monit?.cpu ?? 0;
    const status = p.pm2_env?.status || p.status;
    const hist = pm2CpuHistory.get(name) || [];
    hist.push(status === 'online' ? cpu : 0); // don't let a stopped/restarting process count as hung
    if (hist.length > HUNG_SAMPLES) hist.shift();
    pm2CpuHistory.set(name, hist);
    const isHung = hist.length >= HUNG_SAMPLES && hist.every(c => c > HUNG_CPU_PCT);
    if (isHung && !hungWarned.has(name)) {
      hungWarned.add(name);
      try { logBox.log(`{${C.error}}⚠ ${name} looks hung — CPU >${HUNG_CPU_PCT}% for ${HUNG_SAMPLES} straight polls. Press Enter on it in PM2 panel to restart.{/${C.error}}`); } catch {}
    } else if (!isHung && hungWarned.has(name)) {
      hungWarned.delete(name);
      try { logBox.log(`{${C.success}}✓ ${name} CPU back to normal.{/${C.success}}`); } catch {}
    }
  }
  for (const name of [...pm2CpuHistory.keys()]) if (!seen.has(name)) { pm2CpuHistory.delete(name); hungWarned.delete(name); }
}
function isPm2Hung(name) { return hungWarned.has(name); }

// ── WebSocket connection ──────────────────────────────────────────
const WS_BASE = API_BASE.replace(/^http/, 'ws') + '/ws';

function wsConnect() {
  if (wsConn && (wsConn.readyState === WebSocket.OPEN || wsConn.readyState === WebSocket.CONNECTING)) return;
  try {
    wsConn = new WebSocket(WS_BASE);

    wsConn.on('open', () => {
      wsConnected = true;
      wsBackoff = 1000;
      logBox.log(`{${C.success}}● WS connected{/${C.success}} {${C.fgSubtle}}${WS_BASE}{/${C.fgSubtle}}`);
      updateHeader();
      // Request notifications subscription
      try { wsConn.send(JSON.stringify({ action: 'subscribe', types: ['notification', 'agent'] })); } catch {}
    });

    wsConn.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        handleWSEvent(msg);
      } catch {}
    });

    wsConn.on('close', () => {
      wsConnected = false;
      logBox.log(`{${C.mustard}}○ WS disconnected{/${C.mustard}}`);
      updateHeader();
      wsReconnect();
    });

    wsConn.on('error', () => {
      wsConnected = false;
      updateHeader();
      wsReconnect();
    });
  } catch (e) {
    wsReconnect();
  }
}

function wsReconnect() {
  if (wsReconnectTimer) return;
  wsBackoff = Math.min(wsBackoff * 2, 30000);
  wsReconnectTimer = setTimeout(() => {
    wsReconnectTimer = null;
    wsConnect();
  }, wsBackoff);
}

let lastPhase = null;
let lastToolName = null;

function truncate(s, n) {
  if (!s) return '';
  let out = String(s).replace(/\r\n|\r|\n/g, ' ').trim();
  if (out.length > n) out = out.substring(0, n - 1) + '…';
  return out;
}

function handleWSEvent(msg) {
  const t = msg.type || 'unknown';
  const ts = new Date().toLocaleTimeString();

  // Tokens: only show first/last few to avoid flooding
  if (t === 'token') {
    const text = truncate(msg.token || msg.text || msg.content, 60);
    if (!text) return;
    logBox.log(`{${C.fgSubtle}}${ts} {${C.accent}}tok{/${C.accent}} ${text}{/${C.fgSubtle}}`);
    return;
  }

  // Delta: live model output text chunks (the actual streamed response)
  if (t === 'delta') {
    const text = truncate(msg.content, 100);
    if (!text) return;
    logBox.log(`{${C.fgSubtle}}  {/${C.fgSubtle}} {${C.success}}out{/${C.success}} {${C.fg}}${text}{/${C.fg}}`);
    return;
  }

  // Phase changes: only log when phase actually changes
  if (t === 'phase') {
    const p = msg.phase || msg.name || String(msg).substring(0, 12);
    if (p && p !== lastPhase) {
      lastPhase = p;
      const icon = { THINK: '🧠', PLAN: '📋', ACT: '⚡', OBSERVE: '👁', REFLECT: '🔮', CONSOLIDATE: '📦' }[p.toUpperCase()] || '◇';
      logBox.log(`{${C.secondary}}${icon} ${p.toUpperCase()}{/${C.secondary}} {${C.fgMuted}}[turn ${msg.turn || '?'}]{/${C.fgMuted}}`);
    }
    return;
  }

  // Tool events (legacy + new names)
  if (t === 'tool_call_start' || t === 'tool_start') {
    const tool = msg.tool_name || msg.name || '?';
    lastToolName = tool;
    logBox.log(`{${C.mustard}}⚡{/${C.mustard}} {${C.fg}}${ts}{/${C.fg}} {${C.accent}}TOOL{/${C.accent}} {bold}${tool}{/bold} {${C.fgSubtle}}started{/${C.fgSubtle}}`);
    return;
  }
  if (t === 'tool_call_result' || t === 'tool_result' || t === 'tool_end') {
    const tool = msg.tool_name || msg.name || lastToolName || '?';
    lastToolName = null;
    const raw = msg.tool_result || msg.result || msg.stdout || msg.stderr || '';
    const result = truncate(raw, 80);
    const color = (raw && !msg.error) ? C.success : C.error;
    logBox.log(`{${color}}✓{/${color}} {${C.fg}}${ts}{/${C.fg}} {${C.accent}}TOOL{/${C.accent}} {bold}${tool}{/bold} {${C.fgSubtle}}→{/${C.fgSubtle}} ${result}`);
    return;
  }

  // Thinking lifecycle — one live line, updated in place (see updateThinkingLine)
  if (t === 'thinking_start') {
    updateThinkingLine(`🧠 ${ts} THINKING started`);
    return;
  }
  if (t === 'thinking') {
    // Calculate available width: box width - borders (2) - padding (4) - prefix "  " (4) - color tag overhead (~60)
    const boxWidth = logBox.width || 120;
    const availWidth = Math.max(40, boxWidth - 70);
    const snippet = truncate(msg.content, availWidth);
    if (snippet) updateThinkingLine(`  ${snippet}`);
    return;
  }
  if (t === 'thinking_end') {
    endThinkingLine(`🧠 ${ts} THINKING done`);
    return;
  }

  if (t === 'chat_result') {
    const model = msg.model || '?';
    const tokens = (msg.inputTokens || 0) + (msg.outputTokens || 0);
    logBox.log(`{${C.primary}}◆{/${C.primary}} {${C.fg}}${ts}{/${C.fg}} {${C.success}}CHAT{/${C.success}} {${C.fg}}${model}{/${C.fg}} {${C.fgMuted}}│{/${C.fgMuted}} {${C.fg}}${fmtBytes(tokens)} tok{/${C.fg}}`);
    return;
  }

  if (t === 'notification') {
    const ntype = msg.notifyType || msg.type || 'notify';
    const icon = ntype === 'error' ? `{${C.error}}✗{/${C.error}}` : ntype === 'warn' ? `{${C.mustard}}⚠{/${C.mustard}}` : `{${C.info}}ℹ{/${C.info}}`;
    const text = truncate(msg.msg || msg.message, 120);
    logBox.log(`${icon} {${C.fg}}${ts}{/${C.fg}} {bold}${text || 'notification'}{/bold}`);
    return;
  }

  if (t === 'done') {
    logBox.log(`{${C.success}}✓{/${C.success}} {${C.fg}}${ts}{/${C.fg}} {${C.fgSubtle}}Agent done {${msg.model || ''} ${msg.provider || ''}{/${C.fgSubtle}}`);
    lastPhase = null;
    return;
  }

  if (t === 'error') {
    const err = truncate(msg.error || msg.message || 'WS error', 120);
    logBox.log(`{${C.error}}✗{/${C.error}} {${C.fg}}${ts}{/${C.fg}} {${C.error}}${err}{/${C.error}}`);
    return;
  }

  if (t === 'heartbeat') return;

  if (t === 'loop_detected') {
    logBox.log(`{${C.mustard}}⚠{/${C.mustard}} {${C.fg}}${ts}{/${C.fg}} {${C.mustard}}LOOP {${truncate(msg.reason, 40)}{/${C.mustard}} {${C.fgSubtle}}${truncate(msg.message, 40)}{/${C.fgSubtle}}`);
    return;
  }

  // Unknown event: print type and a tiny preview only (never JSON.stringify)
  if (t !== 'unknown') {
    const label = String(t).substring(0, 16);
    const preview = truncate(msg.content || msg.text || msg.data || '', 60);
    logBox.log(`{${C.fgSubtle}}${ts} {${C.fgMuted}}${label}{/${C.fgMuted}} ${preview}`);
  }
}

// ── Poll notification queue ───────────────────────────────────────
async function pollNotifications() {
  try {
    const items = await httpGet(`${API_BASE}/api/queue`);
    if (items && items.items && items.items.length > 0) {
      for (const n of items.items) {
        const icon = n.type === 'error' ? `{${C.error}}✗{/${C.error}}` : n.type === 'warn' ? `{${C.mustard}}⚠{/${C.mustard}}` : n.type === 'task' ? `{${C.primary}}◆{/${C.primary}}` : `{${C.info}}ℹ{/${C.info}}`;
        const ts = n.ts ? new Date(n.ts).toLocaleTimeString() : '';
        logBox.log(`${icon} {${C.fgMuted}}${ts}{/${C.fgMuted}} {${C.fg}}${n.msg}{/${C.fg}} {${C.fgSubtle}}[${n.type}] {${n.source || 'api'}]{/${C.fgSubtle}}`);
      }
      // Drain the queue so we don't re-read
      try { await httpPost(`${API_BASE}/api/queue/drain`, { max: 50 }); } catch {}
    }
  } catch {}
}

function httpPost(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(body || {});
    const opts = { hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, timeout: 3000 };
    const req = http.request(opts, res => {
      let b = ''; res.on('data', d => b += d); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve({}); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.end(data);
  });
}

// ── Fetch ─────────────────────────────────────────────────────────
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = { hostname: u.hostname, port: u.port, path: u.pathname, method: 'GET', timeout: 5000 };
    const req = http.request(opts, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(new Error('Invalid JSON')); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

async function fetchAll() {
  try {
    const [dash, health, mctx, users, reqs, clientCtxs, people, machines] = await Promise.all([
      httpGet(`${API_BASE}/api/dashboard`),
      httpGet(`${API_BASE}/api/health`),
      httpGet(`${API_BASE}/api/machine-context`).catch(() => null),
      httpGet(`${API_BASE}/api/users`).catch(() => null),
      httpGet(`${API_BASE}/api/requests?limit=10`).catch(() => null),
      httpGet(`${API_BASE}/api/client-contexts?limit=10`).catch(() => null),
      httpGet(`${API_BASE}/api/people?limit=10`).catch(() => null),
      httpGet(`${API_BASE}/api/machines`).catch(() => null),
    ]);
    dashData = dash; healthData = health; connected = true;
    if (mctx && mctx.cpu) machineCtx = mctx;
    if (users) usersData = users;
    if (reqs && reqs.requests) recentRequests = reqs.requests;
    if (clientCtxs && clientCtxs.contexts) clientDevices = clientCtxs.contexts;
    if (people) peopleData = people;
    if (machines) machinesData = machines;
    const s = dash.system || {};
    pushH('mem', s.totalMem ? ((s.totalMem - s.freeMem) / s.totalMem * 100) : 0);
    pushH('reqs', (dash.requests || {}).total || 0);
    pushH('tokens', (dash.requests || {}).totalTokens || 0);
    pushH('ts', Date.now());
    // Prefer load from machine-context API, fallback to /proc/loadavg
    if (machineCtx && machineCtx.cpu && machineCtx.cpu.load1 !== undefined) {
      pushH('cpu', machineCtx.cpu.cores ? Math.min(100, (machineCtx.cpu.load1 / machineCtx.cpu.cores) * 100) : 0);
    } else {
      try {
        const la = execSync('cat /proc/loadavg 2>/dev/null', { encoding: 'utf8' }).trim().split(' ');
        pushH('cpu', s.cpus ? Math.min(100, (parseFloat(la[0]) / s.cpus) * 100) : 0);
      } catch { pushH('cpu', 0); }
    }
  } catch { connected = false; }
  try {
    const raw = execSync('pm2 jlist 2>/dev/null', { encoding: 'utf8', timeout: 5000 });
    pm2Data = JSON.parse(raw);
  } catch {
    try { pm2Data = JSON.parse(execSync('pm2 list --no-color --format json 2>/dev/null', { encoding: 'utf8', timeout: 5000 })); if (!Array.isArray(pm2Data)) pm2Data = []; } catch { pm2Data = []; }
  }
  try { trackPm2Cpu(pm2Data); } catch {}
}

// ── Formatting ───────────────────────────────────────────────────
const fmtBytes = b => b < 1024 ? `${b}B` : b < 1048576 ? `${(b/1024).toFixed(1)}KB` : b < 1073741824 ? `${(b/1048576).toFixed(1)}MB` : `${(b/1073741824).toFixed(1)}GB`;
const fmtUptime = s => { const d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60); return d>0?`${d}d ${h}h ${m}m`:h>0?`${h}h ${m}m`:`${m}m`; };
const bar = (pct, w, fc=C.primary, ec=C.fgSubtle) => { const f=Math.round(Math.min(100,Math.max(0,pct))/100*w); return `{${fc}}${'█'.repeat(f)}{/${fc}}{${ec}}${'░'.repeat(w-f)}{/${ec}}`; };
const dot = s => s==='running'||s==='online'?`{${C.success}}●{/${C.success}}`:s==='stopped'||s==='errored'?`{${C.error}}●{/${C.error}}`:`{${C.mustard}}●{/${C.mustard}}`;
// padEnd only grows a string, never shrinks it — a field longer than its column width (long
// PM2 process names, OS strings, usernames, provider ids) was pushing rows past the panel
// border instead of aligning inside it. padFit truncates first, THEN pads, so every column
// stays inside its box no matter how long the underlying data is.
const padFit = (str, w) => { const s = String(str == null ? '' : str); return (s.length > w ? s.slice(0, Math.max(0, w - 1)) + '…' : s).padEnd(w); };

// ── Sparkline ────────────────────────────────────────────────────
function sparkline(values, width, height = 3, color = C.primary) {
  if (!values || values.length < 2) return `{${C.fgSubtle}}collecting...{/${C.fgSubtle}}`;
  const max = Math.max(...values, 1);
  const step = Math.max(1, Math.ceil(values.length / width));
  const sampled = [];
  for (let i = 0; i < values.length; i += step) {
    const sl = values.slice(i, i + step);
    sampled.push(sl.reduce((a, b) => a + b, 0) / sl.length);
  }
  while (sampled.length > width) sampled.shift();
  const chars = ['▁','▂','▃','▄','▅','▆','▇','█'];
  const lines = [];
  for (let row = height; row >= 1; row--) {
    let line = '';
    for (const v of sampled) {
      const norm = v / max;
      const ci = Math.min(Math.floor(norm * chars.length), chars.length - 1);
      const threshold = row / height;
      line += norm >= threshold - (1/height) ? `{${color}}${chars[ci]}{/${color}}` : `{${C.bgSubtle}}░{/${C.bgSubtle}}`;
    }
    lines.push(line);
  }
  return lines.join('\n');
}

// ── Create screen ─────────────────────────────────────────────────
const screen = blessed.screen({ smartCSR: true, title: 'haksterAi TUI', fullUnicode: true, dockBorders: true, mouse: true });
screen.key(['escape', 'q', 'C-c'], () => process.exit(0));

// ── Panels ─────────────────────────────────────────────────────────
const bdrStyle = (label) => ({ border: { fg: C.primary }, bg: C.bg, fg: C.fg, label: { fg: C.accent } });

// Shared real scrollbar — every scrollable panel gets this, not just the log
const scrollbar = { ch: '█', track: { bg: C.bgSubtle, fg: C.fgSubtle, ch: '░' }, style: { fg: C.primary } };
const scrollOpts = { scrollable: true, alwaysScroll: true, mouse: true, scrollbar };

const header = blessed.box({ top:0, left:0, width:'100%', height:1,
  content: `{center}{bold}{${C.primary}}◆{/bold}{/${C.primary}} {bold}{${C.fg}}haksterAi{/bold}{/${C.fg}} {${C.fgMuted}}TUI v3{/} {${C.fgSubtle}}│{/} {${C.success}}●{/${C.success}} {${C.fgSubtle}}WS{/} {${C.fgSubtle}}│{/} {${C.fgMuted}}1-5:jump r:↻{/}{/${C.fgSubtle}}{/center}`,
  tags: true, style: { bg: C.bgSubtle, fg: C.fg } });

function updateHeader() {
  const wsIcon = wsConnected ? `{${C.success}}●{/${C.success}}` : `{${C.error}}○{/${C.error}}`;
  const wsLabel = wsConnected ? 'WS' : 'offline';
  header.setContent(`{center}{bold}{${C.primary}}◆{/bold}{/${C.primary}} {bold}{${C.fg}}haksterAi{/bold}{/${C.fg}} {${C.fgMuted}}TUI v4{/} {${C.fgSubtle}}│{/} ${wsIcon} {${C.fgSubtle}}${wsLabel}{/${C.fgSubtle}} {${C.fgSubtle}}│{/} {${C.fgMuted}}1-6:jump r:↻{/}{/${C.fgSubtle}}{/center}`);
  try { screen.render(); } catch {}
}

// Layout uses percentage top/height throughout (instead of fixed row counts) so it scales to
// any terminal size instead of clipping panels off-screen on small windows. AGENT ACTIVITY
// (the thinking/output log) gets a dedicated full-width band at ~32% of height — previously it
// was a leftover 33%-wide corner sliver (~18% height at best, less on anything under ~45 rows).
const systemBox = blessed.box({ top:'2%', left:0, width:'50%', height:'20%',
  label:` {${C.primary}}◆{/} SYSTEM `, border:{type:'line'}, style:bdrStyle(), tags:true, ...scrollOpts });

const servicesBox = blessed.list({ top:'2%', left:'50%', width:'50%', height:'20%',
  label:` {${C.primary}}◆{/} SERVICES `, border:{type:'line'}, style:{...bdrStyle(), selected:{bg:C.bgSubtle}}, tags:true, ...scrollOpts, keys:true, vi:true });

const sessionsBox = blessed.box({ top:'23%', left:0, width:'33%', height:'16%',
  label:` {${C.primary}}◆{/} SESSIONS `, border:{type:'line'}, style:bdrStyle(), tags:true, ...scrollOpts });

const providersBox = blessed.box({ top:'23%', left:'33%', width:'34%', height:'16%',
  label:` {${C.primary}}◆{/} PROVIDERS `, border:{type:'line'}, style:bdrStyle(), tags:true, ...scrollOpts });

const usersBox = blessed.list({ top:'23%', left:'67%', width:'33%', height:'16%',
  label:` {${C.primary}}◆{/} USERS & LOGS `, border:{type:'line'}, style:{...bdrStyle(), selected:{bg:C.bgSubtle}}, tags:true, ...scrollOpts, keys:true, vi:true });

const historyBox = blessed.box({ top:'40%', left:'50%', width:'50%', height:'7%',
  label:` {${C.primary}}◆{/} HISTORY `, border:{type:'line'}, style:bdrStyle(), tags:true, ...scrollOpts });

const pm2Box = blessed.list({ top:'40%', left:0, width:'50%', height:'14%',
  label:` {${C.primary}}◆{/} PM2 {${C.fgSubtle}}enter:restart{/${C.fgSubtle}} `, border:{type:'line'}, style:{...bdrStyle(), selected:{bg:C.bgSubtle}}, tags:true, ...scrollOpts, keys:true, vi:true });

const networkBox = blessed.list({ top:'47%', left:'50%', width:'50%', height:'7%',
  label:` {${C.primary}}◆{/} NETWORK `, border:{type:'line'}, style:{...bdrStyle(), selected:{bg:C.bgSubtle}}, tags:true, ...scrollOpts, keys:true, vi:true });

const peopleBox = blessed.list({ top:'55%', left:0, width:'33%', height:'13%',
  label:` {${C.primary}}◆{/} PEOPLE `, border:{type:'line'}, style:{...bdrStyle(), selected:{bg:C.bgSubtle}}, tags:true, ...scrollOpts, keys:true, vi:true });

const machinesBox = blessed.list({ top:'55%', left:'33%', width:'34%', height:'13%',
  label:` {${C.primary}}◆{/} MACHINES `, border:{type:'line'}, style:{...bdrStyle(), selected:{bg:C.bgSubtle}}, tags:true, ...scrollOpts, keys:true, vi:true });

const integrationsBox = blessed.box({ top:'55%', left:'67%', width:'33%', height:'13%',
  label:` {${C.primary}}◆{/} INTEGRATIONS `, border:{type:'line'}, style:bdrStyle(), tags:true, ...scrollOpts });

const logBox = blessed.log({ top:'68%', left:0, width:'100%', height:'32%-1',
  label:` {${C.primary}}◆{/} AGENT ACTIVITY (thinking / tool output) `, border:{type:'line'}, style:bdrStyle(), tags:true,
  ...scrollOpts, scrollback:MAX_LOG_LINES, wrap: false });

// Auto-scroll: force logBox to bottom after every message.
// Every WS-driven event (tool calls, deltas, thinking, phase changes) funnels through this
// wrapper, so a throttled render here is what makes the log feel live instead of waiting up
// to REFRESH_MS for the next poll tick to call screen.render().
let autoScroll = true;
let _renderPending = false;
function scheduleRender() {
  if (_renderPending) return;
  _renderPending = true;
  setImmediate(() => { _renderPending = false; try { screen.render(); } catch {} });
}
let _thinkingActive = false;
let _thinkingInterrupted = false;
let _writingLiveLine = false;
const _origLog = logBox.log.bind(logBox);
logBox.log = (...args) => {
  // Every WS event type (token, delta, phase, tool_call_*, notification, etc.)
  // funnels through this same override. If one of those writes while a live
  // thinking line is showing, the thinking line is no longer the tail of the
  // log — flag it so updateThinkingLine below skips its pop instead of
  // deleting that unrelated content.
  if (_thinkingActive && !_writingLiveLine) _thinkingInterrupted = true;
  _origLog(...args);
  if (autoScroll) try { logBox.setScrollPerc(100); } catch {}
  scheduleRender();
};

// Live thinking line: the server streams many small reasoning chunks per
// second (see server/src/index.js thinking_start/thinking/thinking_end SSE
// events). Logging each chunk as its own line used to flood AGENT ACTIVITY
// with near-duplicate "thinking" lines. Instead keep exactly one line live —
// pop the rows the previous chunk occupied, then log the new snippet in the
// same spot — mirrors the pattern in haksterai-cli.cjs.
let _thinkingRows = 0;
// blessed's Element.popLine(n) is broken for n>1: it computes the delete
// index once (fake.length-1) and reuses it across the loop, so after the
// first splice the array has shrunk and that index is out of range —
// every subsequent splice is a silent no-op. Net effect: only the single
// last line is ever removed, no matter what n is. Calling popLine(1) in a
// loop recomputes the index fresh each time and actually removes n lines.
function popLines(box, n) { for (let i = 0; i < n; i++) { try { box.popLine(1); } catch {} } }
function updateThinkingLine(text) {
  // Only pop if nothing else landed on the log since our last write —
  // otherwise the tail belongs to unrelated content (tool output, deltas,
  // phase changes) and popping would silently delete it. Skipping the pop
  // just leaves one stale "thinking" line behind — cosmetic, not data loss.
  if (_thinkingActive && _thinkingRows > 0 && !_thinkingInterrupted) {
    // Pop ALL previous thinking rows (could be multiple if wrapping happened)
    for (let i = 0; i < _thinkingRows; i++) {
      try { logBox.popLine(1); } catch {}
    }
  }
  _writingLiveLine = true;
  logBox.log(text);
  _writingLiveLine = false;
  // Force single line - if blessed wrapped it anyway, we'll just pop more next time
  _thinkingRows = 1;
  _thinkingActive = true;
  _thinkingInterrupted = false;
}
function endThinkingLine(finalText) {
  if (_thinkingActive && _thinkingRows > 0 && !_thinkingInterrupted) {
    // Pop ALL previous thinking rows
    for (let i = 0; i < _thinkingRows; i++) {
      try { logBox.popLine(1); } catch {}
    }
  }
  _thinkingActive = false;
  _thinkingRows = 0;
  _thinkingInterrupted = false;
  if (finalText) { _writingLiveLine = true; logBox.log(finalText); _writingLiveLine = false; }
}

// Toggle auto-scroll with 's' key
screen.key(['s'], () => {
  autoScroll = !autoScroll;
  if (autoScroll) { try { logBox.setScrollPerc(100); } catch {} }
  updateFooter();
  screen.render();
});

// Every panel auto-scrolls to show its latest content on its own each refresh — not just the
// log. Manual scroll (mouse wheel, or arrow keys) on a panel disengages ITS auto-follow so a
// live update can't yank it back down mid-read (the "bouncing" bug); scrolling back down to
// the bottom manually re-arms it.
const ALL_PANELS = [logBox, systemBox, servicesBox, sessionsBox, providersBox, usersBox, historyBox, pm2Box, networkBox, peopleBox, machinesBox, integrationsBox];
const _manualScroll = new Set();
function autoBottom(panel) {
  if (_manualScroll.has(panel)) return;
  try { panel.setScrollPerc(100); } catch {}
}
for (const panel of ALL_PANELS) {
  panel.on('wheelup', () => {
    _manualScroll.add(panel);
    if (panel === logBox && autoScroll) { autoScroll = false; updateFooter(); }
    screen.render();
  });
  panel.on('wheeldown', () => {
    try { if (panel.getScrollPerc() >= 100) _manualScroll.delete(panel); } catch {}
    screen.render();
  });
}
screen.key(['up', 'down', 'pageup', 'pagedown'], (ch, key) => {
  const panel = screen.focused;
  if (panel && ALL_PANELS.includes(panel)) {
    _manualScroll.add(panel);
    if (panel === logBox && autoScroll) { autoScroll = false; updateFooter(); }
    // blessed.list panels (keys:true, vi:true) already move their own selection on
    // up/down — only drive .scroll() ourselves for the plain box/log panels, and for
    // page keys everywhere (paging isn't handled by list's built-in nav).
    const isList = typeof panel.down === 'function' && typeof panel.select === 'function' && panel.type === 'list';
    const amount = (key.name === 'pageup' || key.name === 'pagedown') ? SCROLL_SPEED * 5 : SCROLL_SPEED;
    if (!isList || key.name === 'pageup' || key.name === 'pagedown') {
      const dir = (key.name === 'up' || key.name === 'pageup') ? -1 : 1;
      try { panel.scroll(dir * amount); } catch {}
    }
  }
  screen.render();
});

// Speed button — '+' steps scroll speed up, '-' steps it down, cycling through SCROLL_SPEEDS.
screen.key(['+', '='], () => {
  _scrollSpeedIdx = Math.min(_scrollSpeedIdx + 1, SCROLL_SPEEDS.length - 1);
  SCROLL_SPEED = SCROLL_SPEEDS[_scrollSpeedIdx];
  updateFooter();
  screen.render();
});
screen.key(['-', '_'], () => {
  _scrollSpeedIdx = Math.max(_scrollSpeedIdx - 1, 0);
  SCROLL_SPEED = SCROLL_SPEEDS[_scrollSpeedIdx];
  updateFooter();
  screen.render();
});

function updateFooter() {
  const scrollLabel = autoScroll ? '{green-fg}● auto{/{green-fg}' : '{red-fg}○ manual{/{red-fg}';
  footer.setContent(`{center}{${C.fgSubtle}}q:quit │ r:refresh │ s:toggle-scroll │ +/-:speed │ 1-9:jump │ ${scrollLabel} │ ${REFRESH_MS}ms │ scroll:${SCROLL_SPEED}x │ log:${MAX_LOG_LINES}{/${C.fgSubtle}}{/center}`);
}

const footer = blessed.box({ bottom:0, left:0, width:'100%', height:1,
  content:`{center}{${C.fgSubtle}}q:quit │ r:refresh │ ↑↓:scroll │ +/-:speed │ enter:restart(pm2) │ 1-9:jump │ auto-scroll:on │ ${REFRESH_MS}ms │ scroll:${SCROLL_SPEED}x │ log:${MAX_LOG_LINES}{/${C.fgSubtle}}{/center}`,
  tags:true, style:{bg:C.bgSubtle, fg:C.fgMuted} });

// ── Renderers ─────────────────────────────────────────────────────
function renderSystem() {
  if (!dashData) { systemBox.setContent(`{center}{${C.mustard}}⏳ Connecting...{/${C.mustard}}{/center}`); return; }
  const s = dashData.system || {};
  const mc = machineCtx || {};
  const memPct = s.totalMem ? ((s.totalMem - s.freeMem) / s.totalMem * 100) : 0;
  const lines = [];
  // OS line
  if (mc.os) {
    lines.push(`{${C.fgMuted}}┌─{/} {bold}{${C.info}}OS{/bold}{/${C.info}}      {${C.fg}}${mc.os.name||'?'} {${C.fgSubtle}}${mc.os.version||''}{/${C.fgSubtle}}`);
  } else {
    lines.push(`{${C.fgMuted}}┌─{/} {bold}{${C.info}}Host{/bold}{/${C.info}}    {${C.fg}}${s.hostname||'?'}{/} {${C.fgSubtle}}${s.platform||''} ${s.arch||''}{/${C.fgSubtle}}`);
  }
  lines.push(`{${C.fgMuted}}├─{/} {bold}{${C.info}}Uptime{/bold}{/${C.info}}  {${C.fg}}${fmtUptime(s.uptime||0)}{/}`);
  // CPU line with model from machine-context
  const cpuModel = mc.cpu?.model || `${s.cpus||'?'} cores`;
  const cpuShort = cpuModel.length > 32 ? cpuModel.substring(0,30)+'…' : cpuModel;
  lines.push(`{${C.fgMuted}}├─{/} {bold}{${C.info}}CPU{/bold}{/${C.info}}     {${C.fg}}${cpuShort}{/${C.fg}} {${C.fgSubtle}}(${mc.cpu?.cores||s.cpus||'?'}c){/${C.fgSubtle}}`);
  // CPU temps from machine-context
  if (mc.cpu?.temps?.length > 0) {
    const avgTemp = mc.cpu.temps.reduce((a,b) => a+b, 0) / mc.cpu.temps.length;
    const tc = avgTemp > 80 ? C.error : avgTemp > 65 ? C.mustard : C.success;
    lines.push(`{${C.fgMuted}}├─{/} {bold}{${C.info}}Temp{/bold}{/${C.info}}    {${tc}}${avgTemp.toFixed(0)}°C{/${tc}} {${C.fgSubtle}}(${mc.cpu.temps.map(t=>t.toFixed(0)+'°C').join(', ')}){/${C.fgSubtle}}`);
  }
  lines.push(`{${C.fgMuted}}├─{/} {bold}{${C.info}}Memory{/bold}{/${C.info}}  ${bar(memPct,18)} {${C.fg}}${fmtBytes(s.totalMem-s.freeMem)}/${fmtBytes(s.totalMem)}{/${C.fg}} {${C.fgSubtle}}${memPct.toFixed(1)}%{/${C.fgSubtle}}`);
  // Load from machine-context or fallback
  try {
    const load1 = mc.cpu?.load1 ?? parseFloat(execSync('cat /proc/loadavg 2>/dev/null', {encoding:'utf8'}).trim().split(' ')[0]);
    const load5 = mc.cpu?.load5 ?? load1;
    const load15 = mc.cpu?.load15 ?? load1;
    const cores = mc.cpu?.cores || s.cpus || 4;
    const lp = Math.min(100, (load1 / cores) * 100);
    const lc = lp > 80 ? C.error : lp > 50 ? C.mustard : C.success;
    lines.push(`{${C.fgMuted}}├─{/} {bold}{${C.info}}Load{/bold}{/${C.info}}    ${bar(lp,18,lc)} {${C.fg}}${load1.toFixed(1)} ${load5.toFixed(1)} ${load15.toFixed(1)}{/}`);
  } catch {}
  // Disk
  try {
    const df = execSync("df -h / 2>/dev/null | awk 'NR==2{print $3,$5}'", {encoding:'utf8'}).trim();
    const [used,pct] = df.split(/\s+/); const dp = parseInt(pct,10)||0;
    const dc = dp > 90 ? C.error : dp > 75 ? C.mustard : C.success;
    lines.push(`{${C.fgMuted}}├─{/} {bold}{${C.info}}Disk{/bold}{/${C.info}}    ${bar(dp,18,dc)} {${C.fg}}${used} (${pct}){/${C.fg}}`);
  } catch {}
  // GPU from machine-context
  if (mc.gpu) {
    const gpuShort = mc.gpu.length > 35 ? mc.gpu.substring(0,33)+'…' : mc.gpu;
    lines.push(`{${C.fgMuted}}├─{/} {bold}{${C.info}}GPU{/bold}{/${C.info}}    {${C.fgSubtle}}${gpuShort}{/${C.fgSubtle}}`);
  }
  // Runtime from machine-context
  if (mc.runtime) {
    const rt = mc.runtime;
    const parts = [];
    if (rt.node) parts.push(`Node ${rt.node}`);
    if (rt.python) parts.push(rt.python.replace('Python ','Py3.'));
    if (rt.npm) parts.push(`npm ${rt.npm}`);
    if (rt.git) parts.push(`git ${rt.git.replace('git version ','')}`);
    if (parts.length) lines.push(`{${C.fgMuted}}└─{/} {bold}{${C.info}}Runtime{/bold} {${C.fgSubtle}}${parts.join(' │ ')}{/${C.fgSubtle}}`);
  }
  lines.push(`{center}{${C.fgSubtle}}${connected?'●':'×'} ${connected?'Connected':'Offline'}{/${C.fgSubtle}}{/center}`);
  systemBox.setContent(lines.join('\n')); autoBottom(systemBox);
}

function renderServices() {
  if (!dashData?.services) { servicesBox.setItems([`{${C.mustard}}⏳ Loading...{/}`]); return; }
  servicesBox.setItems(dashData.services.map(s => {
    const p = `{${C.info}}${padFit(s.port, 6)}{/${C.info}}`;
    const n = `{${C.fg}}${padFit(s.name||'?', 16)}{/${C.fg}}`;
    const pr = `{${C.fgSubtle}}${padFit(s.process||'', 12)}{/${C.fgSubtle}}`;
    return `${dot(s.status)} ${p}${n}${pr}`;
  }));
  autoBottom(servicesBox);
}

function renderSessions() {
  if (!dashData) { sessionsBox.setContent(`{center}{${C.mustard}}⏳ Loading...{/${C.mustard}}{/center}`); return; }
  const r = dashData.requests||{}, sess = dashData.sessions||{};
  const lines = [];
  lines.push(`{bold}{${C.info}}Requests{/bold}{/${C.info}} {${C.fg}}${r.total||0}{/${C.fg}}`);
  lines.push(`{bold}{${C.info}}Tokens{/bold}{/${C.info}}  {${C.fg}}${fmtBytes(r.totalTokens||0)}{/${C.fg}}`);
  lines.push(`{bold}{${C.info}}Cost{/bold}{/${C.info}}     {${C.success}}$${(r.totalCost||0).toFixed(4)}{/${C.success}}`);
  lines.push(`{${C.bgSubtle}}───────────────────────{/${C.bgSubtle}}`);
  lines.push(`{bold}{${C.info}}Sessions{/bold}{/${C.info}} {${C.fg}}${sess.total||0}{/${C.fg}} {${C.fgMuted}}│{/} {bold}{${C.info}}Active{/bold}{/${C.info}} {${C.success}}${sess.active||0}{/${C.success}}`);
  lines.push(`{bold}{${C.info}}Msgs{/bold}{/${C.info}}     {${C.fg}}${sess.messages||0}{/${C.fg}}`);
  sessionsBox.setContent(lines.join('\n')); autoBottom(sessionsBox);
}

function renderProviders() {
  if (!dashData) { providersBox.setContent(`{center}{${C.mustard}}⏳ Loading...{/${C.mustard}}{/center}`); return; }
  const r = dashData.requests||{};
  const prov = r.byProvider || [];
  const lines = [];
  if (prov.length > 0) {
    const maxR = Math.max(...prov.map(p=>p.requests),1);
    for (const p of prov) {
      const pct = p.requests/maxR*100;
      const nm = padFit(p.provider||'?', 12);
      const tk = fmtBytes((p.inputTokens||0)+(p.outputTokens||0));
      lines.push(`{bold}{${C.secondary}}${nm}{/bold}{/${C.secondary}} ${bar(pct,14)} {${C.fg}}${p.requests}req{/${C.fg}} {${C.fgMuted}}${tk}{/${C.fgMuted}}`);
    }
  } else {
    lines.push(`{${C.fgSubtle}}No provider data{/${C.fgSubtle}}`);
  }
  const crush = dashData.crush||{};
  if (crush.stats) {
    const cs = crush.stats;
    lines.push(`{${C.bgSubtle}}─────────────────────────{/${C.bgSubtle}}`);
    lines.push(`{bold}{${C.accent}}Crush{/bold}{/${C.accent}} {${C.fg}}${crush.model||'?'}{/${C.fg}}`);
    lines.push(`{${C.fg}}${cs.toolCalls||0} tools{/${C.fg}} {${C.fgMuted}}│{/} {${C.fg}}${cs.reasoningSteps||0} reasoning{/${C.fg}}`);
  }
  providersBox.setContent(lines.join('\n')); autoBottom(providersBox);
}

function renderUsers() {
  if (!usersData) { usersBox.setItems([`{${C.mustard}}⏳ Loading...{/${C.mustard}}`]); return; }
  const items = [];
  if (usersData.users && usersData.users.length > 0) {
    for (const u of usersData.users.slice(0, 5)) {
      const st = u.status === 'active' ? C.success : u.status === 'suspended' ? C.mustard : C.error;
      items.push(`${dot(u.status)} {bold}{${C.fg}}${padFit(u.username||'?', 10)}{/bold}{/${C.fg}} {${st}}${u.role}{/${st}} {${C.fgSubtle}}${u.plan}{/${C.fgSubtle}}`);
    }
  }
  // Recent requests summary
  if (recentRequests && recentRequests.length > 0) {
    items.push(`{${C.bgSubtle}}───────────────────────────{/${C.bgSubtle}}`);
    items.push(`{bold}{${C.info}}Recent Requests{/bold}{/${C.info}}`);
    for (const r of recentRequests.slice(0, 4)) {
      const st = r.status === 'ok' ? C.success : C.error;
      const ago = r.created_at ? fmtUptime(Date.now()/1000 - r.created_at) : '?';
      items.push(`{${st}}${r.status==='ok'?'✓':'✗'}{/${st}} {${C.fg}}${padFit(r.provider||'?', 8)}{/${C.fg}} {${C.fgSubtle}}${padFit(r.model||'', 16)}{/${C.fgSubtle}} {${C.fgMuted}}${ago}{/${C.fgMuted}}`);
    }
  }
  if (items.length === 0) items.push(`{${C.fgSubtle}}No data yet{/${C.fgSubtle}}`);
  usersBox.setItems(items); autoBottom(usersBox);
}

function renderPeople() {
  if (!peopleData) { peopleBox.setItems([`{${C.mustard}}⏳ Loading...{/${C.mustard}}`]); return; }
  const items = [];
  const people = peopleData.people || [];
  if (people.length === 0) { peopleBox.setItems([`{${C.fgSubtle}}No people yet{/${C.fgSubtle}}`]); return; }
  for (const p of people.slice(0, 12)) {
    const st = p.status === 'active' ? C.success : p.status === 'suspended' ? C.mustard : C.error;
    const role = padFit(p.role || '?', 6);
    const plan = `{${C.info}}${padFit(p.plan || '?', 8)}{/${C.info}}`;
    const ago = p.last_login_at ? fmtUptime(Date.now()/1000 - p.last_login_at) : '?';
    items.push(`${dot(p.status)} {bold}{${C.fg}}${padFit(p.username||'?', 10)}{/bold}{/${C.fg}} {${st}}${role}{/${st}} ${plan} {${C.fgMuted}}${ago}{/${C.fgMuted}}`);
  }
  peopleBox.setItems(items); autoBottom(peopleBox);
}

function renderMachines() {
  if (!machinesData) { machinesBox.setItems([`{${C.mustard}}⏳ Loading...{/${C.mustard}}`]); return; }
  const items = [];
  const server = machinesData.server || {};
  if (server.os || server.cpu) {
    const os = `${server.os?.name || ''} ${server.os?.version || ''}`.trim() || 'server';
    const cpu = server.cpu?.model || `${server.cpu?.cores || '?'} cores`;
    const short = cpu.length > 28 ? cpu.substring(0,26)+'…' : cpu;
    items.push(`{${C.success}}● {bold}{${C.info}}SERVER{/bold}{/${C.info}} {${C.fg}}${padFit(os, 12)}{/${C.fg}} {${C.fgSubtle}}${short}{/${C.fgSubtle}}`);
  }
  const clients = machinesData.clients || [];
  if (clients.length > 0) {
    items.push(`{${C.bgSubtle}}───────────────────────────{/${C.bgSubtle}}`);
    items.push(`{bold}{${C.secondary}}📱 Client Machines{/bold}{/${C.secondary}}`);
  }
  for (const d of clients.slice(0, 12)) {
    const icon = d.device_type === 'tablet' ? '📱' : d.device_type === 'mobile' ? '📲' : '🖥️';
    const os = [d.os_name, d.os_version].filter(Boolean).join(' ') || d.platform || '?';
    const br = [d.browser, d.browser_version].filter(Boolean).join(' ') || '?';
    const ago = d.updated_at ? fmtUptime(Date.now()/1000 - d.updated_at) : '?';
    const res = d.screen_width && d.screen_height ? `{${C.fgSubtle}}${d.screen_width}×${d.screen_height}{/${C.fgSubtle}}` : '';
    items.push(`${icon} {${C.fg}}${padFit(os, 14)}{/${C.fg}} {${C.info}}${padFit(br, 12)}{/${C.info}} ${res} {${C.fgMuted}}${ago}{/${C.fgMuted}}`);
  }
  if (items.length === 0) items.push(`{${C.fgSubtle}}No machines yet{/${C.fgSubtle}}`);
  machinesBox.setItems(items); autoBottom(machinesBox);
}

function renderIntegrations() {
  if (!integrationsBox) return;
  // Firecrawl status is fetched lazily once; not on main poll to avoid leaking keys.
  httpGet(`${API_BASE}/api/integrations`).then(data => {
    const lines = [];
    const fc = (data || {}).firecrawl || {};
    const fcColor = fc.configured ? C.success : C.error;
    lines.push(`{bold}{${C.info}}Firecrawl{/${C.info}}{/bold}`);
    lines.push(`{${fcColor}}${fc.configured ? '●' : '○'} ${fc.key_count || 0} keys loaded{/${fcColor}}`);
    integrationsBox.setContent(lines.join('\n'));
    autoBottom(integrationsBox);
  }).catch(() => {
    integrationsBox.setContent(`{${C.error}}○ integrations offline{/${C.error}}`);
  });
}
function renderHistory() {
  if (history.cpu.length < 2) { historyBox.setContent(`{center}{${C.fgSubtle}}Collecting data...{/${C.fgSubtle}}{/center}`); return; }
  const w = 35;
  const lines = [];
  const lastCpu = history.cpu[history.cpu.length-1]||0;
  lines.push(`{bold}{${C.info}}CPU{/bold}{/${C.info}}  ${bar(lastCpu,10,C.coral)} {${C.fgSubtle}}${lastCpu.toFixed(1)}%{/${C.fgSubtle}}`);
  lines.push(sparkline(history.cpu, w, 2, C.coral));
  lines.push('');
  const lastMem = history.mem[history.mem.length-1]||0;
  lines.push(`{bold}{${C.mustard}}MEM{/bold}{/${C.mustard}}  ${bar(lastMem,10,C.mustard)} {${C.fgSubtle}}${lastMem.toFixed(1)}%{/${C.fgSubtle}}`);
  lines.push(sparkline(history.mem, w, 2, C.mustard));
  // Request deltas
  const deltas = [];
  for (let i=1;i<history.reqs.length;i++) deltas.push(Math.max(0,history.reqs[i]-history.reqs[i-1]));
  if (deltas.length > 0) {
    const ld = deltas[deltas.length-1]||0;
    lines.push('');
    lines.push(`{bold}{${C.success}}REQ{/bold}{/${C.success}}  {${C.fgSubtle}}+${ld}/tick{/${C.fgSubtle}}`);
    lines.push(sparkline(deltas, w, 2, C.success));
  }
  historyBox.setContent(lines.join('\n')); autoBottom(historyBox);
}

function renderPM2() {
  const items = (pm2Data||[]).map(p => {
    const name = p.name||'?';
    const hung = isPm2Hung(name);
    const nm = padFit(name, 14);
    const st = p.pm2_env?.status||p.status||'?';
    const cpuVal = p.monit?.cpu??0;
    const cpuColor = hung ? C.error : C.fgMuted;
    const cpu = `{${cpuColor}}${cpuVal.toFixed(1).padStart(5)}%{/${cpuColor}}`;
    const mem = `{${C.fg}}${fmtBytes(p.monit?.memory??0).padStart(8)}{/${C.fg}}`;
    const rst = p.pm2_env?.restart_time??0;
    const rc = rst>5?C.error:rst>0?C.mustard:C.fgSubtle;
    const up = p.pm2_env?.pm_uptime ? fmtUptime((Date.now()-p.pm2_env.pm_uptime)/1000) : '?';
    const flag = hung ? ` {${C.error}}{bold}⚠ HUNG?{/bold}{/${C.error}}` : '';
    return `${dot(st)} {bold}{${C.fg}}${nm}{/bold}{/${C.fg}} ${cpu} ${mem} {${rc}}rst:${String(rst).padStart(2)}{/${rc}} {${C.info}}${String(up).padStart(8)}{/${C.info}}${flag}`;
  });
  pm2Box.setItems(items.length>0?items:[`{${C.fgSubtle}}No PM2 processes{/${C.fgSubtle}}`]); autoBottom(pm2Box);
}

function renderNetwork() {
  const knownSvcs = {22:'SSH',80:'Apache',3579:'haksterAi',4040:'ngrok',8081:'CineVault',8888:'StalkerHEK',9999:'StalkerSSL',11434:'Ollama',20241:'cloudflared'};
  const hidden = new Set(['systemd-resolve','cupsd','containerd','obfs4proxy','tor']);
  const ports = [];
  try {
    const out = execSync("ss -tlnp 2>/dev/null | awk 'NR>1'", {encoding:'utf8',timeout:3000});
    for (const line of out.split('\n').filter(Boolean)) {
      const m = line.match(/[:](\d+)\s.*?"([^"]+)"/);
      if (m) { const proc=m[2].split('/').pop()||'?'; if(!hidden.has(proc)) ports.push({port:parseInt(m[1],10),proc}); }
      else { const m2=line.match(/[:](\d+)\s/); if(m2) ports.push({port:parseInt(m2[1],10),proc:line.split(/\s+/).pop()||'?'}); }
    }
    ports.sort((a,b)=>a.port-b.port);
  } catch {}
  networkBox.setItems(ports.length>0 ? ports.map(p=>{
    const nm = knownSvcs[p.port]||p.proc;
    return `{${C.success}}●{/${C.success}} {${C.info}}${padFit(p.port, 6)}{/${C.info}} {${C.fg}}${padFit(nm, 16)}{/${C.fg}} {${C.fgSubtle}}${padFit(p.proc, 14)}{/${C.fgSubtle}}`;
  }) : [`{${C.fgSubtle}}No ports found{/${C.fgSubtle}}`]);
  autoBottom(networkBox);
}

function logAgentActivity() {
  if (!dashData) return;
  const r=dashData.requests||{}, sess=dashData.sessions||{};
  const now = new Date().toLocaleTimeString();
  const h = `${r.total}|${r.totalTokens}|${sess.active}|${dashData.services?.length}`;
  if (h === _lastLogHash) return;
  _lastLogHash = h;

  let change = '';
  if (lastDashData) {
    const pr = lastDashData.requests||{};
    const nr = (r.total||0)-(pr.total||0);
    const nt = (r.totalTokens||0)-(pr.totalTokens||0);
    if (nr>0) change = ` {${C.success}}+${nr}req{/${C.success}}`;
    if (nt>0) change += ` {${C.accent}}+${fmtBytes(nt)}tok{/${C.accent}}`;
  }
  lastDashData = JSON.parse(JSON.stringify(dashData));
  logBox.log(`{${C.fgSubtle}}[${now}]{/${C.fgSubtle}} {${C.primary}}◆{/} {${C.fg}}reqs:${r.total||0}{/${C.fg}} {${C.fgMuted}}│{/} {${C.fg}}tok:${fmtBytes(r.totalTokens||0)}{/${C.fg}} {${C.fgMuted}}│{/} {${C.success}}ses:${sess.active||0}{/${C.success}} {${C.fgMuted}}│{/} {${C.fg}}${(dashData.services||[]).length}svc{/${C.fg}}${change}`);
}

// ── Keys ───────────────────────────────────────────────────────────
screen.key(['r'], async () => { logBox.log(`{${C.mustard}}⟳ Refresh...{/${C.mustard}}`); await fetchAll(); renderAll(); logBox.log(`{${C.success}}✓ Refreshed{/${C.success}}`); });
screen.key(['1'], () => { systemBox.focus(); screen.render(); });
screen.key(['2'], () => { servicesBox.focus(); screen.render(); });
screen.key(['3'], () => { sessionsBox.focus(); screen.render(); });
screen.key(['4'], () => { pm2Box.focus(); screen.render(); });
screen.key(['5'], () => { logBox.focus(); screen.render(); });
screen.key(['6'], () => { usersBox.focus(); screen.render(); });
screen.key(['7'], () => { peopleBox.focus(); screen.render(); });
screen.key(['8'], () => { machinesBox.focus(); screen.render(); });
screen.key(['9'], () => { integrationsBox.focus(); screen.render(); });
screen.key(['enter'], () => {
  if (screen.focused === pm2Box && pm2Box.selected < pm2Data.length) {
    const proc = pm2Data[pm2Box.selected];
    if (proc?.name) {
      logBox.log(`{${C.mustard}}⟳ Restarting ${proc.name}...{/${C.mustard}}`);
      try { execSync(`pm2 restart ${proc.name} 2>/dev/null`, {encoding:'utf8',timeout:10000}); logBox.log(`{${C.success}}✓ Restarted ${proc.name}{/${C.success}}`); }
      catch(e) { logBox.log(`{${C.error}}✗ Failed: ${e.message}{/${C.error}}`); }
    }
  }
});

function renderAll() {
  try { renderSystem(); renderServices(); renderSessions(); renderProviders(); renderUsers(); renderHistory(); renderPM2(); renderNetwork(); renderPeople(); renderMachines(); renderIntegrations(); logAgentActivity(); screen.render(); } catch {}
}

// ── Attach ─────────────────────────────────────────────────────────
screen.append(header); screen.append(systemBox); screen.append(servicesBox);
screen.append(sessionsBox); screen.append(providersBox); screen.append(usersBox); screen.append(historyBox); screen.append(pm2Box);
screen.append(networkBox); screen.append(peopleBox); screen.append(machinesBox); screen.append(integrationsBox); screen.append(logBox); screen.append(footer);

logBox.log(`{${C.primary}}◆{/} {bold}{${C.fg}}haksterAi TUI v4{/bold}{/${C.fg}} {${C.fgMuted}}started{/${C.fgMuted}} {${C.fgSubtle}}│ ${REFRESH_MS}ms │ scroll:${SCROLL_SPEED} │ log:${MAX_LOG_LINES} │ ${API_BASE}{/${C.fgSubtle}}`);
logBox.log(`{${C.fgSubtle}}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━{/${C.fgSubtle}}`);
logBox.log(`{${C.fgMuted}}Panels: SYSTEM │ SERVICES │ SESSIONS │ PROVIDERS │ USERS │ HISTORY │ PM2 │ NETWORK │ PEOPLE │ MACHINES │ INTG │ LOG{/${C.fgMuted}}`);
logBox.log(`{${C.fgMuted}}Keys: 1-9 jump │ r refresh │ s scroll-lock │ enter restart(pm2) │ q quit{/${C.fgMuted}}`);
logBox.log(`{${C.fgMuted}}WS: Live agent events + notification queue polling{/${C.fgMuted}}`);

(async () => {
  await fetchAll();
  renderAll();
  wsConnect();
  setInterval(async () => { await fetchAll(); renderAll(); }, REFRESH_MS);
  setInterval(async () => { await pollNotifications(); }, 5000);
})().catch(e => logBox.log(`{${C.error}}✗ Fatal: ${e.message}{/${C.error}}`));

screen.render();