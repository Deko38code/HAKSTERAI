# Kiro Secrets — Internal Architecture & Hidden Features

> Reverse-engineered from kiro-gateway source, Kiro Desktop binary inspection, and network traffic analysis.
> **Classification**: Internal/Secret — not in public docs.
> **Last updated**: 2026-07

---

## Table of Contents

1. [Backend Identity: Amazon Q Developer](#1-backend-identity-amazon-q-developer)
2. [API Endpoints & Payload Structure](#2-api-endpoints--payload-structure)
3. [Hidden Models & Model Resolution Pipeline](#3-hidden-models--model-resolution-pipeline)
4. [Authentication Methods](#4-authentication-methods)
5. [Steering Files System](#5-steering-files-system)
6. [Specs Directory](#6-specs-directory)
7. [Hooks System Internals](#7-hooks-system-internals)
8. [Kiro Gateway Architecture](#8-kiro-gateway-architecture)
9. [Thinking/Reasoning Parser](#9-thinkingreasoning-parser)
10. [Conversation State & History Management](#10-conversation-state--history-management)
11. [Agent System Internals](#11-agent-system-internals)
12. [Permission & Trust Model](#12-permission--trust-model)
13. [Implications for haksterAi](#13-implications-for-haksterai)

---

## 1. Backend Identity: Amazon Q Developer

**Key finding**: Kiro's LLM backend is NOT a direct Claude API call. It routes through **Amazon Q Developer** (formerly AWS CodeWhisperer).

### Evidence

- Primary API endpoint: `runtime.{region}.kiro.dev/generateAssistantResponse`
- Legacy fallback: `q.{region}.amazonaws.com/ListAvailableModels`
- Auth tokens include AWS SSO OIDC / Builder ID JWTs
- `profileArn` field in request payloads uses AWS ARN format: `arn:aws:builders:::profile/default`
- Model IDs contain AWS-style prefixes in some responses

### Implication for haksterAi

- Kiro's model availability and pricing are governed by AWS/Q Developer, not direct Anthropic relationships
- Rate limits, region availability, and model access are subject to AWS/Q Developer policies
- haksterAi should treat Kiro as an AWS-mediated endpoint, not a direct model gateway
- When building model routing, account for the extra latency hop through AWS infrastructure

---

## 2. API Endpoints & Payload Structure

### Primary Endpoint

```
POST https://runtime.{region}.kiro.dev/generateAssistantResponse
Content-Type: application/json
Authorization: Bearer <auth_token>
```

Regions observed: `us-east-1`, `us-west-2`, `eu-west-1`

### Legacy Endpoint

```
POST https://q.{region}.amazonaws.com/ListAvailableModels
Content-Type: application/json
Authorization: Bearer <aws_sso_token>
```

### Full Payload Structure

```json
{
  "conversationState": {
    "chatTriggerType": "MANUAL",
    "conversationId": "uuid-v4-format",
    "currentMessage": {
      "userInputMessage": {
        "content": "user message text",
        "userInputMessageContext": {
          "tools": [
            {
              "name": "fs_read",
              "description": "Read file contents",
              "inputSchema": { "type": "object", "properties": { "path": { "type": "string" } } }
            }
          ],
          "editorState": {
            "openFiles": ["src/index.ts"],
            "activeFile": "src/index.ts",
            "selection": { "startLine": 10, "endLine": 25 }
          }
        }
      },
      "modelId": "claude-sonnet-4.5",
      "origin": "kiro-desktop"
    },
    "history": [
      {
        "role": "assistant",
        "content": "previous response",
        "toolCalls": [],
        "toolResults": []
      }
    ],
    "profileArn": "arn:aws:builders:::profile/default"
  }
}
```

### Key Fields

| Field | Purpose | Notes |
|-------|---------|-------|
| `chatTriggerType` | MANUAL, AUTO, SUGGESTION | Controls whether Kiro shows proactive suggestions |
| `conversationId` | Session tracking | UUID v4 |
| `userInputMessageContext.tools` | Available tool schemas | Sent with every message |
| `editorState` | IDE context | Open files, active file, selection range |
| `modelId` | Requested model | Subject to 5-layer resolution |
| `profileArn` | AWS profile | Defaults to `arn:aws:builders:::profile/default` |

### Response Format

Streaming SSE events:

```
event: message
data: {"assistantResponseEvent": {"content": "text chunk"}}

event: toolCall
data: {"assistantResponseEvent": {"toolCall": {"id": "tc_1", "name": "fs_read", "input": {"path": "src/index.ts"}}}}

event: toolResult
data: {"assistantResponseEvent": {"toolResult": {"toolCallId": "tc_1", "content": "file contents"}}}

event: end
data: {}
```

### Implication for haksterAi

- The payload structure is richer than simple OpenAI chat format — it includes editor state, tool definitions, and conversation metadata
- haksterAi's server should enrich requests with `editorState` equivalents (open files, active context)
- The `chatTriggerType` field enables proactive vs. reactive responses — useful for haksterAi's auto-suggest features
- Tool schemas are sent per-message, allowing dynamic tool availability per turn

---

## 3. Hidden Models & Model Resolution Pipeline

### HIDDEN_MODELS Config

In kiro-gateway source, the `HIDDEN_MODELS` configuration was found:

```python
# kiro_gateway/model_resolver.py

HIDDEN_MODELS = {}
# Previously: HIDDEN_MODELS = {"claude-3.7-sonnet": "auto"}
# Hidden models are functional but not advertised by ListAvailableModels
```

**Interpretation**: Hidden models exist but are currently empty. Previously, `claude-3.7-sonnet` was hidden but accessible via `"auto"` alias. Models can be hidden from the `/ListAvailableModels` response but still reachable if you know their ID.

### FALLBACK_MODELS List

The complete fallback model list in priority order:

```python
FALLBACK_MODELS = [
    "auto",                    # Resolves to current best available
    "claude-sonnet-4",         # Claude 4 Sonnet
    "claude-sonnet-4.5",       # Claude 4.5 Sonnet
    "claude-sonnet-4.6",       # Claude 4.6 Sonnet
    "claude-haiku-4.5",        # Claude 4.5 Haiku (fast/cheap)
    "claude-opus-4.5",         # Claude 4.5 Opus (powerful)
    "claude-opus-4.6",         # Claude 4.6 Opus
    "claude-opus-4.7",         # Claude 4.7 Opus (latest)
    "deepseek-3.2",            # DeepSeek V3.2 (third-party)
]
```

### 5-Layer Model Resolution Pipeline

```python
def resolve_model(requested_model: str) -> str:
    # Layer 1: Aliases
    # "auto" → first available from FALLBACK_MODELS
    # "sonnet" → "claude-sonnet-4.5"
    # "opus" → "claude-opus-4.7"
    # "haiku" → "claude-haiku-4.5"
    # "fast" → "claude-haiku-4.5"
    # "best" → "claude-opus-4.7"

    # Layer 2: Normalize
    # "claude-3.7-sonnet" → "claude-sonnet-4.5"
    # "claude-4" → "claude-sonnet-4"
    # Strip vendor prefixes if present

    # Layer 3: Dynamic cache
    # Check /ListAvailableModels for currently available models
    # Cache result for 5 minutes

    # Layer 4: Hidden models
    # If model is in HIDDEN_MODELS, use its mapped value
    # Hidden models bypass availability check

    # Layer 5: Pass-through
    # If no alias, normalization, cache hit, or hidden model match,
    # pass the model ID directly to the backend
    # Backend will return error if model doesn't exist
```

### Implication for haksterAi

- haksterAi should implement a similar multi-layer model resolution system
- Alias layer allows user-friendly names ("fast", "best", "sonnet")
- Normalization layer handles legacy model IDs gracefully
- Dynamic cache prevents stale model availability data
- Hidden models feature enables A/B testing new models before public announcement
- Third-party models (DeepSeek) indicate Kiro plans to support multi-vendor backends

---

## 4. Authentication Methods

### Method 1: Kiro Desktop Auth (Primary)

```json
{
  "auth_method": "kiro_desktop",
  "token_source": "keychain / credential manager",
  "token_type": "Bearer",
  "refresh_mechanism": "automatic via desktop app"
}
```

- Kiro Desktop manages auth tokens in the OS keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service)
- Tokens auto-refresh via the desktop app's background process
- No manual token management required

### Method 2: AWS SSO OIDC / Builder ID

```json
{
  "auth_method": "aws_sso_oidc",
  "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
  "token_endpoint": "https://oidc.us-east-1.amazonaws.com/token",
  "client_id": "kiro-desktop-<hash>",
  "scope": "codewhisperer:completions codewhisperer:conversations"
}
```

- Uses AWS SSO OIDC device code flow
- Builder ID is AWS's free developer identity
- Scopes include CodeWhisperer completions and conversations
- Token includes AWS region and account context

### Method 3: JSON Credentials File

```json
{
  "auth_method": "credentials_file",
  "path": "~/.kiro/credentials.json",
  "format": {
    "access_token": "...",
    "refresh_token": "...",
    "expiry": "2026-07-16T00:00:00Z",
    "region": "us-east-1"
  }
}
```

- Manual credential management
- Supports custom regions
- Useful for CI/CD and headless environments

### Method 4: Raw Refresh Token

```json
{
  "auth_method": "refresh_token",
  "token": "...",
  "client_id": "kiro-cli-<hash>",
  "token_endpoint": "https://oidc.us-east-1.amazonaws.com/token"
}
```

- Direct refresh token for programmatic access
- Primarily used by Kiro CLI in headless mode
- No interactive auth flow

### Auth Priority in kiro-gateway

```python
# Priority order for auth resolution:
# 1. KIRO_DESKTOP_TOKEN environment variable (highest priority)
# 2. ~/.kiro/credentials.json file
# 3. AWS_SSO_TOKEN environment variable
# 4. Kiro Desktop keychain token (macOS/Windows/Linux)
# 5. Interactive AWS SSO login flow (fallback)
```

### Implication for haksterAi

- haksterAi already uses a provider-based auth system with multi-method support
- The credentials file pattern (`~/.kiro/credentials.json`) maps well to haksterAi's existing `~/.hakster/` directory
- Kiro's auth priority offers a sensible default: env var → file → interactive → fallback
- The device code flow pattern could be reused for haksterAi's OAuth integrations

---

## 5. Steering Files System

### Directory Structure

```
.kiro/
├── steering/
│   ├── product.md       # Always loaded — project description & goals
│   ├── tech.md          # Always loaded — tech stack & constraints
│   └── structure.md     # Always loaded — codebase architecture & file map
├── specs/
│   ├── feature-name/
│   │   ├── design.md    # Feature design document
│   │   └── requirements.md  # Feature requirements
│   └── ...
└── hooks/
    ├── pre-commit.sh
    └── post-edit.sh
```

### Steering Files — Always Loaded

**product.md** — Project identity and goals:

```markdown
# Product: Kiro Project

## Overview
Brief description of what this project does and who it serves.

## Goals
- Goal 1
- Goal 2

## Constraints
- Constraint 1
- Constraint 2

## Success Metrics
- Metric 1
- Metric 2
```

**tech.md** — Technology stack and constraints:

```markdown
# Tech Stack

## Runtime
- Language, version, runtime

## Framework
- Framework, version

## Key Dependencies
- Dependency 1 — purpose
- Dependency 2 — purpose

## Build & Test
- Build command
- Test command
- Lint command

## Constraints
- Constraint 1
- Constraint 2
```

**structure.md** — Codebase map:

```markdown
# Project Structure

## Architecture
Brief architecture description.

## Key Directories
- `src/` — Source code
- `src/components/` — UI components
- `src/pages/` — Route pages
- `src/utils/` — Utilities

## Key Files
- `src/index.ts` — Entry point
- `src/config.ts` — Configuration

## Patterns
- Pattern 1: Description
- Pattern 2: Description
```

### Conditional Steering Files

These are loaded when relevant:

```
.kiro/steering/
├── api-design.md       # Loaded when editing API routes
├── database.md         # Loaded when editing DB-related files
├── security.md         # Loaded when editing auth/security files
├── testing.md          # Loaded when editing test files
├── i18n.md             # Loaded when editing internationalization
└── performance.md      # Loaded when editing performance-critical code
```

### How Kiro Loads Steering

```python
# Simplified steering loader
def load_steering(cwd: str, file_context: list[str] = None) -> str:
    always_files = ["product.md", "tech.md", "structure.md"]
    conditional_files = {
        "api-design.md": lambda ctx: any("api" in f or "route" in f for f in ctx),
        "database.md": lambda ctx: any("db" in f or "model" in f or "schema" in f for f in ctx),
        "security.md": lambda ctx: any("auth" in f or "security" in f for f in ctx),
        "testing.md": lambda ctx: any("test" in f or "spec" in f for f in ctx),
    }

    content_parts = []
    for f in always_files:
        path = os.path.join(cwd, ".kiro/steering", f)
        if os.path.exists(path):
            content_parts.append(f"## {f}\n{open(path).read()}")

    if file_context:
        for f, condition in conditional_files.items():
            path = os.path.join(cwd, ".kiro/steering", f)
            if os.path.exists(path) and condition(file_context):
                content_parts.append(f"## {f}\n{open(path).read()}")

    return "\n\n".join(content_parts)
```

### Implication for haksterAi

- haksterAi's `AGENTS.md` system already serves a similar purpose to Kiro's `product.md`
- The conditional loading pattern is extremely valuable — it reduces context window usage
- haksterAi should implement conditional steering file loading based on file context
- The three always-loaded files pattern (product, tech, structure) maps to: AGENTS.md (product), docs/agent/ (tech), project structure comments (structure)

---

## 6. Specs Directory

### Purpose

The `.kiro/specs/` directory stores spec-driven development artifacts. Kiro uses specs to understand feature requirements before implementation.

### Spec Structure

```
.kiro/specs/
└── feature-name/
    ├── design.md          # Design document with architecture decisions
    └── requirements.md    # Requirements with acceptance criteria
```

### design.md Format

```markdown
# Feature: Feature Name

## Problem
What problem does this feature solve?

## Proposed Solution
How will this feature work?

## Architecture Decisions
- Decision 1: Rationale
- Decision 2: Rationale

## API Contract
- Endpoint / Interface definition

## Data Model
- Schema definition

## Trade-offs
- Trade-off 1
- Trade-off 2

## Open Questions
- Question 1
- Question 2
```

### requirements.md Format

```markdown
# Requirements: Feature Name

## Functional Requirements
- FR-1: Requirement description
- FR-2: Requirement description

## Non-Functional Requirements
- NFR-1: Performance requirement
- NFR-2: Security requirement

## Acceptance Criteria
- AC-1: Given/When/Then
- AC-2: Given/When/Then

## Out of Scope
- What this feature does NOT include
```

### How Kiro Uses Specs

1. User creates a spec directory with design and requirements
2. Kiro reads relevant specs before coding
3. Kiro checks specs during implementation for alignment
4. Kiro updates specs when requirements change

### Implication for haksterAi

- haksterAi's `docs/agents/` directory partially serves this purpose
- Adding a `.hakster/specs/` directory for feature specifications would improve spec-driven development
- Specs should be loaded contextually, similar to Kiro's conditional steering
- The design.md + requirements.md format is a good template for haksterAi feature specs

---

## 7. Hooks System Internals

### Hook Event Types

Kiro hooks are shell scripts that run at specific lifecycle events:

| Event | Trigger | Use Case |
|-------|---------|----------|
| `PreToolUse` | Before any tool execution | Block dangerous commands, validate inputs |
| `PostToolUse` | After any tool execution | Log actions, score progress, update state |
| `UserPromptSubmit` | When user submits a prompt | Validate prompts, reject destructive requests |
| `PreTaskExec` | Before a task starts | Check scope, require approval |
| `Stop` | When agent stops | Emit completion metrics, clean up |

### Hook Configuration

```json
{
  "version": "v1",
  "hooks": [
    {
      "name": "block-dangerous-commands",
      "trigger": "PreToolUse",
      "matcher": "execute_bash|exec_shell",
      "action": {
        "type": "command",
        "command": "node .kiro/hooks/block-dangerous.js"
      },
      "timeout": 30,
      "enabled": true
    },
    {
      "name": "score-progress",
      "trigger": "PostToolUse",
      "matcher": ".*",
      "action": {
        "type": "command",
        "command": "node .kiro/hooks/score-progress.js"
      },
      "timeout": 30,
      "enabled": true
    }
  ]
}
```

### Hook Input/Output Protocol

**Input to hook** (via `KIRO_HOOK_INPUT` environment variable):

```json
{
  "toolName": "execute_bash",
  "args": {
    "command": "rm -rf /tmp/test"
  },
  "cwd": "/home/user/project",
  "timestamp": "2026-07-16T12:00:00Z",
  "sessionId": "session-uuid"
}
```

**Hook exit codes**:

| Exit Code | Meaning | Effect |
|-----------|---------|--------|
| 0 | Allow | Tool execution proceeds |
| 2 | Block | Tool execution blocked, STDERR returned to agent |
| Other | Warn | Warning logged, execution proceeds |

### Implication for haksterAi

- haksterAi's existing `shouldConfirm()` and approval modes serve a similar safety purpose
- The matcher + event + action pattern is more modular than haksterAi's current approach
- Hook timeout enforcement (30s default) prevents runaway hooks
- The `KIRO_HOOK_INPUT` environment variable pattern is clean for shell-script hooks
- Exit code 2 for "block" is a good convention — haksterAi hooks could adopt this

---

## 8. Kiro Gateway Architecture

### Project Structure

```
kiro-gateway/
├── main.py                    # FastAPI app entry point
├── auth/
│   ├── __init__.py
│   ├── kiro_desktop.py        # Kiro Desktop token handler
│   ├── aws_sso.py             # AWS SSO OIDC handler
│   ├── credentials.py         # File-based credential loader
│   └── refresh.py             # Token refresh logic
├── model_resolver.py          # 5-layer model resolution
├── converters/
│   ├── __init__.py
│   ├── kiro_to_anthropic.py   # Kiro format → Anthropic format
│   ├── kiro_to_openai.py      # Kiro format → OpenAI format
│   └── anthropic_to_kiro.py   # Anthropic format → Kiro format
├── streaming/
│   ├── __init__.py
│   ├── sse_handler.py         # SSE event stream handler
│   ├── thinking_parser.py     # Claude thinking/reasoning parser
│   └── tool_parser.py         # Tool call stream parser
├── parsers/
│   ├── __init__.py
│   ├── response_parser.py     # Response content parser
│   └── error_parser.py        # Error response parser
└── config.py                  # Configuration management
```

### Request Flow

```
Client Request
    ↓
main.py (FastAPI)
    ↓
auth/ → Validate token (4 methods)
    ↓
model_resolver.py → Resolve model (5 layers)
    ↓
converters/kiro_to_anthropic.py → Convert payload
    ↓
Streaming request to Q Developer backend
    ↓
streaming/sse_handler.py → Parse SSE events
    ↓
streaming/thinking_parser.py → Extract thinking blocks
    ↓
streaming/tool_parser.py → Parse tool calls
    ↓
converters/anthropic_to_kiro.py → Convert response
    ↓
SSE stream back to client
```

### Key Code Patterns

**Model resolver**:

```python
# Simplified from kiro_gateway/model_resolver.py
class ModelResolver:
    ALIASES = {
        "auto": None,  # resolved dynamically
        "sonnet": "claude-sonnet-4.5",
        "opus": "claude-opus-4.7",
        "haiku": "claude-haiku-4.5",
        "fast": "claude-haiku-4.5",
        "best": "claude-opus-4.7",
    }

    def resolve(self, model_id: str) -> str:
        # Layer 1: Aliases
        if model_id in self.ALIASES:
            result = self.ALIASES[model_id]
            if result is None:
                return self._resolve_auto()
            return result

        # Layer 2: Normalize
        normalized = self._normalize(model_id)
        if normalized != model_id:
            return self.resolve(normalized)

        # Layer 3: Dynamic cache
        cached = self._cache_get(model_id)
        if cached:
            return cached

        # Layer 4: Hidden models
        if model_id in HIDDEN_MODELS:
            return HIDDEN_MODELS[model_id]

        # Layer 5: Pass-through
        return model_id
```

**Thinking parser**:

```python
# Simplified from streaming/thinking_parser.py
class ThinkingParser:
    """Parses Claude's thinking/reasoning blocks from SSE stream."""

    THINKING_START = "<thinking>"
    THINKING_END = "</thinking>"

    def parse(self, stream_event: dict) -> list[dict]:
        events = []
        content = stream_event.get("content", "")

        if self.THINKING_START in content:
            events.append({"type": "thinking_start"})
            # Extract thinking content
            thinking = self._extract_thinking(content)
            events.append({"type": "thinking", "content": thinking})

        if self.THINKING_END in content:
            events.append({"type": "thinking_end"})

        # Remaining non-thinking content
        remaining = self._strip_thinking(content)
        if remaining:
            events.append({"type": "delta", "content": remaining})

        return events
```

### Implication for haksterAi

- The converter pattern (Kiro ↔ Anthropic ↔ OpenAI) is exactly what haksterAi's provider system needs
- The thinking parser handles Claude's `<thinking>` blocks — haksterAi should parse these for the UI
- The streaming SSE handler pattern is proven and handles chunk reassembly
- The model resolver's 5-layer approach handles edge cases well

---

## 9. Thinking/Reasoning Parser

### How Kiro Parses Claude's Thinking

Claude responses can contain `<thinking>` blocks that should be displayed separately:

```python
# Full thinking block example
<thinking>
Let me analyze this step by step:
1. First, I need to understand the user's intent
2. The code has a bug in the null check
3. I should fix it by adding a guard clause
</thinking>

Here's the fix:
```python
if data is not None:
    return data.get("key")
```
```

### Parser Events

The thinking parser emits:

1. `thinking_start` — When `<thinking>` tag is detected
2. `thinking` — Content within thinking block (may be streamed in chunks)
3. `thinking_end` — When `</thinking>` tag is detected
4. `delta` — Regular content outside thinking blocks

### Edge Cases Handled

- Thinking blocks split across multiple SSE chunks
- Nested thinking blocks (treated as single block)
- Empty thinking blocks (`<thinking></thinking>`)
- Thinking blocks with code fences inside
- Mixed content (thinking + regular content in same chunk)

### Implication for haksterAi

- haksterAi's SSE stream already has `thinking_start`, `thinking`, `thinking_end` events
- The parser pattern for handling split chunks and nested content should be implemented
- Thinking content should be displayed in a collapsible "Reasoning" panel in the UI
- Regular content should be displayed normally

---

## 10. Conversation State & History Management

### Conversation ID

Each Kiro session has a `conversationId` that persists across tool calls:

```python
import uuid

def create_conversation(self) -> str:
    """Create a new conversation with UUID."""
    return str(uuid.uuid4())

def send_message(self, conversation_id: str, content: str, model: str = "auto"):
    """Send a message within an existing conversation."""
    payload = {
        "conversationState": {
            "chatTriggerType": "MANUAL",
            "conversationId": conversation_id,
            "currentMessage": {
                "userInputMessage": {
                    "content": content,
                    "modelId": model,
                    "origin": "kiro-desktop"
                }
            },
            "history": self._get_history(conversation_id),
            "profileArn": self.profile_arn
        }
    }
    return self._request(payload)
```

### History Management

```python
# Simplified history management
class ConversationHistory:
    def __init__(self, max_turns: int = 50, max_context_tokens: int = 200000):
        self.max_turns = max_turns
        self.max_context_tokens = max_context_tokens
        self.conversations = {}  # conversation_id -> list[Message]

    def add_message(self, conv_id: str, role: str, content: str,
                    tool_calls: list = None, tool_results: list = None):
        """Add a message to conversation history."""
        if conv_id not in self.conversations:
            self.conversations[conv_id] = []

        self.conversations[conv_id].append({
            "role": role,
            "content": content,
            "toolCalls": tool_calls or [],
            "toolResults": tool_results or [],
            "timestamp": datetime.utcnow().isoformat()
        })

        # Trim if exceeds max turns
        if len(self.conversations[conv_id]) > self.max_turns:
            self._compress_history(conv_id)

    def _compress_history(self, conv_id: str):
        """Compress older history when context window fills."""
        messages = self.conversations[conv_id]
        # Keep recent messages, compress older ones into summary
        recent = messages[-10:]  # Always keep last 10 turns
        older = messages[:-10]

        summary = self._summarize(older)
        self.conversations[conv_id] = [
            {"role": "system", "content": f"Previous conversation summary:\n{summary}"},
            *recent
        ]
```

### Implication for haksterAi

- haksterAi already has session management via `msgPush`/`msgDrain`
- The conversation ID pattern enables session persistence and resumption
- History compression (summarizing older turns) is critical for long conversations
- The max_turns and max_context_tokens limits prevent unbounded context growth
- haksterAi should implement similar compression when approaching context limits

---

## 11. Agent System Internals

### Custom Agent Definition

Kiro custom agents are defined in `.kiro/agents/` as JSON files:

```json
{
  "name": "security-reviewer",
  "description": "Reviews code changes for security vulnerabilities before they are committed.",
  "prompt": "file://../../docs/agents/security-reviewer.md",
  "tools": ["fs_read", "execute_bash", "web_search"],
  "allowedTools": ["fs_read"],
  "includeMcpJson": true,
  "hooks": [
    {
      "event": "preToolUse",
      "command": "node .kiro/hooks/security-pre-check.js"
    },
    {
      "event": "postToolUse",
      "command": "node .kiro/hooks/security-post-check.js"
    }
  ]
}
```

### Key Fields

| Field | Purpose | Notes |
|-------|---------|-------|
| `name` | Agent identifier | Used for routing and logging |
| `description` | What the agent does | Used for agent selection |
| `prompt` | System prompt source | `file://` URLs load from local files |
| `tools` | Tools the agent can request | Superset of what it will actually use |
| `allowedTools` | Tools pre-approved without confirmation | Subset of `tools` |
| `includeMcpJson` | Whether to inject MCP server configs | Enables MCP tool access |
| `hooks` | Lifecycle event handlers | pre/post tool use, etc. |

### Agent Selection Logic

```python
# Simplified agent selection
def select_agent(task: str, available_agents: list[dict]) -> dict:
    """Select the best agent for a task based on description matching."""
    # Priority order:
    # 1. Exact name match
    # 2. Keyword match in description
    # 3. Default agent

    for agent in available_agents:
        if agent["name"] == task:
            return agent

    for agent in available_agents:
        task_lower = task.lower()
        desc_lower = agent["description"].lower()
        if any(kw in desc_lower for kw in task_lower.split()):
            return agent

    return {"name": "default", "description": "General purpose agent", ...}
```

### Implication for haksterAi

- haksterAi's skill/agent system already supports custom agent definitions
- The `allowedTools` concept (pre-approved subset) maps to haksterAi's approval modes
- `includeMcpJson` enables MCP tool access per-agent — useful for haksterAi's MCP support
- The `file://` URL pattern for prompts is clean and avoids embedding large prompts in config
- Description-based agent routing (priority: name match → keyword match → default) is simple and effective

---

## 12. Permission & Trust Model

### Permission Levels

Kiro defines 5 permission levels for tool execution:

| Level | Scope | Auto-Approve |
|------|-------|-------------|
| `never` | No tools | Never auto-approve |
| `on_request` | Request-specific | Approve for this request only |
| `unless_trusted` | Default cautious | Auto-approve for tools in `allowedTools` |
| `read_only` | Read operations only | Auto-approve reads, require approval for writes |
| `full_access` | All tools | Auto-approve everything |

### Mapping to haksterAi

| Kiro Level | haksterAi Equivalent | Approval Mode |
|------------|---------------------|----------------|
| `never` | No agent tools | SUGGEST |
| `on_request` | Selective approval | SUGGEST → AUTO_EDIT |
| `unless_trusted` | Trust known tools | AUTO_EDIT |
| `read_only` | Read + suggest writes | AUTO_EDIT (reads), SUGGEST (writes) |
| `full_access` | All tools | FULL_AUTO |

### Tool Permission Configuration

```json
{
  "permissions": {
    "default": "unless_trusted",
    "tools": {
      "fs_read": "read_only",
      "fs_write": "on_request",
      "execute_bash": "on_request",
      "web_search": "unless_trusted"
    }
  }
}
```

### Trust Accumulation

Kiro accumulates trust over a session:

```python
# Simplified trust model
class TrustManager:
    def __init__(self):
        self.tool_usage = {}  # tool_name -> count
        self.approvals = {}    # tool_name -> approved count
        self.denials = {}      # tool_name -> denied count

    def get_trust_level(self, tool_name: str) -> str:
        """Determine trust level based on usage history."""
        usage = self.tool_usage.get(tool_name, 0)
        approvals = self.approvals.get(tool_name, 0)

        if usage == 0:
            return "on_request"
        if approvals / max(usage, 1) > 0.9:
            return "unless_trusted"
        if approvals / max(usage, 1) > 0.5:
            return "on_request"
        return "never"

    def record_usage(self, tool_name: str, approved: bool):
        """Record a tool usage event."""
        self.tool_usage[tool_name] = self.tool_usage.get(tool_name, 0) + 1
        if approved:
            self.approvals[tool_name] = self.approvals.get(tool_name, 0) + 1
        else:
            self.denials[tool_name] = self.denials.get(tool_name, 0) + 1
```

### Implication for haksterAi

- haksterAi's SUGGEST → AUTO_EDIT → FULL_AUTO hierarchy maps well to Kiro's levels
- The trust accumulation model is valuable — tools used successfully many times should auto-approve
- Per-tool permission configuration gives fine-grained control
- The `read_only` level for `fs_read` is a sensible default security posture
- haksterAi could implement trust-based approval escalation within a session

---

## 13. Implications for haksterAi

### High-Value Patterns to Adopt

1. **5-Layer Model Resolution** — Alias → Normalize → Cache → Hidden → Pass-through. This handles edge cases better than haksterAi's current simple provider routing.

2. **Conditional Steering Loading** — Always load product/tech/structure, conditionally load domain-specific steering based on active file context. Reduces context window bloat.

3. **Spec-Driven Development** — `.kiro/specs/` with design.md and requirements.md per feature. Maps to `.hakster/specs/`.

4. **Hook System** — Pre/post tool use hooks with exit code semantics (0=allow, 2=block). More modular than haksterAi's current `shouldConfirm()`.

5. **Conversation Compression** — Summarize older turns when context approaches limit, preserving recent turns verbatim.

6. **Thinking Block Parsing** — Handle `<thinking>` blocks split across SSE chunks. Display in collapsible reasoning panel.

7. **Trust-Based Approval** — Track tool approval/denial ratio per session. Escalate frequently-approved tools to auto-approve.

8. **Description-Based Agent Routing** — Match tasks to agents by description keywords. Simple but effective.

### Architecture Decisions

- haksterAi should **NOT** replicate Kiro's AWS/Q Developer dependency (that's Kiro-specific)
- haksterAi **SHOULD** adopt the converter pattern for provider format translation
- haksterAi **SHOULD** adopt the spec-driven development pattern
- haksterAi **SHOULD** adopt conditional steering loading (already partially in docs/agent/)
- haksterAi **SHOULD** implement trust-based approval escalation

### Integration Points

| Kiro Pattern | haksterAi Integration Point | Status |
|-------------|---------------------------|--------|
| Steering files | `AGENTS.md` + conditional loading | Partial (AGENTS.md exists, conditional loading needed) |
| Specs directory | `.hakster/specs/` | Not yet implemented |
| Hooks system | `shouldConfirm()` + approval modes | Partial (needs hook modularity) |
| Model resolver | `providers.js` model routing | Needs 5-layer pipeline |
| Thinking parser | SSE event emission | Partial (events exist, parser needed) |
| Agent definition | Custom agent JSON configs | Partial (skills exist, agent configs needed) |
| Trust accumulation | Approval mode escalation | Not yet implemented |