# tui.md — Live Status Model

The TUI is the agent's self-monitoring surface. It renders in three places: the
reasoning panel (in-place redraw), the status bar (`\r` in-place), and the periodic idle
auto-review.

## Reasoning panel (✅ index.js:~2045)
Per-phase timing + a Progress bar + a Smart bar:
- `Progress ████░░ 62% Step X/120` (index.js:2058)
- `🧠 Smart ████░░ 62% ▲` (index.js:2083 `smartBar()`)
Phases: THINK→PLAN→ACT→OBSERVE→REFLECT→CONSOLIDATE with per-phase durations.

## Status bar (✅ index.js:6045)
Single `\r` in-place line, refreshed ~1Hz:
`haksterAI ❯ │ ⚡ Executing → <cmd> ⏋ Step X/120 │ 12s │ ↑25k ↓0.1k 🔥500k/m │ 💰$0 │ 🔍2 pending │ 📬1 waiting │ 🧠62%▲`
- activity + spinner frame (index.js:6010)
- token in/out + burn rate + cost (index.js:5975)
- pending tools `🔍N pending` (index.js:5979)
- queue `📬N waiting` (index.js:6045)
- smartness `🧠NN%▲` (index.js:6045 `smartCompact`)

## Idle auto-review (✅ index.js:7635 `runIdleAutoReview`)
Periodic (IDLE_TIMEOUT_MS) snapshot:
- 📦 Services (pm2 list + auto-restart dead)
- 🏥 Health (curl /api/health per service)
- 💻 System (RAM/disk/load/uptime)
- 📚 Skills (count across roots)
- 🔧 Self-Check (pid/heap/uptime/history/tools)
- 🔌 Ports (expected services up/down)
- 📁 Files (fileIntegrity %, missing) — index.js:7803
- 🧠 Smartness (bar + label Sharp/Strong/Steady/Slipping/Struggling) — index.js:7810

## Tool grid + chain table (✅)
- TOOL GRID: each tool call with status (✓/●/×) + output preview (index.js `tuiToolDone`).
- CHAIN TABLE: ordered exploit-chain map of calls (index.js `renderChainPanel`).

## Gap (🔲 spec)
- 🔲 A dedicated **loop-risk panel** summarizing all detector states at a glance
  (loop_count, diagCount, smartTrend, last nudge). Currently spread across the smart bar
  + log lines. Spec: one panel row: `loop:🔁0 diag:0/5 trend:0 last:none`.
