# Agent Navigation Map

A lookup-first index for AI agents (and humans) working in the HaksterAI codebase.
Tell the agent **what** they want to do, and this map tells them **where to go** —
file path, line number, and what already exists there.

This is a companion to the other docs in `docs/agent/`. Those docs describe
**how** agents should behave. This doc describes **where** the code lives.

> Line numbers reflect the state of the repo at the time of writing. Code moves;
> when a line number drifts, use the function/symbol name as the primary anchor
> and `rg -n "symbol" path` to relocate it.

---

## 1. Repository Shape

```
haksterAi/
├── cli/                          # CLI frontend (user-facing REPL, providers, tools, UI, memory)
│   ├── index.js          1876     # Main CLI entrypoint: commander setup, chat REPL, slash commands
│   ├── providers.js       591     # Provider selection, ollama auto-start, unified provider entry
│   ├── tools.js          1270     # Tool parsing, tool execution, persistent shell, tool schemas
│   ├── ui.js             1107     # Terminal rendering: thinking animation, reasoning grid, banner, team
│   ├── memory.js          751     # Memory store: USB sync, trust config, knowledge base, machine profile
│   └── logo.js             68     # ASCII banner / intro display
├── server/
│   └── src/
│       ├── index.js               # (server) HTTP API, SSE streaming, /api/agent/run
│       └── agent/
│           ├── index.js  7029     # Main server agent loop (tool execution, dangerous-command gate)
│           ├── loop.js    500     # Phase state machine, consolidation, reflection, AGENTS.md injection
│           ├── autolearn.js 599    # Memory init, consolidation, skill extraction, auto-init
│           ├── approval.js  37     # Confirmation gates for dangerous actions
│           └── mcp.js      439     # MCP server bridge
├── docs/agent/                    # This directory — markdown brain for agents (see §10)
├── .hakster/                      # Runtime memory + extracted skills (created at runtime)
└── package.json
```

Total source: ~14,267 lines across 11 files. CLI side: ~5,663 lines. Server side: ~8,604 lines.

---

## 2. "I want to…" — Lookup Table

Use this first. Find the task, go to the listed file:line.

