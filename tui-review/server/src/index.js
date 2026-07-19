'use strict';
/**
 * haksterAi — Server Entry Point
 * Express + WebSocket API for the agentic CLI platform
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { diffLines } = require('diff');
const { getDb } = require('./db');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { chat, chatStream, listModels, generateImage, analyzeImage, PROVIDERS, estimateCost, AGENT_TOOLS, AGENT_SYSTEM_PROMPT, executeAgentTool } = require('./providers');

// ── Config ────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3579', 10);
const CORS_ORIGINS = (process.env.CORS_ORIGINS || 'http://localhost:4321,http://localhost:3000').split(',').map(s => s.trim());
const FS_ROOT = process.env.FS_ROOT || process.cwd();

// ── Express app ───────────────────────────────────────────────────
const app = express();
app.use(cors({ origin: CORS_ORIGINS, credentials: true }));
app.use(express.json({ limit: '10mb' }));

// ── Health ────────────────────────────────────────────────────────
// Existing health endpoint
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', version: '1.0.0', providers: Object.keys(PROVIDERS) });
});
// ── Messaging API ────────────────────────────────────────────────────────
app.get('/api/messages', (req, res) => {
  const db = getDb();
  const limit = parseInt(req.query.limit) || 100;
  const msgs = db.prepare(`SELECT * FROM messages ORDER BY created_at DESC LIMIT ?`).all(limit);
  res.json({ messages: msgs });
});


// ── Workspace info ───────────────────────────────────────────────
app.get('/api/workspace/:sessionId', (req, res) => {
  const FS_ROOT = process.env.FS_ROOT || path.join(__dirname, '..', 'data');
  const workDir = path.join(FS_ROOT, 'workspaces', req.params.sessionId || 'default');
  fs.mkdirSync(workDir, { recursive: true });
  let files = [];
  try {
    files = fs.readdirSync(workDir, { withFileTypes: true }).map(e => ({
      name: e.name,
      type: e.isDirectory() ? 'dir' : 'file',
    }));
  } catch {}
  res.json({ workspace: workDir, files });
});

// ── List providers & models ───────────────────────────────────────
app.get('/api/providers', (_req, res) => {
  const providers = Object.entries(PROVIDERS).map(([key, cfg]) => ({
    id: key,
    name: cfg.name,
    type: cfg.type,
    defaultModel: cfg.defaultModel,
  }));
  res.json({ providers });
});

app.get('/api/providers/:id/models', async (req, res) => {
  try {
    const models = await listModels(req.params.id);
    res.json({ provider: req.params.id, models });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Sessions CRUD ─────────────────────────────────────────────────
app.post('/api/sessions', (req, res) => {
  const db = getDb();
  const id = uuidv4();
  const { provider = 'ollama', model, title } = req.body;
  const cfg = PROVIDERS[provider];
  if (!cfg) return res.status(400).json({ error: `Unknown provider: ${provider}` });

  const finalModel = model || cfg.defaultModel;
  db.prepare(
    `INSERT INTO sessions (id, provider, model, title) VALUES (?, ?, ?, ?)`
  ).run(id, provider, finalModel, title || null);

  res.status(201).json({ id, provider, model: finalModel, title, createdAt: Date.now() });
});

app.get('/api/sessions', (_req, res) => {
  const db = getDb();
  const sessions = db.prepare(
    `SELECT * FROM sessions ORDER BY updated_at DESC`
  ).all();
  res.json({ sessions });
});

app.get('/api/sessions/:id', (req, res) => {
  const db = getDb();
  const session = db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const messages = db.prepare(
    `SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC`
  ).all(req.params.id);

  res.json({ ...session, messages });
});

app.delete('/api/sessions/:id', (req, res) => {
  const db = getDb();
  const del = db.prepare(`DELETE FROM sessions WHERE id = ?`).run(req.params.id);
  if (del.changes === 0) return res.status(404).json({ error: 'Session not found' });
  res.json({ deleted: true });
});

// ── Chat (non-streaming) ──────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { provider = 'ollama', model, messages, system, sessionId } = req.body;
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array required' });
  }

  try {
    const result = await chat({ provider, model, messages, system });
    const db = getDb();

    // Log the request
    const reqId = uuidv4();
    db.prepare(
      `INSERT INTO requests (id, session_id, type, provider, model, input_tokens, output_tokens, latency_ms, cost, status)
       VALUES (?, ?, 'chat', ?, ?, ?, ?, ?, ?, 'ok')`
    ).run(reqId, sessionId || null, provider, result.model, result.inputTokens, result.outputTokens, result.latency, result.cost);

    // Update session stats
    if (sessionId) {
      db.prepare(
        `UPDATE sessions SET total_tokens = total_tokens + ?, total_cost = total_cost + ?, updated_at = unixepoch() WHERE id = ?`
      ).run(result.inputTokens + result.outputTokens, result.cost, sessionId);
    }

    res.json(result);
  } catch (err) {
    console.error('[chat] error:', err);
    const db = getDb();
    const reqId = uuidv4();
    db.prepare(
      `INSERT INTO requests (id, session_id, type, provider, model, status, error, created_at) VALUES (?, ?, 'chat', ?, ?, 'error', ?, unixepoch())`
    ).run(reqId, sessionId || null, provider, model || PROVIDERS[provider]?.defaultModel || 'unknown', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Chat (SSE streaming) ─────────────────────────────────────────
app.post('/api/chat/stream', async (req, res) => {
  const { provider = 'ollama', model, messages, system, sessionId, thinking = false } = req.body;
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array required' });
  }

  // SSE heartbeat — prevent idle disconnect
  const chatHeartbeat = setInterval(() => {
    try { res.write(':heartbeat\n\n'); } catch {}
  }, 15000);
  res.on('close', () => { clearInterval(chatHeartbeat); });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  try {
    let fullContent = '';
    let fullThinking = '';
    let finalMeta = null;

    for await (const event of chatStream({ provider, model, messages, system, thinking })) {
      if (event.type === 'delta') {
        fullContent += event.content;
        res.write(`data: ${JSON.stringify({ type: 'delta', content: event.content })}\n\n`);
      } else if (event.type === 'thinking_start') {
        res.write(`data: ${JSON.stringify({ type: 'thinking_start' })}\n\n`);
      } else if (event.type === 'thinking') {
        fullThinking += event.content;
        res.write(`data: ${JSON.stringify({ type: 'thinking', content: event.content })}\n\n`);
      } else if (event.type === 'thinking_end') {
        res.write(`data: ${JSON.stringify({ type: 'thinking_end' })}\n\n`);
      } else if (event.type === 'done') {
        finalMeta = event;
      }
    }

    // Log
    if (finalMeta) {
      const db = getDb();
      const reqId = uuidv4();
      db.prepare(
        `INSERT INTO requests (id, session_id, type, provider, model, input_tokens, output_tokens, latency_ms, cost, status)
         VALUES (?, ?, 'stream', ?, ?, ?, ?, ?, ?, 'ok')`
      ).run(reqId, sessionId || null, finalMeta.provider, finalMeta.model, finalMeta.inputTokens, finalMeta.outputTokens, finalMeta.latency, finalMeta.cost);

      if (sessionId) {
        db.prepare(
          `UPDATE sessions SET total_tokens = total_tokens + ?, total_cost = total_cost + ?, updated_at = unixepoch() WHERE id = ?`
        ).run(finalMeta.inputTokens + finalMeta.outputTokens, finalMeta.cost, sessionId);
      }
    }

    res.write(`data: ${JSON.stringify({ type: 'done', ...(finalMeta || {}) })}\n\n`);
    res.end();
  } catch (err) {
    console.error('[stream] error:', err);
    res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
    res.end();
  }
});

// ── Agent Run (agentic loop with tool calls) ──────────────────────
const { OpenAI: OpenAIClient } = require('openai');

app.post('/api/agent/run', async (req, res) => {
  const { provider = 'ollama', model, messages, sessionId, cwd } = req.body;
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array required' });
  }

  const cfg = PROVIDERS[provider];
  if (!cfg) return res.status(400).json({ error: `Unknown provider: ${provider}` });

  // Per-session workspace: if no cwd provided, create an isolated workspace
  // under data/workspaces/<sessionId>. This gives each chat session its own
  // sandboxed directory for file operations.
  const FS_ROOT = process.env.FS_ROOT || path.join(__dirname, '..', 'data');
  const workDir = cwd || path.join(FS_ROOT, 'workspaces', sessionId || 'default');
  // Ensure workspace directory exists
  if (!cwd) {
    fs.mkdirSync(workDir, { recursive: true });
  }
  const maxTurns = 25;
  const agentModel = model || cfg.defaultModel;

  // Abort tracking — client disconnect support (use res, not req)
  let aborted = false;
  res.on('close', () => {
    aborted = true;
    clearInterval(heartbeat);
  });

  // SSE heartbeat — prevent idle disconnect (send every 15s)
  const heartbeat = setInterval(() => {
    if (!aborted) {
      try { res.write(`:heartbeat\n\n`); } catch {}
    }
  }, 15000);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
  res.flushHeaders();

  // Build the OpenAI-compatible client for the chosen provider
  let client;
  if (cfg.type === 'anthropic') {
    // Anthropic doesn't support OpenAI-style tool_calls in our current setup —
    // route through Ollama for agent mode
    const ollamaCfg = PROVIDERS.ollama;
    client = new OpenAIClient({
      apiKey: ollamaCfg.apiKey || 'ollama',
      baseURL: `${ollamaCfg.baseURL.replace(/\/$/, '')}/v1`,
    });
  } else if (cfg.type === 'openai-compat') {
    client = new OpenAIClient({
      apiKey: cfg.apiKey || 'ollama',
      baseURL: `${cfg.baseURL.replace(/\/$/, '')}/v1`,
    });
  } else {
    client = new OpenAIClient({
      apiKey: cfg.apiKey,
      baseURL: cfg.baseURL,
    });
  }

  // Build machine context so the model knows the environment
  let dirListing = '';
  try { dirListing = fs.readdirSync(workDir).map(f => {
    try { return fs.statSync(path.join(workDir, f)).isDirectory() ? f + '/' : f; } catch { return f; }
  }).join('\n'); } catch { dirListing = '(unreadable)'; }
  const machineContext = `
=== MACHINE CONTEXT ===
OS: ${os.type()} ${os.release()} (${os.arch()})
Hostname: ${os.hostname()}
User: ${os.userInfo().username}
Shell: ${process.env.SHELL || '/bin/bash'}
CWD: ${workDir}
Home: ${os.homedir()}
 CPUs: ${os.cpus().length} cores | RAM: ${Math.round(os.totalmem()/1024/1024/1024)}GB | Uptime: ${Math.round(os.uptime()/3600)}h
Node: ${process.version}

Files in CWD (${workDir}):
${dirListing}
=== END MACHINE CONTEXT ===`;

  const agentMessages = [
    { role: 'system', content: AGENT_SYSTEM_PROMPT + '\n\n' + machineContext },
    ...messages.filter(m => m.role !== 'system'),
  ];

  // ── Hard context ceiling — progressive truncation, no message dropping ──
  const CONTEXT_LIMIT = 131072; // matches gpt-oss:120b-cloud actual context window
  const MAX_OUTPUT_TOKENS = 16384; // reserved for model output
  const INPUT_TOKEN_BUDGET = CONTEXT_LIMIT - MAX_OUTPUT_TOKENS; // ~114k tokens available for input
  const MAX_CONTEXT_CHARS = 100000; // hard ceiling in chars — very aggressive to prevent token overflow
  const MAX_MSG_CHARS = 1000; // max chars per message in context (except system prompt)

  function estimateTokens(msgs) {
    let chars = 0;
    for (const m of msgs) {
      chars += (m.content || '').length;
      if (m.tool_calls) {
        for (const tc of m.tool_calls) {
          chars += (tc.function?.arguments || '').length;
          // Tool definitions add overhead — function name + description + params
          chars += 100; // per tool call: name, id, type overhead
        }
      }
      // Tool result messages include tool_call_id overhead
      if (m.role === 'tool') chars += 50;
    }
    // Use aggressive 1.5:1 ratio (code/special chars tokenize higher than plain text)
    return Math.ceil(chars / 1.5);
  }

  // Hard-truncate a single message's content fields
  function truncateMessage(m, maxLen) {
    if (m.role === 'system') return m; // never truncate system prompt
    const content = (m.content || '').length > maxLen
      ? m.content.substring(0, maxLen) + '\n[trimmed]'
      : m.content;
    let tool_calls = m.tool_calls;
    if (tool_calls) {
      tool_calls = tool_calls.map(tc => ({
        ...tc,
        function: {
          ...tc.function,
          arguments: (tc.function?.arguments || '').length > maxLen
            ? tc.function.arguments.substring(0, maxLen) + '...'
            : tc.function?.arguments,
        }
      }));
    }
    return { ...m, content, tool_calls };
  }

  // Enforce hard ceiling on total context before sending to model
  // Strategy: keep ALL messages, just truncate content to fit budget
  function enforceContextCeiling(msgs) {
    let totalChars = msgs.reduce((sum, m) => sum + (m.content || '').length +
      (m.tool_calls ? m.tool_calls.reduce((s, tc) => s + (tc.function?.arguments || '').length, 0) : 0), 0);

    // Step 1: Truncate every message to MAX_MSG_CHARS (except system)
    msgs = msgs.map(m => truncateMessage(m, MAX_MSG_CHARS));

    totalChars = msgs.reduce((sum, m) => sum + (m.content || '').length +
      (m.tool_calls ? m.tool_calls.reduce((s, tc) => s + (tc.function?.arguments || '').length, 0) : 0), 0);

    // Step 2: If still over budget, progressively truncate harder — never drop messages
    // Reduce max per-message length until we fit
    let perMsgLimit = MAX_MSG_CHARS;
    while (totalChars > MAX_CONTEXT_CHARS && perMsgLimit > 100) {
      perMsgLimit = Math.floor(perMsgLimit * 0.6); // shrink by 40% each pass
      msgs = msgs.map((m, i) => i === 0 ? m : truncateMessage(m, perMsgLimit));
      totalChars = msgs.reduce((sum, m) => sum + (m.content || '').length +
        (m.tool_calls ? m.tool_calls.reduce((s, tc) => s + (tc.function?.arguments || '').length, 0) : 0), 0);
    }

    // Step 3: Absolute last resort — nuclear 100 char truncation
    if (totalChars > MAX_CONTEXT_CHARS) {
      msgs = msgs.map((m, i) => i === 0 ? m : truncateMessage(m, 100));
    }

    // Step 4: If STILL over budget, drop oldest messages (except system prompt)
    // This is the nuclear option — we must not exceed the token limit
    totalChars = msgs.reduce((sum, m) => sum + (m.content || '').length +
      (m.tool_calls ? m.tool_calls.reduce((s, tc) => s + (tc.function?.arguments || '').length, 0) : 0), 0);
    let spliceGuard = 0;
    while (totalChars > MAX_CONTEXT_CHARS && msgs.length > 2 && spliceGuard < 200) {
      // Drop the oldest non-system message (index 1)
      const dropped = msgs.splice(1, 1);
      totalChars -= (dropped[0]?.content || '').length;
      spliceGuard++;
    }
    totalChars = msgs.reduce((sum, m) => sum + (m.content || '').length +
      (m.tool_calls ? m.tool_calls.reduce((s, tc) => s + (tc.function?.arguments || '').length, 0) : 0), 0);

    return msgs;
  }

  // ── Pre-flight: enforce context ceiling on incoming history ──
  {
    const before = estimateTokens(agentMessages);
    const enforced = enforceContextCeiling(agentMessages);
    if (enforced.length < agentMessages.length || estimateTokens(enforced) < before) {
      agentMessages.length = 0;
      agentMessages.push(...enforced);
      const after = estimateTokens(agentMessages);
      console.log(`[agent] Pre-flight ceiling: ${before} → ${after} tokens (budget: ${INPUT_TOKEN_BUDGET})`);
    }
  }

  let lastHadToolCalls = false;
  try {
    for (let turn = 0; turn < maxTurns; turn++) {
      // Check abort at start of each iteration
      if (aborted) {
        clearInterval(heartbeat);
        res.write(`data: ${JSON.stringify({ type: 'aborted' })}\n\n`);
        res.end();
        return;
      }

      // ── Enforce context ceiling before every model call ──
      {
        const tokensBefore = estimateTokens(agentMessages);
        const enforced = enforceContextCeiling(agentMessages);
        if (enforced.length < agentMessages.length || estimateTokens(enforced) < tokensBefore) {
          agentMessages.length = 0;
          agentMessages.push(...enforced);
          const tokensAfter = estimateTokens(agentMessages);
          if (tokensBefore !== tokensAfter) {
            console.log(`[agent] Context ceiling: ${tokensBefore} → ${tokensAfter} tokens (budget: ${INPUT_TOKEN_BUDGET})`);
            res.write(`data: ${JSON.stringify({ type: 'compact', message: `[context ceiling] ${tokensBefore} → ${tokensAfter} tokens (budget: ${INPUT_TOKEN_BUDGET})`, tokensBefore, tokensAfter })}\n\n`);
          }
        }
        // Debug: log actual message sizes being sent to model
        const totalChars = agentMessages.reduce((s, m) => s + (m.content || '').length + 
          (m.tool_calls ? m.tool_calls.reduce((acc, tc) => acc + (tc.function?.arguments || '').length, 0) : 0), 0);
        console.log(`[agent] Sending turn ${turn}: ${agentMessages.length} msgs, ${totalChars.toLocaleString()} chars, est ${estimateTokens(agentMessages).toLocaleString()} tokens (budget: ${INPUT_TOKEN_BUDGET})`);
      }

      // Hard safety: if still over budget after all enforcement, refuse the call
      const finalEstimate = estimateTokens(agentMessages);
      if (finalEstimate > INPUT_TOKEN_BUDGET) {
        console.error(`[agent] FATAL: Still ${finalEstimate} tokens after enforcement (budget: ${INPUT_TOKEN_BUDGET}). Dropping oldest messages.`);
        while (estimateTokens(agentMessages) > INPUT_TOKEN_BUDGET && agentMessages.length > 2) {
          agentMessages.splice(1, 1); // drop oldest non-system message
        }
        console.log(`[agent] After emergency trim: ${estimateTokens(agentMessages)} tokens, ${agentMessages.length} msgs`);
      }

      // Stream the model response with timeout protection
      const streamAbort = new AbortController();
      const streamTimeout = setTimeout(() => {
        streamAbort.abort();
        console.warn('[agent] Stream timed out after 120s, aborting');
      }, 120000);

      let stream;
      try {
        stream = await client.chat.completions.create({
          model: agentModel,
          messages: agentMessages,
          tools: AGENT_TOOLS,
          stream: true,
          max_tokens: MAX_OUTPUT_TOKENS,
        }, { signal: streamAbort.signal });
      } catch (streamErr) {
        clearTimeout(streamTimeout);
        if (streamErr.name === 'AbortError') {
          res.write(`data: ${JSON.stringify({ type: 'error', message: 'Model response timed out (120s). Try again.' })}\n\n`);
          break;
        }
        throw streamErr;
      }

      let assistantContent = '';
      const toolCalls = []; // { id, name, arguments (accumulated) }
      let currentToolCall = null;
      let thinkingActive = false;

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;

        // Reasoning / thinking content (OpenAI-compatible models like GLM-5.1)
        const thinkingContent = delta.reasoning_content || delta.thinking || delta.reasoning;
        if (thinkingContent) {
          if (!thinkingActive) {
            thinkingActive = true;
            res.write(`data: ${JSON.stringify({ type: 'thinking_start' })}\n\n`);
          }
          res.write(`data: ${JSON.stringify({ type: 'thinking', content: thinkingContent })}\n\n`);
        }
        // Close thinking if we had thinking but now see content or tool_calls (thinking block ended)
        if (thinkingActive && (delta.content || delta.tool_calls)) {
          thinkingActive = false;
          res.write(`data: ${JSON.stringify({ type: 'thinking_end' })}\n\n`);
        }

        // Text content
        if (delta.content) {
          assistantContent += delta.content;
          res.write(`data: ${JSON.stringify({ type: 'delta', content: delta.content })}\n\n`);
        }

        // Tool calls — accumulate
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (tc.index !== undefined) {
              // New tool call starts
              if (!toolCalls[tc.index]) {
                toolCalls[tc.index] = {
                  id: tc.id || '',
                  name: tc.function?.name || '',
                  arguments: '',
                };
                currentToolCall = tc.index;
              }
              if (tc.id) toolCalls[tc.index].id = tc.id;
              if (tc.function?.name) toolCalls[tc.index].name = tc.function.name;
              if (tc.function?.arguments) toolCalls[tc.index].arguments += tc.function.arguments;
            }
          }
        }

        // Usage info
        if (chunk.usage) {
          // We'll send usage at the end
        }
      }

      // Stream finished successfully
      clearTimeout(streamTimeout);

      // Close thinking if still active at end of stream
      if (thinkingActive) {
        thinkingActive = false;
        res.write(`data: ${JSON.stringify({ type: 'thinking_end' })}\n\n`);
      }

      // Build assistant message for history
      const assistantMsg = { role: 'assistant' };
      if (assistantContent) assistantMsg.content = assistantContent;
      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments },
        }));
      }
      agentMessages.push(assistantMsg);

      // No tool calls — we're done
      if (toolCalls.length === 0) {
        lastHadToolCalls = false;
        clearInterval(heartbeat);
        res.write(`data: ${JSON.stringify({ type: 'done', model: agentModel, provider })}\n\n`);
        res.end();
        return;
      }

      // Tool calls in progress — mark so next turn skips compact
      lastHadToolCalls = true;

      // Execute tool calls
      for (const tc of toolCalls) {
        // Check abort before each tool execution
        if (aborted) {
          clearInterval(heartbeat);
          res.write(`data: ${JSON.stringify({ type: 'aborted' })}\n\n`);
          res.end();
          return;
        }

        const toolName = tc.name;
        let toolArgs = {};
        try {
          toolArgs = JSON.parse(tc.arguments || '{}');
        } catch { /* leave empty */ }

        // Notify frontend: tool call starting
        res.write(`data: ${JSON.stringify({
          type: 'tool_call_start',
          tool_call_id: tc.id,
          tool_name: toolName,
          tool_args: toolArgs,
        })}\n\n`);

        // Execute the tool
        const result = await executeAgentTool(toolName, toolArgs, workDir, provider, agentModel);

        // Truncate tool results aggressively: display gets 4k, model context gets 800 chars
        const SHELL_DISPLAY_LIMIT = 4000;
        const SHELL_CONTEXT_LIMIT = 800;

        // Check if the result contains image URLs (from generate_image tool)
        let imageUrls = null;
        let displayResult = result;
        try {
          const parsed = JSON.parse(result);
          if (parsed && parsed.__image_urls) {
            imageUrls = parsed.__image_urls;
            displayResult = parsed.text || result;
          }
        } catch (_) { /* not JSON, use raw result */ }

        const truncatedResult = displayResult.length > SHELL_DISPLAY_LIMIT ? displayResult.slice(0, SHELL_DISPLAY_LIMIT) + '\n... (truncated)' : displayResult;
        const contextResult = displayResult.length > SHELL_CONTEXT_LIMIT ? displayResult.slice(0, SHELL_CONTEXT_LIMIT) + '\n[trimmed]' : displayResult;

        // Notify frontend: tool call result
        res.write(`data: ${JSON.stringify({
          type: 'tool_call_result',
          tool_call_id: tc.id,
          tool_name: toolName,
          tool_result: truncatedResult,
        })}\n\n`);

        // If generate_image returned image URLs, emit an image event for inline preview
        if (imageUrls && imageUrls.length > 0) {
          for (const imgUrl of imageUrls) {
            res.write(`data: ${JSON.stringify({
              type: 'image',
              url: imgUrl,
              prompt: toolArgs.prompt || '',
            })}\n\n`);
          }
        }

        // Add tool result to messages (trimmed for context)
        agentMessages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: contextResult,
        });
      }

      // Turn marker
      res.write(`data: ${JSON.stringify({ type: 'turn_end', turn })}\n\n`);
    }

    // Hit max turns
    clearInterval(heartbeat);
    res.write(`data: ${JSON.stringify({ type: 'max_turns', maxTurns })}\n\n`);
    res.end();
  } catch (err) {
    clearInterval(heartbeat);
    console.error('[agent] error:', err);
    res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
    res.end();
  }
});

