# TUI Patterns Research — Codex CLI & Kiro CLI (Ink/React)

> Scraped and compiled 2026-07-20 from OpenAI Codex CLI source, Kiro CLI docs/blog, ink-ui, and Ink README.
> Purpose: Apply these patterns to haksterAi's CLI TUI (`cli/ui/src/App.jsx`).

---

## 1. Codex CLI TUI Architecture

Source: `codex-rs/core` (Rust backend) + React/Ink frontend.

### Key UI Components

| Component | Purpose | Ink Primitives |
|-----------|---------|----------------|
| **StatusBar** (bottom) | Shows model, reasoning effort, approval mode, sandbox mode, file count | `Box` + `Text` with `borderTop` |
| **Spinner** | Animated dots during thinking/acting | Custom `useEffect` interval + `Text` |
| **ToolCallCard** | Collapsible panel: tool name, args, result, duration | `Box` with border + `useInput` for collapse |
| **DiffPreview** | Colorized +/- lines before applying edit | `Text` with green/red colors |
| **InputBox** | Multi-line: Enter=send, Shift+Enter=newline | `TextInput` + `useInput` override |
| **SlashCommands** | Autocomplete dropdown: /model, /review, /approve | `SelectInput` from `ink-select-input` |
| **TokenCounter** | Running token/cost display | `Text` with dim color |
| **GitBranch** | Current git branch in header | `execSync('git rev-parse --abbrev-ref HEAD')` |
| **PhaseTimer** | Elapsed time per agent phase | `Date.now()` delta + `Text` |

### Layout (Codex)

```
┌─ Codex ─────────────────────────────────────┐
│  [output area — scrollable]                  │
│  > thinking...                                │
│  > applying edit to src/auth.js               │
│  ┌─ tool: edit_file ──────────────────────┐  │
│  │ ✓ Applied — 3 lines changed             │  │
│  └──────────────────────────────────────────┘  │
│                                                │
├─ Input ──────────────────────────────────────┤
│ > _                                            │
├───────────────────────────────────────────────┤
│ gpt-5.6 │ xhigh │ on-request │ 12 files │ 4.2k │ ← StatusBar
└───────────────────────────────────────────────┘
```

### Key Patterns

1. **Bottom status bar** — always visible, shows model + mode + context stats
2. **Spinner during reasoning** — animated `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` frames
3. **Tool call cards** — bordered box per tool call, collapsible with Tab key
4. **Diff preview** — green `+` / red `-` lines, shown before apply
5. **Multi-line input** — Shift+Enter for newline, Enter to send
6. **Slash command palette** — type `/` to see available commands
7. **Auto-scroll lock** — scrolling up locks auto-scroll, indicator shows
8. **Phase indicators** — colored phase labels (THINK=blue, ACT=green, etc.)
9. **Token/cost tracking** — running total in status bar
10. **Git branch + dirty indicator** — shown in header

---

## 2. Kiro CLI TUI Architecture

Source: AWS Builder Blog — "From Rust to React/Ink: The Architecture Behind Kiro CLI's Classic vs TUI Mode"

### Architecture

- **Classic mode**: Plain text output (Rust CLI, fast, minimal)
- **TUI mode** (`--tui`): React/Ink full-screen interface
- Communication via IPC: Rust core → JSON events → Ink frontend
- Events: `phase_change`, `tool_start`, `tool_result`, `token`, `status`, `done`

### Key UI Components

| Component | Purpose |
|-----------|---------|
| **LiveStatusBar** | Phase, elapsed time, tool count, current target |
| **RichToolPanel** | Syntax-highlighted tool output with collapsible sections |
| **PhaseTimer** | Per-phase elapsed time |
| **ProgressIndicator** | Animated progress for long operations |
| **CommandPalette** | Slash commands with autocomplete |
| **SplitView** | Reasoning panel (left) + output panel (right) on wide terminals |
| **KeyboardShortcuts** | `?` toggles shortcuts overlay |

### Layout (Kiro TUI)

