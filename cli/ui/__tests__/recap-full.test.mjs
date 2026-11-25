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
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

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

test('an id survives a dedup merge, so /recap #id still finds the run', () => {
  // The dedup path keeps the existing row and drops the new one — which used to
  // drop the new run's `#id` too, leaving the panel's handle pointing at
  // nothing. Run the real recorder against a throwaway home so production
  // memory is never touched.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hakster-recap-'));
  const before = process.env.HAKSTER_HOME;
  process.env.HAKSTER_HOME = home;
  try {
    const require = createRequire(import.meta.url);
    const autolearn = require(path.join(root, 'server/src/agent/autolearn.js'));
    const base = { task: 'dedup probe', tools: 4, ok: 4, fail: 0, points: 8, learned: 1, failures: [] };
    const first = autolearn.recordRecap({ ...base, id: '#tst001' });
    const second = autolearn.recordRecap({ ...base, id: '#tst002' });
    assert.equal(first.written, 1, 'the first run writes its entry');
    assert.equal(second.written, 0, 'an identical run merges instead of duplicating');
    const raw = autolearn.readRawMemories();
    const tagged = (id) => raw.filter((m) => Array.isArray(m.tags) && m.tags.includes(id)).length;
    assert.equal(tagged('#tst001'), 1, 'the surviving entry still carries the original id');
    assert.equal(tagged('#tst002'), 1, 'the merged run is still reachable by its own id');
    // Bounded: many merges cannot grow the tag list without limit.
    for (let i = 0; i < 12; i += 1) autolearn.recordRecap({ ...base, id: `#bulk${String(i).padStart(2, '0')}` });
    const after = autolearn.readRawMemories().find((m) => Array.isArray(m.tags) && m.tags.includes('#bulk11'));
    assert.ok(after, 'the newest merged id is kept');
    const ids = after.tags.filter((t) => /^#[a-z0-9]{3,16}$/i.test(t));
    assert.ok(ids.length <= 8, `ids are bounded (got ${ids.length})`);
    assert.ok(!ids.includes('#tst001'), 'the oldest ids fall off first');
  } finally {
    if (before === undefined) delete process.env.HAKSTER_HOME;
    else process.env.HAKSTER_HOME = before;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('the keyed recap pointer has a category it is allowed to use', () => {
  // /api/agent/session-summary writes one keyed record under `recap#id`. The
  // category was not on the allow-list, so every write threw and the endpoint's
  // own catch swallowed it — the pointer never existed.
  const src = read('server/src/memory.js');
  assert.match(src, /^\s*'recap',$/m, "'recap' is a valid memory category");
  assert.match(read('server/src/index.js'), /category: 'recap',/, 'the endpoint still asks for it');
});
