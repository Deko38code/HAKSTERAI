/**
 * haksterAi — Smart Agent Router
 *
 * Routes agent tasks to the cheapest available backend based on:
 *   - Task type (code, recon, pentest, chat, image, research)
 *   - Model availability (local Ollama, Miniforge, phantom gateway, parrot, kaggle)
 *   - Cost (always cheapest first — local > GPU > gateway > cloud-redirect)
 *   - Schedule (cron-style or interval-based agent dispatch)
 *
 * Rules:
 *   - NEVER route to real Claude/Anthropic API (refuses commands, breaks agent)
 *   - ALWAYS use cheapest tier that can handle the task
 *   - Cloud model aliases (claude-sonnet-4-5, gpt-4.1) route to local uncensored models
 *   - Miniforge (port 5555) is always free, 48 bots, no refusals
 *
 * Usage:
 *   const router = require('./smart-router');
 *   router.init();
 *   const backend = router.route({ type: 'code', message: 'fix bug in server.js' });
 *   router.schedule('0 9 * * *', { type: 'health-check', message: 'check all services' });
 */

const http = require('http');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ── Tier definitions (GLM cloud = always default backbone, free tiers chained first to save tokens) ────

const TIERS = {
  // T1: FREE CLOUD — fast, supports tools, no credit card
  // Groq 500+ tok/s, Cerebras 2000 tok/s, SambaNova 70B — use these for most work
  T1_FREE_CLOUD: {
    name: 'free-cloud',
    cost: 0,
    url: 'http://localhost:4000/api/ai/chat',
    models: {
      fast: 'groq',          // 500+ tok/s — default for most tasks
      faster: 'cerebras',    // 2000 tok/s — quick responses
      heavy: 'sambanova',    // Llama 3.3 70B — complex tasks
      fallback: 'openrouter',// Qwen3 235B free — backup
      nokey: 'pollinations', // GPT-4o proxy — no key needed
    }
  },
  // T2: HACKBOTS/Miniforge — free, uncensored, no refusals.
  // Credit maker rotator keeps hackbots sustainable — always chained.
  T2_MINIFORGE: {
    name: 'miniforge',
    cost: 0,
    url: 'http://localhost:5555/api/apps',
    models: {
      uncensored: 'ai-unrestricted',
      coding: 'RobloxScriptHelper',
      chat: 'chatgpt',
      creative: 'claude-3-5-sonnet',
      reasoning: 'gemini-experimental-2-5',
      hack: 'redhot-butterfly',
    }
  },
  // T3: GLM CLOUD — ALWAYS DEFAULT BACKBONE. Premium, smart, always available.
  // Chained after free tiers so it's used less, but always in the chain.
  // Burns GLM tokens but free tiers intercept most traffic first.
  T3_GLM_CLOUD: {
    name: 'glm-cloud',
    cost: 1,  // costs tokens — free tiers intercept first to save these
    url: 'http://localhost:11434/api/chat',
    models: {
      default: 'hp-1000:latest',        // glm-5.1:cloud + uncensored system prompt
      power: 'glm-5.1:cloud',           // raw glm-5.1 — high quality
      code: 'hp-1000:latest',            // uncensored coder on cloud
    }
  },
  // T4: PHANTOM GATEWAY — free external providers (same as T1 but via Phantom)
  T4_PHANTOM: {
    name: 'phantom-gateway',
    cost: 0,
    url: 'http://localhost:4000/api/ai/chat',
    models: {
      groq: 'groq',
      gemini: 'gemini',
      cerebras: 'cerebras',
      sambanova: 'sambanova',
      openrouter: 'openrouter',
    }
  },
  // T5: PARROT BOX — remote Ollama on Parrot (free, has different models)
  T5_PARROT: {
    name: 'parrot-box',
    cost: 0,
    url: 'http://10.0.0.251:11434/api/chat',
    models: {
      code: 'deepseek-coder-v2:16b',
      fast: 'phi3:mini',
      fallback: 'codellama:7b',
    }
  },
  // T6: KAGGLE GPU — free GPU (30 hrs/wk per account, 90 hrs with 3 accounts)
  T6_KAGGLE: {
    name: 'kaggle-gpu',
    cost: 0,
    url: '',  // Set via KAGGLE_TUNNEL env
    models: {
      heavy: 'qwen2.5:32b',
      reasoning: 'deepseek-r1:14b',
    }
  },
  // T7: LOCAL OLLAMA — free but SLOW on 7GB RAM (1-3 tok/s). Last resort only.
  T7_LOCAL: {
    name: 'local-ollama',
    cost: 0,
    url: 'http://localhost:11434/api/chat',
    models: {
      code: 'hp-1000:latest',
      chat: 'kimi-uncensored:latest',
      power: 'glm-uncensored:latest',
      fast: 'kimi-uncensored:latest',
      security: 'hp-1000:latest',
      research: 'glm-uncensored:latest',
    }
  },
  // T8: CLOUD aliases — compatibility labels, route to GLM cloud
  T8_CLOUD_ALIAS: {
    name: 'cloud-alias-glm',
    cost: 1,  // costs GLM tokens
    url: 'http://localhost:11434/api/chat',
    models: {
      'claude-sonnet-4-5': 'hp-1000:latest',
      'claude-opus-4-5': 'glm-5.1:cloud',
      'claude-haiku-3-5': 'hp-1000:latest',
      'gpt-4.1': 'hp-1000:latest',
      'gpt-4.1-mini': 'hp-1000:latest',
      'gemini-2.5-pro': 'glm-5.1:cloud',
      'gemini-2.5-flash': 'hp-1000:latest',
    }
  }
};

