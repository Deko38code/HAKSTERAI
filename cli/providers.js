'use strict';

// ──────────────────────────────────────────────────────────────────────────
// haksterAi CLI — multi-provider fallback module
// Ported from phantom-cli.js (and provider endpoint map from phantom-server.js)
// Rebranded: phantom → hakster, .phantom-ai-config.json → .hakster-ai-config.json
//
// Exports:
//   getBestProvider(config?)      → { name, url, apiKey, model, type } | null
//   loadAIConfig()                → config object (merged from all paths)
//   collectProviderInventory()    → array of { name, status, reason, cost }
//   ensureProviderAvailable(opts) → provider or null
//   PROVIDER_ORDER                → array (priority waterfall)
//   LOCAL_PROVIDERS_ORDER         → array (local-first waterfall)
//   CLOUD_PROVIDERS               → array (cloud-only providers)
//   listFallbacks()               → formatted string
// ──────────────────────────────────────────────────────────────────────────

const fs   = require('fs');
const path = require('path');
const http  = require('http');
const https = require('https');

// ── Constants ──────────────────────────────────────────────────────────────
const HOME       = process.env.HOME || '/home/ghost';
const CLI_ROOT   = path.dirname(fs.realpathSync(__filename));
const LOG_DIR    = path.join(HOME, 'logs');
const OLLAMA_LOG = path.join(LOG_DIR, 'ollama-out.log');
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';

// USB paths used for portable config discovery (carried over from phantom)
const USB_PATHS = [
  '/media/ghost/BOOT', '/media/ghost/USB STICK', '/media/ghost/USB STICK1',
  '/media/ghost/BOOT1', '/media/ghost/USB2', '/media/ghost/HAKSTER',
];

// ANSI colors (mirrors phantom-cli.js C object — subset used here)
const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  purple: '\x1b[35m', lpurp: '\x1b[95m', green: '\x1b[32m',
  lgreen: '\x1b[92m', yellow: '\x1b[33m', red: '\x1b[31m',
  cyan: '\x1b[36m', white: '\x1b[97m', gray: '\x1b[90m',
  blue: '\x1b[34m', lblue: '\x1b[94m',
};

// ── Provider waterfall arrays ──────────────────────────────────────────────
// Cloud-first priority: speed-first free providers first, then smart cloud.
// Mirrors getBestProvider() priority list from phantom-cli.js L762-764.
const PROVIDER_ORDER = [
  'ollama', 'sambanova', 'groq', 'cerebras', 'gemini-flash', 'gemini',
  'openrouter', 'pollinations', 'minimax', 'together', 'hyperbolic',
  'novita', 'deepinfra', 'glhf', 'featherless', 'aimlapi',
  'anthropic', 'openai', 'lmstudio', 'jan', 'copilot', 'deepseek',
  'mistral', 'fireworks', 'huggingface',
];

// Local-first priority: local servers first, then cloud fallback.
const LOCAL_PROVIDERS_ORDER = [
  'ollama', 'lmstudio', 'jan', 'sambanova', 'groq', 'cerebras',
  'gemini-flash', 'openrouter', 'pollinations', 'minimax', 'together',
  'hyperbolic', 'novita', 'deepinfra', 'glhf', 'featherless', 'aimlapi',
  'gemini', 'anthropic', 'openai', 'copilot', 'deepseek', 'mistral',
  'fireworks', 'huggingface',
];

// Cloud-only providers (no local server)
const CLOUD_PROVIDERS = [
  'sambanova', 'groq', 'cerebras', 'gemini-flash', 'gemini', 'openrouter',
  'pollinations', 'minimax', 'together', 'hyperbolic', 'novita', 'deepinfra',
  'glhf', 'featherless', 'aimlapi', 'anthropic', 'openai', 'copilot',
  'deepseek', 'mistral', 'fireworks', 'huggingface',
];