| I want to… | Go to | What's there |
| --- | --- | --- |
| Add a CLI flag to `chat` (e.g. `--thinking`) | `cli/index.js:444` | `chat` commander command + options block |
| Add a new slash command (`/foo`) | `cli/index.js:504` | `handleSlashCommand(text)` switch |
| Change which provider is picked first | `cli/providers.js` `PROVIDER_ORDER` | Top of file, ollama is `[0]` |
| Change the default Ollama model | `cli/providers.js` `DEFAULT_OLLAMA_MODEL` | `process.env.OLLAMA_MODEL \|\| 'glm-5.2:cloud'` |
| Auto-start Ollama if not running | `cli/providers.js:364` | `ensureOllamaAvailable()` |
| Get a provider descriptor (unified entry) | `cli/providers.js:482` | `ensureProviderAvailable({name?, config?, autoStart?})` |
| Inject a system prompt into the agent loop | `cli/index.js:262` | `offlineAgentLoop(history, sysPrompt, opts)` |
| Change how the LLM request body is built | `cli/index.js:210` | `offlineLLMCall(messages, opts)` |
| Change the thinking phase prompts | `cli/ui.js:36` (`PHRASES`) | Phase-keyed phrase bank |
| Change the thinking animation visuals | `cli/ui.js:97` | `thinkingAnimation(modelHint, phase)` |
| Render a boxed reasoning window | `cli/ui.js:182` | `renderReasoningWindow({title, intro, cards, footer})` |
| Render live reasoning cards from thinking text | `cli/ui.js:211` | `showThinkingGrid(thinking)` |
| Parse step-by-step reasoning from text | `cli/ui.js:221` | `showReasoningGrid(text)` |
| Render markdown in the terminal | `cli/ui.js:277` | `renderMarkdown(text)` |
| Display a token-usage bar | `cli/ui.js:243` | `showTokenBar(history)` |
| Display the team / workflows | `cli/ui.js` (beyond :400, `AGENT_TEAM`, `TEAM_WORKFLOWS`) | Referenced from `cli/index.js:707` |
| Add a new tool the agent can call | `cli/tools.js:1` exports + `TOOL_DEFINITIONS` | Tool schema + executor |
| Parse tool calls out of model output | `cli/tools.js` `parseTools(text)` | Exported |
| Execute a parsed tool call | `cli/tools.js` `execTools(tools, trustCfg, rl)` | Exported |
| Run a shell command with a persistent cwd/env | `cli/tools.js:51` | `PersistentShell` class |
| Change the agent loop phase state machine | `server/src/agent/loop.js` (top) | `AgentLoopPhase` enum, `loopPhaseTransitions` |
| Add THINK-phase behavior | `server/src/agent/loop.js` (THINK phase handling) | First phase in the machine |
| Inject AGENTS.md into the system prompt | `server/src/agent/loop.js` `injectAgentsMd(cwd)` | Walk-up discovery with mtime cache |
| Inject learned lessons | `server/src/agent/loop.js` `injectLearnedLessons(cwd, contextTags)` | Memory injection, 2000-char budget |
| Trigger memory consolidation | `server/src/agent/loop.js` `shouldConsolidate(state)` | 25-turn interval or 10+ raw memories |
| Trigger reflection on no-progress | `server/src/agent/loop.js` `shouldReflect(state)` | 3 consecutive no-progress turns |
| Manage trust escalation levels (0-9/10-29/30+) | `server/src/agent/loop.js` `trustEscalation` | SUGGEST / AUTO_EDIT / FULL_AUTO |
| Auto-init memory + lessons on session start | `server/src/agent/autolearn.js` `autoInit(process.cwd())` | Loads AGENTS.md + MEMORY.md + summary |
| Extract a skill from repeated patterns | `server/src/agent/autolearn.js` (skill extraction) | Fires when a pattern appears 3+ times |
| Confirm a dangerous command | `server/src/agent/approval.js` | 37-line confirmation gate |
| Talk to an MCP server | `server/src/agent/mcp.js` | MCP bridge |
| Run the full server agent loop (HTTP entry) | `server/src/agent/index.js` | 7029-line main loop, tool execution, loop breaks |
| Save memory across sessions | `cli/memory.js` (751 lines) | USB sync, trust config, knowledge |
| Sync a USB drive | `cli/memory.js` `findAllUSBs` (imported by ui.js) | USB sync commands wired through `/usb` slash cmd at `cli/index.js:674` |
| Encode/decode base64/hex/url/rot13/binary | `cli/index.js:846` / `:889` | `/encode` and `/decode` slash commands |
| Run a one-off shell command from CLI | `cli/index.js:812` | `/run` slash command, 30s timeout |
| Print the banner | `cli/logo.js` (68 lines) + `cli/ui.js` `printBanner` | Called from chat command |

---

## 3. Data Flow — User Input → Response

```
User types in terminal
        │
        ▼
cli/index.js  — commander parses argv
        │
        ├── `chat` command (cli/index.js:444)
        │       │
        │       ├── autolearn.autoInit(cwd)         ← server/src/agent/autolearn.js
        │       │       loads AGENTS.md + MEMORY.md + summary into system prompt
        │       │
        │       ├── providers.ensureProviderAvailable({name, autoStart})
        │       │       (cli/providers.js:482)
        │       │       → returns {name, url, apiKey, model, type}
        │       │       → ollama: ensureOllamaAvailable() auto-starts `ollama serve`
        │       │
        │       ├── mem.loadTrust()                ← cli/memory.js
        │       │
        │       ├── ui.printBanner()               ← cli/ui.js
        │       │
        │       └── readline REPL  (prompt: "ghost@hakster>")
        │               │
        │               ├── handleSlashCommand(text)  (cli/index.js:504)
        │               │       /exit /quit /clear /help /tools /mcp /models
        │               │       /memory /trust /providers /fallbacks /usb
        │               │       /team /status /ls /cat /run /history
        │               │       /encode /decode
        │               │
        │               └── normal message → offlineAgentLoop(history, sysPrompt, opts)
        │                       (cli/index.js:262)
        │                       │
        │                       └── loop (max 30 rounds):
        │                              offlineLLMCall(messages, opts)   (cli/index.js:210)
        │                              → builds OpenAI-compatible body
        │                              → POST to provider url
        │                              → handles OpenAI / Anthropic / Gemini response shapes
        │                              │
        │                              tools.parseTools(response)      ← cli/tools.js
        │                              tools.execTools(tools, trustCfg, rl)
        │                              │   ├── PersistentShell.run(cmd)  (cli/tools.js:51)
        │                              │   ├── isTrusted(path, cfg)      (cli/tools.js:186)
        │                              │   └── askYN(question)           (cli/tools.js:193)
        │                              │
        │                              feed tool results back into history
        │                              repeat until no tool calls or max rounds
        │
        └── (other commands: config, ls, download, health, status — cli/index.js:314+)


Server path (when using server mode, not --local):
        POST /api/agent/run  →  server/src/index.js  →  server/src/agent/index.js
        6-phase loop (server/src/agent/loop.js):
            THINK → PLAN → ACT → OBSERVE → REFLECT → CONSOLIDATE
        Tool execution + dangerous-command gate + 14 loop-break mechanisms
        SSE events streamed back to CLI/UI
```

