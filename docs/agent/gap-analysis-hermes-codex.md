# haksterAi Gap Analysis: Running at Hermes/Codex CLI Level

## Executive Summary

haksterAi has a rich tool set (especially for pentesting) and solid MCP integration, but its architecture is **server-first, not CLI-first**. Codex, Claude Code, OpenCode, and Aider all run their agent loops locally in the terminal. haksterAi's CLI is a thin client that cannot operate without the server. This is the single biggest architectural gap. Below that, haksterAi lacks the polish layer that makes production agents feel reliable: approval modes, session persistence, project configuration, context compaction, and git integration.

---

## Feature Matrix

| Feature | haksterAi | Codex CLI | Claude Code | OpenCode | Aider |
|---|:---:|:---:|:---:|:---:|:---:|
| Standalone CLI (no server) | ✗ | ✓ | ✓ | ✓ | ✓ |
| Approval/permission modes | Partial | ✓ (3 tiers) | ✓ | — | — |
| Session resume | ✗ | ✓ | ✓ | ✓ | — |
| Project config file (AGENTS.md) | ✗ | ✓ | ✓ | — | — |
| Sandbox/isolation | ✗ | ✓ (network) | ✓ | — | — |
| Git auto-checkpoint | ✗ | ✓ | ✓ | — | ✓ |
| Context compaction | — | ✓ | ✓ | — | ✓ |
| Sub-agent worktree isolation | ✗ | ✓ | ✓ | — | — |
| Background agent tasks | ✗ | ✓ (Cloud) | ✓ | — | — |
| Code review workflow | — | ✓ | ✓ | — | — |
| LSP integration | ✗ | — | ✓ | ✓ | ✓ |
| Diff preview before apply | — | ✓ | ✓ | — | ✓ |
| Image/vision input | ✗ | ✓ | ✓ | — | — |
| MCP integration | ✓ | ✓ | ✓ | ✓ | — |
| Custom slash commands | Skills only | — | ✓ | — | — |
| Multi-model routing | Per session | — | Per command | ✓ | Per file |
| Memory persistence | ✓ (SQLite) | ✓ | ✓ | — | — |
| Skill/plugin system | ✓ (750+) | ✓ | ✓ | — | — |
| Browser automation | ✓ (Playwright) | — | ✓ | — | — |
| Sub-agent spawning | ✓ | ✓ | ✓ | — | — |
| Fuzzy patch/apply | ✓ (multi_patch) | ✓ | ✓ | — | ✓ |
| Tool loop detection | ✓ | — | ✓ | — | — |
| Dangerous command gating | ✓ | ✓ | ✓ | — | — |

---

## CRITICAL GAPS (must-fix)

### 1. CLI-First Autonomous Agent Loop

**What's missing**: The CLI (`cli/index.js`, 662 lines) is a thin WebSocket/HTTP client. It cannot run without the server. Every competitor runs their agent loop locally.

**Impact**: Users must start a server daemon before using the CLI. No offline operation. No `ssh` into a remote box and just run `hakster`.

**Fix**: Extract the agent loop from `server/src/agent/index.js` (6314 lines) into a shared module. Create `cli/agent.js` that embeds the loop in-process.

**Key files**:
- `cli/index.js` — needs rewrite or new module
- `server/src/agent/index.js` — extract core loop into `server/src/agent/loop.js`
- `server/src/providers.js` — already exports `chat`/`stream`/`AGENT_TOOLS`

**Approach**: Add a `--local` flag to the CLI that skips the server and runs the agent loop directly using the provider SDK calls already in `providers.js`.

```bash
# Current (requires server):
hakster chat "fix the login bug"

# Target (standalone):
hakster --local chat "fix the login bug"

# Or, auto-start server if not running:
hakster chat "fix the login bug" --auto-server
```

### 2. Approval/Permissions System

**What's missing**: haksterAi has `dangerousCommands` confirmation (asks before `rm -rf`, etc.) but no structured approval mode system.

**Impact**: Users must babysit every operation or approve everything. No middle ground.

**Fix**: Add three approval tiers:

