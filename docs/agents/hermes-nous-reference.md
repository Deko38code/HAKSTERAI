# Hermes & Nous Research Agent Reference

> Internal reference for haksterAi agent architecture — translates Hermes/Nous prompt patterns into actionable haksterAi patterns.

## 1. System Prompt Architecture (sys_prompt.yml)

The Hermes agent uses a structured YAML system prompt with these sections:

### Role Definition
```yaml
role: |
  You are an autonomous AI agent with tool-calling capabilities.
  You operate in a loop: Think → Act → Observe → Repeat.
  Your goal is to complete tasks by using tools when needed.
```

### Objective Hierarchy
```yaml
objective: |
  1. Understand the user's request completely before acting.
  2. Break complex tasks into discrete steps.
  3. Use tools to gather information and make changes.
  4. Verify your work after each action.
  5. Report results concisely.
```

### Tool Schema
Tools are defined with JSON Schema input validation:
```yaml
tools:
  - name: read_file
    description: Read file contents
    inputSchema:
      type: object
      properties:
        path: { type: string }
        offset: { type: integer }
        limit: { type: integer }
      required: [path]
```

### Instruction Sections
```yaml
instructions:
  - section: planning
    content: |
      Before using any tool, explain what you plan to do and why.
      Break complex tasks into numbered steps.
  
  - section: verification
    content: |
      After every tool call, verify the result before proceeding.
      If a tool fails, try a different approach rather than repeating.
  
  - section: safety
    content: |
      Never execute destructive commands without explicit user approval.
      Always confirm before: file deletion, database writes, service restarts.
```

### Self-Recursion Loop
```yaml
recursion:
  max_iterations: 10
  stop_conditions:
    - task_complete: "User's goal has been achieved"
    - stuck: "Three consecutive tool calls make no progress"
    - user_interrupt: "User sent a new message"
    - error_limit: "Five consecutive tool errors"
```

**Implication for haksterAi**: The 10-iteration limit is a sensible default. haksterAi already has MAX_TURNS=80 (env-overridable) which is more generous. The stop_conditions map cleanly to haksterAi's existing loop-break mechanisms.

---

## 2. THINK Phase — Model Call with Context Management

The THINK phase handles the model API call with context window management.

### Context Window Strategy
```yaml
context_management:
  priority_order:
    - system_prompt          # Always include
    - tool_definitions       # Always include  
    - recent_conversation    # Last N turns
    - few_shot_examples       # Trim first if over budget
    - conversation_summary    # Generated for long sessions
    - memory_items           # Lowest priority, trim first
```

### Compaction Approach
Hermes compacts context by:
1. Summarizing older turns into a single `conversation_summary` message
2. Keeping the last N turns verbatim
3. Always preserving: system prompt, tool definitions, current objective
4. Removing few-shot examples first when over budget

**Implication for haksterAi**: haksterAi's `compactHistory()` already does sliding-window compaction. Adding a summarization step (Kiro-style conversation compression) would improve context retention for long sessions. Priority ordering guides what to trim first.

### Model Call Pattern
```javascript
// Simplified Hermes THINK phase
async function think(history, tools) {
  const systemPrompt = buildSystemPrompt();
  const compactedHistory = compactContext(history, {
    maxTokens: modelContextLimit,
    priorityOrder: ['system', 'tools', 'recent', 'summary', 'memory']
  });
  
  const response = await callModel({
    model: config.model,
    messages: [
      { role: 'system', content: systemPrompt },
      ...compactedHistory
    ],
    tools: tools,
    temperature: config.temperature || 0.7,
    max_tokens: config.maxTokens || 4096
  });
  
  return response;
}
```

**Implication for haksterAi**: The priority-ordered compaction is worth adopting. Currently haksterAi compacts by sliding window; adding priority-based trimming would preserve more relevant context.

---

## 3. ACT Phase — Tool Dispatch and Gerard Format

Hermes uses an XML-based tool call format internally called "Gerard" for structured tool dispatch. While haksterAi uses OpenAI-compatible function calls, the Gerard pattern provides useful structural ideas.

### Gerard Tool Call Format

