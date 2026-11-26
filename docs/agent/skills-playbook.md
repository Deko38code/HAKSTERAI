# Skills Playbook — Make a Quickskill From What We Learn

Owner direction, 2026-11-26: *"add skills playbook were we can make qickskill from what we learn"*.
A skill turns one run's measured lesson into something the next run starts with — so the same
mistake is never paid for twice.

## What a skill is here

A skill is **one markdown file** in the living bank:

| Where | What it is |
| --- | --- |
| `~/.hakster/skills/<slug>.md` | the living bank — auto-extracted and operator-captured skills |
| `~/.hakster/skills/index.json` | that bank's own index (one honest row per file) |
| `.hakster/skills/` (repo) | curated, committed project skills |

`GET /api/agent/skills` lists both, and the dashboard page `/admin/skills` shows them. Nothing else
needs to know a skill exists — the list is read from the files.

## Two ways a skill gets written

**1. Automatically — `extractSkillFromMemories`** (`server/src/agent/autolearn.js`). When the same
tagged pattern recurs `SKILL_RECURRENCE_THRESHOLD` (3+) times, consolidation writes the skill for
you. No human, no prompt.

**2. On purpose — quickskill**, right after a run taught you something:

```
/quickskill port conflict on restart                       # files the LAST recap's mistakes + lessons
/quickskill port conflict on restart :: also check pm2 max # adds your own line
```

The same thing over HTTP:

```bash
curl -s -X POST http://127.0.0.1:3580/api/agent/quickskill \
  -H 'content-type: application/json' \
  -d '{"name":"port conflict on restart","recap":"#a3f9k2","notes":"check pm2 max restarts too"}'
```

Fields: `name` (required), `recap` (`#a3f9k2` — bare `/quickskill` uses the last run), `notes`,
`steps` (array or newline string), `description`, `trigger`. Want to see what will be filed first?
`GET /api/agent/recap/<id>` — or just `/recap #id` in the TUI.

## What qualifies — and what does not

A capture is worth making when it is **measured**:

- a fix **with a reading behind it** (the command that showed it working — §13, §50.1);
- a failure that **repeats**, with a concrete trigger you can recognise next time;
- a procedure that **took more than one try**, where the wrong first move is now known.

It is **not** a skill if it is a guess, a plan not yet carried out, or something unverified. That is
exactly why the endpoint **refuses** a capture with no recap and no note: an empty skill is worse
than no skill — it teaches nothing and it hides that nothing was learned.

## File shape

```markdown
# <title>

## Description
one line — what this skill is for

## Trigger
use when …

## Steps
1. …
2. …

## Mistakes not to repeat
- what already went wrong once

## What worked
- the move that actually fixed it

## Operator note
the line you typed after `::`

## Source
recap #a3f9k2 · captured 2026-11-26T…
```

Two sections are **never** written: an invented `## Confidence` and any step the run did not take.
Only the auto-extractor records a confidence, and it is the average of its own source observations —
a capture says where it came from and stops there.

## Rules that hold for every capture

- **Measured only** — the recap's own mistakes and lessons, plus your note. §10, §13, §50.1.
- **Never overwrite** — the same name twice appends a dated section and keeps the first capture's
  text; `triggerCount` goes up, the history stays. §2.4, §49.1.
- **Slugged and banked** — the name becomes a filename, so a path-shaped name cannot escape the bank.
- **No cross-project writes** — skills land in this project's bank only. §16.
- **Refusals are honest** — a refused capture says why (`name is required`, `nothing learned to
  capture`), never a fake success.

## Verification

Both capture paths are pinned:

```bash
node server/__smoke__/quickskill-probe.mjs   # 6 checks: refusal, content, append, slug, index
cd cli && npm test                           # the TUI/CLI suite
```

The probe slices the **real handler** out of `server/src/index.js` and runs it against a temp bank,
so deleting the refusal or overwriting a skill fails there instead of filing bad data.

## Worked example — the steer change itself

The 2026-11-26 steer rework is exactly the kind of lesson this captures:

```
/quickskill steer must not interrupt a live answer :: drains at the turn boundary instead of aborting the stream
```

What would be filed: the mistake (`the stream loop aborted mid-reply to take a steer, so the answer
the operator was watching was cut`), what worked (`drain the inbox at the top of the next turn and
at run end; on claude-cli take it after the child closes`), and the source (`recap #id`). Next time
steering is touched, the run starts with that instead of rediscovering it.
