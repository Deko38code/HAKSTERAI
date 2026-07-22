# tools.md — Tool Orchestration, Caching, Retries, Recovery

How tool calls are executed, scored, cached, retried, and recovered.

## Executors (✅)
- ✅ `toolExecutors` map + MCP bridge (`callMcpTool`) — tools dispatched by `fnName`
  in the for-loop (index.js:6549+). Tools: shell, read_file, write_file, patch_file,
  search_files, list_dir, generate_image, read_image, + MCP (filesystem, nmap,
  playwright, sqlite, memory, sequential-thinking).

## Per-call outcome scoring (✅)
- ✅ index.js:1010 `scoreToolCall(fnName, fnArgs, ok, out)` → `bumpSmart(delta, 'tool:'+fn)`
  (index.js:6931). +2 success/HTTP 200, +2 write/patch, +3 scrape, +1 install/rebuild;
  −4 failed, −3 error signatures (EADDRINUSE/ERR_DLOPEN_FAILED/npm error/SyntaxError),
  −10 rm/git-reset of important .md/.js/.json/.env.

## Result cache (🔲 — see scheduler.md)
Same-call dedup via `_toolCache` keyed by `tool + hash(args)`; read-only results cached
per task. Closes "read .env 3×" → cache hit + loop flag.

## Retries vs recovery (✅ mostly, 🔲 policy)
- ✅ Empty-response retry: index.js:6228 `_emptyRetries` capped at `EMPTY_RETRY_LIMIT`
  with compaction + nudge before retry.
- ✅ API retry: callOllama retry path (index.js:6064) — up to 2 retries with backoff,
  reusing the nudge-augmented history.
- 🔲 Gap: **recovery, not blind retry.** Re-running an identical failed command is
  blocked by the redundant-modify detector (index.js:6994). Spec a recovery table:
```
on toolError(name, args, err):
  strat = RECOVERY[name] || 'change-input'
  switch strat:
    'read-error'   -> inject "read the actual stderr" nudge, do NOT retry same call
    'perm-denied'  -> inject chown/chmod fix nudge
    'port-inuse'   -> inject "find holder (lsof/ss), kill or change port" nudge
    'module-mismatch' -> inject "npm rebuild <mod>" nudge
  // never: re-run identical args (loop_guard blocks it anyway)
```
This is already half-lived via the diagnosis-timeout message templates (index.js:6987
includes a chown+npm+pm2+curl recipe); formalizing it as a table makes it deterministic.

## Verification policies (verify once) (🔲 spec)
- ✅ `node --check` is the model's own tool habit (enforced in AGENTS.md anti-hallucination).
- 🔲 Gap: a `verify-once` flag so a passed check isn't re-run. Spec:
```
_verified = new Set()             // key: verify-kind + target
function verify(kind, target, fn):
  k = kind + ':' + target
  if _verified.has(k) return _verified.get(k)
  r = fn(); _verified.set(k, r); return r
```
  Stops the "curl /health 5×" pattern (also caught by the filesystem-wandering detector,
  index.js:6652, and the loop detector).
