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
const crypto = require('crypto');
const { chat, chatStream, listModels, generateImage, analyzeImage, PROVIDERS, estimateCost, AGENT_TOOLS, AGENT_SYSTEM_PROMPT, buildAgentSystemPrompt, executeAgentTool, sanitizeMessagesForProvider, getFirecrawlKeys } = require('./providers');
const { loadMcpServers, getMcpTools, callMcpTool, isMcpTool, mcpStatus, shutdownMcp, setLogFn: mcpSetLogFn } = require('./agent/mcp');
// ── Autoflow: 6-phase loop + autolearn + approval modules ──
const { AgentLoopPhase, loopPhaseTransitions, LOOP_GUARD, shouldConsolidate, shouldReflect, injectAgentsMd, injectLearnedLessons, trustEscalation, validatePhaseTransition, phaseName } = require('./agent/loop');
const autolearn = require('./agent/autolearn');

// ── MCP Integration — merge MCP tools into the agent tool list ────────────
let ALL_TOOLS = AGENT_TOOLS; // starts as built-in only; expanded after MCP loads
let _mcpLoaded = false;

const FAST_CHAT_TOOL_NAMES = new Set([
  'read_file',
  'list_dir',
  'search_files',
  'glob_search',
  'exec_shell',
  'write_file',
  'edit_file',
  'replace_in_file',
  'apply_patch',
  'browser_detect',
  'browser_navigate',
  'browser_snapshot',
  'browser_screenshot',
  'web_search',
  'firecrawl_scrape',
  'generate_image',
  'recall_memory',
  'save_memory',
]);

function getFastChatTools() {
  return ALL_TOOLS.filter((tool) => FAST_CHAT_TOOL_NAMES.has(tool.function?.name));
}

async function initWebMcp() {
  if (_mcpLoaded) return;
  _mcpLoaded = true;
  mcpSetLogFn((msg) => console.log(msg));
  try {
    // Use the same root discovery as the CLI agent
    const roots = Array.from(new Set([
      path.join(process.env.HOME || '/home/ghost', '.hakster'),
      '/home/ghost/.hakster',
      path.join(process.cwd(), '.hakster'),
      path.join(__dirname, '..', '..', '.hakster'),
      '/home/ghost/.agents',
      '/home/ghost/skills',
      '/home/ghost/.hermes/hermes-agent',
      '/home/ghost/.hermes',
      '/home/ghost/haksterAi/pentest-agents',
    ]));
    const { tools: mcpToolDefs, servers } = await loadMcpServers(roots);
    if (mcpToolDefs.length > 0) {
      // Compress MCP tool schemas to save context (same logic as CLI agent)
      const compressed = mcpToolDefs.map(t => {
        const desc = t.function.description || '';
        const shortDesc = desc.split('.')[0] + (desc.includes('.') ? '.' : '');
        let params = { type: 'object', properties: {}, required: t.function.parameters?.required || [] };
        if (t.function.parameters?.properties) {
          for (const [key, schema] of Object.entries(t.function.parameters.properties)) {
            const compressedProp = { type: schema.type || 'string' };
            if (schema.enum) compressedProp.enum = schema.enum;
            if (schema.description && schema.description.length < 60) {
              compressedProp.description = schema.description;
            }
            params.properties[key] = compressedProp;
          }
        }
        return {
          type: 'function',
          function: { name: t.function.name, description: shortDesc, parameters: params },
          _mcpServer: t._mcpServer,
          _mcpToolName: t._mcpToolName,
        };
      });
      ALL_TOOLS = [...AGENT_TOOLS, ...compressed];
      console.log(`[MCP] Loaded ${mcpToolDefs.length} MCP tools from ${servers.length} servers: ${servers.join(', ')}`);
    } else {
      console.log('[MCP] No MCP servers connected (mcp.json may be missing or servers failed to start)');
    }
  } catch (err) {
    console.warn(`[MCP] Init warning: ${err.message}`);
  }
}
const { saveMemory, getMemory, searchMemories, listMemories, deleteMemory, getMemoryContext, getMemoryStats, compactMemories, CATEGORIES: MEMORY_CATEGORIES } = require('./memory');
const { runSecurityAudit, startSecurityScanner, getSecurityNotifications, acknowledgeSecurityNotification, acknowledgeAllSecurityNotifications, SEVERITY: SECURITY_SEVERITY } = require('./security');
const compression = require('compression');
const telegramBots = require('./telegramBots');

// ── Config ────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3579', 10);
const CORS_ORIGINS = (process.env.CORS_ORIGINS || 'http://localhost:4321,http://localhost:3000').split(',').map(s => s.trim());
const FS_ROOT = process.env.FS_ROOT || process.cwd();

// ── Usage limits ─────────────────────────────────────────────────
const USAGE_LIMIT_ENABLED = process.env.USAGE_LIMIT_ENABLED === 'true'; // default: off
const FREE_USAGE_LIMIT = 10;
const USAGE_RESET_DAYS = parseInt(process.env.USAGE_RESET_DAYS || '30', 10);
const REFERRAL_REWARD_TOKENS = parseInt(process.env.REFERRAL_REWARD_TOKENS || '10000', 10);
const REFERRAL_SIGNUP_TOKENS = parseInt(process.env.REFERRAL_SIGNUP_TOKENS || '2500', 10);

const AGENT_PROJECT_CWDS = [
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
      /\bpatching tool\b/i,
    ],
  },
];

function inferAgentWorkDir(messages) {
  const text = (messages || [])
    .filter((m) => m && (m.role === 'user' || m.role === 'system'))
    .map((m) => String(m.content || ''))
    .join('\n');
  for (const project of AGENT_PROJECT_CWDS) {
    if (project.patterns.some((rx) => rx.test(text)) && fs.existsSync(project.cwd)) {
      return project.cwd;
    }
  }
  return null;
}

function resolveAgentWorkDir({ cwd, messages, sessionId }) {
  if (cwd && typeof cwd === 'string') {
    return { workDir: path.resolve(cwd), isolated: false, reason: 'request cwd' };
  }
  const inferred = inferAgentWorkDir(messages);
  if (inferred) return { workDir: inferred, isolated: false, reason: 'inferred project cwd' };

  const root = process.env.FS_ROOT || path.join(__dirname, '..', 'data');
  return {
    workDir: path.join(root, 'workspaces', sessionId || 'default'),
    isolated: true,
    reason: 'isolated workspace',
  };
}

const PRICING_CATALOG = [
  {
    id: 'free',
    name: 'HaksterAI Free',
    stripeProductName: 'HaksterAI Free',
    description: 'Free users get 10 commands or questions, then must upgrade.',
    features: ['10 free commands or questions', 'Upgrade required after free limit', 'Local Ollama support', 'Basic chat and terminal tools'],
    prices: [
      {
        id: 'free',
        name: 'Free',
        billingCycle: 'monthly',
        amount: 0,
        currency: 'usd',
        lookupKey: 'haksterai_free',
        stripePriceId: process.env.STRIPE_PRICE_FREE || null,
      },
    ],
  },
  {
    id: 'pro',
    name: 'HaksterAI Pro',
    stripeProductName: 'HaksterAI Pro',
    description: 'Unlimited personal access for builders and operators.',
    features: ['Unlimited app usage', 'Cloud model routing', 'Agent tools', 'Memory and task history'],
    prices: [
      {
        id: 'starter_monthly',
        name: 'Starter Monthly',
        billingCycle: 'monthly',
        amount: parseInt(process.env.PRICE_STARTER_MONTHLY_CENTS || '400', 10),
        currency: 'usd',
        lookupKey: 'haksterai_starter_monthly',
        stripePriceId: process.env.STRIPE_PRICE_STARTER_MONTHLY || null,
      },
      {
        id: 'pro_monthly',
        name: 'Pro Monthly',
        billingCycle: 'monthly',
        amount: parseInt(process.env.PRICE_PRO_MONTHLY_CENTS || '1900', 10),
        currency: 'usd',
        lookupKey: 'haksterai_pro_monthly',
        stripePriceId: process.env.STRIPE_PRICE_PRO_MONTHLY || null,
      },
      {
        id: 'pro_yearly',
        name: 'Pro Yearly',
        billingCycle: 'yearly',
        amount: parseInt(process.env.PRICE_PRO_YEARLY_CENTS || '19000', 10),
        currency: 'usd',
        lookupKey: 'haksterai_pro_yearly',
        stripePriceId: process.env.STRIPE_PRICE_PRO_YEARLY || null,
      },
    ],
  },
  {
    id: 'enterprise',
    name: 'HaksterAI Enterprise',
    stripeProductName: 'HaksterAI Enterprise',
    description: 'Team access, admin controls, and custom deployment support.',
    features: ['Team seats', 'Higher limits', 'Admin dashboard', 'Priority support'],
    prices: [
      {
        id: 'enterprise_monthly',
        name: 'Enterprise Monthly',
        billingCycle: 'monthly',
        amount: parseInt(process.env.PRICE_ENTERPRISE_MONTHLY_CENTS || '9900', 10),
        currency: 'usd',
        lookupKey: 'haksterai_enterprise_monthly',
        stripePriceId: process.env.STRIPE_PRICE_ENTERPRISE_MONTHLY || null,
      },
      {
        id: 'enterprise_yearly',
        name: 'Enterprise Yearly',
        billingCycle: 'yearly',
        amount: parseInt(process.env.PRICE_ENTERPRISE_YEARLY_CENTS || '99000', 10),
        currency: 'usd',
        lookupKey: 'haksterai_enterprise_yearly',
        stripePriceId: process.env.STRIPE_PRICE_ENTERPRISE_YEARLY || null,
      },
    ],
  },
];

function normalizeReferralCode(code) {
  return String(code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 24);
}

function generateReferralCode(username = '') {
  const base = normalizeReferralCode(username).slice(0, 10) || 'HAKSTER';
  return `${base}${crypto.randomBytes(3).toString('hex').toUpperCase()}`.slice(0, 18);
}

function ensureReferralCode(db, user) {
  if (!user?.id) return null;
  if (user.referral_code) return user.referral_code;
  for (let i = 0; i < 8; i++) {
    const code = generateReferralCode(user.username || user.email || user.id);
    try {
      db.prepare("UPDATE users SET referral_code = ?, updated_at = unixepoch() WHERE id = ? AND (referral_code IS NULL OR referral_code = '')")
        .run(code, user.id);
      return db.prepare('SELECT referral_code FROM users WHERE id = ?').get(user.id)?.referral_code || code;
    } catch {}
  }
  return null;
}

function parseOAuthState(state) {
  if (!state) return {};
  try {
    const json = Buffer.from(String(state), 'base64url').toString('utf8');
    return JSON.parse(json);
  } catch {
    return {};
  }
}

function makeOAuthState(referralCode) {
  return Buffer.from(JSON.stringify({
    nonce: crypto.randomBytes(16).toString('hex'),
    ref: normalizeReferralCode(referralCode),
  })).toString('base64url');
}

function applyReferralCredit(db, newUser, rawReferralCode) {
  const referralCode = normalizeReferralCode(rawReferralCode);
  if (!newUser?.id || !referralCode) return null;
  const referrer = db.prepare('SELECT * FROM users WHERE referral_code = ?').get(referralCode);
  if (!referrer || referrer.id === newUser.id) return null;
  const already = db.prepare('SELECT id FROM referrals WHERE referred_user_id = ?').get(newUser.id);
  if (already) return null;

  const referralId = 'ref_' + crypto.randomBytes(16).toString('hex');
  const rewardTokens = Math.max(0, REFERRAL_REWARD_TOKENS);
  const referredTokens = Math.max(0, REFERRAL_SIGNUP_TOKENS);
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO referrals (id, referrer_user_id, referred_user_id, referral_code, reward_tokens, referred_tokens, status)
       VALUES (?, ?, ?, ?, ?, ?, 'credited')`
    ).run(referralId, referrer.id, newUser.id, referralCode, rewardTokens, referredTokens);
    db.prepare('UPDATE users SET token_balance = COALESCE(token_balance, 0) + ?, updated_at = unixepoch() WHERE id = ?')
      .run(rewardTokens, referrer.id);
    db.prepare('UPDATE users SET token_balance = COALESCE(token_balance, 0) + ?, referred_by = ?, updated_at = unixepoch() WHERE id = ?')
      .run(referredTokens, referrer.id, newUser.id);
  });
  tx();
  return { referralId, referrerId: referrer.id, rewardTokens, referredTokens, referralCode };
}

// ── In-memory caches ──────────────────────────────────────────────
let _skillsCache = null;
let _skillsCacheTime = 0;
const SKILLS_CACHE_TTL = 10000; // dashboard counters should stay live
let _toolsCache = null;
let _toolsCacheTime = 0;
const TOOLS_CACHE_TTL = 10000; // dashboard counters should stay live

function walkMarkdownFiles(dir, maxFiles = 5000) {
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
    path.join(FS_ROOT, '.hakster'),
    path.join(ghostHome, 'haksterAi', '.hakster', 'skills'),
    path.join(ghostHome, 'haksterAi', '.hakster'),
  ];
  const phantomKnowledgeFiles = [
    '/media/ghost/USB2/phantom-knowledge.md',
    '/media/ghost/BOOT/phantom-knowledge.md',
    '/media/ghost/USB STICK/phantom-knowledge.md',
  ];
  const claudeKnowledgeFiles = [
    path.join(ghostHome, 'haksterAi', 'CLAUDE.md'),
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
  for (const file of phantomKnowledgeFiles) {
    if (!fs.existsSync(file)) continue;
    const key = `phantom:${file}`;
    if (seen.has(key)) continue;
    seen.add(key);
    skills.push({
      name: 'phantom-knowledge',
      category: 'phantom',
      path: file,
      source: 'phantom-knowledge',
    });
  }
  for (const file of claudeKnowledgeFiles) {
    if (!fs.existsSync(file)) continue;
    const key = `claude:${file}`;
    if (seen.has(key)) continue;
    seen.add(key);
    skills.push({
      name: path.basename(file, '.md').toLowerCase(),
      category: 'claude',
      path: file,
      source: 'claude-project-docs',
    });
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
  const tools = ALL_TOOLS.map((tool) => ({
    name: tool.function?.name || 'unknown',
    description: tool.function?.description || '',
    source: tool._mcpServer ? `mcp:${tool._mcpServer}` : 'web-agent',
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

function estimateUsageTokens(value) {
  let text = '';
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value || '');
  } catch {
    text = String(value || '');
  }
  return Math.max(0, Math.ceil(text.length / 4));
}

function recordUserTokenUsage(user, usage) {
  if (!user?.id) return;
  try {
    const db = getDb();
    db.prepare(
      `INSERT INTO user_token_usage
       (user_id, google_id, session_id, endpoint, provider, model, input_tokens, output_tokens, tool_calls, fast_mode)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      user.id,
      user.google_id || null,
      usage.sessionId || null,
      usage.endpoint || '/api/agent/run',
      usage.provider || null,
      usage.model || null,
      Math.max(0, Math.round(usage.inputTokens || 0)),
      Math.max(0, Math.round(usage.outputTokens || 0)),
      Math.max(0, Math.round(usage.toolCalls || 0)),
      usage.fastMode ? 1 : 0,
    );
  } catch (err) {
    console.warn('[usage] token ledger write failed:', err.message);
  }
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

app.get('/api/health/security', async (_req, res) => {
  try {
    const report = await runSecurityAudit(path.join(__dirname, '..'), CORS_ORIGINS);
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message, summary: { passed: false, total: 0 } });
  }
});

