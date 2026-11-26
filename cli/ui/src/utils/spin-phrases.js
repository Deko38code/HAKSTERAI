/* The run row's thinking phrases — HakTerm's own wording, wired to live state.
 *
 * Owner, 2026-11-25: "make sure all my thinking phrases or there from hakterm
 * like getting hotter warming up getting cold and wired in in the right place
 * where those phrases will show if he getting cold warmer etc at right times
 * like thinking it through when thinking calling on tools when agent is stuck to
 * know when to stop and use tools rtc".
 *
 * HakTerm (`/home/ghost/dsterm/index.html`, `_CS_PHASES`) already speaks this
 * language: it heats up when the idea engine starts, calls the execution
 * "crisp", and warns that reasoning is "getting cold" when the run stops making
 * ground. The TUI's run row used to say none of that — it printed a flat
 * "Thinking through the problem…" set that never reacted to the run. This module
 * carries the phrases over (same words, mono-safe punctuation: no colour emoji,
 * see `__tests__/glyphs.test.mjs`) and gives each one a place to show:
 *
 *   - THINK / PLAN / …  rotating phrases per phase, 1.4 s apart (HakTerm's rate);
 *   - a tool in flight  `describeToolActivity()` — "Running a command · npm test",
 *                       so a call is named while it runs instead of a generic verb;
 *   - stuck             no event for STUCK_MS (12 s, HakTerm's no-progress guard)
 *                       swaps in a phrase that tells him to stop thinking and
 *                       call a tool — "Thinking past the point — call a tool";
 *   - resume            back to THINK after ACT/OBSERVE reads "Back on task";
 *   - heat              hot / warming / cooling / cold, from the meter's own
 *                       90 s trend plus the stall clock — never from a timer.
 *
 * Everything here is pure so the mapping can be tested without a terminal.
 */

/** HakTerm's phrase rotation interval. */
export const PHRASE_MS = 1400;
/** HakTerm's ACT no-progress guard: this long with no event is "stuck". */
export const STUCK_MS = 12000;
/** How long "Back on task" stays up after reasoning resumes. */
export const RESUME_MS = 2200;

/* The HakTerm phase table, wording kept: warming up, cooling down, crisp, on
 * fire. Rotation order is the order they are written in. */
export const PHASE_PHRASES = {
  THINK: [
    'Thinking it through — heating up the idea engine',
    'Warming up the reasoning',
    'Cooling down and checking the details',
    'On fire and keeping the reasoning sharp',
  ],
  PLAN: [
    'Laying out a cooler-headed plan',
    'Making sure the steps are not getting sloppy',
  ],
  ACT: [
    'Calling on tools — putting the plan to work',
    'Keeping the execution crisp',
    'On fire and knocking out the next step',
    // Owner's own line for a working run (2026-11-26: "add that boy got the
    // flavor now when cooking"). ACT is the cooking phase — the plan actually
    // moving — so it belongs in this list and nowhere else.
    'Boy got the flavor now — cooking it right',
  ],
  OBSERVE: [
    'Checking whether anything is getting cold',
    'Giving the details a second look',
  ],
  REFLECT: [
    'Catching rough edges before they get sloppy',
    'Taking a quick breath and reviewing',
  ],
  CONSOLIDATE: [
    'Bringing the hot and cold bits together',
    'Wrapping up cleanly',
  ],
  DEFAULT: [
    'Heating up',
    'Cooling off to think clearly',
    'Keeping things crisp, not sloppy',
  ],
};

/* What to say when the run has gone quiet. Each one names the next real action,
 * so "stuck" is a prompt to use a tool rather than a decoration (owner: "when
 * agent is stuck to know when to stop and use tools"). */
export const STUCK_PHRASES = {
  THINK: [
    'Thinking past the point — stop and call a tool',
    'Reasoning is getting cold — take the next concrete step',
    'Enough thinking — run a tool and read the result',
  ],
  PLAN: [
    'The plan is drafted — stop planning and start the first step',
  ],
  ACT: [
    'Nudge · checking progress and continuing the active task',
  ],
  OBSERVE: [
    'Output is getting cold — act on what the tool returned',
  ],
  REFLECT: [
    'Review is long enough — apply the fix and move on',
  ],
  CONSOLIDATE: [
    'Wrapping up — state the answer already in hand',
  ],
  DEFAULT: [
    'Getting cold — take the next concrete step',
  ],
};

/** HakTerm's lines for the two transitions worth naming out loud. */
export const NUDGE_PHRASE = 'Nudge · checking progress and continuing the active task';
export const RESUME_PHRASE = 'Back on task · continuing the checklist';
export const ON_FIRE_PHRASE = 'On fire · difficulty increased, pushing harder';
/** A detected loop is stuck-ness the server already proved — say it at once. */
export const LOOP_PHRASE = 'Loop detected — stop repeating and change the approach';

/** True when `from` is reasoning after doing: the run has just resumed. */
export function isResume(from, to) {
  const a = String(from || '').toUpperCase();
  const b = String(to || '').toUpperCase();
  return b === 'THINK' && (a === 'ACT' || a === 'OBSERVE' || a === 'REFLECT');
}

