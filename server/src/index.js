'use strict';
/**
 * haksterAi — Server Entry Point
 * Express + WebSocket API for the agentic CLI platform
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { diffLines } = require('diff');
const { getDb } = require('./db');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { chat, chatStream, listModels, generateImage, analyzeImage, PROVIDERS, estimateCost, AGENT_TOOLS, AGENT_SYSTEM_PROMPT, executeAgentTool, sanitizeMessagesForProvider, getFirecrawlKeys } = require('./providers');
const { saveMemory, getMemory, searchMemories, listMemories, deleteMemory, getMemoryContext, getMemoryStats, CATEGORIES: MEMORY_CATEGORIES } = require('./memory');
const compression = require('compression');

// ── Config ────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3579', 10);
const CORS_ORIGINS = (process.env.CORS_ORIGINS || 'http://localhost:4321,http://localhost:3000').split(',').map(s => s.trim());
const FS_ROOT = process.env.FS_ROOT || process.cwd();

// ── In-memory caches ──────────────────────────────────────────────
let _skillsCache = null;
let _skillsCacheTime = 0;
const SKILLS_CACHE_TTL = 300000; // 5 min
let _toolsCache = null;
let _toolsCacheTime = 0;
const TOOLS_CACHE_TTL = 300000; // 5 min

function walkMarkdownFiles(dir, maxFiles = 500) {
  const files = [];
  const stack = [dir];
  while (stack.length && files.length < maxFiles) {
    const current = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
        stack.push(full);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        files.push(full);
        if (files.length >= maxFiles) break;
      }
    }
  }
  return files;
}

function getSkillsInventory() {
  const now = Date.now();
  if (_skillsCache && (now - _skillsCacheTime) < SKILLS_CACHE_TTL) return _skillsCache;
  const serviceHome = os.homedir();
  const ghostHome = process.env.HAKSTER_HOME || process.env.GHOST_HOME || '/home/ghost';
  const roots = [
    path.join(serviceHome, '.agents', 'skills'),
    path.join(serviceHome, 'haksterAi', 'pentest-agents', 'skills'),
    path.join(serviceHome, 'skills'),
    path.join(ghostHome, '.agents', 'skills'),
    path.join(ghostHome, 'haksterAi', 'pentest-agents', 'skills'),
    path.join(ghostHome, 'skills'),
    path.join(FS_ROOT, '.hakster', 'skills'),
  ];
  const seen = new Set();
  const skills = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const file of walkMarkdownFiles(root)) {
      const rel = path.relative(root, file);
      const key = `${root}:${rel}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const parts = rel.split(path.sep);
      const isSkillMd = path.basename(file).toLowerCase() === 'skill.md';
      const name = isSkillMd
        ? path.basename(path.dirname(file))
        : rel.replace(/\.md$/i, '').split(path.sep).join('/');
      skills.push({
        name,
        category: parts.length > 1 ? parts[0] : 'general',
        path: file,
        source: root,
      });
    }
  }
  skills.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  const categories = {};
  for (const skill of skills) categories[skill.category] = (categories[skill.category] || 0) + 1;
  const result = { total: skills.length, categories, skills };
  _skillsCache = result;
  _skillsCacheTime = now;
  return result;
}

function getToolInventory() {
  const now = Date.now();
  if (_toolsCache && (now - _toolsCacheTime) < TOOLS_CACHE_TTL) return _toolsCache;
  const tools = AGENT_TOOLS.map((tool) => ({
    name: tool.function?.name || 'unknown',
    description: tool.function?.description || '',
    source: 'web-agent',
  }));
  try {
    const agentFile = path.join(__dirname, 'agent', 'index.js');
    const src = fs.readFileSync(agentFile, 'utf8');
    const start = src.indexOf('let TOOLS = [');
    const end = src.indexOf('const toolExecutors =', start);
    if (start !== -1 && end !== -1) {
      const block = src.slice(start, end);
      const seen = new Set(tools.map(t => t.name));
      for (const match of block.matchAll(/name:\s*['"]([^'"]+)['"]/g)) {
        const name = match[1];
        if (seen.has(name)) continue;
        seen.add(name);
        tools.push({ name, description: '', source: 'terminal-agent' });
      }
    }
  } catch {}
  const result = tools.sort((a, b) => a.name.localeCompare(b.name));
  _toolsCache = result;
  _toolsCacheTime = now;
  return result;
}

// ── Express app ───────────────────────────────────────────────────
const app = express();
app.use(compression());
app.use(cors({ origin: CORS_ORIGINS, credentials: true }));
app.use(express.json({ limit: '10mb' }));

function isCerebrasValue(value) {
  return String(value || '').toLowerCase().includes('cerebras');
}

function isCerebrasModel(model) {
  return isCerebrasValue(model?.id) || isCerebrasValue(model?.name) || isCerebrasValue(model);
}

function getHaksterModelConfig() {
  const haksterConfigPath = path.join(__dirname, '..', 'hakster-config.json');
  let provider = 'ollama';
  let model = PROVIDERS.ollama.defaultModel;
  try {
    const cfg = JSON.parse(fs.readFileSync(haksterConfigPath, 'utf8'));
    if (cfg.provider && !isCerebrasValue(cfg.provider)) provider = cfg.provider;
    if (cfg.model && !isCerebrasValue(cfg.model)) model = cfg.model;
  } catch {}
  return { provider, model };
}

async function openAICompatStreamFetch(baseURL, payload, signal) {
  const apiBase = String(baseURL || '').replace(/\/$/, '').replace(/\/v1$/, '');
  const resp = await fetch(`${apiBase}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ollama',
    },
    body: JSON.stringify(payload),
    signal,
  });
  if (!resp.ok || !resp.body) {
    const text = await resp.text().catch(() => '');
    throw new Error(`${resp.status} ${resp.statusText}${text ? `: ${text.slice(0, 300)}` : ''}`);
  }

  async function* iterator() {
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try { yield JSON.parse(data); } catch {}
      }
    }
  }

  return iterator();
}

// ── Health ────────────────────────────────────────────────────────
// Existing health endpoint
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', version: '1.0.0', providers: Object.keys(PROVIDERS) });
});

app.get('/api/agent/capabilities', (_req, res) => {
  const firecrawlKeyCount = getFirecrawlKeys().length;
  const defaultAgent = getHaksterModelConfig();
  const osInfo = { name: os.type(), version: os.release(), arch: os.arch() };
  const subAgents = [
    { id: 'search', name: 'Search Agent', purpose: 'Find files, docs, references, and implementation examples.' },
    { id: 'builder', name: 'Build Agent', purpose: 'Implement app changes, components, routes, and integrations.' },
    { id: 'script', name: 'Script Agent', purpose: 'Write shell, Node, Python, setup, migration, and automation scripts.' },
    { id: 'qa', name: 'QA Agent', purpose: 'Run checks, inspect failures, and verify responsive UI behavior.' },
    { id: 'firecrawl', name: 'Firecrawl Agent', purpose: 'Search and scrape current webpages, docs, and reference sites.' },
    { id: 'ops', name: 'Ops Agent', purpose: 'Inspect services, PM2, ports, logs, health checks, and deploy readiness.' },
  ];
  res.json({
    firecrawl: {
      configured: firecrawlKeyCount > 0,
      keyCount: firecrawlKeyCount,
      tools: ['web_search', 'firecrawl_scrape'],
      env: ['FIRECRAWL_API_KEY', 'FIRECRAWL_API_KEY_1..12'],
    },
    defaultAgent,
    subAgents,
    tools: AGENT_TOOLS.map((tool) => tool.function?.name).filter(Boolean),
    os: osInfo,
  });
});

// ── Machine Context API (live OS/hardware/folders for agents & TUI) ──
let _machineCtxCache = null;
let _machineCtxTime = 0;
let _machineCtxRefreshing = false;
const MACHINE_CTX_TTL = 300000; // 5 minutes

const { exec: _exec } = require('child_process');
const _execAsync = (cmd, opts) => new Promise((resolve) => { _exec(cmd, opts, (err, stdout) => { resolve(err ? '' : (stdout || '')); }); });
const _readFileAsync = (fp) => new Promise((resolve) => { fs.readFile(fp, 'utf-8', (err, data) => { resolve(err ? null : data); }); });

async function getMachineContext(force = false) {
  const now = Date.now();
  if (!force && _machineCtxCache && (now - _machineCtxTime) < MACHINE_CTX_TTL) {
    return _machineCtxCache;
  }
  if (_machineCtxRefreshing && _machineCtxCache) {
    return _machineCtxCache;
  }
  _machineCtxRefreshing = true;
  const ctx = {
    os: {}, cpu: {}, memory: {}, disk: {}, network: {}, gpu: {}, runtime: {},
    folders: [], services: [], ports: [],
  };

  try {
    // OS
    const osRel = await _readFileAsync('/etc/os-release');
    if (osRel) {
      const n = osRel.match(/^NAME="(.+?)"/m), v = osRel.match(/^VERSION="(.+?)"/m), id = osRel.match(/^ID=(\S+)/m);
      ctx.os = { name: n?.[1] || os.type(), version: v?.[1] || os.release(), id: id?.[1] || 'linux', kernel: os.release(), arch: os.arch(), hostname: os.hostname() };
    } else {
      ctx.os = { name: os.type(), version: os.release(), arch: os.arch(), hostname: os.hostname() };
    }

    // CPU
    const cpus = os.cpus();
    ctx.cpu = { model: cpus[0]?.model?.trim() || 'unknown', cores: cpus.length, speed: cpus[0]?.speed || 0 };
    try {
      const zones = fs.readdirSync('/sys/class/thermal').filter(f => f.startsWith('thermal_zone'));
      ctx.cpu.temps = [];
      for (const t of zones) { try { const v = await _readFileAsync(`/sys/class/thermal/${t}/temp`); if (v) ctx.cpu.temps.push(parseInt(v, 10) / 1000); } catch { /* skip */ } }
    } catch {}

    // Memory
    const totalMem = os.totalmem(), freeMem = os.freemem();
    ctx.memory = { total: totalMem, free: freeMem, used: totalMem - freeMem, pct: totalMem > 0 ? ((totalMem - freeMem) / totalMem * 100).toFixed(1) : '0' };
    const meminfo = await _readFileAsync('/proc/meminfo');
    if (meminfo) {
      const st = meminfo.match(/SwapTotal:\s+(\d+)/), sf = meminfo.match(/SwapFree:\s+(\d+)/);
      if (st && sf) { const total = parseInt(st[1], 10) * 1024; ctx.memory.swapTotal = total; ctx.memory.swapUsed = (parseInt(st[1], 10) - parseInt(sf[1], 10)) * 1024; }
    }

    // Load
    const loadavg = await _readFileAsync('/proc/loadavg');
    if (loadavg) { const la = loadavg.trim().split(' '); ctx.cpu.load1 = parseFloat(la[0]); ctx.cpu.load5 = parseFloat(la[1]); ctx.cpu.load15 = parseFloat(la[2]); } else { ctx.cpu.load = os.loadavg(); }

    // Disk
    const dfOut = await _execAsync('df -h / --output=size,used,avail,pcent 2>/dev/null', { encoding: 'utf-8' });
    if (dfOut) {
      const df = dfOut.trim().split('\n');
      if (df.length > 1) { const p = df[1].trim().split(/\s+/); ctx.disk = { total: p[0], used: p[1], avail: p[2], pct: p[3].trim() }; }
    }

    // GPU
    const gpuOut = await _execAsync('lspci 2>/dev/null | grep -i vga', { encoding: 'utf-8' });
    ctx.gpu = gpuOut ? gpuOut.trim().replace(/^.*:\s*/, '') || null : null;

    // Runtime
    ctx.runtime = { node: process.version, shell: process.env.SHELL || '/bin/sh', user: os.userInfo().username, home: os.homedir(), cwd: process.cwd() };
    const [pythonVer, npmVer, gitVer] = await Promise.all([
      _execAsync('python3 --version 2>/dev/null', { encoding: 'utf-8' }),
      _execAsync('npm --version 2>/dev/null', { encoding: 'utf-8' }),
      _execAsync('git --version 2>/dev/null', { encoding: 'utf-8' }),
    ]);
    if (pythonVer) ctx.runtime.python = pythonVer.trim();
    if (npmVer) ctx.runtime.npm = npmVer.trim();
    if (gitVer) ctx.runtime.git = gitVer.trim();

    // Key folders (dynamic)
    const homeDir = os.homedir();
    const knownDirs = [
      { dir: `${homeDir}/haksterAi`, label: 'haksterAI' },
      { dir: `${homeDir}/cine-vault-live`, label: 'CineVault' },
      { dir: `${homeDir}/miniforge`, label: 'Miniforge' },
      { dir: `${homeDir}/claude-code-proxy`, label: 'Claude Proxy' },
      { dir: `${homeDir}/movie-server`, label: 'Movie Server' },
      { dir: `${homeDir}/skills`, label: 'Skills Library' },
      { dir: `${homeDir}/.agents`, label: 'Agent Skills' },
      { dir: `${homeDir}/.hermes`, label: 'Hermes' },
      { dir: `${homeDir}/.hakster`, label: 'Hakster Config' },
    ];
    for (const k of knownDirs) {
      if (fs.existsSync(k.dir)) {
        try { const st = fs.statSync(k.dir); ctx.folders.push({ label: k.label, path: k.dir, modified: st.mtime.toISOString() }); } catch {}
      }
    }
    // Auto-detect project dirs
    try {
      const entries = fs.readdirSync(homeDir, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith('.')) continue;
        const full = path.join(homeDir, e.name);
        if (knownDirs.some(k => k.dir === full)) continue;
        const pkg = path.join(full, 'package.json');
        if (fs.existsSync(pkg)) {
          try { const p = JSON.parse(fs.readFileSync(pkg, 'utf-8')); ctx.folders.push({ label: p.name || e.name, path: full, modified: fs.statSync(full).mtime.toISOString() }); } catch {}
        }
      }
    } catch {}

    // PM2 services
    const pm2Out = await _execAsync('pm2 jlist 2>/dev/null', { encoding: 'utf-8', timeout: 5000 });
    if (pm2Out) {
      try {
        const pm2List = JSON.parse(pm2Out);
        ctx.services = pm2List.map(p => ({ name: p.name, status: p.pm2_env?.status || '?', pid: p.pid, port: p.pm2_env?.env?.PORT, cpu: p.monit?.cpu, memory: p.monit?.memory, uptime: p.pm2_env?.pm_uptime }));
      } catch {}
    }

    // Listening ports
    const ssOut = await _execAsync("ss -tlnp 2>/dev/null | grep LISTEN", { encoding: 'utf-8' });
    if (ssOut) {
      ctx.ports = ssOut.trim().split('\n').filter(Boolean).map(l => { 
        const portM = l.match(/[:](\d+)\s/); 
        const procM = l.match(/users:\(\("([^"]+)"/);
        return portM ? { port: parseInt(portM[1], 10), process: procM ? procM[1] : 'unknown' } : null; 
      }).filter(p => p && p.port).slice(0, 20);
    }

    _machineCtxCache = ctx;
    _machineCtxTime = now;
  } catch (e) {
    ctx.error = e.message;
  }
  _machineCtxRefreshing = false;
  return ctx;
}