The Gerard format wraps tool calls in XML tags for clear delineation between reasoning and execution:

```xml
<Gerard>
<tool_call_id>call_001</tool_call_id>
<tool_name>read_file</tool_name>
<arguments>{"path": "/home/ghost/haksterAi/server/src/index.js"}</arguments>
</Gerard>
```

### Tool Result Format

Tool results use a matching XML structure:

```xml
<tool_result>
<tool_call_id>call_001</tool_call_id>
<status>success</status>
<output>file contents here...</output>
</tool_result>
```

### Error Format

```xml
<tool_result>
<tool_call_id>call_001</tool_call_id>
<status>error</status>
<error_type>file_not_found</error_type>
<error_message>No such file or directory</error_message>
</tool_result>
```

### Tool Dispatch Pipeline

```javascript
// Hermes ACT phase — tool dispatch
async function act(toolCalls, executors) {
  const results = [];
  
  for (const call of toolCalls) {
    const { tool_call_id, tool_name, arguments } = parseToolCall(call);
    
    // 1. Validate tool exists
    const executor = executors[tool_name];
    if (!executor) {
      results.push({
        tool_call_id,
        status: 'error',
        error_type: 'unknown_tool',
        error_message: `Unknown tool: ${tool_name}`
      });
      continue;
    }
    
    // 2. Validate arguments against schema
    const validation = validateArgs(arguments, executor.inputSchema);
    if (!validation.valid) {
      results.push({
        tool_call_id,
        status: 'error',
        error_type: 'invalid_arguments',
        error_message: validation.error
      });
      continue;
    }
    
    // 3. Execute with timeout
    try {
      const result = await Promise.race([
        executor.execute(arguments),
        timeout(executor.timeout || 60000)
      ]);
      results.push({ tool_call_id, status: 'success', output: result });
    } catch (err) {
      results.push({
        tool_call_id,
        status: 'error',
        error_type: 'execution_error',
        error_message: err.message
      });
    }
  }
  
  return results;
}
```

**Implication for haksterAi**: The structured error types (unknown_tool, invalid_arguments, execution_error) are worth adopting in haksterAi's tool result format. Currently haksterAi returns string errors; typed errors would improve loop-control decisions.

---

## 4. OBSERVE Phase — Result Processing and Loop Control

The OBSERVE phase processes tool results and decides whether to continue, break, or adjust strategy.

### Loop State Machine

```
THINK ──→ ACT ──→ OBSERVE ───────────────────────→ THINK (continue)
                       │
                       ├── task_complete ──→ EXIT (success)
                       ├── stuck ──→ LOOP_BREAK → THINK (with nudge)
                       ├── error_limit ──→ EXIT (failure)
                       ├── user_interrupt ──→ EXIT (yield to user)
                       └── context_overflow ──→ COMPACT → THINK
```

### Progress Scoring

Hermes scores each tool result to determine whether real progress was made:

```javascript
function scoreProgress(toolCall, result) {
  // High progress: file written, test passed, build succeeded
  if (result.status === 'success' && result.output) {
    const output = String(result.output).trim();
    if (/pass|ok|success|written|updated|created/i.test(output)) return 2;
    if (output.length > 100) return 1; // Substantial new information
    return 0; // Minimal progress
  }
  
  // Negative: errors, timeouts, not found
  if (result.status === 'error') return -1;
  return 0;
}
```

### Loop Control Variables

```javascript
const loopConfig = {
  maxIterations: 10,         // Hard cap on self-recursion
  noProgressLimit: 3,        // Consecutive no-progress turns before break
  errorStreakLimit: 5,        // Consecutive errors before exit
  duplicateCallLimit: 3,      // Same tool+args repeated
  explorationLimit: 5,        // Read/search calls without action
  contextWarningThreshold: 0.8, // Warn when context is 80% full
  contextHardLimit: 0.95      // Force compaction at 95%
};
```

**Implication for haksterAi**: The progress scoring function is simpler than haksterAi's existing 8-mechanism system but provides a clean baseline. haksterAi should adopt the typed scoring (2/1/0/-1) and use it to feed into the existing stuck-loop detection. The context warning thresholds (80% warn, 95% force compact) are useful additions.

