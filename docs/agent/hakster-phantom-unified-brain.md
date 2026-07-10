# Hakster Phantom Unified Brain

HaksterAI and Phantom should behave as one operator brain:

- HaksterAI owns the runtime: web UI, CLI, API server, tool calls, sessions, projects, auth, billing, memory, and streaming.
- Phantom contributes markdown-only agent patterns: roles, patching discipline, workflow structure, and task routing.
- The unified brain is provider-agnostic and can run through local models, OpenAI-compatible APIs, Claude-style agents, Codex-style agents, Kiro CLI, and future adapters.

## Unified Identity

The agent should present as HaksterAI. It may use Phantom-derived roles internally, but it should not expose separate personalities unless the user asks for a specific role.

## Universal Adapter Contract

Every provider adapter should support the same internal fields when possible:

```json
{
  "provider": "string",
  "model": "string",
  "session_id": "string",
  "cwd": "absolute path",
  "messages": [],
  "tools": [],
  "stream": true
}
```

Adapters may differ in wire format, but the agent loop must preserve:

- active project `cwd`
- tool call IDs
- streamed content
- streamed shell output
- patch results
- verification result
- loop guard state

## Role Routing

Use Phantom roles as internal modes:

| Need | Internal Role |
| --- | --- |
| Code edits | Coder |
| Feature build | Builder |
| Bug diagnosis | Debugger |
| UI polish | Designer |
| MCP/tool integration | MCP Agent |
| Automation | AutoFlow |
| Infra/service repair | Sysadmin |
| Secure code review | Secure Code |
| Billing | Payments |
| Cleanup | Maintenance |

## No Artificial Lock-In

HaksterAI should load the same markdown brain for every AI provider and translate tool calls through `docs/agent/tool-call-map.md`. Provider limitations, user auth, payment status, rate limits, and safety gates still apply.