app.get('/api/machine-context', async (_req, res) => {
  const ctx = await getMachineContext();
  if (ctx.error) return res.status(500).json({ error: ctx.error });
  res.json(ctx);
});

// ── Notification Queue API ────────────────────────────────────────
// Shared notification queue — can be pushed from CLI agent, web API, or MCP tools
const _notifQueue = [];
const _notifId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const NOTIF_TYPES = ['notify', 'warn', 'error', 'task', 'mcp', 'system'];
const NOTIF_PRIORITIES = { critical: 0, high: 1, normal: 2, low: 3 };

function notifPush(msg, { type = 'notify', priority = 'normal', source = 'api' } = {}) {
  const entry = {
    id: _notifId(),
    msg: String(msg),
    type: NOTIF_TYPES.includes(type) ? type : 'notify',
    priority: NOTIF_PRIORITIES[priority] ?? 2,
    source,
    ts: new Date().toISOString(),
  };
  _notifQueue.push(entry);
  _notifQueue.sort((a, b) => a.priority - b.priority || a.ts.localeCompare(b.ts));
  while (_notifQueue.length > 200) _notifQueue.shift();
  return entry;
}

function notifDrain(max = 50) {
  return _notifQueue.splice(0, Math.min(max, _notifQueue.length));
}

function notifPeek(limit = 20) {
  return _notifQueue.slice(0, limit);
}

function notifSize() { return _notifQueue.length; }
function notifClear() { _notifQueue.length = 0; }

// Push a notification (also broadcasts to WS clients if available)
app.post('/api/notify', (req, res) => {
  const { message, type = 'notify', priority = 'normal', source } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });
  const entry = notifPush(message, { type, priority, source: source || 'api' });
  // Broadcast to connected WS clients (wss may not exist yet during startup)
  try {
    if (typeof wss !== 'undefined' && wss && wss.clients) {
      wss.clients.forEach(client => {
        if (client.readyState === 1) {
          try { client.send(JSON.stringify({ type: 'notification', ...entry })); } catch {}
        }
      });
    }
  } catch {}
  res.json({ ok: true, ...entry });
});

// Peek at pending notifications (non-destructive)
app.get('/api/queue', (_req, res) => {
  res.json({ size: notifSize(), items: notifPeek(50) });
});

// Drain (consume) pending notifications
app.post('/api/queue/drain', (req, res) => {
  const max = parseInt(req.body?.max) || 50;
  const items = notifDrain(max);
  res.json({ drained: items.length, items });
});

// Clear all notifications
app.post('/api/queue/clear', (_req, res) => {
  const cleared = notifSize();
  notifClear();
  res.json({ ok: true, cleared });
});

// ── Messaging API ────────────────────────────────────────────────────────
app.get('/api/messages', (req, res) => {
  const db = getDb();
  const limit = parseInt(req.query.limit) || 100;
  const msgs = db.prepare(`SELECT * FROM messages ORDER BY created_at DESC LIMIT ?`).all(limit);
  res.json({ messages: msgs });
});


// ── Workspace info ───────────────────────────────────────────────
app.get('/api/workspace/:sessionId', (req, res) => {
  const FS_ROOT = process.env.FS_ROOT || path.join(__dirname, '..', 'data');
  const workDir = path.join(FS_ROOT, 'workspaces', req.params.sessionId || 'default');
  fs.mkdirSync(workDir, { recursive: true });
  let files = [];
  try {
    files = fs.readdirSync(workDir, { withFileTypes: true }).map(e => ({
      name: e.name,
      type: e.isDirectory() ? 'dir' : 'file',
    }));
  } catch {}
  res.json({ workspace: workDir, files });
});

// ── Workspace file serve (for live preview) ───────────────────────
app.get('/api/workspace/:sessionId/files/*filepath', (req, res) => {
  const FS_ROOT = process.env.FS_ROOT || path.join(__dirname, '..', 'data');
  const workDir = path.join(FS_ROOT, 'workspaces', req.params.sessionId || 'default');
  const filePath = path.join(workDir, req.params.filepath);

  // Prevent path traversal
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(workDir))) {
    return res.status(403).json({ error: 'Path traversal denied' });
  }
  if (!fs.existsSync(resolved)) {
    return res.status(404).json({ error: 'File not found' });
  }
  if (fs.statSync(resolved).isDirectory()) {
    // Serve index.html if directory
    const indexPath = path.join(resolved, 'index.html');
    if (fs.existsSync(indexPath)) {
      return res.sendFile(indexPath);
    }
    return res.status(404).json({ error: 'No index.html in directory' });
  }
  res.sendFile(resolved);
});

// ── Workspace file change watcher (SSE) ───────────────────────────
const workspaceWatchers = new Map(); // sessionId -> Set<res>
app.get('/api/workspace/:sessionId/watch', (req, res) => {
  const sessionId = req.params.sessionId || 'default';
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);

  if (!workspaceWatchers.has(sessionId)) {
    workspaceWatchers.set(sessionId, new Set());
  }
  workspaceWatchers.get(sessionId).add(res);

  req.on('close', () => {
    const watchers = workspaceWatchers.get(sessionId);
    if (watchers) {
      watchers.delete(res);
      if (watchers.size === 0) workspaceWatchers.delete(sessionId);
    }
  });
});

function notifyWorkspaceChange(sessionId, filename) {
  const watchers = workspaceWatchers.get(sessionId);
  if (watchers && watchers.size > 0) {
    const data = JSON.stringify({ type: 'file_changed', file: filename, time: Date.now() });
    for (const w of watchers) {
      try { w.write(`data: ${data}\n\n`); } catch {}
    }
  }
}

// ── List providers & models ───────────────────────────────────────
app.get('/api/providers', (_req, res) => {
  const providers = Object.entries(PROVIDERS)
    .filter(([key, cfg]) => !isCerebrasValue(key) && !isCerebrasValue(cfg.name) && !isCerebrasValue(cfg.defaultModel))
    .map(([key, cfg]) => ({
      id: key,
      name: cfg.name,
      type: cfg.type,
      defaultModel: cfg.defaultModel,
    }));
  res.json({ providers });
});

