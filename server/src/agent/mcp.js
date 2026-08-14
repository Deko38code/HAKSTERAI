/**
 * MCP (Model Context Protocol) Client for haksterAI
 * Dynamically discovers tools from MCP servers via stdio JSON-RPC
 * and integrates them into the agent's tool system.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// ── MCP Server Registry ─────────────────────────────────────────────────
const mcpServers = new Map(); // serverName → { config, child, tools, requestId, buffer, pending }

let _logFn = () => {};
let _statusFn = () => {};

function setLogFn(fn) { _logFn = fn || (() => {}); }
function setStatusFn(fn) { _statusFn = fn || (() => {}); }

// ── JSON-RPC helpers ─────────────────────────────────────────────────────
let _nextId = 1;

function makeId() {
  return _nextId++;
}

function jsonRpcRequest(method, params, id) {
  const msg = { jsonrpc: '2.0', method, params: params || {}, id };
  return JSON.stringify(msg);
}

/**
 * Send a JSON-RPC request to an MCP server and wait for the response.
 */
function sendRequest(serverName, method, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    const server = mcpServers.get(serverName);
    if (!server || !server.child || server.child.stdin.destroyed) {
      return reject(new Error(`MCP server "${serverName}" not connected`));
    }

    const id = makeId();
    const msg = jsonRpcRequest(method, params, id);

    const timer = setTimeout(() => {
      server.pending.delete(id);
      reject(new Error(`MCP call to ${serverName}::${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    server.pending.set(id, { resolve, reject, timer });

    // Handle EPIPE — child process may have exited during the startup delay
    const onError = (err) => {
      clearTimeout(timer);
      server.pending.delete(id);
      reject(new Error(`Failed to write to MCP server "${serverName}": ${err.message}`));
    };

    server.child.stdin.once('error', onError);

    try {
      server.child.stdin.write(msg + '\n', () => {
        server.child.stdin.removeListener('error', onError);
      });
    } catch (err) {
      clearTimeout(timer);
      server.pending.delete(id);
      server.child.stdin.removeListener('error', onError);
      reject(new Error(`Failed to write to MCP server "${serverName}": ${err.message}`));
    }
  });
}

/**
 * Parse data from MCP server stdout — handles partial lines and multiple messages.
 */
function handleServerData(serverName, data) {
  const server = mcpServers.get(serverName);
  if (!server) return;

  server.buffer += data.toString();

  // Process complete lines (JSON-RPC messages are newline-delimited)
  let newlineIdx;
  while ((newlineIdx = server.buffer.indexOf('\n')) !== -1) {
    const line = server.buffer.substring(0, newlineIdx).trim();
    server.buffer = server.buffer.substring(newlineIdx + 1);

    if (!line) continue;

    let msg;
    try {
      msg = JSON.parse(line);
    } catch (_) {
      // Not JSON — could be a log message from the server, ignore
      continue;
    }

    // Handle response
    if (msg.id != null && server.pending.has(msg.id)) {
      const { resolve, reject, timer } = server.pending.get(msg.id);
      clearTimeout(timer);
      server.pending.delete(msg.id);
      if (msg.error) {
        reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      } else {
        resolve(msg.result);
      }
    }
    // Handle notification (no id, or id we don't track)
    else if (msg.method && !msg.id) {
      // MCP notifications — we can log them but don't need to act
      _logFn(`  [MCP:${serverName}] notification: ${msg.method}`);
    }
  }
}

/**
 * Spawn an MCP server process and connect via stdio.
 */
// Each box here is single-operator. MCP child processes (claude, uvx/serena, ...) read
// per-user config from $HOME, but hakster is sometimes launched as root — which points them
// at /root instead of the real operator's config/credentials (e.g. claude-code auth). Pin HOME
// so MCP servers always resolve to the operator's config no matter which user started the
// parent process, without hardcoding a path that only exists on one machine.
function resolveGhostHome() {
  if (process.env.HAKSTER_HOME) return process.env.HAKSTER_HOME;
  if (process.getuid && process.getuid() === 0) {
    if (process.env.SUDO_USER) {
      try {
        const { execFileSync } = require('child_process');
        const home = execFileSync('getent', ['passwd', process.env.SUDO_USER]).toString().trim().split(':')[5];
        if (home) return home;
      } catch { /* getent unavailable or user not found — fall through */ }
    }
    // Single-operator box: exactly one non-root home dir under /home.
    try {
      const users = fs.readdirSync('/home').filter((u) => u !== 'lost+found');
      if (users.length === 1) return path.join('/home', users[0]);
    } catch { /* /home unreadable — fall through */ }
  }
  return require('os').homedir();
}
const GHOST_HOME = resolveGhostHome();

function connectServer(serverName, config) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...(config.env || {}) };
    env.HOME = GHOST_HOME;
    // Ensure bun is in PATH for MCP servers that need it
    if (!env.PATH?.includes('/root/.bun/bin')) {
      env.PATH = `/root/.bun/bin:${env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'}`;
    }
    // Ensure ~/.local/bin is in PATH — uv/uvx (serena and friends) install there,
    // and it's not always on the parent process's PATH depending on how the server was launched.
    const localBin = path.join(GHOST_HOME, '.local', 'bin');
    if (!env.PATH?.includes(localBin)) {
      env.PATH = `${localBin}:${env.PATH}`;
    }

    const child = spawn(config.command, config.args || [], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: '/tmp',  // Run from /tmp to avoid project .npmrc issues
      // Don't detach — we want the child to die when the parent dies
    });

    // Prevent EPIPE crashes — swallow stdin errors when child exits
    child.stdin.on('error', () => {});
    child.stdout.on('error', () => {});
    child.stderr.on('error', () => {});

    const server = {
      name: serverName,
      config,
      child,
      tools: [],
      buffer: '',
      pending: new Map(),
      initialized: false,
    };

    mcpServers.set(serverName, server);

    child.stdout.on('data', (data) => handleServerData(serverName, data));

    child.stderr.on('data', (data) => {
      // Log stderr but filter out npm prefix noise and npx cache spam
      const lines = data.toString().trim();
      if (!lines) return;
      const filtered = lines.split('\n')
        .filter(l => !l.includes('config prefix cannot be changed') && !l.includes('npm error config prefix'))
        .join('\n');
      if (filtered) _logFn(`  [MCP:${serverName}] stderr: ${filtered.substring(0, 200)}`);
    });

    child.on('error', (err) => {
      _logFn(`  [MCP:${serverName}] process error: ${err.message}`);
      mcpServers.delete(serverName);
    });

    child.on('close', (code) => {
      _logFn(`  [MCP:${serverName}] process exited with code ${code}`);
      // Reject any pending requests
      for (const [id, { reject: rej, timer }] of server.pending) {
        clearTimeout(timer);
        rej(new Error(`MCP server "${serverName}" exited`));
      }
      server.pending.clear();
      mcpServers.delete(serverName);

      // Auto-retry heavy servers killed by OOM (code null = signal death).
      // Serena is the heaviest (~300MB with TypeScript LSP) and most likely to
      // get OOM-killed when all 15 MCP servers spawn simultaneously on a 7GB box.
      // Retry once after a 5s delay to let memory settle, with a flag to prevent
      // infinite retry loops.
      if (code === null && !server._retried && serverName === 'serena') {
        server._retried = true;
        _logFn(`  [MCP:${serverName}] likely OOM-killed — retrying in 5s...`);
        setTimeout(() => {
          try {
            connectServer(serverName, config)
              .then(() => _logFn(`  [MCP:${serverName}] retry succeeded`))
              .catch(err => _logFn(`  [MCP:${serverName}] retry failed: ${err.message}`));
          } catch (err) {
            _logFn(`  [MCP:${serverName}] retry error: ${err.message}`);
          }
        }, 5000);
      }
    });

    // Initialize the server (with startup delay for npx to finish installing)
    (async () => {
      try {
        // npx-based servers need time to download/install before they listen on stdin
        // Give npx-based servers time to download/install on first run
        // Direct binaries start instantly — no delay needed
        const isNpx = config.command === 'npx' || config.command === 'npx.cmd';
        const isBun = config.command.endsWith('bun') || config.command.endsWith('/bun');
        const isUvx = config.command === 'uvx' || config.command === 'uv' || config.command.endsWith('/uvx') || config.command.endsWith('/uv');
        if (isNpx) {
          const pkgName = config.args && config.args.length > 1 ? config.args[1] : '';
          _logFn(`  [MCP:${serverName}] npx starting${pkgName ? ` ${pkgName}` : ''}...`);
          await new Promise(r => setTimeout(r, 8000)); // 8s for npx package resolution
        } else if (isBun) {
          _logFn(`  [MCP:${serverName}] bun starting...`);
          await new Promise(r => setTimeout(r, 2000)); // 2s for bun to warm up
        }

        // uv/uvx-launched servers (e.g. Serena) don't just resolve a package — they can also
        // spin up a language server + dashboard on top, which is slower and more load-sensitive
        // than the other MCP servers. Give them extra headroom so a busy box doesn't false-fail them.
        // Per-server override via config.initTimeoutMs takes priority over all heuristics.
        const initTimeoutMs = config.initTimeoutMs
          ? parseInt(config.initTimeoutMs, 10)
          : (isUvx ? 120000 : 120000); // 120s default — heavy Python servers (hermes, serena) need it on slower boxes

        // Step 1: Send "initialize" request
        const initResult = await sendRequest(serverName, 'initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: {
            name: 'haksterAI',
            version: '2.1.0',
          },
        }, initTimeoutMs); // 60s default, 120s for uv/uvx-launched servers under load

        _logFn(`  [MCP:${serverName}] initialized — protocol: ${initResult?.protocolVersion}, server: ${initResult?.serverInfo?.name || serverName}`);

        // Step 2: Send "initialized" notification
        const initNotif = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' });
        child.stdin.write(initNotif + '\n');

        // Step 3: Call "tools/list" to discover tools
        const toolsResult = await sendRequest(serverName, 'tools/list', {}, 15000);

        const mcpTools = (toolsResult?.tools || []).map((tool) => ({
          name: tool.name,
          description: tool.description || '',
          inputSchema: tool.inputSchema || { type: 'object', properties: {} },
        }));

        server.tools = mcpTools;
        server.initialized = true;

        _logFn(`  [MCP:${serverName}] discovered ${mcpTools.length} tool(s): ${mcpTools.map(t => t.name).join(', ')}`);
        resolve();
      } catch (err) {
        _logFn(`  [MCP:${serverName}] initialization failed: ${err.message}`);
        // Clean up
        try { child.kill('SIGTERM'); } catch (_) {}
        mcpServers.delete(serverName);
        reject(err);
      }
    })();
  });
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Load MCP servers from config dirs, spawn them, discover tools.
 * Called at startup and on /mcp reload.
 * @param {string[]} configDirs — directories to look for .hakster/mcp.json
 * @returns {Promise<{tools: Array, servers: Array}>} — discovered tools and server info
 */