| Mode | File reads | File writes | Shell commands | Dangerous commands |
|---|:---:|:---:|:---:|:---:|
| `--suggest` | ✓ | Show diff only | Show command only | Blocked |
| `--auto-edit` | ✓ | ✓ | Confirm each | Blocked |
| `--full-auto` | ✓ | ✓ | ✓ | Confirm each |

**Key files**:
- `server/src/agent/index.js` — extend the dangerous command check into a permissions layer
- `cli/index.js` — add `--suggest`, `--auto-edit`, `--full-auto` flags

The `dangerousCommands` array already exists. Wrap it in a proper `ApprovalMode` enum and check it before every tool execution, not just shell commands.

### 3. Session Persistence & Resume

**What's missing**: Sessions are ephemeral (in-memory on the server). No way to list past sessions or resume one.

**Impact**: Closing the terminal kills the conversation. Starting over wastes context and time.

**Fix**: Use the existing `better-sqlite3` dependency to persist sessions.

**Key files**:
- New: `server/src/session.js` — SQLite session store
- `server/src/index.js` — add `GET /sessions`, `POST /sessions/:id/resume`
- `cli/index.js` — add `hakster resume <id>`, `hakster sessions`

**Schema**:
```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  created_at INTEGER,
  updated_at INTEGER,
  provider TEXT,
  model TEXT,
  cwd TEXT,
  messages TEXT -- JSON array
);
```

### 4. Project-Level Configuration

**What's missing**: No equivalent of Codex's `AGENTS.md` or Claude Code's `CLAUDE.md`. The system prompt is static.

**Impact**: The agent doesn't know project-specific rules, style preferences, or domain context unless the user repeats them every session.

**Fix**: Add `.hakster/AGENTS.md` (or `HAKSTER.md`) auto-loading. When the agent starts, check `cwd/.hakster/AGENTS.md` and prepend it to the system prompt.

**Key files**:
- `server/src/agent/index.js` — system prompt construction
- `server/src/skills.js` — already loads markdown from directories; reuse pattern

The project already has `AGENTS.md` at `/home/ghost/haksterAi/AGENTS.md` but it's not auto-loaded into the agent's system prompt.

### 5. Sandbox/Isolation Model

**What's missing**: Shell commands run directly on the host with full access.

**Impact**: A bad agent command could `rm -rf /` or overwrite system files.

**Fix (progressive)**:

**Phase 1 — `--writable-root`**: Restrict file writes to a specified directory tree. Read-only access outside.

**Phase 2 — Docker sandbox**: Run shell commands in a Docker container with network restrictions, matching Codex's approach.

**Key files**:
- `server/src/agent/index.js` — `exec_shell` handler, file operation handlers
- New: `server/src/sandbox.js`

```bash
hakster --local --writable-root ./src chat "refactor the auth module"
```

### 6. Git Integration

**What's missing**: haksterAi has a `git_op` tool but no automatic git workflow. No checkpoint before changes, no auto-commit after.

**Impact**: No undo. If the agent breaks something, the user must manually `git checkout`.

**Fix**:

1. **Auto-checkpoint**: Before any file edit, `git add -A && git commit -m "checkpoint: before agent action"`.
2. **Auto-commit**: After a successful task, offer to commit with a meaningful message.
3. **Diff review**: Show `git diff` before committing.

**Key files**:
- `server/src/agent/index.js` — add checkpoint logic around file edit tools
- New: `server/src/git.js` — git operations module

---

## HIGH PRIORITY GAPS (important for production quality)

### 7. Context Compaction

**What's missing**: No context window management. When history fills up, either truncation or errors occur.

**Fix**: When messages approach the model's context limit, summarize older messages while preserving system prompt, recent turns, and memory recalls.

**Key files**: `server/src/agent/index.js` (message history management), `server/src/providers.js` (token counting)

### 8. Sub-Agent Worktree Isolation

**What's missing**: `spawn_agent` runs in the same working directory. Sub-agents can conflict with each other and the parent.

**Fix**: When spawning a sub-agent, create a git worktree, run the agent there, then merge changes back.