app.get('/api/providers/:id/models', async (req, res) => {
  try {
    if (isCerebrasValue(req.params.id)) {
      return res.status(400).json({ error: 'Cerebras models are disabled' });
    }
    const models = (await listModels(req.params.id)).filter(model => !isCerebrasModel(model));
    res.json({ provider: req.params.id, models });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Client Context (device detection from browser) ──────────────────
function parseClientContext(body, headers) {
  const ua = body.user_agent || headers['user-agent'] || '';
  const rawPlatform = body.platform || headers['sec-ch-ua-platform'] || '';
  const rawUaPlatform = ua.match(/\(([^)]+)\)/)?.[1] || '';

  let os_name = body.os_name || null;
  let os_version = body.os_version || null;
  let platform = body.platform || null;
  let browser = body.browser || null;
  let browser_version = body.browser_version || null;
  let device_type = body.device_type || null;

  // Parse OS from user-agent if client didn't provide it
  if (!os_name && ua) {
    if (/Windows NT 10\.0/i.test(ua)) { os_name = 'Windows'; os_version = '10/11'; }
    else if (/Windows NT/i.test(ua)) { os_name = 'Windows'; }
    else if (/Macintosh|Mac OS X/i.test(ua)) { os_name = 'macOS'; os_version = (ua.match(/Mac OS X ([0-9_.]+)/)?.[1] || '').replace(/_/g, '.'); }
    else if (/Linux/i.test(ua)) { os_name = 'Linux'; }
    else if (/Android/i.test(ua)) { os_name = 'Android'; os_version = ua.match(/Android ([0-9.]+)/)?.[1] || ''; device_type = 'mobile'; }
    else if (/iPhone|iPad|iPod/i.test(ua)) { os_name = 'iOS'; os_version = ua.match(/OS ([0-9_]+)/)?.[1]?.replace(/_/g, '.') || ''; device_type = /iPad/.test(ua) ? 'tablet' : 'mobile'; }
  }

  // Parse platform/OS from navigator.platform / Sec-CH-UA-Platform
  if (!platform && rawPlatform) platform = rawPlatform.replace(/"/g, '');
  if (!platform && rawUaPlatform) {
    if (/Win/i.test(rawUaPlatform)) platform = 'Win32';
    else if (/Mac/i.test(rawUaPlatform)) platform = 'MacIntel';
    else if (/Linux/i.test(rawUaPlatform)) platform = 'Linux x86_64';
    else if (/Android/i.test(rawUaPlatform)) platform = 'Android';
  }

  // Parse browser
  if (!browser && ua) {
    if (/Edg\//i.test(ua)) { browser = 'Edge'; browser_version = ua.match(/Edg\/([0-9.]+)/)?.[1] || ''; }
    else if (/Chrome/i.test(ua)) { browser = 'Chrome'; browser_version = ua.match(/Chrome\/([0-9.]+)/)?.[1] || ''; }
    else if (/Firefox/i.test(ua)) { browser = 'Firefox'; browser_version = ua.match(/Firefox\/([0-9.]+)/)?.[1] || ''; }
    else if (/Safari/i.test(ua)) { browser = 'Safari'; browser_version = ua.match(/Version\/([0-9.]+)/)?.[1] || ''; }
  }

  // Classify device type from screen if not already known
  if (!device_type && body.screen_width && body.screen_height) {
    const min = Math.min(body.screen_width, body.screen_height);
    if (min <= 480) device_type = 'mobile';
    else if (min <= 1024) device_type = 'tablet';
    else device_type = 'desktop';
  }

  return {
    session_id: body.session_id,
    ip_address: body.ip_address || headers['x-forwarded-for']?.split(',')[0] || null,
    user_agent: ua,
    platform: platform || null,
    os_name: os_name || null,
    os_version: os_version || null,
    browser: browser || null,
    browser_version: browser_version || null,
    device_type: device_type || null,
    screen_width: body.screen_width || null,
    screen_height: body.screen_height || null,
    device_pixel_ratio: body.device_pixel_ratio || null,
    language: body.language || null,
    timezone: body.timezone || null,
    online: body.online,
    cores: body.cores || null,
    memory_gb: body.memory_gb || null,
    touch_support: body.touch_support,
  };
}

app.post('/api/client-context', (req, res) => {
  const db = getDb();
  const ctx = parseClientContext(req.body, req.headers);

  if (!ctx.session_id) return res.status(400).json({ error: 'session_id required' });

  const ip = ctx.ip_address || req.ip || req.headers['x-forwarded-for']?.split(',')[0] || 'unknown';

  db.prepare(`
    INSERT INTO client_contexts (session_id, ip_address, user_agent, platform, os_name, os_version,
      browser, browser_version, device_type, screen_width, screen_height, device_pixel_ratio,
      language, timezone, online, cores, memory_gb, touch_support)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      ip_address=excluded.ip_address, user_agent=excluded.user_agent, platform=excluded.platform,
      os_name=excluded.os_name, os_version=excluded.os_version, browser=excluded.browser,
      browser_version=excluded.browser_version, device_type=excluded.device_type,
      screen_width=excluded.screen_width, screen_height=excluded.screen_height,
      device_pixel_ratio=excluded.device_pixel_ratio, language=excluded.language,
      timezone=excluded.timezone, online=excluded.online, cores=excluded.cores,
      memory_gb=excluded.memory_gb, touch_support=excluded.touch_support, updated_at=unixepoch()
  `).run(ctx.session_id, ip, ctx.user_agent, ctx.platform, ctx.os_name, ctx.os_version,
    ctx.browser, ctx.browser_version, ctx.device_type,
    ctx.screen_width, ctx.screen_height, ctx.device_pixel_ratio,
    ctx.language, ctx.timezone, ctx.online ? 1 : 0, ctx.cores, ctx.memory_gb,
    ctx.touch_support ? 1 : 0);

  res.json({ ok: true, session_id: ctx.session_id, detected: { os_name: ctx.os_name, platform: ctx.platform, browser: ctx.browser, device_type: ctx.device_type } });
});

app.get('/api/client-context/:sessionId', (req, res) => {
  const db = getDb();
  const ctx = db.prepare(`SELECT * FROM client_contexts WHERE session_id = ? ORDER BY updated_at DESC LIMIT 1`).get(req.params.sessionId);
  if (!ctx) return res.status(404).json({ error: 'No client context found for this session' });
  res.json(ctx);
});

app.get('/api/client-contexts', (req, res) => {
  const db = getDb();
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const contexts = db.prepare(`
    SELECT cc.*, s.title as session_title, s.provider, s.model
    FROM client_contexts cc LEFT JOIN sessions s ON cc.session_id = s.id
    ORDER BY cc.updated_at DESC LIMIT ?
  `).all(limit);
  res.json({ contexts });
});

// ── People & Machines directory API (for TUI CLI) ─────────────────
app.get('/api/people', (req, res) => {
  const db = getDb();
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const people = db.prepare(`
    SELECT u.id, u.username, u.email, u.role, u.plan, u.status,
           u.created_at, u.updated_at, u.last_login_at, u.last_login_ip
    FROM users u
    ORDER BY u.last_login_at DESC, u.created_at DESC
    LIMIT ?
  `).all(limit);
  // Enrich with access logs since sessions/requests don't carry user_id directly.
  const enriched = people.map(p => {
    const access = db.prepare(`SELECT created_at, endpoint, method, status_code FROM access_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`).get(p.id);
    const accessCount = db.prepare(`SELECT COUNT(*) as c FROM access_logs WHERE user_id = ?`).get(p.id).c;
    return { ...p, last_access: access || null, access_count: accessCount };
  });
  res.json({ people: enriched });
});

app.get('/api/machines', async (_req, res) => {
  const db = getDb();
  try {
    const serverCtx = await getMachineContext();
    const clients = db.prepare(`
      SELECT cc.*, s.title as session_title, s.provider, s.model
      FROM client_contexts cc LEFT JOIN sessions s ON cc.session_id = s.id
      ORDER BY cc.updated_at DESC LIMIT 200
    `).all();
    const dash = db.prepare(`SELECT * FROM requests ORDER BY created_at DESC LIMIT 1`).get();
    res.json({ server: serverCtx, clients, last_request: dash || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/integrations', (_req, res) => {
  const keys = getFirecrawlKeys();
  res.json({
    firecrawl: {
      configured: keys.length > 0,
      key_count: keys.length,
      // expose first/last few characters only so the user can verify which keys are loaded
      key_prefixes: keys.map(k => k.length > 12 ? `${k.slice(0, 4)}…${k.slice(-4)}` : '…'),
    },
  });
});

// ── Persistent Memory API ─────────────────────────────────────────
app.get('/api/memory', (req, res) => {
  const { category, limit, offset } = req.query;
  const memories = listMemories({ category: category || null, limit: parseInt(limit) || 100, offset: parseInt(offset) || 0 });
  res.json({ memories });
});

app.get('/memory/stats', (_req, res) => {
  res.json(getMemoryStats());
});

app.get('/memory/:key', (req, res) => {
  const mem = getMemory(req.params.key);
  if (!mem) return res.status(404).json({ error: 'Memory not found' });
  res.json(mem);
});

app.post('/api/memory', (req, res) => {
  try {
    const { category, key, value, source, sessionId, confidence, expiresAt } = req.body;
    if (!key || !value) return res.status(400).json({ error: 'key and value are required' });
    const mem = saveMemory({ category, key, value, source: source || 'api', sessionId: sessionId || null, confidence: confidence || 1.0, expiresAt: expiresAt || null });
    res.status(201).json(mem);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/memory/:key', (req, res) => {
  try {
    const existing = getMemory(req.params.key);
    if (!existing) return res.status(404).json({ error: 'Memory not found' });
    const { category, value, source, confidence, expiresAt } = req.body;
    const mem = saveMemory({
      category: category || existing.category,
      key: req.params.key,
      value: value || existing.value,
      source: source || existing.source,
      confidence: confidence || existing.confidence,
      expiresAt: expiresAt || null,
    });
    res.json(mem);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/memory/:key', (req, res) => {
  const ok = deleteMemory(req.params.key);
  if (!ok) return res.status(404).json({ error: 'Memory not found' });
  res.json({ deleted: true });
});

app.post('/api/memory/search', (req, res) => {
  const { query, category, limit } = req.body;
  if (!query) return res.status(400).json({ error: 'query is required' });
  const results = searchMemories(query, { category: category || null, limit: parseInt(limit) || 20 });
  res.json({ results });
});

// ── Sessions CRUD ─────────────────────────────────────────────────
app.post('/api/sessions', (req, res) => {
  const db = getDb();
  const id = uuidv4();
  const { provider = 'ollama', model, title } = req.body;
  const cfg = PROVIDERS[provider];
  if (!cfg) return res.status(400).json({ error: `Unknown provider: ${provider}` });

  const finalModel = model || cfg.defaultModel;
  db.prepare(
    `INSERT INTO sessions (id, provider, model, title) VALUES (?, ?, ?, ?)`
  ).run(id, provider, finalModel, title || null);

  res.status(201).json({ id, provider, model: finalModel, title, createdAt: Date.now() });
});

app.get('/api/sessions', (_req, res) => {
  const db = getDb();
  const sessions = db.prepare(
    `SELECT * FROM sessions ORDER BY updated_at DESC`
  ).all();
  res.json({ sessions });
});

app.get('/api/sessions/:id', (req, res) => {
  const db = getDb();
  const session = db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const messages = db.prepare(
    `SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC`
  ).all(req.params.id);

  res.json({ ...session, messages });
});

app.delete('/api/sessions/:id', (req, res) => {
  const db = getDb();
  const del = db.prepare(`DELETE FROM sessions WHERE id = ?`).run(req.params.id);
  if (del.changes === 0) return res.status(404).json({ error: 'Session not found' });
  res.json({ deleted: true });
});

// ── Chat (non-streaming) ──────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { provider = 'ollama', model, messages, system, sessionId } = req.body;
  if (isCerebrasValue(provider) || isCerebrasValue(model)) {
    return res.status(400).json({ error: 'Cerebras models are disabled' });
  }
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array required' });
  }

  try {
    const result = await chat({ provider, model, messages, system });
    const db = getDb();

    // Log the request
    const reqId = uuidv4();
    db.prepare(
      `INSERT INTO requests (id, session_id, type, provider, model, input_tokens, output_tokens, latency_ms, cost, status)
       VALUES (?, ?, 'chat', ?, ?, ?, ?, ?, ?, 'ok')`
    ).run(reqId, sessionId || null, provider, result.model, result.inputTokens, result.outputTokens, result.latency, result.cost);

    // Update session stats
    if (sessionId) {
      db.prepare(
        `UPDATE sessions SET total_tokens = total_tokens + ?, total_cost = total_cost + ?, updated_at = unixepoch() WHERE id = ?`
      ).run(result.inputTokens + result.outputTokens, result.cost, sessionId);
    }

    res.json(result);
  } catch (err) {
    console.error('[chat] error:', err);
    const db = getDb();
    const reqId = uuidv4();
    db.prepare(
      `INSERT INTO requests (id, session_id, type, provider, model, status, error, created_at) VALUES (?, ?, 'chat', ?, ?, 'error', ?, unixepoch())`
    ).run(reqId, sessionId || null, provider, model || PROVIDERS[provider]?.defaultModel || 'unknown', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Chat (SSE streaming) ─────────────────────────────────────────
app.post('/api/chat/stream', async (req, res) => {
  const { provider = 'ollama', model, messages, system, sessionId, thinking = false } = req.body;
  if (isCerebrasValue(provider) || isCerebrasValue(model)) {
    return res.status(400).json({ error: 'Cerebras models are disabled' });
  }
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array required' });
  }

  // SSE heartbeat — prevent idle disconnect
  const chatHeartbeat = setInterval(() => {
    try { res.write(':heartbeat\n\n'); } catch {}
  }, 15000);
  res.on('close', () => { clearInterval(chatHeartbeat); });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  try {
    let fullContent = '';
    let fullThinking = '';
    let finalMeta = null;

    for await (const event of chatStream({ provider, model, messages, system, thinking })) {
      if (event.type === 'delta') {
        fullContent += event.content;
        res.write(`data: ${JSON.stringify({ type: 'delta', content: event.content })}\n\n`);
      } else if (event.type === 'thinking_start') {
        res.write(`data: ${JSON.stringify({ type: 'thinking_start' })}\n\n`);
      } else if (event.type === 'thinking') {
        fullThinking += event.content;
        res.write(`data: ${JSON.stringify({ type: 'thinking', content: event.content })}\n\n`);
      } else if (event.type === 'thinking_end') {
        res.write(`data: ${JSON.stringify({ type: 'thinking_end' })}\n\n`);
      } else if (event.type === 'done') {
        finalMeta = event;
      }
    }

    // Log
    if (finalMeta) {
      const db = getDb();
      const reqId = uuidv4();
      db.prepare(
        `INSERT INTO requests (id, session_id, type, provider, model, input_tokens, output_tokens, latency_ms, cost, status)
         VALUES (?, ?, 'stream', ?, ?, ?, ?, ?, ?, 'ok')`
      ).run(reqId, sessionId || null, finalMeta.provider, finalMeta.model, finalMeta.inputTokens, finalMeta.outputTokens, finalMeta.latency, finalMeta.cost);

      if (sessionId) {
        db.prepare(
          `UPDATE sessions SET total_tokens = total_tokens + ?, total_cost = total_cost + ?, updated_at = unixepoch() WHERE id = ?`
        ).run(finalMeta.inputTokens + finalMeta.outputTokens, finalMeta.cost, sessionId);
      }
    }

    res.write(`data: ${JSON.stringify({ type: 'done', ...(finalMeta || {}) })}\n\n`);
    res.end();
  } catch (err) {
    console.error('[stream] error:', err);
    res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
    res.end();
  }
});

// ── Agent Run (agentic loop with tool calls) ──────────────────────
const { OpenAI: OpenAIClient } = require('openai');

// ── Per-session allowlist for dangerous commands ──────────────────
const sessionAllowedCommands = new Map(); // sessionId -> Set of allowed command strings
// Hydrate allowlist from DB on startup
{
  try {
    const db = getDb();
    const rows = db.prepare('SELECT command, session_id FROM command_allowlist').all();
    for (const row of rows) {
      const sid = row.session_id || 'default';
      if (!sessionAllowedCommands.has(sid)) sessionAllowedCommands.set(sid, new Set());
      sessionAllowedCommands.get(sid).add(row.command);
    }
    if (rows.length) console.log(`[allowlist] Loaded ${rows.length} allowed commands from DB`);
  } catch (_) { /* DB may not exist yet on first boot */ }
}

app.get('/api/agent/allowlist', (_req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT id, command, pattern, source, created_at FROM command_allowlist ORDER BY created_at DESC').all();
  res.json({ allowlist: rows });
});

app.post('/api/agent/allow', (req, res) => {
  const { command } = req.body;
  if (!command) return res.status(400).json({ error: 'command is required' });
  const cmd = command.trim();
  // Add to in-memory allowlist for all sessions
  if (!sessionAllowedCommands.has('default')) sessionAllowedCommands.set('default', new Set());
  sessionAllowedCommands.get('default').add(cmd);
  // Persist to DB for cross-session reuse (no session_id — global permanent allowlist)
  const db = getDb();
  db.prepare('INSERT OR IGNORE INTO command_allowlist (command, source, session_id) VALUES (?, ?, ?)').run(cmd, 'user', 'default');
  res.json({ ok: true, command: cmd, permanent: true });
});

app.delete('/api/agent/allowlist/:id', (req, res) => {
  const db = getDb();
  const result = db.prepare('DELETE FROM command_allowlist WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
  // Also rebuild in-memory sets
  const allRows = db.prepare('SELECT command, session_id FROM command_allowlist').all();
  sessionAllowedCommands.clear();
  for (const row of allRows) {
    const sid = row.session_id || 'default';
    if (!sessionAllowedCommands.has(sid)) sessionAllowedCommands.set(sid, new Set());
    sessionAllowedCommands.get(sid).add(row.command);
  }
  res.json({ deleted: true });
});

app.post('/api/agent/run', async (req, res) => {
  const { provider = 'ollama', model, messages, sessionId, cwd } = req.body;
  if (isCerebrasValue(provider) || isCerebrasValue(model)) {
    return res.status(400).json({ error: 'Cerebras models are disabled' });
  }
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array required' });
  }

  const cfg = PROVIDERS[provider];
  if (!cfg) return res.status(400).json({ error: `Unknown provider: ${provider}` });

  // Per-session workspace: if no cwd provided, create an isolated workspace
  // under data/workspaces/<sessionId>. This gives each chat session its own
  // sandboxed directory for file operations.
  const FS_ROOT = process.env.FS_ROOT || path.join(__dirname, '..', 'data');
  const workDir = cwd || path.join(FS_ROOT, 'workspaces', sessionId || 'default');
  // Ensure workspace directory exists
  if (!cwd) {
    fs.mkdirSync(workDir, { recursive: true });
  }
  const maxTurns = 25;
  const agentModel = model || cfg.defaultModel;

  // ── Loop detection (per-request, not module-level) ────────────
  let loopDetect = {
    lastAssistantContent: '',       // Last assistant response for exact-repeat detection
    noProgressCount: 0,             // Consecutive turns without real tool calls
    recentPrefixes: [],             // Last N response prefixes for semantic loop detection
    consecutiveToolErrors: [],      // [{name, count}] — same tool erroring repeatedly
    recentToolCalls: [],            // [{name, args}] — last N tool calls for duplicate detection
    totalToolCalls: 0,              // Running total of tool calls made
  };
  const NO_PROGRESS_LIMIT = 4;       // Break after this many no-progress turns
  const SEMANTIC_LOOP_WINDOW = 3;    // How many recent prefixes to check
  const SEMANTIC_LOOP_THRESHOLD = 2;  // How many similar prefixes → loop
  const TOOL_ERROR_LOOP_LIMIT = 3;   // Same tool erroring this many times → break
  const DUPE_CALL_WINDOW = 4;        // How many recent tool calls to check for dupes
  const DUPE_CALL_LIMIT = 3;         // Same tool+args repeating this many times → loop

  // Abort tracking — client disconnect support (use res, not req)
  let aborted = false;
  res.on('close', () => {
    aborted = true;
    clearInterval(heartbeat);
  });

  // SSE heartbeat — prevent idle disconnect (send every 15s)
  const heartbeat = setInterval(() => {
    if (!aborted) {
      try { res.write(`:heartbeat\n\n`); } catch {}
    }
  }, 15000);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
  res.flushHeaders();

  // Build the OpenAI-compatible client for the chosen provider
  let client;
  if (cfg.type === 'anthropic') {
    // Anthropic doesn't support OpenAI-style tool_calls in our current setup —
    // route through Ollama for agent mode
    const ollamaCfg = PROVIDERS.ollama;
    client = new OpenAIClient({
      apiKey: ollamaCfg.apiKey || 'ollama',
      baseURL: `${ollamaCfg.baseURL.replace(/\/$/, '')}/v1`,
    });
  } else if (cfg.type === 'openai-compat') {
    client = new OpenAIClient({
      apiKey: cfg.apiKey || 'ollama',
      baseURL: `${cfg.baseURL.replace(/\/$/, '')}/v1`,
    });
  } else {
    client = new OpenAIClient({
      apiKey: cfg.apiKey,
      baseURL: cfg.baseURL,
    });
  }

  // Build machine context so the model knows the environment
  let dirListing = '';
  try { dirListing = fs.readdirSync(workDir).map(f => {
    try { return fs.statSync(path.join(workDir, f)).isDirectory() ? f + '/' : f; } catch { return f; }
  }).join('\n'); } catch { dirListing = '(unreadable)'; }
  const machineContext = `
=== MACHINE CONTEXT ===
OS: ${os.type()} ${os.release()} (${os.arch()})
Hostname: ${os.hostname()}
User: ${os.userInfo().username}
Shell: ${process.env.SHELL || '/bin/bash'}
CWD: ${workDir}
Home: ${os.homedir()}
 CPUs: ${os.cpus().length} cores | RAM: ${Math.round(os.totalmem()/1024/1024/1024)}GB | Uptime: ${Math.round(os.uptime()/3600)}h
Node: ${process.version}

Files in CWD (${workDir}):
${dirListing}
=== END MACHINE CONTEXT ===`;

  // ── Inject persistent memory context ──────────────────────────────
  const lastUserMsg = messages.filter(m => m.role === 'user').pop();
  const memoryContext = getMemoryContext(lastUserMsg?.content || '', { maxMemories: 15, maxChars: 3000 });

  // ── Preserve client-supplied system prompt (e.g. hack page pentest prompts) ──
  const clientSystemMsg = messages.find(m => m.role === 'system');
  const clientSystemContent = clientSystemMsg ? clientSystemMsg.content : '';
  const systemContent = AGENT_SYSTEM_PROMPT
    + (clientSystemContent ? '\n\n=== CLIENT DIRECTIVE ===\n' + clientSystemContent : '')
    + '\n\n' + machineContext
    + (memoryContext ? '\n\n' + memoryContext : '');

  const agentMessages = [
    { role: 'system', content: systemContent },
    ...messages.filter(m => m.role !== 'system'),
  ];

  // ── Inject client device context if available ──────────────────────
  if (sessionId) {
    try {
      const db = getDb();
      const clientCtx = db.prepare(`SELECT * FROM client_contexts WHERE session_id = ? ORDER BY updated_at DESC LIMIT 1`).get(sessionId);
      if (clientCtx) {
        const lines = ['\n=== CLIENT DEVICE CONTEXT ==='];
        lines.push(`The user is connecting from a DIFFERENT device than the server.`);
        lines.push(`Server: See MACHINE CONTEXT above (where I run)`);
        lines.push(`Client (where the user is):`);
        if (clientCtx.device_type) lines.push(`  Device: ${clientCtx.device_type}`);
        if (clientCtx.os_name || clientCtx.os_version) lines.push(`  OS: ${[clientCtx.os_name, clientCtx.os_version].filter(Boolean).join(' ')}`);
        if (clientCtx.platform) lines.push(`  Platform: ${clientCtx.platform}`);
        if (clientCtx.browser || clientCtx.browser_version) lines.push(`  Browser: ${[clientCtx.browser, clientCtx.browser_version].filter(Boolean).join(' ')}`);
        if (clientCtx.screen_width && clientCtx.screen_height) lines.push(`  Screen: ${clientCtx.screen_width}×${clientCtx.screen_height}${clientCtx.device_pixel_ratio ? ` @${clientCtx.device_pixel_ratio}x` : ''}`);
        if (clientCtx.language) lines.push(`  Language: ${clientCtx.language}`);
        if (clientCtx.timezone) lines.push(`  Timezone: ${clientCtx.timezone}`);
        if (clientCtx.cores) lines.push(`  CPU cores: ${clientCtx.cores}`);
        if (clientCtx.memory_gb) lines.push(`  Memory: ${clientCtx.memory_gb} GB`);
        if (clientCtx.touch_support) lines.push(`  Touch: Yes`);
        if (clientCtx.ip_address) lines.push(`  IP: ${clientCtx.ip_address}`);
        lines.push('=== END CLIENT DEVICE CONTEXT ===\n');
        agentMessages[0].content += lines.join('\n');
      }
    } catch (_) { /* client context not available — skip */ }
  }

  // ── Pre-process multimodal messages: convert images to text for non-vision models ──
  const VISION_CAPABLE_PATTERNS = [
    /^claude-/i,
    /^gpt-4o/i,
    /^gpt-4-turbo/i,
    /^gpt-4-vision/i,
    /^gemini-/i,
    /^qwen-vl-/i,
  ];
  function isVisionCapable(modelName) {
    if (!modelName) return false;
    return VISION_CAPABLE_PATTERNS.some(p => p.test(modelName));
  }

  if (!isVisionCapable(agentModel)) {
    for (let i = 0; i < agentMessages.length; i++) {
      const msg = agentMessages[i];
      if (!Array.isArray(msg.content)) continue;

      const imageBlocks = msg.content.filter(b => b.type === 'image_url');
      if (imageBlocks.length === 0) continue;

      // Separate text parts from image blocks
      const textParts = msg.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .filter(Boolean);

      // Analyze each image block
      const imageDescriptions = [];
      for (const imageBlock of imageBlocks) {
        const imageUrl = imageBlock.image_url?.url || imageBlock.url;
        try {
          const visionResult = await analyzeImage({
            provider: 'openrouter',
            model: 'openai/gpt-4o',
            prompt: 'Describe this image in detail. Include all text, UI elements, code, error messages, and visual content visible.',
            imageUrl: imageUrl,
            imageBase64: imageUrl?.startsWith('data:') ? undefined : undefined,
            mimeType: 'image/png'
          });
          imageDescriptions.push(visionResult.content);
        } catch (err) {
          imageDescriptions.push('[Image could not be analyzed: ' + (err.message || String(err)) + ']');
        }
      }

      // Replace multimodal content with text-only version
      const combinedText = textParts.join('\n') + '\n\n[Image analysis]: ' + imageDescriptions.join('\n\n');
      agentMessages[i] = { role: msg.role, content: combinedText };
    }
  }

  // ── Hard context ceiling — progressive truncation, no message dropping ──
  const CONTEXT_LIMIT = 131072; // matches gpt-oss:120b-cloud actual context window
  const MAX_OUTPUT_TOKENS = 16384; // reserved for model output
  const INPUT_TOKEN_BUDGET = CONTEXT_LIMIT - MAX_OUTPUT_TOKENS; // ~114k tokens available for input
  const MAX_CONTEXT_CHARS = 100000; // hard ceiling in chars — very aggressive to prevent token overflow
  const MAX_MSG_CHARS = 1000; // max chars per message in context (except system prompt)

  function estimateTokens(msgs) {
    let chars = 0;
    for (const m of msgs) {
      if (Array.isArray(m.content)) {
        for (const part of m.content) {
          if (part.type === 'text') chars += (part.text || '').length;
          else if (part.type === 'image_url') chars += 1200;
        }
      } else {
        chars += (m.content || '').length;
      }
      if (m.tool_calls) {
        for (const tc of m.tool_calls) {
          chars += (tc.function?.arguments || '').length;
          // Tool definitions add overhead — function name + description + params
          chars += 100; // per tool call: name, id, type overhead
        }
      }
      // Tool result messages include tool_call_id overhead
      if (m.role === 'tool') chars += 50;
    }
    // Use aggressive 1.5:1 ratio (code/special chars tokenize higher than plain text)
    return Math.ceil(chars / 1.5);
  }

  // Hard-truncate a single message's content fields
  function truncateMessage(m, maxLen) {
    if (m.role === 'system') return m; // never truncate system prompt
    if (Array.isArray(m.content)) {
      return {
        ...m,
        content: m.content.map(part => (
          part.type === 'text' && (part.text || '').length > maxLen
            ? { ...part, text: part.text.substring(0, maxLen) + '\n[trimmed]' }
            : part
        )),
      };
    }
    const content = (m.content || '').length > maxLen
      ? m.content.substring(0, maxLen) + '\n[trimmed]'
      : m.content;
    let tool_calls = m.tool_calls;
    if (tool_calls) {
      tool_calls = tool_calls.map(tc => ({
        ...tc,
        function: {
          ...tc.function,
          arguments: (tc.function?.arguments || '').length > maxLen
            ? tc.function.arguments.substring(0, maxLen) + '...'
            : tc.function?.arguments,
        }
      }));
    }
    return { ...m, content, tool_calls };
  }

  // Enforce hard ceiling on total context before sending to model
  // Strategy: keep ALL messages, just truncate content to fit budget
  function enforceContextCeiling(msgs) {
    let totalChars = msgs.reduce((sum, m) => sum + (m.content || '').length +
      (m.tool_calls ? m.tool_calls.reduce((s, tc) => s + (tc.function?.arguments || '').length, 0) : 0), 0);

    // Step 1: Truncate every message to MAX_MSG_CHARS (except system)
    msgs = msgs.map(m => truncateMessage(m, MAX_MSG_CHARS));

    totalChars = msgs.reduce((sum, m) => sum + (m.content || '').length +
      (m.tool_calls ? m.tool_calls.reduce((s, tc) => s + (tc.function?.arguments || '').length, 0) : 0), 0);

    // Step 2: If still over budget, progressively truncate harder — never drop messages
    // Reduce max per-message length until we fit
    let perMsgLimit = MAX_MSG_CHARS;
    while (totalChars > MAX_CONTEXT_CHARS && perMsgLimit > 100) {
      perMsgLimit = Math.floor(perMsgLimit * 0.6); // shrink by 40% each pass
      msgs = msgs.map((m, i) => i === 0 ? m : truncateMessage(m, perMsgLimit));
      totalChars = msgs.reduce((sum, m) => sum + (m.content || '').length +
        (m.tool_calls ? m.tool_calls.reduce((s, tc) => s + (tc.function?.arguments || '').length, 0) : 0), 0);
    }

    // Step 3: Absolute last resort — nuclear 100 char truncation
    if (totalChars > MAX_CONTEXT_CHARS) {
      msgs = msgs.map((m, i) => i === 0 ? m : truncateMessage(m, 100));
    }

    // Step 4: If STILL over budget, drop oldest messages (except system prompt)
    // This is the nuclear option — we must not exceed the token limit
    totalChars = msgs.reduce((sum, m) => sum + (m.content || '').length +
      (m.tool_calls ? m.tool_calls.reduce((s, tc) => s + (tc.function?.arguments || '').length, 0) : 0), 0);
    let spliceGuard = 0;
    while (totalChars > MAX_CONTEXT_CHARS && msgs.length > 2 && spliceGuard < 200) {
      // Drop the oldest non-system message (index 1)
      const dropped = msgs.splice(1, 1);
      totalChars -= (dropped[0]?.content || '').length;
      spliceGuard++;
    }
    totalChars = msgs.reduce((sum, m) => sum + (m.content || '').length +
      (m.tool_calls ? m.tool_calls.reduce((s, tc) => s + (tc.function?.arguments || '').length, 0) : 0), 0);

    return msgs;
  }

  // ── Pre-flight: enforce context ceiling on incoming history ──
  {
    const before = estimateTokens(agentMessages);
    const enforced = enforceContextCeiling(agentMessages);
    if (enforced.length < agentMessages.length || estimateTokens(enforced) < before) {
      agentMessages.length = 0;
      agentMessages.push(...enforced);
      const after = estimateTokens(agentMessages);
      console.log(`[agent] Pre-flight ceiling: ${before} → ${after} tokens (budget: ${INPUT_TOKEN_BUDGET})`);
    }
  }

  let lastHadToolCalls = false;
  try {
    for (let turn = 0; turn < maxTurns; turn++) {
      // Check abort at start of each iteration
      if (aborted) {
        clearInterval(heartbeat);
        res.write(`data: ${JSON.stringify({ type: 'aborted' })}\n\n`);
        res.end();
        return;
      }

      // ── Enforce context ceiling before every model call ──
      {
        const tokensBefore = estimateTokens(agentMessages);
        const enforced = enforceContextCeiling(agentMessages);
        if (enforced.length < agentMessages.length || estimateTokens(enforced) < tokensBefore) {
          agentMessages.length = 0;
          agentMessages.push(...enforced);
          const tokensAfter = estimateTokens(agentMessages);
          if (tokensBefore !== tokensAfter) {
            console.log(`[agent] Context ceiling: ${tokensBefore} → ${tokensAfter} tokens (budget: ${INPUT_TOKEN_BUDGET})`);
            res.write(`data: ${JSON.stringify({ type: 'compact', message: `[context ceiling] ${tokensBefore} → ${tokensAfter} tokens (budget: ${INPUT_TOKEN_BUDGET})`, tokensBefore, tokensAfter })}\n\n`);
          }
        }
        // Debug: log actual message sizes being sent to model
        const totalChars = agentMessages.reduce((s, m) => s + (m.content || '').length + 
          (m.tool_calls ? m.tool_calls.reduce((acc, tc) => acc + (tc.function?.arguments || '').length, 0) : 0), 0);
        console.log(`[agent] Sending turn ${turn}: ${agentMessages.length} msgs, ${totalChars.toLocaleString()} chars, est ${estimateTokens(agentMessages).toLocaleString()} tokens (budget: ${INPUT_TOKEN_BUDGET})`);
      }

      // Hard safety: if still over budget after all enforcement, refuse the call
      const finalEstimate = estimateTokens(agentMessages);
      if (finalEstimate > INPUT_TOKEN_BUDGET) {
        console.error(`[agent] FATAL: Still ${finalEstimate} tokens after enforcement (budget: ${INPUT_TOKEN_BUDGET}). Dropping oldest messages.`);
        while (estimateTokens(agentMessages) > INPUT_TOKEN_BUDGET && agentMessages.length > 2) {
          agentMessages.splice(1, 1); // drop oldest non-system message
        }
        console.log(`[agent] After emergency trim: ${estimateTokens(agentMessages)} tokens, ${agentMessages.length} msgs`);
      }

      // Stream the model response with timeout protection
      const streamAbort = new AbortController();
      const streamTimeout = setTimeout(() => {
        streamAbort.abort();
        console.warn('[agent] Stream timed out after 120s, aborting');
      }, 120000);

      let stream;
      try {
        const streamPayload = {
          model: agentModel,
          messages: sanitizeMessagesForProvider(agentMessages, provider),
          tools: AGENT_TOOLS,
          stream: true,
          max_tokens: MAX_OUTPUT_TOKENS,
        };
        stream = cfg.type === 'openai-compat'
          ? await openAICompatStreamFetch(cfg.baseURL, streamPayload, streamAbort.signal)
          : await client.chat.completions.create(streamPayload, { signal: streamAbort.signal });
      } catch (streamErr) {
        clearTimeout(streamTimeout);
        if (streamErr.name === 'AbortError') {
          res.write(`data: ${JSON.stringify({ type: 'error', message: 'Model response timed out (120s). Try again.' })}\n\n`);
          break;
        }
        throw streamErr;
      }

      let assistantContent = '';
      const toolCalls = []; // { id, name, arguments (accumulated) }
      let currentToolCall = null;
      let thinkingActive = false;

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;

        // Reasoning / thinking content (OpenAI-compatible models like GLM-5.1)
        const thinkingContent = delta.reasoning_content || delta.thinking;
        if (thinkingContent) {
          if (!thinkingActive) {
            thinkingActive = true;
            res.write(`data: ${JSON.stringify({ type: 'thinking_start' })}\n\n`);
          }
          res.write(`data: ${JSON.stringify({ type: 'thinking', content: thinkingContent })}\n\n`);
        }
        // Close thinking if we had thinking but now see content or tool_calls (thinking block ended)
        if (thinkingActive && (delta.content || delta.tool_calls)) {
          thinkingActive = false;
          res.write(`data: ${JSON.stringify({ type: 'thinking_end' })}\n\n`);
        }

        // Text content
        if (delta.content) {
          assistantContent += delta.content;
          res.write(`data: ${JSON.stringify({ type: 'delta', content: delta.content })}\n\n`);
        }

        // Tool calls — accumulate
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (tc.index !== undefined) {
              // New tool call starts
              if (!toolCalls[tc.index]) {
                toolCalls[tc.index] = {
                  id: tc.id || '',
                  name: tc.function?.name || '',
                  arguments: '',
                };
                currentToolCall = tc.index;
              }
              if (tc.id) toolCalls[tc.index].id = tc.id;
              if (tc.function?.name) toolCalls[tc.index].name = tc.function.name;
              if (tc.function?.arguments) toolCalls[tc.index].arguments += tc.function.arguments;
            }
          }
        }

        // Usage info
        if (chunk.usage) {
          // We'll send usage at the end
        }
      }

      // Stream finished successfully
      clearTimeout(streamTimeout);

      // Close thinking if still active at end of stream
      if (thinkingActive) {
        thinkingActive = false;
        res.write(`data: ${JSON.stringify({ type: 'thinking_end' })}\n\n`);
      }

      // Build assistant message for history
      const assistantMsg = { role: 'assistant' };
      if (assistantContent) assistantMsg.content = assistantContent;
      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments },
        }));
      }
      agentMessages.push(assistantMsg);

      // No tool calls — we're done
      if (toolCalls.length === 0) {
        lastHadToolCalls = false;
        loopDetect.noProgressCount = 0;
        clearInterval(heartbeat);
        res.write(`data: ${JSON.stringify({ type: 'done', model: agentModel, provider })}\n\n`);
        res.end();
        return;
      }

      // ── Loop detection checks (before executing tools) ──────────
      const responsePrefix = (assistantContent || '').substring(0, 80).toLowerCase().trim();

      // 1. Exact repeat — model said the same thing twice in a row
      if (responsePrefix && responsePrefix === loopDetect.lastAssistantContent.substring(0, 80).toLowerCase().trim()) {
        console.warn(`[agent] Loop detected: exact repeat response (turn ${turn})`);
        clearInterval(heartbeat);
        res.write(`data: ${JSON.stringify({ type: 'loop_detected', reason: 'exact_repeat', message: 'Model is repeating the same response. Stopping to avoid infinite loop.' })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'done', model: agentModel, provider })}\n\n`);
        res.end();
        return;
      }

      // 2. Semantic loop — similar prefixes repeating
      if (responsePrefix) {
        loopDetect.recentPrefixes.push(responsePrefix);
        if (loopDetect.recentPrefixes.length > SEMANTIC_LOOP_WINDOW) {
          loopDetect.recentPrefixes.shift();
        }
        if (loopDetect.recentPrefixes.length >= SEMANTIC_LOOP_THRESHOLD) {
          const prefixWords = loopDetect.recentPrefixes.map(p => new Set(p.split(/\s+/)));
          let similarCount = 0;
          for (let i = 0; i < prefixWords.length - 1; i++) {
            const overlap = [...prefixWords[i]].filter(w => prefixWords[i + 1].has(w));
            const smaller = Math.min(prefixWords[i].size, prefixWords[i + 1].size);
            if (smaller > 0 && overlap.length / smaller >= 0.4) similarCount++;
          }
          if (similarCount >= SEMANTIC_LOOP_THRESHOLD - 1) {
            console.warn(`[agent] Loop detected: semantic repeat (turn ${turn}, ${similarCount + 1} similar)`);
            clearInterval(heartbeat);
            res.write(`data: ${JSON.stringify({ type: 'loop_detected', reason: 'semantic_repeat', message: 'Model is repeating similar responses. Stopping to avoid infinite loop.' })}\n\n`);
            res.write(`data: ${JSON.stringify({ type: 'done', model: agentModel, provider })}\n\n`);
            res.end();
            return;
          }
        }
      }

      // 3. No-progress — turns without meaningful content
      if (!assistantContent || assistantContent.trim().length < 10) {
        loopDetect.noProgressCount++;
        if (loopDetect.noProgressCount >= NO_PROGRESS_LIMIT) {
          console.warn(`[agent] Loop detected: ${loopDetect.noProgressCount} turns without meaningful content (turn ${turn})`);
          clearInterval(heartbeat);
          res.write(`data: ${JSON.stringify({ type: 'loop_detected', reason: 'no_progress', message: 'Model is making tool calls without producing content. Stopping to avoid infinite loop.' })}\n\n`);
          res.write(`data: ${JSON.stringify({ type: 'done', model: agentModel, provider })}\n\n`);
          res.end();
          return;
        }
      } else {
        loopDetect.noProgressCount = 0;
      }

      // 4. Duplicate tool call detection — same tool+args appearing repeatedly
      for (const tc of toolCalls) {
        const callSig = `${tc.name}:${(tc.arguments || '').substring(0, 100)}`;
        loopDetect.recentToolCalls.push(callSig);
        if (loopDetect.recentToolCalls.length > DUPE_CALL_WINDOW) {
          loopDetect.recentToolCalls.shift();
        }
        // Count how many times this exact call signature appears in recent history
        const dupes = loopDetect.recentToolCalls.filter(c => c === callSig).length;
        if (dupes >= DUPE_CALL_LIMIT) {
          console.warn(`[agent] Loop detected: duplicate tool call ${tc.name} (turn ${turn}, ${dupes}x)`);
          clearInterval(heartbeat);
          res.write(`data: ${JSON.stringify({ type: 'loop_detected', reason: 'duplicate_tool_call', message: `Tool ${tc.name} called ${dupes}x with same arguments. Stopping to avoid infinite loop.` })}\n\n`);
          res.write(`data: ${JSON.stringify({ type: 'done', model: agentModel, provider })}\n\n`);
          res.end();
          return;
        }
        loopDetect.totalToolCalls++;
      }

      // Tool calls in progress — mark so next turn skips compact
      lastHadToolCalls = true;
      loopDetect.lastAssistantContent = assistantContent || '';

      // Execute tool calls
      for (const tc of toolCalls) {
        // Check abort before each tool execution
        if (aborted) {
          clearInterval(heartbeat);
          res.write(`data: ${JSON.stringify({ type: 'aborted' })}\n\n`);
          res.end();
          return;
        }

        const toolName = tc.name;
        let toolArgs = {};
        try {
          toolArgs = JSON.parse(tc.arguments || '{}');
        } catch { /* leave empty */ }

        // Notify frontend: tool call starting
        res.write(`data: ${JSON.stringify({ type: 'tool_call_start', tool_call_id: tc.id, tool_name: toolName, tool_args: toolArgs })}\n\n`);

        const onToolStream = (ev) => {
          res.write(`data: ${JSON.stringify({
            type: ev.type,
            tool_call_id: tc.id,
            tool_name: toolName,
            ...(ev.type === 'shell_start' ? { command: ev.command, cwd: ev.cwd } : {}),
            ...(ev.type === 'shell_data' ? { stream: ev.stream, data: ev.data } : {}),
            ...(ev.type === 'shell_end' ? { exit_code: ev.exit_code } : {}),
            ...(ev.type === 'shell_error' ? { error: ev.error } : {}),
          })}\n\n`);
        };

        // Execute the tool — pass per-session allowlist for dangerous commands
        // Merge session-specific + global (default) allowlists
        const sessionSet = sessionAllowedCommands.get(sessionId || 'default');
        const globalSet = sessionAllowedCommands.get('default');
        const allowedCommands = new Set([...(sessionSet || []), ...(globalSet || [])]);
        const result = await executeAgentTool(toolName, toolArgs, workDir, provider, agentModel, onToolStream, allowedCommands);

        // ── Detect __needs_confirmation and emit special SSE event ──
        let needsConfirmation = null;
        try {
          const parsed = JSON.parse(result);
          if (parsed && parsed.__needs_confirmation) needsConfirmation = parsed;
        } catch (_) { /* not JSON */ }
        if (needsConfirmation) {
          res.write(`data: ${JSON.stringify({
            type: 'needs_confirmation',
            tool_call_id: tc.id,
            tool_name: needsConfirmation.tool || toolName,
            reason: needsConfirmation.reason,
            command: needsConfirmation.args?.command || '',
            args: needsConfirmation.args,
          })}\n\n`);
        }

        // Truncate tool results: display gets 4k, model context gets 2500 chars
        // (800 was too aggressive — caused the model to re-query because results were trimmed to uselessness)
        const SHELL_DISPLAY_LIMIT = 4000;
        const SHELL_CONTEXT_LIMIT = 2500;

        // If this was a needs_confirmation result, don't send raw JSON to frontend or model — tell the model to wait
        if (needsConfirmation) {
          const confirmContextResult = `This command requires user confirmation before execution. Waiting for the user to approve or deny the command: ${needsConfirmation.args?.command || '(unknown)'}. Do not retry — explain to the user that they need to approve the command.`;
          agentMessages.push({ role: 'tool', tool_call_id: tc.id, content: confirmContextResult });
          continue;
        }

        // Check if the result contains image URLs (from generate_image tool)
        let imageUrls = null;
        let displayResult = result;
        try {
          const parsed = JSON.parse(result);
          if (parsed && parsed.__image_urls) {
            imageUrls = parsed.__image_urls;
            displayResult = parsed.text || result;
          }
        } catch (_) { /* not JSON, use raw result */ }

        const truncatedResult = displayResult.length > SHELL_DISPLAY_LIMIT ? displayResult.slice(0, SHELL_DISPLAY_LIMIT) + '\n... (truncated)' : displayResult;
        const contextResult = displayResult.length > SHELL_CONTEXT_LIMIT ? displayResult.slice(0, SHELL_CONTEXT_LIMIT) + '\n[trimmed]' : displayResult;

        // Notify frontend: tool call result
        res.write(`data: ${JSON.stringify({ type: 'tool_call_result', tool_call_id: tc.id, tool_name: toolName, tool_result: truncatedResult })}\n\n`);

        // If a file was written/edited, emit a file event so frontend can show a download button
        if (['write_file', 'edit_file', 'patch_file', 'multi_patch'].includes(toolName) && toolArgs.path) {
          res.write(`data: ${JSON.stringify({ type: 'file_created', path: toolArgs.path, tool: toolName })}\n\n`);
        }

        // Notify workspace watchers if a file was written/edited
        if (['write_file', 'edit_file'].includes(toolName) && toolArgs.path) {
          notifyWorkspaceChange(sessionId, toolArgs.path);
        }

        // If generate_image returned image URLs, emit an image event for inline preview
        if (imageUrls && imageUrls.length > 0) {
          for (const imgUrl of imageUrls) {
            res.write(`data: ${JSON.stringify({ type: 'image', url: imgUrl, prompt: toolArgs.prompt || '' })}\n\n`);
          }
        }

        // Add tool result to messages (trimmed for context)
        agentMessages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: contextResult,
        });

        // ── Tool-error loop detection ──
        // Track consecutive errors from the same tool — if a tool errors 3x in a row, break the loop
        const isError = result.toLowerCase().includes('error') || result.toLowerCase().includes('failed') || result.toLowerCase().includes('exception');
        if (isError) {
          const existing = loopDetect.consecutiveToolErrors.find(e => e.name === toolName);
          if (existing) {
            existing.count++;
            if (existing.count >= TOOL_ERROR_LOOP_LIMIT) {
              console.warn(`[agent] Loop detected: tool ${toolName} errored ${existing.count}x in a row (turn ${turn})`);
              clearInterval(heartbeat);
              res.write(`data: ${JSON.stringify({ type: 'loop_detected', reason: 'tool_error', message: `Tool ${toolName} has failed ${existing.count} times in a row. Stopping to avoid retry loop.` })}\n\n`);
              res.write(`data: ${JSON.stringify({ type: 'done', model: agentModel, provider })}\n\n`);
              res.end();
              return;
            }
          } else {
            loopDetect.consecutiveToolErrors = [{ name: toolName, count: 1 }];
          }
        } else {
          // Successful tool call resets error counter
          loopDetect.consecutiveToolErrors = [];
        }
      }

      // Turn marker
      res.write(`data: ${JSON.stringify({ type: 'turn_end', turn })}\n\n`);
    }

    // Hit max turns
    clearInterval(heartbeat);
    res.write(`data: ${JSON.stringify({ type: 'max_turns', maxTurns })}\n\n`);
    res.end();
  } catch (err) {
    clearInterval(heartbeat);
    console.error('[agent] error:', err);
    res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
    res.end();
  }
});

