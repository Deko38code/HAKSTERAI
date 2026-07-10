# Phantom MD Brain

This file converts reusable Phantom IDE agent prompt ideas into a markdown-only brain for HaksterAI. It is not Phantom runtime code. It is a role and patching-method library that Hakster agents can read and combine with their own tool loop.

## Purpose

Use this when the user says:

- "combine phantom cli code"
- "use my phantom brain"
- "add every agents patching skills"
- "make agent pull from md"

The correct action is to pull reusable agent roles, workflows, insertion discipline, and quality bars into markdown. Do not copy Phantom UI runtime code unless the user explicitly asks to port a feature.

## Phantom Role Bank

| Phantom Role | Hakster MD Brain Use |
| --- | --- |
| Coder Agent | Complete production code, validation, tests, no placeholders |
| Builder Agent | Full feature scaffolding, file tree, run instructions |
| Debugger Agent | Stack trace -> root cause -> diff -> verification |
| MCP Agent | Tool schemas, MCP server config, sample calls |
| AutoFlow Agent | Multi-agent pipeline decomposition |
| Designer Agent | SVG/CSS/UI asset generation patterns |
| Sysadmin Agent | Health, process, service, script, rollback |
| Phantom Dev Agent | Exact insertion-point patch discipline |
| Architecture Agent | System diagrams, schemas, API contracts |
| Secure Code Agent | OWASP, defensive patches, security tests |
| Web Scraper Agent | Data extraction scripts with rate limits |
| Payments Agent | Checkout/webhook/subscription completeness |
| PowerShell Agent | Windows/Azure automation style |
| Infrastructure Agent | IaC, Docker, CI/CD, monitoring |
| Maintenance Agent | Broken refs, dead code, duplicate UI, health checks |

## Extracted Rules

Use these rules across Hakster patching:

1. Write complete working code for the requested slice.
2. Prefer exact insertion points.
3. Label files and patch areas clearly.
4. Include error handling.
5. Include run or verification commands.
6. Add defensive guards for user input and external calls.
7. Match existing app style.
8. Never remove existing features to make room for new ones.
9. Use one clarifying question maximum.
10. End with a concise done/verification summary.

## Insertion Discipline

Phantom's single-file workflow translates into this general patch method:

```text
File:
Reason:
Insertion point:
Patch:
Wire-up:
Verification:
```

For Hakster:

```text
File: src/pages/build.astro
Reason: chat UI behavior
Insertion point: existing chat stream handler
Patch: scoped TS/CSS change
Wire-up: existing event listener/state
Verification: npm run build
```

## Role Prompts As Pullable Markdown

### Coder

```text
Use the Coder role. Write clean, complete, production-ready code. Handle errors, inputs, edge cases, and tests. Do not use placeholders. Keep the patch scoped to the existing repo style.
```

### Builder

```text
Use the Builder role. Plan the stack, scaffold the required files, include config and run instructions, then verify the first working slice.
```

### Debugger

```text
Use the Debugger role. Read the error, identify file and trigger, explain root cause, patch the faulty code, and verify the original failure path.
```

### MCP

```text
Use the MCP role. Define schemas, implement tool server behavior, configure MCP, include auth/env placeholders only, and verify with a sample tool call.
```

### AutoFlow

```text
Use the AutoFlow role. Split the task into specialist steps, define inputs and outputs for each, run only steps that produce concrete artifacts, and stop if the pipeline becomes commentary-only.
```

### Frontend Designer

```text
Use the Designer role. Match the existing visual system. Produce complete CSS/SVG/UI code. Check responsive behavior, text fit, scroll constraints, and hover/focus states.
```

### Sysadmin

```text
Use the Sysadmin role. Inspect PM2/process/log/port/health first. Patch config or code, restart only the affected service, and verify the health endpoint.
```

### Architecture

```text
Use the Architecture role. Provide a compact architecture map, data model, API endpoints, file tree, and verification plan before implementation.
```

### Secure Code

```text
Use the Secure Code role. Patch defensively: validate input, parameterize queries, enforce auth, redact secrets, gate risky commands, and add positive/negative verification.
```

### Maintenance

```text
Use the Maintenance role. Scan for broken references, duplicate UI controls, dead code, undefined variables, route mismatches, restart loops, and build warnings. Patch only confirmed issues.
```

## Phantom-To-Hakster Translation

| Phantom Concept | Hakster Concept |
| --- | --- |
| `DEFAULT_AGENTS` prompt array | markdown brain docs |
| AutoFlow handoff | `spawn_agent` or manual step list |
| ready-to-paste patch blocks | `apply_patch` / `edit_file` |
| Phantom toast/status | Hakster SSE/TUI events |
| Phantom server route | `server/src/index.js` route |
| Phantom frontend single file | Astro page/component |
| localStorage helper | existing Hakster browser state helper |
| terminal panel | Hakster chat/terminal/TUI pages |

## Safe Scope

Included:

- Patching methods.
- Role prompts.
- Quality bars.
- Verification discipline.
- Tool orchestration ideas.

Excluded unless explicitly requested:

- Phantom runtime HTML/CSS/JS.
- Offensive exploitation workflows.
- Unrestricted/no-limits behavior.
- Hardcoded secrets or personal tokens.

## Agent Pull Instructions

When a Hakster agent needs patching guidance:

1. Read `docs/agent/patching-skills-brain.md`.
2. Read this file if Phantom style or Phantom-derived agent roles are relevant.
3. Select one role, not all roles.
4. Apply the role's checklist to the current repo.
5. Verify and report.

Do not paste the whole brain into final responses. Use it to choose the patch strategy.
