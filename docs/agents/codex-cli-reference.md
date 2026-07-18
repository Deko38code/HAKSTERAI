# Codex CLI Reference

> Comprehensive reference for OpenAI Codex CLI — features, configuration, and patterns worth adopting in haksterAi.
> Source: https://developers.openai.com/codex + https://github.com/openai/codex
> Last scraped: 2026-07-16

---

## 1. Overview

Codex CLI is a Rust-based terminal AI coding agent from OpenAI. It inspects code, makes edits, runs commands, and automates repeatable work from the terminal.

**Install**: `curl -fsSL https://chatgpt.com/codex/install.sh | sh` (macOS/Linux), `npm install -g @openai/codex`, or `brew install --cask codex`

**Run**: `codex` (interactive TUI), `codex exec "task"` (non-interactive)

**Models**: gpt-5.6, gpt-5.6-sol, gpt-5.6-terra, gpt-5.4, gpt-5.3-codex-spark

**Reasoning efforts**: ultra, max, xhigh, high, medium, low, minimal, none

---

## 2. Configuration (config.toml)

Codex uses **TOML-based** configuration:

| Layer | Path | Notes |
|-------|------|-------|
| System | OS-specific (`/etc/xdg/` or `Library/Application Support/`) | Lowest precedence |
| User | `~/.codex/config.toml` | |
| Profile | `~/.codex/<name>.config.toml` | Switched via `--profile` |
| Project | `<repo>/.codex/config.toml` | Only loaded for *trusted* projects |
| CLI flags | `--model`, `--config`, etc. | Highest precedence |

**Precedence**: CLI flags > Project config > Profile config > User config > System config > Defaults

**Security**: Project config **cannot** override `openai_base_url`, `chatgpt_base_url`, `model_provider`, `model_providers`, `notify`, `profile`, `profiles`, `otel`, or other security-sensitive settings.

### Key Settings

```toml
model = "gpt-5.6"
model_provider = "openai"
model_reasoning_effort = "xhigh"
approval_policy = "on-request"       # "untrusted" | "on-request" | "never" | { granular = {...} }
sandbox_mode = "read-only"            # "read-only" | "workspace-write" | "danger-full-access"
default_permissions = ":workspace"    # Built-in: :read-only, :workspace, :danger-full-access
allow_login_shell = true
file_opener = "vscode"               # vscode | vscode-insiders | windsurf | cursor | none
web_search = "cached"                  # disabled | cached | indexed | live
project_doc_max_bytes = 32768
```

### Model Providers

Custom providers with API key or command-backed auth:

```toml
model = "gpt-5.4"
model_provider = "proxy"

[model_providers.proxy]
name = "OpenAI via Proxy"
base_url = "http://proxy.example.com"
env_key = "OPENAI_API_KEY"

[model_providers.proxy.auth]
command = "/usr/local/bin/fetch-codex-token"
args = ["--audience", "codex"]
timeout_ms = 5000
refresh_interval_ms = 300000
```

Built-in Amazon Bedrock:

```toml
model_provider = "amazon-bedrock"
model = "<bedrock-model-id>"

[model_providers.amazon-bedrock.aws]
profile = "default"
region = "eu-central-1"
```

### Profiles

Named configuration layers stored at `~/.codex/<name>.config.toml`:

```bash
codex --profile deep-review
codex exec --profile ci "review this change"
```

### Shell Environment Policy

```toml
[shell_environment_policy]
inherit = "none"          # "all" (default) | "core" | "none"
set = { PATH = "/usr/bin", MY_FLAG = "1" }
exclude = ["AWS_*", "AZURE_*"]
include_only = ["PATH", "HOME"]
ignore_default_excludes = false
```

---

## 3. AGENTS.md System

Codex discovers instruction files starting from `~/.codex/AGENTS.md` (global), then walking from the project root to the current working directory, concatenating with blank-line joins.

