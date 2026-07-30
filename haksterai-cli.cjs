#!/usr/bin/env node
/**
 * haksterAi Agent Chat CLI — terminal UI like Codex/Hermes CLI
 *
 * Usage:
 *   node haksterai-cli.cjs
 *   HAKSTER_HOST=http://host:3579 node haksterai-cli.cjs
 *   HAKSTER_PROVIDER=ollama HAKSTER_MODEL=gpt-oss:120b-cloud node haksterai-cli.cjs
 */

'use strict';

// License gate — TUI won't start without valid license
const { checkLicense } = require('./server/src/license');

const blessed = require('blessed');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// ── Config (config file first, env vars override, sensible fallback) ──
const CONFIG_FILE = path.join(os.homedir(), '.hakster', 'config.json');
const _cfgDefaults = (() => {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
})();
const API_BASE = (process.env.HAKSTER_HOST || _cfgDefaults.server || 'http://localhost:3579').replace(/\/$/, '');
const DEFAULT_PROVIDER = process.env.HAKSTER_PROVIDER || process.env.DEFAULT_PROVIDER || _cfgDefaults.provider || 'nous';
const DEFAULT_MODEL = process.env.HAKSTER_MODEL || _cfgDefaults.model || '';
const MAX_LOG_LINES = parseInt(process.env.MAX_LOG_LINES || '500', 10); // Grid tuning max log lines

// ── Color palette ──────────────────────────────────────────────────
const C = {
  bg: '#0a0a0f', bgSubtle: '#1e1e2e', fg: '#e2e8f0',
  fgMuted: '#94a3b8', fgSubtle: '#64748b',
  primary: '#7c3aed', secondary: '#a855f7', accent: '#c084fc',
  info: '#38bdf8', success: '#4ade80', mustard: '#facc15',
  error: '#f87171', coral: '#ff577d', white: '#ffffff',
};

// ── State ─────────────────────────────────────────────────────────
let sessionId = null;
let provider = DEFAULT_PROVIDER;
let model = DEFAULT_MODEL;
let messages = [];
let streaming = false;
let selectedPerson = null;
let selectedMachine = null;
let people = [];
let machines = [];
let pendingConfirm = null; // { toolCallId, command, reason, isSudo, passwordMode }

// ── HTTP helpers ──────────────────────────────────────────────────
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

function httpPost(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(body || {});
    const opts = { hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, timeout: 8000 };
    const req = http.request(opts, res => {
      let b = '';
      res.on('data', d => b += d);
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve({}); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.end(data);
  });
}

function saveMessage(role, content, meta = {}) {
  messages.push({ role, content, ...meta });
  if (!sessionId) return Promise.resolve();
  return httpPost(`${API_BASE}/api/sessions/${sessionId}/messages`, {
    role,
    content,
    inputTokens: meta.inputTokens || 0,
    outputTokens: meta.outputTokens || 0,
    latencyMs: meta.latency || 0,
    provider,
    model,
  });
}

async function postConfirm(toolCallId, approved, permanent = false) {
  try {
    await httpPost(`${API_BASE}/api/agent/confirm`, {
      sessionId: sessionId || '',
      toolCallId,
      approved,
      permanent,
      command: pendingConfirm?.command || '',
    });
  } catch (e) {
    chatBox.log(`{${C.error}}✗ confirm failed: ${e.message}{/${C.error}}`);
  }
}

// ── Formatting ───────────────────────────────────────────────────
const fmtUptime = s => { const d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60); return d>0?`${d}d ${h}h ${m}m`:h>0?`${h}h ${m}m`:`${m}m`; };

// ── Screen ────────────────────────────────────────────────────────
// License gate — TUI won't start without valid license
(async () => {
  const lic = await checkLicense(true);
  if (!lic.valid) {
    console.error('\n' + lic.message + '\n');
    process.exit(1);
  }
  if (lic.message) console.log(lic.message + '\n');
})();

const screen = blessed.screen({ smartCSR: true, title: 'haksterAi CLI', fullUnicode: true, dockBorders: true });
screen.key(['escape', 'q', 'C-c'], () => process.exit(0));

// Coalesce bursty renders (e.g. many SSE chunks/sec while the agent is
// streaming) into one render per tick. Without this, each delta/thinking/
// tool_call line forces a full synchronous screen.render(), which races the
// per-keystroke render() the focused inputBox fires and makes the terminal
// cursor appear to jump back to the start of the line while typing ahead.
let _renderPending = false;
function renderThrottled() {
  if (_renderPending) return;
  _renderPending = true;
  setImmediate(() => { _renderPending = false; try { screen.render(); } catch {} });
}