// ── Save messages to a session ────────────────────────────────────
app.post('/api/sessions/:id/messages', (req, res) => {
  const db = getDb();
  const session = db.prepare(`SELECT id FROM sessions WHERE id = ?`).get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const { role, content, inputTokens = 0, outputTokens = 0, latencyMs = 0, provider, model } = req.body;
  if (!['user', 'assistant', 'system'].includes(role)) {
    return res.status(400).json({ error: 'role must be user, assistant, or system' });
  }

  const id = uuidv4();
  db.prepare(
    `INSERT INTO messages (id, session_id, role, content, input_tokens, output_tokens, latency_ms, provider, model)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, req.params.id, role, content, inputTokens, outputTokens, latencyMs, provider || null, model || null);

  res.status(201).json({ id, role, content, createdAt: Date.now() });
});

// ── File system API (scoped to FS_ROOT) ───────────────────────────

function safePath(reqPath) {
  const resolved = path.resolve(FS_ROOT, '.' + reqPath);
  if (!resolved.startsWith(path.resolve(FS_ROOT))) {
    throw new Error('Path traversal blocked');
  }
  return resolved;
}

// Read file
app.get('/api/fs/read', (req, res) => {
  try {
    const filePath = safePath(req.query.path || '/');
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      const entries = fs.readdirSync(filePath).map(name => {
        const full = path.join(filePath, name);
        const s = fs.statSync(full);
        return { name, type: s.isDirectory() ? 'dir' : 'file', size: s.size, modified: s.mtimeMs };
      });
      return res.json({ type: 'dir', path: req.query.path, entries });
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    res.json({ type: 'file', path: req.query.path, content, size: stat.size });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Write file
app.post('/api/fs/write', (req, res) => {
  try {
    const { path: fPath, content } = req.body;
    if (!fPath || content === undefined) return res.status(400).json({ error: 'path and content required' });
    const filePath = safePath(fPath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
    res.json({ ok: true, path: fPath, size: Buffer.byteLength(content) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Diff (apply a patch)
app.post('/api/fs/diff', (req, res) => {
  try {
    const { path: fPath, oldContent, newContent } = req.body;
    if (!fPath) return res.status(400).json({ error: 'path required' });
    const filePath = safePath(fPath);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    const current = fs.readFileSync(filePath, 'utf-8');
    const changes = diffLines(oldContent || current, newContent);

    if (newContent !== undefined) {
      fs.writeFileSync(filePath, newContent, 'utf-8');
    }

    res.json({
      ok: true,
      path: fPath,
      changes: changes.map(c => ({
        value: c.value,
        added: c.added,
        removed: c.removed,
        count: c.count,
      })),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Delete file/dir
app.delete('/api/fs/delete', (req, res) => {
  try {
    const filePath = safePath(req.query.path || '/');
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      fs.rmSync(filePath, { recursive: true });
    } else {
      fs.unlinkSync(filePath);
    }
    res.json({ ok: true, path: req.query.path });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Artifact System (App Builder) ──────────────────────────────────
const archiver = require('archiver');

// System prompt for app generation
const APP_BUILDER_SYSTEM = `You are haksterAi App Builder, an expert full-stack developer. When the user asks you to build an app, website, or tool, you MUST output the complete code as structured artifacts.

FORMAT: Output each file as a fenced code block with the filename in the header, like:

---filename:index.html---
(complete file content here)
---end---

---filename:style.css---
(complete file content here)
---end---

---filename:script.js---
(complete file content here)
---end---

RULES:
1. ALWAYS output at least one HTML file called index.html (this is the main entry point)
2. Include ALL CSS inline or in a linked style.css file
3. Include ALL JavaScript inline or in a linked script.js file
4. Make it COMPLETE and RUNNABLE — no placeholders, no "..." marks, no "// rest of code here"
5. Use modern HTML5, CSS3, and vanilla JS (no frameworks needed unless user specifies)
6. Make it responsive and mobile-friendly
7. Use a dark theme by default (background: #0a0a0f, text: #e2e8f0, accent: #7c3aed)
8. Add smooth animations and transitions for a polished feel
9. If the app needs data, include sample/mock data directly in the JS
10. Everything must work in a single browser tab with no server required
11. You can use CDN links for libraries (Tailwind, Chart.js, etc.)
12. For images, use emoji, SVG inline, or placeholder URLs

Output ONLY the file blocks. No explanation before or after. Just the code.`;

// Parse artifact files from AI response
function parseArtifacts(content) {
  const files = [];
  const regex = /---filename:(.+?)---\n([\s\S]*?)---end---/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    files.push({ filename: match[1].trim(), content: match[2].trim() });
  }

  // Fallback: if no ---filename: markers found, try code blocks with filenames
  if (files.length === 0) {
    const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;
    let codeMatch;
    let htmlFound = false;
    while ((codeMatch = codeBlockRegex.exec(content)) !== null) {
      let lang = codeMatch[1] || 'txt';
      let code = codeMatch[2];
      // Detect if it's HTML
      if (lang === 'html' || code.trim().startsWith('<!DOCTYPE') || code.trim().startsWith('<html') || code.trim().startsWith('<div')) {
        files.push({ filename: 'index.html', content: code.trim() });
        htmlFound = true;
      } else if (lang === 'css' || lang === 'stylesheet') {
        files.push({ filename: 'style.css', content: code.trim() });
      } else if (lang === 'javascript' || lang === 'js') {
        files.push({ filename: 'script.js', content: code.trim() });
      }
    }

    // If still nothing, try to find any HTML-like content
    if (files.length === 0) {
      const htmlMatch = content.match(/<[\s\S]*?(?:<\/html>|<\/body>)/i);
      if (htmlMatch) {
        files.push({ filename: 'index.html', content: htmlMatch[0].trim() });
      }
    }
  }

  // Determine main file
  const mainFile = files.find(f => f.filename === 'index.html')?.filename || files[0]?.filename || 'index.html';

  return { files, mainFile };
}

// POST /api/generate — Generate an app from description, stream response, parse artifacts
app.post('/api/generate', async (req, res) => {
  const { provider = 'ollama', model, description, thinking = false } = req.body;
  if (!description) return res.status(400).json({ error: 'description required' });

  const messages = [
    { role: 'system', content: APP_BUILDER_SYSTEM },
    { role: 'user', content: description },
  ];

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  try {
    let fullContent = '';
    let fullThinking = '';
    let finalMeta = null;

    for await (const event of chatStream({ provider, model, messages, system: APP_BUILDER_SYSTEM, thinking })) {
      if (event.type === 'delta') {
        fullContent += event.content;
        res.write(`data: ${JSON.stringify({ type: 'delta', content: event.content })}\n\n`);
      } else if (event.type === 'thinking_start') {
        res.write(`data: ${JSON.stringify({ type: 'thinking_start' })}\n\n`);
      } else if (event.type === 'thinking') {
        fullThinking += event.content;
        res.write(`data: ${JSON.stringify({ type: 'thinking', content: event.content })}\n\n`);
      } else if (event.type === 'thinking_end') {
        res.write(`data: ${JSON.stringify({ type: 'thinking_end' })}\n\n`);
      } else if (event.type === 'done') {
        finalMeta = event;
      }
    }

    // Parse artifacts from accumulated content
    const parsed = parseArtifacts(fullContent);

    if (parsed.files.length > 0) {
      const db = getDb();
      const artifactId = uuidv4();
      const sessionId = req.body.sessionId || null;

      db.prepare(
        `INSERT INTO artifacts (id, session_id, title, description, provider, model, files, main_file)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        artifactId,
        sessionId,
        description.slice(0, 100),
        description,
        provider,
        finalMeta?.model || model || 'unknown',
        JSON.stringify(parsed.files),
        parsed.mainFile
      );

      res.write(`data: ${JSON.stringify({
        type: 'artifact',
        artifact: {
          id: artifactId,
          title: description.slice(0, 100),
          files: parsed.files,
          mainFile: parsed.mainFile,
        }
      })}\n\n`);
    }

    if (finalMeta) {
      const db = getDb();
      const reqId = uuidv4();
      db.prepare(
        `INSERT INTO requests (id, session_id, type, provider, model, input_tokens, output_tokens, latency_ms, cost, status)
         VALUES (?, ?, 'generate', ?, ?, ?, ?, ?, ?, 'ok')`
      ).run(reqId, req.body.sessionId || null, provider, finalMeta.model, finalMeta.inputTokens, finalMeta.outputTokens, finalMeta.latency, finalMeta.cost);
    }

    res.write(`data: ${JSON.stringify({ type: 'done', ...(finalMeta || {}) })}\n\n`);
    res.end();
  } catch (err) {
    console.error('[generate] error:', err);
    res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
    res.end();
  }
});

