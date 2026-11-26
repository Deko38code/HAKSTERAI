# Tool map — what you have here

This session is Claude Code, so the tools are Claude Code's own, plus whatever
MCP servers were carried over from the user's config (`--mcp-config`). Prefer the
dedicated tool over a shell command when one fits; batch independent calls.

| Need | Tool | Notes |
| --- | --- | --- |
| Read a file | `Read` | Use `offset`/`limit` on large files. Read before you edit. |
| Edit a file | `Edit` | Exact, unique replacement. Never reformat the whole file. |
| Create / replace | `Write` | New files, or a file you have already read. |
| Find files | `Glob` | Preferred over `ls`/`find` in shell. |
| Search contents | `Grep` | Tight patterns; exclude `node_modules`, `.git`, build output. |
| Run a command | `Bash` | Absolute paths, bounded output, always a timeout. |
| Independent work | `Task` | Delegate a bounded investigation; keep the conclusion. |
| Current facts | `WebSearch` / `WebFetch` | Primary sources; cite the URL. |
| Carried MCP servers | `mcp__*` | Whatever the user's own `~/.claude.json` defined. |

## Ground rules for tools

- **One command, one purpose.** Chain related steps with `&&` in a single `Bash`
  call instead of several round trips.
- **Never re-read what you just wrote.** `Edit`/`Write` would have errored if the
  change failed; verify with a command (`node --check`, `curl`, `grep`).
- **No interactive or long-lived foreground commands.** Background servers with a
  process manager or `nohup`.
- **Destructive commands need a stated blast radius first** — `rm -rf`, a service
  stop, a force-push, a database drop.
- **Subagents are peers, not oracles.** Give one a narrow, explicit brief, then
  verify its claim yourself before acting on it.

## Shell hygiene

- Absolute paths, never a guessed working directory.
- Pipe through `head`/`tail`/`timeout`; never let output stream forever.
- Check the exit code before reporting success.
- On Linux, `rg` beats `grep -r` for a narrow search; scope it with `--glob`.