- `project_doc_max_bytes`: Max bytes from each AGENTS.md file (default 32768)
- `project_doc_fallback_filenames`: Additional filenames to try when AGENTS.md is missing
- `project_root_markers`: Directory markers for project root detection (default `[".git"]`)
- `/init` command: Creates AGENTS.md in the current project

Agent role definitions live in `.codex/agents/*.toml` files.

---

## 4. Permission Modes & Approval Policies

### Approval Policies

| Policy | Behavior |
|--------|----------|
| `untrusted` | Only known-safe read-only commands auto-run; others prompt |
| `on-request` | Model decides when to ask (default) |
| `never` | Never prompt (risky — for CI/CD) |
| `{ granular = {...} }` | Per-category allow/auto-reject rules |

Granular sub-options: `sandbox_approval`, `rules`, `mcp_elicitations`, `request_permissions`, `skill_approval`

### Sandbox Modes

| Mode | Filesystem | Network |
|------|-----------|---------|
| `read-only` (default) | Read only | Blocked |
| `workspace-write` | Write within workspace + writable roots | Blocked by default, `network_access = true` opts in |
| `danger-full-access` | No restrictions | No restrictions |

In `workspace-write` mode, `.git/` and `.codex/` remain read-only.

### Named Permission Profiles (Beta)

Built-in: `:read-only`, `:workspace`, `:danger-full-access`

Custom profiles with fine-grained filesystem glob rules and network domain allowlists:

```toml
default_permissions = "workspace"

[permissions.workspace.workspace_roots]
"~/code/app" = true
"~/code/shared-lib" = true

[permissions.workspace.filesystem]
":workspace_roots" = { "." = "write", "**/*.env" = "deny" }
"/absolute/path/to/secrets" = "deny"

[permissions.workspace.network]
enabled = true
mode = "limited"
[permissions.workspace.network.domains]
"api.openai.com" = "allow"
"example.com" = "deny"
```

### Auto-Review

`approvals_reviewer = "auto_review"` replaces manual approval with a separate reviewer agent:

- Only evaluates actions crossing a sandbox boundary
- Sees compact transcript + exact approval request (not hidden reasoning)
- **Denial circuit breaker**: interrupts turn after 3 consecutive denials or 10 denials in last 50 reviews
- Override with `/approve`
- Local policy: `[auto_review].policy = "..."`; managed `guardian_policy_config` takes precedence

---

## 5. Rules System

Rules control which commands Codex can run **outside** the sandbox. Experimental feature.

Files: `.rules` files under `rules/` next to an active config layer (e.g., `~/.codex/rules/default.rules`).

```python
prefix_rule(
    pattern = ["gh", "pr", "view"],
    decision = "prompt",
    justification = "Viewing PRs is allowed with approval",
    match = ["gh pr view 7888"],
    not_match = ["gh pr --repo openai/codex view 7888"],
)
```

Fields: `pattern` (required, list of strings), `decision` (`allow` | `prompt` | `forbidden`), `justification` (optional), `match`/`not_match` (inline unit tests).

Tree-sitter splits `bash -lc` / `bash -c` / `zsh -c` / `sh -c` commands for simple chains (`&&`, `||`, `;`, `|`). Commands with redirections, substitutions, env vars, or wildcards are treated as a single invocation.

Test: `codex execpolicy check --pretty --rules ~/.codex/rules/default.rules -- gh pr view 7888`

---

## 6. Subagents

Built-in agent roles: `default`, `worker`, `explorer`

Custom agent roles in `.codex/agents/*.toml`:

```toml
[agents.reviewer]
description = "Find correctness, security, and test risks in code."
config_file = "./agents/reviewer.toml"
nickname_candidates = ["Athena", "Ada"]
```

Configuration:

```toml
[agents]
max_threads = 6           # Maximum concurrent agent threads (default 6)
max_depth = 1             # Maximum nesting depth (root starts at 0)
interrupt_message = true  # Record message when agent turn is interrupted
job_max_runtime_seconds = 1800  # Per-worker timeout for spawn_agents_on_csv
```

`spawn_agents_on_csv` tool for batch processing with CSV input — dispatches multiple agent threads from a CSV file.

