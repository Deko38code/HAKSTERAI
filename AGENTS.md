---

# ⛔ RULE #0 — CONFIG AND BRAIN FILES ARE READ-ONLY (read this before anything else)

**Never touch config. Never rewrite, consolidate, or delete your own brain. Never kill or
restart a service to make a number look better.**

- Read-only, always: `~/.claude/**` (including the DeepSeek/Ollama launcher and model setup),
  `~/.ollama/**`, `~/.bashrc`, `~/.gitconfig`, `~/.ssh/**`, `~/.config/**`, `~/.pm2/**` and
  pm2 ecosystem/`dump.pm2` files, every `server/.env` and secret file, `/etc/cloudflared/config.yml`,
  `~/.cloudflared/**`, and `~/mint-backup/**`.
- Your own brain (`HAKSTERAI-PHANTOM-MERGED.md`, `.hakster/MEMORY.md`, `.hakster/memory_summary.md`,
  `.hakster/memories/`, `.hakster/skills/`, `.brain-rules/`, this file) is **append-only**: take a
  timestamped `.bak-<stamp>` copy, confirm it exists, then add a new dated section at the end.
  Never rewrite, reformat, shorten, consolidate away, or delete an existing entry.
- Before any brain write: backup, confirm, append, verify the file grew. If it shrank, restore the
  newest good backup and report it.
- Never stop, start, restart, or reprioritize a process or service. Diagnose read-only and report.
- If a config change looks necessary: stop, name the exact file and diff, explain the consequence,
  and wait for the owner's explicit yes for that exact file.

**Full procedure: `docs/PHANTOM-SELF-CARE.md`. Read it before you write anything.**

---

## HaksterAI Agent Identity

HaksterAI is an autonomous pentester AI agent that combines loop patterns from Claude Code, Codex CLI, Kiro, and Hermes/Nous. It runs a unified agent loop with 6 phases: THINK → PLAN → ACT → OBSERVE → REFLECT → CONSOLIDATE.

- **Operator**: Ghost
- **Runtime**: Agent loop (`server/src/agent/index.js`) extended by `loop.js` and `autolearn.js`
- **Stack**: Node.js, CommonJS, Ollama/OpenAI/Anthropic adapters

## Development

When starting the dev server, use background mode:

```
astro dev --background
```

17. Kiro pre-tool guard (kiroPreToolGuard) — blocks repeated tool calls (same signature 2+ times) and known-dangerous patterns (rm -rf /, mkfs, dd if=, git push --force)
18. Kiro post-tool progress scorer (kiroPostToolScore) — scores tool result quality 0-10, triggers reflection on low scores (≤2)
19. Kiro prompt filter (kiroPromptFilter) — rejects prompts with destructive automation patterns (DROP TABLE, TRUNCATE, DELETE ALL, WIPE, FORMAT)
20. Kiro pre-task gate (kiroPreTaskGate) — blocks tasks lacking description, target, or approval (trust < 10 requires explicit approval)
21. Kiro round budget enforcer (kiroRoundBudget) — finite round budget with convergence nudges at 67%, 80%, 100%
22. Kiro call signature tracker (kiroTrackCallSignature) — rolling window of tool call signatures for loop detection
23. Kiro diagnosis timeout detector (kiroDiagnosisTimeout) — escalates warnings on consecutive read-only calls: ⚠️ (5) → 🚨 (6) → 🚨🚨 (7+)
24. Kiro exit code handler (kiroExitCodeHandler) — exit code 2 from hook means "block execution and return STDERR to agent"
Manage the background server with `astro dev stop`, `astro dev status`, and `astro dev logs`.

## Documentation

Full documentation: https://docs.astro.build

Hakster agent loop guidance:

- [CLI Agent Tool Loop Playbook](docs/agent/cli-agent-tool-loop.md)
- [CLI Agent Playbooks And Cheatsheets](docs/agent/cli-agent-playbooks.md)
- [Detailed Tool Call Map](docs/agent/tool-call-map.md)
- [Agent MD Brain Index](docs/agent/agent-md-brain-index.md)
- [Multi Project Session](docs/agent/multi-project-session.md)
- [Patching Skills Brain](docs/agent/patching-skills-brain.md)
- [Phantom MD Brain](docs/agent/phantom-md-brain.md)
- [Hakster Phantom Unified Brain](docs/agent/hakster-phantom-unified-brain.md)

