# haksterAi Agent Runtime Specification

A modular runtime contract for the haksterAi agent loop (`server/src/agent/index.js`).
Each module is a Markdown spec: what it governs, what's **already implemented** (with line
refs into `server/src/agent/index.js`), the **contract** the loop must honor, and
**pseudocode for gaps**. Hand these to the agent / a maintainer as the source of truth.

## Modules
- `runtime.md` — core execution engine + explicit state machine
- `planner.md` — planning, round budget, convergence + Definition of Done
- `scheduler.md` — tool-call queue, dependency ordering, duplicate-prevention
- `memory.md` — working / project / archived memory + summarization
- `tools.md` — tool orchestration, result cache, retries, recovery
- `loop_guard.md` — loop / stall detection, escalation, recovery
- `tui.md` — live status model (queue, action, memory, loop risk, progress, smartness)
- `config.yaml` — all configurable limits in one place

## Status
Much of this is **already live** in `server/src/agent/index.js` (loop detection,
diagnosis-timeout escalation, redundant-modify, smartness meter, round nudges, file
integrity, queue, idle auto-review). The specs below mark implemented parts with
`✅ index.js:LINE` and gaps with `🔲`.
