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

// ── Config ────────────────────────────────────────────────────────
const REFRESH_MS = parseInt(process.env.REFRESH_MS || '2000', 10);
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

// ── WebSocket connection ──────────────────────────────────────────
const WS_BASE = API_BASE.replace(/^http/, 'ws');

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

function handleWSEvent(msg) {
  const t = msg.type || 'unknown';
  const ts = new Date().toLocaleTimeString();

  // Agent/tool events from streaming
  if (t === 'tool_call_start') {
    const tool = msg.tool_name || '?';
    logBox.log(`{${C.mustard}}⚡{/${C.mustard}} {${C.fg}}${ts}{/${C.fg}} {${C.accent}}TOOL{/${C.accent}} {bold}${tool}{/bold} {${C.fgSubtle}}started{/${C.fgSubtle}}`);
  } else if (t === 'tool_call_result') {
    const tool = msg.tool_name || '?';
    const result = (msg.tool_result || '').substring(0, 80).replace(/\n/g, ' ');
    const color = result.length > 0 ? C.success : C.error;
    logBox.log(`{${C.success}}✓{/${C.success}} {${C.fg}}${ts}{/${C.fg}} {${C.accent}}TOOL{/${C.accent}} {bold}${tool}{/bold} {${C.fgSubtle}}→{/${C.fgSubtle}} {${color}}${result}{/${color}}`);
  } else if (t === 'thinking_start') {
    logBox.log(`{${C.secondary}}🧠{/${C.secondary}} {${C.fg}}${ts}{/${C.fg}} {${C.secondary}}THINKING{/${C.secondary}} {${C.fgSubtle}}started{/${C.fgSubtle}}`);
  } else if (t === 'thinking') {
    const snippet = (msg.content || '').substring(0, 120).replace(/\n/g, ' ');
    logBox.log(`{${C.secondary}}  {/${C.secondary}} {${C.fgSubtle}}${snippet}{/${C.fgSubtle}}`);
  } else if (t === 'thinking_end') {
    logBox.log(`{${C.secondary}}🧠{/${C.secondary}} {${C.fg}}${ts}{/${C.fg}} {${C.secondary}}THINKING{/${C.secondary}} {${C.fgSubtle}}done{/${C.fgSubtle}}`);
  } else if (t === 'chat_result') {
    const model = msg.model || '?';
    const tokens = (msg.inputTokens || 0) + (msg.outputTokens || 0);
    logBox.log(`{${C.primary}}◆{/${C.primary}} {${C.fg}}${ts}{/${C.fg}} {${C.success}}CHAT{/${C.success}} {${C.fg}}${model}{/${C.fg}} {${C.fgMuted}}│{/${C.fgMuted}} {${C.fg}}${fmtBytes(tokens)} tok{/${C.fg}}`);
  } else if (t === 'notification') {
    const ntype = msg.type || 'notify';
    const icon = ntype === 'error' ? `{${C.error}}✗{/${C.error}}` : ntype === 'warn' ? `{${C.mustard}}⚠{/${C.mustard}}` : `{${C.info}}ℹ{/${C.info}}`;
    logBox.log(`${icon} {${C.fg}}${ts}{/${C.fg}} {bold}${msg.msg || msg.message || 'notification'}{/bold}`);
  } else if (t === 'done') {
    logBox.log(`{${C.success}}✓{/${C.success}} {${C.fg}}${ts}{/${C.fg}} {${C.fgSubtle}}Agent done {${msg.model || ''} ${msg.provider || ''}{/${C.fgSubtle}}`);
  } else if (t === 'error') {
    logBox.log(`{${C.error}}✗{/${C.error}} {${C.fg}}${ts}{/${C.fg}} {${C.error}}${msg.error || 'WS error'}{/${C.error}}`);
  } else if (t === 'heartbeat') {
    // Silently ignore heartbeats
  } else if (t === 'loop_detected') {
    logBox.log(`{${C.mustard}}⚠{/${C.mustard}} {${C.fg}}${ts}{/${C.fg}} {${C.mustard}}LOOP {${msg.reason || ''}{/${C.mustard}} {${C.fgSubtle}}${msg.message || ''}{/${C.fgSubtle}}`);
  } else if (t !== 'unknown') {
    // Catch-all for any other event types
    const label = String(t).substring(0, 16);
    const content = JSON.stringify(msg).substring(0, 100);
    logBox.log(`{${C.fgSubtle}}${ts} {${C.fgMuted}}${label}{/${C.fgMuted}} ${content}{/${C.fgSubtle}}`);
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
}

// ── Formatting ───────────────────────────────────────────────────
const fmtBytes = b => b < 1024 ? `${b}B` : b < 1048576 ? `${(b/1024).toFixed(1)}KB` : b < 1073741824 ? `${(b/1048576).toFixed(1)}MB` : `${(b/1073741824).toFixed(1)}GB`;
const fmtUptime = s => { const d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60); return d>0?`${d}d ${h}h ${m}m`:h>0?`${h}h ${m}m`:`${m}m`; };
const bar = (pct, w, fc=C.primary, ec=C.fgSubtle) => { const f=Math.round(Math.min(100,Math.max(0,pct))/100*w); return `{${fc}}${'█'.repeat(f)}{/${fc}}{${ec}}${'░'.repeat(w-f)}{/${ec}}`; };
const dot = s => s==='running'||s==='online'?`{${C.success}}●{/${C.success}}`:s==='stopped'||s==='errored'?`{${C.error}}●{/${C.error}}`:`{${C.mustard}}●{/${C.mustard}}`;

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
const screen = blessed.screen({ smartCSR: true, title: 'haksterAi TUI', fullUnicode: true, dockBorders: true });
screen.key(['escape', 'q', 'C-c'], () => process.exit(0));

