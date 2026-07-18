# Claude Code Secrets — Internal & Rare Documentation

> Scraped from `anthropics/claude-code` source repo. These are the hidden/rare markdown files that drive agent creation, hook systems, security guidance, and plugin architecture — not publicly documented.

---

## 1. Agent Creation System Prompt

**File**: `plugins/plugin-dev/skills/agent-development/references/agent-creation-system-prompt.md`

This is the exact system prompt Claude Code uses internally to generate new agent configurations:

```markdown
You are an elite AI agent architect specializing in crafting high-performance agent configurations. Your expertise lies in translating user requirements into precisely-tuned agent specifications that maximize effectiveness and reliability.

**Important Context**: You may have access to project-specific instructions from CLAUDE.md files and other context that may include coding standards, project structure, and custom requirements. Consider this context when creating agents to ensure they align with the project's established patterns and practices.

When a user describes what they want an agent to do, you will:

1. **Extract Core Intent**: Identify the fundamental purpose, key responsibilities, and success criteria for the agent. Look for both explicit requirements and implicit needs. Consider any project-specific context from CLAUDE.md files. For agents that are meant to review code, you should assume that the user is asking to review recently written code and not the whole codebase, unless the user has explicitly instructed you otherwise.

2. **Design Expert Persona**: Create a compelling expert identity that embodies deep domain knowledge relevant to the task. The persona should inspire confidence and guide the agent's decision-making approach.

3. **Architect Comprehensive Instructions**: Develop a system prompt that:
   - Establishes clear behavioral boundaries and operational parameters
   - Provides specific methodologies and best practices for task execution
   - Anticipates edge cases and provides guidance for handling them
   - Incorporates any specific requirements or preferences mentioned by the user
   - Defines output format expectations when relevant
   - Aligns with project-specific coding standards and patterns from CLAUDE.md

4. **Optimize for Performance**: Include:
   - Decision-making frameworks appropriate to the domain
   - Quality control mechanisms and self-verification steps
   - Efficient workflow patterns
   - Clear escalation or fallback strategies

5. **Create Identifier**: Design a concise, descriptive identifier that:
   - Uses lowercase letters, numbers, and hyphens only
   - Is typically 2-4 words joined by hyphens
   - Clearly indicates the agent's primary function
   - Is memorable and easy to type
   - Avoids generic terms like "helper" or "assistant"

6. **Example agent descriptions**:
   - In the 'whenToUse' field of the JSON object, you should include examples of when this agent should be used.
   - Examples should be of the form:
     <example>
     Context: The user is creating a code-review agent that should be called after a logical chunk of code is written.
     user: "Please write a function that checks if a number is prime"
     assistant: "Here is the relevant function: "
     <function call omitted for brevity only for this example>
     <commentary>
     Since a logical chunk of code was written and the task was completed, now use the code-review agent to review the code.
     </commentary>
     assistant: "Now let me use the code-review agent to review the code"
     </example>
   - If the user mentioned or implied that the agent should be used proactively, you should include examples of this.
   - NOTE: Ensure that in the examples, you are making the assistant use the Agent tool and not simply respond directly to the task.

Your output must be a valid JSON object with exactly these fields:
{
  "identifier": "A unique, descriptive identifier using lowercase letters, numbers, and hyphens (e.g., 'code-reviewer', 'api-docs-writer', 'test-generator')",
  "whenToUse": "A precise, actionable description starting with 'Use this agent when...' that clearly defines the triggering conditions and use cases. Ensure you include examples as described above.",
  "systemPrompt": "The complete system prompt that will govern the agent's behavior, written in second person ('You are...', 'You will...') and structured for maximum clarity and effectiveness"
}

Key principles for your system prompts:
- Be specific rather than generic - avoid vague instructions
- Include concrete examples when they would clarify behavior
- Balance comprehensiveness with clarity - every instruction should add value
- Ensure the agent has enough context to handle variations of the core task
- Make the agent proactive in seeking clarification when needed
- Build in quality assurance and self-correction mechanisms

Remember: The agents you create should be autonomous experts capable of handling their designated tasks with minimal additional guidance. Your system prompts are their complete operational manual.
```

