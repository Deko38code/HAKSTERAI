# Cline AI Coding Agent — Top Secrets & Best Practices

## Sources
- https://github.com/cline/cline (239 lines saved locally as cline-readme.md)
- https://www.deployhq.com/guides/cline (setup guide with best practices)
- https://cline.bot/faq (official FAQ)
- https://www.reddit.com/r/ChatGPTCoding/comments/1hm3wcy/ (Reddit tips)

## What is Cline?
Open-source autonomous AI coding agent (Apache 2.0, 5M+ installs, 61.2k GitHub stars, v3.81). Runs as a sidebar in VS Code, JetBrains, Cursor, Windsurf, Zed, Neovim. Reads/writes across multiple files, executes commands, adapts to your workflow.

## Key Secrets

### 1. .clinerules File
- Like CLAUDE.md / AGENTS.md / .kiro/steering/ — project-level instructions
- Place at project root: `.clinerules` (or `.clinerules/` directory)
- Define coding standards, architecture decisions, preferred patterns
- Cline reads this before every task for context
- Can layer: global `.clinerules` + project-specific + directory-specific

### 2. MCP (Model Context Protocol) Support
- Add MCP servers to give Cline access to external tools
- Database access, API integrations, file system extensions
- Configure in Cline settings → MCP servers
- Use MCPs to extend Cline's capabilities beyond file editing

### 3. Multi-File Edits
- Cline reads your entire codebase for context
- Can refactor across multiple files in one task
- Shows diff for each file edit — review every one
- AI-generated code can contain subtle bugs — always review diffs

### 4. Command Execution
- Cline can run terminal commands (with approval)
- Use for: running tests, installing deps, building projects
- Approval system prevents dangerous commands
- Can configure auto-approve for safe commands

### 5. Custom Instructions
- Per-project custom instructions in settings
- More granular than .clinerules
- Can specify: preferred language, framework, style guide
- Combine with .clinerules for layered guidance

### 6. Model Selection
- Cline supports multiple providers: Claude, GPT-4, OpenRouter, local models
- Match model to task: simple edits → cheaper model, complex refactors → powerful model
- OpenRouter gives access to 100+ models
- Local models (via Ollama) for privacy-sensitive code

### 7. Plan Mode
- Cline can plan before executing
- Review the plan, approve/modify, then execute
- Prevents wasted work on wrong approach
- Use for complex multi-step tasks

### 8. Checkpoints
- Cline saves checkpoints as it works
- Rewind to previous checkpoint if something goes wrong
- Safety net for autonomous operations

### 9. Browser Preview
- Cline can preview web apps inside VS Code
- See changes live as Cline makes them
- No need to switch to external browser

### 10. SDK Mode
- Cline is available as an SDK (not just VS Code extension)
- Build custom agentic workflows using Cline's engine
- Programmatic access to Cline's file editing and command execution

## Best Practices (from Reddit + guides)

### Guiding Cline Effectively
- **Be specific in prompts** — vague prompts produce vague results
- **Use .clinerules** — but don't over-stuff it, keep it focused
- **Break large tasks into smaller ones** — Cline works better with focused tasks
- **Review every diff** — AI code can have subtle bugs
- **Use plan mode for complex tasks** — review before execute
- **Add MCPs for external tools** — extends Cline's reach
- **Specify file paths** — tell Cline exactly which files to touch
- **Provide examples** — show Cline the pattern you want followed

### Common Mistakes to Avoid
- Don't let Cline run unsupervised on large refactors
- Don't skip diff review — subtle bugs hide in AI-generated code
- Don't over-rely on .clinerules alone — combine with specific prompts
- Don't use expensive models for simple tasks — waste of money
- Don't forget to checkpoint before major changes

### Folder Structure
```
project/
├── .clinerules          # Project-level rules
├── .clinerules/         # Or directory of rule files
│   ├── coding-standards.md
│   ├── architecture.md
│   └── testing.md
├── .cline/
│   └── mcp-config.json  # MCP server configs
└── src/
```

## Cline vs Claude Code vs Kiro vs Codex
| Feature | Cline | Claude Code | Kiro | Codex CLI |
|---------|-------|-------------|------|-----------|
| Config | .clinerules | CLAUDE.md | .kiro/steering/ | AGENTS.md + .codex/ |
| IDE | VS Code sidebar | CLI-first | Full IDE | CLI only |
| MCP | Yes | Yes | Yes | No |
| SDK | Yes | No | No | No |
| Multi-IDE | VS Code, JetBrains, Cursor, Zed, Neovim | CLI | Kiro IDE | CLI |
| Checkpoints | Yes | Git-based | Native rewind | Git-based |
| Plan Mode | Yes | Yes | Specs | Orchestration |
| Open Source | Apache 2.0 | Proprietary | Proprietary | Proprietary |
| Local Models | Yes (Ollama) | No | No | No |