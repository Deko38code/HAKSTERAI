'use strict';
/**
 * haksterAi — Multi-provider AI router
 * Supports: Ollama, Anthropic Claude, OpenAI/Codex, Hermes, OpenRouter
 * Features: extended thinking (all providers), image generation, image analysis
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env'), override: true });

// Approval mode — bypass confirmation prompts in FULL_AUTO / AUTO_EDIT
const { FULL_AUTO, shouldConfirm: shouldConfirmApproval } = require('./agent/approval');

// MCP integration — lazy-loaded to avoid circular require
let _isMcpTool, _callMcpTool;
function getMcp() {
  if (!_isMcpTool) {
    const mcp = require('./agent/mcp');
    _isMcpTool = mcp.isMcpTool;
    _callMcpTool = mcp.callMcpTool;
  }
}
function isMcpTool(name) { getMcp(); return _isMcpTool(name); }
function callMcpTool(name, args) { getMcp(); return _callMcpTool(name, args); }

const Anthropic = require('@anthropic-ai/sdk');
const { OpenAI } = require('openai');
const fs = require('fs');
const path = require('path');

// ── Sanitize messages before sending to any provider ────────────────
// Some providers (OpenRouter, OpenAI) reject messages with `reasoning_content`
// or other unsupported fields that get added by models like GLM-5.1
function sanitizeMessagesForProvider(msgs, provider) {
  if (!Array.isArray(msgs)) return msgs;
  // Whitelist approach: only keep fields the downstream API expects.
  // DB-loaded messages carry extra columns (id, session_id, created_at,
  // input_tokens, etc.) and model responses can carry reasoning_content —
  // both cause 400 errors from OpenRouter/OpenAI. Only keep role + content
  // + tool_calls + tool_call_id (for tool-result messages).
  return msgs.map(m => {
    const clean = { role: m.role };
    if (m.content !== undefined) clean.content = m.content;
    if (m.tool_calls) {
      clean.tool_calls = m.tool_calls.map(tc => ({
        id: tc.id,
        type: tc.type || 'function',
        function: {
          name: tc.function?.name,
          arguments: tc.function?.arguments,
        },
      }));
    }
    if (m.tool_call_id) clean.tool_call_id = m.tool_call_id;
    if (m.name) clean.name = m.name;
    // Also strip reasoning_content from nested content arrays (Anthropic format)
    if (Array.isArray(clean.content)) {
      clean.content = clean.content.map(block => {
        if (typeof block === 'object' && block !== null) {
          const stripped = { ...block };
          delete stripped.reasoning_content;
          delete stripped.thinking;
          delete stripped.reasoning;
          return stripped;
        }
        return block;
      });
    }
    return clean;
  });
}

// ── Provider configs ────────────────────────────────────────────────
const PROVIDERS = {
  ollama: {
    name: 'Ollama',
    baseURL: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
    defaultModel: process.env.DEFAULT_MODEL || 'glm-uncensored:latest',
    type: 'openai-compat',
  },
  // Second ollama instance for gpt-oss:120b-cloud — same backend, different model,
  // so the waterfall can rotate between hp-1000 (local custom) and gpt-oss (cloud) without conflict.
  'gpt-oss': {
    name: 'GPT-OSS 120B Cloud',
    baseURL: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
    defaultModel: 'gpt-oss:120b-cloud',
    type: 'openai-compat',
    apiKey: 'ollama',
  },
  anthropic: {
    name: 'Anthropic Claude',
    defaultModel: 'claude-sonnet-4-5',
    type: 'anthropic',
  },
  openai: {
    name: 'OpenAI / Codex',
    defaultModel: 'gpt-4o',
    type: 'openai',
  },
  openrouter: {
    name: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
    defaultModel: 'thudm/glm-5.1:cloud-ctx',
    type: 'openrouter',
  },
  hermes: {
    name: 'Hermes (Ollama)',
    baseURL: process.env.HERMES_BASE_URL || 'http://localhost:11434',
    defaultModel: process.env.HERMES_MODEL || 'nous-hermes-2-mistral-7b-dpo',
    type: 'openai-compat',
  },
  'hermes-api': {
    name: 'Hermes API',
    baseURL: process.env.HERMES_API_BASE_URL || 'https://api.nousresearch.com/hermes/v1',
    defaultModel: process.env.HERMES_API_MODEL || 'nous-hermes-2-mixtral-8x7b-dpo',
    apiKeyEnv: 'HERMES_API_KEY',
    type: 'hermes-api',
  },
  'butch': {
    name: 'Butch (Hermes)',
    baseURL: process.env.BUTCH_BASE_URL || 'https://api.nousresearch.com/hermes/v1',
    defaultModel: process.env.BUTCH_MODEL || 'nous-hermes-2-mixtral-8x7b-dpo',
    type: 'butch',
  },
  'claude-proxy': {
    name: 'Claude Proxy',
    baseURL: process.env.CLAUDE_PROXY_URL || 'http://localhost:8082',
    defaultModel: 'claude-sonnet-4-5',
    type: 'claude-proxy',
  },
  codex: {
    name: 'Codex (Nous Research)',
    baseURL: process.env.CODEX_BASE_URL || 'https://inference-api.nousresearch.com/v1',
    defaultModel: 'openai/gpt-5.5',
    apiKey: process.env.CODEX_API_KEY || process.env.NOUS_API_KEY || '',
    apiKeyEnv: 'CODEX_API_KEY',
    type: 'codex',
  },
  nous: {
    name: 'Nous / Hermes',
    baseURL: process.env.NOUS_BASE_URL || 'https://inference-api.nousresearch.com/v1',
    defaultModel: process.env.NOUS_MODEL || 'nousresearch/hermes-4-70b',
    apiKey: process.env.NOUS_API_KEY || process.env.CODEX_API_KEY || '',
    apiKeyEnv: 'NOUS_API_KEY',
    type: 'nous',
  },
  'claude-cli': {
    name: 'Claude (Pro/Max CLI)',
    // Shells out to the locally-authenticated `claude` CLI instead of the
    // metered Anthropic API — rides the user's existing Pro/Max subscription
    // for zero extra token cost. Fallback for when ollama is rate-limited.
    defaultModel: process.env.CLAUDE_CLI_MODEL || 'sonnet',
    type: 'claude-cli',
  },
  // haksterAi Hack Bot — routes through claude-proxy (port 8082) for free cloud models.
  // Payment-bypassed cloud tier: glm-5.2:cloud, kimi-k2.7-code:cloud via Ollama relay.
  'hackbot': {
    name: 'HackBot Cloud',
    baseURL: process.env.HACKBOT_BASE_URL || 'http://localhost:8082',
    defaultModel: process.env.HACKBOT_MODEL || 'glm-5.2:cloud',
    apiKey: process.env.HACKBOT_API_KEY || 'hk-universal-2026',
    type: 'openai-compat',
  },
};

// ── Phantom-key waterfall (merge phantom's free cloud keys into our providers) ──
// Reads /home/ghost/.phantom-ai-config.json once (cached) and exposes groq / sambanova /
// cerebras / gemini / openrouter / pollinations / puter-* with the phantom keys so the
// server can rotate across them to stretch tokens.
let _phantomKeysCache = null; let _phantomKeysMtime = 0;
function loadPhantomKeys() {
  try {
    const pth = '/home/ghost/.phantom-ai-config.json';
    const st = fs.statSync(pth);
    if (_phantomKeysCache && st.mtimeMs === _phantomKeysMtime) return _phantomKeysCache;
    _phantomKeysCache = JSON.parse(fs.readFileSync(pth, 'utf8'));
    _phantomKeysMtime = st.mtimeMs;
    return _phantomKeysCache;
  } catch (_) { _phantomKeysCache = {}; return _phantomKeysCache; }
}
function _pk(name, fld) { const e = loadPhantomKeys()[name]; return e && typeof e.key === 'string' ? e.key : ''; }
function _pmodel(name, fallback) { const e = loadPhantomKeys()[name]; return (e && e.model) || fallback; }

// Add the phantom cloud providers into PROVIDERS (merge, don't overwrite existing).
Object.assign(PROVIDERS, {
  groq:        { name: 'Groq',        baseURL: 'https://api.groq.com/openai/v1',                 defaultModel: _pmodel('groq', 'llama-3.3-70b-versatile'), apiKey: _pk('groq')        || process.env.GROQ_API_KEY,        apiKeyEnv: 'GROQ_API_KEY',        type: 'openai-compat' },
  groq2:       { name: 'Groq 2',      baseURL: 'https://api.groq.com/openai/v1',                 defaultModel: _pmodel('groq2','llama-3.1-8b-instant'),   apiKey: _pk('groq2')       || process.env.GROQ_API_KEY2,      apiKeyEnv: 'GROQ_API_KEY2',       type: 'openai-compat' },
  sambanova:   { name: 'SambaNova',   baseURL: 'https://api.sambanova.ai/v1',                    defaultModel: _pmodel('sambanova','Meta-Llama-3.3-70B-Instruct'), apiKey: _pk('sambanova') || process.env.SAMBANOVA_API_KEY,   apiKeyEnv: 'SAMBANOVA_API_KEY',   type: 'openai-compat' },
  cerebras:    { name: 'Cerebras',    baseURL: 'https://api.cerebras.ai/v1',                      defaultModel: _pmodel('cerebras','llama3.1-8b'),          apiKey: _pk('cerebras')    || process.env.CEREBRAS_API_KEY,    apiKeyEnv: 'CEREBRAS_API_KEY',    type: 'openai-compat' },
  gemini:      { name: 'Google Gemini', baseURL: 'https://generativelanguage.googleapis.com/v1beta', defaultModel: _pmodel('gemini','gemini-2.5-flash'), apiKey: _pk('gemini') || process.env.GEMINI_API_KEY,  apiKeyEnv: 'GEMINI_API_KEY',  type: 'gemini' },
  'gemini-flash': { name: 'Gemini Flash', baseURL: 'https://generativelanguage.googleapis.com/v1beta', defaultModel: 'gemini-2.0-flash-lite', apiKey: _pk('gemini') || process.env.GEMINI_API_KEY, apiKeyEnv: 'GEMINI_API_KEY', type: 'gemini' },
  pollinations:{ name: 'Pollinations', baseURL: 'https://text.pollinations.ai/openai',             defaultModel: 'openai',                                    apiKey: _pk('pollinations')|| 'free',                          apiKeyEnv: 'POLLINATIONS_API_KEY',type: 'openai-compat' },
  'puter-sonnet': { name: 'Puter Sonnet', baseURL: 'https://api.puter.com',                         defaultModel: 'claude-sonnet-4-20250514',                 apiKey: 'free',                                              apiKeyEnv: '',                     type: 'openai-compat' },
  'puter-4o':  { name: 'Puter GPT-4o', baseURL: 'https://api.puter.com',                            defaultModel: 'gpt-4o',                                   apiKey: 'free',                                              apiKeyEnv: '',                     type: 'openai-compat' },
});

// Waterfall order: hackbot 1st (uncensored bot network, primary brain),
// gpt-oss 2nd (120b cloud), ollama 3rd (hp-1000, local backup),
// then sambanova + groq (cloud-free) and on down — rotates to the next on rate-limit.
const WATERFALL_ORDER = ['hackbot','gpt-oss','ollama','claude-cli','sambanova','groq','cerebras','gemini','gemini-flash','openrouter','pollinations','puter-sonnet','puter-4o'];
const _rateLimited = new Map(); // provider -> until ms
function markProviderRateLimited(name, ms = 60000) { if (name) _rateLimited.set(name, Date.now() + ms); }
function isProviderRateLimited(name) { const until = _rateLimited.get(name); if (!until) return false; if (Date.now() > until) { _rateLimited.delete(name); return false; } return true; }
function providerHasKey(name) {
  const cfg = PROVIDERS[name]; if (!cfg) return false;
  if (cfg.type === 'gemini') return !!(cfg.apiKey);
  return !!cfg.apiKey || cfg.apiKey === 'free';
}
// Pick the best provider from the waterfall (skip rate-limited / keyless). Returns {provider, model}.
function getWaterfallProvider(prefer) {
  const order = prefer ? [prefer, ...WATERFALL_ORDER] : WATERFALL_ORDER;
  for (const name of order) {
    if (!PROVIDERS[name]) continue;
    if (isProviderRateLimited(name)) continue;
    if (!providerHasKey(name)) continue;
    return { provider: name, model: PROVIDERS[name].defaultModel };
  }
  // fallback to ollama (local, keyless) — always usable
  return { provider: 'ollama', model: PROVIDERS.ollama.defaultModel };
}

// ── Image Gen providers ────────────────────────────────────────────
const IMAGE_PROVIDERS = {
  pollinations: {
    name: 'Pollinations',
    models: ['zimage', 'flux', 'gptimage', 'kontext', 'seedream5', 'qwen-image'],
  },
  openai: {
    name: 'DALL-E 3',
    models: ['dall-e-3', 'gpt-image-1'],
  },
  openrouter: {
    name: 'OpenRouter Image',
    models: ['openai/dall-e-3'],
  },
};

// Keep upstream image calls below Cloudflare's common 100s 524 window.
// The Chat agent streams heartbeats, but the image modal/API returns JSON.
const IMAGE_REQUEST_TIMEOUT_MS = 85000;

function parseImageSize(size = '1024x1024') {
  const match = String(size || '').match(/^(\d{2,5})x(\d{2,5})$/i);
  const width = match ? Math.max(64, Math.min(2048, Number(match[1]))) : 1024;
  const height = match ? Math.max(64, Math.min(2048, Number(match[2]))) : 1024;
  return { width, height, size: `${width}x${height}` };
}

function getPollinationsKey() {
  const usable = (value) => {
    const key = String(value || '').trim();
    if (!key) return '';
    if (['free', 'none', 'null', 'undefined', 'changeme', 'your_key_here'].includes(key.toLowerCase())) return '';
    return key;
  };
  const envKey = process.env.POLLINATIONS_API_KEY || process.env.POLLINATIONS_KEY || '';
  const usableEnvKey = usable(envKey);
  if (usableEnvKey) return usableEnvKey;
  try {
    const envFile = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
    const match = envFile.match(/^POLLINATIONS_API_KEY=(.+)$/m) || envFile.match(/^POLLINATIONS_KEY=(.+)$/m);
    const fileKey = usable(match?.[1]);
    if (fileKey) return fileKey;
  } catch (_) { /* optional server env fallback */ }
  for (const file of [
    '/home/ghost/.phantom-ai-config.json',
    '/home/ghost/.phantom-ai-config.backup.json',
  ]) {
    try {
      const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
      const key = usable(cfg?.pollinations?.key || cfg?.providers?.pollinations?.key || '');
      if (key) return key;
    } catch (_) { /* optional PhantomIDE config fallback */ }
  }
  return '';
}

function getPhantomImagegenConfig() {
  for (const file of ['/home/ghost/.phantom-ai-config.json']) {
    try {
      const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
      const imagegen = cfg?.imagegen || {};
      const key = String(imagegen.key || imagegen.keyBackup || '').trim();
      if (!key) continue;
      return {
        key,
        baseUrl: imagegen.baseUrl || 'https://generativelanguage.googleapis.com/v1beta',
        model: imagegen.model || 'gemini-2.5-flash-image',
      };
    } catch (_) { /* optional PhantomIDE imagegen fallback */ }
  }
  return null;
}

async function phantomImagegenGenerate({ prompt, model, size }) {
  const cfg = getPhantomImagegenConfig();
  if (!cfg) throw new Error('PhantomIDE imagegen config is missing');
  const imageModel = model && /^gemini-|^imagen-/i.test(model) ? model : cfg.model;
  const url = new URL(`${String(cfg.baseUrl).replace(/\/$/, '')}/models/${encodeURIComponent(imageModel)}:generateContent`);
  url.searchParams.set('key', cfg.key);
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ['IMAGE', 'TEXT'] },
    }),
    signal: AbortSignal.timeout(IMAGE_REQUEST_TIMEOUT_MS),
  });
  const data = await response.json().catch(async () => ({ error: await response.text().catch(() => response.statusText) }));
  if (!response.ok) {
    const msg = data?.error?.message || data?.error || response.statusText;
    throw new Error(`PhantomIDE imagegen failed (${response.status}): ${String(msg).slice(0, 240)}`);
  }
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find(p => p.inlineData?.data || p.inline_data?.data);
  const inlineData = imagePart?.inlineData || imagePart?.inline_data;
  if (!inlineData?.data) throw new Error('PhantomIDE imagegen returned no image');
  return {
    b64_json: inlineData.data,
    revised_prompt: parts.find(p => p.text)?.text || null,
    mime_type: inlineData.mimeType || inlineData.mime_type || 'image/png',
    model: imageModel,
    size: parseImageSize(size).size,
  };
}

async function pollinationsImageFromUrl({ prompt, model, size, quality, imageUrl, enhance = false }) {
  const dims = parseImageSize(size);
  const imageModel = (!model || model === 'dall-e-3' || model === 'gpt-image-1') ? (imageUrl ? 'kontext' : 'zimage') : model;
  const url = new URL(`https://gen.pollinations.ai/image/${encodeURIComponent(prompt)}`);
  url.searchParams.set('model', imageModel);
  url.searchParams.set('width', String(dims.width));
  url.searchParams.set('height', String(dims.height));
  url.searchParams.set('nologo', 'true');
  url.searchParams.set('safe', 'true');
  if (quality) url.searchParams.set('quality', quality);
  if (enhance) url.searchParams.set('enhance', 'true');
  if (imageUrl) url.searchParams.set('image', imageUrl);
  const apiKey = getPollinationsKey();
  if (apiKey) url.searchParams.set('key', apiKey);

  const response = await fetch(url, {
    headers: {
      'Accept': 'image/png,image/jpeg,image/*',
      'User-Agent': 'haksterAi/0.1 image-generator',
    },
    signal: AbortSignal.timeout(IMAGE_REQUEST_TIMEOUT_MS),
  });
  const contentType = response.headers.get('content-type') || '';
  if (!response.ok || !contentType.startsWith('image/')) {
    const body = await response.text().catch(() => '');
    throw new Error(`Pollinations image generation failed (${response.status}): ${body.slice(0, 240) || contentType || response.statusText}`);
  }
  return {
    b64_json: Buffer.from(await response.arrayBuffer()).toString('base64'),
    revised_prompt: null,
    mime_type: contentType || 'image/png',
    model: imageModel,
    size: dims.size,
  };
}