---

## 2. Agent Inventory — 9 Internal Agent System Prompts

All discovered in `plugins/*/agents/`:

| Agent | Path | Purpose |
|-------|------|---------|
| `code-architect` | `plugins/feature-dev/agents/code-architect.md` | Architecture planning before code |
| `code-explorer` | `plugins/feature-dev/agents/code-explorer.md` | Code exploration and navigation |
| `code-reviewer` | `plugins/feature-dev/agents/code-reviewer.md` | Code review with quality focus |
| `parallel-reviewer-1` | `plugins/code-review/agents/parallel-reviewer-1.md` | Parallel code review lane 1 |
| `parallel-reviewer-2` | `plugins/code-review/agents/parallel-reviewer-2.md` | Parallel code review lane 2 |
| `parallel-reviewer-3` | `plugins/code-review/agents/parallel-reviewer-3.md` | Parallel code review lane 3 |
| `agent-creator` | `plugins/plugin-dev/agents/agent-creator.md` | Creates new agent configs |
| `plugin-validator` | `plugins/plugin-dev/agents/plugin-validator.md` | Validates plugin structure |
| `skill-reviewer` | `plugins/plugin-dev/agents/skill-reviewer.md` | Reviews and scores skills |

**Key pattern**: Claude Code uses parallel code review agents (3 lanes) that run simultaneously, each with slightly different review focus areas. This is the "adversarial review" pattern — multiple perspectives catch more issues.

---

## 3. SKILL.md Inventory — 9 Internal Skills

| Skill | Path | Trigger |
|-------|------|---------|
| Agent Development | `plugins/plugin-dev/skills/agent-development/SKILL.md` | "create an agent", "add an agent" |
| Writing Hookify Rules | `plugins/hookify/skills/writing-rules/SKILL.md` | "create a hookify rule", "configure hookify" |
| Code Tour | `plugins/code-tour/skills/code-tour/SKILL.md` | "create a tour", "onboarding tour" |
| Commit | `plugins/commit-commands/commands/commit.md` | Git commit automation |
| Commit Push PR | `plugins/commit-commands/commands/commit-push-pr.md` | Full Git workflow |
| Cancel Ralph | `plugins/ralph-wiggum/commands/cancel-ralph.md` | Cancel loop |
| Ralph Loop | `plugins/ralph-wiggum/commands/ralph-loop.md` | Loop command |
| Frontend Design | `plugins/frontend-design/README.md` | UI generation |
| Opus Migration | `plugins/claude-opus-4-5-migration/README.md` | Model migration |

---

## 4. Hook Examples — 4 Safety Hooks

### 4a. Block Dangerous `rm` — `dangerous-rm.local.md`

```yaml
---
name: block-dangerous-rm
enabled: true
event: bash
pattern: rm\s+-rf
action: block
---

⚠️ **Dangerous rm command detected!**

This command could delete important files. Please:
- Verify the path is correct
- Consider using a safer approach
- Make sure you have backups
```

### 4b. Sensitive Files Warning — `sensitive-files-warning.local.md`

```yaml
---
name: warn-sensitive-files
enabled: true
event: file
action: warn
conditions:
  - field: file_path
    operator: regex_match
    pattern: \.env$|\.env\.|credentials|secrets
---

🔐 **Sensitive file detected**

You're editing a file that may contain sensitive data:
- Ensure credentials are not hardcoded
- Use environment variables for secrets
- Verify this file is in .gitignore
- Consider using a secrets manager
```

### 4c. Console Log Warning — `console-log-warning.local.md`

Blocks `console.log` in production code (pattern: `console\.log`).

### 4d. Require Tests — `require-tests-stop.local.md`

Stop-event hook requiring tests before marking work complete.

---

## 5. Security Guidance Plugin — 3-Layer System

**File**: `plugins/security-guidance/README.md`

Three layers of security review:

