# Kiro CLI — Reference for haksterAi

> Extracted from kiro.dev docs. Last updated: 2026-07.

## 1. Overview

Kiro is an AI IDE + CLI agent by Amazon. It has the most sophisticated custom agent definition format, the deepest hook system, and the most granular tool permission model of any agent platform. Key differentiators: steering files, powers, DAG-based subagent orchestration, and YAML permission rules.

## 2. Installation

```bash
# macOS / Linux
curl -fsSL https://cli.kiro.dev/install | bash

# Windows (PowerShell)
irm 'https://cli.kiro.dev/install.ps1' | iex
```

Auth: Browser-based (GitHub, Google, AWS Builder ID, AWS IAM) or API key (`KIRO_API_KEY`).

## 3. Custom Agents

### IDE Agents (Markdown + YAML frontmatter)

Stored in `.kiro/agents/` (workspace) or `~/.kiro/agents/` (global):

```markdown
---
description: Backend development agent
model: claude-sonnet-4
tools: [read, write, shell, web]
mcpServers:
  postgres:
    command: npx
    args: ["-y", "@modelcontextprotocol/server-postgres"]
    env:
      DATABASE_URL: "${DATABASE_URL}"
permissions:
  rules:
    - capability: shell
      effect: allow
      match:
        - "npm *"
        - "node *"
---

You are a backend developer focused on Node.js and TypeScript.
Always use async/await. All database queries must be parameterized.
```

### CLI Agents (JSON)

Full JSON configuration in `.kiro/agents/`:

```json
{
  "name": "backend-specialist",
  "description": "Backend coding specialist",
  "prompt": "file://./prompts/backend.md",
  "model": "claude-sonnet-4",
  "tools": ["read", "write", "shell", "@git", "@builtin"],
  "toolAliases": {},
  "allowedTools": ["read", "write", "shell"],
  "toolsSettings": {
    "write": { "allowedPaths": ["src/**", "tests/**"] },
    "shell": { "allowedCommands": ["npm *", "node *"], "deniedCommands": ["rm *"], "autoAllowReadonly": true }
  },
  "resources": [
    "file://.kiro/steering/**/*.md",
    "skill://.kiro/skills/*/SKILL.md"
  ],
  "mcpServers": {},
  "hooks": [],
  "includeMcpJson": true,
  "keyboardShortcut": "ctrl+a",
  "welcomeMessage": "Backend specialist ready."
}
```

**Tool tags:** `read`, `write`, `shell`, `web`, `subagent`, `context`, `@mcp`, `@builtin`, `*`

**Resources:** `file://`, `skill://`, `knowledgeBase` objects. Skills are progress-loaded — metadata at startup, full content on demand.

**Disabling default inheritance:** `kiro-cli settings chat.disableInheritingDefaultResources true`

## 4. Hooks

### IDE Hooks (JSON in `.kiro/hooks/`)

```json
{
  "version": "v1",
  "hooks": [
    {
      "name": "lint-on-save",
      "trigger": "PostFileSave",
      "matcher": "\\.ts$",
      "action": { "type": "command", "command": "npm run lint" },
      "timeout": 30,
      "enabled": true
    }
  ]
}
```

### IDE Hook Triggers (10 types)

| Trigger | Fires when | Can block? |
|---------|-----------|------------|
| `SessionStart` | Session begins | No |
| `Stop` | Agent completes turn | No |
| `PreToolUse` | Before tool executes | Yes (exit 2) |
| `PostToolUse` | After tool executes | No |
| `PreTaskExec` | Before spec task starts | Yes (exit 2) |
| `PostTaskExec` | After spec task finishes | No |
| `UserPromptSubmit` | User submits prompt | Yes (exit 2) |
| `PostFileCreate` | File created by agent | No |
| `PostFileSave` | File saved by agent | No |
| `PostFileDelete` | File deleted by agent | No |

### CLI Hooks (in agent config `hooks` field)

JSON via STDIN. Hook events: `agentSpawn`, `userPromptSubmit`, `preToolUse`, `postToolUse`, `stop`.

**Stop hook can prevent stopping** by returning:
```json
{"decision": "block", "reason": "You haven't run the tests yet."}
```

**Exit codes:** 0 = success, 2 = block (PreToolUse/UserPromptSubmit/PreTaskExec), other = warning.

**Tool matcher:** `fs_write`/`write`, `fs_read`/`read`, `execute_bash`/`shell`, `@git`, `@git/status`, `*`, `@builtin`.

**Caching:** `cache_ttl_seconds` — 0 = no cache (default), >0 = cache results for N seconds.

## 5. Steering Files

Markdown files in `.kiro/steering/` (workspace) or `~/.kiro/steering/` (global).

**Foundational files** (auto-generated):
- `product.md` — Product purpose, users, features, business objectives
- `tech.md` — Frameworks, libraries, dev tools, technical constraints
- `structure.md` — File organization, naming conventions, import patterns

**Inclusion modes** (YAML frontmatter):

```yaml
# Always included (default)
---
inclusion: always
---

# Conditional — included when working with matching files
---
inclusion: fileMatch
fileMatchPattern: "components/**/*.tsx"
---

# Manual — on-demand via #filename
---
inclusion: manual
---

# Auto — included when request matches description
---
inclusion: auto
name: api-design
description: REST API design patterns. Use when creating or modifying API endpoints.
---
```

