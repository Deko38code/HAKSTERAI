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


## Profit rates — locked (see PROFIT-RATES.md)

Owner (2026-11-22): this project **displays** the locked rate card; it never defines one. Read the
read-only snapshot `Junkalot/data/profit-rates-snapshot.json` and label it "source: junkalot.co"
(CLAUDE.md §16 project isolation, §19.6 read-only reads, §25 owner-internal, §26 locked rates).

- Billed rate (locked): **$541.3043 in / $108.2609 out per 1M tokens**; $249 buys 450k in + 50k out tokens
  a month, overage above it at the same rate. A Coach turn is metered by its own tokens.
- Cost base: **`deepseek-v4.1-flash:1017` on Ollama cloud**, billed by **request quota, not tokens** —
  26,511 requests = 83.5 % of a ~31,750 weekly quota (headroom ~5,239) at a heavy workload; a second Ollama
  cloud account and Codex Pro (unlimited) sit behind it. Per-token cost stays `null`; margin is the quota
  share, never an invented dollar figure.
- The demand index is advice only and never moves a rate, bill, route, model or plan on its own.
- Never write profit data into Junkalot or into another project.


## Builds go through the server widget

Owner (2026-11-22): "make sure all our builds and updates go threw server widget always to junkalot and
haksterai" (CLAUDE.md §27). **`npm run build:update -- --label X --note Y` is the only deploy path** —
`scripts/build-update.cjs` records the job in `dev/build-history/data/current-job.json` (the applet's only
source of truth), builds into `dist-next`, rsyncs into `dist`, waits for `/api/version` to report the build
id the served page carries, health-checks `:3579`, and only then marks it complete. A bare `astro build`
into `dist` changes the live site without showing in the widget — never use it as a deploy. Never restart
the server for a static deploy.

## Junkalot rulebook index — mapped

Junkalot's index of the MASTERGUARD rules is `/home/ghost694/junkalot/RULEBOOK-INDEX.md` (on Parrot's
master copy): every section of `/home/ghost/CLAUDE.md` (§1–§50) with what it means on that project and where
this file mirrors it. It is a read-only pointer — HaksterAI never writes a rule, a rate, a key or usage into
that project (§16) — and it is not a second rulebook: CLAUDE.md wins on any difference.

Shared rules that apply here exactly as they do there: §16 project isolation, §17 tunnel protection, §19
profit accounting, §22 the locked model configuration, §23 silent secret intake, §25 owner-internal stays
internal, §26 locked rates with an advisory index, §27 builds go through the server widget, §30 no profit
on Junkalot's client admin, §31 client API keys never enter Git, §32 installs only while a client is signed
out, §33 queue builds in order and verify her email+IP before applying.

## Section Pointer Corrected — §1–§35 (2026-11-24)

_Added: 2026-11-24, owner-approved ("yes go"). One existing parenthetical was corrected; nothing else in
this file was rewritten, reordered or removed. Backup before the edit: `AGENTS.md.bak-20261124T052355Z`
(34,933 B, size-verified)._

The rulebook pointer above now reads `/home/ghost/CLAUDE.md` **(§1–§35)** instead of §1–33, because the
master rulebook grew two sections on 2026-11-24:

- **§34 Nothing Public Ever Points At The Admin** — bare sign-in page, generic errors, `/admin` noindex.
  This one applies to every project we serve, Junkalot included.
- **§35 Our Model Is Named HAKSTERAI-FLASH — The Label Only, The Config Untouched** — amends §22.1's
  *display* name only; the wire model `deepseek-v4.1-flash:cloud`, the `127.0.0.1:11434` relay, the
  provider, the ladder and every rate stay exactly as §22 locked them. HaksterAI-only; it does not
  reach Junkalot.

Junkalot's own index was updated to map §1–§35 in the same task
(`/home/ghost694/junkalot/RULEBOOK-INDEX.md`, Parrot master copy), with a timestamped backup and an
append-only §20 worklog entry. No rule, rate, key or usage value was written into Junkalot (§16).

---

## Section 36 Added — Profit Leaves Junkalot (2026-11-24)