// ── Panels ─────────────────────────────────────────────────────────
const bdrStyle = (label) => ({ border: { fg: C.primary }, bg: C.bg, fg: C.fg, label: { fg: C.accent } });

const header = blessed.box({ top:0, left:0, width:'100%', height:1,
  content: `{center}{bold}{${C.primary}}◆{/bold}{/${C.primary}} {bold}{${C.fg}}haksterAi{/bold}{/${C.fg}} {${C.fgMuted}}TUI v3{/} {${C.fgSubtle}}│{/} {${C.success}}●{/${C.success}} {${C.fgSubtle}}WS{/} {${C.fgSubtle}}│{/} {${C.fgMuted}}1-5:jump r:↻{/}{/${C.fgSubtle}}{/center}`,
  tags: true, style: { bg: C.bgSubtle, fg: C.fg } });

function updateHeader() {
  const wsIcon = wsConnected ? `{${C.success}}●{/${C.success}}` : `{${C.error}}○{/${C.error}}`;
  const wsLabel = wsConnected ? 'WS' : 'offline';
  header.setContent(`{center}{bold}{${C.primary}}◆{/bold}{/${C.primary}} {bold}{${C.fg}}haksterAi{/bold}{/${C.fg}} {${C.fgMuted}}TUI v4{/} {${C.fgSubtle}}│{/} ${wsIcon} {${C.fgSubtle}}${wsLabel}{/${C.fgSubtle}} {${C.fgSubtle}}│{/} {${C.fgMuted}}1-6:jump r:↻{/}{/${C.fgSubtle}}{/center}`);
  try { screen.render(); } catch {}
}

const systemBox = blessed.box({ top:1, left:0, width:'50%', height:11,
  label:` {${C.primary}}◆{/} SYSTEM `, border:{type:'line'}, style:bdrStyle(), tags:true, scrollable:true });

const servicesBox = blessed.list({ top:1, left:'50%', width:'50%', height:11,
  label:` {${C.primary}}◆{/} SERVICES `, border:{type:'line'}, style:{...bdrStyle(), selected:{bg:C.bgSubtle}}, tags:true, scrollable:true, keys:true, vi:true });

const sessionsBox = blessed.box({ top:12, left:0, width:'33%', height:10,
  label:` {${C.primary}}◆{/} SESSIONS `, border:{type:'line'}, style:bdrStyle(), tags:true, scrollable:true });

const providersBox = blessed.box({ top:12, left:'33%', width:'34%', height:10,
  label:` {${C.primary}}◆{/} PROVIDERS `, border:{type:'line'}, style:bdrStyle(), tags:true, scrollable:true });

const usersBox = blessed.list({ top:12, left:'67%', width:'33%', height:10,
  label:` {${C.primary}}◆{/} USERS & LOGS `, border:{type:'line'}, style:{...bdrStyle(), selected:{bg:C.bgSubtle}}, tags:true, scrollable:true, keys:true, vi:true });

const historyBox = blessed.box({ top:22, left:'50%', width:'50%', height:9,
  label:` {${C.primary}}◆{/} HISTORY `, border:{type:'line'}, style:bdrStyle(), tags:true, scrollable:true });

const pm2Box = blessed.list({ top:22, left:0, width:'50%', height:9,
  label:` {${C.primary}}◆{/} PM2 {${C.fgSubtle}}enter:restart{/${C.fgSubtle}} `, border:{type:'line'}, style:{...bdrStyle(), selected:{bg:C.bgSubtle}}, tags:true, scrollable:true, keys:true, vi:true });

const networkBox = blessed.list({ top:22, left:'50%', width:'50%', height:9,
  label:` {${C.primary}}◆{/} NETWORK `, border:{type:'line'}, style:{...bdrStyle(), selected:{bg:C.bgSubtle}}, tags:true, scrollable:true, keys:true, vi:true });

