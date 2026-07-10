# Detailed Tool Call Map

This file defines HaksterAI's canonical tool-call format and how to translate it across Codex, Hermes/Nous, Claude, Kiro CLI, and local agents.

## Canonical Internal Shape

Hakster should normalize every provider into this shape before execution:

```ts
type CanonicalToolCall = {
  id: string;
  provider: 'anthropic' | 'openai-compatible' | 'kiro' | 'local' | 'hakster';
  model: string;
  name: string;
  args: Record<string, unknown>;
  raw?: unknown;
};
```

Tool result:

```ts
type CanonicalToolResult = {
  id: string;
  name: string;
  ok: boolean;
  content: string;
  displayContent?: string;
  metadata?: Record<string, unknown>;
};
```

## Provider Translation

### Codex / OpenAI-Compatible / Hermes / Nous

Incoming streamed tool call:

```json
{
  "choices": [
    {
      "delta": {
        "tool_calls": [
          {
            "index": 0,
            "id": "call_abc",
            "function": {
              "name": "exec_shell",
              "arguments": "{\"command\":\"npm run build\"}"
            }
          }
        ]
      }
    }
  ]
}
```

Normalize:

```js
canonical = {
  id: tc.id,
  provider: 'openai-compatible',
  model,
  name: tc.function.name,
  args: JSON.parse(accumulatedArguments),
  raw: tc,
};
```

Return result:

```json
{
  "role": "tool",
  "tool_call_id": "call_abc",
  "content": "Build passed"
}
```

### Claude / Anthropic

Incoming tool use:

```json
{
  "type": "tool_use",
  "id": "toolu_abc",
  "name": "read_file",
  "input": { "path": "server/src/index.js" }
}
```

Normalize:

```js
canonical = {
  id: block.id,
  provider: 'anthropic',
  model,
  name: block.name,
  args: block.input || {},
  raw: block,
};
```

Return result:

```json
{
  "role": "user",
  "content": [
    {
      "type": "tool_result",
      "tool_use_id": "toolu_abc",
      "content": "file contents"
    }
  ]
}
```

### Kiro CLI

Hook input should be converted into the same canonical signature for scoring:

```json
{
  "toolName": "execute_bash",
  "args": { "command": "npm run build" },
  "cwd": "/repo"
}
```

Normalize:

```js
canonical = {
  id: input.toolUseId || `${Date.now()}`,
  provider: 'kiro',
  model: input.model || 'kiro-auto',
  name: mapKiroToolName(input.toolName),
  args: input.args || {},
  raw: input,
};
```

Tool name map:

| Kiro | Hakster |
| --- | --- |
| `fs_read` | `read_file` |
| `fs_write` | `write_file` |
| `execute_bash` | `exec_shell` |
| `web_search` | `web_search` |
| MCP tool name | same name with `mcp:` prefix if needed |

## Hakster Tool Catalog

| Tool | Required Args | Optional Args | Returns | Loop Risk |
| --- | --- | --- | --- | --- |
| `read_file` | `path` | `offset`, `limit` | file text | repeated same range |
| `write_file` | `path`, `content` | none | write status | overwriting wrong file |
| `edit_file` | `path`, `old_text`, `new_text` | none | patch status | repeated failed match |
| `list_dir` | none | `path` | entries | directory wandering |
| `exec_shell` | `command` | `timeout_ms` | stdout/stderr | repeated failure, hang |
| `spawn_agent` | `task` | none | sub-agent result | unbounded delegation |
| `browser_navigate` | `url` | `wait_ms` | page status | repeated navigation |
| `browser_snapshot` | none | `full` | DOM/text summary | over-inspection |
| `browser_screenshot` | none | `full_page`, `selector` | image path | stale page |
| `generate_image` | `prompt` | `model`, `size`, `quality` | image URLs | repeated costly calls |
| `web_search` | `query` | `count` | results | broad repeated search |
| `firecrawl_scrape` | `url` | none | markdown | repeated same URL |
| `save_memory` | `key`, `value` | `category` | saved status | saving noisy facts |
| `recall_memory` | `query` | none | memories | repeated broad recall |
| `guardian` | `command` | `timeout_ms` | scan output | long/risky scans |
| `list_skills` | none | `category`, `search` | skill list | repeated broad lists |
| `read_skill` | `name` | none | skill text | reading unrelated skills |

## Routing Matrix

