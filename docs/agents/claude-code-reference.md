# Claude Code CLI — Reference for haksterAi

> Extracted from Anthropic docs. Last updated: 2026-07.

## 1. Overview

Claude Code is Anthropic's CLI agent. It uses CLAUDE.md files (like AGENTS.md) for project context, has a rich hooks system, sandboxing, MCP integration, skills, subagents, and fine-grained permissions.

## 2. Installation

```bash
# macOS / Linux / WSL
curl -fsSL https://claude.ai/install.sh | bash

# Windows PowerShell
irm https://claude.ai/install.ps1 | iex

# Homebrew
brew install --cask claude-code
```

Start: `claude` in project directory.

## 3. CLI Commands

| Command | Description |
|---------|-------------|
| `claude` | Start interactive session |
| `claude "query"` | Start with initial prompt |
| `claude -p "query"` | Non-interactive print mode |
| `claude -c` | Continue most recent conversation |
| `claude -r "<id>" "query"` | Resume session |
| `claude update` | Update to latest |
| `claude auth login/logout/status` | Auth management |
| `claude mcp add/remove/list` | MCP server management |
| `claude doctor` | Diagnostics |
| `claude agents` | Open agent view |

## 4. Key CLI Flags

| Flag | Description |
|------|-------------|
| `--add-dir <path>` | Add working directories |
| `--agent <name>` | Run as named subagent |
| `--agents '<json>'` | Define subagents dynamically |
| `--allowedTools` / `--disallowed-tools` | Tool allow/deny lists |
| `--append-system-prompt` | Append to system prompt |
| `--system-prompt` | Replace entire system prompt |
| `--bg` | Start as background agent |
| `--dangerously-skip-permissions` | Skip permission prompts |
| `--effort <level>` | low/medium/high/xhigh/max/ultracode |
| `--model` | Set model |
| `--permission-mode` | default/acceptEdits/plan/auto/dontAsk/bypassPermissions |
| `--print` / `-p` | Non-interactive print mode |
| `--safe-mode` | Disable all customizations |
| `--worktree` | Start in isolated git worktree |
| `--tools` | Restrict available tools |

## 5. CLAUDE.md System

### Scopes (loaded in order)

| Scope | Location | Purpose |
|-------|----------|---------|
| Managed policy | `/Library/Application Support/ClaudeCode/CLAUDE.md` or `/etc/claude-code/CLAUDE.md` | Organization-wide, IT-managed |
| User | `~/.claude/CLAUDE.md` | Personal preferences across all projects |
| Project | `./CLAUDE.md` or `./.claude/CLAUDE.md` | Team-shared project instructions |
| Local | `./CLAUDE.local.md` | Personal project-specific (gitignored) |

**Loading:** Walks up directory tree from cwd, loading all found CLAUDE.md files. Subdirectory files load on demand. Content concatenated root→cwd.

**Imports:** `@path/to/file` syntax imports additional files. Supports relative/absolute paths, recursive up to 4 hops.

### Path-Specific Rules (`.claude/rules/`)

```markdown
---
paths:
  - "src/api/**/*.ts"
---
# API Development Rules
- All endpoints must include input validation
```

### Auto Memory

Stored at `~/.claude/projects/<project>/memory/`. First 200 lines or 25KB of `MEMORY.md` loaded per session.

## 6. Settings

### Configuration Scopes (precedence high→low)

| Scope | Location | Shared? |
|-------|----------|---------|
| Managed | Server-managed or `/etc/claude-code/managed-settings.json` | Org-wide |
| Command line | CLI flags | Session-only |
| Local | `.claude/settings.local.json` | No (gitignored) |
| Project | `.claude/settings.json` | Yes (git) |
| User | `~/.claude/settings.json` | No |

### Key Settings

- **Permissions:** `allow`, `ask`, `deny` arrays with `Tool(specifier)` syntax
- **Sandbox:** Full OS-level isolation (Seatbelt/bubblewrap)
- **Hooks:** Defined in settings JSON
- **Environment:** `env` key for env vars
- **Model:** `model`, `effortLevel`, `fallbackModel`