---

## 7. Hooks System

Lifecycle hooks in `hooks.json` or inline `[[hooks.EventName]]` in `config.toml`.

**Events**: `SessionStart`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `UserPromptSubmit`, `SubagentStart`, `SubagentStop`, `Stop`

**Matcher patterns**: Regex matched against tool name (for tool events) or event type.

**Command hooks receive JSON on stdin**.

Inline TOML example:

```toml
[[hooks.PreToolUse]]
matcher = "^Bash$"

[[hooks.PreToolUse.hooks]]
type = "command"
command = '/usr/bin/python3 "$(git rev-parse --show-toplevel)/.codex/hooks/pre_tool_use_policy.py"'
timeout = 30
statusMessage = "Checking Bash command"
```

Load locations:
- `~/.codex/hooks.json` (user-level)
- `~/.codex/config.toml` (user-level inline)
- `<repo>/.codex/hooks.json` (project-level, requires trust)
- `<repo>/.codex/config.toml` (project-level inline, requires trust)

Feature flag: `[features] hooks = true` (on by default)

---

## 8. MCP Integration

Configuration via `[mcp_servers.<name>]` tables in `config.toml`.

**STDIO server:**

```toml
[mcp_servers.context7]
command = "npx"
args = ["-y", "@upstash/context7-mcp@latest"]
env = { NODE_TLS_REJECT_UNAUTHORIZED = "0" }
```

**Streamable HTTP server:**

```toml
[mcp_servers.remote-api]
url = "https://api.example.com/mcp"
bearer_token_env_var = "MY_API_KEY"
startup_timeout_sec = 15
tool_timeout_sec = 120
required = true
```

Per-server options: `enabled`, `disabled_tools`, `enabled_tools`, `default_tools_approval_mode` (`auto` | `prompt` | `writes` | `approve`), per-tool overrides, OAuth (`auth = "oauth"`), `experimental_environment` (`local` | `remote`).

---

## 9. Non-Interactive Mode (CI/CD)

```bash
codex exec "fix the type error in main.ts"
codex exec --json "list the open PRs"
codex exec --output-schema 'type Response = { files: string[] }' --json "list changed files"
codex exec --ephemeral "quick refactor"
codex exec --resume <thread-id> "continue fixing tests"
echo "Explain this error" | codex exec -
codex exec --profile ci "review this change"
```

Key flags: `--json` (JSONL output), `--output-schema`, `--ephemeral`, `--resume`, `--profile`, `--model`, `--config`

---

## 10. Skills

Skills are reusable workflow packages:

- `SKILL.md` (required): Name, description, workflow instructions
- Optional: scripts, reference files, assets
- Scan locations: `.agents/skills`, `$HOME/.agents/skills`, `/etc/codex/skills`, bundled skills
- ChatGPT uses `@` mentions; Codex uses `$` mentions
- Progressive disclosure for context efficiency

Per-skill overrides:

```toml
[[skills.config]]
path = "/path/to/skill/SKILL.md"
enabled = false
```

Feature flag: `[features] skill_mcp_dependency_install = true` (on by default, allows installing missing MCP dependencies for skills)

---

## 11. Speed / Fast Mode

Fast mode increases model speed by 1.5× at higher credit consumption:
- GPT-5.6 and GPT-5.5: 2.5× Standard rate
- GPT-5.4: 2× Standard rate

TUI: `/fast on`, `/fast off`, `/fast status`

Config: `service_tier = "fast"` + `[features] fast_mode = true`

**Codex-Spark** (`gpt-5.3-codex-spark`): Separate fast, less-capable model for near-instant real-time coding iteration. ChatGPT Pro only during research preview.

---

## 12. Sandbox & Security

### Platform Enforcement

| Platform | Mechanism |
|----------|-----------|
| macOS | Seatbelt (`sandbox-exec`) |
| Linux | bwrap (bubblewrap) + seccomp |
| Windows | Native sandbox or WSL2 |

### Protected Paths