---

## 4. Provider Selection — Internal Waterfall

```
ensureProviderAvailable({name?, config?, autoStart?})     cli/providers.js:482
        │
        ├── if name === 'ollama':
        │       ensureOllamaAvailable()                  cli/providers.js:364
        │         ├── isOllamaOnline()  GET /api/tags    cli/providers.js:351
        │         └── if down: nohup ollama serve
        │       return {name:'ollama', url, apiKey:'', model, type:'local'}
        │
        ├── if name given (not ollama):
        │       buildProviderDescriptor(name, cfg)        cli/providers.js:288
        │       return {name, url, apiKey, model, type}
        │
        └── if no name given:
                getBestProvider(config)                   cli/providers.js:305
                  pass 1: skip slow + failed providers
                  pass 2: allow slow providers
                  last resort: any provider with a key
                return descriptor or null

Constants (top of cli/providers.js):
  PROVIDER_ORDER         = ['ollama', ...]                # ollama first
  LOCAL_PROVIDERS_ORDER  = ['ollama', ...]
  CLOUD_PROVIDERS        = [...]
  PROVIDER_ENDPOINTS     = { ollama: 'http://localhost:11434/v1/chat/completions', ... }
  NO_KEY_PROVIDERS       = Set{ 'ollama', ... }
  PROVIDER_TYPE          = { ollama: 'local', ... }
  DEFAULT_OLLAMA_MODEL   = process.env.OLLAMA_MODEL || 'glm-5.2:cloud'
```

---

## 5. Agent Loop Phase Machine (server/src/agent/loop.js)

```
 AgentLoopPhase enum:
   THINK        = 0
   PLAN         = 1
   ACT          = 2
   OBSERVE      = 3
   REFLECT      = 4
   CONSOLIDATE  = 5

 loopPhaseTransitions (directed edges):
   THINK       → PLAN
   PLAN        → ACT
   ACT         → OBSERVE
   OBSERVE     → REFLECT | THINK
   REFLECT     → CONSOLIDATE | THINK
   CONSOLIDATE → THINK

 Triggers:
   shouldConsolidate(state)   →  every 25 turns OR 10+ raw memories
   shouldReflect(state)       →  3 consecutive no-progress turns
   Self-recursion limit       →  10 consecutive THINK→PLAN without ACT

 Injectors:
   injectAgentsMd(cwd)            →  walks up to find AGENTS.md, mtime-cached
   injectLearnedLessons(cwd, tags) →  pulls from .hakster/MEMORY.md, 2000-char budget

 Trust escalation:
   trustEscalation = { SUGGEST: 0-9, AUTO_EDIT: 10-29, FULL_AUTO: 30+ }
   trust increases on verified actions, resets on destructive-action denial
```

