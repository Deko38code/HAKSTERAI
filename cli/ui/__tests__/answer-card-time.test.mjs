/* The answer card names him HAKSTER-AI and states how long he took.
 *
 * Owner, 2026-11-26: "add on hakster output card to HAKSTER-AI AND HIS TIME HE
 * TOOK TO RESPOND ON CARD".
 *
 * Pinned here:
 *   1. the assistant role's label is HAKSTER-AI (the user's and system's are
 *      untouched);
 *   2. the card header draws the turn's own `ms` through fmtDur, and draws
 *      nothing when it is absent — a turn with no measurement shows no time
 *      (§10);
 *   3. useAgentStream stamps that `ms` once, from startedAtRef, on the ladder's
 *      shared exit path, so success, failure and cancel all get the same real
 *      number and a re-render cannot move it;
 *   4. the shipped bundle carries the label, so an installed copy shows it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cliRoot = path.resolve(here, '..', '..');
const BLOCK = fs.readFileSync(path.join(cliRoot, 'ui', 'src', 'components', 'MessageBlock.jsx'), 'utf8');
const STREAM = fs.readFileSync(path.join(cliRoot, 'ui', 'src', 'hooks', 'useAgentStream.js'), 'utf8');
const BUNDLE_PATH = path.join(cliRoot, 'ui-fb.mjs');

test('the answer card is labelled HAKSTER-AI', () => {
  assert.match(BLOCK, /assistant: \{ border: 'gray', label: 'HAKSTER-AI' \}/, 'the assistant label names him');
  assert.match(BLOCK, /user: \{ border: 'cyan', label: 'you' \}/, 'the user label is unchanged');
  assert.match(BLOCK, /system: \{ border: 'yellow', label: 'system' \}/, 'the system label is unchanged');
});

test('the card header states the measured response time', () => {
  assert.match(BLOCK, /message\.role === 'assistant' && message\.ms != null/, 'only his finished card carries a time');
  assert.match(BLOCK, /fmtDur\(message\.ms\)/, 'the time is formatted by the same helper the tool rows use');
});

test('the duration is measured once, on every exit path', () => {
  assert.match(STREAM, /const turnMs = startedAtRef\.current \? Math\.max\(0, Date\.now\(\) - startedAtRef\.current\) : 0;/,
    'one measurement from the turn start');
  assert.match(STREAM, /patch\(assistantId, \(m\) => \(\{ \.\.\.m, ms: turnMs, finishedAt: Date\.now\(\) \}\)\)/,
    'stamped onto the turn\'s own message, so a dropped card leaves no orphan time');
  assert.match(STREAM, /setElapsedMs\(turnMs\)/, 'the header clock and the card agree');
  // The stamp must sit after the ladder loop, not inside a success branch: a
  // cancelled or failed turn still took real time.
  const loop = STREAM.indexOf('for (let i = 0; i < attempts.length; i++)');
  const stamp = STREAM.indexOf('const turnMs = startedAtRef.current');
  assert.ok(loop > 0 && stamp > loop, 'the stamp is on the shared exit path');
});

test('the card above the input bar names him and shows his time', () => {
  const panel = fs.readFileSync(path.join(cliRoot, 'ui', 'src', 'components', 'LiveOutputPanel.jsx'), 'utf8');
  const app = fs.readFileSync(path.join(cliRoot, 'ui', 'src', 'App.jsx'), 'utf8');
  assert.match(panel, /name = 'HAKSTER-AI',/, 'the panel carries the name by default');
  assert.match(panel, /title=\{`\$\{busy \? '▶ Live' : '▶ Result'\} · \$\{name\}\$\{durSuffix\(ms\)\}`\}/,
    'the title states the name and the measured duration');
  assert.match(app, /ms=\{agent\.elapsedMs\}/, 'the run clock feeds the card');
  // The sidebar card was explicitly out of scope (owner, 2026-11-26: "NOT
  // SIDEBAR MIDDLE ONE"), so it keeps its plain title.
  const sidebar = fs.readFileSync(path.join(cliRoot, 'ui', 'src', 'components', 'LiveSidebar.jsx'), 'utf8');
  assert.match(sidebar, /title="▶ Output"/, 'the sidebar output panel is left as it was');
});

test('one formatter, so the two cards cannot disagree', () => {
  const dur = fs.readFileSync(path.join(cliRoot, 'ui', 'src', 'utils', 'duration.js'), 'utf8');
  assert.match(dur, /export function fmtDur\(ms\)/, 'the shared formatter exists');
  assert.match(BLOCK, /import \{ fmtDur \} from '\.\.\/utils\/duration\.js';/, 'the transcript card uses it');
  assert.ok(!/function fmtDur\(ms\) \{/.test(BLOCK), 'the transcript card no longer keeps its own copy');
});

test('an install gets it too, not only this checkout', () => {
  if (!fs.existsSync(BUNDLE_PATH)) return; // before a build there is no bundle to check
  const bundle = fs.readFileSync(BUNDLE_PATH, 'utf8');
  assert.ok(bundle.includes('HAKSTER-AI'), 'ui-fb.mjs was rebuilt after the label change');
  assert.ok(bundle.includes('durSuffix'), 'ui-fb.mjs was rebuilt after the panel title change');
});
