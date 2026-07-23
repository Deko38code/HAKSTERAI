#!/usr/bin/env node
/**
 * MCP<->Kiro bridge.
 *
 * kiro-cli has no MCP serve mode (only `mcp` for consuming other servers, and
 * `acp` which speaks the Agent Client Protocol — a different, incompatible
 * wire protocol from MCP). Rather than implement a full ACP client, this
 * bridges the simple way: expose ONE MCP tool ("kiro") that shells out to
 * `kiro-cli chat --no-interactive <prompt>` and relays the text output back.
 * Same shape as the real `codex` MCP tool (single prompt-in, text-out call).
 */
const { spawn } = require('child_process');
const readline = require('readline');

const KIRO_BIN = 'kiro-cli';

// Strip ANSI escape codes / cursor control sequences — kiro-cli's output is
// styled for a terminal, not for an LLM tool result.
function stripAnsi(s) {
  return s
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .trim();
}

function runKiro({ prompt, agent, trustAllTools }) {
  return new Promise((resolve) => {
    const args = ['chat', '--no-interactive'];
    if (agent) args.push('--agent', agent);
    if (trustAllTools) args.push('--trust-all-tools');
    args.push(prompt);

    const child = spawn(KIRO_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve(`[kiro-bridge] timed out after 180s. Partial output:\n${stripAnsi(out || err)}`);
    }, 180000);

    child.on('close', () => {
      clearTimeout(timer);
      const text = stripAnsi(out) || stripAnsi(err) || '(no output)';
      resolve(text);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve(`[kiro-bridge] failed to spawn kiro-cli: ${e.message}`);
    });
  });
}

// ── Minimal MCP server over stdio ───────────────────────────────────────
const TOOLS = [{
  name: 'kiro',
  description: 'Run a one-shot, non-interactive Kiro CLI session. Give it a self-contained prompt (it has no memory of this conversation). Real tool access (fs/shell) on the local machine if trustAllTools is set.',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'The task/question to give Kiro.' },
      agent: { type: 'string', description: 'Optional Kiro agent/context profile name.' },
      trustAllTools: { type: 'boolean', description: 'Auto-approve all tool permission requests (equivalent to kiro-cli --trust-all-tools). Off by default.' },
    },
    required: ['prompt'],
    additionalProperties: false,
  },
}];

const rl = readline.createInterface({ input: process.stdin, terminal: false });

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

rl.on('line', async (line) => {
  line = line.trim();
  if (!line) return;
  let msg;
  try { msg = JSON.parse(line); } catch (_) { return; }
  if (msg.method === 'notifications/initialized') return; // no response expected

  const { id, method, params } = msg;
  try {
    if (method === 'initialize') {
      send({ jsonrpc: '2.0', id, result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'kiro-mcp-bridge', version: '1.0.0' },
      }});
    } else if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    } else if (method === 'tools/call') {
      const { name, arguments: args } = params || {};
      if (name !== 'kiro') {
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${name}` } });
        return;
      }
      const text = await runKiro(args || {});
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
    } else {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method: ${method}` } });
    }
  } catch (e) {
    send({ jsonrpc: '2.0', id, error: { code: -32000, message: e.message } });
  }
});

process.stdin.resume();