// GET /api/artifacts — List all artifacts
app.get('/api/artifacts', (_req, res) => {
  const db = getDb();
  const artifacts = db.prepare(`SELECT id, title, description, provider, model, main_file, created_at FROM artifacts ORDER BY created_at DESC`).all();
  res.json({ artifacts });
});

// GET /api/artifacts/:id — Get artifact with files
app.get('/api/artifacts/:id', (req, res) => {
  const db = getDb();
  const artifact = db.prepare(`SELECT * FROM artifacts WHERE id = ?`).get(req.params.id);
  if (!artifact) return res.status(404).json({ error: 'Artifact not found' });

  res.json({
    ...artifact,
    files: JSON.parse(artifact.files),
  });
});

// DELETE /api/artifacts/:id — Delete artifact
app.delete('/api/artifacts/:id', (req, res) => {
  const db = getDb();
  const del = db.prepare(`DELETE FROM artifacts WHERE id = ?`).run(req.params.id);
  if (del.changes === 0) return res.status(404).json({ error: 'Artifact not found' });
  // Also delete preview files from disk
  const previewDir = path.join(__dirname, '../../data/previews', req.params.id);
  if (fs.existsSync(previewDir)) {
    fs.rmSync(previewDir, { recursive: true });
  }
  res.json({ deleted: true });
});

