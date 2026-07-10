# Patching Skills Brain

This markdown brain combines patching skills from HaksterAI, Phantom IDE agent prompts, Codex-style repo discipline, Claude-style tool use, Kiro custom-agent hooks, Aider git-pairing, and local CLI agents.

Agents should pull from this file when the task involves editing code, fixing bugs, scaffolding files, wiring tools, or verifying app behavior.

## Universal Patch Contract

Every patching agent follows this loop:

1. Identify the target file, route, component, service, or config.
2. Read the smallest useful context.
3. State the intended patch surface.
4. Make one scoped change.
5. Verify with the narrowest useful command.
6. Summarize changed files and residual risk.

Hard rules:

- Preserve unrelated user changes.
- Never patch by guessing a file shape.
- Never retry a failed patch blindly.
- Never use placeholders for production code.
- Never claim verification without command output or observable evidence.
- Prefer exact patch tools over broad rewrites.
- If a file is already dirty, stage only the intended hunks when possible.

## Patching Skill Router

| User Goal | Skill To Pull | Primary Tools | Verification |
| --- | --- | --- | --- |
| Fix a bug | Debugger patch | `rg`, `read_file`, `edit_file` | failing case, syntax/test |
| Add feature | Builder patch | `read_file`, `edit_file`, `write_file` | build, smoke test |
| UI polish | Frontend patch | component/page read, CSS patch, screenshot | `npm run build`, visual check |
| Server route | API patch | server read, schema check, route patch | `node -c`, curl |
| Agent tool | Tool-loop patch | tool schema, executor, SSE/UI event | syntax, local tool call |
| MCP integration | MCP patch | config, tool server code, sample call | MCP status/call |
| Ops fix | Sysadmin patch | PM2/logs/env/health | restart only if needed, health |
| Security hardening | Secure-code patch | dependency/code review, input validation | security test/regression |
| Payments | Payments patch | server webhook, client checkout | webhook/test mode |
| Infrastructure | Infra patch | Docker/IaC/config | validate/build/plan |
| Maintenance | Maintenance patch | scan broken refs, dead code, health | checklist plus build |

## Coder Patch Skill

Use for normal production code edits.

Pattern:

1. Read package scripts and nearby implementation.
2. Locate exact symbol with `rg`.
3. Patch focused functions under existing style.
4. Add error handling and input validation.
5. Verify with syntax/test/build.

Output expectations:

- Complete changed code.
- No `TODO` or placeholder functions.
- Clear names and small functions.
- Edge cases handled.
- Security-sensitive inputs validated.

Best prompt:

```text
Use the Coder Patch Skill. Inspect the target files first, patch only the minimal implementation, then verify with the smallest command that proves it works.
```

## Builder Patch Skill

Use for scaffolding a new feature or small subsystem.

Pattern:

1. Give a 5-line architecture map: stack, routes, state, data, verification.
2. Create or patch every required file.
3. Add config/env examples when needed.
4. Add run/build/test instructions.
5. End with a file tree of created/changed files.

Required artifacts:

- Entry point or route.
- UI/component or API handler.
- Data model or schema change if needed.
- Config/env example if needed.
- Verification command.

Loop guard:

- If scaffolding touches more than 5 files, stop after the first coherent slice and verify before continuing.

## Debugger Patch Skill

Use for stack traces, runtime errors, regressions, failing tests, bad outputs, or broken UI.

Method:

1. Read the exact error message and file:line.
2. Reproduce or identify the trigger.
3. Explain root cause in one or two sentences.
4. Patch the smallest faulty expression, branch, import, selector, SQL, or route.
5. Verify with the failing scenario.
6. Add prevention if cheap: guard, validation, regression test, or clearer error.

Diff discipline:

```diff
- broken line or behavior
+ fixed line or behavior
```

Do not:

- Rewrite the file because one line failed.
- Fix symptoms without naming root cause.
- Run broad formatters unless the repo already expects it.

## Frontend Patch Skill

Use for Astro pages, components, dashboards, chat panels, tabs, scrollbars, grids, and visual polish.

Pattern:

1. Read the page/component and CSS rules around the affected UI.
2. Identify layout constraints: mobile, desktop, overflow, z-index, fixed panels.
3. Patch stable dimensions, scroll behavior, and text fit.
4. Keep operational UI dense and useful.
5. Verify with build and, when possible, screenshot/browser check.

Checks:

- Text does not overflow buttons/cards.
- Scroll containers have explicit height/flex constraints.
- No duplicate controls.
- Interactive controls have visible hover/focus states.
- Background images/logos do not block text readability.

## Phantom MD Brain Skill

This skill extracts reusable Phantom IDE prompt patterns into markdown-only guidance.

Use when:

- The user asks to combine Phantom CLI/IDE brain with Hakster.
- The agent needs app-specific patch discipline.
- A feature requires exact insertion-point instructions.

Phantom-derived patch discipline:

1. State which file(s) need changing.
2. State where CSS should be inserted.
3. State where HTML should be inserted.
4. State where JS functions should be inserted.
5. State any server route needed.
6. State the one-line wiring change.
7. Preserve the app aesthetic and existing patterns.

For Hakster, translate that to:

| Phantom Pattern | Hakster Pattern |
| --- | --- |
| single-file `phantom-ide.html` insertions | Astro component/page patch |
| `phantom-server.js` route | `server/src/index.js` route |
| `DEFAULT_AGENTS` prompt bank | markdown brain docs under `docs/agent/` |
| modal/toast/panel conventions | existing Hakster component conventions |
| ghost completion puff | Hakster SSE/TUI event/status |
| ready-to-paste blocks | committed repo patch |

Do not copy Phantom runtime UI code into Hakster unless explicitly requested. Extract roles, checklists, and workflows into markdown.

## MCP Patch Skill

Use for MCP servers, tool schema, tool aliases, and multi-tool pipelines.

Patch checklist:

1. Define tool name, description, and JSON schema.
2. Implement executor with validation and errors.
3. Add auth/env config without hardcoding secrets.
4. Add timeout/retry behavior.
5. Add sample call.
6. Verify server starts and tool call returns expected output.

Tool schema pattern:

```json
{
  "name": "tool_name",
  "description": "What the tool does and when to use it.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "target": { "type": "string" }
    },
    "required": ["target"]
  }
}
```

## AutoFlow Patch Skill

Use when one task needs multiple specialist passes.

Pipeline:

1. Architect: identify files and plan.
2. Builder: implement first slice.
3. Debugger: inspect likely failure points.
4. QA: run build/test/health.
5. Ops: restart/verify only if runtime changed.
6. Reporter: summarize changed files and evidence.

Handoff format:

```text
[STEP N - Skill]
Input:
Output:
Status:
Next:
```

Loop guard:

- Each step must produce a new artifact or new evidence.
- If two steps produce only commentary, stop and act directly.

## Sysadmin Patch Skill

Use for ports, PM2, services, logs, env, health endpoints, and local runtime fixes.

Checklist:

1. Identify process manager and cwd.
2. Read recent logs.
3. Check port/health.
4. Patch config or code.
5. Syntax check.
6. Restart only affected service.
7. Verify health.

Commands:

```bash
pm2 list
pm2 logs <app> --lines 80 --nostream
node -c server/src/index.js
curl -s http://127.0.0.1:3579/api/health
```

## Architecture Patch Skill

Use before large features.

Deliver:

- ASCII architecture diagram.
- Mermaid diagram if useful.
- File/folder structure.
- Data model.
- API endpoint list.
- Verification plan.

Then implement the first small slice only.

## Secure-Code Patch Skill

Use for auth, payments, user data, shell tools, file tools, SSRF, XSS, SQL, and red-team adjacent work.

Patch checklist:

- Validate inputs.
- Escape or parameterize outputs/queries.
- Enforce auth/session checks.
- Add rate/usage limits when abuse risk exists.
- Redact secrets from logs.
- Gate dangerous commands.
- Add safe error messages.
- Verify with one negative test and one positive test when possible.

## Payments Patch Skill

Use for Stripe/PayPal/crypto billing.

Patch checklist:

1. Product and price names.
2. Checkout/session route.
3. Webhook route.
4. Idempotency handling.
5. User/subscription DB update.
6. Customer-visible pricing card.
7. Test-mode verification.

Never log full payment secrets or webhook signing secrets.

## Infrastructure Patch Skill

Use for Docker, deploy, env, CI/CD, Terraform, PM2 ecosystem, and cloud configs.

Patch checklist:

- Complete config, not snippets.
- `.env.example` with names only.
- Least privilege.
- Health check.
- Rollback note.
- Validation command.

## Maintenance Patch Skill

Use for routine cleanup and health repair.

Scan for:

- Broken function calls.
- Missing element IDs used by JS.
- Undefined variables.
- Duplicate handlers/buttons.
- Dead CSS classes.
- Stale routes.
- Build warnings.
- PM2 restart loops.

Output:

```text
Health:
Findings:
Patches:
Verification:
Follow-ups:
```

## Skill Pull Map

Agents should load these docs in order:

1. `docs/agent/cli-agent-tool-loop.md`
2. `docs/agent/tool-call-map.md`
3. `docs/agent/multi-project-session.md`
4. `docs/agent/cli-agent-playbooks.md`
5. `docs/agent/patching-skills-brain.md`
6. `docs/agent/phantom-md-brain.md` when Phantom patterns are relevant
7. `docs/agent/hakster-phantom-unified-brain.md` when unifying Hakster and Phantom behavior

## Final Patch Checklist

- Target was inspected.
- Patch is scoped.
- No unrelated dirty files were reverted.
- Secrets were not printed or committed.
- Syntax/build/test/health check was run.
- Staged files match the user request.
- Commit message describes the real change.
- Push completed when requested.
