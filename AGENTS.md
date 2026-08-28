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