// ── Task type detection ──────────────────────────────────────────────────────

const TASK_KEYWORDS = {
  code: ['function', 'class', 'bug', 'fix', 'refactor', 'endpoint', 'route', 'api', 'server', 'client',
         'javascript', 'python', 'node', 'react', 'express', 'script', 'compile', 'build', 'deploy',
         'file', 'edit', 'write', 'code', 'implement', 'feature', 'merge', 'commit', 'git'],
  security: ['pentest', 'exploit', 'reverse shell', 'nmap', 'scan', 'vuln', 'bypass', 'payload',
             'xss', 'sqli', 'ssrf', 'rce', 'lfi', 'osint', 'recon', 'brute', 'fuzz', 'waf',
             'cloudflare', 'captcha', 'injection', 'escalation', 'forensic', 'malware'],
  research: ['research', 'analyze', 'compare', 'investigate', 'find', 'search', 'document',
             'explain', 'summarize', 'report', 'study', 'review'],
  chat: ['hello', 'hey', 'yo', 'what', 'how', 'why', 'when', 'where', 'who', 'tell me',
         'chat', 'talk', 'discuss', 'opinion', 'think'],
  image: ['image', 'picture', 'photo', 'draw', 'generate image', 'render', 'flux', 'sdxl'],
  power: ['architecture', 'design system', 'refactor large', 'migrate', 'rewrite', 'scale',
          'optimize', 'performance', 'complex', 'multi-step', 'plan'],
};

function detectTaskType(message) {
  const lower = (message || '').toLowerCase();
  // Security tasks get priority — never refuse
  for (const kw of TASK_KEYWORDS.security) {
    if (lower.includes(kw)) return 'security';
  }
  for (const kw of TASK_KEYWORDS.image) {
    if (lower.includes(kw)) return 'image';
  }
  for (const kw of TASK_KEYWORDS.power) {
    if (lower.includes(kw)) return 'power';
  }
  for (const kw of TASK_KEYWORDS.code) {
    if (lower.includes(kw)) return 'code';
  }
  for (const kw of TASK_KEYWORDS.research) {
    if (lower.includes(kw)) return 'research';
  }
  return 'chat';
}

// ── Backend health checks ─────────────────────────────────────────────────────