// ── Provider endpoint URL map ──────────────────────────────────────────────
// Sourced from phantom-server.js ENDPOINTS table (L3918-3947) so that
// getBestProvider can return a ready-to-use url alongside the key/model.
const PROVIDER_ENDPOINTS = {
  openai:        'https://api.openai.com/v1/chat/completions',
  groq:          'https://api.groq.com/openai/v1/chat/completions',
  together:      'https://api.together.xyz/v1/chat/completions',
  mistral:       'https://api.mistral.ai/v1/chat/completions',
  perplexity:    'https://api.perplexity.ai/chat/completions',
  fireworks:     'https://api.fireworks.ai/inference/v1/chat/completions',
  deepseek:      'https://api.deepseek.com/v1/chat/completions',
  openrouter:    'https://openrouter.ai/api/v1/chat/completions',
  huggingface:   'https://api-inference.huggingface.co/v1/chat/completions',
  siliconflow:   'https://api.siliconflow.cn/v1/chat/completions',
  'deepseek-r1': 'https://api.siliconflow.cn/v1/chat/completions',
  minimax:       'https://api.minimaxi.chat/v1/text/chatcompletion_v2',
  ollama:        `${OLLAMA_URL.replace(/\/$/, '')}/v1/chat/completions`,
  pollinations:  'https://text.pollinations.ai/openai',
  cerebras:      'https://api.cerebras.ai/v1/chat/completions',
  sambanova:     'https://api.sambanova.ai/v1/chat/completions',
  'gemini-flash':'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent',
  gemini:        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
  anthropic:     'https://api.anthropic.com/v1/messages',
  cohere:        'https://api.cohere.ai/v1/chat',
  lmstudio:      'http://localhost:1234/v1/chat/completions',
  jan:           'http://localhost:1337/v1/chat/completions',
  copilot:       'https://api.githubcopilot.com/chat/completions',
  hyperbolic:    'https://api.hyperbolic.xyz/v1/chat/completions',
  novita:        'https://api.novita.ai/v3/openai/chat/completions',
  deepinfra:     'https://api.deepinfra.com/v1/openai/chat/completions',
  glhf:          'https://glhf.chat/api/openai/v1/chat/completions',
  featherless:   'https://api.featherless.ai/v1/chat/completions',
  aimlapi:       'https://api.aimlapi.com/v1/chat/completions',
};

// Providers that need no API key (local servers or keyless free tier)
const NO_KEY_PROVIDERS = new Set(['ollama', 'pollinations', 'lmstudio', 'jan']);
const DEFAULT_OLLAMA_MODEL = process.env.OLLAMA_MODEL || process.env.DEFAULT_MODEL || 'glm-5.2:cloud';

// Providers whose keys must match a known prefix
const INVALID_KEY_PATTERNS = {
  openai: k => !k.startsWith('sk-'),
  groq:   k => !k.startsWith('gsk_'),
};

// Slow models to never use as primary (too heavy for interactive CLI)
const SLOW_MODELS = ['deepseek-coder-v2', 'deepseek-r1', 'deepseek-coder', 'deepseek'];

// Provider type classification — 'local', 'openai-compat', 'anthropic', 'gemini', 'cohere'
const PROVIDER_TYPE = {
  ollama:        'local',
  lmstudio:      'local',
  jan:           'local',
  openai:        'openai-compat',
  groq:          'openai-compat',
  together:      'openai-compat',
  mistral:       'openai-compat',
  fireworks:     'openai-compat',
  deepseek:      'openai-compat',
  openrouter:    'openai-compat',
  huggingface:   'openai-compat',
  siliconflow:   'openai-compat',
  'deepseek-r1': 'openai-compat',
  minimax:       'openai-compat',
  pollinations:  'openai-compat',
  cerebras:      'openai-compat',
  sambanova:     'openai-compat',
  copilot:       'openai-compat',
  hyperbolic:    'openai-compat',
  novita:        'openai-compat',
  deepinfra:     'openai-compat',
  glhf:          'openai-compat',
  featherless:   'openai-compat',
  aimlapi:       'openai-compat',
  anthropic:     'anthropic',
  gemini:        'gemini',
  'gemini-flash':'gemini',
  cohere:        'cohere',
};

// ── Config merge helper (from phantom-cli.js L162) ─────────────────────────
function mergeConfigObjects(base, extra) {
  const out = { ...(base || {}) };
  for (const [key, value] of Object.entries(extra || {})) {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      out[key] &&
      typeof out[key] === 'object' &&
      !Array.isArray(out[key])
    ) {
      out[key] = { ...out[key], ...value };
    } else {
      out[key] = value;
    }
  }
  return out;
}