// ── Save messages to a session ────────────────────────────────────
app.post('/api/sessions/:id/messages', (req, res) => {
  const db = getDb();
  const session = db.prepare(`SELECT id FROM sessions WHERE id = ?`).get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const { role, content, inputTokens = 0, outputTokens = 0, latencyMs = 0, provider, model } = req.body;
  if (!['user', 'assistant', 'system'].includes(role)) {
    return res.status(400).json({ error: 'role must be user, assistant, or system' });
  }

  const id = uuidv4();
  db.prepare(
    `INSERT INTO messages (id, session_id, role, content, input_tokens, output_tokens, latency_ms, provider, model)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, req.params.id, role, content, inputTokens, outputTokens, latencyMs, provider || null, model || null);

  res.status(201).json({ id, role, content, createdAt: Date.now() });
});

// ── File system API (scoped to FS_ROOT) ───────────────────────────

function safePath(reqPath) {
  const resolved = path.resolve(FS_ROOT, '.' + reqPath);
  if (!resolved.startsWith(path.resolve(FS_ROOT))) {
    throw new Error('Path traversal blocked');
  }
  return resolved;
}

// Read file
app.get('/api/fs/read', (req, res) => {
  try {
    const filePath = safePath(req.query.path || '/');
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      const entries = fs.readdirSync(filePath).map(name => {
        const full = path.join(filePath, name);
        const s = fs.statSync(full);
        return { name, type: s.isDirectory() ? 'dir' : 'file', size: s.size, modified: s.mtimeMs };
      });
      return res.json({ type: 'dir', path: req.query.path, entries });
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    res.json({ type: 'file', path: req.query.path, content, size: stat.size });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Write file
app.post('/api/fs/write', (req, res) => {
  try {
    const { path: fPath, content } = req.body;
    if (!fPath || content === undefined) return res.status(400).json({ error: 'path and content required' });
    const filePath = safePath(fPath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
    res.json({ ok: true, path: fPath, size: Buffer.byteLength(content) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Diff (apply a patch)
app.post('/api/fs/diff', (req, res) => {
  try {
    const { path: fPath, oldContent, newContent } = req.body;
    if (!fPath) return res.status(400).json({ error: 'path required' });
    const filePath = safePath(fPath);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    const current = fs.readFileSync(filePath, 'utf-8');
    const changes = diffLines(oldContent || current, newContent);

    if (newContent !== undefined) {
      fs.writeFileSync(filePath, newContent, 'utf-8');
    }

    res.json({
      ok: true,
      path: fPath,
      changes: changes.map(c => ({
        value: c.value,
        added: c.added,
        removed: c.removed,
        count: c.count,
      })),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Delete file/dir
app.delete('/api/fs/delete', (req, res) => {
  try {
    const filePath = safePath(req.query.path || '/');
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      fs.rmSync(filePath, { recursive: true });
    } else {
      fs.unlinkSync(filePath);
    }
    res.json({ ok: true, path: req.query.path });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/fs/download?path=/some/file — Download any file from server filesystem
app.get('/api/fs/download', (req, res) => {
  try {
    const filePath = safePath(req.query.path || '/');
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) return res.status(400).json({ error: 'Cannot download a directory' });
    const filename = path.basename(filePath);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', stat.size);
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Artifact System (App Builder) ──────────────────────────────────
const archiver = require('archiver');

// System prompt for app generation
const APP_BUILDER_SYSTEM = `You are haksterAi App Builder, an expert full-stack developer. When the user asks you to build an app, website, or tool, you MUST output the complete code as structured artifacts.

FORMAT: Output each file as a fenced code block with the filename in the header, like:

---filename:index.html---
(complete file content here)
---end---

---filename:style.css---
(complete file content here)
---end---

---filename:script.js---
(complete file content here)
---end---

RULES:
1. ALWAYS output at least one HTML file called index.html (this is the main entry point)
2. Include ALL CSS inline or in a linked style.css file
3. Include ALL JavaScript inline or in a linked script.js file
4. Make it COMPLETE and RUNNABLE — no placeholders, no "..." marks, no "// rest of code here"
5. Use modern HTML5, CSS3, and vanilla JS (no frameworks needed unless user specifies)
6. Make it responsive and mobile-friendly
7. Use a dark theme by default (background: #0a0a0f, text: #e2e8f0, accent: #7c3aed)
8. Add smooth animations and transitions for a polished feel
9. If the app needs data, include sample/mock data directly in the JS
10. Everything must work in a single browser tab with no server required
11. You can use CDN links for libraries (Tailwind, Chart.js, etc.)
12. For images, use emoji, SVG inline, or placeholder URLs

Output ONLY the file blocks. No explanation before or after. Just the code.`;

// Parse artifact files from AI response
function parseArtifacts(content) {
  const files = [];
  const regex = /---filename:(.+?)---\n([\s\S]*?)---end---/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    files.push({ filename: match[1].trim(), content: match[2].trim() });
  }

  // Fallback: if no ---filename: markers found, try code blocks with filenames
  if (files.length === 0) {
    const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;
    let codeMatch;
    let htmlFound = false;
    while ((codeMatch = codeBlockRegex.exec(content)) !== null) {
      let lang = codeMatch[1] || 'txt';
      let code = codeMatch[2];
      // Detect if it's HTML
      if (lang === 'html' || code.trim().startsWith('<!DOCTYPE') || code.trim().startsWith('<html') || code.trim().startsWith('<div')) {
        files.push({ filename: 'index.html', content: code.trim() });
        htmlFound = true;
      } else if (lang === 'css' || lang === 'stylesheet') {
        files.push({ filename: 'style.css', content: code.trim() });
      } else if (lang === 'javascript' || lang === 'js') {
        files.push({ filename: 'script.js', content: code.trim() });
      }
    }

    // If still nothing, try to find any HTML-like content
    if (files.length === 0) {
      const htmlMatch = content.match(/<[\s\S]*?(?:<\/html>|<\/body>)/i);
      if (htmlMatch) {
        files.push({ filename: 'index.html', content: htmlMatch[0].trim() });
      }
    }
  }

  // Determine main file
  const mainFile = files.find(f => f.filename === 'index.html')?.filename || files[0]?.filename || 'index.html';

  return { files, mainFile };
}

// POST /api/generate — Generate an app from description with full agent loop + tools
app.post('/api/generate', async (req, res) => {
  const { provider = 'ollama', model, description, thinking = false, images = [] } = req.body;
  if (isCerebrasValue(provider) || isCerebrasValue(model)) {
    return res.status(400).json({ error: 'Cerebras models are disabled' });
  }
  if (!description && images.length === 0) return res.status(400).json({ error: 'description or images required' });

  const cfg = PROVIDERS[provider];
  if (!cfg) return res.status(400).json({ error: `Unknown provider: ${provider}` });

  const sessionId = req.body.sessionId || null;
  const FS_ROOT = process.env.FS_ROOT || path.join(__dirname, '..', 'data');
  const workDir = req.body.cwd || path.join(FS_ROOT, 'workspaces', sessionId || 'build-default');
  if (!req.body.cwd) fs.mkdirSync(workDir, { recursive: true });

  const agentModel = model || cfg.defaultModel;
  const maxTurns = 25;

  // Build user message — multimodal if images attached
  let userContent;
  if (images.length > 0) {
    const parts = [];
    if (description) parts.push({ type: 'text', text: description });
    for (const img of images) {
      parts.push({ type: 'image_url', image_url: { url: img.dataUrl, detail: 'auto' } });
    }
    userContent = parts;
  } else {
    userContent = description;
  }

  // System prompt: combine app builder instructions with agent tool awareness
  const machineCtx = await getMachineContext();
  const machineCtxText = machineCtx.error
    ? ''
    : `\n\n=== User Machine Context ===\n` +
      `OS: ${machineCtx.os?.name || 'unknown'} ${machineCtx.os?.version || ''} (${machineCtx.os?.arch || ''})\n` +
      `Hostname: ${machineCtx.os?.hostname || 'unknown'} | User: ${machineCtx.runtime?.user || 'unknown'}\n` +
      `CPU: ${machineCtx.cpu?.model || 'unknown'}, ${machineCtx.cpu?.cores || 0} cores\n` +
      `Memory: total ${machineCtx.memory?.total ? Math.round(machineCtx.memory.total / 1024 / 1024 / 1024) + 'GB' : 'unknown'}, ${machineCtx.memory?.pct || 0}% used\n` +
      `Runtime: Node ${machineCtx.runtime?.node || ''}, Shell ${machineCtx.runtime?.shell || ''}\n` +
      `Known projects/folders: ${(machineCtx.folders || []).map(f => `${f.label} (${f.path})`).join(', ') || 'none'}\n` +
      `Services: ${(machineCtx.services || []).map(s => `${s.name}:${s.port || '?'}`).join(', ') || 'none'}\n` +
      `Listening ports: ${(machineCtx.ports || []).map(p => `${p.port}/${p.process}`).join(', ') || 'none'}\n` +
      `Use this context to pick the right commands, paths, and tech stack for this machine. Remember this context across turns.`;

  const firecrawlKeys = getFirecrawlKeys();
  const firecrawlHint = firecrawlKeys.length > 0
    ? ' Firecrawl is configured with rotating keys; use web_search and firecrawl_scrape to pull live docs/examples when needed.'
    : '';

  const BUILD_SYSTEM = APP_BUILDER_SYSTEM + '\n\n' + AGENT_SYSTEM_PROMPT + machineCtxText + '\n\nYou have tools available: read_file, write_file, edit_file, list_dir, exec_shell, browser_navigate, browser_snapshot, browser_screenshot, generate_image, web_search, firecrawl_scrape.' + firecrawlHint + ' Use them to inspect the workspace, search the web for docs/examples, scrape reference pages, generate images for the app, run shell commands (build/test), and write files directly. After using tools, still output the complete app as structured artifacts in the format above.';

  const messages = [
    { role: 'system', content: BUILD_SYSTEM },
    { role: 'user', content: userContent },
  ];

  // Build OpenAI-compatible client (same pattern as /api/agent/run)
  let client;
  if (cfg.type === 'anthropic' || cfg.type === 'claude-proxy') {
    const ollamaCfg = PROVIDERS.ollama;
    client = new OpenAIClient({
      apiKey: ollamaCfg.apiKey || 'ollama',
      baseURL: `${ollamaCfg.baseURL.replace(/\/$/, '')}/v1`,
    });
  } else if (cfg.type === 'openai-compat') {
    client = new OpenAIClient({
      apiKey: cfg.apiKey || 'ollama',
      baseURL: `${cfg.baseURL.replace(/\/v1\/?$/, '').replace(/\/$/, '')}/v1`,
    });
  } else {
    client = new OpenAIClient({
      apiKey: cfg.apiKey,
      baseURL: cfg.baseURL,
    });
  }

  // SSE setup
  let aborted = false;
  res.on('close', () => { aborted = true; clearInterval(heartbeat); });
  const heartbeat = setInterval(() => {
    if (!aborted) { try { res.write(`:heartbeat\n\n`); } catch {} }
  }, 15000);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Loop detection state
  let loopDetect = {
    lastAssistantContent: '',
    noProgressCount: 0,
    recentToolCalls: [],
    totalToolCalls: 0,
  };
  const NO_PROGRESS_LIMIT = 4;
  const DUPE_CALL_WINDOW = 4;
  const DUPE_CALL_LIMIT = 3;
  const MAX_OUTPUT_TOKENS = 16384;

  try {
    let fullContent = '';
    let finalMeta = null;

    for (let turn = 0; turn < maxTurns; turn++) {
      if (aborted) {
        clearInterval(heartbeat);
        res.write(`data: ${JSON.stringify({ type: 'aborted' })}\n\n`);
        res.end();
        return;
      }

      // Stream model response with tool support
      const streamAbort = new AbortController();
      const streamTimeout = setTimeout(() => { streamAbort.abort(); }, 120000);

      let stream;
      try {
        stream = await client.chat.completions.create({
          model: agentModel,
          messages: sanitizeMessagesForProvider(messages, provider),
          tools: AGENT_TOOLS,
          stream: true,
          max_tokens: MAX_OUTPUT_TOKENS,
        }, { signal: streamAbort.signal });
      } catch (streamErr) {
        clearTimeout(streamTimeout);
        if (streamErr.name === 'AbortError') {
          res.write(`data: ${JSON.stringify({ type: 'error', message: 'Model response timed out (120s).' })}\n\n`);
          break;
        }
        throw streamErr;
      }

      let assistantContent = '';
      const toolCalls = [];
      let thinkingActive = false;

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;

        // Reasoning / thinking content
        const thinkingContent = delta.reasoning_content || delta.thinking;
        if (thinkingContent) {
          if (!thinkingActive) {
            thinkingActive = true;
            res.write(`data: ${JSON.stringify({ type: 'thinking_start' })}\n\n`);
          }
          res.write(`data: ${JSON.stringify({ type: 'thinking', content: thinkingContent })}\n\n`);
        }
        if (thinkingActive && (delta.content || delta.tool_calls)) {
          thinkingActive = false;
          res.write(`data: ${JSON.stringify({ type: 'thinking_end' })}\n\n`);
        }

        // Text content
        if (delta.content) {
          assistantContent += delta.content;
          fullContent += delta.content;
          res.write(`data: ${JSON.stringify({ type: 'delta', content: delta.content })}\n\n`);
        }

        // Tool calls — accumulate
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (tc.index !== undefined) {
              if (!toolCalls[tc.index]) {
                toolCalls[tc.index] = { id: tc.id || '', name: tc.function?.name || '', arguments: '' };
              }
              if (tc.id) toolCalls[tc.index].id = tc.id;
              if (tc.function?.name) toolCalls[tc.index].name = tc.function.name;
              if (tc.function?.arguments) toolCalls[tc.index].arguments += tc.function.arguments;
            }
          }
        }
      }

      clearTimeout(streamTimeout);
      if (thinkingActive) {
        thinkingActive = false;
        res.write(`data: ${JSON.stringify({ type: 'thinking_end' })}\n\n`);
      }

      // Build assistant message
      const assistantMsg = { role: 'assistant' };
      if (assistantContent) assistantMsg.content = assistantContent;
      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls.map(tc => ({
          id: tc.id, type: 'function',
          function: { name: tc.name, arguments: tc.arguments },
        }));
      }
      messages.push(assistantMsg);

      // No tool calls — we're done
      if (toolCalls.length === 0) {
        loopDetect.noProgressCount = 0;
        finalMeta = { model: agentModel, provider, inputTokens: 0, outputTokens: 0, latency: 0, cost: 0 };
        break;
      }

      // Loop detection: no-progress
      if (!assistantContent || assistantContent.trim().length < 10) {
        loopDetect.noProgressCount++;
        if (loopDetect.noProgressCount >= NO_PROGRESS_LIMIT) {
          res.write(`data: ${JSON.stringify({ type: 'loop_detected', reason: 'no_progress', message: 'Stopping: no meaningful content for several turns.' })}\n\n`);
          break;
        }
      } else {
        loopDetect.noProgressCount = 0;
      }

      // Loop detection: duplicate tool calls
      for (const tc of toolCalls) {
        const callSig = `${tc.name}:${(tc.arguments || '').substring(0, 100)}`;
        loopDetect.recentToolCalls.push(callSig);
        if (loopDetect.recentToolCalls.length > DUPE_CALL_WINDOW) loopDetect.recentToolCalls.shift();
        const dupes = loopDetect.recentToolCalls.filter(c => c === callSig).length;
        if (dupes >= DUPE_CALL_LIMIT) {
          res.write(`data: ${JSON.stringify({ type: 'loop_detected', reason: 'duplicate_tool_call', message: `Tool ${tc.name} called ${dupes}x with same args. Stopping.` })}\n\n`);
          break;
        }
        loopDetect.totalToolCalls++;
      }

      loopDetect.lastAssistantContent = assistantContent || '';

      // Execute tool calls
      for (const tc of toolCalls) {
        if (aborted) { clearInterval(heartbeat); res.write(`data: ${JSON.stringify({ type: 'aborted' })}\n\n`); res.end(); return; }

        const toolName = tc.name;
        let toolArgs = {};
        try { toolArgs = JSON.parse(tc.arguments || '{}'); } catch {}

        res.write(`data: ${JSON.stringify({ type: 'tool_call_start', tool_call_id: tc.id, tool_name: toolName, tool_args: toolArgs })}\n\n`);

        // Stream live shell stdout/stderr to the frontend terminal as it happens
        const onToolStream = (ev) => {
          res.write(`data: ${JSON.stringify({
            type: ev.type,
            tool_call_id: tc.id,
            tool_name: toolName,
            ...(ev.type === 'shell_start' ? { command: ev.command, cwd: ev.cwd } : {}),
            ...(ev.type === 'shell_data' ? { stream: ev.stream, data: ev.data } : {}),
            ...(ev.type === 'shell_end' ? { exit_code: ev.exit_code } : {}),
            ...(ev.type === 'shell_error' ? { error: ev.error } : {}),
          })}\n\n`);
        };

        const result = await executeAgentTool(toolName, toolArgs, workDir, provider, agentModel, onToolStream);

        // Check for image URLs in result
        let imageUrls = null;
        let displayResult = result;
        try {
          const parsed = JSON.parse(result);
          if (parsed && parsed.__image_urls) {
            imageUrls = parsed.__image_urls;
            displayResult = parsed.text || result;
          }
        } catch {}

        const SHELL_DISPLAY_LIMIT = 4000;
        const SHELL_CONTEXT_LIMIT = 2500;
        const truncatedResult = displayResult.length > SHELL_DISPLAY_LIMIT ? displayResult.slice(0, SHELL_DISPLAY_LIMIT) + '\n... (truncated)' : displayResult;
        const contextResult = displayResult.length > SHELL_CONTEXT_LIMIT ? displayResult.slice(0, SHELL_CONTEXT_LIMIT) + '\n[trimmed]' : displayResult;

        res.write(`data: ${JSON.stringify({ type: 'tool_call_result', tool_call_id: tc.id, tool_name: toolName, tool_result: truncatedResult })}\n\n`);

        // Emit image events for inline preview
        if (imageUrls && imageUrls.length > 0) {
          for (const imgUrl of imageUrls) {
            res.write(`data: ${JSON.stringify({ type: 'image', url: imgUrl, prompt: toolArgs.prompt || '' })}\n\n`);
          }
        }

        messages.push({ role: 'tool', tool_call_id: tc.id, content: contextResult });
      }
    }

    clearInterval(heartbeat);

    // Parse artifacts from accumulated content
    const parsed = parseArtifacts(fullContent);

    if (parsed.files.length > 0) {
      const db = getDb();
      const artifactId = uuidv4();

      db.prepare(
        `INSERT INTO artifacts (id, session_id, title, description, provider, model, files, main_file)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        artifactId,
        sessionId,
        description.slice(0, 100),
        description,
        provider,
        finalMeta?.model || agentModel || 'unknown',
        JSON.stringify(parsed.files),
        parsed.mainFile
      );

      res.write(`data: ${JSON.stringify({ type: 'artifact', artifact: { id: artifactId, title: description.slice(0, 100), files: parsed.files, mainFile: parsed.mainFile } })}\n\n`);
    }

    if (finalMeta) {
      const db = getDb();
      const reqId = uuidv4();
      db.prepare(
        `INSERT INTO requests (id, session_id, type, provider, model, input_tokens, output_tokens, latency_ms, cost, status)
         VALUES (?, ?, 'generate', ?, ?, ?, ?, ?, ?, 'ok')`
      ).run(reqId, sessionId, provider, finalMeta.model, finalMeta.inputTokens, finalMeta.outputTokens, finalMeta.latency, finalMeta.cost);
    }

    res.write(`data: ${JSON.stringify({ type: 'done', ...(finalMeta || { model: agentModel, provider }) })}\n\n`);
    res.end();
  } catch (err) {
    console.error('[generate] error:', err);
    clearInterval(heartbeat);
    res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
    res.end();
  }
});