async function loadMcpServers(configDirs) {
  // First, shut down any existing servers
  for (const [name, server] of mcpServers) {
    try {
      if (server.child && !server.child.killed) {
        server.child.kill('SIGTERM');
      }
    } catch (_) {}
  }
  mcpServers.clear();

  // Collect unique mcp.json paths
  const seenConfigs = new Set();
  const configs = [];

  for (const dir of configDirs) {
    const configPath = path.join(dir, 'mcp.json');
    if (seenConfigs.has(configPath)) continue;
    seenConfigs.add(configPath);

    try {
      const raw = fs.readFileSync(configPath, 'utf-8');
      const json = JSON.parse(raw);
      const servers = json.mcpServers || {};
      for (const [name, cfg] of Object.entries(servers)) {
        configs.push({ name, config: cfg });
      }
    } catch (_) {
      // mcp.json doesn't exist or is invalid — skip silently
    }
  }

  if (configs.length === 0) {
    _logFn('  [MCP] No MCP servers configured');
    return { tools: [], servers: [] };
  }

  // Connect to all servers in parallel (with individual error handling).
  // Staggered by 250ms per server — spawning 10 interpreters (node/python/uv)
  // at the exact same instant creates a CPU/IO spike that's cheap to avoid and
  // gets worse when a heavy local Ollama model is also running on the same box.
  //
  // Heavy servers (serena) get extra delay — they spawn Python + a TypeScript
  // language server + web dashboard (~300MB) and are prone to OOM kills when
  // all 15 servers fire at once on a 7GB box. Spawning serena last gives the
  // lighter servers time to settle first.
  const HEAVY_SERVERS = new Set(['serena']);
  const sortedConfigs = [...configs].sort((a, b) => {
    const aH = HEAVY_SERVERS.has(a.name) ? 1 : 0;
    const bH = HEAVY_SERVERS.has(b.name) ? 1 : 0;
    return aH - bH; // heavy servers go last
  });
  const results = await Promise.allSettled(
    sortedConfigs.map(({ name, config }, i) =>
      new Promise(r => setTimeout(r, i * 250 + (HEAVY_SERVERS.has(name) ? 2000 : 0))).then(() => connectServer(name, config))
    )
  );

  const connected = [];
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === 'fulfilled') {
      connected.push(sortedConfigs[i].name);
    } else {
      _logFn(`  [MCP] Failed to connect "${sortedConfigs[i].name}": ${results[i].reason?.message || results[i].reason}`);
    }
  }

  return { tools: getMcpTools(), servers: connected };
}

