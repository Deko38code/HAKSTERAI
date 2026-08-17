# OpenHands CLI — Top Secrets & Best Practices

## Sources
- https://github.com/OpenHands/openhands (144 lines saved locally as openhands-readme.md)
- https://www.openhands.dev/blog/the-openhands-cli-ai-powered-development-in-your-terminal

## What is OpenHands CLI?
Open-source AI software development agent. Runs in terminal — no Docker, no web interface needed. Fully open source, no model lock-in. Top-performing on SWE-bench. Python 3.12+ required.

## Key Secrets

### 1. Simple Setup
- `pip install openhands-ai` then run `openhands`
- Or: `uvx --python 3.12 --from openhands-ai openhands`
- No Docker required (unlike older OpenHands versions)
- No web interface needed — pure CLI
- Immediate access to top-performing coding agents

### 2. No Model Lock-In
- Supports: Claude, GPT, Gemini, DeepSeek, local models (Ollama)
- Configure via `~/.openhands/config.yaml`
- Switch models per-session or per-task
- No vendor lock-in — truly open source

### 3. SWE-bench Performance
- OpenHands is a top performer on SWE-bench (software engineering benchmark)
- Solves real GitHub issues autonomously
- Can: read code, understand bugs, write fixes, run tests
- Best for: bug fixing, feature implementation, code review

### 4. Agent Canvas
- Visual workflow builder for agents
- Run agents locally, in Docker, on VMs, or anywhere
- Self-host your way — full control over infrastructure
- Canvas = drag-and-drop agent workflow design

### 5. Tool Use
- File read/write
- Command execution (bash)
- Browser automation
- Code execution (Python sandbox)
- Can install packages, run tests, build projects

### 6. Session Management
- `openhands --session <id>` — Resume session
- Sessions saved locally
- Can resume long-running tasks
- Great for complex multi-day projects

### 7. Configuration
- `~/.openhands/config.yaml` — Global config
- Project-level config in `.openhans/` directory
- Set: default model, API keys, sandbox settings, permissions
- Like CLAUDE.md but for OpenHands

### 8. Docker Mode (Optional)
- CLI runs without Docker (new in 2025)
- Docker mode available for isolated execution
- `openhands --docker` — Run in container
- Good for: untrusted code, CI/CD, reproducible environments

### 9. Multi-Agent Support
- Run multiple OpenHands agents in parallel
- Different agents for different tasks
- Orchestrate via shell scripts
- Like Codex orchestration workflow

### 10. Open Source Community
- Apache 2.0 license
- Active community on GitHub
- Regular updates and improvements
- No commercial entity controlling it

## Best Practices
- Use `pip install openhands-ai` for simplest setup
- Configure model in config.yaml — match to task complexity
- Use Docker mode for untrusted code
- Save sessions for long-running tasks
- Use local models (Ollama) for privacy
- Run tests after agent makes changes
- Review all file writes before committing

## OpenHands vs Others
| Feature | OpenHands | Claude Code | Aider |
|---------|-----------|-------------|-------|
| Open Source | ✅ Apache 2.0 | ❌ | ✅ |
| Docker | Optional | ❌ | ❌ |
| SWE-bench | Top performer | ❌ | ❌ |
| Model Lock-in | None | Anthropic | None |
| Setup | pip install | npm install | pip install |
| Web UI | Agent Canvas | ❌ | ❌ |
| Browser | ✅ Automation | ❌ | ❌ |