**Where to patch thinking/reasoning features into the loop:**
- THINK phase prompt enrichment → `server/src/agent/loop.js` (THINK handler)
- Goal mode success criteria → THINK phase
- Upfront plan display → THINK→PLAN transition + emit a UI event
- Reflection on no-progress → `shouldReflect()` + REFLECT phase
- Memory budget for thinking context → `injectLearnedLessons` budget (2000 chars)

---

## 6. UI / Thinking Display (cli/ui.js)

Already-existing infrastructure for showing reasoning in the terminal:

| Symbol | Line | Purpose |
| --- | ---: | --- |
| `PHRASES` | 36 | Phase-keyed phrase bank (THINK/PLAN/ACT/OBSERVE/REFLECT/CONSOLIDATE/DEFAULT) |
| `thinkingAnimation(modelHint, phase)` | 97 | Animated spinner, phase-colored, returns timer with `updateModel`, `updatePhase`, `updateActivity`, `stop` |
| `renderReasoningWindow({title, intro, cards, footer})` | 182 | Boxed reasoning card display, purple border, neon-green accents, 66-char width |
| `showThinkingGrid(thinking)` | 211 | Render live reasoning cards from thinking text |
| `showReasoningGrid(text)` | 221 | Parse step patterns from text, render as reasoning cards |
| `showTokenBar(history)` | 243 | Token usage bar, color-coded green/yellow/red |
| `listFallbacks()` | 256 | Render fallback model list (string version in providers.js:529) |
| `renderMarkdown(text)` | 277 | Terminal markdown renderer: code blocks, headings, bullets, purple borders |
| `showHelp()` | 341 | Slash command help |
| `printBanner` | (beyond 400) | Banner display — also see `cli/logo.js` |
| `AGENT_TEAM` | (beyond 400) | Team role list — referenced from `cli/index.js:707` (`/team`) |
| `TEAM_WORKFLOWS` | (beyond 400) | Workflow list — referenced from `cli/index.js:707` |

