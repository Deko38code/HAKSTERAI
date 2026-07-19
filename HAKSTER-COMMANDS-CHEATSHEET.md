# HAKSTERAI — Commands & Tools Cheatsheet / Playbook Map

_Auto-generated from the live CLI help + server agent tool registry + skill roots._

## CLI Commands (`haksterai`)
- `config` — Manage CLI configuration
- `ls` — [path] List files in server workspace
- `download` — [options] <path> Download a file from the server
- `health` — Check if server is online
- `status` — Show CLI config and server connection status
- `chat` — [options] Full autonomous AI agent — type tasks, it runs
- `tools` — and loops until done
- `guardian` — [options] [args...] Run Guardian pentest CLI commands (scan, recon,
- `analyze,` — report, workflow)
- `init` — [options] Initialize haksterAi CLI — set server URL and
- `API` — key
- `models` — List available AI models from the server
- `mcp` — List available MCP tools from the server
- `agent` — [options] <prompt> Run a one-shot agent task with full tool loop
- `(non-interactive)`
- `providers` — List all available AI providers (online and
- `offline)`
- `team` — [workflow] [prompt...] Run an agent team workflow (e.g. hakster team
- `fix` — "bug description")
- `usb` — Show USB status and sync options
- `ui` — Launch haksterAI TUI (Ink/React)
- `sessions` — [options] List all server sessions in a grid box layout
- `resume` — [options] <id> Resume a saved session by ID — loads its
- `messages` — and opens the chat REPL
- `cockpit` — [options] Open the haksterAi web cockpit dashboard in
- `your` — default browser
- `help` — [command] display help for command

## Config subcommands (`haksterai config`)
- `config set` — <key> <value> Set a config value (e.g. server URL)
- `config get` — <key> Get a config value
- `config list` — Show all config
- `config sudo` — [options] Set the sudo/danger password the agent uses for elevated
- `config shell` — commands (input hidden).
- `config help` — [command] display help for command

## Built-in Agent Tools (`/api/agent/run`)
`shell`, `read_file`, `write_file`, `patch_file`, `list_dir`, `web_fetch`, `firecrawl`, `web_search`, `search_files`, `run_background`, `kill_process`, `multi_patch`, `insert_lines`, `delete_lines`, `replace_regex`, `append_file`, `git_op`, `pm2`, `service_check`, `claude_proxy`, `run_agent`, `snapshot`, `sub_agent`, `crush`, `parallel_shell`, `code_grid`, `browser_navigate`, `browser_click`, `browser_type`, `browser_screenshot`, `browser_snapshot`, `memory`, `skill_save`, `skill_load`, `skill_list`, `notify`, `generate_image`, `read_image`, `analyze_image`, `ocr_text`, `compare_images`, `glob_search`, `edit_file`, `replace_in_file`, `shell_bg`, `diff_preview`, `codebase_map`, `context_compaction`, `plan`, `todo`, `haksterAI`, `CineVault`, `Miniforge`, `Hermes`

## CLI slash commands (chat REPL)
- `/status` `/memory` `/help` `/clear` `/exit`

## Skills available (skill_load <name>)
Total: 2667. Examples: `.github/PULL_REQUEST_TEMPLATE`, `.plans/openai-api-server`, `.plans/streaming-support`, `AGENTS`, `CONTRIBUTING`, `README`, `README.zh-CN`, `RELEASE_v0.10.0`, `RELEASE_v0.11.0`, `RELEASE_v0.12.0`, `RELEASE_v0.13.0`, `RELEASE_v0.14.0`, `RELEASE_v0.15.0`, `RELEASE_v0.15.1`, `RELEASE_v0.2.0`, `RELEASE_v0.3.0`, `RELEASE_v0.4.0`, `RELEASE_v0.5.0`, `RELEASE_v0.6.0`, `RELEASE_v0.7.0`, `RELEASE_v0.8.0`, `RELEASE_v0.9.0`, `SECURITY`, `apps/desktop/README`, `apps/desktop/scripts/profile-typing-lag`

## Provider Waterfall (cloud-first)
ollama → sambanova → groq → cerebras → gemini-flash → gemini → openrouter → pollinations → … (see `haksterai providers`)

## Defaults / Overrides
- Default: ollama · glm-5.2:cloud. Override: `-p`/`-m` or `HAKSTER_PROVIDER`/`HAKSTER_MODEL`.
- Sudo/danger password: `hakster config sudo` (server pipes via `sudo -A` + SUDO_ASKPASS).
- Sub-agents: `sub_agent` (≤3 parallel) and `spawn_agent` (single) — full tool loops.
- Firecrawl: `firecrawl` tool (scrape|crawl|map|search).
- Watchdog: PM2 `hakster-watchdog` auto-restarts `haksterAi` after 3 health fails.
