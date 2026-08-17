# Kiro AI IDE — Top Secrets & Best Practices

## Sources
- https://kiro.dev/blog/introducing-kiro-autonomous-agent/
- https://kiro.dev/docs/
- https://www.reddit.com/r/kiroIDE/comments/1p8vjn8/
- https://github.com/awsdataarchitect/kiro-best-practices
- Local file: kiro-best-practices.md (220 lines)

## What is Kiro?
Kiro is an AI-powered IDE by AWS, designed specifically for agentic software development. It evolved from inline completions → chat → agentic workflows → autonomous agent mode.

## Key Features (from docs)

### 1. Specs System
- Define specifications before coding — Kiro generates code from specs
- Specs act as contracts: what the code should do, inputs/outputs, edge cases
- Kiro follows specs deterministically rather than guessing

### 2. Steering Files
- `.kiro/steering/` directory contains markdown files that guide Kiro's behavior
- Like CLAUDE.md but more structured — per-project guidance
- Steering files enforce: coding standards, architecture decisions, testing requirements
- Best practice: Create steering files for:
  - `best-practices.md` — general coding standards
  - `architecture.md` — system design decisions
  - `testing.md` — test requirements and patterns
  - `security.md` — security guidelines
  - `dependencies.md` — allowed/banned dependencies

### 3. Hooks
- Lifecycle hooks that run shell commands at specific points
- Pre-commit hooks, post-edit hooks, pre-push hooks
- Deterministic automation — always runs, doesn't rely on LLM choice
- Use for: linting, formatting, security scans, test runs

### 4. Agent Skills
- Custom agents with specialized roles (like Claude Code subagents)
- Define agent personas with specific system prompts
- Agent Skills can be shared across projects

### 5. Powers
- Extended capabilities that can be granted to agents
- Fine-grained permission control

### 6. MCP Support
- Model Context Protocol integration
- Connect external tools and data sources

### 7. Reasoning Effort Control
- Control how much thinking Kiro puts into responses
- Similar to Claude Code's effort levels
- Higher effort = deeper reasoning, slower response

### 8. Cloud Sessions
- Run Kiro agents in the cloud
- Persistent sessions that survive disconnection

### 9. Compaction
- Compress conversation history to stay within token limits
- Automatic context management

### 10. Kiroignore
- `.kiroignore` file — like .gitignore but for what Kiro should ignore
- Prevents Kiro from reading sensitive/irrelevant files

### 11. Checkpoints and Rewind
- Save state at checkpoints
- Rewind to previous checkpoint if agent goes wrong
- Safety net for autonomous operations

### 12. Custom Agents
- Define custom agent types with specific behaviors
- Crew mode: Run multiple agents 24/7

### 13. CLI Mode (v3.0)
- Full CLI experience with terminal UI
- Voice mode support
- Headless mode for automation
- ACP (Agent Control Protocol)

## Best Practices (from Reddit + GitHub)

### Folder Structure
```
project/
├── .kiro/
│   ├── steering/
│   │   ├── best-practices.md
│   │   ├── architecture.md
│   │   ├── testing.md
│   │   └── security.md
│   ├── hooks/
│   │   ├── pre-commit.sh
│   │   └── post-edit.sh
│   └── agents/
│       └── custom-agent.md
├── specs/
│   ├── feature-specs/
│   └── api-specs/
├── .kiroignore
└── src/
```

### Steering File Tips
- Be specific about patterns and anti-patterns
- Include code examples in steering files
- Reference actual file paths, not generic descriptions
- Update steering files as project evolves
- Keep steering files under 500 lines each

### Hook Tips
- Use hooks for deterministic tasks (lint, format, test)
- Don't use hooks for tasks that need LLM judgment
- Chain hooks: pre-edit → edit → post-edit → pre-commit
- Log hook output for debugging

### Autonomous Agent Tips
- Start with specs — autonomous mode works best with clear specs
- Use checkpoints frequently in autonomous mode
- Set up kiroignore to protect sensitive files
- Limit agent permissions via Powers system
- Monitor cloud sessions for runaway agents

## Kiro vs Claude Code
| Feature | Kiro | Claude Code |
|---------|------|-------------|
| Specs | Native spec system | CLAUDE.md hierarchy |
| Steering | .kiro/steering/ | CLAUDE.md files |
| Hooks | .kiro/hooks/ | hooks config |
| Agents | Custom agents + Crew | Subagents |
| Cloud | Cloud sessions | No native cloud |
| Checkpoints | Native rewind | Git-based |
| IDE | Full IDE | CLI-first |
| Voice | Native voice mode | Via plugins |