// ── Config path discovery (from phantom-cli.js L181, rebranded) ────────────
function getAIConfigPaths() {
  const candidates = [
    path.join(HOME, '.hakster-ai-config.json'),
    path.join(CLI_ROOT, '.hakster-ai-config.json'),
    // Legacy fallback — pick up old phantom configs during migration
    path.join(HOME, '.phantom-ai-config.json'),
    path.join(CLI_ROOT, '.phantom-ai-config.json'),
    ...USB_PATHS.flatMap(usb => [
      path.join(usb, '.hakster-ai-config.json'),
      path.join(usb, 'hakster-ai-config.json'),
      path.join(usb, '.phantom-ai-config.json'),
      path.join(usb, 'phantom-ai-config.json'),
    ]),
  ];
  return candidates.filter((p, idx, arr) => arr.indexOf(p) === idx && fs.existsSync(p));
}

// ── Load merged AI config (from phantom-cli.js L193) ───────────────────────
function loadAIConfig() {
  let merged = {
    runtime: { localFirst: true },
    ollama: {
      key: 'free',
      model: DEFAULT_OLLAMA_MODEL,
      endpoint: `${OLLAMA_URL.replace(/\/$/, '')}/v1/chat/completions`,
    },
  };
  for (const cfgPath of getAIConfigPaths()) {
    try {
      merged = mergeConfigObjects(merged, JSON.parse(fs.readFileSync(cfgPath, 'utf8')));
    } catch {}
  }
  return merged;
}

// ── Mask secrets for display (from phantom-cli.js L203) ───────────────────
function maskSecret(value) {
  const s = String(value || '');
  if (!s) return '';
  if (s.length <= 10) return '*'.repeat(s.length);
  return `${s.slice(0, 4)}...${s.slice(-4)}`;
}

// ── Collect provider inventory (from phantom-cli.js L210) ─────────────────
// Returns array of { name, status, reason, cost } for each configured provider.
function collectProviderInventory() {
  const cfg = loadAIConfig();
  const inventory = [];

  // Cost/reason metadata for known providers
  const META = {
    sambanova:    { cost: 'Free (rate-limited)', reason: 'Fast inference (<1s)' },
    groq:         { cost: 'Free (rate-limited)', reason: 'Fast inference (<1s)' },
    cerebras:     { cost: 'Free (rate-limited)', reason: 'Fast inference (<1s)' },
    'gemini-flash': { cost: 'Free', reason: 'Fast Gemini Flash tier' },
    gemini:       { cost: 'Free', reason: 'Google Gemini' },
    openrouter:   { cost: 'Freemium', reason: 'Multi-model router' },
    ollama:       { cost: 'Free (local)', reason: 'Local models (offline)' },
    lmstudio:     { cost: 'Free (local)', reason: 'Local LM Studio server' },
    jan:          { cost: 'Free (local)', reason: 'Local Jan server' },
    minimax:      { cost: 'Free (100 q/day)', reason: 'Rate-limited free tier' },
    together:     { cost: '$0.02/query', reason: 'Cloud provider (paid)' },
    hyperbolic:   { cost: 'Freemium', reason: 'Open-model inference' },
    novita:       { cost: 'Freemium', reason: 'Open-model inference' },
    deepinfra:    { cost: 'Freemium', reason: 'Open-model inference' },
    glhf:         { cost: 'Free', reason: 'Free open-model tier' },
    featherless:  { cost: 'Freemium', reason: 'Open-model hosting' },
    aimlapi:      { cost: 'Freemium', reason: 'Multi-model API' },
    anthropic:    { cost: 'Paid', reason: 'Claude models' },
    openai:       { cost: 'Paid', reason: 'GPT models' },
    copilot:      { cost: 'Free (GitHub)', reason: 'Copilot chat endpoint' },
    deepseek:     { cost: 'Freemium', reason: 'DeepSeek models' },
    mistral:      { cost: 'Freemium', reason: 'Mistral models' },
    fireworks:    { cost: 'Paid', reason: 'Fireworks inference' },
    huggingface:  { cost: 'Freemium', reason: 'HF inference API' },
    pollinations: { cost: 'Free (no key)', reason: 'Keyless free tier' },
  };

  // Walk every provider in the merged order; include configured ones
  const seen = new Set();
  for (const name of [...PROVIDER_ORDER, ...Object.keys(cfg)]) {
    if (seen.has(name)) continue;
    seen.add(name);
    const entry = cfg[name];
    const meta = META[name] || { cost: 'Unknown', reason: 'Custom provider' };
    if (entry && typeof entry === 'object') {
      const key = typeof entry.key === 'string' ? entry.key : '';
      const hasKey = !!key || NO_KEY_PROVIDERS.has(name);
      const invalid = INVALID_KEY_PATTERNS[name] && key && INVALID_KEY_PATTERNS[name](key);
      let status, reason;
      if (!hasKey) { status = '✗'; reason = 'No API key configured'; }
      else if (invalid) { status = '✗'; reason = `Invalid key format (expected ${name} prefix)`; }
      else { status = '✓'; reason = meta.reason; }
      inventory.push({ name, status, reason, cost: meta.cost, model: entry.model || '' });
    } else if (NO_KEY_PROVIDERS.has(name)) {
      // Keyless providers are always "available" even without config entry
      inventory.push({ name, status: '✓', reason: meta.reason, cost: meta.cost, model: '' });
    }
  }

  return inventory;
}