// GET /api/artifacts — List all artifacts
app.get('/api/artifacts', (_req, res) => {
  const db = getDb();
  const artifacts = db.prepare(`SELECT id, title, description, provider, model, main_file, created_at FROM artifacts ORDER BY created_at DESC`).all();
  res.json({ artifacts });
});

// GET /api/artifacts/:id — Get artifact with files
app.get('/api/artifacts/:id', (req, res) => {
  const db = getDb();
  const artifact = db.prepare(`SELECT * FROM artifacts WHERE id = ?`).get(req.params.id);
  if (!artifact) return res.status(404).json({ error: 'Artifact not found' });

  res.json({
    ...artifact,
    files: JSON.parse(artifact.files),
  });
});

// DELETE /api/artifacts/:id — Delete artifact
app.delete('/api/artifacts/:id', (req, res) => {
  const db = getDb();
  const del = db.prepare(`DELETE FROM artifacts WHERE id = ?`).run(req.params.id);
  if (del.changes === 0) return res.status(404).json({ error: 'Artifact not found' });
  // Also delete preview files from disk
  const previewDir = path.join(__dirname, '../../data/previews', req.params.id);
  if (fs.existsSync(previewDir)) {
    fs.rmSync(previewDir, { recursive: true });
  }
  res.json({ deleted: true });
});