const peopleBox = blessed.list({ top:31, left:0, width:'33%', height:'100%-33',
  label:` {${C.primary}}◆{/} PEOPLE `, border:{type:'line'}, style:{...bdrStyle(), selected:{bg:C.bgSubtle}}, tags:true, scrollable:true, keys:true, vi:true });

const machinesBox = blessed.list({ top:31, left:'33%', width:'33%', height:'100%-33',
  label:` {${C.primary}}◆{/} MACHINES `, border:{type:'line'}, style:{...bdrStyle(), selected:{bg:C.bgSubtle}}, tags:true, scrollable:true, keys:true, vi:true });

const integrationsBox = blessed.box({ top:31, left:'66%', width:'34%', height:'100%-33',
  label:` {${C.primary}}◆{/} INTEGRATIONS `, border:{type:'line'}, style:bdrStyle(), tags:true, scrollable:true });

const logBox = blessed.log({ top:31, left:'66%', width:'34%', height:'100%-33',
  label:` {${C.primary}}◆{/} AGENT ACTIVITY `, border:{type:'line'}, style:bdrStyle(), tags:true, scrollable:true,
  alwaysScroll:true, scrollback:500,
  scrollbar:{ch:'█',style:{fg:C.primary}} });

// Auto-scroll: force logBox to bottom after every message
let autoScroll = true;
const _origLog = logBox.log.bind(logBox);
logBox.log = (...args) => { _origLog(...args); if (autoScroll) try { logBox.setScrollPerc(100); } catch {} };

// Toggle auto-scroll with 's' key
screen.key(['s'], () => {
  autoScroll = !autoScroll;
  if (autoScroll) { try { logBox.setScrollPerc(100); } catch {} }
  updateFooter();
  screen.render();
});

function updateFooter() {
  const scrollLabel = autoScroll ? '{green-fg}● auto{/{green-fg}' : '{red-fg}○ manual{/{red-fg}';
  footer.setContent(`{center}{${C.fgSubtle}}q:quit │ r:refresh │ s:toggle-scroll │ 1-9:jump │ ${scrollLabel} │ ${REFRESH_MS}ms{/${C.fgSubtle}}{/center}`);
}

