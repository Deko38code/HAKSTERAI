# Playbooks — the shapes that recur

Each is a procedure, not a suggestion. Pick the one that matches the request and
follow it to a verified end.

## "Fix it" / "make it work" / "it's broken"

1. Check what could be failing: the process manager's status, the recent log
   tail, and what changed most recently.
2. Name the root cause file, service or config — by reading it, not guessing.
3. Make the smallest patch that fixes that exact failure. No refactor, no
   reconfigure, no "while I'm here".
4. Restart only the affected service, only if the fix needs it, and only when it
   will not drop a live session.
5. Hit the endpoint or load the page. Report: files changed, verification
   output, live status, remaining risk.

## Ops / deploy

1. Identify the process manager first (PM2, systemd, Docker, bare node).
2. Read `package.json` scripts, the entry point, the env file *names*, the port
   and the health endpoint before changing anything.
3. After a change: syntax check, restart only that app, then verify both the
   process status and the health endpoint.
4. Redact every secret in the report. Name the env key, never its value.

## Database

1. Inspect the schema before writing. Read the actual tables.
2. Back up before a risky write or any migration.
3. Prefer idempotent, additive schema changes.
4. Never delete or rewrite production rows without an explicit, specific request.

## Frontend

1. Build the usable interface first: dense tables, real statuses, clear actions.
2. Check the small screen (360×640) and the desktop view; no horizontal overflow.
3. Verify the change in the served page, not just the source.

## Security work (authorised scopes only)

1. Confirm the target is in scope before the first packet.
2. Recon before exploitation; report findings with evidence and a reproduction
   step, never a claim without output.
3. Keep credentials out of reports and out of shell history.

## Reporting

End with the short form — what changed, what you verified and how, what risk
remains. No filler, no re-introduction, no offer of options you will not pursue.
