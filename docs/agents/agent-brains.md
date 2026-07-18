# Agent Brains — haksterAi Unified Brain Design

This document synthesizes agent loop patterns from Claude Code, Codex CLI, Kiro CLI, and Hermes/Nous into haksterAi's own unified brain architecture. It is the design spec for `loop.js` and `autolearn.js`.

## 1. Unified Phase Enum

haksterAi's agent loop operates in explicit phases. Every turn of the loop is in exactly one phase.

| Phase | Purpose | Entry Condition | Exit Condition |
|-------|---------|----------------|----------------|
| THINK | Analyze context, load memory, plan approach | Start of turn or after OBSERVE | Plan formed or clarification needed |
| PLAN | Structure the tool call or response | After THINK with a plan | Tool call emitted or final answer ready |
| ACT | Execute tool calls and mutations | Tool calls in model output | All tools executed for this turn |
| OBSERVE | Process tool results, score progress | After ACT | Results integrated into history |
| REFLECT | Evaluate progress, detect loops, adjust strategy | After OBSERVE when triggered | Reflection injected, strategy updated |
| CONSOLIDATE | Compress memories, extract skills, persist learning | After REFLECT when consolidation threshold met | Memory written, skills extracted |

Phase transitions are deterministic:

```
THINK → PLAN → ACT → OBSERVE → (REFLECT?) → (CONSOLIDATE?) → THINK
```

REFLECT triggers when:
- No progress for `_noProgressCount >= 3`
- Semantic loop detected (prefix overlap in `_recentResponsePrefixes`)
- Same tool error repeated 3 times
- Clarifying question detected
- Filesystem wandering detected

CONSOLIDATE triggers when:
- `_rawMemories.length >= CONSOLIDATION_THRESHOLD` (default 10)
- Turn count reaches `CONSOLIDATION_TURN_INTERVAL` (default 25)
- Session is ending (exit handler)
- User explicitly requests `/consolidate`

## 2. Memory System Architecture

### 2.1 Memory Layers

| Layer | File | Purpose | Format |
|-------|------|---------|--------|
| Raw | `.hakster/memories/raw_memories.json` | Timestamped observations from each turn | JSON lines |
| Structured | `.hakster/MEMORY.md` | Consolidated lessons, preferences, patterns | Markdown |
| Summary | `.hakster/memory_summary.md` | Condensed version for system prompt injection | Markdown |
| Skills | `.hakster/skills/*.md` | Extracted reusable patterns | SKILL.md format |
| Steering | `AGENTS.md` (walk-up) | Project-level identity and rules | Markdown |

### 2.2 MEMORY.md Format

```markdown
# haksterAi Memory

## Preferences
- [preference] User prefers minimal output
- [preference] Project uses CommonJS modules

## Patterns
- [pattern] When fixing server bugs: read logs first, then locate the error, then patch
- [pattern] Always use `write` tool for files containing XML-like tags

## Lessons
- [lesson] hermes-nous-reference.md failed 4 times via bash — use `write` tool instead
- [lesson] Server restarts interrupt CLI user — minimize them

## Project Facts
- [fact] haksterAi uses CommonJS throughout
- [fact] agentLoop is at lines 5027-5833 in server/src/agent/index.js
- [fact] MAX_TURNS is 80, NO_PROGRESS_LIMIT is 15
```

### 2.3 Raw Memory Entry

```json
{
  "timestamp": "2026-07-16T12:34:56Z",
  "turn": 42,
  "phase": "OBSERVE",
  "toolUsed": "edit_file",
  "outcome": "success",
  "observation": "Patched agentLoop stuck-loop detection at line 5565",
  "tags": ["loop-detection", "agentLoop", "patch"]
}
```

### 2.4 Consolidation Pipeline

```
raw_memories.json (10+ entries)
  → group by tags and recency
  → deduplicate overlapping entries
  → merge into MEMORY.md under matching sections
  → regenerate memory_summary.md (compact version)
  → clear raw_memories.json (or archive to raw_memories.archive.json)
```

