'use strict';

// ──────────────────────────────────────────────────────────────────────────
// haksterAi CLI — Memory, Knowledge, Trust, USB Sync, Machine Profile,
//                 and Token Budget systems
// Ported from phantom-cli.js:
//   - USB sync          (lines 86–145)
//   - Trust system      (lines 147–278)
//   - Token budget      (lines 417–422, 3209–3252)
//   - Knowledge base    (lines 1566–1638)
//   - Machine profile   (lines 1944–2081)
//   - Memory system     (lines 3249–3420)
//
// Rebranded:
//   .phantom-memory.json  → .hakster-memory.json  (fallback to old file)
//   phantom-knowledge.md  → hakster-knowledge.md  (fallback to old file)
//   .phantom-trust.json   → .hakster-trust.json   (fallback to old file)
//   All "phantom" user-facing strings → "hakster"
//
// Exports:
//   ── USB sync ──
//     findUSB(), findAllUSBs(), usbStatus()
//     syncFileToUSB(localPath, usbRoot), syncToUSB(files, usbRoot), syncToAllUSBs(files)
//   ── Trust ──
//     loadTrust(), saveTrust(cfg), isTrusted(filePath, cfg),
//     trustPath(p, cfg), untrustPath(p, cfg), askYN(question)
//   ── Token budget ──
//     tokenBudget(msg), estTokens(history), showTokenBar(history)
//   ── Knowledge base ──
//     loadKnowledgeBase(), getKnowledge(), getKnowledgeTrimmed(maxChars)
//   ── Machine profile ──
//     getMachineProfile(), formatMachineProfile(p),
//     scanGitRepos(), formatRepoAwareness()
//   ── Memory system ──
//     loadMemory(), saveMemory(mem), getMemoryText(),
//     memGetNotes(mem), memAddNote(mem, fact), memSetNotes(mem, arr),
//     memClear(mem), memLength(mem),
//     extractAndSaveMemory(userMsg, assistantMsg),
//     idleMemoryReview(rl, trustCfg, opts?), resetIdleTimer(rl, trustCfg, opts?)
//   ── Constants ──
//     HOME, CLI_ROOT, USB_PATHS, C,
//     MEMORY_FILE, TRUST_FILE, MEMORY_MAX_CHARS, IDLE_REVIEW_MS
// ──────────────────────────────────────────────────────────────────────────

const fs       = require('fs');
const path     = require('path');
const os       = require('os');
const readline = require('readline');
const { execSync } = require('child_process');

// ── Constants ──────────────────────────────────────────────────────────────
const HOME     = process.env.HOME || '/home/ghost';
const CLI_ROOT = path.dirname(fs.realpathSync(__filename));

// Rebranded file paths (with fallback to legacy phantom files)
const MEMORY_FILE_NEW = path.join(HOME, '.hakster-memory.json');
const MEMORY_FILE_OLD = path.join(HOME, '.phantom-memory.json');
const MEMORY_FILE     = fs.existsSync(MEMORY_FILE_NEW) ? MEMORY_FILE_NEW
                      : fs.existsSync(MEMORY_FILE_OLD) ? MEMORY_FILE_OLD
                      : MEMORY_FILE_NEW; // default write target when neither exists

const TRUST_FILE_NEW  = path.join(HOME, '.hakster-trust.json');
const TRUST_FILE_OLD  = path.join(HOME, '.phantom-trust.json');
const TRUST_FILE      = fs.existsSync(TRUST_FILE_NEW) ? TRUST_FILE_NEW
                      : fs.existsSync(TRUST_FILE_OLD) ? TRUST_FILE_OLD
                      : TRUST_FILE_NEW;

const USB_PATHS = [
  '/media/ghost/BOOT', '/media/ghost/USB STICK', '/media/ghost/USB STICK1',
  '/media/ghost/BOOT1', '/media/ghost/USB2', '/media/ghost/HAKSTER',
];

const IDLE_REVIEW_MS    = 30 * 60 * 1000; // 30 min idle → memory review
const MEMORY_MAX_CHARS  = 3000;           // cap memory text injected into prompt

