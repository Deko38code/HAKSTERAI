#!/usr/bin/env node
'use strict';
// Avoid Node's "NO_COLOR ignored due to FORCE_COLOR" warning leaking into the TUI/alt-screen.
if (process.env.NO_COLOR && process.env.FORCE_COLOR) { delete process.env.NO_COLOR; }

// ════════════════════════════════════════════════════════════════════════
// haksterAi CLI — index.js
// Wires in providers.js, tools.js, memory.js, ui.js modules
// Preserves all commander.js commands and SSE streaming
// Adds: offline fallback, slash commands, memory auto-save,
//       token bar, markdown rendering, agent team support
// ════════════════════════════════════════════════════════════════════════

const { Command } = require('commander');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');

// License check — must pass before anything else runs
const { checkLicense } = require('../server/src/license');
async function _haksterLicenseGate() {
  const lic = await checkLicense(true); // allowTrial = true
  if (!lic.valid) {
    console.error('\n' + lic.message + '\n');
    process.exit(1);
  }
  if (lic.message) console.log(lic.message + '\n');
}
// Run gate before CLI starts (non-blocking for --help/--version)
const _rawArgs = process.argv.slice(2);
if (_rawArgs.includes('--help') || _rawArgs.includes('-h') || _rawArgs.includes('--version') || _rawArgs.includes('-V')) {
  // Allow help/version without license
} else {
  _haksterLicenseGate().catch((e) => { console.error('License check failed:', e.message); process.exit(1); });
}

const pkg = require('./package.json');
const { showIntro, C: logoC } = require('./logo');

// ── Grid helpers ───────────────────────────────────────────────────────
function _avg(arr) {
  if (!arr.length) return 0;
  return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
}
function _fmtMs(ms) {
  if (ms < 1000) return ms + 'ms';
  const s = (ms / 1000).toFixed(1);
  return s + 's';
}

// ── New module imports ──────────────────────────────────────────────────
const providers = require('./providers');
const tools = require('./tools');
const mem = require('./memory');
const ui = require('./ui');

// Use providers.C for new code (richer color set); logo.C for existing intro
const C = providers.C;

// ── Auto-learn module (non-blocking) ─────────────────────────────────────
// Reaches into the monorepo's server/ package for the shared autolearn engine.
// That path only exists in a git checkout — an `npm install -g hakster-cli`
// install has no server/ sibling, so this must never throw at require() time
// or it takes the entire CLI down before a single command can run.
let autolearn;
try {
  autolearn = require('../server/src/agent/autolearn');
} catch (_) {
  autolearn = { autoInit() { return ''; } };
}

// Show intro on every launch (skip for TUI mode — Ink manages the screen)
if (!process.argv.includes('ui')) {
  showIntro(pkg.version);
}

// ── Auto-learn: eager init on startup (non-blocking, caches for later) ──
let _startupSteering = '';
try {
  const r = autolearn.autoInit(process.cwd());
  if (r && typeof r === 'string') _startupSteering = r;
} catch (e) { /* non-blocking */ }

// ── Config ───────────────────────────────────────────────────────────────
const CONFIG_DIR = path.join(os.homedir(), '.hakster');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveConfig(cfg) {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  console.log(`Config saved to ${CONFIG_FILE}`);
}

function getConfig() {
  const cfg = loadConfig();
  if (!cfg.server) {
    console.error('No server configured. Run: hakster config set server http://your-server:3579');
    process.exit(1);
  }
  return cfg;
}

// ── CLI conversation history persistence (survives restart) ─────────────
const HISTORY_FILE = path.join(CONFIG_DIR, 'cli-history.json');
const HISTORY_MAX_MESSAGES = 200;

function loadHistory() {
  try {
    const data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    if (Array.isArray(data && data.messages)) {
      return data.messages
        .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .slice(-HISTORY_MAX_MESSAGES);
    }
  } catch {}
  return [];
}

function saveHistory(history) {
  try {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const msgs = (history || [])
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-HISTORY_MAX_MESSAGES);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify({ savedAt: Date.now(), messages: msgs }, null, 2));
  } catch {}
}

function clearHistory() {
  try {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify({ savedAt: Date.now(), messages: [] }, null, 2));
  } catch {}
}


// ── Danger password helper ───────────────────────────────────────────────
function getDangerPassword() {
  // Primary source: environment variable (HAKSTER_DANGER_PASSWORD)
  if (process.env.HAKSTER_DANGER_PASSWORD) return process.env.HAKSTER_DANGER_PASSWORD;
  // Fallback: config file property "dangerPassword"
  try {
    const cfg = loadConfig();
    if (cfg && typeof cfg.dangerPassword === 'string') return cfg.dangerPassword;
  } catch {}
  return null;
}

// ── Default AI provider + model (config first, env override, sensible fallback) ──
const _cfgDefaults = (() => { try { return loadConfig(); } catch { return {}; } })();
const DEFAULT_AI_PROVIDER = process.env.HAKSTER_PROVIDER || process.env.DEFAULT_PROVIDER || _cfgDefaults.provider || 'ollama';
const DEFAULT_MODEL = process.env.HAKSTER_MODEL || _cfgDefaults.model || 'gpt-oss:120b-cloud';