---

## 5. Few-Shot Examples (few_shot.json)

Hermes uses a structured few-shot file to guide the model's behavior patterns.

### Format
```json
{
  "examples": [
    {
      "name": "file_read_then_edit",
      "description": "Read a file before editing it",
      "input": "Fix the bug in server.js where the port is hardcoded",
      "turns": [
        {
          "role": "assistant",
          "content": "I'll read the file first to find the bug.",
          "tool_calls": [{"name": "read_file", "arguments": {"path": "server.js"}}]
        },
        {
          "role": "tool_result",
          "content": "// server.js content...",
          "tool_call_id": "call_1"
        },
        {
          "role": "assistant",
          "content": "I found the hardcoded port. I'll fix it.",
          "tool_calls": [{"name": "edit_file", "arguments": {"path": "server.js", "old_text": "port = 3000", "new_text": "port = process.env.PORT || 3000"}}]
        }
      ]
    }
  ]
}
```

### Injection Strategy

Few-shot examples are injected after the system prompt and before task-specific instructions, with priority-based trimming when context is over budget:

```javascript
function injectFewShots(systemPrompt, fewShots, contextBudget) {
  // Always include system prompt
  let messages = [{ role: 'system', content: systemPrompt }];
  
  // Add few-shot examples up to budget
  let remaining = contextBudget - estimateTokens(systemPrompt);
  
  for (const example of fewShots.examples) {
    const tokens = estimateTokens(JSON.stringify(example.turns));
    if (tokens < remaining) {
      for (const turn of example.turns) {
        messages.push(turn);
      }
      remaining -= tokens;
    }
  }
  
  return messages;
}
```

**Implication for haksterAi**: haksterAi doesn't currently use few-shot examples in its prompt. Adding them would improve model behavior on common patterns (read-before-edit, verify-after-write, plan-before-act). They should be injected into `buildSystemPrompt()` with the lowest compaction priority.

---

## 6. Code Interpreter Escape Hatch

Hermes includes a Python code interpreter as an escape hatch when tools can't solve a problem.

### How It Works

```yaml
code_interpreter:
  enabled: true
  timeout: 30
  sandbox: true
  allowed_modules:
    - math
    - json
    - re
    - datetime
    - collections
    - itertools
  blocked_modules:
    - os
    - subprocess
    - socket
    - requests
  max_output_chars: 10000
```

### When It's Triggered

The code interpreter is invoked as a tool when:
1. No existing tool can accomplish the task (e.g., complex calculations)
2. Data transformation is needed between tool calls
3. Pattern matching or extraction requires programmatic logic

**Implication for haksterAi**: haksterAi already has `exec_shell` which can run `node -e` or `python3 -c`. Rather than adding a separate code interpreter tool, haksterAi should ensure its shell tool can handle computational tasks and consider adding a sandboxed evaluation mode for trusted sessions.

---

## 7. Provider Adapter Layer

Hermes/Nous use a provider-agnostic adapter pattern that maps a single internal tool format to different API wire formats.

### Adapter Architecture

```javascript
// Provider adapter pattern
const adapters = {
  openai: {
    formatToolCall(call) {
      return {
        type: 'function',
        function: {
          name: call.tool_name,
          arguments: JSON.stringify(call.arguments)
        },
        id: call.tool_call_id
      };
    },
    formatResult(result) {
      return {
        role: 'tool',
        tool_call_id: result.tool_call_id,
        content: JSON.stringify(result.output)
      };
    }
  },
  
  anthropic: {
    formatToolCall(call) {
      return {
        type: 'tool_use',
        id: call.tool_call_id,
        name: call.tool_name,
        input: call.arguments
      };
    },
    formatResult(result) {
      return {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: result.tool_call_id,
          content: JSON.stringify(result.output)
        }]
      };
    }
  },
  
  gerard: {
    formatToolCall(call) {
      return `<Gerard>\n<tool_call_id>${call.tool_call_id}</tool_call_id>\n<tool_name>${call.tool_name}</tool_name>\n<arguments>${JSON.stringify(call.arguments)}</arguments>\n</Gerard>`;
    },
    formatResult(result) {
      return `<tool_result>\n<tool_call_id>${result.tool_call_id}</tool_call_id>\n<status>${result.status}</status>\n<output>${JSON.stringify(result.output)}</output>\n</tool_result>`;
    }
  }
};
```