// ── ANSI colors (mirrors phantom-cli.js C object) ──────────────────────────
const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  purple: '\x1b[35m', lpurp: '\x1b[95m', green: '\x1b[32m',
  lgreen: '\x1b[92m', yellow: '\x1b[33m', red: '\x1b[31m',
  cyan: '\x1b[36m', white: '\x1b[97m', gray: '\x1b[90m',
  blue: '\x1b[34m', lblue: '\x1b[94m',
};

// Convenience output helpers
const p   = (color, ...a) => process.stdout.write(color + a.join(' ') + C.reset);
const pl  = (color, ...a) => console.log(color + a.join(' ') + C.reset);

// ══════════════════════════════════════════════════════════════════════════
// ── USB SYNC ──────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════

// Find first writable USB mount point
function findUSB() {
  for (const p of USB_PATHS) {
    try { fs.accessSync(p, fs.constants.W_OK); return p; } catch {}
  }
  return null;
}

// Returns ALL currently mounted+writable USB paths
function findAllUSBs() {
  return USB_PATHS.filter(p => {
    try { fs.accessSync(p, fs.constants.W_OK); return true; } catch { return false; }
  });
}

function usbStatus() {
  const all = findAllUSBs();
  if (all.length) {
    const files = fs.readdirSync(all[0]).slice(0, 5);
    return { mounted: true, path: all[0], paths: all, files };
  }
  return { mounted: false, path: null, paths: [], files: [] };
}