/**
 * Returns OpenAI-format tool definitions for all discovered MCP tools.
 */
function getMcpTools() {
  const tools = [];
  for (const [serverName, server] of mcpServers) {
    for (const tool of server.tools) {
      // Convert MCP inputSchema to OpenAI function parameters
      const parameters = tool.inputSchema && tool.inputSchema.properties
        ? tool.inputSchema
        : { type: 'object', properties: {} };

      // Ensure required array exists
      if (!parameters.required) {
        parameters.required = [];
      }

      tools.push({
        type: 'function',
        function: {
          name: `mcp__${serverName}__${tool.name}`,
          description: `[MCP:${serverName}] ${tool.description}`,
          parameters,
        },
        _mcpServer: serverName,
        _mcpToolName: tool.name,
      });
    }
  }
  return tools;
}

/**
 * Call an MCP tool by name.
 * @param {string} fullFnName — the OpenAI function name (e.g., "mcp__nmap__scan")
 * @param {object} args — the arguments to pass to the tool
 * @returns {Promise<string>} — the tool result as a string
 */
async function callMcpTool(fullFnName, args) {
  // Parse "mcp__serverName__toolName"
  const match = fullFnName.match(/^mcp__(.+)__(.+)$/);
  if (!match) {
    throw new Error(`Invalid MCP tool name: ${fullFnName}`);
  }

  const [, serverName, toolName] = match;
  const server = mcpServers.get(serverName);

  if (!server || !server.initialized) {
    throw new Error(`MCP server "${serverName}" not connected`);
  }

  _logFn(`  [MCP:${serverName}] calling ${toolName}(${JSON.stringify(args).substring(0, 200)})`);

  try {
    const result = await sendRequest(serverName, 'tools/call', {
      name: toolName,
      arguments: args || {},
    }, 30000);

    // MCP tools/call returns { content: [{type, text}], isError }
    if (result?.content && Array.isArray(result.content)) {
      const textParts = result.content
        .filter(c => c.type === 'text')
        .map(c => c.text);
      const output = textParts.join('\n');
      if (result.isError) {
        return `Error: ${output}`;
      }
      return output || '(no output)';
    }

    return JSON.stringify(result) || '(no output)';
  } catch (err) {
    return `Error: MCP call "${fullFnName}" failed: ${err.message}`;
  }
}

