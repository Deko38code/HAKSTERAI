/* The run row speaks HakTerm's thinking phrases, and each one shows at the
 * moment it is true.
 *
 * Owner, 2026-11-25: "make sure all my thinking phrases or there from hakterm
 * like getting hotter warming up getting cold and wired in in the right place
 * where those phrases will show if he getting cold warmer etc at right times
 * like thinking it through when thinking calling on tools when agent is stuck to
 * know when to stop and use tools rtc".
 *
 * Pinned here:
 *   1. HakTerm's actual wording is present per phase (warming / cooling / crisp /
 *      on fire), not a flat generic set;
 *   2. a tool in flight is named by `describeToolActivity` — verb · target;
 *   3. a run with no event for 12 s prints a "stop thinking, call a tool" line;
 *   4. heat (hot / warming / cooling / cold) comes from the meter's measured
 *      trend plus the stall clock, never from a timer;
 *   5. the component and App actually pass the stall clock and the trend in.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PHASE_PHRASES,
  STUCK_MS,
  RESUME_PHRASE,
  heatColor,
  heatOf,
  heatWord,
  isResume,
  phraseAt,
  phraseFor,
  describeToolActivity,
} from '../src/utils/spin-phrases.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..', '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

test('the phrases are HakTerm\'s: warming up, cooling down, crisp, on fire', () => {
  const all = Object.values(PHASE_PHRASES).flat().join(' | ');
  for (const phrase of [
    'heating up the idea engine',
    'Warming up the reasoning',
    'Cooling down and checking the details',
    'On fire and keeping the reasoning sharp',
    'Keeping the execution crisp',
    'Calling on tools',
    'Checking whether anything is getting cold',
    'Catching rough edges before they get sloppy',
    'Bringing the hot and cold bits together',
  ]) {
    assert.ok(all.includes(phrase), `HakTerm's "${phrase}" must be present`);
  }
  for (const phase of ['THINK', 'PLAN', 'ACT', 'OBSERVE', 'REFLECT', 'CONSOLIDATE', 'DEFAULT']) {
    assert.ok(Array.isArray(PHASE_PHRASES[phase]) && PHASE_PHRASES[phase].length, `${phase} has phrases`);
  }
  // Thinking says it is thinking; acting says it calls tools.
  assert.ok(PHASE_PHRASES.THINK.some((p) => /thinking/i.test(p)), 'THINK says thinking');
  assert.ok(PHASE_PHRASES.ACT.some((p) => /tools/i.test(p)), 'ACT says tools');
});

test('a tool in flight is named: verb · target', () => {
  assert.equal(describeToolActivity('exec_shell', { cmd: 'npm test' }), 'Running a command · npm test');
  assert.equal(describeToolActivity('read_file', { path: '/home/ghost/haksterAi/cli/ui/src/App.jsx' }), 'Reading source · App.jsx');
  assert.match(describeToolActivity('write_file', { path: '/tmp/a/b/c.js' }), /^Updating a file · c\.js$/);
  assert.match(describeToolActivity('grep_search', { pattern: 'recordRecap' }), /^Searching for evidence · recordRecap$/);
  assert.match(describeToolActivity('mcp__filesystem__read_file', {}), /^Using filesystem · read_file$/);
  assert.match(describeToolActivity('some_custom_tool', { query: 'x' }), /^Using some_custom_tool · x$/);
  assert.ok(describeToolActivity('').length > 0, 'never an empty phrase');
});

test('hot, warming, cooling, cold — from the meter and the stall clock', () => {
  assert.equal(heatOf({ trend: 'smarter', stalledMs: 0 }), 'hot');
  assert.equal(heatOf({ trend: 'slipping', stalledMs: 0 }), 'cool');
  assert.equal(heatOf({ trend: 'steady', stalledMs: 0 }), 'warm');
  // A quiet run is cold no matter what the meter last said.
  assert.equal(heatOf({ trend: 'smarter', stalledMs: STUCK_MS }), 'cold');
  assert.equal(heatWord('hot'), 'hot');
  assert.equal(heatWord('warm'), 'warming');
  assert.equal(heatWord('cool'), 'cooling');
  assert.equal(heatWord('cold'), 'cold');
  assert.equal(heatColor('hot'), '#3fb950');
  assert.equal(heatColor('cold'), '#f85149');
});

test('stuck says stop thinking and use a tool, at HakTerm\'s 12 s', () => {
  assert.equal(STUCK_MS, 12000);
  const thinking = phraseFor({ phase: 'THINK', stalledMs: STUCK_MS });
  assert.equal(thinking.kind, 'stuck');
  assert.match(thinking.text, /stop and call a tool/i);
  // Every phase has something to say when it goes quiet, and it names an action.
  for (const phase of ['THINK', 'PLAN', 'ACT', 'OBSERVE', 'REFLECT', 'CONSOLIDATE', 'DEFAULT']) {
    const out = phraseFor({ phase, stalledMs: STUCK_MS + 5000, index: 0 });
    assert.equal(out.kind, 'stuck', `${phase} has a stuck line`);
    assert.ok(out.text.length > 10, `${phase} stuck line is a sentence`);
  }
  // Before the threshold it is still the phase's own phrase.
  assert.equal(phraseFor({ phase: 'THINK', stalledMs: STUCK_MS - 1 }).kind, 'phase');
});

test('precedence: resumed → tool → stuck → phase, and rotation is by index', () => {
  assert.equal(isResume('ACT', 'THINK'), true);
  assert.equal(isResume('OBSERVE', 'THINK'), true);
  assert.equal(isResume('PLAN', 'THINK'), false);
  assert.equal(isResume('THINK', 'ACT'), false);
  assert.equal(phraseFor({ phase: 'THINK', resumed: true, stalledMs: STUCK_MS * 2 }).text, RESUME_PHRASE);
  assert.match(
    phraseFor({ phase: 'ACT', tool: { name: 'exec_shell', args: { cmd: 'ls' } }, stalledMs: STUCK_MS }).text,
    /^Running a command · ls$/,
    'a live tool outranks both the stall and the phase',
  );
  const a = phraseFor({ phase: 'THINK', index: 0 }).text;
  const b = phraseFor({ phase: 'THINK', index: 1 }).text;
  assert.notEqual(a, b, 'the phrases rotate');
  assert.equal(phraseAt([], 3).length > 0, true, 'an empty list falls back, never prints nothing');
});

test('the row and App are wired to the real clocks', () => {
  const row = read('cli/ui/src/components/CrushStatus.jsx');
  assert.ok(row.includes("from '../utils/spin-phrases.js'"), 'the row uses the phrase module');
  assert.match(row, /progressAt = 0/, 'the row takes the stall clock');
  assert.match(row, /trend = 'steady'/, 'and the meter trend');
  assert.match(row, /heatOf\(\{ trend, stalledMs \}\)/, 'heat is measured, not invented');
  assert.match(row, /isResume\(prev, normalizedPhase\)/, 'resuming is detected from the phase change');

  const app = read('cli/ui/src/App.jsx');
  assert.match(app, /progressAt=\{agent\.progressAtRef\?\.current \|\| 0\}/, 'App passes the run\'s last event time');
  assert.match(app, /trend=\{agent\.meters\?\.health\?\.trend \|\| 'steady'\}/, 'App passes the measured trend');
  assert.match(app, /tool=\{activeTool\}/, 'App passes the tool in flight so it can be named');

  const hook = read('cli/ui/src/hooks/useAgentStream.js');
  assert.match(hook, /progressAtRef\.current = Date\.now\(\);/, 'the hook stamps every event');
  assert.ok(hook.includes('progressAtRef,'), 'and exposes the clock');
});
