# CLI Agent Tool Loop Playbook

This guide combines the loop-control patterns used by HaksterAI, Claude-style tool use, Codex/OpenAI-compatible tool calls, Kiro CLI custom agents, Kiro hooks, and ReAct-style CLI agents.

Use it when building or tuning a terminal agent that can read files, edit files, run shell commands, call MCP tools, spawn sub-agents, or continue across multiple turns.

## Core Loop Contract

Every CLI agent loop should follow this state machine:

1. Receive user goal and current context.
2. Decide whether more information, a file edit, a command, or a final answer is needed.
3. If using a tool, emit a short text explanation plus one or more tool calls.
4. Execute tools with timeouts, allowlists, and dangerous-command gates.
5. Append compact tool results to model history.
6. Score progress and detect repeated patterns before the next model call.
7. Stop with a final answer, a verified change, a blocker, or a loop-break message.

Hard invariants:

- Do not allow unlimited turns. Use `maxTurns`.
- Do not allow unlimited repeated tool calls. Track `toolName + normalizedArgs`.
- Do not let tool-only assistant messages pile up without human-readable content.
- Do not retry the same failed command or tool arguments without changing strategy.
- Do not let directory browsing, grep/search, or clarification questions replace progress.
- Always include a concrete next action after a loop break.

## Detection Signals

Track these fields per session:

```js
const loopState = {
  turn: 0,
  maxTurns: 25,
  lastAssistantPrefix: '',
  recentAssistantPrefixes: [],
  recentToolCalls: [],
  consecutiveToolErrors: new Map(),
  noProgressTurns: 0,
  explorationCalls: [],
  clarifyingQuestions: 0,
  queuedMessagesSkipped: 0,
};
```

Recommended thresholds:

| Signal | Threshold | Action |
| --- | ---: | --- |
| Same tool + same args | 3 times in last 4 calls | Stop or force strategy change |
| Same tool error | 3 consecutive failures | Stop retrying that tool |
| No content or no useful progress | 3 turns | Inject loop-break instruction |
| Similar assistant prefix | 2 of last 3 turns | Stop semantic loop |
| Repeated clarification | 2-3 times | Proceed with best assumption |
| Directory/search wandering | 3 exploration calls in same subtree | Stop browsing and act |
| Shell command runtime | 60-120 seconds | Kill or timeout and inspect logs |
| Max total turns | 25-50 | Stop with partial result and next step |

## Progress Scoring

A tool call counts as progress only if it changes useful state or reveals new information.

Counts as progress:

- File was written, edited, or patched.
- Test/build/health check produced a new pass/fail signal.
- Search/read found the exact symbol, route, config, or error needed.
- A command produced non-trivial output that changes the next step.
- A user confirmation was requested for a legitimately dangerous action.

Does not count as progress:

- Re-reading the same file range.
- Listing sibling directories repeatedly.
- Running the same failing command.
- Asking the same clarification again.
- Tool result is empty, tiny, or only says not found.
- Tool output is just an error already seen.

## Unified Loop Break

When a loop is detected, do not simply stop. Change the context so the model cannot resume the same loop.

```js
function breakLoop(history, reason) {
  trimRecentLoopTurns(history, 6);
  history.push({
    role: 'system',
    content: [
      `LOOP BREAK: ${reason}.`,
      'Stop repeating searches, directory listings, clarifying questions, or failed tool calls.',
      'Immediately do one of: make a concrete edit, run one different verification command, or give the user a direct blocker with the next exact step.',
    ].join(' '),
  });
}
```

Loop break side effects:

- Clear repeated response prefixes.
- Clear exploration-call tracking.
- Drain stale queued messages that caused the loop.
- Keep the last useful facts and tool results.
- Emit a visible SSE/TUI event such as `loop_detected`.

## Claude Tool-Use Adapter

Claude-style APIs use `tool_use` and `tool_result` blocks.

Assistant tool request:

```json
{
  "role": "assistant",
  "content": [
    { "type": "text", "text": "I will inspect the package scripts first." },
    {
      "type": "tool_use",
      "id": "toolu_01",
      "name": "read_file",
      "input": { "path": "package.json" }
    }
  ]
}
```

Tool result back to Claude:

```json
{
  "role": "user",
  "content": [
    {
      "type": "tool_result",
      "tool_use_id": "toolu_01",
      "content": "{...trimmed result...}"
    }
  ]
}
```

Claude loop guard:

- Convert `tool_use.id` to the canonical `tool_call_id`.
- Convert `input` to normalized JSON before duplicate-call scoring.
- Preserve text blocks so empty tool-only responses are detectable.
- If Claude emits multiple `tool_use` blocks, execute them in order unless they are independent and safe to parallelize.

## Codex/OpenAI-Compatible Tool Loop

OpenAI-compatible APIs use `tool_calls`.

Assistant tool request:

```json
{
  "role": "assistant",
  "content": "I will run the narrow syntax check now.",
  "tool_calls": [
    {
      "id": "call_1",
      "type": "function",
      "function": {
        "name": "exec_shell",
        "arguments": "{\"command\":\"node -c server/src/index.js\",\"timeout_ms\":60000}"
      }
    }
  ]
}
```

Tool result:

```json
{
  "role": "tool",
  "tool_call_id": "call_1",
  "content": "syntax ok"
}
```

Codex/OpenAI-compatible loop guard:

- Accumulate streamed `delta.tool_calls[index].function.arguments` until valid JSON.
- Score duplicates by canonicalized arguments, not raw streaming chunks.
- Keep `tool_call_id` attached to every tool result.
- Strip provider-specific reasoning fields before sending history to a different provider.
- Trim large tool output for model context while showing richer output to the UI.

## Kiro CLI Pattern

Kiro CLI supports custom agents, steering, MCP, permissions, prompts via `file://`, and hooks. Use those as an outer harness around the model loop.

Kiro agent config pattern:

```json
{
  "name": "hakster-loop-guard",
  "description": "Agent that uses strict tool-loop detection before modifying code.",
  "prompt": "file://./cli-agent-tool-loop.md",
  "tools": ["fs_read", "fs_write", "shell", "mcp"],
  "allowedTools": ["fs_read"],
  "hooks": [
    {
      "event": "preToolUse",
      "command": "node .kiro/hooks/pre-tool-loop-guard.js"
    },
    {
      "event": "postToolUse",
      "command": "node .kiro/hooks/post-tool-progress-score.js"
    }
  ]
}
```

Kiro hook pattern:

```json
{
  "version": "v1",
  "hooks": [
    {
      "name": "block-repeated-shell",
      "trigger": "PreToolUse",
      "matcher": "shell|exec_shell|bash",
      "action": {
        "type": "command",
        "command": "node .kiro/hooks/pre-tool-loop-guard.js"
      },
      "timeout": 30,
      "enabled": true
    },
    {
      "name": "score-tool-progress",
      "trigger": "PostToolUse",
      "matcher": ".*",
      "action": {
        "type": "command",
        "command": "node .kiro/hooks/post-tool-progress-score.js"
      },
      "timeout": 30,
      "enabled": true
    }
  ]
}
```

Kiro hook behavior to mirror:

- `PreToolUse` can block risky or repeated tool calls.
- `PostToolUse` can score result quality and update loop state.
- `UserPromptSubmit` can reject prompts that would trigger destructive automation.
- `PreTaskExec` can block spec tasks that lack approval or target.
- Command exit code `2` should mean "block execution and return STDERR to the agent."
- Keep hooks fast and deterministic. Use them for policy, not long reasoning.

Example `pre-tool-loop-guard.js` behavior:

```js
const input = JSON.parse(process.env.KIRO_HOOK_INPUT || '{}');
const state = readJson('.kiro/state/tool-loop.json', { recent: [] });
const sig = `${input.toolName}:${canonicalJson(input.args || {})}`;
const repeats = state.recent.filter(item => item === sig).length;

if (repeats >= 2) {
  console.error(`Blocked repeated tool call: ${sig}`);
  process.exit(2);
}

process.exit(0);
```

## Search And Filesystem Wandering

Exploration tools are useful but can become a loop.

Exploration tools:

- `list_dir`
- `read_file`
- `search_files`
- `grep`
- `find`
- `rg`
- web search/scrape tools when the query does not narrow

Rules:

- First search: broad enough to locate the area.
- Second search: exact symbol, route, file name, error, or config key.
- Third repeated exploration in the same area: stop and act.
- If the path is unknown after two targeted searches, ask for the path or state the blocker.

## Shell Safety

Shell tools need both safety and loop control.

- Default timeout: 60 seconds.
- Long scan/build timeout: 120-300 seconds only when justified.
- Never retry a command that timed out without narrowing scope.
- Prefer `rg`, `node -c`, package scripts, health curls, PM2 status/logs, and single-purpose checks.
- Treat destructive commands, restarts, database writes, credential reads, and filesystem deletes as approval-gated.
- Redact secrets from logs and command output before adding them to model context.

## Context Cleanup

Before each model call:

- Remove empty assistant messages without content or tools.
- Remove orphan tool result messages.
- Remove duplicate consecutive user messages.
- Convert provider-specific tool formats to the active provider format.
- Truncate large tool outputs.
- Preserve the system prompt, the latest user goal, the last meaningful tool results, and the last edit/test result.

## UI/TUI Events

The agent loop should emit observable events:

- `thinking_start`, `thinking`, `thinking_end`
- `tool_call_start`
- `shell_start`, `shell_data`, `shell_end`
- `tool_call_result`
- `file_created`
- `loop_detected`
- `needs_confirmation`
- `turn_end`
- `done`, `max_turns`, `aborted`, `error`

These events make the loop debuggable and prevent the model from faking progress UI in text.

## Combined Best-Practice Checklist