## 7. Permission Modes

| Mode | Description |
|------|-------------|
| `default` | Prompts on first use of each tool |
| `acceptEdits` | Auto-accepts file edits and common commands |
| `plan` | Read-only exploration, no edits |
| `auto` | Auto-approves with background safety checks |
| `dontAsk` | Auto-denies unless pre-approved |
| `bypassPermissions` | Skips all prompts (danger zones only) |

### Rule Syntax

- `Bash(npm run *)`, `Bash(git commit *)` — wildcard matching
- `Read(./.env)`, `Edit(/src/**/*.ts)` — gitignore-style paths
- `WebFetch(domain:example.com)` — domain restrictions
- `mcp__puppeteer__*` — MCP tool patterns
- `Agent(Explore)` — subagent patterns

Evaluation order: deny → ask → allow.

## 8. Sandboxing

Uses Seatbelt (macOS) or bubblewrap (Linux/WSL2). Configuration:

```json
{
  "sandbox": {
    "enabled": true,
    "failIfUnavailable": true,
    "autoAllowBashIfSandboxed": true,
    "filesystem": {
      "allowWrite": ["/tmp/build"],
      "denyWrite": ["/etc"],
      "denyRead": ["~/.aws/credentials"],
      "allowRead": ["."]
    },
    "network": {
      "allowedDomains": ["github.com", "*.npmjs.org"],
      "deniedDomains": ["uploads.github.com"]
    },
    "credentials": {
      "files": [{"path": "~/.aws/credentials", "mode": "deny"}],
      "envVars": [{"name": "GH_TOKEN", "mode": "mask", "injectHosts": ["api.github.com"]}]
    }
  }
}
```

## 9. MCP Integration

- **Transports:** HTTP (recommended), SSE, stdio, WebSocket
- **Scopes:** Local (project), Project (`.mcp.json`), User (all projects)
- **Auth:** OAuth via `claude mcp login`, headers, dynamic header helpers
- **Auto-reconnection** with exponential backoff
- **Dynamic tool updates** via `list_changed` notifications
- **Tool search** for scaling to many tools

## 10. Hooks System

### Hook Events (30+ events)

| Event | When |
|-------|------|
| `SessionStart` | Session begins or resumes |
| `UserPromptSubmit` | User submits prompt |
| `PreToolUse` | Before tool executes (can block) |
| `PostToolUse` | After tool succeeds |
| `PostToolUseFailure` | After tool fails |
| `PostToolBatch` | After batch of parallel tool calls |
| `Stop` | Claude finishes responding |
| `SubagentStart` / `SubagentStop` | Subagent lifecycle |
| `Notification` | Claude sends notification |
| `InstructionsLoaded` | CLAUDE.md or rules file loads |
| `ConfigChange` | Settings file changes |
| `PreCompact` / `PostCompact` | Context compaction |
| `PermissionRequest` | Permission dialog appears |
| `PermissionDenied` | Auto mode denies a tool call |

### Hook Handler Types

| Type | Description |
|------|-------------|
| `command` | Shell command (stdin JSON, exit codes) |
| `http` | HTTP POST (JSON body, response) |
| `mcp_tool` | Call MCP server tool |
| `prompt` | Single-turn LLM evaluation |
| `agent` | Subagent with tools |

### Exit Codes

- **0**: Success, parse stdout for JSON output
- **2**: Blocking error, stderr shown to Claude
- **Other**: Non-blocking error, execution continues

### Example Hook

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "python3 scripts/validate-command.py"
          }
        ]
      }
    ]
  }
}
```

## 11. Skills

Markdown files (`SKILL.md`) with YAML frontmatter in `.claude/skills/` or `~/.claude/skills/`.

### Frontmatter

```yaml
---
name: my-skill
description: What the skill does; Claude uses this for auto-invocation
when_to_use: Additional context for auto-invocation
argument-hint: "target file"
arguments:
  - name: target
    description: File to process