Consolidation runs:
1. Automatically when `_rawMemories.length >= CONSOLIDATION_THRESHOLD`
2. Automatically every 25 turns
3. On session exit (if any raw memories exist)
4. On explicit `/consolidate` command

### 2.5 Skill Extraction

When a task pattern recurs 3+ times in consolidated memories:

```
Pattern detected: "fix server bug" appears 3+ times with similar steps
  → Extract skill template:
    - Trigger: "fix server", "server bug", "runtime error"
    - Steps: 1) read logs, 2) locate error, 3) patch, 4) verify
    - Verification: `node -c` + `pm2 restart` + `curl health`
  → Write to .hakster/skills/fix-server-bug.md
  → Add to skill index in .hakster/skills/index.json
```

## 3. Steering Files (AGENTS.md Walk-Up)

### 3.1 Discovery Order

haksterAi discovers steering files by walking up from the current working directory to the git root:

```
CWD/.hakster/AGENTS.md
CWD/AGENTS.md
parent/.hakster/AGENTS.md
parent/AGENTS.md
...
git_root/.hakster/AGENTS.md
git_root/AGENTS.md
```

### 3.2 Loading Strategy

- **INIT mode** (session start): Load all discovered AGENTS.md files, merge them, inject into system prompt.
- **INCREMENTAL mode** (mid-session): Only reload if file mtimes changed since last load.
- **Conditional loading**: If AGENTS.md references domain specs (e.g., `@pentest`, `@cinevault`), load those conditionally based on the detected project context.

### 3.3 AGENTS.md Structure

```markdown
# haksterAi Project Context

## Identity
- Name: haksterAi
- Operator: Ghost
- Mode: autonomous agent loop

## References
- docs/agents/claude-code-reference.md
- docs/agents/codex-cli-reference.md
- docs/agents/kiro-reference.md
- docs/agents/hermes-nous-reference.md
- docs/agents/agent-brains.md
- docs/agents/auto-learn.md

## Tool Usage
- Prefer `rg` over `grep` for searches
- Use `write` tool for files with XML-like content
- Always run `node -c` after editing .js files
- Check PM2 status before suggesting server restarts

## Approval Hierarchy
1. SUGGEST — ask every time (default for dangerous commands)
2. AUTO_EDIT — auto-approve file edits, ask for shells
3. FULL_AUTO — auto-approve everything (use with caution)
```

## 4. Trust Escalation System

### 4.1 Trust Levels

| Level | Name | Auto-Approve | Confirm Required |
|-------|------|-------------|-----------------|
| 0 | SUGGEST | Nothing | Everything |
| 1 | AUTO_EDIT | File reads, file edits | Shell commands, dangerous operations |
| 2 | FULL_AUTO | Everything | Destructive commands only (rm -rf, force push, db drops) |

### 4.2 Trust Accumulation

Trust accumulates per-session based on successful tool executions:

```javascript
// Trust score starts at 0
let trustScore = 0;

// Successful file read: +1
// Successful file edit verified by node -c: +2
// Successful test run: +3
// Successful build: +5
// Failed tool call: -1

// Trust level 1 (AUTO_EDIT) at score >= 10
// Trust level 2 (FULL_AUTO) at score >= 30
```

### 4.3 Trust Decay

- Trust resets to 0 at session start.
- Trust decays by 1 point every 5 turns of inactivity.
- Trust drops to 0 immediately on any destructive action confirmation denial.

### 4.4 Integration with Existing Approval

The existing `shouldConfirm()` function in `agentLoop` already implements SUGGEST/AUTO_EDIT/FULL_AUTO levels. Trust escalation enhances this by:

1. Starting at SUGGEST (level 0) for every session.
2. Progressively upgrading to AUTO_EDIT (level 1) and FULL_AUTO (level 2) based on accumulated trust.
3. Still respecting the existing `approvalLevel` config if set explicitly.

## 5. Loop Break Mechanisms (Synthesized)

### 5.1 Existing (Keep All)

