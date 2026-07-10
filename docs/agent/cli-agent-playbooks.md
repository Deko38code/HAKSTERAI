# CLI Agent Playbooks And Cheatsheets

This is the operator map for using multiple CLI agents together inside HaksterAI. It covers Codex, Hermes/Nous, Claude, Kiro CLI, OpenCode, Aider, Gemini-style CLI agents, Ollama/local agents, and Hakster's own web/terminal agents.

Use this alongside:

- `docs/agent/cli-agent-tool-loop.md`
- `docs/agent/tool-call-map.md`

## Quick Router

| Agent | Best For | Avoid For | Primary Tool Shape |
| --- | --- | --- | --- |
| Hakster Web Agent | Browser chat, SSE tool output, file delivery, user-facing workflows | Huge terminal-only workflows | Normalized internal tools -> provider adapter |
| Hakster Terminal Agent | Local machine ops, PM2, filesystem, TUI, sub-agents | Browser-only UX inspection unless browser tool is active | Ollama/OpenAI-compatible `tool_calls` |
| Codex | Repo edits, code review, test-driven fixes, patch discipline | Blind web research without docs/context | OpenAI-compatible `tool_calls` |
| Hermes/Nous | Fast chat, red-team persona, OpenAI-compatible cloud fallback | Complex verified code edits without tool loop | OpenAI-compatible `tool_calls` when supported |
| Claude | Planning, architecture, code reasoning, safe tool use | Raw OpenAI `tool_calls` without adapter | Anthropic `tool_use` / `tool_result` |
| Kiro CLI | Custom agents, hooks, steering, MCP, CI/headless automation | Unbounded ad hoc loops without hook state | CLI custom agents + hooks |
| OpenCode | Lightweight terminal coding agent with config-driven tools | High-risk production changes without review | OpenAI-compatible/MCP-style tools depending setup |
| Aider | Git-based pair programming, file-scoped edits | Multi-service ops orchestration | Chat + repo map + git diff/commit |
| Gemini CLI | Big-context exploration and planning | Precision patching without verification | CLI tool calls / extensions / MCP style |
| Ollama Local | Private/local model loops and offline tasks | Tasks needing current web/cloud APIs | OpenAI-compatible or native Ollama tool calls |

## Golden Workflow

1. Classify task: code edit, ops, research, UI, security, docs, or orchestration.
2. Select agent and model based on task.
3. Load context: repo files, prompt docs, steering files, memory, and active service details.
4. Use a bounded tool loop with duplicate-call detection.
5. Edit with the smallest safe patch.
6. Verify with syntax/test/build/health/UI check.
7. Commit and push only intended files.

## Codex Playbook

Use Codex for disciplined codebase changes.

Best prompts:

```text
Inspect the repo first, then implement the smallest safe change for <goal>.
Preserve unrelated dirty files. Verify with the narrowest useful command.
Commit only the intended files.
```

Tool call map:

| Need | Tool Call | Notes |
| --- | --- | --- |
| Find files | `exec_shell: rg --files ...` | Prefer bounded globs |
| Find symbols | `exec_shell: rg -n "symbol" path` | Avoid recursive grep |
| Read file | `read_file` or `exec_shell: sed -n` | Use line windows |
| Edit file | `apply_patch` / `edit_file` | Never broad rewrite unless needed |
| Verify JS | `exec_shell: node -c file.js` | Good for CommonJS server files |
| Verify frontend | `exec_shell: npm run build` | Run after Astro/UI changes |
| Push | `git add <files>`, `git commit`, `git push` | Stage scoped files only |

Loop guards:

- Stop after 2 repeated searches for the same symbol.
- Never stage all files in a dirty worktree.
- If a test fails, inspect the exact failure before changing another file.
- If a command hits sandbox/network limits, request escalation once with a clear reason.

Hakster config:

```json
{
  "provider": "codex",
  "model": "openai/gpt-5.5"
}
```

## Hermes / Nous Playbook