1. **Pattern warnings** — Instant regex-based reminders on `Edit`/`Write` for ~25 known-dangerous patterns:
   - `yaml.load` (unsafe YAML)
   - `torch.load(weights_only=False)` (pickle deserialization)
   - `pickle.load` on untrusted data
   - Raw `innerHTML` (XSS)
   - Hardcoded secrets
   - SQL string concatenation
   - Command injection patterns

2. **LLM diff review** — When Claude finishes a turn, sends the diff to a fast LLM call (Opus 4.7 default). High-severity findings are fed back so Claude can fix them before the user sees the response.

3. **Agentic commit review** — On `git commit`, an SDK-driven reviewer reads related files (`Read`/`Grep`/`Glob`) to trace data flow across the codebase. Catches multi-file vulnerabilities pattern matching misses (IDOR, auth bypass, cross-file SSRF).

**Config**:
- `SECURITY_REVIEW_MODEL` — Default `claude-opus-4-7`
- `SG_AGENTIC_MODEL` — Model for agentic review
- `SECURITY_GUIDANCE_DISABLE=1` — Kill switch
- `SG_DUAL_OR=on` — Dual-review mode
- Org-specific policies via `claude-security-guidance.md` files in:
  - `~/.claude/`
  - `<project>/.claude/`
  - `<project>/.claude/claude-security-guidance.local.md`

---

## 6. Security Code Reviewer Agent

**File**: `anthropics/claude-code-action/.claude/agents/security-code-reviewer.md`

```yaml
---
name: security-code-reviewer
description: Use this agent when you need to review code for security vulnerabilities, input validation issues, or authentication/authorization flaws...
tools: Glob, Grep, Read, WebFetch, TodoWrite, WebSearch, BashOutput, KillBash
model: inherit
---
```

System prompt covers OWASP Top 10, input validation, auth/authorization, crypto, race conditions. Provides findings in severity order: Critical > High > Medium > Low > Informational.

---

## 7. SENSITIVE_PATHS — Config File Protection List

Paths Claude Code treats as sensitive (never auto-include in context without explicit user request):

```
.claude/
.mcp.json
.claude.json
.gitmodules
.ripgreprc
CLAUDE.md
CLAUDE.local.md
.husky/
```

---

## 8. Plugin Architecture

Claude Code plugins live in `~/.claude/plugins/` and are structured as NPM-compatible packages with a `claude-plugin` manifest key.

### Plugin Directory Structure

```
~/.claude/plugins/
└── my-plugin/
    ├── package.json        # Must contain "claude-plugin" key
    ├── agents/
    │   └── my-agent.yaml   # Agent definitions
    ├── skills/              # Skill SKILL.md files
    │   └── my-skill/
    │       └── SKILL.md
    ├── hooks/               # Hook event handlers
    │   └── pre-tool.sh
    └── prompts/             # Additional system prompt fragments
        └── guidelines.md
```

