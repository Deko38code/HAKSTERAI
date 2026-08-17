#!/usr/bin/env node
const path = require('path');
const readline = require('readline');
const { spawnSubAgent } = require(path.join(__dirname, '..', 'subagent.js'));

const ROLES = {
  coder: 'groq',
  recon: 'groq',
  debugger: 'ollama',
  general: 'ollama',
};

// Provider waterfall - try each until one works
const PROVIDER_FALLBACK = ['ollama', 'groq', 'gemini'];

async function dispatchSubAgent(role, task, cwd) {
  const primary = ROLES[role] || 'ollama';
  const providers = [primary, ...PROVIDER_FALLBACK.filter(p => p !== primary)];
  for (const provider of providers) {
    try {
      const result = await spawnSubAgent(task, cwd || process.cwd(), provider);
      if (result && !result.startsWith('Error:')) {
        return { provider, result };
      }
    } catch (e) { /* try next */ }
  }
  return { provider: 'none', result: 'Error: All providers failed for sub-agent task' };
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
let inputBuffer = '';
rl.on('line', (line) => { inputBuffer += line + '\n'; });
rl.on('close', async () => {
  try {
    const msg = JSON.parse(inputBuffer);
    if (msg.method === 'initialize') {
      console.log(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'subagent-bridge', version: '1.0.0' } } }));
      return;
    }
    if (msg.method === 'tools/list') {
      console.log(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'dispatch_subagent', description: 'Delegate a focused sub-task to a free-tier sub-agent. Roles: coder, recon, debugger, general.', inputSchema: { type: 'object', properties: { role: { type: 'string', enum: ['coder', 'recon', 'debugger', 'general'], description: 'Sub-agent role' }, task: { type: 'string', description: 'The task to perform' }, cwd: { type: 'string', description: 'Working directory' } }, required: ['role', 'task'] } }] } }));
      return;
    }
    if (msg.method === 'tools/call') {
      const args = msg.params?.arguments || {};
      const { provider, result } = await dispatchSubAgent(args.role || 'general', args.task || '', args.cwd);
      console.log(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `[${provider}] ${result}` }] } }));
      return;
    }
    console.log(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }));
  } catch (e) {
    console.log(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: e.message } }));
  }
});