```
┌─ Kiro CLI ────────────────────────────────────────────┐
│ Phase: ACT  │  Elapsed: 12s  │  Tools: 3  │  Target: x │ ← StatusBar (top)
├──────────────────────────────────────────────────────┤
│  [reasoning + output area]                             │
│  ┌─ tool: exec_shell ─────────────────────────────┐  │
│  │ $ npm test                                       │  │
│  │ ✓ 3 passed (2.1s)                                │  │
│  └──────────────────────────────────────────────────┘  │
│                                                         │
├─ Input ────────────────────────────────────────────────┤
│ > _                                                     │
└─────────────────────────────────────────────────────────┘
```

### Key Patterns

1. **Classic ↔ TUI toggle** — `--tui` flag, same backend
2. **Top status bar** — phase, elapsed, tools, target
3. **Phase-colored indicators** — each phase has distinct color
4. **Collapsible tool panels** — Tab to expand/collapse
5. **Wide-screen split view** — reasoning | output side by side
6. **Keyboard shortcut overlay** — `?` to show all shortcuts
7. **Event-driven rendering** — JSON events from backend → React state updates
8. **Progress bar** — for operations > 2s

---

## 3. ink-ui Component Library

Source: ink-ui (vadimdemedes) — companion component library for Ink.

| Component | Package | Use Case |
|-----------|---------|----------|
| `Spinner` | `ink-spinner` | Animated loading indicator |
| `TextInput` | `ink-text-input` | Single/multi-line text input |
| `SelectInput` | `ink-select-input` | Slash command palette |
| `BigText` | `ink-big-text` | ASCII art banner |
| `Gradient` | `ink-gradient-text` | Gradient colored text |
| `Link` | `ink-link` | Clickable terminal links |
| `ProgressBar` | ink-ui | Progress bars for operations |
| `Badge` | ink-ui | Status badges (colored labels) |
| `Alert` | ink-ui | Info/success/warning/error boxes |
| `Table` | ink-ui | Tabular data display |
| `Tabs` | ink-ui | Tab navigation |
| `CodeBlock` | ink-ui | Syntax-highlighted code |
| `ConfirmInput` | ink-ui | Yes/No confirmation |

---

## 4. Patterns to Adopt in haksterAi

### Priority 1 — Status Bar (Codex + Kiro)
Bottom status bar showing: model, phase, trust level, tool count, elapsed time.

### Priority 2 — Spinner (Codex)
Animated spinner during THINK/ACT phases instead of static "..." text.

### Priority 3 — Tool Call Cards (Codex + Kiro)
Bordered collapsible panels per tool call with name, args, result, duration.

### Priority 4 — Slash Commands (Codex)
`/model`, `/clear`, `/help`, `/tools`, `/phase`, `/exit` autocomplete.

### Priority 5 — Multi-line Input (Codex)
Shift+Enter for newline, Enter to send.

### Priority 6 — Git Branch in Header (Codex)
Show current branch + dirty status in header bar.

### Priority 7 — Token Counter (Codex)
Running token count in status bar.

### Priority 8 — Keyboard Shortcuts Overlay (Kiro)
`?` toggles a help overlay showing all shortcuts.

### Priority 9 — Diff Preview (Codex)
Colorized diff lines for file edits before apply.

### Priority 10 — Auto-scroll Lock (Codex)
Scroll up → lock auto-scroll, show "auto-scroll paused" indicator.

---

## 5. Implementation Notes

haksterAi already has:
- ✅ Phase indicators with colors (THINK/PLAN/ACT/OBSERVE/REFLECT/CONSOLIDATE/DONE)
- ✅ Scrollable output with scrollbar
- ✅ Tool chain display
- ✅ Reasoning classification (inspect/find/error/plan/conclusion/diagnosis)
- ✅ WebSocket agent connection
- ✅ Input box with basic key handling

haksterAi needs:
- ❌ Bottom status bar (model, phase, trust, tools, elapsed)
- ❌ Animated spinner during phases
- ❌ Tool call cards (collapsible bordered panels)
- ❌ Slash command palette
- ❌ Multi-line input (Shift+Enter newline)
- ❌ Git branch in header
- ❌ Token counter
- ❌ Keyboard shortcut overlay
- ❌ Diff preview for edits
- ❌ Auto-scroll lock indicator