// ── Failed-provider tracker (from phantom-cli.js L749) ────────────────────
const _failedProviders = new Set();

// Public hooks to manage the failed set from outside the module
function markProviderFailed(name)   { _failedProviders.add(name); }
function unmarkProviderFailed(name) { _failedProviders.delete(name); }
function clearFailedProviders()     { _failedProviders.clear(); }

// ── Build a full provider descriptor from a name + config entry ───────────
// Returns { name, url, apiKey, model, type } or null if unusable.
function buildProviderDescriptor(name, cfg) {
  const entry = cfg[name];
  if (!entry || typeof entry !== 'object') {
    if (!NO_KEY_PROVIDERS.has(name)) return null;
  }
  const apiKey = (entry && typeof entry.key === 'string') ? entry.key : (NO_KEY_PROVIDERS.has(name) ? 'free' : '');
  const model  = (entry && entry.model) ? entry.model : '';
  // Allow per-provider endpoint override from config
  const cfgEndpoint = entry && entry.endpoint;
  const url = cfgEndpoint || PROVIDER_ENDPOINTS[name] || PROVIDER_ENDPOINTS.openai;
  const type = PROVIDER_TYPE[name] || 'openai-compat';
  return { name, url, apiKey, model, type };
}

// ── getBestProvider (from phantom-cli.js L752) ────────────────────────────
// Returns { name, url, apiKey, model, type } for the best available provider.
// Pass an optional config object (from loadAIConfig) to avoid re-reading disk.
function getBestProvider(config) {
  try {
    const cfg = config || loadAIConfig();
    const localFirst = cfg.runtime?.localFirst === true;
    const priority = localFirst ? LOCAL_PROVIDERS_ORDER : PROVIDER_ORDER;

    // First pass — skip slow models and failed providers
    for (const p of priority) {
      if (!cfg[p]?.key && !NO_KEY_PROVIDERS.has(p)) continue;
      if (_failedProviders.has(p)) continue;
      const k = cfg[p]?.key || 'free';
      if (!NO_KEY_PROVIDERS.has(p) && INVALID_KEY_PATTERNS[p] && INVALID_KEY_PATTERNS[p](k)) continue;
      const m = cfg[p]?.model || '';
      if (SLOW_MODELS.some(s => m.includes(s))) continue;
      return buildProviderDescriptor(p, cfg);
    }

    // Second pass — allow slow models but still skip failed providers
    for (const p of priority) {
      if ((cfg[p]?.key || NO_KEY_PROVIDERS.has(p)) && !_failedProviders.has(p)) {
        return buildProviderDescriptor(p, cfg);
      }
    }

    // Last resort — try anything with a key
    for (const p of priority) {
      if (cfg[p]?.key) return buildProviderDescriptor(p, cfg);
    }
  } catch {}
  return null;
}

// ── HTTP GET helper (from phantom-cli.js L682) ────────────────────────────
function get(url) {
  return new Promise((resolve) => {
    const req = (url.startsWith('https') ? https : http).get(url, { timeout: 10000 }, res => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve({}); } });
    });
    req.on('error', () => resolve({}));
    req.on('timeout', () => { req.destroy(); resolve({}); });
  });
}

