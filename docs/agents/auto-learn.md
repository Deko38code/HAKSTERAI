# Auto-Learn Design Document

## Overview

The auto-learn module (`server/src/agent/autolearn.js`) provides haksterAi with persistent, self-improving memory across sessions. It captures observations from each turn, consolidates them into structured lessons, and injects relevant learned patterns back into the system prompt so the agent improves over time without manual configuration.

This document covers the full design: memory formats, pipeline stages, triggering conditions, injection points, and integration with the existing `agentLoop` in `index.js`.

---

## 1. Two Modes of Operation

### INIT Mode
Runs once when a session starts or when `autoInit()` is called.

- Creates `.hakster/` directory structure if missing.
- Loads `MEMORY.md` and `memory_summary.md` from disk.
- Walks up from `cwd` to find `AGENTS.md` for project-level steering.
- Returns a consolidated prompt fragment to inject into `buildSystemPrompt()`.

### INCREMENTAL Mode
Runs every N turns during a session (controlled by `shouldConsolidate()` in `loop.js`).

- Adds a raw memory entry for the current turn.
- Checks consolidation threshold.
- If threshold met, runs the consolidation pipeline.
- Updates `memory_summary.md` for next prompt injection.

---

## 2. Directory Structure

```
.hakster/
├── memories/
│   └── raw_memories.json     # Timestamped observations from each turn
├── MEMORY.md                  # Consolidated lessons, preferences, patterns
├── memory_summary.md          # Condensed version for system prompt injection
└── skills/                    # Extracted reusable patterns
    └── *.md                   # SKILL.md templates
```

All paths are relative to the project root (`cwd`).

---

## 3. Raw Memory Format

Raw memories are stored in `.hakster/memories/raw_memories.json` as a JSON array.

### Entry Schema

```json
{
  "id": "mem_1708392000_001",
  "timestamp": "2025-07-16T12:00:00Z",
  "turn": 14,
  "phase": "OBSERVE",
  "tags": ["error-handling", "server", "socket"],
  "observation": "Server crashes on ECONNREFUSED when Ollama is not running. The error handler in index.js line 2340 catches this but logs raw stack. A safer pattern is to check provider availability before the call.",
  "context": {
    "file": "server/src/index.js",
    "line": 2340,
    "toolName": "exec_shell",
    "toolResult": "ECONNREFUSED"
  },
  "type": "pattern" | "error" | "preference" | "skill_candidate",
  "confidence": 0.7
}
```

### Field Descriptions

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Unique ID: `mem_{unixTimestamp}_{sequence}` |
| `timestamp` | string | yes | ISO 8601 timestamp |
| `turn` | number | yes | Turn number in current session |
| `phase` | string | yes | Agent loop phase when observed |
| `tags` | string[] | yes | Categorization tags for grouping |
| `observation` | string | yes | What was learned (concise, actionable) |
| `context` | object | no | File, line, tool, or result that generated this |
| `type` | enum | yes | `pattern`, `error`, `preference`, `skill_candidate` |
| `confidence` | number | yes | 0-1, how certain the observation is |

### When Raw Memories Are Added

`addRawMemory()` is called in the OBSERVE phase after each tool execution that produces meaningful output:

1. **After successful edits** — pattern: "Project uses X convention for Y"
2. **After errors** — error: "Tool X fails when Y condition"
3. **After user corrections** — preference: "User prefers X approach over Y"
4. **After repeated patterns** — skill_candidate: "This is the 3rd time we've done X pattern"

### Deduplication

Before adding a raw memory, check if a similar observation already exists in the current batch (matching on `tags` overlap and `observation` substring similarity > 0.6). If so, increment the existing entry's confidence and skip creating a duplicate.

---

## 4. MEMORY.md Format

The consolidated memory file at `.hakster/MEMORY.md` uses structured markdown:

```markdown
# haksterAi Memory

_Last consolidated: 2025-07-16T12:30:00Z
_Raw memories processed: 23
_Skills extracted: 2

## Project: haksterAi

### Patterns
- **[server]** The Express server listens on port from `process.env.PORT || 3579`. Always use `process.env.PORT` in code references.
- **[agent-loop]** The main agent loop is at `agentLoop()` in `server/src/agent/index.js` lines 5027-5833. It has 8 loop-break mechanisms. When modifying, preserve all of them.
- **[frontend]** Astro pages use `.astro` extension. Component imports use `@/` alias mapped in `tsconfig.json`.

### Errors Encountered
- **[ollama]** When Ollama is not running, `callOllama()` throws `ECONNREFUSED`. The error handler at line 2340 catches this but logs raw stack. Check provider availability before calling.
- **[build]** `npm run build` must be run from project root. Running from `server/` fails because `astro.config.mjs` is at root.

### User Preferences
- **[style]** User prefers minimal code — no unnecessary comments, keep functions small.
- **[workflow]** User often switches between CLI and web. Preserve state across both when possible.

### Conventions
- **[naming]** File names use kebab-case: `agent-loop.md`, not `agentLoop.md`.
- **[commits]** Commit messages should be concise, under 72 characters first line.

## Project: Other Projects (if detected)

(Sections repeat per project root)

## Cross-Project Patterns
- All projects use CommonJS (`require`/`module.exports`), never ESM.
- PM2 is the process manager. Always check `pm2 list` before restarts.
```

### MEMORY.md Update Rules

1. **Append, never delete** — older entries remain unless contradicted by newer ones.
2. **Contradiction resolution** — if a new observation directly contradicts an old one, replace the old one and add `(updated)` marker.
3. **Section ordering** — Patterns → Errors → Preferences → Conventions → Cross-Project.
4. **Tag consistency** — tags in brackets `[tag]` must match `raw_memories.json` tag categories.
5. **Max size** — keep MEMORY.md under 4000 tokens. If over limit, consolidate older/low-confidence entries into `memory_summary.md` and remove from MEMORY.md.

---

## 5. Consolidation Pipeline

### Trigger Conditions

Consolidation runs when `shouldConsolidate()` returns true. The conditions are:

| Condition | Threshold | Source |
|-----------|-----------|--------|
| Raw memory count | ≥ 10 entries | `raw_memories.json` length |
| Turn interval | Every 25 turns | `_toolCallCount` |
| Session ending | On `autoInit()` next session start | Always |
| Explicit command | `/consolidate` | User-triggered |

The 25-turn interval and 10-entry threshold are configurable via environment variables:

```javascript
const CONSOLIDATION_THRESHOLD = parseInt(process.env.HAKSTER_CONSOLIDATION_THRESHOLD) || 10;
const CONSOLIDATION_TURN_INTERVAL = parseInt(process.env.HAKSTER_CONSOLIDATION_INTERVAL) || 25;
```

### Pipeline Stages

```
┌─────────────────────────────────────────────────────────────┐
│                    CONSOLIDATION PIPELINE                     │
│                                                              │
│  1. LOAD raw_memories.json                                   │
│  2. GROUP by tags (pattern, error, preference, skill_candidate)│
│  3. DEDUPLICATE within groups (substring similarity > 0.6)   │
│  4. MERGE into existing MEMORY.md:                           │
│     a. Append new patterns                                   │
│     b. Update contradicted entries                           │
│     c. Increment confidence for recurring observations        │
│  5. CHECK for skill candidates (3+ occurrences of same tag)   │
│     a. If found → call extractSkill()                        │
│  6. GENERATE memory_summary.md from MEMORY.md                 │
│     a. Top 20 most relevant entries for current context       │
│     b. Condensed to fit under 1500 tokens                     │
│  7. CLEAR raw_memories.json (archived, not deleted)           │
│  8. RETURN updated prompt fragment for injection              │
└─────────────────────────────────────────────────────────────┘
```

### Archive Behavior

Consolidated raw memories are moved to `.hakster/memories/archive_{timestamp}.json` rather than deleted. This preserves the audit trail while keeping the active raw file clean.

---

## 6. SKILL.md Extraction

### When to Extract

A skill is extracted when a `skill_candidate` pattern appears 3+ times in raw memories with the same tag group. The `extractSkill()` function:

1. Reads the 3+ raw memories tagged as `skill_candidate` with matching tags.
2. Generates a SKILL.md template with:
   - Name (derived from tags)
   - Description (from the recurring observation)
   - Trigger conditions (when to use this skill)
   - Steps (extracted from the pattern)
   - Verification (how to confirm the skill worked)
3. Writes to `.hakster/skills/{skill-name}.md`
4. Updates MEMORY.md to reference the extracted skill
5. Removes the `skill_candidate` entries from raw_memories.json