const bdrStyle = { border: { fg: C.primary }, bg: C.bg, fg: C.fg, label: { fg: C.accent } };

const header = blessed.box({ top:0, left:0, width:'100%', height:1,
  content: `{center}{bold}{${C.primary}}◆{/bold}{/${C.primary}} {bold}{${C.fg}}haksterAi{/bold}{/${C.fg}} {${C.fgMuted}}Agent CLI{/${C.fgMuted}} {${C.fgSubtle}}│ q:quit │ tab:focus │ enter:send │ p/m:select entity{/${C.fgSubtle}}{/center}`,
  tags: true, style: { bg: C.bgSubtle, fg: C.fg } });

const peopleBox = blessed.list({ top:1, left:0, width:'25%', height:'50%-1',
  label:` {${C.primary}}◆{/} PEOPLE `, border:{type:'line'}, style:{...bdrStyle, selected:{bg:C.bgSubtle}}, tags:true, scrollable:true, keys:true, vi:true });

const machinesBox = blessed.list({ top:'50%', left:0, width:'25%', height:'50%-2',
  label:` {${C.primary}}◆{/} MACHINES `, border:{type:'line'}, style:{...bdrStyle, selected:{bg:C.bgSubtle}}, tags:true, scrollable:true, keys:true, vi:true });

const chatBox = blessed.log({ top:1, left:'25%', width:'75%', height:'100%-4',
  label:` {${C.primary}}◆{/} CHAT `, border:{type:'line'}, style:bdrStyle, tags:true, scrollable:true,
  alwaysScroll:true, scrollback:MAX_LOG_LINES, scrollbar:{ch:'█',style:{fg:C.primary}}, wrap: false });

const inputBox = blessed.textbox({ bottom:1, left:'25%', width:'75%', height:3,
  label:` {${C.primary}}◆{/} MESSAGE {${C.fgSubtle}}(Tab←entities, Enter→send){/${C.fgSubtle}} `, border:{type:'line'}, style:{...bdrStyle, focus:{border:{fg:C.accent}}}, tags:true, input:true, keys:true });

const statusBox = blessed.box({ bottom:1, left:0, width:'25%', height:3,
  label:` {${C.primary}}◆{/} SESSION `, border:{type:'line'}, style:bdrStyle, tags:true });

// Auto-scroll chat
let _thinkingActive = false;
let _thinkingInterrupted = false;
let _thinkingBuffer = '';
let _writingLiveLine = false;
const _origChatLog = chatBox.log.bind(chatBox);
chatBox.log = (...args) => {
  // If something other than updateThinkingLine/endThinkingLine writes to the
  // box while a live thinking line is showing (deltas, tool_call_start/result,
  // errors, etc. all land on chatBox too via this same override), the thinking
  // line is no longer the tail of the log. Flag it so the next pop is skipped —
  // see updateThinkingLine below for why popping here would delete that content.
  if (_thinkingActive && !_writingLiveLine) _thinkingInterrupted = true;
  _origChatLog(...args);
  try { chatBox.setScrollPerc(100); } catch {}
};

// Live thinking line: reasoning streams arrive as many small chunks per
// second. Logging each one as its own line used to flood the chat box and
// shove everything else up the screen. Instead we keep exactly one line
// "live" — pop the rows the previous chunk occupied, then log the new
// snippet in the same spot — so a whole thinking burst stays pinned to a
// single, continuously-updating line.
let _thinkingRows = 0;
// blessed's Element.popLine(n) is broken for n>1: it computes the delete
// index once (fake.length-1) and reuses it across the loop, so after the
// first splice the array has shrunk and that index is out of range —
// every subsequent splice is a silent no-op. Net effect: only the single
// last line is ever removed, no matter what n is. Calling popLine(1) in a
// loop recomputes the index fresh each time and actually removes n lines.
function popLines(box, n) { for (let i = 0; i < n; i++) { try { box.popLine(1); } catch {} } }
function updateThinkingLine(text) {
  // Only pop if nothing else got appended since our last write — otherwise
  // the tail belongs to unrelated content (tool output, deltas) and popping
  // would silently delete it. Skipping the pop just leaves one stale
  // "thinking" line behind instead, which is a cosmetic no-op, not data loss.
  if (_thinkingActive && _thinkingRows > 0 && !_thinkingInterrupted) {
    // Pop ALL previous thinking rows (could be multiple if wrapping happened)
    for (let i = 0; i < _thinkingRows; i++) {
      try { chatBox.popLine(1); } catch {}
    }
  }
  _writingLiveLine = true;
  chatBox.log(text);
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
      try { chatBox.popLine(1); } catch {}
    }
  }
  _thinkingActive = false;
  _thinkingRows = 0;
  _thinkingInterrupted = false;
  if (finalText) { _writingLiveLine = true; chatBox.log(finalText); _writingLiveLine = false; }
}