// Sync one file to USB — mirrors the path under USB root
function syncFileToUSB(localPath, usbRoot) {
  try {
    const rel = path.isAbsolute(localPath)
      ? path.relative(HOME, localPath)
      : localPath;
    const dest = path.join(usbRoot, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(localPath, dest);
    return dest;
  } catch (e) {
    return null;
  }
}

// Sync a list of files to USB
function syncToUSB(files, usbRoot) {
  const results = [];
  for (const f of files) {
    const dest = syncFileToUSB(f, usbRoot);
    results.push({ src: f, dest, ok: !!dest });
  }
  return results;
}

// Sync a list of files to ALL mounted USBs simultaneously
function syncToAllUSBs(files) {
  const usbs = findAllUSBs();
  if (!usbs.length) return [];
  const results = [];
  for (const usbRoot of usbs) {
    for (const f of files) {
      const dest = syncFileToUSB(f, usbRoot);
      results.push({ src: f, dest, ok: !!dest, mount: usbRoot });
    }
  }
  return results;
}

// ══════════════════════════════════════════════════════════════════════════
// ── TRUST SYSTEM ──────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════

function loadTrust() {
  // Try new file first, then fall back to legacy phantom file
  for (const f of [TRUST_FILE_NEW, TRUST_FILE_OLD]) {
    try {
      if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch {}
  }
  // Default trusted paths
  return {
    trusted: [HOME, '/home/ghost/workspace', '/home/ghost/agent-knowledge', '/tmp'],
    auto_usb_sync: true,
  };
}

function saveTrust(cfg) {
  // Always write to the new hakster trust file
  fs.writeFileSync(TRUST_FILE_NEW, JSON.stringify(cfg, null, 2));
}

function isTrusted(filePath, cfg) {
  const abs = path.resolve(filePath);
  return cfg.trusted.some(t => abs.startsWith(path.resolve(t)));
}

function trustPath(p, cfg) {
  const abs = path.resolve(p);
  if (!cfg.trusted.includes(abs)) {
    cfg.trusted.push(abs);
    saveTrust(cfg);
  }
}

function untrustPath(p, cfg) {
  const abs = path.resolve(p);
  cfg.trusted = cfg.trusted.filter(t => t !== abs);
  saveTrust(cfg);
}

// ── Ask user yes/no ───────────────────────────────────────────────────────
function askYN(question) {
  return new Promise(resolve => {
    const r = readline.createInterface({ input: process.stdin, output: process.stdout });
    r.question(C.yellow + question + ' [y/N] ' + C.reset, ans => {
      r.close();
      resolve(ans.trim().toLowerCase() === 'y');
    });
  });
}

// ══════════════════════════════════════════════════════════════════════════
// ── TOKEN BUDGET ──────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════

// Local state mirror — callers can set `.lowTokenMode` to influence tokenBudget
const _state = {
  lowTokenMode: false,
  _busy: false,
};

function tokenBudget(msg) {
  if (_state.lowTokenMode) return 2048;
  if (/build|create|write|implement|refactor|migrate|deploy|scaffold|generate|design|architect/i.test(msg)) return 8192;
  if (/fix|debug|change|update|add|remove|rename|convert|explain|review/i.test(msg)) return 4096;
  return 2048;
}

// Estimate total tokens in a conversation history
function estTokens(history) {
  // Rough: ~4 chars per token for English code, ~2.5 for highly-compressed code
  let total = 0;
  for (const m of history) {
    const content = m.content || '';
    // Count words as proxy for tokens (1 word ≈ 1.3 tokens)
    const words = content.split(/\s+/).filter(Boolean).length;
    // Chars contribute ~0.25 tokens each for English, more for code
    const isCode = /[{}();=<>]/.test(content);
    total += isCode ? Math.ceil(content.length / 2.5) : Math.ceil(words * 1.3);
  }
  return total;
}

function showTokenBar(history) {
  const used   = estTokens(history);
  const MAX_K  = 200; // target ceiling in k tokens
  const usedK  = (used / 1000).toFixed(1);
  const pct    = Math.min(100, Math.round((used / (MAX_K * 1000)) * 100));
  const BAR_W  = 20;
  const filled = Math.round(pct / 100 * BAR_W);
  const col    = pct > 80 ? '\x1b[38;5;196m' : pct > 50 ? '\x1b[38;5;226m' : '\x1b[38;5;46m';
  const bar    = col + '▰'.repeat(filled) + '\x1b[38;5;238m' + '▱'.repeat(BAR_W - filled);
  process.stdout.write(`\x1b[2m  ctx ${bar}\x1b[0m \x1b[2m${usedK}k / ${MAX_K}k tokens\x1b[0m\n`);
}

// ══════════════════════════════════════════════════════════════════════════
// ── KNOWLEDGE BASE ────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════

function loadKnowledgeBase() {
  const kbRoots = [
    path.join(HOME, 'agent-knowledge'),
    path.join(CLI_ROOT, 'agent-knowledge'),
  ].filter((dir, idx, arr) => arr.indexOf(dir) === idx);

  // Priority files to always load (most critical knowledge)
  // Includes both hakster-* and legacy phantom-* names for backward compat
  const priority = [
    'hakster-ide-app-map.md',
    'phantom-ide-app-map.md',
    'DEFAULT_AGENTS.md',
    'builder-agent-skills.md',
    'hakster-server-api-reference.md',
    'phantom-server-api-reference.md',
    'hakster-cli-preview-fixes.md',
    'phantom-cli-preview-fixes.md',
    'pentest-patching-skills.md',
  ];
  // Secondary files (loaded summarized)
  const secondary = [
    'builder-database-schema.md',
    'security-agents-reference.md',
    'hakster-dev-agent-setup.md',
    'phantom-dev-agent-setup.md',
    'phinder-ai-integration.md',
  ];

  let context = '';
  const seen = new Set();

  for (const kbRoot of kbRoots) {
    for (const file of priority) {
      const fullPath = path.join(kbRoot, file);
      const key = `${kbRoot}:${file}`;
      if (fs.existsSync(fullPath) && !seen.has(key)) {
        const content = fs.readFileSync(fullPath, 'utf8');
        context += `\n\n=== ${file} (${kbRoot}) ===\n${content}`;
        seen.add(key);
      }
    }
  }

  for (const kbRoot of kbRoots) {
    for (const file of secondary) {
      const fullPath = path.join(kbRoot, file);
      const key = `${kbRoot}:${file}`;
      if (fs.existsSync(fullPath) && !seen.has(key)) {
        const content = fs.readFileSync(fullPath, 'utf8');
        context += `\n\n=== ${file} (${kbRoot}, summary excerpt) ===\n${content.slice(0, 3000)}...[summary excerpt — ask Hakster to read the file if you need more]`;
        seen.add(key);
      }
    }
  }

  // Load hakster-knowledge.md (with fallback to phantom-knowledge.md)
  const knowledgePaths = [
    path.join(HOME, 'hakster-knowledge.md'),
    path.join(CLI_ROOT, 'hakster-knowledge.md'),
    path.join(HOME, 'phantom-knowledge.md'),
    path.join(CLI_ROOT, 'phantom-knowledge.md'),
  ];
  for (const pkPath of knowledgePaths) {
    if (fs.existsSync(pkPath) && !seen.has(pkPath)) {
      const pk = fs.readFileSync(pkPath, 'utf8');
      const slice = pk.length > 30000 ? '...[earlier sections omitted]\n' + pk.slice(-30000) : pk;
      context += `\n\n=== ${path.basename(pkPath)} (${pkPath}) ===\n${slice}`;
      seen.add(pkPath);
    }
  }

  return context.trim();
}

// Re-read knowledge fresh every message — no stale cache
function getKnowledge() {
  return loadKnowledgeBase();
}

// Trim knowledge to fit token budget (keep most critical parts)
function getKnowledgeTrimmed(maxChars) {
  const full = getKnowledge();
  if (full.length <= maxChars) return full;
  // Keep the first maxChars chars (priority files are loaded first)
  return full.slice(0, maxChars) + '\n...[knowledge excerpt loaded to fit context — use tools for more if needed]';
}

// ══════════════════════════════════════════════════════════════════════════
// ── MACHINE PROFILE ───────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════

let _machineProfileCache = null;
let _machineProfileTs = 0;

function getMachineProfile() {
  // Cache for 5 minutes — machine specs don't change often
  if (_machineProfileCache && (Date.now() - _machineProfileTs) < 300000) return _machineProfileCache;

  const cpus = os.cpus();
  const cpuModel = cpus.length > 0 ? cpus[0].model : 'Unknown';
  const cpuCores = cpus.length;
  const totalMemGB = (os.totalmem() / (1024**3)).toFixed(1);
  const freeMemGB = (os.freemem() / (1024**3)).toFixed(1);
  const memUsedPct = Math.round((1 - os.freemem() / os.totalmem()) * 100);
  const uptimeHrs = (os.uptime() / 3600).toFixed(1);
  const loadAvg = os.loadavg()[0].toFixed(2);

  // Disk usage
  let diskInfo = 'N/A';
  try {
    const dfStdout = execSync("df -h / --output=size,used,avail,pcent 2>/dev/null | tail -1", { encoding: 'utf8', timeout: 3000 }).trim();
    const parts = dfStdout.split(/\s+/).filter(Boolean);
    if (parts.length >= 4) diskInfo = `${parts[1]}/${parts[0]} used (${parts[3].trim()} full) | ${parts[2]} free`;
  } catch {}

  // GPU info (quick, non-blocking)
  let gpuInfo = 'N/A';
  try {
    const lspci = execSync("lspci 2>/dev/null | grep -i 'vga\\|3d\\|display'", { encoding: 'utf8', timeout: 3000 }).trim();
    if (lspci) gpuInfo = lspci.split('\n')[0].replace(/.*:\s*/, '').trim();
  } catch {}

  // IP info (local only, no external calls)
  let localIP = 'N/A';
  try {
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        if (net.family === 'IPv4' && !net.internal && name !== 'lo') {
          localIP = net.address;
          break;
        }
      }
      if (localIP !== 'N/A') break;
    }
  } catch {}

  // User/shell
  const userInfo = os.userInfo();
  const shell = userInfo.shell || 'unknown';
  const hostname = os.hostname();
  const platform = `${os.type()} ${os.release()}`;
  const arch = os.arch();

  // Working directory
  let workspaceDir = HOME;
  try {
    workspaceDir = execSync('pwd', { encoding: 'utf8', timeout: 2000 }).trim();
  } catch {}

  const profile = {
    hostname,
    owner: userInfo.username,
    platform,
    arch,
    shell,
    cpu: `${cpuModel} (${cpuCores} cores)`,
    ram: `${totalMemGB} GB (using ${memUsedPct}%, ${freeMemGB} GB free)`,
    disk: diskInfo,
    gpu: gpuInfo,
    localIP,
    uptime: `${uptimeHrs} hrs`,
    loadAvg,
    workspace: workspaceDir,
    home: HOME,
    serverPort: 4000,
    timestamp: new Date().toISOString(),
  };

  _machineProfileCache = profile;
  _machineProfileTs = Date.now();
  return profile;
}