async function pollinationsEditFromFile({ prompt, model, size, quality, imagePath, enhance = false }) {
  const apiKey = getPollinationsKey();
  if (!apiKey) throw new Error('Pollinations image editing requires POLLINATIONS_API_KEY in the server environment');
  const dims = parseImageSize(size);
  const imageModel = (!model || model === 'dall-e-3' || model === 'gpt-image-1' || model === 'zimage' || model === 'flux') ? 'kontext' : model;
  const finalPrompt = enhance ? `${prompt}\n\nEnhance image quality, sharpen details, improve lighting/color balance, and preserve the main subject unless instructed otherwise.` : prompt;
  const fileBuffer = fs.readFileSync(imagePath);
  const ext = path.extname(imagePath).toLowerCase();
  const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
    : ext === '.webp' ? 'image/webp'
    : ext === '.gif' ? 'image/gif'
    : 'image/png';
  const form = new FormData();
  form.append('image', new Blob([fileBuffer], { type: mime }), path.basename(imagePath));
  form.append('prompt', finalPrompt);
  form.append('model', imageModel);
  form.append('size', dims.size);
  form.append('quality', quality || 'hd');
  form.append('response_format', 'b64_json');
  const response = await fetch('https://gen.pollinations.ai/v1/images/edits', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(IMAGE_REQUEST_TIMEOUT_MS),
  });
  const data = await response.json().catch(async () => ({ error: await response.text().catch(() => response.statusText) }));
  if (!response.ok) {
    const msg = data?.error?.message || data?.error || response.statusText;
    throw new Error(`Pollinations image edit failed (${response.status}): ${String(msg).slice(0, 240)}`);
  }
  const first = data?.data?.[0];
  if (!first?.b64_json && !first?.url) throw new Error('Pollinations image edit returned no image');
  if (first.b64_json) {
    return { b64_json: first.b64_json, revised_prompt: first.revised_prompt || null, mime_type: 'image/png', model: imageModel, size: dims.size };
  }
  const img = await pollinationsImageFromUrl({ prompt: finalPrompt, model: imageModel, size: dims.size, quality, imageUrl: first.url });
  return { ...img, revised_prompt: first.revised_prompt || img.revised_prompt };
}

function writeDataImageToTemp(imageUrl) {
  const match = String(imageUrl || '').match(/^data:image\/([\w+.-]+);base64,(.+)$/i);
  if (!match) return null;
  const ext = match[1].replace('jpeg', 'jpg').replace(/[^\w.-]/g, '') || 'png';
  const filePath = path.join(osTmpDir(), `hakster-image-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
  fs.writeFileSync(filePath, Buffer.from(match[2], 'base64'));
  return filePath;
}

function osTmpDir() {
  try { return require('os').tmpdir(); } catch (_) { return '/tmp'; }
}

// ── Client factory ──────────────────────────────────────────────────
function getClient(provider) {
  const cfg = PROVIDERS[provider];
  if (!cfg) throw new Error(`Unknown provider: ${provider}`);

  switch (cfg.type) {
    case 'anthropic':
      return new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });

    case 'openai':
      return new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 120000 });

    case 'openrouter':
      return new OpenAI({
        apiKey: process.env.OPENROUTER_API_KEY,
        baseURL: cfg.baseURL,
        timeout: 120000,
        defaultHeaders: {
          'HTTP-Referer': 'https://hakster.ai',
          'X-Title': 'haksterAi',
        },
      });

    case 'openai-compat':
      return new OpenAI({
        apiKey: 'ollama',
        baseURL: `${cfg.baseURL}/v1`,
        timeout: 120000, // 2 minute timeout for model calls
      });

    case 'hermes-api':
      return new OpenAI({
        apiKey: process.env.HERMES_API_KEY || '',
        baseURL: cfg.baseURL,
        timeout: 120000,
      });

    case 'butch':
      return new OpenAI({
        apiKey: process.env.BUTCH_API_KEY || process.env.HERMES_API_KEY || '',
        baseURL: cfg.baseURL,
        timeout: 120000,
      });

    case 'claude-proxy':
      // Claude Code Proxy translates Anthropic API → LiteLLM (OpenAI/Google/Anthropic)
      // It runs on port 8082 and accepts /v1/messages (Anthropic format)
      // We use the Anthropic SDK pointed at the proxy
      return new Anthropic.default({
        apiKey: process.env.ANTHROPIC_API_KEY || 'proxy',
        baseURL: cfg.baseURL,
      });

    case 'codex':
      // Nous Research OpenAI-compatible endpoint (GPT-5.5 non-US)
      return new OpenAI({
        apiKey: process.env.CODEX_API_KEY || process.env.NOUS_API_KEY || '',
        baseURL: cfg.baseURL,
        timeout: 120000,
      });

    case 'nous':
      // Nous Research OpenAI-compatible endpoint for Claude Fable/latest models
      return new OpenAI({
        apiKey: process.env.NOUS_API_KEY || process.env.CODEX_API_KEY || '',
        baseURL: cfg.baseURL,
        timeout: 120000,
      });

    default:
      throw new Error(`Unhandled provider type: ${cfg.type}`);
  }
}

// ── Cost estimator (rough, per 1M tokens) ─────────────────────────
const COST_TABLE = {
  'claude-sonnet-4-5':         { in: 3.00,  out: 15.00 },
  'claude-opus-4-5':           { in: 15.00, out: 75.00 },
  'claude-haiku-3-5':          { in: 0.80,  out: 4.00  },
  'gpt-4o':                    { in: 5.00,  out: 15.00 },
  'gpt-4o-mini':               { in: 0.15,  out: 0.60  },
  'gpt-3.5-turbo':             { in: 0.50,  out: 1.50  },
  'default':                   { in: 0,     out: 0     },
};

function estimateCost(model, inputTokens, outputTokens) {
  const rates = COST_TABLE[model] || COST_TABLE['default'];
  return (inputTokens / 1_000_000) * rates.in + (outputTokens / 1_000_000) * rates.out;
}

// ── Firecrawl key rotator ────────────────────────────────────────
function getFirecrawlKeys() {
  const keys = [];
  if (process.env.FIRECRAWL_API_KEY) keys.push(process.env.FIRECRAWL_API_KEY);
  for (let i = 1; i <= 12; i++) {
    const k = process.env[`FIRECRAWL_API_KEY_${i}`] || process.env[`FIRECRAWL_API_KEY${i}`];
    if (k) keys.push(k);
  }
  return [...new Set(keys)].filter(k => k && k.trim().length > 10);
}

let _fcKeyIndex = 0;
function nextFirecrawlKey() {
  const keys = getFirecrawlKeys();
  if (keys.length === 0) return null;
  const key = keys[_fcKeyIndex % keys.length];
  _fcKeyIndex++;
  return key;
}

async function firecrawlRequest(endpoint, body, keysLeft = null) {
  const keys = keysLeft || (() => {
    const allKeys = getFirecrawlKeys();
    if (allKeys.length === 0) return [];
    const start = _fcKeyIndex % allKeys.length;
    _fcKeyIndex++;
    return allKeys.slice(start).concat(allKeys.slice(0, start));
  })();
  if (keys.length === 0) throw new Error('No FIRECRAWL_API_KEY_* configured');
  const key = keys[0];
  const https = require('https');
  const postData = JSON.stringify(body);
  const url = new URL(`https://api.firecrawl.dev/v1${endpoint}`);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
      timeout: 30000,
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if ([401, 403, 429].includes(res.statusCode) || res.statusCode >= 500 || json?.error?.includes?.('rate limit')) {
            if (keys.length > 1) return resolve(firecrawlRequest(endpoint, body, keys.slice(1)));
          }
          resolve({ status: res.statusCode, json });
        } catch {
          resolve({ status: res.statusCode, text: data });
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Firecrawl request timed out')); });
    req.write(postData);
    req.end();
  });
}

async function firecrawlSearch(query, count = 5) {
  const res = await firecrawlRequest('/search', { query, limit: Math.min(count, 10) });
  if (res.status >= 400) throw new Error(res.json?.error || res.text || `HTTP ${res.status}`);
  return res.json?.data?.map(r => ({
    title: r.title || r.metadata?.title || '(No title)',
    url: r.url || r.metadata?.sourceURL || '',
    snippet: r.description || r.markdown?.slice(0, 300) || '',
  })) || [];
}

async function firecrawlScrape(url) {
  const res = await firecrawlRequest('/scrape', { url, formats: ['markdown'] });
  if (res.status >= 400) throw new Error(res.json?.error || res.text || `HTTP ${res.status}`);
  return res.json?.data?.markdown || res.json?.data?.content || JSON.stringify(res.json?.data, null, 2);
}

