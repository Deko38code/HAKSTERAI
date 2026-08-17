# Google Gemini CLI — Top Secrets & Best Practices

## Sources
- https://addyo.substack.com/p/gemini-cli-tips-and-tricks (Addy Osmani's 30 pro-tips)
- https://github.com/addyosmani/gemini-cli-tips
- Firecrawl search results

## What is Gemini CLI?
Google's terminal-native AI coding agent. Powered by Gemini models. Open source. 1M token context window. Free tier available with Google account.

## Key Secrets (30 Pro-Tips from Addy Osmani)

### 1. GEMINI.md (Like CLAUDE.md)
- `GEMINI.md` at project root — project context
- Gemini reads it for coding standards, architecture, preferences
- Layer: global `~/.gemini/GEMINI.md` + project + subdirectory
- Same hierarchy concept as CLAUDE.md

### 2. 1M Token Context Window
- Gemini has 1M token context — largest available
- Can read entire large codebases in one shot
- No need to chunk or select files carefully
- Perfect for monorepo understanding

### 3. Free Tier
- Free usage with Google account
- Rate limited but usable for personal projects
- No API key needed for basic usage
- Upgrade to paid for higher limits

### 4. @ File References
- `@filename` in prompts to reference files
- `@src/` to reference entire directory
- Gemini reads referenced files into context
- Like `/add` in Aider but simpler syntax

### 5. Extensions System
- Gemini CLI supports extensions
- Install via `gemini extensions install <name>`
- Extensions add new capabilities (linting, testing, deployment)
- Community extensions available

### 6. Tool Use
- Gemini can execute shell commands
- Can read/write files
- Asks before dangerous operations
- `--yolo` flag to auto-approve everything (dangerous)

### 7. Session Management
- `gemini --session <id>` — Resume session
- Sessions saved locally
- `gemini --list-sessions` — See all sessions
- Great for long-running projects

### 8. Model Selection
- `gemini-2.5-pro` — Most capable, 1M context
- `gemini-2.5-flash` — Fast, efficient
- `--model` flag to switch
- Flash for simple tasks, Pro for complex

### 9. Prompt Chaining
- Chain Gemini CLI calls: output → input
- `gemini "analyze this code" | gemini "write tests for it"`
- Orchestrate via shell scripts
- Like Codex orchestration workflow

### 10. Google Cloud Integration
- Native integration with Google Cloud
- Can query GCP resources
- Deploy to Cloud Run, Cloud Functions
- IAM-aware

### 11. Multi-Modal
- Gemini can process images
- Screenshot a design, ask Gemini to code it
- Paste UI mockups, get HTML/CSS
- Read diagrams and generate code

### 12. /compact Command
- Compress conversation to save tokens
- `/compact` summarizes history
- Keeps key context, drops details
- Like Claude Code's compaction

### 13. /stats Command
- Show token usage, cost, model info
- Monitor spending
- Track context window usage

### 14. Custom Tools
- Define custom tools in GEMINI.md
- Gemini can call these tools during tasks
- Like MCP but simpler — just function definitions

### 15. Memory Mode
- `--memory` flag — Gemini remembers across sessions
- Builds up knowledge of your project
- Persists between CLI invocations

## Best Practices
- Use GEMINI.md for project context (like CLAUDE.md)
- Leverage 1M context — add whole directories with @
- Use Flash for simple tasks, Pro for complex
- Chain prompts for multi-step workflows
- Use /compact when approaching token limits
- Use free tier for personal projects
- Enable memory mode for long-running projects
- Use multi-modal: paste screenshots for UI coding
- Don't use --yolo in production (auto-approve is dangerous)

## Gemini CLI vs Others
| Feature | Gemini CLI | Claude Code | Codex CLI |
|---------|-----------|-------------|-----------|
| Context | 1M tokens | 200K | Varies |
| Config | GEMINI.md | CLAUDE.md | AGENTS.md |
| Free Tier | ✅ | ❌ | ❌ |
| Multi-Modal | ✅ Images | ❌ | ❌ |
| Open Source | ✅ | ❌ | ❌ |
| Cloud Native | Google Cloud | ❌ | ❌ |
| Extensions | ✅ | Plugins | ❌ |