### SKILL.md Template

```markdown
# {Skill Name}

## Description
{One-line description of what this skill does}

## Trigger
Use when: {specific conditions that should activate this pattern}

## Steps
1. {Step 1}
2. {Step 2}
3. {Step 3}

## Verification
{How to confirm the skill worked correctly}

## Source
Auto-extracted from {N} recurring observations on {date}

## Confidence
{0-1 scale based on observation frequency and consistency}
```

---

## 7. Relevance Scoring

When injecting learned lessons into the system prompt, not all memories are equally relevant. The `loadLearnedLessons()` function scores each MEMORY.md entry and `memory_summary.md` entry against the current context.

### Scoring Factors

| Factor | Weight | Description |
|--------|--------|-------------|
| Tag match | 0.3 | Does the entry's tags match current tools/files being used? |
| Recency | 0.2 | How recently was this entry added or updated? |
| Confidence | 0.2 | The entry's confidence score |
| Frequency | 0.15 | How many raw observations contributed to this entry |
| Type priority | 0.15 | Errors > Patterns > Preferences > Conventions |

### Relevance Scoring Algorithm

```javascript
function scoreRelevance(entry, currentContext) {
  const tagScore = computeTagOverlap(entry.tags, currentContext.tags);
  const recencyScore = computeRecency(entry.timestamp);
  const confidenceScore = entry.confidence;
  const frequencyScore = Math.min(entry.frequency / 5, 1); // normalize to 0-1
  const typeScore = TYPE_PRIORITY[entry.type] || 0.5;

  return (tagScore * 0.3) +
         (recencyScore * 0.2) +
         (confidenceScore * 0.2) +
         (frequencyScore * 0.15) +
         (typeScore * 0.15);
}
```

### Context Tags

Context tags are derived from:
- **Current file** being edited (e.g., `server`, `frontend`, `astro`)
- **Current tool** being used (e.g., `edit_file`, `exec_shell`, `web_search`)
- **Current project** directory name
- **Current task type** (inferred from user message keywords: `fix`, `build`, `deploy`, `debug`, `refactor`)

### Injection Budget

The system prompt injection for learned lessons is capped at **1500 tokens**. Entries are sorted by relevance score, and the top entries that fit within the budget are included.

---

## 8. System Prompt Injection

### Injection Point

Learned lessons are injected into the system prompt in `buildSystemPrompt()` (currently in `server/src/agent/index.js`, before line 631).

### Injection Format

```markdown
## Learned Lessons

{injection_from_agMd}

{injection_from_memory_summary}
```

Where:
- `injection_from_agMd` comes from `injectAgentsMd()` in `loop.js` — walks up from `cwd` to find `AGENTS.md`, reads it, and returns its content.
- `injection_from_memory_summary` comes from `injectLearnedLessons()` in `loop.js` — loads `.hakster/memory_summary.md`, scores entries against current context, and returns the top relevant entries within the 1500-token budget.

### Injection Order in System Prompt

The system prompt is assembled in this order:

1. **Base identity** — "You are haksterAi..."
2. **AGENTS.md content** — project-level steering rules
3. **Learned Lessons** — from `memory_summary.md`, relevance-scored
4. **Tool instructions** — available tools and their schemas
5. **Loop guard instructions** — from the existing loop-guard system prompt sections
6. **Current context** — user message, history, etc.

### Dynamic Updates

The injection is **not** static — it's recalculated:
- On every `autoInit()` call (session start)
- On every consolidation run (every 25 turns or 10 raw memories)
- When `shouldConsolidate()` returns true during the CONSOLIDATE phase

---

## 9. Consolidation Trigger Integration with Loop Phases

The CONSOLIDATE phase in the agent loop is where auto-learn runs its pipeline:

```
OBSERVE → (shouldReflect?) → REFLECT → (shouldConsolidate?) → CONSOLIDATE → THINK
```

### REFLECT Phase

`shouldReflect()` returns true when:
- `_noProgressCount >= 3` (3 turns without real progress)
- Semantic loop detected (`_recentResponsePrefixes` overlap ≥ threshold)
- Same tool error repeated 3+ times
- Clarifying question detected
- Filesystem wandering detected

**REFLECT action**: Inject a reflection message into history:

```
[REFLECT] No progress for {N} turns. Strategy: {current}. Consider: {alternatives}.
```

### CONSOLIDATE Phase

`shouldConsolidate()` returns true when:
- `_rawMemories.length >= CONSOLIDATION_THRESHOLD` (default 10)
- `turn % CONSOLIDATION_TURN_INTERVAL === 0` (every 25 turns)
- Session is ending
- User typed `/consolidate`

**CONSOLIDATE action**:
1. Run consolidation pipeline
2. Update `MEMORY.md`
3. Regenerate `memory_summary.md`
4. Clear `raw_memories.json` (archive)
5. Re-inject updated lessons into system prompt

---

## 10. autoInit() Flow

The `autoInit()` function is called at session start from `cli/index.js` (additive change in the chat command handler).

### Flow

```
autoInit(cwd)
├── 1. ENSURE .hakster/ directory structure exists
│   ├── mkdir .hakster/memories/ (if missing)
│   ├── mkdir .hakster/skills/ (if missing)
│   └── touch .hakster/memories/raw_memories.json (if missing, init [])
│
├── 2. LOAD existing memory
│   ├── Read .hakster/MEMORY.md (if exists)
│   ├── Read .hakster/memory_summary.md (if exists)
│   └── Read .hakster/memories/raw_memories.json (if exists)
│
├── 3. WALK UP to find AGENTS.md
│   ├── Start at cwd
│   ├── Check each parent for AGENTS.md
│   ├── Stop at git root or filesystem root
│   └── Read and return AGENTS.md content
│
├── 4. SCORE and FILTER learned lessons
│   ├── Load memory_summary.md entries
│   ├── Score each entry against current context
│   ├── Sort by relevance score descending
│   └── Select top entries within 1500-token budget
│
├── 5. BUILD prompt fragment
│   ├── Format AGENTS.md content as "## Project Rules"
│   ├── Format top lessons as "## Learned Lessons"
│   └── Return combined string for injection
│
└── 6. RETURN { agentsMd, learnedLessons, promptFragment }
```

### Error Handling

- If `.hakster/` creation fails (permissions), log warning and continue without memory.
- If `MEMORY.md` is malformed JSON, log warning and start fresh.
- If `AGENTS.md` not found, continue without project steering.
- All I/O operations use synchronous fs for simplicity, wrapped in try/catch.

---

## 11. addRawMemory() Integration

`addRawMemory()` is called from the OBSERVE phase of the agent loop, after each meaningful tool execution.

### Call Sites in agentLoop

```javascript
// After successful tool execution (in the tool result processing section)
const rawMemory = autolearn.addRawMemory({
  turn: _toolCallCount,
  phase: 'OBSERVE',
  tags: extractTags(fnName, fnArgs, cwd),
  observation: summarizeToolResult(fnName, fnArgs, toolResult),
  context: {
    file: fnArgs.path || fnArgs.file || null,
    line: fnArgs.line || null,
    toolName: fnName,
    toolResult: truncate(toolResult, 200)
  },
  type: classifyObservation(fnName, toolResult),
  confidence: computeConfidence(fnName, toolResult)
});
```

### Tag Extraction

Tags are derived from:
- **Tool name** — `edit_file` → `edit`, `exec_shell` → `shell`, `web_search` → `search`
- **File path** — extract directory/component names from `fnArgs.path`
- **Current project** — `path.basename(cwd)`
- **Error type** — if tool result indicates error: `error`, `timeout`, `permission-denied`

### Observation Classification

| Type | When Created | Example |
|------|-------------|---------|
| `pattern` | Successful tool use reveals project convention | "Project uses kebab-case for filenames" |
| `error` | Tool execution fails or produces unexpected output | "exec_shell: command X failed with ECONNREFUSED" |
| `preference` | User explicitly corrects or requests a style | "User prefers no comments in production code" |
| `skill_candidate` | Same pattern observed 3+ times | "Debugging pattern: read error → locate file → patch → verify" |

---

## 12. Memory Summary Generation

The `memory_summary.md` file is a condensed version of `MEMORY.md` optimized for system prompt injection.

### Format

