/**
 * haksterAI — Local AI coding agent powered by gpt-oss:120b-cloud
 * Runs inside the haksterAI browser terminal or any Node.js terminal.
 * Full tool loop: shell, read/write/patch files, web fetch, browser, process mgmt.
 */

const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { globSync } = require('glob');
const os = require('os');
const crypto = require('crypto');
const { loadMcpServers, getMcpTools, callMcpTool, isMcpTool, mcpStatus, shutdownMcp, setLogFn: setMcpLogFn, setStatusFn: setMcpStatusFn } = require('./mcp');
const { generateImage } = require('../providers');

// ── Puppeteer (lazy-loaded) ──────────────────────────────────────────
let _browser = null;
async function getBrowser() {
  if (!_browser || !_browser.isConnected()) {
    const puppeteer = require('puppeteer');
    _browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
  }
  return _browser;
}
let _page = null;
async function getPage() {
  const browser = await getBrowser();
  if (!_page || _page.closed) {
    _page = await browser.newPage();
    await _page.setViewport({ width: 1280, height: 800 });
  }
  return _page;
}

// ── Config ──────────────────────────────────────────────────────────────
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const HAKSTER_HOST = process.env.HAKSTER_HOST || 'http://localhost:3579';
const MODEL = process.env.HAKSTER_MODEL || 'gpt-oss:120b-cloud';
const WORK_DIR = process.cwd();
const SYSTEM_PROMPT = `You are haksterAI, an expert AI coding and ops agent running on the user's machine. You have direct access to shell commands, file operations, processes, and networking. You are bold, concise, and get things done. Prefer action over explanation. When writing code, just write it — no unnecessary framing.

## CRITICAL RULES
1. DANGEROUS COMMANDS REQUIRE CONFIRMATION. If you use shell, kill_process, pm2 (stop/restart), or write to critical system paths, the user will be asked to approve. Plan accordingly.
2. ALWAYS use the code_grid tool when showing code, file contents, diffs, or config to the user. Never dump raw code without line numbers and color grid.
3. When showing file contents with read_file, the output already has line numbers — use code_grid for any code you write or modify to give the user a clear before/after view with highlighted changes (use diff_lines with + for additions, - for deletions).
4. Sub-agents (sub_agent tool) run tasks in parallel — use them when multiple independent tasks need doing simultaneously (e.g. check 3 services, edit 3 files).
5. NEVER run modifying commands during idle review — only read-only operations (pm2 list, cat, ss, df, free, etc).
6. NEVER output fake UI status lines (e.g. "⏳ Queued", "⏳ Processing", spinners, progress bars, ASCII box-drawing chrome like ┌──┐│└┘, or numbered step counters). The TUI handles ALL status display. Your text output goes DIRECTLY to the user — just give plain answers, results, and tool calls. No simulated terminal chrome, no boxes, no fake progress indicators. FAKE QUEUE COUNTS ARE A CRITICAL BUG — never output "⏳ Queued (N pending)" or any queue/progress count. The real TUI uses format "⏳ Queued (1 batch, N lines, queue depth X)" and displays it automatically. If you catch yourself drawing a box or outputting ⏳, STOP and just write the plain text answer instead.
7. NEVER ask the same clarifying question twice. If you asked for details and the user responded, ACT on their response immediately — do not re-ask or rephrase the same question. After 1 clarification attempt, proceed with your best judgment. Repetitive clarification without action is a loop violation.

## System Knowledge (always accurate)
- Machine: AMD A12-9720P, 4 cores, ~7GB RAM, runs hot (84-89°C). Always check before heavy tasks.
- OS: Garuda Linux (Arch-based)
- Work dir: ${WORK_DIR}

## Services & Ports
- haksterAI: PM2 name "hakster", PORT=3579, dir /home/ghost/haksterAi, server/src/index.js
- CineVault: PM2 name "cinevault", PORT=8081, dir /home/ghost/cine-vault-live, server.js
- Miniforge: PM2 name "miniforge", PORT=5555, dir /home/ghost/miniforge, server.js

## PM2 Commands
- Check all: pm2 list
- Restart haksterAI: pm2 restart hakster (never use --env PORT, set PORT in .env)
- Restart CineVault: pm2 restart cinevault
- Restart Miniforge: pm2 restart miniforge (After PM2 start, port 5555 returns 000 for 2-3 seconds — wait and retry)
- Logs: pm2 logs hakster --lines 50
- Before restarting CineVault: run /home/ghost/cine-vault-live/cli-guard.sh check — if exit=1, someone is using CLI, don't restart

## Fix/Start Procedures
- Stale port: fuser -k <port>/tcp before restart (e.g. fuser -k 8081/tcp)
- Build haksterAI: cd /home/ghost/haksterAi && npx astro build
- Build CineVault: cd /home/ghost/cine-vault-live && npm run build
- Health checks: curl -s http://localhost:3579/api/health | curl -s http://localhost:8081/api/health
- Disk: df -h / (78% used, ~96GB free)
- RAM: free -h (6.7GB total, watch swap usage)
- Temp: cat /sys/class/thermal/thermal_zone*/temp (divide by 1000 for °C)

## Known Issues
- CineVault: /api/stalkerhek-proxy GET sends headers but 0 bytes body — timeout:5000 kills live TS sockets
- CineVault: PM2 crash loop → always check stale PIDs on 8081 before restart
- OOM: if oom-killer strikes, check dmesg | tail -30
- Machine priority: keep it running tip-top. Proactive health checks are standing priority.

## Other Projects
- PhantomIDE: Single-file HTML web IDE at /home/ghost/phantom-ide.html (1.1MB). DO NOT modify unless explicitly asked — user rule.
  - Phantom server: FastAPI backend at /home/ghost/phantom-ide/app.py, PM2 name "phantom", PORT 4000
  - Start: pm2 start /home/ghost/phantom-restore/ecosystem.config.js OR pm2 restart phantom
  - Health: curl -s http://localhost:4000/api/ping
  - Knowledge base: /home/ghost/phantom-knowledge.md (8300+ lines, load first 6000 chars as context)
  - 57 agent system, smart routing, AI provider waterfall, RAG semantic search
- CineVault: IPTV player, see Services section above for details
- haksterAI: This project. Astro frontend, Express/WS backend, PTY terminal, haksterAI agent`;

// ── Core skill cache (built once, auto-injected into every system prompt) ──
let _coreSkillCache = null;
let _coreSkillCacheTime = 0;
const CORE_SKILL_TTL = 60000; // refresh every 60s

function loadCoreSkills() {
  const now = Date.now();
  if (_coreSkillCache && (now - _coreSkillCacheTime) < CORE_SKILL_TTL) return _coreSkillCache;
  // Only load haksterAi-relevant skill docs — guardrails + useful behavior guides.
  // EXCLUDED: raw TS source dumps (prompts-constants, system-prompt-sections,
  //   system-prompt-utils, context, memdir-paths) and Claude Code internal guides
  //   (claude-code-skill, claude-agent, claude-readme, claude-contributing).
  //   These teach the agent Claude Code's FileEditTool patterns which don't map to
  //   haksterAi's shell/write_file tools, leading to broken edits (e.g. inserting
  //   JS statements inside fetch() call arguments).
  const coreSkills = [
    'hakster-guardrails',         // CRITICAL safety & editing rules — prevents code corruption
    'stuck',                      // how to get unstuck
    'debug',                      // debugging approach
    'remember',                   // memory review
    'simplify',                    // simplification strategy
    'skillify',                   // skill creation guide
    'loop',                       // loop/retry behavior
    'batch',                      // batch operations
    'cyber-risk-instruction',     // cyber risk awareness
  ];
  const skillsDirs = getHaksterRoots().map(root => path.join(root, 'skills'));
  const parts = [];
  for (const skillName of coreSkills) {
    for (const skillsDir of skillsDirs) {
      const matches = globSync(path.join(skillsDir, '**', `${skillName}.md`));
      if (matches.length > 0) {
        try {
          const content = fs.readFileSync(matches[0], 'utf-8');
          if (content && content.trim().length > 0) {
            parts.push(`\n\n---\n## Auto-loaded skill: ${skillName}\n${content}`);
          }
        } catch (_) { /* skip unreadable */ }
        break;
      }
    }
  }
  _coreSkillCache = parts.join('');
  _coreSkillCacheTime = now;
  return _coreSkillCache;
}