/**
 * Check if a function name is an MCP tool.
 */
function isMcpTool(fnName) {
  return fnName.startsWith('mcp__');
}

/**
 * Returns status info about connected MCP servers.
 */
function mcpStatus() {
  const servers = [];
  for (const [name, server] of mcpServers) {
    servers.push({
      name,
      initialized: server.initialized,
      toolCount: server.tools.length,
      tools: server.tools.map(t => t.name),
      pid: server.child?.pid || null,
    });
  }
  return servers;
}

/**
 * One-shot test of an MCP server config — spawns it in isolation, does the real
 * initialize + tools/list handshake, then always kills the process. Does NOT touch
 * the live `mcpServers` registry, so it's safe to run against a config that's
 * already connected (or one that isn't wired in yet) without disturbing it.
 * Used by the `verify_mcp` tool so hakster can actually test a new/edited
 * mcp.json entry — or re-check a currently-failing one — instead of assuming.
 * @param {string} name — server name (for logging only)
 * @param {object} config — { command, args, env } from mcp.json
 * @param {number} [timeoutMs] — override the init timeout
 * @returns {Promise<{ok: boolean, tools?: string[], serverInfo?: object, error?: string, stderr?: string, durationMs: number}>}
 */
function testServerConfig(name, config, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const env = { ...process.env, ...(config.env || {}) };
    env.HOME = GHOST_HOME;
    if (!env.PATH?.includes('/root/.bun/bin')) {
      env.PATH = `/root/.bun/bin:${env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'}`;
    }
    const localBin = path.join(GHOST_HOME, '.local', 'bin');
    if (!env.PATH?.includes(localBin)) {
      env.PATH = `${localBin}:${env.PATH}`;
    }

    let child;
    try {
      child = spawn(config.command, config.args || [], { env, stdio: ['pipe', 'pipe', 'pipe'], cwd: '/tmp' });
    } catch (err) {
      return resolve({ ok: false, error: `spawn failed: ${err.message}`, durationMs: Date.now() - start });
    }

    let settled = false;
    let stdoutBuf = '';
    let stderrTail = '';
    let initResult = null;
    let timer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGTERM'); } catch (_) {}
      setTimeout(() => { try { if (!child.killed) child.kill('SIGKILL'); } catch (_) {} }, 2000);
      resolve({ ...result, durationMs: Date.now() - start });
    };

    child.stdin.on('error', () => {});
    child.stdout.on('error', () => {});
    child.stderr.on('error', () => {});
    child.stderr.on('data', (d) => { stderrTail = (stderrTail + d.toString()).slice(-2000); });
    child.on('error', (err) => finish({ ok: false, error: `process error: ${err.message}`, stderr: stderrTail }));
    child.on('close', (code) => {
      if (!settled) finish({ ok: false, error: `process exited early with code ${code}`, stderr: stderrTail });
    });

    const isNpx = config.command === 'npx' || config.command === 'npx.cmd';
    const isBun = config.command.endsWith('bun') || config.command.endsWith('/bun');
    const isUvx = config.command === 'uvx' || config.command === 'uv' || config.command.endsWith('/uvx') || config.command.endsWith('/uv');
    const startupDelay = isNpx ? 8000 : isBun ? 2000 : 0;
    const effTimeout = timeoutMs || config.initTimeoutMs || 120000;
    timer = setTimeout(() => finish({ ok: false, error: `initialize timed out after ${effTimeout}ms`, stderr: stderrTail }), effTimeout + startupDelay);

    child.stdout.on('data', (data) => {
      stdoutBuf += data.toString();
      let idx;
      while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
        const line = stdoutBuf.slice(0, idx).trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch (_) { continue; }
        if (msg.id === 1 && msg.result) {
          initResult = msg.result;
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', params: {}, id: 2 }) + '\n');
        } else if (msg.id === 2 && msg.result) {
          const tools = (msg.result.tools || []).map(t => t.name);
          finish({ ok: true, tools, serverInfo: initResult?.serverInfo });
        } else if (msg.error) {
          finish({ ok: false, error: msg.error.message || JSON.stringify(msg.error), stderr: stderrTail });
        }
      }
    });

    (async () => {
      if (startupDelay) await new Promise(r => setTimeout(r, startupDelay));
      try {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'haksterAI-verify', version: '1.0' } }, id: 1 }) + '\n');
      } catch (err) {
        finish({ ok: false, error: `write failed: ${err.message}`, stderr: stderrTail });
      }
    })();
  });
}

