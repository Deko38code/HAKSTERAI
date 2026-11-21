/**
 * Cloud sub-agent spawner for haksterAi.
 * Creates a focused OpenAI-compatible client call with limited turns (max 3)
 * to handle delegated sub-tasks within the agent loop.
 */

const { OpenAI } = require('openai');
const { PROVIDERS, AGENT_TOOLS, AGENT_SYSTEM_PROMPT, executeAgentTool } = require('./providers');
const { getAgentRole } = require('./agent/agent-roster');
const os = require('os');
const fs = require('fs');
const path = require('path');

const SUBAGENT_SESSIONS = new Map();
const MAX_SUBAGENT_SESSIONS = 50;
const MAX_SUBAGENT_TURNS = 3;

async function runSubAgent(session, userMessage) {
  session.messages.push({ role: 'user', content: userMessage });
  const subTools = AGENT_TOOLS.filter(t => !['spawn_agent', 'followup_agent', 'sub_agent'].includes(t.function.name));
  let responseText = '';
  for (let turn = 0; turn < MAX_SUBAGENT_TURNS; turn++) {
    const response = await session.client.chat.completions.create({
      model: session.model,
      messages: session.messages,
      tools: subTools,
      tool_choice: turn < MAX_SUBAGENT_TURNS - 1 ? 'auto' : 'none',
    });
    const assistantMsg = response.choices[0]?.message;
    if (!assistantMsg) throw new Error('Provider returned no sub-agent response');
    session.messages.push(assistantMsg);
    responseText = assistantMsg.content || '';
    if (!assistantMsg.tool_calls?.length) return responseText || '(sub-agent completed with no text output)';
    for (const tc of assistantMsg.tool_calls) {
      let toolArgs;
      try { toolArgs = JSON.parse(tc.function.arguments); } catch { toolArgs = {}; }
      const result = await executeAgentTool(tc.function.name, toolArgs, session.cwd);
      session.messages.push({ role: 'tool', tool_call_id: tc.id, content: result.length > 4000 ? result.slice(0, 4000) + '\n...(truncated)' : result });
    }
  }
  return (responseText || '(sub-agent hit max turns)') + '\n\n⚠️ Sub-agent reached max turns.';
}

async function spawnSubAgent(task, cwd, provider = null, model = null, options = {}) {
  const prov = provider || process.env.DEFAULT_PROVIDER || process.env.HAKSTER_PROVIDER || 'ollama';
  const cfg = PROVIDERS[prov] || PROVIDERS['ollama'];
  if (!cfg) return 'Error: No provider configured for sub-agent';

  // Ollama's OpenAI-compat endpoint is /v1/chat/completions — the OpenAI SDK
  // appends /chat/completions to baseURL, so make sure baseURL ends with /v1.
  let baseURL = cfg.baseURL;
  if (cfg.type === 'openai-compat' && !/\/v1\/?$/.test(baseURL)) {
    baseURL = baseURL.replace(/\/?$/, '') + '/v1';
  }

  const client = new OpenAI({
    apiKey: cfg.apiKey || 'ollama',
    baseURL,
  });

  const subModel = model || cfg.defaultModel || (cfg.type === 'openai-compat' ? 'glm-5.2:cloud' : 'gpt-oss:120b-cloud');

  // Build machine context for the sub-agent
  let dirListing = '';
  try {
    dirListing = fs.readdirSync(cwd).map(f => {
      try { return fs.statSync(path.join(cwd, f)).isDirectory() ? f + '/' : f; } catch { return f; }
    }).join('\n');
  } catch { dirListing = '(unreadable)'; }

  const role = getAgentRole(options.agentType);
  const roleBrief = role ? `\n\nSPECIALIST ROLE: ${role.name} (@${role.handle}) — ${role.focus}.\n${role.prompt}` : '';
  const subSystemPrompt = `${AGENT_SYSTEM_PROMPT}${roleBrief}

You are a SUB-AGENT handling a focused sub-task. Be concise and direct. Complete the task and report results.

=== MACHINE CONTEXT ===
OS: ${os.type()} ${os.release()} (${os.arch()})
Hostname: ${os.hostname()}
CWD: ${cwd}
Home: ${os.homedir()}
Files in CWD:
${dirListing}
=== END MACHINE CONTEXT ===`;

  const messages = [{ role: 'system', content: subSystemPrompt }];

  try {
    const sessionId = require('crypto').randomUUID();
    const session = { client, model: subModel, cwd, messages, role: role?.id || null, updatedAt: Date.now() };
    const result = await runSubAgent(session, task);
    SUBAGENT_SESSIONS.set(sessionId, session);
    while (SUBAGENT_SESSIONS.size > MAX_SUBAGENT_SESSIONS) SUBAGENT_SESSIONS.delete(SUBAGENT_SESSIONS.keys().next().value);
    return `Delegated${role ? ` to ${role.name} (@${role.handle})` : ''}. session_id=${sessionId}\n\n${result}`;
  } catch (err) {
    return `Error: Sub-agent failed: ${err.message}`;
  }
}

async function followupSubAgent(sessionId, message) {
  const session = SUBAGENT_SESSIONS.get(String(sessionId || ''));
  if (!session) return 'Error: sub-agent session not found or expired (sessions are in-memory and expire when the server restarts).';
  try {
    const result = await runSubAgent(session, String(message || ''));
    session.updatedAt = Date.now();
    return `Follow-up from ${session.role ? `@${session.role}` : 'sub-agent'} (session_id=${sessionId}):\n\n${result}`;
  } catch (err) {
    return `Error: sub-agent follow-up failed: ${err.message}`;
  }
}

module.exports = { spawnSubAgent, followupSubAgent };
