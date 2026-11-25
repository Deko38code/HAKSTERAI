/* The idle recap has a FULL form at the bottom of the chat column, and the
 * recap ids live in it.
 *
 * Owner, 2026-11-26: "fix our recap to work like claude's does with fullrecap
 * while idle in bottom where our recap ids are".
 *
 * Four things are pinned:
 *   1. the panel renders the run it recaps (id, task, tools, mistakes), the
 *      session facts, and — the request — the session's recap ids with how to
 *      read one back;
 *   2. the panel never exceeds its row budget and picks its lines by priority,
 *      so a short column loses counts before it loses the ids;
 *   3. the hook keeps a capped, de-duplicated recap history and hands it out;
 *   4. App grows the one-row receipt into the panel only from rows the
 *      transcript can spare, and shrinks the transcript by exactly those rows.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..', '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

test('the full recap renders the run, its mistakes and the recap ids', () => {
  const src = read('cli/ui/src/components/RecapPanel.jsx');
  for (const prop of ['recap', 'history', 'lines', 'learned', 'memWritten', 'tokensKnown']) {
    assert.ok(src.includes(prop), `RecapPanel must take ${prop}`);
  }
  assert.ok(src.includes("text: 'full recap'"), 'the panel names itself');
  assert.ok(src.includes('run complete'), 'the panel states the outcome');
  assert.ok(src.includes("kind: 'ids'") || src.includes("key: 'ids'"), 'the panel has an ids line');
  assert.match(src, /\/recap #id/, 'the ids line says how to read one back');
  assert.match(src, /text: '✗ ', fg: 'red'/, 'the run\'s mistakes are on the panel');
  assert.match(src, /run failed/, 'a failed run says so');
  assert.match(src, /session totals/, 'with no finished run the panel states session totals');
  assert.match(src, /learned \$\{lrn\} from \$\{from\}/, 'learned names its source');
  // Fitting is by priority, so a short column keeps the id before the counts.
  assert.match(src, /prio: 95/, 'the ids line is ranked');
  assert.ok(src.indexOf('prio: 95') < src.indexOf('prio: 40'), 'ids outrank the session line');
  assert.match(src, /slice\(0, budget\)/, 'the panel is capped at its row budget');
});

test('the hook keeps a capped, de-duplicated recap history', () => {
  const src = read('cli/ui/src/hooks/useAgentStream.js');
  assert.match(src, /const \[recapHistory, setRecapHistory\] = useState\(\[\]\)/, 'history state');
  assert.match(
    src,
    /setRecapHistory\(\(prev\) => \[recap, \.\.\.prev\.filter\(\(one\) => one\.id !== recap\.id\)\]\.slice\(0, 25\)\)/,
    'each finished run is prepended once and the list is capped',
  );
  assert.match(src, /one\.id === recapId \? \{ \.\.\.one, memWritten: Number\(data\.written\) \|\| 0 \}/, 'the history entry learns what memory took');
  assert.ok(src.includes('    recapHistory,'), 'the hook exposes the history');
  // The recap carries its own clock so the panel never borrows another run's.
  assert.match(src, /ms: turnMs/, 'the recap records its own elapsed time');
});

test('App grows the receipt into the panel from spare transcript rows only', () => {
  const app = read('cli/ui/src/App.jsx');
  assert.ok(app.includes("import RecapPanel from './components/RecapPanel.jsx'"), 'the panel is imported');
  assert.match(app, /const recapSpare = showRecap \? Math\.max\(0, transcriptRows - 4\) : 0/, 'only spare rows are offered');
  assert.match(app, /const showFullRecap = showRecap && recapExtra >= 2/, 'a short column keeps the one-row receipt');
  assert.match(app, /const transcriptRowsFinal = Math\.max\(4, transcriptRows - \(showFullRecap \? recapExtra : 0\)\)/, 'the transcript gives up exactly those rows');
  assert.match(app, /height=\{transcriptRowsFinal\}/, 'the transcript renders its reduced height');
  assert.match(app, /<RecapPanel[\s\S]{0,900}history=\{agent\.recapHistory\}/, 'the panel gets the recap ids');
  assert.match(app, /<Recap[\s\S]{0,200}recapId=\{agent\.lastRecap\?\.id/, 'the one-row receipt still exists');
  // Bare /recap lists several runs with their ids.
  assert.match(app, /hist\.length > 1/, 'several runs get a readable index');
  assert.match(app, /\/recap #id reads one back out of memory/, 'the index says how to read one');
});