// ── HTTP helper (preserved with timeoutMs support) ───────────────────────
function fetchUrl(url, { method = 'GET', headers = {}, body = null, timeoutMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.request(url, { method, headers }, (res) => {
      if (res.statusCode >= 400) {
        let errBody = '';
        res.on('data', (d) => (errBody += d));
        res.on('end', () => reject(new Error(`${res.statusCode} ${errBody || res.statusMessage}`)));
        return;
      }
      res.setTimeout(0);
      resolve(res);
    });
    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        req.destroy(new Error(`Connection timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }
    req.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    req.on('response', () => { if (timer) clearTimeout(timer); });
    if (body) req.write(body);
    req.end();
  });
}

async function fetchJson(url, opts) {
  const res = await fetchUrl(url, opts);
  let data = '';
  for await (const chunk of res) data += chunk;
  return JSON.parse(data);
}

async function saveServerMemory(server, apiKey, { category = 'general', key, value, source = 'cli', confidence = 0.9 }) {
  if (!server || !key || !value) return false;
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  try {
    await fetchJson(`${server}/api/agent/memory`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ category, key, value, source, confidence }),
      timeoutMs: 5000,
    });
    return true;
  } catch (_) {
    return false;
  }
}

async function syncLocalMemoryToServer(server, apiKey) {
  if (!server) return { attempted: 0, saved: 0 };
  const local = mem.loadMemory();
  const notes = mem.memGetNotes(local).slice(0, 200);
  let saved = 0;
  for (let i = 0; i < notes.length; i++) {
    const value = String(notes[i] || '').trim();
    if (!value) continue;
    const ok = await saveServerMemory(server, apiKey, {
      category: 'context',
      key: `cli_note_${i}_${Buffer.from(value).toString('base64url').slice(0, 18)}`,
      value,
      source: 'cli-import',
      confidence: 0.85,
    });
    if (ok) saved++;
  }
  return { attempted: notes.length, saved };
}

const KNOWN_AGENT_CWDS = [
  {
    cwd: '/home/ghost/cine-vault-live',
    patterns: [
      /\bcine\s*-?\s*vault\b/i,
      /\bcinevault\b/i,
      /\blive channels?\b/i,
      /\bside panel\b/i,
      /\bstalker\b/i,
      /\biptv\b/i,
      /\bmovie server\b/i,
    ],
  },
  {
    cwd: '/home/ghost/haksterAi',
    patterns: [
      /\bhakster\s*ai\b/i,
      /\bhaksterai\b/i,
      /\btool loop\b/i,
      /\bcli tools?\b/i,
      /\bagent loop\b/i,
      /\bsearch_files\b/i,
      /\bglob_search\b/i,
    ],
  },
];

const SSE_IDLE_TIMEOUT_MS = Math.max(30000, parseInt(process.env.HAKSTER_CLI_SSE_IDLE_MS || '90000', 10) || 90000);

function makeSseIdleWatchdog(stream, onIdle) {
  let timer = null;
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      try { onIdle(); } catch (_) {}
      try { stream.destroy(new Error(`SSE idle timeout after ${SSE_IDLE_TIMEOUT_MS}ms`)); } catch (_) {}
    }, SSE_IDLE_TIMEOUT_MS);
  };
  const stop = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  arm();
  return { arm, stop };
}

function inferAgentCwd(text) {
  const input = String(text || '');
  for (const project of KNOWN_AGENT_CWDS) {
    if (project.patterns.some((rx) => rx.test(input)) && fs.existsSync(project.cwd)) {
      return project.cwd;
    }
  }
  const cwd = process.cwd();
  if (cwd && cwd.startsWith('/home/ghost/') && fs.existsSync(cwd)) return cwd;
  return null;
}

// ════════════════════════════════════════════════════════════════════════
// ── OFFLINE MODE — LLM call via direct provider API ──────────────────────
// ════════════════════════════════════════════════════════════════════════

let _offlineMode = false;
let _offlineProvider = null;

async function offlineLLMCall(messages, opts = {}) {
  if (!_offlineProvider) {
    _offlineProvider = await providers.ensureProviderAvailable({ autoStart: true });
  }
  if (!_offlineProvider) {
    throw new Error('No AI provider available for offline mode');
  }

  const prov = _offlineProvider;
  const model = opts.model || prov.model || 'default';
  const url = prov.url;
  const headers = { 'Content-Type': 'application/json' };
  if (prov.apiKey && prov.apiKey !== 'free') {
    headers['Authorization'] = `Bearer ${prov.apiKey}`;
  }

  // Build OpenAI-compatible request body
  const reqBody = JSON.stringify({
    model,
    messages,
    stream: false,
    max_tokens: opts.maxTokens || 4096,
    temperature: opts.temperature || 0.7,
  });

  const res = await fetchUrl(url, {
    method: 'POST',
    headers,
    body: reqBody,
    timeoutMs: 60000,
  });

  let data = '';
  for await (const chunk of res) data += chunk;
  const parsed = JSON.parse(data);

  // Extract content from OpenAI-compatible response
  if (parsed.choices && parsed.choices[0]) {
    // GLM-5.2 puts reasoning in message.reasoning, content in message.content
    // If content is empty but reasoning exists, fall back to reasoning (so the
    // offline loop at least gets text to parse/display instead of hanging).
    return parsed.choices[0].message?.content
      || parsed.choices[0].message?.reasoning
      || parsed.choices[0].message?.thinking
      || '';
  }
  // Anthropic-style response
  if (parsed.content && parsed.content[0]) {
    return parsed.content[0].text || '';
  }
  // Gemini-style response
  if (parsed.candidates && parsed.candidates[0]) {
    return parsed.candidates[0].content?.parts?.[0]?.text || '';
  }
  return JSON.stringify(parsed).slice(0, 500);
}

// ── Offline agent loop — parse tools, execute locally, feed back, repeat ─
async function offlineAgentLoop(history, sysPrompt, opts = {}) {
  const maxRounds = opts.maxRounds || 30;
  const trustCfg = mem.loadTrust();
  const readline = require('readline');

  let round = 0;
  let fullResponse = '';
  // ── BUG FIX: Loop-detection state (was completely missing) ──
  // The offline agent loop had no loop detection at all — the model could
  // call the same tools with the same args repeatedly for 30 rounds.
  let recentToolCalls = [];   // last N tool call signatures for dupe detection
  let noProgressCount = 0;    // consecutive rounds with no meaningful text output
  let lastResponsePrefix = '';// for exact-repeat detection
  const DUPE_CALL_LIMIT = 3;
  const DUPE_CALL_WINDOW = 8;
  const NO_PROGRESS_LIMIT = 5;
  const REPEAT_LIMIT = 3;
  let repeatCount = 0;

  while (round < maxRounds) {
    round++;
    const messages = [
      { role: 'system', content: sysPrompt },
      ...history,
    ];

    const aiResponse = await offlineLLMCall(messages, { maxTokens: 4096 });
    const parsed = tools.parseTools(aiResponse);
    const cleanedText = tools.stripTools(aiResponse);

    if (cleanedText.trim()) {
      process.stdout.write(cleanedText);
      fullResponse += cleanedText;
      noProgressCount = 0;
    } else {
      noProgressCount++;
    }

    // ── Exact-repeat detection ──
    const responsePrefix = cleanedText.substring(0, 80).toLowerCase().trim();
    if (responsePrefix && responsePrefix === lastResponsePrefix) {
      repeatCount++;
      if (repeatCount >= REPEAT_LIMIT) {
        console.log(`\n${C.yellow}  ⚠ Offline loop detected: repeated response ${repeatCount}x. Breaking.${C.reset}`);
        break;
      }
    } else {
      repeatCount = 0;
    }
    lastResponsePrefix = responsePrefix;

    // ── No-progress detection ──
    if (noProgressCount >= NO_PROGRESS_LIMIT) {
      console.log(`\n${C.yellow}  ⚠ Offline loop detected: ${noProgressCount} rounds with no output. Breaking.${C.reset}`);
      break;
    }

    if (parsed.length === 0) {
      // No more tools — we're done
      break;
    }

    // ── Duplicate tool-call detection ──
    let duplicateLoop = false;
    for (const t of parsed) {
      const callSig = `${t.name}:${JSON.stringify(t.args || {}).substring(0, 100)}`;
      recentToolCalls.push(callSig);
      if (recentToolCalls.length > DUPE_CALL_WINDOW) recentToolCalls.shift();
      const dupes = recentToolCalls.filter(c => c === callSig).length;
      if (dupes >= DUPE_CALL_LIMIT) {
        console.log(`\n${C.yellow}  ⚠ Offline loop detected: tool ${t.name} called ${dupes}x with same args. Breaking.${C.reset}`);
        duplicateLoop = true;
        break;
      }
    }
    if (duplicateLoop) break;

    // Execute tools locally
    console.log(`\n${C.gray}  [offline] executing ${parsed.length} tool(s)...${C.reset}`);
    // ── Plan grid: render when hak_plan fires in offline mode ────────────
    for (const t of parsed) {
      if (t.name === 'plan' && Array.isArray(t.args && t.args.steps)) {
        const offlinePlanState = { steps: t.args.steps.map(s => ({ text: s, done: false })) };
        ui.printScriptGrid(offlinePlanState.steps, null);
      }
    }
    const { results } = await tools.execTools(parsed, trustCfg, null);

    // Feed tool results back into history
    let toolFeedback = '';
    for (let i = 0; i < parsed.length; i++) {
      const t = parsed[i];
      const result = results[i] || '(no output)';
      toolFeedback += `\n[Tool: ${t.name}] Result:\n${result}\n`;
    }

    history.push({ role: 'assistant', content: aiResponse });
    history.push({ role: 'user', content: `Tool execution results:\n${toolFeedback}\nContinue based on these results.` });
  }

  return fullResponse;
}

// ════════════════════════════════════════════════════════════════════════
// ── Commands ─────────────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════

const program = new Command();

program
  .name('hakster')
  .description('haksterAi CLI — manage files, sessions, and agent interactions from the terminal')
  .version(pkg.version);

// ── config ──────────────────────────────────────────────────────────────
const configCmd = program.command('config').description('Manage CLI configuration');

configCmd
  .command('set <key> <value>')
  .description('Set a config value (e.g. server URL)')
  .action((key, value) => {
    const cfg = loadConfig();
    cfg[key] = value;
    saveConfig(cfg);
  });

configCmd
  .command('get <key>')
  .description('Get a config value')
  .action((key) => {
    const cfg = loadConfig();
    console.log(cfg[key] || '(not set)');
  });

configCmd
  .command('list')
  .description('Show all config')
  .action(() => {
    const cfg = loadConfig();
    if (Object.keys(cfg).length === 0) {
      console.log('(empty — run: hakster config set server http://your-server:3579)');
    } else {
      for (const [k, v] of Object.entries(cfg)) console.log(`${k} = ${v}`);
    }
  });

// ── sudo: set the system/sudo password the agent uses for elevated commands ──
configCmd
  .command('sudo')
  .description('Set the sudo/danger password the agent uses for elevated shell commands (input hidden).')
  .option('-c, --clear', 'Remove the stored sudo/danger password')
  .action((opts) => {
    if (opts.clear) {
      const cfg = loadConfig();
      delete cfg.dangerPassword;
      saveConfig(cfg);
      console.log(`${C.green}✓ sudo/danger password cleared.${C.reset}`);
      return;
    }
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // Hide the typed password
    rl._writeToOutput = function (string) {
      if (rl.stdoutMuted) rl.output.write('*');
      else rl.output.write(string);
    };
    process.stdout.write(`${C.yellow}🔑 Enter the sudo/danger password for the agent${C.reset} (typed hidden, Enter to save): `);
    rl.stdoutMuted = true;
    rl.question('', (pwd) => {
      rl.close();
      process.stdout.write('\n');
      const pw = (pwd || '').trim();
      if (!pw) { console.log(`${C.red}✗ empty password — nothing saved.${C.reset}`); return; }
      const cfg = loadConfig();
      cfg.dangerPassword = pw;
      saveConfig(cfg);
      console.log(`${C.green}✓ sudo/danger password saved.${C.reset} ${C.gray}(stored in ~/.hakster/config.json as dangerPassword; the server pipes it via sudo -S for elevated commands. Also exportable as HAKSTER_DANGER_PASSWORD.)${C.reset}`);
    });
  });

// ── ls ──────────────────────────────────────────────────────────────────
program
  .command('ls [path]')
  .description('List files in server workspace')
  .action(async (dirPath = '/') => {
    const { server } = getConfig();
    try {
      const data = await fetchJson(`${server}/api/fs/list?path=${encodeURIComponent(dirPath)}`);
      if (Array.isArray(data)) {
        for (const item of data) {
          const type = item.type === 'dir' ? 'd' : 'f';
          const size = item.size ? String(item.size).padStart(8) : '       -';
          console.log(`${type} ${size}  ${item.name}`);
        }
      } else {
        console.log(JSON.stringify(data, null, 2));
      }
    } catch (err) {
      console.error(`Error: ${err.message}`);
    }
  });

// ── download ────────────────────────────────────────────────────────────
program
  .command('download <path>')
  .description('Download a file from the server')
  .option('-o, --output <file>', 'Save to specific file path')
  .action(async (filePath, opts) => {
    const { server } = getConfig();
    try {
      const res = await fetchUrl(`${server}/api/fs/download?path=${encodeURIComponent(filePath)}`);
      const fileName = opts.output || path.basename(filePath);
      const outPath = path.resolve(fileName);
      const writeStream = fs.createWriteStream(outPath);
      res.pipe(writeStream);
      writeStream.on('finish', () => {
        const size = fs.statSync(outPath).size;
        console.log(`Downloaded ${fileName} (${size} bytes) -> ${outPath}`);
      });
      writeStream.on('error', (err) => console.error(`Write error: ${err.message}`));
    } catch (err) {
      console.error(`Error: ${err.message}`);
    }
  });

// ── health ──────────────────────────────────────────────────────────────
program
  .command('health')
  .description('Check if server is online')
  .action(async () => {
    const { server } = getConfig();
    try {
      const data = await fetchJson(`${server}/api/health`);
      console.log(`Server: ${server}`);
      console.log(`Status: ${data.status}`);
      console.log(`Providers: ${(data.providers || []).join(', ')}`);
    } catch (err) {
      console.error(`Server unreachable: ${err.message}`);
      process.exit(1);
    }
  });

// ── status ──────────────────────────────────────────────────────────────
program
  .command('status')
  .description('Show CLI config and server connection status')
  .action(async () => {
    const cfg = loadConfig();
    console.log('Config:');
    if (Object.keys(cfg).length === 0) {
      console.log('  (empty — run: hakster config set server http://your-server:3579)');
    } else {
      for (const [k, v] of Object.entries(cfg)) console.log(`  ${k} = ${v}`);
    }
    if (cfg.server) {
      try {
        const data = await fetchJson(`${cfg.server}/api/health`);
        console.log(`\nServer: ${cfg.server}`);
        console.log(`Status: ${data.status}`);
      } catch {
        console.log(`\nServer: ${cfg.server} (unreachable)`);
      }
    }
    // Show machine profile
    try {
      const profile = mem.getMachineProfile();
      console.log(`\n${C.cyan}Machine:${C.reset}`);
      console.log(`  ${mem.formatMachineProfile(profile).split('\n').join('\n  ')}`);
    } catch {}
  });

// ── chat (full autonomous agent REPL) ───────────────────────────────────
program
  .command('chat')
  .description('Full autonomous AI agent — type tasks, it runs tools and loops until done')
  .option('-s, --system <prompt>', 'System prompt for the session')
  .option('-m, --model <model>', 'Model to use (e.g. glm-5.1:cloud-ctx)')
  .option('-p, --provider <name>', 'Provider (ollama, openai, anthropic, etc)')
  .option('--no-full-auto', 'Disable full autonomous mode (require confirmations)')
  .option('--low-token', 'Enable low-token mode (aggressive context limits to save credits)')
  .option('--fresh', 'Start fresh - ignore saved conversation history')
  .action(async (opts) => {
    let serverCfg = {};
    try { serverCfg = getConfig(); } catch { /* no server configured */ }
    const { server, apiKey } = serverCfg;
    const readline = require('readline');
    const history = (opts.fresh ? [] : loadHistory());
    // ── Session-wide tool call log (table of contents) ──
    // Every tool call gets a persistent #id (never resets within the session) so
    // the user can say "check #25" and both of us can find exactly which call that was.
    let sessionToolSeq = 0;
    const sessionToolLog = []; // [{id, name, argStr, status, preview, ms, turn}]
    if (!opts.fresh && history.length > 0) {
      console.log(`${C.gray}  ~ restored ${history.length} message(s) from last session${C.reset}\n`);
    }

    // ── Auto-init: use cached startup result or fetch fresh ──
    let autoInitFragment = '';
    try {
      if (_startupSteering) {
        autoInitFragment = '\n\n' + _startupSteering;
      } else {
        const initResult = await autolearn.autoInit(process.cwd());
        if (initResult && initResult.steering) autoInitFragment = '\n\n' + initResult.steering;
      }
    } catch (_) { /* non-blocking */ }

    const sysPrompt = opts.system || '';

    // ── Load trust config for offline mode ──
    const trustCfg = mem.loadTrust();
    try { await syncLocalMemoryToServer(server, apiKey); } catch (_) {}

    // ── Print banner via ui module ──
    try {
      const usbRoot = mem.findUSB();
      ui.printBanner(usbRoot, trustCfg);
    } catch {
      // Fallback to simple banner if ui fails
      console.log();
      console.log(`${C.green}  👻 HAKSTERAI AGENT${C.reset}  ${C.gray}·${C.reset}  ${C.gray}autonomous mode${C.reset}`);
      console.log(`${C.gray}  Commands: /help /tools /models /clear /exit${C.reset}`);
      console.log();
    }

    // ── Show offline mode status ──
    if (_offlineMode) {
      console.log(`${C.yellow}  ⚠ OFFLINE MODE — using local providers (no server)${C.reset}\n`);
    }

    // ── Low throttle mode: slow down sends to reduce server load/credits ──
    const LOW_THROTTLE = !!(opts.lowToken || process.env.HAKSTER_LOW_THROTTLE);
    const THROTTLE_DELAY_MS = parseInt(process.env.HAKSTER_THROTTLE_MS || '3000', 10);
    let _lastSendTime = 0;

    // ── Show low throttle status ──
    if (LOW_THROTTLE) {
      console.log(`${C.yellow}  🐢 LOW THROTTLE MODE — ${THROTTLE_DELAY_MS / 1000}s cooldown between sends (set HAKSTER_THROTTLE_MS to change)${C.reset}\n`);
    }

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: `${C.green}ghost@hakster>${C.reset} `,
    });

    let pending = false;
    rl.prompt();

    // ── Helper: handle all slash commands ──
    async function handleSlashCommand(text) {
      const parts = text.split(/\s+/);
      const cmd = parts[0];
      const arg = parts.slice(1).join(' ');

      // ── Exit / quit ──
      if (cmd === '/exit' || cmd === '/quit' || cmd === 'exit' || cmd === 'quit') {
        rl.close();
        return true;
      }

      // ── Clear ──
      if (cmd === '/clear') {
        history.length = 0;
        clearHistory();
        console.log(`${C.gray}history cleared${C.reset}`);
        rl.prompt();
        return true;
      }

      // ── Help ──
      if (cmd === '/help') {
        ui.showHelp();
        rl.prompt();
        return true;
      }

      // ── Tools / MCP ──
      if (cmd === '/tools' || cmd === '/mcp') {
        if (_offlineMode) {
          // Show local tool definitions
          console.log(`${C.cyan}Local Tools (offline mode):${C.reset}`);
          for (const t of (tools.TOOL_DEFINITIONS || [])) {
            console.log(`  ${C.green}${t.name}${C.reset} ${C.gray}— ${t.description || ''}${C.reset}`);
          }
        } else if (server) {
          try {
            const data = await fetchJson(`${server}/api/agent/mcp-status`, { headers: apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {} });
            const servers = data.servers || data || {};
            let total = 0;
            for (const [name, info] of Object.entries(servers)) {
              const toolList = info.tools || info || [];
              const count = Array.isArray(toolList) ? toolList.length : 0;
              total += count;
              console.log(`  ${C.green}${name}${C.reset} ${C.gray}(${count})${C.reset}`);
              if (Array.isArray(toolList)) for (const t of toolList.slice(0, 5)) console.log(`    ${C.gray}•${C.reset} ${typeof t === 'string' ? t : t.name}`);
            }
            console.log(`  ${C.cyan}Total: ${total} tools${C.reset}`);
          } catch (e) { console.log(`${C.red}${e.message}${C.reset}`); }
        }
        rl.prompt();
        return true;
      }

      // ── Models ──
      if (cmd === '/models') {
        if (_offlineMode) {
          const prov = _offlineProvider || providers.getBestProvider();
          if (prov) {
            console.log(`${C.cyan}Offline provider:${C.reset}`);
            console.log(`  ${C.green}${prov.name}${C.reset} ${C.gray}— model: ${prov.model || 'default'}${C.reset}`);
          } else {
            console.log(`${C.red}No offline provider available${C.reset}`);
          }
        } else if (server) {
          try {
            const health = await fetchJson(`${server}/api/health`);
            for (const p of (health.providers || [])) {
              try {
                const data = await fetchJson(`${server}/api/providers/${p}/models`);
                const models = data.models || [];
                if (models.length) {
                  console.log(`  ${C.green}[${p}]${C.reset}`);
                  for (const m of models.slice(0, 8)) console.log(`    ${C.gray}•${C.reset} ${typeof m === 'string' ? m : m.id}`);
                }
              } catch {}
            }
          } catch (e) { console.log(`${C.red}${e.message}${C.reset}`); }
        }
        rl.prompt();
        return true;
      }

      // ── Memory ──
      if (cmd === '/memory') {
        if (parts[1] === 'add') {
          const fact = parts.slice(2).join(' ');
          if (fact) {
            const m = mem.loadMemory();
            mem.memAddNote(m, fact);
            mem.saveMemory(m);
            const synced = await saveServerMemory(server, apiKey, {
              category: 'context',
              key: `cli_manual_${Date.now()}`,
              value: fact,
              source: 'cli',
              confidence: 0.95,
            });
            console.log(`${C.green}✓ Memory added${synced ? ' + synced' : ''}: ${fact}${C.reset}`);
          } else {
            console.log(`${C.yellow}Usage: /memory add <text>${C.reset}`);
          }
        } else if (parts[1] === 'clear') {
          const m = mem.loadMemory();
          mem.memClear(m);
          mem.saveMemory(m);
          console.log(`${C.gray}Memory cleared${C.reset}`);
        } else {
          const m = mem.loadMemory();
          const notes = mem.memGetNotes(m);
          if (notes.length === 0) {
            console.log(`${C.gray}No memory notes saved${C.reset}`);
          } else {
            console.log(`${C.cyan}Memory notes (${notes.length}):${C.reset}`);
            notes.forEach((n, i) => console.log(`  ${C.gray}${i + 1}.${C.reset} ${n}`));
          }
        }
        rl.prompt();
        return true;
      }

      // ── Trust ──
      if (cmd === '/trust') {
        if (parts[1] === 'add') {
          const p = parts[2];
          if (p) {
            const tc = mem.loadTrust();
            mem.trustPath(p, tc);
            console.log(`${C.green}✓ Trusted: ${p}${C.reset}`);
          } else {
            console.log(`${C.yellow}Usage: /trust add <path>${C.reset}`);
          }
        } else if (parts[1] === 'remove') {
          const p = parts[2];
          if (p) {
            const tc = mem.loadTrust();
            mem.untrustPath(p, tc);
            console.log(`${C.gray}✗ Untrusted: ${p}${C.reset}`);
          } else {
            console.log(`${C.yellow}Usage: /trust remove <path>${C.reset}`);
          }
        } else {
          const tc = mem.loadTrust();
          console.log(`${C.cyan}Trusted paths:${C.reset}`);
          for (const t of (tc.trusted || [])) console.log(`  ${C.green}✓${C.reset} ${t}`);
        }
        rl.prompt();
        return true;
      }

      // ── Providers ──
      if (cmd === '/providers') {
        const inv = providers.collectProviderInventory();
        console.log(`\n${C.cyan}Available Providers:${C.reset}\n`);
        for (const p of inv) {
          const sc = p.status === '✓' ? C.green : C.red;
          console.log(`  ${sc}${p.status}${C.reset} ${p.name.padEnd(14)} ${C.gray}${p.reason}${C.reset} ${C.dim}${p.cost}${C.reset}`);
        }
        console.log();
        rl.prompt();
        return true;
      }

      // ── Fallbacks ──
      if (cmd === '/fallbacks') {
        ui.listFallbacks();
        rl.prompt();
        return true;
      }

      // ── USB ──
      if (cmd === '/usb') {
        if (parts[1] === 'sync') {
          const results = mem.syncToAllUSBs([
            mem.MEMORY_FILE_NEW,
            mem.TRUST_FILE_NEW,
            providers.HOME + '/.hakster-ai-config.json',
          ].filter(f => { try { return fs.existsSync(f); } catch { return false; } }));
          if (results.length === 0) {
            console.log(`${C.yellow}No USB drives mounted${C.reset}`);
          } else {
            for (const r of results) {
              console.log(`  ${r.ok ? C.green + '✓' : C.red + '✗'}${C.reset} ${r.src} → ${r.dest || 'failed'}`);
            }
          }
        } else {
          const status = mem.usbStatus();
          if (status.mounted) {
            console.log(`${C.green}✓ USB mounted: ${status.path}${C.reset}`);
            console.log(`  ${C.gray}All mounts: ${status.paths.join(', ')}${C.reset}`);
            if (status.files.length) {
              console.log(`  ${C.gray}Files: ${status.files.join(', ')}${C.reset}`);
            }
          } else {
            console.log(`${C.yellow}No USB drives mounted${C.reset}`);
          }
        }
        rl.prompt();
        return true;
      }

      // ── Team ──
      if (cmd === '/team') {
        if (parts[1]) {
          const wf = ui.TEAM_WORKFLOWS[parts[1]];
          if (wf) {
            console.log(`${C.cyan}Team Workflow: ${wf.name}${C.reset}`);
            console.log(`  ${C.gray}${wf.desc}${C.reset}`);
            console.log(`  ${C.gray}Agents: ${wf.agents.map(a => {
              const agent = ui.AGENT_TEAM[a];
              return agent ? `${agent.emoji} ${agent.name}` : a;
            }).join(' → ')}${C.reset}`);
          } else {
            console.log(`${C.yellow}Unknown workflow: ${parts[1]}${C.reset}`);
            console.log(`${C.gray}Available: ${Object.keys(ui.TEAM_WORKFLOWS).join(', ')}${C.reset}`);
          }
        } else {
          console.log(`\n${C.cyan}Agent Team Roster:${C.reset}\n`);
          for (const [id, agent] of Object.entries(ui.AGENT_TEAM)) {
            console.log(`  ${agent.emoji} ${C.green}${agent.name}${C.reset} ${C.gray}[${id}] ${agent.callerId}${C.reset}`);
          }
          console.log(`\n${C.cyan}Team Workflows:${C.reset}\n`);
          for (const [id, wf] of Object.entries(ui.TEAM_WORKFLOWS)) {
            console.log(`  ${C.green}${id}${C.reset} ${C.gray}— ${wf.name}: ${wf.desc}${C.reset}`);
          }
          console.log();
        }
        rl.prompt();
        return true;
      }

      // ── Status (full system) ──
      if (cmd === '/status') {
        // Machine profile
        try {
          const profile = mem.getMachineProfile();
          console.log(`\n${C.cyan}Machine Profile:${C.reset}`);
          console.log(`  ${mem.formatMachineProfile(profile).split('\n').join('\n  ')}`);
        } catch {}
        // Providers
        console.log(`\n${C.cyan}Providers:${C.reset}`);
        const inv = providers.collectProviderInventory();
        for (const p of inv.slice(0, 8)) {
          const sc = p.status === '✓' ? C.green : C.red;
          console.log(`  ${sc}${p.status}${C.reset} ${p.name}`);
        }
        // Server
        if (server) {
          try {
            const data = await fetchJson(`${server}/api/health`, { timeoutMs: 3000 });
            console.log(`\n${C.cyan}Server:${C.reset} ${C.green}${data.status}${C.reset}`);
          } catch {
            console.log(`\n${C.cyan}Server:${C.reset} ${C.red}unreachable${C.reset}`);
          }
        } else {
          console.log(`\n${C.cyan}Server:${C.reset} ${C.gray}not configured${C.reset}`);
        }
        // Memory
        const m = mem.loadMemory();
        const notes = mem.memGetNotes(m);
        console.log(`\n${C.cyan}Memory:${C.reset} ${notes.length} notes`);
        // USB
        const usbSt = mem.usbStatus();
        console.log(`${C.cyan}USB:${C.reset} ${usbSt.mounted ? C.green + usbSt.path : C.gray + 'not mounted'}${C.reset}`);
        console.log();
        rl.prompt();
        return true;
      }

      // ── Local filesystem listing ──
      if (cmd === '/ls') {
        const dirPath = parts[1] || process.cwd();
        try {
          const items = fs.readdirSync(dirPath, { withFileTypes: true });
          for (const item of items) {
            const type = item.isDirectory() ? 'd' : 'f';
            try {
              const stat = fs.statSync(path.join(dirPath, item.name));
              const size = String(stat.size).padStart(8);
              console.log(`${type} ${size}  ${item.name}`);
            } catch {
              console.log(`${type}        -  ${item.name}`);
            }
          }
        } catch (e) {
          console.log(`${C.red}Error: ${e.message}${C.reset}`);
        }
        rl.prompt();
        return true;
      }

      // ── Cat (read local file) ──
      if (cmd === '/cat') {
        const filePath = parts[1];
        if (!filePath) {
          console.log(`${C.yellow}Usage: /cat <path>${C.reset}`);
        } else {
          try {
            const content = fs.readFileSync(filePath, 'utf8');
            console.log(content);
          } catch (e) {
            console.log(`${C.red}Error: ${e.message}${C.reset}`);
          }
        }
        rl.prompt();
        return true;
      }

      // ── Run (local shell command) ──
      if (cmd === '/run') {
        const shellCmd = parts.slice(1).join(' ');
        if (!shellCmd) {
          console.log(`${C.yellow}Usage: /run <command>${C.reset}`);
        } else {
          try {
            const { execSync } = require('child_process');
            const output = execSync(shellCmd, { encoding: 'utf8', timeout: 30000, maxBuffer: 5 * 1024 * 1024 });
            console.log(output);
          } catch (e) {
            console.log(`${C.red}${e.message}${C.reset}`);
          }
        }
        rl.prompt();
        return true;
      }

      // ── History ──
      if (cmd === '/history') {
        if (history.length === 0) {
          console.log(`${C.gray}No conversation history${C.reset}`);
        } else {
          console.log(`${C.cyan}Conversation History (${history.length} messages):${C.reset}`);
          history.forEach((m, i) => {
            const role = m.role === 'user' ? C.green + 'user' : C.cyan + 'assistant';
            const preview = (m.content || '').slice(0, 80).replace(/\n/g, ' ');
            console.log(`  ${C.gray}${i + 1}.${C.reset} ${role}${C.reset} ${C.gray}${preview}${m.content.length > 80 ? '...' : ''}${C.reset}`);
          });
        }
        rl.prompt();
        return true;
      }

      // ── Table of contents: list every tool call this session with its #id ──
      if (cmd === '/toc') {
        if (sessionToolLog.length === 0) {
          console.log(`${C.gray}No tool calls yet this session${C.reset}`);
        } else {
          // /toc <n> — show full detail for a single call
          const wantId = arg && /^\d+$/.test(arg.trim()) ? parseInt(arg.trim(), 10) : null;
          if (wantId != null) {
            const e = sessionToolLog.find(x => x.id === wantId);
            if (!e) {
              console.log(`${C.yellow}No tool call #${wantId} in this session${C.reset}`);
            } else {
              const statusColor = e.status === 'running' ? C.yellow : C.green;
              console.log(`${C.bold}#${e.id}${C.reset} ${C.cyan}${e.name}${C.reset} ${statusColor}${e.status}${C.reset} ${C.gray}${e.ms ? `(${e.ms}ms)` : ''}${C.reset}`);
              if (e.argStr) console.log(`  ${C.gray}args:${C.reset} ${e.argStr}`);
              if (e.preview) console.log(`  ${C.gray}result:${C.reset} ${e.preview}`);
            }
          } else {
            console.log(`${C.cyan}Table of Contents (${sessionToolLog.length} tool call${sessionToolLog.length !== 1 ? 's' : ''} this session):${C.reset}`);
            for (const e of sessionToolLog) {
              const statusMark = e.status === 'running' ? `${C.yellow}…${C.reset}` : `${C.green}✓${C.reset}`;
              const ms = e.ms ? ` ${C.gray}${e.ms}ms${C.reset}` : '';
              console.log(`  ${C.bold}#${e.id}${C.reset} ${statusMark} ${C.cyan}${e.name}${C.reset}${ms} ${C.gray}${e.preview.slice(0, 60)}${C.reset}`);
            }
            console.log(`${C.gray}Use /toc <n> for full detail on one call (e.g. /toc 25)${C.reset}`);
          }
        }
        rl.prompt();
        return true;
      }

      // ── Live grid toggle — todo/reasoning panel pinned to top of terminal, streaming
      // output scrolls in a confined region below it (like a real split pane) instead
      // of the panel overwriting scrollback each turn. Runtime toggle (no restart needed)
      // since useLiveGrid re-reads HAKSTER_LIVE_GRID from env on every message. ──
      if (cmd === '/livegrid') {
        const want = (arg || '').trim().toLowerCase();
        const turningOn = want === 'on' ? true : want === 'off' ? false : process.env.HAKSTER_LIVE_GRID !== '1';
        process.env.HAKSTER_LIVE_GRID = turningOn ? '1' : '0';
        const rows = process.stdout.rows || 0;
        const minRows = 14 + 5;
        if (turningOn && process.stdout.isTTY && rows < minRows) {
          console.log(`${C.yellow}⚠ Live grid needs a terminal at least ${minRows} rows tall (yours is ${rows}) — it won't activate until the window is taller.${C.reset}`);
        } else if (turningOn && !process.stdout.isTTY) {
          console.log(`${C.yellow}⚠ Live grid needs an interactive terminal — has no effect when piped/redirected.${C.reset}`);
        } else {
          console.log(`${C.gray}Live grid ${turningOn ? `${C.green}ON${C.gray} — panel pinned to top, output scrolls below it` : `${C.red}OFF${C.gray} — panel prints inline with output`}${C.reset}`);
        }
        rl.prompt();
        return true;
      }

      // ── Encode (base64/hex/url/rot13/binary) ──
      if (cmd === '/encode') {
        if (!arg) {
          console.log(`${C.yellow}Usage: /encode <format> <str>${C.reset}`);
          console.log(`${C.gray}Formats: base64, hex, url, rot13, binary${C.reset}`);
        } else {
          const sp = arg.indexOf(' ');
          if (sp === -1) {
            console.log(`${C.yellow}Usage: /encode <format> <str>${C.reset}`);
            console.log(`${C.gray}Formats: base64, hex, url, rot13, binary${C.reset}`);
          } else {
            const fmt = arg.slice(0, sp).toLowerCase();
            const str = arg.slice(sp + 1);
            let out = null;
            try {
              switch (fmt) {
                case 'base64': case 'b64':
                  out = Buffer.from(str, 'utf8').toString('base64'); break;
                case 'hex':
                  out = Buffer.from(str, 'utf8').toString('hex'); break;
                case 'url': case 'uri':
                  out = encodeURIComponent(str); break;
                case 'rot13':
                  out = str.replace(/[a-zA-Z]/g, c => {
                    const b = c <= 'Z' ? 65 : 97;
                    return String.fromCharCode((c.charCodeAt(0) - b + 13) % 26 + b);
                  }); break;
                case 'binary': case 'bin':
                  out = str.split('').map(c => c.charCodeAt(0).toString(2).padStart(8, '0')).join(' '); break;
                default:
                  console.log(`${C.red}Unknown format: ${fmt}${C.reset}`);
                  console.log(`${C.gray}Formats: base64, hex, url, rot13, binary${C.reset}`);
              }
            } catch (e) { out = null; }
            if (out !== null) {
              console.log(`${C.cyan}[encode:${fmt}]${C.reset} ${C.lgreen}${out}${C.reset}`);
            }
          }
        }
        rl.prompt();
        return true;
      }

      // ── Decode (auto-detect all formats) ──
      if (cmd === '/decode') {
        if (!arg) {
          console.log(`${C.yellow}Usage: /decode <str>${C.reset}`);
          console.log(`${C.gray}Auto-detects: base64, hex, url, rot13, binary, decimal, reverse${C.reset}`);
        } else {
          const results = [];
          const s = arg.trim();

          // Base64 — charset check + length multiple of 4
          if (/^[A-Za-z0-9+/]+=*?$/.test(s) && s.length % 4 === 0 && s.length >= 4) {
            try {
              const dec = Buffer.from(s, 'base64').toString('utf8');
              if (dec && /^[\x20-\x7E\r\n\t]+$/.test(dec)) results.push(['base64', dec]);
            } catch (e) {}
          }

          // Hex — all hex chars, even length
          if (/^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0 && s.length >= 2) {
            try {
              const dec = Buffer.from(s, 'hex').toString('utf8');
              if (dec && /^[\x20-\x7E\r\n\t]+$/.test(dec)) results.push(['hex', dec]);
            } catch (e) {}
          }

          // URL-encoded — contains %XX patterns
          if (/%[0-9a-fA-F]{2}/.test(s)) {
            try {
              const dec = decodeURIComponent(s);
              if (dec !== s) results.push(['url', dec]);
            } catch (e) {}
          }

          // ROT13 — always apply (reversible)
          const rot13 = s.replace(/[a-zA-Z]/g, c => {
            const b = c <= 'Z' ? 65 : 97;
            return String.fromCharCode((c.charCodeAt(0) - b + 13) % 26 + b);
          });
          if (rot13 !== s) results.push(['rot13', rot13]);

          // Binary — groups of 8 bits separated by spaces or not
          const binClean = s.replace(/\s/g, '');
          if (/^[01]+$/.test(binClean) && binClean.length % 8 === 0 && binClean.length >= 8) {
            try {
              const dec = binClean.match(/.{8}/g).map(b => String.fromCharCode(parseInt(b, 2))).join('');
              if (dec && /^[\x20-\x7E\r\n\t]+$/.test(dec)) results.push(['binary', dec]);
            } catch (e) {}
          }

          // Decimal — space-separated ASCII codes
          if (/^\d{1,3}(\s+\d{1,3})*$/.test(s)) {
            try {
              const codes = s.split(/\s+/).map(Number);
              if (codes.every(n => n >= 0 && n <= 255)) {
                const dec = codes.map(n => String.fromCharCode(n)).join('');
                if (dec && /^[\x20-\x7E\r\n\t]+$/.test(dec)) results.push(['decimal', dec]);
              }
            } catch (e) {}
          }

          // Reverse — just flip the string
          if (s.length > 1) {
            const rev = s.split('').reverse().join('');
            if (rev !== s) results.push(['reverse', rev]);
          }

          if (results.length === 0) {
            console.log(`${C.yellow}No decodings detected for: "${s}"${C.reset}`);
          } else {
            console.log(`${C.cyan}${C.bold}Decode results for:${C.reset} ${C.gray}"${s}"${C.reset}`);
            console.log();
            results.forEach(([fmt, dec]) => {
              const badge = {
                base64: C.lpurp, hex: C.lblue, url: C.yellow,
                rot13: C.lgreen, binary: C.purple, decimal: C.cyan, reverse: C.gray,
              }[fmt] || C.cyan;
              console.log(`  ${badge}${C.bold}[${fmt}]${C.reset} ${C.white}${dec}${C.reset}`);
            });
            if (results.length > 1) {
              console.log();
              console.log(`${C.dim}${results.length} possible decodings detected${C.reset}`);
            }
          }
        }
        rl.prompt();
        return true;
      }

      return false; // Not a recognized slash command
    }

    rl.on('line', async (input) => {
      const text = input.trim();
      if (!text) { rl.prompt(); return; }

      // ── Slash commands ──
      if (text.startsWith('/')) {
        const handled = await handleSlashCommand(text);
        if (handled) return;
        // Unrecognized slash command
        console.log(`${C.yellow}Unknown command: ${text}${C.reset} ${C.gray}(try /help)${C.reset}`);
        rl.prompt();
        return;
      }

      // ── Low throttle: enforce minimum inter-send cooldown ──
      if (LOW_THROTTLE && !pending) {
        const now = Date.now();
        const elapsed = now - _lastSendTime;
        if (_lastSendTime > 0 && elapsed < THROTTLE_DELAY_MS) {
          const wait = THROTTLE_DELAY_MS - elapsed;
          process.stdout.write(`${C.yellow}  ⏳ throttle: waiting ${(wait / 1000).toFixed(1)}s...${C.reset}\r`);
          await new Promise(r => setTimeout(r, wait));
          process.stdout.write(' '.repeat(50) + '\r'); // clear throttle line
        }
      }

      // 🧠 SONNET BRAIN: Auto-inject relevant past knowledge before sending to LLM
      try {
      const { execFileSync } = require('child_process');
      const injectScript = '/home/ghost/claude-code-proxy/brain_inject.js';
      const fs = require('fs');
      if (fs.existsSync(injectScript) && text && text.length > 3) {
      const result = execFileSync('node', [injectScript, '--prompt', text, '--agent', 'haksterai', '--json'], {
      timeout: 5000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
      });
      const parsed = JSON.parse(result);
      if (parsed.injected && parsed.recall_results && parsed.recall_results.length > 0) {
      text = parsed.augmented_prompt;
      process.stdout.write(`\x1b[38;5;141m 🧠 Brain: injected ${parsed.recall_results.length} memories\x1b[0m\n`);
      }
      }
      } catch (e) {
      // Non-blocking: if brain fails, use original prompt unchanged
      if (process.env.BRAIN_DEBUG) process.stdout.write(`\x1b[38;5;196m 🧠 Brain error: ${e.message}\x1b[0m\n`);
      }

    history.push({ role: 'user', content: text });

      // ══════════════════════════════════════════════════════════════════
      // ── OFFLINE MODE — direct provider call + local tool execution ──
      // ══════════════════════════════════════════════════════════════════
      if (_offlineMode || !server) {
        pending = true;
        try {
          // Build system prompt via ui module
          const fullSysPrompt = ui.buildSystemPrompt(true, 4096, trustCfg) + autoInitFragment;
          const userHistory = [...history];
          const fullResponse = await offlineAgentLoop(userHistory, fullSysPrompt, { maxRounds: 30 });

          // Store in history
          if (fullResponse) {
            history.push({ role: 'assistant', content: fullResponse });
            saveHistory(history);
            // ── Render markdown for final display ──
            console.log('\n');
            try { ui.renderMarkdown(fullResponse); } catch { /* plain text already shown */ }
            // ── Token bar ──
            try { mem.showTokenBar(history); } catch {}
            // ── Auto-save memory ──
            try { mem.extractAndSaveMemory(text, fullResponse); } catch {}
          }
          console.log();
          pending = false;
          if (rl.closed) process.exit(0);
          else rl.prompt();
        } catch (err) {
          console.error(`${C.red}  ✗ Offline error: ${err.message}${C.reset}`);
          pending = false;
          if (rl.closed) process.exit(0);
          else rl.prompt();
        }
        return;
      }

      // ══════════════════════════════════════════════════════════════════
      // ── ONLINE MODE — SSE streaming to server ──
      // ══════════════════════════════════════════════════════════════════
      const agentCwd = inferAgentCwd(text);
      const body = JSON.stringify({
        messages: [{ role: 'system', content: sysPrompt }, ...history],
        stream: true,
        provider: opts.provider || DEFAULT_AI_PROVIDER,
        model: opts.model || DEFAULT_MODEL,
        ...(agentCwd ? { cwd: agentCwd } : {}),
        ...(opts.fullAuto ? { approvalMode: 'full-auto' } : {}),
        ...(opts.lowToken ? { lowToken: true } : {}),
      });

      const headers = { 'Content-Type': 'application/json' };
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

      pending = true;
      _lastSendTime = Date.now();
      let fullResponse = '';
      let toolCount = 0;
      let turnCount = 0;
      let isThinking = false;
      let thinkingBuf = '';
      let thinkingRendered = false;
      // Live grid region (top of terminal, updates in place). Define these
      // before callbacks so connection errors can clean up safely.
      const GRID_H = 14; // 7 (todo box) + 7 (reasoning grid) — always fixed
      const termRows = process.stdout.rows || 24;
      // Live grid is OPT-IN: it jumps the cursor to row 1 and clears lines, which clobbers
      // the readline prompt/scrollback and makes the session look like it 'stopped' when the
      // agent starts. Enable with HAKSTER_LIVE_GRID=1 only if you want the top-of-screen grid.
      const useLiveGrid = process.stdout.isTTY && termRows > GRID_H + 5 && process.env.HAKSTER_LIVE_GRID === '1';
      const useSpinner = process.stdout.isTTY && process.env.HAKSTER_SPINNER !== '0';
      let scrollTop = 0;
      let lastRenderTime = 0;
      const MIN_RENDER_MS = LOW_THROTTLE ? 200 : 80; // throttle grid re-renders; slower in low-throttle mode
      const gridTurnCount = { value: 0 };
      const gridToolTimes = []; // track tool durations for avg display
      const endLiveGrid = () => {
        if (!useLiveGrid) return;
        process.stdout.write('\x1b[s\x1b[1;1H');
        for (let i = 0; i < GRID_H; i++) process.stdout.write('\x1b[2K\x1b[1B');
        process.stdout.write('\x1b[r\x1b[u');
      };
      const todoState = { status: 'active', phase: 'THINK', totalTools: 0, completedTools: 0, activeTool: 'agent', cwd: agentCwd || '', turnCount: 0, startTime: Date.now() };
      // ── Plan step grid state (phantom-style checklist) ────────────────
      const planState = { steps: [] };
      const showTodo = (patch = {}) => {
        const now = Date.now();
        if (now - lastRenderTime < MIN_RENDER_MS) return; // debounce rapid updates
        lastRenderTime = now;
        Object.assign(todoState, patch);
        if (!useLiveGrid) return;
        // Batch all ANSI escapes into a single write call to eliminate flicker
        const buf = [];
        buf.push('\x1b[s');   // save streaming cursor
        buf.push('\x1b[1;1H'); // jump to grid region (top)
        for (let i = 0; i < GRID_H; i++) buf.push('\x1b[2K\x1b[1B'); // clear
        buf.push('\x1b[1;1H'); // back to top
        process.stdout.write(buf.join(''));
        try {
          ui.renderAgentTodoBox(todoState);
          ui.renderAgentReasoningGrid(todoState);
        } catch {}
        process.stdout.write('\x1b[u');   // restore streaming cursor
      };

      try {
        const res = await fetchUrl(`${server}/api/agent/run`, { method: 'POST', headers, body, timeoutMs: 15000 });

        // ── SSE idle watchdog: fires if server goes silent mid-stream ──
        const sseWatchdog = makeSseIdleWatchdog(res, () => {
          if (pending) {
            console.error(`\n${C.red}  ✗ SSE stream stalled (no data for ${SSE_IDLE_TIMEOUT_MS / 1000}s) — aborting${C.reset}`);
            pending = false;
            endLiveGrid();
            if (!_offlineMode) {
              console.log(`${C.yellow}  ⚠ Switching to OFFLINE MODE...${C.reset}`);
              _offlineMode = true;
            }
            if (!rl.closed) rl.prompt();
          }
        });

        // ── Socket error handling ──
        res.socket.on('error', () => {
          sseWatchdog.stop();
          if (pending) {
            console.error(`\n${C.red}  ✗ Connection lost${C.reset}`);
            pending = false;
            endLiveGrid();
            // ── Switch to offline mode on connection failure ──
            if (!_offlineMode && !server === false) {
              console.log(`${C.yellow}  ⚠ Switching to OFFLINE MODE...${C.reset}`);
              _offlineMode = true;
            }
            if (!rl.closed) rl.prompt();
          }
        });

        res.on('close', () => {
          sseWatchdog.stop();
          if (pending) {
            console.error(`\n${C.red}  ✗ Connection closed by server${C.reset}`);
            pending = false;
            endLiveGrid();
            if (!rl.closed) rl.prompt();
          }
        });

        let buffer = '';
        let spinner = null; // live thinking spinner

        if (useLiveGrid) {
          scrollTop = GRID_H + 1;
          process.stdout.write(`\x1b[${scrollTop};${termRows}r`); // scroll region below grids
          process.stdout.write(`\x1b[${scrollTop};1H`);            // cursor → top of scroll region
        }
        showTodo({ status: 'active', phase: 'THINK' }); // initial grid render

        // Helper: stop spinner if running, clear its line
        const stopSpinner = () => {
          if (spinner) {
            spinner.stop();
            spinner = null;
          }
        };
        const setSpinnerActivity = (activity) => {
          if (spinner && typeof spinner.updateActivity === 'function') spinner.updateActivity(activity);
        };
        const startSpinner = (phase, activity) => {
          if (!useSpinner) return;
          stopSpinner();
          spinner = ui.thinkingAnimation(opts.model || '', phase || 'THINK');
          setSpinnerActivity(activity || `agent ${String(phase || 'THINK').toLowerCase()}`);
        };

        res.on('data', (chunk) => {
          sseWatchdog.arm(); // reset idle timer on every incoming chunk
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop();

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            try {
              const evt = JSON.parse(line.slice(6));

              if (evt.type === 'delta') {
                stopSpinner();
                process.stdout.write(evt.content);
                fullResponse += evt.content;
              }
              else if (evt.type === 'thinking_start') {
                isThinking = true;
                thinkingBuf = '';
                thinkingRendered = false;
                startSpinner('THINK', 'reading the request and choosing the next step');
              }
              else if (evt.type === 'thinking') {
                if (evt.content && evt.content.trim()) {
                  thinkingBuf += evt.content;
                  // Update spinner activity with latest phrase (1 line at bottom, in-place)
                  const lines = thinkingBuf.split('\n').map(l => l.trim()).filter(Boolean);
                  const latest = lines[lines.length - 1] || '';
                  if (latest) setSpinnerActivity(latest.slice(0, 80));
                } else {
                  setSpinnerActivity('reasoning through the next action');
                }
              }
              else if (evt.type === 'thinking_end') {
                // Don't print anything — spinner already showed latest phrase in 1 line
                stopSpinner();
                isThinking = false;
              }
              else if (evt.type === 'tool_call_start') {
                stopSpinner();
                toolCount++;
                const tname = evt.tool_name || 'unknown';
                const args = evt.tool_args || {};
                const argStr = Object.keys(args).length ? ' ' + JSON.stringify(args).slice(0, 100) : '';
                todoState._toolStart = Date.now();
                todoState._lastToolName = tname;
                // ── Table of contents: assign a session-persistent #id to this call ──
                sessionToolSeq++;
                const _tocId = sessionToolSeq;
                sessionToolLog.push({ id: _tocId, callId: evt.tool_call_id || null, name: tname, argStr: argStr.trim(), status: 'running', preview: '', ms: 0, startedAt: Date.now() });
                showTodo({ totalTools: toolCount, activeTool: tname, status: 'active' });
                startSpinner('ACT', `running ${tname}`);
                process.stdout.write(`\n${C.gray}  ↳ ${C.bold}#${_tocId}${C.reset} ${C.cyan}${tname}${C.reset}${C.gray}${argStr}${C.reset}`);
                // ── Plan grid: parse steps when plan(action=write) fires ──────
                if (tname === 'plan' && args.action === 'write' && args.content) {
                  const rawSteps = String(args.content).split('\n')
                    .map(l => l.replace(/^\s*(\d+[.)]\s*|-\s*|\*\s*)/, '').trim())
                    .filter(Boolean);
                  if (rawSteps.length > 0) {
                    planState.steps = rawSteps.map(s => ({ text: s, done: false }));
                    process.stdout.write('\n');
                    ui.printScriptGrid(planState.steps, null);
                  }
                }
              }
              else if (evt.type === 'tool_call_result') {
                const tname = evt.tool_name || '';
                const result = (evt.tool_result || '').toString();
                const preview = result.slice(0, 500).replace(/\n/g, ' ');
                const dur = todoState._toolStart ? Date.now() - todoState._toolStart : 0;
                if (dur > 0) gridToolTimes.push(dur);
                if (gridToolTimes.length > 20) gridToolTimes.shift();
                todoState._toolStart = null;
                showTodo({ completedTools: Math.max(todoState.completedTools, toolCount), activeTool: tname || todoState.activeTool, avgToolTime: _avg(gridToolTimes) });
                startSpinner('OBSERVE', `checking ${tname || 'tool'} result`);
                // ── Table of contents: close out the matching entry (by tool_call_id, else newest running w/ same name) ──
                let _tocEntry = evt.tool_call_id ? sessionToolLog.find(e => e.callId === evt.tool_call_id) : null;
                if (!_tocEntry) {
                  for (let i = sessionToolLog.length - 1; i >= 0; i--) {
                    if (sessionToolLog[i].status === 'running' && (!tname || sessionToolLog[i].name === tname)) { _tocEntry = sessionToolLog[i]; break; }
                  }
                }
                const _tocId = _tocEntry ? _tocEntry.id : null;
                if (_tocEntry) {
                  _tocEntry.status = 'done';
                  _tocEntry.preview = preview;
                  _tocEntry.ms = dur;
                }
                process.stdout.write(`\n${C.gray}  ↳ ${C.green}✓${C.reset}${_tocId ? ` ${C.bold}#${_tocId}${C.reset}` : ''} ${C.gray}${preview}${result.length > 500 ? '...' : ''}${C.reset}\n`);
                // ── Plan grid: show plan as read back from server ──────────────
                if (tname === 'plan' && planState.steps.length === 0 && result.includes('\n')) {
                  const rawSteps = result.split('\n')
                    .map(l => l.replace(/^\s*(\d+[.)]\s*|-\s*|\*\s*)/, '').trim())
                    .filter(l => l && !l.startsWith('#') && !l.startsWith('Updated'));
                  if (rawSteps.length > 1) {
                    planState.steps = rawSteps.map(s => ({ text: s, done: false }));
                    ui.printScriptGrid(planState.steps, null);
                  }
                }
              }
              else if (evt.type === 'tool_use' || evt.type === 'tool_call') {
                stopSpinner();
                toolCount++;
                const tname = evt.tool || evt.tool_name || evt.name || 'unknown';
                showTodo({ totalTools: toolCount, activeTool: tname, status: 'active' });
                startSpinner('ACT', `calling ${tname}`);
                process.stdout.write(`\n${C.gray}  ↳ [tool ${toolCount}] ${C.cyan}${tname}${C.reset}\n`);
              }
              else if (evt.type === 'tool_result') {
                const result = (evt.result || evt.tool_result || '').toString();
                const preview = result.slice(0, 500).replace(/\n/g, ' ');
                showTodo({ completedTools: Math.max(todoState.completedTools, toolCount) });
                startSpinner('OBSERVE', 'reading tool output');
                process.stdout.write(`${C.gray}  ↳ ${C.green}✓${C.reset} ${C.gray}${preview}${result.length > 500 ? '...' : ''}${C.reset}\n`);
              }
              else if (evt.type === 'file_created') {
                stopSpinner();
                process.stdout.write(`\n${C.green}  📄 Created: ${evt.path}${C.reset} ${C.gray}(${evt.tool})${C.reset}\n`);
              }
              else if (evt.type === 'image') {
                stopSpinner();
                process.stdout.write(`\n${C.magenta}  🖼️ Image: ${evt.url}${C.reset}\n`);
              }
              else if (evt.type === 'artifact') {
                stopSpinner();
                process.stdout.write(`\n${C.magenta}  📦 Artifact: ${evt.artifact.title}${C.reset}\n`);
              }
              else if (evt.type === 'turn_end') {
                stopSpinner();
                turnCount++;
                gridTurnCount.value = turnCount;
                todoState.turnCount = turnCount;
                if (fullResponse) process.stdout.write('\n');
              }
              else if (evt.type === 'compact') {
                stopSpinner();
                process.stdout.write(`\n${C.yellow}  ⚡ ${evt.message}${C.reset}\n`);
              }
              else if (evt.type === 'loop_detected') {
                stopSpinner();
                showTodo({ status: 'blocked', message: evt.message || 'Loop detected' });
                process.stdout.write(`\n${C.yellow}  ⚠ ${evt.message || 'Loop detected'}${C.reset}\n`);
              }
              else if (evt.type === 'loop_nudge') {
                showTodo({ status: 'active', activeTool: 'loop guard', message: evt.message || 'Loop nudge' });
                startSpinner('REFLECT', evt.message || 'loop guard nudging the agent forward');
                process.stdout.write(`\n${C.yellow}  ⚡ ${evt.message || 'Loop nudge'}${C.reset}\n`);
              }
              else if (evt.type === 'auto_nudge') {
                showTodo({ status: 'active', activeTool: 'auto-nudge', message: 'nudging model to use tools' });
                startSpinner('THINK', 'nudging model to act autonomously');
                process.stdout.write(`\n${C.cyan}  ⚡ ${evt.message || 'Nudging model to use tools...'}${C.reset}\n`);
              }
              else if (evt.type === 'needs_confirmation') {
                stopSpinner();
                showTodo({ status: 'blocked', activeTool: evt.tool_name || 'approval', message: evt.reason || 'Approval needed' });
                const cmd = evt.command || 'command/file change';
                const reason = evt.reason || cmd;
                const isSudoCmd = /^\s*sudo\b/i.test(String(cmd));
                // Prominent system prompt for dangerous operations
                if (isSudoCmd) {
                  process.stdout.write(`\n${C.red}${C.bold}╔══════════════════════════════════════════════════════════╗${C.reset}\n`);
                  process.stdout.write(`${C.red}${C.bold}║  🔑  SUDO PASSWORD REQUIRED — ELEVATED EXECUTION           ║${C.reset}\n`);
                  process.stdout.write(`${C.red}${C.bold}╚══════════════════════════════════════════════════════════╝${C.reset}\n`);
                  process.stdout.write(`${C.yellow}  Reason: ${reason}${C.reset}\n`);
                  process.stdout.write(`${C.gray}  Command: $ ${cmd}${C.reset}\n`);
                } else {
                  process.stdout.write(`\n${C.yellow}${C.bold}╔══════════════════════════════════════════════════════════╗${C.reset}\n`);
                  process.stdout.write(`${C.yellow}${C.bold}║  ⚠️  DANGEROUS COMMAND DETECTED — AGENT NEEDS APPROVAL   ║${C.reset}\n`);
                  process.stdout.write(`${C.yellow}${C.bold}╚══════════════════════════════════════════════════════════╝${C.reset}\n`);
                  process.stdout.write(`${C.yellow}  Reason: ${reason}${C.reset}\n`);
                  process.stdout.write(`${C.gray}  Command: $ ${cmd}${C.reset}\n`);
                }
                // Determine if a danger password is configured.
                const dangerPwd = getDangerPassword();
                if (dangerPwd) {
                  // Prompt for password (hidden input) instead of y/N.
                  rl.pause();
                  const pwdRl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
                  // Mute echo of password characters.
                  pwdRl._writeToOutput = function (string) {
                    if (pwdRl.stdoutMuted) pwdRl.output.write('*');
                    else pwdRl.output.write(string);
                  };
                  // Write prompt visibly BEFORE muting so user sees the prompt text.
                  pwdRl.stdoutMuted = false;
                  process.stdout.write(`${C.bgError}${C.butter}${C.bold} password ${C.reset} Enter to approve: `);
                  pwdRl.stdoutMuted = true;
                  pwdRl.question('', async (pwd) => {
                    pwdRl.close();
                    const approved = pwd === dangerPwd;
                    process.stdout.write(approved
                      ? `${C.green}  ✓ password accepted${C.reset}\n`
                      : `${C.red}  ✗ wrong password${C.reset}\n`);
                    try {
                      await fetchJson(`${server}/api/agent/confirm`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
                        body: JSON.stringify({ sessionId: 'default', toolCallId: evt.tool_call_id, approved, command: evt.command || '' }),
                        timeoutMs: 10000,
                      });
                    } catch (e) {
                      console.error(`${C.red}  ✗ confirm report failed: ${e.message}${C.reset}`);
                    }
                    rl.resume();
                    rl.prompt();
                  });
                } else {
                  // Fallback to existing y/N prompt.
                  // Prompt the user y/N and report the answer back to the server so the agent can proceed.
                  // Pause the main readline so its 'line' handler doesn't grab the y/N answer as a new message.
                  rl.pause();
                  const confRl = readline.createInterface({ input: process.stdin, output: process.stdout });
                  const promptText = isSudoCmd
                    ? `${C.bgError}${C.butter}${C.bold} 🔑 sudo ${C.reset} Enter your system password to approve, or Ctrl+C to deny: `
                    : `${C.bgError}${C.butter}${C.bold} y/N ${C.reset} Approve this? `;
                  confRl.question(promptText, async (ans) => {
                    confRl.close();
                    let approved = false;
                    if (isSudoCmd) {
                      // In sudo mode without a configured dangerPassword,
                      // any non-empty input is treated as approval.
                      // You can set HAKSTER_DANGER_PASSWORD to require an exact match.
                      approved = ans.trim().length > 0;
                      process.stdout.write(approved
                        ? `${C.green}  ✓ sudo approved${C.reset}\n`
                        : `${C.red}  ✗ denied${C.reset}\n`);
                    } else {
                      approved = ans.trim().toLowerCase() === 'y';
                      process.stdout.write(approved
                        ? `${C.green}  ✓ approved${C.reset}\n`
                        : `${C.red}  ✗ denied${C.reset}\n`);
                    }
                    try {
                      await fetchJson(`${server}/api/agent/confirm`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
                        body: JSON.stringify({ sessionId: 'default', toolCallId: evt.tool_call_id, approved, command: evt.command || '' }),
                        timeoutMs: 10000,
                      });
                    } catch (e) {
                      console.error(`${C.red}  ✗ confirm report failed: ${e.message}${C.reset}`);
                    }
                    rl.resume();
                    rl.prompt();
                  });
                }
              }
              else if (evt.type === 'phase') {
                const phaseColors = { THINK: C.blue, PLAN: C.yellow, ACT: C.green, OBSERVE: C.cyan, REFLECT: C.magenta, CONSOLIDATE: C.red };
                const phaseIcons  = { THINK: '🧠', PLAN: '📋', ACT: '⚡', OBSERVE: '👁', REFLECT: '🪞', CONSOLIDATE: '📦' };
                const pc = phaseColors[evt.phase] || C.gray;
                const pi = phaseIcons[evt.phase] || '•';
                const turn = evt.turn !== undefined ? ` [turn ${evt.turn}]` : '';
                showTodo({ phase: evt.phase || todoState.phase, activeTool: evt.phase || todoState.activeTool, status: 'active' });
                process.stdout.write(`\n${pc}  ${pi} ${evt.phase}${turn}${C.reset}\n`);
                const phaseActivity = {
                  THINK: 'reasoning about the request',
                  PLAN: 'choosing the next concrete action',
                  ACT: 'executing the selected tool',
                  OBSERVE: 'checking results',
                  REFLECT: 'adjusting after a problem',
                  CONSOLIDATE: 'summarizing and finishing',
                };
                startSpinner(evt.phase, phaseActivity[evt.phase] || 'agent working');
              }
              else if (evt.type === 'max_turns') {
                stopSpinner();
                process.stdout.write(`\n${C.yellow}  ⚠ Max turns (${evt.maxTurns}) reached${C.reset}\n`);
              }
              else if (evt.type === 'error') {
                stopSpinner();
                process.stdout.write(`\n${C.red}  ✗ ${evt.error || evt.message}${C.reset}\n`);
              }
              else if (evt.type === 'done') {
                stopSpinner();
                const elapsed = Date.now() - (todoState.startTime || Date.now());
                showTodo({ status: 'done', phase: 'COMPLETE', activeTool: 'complete', completedTools: Math.max(todoState.completedTools, toolCount), totalTools: Math.max(todoState.totalTools, toolCount), turnCount: turnCount, avgToolTime: _avg(gridToolTimes), sessionDur: elapsed });
                if (fullResponse) process.stdout.write('\n');
                const model = evt.model || '';
                const prov = evt.provider || '';
                if (toolCount > 0 || turnCount > 0) {
                  process.stdout.write(`${C.green}  ── done${C.reset} ${C.gray}(${toolCount} tools, ${turnCount} turns, ${_fmtMs(elapsed)}${model ? ', ' + model : ''})${C.reset}\n`);
                }
              }
              else if (evt.type === 'aborted') {
                stopSpinner();
                process.stdout.write(`\n${C.yellow}  ⚠ Aborted${C.reset}\n`);
              }
            } catch {}
          }
        });

        res.on('end', () => {
          stopSpinner();
          sseWatchdog.stop();
          if (fullResponse) {
            history.push({ role: 'assistant', content: fullResponse });
            saveHistory(history);
            // ── Render markdown for final display (after streaming) ──
            // Only do additional markdown rendering if the response wasn't streamed inline
            // (streaming already showed it). We skip re-rendering to avoid duplication.
          }
          if (!fullResponse && toolCount === 0) {
            console.log(`${C.gray}  (no response)${C.reset}`);
          }
          // ── Token bar ──
          try { mem.showTokenBar(history); } catch {}
          // ── Auto-save memory ──
          try { mem.extractAndSaveMemory(text, fullResponse); } catch {}
          console.log();
          endLiveGrid();
          pending = false;
          if (rl.closed) process.exit(0);
          else rl.prompt();
        });

        res.on('error', (err) => {
          stopSpinner();
          sseWatchdog.stop();
          console.error(`${C.red}  ✗ Stream error: ${err.message}${C.reset}`);
          // ── Fall back to offline mode on stream error ──
          if (!_offlineMode) {
            console.log(`${C.yellow}  ⚠ Falling back to OFFLINE MODE...${C.reset}`);
            _offlineMode = true;
          }
          pending = false;
          endLiveGrid();
          if (rl.closed) process.exit(0);
          else rl.prompt();
        });
      } catch (err) {
        // ── Server unreachable — switch to offline mode ──
        if (!_offlineMode) {
          console.log(`\n${C.yellow}  ⚠ Server unreachable: ${err.message}${C.reset}`);
          console.log(`${C.yellow}  ⚠ Switching to OFFLINE MODE — using local providers${C.reset}\n`);
          _offlineMode = true;
          pending = false;
          // Re-run the user's message in offline mode
          try {
            const fullSysPrompt = ui.buildSystemPrompt(true, 4096, trustCfg) + autoInitFragment;
            const userHistory = [...history];
            const fullResponse = await offlineAgentLoop(userHistory, fullSysPrompt, { maxRounds: 30 });
            if (fullResponse) {
              history.push({ role: 'assistant', content: fullResponse });
              saveHistory(history);
              console.log('\n');
              try { ui.renderMarkdown(fullResponse); } catch {}
              try { mem.showTokenBar(history); } catch {}
              try { mem.extractAndSaveMemory(text, fullResponse); } catch {}
            }
            console.log();
          } catch (offlineErr) {
            console.error(`${C.red}  ✗ Offline mode also failed: ${offlineErr.message}${C.reset}`);
          }
          if (rl.closed) process.exit(0);
          else rl.prompt();
        } else {
          console.error(`${C.red}  ✗ ${err.message}${C.reset}`);
          pending = false;
          if (rl.closed) process.exit(0);
          else rl.prompt();
        }
      }
    });

    rl.on('close', () => {
      if (pending) return;
      // Session-end consolidation safety net: shouldConsolidate()'s threshold trigger
      // only fires within a single long session (10+ tool calls). Short sessions were
      // leaving real memories stuck in raw_memories.json indefinitely since nothing
      // else ever consolidated them. Safe to call unconditionally — it's a no-op when
      // there's nothing pending.
      try { autolearn.consolidateMemories(path.join(os.homedir(), '.hakster')); } catch {}
      console.log(`\n${C.green}  session ended. 👻${C.reset}`);
      process.exit(0);
    });
  });

