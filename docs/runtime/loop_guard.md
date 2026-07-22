# loop_guard.md — Loop / Stall Detection, Escalation, Recovery

The most-built subsystem this session. Multiple independent detectors; each logs +
adjusts the smartness meter + injects a system nudge.

## Detectors (all ✅ implemented)

| Signal | Site | Threshold | Smartness |
|---|---|---|---|
| Read-only repeat | index.js:7063 (`guardrails track`) | same sig 3×/last 5 | −8 |
| Diagnosis timeout | index.js:6987 | 5 read-only, no modify | −5/−7/−8 (escalating) |
| Redundant modify | index.js:6994 (`_modifyingSigs`) | same cmd 2×/3× | −6 / −10 |
| Filesystem wandering | index.js:6652 | 6 calls, same subtree | −7 |
| Empty-response stuck-loop | index.js:6228 | empty tool_calls | −3 |
| Stall trend | index.js:7002 (`_smartTrendDrops≥3`) | 3 consecutive drops | nudge + reset |
| Missing important file | index.js:7807 (`fileIntegrity`) | tracked file gone | −8 (restored +5) |

## Escalation pattern (✅)
Each detector escalates rather than fires once-and-resets:
- Diagnosis timeout: 5 → 2 → 1 threshold (stays on, not a one-shot).
- Redundant modify: `🔁` (reflect) → `🚨` (force DONE-or-change).
- Adaptive: when `_smartScore < 40`, diagnosis threshold drops to 3; `< 25` to 1
  (index.js:7094) — stricter exactly when he's failing.

## Smartness meter (✅ index.js:975)
`_smartScore` starts 62 (his current rated level), re-baselines per task. Drives:
- reasoning panel `🧠 Smart` bar (index.js:2083)
- status bar `🧠62%▲` chip (index.js:6045 `smartCompact`)
- idle review `🧠 Smartness` + `📁 Files` sections (index.js:7810)
- adaptive loop thresholds (index.js:7094) + trend stall nudge (index.js:7002)
Audit trail: `bumpSmart(delta, why)` logs `[smart] ±N → P% (why) [trend:K]` when
`HAKSTER_DEBUG_AGENT=1` (index.js:977).

## Recovery (see tools.md)
Detectors inject a nudge; the recovery table turns a repeated error into a structural
change, never an identical retry (which the detectors block anyway).

## Round-budget guardrail (✅)
- ✅ Round nudge (index.js:6097) + ship-now at 100%.
- 🔲 Gap: hard halt at `turn >= max` forcing a final answer (currently advisory).