function formatMachineProfile(p) {
  if (!p) return '';
  return [
    `Owner: ${p.owner} · Machine: ${p.hostname} (${p.platform} ${p.arch})`,
    `CPU: ${p.cpu} | RAM: ${p.ram} | Load: ${p.loadAvg} | Uptime: ${p.uptime}`,
    `Disk: ${p.disk} | GPU: ${p.gpu} | IP: ${p.localIP}`,
    `Shell: ${p.shell} | Home: ${p.home} | Workspace: ${p.workspace} | Server: localhost:${p.serverPort}`,
  ].join('\n');
}

// ── Repo awareness — scan for existing .git repos on startup ──────────────

let _repoCache = null;
let _repoCacheTs = 0;

function scanGitRepos() {
  if (_repoCache && (Date.now() - _repoCacheTs) < 600000) return _repoCache; // 10min cache
  const repos = [];
  const scanDirs = [
    '/home/ghost',
    '/home/ghost/haksterAi',
    '/home/ghost/cine-vault-live',
    '/home/ghost/cine-vault-movie-site',
    '/home/ghost/workspace',
  ];
  for (const dir of scanDirs) {
    try {
      const gitDir = dir === '/home/ghost' ? '/home/ghost/.git' : `${dir}/.git`;
      if (fs.existsSync(gitDir)) {
        // Get remote URL
        let remote = '';
        let branch = '';
        try {
          remote = execSync(`git -C ${dir} remote get-url origin 2>/dev/null`, { encoding: 'utf8', timeout: 2000 }).trim();
        } catch {}
        try {
          branch = execSync(`git -C ${dir} rev-parse --abbrev-ref HEAD 2>/dev/null`, { encoding: 'utf8', timeout: 2000 }).trim();
        } catch {}
        repos.push({ dir, remote, branch });
      }
    } catch {}
  }
  _repoCache = repos;
  _repoCacheTs = Date.now();
  return repos;
}