**AGENTS.md support:** Kiro reads AGENTS.md files from `~/.kiro/steering/` or workspace root. Always included.

## 6. Skills

SKILL.md format with YAML frontmatter in `.kiro/skills/`:

```markdown
---
name: pr-review
description: Review pull requests for code quality, security issues, and test coverage.
---

## Review process
1. Check for security vulnerabilities
2. Verify error handling
3. Confirm test coverage
```

**Directory structure:**
```
my-skill/
├── SKILL.md
├── scripts/
├── references/
└── assets/
```

**Skill argument passing:** If SKILL.md contains `$ARGUMENTS` or `${N}`, text after slash command is substituted.

## 7. MCP

Configuration via `.kiro/settings/mcp.json`:

```json
{
  "mcpServers": {
    "local-server": {
      "command": "command-to-run-server",
      "args": ["arg1"],
      "env": { "KEY": "value" },
      "disabled": false
    },
    "remote-server": {
      "url": "https://api.example.com/mcp",
      "oauth": {
        "clientId": "your-client-id",
        "redirectUri": "http://127.0.0.1:8080/oauth/callback",
        "oauthScopes": ["read", "write"]
      }
    }
  }
}
```

**Tool validation:** Names ≤64 chars, match `^[a-zA-Z][a-zA-Z0-9_]*$`, non-empty descriptions. Descriptions >10K chars produce warnings.

## 8. Tool Permissions

### IDE Permissions (YAML)

```yaml
rules:
  - capability: shell
    effect: allow
    match: ["git *", "npm *", "npx *"]
  - capability: fs_write
    effect: allow
    match: ["src/**", "tests/**"]
  - capability: filesystem
    effect: deny
    match: [".env", "secrets/**"]
```

**Effect resolution:** deny > ask > allow.

**Capabilities:** `fs_read`, `fs_write`, `filesystem`, `shell`, `web_fetch`, `web_search`, `mcp` (pattern: `server/tool`), `subagent`, `skill`, `power`, `diagnostics`, `context`, `all`, `builtin`.

### CLI Trust Tiers

Shell trust tiers: Full command → Partial (command + subcommand + `*`) → Base command → Entire tool.

Read/Write path trust: Specific paths → Directory → Entire tool.

### Agent-Level Permissions (CLI JSON)

```json
{
  "allowedTools": ["read", "@git/git_status"],
  "toolsSettings": {
    "write": { "allowedPaths": ["src/**", "tests/**"] },
    "shell": { "allowedCommands": ["git status", "npm test"], "deniedCommands": ["rm *"], "autoAllowReadonly": true }
  }
}
```

## 9. Subagents

- Main agent can spawn up to 4 subagents at once
- Default subagent has same tools as main agent
- Custom agent subagents use that agent's `tools`, `toolsSettings`, `allowedTools`
- **Task dependencies (DAG):** Main agent plans a task graph. Independent tasks run in parallel; dependent tasks wait for predecessors.
- **Review loops:** Stages can loop back based on trigger text (e.g., `NEEDS_CHANGES`). Max 10 iterations.
- Configured via `toolsSettings.subagent.availableAgents` and `trustedAgents`

## 10. Headless Mode (CI/CD)

```bash
kiro-cli chat --no-interactive "your prompt here"
kiro-cli chat --no-interactive --trust-all-tools "Write tests for auth module"
kiro-cli chat --no-interactive --trust-tools=read,grep "Find all TODOs"
```

GitHub Actions example:
```yaml
- name: Review PR changes
  env:
    KIRO_API_KEY: ${{ secrets.KIRO_API_KEY }}
  run: kiro-cli chat --no-interactive --trust-tools=read,grep "Review the changes in this PR"
```

## 11. Patterns Worth Adopting for haksterAi

1. **Granular YAML permission rules** — `capability` + `effect` + `match` patterns with deny>ask>allow resolution is the gold standard.

2. **Steering files with inclusion modes** — always/fileMatch/manual/auto is elegant. haksterAi's `docs/agent/` files should support similar scoping.

3. **DAG-based subagent orchestration** — Task dependency graphs with parallel execution and review loops. haksterAi's AutoFlow could adopt this.

4. **Stop hook preventing agent from stopping** — Returning `{"decision": "block", "reason": "..."}` is a powerful guardrail pattern.

5. **Cached hook results** — `cache_ttl_seconds` avoids re-running expensive hooks for repeated tool calls.

6. **Tool trust tiers** — Graduated trust from exact command → wildcards → entire tool. haksterAi's approval modes should be this granular.

7. **Knowledge base resources** — `knowledgeBase` objects with `indexType` and `autoUpdate` for on-demand context loading.

8. **Powers** — Bundles of MCP tools + knowledge + workflows that activate dynamically. A higher-level composability unit than skills alone.

9. **Specs workflow** — Three-phase (requirements → design → tasks) with dependency graphs and wave-based execution. Maps well to haksterAi's AutoFlow.

10. **Delegate (background tasks)** — Natural language task delegation with progress tracking. haksterAi should support background agent tasks.