**Phase colors (already wired):**
- THINK = bright blue (#75)
- PLAN = purple (#141)
- ACT = green (#118)
- OBSERVE = cyan (#81)
- REFLECT = orange (#215)
- CONSOLIDATE = gold (#220)

**Where to patch thinking output:**
- Add an "effort level" indicator → extend `thinkingAnimation()` or add a sibling
- Add dimmed/cyan chain-of-thought stream → extend `showReasoningGrid()` or add a sibling
- Add upfront-plan display before execution → call `renderReasoningWindow()` with the plan
- Add interrupt support → `thinkingAnimation().stop()` + new render on interrupt

---

## 7. CLI Tools Layer (cli/tools.js)

| Symbol | Line | Purpose |
| --- | ---: | --- |
| `parseTools` | exported | Parse tool calls out of model text output |
| `stripTools` | exported | Remove tool-call blocks from text |
| `stripFences` | exported | Strip code fences |
| `stripHtmlArtifacts` | exported | Strip HTML artifacts |
| `isReasoningText` | exported | Detect reasoning text (for filtering) |
| `cliExecuteTool(name, args, trustCfg)` | exported | Execute a single tool |
| `execTools(tools, trustCfg, rl)` | exported | Execute a batch of parsed tools |
| `TOOL_DEFINITIONS` | exported | Tool schema catalog |
| `PersistentShell` | 51 | Class: maintains cwd, env, aliases across commands |
| `runCmd(cmd, cwd)` | 144 | Execute via persistent shell, 30s timeout |
| `runCmdStream(cmd, cwd)` | 149 | Streaming output, 120s timeout, spawns bash |
| `resolveTaskPath(inputPath)` | 174 | Path resolution: absolute / home / CLI root / relative |
| `isTrusted(filePath, cfg)` | 186 | Trust check against configured trusted paths |
| `askYN(question)` | 193 | Yes/no prompt via readline |

Tool definitions and executors live beyond line 200 — see file for the full `TOOL_DEFINITIONS` catalog.

---

## 8. Memory Layer (cli/memory.js)

Imported by `cli/ui.js` (see import block at top of ui.js):
- `findAllUSBs` — enumerate USB drives for sync
- `loadMemory` — load memory store
- `memGetNotes` — get notes
- `getMemoryText` — get raw memory text
- `getKnowledge` — get knowledge base
- `getKnowledgeTrimmed` — get knowledge base with token budget
- `getMachineProfile` — detect machine profile (OS, browser, device)
- `formatMachineProfile` — render machine profile for display
- `scanGitRepos` — scan for git repos
- `formatRepoAwareness` — render repo awareness for display
- `estTokens` — estimate token count

Trust config is loaded via `mem.loadTrust()` in `cli/index.js` chat command.

Slash commands that touch memory:
- `/memory add` (cli/index.js:588)
- `/memory clear` (cli/index.js:605)
- `/memory list` (cli/index.js:~600)
- `/trust add|remove|list` (cli/index.js:625)
- `/usb sync|status` (cli/index.js:674)

---

## 9. Patch Point Registry — GPT-5.5 Thinking Features

For each feature, the primary file:line to patch (additive only — never delete):

| Feature | Primary patch point | Secondary patch points |
| --- | --- | --- |
| Thinking effort levels (Light/Standard/Extended/Heavy) | `cli/index.js:444` (add `--thinking` flag to `chat` cmd) | `cli/providers.js` prompt config; `server/src/agent/loop.js` THINK phase |
| Upfront thinking plan display | `server/src/agent/loop.js` THINK→PLAN transition | `cli/ui.js:182` `renderReasoningWindow()`; `cli/ui.js:211` `showThinkingGrid()` |
| Chain-of-thought reasoning display | `cli/ui.js:221` `showReasoningGrid()` | `cli/index.js` SSE handling (beyond :900); `cli/ui.js` `PHRASES` (add effort variants) |
| Interrupt mid-response | `cli/index.js:494` readline interface | `cli/ui.js:97` `thinkingAnimation().stop()`; SSE stream handler (beyond :900) |
| Fast answers mode | `cli/index.js:444` (add `--fast` flag) | `cli/providers.js:305` `getBestProvider()` model selection |
| Goal mode + success criteria | `server/src/agent/loop.js` THINK phase | `cli/index.js:444` (add `--goal` flag) |
| Model picker with thinking modes (Instant/Thinking/Pro) | `cli/providers.js:305` `getBestProvider()` | `cli/providers.js` `DEFAULT_OLLAMA_MODEL` |
| Thinking animation effort indicator | `cli/ui.js:97` `thinkingAnimation()` | `cli/ui.js:36` `PHRASES` (add effort variants) |
| System-prompt thinking enrichment | `cli/index.js:262` `offlineAgentLoop(history, sysPrompt, opts)` | `server/src/agent/loop.js` `injectAgentsMd` / `injectLearnedLessons` |
| Token budget for thinking context | `server/src/agent/loop.js` `injectLearnedLessons` (2000-char budget) | `cli/ui.js:243` `showTokenBar()` |

**Additive-only rule**: every patch above is a new flag, new function, new prompt string, or
new branch. Never delete existing code. Wrap new behavior in feature flags so the default
path stays unchanged.

---

## 10. Existing Agent Docs (docs/agent/)

These describe **how** agents should behave. This navigation map describes **where** the code is.

| Doc | Purpose |
| --- | --- |
| `agent-md-brain-index.md` | Load order for the markdown brain; universal provider rule |
| `cli-agent-tool-loop.md` | Loop-control patterns (bounded turns, duplicate detection, loop breaks) |
| `cli-agent-playbooks.md` | Per-agent playbooks (Codex, Hermes/Nous, Claude, Kiro, OpenCode, Aider, Gemini, Ollama, Hakster web/terminal) |
| `tool-call-map.md` | Canonical tool-call shape, provider translation, tool catalog, routing matrix |
| `patching-skills-brain.md` | Universal patch contract + per-role patch skills (Coder, Builder, Debugger, etc.) |
| `phantom-md-brain.md` | Phantom IDE agent roles extracted as markdown-only guidance |
| `hakster-phantom-unified-brain.md` | Hakster + Phantom unified identity, adapter contract, role routing |
| `multi-project-session.md` | Switching cwd mid-session; project context protocol |
| `gap-analysis-hermes-codex.md` | Feature gap analysis vs Codex/Claude Code/OpenCode/Aider |

**Load order for a patching task** (from `agent-md-brain-index.md`):
1. `cli-agent-tool-loop.md`
2. `tool-call-map.md`
3. `multi-project-session.md`
4. `cli-agent-playbooks.md`
5. `patching-skills-brain.md`
6. `phantom-md-brain.md` (if Phantom-style patterns are relevant)
7. `hakster-phantom-unified-brain.md` (if unifying Hakster + Phantom)
8. **`agent-navigation-map.md`** (this file — for finding the code)

---

## 11. Module Dependency Map (CLI side)

```
cli/index.js
  ├── imports cli/providers.js   (C, HOME, CLI_ROOT, ensureProviderAvailable, getBestProvider, ...)
  ├── imports cli/tools.js        (parseTools, execTools, TOOL_DEFINITIONS, ...)
  ├── imports cli/ui.js           (printBanner, thinkingAnimation, renderMarkdown, AGENT_TEAM, ...)
  ├── imports cli/memory.js as mem (loadTrust, saveMemory, ...)
  ├── imports cli/logo.js         (intro/banner)
  └── imports server/src/agent/autolearn.js (autoInit)

cli/ui.js
  ├── imports cli/providers.js   (C, HOME, CLI_ROOT)
  └── imports cli/memory.js       (findAllUSBs, loadMemory, getMachineProfile, estTokens, ...)

cli/tools.js
  └── imports cli/providers.js   (for path resolution / trust config)

cli/providers.js
  └── self-contained (HTTP helpers, ollama auto-start, provider inventory)

server/src/agent/index.js  (server loop — 7029 lines)
  ├── imports server/src/agent/loop.js     (phases, consolidation, reflection, injection)
  ├── imports server/src/agent/autolearn.js (memory init, skill extraction)
  ├── imports server/src/agent/approval.js  (dangerous-command gate)
  └── imports server/src/agent/mcp.js       (MCP bridge)

server/src/agent/loop.js
  └── self-contained (phase enum, transitions, triggers, injectors)
```

---

## 12. Quick-Reference Constants

```
# cli/providers.js
PROVIDER_ORDER[0]      = 'ollama'
PROVIDER_ENDPOINTS.ollama = 'http://localhost:11434/v1/chat/completions'
NO_KEY_PROVIDERS       = Set{ 'ollama', ... }
PROVIDER_TYPE.ollama   = 'local'
DEFAULT_OLLAMA_MODEL   = process.env.OLLAMA_MODEL || 'glm-5.2:cloud'
OLLAMA_URL             = 'http://localhost:11434'
Ollama health check    = GET http://localhost:11434/api/tags

# cli/index.js
chat command           = line 444
offlineLLMCall         = line 210
offlineAgentLoop       = line 262
handleSlashCommand     = line 504
REPL prompt            = "ghost@hakster>"

# cli/ui.js
VERSION               = '1.1.0'
Phase colors          = THINK #75, PLAN #141, ACT #118, OBSERVE #81, REFLECT #215, CONSOLIDATE #220

# server/src/agent/loop.js
Consolidation interval = 25 turns
Consolidation threshold = 10 raw memories
Reflect after          = 3 no-progress turns
Self-recursion limit   = 10
Memory injection budget = 2000 chars
Summary token budget   = 1500 tokens
Trust levels           = SUGGEST 0-9, AUTO_EDIT 10-29, FULL_AUTO 30+
```

---

## 13. How to Use This Map

1. **Start with §2 "I want to…"** — find the task, go to the listed file:line.
2. **If the task is a patch**, cross-reference §9 to find all the touch points
   (primary + secondary).
3. **If you need behavior guidance** (not just location), load the docs in §10
   in the listed order.
4. **If you're lost in a file**, use `rg -n "symbol" path` to relocate — line
   numbers drift, symbol names don't.
5. **Always patch additively** — new flags, new functions, new branches. Never
   delete. Wrap new behavior in feature flags so the default path stays unchanged.
6. **After patching, verify** with the narrowest useful command:
   - `node -c <file>` for syntax
   - `node cli/index.js chat --help` for CLI flag wiring
   - `node cli/index.js chat --thinking extended "ping"` for end-to-end