function formatRepoAwareness() {
  const repos = scanGitRepos();
  if (repos.length === 0) return '';
  const lines = ['\n📁 GIT REPOS ON THIS MACHINE (do NOT blindly git init — check here first):'];
  for (const r of repos) {
    const remoteStr = r.remote ? ` → ${r.remote}` : ' (no remote)';
    const branchStr = r.branch ? ` [${r.branch}]` : '';
    lines.push(`  ${r.dir}${branchStr}${remoteStr}`);
  }
  lines.push('RULE: Before running "git init", check if a repo already exists at the target path. Use <hak_run>test -d PATH/.git && echo EXISTS</hak_run> first.');
  return lines.join('\n');
}

// ══════════════════════════════════════════════════════════════════════════
// ── MEMORY SYSTEM — persistent cross-session memory ───────────────────────
// ══════════════════════════════════════════════════════════════════════════

let _memoryCache = null;
let _idleTimer = null;

// Resolve which memory file to read from (new hakster file, or legacy phantom file)
function _resolveMemoryReadPath() {
  if (fs.existsSync(MEMORY_FILE_NEW)) return MEMORY_FILE_NEW;
  if (fs.existsSync(MEMORY_FILE_OLD)) return MEMORY_FILE_OLD;
  return MEMORY_FILE_NEW; // default when neither exists
}

function loadMemory() {
  if (_memoryCache) return _memoryCache;
  try {
    const memPath = _resolveMemoryReadPath();
    if (fs.existsSync(memPath)) {
      _memoryCache = JSON.parse(fs.readFileSync(memPath, 'utf8'));
      // Ensure notes field exists regardless of format
      if (!_memoryCache.notes && !_memoryCache.entries) {
        _memoryCache.notes = [];
      }
      if (!_memoryCache.lastReview) _memoryCache.lastReview = 0;
    } else {
      _memoryCache = { notes: [], lastReview: 0 };
    }
  } catch (e) {
    _memoryCache = { notes: [], lastReview: 0 };
  }
  return _memoryCache;
}

function saveMemory(mem) {
  try {
    // Always write to the new hakster memory file
    fs.writeFileSync(MEMORY_FILE_NEW, JSON.stringify(mem, null, 2));
    _memoryCache = mem;
  } catch (e) { /* silently fail */ }
}