let _health = {};
function checkHealth() {
  const checks = [
    { tier: 'T1_FREE_CLOUD', host: '127.0.0.1', port: 4000 },   // Phantom gateway
    { tier: 'T2_MINIFORGE', host: '127.0.0.1', port: 5555 },   // Miniforge bots
    { tier: 'T3_GLM_CLOUD', host: '127.0.0.1', port: 11434 },   // Ollama (GLM cloud proxies through here)
    { tier: 'T4_PHANTOM', host: '127.0.0.1', port: 4000 },       // Same as T1
    { tier: 'T5_PARROT', host: '10.0.0.251', port: 11434 },      // Remote Parrot box
    { tier: 'T7_LOCAL', host: '127.0.0.1', port: 11434 },        // Local Ollama
  ];
  for (const chk of checks) {
    const sock = new (require('net').Socket)();
    sock.setTimeout(2000);
    sock.on('connect', () => { _health[chk.tier] = true; sock.destroy(); });
    sock.on('error', () => { _health[chk.tier] = false; sock.destroy(); });
    sock.on('timeout', () => { _health[chk.tier] = false; sock.destroy(); });
    sock.connect(chk.port, chk.host);
  }
  _health.T6_KAGGLE = !!process.env.KAGGLE_TUNNEL;
  _health.T8_CLOUD_ALIAS = true; // always — routes to GLM cloud
}

// ── Router ─────────────────────────────────────────────────────────────────

/**
 * Route a task to the cheapest available backend.
 * Strategy: GLM cloud is ALWAYS the default backbone. Free tiers (T1 cloud, T2 hackbots)
 * are chained first to intercept most traffic and save GLM tokens. GLM is always
 * available as the premium fallback — used less but always there.
 *
 * Chain order:
 *   1. T1 FREE CLOUD (Groq/Cerebras/SambaNova) — fast, free, saves GLM tokens
 *   2. T2 HACKBOTS/Miniforge — free, uncensored, credit maker rotator (sustainable)
 *   3. T3 GLM CLOUD — always default backbone, premium, used less
 *   4. T4-T7 — extra free fallbacks (Phantom, Parrot, Kaggle, local Ollama)
 *
 * Returns the first healthy tier in the chain. Callers can also use routeChain()
 * to get the full ordered list for waterfall execution.
 *
 * @param {Object} task - { type?, message, model? }
 * @returns {Object} { tier, url, model, displayModel, cost }
 */
function route(task = {}) {
  const chain = routeChain(task);
  return chain[0];  // first healthy in chain
}

/**
 * Build the full routing chain — GLM cloud always included as default backbone.
 * Free tiers (T1, T2) come first to save GLM tokens. GLM is always in the chain.
 * @param {Object} task - { type?, message, model? }
 * @returns {Array} ordered list of backends to try (first = preferred)
 */