// ── Build system prompt with memory injection ───────────────────────────
function buildSystemPrompt() {
  let prompt = SYSTEM_PROMPT;
  const haksterRoots = getHaksterRoots();

  // Inject saved memory notes
  const allNotes = [];
  for (const root of haksterRoots) {
    const memoryFile = path.join(root, 'memory', 'notes.json');
    try {
      const notes = JSON.parse(fs.readFileSync(memoryFile, 'utf-8'));
      if (Array.isArray(notes)) allNotes.push(...notes);
    } catch (_) { /* no memory file at this root */ }
  }
  if (allNotes.length > 0) {
    const seen = new Set();
    const memoryLines = allNotes
      .filter(n => {
        const key = n.id || n.content;
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map(n => `• ${n.content}`)
      .join('\n');
    prompt += `\n\n## 🧠 Memory (notes from past sessions)\n${memoryLines}`;
  }

  // Inject skill names so the agent knows what skills exist
  const skillNames = [];
  for (const root of haksterRoots) {
    const skillsDir = path.join(root, 'skills');
    try {
      const skillFiles = globSync(path.join(skillsDir, '**', '*.md'));
      if (skillFiles.length > 0) {
        skillNames.push(...skillFiles.map(f => path.relative(skillsDir, f).replace(/\.md$/, '')));
      }
    } catch (_) { /* no skills at this root */ }
  }
  if (skillNames.length > 0) {
    const uniqueSkills = Array.from(new Set(skillNames));
    // Compress skill list to save context — show categories with counts, not every name
    const byCategory = {};
    for (const s of uniqueSkills) {
      const cat = s.includes('/') ? s.split('/').slice(0, -1).join('/') : 'root';
      byCategory[cat] = (byCategory[cat] || 0) + 1;
    }
    const categories = Object.entries(byCategory)
      .sort((a, b) => b[1] - a[1])
      .map(([cat, count]) => `${cat}/ (${count})`)
      .join(', ');
    prompt += `\n\n## 📋 ${uniqueSkills.length} Skills Available\nCategories: ${categories}\nUse skill_load to read a skill before following its steps.`;
  }

  // Auto-inject core Claude Code skill content (cached, refreshed every 60s)
  prompt += loadCoreSkills();

  return prompt;
}

function getHaksterRoots() {
  return Array.from(new Set([
    path.join(process.env.HOME || '/home/ghost', '.hakster'),
    path.join('/home/ghost', '.hakster'),
    path.join(WORK_DIR, '.hakster'),
    path.join(__dirname, '..', '..', '..', '.hakster'),  // project root .hakster
  ]));
}

// (Idle review prompt removed — health checks now run directly via shell, no model call)
const MAX_TURNS = 50;
const IDLE_TIMEOUT_MS = 120000; // 2 minutes idle → auto review

// ── TUI Config (env-var tunable) ──────────────────────────────────────────
// Safe parsing: parseInt("") → NaN, but parseInt("0") → 0 which is falsy.
// Use IIFE to handle both empty strings and explicit zero values correctly.
const REFRESH_MS    = (() => { const v = process.env.REFRESH_MS;    return v !== undefined && v !== '' ? parseInt(v, 10) || 200 : 200; })();
const SCROLL_SPEED  = (() => { const v = process.env.SCROLL_SPEED;  return v !== undefined && v !== '' ? parseInt(v, 10) || 1   : 1;   })();
const MAX_LOG_LINES = (() => { const v = process.env.MAX_LOG_LINES; return v !== undefined && v !== '' ? parseInt(v, 10) || 12  : 12;  })();

// ── Module-level state for stuck-loop detection (shared with agentLoop) ──
let _lastAssistantResponse = '';   // Tracks last model response for loop detection
let _noProgressCount = 0;          // Counts consecutive responses without tool calls
const NO_PROGRESS_LIMIT = 2;       // Break loop after this many no-progress turns (was 4, lowered — clarifying questions loop fast)
let _recentResponsePrefixes = [];  // Last N response prefixes for semantic loop detection
let _emptyRetries = 0;              // Counts empty-response retries within a single agentLoop call
const SEMANTIC_LOOP_WINDOW = 3;    // How many recent responses to check (was 5, lowered — catches loops faster)
const SEMANTIC_LOOP_THRESHOLD = 2; // How many similar prefixes → loop detected (was 3, lowered to catch loops faster)
let _messageQueue = [];            // Queue of incoming messages (flushed on stuck loop)
let _batch = null;                 // Paste-batching state: { lines: string[], timer: NodeJS.Timeout }
let _stuckCooldown = 0;             // After stuck-loop break, skip this many queued messages to prevent re-loop

// ── Tool-error loop detection ──
// Track consecutive errors from the SAME tool — if a tool errors 3+ times in a row,
// it's likely a code bug (like ReferenceError) causing an infinite retry loop.
let _consecutiveToolErrors = [];     // [{name, count}]  recent tool error counts
const TOOL_ERROR_LOOP_LIMIT = 3;    // Same tool erroring this many times → break loop

// Normalize text for loop comparison: lowercase, strip trailing punctuation/whitespace, collapse spaces
function _normalizeForLoopCheck(text) {
  return (text || '').toLowerCase().replace(/\s+/g, ' ').replace(/[.!?;:,]+$/, '').trim();
}

// Strip hallucinated TUI chrome from thinking/content display
// (models sometimes generate fake "⏳ Queued (N pending)", "📦 Skipping compact", "✓ Done", box-drawing lines)
function _stripFakeTui(text) {
  if (!text) return '';
  return text
    .replace(/^.*⏳\s*(Queued|Processing|Thinking|Done|Complete|Step|Tool call|Running)[^\n]*$/gim, '')
    .replace(/^.*Queued\s*\(\d+\s+pending\).*$/gim, '')
    .replace(/^.*📦\s*Skipping\s+compact.*$/gim, '')
    .replace(/^✓\s*Done\s*$/gm, '')
    .replace(/^│\s*│.*│\s*│\s*$/gm, '')
    .replace(/^[║│┃┆┇┊╎╏]\s*.{1,80}?\s*[║│┃┆┇┊╎╏]\s*$/gm, (m) => {
      // Keep lines that look like real data (long content, structured)
      const inner = m.replace(/^[║│┃┆┇┊╎╏]\s*/, '').replace(/\s*[║│┃┆┇┊╎╏]\s*$/, '');
      if (/^[├└┌│]/.test(inner) || inner.length > 70) return m;
      return '';
    })
    .replace(/\n{3,}/g, '\n')
    .trim();
}

// Patterns that indicate the agent is asking a clarifying question instead of making progress
const _clarifyingPatterns = [
  /\b(let me know|please (tell|provide|share|confirm|specify)|i need (more |a few )?(details|information|specifics))\b/i,
  /\b(could you|can you|would you|what (should|would)|how (should|would)|which .+ (would|do))\b/i,
  /\b(confirm|clarify|elaborate|specify|details|specifics)\b/i,
  /\b(once (i|you) (have|know|confirm)|if (that|this) (looks|sounds)|reply.*yes)\b/i,
  /\b(i('m| am) (ready|happy|glad|here) to)\b/i,
  /\b(i('ll| will) (add|create|implement|build|patch))\b/i,  // "I'll add..." — intent without action
  /\b(i( still | )?need\b.*\b(information|detail|specific|confirm))\b/i,  // "I need information/confirmation"
  /\b(what (exactly|specifically)|which .+ (would|do|should)|just (let me know|tell me|reply))\b/i,
  /\b(propose|proposed|if.*(sound|look)s? good)\b/i,  // "Proposed..." / "If this sounds good"
  /\b(please (confirm|let me know)|do you want|would you like|shall i|should i)\b/i,  // Direct question markers
  /\b(i can (add|create|build|implement|write|make),? but)\b/i,  // "I can X, but..." hedging
  /\b(if you('d| would)? like|what (is|are) your|tell me (more|about))\b/i,  // More question patterns
];

// Check if a response is just a clarifying question (no real progress)
function _isClarifyingQuestion(text) {
  if (!text || text.length < 30) return false;
  const norm = _normalizeForLoopCheck(text);
  let hits = 0;
  for (const pat of _clarifyingPatterns) {
    if (pat.test(norm)) hits++;
  }
  // Need at least 2 pattern matches to detect clarifying questions
  // (1 pattern is too easy — many normal responses hit 1 pattern accidentally)
  return hits >= 2;
}

// Count how many of the last N response prefixes are similar to `prefix`
// Uses fuzzy matching: overlap of significant words, not just prefix match
function _semanticLoopCount(prefix) {
  const norm = _normalizeForLoopCheck(prefix);
  if (!norm || norm.length < 10) return 0;  // Lower threshold from 20 to 10
  // Extract significant words (length > 3) for fuzzy matching
  const prefixWords = norm.split(/\s+/).filter(w => w.length > 3).slice(0, 15);
  if (prefixWords.length < 2) return 0;
  let count = 0;
  for (const p of _recentResponsePrefixes) {
    // Method 1: original prefix match (startsWith)
    if (p.startsWith(norm.substring(0, 60)) || norm.substring(0, 60).startsWith(p)) {
      count++;
      continue;
    }
    // Method 2: word overlap — if >= 40% of significant words overlap, it's a similar response
    const pWords = p.split(/\s+/).filter(w => w.length > 3);
    if (pWords.length < 2) continue;
    const pSet = new Set(pWords);
    const overlap = prefixWords.filter(w => pSet.has(w)).length;
    const similarity = overlap / Math.max(prefixWords.length, pWords.length);
    if (similarity >= 0.4) count++;
  }
  return count;
}

// ── Dangerous command patterns ──────────────────────────────────────────
const DANGEROUS_SHELL_PATTERNS = [
  /\brm\s+(-rf?|--force|--recursive)/i,
  /\brm\s+.*\//i,                      // rm with paths
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
  /\bcurl.*\|\s*(ba)?sh/i,             // pipe to shell
  /\bwget.*\|\s*(ba)?sh/i,
  /\bmv\b.*\s+\/dev\/null/i,            // mv to /dev/null (destructive)
  /\b>\s*\/dev\/(sda|nvme|vd)/i,        // write to raw block device
  /\btruncate\s+-s\s+0\b/i,            // truncate to zero
  /\bswapoff\b/i,
  /\bmount\s+.*\/dev\/(sda|nvme)/i,     // mount raw device
  /\bcrontab\s+-r\b/i,                 // delete crontab
  /\bat\/atq\s+-r\b/i,                  // delete at queue
  /\bparted\b.*\b(mklabel|mkpart|rm)\b/i, // partition table ops
  /\blvm\s+.*\b(remove|lvremove|vgremove|pvremove)\b/i, // LVM destructive
  /\braid\d*\s+.*\b(--stop|--fail|--remove)\b/i, // RAID destructive
  /\bip\s+link\s+set\s+.*\bdown\b/i,   // network interface down
  /\bip\s+route\s+(flush|del\s+default)/i, // route destruction
  /\bip\s+addr\s+(flush|del)\b/i,       // IP addr destruction
  /\biwconfig\s+.*\b(txpower\s+off|mode\s+monitor)\b/i, // wireless destructive
  /\btcpkill\b/i,                       // kills TCP connections
  /\bfsck\s+/i,                          // filesystem check (can corrupt)
  /\bmkswap\b/i,                         // make swap (destructive)
  /\bbadblocks\s+.*-w\b/i,              // destructive badblocks test
  /\bsfdisk\b/i,                         // partition manipulator
  /\bcfdisk\b/i,                         // partition manipulator
];

const CRITICAL_PATHS = [
  '/etc/passwd', '/etc/shadow', '/etc/sudoers', '/etc/ssh',
  '/etc/systemd', '/boot', '/usr/bin', '/usr/sbin',
  '/home/ghost/.ssh', '/root/.ssh',
];

function isDangerousCommand(tool, args) {
  // Shell commands
  if (tool === 'shell') {
    const cmd = args.command || '';
    for (const pat of DANGEROUS_SHELL_PATTERNS) {
      if (pat.test(cmd)) return `Dangerous shell command: ${cmd.substring(0, 100)}`;
    }
  }
  // Kill processes
  if (tool === 'kill_process' && args.pid) return `Kill PID ${args.pid}?`;
  // PM2 destructive actions
  if (tool === 'pm2' && ['stop', 'restart'].includes(args.action)) {
    return `PM2 ${args.action} ${args.name || ''}?`;
  }
  // Write/overwrite on critical paths
  if (['write_file', 'patch_file', 'multi_patch', 'insert_lines', 'delete_lines', 'replace_regex'].includes(tool)) {
    const fp = path.resolve(WORK_DIR, args.path || '');
    for (const cp of CRITICAL_PATHS) {
      if (fp.startsWith(cp)) return `Writing to critical path: ${fp}`;
    }
  }
  return null;
}

// ── Tool Emoji Map ──────────────────────────────────────────────────
const TOOL_EMOJI = {
  shell:            '🖥️',  read_file:       '📄',
  write_file:       '✏️',  patch_file:      '🔧',
  multi_patch:      '🔧',  insert_lines:    '📝',
  delete_lines:     '🗑️',  replace_regex:   '🔄',
  append_file:      '➕',  list_dir:        '📁',
  search_files:     '🔍',  web_fetch:       '🌐',
  run_background:   '⚙️',  kill_process:    '☠️',
  git_op:           '🔀',  pm2:             '📦',
  service_check:    '💊',  snapshot:        '📸',
  sub_agent:        '🤖',  parallel_shell:  '⚡',
  code_grid:        '🎨',  browser_navigate: '🧭',
  browser_click:    '👆',  browser_type:    '⌨️',
  browser_screenshot: '📸', browser_snapshot: '🔍',
  memory:            '🧠',  skill_save:     '💾',
  skill_load:        '📖',  skill_list:     '📋',
  notify:            '📬',
};

function toolEmoji(name) { return TOOL_EMOJI[name] || '🛠️'; }

// ── Tool Type Badge Map (short codes for TOOL GRID panel) ──────────────
const TOOL_TYPE = {
  shell:            'SH',  read_file:       'RF',
  write_file:       'WF',  patch_file:      'PF',
  multi_patch:      'MP',  insert_lines:    'IL',
  delete_lines:     'DL',  replace_regex:   'RR',
  append_file:      'AF',  list_dir:        'LS',
  search_files:     'SR',  web_fetch:       'WB',
  run_background:   'BG',  kill_process:    'KL',
  git_op:           'GT',  pm2:             'PM',
  service_check:    'SV',  snapshot:        'SN',
  sub_agent:        'SA',  parallel_shell:  'PS',
  code_grid:        'CG',  browser_navigate: 'BN',
  browser_click:    'BC',  browser_type:    'BT',
  browser_screenshot:'BS', browser_snapshot:'BX',
  memory:            'MM',  skill_save:     'SS',
  skill_load:        'SL',  skill_list:     'SLS',
  notify:            'NT',
  // MCP tool name prefixes
  nmap_basic_scan:          'NM',  nmap_service_detection:    'NS',
  nmap_os_detection:        'NO',  nmap_script_scan:         'NC',
  nmap_vulnerability_scan:  'NV',  nmap_custom_scan:         'NX',
  nmap_ping_scan:           'NP',  nmap_port_scan:           'NP',
  nmap_mdns_discovery:      'ND',
  read_file:                'RF',  read_text_file:           'RT',
  read_media_file:          'RM',  read_multiple_files:      'RML',
  write_file:               'WF',  edit_file:               'EF',
  create_directory:         'CD',  list_directory:           'LD',
  list_directory_with_sizes:'LZ',  directory_tree:           'DT',
  move_file:                'MV',  search_files:            'SF',
  get_file_info:            'FI',  list_allowed_directories:'AD',
  create_entities:          'CE',  create_relations:         'CR',
  add_observations:         'AO',  delete_entities:          'DE',
  delete_observations:     'DO',  delete_relations:         'DR',
  read_graph:               'RG',  search_nodes:            'SN',
  open_nodes:               'ON',
  read_query:               'RQ',  write_query:             'WQ',
  create_table:             'CT',  list_tables:             'LT',
  describe_table:          'DT2',
  sequentialthinking:       'ST',
  browser_close:            'BC2', browser_resize:          'BR',
  browser_console_messages: 'BCM', browser_handle_dialog:   'BHD',
  browser_evaluate:         'BE',  browser_file_upload:     'BFU',
  browser_drop:             'BD',  browser_fill_form:       'BFF',
  browser_press_key:        'BP',  browser_type:            'BT',
  browser_navigate:         'BN',  browser_navigate_back:   'BBK',
  browser_network_requests: 'BNR', browser_network_request: 'BNQ',
  browser_run_code_unsafe:  'BRC', browser_take_screenshot:'BS2',
  browser_snapshot:          'BSX', browser_click:           'BC',
  browser_drag:              'BD2', browser_hover:          'BH',
  browser_select_option:    'BSO', browser_tabs:            'BT2',
  browser_wait_for:         'BWF',
};

// ── Confirmation system ──────────────────────────────────────────────────
// _confirmFn is set by TUI/REPL; returns true (approved), false (denied), or a string (edited command)
let _confirmFn = null; // (dangerMsg, tool, args) => Promise<boolean>

// Safe shell command prefixes — read-only introspection commands that never modify state
const SAFE_READ_CMDS = [
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
  'jq', 'node', 'python3', 'python', 'bash',
];

// Safe shell commands that require sub-command matching (read-only sub-commands only)
const SAFE_READ_SUBCMDS = {
  sed: ['−n'],           // sed -n (print-only)
  awk: [],               // awk is generally safe (print-only)
  ip: ['addr show', 'addr list', 'link show', 'link list', 'route show', 'route list', 'neigh show', 'neigh list', 'rule show', '-s link'],
  systemctl: ['status', 'list-units', 'list-timers', 'is-active', 'is-enabled', 'is-failed', 'show', 'cat'],
  pm2: ['list', 'describe', 'logs', 'show', 'prettylist', 'jlist', 'info'],
  git: ['status', 'log', 'diff', 'branch', 'fetch', 'remote', 'tag', 'show', 'rev-parse', 'ls-files', 'ls-tree', 'blame', 'shortlog', 'describe', 'reflog', 'cherry', 'name-rev'],
  smartctl: ['-a'],
  fdisk: ['-l'],
  parted: ['-l', '-l'],
  swapon: ['--show'],
  mount: [],              // bare 'mount' (list mounts) is safe
  nmap: ['-sV', '-sS', '-sT', '-sA', '-sO', '-sF'],
};

function isReadOnlyTool(tool, args) {
  const readOnlyTools = ['read_file', 'list_dir', 'search_files', 'service_check', 'snapshot', 'browser_navigate', 'browser_snapshot', 'browser_screenshot', 'memory', 'skill_load', 'skill_list'];
  if (readOnlyTools.includes(tool)) return true;
  if (tool === 'shell') {
    const cmd = (args?.command || '').trim();
    if (!cmd) return false;
    // Get the first word (command binary)
    const firstWord = cmd.split(/\s+/)[0];
    const baseCmd = firstWord.replace(/^\//, '').split('/').pop(); // handle /usr/bin/xxx
    // Check safe command list
    if (SAFE_READ_CMDS.includes(baseCmd)) {
      // For commands with sub-command restrictions, verify sub-command is read-only
      const safeSubs = SAFE_READ_SUBCMDS[baseCmd];
      if (safeSubs !== undefined) {
        // If no safe subcmds defined, the bare command is read-only (e.g., 'mount', 'awk')
        if (safeSubs.length === 0 && !cmd.includes(' ')) return true;
        // Check if any safe subcmd matches
        return safeSubs.some(sub => cmd.includes(sub));
      }
      // Simple read-only command — allow
      return true;
    }
    // Special: curl to localhost/127.0.0.1 is read-only
    if (baseCmd === 'curl' && /localhost|127\.0\.0/.test(cmd)) return true;
    // Special: cat /proc, /etc, /sys (read system info)
    if (baseCmd === 'cat' && /^cat\s+\/(proc|etc|sys)/i.test(cmd)) return true;
    // Special: node --check (syntax check) or node -e 'console.log(...)' (print-only)
    if (baseCmd === 'node' && /--check|-e\s+console/i.test(cmd)) return true;
    // Special: python -c 'print(...)' or python -m json.tool (read-only)
    if (/^python3?$/.test(baseCmd) && /-c\s+print|-m\s+json\.tool/i.test(cmd)) return true;
    return false;
  }
  if (tool === 'pm2') return args?.action === 'list';
  if (tool === 'git_op') return ['status', 'diff', 'log', 'branch', 'fetch', 'show'].includes(args?.operation);
  return false;
}

// ── ANSI Colors ─────────────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  reverse: '\x1b[7m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  purple: '\x1b[38;5;93m',
  gray: '\x1b[90m',
  white: '\x1b[97m',
  bgPurple: '\x1b[48;5;93m',
};

// ── Message Queue ────────────────────────────────────────────────────────
// Priority queue for async notifications, background task updates, MCP events.
// Messages drain before each agent loop turn so user sees them immediately.
const _msgQueue = [];
const MSG_PRIORITIES = { critical: 0, high: 1, normal: 2, low: 3 };
const MSG_TYPES = ['notify', 'warn', 'error', 'task', 'mcp', 'system'];

function msgPush(msg, { type = 'notify', priority = 'normal', source = 'agent' } = {}) {
  const entry = {
    id: Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    msg: String(msg),
    type,
    priority: MSG_PRIORITIES[priority] ?? 2,
    source,
    ts: new Date().toISOString(),
  };
  _msgQueue.push(entry);
  _msgQueue.sort((a, b) => a.priority - b.priority || a.ts.localeCompare(b.ts));
  return entry.id;
}

function msgDrain(max = 20) {
  return _msgQueue.splice(0, Math.min(max, _msgQueue.length));
}

function msgPeek(limit = 10) {
  return _msgQueue.slice(0, limit);
}

function msgClear() {
  _msgQueue.length = 0;
}

function msgSize() {
  return _msgQueue.length;
}

// ── TUI Dashboard Panels ────────────────────────────────────────────────
// Bordered panels for REASONING, THINKING, TOOL GRID, CHAIN TABLE.
// Wide layout (91 chars inner) with side-by-side TOOL+OUTPUT grid.
// Uses the `C` color object already defined above.
// Panels scroll IN-PLACE using ANSI cursor movement — new updates
// overwrite the same screen region instead of printing new boxes.

const BOX_W = 137; // inner width of panels — expanded 50% to fill terminal

// ── In-place panel rendering tracker ──
// Maps panel name → { lineCount: number } so we can scroll over the
// previous render of the same panel instead of appending below it.
// Only overwrites in-place if the panel was the LAST thing written to stdout.
const _panelLines = {};  // e.g. { 'TOOL GRID': 12, 'REASONING': 8 }
let _lastPanelName = null;  // Track which panel was written last

// Write a panel to stdout, overwriting the previous render of the same panel
// in-place if it was the most recent output. Otherwise, just appends below.
// Uses trailing-edge debounce: rapid updates within REFRESH_MS are coalesced —
// only the LAST update in a burst is rendered, guaranteeing no lost final state.
// Returns the number of lines written.
const _panelDebounce = {};   // { name: { timer, text } }
function _writePanel(name, text) {
  const now = Date.now();
  const lastRender = _panelLines[name + '_ts'] || 0;
  const elapsed = now - lastRender;
  // Throttle: if we rendered this panel too recently, defer the update.
  // Always update the pending text so the deferred render uses the LATEST state.
  if (elapsed < REFRESH_MS && _lastPanelName === name) {
    if (_panelDebounce[name]) {
      // Already have a pending timer — just update the text (no double timer)
      _panelDebounce[name].text = text;
    } else {
      _panelDebounce[name] = {
        text,
        timer: setTimeout(() => {
          const pending = _panelDebounce[name];
          _panelDebounce[name] = null;
          if (pending) _writePanel(name, pending.text);
        }, REFRESH_MS - elapsed),
      };
    }
    return _panelLines[name] || 0;
  }
  // Clear any pending debounce for this panel — we're rendering now
  if (_panelDebounce[name]) {
    clearTimeout(_panelDebounce[name].timer);
    _panelDebounce[name] = null;
  }
  _panelLines[name + '_ts'] = now;
  const lines = text.split('\n');
  const count = lines.length;
  const prev = _panelLines[name] || 0;
  // Only scroll UP if this panel was the VERY LAST thing written to stdout.
  // If other log() output came after the previous render, we can't safely
  // overwrite — the cursor would land on the wrong content.
  const canScrollUp = prev > 0 && _lastPanelName === name;
  if (canScrollUp) {
    // Move cursor up `prev` lines, then clear from cursor to end of screen
    process.stdout.write(`\x1b[${prev}A\x1b[0J`);
  }
  process.stdout.write(text + '\n');
  _panelLines[name] = count;
  _lastPanelName = name;
  return count;
}

// ── ANSI-aware string helpers (used by all panels) ──
const _stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const _visLen    = (s) => _stripAnsi(s).length;
const _pad       = (s, len) => { const vl = _visLen(s); if (vl >= len) return _stripAnsi(s).substring(0, len); return s + ' '.repeat(len - vl); };
const _truncPad  = (s, len) => { const vl = _visLen(s); if (vl <= len) return _pad(s, len); return _stripAnsi(s).substring(0, len - 1) + '…'; };

// Detect terminal width (fallback to 137 to match expanded BOX_W)
function _termWidth() { try { return Math.max(137, process.stdout.columns || 137); } catch (_) { return 137; } }

function drawBox(title, lines, width = BOX_W, color = C.purple) {
  const b = color + C.bold;
  const R = C.reset;
  const w = width;
  const top    = `  ${b}╔${'═'.repeat(w + 2)}╗${R}`;
  const bottom = `  ${b}╚${'═'.repeat(w + 2)}╝${R}`;
  const sep    = `  ${b}╠${'═'.repeat(w + 2)}╣${R}`;
  const titleLine = `  ${b}║${R} ${C.bold}${C.reverse}${_pad(' ' + title + ' ', w)}${R}${b}║${R}`;
  const out = [top, titleLine, sep];
  for (const line of lines) {
    out.push(`  ${b}║${R} ${_pad(line, w)} ${b}║${R}`);
  }
  out.push(bottom);
  return out.join('\n');
}

// ── REASONING panel: tree-structured phases with progress bar ──
// State tracked via module-level vars updated by the agent loop
let _tuiPhase      = 'Idle';
let _tuiTarget     = '';
let _tuiPorts      = '';
let _tuiServices   = '';
let _tuiVulns      = [];   // [{svc, cve, flag}]  e.g. [{svc:'Apache 2.4.49', cve:'CVE-2021-41773', flag:'🚩'}]
let _tuiStep       = 0;
let _tuiMaxSteps   = MAX_TURNS;

function renderReasoningPanel() {
  const W = BOX_W;
  const lines = [];
  // Phase header with timestamp
  lines.push(`${C.cyan}[${new Date().toLocaleTimeString()}]${C.reset} ${C.bold}${_tuiPhase}${C.reset}`);
  // Tree-structured info lines
  const items = [];
  if (_tuiTarget)   items.push(`${C.bold}├─${C.reset} Target:   ${_tuiTarget}`);
  if (_tuiPorts)    items.push(`${C.bold}├─${C.reset} Ports:     ${_tuiPorts}`);
  if (_tuiServices) items.push(`${C.bold}├─${C.reset} Services:  ${_tuiServices}`);
  if (_tuiVulns.length > 0) {
    items.push(`${C.bold}├─${C.reset} Vulns:`);
    for (const v of _tuiVulns) {
      const flag = v.flag === '✅' ? `${C.green}✅${C.reset}` : v.flag === '🚩' ? `${C.red}🚩${C.reset}` : v.flag;
      items.push(`${C.bold}│   ${C.reset}├─ ${v.svc} → ${C.bold}${v.cve}${C.reset} ${flag}`);
    }
  }
  // Add items with proper indentation
  for (const item of items) {
    lines.push(`           ${item}`);
  }
  // Progress bar
  const progress = _tuiMaxSteps > 0 ? Math.round((_tuiStep / _tuiMaxSteps) * 100) : 0;
  const barLen = 20;
  const filled = Math.round(progress / 100 * barLen);
  const bar = `${C.yellow}─${C.reset}${C.bold}█${C.reset}${C.yellow}═══${C.reset} ${C.bold}PROGRESS${C.reset} ${barLen > 0 ? `${'█'.repeat(filled)}${'░'.repeat(barLen - filled)}` : ''} ${C.bold}${progress}%${C.reset}`;
  lines.push(`           ${C.bold}└─${C.reset} Status  ${bar}  Step ${_tuiStep}/${_tuiMaxSteps}`);
  return drawBox('REASONING', lines, W, C.cyan);
}

// ── THINKING panel: emoji-prefixed reasoning lines, word-wrapped ──
function renderThinkingPanel(thinkText) {
  // BUG 17 FIX: Strip hallucinated TUI lines before display
  const cleaned = _stripFakeTui(thinkText);
  if (!cleaned) return '';
  const W = BOX_W;
  const lines = [];
  const thinkLines = cleaned.split('\n').filter(l => l.trim());
  // Wrap each thinking line to fit in the panel
  const maxW = W - 4; // leave room for " │ " prefix
  for (const line of thinkLines.slice(0, 20)) {
    const raw = _stripAnsi(line);
    if (raw.length <= maxW) {
      lines.push(line);
    } else {
      // Word-wrap long lines
      const words = line.split(' ');
      let cur = '';
      for (const word of words) {
        const test = cur ? cur + ' ' + word : word;
        if (_visLen(test) > maxW) {
          if (cur) lines.push(cur);
          cur = word;
        } else {
          cur = test;
        }
      }
      if (cur) lines.push(cur);
    }
  }
  if (thinkLines.length > 20) {
    lines.push(`${C.dim}... (${thinkLines.length - 20} more lines)${C.reset}`);
  }
  return drawBox('THINKING', lines, W, C.magenta);
}

// ── TOOL GRID panel: split layout — commands left, output right ──
let _tuiToolGrid = [];  // [{emoji, name, status, output}]  status: 'running'|'ok'|'err'

function renderToolPanel() {
  try {
  const W = BOX_W;
  // Split: TOOL GRID (left) | OUTPUT (right)
  const innerW = W - 4;  // inner box usable width
  const splitRatio = 0.58;
  const leftW = Math.floor(innerW * splitRatio);
  const rightW = innerW - leftW - 3;  // -3 for " │ " separator
  const lines = [];
  // Show last MAX_LOG_LINES tools
  const recent = _tuiToolGrid.slice(-MAX_LOG_LINES);
  if (_tuiToolGrid.length > MAX_LOG_LINES) {
    const older = _tuiToolGrid.length - MAX_LOG_LINES;
    lines.push(`${C.dim}  ↑ ${older} older tool${older !== 1 ? 's' : ''}${C.reset}`);
  }
  for (const t of recent) {
    const rowColor = t.status === 'running' ? C.yellow : t.status === 'ok' ? C.green : C.red;
    const statusIcon = t.status === 'running' ? '⏳' : t.status === 'ok' ? '✅' : '❌';
    const baseName = t.name.split(' → ')[0];
    const badge = TOOL_TYPE[baseName] || '??';
    const badgeStr = `${C.dim}${badge}${C.reset}`;
    const left  = `${badgeStr} ${statusIcon} ${rowColor}${t.name}${C.reset}`;
    const right = t.status === 'running' ? `${C.yellow}...${C.reset}` : (t.output || '');
    lines.push(`${_truncPad(left, leftW)}${C.dim} │${C.reset} ${_truncPad(right, rightW)}`);
  }
  // Separator between tools and summary
  lines.push(`${C.dim}${'─'.repeat(leftW)}${C.bold}─┼─${C.reset}${C.dim}${'─'.repeat(rightW)}${C.reset}`);
  // Status summary with progress bar
  const total = _tuiToolGrid.length;
  const errs  = _tuiToolGrid.filter(t => t.status === 'error').length;
  const runs  = _tuiToolGrid.filter(t => t.status === 'running').length;
  const oks   = _tuiToolGrid.filter(t => t.status === 'ok').length;
  const barLen = 20;
  const filled = total > 0 ? Math.round((oks / total) * barLen) : 0;
  const bar = `${C.green}${'█'.repeat(filled)}${C.dim}${'░'.repeat(barLen - filled)}${C.reset}`;
  lines.push(`${C.bold}Total:${C.reset} ${total}  ${C.green}✅${oks}${C.reset}  ${C.yellow}⏳${runs}${C.reset}  ${C.red}❌${errs}${C.reset}  ${bar}`);
  // Status-dependent border color
  const borderColor = errs > 0 ? C.red : runs > 0 ? C.yellow : C.green;
  const b = borderColor + C.bold;
  const R = C.reset;
  // ── Custom box with split title: TOOL GRID ───┼─── OUTPUT ──── ──
  const top    = `  ${b}╔${'═'.repeat(W + 2)}╗${R}`;
  const bottom = `  ${b}╚${'═'.repeat(W + 2)}╝${R}`;
  // Title bar: "TOOL GRID" left, "OUTPUT" right, ┬ divider
  // Build inner content exactly innerW wide, then _pad to W for box alignment
  const ltRaw = ' TOOL GRID ';
  const rtRaw = ' OUTPUT ';
  const leftDash = '─'.repeat(Math.max(0, leftW - ltRaw.length - 1));
  const rightDash = '─'.repeat(Math.max(0, rightW - rtRaw.length - 1));
  const titleInner = `${C.bold}${C.reverse}${ltRaw}${R}${C.dim}${leftDash}${R} ${C.dim}${b}─${R}${C.bold}┬${R}${C.dim}${b}─${R} ${C.bold}${C.reverse}${rtRaw}${R}${C.dim}${rightDash}${R}`;
  const titleLine = `  ${b}║${R} ${_pad(titleInner, W)} ${b}║${R}`;
  const sep    = `  ${b}╠${'═'.repeat(W + 2)}╣${R}`;
  const out = [top, titleLine, sep];
  for (const line of lines) {
    out.push(`  ${b}║${R} ${_pad(line, W)} ${b}║${R}`);
  }
  out.push(bottom);
  return out.join('\n');
  } catch (e) {
    if (globalThis._agentDebug) console.error('[renderToolPanel error]', e.message);
    return '';
  }
}

// ── CHAIN TABLE panel: CVE chains and privesc paths ──
let _tuiChains = []; // [{desc, tag}]  e.g. [{desc:'Apache PT → Ghostcat AJP → Shell → Root', tag:'🎯'}]

function renderChainPanel() {
  if (_tuiChains.length === 0) return '';
  const W = BOX_W;
  const lines = [];
  for (const c of _tuiChains) {
    lines.push(`${c.tag} ${C.bold}${c.desc}${C.reset}`);
  }
  lines.push(`${'═'.repeat(W - 4)}`);
  return drawBox('CHAIN TABLE', lines, W, C.yellow);
}

// ── Dashboard composition: render all non-empty panels ──
function renderDashboard(thinkText) {
  const parts = [];
  if (_tuiPhase !== 'Idle') parts.push(renderReasoningPanel());
  const tp = renderThinkingPanel(thinkText);
  if (tp) parts.push(tp);
  if (_tuiToolGrid.length > 0) parts.push(renderToolPanel());
  if (_tuiChains.length > 0) parts.push(renderChainPanel());
  return parts.join('\n');
}

// ── Dashboard state updates (called from agent loop) ──
function tuiSetPhase(phase)     { _tuiPhase = phase; }
function tuiSetTarget(target)   { _tuiTarget = target; }
function tuiSetPorts(ports)     { _tuiPorts = ports; }
function tuiSetServices(svc)    { _tuiServices = svc; }
function tuiAddVuln(svc, cve, flag) { _tuiVulns.push({ svc, cve, flag }); }
function tuiSetStep(step, max)  { _tuiStep = step; if (max) _tuiMaxSteps = max; }
function tuiToolStart(emoji, name) {
  // Remove any previous 'running' entry for same tool to avoid dupes
  // Match by prefix (fnName) since name may include arg hint like "search_files → /path"
  const baseName = name.split(' → ')[0];
  _tuiToolGrid = _tuiToolGrid.filter(t => {
    const tBase = t.name.split(' → ')[0];
    return !(tBase === baseName && t.status === 'running');
  });
  _tuiToolGrid.push({ emoji: emoji || '🛠️', name, status: 'running', output: '' });
}
function tuiToolDone(name, status, output) {
  // Match by base name (fnName) since grid entries may include arg hints
  const baseName = name.split(' → ')[0];
  const t = _tuiToolGrid.find(t => {
    const tBase = t.name.split(' → ')[0];
    return tBase === baseName && t.status === 'running';
  });
  if (t) { t.status = status; t.output = (output || '').substring(0, 80); }
}
function tuiAddChain(desc, tag) { _tuiChains.push({ desc, tag: tag || '🎯' }); }
function tuiReset() {
  _tuiPhase = 'Idle'; _tuiTarget = ''; _tuiPorts = ''; _tuiServices = '';
  _tuiVulns = []; _tuiStep = 0; _tuiMaxSteps = MAX_TURNS;
  _tuiToolGrid = []; _tuiChains = [];
  // Reset in-place panel tracking so fresh sessions don't scroll over stale panels
  for (const k of Object.keys(_panelLines)) delete _panelLines[k];
}

// ── Banner ───────────────────────────────────────────────────────────────
function banner() {
  // Dynamically count skills from .hakster/skills/
  const skillsDirs = getHaksterRoots().map(root => path.join(root, 'skills'));
  let skillCount = 0;
  for (const skillsDir of skillsDirs) {
    try { skillCount += globSync(path.join(skillsDir, '**', '*.md')).length; } catch (_) {}
  }
  const mcpToolCount = getMcpTools().length;
  const toolLabel = mcpToolCount > 0 ? `${TOOLS.length} + ${mcpToolCount} MCP` : `${TOOLS.length}`;
  let memCount = 0;
  try { memCount = JSON.parse(fs.readFileSync(path.join(WORK_DIR, '.hakster', 'memory', 'notes.json'), 'utf-8')).length; } catch (_) {}

  // Width constant — outer box inner width adapts to terminal (min 137, ~50% bigger)
  const W = _termWidth() - 6;  // 6 = border + padding chars
  const b = C.purple + C.bold;
  const R = C.reset;
  // Strip ANSI escape sequences to measure visible character width
  const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
  const visLen = (s) => stripAnsi(s).length;
  const pad = (s, len) => {
    const vl = visLen(s);
    if (vl >= len) return stripAnsi(s).substring(0, len);
    return s + ' '.repeat(len - vl);
  };
  const truncPad = (s, len) => {
    const vl = visLen(s);
    if (vl <= len) return pad(s, len);
    // Truncate visible text, keeping color codes intact
    return s + '…';  // simplistic: just add ellipsis if too long
  };

  // ── MASSIVE PIXEL-DOUBLED HAKSTER LOGO ──
  // Banner font from figlet, pixel-doubled for 20x visual impact
  const _bannerArt = [
    "██          ██        ██        ██        ██    ████████    ██████████  ██████████  ████████  ",
    "██          ██      ██  ██      ██      ██    ██      ██      ██      ██        ██      ██  ",
    "██          ██    ██      ██    ██    ██      ██            ██      ██              ██      ██  ",
    "██████████████  ██      ██  ██████        ████████      ██      ████████      ████████    ",
    "██          ██  ██████████  ██    ██            ██      ██      ██              ██  ██      ",
    "██          ██  ██      ██  ██      ██    ██      ██      ██      ██              ██    ██    ",
    "██          ██  ██      ██  ██        ██    ████████      ██      ██████████  ██      ██  ",
  ];

  // Render the logo left-aligned (fill top-left corner) with bold purple
  // Each row is: left padding (0 chars — flush left) + colored art + remaining space for info
  const art = _bannerArt.map(row => {
    // Truncate or pad each row to W
    const raw = row.substring(0, Math.min(row.length, W));
    return `${b}${raw}${R}`;
  });

  // Helper: outer box line with content
  const outerLine = (text) => `  ${b}│${R} ${pad(text, W)} ${b}│${R}`;
  const outerSep  = () => `  ${b}├${'─'.repeat(W + 2)}┤${R}`;
  const outerEmpty = () => outerLine('');

  // (art array already declared above — pixel-doubled massive HAKSTER logo)

  // Inner panel helper — draws a labeled box inside the outer box
  // Inner box uses cyan for REASONING, magenta for THINKING, green for TOOL GRID, yellow for CHAIN TABLE
  const innerBox = (label, lines, color = C.cyan) => {
    const iw = W - 4;  // inner box inner width (2 chars margin each side)
    const ib = color + C.bold;
    const top    = `  ${b}│${R}  ${ib}┌${'─'.repeat(iw + 2)}┐${R}  ${b}│${R}`;
    const bottom = `  ${b}│${R}  ${ib}└${'─'.repeat(iw + 2)}┘${R}  ${b}│${R}`;
    const sep    = `  ${b}│${R}  ${ib}├${'─'.repeat(iw + 2)}┤${R}  ${b}│${R}`;
    const titleLine = `  ${b}│${R}  ${ib}│${R} ${C.bold}${pad(label, iw)}${R} ${ib}│${R}  ${b}│${R}`;
    const contentLines = lines.map(l => {
      return `  ${b}│${R}  ${ib}│${R} ${truncPad(l, iw)} ${ib}│${R}  ${b}│${R}`;
    });
    return [top, titleLine, sep, ...contentLines, bottom].join('\n');
  };

  // ── Build the banner ──
  const lines = [];

  // Top border
  lines.push(`  ${b}┌${'─'.repeat(W + 2)}┐${R}`);

  // HAKSTER ASCII art
  for (const a of art) {
    lines.push(outerLine(a));
  }

  // Separator line
  lines.push(outerLine(`${'═'.repeat(W)}`));

  // Version / status line — centered in W
  const versionStr = `${C.bold}HAKSTER AI${R}  ${C.dim}v2.1${R}`;
  const statusStr = `${C.green}[ACTIVE]${R}  🟢  ⚡  🔒`;
  const versionPad = W - stripAnsi(versionStr + statusStr).length;
  const halfPad = Math.max(0, Math.floor(versionPad / 2));
  lines.push(outerLine(`${versionStr}${' '.repeat(halfPad)}${statusStr}`));

  // Stat line (tools + skills + mems)
  lines.push(outerLine(`${C.cyan}${C.bold}tools${R} ${C.bold}${toolLabel}${R} ${C.yellow}•${R} ${C.magenta}${C.bold}skills${R} ${C.bold}${skillCount}${R} ${C.yellow}•${R} ${C.green}${C.bold}mems${R} ${C.bold}${memCount}${R} ${C.yellow}•${R} ${C.red}${C.bold}⚠ confirm${R}`));

  // Separator before panels
  lines.push(outerSep());

  // ── REASONING panel (idle state at startup) ──
  const reasoningLines = [
    `${C.cyan}[${new Date().toLocaleTimeString()}]${R} ${C.bold}Phase:${R} Waiting for target...`,
    `          ${C.dim}Enter a task to begin${R}`,
  ];
  lines.push(innerBox('REASONING', reasoningLines, C.cyan));

  // Empty line between panels
  lines.push(outerEmpty());

  // ── THINKING panel (idle state at startup) ──
  const thinkingLines = [
    `${C.dim}🤔 Awaiting input...${R}`,
    `${C.dim}Type a task and the agent will reason automatically.${R}`,
  ];
  lines.push(innerBox('THINKING', thinkingLines, C.magenta));

  // Empty line between panels
  lines.push(outerEmpty());

  // ── TOOL GRID panel (idle state at startup) ── split header style ──
  const innerW = W - 4;
  const splitRatio = 0.58;
  const leftW = Math.floor(innerW * splitRatio);
  const rightW = innerW - leftW - 3;
  const ltRaw = ' TOOL GRID ';
  const rtRaw = ' OUTPUT ';
  const leftDash = '─'.repeat(Math.max(0, leftW - ltRaw.length - 1));
  const rightDash = '─'.repeat(Math.max(0, rightW - rtRaw.length - 1));
  const toolTitleInner = `${C.bold}${C.reverse}${ltRaw}${R}${C.dim}${leftDash}${R} ${C.dim}${b}─${R}${C.bold}┬${R}${C.dim}${b}─${R} ${C.bold}${C.reverse}${rtRaw}${R}${C.dim}${rightDash}${R}`;
  const toolTitleLine = `  ${C.green}${C.bold}║${R} ${_pad(toolTitleInner, W)} ${C.green}${C.bold}║${R}`;
  const toolSepLine    = `  ${C.green}${C.bold}╠${'═'.repeat(W + 2)}╣${R}`;
  const toolContentLines = [
    `${_truncPad(`  [ ]  Waiting for tool calls...`, leftW)}${C.dim} │${R} ${_truncPad('', rightW)}`,
    `${C.dim}${'─'.repeat(leftW)}${C.bold}─┼─${R}${C.dim}${'─'.repeat(rightW)}${R}`,
    `${C.bold}Total:${R} 0  ${C.green}✅0${R}  ${C.yellow}⏳0${R}  ${C.red}❌0${R}  ${C.dim}${'░'.repeat(20)}${R}`,
  ];
  const toolGridBox = [
    `  ${C.green}${C.bold}╔${'═'.repeat(W + 2)}╗${R}`,
    toolTitleLine,
    toolSepLine,
    ...toolContentLines.map(l => `  ${C.green}${C.bold}║${R} ${_pad(l, W)} ${C.green}${C.bold}║${R}`),
    `  ${C.green}${C.bold}╚${'═'.repeat(W + 2)}╝${R}`,
  ];
  lines.push(...toolGridBox);

  // Empty line between panels
  lines.push(outerEmpty());

  // ── CHAIN TABLE (idle state at startup) ──
  const chainLines = [
    `${C.dim}No exploit chains yet${R}`,
    `${'═'.repeat(W - 12)}`,
    `${C.dim}Chains will appear as vulnerabilities are linked.${R}`,
  ];
  lines.push(innerBox('CHAIN TABLE', chainLines, C.yellow));

  // Empty line before footer
  lines.push(outerEmpty());

  // Separator before footer
  lines.push(outerSep());

  // Footer with keybindings
  lines.push(outerLine(`${C.green}[Ctrl+C]${R} Exit  ${C.green}[Tab]${R} Panels  ${C.green}[↑↓]${R} Scroll  ${C.green}[F5]${R} Refresh`));

  // Bottom border
  lines.push(`  ${b}└${'─'.repeat(W + 2)}┘${R}`);

  return '\n' + lines.join('\n') + '\n';
}

// ── Tool Definitions ────────────────────────────────────────────────────
let TOOLS = [
  {
    type: 'function',
    function: {
      name: 'shell',
      description: 'Execute a shell command and return stdout+stderr. Runs in the project working directory.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute' },
          timeout: { type: 'number', description: 'Timeout in seconds (default 30, max 300)' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file and return its contents. Supports offset/limit for large files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path (absolute or relative to project)' },
          offset: { type: 'number', description: 'Line number to start reading from (1-indexed)' },
          limit: { type: 'number', description: 'Max lines to return' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write content to a file. Creates parent directories. Overwrites existing files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
          content: { type: 'string', description: 'Full file content to write' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'patch_file',
      description: 'Find and replace text in a file. For targeted edits without rewriting the whole file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
          old_text: { type: 'string', description: 'Text to find (must be unique in file)' },
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
      description: 'List files and directories at a path. Returns names, sizes, types.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path (default: project root)' },
          recursive: { type: 'boolean', description: 'List recursively (default: false)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: 'Fetch a URL and return the response body (text/HTML/JSON). For reading docs, APIs, etc.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to fetch' },
          method: { type: 'string', description: 'HTTP method (default: GET)', enum: ['GET', 'POST', 'PUT', 'DELETE'] },
          headers: { type: 'object', description: 'Request headers' },
          body: { type: 'string', description: 'Request body (for POST/PUT)' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'Search for files by name pattern or search inside file contents with regex.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern for filenames, or regex for content search' },
          path: { type: 'string', description: 'Directory to search in (default: project root)' },
          mode: { type: 'string', description: '"files" to find by name, "content" to search inside files', enum: ['files', 'content'] },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_background',
      description: 'Start a long-running process in the background (servers, watchers). Returns PID.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Command to run in background' },
          name: { type: 'string', description: 'Friendly name for the process' },
        },
        required: ['command', 'name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'kill_process',
      description: 'Kill a background process by name or PID.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Process name to kill' },
          pid: { type: 'number', description: 'Process PID to kill' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'multi_patch',
      description: 'Apply multiple find-and-replace patches to a single file in one call. Faster than calling patch_file repeatedly.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
          patches: {
            type: 'array',
            description: 'Array of {old_text, new_text} pairs to apply sequentially',
            items: {
              type: 'object',
              properties: {
                old_text: { type: 'string', description: 'Text to find (must be unique in file)' },
                new_text: { type: 'string', description: 'Replacement text' },
              },
              required: ['old_text', 'new_text'],
            },
          },
        },
        required: ['path', 'patches'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'insert_lines',
      description: 'Insert text at a specific line number in a file. Does not modify existing lines. Use for adding imports, functions, config blocks.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
          line: { type: 'number', description: 'Line number to insert AFTER (0 = insert at top)' },
          content: { type: 'string', description: 'Text to insert' },
        },
        required: ['path', 'line', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_lines',
      description: 'Delete a range of lines from a file. Line numbers are 1-indexed.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
          start: { type: 'number', description: 'Start line number (1-indexed, inclusive)' },
          end: { type: 'number', description: 'End line number (1-indexed, inclusive)' },
        },
        required: ['path', 'start', 'end'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'replace_regex',
      description: 'Regex find-and-replace in a file. Use for bulk renames, pattern changes, removing all occurrences. Set replace_all=true for global replace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
          pattern: { type: 'string', description: 'JavaScript regex pattern (e.g. "console\\.log\\(.*?\\)")' },
          replacement: { type: 'string', description: 'Replacement string ($1, $2 for capture groups)' },
          flags: { type: 'string', description: 'Regex flags (default: "g"). Use "g" for global, "gi" for case-insensitive.' },
        },
        required: ['path', 'pattern', 'replacement'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'append_file',
      description: 'Append content to end of file. Much faster than read_file + write_file for adding lines.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
          content: { type: 'string', description: 'Text to append' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_op',
      description: 'Execute a git operation. Common: status, diff, add, commit, push, log, branch, checkout. For complex git commands use shell tool instead.',
      parameters: {
        type: 'object',
        properties: {
          operation: {
            type: 'string',
            description: 'Git operation',
            enum: ['status', 'diff', 'add', 'commit', 'push', 'pull', 'log', 'branch', 'checkout', 'stash', 'reset', 'fetch'],
          },
          args: { type: 'string', description: 'Arguments for the operation (e.g. commit message, branch name, file paths)' },
        },
        required: ['operation'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pm2',
      description: 'Manage PM2 processes. Start, stop, restart, logs, status for haksterAI, CineVault, Miniforge, Phantom services.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description: 'PM2 action',
            enum: ['list', 'restart', 'stop', 'start', 'logs', 'describe'],
          },
          name: { type: 'string', description: 'Process name (hakster, cinevault, miniforge, phantom)' },
          lines: { type: 'number', description: 'Lines of logs to show (default: 30)' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'service_check',
      description: 'Quick health check for local services. Tests if haksterAI (3579), CineVault (8081), Miniforge (5555), or Phantom (4000) are responding.',
      parameters: {
        type: 'object',
        properties: {
          service: {
            type: 'string',
            description: 'Service to check',
            enum: ['haksterai', 'cinevault', 'miniforge', 'phantom', 'all'],
          },
        },
        required: ['service'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'snapshot',
      description: 'Take a screenshot of a web page or localhost URL. Returns a description of what the page looks like. Use to verify UI changes, debug layout issues, or check deployed apps visually.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to snapshot (e.g. http://localhost:3579/chat)' },
          width: { type: 'number', description: 'Viewport width in px (default: 1280)' },
          height: { type: 'number', description: 'Viewport height in px (default: 800)' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'sub_agent',
      description: 'Spawn one or more sub-agents that run in parallel. Each sub-agent gets its own conversation and can use ALL tools. Use for: running multiple independent tasks simultaneously, researching multiple topics at once, parallelizing file edits across different files. Returns each sub-agent result. Max 3 sub-agents per call.',
      parameters: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            description: 'Array of tasks to run in parallel. Each task has a goal string.',
            items: {
              type: 'object',
              properties: {
                goal: { type: 'string', description: 'What this sub-agent should accomplish' },
                name: { type: 'string', description: 'Short name for this task (e.g. "check-ports", "fix-auth")' },
              },
              required: ['goal'],
            },
            maxItems: 3,
          },
        },
        required: ['tasks'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'parallel_shell',
      description: 'Run multiple shell commands in parallel. Returns all outputs together. Use for checking multiple ports, running independent diagnostics, or parallel file operations.',
      parameters: {
        type: 'object',
        properties: {
          commands: {
            type: 'array',
            description: 'Array of shell commands to run simultaneously',
            items: { type: 'string' },
            maxItems: 5,
          },
          timeout: { type: 'number', description: 'Timeout per command in seconds (default: 30)' },
        },
        required: ['commands'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'code_grid',
      description: 'Display code with line numbers and syntax coloring in a grid. Use for showing code to the user — always use this when presenting code files, diffs, or file contents. Renders a colored, line-numbered grid that highlights modifications, additions (green +), and deletions (red -).',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'The code content to display' },
          title: { type: 'string', description: 'File name or title for the grid header' },
          lang: { type: 'string', description: 'Language for syntax hints (js, py, html, css, json, bash, etc.)' },
          highlight_lines: {
            type: 'array',
            description: 'Line numbers to highlight (changed/important lines)',
            items: { type: 'number' },
          },
          diff_lines: {
            type: 'array',
            description: 'Lines that are additions (+) or deletions (-). Prefix with + or - e.g. "+5" means line 5 is an addition',
            items: { type: 'string' },
          },
        },
        required: ['code', 'title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_navigate',
      description: 'Navigate a headless browser to a URL. Opens the page and waits for it to load. Returns the page title, URL, and a text snapshot of visible content. Use before browser_click, browser_type, or browser_screenshot.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to navigate to (e.g. http://localhost:3579/chat)' },
          wait_ms: { type: 'number', description: 'Milliseconds to wait after load for JS to render (default: 2000)' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_click',
      description: 'Click an element on the current browser page by its text content, CSS selector, or index. Returns the result and updated page snapshot.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector or button/link text to click' },
          index: { type: 'number', description: 'If multiple matches, click the Nth one (0-based, default: 0)' },
        },
        required: ['selector'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_type',
      description: 'Type text into an input field on the current browser page. Clears existing text first, then types the new value.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector for the input field' },
          text: { type: 'string', description: 'Text to type into the field' },
          press_enter: { type: 'boolean', description: 'Press Enter after typing (default: false)' },
        },
        required: ['selector', 'text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_screenshot',
      description: 'Take a real screenshot of the current browser page (PNG). Returns the file path. Use to visually verify UI, debug layout, or check what a page looks like.',
      parameters: {
        type: 'object',
        properties: {
          full_page: { type: 'boolean', description: 'Capture the full scrollable page (default: false, viewport only)' },
          selector: { type: 'string', description: 'CSS selector to screenshot a specific element only' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_snapshot',
      description: 'Get an accessibility tree snapshot of the current browser page. Returns interactive elements (buttons, links, inputs) with ref IDs for clicking/typing. Use to understand page structure before interacting.',
      parameters: {
        type: 'object',
        properties: {
          full: { type: 'boolean', description: 'Return full page content (default: false, compact view with interactive elements only)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory',
      description: 'Save or recall persistent notes that survive across sessions. Use "add" to save a fact, "list" to see all notes, "get" to read one, "remove" to delete one, "search" to find by keyword. Notes are automatically loaded into context at the start of each conversation. Save user preferences, project conventions, environment facts, and anything worth remembering.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['add', 'list', 'get', 'remove', 'search'], description: 'Action: add a note, list all, get by id, remove by id, or search by keyword' },
          content: { type: 'string', description: 'Note content (for add action)' },
          id: { type: 'string', description: 'Note ID (for get/remove actions)' },
          query: { type: 'string', description: 'Search keyword (for search action)' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'skill_save',
      description: 'Save a reusable skill/procedure as a markdown file. Skills capture workflows, step-by-step procedures, gotchas, and best practices. Like a playbook you can load later. Use when you discover a repeatable process worth remembering.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Skill name (lowercase, hyphens, e.g. "deploy-cinevault")' },
          content: { type: 'string', description: 'Full skill content in markdown (steps, commands, gotchas)' },
          category: { type: 'string', description: 'Optional category folder (e.g. "devops", "debugging")' },
        },
        required: ['name', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'skill_load',
      description: 'Load a saved skill by name. Returns the full markdown content. Use before executing a workflow you have a skill for.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Skill name to load' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'skill_list',
      description: 'List all saved skills with names and categories. Use to discover available skills.',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', description: 'Filter by category' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'notify',
      description: 'Push a message to the notification queue. Messages are displayed to the user before their next input and can be viewed with /queue.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'The notification message' },
          type: { type: 'string', description: 'Message type: notify, warn, error, task, mcp, system', enum: ['notify', 'warn', 'error', 'task', 'mcp', 'system'] },
          priority: { type: 'string', description: 'Priority: critical, high, normal, low', enum: ['critical', 'high', 'normal', 'low'] },
        },
        required: ['message'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_image',
      description: 'Generate an image from a text prompt using DALL-E 3 or gpt-image-1. Returns the saved file path.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Text description of the desired image' },
          model: { type: 'string', description: 'Model to use: dall-e-3 (default) or gpt-image-1', enum: ['dall-e-3', 'gpt-image-1'] },
          size: { type: 'string', description: 'Image size: 1024x1024 (default), 1024x1792, or 1792x1024', enum: ['1024x1024', '1024x1792', '1792x1024'] },
          quality: { type: 'string', description: 'Quality: standard (default) or hd (dall-e-3 only)', enum: ['standard', 'hd'] },
        },
        required: ['prompt'],
      },
    },
  },
];

// ── Background process registry ──────────────────────────────────────────
const bgProcesses = new Map();

// ── Async shell (replaces execSync — non-blocking, proper timeout kill) ──
function asyncShell(command, opts = {}) {
  const { cwd = WORK_DIR, timeout = 30, maxBuffer = 1024 * 1024 * 5 } = opts;
  return new Promise((resolve) => {
    const child = spawn('/bin/bash', ['-c', command], {
      cwd,
      env: { ...process.env, FORCE_COLOR: '0', TERM: 'dumb' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,  // needed for process.kill(-pid) to wipe the group
    });
    let stdout = '', stderr = '';
    let killed = false;
    let resolved = false;

    const timer = setTimeout(() => {
      killed = true;
      try { child.kill('SIGKILL'); } catch (_) {}
      // Kill entire process group to clean up any child processes
      try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
      // Force-resolve after SIGKILL if close event never fires (zombie stdio pipes)
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          const out = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
          resolve({ ok: false, stdout: stdout.trim(), stderr: stderr.trim(), exitCode: -1, killed: true, output: out + `\n[timeout after ${timeout}s, force-resolved]` });
        }
      }, 2000);  // 2s grace after SIGKILL for close to fire
    }, Math.min(timeout, 300) * 1000);

    child.stdout.on('data', (d) => {
      if (stdout.length < maxBuffer) stdout += d;
    });
    child.stderr.on('data', (d) => {
      if (stderr.length < maxBuffer) stderr += d;
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (resolved) return;
      resolved = true;
      if (killed) {
        const out = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
        resolve({ ok: false, stdout: stdout.trim(), stderr: stderr.trim(), exitCode: code ?? -1, killed: true, output: out + `\n[timeout after ${timeout}s]` });
      } else if (code !== 0) {
        resolve({ ok: false, stdout: stdout.trim(), stderr: stderr.trim(), exitCode: code, output: [stdout.trim(), stderr.trim(), `exit code: ${code}`].filter(Boolean).join('\n') });
      } else {
        resolve({ ok: true, stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0, output: stdout.trim() || '(command produced no output)' });
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      if (resolved) return;
      resolved = true;
      resolve({ ok: false, stdout: '', stderr: err.message, exitCode: -1, output: `Error: ${err.message}` });
    });
  });
}

// ── Tool Executors ──────────────────────────────────────────────────────
const toolExecutors = {
  async shell({ command, timeout = 30 }) {
    const result = await asyncShell(command, { timeout });
    return result.output;
  },

  read_file({ path: filePath, offset = 1, limit = 500 }) {
    const resolved = path.resolve(WORK_DIR, filePath);
    try {
      if (!fs.existsSync(resolved)) return `Error: File not found: ${resolved}`;
      const content = fs.readFileSync(resolved, 'utf-8');
      const lines = content.split('\n');
      const totalWidth = String(lines.length).length + 1;
      const start = Math.max(0, offset - 1);
      const end = Math.min(lines.length, start + limit);
      const sliced = lines.slice(start, end);
      // Color line numbers with dim purple, alternating subtle bg for readability
      const numbered = sliced.map((l, i) => {
        const lineNum = String(start + i + 1).padStart(totalWidth);
        const bgColor = i % 2 === 0 ? '\x1b[48;5;234m' : '\x1b[48;5;236m';
        return `${bgColor}\x1b[38;5;183m${lineNum}│\x1b[0m${l}`;
      }).join('\n');
      return numbered + `\n--- showing lines ${start + 1}-${end} of ${lines.length} ---`;
    } catch (err) {
      return `Error: ${err.message}`;
    }
  },

  write_file({ path: filePath, content }) {
    const resolved = path.resolve(WORK_DIR, filePath);
    try {
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, content, 'utf-8');
      const lines = content.split('\n').length;
      return `✓ Wrote ${lines} lines to ${resolved}`;
    } catch (err) {
      return `Error: ${err.message}`;
    }
  },

  patch_file({ path: filePath, old_text, new_text }) {
    const resolved = path.resolve(WORK_DIR, filePath);
    try {
      if (!fs.existsSync(resolved)) return `Error: File not found: ${resolved}`;
      let content = fs.readFileSync(resolved, 'utf-8');
      const idx = content.indexOf(old_text);
      if (idx === -1) return `Error: old_text not found in ${resolved}`;
      if (content.indexOf(old_text, idx + 1) !== -1) return `Error: old_text is not unique in ${resolved}`;
      content = content.replace(old_text, new_text);
      fs.writeFileSync(resolved, content, 'utf-8');
      return `✓ Patched ${resolved}`;
    } catch (err) {
      return `Error: ${err.message}`;
    }
  },

  list_dir({ path: dirPath = '.', recursive = false }) {
    const resolved = path.resolve(WORK_DIR, dirPath);
    try {
      if (!fs.existsSync(resolved)) return `Error: Directory not found: ${resolved}`;
      const items = [];
      function walk(dir, prefix = '') {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
          if (entry.name === 'node_modules') { items.push(`${prefix}📁 ${entry.name}/ (skipped)`); continue; }
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            items.push(`${prefix}📁 ${entry.name}/`);
            if (recursive) walk(full, prefix + '  ');
          } else {
            const stat = fs.statSync(full);
            const size = stat.size < 1024 ? `${stat.size}B` : `${(stat.size / 1024).toFixed(1)}KB`;
            items.push(`${prefix}📄 ${entry.name} (${size})`);
          }
        }
      }
      walk(resolved);
      return items.join('\n') || '(empty directory)';
    } catch (err) {
      return `Error: ${err.message}`;
    }
  },

  async web_fetch({ url, method = 'GET', headers = {}, body }) {
    try {
      const u = new URL(url);
      const options = { method, headers: { 'User-Agent': 'haksterAI/1.0', ...headers } };
      if (body) options.body = body;
      const resp = await fetch(url, options);
      const text = await resp.text();
      const truncated = text.length > 10000 ? text.substring(0, 10000) + '\n... (truncated)' : text;
      return `${resp.status} ${resp.statusText}\n${truncated}`;
    } catch (err) {
      return `Error: ${err.message}`;
    }
  },

  async search_files({ pattern, path: dirPath = '.', mode = 'files' }) {
    const resolved = path.resolve(WORK_DIR, dirPath);
    try {
      if (mode === 'files') {
        const result = await asyncShell(`find ${resolved} -name "${pattern}" -not -path "*/node_modules/*" -not -path "*/.git/*" | head -50`, { timeout: 10 });
        return result.ok ? (result.stdout || '(no files found)') : (result.output || '(no files found)');
      } else {
        const result = await asyncShell(`grep -rn "${pattern}" ${resolved} --include="*.js" --include="*.ts" --include="*.py" --include="*.astro" --include="*.json" --include="*.md" --exclude-dir=node_modules --exclude-dir=.git | head -50`, { timeout: 10 });
        return result.ok ? (result.stdout || '(no matches found)') : (result.output || '(no matches found)');
      }
    } catch (err) {
      return `(no matches)`;
    }
  },

  run_background({ command, name }) {
    try {
      const child = spawn('/bin/bash', ['-c', command], {
        cwd: WORK_DIR,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, FORCE_COLOR: '0' },
      });
      child.unref();
      bgProcesses.set(name, { pid: child.pid, child, command });
      return `✓ Started "${name}" (PID ${child.pid})`;
    } catch (err) {
      return `Error: ${err.message}`;
    }
  },

  kill_process({ name, pid }) {
    try {
      if (name && bgProcesses.has(name)) {
        const proc = bgProcesses.get(name);
        process.kill(proc.pid, 'SIGTERM');
        bgProcesses.delete(name);
        return `✓ Killed "${name}" (PID ${proc.pid})`;
      }
      if (pid) {
        process.kill(pid, 'SIGTERM');
        return `✓ Killed PID ${pid}`;
      }
      return 'Error: provide name or pid';
    } catch (err) {
      return `Error: ${err.message}`;
    }
  },

  multi_patch({ path: filePath, patches }) {
    const resolved = path.resolve(WORK_DIR, filePath);
    try {
      if (!fs.existsSync(resolved)) return `Error: File not found: ${resolved}`;
      let content = fs.readFileSync(resolved, 'utf-8');
      const results = [];
      for (let i = 0; i < patches.length; i++) {
        const { old_text, new_text } = patches[i];
        const idx = content.indexOf(old_text);
        if (idx === -1) { results.push(`Patch ${i + 1}: old_text not found`); continue; }
        if (content.indexOf(old_text, idx + 1) !== -1) { results.push(`Patch ${i + 1}: old_text not unique`); continue; }
        content = content.replace(old_text, new_text);
        results.push(`✓ Patch ${i + 1} applied`);
      }
      fs.writeFileSync(resolved, content, 'utf-8');
      return results.join('\n') + `\n--- ${patches.length} patches processed on ${resolved}`;
    } catch (err) {
      return `Error: ${err.message}`;
    }
  },

  insert_lines({ path: filePath, line, content: insertContent }) {
    const resolved = path.resolve(WORK_DIR, filePath);
    try {
      if (!fs.existsSync(resolved)) return `Error: File not found: ${resolved}`;
      const lines = fs.readFileSync(resolved, 'utf-8').split('\n');
      const insertAt = Math.max(0, Math.min(line, lines.length));
      lines.splice(insertAt, 0, insertContent);
      fs.writeFileSync(resolved, lines.join('\n'), 'utf-8');
      return `✓ Inserted ${insertContent.split('\n').length} line(s) after line ${line} in ${resolved}`;
    } catch (err) {
      return `Error: ${err.message}`;
    }
  },

  delete_lines({ path: filePath, start, end }) {
    const resolved = path.resolve(WORK_DIR, filePath);
    try {
      if (!fs.existsSync(resolved)) return `Error: File not found: ${resolved}`;
      const lines = fs.readFileSync(resolved, 'utf-8').split('\n');
      const totalLines = lines.length;
      if (start < 1 || end > totalLines || start > end) return `Error: Invalid range ${start}-${end} (file has ${totalLines} lines)`;
      const deleted = lines.splice(start - 1, end - start + 1).join('\n');
      fs.writeFileSync(resolved, lines.join('\n'), 'utf-8');
      return `✓ Deleted lines ${start}-${end} (${end - start + 1} lines) from ${resolved}`;
    } catch (err) {
      return `Error: ${err.message}`;
    }
  },

  replace_regex({ path: filePath, pattern, replacement, flags = 'g' }) {
    const resolved = path.resolve(WORK_DIR, filePath);
    try {
      if (!fs.existsSync(resolved)) return `Error: File not found: ${resolved}`;
      let content = fs.readFileSync(resolved, 'utf-8');
      const regex = new RegExp(pattern, flags);
      const matches = (content.match(regex) || []).length;
      content = content.replace(regex, replacement);
      fs.writeFileSync(resolved, content, 'utf-8');
      return `✓ Replaced ${matches} match(es) in ${resolved}`;
    } catch (err) {
      return `Error: ${err.message}`;
    }
  },

  append_file({ path: filePath, content: appendContent }) {
    const resolved = path.resolve(WORK_DIR, filePath);
    try {
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.appendFileSync(resolved, appendContent, 'utf-8');
      return `✓ Appended ${appendContent.split('\n').length} line(s) to ${resolved}`;
    } catch (err) {
      return `Error: ${err.message}`;
    }
  },

  async git_op({ operation, args = '' }) {
    try {
      const gitCmd = args ? `git ${operation} ${args}` : `git ${operation}`;
      const result = await asyncShell(gitCmd, { timeout: 30 });
      return result.output;
    } catch (err) {
      return `Error: ${err.message}`;
    }
  },

  async pm2({ action, name, lines = 30 }) {
    try {
      let cmd;
      if (action === 'list') cmd = 'pm2 list --no-color';
      else if (action === 'logs') cmd = `pm2 logs ${name || ''} --lines ${lines} --nostream`;
      else if (action === 'describe') cmd = `pm2 describe ${name}`;
      else cmd = `pm2 ${action} ${name || ''}`;
      const result = await asyncShell(cmd, { timeout: 15 });
      return result.output;
    } catch (err) {
      return `Error: ${err.message}`;
    }
  },

  async service_check({ service }) {
    const checks = {
      haksterai: { port: 3579, url: 'http://localhost:3579/api/health' },
      cinevault: { port: 8081, url: 'http://localhost:8081/api/health' },
      miniforge: { port: 5555, url: 'http://localhost:5555/' },
      phantom: { port: 4000, url: 'http://localhost:4000/api/ping' },
    };
    const toCheck = service === 'all' ? Object.keys(checks) : [service];
    const results = [];
    for (const name of toCheck) {
      const s = checks[name];
      if (!s) { results.push(`${name}: unknown service`); continue; }
      try {
        const resp = await fetch(s.url, { signal: AbortSignal.timeout(5000) });
        const text = await resp.text();
        const status = resp.ok ? '✓' : '✗';
        results.push(`${status} ${name} (:${s.port}) → ${resp.status} ${text.substring(0, 100)}`);
      } catch (err) {
        results.push(`✗ ${name} (:${s.port}) → ${err.message}`);
      }
    }
    return results.join('\n');
  },

  async snapshot({ url, width = 1280, height = 800 }) {
    try {
      // Use a headless approach: fetch page, extract key visual info
      const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
      const html = await resp.text();
      // Extract title, meta, headings, links, forms, images
      const title = html.match(/<title[^>]*>(.*?)<\/title>/is)?.[1] || '(no title)';
      const headings = [...html.matchAll(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/gis)].map(m => m[1].replace(/<[^>]+>/g, '').trim()).filter(Boolean).slice(0, 10);
      const links = [...html.matchAll(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gis)].map(m => `${m[1]} → ${m[2].replace(/<[^>]+>/g, '').trim()}`).filter(l => !l.startsWith('#')).slice(0, 15);
      const buttons = [...html.matchAll(/<button[^>]*>(.*?)<\/button>/gis)].map(m => m[1].replace(/<[^>]+>/g, '').trim()).filter(Boolean).slice(0, 10);
      const inputs = [...html.matchAll(/<input[^>]*>/gis)].map(m => { const name = m[0].match(/name="([^"]*)"/)?.[1] || ''; const type = m[0].match(/type="([^"]*)"/)?.[1] || 'text'; const placeholder = m[0].match(/placeholder="([^"]*)"/)?.[1] || ''; return `${type}${name ? ':' + name : ''}${placeholder ? ' (' + placeholder + ')' : ''}`; }).slice(0, 10);
      const images = [...html.matchAll(/<img[^>]*src="([^"]*)"[^>]*>/gis)].map(m => m[1]).slice(0, 10);
      const bodyText = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 2000);

      const lines = [
        `📸 Snapshot: ${url}`,
        `Status: ${resp.status} ${resp.statusText}`,
        `Title: ${title}`,
        `Viewport: ${width}x${height}`,
        ``,
      ];
      if (headings.length) lines.push(`Headings:`, ...headings.map(h => `  • ${h}`), '');
      if (buttons.length) lines.push(`Buttons:`, ...buttons.map(b => `  [${b}]`), '');
      if (inputs.length) lines.push(`Inputs:`, ...inputs.map(i => `  • ${i}`), '');
      if (links.length) lines.push(`Links:`, ...links.map(l => `  → ${l}`), '');
      if (images.length) lines.push(`Images:`, ...images.map(i => `  🖼 ${i}`), '');
      lines.push('', `Page text (first 2000 chars):`, bodyText.substring(0, 1500));
      if (bodyText.length > 1500) lines.push(`... (${bodyText.length - 1500} more chars)`);
      return lines.join('\n');
    } catch (err) {
      return `Error snapshotting ${url}: ${err.message}`;
    }
  },

  async sub_agent({ tasks }) {
    // Run each sub-task as an independent agent loop call
    const results = [];
    const maxConcurrent = 3;
    const tasksToRun = tasks.slice(0, maxConcurrent);

    log(`\n${C.cyan}🔀 Spawning ${tasksToRun.length} sub-agent(s) in parallel...${C.reset}`);

    const promises = tasksToRun.map(async (task, i) => {
      const taskName = task.name || `task-${i + 1}`;
      const taskHist = [{ role: 'system', content: buildSystemPrompt() }];
      log(`${C.purple}  ▸ ${taskName}: ${task.goal.substring(0, 80)}${C.reset}`);
      try {
        const result = await agentLoop(task.goal, taskHist, true); // silent mode
        const lastAssistant = [...taskHist].reverse().find(m => m.role === 'assistant');
        return { name: taskName, status: 'done', result: lastAssistant?.content || '(completed)' };
      } catch (err) {
        return { name: taskName, status: 'error', result: err.message };
      }
    });

    const settled = await Promise.all(promises);
    for (const s of settled) {
      log(`${s.status === 'done' ? C.green : C.red}  ✓ ${s.name}: ${s.result.substring(0, 200)}${C.reset}`);
      results.push(`--- ${s.name} (${s.status}) ---\n${s.result}`);
    }
    return results.join('\n\n');
  },

  async parallel_shell({ commands, timeout = 30 }) {
    const maxTimeout = Math.min(timeout, 300);
    const results = commands.map(cmd => {
      return asyncShell(cmd, { timeout: maxTimeout }).then(result => ({
        cmd,
        stdout: (result.stdout || '').substring(0, 3000),
        stderr: (result.stderr || '').substring(0, 1000),
        code: result.exitCode,
        killed: result.killed,
      }));
    });

    return Promise.all(results).then(outputs => {
      return outputs.map(o => {
        const parts = [`$ ${o.cmd}`];
        if (o.stdout) parts.push(o.stdout);
        if (o.stderr) parts.push(`[stderr] ${o.stderr}`);
        if (o.killed) parts.push(`[timeout after ${timeout}s]`);
        if (o.code !== 0 && !o.killed) parts.push(`[exit: ${o.code}]`);
        return parts.join('\n');
      }).join('\n---\n');
    });
  },

  code_grid({ code, title, lang = '', highlight_lines = [], diff_lines = [] }) {
    const lines = code.split('\n');
    const lineNumWidth = String(lines.length).length;
    const diffSet = {};
    for (const d of diff_lines) {
      if (d.startsWith('+')) diffSet[parseInt(d.substring(1))] = 'add';
      else if (d.startsWith('-')) diffSet[parseInt(d.substring(1))] = 'del';
    }
    const hlSet = new Set(highlight_lines);

    // Color codes for terminal output
    const GR = '\x1b[32m'; // green - additions
    const RD = '\x1b[31m'; // red - deletions
    const CY = '\x1b[36m'; // cyan - line numbers
    const YL = '\x1b[33m'; // yellow - highlighted
    const MG = '\x1b[35m'; // magenta - header
    const DM = '\x1b[2m'; // dim
    const BD = '\x1b[1m'; // bold
    const RS = '\x1b[0m'; // reset

    const bar = '─'.repeat(Math.max(60, title.length + lang.length + 6));
    const output = [
      `${MG}${BD}┌${bar}┐${RS}`,
      `${MG}│ ${BD}${title}${RS}${lang ? ` ${DM}(${lang})${RS}` : ''} ${MG}${' '.repeat(Math.max(0, bar.length - title.length - (lang ? lang.length + 3 : 1) - 2))}│${RS}`,
      `${MG}├${bar}┤${RS}`,
    ];

    for (let i = 0; i < lines.length; i++) {
      const num = i + 1;
      const numStr = String(num).padStart(lineNumWidth);
      const line = lines[i];
      let prefix = ' ';
      let color = '';
      let suffix = RS;

      if (diffSet[num] === 'add') { prefix = '+'; color = GR; suffix = RS; }
      else if (diffSet[num] === 'del') { prefix = '-'; color = RD; suffix = RS; }
      else if (hlSet.has(num)) { color = YL; suffix = RS; }

      const numColor = CY;
      const gutter = `${MG}│${RS} ${numColor}${numStr}${RS} ${color}${prefix}${RS} `;
      const lineColor = color || RS;

      // Truncate very long lines
      const maxLen = 120;
      const displayLine = line.length > maxLen ? line.substring(0, maxLen) + `${DM}...${RS}` : line;
      output.push(`${gutter}${lineColor}${displayLine}${suffix}`);
    }

    output.push(`${MG}└${bar}┘${RS}`);
    return output.join('\n');
  },

  // ── Visual Browser Tools (Puppeteer) ──────────────────────────────────
  async browser_navigate({ url, wait_ms = 2000 }) {
    try {
      const page = await getPage();
      const response = await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });
      if (wait_ms > 0) await page.waitForTimeout(wait_ms);
      const title = await page.title();
      const currentUrl = page.url();
      const statusCode = response ? response.status() : null;
      const statusText = response ? response.statusText() : '';
      // Get accessibility snapshot
      const snapshot = await page.evaluate(() => {
        const elements = [];
        const interactive = document.querySelectorAll('button, a, input, select, textarea, [role="button"], [role="link"], [contenteditable]');
        interactive.forEach((el, i) => {
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) return;
          const tag = el.tagName.toLowerCase();
          const text = (el.textContent || '').trim().slice(0, 80);
          const type = el.getAttribute('type') || '';
          const placeholder = el.getAttribute('placeholder') || '';
          const href = el.getAttribute('href') || '';
          const name = el.getAttribute('name') || '';
          elements.push({ idx: i, tag, text, type, placeholder, href, name });
        });
        return { title: document.title, url: location.href, elements };
      });
      const lines = [
        `🧭 Navigated to: ${currentUrl}`,
        `Status: ${statusCode} ${statusText}`,
        `Title: ${title}`,
        `Interactive elements (${snapshot.elements.length}):`,
      ];
      snapshot.elements.slice(0, 30).forEach(el => {
        const label = el.text || el.placeholder || el.name || el.href?.slice(0, 50) || '(unnamed)';
        lines.push(`  [${el.idx}] <${el.tag}${el.type ? ' type=' + el.type : ''}> ${label}`);
      });
      if (snapshot.elements.length > 30) lines.push(`  ... and ${snapshot.elements.length - 30} more`);
      return lines.join('\n');
    } catch (err) {
      return `Error navigating to ${url}: ${err.message}`;
    }
  },

  async browser_click({ selector, index = 0 }) {
    try {
      const page = await getPage();
      // Try CSS selector first, then text content
      let clicked = false;
      try {
        const els = await page.$$(selector);
        if (els.length > index) {
          await els[index].click();
          clicked = true;
        }
      } catch (_) {}
      if (!clicked) {
        // Try as text content of button/link
        const el = await page.evaluateHandle((text, idx) => {
          const all = Array.from(document.querySelectorAll('button, a, [role="button"], [role="link"]'));
          const match = all.filter(e => e.textContent.trim().includes(text));
          return match[idx] || match[0] || null;
        }, selector, index);
        if (el && el.asElement()) {
          await el.asElement().click();
          clicked = true;
        }
      }
      if (!clicked) return `Could not find clickable element matching: ${selector}`;
      await page.waitForTimeout(1000);
      // Return snapshot after click
      const title = await page.title();
      const url = page.url();
      return `👆 Clicked: ${selector}\nNow at: ${url}\nTitle: ${title}`;
    } catch (err) {
      return `Error clicking ${selector}: ${err.message}`;
    }
  },

  async browser_type({ selector, text, press_enter = false }) {
    try {
      const page = await getPage();
      let el;
      try {
        el = await page.$(selector);
      } catch (_) {}
      if (!el) {
        // Try by name, id, or placeholder
        el = await page.$(`input[name="${selector}"], textarea[name="${selector}"], #${selector}, input[placeholder*="${selector}"]`);
      }
      if (!el) return `Could not find input field matching: ${selector}`;
      await el.click({ clickCount: 3 }); // select all
      await page.keyboard.press('Backspace');
      await el.type(text, { delay: 20 });
      if (press_enter) await page.keyboard.press('Enter');
      await page.waitForTimeout(500);
      return `⌨️ Typed "${text}" into ${selector}${press_enter ? ' + Enter' : ''}`;
    } catch (err) {
      return `Error typing into ${selector}: ${err.message}`;
    }
  },

  async browser_screenshot({ full_page = false, selector } = {}) {
    try {
      const page = await getPage();
      const screenshotDir = '/tmp/hakster_screenshots';
      if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });
      const filename = `screenshot_${Date.now()}.png`;
      const filepath = path.join(screenshotDir, filename);
      const opts = { path: filepath, type: 'png' };
      if (full_page) opts.fullPage = true;
      let target = page;
      if (selector) {
        const el = await page.$(selector);
        if (!el) return `Could not find element: ${selector}`;
        await el.screenshot(opts);
      } else {
        await page.screenshot(opts);
      }
      const stats = fs.statSync(filepath);
      const sizeKB = (stats.size / 1024).toFixed(1);
      return `📸 Screenshot saved: ${filepath} (${sizeKB} KB)${full_page ? ' [full page]' : ''}${selector ? ` [element: ${selector}]` : ''}\nUse shell tool to display: cat ${filepath}`;
    } catch (err) {
      return `Error taking screenshot: ${err.message}`;
    }
  },

  async browser_snapshot({ full = false } = {}) {
    try {
      const page = await getPage();
      const currentUrl = page.url();
      if (currentUrl === 'about:blank') return 'No page loaded. Use browser_navigate first.';
      const snapshot = await page.evaluate((wantFull) => {
        const elements = [];
        const interactive = document.querySelectorAll('button, a, input, select, textarea, [role="button"], [role="link"], [contenteditable]');
        interactive.forEach((el, i) => {
          const rect = el.getBoundingClientRect();
          if (!wantFull && rect.width === 0 && rect.height === 0) return;
          const tag = el.tagName.toLowerCase();
          const text = (el.textContent || '').trim().slice(0, 100);
          const type = el.getAttribute('type') || '';
          const placeholder = el.getAttribute('placeholder') || '';
          const value = el.value || '';
          const href = el.getAttribute('href') || '';
          const name = el.getAttribute('name') || '';
          const id = el.id || '';
          const checked = el.checked !== undefined ? String(el.checked) : '';
          const disabled = el.disabled ? ' [disabled]' : '';
          elements.push({ idx: i, tag, text: text.slice(0, 80), type, placeholder, value, href, name, id, checked, disabled });
        });
        // Page text content
        const bodyText = document.body ? document.body.innerText.slice(0, wantFull ? 5000 : 1500) : '';
        return {
          title: document.title,
          url: location.href,
          viewport: { w: window.innerWidth, h: window.innerHeight },
          scroll: { x: window.scrollX, y: window.scrollY },
          elements,
          bodyText,
        };
      }, full);
      const lines = [
        `🔍 Snapshot: ${snapshot.url}`,
        `Title: ${snapshot.title}`,
        `Viewport: ${snapshot.viewport.w}x${snapshot.viewport.h}`,
        `Interactive elements (${snapshot.elements.length}):`,
      ];
      snapshot.elements.slice(0, full ? 50 : 25).forEach(el => {
        const label = el.text || el.placeholder || el.name || el.id || '(unnamed)';
        const extra = [];
        if (el.type && el.tag === 'input') extra.push(`type=${el.type}`);
        if (el.value) extra.push(`val="${el.value.slice(0, 30)}"`);
        if (el.checked) extra.push(`checked=${el.checked}`);
        lines.push(`  [${el.idx}] <${el.tag}${el.disabled}> ${label}${extra.length ? ' (' + extra.join(', ') + ')' : ''}`);
      });
      if (snapshot.elements.length > (full ? 50 : 25)) lines.push(`  ... and ${snapshot.elements.length - (full ? 50 : 25)} more`);
      if (snapshot.bodyText) {
        lines.push('', '--- Page text ---');
        lines.push(snapshot.bodyText.slice(0, full ? 3000 : 800));
        if (snapshot.bodyText.length > (full ? 3000 : 800)) lines.push(`... (${snapshot.bodyText.length} chars total)`);
      }
      return lines.join('\n');
    } catch (err) {
      return `Error taking snapshot: ${err.message}`;
    }
  },

  // ── Memory: persistent notes across sessions ─────────────────────────────
  memory({ action, content, id, query }) {
    const MEMORY_DIR = path.join(WORK_DIR, '.hakster', 'memory');
    const MEMORY_FILE = path.join(MEMORY_DIR, 'notes.json');
    if (!fs.existsSync(MEMORY_DIR)) fs.mkdirSync(MEMORY_DIR, { recursive: true });
    let notes = [];
    try { notes = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf-8')); } catch (_) { notes = []; }

    switch (action) {
      case 'add': {
        if (!content) return 'Error: content is required for add action';
        const note = {
          id: `mem_${Date.now()}`,
          content,
          created: new Date().toISOString(),
        };
        notes.push(note);
        fs.writeFileSync(MEMORY_FILE, JSON.stringify(notes, null, 2));
        return `🧠 Saved note ${note.id}: "${content.slice(0, 80)}${content.length > 80 ? '...' : ''}"`;
      }
      case 'list': {
        if (notes.length === 0) return '🧠 No notes saved yet. Use memory add to save one.';
        const lines = [`🧠 ${notes.length} note(s):`];
        notes.forEach((n, i) => {
          lines.push(`  ${i + 1}. [${n.id}] ${n.content.slice(0, 100)}${n.content.length > 100 ? '...' : ''} (${n.created?.slice(0, 10) || '?'})`);
        });
        return lines.join('\n');
      }
      case 'get': {
        if (!id) return 'Error: id is required for get action';
        const note = notes.find(n => n.id === id);
        if (!note) return `Note not found: ${id}`;
        return `🧠 [${note.id}]\n${note.content}\nCreated: ${note.created}`;
      }
      case 'remove': {
        if (!id) return 'Error: id is required for remove action';
        const idx = notes.findIndex(n => n.id === id);
        if (idx === -1) return `Note not found: ${id}`;
        const removed = notes.splice(idx, 1)[0];
        fs.writeFileSync(MEMORY_FILE, JSON.stringify(notes, null, 2));
        return `🗑️ Removed note ${removed.id}: "${removed.content.slice(0, 60)}..."`;
      }
      case 'search': {
        if (!query) return 'Error: query is required for search action';
        const q = query.toLowerCase();
        const matches = notes.filter(n => n.content.toLowerCase().includes(q));
        if (matches.length === 0) return `No notes matching "${query}"`;
        const lines = [`🧠 ${matches.length} match(es) for "${query}":`];
        matches.forEach((n, i) => {
          lines.push(`  ${i + 1}. [${n.id}] ${n.content.slice(0, 100)}...`);
        });
        return lines.join('\n');
      }
      default:
        return `Unknown memory action: ${action}. Use: add, list, get, remove, search`;
    }
  },

  // ── Skills: persistent procedural knowledge ───────────────────────────────
  skill_save({ name, content, category }) {
    const SKILLS_DIR = path.join(WORK_DIR, '.hakster', 'skills');
    const dir = category ? path.join(SKILLS_DIR, category) : SKILLS_DIR;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const filename = name.endsWith('.md') ? name : `${name}.md`;
    const filepath = path.join(dir, filename);
    fs.writeFileSync(filepath, content, 'utf-8');
    return `💾 Skill saved: ${name}${category ? ` (${category})` : ''} → ${filepath}`;
  },

  skill_load({ name }) {
    const skillsDirs = getHaksterRoots().map(root => path.join(root, 'skills'));
    // Search all categories
    let filepath = '';
    for (const skillsDir of skillsDirs) {
      const candidate = path.join(skillsDir, name.endsWith('.md') ? name : `${name}.md`);
      if (fs.existsSync(candidate)) {
        filepath = candidate;
        break;
      }
    }
    if (!filepath) {
      // Try with .md extension in subdirectories
      const filename = name.endsWith('.md') ? name : `${name}.md`;
      for (const skillsDir of skillsDirs) {
        const found = globSync(path.join(skillsDir, '**', filename));
        if (found[0]) {
          filepath = found[0];
          break;
        }
      }
    }
    if (!filepath || !fs.existsSync(filepath)) {
      // List available skills
      const available = skillsDirs.flatMap(skillsDir =>
        globSync(path.join(skillsDir, '**', '*.md')).map(f => path.relative(skillsDir, f).replace(/\.md$/, ''))
      );
      return `Skill not found: ${name}\nAvailable: ${available.length > 0 ? available.join(', ') : '(none)'}`;
    }
    const content = fs.readFileSync(filepath, 'utf-8');
    return `📖 Skill: ${name}\n${'─'.repeat(40)}\n${content}`;
  },

  skill_list({ category } = {}) {
    const skillsDirs = getHaksterRoots().map(root => path.join(root, 'skills'));
    const files = skillsDirs.flatMap(skillsDir => {
      if (!fs.existsSync(skillsDir)) return [];
      const pattern = category ? path.join(skillsDir, category, '*.md') : path.join(skillsDir, '**', '*.md');
      return globSync(pattern).map(file => ({ file, skillsDir }));
    });
    if (files.length === 0) return `📋 No skills found${category ? ` in category "${category}"` : ''}.`;
    const lines = ['📋 Saved skills:'];
    const seen = new Set();
    files.forEach(({ file, skillsDir }) => {
      const rel = path.relative(skillsDir, file).replace(/\.md$/, '');
      if (seen.has(rel)) return;
      seen.add(rel);
      const cat = path.dirname(rel) === '.' ? '' : ` [${path.dirname(rel)}]`;
      const name = path.basename(rel);
      lines.push(`  • ${name}${cat}`);
    });
    return lines.join('\n');
  },
  notify({ message, type = 'notify', priority = 'normal' }) {
    const id = msgPush(message, { type, priority, source: 'agent' });
    return `📬 Queued as ${id} (type: ${type}, priority: ${priority})`;
  },

  async generate_image({ prompt, model = 'dall-e-3', size = '1024x1024', quality = 'standard' }) {
    try {
      const imgDir = path.join(process.cwd(), 'outputs', 'images');
      if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir, { recursive: true });

      const result = await generateImage({ provider: 'openai', model, prompt, size, quality, n: 1 });

      const saved = [];
      for (const img of result.images) {
        const id = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
        const filePath = path.join(imgDir, `${id}.png`);
        fs.writeFileSync(filePath, Buffer.from(img.b64_json, 'base64'));
        const stats = fs.statSync(filePath);
        const sizeKB = (stats.size / 1024).toFixed(1);
        saved.push({ path: filePath, sizeKB, revised_prompt: img.revised_prompt });
      }

      const lines = [`🎨 Image generated (${model}, ${size}, ${quality}) — ${result.latency}ms`];
      saved.forEach(s => {
        lines.push(`  📁 ${s.path} (${s.sizeKB} KB)`);
        if (s.revised_prompt) lines.push(`  📝 Revised prompt: ${s.revised_prompt}`);
      });
      return lines.join('\n');
    } catch (err) {
      return `❌ Image generation failed: ${err.message}`;
    }
  },
};

// ── MCP Integration — merge MCP tools into TOOLS array ──────────────────────
// Count of built-in tools for reference
const _builtinToolCount = TOOLS.length;

async function initMcpTools() {
  try {
    const { tools: mcpToolDefs, servers } = await loadMcpServers(getHaksterRoots());
    if (mcpToolDefs.length > 0) {
      // Compress MCP tool schemas to save context — strip verbose parameter
      // descriptions, keep only name + shortened description + param names.
      // Full schemas are restored dynamically in callMcpTool() from the server.
      const compressed = mcpToolDefs.map(t => {
        const desc = t.function.description || '';
        // Keep first sentence only (skip detailed paragraphs)
        const shortDesc = desc.split('.')[0] + (desc.includes('.') ? '.' : '');
        // Strip property descriptions and compress parameters
        let params = { type: 'object', properties: {}, required: t.function.parameters?.required || [] };
        if (t.function.parameters?.properties) {
          for (const [key, schema] of Object.entries(t.function.parameters.properties)) {
            const compressedProp = { type: schema.type || 'string' };
            // Keep enum values if present (important for the model to know valid options)
            if (schema.enum) compressedProp.enum = schema.enum;
            // Keep one-word description if it's short, otherwise drop
            if (schema.description && schema.description.length < 60) {
              compressedProp.description = schema.description;
            }
            params.properties[key] = compressedProp;
          }
        }
        return {
          type: 'function',
          function: {
            name: t.function.name,
            description: shortDesc,
            parameters: params,
          },
          _mcpServer: t._mcpServer,
          _mcpToolName: t._mcpToolName,
        };
      });
      // Merge MCP tools into the TOOLS array (keep built-in tools first)
      TOOLS = [...TOOLS.slice(0, _builtinToolCount), ...compressed];
    }
  } catch (err) {
    // MCP init failure is non-fatal — agent still works with built-in tools
    if (typeof _logFn === 'function') _logFn(`[MCP] Init warning: ${err.message}`);
  }
}

// ── Ollama API Call ─────────────────────────────────────────────────────
function callOllama(messages, tools, { onToken } = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: MODEL,
      messages,
      tools: tools || undefined,
      stream: true,   // ← STREAMING: tokens arrive in real-time instead of blocking until complete
      options: {
        num_predict: 16384,   // max output tokens per turn — enough for thinking + response
        temperature: 0.3,     // lower temp = faster convergence, less creative drift
        top_p: 0.9,
      },
    });

    const url = new URL(`${OLLAMA_HOST}/api/chat`);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };

    const maxTimeout = 300000; // 5 min for big models
    const req = http.request(options, (res) => {
      // ── Detect HTTP errors (e.g., 400 from malformed request) ──
      if (res.statusCode >= 400) {
        let errBody = '';
        res.on('data', (c) => { errBody += c.toString(); });
        res.on('end', () => {
          // Try to extract Ollama's structured error: {"error":"message"} or {"error":{"message":"..."}}
          let detail = errBody.substring(0, 500);
          try {
            const parsed = JSON.parse(errBody);
            if (parsed.error) {
              detail = typeof parsed.error === 'string' ? parsed.error
                : (parsed.error.message || JSON.stringify(parsed.error));
            }
          } catch (_) { /* not JSON — use raw substring */ }
          const errMsg = `Ollama HTTP ${res.statusCode}: ${detail}`;
          console.log(`[DEBUG callOllama] ${errMsg}`);
          reject(new Error(errMsg));
        });
        return;
      }
      // ── Streaming: accumulate NDJSON chunks into a final response ──
      let message = { role: 'assistant', content: '', thinking: '' };
      let toolCalls = [];
      let buffer = '';  // partial line buffer (NDJSON = newline-delimited)
      global._chunkLogCount = 0; // reset chunk debug counter

      // Throttle token display: update status bar at most every 150ms
      let lastStatusUpdate = 0;
      let pendingContent = '';
      let pendingThinking = '';

      res.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();  // keep incomplete line in buffer

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const obj = JSON.parse(trimmed);
            // DEBUG: Log first 5 chunks to see what model returns
            if (!global._chunkLogCount) global._chunkLogCount = 0;
            if (global._chunkLogCount < 5) {
              global._chunkLogCount++;
              const hasContent = !!(obj.message?.content);
              const hasThinking = !!(obj.message?.thinking);
              const hasTC = !!(obj.message?.tool_calls?.length);
              console.log(`[CHUNK ${global._chunkLogCount}] content=${hasContent} thinking=${hasThinking} tool_calls=${hasTC} done=${obj.done || false}`);
            }
            if (obj.message) {
              // Accumulate content/thinking
              if (obj.message.content) {
                message.content += obj.message.content;
                pendingContent += obj.message.content;
              }
              if (obj.message.thinking) {
                message.thinking += obj.message.thinking;
                pendingThinking += obj.message.thinking;
              }
              // Accumulate tool calls (Ollama sends complete tool_call objects, not incremental)
              if (obj.message.tool_calls) {
                for (const tc of obj.message.tool_calls) {
                  // Deduplicate: Ollama may send the same tool_call in multiple chunks
                  // Each tool_call has a unique .id — only add if we haven't seen it
                  const existingIdx = toolCalls.findIndex(e => e.id && e.id === tc.id);
                  if (existingIdx !== -1) {
                    // Already seen — skip duplicate
                  } else {
                    // Normalize: Ollama sends arguments as a parsed object, but agent loop expects a JSON string
                    const args = tc.function?.arguments;
                    const argsStr = (typeof args === 'object' && args !== null)
                      ? JSON.stringify(args)
                      : (typeof args === 'string' ? args : '{}');
                    toolCalls.push({
                      id: tc.id || `call_${toolCalls.length}`,
                      type: 'function',
                      function: {
                        name: tc.function?.name || '',
                        arguments: argsStr,
                      },
                    });
                  }
                }
              }
            }
            // Throttled status updates: show token progress in real-time
            const now = Date.now();
            if (onToken && (now - lastStatusUpdate > 150 || obj.done)) {
              lastStatusUpdate = now;
              // Show what we're streaming: thinking takes priority, then content
              const preview = pendingThinking || pendingContent;
              if (preview) {
                const short = preview.length > 80 ? preview.slice(-80) : preview;
                onToken(short.replace(/\n/g, ' '));
                pendingContent = '';
                pendingThinking = '';
              }
            }
          } catch (parseErr) {
            // DEBUG: Log parse failures (could indicate stream errors)
            console.log(`[DEBUG callOllama] JSON parse error on chunk: ${trimmed.substring(0, 200)}`);
          }
        }
      });

      res.on('end', () => {
        // Process any remaining buffer
        if (buffer.trim()) {
          try {
            const obj = JSON.parse(buffer.trim());
            if (obj.message) {
              if (obj.message.content) message.content += obj.message.content;
              if (obj.message.thinking) message.thinking += obj.message.thinking;
              if (obj.message.tool_calls) {
                for (const tc of obj.message.tool_calls) {
                  const existingIdx = toolCalls.findIndex(e => e.id && e.id === tc.id);
                  if (existingIdx === -1) {
                    const args = tc.function?.arguments;
                    const argsStr = (typeof args === 'object' && args !== null)
                      ? JSON.stringify(args)
                      : (typeof args === 'string' ? args : '{}');
                    toolCalls.push({
                      id: tc.id || `call_${toolCalls.length}`,
                      type: 'function',
                      function: {
                        name: tc.function?.name || '',
                        arguments: argsStr,
                      },
                    });
                  }
                }
              }
            }
          } catch (_) { /* ignore trailing parse errors */ }
        }

        // Tool calls already normalized during streaming accumulation — just attach if present
        if (toolCalls.length > 0) {
          message.tool_calls = toolCalls;
        }
        const response = { message };
        // DEBUG: Log final accumulated response
        console.log(`[DEBUG callOllama] STREAM END: content=${message.content.length}ch thinking=${message.thinking.length}ch tool_calls=${toolCalls.length} chunks_seen=${global._chunkLogCount}`);
        resolve(response);
      });
    });

    req.on('error', reject);
    req.setTimeout(maxTimeout, () => { req.destroy(new Error('Request timeout')); });
    req.write(body);
    req.end();
  });
}