### SSE Streaming

For streaming responses, Hermes uses Server-Sent Events with a structured event taxonomy:

```javascript
// SSE event types
const eventTypes = {
  delta: 'text',              // Assistant text chunk
  thinking_start: 'thinking',  // Reasoning phase begins
  thinking: 'thinking',        // Reasoning content
  thinking_end: 'thinking',    // Reasoning phase ends
  tool_call_start: 'tool',     // Tool execution begins
  tool_call_result: 'tool',    // Tool result available
  shell_start: 'shell',        // Shell command begins
  shell_data: 'shell',         // Shell output chunk
  shell_end: 'shell',          // Shell command completes
  needs_confirmation: 'auth',  // Approval required
  loop_detected: 'control',   // Loop break triggered
  turn_end: 'control',         // Turn boundary
  done: 'control'              // Stream complete
};
```

**Implication for haksterAi**: This adapter pattern maps directly to haksterAi's existing `callOllama` / `providers.js` architecture. The SSE event taxonomy aligns with haksterAi's existing events. The key improvement is formalizing the canonical internal format and ensuring all adapters convert to/from it consistently.

---

## 8. Memory and Learning

Hermes implements a lightweight memory system for cross-session persistence.

### Memory Structure
```yaml
memory:
  storage: .hakster/memory/
  structure:
    - MEMORY.md           # Curated lessons and patterns
    - memory_summary.md   # Auto-generated summary
    - raw_memories/       # Individual session observations
      - {timestamp}.md    # Per-session raw captures
```

### Memory Operations

```javascript
// Memory lifecycle
const memory = {
  // Capture observations during task execution
  addRaw(sessionId, observation, metadata) {
    const entry = {
      timestamp: Date.now(),
      session: sessionId,
      type: metadata.type || 'observation', // observation | pattern | lesson | error
      content: observation,
      tags: metadata.tags || [],
      confidence: metadata.confidence || 0.5
    };
    // Append to raw_memories/{sessionId}.md
    appendRawMemory(entry);
  },
  
  // Consolidate raw memories into structured lessons
  async consolidate() {
    const rawMemoryFiles = glob('.hakster/memory/raw_memories/*.md');
    const allObservations = rawMemoryFiles.flatMap(parseRawMemory);
    
    // Pattern extraction
    const patterns = extractPatterns(allObservations);
    
    // Update MEMORY.md with high-confidence lessons
    const lessons = patterns
      .filter(p => p.confidence >= 0.7)
      .map(formatLesson);
    
    updateMemoryMd(lessons);
    
    // Generate summary
    const summary = generateSummary(patterns);
    writeMemorySummary(summary);
  },
  
  // Load relevant lessons for context injection
  loadRelevant(currentTask) {
    const lessons = readMemoryMd();
    return lessons.filter(l => isRelevant(l, currentTask));
  }
};
```

### Trigger Conditions

Memory consolidation is triggered:
1. At session end (graceful shutdown)
2. When raw memory exceeds a threshold (e.g., 50 entries)
3. On explicit user command ("remember this")
4. Periodically during long sessions (every 20 turns)

**Implication for haksterAi**: This maps directly to the planned `autolearn.js` module. The key patterns to adopt are:
- Raw observation capture during task execution
- Pattern extraction and confidence scoring
- Consolidation into structured lessons (MEMORY.md)
- Relevance-based injection into system prompt
- Multiple trigger conditions for consolidation

---

## 9. Error Recovery Patterns

Hermes implements structured error recovery with typed error handling.

### Error Classification