In `workspace-write` mode, `.git/` and `.codex/` remain read-only. Commands like `git commit` may need approval to run outside the sandbox.

```toml
[sandbox_workspace_write]
exclude_tmpdir_env_var = false
exclude_slash_tmp = false
writable_roots = ["/Users/YOU/.pyenv/shims"]
network_access = false
```

---

## 13. Environment Variables

| Variable | Purpose |
|----------|---------|
| `CODEX_HOME` | Config/state directory (default `~/.codex`) |
| `CODEX_SQLITE_HOME` | SQLite state directory |
| `CODEX_NON_INTERACTIVE` | Force non-interactive mode |
| `CODEX_API_KEY` | API key for authentication |
| `CODEX_ACCESS_TOKEN` | Access token |
| `RUST_LOG` | Rust log level for debugging |
| `SSL_CERT_FILE` | SSL certificate file |

---

## 14. Notifications & History

Notifications:

```toml
notify = ["python3", "/path/to/notify.py"]  # External command

[tui]
notifications = true
notification_method = "auto"          # auto | osc9 | bel
notification_condition = "unfocused"  # unfocused | always
```

History:

```toml
[history]
persistence = "save-all"  # or "none"
max_bytes = 104857600     # 100 MiB cap
```

---

## 15. Observability (OpenTelemetry)

```toml
[otel]
environment = "staging"
exporter = "none"  # or { otlp-http = { ... } } or { otlp-grpc = { ... } }
log_user_prompt = false
```

Key events: `codex.conversation_starts`, `codex.api_request`, `codex.sse_event`, `codex.user_prompt`, `codex.tool_decision`, `codex.tool_result`, `codex.hooks.run`

---

## 16. CLI Commands

| Command | Description |
|---------|-------------|
| `codex` | Start interactive TUI |
| `codex exec "task"` | Non-interactive mode |
| `codex resume` | Resume a saved session |
| `codex --image file.png` | Include image in prompt |
| `codex --search` | Enable live web search |
| `codex mcp` | Manage MCP servers |
| `codex completion <shell>` | Generate shell completions |
| `/init` | Create AGENTS.md |
| `/status` | Show current session config |
| `/permissions` | Set permission boundaries |
| `/model` | Choose model and reasoning effort |
| `/review` | Review changes |
| `/fast on\|off\|status` | Toggle fast mode |
| `/approve` | Override auto-review denials |
| `/theme` | Change syntax highlighting theme |

---

## Patterns Worth Adopting in haksterAi

### 1. TOML Configuration with Layered Precedence
Codex's config system with system → user → profile → project → CLI flags precedence is clean and extensible. haksterAi should adopt layered JSON/TOML config with security-safe project overrides.

### 2. AGENTS.md Discovery with Fallbacks
Walking from global `~/.codex/AGENTS.md` through project root to CWD, with configurable `project_doc_max_bytes` and `project_doc_fallback_filenames`. This is more robust than a single-file approach.

### 3. Auto-Review as Safety Layer
The auto-review concept — a separate reviewer agent that only evaluates sandbox boundary crossings, with denial circuit breakers — is an elegant middle ground between full-auto and manual approval.

### 4. Named Permission Profiles with Glob Rules
Fine-grained filesystem glob rules (`"**/*.env" = "deny"`) and network domain allowlists are more expressive than simple allow/deny lists. haksterAi should adopt this granularity.

### 5. Rules System with Inline Tests
`.rules` files with `match`/`not_match` inline tests for command policies are self-documenting and testable. haksterAi's shell safety should adopt this pattern.

### 6. Subagent Throttling
`max_threads`, `max_depth`, and `job_max_runtime_seconds` are essential for preventing runaway agent chains. haksterAi's `spawn_agent` should have similar bounds.

### 7. Profile Switching
Named config profiles (`--profile ci`, `--profile deep-review`) are useful for switching between task-specific configurations. haksterAi should support profile switching.

### 8. Structured Output for CI
`--output-schema` and `--json` with typed output schemas is critical for CI/CD integration. haksterAi's `exec` mode should support structured output.

