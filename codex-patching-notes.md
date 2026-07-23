# Codex Patching & Runtime Notes

## Overview
This note consolidates Codex-related runtime, patching, migration, model-discovery, and integration details found in the Hermes/Codex workspace.

## Codex CLI basics
- Codex is OpenAI's autonomous coding-agent CLI.
- It is intended for:
  - feature building
  - refactoring
  - PR review
  - batch issue fixing
- Requirements:
  - Codex CLI installed via `npm install -g @openai/codex`
  - OpenAI auth configured through `OPENAI_API_KEY` or Codex OAuth
  - a git repository is required for normal usage
  - `pty=true` is required for terminal execution because Codex is interactive

## Common Codex commands
### One-shot
```bash
codex exec "Add dark mode toggle to settings"
```

### Full-auto mode
```bash
codex exec --full-auto "Refactor the auth module"
```

### Dangerous / no-sandbox mode
```bash
codex exec --sandbox danger-full-access "Perform the task"
```

### Background mode
```bash
codex exec --full-auto "Refactor the auth module"  # background-friendly in Hermes-style workflows
```

## Key flags
- `exec "prompt"` → one-shot execution
- `--full-auto` → auto-approves changes inside the sandbox
- `--yolo` → no sandbox and no approvals; fastest but most dangerous
- `--sandbox danger-full-access` → disables sandboxing for environments where the host runtime breaks the standard bubblewrap layer

## Hermes integration notes
Hermes supports a runtime toggle:
- `auto`
- `codex_app_server`

This is persisted via `model.openai_runtime` in config.

When the runtime is switched to `codex_app_server`, Hermes can:
- migrate MCP server config into `~/.codex/config.toml`
- migrate native Codex plugins into the same config file
- configure default permissions so the user is not repeatedly prompted for writes

## MCP / plugin migration behavior
The migration flow:
1. Reads Hermes MCP config and writes equivalent `[mcp_servers.<name>]` entries to `~/.codex/config.toml`
2. Queries Codex's plugin list and writes `[plugins."<name>@<marketplace>"]` entries for installed plugins
3. Writes a `[permissions] default` profile to reduce repetitive approval prompts

### What translates
- Hermes `command/args/env/cwd` → Codex stdio transport
- Hermes `url/headers` → Codex streamable HTTP transport
- Hermes `timeout` → `tool_timeout_sec`
- Hermes `connect_timeout` → `startup_timeout_sec`

### What does not translate cleanly
- Hermes-specific fields such as sampling are not mirrored to Codex because Codex has no direct equivalent

## Patching / change-tracking behavior
Codex app-server messages emit structured item notifications such as:
- `commandExecution`
- `fileChange`
- `mcpToolCall`
- `dynamicToolCall`

Hermes maps these to tool progress events:
- `commandExecution` → `exec_command`
- `fileChange` → `apply_patch`
- `mcpToolCall` / `dynamicToolCall` → MCP or dynamic tool calls

This means patch-style work is surfaced as `apply_patch` progress in Hermes even when the underlying runtime is Codex.

## Model discovery
Hermes Codex model discovery pulls from:
1. live API results (if an access token is available)
2. local `~/.codex/config.toml`
3. local cache (`models_cache.json`)
4. fallback hardcoded model slugs

Notable model examples include:
- `gpt-5.6-sol`
- `gpt-5.6-sol-pro`
- `gpt-5.6-terra`
- `gpt-5.6-terra-pro`
- `gpt-5.6-luna`
- `gpt-5.6-luna-pro`
- `gpt-5.5`
- `gpt-5.4-mini`
- `gpt-5.4`
- `gpt-5.3-codex`
- `gpt-5.3-codex-spark`

## Operational recommendations
- Use `pty=true` for Codex terminals.
- Prefer `exec` for one-shot tasks.
- Use `--full-auto` when you want automation but still want sandboxing.
- Use `danger-full-access` only in controlled environments where the host context is trusted.
- For gateway/service contexts, review diffs and limit scope to reduce risk.
- Prefer explicit workdirs and clean git state before launching broad changes.

## Summary
The main practical Codex takeaways are:
- it works best inside git repos
- Hermes can bridge it into a more integrated runtime
- patching and file changes are surfaced as `apply_patch`-style progress events
- MCP/plugin migration and permissions are important when enabling the Codex app-server route