screen.append(header); screen.append(peopleBox); screen.append(machinesBox); screen.append(chatBox); screen.append(inputBox); screen.append(statusBox);

// ── Entity selection ──────────────────────────────────────────────
function updateStatus() {
  const sp = selectedPerson ? `@${selectedPerson.username}` : 'none';
  const sm = selectedMachine ? selectedMachine.os_name || selectedMachine.platform || 'device' : 'none';
  statusBox.setContent(`provider: {${C.info}}${provider}{/${C.info}}\nmodel: {${C.accent}}${model || 'default'}{/${C.accent}}\nperson: {${C.fgMuted}}${sp}{/${C.fgMuted}} | machine: {${C.fgMuted}}${sm}{/${C.fgMuted}}`);
  screen.render();
}

async function loadEntities() {
  try {
    const [p, m] = await Promise.all([
      httpGet(`${API_BASE}/api/people?limit=50`).catch(() => ({ people: [] })),
      httpGet(`${API_BASE}/api/machines`).catch(() => ({ clients: [] })),
    ]);
    people = p.people || [];
    machines = (m.clients || []).map(c => ({ ...c, kind: 'client' }));
    if (m.server) machines.unshift({ ...m.server, kind: 'server', platform: 'server' });

    peopleBox.setItems(people.length ? people.map(person => {
      const st = person.status === 'active' ? C.success : person.status === 'suspended' ? C.mustard : C.error;
      return `${dot(person.status)} {${C.fg}}${(person.username || '?').padEnd(10)}{/${C.fg}} {${st}}${person.role}{/${st}} {${C.fgSubtle}}${person.plan}{/${C.fgSubtle}}`;
    }) : [`{${C.fgSubtle}}No people found{/${C.fgSubtle}}`]);

    machinesBox.setItems(machines.length ? machines.map(m => {
      const icon = m.kind === 'server' ? '🖥️' : m.device_type === 'tablet' ? '📱' : m.device_type === 'mobile' ? '📲' : '🖥️';
      const os = [m.os_name, m.os_version].filter(Boolean).join(' ') || m.platform || '?';
      const ago = m.updated_at ? fmtUptime(Date.now()/1000 - m.updated_at) : '';
      return `${icon} {${C.fg}}${os.padEnd(14)}{/${C.fg}} {${C.fgMuted}}${ago}{/${C.fgMuted}}`;
    }) : [`{${C.fgSubtle}}No machines found{/${C.fgSubtle}}`]);

    renderThrottled();
  } catch (err) {
    chatBox.log(`{${C.error}}✗ Failed to load people/machines: ${err.message}{/${C.error}}`);
  }
}

function dot(s) { return s==='running'||s==='online'||s==='active'?`{${C.success}}●{/${C.success}}`:`{${C.error}}●{/${C.error}}`; }

// ── Session init ──────────────────────────────────────────────────
async function initSession() {
  try {
    const cfg = await httpGet(`${API_BASE}/api/health`).catch(() => ({ providers: [provider] }));
    const providers = cfg.providers || [provider];
    if (!providers.includes(provider)) provider = providers[0];
    const sess = await httpPost(`${API_BASE}/api/sessions`, { provider, model, title: 'CLI session' });
    sessionId = sess.id;
    provider = sess.provider;
    model = sess.model;
    chatBox.log(`{${C.success}}✓{/} {${C.fg}}Session ${sessionId.slice(0,8)} started ({${C.info}}${provider}{/${C.info}} / {${C.accent}}${model}{/${C.accent}}){/${C.fg}}`);
    updateStatus();
  } catch (err) {
    chatBox.log(`{${C.error}}✗ Could not start session: ${err.message}{/${C.error}}`);
  }
}