// GET /api/artifacts/:id/download — Download artifact as ZIP
app.get('/api/artifacts/:id/download', (req, res) => {
  const db = getDb();
  const artifact = db.prepare(`SELECT * FROM artifacts WHERE id = ?`).get(req.params.id);
  if (!artifact) return res.status(404).json({ error: 'Artifact not found' });

  const files = JSON.parse(artifact.files);
  const title = artifact.title.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${title}.zip"`);

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.pipe(res);

  for (const file of files) {
    archive.append(Buffer.from(file.content, 'utf-8'), { name: file.filename });
  }

  archive.finalize();
});

// GET /preview/:id — Serve artifact preview (live sandboxed app)
app.get('/preview/:id', (req, res) => {
  const db = getDb();
  const artifact = db.prepare(`SELECT * FROM artifacts WHERE id = ?`).get(req.params.id);
  if (!artifact) return res.status(404).send('Artifact not found');

  const files = JSON.parse(artifact.files);
  const mainFile = artifact.main_file || files[0]?.filename;

  // Find main HTML file
  let html = files.find(f => f.filename === 'index.html')?.content
    || files.find(f => f.filename.endsWith('.html'))?.content;

  if (!html) {
    // Construct an HTML wrapper if only JS/CSS provided
    const css = files.find(f => f.filename.endsWith('.css'))?.content || '';
    const js = files.find(f => f.filename.endsWith('.js'))?.content || '';
    html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${artifact.title}</title>
<style>${css}</style>
</head>
<body>
<script>${js}</script>
</body>
</html>`;
  } else {
    // Inject CSS and JS files if referenced
    const css = files.find(f => f.filename.endsWith('.css'));
    const js = files.find(f => f.filename.endsWith('.js'));
    if (css && !html.includes('style.css')) {
      html = html.replace('</head>', `<style>${css.content}</style>\n</head>`);
    }
    if (js && !html.includes('script.js')) {
      html = html.replace('</body>', `<script>${js.content}</script>\n</body>`);
    }
  }

  res.setHeader('Content-Type', 'text/html');
  res.setHeader('Content-Security-Policy', "default-src 'unsafe-inline' 'unsafe-eval' * data: blob:;");
  res.send(html);
});

// ── Image Generation ────────────────────────────────────────────────
app.post('/api/images/generate', async (req, res) => {
  const { provider = 'openai', model = 'dall-e-3', prompt, size = '1024x1024', quality = 'standard' } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt required' });

  try {
    const result = await generateImage({ provider, model, prompt, size, quality });
    res.json(result);
  } catch (err) {
    console.error('[image-gen] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Image Analysis (Vision) ────────────────────────────────────────
app.post('/api/images/analyze', async (req, res) => {
  const { provider = 'openai', model, prompt, imageBase64, imageUrl, mimeType } = req.body;
  if (!imageBase64 && !imageUrl) return res.status(400).json({ error: 'imageBase64 or imageUrl required' });
  if (!prompt) return res.status(400).json({ error: 'prompt required (e.g. "Describe this image" or "Enhance and describe")' });

  try {
    const result = await analyzeImage({ provider, model, prompt, imageBase64, imageUrl, mimeType });
    res.json(result);
  } catch (err) {
    console.error('[image-analyze] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Stats ──────────────────────────────────────────────────────────
app.get('/api/stats', (_req, res) => {
  const db = getDb();
  const totalRequests = db.prepare(`SELECT COUNT(*) as count FROM requests`).get().count;
  const totalTokens = db.prepare(`SELECT SUM(input_tokens + output_tokens) as total FROM requests`).get().total || 0;
  const totalCost = db.prepare(`SELECT SUM(cost) as total FROM requests`).get().total || 0;
  const byProvider = db.prepare(
    `SELECT provider, COUNT(*) as requests, SUM(input_tokens) as inputTokens, SUM(output_tokens) as outputTokens, SUM(cost) as cost FROM requests GROUP BY provider`
  ).all();

  res.json({ totalRequests, totalTokens, totalCost, byProvider });
});

// ── Serve generated images ────────────────────────────────────────
const outputsPath = path.join(__dirname, '../../outputs');
app.use('/outputs', express.static(outputsPath));

// ── Serve Astro static build ──────────────────────────────────────
const distPath = path.join(__dirname, '../../dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  // SPA fallback (Express 5 uses named wildcards)
  app.get('/{*splat}', (_req, res) => {
    const indexHtml = path.join(distPath, 'index.html');
    if (fs.existsSync(indexHtml)) {
      res.sendFile(indexHtml);
    } else {
      res.status(404).json({ error: 'Not found' });
    }
  });
}

// ── HTTP + WebSocket server ─────────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws) => {
  console.log('[ws] client connected');

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      ws.send(JSON.stringify({ type: 'error', error: 'Invalid JSON' }));
      return;
    }

    const { action, provider = 'ollama', model, messages, system, sessionId } = msg;

    if (action === 'chat') {
      // Non-streaming via WS
      try {
        const result = await chat({ provider, model, messages, system });
        ws.send(JSON.stringify({ type: 'chat_result', ...result }));

        // Log
        if (sessionId) {
          const db = getDb();
          const reqId = uuidv4();
          db.prepare(
            `INSERT INTO requests (id, session_id, type, provider, model, input_tokens, output_tokens, latency_ms, cost, status)
             VALUES (?, ?, 'ws-chat', ?, ?, ?, ?, ?, ?, 'ok')`
          ).run(reqId, sessionId, provider, result.model, result.inputTokens, result.outputTokens, result.latency, result.cost);
        }
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', error: err.message }));
      }
    } else if (action === 'stream') {
      // Streaming via WS
      try {
        for await (const event of chatStream({ provider, model, messages, system })) {
          if (ws.readyState !== 1) break; // client disconnected
          ws.send(JSON.stringify(event));
        }
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', error: err.message }));
      }
    } else {
      ws.send(JSON.stringify({ type: 'error', error: `Unknown action: ${action}` }));
    }
  });

  ws.on('close', () => console.log('[ws] client disconnected'));
});

// ── PTY WebSocket — Real terminal in the browser ──────────────────
const pty = require('node-pty');

const ptyWss = new WebSocketServer({ noServer: true });

ptyWss.on('connection', (ws) => {
  let ptyProcess = null;
  let closed = false;

  const shell = process.env.SHELL || '/bin/bash';
  const workDir = process.env.TERMINAL_CWD || process.env.FS_ROOT || '/home/ghost';
  const haksterPath = path.resolve(__dirname, 'agent/index.js');

  try {
    ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: workDir,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        HAKSTER_CLI: haksterPath,
        HOME: process.env.HOME || '/home/ghost',
      }
    });
    console.log(`[pty] spawned shell: ${shell} (pid=${ptyProcess.pid})`);
  } catch (err) {
    console.error('[pty] failed to spawn:', err);
    ws.send(JSON.stringify({ type: 'error', error: `Failed to spawn terminal: ${err.message}` }));
    ws.close();
    return;
  }

  const heartbeat = setInterval(() => {
    if (ws.readyState === 1) {
      try { ws.send(JSON.stringify({ type: 'heartbeat', ts: Date.now() })); } catch {}
    }
  }, 30000);

  // PTY output → browser
  ptyProcess.onData((data) => {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'pty', data }));
    }
  });

  ptyProcess.onExit(({ exitCode }) => {
    console.log(`[pty] shell exited (code=${exitCode})`);
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'exit', exitCode }));
    }
    try { ws.close(); } catch {}
  });

  // Browser → PTY input
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'input' && ptyProcess) {
      ptyProcess.write(msg.data || '');
    } else if (msg.type === 'resize' && ptyProcess) {
      try { ptyProcess.resize(msg.cols || 120, msg.rows || 30); } catch {}
    } else if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
    }
  });

  ws.on('close', () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    console.log(`[pty] client disconnected, killing shell (pid=${ptyProcess?.pid})`);
    if (ptyProcess) {
      try {
        ptyProcess.write('exit\r');
        setTimeout(() => {
          try { ptyProcess.kill(); } catch {}
        }, 500);
      } catch {}
    }
  });
});

// Upgrade handler — route /ws to chat WSS, /pty to PTY WSS.
server.on('upgrade', (req, socket, head) => {
  if (req.url === '/pty') {
    ptyWss.handleUpgrade(req, socket, head, (ws) => {
      ptyWss.emit('connection', ws, req);
    });
  } else if (req.url === '/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

// ── Start ──────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n  ╔══════════════════════════════════════════╗`);
  console.log(`  ║  haksterAi server v1.0                   ║`);
  console.log(`  ║  http://localhost:${String(PORT).padEnd(5)}                ║`);
  console.log(`  ║  WS:   ws://localhost:${String(PORT).padEnd(5)}/ws           ║`);
  console.log(`  ║  Providers: ${Object.keys(PROVIDERS).join(', ').padEnd(26)}║`);
  console.log(`  ║  FS Root: ${FS_ROOT.substring(0, 30).padEnd(34)}║`);
  console.log(`  ╚══════════════════════════════════════════╝\n`);
});