// GET /api/artifacts/:id/download — Download artifact as ZIP
app.get('/api/artifacts/:id/download', (req, res) => {
  const db = getDb();
  const artifact = db.prepare(`SELECT * FROM artifacts WHERE id = ?`).get(req.params.id);
  if (!artifact) return res.status(404).json({ error: 'Artifact not found' });

  const files = JSON.parse(artifact.files);
  const title = artifact.title.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${title}.zip"`);

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.pipe(res);

  for (const file of files) {
    archive.append(Buffer.from(file.content, 'utf-8'), { name: file.filename });
  }

  archive.finalize();
});

// GET /preview/:id — Serve artifact preview (live sandboxed app)
app.get('/preview/:id', (req, res) => {
  const db = getDb();
  const artifact = db.prepare(`SELECT * FROM artifacts WHERE id = ?`).get(req.params.id);
  if (!artifact) return res.status(404).send('Artifact not found');

  const files = JSON.parse(artifact.files);
  const mainFile = artifact.main_file || files[0]?.filename;

  // Find main HTML file
  let html = files.find(f => f.filename === 'index.html')?.content
    || files.find(f => f.filename.endsWith('.html'))?.content;

  if (!html) {
    // Construct an HTML wrapper if only JS/CSS provided
    const css = files.find(f => f.filename.endsWith('.css'))?.content || '';
    const js = files.find(f => f.filename.endsWith('.js'))?.content || '';
    html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${artifact.title}</title>
<style>${css}</style>
</head>
<body>
<script>${js}</script>
</body>
</html>`;
  } else {
    // Inject CSS and JS files if referenced
    const css = files.find(f => f.filename.endsWith('.css'));
    const js = files.find(f => f.filename.endsWith('.js'));
    if (css && !html.includes('style.css')) {
      html = html.replace('</head>', `<style>${css.content}</style>\n</head>`);
    }
    if (js && !html.includes('script.js')) {
      html = html.replace('</body>', `<script>${js.content}</script>\n</body>`);
    }
  }

  res.setHeader('Content-Type', 'text/html');
  res.setHeader('Content-Security-Policy', "default-src 'unsafe-inline' 'unsafe-eval' * data: blob:;");
  res.send(html);
});

// ── Image Generation ────────────────────────────────────────────────
app.post('/api/images/generate', async (req, res) => {
  const { provider = 'openai', model = 'dall-e-3', prompt, size = '1024x1024', quality = 'standard' } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt required' });

  try {
    const result = await generateImage({ provider, model, prompt, size, quality });
    res.json(result);
  } catch (err) {
    console.error('[image-gen] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Image Analysis (Vision) ────────────────────────────────────────
app.post('/api/images/analyze', async (req, res) => {
  const { provider = 'openai', model, prompt, imageBase64, imageUrl, mimeType } = req.body;
  if (!imageBase64 && !imageUrl) return res.status(400).json({ error: 'imageBase64 or imageUrl required' });
  if (!prompt) return res.status(400).json({ error: 'prompt required (e.g. "Describe this image" or "Enhance and describe")' });

  try {
    const result = await analyzeImage({ provider, model, prompt, imageBase64, imageUrl, mimeType });
    res.json(result);
  } catch (err) {
    console.error('[image-analyze] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Stats ──────────────────────────────────────────────────────────
// ── Dashboard stats ────────────────────────────────────────────────
app.get('/api/dashboard', (_req, res) => {
  const db = getDb();

  // Request stats
  const totalRequests = db.prepare(`SELECT COUNT(*) as count FROM requests`).get().count;
  const totalTokens = db.prepare(`SELECT SUM(input_tokens + output_tokens) as total FROM requests`).get().total || 0;
  const totalCost = db.prepare(`SELECT SUM(cost) as total FROM requests`).get().total || 0;
  const byProvider = db.prepare(
    `SELECT provider, COUNT(*) as requests, SUM(input_tokens) as inputTokens, SUM(output_tokens) as outputTokens, SUM(cost) as cost FROM requests GROUP BY provider`
  ).all();
  const toolCallRows = db.prepare(
    `SELECT SUM(output_tokens) as total FROM requests WHERE status = 'ok'`
  ).get();
  const totalToolCalls = toolCallRows?.total || 0;
  const sessionCount = db.prepare(`SELECT COUNT(*) as count FROM sessions`).get().count;
  const messageCount = db.prepare(`SELECT COUNT(*) as count FROM messages`).get().count;
  const artifactCount = db.prepare(`SELECT COUNT(*) as count FROM artifacts`).get().count;

  // Active sessions (updated in last hour)
  const activeSessions = db.prepare(
    `SELECT COUNT(*) as count FROM sessions WHERE updated_at > datetime('now', '-1 hour')`
  ).get().count;

  // System info
  const cpus = os.cpus().length;
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const uptime = os.uptime();

  // Running servers / ports — dynamically detected
  const runningServices = [];
  const knownServices = {
    22: { name: 'SSH' },
    80: { name: 'Apache' },
    3579: { name: 'haksterAi' },
    4040: { name: 'ngrok' },
    8081: { name: 'CineVault' },
    8888: { name: 'StalkerHEK' },
    9999: { name: 'StalkerHEK-SSL' },
    11434: { name: 'Ollama' },
    20241: { name: 'cloudflared' },
  };
  const hiddenProcesses = new Set(['systemd', 'systemd-resolve', 'cupsd', 'tor', 'containerd', 'obfs4proxy', 'warpinator', '.cline']);
  try {
    const { execSync } = require('child_process');
    const ssOut = execSync("ss -tlnp 2>/dev/null | awk 'NR>1 {print $4, $6}'", { encoding: 'utf8' });
    const portMap = {};
    for (const line of ssOut.split('\n').filter(Boolean)) {
      const m = line.match(/[:](\d+)\s+(.*)/);
      if (m) portMap[m[1]] = m[2].trim();
    }
    for (const [port, info] of Object.entries(portMap)) {
      const procName = (info.match(/"([^"]+)"/) || [])[1] || info.split(/[\s(]/)[0].replace(/^users:/, '') || 'node';
      if (hiddenProcesses.has(procName)) continue;
      const known = knownServices[port];
      runningServices.push({
        name: known?.name || procName || 'unknown',
        port: parseInt(port, 10),
        status: 'running',
        process: procName,
      });
    }
  } catch {
    runningServices.push({ name: 'haksterAi', port: PORT, status: 'running' });
  }

  // HaksterAi model config (separate from crush — crush overwrites its own config)
  const haksterConfigPath = path.join(__dirname, '..', 'hakster-config.json');
  let haksterModel = 'gpt-oss:120b-cloud';
  let haksterProvider = 'ollama';
  try {
    const haksterCfg = JSON.parse(fs.readFileSync(haksterConfigPath, 'utf8'));
    haksterModel = haksterCfg.model || haksterModel;
    haksterProvider = haksterCfg.provider || haksterProvider;
  } catch {}
  let crushModel = haksterModel;
  let crushProvider = haksterProvider;
  const skillsInventory = getSkillsInventory();
  const toolInventory = getToolInventory();

  // Crush DB stats (tool calls, reasoning, sessions)
  let crushStats = { sessions: 0, messages: 0, promptTokens: 0, completionTokens: 0, toolCalls: 0, uniqueTools: 0, toolBreakdown: {}, reasoningSteps: 0, files: 0 };
  const crushDbPaths = [
    path.join('/home/ghost', '.crush', 'crush.db'),
    path.join(os.homedir(), '.crush', 'crush.db'),
  ];
  for (const crushDbPath of crushDbPaths) {
    try {
      if (fs.existsSync(crushDbPath)) {
        const Database = require('better-sqlite3');
        const cdb = new Database(crushDbPath, { readonly: true });
        crushStats.sessions = cdb.prepare('SELECT COUNT(*) as c FROM sessions').get().c || 0;
        crushStats.messages = cdb.prepare('SELECT COUNT(*) as c FROM messages').get().c || 0;
        crushStats.promptTokens = cdb.prepare('SELECT SUM(prompt_tokens) as s FROM sessions').get().s || 0;
        crushStats.completionTokens = cdb.prepare('SELECT SUM(completion_tokens) as s FROM sessions').get().s || 0;
        crushStats.files = cdb.prepare('SELECT COUNT(*) as c FROM files').get().c || 0;

        // Parse tool calls, reasoning, and tool results from messages
        const msgs = cdb.prepare('SELECT parts FROM messages').all();
        const toolCount = {};
        let reasoningSteps = 0;
        let toolResultCount = 0;
        let browserActions = 0;
        let snapshots = 0;
        for (const m of msgs) {
          try {
            const parts = JSON.parse(m.parts);
            for (const p of parts) {
              if (p.type === 'tool_call' && p.data?.name) {
                toolCount[p.data.name] = (toolCount[p.data.name] || 0) + 1;
                // Track browser-related actions
                const n = p.data.name.toLowerCase();
                if (n.includes('browser') || n.includes('click') || n.includes('navigate') || n.includes('screenshot') || n.includes('snapshot') || n === 'web') {
                  browserActions++;
                }
                // Track snapshot/screenshot calls
                if (n.includes('snapshot') || n.includes('screenshot')) {
                  snapshots++;
                }
              }
              if (p.type === 'tool_result') {
                toolResultCount++;
                if (p.data?.name) {
                  const n = p.data.name.toLowerCase();
                  if (n.includes('browser') || n.includes('click') || n.includes('navigate') || n.includes('screenshot') || n.includes('snapshot') || n === 'web') {
                    browserActions++;
                  }
                }
              }
              if (p.type === 'reasoning') reasoningSteps++;
            }
          } catch {}
        }
        crushStats.toolCalls = Object.values(toolCount).reduce((a, b) => a + b, 0);
        crushStats.uniqueTools = Object.keys(toolCount).length;
        crushStats.toolBreakdown = toolCount;
        crushStats.reasoningSteps = reasoningSteps;
        crushStats.toolResults = toolResultCount;
        crushStats.browserActions = browserActions;
        crushStats.snapshots = snapshots;
        cdb.close();
        break; // found it, stop searching
      }
    } catch (e) { console.error('[dashboard] crush stats error for', crushDbPath, ':', e.message); }
  }

  // Crush version + latest GitHub release
  let crushVersion = 'unknown';
  try { crushVersion = require('child_process').execSync('crush --version 2>/dev/null', { encoding: 'utf8' }).trim().split('\n').pop().replace(/^.*?(\d+\.\d+\.\d+).*$/, '$1'); } catch {}

  res.json({
    requests: { total: totalRequests, totalTokens, totalCost, byProvider, outputTokens: totalToolCalls },
    sessions: { total: sessionCount, active: activeSessions, messages: messageCount, artifacts: artifactCount },
    system: { cpus, totalMem, freeMem, uptime, hostname: os.hostname(), platform: os.platform(), arch: os.arch() },
    services: runningServices,
    crush: { model: crushModel, provider: crushProvider, version: crushVersion, stats: crushStats },
    agent: { tools: toolInventory, skills: skillsInventory },
    providers: Object.entries(PROVIDERS)
      .filter(([key, cfg]) => !isCerebrasValue(key) && !isCerebrasValue(cfg.name) && !isCerebrasValue(cfg.defaultModel))
      .map(([key, cfg]) => ({ id: key, name: cfg.name, type: cfg.type, defaultModel: cfg.defaultModel })),
  });
});

// ── Crush config update (model/provider switch) ──────────────────
app.post('/api/crush/config', express.json(), (req, res) => {
  try {
  const { provider, model } = req.body;
    if (!provider || !model) return res.status(400).json({ error: 'provider and model are required' });
    if (isCerebrasValue(provider) || isCerebrasValue(model)) {
      return res.status(400).json({ error: 'Cerebras models are disabled' });
    }
    // Save to haksterAi's own config (crush can't overwrite this)
    const haksterConfigPath = path.join(__dirname, '..', 'hakster-config.json');
    fs.writeFileSync(haksterConfigPath, JSON.stringify({ provider, model }, null, 2));
    // Update crush DATA file (runtime)
    const crushDataPath = path.join(os.homedir(), '.local/share/crush/crush.json');
    let crushCfg = {};
    try {
      crushCfg = JSON.parse(fs.readFileSync(crushDataPath, 'utf8'));
    } catch {}
    if (!crushCfg.models) crushCfg.models = {};
    if (!crushCfg.models.large) crushCfg.models.large = {};
    if (!crushCfg.models.small) crushCfg.models.small = {};
    crushCfg.models.large.model = model;
    crushCfg.models.large.provider = provider;
    crushCfg.models.small.model = model;
    crushCfg.models.small.provider = provider;
    // Purge cerebras from recent_models — not a valid haksterAi provider
    if (crushCfg.recent_models) {
      for (const size of ['large', 'small']) {
        if (Array.isArray(crushCfg.recent_models[size])) {
          crushCfg.recent_models[size] = crushCfg.recent_models[size].filter(m => m.provider !== 'cerebras');
        }
      }
    }
    fs.writeFileSync(crushDataPath, JSON.stringify(crushCfg, null, 2));
    // Update crush CONFIG file (what crush reads on startup)
    const crushConfigDir = path.join(os.homedir(), '.config/crush/crush.json');
    try {
      let crushConf = JSON.parse(fs.readFileSync(crushConfigDir, 'utf8'));
      crushConf.models = crushConf.models || {};
      crushConf.models.large = crushConf.models.large || {};
      crushConf.models.small = crushConf.models.small || {};
      crushConf.models.large.model = model;
      crushConf.models.large.provider = provider;
      crushConf.models.small.model = model;
      crushConf.models.small.provider = provider;
      fs.writeFileSync(crushConfigDir, JSON.stringify(crushConf, null, 2));
    } catch (e) { console.error('[crush] config dir update error:', e.message); }
    console.log(`[crush] config updated: provider=${provider}, model=${model}`);
    res.json({ ok: true, provider, model, config: crushCfg });
  } catch (e) {
    console.error('[crush] config update error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Crush auto-update check ────────────────────────────────────────
let _crushUpdateCache = { data: null, checkedAt: 0 };
app.get('/api/crush-update', async (_req, res) => {
  const now = Date.now();
  // Cache for 1 hour
  if (_crushUpdateCache.data && now - _crushUpdateCache.checkedAt < 3600000) {
    return res.json(_crushUpdateCache.data);
  }
  try {
    const https = require('https');
    const ghData = await new Promise((resolve, reject) => {
      https.get('https://api.github.com/repos/charmbracelet/crush/releases?per_page=5', { headers: { 'User-Agent': 'haksterAi' } }, (r) => {
        let b = ''; r.on('data', c => b += c); r.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve([]); } }); r.on('error', reject);
      }).on('error', reject);
    });
    // Find latest stable (non-prerelease) release
    const stable = (Array.isArray(ghData) ? ghData : []).find(r => !r.prerelease && r.tag_name);
    const latestTag = stable ? stable.tag_name.replace(/^v/, '') : '';
    let currentVer = 'unknown';
    try { currentVer = require('child_process').execSync('crush --version 2>/dev/null', { encoding: 'utf8' }).trim().split('\n').pop().replace(/^.*?(\d+\.\d+\.\d+).*$/, '$1'); } catch {}
    const needsUpdate = latestTag && currentVer !== 'unknown' && latestTag !== currentVer;
    _crushUpdateCache = {
      data: { currentVersion: currentVer, latestVersion: latestTag || 'unknown', needsUpdate, releaseUrl: stable?.html_url || '', releaseNotes: (stable?.body || '').substring(0, 500), publishedAt: stable?.published_at || '' },
      checkedAt: now,
    };
    res.json(_crushUpdateCache.data);
  } catch (e) {
    res.json({ currentVersion: 'unknown', latestVersion: 'unknown', needsUpdate: false, error: e.message });
  }
});

app.get('/api/stats', (_req, res) => {
  const db = getDb();
  const totalRequests = db.prepare(`SELECT COUNT(*) as count FROM requests`).get().count;
  const totalTokens = db.prepare(`SELECT SUM(input_tokens + output_tokens) as total FROM requests`).get().total || 0;
  const totalCost = db.prepare(`SELECT SUM(cost) as total FROM requests`).get().total || 0;
  const byProvider = db.prepare(
    `SELECT provider, COUNT(*) as requests, SUM(input_tokens) as inputTokens, SUM(output_tokens) as outputTokens, SUM(cost) as cost FROM requests GROUP BY provider`
  ).all();

  res.json({ totalRequests, totalTokens, totalCost, byProvider });
});

// ── Users, Logs & Audit API ────────────────────────────────────────
app.get('/api/users', (_req, res) => {
  const db = getDb();
  const users = db.prepare(`SELECT id, username, email, role, plan, status, created_at, updated_at, last_login_at, last_login_ip FROM users ORDER BY created_at DESC`).all();
  const stats = {
    total: users.length,
    byRole: {},
    byPlan: {},
    byStatus: {},
  };
  for (const u of users) {
    stats.byRole[u.role] = (stats.byRole[u.role] || 0) + 1;
    stats.byPlan[u.plan] = (stats.byPlan[u.plan] || 0) + 1;
    stats.byStatus[u.status] = (stats.byStatus[u.status] || 0) + 1;
  }
  res.json({ users, stats });
});

app.get('/api/users/:id', (req, res) => {
  const db = getDb();
  const user = db.prepare(`SELECT id, username, email, role, plan, status, created_at, updated_at, last_login_at, last_login_ip FROM users WHERE id = ?`).get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  // Get user's sessions and requests
  const sessions = db.prepare(`SELECT id, provider, model, total_tokens, total_cost, created_at, updated_at FROM sessions WHERE id IN (SELECT session_id FROM requests WHERE ? = 'placeholder') ORDER BY updated_at DESC LIMIT 20`).all();
  const requestCount = db.prepare(`SELECT COUNT(*) as c FROM requests`).get().c;
  const accessLogs = db.prepare(`SELECT * FROM access_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`).all(req.params.id);
  const auditLogs = db.prepare(`SELECT * FROM api_key_audit WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`).all(req.params.id);
  res.json({ ...user, requestCount, accessLogs, auditLogs });
});

app.get('/api/access-logs', (req, res) => {
  const db = getDb();
  const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
  const offset = parseInt(req.query.offset) || 0;
  const userId = req.query.user_id;
  const endpoint = req.query.endpoint;

  let query = `SELECT al.*, u.username FROM access_logs al LEFT JOIN users u ON al.user_id = u.id WHERE 1=1`;
  const params = [];
  if (userId) { query += ` AND al.user_id = ?`; params.push(userId); }
  if (endpoint) { query += ` AND al.endpoint LIKE ?`; params.push(`%${endpoint}%`); }
  query += ` ORDER BY al.created_at DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  const logs = db.prepare(query).all(...params);
  const total = db.prepare(`SELECT COUNT(*) as c FROM access_logs${userId ? ` WHERE user_id = ?` : ''}`).get(userId)?.c || 0;
  res.json({ logs, total, limit, offset });
});

app.get('/api/api-key-audit', (req, res) => {
  const db = getDb();
  const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
  const offset = parseInt(req.query.offset) || 0;

  const logs = db.prepare(`SELECT aka.*, u.username FROM api_key_audit aka LEFT JOIN users u ON aka.user_id = u.id ORDER BY aka.created_at DESC LIMIT ? OFFSET ?`).all(limit, offset);
  const total = db.prepare(`SELECT COUNT(*) as c FROM api_key_audit`).get().c;
  res.json({ logs, total, limit, offset });
});

app.get('/api/requests', (req, res) => {
  const db = getDb();
  const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
  const offset = parseInt(req.query.offset) || 0;
  const provider = req.query.provider;

  let query = `SELECT r.*, s.title as session_title FROM requests r LEFT JOIN sessions s ON r.session_id = s.id WHERE 1=1`;
  const params = [];
  if (provider) { query += ` AND r.provider = ?`; params.push(provider); }
  query += ` ORDER BY r.created_at DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  const requests = db.prepare(query).all(...params);
  const total = db.prepare(`SELECT COUNT(*) as c FROM requests${provider ? ` WHERE provider = ?` : ''}`).get(...(provider ? [provider] : [])).c;
  const byProvider = db.prepare(`SELECT provider, model, COUNT(*) as count, SUM(input_tokens) as input_tokens, SUM(output_tokens) as output_tokens, SUM(cost) as cost FROM requests GROUP BY provider, model ORDER BY count DESC`).all();
  const byStatus = db.prepare(`SELECT status, COUNT(*) as count FROM requests GROUP BY status`).all();

  res.json({ requests, total, limit, offset, byProvider, byStatus });
});

app.get('/api/messages', (req, res) => {
  const db = getDb();
  const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
  const offset = parseInt(req.query.offset) || 0;
  const sessionId = req.query.session_id;

  let query = `SELECT m.*, s.title as session_title FROM messages m LEFT JOIN sessions s ON m.session_id = s.id WHERE 1=1`;
  const params = [];
  if (sessionId) { query += ` AND m.session_id = ?`; params.push(sessionId); }
  query += ` ORDER BY m.created_at DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  const messages = db.prepare(query).all(...params);
  const total = db.prepare(`SELECT COUNT(*) as c FROM messages${sessionId ? ` WHERE session_id = ?` : ''}`).get(...(sessionId ? [sessionId] : [])).c;
  const byRole = db.prepare(`SELECT role, COUNT(*) as count FROM messages GROUP BY role`).all();

  res.json({ messages, total, limit, offset, byRole });
});

// ── Serve generated images ────────────────────────────────────────
const outputsPath = path.join(__dirname, '../../outputs');
app.use('/outputs', express.static(outputsPath));

app.get(['/chat', '/chat/'], (req, res) => {
  res.redirect(301, '/terminal');
});

// ── Serve Astro static build ──────────────────────────────────────
const distPath = path.join(__dirname, '../../dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  // SPA fallback: try page-specific index.html first, then root index.html
  // Astro generates /chat/index.html, /terminal/index.html, etc.
  app.get('/{*splat}', (req, res) => {
    if (req.path.startsWith('/api/')) {
      return res.status(404).json({ error: 'Not found' });
    }
    // Try: /<splat>/index.html (Astro's per-page output)
    const pageHtml = path.join(distPath, req.path, 'index.html');
    if (fs.existsSync(pageHtml)) {
      return res.sendFile(pageHtml);
    }
    // Try: /<splat>.html (flat file output)
    const flatHtml = path.join(distPath, req.path.endsWith('.html') ? req.path : req.path + '.html');
    if (fs.existsSync(flatHtml)) {
      return res.sendFile(flatHtml);
    }
    // Fallback: root index.html for SPA client-side routing
    const indexHtml = path.join(distPath, 'index.html');
    if (fs.existsSync(indexHtml)) {
      res.sendFile(indexHtml);
    } else {
      res.status(404).json({ error: 'Not found' });
    }
  });
}

// ── HTTP + WebSocket server ─────────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxReceivedFrameSize: 16 * 1024 * 1024, maxReceivedMessageSize: 32 * 1024 * 1024 });

wss.on('connection', (ws) => {
  console.log('[ws] client connected');

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      ws.send(JSON.stringify({ type: 'error', error: 'Invalid JSON' }));
      return;
    }

    const { action, provider = 'ollama', model, messages, system, sessionId } = msg;

    if (action === 'chat') {
      // Non-streaming via WS
      try {
        const result = await chat({ provider, model, messages, system });
        ws.send(JSON.stringify({ type: 'chat_result', ...result }));

        // Log
        if (sessionId) {
          const db = getDb();
          const reqId = uuidv4();
          db.prepare(
            `INSERT INTO requests (id, session_id, type, provider, model, input_tokens, output_tokens, latency_ms, cost, status)
             VALUES (?, ?, 'ws-chat', ?, ?, ?, ?, ?, ?, 'ok')`
          ).run(reqId, sessionId, provider, result.model, result.inputTokens, result.outputTokens, result.latency, result.cost);
        }
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', error: err.message }));
      }
    } else if (action === 'stream') {
      // Streaming via WS
      try {
        for await (const event of chatStream({ provider, model, messages, system })) {
          if (ws.readyState !== 1) break; // client disconnected
          ws.send(JSON.stringify(event));
        }
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', error: err.message }));
      }
    } else {
      ws.send(JSON.stringify({ type: 'error', error: `Unknown action: ${action}` }));
    }
  });

  ws.on('close', () => console.log('[ws] client disconnected'));
});

