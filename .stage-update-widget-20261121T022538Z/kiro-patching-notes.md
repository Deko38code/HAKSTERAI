# Kiro CLI & Hermes Integration Notes

## Overview
This note covers what's actually present on this machine for Kiro, and how (or whether) it relates to the Hermes agent workspace (`~/.hermes/hermes-agent`) that also hosts the Codex and Claude integrations.

## Kiro CLI basics
- Installed locally at `~/.local/share/kiro-cli` (release feed: `~/.local/share/kiro-cli/feed.json`).
- Config lives at `~/.kiro/settings/cli.json` (currently empty/default on this machine) and `~/.kiro/agents/agent_config.json.example`.
- Per the local release feed (latest entry: v2.12.0, 2026-07-08), Kiro CLI supports:
  - MCP OAuth, including `client_secret` for confidential clients and Dynamic Client Registration skip when a custom `client_id` is configured
  - A TUI with ASCII-mode-aware glyphs/symbols for terminal compatibility
  - A shell permission detector (recently hardened against combined short-option bypasses, e.g. `grep -iP`, being misclassified as read-only)

## Relationship to Hermes
- Unlike Codex (`agent/codex_runtime.py`, `agent/transports/codex_app_server.py`) and Claude (`agent/anthropic_adapter.py`, first-class `PROVIDER_REGISTRY` entry), **no `kiro` runtime, provider, or transport exists in the Hermes agent codebase.**
- A search of `hermes_cli/`, `agent/`, and `agent/transports/` for "kiro" returns no matches — Kiro is a standalone CLI on this machine, not a Hermes-integrated runtime.
- If Kiro integration is wanted, it would need the same three pieces Codex has:
  1. A runtime module (`agent/kiro_runtime.py`) analogous to `codex_runtime.py`
  2. A transport (`agent/transports/kiro_app_server.py`) if Kiro exposes an app-server/JSON-RPC style protocol like Codex does
  3. A `PROVIDER_REGISTRY` entry or `model.provider` toggle if Kiro should be selectable the way `anthropic` is

## Operational notes
- Treat Kiro as fully separate tooling for now — don't expect `hermes config set model kiro/...` or similar to work, since there's no provider registered for it.
- If Kiro's MCP OAuth config format is ever mirrored into Hermes (the way Codex's `~/.codex/config.toml` MCP migration works), the `client_secret` / DCR-skip behavior from v2.12.0 above is the relevant surface to match.

## Summary
Kiro CLI is present and configured independently on this machine but has zero footprint inside the Hermes agent's runtime/provider system — it's not wired up the way Codex (subprocess app-server) or Claude (direct API provider) are.