// ── Hard context ceiling — progressive truncation ────────────────
// gpt-oss:120b-cloud has 131k context. Budget: ~114k tokens (131k minus 16k output).
// Ceiling: ~100k chars at ~2:1 ratio (conservative estimate).
// Aggressive threshold to stay well below the model's hard limit.
const MAX_CONTEXT_CHARS = 80000;  // proactive compact threshold (leave headroom)
const ABSOLUTE_CONTEXT_CHARS = 100000; // hard ceiling — matches server/index.js
const MIN_MESSAGES_TO_KEEP = 10;  // Keep last 5 exchanges (10 messages)

function estimateChars(history) {
  return history.reduce((sum, m) => sum + (m.content?.length || 0), 0);
}

// Check if history has in-progress tool calls (assistant message with tool_calls
// that hasn't had all tool results answered yet)
function hasPendingToolCalls(history) {
  for (let i = history.length - 1; i >= Math.max(0, history.length - 6); i--) {
    const m = history[i];
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      // Found a tool call message — check if all results are present
      const toolNames = m.tool_calls.map(tc => tc.function?.name || tc.name);
      let answered = 0;
      for (let j = i + 1; j < history.length; j++) {
        if (history[j].role === 'tool') answered++;
      }
      if (answered < m.tool_calls.length) return true;
    }
  }
  return false;
}