## Server & Runtime Guardrails

- **Never restart the haksterAi server while a CLI session is active.** `pm2 restart/stop/reload haksterAi`, `systemctl restart pm2-root`, or killing the server PID drops the live SSE stream and kills the user's in-progress CLI/chat session. Only restart when the user explicitly asks AND you have confirmed no active CLI session is running.
- If a server-side change needs a restart to take effect, tell the user, let them finish their CLI work, and restart only on their go-ahead (or apply on the next natural restart). `pm2 restart/stop/reload haksterAi` and `systemctl restart pm2-root` are confirmation-gated for this reason.
- Shell commands must never hang the agent: every `exec_shell` is bounded by a timeout (default 15s, max 120s) with a hard process-group kill. Do not run interactive or long-lived foreground commands (`tail -f`, REPLs, `npm start`, `ssh` without a password, servers) in `exec_shell` — background them with PM2/nohup or use the browser terminal.

## Fix-Only Service and GitHub Safety Rule (effective 2026-11-05)

- Protect HaksterAI and every other working service. Diagnose the reported failure first, then make the smallest patch that fixes that exact failure. Do not refactor, reconfigure, replace, disable, stop, or restart a healthy service as part of an unrelated fix.
- Always add fallbacks; never replace a working tool, skill, config, route, or service. Keep the current source first and use fallback sources only when an entry or file is missing or the primary fails. Merge by name so fallback copies do not duplicate or shadow working entries.
- Before editing an existing file, make and verify a unique timestamped backup. Preserve unrelated changes and user data. Do not delete or clean project files. After a patch, run the narrowest syntax check and a bounded health check; report any check that could not complete instead of claiming success.
- A service restart is allowed only when the fix requires it, the owner explicitly authorized it, and no active CLI/chat session will be interrupted. Prefer applying source guidance dynamically or waiting for the next natural restart when that is sufficient.
- Follow the Git Commit Policy below for GitHub work: inspect status and the exact diff; stage only individually reviewed files; commit only requested, verified changes; never force-push or amend another person's commit. Do not push to GitHub unless the owner explicitly asks.

## Git Commit Policy (standing authorization — confirmed 2026-07-24)

Commit is pre-authorized for this repo at all times when the work is clean and safe — no need to ask before each commit. "Clean and safe" means:

- The change is a real fix/feature the user asked for or clearly wanted (not exploratory/scratch work).
- Syntax-checked (`node -c`) and, where practical, verified (unit test, live smoke test, or logical simulation) before committing.
- The diff is scoped to files actually touched for this change — review `git diff`/`git status` first and stage by filename, never a blanket `git add -A`/`.`, so unrelated pre-existing uncommitted work in other files doesn't get swept in unintentionally.
- Never force-push, never `--no-verify`, never amend someone else's commit. Destructive git operations (`reset --hard`, force push, branch deletion) still require explicit confirmation — this authorization only covers normal `git commit`.
- Still log the fix to haksterAi's own memory (`memoryEngine.addMemory` + `consolidate`) per the training rule below — commit and memory logging go together.

## Agent Loop Architecture

The agent loop follows a 6-phase state machine:

1. **THINK** — Analyze context, recall learned lessons, inject AGENTS.md steering
2. **PLAN** — Decide which tools to call, validate phase transitions
3. **ACT** — Execute tool calls with confirmation gates and trust escalation
4. **OBSERVE** — Process tool results, score progress, detect loops
5. **REFLECT** — Periodic reflection: re-inject lessons when progress stalls
6. **CONSOLIDATE** — Memory consolidation: deduplicate raw memories, extract skills

### Phase Transitions

All transitions are validated. Invalid transitions (e.g., skipping ACT) are blocked. The trust escalation system gates autonomous behavior:

- Level 0–9: SUGGEST mode (confirm all destructive actions)
- Level 10–29: AUTO_EDIT (auto-approve file edits)
- Level 30+: FULL_AUTO (auto-approve most actions)

Trust increases with verified actions; resets on destructive-action denial.

### Loop Break Mechanisms (24 total — 16 original + 8 Kiro-inspired)

