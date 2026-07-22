# 🔒 TOP SECRET — haksterAI Loop Tools Cheat Sheet

> **Classification:** TOP SECRET / FOR OPERATOR EYES ONLY
> **Last Updated:** 2026-07-20
> **Source:** `server/src/agent/loop.js` (1058 lines)
> **Purpose:** Complete line-level map of every loop tool, guard, and hook in the haksterAI agent loop.
> **Rule:** Always add, never delete. Understand in and out. Score 100% every time.

---

## 📊 Score Card

| Metric | Target | Current |
|--------|--------|---------|
| Total Loop Tools | 24+ | 24 ✅ |
| Loop Break Mechanisms | 24 | 24 ✅ |
| Syntax Valid | YES | YES ✅ |
| All Exported | YES | YES ✅ |
| Documented | YES | YES ✅ |
| Line Map | YES | YES ✅ |
| Score | 100% | ████████████████████ 100% ▲ Sharp 💪 |

---

## 🗺️ MASTER LINE MAP — `server/src/agent/loop.js`

### Core Infrastructure (Original)

| Line | Function / Constant | Purpose |
|------|---------------------|---------|
| L47 | `LOOP_GUARD` object | All guard constants in one place |
| L47 | `CONSOLIDATION_THROTTLE` | Min turns between consolidations |
| L47 | `CONSOLIDATION_THRESHOLD` | Raw memory count to trigger consolidation |
| L47 | `CONSOLIDATION_INTERVAL` | Turn interval for periodic consolidation |
| L47 | `NO_PROGRESS_REFLECT` | No-progress turns before reflection |
| L47 | `SAME_TOOL_ERROR_REFLECT` | Same-tool errors before reflection |
| L47 | `MEMORY_INJECTION_BUDGET` | Max tokens for memory injection |
| L47 | `SELF_RECURSION_LIMIT` | Max THINK→PLAN without ACT |
| L47 | `KIRO_REPEAT_BLOCK: 2` | Kiro: max repeated tool calls before blocking |
| L47 | `KIRO_CALL_WINDOW: 20` | Kiro: rolling window for call signatures |
| L47 | `KIRO_DIAGNOSIS_THRESHOLD: 5` | Kiro: read-only streak before timeout |
| L79 | `shouldConsolidate(state)` | Decides if raw memories need consolidation |
| L123 | `shouldReflect(state)` | Decides if agent should pause and reflect |
| L153 | `injectAgentsMd(cwd)` | Loads and injects AGENTS.md steering content |
| L218 | `injectLearnedLessons(cwd, contextTags)` | Injects learned lessons by tag relevance |
| L373 | `validatePhaseTransition(from, to, state)` | Validates 6-phase state machine transitions |
| L390 | `phaseName(phase)` | Returns human-readable phase name |
| L465 | `countTagOverlap(entryTags, contextTags)` | Counts matching tags for memory relevance |
| L473 | `safeStat(filePath)` | Safe fs.statSync that never throws |
| L477 | `safeRead(filePath)` | Safe fs.readFileSync that never throws |
| L483 | `module.exports` | All functions exported here |

### Kiro-Inspired Loop Tools (L522-L735)

| Line | Function | Kiro Pattern | Input | Output | Purpose |
|------|----------|-------------|-------|--------|---------|
| L552 | `kiroPreToolGuard(ctx)` | PreToolUse hook | `{toolName, args, recentCalls}` | `{block, reason?}` | Blocks repeated calls (2+ same sig) + dangerous patterns (rm -rf, mkfs, dd, force push) |
| L583 | `kiroPostToolScore(ctx)` | PostToolUse hook | `{toolName, success, resultSize, hadError, duration}` | `{score: 0-10, quality, shouldReflect}` | Scores tool result quality, triggers reflection on ≤2 |
| L611 | `kiroPromptFilter(prompt)` | UserPromptSubmit hook | `string` prompt | `{reject, reason?}` | Rejects destructive prompts (DROP, TRUNCATE, WIPE, FORMAT) |
| L637 | `kiroPreTaskGate(task)` | PreTaskExec hook | `{description, target, approved, trustLevel}` | `{block, reason?}` | Blocks tasks missing description/target/approval |
| L660 | `kiroRoundBudget(ctx)` | Round budget system | `{round, maxRounds}` | `{exhausted, phase, nudge?}` | Finite budget with nudges at 67%/80%/100% |
| L684 | `kiroTrackCallSignature(existing, sig, maxWindow)` | tool-loop.json state | `string[], string, number` | `string[]` | Rolling window of call signatures for loop detection |
| L703 | `kiroDiagnosisTimeout(ctx)` | Idle detection | `{readOnlyStreak}` | `{triggered, level, message?}` | Escalates: ⚠️(5)→🚨(6)→🚨🚨(7+) |
| L723 | `kiroExitCodeHandler(code, stderr)` | Exit code 2 pattern | `number, string` | `{block, feedback?}` | Exit 2 = block + return STDERR to agent |