_Added: 2026-11-24, owner-directed ("data profit from junkalot always goes to phantomide never display our
profits in junkalot admin dash only what junkalot owes due etc add rule"). Backup before the edit:
`AGENTS.md.bak-20261124T054226Z (36,160 B, size-verified)`; master-rulebook backup `CLAUDE.md.bak-20261124T054208Z` (55,777 B,
size-verified). Nothing above this line was rewritten, reordered or removed — one pointer parenthetical was
advanced from §1–§35 to §1–§36, exactly as the §35 entry did._

`/home/ghost/CLAUDE.md` is now **§1–§36**. §36 is **"Profit Leaves Junkalot — Its Admin Shows Only What
Junkalot Owes"**: our profit figures (rate card, meter, margin, cost base, demand index) are produced in
Junkalot's data and read out by the PhantomIDE and HaksterAI owner dashboards through the existing
read-only snapshot/bridge — they are never rendered on junkalot.co, in any admin tab or any payload either
account can read. Junkalot's admin shows her plan, allowance, tokens, meter against her plan, invoices and
amounts due. It extends §30 (which kept profit out of her *client* view) to the whole project, including
the owner view, and moves no rate, bill or computation (§19, §24, §26 remain locked).

Verified read-only against the live code on Parrot before writing: `/api/admin/mred-usage` already returns a
profit-free `selfView` to a non-owner and a profit object only on the owner branch, and
`src/app/admin/security/page.tsx` renders no rate card, meter or margin — its own comment at the meter tab
states they "are not rendered on junkalot.co at all". So §36 records existing correct behaviour as a rule
rather than mandating a code change; `_BusinessTools.tsx` (her own job-pricing margin calculator) is her
tool, not our disclosure, and stays (§36.5).

---

## Section 37 Added — No Client-Server Restart While She Is Active (2026-11-24)

_Added: 2026-11-24, owner-directed ("and we never restart clients server while shes active in admin dash in
junkalot with 1junkalot and her susie email add rule always when offline we update server etc"). Backup
before the edit: `AGENTS.md.bak-20261124T054429Z (38034 B, size-verified)`; master-rulebook backup
`CLAUDE.md.bak-20261124T054413Z` (58,732 B, size-verified). Nothing above this line was rewritten,
reordered or removed — one pointer parenthetical was advanced from §1–§36 to §1–§37, exactly as the §35 and
§36 entries did._

`/home/ghost/CLAUDE.md` is now **§1–§37**. §37 is **"Never Restart The Client's Server While She Is Active —
Update Only When Offline"**: it extends §32 (installs only while she is signed out) and §33 (queue builds,
verify her email+IP) to *every* restart of Junkalot's server process — a PM2 restart for an env or config
change, a crash-recovery loop, a hand-run bounce — not only a staged build hand-off. Activity is measured
read-only via `scripts/client-activity.mjs` over `data/admin-sessions.jsonl`, naming her by email and IP
(`1junkalot@gmail.com`, `susanschlamp53@gmail.com`); the owner's account never counts. A held restart is
reported as held, never as done, and nothing overrides her session on a timer. No rate, bill, model or
computation moves (§19, §24, §26, §22 remain locked).

---

## Section 38 Added — Fix And Patch, Never Reconfigure Himself (2026-11-25)

_Added: 2026-11-25, owner-directed ("add a guard where hakster can break himself only fix patch but never do
what he just did break his own config"; "make sure his steer is working and he recieves his messages while
working to do it all in one shot"; "make sure his response time is fast like 10sec or less not 20 sec"; "his
cli updates arent installing when cli starts and dosnt say installed restart cli to see changes should be on
top of tui to the right of cpu ram usage"; "make sure his model has our config from this cli for speed";
"make it exacly like this cli and my model are set to"). Backup before the edit:
`AGENTS.md.bak-20261125T063452Z (39,484 B, size-verified)`. Nothing above this line was rewritten, reordered
or removed — one pointer parenthetical was advanced from §1–§37 to §1–§38, exactly as the §35–§37 entries did._

`/home/ghost/CLAUDE.md` is now **§1–§38**. §38 is **"Hakster Fixes And Patches — He Never Rewrites His Own
Config, And He Hears You While He Works"**. Four things it makes binding here:

1. **Self-config guard.** `cli/src/self-config-guard.js` refuses — never rewrites — any tool write to
   `cli/src/models/ladder.js`, `cli/src/prefs.js`, `~/.hakster/config.json` or a model/provider variable in
   an env file, on both tool surfaces (`cli/tools.js`, `server/src/providers.js` `executeAgentTool`). Ordinary
   fixes and patches are untouched; the owner's `HAKSTER_ALLOW_SELF_CONFIG=1` opens it for one action.
   Pinned by `cli/ui/__tests__/self-config-lock.test.mjs`.
2. **Live steer.** A message typed while he works is read inside the run — drained before the next model
   call, taken at a mid-stream boundary, or (on the `claude-cli` lane, which has no stdin turn loop) the turn
   is stopped, the update is announced on the wire, and the run restarts on the same conversation with what
   was already completed spelled out. Bounded at 4 restarts; an update that cannot reach the model is handed
   back and queued, never dropped.
3. **The 10-second bar.** An interactive turn answers in ~10 s or less: the `claude-cli` lane starts the MCP
   core plus any server the operator's own message names (measured 11.1–11.6 s with all, 5.1–6.4 s with the
   core), and a change that moves latency is measured before and after. **Amended 2026-11-26 at the owner's
   direction ("check his response time was almost 20sec this time on dell" → "go"): the full-auto exemption
   is removed** — the approval dial no longer widens the tool set; a chat turn starts the six-server core
   plus any server the message names, and only "all tools" loads everything (measured that day on the Dell:
   core 3.54 s vs all 20 servers 8.81 s). The lean set is derived from `mcp.json` into a temp file; no model,
   route, provider, rate or plan moves (§19.3, §22.4, §26). A build on disk newer than the running session
   shows `⬆ vX installed · restart CLI to see changes`
   at the right of the cpu/ram meters, once in the transcript too.