Use Hermes/Nous for fast OpenAI-compatible chat and cloud model fallback.

Provider shapes:

```json
{
  "provider": "nous",
  "baseURL": "https://inference-api.nousresearch.com/v1",
  "model": "nousresearch/hermes-4-70b"
}
```

```json
{
  "provider": "codex",
  "baseURL": "https://inference-api.nousresearch.com/v1",
  "model": "~anthropic/claude-fable-latest"
}
```

Tool call map:

| Need | Tool Call | Notes |
| --- | --- | --- |
| Chat completion | `POST /v1/chat/completions` | OpenAI-compatible body |
| Tool loop | `tools: [{ type: "function", function: ... }]` | Only when model/provider supports tool calls |
| Stream | `stream: true` | Accumulate chunks by tool index |
| Final answer | No `tool_calls` | End loop |
| Retry | Change model or reduce context | Do not replay same failed body blindly |

Loop guards:

- Normalize model IDs; some providers use `~vendor/model-latest`.
- Do not paste API keys into docs, prompts, logs, commits, or screenshots.
- If a model ignores tool specs, route through Hakster's server-side tool loop or use a different model.
- Keep model output caps lower for tool loops so the agent returns control quickly.

Cheatsheet:

```bash
curl -s "$NOUS_BASE_URL/chat/completions" \
  -H "Authorization: Bearer $NOUS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"nousresearch/hermes-4-70b","messages":[{"role":"user","content":"ping"}],"max_tokens":128}'
```

## Claude Playbook

Use Claude for high-quality planning, careful code reasoning, and native tool-use.

Tool call map:

| Need | Anthropic Shape | Hakster Internal Shape |
| --- | --- | --- |
| Tool request | `content[].type = "tool_use"` | `assistant.tool_calls[]` |
| Tool id | `tool_use.id` | `tool_call_id` |
| Tool args | `tool_use.input` object | `function.arguments` JSON string |
| Tool result | user message with `tool_result` | `role: "tool"` |
| Text | `content[].type = "text"` | `content` string |

Native Claude tool request:

```json
{
  "role": "assistant",
  "content": [
    { "type": "text", "text": "I will inspect the server entrypoint." },
    {
      "type": "tool_use",
      "id": "toolu_01",
      "name": "read_file",
      "input": { "path": "server/src/index.js", "offset": 1, "limit": 120 }
    }
  ]
}
```

Tool result:

```json
{
  "role": "user",
  "content": [
    {
      "type": "tool_result",
      "tool_use_id": "toolu_01",
      "content": "file lines..."
    }
  ]
}
```

Loop guards:

- Preserve text blocks; empty tool-only turns are loop risk.
- Convert image blocks when crossing OpenAI/Anthropic formats.
- Do not send OpenAI `tool_calls` directly to Claude without adapter conversion.
- Stop if Claude asks the same clarification twice.

## Kiro CLI Playbook

Use Kiro CLI when you want custom agents, steering files, tool permissions, MCP, and hooks.

Core files:

| File | Purpose |
| --- | --- |
| `.kiro/agents/*.json` | Custom agent config |
| `.kiro/steering/*.md` | Reusable steering/context |
| `.kiro/hooks/*` or `hooks` config | Pre/post tool guards |
| `.kiro/state/*.json` | Loop-state cache for hooks |
| `mcp.json` | MCP server config when included |

Custom agent shape:

```json
{
  "name": "hakster-coder",
  "description": "Scoped coding agent with loop guards.",
  "prompt": "file://../../docs/agent/cli-agent-playbooks.md",
  "tools": ["fs_read", "fs_write", "execute_bash"],
  "allowedTools": ["fs_read"],
  "includeMcpJson": true,
  "hooks": [
    {
      "event": "preToolUse",
      "command": "node .kiro/hooks/pre-tool-loop-guard.js"
    },
    {
      "event": "postToolUse",
      "command": "node .kiro/hooks/post-tool-progress-score.js"
    }
  ]
}
```

Hook event map:

