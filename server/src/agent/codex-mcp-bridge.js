#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const readline = require('readline');

const CODEX = '/home/ghost/.local/bin/codex';
const WORKSPACE = '/home/ghost/haksterAi';
const MAX_PROMPT_CHARS = 12000;
const TIMEOUT_MS = 120000;
let active = false;

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function rpcError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

function runCodex(prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn(CODEX, [
      'exec', '--ephemeral', '--sandbox', 'read-only', '--json',
      '--skip-git-repo-check', '--cd', WORKSPACE, '-'
    ], {
      cwd: WORKSPACE,
      env: { ...process.env, HOME: '/home/ghost' },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let stdout = '';
    let finalText = '';
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err); else resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(new Error('Codex response timed out after 120 seconds.'));
    }, TIMEOUT_MS);
    child.on('error', () => finish(new Error('Could not start the authenticated Codex CLI.')));
    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
      if (stdout.length > 2_000_000) {
        child.kill('SIGTERM');
        finish(new Error('Codex response exceeded the 2 MB output limit.'));
        return;
      }
      let newline;
      while ((newline = stdout.indexOf('\n')) !== -1) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (!line) continue;
        let event;
        try { event = JSON.parse(line); } catch (_) { continue; }
        if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
          finalText = event.item.text || finalText;
        } else if (event.type === 'item.completed' && event.item?.type === 'error') {
          finalText = event.item.message || finalText;
        }
      }
    });
    child.on('close', code => {
      if (code !== 0) return finish(new Error(`Codex exited with status ${code ?? 'unknown'}.`));
      if (!finalText) return finish(new Error('Codex completed without a text response.'));
      finish(null, finalText.slice(0, 24000));
    });
    child.stdin.end(prompt);
  });
}

const tool = {
  name: 'codex_readonly',
  description: 'Ask the authenticated local Codex CLI to analyze or summarize the HaksterAI workspace. Read-only sandbox; Codex cannot edit files or run write commands.',
  inputSchema: {
    type: 'object',
    properties: { prompt: { type: 'string', description: 'Analysis or curation request for Codex' } },
    required: ['prompt'],
  },
};

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', async line => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); }
  catch (_) { return; }
  if (msg.id === undefined || msg.id === null) return;
  if (msg.method === 'initialize') {
    reply(msg.id, {
      protocolVersion: '2024-11-05', capabilities: { tools: {} },
      serverInfo: { name: 'haksterai-codex-readonly', version: '1.0.0' },
    });
    return;
  }
  if (msg.method === 'tools/list') {
    reply(msg.id, { tools: [tool] });
    return;
  }
  if (msg.method !== 'tools/call') {
    reply(msg.id, {});
    return;
  }
  const prompt = String(msg.params?.arguments?.prompt || '').trim();
  if (!prompt) return rpcError(msg.id, -32602, 'prompt is required');
  if (prompt.length > MAX_PROMPT_CHARS) return rpcError(msg.id, -32602, `prompt exceeds ${MAX_PROMPT_CHARS} characters`);
  if (active) return rpcError(msg.id, -32002, 'Codex is already handling a request');
  active = true;
  try {
    const text = await runCodex(prompt);
    reply(msg.id, { content: [{ type: 'text', text }] });
  } catch (error) {
    reply(msg.id, { isError: true, content: [{ type: 'text', text: error.message }] });
  } finally {
    active = false;
  }
});
