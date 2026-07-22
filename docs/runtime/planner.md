# planner.md — Planning, Convergence & Definition of Done

The planner decides what tools to call, when to stop diagnosing, and when the task is
"done." It enforces the round budget and convergence rules from `AGENTS.md`.

## Round budget + convergence (✅ implemented)
- ✅ index.js:951 — 120-round single-use budget.
- ✅ index.js:6097 — nudge ladder: silent <50%, halfway 50%, converge 80% (round 96),
  ship-now 100% (round 120). Guardrails `nudge` prints nothing when fine.
- ✅ `AGENTS.md` "Round Budget & Nudges" (auto-loaded, uncapped) — the contract the model
  sees: "Rounds 0–80 diagnose/build; 80–96 narrow; 96–120 converge/ship."

## Diagnosis timeout (✅)
- ✅ index.js:6987 — 5+ read-only calls without a state-modifying action → escalating
  nudge (⚠️→🚨→🚨🚨), threshold collapses (5→2→1) as it repeats. Adaptive: stricter when
  `_smartScore < 40` (see `loop_guard.md`).

## Definition of Done (🔲 gap — spec)
The agent stops when success criteria are met. Today "done" = "model returns content with
no tool_calls" (index.js:6260 `if (!msg.tool_calls ...)`). Spec a real DoD checklist:
```
dod = []                       // task-specific success criteria
function checkDoD():
  for c in dod: if !c.verify() return false
  return true
// on each OBSERVE:
if checkDoD(): phase = COMPLETE; emitFinal()
```
DoD items are populated from the user's task (e.g. "service responds HTTP 200", "file
syntax OK", "diff applied"). The `verify once, not forever` rule (see `tools.md`) prevents
re-checking.

## Plan persistence
- ✅ `plan` tool writes `.hakster/plan.md` (referenced in AGENTS.md "Plan & Todo Tools").
- 🔲 Gap: the loop doesn't auto-mark plan todos done as actions complete. Spec: each
  successful modifying action that matches a plan todo marks it `done`.
