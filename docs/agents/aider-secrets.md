# Aider — Top Secrets & Best Practices

## Sources
- https://aider.chat/ (official site)
- https://github.com/Aider-AI/aider (180 lines saved locally as aider-readme.md)

## What is Aider?
AI pair programming in your terminal. 44K GitHub stars, 6.8M installs, 15B tokens/week. 88% of new code in last release written by Aider itself. Works best with Claude 3.7 Sonnet, DeepSeek R1 & Chat V3.

## Key Secrets

### 1. Git-Native Workflow
- Aider automatically commits changes with descriptive messages
- Every edit is a git commit — full history of AI changes
- Use `git log` to see what Aider changed and when
- Easy to revert: `git revert <commit>`
- Best practice: Work in a separate branch when using Aider

### 2. Repo Map
- Aider builds a map of your entire codebase
- Uses tree-sitter to understand code structure
- Sends relevant parts to the LLM automatically
- No need to manually specify context files for every task
- `--map-tokens` controls how much of the repo map is sent

### 3. Multi-File Editing
- Aider can edit multiple files in one session
- Say "refactor the auth module" — it touches all relevant files
- Shows diffs before applying — review and approve
- `/diff` command shows pending changes
- `/undo` reverts the last change

### 4. Architect Mode
- `--architect` flag: Use one model to plan, another to edit
- Cheaper model designs the solution, powerful model implements
- Cost-efficient for complex tasks
- Example: `aider --architect --model claude-3.5-sonnet --editor-model deepseek-v3`

### 5. In-Chat Commands
- `/add <file>` — Add file to chat context
- `/drop <file>` — Remove file from context
- `/clear` — Clear conversation history
- `/diff` — Show pending changes
- `/undo` — Undo last change
- `/save <name>` — Save conversation
- `/load <name>` — Load saved conversation
- `/tokens` — Show token usage
- `/model <name>` — Switch model mid-session

### 6. .aider.conf.yml
- Config file at `~/.aider.conf.yml` or project root
- Set default model, API keys, editor preferences
- Example:
  ```yaml
  model: claude-3.5-sonnet
  auto-commits: true
  dark-mode: true
  map-tokens: 1024
  ```

### 7. Model Selection
- **Claude 3.7 Sonnet** — Best overall, most capable
- **DeepSeek R1** — Best open-source, reasoning focused
- **DeepSeek Chat V3** — Fast, cost-effective
- **GPT-4o** — Good for general tasks
- **Local models** — Via Ollama for privacy
- `--model` flag or `/model` command to switch

### 8. Watch Files Mode
- `--watch-files` — Aider watches for file changes
- Automatically reads modified files into context
- Great for multi-tool workflows (edit in IDE, Aider follows)

### 9. Auto-Commits
- `--auto-commits` — Automatically commit after each change (default: on)
- `--no-auto-commits` — Manual commit, review before saving
- `--dirty-commits` — Commit even if working directory is dirty
- Best practice: Keep auto-commits on for speed, use branch + PR workflow

### 10. Token Efficiency
- `/tokens` shows token usage per message
- `--map-tokens` controls repo map size
- Drop unnecessary files from context to save tokens
- Use `/clear` between unrelated tasks
- Architect mode saves tokens (cheaper model plans)

## Best Practices
- Work in a git branch — Aider commits are easy to review via PR
- Use `/add` to add only relevant files — saves tokens
- Use architect mode for complex tasks — cost efficient
- Review every diff before approving
- Use `/undo` liberally — don't accept bad changes
- Keep `.aider.conf.yml` for project-specific defaults
- Use `--watch-files` when working with IDE alongside Aider
- Switch models mid-session with `/model` for cost control

## Aider vs Others
| Feature | Aider | Claude Code | Codex CLI |
|---------|-------|-------------|-----------|
| Git-Native | ✅ Auto-commit | Manual | Manual |
| Repo Map | ✅ Tree-sitter | Manual context | Manual context |
| Architect Mode | ✅ Split models | ❌ | ❌ |
| Open Source | ✅ Apache 2.0 | ❌ | ❌ |
| Local Models | ✅ Ollama | ❌ | ❌ |
| IDE | Terminal only | CLI | CLI |
| Stars | 44K | N/A | N/A |