**Key files**: `server/src/subagent.js`, `server/src/agent/index.js` (spawn_agent handler)

### 9. Background Task Execution

**What's missing**: `run_background` spawns detached processes but there's no agent-level background execution. No way to check status or retrieve results.

**Fix**: Add agent-level background execution with WebSocket status updates and result retrieval.

**Key files**: `server/src/agent/index.js`, `server/src/index.js`

### 10. Code Review Workflow

**What's missing**: No built-in review system. Codex has `/review`, Claude Code has `/code-review`.

**Fix**: Implement as skills leveraging the existing skill system (create `coding/skills/code-review.md`, `coding/skills/security-review.md`).

### 11. LSP Integration

**What's missing**: No Language Server Protocol integration. Agents operate on raw text without type information.

**Fix**: Create `server/src/lsp.js` client that connects to language servers and exposes diagnostics, hover info, and go-to-definition as agent tools.

### 12. Streaming Architecture for CLI

**What's missing**: CLI streaming requires a running server. For local-first operation, need either embedded streaming or auto-started server with Unix socket.

**Fix**: Option (a) embed the streaming loop in the CLI process for `--local` mode. Option (b) auto-start the server on CLI launch and use Unix domain socket for low-latency communication.

---

## MODERATE PRIORITY GAPS (nice-to-have for parity)

### 13. Diff Preview UI

**Current**: `edit_file` applies changes directly. `multi_patch` has fuzzy matching.
**Missing**: Colorized diff display in the terminal before applying, especially in `--suggest` mode.

### 14. Image/Vision Input

**Current**: No image input from CLI.
**Missing**: Accept screenshots or images and pass to vision-capable models (Claude, GPT-4o).

### 15. Desktop App / IDE Extension

**Current**: Web dashboard (Astro) but no desktop app or IDE extension.
**Missing**: VS Code extension, desktop wrapper (Electron/Tauri).

### 16. Share Links

**Current**: No session sharing.
**Missing**: Generate a link to share/replay a session.

### 17. Custom Slash Commands

**Current**: Extensive skill system (750+ markdown files) but no user-defined slash commands.
**Missing**: `.hakster/commands/` directory for custom commands à la Claude Code.

### 18. Multi-Model Routing per Tool

**Current**: One model per session.
**Missing**: Route different tools to different models (e.g., Haiku for linting, Sonnet for complex edits).

---

## Implementation Priority

| Priority | Gap | Effort | Impact |
|:---:|---|:---:|:---:|
| P0 | CLI-first agent loop | L | Critical |
| P0 | Approval modes | M | Critical |
| P1 | Session persistence | M | High |
| P1 | Project config (AGENTS.md) | S | High |
| P1 | Git auto-checkpoint | M | High |
| P2 | Sandbox (--writable-root) | M | High |
| P2 | Context compaction | M | High |
| P2 | Sub-agent worktree isolation | M | Medium |
| P2 | Background task execution | M | Medium |
| P3 | Code review workflow (skills) | S | Medium |
| P3 | LSP integration | L | Medium |
| P3 | Streaming for CLI | M | Medium |
| P4 | Diff preview UI | S | Low |
| P4 | Image/vision input | S | Low |
| P4 | Custom slash commands | S | Low |

---

## Immediate Next Steps

1. **Extract agent loop** from `server/src/agent/index.js` into `server/src/agent/loop.js` (shared module).
2. **Create `cli/agent.js`** that imports the shared loop and runs in-process with `--local` flag.
3. **Add approval modes** (`--suggest`, `--auto-edit`, `--full-auto`) to the dangerous command check system.
4. **Auto-load `.hakster/AGENTS.md`** into the system prompt using the existing skill-loading pattern from `server/src/skills.js`.
5. **Add session persistence** using the existing `better-sqlite3` dependency.
6. **Add git auto-checkpoint** before destructive file operations.

These 6 changes would bring haksterAi from "server-dependent tool with a thin CLI client" to "CLI-first agent that rivals Codex and Hermes for autonomous coding workflows."