/* The idle recap names what it learned and from what, carries an id, and that
 * id points into memory; and a run starts from its memories.
 *
 * Owner, 2026-11-25:
 *   "and when he recaps on idle make it say what he learned from and points and
 *    logg to his mem so he gets smarter and smarter from mistakes"
 *   "and each recap will have id # to go stright to for issues in mem"
 *   "and make him when starting task cycle threw his memorys 1st for the task to
 *    get done faster if previous mem are present"
 *
 * Four things are pinned:
 *   1. the recap row renders the id, the learned count with its source, and the
 *      points — from counted values, never a guess;
 *   2. the hook posts one session summary per finished run, under that id, and
 *      remembers it for the row;
 *   3. the server writes the run's mistakes as `error` memories and the run as a
 *      `lesson` under the same id, and can read a recap back by that id;
 *   4. the run builds a MEMORY FIRST block from the task text and announces it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..', '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const require = createRequire(import.meta.url);

test('the recap row shows the id, what it learned from, and the points', () => {
  const src = read('cli/ui/src/components/Recap.jsx');
  for (const prop of ['recapId', 'points', 'learned', 'learnedSkills', 'memWritten']) {
    assert.ok(src.includes(prop), `Recap must take ${prop}`);
  }
  assert.ok(src.includes("key: 'id'"), 'the recap id is its own segment');
  assert.match(src, /learned \$\{lrn\} from \$\{from\}/, 'the learned segment names what it learned from');
  assert.match(src, /✦ \$\{pts\}p/, 'the points segment');
  assert.match(src, /key: 'learned'[\s\S]{0,400}key: 'points'/, 'id → learned → points order');

  const app = read('cli/ui/src/App.jsx');
  assert.match(app, /<Recap[\s\S]{0,200}recapId=\{agent\.lastRecap\?\.id/, 'App passes the recap id');
  assert.match(app, /points=\{agent\.meters\?\.points/, 'App passes the live point total');
  assert.match(app, /learned=\{agent\.learned\?\.added/, 'App passes the learned count');
});

test('the hook posts one session summary per run under its recap id', () => {
  const src = read('cli/ui/src/hooks/useAgentStream.js');
  assert.match(src, /const recapId = `#\$\{Date\.now\(\)\.toString\(36\)\.slice\(-6\)\}`/, 'a per-run id is generated');
  assert.ok(src.includes("fetch(`${api}/api/agent/session-summary`"), 'the summary is posted');
  assert.match(src, /if \(snap\.rounds > 0\)/, 'a run with no tool calls writes nothing');
  assert.match(src, /setLastRecap\(recap\)/, 'the row reads the last finished run');
  assert.match(src, /memWritten: Number\(data\.written\) \|\| 0/, 'the row reports what memory actually took');
  assert.match(src, /const \[lastRecap, setLastRecap\] = useState\(null\)/);
  assert.ok(src.includes('lastRecap,') && src.includes('learned,'), 'both are exposed from the hook');
  assert.ok(src.includes("case 'memory_recall':"), 'the memory-first event is rendered');
  assert.ok(src.includes("case 'learn':"), 'the learn event still moves the meter');
  assert.match(src, /learnedRef\.current\.added \+ Math\.max\(0, Number\(evt\.added\)/, 'learn counts accumulate');
});

test('the server writes the recap into memory and can read it back by id', () => {
  const src = read('server/src/index.js');
  assert.ok(src.includes("app.post('/api/agent/session-summary'"), 'summary endpoint');
  assert.ok(src.includes("app.get('/api/agent/recap/:id'"), 'recap lookup endpoint');
  assert.match(src, /autolearn\.recordRecap\(body, cwd\)/);
  assert.match(src, /key: `recap\$\{result\.id\}`/, 'a keyed pointer under the id');
  assert.match(src, /m\.tags\.includes\(id\)/, 'raw entries are found by their id tag');
});

test('autolearn builds the recap entries: mistakes as errors, the run as a lesson', () => {
  const autolearn = require(path.join(root, 'server/src/agent/autolearn.js'));
  for (const fn of ['buildRecapMemories', 'recordRecap', 'readRawMemories']) {
    assert.equal(typeof autolearn[fn], 'function', `${fn} is exported`);
  }
  const out = autolearn.buildRecapMemories({
    recapId: '#a3f9k2',
    task: 'fix the recap row',
    tools: 12,
    ok: 10,
    fail: 2,
    points: 413,
    learned: 7,
    learnedSkills: 1,
    failures: [{ tool: 'bash', error: 'npm ERR! missing script: build' }],
  });
  assert.equal(out.id, '#a3f9k2');
  assert.equal(out.entries.length, 2);
  const err = out.entries.find((e) => e.type === 'error');
  const lesson = out.entries.find((e) => e.type === 'lesson');
  assert.ok(err && lesson, 'one error entry and one lesson entry');
  for (const e of out.entries) {
    assert.ok(e.tags.includes('#a3f9k2'), 'every entry carries the recap id as a tag');
    assert.ok(e.observation.includes('#a3f9k2'), 'and in its text, so a search finds it');
    for (const field of ['id', 'timestamp', 'turn', 'phase', 'tags', 'observation', 'type', 'confidence']) {
      assert.ok(e[field] !== undefined && e[field] !== null, `${field} present on a memory entry`);
    }
  }
  assert.match(out.line, /learned 7 \+ 1 skill/);
  assert.match(out.line, /413p/);

  // A clean run is filed as a pattern, not a lesson.
  const clean = autolearn.buildRecapMemories({ recapId: '#b1c2d3', tools: 3, ok: 3, fail: 0 });
  assert.equal(clean.entries.length, 1);
  assert.equal(clean.entries[0].type, 'pattern');
  // A malformed id is replaced rather than written through.
  const odd = autolearn.buildRecapMemories({ recapId: 'nonsense', tools: 1 });
  assert.match(odd.id, /^#[a-z0-9]{3,16}$/);
});

test('the run starts from memory: a MEMORY FIRST block ahead of machine context', () => {
  const src = read('server/src/index.js');
  assert.ok(src.includes('function buildMemoryFirstBlock('), 'the block builder exists');
  assert.match(src, /const memoryFirst = buildMemoryFirstBlock\(lastUserMsg\?\.content \|\| ''/);
  assert.match(src, /memoryFirst\.text \? '\\n\\n' \+ memoryFirst\.text : ''/, 'memory block is in the prompt');
  // Order, not adjacency: the prompt grew a PAST PROJECTS block that sits
  // between them (2026-11-26), and pinning the two blocks as touching made this
  // test fail for a change that was correct. What the rule actually requires is
  // that everything recalled for the task comes BEFORE the machine context.
  const atMemory = src.indexOf("+ (!customerDirective && memoryFirst.text ? '\\n\\n' + memoryFirst.text : '')");
  const atPast = src.indexOf("+ (!customerDirective && pastProjects.text ? '\\n\\n' + pastProjects.text : '')");
  const atMachine = src.indexOf("+ (customerDirective ? '' : '\\n\\n' + machineContext)");
  assert.ok(atMemory > 0, 'the memory block is no longer concatenated into the system prompt');
  assert.ok(atMachine > atMemory, 'MEMORY FIRST no longer sits above the machine context');
  if (atPast > 0) assert.ok(atPast > atMemory && atMachine > atPast, 'recalled memory must also sit above the machine context');
  assert.ok(src.includes("type: 'memory_recall'"), 'the recall is announced on the stream');
  assert.match(src, /Do not repeat them; apply the fix noted\./, 'mistakes are framed as do-not-repeat');
  assert.match(src, /if \(s <= 0\) return;/, 'only matching memories are injected');
  assert.match(src, /if \(!terms\.length\) return \{ text: ''/, 'an empty task recalls nothing');
});

test('the recap says what it is a recap of, and it is shown once the agent sits', () => {
  // Owner, 2026-11-26: "make sure the recapp is working and says what the recap
  // is and done after agent sits".
  const recap = read('cli/ui/src/components/Recap.jsx');
  assert.ok(recap.includes('task = \'\''), 'Recap takes the run task');
  assert.ok(recap.includes("key: 'task'"), 'the task is its own segment');
  assert.match(recap, /key: 'id'[\s\S]{0,600}key: 'task'[\s\S]{0,900}key: 'learned'/,
    'label → id → task → learned order');
  assert.match(recap, /taskText\.length > 36/, 'the task is clipped to one segment');

  const app = read('cli/ui/src/App.jsx');
  assert.match(app, /task=\{agent\.lastRecap\?\.task \|\| ''\}/, 'App passes the last run task');
  // "done after agent sits": the recap row is the idle row — it appears only
  // when no run is in flight, and the live spinner owns that same row while a
  // run is going.
  assert.match(app, /const showRecap = view === 'chat' && !agent\.busy/, 'the recap shows only while idle');
  assert.match(app, /showCrushStatus = view === 'chat' && agent\.busy/, 'the spinner owns the row while busy');

  const hook = read('cli/ui/src/hooks/useAgentStream.js');
  assert.match(hook, /task: String\(prompt \|\| ''\)/, 'the hook records the run task on the recap');
});