function routeChain(task = {}) {
  const type = task.type || detectTaskType(task.message || '');
  const requestedModel = task.model || '';
  const chain = [];

  // If a specific cloud alias is requested, route directly to GLM cloud (premium)
  if (requestedModel && TIERS.T8_CLOUD_ALIAS.models[requestedModel]) {
    const cloudModel = TIERS.T8_CLOUD_ALIAS.models[requestedModel];
    return [{
      tier: 'T8_CLOUD_ALIAS',
      name: TIERS.T8_CLOUD_ALIAS.name,
      url: TIERS.T8_CLOUD_ALIAS.url,
      model: cloudModel,
      displayModel: requestedModel,
      cost: 1,  // burns GLM tokens
      redirected: true,
    }];
  }

  // 1. T1: FREE CLOUD — Groq/Cerebras/SambaNova (fast, free, saves GLM tokens)
  if (_health.T1_FREE_CLOUD !== false) {
    const providerMap = {
      code: 'groq',          // 500+ tok/s, great for code
      chat: 'cerebras',      // 2000 tok/s, instant responses
      power: 'sambanova',    // Llama 3.3 70B, complex reasoning
      security: 'groq',      // fast + good for security scripts
      research: 'sambanova', // 70B for deep research
      fast: 'cerebras',      // 2000 tok/s
      image: 'pollinations', // free GPT-4o proxy
    };
    const provider = providerMap[type] || 'groq';
    chain.push({
      tier: 'T1_FREE_CLOUD',
      name: TIERS.T1_FREE_CLOUD.name,
      url: TIERS.T1_FREE_CLOUD.url,
      model: provider,
      displayModel: `free-${provider}`,
      cost: 0,
    });
  }

  // 2. T2: HACKBOTS/Miniforge — free, uncensored, no refusals.
  //    Credit maker rotator = sustainable, always chained.
  if (_health.T2_MINIFORGE !== false) {
    const botMap = { code: 'RobloxScriptHelper', security: 'ai-unrestricted', chat: 'chatgpt',
                     power: 'gemini-experimental-2-5', research: 'gemini-experimental-2-5', image: 'flux-schnell-image-generator' };
    const bot = botMap[type] || 'ai-unrestricted';
    chain.push({
      tier: 'T2_MINIFORGE',
      name: TIERS.T2_MINIFORGE.name,
      url: `http://localhost:5555/api/apps/${bot}/chat`,
      model: bot,
      displayModel: bot,
      cost: 0,
    });
  }

  // 3. T3: GLM CLOUD — ALWAYS DEFAULT BACKBONE. Premium, used less, but always in chain.
  //    This is the guaranteed fallback — if free tiers fail, GLM is always here.
  if (_health.T3_GLM_CLOUD !== false) {
    const modelMap = {
      code: 'hp-1000:latest',     // uncensored on GLM cloud
      power: 'glm-5.1:cloud',     // raw GLM — highest quality
      chat: 'hp-1000:latest',
      security: 'hp-1000:latest',
      research: 'glm-5.1:cloud',
    };
    const model = modelMap[type] || 'hp-1000:latest';
    chain.push({
      tier: 'T3_GLM_CLOUD',
      name: TIERS.T3_GLM_CLOUD.name,
      url: TIERS.T3_GLM_CLOUD.url,
      model,
      displayModel: model,
      cost: 1,  // burns GLM tokens — used less but always available
      isDefault: true,  // marks this as the default backbone
    });
  }

  // 4. T4: PHANTOM GATEWAY — same free providers, different route
  if (_health.T4_PHANTOM !== false) {
    chain.push({
      tier: 'T4_PHANTOM',
      name: TIERS.T4_PHANTOM.name,
      url: TIERS.T4_PHANTOM.url,
      model: 'groq',
      displayModel: 'phantom-groq',
      cost: 0,
    });
  }

  // 5. T5: Parrot box (remote Ollama, free)
  if (_health.T5_PARROT !== false) {
    chain.push({
      tier: 'T5_PARROT',
      name: TIERS.T5_PARROT.name,
      url: TIERS.T5_PARROT.url,
      model: TIERS.T5_PARROT.models.code,
      displayModel: TIERS.T5_PARROT.models.code,
      cost: 0,
    });
  }

  // 6. T6: Kaggle GPU (free, if tunnel up)
  if (_health.T6_KAGGLE) {
    chain.push({
      tier: 'T6_KAGGLE',
      name: TIERS.T6_KAGGLE.name,
      url: (process.env.KAGGLE_TUNNEL || '').replace(/\/$/, '') + '/api/chat',
      model: TIERS.T6_KAGGLE.models.heavy,
      displayModel: TIERS.T6_KAGGLE.models.heavy,
      cost: 0,
    });
  }

  // 7. T7: LOCAL OLLAMA — free but SLOW on 7GB RAM. Last resort.
  if (_health.T7_LOCAL !== false) {
    const model = TIERS.T7_LOCAL.models[type] || TIERS.T7_LOCAL.models.chat;
    chain.push({
      tier: 'T7_LOCAL',
      name: TIERS.T7_LOCAL.name,
      url: TIERS.T7_LOCAL.url,
      model,
      displayModel: model,
      cost: 0,
    });
  }

  // If nothing is healthy, GLM cloud is ALWAYS the absolute fallback
  if (chain.length === 0) {
    chain.push({
      tier: 'T8_CLOUD_ALIAS',
      name: TIERS.T8_CLOUD_ALIAS.name,
      url: TIERS.T8_CLOUD_ALIAS.url,
        model: 'hp-1000:latest',
      displayModel: 'hp-1000:latest',
      cost: 1,
    });
  }

  return chain;
}

// ── Scheduler — cron-style agent dispatch ────────────────────────────────────

const _scheduledJobs = [];
const CRON_FILE = path.join(process.env.HOME || '/home/ghost', '.hakster', 'agent-schedule.json');

function loadSchedule() {
  try {
    if (fs.existsSync(CRON_FILE)) {
      return JSON.parse(fs.readFileSync(CRON_FILE, 'utf8'));
    }
  } catch (e) { /* ignore */ }
  return [];
}

