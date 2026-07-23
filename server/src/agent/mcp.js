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
function connectServer(serverName, config) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...(config.env || {}) };
    // Ensure bun is in PATH for MCP servers that need it
    if (!env.PATH?.includes('/root/.bun/bin')) {
      env.PATH = `/root/.bun/bin:${env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'}`;
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
    });

    // Initialize the server (with startup delay for npx to finish installing)
    (async () => {
      try {
        // npx-based servers need time to download/install before they listen on stdin
        // Give npx-based servers time to download/install on first run
        // Direct binaries start instantly — no delay needed
        const isNpx = config.command === 'npx' || config.command === 'npx.cmd';
        const isBun = config.command.endsWith('bun') || config.command.endsWith('/bun');
        if (isNpx) {
          const pkgName = config.args && config.args.length > 1 ? config.args[1] : '';
          _logFn(`  [MCP:${serverName}] npx starting${pkgName ? ` ${pkgName}` : ''}...`);
          await new Promise(r => setTimeout(r, 8000)); // 8s for npx package resolution
        } else if (isBun) {
          _logFn(`  [MCP:${serverName}] bun starting...`);
          await new Promise(r => setTimeout(r, 2000)); // 2s for bun to warm up
        }

        // Step 1: Send "initialize" request
        const initResult = await sendRequest(serverName, 'initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: {
            name: 'haksterAI',
            version: '2.1.0',
          },
        }, 60000); // 60s timeout — npx may need to download on first run

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
  const results = await Promise.allSettled(
    configs.map(({ name, config }, i) =>
      new Promise(r => setTimeout(r, i * 250)).then(() => connectServer(name, config))
    )
  );

  const connected = [];
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === 'fulfilled') {
      connected.push(configs[i].name);
    } else {
      _logFn(`  [MCP] Failed to connect "${configs[i].name}": ${results[i].reason?.message || results[i].reason}`);
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
};