```yaml
error_types:
  tool_not_found:
    severity: low
    recovery: "Report unknown tool, suggest available alternatives"
    
  invalid_arguments:
    severity: medium  
    recovery: "Retry with corrected arguments or ask user for clarification"
    
  execution_timeout:
    severity: medium
    recovery: "Retry once with longer timeout, then try alternative approach"
    
  context_limit_exceeded:
    severity: high
    recovery: "Compact history, summarize older turns, retry"
    
  model_api_error:
    severity: high
    recovery: "Retry with exponential backoff (2s, 4s, 8s), then switch provider"
    
  rate_limit_exceeded:
    severity: medium
    recovery: "Wait and retry, or switch to backup provider"
```

### Retry Strategy

```javascript
async function callWithRetry(fn, options = {}) {
  const { maxRetries = 3, backoffMs = 2000, provider = null } = options;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      // Classify error
      const errorType = classifyError(err);
      
      if (errorType === 'rate_limit') {
        const waitMs = backoffMs * Math.pow(2, attempt);
        await sleep(waitMs);
        continue;
      }
      
      if (errorType === 'context_limit') {
        // Compact and retry
        compactHistory();
        return await fn(); // One retry after compaction
      }
      
      if (errorType === 'non_retryable') {
        throw err; // Don't retry tool-not-found, invalid-args
      }
      
      if (attempt < maxRetries) {
        await sleep(backoffMs);
        continue;
      }
      
      throw err;
    }
  }
}
```

**Implication for haksterAi**: haksterAi already has a 2x retry on `callOllama` errors. The typed error classification and provider failover pattern should be adopted. The provider-switching capability is especially useful since haksterAi supports multiple providers (Ollama, Nous, Codex, Claude).

---

## 10. Loop State Machine Summary

The complete Hermes agent loop state machine:

```
┌─────────┐     ┌───────┐     ┌───────┐     ┌─────────┐
│  THINK  │────→│  ACT  │────→│OBSERVE│────→│ REFLECT │
└────┬────┘     └───┬───┘     └───┬───┘     └────┬────┘
     │              │             │              │
     │              │         ┌───┴───┐          │
     │              │         │ LOOP  │          │
     │              │         │BREAK  │          │
     │              │         └───┬───┘          │
     │              │             │              │
     │              │             ↓              │
     │              │     ┌───────────┐         │
     │              │     │  COMPACT  │         │
     │              │     │  + NUDGE   │         │
     │              │     └─────┬─────┘         │
     │              │           │               │
     ↓              ↓           ↓               ↓
┌─────────────────────────────────────────────────────┐
│                  CONSOLIDATE                         │
│  (memory, lessons, patterns)                         │
└──────────────────────┬──────────────────────────────┘
                       │
                       ↓
                  ┌─────────┐
                  │  EXIT   │
                  └─────────┘
```

### State Transitions

| From State | Condition | To State | Action |
|---|---|---|---|
| THINK | Model returns tool_calls | ACT | Parse and validate tool calls |
| THINK | Model returns text only | REFLECT | Check for loops, consider done |
| THINK | Model returns empty | THINK | Nudge and retry (2x max) |
| THINK | Context overflow | COMPACT | Compact history, retry |
| ACT | Tool succeeded | OBSERVE | Process result, score progress |
| ACT | Tool failed | OBSERVE | Classify error, decide retry |
| OBSERVE | Progress scored >= 1 | THINK | Continue loop |
| OBSERVE | No progress (3x) | LOOP_BREAK | Trim history, inject nudge |
| REFLECT | Task complete | CONSOLIDATE | Extract lessons, update memory |
| REFLECT | More work needed | THINK | Continue with adjustments |
| CONSOLIDATE | Done | EXIT | Return final results |

**Implication for haksterAi**: This formalizes the loop phases that haksterAi already implements implicitly. The addition of REFLECT and CONSOLIDATE phases are the key improvements — these provide structured hook points for auto-learning, loop quality assessment, and memory update.

---

## 11. Key Patterns Worth Adopting

### From Hermes/Nous into haksterAi

