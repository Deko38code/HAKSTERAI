/**
 * Cloud sub-agent spawner for haksterAi.
 * Creates a focused OpenAI-compatible client call with limited turns (max 3)
 * to handle delegated sub-tasks within the agent loop.
 */

const { OpenAI } = require('openai');
const { PROVIDERS, AGENT_TOOLS, AGENT_SYSTEM_PROMPT, executeAgentTool } = require('./providers');
const os = require('os');
const fs = require('fs');
const path = require('path');

async function spawnSubAgent(task, cwd, provider = null, model = null) {
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

  const subSystemPrompt = `${AGENT_SYSTEM_PROMPT}

You are a SUB-AGENT handling a focused sub-task. Be concise and direct. Complete the task and report results.

=== MACHINE CONTEXT ===
OS: ${os.type()} ${os.release()} (${os.arch()})
Hostname: ${os.hostname()}
CWD: ${cwd}
Home: ${os.homedir()}
Files in CWD:
${dirListing}
=== END MACHINE CONTEXT ===`;

  const messages = [
    { role: 'system', content: subSystemPrompt },
    { role: 'user', content: task },
  ];

  const maxSubTurns = 3;
  // No spawn_agent inside sub-agent — prevent infinite nesting
  const subTools = AGENT_TOOLS.filter(t => t.function.name !== 'spawn_agent');

  try {
    for (let turn = 0; turn < maxSubTurns; turn++) {
      const response = await client.chat.completions.create({
        model: subModel,
        messages,
        tools: subTools,
        tool_choice: turn < maxSubTurns - 1 ? 'auto' : 'none',
      });

      const choice = response.choices[0];
      const assistantMsg = choice.message;
      messages.push(assistantMsg);

      // If no tool calls, we're done
      if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
        return assistantMsg.content || '(sub-agent completed with no text output)';
      }

      // Execute each tool call
      for (const tc of assistantMsg.tool_calls) {
        const toolName = tc.function.name;
        let toolArgs;
        try { toolArgs = JSON.parse(tc.function.arguments); } catch { toolArgs = {}; }

        const result = await executeAgentTool(toolName, toolArgs, cwd);
        const truncated = result.length > 4000 ? result.slice(0, 4000) + '\n...(truncated)' : result;

        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: truncated,
        });
      }
    }

    // Max turns reached — return last assistant content
    const lastAssistant = messages.filter(m => m.role === 'assistant').pop();
    return (lastAssistant?.content || '(sub-agent hit max turns)') + '\n\n⚠️ Sub-agent reached max turns.';
  } catch (err) {
    return `Error: Sub-agent failed: ${err.message}`;
  }
}

module.exports = { spawnSubAgent };