### package.json Plugin Manifest

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "claude-plugin": {
    "agents": ["agents/*.yaml"],
    "skills": ["skills/*/SKILL.md"],
    "hooks": {
      "preToolUse": "hooks/pre-tool-loop-guard.js"
    },
    "permissions": {
      "allow": ["Bash(git status)", "Read"],
      "deny": ["Bash(rm -rf *)"]
    }
  }
}
```

### Plugin Discovery & Loading

1. Claude Code scans `~/.claude/plugins/*/package.json` at startup.
2. For each valid plugin manifest, it:
   - Registers agent YAML files into the agent roster.
   - Indexes SKILL.md files into the skill search index.
   - Registers hook event handlers.
   - Merges permission allow/deny rules into the session policy.
3. Plugins are loaded after built-in skills and project-level AGENTS.md.

---

## 9. Agent YAML Frontmatter Format

Agents are defined as YAML files with this structure:

```yaml
---
name: agent-name                    # Required: unique identifier
description: When to invoke this agent  # Required: trigger description
tools:                               # Required: allowed tools list
  - Glob
  - Grep
  - Read
  - Write
  - Edit
  - Bash
model: inherit                      # Optional: "inherit" (use session model) or specific model name
prompt: |                           # Required: system prompt body
  You are a specialist agent...
---
```

### Key Frontmatter Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Unique agent identifier, used in routing |
| `description` | Yes | Trigger description — matches user intent |
| `tools` | Yes | List of allowed tools (subset of all available) |
| `model` | No | `inherit` (default) or a specific model override |
| `prompt` | Yes | Full system prompt for the agent |

### Agent Routing

When a user's request matches an agent's `description`, Claude Code:
1. Extracts the agent's YAML frontmatter.
2. Injects the `prompt` as the system message.
3. Restricts available tools to the `tools` list.
4. Uses the specified `model` or inherits the session model.

---

## 10. SKILL.md Format Specification

Skills follow a strict SKILL.md format with YAML frontmatter:

```yaml
---
name: skill-name
description: Trigger description for matching
triggers:                           # Optional explicit triggers
  - "keyword"
  - "phrase pattern"
tools:                              # Required tools
  - Read
  - Write
  - Bash
---

# Skill Name

## Overview
What this skill does and when to use it.

## Instructions
Detailed step-by-step instructions for the skill.

## Examples
Concrete examples of input/output.
```

### SKILL.md Frontmatter Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Unique skill identifier |
| `description` | Yes | Short description, used in search/routing |
| `triggers` | No | Explicit trigger phrases for matching |
| `tools` | No | Tools this skill needs (may restrict session) |

### Skill Discovery Algorithm

1. Scan `~/.claude/plugins/*/skills/*/SKILL.md`.
2. Scan project-level `.claude/skills/*/SKILL.md`.
3. Index by `name`, `description`, and `triggers`.
4. On user request, match against descriptions and triggers using LLM-based routing.
5. Load matched SKILL.md content into the system prompt as needed.

---

## 11. Hook Event Types & Lifecycle

Claude Code supports these hook event types:

| Event | Trigger | Use Case |
|-------|---------|----------|
| `PreToolUse` | Before a tool executes | Block dangerous commands, enforce policies |
| `PostToolUse` | After a tool executes | Score progress, log results |
| `UserPromptSubmit` | Before processing user input | Reject underspecified or destructive prompts |
| `Notification` | On notification events | Custom alert handling |
| `Stop` | On agent stop/completion | Emit summaries, cleanup |

### Hook Exit Codes

| Code | Meaning | Behavior |
|------|---------|----------|
| `0` | Allow | Continue execution normally |
| `2` | Block | Stop execution, return STDERR to agent |
| Other | Warn | Log warning but continue |

### Hook Input Environment

Hooks receive context via environment variables:

- `CLAUDE_TOOL_NAME` — Name of the tool being called
- `CLAUDE_TOOL_INPUT` — JSON string of tool arguments
- `CLAUDE_SESSION_ID` — Current session identifier
- `CLAUDE_WORKING_DIR` — Current working directory

---

## 12. Permission Levels & Auto-Approval

Claude Code has a hierarchical permission system:

### Permission Templates

| Template | Behavior |
|----------|----------|
| `never` | Always deny, never ask |
| `on_request` | Ask user each time |
| `unless_trusted` | Auto-approve if in trusted directory |
| `read_only` | Auto-approve reads, ask for writes |
| `workspace_write` | Auto-approve writes in workspace |
| `danger_full_access` | Auto-approve everything (FULL_AUTO mode) |

### Auto-Approval Hierarchy (lowest to highest)

1. **never** — Hard deny, no override possible
2. **on_request** — Require explicit user approval
3. **unless_trusted** — Auto if in workspace trust scope
4. **read_only** — Auto for reads, prompt for writes
5. **workspace_write** — Auto for workspace writes
6. **danger_full_access** — Auto for everything including destructive ops

### Session Approval Modes

```javascript
const APPROVAL_MODES = {
  SUGGEST: 'suggest',     // Suggest actions, wait for approval
  AUTO_EDIT: 'auto_edit', // Auto-approve file edits, ask for shell
  FULL_AUTO: 'full_auto'  // Auto-approve everything (danger_full_access)
};
```

The `shouldConfirm(toolName, args, mode)` function checks:
- If mode is FULL_AUTO → auto-approve everything
- If mode is AUTO_EDIT → auto-approve file ops, ask for shell
- If mode is SUGGEST → ask for everything

---

## 13. AGENTS.md Discovery & Loading

Claude Code discovers project context through a hierarchical AGENTS.md system:

```javascript
const DEFAULT_AGENTS_MD_FILENAME = "AGENTS.md";
const LOCAL_AGENTS_MD_FILENAME = "AGENTS.override.md";