// ── Memory helpers that handle both 'notes' (string[]) and 'entries' (object[]) formats ──

function memGetNotes(mem) {
  if (mem.notes && Array.isArray(mem.notes)) return mem.notes;
  if (mem.entries && Array.isArray(mem.entries)) return mem.entries.map(e => e.value || e.key || String(e));
  return [];
}

function memAddNote(mem, fact) {
  if (mem.notes && Array.isArray(mem.notes)) {
    if (!mem.notes.some(n => n.toLowerCase().includes(fact.toLowerCase()))) {
      mem.notes.push(fact);
    }
    if (mem.notes.length > 50) mem.notes = mem.notes.slice(-50);
  } else if (mem.entries && Array.isArray(mem.entries)) {
    if (!mem.entries.some(e => (e.value||'').toLowerCase().includes(fact.toLowerCase()))) {
      mem.entries.push({ key: fact.slice(0,30), value: fact, tags: ['memory'], source: 'extract', ts: Date.now() });
    }
    if (mem.entries.length > 50) mem.entries = mem.entries.slice(-50);
  } else {
    mem.notes = [fact];
  }
}

function memSetNotes(mem, arr) {
  if (mem.notes && Array.isArray(mem.notes)) {
    mem.notes = arr.slice(0, 50);
  } else if (mem.entries && Array.isArray(mem.entries)) {
    mem.entries = arr.slice(0, 50).map(n => ({ key: n.slice(0,30), value: n, tags: ['memory'], source: 'review', ts: Date.now() }));
  } else {
    mem.notes = arr.slice(0, 50);
  }
}

function memClear(mem) {
  if (mem.notes) mem.notes = [];
  if (mem.entries) mem.entries = [];
}

function memLength(mem) { return (mem.notes || mem.entries || []).length; }

function getMemoryText() {
  const mem = loadMemory();
  const notes = memGetNotes(mem);
  if (!notes.length) return '';
  const lines = notes.map(n => `- ${n}`).join('\n');
  return lines.length > MEMORY_MAX_CHARS ? lines.slice(0, MEMORY_MAX_CHARS) + '\n...(truncated)' : lines;
}