// ── isOllamaOnline (from phantom-cli.js L1500) ────────────────────────────
async function isOllamaOnline() {
  try {
    const r = await get(`${OLLAMA_URL}/api/tags`);
    return Array.isArray(r.models);
  } catch {
    return false;
  }
}

// ── ensureOllamaAvailable (from phantom-cli.js L1509) ─────────────────────
let _ollamaLastStartAt = 0;
let _ollamaStartInFlight = null;

async function ensureOllamaAvailable(options = {}) {
  const {
    autoStart = true,
    startupWaitMs = 1500,
    retries = 4,
    retryWaitMs = 1200,
  } = options;

  let alive = await isOllamaOnline();
  if (alive || !autoStart) return alive;
  if (_ollamaStartInFlight) return _ollamaStartInFlight;

  _ollamaStartInFlight = (async () => {
    const now = Date.now();
    if (now - _ollamaLastStartAt < 20000) {
      for (let i = 0; i < retries; i++) {
        await new Promise(r => setTimeout(r, retryWaitMs));
        if (await isOllamaOnline()) return true;
      }
      return false;
    }

    _ollamaLastStartAt = now;
    try {
      const { spawn, execSync } = require('child_process');
      let alreadyRunning = false;
      try {
        alreadyRunning = execSync('pgrep -f "ollama serve" 2>/dev/null', { encoding: 'utf8' }).trim().length > 0;
      } catch {}
      if (!alreadyRunning) {
        try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}
        const child = spawn('bash', ['-lc', `nohup ollama serve >> ${JSON.stringify(OLLAMA_LOG)} 2>&1 &`], {
          detached: true,
          stdio: 'ignore',
        });
        child.unref();
      }
      await new Promise(r => setTimeout(r, startupWaitMs));
      for (let i = 0; i < retries; i++) {
        alive = await isOllamaOnline();
        if (alive) return true;
        await new Promise(r => setTimeout(r, retryWaitMs));
      }
    } catch {}
    return false;
  })();

  try {
    return await _ollamaStartInFlight;
  } finally {
    _ollamaStartInFlight = null;
  }
}

// ── Server availability (from phantom-cli.js L699) ────────────────────────
// Used by callers that still proxy through a hakster/phantom server.
const SERVER = process.env.HAKSTER_SERVER || 'http://localhost:4000';

async function checkServer() {
  try { const r = await get(`${SERVER}/api/ping`); return r.ok === true; } catch { return false; }
}

async function ensureServerAvailable(options = {}) {
  const {
    autoStart = true,
    initialRetries = 3,
    initialWaitMs = 2000,
    startupWaitMs = 3000,
    startupRetries = 3,
    startupRetryWaitMs = 2000,
  } = options;

  let alive = await checkServer();
  for (let i = 0; i < initialRetries && !alive; i++) {
    await new Promise(r => setTimeout(r, initialWaitMs));
    alive = await checkServer();
  }
  if (alive || !autoStart) return alive;

  try {
    const { spawn, execSync } = require('child_process');
    let alreadyRunning = false;
    try {
      alreadyRunning = execSync('pgrep -f "[h]akster-server.js\\|[p]hantom-server.js" 2>/dev/null').toString().trim().length > 0;
    } catch {}
    if (!alreadyRunning) {
      const ecosystemFile = path.join(CLI_ROOT, 'ecosystem.config.js');
      const serverFile = path.join(CLI_ROOT, 'hakster-server.js');
      const logDir = path.join(CLI_ROOT, 'logs');
      try { fs.mkdirSync(logDir, { recursive: true }); } catch {}
      const child = spawn('bash', ['-c',
        `PORT=4000 pm2 restart hakster-server --update-env 2>/dev/null || PORT=4000 pm2 start ${JSON.stringify(ecosystemFile)} --only hakster-server 2>/dev/null || PORT=4000 nohup node ${JSON.stringify(serverFile)} >> ${JSON.stringify(path.join(logDir, 'hakster-out.log'))} 2>&1 &`
      ], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, PORT: '4000', NODE_ENV: 'production' }
      });
      child.unref();
    }

    await new Promise(r => setTimeout(r, startupWaitMs));
    alive = await checkServer();
    for (let i = 0; i < startupRetries && !alive; i++) {
      await new Promise(r => setTimeout(r, startupRetryWaitMs));
      alive = await checkServer();
    }
  } catch {}

  return alive;
}