// ── guardian ────────────────────────────────────────────────────────────
program
  .command('guardian [args...]')
  .description('Run Guardian pentest CLI commands (scan, recon, analyze, report, workflow)')
  .option('-t, --timeout <ms>', 'Timeout in ms (default 120000)')
  .allowUnknownOption()
  .action(async (args, opts) => {
    const { execFileSync } = require('child_process');
    const wrapper = '/home/ghost/.local/bin/guardian-wrapper';
    if (!fs.existsSync(wrapper)) {
      console.error('guardian-wrapper not found. Install guardian-cli first.');
      process.exit(1);
    }
    const timeout = parseInt(opts.timeout || '120000', 10);
    const cmdArgs = args.join(' ');
    if (!cmdArgs) {
      console.log('Usage: hakster guardian <command> [options]');
      console.log('');
      console.log('Commands:');
      console.log('  init         Initialize Guardian configuration');
      console.log('  scan         Quick port scan using Nmap (e.g. scan --target 10.10.10.1)');
      console.log('  recon        Run reconnaissance workflow (e.g. recon --target example.com)');
      console.log('  analyze      Analyze scan results using AI');
      console.log('  report       Generate penetration testing report');
      console.log('  workflow     Run or list pentest workflows');
      console.log('  ai           Explain AI decisions and reasoning');
      console.log('  models       List available AI models');
      console.log('  version      Show Guardian version');
      console.log('  kb           Knowledge base maintenance');
      console.log('');
      console.log('Examples:');
      console.log('  hakster guardian scan --target 10.10.10.1');
      console.log('  hakster guardian recon --target example.com');
      console.log('  hakster guardian workflow --list');
      console.log('  hakster guardian report --format html');
      return;
    }
    try {
      const output = execFileSync(wrapper, args, {
        encoding: 'utf8',
        timeout,
        maxBuffer: 6 * 1024 * 1024,
        env: { ...process.env, CI: '1' },
      });
      console.log(output);
    } catch (err) {
      if (err.killed) {
        console.error(`Guardian timed out after ${timeout}ms`);
      } else {
        const stdout = (err.stdout || '').replace(/\x1b\[[0-9;]*m/g, '');
        const stderr = (err.stderr || '').replace(/\x1b\[[0-9;]*m/g, '');
        if (stdout) console.log(stdout);
        if (stderr) console.error(stderr);
        if (!stdout && !stderr) console.error(`Guardian error: ${err.message}`);
      }
      process.exit(err.status || 1);
    }
  });

// ── init ────────────────────────────────────────────────────────────────
program
  .command('init')
  .description('Initialize haksterAi CLI — set server URL and API key')
  .option('-s, --server <url>', 'Server URL (e.g. http://your-server:3579)')
  .option('-k, --key <key>', 'API key for authentication')
  .action(async (opts) => {
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

    console.log(`${C.cyan}╔══════════════════════════════════════╗${C.reset}`);
    console.log(`${C.cyan}║${C.reset}  ${C.green}👻 HAKSTERAI CLI SETUP${C.reset}        ${C.cyan}║${C.reset}`);
    console.log(`${C.cyan}╚══════════════════════════════════════╝${C.reset}`);
    console.log();

    const cfg = loadConfig();
    const server = opts.server || await ask(`${C.green}Server URL${C.reset} [${cfg.server || 'http://127.0.0.1:3579'}]: `) || cfg.server || 'http://127.0.0.1:3579';
    const key = opts.key || await ask(`${C.green}API key${C.reset} [${cfg.apiKey ? '****' : 'none'}]: `) || cfg.apiKey || '';

    cfg.server = server;
    if (key) cfg.apiKey = key;
    saveConfig(cfg);

    try {
      process.stdout.write(`${C.gray}Testing connection...${C.reset}\r`);
      const health = await fetchJson(`${server}/api/health`);
      console.log(`${C.green}✓ Connected!${C.reset} Providers: ${(health.providers || []).join(', ')}`);
    } catch (err) {
      console.log(`${C.yellow}⚠ Could not reach server: ${err.message}${C.reset}`);
      console.log(`${C.gray}You can configure later with: hakster config set server <url>${C.reset}`);
      console.log(`${C.gray}Offline mode will use local AI providers automatically.${C.reset}`);
    }

    rl.close();
    console.log(`\n${C.green}Ready! Run 'hakster chat' to start.${C.reset}`);
  });

// ── models ──────────────────────────────────────────────────────────────
program
  .command('models')
  .description('List available AI models from the server')
  .action(async () => {
    const { server, apiKey } = getConfig();
    const headers = {};
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    try {
      const health = await fetchJson(`${server}/api/health`, { headers });
      const provList = health.providers || [];
      console.log(`${C.cyan}Available Models:${C.reset}`);
      for (const p of provList) {
        try {
          const data = await fetchJson(`${server}/api/providers/${p}/models`, { headers });
          const models = data.models || data || [];
          if (Array.isArray(models) && models.length > 0) {
            console.log(`\n  ${C.green}[${p}]${C.reset}`);
            for (const m of models.slice(0, 15)) {
              const id = typeof m === 'string' ? m : (m.id || m.name || '?');
              console.log(`    ${C.gray}•${C.reset} ${id}`);
            }
            if (models.length > 15) console.log(`    ${C.gray}... and ${models.length - 15} more${C.reset}`);
          }
        } catch {}
      }
    } catch (err) {
      console.error(`${C.red}Error: ${err.message}${C.reset}`);
      // Show offline providers
      console.log(`${C.yellow}\nShowing offline providers:${C.reset}`);
      const inv = providers.collectProviderInventory();
      for (const p of inv) {
        const sc = p.status === '✓' ? C.green : C.red;
        console.log(`  ${sc}${p.status}${C.reset} ${p.name} ${C.gray}${p.model || ''}${C.reset}`);
      }
      process.exit(1);
    }
  });

// ── mcp ─────────────────────────────────────────────────────────────────
program
  .command('mcp')
  .description('List available MCP tools from the server')
  .action(async () => {
    const { server, apiKey } = getConfig();
    const headers = {};
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    try {
      const data = await fetchJson(`${server}/api/agent/mcp-status`, { headers });
      const servers = data.servers || data || {};
      if (typeof servers === 'object') {
        console.log(`${C.cyan}MCP Servers & Tools:${C.reset}`);
        let total = 0;
        for (const [name, info] of Object.entries(servers)) {
          const toolList = info.tools || info || [];
          const count = Array.isArray(toolList) ? toolList.length : 0;
          total += count;
          console.log(`\n  ${C.green}${name}${C.reset} ${C.gray}(${count} tools)${C.reset}`);
          if (Array.isArray(toolList)) {
            for (const t of toolList.slice(0, 8)) {
              const tName = typeof t === 'string' ? t : (t.name || '?');
              const tDesc = typeof t === 'object' ? (t.description || '').slice(0, 60) : '';
              console.log(`    ${C.gray}•${C.reset} ${tName}${tDesc ? ` ${C.gray}— ${tDesc}${C.reset}` : ''}`);
            }
            if (toolList.length > 8) console.log(`    ${C.gray}... and ${toolList.length - 8} more${C.reset}`);
          }
        }
        console.log(`\n${C.cyan}Total: ${total} tools${C.reset}`);
      } else {
        console.log(JSON.stringify(data, null, 2));
      }
    } catch (err) {
      console.error(`${C.red}Error: ${err.message}${C.reset}`);
      process.exit(1);
    }
  });

// ── agent (one-shot with SSE) ───────────────────────────────────────────
program
  .command('agent <prompt>')
  .description('Run a one-shot agent task with full tool loop (non-interactive)')
  .option('-s, --system <prompt>', 'System prompt override')
  .option('-m, --model <model>', 'Model to use (e.g. glm-5.1:cloud-ctx)')
  .option('-p, --provider <name>', 'Provider (ollama, openai, anthropic, etc)')
  .option('--no-full-auto', 'Disable full autonomous mode (require confirmations)')
  .option('--low-token', 'Enable low-token mode (aggressive context limits to save credits)')
  .action(async (prompt, opts) => {
    let serverCfg = {};
    try { serverCfg = getConfig(); } catch { /* no server */ }
    const { server, apiKey } = serverCfg;

    // ── No server or offline — use offline mode ──
    if (!server) {
      console.log(`${C.yellow}  ⚠ No server configured — using OFFLINE MODE${C.reset}\n`);
      try {
        const trustCfg = mem.loadTrust();
        const sysPrompt = ui.buildSystemPrompt(false, 8192, trustCfg);
        const history = [{ role: 'user', content: prompt }];
        const fullResponse = await offlineAgentLoop(history, sysPrompt, { maxRounds: 30, model: opts.model });
        console.log('\n');
        try { ui.renderMarkdown(fullResponse); } catch { console.log(fullResponse); }
        console.log(`\n${C.green}── done (offline) ──${C.reset}`);
      } catch (err) {
        console.error(`${C.red}  ✗ Offline error: ${err.message}${C.reset}`);
        process.exit(1);
      }
      return;
    }

    const sysPrompt = opts.system || '';
    const agentCwd = inferAgentCwd(prompt);
    const body = JSON.stringify({
      messages: [
        { role: 'system', content: sysPrompt },
        { role: 'user', content: prompt },
      ],
      stream: true,
      provider: opts.provider || DEFAULT_AI_PROVIDER,
      model: opts.model || DEFAULT_MODEL,
      ...(agentCwd ? { cwd: agentCwd } : {}),
      ...(opts.fullAuto ? { approvalMode: 'full-auto' } : {}),
      ...(opts.lowToken ? { lowToken: true } : {}),
    });
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    try {
      const res = await fetchUrl(`${server}/api/agent/run`, { method: 'POST', headers, body, timeoutMs: 15000 });
      res.socket.on('error', () => {
        console.error(`\n${C.red}✗ Connection lost${C.reset}`);
      });
      let buffer = '';
      let fullText = '';
      let toolCount = 0;
      let spinner = null;
      const stopSpinner = () => { if (spinner) { spinner.stop(); spinner = null; } };

      // ── SSE idle watchdog for one-shot agent ──
      const agentWatchdog = makeSseIdleWatchdog(res, () => {
        console.error(`\n${C.red}✗ SSE stream stalled (no data for ${SSE_IDLE_TIMEOUT_MS / 1000}s) — aborting${C.reset}`);
        stopSpinner();
      });

      res.on('data', (chunk) => {
        agentWatchdog.arm(); // reset idle timer on every incoming chunk
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const evt = JSON.parse(line.slice(6));
            if (evt.type === 'delta') {
              stopSpinner();
              process.stdout.write(evt.content);
              fullText += evt.content;
            } else if (evt.type === 'tool_use' || evt.type === 'tool_call') {
              stopSpinner();
              toolCount++;
              const tname = evt.tool || evt.tool_name || evt.name || 'unknown';
              process.stdout.write(`\n${C.gray}[tool ${toolCount}: ${tname}]${C.reset}\n`);
            } else if (evt.type === 'tool_result' || evt.type === 'tool_call_result') {
              const r = (evt.result || evt.tool_result || '').toString().slice(0, 300);
              process.stdout.write(`${C.gray}[result: ${r}]${C.reset}\n`);
            } else if (evt.type === 'tool_call_start') {
              stopSpinner();
              toolCount++;
              process.stdout.write(`\n${C.gray}[tool ${toolCount}: ${evt.tool_name}]${C.reset}\n`);
            } else if (evt.type === 'error') {
              stopSpinner();
              process.stdout.write(`\n${C.red}Error: ${evt.error}${C.reset}\n`);
            } else if (evt.type === 'loop_detected') {
              stopSpinner();
              process.stdout.write(`\n${C.yellow}⚠ ${evt.message}${C.reset}\n`);
            } else if (evt.type === 'auto_nudge') {
              process.stdout.write(`\n${C.cyan}⚡ ${evt.message || 'Nudging model to use tools...'}${C.reset}\n`);
            } else if (evt.type === 'phase') {
              const phaseColors = { THINK: C.blue, PLAN: C.yellow, ACT: C.green, OBSERVE: C.cyan, REFLECT: C.magenta, CONSOLIDATE: C.red };
              const phaseIcons  = { THINK: '🧠', PLAN: '📋', ACT: '⚡', OBSERVE: '👁', REFLECT: '🪞', CONSOLIDATE: '📦' };
              const pc = phaseColors[evt.phase] || C.gray;
              const pi = phaseIcons[evt.phase] || '•';
              const turn = evt.turn !== undefined ? ` [turn ${evt.turn}]` : '';
              stopSpinner();
              process.stdout.write(`\n${pc}  ${pi} ${evt.phase}${turn}${C.reset}\n`);
              spinner = ui.thinkingAnimation(opts.model || '', evt.phase);
            } else if (evt.type === 'max_turns') {
              stopSpinner();
              process.stdout.write(`\n${C.yellow}⚠ Max turns (${evt.maxTurns}) reached${C.reset}\n`);
            } else if (evt.type === 'done') {
              stopSpinner();
              if (evt.model || evt.provider) {
                const costStr = evt.cost ? ` · $${Number(evt.cost).toFixed(4)}` : '';
                process.stdout.write(`\n${C.gray}[answered by ${evt.provider || DEFAULT_AI_PROVIDER}/${evt.model}${costStr}]${C.reset}\n`);
              }
              process.stdout.write('\n');
            }
          } catch {}
        }
      });

      res.on('end', () => {
        agentWatchdog.stop();
        console.log(`\n${C.green}── done (${toolCount} tool calls) ──${C.reset}`);
      });

      res.on('error', (err) => {
        agentWatchdog.stop();
        console.error(`${C.red}Stream error: ${err.message}${C.reset}`);
        process.exit(1);
      });
    } catch (err) {
      // ── Fall back to offline mode for one-shot agent ──
      console.log(`${C.yellow}  ⚠ Server unreachable — trying OFFLINE MODE...${C.reset}\n`);
      try {
        const trustCfg = mem.loadTrust();
        const sysPrompt2 = ui.buildSystemPrompt(false, 8192, trustCfg);
        const history2 = [{ role: 'user', content: prompt }];
        const fullResponse = await offlineAgentLoop(history2, sysPrompt2, { maxRounds: 30, model: opts.model });
        console.log('\n');
        try { ui.renderMarkdown(fullResponse); } catch { console.log(fullResponse); }
        console.log(`\n${C.green}── done (offline) ──${C.reset}`);
      } catch (offlineErr) {
        console.error(`${C.red}  ✗ Offline error: ${offlineErr.message}${C.reset}`);
        process.exit(1);
      }
    }
  });

