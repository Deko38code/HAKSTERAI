# runtime.md — Core Execution Engine

The agent loop is a single `agentLoop()` in `server/src/agent/index.js` that drives a
6-phase state machine over a finite round budget, executing tool calls, observing
results, and converging to a Definition of Done.

## State machine (explicit)

```
IDLE → THINK → PLAN → ACT → OBSERVE → REFLECT → CONSOLIDATE → (COMPLETE | THINK)
```

Transitions are validated; invalid jumps (e.g. skipping ACT) are blocked.

- ✅ index.js — 6-phase enum + `tuiSetPhase()` drives the panel; phase transitions gated
  by `loop.js` validation (AGENTS.md "Agent Loop Architecture").
- 🔲 Gap: the phases are string-driven, not an enum with a guarded `transition()`. Spec
  below.

### Contract
```
phase = IDLE
function transition(to):
  allowed = TABLE[phase]            // e.g. IDLE→THINK, THINK→PLAN, PLAN→ACT, ACT→OBSERVE,
                                   //      OBSERVE→REFLECT/THINK, REFLECT→CONSOLIDATE, CONSOLIDATE→COMPLETE
  assert allowed.includes(to), "invalid transition " + phase + "→" + to
  phase = to; tuiSetPhase(to)
  log('[phase] ' + to)
```

## Round budget (single-use, 120)
- ✅ index.js:951 `MAX_TURNS_DEFAULT = 120` (env `HAKSTER_AGENT_MAX_TURNS`).
- ✅ index.js:6097 — round-aware nudge injected transiently before each `callOllama`
  (`hakster-guardrails.sh nudge <round> <max>`; not persisted in history).
- 🔲 Gap: a hard halt at round 120 that forces a final answer (currently the nudge is
  advisory). Spec: at `turn >= max`, set `phase=COMPLETE`, emit best result, stop.

## Reasoning budget (hard limits)
- ✅ Empty-response retry limit: `EMPTY_RETRY_LIMIT` (index.js `_emptyRetries`).
- ✅ `num_predict` cap on generation (callOllama `numPredict`).
- 🔲 Gap: a per-turn wall-clock THINK budget. Spec:
```
THINK_BUDGET_MS = 30000   // config.yaml
thinkStart = Date.now()
... after model returns ...
if (Date.now()-thinkStart > THINK_BUDGET_MS) log('[budget] THINK overran')
```

## Execution history (structured)
- ✅ `saveToHistory()` / `SESSION_FILE` (cli_session.json) persists turns.
- ✅ `_recordAction()` builds the "What was done" checklist.
- 🔲 Gap: a structured JSONL execution log (turn, phase, tool, args-hash, result-hash,
  duration, smartness delta). Spec:
```
emitExecLog(evt):
  fs.appendFileSync(EXEC_LOG, JSON.stringify({t:Date.now(), turn, phase, ...evt})+'\n')
```
Useful for post-run replay + the watchdog debug report.

## Trust escalation (already implemented)
- ✅ SUGGEST (0–9) → AUTO_EDIT (10–29) → FULL_AUTO (30+); resets on denied destructive
  action. Phase transitions + approval gates live in `server/src/agent/approval.js`.