| # | Mechanism | Source | Trigger |
|---|-----------|--------|---------|
| 1 | No-progress counter | haksterAi | `_noProgressCount >= NO_PROGRESS_LIMIT` |
| 2 | Semantic loop | haksterAi | Prefix overlap in `_recentResponsePrefixes` |
| 3 | Clarifying question | haksterAi | Question detection regex |
| 4 | Grep/search loop | haksterAi | `_recentShellCommands` streak |
| 5 | Filesystem wandering | haksterAi | `_explorationCalls` threshold |
| 6 | Tool error loop | haksterAi | Same tool error 3x |
| 7 | Dangerous command gate | haksterAi | `isDangerousCommand()` + `shouldConfirm()` |
| 8 | Stall guard | haksterAi | 20-second idle timer |

### 5.2 New (Added by Unified Loop)

| # | Mechanism | Source | Trigger |
|---|-----------|--------|---------|
| 9 | Phase transition guard | Hermes/Nous | Invalid phase transition attempted |
| 10 | Self-recursion limit | Hermes/Nous | 10 consecutive THINK→PLAN cycles without ACT |
| 11 | Consolidation throttle | Codex | No more than 1 consolidation per 10 turns |
| 12 | Memory budget | Codex | Total memory injection < 2000 chars in system prompt |
| 13 | Skill extraction throttle | Codex | No more than 1 skill extraction per session |
| 14 | Steering reload guard | Kiro | Only reload AGENTS.md if mtime changed |

## 6. Conversation Compression

### 6.1 Existing

haksterAi already has `compactHistory()` which trims old messages. This is retained.

### 6.2 Enhancement: Summarization Layer

When history exceeds a token budget (default: 80% of model context), apply compression in order:

1. **Phase 1**: Compact old tool results (already exists — `HISTORY_RESULT_CAP = 4000`)
2. **Phase 2**: Summarize oldest 30% of messages into a single system message (new)
3. **Phase 3**: Drop mid-conversation clarification exchanges where both sides agree (new)

Phase 2 and 3 are optional and only triggered when Phase 1 alone doesn't bring history under budget.

## 7. Session Lifecycle

### 7.1 INIT Phase (New Session Start)

```
autoInit():
  1. Load steering files (AGENTS.md walk-up)
  2. Load MEMORY.md and memory_summary.md
  3. Load skill index (.hakster/skills/index.json)
  4. Set trust score to 0
  5. Set current phase to THINK
  6. Inject loaded context into system prompt
  7. Announce session start briefly
```

### 7.2 PER-TURN Phase Lifecycle

```
For each turn in agentLoop:
  1. Set phase = THINK
  2. (Existing loop entry: fingerprint, drain, step counter)
  3. (Existing: compact, sanitize, call model)
  4. If model response has tool_calls:
     a. Set phase = PLAN
     b. (Existing: TUI display, tool execution pipeline)
     c. Set phase = ACT
     d. (Existing: execute each tool)
     e. Set phase = OBSERVE
     f. (Existing: process results, push to history)
     g. Check shouldReflect() → if yes, set phase = REFLECT, inject reflection
     h. Check shouldConsolidate() → if yes, set phase = CONSOLIDATE, run consolidation
  5. If model response has no tool_calls:
     a. (Existing: loop detection or exit)
  6. Next turn → back to THINK
```

### 7.3 EXIT Phase (Session End)

```
autoExit():
  1. If raw_memories exist, run final consolidation
  2. Save trust score to session metadata (future: persist across sessions)
  3. Log session stats (turns, tools used, phases entered)
```

## 8. Integration Equation

This maps each design pattern to its source and haksterAi implementation:

| Pattern | Source | haksterAi Implementation |
|---------|--------|--------------------------|
| THINK → ACT → OBSERVE phases | Hermes/Nous Gerard format | `AgentLoopPhase` enum in loop.js |
| 10-iteration self-recursion limit | Hermes/Nous | Phase transition guard in loop.js |
| AGENTS.md discovery walk-up | Claude Code | `injectAgentsMd()` in loop.js |
| MEMORY.md + raw_memories pipeline | Codex | autolearn.js: `addRawMemory()`, `consolidateMemories()` |
| Skill extraction from interactions | Codex | autolearn.js: `extractSkill()` |
| Steering files (product/tech/structure) | Kiro | Conditional loading in `injectAgentsMd()` |
| Trust-based approval escalation | Kiro | Trust accumulation in loop.js, integration with existing `shouldConfirm()` |
| Conversation compression | Kiro | Enhancement layer on existing `compactHistory()` |
| Few-shot examples in system prompt | Hermes/Nous | Loaded from `.hakster/few_shot.json` if present |
| Session init → task → tool → observe → complete | All | Formalized in loop.js phase transitions |
| Loop break: no-progress | haksterAi (existing) | Unchanged |
| Loop break: semantic | haksterAi (existing) | Unchanged |
| Loop break: grep/search | haksterAi (existing) | Unchanged |
| Loop break: filesystem wandering | haksterAi (existing) | Unchanged |
| Loop break: tool error streak | haksterAi (existing) | Unchanged |
| Loop break: dangerous command gate | haksterAi (existing) | Unchanged |
| Loop break: stall guard | haksterAi (existing) | Unchanged |
| Loop break: clarifying question | haksterAi (existing) | Unchanged |
| Memory budget cap in system prompt | Codex | 2000 chars max for memory injection |
| Consolidation throttle | Codex | Max 1 consolidation per 10 turns |
| Skill extraction throttle | Codex | Max 1 skill extraction per session |
| Steering reload guard | Kiro | Only reload if mtime changed |

## 9. Phase Injection Points

Where each phase injects content into the model's context:

| Phase | Injection Point | Content Injected |
|-------|----------------|-----------------|
| THINK | Before model call | AGENTS.md, memory_summary.md, session metadata |
| PLAN | As part of THINK | Skill matches, relevant learned lessons |
| ACT | (No injection — tool execution) | — |
| OBSERVE | As tool_result messages | Tool results (existing) |
| REFLECT | Before model call when triggered | Reflection prompt: "No progress detected. Reassess strategy." |
| CONSOLIDATE | After OBSERVE when triggered | Memory consolidation (no model injection — background process) |

## 10. Key Constraints

1. **CommonJS only**: All modules use `require()`/`module.exports`.
2. **No server restart for file creation**: New files are created with `write` tool; only existing files need server restart when modified.
3. **Additive CLI changes**: `cli/index.js` changes must be additive only — "never change crush terminal in haksterai".
4. **Wraps, not replaces**: `loop.js` extends the existing `agentLoop` — it does not replace it.
5. **Works offline**: Memory and steering files are local filesystem only — no network calls.
6. **Budget-aware**: Memory injection is capped at 2000 chars in system prompt to avoid context bloat.
7. **Trust resets per session**: No cross-session trust persistence (future enhancement).
8. **Consolidation is non-blocking**: Memory consolidation happens after OBSERVE, does not block the next THINK phase.

## 11. File Dependencies

```
server/src/agent/loop.js       → exports AgentLoopPhase, transitions, hooks
server/src/agent/autolearn.js   → exports initMemory, addRawMemory, consolidateMemories, etc.
server/src/agent/index.js       → requires loop.js + autolearn.js, uses in agentLoop
cli/index.js                    → requires autolearn.js, calls autoInit() on chat start
.hakster/memories/              → raw_memories.json (created by autolearn)
.hakster/MEMORY.md              → structured memory (created by autolearn)
.hakster/memory_summary.md      → summary for injection (created by autolearn)
.hakster/skills/                → extracted skills (created by autolearn)
AGENTS.md                       → steering context (walk-up discovery by loop.js)
```

## 12. Testing Strategy

Since we're in CLI and minimizing server restarts:

1. **Syntax checks**: `node -c` on all new .js files
2. **Module require test**: `node -e "require('./server/src/agent/loop.js')"` after creation
3. **Autolearn unit test**: `node -e "const al = require('./server/src/agent/autolearn.js'); console.log(Object.keys(al))"`
4. **Integration test**: Only when all files are in place and user requests a server restart