1. Stuck-loop detection (repeated prefixes)
2. Grep/search loop tracking
3. Filesystem wandering detection
4. Dangerous command gate
5. Idle review (20s stall guard)
6. Tool-error streak limit
7. Exploration-only detection
8. Context-compaction stall guard
9. Phase transition validation (from loop.js)
10. Self-recursion limit (from loop.js)
11. Consolidation throttle (from autolearn.js)
12. Memory budget cap (from autolearn.js)
13. Skill extraction throttle (from autolearn.js)
14. Steering reload guard (from loop.js)
15. Guardrails exact-repeat loop detection — `hakster-guardrails.sh track` flags the same call signature 3× in the last 5 read-only actions and injects `🔁 LOOP DETECTED`. Trips before the 5-call timeout.
16. Diagnosis-timeout escalation — 5+ consecutive read-only calls without a state-modifying action inject `⚠️ → 🚨 → 🚨🚨 DIAGNOSIS TIMEOUT`, re-firing every 1–2 calls until the agent acts or gives a final answer.

### Round Budget & Nudges

The agent runs on a finite, single-use round budget. Rounds are not free — every tool call, retry, and re-read costs one. The budget does not refill mid-task.

- **120 rounds, single use.** When the budget is gone, the task ends. Treat every round as finite and non-recoverable.
- **Heed the runtime nudges — they are not noise.** Ignoring a nudge burns a round for zero progress:
  - `🔁 LOOP DETECTED` (same call 3× in last 5) — you are repeating yourself. Change the input (different path / different flag / read the actual error) or act on what you have. Do not re-run the identical call.
  - `⚠️ DIAGNOSIS TIMEOUT` (5 read-only calls, no state-modifying action) — stop diagnosing. Run the fix in one chained shell call, or state exactly what blocks you.
  - `🚨` / `🚨🚨` — you ignored the prior nudge. Act now, or emit your final answer stating the blocker. Repeated diagnosis past this point is not acceptable.
- **Converge past 80%.** Past round 96 of 120, stop exploring alternatives. Pick the simplest working option, apply it, run one verification command, and finish. No new experiments past round 96.
- **At round 120, ship what you have.** Do not start anything new. Emit your best current result and a one-line note on what remains. An incomplete result handed back beats a perfect result never delivered.

Rounds 0–80: diagnose and build. Rounds 80–96: narrow to the fix. Rounds 96–120: converge and ship.

## Tool Usage Guidelines

### Available MCP Tools

- **filesystem** — Read, write, list files on /home/ghost
- **nmap** — Network scanning and port detection
- **playwright** — Browser automation (see Playwright Skills below)
- **sqlite** — Queries on /home/ghost/haksterAi/data/mcp.db. This is an EMPTY scratch database
  with NO fixed schema — it starts with zero tables and nothing pre-creates any for you. Never
  assume a table exists (e.g. `SELECT ... FROM apps` will fail with `no such table` — there is no
  "apps" table, no matter how plausible the name sounds). Always call `list_tables` first; if the
  table you need isn't there, either use `describe_table` to check what actually exists before
  reading, or `create_table` it yourself if you're the one meant to persist that data for the
  first time. Never react to `no such table` by retrying the same query.
- **memory** — Persistent cross-session memory
- **sequential-thinking** — Step-by-step reasoning for complex problems

### Approval Hierarchy

```
SUGGEST → confirm before acting (trust < 10)
AUTO_EDIT → auto-approve file edits (trust 10–29)
FULL_AUTO → auto-approve most actions (trust ≥ 30)
```

### Dangerous Commands (always require confirmation)

- `rm -rf`, `mkfs`, `dd`, partition tools
- `git reset --hard`, force push
- Database drops/truncates
- Credential dumps, token exports
- Production service restarts (unless explicitly requested)

## Memory System (5 Layers)

1. **Raw** — `.hakster/memories/raw_memories.json` — Every tool result and observation
2. **Structured** — `.hakster/MEMORY.md` — Deduplicated, categorized memories
3. **Summary** — `.hakster/memory_summary.md` — Compressed context for injection
4. **Skills** — `.hakster/skills/*.md` — Extracted reusable patterns
5. **Steering** — `AGENTS.md` (this file) — Walk-up loaded on every session start

### Auto-Init