// ════════════════════════════════════════════════════════════════════════
// ── NEW STANDALONE COMMANDS ──────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════

// ── providers ───────────────────────────────────────────────────────────
program
  .command('providers')
  .description('List all available AI providers (online and offline)')
  .action(async () => {
    const inv = providers.collectProviderInventory();
    console.log(`\n${C.cyan}AI Provider Inventory:${C.reset}\n`);
    let available = 0;
    for (const p of inv) {
      const sc = p.status === '✓' ? C.green : p.status === '⚠' ? C.yellow : C.red;
      if (p.status === '✓') available++;
      const modelStr = p.model ? ` ${C.gray}model: ${p.model}${C.reset}` : '';
      console.log(`  ${sc}${p.status}${C.reset} ${p.name.padEnd(14)} ${C.gray}${(p.reason || '').padEnd(32)}${C.reset} ${C.dim}${p.cost}${C.reset}${modelStr}`);
    }
    console.log(`\n  ${C.cyan}${available} available / ${inv.length} total${C.reset}`);
    // Check ollama status
    const ollamaOnline = await providers.isOllamaOnline();
    console.log(`  ${ollamaOnline ? C.green + '✓' : C.gray + '○'}${C.reset} Ollama: ${ollamaOnline ? 'online' : 'offline'}\n`);
  });

