#!/usr/bin/env node
/**
 * MCP <-> Phantom IDE bridge.
 *
 * Exposes Phantom IDE's HTTP API (localhost:4000) as MCP tools so that
 * haksterAI / claude-cli / codex / any MCP consumer can use Phantom's
 * file access, shell execution, web search, AI proxy, and status endpoints.
 *
 * Tools exposed:
 *   - phantom_read_file     : Read a file (with optional line range)
 *   - phantom_write_file    : Write/create a file
 *   - phantom_edit_file     : Targeted find-and-replace edit
 *   - phantom_run_command   : Execute a shell command
 *   - phantom_search_web    : Web search
 *   - phantom_ai_chat       : Chat via Phantom's AI provider waterfall (Groq/Gemini/Ollama/etc.)
 *   - phantom_grep          : Grep pattern across files
 *   - phantom_list_files    : List directory contents
 *   - phantom_status        : Get Phantom server status
 */
'use strict';
const http = require('http');

const PHANTOM_HOST = 'localhost';
const PHANTOM_PORT = 4000;
// Phantom identifies localhost as the owner — no token needed
const OWNER_HEADERS = {
  'Content-Type': 'application/json',
  'x-phantom-terminal': '1',
  'x-owner-email': 'deezykc1nun37@yahoo.com',
};

function phantomRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { ...OWNER_HEADERS };
    if (!data) delete headers['Content-Type'];
    else headers['Content-Length'] = String(Buffer.byteLength(data));

    const req = http.request(
      { hostname: PHANTOM_HOST, port: PHANTOM_PORT, path, method, headers, timeout: 45000 },
      (res) => {
        let out = '';
        res.on('data', (d) => { out += d.toString(); });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(out) }); }
          catch (_) { resolve({ status: res.statusCode, body: { raw: out } }); }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Phantom API timeout (45s)')); });
    if (data) req.write(data);
    req.end();
  });
}