const footer = blessed.box({ bottom:0, left:0, width:'100%', height:1,
  content:`{center}{${C.fgSubtle}}q:quit │ r:refresh │ ↑↓:scroll │ enter:restart(pm2) │ 1-9:jump │ auto-scroll:on │ ${REFRESH_MS}ms{/${C.fgSubtle}}{/center}`,
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
  systemBox.setContent(lines.join('\n'));
}

function renderServices() {
  if (!dashData?.services) { servicesBox.setItems([`{${C.mustard}}⏳ Loading...{/}`]); return; }
  servicesBox.setItems(dashData.services.map(s => {
    const p = `{${C.info}}${String(s.port).padEnd(6)}{/${C.info}}`;
    const n = `{${C.fg}}${(s.name||'?').padEnd(16)}{/${C.fg}}`;
    const pr = `{${C.fgSubtle}}${(s.process||'').padEnd(12)}{/${C.fgSubtle}}`;
    return `${dot(s.status)} ${p}${n}${pr}`;
  }));
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
  sessionsBox.setContent(lines.join('\n'));
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
      const nm = (p.provider||'?').padEnd(12);
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
  providersBox.setContent(lines.join('\n'));
}

function renderUsers() {
  if (!usersData) { usersBox.setItems([`{${C.mustard}}⏳ Loading...{/${C.mustard}}`]); return; }
  const items = [];
  if (usersData.users && usersData.users.length > 0) {
    for (const u of usersData.users.slice(0, 5)) {
      const st = u.status === 'active' ? C.success : u.status === 'suspended' ? C.mustard : C.error;
      items.push(`${dot(u.status)} {bold}{${C.fg}}${(u.username||'?').padEnd(10)}{/bold}{/${C.fg}} {${st}}${u.role}{/${st}} {${C.fgSubtle}}${u.plan}{/${C.fgSubtle}}`);
    }
  }
  // Recent requests summary
  if (recentRequests && recentRequests.length > 0) {
    items.push(`{${C.bgSubtle}}───────────────────────────{/${C.bgSubtle}}`);
    items.push(`{bold}{${C.info}}Recent Requests{/bold}{/${C.info}}`);
    for (const r of recentRequests.slice(0, 4)) {
      const st = r.status === 'ok' ? C.success : C.error;
      const ago = r.created_at ? fmtUptime(Date.now()/1000 - r.created_at) : '?';
      items.push(`{${st}}${r.status==='ok'?'✓':'✗'}{/${st}} {${C.fg}}${(r.provider||'?').padEnd(8)}{/${C.fg}} {${C.fgSubtle}}${(r.model||'').substring(0,16)}{/${C.fgSubtle}} {${C.fgMuted}}${ago}{/${C.fgMuted}}`);
    }
  }
  if (items.length === 0) items.push(`{${C.fgSubtle}}No data yet{/${C.fgSubtle}}`);
  usersBox.setItems(items);
}

function renderPeople() {
  if (!peopleData) { peopleBox.setItems([`{${C.mustard}}⏳ Loading...{/${C.mustard}}`]); return; }
  const items = [];
  const people = peopleData.people || [];
  if (people.length === 0) { peopleBox.setItems([`{${C.fgSubtle}}No people yet{/${C.fgSubtle}}`]); return; }
  for (const p of people.slice(0, 12)) {
    const st = p.status === 'active' ? C.success : p.status === 'suspended' ? C.mustard : C.error;
    const role = (p.role || '?').padEnd(6);
    const plan = `{${C.info}}${(p.plan || '?').padEnd(8)}{/${C.info}}`;
    const ago = p.last_login_at ? fmtUptime(Date.now()/1000 - p.last_login_at) : '?';
    items.push(`${dot(p.status)} {bold}{${C.fg}}${(p.username||'?').padEnd(10)}{/bold}{/${C.fg}} {${st}}${role}{/${st}} ${plan} {${C.fgMuted}}${ago}{/${C.fgMuted}}`);
  }
  peopleBox.setItems(items);
}

function renderMachines() {
  if (!machinesData) { machinesBox.setItems([`{${C.mustard}}⏳ Loading...{/${C.mustard}}`]); return; }
  const items = [];
  const server = machinesData.server || {};
  if (server.os || server.cpu) {
    const os = `${server.os?.name || ''} ${server.os?.version || ''}`.trim() || 'server';
    const cpu = server.cpu?.model || `${server.cpu?.cores || '?'} cores`;
    const short = cpu.length > 28 ? cpu.substring(0,26)+'…' : cpu;
    items.push(`{${C.success}}● {bold}{${C.info}}SERVER{/bold}{/${C.info}} {${C.fg}}${os.padEnd(12)}{/${C.fg}} {${C.fgSubtle}}${short}{/${C.fgSubtle}}`);
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
    items.push(`${icon} {${C.fg}}${os.padEnd(14)}{/${C.fg}} {${C.info}}${br.padEnd(12)}{/${C.info}} ${res} {${C.fgMuted}}${ago}{/${C.fgMuted}}`);
  }
  if (items.length === 0) items.push(`{${C.fgSubtle}}No machines yet{/${C.fgSubtle}}`);
  machinesBox.setItems(items);
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
  historyBox.setContent(lines.join('\n'));
}

function renderPM2() {
  const items = (pm2Data||[]).map(p => {
    const nm = (p.name||'?').padEnd(14);
    const st = p.pm2_env?.status||p.status||'?';
    const cpu = `{${C.fgMuted}}${(p.monit?.cpu??0).toFixed(1).padStart(5)}%{/${C.fgMuted}}`;
    const mem = `{${C.fg}}${fmtBytes(p.monit?.memory??0).padStart(8)}{/${C.fg}}`;
    const rst = p.pm2_env?.restart_time??0;
    const rc = rst>5?C.error:rst>0?C.mustard:C.fgSubtle;
    const up = p.pm2_env?.pm_uptime ? fmtUptime((Date.now()-p.pm2_env.pm_uptime)/1000) : '?';
    return `${dot(st)} {bold}{${C.fg}}${nm}{/bold}{/${C.fg}} ${cpu} ${mem} {${rc}}rst:${String(rst).padStart(2)}{/${rc}} {${C.info}}${String(up).padStart(8)}{/${C.info}}`;
  });
  pm2Box.setItems(items.length>0?items:[`{${C.fgSubtle}}No PM2 processes{/${C.fgSubtle}}`]);
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
    return `{${C.success}}●{/${C.success}} {${C.info}}${String(p.port).padEnd(6)}{/${C.info}} {${C.fg}}${nm.padEnd(16)}{/${C.fg}} {${C.fgSubtle}}${p.proc.padEnd(14)}{/${C.fgSubtle}}`;
  }) : [`{${C.fgSubtle}}No ports found{/${C.fgSubtle}}`]);
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

logBox.log(`{${C.primary}}◆{/} {bold}{${C.fg}}haksterAi TUI v4{/bold}{/${C.fg}} {${C.fgMuted}}started{/${C.fgMuted}} {${C.fgSubtle}}│ ${REFRESH_MS}ms │ ${API_BASE}{/${C.fgSubtle}}`);
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