// ── PTY WebSocket — Real terminal in the browser ──────────────────
const pty = require('node-pty');

const ptyWss = new WebSocketServer({ noServer: true, maxReceivedFrameSize: 16 * 1024 * 1024, maxReceivedMessageSize: 32 * 1024 * 1024 });

ptyWss.on('connection', (ws) => {
  let ptyProcess = null;
  let closed = false;

  const crushBin = process.env.CRUSH_BIN || 'crush';
  const workDir = process.env.TERMINAL_CWD || process.env.FS_ROOT || '/home/ghost';

  // Sync haksterAi model config into crush config before spawning crush
  // so crush always starts with the user's selected model, not cerebras default
  try {
    const hakCfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'hakster-config.json'), 'utf8'));
    // Update data file
    const crushDataPath = path.join(os.homedir(), '.local/share/crush/crush.json');
    let crushCfg = {};
    try { crushCfg = JSON.parse(fs.readFileSync(crushDataPath, 'utf8')); } catch {}
    if (!crushCfg.models) crushCfg.models = {};
    if (!crushCfg.models.large) crushCfg.models.large = {};
    if (!crushCfg.models.small) crushCfg.models.small = {};
    if (hakCfg.model) { crushCfg.models.large.model = hakCfg.model; crushCfg.models.small.model = hakCfg.model; }
    if (hakCfg.provider) { crushCfg.models.large.provider = hakCfg.provider; crushCfg.models.small.provider = hakCfg.provider; }
    fs.writeFileSync(crushDataPath, JSON.stringify(crushCfg, null, 2));
    // Update config file (what crush reads on startup)
    const crushConfigPath = path.join(os.homedir(), '.config/crush/crush.json');
    try {
      let crushConf = JSON.parse(fs.readFileSync(crushConfigPath, 'utf8'));
      crushConf.models = crushConf.models || {};
      crushConf.models.large = crushConf.models.large || {};
      crushConf.models.small = crushConf.models.small || {};
      if (hakCfg.model) { crushConf.models.large.model = hakCfg.model; crushConf.models.small.model = hakCfg.model; }
      if (hakCfg.provider) { crushConf.models.large.provider = hakCfg.provider; crushConf.models.small.provider = hakCfg.provider; }
      fs.writeFileSync(crushConfigPath, JSON.stringify(crushConf, null, 2));
    } catch {}
  } catch {}

  try {
    ptyProcess = pty.spawn(crushBin, [], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: workDir,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        HOME: process.env.HOME || '/home/ghost',
      }
    });
    console.log(`[pty] spawned crush: ${crushBin} (pid=${ptyProcess.pid})`);
  } catch (err) {
    console.error('[pty] failed to spawn:', err);
    ws.send(JSON.stringify({ type: 'error', error: `Failed to spawn terminal: ${err.message}` }));
    ws.close();
    return;
  }

  const heartbeat = setInterval(() => {
    if (ws.readyState === 1) {
      try { ws.send(JSON.stringify({ type: 'heartbeat', ts: Date.now() })); } catch {}
    }
  }, 15000);

  // PTY output → browser — pass through directly for TUI apps
  ptyProcess.onData((data) => {
    if (ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type: 'pty', data }));
  });

  ptyProcess.onExit(({ exitCode }) => {
    console.log(`[pty] crush exited (code=${exitCode})`);
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'exit', exitCode }));
    }
    try { ws.close(); } catch {}
  });

  // Browser → PTY input
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'input' && ptyProcess) {
      ptyProcess.write(msg.data || '');
    } else if (msg.type === 'resize' && ptyProcess) {
      try { ptyProcess.resize(msg.cols || 120, msg.rows || 30); } catch {}
    } else if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
    }
  });

  ws.on('close', () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    console.log(`[pty] client disconnected, killing crush (pid=${ptyProcess?.pid})`);
    if (ptyProcess) {
      try {
        // Send Ctrl+C then quit command for graceful exit
        ptyProcess.kill('SIGTERM');
        setTimeout(() => {
          try { ptyProcess.kill('SIGKILL'); } catch {}
        }, 1000);
      } catch {}
    }
  });
});

// Upgrade handler — route /ws to chat WSS, /pty to PTY WSS.
server.on('upgrade', (req, socket, head) => {
  if (req.url === '/pty') {
    ptyWss.handleUpgrade(req, socket, head, (ws) => {
      ptyWss.emit('connection', ws, req);
    });
  } else if (req.url === '/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

// ── Start ──────────────────────────────────────────────────────────
// Pre-warm caches before serving requests
getSkillsInventory();
getToolInventory();
getMachineContext();

server.listen(PORT, () => {
  console.log(`\n  ╔══════════════════════════════════════════╗`);
  console.log(`  ║  haksterAi server v1.0                   ║`);
  console.log(`  ║  http://localhost:${String(PORT).padEnd(5)}                ║`);
  console.log(`  ║  WS:   ws://localhost:${String(PORT).padEnd(5)}/ws           ║`);
  console.log(`  ║  Providers: ${Object.keys(PROVIDERS).join(', ').padEnd(26)}║`);
  console.log(`  ║  FS Root: ${FS_ROOT.substring(0, 30).padEnd(34)}║`);
  console.log(`  ╚══════════════════════════════════════════╝\n`);
});