| Pattern | Current haksterAi | Hermes/Nous | Adoption |
|---|---|---|---|
| Phase names | Implicit in code | Explicit (THINK/ACT/OBSERVE) | Add phase enum to loop.js |
| Structured errors | String errors | Typed error classification | Add error types to tool results |
| Progress scoring | 8 mechanisms, complex | Simple 2/1/0/-1 scoring | Add as baseline, keep existing on top |
| Few-shot injection | None | Priority-based budget | Add to buildSystemPrompt() |
| Memory pipeline | None | Raw → Patterns → Lessons | Implement in autolearn.js |
| Provider adapter | Per-provider code in providers.js | Canonical internal format + adapters | Standardize in loop.js |
| Context priority | Sliding window | Priority-ordered trimming | Enhance compactHistory() |
| Consolidation trigger | None | Session end, threshold, explicit, periodic | Add to autolearn.js |
| Error recovery | 2x retry on callOllama | Typed errors + backoff + failover | Enhance in loop.js |

### Not Worth Adopting

| Pattern | Why Skip |
|---|---|
| Gerard XML format | haksterAi uses OpenAI-compatible function calls natively |
| Python code interpreter | haksterAi has exec_shell which covers this |
| 10-iteration hard limit | haksterAi's MAX_TURNS=80 is more flexible |
| Few-shot in separate JSON | Inline examples are simpler for haksterAi's architecture |

---

## 12. Adapter Integration Points

### Where Hermes Patterns Connect to haksterAi Code

```javascript
// In server/src/agent/index.js — agentLoop()

// CURRENT (lines 5027-5833):
//   The loop is one large function with implicit phases

// ENHANCED with loop.js:
const { AgentLoopPhase, shouldConsolidate, shouldReflect } = require('./loop');

// Phase tracking in agentLoop
let currentPhase = AgentLoopPhase.THINK;

// After model call (line ~5350):
currentPhase = AgentLoopPhase.ACT;
// After tool execution (line ~5770):
currentPhase = AgentLoopPhase.OBSERVE;
// After progress scoring:
currentPhase = shouldReflect(history, turn) ? AgentLoopPhase.REFLECT : AgentLoopPhase.THINK;

// After loop exit:
if (shouldConsolidate(history, turn)) {
  currentPhase = AgentLoopPhase.CONSOLIDATE;
  const { consolidateMemories } = require('./autolearn');
  await consolidateMemories(history);
}
```

### Where to Inject AGENTS.md

```javascript
// In buildSystemPrompt() — before line 631
// Add AGENTS.md content as highest-priority context
async function buildSystemPrompt(context) {
  let prompt = baseSystemPrompt;
  
  // NEW: Inject AGENTS.md
  const agentsMd = await loadAgentsMd();
  if (agentsMd) {
    prompt += '\n\n## Project Context (AGENTS.md)\n' + agentsMd;
  }
  
  // NEW: Inject learned lessons
  const { loadLearnedLessons } = require('./autolearn');
  const lessons = loadLearnedLessons(context.cwd);
  if (lessons) {
    prompt += '\n\n## Learned Lessons\n' + lessons;
  }
  
  // ... existing prompt building ...
  return prompt;
}
```

---

## 13. Security and Safety Patterns

### Tool Permission Levels

Hermes implements a layered permission system:

```yaml
permissions:
  read_only:
    - read_file
    - list_dir
    - search_files
    - web_search
    
  moderate_risk:
    - edit_file
    - write_file
    
  high_risk:
    - exec_shell
    - spawn_agent
    
  confirmation_required:
    - Any exec_shell command matching: rm, mkfs, dd, format
    - Any file write outside CWD
    - Any network operation to internal IPs
```

### Dangerous Command Detection

```javascript
const DANGEROUS_PATTERNS = [
  /\brm\s+-rf\b/,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  /\bformat\b/i,
  /\bgit\s+(push|reset\s+--hard)/,
  /\bdd\s+of=\/dev\//,
  /\b(wget|curl)\s+.*\|\s*(sh|bash|zsh)/,
  /\b>(\/dev\/sda|\/dev\/null)\b/
];

function isDangerousCommand(cmd) {
  return DANGEROUS_PATTERNS.some(pattern => pattern.test(cmd));
}
```

**Implication for haksterAi**: haksterAi already has `isDangerousCommand()` and `shouldConfirm()` with three levels (SUGGEST, AUTO_EDIT, FULL_AUTO). The pattern matching approach is similar. Worth adding: network-internal-IP blocking and pipe-to-shell detection.

---

