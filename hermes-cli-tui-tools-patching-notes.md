# Hermes CLI / TUI / Tools — Patching Notes

## Overview
This note covers the Hermes CLI's terminal interfaces (Classic CLI vs. modern TUI) and its built-in tool system, cross-referencing the official NousResearch docs with what's actually present in the local workspace (`~/.hermes/hermes-agent`, upstream: [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent)).

## What Hermes Agent is
"The agent that grows with you" — a self-improving AI agent from Nous Research. One agent core, several front-ends: Classic CLI, modern TUI, a messaging gateway (Telegram, Discord, Slack, ~20 platforms), and an Electron desktop app.

## Two CLI surfaces
### Classic CLI
- Built on `prompt_toolkit` + `Rich`.
- Per open feature request [#504](https://github.com/NousResearch/hermes-agent/issues/504), it's missing rich markdown tables/syntax highlighting, syntax-highlighted diff previews, a persistent token/cost status bar, and navigable/scrollable output blocks — proposed as a 3-phase rollout (status bar → markdown/diff rendering → block navigation/export). **Issue is open, unassigned, no linked PR** as of this writing.

### Modern TUI
- Launch via `hermes --tui`, the `HERMES_TUI=1` env var, or `display.interface: tui` in `~/.hermes/config.yaml`.
- Runs as a **Node.js subprocess** (requires Node ≥ 20 + a TTY) spawned from the Python CLI, backed by a Python JSON-RPC `tui_gateway` process — confirmed locally at `~/.hermes/hermes-agent/tui_gateway` and `~/.hermes/hermes-agent/ui-tui`.
- By default each TUI instance spawns its **own in-process gateway** (self-contained). `HERMES_TUI_GATEWAY_URL` is an internal wiring detail used only when the web dashboard embeds a TUI child process over a loopback WebSocket (`/api/ws`).
- Features: instant first-frame banner paint, non-blocking input (type/queue before session ready), modal overlays for model picker / session picker / approval & clarification prompts, live session switcher (`Ctrl+X` or `/sessions`), mouse support (drag-to-select, `Cmd+V`/`Ctrl+V` paste), live tool/skill init panel, LaTeX-to-Unicode math rendering.
- Graceful fallback to Classic CLI if the TUI subprocess fails to launch; optional prebuilt bundle support for distros that ship one (matches local `tests/hermes_cli/test_tui_bundled.py`, `tests/docker/test_tui_prebuilt_bundle.py`).

## Local TUI test coverage (confirms doc claims)
- `test_tui_gateway_loop_noise.py`, `test_tui_gateway_queue_on_busy.py`, `test_tui_gateway_server.py`, `test_tui_gateway_ws.py` — gateway process/queueing/WebSocket behavior
- `test_tui_resume_flow.py` — session resume
- `test_tui_heap_sizing.py` — Node subprocess heap tuning
- `test_tui_mouse_residue_suppression.py` — cleans up terminal mouse-tracking escape sequences on exit
- `test_tui_terminal_reset_on_exit.py` — terminal state restoration
- `test_tui_npm_install.py` — handles missing/broken `node_modules` for the Node frontend
- `test_dashboard_tui_backcompat.py`, `test_cli_background_tui_refresh.py` — dashboard/background refresh compatibility
- `test_tui_approval_redaction.py` — redacts sensitive content in approval-prompt overlays

## Built-in tools
Per the official [tools reference](https://hermes-agent.nousresearch.com/docs/reference/tools-reference): roughly **73 tools across 30+ toolsets**, gated by platform, credentials, and enabled toolsets:
- **Browser** (~12): navigation, click/type/scroll, vision analysis; a couple require CDP endpoint connectivity
- **File** (4): read, write, patch (fuzzy-matched to survive whitespace differences), search
- **Terminal** (3): shell exec, background processes, `read_terminal` (desktop-only)
- **Web** (2): search, content extraction (keyed to Exa/Firecrawl/Tavily credentials)
- **Kanban** (9): task/board orchestration
- **Spotify** (7), **Video** (2 toolsets, FAL/xAI-backed), **Discord** (2 toolsets), **Home Assistant** (4)
- Platform-specific: Yuanbao (5), Feishu (5)
- Singles/small groups: Skills, Memory, Projects, Vision, TTS, X Search (enrollment-gated)

Locally, this maps to `~/.hermes/hermes-agent/tools/*.py` (one module per tool family — `file_tools.py`, `browser_tool.py`, `browser_cdp_tool.py`, `code_execution_tool.py`, `cronjob_tools.py`, `kanban_tools.py`, `homeassistant_tool.py`, `mcp_tool.py`, `computer_use_tool.py`, `delegate_tool.py`, etc.), dispatched through `agent/tool_executor.py` and `agent/tool_dispatch_helpers.py`, with `agent/tool_guardrails.py` handling permission/safety checks and `agent/tool_result_classification.py` + `tests/test_sanitize_tool_error.py` handling error sanitization before results reach the model.

## Toolset config surface
- `toolsets.py` / `toolset_distributions.py` define which tools ship in which toolset bundle.
- `hermes_cli/tools_config.py` + `hermes_cli/toolset_validation.py` handle user-facing enable/disable config and validate it.
- `agent/transports/hermes_tools_mcp_server.py` exposes Hermes's own tools back out over MCP (so Hermes tools can be consumed by other MCP clients, not just invoked internally).

## Operational recommendations
- If you want the modernized CLI experience from #504 (status bar, diff previews, block nav), don't wait on Classic CLI — use `hermes --tui` today; several of its features (overlays, live tool panel) already cover part of that ask.
- Node ≥ 20 is a hard requirement for the TUI; `test_tui_npm_install.py` suggests a first-run `node_modules` install step can fail silently if Node/npm isn't set up — check that before assuming a TUI launch failure is a Hermes bug.
- When adding a new tool, register it in a toolset (`toolsets.py`) and confirm it passes through `tool_guardrails.py` — tools aren't picked up just by dropping a file in `tools/`.

## Summary
Hermes ships two terminal front-ends — a `prompt_toolkit`/`Rich` Classic CLI that's due for a rendering overhaul (tracked, unshipped, in #504) and a Node-subprocess TUI already ahead of it on overlays/session UX — both driven by the same ~73-tool, 30+-toolset registry gated by platform/credentials/opt-in, dispatched through a guardrail + sanitization layer before tool results reach the model.

Sources:
- [GitHub - NousResearch/hermes-agent: The agent that grows with you](https://github.com/NousResearch/hermes-agent)
- [hermes-agent/website/docs/user-guide/tui.md](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/tui.md)
- [Feature: Enhanced CLI TUI — Issue #504](https://github.com/NousResearch/hermes-agent/issues/504)
- [Built-in Tools Reference](https://hermes-agent.nousresearch.com/docs/reference/tools-reference)