// ── team ────────────────────────────────────────────────────────────────
program
  .command('team [workflow] [prompt...]')
  .description('Run an agent team workflow (e.g. hakster team fix "bug description")')
  .action(async (workflow, promptParts) => {
    const prompt = (promptParts || []).join(' ');

    if (!workflow || !ui.TEAM_WORKFLOWS[workflow]) {
      console.log(`\n${C.cyan}Agent Team Roster:${C.reset}\n`);
      for (const [id, agent] of Object.entries(ui.AGENT_TEAM)) {
        console.log(`  ${agent.emoji} ${C.green}${agent.name}${C.reset} ${C.gray}[${id}] ${agent.callerId} · ${agent.model}${C.reset}`);
      }
      console.log(`\n${C.cyan}Team Workflows:${C.reset}\n`);
      for (const [id, wf] of Object.entries(ui.TEAM_WORKFLOWS)) {
        console.log(`  ${C.green}${id}${C.reset} ${C.gray}— ${wf.name}: ${wf.desc}${C.reset}`);
      }
      console.log(`\n${C.gray}Usage: hakster team <workflow> "your task"${C.reset}`);
      console.log(`${C.gray}Example: hakster team fix "login button doesn't work"${C.reset}\n`);
      return;
    }

    if (!prompt) {
      console.log(`${C.yellow}Please provide a task prompt.${C.reset}`);
      console.log(`${C.gray}Example: hakster team fix "login button doesn't work"${C.reset}`);
      return;
    }

    const wf = ui.TEAM_WORKFLOWS[workflow];
    console.log(`\n${C.cyan}🚀 Running Team Workflow: ${wf.name}${C.reset}`);
    console.log(`  ${C.gray}Pipeline: ${wf.desc}${C.reset}\n`);

    // Run each agent in sequence
    let accumulatedContext = `Task: ${prompt}\n`;
    for (let i = 0; i < wf.agents.length; i++) {
      const agentId = wf.agents[i];
      const agent = ui.AGENT_TEAM[agentId];
      if (!agent) continue;

      console.log(`\n${C.cyan}━━━ [${i + 1}/${wf.agents.length}] ${agent.emoji} ${agent.name} ${C.gray}(${agent.callerId})${C.reset} ━━━\n`);

      const agentPrompt = `${agent.prompt}\n\nContext from previous agents:\n${accumulatedContext}\n\nExecute your specialty now.`;
      const messages = [
        { role: 'system', content: agent.prompt },
        { role: 'user', content: accumulatedContext },
      ];

      try {
        // Try server first, then offline
        let response;
        let serverCfg = {};
        try { serverCfg = getConfig(); } catch {}

        if (serverCfg.server && !_offlineMode) {
          try {
            const sseBody = JSON.stringify({
              messages: [{ role: 'system', content: agent.prompt }, { role: 'user', content: accumulatedContext }],
              stream: true,
              provider: DEFAULT_AI_PROVIDER,
              model: agent.model,
              ...(inferAgentCwd(accumulatedContext) ? { cwd: inferAgentCwd(accumulatedContext) } : {}),
            });
            const sseHeaders = { 'Content-Type': 'application/json' };
            if (serverCfg.apiKey) sseHeaders['Authorization'] = `Bearer ${serverCfg.apiKey}`;
            const res = await fetchUrl(`${serverCfg.server}/api/agent/run`, { method: 'POST', headers: sseHeaders, body: sseBody, timeoutMs: 15000 });
            let sseBuf = '';
            response = '';
            await new Promise((resolve) => {
              res.on('data', (chunk) => {
                sseBuf += chunk.toString();
                const lines = sseBuf.split('\n');
                sseBuf = lines.pop();
                for (const line of lines) {
                  if (!line.startsWith('data: ')) continue;
                  try {
                    const evt = JSON.parse(line.slice(6));
                    if (evt.type === 'delta') { process.stdout.write(evt.content); response += evt.content; }
                    else if (evt.type === 'done') { resolve(); }
                  } catch {}
                }
              });
              res.on('end', resolve);
              res.on('error', resolve);
            });
            if (!response) throw new Error('No response from server');
          } catch (serverErr) {
            // Fall back to offline
            response = await offlineLLMCall(messages, { model: agent.model, maxTokens: 4096 });
            process.stdout.write(response);
          }
        } else {
          response = await offlineLLMCall(messages, { model: agent.model, maxTokens: 4096 });
          process.stdout.write(response);
        }

        accumulatedContext += `\n\n[${agent.name} output]:\n${response}\n`;
        console.log(`\n${C.green}  ✅ ${agent.name} done${C.reset}`);
      } catch (err) {
        console.log(`\n${C.red}  ✗ ${agent.name} failed: ${err.message}${C.reset}`);
      }
    }

    console.log(`\n${C.green}═══ Team workflow complete ═══${C.reset}\n`);
  });

