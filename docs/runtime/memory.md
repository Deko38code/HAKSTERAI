# memory.md — Working / Project / Archived Memory + Summarization

haksterAi already has a 5-layer memory system (see `AGENTS.md` "Memory System (5 Layers)").

## Layers (✅ implemented)
1. ✅ Raw — `.hakster/memories/raw_memories.json` — every tool result/observation.
2. ✅ Structured — `.hakster/MEMORY.md` — deduplicated, categorized.
3. ✅ Summary — `.hakster/memory_summary.md` — compressed context injected per session.
4. ✅ Skills — `.hakster/skills/*.md` — patterns extracted after 3+ repeats.
5. ✅ Steering — `AGENTS.md` — walk-up loaded every session (uncapped, the contract).

## Session injection (✅)
- ✅ index.js `loadPhantomBrain()` (capped 3000 chars) + `injectAgentsMd()` (uncapped) +
  `buildProjectMemoryBlock()` (MEMORY.md) + `injectLearnedLessons()` + memoryEngine
  recall — all composed in `buildSystemPrompt()`.

## Consolidation (✅)
- ✅ `autolearn.js` — at the consolidation threshold (`_toolCallCount` default 10) raw
  memories dedupe → structured; 3+ repeats → skill file.

## Working memory = `history` (✅)
- ✅ `history[]` — the live conversation; `compactHistory()` shrinks it on budget pressure
  (`budgetMax` index.js:7179). Sanitize collapses consecutive system messages
  (index.js:5671 `sanitizeHistory`).

## Gaps (🔲 spec)
- 🔲 **Forgetting policy**: archived memory should age out (importance × recency). Spec:
  `score = importance * decay(ageDays)`; drop below threshold on consolidation.
- 🔲 **Memory budget per type**: cap raw_memories.json size; rotate to archive files
  (already partly done — `raw_memories_archive_*.json` exist).
- 🔲 **Recall grounding**: injected memories should carry a `source` ref so the model
  doesn't treat stale memory as current truth (anti-hallucination, per AGENTS.md
  "Never state system stats from memory").