### Claude Code-Inspired Loop Tools (L745-L905)

| Line | Function | Claude Code Hook | Input | Output | Purpose |
|------|----------|-----------------|-------|--------|---------|
| L745 | `claudePreCompactGuard(ctx)` | PreCompactHookInput | `{tokenCount, maxTokens, activeTasks, pendingApprovals}` | `{compact, preserve[], reason?}` | Decides if context compaction is safe, preserves critical keys |
| L771 | `claudePostCompactVerify(ctx)` | PostCompactHookInput | `{preservedKeys[], actualKeys[]}` | `{verified, missing[]}` | Verifies critical context survived compaction |
| L785 | `claudeStopEvaluator(ctx)` | StopHookInput | `{taskComplete, hasErrors, unverifiedChanges, openTodos}` | `{shouldStop, reason?}` | Blocks premature stop if errors/unverified/todos remain |
| L809 | `claudeSubagentTracker(ctx)` | SubagentStart/StopHookInput | `{active, max, action}` | `{allow, reason?}` | Prevents runaway sub-agent spawning (default max 5) |
| L827 | `claudeTaskLogger(ctx)` | TaskCreated/CompletedHookInput | `{action, taskId, taskDesc, duration}` | `{logged, event, detail}` | Tracks task lifecycle for metrics |
| L841 | `claudeSessionManager(ctx)` | SessionStart/EndHookInput | `{action, sessionId, workDir}` | `{initialized, cleanup[], detail}` | Initializes or cleans up session state |
| L865 | `claudePermissionHandler(ctx)` | PermissionRequestHookInput | `{tool, args, trustLevel, isDestructive}` | `{approved, reason?}` | Trust-based auto-approve: <10 suggest, 10+ auto, 30+ destructive |
| L886 | `claudeCwdChangeDetector(ctx)` | CwdChangedHookInput | `{oldCwd, newCwd}` | `{changed, actions[], detail}` | Invalidates caches + re-injects steering on CWD change |

### Codex-Inspired Loop Tools (L911-L980)

| Line | Function | Codex Pattern | Input | Output | Purpose |
|------|----------|---------------|-------|--------|---------|
| L911 | `codexSandboxPolicy(ctx)` | SandboxPolicy | `{level: 'readonly'|'limited'|'full', path, operation}` | `{allowed, reason?}` | Restricts writes/execution based on sandbox level |
| L940 | `codexApprovalGate(ctx)` | AskForApproval | `{policy: 'never'|'onRequest'|'always', action, isDestructive}` | `{needsApproval, reason?}` | Decides if action needs explicit user approval |
| L962 | `codexContextManager(ctx)` | context_manager | `{tokensUsed, maxTokens, strategy}` | `{action, threshold, reason?}` | Tracks context window usage, triggers compaction at 85%/95% |

### ReAct/Hermes-Inspired Loop Tools (L987-L1058)

| Line | Function | Pattern Source | Input | Output | Purpose |
|------|----------|---------------|-------|--------|---------|
| L987 | `reactCycleValidator(ctx)` | ReAct (Reason+Act) | `{phase, hasContent, isEmpty, consecutiveThoughts}` | `{valid, reason?}` | Validates thought-action-observation cycle is progressing |
| L1006 | `hermesMemoryConsolidation(ctx)` | Hermes/Nous memory | `{rawCount, threshold, oldestAge, lastConsolidation}` | `{shouldConsolidate, reason?}` | Triggers memory consolidation by volume or age |
| L1025 | `hermesReflectionTrigger(ctx)` | Hermes/Nous reflection | `{turnsSinceReflection, errorStreak, progressScore, lastReflection}` | `{shouldReflect, reason?}` | Triggers reflection on stalls, errors, or low progress |
| L1049 | `hermesSkillExtractor(ctx)` | Hermes/Nous skill extraction | `{pattern, occurrences, lastExtraction, category}` | `{shouldExtract, reason?}` | Extracts reusable skill when pattern appears 3+ times |

---

## 🔧 LOOP_GUARD Constants Quick Reference

```
LOOP_GUARD = {
  CONSOLIDATION_THROTTLE,      // min turns between consolidations
  CONSOLIDATION_THRESHOLD,     // raw memory count to trigger
  CONSOLIDATION_INTERVAL,      // periodic turn interval
  NO_PROGRESS_REFLECT,         // no-progress turns before reflection
  SAME_TOOL_ERROR_REFLECT,     // same-tool errors before reflection
  MEMORY_INJECTION_BUDGET,     // max tokens for memory injection
  SELF_RECURSION_LIMIT: 10,    // max THINK→PLAN without ACT
  KIRO_REPEAT_BLOCK: 2,        // Kiro: max repeated calls before block
  KIRO_CALL_WINDOW: 20,        // Kiro: rolling window size
  KIRO_DIAGNOSIS_THRESHOLD: 5, // Kiro: read-only streak before timeout
}
```