// Extract key facts from a conversation exchange to save as memory
function extractAndSaveMemory(userMsg, assistantMsg) {
  const mem = loadMemory();
  // Heuristic extraction: look for user corrections, preferences, names, facts
  const combined = (userMsg + '\n' + assistantMsg).slice(0, 6000);
  const patterns = [
    /\b(?:my name is|i'm called|call me)\s+([^\.,!?]+)/i,
    /\b(?:i prefer|i like|i want|i need)\s+([^\.,!?]{5,80})/i,
    /\b(?:don't|never|always|must)\s+([^\.,!?]{5,80})/i,
    /\b(?:the (?:password|key|token|secret|IP|address|port|server|endpoint|API|url))\s+(?:is|for|=)\s+([^\.,!?]+)/i,
    /\b(?:project|repo|app|service)\s+(?:is called|named|=)\s+([^\.,!?]+)/i,
  ];
  for (const pat of patterns) {
    const m = combined.match(pat);
    if (m && m[1] && m[1].trim().length > 2) {
      const fact = m[1].trim().replace(/["']/g, '');
      memAddNote(mem, fact);
    }
  }
  // Also save important keywords from hacking/technical discussions
  const hackMatch = combined.match(/(?:cracked|exploited|vulnerable|password|key|hash|ssid|bssid|wallet|address)\s+(?:is|was|found|=)\s+([^\.,!?]{3,60})/i);
  if (hackMatch && hackMatch[1]) {
    const fact = hackMatch[0].trim();
    memAddNote(mem, fact);
  }
  saveMemory(mem);
}

// Idle memory review — called after N minutes of no user input.
// opts: { askAI: async (messages, maxTokens) => string, isBusy: () => boolean }
async function idleMemoryReview(rl, trustCfg, opts = {}) {
  const askAI = opts.askAI || (async () => '');
  const isBusy = opts.isBusy || (() => _state._busy);

  const mem = loadMemory();
  const now = Date.now();
  // Only review if enough time passed and there are notes
  if (now - (mem.lastReview || 0) < IDLE_REVIEW_MS) return;
  const memNotes = memGetNotes(mem);
  if (!memNotes.length) return;

  mem.lastReview = now;
  saveMemory(mem);

  const memoryNotes = getMemoryText();
  if (!memoryNotes) return;

  pl(C.gray, '\n  🧠 Memory review — checking notes...\n');

  const reviewPrompt = `You are Hakster's memory reviewer. Review these memory notes and improve them:
- Remove duplicates or near-duplicates
- Remove outdated/tmp facts (paths, PIDs, one-time errors)
- Merge related facts into concise single entries
- Keep: user preferences, important credentials, project facts, technical discoveries
- Remove: temporary state, session-specific info, things that change daily

Current notes:
${memoryNotes}

Output ONLY the cleaned-up notes, one per line starting with "- ". No explanation. If no notes should remain, output "EMPTY".`;

  try {
    const result = await askAI([
      { role: 'system', content: 'You are a memory management AI. Be concise. Output only cleaned notes.' },
      { role: 'user', content: reviewPrompt }
    ], 2048);

    if (result && result.trim() !== 'EMPTY') {
      const cleaned = result.trim().split('\n')
        .map(l => l.replace(/^[-•*]\s*/, '').trim())
        .filter(l => l.length > 2 && l.length < 200);
      if (cleaned.length > 0 && Math.abs(cleaned.length - memNotes.length) <= Math.max(5, memNotes.length * 0.3)) {
        memSetNotes(mem, cleaned);
        saveMemory(mem);
        pl(C.lgreen, `  🧠 Memory cleaned: ${memLength(mem)} notes retained\n`);
      }
    } else if (result && result.trim() === 'EMPTY') {
      memClear(mem);
      saveMemory(mem);
      pl(C.gray, '  🧠 Memory cleared — no persistent facts found\n');
    }
  } catch (e) {
    // Silently fail — don't interrupt user for memory review errors
  }
  // Do NOT reset idle timer here — that causes infinite review loops.
  // Timer is only reset on actual user input (in the readline handler).
}

// opts: { askAI: async fn, isBusy: () => boolean }
function resetIdleTimer(rl, trustCfg, opts = {}) {
  if (_idleTimer) clearTimeout(_idleTimer);
  const isBusy = opts.isBusy || (() => _state._busy);
  _idleTimer = setTimeout(() => {
    if (!isBusy()) {
      idleMemoryReview(rl, trustCfg, opts);
    } else {
      // If busy, try again in 30s
      _idleTimer = setTimeout(() => {
        if (!isBusy()) idleMemoryReview(rl, trustCfg, opts);
      }, 30000);
    }
  }, IDLE_REVIEW_MS);
}

// ══════════════════════════════════════════════════════════════════════════
// ── Exports ───────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════

module.exports = {
  // ── USB sync ──
  findUSB,
  findAllUSBs,
  usbStatus,
  syncFileToUSB,
  syncToUSB,
  syncToAllUSBs,

  // ── Trust system ──
  loadTrust,
  saveTrust,
  isTrusted,
  trustPath,
  untrustPath,
  askYN,

  // ── Token budget ──
  tokenBudget,
  estTokens,
  showTokenBar,

  // ── Knowledge base ──
  loadKnowledgeBase,
  getKnowledge,
  getKnowledgeTrimmed,

  // ── Machine profile ──
  getMachineProfile,
  formatMachineProfile,
  scanGitRepos,
  formatRepoAwareness,

  // ── Memory system ──
  loadMemory,
  saveMemory,
  getMemoryText,
  memGetNotes,
  memAddNote,
  memSetNotes,
  memClear,
  memLength,
  extractAndSaveMemory,
  idleMemoryReview,
  resetIdleTimer,

  // ── State (callers can set _state.lowTokenMode / _state._busy) ──
  state: _state,

  // ── Constants ──
  HOME,
  CLI_ROOT,
  USB_PATHS,
  C,
  MEMORY_FILE,
  MEMORY_FILE_NEW,
  MEMORY_FILE_OLD,
  TRUST_FILE,
  TRUST_FILE_NEW,
  TRUST_FILE_OLD,
  MEMORY_MAX_CHARS,
  IDLE_REVIEW_MS,
};