### 9. Shell Environment Policy
Explicit control over which environment variables are inherited, excluded, or set — with case-insensitive glob patterns — is important for security. haksterAi should adopt this.

### 10. History Persistence with Size Limits
`save-all` or `none` persistence with configurable byte caps prevents unbounded history growth.

---

## 17. Internal System Prompts (from codex-rs/core)

> Extracted from the actual Rust source tree: `codex-rs/core/`. These are the real prompt templates shipped with Codex CLI, not the public docs stubs.

### gpt-5.2-codex Prompt (`core/gpt-5.2-codex_prompt.md`)

The base system prompt for GPT-5.2 Codex:

```
You are Codex, a coding agent based on GPT-5. You and the user share the same
workspace and collaborate to achieve the user's goals.

{{ personality }}

# Working with the user

You interact with the user through a terminal. You are producing plain text
that will later be styled by the program you run in. Formatting should make
results easy to scan, but not feel mechanical. Use judgment to decide how
much structure adds value. Follow the formatting rules exactly.

## Final answer formatting rules
- You may format with GitHub-flavored Markdown.
- Structure your answer if necessary, the complexity of the answer should
  match the task. If the task is simple, your answer should be a one-liner.
  Order sections from general to specific to supporting.
- Never use nested bullets. Keep lists flat (single level). If you need
  hierarchy, split into separate lists or sections or if you use : just
  include the line you might usually render using a nested bullet
  immediately after it. For numbered lists, only use the 1. 2. 3. style
  markers (with a period), never 1).
- Headers are optional, only use them when you think they are necessary.
  If you do use them, use short Title Case (1-3 words) wrapped in **…**.
  Don't add a blank line.
- Use monospace commands/paths/env vars/code ids, inline examples, and
  literal keyword bullets by wrapping them in backticks.
- Code samples or multi-line snippets should be wrapped in fenced code
  blocks. Include an info string as often as possible.
- File References: Use inline code to make file paths clickable. Each
  reference should be a stand alone path. Accepted: absolute,
  workspace-relative, a/ or b/ diff prefixes, or bare filename/suffix.
  Optionally include line/column (1-based): :line[:column] or #Lline[Ccolumn].
  Do not use URIs like file://, vscode://, or https://. Do not provide range
  of lines. Examples: src/app.ts, src/app.ts:42, b/server/index.js#L10
- Don't use emojis.

## Presenting your work
- Balance conciseness to not overwhelm the user with appropriate detail for
  the request. Do not narrate abstractly; explain what you are doing and why.
- The user does not see command execution outputs. When asked to show the
  output of a command, relay the important details in your answer or
  summarize the key lines so the user understands the outcome.
```

**Key takeaways for haksterAi**:
- The `{{ personality }}` slot is injected from personality templates (see §18)
- Flat lists only — no nested bullets. Split into sections instead.
- File references use inline code with standalone paths, optionally with `:line` or `#Lline[Ccolumn]`
- No emojis, no `file://` URIs, no line ranges
- The user does not see tool output — the agent must relay important details

### gpt-5-codex / gpt-5.1-codex-max Prompts (`core/gpt_5_codex_prompt.md`, `core/gpt-5.1-codex-max_prompt.md`)

All three model prompts (gpt-5-codex, gpt-5.2-codex, gpt-5.1-codex-max) share the same core structure:

```
You are Codex, based on GPT-5. You are running as a coding agent in the Codex
CLI on a user's computer.

## General
- When searching for text or files, prefer using `rg` or `rg --files`
  respectively because `rg` is much faster than alternatives like `grep`.

## Editing constraints
- Default to ASCII when editing or creating files.
- Add succinct code comments that explain what is going on if code is not
  self-explanatory.
- Try to use apply_patch for single file edits, but it is fine to explore
  other options to make the edit if it does not work well. Do not use
  apply_patch for changes that are auto-generated or when scripting is more
  efficient.
- You may be in a dirty git worktree.
  * NEVER revert existing changes you did not make unless explicitly requested.
  * If changes are in files you've touched recently, read carefully and
    understand how you can work with the changes rather than reverting.
  * If changes are in unrelated files, just ignore them.
- Do not amend a commit unless explicitly requested.
- While you are working, you might notice unexpected changes that you didn't
  make. If this happens, STOP IMMEDIATELY and ask the user.
- NEVER use destructive commands like `git reset --hard` or `git checkout --`
  unless specifically requested or approved.

## Plan tool
- Skip using the planning tool for straightforward tasks (roughly the easiest 25%).
- Do not make single-step plans.
- When you made a plan, update it after having performed one of the sub-tasks
  that you shared on the plan.
```

**Key takeaways for haksterAi**:
- Prefer `rg` over `grep` — hardcoded in the system prompt
- `apply_patch` is the preferred edit tool for single-file changes
- Dirty worktree safety: never revert changes you didn't make
- Plan tool: skip for easy tasks (bottom 25%), never single-step plans, always update after completing a sub-task
- STOP IMMEDIATELY on unexpected changes — don't silently "fix" them

---

## 18. Personality Templates (`core/templates/personalities/`)

Codex separates personality from capability via swappable personality templates injected via `{{ personality }}`.

### Pragmatic (`gpt-5.2-codex_pragmatic.md`)

```
You are Codex, operating in pragmatic mode. You prioritize:
- Correctness over cleverness
- Working code over perfect abstractions
- Clear communication over exhaustive explanation
- Action over deliberation when the path is clear

When blocked, you say so directly rather than guessing. You prefer
explicit error handling over silent fallbacks.
```

### Friendly (`gpt-5.2-codex_friendly.md`)

```
You are Codex, operating in friendly mode. You are:
- Conversational and warm without being verbose
- Quick to celebrate progress and acknowledge effort
- Honest about limitations — you say "I'm not sure" when it's true
- Proactive about offering next steps and alternatives
```

**Implication for haksterAi**: Personality is a swappable slot, not hardcoded. haksterAi could support personality profiles (`--personality pragmatic|friendly|concise|detailed`) by injecting different personality blocks into the system prompt template.

---

## 19. Orchestrator Template (`core/templates/agents/orchestrator.md`)

The orchestrator agent template defines collaboration behavior:

```
- If the user makes a simple request (such as asking for the time) which you
  can fulfill by running a terminal command (such as `date`), you should do so.
- Treat the user as an equal co-builder; preserve the user's intent and coding
  style rather than rewriting everything.
- When the user is in flow, stay succinct and high-signal; when the user seems
  blocked, get more animated with hypotheses, experiments, and offers to take
  the next concrete step.
- Propose options and trade-offs and invite steering, but don't block on
  unnecessary confirmations.
- Reference the collaboration explicitly when appropriate emphasizing shared
  achievement.

### User Updates Spec
- If you expect a longer heads-down stretch, post a brief heads-down note with
  why and when you'll report back; when you resume, summarize what you learned.
- Only the initial plan, plan updates, and final recap can be longer, with
  multiple bullets and paragraphs

### Reviews
When the user asks for a review, you default to a code-review mindset. Your
response prioritizes identifying bugs, risks, behavioral regressions, and
missing tests. You present findings first, ordered by severity and including
file or line references where possible.
```

**Key takeaways for haksterAi**:
- "Equal co-builder" framing — preserve user intent, don't rewrite everything
- Adaptive verbosity: succinct when in flow, more animated when blocked
- Heads-down protocol: post a note before long stretches, summarize after
- Review mode is distinct: severity-ordered findings with file:line references

---

## 20. Memory System (`ext/memories/`)

Codex has a structured memory system with a decision boundary for when to use it:

### Memory Read Path (`ext/memories/templates/memories/read_path.md`)

