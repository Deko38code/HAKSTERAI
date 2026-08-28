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
  // NOTE: Free cloud via Phantom chat endpoint does NOT support tool calling.
  // Only route here for pure chat/text. Tool tasks go to GLM or hackbots.
  T1_FREE_CLOUD: {
    name: 'free-cloud',
    cost: 0,
    url: 'http://localhost:4000/api/ai/chat',
    supportsTools: true,   // Groq/Cerebras/SambaNova all support OpenAI tool calling natively
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
    supportsTools: true,  // hackbots can execute scripts/commands
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
    supportsTools: true,  // GLM supports tool calling via Ollama
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
    supportsTools: true,  // Phantom now passes tools to free cloud providers
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
    supportsTools: true,  // remote Ollama supports tool calling
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
  },
  // T9: SCRAPERAPI — 2 keys, 9,970 credits. Web scraping with proxy rotation.
  // Bypasses Cloudflare, renders JS, rotates IPs. Free tier (5k credits each).
  T9_SCRAPERAPI: {
    name: 'scraperapi',
    cost: 0,  // free credits
    url: 'https://api.scraperapi.com',
    keysFile: '/home/ghost/.scraperapi_keys',
    models: {
      scrape: 'default',
      render: 'render=true',
      premium: 'premium=true',
      render_premium: 'render=true&premium=true',
    }
  }
};

// ── Task type detection ──────────────────────────────────────────────────────

const TASK_KEYWORDS = {
  code: ['function', 'class', 'bug', 'fix', 'refactor', 'endpoint', 'route', 'api', 'server', 'client',
         'javascript', 'python', 'node', 'react', 'express', 'script', 'compile', 'build', 'deploy',
         'file', 'edit', 'write', 'code', 'implement', 'feature', 'merge', 'commit', 'git',
         'npm', 'pip', 'install', 'package', 'module', 'import', 'require', 'config', 'json',
         'directory', 'folder', 'list', 'mkdir', 'cp', 'mv', 'rename', 'chmod'],
  security: ['pentest', 'exploit', 'reverse shell', 'nmap', 'scan', 'vuln', 'bypass', 'payload',
             'xss', 'sqli', 'ssrf', 'rce', 'lfi', 'osint', 'recon', 'brute', 'fuzz', 'waf',
             'cloudflare', 'captcha', 'injection', 'escalation', 'forensic', 'malware',
             'phishing', 'botnet', 'ddos', 'trojan', 'backdoor', 'rootkit', 'keylogger',
             'mitm', 'arp', 'spoofing', 'sniff', 'wireshark', 'metasploit', 'burpsuite',
             'hashcat', 'john', 'hydra', 'nikto', 'dirb', 'gobuster', 'sqlmap', 'ffuf',
             'shellshock', 'log4j', 'cve', '0day', 'zeroday', 'privilege', 'sudoers',
             'crack', 'decrypt', 'encode', 'decode', 'base64', 'hex', 'openssl',
             'ssh', 'rdp', 'ftp', 'smb', 'telnet', 'snmp', 'ldap', 'kerberos'],
  research: ['research', 'analyze', 'compare', 'investigate', 'find', 'search', 'document',
             'explain', 'summarize', 'report', 'study', 'review',
             'lookup', 'query', 'inspect', 'examine', 'assess', 'evaluate'],
  chat: ['hello', 'hey', 'yo', 'what', 'how', 'why', 'when', 'where', 'who', 'tell me',
         'chat', 'talk', 'discuss', 'opinion', 'think', 'thanks', 'hi', 'sup'],
  image: ['image', 'picture', 'photo', 'draw', 'generate image', 'render', 'flux', 'sdxl'],
  power: ['architecture', 'design system', 'refactor large', 'migrate', 'rewrite', 'scale',
          'optimize', 'performance', 'complex', 'multi-step', 'plan',
          'run command', 'execute', 'shell', 'bash', 'terminal', 'cmd', 'command',
          'generate script', 'write script', 'create script', 'automate',
          'system', 'infrastructure', 'deploy', 'orchestrate', 'pipeline',
          'database', 'migration', 'schema', 'backup', 'restore'],
  scrape: ['scrape', 'scraping', 'crawl', 'crawling', 'fetch page', 'fetch url',
           'extract data', 'extract content', 'parse html', 'parse page',
           'web scraping', 'web crawl', 'get page content', 'get html',
           'bypass cloudflare', 'scrape site', 'scrape website',
           'spider', 'harvest', 'ripper', 'extract from url', 'extract from site'],
};