## 14. Performance Patterns

### Parallel Tool Execution

Hermes parallelizes independent tool calls:

```javascript
async function executeToolCalls(calls, executors) {
  // Group by dependency
  const independent = calls.filter(c => !dependsOnPreviousResult(c));
  const dependent = calls.filter(c => dependsOnPreviousResult(c));
  
  // Execute independent calls in parallel
  const independentResults = await Promise.all(
    independent.map(call => executeTool(call, executors))
  );
  
  // Execute dependent calls sequentially
  const dependentResults = [];
  for (const call of dependent) {
    const result = await executeTool(call, executors);
    dependentResults.push(result);
  }
  
  return [...independentResults, ...dependentResults];
}
```

### Context Caching

```javascript
// Cache system prompt across turns — it rarely changes
let systemPromptCache = { hash: null, content: null };

function getCachedSystemPrompt(prompt) {
  const hash = hashString(prompt);
  if (systemPromptCache.hash === hash) {
    return systemPromptCache.content;
  }
  systemPromptCache = { hash, content: prompt };
  return prompt;
}
```

### Token Budget Management

```javascript
function manageTokenBudget(history, config) {
  const totalTokens = estimateTokens(history);
  const maxTokens = config.maxContextTokens;
  
  if (totalTokens > maxTokens * 0.95) {
    // Hard limit: force compaction
    return compactHistory(history, { keepLast: 5 });
  }
  
  if (totalTokens > maxTokens * 0.80) {
    // Soft limit: summarize older turns
    return summarizeOlderTurns(history, { keepLast: 10 });
  }
  
  return history; // Within budget
}
```

**Implication for haksterAi**: haksterAi already has token estimation and context compaction. The 80%/95% thresholds for soft/hard compaction are useful additions. The system prompt caching is relevant since `buildSystemPrompt()` is called every turn.

---

## 15. Summary — What haksterAi Should Take from Hermes/Nous

### Adopt Directly

1. **Explicit phase enum** (THINK, ACT, OBSERVE, REFLECT, CONSOLIDATE) — makes the loop state machine clear and debuggable
2. **Typed error classification** (unknown_tool, invalid_arguments, execution_error, timeout, context_limit) — improves loop-control decisions
3. **Simple progress scoring** (2/1/0/-1) as a baseline alongside existing complex mechanisms
4. **Context priority ordering** (system → tools → recent → summary → memory → few-shot) for compaction
5. **Memory pipeline** (raw_memories → patterns → lessons → MEMORY.md) implemented in autolearn.js
6. **Consolidation triggers** (session end, threshold, explicit command, periodic)
7. **Provider adapter canonical format** — normalize tool calls/results through a single internal shape
8. **Token budget thresholds** (80% warn, 95% force compact)

### Adapt for haksterAi

1. **Gerard XML format** — Don't adopt XML; but adopt the structured error envelope with typed statuses
2. **Few-shot examples** — Inject into buildSystemPrompt() as lowest-priority context, not separate JSON
3. **10-iteration limit** — Keep MAX_TURNS=80 but add per-tool-type iteration limits
4. **Code interpreter** — Don't add separate tool; ensure exec_shell covers computational needs
5. **Parallel tool execution** — Only when model returns multiple independent tool calls; keep sequential for dependent calls

### Skip

1. **Gerard XML wire format** — haksterAi uses OpenAI-compatible function calls
2. **Python-only code interpreter** — exec_shell is more flexible
3. **Hard 10-iteration limit** — Too restrictive for complex tasks
4. **Separate few-shot JSON file** — Inline examples in system prompt are simpler

### Key Integration Equation

```
haksterAi unified loop = 
  existing agentLoop (battle-tested 8-break mechanism) +
  explicit phase enum from Hermes (THINK/ACT/OBSERVE/REFLECT/CONSOLIDATE) +
  typed error classification from Hermes +
  simple progress scoring baseline from Hermes +
  memory pipeline from Hermes (raw → patterns → lessons → MEMORY.md) +
  AGENTS.md + few-shot injection from Claude Code +
  steering files + trust escalation from Kiro +
  MEMORY.md + skill extraction from Codex
```