#!/usr/bin/env node
/**
 * MCP <-> Phantom IDE bridge.
 *
 * Exposes Phantom IDE's HTTP API (localhost:4000) as MCP tools so that
 * claude-cli / codex / any MCP consumer can use Phantom's file access,
 * shell execution, web search, and status endpoints.
 *
 * Tools exposed:
 *   - phantom_read_file    : Read a file via Phantom's API
 *   - phantom_run_command  : Execute a shell command via Phantom's API
 *   - phantom_search_web    : Web search via Phantom's API
 *   - phantom_status        : Get Phantom server status
 */
const http = require('http');

const PHANTOM_HOST = 'localhost';
const PHANTOM_PORT = 4000;

function phantomRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: PHANTOM_HOST,
      port: PHANTOM_PORT,
      path,
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      timeout: 30000,
    };
    if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);

    const req = http.request(opts, (res) => {
      let out = '';
      res.on('data', (d) => { out += d.toString(); });
      res.on('end', () => {
        try { resolve(JSON.parse(out)); }
      catch (_) { resolve({ raw: out }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Phantom API timeout (30s)')); });
    if (data) req.write(data);
    req.end();
  });
}

const TOOLS = [
  {
    name: 'phantom_read_file',
    description: 'Read a file from the local filesystem via Phantom IDE (localhost:4000). Returns file contents.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or relative path to the file.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'phantom_run_command',
    description: 'Execute a shell command via Phantom IDE (localhost:4000). Returns stdout+stderr.',
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
    description: 'Search the web via Phantom IDE (localhost:4000). Returns search results.',
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
    name: 'phantom_status',
    description: 'Get Phantom IDE server status (uptime, CPU, memory, providers, sessions).',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
];

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
        serverInfo: { name: 'phantom-mcp-bridge', version: '1.0.0' },
      }});
    } else if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    } else if (method === 'tools/call') {
      const { name, arguments: args } = params || {};
      let text;

      if (name === 'phantom_read_file') {
        const res = await phantomRequest('POST', '/api/agent/read-file', { path: args.path });
        text = typeof res === 'string' ? res : (res.content || res.raw || JSON.stringify(res, null, 2));
      } else if (name === 'phantom_run_command') {
        const res = await phantomRequest('POST', '/api/agent/run', { cmd: args.cmd, cwd: args.cwd || '/home/ghost' });
        text = typeof res === 'string' ? res : (res.output || res.stdout || res.raw || JSON.stringify(res, null, 2));
      } else if (name === 'phantom_search_web') {
        const res = await phantomRequest('POST', '/api/agent/search-web', { query: args.query, num: args.num || 8 });
        text = JSON.stringify(res, null, 2);
      } else if (name === 'phantom_status') {
        const res = await phantomRequest('GET', '/api/status/full');
        text = JSON.stringify(res, null, 2);
      } else {
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${name}` } });
        return;
      }

      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
    } else {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method: ${method}` } });
    }
  } catch (e) {
    send({ jsonrpc: '2.0', id, error: { code: -32000, message: e.message } });
  }
});

process.stdin.resume();