/** One tool argument, trimmed to something a single row can show. */
function short(value, max = 44) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** The first meaningful word of an argument object (cmd · path · pattern · query). */
function targetOf(args = {}) {
  const a = args && typeof args === 'object' ? args : {};
  const pickList = [
    a.cmd, a.command, a.script && Array.isArray(a.script) ? a.script.join(' ') : a.script,
    a.path, a.file, a.file_path, a.filename, a.target,
    a.pattern, a.query, a.q, a.url, a.selector, a.name,
  ];
  for (const value of pickList) {
    const t = short(value);
    if (t) return t;
  }
  return '';
}

const baseName = (p) => {
  const t = String(p || '').replace(/[/\\]+$/, '');
  const parts = t.split(/[/\\]/);
  return parts[parts.length - 1] || t;
};

const TOOL_VERBS = [
  [/^(exec_shell|run_shell|shell|bash|run_command|terminal)$/i, 'Running a command'],
  [/^(read_file|view_file|open_file|read)$/i, 'Reading source'],
  [/^(write_file|edit_file|apply_patch|patch|create_file|str_replace_editor)$/i, 'Updating a file'],
  [/^(grep_search|grep|search_files|search|codebase_search|rg)$/i, 'Searching for evidence'],
  [/^(list_dir|ls|list_files|glob)$/i, 'Inspecting project files'],
  [/^(snapshot|scrape|fetch_url|browser|playwright_\w+|web_search)$/i, 'Checking a live page'],
];

/**
 * Name what a tool is actually doing, HakTerm style: verb + target.
 * `describeToolActivity('exec_shell', { cmd: 'npm test' })`
 *   → "Running a command · npm test"
 */
export function describeToolActivity(name, args = {}) {
  const raw = String(name || '').trim();
  const target = targetOf(args);
  // MCP tools carry their server in the name (mcp__server__tool).
  const label = raw.startsWith('mcp__')
    ? raw.split('__').slice(1).filter(Boolean).join(' · ') || 'MCP tool'
    : raw;
  if (!raw) return 'Calling on tools';
  for (const [re, verb] of TOOL_VERBS) {
    if (!re.test(raw)) continue;
    // A file tool reads better with just the basename than a long absolute path.
    const shown = /^(read_file|view_file|open_file|write_file|edit_file|apply_patch|patch|create_file|str_replace_editor)$/i.test(raw)
      ? short(baseName(target), 32)
      : target;
    return shown ? `${verb} · ${shown}` : verb;
  }
  if (/^(update_todo|plan|todo)$/i.test(raw)) return 'Updating the checklist';
  if (raw.startsWith('mcp__')) return `Using ${label}`;
  return target ? `Using ${raw} · ${target}` : `Using ${raw}`;
}

/**
 * How warm the run reads, from the meter's own 90 s trend and the stall clock —
 * never from a timer. `hot` means outcomes are landing, `cold` means the run has
 * gone quiet, `cool` means the last window slipped.
 */
export function heatOf({ trend = 'steady', stalledMs = 0 } = {}) {
  if (Number(stalledMs) >= STUCK_MS) return 'cold';
  if (trend === 'smarter') return 'hot';
  if (trend === 'slipping') return 'cool';
  return 'warm';
}

/** The word shown on the row beside the phase. */
export function heatWord(heat) {
  return heat === 'hot' ? 'hot' : heat === 'cool' ? 'cooling' : heat === 'cold' ? 'cold' : 'warming';
}

/** Colour for that word; matches the meters row's own green/amber/red. */
export function heatColor(heat) {
  return heat === 'hot' ? '#3fb950' : heat === 'cool' ? '#d29922' : heat === 'cold' ? '#f85149' : '#a5b4c3';
}

/** Pick one phrase out of a rotating list; safe for any index. */
export function phraseAt(list, index) {
  const items = Array.isArray(list) && list.length ? list : PHASE_PHRASES.DEFAULT;
  const i = Math.max(0, Math.floor(Number(index) || 0)) % items.length;
  return items[i];
}

/**
 * The phrase the row should print right now, and why.
 *
 * Priority: a proven loop → a resuming run → a tool in flight → a stalled run →
 * the phase's own warming/cooling phrases rotating.
 */
export function phraseFor({ phase, tool, activity = '', index = 0, resumed = false, stalledMs = 0, loop = false } = {}) {
  const normalized = String(phase || 'DEFAULT').toUpperCase();
  const info = PHASE_PHRASES[normalized] ? normalized : 'DEFAULT';
  if (loop) return { text: LOOP_PHRASE, kind: 'loop' };
  if (resumed) return { text: RESUME_PHRASE, kind: 'resume' };
  const name = tool && (tool.name || tool.tool_name) ? String(tool.name || tool.tool_name) : '';
  if (name) {
    return { text: describeToolActivity(name, tool.args || tool.tool_args || {}), kind: 'tool' };
  }
  // A prose `activity` prop still wins (some callers pass a ready-made line).
  const ready = String(activity || '').trim();
  if (ready && ready.includes(' ')) return { text: ready, kind: 'activity' };
  if (Number(stalledMs) >= STUCK_MS) {
    return { text: phraseAt(STUCK_PHRASES[info] || STUCK_PHRASES.DEFAULT, index), kind: 'stuck' };
  }
  return { text: phraseAt(PHASE_PHRASES[info], index), kind: 'phase' };
}