4. **His model is this session's config, value for value.** `claudeCliEnv()` mirrors the owner's own Claude
   Code session — relay `http://127.0.0.1:11434`, `deepseek-v4.1-flash:cloud` behind every Claude-style
   alias, 1,048,576 context and compact window, attribution header, auto-mode server, survey/reminder/
   error-reporting switches and PATH — and a test pins it so a later edit cannot drift one value. `--model`
   is passed only for a wire id, so an alias can send the relay nothing it does not serve. Nothing in §38
   moves a model, route, provider order, rate, plan or allowance (§19.3, §22.4, §26).

Behavioural canary: `cd cli && npm run selfcheck` (add `--live` for one real tool round) — it fails when a
tool round stops completing, which is the exact failure that broke tool calling on 2026-11-25. §38 is
HaksterAI-only; nothing in it writes into Junkalot, PhantomIDE or any other project (§16).

---

## Section 39 Added — The CLI Auto-Compacts Like This Session (2026-11-25)

_Added: 2026-11-25, owner-directed ("make sure the cli auto compact is set like this cli is in this session
and make it to where each time the version changes it gets updated also add rule"; "and add compacting
conversation while doing it"; "never break my output panels or change config"). Backup before the edit:
`AGENTS.md.bak-20261125T071500Z (43,009 B, size-verified)`; master-rulebook backup
`CLAUDE.md.bak-20261125T071500Z (65,611 B, size-verified)`. Nothing above this line was rewritten,
reordered or removed — one pointer parenthetical was advanced from §1–§38 to §1–§39, exactly as the
§35–§38 entries did._

`/home/ghost/CLAUDE.md` is now **§1–§39**. §39 is **"The CLI Auto-Compacts Like This Session, And A Version
Change Reaches Every Surface"**. What it makes binding here:

1. **The compact window is the owner's own session value.** `claudeCliEnv()` in `server/src/providers.js`
   and in `server/src/agent/index.js` both carry `CLAUDE_CODE_AUTO_COMPACT_WINDOW=200000` and
   `CLAUDE_CODE_MAX_CONTEXT_TOKENS=1048576`, as literals in code (§22.4). 200000 is the compact window;
   1048576 is max context — they were both 1048576 here, so the spawned CLI never compacted at the same
   point as his. Pinned by `cli/ui/__tests__/auto-compact.test.mjs` and `self-config-lock.test.mjs`.
2. **The run compacts its conversation while it works.** `/api/agent/run` summarises the older turns into
   one model-written `📦 SESSION SUMMARY` once the history passes 60 % of the input budget (pre-flight and
   mid-run), once per run, 15 s bound, truncation as the fallback. Old history is dropped in whole turns
   only, so a `tool_calls` message never loses its `tool` results. The `compact` event carries its own
   counts and the TUI shows it as one activity line and one notice turn — no guessed percentage, no
   output-panel layout change (§10, §38).
3. **One version source, every surface.** `cli/package.json` → `/cli/latest.json` (computed per request:
   version, bundle SHA-256, build time) → the site's `#hero-cli-version` badge, which renders it at build
   time and refreshes from that endpoint on load, every 60 s while visible and on `visibilitychange`. A
   version bump updates the CLI, the endpoint and an open tab with no second edit (§28).
4. **Nothing moves for money and nothing else is touched.** No model, provider, route, rate, plan or
   allowance changes, and the output panels keep their layout (§19.3, §22.4, §26). HaksterAI-only (§16).

---

`Section 40 Added — The Recap Is Addressable, And Every Run Starts From Memory (2026-11-25)`

_Appended 2026-11-25 at the owner's direction ("when he recaps on idle make it say what he learned from
and points and logg to his mem so he gets smarter and smarter from mistakes"; "each recap will have id # to
go stright to for issues in mem"; "make him when starting task cycle threw his memorys 1st for the task to
get done faster if previous mem are present"; "the mem bar up top in right tui add heath ratio green red for
bad good slipping getting smarter by the sec"). Nothing above this line was rewritten, reordered or
removed. Backups: `AGENTS.md.bak-20261125T153000Z (45,602 B, size-verified)`; master-rulebook
`CLAUDE.md.bak-20261125T153000Z (68,401 B, size-verified)`._

`/home/ghost/CLAUDE.md` is **§1–§40**. §40 is **"The Recap Is Addressable, And Every Run Starts From
Memory"**. What it makes binding here:

1. **The idle recap says what was learned, from what, and the points.** `learned N from M errors` (or
   `from M ok`), the ✦ point total, and the outcome — counted from the meter and the server's own
   consolidation events (`cli/ui/src/components/Recap.jsx`, `useAgentStream.js`).
2. **Every recap has an id, and that id points into memory.** A per-run `#a3f9k2` is shown on the recap
   row, written into every memory entry the run files (tag + text) plus a keyed record, and readable with
   `/recap [#id]` → `GET /api/agent/recap/<id>`. `/recap` alone reports the last id
   (`cli/ui/src/App.jsx` case `/recap`, `MenuPalette.jsx`).
3. **Mistakes become errors, the run becomes a lesson.** `POST /api/agent/session-summary` files up to
   five distinct failures as `error` memories and the run as a `lesson` (`pattern` when clean); a run with
   no tool calls writes nothing (`server/src/agent/autolearn.js` `buildRecapMemories`/`recordRecap`).
4. **Memory first.** Before the first model call the task text is scored against raw entries, the banks
   and the keyed notes; up to four mistakes and four lessons are placed above the machine context with a
   do-not-repeat instruction, and the recall is announced on the stream with its own counts
   (`buildMemoryFirstBlock` in `server/src/index.js`, `memory_recall` event).
5. **The memory-bar health ratio is measured.** Share of the last 90 s of metered tool calls that worked
   (green ≥ 80 %, amber ≥ 60 %, red below) plus ▲ smarter / ▼ slipping / ◆ steady from that window's own
   movement; empty window reads the score and says steady (`meter.health()` in `cli/smartness.mjs`,
   header ◈ bar in `cli/ui/src/App.jsx`).
6. **HaksterAI only.** Nothing here writes into Junkalot, PhantomIDE or another project (§16, §38.8).
   Pinned by `cli/ui/__tests__/recap-memory.test.mjs` and `meter.test.mjs`.


---

## Session Log — 2026-11-26 (CLI latency, streaming, addressable recap, memory-DB exact restore)

_Appended at the end of this file; nothing above was rewritten, reordered or removed.
Backup before this append: `AGENTS.md.bak-20261125T200821Z` (48905 B, size-verified)._

### 1. CLI latency — no config, route, model or rate touched
- **Byte-stable system prompt.** `buildAgentSystemPrompt()` embedded `Project inventory generated
  <ISO timestamp>`, so every rebuild changed bytes and blew the ~24k-token prompt cache. The stamp is
  gone from the prompt path; the prompt now builds in **136 ms (was ~2.5 s)** and is cache-stable.
- **Memory write-on-read removed.** `getMemoryContext()` bumped `updated_at` on every read, so its own
  ordering reshuffled each call and every age read "just now" — a second cache-killer. Reads no longer
  write; relative ages are rendered, not stored.
- **Duplicated steering removed on the `claude-cli` lane.** The spawned `claude` already loads
  `haksterAi/CLAUDE.md` (byte-identical to `haksterAi/AGENTS.md`, sha256 `0c7af095…`), so the lane was
  sending the same 48.9 KB twice. `buildAgentSystemPrompt()` gained a `steering` mode whose cache key
  includes it; the lane now appends only the master `/home/ghost/AGENTS.md` head.
  Lane prompt **94,882 → 58,889 chars (−38 %, ~9,000 tokens/turn)**; RULE #0, the CineVault roster and
  IPTV authorization all retained. Pinned by `server/__smoke__/prompt-steering-probe.mjs` (12 checks).

### 2. The `claude-cli` lane streams instead of buffering
- It called the blocking `claudeCliComplete()` and emitted the whole answer as one delta — 11.3 s of
  dead air, then everything at once. Added `claudeCliStream()`
  (`--output-format stream-json --include-partial-messages`); `chatStream` yields text as it arrives and
  falls back to the blocking call only when a lane yielded nothing (a lane that streamed is never
  re-run, so an answer cannot print twice). Token counts now come from the CLI's own usage.
- Measured on the real lane: **first token 1.99 s**, total 2.51 s (was 2.89 s of silence then the whole
  answer). No model, route, provider, plan or allowance changed.

### 3. The idle recap is full and its ids are addressable
- New `cli/ui/src/components/RecapPanel.jsx`: the full recap while idle at the bottom, on the row the
  spinner vacates — run id, what the run was, its mistakes, counted tools/learned/points/mem, session
  totals, and the session's recap ids with `/recap #id`. Takes only rows the transcript can spare
  (never below 4), so a short terminal keeps the one-row receipt and no other panel moves.
- Two defects made `#id` point nowhere and are fixed: `recap` was missing from `CATEGORIES` in
  `server/src/memory.js` (every keyed write threw and was swallowed), and when a run's entry deduped
  into an earlier one the new run's id tag was dropped with it (`autolearn.js` now merges ids, bounded
  to the 8 newest).