---

## 📋 24 Loop Break Mechanisms (Complete List)

| # | Mechanism | Source | Line |
|---|-----------|--------|------|
| 1 | Stuck-loop detection (repeated prefixes) | index.js | — |
| 2 | Grep/search loop tracking | index.js | — |
| 3 | Filesystem wandering detection | index.js | — |
| 4 | Dangerous command gate | index.js | — |
| 5 | Idle review (20s stall guard) | index.js | — |
| 6 | Tool-error streak limit | index.js | — |
| 7 | Exploration-only detection | index.js | — |
| 8 | Context-compaction stall guard | index.js | — |
| 9 | Phase transition validation | loop.js | L373 |
| 10 | Self-recursion limit | loop.js | L373 (SELF_RECURSION_LIMIT) |
| 11 | Consolidation throttle | loop.js | L79 (shouldConsolidate) |
| 12 | Memory budget cap | loop.js | L218 (MEMORY_INJECTION_BUDGET) |
| 13 | Skill extraction throttle | autolearn.js | — |
| 14 | Steering reload guard | loop.js | L153 (injectAgentsMd) |
| 15 | Guardrails exact-repeat detection | guardrails.sh | — |
| 16 | Diagnosis-timeout escalation | index.js | — |
| 17 | Kiro pre-tool guard | loop.js | L552 |
| 18 | Kiro post-tool progress scorer | loop.js | L583 |
| 19 | Kiro prompt filter | loop.js | L611 |
| 20 | Kiro pre-task gate | loop.js | L637 |
| 21 | Kiro round budget enforcer | loop.js | L660 |
| 22 | Kiro call signature tracker | loop.js | L684 |
| 23 | Kiro diagnosis timeout detector | loop.js | L703 |
| 24 | Kiro exit code handler | loop.js | L723 |

---

## 🎯 How to Score 100% Every Time

1. **Before editing loop.js** — read this cheat sheet, know the line numbers
2. **Always add, never delete** — new tools go at the bottom, before `module.exports`
3. **Add to exports** — every new function MUST be in `module.exports` at L483
4. **Verify syntax** — `node -c server/src/agent/loop.js` after EVERY change
5. **Update this doc** — add new tools to the line map immediately
6. **Update AGENTS.md** — increment loop break mechanism count
7. **Save memory** — `memory add` with line numbers for next session
8. **Pattern: understand in and out** — read the source pattern, understand the hook type, then implement

---

## 🔄 Integration Points (where each tool fires in the agent loop)

| Phase | Tools Called |
|-------|-------------|
| **THINK** | `kiroPromptFilter()`, `kiroRoundBudget()`, `claudeCwdChangeDetector()` |
| **PLAN** | `kiroPreTaskGate()`, `codexApprovalGate()`, `codexSandboxPolicy()` |
| **ACT** | `kiroPreToolGuard()` → tool call → `kiroPostToolScore()`, `claudePermissionHandler()`, `kiroExitCodeHandler()` |
| **OBSERVE** | `kiroDiagnosisTimeout()`, `reactCycleValidator()`, `kiroTrackCallSignature()` |
| **REFLECT** | `hermesReflectionTrigger()`, `hermesMemoryConsolidation()`, `hermesSkillExtractor()` |
| **CONSOLIDATE** | `claudePreCompactGuard()`, `claudePostCompactVerify()`, `codexContextManager()` |
| **STOP** | `claudeStopEvaluator()`, `claudeSessionManager()`, `claudeTaskLogger()` |
| **SUB-AGENT** | `claudeSubagentTracker()` |

---

## 📚 Source Pattern Reference

| Source | Location on Machine | What We Extracted |
|--------|---------------------|-------------------|
| Kiro CLI | kiro.dev (cookie wall) | PreToolUse, PostToolUse, UserPromptSubmit, PreTaskExec, exit code 2, round budget |
| Claude Code | `/home/ghost/claude-code/src/utils/hooks.ts` | PreCompact, PostCompact, Stop, SubagentStart/Stop, TaskCreated/Completed, SessionStart/End, PermissionRequest, CwdChanged |
| Codex CLI | `/home/ghost/codex/codex-rs/core/src/` | SandboxPolicy, AskForApproval, context_manager |
| ReAct | Academic paper pattern | Thought-Action-Observation cycle validation |
| Hermes/Nous | `/home/ghost/haksterAi/docs/nous-research/` | Memory consolidation, reflection triggers, skill extraction |

---

## ⚠️ Iron Rules

1. **NEVER delete a loop tool** — always add, never delete
2. **NEVER change a line number without updating this doc**
3. **ALWAYS run `node -c loop.js` after edits**
4. **ALWAYS update `module.exports` when adding functions**
5. **ALWAYS update AGENTS.md loop break count**
6. **ALWAYS save memory with line numbers**
7. **NEVER break syntax** — one bad edit kills the entire agent loop

---

_End of TOP SECRET document. Handle with care._