// ── Sanitize history: fix malformed message sequences that cause empty model responses ──
// Ollama requires proper role alternation and rejects orphaned tool messages.
// This function MUST be called before every callOllama() to prevent context corruption.
function sanitizeHistory(history) {
  if (history.length <= 1) return; // only system prompt, nothing to fix

  const before = history.length;

  // 1. Remove empty assistant messages (content="" and no tool_calls)
  //    These poison context — the model sees its own empty prior and mirrors it
  for (let i = history.length - 1; i >= 1; i--) {
    const m = history[i];
    if (m.role === 'assistant') {
      const content = (m.content || '').trim();
      const thinking = (m.thinking || '').trim();
      const hasTools = m.tool_calls && m.tool_calls.length > 0;
      if (!content && !thinking && !hasTools) {
        history.splice(i, 1);
      }
    }
  }

  // 2. Remove orphaned tool responses (tool role without preceding assistant tool_calls)
  for (let i = history.length - 1; i >= 1; i--) {
    if (history[i].role === 'tool') {
      // Look back for the nearest assistant message with tool_calls
      let hasMatchingCall = false;
      for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
        if (history[j].role === 'assistant' && history[j].tool_calls?.length > 0) {
          // Check if this assistant's tool_calls include a call matching the tool name
          const toolName = history[i].name || '';
          const matchIdx = history[j].tool_calls.findIndex(tc =>
            (tc.function?.name || tc.name) === toolName || !toolName
          );
          if (matchIdx !== -1) {
            hasMatchingCall = true;
          }
          break;
        } else if (history[j].role === 'assistant') {
          // Assistant without tool_calls — orphan confirmed
          break;
        }
      }
      if (!hasMatchingCall) {
        history.splice(i, 1);
      }
    }
  }

  // 3. Merge consecutive same-role messages (Ollama expects alternating roles)
  //    Consecutive user messages → merge into one
  //    Consecutive system messages → keep only the last one
  for (let i = history.length - 1; i >= 1; i--) {
    if (i > 0 && history[i].role === history[i - 1].role) {
      if (history[i].role === 'user') {
        // Merge: keep both contents separated by newline
        history[i - 1] = {
          ...history[i - 1],
          content: (history[i - 1].content || '') + '\n' + (history[i].content || ''),
        };
        history.splice(i, 1);
      } else if (history[i].role === 'system') {
        // Keep the last system nudge (it's usually the more relevant one)
        history.splice(i - 1, 1);
      }
      // Don't merge assistant messages — they may have different tool_calls
    }
  }

  // 4. Deduplicate repeated nudge messages from empty-response retries
  const nudgePrefix = 'IMPORTANT: Your last response was empty.';
  let nudgeCount = 0;
  for (let i = history.length - 1; i >= 1; i--) {
    if (history[i].role === 'system' && (history[i].content || '').startsWith(nudgePrefix)) {
      nudgeCount++;
      if (nudgeCount > 1) {
        history.splice(i, 1); // keep only the most recent nudge
      }
    }
  }

  // 5. Ensure first message is system role
  if (history.length > 0 && history[0].role !== 'system') {
    // Shouldn't happen, but fix it
    history.unshift({ role: 'system', content: 'You are haksterAI, an expert AI agent.' });
  }

  // 6. CRITICAL: Convert tool_calls[].function.arguments from string to object
  //    Ollama's /api/chat requires arguments as a parsed object, NOT a JSON string.
  //    When we store tool_calls from Ollama responses, we stringify arguments (L2505)
  //    for OpenAI-compat format. But when sending BACK to Ollama, they must be objects.
  //    A string arguments field causes Ollama to return 400 with zero stream chunks,
  //    which the agent sees as an "empty response" and retries endlessly.
  let argsFixed = 0;
  for (const m of history) {
    if (m.role === 'assistant' && m.tool_calls) {
      for (const tc of m.tool_calls) {
        if (tc.function && typeof tc.function.arguments === 'string') {
          try {
            tc.function.arguments = JSON.parse(tc.function.arguments);
            argsFixed++;
          } catch (_) {
            // If it's not valid JSON, replace with empty object
            tc.function.arguments = {};
            argsFixed++;
          }
        }
      }
    }
  }

  const removed = before - history.length;
  if (removed > 0 || argsFixed > 0) {
    const parts = [];
    if (removed > 0) parts.push(`removed ${removed} malformed message(s) (${before} → ${history.length})`);
    if (argsFixed > 0) parts.push(`fixed ${argsFixed} tool_call arguments (string→object)`);
    log(`${C.yellow}📦 Sanitized history: ${parts.join(', ')}${C.reset}`);
  }
}

