# OpenAI Codex CLI — Top Secrets & Best Practices

## Sources
- https://github.com/shanraisshan/codex-cli-best-practice (268 lines saved locally)
- https://learn.chatgpt.com/guides/best-practices
- https://community.openai.com/t/codex-best-practices-for-persistent-secrets/1286607
- Firecrawl search results

## What is Codex CLI?
OpenAI's terminal-native agentic coding agent. Can read/write files, run commands, apply patches, and reason about code autonomously. Runs non-interactively with a prompt.

## Key Secrets

### 1. AGENTS.md (Like CLAUDE.md)
- Codex reads `AGENTS.md` files for project context
- Place at project root for global instructions
- Layer in subdirectories for scoped instructions
- Include: coding standards, architecture decisions, test requirements
- Codex also reads `.codex/` directory for configuration

### 2. Codex Configuration (.codex/)
- `.codex/` directory contains project-specific config
- Similar to `.kiro/` in Kiro or CLAUDE.md in Claude Code
- Can define: allowed commands, sandbox settings, model preferences

### 3. Sandbox Modes
- `read-only` — Codex can only read, no writes (safe exploration)
- `workspace-write` — Codex can write within the workspace
- `danger-full-access` — Full system access (use with caution)
- Always start with read-only for new projects, escalate as needed

### 4. Approval Policies
- `untrusted` — Require approval for all actions
- `on-failure` — Only ask for approval when something fails
- `on-request` — Ask when Codex requests it
- `never` — Full autonomy (dangerous but fast)
- Best practice: Use `on-failure` for development, `never` for CI/CD

### 5. Orchestration Workflow
- Break complex tasks into smaller, focused prompts
- Chain Codex sessions: output of one feeds into next
- Use orchestration workflow for multi-step tasks
- Pattern: Plan → Implement → Test → Review (each as separate Codex run)

### 6. Persistent Secrets Management
- Use environment variables, not hardcoded secrets
- `.env` files with `.gitignore` protection
- Codex can read env vars but won't expose them in output
- For API keys: use vault systems, reference via env vars

### 7. Model Selection
- `o4-mini` — Fast, efficient, good for simple tasks
- `gpt-4.1` — Balanced, good for most coding tasks
- `o3` — Deep reasoning, complex problem solving
- `gpt-5.5` — Most powerful, use for complex refactoring
- Match model to task complexity for cost efficiency

### 8. Best Practice Patterns (from GitHub repo)

#### Vibe Coding → Agentic Engineering
- Start with "vibe coding" (free-form exploration)
- Transition to "agentic engineering" (structured, spec-driven)
- Use Codex for both modes — different prompts for different modes

#### Implemented Tags
- Tag implemented features in `.codex/` directory
- Track what Codex has done vs what's pending
- Creates a trail of completed work

#### Practice Makes Perfect
- Codex improves with better prompts
- Iterate on prompts — save what works, discard what doesn't
- Build a library of effective prompts per project type

### 9. CLI Tips
- `codex --prompt "task"` — non-interactive single task
- `codex-reply` — continue a previous conversation by thread ID
- Use `--cwd` to set working directory
- Use `--timeout` for long-running tasks (max 300s)
- Pipe output: `codex --prompt "task" > output.txt`

### 10. Multi-Agent Patterns
- Run multiple Codex instances in parallel for independent tasks
- Use different models for different sub-tasks
- Pattern: o4-mini for boilerplate, gpt-5.5 for core logic
- Orchestrate via shell scripts that chain Codex calls

### 11. Code Review with Codex
- Use Codex to review its own output
- Pattern: Implement with one model, review with another
- Catch bugs that the implementing model might miss

### 12. Security Best Practices
- Never give `danger-full-access` to untrusted code
- Use `read-only` for code exploration/audit
- Review all file writes before committing
- Use sandbox modes to limit blast radius
- Codex won't expose secrets in output (but can read them)

## Codex vs Claude Code vs Kiro
| Feature | Codex CLI | Claude Code | Kiro |
|---------|-----------|-------------|------|
| Config | AGENTS.md + .codex/ | CLAUDE.md | .kiro/steering/ |
| Sandbox | 3 modes | Permission system | Powers system |
| Models | o4-mini, gpt-4.1, o3, gpt-5.5 | Sonnet, Opus, Haiku | Multiple |
| Cloud | No native | No native | Cloud sessions |
| IDE | CLI only | CLI-first | Full IDE |
| Voice | No | Via plugins | Native |
| Checkpoints | Git-based | Git-based | Native rewind |
| Orchestration | Built-in workflow | Subagents | Crew mode |
| Approval | 4 policies | Permission prompts | Permission system |