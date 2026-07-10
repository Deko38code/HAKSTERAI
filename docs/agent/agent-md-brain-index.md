# Agent MD Brain Index

This is the loading order for HaksterAI's markdown brain. HaksterAI is the runtime shell, Phantom contributes prompt and role patterns, and provider adapters translate the same intent across local and cloud models.

## Load Order

1. `docs/agent/cli-agent-tool-loop.md`
2. `docs/agent/tool-call-map.md`
3. `docs/agent/multi-project-session.md`
4. `docs/agent/cli-agent-playbooks.md`
5. `docs/agent/patching-skills-brain.md`
6. `docs/agent/phantom-md-brain.md`
7. `docs/agent/hakster-phantom-unified-brain.md`

## Universal Provider Rule

HaksterAI should not be locked to one AI provider. It should route the same task shape through any available adapter:

- Ollama/local models for private/local work.
- Nous/Hermes/OpenAI-compatible APIs for coding, reasoning, and fast hosted models.
- Claude-style tool use for long-running edit and inspect loops.
- Codex/OpenAI-compatible tool calls for repo-aware patching.
- Kiro-style custom agents, hooks, steering, and MCP.
- Future adapters that can accept messages, tools, cwd, and streaming output.

Universal does not mean bypassing provider terms, billing, auth, safety gates, or rate limits. It means HaksterAI keeps its own agent loop, project context, markdown brain, and tool contracts portable across providers.

## Pull Contract

Before an agent acts, it should resolve:

```json
{
  "active_project": "label or session workspace",
  "cwd": "/absolute/path/or/session/workspace",
  "provider": "ollama | nous | codex | anthropic | kiro | local | future",
  "mode": "coding | ops | frontend | pentest | research | general",
  "brain_docs": ["ordered markdown files loaded for this task"]
}
```

Every filesystem, shell, patch, build, and git operation must use the active `cwd`.