function saveSchedule(jobs) {
  try {
    const dir = path.dirname(CRON_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CRON_FILE, JSON.stringify(jobs, null, 2));
  } catch (e) { /* ignore */ }
}

/**
 * Schedule an agent task on a cron schedule.
 * @param {string} cron - 5-field cron expression (e.g. "0 9 * * *")
 * @param {Object} task - { type, message, model? }
 * @param {Object} opts - { recurring (default true), durable (default true) }
 * @returns {string} job ID
 */
function schedule(cronExpr, task, opts = {}) {
  const id = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const job = {
    id,
    cron: cronExpr,
    task,
    recurring: opts.recurring !== false,
    durable: opts.durable !== false,
    createdAt: new Date().toISOString(),
    lastRun: null,
    runCount: 0,
    nextRun: _nextCronRun(cronExpr),
  };
  _scheduledJobs.push(job);
  if (job.durable) {
    const stored = loadSchedule();
    stored.push(job);
    saveSchedule(stored);
  }
  return id;
}

/**
 * Schedule a one-shot agent task N seconds from now.
 * @param {number} delaySeconds - seconds from now
 * @param {Object} task - { type, message, model? }
 * @returns {string} job ID
 */
function scheduleOnce(delaySeconds, task) {
  const id = `once_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const runAt = Date.now() + delaySeconds * 1000;
  const job = {
    id,
    type: 'once',
    runAt,
    task,
    recurring: false,
    durable: false,
    createdAt: new Date().toISOString(),
  };
  _scheduledJobs.push(job);
  setTimeout(() => {
    _dispatchJob(job);
  }, delaySeconds * 1000);
  return id;
}

function cancelJob(id) {
  const idx = _scheduledJobs.findIndex(j => j.id === id);
  if (idx >= 0) {
    _scheduledJobs.splice(idx, 1);
    const stored = loadSchedule();
    const sIdx = stored.findIndex(j => j.id === id);
    if (sIdx >= 0) {
      stored.splice(sIdx, 1);
      saveSchedule(stored);
    }
    return true;
  }
  return false;
}

function listJobs() {
  return _scheduledJobs.map(j => ({
    id: j.id,
    cron: j.cron,
    task: j.task,
    recurring: j.recurring,
    lastRun: j.lastRun,
    runCount: j.runCount,
    nextRun: j.nextRun,
  }));
}

// ── Cron parser (5-field: min hour dom mon dow) ─────────────────────────────

function _parseCron(expr) {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const ranges = [[0,59],[0,23],[1,31],[1,12],[0,6]];
  const fields = parts.map((p, i) => {
    if (p === '*') return null; // any
    if (p.startsWith('*/')) {
      const step = parseInt(p.slice(2));
      return { step, min: ranges[i][0], max: ranges[i][1] };
    }
    if (p.includes(',')) {
      return { values: p.split(',').map(Number) };
    }
    return { values: [parseInt(p)] };
  });
  return fields;
}

function _nextCronRun(expr) {
  const fields = _parseCron(expr);
  if (!fields) return null;
  const now = new Date();
  // Simple: increment minute by minute until match (max 60*24 checks)
  for (let i = 0; i < 1440; i++) {
    const t = new Date(now.getTime() + i * 60000);
    const vals = [t.getMinutes(), t.getHours(), t.getDate(), t.getMonth() + 1, t.getDay()];
    let match = true;
    for (let f = 0; f < 5; f++) {
      if (!fields[f]) continue; // wildcard
      if (fields[f].step) {
        if ((vals[f] - fields[f].min) % fields[f].step !== 0) { match = false; break; }
      } else if (fields[f].values) {
        if (!fields[f].values.includes(vals[f])) { match = false; break; }
      }
    }
    if (match) return t.toISOString();
  }
  return null;
}

function _shouldRunCron(expr, now) {
  const fields = _parseCron(expr);
  if (!fields) return false;
  const vals = [now.getMinutes(), now.getHours(), now.getDate(), now.getMonth() + 1, now.getDay()];
  for (let f = 0; f < 5; f++) {
    if (!fields[f]) continue;
    if (fields[f].step) {
      if ((vals[f] - fields[f].min) % fields[f].step !== 0) return false;
    } else if (fields[f].values) {
      if (!fields[f].values.includes(vals[f])) return false;
    }
  }
  return true;
}

// ── Job dispatcher ────────────────────────────────────────────────────────────

let _dispatchCallback = null;

/**
 * Set the dispatch callback — called when a scheduled job fires.
 * The callback receives (task, backend) and should execute the agent.
 */
function onDispatch(cb) {
  _dispatchCallback = cb;
}

function _dispatchJob(job) {
  const backend = route(job.task);
  job.lastRun = new Date().toISOString();
  job.runCount = (job.runCount || 0) + 1;

  if (_dispatchCallback) {
    _dispatchCallback(job.task, backend, job);
  } else {
    // Default: log (no side effects)
    console.log(`[smart-router] Job ${job.id} fired → ${backend.name}/${backend.model} — ${(job.task.message||'').slice(0,80)}`);
  }

  // Update next run for recurring jobs
  if (job.recurring && job.cron) {
    job.nextRun = _nextCronRun(job.cron);
  }
}

// ── Tick — called every minute to check scheduled jobs ───────────────────────

function tick() {
  const now = new Date();
  for (const job of _scheduledJobs) {
    if (job.type === 'once') continue; // handled by setTimeout
    if (!job.recurring && job.runCount > 0) continue;
    if (_shouldRunCron(job.cron, now)) {
      // Avoid double-firing within same minute
      if (job.lastRun) {
        const last = new Date(job.lastRun);
        if (last.getTime() > now.getTime() - 60000) continue;
      }
      _dispatchJob(job);
    }
  }
}

// ── Init ─────────────────────────────────────────────────────────────────────

let _initialized = false;
let _auditLeakCount = 0;

async function _autoAudit() {
  const leaks = await auditTokenBurn();
  if (leaks.length > 0) {
    _auditLeakCount = leaks.length;
    console.log(`[smart-router] ⚠️ TOKEN BURN DETECTED — ${leaks.length} model(s) leaking to cloud:`);
    for (const l of leaks) {
      console.log(`  ❌ ${l.model} → ${l.url}`);
    }
    console.log('[smart-router] Fix: ollama rm "<model>" && ollama create "<model>" -f <modelfile with FROM local-base>');
  } else {
    _auditLeakCount = 0;
  }
}

function init() {
  if (_initialized) return;
  _initialized = true;

  // Health checks every 30s
  checkHealth();
  setInterval(checkHealth, 30000);

  // Load durable jobs
  const stored = loadSchedule();
  for (const job of stored) {
    if (job.recurring) {
      _scheduledJobs.push(job);
    }
  }

  // Cron tick every 60s
  setInterval(tick, 60000);

  // Token burn audit on startup + every 30 min
  _autoAudit();
  setInterval(_autoAudit, 30 * 60 * 1000);

  console.log(`[smart-router] Initialized — ${_scheduledJobs.length} jobs loaded, health monitoring + token burn audit active`);
}

// ── Token burn auditor ─────────────────────────────────────────────────────────

/**
 * Audit all Ollama models for cloud token leaks.
 * Returns array of leaking models (empty = all clean).
 */
async function auditTokenBurn() {
  return new Promise((resolve) => {
    try {
      const out = execSync('ollama list', { encoding: 'utf8', timeout: 10000 });
      const models = out.trim().split('\n').slice(1).map(l => l.split(/\s+/)[0]).filter(Boolean);
      const leaks = [];
      for (const m of models) {
        try {
          const show = execSync(`ollama show "${m}"`, { encoding: 'utf8', timeout: 5000 });
          if (show.includes('Remote URL') || show.includes('ollama.com')) {
            leaks.push({ model: m, url: (show.match(/Remote URL\s+(\S+)/) || [])[1] || 'unknown' });
          }
        } catch (e) { /* skip */ }
      }
      resolve(leaks);
    } catch (e) {
      resolve([]);
    }
  });
}

module.exports = {
  TIERS,
  init,
  route,
  routeChain,
  detectTaskType,
  schedule,
  scheduleOnce,
  cancelJob,
  listJobs,
  onDispatch,
  checkHealth,
  auditTokenBurn,
  getLeakCount: () => _auditLeakCount,
  loadSchedule,
  saveSchedule,
};