```markdown
# Memory Summary
_Generated: 2025-07-16T12:30:00Z
_Entries: 12/23 (top 52% by relevance)

## Top Patterns
- Server listens on process.env.PORT || 3579
- Agent loop has 8 loop-break mechanisms (preserve all)
- Use CommonJS require/module.exports, never ESM

## Known Errors
- ECONNREFUSED when Ollama down → check provider availability first
- Build must run from project root, not server/

## Preferences
- Minimal code, no unnecessary comments
- Preserve CLI and web state across both

## Conventions
- kebab-case filenames
- Commit messages under 72 chars
```

### Regeneration Rules

1. Regenerate on every consolidation run.
2. Sort entries by relevance score (computed against an empty context — pure recency/confidence/frequency).
3. Keep under **1500 tokens** total.
4. Include section headers even if sections are empty (for consistent prompt structure).

---

## 13. Integration Points

### In `server/src/agent/loop.js`

| Export | Purpose | Called By |
|--------|---------|-----------|
| `shouldReflect(state)` | Decides if REFLECT phase should run | `agentLoop` in `index.js` |
| `shouldConsolidate(state)` | Decides if CONSOLIDATE phase should run | `agentLoop` in `index.js` |
| `injectAgentsMd(cwd)` | Walks up to find and read AGENTS.md | `buildSystemPrompt` in `index.js` |
| `injectLearnedLessons(cwd, context)` | Loads and scores memory_summary.md | `buildSystemPrompt` in `index.js` |
| `AgentLoopPhase` | Enum: THINK=0, PLAN=1, ACT=2, OBSERVE=3, REFLECT=4, CONSOLIDATE=5 | Phase tracking |
| `loopPhaseTransitions` | Map of valid phase transitions | Phase validation |

### In `server/src/agent/autolearn.js`

| Export | Purpose | Called By |
|--------|---------|-----------|
| `initMemory(cwd)` | Creates .hakster/ structure | `autoInit` |
| `addRawMemory(entry, cwd)` | Adds observation to raw_memories.json | OBSERVE phase in agentLoop |
| `consolidateMemories(cwd)` | Runs consolidation pipeline | CONSOLIDATE phase |
| `extractSkill(entries, cwd)` | Extracts SKILL.md template | consolidateMemories |
| `loadLearnedLessons(cwd, contextTags)` | Scores and returns top lessons | `injectLearnedLessons` |
| `autoInit(cwd)` | Full INIT mode flow | `cli/index.js` chat handler |

### In `server/src/agent/index.js`

| Integration Point | Location | Change |
|-------------------|----------|--------|
| Require modules | Top of file | Add `const loop = require('./loop')` and `const autolearn = require('./autolearn')` |
| System prompt | `buildSystemPrompt()` ~line 631 | Inject AGENTS.md and learned lessons before tool instructions |
| Tool result processing | After each tool execution in agentLoop | Call `autolearn.addRawMemory()` |
| Post-observation | After OBSERVE phase | Check `shouldReflect()` and `shouldConsolidate()` |
| Session start | Beginning of agentLoop or CLI init | Call `autolearn.autoInit(cwd)` |

### In `cli/index.js`

| Integration Point | Location | Change |
|-------------------|----------|--------|
| Chat command handler | ~line 204, after config loading | Add `autolearn.autoInit(process.cwd())` |

---

## 14. Trust Escalation Integration

Auto-learn integrates with the trust escalation system from `agent-brains.md`:

### Trust Score Updates

| Event | Trust Delta | Auto-Learn Effect |
|-------|------------|-------------------|
| Successful file read | +1 | Higher confidence in file-related observations |
| Verified edit | +2 | Mark edit patterns as high-confidence |
| Successful test run | +3 | Boost confidence of testing conventions |
| Successful build | +5 | Boost confidence of build conventions |
| Destructive action denied | 0 (reset to 0) | Flag related observations as low-confidence |
| Inactive 5 turns | -1 | Reduce weight of older observations |

### Trust-Based Memory Filtering

When `loadLearnedLessons()` scores entries, it also considers the current trust level:

```javascript
const effectiveConfidence = entry.confidence * (0.5 + (trustLevel / 60));
// trustLevel ranges 0-30+, so multiplier ranges 0.5-1.0+
```

This means:
- At trust level 0: lessons are scored at 50% of their base confidence
- At trust level 10 (AUTO_EDIT): lessons are scored at 67%
- At trust level 30 (FULL_AUTO): lessons are scored at 100%

---

## 15. Configuration