// ── usb ─────────────────────────────────────────────────────────────────
program
  .command('usb')
  .description('Show USB status and sync options')
  .action(async () => {
    const status = mem.usbStatus();
    if (status.mounted) {
      console.log(`${C.green}✓ USB drive mounted${C.reset}`);
      console.log(`  ${C.gray}Path: ${status.path}${C.reset}`);
      console.log(`  ${C.gray}All mounts: ${status.paths.join(', ')}${C.reset}`);
      if (status.files.length) {
        console.log(`  ${C.gray}Sample files: ${status.files.join(', ')}${C.reset}`);
      }
      console.log(`\n${C.cyan}Sync options:${C.reset}`);
      console.log(`  ${C.gray}hakster usb sync${C.reset} — sync config files to USB`);
    } else {
      console.log(`${C.yellow}No USB drives mounted.${C.reset}`);
      console.log(`${C.gray}USB paths checked: ${mem.USB_PATHS.join(', ')}${C.reset}`);
      console.log(`\n${C.gray}Mount a USB drive to /media/ghost/ to enable sync.${C.reset}`);
    }

    // Also show sync status
    const trustCfg = mem.loadTrust();
    if (trustCfg.auto_usb_sync) {
      console.log(`\n${C.green}✓ Auto USB sync enabled${C.reset}`);
    } else {
      console.log(`\n${C.gray}Auto USB sync disabled${C.reset}`);
    }
  });

