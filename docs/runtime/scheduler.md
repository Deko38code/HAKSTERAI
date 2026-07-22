# scheduler.md — Tool-Call Queue, Ordering & Duplicate Prevention

The scheduler batches the model's tool_calls, runs independent ones in parallel, and
prevents duplicate/redundant executions.

## Queue (✅ implemented)
- ✅ index.js:1074 `_messageQueue` — user messages typed while the agent is busy are
  batched (paste-batching at index.js:8200) and queued.
- ✅ index.js:1197 `_pendingTools` — in-flight tool calls shown in the TUI ("🔍N pending").
- ✅ index.js:1782 `msgPush/msgDrain/msgPeek/msgSize` — notification queue drained at
  turn start (index.js:8200 area).
- ✅ index.js:6045 — `📬 N waiting` chip in the status bar when `_messageQueue > 0`.

## Parallel execution (✅)
- ✅ index.js:6549 `for (const tc of msg.tool_calls)` — all tool_calls in a message run
  in one pass (the system prompt instructs batching independent calls in one turn).

## Duplicate prevention (partially ✅)
- ✅ Read-only repeat: `hakster-guardrails.sh track` flags the same call sig 3× in last 5
  (index.js:7063) → `🔁 LOOP DETECTED`.
- ✅ Modifying repeat: `_modifyingSigs` (index.js:6994) flags the same modifying command
  2×/3× → `🔁 REDUNDANT MODIFY` / `🚨` escalation.
- 🔲 Gap: a **tool-result cache** keyed by `tool + hash(args)` so the SAME call in the
  same task returns the cached result instead of re-executing. Spec:
```
_toolCache = new Map()            // key: tool + ':' + stableHash(args)
function execTool(name, args):
  key = name + ':' + stableHash(args)
  if !isModifying(name,args) and _toolCache.has(key):
     bumpSmart(0,'cache-hit'); return _toolCache.get(key)   // dedup read-only repeats
  r = runExecutor(name, args)
  if !isModifying(name,args): _toolCache.set(key, r)        // cache read-only results
  return r
```
  This makes "read .env 3×" a cache hit (0 cost) AND triggers the loop detector. TTL per
  task (cleared on task reset, index.js:5946 area).

## Dependency ordering (🔲 spec)
Tool calls are independent by default. Spec a dependency hint for ordered calls:
```
// a tool_call may carry dependsOn: [id] — scheduler runs those first
order = topologicalSort(tool_calls, deps)
```
Currently the model is trusted to chain with `&&` in one shell call (per AGENTS.md);
formal deps are optional.