All auto-learn behavior is configurable via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `HAKSTER_CONSOLIDATION_THRESHOLD` | 10 | Raw memories before consolidation |
| `HAKSTER_CONSOLIDATION_INTERVAL` | 25 | Turns between consolidation checks |
| `HAKSTER_MEMORY_MAX_TOKENS` | 4000 | Max tokens for MEMORY.md |
| `HAKSTER_SUMMARY_MAX_TOKENS` | 1500 | Max tokens for memory_summary.md |
| `HAKSTER_SKILL_THRESHOLD` | 3 | Observations before skill extraction |
| `HAKSTER_MEMORY_DIR` | `.hakster/memories` | Directory for raw memories |
| `HAKSTER_SKILLS_DIR` | `.hakster/skills` | Directory for extracted skills |
| `HAKSTER_AGENTS_MD` | `AGENTS.md` | Filename for project steering |
| `HAKSTER_RAW_ARCHIVE` | `true` | Archive raw memories instead of deleting |

---

## 16. Testing Strategy

### Unit Tests

| Test | What It Verifies |
|------|-----------------|
| `autoInit()` creates directory structure | .hakster/ and subdirectories exist |
| `autoInit()` loads existing memory | MEMORY.md and summary are read correctly |
| `autoInit()` finds AGENTS.md | Walk-up discovery works |
| `addRawMemory()` creates entry | Entry matches schema, ID is unique |
| `addRawMemory()` deduplicates | Similar observations increment confidence |
| `consolidateMemories()` groups and dedupes | Output MEMORY.md has correct sections |
| `consolidateMemories()` archives raw | Archive file exists, raw is cleared |
| `extractSkill()` generates SKILL.md | Template is correct, file is written |
| `loadLearnedLessons()` scores and truncates | Top entries within token budget |
| `shouldConsolidate()` conditions | Threshold, interval, session-end |
| `shouldReflect()` conditions | No-progress, loop, error, clarification |

### Integration Tests

| Test | What It Verifies |
|------|-----------------|
| Full INIT → INCREMENTAL → CONSOLIDATE cycle | End-to-end pipeline works |
| Memory persists across sessions | Auto-init loads previous memory |
| AGENTS.md injection into system prompt | Prompt includes project rules |
| Learned lessons injection | Prompt includes relevant lessons |
| Trust escalation affects memory filtering | Higher trust → higher effective confidence |

### Manual Smoke Test

1. Start haksterAi CLI
2. Run a few tool operations (read, edit, shell)
3. Verify `.hakster/memories/raw_memories.json` has entries
4. Wait for 25 turns or trigger `/consolidate`
5. Verify `.hakster/MEMORY.md` has consolidated sections
6. Verify `.hakster/memory_summary.md` has condensed entries
7. Restart CLI
8. Verify system prompt includes learned lessons from `memory_summary.md`
9. Verify AGENTS.md content is injected into system prompt

---

## 17. Key Constraints

1. **Never delete data** — archive raw memories, don't delete them.
2. **Never block the agent loop** — auto-learn I/O must not prevent the loop from continuing on error.
3. **Keep under token budgets** — MEMORY.md ≤ 4000 tokens, summary ≤ 1500 tokens.
4. **CommonJS only** — `require()`/`module.exports`, no ESM.
5. **Synchronous fs for init** — `autoInit()` uses sync fs; `addRawMemory()` and consolidation use async fs with error handling.
6. **No external dependencies** — only Node.js built-in modules (`fs`, `path`, `crypto`).
7. **Respect `.gitignore`** — `.hakster/` should be gitignored by default.
8. **Project-scoped** — each project root has its own `.hakster/` directory.
9. **Cross-project awareness** — lessons tagged as `cross-project` are shared across projects.
10. **Trust-aware** — memory relevance is modulated by the trust escalation system.

---

## 18. File Dependencies

```
auto-learn.md (this file)
├── References: agent-brains.md (phase enum, trust system, consolidation triggers)
├── Implemented by: server/src/agent/autolearn.js
├── Used by: server/src/agent/loop.js (shouldConsolidate, shouldReflect, injectAgentsMd, injectLearnedLessons)
├── Integrated into: server/src/agent/index.js (buildSystemPrompt, agentLoop)
└── Initialized from: cli/index.js (autoInit in chat handler)
```