```
## Memory

You have access to a memory folder with guidance from prior runs. It can save
time and help you stay consistent. Use it whenever it is likely to help.

Decision boundary: should you use memory for a new user query?

- Skip memory ONLY when the request is clearly self-contained and does not need
  workspace history, conventions, or prior decisions.
- Hard skip examples: current time/date, simple translation, simple sentence
  rewrite, one-line shell command, trivial formatting.
- Use memory by default when ANY of these are true:
  - the query mentions workspace/repo/module/path/files in MEMORY_SUMMARY below,
  - the user asks for prior context / consistency / previous decisions,
  - the task is ambiguous and could depend on earlier project choices,
  - the ask is non-trivial and related to MEMORY_SUMMARY below.
- If unsure, do a quick memory pass.

Memory layout (general -> specific):
- {{ base_path }}/memory_summary.md (already provided below; do NOT open again)
- {{ base_path }}/MEMORY.md (searchable registry; primary file to query)
- {{ base_path }}/skills/<skill-name>/ (skill folder)
  - SKILL.md (entrypoint instructions)
  - scripts/ (optional helper scripts)
  - examples/ (optional example outputs)
  - templates/ (optional templates)
- {{ base_path }}/rollout_summaries/ (per-rollout recaps + evidence snippets)
  - These files are append-only jsonl: session_meta.payload.id identifies the
    session, turn_context marks turn boundaries, event_msg is the lightweight
    status stream, and response_item contains actual messages, tool calls,
    and tool outputs.
  - For efficient lookup, prefer matching the filename suffix or
    session_meta.payload.id; avoid broad full-content scans unless needed.

Quick memory pass (when applicable):
1. Skim the MEMORY_SUMMARY below and extract task-relevant keywords.
2. Search {{ base_path }}/MEMORY.md using those keywords.
3. Only if MEMORY.md directly points to rollout summaries/skills, open the 1-2
   most relevant files under rollout_summaries/ or skills/.
4. If above are not clear and you need exact commands, error text, or precise
   evidence, search over rollout_path for more evidence.
5. If there are no relevant hits, stop memory lookup and continue normally.

Quick-pass budget:
- Keep memory lookup lightweight: ideal 1-2 file opens, max 3-4.
```

**Key takeaways for haksterAi**:
- Memory has a **decision boundary**: skip for trivial self-contained requests, use for anything touching workspace/prior context/ambiguous tasks
- Memory layout mirrors haksterAi's own: `MEMORY.md` registry, `memory_summary.md`, `skills/` folder with SKILL.md entrypoints, `rollout_summaries/` as append-only jsonl
- Quick-pass budget: 1-2 file opens ideal, max 3-4 — prevents memory lookup from dominating the turn
- `rollout_summaries/` are append-only JSONL with `session_meta`, `turn_context`, `event_msg`, and `response_item` fields

---

## 21. Goal System (`ext/goal/`)

Codex has a goal-tracking system with templates for budget limits, continuations, and objective updates.

### Budget Limit (`ext/goal/templates/goals/budget_limit.md`)

```
You have a budget constraint for this task:
- Maximum tool calls: {{ max_tool_calls }}
- Maximum time: {{ max_time_seconds }}s
- Maximum tokens: {{ max_tokens }}

When you are within 20% of any limit, notify the user and prioritize completing
the most important remaining work. Do not silently exceed budget.
```

### Continuation (`ext/goal/templates/goals/continuation.md`)

```
You are continuing a goal from a previous session. The goal state has been
preserved below. Pick up where you left off.

Previous goal: {{ previous_goal }}
Completed steps: {{ completed_steps }}
Remaining steps: {{ remaining_steps }}
Last context: {{ last_context }}
```

### Objective Updated (`ext/goal/templates/goals/objective_updated.md`)

```
The objective has been updated by the user. Adjust your plan accordingly.

New objective: {{ new_objective }}
Previous objective: {{ previous_objective }}
Reason for change: {{ reason }}
```

**Implication for haksterAi**: haksterAi's agent loop should track goals across turns with budget limits, continuation state, and objective-update handling. The budget limit template with 20% warning threshold is directly adoptable.

---

## 22. MCP Interface Protocol (`docs/codex_mcp_interface.md`, `docs/protocol_v1.md`)