// ── Streaming agent ───────────────────────────────────────────────
function streamAgent(prompt) {
  return new Promise((resolve, reject) => {
    const u = new URL(`${API_BASE}/api/agent/run`);
    const body = JSON.stringify({ provider, model, sessionId, messages: [...messages, { role: 'user', content: prompt }] });
    const opts = { hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 300000 };
    let buffer = '';
    let fullContent = '';
    let meta = {};

    const req = http.request(opts, res => {
      res.on('data', chunk => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          const t = line.trim();
          if (!t || !t.startsWith('data: ')) continue;
          let data;
          try { data = JSON.parse(t.slice(6)); } catch { continue; }
          if (data.type === 'delta') {
            // Block deltas while approval is pending so the prompt stays visible
            if (!pendingConfirm) {
              fullContent += data.content;
              const clean = (data.content || '').replace(/\x1b\[[0-9;]*m/g, '');
              if (clean) chatBox.log(clean);
            }
          } else if (data.type === 'thinking_start') {
            // Don't show anything - Claude Code style hides thinking by default
            _thinkingActive = true;
            _thinkingBuffer = '';
          } else if (data.type === 'thinking') {
            // Accumulate thinking content but don't display it
            if (data.content) _thinkingBuffer += data.content;
          } else if (data.type === 'thinking_end') {
            // Show a single summary line after thinking completes
            _thinkingActive = false;
            if (_thinkingBuffer.trim()) {
              const summary = _thinkingBuffer.trim().split('\n')[0].slice(0, 80);
              chatBox.log(`💭 ${summary}${_thinkingBuffer.length > 80 ? '…' : ''}`);
            }
            _thinkingBuffer = '';
          } else if (data.type === 'tool_call_start') {
            chatBox.log(`{${C.mustard}}⚡ tool{/${C.mustard}} {${C.accent}}${data.tool_name || '?'}{/${C.accent}}`);
          } else if (data.type === 'tool_call_result') {
            const res = (data.tool_result || '').replace(/\n/g, ' ').slice(0, 120);
            chatBox.log(`{${C.success}}  →{/${C.success}} {${C.fgSubtle}}${res}…{/${C.fgSubtle}}`);
          } else if (data.type === 'error') {
            chatBox.log(`{${C.error}}✗ ${data.error || data.message || 'error'}{/${C.error}}`);
          } else if (data.type === 'done') {
            meta = { ...data, inputTokens: data.inputTokens || 0, outputTokens: data.outputTokens || 0, latency: data.latency || 0 };
          } else if (data.type === 'loop_detected') {
            chatBox.log(`{${C.mustard}}⚠ ${data.reason || 'loop'}: ${data.message || ''}{/${C.mustard}}`);
          } else if (data.type === 'needs_confirmation') {
            const { tool_call_id, reason, command } = data;
            const isSudo = /^\s*sudo\b/i.test(String(command || ''));
            pendingConfirm = { toolCallId: tool_call_id, reason: reason || 'Approval needed', command: command || '', isSudo };
            inputBox.setValue('');
            inputBox.setLabel(` {${C.error}}◆{/} CONFIRM {${C.fgSubtle}}${isSudo ? '🔑 sudo password' : 'y=approve n=deny a=allowlist'}{/${C.fgSubtle}} `);
            inputBox.focus();
            chatBox.log(`{${C.error}${C.bold}}╔══════════════════════════════════════════════════════════════════╗{/${C.error}${C.bold}}`);
            chatBox.log(`{${C.error}${C.bold}}║  ${isSudo ? '🔑 SUDO PASSWORD REQUIRED' : '⚠️  DANGEROUS COMMAND DETECTED'}${' '.repeat(isSudo ? 16 : 12)}║{/${C.error}${C.bold}}`);
            chatBox.log(`{${C.error}${C.bold}}╚══════════════════════════════════════════════════════════════════╝{/${C.error}${C.bold}}`);
            chatBox.log(`{${C.yellow}}  Reason: ${reason || 'command/file change'}{/${C.yellow}}`);
            chatBox.log(`{${C.fgSubtle}}  Command: $ ${command || '(unknown)'}{/${C.fgSubtle}}`);
            chatBox.log(`{${C.primary}}  y=approve  n=deny  a=approve+allowlist${isSudo ? '  [password=enter to approve]' : ''}{/${C.primary}}`);
            screen.render();
          }
          renderThrottled();
        }
      });
      res.on('end', () => resolve({ content: fullContent, meta }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    req.end(body);
  });
}

// ── Send flow ───────────────────────────────────────────────────────
async function sendMessage() {
  if (streaming) return;
  const text = inputBox.getValue().trim();

  // Approval mode: inputBox is repurposed for y/n/a/password
  if (pendingConfirm) {
    const ans = text;
    inputBox.setValue('');
    const c = pendingConfirm;
    pendingConfirm = null;
    inputBox.setLabel(` {${C.primary}}◆{/} MESSAGE {${C.fgSubtle}}(Tab←entities, Enter→send){/${C.fgSubtle}} `);
    if (!ans) {
      chatBox.log(`{${C.fgSubtle}}  [confirm dismissed]{/${C.fgSubtle}}`);
      await postConfirm(c.toolCallId, false);
    } else if (/^\s*(y|yes)\s*$/i.test(ans)) {
      chatBox.log(`{${C.success}}  ✓ approved{/${C.success}}`);
      await postConfirm(c.toolCallId, true);
    } else if (/^\s*(a|allow)\s*$/i.test(ans)) {
      chatBox.log(`{${C.success}}  ✓ approved + allowlisted{/${C.success}}`);
      await postConfirm(c.toolCallId, true, true);
    } else if (/^\s*(n|no)\s*$/i.test(ans)) {
      chatBox.log(`{${C.error}}  ✗ denied{/${C.error}}`);
      await postConfirm(c.toolCallId, false);
    } else if (c.isSudo) {
      chatBox.log(`{${C.success}}  ✓ sudo password accepted{/${C.success}}`);
      await postConfirm(c.toolCallId, true);
    } else {
      chatBox.log(`{${C.fgSubtle}}  [confirm dismissed]{/${C.fgSubtle}}`);
      await postConfirm(c.toolCallId, false);
    }
    inputBox.focus();
    screen.render();
    return;
  }

  if (!text) return;
  inputBox.setValue('');
  inputBox.focus();
  screen.render();

  let prompt = text;
  const ctxParts = [];
  if (selectedPerson) {
    ctxParts.push(`Selected user: @${selectedPerson.username} (role=${selectedPerson.role}, plan=${selectedPerson.plan}, status=${selectedPerson.status}).`);
  }
  if (selectedMachine) {
    const m = selectedMachine;
    const os = [m.os_name, m.os_version].filter(Boolean).join(' ') || m.platform || 'unknown';
    const br = [m.browser, m.browser_version].filter(Boolean).join(' ') || '';
    const res = m.screen_width && m.screen_height ? `${m.screen_width}×${m.screen_height}` : '';
    ctxParts.push(`Selected machine: ${os} ${br} ${res}`.trim() + '.');
  }
  if (ctxParts.length) prompt = ctxParts.join('\n') + '\n\n' + prompt;

  chatBox.log(`{${C.primary}}◆ You{/${C.primary}}\n${text}`);
  await saveMessage('user', text);
  streaming = true;
  updateStatus();

  try {
    const { content, meta } = await streamAgent(prompt);
    chatBox.log(`{${C.success}}✓ Assistant{/${C.success}}`);
    await saveMessage('assistant', content, meta);
  } catch (err) {
    chatBox.log(`{${C.error}}✗ Stream failed: ${err.message}{/${C.error}}`);
  } finally {
    streaming = false;
    updateStatus();
    inputBox.focus();
  }
}

// ── Keys ───────────────────────────────────────────────────────────
screen.key(['tab'], () => {
  if (screen.focused === inputBox) { peopleBox.focus(); }
  else if (screen.focused === peopleBox) { machinesBox.focus(); }
  else { inputBox.focus(); }
  screen.render();
});

screen.key(['p'], () => { peopleBox.focus(); screen.render(); });
screen.key(['m'], () => { machinesBox.focus(); screen.render(); });

peopleBox.on('select', (item, index) => {
  selectedPerson = people[index] || null;
  if (selectedPerson) chatBox.log(`{${C.info}}Selected person: @${selectedPerson.username}{/${C.info}}`);
  updateStatus();
  inputBox.focus();
});

machinesBox.on('select', (item, index) => {
  selectedMachine = machines[index] || null;
  if (selectedMachine) {
    const os = [selectedMachine.os_name, selectedMachine.os_version].filter(Boolean).join(' ') || selectedMachine.platform || 'machine';
    chatBox.log(`{${C.info}}Selected machine: ${os}{/${C.info}}`);
  }
  updateStatus();
  inputBox.focus();
});

inputBox.on('submit', sendMessage);

// ── Boot ───────────────────────────────────────────────────────────
(async () => {
  chatBox.log(`{${C.primary}}◆{/} {bold}{${C.fg}}haksterAi Agent CLI{/bold}{/${C.fg}} {${C.fgMuted}}connecting to ${API_BASE}{/${C.fgMuted}}`);
  await loadEntities();
  await initSession();
  setInterval(() => { loadEntities(); }, 10000);
  inputBox.focus();
  screen.render();
})().catch(err => {
  chatBox.log(`{${C.error}}✗ Fatal: ${err.message}{/${C.error}}`);
});
