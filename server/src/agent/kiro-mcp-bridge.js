#!/usr/bin/env node
/**
 * MCP<->Kiro bridge (ACTIVE).
 * Uses the same headless auth approach as the CineVault kiro-wrapper:
 *   BROWSER=none, NO_OPEN_BROWSER=1, DISPLAY= to suppress browser
 *   kiro-cli login --use-device-flow for headless auth
 * Spawns kiro-cli chat non-interactively with a prompt.
 */
const { spawn, spawnSync } = require('child_process');
const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin, terminal: false });

// Headless env — same as cine-vault-live/container/local-bin/kiro-wrapper
const HEADLESS_ENV = {
  ...process.env,
  BROWSER: 'none',
  NO_OPEN_BROWSER: '1',
  DISPLAY: '',
};

// Find kiro binary
function findKiroBin() {
  const candidates = [
    process.env.KIRO_BIN,
    '/home/ghost/cine-vault-live/container/local-bin/kiro-wrapper',
    '/usr/bin/kiro-cli',
  ].filter(Boolean);
  const { execSync } = require('child_process');
  for (const c of candidates) {
    try {
      execSync(`test -x "${c}"`, { stdio: 'ignore' });
      return c;
    } catch {}
  }
  // fallback to PATH lookup
  try {
    const p = execSync('command -v kiro-cli 2>/dev/null || command -v kiro 2>/dev/null', { stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim();
    if (p) return p;
  } catch {}
  return null;
}

const KIRO_BIN = findKiroBin();

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function checkAuth() {
  if (!KIRO_BIN) return { ok: false, error: 'kiro-cli binary not found' };
  try {
    const result = spawnSync(KIRO_BIN, ['whoami'], {
      env: HEADLESS_ENV,
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out = (result.stdout?.toString() || '') + (result.stderr?.toString() || '');
    if (out.match(/not signed|error|unauthorized|401|403/i)) {
      return { ok: false, needLogin: true };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function doLogin() {
  try {
    const result = spawnSync(KIRO_BIN, ['login', '--use-device-flow'], {
      env: HEADLESS_ENV,
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out = (result.stdout?.toString() || '') + (result.stderr?.toString() || '');
    return result.status === 0;
  } catch (e) {
    return false;
  }
}

function callKiro(prompt) {
  return new Promise((resolve) => {
    if (!KIRO_BIN) {
      resolve({ content: [{ type: 'text', text: 'Error: kiro-cli binary not found. Install kiro-cli or set KIRO_BIN env var.' }] });
      return;
    }

    // Check auth first
    const auth = checkAuth();
    if (!auth.ok && auth.needLogin) {
      const loggedIn = doLogin();
      if (!loggedIn) {
        resolve({ content: [{ type: 'text', text: 'Error: kiro-cli not authenticated and device-flow login failed. Run `kiro-cli login --use-device-flow` manually.' }] });
        return;
      }
    } else if (!auth.ok) {
      resolve({ content: [{ type: 'text', text: `Error: kiro-cli auth check failed: ${auth.error}` }] });
      return;
    }

    // Spawn kiro-cli chat with the prompt
    const args = ['chat', '-p', prompt];
    const child = spawn(KIRO_BIN, args, {
      env: HEADLESS_ENV,
      timeout: 120000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (e) => {
      resolve({ content: [{ type: 'text', text: `Error spawning kiro-cli: ${e.message}` }] });
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ content: [{ type: 'text', text: stdout.trim() || '(empty response)' }] });
      } else {
        const err = stderr.trim() || stdout.trim() || `kiro-cli exited with code ${code}`;
        resolve({ content: [{ type: 'text', text: `kiro error (exit ${code}): ${err}` }] });
      }
    });
  });
}

const TOOLS = [
  {
    name: 'kiro',
    description: 'Delegate a prompt to Kiro CLI (one-shot, non-interactive). Give it a "prompt" and set "trustAllTools" to true if it needs to act, not just advise. Uses headless device-flow auth (same as CineVault kiro-wrapper). May fail if over quota.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The prompt to send to Kiro CLI' },
        trustAllTools: { type: 'boolean', description: 'Allow Kiro to use all tools without confirmation', default: false },
      },
      required: ['prompt'],
    },
  },
];

rl.on('line', (line) => {
  try {
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'kiro-bridge', version: '3.1.0' },
        },
      });
    } else if (msg.method === 'notifications/initialized') {
      // no response needed
    } else if (msg.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
    } else if (msg.method === 'tools/call') {
      const toolName = msg.params?.name;
      const args = msg.params?.arguments || {};
      if (toolName === 'kiro') {
        callKiro(args.prompt).then((result) => {
          send({ jsonrpc: '2.0', id: msg.id, result });
        });
      } else {
        send({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32601, message: `Unknown tool: ${toolName}` },
        });
      }
    } else if (msg.method === 'shutdown') {
      send({ jsonrpc: '2.0', id: msg.id, result: {} });
      process.exit(0);
    } else if (msg.id) {
      send({ jsonrpc: '2.0', id: msg.id, result: {} });
    }
  } catch (e) {
    // Ignore malformed lines
  }
});