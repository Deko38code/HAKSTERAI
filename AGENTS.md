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

### Loop Break Mechanisms (14 total)

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

## Tool Usage Guidelines

### Available MCP Tools

- **filesystem** — Read, write, list files on /home/ghost
- **nmap** — Network scanning and port detection
- **playwright** — Browser automation (see Playwright Skills below)
- **sqlite** — Queries on /home/ghost/haksterAi/data/mcp.db
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