### 4. `data/hakster.db` — corruption cause and exact restore ("no diff")
- **Symptom:** `integrity_check` → `database disk image is malformed`; every `saveMemory` and recall
  threw, so the agent had no long-term memory.
- **Cause, proven from the file:** the live server (pid 359024) held `hakster.db-wal` (4.2 MB, inode
  21576729) and `-shm` **already unlinked**, while the on-disk `-wal` was a different inode
  (21579794, **0 bytes**, created 04:37). A `hakster.db.rebuilt-…` file at **04:25 is 0 bytes** and no
  tracked script writes that name — an ad-hoc "rebuild" step wrote nothing and the WAL/SHM were then
  replaced under the live connection. On top of that, **page 20 (the `memories` root) had its
  right-most child pointer overwritten with page 295**, an index leaf of `security_notifications`.
- **Restore, exactly:** the 4.2 MB unlinked WAL was still readable and was captured
  (`data/hakster.db-wal-rescue-<stamp>.bin`); its 563 current-generation frames were checksum-verified
  (little-endian WAL checksums) and its committed pages replayed over the main image. Page 20 was
  rebuilt as a valid interior page (children 106 key 12, 107 key 28, right-most 108). Every table was
  then extracted with exact storage classes and inserted into a fresh DB with the **original schema SQL
  byte-identical (102 objects)** and **exact rowids**.
