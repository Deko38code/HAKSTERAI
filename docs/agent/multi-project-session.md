# Multi Project Session

HaksterAI sessions can switch between projects without starting over. The active project is a session-level context value, not a separate chat.

## Active Project Context

```json
{
  "sessionId": "chat/session id",
  "activeProjectLabel": "haksterAI",
  "cwd": "/home/ghost/haksterAi",
  "gitRoot": "/home/ghost/haksterAi",
  "lastVerifiedCommand": "npm run build"
}
```

If no project is selected, use the isolated session workspace created by the server.

## Switch Protocol

When the user switches projects:

1. Resolve the target from known folders or the explicit path.
2. Store that path as the active `cwd` for the session.
3. Announce the active project briefly when useful.
4. Use that `cwd` for every shell, read, write, patch, build, and git operation.
5. Keep verification and commit scope inside the active project.
6. Do not mix files from another project unless the user asks for a cross-project change.

## Tool Rules

- `exec_shell.cwd` must equal the active project path.
- `read_file`, `write_file`, and `edit_file` must resolve relative paths inside the active project.
- Before committing, inspect `git status` in the active project.
- If a project has no `.git`, report that push is not available for that project.
- If the user says "switch to X", update active project first, then continue the task.

## UI Rules

The Hack tab should expose a project selector populated from `/api/machine-context`. The selector sends `cwd` to `/api/agent/run`, allowing one conversation to move between HaksterAI, CineVault, Movie Server, skills, and other detected projects.
