# Claude (Anthropic) Patching & Runtime Notes

## Overview
This note consolidates Claude/Anthropic-related provider, credential, and model-discovery details found in the Hermes agent workspace (`~/.hermes/hermes-agent`). Unlike Codex, Claude is integrated as a direct API provider rather than a subprocess app-server runtime.

## Integration shape
- Anthropic is registered in `hermes_cli/auth.py` as a standard entry in `PROVIDER_REGISTRY`:
  - `id="anthropic"`, `name="Anthropic"`
  - `inference_base_url="https://api.anthropic.com"`
  - `api_key_env_vars=("ANTHROPIC_API_KEY", "ANTHROPIC_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN")`
  - `base_url_env_var="ANTHROPIC_BASE_URL"`
- There is no `claude_runtime.py` / app-server bridge analogous to `agent/codex_runtime.py`. Claude traffic goes straight through the Anthropic Messages API via:
  - `agent/anthropic_adapter.py`
  - `agent/transports/anthropic.py`
  - `plugins/model-providers/anthropic`

## Credential resolution order
`get_anthropic_key()` (auth.py) walks the registry's env vars in order:
1. `ANTHROPIC_API_KEY`
2. `ANTHROPIC_TOKEN`
3. `CLAUDE_CODE_OAUTH_TOKEN`

## Explicit-configuration gating
`is_provider_explicitly_configured("anthropic")` exists specifically to stop Hermes from silently borrowing Claude Code's own credentials. It requires one of:
1. `auth.json` `active_provider == "anthropic"`
2. `config.yaml` `model.provider == "anthropic"`
3. A provider env var set — but `CLAUDE_CODE_OAUTH_TOKEN` is explicitly excluded from this check (it's set by Claude Code itself, not by a user choosing Anthropic inside Hermes)
4. A credential-pool entry sourced from an **explicit** flow the user ran inside Hermes (manual add / device-code / PKCE) — ambient/borrowed sources like `claude_code`, `gh_cli`, `qwen-cli` are intentionally excluded from counting as "explicit"

This means Hermes can *see* a locally-authenticated Claude Code session but will not silently use it as the active provider without the user opting in.

## OAuth / auth flow coverage (by test file, `tests/`)
- `test_anthropic_oauth_pkce.py` — PKCE device flow
- `test_anthropic_oauth_flow.py` — general OAuth flow
- `test_anthropic_oauth_routes_to_messages_api.py` — ensures OAuth-authenticated sessions route to the native Messages API, not a chat/completions shim
- `test_anthropic_oauth_ua_prefix.py` — user-agent prefix handling for OAuth requests
- `test_anthropic_third_party_oauth_guard.py` — guards against cross-provider OAuth token reuse
- `test_anthropic_provider_persistence.py`, `test_anthropic_model_flow_stale_oauth.py` — persistence and stale-token handling

## Behavioral edge cases covered by tests
- `test_anthropic_prompt_cache_policy.py` — prompt caching policy
- `test_anthropic_truncation_continuation.py` — continuation after truncation
- `test_anthropic_thinking_block_order.py` — extended-thinking block ordering
- `test_anthropic_kwargs_sanitize.py` — request kwarg sanitization
- `test_anthropic_output_field_leak.py` — prevents internal fields leaking into output
- `test_anthropic_mcp_prefix_strip.py` — MCP tool-name prefix stripping
- `test_28161_anthropic_stream_pool_cleanup.py` — stream/connection pool cleanup (issue #28161)
- `test_auxiliary_anthropic_pool_fallback_regression.py` — auxiliary-client pool fallback

## Model discovery
Anthropic model slugs appear in `hermes_cli/models.py`, `config.py`, `moa_config.py`, and `model_setup_flows.py`:
- `anthropic/claude-opus-4.8` (and `-fast` variant, "2x price, higher output speed")
- `anthropic/claude-sonnet-4-6`
- Bedrock-style ARNs: `us.anthropic.claude-sonnet-4-6`, `us.anthropic.claude-opus-4-6`, `us.anthropic.claude-haiku-4-5`
- Default suggested model in config scaffolding: `anthropic/claude-sonnet-4`

## Mismatch guard
`auth.py` (~line 6540-6580) explicitly guards against sending a model string shaped like `anthropic/claude-opus-4.6` to a direct-API provider that doesn't understand the `anthropic/` prefix — a common misconfiguration when switching between OpenRouter-style and direct-API routing.

## Operational recommendations
- Prefer `ANTHROPIC_API_KEY` for scripted/headless use; it's checked first.
- Don't rely on `CLAUDE_CODE_OAUTH_TOKEN` from Hermes — it's intentionally excluded from "explicit configuration" checks and from auto-borrowing.
- When switching model strings between direct-API and OpenRouter-style routing, keep the `anthropic/` prefix consistent with the active provider to avoid the mismatch guard rejecting the request.

## Summary
Claude support in Hermes is a first-class direct-API provider (not a subprocess runtime like Codex), with explicit-consent gating around credential borrowing, full OAuth/PKCE support, and dedicated regression coverage for prompt caching, truncation, thinking-block ordering, and MCP tool naming.