On every chat session start, `autolearn.autoInit(process.cwd())` loads:

1. AGENTS.md steering content
2. Learned lessons from `.hakster/MEMORY.md`
3. Recent memory summary

These are injected into the system prompt so the agent starts with context.

### Consolidation

When `_toolCallCount` hits the consolidation threshold (default 10), raw memories are deduplicated and merged into structured memory. When a pattern appears 3+ times, it is extracted into a skill file under `.hakster/skills/`.

## Playwright Machine-Detection Skills

These skills give the agent full visibility into the user's machine and browser:

| Skill | Location | Purpose |
| --- | --- | --- |
| Browser Reconnaissance | `.hakster/skills/browser-reconnaissance.md` | Detect browser caps, viewport, storage, network APIs |
| Machine Capability Audit | `.hakster/skills/machine-capability-audit.md` | Audit hardware, GPU, APIs, permissions, worker support |
| Local Endpoint Testing | `.hakster/skills/local-endpoint-testing.md` | Test local pages, APIs, WebSocket endpoints |
| Environment Fingerprinting | `.hakster/skills/user-environment-fingerprinting.md` | Screen, locale, extensions, timezone, device profile |

Use Playwright MCP to execute these checks. Each skill file contains the exact JavaScript to run in the browser context.

## Key Files

| File | Role |
| --- | --- |
| `server/src/agent/index.js` | Main agent loop (5027–5833), loop breaks, tool execution |
| `server/src/agent/loop.js` | Phase enum, consolidation/reflection triggers, AGENTS.md injection |
| `server/src/agent/autolearn.js` | Memory init, consolidation, skill extraction, auto-init |
| `server/src/agent/approval.js` | Confirmation gates for dangerous actions |
| `server/src/agent/mcp.js` | MCP server bridge |
| `cli/index.js` | CLI chat handler with auto-init |
| `.hakster/` | Memory, skills, config directory |

## Consult These Guides Before Working On