- Use a bounded `while turn < maxTurns` loop.
- Normalize all tool calls into one internal shape.
- Score progress after every tool result.
- Block exact duplicate tool calls.
- Break on repeated errors.
- Break on semantic repeated assistant text.
- Break on repeated clarification.
- Break on filesystem/search wandering.
- Inject a loop-break system message when needed.
- Trim loop debris from history before continuing.
- Gate dangerous commands.
- Keep a user-visible event stream.
- Commit small verified changes instead of one huge autonomous run.
- For Kiro CLI, put the policy in markdown prompt files and enforce it with `PreToolUse` and `PostToolUse` hooks.

## References

- Kiro hooks: https://kiro.dev/docs/hooks/
- Kiro CLI custom agent configuration: https://kiro.dev/docs/cli/custom-agents/configuration-reference/
- Kiro CLI overview: https://kiro.dev/cli/
- HaksterAI web agent loop: `server/src/index.js`
- HaksterAI terminal agent loop: `server/src/agent/index.js`

## Kiro-Inspired Loop Tools (Added to loop.js)

The following Kiro-inspired loop tools have been implemented in `server/src/agent/loop.js`:

### 1. kiroPreToolGuard(ctx)
- **Pattern**: Kiro `PreToolUse` hook / `pre-tool-loop-guard.js`
- **Purpose**: Blocks repeated tool calls (same signature 2+ times in window) and known-dangerous patterns (`rm -rf /`, `mkfs`, `dd if=`, `git push --force`, raw device writes)
- **Input**: `{ toolName, args, recentCalls: string[] }`
- **Output**: `{ block: boolean, reason?: string }`

### 2. kiroPostToolScore(ctx)
- **Pattern**: Kiro `PostToolUse` hook / `post-tool-progress-score.js`
- **Purpose**: Scores tool result quality 0-10 based on success, result size, duration, errors. Triggers reflection on low scores (≤2).
- **Input**: `{ toolName, success, resultSize, hadError, duration }`
- **Output**: `{ score: number, quality: string, shouldReflect: boolean }`

### 3. kiroPromptFilter(prompt)
- **Pattern**: Kiro `UserPromptSubmit` hook
- **Purpose**: Rejects prompts containing destructive automation patterns (DROP TABLE, TRUNCATE, DELETE ALL, WIPE, FORMAT)
- **Input**: `string` prompt
- **Output**: `{ reject: boolean, reason?: string }`

### 4. kiroPreTaskGate(task)
- **Pattern**: Kiro `PreTaskExec` hook
- **Purpose**: Blocks tasks that lack description, target, or approval (trust < 10 requires explicit approval)
- **Input**: `{ description, target, approved, trustLevel }`
- **Output**: `{ block: boolean, reason?: string }`

### 5. kiroRoundBudget(ctx)
- **Pattern**: Kiro round budget system
- **Purpose**: Enforces finite round budget with convergence nudges at 67%, 80%, 100%
- **Input**: `{ round, maxRounds }`
- **Output**: `{ exhausted: boolean, phase: string, nudge?: string }`

### 6. kiroTrackCallSignature(existing, sig, maxWindow)
- **Pattern**: Kiro `.kiro/state/tool-loop.json` rolling window
- **Purpose**: Maintains rolling window of tool call signatures for loop detection
- **Input**: `string[] existing, string sig, number maxWindow`
- **Output**: `string[]` updated signature list

### 7. kiroDiagnosisTimeout(ctx)
- **Pattern**: Kiro idle-detection / diagnosis timeout
- **Purpose**: Detects consecutive read-only calls without state-modifying action. Escalates: ⚠️ (5) → 🚨 (6) → 🚨🚨 (7+)
- **Input**: `{ readOnlyStreak, lastWriteAction }`
- **Output**: `{ triggered: boolean, level: string, message?: string }`

### 8. kiroExitCodeHandler(code, stderr)
- **Pattern**: Kiro exit code 2 pattern
- **Purpose**: Exit code 2 from a hook means "block execution and return STDERR to agent"
- **Input**: `number code, string stderr`
- **Output**: `{ block: boolean, feedback?: string }`

### LOOP_GUARD Constants Added

- `KIRO_REPEAT_BLOCK: 2` — max repeated tool calls before blocking
- `KIRO_CALL_WINDOW: 20` — rolling window size for call signatures
- `KIRO_DIAGNOSIS_THRESHOLD: 5` — read-only streak before diagnosis timeout

### Integration Points

These tools are exported from `loop.js` and can be called from `index.js` during:
- **ACT phase** — `kiroPreToolGuard()` before each tool call, `kiroPostToolScore()` after
- **THINK phase** — `kiroPromptFilter()` on user input, `kiroRoundBudget()` to check budget
- **PLAN phase** — `kiroPreTaskGate()` before task execution
- **OBSERVE phase** — `kiroDiagnosisTimeout()` to detect read-only streaks
- **All phases** — `kiroTrackCallSignature()` to maintain call history, `kiroExitCodeHandler()` for hook exit codes