| Event | Use |
| --- | --- |
| `agentSpawn` / `SessionStart` | Initialize loop state and context |
| `userPromptSubmit` | Reject destructive or underspecified prompts |
| `preToolUse` / `PreToolUse` | Block duplicate, dangerous, or out-of-scope calls |
| `postToolUse` / `PostToolUse` | Score progress and record result signatures |
| `stop` / `Stop` | Emit completion score, summary, and unresolved blockers |

Blocking policy:

- Exit `0`: allow.
- Exit `2`: block and return STDERR to the agent.
- Any other exit: warn, but do not depend on it for policy.

Kiro tool map:

| Kiro Tool Family | Hakster Equivalent | Guard |
| --- | --- | --- |
| `fs_read` | `read_file` | Allow by default, but cap repeats |
| `fs_write` | `write_file` / `edit_file` | Require scope and path validation |
| `execute_bash` | `exec_shell` | Timeout and dangerous command gate |
| MCP tool | `mcp:*` | Validate server/tool name and args |
| Web/search tool | `web_search` / `firecrawl_scrape` | Cap repeated broad queries |

## OpenCode Playbook

Use OpenCode-style agents as lightweight terminal coding workers.

Best for:

- Isolated file edits.
- Small refactors.
- Secondary model review.
- Running local commands from a repo root.

Tool call map:

| Need | Pattern |
| --- | --- |
| Read | file/read tool or shell `sed -n` |
| Edit | patch/edit tool preferred |
| Shell | explicit command tool with timeout |
| Search | ripgrep first |
| Verify | project test/build command |

Loop guards:

- Force a plan -> edit -> verify lifecycle.
- Stop after one failed patch and re-read context.
- Do not let the agent run formatter/build loops more than twice.

## Aider Playbook

Use Aider for git-aware pair programming and file-scoped changes.

Cheatsheet:

```bash
aider path/to/file.js path/to/test.js
aider --model <model> --message "Fix the failing test and commit only this fix."
aider --read README.md --read package.json src/file.ts
```

Workflow:

1. Add only relevant files to the Aider session.
2. Ask for a single change.
3. Review diff.
4. Run tests outside or inside Aider.
5. Commit intentionally.

Loop guards:

- Keep file set small.
- If Aider edits the wrong file, stop and reset the session context.
- Never let it auto-commit broad changes in a mixed worktree.

## Gemini CLI Playbook

Use Gemini-style CLI agents for broad context exploration, summarization, and planning with large context.

Best for:

- Reading large docs.
- Understanding broad architecture.
- Comparing many files.
- Drafting plans/specs.

Avoid for:

- Final production edits without a narrower verification agent.
- Secret-heavy files unless redaction is guaranteed.

Tool call map:

| Need | Pattern |
| --- | --- |
| Broad repo context | workspace/file context |
| Current docs | web/search tool |
| Local verification | shell tool with timeout |
| Final patch | hand off to Codex/Hakster edit loop |

Loop guards:

- Convert broad findings into a concise task list.
- Do not let broad context become broad edits.
- Require exact files and exact verification before handoff.

## Ollama / Local Agent Playbook

Use local models when privacy, offline work, or low-cost iteration matters.

Provider shape:

```json
{
  "provider": "ollama",
  "baseURL": "http://localhost:11434",
  "model": "gpt-oss:120b-cloud"
}
```

Tool call map:

| Need | Pattern |
| --- | --- |
| Native Ollama chat | `/api/chat` |
| OpenAI-compatible chat | `/v1/chat/completions` |
| Tool calls | Model-dependent `tool_calls` |
| Streaming | Native JSON lines or SSE adapter |

Loop guards:

- Detect empty tool-only responses and retry once after compaction.
- Convert tool arguments from object to JSON string if the loop expects OpenAI shape.
- Keep context smaller than cloud model defaults.
- Prefer deterministic local shell checks over model guesses.

## Hakster Web Agent Playbook

Entry point:

- `POST /api/agent/run`

Provider adapters:

| Provider | Adapter |
| --- | --- |
| `ollama` | OpenAI-compatible stream fetch |
| `codex` | OpenAI-compatible SDK |
| `nous` | OpenAI-compatible SDK |
| `anthropic` | Anthropic `tool_use` adapter |
| `claude-proxy` | Anthropic proxy adapter |

SSE event map:

| Event | UI Use |
| --- | --- |
| `delta` | Assistant text |
| `thinking_start` / `thinking` / `thinking_end` | Reasoning panel |
| `tool_call_start` | Tool activity row |
| `shell_start` | Terminal block begins |
| `shell_data` | Live stdout/stderr |
| `shell_end` | Terminal block status |
| `tool_call_result` | Tool result message |
| `file_created` | Download button |
| `image` | Inline image preview |
| `needs_confirmation` | Approval UI |
| `loop_detected` | Loop warning |
| `turn_end` | Step boundary |
| `done` | Stream close |

## Hakster Terminal Agent Playbook

Entry point:

- `server/src/agent/index.js`

Best for:

- Local PM2/service operations.
- TUI-visible command chains.
- Shell-heavy work.
- Sub-agent orchestration.

Key loop protections:

- `NO_PROGRESS_LIMIT`
- `SEMANTIC_LOOP_WINDOW`
- `TOOL_ERROR_LOOP_LIMIT`
- grep/search loop tracking
- filesystem wandering tracking
- stale queue draining
- fake TUI/status stripping
- dangerous command confirmation

## Cross-Agent Tool Call Map

| Internal Need | Hakster Tool | Claude | Codex/OpenAI | Kiro CLI | Aider | Local/Ollama |
| --- | --- | --- | --- | --- | --- | --- |
| Read file | `read_file` | `tool_use: read_file` | `tool_calls[].function.name` | `fs_read` | add file/read | native/openai tool |
| Edit file | `edit_file` | `tool_use: edit_file` | function call | `fs_write` | patch diff | native/openai tool |
| Write file | `write_file` | `tool_use: write_file` | function call | `fs_write` | edit/create | native/openai tool |
| Run shell | `exec_shell` | `tool_use: exec_shell` | function call | `execute_bash` | `/run` or shell | shell tool |
| Search web | `web_search` | tool_use | function call | web/MCP | external | MCP/tool |
| Scrape URL | `firecrawl_scrape` | tool_use | function call | MCP/web | external | MCP/tool |
| Spawn helper | `spawn_agent` | tool_use | function call | subagent/custom agent | separate aider session | separate process |
| Ask approval | `needs_confirmation` | tool result text | SSE event | hook exit 2 | human prompt | human prompt |
| Stop loop | `loop_detected` | system nudge | system nudge | hook block | stop/restart session | compact/retry |

## Prompt Snippets

Codex:

```text
Act as a repo-safe coding agent. Inspect first. Preserve unrelated changes.
Use bounded shell commands. Patch only intended files. Verify before final.
If any tool call repeats or fails twice, change strategy instead of retrying.
```

Hermes/Nous:

```text
Use concise tool calls. Prefer one inspection, one patch, one verification.
Do not claim a command ran unless a tool result confirms it.
Return final only after no tool calls are needed.
```

Claude:

```text
Use native tool_use blocks for filesystem, shell, web, and memory actions.
Always include a text explanation with tool_use. Stop repeated clarifications.
```

Kiro:

```text
Follow the prompt file and hook policy. PreToolUse may block repeated or risky calls.
If blocked, summarize the blocker and choose a different safe action.
```

## References

- Codex / OpenAI CLI docs: https://developers.openai.com/codex/cli/
- Claude Code docs: https://docs.anthropic.com/en/docs/claude-code/
- Kiro CLI docs: https://kiro.dev/docs/cli/
- Kiro hooks: https://kiro.dev/docs/hooks/
- Kiro custom agents: https://kiro.dev/docs/cli/custom-agents/
- Aider docs: https://aider.chat/docs/
- OpenCode docs: https://opencode.ai/docs/