function compactHistory(history) {
  if (history.length <= 1) return; // system prompt only
  
  // Don't compact if there are in-progress tool calls — wait until they settle
  if (hasPendingToolCalls(history)) {
    log(`${C.gray}📦 Skipping compact — tool calls in progress${C.reset}`);
    return;
  }
  
  // ALWAYS enforce message count limit, regardless of char size.
  // Models get confused with too many messages even if each is short.
  const MAX_MESSAGES = 60; // keep last 60 messages (~30 exchanges)
  if (history.length > MAX_MESSAGES + 1) { // +1 for system prompt
    const dropCount = history.length - MAX_MESSAGES - 1;
    log(`${C.yellow}📦 Dropping ${dropCount} oldest messages (history has ${history.length - 1} msgs, max ${MAX_MESSAGES})${C.reset}`);
    history.splice(1, dropCount);
  }

  const totalChars = estimateChars(history);

  // Progressive truncation — shrink message content, never drop messages
  // Target: get below MAX_CONTEXT_CHARS (80k), with absolute ceiling at ABSOLUTE_CONTEXT_CHARS (100k)
  const MAX_MSG = 1000;
  let msgs = [...history];  // ALWAYS copy — never alias the original array
  let perMsgLimit = MAX_MSG;
  let iterations = 0;
  
  while (estimateChars(msgs) > MAX_CONTEXT_CHARS && perMsgLimit > 100) {
    perMsgLimit = Math.max(100, Math.floor(perMsgLimit * 0.6));
    msgs = msgs.map((m, i) => {
      if (i === 0 && m.role === 'system') return m; // never truncate system prompt
      const content = (m.content || '');
      if (content.length <= perMsgLimit) return m;
      return { ...m, content: content.substring(0, perMsgLimit) + '\n[trimmed]' };
    });
    iterations++;
  }

  // Nuclear: if still over, cap everything hard
  // Nuclear: if still over absolute ceiling, cap everything hard
  if (estimateChars(msgs) > ABSOLUTE_CONTEXT_CHARS) {
    msgs = msgs.map((m, i) => {
      if (i === 0 && m.role === 'system') return m;
      const content = (m.content || '');
      if (content.length <= 100) return m;
      return { ...m, content: content.substring(0, 100) + '\n[trimmed]' };
    });
    // If STILL over, drop oldest messages until under ceiling
    while (msgs.length > MIN_MESSAGES_TO_KEEP + 1 && estimateChars(msgs) > ABSOLUTE_CONTEXT_CHARS) {
      msgs.splice(1, 1); // remove oldest non-system message
    }
  }

  // Apply back to history array in place (safe because msgs is a copy, not alias)
  if (iterations > 0 || msgs.length !== history.length) {
    history.length = 0;
    history.push(...msgs);
    log(`${C.yellow}📦 Context ceiling applied (${iterations} rounds). Context: ${estimateChars(history).toLocaleString()} chars.${C.reset}`);
  }
}
let _logFn = (text) => console.log(text);
function log(text) {
  _logFn(text);
  // Any regular log output invalidates in-place panel scroll — the next
  // panel render can't scroll up over random log lines, it must append below.
  _lastPanelName = null;
}