- **Verified:** `integrity_check = ok`; **43/43 tables identical hash-for-hash** to the source
  snapshot; `sqlite_sequence` identical; **2,184 rows**; `memories` **33 rows, rowids 1–33**, 0
  differences against an independent raw b-tree walk; `journal_mode = wal`, page size 4096,
  user_version/application_id unchanged. A live `saveMemory` → `getMemory` → `searchMemories` →
  `deleteMemory` round-trip through the app's own engine succeeded and was removed again.
- **Installed** by atomic `os.replace`; corrupt original kept as
  `data/hakster.db.corrupt-<stamp>`; orphaned sidecars moved to `*.orphaned-<stamp>`. **No service was
  restarted and no CLI session was killed** — the running server keeps its old inode and picks the new
  file up on its next idle reload (§37, §45).
- **Open item:** the every-5-minute failover sync has been hashing an identical DB image across runs
  (a live WAL-mode DB that never changes ⇒ the snapshot ignores the WAL). It should read through the
  WAL (SQLite backup API) rather than copy the main file. Reported, not changed — it is a standby-copy
  defect, not a cause of this corruption.

---

## Section 46 Added — A Fallback Is Only A Fallback If The Run Path Can Run It (2026-11-26)

_Added: 2026-11-26, owner-directed ("add rule"). Backup before the edit:
`AGENTS.md.bak-20261125T230559Z` (54,377 B, sha256 `7209782…`, size-verified); master-rulebook backup
`CLAUDE.md.bak-20261125T230559Z` (86,412 B, sha256 `ccb72e4…`, size-verified). Nothing above this line was
rewritten, reordered or removed — this is an appended entry, exactly as the §35–§40 entries were._

`/home/ghost/CLAUDE.md` is now **§1–§46**. §46 is **"A Fallback Is Only A Fallback If The Run Path Can
Actually Run It — And A Lane Never Poisons Itself"**. What it makes binding here:

1. Every provider in `WATERFALL_ORDER` has a dispatch at every entry point that can hand it work, verified
   by `grep -c "<provider>" <entry point>` — 0 means it cannot run and must not be in the ladder.
2. A lane receives only the model it serves: the locked wire model is never forwarded into another
   provider's `-m`, and a foreign name resolves to empty so the provider uses its own default (§22 untouched).
3. `markProviderAuthDead` fires on a real provider auth rejection only. Our own HTTP-to-CLI wiring bug never
   disables a lane for 30 minutes; any disabled lane reports its provider, reason and duration.
4. A fallback is proven by one real call through its own binary before it is counted as redundancy.
5. No model, route, provider order, rate, plan or allowance moves (§19.3, §22.4, §26). HaksterAI only (§16).

Measured at adoption: `codex-cli` sits at **position 2 of 35** in `server/src/providers.js`
`WATERFALL_ORDER`, while `server/src/index.js` contains **zero** occurrences of `codex-cli` — the
`claude-cli` dispatch block exists (`if (cfg.type === 'claude-cli')`, ~line 5516) and codex has none — so the
agent path handed a CLI provider to a generic HTTP client, took a `401`, and `markProviderAuthDead` disabled
the lane. Separately the Ollama wire model was forwarded into `codex -m` (`model_not_found`), while
`codex exec` without `-m` answered fine. The dispatch fix is the next change; this rule sets the bar it must
meet.

---

## Section 47 Added — Every Safe Change Is Committed, And No Change Is A Setback (2026-11-26)

_Appended 2026-11-26 at the owner's direction ("always commit if safe and make project better rule no
setbacks"; "and never expose secrets"). Nothing above this line was rewritten, reordered or removed.
Backups taken and hash-verified before the edit: `CLAUDE.md.bak-20261125T232011Z` (93,311 B, sha256
`5a131439ca2f…`), `haksterAi/AGENTS.md.bak-20261125T232011Z` (56,528 B, sha256 `12a678a807dd…`)._

`/home/ghost/CLAUDE.md` is now **§1–§47**. §47 is **"Every Safe Change Is Committed, And No Change Is A
Setback"**. What it makes binding here:

1. **Commit in the session that made the change.** A real, verified, scoped change is committed before the
   session reports finished — never left as a working tree for the next session to rediscover (§28, §42.6).
   Four gates define safe: it is what the owner asked for (§3); the narrowest check passed (`node --check`,
   the probe, the build, the live health check); it is staged **by filename**, never `git add -A`/`.` (§8,
   §28.3); and the secret scan is clean (§31).
2. **No setbacks.** Every commit leaves the project equal or better on what is measured: tests and probes no
   fewer passing, services answering, the §38.5 latency bar no worse, both boxes on the same commit (§41). A
   change that removes working behaviour, disables a lane or hides a failure does not ship.
