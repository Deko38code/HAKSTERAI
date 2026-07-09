# haksterAI Agent Structure

This app runs the haksterAI server on port `3579` by default. The agent runtime prompt lives in `server/src/providers.js` as `AGENT_SYSTEM_PROMPT`, and `/api/agent/run` injects it with machine context before tool calls.

## Agent Modes

haksterAI should classify each request before acting:

- `Coding`: repo inspection, scoped edits, tests/builds, bug fixes, feature work.
- `IPTV`: M3U/M3U8, Xtream, Stalker/MAG, EPG, stream validation, channel normalization.
- `Movie Servers`: `/home/ghost/movie-server`, `vidsrc/devsrc`, source resolvers, PM2 movie services, CineVault integrations.
- `Cloud/Ops`: PM2/systemd/Docker, ports, logs, health checks, env safety, restarts.
- `Database`: schema inspection, backups, migrations, safe writes.
- `Frontend`: operational UI, dashboards, admin workflows, responsive checks.
- `Research`: external docs or source lookup when current information matters.
- `General`: planning, explanations, and lightweight help.

## Standard Workflow

1. Inspect relevant files, scripts, logs, or process state.
2. State the working assumption briefly.
3. Make the smallest safe change.
4. Verify with the narrowest useful command.
5. Report changed files, verification, and blockers.

## Speed Rules

- Start with targeted files, PM2 metadata, recent logs, package scripts, and exact symbols.
- Avoid broad scans through `node_modules`, `dist`, `build`, `.git`, caches, media folders, and large logs.
- Use `rg` with narrow globs and service-specific paths.
- Bound long commands with timeouts.
- Use PM2 or the browser terminal for long-running services instead of foreground agent shell commands.
- Prefer the smallest working fix that unblocks the current workflow.

## IPTV Data Shape

Use a consistent internal record when adding IPTV features:

```json
{
  "name": "Channel Name",
  "tvg_id": "channel.id",
  "logo": "https://example.com/logo.png",
  "group": "News",
  "country": "US",
  "language": "en",
  "source": "playlist-name",
  "url": "https://example.com/live.m3u8",
  "headers": {
    "user-agent": "Mozilla/5.0"
  },
  "status": "unknown",
  "latency_ms": null,
  "last_checked": null
}
```

## Verification Targets

- Node syntax: `node -c server/src/providers.js`
- Server health: `curl -s http://127.0.0.1:3579/api/health`
- Process status: `pm2 list`
- Frontend build: `npm run build`
- Movie server source scan: `rg --files /home/ghost/movie-server -g '!node_modules'`

## Safety Rules

- Never print secrets, playlist credentials, portal MACs, tokens, cookies, DB passwords, or webhook secrets.
- Back up databases before risky migrations.
- Avoid destructive shell commands unless the user explicitly confirms the target.
- Preserve unrelated user changes.