| User Intent | First Tool | Second Tool | Verification | Agent |
| --- | --- | --- | --- | --- |
| Fix server bug | `rg`/`read_file` | `edit_file` | `node -c`, curl health | Codex/Hakster |
| UI polish | `read_file` | `edit_file` | `npm run build`, screenshot | Codex/Hakster |
| Current docs | `web_search` | `firecrawl_scrape` | cite/source summary | Claude/Gemini/Hakster |
| Long refactor | `spawn_agent` or Kiro custom agent | patches | tests/build | Codex/Kiro |
| Local ops | PM2/status shell | targeted edit/restart | health curl/logs | Hakster terminal |
| Pentest authorized target | `guardian` | shell/web tools | report output | Hakster/Guardian |
| Image/logo | `generate_image` | file/image event | visual preview | Hakster web |
| Broad architecture | read/search many files | summary/spec | handoff checklist | Gemini/Claude |

## Tool Call Lifecycle

1. Validate tool exists.
2. Validate args schema.
3. Canonicalize args.
4. Score duplicate signature.
5. Check permission and danger gates.
6. Execute with timeout.
7. Redact secrets.
8. Split display result from model-context result.
9. Score progress.
10. Append result in active provider format.
11. Emit UI/TUI event.
12. Decide continue/final/loop-break.

## Duplicate Signature

Use stable JSON:

```js
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function toolSignature(call) {
  return `${call.name}:${canonicalJson(call.args)}`;
}
```

## Progress Score

```js
function scoreToolResult(call, result) {
  const text = String(result.content || '');
  if (/^(error|failed|exception|timeout)/i.test(text.trim())) return -1;
  if (text.trim().length < 20) return 0;
  if (['write_file', 'edit_file', 'exec_shell'].includes(call.name) && /pass|ok|success|written|updated/i.test(text)) return 2;
  if (['read_file', 'web_search', 'firecrawl_scrape'].includes(call.name)) return 1;
  return 1;
}
```

Policy:

- Score `2`: reset no-progress count.
- Score `1`: reset only if output is new.
- Score `0`: increment no-progress count.
- Score `-1`: increment tool error count.

## Dangerous Command Gate

Block or require approval for:

- `rm -rf`, `mkfs`, disk writes, partition tools.
- `git reset --hard`, destructive checkout, force push.
- Database deletes/truncates/migrations without backup.
- Credential dumps, token printing, cookie export.
- Service restarts in production unless requested or necessary.
- Network scans against targets not explicitly authorized.

## Streaming Event Contract

```ts
type AgentEvent =
  | { type: 'delta'; content: string }
  | { type: 'thinking_start' }
  | { type: 'thinking'; content: string }
  | { type: 'thinking_end' }
  | { type: 'tool_call_start'; tool_call_id: string; tool_name: string; tool_args: object }
  | { type: 'shell_start'; tool_call_id: string; command: string; cwd: string }
  | { type: 'shell_data'; tool_call_id: string; stream: 'stdout' | 'stderr'; data: string }
  | { type: 'shell_end'; tool_call_id: string; exit_code: number }
  | { type: 'tool_call_result'; tool_call_id: string; tool_name: string; tool_result: string }
  | { type: 'file_created'; path: string; tool: string }
  | { type: 'needs_confirmation'; tool_call_id: string; reason: string; command: string }
  | { type: 'loop_detected'; reason: string; message: string }
  | { type: 'turn_end'; turn: number }
  | { type: 'done'; model: string; provider: string };
```

## Concrete Examples

### Read Then Patch Then Verify

```json
[
  { "name": "read_file", "args": { "path": "server/src/index.js", "offset": 1180, "limit": 120 } },
  { "name": "edit_file", "args": { "path": "server/src/index.js", "old_text": "...", "new_text": "..." } },
  { "name": "exec_shell", "args": { "command": "node -c server/src/index.js", "timeout_ms": 60000 } }
]
```

### Web Docs Then Implementation

```json
[
  { "name": "web_search", "args": { "query": "official Astro middleware docs", "count": 3 } },
  { "name": "firecrawl_scrape", "args": { "url": "https://docs.astro.build/en/guides/middleware/" } },
  { "name": "read_file", "args": { "path": "src/middleware.ts" } },
  { "name": "edit_file", "args": { "path": "src/middleware.ts", "old_text": "...", "new_text": "..." } }
]
```

### Kiro PreToolUse Block

```json
{
  "decision": "block",
  "exitCode": 2,
  "stderr": "Repeated exec_shell call blocked. Use the previous error and choose a different verification command."
}
```

## Final Checklist For New Tools

- Add schema.
- Add executor.
- Add provider adapter mapping.
- Add display event.
- Add context truncation.
- Add duplicate signature support.
- Add dangerous-use policy.
- Add progress scoring.
- Add tests or syntax checks.
- Add docs in this map.