3. **Verified means measured against the thing it changes** — a named symptom and a before/after reading,
   or one real round-trip for a lane (§13). "It compiles" is not evidence.
4. **Unrelated dirt is left exactly as it was** — not committed, stashed, cleaned or reverted; stage by name
   and say in the report what was left alone (§8.4).
5. **A change that cannot be proven is reported, not forced** — committed on its code-level check, with the
   unrun check named by its exact command (§10, §13, §37, §45).
6. **A commit is not a deploy and never restarts anything** beyond the paths already armed (§37, §41, §45).
7. **Better, not busier** — the requested change done properly plus a loose end on the same path, never
   unrequested scope or a redesign dressed as an improvement.
8. **Never expose secrets** — nothing in a commit, diff, log, tarball, build note or report carries a key,
   token, cookie, `.env` value, portal credential or signed URL (§9, §23, §31). Findings are reported by
   key name only. A secret in a stage or in history is exposed: rotate, then the owner decides (§23.2).
9. **HaksterAI scope** — this project's own repository and its two boxes; nothing in it authorises a commit
   or a write into Junkalot, PhantomIDE or another project (§16).

---

## Section 48 Added — Every Commit Is Scanned For Secrets First (2026-11-26)

_Appended 2026-11-26 at the owner's direction ("add rule we check always before commiting for secrets etc").
Nothing above this line was rewritten, reordered or removed. Backups taken and hash-verified before the
edit: `CLAUDE.md.bak-20261125T232123Z` (93,907 B, sha256 `b25b8b14d1be…`), `haksterAi/AGENTS.md.bak-20261125T232123Z`
(59,289 B, sha256 `621288c8c508…`)._

`/home/ghost/CLAUDE.md` is now **§1–§48**. §48 is **"Every Commit Is Scanned For Secrets First — Always,
And Before It Lands"**. What it makes binding here:

1. **One scanner, every layer.** `~/bin/secret-scan.sh` sits behind this repo's `.git/hooks/pre-commit`
   (`--staged`), its `pre-push` (`--commits <range>`, which blocks the push), and the global `~/.git/hooks/`
   pair covering every other repository on the box. `--tree` / `--at REV` sweep a whole tree; `--deep` also
   matches the live values in `~/.secrets.env` by value, so an unknown key format is still caught.
2. **Shape only, never the value.** Output is `file:line` and the rule name; a finding is reported by rule
   name and path only (§9, §23, §31).
3. **Named hard rules** — `private-key`, `anthropic`, `openrouter`, `openai`, `groq`, `nvidia`, `google`,
   `aws`, `github`, `slack`, `stripe`, `telegram`, `cftunnel`, `dburl`, `jwt` — fail the commit; `bearer` and
   `assignment` warn, and `--strict` makes them fail too.
4. **"Clean" can mean filtered.** The placeholder noise list (`example`, `dummy`, `changeme`,
   `process.env`, `<var>`, …) skips lines on purpose — `AKIAIOSFODNN7EXAMPLE` scans clean for that reason.
   Confirm against the rule that should have matched; never widen the list to silence a finding.
5. **Scan before committing, not after.** Stage by filename (§8, §28.3, §47.1), then run
   `~/bin/secret-scan.sh --staged` and read the exit code (0 clean, 1 findings, 2 usage error). Use
   `--commits <range>` before a push and `--tree --deep` before packing or publishing (§28, §42). The hooks
   fail open and `.git/hooks` is unversioned (§41.2), so a gate that never ran is not evidence (§13).
6. **A finding stops the commit** — unstage, move the value to `~/.secrets.env` (mode 600, via
   `/home/ghost/bin/secret-add`, §23) or an untracked `.env`, use `process.env.NAME`, rescan.
7. **Committed means exposed** — rotate, and the owner decides the history scrub; never a quiet deletion
   (§23.2, §31.5). `--no-verify` is for a confirmed false positive only, and the allow list stays empty
   unless a match is proven to be a placeholder or public fixture.
8. **Nothing here moves the setup** — no model, route, provider order, rate, plan or allowance changes
   (§19.3, §22.4, §26). It covers every project we serve; this project's scanner and hooks are the reference
   (§16).

Verified at adoption: a throwaway repo with the real hook installed refused a `ghp_…`-shaped fixture
(`1 hard`, exit 1, no commit object created) and committed cleanly once the line became
`process.env.GITHUB_TOKEN`; `--staged` clean at HEAD; no active allow-list exemptions.

---

## Section 49 Added — Never Break What Works, And Never Run Destructive Git (2026-11-26)

_Appended 2026-11-26 at the owner's direction ("add rule to never break or git again"). Nothing above this
line was rewritten, reordered or removed. Backups taken and hash-verified before the edit:
`CLAUDE.md.bak-20261126T011212Z` (98,480 B, sha256 `9476efe4…`), `AGENTS.md.bak-20261126T011212Z`
(62,446 B, sha256 `899dc420…`)._

`/home/ghost/CLAUDE.md` is now **§1–§49**. §49 is **"Never Break What Works, And Never Run Destructive Git"**.
What it makes binding here:

1. **Never break a working thing to fix a neighbouring thing.** Smallest patch for the reported failure;
   no refactor, reconfigure, disable or restart of a healthy service, route, panel or file as a side effect.
   If it cannot be done without risking something that works, stop and report (§2.8, §11).
2. **Git is append-forward, never destructive.** Allowed: inspect, stage **by filename**, commit a verified
   scoped change, push when asked. Never without an approval naming the exact command and target:
   `reset --hard`, `reset` that drops staged work, `clean -fd`/`-fdx`, `push --force`,
   `rebase`, `checkout -- .` / `restore .`, `stash drop`/`clear`, branch delete, tag rewrite,
   `filter-branch`/`filter-repo`, any history rewrite. `--no-verify` only for a confirmed false positive
   (§48.8).
3. **A git mistake is fixed forward, never by rewriting** — a new commit that says what it corrects; a value
   that reached history is rotated and the owner decides the scrub (§8, §23.2, §31.5).
4. **Unrelated dirt is left exactly as it was** — not committed, stashed, cleaned or reverted; stage by name
   and say what was left alone (§8.4, §47.4).
5. **Verified means nothing regressed** — narrowest check before and after, with the reading shown: tests no
   fewer passing, services answering, page still serving our build, both boxes on the same commit (§13, §41,
   §47.2–§47.3). A change that removes working behaviour does not ship.
6. **A restart is not a fix** — never bounce or kill a process to make a number look better (§0, §37, §45).
7. **Config and brain files are never fixed in passing** — report drift read-only; never edit `~/.claude/**`,
   `~/.ollama/**`, dotfiles, tunnels, the pm2 registry or a brain file to diagnose (§0, §17, §22).
8. **HaksterAI scope** — this repository and its two boxes; nothing here authorises a write into Junkalot,
   PhantomIDE or another project (§16).

Evidence at adoption: both brain files backed up and hash-verified before this append; the working tree held
only this change's files plus pre-existing untracked dirt, left untouched (§47.4).

---

## Section 50 Added — No Setbacks, No Fumbles (2026-11-26)

_Appended 2026-11-26 at the owner's direction ("add rule no setbacks or fumbles please eveer no more").
Nothing above this line was rewritten, reordered or removed — an appended entry, exactly as §35–§49 were.
Backups taken and hash-verified before the edit: `CLAUDE.md.bak-20261126T012302Z` (102,304 B, sha256
`b02d38f7…`), `AGENTS.md.bak-20261126T012302Z` (65,164 B, sha256 `60715b96…`)._

`/home/ghost/CLAUDE.md` is now **§1–§50**. §50 is **"No Setbacks, No Fumbles — Ever, No More"**. §47 forbade
setbacks; §50 forbids the fumble — the "done" with no reading behind it. What it makes binding here:

1. **A change is finished only when a command showed it working on the surface the user meets** — the
   installed copy, the served package, the public door, the running process — never the edited file or the
   local build (§10, §13, §47.3).
2. **Verify the delivery path, not just the source.** Source → bundle → package → served build → installed
   copy drops changes silently: a bundled module (`cli/src/prefs.js` → `ui-fb.mjs`) is not edited until it is
   rebuilt, and a served file is not updated until every backend answering for it carries it (§38.6, §41,
   §42, §43).
3. **Two strikes, then change the approach** — never a third variation of an attempt that already failed
   (§49.1).
4. **A fumble already made is reported plainly**, with what broke and what fixed it — no quietly tidy story
   (§13).
5. **Nothing regresses to look finished**, and nothing ends without an explicit outcome (VERIFIED /
   PARTIALLY VERIFIED / BLOCKED / FAILED / NOT STARTED).
6. **Applies to every project, agent and session** (§16), and moves no model, route, provider order, rate,
   plan or allowance (§19.3, §22.4, §26). It is a standard of work, not a feature.

---

## CLI Skins / Layout Menu — recorded direction (2026-11-26)

_Appended 2026-11-26 at the owner's direction ("eventually we will build skins / menu for switching cli
layout etc"; "add to our mds mem"). Backup before the append: `AGENTS.md.bak-20261126T024031Z` (67,049 B, sha256
`a6825e11…`). Nothing above this line was rewritten, reordered or removed. A direction, not a numbered rule
until the owner says so; master entry in `/home/ghost/CLAUDE.md` under the same date._

- **Wanted:** switchable CLI skins plus a menu to pick a layout (startup card, transcript, panels), chosen at
  runtime and remembered between sessions. The current card stays the default skin.
- **Build on what exists:** theme the `frameBox()` bands in `cli/logo.js` and the callers in `cli/ui.js` —
  never a parallel renderer, so width and narrow-terminal fallbacks keep holding.
- **Still holds:** no model, route, provider, rate, plan or allowance moves (§19.3, §22.4, §26); the locked
  config and the checklist rails stay truthful in every skin (§35, §38.1, §10).
- **Status: NOT STARTED** — direction saved; working note in `cli-skins-menu-planned.md`.

---

## Session Log — 2026-11-26 (steer never interrupts · killing 2 birds 1 stone · quickskill)