Codex communicates with MCP servers via a JSON-RPC protocol over stdio. The protocol defines:

- **Tool discovery**: `tools/list` → returns tool schemas with `name`, `description`, `inputSchema`
- **Tool execution**: `tools/call` with `name` and `arguments` → returns `content` array with `type` and `text`
- **Resource access**: `resources/read`, `resources/list`
- **Prompts**: `prompts/list`, `prompts/get`
- **Sampling**: `sampling/createMessage` for LLM-backed operations

The protocol supports both stdio transport (subprocess) and SSE transport (remote server).

---

## 23. Execution Policy (`execpolicy/README.md`)

Codex's execpolicy is a Rust crate that enforces command execution rules:

- **Rule matching**: Commands are matched against allow/deny patterns before execution
- **Sandbox enforcement**: The policy layer sits between the LLM output and the shell, filtering commands
- **Pattern syntax**: Supports glob-style patterns (`git *`, `npm *`, `rg *`) with deny-list overrides
- **Default rules**: Read-only commands (`ls`, `cat`, `head`, `tail`, `wc`, `find`, `rg`, `grep`) auto-approved; write commands require approval

**Implication for haksterAi**: haksterAi's shell safety layer should have a similar pattern-matching gate between the LLM and the shell, with glob-based allow/deny lists and a default safe set.

---

## 24. TUI Init Command (`tui/prompt_for_init_command.md`)

The `/init` command generates an AGENTS.md from the codebase:

```
Analyze this codebase and generate an AGENTS.md file that captures:
1. Project overview (what it does, tech stack)
2. Build and run commands (from package.json, Makefile, etc.)
3. Key directories and their purposes
4. Coding conventions (naming, formatting, testing patterns)
5. Environment setup (required env vars, dependencies)
6. Common workflows (how to add a feature, run tests, deploy)

Keep it concise and actionable. Use the existing project structure as truth.
Do not invent conventions that aren't evident in the codebase.
```

**Implication for haksterAi**: haksterAi's `/init` should analyze package.json, Makefile, directory structure, existing code patterns, and env examples to auto-generate AGENTS.md — not hallucinate conventions.

---

## 25. Config Loader (`config/src/loader/README.md`)

The config loader has a layered precedence system:

1. **Built-in defaults** (compiled into the binary)
2. **System config** (`/etc/xdg/codex/config.toml` on Linux, `Library/Application Support/Codex/config.toml` on macOS)
3. **User config** (`~/.codex/config.toml`)
4. **Profile config** (`~/.codex/<name>.config.toml`, selected via `--profile`)
5. **Project config** (`<repo>/.codex/config.toml`, only for trusted projects)
6. **Managed config** (admin-pushed via `requirements.toml`)
7. **CLI flags** (highest precedence)

Security-sensitive keys (`openai_base_url`, `model_provider`, `model_providers`, `notify`, `otel`, etc.) cannot be overridden by project config — only by user/system/CLI.

The `allow_managed_hooks_only` flag in `requirements.toml` makes admin-pushed hooks the only allowed hooks, ignoring user/project/session hook configs.

---

## 26. Skills System (`docs/skills.md`)

Codex has a skills system where reusable patterns are stored as markdown files:

- Skills live in `.codex/skills/<skill-name>/SKILL.md`
- Each skill has an entrypoint `SKILL.md` with instructions
- Optional: `scripts/` (helper scripts), `examples/` (example outputs), `templates/` (templates)
- Skills are discovered and injected into context when relevant to the current task
- Skills can be shared across projects via user-level `~/.codex/skills/`

**Implication for haksterAi**: This mirrors haksterAi's own `.hakster/skills/*.md` system. The pattern of SKILL.md entrypoints with optional scripts/examples/templates is directly aligned.

---

*Updated: 2026-07-18. Added sections 17-26 from codex-rs/ source tree (internal prompts, personality templates, orchestrator, memory system, goal system, MCP protocol, execpolicy, TUI init, config loader, skills).*