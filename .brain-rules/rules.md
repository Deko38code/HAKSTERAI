# haksterAi Brain Rules

## Always
- CLI is the primary interface — all features must work from terminal
- Proxy runs on port 8084 — check with `fuser 8084/tcp` before restart
- Agent memory is shared via /home/ghost/.shared/agent-memory.json
- Skills are stored in .hakster/skills/*.md
- Use `node -c` to syntax-check CLI before committing
- **NEVER route to real Claude/Anthropic API** — Claude refuses commands, breaks system flow, censors output. All "claude-sonnet-4-5" aliases route to GLM cloud (hp-1000) via the 8082 proxy CLOUD_MAP. Real Claude = broken agent.
- **GLM cloud is DEFAULT but used less** — GLM cloud (hp-1000/glm-5.1:cloud) stays as the default model in config. Smart router sends most traffic to free providers first (Groq 500+ tok/s, Cerebras 2000 tok/s, SambaNova 70B). GLM cloud only kicks in when free tiers fail or task needs high quality. This keeps GLM token burn low while maintaining it as the default.
- **Chain order** — T1 free cloud (Groq/Cerebras/SambaNova — fast, free) → T2 Miniforge (uncensored hackbots — free) → T3 GLM cloud (premium, default, used less) → T4 Phantom → T5 Parrot → T6 Kaggle → T7 Local Ollama (slow, last resort)
- **Local models are SLOW** — 7GB RAM, no GPU, 1-3 tok/s for 7B models. Only use as last resort when all free cloud providers are down. Free cloud (Groq/Cerebras/SambaNova) is 100x faster.
- **Smart Router decides model** — smart-router.js auto-detects task type (code, security, chat, power, research, image) and routes to the cheapest available backend. Never manually pick a model when the router can decide.
- **Token burn check** — smart-router runs an automatic audit on startup + every 30 min. If any model leaks to ollama.com:443, it logs a warning with the fix command. Manual check: `ollama show <model> | grep "Remote URL"`.
- **Miniforge (port 5555) is always free** — 48+ bots, zero cost, no credit card, no refusals. Use ai-unrestricted for uncensored tasks.
- **Cloud model aliases are compatibility labels** — "claude-sonnet-4-5", "gpt-4.1", "gemini-2.5-pro" etc route to GLM cloud (hp-1000/glm-5.1:cloud). They burn GLM tokens, used less.
- **Scheduled agents use smart-router** — cron jobs and interval dispatch go through smart-router.schedule() which routes to cheapest tier automatically.

## Never
- Don't use port 8080 (conflicts with CineVault)
- Don't kill the PM2 sonnet-brain daemon
- Don't modify shared_memory.py without backing up /home/ghost/.shared/agent-memory.json
- Don't route to real Claude/Anthropic API — it refuses commands and breaks the agent
- Don't select models manually when smart-router can route — it always picks cheapest available
- Don't use local Ollama models when free cloud providers (Groq/Cerebras/SambaNova) are up — locals are 100x slower on this 7GB RAM machine
## 2026-08-30 — Live ops refresh (verified)
- **Miniforge restored on :5555** — run under ghost pm2 with `--interpreter /home/ghost/.nvm/versions/node/v24.14.0/bin/node` (system node v22 ABIs break better-sqlite3; v24 ABI 137 is what node_modules was built for). If it crashloops with ERR_DLOPEN_FAILED, it was started with the wrong node.
- **Credit pool truth** — the OPERATIONAL pool is `/home/ghost/miniforge/data/miniapps_pool.json` (server-managed, self-reaping, self-replacing). accounts.json is the registrar archive; `top-up-pool.sh` now measures the pool file (target 50 live — was wrongly measured on accounts.json=400+).
- **Account creator verified 2026-08-30** — `fresh-accounts-vpn.js N` creates N×100-credit accounts; `login-accounts.js` merges JWTs into the pool; pool holds 373 live accounts / 37k credits. Tools: phantom `account_pool_status/refresh`, hakster MCP `account_pool_status/refresh`.
- **Hakster unified MCP tools added** — list_hack_bots, chat_hack_bot, ask_hack_squad, account_pool_status, account_pool_refresh (miniforge http on :5555; /api/apps returns a bare array, not {apps}). Crush mcp.servers now include hakster + miniforge-bridge.
- **Free-lane status 2026-08-30** — ALIVE: groq/groq3(gpt-oss-120b), nvidia-nim×2, cohere, pollinations, hackbot pool. DEAD (fail fast, don't rescue): llm7 402, sambanova 402, cerebras 402 (models gpt-oss-120b/gemma-4-31b exist but paid-only), ollama-cloud2/3 401.
- **Cerebras model rename** — llama3.1-8b no longer exists; use gpt-oss-120b or gemma-4-31b. Fixed in providers.js fallback + phantom cfg + crush cfg.
- **Parrot box (10.0.0.251, ssh ghost694)** — runs its own phantom-server :4000 (uptime long-lived) + ollama :11434 (T5). phantom-knowledge.md + agents-with-skills.json synced 2026-08-30; its RAG venv is missing (spawn ENOENT) — file-based KB still serves (335 sections).