const TOOLS = [
  {
    name: 'phantom_read_file',
    description: 'Read a file from Phantom IDE (localhost:4000). Supports line ranges for large files.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Filename relative to Phantom workspace or absolute path.' },
        start: { type: 'number', description: 'Start line number (1-indexed, optional).' },
        end: { type: 'number', description: 'End line number (inclusive, optional).' },
      },
      required: ['file'],
      additionalProperties: false,
    },
  },
  {
    name: 'phantom_write_file',
    description: 'Create or overwrite a file via Phantom IDE. Wipe-protection is enforced on core files.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Filename relative to Phantom workspace or absolute path.' },
        content: { type: 'string', description: 'Full file content to write.' },
      },
      required: ['file', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'phantom_edit_file',
    description: 'Targeted find-and-replace edit in a file via Phantom IDE. old_str must be an exact unique match.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Filename relative to Phantom workspace or absolute path.' },
        old_str: { type: 'string', description: 'Exact text to replace (must be unique in file).' },
        new_str: { type: 'string', description: 'Replacement text.' },
      },
      required: ['file', 'old_str', 'new_str'],
      additionalProperties: false,
    },
  },
  {
    name: 'phantom_run_command',
    description: 'Execute a shell command via Phantom IDE (localhost:4000). Returns stdout + stderr.',
    inputSchema: {
      type: 'object',
      properties: {
        cmd: { type: 'string', description: 'Shell command to execute.' },
        cwd: { type: 'string', description: 'Working directory (defaults to /home/ghost).' },
      },
      required: ['cmd'],
      additionalProperties: false,
    },
  },
  {
    name: 'phantom_search_web',
    description: 'Search the web via Phantom IDE\'s search endpoint. Returns titles, URLs, and snippets.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query.' },
        num: { type: 'number', description: 'Number of results (default 8).' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'phantom_ai_chat',
    description: 'Send a message through Phantom\'s AI provider waterfall (Groq → Gemini → Ollama → cloud). Uses Phantom\'s free API keys — zero token cost to haksterAI.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'User message to send.' },
        system: { type: 'string', description: 'Optional system prompt override.' },
        model: { type: 'string', description: 'Optional model name (e.g. llama-3.3-70b-versatile).' },
      },
      required: ['message'],
      additionalProperties: false,
    },
  },
  {
    name: 'phantom_grep',
    description: 'Grep a pattern across files in the Phantom workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Search pattern (regex supported).' },
        dir: { type: 'string', description: 'Directory to search (defaults to /home/ghost).' },
        ext: { type: 'string', description: 'File extension filter (e.g. .js, .html).' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
  {
    name: 'phantom_list_files',
    description: 'List files and directories in the Phantom workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: 'Directory path to list (defaults to /home/ghost).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'phantom_status',
    description: 'Get Phantom IDE server status: uptime, CPU/RAM, AI providers, sessions, peer sync.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
];

function formatResult(r) {
  if (typeof r === 'string') return r;
  if (r && typeof r === 'object') {
    // Prefer human-readable fields over raw JSON
    if (r.content) return String(r.content);
    if (r.output) return String(r.output);
    if (r.stdout !== undefined) {
      const parts = [];
      if (r.stdout) parts.push(r.stdout);
      if (r.stderr) parts.push(`[stderr] ${r.stderr}`);
      if (r.exit !== undefined) parts.push(`[exit ${r.exit}]`);
      return parts.join('\n') || '(empty output)';
    }
    if (r.error) return `Error: ${r.error}`;
    if (r.ok === false) return `Error: ${r.error || 'request failed'}`;
    return JSON.stringify(r, null, 2);
  }
  return String(r);
}
// ── FABRICATION GUARD: validate tool args before execution ──
const fs = require('fs');
const path = require('path');

const KNOWN_TOOLS = new Set([
  'phantom_read_file', 'phantom_write_file', 'phantom_edit_file',
  'phantom_run_command', 'phantom_search_web', 'phantom_ai_chat',
  'phantom_grep', 'phantom_list_files', 'phantom_status',
]);

// Reject placeholder/fabricated paths
function isValidFilePath(p) {
  if (!p || typeof p !== 'string') return false;
  if (p.length < 3) return false;
  if (/^(path|file|dir|cmd|command|url|query|pattern|search|target|undefined|null)$/i.test(p)) return false;
  if (/^[a-z]$/i.test(p)) return false; // single letter
  return true;
}

// Reject placeholder/fabricated commands
function isValidCommand(cmd) {
  if (!cmd || typeof cmd !== 'string') return false;
  if (cmd.length < 2) return false;
  if (/^(cmd|command|run|shell|exec|script|undefined|null)$/i.test(cmd.trim())) return false;
  // Reject prose sentences — LLM sometimes writes natural language
  const words = cmd.trim().split(/\s+/);
  if (words.length > 8 && /\b(allow|me|execute|provide|output|this|that|will|can|the|a|an|to|for|with|using)\b/i.test(cmd)) return false;
  return true;
}

// Check if a file path exists on disk (for read operations)
function fileExists(p) {
  try { return fs.existsSync(path.resolve(p)); } catch { return false; }
}

// Validate tool call args — returns error string or null if valid
function validateToolCall(name, args) {
  if (!KNOWN_TOOLS.has(name)) return `Unknown tool: ${name}. Valid tools: ${[...KNOWN_TOOLS].join(', ')}`;
  if (!args || typeof args !== 'object') return 'Missing or invalid arguments';

  switch (name) {
    case 'phantom_read_file':
      if (!isValidFilePath(args.file)) return 'Invalid file path — must be a real path, not a placeholder';
      if (!fileExists(args.file)) return `File not found: ${args.file} — cannot read a file that doesn't exist. Do not fabricate its contents.`;
      break;
    case 'phantom_write_file':
      if (!isValidFilePath(args.file)) return 'Invalid file path';
      if (!args.content || typeof args.content !== 'string') return 'Missing file content';
      break;
    case 'phantom_edit_file':
      if (!isValidFilePath(args.file)) return 'Invalid file path';
      if (!fileExists(args.file)) return `File not found: ${args.file} — cannot edit a file that doesn't exist`;
      if (!args.old_str || typeof args.old_str !== 'string') return 'Missing old_str';
      if (!args.new_str || typeof args.new_str !== 'string') return 'Missing new_str';
      break;
    case 'phantom_run_command':
      if (!isValidCommand(args.cmd)) return 'Invalid command — must be a real shell command, not a placeholder or prose';
      break;
    case 'phantom_grep':
      if (!args.pattern || args.pattern.length < 2) return 'Pattern too short';
      break;
    case 'phantom_search_web':
      if (!args.query || args.query.length < 2) return 'Query too short';
      break;
    case 'phantom_ai_chat':
      if (!args.message || typeof args.message !== 'string') return 'Missing message';
      break;
  }
  return null; // valid
}

const rl = require('readline').createInterface({ input: process.stdin, terminal: false });

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

rl.on('line', async (line) => {
  line = line.trim();
  if (!line) return;
  let msg;
  try { msg = JSON.parse(line); } catch (_) { return; }
  if (msg.method === 'notifications/initialized') return;

  const { id, method, params } = msg;
  try {
    if (method === 'initialize') {
      send({ jsonrpc: '2.0', id, result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'phantom-mcp-bridge', version: '2.1.0' },
      }});
      return;
    }

    if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      return;
    }

    if (method === 'tools/call') {
      const { name, arguments: args } = params || {};

      // ── FABRICATION GUARD: validate before execution ──
      const validationError = validateToolCall(name, args);
      if (validationError) {
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `🚫 FABRICATION BLOCKED: ${validationError}` }] } });
        return;
      }

      let text;

      switch (name) {
        case 'phantom_read_file': {
          const body = { file: args.file };
          if (args.start) body.start = args.start;
          if (args.end) body.end = args.end;
          const r = await phantomRequest('POST', '/api/agent/read', body);
          text = formatResult(r.body);
          break;
        }
        case 'phantom_write_file': {
          const r = await phantomRequest('POST', '/api/agent/write', { file: args.file, content: args.content });
          text = formatResult(r.body);
          break;
        }
        case 'phantom_edit_file': {
          const r = await phantomRequest('POST', '/api/agent/edit', { file: args.file, old_str: args.old_str, new_str: args.new_str });
          text = formatResult(r.body);
          break;
        }
        case 'phantom_run_command': {
          const r = await phantomRequest('POST', '/api/agent/run', { cmd: args.cmd, cwd: args.cwd || '/home/ghost' });
          text = formatResult(r.body);
          break;
        }
        case 'phantom_search_web': {
          const r = await phantomRequest('POST', '/api/agent/search-web', { query: args.query, num: args.num || 8 });
          text = formatResult(r.body);
          break;
        }
        case 'phantom_ai_chat': {
          // Route through Phantom's bypass/chat endpoint — uses Phantom's own free provider keys
          const messages = [{ role: 'user', content: args.message }];
          const body = { messages, stream: false };
          if (args.system) body.system = args.system;
          if (args.model) body.model = args.model;
          const r = await phantomRequest('POST', '/api/bypass/chat', body);
          const resp = r.body;
          // bypass/chat returns different shapes depending on provider
          if (resp && resp.choices) {
            text = resp.choices[0]?.message?.content || JSON.stringify(resp, null, 2);
          } else if (resp && resp.content) {
            text = Array.isArray(resp.content) ? resp.content.map(c => c.text || '').join('') : String(resp.content);
          } else {
            text = formatResult(resp);
          }
          break;
        }
        case 'phantom_grep': {
          const r = await phantomRequest('POST', '/api/agent/grep', {
            pattern: args.pattern,
            dir: args.dir || '/home/ghost',
            ext: args.ext || '',
          });
          text = formatResult(r.body);
          break;
        }
        case 'phantom_list_files': {
          const r = await phantomRequest('POST', '/api/agent/list', { dir: args.dir || '/home/ghost' });
          text = formatResult(r.body);
          break;
        }
        case 'phantom_status': {
          const r = await phantomRequest('GET', '/api/status/full');
          text = formatResult(r.body);
          break;
        }
        default:
          send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${name}` } });
          return;
      }

      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(text) }] } });
      return;
    }

    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method: ${method}` } });
  } catch (e) {
    send({ jsonrpc: '2.0', id, error: { code: -32000, message: e.message } });
  }
});

process.stdin.resume();