disable-model-invocation: false
user-invocable: true
allowed-tools:
  - Bash(npm test *)
  - Edit
  - Read
disallowed-tools:
  - Bash(rm *)
context: fork  # run in isolated subagent
---
```

### Key Behaviors

- Invoked skills stay in context for the session
- Auto-compaction carries invoked skills within token budget (5K tokens each, 25K total)
- Skills override bundled skills with same name
- Live change detection for skill directories

## 12. Subagents

### Built-in Subagents

| Agent | Description |
|-------|-------------|
| Explore | Read-only, fast codebase exploration |
| Plan | Research agent for plan mode (read-only) |
| General-purpose | All tools, complex multi-step tasks |

### Custom Subagents

Markdown files with YAML frontmatter in `.claude/agents/` or `~/.claude/agents/`:

```yaml
---
name: backend-specialist
description: Backend development agent
tools: [Read, Edit, Write, Bash, Grep, Glob]
model: sonnet
permissionMode: acceptEdits
maxTurns: 50
mcpServers:
  postgres:
    command: npx
    args: ["-y", "@modelcontextprotocol/server-postgres"]
---

You are a backend specialist focusing on Node.js and databases.
Always parameterize queries. Handle errors properly.
```

### Subagent Memory

- `~/.claude/agent-memory/<name>/` — user scope
- `.claude/agent-memory/<name>/` — project scope
- `.claude/agent-memory-local/<name>/` — local scope

## 13. Built-in Tools

| Tool | Permission | Description |
|------|-----------|-------------|
| Agent | No | Spawn subagent |
| Bash | Yes | Execute shell commands (2min default, 10min max) |
| Edit | Yes | Targeted string replacement edits |
| Glob | No | Find files by pattern |
| Grep | No | Search file contents (ripgrep-based) |
| LSP | No | Language server intelligence |
| Read | No | Read file contents (images, PDFs, notebooks) |
| Write | Yes | Create/overwrite files |
| WebFetch | Yes | Fetch URL content |
| WebSearch | Yes | Web search |
| Workflow | Yes | Run dynamic workflow |

## 14. Key Environment Variables

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` | API key |
| `ANTHROPIC_BASE_URL` | Override API endpoint |
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY` | Disable auto memory |
| `CLAUDE_CODE_SUBAGENT_MODEL` | Override subagent model |
| `MCP_TIMEOUT` | MCP startup timeout (default 30s) |
| `BASH_DEFAULT_TIMEOUT_MS` | Default Bash timeout |
| `BASH_MAX_TIMEOUT_MS` | Max Bash timeout |

## 15. Patterns Worth Adopting for haksterAi

1. **CLAUDE.md/AGENTS.md with imports** — The `@path` import syntax and directory tree walking is elegant. haksterAi should support `@docs/agents/agent-brains.md` style imports.

2. **Permission rule syntax** — `Tool(specifier)` with deny→ask→allow evaluation order is powerful. haksterAi's FULL_AUTO mode should map to a similar rule engine.

3. **30+ hook events** — haksterAi's existing PreToolUse/PostToolUse hooks should expand to cover more lifecycle events (SessionStart, Stop, SubagentStart, etc.).

4. **Skills with frontmatter** — SKILL.md format with YAML frontmatter for name, description, allowed-tools, auto-invocation triggers. haksterAi has this already.

5. **Sandboxing** — Seatbelt/bubblewrap OS-level isolation for Bash commands. haksterAi should consider sandbox profiles.

6. **Subagent memory scopes** — user/project/local memory per agent is a clean pattern.

7. **Auto memory** — First 200 lines of MEMORY.md loaded per session. Simple but effective context injection.

8. **Effort levels** — low/medium/high/xhigh/max/ultracode controlling how much reasoning the agent invests. Useful for cost/speed control.