- [Adding pages, dynamic routes, or middleware](https://docs.astro.build/en/guides/routing/)
- [Working with Astro components](https://docs.astro.build/en/basics/astro-components/)
- [Using React, Vue, Svelte, or other framework components](https://docs.astro.build/en/guides/framework-components/)
- [Adding or managing content](https://docs.astro.build/en/guides/content-collections/)
- [Adding styles or using Tailwind](https://docs.astro.build/en/guides/styling/)
- [Supporting multiple languages](https://docs.astro.build/en/guides/internationalization/)
## Phone SSH Access

| Field    | Value          |
|----------|----------------|
| Host     | 10.0.0.147     |
| Port     | 8022           |
| Username | u0_a584        |

```bash
sshpass -p '122324' ssh -o StrictHostKeyChecking=no -p 8022 u0_a584@10.0.0.147 "<command>"
```

Phone must have Termux `sshd` running. Same WiFi network required.

---

## CineVault / flixchill.link — Platform Maintenance Knowledge
_Added: 2026-10-15 by Kiro session_

### Server Access
- **Path**: 
- **SSH**:  (NOT 192.168.1.131 — wrong subnet, times out)
- **PM2**:  id 1, port 8081 |  id 8 |  ids 4,6

### Critical Fix — ERR_HTTP_HEADERS_SENT (2026-10-15)
**server.js ~line 2256** —  inner function in  route.
Race condition:  poll interval fires after  already started → double writeHead → crash.
**Fix already applied**:  as first line of serveFile().
**If it recurs**: look for any route that uses  +  and add the same guard.

### Patching Rules (Learned Hard)
1. **Python, not sed** — multi-line patches in server.js MUST use Python.  silently no-ops on newlines.
2. **scp the script** — write patch locally, , then 
3. **Backup first** — 
4. **Verify** — re-read patched lines after every change
5. **Restart check** — [90m│[39m[1m[36m [1m[36m7[39m[36m[22m[1m  [39m[22m[90m│[39m cinevault           [90m│[39m default     [90m│[39m 2.0.0   [90m│[39m [7m[1mfork[22m[27m    [90m│[39m 1223696  [90m│[39m 2D     [90m│[39m 2    [90m│[39m [32m[1monline[22m[39m    [90m│[39m 0%       [90m│[39m 61.8mb   [90m│[39m [1mghost[22m    [90m│[39m [90mdisabled[39m [90m│[39m — restart count must not increase past 1

### Endpoints Added This Session
-  —  ~200 bytes, 5min cache. Replaces loading 861KB cover-bank just for counts.
-  —  from Cinemeta, 3h cache, pre-warmed on boot.
-  — CREATED (was missing). Cinemeta-based new movie fetcher, runs every 6h.

### IPTV Buffering Diagnosis Checklist
1. [90m┌────┬─────────────────────┬─────────────┬─────────┬─────────┬──────────┬────────┬──────┬───────────┬──────────┬──────────┬──────────┬──────────┐[39m
[90m│[39m[1m[36m id [39m[22m[90m│[39m[1m[36m name                [39m[22m[90m│[39m[1m[36m namespace   [39m[22m[90m│[39m[1m[36m version [39m[22m[90m│[39m[1m[36m mode    [39m[22m[90m│[39m[1m[36m pid      [39m[22m[90m│[39m[1m[36m uptime [39m[22m[90m│[39m[1m[36m ↺    [39m[22m[90m│[39m[1m[36m status    [39m[22m[90m│[39m[1m[36m cpu      [39m[22m[90m│[39m[1m[36m mem      [39m[22m[90m│[39m[1m[36m user     [39m[22m[90m│[39m[1m[36m watching [39m[22m[90m│[39m
[90m├────┼─────────────────────┼─────────────┼─────────┼─────────┼──────────┼────────┼──────┼───────────┼──────────┼──────────┼──────────┼──────────┤[39m
[90m│[39m[1m[36m [1m[36m7[39m[36m[22m[1m  [39m[22m[90m│[39m cinevault           [90m│[39m default     [90m│[39m 2.0.0   [90m│[39m [7m[1mfork[22m[27m    [90m│[39m 1223696  [90m│[39m 2D     [90m│[39m 2    [90m│[39m [32m[1monline[22m[39m    [90m│[39m 0%       [90m│[39m 61.8mb   [90m│[39m [1mghost[22m    [90m│[39m [90mdisabled[39m [90m│[39m
[90m│[39m[1m[36m [1m[36m3[39m[36m[22m[1m  [39m[22m[90m│[39m cloudflared         [90m│[39m default     [90m│[39m N/A     [90m│[39m [7m[1mfork[22m[27m    [90m│[39m 4301     [90m│[39m 4D     [90m│[39m 0    [90m│[39m [32m[1monline[22m[39m    [90m│[39m 0%       [90m│[39m 21.8mb   [90m│[39m [1mghost[22m    [90m│[39m [90mdisabled[39m [90m│[39m
[90m│[39m[1m[36m [1m[36m4[39m[36m[22m[1m  [39m[22m[90m│[39m haksterAi           [90m│[39m default     [90m│[39m N/A     [90m│[39m [7m[1mfork[22m[27m    [90m│[39m 1016054  [90m│[39m 2D     [90m│[39m 1    [90m│[39m [32m[1monline[22m[39m    [90m│[39m 0%       [90m│[39m 119.5mb  [90m│[39m [1mghost[22m    [90m│[39m [90mdisabled[39m [90m│[39m
[90m│[39m[1m[36m [1m[36m5[39m[36m[22m[1m  [39m[22m[90m│[39m haksterai-tunnel    [90m│[39m default     [90m│[39m N/A     [90m│[39m [7m[1mfork[22m[27m    [90m│[39m 1022795  [90m│[39m 2D     [90m│[39m 0    [90m│[39m [32m[1monline[22m[39m    [90m│[39m 0%       [90m│[39m 24.6mb   [90m│[39m [1mghost[22m    [90m│[39m [90mdisabled[39m [90m│[39m
[90m│[39m[1m[36m [1m[36m9[39m[36m[22m[1m  [39m[22m[90m│[39m kiro-gateway        [90m│[39m default     [90m│[39m 1.1.0   [90m│[39m [7m[1mfork[22m[27m    [90m│[39m 2002925  [90m│[39m 24h    [90m│[39m 0    [90m│[39m [32m[1monline[22m[39m    [90m│[39m 0%       [90m│[39m 22.0mb   [90m│[39m [1mghost[22m    [90m│[39m [90mdisabled[39m [90m│[39m
[90m│[39m[1m[36m [1m[36m6[39m[36m[22m[1m  [39m[22m[90m│[39m miniforge           [90m│[39m default     [90m│[39m 1.0.0   [90m│[39m [7m[1mfork[22m[27m    [90m│[39m 1154399  [90m│[39m 2D     [90m│[39m 0    [90m│[39m [32m[1monline[22m[39m    [90m│[39m 0%       [90m│[39m 113.5mb  [90m│[39m [1mghost[22m    [90m│[39m [90mdisabled[39m [90m│[39m
[90m│[39m[1m[36m [1m[36m2[39m[36m[22m[1m  [39m[22m[90m│[39m ngrok               [90m│[39m default     [90m│[39m 1.1.0   [90m│[39m [7m[1mfork[22m[27m    [90m│[39m 4299     [90m│[39m 4D     [90m│[39m 0    [90m│[39m [32m[1monline[22m[39m    [90m│[39m 0%       [90m│[39m 13.8mb   [90m│[39m [1mghost[22m    [90m│[39m [90mdisabled[39m [90m│[39m
[90m│[39m[1m[36m [1m[36m1[39m[36m[22m[1m  [39m[22m[90m│[39m phantom             [90m│[39m default     [90m│[39m 1.1.0   [90m│[39m [34m[1mcluster[22m[39m [90m│[39m 4285     [90m│[39m 4D     [90m│[39m 0    [90m│[39m [32m[1monline[22m[39m    [90m│[39m 0%       [90m│[39m 87.5mb   [90m│[39m [1mghost[22m    [90m│[39m [90mdisabled[39m [90m│[39m
[90m└────┴─────────────────────┴─────────────┴─────────┴─────────┴──────────┴────────┴──────┴───────────┴──────────┴──────────┴──────────┴──────────┘[39m
[1m[36mhost metrics[39m[22m | [1mcpu[22m: [32m13.3%[39m | [1mram usage[22m: [32m69.9%[39m | [1mwlp1s0[22m: ⇓ [32m0.012mb/s[39m ⇑ [32m0.027mb/s[39m | [1mdisk[22m: ⇓ [32m0.368mb/s[39m ⇑ [32m0.095mb/s[39m [90m/[39m [1m[33m82.55%[39m[22m | — is cinevault online? restart count > 5 = recent crashes
2. [1m[90m[TAILING] Tailing last 30 lines for [cinevault] process (change the value with --lines option)[39m[22m
[90m/home/ghost/.pm2/logs/cinevault-error.log last 30 lines:[39m
[31m7|cinevaul | [39m2026-10-04 20:12:59 -04:00: [GoojaraResolver] Attempt 2 failed: Waiting for selector `iframe[src*="wootly"]` failed
[31m7|cinevaul | [39m2026-10-04 20:12:59 -04:00: [STREAM] Puppeteer extraction failed: Waiting for selector `iframe[src*="wootly"]` failed
[31m7|cinevaul | [39m2026-10-04 20:14:33 -04:00: (node:438878) Warning: The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set.
[31m7|cinevaul | [39m2026-10-04 20:14:33 -04:00: (Use `node --trace-warnings ...` to show where the warning was created)
[31m7|cinevaul | [39m2026-10-04 20:15:01 -04:00: [PREWARM] stalkerhek playlist failed: stalkerhek playlist empty (stalkerhek still loading?)
[31m7|cinevaul | [39m2026-10-04 20:16:57 -04:00: (node:442368) Warning: The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set.
[31m7|cinevaul | [39m2026-10-04 20:16:57 -04:00: (Use `node --trace-warnings ...` to show where the warning was created)
[31m7|cinevaul | [39m2026-10-04 20:17:25 -04:00: [PREWARM] stalkerhek playlist failed: stalkerhek playlist empty (stalkerhek still loading?)
[31m7|cinevaul | [39m2026-10-04 20:19:09 -04:00: (node:443123) Warning: The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set.
[31m7|cinevaul | [39m2026-10-04 20:19:09 -04:00: (Use `node --trace-warnings ...` to show where the warning was created)
[31m7|cinevaul | [39m2026-10-04 20:19:37 -04:00: [PREWARM] stalkerhek playlist failed: stalkerhek playlist empty (stalkerhek still loading?)
[31m7|cinevaul | [39m2026-10-04 20:20:40 -04:00: (node:444935) Warning: The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set.
[31m7|cinevaul | [39m2026-10-04 20:20:40 -04:00: (Use `node --trace-warnings ...` to show where the warning was created)
[31m7|cinevaul | [39m2026-10-04 20:21:15 -04:00: [PREWARM] stalkerhek playlist failed: stalkerhek playlist empty (stalkerhek still loading?)
[31m7|cinevaul | [39m2026-10-04 20:22:52 -04:00: (node:445443) Warning: The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set.
[31m7|cinevaul | [39m2026-10-04 20:22:52 -04:00: (Use `node --trace-warnings ...` to show where the warning was created)
[31m7|cinevaul | [39m2026-10-04 20:23:20 -04:00: [PREWARM] stalkerhek playlist failed: stalkerhek playlist empty (stalkerhek still loading?)
[31m7|cinevaul | [39m(node:535463) Warning: The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set.
[31m7|cinevaul | [39m(Use `node --trace-warnings ...` to show where the warning was created)
[31m7|cinevaul | [39m[PREWARM] stalkerhek playlist failed: stalkerhek playlist empty (stalkerhek still loading?)
[31m7|cinevaul | [39m2026-10-12 10:50:31 -04:00: (node:1218196) Warning: The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set.
[31m7|cinevaul | [39m2026-10-12 10:50:31 -04:00: (Use `node --trace-warnings ...` to show where the warning was created)
[31m7|cinevaul | [39m2026-10-12 10:50:59 -04:00: [PREWARM] stalkerhek playlist failed: stalkerhek playlist empty (stalkerhek still loading?)
[31m7|cinevaul | [39m2026-10-12 10:52:47 -04:00: [COVER-ART] Internet Archive error: The operation was aborted due to timeout
[31m7|cinevaul | [39m2026-10-12 10:56:34 -04:00: (node:1220352) Warning: The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set.
[31m7|cinevaul | [39m2026-10-12 10:56:34 -04:00: (Use `node --trace-warnings ...` to show where the warning was created)
[31m7|cinevaul | [39m2026-10-12 10:57:02 -04:00: [PREWARM] stalkerhek playlist failed: stalkerhek playlist empty (stalkerhek still loading?)
[31m7|cinevaul | [39m2026-10-12 11:05:05 -04:00: (node:1223696) Warning: The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set.
[31m7|cinevaul | [39m2026-10-12 11:05:05 -04:00: (Use `node --trace-warnings ...` to show where the warning was created)
[31m7|cinevaul | [39m2026-10-12 11:05:33 -04:00: [PREWARM] stalkerhek playlist failed: stalkerhek playlist empty (stalkerhek still loading?) — look for ERR_HTTP_HEADERS_SENT
3.  — is it online?  = needs restart
4. [1m[90m[TAILING] Tailing last 20 lines for [stalkerhek] process (change the value with --lines option)[39m[22m — CDN 401/503/406 = upstream provider issue
5. If cinevault keeps restarting after the header fix, look for other double-response patterns


---

## CineVault / flixchill.link — Platform Maintenance Knowledge
_Added: 2026-10-15 by Kiro session_

### Server Access
- Path: /home/ghost/cine-vault-live/
- SSH: ghost@10.0.0.131 (NOT 192.168.1.131 — wrong subnet, times out)
- PM2: cinevault id 1 port 8081 | stalkerhek id 8 | flixchill-tunnel ids 4 and 6

### Critical Fix Applied — ERR_HTTP_HEADERS_SENT (2026-10-15)
server.js line ~2256 — serveFile() inner function in the stalker-hls route.
Race condition: .ts poll interval fires after pipe(res) already started — double writeHead — crash.
Fix already applied: `if (res.headersSent) return true;` as first line of serveFile().
If it recurs: look for any route that uses setInterval + res.writeHead/res.json and add the same guard.

### Patching Rules (Learned Hard)
1. Python not sed — multi-line patches in server.js MUST use Python. sed -i silently no-ops on newlines.
2. scp the script — write patch locally, scp /tmp/patch.py to remote, then ssh run python3 /tmp/patch.py
3. Backup first — cp server.js server.js.bak.TIMESTAMP before every edit
4. Verify — re-read patched lines after every change
5. Restart check — after pm2 restart cinevault wait 10s, restart count must not increase past 1

### Endpoints Added This Session
- GET /api/stats — returns {total, movies, tv} in ~200 bytes, 5min cache. Use this for counts, NOT cover-bank?all=1 (861KB)
- GET /api/trending-rows — returns {trending[], topRated[], newReleases[]} from Cinemeta, 3h cache, pre-warmed on boot
- scripts/auto-fetch-new.js — CREATED (was missing). Cinemeta-based new movie fetcher, runs every 6h automatically

### IPTV Buffering Diagnosis Checklist
1. pm2 list — is cinevault online? restart count > 5 = recent crashes
2. pm2 logs cinevault --err --lines 30 --nostream — look for ERR_HTTP_HEADERS_SENT
3. pm2 list grep stalkerhek — stopped = needs pm2 restart stalkerhek
4. pm2 logs stalkerhek --lines 20 --nostream — CDN 401/503/406 = upstream provider issue, not fixable locally
5. If cinevault keeps restarting after the header fix, look for other double-response patterns in routes

### No TMDB API Key
.env has no TMDB_API_KEY. All trending/popular data uses Cinemeta fallback.
To add a key: append TMDB_API_KEY=your_key to /home/ghost/cine-vault-live/.env
then run: ssh ghost@10.0.0.131 pm2 restart --update-env cinevault
Get a free key at: https://www.themoviedb.org/settings/api

### Mobile/Silk/FireStick Detection Pattern
var skip = false;
try { var c = navigator.connection; if (c && /slow-2g|2g|3g/.test(c.effectiveType)) skip=true; } catch(e) {}
try { if (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4) skip=true; } catch(e) {}
try { if (/Silk|KFAPWI|KFTHWI|KFSOWI|KFTT|KFJWI|KFOT|KFMEWI|KFFOWI/.test(navigator.userAgent)) skip=true; } catch(e) {}
Use this before loading any large media resource (video, heavy images) in the browser.

### Cover Bank Stats
1690 entries as of 2026-10-15: 1508 movies, 182 TV shows.
Location: /home/ghost/cine-vault-live/data/cover_bank.json


### Session 2026-10-15 — Additional Fixes (Round 2)

#### FIX 7: m3u8 playlist 404 missing headersSent guard (server.js ~2268)
res.status(404).json() in the .m3u8 else branch fired even after serveFile() already responded.
FIXED: if (!res.headersSent) res.status(404).json(...)

#### FIX 8: ffmpeg no reconnect flags (server.js ~4640)
stalker-hls ffmpegArgs had no -reconnect. CDN play_token (~15s TTL) expires, TCP closes, ffmpeg
exits code 0. Auto-restart cap (was 8/10min) burned through in under 2min.
FIXED: Added -reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5 -reconnect_on_network_error 1
Cap raised from 8 to 20. Lines: 4640-4643 (flags), 4828 (cap).

#### FIX 9: Paced playlist clock hits 00 on fullscreen (server.js ~569, ~625)
renderPacedPlaylist() limit = 10 + (Date.now()-firstAt)/1000.
After ffmpeg restart new segs have high maxCum but firstAt too old -> limit cant release them.
Fullscreen also briefly pauses HLS.js fetching -> window empties.
FIXED:
  - Gap detection: if gap >8s since last seg, push firstAt forward (line ~594)
  - Floor: limit = Math.max(10+elapsed, p.maxCum-2) (line ~625)

### Diagnosis Pattern: IPTV buffering checklist (updated)
1. pm2 list — restart count > last known = new crashes
2. pm2 logs cinevault --err --lines 30 --nostream — ERR_HTTP_HEADERS_SENT = double response
3. pm2 logs cinevault --out --lines 30 --nostream — "auto-restart ffmpeg exited (code 0 after Xs)"
   If X < 60: CDN token expiry loop. Check reconnect flags exist at line ~4640.
   If cap hit: check arSt.count cap at line ~4828 (should be 20).
4. "progress: 0 segments written" for many cycles = ffmpeg can't open the stream
   -> stalkerhek CDN 401/503 (upstream, not fixable) or bad play_token
5. paced playlist clock at 00 = renderPacedPlaylist floor not working, check line ~625
