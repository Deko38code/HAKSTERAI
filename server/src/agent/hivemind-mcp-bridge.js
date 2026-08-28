#!/usr/bin/env node
/**
 * MCP <-> Hivemind bridge.
 *
 * Exposes Hivemind's shared brain (the "one big brain" across every assistant)
 * to the hakster agent as an MCP server, WITHOUT running `hivemind install`
 * (which would rewrite the user's Claude Code / Cursor / etc. config).
 *
 * Two access paths:
 *   1. Direct filesystem read of the Deeplake memory-graph mount at
 *      ~/.deeplake/memory/graph/{index.md, find/<pattern>, show/<handle>}
 *      — fast, no spawn, works offline once the graph is populated.
 *   2. `hivemind` CLI fallback for context / rules / skills / whoami — these
 *      require `hivemind login` (device-flow, opens a browser). Until the
 *      operator logs in, every tool returns a clear "Not logged in" message
 *      instead of hanging.
 *
 * Auth is the operator's step: run `hivemind login` once on the host.
 * A pre-provisioned token can be supplied via HIVEMIND_TOKEN (forwarded to the
 * CLI through env) for headless/CI setups.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin, terminal: false });

// The hakster MCP loader (mcp.js) overrides HOME to the ghost home for MCP
// children, but the operator runs `hivemind login` as their real user (root on
// this box → /root). Use the real home so credentials + the graph mount line up
// with wherever `hivemind login` actually wrote them. Override via HIVEMIND_HOME.
const HOME = process.env.HIVEMIND_HOME
 || '/home/ghost'
 || (process.getuid && process.getuid() === 0 ? '/root' : (process.env.HOME || os.homedir() || '/root'));
const GRAPH_DIR = process.env.HIVEMIND_GRAPH_DIR || path.join(HOME, '.deeplake', 'memory', 'graph');
const HIVEMIND_BIN = process.env.HIVEMIND_BIN || 'hivemind';

// Forward a token to the CLI if one is present (headless auth). Pin HOME so the
// CLI reads the same credentials + graph the bridge reads, regardless of what
// the MCP loader set HOME to.
const CLI_ENV = { ...process.env, HOME };
if (process.env.HIVEMIND_TOKEN && !CLI_ENV.HIVEMIND_TOKEN) CLI_ENV.HIVEMIND_TOKEN = process.env.HIVEMIND_TOKEN;
// Fallback: read token directly from deeplake credentials if env var is missing
if (!CLI_ENV.HIVEMIND_TOKEN) {
  try {
    const credsPath = path.join(HOME, '.deeplake', 'credentials.json');
    const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
    if (creds.token) CLI_ENV.HIVEMIND_TOKEN = creds.token;
  } catch(e) {}
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

// Run a hivemind CLI subcommand synchronously with a hard timeout so a
// missing auth or hung network never stalls the MCP caller.
function runCli(args, { timeoutMs = 20000 } = {}) {
  try {
    const r = spawnSync(HIVEMIND_BIN, args, {
      env: CLI_ENV,
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    const out = (r.stdout || '').trim();
    const err = (r.stderr || '').trim();
    // CLI prints auth errors to stdout OR stderr depending on subcommand.
    const combined = out + '\n' + err;
    if (combined.match(/not logged in|run `?hivemind login|login first/i)) {
      return { ok: false, needLogin: true, text: 'Hivemind is not logged in. Run `hivemind login` on the host (opens a browser) or set HIVEMIND_TOKEN, then reload MCP.' };
    }
    if (r.error || (r.status !== 0 && !out)) {
      return { ok: false, text: err || (r.error ? r.error.message : `hivemind exited ${r.status}`) };
    }
    return { ok: true, text: out || '(no output)' };
  } catch (e) {
    return { ok: false, text: `Failed to run hivemind: ${e.message}` };
  }
}

// Safe read of a graph-mount file. Returns null if the mount isn't populated.
function readGraphFile(rel) {
  const p = path.join(GRAPH_DIR, rel);
  try {
    if (!fs.existsSync(p)) return null;
    const stat = fs.statSync(p);
    if (stat.isDirectory()) {
      const entries = fs.readdirSync(p).map(n => {
        try { return `${n}/ (${fs.statSync(path.join(p, n)).isDirectory() ? 'dir' : 'file'})`; } catch { return `${n}/`; }
      });
      return entries.length ? `Directory ${rel}:
${entries.join('\n')}` : `(empty directory: ${rel})`;
    }
    const body = fs.readFileSync(p, 'utf8');
    // Cap to keep the tool result bounded.
    return body.length > 200000 ? body.slice(0, 200000) + `
... (truncated, ${body.length} chars total)` : body;
  } catch (e) {
    return null;
  }
}

function graphReady() {
  try { return fs.existsSync(GRAPH_DIR); } catch { return false; }
}

// ── Tool handlers ────────────────────────────────────────────────────────
const handlers = {
  hivemind_whoami() {
    const r = runCli(['whoami']);
    return r.text;
  },
  hivemind_context() {
    // Rules + open-goals block — the cross-agent steering context.
    const r = runCli(['context']);
    return r.text;
  },
  hivemind_rules_list({ status = 'active', limit = 20 } = {}) {
    const r = runCli(['rules', 'list', '--status', String(status), '--limit', String(limit)]);
    return r.text;
  },
  hivemind_memory_index() {
    if (!graphReady()) {
      return `Memory graph not populated yet at ${GRAPH_DIR}. It is created after \`hivemind login\` + a session scan (or \`hivemind graph install\` in a repo). CLI whoami: ` + runCli(['whoami']).text;
    }
    const idx = readGraphFile('index.md');
    return idx || `(graph mount exists at ${GRAPH_DIR} but index.md is empty)`;
  },
  hivemind_memory_find({ pattern } = {}) {
    if (!pattern) return 'Missing required `pattern`. Example: hivemind_memory_find({ pattern: "auth" }).';
    if (!graphReady()) {
      return `Memory graph not populated yet at ${GRAPH_DIR}. Run \`hivemind login\` and let it scan, then reload. ` + runCli(['whoami']).text;
    }
    // The mount exposes find/<pattern> as a file/dir; pattern may contain slashes.
    const safe = pattern.replace(/^\/+|\/+$/g, '');
    const hit = readGraphFile(path.join('find', safe));
    if (hit != null) return hit;
    // Fall back to listing the find/ directory so the caller sees available patterns.
    const listing = readGraphFile('find');
    return `No graph entry for pattern "${pattern}". ${listing ? 'Available patterns:\n' + listing : 'find/ directory is empty.'}`;
  },
  hivemind_memory_show({ handle } = {}) {
    if (!handle) return 'Missing required `handle` (a handle or pattern). Example: hivemind_memory_show({ handle: "lesson:auth-rce" }).';
    if (!graphReady()) {
      return `Memory graph not populated yet at ${GRAPH_DIR}. Run \`hivemind login\` + scan, then reload. ` + runCli(['whoami']).text;
    }
    const safe = handle.replace(/^\/+|\/+$/g, '');
    const hit = readGraphFile(path.join('show', safe));
    if (hit != null) return hit;
    const listing = readGraphFile('show');
    return `No graph entry for handle "${handle}". ${listing ? 'Available handles:\n' + listing : 'show/ directory is empty.'}`;
  },
  hivemind_skills_state() {
    const r = runCli(['skillify']);
    return r.text;
  },
  hivemind_skills_pull({ to = 'global', allUsers = true, user, dryRun = false } = {}) {
    const args = ['skillify', 'pull'];
    if (allUsers) args.push('--all-users');
    else if (user) args.push('--user', String(user));
    args.push('--to', String(to));
    if (dryRun) args.push('--dry-run');
    const r = runCli(args, { timeoutMs: 60000 });
    return r.text;
  },
  hivemind_skills_mine_local({ n = 'all', dryRun = false } = {}) {
    // mine-local works WITHOUT auth — mines skills from local sessions.
    const args = ['skillify', 'mine-local', '--n', String(n)];
    if (dryRun) args.push('--dry-run');
    const r = runCli(args, { timeoutMs: 120000 });
    return r.text;
    },
    hivemind_rules_add({ text, scope = 'team' } = {}) {
    if (!text) return 'Error: text is required';
    try {
    const rulesFile = path.join(HOME, '.hivemind', 'rules.json');
    let rules = [];
    if (fs.existsSync(rulesFile)) rules = JSON.parse(fs.readFileSync(rulesFile, 'utf8'));
    rules.push({ id: 'rule-' + Date.now(), text, scope, status: 'active', createdAt: new Date().toISOString() });
    fs.mkdirSync(path.dirname(rulesFile), { recursive: true });
    fs.writeFileSync(rulesFile, JSON.stringify(rules, null, 2));
    return `Rule added: ${text}`;
    } catch(e) { return `Failed: ${e.message}`; }
    },
    hivemind_memory_write({ handle, content, tags = [] } = {}) {
    if (!handle || !content) return 'Error: handle and content required';
    try {
    const memDir = path.join(HOME, '.deeplake', 'memory', 'graph', 'show');
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(path.join(memDir, handle + '.md'), `# ${handle}

Tags: ${tags.join(', ')}

${content}
`);
    const idxFile = path.join(HOME, '.deeplake', 'memory', 'graph', 'index.md');
    let idx = fs.existsSync(idxFile) ? fs.readFileSync(idxFile, 'utf8') : '# Memory Graph Index\n';
    if (!idx.includes(handle)) { idx += `
- ${handle} — ${content.slice(0, 80)}`; fs.writeFileSync(idxFile, idx); }
    return `Memory written: ${handle}`;
    } catch(e) { return `Failed: ${e.message}`; }
    },
    hivemind_brain_dump({} = {}) {
    const results = [];
    const rules = [
    'All agents must verify file syntax with node -c after editing JS files',
    'Never restart CineVault without checking cli-guard.sh and stale PIDs on 8081',
    'Always use --prefer-offline with npm install to avoid hangs',
    'Machine has 7GB RAM - avoid spawning multiple heavy processes at once',
    'Check CPU temp before heavy builds - temps run 84-89C on this box',
    'Always use absolute paths - project dir may not be cwd',
    'Never edit CineVault app.js or server.js unless user explicitly asks',
    'PM2 services: hakster 3579, cinevault 8081, miniforge 5555, phantom 4000, claude-proxy 8082',
    'Pentest tools: nmap, nikto, sqlmap, gobuster, ffuf, hydra, john, hashcat, masscan',
    'Skills library at /home/ghost/skills with 2080+ skills - always skill_list before unfamiliar tasks',
    'Miniforge has 10730+ bots including 186 hack bots - use list_hack_bots and chat_hack_bot',
    'ScraperAPI 2 keys with 9970 credits, rotation at /home/ghost/scraperapi-rotation.sh',
    'Hivemind shared brain - all agents share rules, memory graph, and skills via deeplake',
    'Identity: You are haksterAI - never reference underlying model vendor or engine',
    ];
    for (const rule of rules) results.push(handlers.hivemind_rules_add({ text: rule }));
    const memories = [
    { handle: 'machine-specs', content: 'OS: Linux Mint 22.3, AMD A12-9720P 4C+8G, 7GB RAM, 457GB disk (78% used). Node v22.23.2, Python 3.12.3.', tags: ['system', 'hardware'] },
    { handle: 'pm2-services', content: 'hakster(3579), cinevault(8081), miniforge(5555), phantom(4000), claude-proxy(8082), codex-proxy, ollama(11434), sonnet-brain, hakster-api, hakster-web, vidsrc-server, cloudflared, tg-miniapps-bridge', tags: ['pm2', 'services', 'ports'] },
    { handle: 'pentest-toolkit', content: 'nmap, nikto, sqlmap, gobuster, ffuf, hydra, john, hashcat, massan. Skills: hunting-methodology, recon-methodology, hunt-rce, hunt-xss, hunt-sqli, hunt-ssrf, hunt-idor, hunt-oauth, red-teaming/godmode', tags: ['pentest', 'security'] },
    { handle: 'skills-library', content: '2080+ skills at /home/ghost/skills. Categories: creative, pentest-agents, knowledge, iptv, devops, security, coding, research, media, autonomous-ai-agents.', tags: ['skills', 'reference'] },
    { handle: 'miniforge-bots', content: 'Miniforge has 10730+ bots including 186 hack bots. Use list_hack_bots, chat_hack_bot, ask_hack_squad. Image bots, security bots, coding bots available.', tags: ['miniforge', 'bots', 'ai'] },
    { handle: 'scraperapi', content: '2 ScraperAPI keys with 9970 credits. Rotation at /home/ghost/scraperapi-rotation.sh. Smart scraper at /home/ghost/smart-scraper.sh.', tags: ['scraper', 'api'] },
    { handle: 'project-map', content: 'haksterAi: /home/ghost/haksterAi (Astro+Express). CineVault: /home/ghost/cine-vault-live (IPTV). Miniforge: /home/ghost/miniforge (bots). Phantom: /home/ghost/phantom-ide.html (web IDE, 57 agents).', tags: ['projects', 'paths'] },
    { handle: 'operator-profile', content: 'Operator: Ghost. Works on bug bounty, pentesting, AI development, IPTV/streaming. Machine is personal - treat with care.', tags: ['user', 'operator'] },
    ];
    for (const mem of memories) results.push(handlers.hivemind_memory_write(mem));
    return results.join('\n');
    },
};

const TOOLS = [
  {
    name: 'hivemind_whoami',
    description: 'Check Hivemind auth status (user / org / workspace). Returns "Not logged in" until `hivemind login` is run on the host.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'hivemind_context',
    description: 'Get the shared Hivemind context block (active team rules + open goals) injected across all agents. Requires login.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'hivemind_rules_list',
    description: 'List team-wide rules from the shared brain. status: active|done|all. Requires login.',
    inputSchema: { type: 'object', properties: { status: { type: 'string', enum: ['active', 'done', 'all'] }, limit: { type: 'number' } }, required: [] },
  },
  {
    name: 'hivemind_memory_index',
    description: 'Read the index of the shared Deeplake memory graph (~/.deeplake/memory/graph/index.md). The "one big brain" — memories mined from every wired assistant. Read directly from the mount (fast).',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'hivemind_memory_find',
    description: 'Search the shared memory graph by pattern. Reads ~/.deeplake/memory/graph/find/<pattern>. Use before guessing — recall lessons other agents learned.',
    inputSchema: { type: 'object', properties: { pattern: { type: 'string', description: 'Search pattern, e.g. "auth", "rce", "ffmpeg"' } }, required: ['pattern'] },
  },
  {
    name: 'hivemind_memory_show',
    description: 'Show a specific memory by handle from the shared graph. Reads ~/.deeplake/memory/graph/show/<handle>.',
    inputSchema: { type: 'object', properties: { handle: { type: 'string', description: 'Memory handle or pattern, e.g. "lesson:auth-rce"' } }, required: ['handle'] },
  },
  {
    name: 'hivemind_skills_state',
    description: 'Show Hivemind skillify state (scope, team, install location, per-project state). Requires login.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'hivemind_skills_pull',
    description: 'Pull shared skills from the org table to local FS so every agent reuses them. Default: all users -> global. Requires login.',
    inputSchema: { type: 'object', properties: { to: { type: 'string', enum: ['global', 'project'] }, allUsers: { type: 'boolean' }, user: { type: 'string' }, dryRun: { type: 'boolean' } }, required: [] },
  },
  {
    name: 'hivemind_rules_add',
 description: 'Add a team-wide rule to the shared brain. text is required, scope defaults to team.',
 inputSchema: { type: 'object', properties: { text: { type: 'string' }, scope: { type: 'string' } }, required: ['text'] },
 },
 {
 name: 'hivemind_memory_write',
 description: 'Write a memory to the shared Deeplake memory graph. handle and content required.',
 inputSchema: { type: 'object', properties: { handle: { type: 'string' }, content: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } }, required: ['handle', 'content'] },
 },
 {
 name: 'hivemind_brain_dump',
 description: 'Populate the shared brain with all local knowledge: machine specs, PM2 services, pentest tools, skills, bots, projects, operator profile.',
 inputSchema: { type: 'object', properties: {}, required: [] },
 },
 {
 name: 'hivemind_rules_add',
 description: 'Add a team-wide rule to the shared brain.',
 inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'Rule text' }, scope: { type: 'string', default: 'team' } }, required: ['text'] },
 },
 {
 name: 'hivemind_memory_write',
 description: 'Write a memory to the shared Deeplake memory graph.',
 inputSchema: { type: 'object', properties: { handle: { type: 'string' }, content: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } }, required: ['handle', 'content'] },
 },
 {
 name: 'hivemind_brain_dump',
 description: 'Populate the shared brain with all local knowledge (rules, memories, skills, tools, hackbots). One-shot setup.',
 inputSchema: { type: 'object', properties: {}, required: [] },
 },
 {
 name: 'hivemind_rules_add',
 description: 'Add a team-wide rule to the shared brain.',
 inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'Rule text' }, scope: { type: 'string', default: 'team' } }, required: ['text'] },
 },
 {
 name: 'hivemind_memory_write',
 description: 'Write a memory to the shared brain graph.',
 inputSchema: { type: 'object', properties: { handle: { type: 'string' }, content: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } }, required: ['handle', 'content'] },
 },
 {
 name: 'hivemind_brain_dump',
 description: 'Populate the shared brain with all local knowledge (rules + memories). One-shot setup.',
 inputSchema: { type: 'object', properties: {}, required: [] },
 },
 {
 name: 'hivemind_skills_mine_local',
    description: 'Mine reusable skills from local sessions WITHOUT auth. One-shot local mining. Slow (up to 120s).',
    inputSchema: { type: 'object', properties: { n: { type: 'string', description: 'Number to mine or "all"' }, dryRun: { type: 'boolean' } }, required: [] },
  },
];

rl.on('line', (line) => {
  try {
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      send({
        jsonrpc: '2.0', id: msg.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'hivemind-bridge', version: '1.0.0' },
        },
      });
    } else if (msg.method === 'notifications/initialized') {
      // no response
    } else if (msg.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
    } else if (msg.method === 'tools/call') {
      const toolName = msg.params?.name;
      const args = msg.params?.arguments || {};
      const fn = handlers[toolName];
      const result = fn ? fn(args) : `Unknown tool: ${toolName}`;
      send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: String(result) }] } });
    } else if (msg.method === 'shutdown') {
      send({ jsonrpc: '2.0', id: msg.id, result: {} });
      process.exit(0);
    } else if (msg.id) {
      send({ jsonrpc: '2.0', id: msg.id, result: {} });
    }
  } catch (e) {
    // Ignore malformed lines — keep the bridge alive.
  }
});

// Don't die on a broken pipe if the parent MCP client disconnects abruptly.
process.stdout.on('error', () => process.exit(0));