/**
 * Diff `.hakster/mcp.json` (across all configDirs) against what's actually
 * connected right now. Surfaces "configured but not loaded" drift — exactly the
 * kind of failure (PATH/ENOENT, wrong HOME, init timeout) that's silent unless
 * someone manually checks `/api/agent/mcp-status` against the config by hand.
 * @param {string[]} configDirs
 * @returns {{configured: string[], connected: string[], missing: {name: string, config: object}[]}}
 */
function diffConfiguredVsConnected(configDirs) {
  const configured = [];
  const seen = new Set();
  for (const dir of configDirs) {
    const configPath = path.join(dir, 'mcp.json');
    if (seen.has(configPath)) continue;
    seen.add(configPath);
    try {
      const raw = fs.readFileSync(configPath, 'utf-8');
      const json = JSON.parse(raw);
      for (const [name, cfg] of Object.entries(json.mcpServers || {})) {
        configured.push({ name, config: cfg });
      }
    } catch (_) {
      // mcp.json doesn't exist or is invalid at this dir — skip silently, same as loadMcpServers
    }
  }
  const connectedNames = new Set(mcpServers.keys());
  const missing = configured.filter(c => !connectedNames.has(c.name));
  return {
    configured: configured.map(c => c.name),
    connected: configured.filter(c => connectedNames.has(c.name)).map(c => c.name),
    missing: missing.map(c => ({ name: c.name, config: c.config })),
  };
}

/**
 * Shut down all MCP server processes.
 */
function shutdownMcp() {
  for (const [name, server] of mcpServers) {
    try {
      if (server.child && !server.child.killed) {
        // Send SIGTERM then force kill after 3s
        server.child.kill('SIGTERM');
        setTimeout(() => {
          try { if (!server.child.killed) server.child.kill('SIGKILL'); } catch (_) {}
        }, 3000);
      }
    } catch (_) {}
  }
  mcpServers.clear();
}

// Clean up on process exit
process.on('exit', () => {
  for (const [name, server] of mcpServers) {
    try { if (server.child && !server.child.killed) server.child.kill(); } catch (_) {}
  }
});

process.on('SIGINT', () => { shutdownMcp(); process.exit(0); });
process.on('SIGTERM', () => { shutdownMcp(); process.exit(0); });

module.exports = {
  loadMcpServers,
  getMcpTools,
  callMcpTool,
  isMcpTool,
  mcpStatus,
  shutdownMcp,
  setLogFn,
  setStatusFn,
  testServerConfig,
  diffConfiguredVsConnected,
};