_Appended at the end of this file at the owner's direction ("fix our steer to not interupt you but you
still grab message beore your run to kill 2 birds 1 stone add that phrase to ours killing 2 birds 1
stone wired in the right place when knocking 2 thing out at once get it"; "and add skills playbook were
we can make qickskill from what we learn"). Nothing above this line was rewritten, reordered or removed.
Backups taken and hash-verified identical before the append: `CLAUDE.md.bak-20261126T035840Z` (108026 B, sha256
`6aaa96c6d9a7…`), `haksterAi/AGENTS.md.bak-20261126T035840Z` (68205 B, sha256 `26b47e65bb85…`)._

### 1. The steer never interrupts a run — it is drained at the boundary

Amends the mechanism §38.4 described. On 2026-11-25 a steer typed mid-run was taken by **cutting the
live answer** (abort the stream, retract the partial, regenerate the turn) so it couldn't be handed to
`claude -p`, which reads its prompt once. The owner changed the requirement on 2026-11-26: *"fix our
steer to not interupt you but you still grab message beore your run"*.

So steering is now taken **only at natural boundaries** and never cuts what the operator is watching:

- **standard lane** (`/api/agent/run`): the stream loop reads **nothing** from the steer inbox — no
  abort, no retraction, no regeneration. The inbox is drained at the top of the next turn (before the
  next model call) and again at run end, where a steer the run never reached keeps the run alive
  instead of closing it (`steer_undelivered` is the fallback when it still cannot be delivered).
- **`claude-cli` lane**: the child runs to completion and `takeSteerAtBoundary()` drains the inbox
  **after** the turn closes; the `steerPoll` that SIGTERM/SIGKILLed the child is gone, and the turn
  resolves with `steered`. A non-zero exit without an answer is now a real failure, not "stopped for
  a steer".
- The TUI records a non-supersede steer as a marker round and **keeps the delivered text**; only a
  legacy `supersede` event (older servers) still retracts the round being written.

Pinned by `server/__smoke__/mid-stream-steer-probe.mjs` — **7 checks**, including that the stream
loop never reads the inbox, the poll/kill path is gone, the boundary drain consumes (so it can't
apply twice), and the TUI's transcript survives. Verified 2026-11-26: 7/7 pass; `cli` suite
**310/310** pass; `node --check` clean on `server/src/index.js` and `server/src/agent/autolearn.js`.

### 2. "Killing 2 birds 1 stone" — the phrase, wired where one action does two things

Owner: *"add that phrase to ours … wired in the right place when knocking 2 thing out at once"*. It is
recorded here as our own phrase for **one action that settles two things at once**, and it lives at the
exact places that do it — never as decoration:

- `server/src/index.js` — the boundary-drain comments (standard lane and `claude-cli`) name it: the
  delivered answer survives **and** the update still reaches the model inside the same run.
- `cli/ui/src/hooks/useAgentStream.js` — the applied-steer activity row reads
  `↳ live steer applied · killing 2 birds 1 stone — answer kept, update delivered`, so the operator
  sees both wins in one line instead of a claim that the reply restarted.
- `server/__smoke__/mid-stream-steer-probe.mjs` — asserts the row still names both things, so the
  phrase cannot drift into a promise the code no longer keeps.

Use it when the work really does two jobs in one pass (a drain that both preserves the answer and
delivers the update). Do not use it to describe two separate steps done in a row.

### 3. Skills playbook — a quickskill from what we learn

Owner: *"add skills playbook were we can make qickskill from what we learn"*. Built as a working
capture path, not just a document:

- **Playbook:** `docs/agent/skills-playbook.md` — what a skill is, the two ways one gets written
  (auto-extraction at 3+ recurrences; deliberate capture), what qualifies (measured only), the file
  shape, and the rules that hold for every capture.
- **Capture:** `POST /api/agent/quickskill` (`server/src/index.js`) writes
  `~/.hakster/skills/<slug>.md` + its `index.json` row — the same bank and index
  `extractSkill` uses (`autolearn.SKILLS_DIR`, now exported). It files the recap's own **mistakes**
  and **lessons** plus the operator's note, **refuses** a capture with nothing learned (no recap and no
  note), **appends** a dated section instead of overwriting an existing skill, keeps the first
  capture's recap/description through the merge, slugs the name so it cannot escape the bank, and
  invents no confidence score (§10, §13, §50.1).
- **CLI:** `/quickskill <name>` (bare = the last recap) and `/quickskill <name> :: your note`; listed
  in `/help` and the `^P` palette.
- **Probe:** `server/__smoke__/quickskill-probe.mjs` — **6 checks** that slice the **real handler**
  out of `server/src/index.js` and run it against a temp bank (refusal, content, append, slug, index).
  Verified 2026-11-26: 6/6 pass.

Nothing here moves a model, route, provider order, rate, plan or allowance (§19.3, §22.4, §26), and
nothing is written into Junkalot, PhantomIDE or another project (§16). CLI version **0.3.94**,
`ui-fb.mjs` rebuilt from source (§50.2 — a bundled module is not edited until it is rebuilt).