function detectTaskType(message) {
  const lower = (message || '').toLowerCase();
  // Security tasks get priority — never refuse
  for (const kw of TASK_KEYWORDS.security) {
    if (lower.includes(kw)) return 'security';
  }
  // Scrape tasks — ScraperAPI with proxy rotation
  for (const kw of TASK_KEYWORDS.scrape) {
    if (lower.includes(kw)) return 'scrape';
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
  _health.T9_SCRAPERAPI = true;  // always — external API, checks keys file on use
}

// ── Router ─────────────────────────────────────────────────────────────────

// Round-robin counter — rotates through all healthy tiers so nothing sits idle
let _rrCounter = 0;
let _wrCounter = 0;

// ── Shared constants (extracted to kill duplication) ─────────────────────────

const ROUTING_MAP = {
  chat:     ['T1_FREE_CLOUD', 'T4_PHANTOM', 'T2_MINIFORGE', 'T7_LOCAL', 'T3_GLM_CLOUD'],
  code:     ['T1_FREE_CLOUD', 'T4_PHANTOM', 'T2_MINIFORGE', 'T5_PARROT', 'T7_LOCAL', 'T3_GLM_CLOUD'],
  fast:     ['T1_FREE_CLOUD', 'T4_PHANTOM', 'T7_LOCAL', 'T3_GLM_CLOUD'],
  security: ['T2_MINIFORGE', 'T1_FREE_CLOUD', 'T4_PHANTOM', 'T7_LOCAL', 'T3_GLM_CLOUD'],
  power:    ['T1_FREE_CLOUD', 'T4_PHANTOM', 'T2_MINIFORGE', 'T6_KAGGLE', 'T5_PARROT', 'T7_LOCAL', 'T3_GLM_CLOUD'],
  research: ['T1_FREE_CLOUD', 'T4_PHANTOM', 'T2_MINIFORGE', 'T6_KAGGLE', 'T5_PARROT', 'T7_LOCAL', 'T3_GLM_CLOUD'],
  image:    ['T1_FREE_CLOUD', 'T2_MINIFORGE', 'T3_GLM_CLOUD'],
  scrape:   ['T9_SCRAPERAPI', 'T2_MINIFORGE', 'T1_FREE_CLOUD', 'T7_LOCAL', 'T3_GLM_CLOUD'],
};

const TIER_WEIGHTS = {
  T1_FREE_CLOUD: 6,   // 6 slots — free, fast, handles the BULK of traffic
  T2_MINIFORGE:  4,   // 4 slots — hackbots, uncensored, credit rotator
  T3_GLM_CLOUD:  1,   // 1 slot — GLM is LAST RESORT, save tokens
  T4_PHANTOM:    3,   // 3 slots — secondary free cloud
  T5_PARROT:     1,   // 1 slot — remote, slow
  T6_KAGGLE:     2,   // 2 slots — free GPU
  T7_LOCAL:      1,   // 1 slot — slow on 7GB RAM
  T8_CLOUD_ALIAS: 1,  // 1 slot — costs GLM tokens
  T9_SCRAPERAPI: 3,   // 3 slots — 9,970 credits, proxy rotation
};

const TOOL_NEEDS_RE = /read|write|run|execute|file|command|shell|script|edit|fix|install|create|scrape|browse|click|navigate|deploy|build|grep|find|ls|cat|npm|pip|git|node|python|bash/;

function _detectNeedsTools(task) {
  if (task.needsTools === true) return true;
  return TOOL_NEEDS_RE.test((task.message || '').toLowerCase());
}

function _cloudAliasRoute(requestedModel) {
  const cloudModel = TIERS.T8_CLOUD_ALIAS.models[requestedModel];
  return {
    tier: 'T8_CLOUD_ALIAS',
    name: TIERS.T8_CLOUD_ALIAS.name,
    url: TIERS.T8_CLOUD_ALIAS.url,
    model: cloudModel,
    displayModel: requestedModel,
    cost: 1,
    redirected: true,
  };
}

function _fallbackRoute() {
  return {
    tier: 'T8_CLOUD_ALIAS',
    name: TIERS.T8_CLOUD_ALIAS.name,
    url: TIERS.T8_CLOUD_ALIAS.url,
    model: 'hp-1000:latest',
    displayModel: 'hp-1000:latest',
    cost: 1,
  };
}

function _buildHealthyChain(type, needsTools) {
  const chain = ROUTING_MAP[type] || ROUTING_MAP.chat;
  const healthy = [];
  for (const tierKey of chain) {
    if (needsTools && TIERS[tierKey] && TIERS[tierKey].supportsTools === false) continue;
    const backend = _buildBackend(tierKey, type);
    if (backend) healthy.push(backend);
  }
  return healthy;
}

function _buildWeightedList(healthy) {
  const weighted = [];
  for (const b of healthy) {
    const w = TIER_WEIGHTS[b.tier] || 1;
    for (let i = 0; i < w; i++) weighted.push(b);
  }
  return weighted;
}

/**
 * Route a task to the best backend using weighted round-robin.
 *
 * GLM cloud is the default backbone; free tiers intercept first to save tokens.
 * All AI clusters are utilized via weighted round-robin within each task type's chain:
 *
 *   chat, code, fast  → T1 free cloud (Groq/Cerebras) — saves GLM tokens
 *   security, hack    → T2 hackbots (uncensored, no refusals)
 *   power, research   → T3 GLM cloud (HP-1000/GLM-5.1) — needs quality
 *   image             → T1 pollinations
 *
 * @param {Object} task - { type?, message, model?, needsTools? }
 * @returns {Object} { tier, url, model, displayModel, cost }
 */
function route(task = {}) {
  const type = task.type || detectTaskType(task.message || '');
  const requestedModel = task.model || '';
  const needsTools = _detectNeedsTools(task);

  if (requestedModel && TIERS.T8_CLOUD_ALIAS.models[requestedModel]) {
    return _cloudAliasRoute(requestedModel);
  }

  const healthy = _buildHealthyChain(type, needsTools);
  if (healthy.length === 0) return _fallbackRoute();

  const weighted = _buildWeightedList(healthy);
  const idx = _wrCounter % weighted.length;
  _wrCounter++;
  return weighted[idx];
}

/**
 * Unweighted round-robin route — rotates evenly through healthy backends
 * without tier weighting. Exposed for callers that want pure rotation.
 */
function routeWeighted(task = {}) {
  const type = task.type || detectTaskType(task.message || '');
  const requestedModel = task.model || '';
  const needsTools = _detectNeedsTools(task);

  if (requestedModel && TIERS.T8_CLOUD_ALIAS.models[requestedModel]) {
    return _cloudAliasRoute(requestedModel);
  }

  const healthy = _buildHealthyChain(type, needsTools);
  if (healthy.length === 0) return _fallbackRoute();

  const idx = _rrCounter % healthy.length;
  _rrCounter++;
  return healthy[idx];
}

/**
 * Build a backend object for a given tier + task type.
 * Returns null if tier is not healthy.
 */
function _buildBackend(tierKey, type) {
  if (_health[tierKey] === false) return null;

  switch (tierKey) {
    case 'T1_FREE_CLOUD': {
      // Rotate through all free cloud providers so none sit idle
      const providersByType = {
        code: ['groq', 'cerebras', 'sambanova'],
        chat: ['cerebras', 'groq', 'sambanova'],
        power: ['sambanova', 'groq', 'cerebras'],
        security: ['groq', 'sambanova', 'cerebras'],
        research: ['sambanova', 'cerebras', 'groq'],
        fast: ['cerebras', 'groq'],
        image: ['pollinations'],
      };
      const providers = providersByType[type] || providersByType.code;
      const provider = providers[_rrCounter % providers.length];
      return {
        tier: 'T1_FREE_CLOUD', name: TIERS.T1_FREE_CLOUD.name,
        url: TIERS.T1_FREE_CLOUD.url, model: provider,
        displayModel: `free-${provider}`, cost: 0,
      };
    }
    case 'T2_MINIFORGE': {
      const botMap = {
        code: 'RobloxScriptHelper', security: 'ai-unrestricted', chat: 'chatgpt',
        power: 'gemini-experimental-2-5', research: 'gemini-experimental-2-5', image: 'flux-schnell-image-generator',
      };
      const bot = botMap[type] || 'ai-unrestricted';
      return {
        tier: 'T2_MINIFORGE', name: TIERS.T2_MINIFORGE.name,
        url: `http://localhost:5555/api/apps/${bot}/chat`,
        model: bot, displayModel: bot, cost: 0,
      };
    }
    case 'T3_GLM_CLOUD': {
      const modelMap = {
        code: 'hp-1000:latest', power: 'glm-5.1:cloud',
        chat: 'hp-1000:latest', security: 'hp-1000:latest', research: 'glm-5.1:cloud',
      };
      const model = modelMap[type] || 'hp-1000:latest';
      return {
        tier: 'T3_GLM_CLOUD', name: TIERS.T3_GLM_CLOUD.name,
        url: TIERS.T3_GLM_CLOUD.url, model, displayModel: model,
        cost: 1, isDefault: true,
      };
    }
    case 'T4_PHANTOM':
      return {
        tier: 'T4_PHANTOM', name: TIERS.T4_PHANTOM.name,
        url: TIERS.T4_PHANTOM.url, model: 'groq',
        displayModel: 'phantom-groq', cost: 0,
      };
    case 'T5_PARROT':
      return {
        tier: 'T5_PARROT', name: TIERS.T5_PARROT.name,
        url: TIERS.T5_PARROT.url, model: TIERS.T5_PARROT.models.code,
        displayModel: TIERS.T5_PARROT.models.code, cost: 0,
      };
    case 'T6_KAGGLE':
      if (!process.env.KAGGLE_TUNNEL) return null;
      return {
        tier: 'T6_KAGGLE', name: TIERS.T6_KAGGLE.name,
        url: process.env.KAGGLE_TUNNEL.replace(/\/$/, '') + '/api/chat',
        model: TIERS.T6_KAGGLE.models.heavy, displayModel: TIERS.T6_KAGGLE.models.heavy, cost: 0,
      };
    case 'T7_LOCAL': {
      const model = TIERS.T7_LOCAL.models[type] || TIERS.T7_LOCAL.models.chat;
      return {
        tier: 'T7_LOCAL', name: TIERS.T7_LOCAL.name,
        url: TIERS.T7_LOCAL.url, model, displayModel: model, cost: 0,
      };
    }
    case 'T9_SCRAPERAPI': {
      // Read keys from file, rotate through them
      const keysFile = TIERS.T9_SCRAPERAPI.keysFile;
      let keys = [];
      try {
        keys = fs.readFileSync(keysFile, 'utf8').trim().split('\n').filter(Boolean);
      } catch (e) { /* keys file missing */ }
      if (keys.length === 0) return null;
      const key = keys[_rrCounter % keys.length];
      const modeMap = {
        scrape: '', render: '&render=true', premium: '&premium=true',
        render_premium: '&render=true&premium=true',
        security: '&render=true', power: '&render=true', research: '',
        code: '', chat: '', image: '', fast: '',
      };
      const mode = modeMap[type] || '';
      return {
        tier: 'T9_SCRAPERAPI', name: TIERS.T9_SCRAPERAPI.name,
        url: TIERS.T9_SCRAPERAPI.url,
        model: 'scraperapi',
        displayModel: `scraperapi-${key.slice(0, 8)}...`,
        cost: 0,
        apiKey: key,
        params: mode,
      };
    }
    default:
      return null;
  }
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
  routeWeighted,
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