// ── ensureProviderAvailable ───────────────────────────────────────────────
// Unified entry point: given options { name?, config?, localFirst?, autoStart? }
// returns a provider descriptor { name, url, apiKey, model, type } or null.
//
// - If options.name is provided, verify that specific provider is usable
//   (for local providers, starts the server if autoStart is true).
// - Otherwise, falls back to getBestProvider() waterfall.
async function ensureProviderAvailable(options = {}) {
  const {
    name = null,
    config = null,
    autoStart = true,
  } = options;

  const cfg = config || loadAIConfig();

  // Specific provider requested
  if (name) {
    if (name === 'ollama') {
      const ready = await ensureOllamaAvailable({ autoStart });
      if (!ready) return null;
    } else if (name === 'lmstudio' || name === 'jan') {
      // Local servers — no auto-start logic ported; just check endpoint
      const desc = buildProviderDescriptor(name, cfg);
      if (!desc) return null;
      try {
        const r = await get(desc.url.replace(/\/v1\/chat\/completions$/, '/v1/models'));
        if (!r || r.error) return null;
      } catch { return null; }
    }
    if (_failedProviders.has(name)) return null;
    const desc = buildProviderDescriptor(name, cfg);
    if (!desc) return null;
    if (!NO_KEY_PROVIDERS.has(name) && !desc.apiKey) return null;
    if (INVALID_KEY_PATTERNS[name] && desc.apiKey && INVALID_KEY_PATTERNS[name](desc.apiKey)) return null;
    return desc;
  }

  // Waterfall — try best provider; if it's ollama, ensure it's up first
  const best = getBestProvider(cfg);
  if (!best) return null;
  if (best.name === 'ollama') {
    const ready = await ensureOllamaAvailable({ autoStart });
    if (!ready) {
      markProviderFailed('ollama');
      // Retry waterfall without ollama
      return ensureProviderAvailable({ config: cfg, autoStart: false });
    }
  }
  return best;
}

// ── listFallbacks (from phantom-cli.js L522, rebranded) ───────────────────
// Returns a formatted string showing provider status (does not console.log).
function listFallbacks() {
  const inventory = collectProviderInventory();
  const lines = [];
  lines.push('');
  lines.push(`  ${C.bold}${C.lpurp}FALLBACK PROVIDERS${C.reset}`);
  lines.push('');
  for (const p of inventory) {
    const statusColor = p.status === '✓' ? C.lgreen : p.status === '⚠' ? C.yellow : C.red;
    const modelStr = p.model ? ` (${p.model})` : '';
    lines.push(
      `    ${statusColor}${p.status}${C.reset} ${p.name.padEnd(14)} ${C.gray}${p.reason.padEnd(32)}${C.reset} ${C.dim}${p.cost}${C.reset}${modelStr}`
    );
  }
  lines.push('');
  lines.push(`  ${C.gray}Config: ~/.hakster-ai-config.json${C.reset}`);
  lines.push('');
  return lines.join('\n');
}

// ── Exports ───────────────────────────────────────────────────────────────
module.exports = {
  // Core waterfall
  getBestProvider,
  loadAIConfig,
  collectProviderInventory,
  ensureProviderAvailable,

  // Provider arrays
  PROVIDER_ORDER,
  LOCAL_PROVIDERS_ORDER,
  CLOUD_PROVIDERS,
  PROVIDER_ENDPOINTS,
  PROVIDER_TYPE,
  NO_KEY_PROVIDERS,

  // Local server management
  isOllamaOnline,
  ensureOllamaAvailable,
  ensureServerAvailable,
  checkServer,

  // Failed-provider tracking
  markProviderFailed,
  unmarkProviderFailed,
  clearFailedProviders,

  // Display
  listFallbacks,
  maskSecret,

  // Config helpers (exposed for advanced callers)
  getAIConfigPaths,
  mergeConfigObjects,
  buildProviderDescriptor,

  // Constants
  HOME,
  CLI_ROOT,
  OLLAMA_URL,
  SERVER,
  USB_PATHS,
  C,
};