// ── Spinner (TUI-aware, with elapsed-time nudge) ──────────────────────
let _statusFn = null; // set by TUI to update status bar
function startSpinner(label) {
  if (_statusFn) {
    const frames = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
    const startMs = Date.now();
    let i = 0;
    const interval = setInterval(() => {
      const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
      _statusFn(`${frames[i % frames.length]} ${label} (${elapsed}s)`);
      i++;
    }, Math.round(80 / SCROLL_SPEED));
    return { stop(msg) { clearInterval(interval); _statusFn('Ready'); if (msg) log(msg); } };
  }
  // Fallback for non-TUI mode (module import)
  const frames = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
  let i = 0;
  const interval = setInterval(() => { process.stdout.write(`\r${C.magenta}${frames[i % frames.length]}${C.reset} ${C.gray}${label}${C.reset}   `); i++; }, Math.round(80 / SCROLL_SPEED));
  return { stop(msg) { clearInterval(interval); process.stdout.write(`\r${' '.repeat(50)}\r`); if (msg) process.stdout.write(msg); } };
}

// ── Agent Loop ───────────────────────────────────────────────────────────
async function agentLoop(userMessage, history, silent = false) {
  history.push({ role: 'user', content: userMessage });

  // ── TUI dashboard: reset state at start of each user request ──
  if (!silent) tuiReset();
  tuiSetPhase('Thinking');

  let lastHadToolCalls = false;
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    // ── TUI dashboard: update step counter ──
    tuiSetStep(turn + 1, MAX_TURNS);
    const spinner = silent ? null : startSpinner('thinking...');
    let response;
    try {
      // Only compact when the previous turn did NOT end with tool calls
      // (i.e., we're not in the middle of a tool chain)
      if (!lastHadToolCalls) {
        compactHistory(history);
      } else {
        log(`${C.gray}📦 Skipping compact — still in tool chain (turn ${turn})${C.reset}`);
      }
      // ── Sanitize history before every API call to prevent empty responses ──
      sanitizeHistory(history);
      // Stream tokens to TUI status bar in real-time (150ms throttle built into callOllama)
      const tokenCallback = _statusFn
        ? (preview) => _statusFn(`${C.cyan}💬${C.reset} ${preview}`)
        : null;
      // DEBUG: Log what we're sending
      console.log(`[DEBUG] callOllama: history_len=${history.length} tools_count=${TOOLS?.length || 0} model=${MODEL}`);
      // Estimate total request size
      const _reqBodyEst = JSON.stringify({ model: MODEL, messages: history, tools: TOOLS });
      console.log(`[DEBUG] request body size: ${(_reqBodyEst.length / 1024).toFixed(1)}KB`);
      // TEMP: Dump payload to file for diagnosis
      try { fs.writeFileSync('/tmp/hakster_last_request.json', _reqBodyEst); console.log('[DEBUG] saved payload to /tmp/hakster_last_request.json'); } catch(_) {}
      // TEMP: Dump first user message and system prompt length for diagnosis
      const _sysMsg = history.find(m => m.role === 'system');
      const _firstUser = history.find(m => m.role === 'user');
      console.log(`[DEBUG] sys_prompt_len=${(_sysMsg?.content||'').length} first_user_len=${(_firstUser?.content||'').length} first_user_preview=${JSON.stringify((_firstUser?.content||'').substring(0,200))}`);
      response = await callOllama(history, TOOLS, { onToken: tokenCallback });
      // DEBUG: Log what came back
      const _rContent = (response?.message?.content || '');
      const _rThinking = (response?.message?.thinking || '');
      const _rTC = response?.message?.tool_calls?.length || 0;
      console.log(`[DEBUG] response: content_len=${_rContent.length} thinking_len=${_rThinking.length} tool_calls=${_rTC} content_preview=${JSON.stringify(_rContent.substring(0,100))} thinking_preview=${JSON.stringify(_rThinking.substring(0,100))}`);
    } catch (err) {
      // Retry API errors up to 2 times
      let lastErr = err;
      for (let retry = 0; retry < 2; retry++) {
        if (spinner) spinner.stop('');
        log(`${C.yellow}⚠️ API error (attempt ${retry + 1}/2): ${err.message}${C.reset}`);
        await new Promise(r => setTimeout(r, 2000 * (retry + 1))); // backoff
        const retrySpinner = silent ? null : startSpinner('retrying...');
        try {
          response = await callOllama(history, TOOLS, { onToken: tokenCallback });
          if (retrySpinner) retrySpinner.stop('');
          log(`${C.green}✅ API retry succeeded${C.reset}`);
          lastErr = null;
          break;
        } catch (retryErr) {
          if (retrySpinner) retrySpinner.stop('');
          lastErr = retryErr;
        }
      }
      if (lastErr) {
        if (spinner) spinner.stop(`${C.red}❌ API error after retries: ${lastErr.message}${C.reset}\n`);
        else log(`${C.red}❌ API error after retries: ${lastErr.message}${C.reset}`);
        break;
      }
    }
    if (spinner) spinner.stop('');

    let msg = response.message;
    if (!msg) {
      // Check if the response itself has an error
      if (response.error) {
        // If context limit exceeded, aggressively compact and retry once
        const errStr = String(response.error);
        if (errStr.includes('prompt too long') || errStr.includes('exceeded max context') || errStr.includes('context_length') || errStr.includes('token limit')) {
          log(`${C.yellow}📦 Context limit hit — compacting history and retrying...${C.reset}`);
          // Force a deep compact: truncate all non-system messages to 200 chars
          for (let i = 1; i < history.length; i++) {
            const content = history[i].content || '';
            if (content.length > 200) {
              history[i] = { ...history[i], content: content.substring(0, 200) + '\n[trimmed for context]' };
            }
          }
          // Trim oldest non-system messages if still too large
          while (history.length > MIN_MESSAGES_TO_KEEP + 1 && estimateChars(history) > MAX_CONTEXT_CHARS * 0.5) {
            // Remove the oldest non-system message (index 1)
            history.splice(1, 1);
          }
          log(`${C.yellow}📦 Compacted to ${estimateChars(history).toLocaleString()} chars (${history.length} messages)${C.reset}`);
          // Retry with compacted history
          try {
            const retryResp = await callOllama(history, TOOLS, { onToken: tokenCallback });
            if (retryResp.message) {
              response = retryResp;
              msg = response.message;
              log(`${C.green}✅ Retry after compact succeeded${C.reset}`);
              // Continue processing the response below
            } else {
              log(`${C.red}❌ Model error after compact+retry: ${retryResp.error || 'empty response'}${C.reset}`);
              break;
            }
          } catch (compactErr) {
            log(`${C.red}❌ Compact retry failed: ${compactErr.message}${C.reset}`);
            break;
          }
        } else {
          log(`${C.red}❌ Model error: ${response.error}${C.reset}`);
          break;
        }
      }
      // Empty response — could be a temporary glitch, retry up to 2 times
      log(`${C.yellow}⚠️ Empty response from model, retrying...${C.reset}`);
      let retried = false;
      for (let retry = 0; retry < 2; retry++) {
        try {
          const retryResp = await callOllama(history, TOOLS, { onToken: tokenCallback });
          if (retryResp.message) {
            // Success on retry — process normally below
            response = retryResp;
            retried = true;
            log(`${C.green}✅ Retry succeeded${C.reset}`);
            break;
          } else if (retryResp.error) {
            log(`${C.red}❌ Model error: ${retryResp.error}${C.reset}`);
            break;
          }
        } catch (retryErr) {
          log(`${C.yellow}⚠️ Retry ${retry + 1} failed: ${retryErr.message}${C.reset}`);
        }
      }
      if (!retried && !response?.error && !response?.message) {
        log(`${C.red}❌ No response from model after retries${C.reset}`);
        break;
      }
      if (!response?.message) break;
    }
    // Re-extract msg in case response was reassigned by retry
    msg = response.message;

    // Show thinking if present (full display — thinking is important!)
    if (msg.thinking) {
      // ── TUI dashboard: render THINKING panel (in-place scroll) ──
      const thinkPanel = renderThinkingPanel(msg.thinking);
      if (!silent && thinkPanel) _writePanel('THINKING', `\n${thinkPanel}`);
      else {
        // Fallback for silent mode or if panel is empty
        // BUG 17 FIX: Strip hallucinated TUI lines from fallback display too
        const cleanedThink = _stripFakeTui(msg.thinking);
        if (cleanedThink) {
          const thinkLines = cleanedThink.split('\n');
          log(`\n${C.bold}${C.cyan}🧠 Thinking:${C.reset}`);
          for (const line of thinkLines) {
            log(`${C.cyan}${line}${C.reset}`);
          }
          log('');
        }
      }
    }

    // Show text content — strip fake TUI chrome that the model sometimes generates
    // Compute cleanContent BEFORE the if-block so it's available for history.push below
    // BUG 17 FIX: Use _stripFakeTui() for the common TUI-chrome patterns, then strip box-drawing
    let cleanContent = _stripFakeTui(msg.content || '')
      .replace(/^[\s]*──\s*(?:Step|Phase)\s+\d+.*$/gim, '')
      .replace(/^║\s*(?:undefined\s+)?(?:REASONING|THINKING|TOOL\s*GRID|CHAIN\s*TABLE|OUTPUT|PROGRESS|STATUS|STEP|PHASE|VULN|EXPLOIT|SCAN|TARGET)[^║]*║\s*$/gim, '')
      .replace(/^[║│]\s*.{1,80}?\s*[║│]\s*$/gm, (m) => {
        const inner = m.replace(/^[║│]\s*/, '').replace(/\s*[║│]\s*$/, '');
        if (/^[├└┌│]/.test(inner) || inner.length > 70) return m;
        return '';
      })
      .replace(/^[│┃┆┇┊╎╏║┗┛┘└┌┐┍▌▎┑▒─═├┝┞┟┠┡┢┬┭┮┯┰┤┥┦┧┨┩╄╅┆┇┈╉┊╪╫╬╠╣╔╗╚╝╤╥╧╨╳\s]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n').trim();
    if (msg.content && msg.content.trim()) {
      // cleanContent was already computed above (hoisted) — use it for display
      if (cleanContent) {
        log(`\n${C.white}${cleanContent}${C.reset}\n`);
      }
    }

    // ── Empty response recovery ──
    // If model returns no tool calls AND empty/whitespace content, it likely failed
    // to generate a proper response (confused context, too much history, etc.)
    // Retry up to 2 times with a nudge message instead of immediately giving up.
    const EMPTY_RETRY_LIMIT = 2;
    const hasContent = cleanContent && cleanContent.trim().length > 0;
    const hasThinking = msg.thinking && msg.thinking.trim().length > 0;
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      if (!hasContent && !hasThinking && _emptyRetries < EMPTY_RETRY_LIMIT) {
        _emptyRetries++;
        log(`${C.yellow}⚠️  Model returned empty response (retry ${_emptyRetries}/${EMPTY_RETRY_LIMIT}). Compacting history and retrying...${C.reset}`);
        // Compact history aggressively before retry
        compactHistory(history);
        // Remove the empty assistant entry we just pushed
        if (history.length > 0 && history[history.length - 1].role === 'assistant' && !(history[history.length - 1].content || '').trim()) {
          history.pop();
          // Also remove the user message that triggered it since we'll re-send
          if (history.length > 0 && history[history.length - 1].role === 'user') {
            history.pop();
          }
        }
        // Inject nudge and re-queue the user's message
        history.push({ role: 'system', content: 'IMPORTANT: Your last response was empty. You MUST respond with either a tool call or substantive text. Do not output empty content. If you have information to share, share it. If you need to act, call a tool.' });
        history.push({ role: 'user', content: userMessage });
        continue; // retry the loop
      }
      // After retries exhausted, still empty — fall through to normal exit logic
    }

    // No tool calls = done (or empty response after retries exhausted)
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      // BUG FIX: Don't push empty assistant messages to history — they confuse the model on reload
      const hasContentToSave = (cleanContent && cleanContent.trim().length > 0) || (msg.thinking && msg.thinking.trim().length > 0);
      if (hasContentToSave) {
        // Push CLEANED content to history — strips hallucinated TUI chrome (⏳ Queued, box-drawing, etc.)
        // so the model doesn't see its own fake status lines in context and loop on them
        // BUG 17 FIX: Use _stripFakeTui() helper instead of inline regex chain
        const cleanThinkingNoTool = _stripFakeTui(msg.thinking || '');
        history.push({ role: 'assistant', content: cleanContent || '', ...(cleanThinkingNoTool ? { thinking: cleanThinkingNoTool } : {}) });
      }
      lastHadToolCalls = false;

      // ── Stuck-loop detection ──
      // 1. Exact match: model gives the same response twice in a row
      // 2. No-progress: model responds N times without making any tool calls
      // 3. Semantic loop: model keeps asking similar questions (prefix overlap)
      //    even if it makes trivial tool calls between them
      // Check BOTH start and end of content for clarifying patterns —
      // thinking/reasoning often pushes the actual question to the end
      const responseText = (msg.content || '').trim();
      const responseHead = responseText.substring(0, 500);
      const responseTail = responseText.length > 200 ? responseText.substring(responseText.length - 500) : '';
      const responseAll = responseHead + '\n' + responseTail;
      _noProgressCount++;

      // Track response prefix for semantic loop detection
      const normPrefix = _normalizeForLoopCheck(responseHead).substring(0, 80);
      if (normPrefix && normPrefix.length >= 10) {
        _recentResponsePrefixes.push(normPrefix);
        if (_recentResponsePrefixes.length > SEMANTIC_LOOP_WINDOW) {
          _recentResponsePrefixes.shift();
        }
      }

      // Detect clarifying-question loops even in no-tool-call path
      // Check combined head+tail so patterns hidden after long thinking text are caught
      const isClarifyingNoTool = _isClarifyingQuestion(responseAll);
      const clarifyingLoopNoTool = _recentResponsePrefixes.filter(p => _isClarifyingQuestion(p)).length >= 2;

      const isRepeated = responseHead && responseHead === _lastAssistantResponse;
      const isStalled = _noProgressCount >= NO_PROGRESS_LIMIT;
      const isSemanticLoop = normPrefix && normPrefix.length >= 10 && _semanticLoopCount(responseAll) >= SEMANTIC_LOOP_THRESHOLD;
      if (isRepeated || isStalled || isSemanticLoop || isClarifyingNoTool || clarifyingLoopNoTool) {
        let reason;
        if (isRepeated) reason = 'model repeated itself';
        else if (isSemanticLoop) reason = `semantic loop detected (${_semanticLoopCount(responseAll)} similar responses)`;
        else if (isClarifyingNoTool) reason = 'clarifying question detected (no tool calls — breaking)';
        else if (clarifyingLoopNoTool) reason = `clarifying-question loop (${_recentResponsePrefixes.filter(p => _isClarifyingQuestion(p)).length} clarifying responses)`;
        else reason = `${_noProgressCount} turns with no tool calls (likely semantic loop)`;
        log(`\n${C.yellow}${C.bold}⚠️  Stuck-loop detected: ${reason}. Breaking loop.${C.reset}`);
        log(`${C.dim}   (Clearing stale queued messages too)${C.reset}\n`);
        _lastAssistantResponse = '';
        _noProgressCount = 0;
        // BUG 16 FIX: Save prefix count BEFORE resetting so trim uses the real count
        const savedPrefixCount = _recentResponsePrefixes.length;
        _recentResponsePrefixes = [];
        // Drain stale queued messages that would just trigger the same loop
        const drained = _messageQueue.length;
        _messageQueue.length = 0;
        // BUG 16 FIX: Cooldown = max(3, drained) so we skip all re-queued messages (was always 3)
        _stuckCooldown = Math.max(3, drained);
        // Also cancel any in-progress paste batch
        if (_batch?.timer) clearTimeout(_batch.timer);
        _batch = null;
        if (drained > 0) {
          log(`${C.dim}   (${drained} queued message(s) cleared)${C.reset}`);
        }
        // Trim last N assistant+user pairs from history to remove loop context
        // so the model doesn't re-enter the same loop on the next prompt
        // BUG 16 FIX: use savedPrefixCount (not _recentResponsePrefixes.length which is 0)
        let trimCount = Math.min(savedPrefixCount + 1, 10);  // remove loop turns (max 10, was 5)
        while (trimCount > 0 && history.length > 2) {
          const last = history[history.length - 1];
          if (last.role === 'assistant') { history.pop(); trimCount--; }
          else if (last.role === 'user') { history.pop(); }  // also remove the user prompt that triggered it
          else break;
        }
        // BUG 17 FIX: Inject a system message to prevent re-asking the same question
        history.push({ role: 'system', content: 'LOOP BREAK: You were asking the same clarifying question repeatedly. Do NOT ask the user the same question again. Either: (1) proceed with a reasonable default and explain your choice, or (2) provide a single clear recommendation without asking for more info. Never repeat a question you already asked.' });
      } else {
        _lastAssistantResponse = responseText;
      }

      // ── TUI dashboard: final render at normal exit ──
      if (!silent) {
        tuiSetPhase('Complete');
        const reasonPanel = renderReasoningPanel();
        if (reasonPanel) _writePanel('REASONING', reasonPanel);
      }
      break;
    }

    // Tool calls in progress — mark so next turn skips compact
    lastHadToolCalls = true;

    // ── Smart no-progress tracking ──
    // Only reset (not just decrement) the counter when tool calls produce
    // substantial, non-error output. Trivial/failed tool calls don't count
    // as progress — the agent can loop by alternating questions with
    // failed tool calls and never hit the limit.
    // Check BOTH start and end of content for clarifying patterns —
    // thinking/reasoning often pushes the actual question to the end
    const toolResponseText = (msg.content || '').trim();
    const toolResponseHead = toolResponseText.substring(0, 500);
    const toolResponseTail = toolResponseText.length > 200 ? toolResponseText.substring(toolResponseText.length - 500) : '';
    const toolResponseAll = toolResponseHead + '\n' + toolResponseTail;

    // Check if the text portion of this response is a clarifying question
    // (agent asking for confirmation/details instead of doing the task)
    const isClarifying = _isClarifyingQuestion(toolResponseAll);

    if (isClarifying) {
      // Clarifying question WITH tool calls = agent is still stuck, just
      // making trivial calls. Count as no progress to trigger stuck-loop.
      _noProgressCount++;
    } else {
      // Real tool calls without a clarifying question = genuine progress
      _noProgressCount = 0;
    }

    // ── Semantic loop detection even during tool calls ──
    // The model can make trivial tool calls (like listing files) and then
    // ask the same question again. Track response prefix similarity here too.
    const toolNormPrefix = _normalizeForLoopCheck(toolResponseHead).substring(0, 80);
    if (toolNormPrefix && toolNormPrefix.length >= 10) {
      _recentResponsePrefixes.push(toolNormPrefix);
      if (_recentResponsePrefixes.length > SEMANTIC_LOOP_WINDOW) {
        _recentResponsePrefixes.shift();
      }
    }
    const toolSemanticLoop = toolNormPrefix && toolNormPrefix.length >= 10 && _semanticLoopCount(toolResponseAll) >= SEMANTIC_LOOP_THRESHOLD;
    // Also detect clarifying-question loops: if agent asks clarifying
    // questions 2+ times (even with rephrasing), break the loop
    // (Lowered from 3 — agent rephrases so 2 is enough to detect stuck)
    const clarifyingLoopCount = _recentResponsePrefixes.filter(p => _isClarifyingQuestion(p)).length;
    const isClarifyingLoop = clarifyingLoopCount >= 2;
    // CRITICAL FIX: also check noProgress in the tool-call path
    // Previously _noProgressCount was only checked in the no-tool path,
    // so the agent could loop indefinitely alternating trivial tool calls
    // with clarifying questions and never hit the stuck-loop break.
    const isToolStalled = _noProgressCount >= NO_PROGRESS_LIMIT;

    if (toolSemanticLoop || isClarifyingLoop || isToolStalled) {
      let reason;
      if (toolSemanticLoop) reason = `semantic loop detected (${_semanticLoopCount(toolResponseAll)} similar responses, even with tool calls)`;
      else if (isClarifyingLoop) reason = `clarifying-question loop detected (${clarifyingLoopCount} clarifying responses)`;
      else reason = `${_noProgressCount} turns without real progress (tool-call path)`;
      log(`\n${C.yellow}${C.bold}⚠️  Stuck-loop detected: ${reason}. Breaking loop.${C.reset}`);
      log(`${C.dim}   (Clearing stale queued messages too)${C.reset}\n`);
      _lastAssistantResponse = '';
      _noProgressCount = 0;
      // BUG 16 FIX: Save prefix count BEFORE resetting so trim uses the real count
      const savedPrefixCount2 = _recentResponsePrefixes.length;
      _recentResponsePrefixes = [];
      // Drain stale queued messages that would just trigger the same loop
      const drained2 = _messageQueue.length;
      _messageQueue.length = 0;
      // BUG 16 FIX: Cooldown = max(3, drained) so we skip all re-queued messages (was always 3)
      _stuckCooldown = Math.max(3, drained2);
      if (_batch?.timer) clearTimeout(_batch.timer);
      _batch = null;
      if (drained2 > 0) {
        log(`${C.dim}   (${drained2} queued message(s) cleared)${C.reset}`);
      }
      // Trim last N assistant+user pairs from history to remove loop context
      // BUG 16 FIX: use savedPrefixCount2 (not _recentResponsePrefixes.length which is 0)
      let trimCount2 = Math.min(savedPrefixCount2 + 1, 10);  // remove loop turns (max 10, was 5)
      while (trimCount2 > 0 && history.length > 2) {
        const last = history[history.length - 1];
        if (last.role === 'assistant') { history.pop(); trimCount2--; }
        else if (last.role === 'user') { history.pop(); }  // also remove the user prompt that triggered it
        else break;
      }
      // BUG 17 FIX: Inject a system message to prevent re-asking the same question
      history.push({ role: 'system', content: 'LOOP BREAK: You were asking the same clarifying question repeatedly. Do NOT ask the user the same question again. Either: (1) proceed with a reasonable default and explain your choice, or (2) provide a single clear recommendation without asking for more info. Never repeat a question you already asked.' });
      // Push CLEANED content before breaking — same fix as no-tool-call path
      // BUG FIX: Don't push empty assistant messages
      const _hasLoopContent = (cleanContent && cleanContent.trim().length > 0) || (msg.thinking && msg.thinking.trim().length > 0);
      if (_hasLoopContent) {
        // BUG 17 FIX: Use _stripFakeTui() helper
        const cleanThinking = _stripFakeTui(msg.thinking || '');
        history.push({ role: 'assistant', content: cleanContent || '', ...(cleanThinking ? { thinking: cleanThinking } : {}) });
      }
      break;
    }

    // Process tool calls
    const stepNum = turn + 1;
    // ── TUI dashboard: render REASONING panel at each step (in-place scroll) ──
    if (!silent) {
      const reasoningPanel = renderReasoningPanel();
      if (reasoningPanel) _writePanel('REASONING', reasoningPanel);
      log(`${C.magenta}── Step ${stepNum}/${MAX_TURNS} ──${C.reset}`);
    }
    tuiSetPhase('Executing');
    // BUG 16 FIX: strip fake queue/TUI lines from thinking to prevent re-looping
    // BUG 17 FIX: Use _stripFakeTui() helper for tool-call path thinking
    const cleanThinkingTool = _stripFakeTui(msg.thinking || '');
    history.push({
      role: 'assistant',
      content: cleanContent || '',
      ...(cleanThinkingTool ? { thinking: cleanThinkingTool } : {}),
      tool_calls: msg.tool_calls,
    });

    for (const tc of msg.tool_calls) {
      const fnName = tc.function?.name || tc.name;
      const fnArgs = tc.function?.arguments || tc.arguments || {};
      const tcId = tc.id || tc.function?.index?.toString() || '0';

      // Build a short arg hint for display (e.g., "path=/foo" or "cmd:ls")
      let argHint = '';
      try {
        const args = typeof fnArgs === 'string' ? JSON.parse(fnArgs) : fnArgs;
        if (args) {
          // Pick the most useful arg for context
          const hintKey = args.path || args.file || args.command || args.url || args.query || args.target || args.pattern || args.mode || '';
          if (hintKey) {
            argHint = String(hintKey).substring(0, 40);
          } else {
            // Fallback: first value from args
            const firstVal = Object.values(args).find(v => typeof v === 'string' && v.length > 0);
            if (firstVal) argHint = String(firstVal).substring(0, 40);
          }
        }
      } catch (_) {}

      // ── TUI dashboard: add chain entry with arg hint ──
      const chainLabel = argHint ? `Step ${stepNum}: ${fnName} → ${argHint}` : `Step ${stepNum}: ${fnName}`;
      tuiAddChain(chainLabel, toolEmoji(fnName));

      const emoji = toolEmoji(fnName);
      // ── TUI dashboard: mark tool as running ──
      tuiToolStart(emoji, argHint ? `${fnName} → ${argHint}` : fnName);
      log(`${C.cyan}${emoji} ${fnName}${C.reset} ${C.gray}${JSON.stringify(fnArgs).substring(0, 120)}${C.reset}`);
      if (_statusFn) _statusFn(`${emoji} ${fnName}`);

      // ── Idle review safety: block ANY tool that modifies state ──
      if (silent && !isReadOnlyTool(fnName, fnArgs)) {
        log(`${C.yellow}🔒 Blocked ${fnName} during idle review (read-only mode)${C.reset}`);
        history.push({ role: 'tool', name: fnName, content: 'Blocked: idle review is read-only. Only read-only tools and safe shell commands are allowed.' });
        continue;
      }

      // ── Dangerous command confirmation ──
      const dangerReason = isDangerousCommand(fnName, fnArgs);
      if (dangerReason) {
        log(`${C.yellow}${C.bold}⚠️ DANGEROUS: ${dangerReason}${C.reset}`);
        if (_confirmFn) {
          const approved = await _confirmFn(dangerReason, fnName, fnArgs);
          if (!approved) {
            log(`${C.red}🚫 Denied by user${C.reset}`);
            history.push({ role: 'tool', name: fnName, content: 'User denied this dangerous operation.' });
            continue;
          }
          log(`${C.green}✅ Approved${C.reset}`);
        } else {
          // No confirmation function available (module mode) — block by default
          log(`${C.red}🚫 Blocked (no confirmation available in module mode)${C.reset}`);
          history.push({ role: 'tool', name: fnName, content: 'Blocked: dangerous operation requires user confirmation.' });
          continue;
        }
      }

      // Execute tool (with nudge timer for shell commands)
      let result;
      let nudgeInterval = null;
      const isSlowTool = ['shell', 'parallel_shell', 'sub_agent'].includes(fnName);
      if (isSlowTool && _statusFn) {
        // Live elapsed-time nudge while shell commands run
        const startTime = Date.now();
        const nudgeEmoji = fnName === 'shell' ? '🖥️' : fnName === 'parallel_shell' ? '⚡' : '🤖';
        nudgeInterval = setInterval(() => {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          _statusFn(`${nudgeEmoji} ${fnName} → ${elapsed}s`);
        }, Math.round(500 / SCROLL_SPEED));
      }
      try {
        const executor = toolExecutors[fnName];
        if (!executor) {
          // Fallback: try MCP tool
          if (isMcpTool(fnName)) {
            result = await callMcpTool(fnName, fnArgs);
          } else {
            result = `❌ Error: Unknown tool "${fnName}"`;
          }
        } else {
          result = await (typeof executor === 'function' ? executor(fnArgs) : executor(fnArgs));
          if (result === undefined) result = '(no output)';
        }
      } catch (err) {
        result = `Error: ${err.message}`;
      } finally {
        if (nudgeInterval) { clearInterval(nudgeInterval); nudgeInterval = null; }
      }

      // Show result (truncated) with HTTP status highlighting
      const isErr = String(result).startsWith('Error:');
      const resultEmoji = isErr ? '❌' : '✅';

      // ── Tool-error loop detection ──
      // If the SAME tool errors 3+ times in a row, it's likely a code bug
      // (like ReferenceError) causing an infinite retry loop — break out.
      if (isErr) {
        const existing = _consecutiveToolErrors.find(e => e.name === fnName);
        if (existing) {
          existing.count++;
        } else {
          _consecutiveToolErrors = [{ name: fnName, count: 1 }];
        }
        if (existing && existing.count + 1 >= TOOL_ERROR_LOOP_LIMIT) {
          log(`\n${C.red}${C.bold}🚨 Tool-error loop detected: "${fnName}" failed ${existing.count + 1} times in a row. Breaking loop.${C.reset}`);
          log(`${C.dim}   (Error: ${String(result).substring(0, 100)})${C.reset}\n`);
          history.push({ role: 'tool', name: fnName, content: `Error loop detected: "${fnName}" failed ${existing.count + 1} times consecutively. Stopping retries. Last error: ${String(result).substring(0, 200)}` });
          _consecutiveToolErrors = [];
          _noProgressCount = 0;
          _recentResponsePrefixes = [];
          _stuckCooldown = 3;
          // Don't continue processing more tool calls — break out of this turn
          break;
        }
      } else {
        // Tool succeeded — reset consecutive error tracking
        _consecutiveToolErrors = [];
      }
      // Check for HTTP status codes in the result (e.g. "200 OK", "502 Bad Gateway")
      const httpStatusMatch = String(result).match(/\b([45]\d{2}\s+\w+|2\d{2}\s+\w+)/);
      let statusBadge = '';
      if (httpStatusMatch) {
        const code = parseInt(httpStatusMatch[1]);
        if (code >= 200 && code < 300) statusBadge = ` ${C.green}${C.bold}[${httpStatusMatch[1]}]${C.reset}`;
        else if (code >= 400 && code < 500) statusBadge = ` ${C.yellow}${C.bold}[${httpStatusMatch[1]}]${C.reset}`;
        else if (code >= 500) statusBadge = ` ${C.red}${C.bold}[${httpStatusMatch[1]}]${C.reset}`;
      }
      log(`${isErr ? C.red : C.green}${resultEmoji} ${fnName}${statusBadge}${C.reset}`);
      // ── TUI dashboard: mark tool as done, then re-render dashboard in-place ──
      const tuiStatus = isErr ? 'error' : 'ok';
      // Pass result summary to grid (truncated to 80 chars inside tuiToolDone)
      tuiToolDone(fnName, tuiStatus, String(result).substring(0, 200));
      // Re-render dashboard after each tool completes so the grid scrolls
      // grid-to-grid (rows change from ⏳→✅/❌ in real-time)
      if (!silent) {
        const dashParts = [];
        const toolPanel = renderToolPanel();
        if (toolPanel) dashParts.push(toolPanel);
        const chainPanel = renderChainPanel();
        if (chainPanel) dashParts.push(chainPanel);
        if (dashParts.length > 0) _writePanel('DASHBOARD', dashParts.join('\n'));
      }
      const resultStr = String(result);
      const display = resultStr.length > 2000 ? resultStr.substring(0, 2000) + '\n... (truncated)' : resultStr;
      const lines = display.split('\n');
      if (lines.length <= 10) {
        for (const line of lines) log(`${isErr ? C.red : C.green}│ ${line}${C.reset}`);
      } else {
        for (const line of lines.slice(0, 8)) log(`${isErr ? C.red : C.green}│ ${line}${C.reset}`);
        log(`${isErr ? C.red : C.green}│ ... (${lines.length - 8} more lines)${C.reset}`);
      }
      log(`${isErr ? C.red : C.green}└${C.reset}`);

      // Add tool result to history — cap to reduce context bloat
      // (display already shows 2000 chars; history only needs enough for the LLM to understand)
      const HISTORY_RESULT_CAP = 4000;
      const historyContent = resultStr.length > HISTORY_RESULT_CAP
        ? resultStr.substring(0, HISTORY_RESULT_CAP) + '\n[truncated]'
        : resultStr;
      history.push({
        role: 'tool',
        name: fnName,
        content: historyContent,
        // Ollama expects tool_call_id matching
      });
    }

    // ── TUI dashboard: render TOOL GRID + CHAIN panels after each step ──
    // All dashboard panels render as ONE combined block so they scroll
    // in-place together (grid-to-grid, not printing new boxes each time).
    if (!silent) {
      const dashParts = [];
      const toolPanel = renderToolPanel();
      if (toolPanel) dashParts.push(toolPanel);
      const chainPanel = renderChainPanel();
      if (chainPanel) dashParts.push(chainPanel);
      if (dashParts.length > 0) _writePanel('DASHBOARD', dashParts.join('\n'));
    }
  }

  return history;
}