app.get('/api/health/security/notifications', (req, res) => {
  try {
    const acknowledged = req.query.acknowledged === 'true';
    const limit = parseInt(req.query.limit) || 50;
    const notifications = getSecurityNotifications({ acknowledged, limit });
    res.json({ notifications, count: notifications.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/health/security/notifications/:id/acknowledge', (req, res) => {
  try {
    const result = acknowledgeSecurityNotification(req.params.id);
    if (!result.changes) return res.status(404).json({ error: 'Notification not found' });
    res.json({ ok: true, acknowledged: req.params.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/health/security/notifications/acknowledge-all', (_req, res) => {
  try {
    const result = acknowledgeAllSecurityNotifications();
    res.json({ ok: true, count: result.changes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/agent/capabilities', (_req, res) => {
  const firecrawlKeyCount = getFirecrawlKeys().length;
  const defaultAgent = getHaksterModelConfig();
  const osInfo = { name: os.type(), version: os.release(), arch: os.arch() };
  const localToolNames = [
    'nmap', 'nc', 'openssl', 'whatweb', 'curl', 'nikto', 'ffuf', 'gobuster', 'dirb',
    'dig', 'host', 'nslookup', 'smbclient', 'subfinder', 'theHarvester', 'whois',
    'nuclei', 'masscan', 'amass', 'httpx', 'katana', 'dalfox', 'sqlmap', 'dirsearch',
    'searchsploit', 'wget', 'python3', 'node', 'crontab', 'find', 'shred', 'sudo',
  ];
  const localTools = {};
  try {
    const { execFileSync } = require('child_process');
    for (const name of localToolNames) {
      try {
        const safeName = name.replace(/'/g, "'\\''");
        const rawPath = execFileSync('/bin/sh', ['-lc', `command -v '${safeName}'`], { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] });
        const toolPath = rawPath.split('\n').map(s => s.trim()).find(s => s.startsWith('/') && !s.includes(' ')) || '';
        localTools[name] = { installed: Boolean(toolPath), path: toolPath || null };
      } catch {
        localTools[name] = { installed: false, path: null };
      }
    }
  } catch {
    for (const name of localToolNames) localTools[name] = { installed: false, path: null };
  }
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
    tools: ALL_TOOLS.map((tool) => tool.function?.name).filter(Boolean),
    localTools,
    os: osInfo,
  });
});

// ── MCP Status endpoint ──────────────────────────────────────────────────
app.get('/api/agent/mcp-status', (_req, res) => {
  try {
    const status = mcpStatus();
    res.json({
      servers: status,
      totalMcpTools: status.reduce((sum, s) => sum + s.toolCount, 0),
      totalTools: ALL_TOOLS.length,
      builtinTools: AGENT_TOOLS.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
    else if (/Android/i.test(ua)) { os_name = 'Android'; os_version = ua.match(/Android ([0-9.]+)/)?.[1] || ''; device_type = 'mobile'; }
    else if (/iPhone|iPad|iPod/i.test(ua)) { os_name = 'iOS'; os_version = ua.match(/OS ([0-9_]+)/)?.[1]?.replace(/_/g, '.') || ''; device_type = /iPad/.test(ua) ? 'tablet' : 'mobile'; }
    else if (/Macintosh|Mac OS X/i.test(ua)) { os_name = 'macOS'; os_version = (ua.match(/Mac OS X ([0-9_.]+)/)?.[1] || '').replace(/_/g, '.'); }
    else if (/Linux/i.test(ua)) { os_name = 'Linux'; }
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
    platform: platform || body.platform || null,
    os_name: os_name || body.os_name || null,
    os_version: os_version || body.os_version || null,
    browser: browser || body.browser || null,
    browser_version: browser_version || body.browser_version || null,
    device_type: device_type || body.device_type || null,
    device_model: body.device_model || null,
    engine: body.engine || null,
    engine_version: body.engine_version || null,
    languages: body.languages || null,
    timezone: body.timezone || null,
    timezone_offset: body.timezone_offset ?? null,
    screen_width: body.screen_width || null,
    screen_height: body.screen_height || null,
    screen_avail_width: body.screen_avail_width || null,
    screen_avail_height: body.screen_avail_height || null,
    screen_color_depth: body.screen_color_depth || null,
    screen_orientation: body.screen_orientation || null,
    viewport_width: body.viewport_width || null,
    viewport_height: body.viewport_height || null,
    device_pixel_ratio: body.device_pixel_ratio || null,
    language: body.language || null,
    online: body.online,
    cores: body.cores || null,
    memory_gb: body.memory_gb || null,
    max_touch_points: body.max_touch_points || null,
    touch_support: body.touch_support,
    connection_type: body.connection_type || null,
    connection_downlink: body.connection_downlink || null,
    connection_rtt: body.connection_rtt || null,
    connection_save_data: body.connection_save_data,
    cookies_enabled: body.cookies_enabled,
    do_not_track: body.do_not_track,
    pdf_viewer: body.pdf_viewer,
    webdriver: body.webdriver,
    is_bot: body.is_bot,
    gpu: body.gpu || null,
    dark_mode: body.dark_mode,
    reduced_motion: body.reduced_motion,
  };
}

app.post('/api/client-context', (req, res) => {
  const db = getDb();
  const ctx = parseClientContext(req.body, req.headers);

  if (!ctx.session_id) return res.status(400).json({ error: 'session_id required' });

  const ip = ctx.ip_address || req.ip || req.headers['x-forwarded-for']?.split(',')[0] || 'unknown';

  // Ensure session exists (frontend may generate local IDs not yet in DB)
  db.prepare(`INSERT OR IGNORE INTO sessions (id, title, provider, model) VALUES (?, ?, 'unknown', 'unknown')`)
    .run(ctx.session_id, `Device: ${ctx.os_name || ctx.platform || 'unknown'}`);

  db.prepare(`
    INSERT INTO client_contexts (session_id, ip_address, user_agent, platform, os_name, os_version,
      browser, browser_version, device_type, device_model, engine, engine_version,
      screen_width, screen_height, screen_avail_width, screen_avail_height, screen_color_depth,
      screen_orientation, viewport_width, viewport_height, device_pixel_ratio,
      language, languages, timezone, timezone_offset, online, cores, memory_gb,
      max_touch_points, touch_support, connection_type, connection_downlink, connection_rtt,
      connection_save_data, cookies_enabled, do_not_track, pdf_viewer, webdriver, is_bot,
      gpu, dark_mode, reduced_motion)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      ip_address=excluded.ip_address, user_agent=excluded.user_agent, platform=excluded.platform,
      os_name=excluded.os_name, os_version=excluded.os_version, browser=excluded.browser,
      browser_version=excluded.browser_version, device_type=excluded.device_type,
      device_model=excluded.device_model, engine=excluded.engine, engine_version=excluded.engine_version,
      screen_width=excluded.screen_width, screen_height=excluded.screen_height,
      screen_avail_width=excluded.screen_avail_width, screen_avail_height=excluded.screen_avail_height,
      screen_color_depth=excluded.screen_color_depth, screen_orientation=excluded.screen_orientation,
      viewport_width=excluded.viewport_width, viewport_height=excluded.viewport_height,
      device_pixel_ratio=excluded.device_pixel_ratio, language=excluded.language, languages=excluded.languages,
      timezone=excluded.timezone, timezone_offset=excluded.timezone_offset, online=excluded.online,
      cores=excluded.cores, memory_gb=excluded.memory_gb, max_touch_points=excluded.max_touch_points,
      touch_support=excluded.touch_support, connection_type=excluded.connection_type,
      connection_downlink=excluded.connection_downlink, connection_rtt=excluded.connection_rtt,
      connection_save_data=excluded.connection_save_data, cookies_enabled=excluded.cookies_enabled,
      do_not_track=excluded.do_not_track, pdf_viewer=excluded.pdf_viewer, webdriver=excluded.webdriver,
      is_bot=excluded.is_bot, gpu=excluded.gpu, dark_mode=excluded.dark_mode,
      reduced_motion=excluded.reduced_motion, updated_at=unixepoch()
  `).run(
    ctx.session_id, ip, ctx.user_agent, ctx.platform, ctx.os_name, ctx.os_version,
    ctx.browser, ctx.browser_version, ctx.device_type, ctx.device_model, ctx.engine, ctx.engine_version,
    ctx.screen_width, ctx.screen_height, ctx.screen_avail_width, ctx.screen_avail_height, ctx.screen_color_depth,
    ctx.screen_orientation, ctx.viewport_width, ctx.viewport_height, ctx.device_pixel_ratio,
    ctx.language, ctx.languages, ctx.timezone, ctx.timezone_offset, ctx.online ? 1 : 0, ctx.cores, ctx.memory_gb,
    ctx.max_touch_points, ctx.touch_support ? 1 : 0, ctx.connection_type, ctx.connection_downlink, ctx.connection_rtt,
    ctx.connection_save_data ? 1 : 0, ctx.cookies_enabled ? 1 : 0, ctx.do_not_track, ctx.pdf_viewer ? 1 : 0, ctx.webdriver ? 1 : 0, ctx.is_bot ? 1 : 0,
    ctx.gpu, ctx.dark_mode ? 1 : 0, ctx.reduced_motion ? 1 : 0
  );

  // ── Device fingerprinting: remember this device for the user ──
  const fingerprint = crypto.createHash('sha256').update([
    ctx.user_agent || '', ctx.screen_width || '', ctx.screen_height || '',
    ctx.timezone || '', ctx.language || '', ctx.gpu || '', ctx.device_pixel_ratio || '',
  ].join('|')).digest('hex').slice(0, 32);

  // Check if a logged-in user matches this request (via API key header)
  const apiKey = req.headers['x-api-key'];
  let trackedUserId = null;
  if (apiKey) {
    const u = db.prepare('SELECT id FROM users WHERE api_key = ?').get(apiKey);
    if (u) trackedUserId = u.id;
  }

  if (trackedUserId) {
    const deviceName = ctx.device_model || [ctx.os_name, ctx.device_type].filter(Boolean).join(' ');
    db.prepare(`
      INSERT INTO user_devices (user_id, device_fingerprint, device_name, device_type, os_name, os_version,
        browser, browser_version, user_agent, ip_address, screen_resolution, gpu, timezone, language, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
      ON CONFLICT(user_id, device_fingerprint) DO UPDATE SET
        device_name=excluded.device_name, device_type=excluded.device_type, os_name=excluded.os_name,
        os_version=excluded.os_version, browser=excluded.browser, browser_version=excluded.browser_version,
        user_agent=excluded.user_agent, ip_address=excluded.ip_address, screen_resolution=excluded.screen_resolution,
        gpu=excluded.gpu, timezone=excluded.timezone, language=excluded.language,
        last_seen_at=unixepoch()
    `).run(
      trackedUserId, fingerprint, deviceName, ctx.device_type, ctx.os_name, ctx.os_version,
      ctx.browser, ctx.browser_version, ctx.user_agent, ip,
      ctx.screen_width && ctx.screen_height ? `${ctx.screen_width}x${ctx.screen_height}` : null,
      ctx.gpu, ctx.timezone, ctx.language
    );
  }

  res.json({
    ok: true, session_id: ctx.session_id, fingerprint,
    detected: { os_name: ctx.os_name, platform: ctx.platform, browser: ctx.browser, device_type: ctx.device_type, device_model: ctx.device_model, engine: ctx.engine },
  });
});

// ── Helper: build client device context string for LLM system prompts ──
function getClientContextString(sessionId) {
  if (!sessionId) return '';
  try {
    const db = getDb();
    const cc = db.prepare(`SELECT * FROM client_contexts WHERE session_id = ? ORDER BY updated_at DESC LIMIT 1`).get(sessionId);
    if (!cc) return '';
    const lines = ['\n=== CLIENT DEVICE CONTEXT ==='];
    lines.push(`The user is connecting from this device/browser:`);
    if (cc.device_type) lines.push(`  Device type: ${cc.device_type}`);
    if (cc.device_model) lines.push(`  Device model: ${cc.device_model}`);
    if (cc.os_name || cc.os_version) lines.push(`  OS: ${[cc.os_name, cc.os_version].filter(Boolean).join(' ')}`);
    if (cc.platform) lines.push(`  Platform: ${cc.platform}`);
    if (cc.browser || cc.browser_version) lines.push(`  Browser: ${[cc.browser, cc.browser_version].filter(Boolean).join(' ')}`);
    if (cc.engine) lines.push(`  Engine: ${[cc.engine, cc.engine_version].filter(Boolean).join(' ')}`);
    if (cc.screen_width && cc.screen_height) lines.push(`  Screen: ${cc.screen_width}×${cc.screen_height}${cc.device_pixel_ratio ? ` @${cc.device_pixel_ratio}x` : ''}`);
    if (cc.viewport_width && cc.viewport_height) lines.push(`  Viewport: ${cc.viewport_width}×${cc.viewport_height}`);
    if (cc.touch_support) lines.push(`  Touch: Yes (${cc.max_touch_points || 'multi'} touch points)`);
    if (cc.language) lines.push(`  Language: ${cc.language}${cc.languages ? ` (supports: ${cc.languages})` : ''}`);
    if (cc.timezone) lines.push(`  Timezone: ${cc.timezone}${cc.timezone_offset ? ` (UTC${cc.timezone_offset > 0 ? '-' : '+'}${Math.abs(cc.timezone_offset / 60)}h)` : ''}`);
    if (cc.cores) lines.push(`  CPU cores: ${cc.cores}`);
    if (cc.memory_gb) lines.push(`  Memory: ${cc.memory_gb} GB`);
    if (cc.connection_type) lines.push(`  Connection: ${cc.connection_type}${cc.connection_downlink ? ` (${cc.connection_downlink} Mbps, RTT ${cc.connection_rtt}ms)` : ''}`);
    if (cc.gpu) lines.push(`  GPU: ${cc.gpu}`);
    if (cc.is_bot) lines.push(`  ⚠ Bot/crawler detected`);
    if (cc.webdriver) lines.push(`  ⚠ Automated browser (WebDriver)`);
    if (cc.dark_mode !== null && cc.dark_mode !== undefined) lines.push(`  Dark mode: ${cc.dark_mode ? 'on' : 'off'}`);
    if (cc.ip_address) lines.push(`  IP: ${cc.ip_address}`);
    lines.push('=== END CLIENT DEVICE CONTEXT ===\n');
    return lines.join('\n');
  } catch (_) { return ''; }
}

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

app.post('/api/memory/compact', (req, res) => {
  try {
    const { maxKeep, maxAgeDays } = req.body || {};
    const result = compactMemories({ maxKeep: maxKeep || 40, maxAgeDays: maxAgeDays || 14 });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
  // Usage check
  const user = getUserByApiKey(req);
  const usageCheck = checkUsageLimit(user);
  if (!usageCheck.allowed) {
    return res.status(402).json({ error: 'Free usage limit reached', ...usageCheck });
  }

  // Inject client device context into system prompt
  const clientCtxStr = getClientContextString(sessionId);
  const deviceAwareness = clientCtxStr
    ? '\nYou are aware of the user\'s browser and device via CLIENT DEVICE CONTEXT. Tailor your responses accordingly (mobile vs desktop, touch vs mouse, screen size). When you write files via write_file, the user gets a download button automatically.\n'
    : '';
  const effectiveSystem = (system ? system + '\n\n' : '') + clientCtxStr + deviceAwareness;

  try {
    const result = await chat({ provider, model, messages, system: effectiveSystem || undefined });
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
    incrementUsage(user);
  } catch (err) {
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
  // Usage check
  const user = getUserByApiKey(req);
  const usageCheck = checkUsageLimit(user);
  if (!usageCheck.allowed) {
    return res.status(402).json({ error: 'Free usage limit reached', ...usageCheck });
  }

  // SSE heartbeat — prevent idle disconnect (fast)
  const chatHeartbeat = setInterval(() => {
    try { res.write(':heartbeat\n\n'); } catch {}
  }, 5000);
  res.on('close', () => { clearInterval(chatHeartbeat); });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Inject client device context into system prompt
  const clientCtxStr = getClientContextString(sessionId);
  const deviceAwareness = clientCtxStr
    ? '\nYou are aware of the user\'s browser and device via CLIENT DEVICE CONTEXT. Tailor your responses accordingly (mobile vs desktop, touch vs mouse, screen size). When you write files via write_file, the user gets a download button automatically.\n'
    : '';
  const effectiveSystem = (system ? system + '\n\n' : '') + clientCtxStr + deviceAwareness;

  try {
    let fullContent = '';
    let fullThinking = '';
    let finalMeta = null;

    for await (const event of chatStream({ provider, model, messages, system: effectiveSystem || undefined, thinking })) {
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
    incrementUsage(user);
    res.end();
  } catch (err) {
    console.error('[stream] error:', err);
    res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
    res.end();
  }
});

// ── Agent Run (agentic loop with tool calls) ──────────────────────
const { OpenAI: OpenAIClient } = require('openai');
const AnthropicClient = require('@anthropic-ai/sdk').default;

// ── Per-session allowlist for dangerous commands ──────────────────
const sessionAllowedCommands = new Map(); // sessionId -> Set of allowed command strings
const PHANTOM_EXPLORATION_TOOLS = new Set(['list_dir', 'search_files', 'glob_search', 'read_file', 'codebase_map']);
const PHANTOM_ACTION_TOOLS = new Set(['write_file', 'edit_file', 'replace_in_file', 'apply_patch']);
const PHANTOM_SEARCH_SHELL_RE = /\b(rg|grep|egrep|fgrep|ag|ack|ripgrep|find|fd|locate)\b/i;
const PHANTOM_CLARIFY_RE = /\b(can you|could you|please provide|tell me|let me know|which file|what would you like|do you want|should i|would you like|please clarify|need more|can we|which of these)\b/i;

function normalizeAgentPathForLoop(p, base = '/home/ghost') {
  try {
    return path.resolve(base, p || '.').replace(/\/+$/, '').toLowerCase();
  } catch {
    return String(p || '.').replace(/\/+$/, '').toLowerCase();
  }
}

function isClarifyingLoopText(text) {
  const s = String(text || '').trim();
  return s.endsWith('?') && PHANTOM_CLARIFY_RE.test(s);
}

function toolLoopClass(toolName, toolArgs) {
  if (toolName === 'exec_shell' || toolName === 'shell_bg') {
    const command = String(toolArgs?.command || '');
    return PHANTOM_SEARCH_SHELL_RE.test(command) ? 'explore' : 'action';
  }
  if (PHANTOM_ACTION_TOOLS.has(toolName)) return 'action';
  if (PHANTOM_EXPLORATION_TOOLS.has(toolName)) return 'explore';
  return 'other';
}

function toolLoopTarget(toolName, toolArgs, base) {
  if (toolName === 'exec_shell' || toolName === 'shell_bg') return String(toolArgs?.command || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  return normalizeAgentPathForLoop(toolArgs?.path || toolArgs?.cwd || toolArgs?.focus || '.', base);
}

function detectPhantomLoopNudge(loopDetect, assistantContent, toolCalls, workDir) {
  const text = String(assistantContent || '');
  const hasAction = toolCalls.some((tc) => toolLoopClass(tc.name, safeJsonParse(tc.arguments || '{}')) === 'action');
  const hasExplore = toolCalls.some((tc) => toolLoopClass(tc.name, safeJsonParse(tc.arguments || '{}')) === 'explore');

  if (isClarifyingLoopText(text)) {
    loopDetect.clarifyingCount = (loopDetect.clarifyingCount || 0) + 1;
  } else if (text.trim().length > 30) {
    loopDetect.clarifyingCount = 0;
  }

  if (hasAction) {
    loopDetect.explorationCalls = [];
    loopDetect.searchOnlyCount = 0;
    return null;
  }

  if (hasExplore) {
    for (const tc of toolCalls) {
      const args = safeJsonParse(tc.arguments || '{}');
      if (toolLoopClass(tc.name, args) !== 'explore') continue;
      const target = toolLoopTarget(tc.name, args, workDir);
      loopDetect.explorationCalls.push({ tool: tc.name, target });
    }
    loopDetect.explorationCalls = loopDetect.explorationCalls.slice(-8);
    loopDetect.searchOnlyCount = (loopDetect.searchOnlyCount || 0) + 1;
  }

  const recentTargets = loopDetect.explorationCalls.map((c) => c.target);
  const uniqueTargets = new Set(recentTargets).size;
  const sameSubtreeCount = recentTargets.length >= 5 && uniqueTargets <= 2;
  const searchLoop = (loopDetect.searchOnlyCount || 0) >= 5;
  const clarifyLoop = (loopDetect.clarifyingCount || 0) >= 2;

  if (clarifyLoop) {
    loopDetect.clarifyingCount = 0;
    return {
      reason: 'clarification_loop',
      message: 'Repeated clarification detected. Proceed with best judgment and take a concrete action.',
      nudge: 'PHANTOM LOOP BREAK: Stop asking clarifying questions. Use the project cwd and facts already available. Take one concrete action now: run a bounded shell command, apply a patch, or give the direct answer.',
    };
  }
  if (sameSubtreeCount) {
    loopDetect.explorationCalls = [];
    return {
      reason: 'filesystem_wandering',
      message: 'Filesystem wandering detected. Stop re-listing/searching the same paths and act.',
      nudge: 'PHANTOM WANDERING BREAK: You are browsing the same files/dirs repeatedly. Stop list_dir/search_files/glob_search/read_file. Use what you found and run a fix, apply_patch, or answer now.',
    };
  }
  if (searchLoop) {
    loopDetect.searchOnlyCount = 0;
    return {
      reason: 'search_loop',
      message: 'Repeated search-only turns detected. Stop searching and act.',
      nudge: 'PHANTOM SEARCH BREAK: Too many search commands without progress. Do not search again. Patch the file, run a verification command, or answer with the current evidence.',
    };
  }
  return null;
}

function safeJsonParse(text) {
  try { return JSON.parse(text || '{}'); } catch { return {}; }
}
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
  const { command, permanent, sessionId } = req.body;
  if (!command) return res.status(400).json({ error: 'command is required' });
  const cmd = command.trim();
  const sid = sessionId || 'default';
  // Add to in-memory allowlist for this session
  if (!sessionAllowedCommands.has(sid)) sessionAllowedCommands.set(sid, new Set());
  sessionAllowedCommands.get(sid).add(cmd);
  // Persist to DB only when permanent flag is set (cross-session reuse)
  if (permanent !== false) {
    const db = getDb();
    db.prepare('INSERT OR IGNORE INTO command_allowlist (command, source, session_id) VALUES (?, ?, ?)').run(cmd, 'user', permanent === true ? 'default' : sid);
  }
  res.json({ ok: true, command: cmd, permanent: permanent !== false });
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
  const { messages, sessionId, cwd, thinking: thinkingParam, approvalMode, fastMode = false } = req.body;
  const savedAgent = getHaksterModelConfig();
  const requestedProvider = req.body.provider || savedAgent.provider || 'ollama';
  const requestedModel = req.body.model || savedAgent.model;
  const provider = fastMode ? (savedAgent.provider || requestedProvider || 'ollama') : requestedProvider;
  const model = fastMode && (!req.body.model || req.body.model === 'gpt-oss:120b-cloud')
    ? (savedAgent.model || requestedModel)
    : requestedModel;
  const thinking = fastMode ? thinkingParam === true : thinkingParam !== false;
  const effectiveApprovalMode = approvalMode || (fastMode ? 'full-auto' : undefined);
  if (isCerebrasValue(provider) || isCerebrasValue(model)) {
    return res.status(400).json({ error: 'Cerebras models are disabled' });
  }
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array required' });
  }
  // Usage check
  const user = getUserByApiKey(req);
  const usageCheck = checkUsageLimit(user);
  if (!usageCheck.allowed) {
    return res.status(402).json({ error: 'Free usage limit reached', ...usageCheck });
  }

  const cfg = PROVIDERS[provider];
  if (!cfg) return res.status(400).json({ error: `Unknown provider: ${provider}` });

  // Prefer real project roots when the request names one. Fall back to the
  // isolated per-session workspace only for generic scratch work.
  const { workDir, isolated: usingIsolatedWorkDir, reason: workDirReason } = resolveAgentWorkDir({ cwd, messages, sessionId });
  // Ensure workspace directory exists
  if (usingIsolatedWorkDir) {
    fs.mkdirSync(workDir, { recursive: true });
  }
  const configuredMaxTurns = parseInt(process.env.HAKSTER_AGENT_MAX_TURNS || (fastMode ? '18' : '80'), 10) || (fastMode ? 18 : 80);
  const maxTurns = fastMode
    ? Math.min(Math.max(8, configuredMaxTurns), 24)
    : Math.max(25, configuredMaxTurns);
  const agentModel = model || cfg.defaultModel;

  // ── Session-start activity logging ───────────────────
  try {
    const db = getDb();
    db.prepare('INSERT INTO user_activity (user_id, action, session_id, metadata) VALUES (?, ?, ?, ?)')
      .run(user?.id || null, 'agent_session_start', sessionId, JSON.stringify({ provider, model: agentModel, cwd: workDir, cwdReason: workDirReason }));
  } catch (actErr) { console.error('[activity] session_start log failed:', actErr.message); }

  // ── Loop detection (per-request, not module-level) ────────────
  let loopDetect = {
    lastAssistantContent: '',       // Last assistant response for exact-repeat detection
    noProgressCount: 0,             // Consecutive turns without real tool calls
    recentPrefixes: [],             // Last N response prefixes for semantic loop detection
    consecutiveToolErrors: [],      // [{name, count}] — same tool erroring repeatedly
    recentToolCalls: [],            // [{name, args}] — last N tool calls for duplicate detection
    totalToolCalls: 0,              // Running total of tool calls made
    explorationCalls: [],           // Phantom-style filesystem wandering detection
    searchOnlyCount: 0,             // Consecutive explore/search-only turns
    clarifyingCount: 0,             // Consecutive clarification loops
  };
  const NO_PROGRESS_LIMIT = 15;      // Let long jobs keep driving before declaring no-progress (was 8)
  const SEMANTIC_LOOP_WINDOW = 5;    // How many recent prefixes to check (was 3)
  const SEMANTIC_LOOP_THRESHOLD = 3;  // How many similar prefixes → loop (was 2)
  const SEMANTIC_SIMILARITY_RATIO = 0.4; // Word overlap ratio to count as similar
  const TOOL_ERROR_LOOP_LIMIT = 3;   // Same tool erroring this many times → break
  const DUPE_CALL_WINDOW = 6;        // How many recent tool calls to check for dupes (was 4)
  const DUPE_CALL_LIMIT = 4;         // Same tool+args repeating this many times → loop (was 3)

  // ── 6-Phase Loop State (THINK→PLAN→ACT→OBSERVE→REFLECT→CONSOLIDATE) ──
  let currentPhase = AgentLoopPhase.THINK;
  let thinkPlanStreak = 0;
  let rawMemoryCount = 0;
  let lastConsolidationTurn = -Infinity;
  trustEscalation.reset(); // reset trust for new session

  // Abort tracking — client disconnect support (use res, not req)
  let aborted = false;
  res.on('close', () => {
    aborted = true;
    clearInterval(heartbeat);
  });

  // SSE heartbeat — prevent idle disconnect (send every 5s)
  const heartbeat = setInterval(() => {
    if (!aborted) {
      try { res.write(`:heartbeat\n\n`); } catch {}
    }
  }, 5000);
  // Enable TCP keepalive on the underlying socket — detects dead connections
  // faster and prevents the OS from closing idle sockets during long tool calls
  if (res.socket) {
    res.socket.setKeepAlive(true, 10000); // probe every 10s after idle
    res.socket.setTimeout(0); // no socket timeout — SSE stays open
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
  res.flushHeaders();

  // Emit initial phase event AFTER headers are set
  res.write(`data: ${JSON.stringify({ type: 'phase', phase: phaseName(currentPhase), turn: 0 })}\n\n`);

  // Build the OpenAI-compatible client for the chosen provider
  let client;
  const isAnthropicAgentProvider = cfg.type === 'anthropic' || cfg.type === 'claude-proxy';
  if (isAnthropicAgentProvider) {
    client = new AnthropicClient({
      apiKey: cfg.type === 'claude-proxy' ? (process.env.ANTHROPIC_API_KEY || 'proxy') : process.env.ANTHROPIC_API_KEY,
      ...(cfg.type === 'claude-proxy' ? { baseURL: cfg.baseURL } : {}),
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

  function anthropicToolsFromAgentTools(tools) {
    return tools.map(tool => ({
      name: tool.function.name,
      description: tool.function.description || '',
      input_schema: tool.function.parameters || { type: 'object', properties: {} },
    }));
  }

  function anthropicContentFromMessageContent(content) {
    if (!Array.isArray(content)) return String(content || '');
    return content.map(part => {
      if (part?.type === 'text') {
        return { type: 'text', text: String(part.text || '') };
      }
      if (part?.type === 'image_url') {
        const imageUrl = part.image_url?.url || part.url || '';
        const dataMatch = String(imageUrl).match(/^data:([^;,]+);base64,(.+)$/);
        if (dataMatch) {
          return {
            type: 'image',
            source: {
              type: 'base64',
              media_type: dataMatch[1] || 'image/png',
              data: dataMatch[2],
            },
          };
        }
        return {
          type: 'image',
          source: { type: 'url', url: imageUrl },
        };
      }
      return { type: 'text', text: JSON.stringify(part) };
    });
  }

  function anthropicMessagesFromAgentMessages(msgs) {
    return msgs
      .filter(m => m.role !== 'system')
      .map(m => {
        if (m.role === 'tool') {
          return {
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: m.tool_call_id || m.name || 'tool_result',
              content: String(m.content || ''),
            }],
          };
        }

        if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
          const content = [];
          if (m.content) content.push({ type: 'text', text: String(m.content) });
          for (const tc of m.tool_calls) {
            let input = {};
            try { input = JSON.parse(tc.function?.arguments || '{}'); } catch { input = {}; }
            content.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.function?.name,
              input,
            });
          }
          return { role: 'assistant', content };
        }

        return {
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: anthropicContentFromMessageContent(m.content),
        };
      });
  }

  async function anthropicAgentStream(payload, signal) {
    const budgetTokens = Math.min(10000, Math.max(1024, payload.max_tokens - 1500));
    const streamPayload = {
      model: payload.model,
      max_tokens: payload.max_tokens,
      system: payload.messages.find(m => m.role === 'system')?.content || systemContent,
      messages: anthropicMessagesFromAgentMessages(payload.messages),
      tools: anthropicToolsFromAgentTools(ALL_TOOLS),
      ...(payload.thinking ? { thinking: { type: 'enabled', budget_tokens: budgetTokens } } : {}),
    };
    const stream = await client.messages.stream(streamPayload, { signal });

    async function* iterator() {
      const toolIndexes = new Map();
      let nextToolIndex = 0;
      for await (const event of stream) {
        if (event.type === 'content_block_start') {
          const block = event.content_block || {};
          if (block.type === 'tool_use') {
            const index = nextToolIndex++;
            toolIndexes.set(event.index, index);
            yield {
              choices: [{
                delta: {
                  tool_calls: [{
                    index,
                    id: block.id,
                    type: 'function',
                    function: {
                      name: block.name,
                      arguments: block.input && Object.keys(block.input).length ? JSON.stringify(block.input) : '',
                    },
                  }],
                },
              }],
            };
          }
        } else if (event.type === 'content_block_delta') {
          const delta = event.delta || {};
          if (delta.type === 'text_delta' && delta.text) {
            yield { choices: [{ delta: { content: delta.text } }] };
          } else if (delta.type === 'thinking_delta' && delta.thinking) {
            yield { choices: [{ delta: { thinking: delta.thinking } }] };
          } else if (delta.type === 'input_json_delta' && delta.partial_json) {
            const index = toolIndexes.get(event.index);
            if (index !== undefined) {
              yield {
                choices: [{
                  delta: {
                    tool_calls: [{
                      index,
                      function: { arguments: delta.partial_json },
                    }],
                  },
                }],
              };
            }
          }
        } else if (event.type === 'message_delta' && event.usage) {
          yield {
            choices: [{ delta: {} }],
            usage: {
              prompt_tokens: event.usage.input_tokens || 0,
              completion_tokens: event.usage.output_tokens || 0,
            },
          };
        }
      }
    }

    return iterator();
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
  // ── Build dynamic system prompt with AGENTS.md + autolearn injection ──
  const agentCwd = cwd || process.cwd();
  const contextTags = (lastUserMsg?.content || '').split(/\s+/).filter(w => w.length > 3).slice(0, 10);
  const dynamicPrompt = fastMode
    ? [
        'You are haksterAI in fast Chat tab agent mode.',
        'Be direct and act quickly. Use tools instead of saying you cannot access files.',
        `Active cwd: ${workDir}`,
        'You may inspect user folders under /home/ghost with list_dir, read_file, search_files, glob_search, and exec_shell.',
        'For command requests, call exec_shell with bounded commands and timeout_ms. Avoid foreground servers and broad recursive scans.',
        'For end-user machine diagnosis, call browser_detect first when browser context matters. If you cannot directly access the user machine, create a downloadable diagnostic or fix script with write_file, then tell the user to run it and paste the output.',
        'When creating downloads, write clear scripts/reports into the active cwd with descriptive names like diagnose-linux.sh, fix-network.sh, or machine-report.md.',
        'Dangerous/destructive commands still require confirmation; otherwise run safe read/status/test commands immediately.',
        'Do not repeat failed tool calls. If a command times out, switch to a smaller diagnostic.',
        'After tools finish, always end with a short rundown checklist: What was done, what was verified, and any follow-up or blocker. Keep it concise.',
      ].join('\n')
    : buildAgentSystemPrompt(agentCwd, contextTags);
  const systemContent = dynamicPrompt
    + (clientSystemContent ? '\n\n=== CLIENT DIRECTIVE ===\n' + clientSystemContent : '')
    + '\n\n' + machineContext
    + (memoryContext ? '\n\n' + memoryContext : '');

  const agentMessages = [
    { role: 'system', content: systemContent },
    ...messages.filter(m => m.role !== 'system'),
  ];

  // When "thinking aloud" is enabled for non-Anthropic providers, ask the model to expose reasoning.
  if (thinking && !isAnthropicAgentProvider) {
    agentMessages[0].content += `\n\nThink out loud: show your reasoning/chain-of-thought wrapped in <thinking>…</thinking> tags before your final answer when it helps the user follow your work.`;
  }

  // ── Inject client device context if available ──────────────────────
  const clientCtxStr = getClientContextString(sessionId);
  if (clientCtxStr) {
    agentMessages[0].content += clientCtxStr;
  }

  if (user) {
    const safeName = user.username || (user.email ? String(user.email).split('@')[0] : 'user');
    agentMessages[0].content += `\n\n## Authenticated User\n- Name: ${safeName}\n- Email: ${user.email || 'unknown'}\n- Google ID linked: ${user.google_id ? 'yes' : 'no'}\n- Role: ${user.role || 'user'}\n- Plan: ${user.plan || 'free'}\nUse the user's name naturally when helpful. Never reveal API keys, auth tokens, or hidden account fields.`;
  }

  // ── Inject pentester fingerprint (stable device identity) ──
  const { fingerprint: getServerFingerprint } = require('./fingerprint');
  const serverFp = getServerFingerprint();
  agentMessages[0].content += `\n\n## 🔐 Pentester Device Identity\n- Device UID: ${serverFp.device_uid.device_id}\n- Session UID: ${serverFp.session_uid}\n- Hostname: ${serverFp.hostname}\n- MAC Hash: ${serverFp.mac_hash || 'N/A'}\n- OS: ${serverFp.os.name} ${serverFp.os.release}\nThis is your stable device identity for session tracking, audit logs, and receipts.`;
  // (Client Awareness and File Delivery instructions are already in AGENT_SYSTEM_PROMPT)

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
  const CONTEXT_LIMIT = fastMode ? 32768 : 131072; // fast chat keeps owner token burn low
  const MAX_OUTPUT_TOKENS = fastMode ? 4096 : 16384; // reserved for model output
  const INPUT_TOKEN_BUDGET = CONTEXT_LIMIT - MAX_OUTPUT_TOKENS; // ~114k tokens available for input
  const MAX_CONTEXT_CHARS = fastMode ? 24000 : 100000; // hard ceiling in chars
  const MAX_MSG_CHARS = fastMode ? 700 : 1000; // max chars per message in context (except system prompt)

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

  const requestInputTokens = estimateUsageTokens(agentMessages);
  let responseOutputTokens = 0;
  let requestToolCalls = 0;
  let usageRecorded = false;
  const recordThisAgentUsage = () => {
    if (usageRecorded) return;
    usageRecorded = true;
    recordUserTokenUsage(user, {
      sessionId,
      endpoint: '/api/agent/run',
      provider,
      model: agentModel,
      inputTokens: requestInputTokens,
      outputTokens: responseOutputTokens,
      toolCalls: requestToolCalls,
      fastMode,
    });
  };

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
      // Skip if no new messages were added since last enforcement (saves O(n) scan)
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
        // Debug: log actual message sizes being sent to model (throttled — only log when size changes)
        if (process.env.HAKSTER_DEBUG) {
          const totalChars = agentMessages.reduce((s, m) => s + (m.content || '').length +
            (m.tool_calls ? m.tool_calls.reduce((acc, tc) => acc + (tc.function?.arguments || '').length, 0) : 0), 0);
          console.log(`[agent] Sending turn ${turn}: ${agentMessages.length} msgs, ${totalChars.toLocaleString()} chars, est ${estimateTokens(agentMessages).toLocaleString()} tokens (budget: ${INPUT_TOKEN_BUDGET})`);
        }
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
        console.warn('[agent] Stream timed out after 600s, aborting');
      }, 600000);

      let stream;
      try {
        const isO1 = /^o1/i.test(agentModel);
        const streamPayload = {
          model: agentModel,
          messages: sanitizeMessagesForProvider(agentMessages, provider),
          tools: fastMode ? getFastChatTools() : ALL_TOOLS,
          stream: true,
          max_tokens: MAX_OUTPUT_TOKENS,
          ...(thinking ? { thinking: true } : {}),
          ...(thinking && isO1 ? { reasoning_effort: 'high' } : {}),
        };
        stream = isAnthropicAgentProvider
          ? await anthropicAgentStream(streamPayload, streamAbort.signal)
          : cfg.type === 'openai-compat'
          ? await openAICompatStreamFetch(cfg.baseURL, streamPayload, streamAbort.signal)
          : await client.chat.completions.create(streamPayload, { signal: streamAbort.signal });
      } catch (streamErr) {
        clearTimeout(streamTimeout);
        if (streamErr.name === 'AbortError') {
          res.write(`data: ${JSON.stringify({ type: 'error', message: 'Model response timed out (300s). Try again.' })}\n\n`);
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
          responseOutputTokens += estimateUsageTokens(delta.content);
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
        // Phase: ACT→OBSERVE→CONSOLIDATE (session end)
        if (currentPhase === AgentLoopPhase.ACT) {
          currentPhase = AgentLoopPhase.OBSERVE;
          res.write(`data: ${JSON.stringify({ type: 'phase', phase: phaseName(currentPhase), turn })}\n\n`);
        }
        if (shouldConsolidate({ turn, rawMemoryCount, lastConsolidationTurn, isSessionEnd: true })) {
          currentPhase = AgentLoopPhase.CONSOLIDATE;
          res.write(`data: ${JSON.stringify({ type: 'phase', phase: phaseName(currentPhase), turn })}\n\n`);
          // Autolearn: record session-end consolidation
          try {
            autolearn.initMemory(workDir);
            autolearn.consolidateMemories(workDir);
          } catch(_e) {}
          lastConsolidationTurn = turn;
        }
        clearInterval(heartbeat);
        recordThisAgentUsage();
        res.write(`data: ${JSON.stringify({ type: 'done', model: agentModel, provider })}\n\n`);
        res.end();
        return;
      }

      // ── Phase: THINK→PLAN (model responded, about to act) ──
      if (currentPhase === AgentLoopPhase.THINK) {
        const transition = validatePhaseTransition(currentPhase, AgentLoopPhase.PLAN, { thinkPlanStreak });
        if (transition.allowed) {
          currentPhase = AgentLoopPhase.PLAN;
          thinkPlanStreak++;
          res.write(`data: ${JSON.stringify({ type: 'phase', phase: phaseName(currentPhase), turn })}\n\n`);
        }
      }

      // ── Phase: PLAN→ACT (tool calls present, executing) ──
      if (currentPhase === AgentLoopPhase.PLAN) {
        const transition = validatePhaseTransition(currentPhase, AgentLoopPhase.ACT, { thinkPlanStreak });
        if (transition.allowed) {
          currentPhase = AgentLoopPhase.ACT;
          thinkPlanStreak = 0; // reset streak once we actually act
          res.write(`data: ${JSON.stringify({ type: 'phase', phase: phaseName(currentPhase), turn })}\n\n`);
        }
      }

      // ── Loop detection checks (before executing tools) ──────────
      const responsePrefix = (assistantContent || '').substring(0, 80).toLowerCase().trim();

      // 1. Exact repeat — model said the same thing twice in a row
      if (responsePrefix && responsePrefix === loopDetect.lastAssistantContent.substring(0, 80).toLowerCase().trim()) {
        console.warn(`[agent] Loop detected: exact repeat response (turn ${turn})`);
        clearInterval(heartbeat);
        res.write(`data: ${JSON.stringify({ type: 'loop_detected', reason: 'exact_repeat', message: 'Model is repeating the same response. Stopping to avoid infinite loop.' })}\n\n`);
        recordThisAgentUsage();
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
            recordThisAgentUsage();
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
          recordThisAgentUsage();
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
          recordThisAgentUsage();
          res.write(`data: ${JSON.stringify({ type: 'done', model: agentModel, provider })}\n\n`);
          res.end();
          return;
        }
        loopDetect.totalToolCalls++;
      }

      const phantomNudge = detectPhantomLoopNudge(loopDetect, assistantContent, toolCalls, workDir);
      if (phantomNudge) {
        console.warn(`[agent] Phantom loop nudge: ${phantomNudge.reason} (turn ${turn})`);
        agentMessages.push({ role: 'system', content: phantomNudge.nudge });
        res.write(`data: ${JSON.stringify({ type: 'loop_nudge', reason: phantomNudge.reason, message: phantomNudge.message, nudge: phantomNudge.nudge })}\n\n`);
      }

      // Tool calls in progress — mark so next turn skips compact
      lastHadToolCalls = true;
      loopDetect.lastAssistantContent = assistantContent || '';

      // Execute tool calls — run independent (non-shell) tools in parallel
      const toolResults = [];
      const _tc_abort = () => {
        clearInterval(heartbeat);
        res.write(`data: ${JSON.stringify({ type: 'aborted' })}\n\n`);
        res.end();
        return null;
      };

      // Phase 1: identify which tools can run in parallel (no shell, no browser)
      const parallelizable = toolCalls.every(tc => !['exec_shell', 'browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_screenshot', 'spawn_agent'].includes(tc.name));
      const PARALLEL_BATCH = parallelizable && toolCalls.length > 1;

      if (PARALLEL_BATCH) {
        // Run all non-shell tools concurrently
        const promises = toolCalls.map(async (tc) => {
          if (aborted) return { tc, result: null, aborted: true };
          const toolName = tc.name;
          requestToolCalls++;
          let toolArgs = {};
          try { toolArgs = JSON.parse(tc.arguments || '{}'); } catch { /* leave empty */ }

          res.write(`data: ${JSON.stringify({ type: 'tool_call_start', tool_call_id: tc.id, tool_name: toolName, tool_args: toolArgs })}\n\n`);

          const sessionSet = sessionAllowedCommands.get(sessionId || 'default');
          const globalSet = sessionAllowedCommands.get('default');
          const allowedCommands = new Set([...(sessionSet || []), ...(globalSet || [])]);
          const result = await executeAgentTool(toolName, toolArgs, workDir, provider, agentModel, undefined, allowedCommands, effectiveApprovalMode);
          try { const _db = getDb(); _db.prepare('INSERT INTO user_activity (user_id, action, session_id, metadata) VALUES (?, ?, ?, ?)').run(user?.id || null, 'tool_call', sessionId, JSON.stringify({ tool: toolName, args_summary: JSON.stringify(toolArgs).slice(0, 500) })); } catch(_ae) {}
          return { tc, result, toolName, toolArgs };
        });
        const settled = await Promise.all(promises);

        // Process results sequentially (preserve order, emit SSE events, check loop detections)
        for (const { tc, result, toolName, toolArgs, aborted: wasAborted } of settled) {
          if (wasAborted) return _tc_abort();

          let needsConfirmation = null;
          if (effectiveApprovalMode !== 'full-auto') {
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
          }

          const SHELL_DISPLAY_LIMIT = 4000;
          const SHELL_CONTEXT_LIMIT = 2500;

          if (needsConfirmation) {
            const confirmContextResult = `This command requires user confirmation before execution. Waiting for the user to approve or deny the command: ${needsConfirmation.args?.command || '(unknown)'}. Do not retry — explain to the user that they need to approve the command.`;
            agentMessages.push({ role: 'tool', tool_call_id: tc.id, content: confirmContextResult });
            continue;
          }

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
          responseOutputTokens += estimateUsageTokens(contextResult);

          res.write(`data: ${JSON.stringify({ type: 'tool_call_result', tool_call_id: tc.id, tool_name: toolName, tool_result: truncatedResult })}\n\n`);

          if (['write_file', 'edit_file', 'patch_file', 'multi_patch'].includes(toolName) && toolArgs.path) {
            const isErr = /^Error[:\n]/i.test(String(result).trim()) || /^\u274c/i.test(String(result).trim());
            const fullPath = path.resolve(workDir, toolArgs.path);
            if (!isErr && fs.existsSync(fullPath)) {
              res.write(`data: ${JSON.stringify({ type: 'file_created', path: fullPath, tool: toolName })}\n\n`);
            }
          }
          if (['write_file', 'edit_file'].includes(toolName) && toolArgs.path) {
            notifyWorkspaceChange(sessionId, toolArgs.path);
          }
          if (imageUrls && imageUrls.length > 0) {
            for (const imgUrl of imageUrls) {
              res.write(`data: ${JSON.stringify({ type: 'image', url: imgUrl, prompt: toolArgs.prompt || '' })}\n\n`);
            }
          }

          agentMessages.push({ role: 'tool', tool_call_id: tc.id, content: contextResult });

          // ── Autolearn: record raw memory from tool call ──
          try {
            const _isErr = /^(error|❌)/i.test(String(result).trim());
            autolearn.addRawMemory({
              observation: `${toolName}(${JSON.stringify(toolArgs).slice(0, 200)}) → ${contextResult.slice(0, 200)}`,
              type: _isErr ? 'error' : 'pattern',
              tags: [toolName],
              confidence: _isErr ? 0.3 : 0.8,
              timestamp: Date.now()
            }, workDir);
          } catch(_amErr) { /* autolearn best-effort */ }

          // Tool-error loop detection
          const resultLower = result.toLowerCase();
          const isError = /^(error|❌)/.test(result.trim()) || resultLower.startsWith('error:') || resultLower.startsWith('failed:') || resultLower.startsWith('exception:');
          if (isError) {
            const existing = loopDetect.consecutiveToolErrors.find(e => e.name === toolName);
            if (existing) {
              existing.count++;
              if (existing.count >= TOOL_ERROR_LOOP_LIMIT) {
                console.warn(`[agent] Loop detected: tool ${toolName} errored ${existing.count}x in a row (turn ${turn})`);
                clearInterval(heartbeat);
                res.write(`data: ${JSON.stringify({ type: 'loop_detected', reason: 'tool_error', message: `Tool ${toolName} has failed ${existing.count} times in a row. Stopping to avoid retry loop.` })}\n\n`);
                recordThisAgentUsage();
                res.write(`data: ${JSON.stringify({ type: 'done', model: agentModel, provider })}\n\n`);
                res.end();
                return;
              }
            } else {
              loopDetect.consecutiveToolErrors = [{ name: toolName, count: 1 }];
            }
          } else {
            loopDetect.consecutiveToolErrors = [];
          }
        }
      } else {
      // Sequential execution (shell/browser tools need ordering for streaming)
      for (const tc of toolCalls) {
        // Check abort before each tool execution
        if (aborted) {
          clearInterval(heartbeat);
          res.write(`data: ${JSON.stringify({ type: 'aborted' })}\n\n`);
          res.end();
          return;
        }

        const toolName = tc.name;
        requestToolCalls++;
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
        const result = await executeAgentTool(toolName, toolArgs, workDir, provider, agentModel, onToolStream, allowedCommands, effectiveApprovalMode);
        try { const _db2 = getDb(); _db2.prepare('INSERT INTO user_activity (user_id, action, session_id, metadata) VALUES (?, ?, ?, ?)').run(user?.id || null, 'tool_call', sessionId, JSON.stringify({ tool: toolName, args_summary: JSON.stringify(toolArgs).slice(0, 500) })); } catch(_ae2) {}

        // ── Detect __needs_confirmation and emit special SSE event ──
        let needsConfirmation = null;
        if (effectiveApprovalMode !== 'full-auto') {
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
        responseOutputTokens += estimateUsageTokens(contextResult);

        // Notify frontend: tool call result
        res.write(`data: ${JSON.stringify({ type: 'tool_call_result', tool_call_id: tc.id, tool_name: toolName, tool_result: truncatedResult })}\n\n`);

        // If a file was written/edited, emit a file event so frontend can show a download button.
        // Only emit on success — the tool result must not be an error and the file must actually exist,
        // otherwise the user sees an "error" message alongside a dead download button.
        if (['write_file', 'edit_file', 'patch_file', 'multi_patch'].includes(toolName) && toolArgs.path) {
          const isErr = /^Error[:\n]/i.test(String(result).trim()) || /^\u274c/i.test(String(result).trim());
          const fullPath = path.resolve(workDir, toolArgs.path);
          if (!isErr && fs.existsSync(fullPath)) {
            res.write(`data: ${JSON.stringify({ type: 'file_created', path: fullPath, tool: toolName })}\n\n`);
          }
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

        // ── Autolearn: record raw memory from tool call (sequential path) ──
        try {
          const _isErr = /^(error|❌)/i.test(String(result).trim());
          autolearn.addRawMemory({
            observation: `${toolName}(${JSON.stringify(toolArgs).slice(0, 200)}) → ${contextResult.slice(0, 200)}`,
            type: _isErr ? 'error' : 'pattern',
            tags: [toolName],
            confidence: _isErr ? 0.3 : 0.8,
            timestamp: Date.now()
          }, workDir);
        } catch(_amErr2) { /* autolearn best-effort */ }

        // ── Tool-error loop detection ──
        // Track consecutive errors from the same tool — if a tool errors 3x in a row, break the loop
        // Only match actual error lines (starting with "Error:" or "❌"), not file paths containing "error"
        const resultLower = result.toLowerCase();
        const isError = /^(error|❌)/.test(result.trim()) || resultLower.startsWith('error:') || resultLower.startsWith('failed:') || resultLower.startsWith('exception:');
        if (isError) {
          const existing = loopDetect.consecutiveToolErrors.find(e => e.name === toolName);
          if (existing) {
            existing.count++;
            if (existing.count >= TOOL_ERROR_LOOP_LIMIT) {
              console.warn(`[agent] Loop detected: tool ${toolName} errored ${existing.count}x in a row (turn ${turn})`);
              clearInterval(heartbeat);
              res.write(`data: ${JSON.stringify({ type: 'loop_detected', reason: 'tool_error', message: `Tool ${toolName} has failed ${existing.count} times in a row. Stopping to avoid retry loop.` })}\n\n`);
              recordThisAgentUsage();
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
      } // close else (sequential execution)

      // ── Phase: ACT→OBSERVE (tools finished, observe results) ──
      if (currentPhase === AgentLoopPhase.ACT) {
        currentPhase = AgentLoopPhase.OBSERVE;
        res.write(`data: ${JSON.stringify({ type: 'phase', phase: phaseName(currentPhase), turn })}\n\n`);
      }

      // ── Phase: OBSERVE→REFLECT (check if reflection needed) ──
      const reflectState = {
        noProgressCount: loopDetect.noProgressCount,
        semanticLoopDetected: false, // already handled above — if we got here, no loop
        sameToolErrorCount: loopDetect.consecutiveToolErrors.reduce((max, e) => Math.max(max, e.count), 0),
        isClarifyingQuestion: false,
        isFilesystemWandering: false,
      };
      if (currentPhase === AgentLoopPhase.OBSERVE && shouldReflect(reflectState)) {
        currentPhase = AgentLoopPhase.REFLECT;
        res.write(`data: ${JSON.stringify({ type: 'phase', phase: phaseName(currentPhase), turn, reason: 'loop_signal' })}\n\n`);
        // Inject reflection prompt to guide model
        agentMessages.push({
          role: 'system',
          content: `[REFLECT] You've had ${loopDetect.noProgressCount} no-progress turns or ${reflectState.sameToolErrorCount} tool errors. Pause and reconsider your approach. Try a different tool or strategy.`
        });
        // Reset counters after reflection injection
        loopDetect.noProgressCount = 0;
        loopDetect.consecutiveToolErrors = [];
      }

      // ── Phase: REFLECT→CONSOLIDATE (check if consolidation needed) ──
      if (currentPhase === AgentLoopPhase.REFLECT || currentPhase === AgentLoopPhase.OBSERVE) {
        if (shouldConsolidate({ turn, rawMemoryCount, lastConsolidationTurn })) {
          currentPhase = AgentLoopPhase.CONSOLIDATE;
          res.write(`data: ${JSON.stringify({ type: 'phase', phase: phaseName(currentPhase), turn })}\n\n`);
          // Autolearn: run consolidation — extract lessons from recent activity
          try {
            autolearn.initMemory(workDir);
            const consolidationResult = autolearn.consolidateMemories(workDir);
            if (consolidationResult && consolidationResult.consolidated > 0) {
              rawMemoryCount = 0; // reset after consolidation
              lastConsolidationTurn = turn;
              const lessons = autolearn.loadLearnedLessons(workDir, []);
              // Inject consolidated lessons into context
              agentMessages.push({
                role: 'system',
                content: `[CONSOLIDATE] Lessons learned so far:\n${lessons || 'Consolidation complete.'}`
              });
            }
          } catch(_consolidateErr) {
            console.warn('[agent] Consolidation failed:', _consolidateErr.message);
          }
        }
      }

      // ── Phase: →THINK (always cycle back to THINK for next turn) ──
      if (currentPhase !== AgentLoopPhase.THINK) {
        currentPhase = AgentLoopPhase.THINK;
        res.write(`data: ${JSON.stringify({ type: 'phase', phase: phaseName(currentPhase), turn })}\n\n`);
      }

      // Trust escalation: record activity based on tool types used
      for (const tc of toolCalls) {
        if (['read_file', 'glob_search', 'codebase_map', 'diff_preview'].includes(tc.name)) {
          trustEscalation.recordActivity('read', turn);
        } else if (['write_file', 'edit_file', 'replace_in_file', 'patch_file', 'multi_patch'].includes(tc.name)) {
          trustEscalation.recordActivity('edit', turn);
        } else if (tc.name === 'exec_shell') {
          const _cmd = (() => { try { return JSON.parse(tc.arguments || '{}').command || ''; } catch { return ''; } })();
          if (/test|spec/i.test(_cmd)) trustEscalation.recordActivity('test', turn);
          else if (/build|make|compile/i.test(_cmd)) trustEscalation.recordActivity('build', turn);
        }
      }
      trustEscalation.decay(turn);

      // Track raw memory for consolidation threshold
      rawMemoryCount += toolCalls.length;

      // Turn marker
      res.write(`data: ${JSON.stringify({ type: 'turn_end', turn })}\n\n`);
    }

    // Hit max turns
    clearInterval(heartbeat);
    res.write(`data: ${JSON.stringify({ type: 'max_turns', maxTurns })}\n\n`);
    recordThisAgentUsage();
    incrementUsage(user);
    res.end();
  } catch (err) {
    clearInterval(heartbeat);
    console.error('[agent] error:', err);
    recordThisAgentUsage();
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
  // Handle absolute paths directly; resolve relative paths against FS_ROOT.
  // path.resolve() normalizes away any leading "./" or "../" segments safely.
  const resolved = path.isAbsolute(reqPath)
    ? path.resolve(reqPath)
    : path.resolve(FS_ROOT, reqPath);
  // Security: must be within FS_ROOT or a known safe directory.
  // Use path.relative to guard against traversal (handles trailing-slash edge cases).
  const fsRootResolved = path.resolve(FS_ROOT);
  const safeRoots = [fsRootResolved, '/tmp', '/home/ghost'];
  const allowed = safeRoots.some(root => {
    if (root === '/') return true;
    const rel = path.relative(root, resolved);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
  if (!allowed) {
    throw new Error('Path traversal blocked');
  }
  return resolved;
}

// GET /api/fs/list?path=/some/dir — List files/dirs in a path
app.get('/api/fs/list', (req, res) => {
  try {
    const dirPath = safePath(req.query.path || '/');
    if (!fs.existsSync(dirPath)) return res.status(404).json({ error: 'Not found' });
    const stat = fs.statSync(dirPath);
    if (!stat.isDirectory()) return res.json([{ type: 'file', name: path.basename(dirPath), size: stat.size }]);
    const items = fs.readdirSync(dirPath, { withFileTypes: true }).map(dirent => {
      const fullPath = path.join(dirPath, dirent.name);
      try {
        const s = fs.statSync(fullPath);
        return { type: dirent.isDirectory() ? 'dir' : 'file', name: dirent.name, size: s.isFile() ? s.size : 0 };
      } catch {
        return { type: 'unknown', name: dirent.name, size: 0 };
      }
    });
    res.json(items);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

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
  // Usage check
  const user = getUserByApiKey(req);
  const usageCheck = checkUsageLimit(user);
  if (!usageCheck.allowed) {
    return res.status(402).json({ error: 'Free usage limit reached', ...usageCheck });
  }

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
  }, 5000);

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
  const NO_PROGRESS_LIMIT = 15;      // was 4 — too aggressive for complex prompts
  const DUPE_CALL_WINDOW = 6;        // was 4
  const DUPE_CALL_LIMIT = 4;         // was 3
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
      const streamTimeout = setTimeout(() => { streamAbort.abort(); }, 60000);

      let stream;
      try {
        stream = await client.chat.completions.create({
          model: agentModel,
          messages: sanitizeMessagesForProvider(messages, provider),
          tools: ALL_TOOLS,
          stream: true,
          max_tokens: MAX_OUTPUT_TOKENS,
        }, { signal: streamAbort.signal });
      } catch (streamErr) {
        clearTimeout(streamTimeout);
        if (streamErr.name === 'AbortError') {
          res.write(`data: ${JSON.stringify({ type: 'error', message: 'Model response timed out (60s).' })}\n\n`);
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

        const result = await executeAgentTool(toolName, toolArgs, workDir, provider, agentModel, onToolStream, undefined, approvalMode);
        try { const _db3 = getDb(); _db3.prepare('INSERT INTO user_activity (user_id, action, session_id, metadata) VALUES (?, ?, ?, ?)').run(user?.id || null, 'tool_call', sessionId, JSON.stringify({ tool: toolName, args_summary: JSON.stringify(toolArgs).slice(0, 500) })); } catch(_ae3) {}

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
      try {
        db.prepare('INSERT INTO user_activity (user_id, action, session_id, metadata) VALUES (?, ?, ?, ?)')
          .run(user?.id || null, 'agent_session_end', sessionId, JSON.stringify({ inputTokens: finalMeta.inputTokens, outputTokens: finalMeta.outputTokens, cost: finalMeta.cost, model: finalMeta.model }));
      } catch (actEndErr) { console.error('[activity] session_end log failed:', actEndErr.message); }
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
  // Usage check
  const user = getUserByApiKey(req);
  const usageCheck = checkUsageLimit(user);
  if (!usageCheck.allowed) {
    return res.status(402).json({ error: 'Free usage limit reached', ...usageCheck });
  }

  try {
    const result = await generateImage({ provider, model, prompt, size, quality });
    res.json(result);
    incrementUsage(user);
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
app.get('/api/dashboard', (req, res) => {
  try {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    if (req.query.live === '1') {
      _skillsCache = null;
      _skillsCacheTime = 0;
      _toolsCache = null;
      _toolsCacheTime = 0;
    }
    const db = getDb();

    // Request stats
    const totalRequests = db.prepare(`SELECT COUNT(*) as count FROM requests`).get().count;
    const ledgerTotals = db.prepare(`SELECT COUNT(*) as requests, SUM(input_tokens + output_tokens) as tokens, SUM(input_tokens) as inputTokens, SUM(output_tokens) as outputTokens FROM user_token_usage`).get() || {};
    const totalTokens = (db.prepare(`SELECT SUM(input_tokens + output_tokens) as total FROM requests`).get().total || 0) + (ledgerTotals.tokens || 0);
    const totalCost = db.prepare(`SELECT SUM(cost) as total FROM requests`).get().total || 0;
    const byProvider = db.prepare(
      `SELECT provider, COUNT(*) as requests, SUM(input_tokens) as inputTokens, SUM(output_tokens) as outputTokens, SUM(cost) as cost FROM requests GROUP BY provider`
    ).all();
    const byUser = db.prepare(
      `SELECT
         u.id as userId,
         u.username,
         u.email,
         u.google_id as googleId,
         u.role,
         u.plan,
         COUNT(utu.id) as requests,
         SUM(utu.input_tokens) as inputTokens,
         SUM(utu.output_tokens) as outputTokens,
         SUM(utu.tool_calls) as toolCalls,
         MAX(utu.created_at) as lastUsedAt
       FROM user_token_usage utu
       LEFT JOIN users u ON u.id = utu.user_id
       GROUP BY utu.user_id, utu.google_id
       ORDER BY (SUM(utu.input_tokens) + SUM(utu.output_tokens)) DESC
       LIMIT 20`
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
      `SELECT COUNT(*) as count FROM sessions WHERE updated_at > unixepoch() - 3600`
    ).get().count;

    // System info
    const cpus = os.cpus().length;
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const uptime = os.uptime();

    // Running servers / ports — live detected from listeners, not stale hardcoded status.
    const knownServices = {
      22: { name: 'SSH', desc: 'Remote shell' },
      80: { name: 'Web Server', desc: 'HTTP' },
      443: { name: 'Web Server', desc: 'HTTPS' },
      3000: { name: 'Node App', desc: 'Development server' },
      3579: { name: 'haksterAi', desc: 'Main server' },
      4000: { name: 'Phantom Server', desc: 'Local agent server' },
      4040: { name: 'ngrok', desc: 'Tunnel UI' },
      4321: { name: 'Astro Dev', desc: 'Astro development server' },
      5173: { name: 'Vite', desc: 'Vite development server' },
      8080: { name: 'Node App', desc: 'Local web app' },
      8081: { name: 'CineVault', desc: 'Movie server' },
      8888: { name: 'StalkerHEK', desc: 'IPTV portal' },
      9999: { name: 'StalkerHEK-SSL', desc: 'IPTV SSL' },
      11434: { name: 'Ollama', desc: 'Local LLM' },
      20241: { name: 'cloudflared', desc: 'Cloudflare tunnel' },
    };
    const procInfo = (pid) => {
      if (!pid) return {};
      try {
        const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ');
        let cwd = '';
        try { cwd = fs.readlinkSync(`/proc/${pid}/cwd`); } catch {}
        return { cmd, cwd };
      } catch { return {}; }
    };
    const serviceName = (port, proc, cmd, cwd) => {
      const hay = `${proc || ''} ${cmd || ''} ${cwd || ''}`.toLowerCase();
      if (hay.includes('haksterai')) return 'haksterAi';
      if (hay.includes('cine-vault') || hay.includes('cinevault') || hay.includes('movie-site')) return 'CineVault';
      if (hay.includes('ollama')) return 'Ollama';
      if (hay.includes('cloudflared')) return 'cloudflared';
      if (hay.includes('ngrok')) return 'ngrok';
      if (hay.includes('astro')) return 'Astro Dev';
      if (hay.includes('vite')) return 'Vite';
      if (hay.includes('stalker')) return 'StalkerHEK';
      return knownServices[port]?.name || proc || 'unknown';
    };
    const parseSs = (out, protocol) => {
      const rows = [];
      for (const raw of out.split('\n').filter(Boolean)) {
        const line = raw.trim();
        if (!line || line.startsWith('State ') || line.startsWith('Netid ')) continue;
        const parts = line.split(/\s+/);
        const local = parts.find((p) => /:\d+$/.test(p) || /\]:\d+$/.test(p));
        if (!local) continue;
        const portMatch = local.match(/:(\d+)$/);
        if (!portMatch) continue;
        const port = parseInt(portMatch[1], 10);
        const userInfo = line.match(/users:\(\("([^"]+)",pid=(\d+),fd=\d+\)\)/);
        const processName = userInfo?.[1] || '';
        const pid = userInfo?.[2] ? parseInt(userInfo[2], 10) : null;
        const { cmd, cwd } = procInfo(pid);
        rows.push({
          name: serviceName(port, processName, cmd, cwd),
          port,
          protocol,
          bind: local,
          status: 'running',
          process: processName || 'unknown',
          pid,
          command: cmd || processName || '',
          cwd,
          desc: knownServices[port]?.desc || cwd || cmd || processName || '',
          checkedAt: new Date().toISOString(),
        });
      }
      return rows;
    };
    let runningServices = [];
    try {
      const { execFileSync } = require('child_process');
      const tcpOut = execFileSync('ss', ['-H', '-tlnp'], { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] });
      const udpOut = execFileSync('ss', ['-H', '-ulnp'], { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] });
      const seen = new Set();
      runningServices = [...parseSs(tcpOut, 'tcp'), ...parseSs(udpOut, 'udp')]
        .filter((svc) => {
          const key = `${svc.protocol}:${svc.port}:${svc.pid || svc.process}:${svc.bind}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .sort((a, b) => a.port - b.port || a.protocol.localeCompare(b.protocol));
    } catch (e) {
      runningServices = [{
        name: 'haksterAi',
        port: PORT,
        protocol: 'tcp',
        bind: `:${PORT}`,
        status: 'running',
        process: 'node',
        pid: process.pid,
        command: process.argv.join(' '),
        cwd: process.cwd(),
        desc: 'Main server',
        checkedAt: new Date().toISOString(),
        warning: `service scan limited: ${e.message}`,
      }];
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
    const includeSkillList = req.query.compact !== '1';
    let skillsInventory = { total: 0, categories: {}, skills: [] };
    let toolInventory = [];
    try {
      const inv = getSkillsInventory();
      skillsInventory = { total: inv.total || 0, categories: inv.categories || {}, skills: includeSkillList ? (inv.skills || []) : [] };
    } catch (e) { console.error('[dashboard] skills inventory error:', e.message); }
    try { toolInventory = getToolInventory(); } catch (e) { console.error('[dashboard] tool inventory error:', e.message); }

    // Crush DB stats (tool calls, reasoning, sessions)
    let crushStats = { sessions: 0, messages: 0, promptTokens: 0, completionTokens: 0, toolCalls: 0, uniqueTools: 0, toolBreakdown: {}, reasoningSteps: 0, files: 0 };
    const crushDbPaths = [
      path.join('/home/ghost', '.crush', 'crush.db'),
      path.join(process.env.HOME || '/home/ghost', '.crush', 'crush.db'),
    ];
    for (const crushDbPath of crushDbPaths) {
      try {
        if (fs.existsSync(crushDbPath)) {
          const Database = require('better-sqlite3');
          const cdb = new Database(crushDbPath, { readonly: true });
          const tableExists = (table) => !!cdb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(table);
          const columnExists = (table, column) => tableExists(table) && cdb.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
          crushStats.sessions = tableExists('sessions') ? cdb.prepare('SELECT COUNT(*) as c FROM sessions').get().c || 0 : 0;
          crushStats.messages = tableExists('messages') ? cdb.prepare('SELECT COUNT(*) as c FROM messages').get().c || 0 : 0;
          crushStats.promptTokens = columnExists('sessions', 'prompt_tokens') ? cdb.prepare('SELECT SUM(prompt_tokens) as s FROM sessions').get().s || 0 : 0;
          crushStats.completionTokens = columnExists('sessions', 'completion_tokens') ? cdb.prepare('SELECT SUM(completion_tokens) as s FROM sessions').get().s || 0 : 0;
          crushStats.files = tableExists('files') ? cdb.prepare('SELECT COUNT(*) as c FROM files').get().c || 0 : 0;

          // Parse tool calls, reasoning, and tool results from messages
          const msgs = tableExists('messages') ? cdb.prepare('SELECT parts FROM messages ORDER BY created_at DESC LIMIT 5000').all() : [];
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

    // Keep the dashboard fast. Calling the local crush wrapper can open an interactive menu.
    const crushVersion = 'local';

    res.json({
      requests: { total: totalRequests + (ledgerTotals.requests || 0), totalTokens, totalCost, byProvider, byUser, inputTokens: ledgerTotals.inputTokens || 0, outputTokens: (ledgerTotals.outputTokens || 0) + totalToolCalls },
      sessions: { total: sessionCount, active: activeSessions, messages: messageCount, artifacts: artifactCount },
      system: { cpus, totalMem, freeMem, uptime, hostname: os.hostname(), platform: os.platform(), arch: os.arch() },
      services: runningServices,
      crush: { model: crushModel, provider: crushProvider, version: crushVersion, stats: crushStats },
      agent: { tools: toolInventory, skills: skillsInventory },
      providers: Object.entries(PROVIDERS)
        .filter(([key, cfg]) => !isCerebrasValue(key) && !isCerebrasValue(cfg.name) && !isCerebrasValue(cfg.defaultModel))
        .map(([key, cfg]) => ({ id: key, name: cfg.name, type: cfg.type, defaultModel: cfg.defaultModel })),
    });
  } catch (err) {
    console.error('[dashboard] stats error:', err);
    res.status(500).json({ error: 'dashboard stats failed', detail: err.message });
  }
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
    // Update crush DATA file (runtime). Keep this best-effort: Chat tab model
    // selection must still work even when the server inherited HOME=/root.
    const userHome = process.env.HAKSTER_HOME || (process.env.HOME && process.env.HOME !== '/root' ? process.env.HOME : '/home/ghost');
    const crushDataPath = path.join(userHome, '.local/share/crush/crush.json');
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
    try {
      fs.mkdirSync(path.dirname(crushDataPath), { recursive: true });
      fs.writeFileSync(crushDataPath, JSON.stringify(crushCfg, null, 2));
    } catch (e) { console.error('[crush] data update error:', e.message); }
    // Update crush CONFIG file (what crush reads on startup)
    const crushConfigDir = path.join(userHome, '.config/crush/crush.json');
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
    // The local `crush` wrapper is interactive, so never call it from the web server.
    const currentVer = 'local';
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

// ── User activity & tracking ──────────────────────────────────────
app.get('/api/users/activity', (req, res) => {
  const db = getDb();
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const action = req.query.action;
  let query = `SELECT ua.*, u.username, u.email
    FROM user_activity ua LEFT JOIN users u ON ua.user_id = u.id`;
  const params = [];
  if (action) { query += ` WHERE ua.action = ?`; params.push(action); }
  query += ` ORDER BY ua.created_at DESC LIMIT ?`;
  params.push(limit);
  const activity = db.prepare(query).all(...params);
  res.json({ activity, count: activity.length });
});

app.get('/api/users/recent', (req, res) => {
  const db = getDb();
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const users = db.prepare(
    `SELECT u.id, u.username, u.email, u.role, u.plan, u.status, u.created_at, u.last_login_at, u.last_login_ip,
     (SELECT COUNT(*) FROM user_activity ua WHERE ua.user_id = u.id AND ua.action = 'login') as login_count,
     (SELECT ua.ip_address FROM user_activity ua WHERE ua.user_id = u.id ORDER BY ua.created_at DESC LIMIT 1) as last_ip,
     (SELECT ua.device_type FROM user_activity ua WHERE ua.user_id = u.id ORDER BY ua.created_at DESC LIMIT 1) as last_device,
     (SELECT ua.os_name FROM user_activity ua WHERE ua.user_id = u.id ORDER BY ua.created_at DESC LIMIT 1) as last_os,
     (SELECT ua.browser FROM user_activity ua WHERE ua.user_id = u.id ORDER BY ua.created_at DESC LIMIT 1) as last_browser,
     (SELECT ua.user_agent FROM user_activity ua WHERE ua.user_id = u.id ORDER BY ua.created_at DESC LIMIT 1) as last_user_agent
     FROM users u ORDER BY u.created_at DESC LIMIT ?`
  ).all(limit);
  res.json({ users, count: users.length });
});

app.post('/api/users/track', (req, res) => {
  const db = getDb();
  const { action, userId, sessionId, device } = req.body;
  if (!action) return res.status(400).json({ error: 'action is required' });
  const ip = req.ip || req.connection?.remoteAddress || req.headers['x-forwarded-for'] || '';
  const userAgent = req.get('User-Agent') || '';
  const dev = device || {};
  db.prepare(
    `INSERT INTO user_activity (user_id, action, ip_address, user_agent, endpoint, method, device_type, os_name, browser, screen_size, language, timezone, session_id, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    userId || null, action, ip, userAgent, req.path, req.method,
    dev.deviceType || null, dev.osName || null, dev.browser || null,
    dev.screenSize || null, dev.language || null, dev.timezone || null,
    sessionId || null, JSON.stringify(dev.metadata || {})
  );
  res.json({ ok: true });
});

app.get('/api/users/:id', (req, res) => {
  const db = getDb();
  const user = db.prepare(`SELECT id, username, email, role, plan, status, created_at, updated_at, last_login_at, last_login_ip FROM users WHERE id = ?`).get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const accessLogs = db.prepare(`SELECT * FROM access_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`).all(req.params.id);
  const auditLogs = db.prepare(`SELECT * FROM api_key_audit WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`).all(req.params.id);
  const activity = db.prepare(`SELECT * FROM user_activity WHERE user_id = ? ORDER BY created_at DESC LIMIT 30`).all(req.params.id);
  const devices = db.prepare(`SELECT * FROM user_devices WHERE user_id = ? ORDER BY last_seen_at DESC`).all(req.params.id);
  const payments = db.prepare(`SELECT * FROM payments WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`).all(req.params.id);
  const subscription = db.prepare(`SELECT * FROM subscriptions WHERE user_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1`).get(req.params.id);
  res.json({ ...user, accessLogs, auditLogs, activity, devices, payments, subscription });
});

// ── User Devices API ──
app.get('/api/devices', (req, res) => {
  const db = getDb();
  const user = getUserByApiKey(req);
  if (!user) return res.status(401).json({ error: 'Authentication required' });
  const devices = db.prepare(`SELECT * FROM user_devices WHERE user_id = ? ORDER BY last_seen_at DESC`).all(user.id);
  res.json({ devices, count: devices.length });
});

// ── Server Fingerprint API ──
const { fingerprint: getServerFingerprint } = require('./fingerprint');
app.get('/api/fingerprint', (req, res) => {
  res.json(getServerFingerprint());
});

// ── Pentester Agent API ──
const { execSync } = require('child_process');
app.post('/api/pentester/run', (req, res) => {
  const target = (req.body && req.body.target) || '';
  if (!target) return res.status(400).json({ error: 'target required' });

  // Basic validation — reject obviously invalid targets
  if (!/^[\w.\-:/]+$/.test(target)) return res.status(400).json({ error: 'Invalid target format' });

  const scriptDir = path.join(__dirname, '..', '..', 'scripts');
  try {
    const raw = execSync(`cd ${JSON.stringify(scriptDir)} && python3 pentester_agent.py ${JSON.stringify(target)} 2>&1`, {
      encoding: 'utf-8',
      timeout: 60000,
      maxBuffer: 1024 * 1024 * 10,
    });
    // Parse the two JSON blocks (plan + final state)
    const blocks = raw.split(/\n(?=\{)/).filter(b => b.trim().startsWith('{'));
    const plan = blocks.length > 0 ? JSON.parse(blocks[0]) : null;
    const finalState = blocks.length > 1 ? JSON.parse(blocks[1]) : null;
    res.json({ ok: true, plan, state: finalState, raw });
  } catch (err) {
    res.status(500).json({ error: err.message, stdout: err.stdout || '' });
  }
});

// ── Pentester tools (real implementations) ──
app.post('/api/pentester/scan', (req, res) => {
  const { target, tool } = req.body || {};
  if (!target) return res.status(400).json({ error: 'target required' });

  const allowedTools = {
    port_scan: `nmap -sT -T4 --top-ports 1000 ${JSON.stringify(target)} 2>&1`,
    os_probe: `nmap -O ${JSON.stringify(target)} 2>&1`,
    http_probe: `curl -sI --max-time 10 ${JSON.stringify(target)} 2>&1 | head -30`,
    dir_enum: `gobuster dir -u ${JSON.stringify('http://' + target)} -w /usr/share/wordlists/dirb/common.txt -q 2>&1 | head -50`,
    service_map: `nmap -sV ${JSON.stringify(target)} 2>&1`,
    exploit_check: `searchsploit --nmap ${JSON.stringify(target)} 2>&1 || echo 'searchsploit not installed'`,
  };

  const cmd = allowedTools[tool];
  if (!cmd) return res.status(400).json({ error: `Unknown tool: ${tool}. Available: ${Object.keys(allowedTools).join(', ')}` });

  try {
    const output = execSync(cmd, { encoding: 'utf-8', timeout: 120000, maxBuffer: 1024 * 1024 * 10 });
    res.json({ ok: true, tool, target, output });
  } catch (err) {
    res.json({ ok: true, tool, target, output: err.stdout || err.message });
  }
});

app.get('/api/pentester/fingerprint', (req, res) => {
  try {
    const scriptDir = path.join(__dirname, '..', '..', 'scripts');
    const raw = execSync(`cd ${JSON.stringify(scriptDir)} && python3 pentester_fingerprint.py 2>&1`, {
      encoding: 'utf-8',
      timeout: 10000,
    });
    res.json(JSON.parse(raw));
  } catch (err) {
    // Fallback to JS fingerprint
    res.json(getServerFingerprint());
  }
});

app.post('/api/devices/:id/trust', (req, res) => {
  const db = getDb();
  const user = getUserByApiKey(req);
  if (!user) return res.status(401).json({ error: 'Authentication required' });
  db.prepare('UPDATE user_devices SET is_trusted = 1 WHERE id = ? AND user_id = ?').run(req.params.id, user.id);
  res.json({ ok: true });
});

app.delete('/api/devices/:id', (req, res) => {
  const db = getDb();
  const user = getUserByApiKey(req);
  if (!user) return res.status(401).json({ error: 'Authentication required' });
  db.prepare('DELETE FROM user_devices WHERE id = ? AND user_id = ?').run(req.params.id, user.id);
  res.json({ ok: true });
});

// ── Receipts / Payments API ──
app.get('/api/receipts', (req, res) => {
  const db = getDb();
  const user = getUserByApiKey(req);
  if (!user) return res.status(401).json({ error: 'Authentication required' });
  const receipts = db.prepare(`SELECT * FROM payments WHERE user_id = ? ORDER BY created_at DESC`).all(user.id);
  res.json({ receipts, count: receipts.length });
});

app.get('/api/receipts/:id', (req, res) => {
  const db = getDb();
  const user = getUserByApiKey(req);
  if (!user) return res.status(401).json({ error: 'Authentication required' });
  const receipt = db.prepare(`SELECT * FROM payments WHERE id = ? AND user_id = ?`).get(req.params.id, user.id);
  if (!receipt) return res.status(404).json({ error: 'Receipt not found' });
  res.json(receipt);
});

app.post('/api/receipts', (req, res) => {
  const db = getDb();
  const user = getUserByApiKey(req);
  if (!user) return res.status(401).json({ error: 'Authentication required' });
  const { amount, currency, plan, billing_cycle, payment_method, provider_id, description, metadata } = req.body;
  const receiptId = 'rcpt_' + crypto.randomBytes(16).toString('hex');
  db.prepare(`INSERT INTO payments (id, user_id, amount, currency, plan, billing_cycle, status, payment_method, provider_id, description, metadata) VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?)`)
    .run(receiptId, user.id, amount || 0, currency || 'USD', plan || 'pro', billing_cycle || 'monthly', payment_method || 'stripe', provider_id || null, description || null, metadata ? JSON.stringify(metadata) : null);
  const receipt = db.prepare(`SELECT * FROM payments WHERE id = ?`).get(receiptId);
  res.json({ ok: true, receipt });
});

// ── Subscriptions API ──
app.get('/api/subscription', (req, res) => {
  const db = getDb();
  const user = getUserByApiKey(req);
  if (!user) return res.status(401).json({ error: 'Authentication required' });
  const sub = db.prepare(`SELECT * FROM subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`).get(user.id);
  res.json({ subscription: sub || null });
});

app.post('/api/subscription', (req, res) => {
  const db = getDb();
  const user = getUserByApiKey(req);
  if (!user) return res.status(401).json({ error: 'Authentication required' });
  const { plan, billing_cycle, current_period_start, current_period_end, provider_sub_id, payment_id, metadata } = req.body;
  const subId = 'sub_' + crypto.randomBytes(16).toString('hex');
  // Deactivate previous subscriptions
  db.prepare('UPDATE subscriptions SET status = ? WHERE user_id = ? AND status = ?', 'expired', user.id, 'active').run();
  db.prepare(`INSERT INTO subscriptions (id, user_id, plan, billing_cycle, status, current_period_start, current_period_end, provider_sub_id, payment_id, metadata) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`)
    .run(subId, user.id, plan || 'pro', billing_cycle || 'monthly', current_period_start || null, current_period_end || null, provider_sub_id || null, payment_id || null, metadata ? JSON.stringify(metadata) : null);
  // Update user plan
  db.prepare('UPDATE users SET plan = ?, updated_at = unixepoch() WHERE id = ?').run(plan || 'pro', user.id);
  const sub = db.prepare(`SELECT * FROM subscriptions WHERE id = ?`).get(subId);
  res.json({ ok: true, subscription: sub });
});

app.get('/api/pricing', (_req, res) => {
  res.json({
    currency: 'usd',
    plans: PRICING_CATALOG,
    stripe: {
      configured: Boolean(process.env.STRIPE_SECRET_KEY),
      publishableKeyConfigured: Boolean(process.env.STRIPE_PUBLISHABLE_KEY),
    },
  });
});

// ── Google OAuth ──────────────────────────────────────────────────
let GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
let GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';

// Auto-load from downloaded client JSON if env vars are missing
if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
  try {
    const clientJsonPath = process.env.GOOGLE_OAUTH_CLIENT_JSON
      ? path.resolve(__dirname, '..', process.env.GOOGLE_OAUTH_CLIENT_JSON)
      : path.join(__dirname, '..', 'google-oauth-client.json');
    const raw = fs.readFileSync(clientJsonPath, 'utf8');
    const parsed = JSON.parse(raw);
    const cfg = parsed.web || parsed.installed;
    if (cfg && cfg.client_id && cfg.client_secret) {
      GOOGLE_CLIENT_ID = cfg.client_id;
      GOOGLE_CLIENT_SECRET = cfg.client_secret;
      console.log('[oauth] loaded google client from', clientJsonPath);
    }
  } catch (e) {
    // ignore — env vars are the explicit source of truth
  }
}

app.get('/api/auth/google/client-id', (_req, res) => {
  res.json({ clientId: GOOGLE_CLIENT_ID, configured: !!GOOGLE_CLIENT_ID });
});

app.get('/api/auth/me', (req, res) => {
  const user = getUserByApiKey(req);
  if (!user) return res.status(401).json({ error: 'Invalid or missing API key' });
  const db = getDb();
  const referralCode = ensureReferralCode(db, user);
  res.json({
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      plan: user.plan,
      status: user.status,
      referralCode,
      tokenBalance: user.token_balance || 0,
    },
  });
});

// Redirect to Google OAuth consent screen
app.get('/api/auth/google/redirect', (req, res) => {
  if (!GOOGLE_CLIENT_ID) return res.status(500).json({ error: 'Google OAuth not configured' });
  // Use a canonical redirect URI — strip www, always use same proto/host
  const proto = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
  let host = req.hostname || 'localhost';
  // Strip www. prefix so redirect_uri always matches
  if (host.startsWith('www.')) host = host.slice(4);
  const port = (host === 'localhost' || host === '127.0.0.1') ? `:${req.socket.localPort}` : '';
  const redirectUri = `${proto}://${host}${port}/api/auth/google/callback`;
  const state = makeOAuthState(req.query.ref || req.query.referral || '');
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'offline',
    prompt: 'select_account',
    state,
  });
  res.redirect(`https://accounts.google.com/o/oauth2/auth?${params.toString()}`);
});

// Google OAuth callback
app.get('/api/auth/google/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.redirect(`/build?google_error=${encodeURIComponent(error)}`);
  if (!code) return res.redirect('/build?google_error=no_code');
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) return res.redirect('/build?google_error=not_configured');

  try {
    const oauthState = parseOAuthState(req.query.state);
    const referralCode = normalizeReferralCode(oauthState.ref);
    const proto = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
    let host = req.hostname || 'localhost';
    if (host.startsWith('www.')) host = host.slice(4);
    const port = (host === 'localhost' || host === '127.0.0.1') ? `:${req.socket.localPort}` : '';
    const redirectUri = `${proto}://${host}${port}/api/auth/google/callback`;

    // Exchange authorization code for tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    if (!tokenRes.ok) {
      const errBody = await tokenRes.text();
      console.error('Google token exchange failed:', errBody);
      return res.redirect(`/build?google_error=token_exchange_failed`);
    }
    const tokens = await tokenRes.json();
    const idToken = tokens.id_token;
    if (!idToken) return res.redirect('/build?google_error=no_id_token');

    // Verify the ID token
    const verifyRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
    if (!verifyRes.ok) return res.redirect('/build?google_error=invalid_token');
    const payload = await verifyRes.json();
    if (payload.aud !== GOOGLE_CLIENT_ID) return res.redirect('/build?google_error=audience_mismatch');
    if (payload.exp && parseInt(payload.exp) < Math.floor(Date.now() / 1000)) return res.redirect('/build?google_error=expired_token');

    const googleId = payload.sub;
    const email = payload.email || '';
    const name = payload.name || email.split('@')[0] || 'google_user';
    const picture = payload.picture || '';
    const ip = req.ip || req.connection?.remoteAddress || req.headers['x-forwarded-for'] || '';
    const userAgent = req.get('User-Agent') || '';

    const db = getDb();

    // Check if user exists
    let user = db.prepare('SELECT * FROM users WHERE google_id = ?').get(googleId);
    let wasSignup = false;

    if (!user && email) {
      user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
      if (user) {
        db.prepare('UPDATE users SET google_id = ?, updated_at = unixepoch(), last_login_at = unixepoch(), last_login_ip = ? WHERE id = ?')
          .run(googleId, ip, user.id);
      }
    }

    // Owner accounts always get admin role + enterprise plan on login
    const OWNER_EMAILS = ['dekekenneth840@gmail.com', 'dekoneed@gmail.com', 'dekeneed@yahoo.com', 'savannahscott899@gmail.com'];
    const OWNER_IDS = {
      'dekekenneth840@gmail.com': '1234',
      'dekoneed@gmail.com': '1235',
      'dekeneed@yahoo.com': '1236',
      'savannahscott899@gmail.com': '1237'
    };
    const isOwner = email && OWNER_EMAILS.includes(email.toLowerCase().trim());

    if (!user) {
      wasSignup = true;
      const id = isOwner ? OWNER_IDS[email.toLowerCase().trim()] : uuidv4();
      const apiKey = 'hkai_' + require('crypto').randomBytes(24).toString('hex');
      const username = name.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 30) || ('g_' + googleId.slice(0, 8));
      db.prepare(
        'INSERT INTO users (id, username, email, api_key, google_id, role, plan, status, last_login_at, last_login_ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), ?)'
      ).run(id, username, email, apiKey, googleId, isOwner ? 'admin' : 'user', isOwner ? 'enterprise' : 'free', 'active', ip);
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
      ensureReferralCode(db, user);
      if (!isOwner) applyReferralCredit(db, user, referralCode);
    } else {
      db.prepare('UPDATE users SET last_login_at = unixepoch(), last_login_ip = ?, updated_at = unixepoch(), role = COALESCE(?, role), plan = COALESCE(?, plan) WHERE id = ?')
        .run(ip, isOwner ? 'admin' : null, isOwner ? 'enterprise' : null, user.id);
      ensureReferralCode(db, user);
    }
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);

    // Log to access_logs
    db.prepare('INSERT INTO access_logs (user_id, ip_address, user_agent, endpoint, method, status_code) VALUES (?, ?, ?, ?, ?, ?)')
      .run(user.id, ip, userAgent, '/auth/google/callback', 'GET', 200);

    // Log to user_activity
    db.prepare(
      `INSERT INTO user_activity (user_id, action, ip_address, user_agent, endpoint, method, status_code, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(user.id, wasSignup ? 'signup' : 'login', ip, userAgent, '/auth/google/callback', 'GET', 200,
      JSON.stringify({ googleId: googleId.slice(0, 8) + '...', email, name, picture: picture ? true : false }));

    // Push real-time notification
    notifPush(`👤 ${wasSignup ? 'New user' : 'Login'}: ${user.username} (${email}) from ${ip}`, {
      type: wasSignup ? 'user_signup' : 'user_login',
      priority: wasSignup ? 'high' : 'normal',
      source: 'auth',
    });

    // Encode user data into redirect URL for frontend to pick up
    const userData = encodeURIComponent(JSON.stringify({
      ok: true,
      isNewUser: wasSignup,
      user: { id: user.id, username: user.username, email: user.email, role: user.role, plan: user.plan, picture, apiKey: user.api_key, referralCode: user.referral_code, tokenBalance: user.token_balance || 0 },
      apiKey: user.api_key,
    }));
    res.redirect(`/build?google_auth=${userData}`);
  } catch (err) {
    console.error('Google OAuth callback error:', err);
    res.redirect(`/build?google_error=${encodeURIComponent(err.message || 'unknown')}`);
  }
});

// ── Usage tracking & limits ───────────────────────────────────────
function getUserByApiKey(req) {
  const apiKey = req.headers['x-api-key'] || req.body?.apiKey;
  if (!apiKey) return null;
  const db = getDb();
  return db.prepare('SELECT * FROM users WHERE api_key = ?').get(apiKey);
}

function checkUsageLimit(user) {
  if (!USAGE_LIMIT_ENABLED) return { allowed: true };
  if (!user) return { allowed: true }; // no user = no tracking, let it through
  if (user.plan !== 'free') return { allowed: true, plan: user.plan }; // paid plans unlimited
  const now = Math.floor(Date.now() / 1000);
  // Reset count if reset period passed
  if (user.usage_reset_at && now > user.usage_reset_at) {
    const db = getDb();
    db.prepare('UPDATE users SET usage_count = 0, usage_reset_at = ? WHERE id = ?').run(now + USAGE_RESET_DAYS * 86400, user.id);
    user.usage_count = 0;
    user.usage_reset_at = now + USAGE_RESET_DAYS * 86400;
  }
  if (user.usage_count >= FREE_USAGE_LIMIT) {
    return { allowed: false, limit: FREE_USAGE_LIMIT, used: user.usage_count, plan: user.plan };
  }
  return { allowed: true, used: user.usage_count, limit: FREE_USAGE_LIMIT, plan: user.plan };
}

function incrementUsage(user) {
  if (!user) return;
  const db = getDb();
  // Set reset_at if not yet set
  if (!user.usage_reset_at) {
    db.prepare('UPDATE users SET usage_count = usage_count + 1, usage_reset_at = ? WHERE id = ?')
      .run(Math.floor(Date.now() / 1000) + USAGE_RESET_DAYS * 86400, user.id);
  } else {
    db.prepare('UPDATE users SET usage_count = usage_count + 1 WHERE id = ?').run(user.id);
  }
}

// GET /api/usage — returns current usage stats for the authenticated user
app.get('/api/usage', (req, res) => {
  const user = getUserByApiKey(req);
  if (!user) return res.status(401).json({ error: 'Invalid or missing API key' });
  const db = getDb();
  const referralCode = ensureReferralCode(db, user);
  const tokenUsage = db.prepare(
    `SELECT
       COUNT(*) as requests,
       COALESCE(SUM(input_tokens), 0) as inputTokens,
       COALESCE(SUM(output_tokens), 0) as outputTokens,
       COALESCE(SUM(tool_calls), 0) as toolCalls,
       MAX(created_at) as lastUsedAt
     FROM user_token_usage
     WHERE user_id = ?`
  ).get(user.id) || {};
  res.json({
    plan: user.plan,
    used: user.usage_count || 0,
    limit: user.plan === 'free' ? FREE_USAGE_LIMIT : -1, // -1 = unlimited
    remaining: user.plan === 'free' ? Math.max(0, FREE_USAGE_LIMIT - (user.usage_count || 0)) : -1,
    tokenBalance: user.token_balance || 0,
    tokenUsage: {
      requests: tokenUsage.requests || 0,
      inputTokens: tokenUsage.inputTokens || 0,
      outputTokens: tokenUsage.outputTokens || 0,
      totalTokens: (tokenUsage.inputTokens || 0) + (tokenUsage.outputTokens || 0),
      toolCalls: tokenUsage.toolCalls || 0,
      lastUsedAt: tokenUsage.lastUsedAt || null,
    },
    referralCode,
    limitEnabled: USAGE_LIMIT_ENABLED,
    resetAt: user.usage_reset_at || null,
  });
});

app.get('/api/referrals', (req, res) => {
  const db = getDb();
  const user = getUserByApiKey(req);
  if (!user) return res.status(401).json({ error: 'Invalid or missing API key' });
  const referralCode = ensureReferralCode(db, user);
  const origin = `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}`;
  const referrals = db.prepare(
    `SELECT r.id, r.referral_code, r.reward_tokens, r.referred_tokens, r.status, r.created_at,
            u.username, u.email
       FROM referrals r
       LEFT JOIN users u ON u.id = r.referred_user_id
      WHERE r.referrer_user_id = ?
      ORDER BY r.created_at DESC
      LIMIT 100`
  ).all(user.id);
  const totals = db.prepare(
    `SELECT COUNT(*) as count, COALESCE(SUM(reward_tokens), 0) as earned
       FROM referrals
      WHERE referrer_user_id = ? AND status = 'credited'`
  ).get(user.id);
  res.json({
    referralCode,
    referralLink: `${origin}/?ref=${encodeURIComponent(referralCode || '')}`,
    tokenBalance: user.token_balance || 0,
    rewardTokens: REFERRAL_REWARD_TOKENS,
    signupTokens: REFERRAL_SIGNUP_TOKENS,
    totalReferrals: totals?.count || 0,
    totalEarned: totals?.earned || 0,
    referrals,
  });
});

app.post('/api/auth/google', async (req, res) => {
  const { credential, device } = req.body;
  const referralCode = normalizeReferralCode(req.body?.referralCode || req.body?.ref || '');
  if (!credential) return res.status(400).json({ error: 'credential (JWT) is required' });
  if (!GOOGLE_CLIENT_ID) return res.status(500).json({ error: 'Google OAuth not configured — set GOOGLE_CLIENT_ID in .env' });

  try {
    // Verify the Google ID token via Google's tokeninfo endpoint
    const verifyRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`);
    if (!verifyRes.ok) return res.status(401).json({ error: 'Invalid Google token' });
    const payload = await verifyRes.json();

    // Verify audience matches our client ID
    if (payload.aud !== GOOGLE_CLIENT_ID) {
      return res.status(401).json({ error: 'Token audience mismatch' });
    }

    // Verify token hasn't expired
    if (payload.exp && parseInt(payload.exp) < Math.floor(Date.now() / 1000)) {
      return res.status(401).json({ error: 'Token expired' });
    }

    // Verify issuer
    if (payload.iss && !payload.iss.includes('accounts.google.com') && !payload.iss.includes('google.com')) {
      return res.status(401).json({ error: 'Invalid token issuer' });
    }

    const googleId = payload.sub;
    const email = payload.email || '';
    const name = payload.name || email.split('@')[0] || 'google_user';
    const picture = payload.picture || '';
    const ip = req.ip || req.connection?.remoteAddress || req.headers['x-forwarded-for'] || '';
    const userAgent = req.get('User-Agent') || '';
    const db = getDb();

    const OWNER_EMAILS = ['dekekenneth840@gmail.com', 'dekoneed@gmail.com', 'dekeneed@yahoo.com', 'savannahscott899@gmail.com'];
    const OWNER_IDS = {
      'dekekenneth840@gmail.com': '1234',
      'dekoneed@gmail.com': '1235',
      'dekeneed@yahoo.com': '1236',
      'savannahscott899@gmail.com': '1237'
    };
    const isOwner = email && OWNER_EMAILS.includes(email.toLowerCase().trim());

    const isNewUser = !db.prepare('SELECT 1 FROM users WHERE google_id = ? OR (email = ? AND email != "")').get(googleId, email);

    // Check if user exists by google_id
    let user = db.prepare('SELECT * FROM users WHERE google_id = ?').get(googleId);

    if (!user && email) {
      // Check by email — link existing account
      user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
      if (user) {
        db.prepare('UPDATE users SET google_id = ?, updated_at = unixepoch(), last_login_at = unixepoch(), last_login_ip = ?, role = COALESCE(?, role), plan = COALESCE(?, plan) WHERE id = ?')
          .run(googleId, ip, isOwner ? 'admin' : null, isOwner ? 'enterprise' : null, user.id);
      }
    }

    let wasSignup = false;
    if (!user) {
      // Create new user
      wasSignup = true;
      const id = isOwner ? OWNER_IDS[email.toLowerCase().trim()] : uuidv4();
      const apiKey = 'hkai_' + require('crypto').randomBytes(24).toString('hex');
      const username = name.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 30) || ('g_' + googleId.slice(0, 8));
      db.prepare(
        'INSERT INTO users (id, username, email, api_key, google_id, role, plan, status, last_login_at, last_login_ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), ?)'
      ).run(id, username, email, apiKey, googleId, isOwner ? 'admin' : 'user', isOwner ? 'enterprise' : 'free', 'active', ip);
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
      ensureReferralCode(db, user);
      if (!isOwner) applyReferralCredit(db, user, referralCode);
    } else {
      // Update last login, promote owner if needed
      db.prepare('UPDATE users SET last_login_at = unixepoch(), last_login_ip = ?, updated_at = unixepoch(), role = COALESCE(?, role), plan = COALESCE(?, plan) WHERE id = ?')
        .run(ip, isOwner ? 'admin' : null, isOwner ? 'enterprise' : null, user.id);
      ensureReferralCode(db, user);
    }
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);

    // Log to access_logs
    db.prepare('INSERT INTO access_logs (user_id, ip_address, user_agent, endpoint, method, status_code) VALUES (?, ?, ?, ?, ?, ?)')
      .run(user.id, ip, userAgent, '/api/auth/google', 'POST', 200);

    // Log to user_activity with full device tracking
    const dev = device || {};
    db.prepare(
      `INSERT INTO user_activity (user_id, action, ip_address, user_agent, endpoint, method, status_code, device_type, os_name, browser, screen_size, language, timezone, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      user.id,
      wasSignup ? 'signup' : 'login',
      ip,
      userAgent,
      '/api/auth/google',
      'POST',
      200,
      dev.deviceType || null,
      dev.osName || null,
      dev.browser || null,
      dev.screenSize || null,
      dev.language || null,
      dev.timezone || null,
      JSON.stringify({ googleId: googleId.slice(0, 8) + '...', email, name, picture: picture ? true : false })
    );

    // Push real-time notification to dashboard
    notifPush(`👤 ${wasSignup ? 'New user' : 'Login'}: ${user.username} (${email}) from ${ip}`, {
      type: wasSignup ? 'user_signup' : 'user_login',
      priority: wasSignup ? 'high' : 'normal',
      source: 'auth',
    });

    res.json({
      ok: true,
      isNewUser: wasSignup,
      user: { id: user.id, username: user.username, email: user.email, role: user.role, plan: user.plan, picture, referralCode: user.referral_code, tokenBalance: user.token_balance || 0 },
      apiKey: user.api_key,
    });
  } catch (err) {
    res.status(500).json({ error: 'Google auth failed: ' + err.message });
  }
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

// Wire skills.js auto-update events to WS broadcast
try {
  const { events: skillsEvents } = require('./skills');
  skillsEvents.on('update', ({ count, delta }) => {
    if (typeof wss !== 'undefined' && wss && wss.clients) {
      const payload = JSON.stringify({
        type: 'notification',
        notificationType: 'skills_update',
        message: delta > 0
          ? `📚 Skill library updated: ${count} skills${delta > 0 ? ` (+${delta} new)` : ''}`
          : `📚 Skill library refreshed: ${count} skills`,
        priority: 'normal',
        source: 'skills',
        timestamp: new Date().toISOString(),
      });
      wss.clients.forEach(client => {
        if (client.readyState === 1) client.send(payload);
      });
    }
  });
  console.log('[ws] Skills auto-update broadcaster wired');
} catch (e) {
  console.log('[ws] Skills broadcaster skipped:', e.message);
}

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

// Track active crush PTY processes to prevent duplicate DB locks
let activeCrushPty = null;

ptyWss.on('connection', (ws, req) => {
  let ptyProcess = null;
  let closed = false;

  let ptyMode = 'crush';
  try {
    const url = new URL(req.url || '/pty', 'http://localhost');
    ptyMode = url.searchParams.get('mode') === 'shell' ? 'shell' : 'crush';
  } catch {}

  // Identify logged-in user from API key passed as query param
  let userName = 'Ghost';
  let userEmail = '';
  let userHandle = '';
  try {
    const url = new URL(req.url || '/pty', 'http://localhost');
    const apiKey = url.searchParams.get('key');
    if (apiKey) {
      const db = getDb();
      const u = db.prepare('SELECT username, email FROM users WHERE api_key = ?').get(apiKey);
      if (u) {
        userName = u.username || 'Ghost';
        userEmail = u.email || '';
        userHandle = '@' + userName;
        console.log(`[pty] identified user: ${userName} (${userEmail})`);
      }
    }
  } catch (e) { console.log('[pty] user lookup error:', e.message); }

  // Kill any existing crush process before spawning a new one
  // to prevent "read only database" errors from concurrent SQLite access
  if (activeCrushPty && ptyMode === 'crush') {
    try {
      console.log('[pty] killing previous crush process before spawning new one');
      activeCrushPty.kill('SIGTERM');
      setTimeout(() => { try { activeCrushPty.kill('SIGKILL'); } catch {} }, 100);
    } catch {}
    activeCrushPty = null;
  }

  // Detect client OS/browser from WebSocket request headers
  const clientUA = req.headers['user-agent'] || '';
  const clientIP = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || '';
  let clientOS = 'Unknown';
  let clientBrowser = 'Unknown';
  let clientDevice = 'desktop';
  if (clientUA) {
    if (/Windows NT 10/i.test(clientUA)) clientOS = 'Windows 10/11';
    else if (/Windows NT/i.test(clientUA)) clientOS = 'Windows';
    else if (/Android/i.test(clientUA)) { clientOS = 'Android ' + (clientUA.match(/Android ([0-9.]+)/)?.[1] || ''); clientDevice = 'mobile'; }
    else if (/iPhone|iPad|iPod/i.test(clientUA)) { clientOS = 'iOS ' + (clientUA.match(/OS ([0-9_]+)/)?.[1]?.replace(/_/g, '.') || ''); clientDevice = /iPad/.test(clientUA) ? 'tablet' : 'mobile'; }
    else if (/Mac OS X/i.test(clientUA)) clientOS = 'macOS ' + (clientUA.match(/Mac OS X ([0-9_.]+)/)?.[1] || '').replace(/_/g, '.');
    else if (/Linux/i.test(clientUA)) clientOS = 'Linux';
    if (/Edg\//i.test(clientUA)) clientBrowser = 'Edge ' + (clientUA.match(/Edg\/([0-9.]+)/)?.[1] || '');
    else if (/Chrome/i.test(clientUA)) clientBrowser = 'Chrome ' + (clientUA.match(/Chrome\/([0-9.]+)/)?.[1] || '');
    else if (/Firefox/i.test(clientUA)) clientBrowser = 'Firefox ' + (clientUA.match(/Firefox\/([0-9.]+)/)?.[1] || '');
    else if (/Safari/i.test(clientUA)) clientBrowser = 'Safari ' + (clientUA.match(/Version\/([0-9.]+)/)?.[1] || '');
  }
  const crushBin = process.env.CRUSH_BIN || (fs.existsSync('/usr/local/bin/crush') ? '/usr/local/bin/crush' : 'crush');
  const shellBin = process.env.TERMINAL_SHELL || process.env.SHELL || '/bin/bash';
  const defaultTerminalCwd = fs.existsSync('/home/ghost/haksterAi') ? '/home/ghost/haksterAi' : '/home/ghost';
  const workDir = process.env.TERMINAL_CWD || process.env.FS_ROOT || defaultTerminalCwd;

  // Sync haksterAi model config into crush config before spawning crush
  // so crush always starts with the user's selected model, not cerebras default
  try {
    const hakCfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'hakster-config.json'), 'utf8'));
    // Update data file
    const crushHome = '/home/ghost'; // crush always runs as ghost — never use process.env.HOME (may be /root under PM2)
    const crushDataPath = path.join(crushHome, '.local/share/crush/crush.json');
    let crushCfg = {};
    try { crushCfg = JSON.parse(fs.readFileSync(crushDataPath, 'utf8')); } catch {}
    if (!crushCfg.models) crushCfg.models = {};
    if (!crushCfg.models.large) crushCfg.models.large = {};
    if (!crushCfg.models.small) crushCfg.models.small = {};
    if (hakCfg.model) { crushCfg.models.large.model = hakCfg.model; crushCfg.models.small.model = hakCfg.model; }
    if (hakCfg.provider) { crushCfg.models.large.provider = hakCfg.provider; crushCfg.models.small.provider = hakCfg.provider; }
    // Only give crush playwright + filesystem MCP to keep it fast on 4-core machine
    // haksterAi's agent API already has all 6 — crush doesn't need to duplicate them
    try {
      const mcpPath = path.join(__dirname, '..', '..', '.hakster', 'mcp.json');
      const mcpCfg = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
      if (mcpCfg.mcpServers) {
        crushCfg.mcp_servers = {};
        if (mcpCfg.mcpServers.playwright) crushCfg.mcp_servers.playwright = mcpCfg.mcpServers.playwright;
        if (mcpCfg.mcpServers.filesystem) crushCfg.mcp_servers.filesystem = mcpCfg.mcpServers.filesystem;
      }
    } catch (e) { console.log('[pty] MCP sync error:', e.message); }
    // Tell crush to read CRUSH.md as context
    crushCfg.context_paths = ['CRUSH.md', 'AGENTS.md'];
    crushCfg.global_context_paths = ['~/.config/crush/CRUSH.md'];
    fs.mkdirSync(path.dirname(crushDataPath), { recursive: true });
    fs.writeFileSync(crushDataPath, JSON.stringify(crushCfg, null, 2));
    // Update config file (what crush reads on startup)
    const crushConfigPath = path.join(crushHome, '.config/crush/crush.json');
    let crushConf = {};
    try { crushConf = JSON.parse(fs.readFileSync(crushConfigPath, 'utf8')); } catch {}
    crushConf.models = crushConf.models || {};
    crushConf.models.large = crushConf.models.large || {};
    crushConf.models.small = crushConf.models.small || {};
    if (hakCfg.model) { crushConf.models.large.model = hakCfg.model; crushConf.models.small.model = hakCfg.model; }
    if (hakCfg.provider) { crushConf.models.large.provider = hakCfg.provider; crushConf.models.small.provider = hakCfg.provider; }
    // Only playwright + filesystem for crush
    try {
      const mcpPath = path.join(__dirname, '..', '..', '.hakster', 'mcp.json');
      const mcpCfg = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
      if (mcpCfg.mcpServers) {
        crushConf.mcp_servers = {};
        if (mcpCfg.mcpServers.playwright) crushConf.mcp_servers.playwright = mcpCfg.mcpServers.playwright;
        if (mcpCfg.mcpServers.filesystem) crushConf.mcp_servers.filesystem = mcpCfg.mcpServers.filesystem;
      }
    } catch (e) { console.log('[pty] MCP config sync error:', e.message); }
    // Tell crush to read CRUSH.md as context
    crushConf.context_paths = ['CRUSH.md', 'AGENTS.md'];
    crushConf.global_context_paths = ['~/.config/crush/CRUSH.md'];
    fs.mkdirSync(path.dirname(crushConfigPath), { recursive: true });
    fs.writeFileSync(crushConfigPath, JSON.stringify(crushConf, null, 2));

    // Write CRUSH.md context file so crush knows who the user is and what machine they're on
    try {
      const crushMdPath = path.join(workDir, 'CRUSH.md');
      const crushMd = [
        '# haksterAi CrushTerminal Context',
        '',
        '## Current User (auto-detected from login)',
        `- Username: ${userName}`,
        `- Handle: ${userHandle || '@' + userName}`,
        userEmail ? `- Email: ${userEmail}` : '',
        '- Identity: pentester under haksterAi',
        '',
        '## Client Machine (auto-detected)',
        `- OS: ${clientOS}`,
        `- Browser: ${clientBrowser}`,
        `- Device: ${clientDevice}`,
        `- IP: ${clientIP}`,
        '',
        '## Server Machine',
        '- OS: Linux (Ubuntu, AMD A12-9720P, 4 cores, ~7GB RAM)',
        '- Working directory: /home/ghost/haksterAi',
        '- Projects: CineVault, haksterAi, PhantomIDE, bug bounties',
        '',
        '## Available MCP Tools (crush)',
        '- playwright: Browser automation — USE THIS to check web pages, test UI, interact with browsers',
        '- filesystem: File operations on /home/ghost',
        '',
        '## Additional MCP Tools (via haksterAi agent API)',
        '- nmap: Network scanning and port detection',
        '- sqlite: SQLite database queries on /home/ghost/haksterAi/data/mcp.db',
        '- memory: Persistent memory across sessions',
        '- sequential-thinking: Step-by-step reasoning for complex problems',
        '',
        '## Instructions',
        '- When asked to "check the browser" or "check web pages", USE the playwright MCP tool — do NOT just say you can\'t access it',
        '- When asked about the machine, refer to the Client Machine and Server Machine sections above',
        '- The user is ' + userName + ' — greet them by name when they say "yo" or greet you',
        '- The user connects from different devices — always check the Client Machine section for current device info',
        '- Brand stays "haksterAi" — never rename',
        '- When the user says "yo" or greets you, acknowledge them by name',
        '',
      ].filter(Boolean).join('\n');
      fs.writeFileSync(crushMdPath, crushMd);
      // Ensure ghost owns the file (server may run as root in some configs)
      try { require('child_process').execSync('chown ghost:ghost ' + crushMdPath); } catch {}
      console.log(`[pty] wrote CRUSH.md context (user=${userName}, OS=${clientOS}, Browser=${clientBrowser}, IP=${clientIP})`);
    } catch (e) {
      console.log('[pty] failed to write CRUSH.md:', e.message);
    }
  } catch (e) {
    console.log('[pty] crush config sync error:', e.message);
  }

  try {
    const spawnBin = ptyMode === 'shell' ? shellBin : crushBin;
    const spawnArgs = ptyMode === 'shell' ? ['-l'] : ['--cwd', workDir];
    ptyProcess = pty.spawn(spawnBin, spawnArgs, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: workDir,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        HOME: '/home/ghost', // crush always runs as ghost — never inherit PM2's /root
      }
    });
    console.log(`[pty] spawned ${ptyMode}: ${spawnBin} (pid=${ptyProcess.pid})`);
    if (ptyMode === 'crush') activeCrushPty = ptyProcess;
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
  }, 5000);

  // PTY output -> browser. Batch normal text by roughly 10 lines while still
  // flushing TUI screen updates quickly enough for Crush to feel live.
  let ptyOutBuffer = '';
  let ptyOutTimer = null;
  let ptyOutLineCount = 0;
  const flushPtyOutput = () => {
    ptyOutTimer = null;
    if (ws.readyState !== 1 || !ptyOutBuffer) return;
    const out = ptyOutBuffer;
    ptyOutBuffer = '';
    ptyOutLineCount = 0;
    try { ws.send(Buffer.from(out, 'utf8'), { binary: true }); } catch {}
  };
  ptyProcess.onData((data) => {
    if (ws.readyState !== 1) return;
    ptyOutBuffer += data;
    ptyOutLineCount += (data.match(/\n/g) || []).length;
    if (ptyOutBuffer.length >= 65536 || ptyOutLineCount >= 10) {
      flushPtyOutput();
    } else if (!ptyOutTimer) {
      ptyOutTimer = setTimeout(flushPtyOutput, ptyMode === 'crush' ? 16 : 40);
    }
  });

  ptyProcess.onExit(({ exitCode }) => {
    console.log(`[pty] ${ptyMode} exited (code=${exitCode})`);
    if (ptyMode === 'crush' && activeCrushPty === ptyProcess) activeCrushPty = null;
    if (ptyOutTimer) { clearTimeout(ptyOutTimer); ptyOutTimer = null; }
    flushPtyOutput();
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
    if (ptyOutTimer) { clearTimeout(ptyOutTimer); ptyOutTimer = null; }
    ptyOutBuffer = '';
    console.log(`[pty] client disconnected, killing ${ptyMode} (pid=${ptyProcess?.pid})`);
    if (ptyProcess) {
      try {
        // Send Ctrl+C then quit command for graceful exit
        ptyProcess.kill('SIGTERM');
        setTimeout(() => {
          try { ptyProcess.kill('SIGKILL'); } catch {}
        }, 100);
      } catch {}
    }
  });
});

// Upgrade handler — route /ws to chat WSS, /pty to PTY WSS.
server.on('upgrade', (req, socket, head) => {
  let pathname = req.url || '';
  try { pathname = new URL(req.url || '/', 'http://localhost').pathname; } catch {}
  if (pathname === '/pty') {
    ptyWss.handleUpgrade(req, socket, head, (ws) => {
      ptyWss.emit('connection', ws, req);
    });
  } else if (pathname === '/ws') {
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

// Initialize MCP servers (async, non-blocking)
initWebMcp();

server.listen(PORT, () => {
  console.log(`\n  ╔══════════════════════════════════════════╗`);
  console.log(`  ║  haksterAi server v1.0                   ║`);
  console.log(`  ║  http://localhost:${String(PORT).padEnd(5)}                ║`);
  console.log(`  ║  WS:   ws://localhost:${String(PORT).padEnd(5)}/ws           ║`);
  console.log(`  ║  Providers: ${Object.keys(PROVIDERS).join(', ').padEnd(26)}║`);
  console.log(`  ║  FS Root: ${FS_ROOT.substring(0, 30).padEnd(34)}║`);
  console.log(`  ╚══════════════════════════════════════════╝\n`);

  // Start background security scanner (5-min interval, notifies on persistent risks)
  startSecurityScanner(path.join(__dirname, '..'), CORS_ORIGINS, notifPush);
  console.log('  ✓ Security scanner started (5-min interval, persistent risk notifications)');

  // Start Telegram bot fleet
  telegramBots.initBots();
  telegramBots.sendDeployStatus('haksterAi server started');
});
