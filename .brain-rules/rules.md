# haksterAi Brain Rules

## Always
- CLI is the primary interface — all features must work from terminal
- Proxy runs on port 8084 — check with `fuser 8084/tcp` before restart
- Agent memory is shared via /home/ghost/.shared/agent-memory.json
- Skills are stored in .hakster/skills/*.md
- Use `node -c` to syntax-check CLI before committing

## Never
- Don't use port 8080 (conflicts with CineVault)
- Don't kill the PM2 sonnet-brain daemon
- Don't modify shared_memory.py without backing up /home/ghost/.shared/agent-memory.json