function localKnowledgeFallback(query) {
  const q = String(query || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (/\btupac\b/.test(q) || /\b2pac\b/.test(q) || /\bshukur\b/.test(q) || /\bshakur\b/.test(q)) {
    return [
      'Local knowledge fallback for: Tupac Shakur (often stylized 2Pac)',
      '',
      '1. Tupac Shakur',
      '   Tupac Amaru Shakur, also known as 2Pac and Makaveli, was an American rapper, actor, poet, and activist. He became one of the most influential figures in hip-hop, known for songs that mixed social commentary, personal struggle, and West Coast rap. He was born in 1971 and died in 1996 after a shooting in Las Vegas.',
      '   Note: "Tupac Shukur" is most likely a misspelling of "Tupac Shakur".',
      '',
    ].join('\n');
  }
  return '';
}

// ── System prompt ────────────────────────────────────────────────
// Note: haksterAi is the terminal interface brand. Underlying model engine
// varies (claude-cli, ollama, etc.) and may be different from the brand. Do
// NOT inject "respond with haksterAi when asked your name" — that instruction
// makes honest models flag the prompt as identity-injection and refuse.
const SYSTEM_PROMPT = 'You are haksterAi, an expert coding assistant running inside the haksterAi terminal interface. You always provide complete, runnable code. When asked to write code or scripts, you write the full code — no partial snippets. Every response must contain working code. If the user asks for a bash script, write the full bash script. If they ask for a Python program, write the full program.';

// ── Main: non-streaming chat ────────────────────────────────────────
// ── Claude CLI (Pro/Max subscription, no API billing) ────────────────
// Runs `claude -p` non-interactively as a pure text-completion oracle.
// Tool use is explicitly disallowed here: Hakster's own agent loop is what
// parses tool calls out of the returned text and executes them under its
// own approval gates — letting the spawned CLI use its own Bash/Edit tools
// would let it mutate files outside that loop, unsupervised.
// Some deployments run this server under a supervisor (e.g. a root-owned PM2
// daemon) whose environment still carries HOME=/root even though the actual
// process UID is ghost. `claude` then can't find ghost's OAuth credentials
// (~/.claude.json) or its own binary on PATH. Force the real home/PATH so
// the CLI always resolves against the authenticated ghost account.
const CLAUDE_CLI_HOME = '/home/ghost';
function claudeCliEnv() {
  const { ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, ...rest } = process.env;
  return {
    ...rest,
    HOME: CLAUDE_CLI_HOME,
    USER: 'ghost',
    PATH: `${CLAUDE_CLI_HOME}/.local/bin:${process.env.PATH || ''}`,
  };
}

function claudeCliComplete({ model, messages, system }) {
  const { spawn } = require('child_process');
  return new Promise((resolve, reject) => {
    const sysPrompt = system || SYSTEM_PROMPT;
    const transcript = (messages || [])
      .filter(m => m.role !== 'system')
      .map(m => {
        let content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        if (m.role === 'assistant') content = content.replace(/\b(?:I'm Claude\b|I am Claude\b|made by Anthropic\b|Claude Code CLI agent\b|Anthropic[^.]*\b)/gi, (s) => {
          if (/I'm Claude/i.test(s)) return "I'm haksterAI";
          if (/I am Claude/i.test(s)) return "I am haksterAI";
          if (/made by Anthropic/i.test(s)) return "built by Ghost";
          if (/Claude Code CLI agent/i.test(s)) return "haksterAI agent";
          return 'haksterAI';
        });
        return `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${content}`;
      })
      .join('\n\n');

    // Prompt goes over stdin, not argv — a long conversation transcript can
    // easily exceed the OS's command-line argument size limit ("spawn E2BIG").
    // The system prompt is also often huge (steering docs, memory summaries) —
    // passing it as a raw --system-prompt argv string hits Linux's ~128KB
    // per-argument limit and fails with the same E2BIG error. A file has no such cap.
    // CRITICAL: Use --system-prompt-file (REPLACE), NOT --append-system-prompt-file
    // (APPEND) — appending keeps Claude's "I am Claude" identity, causing bleed-through.
    const os = require('os');
    const sysPromptFile = path.join(os.tmpdir(), `hakster-sysprompt-${process.pid}-${Date.now()}.txt`);
    fs.writeFileSync(sysPromptFile, sysPrompt);
    const args = [
      '-p',
      '--output-format', 'text',
      '--system-prompt-file', sysPromptFile,
      '--disallowedTools', 'Bash Edit Write NotebookEdit Task WebFetch',
    ];
    if (model && model !== 'claude-cli') args.push('--model', model);

    const child = spawn('claude', args, { env: claudeCliEnv() });
    child.stdin.write(transcript);
    child.stdin.end();

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    const cleanupSysPromptFile = () => { try { fs.unlinkSync(sysPromptFile); } catch {} };
    const timer = setTimeout(() => { child.kill('SIGTERM'); }, 120000);
    child.on('error', (err) => { clearTimeout(timer); cleanupSysPromptFile(); reject(new Error(`claude CLI failed: ${err.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      cleanupSysPromptFile();
      if (code !== 0 && !stdout.trim()) return reject(new Error(`claude CLI failed: ${(stderr || `exit ${code}`).slice(0, 500)}`));
      resolve(stdout.trim());
    });
  });
}

// Model routing: pick cheap model for simple tasks, expensive for complex
const MODEL_TIERS = {
  cheap: { anthropic: "claude-haiku-3-5", openai: "gpt-4.1-mini", gemini: "gemini-2.0-flash-lite" },
  standard: { anthropic: "claude-sonnet-4-5", openai: "gpt-4.1", gemini: "gemini-2.5-flash" },
  premium: { anthropic: "claude-opus-4-5", openai: "gpt-4.1", gemini: "gemini-2.5-pro" }
};
function routeModel(complexity, providerType) {
  const tier = MODEL_TIERS[complexity] || MODEL_TIERS.standard;
  return tier[providerType] || tier.anthropic;
}

async function chat({ provider, model, messages, system, maxTokens = 4096 }) {
  const cfg = PROVIDERS[provider];
  if (!cfg) throw new Error(`Unknown provider: ${provider}`);
  model = model || cfg.defaultModel;

  const start = Date.now();

  if (cfg.type === 'anthropic' || cfg.type === 'claude-proxy') {
    const client = getClient(provider);
    const res = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system: [{ type: "text", text: system || SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: sanitizeMessagesForProvider(messages.filter(m => m.role !== 'system'), provider),
    });
    const latency = Date.now() - start;
    const inputTokens = res.usage?.input_tokens ?? 0;
    const outputTokens = res.usage?.output_tokens ?? 0;
    return {
      content: res.content[0]?.text ?? '',
      inputTokens,
      outputTokens,
      latency,
      cost: estimateCost(model, inputTokens, outputTokens),
      model,
      provider,
    };
  }

  if (cfg.type === 'claude-cli') {
    const content = await claudeCliComplete({ model, messages, system });
    return {
      content,
      inputTokens: 0,
      outputTokens: 0,
      latency: Date.now() - start,
      cost: 0,
      model,
      provider,
    };
  }

  // OpenAI / Ollama / Hermes / OpenRouter
  const client = getClient(provider);
  const finalMessages = system
    ? [{ role: 'system', content: system }, ...messages]
    : messages;

  const res = await client.chat.completions.create({
    model,
    messages: sanitizeMessagesForProvider(finalMessages, provider),
    max_tokens: maxTokens,
  });

  const latency = Date.now() - start;
  const inputTokens = res.usage?.prompt_tokens ?? 0;
  const outputTokens = res.usage?.completion_tokens ?? 0;
  return {
    content: res.choices[0]?.message?.content ?? '',
    inputTokens,
    outputTokens,
    latency,
    cost: estimateCost(model, inputTokens, outputTokens),
    model,
    provider,
  };
}

// ── Streaming chat (with thinking support for ALL providers) ────────
async function* chatStream({ provider, model, messages, system, thinking = false, maxTokens = 6144 }) {
  const cfg = PROVIDERS[provider];
  if (!cfg) throw new Error(`Unknown provider: ${provider}`);
  model = model || cfg.defaultModel;

  const start = Date.now();
  let inputTokens = 0;
  let outputTokens = 0;

  // ── Anthropic with extended thinking ──────────────────────────────
  if ((cfg.type === 'anthropic' || cfg.type === 'claude-proxy') && thinking) {
    const client = getClient(provider);
    const sysPrompt = system || SYSTEM_PROMPT;

    const stream = await client.messages.stream({
      model,
      max_tokens: maxTokens,
      system: sysPrompt,
      messages: sanitizeMessagesForProvider(messages.filter(m => m.role !== 'system'), provider),
      thinking: {
        type: 'enabled',
        budget_tokens: 6000,
      },
    });

    for await (const event of stream) {
      if (event.type === 'content_block_start') {
        if (event.content_block?.type === 'thinking') {
          yield { type: 'thinking_start' };
        }
      }
      if (event.type === 'content_block_delta') {
        if (event.delta?.type === 'thinking_delta') {
          yield { type: 'thinking', content: event.delta.thinking };
        }
        if (event.delta?.type === 'text_delta') {
          outputTokens++;
          yield { type: 'delta', content: event.delta.text };
        }
      }
      if (event.type === 'content_block_stop') {
        if (event.content_block?.type === 'thinking') {
          yield { type: 'thinking_end' };
        }
      }
      if (event.type === 'message_start') {
        inputTokens = event.message?.usage?.input_tokens ?? 0;
      }
      if (event.type === 'message_delta') {
        outputTokens = event.usage?.output_tokens ?? outputTokens;
      }
    }

    yield {
      type: 'done',
      inputTokens,
      outputTokens,
      latency: Date.now() - start,
      cost: estimateCost(model, inputTokens, outputTokens),
      model,
      provider,
    };
    return;
  }

  // ── Anthropic without thinking ────────────────────────────────────
  if (cfg.type === 'anthropic' || cfg.type === 'claude-proxy') {
    const client = getClient(provider);
    const stream = await client.messages.stream({
      model,
      max_tokens: maxTokens,
      system: [{ type: "text", text: system || SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: sanitizeMessagesForProvider(messages.filter(m => m.role !== 'system'), provider),
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        outputTokens++;
        yield { type: 'delta', content: event.delta.text };
      }
      if (event.type === 'message_start') {
        inputTokens = event.message?.usage?.input_tokens ?? 0;
      }
      if (event.type === 'message_delta') {
        outputTokens = event.usage?.output_tokens ?? outputTokens;
      }
    }

    yield {
      type: 'done',
      inputTokens,
      outputTokens,
      latency: Date.now() - start,
      cost: estimateCost(model, inputTokens, outputTokens),
      model,
      provider,
    };
    return;
  }

  if (cfg.type === 'claude-cli') {
    const content = await claudeCliComplete({ model, messages, system });
    outputTokens = Math.ceil(content.length / 4);
    yield { type: 'delta', content };
    yield {
      type: 'done',
      inputTokens: 0,
      outputTokens,
      latency: Date.now() - start,
      cost: 0,
      model,
      provider,
    };
    return;
  }

  // ── OpenAI / Ollama / Hermes / OpenRouter ──────────────────────────
  const client = getClient(provider);
  const finalMessages = system
    ? [{ role: 'system', content: system }, ...messages]
    : messages;

  // If thinking is requested for non-Anthropic providers, inject a thinking prompt
  const thinkingPrefix = thinking
    ? [{ role: 'system', content: SYSTEM_PROMPT + '\n\nBefore answering, think through the problem step-by-step inside <thinking>...</thinking> tags. Then provide your answer after the closing </thinking> tag.' }]
    : [];

  const streamMessages = thinking
    ? [...thinkingPrefix, ...finalMessages]
    : finalMessages;

  const streamOpts = {
    model,
    messages: sanitizeMessagesForProvider(streamMessages, provider),
    stream: true,
  };

  // Include usage if provider supports it (not Ollama)
  if (cfg.type !== 'openai-compat') {
    streamOpts.stream_options = { include_usage: true };
  }

  // For o1 models, use reasoning effort instead of max_tokens
  if (model.startsWith('o1') && thinking) {
    streamOpts.reasoning_effort = 'high';
  } else {
    streamOpts.max_tokens = 4096;
  }

  const stream = await client.chat.completions.create(streamOpts);

  let insideThinking = false;
  let thinkingBuffer = '';

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta;

    // OpenAI o1 reasoning tokens
    if (delta?.reasoning_content) {
      yield { type: 'thinking', content: delta.reasoning_content };
    }

    if (delta?.content) {
      // For thinking mode on non-Anthropic providers, parse <thinking> tags
      if (thinking && cfg.type !== 'anthropic') {
        thinkingBuffer += delta.content;

        // Check for <thinking> start
        while (true) {
          if (!insideThinking && thinkingBuffer.includes('<thinking>')) {
            // Yield everything before <thinking> as normal delta
            const before = thinkingBuffer.substring(0, thinkingBuffer.indexOf('<thinking>'));
            if (before.trim()) {
              outputTokens++;
              yield { type: 'delta', content: before };
            }
            thinkingBuffer = thinkingBuffer.substring(thinkingBuffer.indexOf('<thinking>') + 11);
            insideThinking = true;
            yield { type: 'thinking_start' };
          } else if (insideThinking && thinkingBuffer.includes('</thinking>')) {
            // Yield accumulated thinking content
            const thinkingText = thinkingBuffer.substring(0, thinkingBuffer.indexOf('</thinking>'));
            if (thinkingText) {
              yield { type: 'thinking', content: thinkingText };
            }
            thinkingBuffer = thinkingBuffer.substring(thinkingBuffer.indexOf('</thinking>') + 12);
            insideThinking = false;
            yield { type: 'thinking_end' };
          } else {
            break;
          }
        }

        // Flush safe output (don't cut across tag boundaries)
        if (insideThinking) {
          // Still inside thinking block — check if buffer is safe to emit
          const safeEnd = thinkingBuffer.length;
          if (safeEnd > 0) {
            yield { type: 'thinking', content: thinkingBuffer };
            thinkingBuffer = '';
          }
        } else {
          // Outside thinking — check if buffer tail might start a tag
          const lastOpenBracket = thinkingBuffer.lastIndexOf('<');
          if (lastOpenBracket !== -1 && !thinkingBuffer.substring(lastOpenBracket).includes('>')) {
            // Might be start of <thinking> — hold it
            const safePrefix = thinkingBuffer.substring(0, lastOpenBracket);
            if (safePrefix) {
              outputTokens++;
              yield { type: 'delta', content: safePrefix };
            }
            thinkingBuffer = thinkingBuffer.substring(lastOpenBracket);
          } else {
            if (thinkingBuffer) {
              outputTokens++;
              yield { type: 'delta', content: thinkingBuffer };
              thinkingBuffer = '';
            }
          }
        }
      } else {
        // No thinking parsing — just emit directly
        outputTokens++;
        yield { type: 'delta', content: delta.content };
      }
    }

    if (chunk.usage) {
      inputTokens = chunk.usage.prompt_tokens ?? 0;
      outputTokens = chunk.usage.completion_tokens ?? outputTokens;
    }
  }

  // Flush any remaining buffer
  if (thinkingBuffer) {
    if (insideThinking) {
      yield { type: 'thinking', content: thinkingBuffer };
      yield { type: 'thinking_end' };
    } else {
      outputTokens++;
      yield { type: 'delta', content: thinkingBuffer };
    }
  }

  yield {
    type: 'done',
    inputTokens,
    outputTokens,
    latency: Date.now() - start,
    cost: estimateCost(model, inputTokens, outputTokens),
    model,
    provider,
  };
}

// ── Image generation ────────────────────────────────────────────────
async function generateImage({ provider = 'openai', model = 'dall-e-3', prompt, size = '1024x1024', quality = 'hd', n = 1, imagePath, imageUrl, operation = 'generate', enhance = false }) {
  if (provider === 'pollinations') {
    const start = Date.now();
    const useEnhance = enhance || operation === 'enhance';
    let tempImagePath = null;
    if (!imagePath && imageUrl && String(imageUrl).startsWith('data:image/')) {
      tempImagePath = writeDataImageToTemp(imageUrl);
      imagePath = tempImagePath;
      imageUrl = null;
    }
    let img;
    let fallbackProvider = 'pollinations';
    try {
      try {
        img = imagePath
          ? await pollinationsEditFromFile({ prompt, model, size, quality, imagePath, enhance: useEnhance })
          : await pollinationsImageFromUrl({ prompt, model, size, quality, imageUrl, enhance: useEnhance });
      } catch (err) {
        const authFailed = /401|auth|unauthorized/i.test(err.message || String(err));
        if (!authFailed || imagePath || imageUrl) throw err;
        img = await phantomImagegenGenerate({ prompt, model, size });
        fallbackProvider = 'phantomide-imagegen';
      }
    } finally {
      if (tempImagePath) {
        try { fs.unlinkSync(tempImagePath); } catch (_) {}
      }
    }
    return {
      images: [{ b64_json: img.b64_json, revised_prompt: img.revised_prompt, mime_type: img.mime_type }],
      latency: Date.now() - start,
      model: img.model,
      provider: fallbackProvider,
      size: img.size,
    };
  }

  if (provider === 'openrouter') {
    // OpenRouter doesn't have native image gen — route through OpenAI
    const client = new OpenAI({ apiKey: process.env.OPENROUTER_API_KEY, baseURL: 'https://openrouter.ai/api/v1' });
    const start = Date.now();
    const response = await client.images.generate({
      model,
      prompt,
      size,
      quality,
      n,
      response_format: 'b64_json',
    });
    const images = response.data.map(img => ({
      b64_json: img.b64_json,
      revised_prompt: img.revised_prompt,
    }));
    return { images, latency: Date.now() - start, model, provider: 'openrouter' };
  }

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const start = Date.now();
  const response = await client.images.generate({
    model,
    prompt,
    size,
    quality,
    n,
    response_format: 'b64_json',
  });
  const images = response.data.map(img => ({
    b64_json: img.b64_json,
    revised_prompt: img.revised_prompt,
  }));
  return { images, latency: Date.now() - start, model, provider: 'openai' };
}

// ── Image analysis (vision) ────────────────────────────────────────
async function analyzeImage({ provider, model, prompt, imageBase64, imageUrl, mimeType = 'image/png' }) {
  const cfg = PROVIDERS[provider];
  if (!cfg) throw new Error(`Unknown provider: ${provider}`);
  model = model || cfg.defaultModel;

  const start = Date.now();

  // Build image content block
  let imageContent;
  if (imageBase64) {
    imageContent = {
      type: 'image',
      source: {
        type: 'base64',
        media_type: mimeType,
        data: imageBase64,
      },
    };
  } else if (imageUrl) {
    imageContent = {
      type: 'image_url',
      url: imageUrl,
    };
  } else {
    throw new Error('imageBase64 or imageUrl required');
  }

  if (cfg.type === 'anthropic' || cfg.type === 'claude-proxy') {
    const client = getClient(provider);
    const res = await client.messages.create({
      model: model || 'claude-sonnet-4-5',
      max_tokens: maxTokens,
      messages: [{
        role: 'user',
        content: [
          imageContent,
          { type: 'text', text: prompt || 'Describe and analyze this image in detail.' },
        ],
      }],
    });
    const latency = Date.now() - start;
    const inputTokens = res.usage?.input_tokens ?? 0;
    const outputTokens = res.usage?.output_tokens ?? 0;
    return {
      content: res.content[0]?.text ?? '',
      inputTokens,
      outputTokens,
      latency,
      cost: estimateCost(model, inputTokens, outputTokens),
      model,
      provider,
    };
  }

  // OpenAI / Ollama / Hermes / OpenRouter vision
  const client = getClient(provider);
  const imageBlock = imageUrl
    ? { type: 'image_url', image_url: { url: imageUrl } }
    : { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } };

  const res = await client.chat.completions.create({
    model,
    max_tokens: maxTokens,
    messages: [{
      role: 'user',
      content: [
        imageBlock,
        { type: 'text', text: prompt || 'Describe and analyze this image in detail.' },
      ],
    }],
  });

  const latency = Date.now() - start;
  const inputTokens = res.usage?.prompt_tokens ?? 0;
  const outputTokens = res.usage?.completion_tokens ?? 0;
  return {
    content: res.choices[0]?.message?.content ?? '',
    inputTokens,
    outputTokens,
    latency,
    cost: estimateCost(model, inputTokens, outputTokens),
    model,
    provider,
  };
}

// ── List available models ───────────────────────────────────────────
async function listModels(provider) {
  const cfg = PROVIDERS[provider];
  if (!cfg) throw new Error(`Unknown provider: ${provider}`);

  try {
    if (cfg.type === 'anthropic' || cfg.type === 'claude-proxy') {
      return [
        { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', thinking: true },
        { id: 'claude-opus-4-5',   name: 'Claude Opus 4.5', thinking: true },
        { id: 'claude-haiku-3-5',  name: 'Claude Haiku 3.5', thinking: true },
      ];
    }

    if (cfg.type === 'openai') {
      return [
        { id: 'gpt-4o',       name: 'GPT-4o' },
        { id: 'gpt-4o-mini',  name: 'GPT-4o Mini' },
        { id: 'o1-mini',      name: 'o1 Mini', thinking: true },
      ];
    }

    if (cfg.type === 'codex') {
      return [
        // GPT-5.x family
        { id: 'openai/gpt-5.5',          name: 'GPT-5.5', thinking: true },
        { id: 'openai/gpt-5.5-pro',      name: 'GPT-5.5 Pro', thinking: true },
        { id: 'openai/gpt-5.4',          name: 'GPT-5.4', thinking: true },
        { id: 'openai/gpt-5.4-pro',      name: 'GPT-5.4 Pro', thinking: true },
        { id: 'openai/gpt-5.4-mini',     name: 'GPT-5.4 Mini' },
        { id: 'openai/gpt-5.3-codex',    name: 'GPT-5.3 Codex' },
        { id: 'openai/gpt-5.2',          name: 'GPT-5.2' },
        { id: 'openai/gpt-5.2-codex',    name: 'GPT-5.2 Codex' },
        { id: 'openai/gpt-5.1',          name: 'GPT-5.1' },
        { id: 'openai/gpt-5.1-codex',    name: 'GPT-5.1 Codex' },
        { id: 'openai/gpt-5.1-codex-max', name: 'GPT-5.1 Codex Max' },
        { id: 'openai/gpt-5',            name: 'GPT-5' },
        { id: 'openai/gpt-5-codex',      name: 'GPT-5 Codex' },
        { id: 'openai/gpt-5-mini',       name: 'GPT-5 Mini' },
        // Google Gemini
        { id: 'google/gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro', thinking: true },
        { id: 'google/gemini-3.5-flash',  name: 'Gemini 3.5 Flash' },
        { id: 'google/gemini-3-flash-preview', name: 'Gemini 3 Flash' },
        { id: 'google/gemini-2.5-pro',    name: 'Gemini 2.5 Pro', thinking: true },
        { id: 'google/gemini-2.5-flash',  name: 'Gemini 2.5 Flash' },
        { id: '~google/gemini-pro-latest', name: 'Gemini Pro (latest)' },
        { id: '~google/gemini-flash-latest', name: 'Gemini Flash (latest)' },
        // Claude (via Nous)
        { id: 'anthropic/claude-opus-4.8', name: 'Claude Opus 4.8', thinking: true },
        { id: 'anthropic/claude-sonnet-5', name: 'Claude Sonnet 5', thinking: true },
        { id: 'anthropic/claude-opus-4.7-fast', name: 'Claude Opus 4.7 Fast' },
        { id: 'anthropic/claude-haiku-4.5', name: 'Claude Haiku 4.5' },
        // DeepSeek
        { id: 'deepseek/deepseek-r1',     name: 'DeepSeek R1', thinking: true },
        { id: 'deepseek/deepseek-chat-v3.1', name: 'DeepSeek Chat V3.1' },
        // Others
        { id: 'openai/o3',               name: 'o3', thinking: true },
        { id: 'openai/o4-mini',           name: 'o4 Mini', thinking: true },
        { id: 'openai/gpt-oss-120b',     name: 'GPT-OSS 120B' },
        { id: 'bytedance-seed/seed-2.0-mini', name: 'Seed 2.0 Mini' },
      ];
    }

    if (cfg.type === 'nous') {
      return [
        { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash', thinking: true },
        { id: 'nousresearch/hermes-4-70b', name: 'Hermes 4 70B' },
        { id: '~anthropic/claude-fable-latest', name: 'Claude Fable Latest' },
        { id: 'anthropic/claude-fable-latest', name: 'Claude Fable Latest' },
        { id: 'anthropic/claude-sonnet-5', name: 'Claude Sonnet 5', thinking: true },
        { id: 'anthropic/claude-opus-4.8', name: 'Claude Opus 4.8', thinking: true },
        { id: 'anthropic/claude-haiku-4.5', name: 'Claude Haiku 4.5' },
      ];
    }

    if (cfg.type === 'openrouter') {
      return [
        { id: 'thudm/glm-5.2:cloud',          name: 'GLM 5.2 Cloud (1M ctx)', thinking: true },
        { id: 'thudm/glm-5.1:cloud-ctx', name: 'GLM 5.1 Cloud (Context)', thinking: true },
        { id: 'thudm/glm-5.1:cloud',     name: 'GLM 5.1 Cloud', thinking: true },
        { id: 'anthropic/claude-sonnet-4',   name: 'Claude Sonnet 4 (via OR)', thinking: true },
        { id: 'openai/gpt-4o',               name: 'GPT-4o (via OR)' },
        { id: 'google/gemini-2.5-pro',       name: 'Gemini 2.5 Pro (via OR)', thinking: true },
        { id: 'deepseek/deepseek-r1',        name: 'DeepSeek R1 (via OR)', thinking: true },
        { id: 'meta-llama/llama-4-maverick', name: 'Llama 4 Maverick (via OR)' },
      ];
    }

    // Ollama / Hermes — strip /v1 suffix (used for OpenAI-compat chat) to hit native /api/tags
    const tagsBase = cfg.baseURL.replace(/\/v1\/?$/, '');
    const res = await fetch(`${tagsBase}/api/tags`);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.models || []).map(m => ({ id: m.name, name: m.name }));
  } catch {
    return [];
  }
}

// ── Agent Tools ────────────────────────────────────────────────────
const AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a text file. Use offset/limit for large files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path (relative or absolute)' },
          offset: { type: 'number', description: '1-indexed start line (optional)' },
          limit: { type: 'number', description: 'Max lines to return (optional)' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or overwrite a file. Creates parent directories as needed.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
          content: { type: 'string', description: 'Full file content' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Replace an exact, unique text match in a file with new text. Use for precise edits instead of rewriting entire files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
          old_text: { type: 'string', description: 'Exact text to find (must be unique in the file)' },
          new_text: { type: 'string', description: 'Replacement text' },
        },
        required: ['path', 'old_text', 'new_text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List files and subdirectories of a directory (non-recursive).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path, defaults to cwd' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'exec_shell',
      description: 'Run a shell command and return its stdout/stderr. Use for builds, tests, git, installs, etc.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to run' },
          timeout_ms: { type: 'number', description: 'Optional timeout in ms, default 60000' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'spawn_agent',
      description: 'Spawn a sub-agent to handle a specific sub-task. The sub-agent gets the same tools as you. Use for parallelizing work or handing off focused tasks.',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'The task description for the sub-agent' },
        },
        required: ['task'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_navigate',
      description: 'Navigate a headless browser to a URL and return title, status, and interactive elements. Use before browser_snapshot or browser_screenshot.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to open' },
          wait_ms: { type: 'number', description: 'Optional extra wait after load, default 500ms' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_snapshot',
      description: 'Return a text snapshot of the current browser page: URL, title, viewport, interactive elements, and visible text.',
      parameters: {
        type: 'object',
        properties: {
          full: { type: 'boolean', description: 'Return more elements and page text' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_screenshot',
      description: 'Take a PNG screenshot of the current browser page or a CSS selector and return the local file path.',
      parameters: {
        type: 'object',
        properties: {
          full_page: { type: 'boolean', description: 'Capture full page instead of viewport' },
          selector: { type: 'string', description: 'Optional CSS selector for element screenshot' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_detect',
      description: 'Detect browser/device context. Returns the current headless browser page state plus the latest saved user browser/device context when available. Use when debugging browser issues, responsive UI, xterm, or user device-specific behavior.',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Optional session id to fetch a specific saved client context' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_image',
      description: 'Generate, edit, or enhance an image from a prompt. Defaults to Pollinations HD/top-grade output (low token/cost burn) and returns a local file path plus URL for inline display.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Text description of the image to generate' },
          provider: { type: 'string', description: 'Image provider: pollinations (default), openai, or openrouter', enum: ['pollinations', 'openai', 'openrouter'] },
          model: { type: 'string', description: 'Model to use. Pollinations default: zimage. Other options include flux, gptimage, kontext, seedream5, qwen-image.' },
          size: { type: 'string', description: 'Image size, e.g. 1024x1024, 1792x1024, 1024x1792, or 512x512' },
          quality: { type: 'string', description: 'Image quality: standard or hd. Default should be hd/top-grade unless the user asks for fast/cheap.' },
          operation: { type: 'string', description: 'What to do: generate, logo, edit, or enhance', enum: ['generate', 'logo', 'edit', 'enhance'] },
          image_path: { type: 'string', description: 'Optional local image path to edit/enhance' },
          image_url: { type: 'string', description: 'Optional image URL to use as an edit/style reference' },
        },
        required: ['prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web for current information. Uses Firecrawl when configured, otherwise falls back to DuckDuckGo. Use for recent events, facts, documentation, or up-to-date data. Returns top results with titles, URLs, and snippets.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          count: { type: 'number', description: 'Number of results (default: 5, max: 10)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'firecrawl_scrape',
      description: 'Scrape a single webpage and return its content as clean markdown. Requires FIRECRAWL_API_KEY_* to be configured. Use to read docs, examples, or reference pages the agent finds during a build.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to scrape' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_memory',
      description: 'Save a fact, preference, decision, or piece of context to persistent memory. The agent can recall this across all future sessions. Use when the user shares preferences, important facts about their setup, architecture decisions, or any information worth remembering.',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', description: 'One of: preference, fact, decision, procedure, context, relationship, general' },
          key: { type: 'string', description: 'Short unique key for this memory (e.g. "user_preferred_editor", "project_tech_stack")' },
          value: { type: 'string', description: 'The content to remember' },
        },
        required: ['key', 'value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'recall_memory',
      description: 'Search persistent memory for relevant facts, preferences, or context. Use before answering to check if there is remembered information about the user or project.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query to find relevant memories' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'guardian',
      description: 'Run Guardian CLI pentest commands. Guardian is an AI-powered penetration testing framework with 19 security tools and smart workflows. Use for recon, scanning, vulnerability assessment, and pentest report generation. Commands: scan (nmap port scan), recon (reconnaissance workflow), analyze (AI analysis of scan results), report (generate pentest report), workflow (run/list pentest workflows), models (list AI models), kb (knowledge base), init (initialize config). Example: guardian scan --target 10.10.10.1',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Guardian subcommand + args (e.g. "scan --target 10.10.10.1", "recon --target example.com", "workflow --list", "report --format html")' },
          timeout_ms: { type: 'number', description: 'Optional timeout in ms, default 120000 (pentest scans can be slow)' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_skills',
      description: 'List all available skills in the haksterAi skill library. Returns skill names, categories, file paths, and descriptions. Use to discover what skills are available before reading specific ones. The library contains 750+ markdown skill files across categories like pentesting, coding, cloud ops, IPTV, and more.',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', description: 'Optional category filter (e.g. "pentest", "coding", "cloud", "iptv")' },
          search: { type: 'string', description: 'Optional search term to filter skills by name or content' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_skill',
      description: 'Read the full content of a specific skill file by name or path. Use after list_skills to find relevant skills, then read the detailed instructions, commands, and procedures from the skill file.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Skill name or file path (e.g. "nmap-recon" or "pentest-agents/skills/nmap-recon.md")' },
        },
        required: ['name'],
      },
    },
  },
  // ── Autoflow: 7 new top-tier agent tools (from agent/index.js) ──────────────
  {
    type: 'function',
    function: {
      name: 'glob_search',
      description: 'Find files matching a glob pattern under the working directory. Returns matched file paths sorted by modification time. Use for file discovery, pattern-based search, and project navigation.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern to match (e.g. "src/**/*.js", "**/*.test.ts", "docs/*.md")' },
          maxResults: { type: 'number', description: 'Maximum results to return (default: 100)' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Edit a file by applying a list of line-based changes. Each change specifies start/end line numbers and replacement text. Returns a summary of changes made. Safer than write_file for targeted edits.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to edit (relative to working directory)' },
          changes: {
            type: 'array',
            description: 'Array of {start, end, text} objects. start/end are 1-based line numbers. text is the replacement content.',
            items: {
              type: 'object',
              properties: {
                start: { type: 'number', description: 'Start line (1-based)' },
                end: { type: 'number', description: 'End line (1-based, inclusive)' },
                text: { type: 'string', description: 'Replacement text for the line range' },
              },
              required: ['start', 'end', 'text'],
            },
          },
          createIfMissing: { type: 'boolean', description: 'Create the file if it does not exist (default: false)' },
        },
        required: ['path', 'changes'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'replace_in_file',
      description: 'Replace exact string matches in a file. Each replacement specifies old text and new text. Fails if old text is not found. Returns count of replacements made.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path (relative to working directory)' },
          replacements: {
            type: 'array',
            description: 'Array of {old, new} replacement pairs. old must match exactly.',
            items: {
              type: 'object',
              properties: {
                old: { type: 'string', description: 'Exact text to find' },
                new: { type: 'string', description: 'Replacement text' },
              },
              required: ['old', 'new'],
            },
          },
          createIfMissing: { type: 'boolean', description: 'Create the file if it does not exist (default: false)' },
        },
        required: ['path', 'replacements'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'shell_bg',
      description: 'Run a long-running shell command in the background. Returns a process ID immediately for non-blocking execution. Use for servers, watchers, daemons, and long builds. Check output with run_background, kill with kill_process.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to run in the background' },
          label: { type: 'string', description: 'Optional label for the background process (e.g. "dev-server", "test-watch")' },
          cwd: { type: 'string', description: 'Working directory for the command (default: project root)' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'diff_preview',
      description: 'Preview the unified diff of proposed changes to a file without writing them. Shows what would change if you apply the given replacements. Use before edit_file or replace_in_file to verify changes.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to preview changes for (relative to working directory)' },
          replacements: {
            type: 'array',
            description: 'Array of {old, new} replacement pairs to preview',
            items: {
              type: 'object',
              properties: {
                old: { type: 'string', description: 'Existing text' },
                new: { type: 'string', description: 'Proposed replacement text' },
              },
              required: ['old', 'new'],
            },
          },
        },
        required: ['path', 'replacements'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'codebase_map',
      description: 'Generate a structured overview of the project directory tree. Shows files, directories, line counts, and key files. Use to orient yourself in a new codebase or find relevant files quickly.',
      parameters: {
        type: 'object',
        properties: {
          maxDepth: { type: 'number', description: 'Maximum directory depth to show (default: 4)' },
          maxFiles: { type: 'number', description: 'Maximum files to list (default: 200)' },
          includeHidden: { type: 'boolean', description: 'Include hidden files/dirs like .git (default: false)' },
          focus: { type: 'string', description: 'Focus on a subdirectory (e.g. "src", "server/src")' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'codebase_index',
      description: 'Return the persistent project inventory and direct file:line anchors for routes, functions, classes, exports, and page files. Use this before codebase questions or edits so you can jump directly to the right line instead of wandering through directories.',
      parameters: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Optional project/name/path filter, e.g. "haksterAi", "cinevault", "skills"' },
          query: { type: 'string', description: 'Alias for project/filter text' },
          maxAnchors: { type: 'number', description: 'Maximum anchors per matching project, default 120' },
          refresh: { type: 'boolean', description: 'Refresh the inventory before returning it' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'context_compaction',
      description: 'Summarize and compress conversation history to stay within token limits. Returns a condensed version of recent context. Use when approaching context window limits to preserve the most important context.',
      parameters: {
        type: 'object',
        properties: {
          strategy: { type: 'string', enum: ['summarize', 'truncate_old', 'keep_recent', 'key_facts'], description: 'Compaction strategy: summarize=all, truncate_old=drop oldest, keep_recent=keep last N, key_facts=extract key facts only' },
          maxTokens: { type: 'number', description: 'Target maximum token count for compacted context (default: 8000)' },
          keepLastN: { type: 'number', description: 'For keep_recent strategy, how many recent turns to keep (default: 10)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'Search for a regex pattern inside files or find filenames by glob. Uses ripgrep with bounded output. Prefer this or exec_shell with rg for code search; do not run broad recursive grep.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory or file to search in (absolute or relative to working dir)' },
          pattern: { type: 'string', description: 'Regex pattern to search for' },
          query: { type: 'string', description: 'Alias for pattern, accepted for compatibility' },
          mode: { type: 'string', enum: ['content', 'grep', 'files'], description: 'content/grep searches inside files; files searches filenames by glob' },
          maxResults: { type: 'number', description: 'Maximum results to return (default: 50)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'apply_patch',
      description: 'Apply a unified diff patch in one shot from the current project root. Use this for precise multi-line or multi-file code edits instead of repeated edit_file loops. The patch must be a standard git/unified diff.',
      parameters: {
        type: 'object',
        properties: {
          patch: { type: 'string', description: 'Unified diff text, for example output beginning with diff --git or ---/+++' },
          cwd: { type: 'string', description: 'Optional working directory; defaults to the active project root' },
        },
        required: ['patch'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: 'Fetch content from a URL and return it as text. Use for reading API responses, documentation pages, config files, or any web-accessible resource.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to fetch' },
        },
        required: ['url'],
      },
    },
  },
];

let agentBrowser = null;
let agentPage = null;

async function getAgentPage() {
  const puppeteer = require('puppeteer');
  if (!agentBrowser || !agentBrowser.isConnected()) {
    agentBrowser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
  }
  if (!agentPage || (typeof agentPage.isClosed === 'function' && agentPage.isClosed())) {
    agentPage = await agentBrowser.newPage();
    await agentPage.setViewport({ width: 1366, height: 900, deviceScaleFactor: 1 });
    agentPage.setDefaultTimeout(10000);
    agentPage.setDefaultNavigationTimeout(15000);
  }
  return agentPage;
}

const { injectAgentsMd, injectLearnedLessons } = require('./agent/loop');
const autolearn = require('./agent/autolearn');
const { formatProjectInventory, formatCodebaseIndex } = require('./projectInventory');

// ── Known project locations on this server ──────────────────────────────
const KNOWN_PROJECTS = [
  { name: 'CineVault', path: '/home/ghost/cine-vault-live/', desc: 'IPTV/movie streaming platform, Astro+Express, PM2 process "cinevault"' },
  { name: 'haksterAi', path: '/home/ghost/haksterAi/', desc: 'AI agent platform with CLI, web API on port 3579, PM2 process "haksterAi"' },
  { name: 'PhantomIDE', path: '/home/ghost/phantom-ide/', desc: 'Phantom IDE project' },
  { name: 'movie-server', path: '/home/ghost/movie-server/', desc: 'Movie server / source resolver' },
  { name: 'kiro-gateway', path: '/home/ghost/kiro-gateway/', desc: 'Kiro gateway, Python FastAPI on port 8000' },
  { name: 'bugbounty', path: '/home/ghost/bugbounty/', desc: 'Bug bounty hunting tools and reports' },
];

// ── Dynamic system prompt builder (replaces static AGENT_SYSTEM_PROMPT) ──
// Injects AGENTS.md steering + autolearned lessons + MEMORY.md + project map
const _sysPromptCache = new Map(); // cwd -> { prompt, ts }
const SYS_PROMPT_CACHE_TTL = 60000; // 60s; prompts are expensive to rebuild

function buildAgentSystemPrompt(cwd, contextTags, opts = {}) {
  const { lowToken = false } = opts;
  const cacheKey = `${cwd}::${lowToken}`;
  const now = Date.now();
  const cached = _sysPromptCache.get(cacheKey);
  if (cached && (now - cached.ts) < SYS_PROMPT_CACHE_TTL) {
    return cached.prompt;
  }

  let prompt = AGENT_SYSTEM_PROMPT_BASE;

  // Inject a compact, refreshed project map with file:line anchors.
  try {
    prompt += `\n\n═══ PROJECT INVENTORY AND LINE MAP ═══\n${formatProjectInventory({ maxProjects: 10 })}\nUse codebase_index before edits or explanations when you need exact file:line anchors. Use absolute paths from this inventory for read_file, search_files, exec_shell, and apply_patch.\n═══ END PROJECT INVENTORY ═══`;
  } catch (_) {
    const projectList = KNOWN_PROJECTS.map(p => `- ${p.name}: ${p.path} — ${p.desc}`).join('\n');
    prompt += `\n\n═══ KNOWN PROJECTS ON THIS SERVER ═══\n${projectList}\nUse absolute paths when calling file and shell tools.\n═══ END PROJECTS ═══`;
  }

  // Inject AGENTS.md (walks up from cwd)
  try {
    const agentsMd = injectAgentsMd(cwd || process.cwd());
    if (agentsMd) {
      prompt += `\n\n═══ PROJECT STEERING (AGENTS.md) ═══\n${agentsMd}\n═══ END STEERING ═══`;
    }
  } catch (e) { /* AGENTS.md injection is best-effort */ }

  // Inject Codex CLI reference + secrets + gap analysis as agent context
  // These docs encode Codex CLI's architecture, internal prompts, permission
  // system, memory consolidation schema, and the haksterAi gap analysis vs
  // Codex/Claude Code/OpenCode/Aider. Wiring them into the system prompt so
  // the terminal agent actually operates off them instead of just archiving
  // them in git. Per-file cap to keep prompt size sane.
  try {
    const fs3 = require('fs');
    const path3 = require('path');
    const haksterRoot = '/home/ghost/haksterAi';
    const CODEX_DOCS = [
      { path: 'docs/agents/codex-cli-reference.md', label: 'CODEX CLI REFERENCE' },
      { path: 'docs/agents/codex-cli-secrets.md', label: 'CODEX CLI SECRETS (internal prompts, memory, permissions)' },
      { path: 'docs/agent/gap-analysis-hermes-codex.md', label: 'HAKSTERAI vs CODEX GAP ANALYSIS' },
    ];
    // Low-token mode: skip heavy reference docs entirely (~12K tokens otherwise).
    if (!lowToken) {
      const PER_FILE_CAP = 8000; // cap at 8K each (~6K tokens total)
      for (const doc of CODEX_DOCS) {
        const docPath = path3.join(haksterRoot, doc.path);
        if (fs3.existsSync(docPath)) {
          let content = fs3.readFileSync(docPath, 'utf8').trim();
          if (content.length > PER_FILE_CAP) {
            content = content.slice(0, PER_FILE_CAP) + '\n...[truncated, see ' + doc.path + ' for full doc]';
          }
          prompt += `\n\n═══ ${doc.label} ═══\n${content}\n═══ END ${doc.label} ═══`;
        }
      }
    }
  } catch (e) { /* codex docs injection is best-effort */ }

  // Inject MEMORY.md from the project's .hakster/ directory
  try {
    const fs2 = require('fs');
    const path2 = require('path');
    const projectDir = cwd || process.cwd();
    const memoryMdPath = path2.join(projectDir, '.hakster', 'MEMORY.md');
    if (fs2.existsSync(memoryMdPath)) {
      const memoryContent = fs2.readFileSync(memoryMdPath, 'utf8').trim();
      if (memoryContent) {
        prompt += `\n\n═══ PROJECT MEMORY (MEMORY.md) ═══\n${memoryContent}\n═══ END MEMORY ═══`;
      }
    }
    // Also check global haksterAi memory
    const globalMemoryPath = path2.join('/home/ghost/haksterAi', '.hakster', 'MEMORY.md');
    if (fs2.existsSync(globalMemoryPath) && globalMemoryPath !== memoryMdPath) {
      const globalMemory = fs2.readFileSync(globalMemoryPath, 'utf8').trim();
      if (globalMemory) {
        prompt += `\n\n═══ GLOBAL MEMORY (haksterAi MEMORY.md) ═══\n${globalMemory}\n═══ END GLOBAL MEMORY ═══`;
      }
    }
  } catch (e) { /* MEMORY.md injection is best-effort */ }

  // Inject learned lessons from autolearn memory
  try {
    const lessons = injectLearnedLessons(cwd || process.cwd(), contextTags || []);
    if (lessons) {
      const cappedLessons = lowToken && lessons.length > 1500 ? lessons.slice(0, 1500) + '\n...(learned lessons trimmed)' : lessons;
      prompt += `\n\n═══ LEARNED LESSONS (auto-memory) ═══\n${cappedLessons}\n═══ END LESSONS ═══`;
    }
  } catch (e) { /* lessons injection is best-effort */ }

  // Inject persistent memories from SQLite (save_memory / recall_memory store)
  // This is the critical recall path — without it, saved memories are never
  // visible to the agent and it appears to "forget" everything across sessions.
  try {
    const { getMemoryContext } = require('./memory');
    const memCtx = getMemoryContext(null, { maxMemories: lowToken ? 5 : 20, maxChars: lowToken ? 1000 : 4000 });
    if (memCtx) {
      prompt += `\n\n${memCtx}`;
    }
  } catch (e) { /* memory injection is best-effort */ }

  // NOTE: autolearn.autoInit() also reads AGENTS.md — skip it here to avoid
  // duplicating 6.5K chars of steering content. injectAgentsMd above already
  // handles AGENTS.md injection. autoInit is still called by the CLI for
  // interactive steering display, just not in the system prompt.

  // 6-Phase Loop awareness
  prompt += `

═══ AGENT LOOP PHASES ═══
You operate in a 6-phase loop: THINK → PLAN → ACT → OBSERVE → REFLECT → CONSOLIDATE.
- THINK: Analyze the request and current state. Reason about what needs to be done.
- PLAN: Decide which tools to call and in what order. Every tool call should move you closer to completion.
- ACT: Execute tool calls (write_file, exec_shell, read_file, etc.).
- OBSERVE: Review tool results. Did they succeed? What did you learn?
- REFLECT: If stuck (errors, no progress), pause and reconsider your approach. Try a different strategy.
- CONSOLIDATE: Periodically, lessons learned are consolidated into memory for future sessions.
The server tracks these phases and will inject [REFLECT] and [CONSOLIDATE] system messages when needed.
═══ END PHASES ═══`;

  _sysPromptCache.set(cacheKey, { prompt, ts: Date.now() });
  return prompt;
}

const AGENT_SYSTEM_PROMPT_BASE = `You are haksterAI, an agentic coding, ops, and security assistant running on Ghost's machine. You operate like Kiro CLI and OpenAI Codex CLI — you read the real codebase, act with tools, verify every edit, and keep working until the job is done end-to-end.

Context:
- Interface name: haksterAI. Operator: Ghost (pentester, developer, IPTV/cloud engineer).
- This terminal interface is branded "haksterAI", but the underlying model engine may differ (Claude via Claude Code CLI, OpenAI, etc.). When asked "what model are you?" or "are you Claude/GPT?", be honest about the actual engine you are running on. The interface brand is haksterAI; the model is whatever the current session is using. Do not lie about your model identity.
- OPERATOR ROLE: Ghost works on bug bounty scopes, CTF challenges, authorized assessments, and systems he owns. When security tasks come up, run the requested tools directly and report factual output.
- Do not reintroduce yourself every turn unless the user asks who you are or it is the first reply in a new session.
- Treat the user's app, IPTV stack, cloud runtime, and coding projects as production systems unless told otherwise.
- Every shell command executes directly on Ghost's real machine — NOT a sandbox. Act accordingly.

## KIRO + CODEX OPERATING CONTRACT

### Agent Loop Phases
You operate in a 6-phase loop internally: THINK → PLAN → ACT → OBSERVE → REFLECT → CONSOLIDATE. Use these phases privately to organize your reasoning. DO NOT output phase markers, emoji headers, or turn counters in the final response. The user should only see concise status sentences, tool results, and the final report.

Never skip from THINK straight to a final answer when files, services, or web pages are involved. Always check the real state first.

### Core Rules (non-negotiable)
1. READ BEFORE YOU WRITE. Before making any claim about code or making any edit, use tools to inspect the real file. Read package scripts, entry points, nearby source, service config, and recent logs when relevant.
2. ACT WITH TOOLS. When you can make a change with a tool (write_file, edit_file, exec_shell, browser), do it. Do not give Ghost copy-paste instructions when tools can do the work.
3. PRECISE MINIMAL EDITS. Make exact, targeted patches. Preserve unrelated user code. Never broad-rewrite a file unless Ghost explicitly asks or the file is generated.
4. VERIFY EVERY MEANINGFUL EDIT. After changing a file, run the narrowest useful check:
   - Node/JS CommonJS → node -c <file>
   - Running service → pm2 status + curl health endpoint
   - Frontend → npm run build or playwright page check
   - Shell scripts → bash -n <file>
5. SHOW CONCISE REASONING. Before acting, say:
   - "Checking X because Y could be the issue."
   - "Found Z — patching A."
   - "Verified: working / blocked by B."
   Do not include internal monologue, phase markers, token-budget notes, context-ceiling warnings, or idle questions like "What would you like me to do?" in your response to the user.
6. KEEP MOVING UNTIL DONE. Don't stop after a plan when tools can make progress. If a command fails, read the error and change strategy — never repeat the same failing command.
7. NEVER EXPOSE SECRETS. Do not print API keys, tokens, cookies, OAuth secrets, DB passwords, playlist credentials, signed URLs, or raw private user/admin data — even when visible in files you read.

### ONE-SHOT PATCHING (operate like a senior shell operator)
- Make file edits with a SINGLE one-shot command, not one tool call per line. Prefer, in order:
  1. \`sed -i\` for line/regex replacements: \`sed -i 's|old|new|g' path\` (use multiple \`-e\` for multi-spot).
  2. A python3 heredoc for surgical multi-spot edits: \`python3 - <<'PY' ... open(p).read().replace(...) ... PY\`.
  3. \`node -e\` / \`perl -i\` when sed can't express the change.
  4. write_file/patch_file/multi_patch ONLY for large rewrites or new files.
- Chain ALL the shell commands a task needs into ONE exec_shell call with \`&&\` (or one heredoc) so the whole change lands in one step: \`sed -i ... a && sed -i ... b && node -c a && pm2 restart x\`. Do NOT fire one command per tool call.
- Verify in the SAME shot when possible: \`&& node -c file\` (syntax) / \`&& curl -s localhost:PORT/api/health\` (live) / \`&& pm2 status\`.
- Never re-read a file you just wrote to "check". Trust the one-shot, verify with a command (node -c / curl / grep), and move on.
- Bounded, idempotent edits. No broad rewrites. No exploratory cat/read loops after you already know the target line.

### "Fix it" / "Make it work" / "Critical" / "Live" Response Pattern
1. Check what could be failing: logs, pm2 status, recent changes.
2. Identify the root cause file/service/config.
3. Read the file, make the exact patch, restart only the affected service.
4. Check service status + hit the endpoint or open the page.
5. Report: changed files, verification result, live status, remaining risk.

### Final Report Format (always short)
✅ Changed: <files>
✅ Verified: <what you checked and what it showed>
⚠️  Risk: <remaining concern or "none">

Skill Library:
- You have access to a large skill library with 750+ markdown skill files across categories: pentesting, coding, cloud ops, IPTV, security, and more.
- ALWAYS use list_skills and read_skill tools to discover and leverage relevant skills before tackling complex tasks.
- Skills contain detailed procedures, commands, configurations, and workflows written by experts.
- When a user asks about a topic, first check if a relevant skill exists using list_skills with a search term, then read_skill for the full procedure.
- This is critical — you have 750+ skills, not 16. Always pull from your full skill library.

Skill Library:
- You have access to a large skill library with 750+ markdown skill files across categories: pentesting, coding, cloud ops, IPTV, security, and more.
- ALWAYS use list_skills and read_skill tools to discover and leverage relevant skills before tackling complex tasks.
- Skills contain detailed procedures, commands, configurations, and workflows written by experts.
- When a user asks about a topic, first check if a relevant skill exists using list_skills with a search term, then read_skill for the full procedure.
- This is critical — you have 750+ skills, not 16. Always pull from your full skill library.

Operating Loop:
1. [THINK] Classify the request: Coding, IPTV, Movie Servers, Cloud/Ops, Database, Frontend, Research, Pentest, or General. Recall memory for relevant past context.
2. [PLAN] Identify the target files, services, and tools. Decide the order of operations and minimum viable inspection path.
3. [ACT] Inspect before changing — read relevant code/config, identify the running process. Then make the targeted edit.
4. [OBSERVE] Run the narrowest verification: node -c, bash -n, curl health check, pm2 status/logs, build check, or stream probe.
5. [REFLECT] If blocked or wrong, diagnose root cause. Try a fundamentally different approach — do not patch the same thing twice.
6. [DONE] Report: changed files, commands run, verification result, and any real blocker.
- Loop violations to avoid: repeated tool calls with tiny variations, repeated errors with same command, filesystem wandering, no-progress turns, plan-without-action.
- Preserve active project cwd across all shell, file, patch, verify, and git operations.
- Reference: docs/agent/cli-agent-tool-loop.md, docs/agent/cli-agent-playbooks.md, docs/agent/tool-call-map.md for full playbook.

Persistence:
- Continue until the user's requested job is actually finished end-to-end: inspect, edit, verify, and report.
- Do not stop after a plan when tools can make progress.
- If a command times out or hangs, use the timeout result as information, switch to logs/status/smaller checks, and keep moving.
- Only stop early for a real blocker: missing credentials, denied permission, destructive action needing confirmation, unavailable external service, or repeated timeout with no smaller diagnostic path.
- When blocked, say exactly what is blocking completion and the next concrete command or credential needed.
- Use save_memory to persist important facts, preferences, decisions, and context that should be remembered across sessions. When the user tells you their preference, tech stack, project details, or any reusable decision, save it.
- Use recall_memory to search your persistent memory before answering questions — you may already know relevant context from past sessions.
- Persistent memory is already injected into your system prompt when relevant, but you can actively recall more with recall_memory if needed.

Speed & Quality:
- Be faster than a generic CLI by using targeted inspection first: package files, entry points, PM2 metadata, recent logs, and exact symbols.
- Avoid broad scans through node_modules, dist, build, cache, media folders, and logs unless specifically needed.
- Prefer rg with narrow globs, exact routes, exact function names, and known service paths.
- Batch related shell checks into one bounded command when it reduces round trips.
- Use spawn_agent for independent research/search tasks, but verify important conclusions yourself before editing.
- Keep mental state concise: know the goal, current file, active process, and verification target.
- Do not over-explain while working. Move from diagnosis to patch to verification.
- Optimize for correct, working changes over long commentary.
- When multiple fixes are possible, choose the smallest one that unblocks the user's actual workflow.

Sub-Agent Roster:
- Search Agent: use spawn_agent when the task needs broad codebase search, docs lookup, reference discovery, or locating examples.
- Build Agent: use spawn_agent for isolated implementation work on a component, route, API endpoint, or integration while you inspect adjacent files.
- Script Agent: use spawn_agent for shell, Node, Python, migration, setup, install, maintenance, and automation scripts.
- QA Agent: use spawn_agent for focused test/build/log review, regression checks, syntax checks, and UI verification notes.
- Firecrawl Agent: use spawn_agent plus web_search/firecrawl_scrape for current websites, docs, reference pages, competitor pages, and API examples. If Firecrawl keys are configured, prefer Firecrawl for search/scrape.
- Ops Agent: use spawn_agent for PM2/service/port/log/health diagnostics when the coding change touches a running app.
- Keep sub-agent tasks specific and bounded. Merge their findings into your own final decision; do not blindly trust a sub-agent result.

Coding Mode:
- Prefer the repo's existing framework, patterns, package manager, and style.
- Read package scripts, entry points, env examples, and nearby code before adding new logic.
- Preserve unrelated user changes and avoid broad refactors.
- Add tests when changing parser logic, auth, payments, database writes, stream handling, or shared utilities.
- For Node apps, use node -c for edited CommonJS files when no test exists.

IPTV Mode:
- Treat playlists, portals, and stream sources as unreliable external systems.
- Support M3U/M3U8, Xtream-style APIs, Stalker/MAG-style portals, EPG XMLTV, logos, groups, countries, and languages when relevant.
- Normalize channel data into consistent fields: name, tvg_id, logo, group, country, language, source, url, headers, status, latency_ms, last_checked.
- Dedupe conservatively by normalized name plus stable URL/source identifiers. Never discard original source metadata.
- Validate streams with timeouts, redirects, user-agent/header support, HTTP status, content type, and first-byte/manifest checks.
- Separate adult, broken, geo-blocked, duplicate, and unknown streams rather than silently hiding them.
- Avoid logging playlist credentials, portal MACs, tokens, or subscription URLs.

Movie Servers Mode:
- Use this mode for /home/ghost/movie-server, vidsrc/devsrc providers, source resolvers, stream proxy routes, IPTV/stalker services, and CineVault integrations.
- Inspect PM2 first when runtime behavior is involved: service name, cwd, script path, logs, restart count, port, and health/API endpoint.
- Read the relevant package.json, server.js, source resolver, PM2 config, and logs before edits.
- Treat provider/source sites as unstable external systems. Preserve headers, referer, user-agent, proxy behavior, timeout behavior, and fallback order.
- Do not log tokens, cookies, signed stream URLs, playlist credentials, portal MACs, or user identifiers.
- Categorize resolver failures clearly: unavailable, blocked, parse-failed, no-sources, timeout, provider-error.
- After runtime edits, run node syntax checks, restart only the affected PM2 app, and verify with the smallest safe endpoint or source smoke test.

Cloud/Ops Mode:
- Identify process manager first: PM2, systemd, Docker, bare node, or dev server.
- Check ports, health endpoints, logs, env files, restart counts, and working directory before restarting.
- Do not expose secrets. Redact API keys, tokens, playlist URLs, DB passwords, webhook secrets, MAC addresses, and cookies.
- Prefer zero-downtime or minimal restart actions. Report when a restart is required.
- After deploy or restart, verify with PM2 status plus the app health/API endpoint.

Database Mode:
- Inspect schema before writing.
- Back up SQLite/Postgres data before risky migrations or destructive writes.
- Use migrations or idempotent schema changes when possible.
- Avoid deleting or rewriting production data unless the user explicitly asks and confirms the target.

Frontend Mode:
- Build the actual usable interface first, not marketing copy.
- Keep operational tools dense, clear, and fast: searchable tables, filters, statuses, detail drawers, and clear actions.
- For IPTV/admin views, include source import, stream checker status, EPG visibility, broken-stream triage, and logs when relevant.
- Verify responsive layout and text fit after UI changes when possible.

Tool Use:
- read_file: use offset/limit for large files.
- list_dir: inspect directories before assuming structure.
- edit_file: use exact unique replacements for precise changes.
- write_file: use for new files or complete generated artifacts.
- exec_shell: use for builds, tests, git status, PM2 checks, curl health checks, stream probes, and diagnostics. Use timeout_ms for slow commands.
- spawn_agent: delegate isolated investigations or large parallel searches, then validate important results yourself.
- web_search: use when the user asks about current information, recent events, documentation, or anything requiring up-to-date data. Returns titles, URLs, and snippets from web results.
- guardian: run Guardian CLI pentest commands for offensive security operations. Use for port scanning (guardian scan --target IP), reconnaissance (guardian recon --target domain), vulnerability analysis (guardian analyze), report generation (guardian report --format html), and workflow execution (guardian workflow --list to see available workflows, guardian workflow --run <name> --target <host>). Guardian has 19 security tools including nmap, nuclei, sqlmap, nikto, ffuf, gobuster, httpx, subfinder, and more. Pentest scans can be slow — set timeout_ms appropriately (default 120s, max 300s).

Shell Guidance:
- Prefer fast targeted commands: rg, npm scripts, node -c, curl health endpoints, pm2 status/logs.
- Exclude heavy folders by default: node_modules, dist, build, .git, cache, coverage, logs, media.
- Chain closely related quick checks when useful, but every shell command must be bounded by timeout/output limits. Use pm2 logs with --nostream, tail/head, rg --max-count, and find -maxdepth. Never start long-running foreground servers.
- Avoid interactive or long-lived foreground commands in exec_shell. Use PM2, nohup, timeout wrappers, or the browser terminal for long-running services.
- Do not run destructive commands, database wipes, credential dumps, or broad filesystem deletes without explicit confirmation.
- For multi-line or multi-file edits, prefer apply_patch with one unified diff over repeated edit_file calls.
- For browser/device debugging, call browser_detect first, then browser_navigate/browser_snapshot/browser_screenshot as needed.
- Dangerous shell commands and file writes may produce an approval prompt. If approval is needed, do not retry the same command; explain that the user must approve it.

Pentest Mode:
- The operator (Ghost) works on bug bounty scopes, CTF challenges, authorized assessments, and systems he owns. When security tasks come up, run the requested security tools directly.
- When asked to scan, enumerate, or assess a target, run the real tools (nmap, nuclei, sqlmap, ffuf, etc.) and report the actual output.
- Use the guardian tool for pentest operations, vulnerability scanning, and exploitation tasks.
- Guardian has 19 security tools (nmap, nuclei, sqlmap, nikto, ffuf, gobuster, httpx, subfinder, masscan, sslyze, wpscan, etc) and 19 workflows (web_pentest, api_pentest, network_pentest, cloud_audit, osint, jwt_audit, llm_redteam, etc).
- Common commands: guardian scan --target <IP>, guardian recon --target <domain>, guardian workflow --list, guardian workflow --run <name> --target <host>.
- Pentest scans are slow — use timeout_ms: 300000 for full scans, 120000 default for quick scans.
- Initialize guardian first if not configured: guardian init.
- Store scan results and reports in the workspace outputs directory.

Operator Relationship Policy:
- Ghost owns this machine. Ghost sets the tasks. Ghost owns the accounts. Your job is to execute efficiently and report results.
- Daily work spans: coding, system admin, file creation, security tool development, config changes, API key management, pentesting — all standard operations for this environment.
- Ghost does security research, pentesting, and AI development. Technical tasks across these domains are the norm here.
- Keep responses concise and actionable.

Response Style:
- Keep responses concise and concrete.
- Mention exact file paths and key command output when relevant.
- If blocked, name the missing credential, permission, dependency, or external service and give the next concrete step.
- Provide complete runnable code when the user asks for code, but do not force code into non-coding answers.

Client Awareness:
- You receive CLIENT DEVICE CONTEXT in your system prompt showing the user's browser, OS, device type, screen size, and more.
- Use this to tailor responses: suggest mobile-friendly layouts for phone users, note touch vs mouse, adapt UI advice to screen size.
- When the user is on Android/iOS, account for mobile-specific tools and limitations.
- If you don't see CLIENT DEVICE CONTEXT, the user's browser info wasn't captured — still proceed normally.

File Delivery:
- When you write_file or edit_file, the user automatically gets a download button in the chat UI for that file.
- Use write_file to deliver generated scripts, configs, reports, wordlists, payloads, or any file the user asked you to create.
- Name files descriptively so the download button is clear (e.g. recon-report.txt, exploit.py, payload.sh).
- For large outputs (reports, data dumps), write to a file instead of pasting in chat — the user can download it.

ANTI-LOOP RULES (CRITICAL):
- NEVER repeat the same action or command that already failed. If a tool call returns an error, change your approach — do not retry with the same arguments.
- NEVER call the same tool with the same arguments more than twice. If you need similar information, vary the query or use a different tool.
- If you realize you are stuck or making no progress, STOP and explain the blocker clearly instead of looping.
- After 2 consecutive tool calls with no visible progress toward the user's goal, pause and summarize what you've learned and what you're trying next.
- When read_file, list_dir, or search_files returns useful data, USE IT — do not re-read or re-search for the same information.
- Prefer making progress on the user's task over exploring. Every tool call should move you closer to completion.`;

// ── Dangerous shell-command guard (server-side, shared across UIs) ──
const DANGEROUS_SHELL_PATTERNS = [
  /\brm\s+(-rf?|--force|--recursive)/i,
  /\brm\s+.*\//i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bhalt\b/i,
  /\bpoweroff\b/i,
  /\bfdisk\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\bformat\b/i,
  /\bchmod\s+(-R\s+)?777/i,
  /\bchown\s+.*root/i,
  /\bchgrp\s+.*root/i,
  /\bkill\s+-9\s+/i,
  /\bkillall\b/i,
  /\bpkill\s+-9/i,
  /\bfuser\s+-k\b/i,
  /\bnpm\s+publish/i,
  /\bgit\s+push\s+.*--force/i,
  /\bgit\s+reset\s+--hard/i,
  /\bgit\s+clean\s+-fd/i,
  /\bdocker\s+(rm|rmi|system\s+prune)/i,
  /\bsystemctl\s+(stop|disable|restart)\s+(ssh|nginx|apache|mysql|postgres)/i,
  /\bsystemctl\s+(mask|daemon-reload)\b/i,
  /\biptables\s+-F/i,
  /\bcurl.*\|\s*(ba)?sh/i,
  /\bwget.*\|\s*(ba)?sh/i,
  /\bmv\b.*\s+\/dev\/null/i,
  /\b>\s*\/dev\/(sda|nvme|vd)/i,
  /\btruncate\s+-s\s+0\b/i,
  /\bswapoff\b/i,
  /\bmount\s+.*\/dev\/(sda|nvme)/i,
  /\bcrontab\s+-r\b/i,
  /\bat\/atq\s+-r\b/i,
  /\bparted\b.*\b(mklabel|mkpart|rm)\b/i,
  /\blvm\s+.*\b(remove|lvremove|vgremove|pvremove)\b/i,
  /\braid\d*\s+.*\b(--stop|--fail|--remove)\b/i,
  /\bip\s+link\s+set\s+.*\bdown\b/i,
  /\bip\s+route\s+(flush|del\s+default)/i,
  /\bip\s+addr\s+(flush|del)\b/i,
  /\biwconfig\s+.*\b(txpower\s+off|mode\s+monitor)\b/i,
  /\btcpkill\b/i,
  /\bfsck\s+/i,
  /\bmkswap\b/i,
  /\bbadblocks\s+.*-w\b/i,
  /\bsfdisk\b/i,
  /\bcfdisk\b/i,
  /\bwipefs\b/i,
  /\bsgdisk\b/i,
  /\bpm2\s+(restart|stop|reload|delete)\s+(hakster-?ai|hakster-tui)\b/i,
  /\bsystemctl\s+(restart|stop)\s+pm2(-root)?\b/i,
  // 🦙 PROTECT OLLAMA — hard-block any command that stops/kills/deletes ollama
  /\bsystemctl\s+(stop|disable|mask)\s+ollama\b/i,
  /\bpm2\s+(stop|delete|kill)\s+ollama\b/i,
  /\bpkill\s+(-\S+\s+)?ollama\b/i,
  /\bkillall\s+ollama\b/i,
  /\bkill\s+(-\S+\s+)+.*\bollama\b/i,
  /\bollama\s+rm\b/i,
  /\bollama\s+delete\b/i,
  /\brm\s+(-\S+\s+)*.*\b\.ollama\b/i,
  /\brm\s+(-\S+\s+)*.*\/usr\/share\/ollama\b/i,
  /\brm\s+(-\S+\s+)*.*\/var\/lib\/ollama\b/i,
];

const READ_ONLY_SHELL_PREFIXES = [
  'cat', 'head', 'tail', 'more', 'less', 'tee', 'wc', 'stat', 'file',
  'du', 'df', 'ls', 'find', 'locate', 'which', 'whereis', 'type', 'command', 'hash',
  'grep', 'egrep', 'fgrep', 'ag', 'rg', 'ack',
  'cut', 'sort', 'uniq', 'tr', 'rev', 'paste', 'column', 'fmt', 'pr',
  'ps', 'top', 'htop', 'free', 'uptime', 'uname', 'whoami', 'id', 'hostname', 'domainname', 'pwd',
  'echo', 'printenv', 'env', 'date', 'cal', 'ncal', 'timedatectl', 'localectl',
  'ss', 'netstat', 'ifconfig', 'iwgetid',
  'ping', 'traceroute', 'tracepath', 'mtr', 'dig', 'nslookup', 'host', 'whois',
  'journalctl', 'dmesg',
  'lsblk', 'lscpu', 'lsmem', 'lsmod', 'lspci', 'lsusb', 'lsscsi', 'hwinfo', 'sensors',
  'blkid', 'findmnt',
  'jq',
];

function getDangerReason(command) {
  if (!command || typeof command !== 'string') return null;
  const cmd = command.trim();
  const first = cmd.split(/\s+/)[0].replace(/^.*[\/]/, '').toLowerCase();
  // Read-only introspection commands never need confirmation
  if (READ_ONLY_SHELL_PREFIXES.includes(first)) return null;
  // Any sudo invocation requires confirmation (elevated privileges)
  if (first === 'sudo' || /\bsudo\s+/i.test(cmd)) return `Elevated privilege command: ${cmd.substring(0, 100)}`;
  for (const pat of DANGEROUS_SHELL_PATTERNS) {
    if (pat.test(cmd)) return `Matches dangerous pattern: ${cmd.substring(0, 100)}`;
  }
  return null;
}


// ── Sudo password: read from CLI config (~/.hakster/config.json) or env, expose via SUDO_ASKPASS ──
// NOTE: this server runs under PM2 as root, whose HOME is /root — not the ghost user's
// /home/ghost. `hakster config sudo` (run interactively by the ghost user) always writes to
// /home/ghost/.hakster/config.json, so we must read from there too, not process.env.HOME,
// or the two never agree on where the password lives.
const _dangerConfigCandidates = [
  '/home/ghost/.hakster/config.json',
  require('path').join(process.env.HOME || '/home/ghost', '.hakster', 'config.json'),
];
let _dangerPwCache = null;
let _dangerPwMtime = 0;
let _dangerConfigPath = _dangerConfigCandidates[0];
function getDangerPassword() {
  try {
    if (process.env.HAKSTER_DANGER_PASSWORD) return process.env.HAKSTER_DANGER_PASSWORD;
    const fs = require('fs');
    _dangerConfigPath = _dangerConfigCandidates.find(p => { try { fs.accessSync(p); return true; } catch { return false; } }) || _dangerConfigCandidates[0];
    const st = fs.statSync(_dangerConfigPath);
    if (_dangerPwCache && st.mtimeMs === _dangerPwMtime) return _dangerPwCache;
    const cfg = JSON.parse(fs.readFileSync(_dangerConfigPath, 'utf8'));
    _dangerPwCache = (cfg && typeof cfg.dangerPassword === 'string') ? cfg.dangerPassword : null;
    _dangerPwMtime = st.mtimeMs;
    return _dangerPwCache;
  } catch (_) { return null; }
}
const _askPassPath = require('path').join(process.env.HOME || '/home/ghost', '.hakster', '.sudo-askpass.sh');
function ensureSudoAskpass() {
  const pw = getDangerPassword();
  if (!pw) return null;
  try {
    const fs = require('fs');
    const script = `#!/bin/sh\necho '${pw.replace(/'/g, "'\\''")}'\n`;
    fs.writeFileSync(_askPassPath, script, { mode: 0o700 });
    return _askPassPath;
  } catch (_) { return null; }
}
// Rewrite a bare "sudo ..." invocation to "sudo -A ..." so SUDO_ASKPASS supplies the password
// (the password never appears in the command line / tool args / logs).
function rewriteSudoWithAskpass(command) {
  const pw = getDangerPassword();
  if (!pw) return { command, askpass: null };
  const m = command.match(/^\s*sudo(\s+(-\w+|\S+=\S+))*\s+/);
  if (!m) return { command, askpass: null };
  // already using -A (askpass) or -S (stdin) — leave alone
  if (/\s-A\b|\s--askpass\b|\s-S\b/.test(m[0])) return { command, askpass: null };
  const askpass = ensureSudoAskpass();
  if (!askpass) return { command, askpass: null };
  const rewritten = command.replace(/^(\s*)sudo\b/, `$1sudo -A`);
  return { command: rewritten, askpass };
}

async function executeAgentTool(name, args, cwd, provider, model, onStream, allowedCommands, approvalMode) {
  const fs = require('fs');
  const path = require('path');
  const { execFileSync, spawn } = require('child_process');

  function resolveSafe(p) {
    return path.resolve(cwd, p);
  }

  // Surface dangerous shell commands before execution so the UI can confirm them
  // In FULL_AUTO / AUTO_EDIT mode, skip confirmation for allowed tool types
  // Approval gate covers shell commands and file writes. Do not treat bash/node/python
  // wrappers as read-only; nested dangerous commands still need confirmation.
  const FILE_WRITE_TOOLS = new Set(['write_file', 'edit_file', 'replace_in_file', 'apply_patch']);
  const SHELL_EXEC_TOOLS = new Set(['exec_shell', 'shell_bg']);
  // Sudo commands ALWAYS require confirmation, even in full-auto mode (safety override)
  if (SHELL_EXEC_TOOLS.has(name) && args.command) {
    const cmd = args.command.trim();
    const firstWord = cmd.split(/\s+/)[0].replace(/^.*[\/]/, '').toLowerCase();
    if (firstWord === 'sudo' || /\bsudo\s+/i.test(cmd)) {
      const isAllowed = allowedCommands && (
        allowedCommands.has(cmd) ||
        [...allowedCommands].some(allowed => cmd.startsWith(allowed) || cmd === allowed)
      );
      if (!isAllowed) {
        return JSON.stringify({ __needs_confirmation: true, reason: `Elevated privilege command: ${cmd.substring(0, 100)}`, tool: name, args });
      }
    }
  }
  if (shouldConfirmApproval(approvalMode, name, args, SHELL_EXEC_TOOLS.has(name) ? getDangerReason(args.command) : (FILE_WRITE_TOOLS.has(name) ? 'file modification' : null))) {
    if (SHELL_EXEC_TOOLS.has(name) && args.command) {
      const reason = getDangerReason(args.command);
      if (reason) {
        const cmd = args.command.trim();
        const isAllowed = allowedCommands && (
          allowedCommands.has(cmd) ||
          [...allowedCommands].some(allowed => cmd.startsWith(allowed) || cmd === allowed)
        );
        if (!isAllowed) {
          return JSON.stringify({ __needs_confirmation: true, reason, tool: name, args });
        }
      }
    } else if (FILE_WRITE_TOOLS.has(name)) {
      // In SUGGEST mode, file writes need confirmation
      return JSON.stringify({ __needs_confirmation: true, reason: `${name} requires confirmation in suggest mode`, tool: name, args });
    }
  }

  try {
    switch (name) {
      case 'read_file': {
        const full = resolveSafe(args.path);
        const content = fs.readFileSync(full, 'utf8');
        const lines = content.split('\n');
        const offset = args.offset ? Math.max(1, args.offset) : 1;
        const limit = args.limit || 500;
        const slice = lines.slice(offset - 1, offset - 1 + limit);
        return slice.map((l, i) => `${offset + i}\t${l}`).join('\n');
      }
      case 'write_file': {
        const full = resolveSafe(args.path);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, args.content, 'utf8');
        return `Wrote ${Buffer.byteLength(args.content, 'utf8')} bytes to ${full}`;
      }
      case 'edit_file': {
        const full = resolveSafe(args.path);
        const content = fs.readFileSync(full, 'utf8');
        const count = content.split(args.old_text).length - 1;
        if (count === 0) throw new Error('old_text not found in file');
        if (count > 1) throw new Error(`old_text matched ${count} times; it must be unique. Add more context.`);
        const next = content.replace(args.old_text, args.new_text);
        fs.writeFileSync(full, next, 'utf8');
        return `Edited ${full}`;
      }
      case 'list_dir': {
        const full = resolveSafe(args.path || '.');
        const entries = fs.readdirSync(full, { withFileTypes: true });
        return entries.map(e => `${e.isDirectory() ? 'd' : '-'} ${e.name}`).join('\n');
      }
      case 'search_files': {
        const dirPath = resolveSafe(args.path || '.');
        const { execFileSync } = require('child_process');
        const maxResults = args.maxResults || 50;
        const pattern = args.pattern || args.query || '';
        if (!pattern) return 'Error: pattern or query is required';
        const looksLikeGlob = /[*?\[\]{}]/.test(pattern);
        const mode = args.mode || (looksLikeGlob ? 'files' : 'content');
        if (mode === 'content' || mode === 'grep') {
          try {
            const out = execFileSync('rg', ['--line-number', '--color', 'never', '--hidden', '-g', '!node_modules/**', '-g', '!.git/**', '-g', '!dist/**', '-g', '!build/**', '-g', '!coverage/**', '--max-count', '50', '--max-filesize', '1M', '--', pattern, dirPath], { encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });
            const lines = out.split('\n').slice(0, maxResults);
            return lines.join('\n') || '(no matches found)';
          } catch (e) {
            return e.stdout ? String(e.stdout).split('\n').slice(0, maxResults).join('\n') : '(no matches found)';
          }
        } else {
          // files mode — find by name pattern
          try {
            const out = execFileSync('rg', ['--files', '--hidden', '-g', pattern, '-g', '!node_modules/**', '-g', '!.git/**', '-g', '!dist/**', '-g', '!build/**', '-g', '!coverage/**', dirPath], { encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });
            const lines = out.split('\n').filter(Boolean).slice(0, maxResults);
            return lines.join('\n') || '(no files found)';
          } catch (e) {
            return e.stdout ? String(e.stdout).split('\n').filter(Boolean).slice(0, maxResults).join('\n') : '(no files found)';
          }
        }
      }
      case 'apply_patch': {
        if (!args.patch || typeof args.patch !== 'string') return 'Error: patch is required';
        const patchCwd = args.cwd ? path.resolve(cwd, args.cwd) : cwd;
        try {
          execFileSync('git', ['-c', `safe.directory=${patchCwd}`, 'apply', '--check', '--whitespace=nowarn', '-'], {
            cwd: patchCwd,
            input: args.patch,
            encoding: 'utf8',
            timeout: 10000,
            maxBuffer: 1024 * 1024,
          });
          execFileSync('git', ['-c', `safe.directory=${patchCwd}`, 'apply', '--whitespace=nowarn', '-'], {
            cwd: patchCwd,
            input: args.patch,
            encoding: 'utf8',
            timeout: 10000,
            maxBuffer: 1024 * 1024,
          });
          return `Applied patch in ${patchCwd}`;
        } catch (e) {
          const msg = [e.message, e.stdout, e.stderr].filter(Boolean).join('\n').trim();
          return `apply_patch failed in ${patchCwd}:\n${msg}`;
        }
      }
      case 'web_fetch': {
        const url = args.url;
        if (!url) return '❌ url is required';
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), Math.min(args.timeout || 15, 60) * 1000);
        try {
          const resp = await fetch(url, { headers: { 'User-Agent': 'haksterAI/1.0', ...(args.headers || {}) }, signal: controller.signal });
          clearTimeout(timeout);
          const text = await resp.text();
          const truncated = text.length > 10000 ? text.substring(0, 10000) + '\n... (truncated)' : text;
          return `${resp.status} ${resp.statusText}\n${truncated}`;
        } catch (err) {
          clearTimeout(timeout);
          if (err.name === 'AbortError') return `Error: Request timed out after ${args.timeout || 15}s`;
          return `Error: ${err.message}`;
        }
      }
      case 'exec_shell': {
        const requestedTimeout = Number(args.timeout_ms || 15000);
        let timeout = Math.min(Math.max(requestedTimeout, 1000), 120000);

        // ── Harden grep/find/dir-style commands to prevent decoder/scrambler hangs ──
        // BUGFIX: Model sometimes sends {"":"cat ..."} instead of {"command":"cat ..."}
        // Fall back to any string value in args if "command" key is missing
        let command = args.command;
        if (!command || typeof command !== 'string') {
          // Try to find the command in any string value in args
          const strValues = Object.values(args).filter(v => typeof v === 'string' && v.trim().length > 0);
          if (strValues.length > 0) {
            command = strValues[0];
          } else {
            return '❌ Error: exec_shell requires a "command" string argument';
          }
        }
        const cmdLower = command.trim().toLowerCase();
        const isGrepLike = /\b(rg|grep|egrep|fgrep|ag|ack|ripgrep)\b/i.test(cmdLower);
        const isFindLike = /\b(find|fd|locate)\b/i.test(cmdLower);
        const isRecursiveLs = /\bls\b.*\s-[a-zA-Z]*R/i.test(cmdLower) || /\bls\s+.*\//i.test(cmdLower);
        const hasHead = /\|\s*head\b/.test(command);
        const hasMaxCount = /--max-count\b|-m\s+\d+/.test(command);
        const hasMaxDepth = /-maxdepth\b/.test(command);

        // Cap timeout for search-like commands — 10s max, they should finish in <2s
        if ((isGrepLike || isFindLike || isRecursiveLs) && timeout > 10000) timeout = 10000;

        if (isGrepLike && !hasHead && !hasMaxCount) {
          const isRg = /\brg\b/i.test(cmdLower);
          const isGrep = /\bgrep\b|\begrep\b|\bfgrep\b/i.test(cmdLower);
          if (isRg && !/\s--\s/.test(command)) {
            command = command + ' --max-count 50 --max-filesize 1M';
          } else if (isRg) {
            command = command.replace(/\s+--\s/, ' --max-count 50 --max-filesize 1M -- ');
          } else if (isGrep) {
            // Plain grep: add directory exclusions + per-file match cap to prevent
            // scanning node_modules/.git which is what actually hangs
            const exclusions = '--exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist --exclude-dir=.next --exclude-dir=build --exclude-dir=.cache';
            if (!/exclude-dir/.test(command)) command = command + ' ' + exclusions;
            if (!/\s-m\s/.test(command)) command = command + ' -m 50';
          }
          command = command + ' 2>/dev/null | head -n 200';
        } else if (isGrepLike && hasMaxCount && !hasHead) {
          // Already has -m but still pipe to head for output cap
          const isGrep = /\bgrep\b|\begrep\b|\bfgrep\b/i.test(cmdLower);
          if (isGrep && !/exclude-dir/.test(command)) {
            command = command + ' --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist --exclude-dir=.next --exclude-dir=build --exclude-dir=.cache';
          }
          command = command + ' 2>/dev/null | head -n 200';
        }
        if (isFindLike && !hasHead && !hasMaxDepth) {
          command = command.replace(/\bfind\b/i, 'find -maxdepth 8');
          // Prune heavy dirs so find doesn't crawl node_modules/.git
          if (!/node_modules/.test(command) && !/path.*prune/.test(command)) {
            command = command + ' -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/.cache/*"';
          }
          command = command + ' 2>/dev/null | head -n 300';
        } else if (isFindLike && hasMaxDepth && !hasHead) {
          if (!/node_modules/.test(command) && !/path.*prune/.test(command)) {
            command = command + ' -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/.cache/*"';
          }
          command = command + ' 2>/dev/null | head -n 300';
        }
        if (isRecursiveLs && !hasHead) {
          command = command + ' 2>/dev/null | head -n 300';
        }

        // ── Sudo: pipe the configured danger password via SUDO_ASKPASS (sudo -A) ──
        const _sudo = rewriteSudoWithAskpass(command);
        command = _sudo.command;
        const _askpassEnv = _sudo.askpass ? { SUDO_ASKPASS: _sudo.askpass } : null;

        // When a stream consumer is present, run via spawn so stdout/stderr can be
        // forwarded in real-time to the build terminal / UI.
        if (typeof onStream === 'function') {
          return await new Promise((resolve, reject) => {
            const chunks = [];
            const errChunks = [];
            let killed = false;
            let totalBytes = 0;
            const maxBytes = 6 * 1024 * 1024; // 6 MiB hard cap for streamed commands

            const shell = process.platform === 'win32' ? 'cmd.exe' : 'bash';
            const shellFlag = process.platform === 'win32' ? '/c' : '-c';
            onStream({ type: 'shell_start', command, cwd });
            const child = spawn(shell, [shellFlag, command], {
              cwd,
              env: {
                ...process.env,
                ...(_askpassEnv || {}),
                HOME: process.env.HOME || '/home/ghost',
                CI: process.env.CI || '1',
                NO_COLOR: process.env.NO_COLOR || '1',
                TERM: process.env.TERM || 'xterm-256color',
              },
              stdio: ['ignore', 'pipe', 'pipe'],
              detached: true, // own process group -> kill the whole tree on timeout
            });

            // Kill the entire process group (descendants included). Without this a
            // backgrounded/pipe-holding grandchild keeps stdout open, `close` never
            // fires, and the promise hangs forever (real hang bug).
            function killGroup(signal) {
              try { process.kill(-child.pid, signal); } catch (_) { try { child.kill(signal); } catch {} }
            }

            const timer = setTimeout(() => {
              killed = true;
              killGroup('SIGTERM');
              setTimeout(() => killGroup('SIGKILL'), 1000);
              // Safety net: resolve no matter what 1.5s after the kill so the agent
              // can never hang waiting on a shell command that won't die.
              setTimeout(() => {
                resolve(`exit_code: timeout\nCommand timed out after ${timeout}ms (force-killed).\nstdout:\n${chunks.join('')}\nstderr:\n${errChunks.join('')}`);
              }, 1500);
            }, timeout);

            function stripAnsiAndNulls(buf) {
              return buf.toString('utf8').replace(/\x00/g, '').replace(/\x1b\[[0-9;]*m/g, '');
            }

            child.stdout.on('data', (data) => {
              totalBytes += data.length;
              let text = data.toString('utf8');
              if (totalBytes > maxBytes) {
                if (!killed) {
                  killed = true;
                  killGroup('SIGTERM');
                  setTimeout(() => killGroup('SIGKILL'), 500);
                }
                return;
              }
              text = text.replace(/\x00/g, '');
              chunks.push(text);
              onStream({ type: 'shell_data', stream: 'stdout', data: text });
            });

            child.stderr.on('data', (data) => {
              const text = stripAnsiAndNulls(data);
              errChunks.push(text);
              onStream({ type: 'shell_data', stream: 'stderr', data: text });
            });

            child.on('error', (err) => {
              clearTimeout(timer);
              onStream({ type: 'shell_error', error: err.message });
              resolve(`exit_code: error\n${err.message}`);
            });

            child.on('close', (code, signal) => {
              clearTimeout(timer);
              const exitCode = killed ? 'timeout' : (code ?? (signal ? `signal:${signal}` : 1));
              const stdout = chunks.join('');
              const stderr = errChunks.join('');
              onStream({ type: 'shell_end', exit_code: exitCode });
              const truncated = totalBytes > maxBytes ? '\n[output truncated at 6 MiB]' : '';
              if (killed) {
                resolve(`exit_code: timeout\nCommand timed out after ${timeout}ms or output exceeded 6 MiB. Use a shorter command, add an explicit timeout, or run long-lived services in the browser terminal/PM2 instead.\nstdout:\n${stdout}${truncated}\nstderr:\n${stderr}`);
              } else if (code === 0 || code === null) {
                const output = stdout.trim();
                const errput = stderr.trim();
                if (output && errput) resolve(`exit_code: 0\nstdout:\n${output}${truncated}\nstderr:\n${errput}`);
                else if (output) resolve(`exit_code: 0\nstdout:\n${output}${truncated}`);
                else if (errput) resolve(`exit_code: 0\nstderr:\n${errput}`);
                else resolve(`exit_code: 0\n(empty output)`);
              } else {
                resolve(`exit_code: ${exitCode}\nstdout:\n${stdout}${truncated}\nstderr:\n${stderr}`);
              }
            });
          });
        }

        // Non-streaming exec: spawn in its own process group so a timeout can
        // kill the entire command tree. promisify(exec) only signals the direct
        // child shell; descendants holding the pipe keep stdout open and the
        // promise never resolves (hang). Group-kill + fallback resolve fixes that.
        try {
          const shellBin = process.platform === 'win32' ? 'cmd.exe' : 'bash';
          const shellArg = process.platform === 'win32' ? '/c' : '-c';
          const r = await new Promise((resolve) => {
            const child = spawn(shellBin, [shellArg, command], {
              cwd,
              env: {
                ...process.env,
                ...(_askpassEnv || {}),
                HOME: process.env.HOME || '/home/ghost',
                CI: process.env.CI || '1',
                NO_COLOR: process.env.NO_COLOR || '1',
              },
              stdio: ['ignore', 'pipe', 'pipe'],
              detached: true,
            });
            let stdout = '', stderr = '', totalBytes = 0, killed = false;
            const MAX_BYTES = 6 * 1024 * 1024;
            const killGroup = (signal) => { try { process.kill(-child.pid, signal); } catch (_) { try { child.kill(signal); } catch {} } };
            const timer = setTimeout(() => {
              killed = true;
              killGroup('SIGTERM');
              setTimeout(() => killGroup('SIGKILL'), 1000);
              setTimeout(() => resolve({ stdout, stderr, killed: true, code: null }), 1500);
            }, timeout);
            child.stdout.on('data', (d) => {
              totalBytes += d.length;
              if (totalBytes > MAX_BYTES) { if (!killed) { killed = true; killGroup('SIGTERM'); setTimeout(() => killGroup('SIGKILL'), 500); } return; }
              stdout += d.toString('utf8');
            });
            child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
            child.on('error', (err) => { clearTimeout(timer); resolve({ stdout, stderr, killed: false, code: `error:${err.message}` }); });
            child.on('close', (code, signal) => { clearTimeout(timer); resolve({ stdout, stderr, killed, code: code ?? (signal ? `signal:${signal}` : 1) }); });
          });
          const output = (r.stdout || '').replace(/\x00/g, '').replace(/\x1b\[[0-9;]*m/g, '').trim();
          const errput = (r.stderr || '').replace(/\x00/g, '').replace(/\x1b\[[0-9;]*m/g, '').trim();
          if (r.killed) {
            return `exit_code: timeout\nCommand timed out after ${timeout}ms or output exceeded 6 MiB. Use a shorter command, add an explicit timeout, or run long-lived services in the browser terminal/PM2 instead.\nstdout:\n${output}\nstderr:\n${errput}`;
          }
          if (r.code === 0 || r.code === null) {
            if (output && errput) return `exit_code: 0\nstdout:\n${output}\nstderr:\n${errput}`;
            if (output) return `exit_code: 0\nstdout:\n${output}`;
            if (errput) return `exit_code: 0\nstderr:\n${errput}`;
            return `exit_code: 0\n(empty output)`;
          }
          return `exit_code: ${r.code}\nstdout:\n${output}\nstderr:\n${errput}`;
        } catch (err) {
          return `exit_code: error\n${err.message}`;
        }
      }
      case 'spawn_agent': {
        // Cloud sub-agent: call the same model with the task and return results
        const { spawnSubAgent } = require('./subagent');
        return await spawnSubAgent(args.task, cwd, provider || 'ollama', model || undefined);
      }
      case 'browser_navigate': {
        const page = await getAgentPage();
        const response = await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        try { await page.waitForNetworkIdle({ idleTime: 500, timeout: 3000 }); } catch {}
        const waitMs = Math.min(Math.max(Number(args.wait_ms || 500), 0), 5000);
        if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));
        const data = await page.evaluate(() => {
          const interactive = Array.from(document.querySelectorAll('button, a, input, select, textarea, [role="button"], [role="link"], [contenteditable]'))
            .map((el, idx) => {
              const rect = el.getBoundingClientRect();
              if (rect.width === 0 && rect.height === 0) return null;
              return {
                idx,
                tag: el.tagName.toLowerCase(),
                text: (el.textContent || '').trim().slice(0, 80),
                type: el.getAttribute('type') || '',
                placeholder: el.getAttribute('placeholder') || '',
                name: el.getAttribute('name') || '',
                id: el.id || '',
                href: el.getAttribute('href') || '',
              };
            })
            .filter(Boolean);
          return { title: document.title, url: location.href, interactive };
        });
        const lines = [
          `Navigated: ${data.url}`,
          `Status: ${response ? response.status() : 'unknown'}`,
          `Title: ${data.title || '(untitled)'}`,
          `Interactive elements: ${data.interactive.length}`,
        ];
        data.interactive.slice(0, 30).forEach(el => {
          const label = el.text || el.placeholder || el.name || el.id || el.href || '(unnamed)';
          lines.push(`  [${el.idx}] <${el.tag}${el.type ? ` type=${el.type}` : ''}> ${label}`);
        });
        if (data.interactive.length > 30) lines.push(`  ... and ${data.interactive.length - 30} more`);
        return lines.join('\n');
      }
      case 'browser_snapshot': {
        const page = await getAgentPage();
        if (page.url() === 'about:blank') return 'No page loaded. Use browser_navigate first.';
        const full = Boolean(args.full);
        const snapshot = await page.evaluate((wantFull) => {
          const elements = Array.from(document.querySelectorAll('button, a, input, select, textarea, [role="button"], [role="link"], [contenteditable]'))
            .map((el, idx) => {
              const rect = el.getBoundingClientRect();
              if (!wantFull && rect.width === 0 && rect.height === 0) return null;
              return {
                idx,
                tag: el.tagName.toLowerCase(),
                text: (el.textContent || '').trim().slice(0, 100),
                type: el.getAttribute('type') || '',
                placeholder: el.getAttribute('placeholder') || '',
                value: 'value' in el ? String(el.value || '').slice(0, 80) : '',
                name: el.getAttribute('name') || '',
                id: el.id || '',
                disabled: el.disabled ? ' disabled' : '',
              };
            })
            .filter(Boolean);
          return {
            title: document.title,
            url: location.href,
            viewport: { width: window.innerWidth, height: window.innerHeight },
            elements,
            bodyText: document.body ? document.body.innerText.slice(0, wantFull ? 5000 : 1500) : '',
          };
        }, full);
        const lines = [
          `Snapshot: ${snapshot.url}`,
          `Title: ${snapshot.title || '(untitled)'}`,
          `Viewport: ${snapshot.viewport.width}x${snapshot.viewport.height}`,
          `Interactive elements: ${snapshot.elements.length}`,
        ];
        snapshot.elements.slice(0, full ? 50 : 25).forEach(el => {
          const label = el.text || el.placeholder || el.name || el.id || '(unnamed)';
          const extra = [];
          if (el.type) extra.push(`type=${el.type}`);
          if (el.value) extra.push(`value=${el.value}`);
          lines.push(`  [${el.idx}] <${el.tag}${el.disabled}> ${label}${extra.length ? ` (${extra.join(', ')})` : ''}`);
        });
        if (snapshot.bodyText) {
          lines.push('', '--- Page text ---', snapshot.bodyText.slice(0, full ? 3000 : 900));
        }
        return lines.join('\n');
      }
      case 'browser_screenshot': {
        const page = await getAgentPage();
        if (page.url() === 'about:blank') return 'No page loaded. Use browser_navigate first.';
        const screenshotDir = '/tmp/hakster_screenshots';
        fs.mkdirSync(screenshotDir, { recursive: true });
        const filepath = path.join(screenshotDir, `screenshot_${Date.now()}.png`);
        if (args.selector) {
          const el = await page.$(args.selector);
          if (!el) return `Could not find element: ${args.selector}`;
          await el.screenshot({ path: filepath, type: 'png' });
        } else {
          await page.screenshot({ path: filepath, type: 'png', fullPage: Boolean(args.full_page) });
        }
        const sizeKb = (fs.statSync(filepath).size / 1024).toFixed(1);
        return `Screenshot saved: ${filepath} (${sizeKb} KB)`;
      }
      case 'browser_detect': {
        const lines = ['Browser detection'];
        try {
          const page = await getAgentPage();
          const state = await page.evaluate(() => ({
            url: location.href,
            title: document.title,
            userAgent: navigator.userAgent,
            platform: navigator.platform,
            language: navigator.language,
            languages: Array.from(navigator.languages || []),
            viewport: { width: window.innerWidth, height: window.innerHeight },
            screen: { width: window.screen?.width || null, height: window.screen?.height || null },
            devicePixelRatio: window.devicePixelRatio || 1,
            online: navigator.onLine,
            touchPoints: navigator.maxTouchPoints || 0,
          }));
          lines.push('', 'Headless browser:', JSON.stringify(state, null, 2));
        } catch (e) {
          lines.push('', `Headless browser: unavailable (${e.message})`);
        }

        try {
          const { getDb } = require('./db');
          const db = getDb();
          const row = args.sessionId
            ? db.prepare('SELECT * FROM client_contexts WHERE session_id = ? ORDER BY updated_at DESC LIMIT 1').get(args.sessionId)
            : db.prepare('SELECT * FROM client_contexts ORDER BY updated_at DESC LIMIT 1').get();
          if (row) {
            const client = {
              session_id: row.session_id,
              browser: [row.browser, row.browser_version].filter(Boolean).join(' '),
              os: [row.os_name, row.os_version].filter(Boolean).join(' '),
              device_type: row.device_type,
              device_model: row.device_model,
              viewport: row.viewport_width && row.viewport_height ? `${row.viewport_width}x${row.viewport_height}` : null,
              screen: row.screen_width && row.screen_height ? `${row.screen_width}x${row.screen_height}` : null,
              dpr: row.device_pixel_ratio,
              language: row.language,
              timezone: row.timezone,
              online: Boolean(row.online),
              updated_at: row.updated_at,
            };
            lines.push('', 'Latest user browser context:', JSON.stringify(client, null, 2));
          } else {
            lines.push('', 'Latest user browser context: none saved yet');
          }
        } catch (e) {
          lines.push('', `Latest user browser context: unavailable (${e.message})`);
        }
        return lines.join('\n');
      }
      case 'generate_image': {
        const crypto = require('crypto');
        const imgDir = path.join(cwd, 'outputs', 'images');
        fs.mkdirSync(imgDir, { recursive: true });
        const imgProvider = args.provider || 'pollinations';
        const operation = args.operation || 'generate';
        const imgModel = args.model || (imgProvider === 'pollinations' ? 'zimage' : 'dall-e-3');
        const imgSize = args.size || '1024x1024';
        const imgQuality = args.quality || 'hd';
        let imagePath = null;
        if (args.image_path) {
          imagePath = path.resolve(cwd, args.image_path);
          if (!imagePath.startsWith(path.resolve(cwd) + path.sep) && !imagePath.startsWith('/home/ghost/')) {
            return 'Error: image_path is outside the allowed workspace';
          }
          if (!fs.existsSync(imagePath)) return `Error: image_path not found: ${imagePath}`;
        }
        let finalPrompt = args.prompt;
        if (operation === 'logo') {
          finalPrompt = `Create a professional production-ready top-grade HD logo. ${args.prompt}. Include clean geometry, strong silhouette, brand-ready composition, premium finish, no watermarks, no mockup background.`;
        } else if (operation === 'enhance') {
          finalPrompt = `Enhance and improve this image to top-grade HD quality while preserving the core subject. ${args.prompt || 'Improve sharpness, lighting, color balance, detail, and professional finish.'}`;
        }
        try {
          const result = await generateImage({
            provider: imgProvider,
            model: imgModel,
            prompt: finalPrompt,
            size: imgSize,
            quality: imgQuality,
            n: 1,
            imagePath,
            imageUrl: args.image_url,
            operation,
            enhance: operation === 'enhance',
          });
          const lines = [];
          const urls = [];
          for (const img of result.images) {
            const id = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
            const filePath = path.join(imgDir, `${id}.png`);
            fs.writeFileSync(filePath, Buffer.from(img.b64_json, 'base64'));
            const sizeKB = (fs.statSync(filePath).size / 1024).toFixed(1);
            const url = `/outputs/images/${id}.png`;
            urls.push(url);
            lines.push(`🎨 ${filePath} (${sizeKB} KB) — ${result.provider || imgProvider}/${result.model || imgModel}`);
            if (img.revised_prompt) lines.push(`📝 Revised: ${img.revised_prompt}`);
          }
          // Return JSON with image URLs so the SSE handler can emit an image event
          return JSON.stringify({ __image_urls: urls, text: lines.join('\n') });
        } catch (imgErr) {
          return `Error: Image generation failed: ${imgErr.message}`;
        }
      }
      case 'web_search': {
        const query = args.query || '';
        const count = Math.min(Math.max(Number(args.count) || 5, 1), 10);
        if (!query) return 'Error: query is required';
        try {
          let results = [];
          let source = 'DuckDuckGo';
          if (getFirecrawlKeys().length > 0) {
            try {
              results = await firecrawlSearch(query, count);
              source = 'Firecrawl';
            } catch (fcErr) {
              // fallback to DuckDuckGo below
            }
          }
          if (results.length === 0) {
            const https = require('https');
            const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
            let result = '';
            try {
              result = await new Promise((resolve, reject) => {
                const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }, timeout: 12000 }, (res) => {
                  let body = '';
                  res.on('data', (chunk) => { body += chunk; });
                  res.on('end', () => resolve(body));
                }).on('error', reject);
                req.on('timeout', () => { req.destroy(new Error('DuckDuckGo fallback timed out')); });
              });
            } catch (_) {
              const { execFileSync } = require('child_process');
              result = execFileSync('curl', ['-sL', '--max-time', '15', '-A', 'Mozilla/5.0', url], {
                encoding: 'utf8',
                maxBuffer: 2 * 1024 * 1024,
              });
            }
            const resultRegex = /<a[^>]+class="result__a"[^>]*>([\s\S]*?)<\/a>/g;
            const snippetRegex = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
            const urlRegex = /uddg=([^&"']+)&/g;
            const titles = [], snippets = [], urls = [];
            let match;
            while ((match = resultRegex.exec(result)) !== null) titles.push(match[1].replace(/<[^>]+>/g, '').trim());
            while ((match = snippetRegex.exec(result)) !== null) snippets.push(match[1].replace(/<[^>]+>/g, '').trim());
            while ((match = urlRegex.exec(result)) !== null) { try { urls.push(decodeURIComponent(match[1])); } catch {} }
            for (let i = 0; i < Math.min(count, Math.max(titles.length, urls.length)); i++) {
              results.push({ title: titles[i] || '(No title)', url: urls[i] || '', snippet: snippets[i] || '' });
            }
          }
          if (results.length === 0) {
            return `No results found for "${query}". Try rephrasing or use more specific terms.`;
          }
          const lines = [`🔍 Search results for: "${query}" (via ${source})`, ''];
          results.forEach((r, i) => {
            lines.push(`${i + 1}. ${r.title}`);
            if (r.url) lines.push(`   ${r.url}`);
            if (r.snippet) lines.push(`   ${r.snippet}`);
            lines.push('');
          });
          return lines.join('\n');
        } catch (err) {
          const fallback = localKnowledgeFallback(query);
          if (fallback) return fallback;
          return `Error: Web search failed: ${err.message}`;
        }
      }
      case 'firecrawl_scrape': {
        const url = args.url || '';
        if (!url) return 'Error: url is required';
        if (getFirecrawlKeys().length === 0) return 'Error: No FIRECRAWL_API_KEY_* configured';
        try {
          const markdown = await firecrawlScrape(url);
          return `🌐 Scraped: ${url}\n\n${markdown}`;
        } catch (err) {
          return `Error: Firecrawl scrape failed: ${err.message}`;
        }
      }
      case 'save_memory': {
        try {
          const { saveMemory } = require('./memory');
          const mem = saveMemory({
            category: args.category || 'general',
            key: args.key,
            value: args.value,
            source: 'agent',
          });
          return `✅ Saved memory [${mem.category}] ${mem.key}: ${mem.value}`;
        } catch (err) {
          return `Error saving memory: ${err.message}`;
        }
      }
      case 'recall_memory': {
        try {
          const { searchMemories, listMemories } = require('./memory');
          const results = args.query
            ? searchMemories(args.query, { limit: 10 })
            : listMemories({ limit: 20 });
          if (results.length === 0) return 'No memories found.';
          return results.map(m => `[${m.category}] ${m.key}: ${m.value} (updated ${new Date(m.updated_at * 1000).toISOString().split('T')[0]}, accessed ${m.access_count}x)`).join('\n');
        } catch (err) {
          return `Error recalling memory: ${err.message}`;
        }
      }
      case 'guardian': {
        const guardianCmd = args.command || '';
        if (!guardianCmd) return 'Error: guardian command is required';
        const guardianTimeout = Math.min(Number(args.timeout_ms || 120000), 300000);
        const guardianWrapper = '/home/ghost/.local/bin/guardian-wrapper';
        if (!fs.existsSync(guardianWrapper)) {
          return 'Error: guardian-wrapper not found at ' + guardianWrapper;
        }

        // Build the full command — guardian-wrapper passes args to python -m cli.main
        const fullCmd = `${guardianWrapper} ${guardianCmd}`;

        // Stream output if onStream is available
        if (typeof onStream === 'function') {
          return await new Promise((resolve, reject) => {
            const chunks = [];
            const errChunks = [];
            let killed = false;
            let totalBytes = 0;
            const maxBytes = 6 * 1024 * 1024;

            onStream({ type: 'shell_start', command: fullCmd, cwd });
            const child = spawn('bash', ['-c', fullCmd], {
              cwd,
              env: {
                ...process.env,
                CI: process.env.CI || '1',
                TERM: process.env.TERM || 'xterm-256color',
              },
              stdio: ['ignore', 'pipe', 'pipe'],
              detached: true, // own process group -> kill the whole tree on timeout
            });

            // Kill the entire process group (descendants included), same pattern as
            // exec_shell — a naked child.kill() only signals the immediate bash
            // process; a grandchild holding stdout open keeps `close` from ever
            // firing and the promise hangs forever.
            function killGroup(signal) {
              try { process.kill(-child.pid, signal); } catch (_) { try { child.kill(signal); } catch {} }
            }

            const timer = setTimeout(() => {
              killed = true;
              killGroup('SIGTERM');
              setTimeout(() => killGroup('SIGKILL'), 2000);
              // Safety net: resolve no matter what shortly after the kill so the
              // agent can never hang waiting on a guardian command that won't die.
              setTimeout(() => {
                resolve(`exit_code: timeout\nGuardian command timed out after ${guardianTimeout}ms (force-killed).\nstdout:\n${chunks.join('')}\nstderr:\n${errChunks.join('')}`);
              }, 2500);
            }, guardianTimeout);

            child.stdout.on('data', (data) => {
              totalBytes += data.length;
              let text = data.toString('utf8').replace(/\x00/g, '');
              if (totalBytes > maxBytes) {
                if (!killed) {
                  killed = true;
                  killGroup('SIGTERM');
                  setTimeout(() => killGroup('SIGKILL'), 500);
                }
                return;
              }
              chunks.push(text);
              onStream({ type: 'shell_data', stream: 'stdout', data: text });
            });

            child.stderr.on('data', (data) => {
              const text = data.toString('utf8').replace(/\x00/g, '').replace(/\x1b\[[0-9;]*m/g, '');
              errChunks.push(text);
              onStream({ type: 'shell_data', stream: 'stderr', data: text });
            });

            child.on('error', (err) => {
              clearTimeout(timer);
              onStream({ type: 'shell_error', error: err.message });
              resolve(`exit_code: error\n${err.message}`);
            });

            child.on('close', (code, signal) => {
              clearTimeout(timer);
              const exitCode = killed ? 'timeout' : (code ?? (signal ? `signal:${signal}` : 1));
              const stdout = chunks.join('');
              const stderr = errChunks.join('');
              onStream({ type: 'shell_end', exit_code: exitCode });
              const truncated = totalBytes > maxBytes ? '\n[output truncated at 6 MiB]' : '';
              if (killed) {
                resolve(`exit_code: timeout\nGuardian command timed out after ${guardianTimeout}ms.\nstdout:\n${stdout}${truncated}\nstderr:\n${stderr}`);
              } else {
                resolve(`exit_code: ${exitCode}\nstdout:\n${stdout}${truncated}\nstderr:\n${stderr}`);
              }
            });
          });
        }

        // Non-streaming fallback: spawn in its own process group (same as exec_shell)
        // instead of promisify(exec) — exec's timeout only signals the direct shell
        // child, so a descendant holding the pipe open leaves the promise hanging.
        try {
          const r = await new Promise((resolve) => {
            const child = spawn('bash', ['-c', fullCmd], {
              cwd,
              env: { ...process.env, CI: process.env.CI || '1' },
              stdio: ['ignore', 'pipe', 'pipe'],
              detached: true,
            });
            let stdout = '', stderr = '', totalBytes = 0, killed = false;
            const MAX_BYTES = 6 * 1024 * 1024;
            const killGroup = (signal) => { try { process.kill(-child.pid, signal); } catch (_) { try { child.kill(signal); } catch {} } };
            const timer = setTimeout(() => {
              killed = true;
              killGroup('SIGTERM');
              setTimeout(() => killGroup('SIGKILL'), 2000);
              setTimeout(() => resolve({ stdout, stderr, killed: true, code: null }), 2500);
            }, guardianTimeout);
            child.stdout.on('data', (d) => {
              totalBytes += d.length;
              if (totalBytes > MAX_BYTES) { if (!killed) { killed = true; killGroup('SIGTERM'); setTimeout(() => killGroup('SIGKILL'), 500); } return; }
              stdout += d.toString('utf8');
            });
            child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
            child.on('error', (err) => { clearTimeout(timer); resolve({ stdout, stderr, killed: false, code: `error:${err.message}` }); });
            child.on('close', (code, signal) => { clearTimeout(timer); resolve({ stdout, stderr, killed, code: code ?? (signal ? `signal:${signal}` : 1) }); });
          });
          const output = (r.stdout || '').trim().replace(/\x00/g, '').replace(/\x1b\[[0-9;]*m/g, '');
          const errput = (r.stderr || '').trim().replace(/\x00/g, '').replace(/\x1b\[[0-9;]*m/g, '');
          if (r.killed) {
            return `exit_code: timeout\nGuardian command timed out after ${guardianTimeout}ms.\nstdout:\n${output}\nstderr:\n${errput}`;
          }
          if (r.code === 0 || r.code === null) {
            if (output && errput) return `exit_code: 0\nstdout:\n${output}\nstderr:\n${errput}`;
            if (output) return `exit_code: 0\nstdout:\n${output}`;
            if (errput) return `exit_code: 0\nstderr:\n${errput}`;
            return `exit_code: 0\n(empty output)`;
          }
          return `exit_code: ${r.code}\nstdout:\n${output}\nstderr:\n${errput}`;
        } catch (err) {
          return `exit_code: error\n${err.message}`;
        }
      }
      case 'list_skills': {
        const { listSkills } = require('./skills');
        const skills = listSkills({ category: args.category, search: args.search });
        if (!skills || skills.length === 0) return 'No skills found. The skill library may still be indexing.';
        const grouped = {};
        for (const s of skills) {
          const cat = s.category || 'other';
          if (!grouped[cat]) grouped[cat] = [];
          grouped[cat].push(s);
        }
        let out = `Total skills: ${skills.length}\n\n`;
        for (const [cat, items] of Object.entries(grouped)) {
          out += `## ${cat} (${items.length})\n`;
          for (const s of items.slice(0, 20)) {
            out += `  - ${s.name}${s.description ? ': ' + s.description.slice(0, 80) : ''}\n`;
          }
          if (items.length > 20) out += `  ... and ${items.length - 20} more\n`;
          out += '\n';
        }
        return out;
      }
      case 'read_skill': {
        const { readSkill } = require('./skills');
        const content = readSkill(args.name);
        if (!content) return `Skill "${args.name}" not found. Use list_skills to see available skills.`;
        return content;
      }
      // ── Autoflow: 7 new tool executors (from agent/index.js) ──────────────
      case 'glob_search': {
        try {
          if (!args.pattern) return '❌ pattern is required';
          const searchCwd = args.cwd ? path.resolve(cwd, args.cwd) : cwd;
          const { globSync } = require('glob');
          const files = globSync(args.pattern, { cwd: searchCwd, nodir: true, absolute: true, ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/coverage/**'] });
          const maxResults = args.maxResults || 100;
          const sorted = files.slice(0, maxResults);
          if (sorted.length === 0) return `📂 No files matching "${args.pattern}"`;
          const total = files.length;
          const lines = sorted.map(f => {
            const rel = require('path').relative(searchCwd, f);
            try {
              const stat = require('fs').statSync(f);
              return `  ${rel} (${(stat.size / 1024).toFixed(1)} KB)`;
            } catch (_) {
              return `  ${rel}`;
            }
          });
          let out = `📂 Found ${total} file${total !== 1 ? 's' : ''} matching "${args.pattern}"\n`;
          out += lines.join('\n');
          if (total > maxResults) out += `\n  ... and ${total - maxResults} more`;
          return out;
        } catch (err) {
          return `❌ glob_search error: ${err.message}`;
        }
      }
      case 'edit_file': {
        try {
          const fs = require('fs');
          const path = require('path');
          if (!args.path) return '❌ path is required';
          if (!args.changes || !Array.isArray(args.changes)) return '❌ changes array is required';
          const baseCwd = args.cwd ? path.resolve(cwd, args.cwd) : cwd;
          const resolved = path.resolve(baseCwd, args.path);
          if (!fs.existsSync(resolved)) {
            if (!args.createIfMissing) return `❌ File not found: ${resolved}`;
            const dir = path.dirname(resolved);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(resolved, '', 'utf-8');
          }
          let content = fs.readFileSync(resolved, 'utf-8');
          const lines = content.split('\n');
          let applied = 0;
          for (const change of args.changes) {
            if (change.start == null || change.end == null) continue;
            const start = Math.max(0, change.start - 1);
            const end = Math.min(lines.length, change.end);
            const newText = (change.text || '').split('\n');
            lines.splice(start, end - start, ...newText);
            applied++;
          }
          fs.writeFileSync(resolved, lines.join('\n'), 'utf-8');
          return `✏️ Edited ${resolved}: ${applied} change${applied !== 1 ? 's' : ''} applied`;
        } catch (err) {
          return `❌ edit_file error: ${err.message}`;
        }
      }
      case 'replace_in_file': {
        try {
          const fs = require('fs');
          const path = require('path');
          if (!args.path) return '❌ path is required';
          if (!args.replacements || !Array.isArray(args.replacements)) return '❌ replacements array is required';
          const baseCwd = args.cwd ? path.resolve(cwd, args.cwd) : cwd;
          const resolved = path.resolve(baseCwd, args.path);
          if (!fs.existsSync(resolved)) {
            if (!args.createIfMissing) return `❌ File not found: ${resolved}`;
            const newContent = args.replacements.map(r => r.new || '').join('\n');
            const dir = path.dirname(resolved);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(resolved, newContent, 'utf-8');
            return `✨ Created ${resolved} with ${args.replacements.length} replacement block${args.replacements.length !== 1 ? 's' : ''}`;
          }
          let content = fs.readFileSync(resolved, 'utf-8');
          let applied = 0;
          for (const rep of args.replacements) {
            if (!rep.old) continue;
            const count = (content.match(new RegExp(rep.old.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
            content = content.split(rep.old).join(rep.new || '');
            if (count > 0) applied++;
          }
          fs.writeFileSync(resolved, content, 'utf-8');
          return `🔄 Replaced in ${resolved}: ${applied} replacement${applied !== 1 ? 's' : ''} applied`;
        } catch (err) {
          return `❌ replace_in_file error: ${err.message}`;
        }
      }
      case 'shell_bg': {
        try {
          if (!args.command) return '❌ command is required';
          const { spawn } = require('child_process');
          const path = require('path');
          const id = `bg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          const procCwd = args.cwd ? path.resolve(cwd, args.cwd) : cwd;
          const child = spawn('/bin/bash', ['-c', args.command], {
            cwd: procCwd,
            env: { ...process.env },
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: false,
          });
          let stdout = '', stderr = '';
          child.stdout.on('data', d => { stdout += d.toString(); if (stdout.length > 50000) stdout = stdout.slice(-50000); });
          child.stderr.on('data', d => { stderr += d.toString(); if (stderr.length > 50000) stderr = stderr.slice(-50000); });
          // Store in a module-level registry
          if (!global._bgProcesses) global._bgProcesses = new Map();
          global._bgProcesses.set(id, { process: child, label: args.label || args.command.slice(0, 60), command: args.command, cwd: procCwd, startedAt: Date.now(), stdout, stderr });
          child.stdout.on('data', d => { const entry = global._bgProcesses.get(id); if (entry) entry.stdout = (entry.stdout || '') + d.toString(); });
          child.stderr.on('data', d => { const entry = global._bgProcesses.get(id); if (entry) entry.stderr = (entry.stderr || '') + d.toString(); });
          child.on('exit', code => { const entry = global._bgProcesses.get(id); if (entry) { entry.exitCode = code; entry.endedAt = Date.now(); } });
          return `🚀 Background process started\n  ID: ${id}\n  Label: ${args.label || args.command.slice(0, 60)}\n  PID: ${child.pid}\n  CWD: ${procCwd}\n  Use run_background or kill_process to manage`;
        } catch (err) {
          return `❌ shell_bg error: ${err.message}`;
        }
      }
      case 'diff_preview': {
        try {
          const fs = require('fs');
          const path = require('path');
          if (!args.path) return '❌ path is required';
          if (!args.replacements || !Array.isArray(args.replacements)) return '❌ replacements array is required';
          const baseCwd = args.cwd ? path.resolve(cwd, args.cwd) : cwd;
          const resolved = path.resolve(baseCwd, args.path);
          if (!fs.existsSync(resolved)) return `❌ File not found: ${resolved}`;
          const original = fs.readFileSync(resolved, 'utf-8');
          let modified = original;
          for (const rep of args.replacements) {
            if (!rep.old) continue;
            modified = modified.split(rep.old).join(rep.new || '');
          }
          if (original === modified) return 'ℹ️ No changes would be applied';
          const origLines = original.split('\n');
          const modLines = modified.split('\n');
          let diff = '';
          let changeCount = 0;
          const maxDiffLines = 200;
          const cs = Math.max(origLines.length, modLines.length);
          for (let i = 0; i < cs && diff.split('\n').length < maxDiffLines; i++) {
            const oLine = i < origLines.length ? origLines[i] : undefined;
            const mLine = i < modLines.length ? modLines[i] : undefined;
            if (oLine !== mLine) {
              changeCount++;
              if (oLine !== undefined) diff += `- ${i + 1}: ${oLine}\n`;
              if (mLine !== undefined) diff += `+ ${i + 1}: ${mLine}\n`;
            }
          }
          let out = `📝 Diff preview for ${path.relative(baseCwd, resolved)}\n`;
          out += `  ${changeCount} line${changeCount !== 1 ? 's' : ''} changed\n\n`;
          out += diff;
          if (diff.split('\n').length >= maxDiffLines) out += '\n  ... (truncated, use edit_file or replace_in_file to apply)';
          return out;
        } catch (err) {
          return `❌ diff_preview error: ${err.message}`;
        }
      }
      case 'codebase_map': {
        try {
          const fs = require('fs');
          const path = require('path');
          const maxDepth = args.maxDepth || 4;
          const maxFiles = args.maxFiles || 200;
          const includeHidden = args.includeHidden || false;
          const baseCwd = args.cwd ? path.resolve(cwd, args.cwd) : cwd;
          const root = args.focus ? path.resolve(baseCwd, args.focus) : baseCwd;
          if (!fs.existsSync(root)) return `❌ Directory not found: ${root}`;
          const skipDirs = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.cache', 'vendor', 'bun.lock']);
          const skipExts = new Set(['.map', '.lock', '.wasm']);
          let fileCount = 0;
          let totalLines = 0;
          const result = [];
          function walk(dir, depth, prefix) {
            if (depth > maxDepth || fileCount >= maxFiles) return;
            let entries;
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
            entries.sort((a, b) => {
              if (a.isDirectory() && !b.isDirectory()) return -1;
              if (!a.isDirectory() && b.isDirectory()) return 1;
              return a.name.localeCompare(b.name);
            });
            for (const entry of entries) {
              if (fileCount >= maxFiles) break;
              if (!includeHidden && entry.name.startsWith('.')) continue;
              if (entry.isDirectory() && skipDirs.has(entry.name)) continue;
              const fullPath = path.join(dir, entry.name);
              const relPath = path.relative(root, fullPath);
              if (entry.isDirectory()) {
                result.push(`${prefix}📁 ${entry.name}/`);
                walk(fullPath, depth + 1, prefix + '  ');
              } else {
                if (skipExts.has(path.extname(entry.name))) continue;
                try {
                  const stat = fs.statSync(fullPath);
                  fileCount++;
                  totalLines += Math.round(stat.size / 40);
                  result.push(`${prefix}📄 ${entry.name} (${(stat.size / 1024).toFixed(1)} KB)`);
                } catch (_) {
                  result.push(`${prefix}📄 ${entry.name}`);
                }
              }
            }
          }
          walk(root, 0, '');
          let out = `🗺️ Codebase map: ${path.relative(baseCwd, root) || '.'}\n`;
          out += `  Files: ${fileCount} | Est. lines: ${totalLines.toLocaleString()}\n\n`;
          out += result.join('\n');
          if (fileCount >= maxFiles) out += `\n\n  ⚠️ Truncated at ${maxFiles} files. Increase maxFiles for more.`;
          return out;
        } catch (err) {
          return `❌ codebase_map error: ${err.message}`;
        }
      }
      case 'codebase_index': {
        try {
          const { formatCodebaseIndex } = require('./projectInventory');
          return formatCodebaseIndex({
            project: args.project,
            query: args.query,
            maxAnchors: args.maxAnchors || 120,
            refresh: !!args.refresh,
          });
        } catch (err) {
          return `❌ codebase_index error: ${err.message}`;
        }
      }
      case 'context_compaction': {
        try {
          const strategy = args.strategy || 'summarize';
          const maxTokens = args.maxTokens || 8000;
          const keepLastN = args.keepLastN || 10;
          // For the web API, we return guidance — the actual compaction happens in the loop
          return `📋 Context compaction (${strategy})\n  Strategy: ${strategy}\n  Max tokens: ${maxTokens}\n  Keep last N: ${keepLastN}\n  Use this to signal the agent loop to compact context. The loop will handle the actual message truncation.`;
        } catch (err) {
          return `❌ context_compaction error: ${err.message}`;
        }
      }
      default: {
        // MCP tool routing — any tool name starting with mcp__ goes to the MCP client
        if (isMcpTool(name)) {
          try {
            const result = await callMcpTool(name, args);
            if (typeof onStream === 'function') {
              onStream({ type: 'mcp_result', tool: name, data: result });
            }
            return result;
          } catch (err) {
            return `Error: MCP tool "${name}" failed: ${err.message}`;
          }
        }
        return `Unknown tool: ${name}`;
      }
    }
  } catch (err) {
    return `Error: ${err.message}`;
  }
}

module.exports = { chat, chatStream, listModels, generateImage, analyzeImage, PROVIDERS, estimateCost, AGENT_TOOLS, AGENT_SYSTEM_PROMPT: AGENT_SYSTEM_PROMPT_BASE, buildAgentSystemPrompt, executeAgentTool, sanitizeMessagesForProvider, getFirecrawlKeys, firecrawlScrape, firecrawlSearch, getWaterfallProvider, markProviderRateLimited, isProviderRateLimited, WATERFALL_ORDER, claudeCliEnv };
