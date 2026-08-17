#!/usr/bin/env node
/**
 * MCP<->Kiro bridge.
 * kiro-cli chat opens a browser GUI which hangs headless environments.
 * Bridge tries kiro-cli with 5s timeout, falls back to Ollama sub-agent.
 */
const { spawn } = require('child_process');
const readline = require('readline');
const path = require('path');

const KIRO_BIN = 'kiro-cli';

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/\r/g, '');
}

function tryKiroCli(prompt) {
  return new Promise((resolve) => {
    let output = '';
    let timedOut = false;
    const child = spawn(KIRO_BIN, ['chat', '--no-interactive', prompt], {
      env: { ...process.env, HEADLESS: '1', DISABLE_BROWSER: '1', TERM: 'dumb', BROWSER: 'none' },
      timeout: 5000,
    });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 5000);
    child.stdout.on('data', (d) => { output += stripAnsi(d.toString()); });
    child.stderr.on('data', (d) => { output += stripAnsi(d.toString()); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut || code !== 0 || !output.trim()) resolve(null);
      else resolve(output.trim());
    });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
  });
}

async function tryOllamaFallback(prompt) {
  try {
    const { spawnSubAgent } = require(path.join(__dirname, '..', 'subagent.js'));
    const result = await spawnSubAgent(prompt, process.cwd(), 'ollama');
    return result && !result.startsWith('Error:') ? result : null;
  } catch { return null; }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
let inputBuffer = '';
rl.on('line', (line) => { inputBuffer += line + '\n'; });
rl.on('close', async () => {
  try {
    const msg = JSON.parse(inputBuffer);
    if (msg.method === 'initialize') {
      console.log(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'kiro-bridge', version: '1.0.0' } } }));
      return;
    }
    if (msg.method === 'tools/list') {
      console.log(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'kiro', description: 'Run a one-shot Kiro CLI session. Falls back to Ollama if Kiro browser-launch is unavailable.', inputSchema: { type: 'object', properties: { prompt: { type: 'string', description: 'The task/prompt for Kiro' }, agent: { type: 'string' }, trustAllTools: { type: 'boolean' } }, required: ['prompt'] } }] } }));
      return;
    }
    if (msg.method === 'tools/call') {
      const args = msg.params?.arguments || {};
      // Try kiro-cli with short timeout (5s), fall back to ollama
      let result = await tryKiroCli(args.prompt || '');
      if (!result) result = await tryOllamaFallback(args.prompt || '');
      if (!result) result = 'Error: Both Kiro CLI and Ollama fallback failed.';
      console.log(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: result }] } }));
      return;
    }
    console.log(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }));
  } catch (e) {
    console.log(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: e.message } }));
  }
});