// ── TUI mode — Ink/React interface ───────────────────────────────────────
program
  .command('ui')
  .description('Launch haksterAI TUI (Ink/React)')
  .action(() => {
    // Ink requires a real TTY for raw mode key input
    if (!process.stdin.isTTY) {
      console.log(`${C.red}✗ TUI requires a real terminal (TTY).${C.reset}`);
      console.log(`${C.dim}Run this command directly in your terminal, not through a pipe or non-interactive shell.${C.reset}`);
      console.log(`${C.dim}Try: ${C.green}node cli/index.js ui${C.reset}`);
      process.exit(1);
    }
    process.stdin.setRawMode(true);
    process.stdin.resume();
    // Enter alternate screen buffer so TUI doesn't clobber scrollback
    process.stdout.write('\x1b[?1049h\x1b[?25l');

    // ── Terminal restoration: ensure the screen never “disappears” on exit/crash ──
    let _restored = false;
    function restoreTerminal() {
      if (_restored) return;
      _restored = true;
      try { process.stdin.setRawMode(false); } catch {}
      try { process.stdin.pause(); } catch {}
      // show cursor + leave alternate screen so scrollback is restored
      process.stdout.write('\x1b[?25h\x1b[?1049l');
    }
    process.on('exit', restoreTerminal);
    process.on('SIGINT',  () => { restoreTerminal(); process.exit(0); });
    process.on('SIGTERM', () => { restoreTerminal(); process.exit(0); });
    process.on('uncaughtException', (err) => {
      restoreTerminal();
      console.error('\n' + (err && err.stack ? err.stack : err));
      process.exit(1);
    });
    process.on('unhandledRejection', (err) => {
      restoreTerminal();
      console.error('\nUnhandled rejection:', err);
      process.exit(1);
    });

    import('./ui.mjs').then(mod => {
      try { mod.start(); }
      catch (err) { restoreTerminal(); console.error(err); process.exit(1); }
    }).catch(err => { restoreTerminal(); console.error(err); process.exit(1); });
  });

