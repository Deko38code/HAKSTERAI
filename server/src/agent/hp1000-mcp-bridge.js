#!/usr/bin/env node
/**
 * MCP <-> hp-1000 model bridge.
 *
 * Exposes the local Ollama hp-1000:latest model as an MCP tool so that
 * claude-cli / codex / any MCP consumer can delegate one-shot prompts
 * to it — useful as a free local fallback for grunt-work tasks.
 *
 * Uses Ollama's HTTP API (default localhost:11434) with streaming disabled.
 */
const http = require('http');

const OLLAMA_HOST = 'localhost';
const OLLAMA_PORT = 11434;
const MODEL = 'hp-1000:latest';

function ollamaChat(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: MODEL,
      prompt,
      stream: false,
      options: { temperature: 0.7 },
    });
    const opts = {
      hostname: OLLAMA_HOST,
      port: OLLAMA_PORT,
      path: '/api/generate',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 120000,
    };

    const req = http.request(opts, (res) => {
      let out = '';
      res.on('data', (d) => { out += d.toString(); });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(out);
          resolve(parsed.response || parsed.message?.content || out);
        } catch (_) {
          resolve(out || '(no output)');
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Ollama timeout (120s) — model may still be loading')); });
    req.write(body);
    req.end();
  });
}

const TOOLS = [{
  name: 'hp1000',
  description: `Run a one-shot prompt against the local Ollama ${MODEL} model. Free, local, no API key needed. Good for: code generation, text tasks, quick analysis. The model has no memory of this conversation — give it a complete, self-contained prompt.`,
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'Complete, self-contained prompt for the model.' },
    },
    required: ['prompt'],
    additionalProperties: false,
  },
}];

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
        serverInfo: { name: 'hp1000-mcp-bridge', version: '1.0.0' },
      }});
    } else if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    } else if (method === 'tools/call') {
      const { name, arguments: args } = params || {};
      if (name !== 'hp1000') {
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${name}` } });
        return;
      }
      const text = await ollamaChat(args.prompt);
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
    } else {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method: ${method}` } });
    }
  } catch (e) {
    send({ jsonrpc: '2.0', id, error: { code: -32000, message: e.message } });
  }
});

process.stdin.resume();