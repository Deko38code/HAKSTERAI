# Goose (Block) — Top Secrets & Best Practices

## Sources
- https://goose-docs.ai/ (official docs)
- Firecrawl search results

## What is Goose?
Open-source AI agent by Block (Square/Cash App). Runs on your machine. General-purpose: code, research, writing, automation, data analysis. Built in Rust. Desktop app + CLI + API. Now part of Agentic AI Foundation (AAIF).

## Key Secrets

### 1. MCP-First Architecture
- Goose is built around Model Context Protocol
- 70+ extensions: databases, APIs, browsers, GitHub, Google Drive
- Extensions are MCP servers — write your own for custom tools
- Configure in `~/.config/goose/config.yaml`
- MCP-first means Goose can connect to ANY tool with an MCP server

### 2. Session Management
- Goose saves sessions — resume where you left off
- `goose session list` — see all sessions
- `goose session resume <id>` — resume a session
- Sessions persist across restarts
- Great for long-running projects

### 3. Recipe System
- Recipes = reusable workflows
- Define multi-step tasks as a recipe
- Share recipes across teams
- Recipes can include: MCP tool calls, LLM prompts, file operations
- Like Claude Code skills but more structured

### 4. Provider Flexibility
- Supports: Anthropic, OpenAI, Google, Ollama, local models
- No model lock-in — switch providers freely
- Configure per-session or globally
- `goose configure` to set up providers

### 5. CLI Mode
- `goose` — Start interactive session
- `goose session` — Manage sessions
- `goose configure` — Set up providers and extensions
- `goose run <recipe>` — Run a recipe
- Full terminal experience, no GUI required

### 6. Desktop App
- Native macOS, Linux, Windows
- GUI for those who prefer visual interface
- Same engine as CLI — sessions sync
- Built in Rust — fast and lightweight

### 7. Extension Development
- Write custom MCP extensions in any language
- Extensions add new tools to Goose's arsenal
- Pattern: Define tool schema → Implement handler → Register
- Share extensions via MCP registry

### 8. Safety & Permissions
- Goose asks before executing commands
- Permission system for file writes, command execution
- Configure allowed/blocked commands
- Safe mode for read-only exploration

### 9. Rust Performance
- Built in Rust — fast startup, low memory
- No Node.js/Python runtime needed
- Native binary — no dependencies
- Cross-platform: macOS, Linux, Windows

### 10. AAIF (Agentic AI Foundation)
- Goose moved to AAIF in 2026
- Open governance, community-driven
- Not locked to Block's commercial interests
- Truly open source

## Best Practices
- Use MCP extensions to connect Goose to your tools
- Create recipes for repeated workflows
- Save sessions for long-running projects
- Configure permission system for safety
- Use local models (Ollama) for privacy
- Write custom extensions for project-specific tools

## Goose vs Others
| Feature | Goose | Claude Code | Aider |
|---------|-------|-------------|-------|
| Open Source | ✅ | ❌ | ✅ |
| MCP-First | ✅ 70+ ext | Yes | No |
| Recipes | ✅ | Skills | ❌ |
| Sessions | ✅ Persistent | ❌ | /save /load |
| Desktop App | ✅ | ❌ | ❌ |
| Language | Rust | TypeScript | Python |
| General Purpose | ✅ | Coding focus | Coding focus |