// ── sessions — grid box view of server sessions ──────────────────────────
program
  .command('sessions')
  .description('List all server sessions in a grid box layout')
  .option('-l, --limit <n>', 'Max sessions to display', '20')
  .action(async (opts) => {
    const { server } = getConfig();
    try {
      const data = await fetchJson(`${server}/api/sessions`);
      let sessions = data.sessions || [];
      const limit = parseInt(opts.limit, 10) || 20;
      sessions = sessions.slice(0, limit);

      if (sessions.length === 0) {
        console.log(`${C.dim}No sessions found.${C.reset}`);
        return;
      }

      // Box width and layout
      const COLS = 2;
      const BOX_W = 44;
      const HALF_W = Math.floor((BOX_W - 3) / 2); // for two boxes side by side

      function pad(str, len) {
        str = String(str || '');
        if (str.length > len) return str.slice(0, len - 1) + '…';
        return str + ' '.repeat(len - str.length);
      }

      function boxTop(label) {
        return `${C.cyan}┌─${C.reset}${C.bold}${label}${C.reset}${C.cyan}${'─'.repeat(Math.max(1, HALF_W - label.length - 1))}┐${C.reset}`;
      }
      function boxMid() {
        return `${C.cyan}│${' '.repeat(HALF_W)}│${C.reset}`;
      }
      function boxRow(label, val) {
        const line = `${C.dim}${pad(label, 8)}${C.reset}${pad(val, HALF_W - 8)}`;
        return `${C.cyan}│${C.reset}${line}${C.cyan}│${C.reset}`;
      }
      function boxBot() {
        return `${C.cyan}└${'─'.repeat(HALF_W)}┘${C.reset}`;
      }

      console.log(`\n${C.bold}${C.magenta}  📦 haksterAi Sessions${C.reset} ${C.dim}— ${sessions.length} session(s)${C.reset}\n`);

      for (let i = 0; i < sessions.length; i += COLS) {
        const row = sessions.slice(i, i + COLS);
        const lines = [];

        // Top borders
        lines.push(row.map(s => boxTop(s.id.slice(0, 8))).join(' '));
        // ID row
        lines.push(row.map(s => boxRow('ID', s.id.slice(0, HALF_W - 9))).join(' '));
        // Provider
        lines.push(row.map(s => boxRow('PROV', s.provider || 'ollama')).join(' '));
        // Model
        lines.push(row.map(s => boxRow('MODEL', (s.model || '').slice(0, HALF_W - 9))).join(' '));
        // Title
        lines.push(row.map(s => boxRow('TITLE', (s.title || '(untitled)').slice(0, HALF_W - 9))).join(' '));
        // Updated
        const updated = (s) => {
          const ts = s.updated_at || s.created_at;
          if (!ts) return '—';
          const d = new Date(typeof ts === 'number' ? ts : Date.parse(ts));
          return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        };
        lines.push(row.map(s => boxRow('UPD', updated(s))).join(' '));
        // Msgs count if available
        lines.push(row.map(s => boxRow('MSGS', String(s.message_count || (s.messages ? s.messages.length : '—')))).join(' '));
        // Bottom borders
        lines.push(row.map(s => boxBot()).join(' '));

        for (const line of lines) console.log('  ' + line);
        console.log();
      }

      console.log(`${C.dim}  Use ${C.reset}${C.green}hakster resume <id>${C.reset}${C.dim} to continue a session${C.reset}`);
    } catch (err) {
      console.error(`Failed to fetch sessions: ${err.message}`);
      process.exit(1);
    }
  });

// ── resume — continue a saved session ──────────────────────────────────
program
  .command('resume <id>')
  .description('Resume a saved session by ID — loads its messages and opens the chat REPL')
  .option('-m, --model <model>', 'Model to use')
  .option('-p, --provider <name>', 'Provider')
  .action(async (id, opts) => {
    const { server } = getConfig();
    try {
      const sess = await fetchJson(`${server}/api/sessions/${id}`);
      if (!sess || sess.error) {
        console.error(`Session not found: ${id}`);
        process.exit(1);
      }
      const msgs = (sess.messages || [])
        .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .map(m => ({ role: m.role, content: m.content }));
      saveHistory(msgs);
      console.log(`${C.green}✓${C.reset} Resumed session ${C.bold}${id.slice(0, 8)}${C.reset} — ${msgs.length} message(s) loaded into history`);
      if (sess.provider) console.log(`  Provider: ${sess.provider}`);
      if (sess.model) console.log(`  Model:    ${sess.model}`);
      // Re-launch the chat REPL; it auto-loads the history we just saved.
      const { spawn } = require('child_process');
      const args = [__filename, 'chat'];
      if (opts.model) args.push('--model', opts.model);
      if (opts.provider) args.push('--provider', opts.provider);
      const child = spawn(process.execPath, args, { stdio: 'inherit' });
      child.on('exit', (code) => process.exit(code || 0));
    } catch (err) {
      console.error(`Failed to resume: ${err.message}`);
      process.exit(1);
    }
  });

// ── cockpit — open the web cockpit dashboard in a browser ───────────────────
program
  .command('cockpit')
  .description('Open the haksterAi web cockpit dashboard in your default browser')
  .option('--host <url>', 'Server host', null)
  .action(async (opts) => {
    const { exec } = require('child_process');
    const { server } = getConfig();
    const host = (opts.host || server || 'http://localhost:3579').replace(/\/$/, '');
    const url = `${host}/cockpit`;
    console.log(`${C.green}●${C.reset} Opening cockpit at ${C.cyan}${url}${C.reset}`);

    const platform = process.platform;
    let cmd;
    if (platform === 'darwin') cmd = `open ${JSON.stringify(url)}`;
    else if (platform === 'win32') cmd = `start "" ${JSON.stringify(url)}`;
    else cmd = `xdg-open ${JSON.stringify(url)}`;

    exec(cmd, (err) => {
      if (err) {
        console.log(`${C.yellow}⚠ Could not auto-open browser.${C.reset}`);
        console.log(`${C.dim}Open manually:${C.reset} ${C.cyan}${url}${C.reset}`);
        process.exit(0);
      }
    });
  });

// ── no args? launch straight into chat ──────────────────────────────────
if (process.argv.length <= 2) {
  process.argv.push('chat');
}

// License gate is checked at top of file before program.parse
program.parse();
