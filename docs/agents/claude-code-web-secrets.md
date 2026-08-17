# Claude Code Web-Scraped Secrets & Tips

> Scraped from web sources on 2026-08-15. Sources: code.claude.com official docs, Reddit r/ClaudeAI, YouTube, GitHub repos.

---

## 1. HOOKS SYSTEM (Official Docs)

**Source**: https://code.claude.com/docs/en/hooks

Hooks are user-defined shell commands, HTTP endpoints, or LLM prompts that execute automatically at specific points in Claude Code's lifecycle. They run everywhere: terminal, IDE extensions, Desktop app, and web.

### Hook Types:
- **Shell hooks**: Run any shell command at lifecycle points
- **Prompt hooks** (`type: "prompt"`): Send a prompt to Claude model for single-turn evaluation. Returns yes/no decision as JSON.
- **HTTP hooks**: Call external endpoints

### Use Cases:
- Enforce project rules deterministically (not relying on LLM to choose)
- Automate repetitive tasks
- Integrate with existing tools/CI
- Lint/format code automatically after edits
- Block certain operations (e.g., prevent pushing to main)
- Run tests on file changes

### Key Insight:
Hooks give you **deterministic control** — certain actions ALWAYS happen, unlike relying on the LLM to choose to run them. This is the power move for automation.

---

## 2. HOOKS GUIDE (Official Docs)

**Source**: https://code.claude.com/docs/en/hooks-guide

### Quickstart Patterns:
- Pre-commit hooks: Auto-format/lint before commits
- Post-edit hooks: Run tests after file changes
- Session hooks: Setup environment on session start
- Prompt-based hooks: Use LLM judgment for complex decisions (yes/no JSON output)

### Hook Lifecycle Points:
- Session start/end
- Before/after file edits
- Before/after commands
- Before commits/pushes
- Custom triggers

---

## 3. PLUGINS SYSTEM (Official Docs)

**Source**: https://code.claude.com/docs/en/plugins

Plugins extend Claude Code with custom functionality shareable across projects and teams. Plugins can include:
- **Skills**: Reusable procedures/workflows
- **Agents**: Custom agent configurations
- **Hooks**: Lifecycle automation
- **MCP servers**: External tool integrations

### Plugin Architecture:
- Plugins are packages containing skills, agents, hooks, and MCP server configs
- Can be shared across projects and teams
- Installed via plugin discovery system
- Reference: https://code.claude.com/docs/en/plugins-reference

---

## 4. 25 CLAUDE CODE TIPS (Reddit r/ClaudeAI)

**Source**: https://www.reddit.com/r/ClaudeAI/comments/1qgccgs/25_claude_code_tips_from_11_months_of_intense_use/

> Reddit blocked full scrape (JS-rendered). Title confirms 25 tips from 11 months of intense use. Key themes from search snippet:

### Known Tips from Search Context:
1. **Front-load information**: Put critical context at the top of your prompt/CLAUDE.md
2. **Recap feature**: Use recap to review what Claude Code did
3. **Effort level**: Control how much effort/thinking Claude puts into responses
4. **CLAUDE.md hierarchy**: Project root, subdirectory, and user-level CLAUDE.md files all merge
5. **Subagents**: Delegate complex tasks to specialized sub-agents
6. **MCP integration**: Connect external tools via MCP servers
7. **Sandboxing**: Control what Claude Code can access/modify
8. **Permissions**: Fine-grained control over allowed/denied operations

---

## 5. 7 SECRETS FROM CLAUDE CODE CREATOR (YouTube)

**Source**: https://www.youtube.com/watch?v=8YhYtIF9PYI
**Channel**: Alex Finn (@AlexFinnOfficial)
**Uploaded**: 2026-04-18 | **Length**: 13:03 | **Views**: 29,935 | **Likes**: 959
**Category**: Science & Technology

### Video Description:
> 7 Claude Code tips and tricks that will make you a 10x vibe coder.
> FULL Claude Code bootcamp in the Vibe Coding Academy: https://vibecodingacademy.dev
> Free newsletter: https://www.alexfinn.ai/subscribe
> Follow on X: https://x.com/AlexFinn

### 7 Secrets (with timestamps from search metadata):
1. **Front load information** (5:56) — Put critical context at the top of your prompt/CLAUDE.md so Claude prioritizes it
2. **Recap feature** (6:44) — Use built-in recap to review what Claude Code did in a session
3. **Effort level** (8:04) — Control how much thinking/effort Claude puts into responses (low/medium/high)
4. **Multi-Claude workflow** — Run multiple Claude Code instances in parallel for different parts of a task
5. **Voice input** — Talk to Claude Code with your voice for faster iteration
6. **Custom status line** — Customize the status line to show useful info (git branch, token count, etc.)
7. **Container workflows** — Run Claude Code inside a container for isolated/safe execution

### Key Takeaway:
The creator emphasizes "vibe coding" — using Claude Code as a force multiplier. Front-loading context and controlling effort level are the highest-impact tips.

---

## 6. SYSTEM PROMPTS REPO (GitHub)

**Source**: https://github.com/Piebald-AI/claude-code-system-prompts

> Collection of Claude Code internal system prompts extracted/leaked.

### Known prompts in repo:
- **Creation Assistants Agent Prompt**: CLAUDE.md creation (631 tokens) — System prompt for analyzing codebases and creating CLAUDE.md documentation files
- Additional agent prompts for various Claude Code internal functions

---

## 7. HIDDEN COMMANDS (Facebook/Community)

**Source**: https://www.facebook.com/groups/claudecowork/posts/1373429010833597/

> "Unlock Claude's Full Potential: 11 Hidden Commands for Better Writing"

### Visual cheat sheet also found:
- https://www.facebook.com/groups/881330171044518/posts/99131223337964
- "Unlocking claude code's full potential with visual cheat sheet"

---

## 8. OFFICIAL DOCS INDEX

**Source**: https://code.claude.com/docs/ (llms.txt endpoint returned 404, but docs structure discovered)

### Available doc pages found:
- `/docs/en/hooks` — Hooks reference
- `/docs/en/hooks-guide` — Hooks quickstart guide
- `/docs/en/plugins` — Plugin creation guide
- `/docs/en/plugins-reference` — Plugin technical specs
- `/docs/en/discover-plugins` — Plugin discovery/installation
- `/docs/en/desktop-quickstart` — Desktop app setup
- `/docs/en/llms.txt` — Documentation index (was 404 at time of scrape)

---

## KEY TAKEAWAYS FOR HACKSTERAI

1. **Hooks = Deterministic automation**: Don't rely on LLM choice — force actions at lifecycle points. We could use this for auto-formatting, auto-testing, security checks.

2. **Plugins = Shareable power-ups**: Skills + agents + hooks + MCP servers packaged together. We could package haksterAI's pentest skills as a Claude Code plugin.

3. **Prompt hooks = LLM judgment gates**: Use Claude itself to make yes/no decisions at lifecycle points. Could be used for security validation before running commands.

4. **System prompts are extractable**: The Piebald-AI repo has Claude Code's internal prompts. Our local `claude-code-secrets.md` already has the agent creation system prompt.

5. **Effort level control**: You can control how much thinking/effort Claude puts into responses — useful for balancing speed vs depth.

6. **CLAUDE.md hierarchy**: Multiple CLAUDE.md files merge (project root + subdirectory + user-level). This is how we layer context in haksterAi already.

7. **Recap feature**: Built-in way to review what Claude Code did in a session — useful for audit trails.