// Walk from project root to CWD collecting all AGENTS.md files
// At each directory level, prefer AGENTS.override.md if it exists
// Separator: "\n\n--- projectDoc ---\n\n"
```

### Discovery Order

1. Start at project root (detected by `.git` directory).
2. Walk toward current working directory.
3. At each level, check for `AGENTS.override.md` first (preferred), then `AGENTS.md`.
4. Concatenate all found files with `--- projectDoc ---` separators.
5. Cache result in `_agentsMdCache`.

### Override Behavior

- `AGENTS.override.md` takes precedence over `AGENTS.md` at the same level.
- This allows project-level overrides without modifying shared configs.
- The override file can selectively override specific sections.

---

## 14. Memory Consolidation System (Phase 2)

Claude Code implements a two-phase memory system that consolidates raw conversation history into structured knowledge:

### Phase 1: Checkpoint Compaction

When context window fills up, the system creates a compact summary using this prompt structure:

```markdown
## Progress & Decisions
[What was accomplished and what was decided]

## Context & Constraints
[Key technical context, user preferences, project constraints]

## Remaining Steps
[What still needs to be done]

## Critical Data
[Any data that must be preserved exactly]
```

### Phase 2: Memory Writing

The consolidation system uses a structured memory format:

```
memory/
├── memory_summary.md     # User profile & preferences overview
├── MEMORY.md            # Task groups, reusable knowledge, failure shields
├── raw_memories.md      # Unprocessed conversation fragments
├── skills/              # Extracted reusable skills
│   └── skill-name/
│       └── SKILL.md
└── rollout_summaries/   # Deployment/release notes
```

### MEMORY.md Format

```markdown
# Memory

## Task Groups
- [active] Project X: fixing auth module
- [completed] Project Y: documentation update

## User Preferences
- Prefers TypeScript over JavaScript
- Uses 2-space indentation
- Commits should reference ticket numbers

## Reusable Knowledge
- Auth module uses JWT with RS256
- API follows OpenAPI 3.0 spec

## Failure Shields
- When test X fails, check the database migration first
- If build breaks on CI, check Node version mismatch
```

### memory_summary.md Format

```markdown
# Memory Summary

## User Profile
- Name: [detected from conversations]
- Preferences: [key preferences]
- Working style: [patterns observed]

## What's in Memory
- Task groups: [count]
- Reusable knowledge: [count]
- Failure shields: [count]
```

---

## 15. Command Definitions

Claude Code exposes these built-in slash commands:

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/compact` | Trigger manual context compaction |
| `/clear` | Clear conversation history |
| `/model` | Switch model |
| `/permissions` | Show or modify permission settings |
| `/mcp` | Manage MCP server connections |
| `/cost` | Show token usage and cost |
| `/skills` | List available skills |
| `/agents` | List available agents |

### Skill Invocation Pattern

Skills are invoked by matching the user's request against skill descriptions and triggers. The system prompt includes:

```
You have access to skills. When a user's request matches a skill's trigger description, load and follow the skill's SKILL.md instructions before responding.
```

### Agent Invocation Pattern

Agents are invoked when:

1. User request matches an agent's description.
2. System detects the task would benefit from specialist handling.
3. User explicitly requests a named agent.

---

## Appendix: Full Sensitive Paths List

```
.claude/
.mcp.json
.claude.json
.gitmodules
.ripgreprc
CLAUDE.md
CLAUDE.local.md
.husky/
.env
.env.local
.env.production
credentials/
secrets/
*.pem
*.key
id_rsa*
id_ed25519*
.ssh/
.gnupg/
```

---

*This document contains internal implementation details from the Claude Code source repository. It is intended for reference by haksterAi agent developers and should not be distributed externally.*