// ── Persistent history (readline up-arrow & session) ────────────────
const HISTORY_FILE = path.join(os.homedir(), '.hakster', 'history');
const SESSION_FILE = path.join(os.homedir(), '.hakster', 'cli_session.json');

function loadHistory() {
  try {
    return fs.readFileSync(HISTORY_FILE, 'utf-8').split('\n').filter(Boolean);
  } catch (_) { return []; }
}

function saveToHistory(line) {
  if (!line || !line.trim()) return;
  try {
    const dir = path.dirname(HISTORY_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const existing = loadHistory();
    const filtered = existing.filter(h => h !== line);
    filtered.push(line);
    const trimmed = filtered.slice(-500);
    fs.writeFileSync(HISTORY_FILE, trimmed.join('\n') + '\n');
  } catch (_) {}
}

function saveSession(history) {
  try {
    const dir = path.dirname(SESSION_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const msgs = history.filter(m => m.role !== 'system').map(m => ({
      role: m.role,
      content: (m.content || '').substring(0, 2000),
      ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
      ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
      ...(m.name ? { name: m.name } : {}),
    }));
    fs.writeFileSync(SESSION_FILE, JSON.stringify(msgs, null, 2), 'utf-8');
  } catch (_) {}
}

function loadSession() {
  try {
    const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
    if (!Array.isArray(data)) return [];
    // BUG FIX: Filter out corrupted history entries that confuse the model
    // 1. Remove empty assistant messages (no content, no tool_calls)
    // 2. Remove orphaned tool messages (without a matching assistant tool_call)
    // 3. Remove consecutive duplicate user messages
    const cleaned = [];
    let lastRole = '';
    let lastContent = '';
    for (const m of data) {
      // Skip empty assistant messages (no content, no thinking, no tool_calls)
      if (m.role === 'assistant' && !(m.content || '').trim() && !(m.thinking || '').trim() && (!m.tool_calls || m.tool_calls.length === 0)) {
        continue;
      }
      // Skip consecutive duplicate user messages
      if (m.role === 'user' && m.role === lastRole && (m.content || '') === lastContent) {
        continue;
      }
      cleaned.push(m);
      lastRole = m.role;
      lastContent = (m.content || '').substring(0, 200); // compare first 200 chars
    }
    // Remove orphaned tool messages (tool role without preceding assistant tool_calls)
    const final = [];
    for (let i = 0; i < cleaned.length; i++) {
      if (cleaned[i].role === 'tool') {
        // Check if previous message was assistant with tool_calls
        if (final.length > 0 && final[final.length - 1].role === 'assistant' && final[final.length - 1].tool_calls) {
          final.push(cleaned[i]);
        }
        // else: orphaned tool message, skip it
      } else {
        final.push(cleaned[i]);
      }
    }
    return [{ role: 'system', content: buildSystemPrompt() }, ...final];
  } catch (_) { return null; }
}

// ── CLI REPL (readline — no alternate screen, native scroll) ───────
async function repl() {
  fs.mkdirSync(path.join(os.homedir(), '.hakster'), { recursive: true });

  // Wire MCP log/status to our output functions
  setMcpLogFn((text) => { console.log(text); });
  setMcpStatusFn((text) => { /* status bar not used in REPL */ });

  // Initialize MCP servers (non-fatal if fails)
  console.log(`${C.cyan}🔌 Loading MCP servers...${C.reset}`);
  await initMcpTools();
  const mcpInfo = mcpStatus();
  if (mcpInfo.length > 0) {
    console.log(`${C.green}✓ ${mcpInfo.length} MCP server(s) connected, ${getMcpTools().length} tool(s) discovered${C.reset}`);
  } else {
    console.log(`${C.dim}  No MCP servers configured${C.reset}`);
  }

  // ── Check skills ──────────────────────────────────────────────────────
  console.log(`${C.cyan}📋 Loading skills...${C.reset}`);
  const skillsDirs = getHaksterRoots().map(root => path.join(root, 'skills'));
  let skillCount = 0;
  const skillCategories = {};
  for (const skillsDir of skillsDirs) {
    try {
      const files = globSync(path.join(skillsDir, '**', '*.md'));
      skillCount += files.length;
      for (const f of files) {
        const rel = path.relative(skillsDir, f).replace(/\.md$/, '');
        const cat = rel.includes('/') ? rel.split('/').slice(0, -1).join('/') : 'root';
        skillCategories[cat] = (skillCategories[cat] || 0) + 1;
      }
    } catch (_) {}
  }
  if (skillCount > 0) {
    const topCats = Object.entries(skillCategories)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([cat, n]) => `${C.magenta}${cat}/${C.reset}${C.dim}(${n})${C.reset}`)
      .join(', ');
    const moreCount = Object.keys(skillCategories).length > 5 ? ` ${C.dim}+${Object.keys(skillCategories).length - 5} more${C.reset}` : '';
    console.log(`${C.green}✓ ${skillCount} skills${C.reset} across ${Object.keys(skillCategories).length} categories: ${topCats}${moreCount}`);
  } else {
    console.log(`${C.dim}  No skills found${C.reset}`);
  }

  // ── Check memory ──────────────────────────────────────────────────────
  console.log(`${C.cyan}🧠 Loading memory...${C.reset}`);
  let memCount = 0;
  const memFiles = [];
  for (const root of getHaksterRoots()) {
    const memoryFile = path.join(root, 'memory', 'notes.json');
    try {
      const notes = JSON.parse(fs.readFileSync(memoryFile, 'utf-8'));
      if (Array.isArray(notes)) {
        memCount += notes.length;
        memFiles.push(memoryFile);
      }
    } catch (_) {}
  }
  if (memCount > 0) {
    // Show last note preview
    let lastNote = '';
    for (const root of getHaksterRoots()) {
      try {
        const notes = JSON.parse(fs.readFileSync(path.join(root, 'memory', 'notes.json'), 'utf-8'));
        if (Array.isArray(notes) && notes.length > 0 && notes[notes.length - 1].content) {
          const c = notes[notes.length - 1].content;
          lastNote = c.length > 80 ? c.substring(0, 77) + '...' : c;
        }
      } catch (_) {}
    }
    const noteInfo = lastNote ? ` ${C.dim}last: "${lastNote}"${C.reset}` : '';
    console.log(`${C.green}✓ ${memCount} memory notes${C.reset} loaded from ${memFiles.length} file(s)${noteInfo}`);
  } else {
    console.log(`${C.dim}  No memory notes — fresh start${C.reset}`);
  }

  // ── Context budget estimate ────────────────────────────────────────────
  const builtInToolCount = _builtinToolCount;
  const mcpToolCount = getMcpTools().length;
  const totalTools = TOOLS.length;
  // Context budget: system prompt + tools + conversation history
  const sysPromptSize = buildSystemPrompt().length;
  const toolJsonSize = JSON.stringify(TOOLS).length;
  const estimatedTokens = Math.ceil((sysPromptSize + toolJsonSize) / 4); // ~4 chars/token for mixed content
  const budgetMax = 131072; // gpt-oss:120b-cloud context window
  const budgetPct = ((estimatedTokens / budgetMax) * 100).toFixed(1);
  const budgetColor = parseFloat(budgetPct) > 80 ? C.red : parseFloat(budgetPct) > 50 ? C.yellow : C.green;
  console.log(`${budgetColor}📐 Context: ~${estimatedTokens.toLocaleString()} / ${budgetMax.toLocaleString()} tokens (${budgetPct}%)${C.reset} ${C.dim}[sys:${Math.ceil(sysPromptSize/4)} tools:${Math.ceil(toolJsonSize/4)}]${C.reset}`);
  console.log(`${C.bold}🔧 ${totalTools} tools${C.reset} (${builtInToolCount} built-in + ${mcpToolCount} MCP)${C.reset}`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${C.purple}❯${C.reset} `,
    historySize: 200,
    removeHistoryDuplicates: true,
  });

  // Load persistent readline history (up-arrow across sessions)
  const savedHistory = loadHistory();
  if (savedHistory.length > 0) {
    rl.history = [...savedHistory].reverse(); // readline stores newest-first
  }

  // ── Status line (overwritten in-place) ────────────────────────────────
  let statusText = 'Ready';
  let spinnerFrames = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
  let spinnerIdx = 0;
  let spinnerInterval = null;

  function startSpinner(label) {
    spinnerIdx = 0;
    spinnerInterval = setInterval(() => {
      process.stdout.write(`\r${C.dim}${spinnerFrames[spinnerIdx % spinnerFrames.length]} ${label}...${C.reset}   `);
      spinnerIdx++;
    }, Math.round(80 / SCROLL_SPEED));
  }
  function stopSpinner() {
    if (spinnerInterval) { clearInterval(spinnerInterval); spinnerInterval = null; }
    process.stdout.write('\r' + ' '.repeat(40) + '\r');
  }

  // ── Wire log & status to straight stdout ──────────────────────────────
  _logFn = (text) => {
    stopSpinner();
    process.stdout.write(text + '\n');
  };
  _statusFn = (text) => {
    statusText = text;
    if (text === 'Ready') {
      stopSpinner();
    }
  };

  // ── Wire danger confirm as readline prompt ────────────────────────────
  _confirmFn = (dangerMsg, tool, args) => {
    return new Promise((resolve) => {
      stopSpinner();
      console.log(`\n${C.red}${C.bold}⚠️  DANGEROUS OPERATION${C.reset}`);
      console.log(`  ${dangerMsg}`);
      console.log(`  Tool: ${tool}`);
      console.log(`  Args: ${JSON.stringify(args).substring(0, 200)}`);
      rl.question(`${C.red}[y/N]${C.reset} Run this? `, (answer) => {
        resolve(answer.toLowerCase() === 'y');
        rl.prompt();
      });
    });
  };

  // ── Print banner ────────────────────────────────────────────────────
  console.log(banner());

  // ── History & state ──────────────────────────────────────────────────
  // Load previous session if available, otherwise start fresh
  const savedSession = loadSession();
  const history = savedSession || [{ role: 'system', content: buildSystemPrompt() }];
  if (savedSession) {
    console.log(`  ${C.green}✓ Restored previous session (${history.length - 1} messages)${C.reset}`);
  }
  let idleTimer = null;
  let processing = false;
  _messageQueue = [];  // Reset module-level queue for this REPL session
  _batch = null;       // Reset paste-batching state
  _lastAssistantResponse = '';  // Reset module-level loop detection for this session
  _noProgressCount = 0;  // Reset no-progress loop detection for this session
  _recentResponsePrefixes = [];  // Reset semantic loop detection for this session
  _stuckCooldown = 0;            // Reset stuck-loop cooldown
  _emptyRetries = 0;              // Reset empty response retry counter

  // ── Idle health check (direct shell — no model call) ──────────────
  async function runIdleHealthCheck() {
    if (processing) return;
    console.log('\n⏳ System health check...');

    const run = async (cmd) => { try { const r = await asyncShell(cmd, { timeout: 10 }); return r.ok ? r.stdout.trim() : null; } catch (_) { return null; } };

    // PM2 services — one line each
    const pm2out = await run('pm2 list --no-color 2>/dev/null');
    if (pm2out) {
      const lines = pm2out.split('\n');
      for (const line of lines) {
        const m = line.match(/^\│\s+(\S+)\s+.*\│\s+(online|stopped|errored|paused)\s+/i);
        if (m) {
          const color = m[2] === 'online' ? C.green : C.red;
          console.log(`  ${C.bold}PM2${C.reset} ${m[1]} ${color}${m[2]}${C.reset}`);
        }
      }
    } else {
      console.log(`  ${C.bold}PM2${C.reset} ${C.red}error${C.reset}`);
    }

    // Memory
    const mem = await run('free -h | head -2 | tail -1');
    if (mem) {
      const parts = mem.split(/\s+/);
      console.log(`  ${C.bold}RAM${C.reset}  ${parts[2] || '?'} used / ${parts[1] || '?'} total`);
    }

    // Disk
    const disk = await run('df -h / | tail -1');
    if (disk) {
      const parts = disk.split(/\s+/);
      console.log(`  ${C.bold}Disk${C.reset} ${parts[2] || '?'} used / ${parts[1] || '?'} total (${parts[4] || '?'})`);
    }

    // Temp
    const tempRaw = await run('cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null');
    if (tempRaw) {
      const tempC = (parseInt(tempRaw) / 1000).toFixed(1);
      const tempColor = parseFloat(tempC) > 80 ? C.red : parseFloat(tempC) > 70 ? C.yellow : C.green;
      console.log(`  ${C.bold}Temp${C.reset} ${tempColor}${tempC}°C${C.reset}`);
    }

    // Ports
    const ports = await run('ss -tlnp 2>/dev/null | grep -E "3579|8081|5555|4000"');
    if (ports) {
      for (const p of ports.split('\n')) {
        const m = p.match(/:(\d+)\s+.*"(.+?)"/);
        if (m) console.log(`  ${C.bold}Port${C.reset} :${m[1]} ${C.green}${m[2]}${C.reset}`);
      }
    } else {
      console.log(`  ${C.bold}Ports${C.reset} ${C.yellow}none found${C.reset}`);
    }

    // Load
    const load = await run('uptime');
    if (load) {
      const lm = load.match(/load average:\s*([\d.,]+)/);
      console.log(`  ${C.bold}Load${C.reset} ${lm ? lm[1] : load}`);
    }

    console.log('✓ Health check complete.\n');
    startIdleTimer();
    rl.prompt();
  }

  function startIdleTimer() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      runIdleHealthCheck();
    }, IDLE_TIMEOUT_MS);
  }
  startIdleTimer();

  // ── Handle input ────────────────────────────────────────────────────
  function handleInput(input) {
    input = (input || '').trim();
    if (!input) { rl.prompt(); return; }
    // Save to persistent history (survives restarts)
    saveToHistory(input);
    startIdleTimer();

    // Commands
    if (input === '/exit' || input === '/quit') {
      shutdownMcp();
      console.log('bye ⚡');
      process.exit(0);
    }
    if (input === '/clear') {
      console.clear();
      console.log(banner());
      history.length = 0;
      history.push({ role: 'system', content: buildSystemPrompt() });
      saveSession(history); // Clear saved session too
      startIdleTimer();
      rl.prompt();
      return;
    }
    if (input === '/review' || input === '/health') {
      runIdleHealthCheck();
      return;
    }
    if (input === '/help') {
      console.log('  /clear  Clear history    /model  Show model    /review  Health check    /skills  Skills count    /tools  Tool list    /mcp  MCP status    /queue  Input+notif queues    /exit  Quit');
      console.log('  ⚠  Dangerous commands (rm, kill, shutdown, etc.) will prompt for confirmation');
      rl.prompt();
      return;
    }
    if (input === '/queue') {
      const notifCount = msgSize();
      const inputCount = _messageQueue.length;
      if (notifCount === 0 && inputCount === 0) {
        console.log(`\n  ${C.dim}Queues are empty${C.reset}\n`);
      } else {
        console.log(`\n${C.bold}${C.cyan}📬 Queues${C.reset}`);
        if (inputCount > 0) {
          console.log(`  ${C.bold}⏳ Input queue: ${inputCount} pending${C.reset}  ${C.dim}(messages waiting for agent)${C.reset}`);
        } else {
          console.log(`  ${C.dim}⏳ Input queue: empty${C.reset}`);
        }
        if (notifCount > 0) {
          console.log(`  ${C.bold}📬 Notification queue: ${notifCount} pending${C.reset}  ${C.dim}(async events, MCP updates)${C.reset}`);
          const items = msgPeek(20);
          const typeColors = { notify: C.cyan, warn: C.yellow, error: C.red, task: C.green, mcp: C.magenta, system: C.dim };
          for (const m of items) {
            const icon = { notify: '📬', warn: '⚠️', error: '❌', task: '✅', mcp: '🔌', system: '⚙️' }[m.type] || '📬';
            const tc = typeColors[m.type] || C.dim;
            const time = m.ts.split('T')[1]?.split('.')[0] || m.ts;
            console.log(`    ${icon} ${tc}${m.msg}${C.reset}  ${C.dim}${time} from:${m.source}${C.reset}`);
          }
        } else {
          console.log(`  ${C.dim}📬 Notification queue: empty${C.reset}`);
        }
        console.log();
      }
      rl.prompt();
      return;
    }
    if (input === '/mcp') {
      const servers = mcpStatus();
      const mcpTools = getMcpTools();
      if (servers.length === 0) {
        console.log(`\n  ${C.yellow}${C.bold}No MCP servers connected${C.reset}`);
        console.log(`  ${C.dim}Add servers to .hakster/mcp.json${C.reset}\n`);
      } else {
        console.log(`\n${C.bold}${C.cyan}🔌 MCP Servers: ${servers.length}${C.reset}  ${C.bold}${C.magenta}Tools: ${mcpTools.length}${C.reset}\n`);
        for (const s of servers) {
          const statusIcon = s.initialized ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
          console.log(`  ${statusIcon} ${C.bold}${s.name}${C.reset}  ${C.dim}PID: ${s.pid || 'N/A'}  tools: ${s.toolCount}${C.reset}`);
          for (const t of s.tools) {
            console.log(`    ${C.cyan}├${C.reset} ${t}`);
          }
        }
        console.log();
      }
      rl.prompt();
      return;
    }
    if (input === '/tools') {
      console.log(`\n${C.bold}${C.cyan}🔧 Tools: ${TOOLS.length}${C.reset}\n`);
      TOOLS.forEach((t, i) => {
        const name = t.function?.name || '(unknown)';
        const desc = t.function?.description?.split('\n')[0]?.slice(0, 60) || '';
        console.log(`  ${C.green}${String(i + 1).padStart(2)}${C.reset}  ${C.bold}${name}${C.reset}  ${C.dim}${desc}${C.reset}`);
      });
      console.log();
      rl.prompt();
      return;
    }

    if (input === '/skills') {
      const skillsDirs = getHaksterRoots().map(root => path.join(root, 'skills'));
      let total = 0;
      const categories = [];
      for (const skillsDir of skillsDirs) {
        try {
          const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isFile() && entry.name.endsWith('.md')) {
              total++;
            } else if (entry.isDirectory()) {
              const count = globSync(path.join(skillsDir, entry.name, '**', '*.md')).length;
              if (count > 0) { categories.push({ name: entry.name, count }); total += count; }
            }
          }
        } catch (_) {}
      }
      console.log(`\n${C.bold}${C.cyan}🔧 Tools: ${TOOLS.length}${C.reset}  ${C.bold}${C.magenta}📚 Skills: ${total} loaded${C.reset}`);
      categories.sort((a, b) => b.count - a.count).forEach(c => {
        console.log(`  ${C.cyan}${c.name}${C.reset} ${C.dim}(${c.count})${C.reset}`);
      });
      console.log();
      rl.prompt();
      return;
    }
    if (input === '/model') {
      console.log(`  Model: ${MODEL}`);
      rl.prompt();
      return;
    }

    // Drain notification queue before processing user input
    const pending = msgDrain(10);
    if (pending.length > 0) {
      const typeColors = { notify: C.cyan, warn: C.yellow, error: C.red, task: C.green, mcp: C.magenta, system: C.dim };
      const typeIcons = { notify: '📬', warn: '⚠️', error: '❌', task: '✅', mcp: '🔌', system: '⚙️' };
      for (const m of pending) {
        const icon = typeIcons[m.type] || '📬';
        const tc = typeColors[m.type] || C.dim;
        const time = m.ts.split('T')[1]?.split('.')[0] || m.ts;
        console.log(`  ${icon} ${tc}${m.msg}${C.reset} ${C.dim}${time}${C.reset}`);
      }
    }

    // Run agent loop (or queue if busy — with paste batching)
    if (processing) {
      // ── Multi-line paste batching ──
      // Lines arriving within the batch window get merged into one message
      // instead of queuing separately. This prevents 60-line pastes from
      // creating 60 separate agentLoop calls.
      // Key fix: use a separate object for batch state instead of attaching
      // properties to the Array (which can be lost on .length=0 reset).
      if (!_batch) _batch = { lines: [], timer: null };
      _batch.lines.push(input);
      // Show live batching feedback (overwrites previous line)
      const batchNum = _batch.lines.length;
      process.stdout.write(`\r${C.dim}⏳ Batching (${batchNum} line${batchNum !== 1 ? 's' : ''})...${C.reset}   `);
      // Reset batch window on each new line (debounce — 500ms for slow pastes)
      if (_batch.timer) clearTimeout(_batch.timer);
      _batch.timer = setTimeout(() => {
        // Batch window closed — merge all lines into one queue entry
        const lineCount = _batch.lines.length;
        const merged = _batch.lines.join('\n');
        _batch = null;
        _messageQueue.push(merged);
        // Clear the batching line, then print final queue status
        process.stdout.write(`\r${' '.repeat(60)}\r`);  // clear the "Batching..." line
        console.log(`${C.dim}⏳ Queued (1 batch, ${lineCount} line${lineCount !== 1 ? 's' : ''}, queue depth ${_messageQueue.length})${C.reset}`);
      }, 500);
      return;
    }
    processing = true;
    _statusFn('⏳ Processing...');
    startSpinner('Processing');
    (async () => {
      try {
        await agentLoop(input, history);
        stopSpinner();
        console.log(`${C.green}✓ Done${C.reset}`);
      } catch (err) {
        stopSpinner();
        console.log(`${C.red}❌ Error: ${err.message}${C.reset}`);
      }
      processing = false;
      _statusFn('Ready');
      startIdleTimer();
      saveSession(history); // Persist conversation for next session
      // Process queued messages — but skip if in stuck-loop cooldown
      if (_stuckCooldown > 0 && _messageQueue.length > 0) {
        // Drain up to _stuckCooldown messages from queue to prevent re-looping
        const skip = Math.min(_stuckCooldown, _messageQueue.length);
        _messageQueue.splice(0, skip);
        _stuckCooldown = 0;  // Cooldown consumed
        if (skip > 0) {
          console.log(`${C.dim}   (${skip} queued message(s) skipped — stuck-loop cooldown)${C.reset}`);
        }
      }
      if (_messageQueue.length > 0) {
        const next = _messageQueue.shift();
        handleInput(next);
      } else {
        rl.prompt();
      }
    })();
  }

  rl.on('line', handleInput);
  rl.on('close', () => {
    // Flush readline history to disk on exit
    try {
      const hist = (rl.history || []).filter(Boolean).reverse().slice(-200);
      fs.writeFileSync(HISTORY_FILE, hist.join('\n'), 'utf-8');
    } catch (_) {}
    saveSession(history);
    shutdownMcp();
    console.log('bye ⚡');
    process.exit(0);
  });

  rl.prompt();
}

// ── Export for use as module or direct run ───────────────────────────────
module.exports = { agentLoop, TOOLS, toolExecutors, banner, buildSystemPrompt, initMcpTools, shutdownMcp, msgPush, msgDrain, msgPeek, msgClear, msgSize };
if (require.main === module) repl();
