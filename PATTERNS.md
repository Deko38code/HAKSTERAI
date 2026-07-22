# haksterAi — Agent Patterns

Catalog of the loop-breaking / convergence / self-monitoring patterns wired into the agent this session. All are additive (no core-loop rewrites), verified with `node --check`, and backed up (`*.bak`).

## Files in this zip
- `scripts/hakster-guardrails.sh` — external guardrail helper (track / preflight / nudge / reset)
- `server/src/agent/index.js` — the agent loop with all patterns wired in
- `AGENTS.md` — steering (auto-loaded every session, uncapped)
- `scripts/system-watchdog.cjs` — watchdog with the auto-debugger startup report
- `PATTERNS.md` — this catalog

## 1. Round budget (120, single-use)
`index.js:951` `MAX_TURNS_DEFAULT = 120`. Per-task, non-refilling. Was 15 (force-convergence cap); bumped to 120 now that guardrails prevent the exploration loops the 15-cap was compensating for.

## 2. Round-aware nudge (transient)
`index.js:6097` — before every `callOllama`, shells `hakster-guardrails.sh nudge <turn+1> <max>`. Output appended to a **copy** of history for that call only (never persisted → can't accumulate or be collapsed by `sanitizeHistory`).
- silent < 50% · halfway nudge at 50% (round 60) · converge nudge at 80% (round 96) · `Round budget exhausted… Ship now` at 100% (round 120) · loop-recovery nudge wins if `track` flagged a repeat.
- Script: `hakster-guardrails.sh` `nudge` case.

## 3. Read-only loop detection (🔁 LOOP DETECTED, 3×)
`index.js:7063` — in the read-only branch, builds a normalized per-call signature and shells `track <sig>`. Signature normalization strips `2>&1`, `2>/dev/null`, `sleep N`, `echo "..."` labels, pipe segments, and keeps only the **leading command** so cosmetic suffix variation (`curl health && echo "--ERRORS--"` vs `&& echo "--OUT--"`) can't evade detection. Fires at 3 identical in last 5.

## 4. Diagnosis-timeout escalation (⚠️ → 🚨 → 🚨🚨)
`index.js:6987` — 5+ consecutive read-only calls without a state-modifying action. Escalating threshold: 1st fire at 5, 2nd at +2, every fire after at +1 (nudge stays on, not a one-shot). Modifying actions reset `_diagCount` + `_diagFires` + guardrails.

## 5. Redundant-modify detector (🔁 → 🚨, 2× / 3×)
`index.js:6994` — re-running the SAME modifying command (`npm rebuild`, `pm2 restart`, `chown`…). Normalized signature (strips fluff, full command kept). 2nd run → `🔁 REDUNDANT MODIFY` reflection. 3rd run → `🚨 REDUNDANT MODIFY (final)` forces a decision: declare DONE, or change approach structurally. Catches the "rebuild 3x after it already succeeded" pattern the read-only detector misses (modifying actions reset the read-only counter).

## 6. Filesystem-wandering loop break
`index.js:6652` (pre-existing) — 6 calls exploring the same subtree without convergence → breaks the loop. Surfaces as `#10 LOOP-BREAK` in the chain table.

## 7. Smartness meter (🧠 %)
`index.js:975` — `_smartScore` starts at 62 (his current rated level), re-baselines per task. Shown as a bar in the reasoning panel, a compact chip in the status bar, and an end-of-review snapshot in the idle auto-review.
- **Per-call outcome scoring** `scoreToolCall` (`index.js:1010`, wired at `6927`): +2 success/HTTP 200, +2 write/patch, **+3 scrape** (scraped data → smarter), +1 install/rebuild/restart; −4 failed command, −3 error signatures (EADDRINUSE / ERR_DLOPEN_FAILED / npm error / SyntaxError / ENOENT), **−10 rm/git-reset of an important .md/.js/.json/.env** (lost real work → weaker).
- **Event hooks**: +5 clean finish (real final answer); −3 empty-retry stuck-loop; −8 read-only loop; −5/−7/−8 diagnosis timeout (escalating); −6/−10 redundant modify; −7 filesystem-wandering.
- **File integrity** `fileIntegrity` (`index.js:999`): tracks 13 critical files; missing one → −8 (once), restored → +5. Shown as `📁 Files X/Y (ZZ%)` in the idle review.
- Color: green ≥66, yellow 33–65, red <33. ▲/▼/◆ trend arrow. Labels: Sharp ≥80 / Strong ≥66 / Steady ≥50 / Slipping ≥33 / Struggling <33.

## 8. Model menu (crush-style, `/model`)
`index.js:7535` — `MODEL` is `let`. `/model` / `/models` opens a crush-styled `_crushPanel` listing ollama models grouped by family (company), pick by # / name / substring filter. `/model <name>` direct switch. API-key paste step (masked) wired but gated behind `MODEL_MENU_NEEDS_API(family)` (off for ollama-served models).

## 9. Idle auto-review (TUI panel)
`index.js:7635` — periodic snapshot: Services, Health, System (RAM/disk/load), Skills, Self-Check, Ports, **📁 Files**, **🧠 Smartness**. The smartness + file-integrity sections were added this session.

## 10. Watchdog auto-debugger
`system-watchdog.cjs:116` `debugReport()` — runs once on watchdog startup: PM2 process list + restart counts, listening ports, system stats, haksterAi health probe, agent-process liveness, critical-file integrity, guardrails state. Logged to stdout + `data/system-watchdog.log`.

## Rules (AGENTS.md, auto-loaded)
- Loop Break Mechanisms: 16 total (added #15 guardrails exact-repeat, #16 diagnosis-timeout escalation).
- Round Budget & Nudges: 120 single-use, converge past 80% (round 96), ship at 120, heed the 🔁/⚠️/🚨 signals.

## Verification status
- `node --check server/src/agent/index.js` ✅
- `bash -n scripts/hakster-guardrails.sh` ✅
- `node --check scripts/system-watchdog.cjs` ✅
- Smartness/scoreToolCall/fileIntegrity logic unit-tested against live state ✅
- Model menu interactive panel: reuses proven `_crushPanel`; not headlessly testable (needs TTY) — test with `/model` after restart.
