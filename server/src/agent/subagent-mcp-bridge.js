#!/usr/bin/env node
/**
 * MCP<->sub-agent bridge.
 *
 * Exposes Hakster's existing free-tier sub-agent dispatcher (server/src/subagent.js
 * — spawnSubAgent()) as an MCP tool, so claude-cli (which only sees MCP tools,
 * not Hakster's own AGENT_TOOLS dispatcher) can delegate focused sub-tasks to
 * the same free waterfall providers (groq/sambanova/gemini/cerebras/...) the
 * rest of Hakster uses — conserving the Claude Pro/Max budget for the parts
 * that actually need it, and giving the "bot fleet" a role beyond notifications.
 *
 * Roles are just named provider presets — pick whichever fits the sub-task.
 */
const path = require('path');
const { spawnSubAgent } = require(path.join(__dirname, '..', 'subagent.js'));

// Cerebras is deliberately excluded — it's blocked elsewhere in this codebase
// (see isCerebrasValue() in server/src/index.js) and confirmed 404ing here too.
const ROLES = {
  coder: { provider: 'groq', model: 'llama-3.3-70b-versatile' },
  recon: { provider: 'gemini', model: 'gemini-2.5-flash' },
  debugger: { provider: 'sambanova', model: 'Meta-Llama-3.3-70B-Instruct' },
  general: { provider: 'groq', model: 'llama-3.3-70b-versatile' },
};

const TOOLS = [{
  name: 'dispatch_subagent',
  description: 'Delegate a focused, self-contained sub-task to a free-tier sub-agent instead of doing it yourself — saves Claude Pro/Max budget for work that needs it. The sub-agent has real file/shell tool access on this machine but no memory of this conversation, so give it a complete, standalone task description. Good for: grunt-work code generation, log/recon scanning, repetitive debugging checks. Max 3 turns internally, so keep the task narrow.',
  inputSchema: {
    type: 'object',
    properties: {
      role: { type: 'string', enum: Object.keys(ROLES), description: 'coder (groq, fast code gen), recon (gemini, broad scanning/summarizing), debugger (sambanova), general (cerebras, catch-all)' },
      task: { type: 'string', description: 'Complete, self-contained task description — the sub-agent has no other context.' },
      cwd: { type: 'string', description: 'Working directory for the sub-agent (defaults to the current project).' },
    },
    required: ['role', 'task'],
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
        serverInfo: { name: 'subagent-mcp-bridge', version: '1.0.0' },
      }});
    } else if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    } else if (method === 'tools/call') {
      const { name, arguments: args } = params || {};
      if (name !== 'dispatch_subagent') {
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${name}` } });
        return;
      }
      const { role, task, cwd } = args || {};
      const preset = ROLES[role] || ROLES.general;
      const text = await spawnSubAgent(task, cwd || process.cwd(), preset.provider, preset.model);
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `[${role || 'general'}/${preset.provider}] ${text}` }] } });
    } else {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method: ${method}` } });
    }
  } catch (e) {
    send({ jsonrpc: '2.0', id, error: { code: -32000, message: e.message } });
  }
});

process.stdin.resume();
